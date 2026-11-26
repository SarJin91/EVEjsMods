"use strict";

const { isModuleEnabled } = require("../../../config");
const { createSovStructureRepository } = require("./repository");
const { createSovStructureService } = require("./service");
const { VIEW_ID, SYSTEM_VIEW_ID, buildSovStructuresViews } = require("./view");
const S = require("./schema");
const { rowsBound: occupationRowsBound } = require("../occupation/schema");
const { createSovPhysicalPump, MODE: PHYSICAL_MODE, MODES: PHYSICAL_MODES } = require("./physical");

const SCHEDULER_READY = "ready";
const UNAVAILABLE = "SOV_STRUCTURES_UNAVAILABLE";
const START_FAILED = "SOV_STRUCTURES_START_FAILED";
const STEP_MAX_PER_PASS = 4;
const COUNT_KEYS = Object.freeze(["anchorMs", "costIsk", "maxAnchoringPerFaction", "maxAttemptsPerClaim", "maxLive",
  "bootstrapPageRows", "siegeHoldMs", "reconcileMs", "reconcileMaxRows", "retentionMs", "panelMaxRows",
  "healMaxPerEvent"]);
const RECONCILE_MAX_PER_PASS = 1;
const RECONCILE_FIXED_ROWS = 2;
const HEAL_SOV_ROWS = 1;

function reconcileRowsOf(config, store) {
  const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
  const storeRows = store.limits && store.limits.maxRowsPerTransaction;
  const rowsCap = Number.isSafeInteger(storeRows) ? Math.min(maxRows || storeRows, storeRows) : maxRows;
  const healCost = occupationRowsBound(config.world.maxFactionsPerSystem) + HEAL_SOV_ROWS;
  const budget = Number.isSafeInteger(rowsCap) ? rowsCap - RECONCILE_FIXED_ROWS : 0;
  if (budget < healCost) {
    return { ok: false, detail: `persistence.maxRowsPerTransaction ${String(rowsCap)} < `
      + `${healCost + RECONCILE_FIXED_ROWS}` };
  }
  const C = config.sovStructures;
  return { ok: true, rowsCap, pageRows: Math.min(C.reconcileMaxRows, budget),
    healRows: Math.min(C.healMaxPerEvent, Math.floor(budget / healCost)) };
}
const FACADE_METHODS = Object.freeze(["readForOccupationInTx", "applyOpsInTx", "noteCommitted", "endOfFactionInTx",
  "getStatus", "stop"]);

const messageOf = (err) => String((err && err.message) || err);

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function factionNamesOf(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  const r = call(() => adapter.readFactionNames(), null);
  return r && r.ok === true && r.names instanceof Map ? r.names : new Map();
}

const PHYSICAL_COUNT_KEYS = Object.freeze(["passMs", "maxWritesPerPass", "maxPhysical"]);
const PHYSICAL_ZERO_KEYS = Object.freeze(["lingerMs", "offsetM", "reinforceHoldMaxMs"]);
const MAX_UINT32 = 0xffffffff;

function startPhysical(deps, service, repository, logger) {
  const off = (reason, detail) => ({ pump: null, status: Object.freeze({ state: "off", reason,
    ...(detail ? { detail: String(detail).slice(0, 120) } : {}) }) });
  try {
    const C = deps.config.sovStructures;
    const P = C.physical;
    if (!P || !PHYSICAL_MODES.includes(P.mode)) return off("CONFIG", "sovStructures.physical.mode");
    if (P.mode === PHYSICAL_MODE.OFF) return off("disabled_by_config");
    if (!Number.isSafeInteger(C.typeId) || C.typeId < 1) return off("CONFIG", "sovStructures.typeId");
    for (const key of PHYSICAL_COUNT_KEYS) {
      if (!Number.isSafeInteger(P[key]) || P[key] < 1) return off("CONFIG", `sovStructures.physical.${key}`);
    }
    for (const key of PHYSICAL_ZERO_KEYS) {
      if (!Number.isSafeInteger(P[key]) || P[key] < 0) return off("CONFIG", `sovStructures.physical.${key}`);
    }
    const world = deps.persistence.worldSeed;
    if (!(Number.isSafeInteger(world) && world >= 0 && world <= MAX_UINT32)) return off("CONFIG", "worldSeed");
    const adapter = deps.adapter;
    const seams = adapter && typeof adapter.sovStructureSeams === "function" ? call(() => adapter.sovStructureSeams(),
      null) : null;
    if (!seams || seams.ok !== true || !seams.seam) {
      return off("SEAM_UNAVAILABLE", (seams && (seams.detail || seams.reason)) || "adapter");
    }
    const states = seams.seam.readStructureStates();
    if (!states || states.ok !== true) return off("SEAM_UNAVAILABLE", (states && (states.detail || states.reason)));
    const pump = createSovPhysicalPump({ store: deps.persistence.store, repository, seam: seams.seam,
      states: states.states, world, config: C, clock: deps.clock, getPresence: deps.getPresence,
      getOccupation: deps.getOccupation, getRegistry: deps.getRegistry, getGovernor: deps.getGovernor,
      telemetry: deps.telemetry || null, logger, setTimer: deps.setTimer, onLiveChanged: service.refreshLive });
    const started = pump.start();
    if (!started.ok) {
      pump.stop();
      return off("START_FAILED", started.reason);
    }
    logger.log(`sovStructures: physical running mode=${P.mode} pass=${P.passMs}ms writes=${P.maxWritesPerPass} `
      + `max=${P.maxPhysical} linger=${P.lingerMs}ms typeId=${C.typeId}`);
    return { pump, status: null };
  } catch (err) {
    return off("START_FAILED", messageOf(err));
  }
}

function createUnavailableSovStructures(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: UNAVAILABLE, detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", enabled: false, reason: String(reason) });
  const noSov = Object.freeze({ ok: true, sov: null });
  const nothingEnded = Object.freeze({ ok: true, ended: 0 });
  return Object.freeze({ readForOccupationInTx: () => noSov, applyOpsInTx: () => refusal, noteCommitted() {},
    endOfFactionInTx: () => nothingEnded, getStatus: () => status, stop() {} });
}

function startSovStructures(deps) {
  try {
    const { config, persistence, clock, scheduler } = deps || {};
    if (!isModuleEnabled(config, "world") || !config.sovStructures || config.sovStructures.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    let schedulerState = null;
    try {
      schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
    } catch (_err) {
      schedulerState = null;
    }
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function"
      || schedulerState !== SCHEDULER_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: START_FAILED, detail: "clock" };
    const C = config.sovStructures;
    for (const key of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < 0) {
        return { ok: false, reason: START_FAILED, detail: `sovStructures.${key}` };
      }
    }
    for (const key of ["bootstrapPageRows", "reconcileMs", "reconcileMaxRows", "panelMaxRows", "healMaxPerEvent"]) {
      if (C[key] < 1) return { ok: false, reason: START_FAILED, detail: `sovStructures.${key}` };
    }
    const rows = reconcileRowsOf(config, persistence.store);
    if (!rows.ok) return { ok: false, reason: START_FAILED, detail: rows.detail };
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    if (rows.pageRows < C.reconcileMaxRows || rows.healRows < C.healMaxPerEvent) {
      logger.log(`sovStructures: reconcile pages bounded by persistence.maxRowsPerTransaction ${rows.rowsCap} `
        + `(reconcileMaxRows ${C.reconcileMaxRows} -> ${rows.pageRows}, healMaxPerEvent ${C.healMaxPerEvent} -> `
        + `${rows.healRows})`);
    }
    const repository = createSovStructureRepository();
    const service = createSovStructureService({ store: persistence.store, repository,
      pageRows: rows.pageRows, healRows: rows.healRows,
      scheduler, config, clock, getOccupation: typeof deps.getOccupation === "function" ? deps.getOccupation : null,
      getTreasury: typeof deps.getTreasury === "function" ? deps.getTreasury : null,
      getPresence: typeof deps.getPresence === "function" ? deps.getPresence : null,
      needsSovStructureOf: typeof deps.needsSovStructureOf === "function" ? deps.needsSovStructureOf : null,
      telemetry: deps.telemetry || null, logger });

    const registrations = [];
    for (const [type, fn, maxPerPass] of [[S.STEP_EVENT_TYPE, service.onStep, STEP_MAX_PER_PASS],
      [S.RECONCILE_EVENT_TYPE, service.onReconcile, RECONCILE_MAX_PER_PASS]]) {
      let registration;
      try {
        registration = scheduler.registerHandler(type, fn, { maxPerPass });
      } catch (err) {
        registration = { ok: false, reason: messageOf(err) };
      }
      if (!registration || !registration.ok) {
        for (const r of registrations) swallow(() => r.unregister());
        return { ok: false, reason: START_FAILED, detail: `handler ${type}: `
          + `${(registration && registration.reason) || "no result"}` };
      }
      registrations.push(registration);
    }
    const boot = service.bootstrap();
    if (!boot.ok) logger.log(`sovStructures: bootstrap failed ${boot.reason}; the next start retries`);
    else if (boot.enqueued + boot.duplicates > 0) {
      logger.log(`sovStructures: bootstrap enqueued=${boot.enqueued} duplicates=${boot.duplicates}`);
    }
    const chain = service.bootstrapReconcile();
    if (!chain.ok) logger.log(`sovStructures: reconcile bootstrap failed ${chain.reason}; the next start retries`);

    const viewHandles = [];
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const built = buildSovStructuresViews({ store: persistence.store, repository, getGovernor: deps.getGovernor,
        graph: deps.graph || null, factionNames: factionNamesOf(deps.adapter), maxRows: C.panelMaxRows });
      for (const [id, def] of [[VIEW_ID, built.all], [SYSTEM_VIEW_ID, built.system]]) {
        const r = call(() => views.registerView(id, def), null);
        if (r && r.ok) viewHandles.push(r);
        else logger.log(`sovStructures: view ${id} not registered - ${(r && r.reason) || "no result"}`);
      }
    }

    const physical = startPhysical(deps, service, repository, logger);
    if (physical.pump === null && physical.status.reason !== "disabled_by_config") {
      logger.log(`sovStructures: physical off - ${physical.status.reason}`
        + `${physical.status.detail ? ` (${physical.status.detail})` : ""}`);
    }

    const facade = {
      readForOccupationInTx: service.readForOccupationInTx,
      applyOpsInTx: service.applyOpsInTx,
      noteCommitted: service.noteCommitted,
      endOfFactionInTx: service.endOfFactionInTx,
      getStatus: () => Object.freeze({ ...service.getStatus(),
        physical: physical.pump ? physical.pump.getStatus() : physical.status }),
      stop() {
        if (service.isStopped()) return;
        if (physical.pump) physical.pump.stop();
        service.stop();
        for (const r of registrations) swallow(() => r.unregister());
        for (const h of viewHandles) swallow(() => h.unregister());
      },
    };
    return { ok: true, sovStructures: Object.freeze(facade), service, physical: physical.pump };
  } catch (err) {
    return { ok: false, reason: START_FAILED, detail: messageOf(err) };
  }
}

module.exports = { startSovStructures, createUnavailableSovStructures, reconcileRowsOf, FACADE_METHODS };
