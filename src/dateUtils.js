// Thailand is fixed at UTC+7 (no DST), so a plain offset is exact and needs no tz database.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function toBangkok(date) {
  return new Date(date.getTime() + BANGKOK_OFFSET_MS);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// "YYYY-MM-DD" for the current moment in Bangkok time.
export function todayStr(date = new Date()) {
  const bkk = toBangkok(date);
  return `${bkk.getUTCFullYear()}-${pad(bkk.getUTCMonth() + 1)}-${pad(bkk.getUTCDate())}`;
}

// "HH:mm" for the current moment in Bangkok time.
export function timeStr(date = new Date()) {
  const bkk = toBangkok(date);
  return `${pad(bkk.getUTCHours())}:${pad(bkk.getUTCMinutes())}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function isValidDateStr(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// Monday-start ISO week range (inclusive) containing dateStr, as ["YYYY-MM-DD", "YYYY-MM-DD"].
export function weekRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = noon.getUTCDay() === 0 ? 7 : noon.getUTCDay(); // Mon=1..Sun=7
  const monday = new Date(noon);
  monday.setUTCDate(noon.getUTCDate() - (dow - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return [fmt(monday), fmt(sunday)];
}

export function monthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
  const last = new Date(Date.UTC(y, m, 0, 12, 0, 0));
  return [fmt(first), fmt(last)];
}

function fmt(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + n);
  return fmt(date);
}
