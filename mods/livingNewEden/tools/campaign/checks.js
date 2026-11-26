"use strict";

const { checkBattleInvariants } = require("../../lib/battle/checks");
const { checkInvariants } = require("../../lib/world/occupation/machine");
const { CLAIM_STATES, EVENT_TYPE: OCCUPATION_EVENT_TYPE } = require("../../lib/world/occupation/schema");
const { getCoreIndex, coreSystemIds, coreStationIds, auditCores } = require("../../lib/world/core");
const { EVENT_TYPES } = require("../../lib/scheduler/eventTypes");

const DISABLED_MODULE_TABLES = Object.freeze(["world_trade_budgets", "world_trade_offers", "world_virtual_identities",
  "world_sov_projection_log", "world_event_sites", "world_events", "world_sov_reconcile"]);

const PERIODIC_EVENT_TYPES = Object.freeze(
  Object.entries(EVENT_TYPES)
    .filter(([, v]) => v.periodic === true)
    .map(([, v]) => [v.eventType, v.aggregateType])
);

const OCCUPATION_TICK_KEY = /^occ:(\d+):(\d+):t:(\d+):(\d+)$/;

const DETAIL_MAX = 20;
const HISTORY_MAX_IDS = 500;
const HISTORY_MAX_ROWS = 100000;

function messageOf(err) {
  return String((err && err.message) || err);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function snapshotForChecks(db) {
  const phaseSeq = new Map();
  const controller = new Map();
  for (const r of db.prepare("SELECT system_id, phase_seq, controller_faction_id FROM world_system_state").all()) {
    if (r.phase_seq !== null) phaseSeq.set(r.system_id, r.phase_seq);
    controller.set(r.system_id, r.controller_faction_id);
  }
  return { phaseSeq, controller };
}

function occupationViolations(db) {
  let n = 0;
  for (const r of db.prepare(`SELECT occupation_state, controller_faction_id, occupier_faction_id, captured_at,
    detached_since_at FROM world_system_state`).all()) {
    const broken = checkInvariants({ state: r.occupation_state, controller: r.controller_faction_id,
      occupier: r.occupier_faction_id, capturedAt: r.captured_at, detachedSinceAt: r.detached_since_at });
    if (broken !== null) n += 1;
  }
  return n;
}

function phaseSeqRegressions(db, prev) {
  if (!prev) return 0;
  let n = 0;
  for (const r of db.prepare("SELECT system_id, phase_seq FROM world_system_state WHERE phase_seq IS NOT NULL").all()) {
    const before = prev.phaseSeq.get(r.system_id);
    if (before !== undefined && r.phase_seq < before) n += 1;
  }
  return n;
}

function upkeepOverlaps(db) {
  let n = 0;
  const last = new Map();
  const rows = db.prepare(`SELECT aggregate_id, payload FROM world_event_journal WHERE event_type = 'FACTION_CHANGED'
    AND state = 'APPLIED' ORDER BY journal_id`).all();
  for (const r of rows) {
    let p;
    try {
      p = JSON.parse(r.payload);
    } catch (_err) {
      continue;
    }
    if (!p || p.reason !== "UPKEEP" || !p.patch || !Number.isFinite(p.patch.upkeepPaidUntil)) continue;
    const before = last.get(r.aggregate_id);
    if (before !== undefined && p.patch.upkeepPaidUntil <= before) n += 1;
    last.set(r.aggregate_id, Math.max(before === undefined ? -Infinity : before, p.patch.upkeepPaidUntil));
  }
  return n;
}

function periodicChainCounts(db, now, details, convergingDetails) {
  const out = { doubled: 0, converging: 0 };
  if (!tableExists(db, "world_scheduled_events")) return out;
  const hasNow = Number.isSafeInteger(now);
  const stmt = db.prepare(`SELECT aggregate_id, count(*) AS c,
      sum(CASE WHEN state = 'QUEUED' AND due_at > ? THEN 1 ELSE 0 END) AS live,
      group_concat(idempotency_key, char(31)) AS keys
    FROM world_scheduled_events
    WHERE event_type = ? AND state <> 'DONE' AND state IN ('QUEUED', 'RETRY', 'CLAIMED')
    GROUP BY aggregate_id HAVING c > 1 ORDER BY aggregate_id`);
  for (const [eventType] of PERIODIC_EVENT_TYPES) {
    for (const r of stmt.all(hasNow ? now : Number.MAX_SAFE_INTEGER, eventType)) {
      const sample = () => ({ eventType, aggregateId: r.aggregate_id, keys: String(r.keys || "").split("\u001f").sort() });
      if (hasNow && Number(r.live) < 2) {
        out.converging += 1;
        if (Array.isArray(convergingDetails) && convergingDetails.length < DETAIL_MAX) convergingDetails.push(sample());
        continue;
      }
      out.doubled += 1;
      if (Array.isArray(details) && details.length < DETAIL_MAX) details.push(sample());
    }
  }
  return out;
}

function occupationTickChainsDoubled(db, now, details) {
  if (!Number.isSafeInteger(now)) return null;
  if (!tableExists(db, "world_scheduled_events")) return 0;
  const rows = db.prepare(`SELECT aggregate_id, idempotency_key FROM world_scheduled_events
    WHERE event_type = ? AND state <> 'DONE' AND state IN ('QUEUED', 'RETRY', 'CLAIMED') AND due_at > ?
    AND idempotency_key LIKE 'occ:%:t:%' ORDER BY aggregate_id, idempotency_key`).all(OCCUPATION_EVENT_TYPE, now);
  const groups = new Map();
  for (const r of rows) {
    const m = OCCUPATION_TICK_KEY.exec(r.idempotency_key);
    if (!m) continue;
    const g = `${r.aggregate_id}|${m[2]}|${m[3]}`;
    const cur = groups.get(g);
    if (cur) cur.keys.push(r.idempotency_key);
    else groups.set(g, { aggregateId: r.aggregate_id, seq: Number(m[2]), intervalMs: Number(m[3]), keys: [r.idempotency_key] });
  }
  let n = 0;
  for (const g of groups.values()) {
    if (g.keys.length < 2) continue;
    n += 1;
    if (details.length < DETAIL_MAX) details.push(g);
  }
  return n;
}

function capturedOverLimit(db, config, details) {
  const max = config.strategy.maxCapturedSystemsPerFaction;
  const rows = db.prepare(`SELECT controller_faction_id AS f, count(*) AS n FROM world_system_state
    WHERE captured_at IS NOT NULL AND controller_faction_id IS NOT NULL GROUP BY controller_faction_id
    ORDER BY controller_faction_id`).all();
  const claims = db.prepare(`SELECT count(*) AS n FROM world_system_state WHERE occupier_faction_id = ?
    AND occupation_state IN (${CLAIM_STATES.map(() => "?").join(", ")})`);
  let n = 0;
  for (const r of rows) {
    if (r.n <= max) continue;
    n += 1;
    if (details.length < DETAIL_MAX) details.push({ factionId: r.f, captured: r.n, claims: claims.get(r.f, ...CLAIM_STATES).n });
  }
  return n;
}

function within(graph, from, range, target) {
  if (from === target) return true;
  let frontier = [from];
  const seen = new Set(frontier);
  for (let d = 0; d < range && frontier.length > 0; d += 1) {
    const next = [];
    for (const id of frontier) {
      for (const nb of graph.getNeighbors(id) || []) {
        if (nb === target) return true;
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return false;
}

function controllerHistory(db, ids, notes) {
  if (!tableExists(db, "world_event_journal")) {
    notes.push("nonAdjacentCaptures: no world_event_journal, controller history not read");
    return null;
  }
  if (ids.length > HISTORY_MAX_IDS) {
    notes.push(`nonAdjacentCaptures: ${ids.length} systems > ${HISTORY_MAX_IDS}, controller history not read`);
    return null;
  }
  const rows = db.prepare(`SELECT journal_id AS j, aggregate_id AS a, created_at AS t,
    json_extract(payload, '$.state.controllerFactionId') AS f, json_extract(payload, '$.state.capturedAt') AS c
    FROM world_event_journal WHERE aggregate_type = 'world_system' AND kind = 'APPLY'
    AND aggregate_id IN (${ids.map(() => "?").join(", ")})
    AND json_type(payload, '$.state.controllerFactionId') IS NOT NULL ORDER BY journal_id LIMIT ?`)
    .all(...ids.map(String), HISTORY_MAX_ROWS + 1);
  if (rows.length > HISTORY_MAX_ROWS) {
    notes.push(`nonAdjacentCaptures: controller history > ${HISTORY_MAX_ROWS} rows, not used`);
    return null;
  }
  const out = new Map();
  for (const r of rows) {
    const id = Number(r.a);
    const list = out.get(id) || [];
    list.push({ j: r.j, t: r.t, f: r.f === null ? null : Number(r.f), c: r.c === null ? null : Number(r.c) });
    out.set(id, list);
  }
  return out;
}

function heldAtCapture(history, sys, f, at, id) {
  const own = history.get(sys) || [];
  const capture = own.find((e) => e.f === f && e.c === at);
  const before = capture ? (e) => e.j < capture.j : (e) => e.t <= at;
  let last;
  for (const e of history.get(id) || []) {
    if (before(e)) last = e;
  }
  return Boolean(last && last.f === f);
}

function adjacencyCounts(db, ctx, details, notes) {
  const out = { nonAdjacentCaptures: 0, footholdCaptures: 0 };
  if (!ctx.prev || !ctx.graph) return out;
  const live = db.prepare(`SELECT 1 AS x FROM world_stations WHERE owner_faction_id = ? AND system_id = ?
    AND state <> 'DESTROYED' LIMIT 1`);
  const beachheads = tableExists(db, "world_invasions")
    ? db.prepare(`SELECT beachhead_system_id AS s, capture_range_jumps AS r FROM world_invasions WHERE faction_id = ?
      AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)`)
    : null;
  const ownSpaceOf = typeof ctx.ownSpaceOf === "function" ? ctx.ownSpaceOf : () => new Set();
  const now = new Map(db.prepare("SELECT system_id, controller_faction_id AS f, captured_at AS c FROM world_system_state")
    .all().map((r) => [r.system_id, r]));
  const heldBefore = (id, f, at) => {
    const n = now.get(id);
    return Boolean(n && n.f === f && (n.c === null || n.c < at));
  };
  const rows = [...now.values()].filter((r) => r.c !== null && r.f !== null).sort((a, b) => a.system_id - b.system_id);
  const unanchored = [];
  for (const r of rows) {
    if (ctx.prev.controller.get(r.system_id) === r.f) continue;
    const sys = r.system_id;
    if (beachheads && beachheads.all(r.f, r.c, r.c).some((b) => b.s !== null && within(ctx.graph, b.s, b.r || 0, sys))) {
      out.footholdCaptures += 1;
      continue;
    }
    const near = [sys, ...(ctx.graph.getNeighbors(sys) || [])];
    const own = ownSpaceOf(r.f) || new Set();
    const onBelt = (id) => own.has(id) || (ctx.graph.getNeighbors(id) || []).some((nb) => own.has(nb));
    const anchored = near.some((id) => live.get(r.f, id) !== undefined || (own.size > 0 && onBelt(id))
      || (id !== sys && (ctx.prev.controller.get(id) === r.f || heldBefore(id, r.f, r.c))));
    if (!anchored) unanchored.push({ r, near });
  }
  if (unanchored.length === 0) return out;
  const ids = [...new Set(unanchored.flatMap((u) => u.near))].sort((a, b) => a - b);
  const history = controllerHistory(db, ids, notes);
  for (const { r, near } of unanchored) {
    const sys = r.system_id;
    if (history && near.some((id) => id !== sys && heldAtCapture(history, sys, r.f, r.c, id))) continue;
    out.nonAdjacentCaptures += 1;
    if (details.length < DETAIL_MAX) details.push({ systemId: sys, factionId: r.f });
  }
  return out;
}

function coreCounts(db, config) {
  const index = getCoreIndex(config);
  if (!index || !index.enabled) return { coreViolations: 0, coreHomeMismatch: 0, audit: null };
  const ids = coreSystemIds(index);
  const rows = ids.length === 0 ? [] : db.prepare(`SELECT system_id, controller_faction_id, occupier_faction_id,
    occupation_state, home_faction_id FROM world_system_state WHERE system_id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids).map((r) => ({ systemId: r.system_id, controllerFactionId: r.controller_faction_id,
      occupierFactionId: r.occupier_faction_id, occupationState: r.occupation_state, homeFactionId: r.home_faction_id }));
  let stations = null;
  const stationIds = coreStationIds(index);
  if (tableExists(db, "world_stations") && stationIds.length > 0
    && db.prepare("SELECT count(*) AS n FROM world_stations").get().n > 0) {
    stations = db.prepare(`SELECT station_id, owner_faction_id, state FROM world_stations
      WHERE station_id IN (${stationIds.map(() => "?").join(", ")})`).all(...stationIds)
      .map((s) => ({ stationId: s.station_id, ownerFactionId: s.owner_faction_id, state: s.state }));
  }
  const audit = auditCores(index, rows, stations);
  const mismatch = audit.violations.filter((v) => v.kind === "HOME_MISMATCH").length;
  return { coreViolations: audit.violations.length - mismatch, coreHomeMismatch: mismatch, audit };
}

function checkCampaignInvariants(db, ctx = {}) {
  try {
    const config = ctx.config;
    if (!config || !config.strategy || !config.limits) return { ok: false, reason: "CHECK_CONFIG_MISSING" };
    const notes = [];
    const details = { capturedOverLimit: [], nonAdjacentCaptures: [], occupationTickChainsDoubled: [],
      periodicChainsDoubled: [], periodicChainsConverging: [] };
    const battle = checkBattleInvariants(db);
    if (!battle.ok) return { ok: false, reason: battle.reason, detail: battle.detail };
    const counts = {
      battleDuplicateSettlements: battle.duplicateSettlements,
      battleFleetsInTwoOpenBattles: battle.fleetsInTwoOpenBattles,
      battleOrphanEngaged: battle.orphanEngaged,
      battleOpenWithoutEvent: battle.openWithoutEvent,
      battleQuarantined: battle.quarantined,
      battleWreckFieldsOverOne: Math.max(0, battle.wreckFieldsPerBattleMax - 1),
    };
    counts.occupationInvariantViolations = occupationViolations(db);
    counts.phaseSeqRegressions = phaseSeqRegressions(db, ctx.prev || null);
    counts.upkeepOverlaps = upkeepOverlaps(db);
    const pcNow = Number.isSafeInteger(ctx.now) ? ctx.now : null;
    const pc = periodicChainCounts(db, pcNow, details.periodicChainsDoubled, details.periodicChainsConverging);
    counts.periodicChainsDoubled = pc.doubled;
    counts.periodicChainsConverging = pc.converging;
    if (pcNow === null) notes.push("no now: periodicChainsDoubled counts every open pair (old rule)");
    const occTicks = occupationTickChainsDoubled(db, ctx.now, details.occupationTickChainsDoubled);
    counts.occupationTickChainsDoubled = occTicks === null ? 0 : occTicks;
    if (occTicks === null) notes.push("no now: occupationTickChainsDoubled not computed");
    counts.capturedOverLimit = capturedOverLimit(db, config, details.capturedOverLimit);
    if (!ctx.prev) notes.push("no prev: phaseSeqRegressions/nonAdjacentCaptures not computed");
    else if (!ctx.graph) notes.push("no graph: nonAdjacentCaptures not computed");
    Object.assign(counts, adjacencyCounts(db, ctx, details.nonAdjacentCaptures, notes));
    const core = coreCounts(db, config);
    counts.coreViolations = core.coreViolations;
    counts.coreHomeMismatch = core.coreHomeMismatch;
    const liveFleets = db.prepare("SELECT count(*) AS n FROM virtual_fleets WHERE state <> 'DESTROYED'").get().n;
    counts.fleetsOverLimit = Math.max(0, liveFleets - config.limits.maxVirtualFleets);
    counts.quarantinedEvents = db.prepare("SELECT count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state = 'QUARANTINED'")
      .get().n;
    const claimedNow = db.prepare("SELECT count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state = 'CLAIMED'")
      .get().n;
    counts.claimedAfterRestart = ctx.restarted === true ? (ctx.claimedAfterFirstPass || 0) + claimedNow : 0;
    let disabledRows = 0;
    for (const t of ctx.disabledTables || DISABLED_MODULE_TABLES) {
      if (!tableExists(db, t)) {
        notes.push(`table ${t} missing`);
        continue;
      }
      disabledRows += db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n;
    }
    counts.disabledModuleRows = disabledRows;
    counts.sovUnavailable = ctx.sovUnavailable || 0;

    const informational = new Set(["footholdCaptures", "coreHomeMismatch", "periodicChainsConverging"]);
    if (config.strategy.captureRequiresAdjacency !== true) informational.add("nonAdjacentCaptures");
    if (ctx.disabledInformational === true) informational.add("disabledModuleRows");
    const failing = Object.keys(counts).filter((k) => !informational.has(k) && counts[k] !== 0);
    return { ok: true, pass: failing.length === 0 && battle.pass === true, counts, failing, details, notes,
      coreHeld: core.audit ? core.audit.heldByFaction : new Map() };
  } catch (err) {
    return { ok: false, reason: "CHECK_FAILED", detail: messageOf(err) };
  }
}

function formatCheck(r) {
  if (!r.ok) return `check-campaign: ${r.reason} ${r.detail || ""}`.trim();
  const parts = Object.entries(r.counts).map(([k, v]) => `${k}=${v}`);
  return `check-campaign: ${parts.join(" ")} -> ${r.pass ? "PASS" : "FAIL"}`;
}

module.exports = { checkCampaignInvariants, snapshotForChecks, formatCheck, coreCounts, periodicChainCounts,
  DISABLED_MODULE_TABLES };
