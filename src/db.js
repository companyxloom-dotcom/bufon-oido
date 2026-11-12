const { Pool } = require('pg');

// Neon exige SSL. Quitamos sslmode de la URL y lo configuramos aquí.
const url = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]channel_binding=[^&]*/g, '');
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 20000 });
pool.on('error', (e) => console.error('[db] error en el pool:', e.message));

const START_COINS = 500;
const DAILY_COINS = 200;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      coins BIGINT NOT NULL DEFAULT ${START_COINS},
      last_daily TIMESTAMPTZ
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_work TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS level_seen INT NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS guild_players (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS champions (guild_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS role_guilds (guild_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS user_items (
      user_id TEXT NOT NULL,
      item TEXT NOT NULL,
      PRIMARY KEY (user_id, item)
    );
    CREATE TABLE IF NOT EXISTS achievements (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS chest_channels (channel_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS stats (
      user_id TEXT NOT NULL,
      game TEXT NOT NULL,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      draws INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, game)
    );
    CREATE TABLE IF NOT EXISTS user_pets (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      pet_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS user_pets_user_idx ON user_pets (user_id);
    ALTER TABLE user_pets ADD COLUMN IF NOT EXISTS xp INT NOT NULL DEFAULT 0;
    ALTER TABLE user_pets ADD COLUMN IF NOT EXISTS evolved BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS pet_listings (
      id BIGSERIAL PRIMARY KEY,
      pet_id BIGINT NOT NULL UNIQUE,
      seller_id TEXT NOT NULL,
      price BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS dragons (
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      adopted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_fed TIMESTAMPTZ,
      xp INT NOT NULL DEFAULT 0
    );
    ALTER TABLE dragons ADD COLUMN IF NOT EXISTS kind TEXT;
    ALTER TABLE dragons ADD COLUMN IF NOT EXISTS seed INT;
    CREATE TABLE IF NOT EXISTS impostor_mutes (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      was_muted BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS impostor_history (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      missed INT NOT NULL DEFAULT 1,
      last_impostor BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS forbidden_rules (
      guild_id TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clans (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      leader_id TEXT NOT NULL,
      role_id TEXT,
      channel_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, name_key)
    );
    CREATE TABLE IF NOT EXISTS clan_members (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      clan_id BIGINT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
}

async function getUser(id) {
  const r = await pool.query(
    `INSERT INTO users (id) VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING *`, [id]);
  return r.rows[0];
}

async function addCoins(id, amount) {
  await getUser(id);
  const r = await pool.query(
    `UPDATE users SET coins = GREATEST(coins + $2, 0) WHERE id = $1 RETURNING coins`, [id, amount]);
  return Number(r.rows[0].coins);
}

// Recompensa diaria con racha. Devuelve { ok:true, coins, gained, streak } o { ok:false, msLeft }
async function claimDaily(id) {
  await getUser(id);
  const r = await pool.query(
    `UPDATE users SET
       streak = CASE WHEN last_daily IS NOT NULL AND last_daily >= NOW() - INTERVAL '48 hours' THEN streak + 1 ELSE 1 END,
       coins = coins + $2 + LEAST(CASE WHEN last_daily IS NOT NULL AND last_daily >= NOW() - INTERVAL '48 hours' THEN streak ELSE 0 END, 10) * 20,
       last_daily = NOW()
     WHERE id = $1 AND (last_daily IS NULL OR last_daily < NOW() - INTERVAL '20 hours')
     RETURNING coins, streak`, [id, DAILY_COINS]);
  if (r.rowCount) {
    const streak = Number(r.rows[0].streak);
    return { ok: true, coins: Number(r.rows[0].coins), gained: DAILY_COINS + Math.min(streak - 1, 10) * 20, streak };
  }
  const t = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (last_daily + INTERVAL '20 hours' - NOW())) * 1000 AS ms FROM users WHERE id = $1`, [id]);
  return { ok: false, msLeft: Math.max(0, Number(t.rows[0].ms)) };
}

// Trabajo con enfriamiento de 1 hora. Devuelve { ok:true, coins } o { ok:false, msLeft }
async function claimWork(id, amount) {
  await getUser(id);
  const r = await pool.query(
    `UPDATE users SET coins = coins + $2, last_work = NOW()
     WHERE id = $1 AND (last_work IS NULL OR last_work < NOW() - INTERVAL '1 hour') RETURNING coins`, [id, amount]);
  if (r.rowCount) return { ok: true, coins: Number(r.rows[0].coins) };
  const t = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (last_work + INTERVAL '1 hour' - NOW())) * 1000 AS ms FROM users WHERE id = $1`, [id]);
  return { ok: false, msLeft: Math.max(0, Number(t.rows[0].ms)) };
}

// Transferencia atómica entre usuarios. Devuelve true/false.
async function transfer(from, to, amount) {
  await getUser(from); await getUser(to);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`UPDATE users SET coins = coins - $2 WHERE id = $1 AND coins >= $2`, [from, amount]);
    if (!r.rowCount) { await c.query('ROLLBACK'); return false; }
    await c.query(`UPDATE users SET coins = coins + $2 WHERE id = $1`, [to, amount]);
    await c.query('COMMIT');
    return true;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

// Descuenta monedas solo si alcanzan. Devuelve true/false.
async function spend(id, amount) {
  await getUser(id);
  const r = await pool.query(`UPDATE users SET coins = coins - $2 WHERE id = $1 AND coins >= $2 RETURNING coins`, [id, amount]);
  return r.rowCount > 0;
}

async function topCoins(limit = 10) {
  const r = await pool.query(`SELECT id, coins FROM users ORDER BY coins DESC LIMIT $1`, [limit]);
  return r.rows.map((x) => ({ id: x.id, coins: Number(x.coins) }));
}

// winnerId/loserId pueden ser null (por ejemplo contra el bot). draws = lista de ids.
async function recordResult(game, { winnerId, loserId, draws = [] }) {
  const bump = async (id, col) => {
    if (!id) return;
    await pool.query(
      `INSERT INTO stats (user_id, game, ${col}) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, game) DO UPDATE SET ${col} = stats.${col} + 1`, [id, game]);
    await pool.query(`UPDATE users SET xp = xp + $2 WHERE id = $1`, [id, (col === 'wins' ? 10 : col === 'losses' ? 3 : 4) * (await xpMult(id))]);
  };
  await bump(winnerId, 'wins');
  await bump(loserId, 'losses');
  for (const d of draws) await bump(d, 'draws');
}

async function getStats(id) {
  const r = await pool.query(`SELECT game, wins, losses, draws FROM stats WHERE user_id = $1 ORDER BY game`, [id]);
  return r.rows;
}

// ---------- Dragones (todo se calcula con horas guardadas, sin procesos en segundo plano) ----------
async function getDragon(id) {
  const r = await pool.query(
    `SELECT name, xp, kind, seed,
            EXTRACT(EPOCH FROM (NOW() - adopted_at)) AS age_s,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(last_fed, adopted_at))) AS fed_s
     FROM dragons WHERE user_id = $1`, [id]);
  const d = r.rows[0];
  return d ? { name: d.name, xp: Number(d.xp), ageS: Number(d.age_s), fedS: Number(d.fed_s), kind: d.kind, seed: d.seed } : null;
}

async function adoptDragon(id, name, kind = null, seed = null) {
  const r = await pool.query(`INSERT INTO dragons (user_id, name, kind, seed) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id`, [id, name, kind, seed]);
  return r.rowCount > 0;
}

// Para dragones adoptados antes de que existieran las especies: les asigna una y se queda fija.
async function setDragonKind(id, kind, seed) {
  await pool.query(`UPDATE dragons SET kind = $2, seed = $3 WHERE user_id = $1 AND kind IS NULL`, [id, kind, seed]);
}

// Devuelve el xp nuevo, o null si aún no nació o comió hace menos de 1 hora.
async function feedDragon(id) {
  const r = await pool.query(
    `UPDATE dragons SET xp = xp + 15, last_fed = NOW()
     WHERE user_id = $1 AND adopted_at <= NOW() - INTERVAL '1 hour'
       AND NOW() - COALESCE(last_fed, adopted_at) >= INTERVAL '1 hour'
     RETURNING xp`, [id]);
  return r.rowCount ? Number(r.rows[0].xp) : null;
}

async function addDragonXp(id, xp) {
  await pool.query(`UPDATE dragons SET xp = xp + $2 WHERE user_id = $1`, [id, xp]);
}

// ---------- Tienda, títulos, logros, cofres ----------
async function getItems(id) {
  const r = await pool.query(`SELECT item FROM user_items WHERE user_id = $1 ORDER BY item`, [id]);
  return r.rows.map((x) => x.item);
}

// Devuelve 'ok' | 'owned' | 'poor'
async function buyItem(id, item, price) {
  await getUser(id);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query(`INSERT INTO user_items (user_id, item) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, item]);
    if (!ins.rowCount) { await c.query('ROLLBACK'); return 'owned'; }
    const pay = await c.query(`UPDATE users SET coins = coins - $2 WHERE id = $1 AND coins >= $2`, [id, price]);
    if (!pay.rowCount) { await c.query('ROLLBACK'); return 'poor'; }
    await c.query('COMMIT');
    return 'ok';
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

async function setTitle(id, title) {
  await getUser(id);
  await pool.query(`UPDATE users SET title = $2 WHERE id = $1`, [id, title]);
}

async function rankOf(id) {
  const r = await pool.query(`SELECT COUNT(*) + 1 AS pos FROM users WHERE coins > (SELECT coins FROM users WHERE id = $1)`, [id]);
  return Number(r.rows[0].pos);
}

async function claimedAchievements(id) {
  const r = await pool.query(`SELECT key FROM achievements WHERE user_id = $1`, [id]);
  return new Set(r.rows.map((x) => x.key));
}

async function claimAchievement(id, key) {
  const r = await pool.query(`INSERT INTO achievements (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  return r.rowCount > 0;
}

async function listChestChannels() {
  const r = await pool.query(`SELECT channel_id FROM chest_channels`);
  return r.rows.map((x) => x.channel_id);
}
async function addChestChannel(id) { await pool.query(`INSERT INTO chest_channels (channel_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]); }
async function removeChestChannel(id) { await pool.query(`DELETE FROM chest_channels WHERE channel_id = $1`, [id]); }

// ---------- XP, rangos y roles ----------
// Poción de Sabiduría: XP x2 mientras dure (si hay cualquier error, vale x1).
async function xpMult(id) {
  try {
    const r = await pool.query(`SELECT 1 FROM potion_effects WHERE user_id = $1 AND effect = 'sabiduria' AND ends_at > NOW()`, [id]);
    return r.rowCount ? 2 : 1;
  } catch (e) { return 1; }
}
async function addXp(id, n) {
  await getUser(id);
  n = n * (await xpMult(id));
  const r = await pool.query(`UPDATE users SET xp = xp + $2 WHERE id = $1 RETURNING xp`, [id, n]);
  return Number(r.rows[0].xp);
}
async function markLevelSeen(id, lvl) {
  const r = await pool.query(`UPDATE users SET level_seen = $2 WHERE id = $1 AND level_seen < $2 RETURNING id`, [id, lvl]);
  return r.rowCount > 0;
}
async function touchGuildPlayer(guildId, userId) {
  await pool.query(`INSERT INTO guild_players (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [guildId, userId]);
}
async function topXpInGuild(guildId, limit = 5) {
  const r = await pool.query(
    `SELECT u.id, u.xp FROM users u JOIN guild_players g ON g.user_id = u.id
     WHERE g.guild_id = $1 ORDER BY u.xp DESC LIMIT $2`, [guildId, limit]);
  return r.rows.map((x) => ({ id: x.id, xp: Number(x.xp) }));
}
async function getChampion(guildId) {
  const r = await pool.query(`SELECT user_id FROM champions WHERE guild_id = $1`, [guildId]);
  return r.rows[0] ? r.rows[0].user_id : null;
}
async function setChampion(guildId, userId) {
  await pool.query(`INSERT INTO champions (guild_id, user_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET user_id = EXCLUDED.user_id`, [guildId, userId]);
}
async function listRoleGuilds() {
  const r = await pool.query(`SELECT guild_id FROM role_guilds`);
  return r.rows.map((x) => x.guild_id);
}
async function addRoleGuild(id) { await pool.query(`INSERT INTO role_guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]); }
async function removeRoleGuild(id) { await pool.query(`DELETE FROM role_guilds WHERE guild_id = $1`, [id]); }

// ---------- Mascotas y mercado ----------
async function addPet(userId, key) {
  const r = await pool.query(`INSERT INTO user_pets (user_id, pet_key) VALUES ($1, $2) RETURNING id`, [userId, key]);
  return Number(r.rows[0].id);
}
// Mascotas del usuario. Las que están a la venta traen listing_id y price.
async function getPets(userId) {
  const r = await pool.query(
    `SELECT p.id, p.pet_key, p.xp, p.evolved, l.id AS listing_id, l.price
       FROM user_pets p LEFT JOIN pet_listings l ON l.pet_id = p.id
      WHERE p.user_id = $1 ORDER BY p.id`, [userId]);
  return r.rows.map((x) => ({ id: Number(x.id), key: x.pet_key, xp: Number(x.xp), evolved: !!x.evolved, listingId: x.listing_id ? Number(x.listing_id) : null, price: x.price ? Number(x.price) : null }));
}
// XP de mascota y evolución a la etapa adulta (cuesta monedas).
async function addPetXp(petId, n) { await pool.query(`UPDATE user_pets SET xp = xp + $2 WHERE id = $1`, [petId, n]); }
async function evolvePet(userId, petId, minXp, cost) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`SELECT xp, evolved FROM user_pets WHERE id = $1 AND user_id = $2 FOR UPDATE`, [petId, userId]);
    if (!r.rows[0]) { await c.query('ROLLBACK'); return { ok: false, reason: 'notyours' }; }
    const xp = Number(r.rows[0].xp);
    if (r.rows[0].evolved) { await c.query('ROLLBACK'); return { ok: false, reason: 'already' }; }
    if (xp < minXp) { await c.query('ROLLBACK'); return { ok: false, reason: 'noxp', xp }; }
    const sp = await c.query(`UPDATE users SET coins = coins - $2 WHERE id = $1 AND coins >= $2 RETURNING coins`, [userId, cost]);
    if (!sp.rows[0]) { await c.query('ROLLBACK'); return { ok: false, reason: 'coins' }; }
    await c.query(`UPDATE user_pets SET evolved = TRUE WHERE id = $1`, [petId]);
    await c.query('COMMIT');
    return { ok: true, xp };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
// Pone a la venta una mascota propia que no esté ya listada. Devuelve 'ok' | 'notyours' | 'listed'.
async function listPet(userId, petId, price) {
  const own = await pool.query(`SELECT 1 FROM user_pets WHERE id = $1 AND user_id = $2`, [petId, userId]);
  if (!own.rowCount) return 'notyours';
  const r = await pool.query(`INSERT INTO pet_listings (pet_id, seller_id, price) VALUES ($1, $2, $3) ON CONFLICT (pet_id) DO NOTHING RETURNING id`, [petId, userId, price]);
  return r.rowCount ? 'ok' : 'listed';
}
async function unlistPet(userId, petId) {
  const r = await pool.query(`DELETE FROM pet_listings WHERE pet_id = $1 AND seller_id = $2`, [petId, userId]);
  return r.rowCount > 0;
}
async function listListings(limit = 15) {
  const r = await pool.query(
    `SELECT l.id, l.pet_id, l.seller_id, l.price, p.pet_key
       FROM pet_listings l JOIN user_pets p ON p.id = l.pet_id
      ORDER BY l.id DESC LIMIT $1`, [limit]);
  return r.rows.map((x) => ({ id: Number(x.id), petId: Number(x.pet_id), sellerId: x.seller_id, price: Number(x.price), key: x.pet_key }));
}
// Compra atómica: cobra, paga al vendedor, mueve la mascota y borra la oferta en una sola transacción.
// Devuelve 'ok' | 'gone' | 'own' | 'poor'.
async function buyListing(buyerId, listingId) {
  await getUser(buyerId);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const l = await c.query(`SELECT * FROM pet_listings WHERE id = $1 FOR UPDATE`, [listingId]);
    if (!l.rowCount) { await c.query('ROLLBACK'); return 'gone'; }
    const { pet_id, seller_id, price } = l.rows[0];
    if (seller_id === buyerId) { await c.query('ROLLBACK'); return 'own'; }
    const pay = await c.query(`UPDATE users SET coins = coins - $2 WHERE id = $1 AND coins >= $2`, [buyerId, price]);
    if (!pay.rowCount) { await c.query('ROLLBACK'); return 'poor'; }
    await getUser(seller_id);
    await c.query(`UPDATE users SET coins = coins + $2 WHERE id = $1`, [seller_id, price]);
    await c.query(`UPDATE user_pets SET user_id = $2 WHERE id = $1`, [pet_id, buyerId]);
    await c.query(`DELETE FROM pet_listings WHERE id = $1`, [listingId]);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

// Regalo directo. Solo mueve la mascota si es del que regala y no está a la venta.
async function transferPet(fromId, toId, petId) {
  await getUser(toId);
  const r = await pool.query(
    `UPDATE user_pets SET user_id = $2
      WHERE id = $3 AND user_id = $1
        AND NOT EXISTS (SELECT 1 FROM pet_listings WHERE pet_id = $3)`, [fromId, toId, petId]);
  return r.rowCount > 0;
}

// ---------- Impostor: silencios puestos por el bot (para quitarlos aunque el bot se reinicie) ----------
async function addImpostorMute(guildId, userId, wasMuted) {
  await pool.query(
    `INSERT INTO impostor_mutes (guild_id, user_id, was_muted) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, user_id) DO NOTHING`, [guildId, userId, !!wasMuted]);
}
async function getImpostorMute(guildId, userId) {
  const r = await pool.query(`SELECT was_muted FROM impostor_mutes WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
  return r.rows[0] || null;
}
async function removeImpostorMute(guildId, userId) {
  await pool.query(`DELETE FROM impostor_mutes WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
}
async function listImpostorMutes() {
  const r = await pool.query(`SELECT guild_id, user_id, was_muted FROM impostor_mutes`);
  return r.rows;
}
// Impostor: historial para repartir el rol de forma pareja (quien nunca ha sido impostor tiene más chance).
async function getImpostorHistory(guildId, ids) {
  const r = await pool.query(
    `SELECT user_id, missed, last_impostor FROM impostor_history WHERE guild_id = $1 AND user_id = ANY($2::text[])`, [guildId, ids]);
  return new Map(r.rows.map((x) => [x.user_id, x]));
}
async function recordImpostorRound(guildId, ids, impostorId) {
  await pool.query(
    `INSERT INTO impostor_history (guild_id, user_id, missed, last_impostor)
     SELECT $1, t.u, CASE WHEN t.u = $3 THEN 0 ELSE 1 END, (t.u = $3) FROM unnest($2::text[]) AS t(u)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       missed = CASE WHEN impostor_history.user_id = $3 THEN 0 ELSE LEAST(impostor_history.missed + 1, 6) END,
       last_impostor = (impostor_history.user_id = $3)`, [guildId, ids, impostorId]);
}
async function topGame(game, limit = 5) {
  const r = await pool.query(
    `SELECT user_id, wins, losses FROM stats WHERE game = $1 AND wins > 0 ORDER BY wins DESC, losses ASC LIMIT $2`, [game, limit]);
  return r.rows;
}

module.exports = { getImpostorHistory, recordImpostorRound, addPetXp, evolvePet, transfer, claimWork, setDragonKind, pool, addImpostorMute, getImpostorMute, removeImpostorMute, listImpostorMutes, topGame, transferPet, addPet, getPets, listPet, unlistPet, listListings, buyListing, addXp, markLevelSeen, touchGuildPlayer, topXpInGuild, getChampion, setChampion, listRoleGuilds, addRoleGuild, removeRoleGuild, getItems, buyItem, setTitle, rankOf, claimedAchievements, claimAchievement, listChestChannels, addChestChannel, removeChestChannel, getDragon, adoptDragon, feedDragon, addDragonXp, init, getUser, addCoins, spend, claimDaily, topCoins, recordResult, getStats, DAILY_COINS };
