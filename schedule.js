// Pianificazione: il firmware ha solo sveglie one-shot, quindi la ricorrenza settimanale
// si ottiene armando le prossime N occorrenze in slot distinti.

export const SCHEDULE_SLOTS = [1, 2, 3, 4, 5, 6];
// La prova prende in prestito l'ultimo slot, che viene riarmato appena ha suonato.
export const TEST_SLOT = 6;

// Margine minimo: il braccialetto rifiuta orari non nel futuro rispetto al suo orologio.
const MIN_LEAD_MS = 90_000;

// week[0..6] = "HH:MM" oppure "" (0 = domenica, come Date#getDay). skip = Set di "YYYY-MM-DD".
export function nextOccurrences(week, now = new Date(), count = SCHEDULE_SLOTS.length, skip = new Set()) {
  const out = [];
  for (let d = 0; d < 22 && out.length < count; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const hhmm = week[day.getDay()];
    if (!hhmm || skip.has(dateKey(day))) continue;
    const [h, m] = hhmm.split(':').map(Number);
    // Costruita in ora locale: il cambio ora legale è gestito da Date.
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
    if (at.getTime() - now.getTime() >= MIN_LEAD_MS) out.push(at);
  }
  return out;
}

export function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Entro quando riarmare: la sera prima della prima sveglia in programma che NON è armata.
// Se quella sveglia è prima delle 22 del giorno stesso in cui si arma, basta riarmare prima di lei.
export function rearmDeadline(firstUnarmed) {
  if (!firstUnarmed) return null;
  const eve = new Date(firstUnarmed.getFullYear(), firstUnarmed.getMonth(), firstUnarmed.getDate() - 1, 22, 0);
  return eve;
}
