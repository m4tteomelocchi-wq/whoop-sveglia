import { Strap, describe } from './strap.js?v=12';
import { nextOccurrences, rearmDeadline, dateKey, SCHEDULE_SLOTS, TEST_SLOT } from './schedule.js?v=12';

const $ = (id) => document.getElementById(id);
const DAYS = [[1, 'Lunedì'], [2, 'Martedì'], [3, 'Mercoledì'], [4, 'Giovedì'], [5, 'Venerdì'], [6, 'Sabato'], [0, 'Domenica']];
const fmtTime = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtClock = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ── Stato persistente (solo su questo telefono) ─────────────────────────────

const STORE_KEY = 'sveglia-whoop-v1';
const defaults = () => ({
  // week[getDay()] = { on, time }
  week: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ on: d >= 1 && d <= 5, time: d >= 1 && d <= 5 ? '07:00' : '09:00' })),
  skip: [],
  armed: [],      // [{ slot, epoch }] come riletto dal braccialetto
  armedWeek: null,
  armedSkip: null,
  strap: null,    // { battery, firmware, skew, at } dall'ultima connessione
});

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...defaults(), ...JSON.parse(raw) };
  } catch {}
  return defaults();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

const state = load();
const weekSpec = () => state.week.map((d) => (d.on ? d.time : ''));
const skipSet = () => new Set(state.skip);
const dirty = () =>
  state.armedWeek !== null &&
  (JSON.stringify(weekSpec()) !== JSON.stringify(state.armedWeek) ||
    JSON.stringify([...state.skip].sort()) !== JSON.stringify(state.armedSkip));

// ── Log ─────────────────────────────────────────────────────────────────────

const logLines = [];
function log(line) {
  logLines.push(`${fmtClock.format(new Date())}  ${line}`);
  if (logLines.length > 400) logLines.shift();
  $('log').textContent = logLines.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

const strap = new Strap(log);
let clockSynced = false;
let connectedAt = null;
let connecting = false;
strap.onDisconnect = () => { clockSynced = false; connectedAt = null; $('connMsg').textContent = ''; render(); };

// ── Render ──────────────────────────────────────────────────────────────────

function renderWeek() {
  const el = $('week');
  el.replaceChildren();
  for (const [d, name] of DAYS) {
    const day = state.week[d];
    const row = document.createElement('div');
    row.className = 'day-row' + (day.on ? '' : ' off');
    row.innerHTML = `
      <span class="name">${name}</span>
      <input type="time" value="${day.time}" aria-label="Orario ${name}">
      <label class="switch"><input type="checkbox" ${day.on ? 'checked' : ''} aria-label="Sveglia ${name}"><span></span></label>`;
    const [time, toggle] = row.querySelectorAll('input');
    time.addEventListener('change', () => {
      day.time = time.value || day.time;
      if (!day.on) { day.on = true; toggle.checked = true; row.classList.remove('off'); }
      changed();
    });
    toggle.addEventListener('change', () => {
      day.on = toggle.checked;
      row.classList.toggle('off', !day.on);
      changed();
    });
    el.append(row);
  }
}

function upcomingArmed() {
  const now = Date.now() / 1000;
  return state.armed.filter((a) => a.epoch > now).sort((a, b) => a.epoch - b.epoch);
}

const LOW_BATTERY = 25;

function renderStrapInfo() {
  const el = $('strapInfo');
  const s = state.strap;
  if (!s) { el.textContent = ''; return; }
  const ago = Math.round((Date.now() - s.at) / 86_400_000);
  const when = ago === 0 ? 'oggi' : ago === 1 ? 'ieri' : `${ago} giorni fa`;
  const low = s.battery < LOW_BATTERY;
  el.className = 'strap-info' + (low ? ' low' : '');
  el.textContent = low
    ? `Batteria del Whoop al ${Math.round(s.battery)}% (${when}): ricaricalo, se si spegne le sveglie si possono perdere.`
    : `Whoop: batteria ${Math.round(s.battery)}% · orologio allineato · ${when}`;
}

const fmtDuration = (ms) => {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'meno di un minuto';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
};

// Fino a quando le sveglie funzionano anche senza collegamento (calcolata da renderStatus).
let coverageUntil = null;

function renderConnection() {
  const card = $('conn');
  const on = strap.connected && connectedAt;
  card.className = `card conn ${on ? 'on' : connecting ? 'busy' : 'off'}`;
  const until = coverageUntil
    ? `Le sveglie suonano anche senza collegamento fino a <strong>${fmtDay.format(coverageUntil)}</strong>.`
    : 'Nessuna sveglia armata: collegalo e premi Arma.';
  if (on) {
    $('connTitle').textContent = `Collegato a ${strap.device.name || 'WHOOP'}`;
    $('connSub').innerHTML = `Da ${fmtDuration(Date.now() - connectedAt)} · resta collegato finché Bluefy è aperto e il telefono è vicino.<br>${until}`;
    $('connect').textContent = 'Scollega';
    $('connect').classList.remove('primary');
  } else if (connecting) {
    $('connTitle').textContent = 'Collegamento in corso…';
    $('connSub').textContent = 'Se compare l\'elenco, scegli il tuo Whoop.';
  } else {
    $('connTitle').textContent = 'Whoop non collegato';
    $('connSub').innerHTML = until;
    $('connect').textContent = 'Collega il Whoop';
    $('connect').classList.add('primary');
  }
  renderStrapInfo();
}

function renderStatus() {
  const up = upcomingArmed();
  const pill = $('statusPill');
  const next = up[0] && new Date(up[0].epoch * 1000);

  if (next) {
    $('heroLabel').textContent = 'Prossima sveglia';
    $('heroTime').textContent = fmtTime.format(next);
    $('heroDay').textContent = fmtDay.format(next);
  } else {
    const planned = nextOccurrences(weekSpec(), new Date(), 1, skipSet())[0];
    $('heroLabel').textContent = planned ? 'In programma (non armata)' : 'Prossima sveglia';
    $('heroTime').textContent = planned ? fmtTime.format(planned) : '--:--';
    $('heroDay').textContent = planned ? fmtDay.format(planned) : 'Nessuna sveglia attiva';
  }

  // La prima sveglia in programma che il braccialetto non ha: è lei a fissare la scadenza.
  const armedEpochs = new Set(up.filter((a) => !a.test).map((a) => a.epoch));
  const firstUnarmed = nextOccurrences(weekSpec(), new Date(), SCHEDULE_SLOTS.length + 1, skipSet())
    .find((d) => !armedEpochs.has(Math.floor(d / 1000)));
  const deadline = rearmDeadline(firstUnarmed);
  coverageUntil = armedEpochs.size ? new Date(Math.max(...armedEpochs) * 1000) : null;

  if (!state.armed.length && state.armedWeek === null) {
    setPill('idle', 'Non ancora armata');
  } else if (dirty()) {
    setPill('warn', 'Modifiche da armare');
  } else if (!firstUnarmed) {
    setPill(armedEpochs.size ? 'ok' : 'idle', armedEpochs.size ? 'Armata' : 'Nessuna sveglia in settimana');
  } else if (!armedEpochs.size || firstUnarmed < new Date(Math.max(...armedEpochs) * 1000)) {
    setPill('err', `Manca la sveglia di ${fmtShort.format(firstUnarmed)}: premi Arma`);
  } else if (new Date() >= deadline) {
    setPill('warn', `Riarma prima di ${fmtShort.format(firstUnarmed)}, ${fmtTime.format(firstUnarmed)}`);
  } else {
    setPill('ok', `Armata · riapri entro ${fmtShort.format(deadline)} sera`);
  }

  function setPill(kind, text) {
    pill.className = `pill ${kind}`;
    pill.textContent = text;
  }
}

function renderArmed() {
  const list = $('armed');
  list.replaceChildren();
  const up = upcomingArmed();
  // Anche le occorrenze saltate, così si possono ripristinare.
  const skipped = state.skip
    .map((k) => {
      const [y, m, d] = k.split('-').map(Number);
      const t = state.week[new Date(y, m - 1, d).getDay()];
      if (!t.on) return null;
      const [h, mi] = t.time.split(':').map(Number);
      return { key: k, date: new Date(y, m - 1, d, h, mi) };
    })
    .filter((s) => s && s.date > new Date());

  const items = [
    ...up.map((a) => ({ date: new Date(a.epoch * 1000), slot: a.slot, test: a.test })),
    ...skipped.map((s) => ({ date: s.date, skippedKey: s.key })),
  ].sort((a, b) => a.date - b.date);

  $('armedEmpty').hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement('li');
    if (it.skippedKey) li.className = 'skipped';
    const day = fmtDay.format(it.date);
    li.innerHTML = `
      <div>
        <div class="when">${day.charAt(0).toUpperCase() + day.slice(1)} · <b>${fmtTime.format(it.date)}</b></div>
        <div class="meta">${it.skippedKey ? 'Saltata: premi Arma per applicare' : it.test ? `Prova · slot ${it.slot}` : `Slot ${it.slot} · verificata ✓`}</div>
      </div>`;
    if (!it.test) {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = it.skippedKey ? 'Ripristina' : 'Salta';
      btn.addEventListener('click', () => {
        const key = it.skippedKey ?? dateKey(it.date);
        state.skip = it.skippedKey ? state.skip.filter((k) => k !== key) : [...state.skip, key];
        changed();
      });
      li.append(btn);
    }
    list.append(li);
  }
}

function renderPendingTest() {
  const test = pendingTest();
  const card = $('pendingTest');
  // Resta visibile dopo la verifica finché c'è un messaggio da leggere.
  if (!test && !$('pendingMsg').textContent) { card.hidden = true; return; }
  card.hidden = false;
  if (test) $('pendingText').textContent =
    `La sveglia di prova delle ${fmtTime.format(new Date(test.epoch * 1000))} doveva suonare mentre l'app era chiusa. Verifica che il braccialetto l'abbia eseguita: poi la settimana si ricompleta da sola.`;
  $('verifyTest').hidden = !test;
}

function render() {
  renderPendingTest();
  renderStatus();
  renderConnection();
  renderArmed();
}

function changed() {
  // I giorni saltati già passati non servono più.
  const today = dateKey(new Date());
  state.skip = state.skip.filter((k) => k >= today);
  save();
  render();
}

// ── Azioni ──────────────────────────────────────────────────────────────────

let busy = false;
const actionButtons = ['connect', 'arm', 'buzz', 'testAlarm', 'readBack', 'disarm', 'verifyTest'].map($);

let lastAction = null;
let currentMsg = null;

async function run(msgEl, label, fn) {
  if (busy) return;
  lastAction = () => run(msgEl, label, fn);
  currentMsg = msgEl;
  busy = true;
  actionButtons.forEach((b) => (b.disabled = true));
  msgEl.className = 'msg';
  msgEl.textContent = label;
  try {
    await ensureConnected();
    $('notFound').hidden = true;
    const text = await fn();
    msgEl.className = 'msg ok';
    msgEl.textContent = text;
  } catch (e) {
    log(`ERRORE: ${describe(e)}`);
    msgEl.className = 'msg err';
    msgEl.textContent = humanError(e);
    if (e?.name === 'NotFoundError' || /non è un WHOOP/.test(e?.message)) {
      $('notFound').hidden = false;
      $('notFound').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } finally {
    busy = false;
    actionButtons.forEach((b) => (b.disabled = false));
    $('reconnectInfo').textContent = `Riconnessione senza elenco: ${strap.reconnect}.`;
    render();
  }
}

function humanError(e) {
  const m = e instanceof Error ? e.message : describe(e);
  if (e?.name === 'NotFoundError') return 'Braccialetto non trovato: segui i passi in alto.';
  if (/non è un WHOOP/.test(m)) return 'Hai scelto un dispositivo che non è il Whoop: segui i passi in alto.';
  // Dopo un tentativo di riconnessione lungo, il browser può non considerare più il tocco «fresco».
  if (e?.name === 'SecurityError') return 'Tocca di nuovo il pulsante per scegliere il Whoop.';
  if (e?.name === 'NetworkError') return 'Connessione persa. Avvicina il telefono al braccialetto e riprova.';
  if (/Bluefy|ancora armata/.test(m)) return m.charAt(0).toUpperCase() + m.slice(1) + '.';
  if (/nessuna risposta/.test(m)) return 'Il braccialetto non risponde. Se usi l\'app Whoop, chiudila del tutto e riprova.';
  return `Qualcosa non va: ${m}. Apri «Avanzate» e copia il log.`;
}

async function ensureConnected() {
  if (!strap.connected) {
    const msg = currentMsg;
    if (msg) msg.textContent = 'Cerco il Whoop…';
    connecting = true;
    render();
    try {
      await strap.connect();
    } finally {
      connecting = false;
    }
    connectedAt = Date.now();
    if (msg) msg.textContent = 'Collegato, un attimo…';
  }
  if (!clockSynced) {
    const info = await strap.syncClock();
    state.strap = { battery: info.battery, firmware: info.firmware, skew: info.skew, at: Date.now() };
    save();
    clockSynced = true;
  }
}

async function arm({ confirmBuzz = true } = {}) {
  const occ = nextOccurrences(weekSpec(), new Date(), SCHEDULE_SLOTS.length, skipSet());
  log(`Armo ${occ.length} sveglie: ${occ.map((d) => fmtShort.format(d) + ' ' + fmtTime.format(d)).join(', ') || 'nessuna'}`);
  const armed = [];
  for (const [i, slot] of SCHEDULE_SLOTS.entries()) {
    if (occ[i]) {
      const stored = await strap.setAlarm(slot, occ[i]);
      armed.push({ slot, epoch: stored.epoch });
    } else {
      // Slot avanzato da una settimana precedente: va svuotato davvero.
      await strap.disableAlarm(slot);
      const left = await strap.readAlarm(slot);
      if (left && left.epoch > Date.now() / 1000) throw new Error(`slot ${slot} non si è svuotato`);
    }
  }
  state.armed = armed;
  state.armedWeek = weekSpec();
  state.armedSkip = [...state.skip].sort();
  save();
  if (confirmBuzz) await strap.buzz().catch(() => {});
  if (!occ.length) return 'Nessuna sveglia in settimana: braccialetto svuotato.';
  return `Fatto. ${occ.length} sveglie scritte e verificate sul braccialetto, che ha appena vibrato per confermare.`;
}

async function testAlarm() {
  // Prende in prestito l'ultimo slot: le prime sveglie della settimana restano intatte.
  const at = new Date(Math.ceil((Date.now() + 65_000) / 1000) * 1000);
  const stored = await strap.setAlarm(TEST_SLOT, at);
  state.armed = [...state.armed.filter((a) => a.slot !== TEST_SLOT), { slot: TEST_SLOT, epoch: stored.epoch, test: true }];
  save();
  log(`Prova armata per le ${fmtClock.format(at)}`);
  // Se la pagina resta aperta e collegata, la verifica parte da sola; altrimenti alla riapertura
  // compare la scheda «Prova da verificare».
  setTimeout(() => {
    if (strap.connected && !busy) run($('testMsg'), 'Verifico la prova…', checkTest);
  }, at - Date.now() + 15_000);
  return `Prova armata per le ${fmtClock.format(at)}. Puoi chiudere Bluefy e allontanarti: vibra lo stesso.`;
}

const pendingTest = () => state.armed.find((a) => a.test && a.epoch * 1000 < Date.now());

// Quando una sveglia scatta, il firmware svuota lo slot: è la prova che l'ha eseguita.
async function checkTest() {
  const test = state.armed.find((a) => a.test);
  if (!test) return 'Nessuna prova da verificare.';
  const at = fmtTime.format(new Date(test.epoch * 1000));
  const slot = await strap.readAlarm(test.slot);
  if (slot && slot.epoch === test.epoch) {
    log(`Verifica prova: slot ${test.slot} ancora armato (${slot.epoch})`);
    throw new Error(`la prova delle ${at} risulta ancora armata: il braccialetto non l'ha eseguita`);
  }
  log(`Verifica prova: slot ${test.slot} svuotato → eseguita dal braccialetto`);
  state.armed = state.armed.filter((a) => !a.test);
  save();
  let text = `Confermato: il braccialetto ha eseguito da solo la prova delle ${at}.`;
  // Restituisce lo slot preso in prestito alla settimana.
  if (state.armedWeek !== null && !dirty()) {
    await arm({ confirmBuzz: false });
    text += ' Settimana di nuovo completa.';
  }
  return text;
}

async function readBack() {
  if (pendingTest()) return checkTest();
  const test = state.armed.find((a) => a.test);
  const records = await strap.readAllAlarms(SCHEDULE_SLOTS);
  const now = Date.now() / 1000;
  state.armed = records.filter((r) => r && r.epoch > now).map((r) => ({
    slot: r.id, epoch: r.epoch, test: test?.slot === r.id && test.epoch === r.epoch,
  }));
  for (const r of records) if (r) log(`  slot ${r.id}: ${r.epoch ? new Date(r.epoch * 1000).toLocaleString('it-IT') : 'vuoto'}`);
  save();
  return `Sul braccialetto ci sono ${state.armed.length} sveglie future.`;
}

async function disarm() {
  for (const slot of SCHEDULE_SLOTS) await strap.disableAlarm(slot);
  state.armed = [];
  await readBack();
  state.armedWeek = null;
  state.armedSkip = null;
  save();
  if (state.armed.length) throw new Error(`restano ${state.armed.length} sveglie armate`);
  return 'Tutte le sveglie disarmate.';
}

// ── Avvio ───────────────────────────────────────────────────────────────────

$('connect').addEventListener('click', () => {
  if (strap.connected) {
    strap.disconnect();
    strap.command = null;
    connectedAt = null;
    clockSynced = false;
    $('connMsg').textContent = '';
    render();
    return;
  }
  run($('connMsg'), 'Cerco il Whoop…', async () => {
    return '';
  });
});
$('arm').addEventListener('click', () => run($('armMsg'), 'Connessione al braccialetto…', arm));
$('buzz').addEventListener('click', () => run($('testMsg'), 'Connessione…', async () => { await strap.buzz(); return 'Ha vibrato?'; }));
$('testAlarm').addEventListener('click', () => run($('testMsg'), 'Connessione…', testAlarm));
$('readBack').addEventListener('click', () => run($('advMsg'), 'Lettura…', readBack));
$('disarm').addEventListener('click', () => {
  if (confirm('Disarmare tutte le sveglie sul braccialetto?')) run($('advMsg'), 'Disarmo…', disarm);
});
$('verifyTest').addEventListener('click', () => run($('pendingMsg'), 'Connessione al braccialetto…', checkTest));
$('copyWeekdays').addEventListener('click', () => {
  const mon = state.week[1];
  for (const d of [2, 3, 4, 5]) state.week[d] = { ...mon };
  renderWeek();
  changed();
});
$('copyLog').addEventListener('click', async () => {
  const text = [`UA: ${navigator.userAgent}`, `Stato: ${JSON.stringify(state)}`, ...logLines].join('\n');
  try { await navigator.clipboard.writeText(text); $('copyLog').textContent = 'Copiato ✓'; }
  catch { $('copyLog').textContent = 'Selezionalo a mano'; }
  setTimeout(() => ($('copyLog').textContent = 'Copia log'), 2000);
});
$('retry').addEventListener('click', () => lastAction?.());
$('copyUrl').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); $('copyUrl').textContent = 'Copiato ✓'; } catch {}
});

if (!navigator.bluetooth) {
  $('noBluetooth').hidden = false;
  $('pageUrl').textContent = location.href;
}
// Bluefy tiene in cache anche la pagina: se sul server c'è una versione più nuova, ricarica.
const APP_VERSION = 12;
async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { v } = await res.json();
    const url = new URL(location.href);
    // Una sola ricarica per versione: se il server serve ancora la pagina vecchia, niente giri infiniti.
    if (v > APP_VERSION && !busy && url.searchParams.get('v') !== String(v)) {
      log(`Nuova versione ${v} disponibile, ricarico…`);
      url.searchParams.set('v', v);
      location.replace(url);
    }
  } catch {}
}
checkForUpdate();
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkForUpdate());

renderWeek();
changed();
setInterval(render, 30_000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && render());
log(`Pronta (versione 12). Bluetooth web ${navigator.bluetooth ? 'disponibile' : 'NON disponibile'}.`);
