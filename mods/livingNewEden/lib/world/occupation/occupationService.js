"use strict";

const { performance } = require("node:perf_hooks");
const { bfs } = require("../../strategy/ai/bfs");
const { strengthOf } = require("../../strategy/ai/strength");
const { EVASIVE_ROLES } = require("../../battle/data/contactRules");
const { parseFleetRoleList } = require("../../fleets/schema");
const S = require("./schema");
const M = require("./machine");
const { effectiveScores, planInfluenceDrop } = require("./influenceRules");
const { anchoredOf } = require("./adjacency");
const { estimateProgress } = require("./progress");
const { getCoreIndex, coreSystemIds, coreStationIds, auditCores, CORE_PROTECTED } = require("../core");
const SOV = require("../sovStructures/schema");
const B = require("../bastions/schema");

const SOV_UNFUNDED = SOV.UNFUNDED_TREASURY_REASONS;
const SOV_NOTE_UNFUNDED = SOV.NOTES.ANCHOR_UNFUNDED;

const SCHEDULER_READY = "ready";
const STATION_ONLINE = "ONLINE";
const AGGREGATE = "world_system";
const MAX_DETAIL = 120;
const MS_DECIMALS = 100;
const BASTION_RELEASE_ROLE = "invasion";
const STATION_LIMIT_REASONS = Object.freeze(["SYSTEM_FACTION_STATION_LIMIT", "FACTION_STATION_LIMIT"]);

function mergeMin(a, b) {
  const out = new Map(a);
  for (const [id, jumps] of b) {
    const prev = out.get(id);
    if (prev === undefined || jumps < prev) out.set(id, jumps);
  }
  return out;
}
const COUNTER_NAMES = Object.freeze(["signals", "signalNoop", "signalRefused", "evals", "stale", "deferred",
  "truncated", "transitions", "controllerChanged", "interrupted", "battleApplied", "battleNoRow", "garrisonAssigned",
  "garrisonRefused", "detachedMarked", "abandoned", "bootstrapEnqueued", "bootstrapDuplicates", "evalRefused",
  "stableDrift", "homeReclaimed", "coreProtected", "coreUnwind",
  "battleNonOccupierWinner",
  "playerRepelEvals", "playerRepelInterrupted",
  "adjacencyBlocked", "adjacencyUnwind", "adjacencyUnknown",
  "cannotOccupy",
  "battleBastionFrozen"]);
const PARAM_KEYS = Object.freeze(["evalIntervalMs", "idleEvalIntervalMs", "maxActiveSystems", "maxFleetsReadPerEval",
  "reconTimeoutMs", "contestTimeoutMs", "invasionHoldMs", "occupiedSettleMs", "consolidateMs", "invasionMinScore",
  "occupyMinScore", "occupyMaxDefenderScore", "stableMinScore", "stableMaxResidualScore", "battleWinPoints",
  "battleLossPoints", "holdPointsPerHour", "stationPointsPerHour", "stationBonusCap", "decayPointsPerHour",
  "requireNoDefenderStations", "garrisonFleetsTarget", "detachedUpkeepStep", "detachedUpkeepPeriodMs",
  "detachedUpkeepMaxFactor", "stableBaselineScore", "stableRecoverPointsPerHour", "stableForeignDecayPointsPerHour",
  "stableForeignFloorScore"]);
const TICK_KEYS = Object.freeze(["systemId", "seq", "trigger"]);
const BATTLE_KEYS = Object.freeze(["systemId", "seq", "trigger", "battleId", "winnerFactionId", "loserFactionId",
  "at"]);
const REPEL_KEYS = Object.freeze(["systemId", "seq", "trigger", "huntId", "loserFactionId", "at"]);
const MAX_SOURCE_ID_LENGTH = 96;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parsePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const keys = Object.keys(p).sort();
  if (!isId(p.systemId) || !isTime(p.seq)) return null;
  if (p.trigger === S.TRIGGER_TICK) {
    return keys.join() === [...TICK_KEYS].sort().join() ? { systemId: p.systemId, seq: p.seq, trigger: p.trigger }
      : null;
  }
  if (p.trigger === S.TRIGGER_REPEL) {
    if (keys.join() !== [...REPEL_KEYS].sort().join()) return null;
    if (typeof p.huntId !== "string" || p.huntId === "" || p.huntId.length > MAX_SOURCE_ID_LENGTH) return null;
    return isId(p.loserFactionId) && isTime(p.at) ? { ...p } : null;
  }
  if (p.trigger !== S.TRIGGER_BATTLE || keys.join() !== [...BATTLE_KEYS].sort().join()) return null;
  if (typeof p.battleId !== "string" || p.battleId === "" || !isTime(p.at)) return null;
  for (const k of ["winnerFactionId", "loserFactionId"]) if (p[k] !== null && !isId(p[k])) return null;
  return { ...p };
}

function createOccupationService(deps) {
  const { store, repository, fleets, scheduler, clock, config } = deps;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const coreIndex = deps.coreIndex || getCoreIndex(config);
  const nonOccupiers = deps.nonOccupierFactionIds instanceof Set ? deps.nonOccupierFactionIds : new Set();
  const params = Object.freeze({ ...Object.fromEntries(PARAM_KEYS.map((k) => [k, config.occupation[k]])),
    maxFactionsPerSystem: config.world.maxFactionsPerSystem,
    garrisonFromRoles: parseFleetRoleList(config.occupation.garrisonFromRoles) || Object.freeze([]),
    adjacencyGate: config.occupation.adjacencyGateEnabled === true
      && config.strategy.captureRequiresAdjacency === true,
    canOccupyGate: config.occupation.canOccupyGateEnabled === true });
  const captureJumps = Math.max(0, Math.min(config.strategy.captureRangeFromStationJumps, config.graph.routeMaxJumps));
  const maxBfsSystems = config.strategy.maxBfsSystems;
  const routeMaxJumps = config.graph.routeMaxJumps;
  const neighborFns = new WeakMap();
  const neighborsFor = (graph) => {
    let fn = neighborFns.get(graph);
    if (!fn) {
      fn = (id) => graph.getNeighbors(id);
      fn.bfsMemo = new Map();
      fn.bfsMemoMax = Number.isSafeInteger(config.strategy.bfsMemoMaxEntries) ? config.strategy.bfsMemoMaxEntries : 0;
      fn.bfsMemoMaxSystems = Number.isSafeInteger(config.strategy.bfsMemoMaxSystems)
        ? config.strategy.bfsMemoMaxSystems : 0;
      neighborFns.set(graph, fn);
    }
    return fn;
  };
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let stopped = false;
  let seq = 0;
  let lastRefusal = null;
  let stationAuditDone = false;

  let onControllerChangedCallback = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    seq += 1;
    metric("count", `world.occupation.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function currentGraph() {
    const g = deps.graph;
    const r = call(() => (g && typeof g.getGraph === "function" ? g.getGraph() : null), null);
    return r && r.ok === true && r.graph ? r.graph : null;
  }

  function stationsService() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const mode = st && typeof st.getMode === "function" ? call(() => st.getMode(), "off") : "off";
    if (mode === "ready" && st.repository) return { st, mode };
    return { st, mode: mode === "pending" ? "pending" : "off" };
  }

  function sovService() {
    const sv = typeof deps.getSovStructures === "function" ? call(deps.getSovStructures, null) : null;
    return sv && typeof sv.readForOccupationInTx === "function" ? sv : null;
  }

  function playerSiegeService() {
    const ps = typeof deps.getPlayerSovSiege === "function" ? call(deps.getPlayerSovSiege, null) : null;
    return ps && typeof ps.readForOccupationInTx === "function" && typeof ps.applyOpsInTx === "function" ? ps : null;
  }

  function captureAnchorsOf(tx, factionId, st) {
    const anchors = [];
    if (st && st.repository && typeof st.repository.listStationsOfFaction === "function") {
      const own = st.repository.listStationsOfFaction(tx, factionId, { states: [STATION_ONLINE] });
      if (own.ok) {
        for (const x of own.records) if (isId(x.systemId)) anchors.push({ systemId: x.systemId, jumps: captureJumps });
      }
    }
    if (typeof deps.footholdsOf === "function") {
      const extra = deps.footholdsOf(tx, factionId);
      if (!extra || !extra.ok) return extra || { ok: false, reason: "CAPTURE_ANCHORS_FAILED" };
      for (const fh of extra.footholds) if (isId(fh.systemId)) anchors.push({ systemId: fh.systemId, jumps: Math.min(fh.jumps, routeMaxJumps) });
    }
    const bySystem = new Map();
    for (const a of anchors) {
      const prev = bySystem.get(a.systemId);
      if (prev === undefined || a.jumps < prev.jumps) bySystem.set(a.systemId, a);
    }
    return { ok: true, anchors: [...bySystem.values()].sort((a, b) => a.systemId - b.systemId) };
  }

  function readView(tx, systemId, at, extraFactions, reachMemo, opts) {
    const got = repository.getSystem(tx, systemId, { includeInfluence: true });
    if (!got.ok) return got;
    const sys = got.system;
    if (!sys) return { ok: true, system: null };
    const fl = fleets.repository.listFleetsInSystem(tx, systemId, { limit: params.maxFleetsReadPerEval + 1,
      states: [...S.STANDING_FLEET_STATES] });
    if (!fl.ok) return fl;
    const presenceTruncated = fl.fleets.length > params.maxFleetsReadPerEval;
    const presence = new Map();
    const engaging = new Set();
    for (const f of fl.fleets.slice(0, params.maxFleetsReadPerEval)) {
      if (nonOccupiers.has(f.factionId)) continue;
      const p = presence.get(f.factionId) || { strength: 0, fleets: [] };
      p.strength += strengthOf(f.composition, deps.powerTable);
      p.fleets.push({ fleetId: f.fleetId, version: f.version, state: f.state, fleetRole: f.fleetRole,
        refitPending: f.refitPending === true });
      if (!EVASIVE_ROLES.includes(f.fleetRole)) engaging.add(f.factionId);
      presence.set(f.factionId, p);
    }
    for (const f of [...presence.keys()]) if (!engaging.has(f)) presence.delete(f);
    const { st, mode } = stationsService();
    const graph = currentGraph();
    const stations = new Map();
    const range = new Map();
    let beltUnknown = false;

    function computeReach(factionId) {
      if (!graph) return null;
      const own = captureAnchorsOf(tx, factionId, st);
      if (!own.ok) return null;
      const anchors = own.anchors || [];
      if (anchors.length === 0) return null;

      const groups = new Map();
      for (const a of anchors) {
        const j = a.jumps;
        if (!groups.has(j)) groups.set(j, []);
        groups.get(j).push(a.systemId);
      }

      let mergedReach = new Map();
      for (const [jumps, starts] of groups) {
        if (starts.length === 0 || !(jumps >= 0)) continue;
        const bfsResult = bfs(starts, neighborsFor(graph), { maxJumps: jumps, maxSystems: maxBfsSystems });
        mergedReach = mergeMin(mergedReach, bfsResult);
      }
      return mergedReach;
    }

    function reachOf(factionId) {
      if (!(reachMemo instanceof Map)) return computeReach(factionId);
      if (!reachMemo.has(factionId)) reachMemo.set(factionId, computeReach(factionId));
      return reachMemo.get(factionId);
    }

    function computeInRange(factionId) {
      const reach = reachOf(factionId);
      if (reach === null) return false;
      let inRange = reach.has(systemId);

      if (!inRange && typeof deps.getCaptureBelt === "function") {
        const belt = call(() => deps.getCaptureBelt(factionId), null);
        if (!belt || belt.ok !== true) beltUnknown = true;
        else {
          inRange = belt.mode === "ready" && belt.captures === true && belt.reach instanceof Map
            && belt.reach.has(systemId);
        }
      }
      return inRange;
    }

    const extraAsked = (extraFactions || []).filter(isId);
    if (extraAsked.length > 0) {
      for (const f of [...new Set(extraAsked)]) {
        range.set(f, computeInRange(f));
      }
    }
    if (mode === "ready") {
      const c = st.repository.countLiveBySystem(tx, [systemId]);
      if (!c.ok) return c;
      for (const r of c.rows) stations.set(r.factionId, (stations.get(r.factionId) || 0) + r.count);
      const asked = [sys.controllerFactionId, sys.occupierFactionId, ...(extraFactions || [])].filter(isId);
      for (const f of [...new Set(asked)]) {
        if (range.has(f)) continue;
        range.set(f, computeInRange(f));
      }
    }
    let sov = null;
    if (opts && opts.sov === true) {
      const sv = sovService();
      if (sv !== null) {
        const sr = call(() => sv.readForOccupationInTx(tx, systemId), null);
        if ((!sr || sr.ok !== true) && opts.sovSoft !== true) return sr || { ok: false, reason: "SOV_READ_FAILED" };
        if (sr && sr.ok === true && sr.sov) {
          sov = Object.freeze({ ...sr.sov,
            needs: (f) => (typeof deps.needsSovStructureOf === "function"
              ? call(() => deps.needsSovStructureOf(f) !== false, true) : true) });
        }
      }
    }
    let playerClaim = null;
    if (opts && opts.sov === true) {
      const ps = playerSiegeService();
      if (ps !== null) {
        const pr = call(() => ps.readForOccupationInTx(tx, systemId, at), null);
        if ((!pr || pr.ok !== true) && opts.sovSoft !== true) {
          return pr || { ok: false, reason: "PLAYER_SOV_READ_FAILED" };
        }
        if (pr && pr.ok === true && pr.claim) playerClaim = pr.claim;
      }
    }
    const view = {
      systemId, state: sys.occupationState, controller: sys.controllerFactionId, occupier: sys.occupierFactionId,
      previousController: sys.previousControllerFactionId, sinceAt: sys.lastStateChangeAt, seq: sys.phaseSeq,
      evaluatedAt: sys.influenceEvaluatedAt, capturedAt: sys.capturedAt, detachedSinceAt: sys.detachedSinceAt,
      home: sys.homeFactionId === null ? null : sys.homeFactionId,
      coreOwner: coreIndex.enabled ? coreIndex.systems.get(systemId) ?? null : null,
      influence: new Map((sys.influence || []).map((i) => [i.factionId, { score: i.influenceScore,
        garrison: i.garrisonStrength }])),
      presence, stations, inRange: (f) => range.get(f) === true, isHostile: deps.hostility, presenceTruncated,
      deferred: mode === "pending" || (mode === "ready" && !graph), rangeKnown: mode === "ready" && !beltUnknown, at,
      consolidates: (f) => {
        const fn = deps.consolidatesOf;
        if (typeof fn !== "function") return true;
        return call(() => fn(f) !== false, true);
      },
      canOccupy: (f) => {
        const fn = deps.canOccupyOf;
        if (typeof fn !== "function") return true;
        return call(() => fn(f) !== false, true);
      },
      drawsGarrison: (f) => {
        const fn = deps.drawsGarrisonOf;
        if (typeof fn !== "function") return true;
        return call(() => fn(f) !== false, true);
      },
      captureSlowFactor: typeof deps.captureSlowFactorOf === "function"
        ? call(() => deps.captureSlowFactorOf(sys.controllerFactionId, sys.homeFactionId), 1) : 1,
      sov,
      playerClaim,
    };
    if (opts && opts.adjacency === true && params.adjacencyGate === true && view.state !== S.STABLE) {
      const adj = adjacencyMapOf(tx, view, graph, st, mode, opts.adjacencyFor);
      if (!adj.ok) return adj;
      const map = adj.map;
      view.adjacent = (f) => (map.has(f) ? map.get(f) : null);
    }
    return { ok: true, system: sys, view };
  }

  function adjacencyMapOf(tx, view, graph, st, mode, extra) {
    const map = new Map();
    const C = view.controller;
    const cands = [];
    const add = (f) => {
      if (isId(f) && f !== C && !cands.includes(f)) cands.push(f);
    };
    if (S.CLAIM_STATES.includes(view.state)) add(view.occupier);
    if (S.HELD_STATES.includes(view.state)) add(M.holderOf(view));
    for (const f of Array.isArray(extra) ? extra : []) add(f);
    if (cands.length === 0) return { ok: true, map };
    const systemId = view.systemId;
    if (!graph) {
      for (const f of cands) map.set(f, null);
      return { ok: true, map };
    }
    const nb = call(() => graph.getNeighbors(systemId), null);
    const neighbours = Array.isArray(nb) ? nb.filter(isId) : [];
    let controllers = new Map();
    if (neighbours.length > 0) {
      const got = call(() => repository.getSystems(tx, neighbours, { includeInfluence: false }), null);
      if (got && got.ok === true) {
        for (const s of got.systems) controllers.set(s.systemId, isId(s.controllerFactionId) ? s.controllerFactionId : null);
      } else controllers = null;
    }
    const stationFactions = new Map();
    if (mode === "ready") {
      const c = st.repository.countLiveBySystem(tx, [systemId, ...neighbours]);
      if (!c.ok) return c;
      for (const r of c.rows) {
        if (!(r.count > 0)) continue;
        if (!stationFactions.has(r.systemId)) stationFactions.set(r.systemId, new Set());
        stationFactions.get(r.systemId).add(r.factionId);
      }
    }
    for (const f of cands) {
      map.set(f, anchoredOf({ systemId, neighbours, controllers, stationFactions, factionId: f,
        footholds: footholdReachOf(tx, f, systemId, neighbours, graph), belt: beltOf(f) }));
    }
    return { ok: true, map };
  }

  function footholdReachOf(tx, factionId, systemId, neighbours, graph) {
    if (typeof deps.footholdsOf !== "function") return { ok: true, reach: new Set() };
    const r = call(() => deps.footholdsOf(tx, factionId), null);
    if (!r || r.ok !== true || !Array.isArray(r.footholds)) return { ok: false };
    for (const fh of r.footholds) {
      if (!fh || !isId(fh.systemId)) continue;
      const jumps = Math.min(Number.isSafeInteger(fh.jumps) ? fh.jumps : 0, routeMaxJumps);
      if (fh.systemId === systemId) return { ok: true, reach: new Set([systemId]) };
      if (jumps < 1) continue;
      if (neighbours.includes(fh.systemId)) return { ok: true, reach: new Set([systemId]) };
      if (jumps < 2) continue;
      const reach = bfs([fh.systemId], neighborsFor(graph), { maxJumps: jumps, maxSystems: maxBfsSystems });
      if (reach.has(systemId)) return { ok: true, reach: new Set([systemId]) };
    }
    return { ok: true, reach: new Set() };
  }

  function beltOf(factionId) {
    if (typeof deps.getCaptureBelt !== "function") return { ok: true, mode: "off" };
    const b = call(() => deps.getCaptureBelt(factionId), null);
    return b && b.ok === true ? b : { ok: false };
  }

  function readProgressInTx(tx, systemId, at, reachMemo) {
    try {
      const r = readView(tx, systemId, at, undefined, reachMemo, { sov: true, sovSoft: true });
      if (!r.ok) return r;
      if (!r.system) return { ok: true, system: null, progress: null };
      const view = { ...r.view, phaseDueAt: r.system.phaseDueAt };
      return { ok: true, system: r.system, progress: estimateProgress(view, params) };
    } catch (err) {
      return { ok: false, reason: "OCCUPATION_READ_FAILED", detail: messageOf(err) };
    }
  }

  function writeEvaluation(tx, sys, evaluation, key, reason) {
    if (Object.keys(evaluation.statePatch).length === 0 && evaluation.influence.length === 0) {
      return { ok: true, written: false };
    }
    const applied = repository.isApplied(tx, key);
    if (!applied.ok) return applied;
    if (applied.applied) return { ok: true, written: false, duplicate: true };
    const r = repository.applyChange(tx, { systemId: sys.systemId, expectedVersion: sys.version, reason,
      state: evaluation.statePatch, influence: evaluation.influence.map((e) => ({ ...e })) }, key);
    if (!r.ok) return r;
    return { ok: true, written: !r.duplicate };
  }

  function successorSpec(systemId, evaluation, newSeq) {
    const n = evaluation.next;
    return { dueAt: n.dueAt, payload: { systemId, seq: newSeq, trigger: S.TRIGGER_TICK },
      key: S.tickKey(systemId, newSeq, n.interval, n.bucket) };
  }

  function enqueueNext(tx, systemId, evaluation, newSeq, chained) {
    if (!evaluation.next) return { ok: true };
    const s = successorSpec(systemId, evaluation, newSeq);
    const r = scheduler.enqueue(S.EVENT_TYPE, String(systemId), s.dueAt, s.payload, s.key, { tx, chained });
    return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
  }

  function seqAfter(view, evaluation) {
    return evaluation.statePatch.phaseSeq === undefined ? view.seq : evaluation.statePatch.phaseSeq;
  }

  function onEvalCommitted(systemId, sys, out) {
    bump("evals");
    if (!out) return;
    if (out.stale) {
      bump("stale");
      return;
    }
    const ev = out.evaluation;
    if (ev.notes.includes("DEFERRED")) bump("deferred");
    if (ev.notes.includes("TRUNCATED")) bump("truncated");
    if (ev.notes.includes("INTERRUPTED")) bump("interrupted");
    if (ev.notes.includes("DETACHED")) bump("detachedMarked");
    if (ev.to !== null) bump("transitions");
    if (out.written && ev.notes.includes("HOME_RECLAIMED")) bump("homeReclaimed");
    if (ev.notes.includes("CORE_PROTECTED")) {
      bump("coreProtected");
      if (ev.to !== null) bump("coreUnwind");
    }
    if (ev.notes.includes(M.ADJACENCY_NOTES.BLOCKED)) {
      const claim = sys.occupationState === S.CONTESTED || sys.occupationState === S.INVASION;
      bump(ev.to !== null && claim ? "adjacencyUnwind" : "adjacencyBlocked");
    }
    if (ev.notes.includes(M.ADJACENCY_NOTES.UNKNOWN)) bump("adjacencyUnknown");
    if (ev.notes.includes(M.CANNOT_OCCUPY)) bump("cannotOccupy");
    bump("garrisonAssigned", out.assigned);
    bump("garrisonRefused", out.garrisonRefused);
    if (ev.controllerChanged) {
      bump("controllerChanged");
      log(`occupation: ${systemId} ${sys.controllerFactionId}->${ev.statePatch.controllerFactionId} `
        + `${ev.statePatch.occupationState} seq=${ev.statePatch.phaseSeq}`);
      if (onControllerChangedCallback) {
        try {
          onControllerChangedCallback({
            systemId,
            oldController: sys.controllerFactionId,
            newController: ev.statePatch.controllerFactionId,
            phaseSeq: ev.statePatch.phaseSeq,
            occupationState: ev.statePatch.occupationState,
          });
        } catch (_err) {
        }
      }
    }
    if (out.t0 !== undefined) metric("observe", "world.occupation.evalMs",
      Math.round((nowMs() - out.t0) * MS_DECIMALS) / MS_DECIMALS);
  }

  function handler(ev, hctx) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "OCCUPATION_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "OCCUPATION_STOPPED" };
      const read = store.transaction("occupation.evalRead", (tx) => repository.getSystem(tx, p.systemId,
        { includeInfluence: false }));
      const got = read.ok ? read.value : read;
      if (!got || !got.ok) return { ok: false, reason: (got && got.reason) || "TX_FAILED" };
      const sys = got.system;
      if (!sys) return { ok: true, outcome: "NO_ROW", onCommitted: () => bump("evals") };
      if (sys.phaseSeq !== p.seq) return { ok: true, outcome: "STALE", onCommitted: () => onEvalCommitted(p.systemId,
        sys, { stale: true }) };
      if (sys.occupationState === S.STABLE) return { ok: true, outcome: "STABLE", onCommitted: () => bump("evals") };
      const now = hctx && Number.isSafeInteger(hctx.now) ? hctx.now : clock.now();
      let trigger = { kind: "tick" };
      if (p.trigger === S.TRIGGER_BATTLE) {
        trigger = { kind: "battle", battleId: p.battleId, winnerFactionId: p.winnerFactionId,
          loserFactionId: p.loserFactionId };
      } else if (p.trigger === S.TRIGGER_REPEL) {
        trigger = { kind: M.TRIGGERS.REPEL, huntId: p.huntId, loserFactionId: p.loserFactionId };
      }
      let out = null;
      return { ok: true, outcome: "EVALUATED",
        effect: (tx) => {
          const t0 = nowMs();
          const at = p.trigger === S.TRIGGER_BATTLE || p.trigger === S.TRIGGER_REPEL ? p.at : now;
          const r = readView(tx, p.systemId, at, [], undefined, { sov: true, adjacency: true,
            adjacencyFor: trigger.kind === "battle" && isId(trigger.winnerFactionId) ? [trigger.winnerFactionId] : [] });
          if (!r.ok) return r;
          if (!r.system || r.view.seq !== p.seq || r.view.state === S.STABLE) {
            out = { stale: true };
            return { ok: true };
          }
          const evaluation = M.evaluate(r.view, trigger, params);
          const reason = (evaluation.to !== null && evaluation.notes.includes("CORE_PROTECTED"))
            ? "OCCUPATION_CORE_PROTECTED" : "OCCUPATION_PHASE";
          const w = writeEvaluation(tx, r.system, evaluation, `${ev.idempotencyKey}:world`, reason);
          if (!w.ok) return w;
          let assigned = 0;
          let garrisonRefused = 0;
          for (const g of evaluation.reassign) {
            const a = fleets.repository.reassignRole(tx, { fleetId: g.fleetId, expectedVersion: g.expectedVersion,
              from: g.from, to: S.GARRISON_ROLE }, `${ev.idempotencyKey}:garrison:${g.fleetId}`);
            if (a.ok && !a.duplicate) assigned += 1;
            else if (!a.ok) garrisonRefused += 1;
          }
          let sovResults = null;
          if (Array.isArray(evaluation.sovOps) && evaluation.sovOps.length > 0) {
            const sv = sovService();
            if (sv === null) return { ok: false, reason: "SOV_STRUCTURES_UNAVAILABLE" };
            const applied = sv.applyOpsInTx(tx, { systemId: p.systemId, ops: evaluation.sovOps,
              at: evaluation.statePatch.influenceEvaluatedAt }, `${ev.idempotencyKey}:sov`);
            if (!applied || applied.ok !== true) return applied || { ok: false, reason: "SOV_APPLY_FAILED" };
            sovResults = applied.results;
            if (sovResults.some((x) => x.outcome === "REFUSED" && SOV_UNFUNDED.includes(x.reason))) {
              evaluation.notes.push(SOV_NOTE_UNFUNDED);
            }
          }
          let playerResults = null;
          if (Array.isArray(evaluation.playerOps) && evaluation.playerOps.length > 0) {
            const ps = playerSiegeService();
            if (ps === null) return { ok: false, reason: "PLAYER_SOV_SIEGE_UNAVAILABLE" };
            const applied = ps.applyOpsInTx(tx, { systemId: p.systemId, ops: evaluation.playerOps,
              at: evaluation.statePatch.influenceEvaluatedAt }, `${ev.idempotencyKey}:psov`);
            if (!applied || applied.ok !== true) return applied || { ok: false, reason: "PLAYER_SOV_APPLY_FAILED" };
            playerResults = applied.results;
          }
          const n = enqueueNext(tx, p.systemId, evaluation, seqAfter(r.view, evaluation), true);
          if (!n.ok) return n;
          out = { evaluation, assigned, garrisonRefused, t0, written: w.written, sovResults, playerResults };
          return { ok: true };
        },
        onCommitted: () => {
          onEvalCommitted(p.systemId, sys, out);
          if (out && (out.sovResults || (out.evaluation && out.evaluation.notes.includes(SOV.NOTES.SIEGE_OBSERVED)))) {
            const sv = sovService();
            if (sv !== null && typeof sv.noteCommitted === "function") {
              call(() => sv.noteCommitted(out.sovResults || [], out.evaluation.notes));
            }
          }
          const playerNoted = out && out.evaluation
            && out.evaluation.notes.some((x) => String(x).startsWith("PLAYER_SOV_"));
          if (out && out.evaluation && (out.playerResults || playerNoted)) {
            const ps = playerSiegeService();
            if (ps !== null && typeof ps.noteCommitted === "function") {
              call(() => ps.noteCommitted(out.playerResults || [], out.evaluation.notes));
            }
          }
          if (p.trigger === S.TRIGGER_REPEL && out && !out.stale) {
            bump("playerRepelEvals");
            if (out.evaluation.notes.includes("PLAYER_REPEL")) bump("playerRepelInterrupted");
          }
          if (!stationAuditDone) {
            const stMode = stationsService().mode;
            if (stMode === "ready" && coreIndex.enabled) {
              const audit = store.transaction("occupation.coreAuditStation", (tx) => auditCoresInTx(tx));
              if (audit.ok) {
                const v = audit.value || audit;
                const stPart = `stations=${coreStationIds(coreIndex).length}`;
                log(`core station audit: protected=${v.protectedSystems} violations=${v.violations.length} ${stPart}`);
                metric("observe", "world.core.violations", v.violations.length);
                stationAuditDone = true;
              }
            }
          }
        } };
    } catch (err) {
      return { ok: false, reason: `OCCUPATION_HANDLER_FAILED: ${messageOf(err)}` };
    }
  }

  function signalInTx(tx, spec, key) {
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_STOPPED" };
      if (!spec || !isId(spec.systemId) || !isId(spec.factionId) || !S.SIGNALS.includes(spec.signal)
        || !isTime(spec.at) || typeof key !== "string" || key === "") {
        return { ok: false, reason: "OCCUPATION_INVALID_INPUT" };
      }
      let result = null;
      const wrapped = deps.journal.applyOnce(tx, { key, aggregate: { type: AGGREGATE, id: String(spec.systemId) },
        eventType: "OCCUPATION_SIGNAL", payload: { systemId: spec.systemId, factionId: spec.factionId,
          signal: spec.signal } }, (db) => {
        const r = readView(db, spec.systemId, spec.at, [spec.factionId]);
        if (!r.ok) return r;
        if (!r.system) return { ok: false, reason: "NO_SYSTEM_ROW" };
        if (r.view.deferred) return { ok: false, reason: "STATIONS_PENDING" };
        const count = repository.countActiveOccupations(db);
        if (!count.ok) return count;
        const s = M.applySignal(r.view, { factionId: spec.factionId, signal: spec.signal }, count.count, params);
        if (!s.ok) {
          return s;
        }
        if (s.outcome === "NOOP") {
          result = { ok: true, outcome: "NOOP", state: r.view.state };
          return { ok: true };
        }
        const w = writeEvaluation(db, r.system, s.evaluation, `${key}:world`, "OCCUPATION_SIGNAL");
        if (!w.ok) return w;
        const n = enqueueNext(db, spec.systemId, s.evaluation, seqAfter(r.view, s.evaluation), true);
        if (!n.ok) return n;
        result = { ok: true, outcome: s.outcome, state: s.evaluation.statePatch.occupationState,
          drift: s.drift || 0 };
        return { ok: true };
      });
      if (!wrapped.ok) {
        if (wrapped.reason === "CORE_PROTECTED" || (wrapped.refusal && wrapped.refusal.reason === "CORE_PROTECTED")) {
        }
        return wrapped.reason === "APPLY_REFUSED" ? wrapped.refusal : wrapped;
      }
      if (wrapped.duplicate) return { ok: true, outcome: "NOOP", duplicate: true, state: null };
      return result || { ok: false, reason: "OCCUPATION_SIGNAL_FAILED" };
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_SIGNAL_FAILED", detail: messageOf(err) };
    }
  }

  function markDetachedInTx(tx, spec, key) {
    if (stopped) return { ok: false, reason: "OCCUPATION_STOPPED" };
    if (!spec || !isId(spec.systemId) || !isId(spec.factionId) || typeof spec.detached !== "boolean"
      || !isTime(spec.at)) return { ok: false, reason: "OCCUPATION_INVALID_INPUT" };
    const applied = repository.isApplied(tx, key);
    if (!applied.ok) return applied;
    if (applied.applied) return { ok: true, changed: false, duplicate: true };
    const got = repository.getSystem(tx, spec.systemId, { includeInfluence: false });
    if (!got.ok) return got;
    const sys = got.system;
    if (!sys) return { ok: false, reason: "NO_SYSTEM_ROW" };
    if (sys.occupationState !== S.STABLE) return { ok: false, reason: "IN_MACHINE" };
    if (sys.capturedAt === null) return { ok: false, reason: "NOT_CAPTURED" };
    if (sys.controllerFactionId !== spec.factionId) return { ok: false, reason: "NOT_CONTROLLER" };
    const desired = spec.detached ? (sys.detachedSinceAt === null ? spec.at : sys.detachedSinceAt) : null;
    if (desired === sys.detachedSinceAt) return { ok: true, changed: false };
    const r = repository.applyChange(tx, { systemId: spec.systemId, expectedVersion: sys.version,
      reason: "OCCUPATION_DETACH", state: { detachedSinceAt: desired } }, key);
    if (!r.ok) return r;
    return { ok: true, changed: !r.duplicate, detachedSinceAt: desired };
  }

  function abandonInTx(tx, spec, key) {
    if (stopped) return { ok: false, reason: "OCCUPATION_STOPPED" };
    if (!spec || !isId(spec.systemId) || !isTime(spec.at)
      || (spec.factionId !== undefined && !isId(spec.factionId))
      || (spec.allowClaim !== undefined && typeof spec.allowClaim !== "boolean")) {
      return { ok: false, reason: "OCCUPATION_INVALID_INPUT" };
    }
    const applied = repository.isApplied(tx, key);
    if (!applied.ok) return applied;
    if (applied.applied) return { ok: true, changed: false, duplicate: true };
    const r = readView(tx, spec.systemId, spec.at, []);
    if (!r.ok) return r;
    if (!r.system) return { ok: false, reason: "NO_SYSTEM_ROW" };
    if (spec.factionId !== undefined && r.view.controller !== spec.factionId) {
      return { ok: false, reason: "NOT_CONTROLLER" };
    }
    if (spec.allowClaim === true && S.CLAIM_STATES.includes(r.view.state)) {
      const rel = M.planRelease(r.view);
      if (!rel.ok) return rel;
      if (rel.outcome === "NOOP") return { ok: true, changed: false };
      const w = writeEvaluation(tx, r.system, rel.evaluation, key, "OCCUPATION_RELEASE");
      if (!w.ok) return w;
      const e = endSovOfInTx(tx, spec.systemId, r.view.controller, spec.at, key);
      if (!e.ok) return e;
      return { ok: true, changed: w.written, previousControllerFactionId: r.view.controller, released: true };
    }
    const plan = M.planAbandon(r.view, params);
    if (!plan.ok) return plan;
    if (plan.outcome === "NOOP") return { ok: true, changed: false };
    const w = writeEvaluation(tx, r.system, plan.evaluation, key, "OCCUPATION_ABANDON");
    if (!w.ok) return w;
    const e = endSovOfInTx(tx, spec.systemId, r.view.controller, spec.at, key);
    if (!e.ok) return e;
    return { ok: true, changed: w.written, previousControllerFactionId: r.view.controller };
  }

  function restoreBastionInTx(tx, spec, keyBase) {
    const none = { garrisonReleased: 0, garrisonRefused: 0, sovEnded: 0 };
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_STOPPED" };
      if (!spec || !isId(spec.systemId) || !isId(spec.factionId) || !isTime(spec.at)
        || typeof keyBase !== "string" || keyBase === "") {
        return { ok: false, reason: "OCCUPATION_INVALID_INPUT" };
      }
      const F = spec.factionId;
      const r = readView(tx, spec.systemId, spec.at, [], undefined, {});
      if (!r.ok) return r;
      if (!r.system) return { ok: false, reason: "NO_SYSTEM_ROW" };
      const plan = M.planBastionRestore(r.view, F, params);
      if (!plan.ok) return plan;
      if (plan.outcome === "NOOP") return { ok: true, outcome: "NOOP", ...none };
      const key = `${keyBase}:${r.system.version}`;
      const applied = repository.isApplied(tx, `${key}:world`);
      if (!applied.ok) return applied;
      if (applied.applied) return { ok: true, outcome: "RESTORED", duplicate: true, ...none };
      const w = writeEvaluation(tx, r.system, plan.evaluation, `${key}:world`, "BASTION_RESTORE");
      if (!w.ok) return w;
      if (r.view.home !== F) {
        const h = repository.setHomeInTx(tx, spec.systemId, F);
        if (!h.ok) return h;
      }
      const presenceFleets = [];
      for (const [factionId, p] of r.view.presence) {
        for (const fl of p.fleets) presenceFleets.push({ ...fl, factionId });
      }
      const { garrisonReleased, garrisonRefused } = releaseGarrisonsInTx(tx, presenceFleets, F, null,
        `${key}:garrison`);
      let sovEnded = 0;
      const leaving = [...new Set([r.view.controller, r.view.occupier].filter((f) => isId(f) && f !== F))];
      for (const f of leaving) {
        const sv = sovService();
        if (sv === null || typeof sv.endOfFactionInTx !== "function") break;
        const e = sv.endOfFactionInTx(tx, { systemId: spec.systemId, factionId: f, reason: SOV.REASON.ABANDONED,
          at: spec.at }, `${key}:sovs:${f}`);
        if (!e || e.ok !== true) return e || { ok: false, reason: "SOV_ABANDON_FAILED" };
        sovEnded += Number.isSafeInteger(e.ended) ? e.ended : 0;
      }
      return { ok: true, outcome: "RESTORED", previousControllerFactionId: r.view.controller,
        state: r.view.state, garrisonReleased, garrisonRefused, sovEnded };
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_RESTORE_FAILED", detail: messageOf(err) };
    }
  }

  function releaseGarrisonsInTx(tx, list, F, onlyFactions, keyPrefix) {
    let garrisonReleased = 0;
    let garrisonRefused = 0;
    for (const fl of list) {
      if (fl.factionId === F || (onlyFactions !== null && !onlyFactions.has(fl.factionId))) continue;
      if (fl.fleetRole !== S.GARRISON_ROLE || fl.state !== "IDLE") continue;
      const a = fleets.repository.reassignRole(tx, { fleetId: fl.fleetId, expectedVersion: fl.version,
        from: S.GARRISON_ROLE, to: BASTION_RELEASE_ROLE }, `${keyPrefix}:${fl.fleetId}`);
      if (a.ok && !a.duplicate) garrisonReleased += 1;
      else if (!a.ok) garrisonRefused += 1;
    }
    return { garrisonReleased, garrisonRefused };
  }

  function returnBastionStationsInTx(tx, spec, keyBase) {
    const out = { ok: true, returned: [], foreignUpwell: 0, busy: 0, limit: 0, garrisonReleased: 0,
      garrisonRefused: 0 };
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_STOPPED" };
      if (!spec || !isId(spec.systemId) || !isId(spec.factionId) || !isId(spec.ownerCorporationId)
        || !isTime(spec.at) || !isId(spec.max) || typeof keyBase !== "string" || keyBase === "") {
        return { ok: false, reason: "OCCUPATION_INVALID_INPUT" };
      }
      const F = spec.factionId;
      const bastionsMap = coreIndex && coreIndex.bastions instanceof Map ? coreIndex.bastions : null;
      if (bastionsMap === null || bastionsMap.get(spec.systemId) !== F) return { ok: false, reason: "NOT_A_BASTION" };
      const { st, mode } = stationsService();
      if (mode !== "ready" || typeof st.repository.reassignOwner !== "function") {
        return { ...out, skipped: "STATIONS_NOT_READY" };
      }
      const repo = st.repository;
      const list = repo.listStationsInSystem(tx, spec.systemId);
      if (!list.ok) return list;
      const foreign = list.records.filter((x) => x.ownerFactionId !== F)
        .sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));
      let firstKey = null;
      for (const x of foreign) {
        if (out.returned.length >= spec.max) break;
        if (x.kind !== "npc") {
          out.foreignUpwell += 1;
          continue;
        }
        if (x.state !== STATION_ONLINE) {
          out.busy += 1;
          continue;
        }
        const k = `${keyBase}:station:${x.stationId}:${x.version}`;
        const a = deps.journal.applyOnce(tx, { key: `${k}:return`,
          aggregate: { type: B.STATION_RETURN_AGGREGATE, id: x.stationId }, eventType: B.EVENT_STATION_RETURNED,
          payload: { stationId: x.stationId, systemId: spec.systemId, fromFactionId: x.ownerFactionId, toFactionId: F,
            at: spec.at } },
        (db) => repo.reassignOwner(db, { stationId: x.stationId, expectedVersion: x.version, from: STATION_ONLINE,
          ownerFactionId: F, ownerCorporationId: spec.ownerCorporationId, key: k, reason: "BASTION_RETURN",
          at: spec.at }));
        if (a.ok && a.duplicate) continue;
        if (a.ok) {
          out.returned.push({ stationId: x.stationId, fromFactionId: x.ownerFactionId });
          if (firstKey === null) firstKey = k;
          continue;
        }
        const refusal = a.reason === "APPLY_REFUSED" && a.refusal ? a.refusal : a;
        if (STATION_LIMIT_REASONS.includes(refusal.reason)) {
          out.limit += 1;
          continue;
        }
        return refusal;
      }
      if (out.returned.length > 0) {
        const fl = fleets.repository.listFleetsInSystem(tx, spec.systemId, { limit: params.maxFleetsReadPerEval + 1,
          states: [...S.STANDING_FLEET_STATES] });
        if (!fl.ok) return fl;
        const from = new Set(out.returned.map((x) => x.fromFactionId));
        const g = releaseGarrisonsInTx(tx, fl.fleets, F, from, `${firstKey}:garrison`);
        out.garrisonReleased = g.garrisonReleased;
        out.garrisonRefused = g.garrisonRefused;
      }
      return out;
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_STATION_RETURN_FAILED", detail: messageOf(err) };
    }
  }

  function endSovOfInTx(tx, systemId, factionId, at, key) {
    const sv = sovService();
    if (sv === null || typeof sv.endOfFactionInTx !== "function" || !isId(factionId)) return { ok: true, ended: 0 };
    const r = sv.endOfFactionInTx(tx, { systemId, factionId, reason: SOV.REASON.ABANDONED, at }, `${key}:sovs`);
    return r && r.ok === true ? r : (r || { ok: false, reason: "SOV_ABANDON_FAILED" });
  }

  function dropInfluenceInTx(tx, spec, key) {
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_STOPPED" };
      if (!spec || !isId(spec.systemId) || !isId(spec.factionId) || !Number.isFinite(spec.points) || !(spec.points > 0)
        || !isTime(spec.at) || (spec.reason !== undefined && (typeof spec.reason !== "string" || spec.reason === ""))
        || (spec.allowNonController !== undefined && typeof spec.allowNonController !== "boolean")
        || typeof key !== "string" || key === "") {
        return { ok: false, reason: "OCCUPATION_INVALID_INPUT" };
      }
      const applied = repository.isApplied(tx, key);
      if (!applied.ok) return applied;
      if (applied.applied) return { ok: true, outcome: "DUPLICATE" };
      const got = repository.getSystem(tx, spec.systemId, { includeInfluence: true });
      if (!got.ok) return got;
      const sys = got.system;
      if (!sys) return { ok: false, reason: "NO_SYSTEM_ROW" };
      if (spec.allowNonController !== true && sys.controllerFactionId !== spec.factionId) {
        return { ok: false, reason: "NOT_CONTROLLER" };
      }
      const plan = planInfluenceDrop(sys, { factionId: spec.factionId, points: spec.points, at: spec.at }, params);
      let written = false;
      if (plan.influence.length > 0 || Object.keys(plan.statePatch).length > 0) {
        const w = repository.applyChange(tx, { systemId: spec.systemId, expectedVersion: sys.version,
          reason: spec.reason || "INFLUENCE_DROP", state: plan.statePatch, influence: plan.influence }, key);
        if (!w.ok) return w;
        if (w.duplicate) return { ok: true, outcome: "DUPLICATE" };
        written = true;
      }
      return { ok: true, outcome: "APPLIED", written, before: plan.before, next: plan.next, drifted: plan.drifted,
        banked: plan.banked, state: sys.occupationState, phaseSeq: sys.phaseSeq };
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_DROP_FAILED", detail: messageOf(err) };
    }
  }

  function enqueueBattleInTx(tx, sys, settled, winnerFactionId, loserFactionId) {
    const payload = { systemId: sys.systemId, seq: sys.phaseSeq, trigger: S.TRIGGER_BATTLE, battleId: settled.battleId,
      winnerFactionId, loserFactionId, at: settled.at };
    const r = scheduler.enqueue(S.EVENT_TYPE, String(sys.systemId), settled.at, payload,
      S.battleKey(sys.systemId, sys.phaseSeq, settled.battleId), { tx, chained: true });
    return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
  }

  const repelEnabled = config.occupation.playerRepelEnabled === true;
  const repelPoints = Number.isFinite(config.occupation.repelPoints) && config.occupation.repelPoints > 0
    ? config.occupation.repelPoints : 0;
  const repelStates = S.parseRepelStates(config.occupation.repelStates) || Object.freeze([]);

  function claimOfInTx(tx, systemId) {
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_UNAVAILABLE", detail: "stopped" };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (!isId(systemId)) return { ok: false, reason: "OCCUPATION_INPUT_INVALID" };
      const got = repository.getSystem(tx, systemId, { includeInfluence: false });
      if (!got.ok) return got;
      const sys = got.system;
      if (!sys || sys.occupierFactionId === null || !repelStates.includes(sys.occupationState)) {
        return { ok: true, claim: null };
      }
      return { ok: true, claim: { systemId, state: sys.occupationState, occupierFactionId: sys.occupierFactionId,
        phaseSeq: sys.phaseSeq } };
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_READ_FAILED", detail: messageOf(err) };
    }
  }

  function sovClaimOfInTx(tx, systemId) {
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_UNAVAILABLE", detail: "stopped" };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (!isId(systemId)) return { ok: false, reason: "OCCUPATION_INPUT_INVALID" };
      const got = repository.getSystem(tx, systemId, { includeInfluence: false });
      if (!got.ok) return got;
      const sys = got.system;
      if (!sys) return { ok: true, claim: null };
      return { ok: true, claim: { state: sys.occupationState, controllerFactionId: sys.controllerFactionId,
        occupierFactionId: sys.occupierFactionId, phaseSeq: sys.phaseSeq, capturedAt: sys.capturedAt } };
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_READ_FAILED", detail: messageOf(err) };
    }
  }

  function nudgeForSovInTx(tx, spec) {
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_UNAVAILABLE", detail: "stopped" };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      const s = spec || {};
      if (!isId(s.systemId) || typeof s.structureId !== "string" || s.structureId === ""
        || s.structureId.length > MAX_SOURCE_ID_LENGTH || !isTime(s.at)) {
        return { ok: false, reason: "OCCUPATION_INPUT_INVALID" };
      }
      const got = repository.getSystem(tx, s.systemId, { includeInfluence: false });
      if (!got.ok) return got;
      const sys = got.system;
      if (!sys) return { ok: false, reason: "NO_ROW" };
      if (sys.occupationState === S.STABLE) return { ok: true, enqueued: false };
      const r = scheduler.enqueue(S.EVENT_TYPE, String(s.systemId), s.at,
        { systemId: s.systemId, seq: sys.phaseSeq, trigger: S.TRIGGER_TICK },
        S.sovNudgeKey(s.systemId, sys.phaseSeq, s.structureId), { tx, chained: true });
      return r && r.ok ? { ok: true, enqueued: true } : { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_NUDGE_FAILED", detail: messageOf(err) };
    }
  }

  function enqueueRepelInTx(tx, sys, huntId, loserFactionId, at) {
    const payload = { systemId: sys.systemId, seq: sys.phaseSeq, trigger: S.TRIGGER_REPEL, huntId, loserFactionId,
      at };
    const r = scheduler.enqueue(S.EVENT_TYPE, String(sys.systemId), at, payload,
      S.repelKey(sys.systemId, sys.phaseSeq, huntId), { tx, chained: true });
    return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
  }

  function applyPlayerRepelInTx(tx, spec, key) {
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_UNAVAILABLE", detail: "stopped" };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (!repelEnabled) return { ok: false, reason: "REPEL_DISABLED" };
      const s = spec || {};
      if (!isId(s.systemId) || !isId(s.factionId) || typeof s.huntId !== "string" || s.huntId === ""
        || s.huntId.length > MAX_SOURCE_ID_LENGTH || !isId(s.characterId) || !isTime(s.at)
        || typeof key !== "string" || key === "") {
        return { ok: false, reason: "OCCUPATION_INPUT_INVALID" };
      }
      let state = null;
      let outcome = "APPLIED";
      const r = deps.journal.applyOnce(tx, { key, aggregate: { type: AGGREGATE, id: String(s.systemId) },
        eventType: "OCCUPATION_PLAYER_REPEL", payload: { systemId: s.systemId, factionId: s.factionId,
          huntId: s.huntId, characterId: s.characterId, points: repelPoints } }, (db) => {
        const got = repository.getSystem(db, s.systemId, { includeInfluence: true });
        if (!got.ok) return got;
        const sys = got.system;
        if (!sys) return { ok: false, reason: "NO_ROW" };
        if (sys.occupierFactionId !== s.factionId || !repelStates.includes(sys.occupationState)) {
          return { ok: false, reason: "NOT_CLAIMANT" };
        }
        state = sys.occupationState;
        if (repelPoints > 0) {
          const drop = dropInfluenceInTx(db, { systemId: s.systemId, factionId: s.factionId, points: repelPoints,
            at: s.at, reason: "OCCUPATION_REPEL", allowNonController: true }, `${key}:world:${s.systemId}`);
          if (!drop.ok) return drop;
          if (drop.outcome === "APPLIED" && drop.written !== true) outcome = "NO_INFLUENCE";
        } else outcome = "NO_INFLUENCE";
        return enqueueRepelInTx(db, sys, s.huntId, s.factionId, s.at);
      });
      if (!r.ok) return r.reason === "APPLY_REFUSED" ? r.refusal : r;
      if (r.duplicate) return { ok: true, outcome: "DUPLICATE", state: null };
      return { ok: true, outcome, state };
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "OCCUPATION_REPEL_FAILED", detail: messageOf(err) };
    }
  }

  function auditCoresInTx(tx) {
    if (!coreIndex.enabled) return { ok: true, violations: [], outOfScope: [], heldByFaction: new Map(), protectedSystems: 0 };
    try {
      const sysIds = coreSystemIds(coreIndex);
      const stIds = coreStationIds(coreIndex);
      const sysResult = repository.getSystems(tx, sysIds, { includeInfluence: false });
      if (!sysResult.ok) return sysResult;
      const rows = sysResult.systems || [];
      let stations = null;
      const { st, mode } = stationsService();
      if (mode === "ready" && st.repository && typeof st.repository.getStation === "function") {
        stations = [];
        for (const sid of stIds) {
          const sr = st.repository.getStation(tx, String(sid));
          if (sr.ok && sr.record) {
            stations.push({ stationId: sr.record.stationId, ownerFactionId: sr.record.ownerFactionId, state: sr.record.state });
          }
        }
      }
      return auditCores(coreIndex, rows, stations);
    } catch (err) {
      return { ok: false, reason: `CORE_AUDIT_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (stopped) return { ok: false, reason: "OCCUPATION_STOPPED" };
      const ready = call(() => scheduler.getStatus().state === SCHEDULER_READY, false);
      if (!ready || typeof scheduler.enqueueMany !== "function") return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
      const read = store.transaction("occupation.bootstrapRead", (tx) => repository.listActiveOccupations(tx,
        { limit: params.maxActiveSystems }));
      const listed = read.ok ? read.value : read;
      if (!listed || !listed.ok) return { ok: false, reason: (listed && listed.reason) || "TX_FAILED" };
      const now = clock.now();
      const specs = listed.systems.map((sys) => {
        const next = M.nextOf(sys.occupationState, sys.lastStateChangeAt, false, now, params);
        return { eventType: S.EVENT_TYPE, aggregateId: String(sys.systemId), dueAt: next.dueAt,
          payload: { systemId: sys.systemId, seq: sys.phaseSeq, trigger: S.TRIGGER_TICK },
          idempotencyKey: S.tickKey(sys.systemId, sys.phaseSeq, next.interval, next.bucket) };
      });
      if (specs.length === 0) return { ok: true, enqueued: 0, duplicates: 0 };
      const r = scheduler.enqueueMany(specs);
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      bump("bootstrapEnqueued", r.enqueued);
      bump("bootstrapDuplicates", r.duplicates);

      const audit = store.transaction("occupation.coreAudit", (tx) => auditCoresInTx(tx));
      if (audit.ok) {
        const v = audit.value || audit;
        if (v.violations.length > 0) {
          for (const viol of v.violations) {
            log(`core audit: ${viol.factionId} ${viol.kind} ${viol.ref}`);
          }
        }
        const stMode = stationsService().mode;
        const stPart = stMode === "ready" ? `stations=${coreStationIds(coreIndex).length}` : "stations=pending";
        log(`core: protected=${v.protectedSystems} outOfScope=${v.outOfScope.length} violations=${v.violations.length} ${stPart}`);
        metric("observe", "world.core.violations", v.violations.length);
      } else {
        log(`core audit failed: ${audit.reason}`);
      }

      return { ok: true, enqueued: r.enqueued, duplicates: r.duplicates, refusal: r.refusal || null };
    } catch (err) {
      return { ok: false, reason: `OCCUPATION_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "ready", seq, counters: Object.freeze({ ...counters }),
      lastRefusal });
  }

  function count(name, n = 1) {
    if (!Object.prototype.hasOwnProperty.call(counters, name)) return;
    bump(name, n);
  }

  function noteRefusal(where, reason) {
    lastRefusal = `${where}:${String(reason).slice(0, MAX_DETAIL)}`;
    seq += 1;
  }

  function registerOnControllerChanged(cb) {
    const prev = onControllerChangedCallback;
    onControllerChangedCallback = typeof cb === "function" ? cb : null;
    return prev;
  }

  return Object.freeze({
    handler,
    bootstrap,
    signalInTx,
    markDetachedInTx,
    abandonInTx,
    restoreBastionInTx,
    returnBastionStationsInTx,
    enqueueBattleInTx,
    readView,
    readProgressInTx,
    getStatus,
    count,
    noteRefusal,
    params,
    territoryUpkeepFactor: (sys, at) => M.territoryUpkeepFactor(sys, at, params),
    dropInfluenceInTx,
    claimOfInTx,
    applyPlayerRepelInTx,
    sovClaimOfInTx,
    nudgeForSovInTx,
    effectiveScoreOf: (sys, factionId, at) => {
      const s = effectiveScores(sys, at, params).get(factionId);
      return s === undefined ? 0 : s;
    },
    registerOnControllerChanged,
    auditCoresInTx,
    stop() {
      stopped = true;
    },
    isStopped: () => stopped,
  });
}

module.exports = { createOccupationService, parsePayload, COUNTER_NAMES, REPEL_KEYS };
