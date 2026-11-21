import { Strap } from './strap.js';
import { nextOccurrences, rearmDeadline, dateKey, SCHEDULE_SLOTS, TEST_SLOT } from './schedule.js';

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
strap.onDisconnect = () => { clockSynced = false; };

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

  const deadline = rearmDeadline(up.map((a) => new Date(a.epoch * 1000)));
  if (!state.armed.length && state.armedWeek === null) {
    setPill('idle', 'Non ancora armata');
  } else if (dirty()) {
    setPill('warn', 'Modifiche da armare');
  } else if (!up.length) {
    setPill(nextOccurrences(weekSpec(), new Date(), 1, skipSet()).length ? 'err' : 'idle',
      nextOccurrences(weekSpec(), new Date(), 1, skipSet()).length ? 'Scaduta: riarma' : 'Nessuna sveglia in settimana');
  } else if (up.length < SCHEDULE_SLOTS.length && nextOccurrences(weekSpec(), new Date(), SCHEDULE_SLOTS.length, skipSet()).length > up.length) {
    setPill('warn', `Ne restano ${up.length}: riarma quando puoi`);
  } else {
    setPill('ok', `Armata · riapri entro ${fmtShort.format(deadline)}`);
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
    ...up.map((a) => ({ date: new Date(a.epoch * 1000), slot: a.slot })),
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
        <div class="meta">${it.skippedKey ? 'Saltata: premi Arma per applicare' : it.slot === TEST_SLOT ? 'Prova' : `Slot ${it.slot} · verificata ✓`}</div>
      </div>`;
    if (it.slot !== TEST_SLOT) {
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

function render() {
  renderStatus();
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
const actionButtons = ['arm', 'buzz', 'testAlarm', 'readBack', 'disarm'].map($);

let lastAction = null;

async function run(msgEl, label, fn) {
  if (busy) return;
  lastAction = () => run(msgEl, label, fn);
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
    log(`ERRORE: ${e.name}: ${e.message}`);
    msgEl.className = 'msg err';
    msgEl.textContent = humanError(e);
    if (e.name === 'NotFoundError' || /non è un WHOOP/.test(e.message)) {
      $('notFound').hidden = false;
      $('notFound').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } finally {
    busy = false;
    actionButtons.forEach((b) => (b.disabled = false));
    render();
  }
}

function humanError(e) {
  if (e.name === 'NotFoundError') return 'Braccialetto non trovato: segui i passi in alto.';
  if (/non è un WHOOP/.test(e.message)) return 'Hai scelto un dispositivo che non è il Whoop: segui i passi in alto.';
  if (e.name === 'NetworkError') return 'Connessione persa. Avvicina il telefono al braccialetto e riprova.';
  if (/Bluefy/.test(e.message)) return e.message;
  if (/nessuna risposta/.test(e.message)) return 'Il braccialetto non risponde. Se usi l\'app Whoop, chiudila del tutto e riprova.';
  return `Qualcosa non va: ${e.message}. Apri «Avanzate» e copia il log.`;
}

async function ensureConnected() {
  if (!strap.connected) await strap.connect();
  if (!clockSynced) {
    await strap.syncClock();
    clockSynced = true;
  }
}

async function arm() {
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
  const test = state.armed.find((a) => a.slot === TEST_SLOT && a.epoch > Date.now() / 1000);
  state.armed = test ? [...armed, test] : armed;
  state.armedWeek = weekSpec();
  state.armedSkip = [...state.skip].sort();
  save();
  await strap.buzz().catch(() => {});
  if (!occ.length) return 'Nessuna sveglia in settimana: braccialetto svuotato.';
  return `Fatto. ${occ.length} sveglie scritte e verificate sul braccialetto, che ha appena vibrato per confermare.`;
}

async function testAlarm() {
  // Slot dedicato, così la prova non tocca la settimana armata.
  const at = new Date(Math.ceil((Date.now() + 65_000) / 1000) * 1000);
  const stored = await strap.setAlarm(TEST_SLOT, at);
  state.armed = [...state.armed.filter((a) => a.slot !== TEST_SLOT), { slot: TEST_SLOT, epoch: stored.epoch }];
  save();
  log(`Prova armata per le ${fmtClock.format(at)}`);
  setTimeout(() => verifyTestFired(at), at - Date.now() + 15_000);
  return `Prova armata: dovrebbe vibrare alle ${fmtClock.format(at)}. Puoi anche bloccare il telefono.`;
}

// Quando una sveglia scatta, il firmware svuota lo slot: è la prova che l'ha eseguita.
async function verifyTestFired(at) {
  const msg = $('testMsg');
  try {
    if (!strap.connected || busy) return;
    const slot = await strap.readAlarm(TEST_SLOT);
    const fired = !slot || slot.epoch === 0;
    log(`Verifica prova: slot ${TEST_SLOT} ${fired ? 'svuotato → eseguita dal braccialetto' : `ancora armato (${slot.epoch})`}`);
    msg.className = fired ? 'msg ok' : 'msg err';
    msg.textContent = fired
      ? `Il braccialetto ha eseguito la sveglia delle ${fmtClock.format(at)}. L'hai sentita vibrare?`
      : 'Il braccialetto risulta ancora armato: la prova non è partita. Copia il log da «Avanzate».';
    if (fired) state.armed = state.armed.filter((a) => a.slot !== TEST_SLOT);
    save();
    render();
  } catch (e) {
    log(`Verifica prova non riuscita: ${e.message}`);
  }
}

async function readBack() {
  const records = await strap.readAllAlarms([...SCHEDULE_SLOTS, TEST_SLOT]);
  const now = Date.now() / 1000;
  state.armed = records.filter((r) => r && r.epoch > now).map((r) => ({ slot: r.id, epoch: r.epoch }));
  for (const r of records) if (r) log(`  slot ${r.id}: ${r.epoch ? new Date(r.epoch * 1000).toLocaleString('it-IT') : 'vuoto'}`);
  save();
  return `Sul braccialetto ci sono ${state.armed.length} sveglie future.`;
}

async function disarm() {
  for (const slot of [...SCHEDULE_SLOTS, TEST_SLOT]) await strap.disableAlarm(slot);
  await readBack();
  state.armedWeek = null;
  state.armedSkip = null;
  save();
  if (state.armed.length) throw new Error(`restano ${state.armed.length} sveglie armate`);
  return 'Tutte le sveglie disarmate.';
}

// ── Avvio ───────────────────────────────────────────────────────────────────

$('arm').addEventListener('click', () => run($('armMsg'), 'Connessione al braccialetto…', arm));
$('buzz').addEventListener('click', () => run($('testMsg'), 'Connessione…', async () => { await strap.buzz(); return 'Ha vibrato?'; }));
$('testAlarm').addEventListener('click', () => run($('testMsg'), 'Connessione…', testAlarm));
$('readBack').addEventListener('click', () => run($('armMsg'), 'Lettura…', readBack));
$('disarm').addEventListener('click', () => {
  if (confirm('Disarmare tutte le sveglie sul braccialetto?')) run($('armMsg'), 'Disarmo…', disarm);
});
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
renderWeek();
changed();
setInterval(render, 60_000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && render());
log(`Pronta. Bluetooth web ${navigator.bluetooth ? 'disponibile' : 'NON disponibile'}.`);
