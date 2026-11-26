"use strict";

const { performance } = require("node:perf_hooks");
const { jumpMsForComposition } = require("../../fleets/travel");
const { parseHullGroupList } = require("../../fleets/schema");
const { nextReconcileKey } = require("../../economy/reconcileSlots");
const { planExpeditions, decideExpeditionStep, cutOffTimesOf, cutOffNextAt, fleetMassOf } =
  require("./expeditionRules");
const S = require("./schema");
const { claimHoldGuardOf, readClaimHoldInTx } = require("../claimHoldGuard");
const R = require("./data/expeditionRules");

const METRIC_PLANS = "expeditions.plans";
const METRIC_PLANNED = "expeditions.planned";
const METRIC_ACTIVATED = "expeditions.activated";
const METRIC_EVACUATED = "expeditions.evacuated";
const METRIC_CUT_OFF = "expeditions.cutOff";
const METRIC_RECOVERED = "expeditions.recovered";
const METRIC_RETURNED = "expeditions.returned";
const METRIC_LOST = "expeditions.lost";
const METRIC_CANCELLED = "expeditions.cancelled";
const METRIC_PLAN_SKIPPED = "expeditions.planSkipped";
const METRIC_SYNC_DEFERRED = "expeditions.syncDeferred";
const METRIC_ENQUEUE_REFUSED = "expeditions.enqueueRefused";
const METRIC_PRUNED = "expeditions.pruned";
const METRIC_OPEN = "expeditions.open";
const METRIC_PLAN_MS = "expeditions.planMs";
const METRIC_HELD = "expeditions.held";
const METRIC_WRITTEN_OFF = "expeditions.writtenOff";
const COUNTERS = Object.freeze({ plans: METRIC_PLANS, planned: METRIC_PLANNED, activated: METRIC_ACTIVATED,
  evacuated: METRIC_EVACUATED, cutOff: METRIC_CUT_OFF, recovered: METRIC_RECOVERED, returned: METRIC_RETURNED,
  lost: METRIC_LOST, cancelled: METRIC_CANCELLED, planSkipped: METRIC_PLAN_SKIPPED, syncDeferred: METRIC_SYNC_DEFERRED,
  enqueueRefused: METRIC_ENQUEUE_REFUSED, pruned: METRIC_PRUNED, held: METRIC_HELD, writtenOff: METRIC_WRITTEN_OFF });
const PANEL_OPEN_ROWS = 50;
const PANEL_ENDED_ROWS = 20;
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const RELEASE_FLEET_STATES = Object.freeze(["STAGED", "PLANNED"]);
const CLOSED_BY = "expedition";
const HOLD_REASON = Object.freeze({ UNHOLD: "UNHOLD", WRITTEN_OFF: "WRITTEN_OFF", REHOLD: "REHOLD" });
const END_COUNTER = Object.freeze({ RETURNED: "returned", LOST: "lost", CANCELLED: "cancelled" });
const STEP_KEYS = Object.freeze(["expeditionId", "round", "stepSeq"]);
const SYNCED = "synced";
const SYNC_PENDING = "WORMHOLE_SYNC_PENDING";
const NOT_SYNCED = "NOT_SYNCED";
const PARKED = Object.freeze(["STAGED", "IDLE"]);
const MAX_DETAIL = 120;
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
  if (typeof p.expeditionId !== "string" || p.expeditionId === "" || !isCount(p.stepSeq) || !isCount(p.round)) {
    return null;
  }
  return { expeditionId: p.expeditionId, stepSeq: p.stepSeq, round: p.round };
}

const wormholeConstraintsOf = (minJumpMass) => (Number.isSafeInteger(minJumpMass) && minJumpMass > 0
  ? { wormholes: true, wormholeMinJumpMass: minJumpMass } : { wormholes: true });

const excludedGroupsOf = (text) => parseHullGroupList(text) || [];

function paramsOf(C) {
  return Object.freeze({ maxActiveExpeditions: C.maxActiveExpeditions,
    massRuleEnabled: C.capitalMassRuleEnabled === true, maxCapitalHulls: C.maxCapitalHullsPerExpedition,
    subcapMassRuleEnabled: C.subcapMassRuleEnabled === true,
    massRuleExcludedGroups: Object.freeze(excludedGroupsOf(C.massRuleExcludedHullGroups)),
    maxActiveExpeditionsPerFaction: C.maxActiveExpeditionsPerFaction, maxExpeditionsPerPlan: C.maxExpeditionsPerPlan,
    entryMaxJumps: C.entryMaxJumps, maxBfsSystems: C.maxBfsSystems, candidateTopN: C.candidateTopN,
    expeditionMinMs: C.expeditionMinMs, expeditionMaxMs: Math.max(C.expeditionMinMs, C.expeditionMaxMs),
    returnMarginMs: C.returnMarginMs, stepIntervalMs: C.stepIntervalMs, stepRecheckMs: C.stepRecheckMs,
    maxWatchRounds: C.maxWatchRounds, presenceGainPermille: C.presenceGainPermille, cutOffRecheckMs: C.cutOffRecheckMs,
    cutOffDecisionMs: C.cutOffDecisionMs });
}

function createExpeditionService(deps) {
  const { store, journal, expeditions, scheduler, fleetRepository, travel, clock, ids, config } = deps;
  const C = config.expeditions;
  const P = paramsOf(C);
  const evacMassOf = (fleet) => fleetMassOf(fleet.composition, { capitals: true, subcaps: P.subcapMassRuleEnabled });
  const timeFactor = config.fleets.travelTimeFactor;
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(Object.keys(COUNTERS).map((n) => [n, 0]));
  const skipByReason = Object.fromEntries(R.PLAN_SKIP_REASONS.map((r) => [r, 0]));
  let state = "running";
  let lastRefusal = null;
  let lastPlanAt = null;
  let openCount = 0;
  const claimGuard = claimHoldGuardOf(config);
  const worldNow = () => {
    try {
      const w = typeof deps.getWorld === "function" ? deps.getWorld() : null;
      return w && w.repository ? w.repository : null;
    } catch (_err) {
      return null;
    }
  };

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

  function wormholesSynced() {
    try {
      const wh = typeof deps.getWormholes === "function" ? deps.getWormholes() : null;
      if (!wh || typeof wh.isSynced !== "function" || typeof wh.getStatus !== "function") return false;
      if (wh.isSynced() !== true) return false;
      const st = wh.getStatus();
      return Boolean(st && st.state === SYNCED);
    } catch (_err) {
      return false;
    }
  }

  function jumpMsOf(fleet) {
    const base = jumpMsForComposition(fleet.composition, { timeFactor });
    if (!base.ok) return null;
    try {
      return Math.max(1, clock.travelDurationMs(base.baseJumpMs, { observed: false }));
    } catch (_err) {
      return null;
    }
  }

  const roundOf = (t) => Math.floor(t / C.planPeriodMs) + 1;
  const isJSpaceIn = (graph) => (id) => {
    const s = graph.getSystem(id);
    return Boolean(s && s.secClass === R.JSPACE_CLASS);
  };

  function readPlan(db, registry, at) {
    const total = expeditions.countOpen(db, {});
    if (!total.ok) return total;
    const occ = expeditions.occupiedSystems(db, { limit: C.maxActiveExpeditions + C.reconcileMaxExpeditions });
    if (!occ.ok) return occ;
    const held = expeditions.listOpen(db, { limit: C.reconcileMaxExpeditions });
    if (!held.ok) return held;
    const heldFleets = new Set(held.expeditions.map((e) => e.fleetId));
    const factions = [];
    const fleetRecords = new Map();
    const kinds = registry.listActiveFactions().filter((f) => f && R.EXPEDITION_KINDS.includes(f.kind))
      .map((f) => f.factionId).sort((a, b) => a - b);
    const world = claimGuard ? worldNow() : null;
    for (const factionId of kinds) {
      const c = expeditions.countOpen(db, { factionId });
      if (!c.ok) return c;
      const hold = readClaimHoldInTx(db, world, factionId, at, claimGuard);
      if (!hold.ok) return hold;
      const page = [];
      for (const role of R.EXPEDITION_ROLES) {
        const l = fleetRepository.listFleetsByFaction(db, factionId, { states: ["IDLE"], role, limit: C.fleetScanMax });
        if (!l.ok) return l;
        page.push(...l.fleets);
      }
      page.sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
      const fleets = [];
      for (const f of page.slice(0, C.fleetScanMax)) {
        if (heldFleets.has(f.fleetId) || hold.holds(f)) continue;
        const jumpMs = jumpMsOf(f);
        if (jumpMs === null) continue;
        fleetRecords.set(f.fleetId, f);
        fleets.push({ fleetId: f.fleetId, version: f.version, systemId: f.currentSystemId, state: f.state,
          fleetRole: f.fleetRole, refitPending: f.refitPending === true, operationId: f.operationId,
          composition: f.composition, jumpMs });
      }
      factions.push({ factionId, openCount: c.count, fleets });
    }
    return { ok: true, openTotal: total.count, occupiedSystems: new Set(occ.systems), factions, fleetRecords };
  }

  function expeditionInTx(db, etx, k, expeditionId, at, c) {
    const total = expeditions.countOpen(db, {});
    if (!total.ok) return total;
    if (total.count >= C.maxActiveExpeditions) return { ok: false, reason: "LIMIT" };
    const own = expeditions.countOpen(db, { factionId: c.factionId });
    if (!own.ok) return own;
    if (own.count >= C.maxActiveExpeditionsPerFaction) return { ok: false, reason: "FACTION_LIMIT" };
    const op = fleetRepository.createOperation(db, { operationType: R.OPERATION_TYPE, factionId: c.factionId,
      originSystemId: c.originSystemId, targetSystemId: c.systemId, objective: R.OBJECTIVE_OUT,
      dueAt: c.evacuateAt + C.stepRecheckMs, fleets: [{ fleetId: c.fleetId, expectedVersion: c.fleetVersion }] },
    `${k}:op`);
    if (!op.ok) return op;
    if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:op` };
    const planned = travel.planInTx(db, { fleetId: c.fleetId, targetSystemId: c.systemId, at,
      constraints: wormholeConstraintsOf(c.minJumpMass) }, `${k}:plan`, { chained: true });
    if (!planned || planned.ok !== true) return planned || { ok: false, reason: "PLAN_FAILED" };
    if (planned.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:plan` };
    if (c.evacuateAt - planned.arriveAt < C.expeditionMinMs) return { ok: false, reason: "EXPEDITION_TOO_SHORT" };
    const created = expeditions.createExpedition(db, { expeditionId, factionId: c.factionId, fleetId: c.fleetId,
      operationId: op.operationId, originSystemId: c.originSystemId, systemId: c.systemId,
      entryPairKey: c.entryPairKey, seed: c.seed, plannedAt: at, arriveAt: planned.arriveAt, evacuateAt: c.evacuateAt,
      detail: { jumps: planned.jumps, durationMs: c.durationMs, etaMs: c.etaMs } }, k);
    if (!created.ok) return created;
    if (created.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: k };
    const e = scheduler.enqueue(S.STEP_EVENT, expeditionId, planned.arriveAt, { expeditionId, stepSeq: 0, round: 0 },
      S.stepKey(expeditionId, 0), { tx: etx, chained: true });
    if (!e || e.ok !== true) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", stage: "step" };
    return { ok: true, expeditionId, factionId: c.factionId, fleetId: c.fleetId, systemId: c.systemId,
      operationId: op.operationId, arriveAt: planned.arriveAt, evacuateAt: c.evacuateAt };
  }

  function planOneEffect(etx, round, at, c) {
    const k = S.expKey(round, c.factionId);
    const seen = journal.findByKey(etx, k);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, duplicate: true };
    const expeditionId = ids.next("wx");
    const r = journal.applyOnce(etx, { key: k, aggregate: { type: S.AGGREGATE, id: expeditionId },
      eventType: "WH_EXPEDITION_PLANNED", payload: { round, factionId: c.factionId, fleetId: c.fleetId,
        systemId: c.systemId, entryPairKey: c.entryPairKey, seed: c.seed, durationMs: c.durationMs } },
    (db) => expeditionInTx(db, etx, k, expeditionId, at, c));
    if (r.ok) return r.duplicate ? { ok: true, duplicate: true } : { ok: true, created: r.value };
    if (r.reason === "APPLY_REFUSED") {
      const why = String((r.refusal && r.refusal.reason) || "REFUSED");
      if (R.RETRYABLE_REASONS.includes(why)) return { ok: false, reason: why };
      return { ok: true, refused: why };
    }
    return { ok: true, refused: `${r.reason || "APPLY_FAILED"}${r.error ? `: ${messageOf(r.error)}` : ""}` };
  }

  function prune(etx, at) {
    const before = at - C.endedRetentionMs;
    if (before <= 0) return 0;
    const pr = expeditions.pruneEnded(etx, { before, limit: C.pruneMaxRows });
    return pr.ok ? pr.pruned : 0;
  }

  function planEffect(etx, round, at, plan) {
    const out = { ok: true, created: [], refused: [], duplicates: 0, pruned: 0 };
    for (const c of plan.plans) {
      const r = planOneEffect(etx, round, at, c);
      if (!r.ok) return r;
      if (r.created) out.created.push(r.created);
      else if (r.duplicate) out.duplicates += 1;
      else out.refused.push(r.refused);
    }
    out.pruned = prune(etx, at);
    return out;
  }

  function nextPlan(at) {
    const next = roundOf(at);
    return { eventType: S.PLAN_EVENT, aggregateId: S.PLAN_AGGREGATE_ID, dueAt: next * C.planPeriodMs,
      payload: { round: next }, idempotencyKey: S.planKey(next) };
  }

  function onPlan(ev, hctx) {
    try {
      const p = parsePlanPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "EXPEDITIONS_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "EXPEDITIONS_STOPPED" };
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      if (!wormholesSynced()) {
        return { ok: true, outcome: NOT_SYNCED, reschedule: nextPlan(at), onCommitted: () => {
          bump("plans");
          lastPlanAt = at;
          skip(NOT_SYNCED);
        } };
      }
      const registry = registryNow();
      if (!registry) return { ok: false, reason: "STRATEGY_NOT_READY" };
      const graph = graphNow();
      if (!graph || typeof graph.listWormholeEdges !== "function") return { ok: false, reason: "GRAPH_NOT_READY" };
      const t0 = nowMs();
      const tx = store.transaction("expeditions.planRead", (db) => readPlan(db, registry, at));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        const reason = String((read && read.reason) || "EXPEDITIONS_READ_FAILED");
        lastRefusal = reason;
        return { ok: false, reason };
      }
      const plan = planExpeditions({ at, round: p.round, worldSeed, factions: read.factions,
        openTotal: read.openTotal, occupiedSystems: read.occupiedSystems, edges: graph.listWormholeEdges(),
        neighbors: (id) => graph.getNeighbors(id), getSystem: (id) => graph.getSystem(id) }, P);
      const ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      return { ok: true, outcome: plan.plans.length > 0 ? "PLAN" : "NO_EXPEDITION",
        effect: (etx) => planEffect(etx, p.round, at, plan),
        reschedule: nextPlan(at),
        onCommitted: (v) => {
          bump("plans");
          lastPlanAt = at;
          metric("observe", METRIC_PLAN_MS, ms);
          for (const [reason, n] of Object.entries(plan.skips)) skip(reason, n);
          if (!v) return;
          for (const why of v.refused) {
            skip(why === "LIMIT" || why === "FACTION_LIMIT" ? why : "PLAN_REFUSED");
            lastRefusal = why;
          }
          bump("pruned", v.pruned);
          if (v.created.length > 0) {
            bump("planned", v.created.length);
            setOpen(read.openTotal + v.created.length);
            for (const c of v.created) {
              log(`expeditions: ${c.expeditionId} faction=${c.factionId} fleet=${c.fleetId} system=${c.systemId} `
                + `arrive=${c.arriveAt} evacuate=${c.evacuateAt}`);
            }
          } else setOpen(read.openTotal);
        } };
    } catch (err) {
      return { ok: false, reason: `EXPEDITIONS_PLAN_FAILED: ${messageOf(err)}` };
    }
  }

  function readStep(db, expeditionId) {
    const g = expeditions.getExpedition(db, expeditionId);
    if (!g.ok) return g;
    if (!g.expedition) return { ok: true, expedition: null, fleet: null };
    const f = fleetRepository.getFleet(db, g.expedition.fleetId);
    if (!f.ok) return f;
    return { ok: true, expedition: g.expedition, fleet: f.fleet };
  }

  function routeOutOf(graph, exp, fleet, isJSpace) {
    const held = Boolean(fleet) && fleet.state === "PLANNED" && typeof exp.holdOperationId === "string"
      && fleet.operationId === exp.holdOperationId;
    if (!fleet || !(PARKED.includes(fleet.state) || held) || !isJSpace(fleet.currentSystemId)) return null;
    const here = fleet.currentSystemId;
    const constraints = wormholeConstraintsOf(evacMassOf(fleet));
    for (const t of [exp.originSystemId, fleet.homeSystemId]) {
      if (!Number.isSafeInteger(t) || t === here) continue;
      const s = graph.getSystem(t);
      if (!s || !R.KSPACE_CLASSES.includes(s.secClass)) continue;
      const found = graph.findRoute(here, t, constraints);
      if (found && found.ok === true && found.jumps > 0) return { targetSystemId: t, jumps: found.jumps };
    }
    return null;
  }

  const cutOffPatch = (exp, at) => ({ ...cutOffTimesOf(exp, at, P), presencePermille: 0, stepSeq: exp.stepSeq + 1,
    watchRound: 0 });

  function unholdInTx(db, k, fleet) {
    const u = fleetRepository.transition(db, { fleetId: fleet.fleetId, expectedVersion: fleet.version, from: "PLANNED",
      to: "IDLE", patch: {} }, `${k}:unhold`);
    if (!u.ok) return u;
    if (u.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:unhold` };
    return { ok: true, version: u.version };
  }

  function evacuateInTx(db, k, exp, fleet, d, at) {
    const eta = jumpMsOf(fleet);
    if (eta === null) return { ok: false, reason: "ETA_UNKNOWN" };
    const target = d.routeOut.targetSystemId;
    const r = journal.applyOnce(db, { key: `${k}:evac`, aggregate: { type: S.AGGREGATE, id: exp.expeditionId },
      eventType: "WH_EXPEDITION_EVACUATED", payload: { expeditionId: exp.expeditionId, evacSeq: exp.evacSeq + 1,
        targetSystemId: target } }, (sdb) => {
      let version = fleet.version;
      if (d.unhold === true) {
        const u = unholdInTx(sdb, k, fleet);
        if (!u.ok) return u;
        version = u.version;
      }
      const hc = closeHoldInTx(sdb, k, exp, HOLD_REASON.UNHOLD);
      if (!hc.ok) return hc;
      const op = fleetRepository.createOperation(sdb, { operationType: R.OPERATION_TYPE, factionId: exp.factionId,
        originSystemId: fleet.currentSystemId, targetSystemId: target, objective: R.OBJECTIVE_RETURN,
        dueAt: at + d.routeOut.jumps * eta, fleets: [{ fleetId: fleet.fleetId, expectedVersion: version }] },
      `${k}:evac:op`);
      if (!op.ok) return op;
      if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:evac:op` };
      const planned = travel.planInTx(sdb, { fleetId: fleet.fleetId, targetSystemId: target, at,
        constraints: wormholeConstraintsOf(evacMassOf(fleet)) }, `${k}:evac:plan`, { chained: true });
      if (!planned || planned.ok !== true) return planned || { ok: false, reason: "PLAN_FAILED" };
      if (planned.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:evac:plan` };
      const t = expeditions.transitionExpedition(sdb, { expeditionId: exp.expeditionId, expectedVersion: exp.version,
        from: exp.state, to: "EVACUATING", at, patch: { returnOperationId: op.operationId, evacSeq: exp.evacSeq + 1,
          presencePermille: 0, stepSeq: exp.stepSeq + 1, watchRound: 0 } });
      if (!t.ok) return t;
      return { ok: true, arriveAt: planned.arriveAt, operationId: op.operationId };
    });
    if (r.ok && !r.duplicate) return { ok: true, evacuated: true, nextAt: r.value.arriveAt };
    if (r.ok) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:evac` };
    const why = r.reason === "APPLY_REFUSED" ? String((r.refusal && r.refusal.reason) || "REFUSED") : null;
    if (why !== null && R.EVAC_ROUTE_REFUSALS.includes(why)) return { ok: true, cut: why };
    if (why !== null) return r.refusal || { ok: false, reason: why };
    return { ok: false, reason: r.reason || "APPLY_FAILED", detail: r.error ? messageOf(r.error) : undefined };
  }

  function releaseDepartureInTx(db, k, exp, fleet, d) {
    const out = { ok: true, released: false, closed: false };
    if (fleet && fleet.operationId === exp.operationId && RELEASE_FLEET_STATES.includes(fleet.state)) {
      const u = fleetRepository.transition(db, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: fleet.state, to: "IDLE", patch: {} }, `${k}:release`);
      if (!u.ok) return u;
      if (u.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:release` };
      out.released = true;
    }
    const c = closeOperationInTx(db, `${k}:close`, exp.operationId, d.reason);
    if (!c.ok) return c;
    out.closed = c.closed;
    return out;
  }

  function closeOperationInTx(db, key, operationId, reason) {
    const none = { ok: true, closed: false };
    if (typeof operationId !== "string" || operationId === "") return none;
    const g = fleetRepository.getOperation(db, operationId);
    if (!g.ok) return g;
    const op = g.operation;
    if (!op || !OPEN_OPERATION_STATES.includes(op.state)) return none;
    const c = fleetRepository.transitionOperation(db, { operationId: op.operationId, expectedVersion: op.version,
      from: op.state, to: "CANCELLED", result: { closedBy: CLOSED_BY, reason } }, key);
    if (!c.ok) return c.reason === "OPERATION_HAS_FLEETS" ? none : c;
    if (c.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
    return { ok: true, closed: true };
  }

  const closeHoldInTx = (db, k, exp, reason) => closeOperationInTx(db, `${k}:holdclose`, exp.holdOperationId, reason);

  function holdInTx(db, k, exp, fleet, decisionAt) {
    const old = closeHoldInTx(db, k, exp, HOLD_REASON.REHOLD);
    if (!old.ok) return old;
    const here = fleet.currentSystemId;
    const op = fleetRepository.createOperation(db, { operationType: R.OPERATION_TYPE, factionId: exp.factionId,
      originSystemId: here, targetSystemId: here, objective: R.OBJECTIVE_HOLD, dueAt: decisionAt,
      fleets: [{ fleetId: fleet.fleetId, expectedVersion: fleet.version }] }, `${k}:hold`);
    if (!op.ok) return op;
    if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:hold` };
    return { ok: true, operationId: op.operationId };
  }

  function stepInTx(db, etx, k, exp, fleet, d, at) {
    const id = exp.expeditionId;
    const seq = exp.stepSeq;
    let action = d.action;
    let reason = d.reason || null;
    let nextAt = d.nextAt;
    let nextKey = null;
    let payload = null;
    let r;
    let decisionAt = null;
    let operationId = null;
    let hold = d.hold === true;
    if (action === "EVACUATE") {
      const ev = evacuateInTx(db, k, exp, fleet, d, at);
      if (!ev.ok) return ev;
      if (ev.evacuated) {
        nextAt = ev.nextAt;
        r = { ok: true };
        nextKey = S.stepKey(id, seq + 1);
        payload = { expeditionId: id, stepSeq: seq + 1, round: 0 };
      } else if (exp.state === "CUT_OFF") {
        action = PARKED.includes(fleet.state) ? "HOLD" : "WAIT";
        reason = ev.cut;
        nextAt = at >= exp.decisionAt ? at + C.cutOffRecheckMs : cutOffNextAt(at, exp.decisionAt, P);
      } else {
        action = "CUT_OFF";
        reason = ev.cut;
        hold = PARKED.includes(fleet.state);
        nextAt = cutOffNextAt(at, cutOffTimesOf(exp, at, P).decisionAt, P);
      }
    }
    if (action === "ACTIVATE") {
      r = expeditions.transitionExpedition(db, { expeditionId: id, expectedVersion: exp.version, from: "PLANNED",
        to: "ACTIVE", at, patch: { activeFrom: at, presencePermille: d.presence, stepSeq: seq + 1, watchRound: 0 } });
      nextKey = S.stepKey(id, seq + 1);
      payload = { expeditionId: id, stepSeq: seq + 1, round: 0 };
    } else if (action === "KEEP") {
      r = expeditions.watchExpedition(db, { expeditionId: id, expectedVersion: exp.version, state: "ACTIVE",
        stepSeq: seq + 1, watchRound: 0, presencePermille: d.presence, at });
      nextKey = S.stepKey(id, seq + 1);
      payload = { expeditionId: id, stepSeq: seq + 1, round: 0 };
    } else if (action === "WAIT") {
      const round = exp.watchRound + 1;
      r = expeditions.watchExpedition(db, { expeditionId: id, expectedVersion: exp.version, state: exp.state,
        stepSeq: seq, watchRound: round, presencePermille: exp.presencePermille, at });
      nextKey = S.waitKey(id, seq, round);
      payload = { expeditionId: id, stepSeq: seq, round };
    } else if (action === "CUT_OFF") {
      const patch = cutOffPatch(exp, at);
      decisionAt = patch.decisionAt;
      if (hold) {
        const h = holdInTx(db, k, exp, fleet, decisionAt);
        if (!h.ok) return h;
        operationId = h.operationId;
        patch.holdOperationId = h.operationId;
      }
      r = expeditions.transitionExpedition(db, { expeditionId: id, expectedVersion: exp.version, from: exp.state,
        to: "CUT_OFF", at, patch });
      nextKey = S.stepKey(id, seq + 1);
      payload = { expeditionId: id, stepSeq: seq + 1, round: 0 };
    } else if (action === "HOLD") {
      const h = holdInTx(db, k, exp, fleet, exp.decisionAt);
      if (!h.ok) return h;
      operationId = h.operationId;
      r = expeditions.transitionExpedition(db, { expeditionId: id, expectedVersion: exp.version, from: "CUT_OFF",
        to: "CUT_OFF", at, patch: { holdOperationId: h.operationId, stepSeq: seq + 1, watchRound: 0 } });
      nextKey = S.stepKey(id, seq + 1);
      payload = { expeditionId: id, stepSeq: seq + 1, round: 0 };
    } else if (action === "WRITE_OFF") {
      let version = fleet.version;
      if (d.unhold === true) {
        const u = unholdInTx(db, k, fleet);
        if (!u.ok) return u;
        version = u.version;
      }
      const w = fleetRepository.disband(db, { fleetId: fleet.fleetId, expectedVersion: version,
        systemId: fleet.currentSystemId, fleetRole: fleet.fleetRole, allowRefitPending: true }, `${k}:writeoff`);
      if (!w.ok) return w;
      if (w.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:writeoff` };
      const hc = closeHoldInTx(db, k, exp, HOLD_REASON.WRITTEN_OFF);
      if (!hc.ok) return hc;
      r = expeditions.transitionExpedition(db, { expeditionId: id, expectedVersion: exp.version, from: "CUT_OFF",
        to: "ENDED", at, patch: { outcome: d.outcome, endReason: d.reason, endedAt: at, presencePermille: 0 } });
    } else if (action === "END") {
      if (d.outcome === "CANCELLED") {
        const rel = releaseDepartureInTx(db, k, exp, fleet, d);
        if (!rel.ok) return rel;
      }
      if (exp.state === "CUT_OFF") {
        const hc = closeHoldInTx(db, k, exp, d.reason);
        if (!hc.ok) return hc;
      }
      r = expeditions.transitionExpedition(db, { expeditionId: id, expectedVersion: exp.version, from: exp.state,
        to: "ENDED", at, patch: { outcome: d.outcome, endReason: d.reason, endedAt: at, presencePermille: 0 } });
    }
    if (!r || !r.ok) return r || { ok: false, reason: "UNKNOWN_ACTION" };
    if (nextKey !== null) {
      const e = scheduler.enqueue(S.STEP_EVENT, id, nextAt, payload, nextKey, { tx: etx, chained: true });
      if (!e || e.ok !== true) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", stage: "step" };
    }
    const ends = action === "END" || action === "WRITE_OFF";
    return { ok: true, expeditionId: id, action, reason, outcome: ends ? d.outcome : null,
      recovered: action === "EVACUATE" && d.reason === "RECOVERED", nextAt: nextKey !== null ? nextAt : null,
      held: action === "HOLD" || (action === "CUT_OFF" && operationId !== null),
      decisionAt, operationId, fleetId: fleet ? fleet.fleetId : null, systemId: fleet ? fleet.currentSystemId : null,
      cutOffAt: exp.cutOffAt };
  }

  function stepEffect(etx, ev, p, exp, fleet, d) {
    const k = ev.idempotencyKey;
    const r = journal.applyOnce(etx, { key: `${k}:apply`, aggregate: { type: S.AGGREGATE, id: exp.expeditionId },
      eventType: "WH_EXPEDITION_STEPPED", payload: { expeditionId: p.expeditionId, stepSeq: p.stepSeq,
        round: p.round } }, (db) => stepInTx(db, etx, k, exp, fleet, d, ev.dueAt));
    if (r.ok) return r.duplicate ? { ok: true, applied: false, action: "DUPLICATE" } : { ok: true, applied: true,
      ...r.value };
    if (r.reason === "APPLY_REFUSED") {
      const why = String((r.refusal && r.refusal.reason) || "REFUSED");
      if (why === "VERSION_CONFLICT" && r.refusal.expeditionId === exp.expeditionId) {
        return { ok: true, applied: false, action: "STALE" };
      }
      return r.refusal || { ok: false, reason: why };
    }
    return { ok: false, reason: r.reason || "APPLY_FAILED", detail: r.error ? messageOf(r.error) : undefined };
  }

  function onStep(ev) {
    try {
      const p = parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "EXPEDITIONS_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "EXPEDITIONS_STOPPED" };
      if (!wormholesSynced()) {
        bump("syncDeferred");
        return { ok: false, reason: SYNC_PENDING, deferUntil: clock.now() + C.syncWaitMs };
      }
      const graph = graphNow();
      if (!graph || typeof graph.findRoute !== "function") return { ok: false, reason: "GRAPH_NOT_READY" };
      const tx = store.transaction("expeditions.stepRead", (db) => readStep(db, p.expeditionId));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "EXPEDITIONS_READ_FAILED") };
      }
      const exp = read.expedition;
      if (!exp || exp.stepSeq !== p.stepSeq || exp.watchRound !== p.round) return { ok: true, outcome: "STALE" };
      const isJSpace = isJSpaceIn(graph);
      const routeOut = routeOutOf(graph, exp, read.fleet, isJSpace);
      const d = decideExpeditionStep(exp, read.fleet, { at: ev.dueAt, isJSpace, routeOut, stepSeq: p.stepSeq,
        round: p.round }, P);
      if (d.action === "STALE") return { ok: true, outcome: "STALE" };
      const dd = d.action === "EVACUATE" ? { ...d, routeOut } : d;
      return { ok: true, outcome: d.action,
        effect: (etx, event) => stepEffect(etx, event, p, exp, read.fleet, dd),
        onCommitted: (v) => {
          if (!v || v.applied !== true) return;
          if (v.action === "ACTIVATE") bump("activated");
          if (v.action === "EVACUATE") {
            bump("evacuated");
            if (v.recovered) bump("recovered");
          }
          if (v.action === "CUT_OFF") {
            bump("cutOff");
            log(`expeditions: ${v.expeditionId} CUT_OFF ${v.reason} decision=${v.decisionAt}`);
          }
          if (v.held) bump("held");
          if (v.outcome) {
            bump(END_COUNTER[v.outcome]);
            setOpen(openCount - 1);
            if (v.action === "WRITE_OFF") {
              bump("writtenOff");
              log(`expeditions: ${v.expeditionId} fleet ${v.fleetId} written off in ${v.systemId} after cut-off since `
                + `${v.cutOffAt}`);
            } else log(`expeditions: ${v.expeditionId} ${v.outcome} ${v.reason}`);
          }
        } };
    } catch (err) {
      return { ok: false, reason: `EXPEDITIONS_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (stopped()) return { ok: false, reason: "EXPEDITIONS_STOPPED" };
      const round = roundOf(clock.now());
      const r = scheduler.enqueue(S.PLAN_EVENT, S.PLAN_AGGREGATE_ID, round * C.planPeriodMs, { round },
        S.planKey(round));
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      return { ok: true, duplicate: r.duplicate === true, round };
    } catch (err) {
      return { ok: false, reason: `EXPEDITIONS_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function reconcile() {
    const out = { ok: true, enqueued: 0, open: 0, exhausted: 0, refused: 0, lastError: null };
    try {
      if (stopped()) return { ok: false, reason: "EXPEDITIONS_STOPPED" };
      const l = store.transaction("expeditions.reconcileRead",
        (db) => expeditions.listOpen(db, { limit: C.reconcileMaxExpeditions }));
      const read = l.ok ? l.value : l;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "EXPEDITIONS_READ_FAILED") };
      }
      const now = clock.now();
      for (const exp of read.expeditions) {
        try {
          const seq = exp.stepSeq;
          const dueKey = exp.watchRound > 0 ? S.waitKey(exp.expeditionId, seq, exp.watchRound)
            : S.stepKey(exp.expeditionId, seq);
          const slot = nextReconcileKey(scheduler, { dueKey, baseKey: S.recBaseKey(exp.expeditionId, seq),
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
          const e = scheduler.enqueue(S.STEP_EVENT, exp.expeditionId, now, { expeditionId: exp.expeditionId,
            stepSeq: seq, round: exp.watchRound }, slot.key);
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
    } catch (err) {
      return { ok: false, reason: `EXPEDITIONS_RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped() ? "off" : "ready", counters: Object.freeze({ ...counters }),
      open: openCount, lastPlanAt, skipByReason: Object.freeze({ ...skipByReason }), lastRefusal });
  }

  function listOpen(opts) {
    try {
      const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit
        : C.reconcileMaxExpeditions;
      const l = store.transaction("expeditions.listOpen", (db) => expeditions.listOpen(db, { limit,
        afterId: opts && typeof opts.afterId === "string" ? opts.afterId : undefined }));
      return l.ok ? l.value : { ok: false, reason: String(l.reason || "EXPEDITIONS_READ_FAILED") };
    } catch (err) {
      return { ok: false, reason: `EXPEDITIONS_READ_FAILED: ${messageOf(err)}` };
    }
  }

  function readPanel() {
    try {
      const t = store.transaction("expeditions.panel", (db) => {
        const o = expeditions.listOpen(db, { limit: PANEL_OPEN_ROWS });
        if (!o.ok) return o;
        const e = expeditions.listEnded(db, { limit: PANEL_ENDED_ROWS });
        if (!e.ok) return e;
        return { ok: true, open: o.expeditions, ended: e.expeditions, openTruncated: o.nextAfter !== null };
      });
      const v = t.ok ? t.value : t;
      return v && v.ok === true ? v : { ok: false, reason: String((v && v.reason) || "EXPEDITIONS_READ_FAILED") };
    } catch (err) {
      return { ok: false, reason: `EXPEDITIONS_READ_FAILED: ${messageOf(err)}` };
    }
  }

  return Object.freeze({
    onPlan,
    onStep,
    bootstrap,
    reconcile,
    getStatus,
    listOpen,
    readPanel,
    setOpen,
    getMode: () => (stopped() ? "off" : "ready"),
    stop() {
      state = "stopped";
    },
    isStopped: stopped,
  });
}

module.exports = { createExpeditionService, parsePlanPayload, parseStepPayload, paramsOf, COUNTERS, PANEL_OPEN_ROWS,
  PANEL_ENDED_ROWS };
