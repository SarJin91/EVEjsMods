"use strict";

const { isModuleEnabled } = require("../../../config");
const { createPoller } = require("../../presence/poller");
const { createSalvageAnomalyService } = require("./anomalyService");
const anomalyRepository = require("./anomalyRepository");
const { VIEW_ID, buildSalvageView } = require("./salvageView");
const data = require("./data");

const MAX_LOGGED_NAMES = 8;

function messageOf(err) {
  return String((err && err.message) || err);
}

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function unavailableSalvageAnomaly(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({
    runPass: () => refusal,
    listBoardRows: () => refusal,
    getStatus: () => status,
    stop() {},
  });
}

function sitesRunning(sites) {
  if (!sites || typeof sites.createSiteInTx !== "function") return false;
  if (typeof sites.getStatus !== "function") return true;
  const st = safeCall(() => sites.getStatus());
  return Boolean(st && st.state === "running");
}

function listText(names) {
  const shown = names.slice(0, MAX_LOGGED_NAMES).join(", ");
  return names.length > MAX_LOGGED_NAMES ? `${shown}, +${names.length - MAX_LOGGED_NAMES}` : shown;
}

function startSalvageAnomaly(deps) {
  try {
    const { config, persistence, clock, adapter } = deps || {};
    if (!isModuleEnabled(config, "sites") || !config.salvageAnomaly || config.salvageAnomaly.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "SALVAGE_ANOMALY_START_FAILED", detail: "clock" };
    }
    const getSites = typeof deps.getSites === "function" ? deps.getSites : () => null;
    if (!sitesRunning(safeCall(getSites))) return { ok: false, reason: "dependency_disabled:sites" };
    const P = config.salvageAnomaly;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };

    const checked = adapter && typeof adapter.checkNativeWrecks === "function"
      ? safeCall(() => adapter.checkNativeWrecks()) : { ok: false, detail: "no checkNativeWrecks" };
    if (!checked || checked.ok !== true) {
      return { ok: false, reason: "SEAM_UNAVAILABLE",
        detail: (checked && (checked.detail || checked.reason)) || "no result" };
    }
    const seam = typeof adapter.getNativeWrecks === "function" ? safeCall(() => adapter.getNativeWrecks()) : null;
    if (!seam || seam.ok !== true) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: (seam && (seam.detail || seam.reason)) || "no seam" };
    }

    const dungeon = typeof adapter.getDungeonSites === "function" ? safeCall(() => adapter.getDungeonSites()) : null;
    const templates = dungeon && dungeon.ok === true && typeof dungeon.checkTemplates === "function"
      ? safeCall(() => dungeon.checkTemplates([P.templateId])) : null;
    if (templates && templates.ok === true && Array.isArray(templates.missing)
      && templates.missing.includes(P.templateId)) {
      return { ok: false, reason: "TEMPLATE_MISSING", detail: P.templateId };
    }
    if (!templates || templates.ok !== true) logger.log(`salvageAnomaly: template ${P.templateId} unchecked`);

    const lootIds = [...new Set([...data.allLootTableIds(), P.fallbackLootTableId])];
    const loot = safeCall(() => seam.checkLootTables(lootIds));
    const lootMissing = loot && loot.ok === true && Array.isArray(loot.missing) ? loot.missing : [];
    const fallbackLootUsable = !lootMissing.includes(P.fallbackLootTableId);
    if (lootMissing.length > 0) {
      logger.log(`salvageAnomaly: loot tables missing in EveJS (fallback ${fallbackLootUsable
        ? P.fallbackLootTableId : "none - no loot rolls"}): ${listText(lootMissing)}`);
    }
    const lootRandomAny = loot && loot.ok === true && Array.isArray(loot.randomAny) ? loot.randomAny : [];
    if (P.sizedDefaultLoot === true && lootRandomAny.length > 0) {
      logger.log(`salvageAnomaly: random-any loot tables refused: ${listText(lootRandomAny)}`);
    }
    const names = typeof seam.checkWreckNames === "function"
      ? safeCall(() => seam.checkWreckNames(data.allFallbackWreckNames())) : null;
    if (names && names.ok === true && Array.isArray(names.missing) && names.missing.length > 0) {
      logger.log(`salvageAnomaly: fallback wreck names missing in EveJS: ${listText(names.missing)}`);
    }

    const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed
      : safeCall(() => persistence.store.getWorldSeed());
    if (!Number.isSafeInteger(worldSeed)) {
      return { ok: false, reason: "SALVAGE_ANOMALY_START_FAILED", detail: "worldSeed" };
    }
    const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
    const service = createSalvageAnomalyService({ store: persistence.store, journal: persistence.journal, worldSeed,
      adapter, clock, config, telemetry: deps.telemetry || null, logger, getGovernor: deps.getGovernor, getPresence,
      getSites, getWrecks: deps.getWrecks, nowMs: deps.nowMs, lootTablesMissing: lootMissing, fallbackLootUsable,
      lootTablesRandomAny: lootRandomAny, getOfficerSpawns: deps.getOfficerSpawns });

    let unsubscribe = null;
    let poller = null;
    const subscribe = () => {
      if (unsubscribe !== null || poller === null) return;
      const presence = safeCall(getPresence);
      if (!presence || typeof presence.onSystemObserved !== "function") return;
      const r = safeCall(() => presence.onSystemObserved(() => poller.arm(0)));
      if (r && r.ok === true && typeof r.unsubscribe === "function") unsubscribe = r.unsubscribe;
    };
    poller = createPoller({
      runPass: () => {
        subscribe();
        const r = service.runPass(clock.now());
        if (r && r.ok === true && r.observedLive > 0) poller.arm(P.trackObservedIntervalMs);
      },
      intervalMs: P.pumpIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`salvageAnomaly: pump pass threw - ${messageOf(err)}`),
    });
    const started = poller.start();
    if (!started.ok) return { ok: false, reason: "SALVAGE_ANOMALY_START_FAILED", detail: `poller ${started.reason}` };
    subscribe();
    const live = service.countLive();
    logger.log(`salvageAnomaly: running live=${live.ok ? live.count : "?"} limit=${P.maxActiveAnomalies}`
      + ` template=${P.templateId}`);
    let stopped = false;
    let viewHandle = null;
    const facade = {
      runPass: service.runPass,
      listBoardRows: (opts) => (stopped ? { ok: false, reason: "SALVAGE_ANOMALY_UNAVAILABLE" }
        : service.listBoardRows(opts)),
      getStatus: () => Object.freeze({ state: stopped ? "stopped" : "running", passes: poller.getPasses(),
        listening: unsubscribe !== null, lootTablesMissing: lootMissing.length,
        last: service.getPassStatus().last, officer: service.getPassStatus().officer }),
      stop() {
        if (stopped) return;
        stopped = true;
        poller.stop();
        if (unsubscribe) {
          safeCall(unsubscribe);
          unsubscribe = null;
        }
        if (viewHandle) {
          safeCall(() => viewHandle.unregister());
          viewHandle = null;
        }
      },
    };
    const maxRows = config.observer && config.observer.salvagePanelMaxRows;
    const views = deps.views;
    if (views && typeof views.registerView === "function" && Number.isSafeInteger(maxRows) && maxRows > 0) {
      const r = safeCall(() => views.registerView(VIEW_ID, buildSalvageView({ store: persistence.store,
        repository: anomalyRepository, getStatus: () => facade.getStatus(), getPresence,
        getGovernor: deps.getGovernor, graph: deps.graph || null, maxRows, clock })));
      if (r && r.ok) viewHandle = r;
      else logger.log(`salvageAnomaly: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }
    return { ok: true, salvageAnomaly: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "SALVAGE_ANOMALY_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startSalvageAnomaly, unavailableSalvageAnomaly };
