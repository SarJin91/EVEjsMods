"use strict";

const { isModuleEnabled } = require("../../config");
const { createWorldStateRepository } = require("./worldStateRepository");
const { createControlSeed } = require("./controlSeed");
const { buildControlView } = require("./controlView");
const { buildGalaxyStateView } = require("./galaxyStateView");
const { getCoreIndex, bastionOwnerOf } = require("./core");
const { buildTerritoryLayerView, STATIC_VIEW_ID: TERRITORY_STATIC_VIEW_ID } = require("./territoryLayer");

const STATE_READY = "ready";
const STATE_UNAVAILABLE = "unavailable";
const REFUSAL_FIELDS = Object.freeze(["code", "detail", "rows", "limit"]);

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err);
}

const UNAVAILABLE_SEED = Object.freeze({ getStatus: () => Object.freeze({ state: "stopped", reason: null, seq: 0 }) });

function createUnavailableWorld(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const refuse = () => refusal;
  return Object.freeze({
    applyChange: refuse,
    isApplied: refuse,
    getSystem: refuse,
    getController: refuse,
    getControllerMemo: refuse,
    getControlState: refuse,
    getSystems: refuse,
    listSystems: refuse,
    listInfluenceByFaction: refuse,
    getStatus: () => Object.freeze({ state: STATE_UNAVAILABLE, reason: refusal.reason }),
    repository: null,
    seed: UNAVAILABLE_SEED,
    stop: noop,
  });
}

function unwrap(result) {
  if (result && result.ok) return result.value;
  const out = { ok: false, reason: (result && result.reason) || "TX_FAILED" };
  for (const field of REFUSAL_FIELDS) {
    if (result && result[field] !== undefined && result[field] !== null) out[field] = result[field];
  }
  return out;
}

function readFactionNames(adapter, logger) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    if (r && r.ok && r.names instanceof Map) return r.names;
    logger.log(`world: faction names unavailable - ${(r && r.reason) || "no_result"}; panel shows ids`);
  } catch (err) {
    logger.log(`world: faction names unavailable - ${messageOf(err)}; panel shows ids`);
  }
  return new Map();
}

function startWorld(deps) {
  try {
    const { config, persistence, clock, telemetry } = deps || {};
    if (!isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence",
        ...(persistence && persistence.ok === true ? { detail: "store or journal missing" } : {}) };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
    const hooks = (telemetry && telemetry.hooks) || {};
    const settings = config.world || {};
    const store = persistence.store;
    const readCache = settings.readCacheEnabled === true && settings.readCacheMaxSystems > 0
      && typeof store.getTxSeq === "function"
      ? { maxSystems: settings.readCacheMaxSystems, txSeq: () => store.getTxSeq() } : undefined;
    const memoMax = Number.isSafeInteger(settings.controllerMemoMaxSystems) && settings.controllerMemoMaxSystems > 0
      ? settings.controllerMemoMaxSystems : 0;
    const memo = new Map();
    let memoWrites = 0;
    const repository = createWorldStateRepository({
      readCache,
      onInvalidate: (systemId) => {
        memoWrites += 1;
        const id = Number(systemId);
        if (Number.isSafeInteger(id)) memo.delete(id);
        else memo.clear();
      },
      journal: persistence.journal,
      clock,
      limits: { maxFactionsPerSystem: settings.maxFactionsPerSystem, maxBatchReadIds: settings.maxBatchReadIds,
        maxListLimit: settings.maxListLimit },
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined,
    });
    const run = (op, fn) => unwrap(store.transaction(`world.${op}`, fn));
    const getController = (systemId) => {
      try {
        if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
          return { ok: false, reason: "TX_ACTIVE" };
        }
        const r = run("getController", (tx) => repository.getSystem(tx, systemId, { includeInfluence: false }));
        if (!r || r.ok !== true) return r || { ok: false, reason: "TX_FAILED" };
        return { ok: true, controllerFactionId: r.system ? r.system.controllerFactionId : null };
      } catch (err) {
        return { ok: false, reason: "WORLD_READ_FAILED", detail: messageOf(err) };
      }
    };
    const countMemo = (name) => {
      if (typeof hooks.onCount !== "function") return;
      try {
        hooks.onCount(name, 1);
      } catch (_err) {
      }
    };
    const getControllerMemo = (systemId) => {
      try {
        if (memoMax === 0 || !Number.isSafeInteger(systemId)
          || (typeof store.isOpen === "function" && !store.isOpen())
          || (typeof store.isInTransaction === "function" && store.isInTransaction())) {
          return getController(systemId);
        }
        const hit = memo.get(systemId);
        if (hit !== undefined) {
          countMemo("world.controllerMemo.hits");
          return hit;
        }
        countMemo("world.controllerMemo.misses");
        const before = memoWrites;
        const r = getController(systemId);
        if (r && r.ok === true && memoWrites === before) {
          if (memo.size >= memoMax) {
            memo.clear();
            countMemo("world.controllerMemo.resets");
          }
          memo.set(systemId, Object.freeze({ ok: true, controllerFactionId: r.controllerFactionId }));
        }
        return r;
      } catch (err) {
        return { ok: false, reason: "WORLD_READ_FAILED", detail: messageOf(err) };
      }
    };
    const getControlState = (systemId) => {
      try {
        if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
          return { ok: false, reason: "TX_ACTIVE" };
        }
        const r = run("getControlState", (tx) => repository.getSystem(tx, systemId, { includeInfluence: true }));
        if (!r || r.ok !== true) return r || { ok: false, reason: "TX_FAILED" };
        return { ok: true, system: r.system };
      } catch (err) {
        return { ok: false, reason: "WORLD_READ_FAILED", detail: messageOf(err) };
      }
    };
    const seed = createControlSeed({
      store, journal: persistence.journal, repository, graph: deps.graph || null, adapter: deps.adapter || null,
      getGovernor: deps.getGovernor, settings, telemetry: telemetry || null, logger, clock,
      defer: deps.defer, setTimer: deps.setTimer, nowMs: deps.nowMs,
      bastionOf: (systemId) => bastionOwnerOf(getCoreIndex(config), systemId),
    });
    const viewHandles = [];
    const views = deps.views;
    let territoryView = null;
    if (views && typeof views.registerView === "function") {
      const factionNames = readFactionNames(deps.adapter, logger);
      const register = (id, def) => {
        const r = views.registerView(id, def);
        if (r && r.ok) viewHandles.push(r);
        else logger.log(`world: view ${id} not registered - ${(r && r.reason) || "no result"}`);
      };
      register("control", buildControlView({ store, repository, graph: deps.graph || null,
        getSeedStatus: seed.getStatus, factionNames, maxListLimit: settings.maxListLimit }));
      const observer = config.observer || {};
      if (observer.galaxyEnabled === true) {
        register("galaxy-state", buildGalaxyStateView({ store, repository, getSeedStatus: seed.getStatus,
          factionNames, maxListLimit: settings.maxListLimit, influenceTop: observer.galaxyInfluenceTop,
          getGovernor: deps.getGovernor, telemetry: telemetry || null,
          getBastions: () => getCoreIndex(config).bastions }));
        if (observer.galaxyTerritoryEnabled === true) {
          territoryView = buildTerritoryLayerView({ store, repository, getSeedStatus: seed.getStatus,
            getStaticView: () => views.getView(TERRITORY_STATIC_VIEW_ID), graph: deps.graph || null, factionNames,
            getGovernor: deps.getGovernor, telemetry: telemetry || null,
            settings: { maxListLimit: settings.maxListLimit, cellSize: observer.galaxyTerritoryCellSize,
              radius: observer.galaxyTerritoryRadius, maxCells: observer.galaxyTerritoryMaxCells,
              maxStampOps: observer.galaxyTerritoryMaxStampOps,
              maxPoints: observer.galaxyTerritoryMaxPoints, maxCoarsenSteps: observer.galaxyTerritoryMaxCoarsenSteps,
              simplifyPercent: observer.galaxyTerritorySimplifyPercent,
              projectEmpireSpace: observer.galaxyTerritoryProjectEmpireSpace === true } });
          register("layer-territory", territoryView);
        }
      }
    }
    const world = Object.freeze({
      applyChange: (change, key) => run("applyChange", (tx) => repository.applyChange(tx, change, key)),
      isApplied: (key) => run("isApplied", (tx) => repository.isApplied(tx, key)),
      getSystem: (id, opts) => run("getSystem", (tx) => repository.getSystem(tx, id, opts)),
      getController: (id) => getController(id),
      getControllerMemo: (id) => getControllerMemo(id),
      getControlState: (id) => getControlState(id),
      getSystems: (ids, opts) => run("getSystems", (tx) => repository.getSystems(tx, ids, opts)),
      listSystems: (opts) => run("listSystems", (tx) => repository.listSystems(tx, opts)),
      listInfluenceByFaction: (factionId, opts) => run("listInfluenceByFaction",
        (tx) => repository.listInfluenceByFaction(tx, factionId, opts)),
      getStatus: () => Object.freeze({ state: STATE_READY, reason: null }),
      repository,
      seed: Object.freeze({ getStatus: seed.getStatus }),
      stop(reason) {
        seed.stop(reason);
        memo.clear();
        if (territoryView) territoryView.reset();
        while (viewHandles.length > 0) {
          const handle = viewHandles.pop();
          try {
            handle.unregister();
          } catch (_err) {
          }
        }
      },
    });
    seed.start();
    return { ok: true, world };
  } catch (err) {
    return { ok: false, reason: "WORLD_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startWorld, createUnavailableWorld };
