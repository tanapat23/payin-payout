import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from './dateUtils.js';
import { levelFor, thresholdsFor } from './diamonds.js';

const DATA_DIR = path.resolve('data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const defaultData = { days: {}, entries: [] };

await mkdir(DATA_DIR, { recursive: true });
const db = new Low(new JSONFile(DATA_FILE), defaultData);
await db.read();
db.data ||= defaultData;
db.data.days ||= {};
db.data.entries ||= [];

// Migration: backfill aggregate fields on any day missing them, then purge entries
// belonging to already-closed days — closed days keep only their daily totals.
let migrated = false;
for (const day of Object.values(db.data.days)) {
  if (day.income === undefined) {
    const entries = db.data.entries.filter((e) => e.date === day.date);
    day.income = entries.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
    day.expense = entries.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
    day.diamonds = entries.reduce((s, e) => s + (e.diamond || 0), 0);
    day.diamondLevel = levelFor(day.diamonds, thresholdsFor(day.date));
    day.count = entries.length;
    migrated = true;
  }
}
const beforeCount = db.data.entries.length;
db.data.entries = db.data.entries.filter((e) => db.data.days[e.date]?.status !== 'closed');
if (db.data.entries.length !== beforeCount) migrated = true;
if (migrated) await db.write();

function getOrCreateDay(dateStr) {
  if (!db.data.days[dateStr]) {
    db.data.days[dateStr] = {
      date: dateStr,
      status: 'closed', // 'open' | 'closed' — a day starts closed until the driver taps "start"
      pendingType: null, // 'income' | 'expense' | null — set while awaiting a typed amount
      startedAt: null,
      endedAt: null,
      income: 0,
      expense: 0,
      diamonds: 0,
      diamondLevel: 0,
      count: 0,
    };
  }
  return db.data.days[dateStr];
}

export function getDay(dateStr) {
  return db.data.days[dateStr] || null;
}

export async function startDay(dateStr) {
  const day = getOrCreateDay(dateStr);
  if (day.status !== 'open') {
    day.status = 'open';
    day.startedAt = nowIso();
    day.endedAt = null;
  }
  await db.write();
  return day;
}

export async function setPendingType(dateStr, type) {
  const day = getOrCreateDay(dateStr);
  day.pendingType = type;
  await db.write();
  return day;
}

export async function clearPendingType(dateStr) {
  const day = getOrCreateDay(dateStr);
  day.pendingType = null;
  await db.write();
  return day;
}

// diamond: optional diamond count gained with this entry (income only, per Grab's daily quest).
export async function addEntry(dateStr, type, amount, diamond = 0) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: dateStr,
    type,
    amount,
    diamond,
    createdAt: nowIso(),
  };
  db.data.entries.push(entry);
  const day = getOrCreateDay(dateStr);
  day.pendingType = null;
  if (type === 'income') day.income += amount;
  else day.expense += amount;
  if (diamond > 0) {
    day.diamonds += diamond;
    day.diamondLevel = levelFor(day.diamonds, thresholdsFor(dateStr));
  }
  day.count += 1;
  await db.write();
  return entry;
}

// Closing a day purges its individual entries — only the day's aggregate totals are kept,
// per the driver's request to not accumulate per-order detail indefinitely.
export async function endDay(dateStr) {
  const day = getOrCreateDay(dateStr);
  day.status = 'closed';
  day.pendingType = null;
  day.endedAt = nowIso();
  db.data.entries = db.data.entries.filter((e) => e.date !== dateStr);
  await db.write();
  return day;
}

export function getEntries(dateStr) {
  return db.data.entries.filter((e) => e.date === dateStr);
}

export function getDaySummary(dateStr) {
  const day = getDay(dateStr);
  if (!day) return { date: dateStr, income: 0, expense: 0, net: 0, count: 0, diamonds: 0, diamondLevel: 0 };
  return {
    date: dateStr,
    income: day.income,
    expense: day.expense,
    net: day.income - day.expense,
    count: day.count,
    diamonds: day.diamonds,
    diamondLevel: day.diamondLevel,
  };
}

// Inclusive range summary, one row per day (with data) plus totals.
export function getRangeSummary(fromStr, toStr) {
  const days = Object.values(db.data.days)
    .filter((d) => d.date >= fromStr && d.date <= toStr && (d.income || d.expense))
    .map((d) => ({
      date: d.date,
      income: d.income,
      expense: d.expense,
      net: d.income - d.expense,
      diamonds: d.diamonds,
      diamondLevel: d.diamondLevel,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const totals = days.reduce(
    (acc, d) => ({
      income: acc.income + d.income,
      expense: acc.expense + d.expense,
      net: acc.net + d.net,
      diamonds: acc.diamonds + d.diamonds,
    }),
    { income: 0, expense: 0, net: 0, diamonds: 0 }
  );
  return { from: fromStr, to: toStr, days, totals };
}

export default db;
