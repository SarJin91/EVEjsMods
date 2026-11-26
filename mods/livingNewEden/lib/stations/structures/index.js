"use strict";

const { isModuleEnabled } = require("../../../config");
const { SEAM_REASONS } = require("./schema");
const { createStructuresService, MODE } = require("./structuresService");
const { VIEW_ID, buildStructuresView } = require("./structuresView");

const MODULE = "structures";
const MAX_UINT32 = 0xffffffff;
const SETTING_KEYS = Object.freeze(["passMs", "fullReconcileMs", "maxWritesPerPass", "maxProjected",
  "placementAttempts", "placementChecksPerPass", "placementClearanceM"]);
const MODES = Object.freeze([MODE.PROJECT, MODE.CLEANUP]);
const START_FAILED = "STRUCTURES_START_FAILED";

function messageOf(err) {
  return String((err && err.message) || err);
}

function createUnavailableStructures(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: "off", mode: MODE.OFF, reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ getMode: () => MODE.OFF, getStatus: () => status, nudge() {}, stop() {},
    getProjection: () => refusal });
}

function seamRefusal(r, what) {
  return { ok: false, reason: SEAM_REASONS.UNAVAILABLE, detail: `${what}: ${String((r && (r.detail || r.reason))
    || "no result")}` };
}

function startStructures(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    if (!isModuleEnabled(config, MODULE)) return { ok: false, reason: "disabled_by_config" };
    const sc = config.structures;
    if (!sc || !MODES.includes(sc.mode)) return { ok: false, reason: START_FAILED, detail: "structures.mode" };
    const mode = sc.mode;
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    const worldSeed = persistence.worldSeed;
    if (mode === MODE.PROJECT && !(Number.isSafeInteger(worldSeed) && worldSeed >= 0 && worldSeed <= MAX_UINT32)) {
      return { ok: false, reason: START_FAILED, detail: "worldSeed" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: START_FAILED, detail: "clock" };
    for (const key of SETTING_KEYS) {
      if (!Number.isSafeInteger(sc[key]) || sc[key] < 1) {
        return { ok: false, reason: START_FAILED, detail: `structures.${key}` };
      }
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const adapter = deps.adapter;
    const seam = adapter && typeof adapter.getStructureSeam === "function" ? adapter.getStructureSeam() : null;
    if (!seam || typeof seam.checkStructureSeams !== "function") {
      return { ok: false, reason: SEAM_REASONS.UNAVAILABLE, detail: "adapter" };
    }
    const checked = seam.checkStructureSeams();
    if (!checked || !checked.ok) return seamRefusal(checked, "check");
    const states = seam.readStructureStates();
    if (!states || !states.ok) return seamRefusal(states, "states");

    const nativeDestructionEnabled = Boolean(config.siege && config.siege.nativeDestructionEnabled === true);
    const service = createStructuresService({ seam, states, store: persistence.store,
      getStations: deps.getStations, getSiege: deps.getSiege, clock,
      worldSeed: mode === MODE.PROJECT ? worldSeed : null, settings: { ...sc, nativeDestructionEnabled }, mode, telemetry: deps.telemetry || null, logger, getGovernor: deps.getGovernor,
      setTimer: deps.setTimer, nowMs: deps.nowMs });

    let viewHandle = null;
    const views = deps.views;
    const maxRows = config.observer && config.observer.stationsPanelMaxRows;
    if (views && typeof views.registerView === "function" && Number.isSafeInteger(maxRows) && maxRows > 0) {
      const r = views.registerView(VIEW_ID, buildStructuresView({ service, getGovernor: deps.getGovernor, maxRows }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`structures: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }
    const unregisterView = () => {
      if (!viewHandle) return;
      const h = viewHandle;
      viewHandle = null;
      try {
        h.unregister();
      } catch (_err) {
      }
    };
    const started = service.start();
    if (!started.ok) {
      service.stop();
      unregisterView();
      return { ok: false, reason: START_FAILED, detail: started.reason };
    }
    logger.log(mode === MODE.PROJECT
      ? `structures: running mode=project pass=${sc.passMs}ms full=${sc.fullReconcileMs}ms writes=${sc.maxWritesPerPass} `
        + `max=${sc.maxProjected} checks=${sc.placementChecksPerPass} docking=${sc.dockingAccess} `
        + `quantumCore=${sc.quantumCore === true}`
      : `structures: running mode=cleanup pass=${sc.passMs}ms writes=${sc.maxWritesPerPass} - removing every tagged `
        + "structure");

    const structures = Object.freeze({
      getMode: service.getMode,
      getStatus: service.getStatus,
      nudge: service.nudge,
      getProjection: service.getProjection,
      stop(reason) {
        service.stop(reason);
        unregisterView();
      },
    });
    return { ok: true, structures };
  } catch (err) {
    return { ok: false, reason: START_FAILED, detail: messageOf(err) };
  }
}

module.exports = { startStructures, createUnavailableStructures, MODE };
