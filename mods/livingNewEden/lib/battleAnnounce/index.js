"use strict";

const { isModuleEnabled } = require("../../config");
const { readFactionNames } = require("../world/sovProjection");
const { rowBoundsOfConfig, rowBoundOverflow } = require("../strategy/reviewBound");
const { createBattleAnnounceRepository } = require("./repository");
const { createBattleAnnounceService, COUNTER_NAMES } = require("./service");
const { parseOperationTypes } = require("./rules");
const S = require("./schema");

const BATTLE_ANNOUNCE_METHODS = Object.freeze(["getStatus", "stop"]);
const INT_KEYS = Object.freeze([["minLeadMs", 0, 3600000], ["proximityJumps", 0, 5], ["maxScanCharacters", 0, 2000],
  ["maxRecipientsPerAnnouncement", 1, 200], ["maxPerCharacterPerDay", 1, 100], ["capWindowMs", 3600000, 604800000],
  ["maxOpenWatches", 1, 1000], ["maxAnnouncementsPerTransaction", 1, 16], ["maxAnnouncementsPerPass", 1, 64],
  ["maxChecksPerPass", 1, 128], ["checkIntervalMs", 30000, 3600000], ["noBattleGraceMs", 0, 21600000],
  ["maxWatchMs", 600000, 86400000], ["staleAfterMs", 60000, 86400000], ["battleScanLimit", 1, 32],
  ["retentionMs", 3600000, 2592000000], ["pruneBatch", 0, 20]]);
const REQUIRED = Object.freeze(["persistence.store.transaction", "persistence.store.getTxSeq",
  "scheduler.registerHandler", "scheduler.enqueue", "fleets.repository.getOperation",
  "fleets.repository.listFleetsOfOperation", "fleets.travel.addDepartureListener", "notices.enqueueItemsInTx", "notices.getStatus"]);

const messageOf = (err) => String((err && err.message) || err);

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
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

function settingsOf(config) {
  const s = config && config.battleAnnounce;
  if (!s) return { ok: false, key: "battleAnnounce" };
  for (const [key, min, max] of INT_KEYS) {
    if (!Number.isSafeInteger(s[key]) || s[key] < min || s[key] > max) return { ok: false, key: `battleAnnounce.${key}` };
  }
  if (typeof s.standingMin !== "number" || !(s.standingMin >= 0 && s.standingMin <= 10)) {
    return { ok: false, key: "battleAnnounce.standingMin" };
  }
  if (typeof s.mailOnExpired !== "boolean") return { ok: false, key: "battleAnnounce.mailOnExpired" };
  const types = parseOperationTypes(s.operationTypes);
  if (!types) return { ok: false, key: "battleAnnounce.operationTypes" };
  const settings = Object.freeze(Object.fromEntries([...INT_KEYS.map(([k]) => [k, s[k]]),
    ["standingMin", s.standingMin], ["mailOnExpired", s.mailOnExpired]]));
  return { ok: true, settings, types };
}

function createUnavailableBattleAnnounce(reason, detail) {
  const status = Object.freeze({ state: "unavailable", mode: "off", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ getStatus: () => status, stop() {} });
}

function startBattleAnnounce(deps) {
  const registrations = [];
  const removeAll = () => {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
  };
  try {
    const { config } = deps || {};
    const ctx = (deps && deps.ctx) || {};
    if (!config || !config.battleAnnounce || config.battleAnnounce.enabled !== true
      || !isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
    const notices = ctx.notices;
    let noticesState = null;
    try {
      noticesState = notices && typeof notices.getStatus === "function" ? notices.getStatus().state : null;
    } catch (_err) {
      noticesState = null;
    }
    if (!(config.notices && config.notices.enabled === true) || noticesState !== "running") {
      return { ok: false, reason: "NOTICES_DISABLED" };
    }
    const parsed = settingsOf(config);
    if (!parsed.ok) return { ok: false, reason: "CONFIG_INVALID", detail: parsed.key };
    const over = rowBoundOverflow(rowBoundsOfConfig(config),
      config.persistence ? config.persistence.maxRowsPerTransaction : undefined);
    if (over) return { ok: false, reason: "ROW_BOUND", detail: over };
    const persistence = ctx.persistence;
    const scheduler = ctx.scheduler;
    const fleets = ctx.fleets;
    if (!persistence || persistence.ok !== true) {
      return { ok: false, reason: "BATTLE_ANNOUNCE_START_FAILED", detail: "persistence" };
    }
    const missing = missingPaths({ persistence, scheduler, fleets, notices });
    if (missing.length > 0) return { ok: false, reason: "BATTLE_ANNOUNCE_START_FAILED", detail: missing.join(",") };
    const adapter = deps.adapter || null;
    const C = parsed.settings;
    let readStanding = null;
    if (C.standingMin > 0) {
      if (!adapter || typeof adapter.readCharacterStanding !== "function") {
        return { ok: false, reason: "BATTLE_ANNOUNCE_SEAM_UNAVAILABLE", detail: "readCharacterStanding" };
      }
      readStanding = (characterId, factionId) => adapter.readCharacterStanding(characterId, factionId);
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
    const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => clock.now();
    const service = createBattleAnnounceService({ store: persistence.store, scheduler,
      fleetRepository: fleets.repository, repo: createBattleAnnounceRepository(), notices: () => ctx.notices,
      settings: C, types: parsed.types,
      getBattleRepository: () => (ctx.battle && ctx.battle.repository) || null,
      getWorldRepository: () => (ctx.world && ctx.world.repository) || null,
      getPresence: () => ctx.presence || null, getGraph: () => ctx.graph || null, readStanding,
      names: readFactionNames(adapter, logger), clock, nowMs, telemetry: deps.telemetry || null, logger });

    for (const [type, fn, maxPerPass] of [[S.ANNOUNCE_EVENT, service.onAnnounce, C.maxAnnouncementsPerPass],
      [S.CHECK_EVENT, service.onCheck, C.maxChecksPerPass]]) {
      let handler;
      try {
        handler = scheduler.registerHandler(type, fn, { maxPerPass });
      } catch (err) {
        handler = { ok: false, reason: messageOf(err) };
      }
      if (!handler || handler.ok !== true) {
        removeAll();
        return { ok: false, reason: "BATTLE_ANNOUNCE_START_FAILED",
          detail: `handler ${type}: ${(handler && handler.reason) || "no result"}` };
      }
      registrations.push(() => handler.unregister());
    }
    const listener = fleets.travel.addDepartureListener(service.onDeparture);
    if (!listener || listener.ok !== true) {
      removeAll();
      return { ok: false, reason: "BATTLE_ANNOUNCE_START_FAILED",
        detail: `departure listener: ${(listener && listener.reason) || "no result"}` };
    }
    registrations.push(() => listener.remove());
    logger.log(`battleAnnounce: on types=${[...parsed.types].join(",")} jumps=${C.proximityJumps} `
      + `standingMin=${C.standingMin} lead=${C.minLeadMs} budget=${C.maxAnnouncementsPerTransaction}`);

    const facade = {
      getStatus: () => Object.freeze({ ...service.getStatus(), listeners: service.isStopped() ? 0 : 1 }),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        removeAll();
      },
    };
    return { ok: true, battleAnnounce: Object.freeze(facade) };
  } catch (err) {
    removeAll();
    return { ok: false, reason: "BATTLE_ANNOUNCE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startBattleAnnounce, createUnavailableBattleAnnounce, settingsOf, COUNTER_NAMES,
  BATTLE_ANNOUNCE_METHODS };
