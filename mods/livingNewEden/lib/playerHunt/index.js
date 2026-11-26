"use strict";

const { isModuleEnabled } = require("../../config");
const { createHuntRepository, END_ROWS } = require("./huntRepository");
const { recoverStale } = require("./recovery");
const { parseNeutralPolicy, parseRoleList, parseObjectKinds, parseSecClassList, repelKey } = require("./schema");
const { createPursuitWriter } = require("./pursuitWriter");
const { planRepel } = require("./repel");
const { parseHullGroupList } = require("../fleets/schema");

const PLAYER_HUNT_METHODS = Object.freeze(["isEnabled", "claimInTx", "markLiveInTx", "markDestroyedInTx", "endInTx",
  "listOpenInTx", "readInTx", "lastEndedAtInTx", "recoverStale", "getStatus", "stop", "pursueInTx",
  "pursueNextInTx", "endWithReturnInTx", "returnHomeInTx", "approachInTx", "recentEndedInTx"]);
const FLEET_METHODS = Object.freeze(["getFleet", "transition", "applyLosses"]);
const METRIC = Object.freeze({ recovered: "playerHunt.recovered", endFailed: "playerHunt.endFailed",
  repelApplied: "playerHunt.repelApplied", repelRefused: "playerHunt.repelRefused" });

const messageOf = (err) => String((err && err.message) || err);

function createUnavailablePlayerHunt(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: String(reason) });
  return Object.freeze({
    isEnabled: () => false,
    claimInTx: () => refusal,
    markLiveInTx: () => refusal,
    markDestroyedInTx: () => refusal,
    endInTx: () => refusal,
    listOpenInTx: () => refusal,
    readInTx: () => refusal,
    lastEndedAtInTx: () => null,
    recentEndedInTx: () => refusal,
    recoverStale: () => refusal,
    getStatus: () => status,
    stop() {},
    pursueInTx: () => refusal,
    pursueNextInTx: () => refusal,
    endWithReturnInTx: () => refusal,
    returnHomeInTx: () => refusal,
    approachInTx: () => refusal,
  });
}

function createRepelHook(getOccupation, lossPermille) {
  return (db, info) => {
    try {
      const plan = planRepel({ members: info.members, reason: info.reason, outcome: info.outcome }, { lossPermille });
      if (!plan.repel) return { applied: false, reason: plan.why };
      const occ = typeof getOccupation === "function" ? getOccupation() : null;
      if (!occ || typeof occ.claimOfInTx !== "function" || typeof occ.applyPlayerRepelInTx !== "function") {
        return { applied: false, reason: "OCCUPATION_UNAVAILABLE" };
      }
      const c = occ.claimOfInTx(db, info.systemId);
      if (!c || c.ok !== true) return { applied: false, reason: (c && c.reason) || "CLAIM_READ_FAILED" };
      if (c.claim === null || c.claim.occupierFactionId !== info.factionId) {
        return { applied: false, reason: "NOT_CLAIMANT" };
      }
      const r = occ.applyPlayerRepelInTx(db, { systemId: info.systemId, factionId: info.factionId,
        huntId: info.huntId, characterId: info.characterId, at: info.at }, repelKey(info.huntId));
      if (!r || r.ok !== true) return { applied: false, reason: (r && r.reason) || "REPEL_FAILED" };
      return { applied: r.outcome !== "DUPLICATE", outcome: r.outcome };
    } catch (_err) {
      return { applied: false, reason: "REPEL_THREW" };
    }
  };
}

function settingsOf(C) {
  if (!C || typeof C !== "object") return { ok: false, key: "playerHunt" };
  const neutralPolicy = parseNeutralPolicy(C.neutralPolicy);
  if (neutralPolicy === null) return { ok: false, key: "neutralPolicy" };
  const roles = parseRoleList(C.roles);
  if (roles === null) return { ok: false, key: "roles" };
  const scannerHullGroups = parseHullGroupList(C.scannerHullGroups);
  if (scannerHullGroups === null) return { ok: false, key: "scannerHullGroups" };
  const objectKinds = parseObjectKinds(C.objectKinds);
  if (objectKinds === null) return { ok: false, key: "objectKinds" };
  if (!Number.isSafeInteger(C.fleetScanMax) || C.fleetScanMax < 1) return { ok: false, key: "fleetScanMax" };
  if (parseSecClassList(C.pursuitAvoidSecClasses) === null) return { ok: false, key: "pursuitAvoidSecClasses" };
  return { ok: true, settings: Object.freeze({ neutralPolicy, roles, scannerHullGroups, objectKinds }) };
}

function startPlayerHunt(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    if (!isModuleEnabled(config, "fleets")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "PLAYER_HUNT_START_FAILED", detail: "clock" };
    }
    let fleets = null;
    try {
      fleets = typeof deps.getFleets === "function" ? deps.getFleets() : null;
    } catch (_err) {
      fleets = null;
    }
    const fleetRepository = fleets && fleets.repository;
    const missing = FLEET_METHODS.filter((m) => !fleetRepository || typeof fleetRepository[m] !== "function");
    if (missing.length > 0) return { ok: false, reason: "FLEETS_UNAVAILABLE", detail: missing.join(",") };
    const C = config.playerHunt;
    const parsed = settingsOf(C);
    if (!parsed.ok) return { ok: false, reason: "INVALID_CONFIG", detail: `playerHunt.${parsed.key}` };

    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const telemetry = deps.telemetry || null;
    const loyaltySpareEnabled = config.playerHunt && config.playerHunt.loyaltySpareEnabled === true;
    logger.log(`playerHunt: loyaltySpareEnabled=${loyaltySpareEnabled}`);
    const count = (name, n) => {
      if (n <= 0 || !telemetry || typeof telemetry.count !== "function") return;
      try {
        telemetry.count(name, n);
      } catch (_err) {
      }
    };
    const store = persistence.store;
    const crewsOn = typeof deps.getCrews === "function" && Boolean(config.crews && config.crews.enabled === true)
      && Number.isSafeInteger(config.crews.maxSettleRows) && config.crews.maxSettleRows > 0;
    const crewRows = crewsOn ? config.crews.maxSettleRows + 1 : 0;
    const repo = createHuntRepository({ journal: persistence.journal, fleetRepository,
      worldSeed: persistence.worldSeed, repel: createRepelHook(deps.getOccupation, C.claimRepelLossPermille),
      ...(typeof deps.releaseContact === "function" ? { releaseContact: deps.releaseContact } : {}),
      ...(crewsOn ? { getCrews: deps.getCrews, crewMaxRows: config.crews.maxSettleRows } : {}) });
    const maxRows = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
      ? store.limits.maxRowsPerTransaction : END_ROWS + crewRows;
    const pageLimit = Math.max(1, Math.min(C.fleetScanMax, Math.floor(maxRows / (END_ROWS + crewRows))));
    const bootAt = clock.now();
    let stopped = false;
    const stats = { recovered: 0, recoverFailed: 0, lastError: null };

    function recover(at) {
      const r = recoverStale(store, repo, at, pageLimit);
      stats.recovered += r.ended;
      stats.recoverFailed += r.failed;
      count(METRIC.recovered, r.ended);
      count(METRIC.endFailed, r.failed);
      count(METRIC.repelApplied, r.repelApplied || 0);
      count(METRIC.repelRefused, r.repelRefused || 0);
      if (!r.ok) stats.lastError = `${r.reason}${r.detail ? ` (${r.detail})` : ""}`;
      else if (r.lastError) stats.lastError = r.lastError;
      return r;
    }

    const boot = recover(bootAt);
    logger.log(`playerHunt: running enabled=${C.enabled === true} recovered=${boot.ended} failed=${boot.failed}`
      + `${boot.ok ? "" : ` recover=${boot.reason}`}${stats.lastError ? ` lastError=${stats.lastError}` : ""}`);

    const pursuit = createPursuitWriter({ repo, getFleets: deps.getFleets });
    const guard = (fn) => (...args) => (stopped ? { ok: false, reason: "PLAYER_HUNT_STOPPED" } : fn(...args));
    const facade = {
      isEnabled: () => !stopped && config.playerHunt.enabled === true,
      claimInTx: guard(repo.claimInTx),
      markLiveInTx: guard(repo.markLiveInTx),
      markDestroyedInTx: guard(repo.markDestroyedInTx),
      endInTx: guard(repo.endInTx),
      listOpenInTx: guard(repo.listOpenInTx),
      readInTx: guard(repo.readInTx),
      lastEndedAtInTx: (...args) => (stopped ? null : repo.lastEndedAtInTx(...args)),
      recentEndedInTx: guard(repo.recentEndedInTx),
      recoverStale: (req) => {
        if (stopped) return { ok: false, reason: "PLAYER_HUNT_STOPPED" };
        const at = req && Number.isSafeInteger(req.bootAt) && req.bootAt >= 0 ? req.bootAt : null;
        if (at === null) return { ok: false, reason: "PLAYER_HUNT_INVALID_INPUT", detail: "bootAt" };
        return recover(at);
      },
      getStatus: () => Object.freeze({ state: stopped ? "stopped" : "ready", enabled: config.playerHunt.enabled === true,
        bootAt, pageLimit, recovered: stats.recovered, recoverFailed: stats.recoverFailed,
        lastError: stats.lastError, settings: parsed.settings }),
      stop() {
        stopped = true;
      },
      pursueInTx: guard(pursuit.pursueInTx),
      pursueNextInTx: guard(pursuit.pursueNextInTx),
      endWithReturnInTx: guard(pursuit.endWithReturnInTx),
      returnHomeInTx: guard(pursuit.returnHomeInTx),
      approachInTx: guard(pursuit.approachInTx),
    };
    return { ok: true, playerHunt: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "PLAYER_HUNT_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startPlayerHunt, createUnavailablePlayerHunt, PLAYER_HUNT_METHODS };
