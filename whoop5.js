// Protocollo BLE WHOOP 5.0 / MG — solo la parte che serve alla sveglia.
// Fonti: ryanbr/noop (docs/PROTOCOL_ALARMS.md), eugenehp/whoop-rs (src/protocol).

export const SERVICE = 'fd4b0001-cce1-4033-93ce-002d5875f58a';
export const COMMAND_CHAR = 'fd4b0002-cce1-4033-93ce-002d5875f58a';
export const NOTIFY_CHARS = [
  'fd4b0003-cce1-4033-93ce-002d5875f58a',
  'fd4b0004-cce1-4033-93ce-002d5875f58a',
  'fd4b0005-cce1-4033-93ce-002d5875f58a',
  'fd4b0007-cce1-4033-93ce-002d5875f58a',
];

export const CMD = {
  BUZZ: 19,          // RUN_HAPTIC_PATTERN_MAVERICK
  SET_ALARM: 66,
  GET_ALARM: 67,
  RUN_ALARM: 68,
  DISABLE_ALARM: 69,
  GET_HELLO: 145,
  SET_CLOCK: 146,
};

export const RESULT = { 0: 'FAILURE', 1: 'SUCCESS', 2: 'PENDING', 3: 'UNSUPPORTED' };

const PACKET_COMMAND = 35;
const RESPONSE_TYPES = new Set([36, 38]);
const INNER = 8; // offset del record interno nei frame WHOOP 5

// Coppia di effetti usata sia dalla notifica sia dalla sveglia ufficiale.
const WAVEFORM = [47, 152, 0, 0, 0, 0, 0, 0];

// ── Checksum ────────────────────────────────────────────────────────────────

export function crc16modbus(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC32_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const rd16 = (a, o) => a[o] | (a[o + 1] << 8);
const rd32 = (a, o) => (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;

// ── Frame ───────────────────────────────────────────────────────────────────

// AA | 01 | declLen u16 | 00 01 | crc16(0..6) | type seq cmd body pad4 | crc32(inner)
export function commandFrame(cmd, seq, body) {
  const inner = [PACKET_COMMAND, seq & 0xff, cmd, ...body];
  while (inner.length % 4) inner.push(0);
  const head = [0xaa, 0x01, ...u16(inner.length + 4), 0x00, 0x01];
  return Uint8Array.from([...head, ...u16(crc16modbus(head)), ...inner, ...u32(crc32(inner))]);
}

// Le notifiche possono spezzare un frame su più pacchetti: si ricompone qui.
export class Reassembler {
  constructor() { this.buf = []; }

  feed(chunk) {
    this.buf.push(...chunk);
    const out = [];
    for (;;) {
      const sof = this.buf.indexOf(0xaa);
      if (sof < 0) { this.buf = []; break; }
      if (sof > 0) this.buf.splice(0, sof);
      if (this.buf.length < 8) break;
      const total = rd16(this.buf, 2) + 8;
      const headerOk = crc16modbus(this.buf.slice(0, 6)) === rd16(this.buf, 6);
      if (!headerOk || total < 16 || total > 8192) { this.buf.shift(); continue; }
      if (this.buf.length < total) break;
      out.push(Uint8Array.from(this.buf.splice(0, total)));
    }
    return out;
  }
}

export function frameOk(f) {
  const total = rd16(f, 2) + 8;
  if (f.length !== total) return false;
  return crc32(f.subarray(INNER, total - 4)) === rd32(f, total - 4);
}

// [8]=type [9]=seq risposta [10]=cmd [11]=seq richiesta [12]=esito [13..]=corpo
export function parseResponse(f) {
  if (!RESPONSE_TYPES.has(f[INNER])) return null;
  const end = rd16(f, 2) + 4;
  return {
    cmd: f[INNER + 2],
    originSeq: f[INNER + 3],
    result: f[INNER + 4],
    body: f.slice(INNER + 5, end),
  };
}

// ── Corpi dei comandi ───────────────────────────────────────────────────────

export const helloBody = () => [0x01];

// Corpo di GET_HELLO: batteria in decimi di % a [1], secondi Unix a [6], firmware a [91..97]
export function parseHello(body) {
  if (body.length < 98 || (body[0] !== 1 && body[0] !== 3)) return null;
  return {
    battery: rd32(body, 1) / 10,
    clock: rd32(body, 6),
    firmware: `${body[91]}.${body[92]}.${body[93]}.${rd32(body, 94)}`,
  };
}

export const setClockBody = (unixSeconds) => [0x01, ...u32(unixSeconds), 0, 0];

// loops = numero di vibrazioni (1–8); il campo sul filo conta le ripetizioni dopo la prima
export const buzzBody = (loops = 2) => [0x01, ...WAVEFORM, 0, 0, Math.min(8, Math.max(1, loops)) - 1];

// Record sveglia revisione 4, 21 byte. repeats 7 + duration 30 è la forma catturata dall'app ufficiale.
export function setAlarmBody(id, wakeEpochSeconds, { ticks = 0, repeats = 7, duration = 30, crescendo = 0 } = {}) {
  return [0x04, id, ...u32(wakeEpochSeconds), ...u16(ticks), ...WAVEFORM, 0, 0, repeats, duration, crescendo];
}

export const getAlarmBody = (id) => [0x04, id];
export const disableAlarmBody = (id = 0xff) => [0x02, id];

export function parseAlarm(body) {
  if (body.length < 21 || body[0] !== 4) return null;
  return { id: body[1], epoch: rd32(body, 2), repeats: body[18], duration: body[19], crescendo: body[20] };
}

export const ALARM_DETAIL = {
  1: 'ok',
  2: 'effetto fuori range',
  3: 'ripetizioni fuori range',
  4: 'durata fuori range',
  10: "orario non nel futuro per l'orologio del braccialetto",
  11: 'slot non valido',
  12: 'crescendo fuori range',
};
