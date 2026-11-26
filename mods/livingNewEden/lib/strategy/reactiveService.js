"use strict";

const { performance } = require("node:perf_hooks");
const { deriveSeed } = require("../util/rng");
const { decideReactive, reactiveCanAct, idleReactive } = require("./ai");
const { createDecideThrewLog } = require("./decideThrewLog");
const { strengthOf } = require("./ai/strength");
const { INTERCEPT_TARGET_TYPES } = require("./ai/intercepts");
const { REVIEW_ROWS, reactiveIntentRowsOf, withDepartureRows, fortressTxRowsOf,
  battleAnnounceTxRowsOf, transitTxRowsOf, listeningPostTxRowsOf } = require("./reviewRows");
const { FACTION_AGGREGATE, EVENT_STRATEGY_INTENT } = require("./schema");
const { gateLegOf } = require("../fleets/crossing");
const { jumpMsForComposition } = require("../fleets/travel");
const { parseOperationTypeList } = require("../fleets/schema");

const EVENT_TYPE = "FACTION_REACTIVE_SWEEP";
const LEGACY_EVENT_TYPE = "FACTION_REACTIVE_REVIEW";
const SWEEP_AGGREGATE_ID = "reactive";
const KEY_PREFIX = "strategy:react:";
const SWEEP_PREFIX = "strategy:sweep:";
const RANGE_END = ";";
const ROUND_DIGITS = 12;
const HOUR_MS = 3600000;
const PRUNE_RANGES = 3;
const ROW_RESERVE = 1;
const SCHEDULER_READY = "ready";
const STATION_READY = "ready";
const STATION_PENDING = "pending";
const INTERCEPT_KIND = "intercept_post";
const REACTIVE_KINDS = Object.freeze(["defense", INTERCEPT_KIND]);
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const INCOMING_STATE = "ACTIVE";
const BLOCKADE_ON = "on";
const SCAN_ROWS_BASE = 2;
const SCAN_ROWS_PER_FLEET = 2;
const MAX_REASON_LENGTH = 120;
const MS_DECIMALS = 100;
const COUNTER_NAMES = Object.freeze(["runs", "idle", "reacted", "skipped", "deferred", "stale", "launches", "defenses",
  "reliefs", "capped", "capScanTruncated", "intentRefused", "pruned", "pruneRefused", "bootstrapEnqueued",
  "bootstrapDuplicates", "sweeps", "rowCapped", "readFailed", "superseded", "fullReads", "roundRepeated",
  "intercepts", "interceptNoFleet", "interceptOpsTruncated", "interceptScanRefused",
  "interceptCapped"]);
const NO_FLEET_NOTE = "INTERCEPT_NO_FLEET:";
const CAPPED_NOTE = "INTERCEPT_CAPPED:";
const QUIET_SKIPS = new Set(["NOT_IN_REGISTRY", "INACTIVE"]);
const EMPTY_SUMMARY = Object.freeze({ launches: Object.freeze([]), refused: Object.freeze([]) });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_REASON_LENGTH);
const pad = (b) => String(b).padStart(ROUND_DIGITS, "0");

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createReactiveService(deps) {
  const { store, journal, strategyRepository, registry, kinds, scheduler, fleets, clock, worldSeed, config,
    params } = deps;
  const S = config.strategy;
  const R = S.reactiveIntervalMs;
  const liveFleetStates = [...deps.liveFleetStates];
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const interceptNoted = new Map();
  let lastRefusal = null;
  let bootstrapped = { enqueued: 0, duplicates: 0, reason: null };
  let stopped = false;

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
    metric("count", `strategy.reactive.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }
  const threwLog = createDecideThrewLog({ log, clock, intervalMs: S.decideThrewLogIntervalMs,
    label: "reactive decide" });

  const ms = (t0) => Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;

  const phase = deriveSeed(worldSeed, "strategy", "reactive-sweep-phase", 0) % R;
  const bucketOf = (t) => Math.floor((t - phase) / R);
  const dueOf = (b) => b * R + phase;
  const sweepKeyOf = (b) => `${SWEEP_PREFIX}${R}:${pad(b)}`;
  const keyOf = (f, b) => `${KEY_PREFIX}${f}:${R}:${pad(b)}`;
  const nextOf = (at) => {
    const b = bucketOf(at) + 1;
    return { dueAt: dueOf(b), payload: { round: b, intervalMs: R }, idempotencyKey: sweepKeyOf(b) };
  };

  function currentGraph() {
    const g = deps.graph;
    const r = call(() => (g && typeof g.getGraph === "function" ? g.getGraph() : null), null);
    return r && r.ok === true && r.graph ? r.graph : null;
  }

  function stationsMode() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    return st && typeof st.getMode === "function" ? call(() => st.getMode(), "off") : "off";
  }

  function blockadeFacade() {
    return typeof deps.getBlockade === "function" ? call(deps.getBlockade, null) : null;
  }

  function interceptOn() {
    if (!params.intercept) return false;
    const bk = blockadeFacade();
    return Boolean(bk && typeof bk.getMode === "function" && call(() => bk.getMode(), "off") === BLOCKADE_ON);
  }

  const interceptTypes = (() => {
    const listed = parseOperationTypeList(S.blockadeInterceptOperationTypes) || [];
    return INTERCEPT_TARGET_TYPES.filter((t) => listed.includes(t));
  })();

  function jumpMsOf(composition) {
    const factor = config.fleets && config.fleets.travelTimeFactor;
    const base = call(() => jumpMsForComposition(composition, { timeFactor: factor }), null);
    if (!base || !base.ok) return null;
    return call(() => Math.max(1, clock.travelDurationMs(base.baseJumpMs, { observed: false })), null);
  }

  function isEnemy(f, o) {
    if (!isId(o) || o === f || typeof deps.hostility !== "function") return false;
    const entry = call(() => registry.getFaction(f), null);
    if (entry && Array.isArray(entry.allies) && entry.allies.includes(o)) return false;
    return call(() => deps.hostility(f, o) === true, false);
  }

  function readControllers(db, ids, graph, into) {
    const todo = [...new Set(ids)].filter((id) => isId(id) && !into.has(id));
    if (todo.length === 0) return { ok: true };
    const world = deps.world && deps.world.repository;
    const rows = new Map();
    if (world && typeof world.getSystems === "function") {
      const size = (world.limits && world.limits.maxBatchReadIds) || todo.length;
      for (let i = 0; i < todo.length; i += size) {
        const r = world.getSystems(db, todo.slice(i, i + size), { includeInfluence: false });
        if (!r || !r.ok) return r || { ok: false, reason: "WORLD_READ_FAILED" };
        for (const s of r.systems) rows.set(s.systemId, s);
      }
    }
    for (const id of todo) {
      const w = rows.get(id);
      if (w) into.set(id, isId(w.controllerFactionId) ? w.controllerFactionId : null);
      else {
        const v = call(() => graph.getSystem(id), null);
        into.set(id, v && isId(v.factionId) ? v.factionId : null);
      }
    }
    return { ok: true };
  }

  function readIncoming(db, graph) {
    const closed = { ok: true, of: () => [], truncated: false, controllers: new Map() };
    if (!interceptOn() || interceptTypes.length === 0) return closed;
    const max = S.interceptScanMaxOperations;
    const r = fleets.repository.listOperations(db, { state: INCOMING_STATE, operationTypes: [...interceptTypes],
      limit: max + 1 });
    if (!r || !r.ok) return r || { ok: false, reason: "INCOMING_READ_FAILED" };
    const truncated = r.operations.length > max;
    const ops = r.operations.slice(0, max);
    const controllers = new Map();
    const c = readControllers(db, ops.map((op) => op.targetSystemId), graph, controllers);
    if (!c.ok) return c;
    const byController = new Map();
    for (const op of ops) {
      const f = controllers.get(op.targetSystemId);
      if (!isId(f)) continue;
      if (!byController.has(f)) byController.set(f, []);
      byController.get(f).push(op);
    }
    return { ok: true, truncated, controllers,
      of: (f) => (byController.get(f) || []).filter((op) => isEnemy(f, op.factionId)) };
  }

  function readIncomingOf(db, f, ops, graph, controllers) {
    const picked = [...ops].sort((a, b) => (a.operationId < b.operationId ? -1 : 1))
      .slice(0, S.interceptMaxCandidates);
    const out = [];
    for (const op of picked) {
      const m = fleets.repository.listFleetsOfOperation(db, op.operationId);
      if (!m || !m.ok) return m || { ok: false, reason: "INCOMING_FLEETS_READ_FAILED" };
      const legs = [];
      for (const x of m.fleets) {
        const leg = gateLegOf(x);
        if (!leg) continue;
        legs.push({ x, leg, systems: leg.systems.slice(0, S.interceptRouteMaxSystems) });
      }
      const c = readControllers(db, legs.flatMap((l) => l.systems), graph, controllers);
      if (!c.ok) return c;
      out.push({ operationId: op.operationId, factionId: op.factionId, operationType: op.operationType,
        targetSystemId: op.targetSystemId, fleets: legs.map(({ x, leg, systems }) => ({ fleetId: x.fleetId,
          legSeq: x.legSeq, strength: strengthOf(x.composition, params.powerTable),
          leg: { systems, departAt: leg.departAt, jumpMs: leg.jumpMs },
          own: systems.map((id) => controllers.get(id) === f) })) });
    }
    return { ok: true, incoming: out };
  }

  function readSieges(db, ids) {
    const sg = typeof deps.getSiege === "function" ? call(deps.getSiege, null) : null;
    if (!sg) return { ok: true, of: () => null };
    const mode = typeof sg.getMode === "function" ? call(() => sg.getMode(), "off") : "off";
    if (mode !== STATION_READY || !params.siege || typeof sg.readForFactions !== "function") {
      const offMode = mode === STATION_READY ? "off" : mode;
      return { ok: true, of: () => ({ mode: offMode, attacking: [], defending: [], truncated: false }) };
    }
    if (ids.length === 0) return { ok: true, of: () => null };
    const r = sg.readForFactions(db, ids, { limit: config.siege.maxOpenSieges });
    if (!r || !r.ok) return r || { ok: false, reason: "SIEGE_READ_FAILED" };
    return { ok: true, of: (f) => {
      const x = r.byFaction.get(f);
      return { mode, attacking: x ? x.attacking : [], defending: x ? x.defending : [], truncated: r.truncated === true };
    } };
  }

  function readPlayerSieges(db, ids) {
    const ps = typeof deps.getPlayerSiege === "function" ? call(deps.getPlayerSiege, null) : null;
    if (!ps) return { ok: true, of: () => null };
    const mode = typeof ps.getMode === "function" ? call(() => ps.getMode(), "off") : "off";
    if (mode !== STATION_READY || !params.playerSiege || typeof ps.readForFactions !== "function") {
      const offMode = mode === STATION_READY ? "off" : mode;
      return { ok: true, of: () => ({ mode: offMode, attacking: [], targets: [], truncated: false }) };
    }
    if (ids.length === 0) return { ok: true, of: () => null };
    const r = ps.readForFactions(db, ids, { limit: config.playerSiege.maxOpen });
    if (!r || !r.ok) return r || { ok: false, reason: "PLAYER_SIEGE_READ_FAILED" };
    return { ok: true, of: (f) => {
      const x = r.byFaction.get(f);
      return { mode, attacking: x ? x.attacking : [], targets: [], truncated: r.truncated === true };
    } };
  }

  function readThreats(db, f) {
    const threats = { mode: "off", truncated: false, items: [] };
    const world = deps.world && deps.world.repository;
    if (!world || typeof world.listByOccupier !== "function" || typeof world.listThreatened !== "function"
      || !(S.maxThreatsRead > 0)) return { ok: true, threats };
    const th = world.listThreatened(db, f, { limit: S.maxThreatsRead + 1, includeInfluence: true });
    if (!th.ok) return th;
    threats.mode = "ready";
    threats.truncated = th.systems.length > S.maxThreatsRead;
    threats.items = th.systems.slice(0, S.maxThreatsRead).map((x) => {
      const inf = Array.isArray(x.influence) ? x.influence.find((i) => i.factionId === x.occupierFactionId) : null;
      return { systemId: x.systemId, state: x.occupationState, occupier: x.occupierFactionId,
        occupierStrength: inf ? inf.garrisonStrength : 0, phaseDueAt: x.phaseDueAt === undefined ? null : x.phaseDueAt };
    });
    return { ok: true, threats };
  }

  function readRoom(db, f, b) {
    const cap = S.reactiveMaxLaunchesPerHour;
    if (!(cap > 0)) return { ok: true, room: 0, truncated: false };
    const W = Math.ceil(HOUR_MS / R);
    const from = keyOf(f, Math.max(0, b - W + 1));
    const to = keyOf(f, b);
    if (!(from < to)) return { ok: true, room: cap, truncated: false };
    const limit = Math.min(config.persistence.maxRowsPerTransaction,
      (cap + 1) * (SCAN_ROWS_BASE + SCAN_ROWS_PER_FLEET * S.maxFleetsPerOperation));
    const sc = journal.scanKeyRange(db, from, to, limit);
    if (!sc.ok) return sc;
    if (sc.rows.length >= limit) return { ok: true, room: 0, truncated: true };
    const used = sc.rows.filter((x) => x.eventType === EVENT_STRATEGY_INTENT).length;
    return { ok: true, room: Math.max(0, cap - used), truncated: false };
  }

  function actedInRound(db, f, b) {
    const base = keyOf(f, b);
    const sc = journal.scanKeyRange(db, `${base}:`, `${base}${RANGE_END}`, 1);
    if (!sc.ok) return sc;
    return { ok: true, acted: sc.rows.length > 0 };
  }

  function threatGate(db) {
    const world = deps.world && deps.world.repository;
    if (!world || typeof world.listByOccupier !== "function" || typeof world.listThreatened !== "function"
      || !(S.maxThreatsRead > 0)) return { ok: true, has: () => false };
    if (typeof world.listThreatenedControllers !== "function") return { ok: true, has: null };
    const r = world.listThreatenedControllers(db);
    if (!r || !r.ok) return r || { ok: false, reason: "THREATS_READ_FAILED" };
    if (r.truncated === true) return { ok: true, has: () => true };
    const ids = new Set(r.factionIds);
    return { ok: true, has: (f) => ids.has(f) };
  }

  function readFaction(db, f, b, at, graph, doctrine, sieges, pre, inc, playerSieges) {
    const fl = fleets.repository.listFleetsByFaction(db, f, { limit: S.maxFleetsReadPerReview + 1,
      states: [...liveFleetStates] });
    if (!fl.ok) return fl;
    const withJump = Boolean(params.intercept);
    const fleetList = fl.fleets.slice(0, S.maxFleetsReadPerReview).map((x) => ({ fleetId: x.fleetId,
      version: x.version, state: x.state, fleetRole: x.fleetRole, systemId: x.currentSystemId,
      refitPending: x.refitPending === true, strength: strengthOf(x.composition, params.powerTable),
      operationId: x.operationId, ...(withJump ? { jumpMs: jumpMsOf(x.composition) } : {}) }));
    let incoming = null;
    if (withJump) {
      const ri = inc && inc.ops.length > 0 ? readIncomingOf(db, f, inc.ops, graph, inc.controllers)
        : { ok: true, incoming: [] };
      if (!ri.ok) return ri;
      incoming = ri.incoming;
    }

    const ops = fleets.repository.listOperations(db, { factionId: f, states: [...OPEN_OPERATION_STATES],
      limit: S.maxOpenOperationsRead + 1 });
    if (!ops.ok) return ops;
    const operationsTruncated = ops.operations.length > S.maxOpenOperationsRead;
    const operations = ops.operations.slice(0, S.maxOpenOperationsRead).map((op) => ({ operationId: op.operationId,
      version: op.version, state: op.state, operationType: op.operationType, targetSystemId: op.targetSystemId,
      dueAt: op.dueAt }));

    const th = pre || readThreats(db, f);
    if (!th.ok) return th;
    const room = readRoom(db, f, b);
    if (!room.ok) return room;

    const world = deps.world && deps.world.repository;
    let occupations = [];
    if (params.claimHold && world && typeof world.listByOccupier === "function") {
      const o = world.listByOccupier(db, f, { limit: S.maxOpenOperationsRead });
      if (!o.ok) return o;
      occupations = o.systems.map((x) => ({ systemId: x.systemId, state: x.occupationState,
        occupier: x.occupierFactionId, sinceAt: x.lastStateChangeAt === undefined ? null : x.lastStateChangeAt,
        homeOwn: x.homeFactionId === f }));
    }

    return { ok: true, capScanTruncated: room.truncated, snapshot: {
      v: 1, factionId: f, round: b, at,
      doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
        operationTypes: [...doctrine.operationTypes], hive: doctrine.hive === true },
      fleets: fleetList, operations, operationsTruncated, occupations, threats: th.threats, siege: sieges.of(f),
      ...(playerSieges && playerSieges.of(f) !== null ? { playerSiege: playerSieges.of(f) } : {}),
      neighbors: (id) => graph.getNeighbors(id),
      reactive: { room: room.room }, ...(incoming ? { incoming } : {}) } };
  }

  function readSweep(b, at, graph) {
    const tx = store.transaction("strategy.reactiveSweepRead", (db) => {
      if (stationsMode() === STATION_PENDING) return { ok: true, deferred: "STATIONS_PENDING" };
      const listed = strategyRepository.listFactions(db);
      if (!listed.ok) return listed;
      const skipped = [];
      const eligible = [];
      for (const row of [...listed.records].sort((x, y) => x.factionId - y.factionId)) {
        const f = row.factionId;
        const entry = registry.getFaction(f);
        let skip = null;
        let doctrine = null;
        if (!entry) skip = "NOT_IN_REGISTRY";
        else if (!registry.isActive(f)) skip = "INACTIVE";
        else if (row.status === "ELIMINATED") skip = "ELIMINATED";
        else {
          doctrine = registry.getDoctrine(row.doctrineId) || registry.getDoctrine(entry.doctrineId);
          if (!doctrine) skip = "NO_DOCTRINE";
        }
        if (skip) skipped.push({ factionId: f, reason: skip, quiet: QUIET_SKIPS.has(skip) });
        else eligible.push({ f, doctrine });
      }
      const n = eligible.length;
      const start = n > 0 ? ((b % n) + n) % n : 0;
      const order = [...eligible.slice(start), ...eligible.slice(0, start)];
      const failed = [];
      const factions = [];
      const sieges = readSieges(db, order.map((x) => x.f));
      if (!sieges.ok) {
        const why = `SIEGE:${String(sieges.reason || "SIEGE_READ_FAILED")}`;
        for (const x of order) failed.push({ factionId: x.f, reason: why });
        return { ok: true, skipped, failed, factions };
      }
      const playerSieges = readPlayerSieges(db, order.map((x) => x.f));
      if (!playerSieges.ok) {
        const why = `PLAYER_SIEGE:${String(playerSieges.reason || "PLAYER_SIEGE_READ_FAILED")}`;
        for (const x of order) failed.push({ factionId: x.f, reason: why });
        return { ok: true, skipped, failed, factions };
      }
      const gate = threatGate(db);
      if (!gate.ok) {
        const why = `THREATS:${String(gate.reason || "THREATS_READ_FAILED")}`;
        for (const x of order) failed.push({ factionId: x.f, reason: why });
        return { ok: true, skipped, failed, factions };
      }
      const incoming = readIncoming(db, graph);
      if (!incoming.ok) {
        const why = `INCOMING:${String(incoming.reason || "INCOMING_READ_FAILED")}`;
        for (const x of order) failed.push({ factionId: x.f, reason: why });
        return { ok: true, skipped, failed, factions };
      }
      for (const x of order) {
        let pre = null;
        let threatCount = 0;
        if (gate.has) threatCount = gate.has(x.f) ? 1 : 0;
        else {
          pre = readThreats(db, x.f);
          if (!pre.ok) {
            failed.push({ factionId: x.f, reason: String(pre.reason || "READ_FAILED") });
            continue;
          }
          threatCount = pre.threats.items.length;
        }
        const incomingOps = incoming.of(x.f);
        if (!reactiveCanAct(threatCount, sieges.of(x.f), incomingOps.length)) {
          factions.push({ ok: true, full: false, factionId: x.f, round: b });
          continue;
        }
        const acted = actedInRound(db, x.f, b);
        if (!acted.ok) {
          failed.push({ factionId: x.f, reason: String(acted.reason || "READ_FAILED") });
          continue;
        }
        if (acted.acted) {
          factions.push({ ok: true, full: false, factionId: x.f, round: b, repeated: true });
          continue;
        }
        const r = readFaction(db, x.f, b, at, graph, x.doctrine, sieges, pre,
          { ops: incomingOps, controllers: incoming.controllers }, playerSieges);
        if (r.ok) factions.push({ ...r, full: true });
        else failed.push({ factionId: x.f, reason: String(r.reason || "READ_FAILED") });
      }
      return { ok: true, skipped, failed, factions, ...(incoming.truncated ? { incomingTruncated: true } : {}) };
    });
    if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
    return tx.value;
  }

  function routeCheck(graph, from, to) {
    if (from === to) return { ok: false, reason: "SAME_SYSTEM" };
    const r = call(() => graph.findRoute(from, to), null);
    if (!r || r.ok !== true || !(r.jumps > 0)) return { ok: false, reason: (r && r.reason) || "UNREACHABLE" };
    return { ok: true };
  }

  function launchReactiveInTx(db, snapshot, intent, ik, at, graph) {
    const kind = kinds.get(intent.kind);
    if (!kind) return { ok: false, reason: "UNKNOWN_KIND", detail: intent.kind };
    if (intent.type !== "LAUNCH" || !REACTIVE_KINDS.includes(intent.kind) || !Array.isArray(intent.mobilize)
      || intent.mobilize.length !== 0 || kind.occupationSignal) {
      return { ok: false, reason: "REACTIVE_INTENT_FORBIDDEN", detail: `${intent.type}:${intent.kind}` };
    }
    const intercept = intent.kind === INTERCEPT_KIND;
    const fleetIds = intercept && intent.intercept && Array.isArray(intent.intercept.fleetIds)
      ? intent.intercept.fleetIds : null;
    if (intercept && (!fleetIds || fleetIds.length === 0 || fleetIds.length > S.maxFleetsPerOperation
      || !fleetIds.every((x) => typeof x === "string" && x.length > 0))) {
      return { ok: false, reason: "INTERCEPT_INVALID" };
    }
    const T = intent.target.systemId;
    const inPlace = new Set(kind.inPlace === true ? snapshot.fleets.filter((x) => x.systemId === T
      && intent.fleets.some((y) => y.fleetId === x.fleetId)).map((x) => x.fleetId) : []);
    const starts = snapshot.fleets.filter((x) => intent.fleets.some((y) => y.fleetId === x.fleetId)
      && !inPlace.has(x.fleetId)).map((x) => x.systemId);
    for (const from of starts) {
      const ok = routeCheck(graph, from, T);
      if (!ok.ok) return ok;
    }
    const members = intent.fleets.map((x) => ({ fleetId: x.fleetId, expectedVersion: x.expectedVersion }));
    const op = fleets.repository.createOperation(db, { operationType: kind.operationType, factionId: snapshot.factionId,
      originSystemId: intent.originSystemId, targetSystemId: T, objective: kind.objective, dueAt: intent.dueAt,
      fleets: members }, `${ik}:op`);
    if (!op.ok) return op;
    if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:op` };
    let queued = null;
    let scan = null;
    if (intercept) {
      const bk = blockadeFacade();
      scan = bk && typeof bk.registerBlockadeInTx === "function"
        ? bk.registerBlockadeInTx(db, { operationId: op.operationId, systemId: T, factionId: snapshot.factionId,
          dueAt: intent.dueAt, at, fleetIds: [...fleetIds] }, { chained: true, maxFleets: fleetIds.length })
        : { ok: false, reason: "BLOCKADE_UNAVAILABLE" };
      if (!scan || scan.ok !== true) {
        return { ok: false, reason: "INTERCEPT_SCAN_REFUSED", detail: String((scan && scan.reason) || "NO_RESULT") };
      }
      if (!(scan.queued > 0)) return { ok: false, reason: "INTERCEPT_NOT_QUEUED" };
      queued = scan.queued;
    }
    for (const m of members) {
      const key = `${ik}:go:${m.fleetId}`;
      const p = inPlace.has(m.fleetId)
        ? fleets.travel.stageInPlaceInTx(db, { fleetId: m.fleetId, at }, key, { chained: true })
        : fleets.travel.planInTx(db, { fleetId: m.fleetId, targetSystemId: T, at }, key, { chained: true });
      if (!p.ok) return { ...p, fleetId: m.fleetId };
    }
    return { ok: true, operationId: op.operationId, fleets: members.length, kind: intent.kind,
      ...(queued !== null ? { queued, scan } : {}) };
  }

  function applyFaction(tx, decision, snapshot, at, graph) {
    const f = snapshot.factionId;
    const b = snapshot.round;
    const out = { factionId: f, launches: [], refused: [] };
    decision.intents.forEach((intent, i) => {
      const ik = `${keyOf(f, b)}:s${i}:${intent.type}`;
      let value = null;
      const res = journal.applyOnce(tx, { key: ik, aggregate: { type: FACTION_AGGREGATE, id: String(f) },
        eventType: EVENT_STRATEGY_INTENT, payload: { intent } }, (db) => {
        value = launchReactiveInTx(db, snapshot, intent, ik, at, graph);
        return value;
      });
      if (res.ok && !res.duplicate) {
        out.launches.push({ target: intent.target.systemId, fleets: value.fleets, kind: intent.kind,
          ...(value.scan ? { scan: value.scan } : {}) });
        return;
      }
      if (res.ok) return;
      const refusal = res.reason === "APPLY_REFUSED" ? res.refusal : res;
      out.refused.push(String((refusal && refusal.reason) || "REFUSED"));
      if (res.reason === "APPLY_FAILED") {
        log(`strategy: ${f} reactive r${b} intent ${intent.type} failed ${res.code || ""} ${messageOf(res.error)}`);
      }
    });
    return out;
  }

  function pruneSpecs(at, b) {
    const retention = S.reactiveDoneRetentionMs;
    const finishedBefore = Math.max(0, at - retention);
    const limit = S.reactivePruneBatch;
    const specs = [{ eventType: EVENT_TYPE, fromKey: `${SWEEP_PREFIX}${R}:`,
      toKey: sweepKeyOf(Math.max(0, bucketOf(at - retention) + 1)), finishedBefore, limit }];
    if (b % Math.ceil(retention / R) === 0) {
      specs.push({ eventType: EVENT_TYPE, fromKey: SWEEP_PREFIX, toKey: `${SWEEP_PREFIX.slice(0, -1)}${RANGE_END}`,
        finishedBefore, limit });
    }
    specs.push({ eventType: LEGACY_EVENT_TYPE, fromKey: KEY_PREFIX, toKey: `${KEY_PREFIX.slice(0, -1)}${RANGE_END}`,
      finishedBefore, limit });
    return specs;
  }

  function applySweep(tx, accepted, at, b, graph) {
    const out = { pruned: 0, pruneRefused: 0, factions: [] };
    if (S.reactivePruneBatch > 0) {
      for (const spec of pruneSpecs(at, b)) {
        const pr = scheduler.purgeDone(spec, { tx });
        if (pr && pr.ok) out.pruned += pr.deleted;
        else out.pruneRefused += 1;
      }
    }
    for (const x of accepted) {
      if (x.decision.intents.length > 0) out.factions.push(applyFaction(tx, x.decision, x.snapshot, at, graph));
    }
    return { ok: true, ...out };
  }

  function countBlockadeScan(scan) {
    const bk = blockadeFacade();
    if (bk && typeof bk.countScan === "function") call(() => bk.countScan(scan), null);
  }

  function countInterceptNotes(decision) {
    const now = new Set(decision.notes.filter((n) => n.startsWith(NO_FLEET_NOTE) || n.startsWith(CAPPED_NOTE)));
    const prev = interceptNoted.get(decision.factionId);
    let noFleet = 0;
    let capped = 0;
    for (const n of now) {
      if (prev && prev.has(n)) continue;
      if (n.startsWith(NO_FLEET_NOTE)) noFleet += 1;
      else capped += 1;
    }
    bump("interceptNoFleet", noFleet);
    bump("interceptCapped", capped);
    if (now.size > 0) interceptNoted.set(decision.factionId, now);
    else interceptNoted.delete(decision.factionId);
  }

  function countFaction(x, summary) {
    const decision = x.decision;
    bump("runs");
    if (!x.accepted) {
      bump("rowCapped");
      lastRefusal = `ROW_CAPPED:${decision.factionId}`;
    }
    else if (decision.outcome === "REACTED") bump("reacted");
    else if (decision.outcome === "IDLE") bump("idle");
    else {
      bump("skipped");
      if (decision.reason) lastRefusal = `DECIDE:${decision.reason}`;
    }
    if (decision.notes.includes("REACTIVE_CAPPED")) bump("capped");
    if (x.capScanTruncated) bump("capScanTruncated");
    if (x.accepted && !x.repeated) countInterceptNotes(decision);
    if (!x.accepted || !summary) return;
    const defended = new Set(decision.notes.filter((n) => n.startsWith("DEFENSE_LAUNCH:"))
      .map((n) => Number(n.slice("DEFENSE_LAUNCH:".length))));
    for (const l of summary.launches) {
      bump("launches");
      const kind = l.kind || "defense";
      if (kind === INTERCEPT_KIND) bump("intercepts");
      else bump(defended.has(l.target) ? "defenses" : "reliefs");
      if (l.scan) countBlockadeScan(l.scan);
      log(`strategy: ${decision.factionId} reactive r${decision.round} launch ${kind} -> ${l.target} `
        + `fleets=${l.fleets}`);
    }
    bump("interceptScanRefused", summary.refused.filter((r) => r === "INTERCEPT_SCAN_REFUSED").length);
    bump("intentRefused", summary.refused.length);
    if (summary.refused.length > 0) lastRefusal = `LAUNCH:${summary.refused[summary.refused.length - 1]}`;
  }

  function onSweepCommitted(read, decided, summary) {
    bump("sweeps");
    bump("fullReads", decided.filter((x) => x.full).length);
    bump("roundRepeated", decided.filter((x) => x.repeated).length);
    if (read.incomingTruncated === true) bump("interceptOpsTruncated");
    for (const s of read.skipped) {
      if (s.quiet) continue;
      bump("skipped");
      lastRefusal = `SKIP:${s.reason}`;
    }
    for (const fail of read.failed) {
      bump("readFailed");
      lastRefusal = `READ:${fail.reason}`;
    }
    const done = summary && summary.ok === true ? summary : null;
    const byFaction = new Map(done ? done.factions.map((x) => [x.factionId, x]) : []);
    for (const x of decided) countFaction(x, byFaction.get(x.decision.factionId) || (done ? EMPTY_SUMMARY : null));
    if (!done) return;
    bump("pruned", done.pruned);
    bump("pruneRefused", done.pruneRefused);
  }

  const validPayload = (p) => Boolean(p && Number.isSafeInteger(p.round) && p.round >= 0
    && Number.isSafeInteger(p.intervalMs) && Object.keys(p).every((k) => k === "round" || k === "intervalMs"));
  const validLegacyPayload = (p) => Boolean(p && isId(p.factionId) && Number.isSafeInteger(p.round) && p.round >= 0
    && Number.isSafeInteger(p.intervalMs)
    && Object.keys(p).every((k) => k === "factionId" || k === "round" || k === "intervalMs"));

  function handler(ev, hctx) {
    try {
      const p = ev && ev.payload;
      if (!validPayload(p)) return { ok: false, reason: "REACTIVE_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "STRATEGY_STOPPED" };
      if (S.reactiveEnabled !== true) return { ok: true, outcome: "SKIPPED", onCommitted: () => bump("skipped") };
      const at = hctx && Number.isSafeInteger(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      const next = nextOf(at);
      if (p.intervalMs !== R) return { ok: true, outcome: "STALE_INTERVAL", reschedule: next,
        onCommitted: () => bump("stale") };
      const graph = currentGraph();
      if (!graph) return { ok: true, outcome: "DEFERRED", reschedule: next, onCommitted: () => bump("deferred") };
      const b = bucketOf(at);
      const t0 = nowMs();
      const read = readSweep(b, at, graph);
      metric("observe", "strategy.reactiveReadMs", ms(t0));
      if (!read.ok) return { ok: false, reason: read.reason || "REACTIVE_READ_FAILED" };
      if (read.deferred) return { ok: true, outcome: "DEFERRED", reschedule: next, onCommitted: () => bump("deferred") };

      const t1 = nowMs();
      const decided = read.factions.map((r) => {
        if (!r.full) {
          return { decision: idleReactive(r.factionId, r.round), snapshot: null, capScanTruncated: false,
            accepted: true, full: false, repeated: r.repeated === true };
        }
        const decision = decideReactive(r.snapshot, params);
        threwLog.note(r.snapshot.factionId, decision);
        return { decision, snapshot: r.snapshot, capScanTruncated: r.capScanTruncated === true, accepted: true,
          full: true };
      });
      metric("observe", "strategy.reactiveDecideMs", ms(t1));

      const room = config.persistence.maxRowsPerTransaction - (REVIEW_ROWS.done + ROW_RESERVE
        + PRUNE_RANGES * S.reactivePruneBatch) - fortressTxRowsOf(config) - battleAnnounceTxRowsOf(config)
        - transitTxRowsOf(config) - listeningPostTxRowsOf(config);
      const perIntent = reactiveIntentRowsOf(withDepartureRows(S, config));
      let used = 0;
      for (const x of decided) {
        const need = x.decision.intents.length * perIntent;
        if (need === 0) continue;
        if (used + need > room) x.accepted = false;
        else used += need;
      }
      const accepted = decided.filter((x) => x.accepted);
      const outcome = accepted.some((x) => x.decision.outcome === "REACTED") ? "REACTED" : "IDLE";
      const needsEffect = S.reactivePruneBatch > 0 || accepted.some((x) => x.decision.intents.length > 0);
      return { ok: true, outcome, reschedule: next,
        ...(needsEffect ? { effect: (tx) => applySweep(tx, accepted, at, b, graph) } : {}),
        onCommitted: (summary) => onSweepCommitted(read, decided, summary) };
    } catch (err) {
      return { ok: false, reason: `REACTIVE_FAILED: ${messageOf(err)}` };
    }
  }

  function legacyHandler(ev) {
    try {
      const p = ev && ev.payload;
      if (!validLegacyPayload(p)) return { ok: false, reason: "REACTIVE_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "STRATEGY_STOPPED" };
      return { ok: true, outcome: "SUPERSEDED", onCommitted: () => bump("superseded") };
    } catch (err) {
      return { ok: false, reason: `REACTIVE_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (stopped) return { ok: false, reason: "STRATEGY_STOPPED" };
      if (S.reactiveEnabled !== true) return { ok: true, enqueued: 0, duplicates: 0 };
      const ready = call(() => scheduler.getStatus().state === SCHEDULER_READY, false);
      if (!ready || typeof scheduler.enqueueMany !== "function") return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
      const n = nextOf(clock.now());
      const r = scheduler.enqueueMany([{ eventType: EVENT_TYPE, aggregateId: SWEEP_AGGREGATE_ID, dueAt: n.dueAt,
        payload: n.payload, idempotencyKey: n.idempotencyKey }]);
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      bootstrapped = { enqueued: r.enqueued, duplicates: r.duplicates,
        reason: r.refusal ? String(r.refusal.reason) : null };
      bump("bootstrapEnqueued", r.enqueued);
      bump("bootstrapDuplicates", r.duplicates);
      return { ok: true, enqueued: r.enqueued, duplicates: r.duplicates };
    } catch (err) {
      return { ok: false, reason: `BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "on", enabled: S.reactiveEnabled === true, intervalMs: R,
      counters: Object.freeze({ ...counters }), lastRefusal, bootstrap: Object.freeze({ ...bootstrapped }) });
  }

  return Object.freeze({
    handler,
    legacyHandler,
    bootstrap,
    getStatus,
    schedule: Object.freeze({ phase, bucketOf, dueOf, sweepKeyOf, keyOf, nextOf }),
    stop() {
      stopped = true;
    },
  });
}

module.exports = { createReactiveService, EVENT_TYPE, LEGACY_EVENT_TYPE, COUNTER_NAMES };
