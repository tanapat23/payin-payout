import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from './dateUtils.js';
import { levelFor, thresholdsFor } from './diamonds.js';

const DATA_DIR = path.resolve('data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const defaultVehicle = { currentOdometer: null, lastOilChangeOdometer: null, lastOilChangeDate: null };
const defaultData = { days: {}, entries: [], vehicle: { ...defaultVehicle } };

await mkdir(DATA_DIR, { recursive: true });
const db = new Low(new JSONFile(DATA_FILE), defaultData);
await db.read();
db.data ||= defaultData;
db.data.days ||= {};
db.data.entries ||= [];
db.data.vehicle ||= { ...defaultVehicle };

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
  if (!day.expenseByCategory) {
    day.expenseByCategory = {};
    migrated = true;
  }
  if (day.pendingCategory === undefined) {
    day.pendingCategory = null;
    migrated = true;
  }
  if (day.distanceKm === undefined) {
    day.startOdometer = day.startOdometer ?? null;
    day.endOdometer = day.endOdometer ?? null;
    day.distanceKm = 0;
    migrated = true;
  }
  if (day.completedHours === undefined) {
    day.completedHours = 0;
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
      pendingCategory: null, // expense category chosen before the amount is typed
      startedAt: null,
      endedAt: null,
      startOdometer: null,
      endOdometer: null,
      distanceKm: 0, // cumulative across every start/end session today
      completedHours: 0, // cumulative across every finished session today
      income: 0,
      expense: 0,
      diamonds: 0,
      diamondLevel: 0,
      count: 0,
      expenseByCategory: {},
    };
  }
  return db.data.days[dateStr];
}

export function getDay(dateStr) {
  return db.data.days[dateStr] || null;
}

export function getVehicle() {
  return db.data.vehicle;
}

// Logs an oil change at the given odometer reading — resets the interval used for
// the 4,000 km oil-change warning, and doubles as a fresh "current odometer" reading.
export async function recordOilChange(dateStr, odometer) {
  db.data.vehicle.lastOilChangeOdometer = odometer;
  db.data.vehicle.lastOilChangeDate = dateStr;
  if (db.data.vehicle.currentOdometer == null || odometer > db.data.vehicle.currentOdometer) {
    db.data.vehicle.currentOdometer = odometer;
  }
  await db.write();
  return db.data.vehicle;
}

// odometer: starting mileage (km) for this session — a day can have several start/end
// sessions (e.g. a lunch break); completedHours/distanceKm accumulate across all of them.
export async function startDay(dateStr, odometer = null) {
  const day = getOrCreateDay(dateStr);
  day.status = 'open';
  day.startedAt = nowIso();
  day.endedAt = null;
  day.pendingType = null;
  if (odometer != null) {
    day.startOdometer = odometer;
    db.data.vehicle.currentOdometer = odometer;
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

export async function setPendingCategory(dateStr, category) {
  const day = getOrCreateDay(dateStr);
  day.pendingCategory = category;
  await db.write();
  return day;
}

export async function clearPendingType(dateStr) {
  const day = getOrCreateDay(dateStr);
  day.pendingType = null;
  day.pendingCategory = null;
  await db.write();
  return day;
}

// diamond: optional diamond count gained with this entry (income only, per Grab's daily quest).
// category: optional expense category key (e.g. 'fuel', 'food', 'repair', 'other').
export async function addEntry(dateStr, type, amount, diamond = 0, category = null) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: dateStr,
    type,
    amount,
    diamond,
    category: type === 'expense' ? category : null,
    createdAt: nowIso(),
  };
  db.data.entries.push(entry);
  const day = getOrCreateDay(dateStr);
  day.pendingType = null;
  day.pendingCategory = null;
  if (type === 'income') {
    day.income += amount;
  } else {
    day.expense += amount;
    if (category) {
      day.expenseByCategory[category] = (day.expenseByCategory[category] || 0) + amount;
    }
  }
  if (diamond > 0) {
    day.diamonds += diamond;
    day.diamondLevel = levelFor(day.diamonds, thresholdsFor(dateStr));
  }
  day.count += 1;
  await db.write();
  return entry;
}

// Removes the most recent entry for a (still-open) day and reverses its effect on the
// day's running totals — lets the driver fix a typo without waiting for end-of-day.
export async function undoLastEntry(dateStr) {
  let lastIndex = -1;
  for (let i = db.data.entries.length - 1; i >= 0; i--) {
    if (db.data.entries[i].date === dateStr) {
      lastIndex = i;
      break;
    }
  }
  if (lastIndex === -1) return null;

  const [entry] = db.data.entries.splice(lastIndex, 1);
  const day = getOrCreateDay(dateStr);
  if (entry.type === 'income') {
    day.income -= entry.amount;
  } else {
    day.expense -= entry.amount;
    if (entry.category && day.expenseByCategory[entry.category]) {
      day.expenseByCategory[entry.category] -= entry.amount;
      if (day.expenseByCategory[entry.category] <= 0) delete day.expenseByCategory[entry.category];
    }
  }
  if (entry.diamond > 0) {
    day.diamonds = Math.max(0, day.diamonds - entry.diamond);
    day.diamondLevel = levelFor(day.diamonds, thresholdsFor(dateStr));
  }
  day.count = Math.max(0, day.count - 1);
  await db.write();
  return entry;
}

// Closing a day purges its individual entries — only the day's aggregate totals are kept,
// per the driver's request to not accumulate per-order detail indefinitely.
// odometer: ending mileage (km) for this session — its duration/distance folds into the
// day's running completedHours/distanceKm so multiple sessions in one day add up correctly.
export async function endDay(dateStr, odometer = null) {
  const day = getOrCreateDay(dateStr);
  if (day.startedAt) {
    const sessionHours = (new Date() - new Date(day.startedAt)) / 3600000;
    if (sessionHours > 0) day.completedHours = (day.completedHours || 0) + sessionHours;
  }
  day.status = 'closed';
  day.pendingType = null;
  day.pendingCategory = null;
  day.endedAt = nowIso();
  if (odometer != null) {
    if (day.startOdometer != null) {
      const sessionDistance = odometer - day.startOdometer;
      if (sessionDistance > 0) day.distanceKm = (day.distanceKm || 0) + sessionDistance;
    }
    day.endOdometer = odometer;
    db.data.vehicle.currentOdometer = odometer;
  }
  db.data.entries = db.data.entries.filter((e) => e.date !== dateStr);
  await db.write();
  return day;
}

export function getEntries(dateStr) {
  return db.data.entries.filter((e) => e.date === dateStr);
}

// Completed sessions' hours (persisted at each endDay call) plus, if a session is
// currently in progress, its live elapsed time — so this is always the true day total.
function hoursWorked(day) {
  const completed = day.completedHours || 0;
  if (day.status === 'open' && day.startedAt) {
    const live = (new Date() - new Date(day.startedAt)) / 3600000;
    return completed + Math.max(0, live);
  }
  return completed;
}

export function getDaySummary(dateStr) {
  const day = getDay(dateStr);
  if (!day) {
    return {
      date: dateStr,
      income: 0,
      expense: 0,
      net: 0,
      count: 0,
      diamonds: 0,
      diamondLevel: 0,
      expenseByCategory: {},
      hoursWorked: 0,
      incomePerHour: 0,
      distanceKm: 0,
      incomePerKm: 0,
      fuelPerKm: 0,
    };
  }
  const hours = hoursWorked(day);
  const distanceKm = day.distanceKm || 0;
  const fuelExpense = day.expenseByCategory?.fuel || 0;
  return {
    date: dateStr,
    income: day.income,
    expense: day.expense,
    net: day.income - day.expense,
    count: day.count,
    diamonds: day.diamonds,
    diamondLevel: day.diamondLevel,
    expenseByCategory: day.expenseByCategory,
    hoursWorked: hours,
    incomePerHour: hours > 0 ? day.income / hours : 0,
    distanceKm,
    incomePerKm: distanceKm > 0 ? day.income / distanceKm : 0,
    fuelPerKm: distanceKm > 0 ? fuelExpense / distanceKm : 0,
  };
}

// Inclusive range summary, one row per day (with data) plus totals.
export function getRangeSummary(fromStr, toStr) {
  const days = Object.values(db.data.days)
    .filter((d) => d.date >= fromStr && d.date <= toStr && (d.income || d.expense || d.distanceKm))
    .map((d) => ({
      date: d.date,
      income: d.income,
      expense: d.expense,
      net: d.income - d.expense,
      diamonds: d.diamonds,
      diamondLevel: d.diamondLevel,
      distanceKm: d.distanceKm || 0,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const totals = days.reduce(
    (acc, d) => ({
      income: acc.income + d.income,
      expense: acc.expense + d.expense,
      net: acc.net + d.net,
      diamonds: acc.diamonds + d.diamonds,
      distanceKm: acc.distanceKm + d.distanceKm,
    }),
    { income: 0, expense: 0, net: 0, diamonds: 0, distanceKm: 0 }
  );
  return { from: fromStr, to: toStr, days, totals };
}

export default db;
