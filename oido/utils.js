// Funciones puras del oído (se pueden probar sin Discord): palabra clave, audio -> WAV, volumen.

// ¿Dijeron "Bufón"? Tolera acentos, "Buffon", mayúsculas y plural.
function quiereHablar(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /(^|[^a-z])bu+f{1,2}o+n(es)?([^a-z]|$)/.test(t);
}

// PCM s16le estéreo a 48 kHz (lo que sale del decodificador de Opus) -> PCM s16le mono a 16 kHz.
function monoDe48kEstereo(buf) {
  const frames = Math.floor(buf.length / 4);          // 4 bytes por muestra estéreo
  const out = Buffer.alloc(Math.floor(frames / 3) * 2);
  let o = 0;
  for (let i = 0; i + 2 < frames; i += 3) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      sum += buf.readInt16LE((i + k) * 4) + buf.readInt16LE((i + k) * 4 + 2);
    }
    if (o + 2 > out.length) break;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), o);
    o += 2;
  }
  return out.subarray(0, o);
}

function rms(pcm16) {
  const n = Math.floor(pcm16.length / 2);
  if (!n) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) { const v = pcm16.readInt16LE(i * 2); acc += v * v; }
  return Math.sqrt(acc / n);
}

// Envuelve PCM s16le mono en un archivo WAV.
function aWav(pcm16, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm16.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([h, pcm16]);
}

module.exports = { quiereHablar, monoDe48kEstereo, rms, aWav };
