"use strict";

const { CHECKPOINT_TIMING } = require("../../lib/persistence/store");

const DEFAULT_SLOW_MS = 100;
const TOP_NAMES = 20;

function round2(x) {
  return Math.round(x * 100) / 100;
}

function emptyDay() {
  return { tx: { n: 0, ro: 0, rw: 0, failed: 0, ms: 0, maxMs: 0, slow: 0 },
    checkpoint: { n: 0, ms: 0, maxMs: 0, frames: 0 } };
}

function finite(ms) {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function createTxTap(opts) {
  const o = opts || {};
  const slowMs = typeof o.slowMs === "number" && o.slowMs >= 0 ? o.slowMs : DEFAULT_SLOW_MS;
  const saved = o.state || {};
  let day = saved.day && typeof saved.day === "object" ? JSON.parse(JSON.stringify(saved.day)) : emptyDay();
  const byName = new Map(Array.isArray(saved.byName) ? saved.byName.map(([k, v]) => [k, { ...v }]) : []);

  function onTiming(name, ms, outcome, rows) {
    if (outcome === undefined) return;
    const t = finite(ms);
    if (name === CHECKPOINT_TIMING) {
      const c = day.checkpoint;
      c.n += 1;
      c.ms += t;
      if (t > c.maxMs) c.maxMs = t;
      if (typeof rows === "number" && Number.isFinite(rows)) c.frames += rows;
      return;
    }
    const d = day.tx;
    const ro = outcome === "ok" && rows === 0;
    d.n += 1;
    if (outcome !== "ok") d.failed += 1;
    else if (ro) d.ro += 1;
    else d.rw += 1;
    d.ms += t;
    if (t > d.maxMs) d.maxMs = t;
    if (t >= slowMs) d.slow += 1;
    const key = String(name);
    const row = byName.get(key) || { n: 0, ro: 0, ms: 0, maxMs: 0 };
    row.n += 1;
    if (ro) row.ro += 1;
    row.ms += t;
    if (t > row.maxMs) row.maxMs = t;
    byName.set(key, row);
  }

  function takeDay() {
    const out = { tx: { ...day.tx, ms: round2(day.tx.ms), maxMs: round2(day.tx.maxMs) },
      checkpoint: { ...day.checkpoint, ms: round2(day.checkpoint.ms), maxMs: round2(day.checkpoint.maxMs) } };
    day = emptyDay();
    return out;
  }

  function totals() {
    return [...byName].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, TOP_NAMES)
      .map(([name, r]) => ({ name, n: r.n, ro: r.ro, ms: round2(r.ms), maxMs: round2(r.maxMs) }));
  }

  function state() {
    return { day: JSON.parse(JSON.stringify(day)), byName: [...byName].map(([k, v]) => [k, { ...v }]) };
  }

  return Object.freeze({ onTiming, takeDay, totals, state });
}

module.exports = { createTxTap, DEFAULT_SLOW_MS, TOP_NAMES };
