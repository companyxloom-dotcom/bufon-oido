// PARTE 54 - EL OIDO (servicio para RENDER). Usa el MISMO bot (mismo DISCORD_TOKEN) que el Bufón de Wispbyte.
// Solo hace esto: entrar a la llamada cuando Wispbyte lo pide (b!escuchar), oír a cada persona, pasar la voz a texto
// (Whisper de Groq) y, si dijeron "Bufón", contestar por el chat con la misma IA y personalidad del Bufón.
// NO lee comandos, NO registra comandos "/" y NO toca la economía: solo oye y responde.
// Arranque en Render:  npm install && node oido/index.js   (ver LEEME-parte54.txt)
require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');

let V, OpusScript;
try { V = require('@discordjs/voice'); OpusScript = require('opusscript'); }
catch (e) { console.error('[oido] Faltan las librerias de voz (@discordjs/voice, opusscript). npm install las trae:', e.message); process.exit(1); }

const db = require('../src/db');
const ia = require('../src/ia');
const U = require('./utils');

if (!process.env.DISCORD_TOKEN) { console.error('[oido] Falta DISCORD_TOKEN (el MISMO token del Bufón)'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('[oido] Falta DATABASE_URL (la misma cadena de Neon)'); process.exit(1); }
const SECRET = process.env.OIDO_SECRET || '';
if (!SECRET) console.error('[oido] Falta OIDO_SECRET: Wispbyte no podrá despertarme ni apagarme.');

const PORT = Number(process.env.PORT) || 3000;
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || process.env.OIDO_SELF_URL || '').replace(/\/+$/, '');
const SILENCE_MS = 1100;        // silencio que cierra una frase
const MIN_MS = 700;             // frases mas cortas se ignoran
const MAX_MS = 20000;           // frases mas largas se cortan
const RMS_MIN = 250;            // volumen minimo (descarta ruido/silencio sin gastar cupo de Groq)
const MAX_CLIPS_MIN = 15;       // limite de frases por minuto y servidor hacia Whisper (cupo gratis ~20/min)
const VENTANA_MS = 15000;       // tras responderle a alguien, le sigue contestando 15 s sin repetir "Bufón"
const VACIA_CHEQUEOS = 5;       // minutos solo en la llamada antes de apagarse
const ECO = process.env.OIDO_ECO !== '0';
const DEBUG = process.env.OIDO_DEBUG !== '0'; // registros de diagnostico en los Logs (ponle OIDO_DEBUG=0 para silenciarlos)
const dbg = (...a) => { if (DEBUG) console.log('[oido]', ...a); }; // muestra lo que entendio ("🎙️ ...") encima de la respuesta

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map(); // guildId -> { guildId, channelId, textId, userId, connection, listening, ventana, clips, vacios, rejoins, closing }
let listo;
const ready = new Promise((r) => { listo = r; });

async function say(textId, text) {
  if (!textId) return;
  try { const ch = await client.channels.fetch(textId); if (ch) await ch.send(text); } catch {}
}

// ---------- sesiones ----------
function cerrar(gid) {
  const s = sessions.get(gid);
  if (!s) return null;
  s.closing = true;
  sessions.delete(gid);
  try { s.connection && s.connection.destroy(); } catch {}
  return s;
}

// Termina por decision del oido: marca la base (Wispbyte lo ve y la guardia vuelve) y avisa en el chat.
async function terminar(gid, textId, mensaje) {
  const s = cerrar(gid);
  await db.pool.query(`UPDATE oido_voz SET activo = FALSE WHERE guild_id = $1`, [gid]).catch((e) => console.error('[oido] db:', e.message));
  await say((s && s.textId) || textId, mensaje);
}

async function conectar(s, guild) {
  const connection = V.joinVoiceChannel({
    channelId: s.channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // si estuviera ensordecido, Discord no le manda el audio de nadie
    selfMute: true,
  });
  s.connection = connection;
  connection.on('error', (e) => console.error('[oido] conexion de voz:', e.message));
  connection.on('stateChange', (o, n) => dbg(`voz: ${o.status} -> ${n.status}`));
  await V.entersState(connection, V.VoiceConnectionStatus.Ready, 30000);
  dbg('conexion de voz LISTA (Ready). Esperando que alguien hable...');

  connection.on(V.VoiceConnectionStatus.Disconnected, async () => {
    if (s.closing || s.connection !== connection) return;
    try {
      await Promise.race([
        V.entersState(connection, V.VoiceConnectionStatus.Signalling, 5000),
        V.entersState(connection, V.VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      if (s.closing || s.connection !== connection) return;
      try { connection.destroy(); } catch {}
      const now = Date.now();
      s.rejoins = s.rejoins.filter((t) => now - t < 300000);
      if (s.rejoins.length >= 4) { await terminar(s.guildId, s.textId, '🤡 Me sacaron de la llamada varias veces seguidas: apagué el modo habla.'); return; }
      s.rejoins.push(now);
      setTimeout(async () => {
        if (s.closing || sessions.get(s.guildId) !== s) return;
        try { await conectar(s, guild); } catch (e) { console.error('[oido] reconexion:', e.message); await terminar(s.guildId, s.textId, '🤡 No pude volver a la llamada: apagué el modo habla.'); }
      }, 2500);
    }
  });

  oir(s, guild);
}

async function abrir(w) {
  const gid = String(w.guild_id);
  const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
  if (!guild) return terminar(gid, w.text_id, '🤡 No encuentro este servidor desde el oído.');
  const ch = await guild.channels.fetch(w.channel_id).catch(() => null);
  if (!ch || ch.type !== 2) return terminar(gid, w.text_id, '🤡 El canal de voz ya no existe: apagué el modo habla.');
  const s = { guildId: gid, channelId: ch.id, textId: w.text_id, userId: w.user_id, connection: null, listening: new Set(), ventana: new Map(), clips: [], vacios: 0, rejoins: [], closing: false };
  sessions.set(gid, s);
  try { await conectar(s, guild); }
  catch (e) {
    console.error('[oido] no pude entrar:', e.message);
    return terminar(gid, w.text_id, `🤡 No pude entrar a **${ch.name}** (${String(e.message).slice(0, 80)}). Apagué el modo habla.`);
  }
  await db.pool.query(`UPDATE oido_voz SET joined = TRUE, seen = NOW() WHERE guild_id = $1 AND activo`, [gid]).catch(() => {});
  await say(s.textId, `👂 **Ya te escucho** en <#${ch.id}>. Di **«Bufón, …»** y te respondo por aquí. Para apagarme: \`b!escuchar off\`.`);
  console.log(`[oido] escuchando ${guild.name} / ${ch.name}`);
}

let sincronizando = false;
async function sync() {
  if (sincronizando) return;
  sincronizando = true;
  try {
    const r = await db.pool.query(`SELECT guild_id, channel_id, text_id, user_id FROM oido_voz WHERE activo`);
    const want = new Map(r.rows.map((x) => [String(x.guild_id), x]));
    for (const [gid, s] of [...sessions]) {
      const w = want.get(gid);
      if (!w || w.channel_id !== s.channelId) cerrar(gid); // lo apagaron (o lo cambiaron de canal) desde Wispbyte
    }
    for (const [gid, w] of want) if (!sessions.has(gid)) await abrir(w);
  } catch (e) { console.error('[oido] sync:', e.message); }
  finally { sincronizando = false; }
}

// ---------- audio -> texto -> respuesta ----------
function oir(s, guild) {
  const receiver = s.connection.receiver;
  receiver.speaking.on('start', (userId) => {
    if (s.closing || s.listening.has(userId)) return;
    s.ultimoAudio = Date.now();
    dbg(`Discord dice que habla ${userId}`);
    const vs = guild.voiceStates.cache.get(userId);
    if (vs && vs.member && vs.member.user.bot) return;
    s.listening.add(userId);

    const opus = receiver.subscribe(userId, { end: { behavior: V.EndBehaviorType.AfterSilence, duration: SILENCE_MS } });
    // Decodificamos paquete por paquete con try/catch: un paquete malo se salta y NO tumba toda la frase
    // (antes usaba un decodificador de flujo que se moría al primer "invalid packet").
    let dec;
    try { dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO); }
    catch (e) { console.error('[oido] no pude crear el decodificador de Opus:', e.message); s.listening.delete(userId); return; }
    const chunks = [];
    let bytes = 0, buenos = 0, malos = 0, hecho = false;
    const fin = () => {
      if (hecho) return;
      hecho = true;
      s.listening.delete(userId);
      try { dec.delete(); } catch {}
      dbg(`captura de ${userId}: ${Math.round(bytes / 192)} ms de audio (paquetes buenos ${buenos}, inválidos ${malos})`);
      if (malos > 0 && buenos === 0) console.error('[oido] TODOS los paquetes llegaron inválidos: casi seguro el audio llega cifrado (DAVE) y no se está descifrando. Revisa que @snazzah/davey esté instalado y actualizado.');
      procesar(s, guild, userId, Buffer.concat(chunks)).catch((e) => console.error('[oido] procesar:', e.message));
    };
    opus.on('data', (pkt) => {
      if (hecho) return;
      try {
        const pcm = dec.decode(pkt);
        chunks.push(Buffer.from(pcm)); bytes += pcm.length; buenos++;
      } catch (e) {
        malos++;
        if (malos === 1) dbg(`paquete de audio inválido (${pkt.length} bytes): ${String(e.message || e).slice(0, 80)}`);
      }
      if (bytes > MAX_MS * 192) { opus.destroy(); fin(); } // 192 bytes por ms (48 kHz, estéreo, 16 bits)
    });
    opus.on('end', fin);
    opus.on('close', fin);
    opus.on('error', (e) => { console.error('[oido] audio:', e.message); fin(); });
  });
}

async function procesar(s, guild, userId, pcm) {
  if (s.closing) return;
  if (pcm.length / 192 < MIN_MS) { dbg(`frase muy corta (${Math.round(pcm.length / 192)} ms): ignorada`); return; }
  const mono = U.monoDe48kEstereo(pcm);
  const vol = Math.round(U.rms(mono));
  if (vol < RMS_MIN) { dbg(`volumen muy bajo (${vol} < ${RMS_MIN}): ignorada`); return; }
  const ahora = Date.now();
  s.clips = s.clips.filter((t) => ahora - t < 60000);
  if (s.clips.length >= MAX_CLIPS_MIN) { dbg('demasiadas frases por minuto: ignorada'); return; }
  s.clips.push(ahora);

  const wav = U.aWav(mono);
  if (process.env.OIDO_AUDIO === '1' && (s.volcados = s.volcados || 0) < 4) { // DIAGNOSTICO: manda el audio que el oído recibió, por MENSAJE PRIVADO (nunca al chat)
    s.volcados++;
    let dest = null;
    if (process.env.OIDO_AUDIO_CANAL) dest = await client.channels.fetch(process.env.OIDO_AUDIO_CANAL).catch(() => null); // opcional: un canal aparte
    else { const u = s.userId && await client.users.fetch(s.userId).catch(() => null); dest = u && await u.createDM().catch(() => null); } // por defecto: DM a quien activó b!escuchar
    if (dest) await dest.send({ content: `🔧 Diagnóstico: esto es lo que oí de <@${userId}> (volumen ${vol}, ${Math.round(mono.length / 32)} ms). ¿Se oye tu voz normal, rápida, lenta o puro ruido?`, files: [{ attachment: wav, name: 'oido.wav' }], allowedMentions: { parse: [] } }).catch((e) => console.error('[oido] diagnóstico:', e.message));
    else console.error('[oido] diagnóstico: no pude mandar el audio (¿tienes los mensajes privados cerrados? Puedes poner OIDO_AUDIO_CANAL con el ID de un canal aparte)');
  }
  let texto = '';
  try {
    texto = (await ia.transcribir(wav)).trim();
    if (!texto && process.env.OIDO_AUDIO === '1') texto = (await ia.transcribir(wav, { sinPrompt: true })).trim(); // reintento sin pista (solo en diagnóstico)
  }
  catch (e) { console.error('[oido] voz->texto:', String(e.message).slice(0, 120)); return; }
  dbg(`Whisper entendió (${userId}, volumen ${vol}): "${texto}"`);
  if (texto.length < 2) return;

  const enVentana = (s.ventana.get(userId) || 0) > Date.now();
  if (!U.quiereHablar(texto) && !enVentana) { dbg('no dijo "Bufón": no respondo'); return; } // no le hablaron al Bufón
  if (s.closing || !s.textId) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (member && member.user.bot) return;
  const nombre = member ? member.displayName : 'Alguien';
  const ch = await client.channels.fetch(s.textId).catch(() => null);
  if (!ch) return;
  ch.sendTyping().catch(() => {});

  let out = '';
  try { out = await ia.hablarVoz({ guildId: guild.id, channelId: s.textId, userId, nombre, texto }); }
  catch (e) { console.error('[oido] IA:', String(e.message).slice(0, 120)); return; }
  if (!out) { dbg('la IA no devolvió respuesta (cooldown, sin claves o IA_OFF)'); return; }
  s.ventana.set(userId, Date.now() + VENTANA_MS);
  const eco = ECO ? `> 🎙️ *${texto.replace(/[*_`>~|\\]/g, '').slice(0, 200)}*\n` : '';
  await ch.send({ content: `${eco}<@${userId}> ${out}`.slice(0, 1990), allowedMentions: { users: [userId] } }).catch((e) => console.error('[oido] enviar:', e.message));
}

// ---------- mantenimiento ----------
let tickN = 0;
async function tick() {
  if (!sessions.size) return;
  tickN++;
  await sync();                                     // cada 10 s: ¿lo apagaron desde Wispbyte?
  if (tickN % 5 === 0 && sessions.size) {           // ~50 s: aviso de que sigo vivo (Wispbyte lo usa para pausar la guardia)
    await db.pool.query(`UPDATE oido_voz SET seen = NOW(), joined = TRUE WHERE guild_id = ANY($1) AND activo`, [[...sessions.keys()]]).catch(() => {});
  }
  if (tickN % 6 === 0) {                            // ~60 s: ¿me quedé solo?
    for (const s of sessions.values()) dbg(`vivo: servidor ${s.guildId}, voz=${s.connection ? s.connection.state.status : 'sin conexion'}, ultimo audio recibido ${s.ultimoAudio ? Math.round((Date.now() - s.ultimoAudio) / 1000) + ' s atrás' : 'NUNCA'}`);
    for (const [gid, s] of [...sessions]) {
      const guild = client.guilds.cache.get(gid);
      const personas = guild ? guild.voiceStates.cache.filter((v) => v.channelId === s.channelId && v.id !== client.user.id && !(v.member && v.member.user.bot)).size : 0;
      s.vacios = personas === 0 ? s.vacios + 1 : 0;
      if (s.vacios >= VACIA_CHEQUEOS) await terminar(gid, s.textId, '👋 Me quedé solo en la llamada, así que apagué el modo habla. Escribe `b!escuchar` cuando quieras de nuevo.');
    }
  }
  if (tickN % 48 === 0 && sessions.size && SELF_URL) { // ~8 min: me pinguea a mí mismo para que Render no me duerma mientras haya llamada
    fetch(SELF_URL + '/ping', { signal: AbortSignal.timeout(30000) }).catch(() => {});
  }
}
setInterval(() => tick().catch((e) => console.error('[oido] tick:', e.message)), 10000);

// ---------- servidor web (Render lo exige y Wispbyte lo usa para despertarme) ----------
function autorizado(req) {
  const dado = Buffer.from(String(req.headers['x-oido-secret'] || ''));
  const real = Buffer.from(SECRET);
  return !!SECRET && dado.length === real.length && crypto.timingSafeEqual(dado, real);
}
http.createServer(async (req, res) => {
  const url = String(req.url || '').split('?')[0];
  const out = (code, body) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(body); };
  try {
    if (url === '/' || url === '/ping' || url === '/salud') return out(200, 'ok');
    if (!autorizado(req)) return out(401, 'no');
    if (req.method === 'POST' && (url === '/despertar' || url === '/parar')) { await ready; await sync(); return out(200, 'ok'); }
    if (url === '/estado') return out(200, JSON.stringify({ sesiones: [...sessions.values()].map((s) => ({ guild: s.guildId, canal: s.channelId, escuchando: s.listening.size })) }));
    return out(404, 'no');
  } catch (e) { console.error('[oido] http:', e.message); return out(500, 'error'); }
}).listen(PORT, () => console.log(`[oido] servidor web en el puerto ${PORT}`));

// ---------- arranque ----------
let arrancado = false;
async function alListo() {
  if (arrancado) return;
  arrancado = true;
  await db.pool.query(`CREATE TABLE IF NOT EXISTS oido_voz (
    guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, text_id TEXT, user_id TEXT,
    activo BOOLEAN NOT NULL DEFAULT TRUE, joined BOOLEAN NOT NULL DEFAULT FALSE,
    since TIMESTAMPTZ NOT NULL DEFAULT NOW(), seen TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch((e) => console.error('[oido] tabla:', e.message));
  console.log(`[oido] listo como ${client.user.tag} (solo oigo: no leo comandos)`);
  try { console.log('[oido] ' + V.generateDependencyReport().split('\n').join('\n[oido] ')); } catch {}
  listo();
  await sync(); // si Render se reinició con una sesión activa, vuelve a entrar
}
client.once('clientReady', alListo);
client.once('ready', alListo);

const apagar = () => { for (const gid of [...sessions.keys()]) cerrar(gid); setTimeout(() => process.exit(0), 500); };
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);
process.on('unhandledRejection', (e) => console.error('[oido] unhandledRejection:', e));
client.login(process.env.DISCORD_TOKEN);
