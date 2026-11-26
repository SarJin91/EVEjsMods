"use strict";

const { isModuleEnabled } = require("../../../config");
const { createHostility } = require("../../battle/data/hostility");
const { GROUPS: STRENGTH_GROUPS } = require("../../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../battle/strength");
const { capitalPowerOverlayOf } = require("../../battle/data/capitalStrengthRows");
const { buildPowerTable, strengthOf } = require("../ai/strength");
const { parseDefenseSettings } = require("./settings");
const { createGridDefenseService } = require("./service");
const { ALERT_EVENT, STEP_EVENT } = require("./keys");
const { EVENT_TYPE: CROSSING_EVENT } = require("./crossing");

const STATE_READY = "ready";
const REQUIRED = Object.freeze(["fleets.repository.getFleet", "fleets.repository.getFleets",
  "fleets.repository.getOperation", "fleets.repository.listFleetsInSystem", "fleets.travel.addArrivalListener",
  "fleets.grid.isEnabled", "fleets.grid.movesEnabled", "fleets.grid.readSystemGrid", "fleets.grid.positionsOf",
  "fleets.grid.moveInTx", "fleets.grid.moveGroupInTx", "fleets.grid.addGridArrivalListener",
  "fleets.grid.addWorkTargetOverride", "scheduler.registerHandler", "scheduler.enqueue", "scheduler.getStatus",
  "persistence.store.transaction", "battle.readCooldownsInTx", "world.repository.getSystems",
  "stations.repository.listStationsInSystem", "siege.readForFaction",
  "fleets.repository.listFleetsInSystems", "fleets.travel.addDepartureListener", "fleets.travel.interceptInTx",
  "fleets.grid.placeInTx",
  "hunt.repository.getActivePinForStrike"]);
const SOFT_ROOTS = Object.freeze(["battle", "world", "stations", "siege", "hunt"]);
const ROWS_PER_MEMBER = 2;
const ROWS_FIXED = 2;

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
    if (SOFT_ROOTS.includes(parts[0])) continue;
    let v = roots[parts[0]];
    for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
    if (typeof v !== "function") out.push(path);
  }
  return out;
}

function createUnavailableGridDefense(reason, detail) {
  const status = Object.freeze({ mode: "off", reason: String(reason), ...(detail ? { detail: String(detail) } : {}),
    counters: Object.freeze({}), lastRefusal: null });
  return Object.freeze({ getMode: () => "off", getStatus: () => status, stop() {} });
}

function startGridDefense(deps) {
  const registrations = [];
  const removeAll = () => {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
  };
  try {
    const { config, persistence, scheduler, fleets } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.grid || !config.grid.defense) {
      return { ok: false, reason: "disabled_by_config" };
    }
    const parsed = parseDefenseSettings(config);
    if (!parsed.ok) return { ok: false, reason: `INVALID_CONFIG:${parsed.key}` };
    const S = parsed.settings;
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    if (!fleets || !fleets.repository || !fleets.travel || !fleets.grid) {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    const missing = missingPaths({ fleets, scheduler, persistence });
    if (missing.length > 0) return { ok: false, reason: "GRID_DEFENSE_FACADE_MISSING", detail: missing.join(",") };
    const maxRows = config.persistence ? config.persistence.maxRowsPerTransaction : undefined;
    const rows = (ROWS_PER_MEMBER + (S.siegePosts ? 1 : 0)) * S.maxPursuersPerIntruder + ROWS_FIXED;
    if (Number.isSafeInteger(maxRows) && rows > maxRows) {
      return { ok: false, reason: "GRID_DEFENSE_ROW_BOUND",
        detail: `group=${rows} > persistence.maxRowsPerTransaction=${maxRows}` };
    }

    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const gridOn = () => {
      try {
        return fleets.grid.isEnabled() === true && fleets.grid.movesEnabled() === true;
      } catch (_err) {
        return false;
      }
    };
    const reason = S.enabled !== true ? "FLAG_OFF" : gridOn() ? null : "GRID_MOVES_OFF";
    const mode = reason === null ? "on" : "drain";
    const power = buildPowerTable(expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy)));
    const service = createGridDefenseService({ store: persistence.store, scheduler, fleets, settings: S,
      worldSeed: persistence.worldSeed, strengthOf: (composition) => strengthOf(composition, power),
      isHostile: typeof deps.isHostile === "function" ? deps.isHostile : createHostility(), mode,
      getBattle: deps.getBattle, getWorld: deps.getWorld, getStations: deps.getStations, getSiege: deps.getSiege,
      getHunt: deps.getHunt, graph: deps.graph || null,
      getSentries: deps.getSentries,
      sentryEyes: Boolean(config.sentries && config.sentries.battle && config.sentries.battle.gridEnabled === true),
      telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs });

    for (const [type, fn, maxPerPass] of [[ALERT_EVENT, service.onAlert, S.maxEventsPerPass],
      [STEP_EVENT, service.onStep, S.maxEventsPerPass],
      [CROSSING_EVENT, service.onCrossing, S.crossings.maxEventsPerPass]]) {
      let h;
      try {
        h = scheduler.registerHandler(type, fn, { maxPerPass });
      } catch (err) {
        h = { ok: false, reason: messageOf(err) };
      }
      if (!h || h.ok !== true) {
        removeAll();
        return { ok: false, reason: "GRID_DEFENSE_START_FAILED", detail: `handler ${type}: ${(h && h.reason)
          || "no result"}` };
      }
      registrations.push(() => h.unregister());
    }
    let listeners = 0;
    const crossingsReason = S.crossings.enabled !== true ? "FLAG_OFF" : mode !== "on" ? (reason || "DRAIN") : null;
    if (mode === "on") {
      const steps = [["arrival listener", () => fleets.travel.addArrivalListener(service.onArrival)],
        ["grid arrival listener", () => fleets.grid.addGridArrivalListener(service.onGridArrival)],
        ["work target override", () => fleets.grid.addWorkTargetOverride(service.workOverride)]];
      if (crossingsReason === null) {
        steps.push(["departure listener", () => fleets.travel.addDepartureListener(service.onDeparture)]);
      }
      for (const [name, add] of steps) {
        let r;
        try {
          r = add();
        } catch (err) {
          r = { ok: false, reason: messageOf(err) };
        }
        if (!r || r.ok !== true || typeof r.remove !== "function") {
          removeAll();
          return { ok: false, reason: "GRID_DEFENSE_START_FAILED",
            detail: `${name}: ${(r && r.reason) || "no result"}` };
        }
        registrations.push(() => r.remove());
        listeners += 1;
      }
    }
    logger.log(`gridDefense: mode=${mode}${reason ? ` reason=${reason}` : ""} roles=${S.roles.join(",")} `
      + `crossings=${crossingsReason === null ? "on" : "off"}`
      + `${S.strikePursuitEnabled === true ? ` strikePursuit=${mode === "on" ? "on" : "off"}` : ""}`);
    const crossings = Object.freeze({ enabled: crossingsReason === null, reason: crossingsReason });
    const strikeReason = S.strikePursuitEnabled !== true ? "FLAG_OFF" : mode !== "on" ? (reason || "DRAIN") : null;
    const strikePursuit = Object.freeze({ enabled: strikeReason === null, reason: strikeReason });

    let stopped = false;
    const facade = {
      getMode: () => (stopped ? "off" : service.getMode()),
      getStatus: () => {
        const s = service.getStatus();
        return Object.freeze({ mode: stopped ? "off" : s.mode, reason: stopped ? "STOPPED" : reason, listeners,
          counters: s.counters, lastRefusal: s.lastRefusal,
          crossings: stopped ? Object.freeze({ enabled: false, reason: "STOPPED" }) : crossings,
          strikePursuit: stopped ? Object.freeze({ enabled: false, reason: "STOPPED" }) : strikePursuit });
      },
      stop() {
        if (stopped) return;
        stopped = true;
        service.stop();
        removeAll();
        listeners = 0;
      },
    };
    return { ok: true, gridDefense: Object.freeze(facade) };
  } catch (err) {
    removeAll();
    return { ok: false, reason: "GRID_DEFENSE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startGridDefense, createUnavailableGridDefense, REQUIRED, SOFT_ROOTS };
