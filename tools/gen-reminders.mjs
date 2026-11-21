// Genera reminders/*.ics: un file per ogni giorno e orario proponibili, più la cadenza di 6 giorni.
// Uso: bun tools/gen-reminders.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { staticReminder, REMINDER_TIMES } from '../reminder.js';

const APP_URL = 'https://m4tteomelocchi-wq.github.io/whoop-sveglia/';
const dir = new URL('../reminders/', import.meta.url);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir);
let n = 0;
for (const t of REMINDER_TIMES) {
  for (let d = 0; d < 7; d++) write(staticReminder(7, d, t, APP_URL));
  write(staticReminder(6, 0, t, APP_URL));
}
function write({ name, ics }) { writeFileSync(new URL(name, dir), ics); n++; }
console.log(`${n} promemoria generati in reminders/`);
