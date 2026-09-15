import express from 'express';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import * as db from './db.js';
import { todayStr, isValidDateStr, weekRange, monthRange, addDays } from './dateUtils.js';

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Hash-pad to equal length first so the length check itself isn't a timing side-channel.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function basicAuth(username, password) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
      if (user && pass && safeEqual(user, username) && safeEqual(pass, password)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="PayIn PayOut"');
    res.status(401).send('Authentication required');
  };
}

function fillRange(fromStr, toStr) {
  const summary = db.getRangeSummary(fromStr, toStr);
  const byDate = new Map(summary.days.map((d) => [d.date, d]));
  const days = [];
  let cursor = fromStr;
  while (cursor <= toStr) {
    days.push(byDate.get(cursor) || { date: cursor, income: 0, expense: 0, net: 0, diamonds: 0, diamondLevel: 0 });
    cursor = addDays(cursor, 1);
  }
  return { from: fromStr, to: toStr, days, totals: summary.totals };
}

export function createServer({ username, password } = {}) {
  const app = express();

  if (username && password) {
    app.use(basicAuth(username, password));
  }

  app.use(express.static(path.resolve('public')));

  app.get('/api/today', (req, res) => {
    res.json(db.getDaySummary(todayStr()));
  });

  app.get('/api/week', (req, res) => {
    const anchor = isValidDateStr(req.query.date) ? req.query.date : todayStr();
    const [from, to] = weekRange(anchor);
    res.json(fillRange(from, to));
  });

  app.get('/api/month', (req, res) => {
    const anchor = isValidDateStr(req.query.date) ? req.query.date : todayStr();
    const [from, to] = monthRange(anchor);
    res.json(fillRange(from, to));
  });

  app.get('/api/entries', (req, res) => {
    if (!isValidDateStr(req.query.date)) {
      res.status(400).json({ error: 'invalid date' });
      return;
    }
    res.json(db.getEntries(req.query.date));
  });

  return app;
}
