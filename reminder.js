// Promemoria nel Calendario per riarmare: un file .ics con un evento ricorrente.
import { nextOccurrences, SCHEDULE_SLOTS } from './schedule.js?v=13';

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Primo momento futuro con quel giorno della settimana e quell'ora.
function nextAt(weekday, hhmm, from) {
  const [h, m] = hhmm.split(':').map(Number);
  for (let d = 0; d < 8; d++) {
    const at = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, h, m);
    if (at.getDay() === weekday && at > from) return at;
  }
}

// Con 6 slot, chi ha la sveglia tutti i giorni deve riarmare ogni 6 giorni, non ogni settimana.
// Verifica la cadenza simulando due giri: ogni volta che si riarma, la prima sveglia
// non coperta deve venire dopo il promemoria successivo.
export function reminderPlan(week, weekday, hhmm, now = new Date()) {
  const activeDays = week.filter(Boolean).length;
  if (!activeDays) return { ok: false, reason: 'Nessuna sveglia in settimana.' };
  const everyDays = activeDays > SCHEDULE_SLOTS.length ? SCHEDULE_SLOTS.length : 7;
  const first = nextAt(weekday, hhmm, now);
  for (let k = 0; k < 2; k++) {
    const armAt = new Date(first.getFullYear(), first.getMonth(), first.getDate() + k * everyDays, first.getHours(), first.getMinutes());
    const nextReminder = new Date(armAt.getFullYear(), armAt.getMonth(), armAt.getDate() + everyDays, armAt.getHours(), armAt.getMinutes());
    const occ = nextOccurrences(week, armAt, SCHEDULE_SLOTS.length + 1);
    const uncovered = occ[SCHEDULE_SLOTS.length];
    if (uncovered && uncovered < nextReminder) {
      return { ok: false, first, everyDays, uncovered, reason: 'Con questo giorno resterebbe scoperta una sveglia.' };
    }
  }
  return { ok: true, first, everyDays };
}

// Il primo giorno che garantisce la copertura, a partire da domenica.
export function suggestWeekday(week, hhmm, now = new Date()) {
  for (const d of [0, 6, 5, 4, 3, 2, 1]) if (reminderPlan(week, d, hhmm, now).ok) return d;
  return 0;
}

const pad = (n) => String(n).padStart(2, '0');
const floating = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Ora locale «floating»: il Calendario la interpreta nel fuso del telefono, ora legale inclusa.
export function buildIcs({ first, everyDays }, appUrl, { now = new Date(), uid } = {}) {
  const end = new Date(first.getTime() + 15 * 60_000);
  const rrule = everyDays === 7
    ? `RRULE:FREQ=WEEKLY;BYDAY=${DAY_CODES[first.getDay()]}`
    : `RRULE:FREQ=DAILY;INTERVAL=${everyDays}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sveglia Whoop//IT',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid ?? `sveglia-whoop-riarmo-${utcStamp(now)}`}@m4tteomelocchi-wq.github.io`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${floating(first)}`,
    `DTEND:${floating(end)}`,
    rrule,
    'SUMMARY:Riarma la sveglia Whoop',
    `DESCRIPTION:Apri Bluefy e premi Arma: ${appUrl}`,
    `URL:${appUrl}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Riarma la sveglia Whoop',
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

// I file sono pubblicati in reminders/: Safari li apre e propone di aggiungerli al Calendario.
// L'inizio è una data fissa nel passato: la ripetizione funziona da lì in avanti e, con lo
// stesso UID, aggiungere di nuovo lo stesso file non crea doppioni.
export const REMINDER_TIMES = ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'];
const REFERENCE_SUNDAY = [2026, 10, 22];

export function reminderFileName({ everyDays, weekday }, hhmm) {
  const t = hhmm.replace(':', '');
  return everyDays === 7 ? `settimanale-${DAY_CODES[weekday].toLowerCase()}-${t}.ics` : `ogni-6-giorni-${t}.ics`;
}

export function staticReminder(everyDays, weekday, hhmm, appUrl) {
  const [y, mo, d] = REFERENCE_SUNDAY;
  const [h, m] = hhmm.split(':').map(Number);
  const first = new Date(y, mo, d + (everyDays === 7 ? weekday : 0), h, m);
  const name = reminderFileName({ everyDays, weekday }, hhmm);
  return { name, ics: buildIcs({ first, everyDays }, appUrl, { now: new Date(Date.UTC(2026, 10, 21)), uid: name.replace('.ics', '') }) };
}
