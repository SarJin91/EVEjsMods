"use strict";

const { isModuleEnabled } = require("../../../config");
const { createHostility } = require("../../battle/data/hostility");
const { parseFleetRoleList, parseOperationTypeList } = require("../../fleets/schema");
const { createPoller } = require("../../presence/poller");
const { rowBoundsOfConfig, rowBoundOverflow } = require("../reviewBound");
const { createRiskIndex } = require("./riskIndex");
const { createTransitService, CHECKPOINT_EVENT } = require("./service");

const STATE_READY = "ready";
const MODES = Object.freeze(["observe", "on"]);
const REQUIRED = Object.freeze(["fleets.repository.getOperation", "fleets.repository.getFleet",
  "fleets.repository.listFleetsInSystem", "fleets.travel.addDepartureListener", "fleets.travel.interceptInTx",
  "world.listSystems", "world.repository.getSystem", "world.repository.getSystems",
  "scheduler.registerHandler", "scheduler.enqueue", "scheduler.getStatus", "scheduler.scanKeys",
  "persistence.store.transaction", "persistence.store.getTxSeq", "persistence.journal.applyOnce",
  "persistence.journal.findByKey", "persistence.journal.countKeyRange",
  "battle.createFixedDefenseBattleInTx", "battle.readCooldownsInTx", "battle.getStatus",
  "presence.distanceToObserved", "sentries.listLiveInSystem", "sentries.getMode",
  "fleets.travel.addRouteAdvisor"]);
const OBSERVE_PATHS = Object.freeze(["fleets.repository.getOperation", "fleets.travel.addDepartureListener",
  "world.listSystems"]);
const SOFT_ROOTS = Object.freeze(["sentries", "battle", "presence"]);
const INT_KEYS = Object.freeze([["basePermille", 0, 1000], ["controlPermille", 0, 1000],
  ["garrisonPermillePer1000", 0, 1000], ["garrisonCapPermille", 0, 1000], ["sentryPermilleEach", 0, 1000],
  ["sentryCapPermille", 0, 1000], ["maxChancePermille", 0, 1000], ["smallGangMaxShips", 1, 64],
  ["smallGangPermille", 0, 1000], ["largeFleetMinShips", 2, 2000], ["largeFleetPermille", 0, 1000],
  ["evasiveRolePermille", 0, 1000], ["listenerMaxSystems", 1, 128], ["indexPageSize", 16, 1000],
  ["indexPageIntervalMs", 200, 60000], ["indexRefreshMs", 60000, 86400000],
  ["maxChecksPerLeg", 1, 32], ["maxCheckpointsPerTransaction", 1, 8], ["maxEventsPerPass", 1, 1024],
  ["haltsPerControllerHour", 0, 1000], ["contactScanFleets", 1, 500], ["defenderBonusPermille", 0, 1000],
  ["picketPermillePerBattery", 1, 1000], ["picketMaxBatteries", 1, 32], ["picketBatteryHp", 1, 1e9],
  ["picketBatteryDps", 0, 1e6], ["picketBatterySignature", 1, 1e9], ["picketBatteryDesignSig", 1, 1e9],
  ["picketBatteryTypeId", 1, 2147483647], ["picketAttackerRetreatLossPermille", 50, 1000],
  ["advisorAvoidPermille", 0, 1000], ["advisorDetourMaxJumps", 0, 64]]);
const SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole", "other"]);
const NONE = "none";
const KEY_PREFIX = "transit:";
const KEY_RANGE_END = "transit;";
const DRAIN_SCAN_LIMIT = 1000;
const FINAL_STATES = Object.freeze(["DONE", "QUARANTINED"]);
const DRAIN_MAX_PER_PASS = 32;
const MAX_DETAIL = 120;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

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

function missingPaths(roots, paths) {
  const out = [];
  for (const path of paths) {
    const parts = path.split(".");
    if (SOFT_ROOTS.includes(parts[0])) continue;
    let v = roots[parts[0]];
    for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
    if (typeof v !== "function") out.push(path);
  }
  return out;
}

function parseFactionIds(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t === "" || t === NONE) return Object.freeze([]);
  const parts = t.split(",").map((p) => p.trim());
  if (!parts.every((p) => /^\d+$/.test(p) && Number(p) > 0 && Number.isSafeInteger(Number(p)))) return null;
  const ids = parts.map(Number);
  return new Set(ids).size === ids.length ? Object.freeze(ids) : null;
}

function parseRoles(text) {
  if (typeof text !== "string") return null;
  return text.trim() === "" ? Object.freeze([]) : parseFleetRoleList(text);
}

function parseSecClasses(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length === 0 || !parts.every((p) => SEC_CLASSES.includes(p))) return null;
  return Object.freeze([...new Set(parts)]);
}

function settingsOf(config) {
  const t = config && config.transit;
  if (!t) return { ok: false, key: "transit" };
  if (!MODES.includes(t.mode)) return { ok: false, key: "transit.mode" };
  for (const [key, min, max] of INT_KEYS) {
    if (!Number.isSafeInteger(t[key]) || t[key] < min || t[key] > max) return { ok: false, key: `transit.${key}` };
  }
  const secClasses = parseSecClasses(t.secClasses);
  if (!secClasses) return { ok: false, key: "transit.secClasses" };
  const exemptFactionIds = parseFactionIds(t.exemptFactionIds);
  if (!exemptFactionIds) return { ok: false, key: "transit.exemptFactionIds" };
  const exemptRoles = parseRoles(t.exemptRoles);
  if (!exemptRoles) return { ok: false, key: "transit.exemptRoles" };
  const exemptOperationTypes = parseOperationTypeList(t.exemptOperationTypes);
  if (!exemptOperationTypes) return { ok: false, key: "transit.exemptOperationTypes" };
  const contactRoles = parseRoles(t.contactRoles);
  if (!contactRoles) return { ok: false, key: "transit.contactRoles" };
  if (typeof t.advisorEnabled !== "boolean") return { ok: false, key: "transit.advisorEnabled" };
  const maxRows = config.persistence ? config.persistence.maxRowsPerTransaction : undefined;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) return { ok: false, key: "persistence.maxRowsPerTransaction" };
  const ints = Object.fromEntries(INT_KEYS.map(([key]) => [key, t[key]]));
  return { ok: true, settings: Object.freeze({ mode: t.mode, secClasses, exemptFactionIds, exemptRoles,
    exemptOperationTypes, contactRoles, maxRowsPerTransaction: maxRows, advisorEnabled: t.advisorEnabled, ...ints }) };
}

function hasOpenRows(persistence, scheduler) {
  try {
    const r = persistence.store.transaction("transit.drainScan", (db) => scheduler.scanKeys({ fromKey: KEY_PREFIX,
      toKey: KEY_RANGE_END, afterKey: null, limit: DRAIN_SCAN_LIMIT }, { tx: db }));
    if (!r || r.ok !== true) return { error: String((r && (r.reason || r.code)) || "TX_FAILED") };
    const scan = r.value;
    if (!scan || scan.ok !== true || !Array.isArray(scan.rows)) {
      return { error: String((scan && scan.reason) || "SCAN_FAILED") };
    }
    return { open: scan.rows.length >= DRAIN_SCAN_LIMIT || scan.rows.some((row) => !FINAL_STATES.includes(row.state)) };
  } catch (err) {
    return { error: messageOf(err) };
  }
}

function createUnavailableTransit(reason, detail) {
  const status = Object.freeze({ state: "unavailable", mode: "off", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}), counters: Object.freeze({}), lastRefusal: null });
  return Object.freeze({ getMode: () => "off", getStatus: () => status, riskOf: () => null, routeRiskOf: () => null,
    stop() {} });
}

function startTransit(deps) {
  const registrations = [];
  const removeAll = () => {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
  };
  try {
    const { config, fleets, world, persistence, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.transit) return { ok: false, reason: "disabled_by_config" };
    const t = config.transit;
    const enabled = t.enabled === true;
    const on = enabled && t.mode === "on";
    let drain = false;
    let drainDetail = null;
    if (!on) {
      const usable = Boolean(persistence && persistence.ok === true && persistence.store && persistence.journal
        && scheduler && stateOf(scheduler) === STATE_READY && typeof scheduler.scanKeys === "function");
      if (usable) {
        const open = hasOpenRows(persistence, scheduler);
        drain = open.error !== undefined || open.open === true;
        if (open.error !== undefined) drainDetail = `drain scan: ${open.error}`;
      }
      if (!enabled && !drain) return { ok: false, reason: "disabled_by_config" };
    }
    if (on) {
      const over = rowBoundOverflow(rowBoundsOfConfig(config),
        config.persistence ? config.persistence.maxRowsPerTransaction : undefined);
      if (over) return { ok: false, reason: "TRANSIT_ROW_BOUND", detail: over };
    }
    const handlerMode = on ? "on" : (drain ? "drain" : null);
    if (handlerMode !== null) {
      if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
        return { ok: false, reason: "dependency_disabled:persistence" };
      }
      if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    if (!fleets || !fleets.repository || !fleets.travel) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    if (!world || stateOf(world) !== STATE_READY) return { ok: false, reason: "WORLD_UNAVAILABLE" };
    const missing = handlerMode !== null ? missingPaths({ fleets, world, scheduler, persistence }, REQUIRED)
      : missingPaths({ fleets, world }, OBSERVE_PATHS);
    if (missing.length > 0) return { ok: false, reason: "TRANSIT_FACADE_MISSING", detail: missing.join(",") };
    let S = null;
    if (enabled) {
      const parsed = settingsOf(config);
      if (!parsed.ok) return { ok: false, reason: "INVALID_CONFIG", detail: parsed.key };
      S = parsed.settings;
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const holder = { service: null };
    const index = enabled ? createRiskIndex({ world, getSentries: deps.getSentries, settings: S, nowMs: deps.nowMs,
      onBuilt: (info) => holder.service && holder.service.noteIndexBuilt(info),
      onPageRefused: (reason) => holder.service && holder.service.noteIndexPageRefused(reason),
      onWaitSeed: () => holder.service && holder.service.noteIndexWaitSeed(),
      onSeedDegraded: (state) => holder.service && holder.service.noteIndexSeedDegraded(state) }) : null;
    const service = createTransitService({ fleetRepository: fleets.repository, index, settings: S,
      mode: enabled ? S.mode : null, handlerMode,
      isHostile: typeof deps.isHostile === "function" ? deps.isHostile : createHostility(),
      telemetry: deps.telemetry || null, logger, store: persistence ? persistence.store : null,
      journal: persistence ? persistence.journal : null, scheduler: scheduler || null, travel: fleets.travel,
      worldRepository: world.repository || null, worldSeed: persistence ? persistence.worldSeed : 0,
      getBattle: deps.getBattle, getPresence: deps.getPresence });
    holder.service = service;

    if (handlerMode !== null) {
      const maxPerPass = S ? S.maxEventsPerPass : (Number.isSafeInteger(t.maxEventsPerPass) && t.maxEventsPerPass > 0
        ? t.maxEventsPerPass : DRAIN_MAX_PER_PASS);
      let handler;
      try {
        handler = scheduler.registerHandler(CHECKPOINT_EVENT, service.onCheckpoint, { maxPerPass });
      } catch (err) {
        handler = { ok: false, reason: messageOf(err) };
      }
      if (!handler || !handler.ok) {
        return { ok: false, reason: "TRANSIT_START_FAILED",
          detail: `handler ${CHECKPOINT_EVENT}: ${(handler && handler.reason) || "no result"}` };
      }
      registrations.push(() => handler.unregister());
    }
    let listeners = 0;
    let advisors = 0;
    if (enabled) {
      const listener = fleets.travel.addDepartureListener(service.onDeparture);
      if (!listener || listener.ok !== true) {
        removeAll();
        return { ok: false, reason: "TRANSIT_START_FAILED",
          detail: `departure listener: ${(listener && listener.reason) || "no result"}` };
      }
      registrations.push(() => listener.remove());
      listeners = 1;
      if (on && S.advisorEnabled) {
        const a = fleets.travel.addRouteAdvisor(service.routeAdvice);
        if (!a || a.ok !== true) {
          removeAll();
          return { ok: false, reason: "TRANSIT_START_FAILED",
            detail: `route advisor: ${(a && a.reason) || "no result"}` };
        }
        registrations.push(() => a.remove());
        advisors = 1;
      }
      const poller = createPoller({ runPass: () => index.step(), intervalMs: S.indexPageIntervalMs,
        now: typeof deps.nowMs === "function" ? deps.nowMs : () => Date.now(),
        ...(typeof deps.setTimer === "function" ? { setTimer: deps.setTimer } : {}) });
      const started = poller.start();
      if (!started || started.ok !== true) {
        removeAll();
        return { ok: false, reason: "TRANSIT_START_FAILED", detail: `index timer: ${(started && started.reason)
          || "no result"}` };
      }
      registrations.push(() => poller.stop());
      poller.arm(0);
      const t = deps.telemetry;
      if (t && typeof t.registerMemoryProbe === "function") {
        const probe = t.registerMemoryProbe("transit.riskIndex", () => ({ entries: index.getStatus().systems }));
        if (probe && probe.ok === true) registrations.push(() => probe.unregister());
      }
    }
    const modeName = enabled ? S.mode : "drain";
    logger.log(`transit: mode=${modeName} handler=${handlerMode || "none"}`
      + `${S ? ` secClasses=${S.secClasses.join(",")} pageSize=${S.indexPageSize} pageMs=${S.indexPageIntervalMs}`
        + ` refreshMs=${S.indexRefreshMs}` : ""}`
      + `${on ? ` budget=${S.maxCheckpointsPerTransaction} halts/h=${S.haltsPerControllerHour}` : ""}`
      + `${advisors > 0 ? ` advisor=on avoid=${S.advisorAvoidPermille} detour=${S.advisorDetourMaxJumps}` : ""}`
      + `${drainDetail ? ` (${drainDetail})` : ""}`);

    const facade = {
      getMode: service.getMode,
      getStatus: () => Object.freeze({ ...service.getStatus(), state: service.isStopped() ? "stopped" : STATE_READY,
        listeners: service.isStopped() ? 0 : listeners, advisors: service.isStopped() ? 0 : advisors,
        ...(drainDetail ? { detail: drainDetail } : {}) }),
      riskOf: (systemId) => (service.isStopped() ? null : service.riskOf(systemId)),
      routeRiskOf: (factionId, systems, opts) => (service.isStopped() ? null
        : service.routeRiskOf(factionId, systems, opts)),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        removeAll();
      },
    };
    return { ok: true, transit: Object.freeze(facade) };
  } catch (err) {
    removeAll();
    return { ok: false, reason: "TRANSIT_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startTransit, createUnavailableTransit, settingsOf, REQUIRED, OBSERVE_PATHS, SOFT_ROOTS };
