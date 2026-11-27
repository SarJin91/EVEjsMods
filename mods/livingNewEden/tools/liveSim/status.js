"use strict";

const fs = require("node:fs");

const { OPEN_BATTLE_STATES } = require("../../lib/battle/schema");

const UNSUPPORTED_TOP = 5;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MB = 1024 * 1024;
const OPEN_BATTLES_SQL = `SELECT count(*) AS n FROM battle_records WHERE state IN (${OPEN_BATTLE_STATES.map(() => "?")
  .join(", ")})`;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : null;
  } catch (_err) {
    return null;
  }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fileBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch (_err) {
    return null;
  }
}

function dbCounts(ctx) {
  const store = ctx.persistence && ctx.persistence.store;
  if (!store || typeof store.transaction !== "function") return { ok: false, reason: "no_store" };
  try {
    const r = store.transaction("livesim.status", (db) => ({
      journalRows: db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n,
      openSchedulerEvents: db.prepare(`SELECT count(*) AS n FROM world_scheduled_events
        WHERE state <> 'DONE' AND state IN ('QUEUED', 'RETRY', 'CLAIMED')`).get().n,
      liveFleets: db.prepare("SELECT count(*) AS n FROM virtual_fleets WHERE state <> 'DESTROYED'").get().n,
      battlesOpen: db.prepare(OPEN_BATTLES_SQL).get(...OPEN_BATTLE_STATES).n,
      battlesSettled: db.prepare("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'BATTLE_SETTLED'")
        .get().n,
    }));
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "no_result" };
    const out = { ok: true };
    for (const [k, v] of Object.entries(r.value)) out[k] = Number(v);
    return out;
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

function collectStatus(h) {
  const ctx = h.ctx || {};
  const virtualAt = h.clock.now();
  const sched = call(ctx.scheduler, "getStatus") || {};
  const snap = call(ctx.telemetry, "getSnapshot");
  const ch = (snap && snap.channels && snap.channels.scheduler) || {};
  const hist = (name, field) => (ch[name] && typeof ch[name] === "object" ? num(ch[name][field]) : null);
  const governor = (snap && snap.governor) || call(ctx.governor, "getStatus");
  const counts = dbCounts(ctx);
  const mem = process.memoryUsage();
  const unsupported = Object.entries((h.getUnsupported && h.getUnsupported()) || {})
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, UNSUPPORTED_TOP);
  return {
    wallAt: (h.wallNow || Date.now)(),
    virtualAt,
    virtualIso: new Date(virtualAt).toISOString(),
    virtualElapsedMs: virtualAt - h.firstVirtualAt,
    speed: h.speed,
    scheduler: {
      state: sched.state || null, open: num(sched.open), inFlight: num(sched.inFlight), nextDueAt: num(sched.nextDueAt),
      due: num(ch.dueBacklog), latenessP95Ms: hist("lateness", "p95"), catchUp: num(ch.catchUpActive),
      passP95Ms: hist("passMs", "p95"), handlerErrors: num(ch.handlerErrors),
    },
    governor: governor ? governor.mode || null : null,
    db: counts,
    dbBytes: h.dbFile ? fileBytes(h.dbFile) : null,
    walBytes: h.dbFile ? fileBytes(`${h.dbFile}-wal`) : null,
    heapUsed: mem.heapUsed,
    rss: mem.rss,
    unsupported: Object.fromEntries(unsupported),
  };
}

function dash(v, fmt) {
  return v === null || v === undefined ? "-" : fmt(v);
}

function elapsed(ms) {
  const m = Math.max(0, Math.floor(ms / MS_PER_MINUTE));
  const d = Math.floor(m / (MS_PER_DAY / MS_PER_MINUTE));
  const h = Math.floor((m % (MS_PER_DAY / MS_PER_MINUTE)) / 60);
  return `+${d > 0 ? `${d}d` : ""}${h}h${String(m % 60).padStart(2, "0")}m`;
}

function kilo(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

const mb = (n) => `${Math.round(n / MB)}MB`;

function formatStatus(s) {
  const sc = s.scheduler || {};
  const db = s.db && s.db.ok ? s.db : null;
  const unsupported = Object.entries(s.unsupported || {}).map(([k, v]) => `${k}:${v}`).join(",");
  return `liveSim: v=${s.virtualIso.slice(0, 16)}Z ${elapsed(s.virtualElapsedMs)} x${s.speed} `
    + `sched open=${dash(sc.open, String)} due=${dash(sc.due, String)} `
    + `lag=${dash(sc.latenessP95Ms, (v) => `${(v / 1000).toFixed(1)}s`)} catchUp=${dash(sc.catchUp, String)} `
    + `pass.p95=${dash(sc.passP95Ms, (v) => `${v.toFixed(1)}ms`)} errs=${dash(sc.handlerErrors, String)} `
    + `gov=${s.governor || "-"} fleets=${db ? db.liveFleets : "-"} `
    + `battles=${db ? `${db.battlesOpen}/${db.battlesSettled}` : "-"} journal=${db ? kilo(db.journalRows) : "-"} `
    + `db=${dash(s.dbBytes, mb)} wal=${dash(s.walBytes, mb)} heap=${mb(s.heapUsed)} `
    + `unsupported=${unsupported || "-"}${db ? "" : ` dbRead=${(s.db && s.db.reason) || "-"}`}`;
}

module.exports = { collectStatus, formatStatus };
