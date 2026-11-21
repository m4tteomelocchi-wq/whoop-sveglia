import assert from 'node:assert/strict';
import { nextOccurrences, rearmDeadline, dateKey } from '../schedule.js';

process.env.TZ = 'Europe/Rome';

const weekdays = ['', '07:00', '07:00', '07:00', '07:00', '07:00', ''];

// Sabato 21/11/2026 alle 23:00 → lun–ven della settimana dopo
let occ = nextOccurrences(weekdays, new Date(2026, 10, 21, 23, 0));
assert.deepEqual(occ.map(dateKey), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
assert.ok(occ.every((d) => d.getHours() === 7 && d.getMinutes() === 0));
assert.equal(dateKey(rearmDeadline(occ)), '2026-11-26');

// Lunedì 06:59:30: troppo vicino, la sveglia di oggi viene saltata
occ = nextOccurrences(weekdays, new Date(2026, 10, 23, 6, 59, 30));
assert.equal(dateKey(occ[0]), '2026-11-24');

// Lunedì 06:50: quella di oggi è ancora valida
occ = nextOccurrences(weekdays, new Date(2026, 10, 23, 6, 50));
assert.equal(dateKey(occ[0]), '2026-11-23');

// Giorni saltati (es. ferie)
occ = nextOccurrences(weekdays, new Date(2026, 10, 21, 23, 0), 5, new Set(['2026-11-24']));
assert.deepEqual(occ.map(dateKey), ['2026-11-23', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30']);

// Ora legale: domenica 28/3/2027 il passaggio alle 02:00 → la sveglia resta alle 07:00 locali
const daily = Array(7).fill('07:00');
occ = nextOccurrences(daily, new Date(2027, 2, 27, 6, 0), 2);
assert.equal(occ[1].getHours(), 7);
assert.equal((occ[1] - occ[0]) / 3600e3, 23);

// Settimana vuota
assert.deepEqual(nextOccurrences(Array(7).fill(''), new Date()), []);
assert.equal(rearmDeadline([]), null);

console.log('ok — pianificazione corretta (anche con ora legale)');
