import assert from 'node:assert/strict';
import { reminderPlan, suggestWeekday, buildIcs, staticReminder } from '../reminder.js';

process.env.TZ = 'Europe/Rome';
const now = new Date(2026, 10, 21, 23, 0); // sabato

const weekdays = ['', '07:00', '07:00', '07:00', '07:00', '07:00', ''];
const daily = Array(7).fill('07:00');
const sixDays = ['', '07:00', '07:00', '07:00', '07:00', '07:00', '08:00'];

// Lun–ven: la domenica sera va benissimo, ogni settimana
let p = reminderPlan(weekdays, 0, '21:00', now);
assert.ok(p.ok);
assert.equal(p.everyDays, 7);
assert.equal(p.first.getDate(), 22);
assert.equal(suggestWeekday(weekdays, '21:00', now), 0);

// Lun–ven con promemoria il mercoledì: armando mercoledì sera si coprono gio→gio dopo, ok
assert.ok(reminderPlan(weekdays, 3, '21:00', now).ok);

// Fino a 6 giorni su 7, 6 slot coprono sempre una settimana: va bene qualsiasi giorno
for (let d = 0; d < 7; d++) assert.ok(reminderPlan(sixDays, d, '21:00', now).ok, `giorno ${d}`);

// Tutti i giorni: niente cadenza settimanale, ogni 6 giorni
p = reminderPlan(daily, 0, '21:00', now);
assert.ok(p.ok);
assert.equal(p.everyDays, 6);


// Nessuna sveglia
assert.ok(!reminderPlan(Array(7).fill(''), 0, '21:00', now).ok);

// File .ics ben formato
const ics = buildIcs(reminderPlan(weekdays, 0, '21:00', now), 'https://example.org/app/', { now });
assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
assert.match(ics, /\r\nDTSTART:20261122T210000\r\n/);
assert.match(ics, /\r\nRRULE:FREQ=WEEKLY;BYDAY=SU\r\n/);
assert.match(ics, /\r\nTRIGGER:PT0M\r\n/);
assert.ok(!/[^\r]\n/.test(ics), 'solo CRLF');
assert.ok(ics.split('\r\n').every((l) => l.length <= 75), 'righe entro 75 caratteri');
assert.match(buildIcs(reminderPlan(daily, 0, '21:00', now), 'https://x/', { now }), /RRULE:FREQ=DAILY;INTERVAL=6/);

// File statici: domenica 21:00 → prima occorrenza domenica 22/11/2026, UID stabile
const st = staticReminder(7, 0, '21:00', 'https://x/');
assert.equal(st.name, 'settimanale-su-2100.ics');
assert.match(st.ics, /DTSTART:20261122T210000/);
assert.match(st.ics, /UID:settimanale-su-2100@/);
assert.match(staticReminder(7, 3, '20:30', 'https://x/').ics, /DTSTART:20261125T203000\r\nDTEND:20261125T204500\r\nRRULE:FREQ=WEEKLY;BYDAY=WE/);
assert.equal(staticReminder(6, 0, '22:00', 'https://x/').name, 'ogni-6-giorni-2200.ics');

console.log('ok — promemoria: cadenza verificata e .ics valido');
