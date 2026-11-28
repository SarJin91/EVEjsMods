"use strict";

const { performance } = require("node:perf_hooks");
const S = require("../schema");
const { ACTION, decideStep } = require("./tripMachine");
const { richnessOf: richnessCore, computeLoad, scaleBands, mineralFactors, scaleCargo, cargoUnits } = require("./yield");
const { createMiningRates } = require("./rates");
const { nextReconcileKey } = require("../reconcileSlots");
const { ownSpaceSystems } = require("./ownSpace");
const { canMineIn, stationExemptionOf } = require("../../strategy/ai/miningControl");

const rawInfluenceOf = (row, factionId) => {
  const mine = Array.isArray(row.influence) ? row.influence.find((x) => x.factionId === factionId) : null;
  return mine && Number.isFinite(mine.influenceScore) ? Math.floor(mine.influenceScore) : 0;
};

const SCHEDULER_READY = "ready";
const STATION_MODE_READY = "ready";
const STATION_ONLINE = "ONLINE";
const ROUTE_SKIP_REASONS = Object.freeze(["SAME_SYSTEM", "TOO_FAR", "UNREACHABLE", "UNKNOWN_SYSTEM",
  "NO_RETREAT_TARGET"]);
const STOCK_FULL_REASONS = Object.freeze(["STOCK_CAP", "STOCK_ITEMS_LIMIT"]);
const MAX_DETAIL = 120;
const MS_DECIMALS = 100;
const COUNTER_NAMES = Object.freeze(["dispatched", "localStarts", "started", "loaded", "emptyLoads", "delivered",
  "deliveredUnits", "lostUnits", "aborted", "lost", "stale", "waits", "reseek", "timeouts", "stockRefused",
  "reconciled", "pruned", "beltsFallback", "ignored", "orphansReleased", "dispatchRefused", "reconcileExhausted",
  "boostedLoads",
  "battleEnded"]);
const EMPTY_LOAD = Object.freeze({ oreM3: 0, minerals: Object.freeze({}), boosted: 0, booster: null });
const DUE_KEYS = Object.freeze(["phaseSeq", "round", "tripId"]);
const NUDGE_KEYS = Object.freeze(["at", "fleetId", "legSeq", "state"]);
const SAVEPOINT_ABORT = Symbol("mining-savepoint-abort");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= S.MAX_ID_LENGTH;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const sameKeys = (p, keys) => Object.keys(p).sort().join() === keys.join();

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parsePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (sameKeys(p, DUE_KEYS)) {
    if (!isText(p.tripId) || !isTime(p.phaseSeq) || !isTime(p.round)) return null;
    return { kind: "due", tripId: p.tripId, phaseSeq: p.phaseSeq, round: p.round };
  }
  if (sameKeys(p, NUDGE_KEYS)) {
    if (!isText(p.fleetId) || !isTime(p.legSeq) || typeof p.state !== "string" || !isTime(p.at)) return null;
    return { kind: "nudge", fleetId: p.fleetId, legSeq: p.legSeq, state: p.state, at: p.at };
  }
  return null;
}

function createMiningService(deps) {
  const { store, trips, fleets, scheduler, clock, ids, config } = deps;
  const M = config.mining;
  const worldRepo = deps.world.repository;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const yieldParams = Object.freeze({ bandFactorPermille: Object.freeze({ highsec: M.bandFactorHighsecPermille,
    lowsec: M.bandFactorLowsecPermille, nullsec: M.bandFactorNullsecPermille }), beltCap: M.beltCap,
  anomalySitesPerSystem: M.anomalySitesPerSystem, siteSaturation: M.siteSaturation,
  refineYieldPermille: M.refineYieldPermille });
  const rates = createMiningRates(M);
  const bands = scaleBands(Object.fromEntries(S.YIELD_SEC_CLASSES.map((c) => {
    const band = deps.industryCatalog.oreBand(c);
    return [c, band ? band.mineralsPerMillionM3 : null];
  }).filter(([, b]) => b)), mineralFactors(M));
  const machineParams = Object.freeze({ maxWatchRounds: M.maxWatchRounds });
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const belts = new Map();
  let state = "pending";
  let lastRefusal = null;
  let seq = 0;

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
    seq += 1;
    metric("count", `mining.${name}`, n);
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

  function stationsNow() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const mode = st && typeof st.getMode === "function" ? call(() => st.getMode(), "off") : "off";
    return { st, mode, locator: mode === STATION_MODE_READY && st ? st.locator : null,
      repository: mode === STATION_MODE_READY && st ? st.repository : null };
  }

  function beltsOf(systemId) {
    if (belts.has(systemId)) return belts.get(systemId);
    const adapter = deps.adapter;
    const r = adapter && typeof adapter.readSystemBelts === "function"
      ? call(() => adapter.readSystemBelts([systemId]), null) : null;
    if (r && r.ok === true && r.counts instanceof Map && Number.isSafeInteger(r.counts.get(systemId))) {
      const n = r.counts.get(systemId);
      belts.set(systemId, n);
      return n;
    }
    bump("beltsFallback");
    return M.defaultBeltsPerSystem;
  }

  function richnessOf(systemId) {
    if (state !== "ready") return { ok: false, reason: state === "pending" ? "MINING_PENDING" : "MINING_STOPPED" };
    const g = currentGraph();
    if (!g) return { ok: false, reason: "GRAPH_NOT_READY" };
    const v = g.getSystem(systemId);
    if (!v) return { ok: false, reason: "UNKNOWN_SYSTEM" };
    return { ok: true, ...richnessCore({ secClass: v.secClass, belts: beltsOf(systemId) }, yieldParams) };
  }

  function warmUp() {
    if (state === "stopped") return;
    const g = currentGraph();
    const first = g && typeof g.getSystemIds === "function" ? (g.getSystemIds() || [])[0] : undefined;
    if (isId(first)) {
      const t0 = nowMs();
      beltsOf(first);
      metric("observe", "mining.beltsWarmUpMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    }
    state = "ready";
    seq += 1;
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "MINING_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function enqueueStep(tx, tripId, phaseSeq, round, dueAt) {
    const r = scheduler.enqueue(S.EVENT_TYPE, tripId, dueAt, { tripId, phaseSeq, round },
      S.dueKey(tripId, phaseSeq, round), { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "step" };
    return { ok: true };
  }

  function doctrineSpaceOf(factionId) {
    const reg = deps.registry;
    const entry = reg && typeof reg.getFaction === "function" ? call(() => reg.getFaction(factionId), null) : null;
    if (!entry) return { ownSpace: null, allies: [] };
    const doctrine = typeof reg.getDoctrine === "function" ? call(() => reg.getDoctrine(entry.doctrineId), null) : null;
    return { ownSpace: doctrine && doctrine.ownSpace ? doctrine.ownSpace : null,
      allies: Array.isArray(entry.allies) ? entry.allies : [] };
  }

  function ownStationHereOf(tx, factionId, systemId) {
    const { repository } = stationsNow();
    if (!repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const r = repository.listStationsInSystem(tx, systemId);
    if (!r || !r.ok) return r || { ok: false, reason: "STATIONS_READ_FAILED" };
    return { ok: true, value: r.records.some((x) => x.ownerFactionId === factionId && x.state === STATION_ONLINE) };
  }

  function controlOf(tx, spec) {
    const r = worldRepo.getSystem(tx, spec.beltSystemId);
    if (!r || !r.ok) return r || { ok: false, reason: "WORLD_READ_FAILED" };
    if (r.system) {
      const row = r.system;
      let opts = null;
      if (M.ownStationSystemsEnabled === true && row.controllerFactionId !== spec.factionId) {
        const here = ownStationHereOf(tx, spec.factionId, spec.beltSystemId);
        if (!here.ok) return here;
        opts = { ownStationHere: stationExemptionOf({ factionId: spec.factionId,
          controllerFactionId: row.controllerFactionId, ownStationHere: here.value,
          ownInfluence: rawInfluenceOf(row, spec.factionId), minInfluence: M.ownStationMinInfluence }) };
      }
      return { ok: true, controlled: canMineIn(spec.factionId, row, null, null, null, opts) };
    }
    if (!(M.ownSpaceScanSystems > 0)) return { ok: true, controlled: false };
    const g = currentGraph();
    if (!g) return { ok: false, reason: "GRAPH_NOT_READY" };
    const fromRegistry = spec.ownSpace === undefined ? doctrineSpaceOf(spec.factionId) : null;
    const ownSpace = fromRegistry ? fromRegistry.ownSpace
      : (spec.ownSpace && typeof spec.ownSpace === "object" ? spec.ownSpace : null);
    const allies = fromRegistry ? fromRegistry.allies : (Array.isArray(spec.allies) ? spec.allies : null);
    return { ok: true, controlled: canMineIn(spec.factionId, null, call(() => g.getSystem(spec.beltSystemId), null),
      ownSpace, allies) };
  }

  function readOwnSpaceSites(tx, factionId, fromSystemIds) {
    if (state !== "ready" || !(M.ownSpaceScanSystems > 0) || !isId(factionId)) return { ok: true, sites: [] };
    const g = currentGraph();
    if (!g) return { ok: true, sites: [] };
    const ids = ownSpaceSystems({ fromSystemIds: Array.isArray(fromSystemIds) ? fromSystemIds : [], factionId,
      getSystem: (id) => g.getSystem(id), neighbors: (id) => g.getNeighbors(id), maxJumps: M.maxTripJumps,
      maxSystems: M.ownSpaceScanSystems });
    const batch = worldRepo.limits && isId(worldRepo.limits.maxBatchReadIds) ? worldRepo.limits.maxBatchReadIds : 1;
    const missing = [];
    for (let i = 0; i < ids.length; i += batch) {
      const r = worldRepo.getSystems(tx, ids.slice(i, i + batch), { includeInfluence: false });
      if (!r || !r.ok) return r || { ok: false, reason: "WORLD_READ_FAILED" };
      missing.push(...r.missing);
    }
    const sites = [];
    for (const id of missing.sort((a, b) => a - b)) {
      const rich = richnessOf(id);
      if (rich.ok && rich.richnessPermille > 0) {
        sites.push({ systemId: id, richnessPermille: rich.richnessPermille, projected: true });
      }
    }
    return { ok: true, sites };
  }

  function getOperation(tx, operationId) {
    if (!operationId) return { ok: true, operation: null };
    return fleets.repository.getOperation(tx, operationId);
  }

  function release(tx, fleet, operationIds, key, close) {
    let version = fleet ? fleet.version : null;
    let operationId = null;
    if (fleet && ["STAGED", "PLANNED"].includes(fleet.state) && operationIds.includes(fleet.operationId)) {
      operationId = fleet.operationId;
      const r = fleets.repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: fleet.state, to: "IDLE" }, `${key}:rel`);
      if (!r.ok) return { ...r, stage: "release" };
      if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:rel` };
      version = r.version;
    }
    for (const id of close ? operationIds.filter((x) => x) : []) {
      const o = getOperation(tx, id);
      if (!o.ok) return o;
      const op = o.operation;
      if (!op || !["PLANNED", "ACTIVE"].includes(op.state)) continue;
      const to = op.state === "PLANNED" ? "CANCELLED" : close.to;
      const c = fleets.repository.transitionOperation(tx, { operationId: id, expectedVersion: op.version,
        from: op.state, to, result: close.result }, `${key}:close:${id}`);
      if (!c.ok) {
        if (c.reason === "OPERATION_HAS_FLEETS") continue;
        return { ...c, stage: "close" };
      }
    }
    return { ok: true, version, releasedFrom: operationId };
  }

  function dispatchInTx(tx, spec, idempotencyKey) {
    if (state === "stopped") return { ok: false, reason: "MINING_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!spec || !isId(spec.factionId) || !isText(spec.fleetId) || !isId(spec.beltSystemId) || !isTime(spec.at)
      || !Number.isSafeInteger(spec.expectedVersion) || spec.expectedVersion < 1
      || typeof idempotencyKey !== "string" || idempotencyKey.length < 1
      || idempotencyKey.length > S.MAX_KEY_LENGTH - 10) {
      return { ok: false, reason: "MINING_INVALID_INPUT" };
    }
    const tripKey = `${idempotencyKey}:trip`;
    const earlier = trips.tripIdOfKey(tx, tripKey);
    if (!earlier.ok) return earlier;
    if (earlier.duplicate) {
      const t = trips.getTrip(tx, earlier.tripId);
      if (!t.ok) return t;
      return { ok: true, duplicate: true, tripId: earlier.tripId, state: t.trip ? t.trip.state : null };
    }
    if (state !== "ready") return { ok: false, reason: "MINING_PENDING" };
    const { mode } = stationsNow();
    if (mode !== STATION_MODE_READY) return { ok: false, reason: "STATIONS_NOT_READY" };
    const f = fleets.repository.getFleet(tx, spec.fleetId);
    if (!f.ok) return f;
    const fleet = f.fleet;
    if (!fleet || fleet.factionId !== spec.factionId || fleet.fleetRole !== S.MINING_ROLE) {
      return { ok: false, reason: "NOT_A_MINER" };
    }
    if (fleet.version !== spec.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: spec.expectedVersion,
        actualVersion: fleet.version };
    }
    if (fleet.state !== "IDLE") return { ok: false, reason: "FLEET_NOT_IDLE", state: fleet.state };
    if (fleet.refitPending === true) return { ok: false, reason: "REFIT_PENDING" };
    const open = trips.findOpenByFleet(tx, fleet.fleetId);
    if (!open.ok) return open;
    if (open.trip) return { ok: false, reason: "TRIP_OPEN", tripId: open.trip.tripId };
    const inBelt = trips.countOpenInBelt(tx, spec.beltSystemId);
    if (!inBelt.ok) return inBelt;
    if (inBelt.count >= M.maxFleetsPerSystem) return { ok: false, reason: "MINING_SYSTEM_FULL", count: inBelt.count };
    const ofFaction = trips.countOpenOfFaction(tx, spec.factionId);
    if (!ofFaction.ok) return ofFaction;
    if (ofFaction.count >= M.maxFleetsPerFaction) return { ok: false, reason: "MINING_FLEET_LIMIT" };
    const ctl = controlOf(tx, spec);
    if (!ctl.ok) return ctl;
    if (ctl.controlled !== true) return { ok: false, reason: "NOT_CONTROLLED" };
    const rich = richnessOf(spec.beltSystemId);
    if (!rich.ok) return rich;
    if (rich.richnessPermille <= 0) return { ok: false, reason: "NO_YIELD" };
    const tripId = ids.next("mt");
    const local = fleet.currentSystemId === spec.beltSystemId;
    const at = spec.at;
    return inSavepoint(tx, () => {
      const pruned = trips.prune(tx, spec.factionId, Math.max(0, at - M.tripRetentionMs), M.pruneBatch);
      if (!pruned.ok) return pruned;
      const op = fleets.repository.createOperation(tx, { operationType: S.MINING_OPERATION_TYPE,
        factionId: spec.factionId, originSystemId: fleet.currentSystemId, targetSystemId: spec.beltSystemId,
        objective: S.OBJECTIVE_MINE, dueAt: null, fleets: [{ fleetId: fleet.fleetId,
          expectedVersion: fleet.version }] }, `${idempotencyKey}:op`);
      if (!op.ok) return op;
      if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${idempotencyKey}:op` };
      const created = trips.createTrip(tx, { tripId, idempotencyKey, factionId: spec.factionId,
        fleetId: fleet.fleetId, outboundOperationId: op.operationId, originSystemId: fleet.currentSystemId,
        beltSystemId: spec.beltSystemId, secClass: rich.secClass, richnessPermille: rich.richnessPermille,
        dispatchedAt: at }, tripKey);
      if (!created.ok) return created;
      if (!local) {
        const plan = fleets.travel.planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: spec.beltSystemId, at },
          `${idempotencyKey}:plan`, { chained: true });
        if (!plan.ok) return plan;
        const ev = enqueueStep(tx, tripId, 0, 0, plan.arriveAt + M.watchGraceMs);
        if (!ev.ok) return ev;
        return { ok: true, duplicate: false, tripId, state: S.OUTBOUND, arriveAt: plan.arriveAt, pruned: pruned.pruned,
          local: false };
      }
      const act = fleets.repository.transitionOperation(tx, { operationId: op.operationId, expectedVersion: 1,
        from: "PLANNED", to: "ACTIVE" }, `${idempotencyKey}:op-active`);
      if (!act.ok) return act;
      const again = fleets.repository.getFleet(tx, fleet.fleetId);
      if (!again.ok || !again.fleet) return again.ok ? { ok: false, reason: "FLEET_NOT_FOUND" } : again;
      const staged = fleets.repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: again.fleet.version,
        from: "PLANNED", to: "STAGED" }, `${idempotencyKey}:stage`);
      if (!staged.ok) return staged;
      const trip = trips.getTrip(tx, tripId);
      if (!trip.ok || !trip.trip) return trip.ok ? { ok: false, reason: "ROW_NOT_FOUND" } : trip;
      const endsAt = at + M.shiftMs;
      const moved = trips.transitionTrip(tx, { tripId, expectedVersion: trip.trip.version, from: S.OUTBOUND,
        to: S.MINING, patch: { phaseSeq: 1, watchRound: 0, miningStartedAt: at, miningEndsAt: endsAt } },
      `${idempotencyKey}:start`);
      if (!moved.ok) return moved;
      const ev = enqueueStep(tx, tripId, 1, 0, endsAt);
      if (!ev.ok) return ev;
      return { ok: true, duplicate: false, tripId, state: S.MINING, pruned: pruned.pruned, local: true };
    });
  }

  function planReturn(tx, trip, fleetId, factionId, from, at, key) {
    const st = stationsNow();
    if (!st.locator) return { ok: false, reason: "STATIONS_NOT_READY" };
    const found = st.locator.findNearestStations(tx, { factionId, fromSystemId: from });
    if (!found || found.ok !== true) return found || { ok: false, reason: "STATIONS_READ_FAILED" };
    const targets = found.targets;
    if (targets[0] === from) return { ok: true, here: true };
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const f = fleets.repository.getFleet(tx, fleetId);
      if (!f.ok || !f.fleet) return f.ok ? { ok: false, reason: "FLEET_NOT_FOUND" } : f;
      const r = inSavepoint(tx, () => {
        const op = fleets.repository.createOperation(tx, { operationType: S.MINING_OPERATION_TYPE, factionId,
          originSystemId: from, targetSystemId: target, objective: S.OBJECTIVE_DELIVER, dueAt: null,
          fleets: [{ fleetId, expectedVersion: f.fleet.version }] }, `${key}:op:${i}`);
        if (!op.ok) return op;
        if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:op:${i}` };
        const plan = fleets.travel.planInTx(tx, { fleetId, targetSystemId: target, at }, `${key}:plan:${i}`,
          { chained: true });
        if (!plan.ok) return plan;
        return { ok: true, operationId: op.operationId, target, arriveAt: plan.arriveAt };
      });
      if (r.ok) return r;
      if (!ROUTE_SKIP_REASONS.includes(r.reason)) return r;
    }
    return { ok: true, none: true };
  }

  function deliverInTx(tx, trip, fleet, stationId, at, key, out) {
    const cargo = trip.cargo || {};
    const scaled = scaleCargo(cargo, trip.shipsAtLoad || 1, fleet.shipCount);
    const keys = Object.keys(scaled.deliver).sort();
    if (keys.length > 0) {
      const st = stationsNow();
      if (!st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
      const stock = st.repository.applyStockChange(tx, { stationId, key: S.dropKey(trip.tripId),
        reason: S.DELIVERY_REASON, at, deltas: keys.map((k) => ({ itemKind: S.MINERAL_ITEM_KIND, itemKey: k,
          delta: scaled.deliver[k] })) });
      if (!stock.ok) return { ...stock, stage: "stock" };
    }
    const rel = release(tx, fleet, [trip.returnOperationId, trip.outboundOperationId], key,
      { to: "COMPLETED", result: { closedBy: "mining", delivered: cargoUnits(scaled.deliver) } });
    if (!rel.ok) return rel;
    const units = cargoUnits(scaled.deliver);
    const moved = trips.transitionTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version, from: S.RETURNING,
      to: S.DELIVERED, patch: { phaseSeq: trip.phaseSeq + 1, deliveredStationId: stationId, delivered: scaled.deliver,
        lostUnits: trip.lostUnits + scaled.lostUnits, endedAt: at,
        endReason: cargoUnits(cargo) > 0 ? "DELIVERED" : "EMPTY" },
    totals: { tripsDelivered: 1, mineralUnits: units, lostMineralUnits: scaled.lostUnits } }, `${key}:deliver`);
    if (!moved.ok) return moved;
    out.delivered = units;
    out.lostUnits = scaled.lostUnits;
    out.empty = cargoUnits(cargo) === 0;
    return { ok: true };
  }

  function endInTx(tx, trip, fleet, to, reason, at, key, out) {
    const rel = release(tx, fleet, [trip.outboundOperationId, trip.returnOperationId], key,
      { to: "FAILED", result: { closedBy: "mining", reason } });
    if (!rel.ok) return rel;
    const lost = to === S.LOST ? cargoUnits(trip.cargo) : 0;
    const moved = trips.transitionTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version, from: trip.state, to,
      patch: { phaseSeq: trip.phaseSeq + 1, endedAt: at, endReason: reason, lostUnits: trip.lostUnits + lost },
      totals: to === S.LOST ? { tripsLost: 1, lostMineralUnits: lost } : { tripsAborted: 1 } }, `${key}:end`);
    if (!moved.ok) return moved;
    out.lostUnits = lost;
    return { ok: true };
  }

  function returnInTx(tx, trip, fleetId, from, at, key, out, firstPatch, totals) {
    const plan = planReturn(tx, trip, fleetId, trip.factionId, from, at, key);
    if (!plan.ok) return plan;
    const next = trip.phaseSeq + 1;
    let patch;
    let due;
    let round = 0;
    if (plan.here || plan.none) {
      round = plan.none ? (firstPatch ? 1 : trip.watchRound + 1) : 0;
      patch = { ...(firstPatch || {}), phaseSeq: next, watchRound: round, returnOperationId: null,
        returnSystemId: plan.here ? from : null };
      due = at + M.returnSeekRecheckMs;
    } else {
      patch = { ...(firstPatch || {}), phaseSeq: next, watchRound: 0, returnOperationId: plan.operationId,
        returnSystemId: plan.target };
      due = plan.arriveAt + M.watchGraceMs;
    }
    const moved = trips.transitionTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version, from: trip.state,
      to: S.RETURNING, patch, ...(totals ? { totals } : {}) }, `${key}:trip`);
    if (!moved.ok) return moved;
    if (plan.here) {
      const st = stationsNow();
      const has = st.locator.hasRepairStation(tx, trip.factionId, from);
      if (!has || has.ok !== true || has.stationId === null) {
        return has || { ok: false, reason: "STATIONS_READ_FAILED" };
      }
      const f = fleets.repository.getFleet(tx, fleetId);
      if (!f.ok || !f.fleet) return f.ok ? { ok: false, reason: "FLEET_NOT_FOUND" } : f;
      return deliverInTx(tx, moved.trip, f.fleet, has.stationId, at, key, out);
    }
    if (plan.none) out.noStation = true;
    return enqueueStep(tx, trip.tripId, next, round, due);
  }

  function readFacts(tx, trip, fleet, trigger, at) {
    const st = stationsNow();
    let stationHere = false;
    let stationId = null;
    if (st.locator && fleet && fleet.state !== "DESTROYED") {
      const has = st.locator.hasRepairStation(tx, trip.factionId, fleet.currentSystemId);
      if (!has || has.ok !== true) return has || { ok: false, reason: "STATIONS_READ_FAILED" };
      stationId = has.stationId;
      stationHere = stationId !== null;
    }
    return { ok: true, facts: { at, trigger, stationHere, stationsMode: st.mode }, stationId };
  }

  function releaseOrphan(tx, fleet, key, out) {
    if (!fleet || fleet.fleetRole !== S.MINING_ROLE || fleet.state !== "STAGED" || !fleet.operationId) {
      return { ok: true };
    }
    const o = getOperation(tx, fleet.operationId);
    if (!o.ok) return o;
    if (!o.operation || o.operation.operationType !== S.MINING_OPERATION_TYPE) return { ok: true };
    const rel = release(tx, fleet, [fleet.operationId], key, { to: "FAILED",
      result: { closedBy: "mining", reason: "ORPHAN" } });
    if (rel.ok) out.orphan = true;
    return rel;
  }

  function releaseOrphanInTx(tx, spec, key) {
    if (state === "stopped") return { ok: false, reason: "MINING_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!spec || !isId(spec.factionId) || !isText(spec.fleetId) || !Number.isSafeInteger(spec.expectedVersion)
      || spec.expectedVersion < 1 || typeof key !== "string" || key.length < 1 || key.length > S.MAX_KEY_LENGTH - 40) {
      return { ok: false, reason: "MINING_INVALID_INPUT" };
    }
    const f = fleets.repository.getFleet(tx, spec.fleetId);
    if (!f.ok) return f;
    const fleet = f.fleet;
    if (!fleet || fleet.factionId !== spec.factionId || fleet.fleetRole !== S.MINING_ROLE) {
      return { ok: false, reason: "NOT_A_MINER" };
    }
    if (fleet.version !== spec.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: spec.expectedVersion,
        actualVersion: fleet.version };
    }
    if (!["STAGED", "PLANNED"].includes(fleet.state) || !fleet.operationId) {
      return { ok: false, reason: "NOT_AN_ORPHAN", state: fleet.state };
    }
    const o = getOperation(tx, fleet.operationId);
    if (!o.ok) return o;
    if (!o.operation || o.operation.operationType !== S.MINING_OPERATION_TYPE) {
      return { ok: false, reason: "NOT_AN_ORPHAN", detail: "operation" };
    }
    const open = trips.findOpenByFleet(tx, fleet.fleetId);
    if (!open.ok) return open;
    if (open.trip) return { ok: false, reason: "TRIP_OPEN", tripId: open.trip.tripId };
    const rel = release(tx, fleet, [fleet.operationId], key, { to: "FAILED",
      result: { closedBy: "mining", reason: "ORPHAN" } });
    if (!rel.ok) return rel;
    return { ok: true, released: true, operationId: rel.releasedFrom };
  }

  function step(tx, ev, p, trigger) {
    const out = { action: ACTION.STALE, reason: null };
    const key = ev.idempotencyKey;
    let trip;
    let fleet;
    if (p.kind === "due") {
      const t = trips.getTrip(tx, p.tripId);
      if (!t.ok) return t;
      trip = t.trip;
      if (!trip || trip.phaseSeq !== p.phaseSeq || trip.watchRound !== p.round) return { ok: true, ...out };
    } else {
      const t = trips.findOpenByFleet(tx, p.fleetId);
      if (!t.ok) return t;
      trip = t.trip;
      if (!trip) {
        const f = fleets.repository.getFleet(tx, p.fleetId);
        if (!f.ok) return f;
        const r = releaseOrphan(tx, f.fleet, key, out);
        return r.ok ? { ok: true, ...out } : r;
      }
    }
    const fr = fleets.repository.getFleet(tx, trip.fleetId);
    if (!fr.ok) return fr;
    fleet = fr.fleet;
    const at = p.kind === "nudge" ? p.at : ev.dueAt;
    const facts = readFacts(tx, trip, fleet, trigger, at);
    if (!facts.ok) return facts;
    const d = decideStep(trip, fleet, facts.facts, machineParams);
    out.action = d.action;
    out.reason = d.reason || null;
    out.tripId = trip.tripId;
    out.factionId = trip.factionId;
    switch (d.action) {
      case ACTION.STALE:
      case ACTION.IGNORE:
        return { ok: true, ...out };
      case ACTION.RETRY_LATER:
        return { ok: false, reason: d.reason };
      case ACTION.WAIT: {
        const round = trip.watchRound + 1;
        const w = trips.watchTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version, state: trip.state,
          watchRound: round }, `${key}:wait`);
        if (!w.ok) return w;
        const flightDue = fleet && isTime(fleet.nextActionAt) ? fleet.nextActionAt + M.watchGraceMs : 0;
        const ev2 = enqueueStep(tx, trip.tripId, trip.phaseSeq, round, Math.max(at + M.watchRecheckMs, flightDue));
        return ev2.ok ? { ok: true, ...out } : ev2;
      }
      case ACTION.START_MINING: {
        const endsAt = at + M.shiftMs;
        const moved = trips.transitionTrip(tx, { tripId: trip.tripId, expectedVersion: trip.version,
          from: S.OUTBOUND, to: S.MINING, patch: { phaseSeq: trip.phaseSeq + 1, watchRound: 0, miningStartedAt: at,
            miningEndsAt: endsAt } }, `${key}:trip`);
        if (!moved.ok) return moved;
        const ev2 = enqueueStep(tx, trip.tripId, trip.phaseSeq + 1, 0, endsAt);
        return ev2.ok ? { ok: true, ...out } : ev2;
      }
      case ACTION.LOAD: {
        const loadAt = trip.miningEndsAt;
        const departAt = trip.watchRound === 0 ? loadAt : at;
        const ctl = controlOf(tx, { factionId: trip.factionId, beltSystemId: trip.beltSystemId });
        if (!ctl.ok) return ctl;
        const controlled = ctl.controlled === true;
        const shiftMs = Math.max(0, trip.miningEndsAt - (trip.miningStartedAt === null ? trip.miningEndsAt
          : trip.miningStartedAt));
        const load = controlled ? computeLoad({ composition: fleet.composition, shiftMs,
          richnessPermille: trip.richnessPermille, secClass: trip.secClass }, yieldParams, rates, bands)
          : EMPTY_LOAD;
        const rel = release(tx, fleet, [trip.outboundOperationId], key, { to: "COMPLETED",
          result: { closedBy: "mining", oreUnits: load.oreM3 } });
        if (!rel.ok) return rel;
        out.oreUnits = load.oreM3;
        out.beltDebit = { systemId: trip.beltSystemId, fleetId: fleet.fleetId,
          worldSeed: deps.worldSeed, oreM3: load.oreM3 };
        out.boosted = load.boosted;
        out.empty = cargoUnits(load.minerals) === 0;
        if (!controlled) out.reason = "CONTROL_LOST";
        const r = returnInTx(tx, trip, fleet.fleetId, fleet.currentSystemId, departAt, key, out,
          { cargo: load.minerals, shipsAtLoad: Math.max(1, fleet.shipCount), loadedAt: loadAt },
          { oreUnits: load.oreM3 });
        return r.ok ? { ok: true, ...out } : r;
      }
      case ACTION.DELIVER: {
        const r = deliverInTx(tx, trip, fleet, facts.stationId, at, key, out);
        if (r.ok) return { ok: true, ...out };
        if (STOCK_FULL_REASONS.includes(r.reason)) {
          out.action = ACTION.LOSE;
          out.reason = "STOCK_FULL";
          out.stockRefused = true;
          const e = endInTx(tx, trip, fleet, S.LOST, "STOCK_FULL", at, key, out);
          return e.ok ? { ok: true, ...out } : e;
        }
        if (r.reason === "STATION_DESTROYED") {
          out.action = ACTION.RESEEK;
          out.reason = "STATION_DESTROYED";
          return reseek(tx, trip, fleet, at, key, out);
        }
        return r;
      }
      case ACTION.RESEEK:
        return reseek(tx, trip, fleet, at, key, out);
      case ACTION.ABORT:
      case ACTION.LOSE: {
        if (d.reason === "FLEET_DESTROYED" || (fleet && fleet.state === "RETREATING")) out.battle = true;
        const e = endInTx(tx, trip, fleet, d.action === ACTION.LOSE ? S.LOST : S.ABORTED, d.reason || "ABORTED", at,
          key, out);
        return e.ok ? { ok: true, ...out } : e;
      }
      default:
        return { ok: false, reason: "UNKNOWN_ACTION", permanent: true };
    }
  }

  function reseek(tx, trip, fleet, at, key, out) {
    const rel = release(tx, fleet, [trip.returnOperationId], key, { to: "FAILED",
      result: { closedBy: "mining", reason: "RESEEK" } });
    if (!rel.ok) return rel;
    const r = returnInTx(tx, trip, fleet.fleetId, fleet.currentSystemId, at, key, out, null, null);
    return r.ok ? { ok: true, ...out } : r;
  }

  function onCommitted(v) {
    if (!v || v.ok !== true) return;
    if (v.orphan) bump("orphansReleased");
    switch (v.action) {
      case ACTION.STALE: bump("stale"); break;
      case ACTION.IGNORE: bump("ignored"); break;
      case ACTION.WAIT: bump("waits"); break;
      case ACTION.START_MINING: bump("started"); break;
      case ACTION.LOAD:
        bump("loaded");
        if (v.empty) bump("emptyLoads");
        if (v.boosted > 0) bump("boostedLoads");
        const simulation = deps.config.population?.simulation;
        if (simulation?.worldImpacts !== false && simulation?.beltDepletion !== false && v.beltDebit && v.beltDebit.oreM3 > 0 && typeof deps.adapter?.debitBeltOre === "function") {
          try {
            const debit = deps.adapter.debitBeltOre(v.beltDebit);
            if (debit.ok && debit.debitedM3 > 0) {
              log(`mining: trip ${v.tripId} system ${v.beltDebit.systemId} sites=${debit.siteIds.join(",")} scene=${debit.detached ? "detached" : "loaded"} debited ${debit.debitedM3.toFixed(2)} of ${v.oreUnits} m3`);
            } else if (!debit.ok && debit.reason !== "SCENE_UNLOADED") {
              log(`mining: trip ${v.tripId} belt debit skipped: ${debit.reason}`);
            }
          } catch (err) {
            log(`mining: trip ${v.tripId} belt debit failed: ${messageOf(err)}`);
          }
        }
        break;
      case ACTION.RESEEK: bump("reseek"); break;
      case ACTION.ABORT: bump("aborted"); break;
      case ACTION.LOSE: bump("lost"); break;
      default: break;
    }
    if (v.action === ACTION.DELIVER || v.delivered !== undefined) {
      bump("delivered");
      bump("deliveredUnits", v.delivered || 0);
    }
    if (v.reason === "TIMEOUT") bump("timeouts");
    if (v.stockRefused) bump("stockRefused");
    if (v.battle) bump("battleEnded");
    bump("lostUnits", v.lostUnits || 0);
    if (v.action === ACTION.LOSE || v.reason === "TIMEOUT") {
      log(`mining: trip ${v.tripId} of ${v.factionId} ${v.action} ${v.reason || ""} lost=${v.lostUnits || 0}`);
    }
  }

  function handler(ev, hctx) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "MINING_PAYLOAD_INVALID", permanent: true };
      if (state === "stopped") return { ok: false, reason: "MINING_STOPPED" };
      const trigger = p.kind === "nudge" ? "arrival"
        : (String(ev.idempotencyKey).startsWith("mining:rec:") ? "reconcile" : "due");
      const t0 = nowMs();
      return { ok: true, outcome: "STEP", effect: (tx) => {
        const r = step(tx, ev, p, trigger);
        metric("observe", "mining.stepMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
        if (!r || r.ok !== true) lastRefusal = String((r && r.reason) || "STEP_FAILED");
        return r;
      }, onCommitted };
    } catch (err) {
      return { ok: false, reason: `MINING_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function onArrival(tx, a) {
    if (state === "stopped" || !a || a.fleetRole !== S.MINING_ROLE) return;
    scheduler.enqueue(S.EVENT_TYPE, a.fleetId, a.at, { fleetId: a.fleetId, legSeq: a.legSeq, state: a.state, at: a.at },
      S.nudgeKey(a.fleetId, a.legSeq, a.state), { tx, chained: true });
  }

  function reconcile() {
    try {
      const listed = store.transaction("mining.reconcileRead", (db) => trips.listOpen(db,
        { limit: M.reconcileMaxTrips }));
      const r = listed.ok ? listed.value : listed;
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
      let enqueued = 0;
      let exhausted = 0;
      const now = clock.now();
      for (const t of r.trips) {
        const slot = nextReconcileKey(scheduler, { dueKey: S.dueKey(t.tripId, t.phaseSeq, t.watchRound),
          baseKey: S.reconcileKey(t.tripId, t.phaseSeq, t.watchRound), maxAttempts: M.reconcileMaxAttempts });
        if (!slot.ok) return slot;
        if (slot.open) continue;
        if (slot.exhausted) {
          exhausted += 1;
          log(`mining: reconcile ${t.tripId} exhausted ${M.reconcileMaxAttempts} attempts`);
          continue;
        }
        const e = scheduler.enqueue(S.EVENT_TYPE, t.tripId, Math.max(now, t.miningEndsAt || 0),
          { tripId: t.tripId, phaseSeq: t.phaseSeq, round: t.watchRound }, slot.key);
        if (e && e.ok && !e.duplicate) enqueued += 1;
        else if (!e || !e.ok) log(`mining: reconcile ${t.tripId} refused ${(e && e.reason) || "?"}`);
      }
      bump("reconciled", enqueued);
      bump("reconcileExhausted", exhausted);
      return { ok: true, open: r.trips.length, enqueued, exhausted };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function readSiteState(tx, factionId) {
    const r = trips.listOpenOfFaction(tx, factionId, M.maxFleetsPerFaction + M.reconcileMaxTrips);
    if (!r.ok) return r;
    const byBelt = new Map();
    for (const t of r.trips) byBelt.set(t.beltSystemId, (byBelt.get(t.beltSystemId) || 0) + 1);
    const openTrips = Object.freeze(r.trips.map((t) => Object.freeze({ tripId: t.tripId, fleetId: t.fleetId,
      systemId: t.beltSystemId, secClass: t.secClass, state: t.state,
      miningEndsAt: Number.isSafeInteger(t.miningEndsAt) ? t.miningEndsAt : null })));
    return { ok: true, openByBelt: [...byBelt.entries()].sort((a, b) => a[0] - b[0])
      .map(([systemId, n]) => ({ systemId, n })), busyFleetIds: r.trips.map((t) => t.fleetId).sort(), openTrips };
  }

  function readMinerTargets(tx, spec) {
    if (!spec || !isId(spec.excludeFactionId) || !isTime(spec.at) || !Number.isSafeInteger(spec.limit)
      || spec.limit < 0) return { ok: false, reason: "INVALID_SPEC" };
    return trips.listMinerTargets(tx, { excludeFactionId: spec.excludeFactionId, at: spec.at, limit: spec.limit });
  }

  function readBeltCooldowns(tx, factionId, at) {
    if (M.beltCooldownEnabled !== true) return { ok: true, systemIds: [], truncated: false };
    if (!isId(factionId) || !isTime(at)) return { ok: false, reason: "INVALID_SPEC" };
    const windowMs = Math.min(M.beltCooldownMs, M.tripRetentionMs);
    const r = trips.listBadEndsByBelt(tx, { factionId, since: Math.max(0, at - windowMs),
      minCount: M.beltCooldownThreshold, limit: M.beltCooldownMaxSystems });
    if (!r.ok) return r;
    return { ok: true, systemIds: r.rows.map((x) => x.systemId).sort((a, b) => a - b), truncated: r.truncated };
  }

  return Object.freeze({
    getMode: () => (state === "stopped" ? "off" : state),
    richnessOf,
    dispatchInTx,
    releaseOrphanInTx,
    readSiteState,
    readMinerTargets,
    readBeltCooldowns,
    readOwnSpaceSites,
    handler,
    onArrival,
    reconcile,
    warmUp,
    count: (name, n = 1) => bump(name, n),
    noteRefusal: (reason) => { lastRefusal = String(reason); },
    getStatus: () => Object.freeze({ state, seq, counters: Object.freeze({ ...counters }), lastRefusal,
      beltsCached: belts.size }),
    stop() {
      state = "stopped";
      seq += 1;
    },
    isStopped: () => state === "stopped",
  });
}

module.exports = { createMiningService, parsePayload, COUNTER_NAMES };
