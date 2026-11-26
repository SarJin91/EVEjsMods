"use strict";

const path = require("node:path");

const { isModuleEnabled, DEFAULT_DB_FILE } = require("../../config");
const { createFleetRepository } = require("./fleetRepository");
const { TERMINAL_OPERATION_STATES } = require("./schema");
const { createTravel } = require("./travelService");
const { createWormholeTransits } = require("./wormholeTransits");
const { positionAt } = require("./travel");
const { LAYER_ID: FLEETS_LAYER_ID, buildFleetsLayerView } = require("./fleetsLayer");
const { LAYER_ID: PARKED_LAYER_ID, buildParkedFleetsLayerView } = require("./parkedFleetsLayer");
const { VIEW_ID: FLEETS_VIEW_ID, buildFleetsView } = require("./fleetsView");
const { VIEW_ID: FACTION_FLEETS_VIEW_ID, buildFactionFleetsView } = require("./factionFleetsView");
const { createBench, BENCH_EVENT_TYPE } = require("./bench");
const { createGrid, createUnavailableGrid } = require("./grid");


const TRAVEL_METHODS = Object.freeze(["planTravel", "retreat", "getPosition", "addDepartureGuard"]);
const WORMHOLE_METHODS = Object.freeze(["listOpenWormholeTransitPairs", "closeWormholeTransits"]);
const WORMHOLE_EXPIRE = "WORMHOLE_EXPIRE";
const CLOSE_ABORT = Symbol("fleets-close-wormhole-abort");
const TRAVEL_UNAVAILABLE = "TRAVEL_UNAVAILABLE";

const STATE_READY = "ready";
const STATE_UNAVAILABLE = "unavailable";
const STATE_STOPPED = "stopped";
const STORE_REFUSAL_FIELDS = Object.freeze(["code", "detail", "rows", "limit"]);
const SETTING_KEYS = Object.freeze(["maxCompositionEntries", "maxShipsPerFleet", "maxFleetsPerOperation",
  "maxJsonBytes", "maxListLimit"]);

const OPERATION_ROWS_FIXED = 2;
const OPERATION_ROWS_PER_FLEET = 2;

const READ_METHODS = Object.freeze(["getFleet", "getFleets", "listFleetsInSystem", "listFleetsInSystems",
  "listFleetsByFaction", "listFleetsByState", "listFleetsOfOperation", "getOperation", "listOperations", "countByState",
  "isApplied", "countOperationsByState", "countOverdueInFlight", "summarizeStationary"]);
const WRITE_METHODS = Object.freeze(["createFleet", "transition", "createOperation", "transitionOperation",
  "replenish", "upgradeComposition"]);

function messageOf(err) {
  return String((err && err.message) || err);
}

function createUnavailableFleets(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const refuse = () => refusal;
  const facade = { getStatus: () => Object.freeze({ state: STATE_UNAVAILABLE, reason: refusal.reason }),
    repository: null, travel: null, positionAt, grid: createUnavailableGrid(refusal.reason), stop() {} };
  for (const name of [...WRITE_METHODS, ...READ_METHODS, ...TRAVEL_METHODS, ...WORMHOLE_METHODS]) facade[name] = refuse;
  return Object.freeze(facade);
}

function checkPersistenceFit(settings, persistence, persistenceSettings) {
  const maxRows = persistence.store.limits && persistence.store.limits.maxRowsPerTransaction;
  const rows = OPERATION_ROWS_FIXED + OPERATION_ROWS_PER_FLEET * settings.maxFleetsPerOperation;
  if (Number.isSafeInteger(maxRows) && rows > maxRows) {
    return { ok: false, reason: "FLEETS_START_FAILED", detail: `fleets.maxFleetsPerOperation=`
      + `${settings.maxFleetsPerOperation}: createOperation needs ${rows} rows > persistence.maxRowsPerTransaction=${maxRows}` };
  }
  const maxPayload = persistenceSettings.journalMaxPayloadBytes;
  if (Number.isSafeInteger(maxPayload) && settings.maxJsonBytes >= maxPayload) {
    return { ok: false, reason: "FLEETS_START_FAILED", detail: `fleets.maxJsonBytes=${settings.maxJsonBytes} must be `
      + `< persistence.journalMaxPayloadBytes=${maxPayload}` };
  }
  return { ok: true };
}

function unwrap(result) {
  if (result && result.ok) return result.value;
  const out = { ok: false, reason: (result && result.reason) || "TX_FAILED" };
  for (const field of STORE_REFUSAL_FIELDS) {
    if (result && result[field] !== undefined && result[field] !== null) out[field] = result[field];
  }
  return out;
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

const REFIT_POLICIES = Object.freeze(["station", "anywhere"]);

function travelSettings(config) {
  const fleets = config.fleets || {};
  const factor = fleets.travelTimeFactor;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
    return { ok: false, key: "fleets.travelTimeFactor" };
  }
  if (!Number.isSafeInteger(fleets.refitMs) || fleets.refitMs < 1) return { ok: false, key: "fleets.refitMs" };
  const recheckMs = config.scheduler && config.scheduler.retryBaseMs;
  if (!Number.isSafeInteger(recheckMs) || recheckMs < 1) return { ok: false, key: "scheduler.retryBaseMs" };
  const recheckMaxMs = config.scheduler.retryMaxMs;
  if (!Number.isSafeInteger(recheckMaxMs) || recheckMaxMs < 1) return { ok: false, key: "scheduler.retryMaxMs" };
  const maxOverdueRounds = fleets.operationMaxOverdueRounds;
  if (!Number.isSafeInteger(maxOverdueRounds) || maxOverdueRounds < 1) {
    return { ok: false, key: "fleets.operationMaxOverdueRounds" };
  }
  const refitPolicy = fleets.refitPolicy === undefined ? "station" : fleets.refitPolicy;
  if (!REFIT_POLICIES.includes(refitPolicy)) return { ok: false, key: "fleets.refitPolicy" };
  const stations = config.stations || null;
  let refitSeekRecheckMs = null;
  let refitSeekMaxRounds = null;
  if (stations) {
    refitSeekRecheckMs = stations.refitSeekRecheckMs;
    if (!Number.isSafeInteger(refitSeekRecheckMs) || refitSeekRecheckMs < 1) {
      return { ok: false, key: "stations.refitSeekRecheckMs" };
    }
    refitSeekMaxRounds = stations.refitSeekMaxRounds;
    if (!Number.isSafeInteger(refitSeekMaxRounds) || refitSeekMaxRounds < 0) {
      return { ok: false, key: "stations.refitSeekMaxRounds" };
    }
  }
  const stationsConfigured = Boolean(stations && stations.enabled === true && isModuleEnabled(config, "strategy"));
  const wh = config.wormholes || {};
  const intOr0 = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const wormholeSyncHoldRecheckMs = intOr0(wh.syncHoldRecheckMs);
  return { ok: true, settings: Object.freeze({ travelTimeFactor: factor, refitMs: fleets.refitMs, recheckMs,
    recheckMaxMs, maxOverdueRounds, refitPolicy, stationsConfigured, refitSeekRecheckMs, refitSeekMaxRounds,
    wormholeExpiryMarginMs: intOr0(wh.expiryMarginMs), wormholeSyncHoldMaxMs: intOr0(wh.syncHoldMaxMs),
    wormholeSyncHoldRecheckMs,
    wormholeHold: wh.enabled === true && isModuleEnabled(config, "graph") && wormholeSyncHoldRecheckMs >= 1 }) };
}

function createWormholeTransitFacade({ store, transits, config, scheduler, logger }) {
  const wh = config.wormholes || {};
  const deferLogged = new Set();
  const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
  const isCount = (v) => Number.isSafeInteger(v) && v >= 1;

  function listOpenWormholeTransitPairs(opts) {
    const limit = opts && opts.limit;
    if (!isCount(limit)) return { ok: false, reason: "FLEET_INVALID_INPUT", detail: "limit" };
    return unwrap(store.transaction("fleets.listOpenWormholeTransitPairs", (db) => transits.listOpenPairs(db,
      { limit })));
  }

  function closeWormholeTransits(closures, opts) {
    const now = opts && opts.now;
    if (!isTime(now)) return { ok: false, reason: "FLEET_INVALID_INPUT", detail: "now" };
    if (!Array.isArray(closures) || !closures.every((c) => c && typeof c.pairKey === "string" && c.pairKey !== ""
      && isTime(c.closedAt))) return { ok: false, reason: "FLEET_INVALID_INPUT", detail: "closures" };
    if (!isCount(wh.maxClosuresPerSync) || !isCount(wh.maxPurgePerSync) || !isCount(wh.transitRetentionMs)) {
      return { ok: false, reason: "FLEET_INVALID_INPUT", detail: "wormholes settings" };
    }
    let ready = false;
    try {
      ready = Boolean(scheduler && typeof scheduler.enqueue === "function" && scheduler.getStatus().state === STATE_READY);
    } catch (_err) {
      ready = false;
    }
    if (!ready) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    const limitRows = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
      ? store.limits.maxRowsPerTransaction : wh.maxPurgePerSync;
    let refusal = null;
    const abort = (r) => {
      refusal = r;
      throw CLOSE_ABORT;
    };
    const newlyDeferred = [];
    const tx = store.transaction("fleets.closeWormholeTransits", (db) => {
      const out = { ok: true, closed: 0, enqueued: 0, deferred: 0, partial: 0, purged: 0 };
      let rows = 0;
      let touched = 0;
      const defer = (pairKey, why) => {
        out.deferred += 1;
        if (!deferLogged.has(pairKey)) newlyDeferred.push([pairKey, why]);
      };
      for (const c of closures) {
        const room = limitRows - rows;
        if (touched >= wh.maxClosuresPerSync || room < 1) {
          defer(c.pairKey, touched >= wh.maxClosuresPerSync ? "wormholes.maxClosuresPerSync" : "row budget");
          continue;
        }
        const prior = transits.firstClosedAt(db, c.pairKey);
        if (!prior.ok) abort(prior);
        const closedAt = prior.closedAt === null ? c.closedAt : prior.closedAt;
        const open = transits.listOpenLegs(db, c.pairKey, { closedAt, limit: room + 1 });
        if (!open.ok) abort(open);
        let taken = 0;
        for (const leg of open.legs) {
          const cost = leg.rows + (leg.affected ? 1 : 0);
          if (rows + cost > limitRows) break;
          const closed = transits.closeLegInTx(db, c.pairKey, { fleetId: leg.fleetId, legSeq: leg.legSeq, closedAt });
          if (!closed.ok) abort(closed);
          if (leg.affected) {
            const ev = scheduler.enqueue(WORMHOLE_EXPIRE, c.pairKey, closedAt, { fleetId: leg.fleetId,
              legSeq: leg.legSeq, pairKey: c.pairKey }, `wh:expire:${c.pairKey}:${leg.fleetId}:${leg.legSeq}`,
            { tx: db });
            if (!ev || ev.ok !== true) abort({ ok: false, reason: (ev && ev.reason) || "ENQUEUE_FAILED" });
            if (!ev.duplicate) out.enqueued += 1;
          }
          rows += cost;
          taken += 1;
        }
        touched += 1;
        if (taken === open.legs.length) {
          out.closed += 1;
          deferLogged.delete(c.pairKey);
        } else {
          if (taken > 0) out.partial += 1;
          defer(c.pairKey, taken > 0 ? "portion" : "row budget");
        }
      }
      const purgeLimit = Math.min(wh.maxPurgePerSync, limitRows - rows);
      if (purgeLimit > 0) {
        const purged = transits.purgeInTx(db, { before: now - wh.transitRetentionMs, limit: purgeLimit });
        if (!purged.ok) abort(purged);
        out.purged = purged.rows;
      }
      return out;
    });
    if (!tx.ok && tx.error === CLOSE_ABORT) return refusal;
    const result = unwrap(tx);
    if (result && result.ok === true) {
      const offered = new Set(closures.map((c) => c.pairKey));
      for (const key of deferLogged) if (!offered.has(key)) deferLogged.delete(key);
      for (const [pairKey, why] of newlyDeferred) {
        if (deferLogged.has(pairKey)) continue;
        deferLogged.add(pairKey);
        if (logger && typeof logger.log === "function") {
          try {
            logger.log(`fleets: wormhole closure of ${pairKey} deferred (${why}); the next sync continues`);
          } catch (_err) {
          }
        }
      }
    }
    return result;
  }

  return { listOpenWormholeTransitPairs, closeWormholeTransits };
}

function wireGridHandlers(deps, grid, config) {
  const registrations = [];
  const scheduler = deps.scheduler;
  let schedulerState = null;
  try {
    schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
  } catch (_err) {
    schedulerState = null;
  }
  if (grid.handlers && scheduler && typeof scheduler.registerHandler === "function"
    && schedulerState === STATE_READY) {
    const maxPerPass = config.grid.moveArrivalMaxPerPass;
    for (const [type, fn] of Object.entries(grid.handlers)) {
      let r;
      try {
        r = scheduler.registerHandler(type, fn, { maxPerPass });
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (r && r.ok) registrations.push(r);
      else if (deps.logger && typeof deps.logger.log === "function") {
        deps.logger.log(`fleets: handler ${type} not registered - ${(r && r.reason) || "no result"}`);
      }
    }
  }
  return { registered: registrations.length, stop() {
    for (const r of registrations.splice(0)) swallow(() => r.unregister());
  } };
}

function wireTravel(deps, parts) {
  const { config } = parts;
  const registrations = [];
  let viewHandle = null;
  const fail = (reason) => ({ travel: null, reason, getStatus: () => Object.freeze({ state: STATE_UNAVAILABLE,
    reason, handlers: 0, layer: false }), stop() {} });
  const settings = travelSettings(config);
  if (!settings.ok) return fail(`TRAVEL_CONFIG_INVALID:${settings.key}`);
  const travel = createTravel({ store: parts.store, repository: parts.repository, journal: parts.journal,
    scheduler: deps.scheduler || null, graph: deps.graph || null, presence: deps.presence || null, clock: deps.clock,
    settings: settings.settings, telemetry: deps.telemetry || null, nowMs: deps.nowMs,
    getStations: typeof deps.getStations === "function"
      && settings.settings.refitSeekRecheckMs !== null ? deps.getStations : undefined,
    getWormholes: typeof deps.getWormholes === "function" ? deps.getWormholes : undefined,
    gridRecorder: parts.gridRecorder || undefined,
    logger: deps.logger || null });
  let reason = null;
  const scheduler = deps.scheduler;
  let schedulerState = null;
  try {
    schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
  } catch (_err) {
    schedulerState = null;
  }
  if (!scheduler || typeof scheduler.registerHandler !== "function" || schedulerState !== STATE_READY) {
    reason = "SCHEDULER_UNAVAILABLE";
  } else {
    for (const [type, fn] of Object.entries(travel.handlers)) {
      let r;
      try {
        r = scheduler.registerHandler(type, fn);
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (r && r.ok) registrations.push(r);
      else if (reason === null) reason = `HANDLER_${type}:${(r && r.reason) || "no result"}`;
    }
  }
  const observer = config.observer || {};
  const views = deps.views;
  if (observer.galaxyEnabled === true && observer.galaxyFleetsEnabled === true && views
    && typeof views.registerView === "function") {
    const r = views.registerView(FLEETS_LAYER_ID, buildFleetsLayerView({ store: parts.store,
      repository: parts.repository, clock: deps.clock, getGovernor: deps.getGovernor,
      telemetry: deps.telemetry || null, nowMs: deps.nowMs, maxItems: observer.galaxyFleetsMaxItems,
      refreshMs: observer.galaxyFleetsRefreshMs, getCrewSummary: deps.getCrewSummary || null }));
    if (r && r.ok) viewHandle = r;
    else if (deps.logger && typeof deps.logger.log === "function") {
      deps.logger.log(`fleets: view ${FLEETS_LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
    }
  }
  let stopped = false;
  return {
    travel,
    reason,
    getStatus: () => {
      let travelState = reason === null ? STATE_READY : STATE_UNAVAILABLE;
      if (stopped) travelState = STATE_STOPPED;
      return Object.freeze({ state: travelState, reason, handlers: registrations.length, layer: viewHandle !== null,
        counters: travel.getCounters() });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      travel.stop();
      for (const r of registrations.splice(0)) swallow(() => r.unregister());
      if (viewHandle) {
        const handle = viewHandle;
        viewHandle = null;
        swallow(() => handle.unregister());
      }
    },
  };
}

function wireBench(deps, parts) {
  const { config, wired } = parts;
  const testing = config.testing || {};
  const target = Number.isSafeInteger(testing.benchFleets) ? testing.benchFleets : 0;
  const opened = deps.persistence && deps.persistence.filePath;
  const dbFile = typeof opened === "string" && opened !== "" ? path.basename(opened) : DEFAULT_DB_FILE;
  const log = (line) => {
    if (deps.logger && typeof deps.logger.log === "function") deps.logger.log(line);
  };
  const none = { ready: Promise.resolve(null), getStatus: () => null, stop() {} };
  if (target <= 0) return none;
  const refused = (reason) => {
    log(`fleets: bench refused - ${reason}`);
    return { ready: Promise.resolve(null), getStatus: () => Object.freeze({ enabled: false, dbFile, target, reason,
      counters: null }), stop() {} };
  };
  if (dbFile === DEFAULT_DB_FILE) return refused("BENCH_REQUIRES_SEPARATE_DB");
  if (target > config.limits.maxVirtualFleets) return refused("BENCH_EXCEEDS_LIMIT");
  const scheduler = deps.scheduler;
  if (!wired.travel || wired.reason !== null || !scheduler || typeof scheduler.enqueueMany !== "function") {
    return refused("BENCH_TRAVEL_UNAVAILABLE");
  }
  const bench = createBench({ store: parts.store, repository: parts.repository, travel: wired.travel, scheduler,
    graph: deps.graph || null, worldSeed: parts.worldSeed, clock: deps.clock, telemetry: deps.telemetry || null,
    settings: { fleets: target, dwellMs: testing.benchDwellMs, roamMaxJumps: testing.benchRoamMaxJumps,
      seedBatchRows: testing.benchSeedBatchRows }, setImmediateFn: deps.setImmediateFn });
  let registration;
  try {
    registration = scheduler.registerHandler(BENCH_EVENT_TYPE, bench.handlers[BENCH_EVENT_TYPE]);
  } catch (err) {
    registration = { ok: false, reason: messageOf(err) };
  }
  if (!registration || !registration.ok) {
    return refused(`BENCH_HANDLER:${(registration && registration.reason) || "no result"}`);
  }
  let stopped = false;
  let seed = Object.freeze({ state: "seeding", enqueued: 0, duplicates: 0 });
  let failure = null;
  const ready = bench.seed({ isActive: () => !stopped }).then((seeded) => {
    if (seeded.ok) {
      seed = Object.freeze({ state: "done", enqueued: seeded.enqueued, duplicates: seeded.duplicates });
      log(`fleets: bench on fleets=${target} enqueued=${seeded.enqueued} duplicates=${seeded.duplicates}`
        + ` dbFile=${dbFile} dwellMs=${testing.benchDwellMs}`);
      return seeded;
    }
    seed = Object.freeze({ state: "failed", reason: seeded.reason, enqueued: seeded.enqueued,
      duplicates: seeded.duplicates });
    swallow(() => registration.unregister());
    if (!stopped && seeded.reason !== "BENCH_STOPPED") {
      failure = `BENCH_SEED_FAILED:${seeded.reason}`;
      log(`fleets: bench refused - ${failure}`);
    }
    return seeded;
  }).catch((err) => ({ ok: false, reason: `SEED_THREW: ${messageOf(err)}` }));
  return {
    ready,
    getStatus: () => Object.freeze({ enabled: !stopped && failure === null, dbFile, target, seed,
      ...(failure ? { reason: failure } : {}), ...bench.getStatus() }),
    stop() {
      if (stopped) return;
      stopped = true;
      swallow(() => registration.unregister());
    },
  };
}

function startFleets(deps) {
  try {
    const { config, persistence, clock, ids, telemetry } = deps || {};
    if (!isModuleEnabled(config, "fleets")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence",
        ...(persistence && persistence.ok === true ? { detail: "store or journal missing" } : {}) };
    }
    const settings = config.fleets || {};
    for (const key of SETTING_KEYS) {
      if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) {
        return { ok: false, reason: "FLEETS_START_FAILED", detail: `fleets.${key}` };
      }
    }
    const limits = config.limits || {};
    if (!Number.isSafeInteger(limits.maxVirtualFleets) || limits.maxVirtualFleets < 1) {
      return { ok: false, reason: "FLEETS_START_FAILED", detail: "limits.maxVirtualFleets" };
    }
    const fit = checkPersistenceFit(settings, persistence, config.persistence || {});
    if (!fit.ok) return fit;
    const hooks = (telemetry && telemetry.hooks) || {};
    const repository = createFleetRepository({
      journal: persistence.journal,
      clock,
      ids,
      worldSeed: persistence.worldSeed,
      limits: { maxVirtualFleets: limits.maxVirtualFleets,
        ...Object.fromEntries(SETTING_KEYS.map((k) => [k, settings[k]])) },
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined,
    });
    const store = persistence.store;
    let state = STATE_READY;
    let stopReason = null;
    const counters = { created: 0, transitions: 0, refused: 0, operationsCreated: 0, operationsClosed: 0,
      replenished: 0, upgraded: 0 };
    const tally = (name, result) => {
      if (!result || result.ok !== true) {
        counters.refused += 1;
        return result;
      }
      if (result.duplicate) return result;
      if (name === "createFleet") counters.created += 1;
      else if (name === "transition") counters.transitions += 1;
      else if (name === "replenish") counters.replenished += 1;
      else if (name === "upgradeComposition") counters.upgraded += 1;
      else if (name === "createOperation") counters.operationsCreated += 1;
      else if (name === "transitionOperation" && TERMINAL_OPERATION_STATES.includes(result.state)) {
        counters.operationsClosed += 1;
      }
      return result;
    };
    const run = (op, fn) => unwrap(store.transaction(`fleets.${op}`, fn));
    const grid = createGrid({ config, adapter: deps.adapter || null, clock, telemetry: telemetry || null,
      logger: deps.logger || null, nowMs: deps.nowMs, store, repository, scheduler: deps.scheduler || null,
      worldSeed: persistence.worldSeed });
    const gridHandlers = wireGridHandlers(deps, grid, config);
    const wired = wireTravel(deps, { store, repository, journal: persistence.journal, config,
      gridRecorder: grid.recorder });
    const bench = wireBench(deps, { config, wired, store, repository, worldSeed: persistence.worldSeed });
    const viewHandles = [];
    const facade = {
      getStatus: () => Object.freeze({ state, reason: stopReason, counters: Object.freeze({ ...counters }),
        travel: wired.getStatus(), bench: bench.getStatus() }),
      repository,
      travel: wired.travel,
      positionAt,
      grid: grid.facade,
      benchReady: () => bench.ready,
      stop(reason) {
        state = STATE_STOPPED;
        stopReason = reason === undefined ? null : String(reason);
        bench.stop();
        wired.stop();
        gridHandlers.stop();
        grid.stop();
        for (const handle of viewHandles.splice(0)) swallow(() => handle.unregister());
      },
    };
    const travelRefusal = Object.freeze({ ok: false, reason: TRAVEL_UNAVAILABLE });
    for (const name of TRAVEL_METHODS) {
      facade[name] = (...args) => {
        if (!wired.travel || state !== STATE_READY) return { ...travelRefusal, detail: wired.reason || stopReason };
        return wired.travel[name](...args);
      };
    }
    for (const name of WRITE_METHODS) {
      facade[name] = (input, key) => tally(name, run(name, (tx) => repository[name](tx, input, key)));
    }
    for (const name of READ_METHODS) {
      facade[name] = (...args) => run(name, (tx) => repository[name](tx, ...args));
    }
    const wormholeFacade = createWormholeTransitFacade({ store, transits: createWormholeTransits(), config,
      scheduler: deps.scheduler || null, logger: deps.logger || null });
    for (const name of WORMHOLE_METHODS) {
      facade[name] = (...args) => {
        if (state !== STATE_READY) return { ok: false, reason: "FLEETS_UNAVAILABLE", detail: stopReason };
        try {
          return wormholeFacade[name](...args);
        } catch (err) {
          return { ok: false, reason: "FLEETS_WORMHOLE_FAILED", detail: messageOf(err) };
        }
      };
    }
    const observer = config.observer || {};
    const views = deps.views;
    const register = (id, view) => {
      const r = views.registerView(id, view);
      if (r && r.ok) viewHandles.push(r);
      else if (deps.logger && typeof deps.logger.log === "function") {
        deps.logger.log(`fleets: view ${id} not registered - ${(r && r.reason) || "no result"}`);
      }
    };
    if (Number.isSafeInteger(observer.fleetsPanelRows) && observer.fleetsPanelRows > 0 && views
      && typeof views.registerView === "function") {
      register(FLEETS_VIEW_ID, buildFleetsView({ store, repository, clock,
        getGovernor: deps.getGovernor, getStatus: facade.getStatus, getScheduler: () => deps.scheduler || null,
        getRegistry: deps.getRegistry, getVirtualCorps: deps.getVirtualCorps, rows: observer.fleetsPanelRows, refreshMs: observer.galaxyFleetsRefreshMs, limit: limits.maxVirtualFleets,
        catchUpLagMs: config.scheduler && config.scheduler.catchUpLagMs }));
    }
    if (observer.galaxyEnabled === true && observer.galaxyParkedFleetsEnabled === true && views
      && typeof views.registerView === "function") {
      register(PARKED_LAYER_ID, buildParkedFleetsLayerView({ store, repository, clock,
        getGovernor: deps.getGovernor, telemetry: telemetry || null, nowMs: deps.nowMs,
        maxSystems: observer.galaxyParkedFleetsMaxSystems, maxLines: observer.galaxyParkedFleetsMaxLines,
        refreshMs: observer.galaxyParkedFleetsRefreshMs, getCrewSummary: deps.getCrewSummary || null }));
    }
    if (observer.factionOverviewEnabled === true && views && typeof views.registerView === "function") {
      register(FACTION_FLEETS_VIEW_ID, buildFactionFleetsView({ store, repository, clock, graph: deps.graph || null,
        getGovernor: deps.getGovernor, telemetry: telemetry || null, nowMs: deps.nowMs,
        maxFactions: observer.factionOverviewMaxFactions, maxPerFaction: observer.factionFleetsMaxPerFaction,
        maxOperations: observer.factionFleetsMaxOperationsPerFaction,
        refreshMs: observer.factionOverviewRefreshMs }));
    }
    return { ok: true, fleets: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "FLEETS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startFleets, createUnavailableFleets };
