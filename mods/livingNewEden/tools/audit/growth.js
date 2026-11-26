"use strict";

const { KIND_APPLY, KIND_OUTBOX, STATE_PENDING, STATE_APPLIED, STATE_FAILED } = require("../../lib/persistence/journal");
const { STATE: EVENT_STATE, LIVE_INDEX_WHERE: LIVE } = require("../../lib/scheduler/schema");
const { getEventType } = require("../../lib/scheduler/eventTypes");

const OPEN_EVENT = Object.freeze([EVENT_STATE.QUEUED, EVENT_STATE.RETRY, EVENT_STATE.CLAIMED]);
const LIBKILL_FROM = "libkill:";
const LIBKILL_TO = "libkill;";
const TOP_OPEN_TYPES = 10;
const HOUR_MS = 3.6e6;
const PER_HOUR_DECIMALS = 1000;
const T_STANDING_GRANT = getEventType("STANDING_GRANT").eventType;
const T_STANDINGS_PRUNE = getEventType("STANDINGS_PRUNE").eventType;

function messageOf(err) {
  return String((err && err.message) || err);
}

const quote = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;

function byState(db, tables, table) {
  const out = {};
  if (!tables.has(table)) return out;
  for (const r of db.prepare(`SELECT state AS s, count(*) AS n FROM ${quote(table)} GROUP BY state ORDER BY state`)
    .all()) out[r.s] = r.n;
  return out;
}

function collectGrowth(db, opts = {}) {
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' "
      + "ESCAPE '\\' ORDER BY name").all().map((r) => r.name);
    const tables = new Set(names);
    const growth = { tables: {}, journal: {}, events: {}, battles: {}, wreckFields: {}, fleets: {}, file: {} };
    for (const t of names) growth.tables[t] = db.prepare(`SELECT count(*) AS n FROM ${quote(t)}`).get().n;
    const one = (sql, ...p) => db.prepare(sql).get(...p).n;
    if (tables.has("world_event_journal")) {
      const J = "world_event_journal";
      growth.journal = {
        apply: one(`SELECT count(*) AS n FROM ${J} WHERE kind = ?`, KIND_APPLY),
        outboxPending: one(`SELECT count(*) AS n FROM ${J} WHERE kind = ? AND state = ?`, KIND_OUTBOX, STATE_PENDING),
        outboxApplied: one(`SELECT count(*) AS n FROM ${J} WHERE kind = ? AND state = ?`, KIND_OUTBOX, STATE_APPLIED),
        outboxFailed: one(`SELECT count(*) AS n FROM ${J} WHERE kind = ? AND state = ?`, KIND_OUTBOX, STATE_FAILED),
        libkillApply: one(`SELECT count(*) AS n FROM ${J} WHERE idempotency_key >= ? AND idempotency_key < ? `
          + "AND kind = ?", LIBKILL_FROM, LIBKILL_TO, KIND_APPLY),
        standingGrantRows: one(`SELECT count(*) AS n FROM ${J} WHERE event_type = ?`, T_STANDING_GRANT),
      };
    }
    if (tables.has("world_scheduled_events")) {
      const E = "world_scheduled_events";
      const marks = OPEN_EVENT.map(() => "?").join(", ");
      const openByType = {};
      for (const r of db.prepare(`SELECT event_type AS t, count(*) AS n FROM ${E} WHERE ${LIVE} AND state IN (${marks}) `
        + "GROUP BY event_type ORDER BY n DESC, event_type LIMIT ?").all(...OPEN_EVENT, TOP_OPEN_TYPES)) {
        openByType[r.t] = r.n;
      }
      growth.events = {
        byState: byState(db, tables, E),
        openByType,
        standingGrantRows: one(`SELECT count(*) AS n FROM ${E} WHERE event_type = ?`, T_STANDING_GRANT),
        standingsPruneOpen: one(`SELECT count(*) AS n FROM ${E} WHERE ${LIVE} AND event_type = ? AND state IN (${marks})`,
          T_STANDINGS_PRUNE, ...OPEN_EVENT),
      };
    }
    growth.battles = { byState: byState(db, tables, "battle_records") };
    growth.wreckFields = { byState: byState(db, tables, "world_wreck_fields") };
    growth.fleets = { byState: byState(db, tables, "virtual_fleets") };
    growth.file = {
      pageSize: db.pragma("page_size", { simple: true }),
      pageCount: db.pragma("page_count", { simple: true }),
      freelistCount: db.pragma("freelist_count", { simple: true }),
      bytes: Number.isSafeInteger(opts.bytes) ? opts.bytes : null,
    };
    return { ok: true, growth };
  } catch (err) {
    return { ok: false, reason: "GROWTH_FAILED", detail: messageOf(err) };
  }
}

function flatten(growth) {
  const out = new Map();
  const g = growth || {};
  const put = (prefix, obj) => {
    for (const [k, v] of Object.entries(obj || {})) if (Number.isFinite(v)) out.set(`${prefix}.${k}`, v);
  };
  put("tables", g.tables);
  put("journal", g.journal);
  put("events.byState", g.events && g.events.byState);
  put("wreckFields.byState", g.wreckFields && g.wreckFields.byState);
  return out;
}

function diffGrowth(baseline, current) {
  const notes = [];
  const hours = (current.refNow - baseline.refNow) / HOUR_MS;
  if (!(hours > 0)) notes.push(`delta: hours ${hours} <= 0 - perHour null`);
  const from = flatten(baseline.growth);
  const to = flatten(current.growth);
  const keys = [...new Set([...from.keys(), ...to.keys()])].sort();
  const rows = {};
  for (const k of keys) {
    const a = from.get(k) || 0;
    const b = to.get(k) || 0;
    const delta = b - a;
    rows[k] = { from: a, to: b, delta,
      perHour: hours > 0 ? Math.round((delta / hours) * PER_HOUR_DECIMALS) / PER_HOUR_DECIMALS : null };
  }
  return { baselineRefNow: baseline.refNow, hours, rows, notes };
}

module.exports = { collectGrowth, diffGrowth };
