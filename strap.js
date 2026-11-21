// Connessione Web Bluetooth a un WHOOP 5.0 / MG e comandi della sveglia.
import * as W from './whoop5.js?v=13';

const REQUEST_TIMEOUT_MS = 6000;
const CLOCK_TOLERANCE_S = 2;
const KNOWN_DEVICE_KEY = 'sveglia-whoop-device';
const RECONNECT_FAILS_KEY = 'sveglia-whoop-reconnect-fails';
const MAX_RECONNECT_FAILS = 2;
const ADVERTISEMENT_WAIT_MS = 10_000;

function storedNumber(key) {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}
function storeNumber(key, n) {
  try { localStorage.setItem(key, String(n)); } catch {}
}

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms) =>
  Promise.race([promise, sleep(ms).then(() => { throw new Error(`nessuna risposta in ${ms / 1000}s`); })]);

// Alcuni browser rifiutano con valori che non sono Error, o con Error senza messaggio.
export function describe(e) {
  if (e instanceof Error) return [e.name !== 'Error' && e.name, e.message].filter(Boolean).join(': ') || 'errore senza descrizione';
  if (e === undefined || e === null) return 'errore senza descrizione';
  return typeof e === 'string' ? e : JSON.stringify(e);
}

export class Strap {
  constructor(log) {
    this.log = log;
    this.device = null;
    this.command = null;
    this.seq = 1;
    this.reconnect = 'non ancora provata';
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
    let gatt = null;
    if (!this.device) {
      gatt = await this.#reconnectKnown();
      if (!gatt) {
        // Anche per nome: alcuni firmware mettono l'UUID del servizio solo nella scan response.
        this.#adopt(await navigator.bluetooth.requestDevice({
          filters: [{ services: [W.SERVICE] }, { namePrefix: 'WHOOP' }, { namePrefix: 'Whoop' }],
          optionalServices: [W.SERVICE, 'battery_service'],
        }));
      }
    }
    if (!gatt) {
      this.log(`Connessione a ${this.device.name || 'WHOOP'}…`);
      gatt = await this.device.gatt.connect();
    }
    let service;
    try {
      service = await gatt.getPrimaryService(W.SERVICE);
    } catch {
      this.device.gatt.disconnect();
      this.device = null;
      throw new Error('Questo dispositivo non è un WHOOP 5.0 / MG');
    }
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
        this.log(`  notify ${uuid.slice(4, 8)} non disponibile: ${describe(e)}`);
      }
    }
    if (!subscribed) throw new Error('Nessun canale di risposta disponibile sul braccialetto');
    this.log(`Connesso, ${subscribed} canali in ascolto`);
  }

  #adopt(device) {
    this.device = device;
    try { localStorage.setItem(KNOWN_DEVICE_KEY, device.id); } catch {}
    device.addEventListener('gattserverdisconnected', () => {
      this.command = null;
      this.log('Braccialetto disconnesso');
      this.onDisconnect();
    });
  }

  // Riapre il Whoop già scelto in passato senza mostrare l'elenco, dove il browser lo consente.
  // Ogni passaggio ha un nome, così se fallisce il log dice dove anche quando l'errore è muto.
  async #reconnectKnown() {
    if (!navigator.bluetooth.getDevices) {
      this.reconnect = 'non supportata da questo browser';
      this.log('Riconnessione diretta: non supportata, apro l\'elenco');
      return null;
    }
    // Se su questo browser non ha mai funzionato, inutile far aspettare: si va dritti all'elenco.
    const fails = storedNumber(RECONNECT_FAILS_KEY);
    if (fails >= MAX_RECONNECT_FAILS) {
      this.reconnect = `disattivata dopo ${fails} tentativi falliti: si usa l'elenco`;
      this.log(`Riconnessione diretta: ${this.reconnect}`);
      return null;
    }
    let knownId = null;
    try { knownId = localStorage.getItem(KNOWN_DEVICE_KEY); } catch {}
    let stage = 'elenco dei dispositivi autorizzati';
    try {
      const devices = await withTimeout(navigator.bluetooth.getDevices(), 2000);
      const device = devices.find((d) => d.id === knownId) ?? (devices.length === 1 ? devices[0] : null);
      if (!device) {
        this.reconnect = `supportata, ma nessun Whoop memorizzato (${devices.length} dispositivi)`;
        this.log(`Riconnessione diretta: ${this.reconnect}`);
        return null;
      }
      this.log(`Riconnessione diretta a ${device.name || 'WHOOP'}…`);
      let gatt;
      try {
        stage = 'collegamento';
        gatt = await withTimeout(device.gatt.connect(), 2500);
      } catch (first) {
        // Chrome vuole prima un segnale dal braccialetto per i dispositivi presi da getDevices.
        if (!device.watchAdvertisements) throw first;
        this.log(`  collegamento: ${describe(first)}, cerco il segnale del braccialetto (fino a ${ADVERTISEMENT_WAIT_MS / 1000}s)…`);
        stage = 'attesa del segnale';
        const started = Date.now();
        const adv = await withTimeout(new Promise((resolve, reject) => {
          device.addEventListener('advertisementreceived', resolve, { once: true });
          device.watchAdvertisements().catch(reject);
        }), ADVERTISEMENT_WAIT_MS);
        this.log(`  segnale ricevuto dopo ${((Date.now() - started) / 1000).toFixed(1)}s${adv?.rssi ? `, RSSI ${adv.rssi}` : ''}`);
        stage = 'collegamento dopo il segnale';
        gatt = await withTimeout(device.gatt.connect(), 2500);
      }
      this.#adopt(device);
      this.reconnect = 'funziona';
      storeNumber(RECONNECT_FAILS_KEY, 0);
      return gatt;
    } catch (e) {
      storeNumber(RECONNECT_FAILS_KEY, fails + 1);
      this.reconnect = `supportata, ma si ferma a «${stage}» (${describe(e)}) · tentativo ${fails + 1} di ${MAX_RECONNECT_FAILS}`;
      this.log(`Riconnessione diretta: ${this.reconnect}, apro l'elenco`);
      return null;
    }
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
        this.log(`  scrittura rifiutata (${describe(e)}), riprovo…`);
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
