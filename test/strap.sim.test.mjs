// Braccialetto WHOOP 5 simulato: decodifica i frame veri, applica le regole del firmware
// documentate in NOOP (orario nel futuro, slot 1–6, slot svuotato a esecuzione) e risponde
// spezzando i frame in pacchetti da 20 byte come una connessione BLE con MTU minimo.
import assert from 'node:assert/strict';
import * as W from '../whoop5.js';

class SimStrap {
  constructor() {
    this.clockOffset = -40; // orologio indietro di 40 s, come dopo settimane senza app
    this.slots = new Map();
    this.buzzes = 0;
    this.listeners = [];
    this.writes = 0;
  }
  now() { return Math.floor(Date.now() / 1000) + this.clockOffset; }

  respond(cmd, originSeq, result, body) {
    const inner = [36, 0x77, cmd, originSeq, result, ...body];
    while (inner.length % 4) inner.push(0);
    const head = [0xaa, 0x01, (inner.length + 4) & 0xff, (inner.length + 4) >> 8, 0x00, 0x01];
    const c16 = W.crc16modbus(head), c32 = W.crc32(inner);
    const f = [...head, c16 & 0xff, c16 >> 8, ...inner, c32 & 0xff, (c32 >> 8) & 0xff, (c32 >> 16) & 0xff, c32 >>> 24];
    for (let i = 0; i < f.length; i += 20) {
      const part = Uint8Array.from(f.slice(i, i + 20));
      queueMicrotask(() => this.listeners.forEach((l) => l({ target: { value: new DataView(part.buffer) } })));
    }
  }

  receive(frame) {
    this.writes++;
    assert.ok(W.frameOk(frame), 'frame inviato con checksum valido');
    const [type, seq, cmd, ...body] = frame.slice(8, frame.length - 4);
    assert.equal(type, 35);
    const le32 = (a, o) => (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;
    switch (cmd) {
      case W.CMD.GET_HELLO: {
        const b = new Array(110).fill(0);
        b[0] = 1;
        b.splice(1, 4, ...[870, 0, 0, 0].flatMap((v, i) => (i ? [] : [v & 0xff, v >> 8, 0, 0])));
        const t = this.now();
        b.splice(6, 4, t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff, t >>> 24);
        b[91] = 50; b[92] = 42; b[93] = 1;
        this.respond(cmd, seq, 2, [1]); // PENDING prima, poi il risultato
        setTimeout(() => this.respond(cmd, seq, 1, b), 30);
        break;
      }
      case W.CMD.SET_CLOCK:
        this.clockOffset = le32(body, 1) - Math.floor(Date.now() / 1000);
        this.respond(cmd, seq, 1, [1]);
        break;
      case W.CMD.SET_ALARM: {
        const id = body[1], t = le32(body, 2);
        if (id < 1 || id > 6) return this.respond(cmd, seq, 0, [4, 11]);
        if (t <= this.now()) return this.respond(cmd, seq, 0, [4, 10]);
        this.slots.set(id, body.slice(0, 21));
        this.respond(cmd, seq, 1, [4, 1]);
        break;
      }
      case W.CMD.GET_ALARM: {
        const rec = this.slots.get(body[1]) ?? [4, body[1], ...new Array(19).fill(0)];
        this.respond(cmd, seq, 1, rec);
        break;
      }
      case W.CMD.DISABLE_ALARM:
        if (body[1] === 0xff) this.slots.clear(); else this.slots.delete(body[1]);
        this.respond(cmd, seq, 1, [2]);
        break;
      case W.CMD.BUZZ:
        this.buzzes++;
        this.respond(cmd, seq, 2, [1, 0]);
        setTimeout(() => this.respond(cmd, seq, 1, [1, 5]), 20);
        break;
      default:
        this.respond(cmd, seq, 3, []);
    }
  }

  // Come fa il firmware: uno slot scaduto viene eseguito e svuotato
  tick() {
    for (const [id, rec] of this.slots) {
      const t = (rec[2] | (rec[3] << 8) | (rec[4] << 16) | (rec[5] << 24)) >>> 0;
      if (t <= this.now()) { this.slots.delete(id); this.buzzes++; }
    }
  }
}

const sim = new SimStrap();
const characteristic = (uuid) => ({
  uuid,
  addEventListener: (_, fn) => sim.listeners.push(fn),
  startNotifications: async () => {},
  writeValueWithResponse: async (f) => sim.receive(f),
});
const device = {
  name: 'WHOOP 5A1B',
  addEventListener() {},
  gatt: {
    connected: false,
    async connect() { this.connected = true; return this; },
    async getPrimaryService(uuid) {
      assert.equal(uuid, W.SERVICE);
      return {
        getCharacteristic: async (u) => {
          if (u === W.NOTIFY_CHARS[3]) throw new Error('assente su questo firmware');
          return characteristic(u);
        },
      };
    },
    disconnect() { this.connected = false; },
  },
};
Object.defineProperty(globalThis, 'navigator', {
  value: { bluetooth: { requestDevice: async () => device } },
  configurable: true,
});

const { Strap } = await import('../strap.js');
const { nextOccurrences, SCHEDULE_SLOTS, TEST_SLOT } = await import('../schedule.js');

const logs = [];
const strap = new Strap((l) => logs.push(l));
await strap.connect();
assert.ok(strap.connected);

// L'orologio sfasato viene rilevato e corretto
const info = await strap.syncClock();
assert.equal(info.firmware, '50.42.1.0');
assert.equal(info.battery, 87);
assert.ok(Math.abs(info.skew) <= 1, `scarto residuo ${info.skew}`);
assert.ok(logs.some((l) => l.includes('scarto -40s')));

// Settimana completa: 5 slot scritti e riletti
const week = ['', '07:00', '07:00', '07:00', '07:00', '07:00', ''];
const occ = nextOccurrences(week, new Date(), SCHEDULE_SLOTS.length);
for (const [i, slot] of SCHEDULE_SLOTS.entries()) await strap.setAlarm(slot, occ[i]);
assert.equal(sim.slots.size, 6);
for (const [i, slot] of SCHEDULE_SLOTS.entries()) {
  const r = await strap.readAlarm(slot);
  assert.equal(r.epoch, Math.floor(occ[i] / 1000));
  assert.equal(r.repeats, 7);
  assert.equal(r.duration, 30);
}

// Orario nel passato → errore leggibile, niente scritto
await assert.rejects(strap.setAlarm(1, new Date(Date.now() - 5000)), /non nel futuro/);

// Prova tra 2 s sullo slot preso in prestito: il firmware la esegue e svuota lo slot
await strap.setAlarm(TEST_SLOT, new Date(Date.now() + 2000));
const before = sim.buzzes;
await new Promise((r) => setTimeout(r, 2200));
sim.tick();
assert.equal(sim.buzzes, before + 1);
assert.equal((await strap.readAlarm(TEST_SLOT)).epoch, 0);
assert.equal(sim.slots.size, 5, 'la prova tocca solo lo slot in prestito');
// …che si riarma con la sesta occorrenza
await strap.setAlarm(TEST_SLOT, occ[5]);
assert.equal(sim.slots.size, 6);

// Vibrazione immediata con risposta PENDING → SUCCESS
await strap.buzz();

// Disarmo slot per slot
for (const s of [...SCHEDULE_SLOTS, TEST_SLOT]) await strap.disableAlarm(s);
assert.equal(sim.slots.size, 0);

// Molte richieste in sequenza: il numero di sequenza fa il giro senza confondere le risposte
for (let i = 0; i < 300; i++) await strap.readAlarm(1 + (i % 6));

console.log(`ok — ${sim.writes} comandi scambiati con il braccialetto simulato senza errori`);
