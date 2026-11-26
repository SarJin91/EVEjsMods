"use strict";

const { createAbortSentinel } = require("../../persistence/store");
const R = require("./rules");
const S = require("./schema");
const KB = require("./sources/killboard");
const ECO = require("./sources/economy");

const COUNTER_NAMES = Object.freeze(["sweep.passes", "sweep.deferredGovernor", "sweep.truncated", "sweep.conflict",
  "sweep.facts.kb_battles", "sweep.facts.kb_kills", "sweep.skippedSec", "sweep.systems", "refresh.rows",
  "refresh.deleted", "captureLoss", "capped.tracked", "capped.kills", "cursor.bootstrap", "cursor.rewound",
  "command.replies", "command.rateLimited", "command.unavailable",
  "sweep.facts.mining", "sweep.facts.production", "sweep.facts.convoys", "sweep.facts.trade", "sweep.skippedNoSystem",
  "invest.requested", "invest.confirmed", "invest.applied", "invest.refused", "invest.retry", "invest.limit",
  "invest.unsafeTransport", "invest.duplicate", "invest.pruned", "capped.trackedInvest",
  "invest.atMax", "invest.capped",
  "effects.garrison", "effects.discount", "effects.failed", "gm.registered", "gm.refused", "gm.reads",
  "client.served", "client.claimed", "client.failed", "client.drift"]);
const WORK_CLASS = "MAINTENANCE";

const ABORT = createAbortSentinel("devIndices.ABORT");
const CONFLICT = createAbortSentinel("devIndices.VERSION_CONFLICT");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, 160);

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createSweep(deps) {
  const { store, repo, kbRepo, memory, settings: P } = deps;
  const economyReaders = deps.economyReaders || ECO.READERS;
  const telemetry = deps.telemetry || null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getter = (name) => (typeof deps[name] === "function" ? () => safe(deps[name], null) : () => null);
  const getGraph = getter("getGraph");
  const getWorldRepository = getter("getWorldRepository");
  const getGovernor = getter("getGovernor");
  const getFactionIds = getter("getFactionIds");
  const onWorldEvents = typeof deps.onWorldEvents === "function" ? deps.onWorldEvents : () => {};
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const cursors = new Map();
  const lags = new Map();
  let inPass = false;
  let stopped = false;
  let lastPass = null;
  let lastRefresh = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `devIndices.${name}`, n);
  }

  function admitted() {
    const governor = getGovernor();
    return !governor || typeof governor.admits !== "function"
      || safe(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function guard() {
    if (stopped) return "STOPPED";
    if (!memory.isWarm()) return "NOT_WARM";
    if (inPass) return "BUSY";
    if (!admitted()) {
      bump("sweep.deferredGovernor");
      return "GOVERNOR_HOLD";
    }
    return null;
  }

  function currentOf(world, db, systemId) {
    const r = world.getSystem(db, systemId);
    if (!r || r.ok !== true) return null;
    const sys = r.system;
    return { controllerFactionId: sys && isId(sys.controllerFactionId) ? sys.controllerFactionId : null,
      occupationState: sys ? sys.occupationState : null };
  }

  function sweepTx(db, now, graph, world, fail, factionIds) {
    const work = new Map();
    const stats = { facts: { kb_battles: 0, kb_kills: 0 }, skippedSec: 0, skippedNoSystem: 0, truncated: 0,
      cappedTracked: 0, cappedKills: 0, captureLoss: 0, bootstrap: 0, rewound: 0 };
    let newRows = 0;

    function admit(systemId) {
      if (!isId(systemId)) return "skip";
      const sys = safe(() => graph.getSystem(systemId), null);
      if (!sys || !P.secClasses.includes(sys.secClass)) return "skip";
      const known = work.get(systemId);
      if (known) return known;
      if (work.size >= P.maxSystemsPerPass) return "truncate";
      const got = repo.getInTx(db, systemId);
      if (!got.ok) fail(`row ${got.reason}`);
      const current = currentOf(world, db, systemId);
      if (!current) fail(`world getSystem ${systemId}`);
      const entry = { systemId, stored: got.row, row: null, current, capped: false };
      if (got.row) {
        const decayed = R.decayRow(got.row, now, P);
        const captured = R.captureLoss(decayed, current, P);
        if (captured.lost) {
          stats.captureLoss += 1;
          entry.lostFrom = decayed;
        }
        entry.row = captured.row;
      } else if (memory.size() + newRows >= P.maxTrackedSystems) {
        entry.capped = true;
        stats.cappedTracked += 1;
      } else {
        newRows += 1;
      }
      work.set(systemId, entry);
      return entry;
    }

    function setRow(entry, next) {
      if (!next || next === entry.row) return;
      entry.row = entry.row ? next : R.captureLoss(next, entry.current, P).row;
    }

    function foldOne(source, fact) {
      if (S.ECONOMY_SOURCES.includes(source)) {
        if (!isId(fact.systemId)) return "noSystem";
        const entry = admit(fact.systemId);
        if (typeof entry === "string") return entry;
        if (entry.capped) return "consumed";
        setRow(entry, R.applyDelta(entry.row, entry.systemId, R.foldEconomy(fact, P), now, P));
        return "consumed";
      }
      if (source === S.KB_SOURCES.BATTLES) {
        const entry = admit(fact.systemId);
        if (typeof entry === "string") return entry;
        if (entry.capped) return "consumed";
        setRow(entry, R.applyDelta(entry.row, entry.systemId,
          R.foldBattle(fact, entry.current.controllerFactionId, P), now, P));
        return "consumed";
      }
      const entry = admit(fact.systemId);
      if (typeof entry === "string") return entry;
      if (entry.capped) return "consumed";
      const row = entry.row;
      const k = R.foldKill({ killAt: fact.at }, row ? { at: row.killWindowAt, points: row.killWindowPoints }
        : { at: 0, points: 0 }, P);
      if (k.capped) stats.cappedKills += 1;
      const next = k.delta > 0 ? R.applyDelta(row, entry.systemId, { mil: k.delta }, now, P) : row;
      if (next) {
        setRow(entry, next);
        if (entry.row.killWindowAt !== k.window.at || entry.row.killWindowPoints !== k.window.points) {
          entry.row = Object.freeze({ ...entry.row, killWindowAt: k.window.at, killWindowPoints: k.window.points });
        }
      }
      return "consumed";
    }

    const sources = [S.KB_SOURCES.BATTLES];
    if (P.killmailsEnabled && P.ratKillMilPoints > 0) sources.push(S.KB_SOURCES.KILLS);
    const outCursors = [];
    const outLags = [];
    for (const source of sources) {
      const stored = repo.readCursorInTx(db, source);
      if (!stored.ok) fail(`cursor ${stored.reason}`);
      const prepared = KB.bootstrapCursor(db, kbRepo, source, stored.cursor, now, P);
      if (!prepared.ok) fail(`${prepared.reason} ${prepared.detail}`);
      if (prepared.event === KB.BOOTSTRAP) stats.bootstrap += 1;
      if (prepared.event === KB.REWOUND) stats.rewound += 1;
      const cursor = prepared.cursor;
      const page = source === S.KB_SOURCES.BATTLES ? KB.readBattleFacts(db, kbRepo, cursor, P)
        : KB.readKillFacts(db, kbRepo, cursor, P);
      if (!page.ok) fail(`${page.reason} ${page.detail}`);
      let endNo = cursor.afterNo;
      let endAt = cursor.afterAt;
      let consumed = 0;
      let truncated = false;
      for (const fact of page.facts) {
        const r = foldOne(source, fact);
        if (r === "truncate") {
          truncated = true;
          break;
        }
        if (r === "skip") stats.skippedSec += 1;
        endNo = fact.no;
        endAt = fact.at;
        consumed += 1;
      }
      if (truncated) stats.truncated += 1;
      else {
        endNo = page.endNo;
        endAt = page.endAt;
      }
      stats.facts[source] += consumed;
      const lag = Math.max(0, (Number(prepared.maxNo) || 0) - endNo);
      outLags.push([source, lag]);
      if (prepared.event !== null || endNo !== cursor.afterNo) {
        const next = { source, afterAt: endAt, afterNo: endNo, afterKey: "", facts: cursor.facts + consumed };
        const w = repo.writeCursorInTx(db, next, now);
        if (!w.ok) fail(`cursor write ${w.reason}`);
        outCursors.push(Object.freeze({ source, afterNo: endNo, afterAt: endAt, facts: next.facts, lag }));
      }
    }
    for (const source of factionIds ? S.ECONOMY_SOURCES : []) {
      const stored = repo.readCursorInTx(db, source);
      if (!stored.ok) fail(`cursor ${stored.reason}`);
      const prepared = ECO.economyCursor(source, stored.cursor, now, P);
      if (prepared.event === ECO.BOOTSTRAP) stats.bootstrap += 1;
      const cursor = prepared.cursor;
      const page = ECO.readEconomyFacts(db, economyReaders, source, cursor, factionIds, now, P);
      if (!page.ok) fail(`${page.reason} ${page.detail}`);
      let endAt = cursor.afterAt;
      let endKey = cursor.afterKey || "";
      let consumed = 0;
      let truncated = false;
      for (const fact of page.facts) {
        const r = foldOne(source, fact);
        if (r === "truncate") {
          truncated = true;
          break;
        }
        if (r === "skip") stats.skippedSec += 1;
        if (r === "noSystem") stats.skippedNoSystem += 1;
        endAt = fact.at;
        endKey = fact.key;
        consumed += 1;
      }
      if (truncated) stats.truncated += 1;
      else {
        endAt = page.endAt;
        endKey = page.endKey;
      }
      stats.facts[source] = consumed;
      if (prepared.event !== null || endAt !== cursor.afterAt || endKey !== (cursor.afterKey || "")) {
        const next = { source, afterAt: endAt, afterNo: 0, afterKey: endKey, facts: cursor.facts + consumed };
        const w = repo.writeCursorInTx(db, next, now);
        if (!w.ok) fail(`cursor write ${w.reason}`);
        outCursors.push(Object.freeze({ source, afterNo: 0, afterAt: endAt, facts: next.facts }));
      }
    }
    const written = [];
    for (const entry of work.values()) {
      if (!entry.row || entry.row === entry.stored) continue;
      const u = repo.upsertInTx(db, entry.row, now);
      if (!u.ok && u.reason === "VERSION_CONFLICT") throw CONFLICT;
      if (!u.ok) fail(`row write ${u.reason}${u.detail ? `:${u.detail}` : ""}`);
      written.push(u.row);
    }
    return { written, cursors: outCursors, lags: outLags, stats, events: P.gmHintEnabled ? worldEventsOf(work.values()) : [] };
  }

  function worldEventsOf(entries) {
    const out = [];
    for (const entry of entries) {
      if (!entry.row) continue;
      if (entry.lostFrom) {
        const fell = S.KINDS.find((k) => R.levelOf(entry.row[k], P) < R.levelOf(entry.lostFrom[k], P));
        if (fell) out.push({ kind: "collapse", systemId: entry.systemId, index: fell, level: R.levelOf(entry.row[fell], P) });
      }
      const before = entry.stored;
      const boom = S.KINDS.find((k) => R.levelOf(entry.row[k], P) >= S.MAX_LEVEL
        && (!before || R.levelOf(before[k], P) < S.MAX_LEVEL));
      if (boom) out.push({ kind: "boom", systemId: entry.systemId, index: boom, level: S.MAX_LEVEL });
    }
    return out;
  }

  function runPass(now) {
    const why = guard();
    if (why) return { ok: false, reason: why };
    const graph = getGraph();
    if (!graph || typeof graph.getSystem !== "function") return { ok: false, reason: "GRAPH_UNAVAILABLE" };
    const world = getWorldRepository();
    if (!world || typeof world.getSystem !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
    inPass = true;
    const t0 = nowMs();
    let detail = null;
    const fail = (text) => {
      detail = text;
      throw ABORT;
    };
    try {
      const ids = getFactionIds();
      const factionIds = Array.isArray(ids) ? ids : null;
      const tx = store.transaction("devIndices.sweep", (db) => sweepTx(db, now, graph, world, fail, factionIds));
      if (!tx || !tx.ok) {
        if (tx && tx.error === CONFLICT) bump("sweep.conflict");
        const reason = tx && tx.error === CONFLICT ? "VERSION_CONFLICT" : String((tx && tx.reason) || "TX_FAILED");
        lastPass = Object.freeze({ at: now, ok: false, reason, detail: detail || (tx && tx.error
          && typeof tx.error !== "symbol" ? messageOf(tx.error) : null) });
        log(`sweep refused ${reason}${lastPass.detail ? ` - ${lastPass.detail}` : ""}`);
        return { ok: false, reason, ...(lastPass.detail ? { detail: lastPass.detail } : {}) };
      }
      const v = tx.value;
      for (const row of v.written) memory.put(row);
      for (const c of v.cursors) cursors.set(c.source, c);
      for (const [source, lag] of v.lags) {
        lags.set(source, lag);
        const c = cursors.get(source);
        if (c && c.lag !== lag) cursors.set(source, Object.freeze({ ...c, lag }));
      }
      if (v.events.length > 0) safe(() => onWorldEvents(v.events, now), null);
      bump("sweep.passes");
      for (const [source, n] of Object.entries(v.stats.facts)) bump(`sweep.facts.${source}`, n);
      bump("sweep.skippedSec", v.stats.skippedSec);
      bump("sweep.skippedNoSystem", v.stats.skippedNoSystem);
      bump("sweep.truncated", v.stats.truncated);
      bump("sweep.systems", v.written.length);
      bump("captureLoss", v.stats.captureLoss);
      bump("capped.tracked", v.stats.cappedTracked);
      bump("capped.kills", v.stats.cappedKills);
      bump("cursor.bootstrap", v.stats.bootstrap);
      bump("cursor.rewound", v.stats.rewound);
      const ms = Math.max(0, nowMs() - t0);
      metric("observe", "devIndices.sweep.ms", ms);
      lastPass = Object.freeze({ at: now, ok: true, systems: v.written.length, facts: Object.freeze({ ...v.stats.facts }),
        truncated: v.stats.truncated > 0, ms: Math.round(ms * 100) / 100 });
      return { ok: true, systems: v.written.length, facts: v.stats.facts };
    } finally {
      inPass = false;
    }
  }

  function runRefresh(now) {
    const why = guard();
    if (why) return { ok: false, reason: why };
    const world = getWorldRepository();
    if (!world || typeof world.getSystem !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
    inPass = true;
    const t0 = nowMs();
    let detail = null;
    const fail = (text) => {
      detail = text;
      throw ABORT;
    };
    try {
      const tx = store.transaction("devIndices.refresh", (db) => {
        const page = repo.listOldestInTx(db, Math.max(0, now - P.refreshMinAgeMs), P.refreshRowsPerPass);
        if (!page.ok) fail(`page ${page.reason}`);
        const put = [];
        const removed = [];
        const lostEntries = [];
        let lost = 0;
        for (const stored of page.rows) {
          const current = currentOf(world, db, stored.systemId);
          if (!current) fail(`world getSystem ${stored.systemId}`);
          const decayed = R.decayRow(stored, now, P);
          const captured = R.captureLoss(decayed, current, P);
          if (captured.lost) {
            lost += 1;
            if (P.gmHintEnabled) lostEntries.push({ systemId: stored.systemId, stored, lostFrom: decayed, row: captured.row });
          }
          const row = captured.row;
          const empty = S.KINDS.every((k) => row[k] === 0)
            && (row.lastInputAt === null || now - row.lastInputAt >= P.trendWindowMs);
          if (empty) {
            const d = repo.deleteInTx(db, stored.systemId, stored.version);
            if (!d.ok && d.reason === "VERSION_CONFLICT") throw CONFLICT;
            if (!d.ok) fail(`delete ${d.reason}`);
            removed.push(stored.systemId);
          } else if (row !== stored) {
            const u = repo.upsertInTx(db, row, now);
            if (!u.ok && u.reason === "VERSION_CONFLICT") throw CONFLICT;
            if (!u.ok) fail(`row write ${u.reason}`);
            put.push(u.row);
          }
        }
        return { put, removed, lost, events: lostEntries.length > 0 ? worldEventsOf(lostEntries) : [] };
      });
      if (!tx || !tx.ok) {
        if (tx && tx.error === CONFLICT) bump("sweep.conflict");
        const reason = tx && tx.error === CONFLICT ? "VERSION_CONFLICT" : String((tx && tx.reason) || "TX_FAILED");
        lastRefresh = Object.freeze({ at: now, ok: false, reason, detail });
        log(`refresh refused ${reason}${detail ? ` - ${detail}` : ""}`);
        return { ok: false, reason, ...(detail ? { detail } : {}) };
      }
      const v = tx.value;
      for (const row of v.put) memory.put(row);
      for (const id of v.removed) memory.remove(id);
      if (v.events.length > 0) safe(() => onWorldEvents(v.events, now), null);
      bump("refresh.rows", v.put.length + v.removed.length);
      bump("refresh.deleted", v.removed.length);
      bump("captureLoss", v.lost);
      const ms = Math.max(0, nowMs() - t0);
      metric("observe", "devIndices.refresh.ms", ms);
      lastRefresh = Object.freeze({ at: now, ok: true, rows: v.put.length + v.removed.length,
        deleted: v.removed.length, ms: Math.round(ms * 100) / 100 });
      return { ok: true, rows: v.put.length + v.removed.length, deleted: v.removed.length };
    } finally {
      inPass = false;
    }
  }

  function gauges(now) {
    let level5 = 0;
    for (const row of memory.decayedRows(now)) {
      if (S.KINDS.some((k) => R.levelOf(row[k], P) >= S.MAX_LEVEL)) level5 += 1;
    }
    metric("gauge", "devIndices.tracked", memory.size());
    metric("gauge", "devIndices.level5", level5);
    for (const source of ["kb_battles", "kb_kills"]) {
      if (lags.has(source)) metric("gauge", `devIndices.lag.${source}`, lags.get(source));
    }
    return { tracked: memory.size(), level5 };
  }

  function setCursors(list) {
    for (const c of Array.isArray(list) ? list : []) {
      const lag = lags.has(c.source) ? { lag: lags.get(c.source) } : {};
      cursors.set(c.source, Object.freeze({ source: c.source, afterNo: c.afterNo, afterAt: c.afterAt, facts: c.facts,
        ...lag }));
    }
  }

  function getStatus() {
    return Object.freeze({ counters: Object.freeze({ ...counters }),
      cursors: Object.freeze([...cursors.values()].sort((a, b) => (a.source < b.source ? -1 : 1))),
      lastPass, lastRefresh });
  }

  return Object.freeze({ runPass, runRefresh, gauges, setCursors, getStatus, bump, stop() { stopped = true; } });
}

module.exports = { createSweep, COUNTER_NAMES };
