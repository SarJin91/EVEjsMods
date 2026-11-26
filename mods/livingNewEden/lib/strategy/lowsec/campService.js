"use strict";

const { performance } = require("node:perf_hooks");
const { jumpMsForComposition } = require("../../fleets/travel");
const { nextReconcileKey } = require("../../economy/reconcileSlots");
const { createHostility } = require("../../battle/data/hostility");
const { pairKeyOf } = require("../../battle/contacts");
const { fingerprint } = require("../../util/fingerprint");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../data/expansion");
const { planCamps, decideCampStep, crossingsOf, decideAmbush, routeWeightOf,
  crossingStartsOf, campGateOf } = require("./campRules");
const { gridOfRef } = require("../../battle/gridContacts");
const { entryGateOf } = require("../../fleets/grid/anchors");
const { transitTimelineOf, gateGridsOf, outCatchAtOf } = require("../../fleets/grid/transit");
const S = require("./schema");
const { claimHoldGuardOf, readClaimHoldInTx } = require("../claimHoldGuard");
const R = require("./data/lowsecRules");

const METRIC_PLANS = "lowsec.plans";
const METRIC_CAMPS_PLANNED = "lowsec.campsPlanned";
const METRIC_CAMPS_ACTIVATED = "lowsec.campsActivated";
const METRIC_CAMPS_EXPIRED = "lowsec.campsExpired";
const METRIC_CAMPS_BROKEN = "lowsec.campsBroken";
const METRIC_CAMPS_CANCELLED = "lowsec.campsCancelled";
const METRIC_PLAN_SKIPPED = "lowsec.planSkipped";
const METRIC_ENQUEUE_REFUSED = "lowsec.enqueueRefused";
const METRIC_PRUNED = "lowsec.pruned";
const METRIC_OPEN = "lowsec.open";
const METRIC_PLAN_MS = "lowsec.planMs";
const METRIC_SCANS = "lowsec.scans";
const METRIC_STRIKES_SCHEDULED = "lowsec.strikesScheduled";
const METRIC_INTERCEPTS = "lowsec.intercepts";
const METRIC_ESCAPES = "lowsec.escapes";
const METRIC_STRIKES_STALE = "lowsec.strikesStale";
const METRIC_SCAN_TRUNCATED = "lowsec.scanTruncated";
const METRIC_SCAN_HOSTILE_CONVOYS = "lowsec.scanHostileConvoys";
const METRIC_SCAN_CROSSINGS = "lowsec.scanCrossings";
const METRIC_STRIKES_KNOWN = "lowsec.strikesKnown";
const METRIC_STRIKES_CAPPED = "lowsec.strikesCapped";
const METRIC_PLAN_LOWSEC_CROSSINGS = "lowsec.planLowsecCrossings";
const METRIC_CAMPS_ON_ROUTE = "lowsec.campsOnRoute";
const METRIC_PLAN_CROSSINGS_IN_WINDOW = "lowsec.planCrossingsInWindow";
const COUNTERS = Object.freeze({ plans: METRIC_PLANS, campsPlanned: METRIC_CAMPS_PLANNED,
  campsActivated: METRIC_CAMPS_ACTIVATED, campsExpired: METRIC_CAMPS_EXPIRED, campsBroken: METRIC_CAMPS_BROKEN,
  campsCancelled: METRIC_CAMPS_CANCELLED, planSkipped: METRIC_PLAN_SKIPPED, enqueueRefused: METRIC_ENQUEUE_REFUSED,
  pruned: METRIC_PRUNED, scans: METRIC_SCANS, strikesScheduled: METRIC_STRIKES_SCHEDULED,
  intercepts: METRIC_INTERCEPTS, escapes: METRIC_ESCAPES, strikesStale: METRIC_STRIKES_STALE,
  scanTruncated: METRIC_SCAN_TRUNCATED, scanHostileConvoys: METRIC_SCAN_HOSTILE_CONVOYS,
  scanCrossings: METRIC_SCAN_CROSSINGS, strikesKnown: METRIC_STRIKES_KNOWN, strikesCapped: METRIC_STRIKES_CAPPED,
  planLowsecCrossings: METRIC_PLAN_LOWSEC_CROSSINGS, campsOnRoute: METRIC_CAMPS_ON_ROUTE,
  planCrossingsInWindow: METRIC_PLAN_CROSSINGS_IN_WINDOW,
  campGatePicked: "lowsec.campGatePicked", campGateNone: "lowsec.campGateNone", campGateMoves: "lowsec.campGateMoves",
  campGateRefused: "lowsec.campGateRefused", strikesOffGate: "lowsec.strikesOffGate", gateIn: "lowsec.gateIn",
  gateOut: "lowsec.gateOut", gateDeferred: "lowsec.gateDeferred", gateUnknown: "lowsec.gateUnknown" });
const FUNNEL = Object.freeze(["scanHostileConvoys", "scanCrossings", "strikesKnown", "strikesCapped",
  "strikesScheduled", "escapes", "intercepts", "strikesStale"]);
const END_COUNTER = Object.freeze({ EXPIRED: "campsExpired", BROKEN: "campsBroken", CANCELLED: "campsCancelled" });
const END_OUTCOME = Object.freeze({ EXPIRE: "EXPIRED", BREAK: "BROKEN", CANCEL: "CANCELLED" });
const STEP_KEYS = Object.freeze(["campId", "round", "stepSeq"]);
const AMBUSH_KEYS = Object.freeze(["at", "campId", "convoyId", "fleetId", "legSeq", "systemIndex"]);
const GATE_OUT = "out";
const AMBUSH_GATE_KEYS = Object.freeze([...AMBUSH_KEYS, "gate"].sort());
const KIND_ANCHOR = "anchor";
const PURPOSE_POST = "POST";
const SCAN_ACTIONS = Object.freeze(["ACTIVATE", "KEEP"]);
const STALE_INTERCEPT = Object.freeze(["STALE_LEG", "NOT_CROSSING", "LEG_HAS_WORMHOLES", "FLEET_NOT_FOUND"]);
const PERMANENT_INTERCEPT = Object.freeze(["FLEET_INVALID_INPUT"]);
const HALT_HASH_HEX = 40;
const ambushHaltKeyOf = (hitKey) => `lah:${fingerprint(`${hitKey}:halt`).slice(0, HALT_HASH_HEX)}`;
const STALE_OTHER = "OTHER";
const STALE_REASONS = Object.freeze([...new Set(["CAMP_NOT_ACTIVE", "CAMP_WINDOW", "CONVOY_GONE", "LEG_MOVED",
  "LEG_HAS_WORMHOLES", "NOT_CROSSING", "CAMP_FLEET_AWAY", "NOT_HOSTILE", "ON_COOLDOWN", "LOGISTICS_UNAVAILABLE",
  "BATTLE_UNAVAILABLE", "GATE_AWAY", ...STALE_INTERCEPT, STALE_OTHER])]);
const LOWSEC_CLASS = "lowsec";
const MAX_DETAIL = 120;

function staleKeyOf(reason) {
  const why = String(reason);
  return STALE_REASONS.includes(why) ? why : STALE_OTHER;
}
const MS_DECIMALS = 10;

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function parsePlanPayload(p) {
  if (!isPlain(p) || Object.keys(p).join() !== "round" || !isCount(p.round)) return null;
  return { round: p.round };
}

function parseStepPayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== STEP_KEYS.join()) return null;
  if (typeof p.campId !== "string" || p.campId === "" || !isCount(p.stepSeq) || !isCount(p.round)) return null;
  return { campId: p.campId, stepSeq: p.stepSeq, round: p.round };
}

function parseAmbushPayload(p) {
  if (!isPlain(p)) return null;
  const keys = Object.keys(p).sort().join();
  const deferred = keys === AMBUSH_GATE_KEYS.join() && p.gate === GATE_OUT;
  if (keys !== AMBUSH_KEYS.join() && !deferred) return null;
  for (const k of ["campId", "convoyId", "fleetId"]) if (typeof p[k] !== "string" || p[k] === "") return null;
  if (!isCount(p.legSeq) || !isCount(p.systemIndex) || !isTime(p.at)) return null;
  return { campId: p.campId, convoyId: p.convoyId, fleetId: p.fleetId, legSeq: p.legSeq, systemIndex: p.systemIndex,
    at: p.at, ...(deferred ? { gate: GATE_OUT } : {}) };
}

function paramsOf(C) {
  return Object.freeze({ maxActiveCamps: C.maxActiveCamps, maxActiveCampsPerFaction: C.maxActiveCampsPerFaction,
    maxCampsPerPlan: C.maxCampsPerPlan, campMaxJumps: C.campMaxJumps, maxBfsSystems: C.maxBfsSystems,
    campChoiceTopN: C.campChoiceTopN, campMinMs: C.campMinMs, campMaxMs: Math.max(C.campMinMs, C.campMaxMs),
    campRoles: R.CAMP_ROLES, excludedRegionIds: EXPANSION_EXCLUDED_REGION_IDS, stepIntervalMs: C.stepIntervalMs,
    stepRecheckMs: C.stepRecheckMs, maxWatchRounds: C.maxWatchRounds, scanMaxConvoys: C.scanMaxConvoys,
    maxStrikesPerScan: C.maxStrikesPerScan, interceptChancePermille: C.interceptChancePermille });
}

function createCampService(deps) {
  const { store, journal, camps, scheduler, fleetRepository, travel, clock, ids, config } = deps;
  const C = config.lowsec;
  const P = paramsOf(C);
  const timeFactor = config.fleets.travelTimeFactor;
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(Object.keys(COUNTERS).map((n) => [n, 0]));
  const skipByReason = Object.fromEntries(R.PLAN_SKIP_REASONS.map((r) => [r, 0]));
  const staleByReason = Object.create(null);
  let state = "running";
  let lastRefusal = null;
  let lastPlanAt = null;
  let openCount = 0;
  let scanState = "off";
  let lastScanRefusal = null;
  const cursors = { scan: "", plan: "", held: "" };
  const isHostile = typeof deps.isHostile === "function" ? deps.isHostile : createHostility();
  const hostile = (a, b) => {
    try {
      return isHostile(Number(a), Number(b)) === true;
    } catch (_err) {
      return false;
    }
  };
  const grid = deps.grid || null;
  const gateFlag = Boolean(config.grid && config.grid.crossings && config.grid.crossings.blockadeGateEnabled === true);
  const gateOn = () => {
    try {
      return gateFlag && Boolean(grid) && grid.isEnabled() === true && grid.movesEnabled() === true;
    } catch (_err) {
      return false;
    }
  };
  const gateOf = (camp) => (camp && camp.detail && Number.isSafeInteger(camp.detail.gateToSystemId)
    ? camp.detail.gateToSystemId : null);

  function softOf(getter, method) {
    try {
      const v = typeof getter === "function" ? getter() : null;
      return v && typeof v[method] === "function" ? v : null;
    } catch (_err) {
      return null;
    }
  }
  const logisticsNow = () => softOf(deps.getLogistics, "listInTransitInTx");
  const claimGuard = claimHoldGuardOf(config);
  const worldNow = () => {
    try {
      const w = typeof deps.getWorld === "function" ? deps.getWorld() : null;
      return w && w.repository ? w.repository : null;
    } catch (_err) {
      return null;
    }
  };
  const battleNow = () => softOf(deps.getBattle, "readCooldownsInTx");

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
    metric("count", COUNTERS[name], n);
  }

  function setOpen(n) {
    openCount = Math.max(0, n);
    metric("gauge", METRIC_OPEN, openCount);
  }

  function skip(reason, n = 1) {
    const key = Object.prototype.hasOwnProperty.call(skipByReason, reason) ? reason : "PLAN_REFUSED";
    skipByReason[key] += n;
    bump("planSkipped", n);
  }

  function strikeStale(reason) {
    const key = staleKeyOf(reason);
    staleByReason[key] = (staleByReason[key] || 0) + 1;
    bump("strikesStale");
    lastRefusal = `AMBUSH_${reason}`;
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const stopped = () => state !== "running";

  function graphNow() {
    try {
      const r = typeof deps.getGraph === "function" ? deps.getGraph() : null;
      return r && r.ok === true && r.graph ? r.graph : null;
    } catch (_err) {
      return null;
    }
  }

  function registryNow() {
    try {
      const r = typeof deps.getRegistry === "function" ? deps.getRegistry() : null;
      return r && typeof r.listActiveFactions === "function" ? r : null;
    } catch (_err) {
      return null;
    }
  }

  function etaOf(fleet, jumps) {
    const base = jumpMsForComposition(fleet.composition, { timeFactor });
    if (!base.ok) return null;
    try {
      return jumps * Math.max(1, clock.travelDurationMs(base.baseJumpMs, { observed: false }));
    } catch (_err) {
      return null;
    }
  }

  const roundOf = (t) => Math.floor(t / C.planPeriodMs) + 1;

  function readConvoys(db, logistics, factionIds, which) {
    const l = logistics.listInTransitInTx(db, { limit: C.scanMaxConvoys, after: cursors[which] });
    if (!l || l.ok !== true) return { ok: false, reason: String((l && l.reason) || "SCAN_READ_FAILED") };
    const truncated = l.truncated === true && l.convoys.length > 0;
    cursors[which] = truncated ? l.convoys[l.convoys.length - 1].convoyId : "";
    const convoys = l.convoys.filter((c) => typeof c.fleetId === "string" && c.fleetId !== ""
      && factionIds.some((f) => hostile(f, c.factionId)));
    if (convoys.length === 0) return { ok: true, convoys, fleets: new Map(), truncated };
    const f = fleetRepository.getFleets(db, convoys.map((c) => c.fleetId));
    if (!f.ok) return f;
    return { ok: true, convoys, fleets: new Map(f.fleets.map((x) => [x.fleetId, x])), truncated };
  }

  function scanFor(camp, start, end) {
    const off = (reason) => {
      scanState = "off";
      lastScanRefusal = reason;
      return { scanned: false, strikes: [], funnel: null };
    };
    try {
      const logistics = logisticsNow();
      if (!logistics) return off("LOGISTICS_UNAVAILABLE");
      const tx = store.transaction("lowsec.scanRead", (db) => readConvoys(db, logistics, [camp.factionId], "scan"));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) return off(String((read && read.reason) || "SCAN_READ_FAILED"));
      scanState = "on";
      const strikes = [];
      const all = crossingsOf(camp, read.convoys, read.fleets, { start, end });
      const gate = gateOn() ? gateOf(camp) : null;
      const crossings = gate === null ? all
        : crossingsOf(camp, read.convoys, read.fleets, { start, end, gateToSystemId: gate });
      const funnel = { scanHostileConvoys: read.convoys.length, scanCrossings: all.length, strikesKnown: 0,
        strikesCapped: 0, ...(gate === null ? {} : { strikesOffGate: all.length - crossings.length }) };
      for (let n = 0; n < crossings.length; n += 1) {
        const h = crossings[n];
        if (strikes.length >= C.maxStrikesPerScan) {
          funnel.strikesCapped = crossings.length - n;
          break;
        }
        const key = S.ambushKey(camp.campId, h.convoyId);
        const seen = scheduler.findByKey(key);
        if (!seen || seen.ok !== true || seen.found) {
          if (seen && seen.ok === true && seen.found) funnel.strikesKnown += 1;
          continue;
        }
        strikes.push({ key, payload: { campId: camp.campId, convoyId: h.convoyId, fleetId: h.fleetId,
          legSeq: h.legSeq, systemIndex: h.systemIndex, at: h.at } });
      }
      return { scanned: true, strikes, truncated: read.truncated, funnel };
    } catch (err) {
      return off(`SCAN_FAILED: ${messageOf(err)}`);
    }
  }

  function readPlan(db, at, registry, gate) {
    const total = camps.countOpen(db, { liveAt: at });
    if (!total.ok) return total;
    const open = camps.listOpen(db, { liveAt: at, limit: C.maxActiveCamps + 1 });
    if (!open.ok) return open;
    const first = camps.listOpen(db, { limit: C.reconcileMaxCamps });
    if (!first.ok) return first;
    let rest = [];
    if (first.nextAfter !== null) {
      const after = cursors.held > first.nextAfter ? cursors.held : first.nextAfter;
      const more = camps.listOpen(db, { limit: C.reconcileMaxCamps, after });
      if (!more.ok) return more;
      rest = more.camps;
      cursors.held = more.nextAfter !== null ? more.nextAfter : "";
    } else {
      cursors.held = "";
    }
    const held = { camps: [...first.camps, ...rest] };
    const heldFleets = new Set(held.camps.map((c) => c.fleetId));
    const factions = [];
    const fleetsByFaction = new Map();
    const fleetRecords = new Map();
    const campers = registry.listActiveFactions().filter((f) => f && R.CAMP_KINDS.includes(f.kind))
      .map((f) => f.factionId).sort((a, b) => a - b);
    const world = claimGuard ? worldNow() : null;
    for (const factionId of campers) {
      const c = camps.countOpen(db, { factionId, liveAt: at });
      if (!c.ok) return c;
      const hold = readClaimHoldInTx(db, world, factionId, at, claimGuard);
      if (!hold.ok) return hold;
      const page = [];
      for (const role of R.CAMP_ROLES) {
        const l = fleetRepository.listFleetsByFaction(db, factionId, { states: ["IDLE"], role, limit: C.fleetScanMax });
        if (!l.ok) return l;
        page.push(...l.fleets);
      }
      page.sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
      factions.push({ factionId, open: c.count });
      const scanned = page.slice(0, C.fleetScanMax);
      fleetsByFaction.set(factionId, scanned.filter((f) => !heldFleets.has(f.fleetId) && !hold.holds(f)).map((f) => {
        fleetRecords.set(f.fleetId, f);
        return { fleetId: f.fleetId, version: f.version, systemId: f.currentSystemId, fleetRole: f.fleetRole,
          refitPending: f.refitPending === true };
      }));
    }
    const occupiedSystems = new Set([...open.camps, ...held.camps].map((c) => c.systemId));
    let routeWeight = new Map();
    let routeTruncated = false;
    let convoyFunnel = null;
    let convoyRead = null;
    const logistics = campers.length > 0 ? logisticsNow() : null;
    if (logistics) {
      try {
        const cv = readConvoys(db, logistics, campers, "plan");
        if (cv.ok) {
          routeWeight = routeWeightOf(cv.convoys, cv.fleets, at);
          routeTruncated = cv.truncated;
          convoyFunnel = { hostileConvoys: cv.convoys.length, starts: crossingStartsOf(cv.convoys, cv.fleets, at) };
          if (gate) convoyRead = { convoys: cv.convoys, fleets: cv.fleets };
        }
      } catch (err) {
        if (db.inTransaction !== true) throw err;
      }
    }
    return { ok: true, openTotal: total.count, occupiedSystems, factions, fleetsByFaction, fleetRecords,
      overdue: held.camps.filter((c) => c.untilAt <= at), routeWeight, routeTruncated, convoyFunnel, convoyRead };
  }

  function campInTx(db, etx, k, campId, at, c, fleet, dueAt, gatePick) {
    const total = camps.countOpen(db, { liveAt: at });
    if (!total.ok) return total;
    if (total.count >= C.maxActiveCamps) return { ok: false, reason: "LIMIT" };
    const own = camps.countOpen(db, { factionId: c.factionId, liveAt: at });
    if (!own.ok) return own;
    if (own.count >= C.maxActiveCampsPerFaction) return { ok: false, reason: "FACTION_LIMIT" };
    const op = fleetRepository.createOperation(db, { operationType: R.CAMP_OPERATION_TYPE, factionId: c.factionId,
      originSystemId: fleet.currentSystemId, targetSystemId: c.systemId, objective: R.CAMP_OBJECTIVE, dueAt,
      fleets: [{ fleetId: c.fleetId, expectedVersion: c.expectedVersion }] }, `${k}:op`);
    if (!op.ok) return op;
    if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:op` };
    const planned = travel.planInTx(db, { fleetId: c.fleetId, targetSystemId: c.systemId, at }, `${k}:plan`,
      { chained: true });
    if (!planned || planned.ok !== true) return planned || { ok: false, reason: "PLAN_FAILED" };
    if (planned.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:plan` };
    if (dueAt - planned.arriveAt < C.campMinMs) return { ok: false, reason: "CAMP_TOO_SHORT" };
    const detail = { jumps: c.jumps, rank: c.rank, durationMs: c.durationMs,
      ...(gatePick === undefined ? {} : { gateToSystemId: gatePick ? gatePick.toSystemId : null,
        gateTraffic: gatePick ? gatePick.traffic : 0 }) };
    const created = camps.createCamp(db, { campId, factionId: c.factionId, fleetId: c.fleetId,
      operationId: op.operationId, systemId: c.systemId, seed: c.seed, plannedAt: at, arriveAt: planned.arriveAt,
      untilAt: dueAt, detail }, k);
    if (!created.ok) return created;
    if (created.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: k };
    const e = scheduler.enqueue(S.STEP_EVENT, campId, planned.arriveAt, { campId, stepSeq: 0, round: 0 },
      S.stepKey(campId, 0), { tx: etx, chained: true });
    if (!e || e.ok !== true) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", stage: "step" };
    return { ok: true, campId, factionId: c.factionId, fleetId: c.fleetId, systemId: c.systemId,
      operationId: op.operationId, arriveAt: planned.arriveAt, untilAt: dueAt,
      ...(gatePick === undefined ? {} : { gateToSystemId: detail.gateToSystemId }) };
  }

  function campEffect(etx, round, at, c, fleet, gatePick) {
    const k = S.campKey(round, c.factionId);
    const seen = journal.findByKey(etx, k);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, duplicate: true };
    const eta = fleet ? etaOf(fleet, c.jumps) : null;
    if (eta === null) return { ok: true, refused: "ETA_UNKNOWN" };
    const dueAt = at + eta + c.durationMs;
    const campId = ids.next("lc");
    const r = journal.applyOnce(etx, { key: k, aggregate: { type: S.CAMP_AGGREGATE, id: campId },
      eventType: "LOWSEC_CAMP_PLANNED", payload: { round, factionId: c.factionId, fleetId: c.fleetId,
        systemId: c.systemId, seed: c.seed, durationMs: c.durationMs } },
    (db) => campInTx(db, etx, k, campId, at, c, fleet, dueAt, gatePick));
    if (r.ok) return r.duplicate ? { ok: true, duplicate: true } : { ok: true, created: r.value };
    if (r.reason === "APPLY_REFUSED") {
      const why = String((r.refusal && r.refusal.reason) || "REFUSED");
      if (R.RETRYABLE_REASONS.includes(why)) return { ok: false, reason: why };
      return { ok: true, refused: why };
    }
    return { ok: true, refused: `${r.reason || "APPLY_FAILED"}${r.error ? `: ${messageOf(r.error)}` : ""}` };
  }

  function gatePickOf(c, at, gate, convoyRead) {
    if (!gate) return undefined;
    if (!convoyRead) return null;
    return campGateOf(c.systemId, convoyRead.convoys.filter((h) => hostile(c.factionId, h.factionId)),
      convoyRead.fleets, at);
  }

  function planEffect(etx, round, at, plan, fleetRecords, gate, convoyRead) {
    const out = { ok: true, created: [], refused: [], duplicates: 0, pruned: 0 };
    for (const c of plan.camps) {
      const r = campEffect(etx, round, at, c, fleetRecords.get(c.fleetId) || null,
        gatePickOf(c, at, gate, convoyRead));
      if (!r.ok) return r;
      if (r.created) out.created.push(r.created);
      else if (r.duplicate) out.duplicates += 1;
      else out.refused.push(r.refused);
    }
    const before = at - C.endedRetentionMs;
    if (before > 0) {
      const pr = camps.pruneEnded(etx, { before, limit: C.pruneMaxRows });
      if (pr.ok) out.pruned = pr.pruned;
    }
    return out;
  }

  function planFunnelOf(read, plan, at, graph) {
    try {
      const cf = read.convoyFunnel;
      if (!cf) return null;
      let lowsecCrossings = 0;
      for (const [systemId, list] of cf.starts) {
        const s = graph.getSystem(systemId);
        if (s && s.secClass === LOWSEC_CLASS) lowsecCrossings += list.length;
      }
      let routeSystems = 0;
      for (const w of read.routeWeight.values()) if (w > 0) routeSystems += 1;
      const byFaction = new Map();
      for (const c of plan.camps) {
        const w = read.routeWeight.get(c.systemId);
        const fleet = read.fleetRecords.get(c.fleetId) || null;
        const eta = fleet ? etaOf(fleet, c.jumps) : null;
        let inWindow = 0;
        if (eta !== null) {
          const from = at + eta;
          const to = from + c.durationMs;
          for (const t of cf.starts.get(c.systemId) || []) if (t >= from && t < to) inWindow += 1;
        }
        byFaction.set(c.factionId, { onRoute: Number.isFinite(w) && w > 0 ? 1 : 0, inWindow });
      }
      return { hostileConvoys: cf.hostileConvoys, lowsecCrossings, routeSystems, truncated: read.routeTruncated === true,
        byFaction };
    } catch (_err) {
      return null;
    }
  }

  function notePlanFunnel(funnel, round, created) {
    let onRoute = 0;
    let inWindow = 0;
    for (const c of created) {
      const f = c && funnel.byFaction.get(c.factionId);
      if (!f) continue;
      onRoute += f.onRoute;
      inWindow += f.inWindow;
    }
    bump("planLowsecCrossings", funnel.lowsecCrossings);
    bump("campsOnRoute", onRoute);
    bump("planCrossingsInWindow", inWindow);
    log(`lowsec: plan round=${round} hostileConvoys=${funnel.hostileConvoys} lowsecCrossings=${funnel.lowsecCrossings} `
      + `routeSystems=${funnel.routeSystems} newCamps=${created.length} onRoute=${onRoute} `
      + `crossingsInWindow=${inWindow} truncated=${funnel.truncated ? 1 : 0}`);
    const stale = Object.keys(staleByReason).sort().map((k) => `${k}=${staleByReason[k]}`);
    if (stale.length > 0) log(`lowsec: stale ${stale.join(" ")}`);
  }

  function onPlan(ev, hctx) {
    try {
      const p = parsePlanPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "LOWSEC_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "LOWSEC_STOPPED" };
      const registry = registryNow();
      if (!registry) return { ok: false, reason: "STRATEGY_NOT_READY" };
      const graph = graphNow();
      if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      const t0 = nowMs();
      const gate = gateOn();
      const tx = store.transaction("lowsec.planRead", (db) => readPlan(db, at, registry, gate));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        const reason = String((read && read.reason) || "LOWSEC_READ_FAILED");
        lastRefusal = reason;
        return { ok: false, reason };
      }
      if (read.overdue.length > 0) {
        const rec = reconcileCamps(read.overdue, at);
        if (rec.enqueued + rec.exhausted + rec.refused > 0) {
          log(`lowsec: plan overdue=${read.overdue.length} reconciled=${rec.enqueued} exhausted=${rec.exhausted} `
            + `refused=${rec.refused}${rec.lastError ? ` error=${rec.lastError}` : ""}`);
        }
      }
      const plan = planCamps({ at, round: p.round, worldSeed, factions: read.factions, openTotal: read.openTotal,
        occupiedSystems: read.occupiedSystems, fleetsByFaction: read.fleetsByFaction,
        neighbors: (id) => graph.getNeighbors(id), getSystem: (id) => graph.getSystem(id),
        routeWeight: read.routeWeight }, P);
      const ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      const funnel = planFunnelOf(read, plan, at, graph);
      const next = roundOf(at);
      return { ok: true, outcome: plan.camps.length > 0 ? "PLAN" : "NO_CAMP",
        effect: (etx) => planEffect(etx, p.round, at, plan, read.fleetRecords, gate, read.convoyRead),
        reschedule: { eventType: S.PLAN_EVENT, aggregateId: S.PLAN_AGGREGATE_ID, dueAt: next * C.planPeriodMs,
          payload: { round: next }, idempotencyKey: S.planKey(next) },
        onCommitted: (v) => {
          bump("plans");
          if (read.routeTruncated) bump("scanTruncated");
          lastPlanAt = at;
          metric("observe", METRIC_PLAN_MS, ms);
          for (const s of plan.skipped) skip(s.reason);
          if (funnel) notePlanFunnel(funnel, p.round, v && Array.isArray(v.created) ? v.created : []);
          if (!v) return;
          for (const why of v.refused) {
            skip(why === "LIMIT" || why === "FACTION_LIMIT" ? why : "PLAN_REFUSED");
            lastRefusal = why;
          }
          bump("pruned", v.pruned);
          for (const c of v.created) {
            if (!Object.prototype.hasOwnProperty.call(c, "gateToSystemId")) continue;
            bump(c.gateToSystemId === null ? "campGateNone" : "campGatePicked");
          }
          if (v.created.length > 0) {
            bump("campsPlanned", v.created.length);
            setOpen(read.openTotal + v.created.length);
            for (const c of v.created) {
              log(`lowsec: camp ${c.campId} faction=${c.factionId} fleet=${c.fleetId} system=${c.systemId} `
                + `arrive=${c.arriveAt} until=${c.untilAt}`);
            }
          } else setOpen(read.openTotal);
        } };
    } catch (err) {
      return { ok: false, reason: `LOWSEC_PLAN_FAILED: ${messageOf(err)}` };
    }
  }

  function readStep(db, campId) {
    const g = camps.getCamp(db, campId);
    if (!g.ok) return g;
    if (!g.camp) return { ok: true, camp: null, fleet: null };
    const f = fleetRepository.getFleet(db, g.camp.fleetId);
    if (!f.ok) return f;
    return { ok: true, camp: g.camp, fleet: f.fleet };
  }

  function campGateMoveInTx(db, camp, fleet, at) {
    const to = gateOf(camp);
    if (to === null || !fleet || fleet.state !== "STAGED" || fleet.currentSystemId !== camp.systemId) return null;
    const sg = grid.readSystemGrid(camp.systemId);
    const anchor = sg && sg.ok === true ? entryGateOf(sg.anchors, to) : null;
    if (!anchor) return { refused: "NO_GATE" };
    const r = grid.moveInTx(db, { fleetId: fleet.fleetId, systemId: camp.systemId, legSeq: fleet.legSeq, at,
      to: { kind: anchor.kind, id: anchor.id }, purpose: PURPOSE_POST }, { chained: true });
    if (r && r.ok === true) return r.moved === true ? { moved: true } : null;
    return { refused: String((r && r.reason) || "MOVE_FAILED") };
  }

  function stepInTx(db, etx, camp, d, at, strikes, fleet) {
    const id = camp.campId;
    const seq = camp.stepSeq;
    let nextKey = null;
    let payload = null;
    let r;
    if (d.action === "ACTIVATE") {
      r = camps.transitionCamp(db, { campId: id, expectedVersion: camp.version, from: "PLANNED", to: "ACTIVE",
        patch: { activeFrom: at, stepSeq: seq + 1, watchRound: 0 } });
      nextKey = S.stepKey(id, seq + 1);
      payload = { campId: id, stepSeq: seq + 1, round: 0 };
    } else if (d.action === "KEEP") {
      r = camps.watchCamp(db, { campId: id, expectedVersion: camp.version, stepSeq: seq + 1, watchRound: 0, at });
      nextKey = S.stepKey(id, seq + 1);
      payload = { campId: id, stepSeq: seq + 1, round: 0 };
    } else if (d.action === "WAIT") {
      const round = camp.watchRound + 1;
      r = camps.watchCamp(db, { campId: id, expectedVersion: camp.version, stepSeq: seq, watchRound: round, at });
      nextKey = S.waitKey(id, seq, round);
      payload = { campId: id, stepSeq: seq, round };
    } else {
      r = camps.transitionCamp(db, { campId: id, expectedVersion: camp.version, from: camp.state, to: "ENDED",
        patch: { outcome: END_OUTCOME[d.action], endReason: d.reason, endedAt: at } });
    }
    if (!r.ok) return r;
    const gateMove = SCAN_ACTIONS.includes(d.action) && gateOn() ? campGateMoveInTx(db, camp, fleet, at) : null;
    if (nextKey !== null) {
      const e = scheduler.enqueue(S.STEP_EVENT, id, d.nextAt, payload, nextKey, { tx: etx, chained: true });
      if (!e || e.ok !== true) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", stage: "step" };
    }
    let scheduled = 0;
    let strikeRefused = 0;
    for (const s of strikes || []) {
      const e = scheduler.enqueue(S.AMBUSH_EVENT, id, s.payload.at, s.payload, s.key, { tx: etx, chained: true });
      if (e && e.ok === true) scheduled += e.duplicate ? 0 : 1;
      else if (!e || e.reason !== "IDEMPOTENCY_CONFLICT") strikeRefused += 1;
    }
    return { ok: true, campId: id, action: d.action, outcome: END_OUTCOME[d.action] || null, reason: d.reason || null,
      strikes: scheduled, strikeRefused, ...(gateMove ? { gateMove } : {}) };
  }

  function stepEffect(etx, ev, p, camp, d, strikes, fleet) {
    const r = journal.applyOnce(etx, { key: `${ev.idempotencyKey}:apply`, aggregate: { type: S.CAMP_AGGREGATE,
      id: camp.campId }, eventType: "LOWSEC_CAMP_STEPPED", payload: { campId: p.campId, stepSeq: p.stepSeq,
      round: p.round } }, (db) => stepInTx(db, etx, camp, d, ev.dueAt, strikes, fleet));
    if (r.ok) return r.duplicate ? { ok: true, applied: false, action: "DUPLICATE" } : { ok: true, applied: true,
      ...r.value };
    if (r.reason === "APPLY_REFUSED") {
      const why = String((r.refusal && r.refusal.reason) || "REFUSED");
      if (why === "VERSION_CONFLICT") return { ok: true, applied: false, action: "STALE" };
      return r.refusal || { ok: false, reason: why };
    }
    return { ok: false, reason: r.reason || "APPLY_FAILED", detail: r.error ? messageOf(r.error) : undefined };
  }

  function onStep(ev) {
    try {
      const p = parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "LOWSEC_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "LOWSEC_STOPPED" };
      const tx = store.transaction("lowsec.stepRead", (db) => readStep(db, p.campId));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "LOWSEC_READ_FAILED") };
      }
      const camp = read.camp;
      if (!camp || camp.stepSeq !== p.stepSeq || camp.watchRound !== p.round) return { ok: true, outcome: "STALE" };
      const d = decideCampStep(camp, read.fleet, { at: ev.dueAt }, P);
      if (d.action === "STALE") return { ok: true, outcome: "STALE" };
      const scan = SCAN_ACTIONS.includes(d.action) ? scanFor(camp, ev.dueAt, d.nextAt)
        : { scanned: false, strikes: [] };
      return { ok: true, outcome: d.action,
        effect: (etx, event) => stepEffect(etx, event, p, camp, d, scan.strikes, read.fleet),
        onCommitted: (v) => {
          if (!v || v.applied !== true) return;
          if (v.gateMove && v.gateMove.moved) bump("campGateMoves");
          if (v.gateMove && v.gateMove.refused) {
            bump("campGateRefused");
            lastRefusal = `CAMP_GATE_${v.gateMove.refused}`;
          }
          if (scan.scanned) bump("scans");
          if (scan.truncated) bump("scanTruncated");
          if (scan.funnel) for (const [name, n] of Object.entries(scan.funnel)) bump(name, n);
          bump("strikesScheduled", v.strikes || 0);
          bump("enqueueRefused", v.strikeRefused || 0);
          if (v.action === "ACTIVATE") bump("campsActivated");
          if (v.outcome) {
            bump(END_COUNTER[v.outcome]);
            setOpen(openCount - 1);
            log(`lowsec: camp ${v.campId} ${v.outcome} ${v.reason}`);
          }
        } };
    } catch (err) {
      return { ok: false, reason: `LOWSEC_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function readAmbush(db, p, logistics, battle) {
    const g = camps.getCamp(db, p.campId);
    if (!g.ok) return g;
    const camp = g.camp;
    if (!camp) return { ok: true, camp: null };
    let convoy = null;
    if (logistics && logistics.convoys && typeof logistics.convoys.getConvoy === "function") {
      const c = logistics.convoys.getConvoy(db, p.convoyId);
      if (!c || c.ok !== true) return c || { ok: false, reason: "CONVOY_READ_FAILED" };
      convoy = c.convoy;
    }
    const f = fleetRepository.getFleets(db, [p.fleetId, camp.fleetId]);
    if (!f.ok) return f;
    const byId = new Map(f.fleets.map((x) => [x.fleetId, x]));
    let cooldownUntil = null;
    let cooldowns = false;
    if (battle && convoy) {
      const cd = battle.readCooldownsInTx(db, camp.systemId);
      if (cd && cd.ok === true && cd.cooldowns instanceof Map) {
        cooldowns = true;
        const u = cd.cooldowns.get(pairKeyOf(camp.factionId, Number(convoy.factionId)));
        cooldownUntil = Number.isFinite(u) ? u : null;
      }
    }
    return { ok: true, camp, convoy, convoyFleet: byId.get(p.fleetId) || null,
      campFleet: byId.get(camp.fleetId) || null, cooldownUntil, cooldowns };
  }

  function gridKeysAt(db, systemId, fleets, at) {
    const r = grid.positionsOf(db, systemId, fleets, at);
    if (!r || r.ok !== true || r.anchorsReason !== null || !(r.positions instanceof Map)) return null;
    const out = new Set();
    for (const pos of r.positions.values()) if (pos && pos.kind === KIND_ANCHOR) out.add(pos.gridKey);
    return out;
  }

  function readAmbushGate(db, p, read) {
    const T = read.camp.systemId;
    const tl = transitTimelineOf(read.convoyFleet.route, p.systemIndex, read.convoyFleet.composition);
    if (!tl.ok) return null;
    const sg = grid.readSystemGrid(T);
    if (!sg || sg.ok !== true || !Array.isArray(sg.anchors)) return null;
    const grids = gateGridsOf(sg.anchors, gridOfRef(sg.grids), read.convoyFleet.route, p.systemIndex);
    if (!grids.in && !grids.out) return { timeline: tl, grids, inGridKeys: new Set(), outGridKeys: new Set() };
    const catchers = [read.campFleet];
    const inGridKeys = p.gate === GATE_OUT ? new Set() : gridKeysAt(db, T, catchers, p.at);
    const outGridKeys = gridKeysAt(db, T, catchers, outCatchAtOf(tl, p.at));
    if (!inGridKeys || !outGridKeys) return null;
    return { timeline: tl, grids, inGridKeys, outGridKeys };
  }

  function deferAmbushEffect(etx, p, k, d) {
    const seen = journal.findByKey(etx, k);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, applied: false, action: "DUPLICATE" };
    const payload = { at: d.catchAt, campId: p.campId, convoyId: p.convoyId, fleetId: p.fleetId, gate: GATE_OUT,
      legSeq: p.legSeq, systemIndex: p.systemIndex };
    const e = scheduler.enqueue(S.AMBUSH_EVENT, p.campId, d.catchAt, payload, `${S.ambushKey(p.campId, p.convoyId)}:o`,
      { tx: etx, chained: true });
    if (!e || e.ok !== true) return { ok: false, reason: String((e && e.reason) || "ENQUEUE_FAILED") };
    return { ok: true, applied: false, action: "DEFER", duplicate: e.duplicate === true };
  }

  function ambushEffect(etx, p, read, d) {
    const k = S.hitKey(p.campId, p.convoyId);
    if (d.action === "DEFER") return deferAmbushEffect(etx, p, k, d);
    const seen = journal.findByKey(etx, k);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, applied: false, action: "DUPLICATE" };
    const r = journal.applyOnce(etx, { key: k, aggregate: { type: S.CAMP_AGGREGATE, id: p.campId },
      eventType: "LOWSEC_AMBUSH_RESOLVED", payload: { ...p, outcome: d.action, roll: d.roll } }, (db) => {
      if (d.action === "ESCAPED") return { ok: true, action: "ESCAPED", campId: p.campId, convoyId: p.convoyId };
      const h = travel.interceptInTx(db, { fleetId: p.fleetId, expectedVersion: read.convoyFleet.version,
        legSeq: p.legSeq, systemIndex: p.systemIndex, at: p.at }, ambushHaltKeyOf(k), { chained: true });
      if (!h || h.ok !== true) return h || { ok: false, reason: "INTERCEPT_FAILED" };
      if (d.gate === GATE_OUT && h.duplicate !== true) {
        const pl = grid.placeInTx(db, { fleetId: p.fleetId, systemId: h.systemId, legSeq: p.legSeq, at: p.at,
          anchor: d.anchor });
        if (!pl || pl.ok !== true || pl.placed !== true) {
          return { ok: false, reason: "GATE_PLACE_FAILED", permanent: true,
            detail: String((pl && pl.reason) || "NOT_PLACED") };
        }
      }
      const n = camps.noteIntercept(db, { campId: read.camp.campId, expectedVersion: read.camp.version, at: p.at,
        convoyId: p.convoyId });
      if (!n.ok) return n;
      return { ok: true, action: "INTERCEPT", campId: p.campId, convoyId: p.convoyId, systemId: h.systemId };
    });
    if (r.ok) return r.duplicate ? { ok: true, applied: false, action: "DUPLICATE" } : { ok: true, applied: true,
      ...r.value };
    if (r.reason === "APPLY_REFUSED") {
      const why = String((r.refusal && r.refusal.reason) || "REFUSED");
      if (STALE_INTERCEPT.includes(why)) return { ok: true, applied: false, action: "STALE", reason: why };
      if (PERMANENT_INTERCEPT.includes(why)) return { ...r.refusal, ok: false, reason: why, permanent: true };
      return r.refusal || { ok: false, reason: why };
    }
    return { ok: false, reason: r.reason || "APPLY_FAILED", detail: r.error ? messageOf(r.error) : undefined };
  }

  function onAmbush(ev) {
    try {
      const p = parseAmbushPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "LOWSEC_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "LOWSEC_STOPPED" };
      const stale = (reason) => ({ ok: true, outcome: "STALE", onCommitted: () => strikeStale(reason) });
      const logistics = logisticsNow();
      const battle = battleNow();
      const tx = store.transaction("lowsec.ambushRead", (db) => readAmbush(db, p, logistics, battle));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "LOWSEC_READ_FAILED") };
      }
      if (!read.camp) return stale("CAMP_NOT_ACTIVE");
      if (!logistics || !logistics.convoys) return stale("LOGISTICS_UNAVAILABLE");
      if (!read.cooldowns && read.convoy) return stale("BATTLE_UNAVAILABLE");
      const facts = { p, camp: read.camp, convoy: read.convoy, convoyFleet: read.convoyFleet,
        campFleet: read.campFleet, hostile: Boolean(read.convoy && hostile(read.camp.factionId, read.convoy.factionId)),
        cooldownUntil: read.cooldownUntil, worldSeed };
      let d = decideAmbush(facts, P);
      if (d.action === "STALE") return stale(d.reason);
      let gateUnknown = false;
      if (gateOn()) {
        const g = store.transaction("lowsec.ambushGateRead", (db) => readAmbushGate(db, p, read));
        const gate = g.ok ? g.value : null;
        if (gate && (gate.grids.in || gate.grids.out)) d = decideAmbush({ ...facts, gate }, P);
        else gateUnknown = true;
        if (d.action === "STALE") return stale(d.reason);
      }
      return { ok: true, outcome: d.action, effect: (etx) => ambushEffect(etx, p, read, d),
        onCommitted: (v) => {
          if (gateUnknown) bump("gateUnknown");
          if (v && v.action === "DEFER") bump("gateDeferred");
          if (!v || v.applied !== true) {
            if (v && v.action === "STALE") strikeStale(v.reason);
            return;
          }
          if (d.gate === "in") bump("gateIn");
          if (d.gate === GATE_OUT) bump("gateOut");
          if (v.action === "ESCAPED") bump("escapes");
          if (v.action === "INTERCEPT") {
            bump("intercepts");
            log(`lowsec: camp ${v.campId} intercepted convoy ${v.convoyId} system=${v.systemId}`);
          }
        } };
    } catch (err) {
      return { ok: false, reason: `LOWSEC_AMBUSH_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (stopped()) return { ok: false, reason: "LOWSEC_STOPPED" };
      const round = roundOf(clock.now());
      const r = scheduler.enqueue(S.PLAN_EVENT, S.PLAN_AGGREGATE_ID, round * C.planPeriodMs, { round },
        S.planKey(round));
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      return { ok: true, duplicate: r.duplicate === true, round };
    } catch (err) {
      return { ok: false, reason: `LOWSEC_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function reconcileCamps(list, dueAt) {
    const out = { ok: true, enqueued: 0, open: 0, exhausted: 0, refused: 0, lastError: null };
    for (const camp of list) {
      try {
        const seq = camp.stepSeq;
        const dueKey = camp.watchRound > 0 ? S.waitKey(camp.campId, seq, camp.watchRound)
          : S.stepKey(camp.campId, seq);
        const slot = nextReconcileKey(scheduler, { dueKey, baseKey: S.recBaseKey(camp.campId, seq),
          maxAttempts: C.reconcileMaxAttempts });
        if (!slot.ok) {
          out.refused += 1;
          out.lastError = String(slot.reason || "RECONCILE_SLOT_FAILED").slice(0, MAX_DETAIL);
          continue;
        }
        if (slot.open) {
          out.open += 1;
          continue;
        }
        if (slot.exhausted) {
          out.exhausted += 1;
          continue;
        }
        const e = scheduler.enqueue(S.STEP_EVENT, camp.campId, dueAt, { campId: camp.campId, stepSeq: seq,
          round: camp.watchRound }, slot.key);
        if (e && e.ok === true) out.enqueued += e.duplicate ? 0 : 1;
        else {
          out.refused += 1;
          out.lastError = String((e && e.reason) || "ENQUEUE_FAILED").slice(0, MAX_DETAIL);
          bump("enqueueRefused");
        }
      } catch (err) {
        out.refused += 1;
        out.lastError = messageOf(err);
      }
    }
    return out;
  }

  function reconcile() {
    try {
      if (stopped()) return { ok: false, reason: "LOWSEC_STOPPED" };
      const l = store.transaction("lowsec.reconcileRead", (db) => camps.listOpen(db, { limit: C.reconcileMaxCamps }));
      const read = l.ok ? l.value : l;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "LOWSEC_READ_FAILED") };
      }
      return reconcileCamps(read.camps, clock.now());
    } catch (err) {
      return { ok: false, reason: `LOWSEC_RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped() ? "off" : "ready", counters: Object.freeze({ ...counters }),
      open: openCount, lastPlanAt, skipByReason: Object.freeze({ ...skipByReason }), lastRefusal,
      scan: scanState, lastScanRefusal, staleByReason: Object.freeze({ ...staleByReason }),
      funnel: Object.freeze(Object.fromEntries(FUNNEL.map((n) => [n, counters[n]]))) });
  }

  return Object.freeze({
    onPlan,
    onStep,
    onAmbush,
    bootstrap,
    reconcile,
    getStatus,
    setOpen,
    getMode: () => (stopped() ? "off" : "ready"),
    stop() {
      state = "stopped";
    },
    isStopped: stopped,
  });
}

module.exports = { createCampService, parsePlanPayload, parseStepPayload, parseAmbushPayload, paramsOf, COUNTERS,
  STALE_REASONS, staleKeyOf, ambushHaltKeyOf };
