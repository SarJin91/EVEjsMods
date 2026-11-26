"use strict";

const { isModuleEnabled } = require("../../../config");
const { createHostility } = require("../../battle/data/hostility");
const { parseFleetRoleList } = require("../../fleets/schema");
const { FORTRESSES } = require("../data/fortresses");
const { rowBoundsOfConfig, rowBoundOverflow } = require("../reviewBound");
const { createFortressService, CHECKPOINT_EVENT } = require("./service");
const { createHaltMemoryRepository } = require("./memoryRepository");

const STATE_READY = "ready";
const REQUIRED = Object.freeze(["fleets.repository.getFleet", "fleets.travel.interceptInTx",
  "fleets.travel.addDepartureListener", "fleets.travel.addRouteAdvisor", "scheduler.registerHandler",
  "scheduler.enqueue", "scheduler.getStatus", "scheduler.scanKeys", "persistence.store.transaction",
  "persistence.store.getTxSeq", "persistence.journal.applyOnce", "persistence.journal.findByKey",
  "battle.createFixedDefenseBattleInTx", "presence.distanceToObserved"]);
const SOFT_ROOTS = Object.freeze(["battle", "presence"]);
const INT_KEYS = Object.freeze([["interceptChancePermille", 0, 1000], ["batteryCount", 1, 64],
  ["batteryHp", 1, 1e9], ["batteryDps", 0, 1e6], ["batterySignature", 1, 1e9], ["batteryDesignSig", 1, 1e9],
  ["batteryTypeId", 1, 2147483647], ["attackerRetreatLossPermille", 50, 1000],
  ["maxCheckpointsPerTransaction", 1, 8], ["haltMemoryMs", 60000, 2592000000], ["haltMemoryDetourMaxJumps", 0, 64]]);
const KEY_PREFIX = "fortress:";
const KEY_RANGE_END = "fortress;";
const DRAIN_SCAN_LIMIT = 1000;
const FINAL_STATES = Object.freeze(["DONE", "QUARANTINED"]);
const NONE = "none";
const MAX_DETAIL = 120;

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

function settingsOf(config) {
  const f = config && config.fortress;
  if (!f) return { ok: false, key: "fortress" };
  for (const [key, min, max] of INT_KEYS) {
    if (!Number.isSafeInteger(f[key]) || f[key] < min || f[key] > max) return { ok: false, key: `fortress.${key}` };
  }
  const exemptFactionIds = parseFactionIds(f.exemptFactionIds);
  if (!exemptFactionIds) return { ok: false, key: "fortress.exemptFactionIds" };
  const exemptRoles = parseRoles(f.exemptRoles);
  if (!exemptRoles) return { ok: false, key: "fortress.exemptRoles" };
  if (typeof f.haltMemoryEnabled !== "boolean") return { ok: false, key: "fortress.haltMemoryEnabled" };
  return { ok: true, settings: Object.freeze({ interceptChancePermille: f.interceptChancePermille,
    batteryCount: f.batteryCount, batteryHp: f.batteryHp, batteryDps: f.batteryDps,
    batterySignature: f.batterySignature, batteryDesignSig: f.batteryDesignSig, batteryTypeId: f.batteryTypeId,
    attackerRetreatLossPermille: f.attackerRetreatLossPermille, exemptFactionIds, exemptRoles,
    maxCheckpointsPerTransaction: f.maxCheckpointsPerTransaction, haltMemoryEnabled: f.haltMemoryEnabled,
    haltMemoryMs: f.haltMemoryMs, haltMemoryDetourMaxJumps: f.haltMemoryDetourMaxJumps }) };
}

function hasOpenRows(persistence, scheduler) {
  try {
    const r = persistence.store.transaction("fortress.drainScan", (db) => scheduler.scanKeys({ fromKey: KEY_PREFIX,
      toKey: KEY_RANGE_END, afterKey: null, limit: DRAIN_SCAN_LIMIT }, { tx: db }));
    if (!r || r.ok !== true) return { error: String((r && (r.reason || r.code)) || "TX_FAILED") };
    const scan = r.value;
    if (!scan || scan.ok !== true || !Array.isArray(scan.rows)) {
      return { error: String((scan && scan.reason) || "SCAN_FAILED") };
    }
    return { open: scan.rows.length >= DRAIN_SCAN_LIMIT || scan.rows.some((row) => !FINAL_STATES.includes(row.state)) };
  } catch (err) {
    return { error: messageOf(err).slice(0, MAX_DETAIL) };
  }
}

function loadMemory(store, repo) {
  try {
    const r = store.transaction("fortress.memoryLoad", (db) => repo.listAllInTx(db));
    if (!r || r.ok !== true) return { ok: false, reason: String((r && (r.reason || r.code)) || "TX_FAILED") };
    const v = r.value;
    if (!v || v.ok !== true || !Array.isArray(v.rows)) {
      return { ok: false, reason: String((v && v.reason) || "READ_FAILED") };
    }
    return { ok: true, rows: v.rows };
  } catch (err) {
    return { ok: false, reason: messageOf(err).slice(0, MAX_DETAIL) };
  }
}

function createUnavailableFortress(reason, detail) {
  const status = Object.freeze({ state: "unavailable", mode: "off", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}), counters: Object.freeze({}), lastRefusal: null });
  return Object.freeze({ getMode: () => "off", getStatus: () => status, stop() {} });
}

function startFortress(deps) {
  const registrations = [];
  const removeAll = () => {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
  };
  try {
    const { config, persistence, scheduler, fleets } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.fortress) return { ok: false, reason: "disabled_by_config" };
    const on = config.fortress.checkpointEnabled === true;
    const usable = Boolean(persistence && persistence.ok === true && persistence.store && persistence.journal
      && scheduler && stateOf(scheduler) === STATE_READY && typeof scheduler.scanKeys === "function");
    let drainDetail = null;
    if (!on) {
      if (!usable) return { ok: false, reason: "disabled_by_config" };
      const open = hasOpenRows(persistence, scheduler);
      if (open.error === undefined && open.open !== true) return { ok: false, reason: "disabled_by_config" };
      if (open.error !== undefined) drainDetail = `drain scan: ${open.error}`;
    }
    if (on) {
      const over = rowBoundOverflow(rowBoundsOfConfig(config),
        config.persistence ? config.persistence.maxRowsPerTransaction : undefined);
      if (over) return { ok: false, reason: "FORTRESS_ROW_BOUND", detail: over };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    if (!fleets || !fleets.repository || !fleets.travel) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    const missing = missingPaths({ fleets, scheduler, persistence });
    if (missing.length > 0) return { ok: false, reason: "FORTRESS_FACADE_MISSING", detail: missing.join(",") };
    let settings = null;
    if (on) {
      const parsed = settingsOf(config);
      if (!parsed.ok) return { ok: false, reason: "INVALID_CONFIG", detail: parsed.key };
      settings = parsed.settings;
    }
    const mode = on ? "on" : "drain";
    const fortresses = Array.isArray(deps.fortresses) ? deps.fortresses : FORTRESSES;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const memoryOn = on && settings.haltMemoryEnabled === true;
    const memoryRepo = memoryOn ? createHaltMemoryRepository() : null;
    let memoryRows = [];
    let memoryState = "off";
    let memoryRefusal = null;
    if (memoryOn) {
      const loaded = loadMemory(persistence.store, memoryRepo);
      memoryState = loaded.ok ? "ready" : "load_failed";
      memoryRows = loaded.ok ? loaded.rows : [];
      memoryRefusal = loaded.ok ? null : `MEMORY_LOAD:${loaded.reason}`;
    }
    const service = createFortressService({ store: persistence.store, journal: persistence.journal, scheduler,
      fleetRepository: fleets.repository, travel: fleets.travel, settings, fortresses, mode,
      worldSeed: persistence.worldSeed, isHostile: typeof deps.isHostile === "function" ? deps.isHostile
        : createHostility(), getBattle: deps.getBattle, getPresence: deps.getPresence,
      telemetry: deps.telemetry || null, logger, memoryRepo, memoryRows, memoryState, memoryRefusal });

    let handler;
    try {
      handler = scheduler.registerHandler(CHECKPOINT_EVENT, service.onCheckpoint);
    } catch (err) {
      handler = { ok: false, reason: messageOf(err) };
    }
    if (!handler || !handler.ok) {
      return { ok: false, reason: "FORTRESS_START_FAILED",
        detail: `handler ${CHECKPOINT_EVENT}: ${(handler && handler.reason) || "no result"}` };
    }
    registrations.push(() => handler.unregister());
    let listeners = 0;
    if (on) {
      const listener = fleets.travel.addDepartureListener(service.onDeparture);
      if (!listener || listener.ok !== true) {
        removeAll();
        return { ok: false, reason: "FORTRESS_START_FAILED",
          detail: `departure listener: ${(listener && listener.reason) || "no result"}` };
      }
      registrations.push(() => listener.remove());
      listeners = 1;
    }
    let advisors = 0;
    if (memoryOn) {
      const advisor = fleets.travel.addRouteAdvisor(service.routeAdvice);
      if (!advisor || advisor.ok !== true) {
        removeAll();
        return { ok: false, reason: "FORTRESS_START_FAILED",
          detail: `route advisor: ${(advisor && advisor.reason) || "no result"}` };
      }
      registrations.push(() => advisor.remove());
      advisors = 1;
    }
    logger.log(`fortress: mode=${mode} systems=${fortresses.map((f) => f.systemId).join(",") || "none"}`
      + `${on ? ` chance=${settings.interceptChancePermille} batteries=${settings.batteryCount}` : ""}`
      + `${on ? ` budget=${settings.maxCheckpointsPerTransaction}` : ""}`
      + `${memoryOn ? ` memory=${memoryState} entries=${memoryRows.length}` : ""}`
      + `${drainDetail ? ` (${drainDetail})` : ""}`);

    const facade = {
      getMode: service.getMode,
      getStatus: () => Object.freeze({ ...service.getStatus(), listeners: service.isStopped() ? 0 : listeners,
        advisors: service.isStopped() ? 0 : advisors, ...(drainDetail ? { detail: drainDetail } : {}) }),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        removeAll();
      },
    };
    return { ok: true, fortress: Object.freeze(facade) };
  } catch (err) {
    removeAll();
    return { ok: false, reason: "FORTRESS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startFortress, createUnavailableFortress, settingsOf, REQUIRED, SOFT_ROOTS };
