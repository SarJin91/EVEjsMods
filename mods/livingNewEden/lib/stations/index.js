"use strict";

const { isModuleEnabled } = require("../../config");
const { HULL_GROUPS } = require("../fleets/schema");
const { createStationRepository } = require("./stationRepository");
const { createRepairLocator } = require("./repairLocator");
const { createFootholdRepairNodes, createHomeRepairNodes, composeRepairNodes } = require("./repairNodes");
const { runStationSeed } = require("./stationSeed");
const { LAYER_ID, buildStationsLayerView } = require("./stationsLayer");
const { VIEW_ID, buildStationsView } = require("./stationsView");

const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", DEGRADED: "degraded", STOPPED: "stopped",
  UNAVAILABLE: "unavailable" });
const MODE = Object.freeze({ READY: "ready", PENDING: "pending", OFF: "off" });
const GRAPH_UNAVAILABLE = "graph_unavailable";
const REFUSAL_FIELDS = Object.freeze(["code", "detail", "rows", "limit"]);
const CLOSED_REASONS = Object.freeze(["STORE_CLOSED", "STORE_SUSPENDED"]);
const MAX_DETAIL_LENGTH = 200;
const WIPE_FIXED_ROWS = 2;
const SETTING_KEYS = Object.freeze(["startStationsPerFaction", "maxPerSystem", "maxPerSystemPerFaction",
  "maxPerFaction", "maxStations", "maxStockItemsPerStation", "maxStockQuantity", "maxDeltasPerChange",
  "repairSearchMaxJumps", "repairSearchMaxSystems", "repairMaxCandidates"]);

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);
}

function unwrap(result) {
  if (result && result.ok) return result.value;
  const out = { ok: false, reason: (result && result.reason) || "TX_FAILED" };
  for (const field of REFUSAL_FIELDS) {
    if (result && result[field] !== undefined && result[field] !== null) out[field] = result[field];
  }
  return out;
}

function createUnavailableStations(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const refuse = () => refusal;
  const status = Object.freeze({ state: STATE.UNAVAILABLE, reason: refusal.reason });
  return Object.freeze({
    getStatus: () => status,
    whenReady: () => Promise.resolve(status),
    getMode: () => MODE.OFF,
    locator: null,
    refitLocator: null,
    repository: null,
    getStation: refuse,
    listStationsInSystem: refuse,
    getStock: refuse,
    applyStockChange: refuse,
    stop: noop,
  });
}

function readFactionNames(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    return r && r.ok && r.names instanceof Map ? r.names : new Map();
  } catch (_err) {
    return new Map();
  }
}

function startStations(deps) {
  try {
    const { config, persistence, clock, telemetry } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.stations || config.stations.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    const registry = deps.strategy && deps.strategy.registry;
    if (!registry || typeof registry.getFaction !== "function" || typeof registry.listFactions !== "function"
      || typeof registry.listActiveFactions !== "function" || typeof registry.isActive !== "function") {
      return { ok: false, reason: "dependency_disabled:strategy" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "STATIONS_START_FAILED", detail: "clock" };
    }
    const settings = config.stations;
    for (const key of SETTING_KEYS) {
      if (!Number.isSafeInteger(settings[key]) || settings[key] < 0) {
        return { ok: false, reason: "STATIONS_START_FAILED", detail: `stations.${key}` };
      }
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
    const txRows = (config.persistence && config.persistence.maxRowsPerTransaction)
      - ((config.battle && config.battle.settleRowsReserve) || 0);
    if (Number.isFinite(txRows) && WIPE_FIXED_ROWS + settings.maxStockItemsPerStation > txRows) {
      try {
        logger.log(`stations: stations.maxStockItemsPerStation=${settings.maxStockItemsPerStation} - a station wipe `
          + `needs ${WIPE_FIXED_ROWS + settings.maxStockItemsPerStation} rows > ${txRows} (persistence.`
          + "maxRowsPerTransaction - battle.settleRowsReserve)");
      } catch (_err) {
      }
    }
    const hooks = (telemetry && telemetry.hooks) || {};
    const repository = createStationRepository({ journal: persistence.journal,
      limits: { maxPerSystem: settings.maxPerSystem, maxPerSystemPerFaction: settings.maxPerSystemPerFaction,
        maxPerFaction: settings.maxPerFaction, maxStations: settings.maxStations,
        maxStockItemsPerStation: settings.maxStockItemsPerStation, maxStockQuantity: settings.maxStockQuantity,
        maxDeltasPerChange: settings.maxDeltasPerChange },
      isKnownFaction: (id) => registry.isActive(id), hullGroups: HULL_GROUPS,
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined });
    const store = persistence.store;
    const run = (op, fn) => unwrap(store.transaction(`stations.${op}`, fn));
    const graphService = deps.graph || null;

    const status = { state: STATE.STARTING, reason: null, seq: 0,
      seed: { state: "pending", created: 0, existing: 0, skipped: 0, failed: 0, reason: null } };
    let readyResolve = null;
    const ready = new Promise((resolve) => { readyResolve = resolve; });

    function log(line) {
      try {
        logger.log(line);
      } catch (_err) {
      }
    }

    function metric(name, n) {
      if (!telemetry || typeof telemetry.count !== "function" || n <= 0) return;
      try {
        telemetry.count(name, n);
      } catch (_err) {
      }
    }

    const stopped = () => status.state === STATE.STOPPED;

    function getStatus() {
      return Object.freeze({ state: status.state, reason: status.reason, seq: status.seq,
        seed: Object.freeze({ ...status.seed }) });
    }

    function getMode() {
      if (status.state === STATE.STARTING) return MODE.PENDING;
      if (status.state === STATE.RUNNING) return MODE.READY;
      if (status.state === STATE.DEGRADED) return status.reason === GRAPH_UNAVAILABLE ? MODE.OFF : MODE.READY;
      return MODE.OFF;
    }

    function currentGraph() {
      try {
        const r = graphService && typeof graphService.getGraph === "function" ? graphService.getGraph() : null;
        return r && r.ok === true && r.graph ? r.graph : null;
      } catch (_err) {
        return null;
      }
    }

    const hiveRepairNodes = deps.strategy && deps.strategy.hive
      && typeof deps.strategy.hive.repairNodesOf === "function"
      ? (tx, f) => deps.strategy.hive.repairNodesOf(tx, f) : undefined;
    const locatorDeps = { repository, getGraph: currentGraph, getMode,
      limits: { repairSearchMaxJumps: settings.repairSearchMaxJumps,
        repairSearchMaxSystems: settings.repairSearchMaxSystems, repairMaxCandidates: settings.repairMaxCandidates },
      telemetry, nowMs: deps.nowMs };
    const locator = createRepairLocator({ ...locatorDeps, repairNodesOf: hiveRepairNodes });
    const refitAtFoothold = Boolean(config.invasions && config.invasions.refitAtFootholdEnabled === true
      && typeof deps.footholdsOf === "function");
    const kindOf = (f) => {
      const faction = registry.getFaction(f);
      return faction && faction.kind ? faction.kind : null;
    };
    const refitAtHome = Boolean(config.invasions && config.invasions.refitAtHomeEnabled === true
      && config.invasions.homeBaseEnabled === true && typeof deps.homeOf === "function");
    const extraNodes = refitAtFoothold
      ? composeRepairNodes(hiveRepairNodes, createFootholdRepairNodes({ footholdsOf: deps.footholdsOf, kindOf }))
      : hiveRepairNodes;
    const refitLocator = refitAtHome
      ? createRepairLocator({ ...locatorDeps, repairNodesOf: composeRepairNodes(extraNodes,
        createHomeRepairNodes({ homeOf: deps.homeOf })) })
      : (refitAtFoothold ? createRepairLocator({ ...locatorDeps, repairNodesOf: extraNodes }) : locator);

    function finish(state, reason) {
      status.state = state;
      status.reason = reason === undefined ? null : reason;
      status.seq += 1;
      readyResolve(getStatus());
    }

    function onGraph(res) {
      if (stopped()) return;
      if (!res || res.ok !== true || !res.graph) {
        Object.assign(status.seed, { state: "skipped", reason: GRAPH_UNAVAILABLE });
        log(`stations: degraded graph_unavailable (${(res && res.reason) || "no_result"}); no seed, legacy refit`);
        finish(STATE.DEGRADED, GRAPH_UNAVAILABLE);
        return;
      }
      const seeded = runStationSeed({ store, journal: persistence.journal, repository, registry, graph: res.graph,
        adapter: deps.adapter || null, clock, settings: { startStationsPerFaction: settings.startStationsPerFaction,
          maxRowsPerTransaction: config.persistence.maxRowsPerTransaction } });
      if (stopped()) return;
      if (!seeded.ok && CLOSED_REASONS.includes(seeded.reason)) return;
      if (seeded.ok) {
        Object.assign(status.seed, { state: "done", created: seeded.created, existing: seeded.existing,
          skipped: seeded.skipped, failed: seeded.failed });
        for (const name of ["created", "existing", "skipped", "failed"]) metric(`stations.seed.${name}`, seeded[name]);
        if (seeded.npcData !== "adapter" && seeded.npcData !== "off") {
          log(`stations: NPC station data unavailable (${seeded.npcData}); seed uses the registry data`);
        }
        if (seeded.skippedDetail.length > 0) {
          const more = seeded.skipped - seeded.skippedDetail.length;
          log(`stations: seed skipped ${seeded.skippedDetail.map((s) => `${s.stationId}(${s.reason})`).join(",")}`
            + `${more > 0 ? ` +${more}` : ""}`);
        }
        if (seeded.failed > 0) log(`stations: seed failed ${seeded.failedDetail.join(", ")}; next start retries`);
      } else {
        Object.assign(status.seed, { state: "failed", reason: seeded.reason });
        metric("stations.seed.failed", 1);
        log(`stations: seed failed ${seeded.reason}${seeded.detail ? ` (${seeded.detail})` : ""}; next start retries`);
      }
      const live = run("count", (tx) => repository.listLiveStations(tx, { limit: settings.maxStations }));
      const s = status.seed;
      log(`stations: running live=${live && live.ok ? live.records.length : "?"} `
        + (s.state === "done" ? `created=${s.created} existing=${s.existing} skipped=${s.skipped} failed=${s.failed}`
          : `seed=${s.state}`) + ` refitPolicy=${config.fleets && config.fleets.refitPolicy}`);
      const degraded = s.state === "failed" || s.failed > 0;
      finish(degraded ? STATE.DEGRADED : STATE.RUNNING, degraded ? `seed_${s.reason || "partial"}` : null);
    }

    const viewHandles = [];
    const views = deps.views;
    const observer = config.observer || {};
    const register = (id, view) => {
      const r = views.registerView(id, view);
      if (r && r.ok) viewHandles.push(r);
      else log(`stations: view ${id} not registered - ${(r && r.reason) || "no result"}`);
    };
    const factionNames = readFactionNames(deps.adapter);
    if (views && typeof views.registerView === "function") {
      if (observer.galaxyEnabled === true && observer.galaxyStationsEnabled === true) {
        register(LAYER_ID, buildStationsLayerView({ store, repository, clock, getGovernor: deps.getGovernor,
          telemetry, nowMs: deps.nowMs, maxStations: settings.maxStations,
          maxSystems: observer.galaxyStationsMaxSystems, maxLines: observer.galaxyStationsMaxLines,
          refreshMs: observer.galaxyStationsRefreshMs, factionNames }));
      }
      if (Number.isSafeInteger(observer.stationsPanelMaxRows) && observer.stationsPanelMaxRows > 0) {
        register(VIEW_ID, buildStationsView({ store, repository, getStatus, getGovernor: deps.getGovernor,
          graph: graphService, factionNames, maxRows: observer.stationsPanelMaxRows,
          stockLines: observer.stationsPanelStockLines }));
      }
    }

    const stations = Object.freeze({
      getStatus,
      whenReady: () => ready,
      getMode,
      locator,
      refitLocator,
      repository,
      getStation: (stationId) => run("getStation", (tx) => repository.getStation(tx, stationId)),
      listStationsInSystem: (systemId) => run("listStationsInSystem",
        (tx) => repository.listStationsInSystem(tx, systemId)),
      getStock: (stationId) => run("getStock", (tx) => repository.getStock(tx, stationId)),
      applyStockChange: (change) => run("applyStockChange", (tx) => repository.applyStockChange(tx, change)),
      stop(reason) {
        if (stopped()) return;
        status.state = STATE.STOPPED;
        status.reason = reason === undefined ? null : String(reason);
        status.seq += 1;
        readyResolve(getStatus());
        while (viewHandles.length > 0) {
          try {
            viewHandles.pop().unregister();
          } catch (_err) {
          }
        }
      },
    });

    if (!graphService || typeof graphService.whenReady !== "function") onGraph(null);
    else {
      Promise.resolve(graphService.whenReady())
        .then((res) => {
          try {
            onGraph(res);
          } catch (err) {
            if (!stopped()) {
              log(`stations: start after graph failed - ${messageOf(err)}`);
              finish(STATE.DEGRADED, "STATIONS_GRAPH_STEP_THREW");
            }
          }
        })
        .catch(noop);
    }
    return { ok: true, stations };
  } catch (err) {
    return { ok: false, reason: "STATIONS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startStations, createUnavailableStations, STATE, MODE };
