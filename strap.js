// Connessione Web Bluetooth a un WHOOP 5.0 / MG e comandi della sveglia.
import * as W from './whoop5.js';

const REQUEST_TIMEOUT_MS = 6000;
const CLOCK_TOLERANCE_S = 2;

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Strap {
  constructor(log) {
    this.log = log;
    this.device = null;
    this.command = null;
    this.seq = 1;
    this.pending = new Map();
    this.reassemblers = new Map();
    this.onDisconnect = () => {};
  }

  get connected() {
    return !!this.device?.gatt?.connected && !!this.command;
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error('Questo browser non supporta il Bluetooth. Su iPhone apri la pagina in Bluefy.');
    }
    if (!this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [W.SERVICE] }],
        optionalServices: ['battery_service'],
      });
      this.device.addEventListener('gattserverdisconnected', () => {
        this.command = null;
        this.log('Braccialetto disconnesso');
        this.onDisconnect();
      });
    }
    this.log(`Connessione a ${this.device.name || 'WHOOP'}…`);
    const gatt = await this.device.gatt.connect();
    const service = await gatt.getPrimaryService(W.SERVICE);
    this.command = await service.getCharacteristic(W.COMMAND_CHAR);

    let subscribed = 0;
    for (const uuid of W.NOTIFY_CHARS) {
      try {
        const ch = await service.getCharacteristic(uuid);
        const r = new W.Reassembler();
        this.reassemblers.set(uuid, r);
        ch.addEventListener('characteristicvaluechanged', (e) => this.#onNotify(r, e.target.value));
        await ch.startNotifications();
        subscribed++;
      } catch (e) {
        this.log(`  notify ${uuid.slice(4, 8)} non disponibile: ${e.message}`);
      }
    }
    if (!subscribed) throw new Error('Nessun canale di risposta disponibile sul braccialetto');
    this.log(`Connesso, ${subscribed} canali in ascolto`);
  }

  async disconnect() {
    this.device?.gatt?.disconnect();
  }

  #onNotify(reassembler, dataView) {
    const chunk = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
    for (const frame of reassembler.feed(chunk)) {
      if (!W.frameOk(frame)) continue;
      const resp = W.parseResponse(frame);
      if (!resp) continue;
      const waiter = this.pending.get(resp.originSeq);
      if (!waiter || waiter.cmd !== resp.cmd) continue;
      // PENDING = il braccialetto sta ancora lavorando: si aspetta il risultato finale.
      if (resp.result === 2 && !waiter.acceptPending) continue;
      this.pending.delete(resp.originSeq);
      clearTimeout(waiter.timer);
      waiter.resolve(resp);
    }
  }

  async #write(frame) {
    // La prima scrittura sul canale cifrato può scatenare il pairing di iOS: un secondo tentativo dopo.
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.command.writeValueWithResponse) await this.command.writeValueWithResponse(frame);
        else await this.command.writeValue(frame);
        return;
      } catch (e) {
        if (attempt >= 3) throw e;
        this.log(`  scrittura rifiutata (${e.message}), riprovo…`);
        await sleep(1500);
      }
    }
  }

  async request(cmd, body, { timeout = REQUEST_TIMEOUT_MS, acceptPending = false } = {}) {
    if (!this.connected) throw new Error('Braccialetto non connesso');
    const seq = this.seq;
    this.seq = (this.seq % 255) + 1;
    const frame = W.commandFrame(cmd, seq, body);
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`nessuna risposta al comando ${cmd}`));
      }, timeout);
      this.pending.set(seq, { cmd, resolve, timer, acceptPending });
    });
    await this.#write(frame);
    const resp = await done;
    this.log(`  ← cmd ${cmd} ${W.RESULT[resp.result] ?? resp.result} ${hex(resp.body.slice(0, 24))}`);
    return resp;
  }

  async hello() {
    const resp = await this.request(W.CMD.GET_HELLO, W.helloBody());
    const info = W.parseHello(resp.body);
    if (!info) throw new Error('Risposta di saluto non riconosciuta: è un WHOOP 5.0 / MG?');
    return info;
  }

  // Senza abbonamento nessuno risincronizza più l'orologio del braccialetto: lo facciamo noi.
  async syncClock() {
    let info = await this.hello();
    const skew = info.clock - Math.floor(Date.now() / 1000);
    this.log(`Orologio braccialetto: scarto ${skew}s · batteria ${info.battery}% · firmware ${info.firmware}`);
    if (Math.abs(skew) > CLOCK_TOLERANCE_S) {
      const r = await this.request(W.CMD.SET_CLOCK, W.setClockBody(Math.floor(Date.now() / 1000)));
      if (r.result !== 1) this.log(`  impostazione orologio: esito ${W.RESULT[r.result] ?? r.result}`);
      info = await this.hello();
      const after = info.clock - Math.floor(Date.now() / 1000);
      this.log(`Orologio corretto, nuovo scarto ${after}s`);
      info.skew = after;
    } else {
      info.skew = skew;
    }
    return info;
  }

  async buzz() {
    await this.request(W.CMD.BUZZ, W.buzzBody(2), { acceptPending: true });
  }

  async setAlarm(slot, date) {
    const epoch = Math.floor(date.getTime() / 1000);
    const r = await this.request(W.CMD.SET_ALARM, W.setAlarmBody(slot, epoch));
    const detail = r.body[1];
    if (r.result !== 1 || detail !== 1) {
      throw new Error(`slot ${slot}: ${W.ALARM_DETAIL[detail] ?? `esito ${r.result}/${detail}`}`);
    }
    // Una conferma da sola non basta: rileggiamo cosa ha memorizzato davvero.
    const stored = await this.readAlarm(slot);
    if (stored?.epoch !== epoch) {
      throw new Error(`slot ${slot}: riletto ${stored?.epoch ?? 'niente'} invece di ${epoch}`);
    }
    return stored;
  }

  async readAlarm(slot) {
    const r = await this.request(W.CMD.GET_ALARM, W.getAlarmBody(slot));
    return r.result === 1 ? W.parseAlarm(r.body) : null;
  }

  async readAllAlarms(slots) {
    const out = [];
    for (const s of slots) out.push(await this.readAlarm(s));
    return out;
  }

  async disableAlarm(slot) {
    const r = await this.request(W.CMD.DISABLE_ALARM, W.disableAlarmBody(slot));
    return r.result === 1;
  }
}
