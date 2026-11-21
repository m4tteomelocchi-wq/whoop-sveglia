// Client contro il braccialetto simulato di sim-strap.mjs.
import assert from 'node:assert/strict';
import * as W from '../whoop5.js';

import { SimStrap, simDevice } from './sim-strap.mjs';

const sim = new SimStrap();
const device = simDevice(sim);
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
assert.ok(logs.some((l) => /scarto -(39|40|41)s/.test(l)), 'scarto di circa 40 s rilevato');

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

// Riapertura: il Whoop già autorizzato si riprende con getDevices, senza mostrare l'elenco
await strap.disconnect();
navigator.bluetooth.getDevices = async () => [device];
navigator.bluetooth.requestDevice = async () => { throw new Error("l'elenco non doveva aprirsi"); };
const again = new Strap((l) => logs.push(l));
await again.connect();
await again.buzz();
assert.ok(logs.some((l) => l.includes('Riconnessione diretta')));

// Rifiuto «muto» come quello visto su Bluefy: il log deve dire dove si è fermato, non «undefined»
logs.length = 0;
navigator.bluetooth.getDevices = async () => [{ ...device, gatt: { connect: () => Promise.reject(undefined) } }];
navigator.bluetooth.requestDevice = async () => device;
const mute = new Strap((l) => logs.push(l));
await mute.connect();
assert.match(mute.reconnect, /«collegamento» \(errore senza descrizione\)/);
assert.ok(!logs.join('\n').includes('undefined'));

// Percorso Chrome: il primo collegamento fallisce, dopo un segnale dal braccialetto riesce
let connects = 0;
const watcher = {
  ...device,
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  async watchAdvertisements() { setTimeout(() => this.listeners.advertisementreceived?.(), 50); },
  gatt: { ...device.gatt, connect() { return ++connects === 1 ? Promise.reject(new DOMException('fuori portata', 'NetworkError')) : device.gatt.connect(); } },
};
navigator.bluetooth.getDevices = async () => [watcher];
navigator.bluetooth.requestDevice = async () => { throw new Error("l'elenco non doveva aprirsi"); };
const viaAdv = new Strap((l) => logs.push(l));
await viaAdv.connect();
assert.equal(viaAdv.reconnect, 'funziona');
assert.equal(connects, 2);

// Se la riconnessione diretta non risponde si torna all'elenco
let chooserOpened = false;
navigator.bluetooth.getDevices = async () => [{ ...device, gatt: { connect: () => new Promise(() => {}) } }];
navigator.bluetooth.requestDevice = async () => { chooserOpened = true; return device; };
const third = new Strap((l) => logs.push(l));
await third.connect();
assert.ok(chooserOpened);

// Dopo 2 fallimenti di fila la riconnessione diretta si disattiva e si va dritti all'elenco
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let getDevicesCalls = 0;
navigator.bluetooth.getDevices = async () => { getDevicesCalls++; return [{ ...device, gatt: { connect: () => Promise.reject(undefined) } }]; };
navigator.bluetooth.requestDevice = async () => device;
for (let i = 0; i < 3; i++) await new Strap(() => {}).connect();
assert.equal(getDevicesCalls, 2, 'al terzo giro non deve più tentare');
const skipped = new Strap(() => {});
await skipped.connect();
assert.match(skipped.reconnect, /disattivata dopo 2 tentativi/);
// …e un successo azzera il contatore
mem.set('sveglia-whoop-reconnect-fails', '1');
navigator.bluetooth.getDevices = async () => [device];
navigator.bluetooth.requestDevice = async () => { throw new Error("l'elenco non doveva aprirsi"); };
await new Strap(() => {}).connect();
assert.equal(mem.get('sveglia-whoop-reconnect-fails'), '0');

console.log(`ok — ${sim.writes} comandi scambiati con il braccialetto simulato senza errori`);
