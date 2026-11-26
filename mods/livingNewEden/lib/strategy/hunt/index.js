"use strict";

const { isModuleEnabled } = require("../../../config");
const { GROUPS: STRENGTH_GROUPS } = require("../../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../battle/strength");
const { capitalPowerOverlayOf } = require("../../battle/data/capitalStrengthRows");
const { createHostility } = require("../../battle/data/hostility");
const { buildPowerTable, strengthOf } = require("../ai/strength");
const { createPinRepository } = require("./pinRepository");
const { createHuntService, SCAN_EVENT, EXPIRE_EVENT } = require("./huntService");

const STATE_READY = "ready";
const REQUIRED = Object.freeze(["fleets.repository.getFleet", "fleets.repository.getFleets",
  "fleets.repository.listFleetsInSystem", "fleets.repository.listFleetsByFaction", "fleets.repository.createOperation",
  "fleets.travel.planInTx", "fleets.travel.addArrivalListener", "fleets.travel.addDepartureGuard",
  "scheduler.registerHandler", "scheduler.enqueue", "scheduler.getStatus", "persistence.store.transaction",
  "persistence.journal.applyOnce", "persistence.journal.findByKey", "battle.readCooldownsInTx", "clock.now",
  "clock.travelDurationMs", "ids.next"]);
const COUNT_KEYS = Object.freeze([["pinBaseMs", 1], ["pinMinMs", 0], ["pinMaxMs", 1], ["pinGraceMs", 0],
  ["speedPenaltyPermille", 0], ["strikeMaxJumps", 1], ["strikeScanMaxFleets", 1], ["maxActivePinsPerFaction", 0],
  ["maxActivePins", 0], ["scanMaxFleets", 1], ["maxHuntersPerScan", 1], ["maxScansPerPass", 1],
  ["maxExpiresPerPass", 1], ["maxBfsSystems", 1]]);

const messageOf = (err) => String((err && err.message) || err);

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function stateOf(facade) {
  try {
    return facade && typeof facade.getStatus === "function" ? facade.getStatus().state : null;
  } catch (_err) {
    return null;
  }
}

function missingPaths(roots) {
  const out = [];
  for (const path of REQUIRED) {
    const parts = path.split(".");
    let v = roots[parts[0]];
    for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
    if (typeof v !== "function") out.push(path);
  }
  return out;
}

function createUnavailableHunt(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason), ...(detail ? { detail: String(detail) }
    : {}) });
  return Object.freeze({ getState: () => "off", getStatus: () => status, repository: null, stop() {} });
}

function startHunt(deps) {
  const registrations = [];
  try {
    const { config, persistence, scheduler, fleets, battle, clock, ids } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.hunt || config.hunt.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    if (!fleets || !fleets.repository || !fleets.travel) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    if (!battle || stateOf(battle) !== STATE_READY) {
      return { ok: false, reason: "BATTLE_UNAVAILABLE", detail: String(stateOf(battle)) };
    }
    const missing = missingPaths({ fleets, scheduler, persistence, battle, clock, ids });
    if (missing.length > 0) return { ok: false, reason: "HUNT_FACADE_MISSING", detail: missing.join(",") };
    const C = config.hunt;
    for (const [key, min] of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < min) return { ok: false, reason: "INVALID_CONFIG", detail: `hunt.${key}` };
    }
    if (!(typeof C.attackStrengthRatio === "number" && C.attackStrengthRatio > 0)) {
      return { ok: false, reason: "INVALID_CONFIG", detail: "hunt.attackStrengthRatio" };
    }
    const tf = config.fleets && config.fleets.travelTimeFactor;
    if (!(typeof tf === "number" && Number.isFinite(tf) && tf > 0)) {
      return { ok: false, reason: "INVALID_CONFIG", detail: "fleets.travelTimeFactor" };
    }
    const engageDelayMs = config.battle && config.battle.engageDelayMs;
    if (!Number.isSafeInteger(engageDelayMs) || C.pinGraceMs >= engageDelayMs) {
      return { ok: false, reason: "INVALID_CONFIG", detail: `hunt.pinGraceMs ${C.pinGraceMs} must be < `
        + `battle.engageDelayMs ${engageDelayMs}` };
    }

    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const pins = createPinRepository();
    const groups = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy));
    const power = buildPowerTable(groups);
    const graph = deps.graph || null;
    const service = createHuntService({ store, journal: persistence.journal, pins, scheduler,
      fleetRepository: fleets.repository, travel: fleets.travel, battle,
      getGraph: () => (graph && typeof graph.getGraph === "function" ? graph.getGraph() : null), clock, ids,
      isHostile: createHostility(), groups, strengthOf: (composition) => strengthOf(composition, power), config,
      telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs, getWorld: deps.getWorld });

    const removeAll = () => {
      for (const r of registrations.splice(0).reverse()) swallow(() => r());
    };
    const fail = (what, r) => {
      removeAll();
      return { ok: false, reason: "HUNT_START_FAILED", detail: `${what}: ${(r && r.reason) || "no result"}` };
    };
    for (const [type, fn, maxPerPass] of [[SCAN_EVENT, service.onScan, C.maxScansPerPass],
      [EXPIRE_EVENT, service.onExpire, C.maxExpiresPerPass]]) {
      let r;
      try {
        r = scheduler.registerHandler(type, fn, { maxPerPass });
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (!r || !r.ok) return fail(`handler ${type}`, r);
      registrations.push(() => r.unregister());
    }
    const listener = fleets.travel.addArrivalListener(service.onArrival);
    if (!listener || !listener.ok) return fail("arrival listener", listener);
    registrations.push(() => listener.remove());
    const guard = fleets.travel.addDepartureGuard(service.departureGuard);
    if (!guard || !guard.ok) return fail("departure guard", guard);
    registrations.push(() => guard.remove());

    const open = store.transaction("hunt.countOpen", (db) => pins.countActive(db));
    const openCount = open.ok && open.value && open.value.ok ? open.value.count : null;
    if (openCount !== null) service.setOpen(openCount);
    logger.log(`hunt: running open=${openCount === null ? "?" : openCount} scanOnHostileArrival=`
      + `${C.scanOnHostileArrival === true}`);

    const facade = {
      getState: service.getState,
      getStatus: service.getStatus,
      repository: pins,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        removeAll();
      },
    };
    return { ok: true, hunt: Object.freeze(facade) };
  } catch (err) {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
    return { ok: false, reason: "HUNT_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startHunt, createUnavailableHunt, REQUIRED };
