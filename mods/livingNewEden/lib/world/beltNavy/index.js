"use strict";

const { deriveSeed } = require("../../util/rng");
const { computeNavyShare } = require("./shareRules");
const { createAggroService } = require("./aggroService");

const STREAM = "belt-navy";
const SITE_STREAM = "site-navy";
const UINT32_RANGE = 0x100000000;

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createBeltNavyRoll(deps) {
  const { getWorld, getOccupation, worldSeed, settings } = deps;

  function decide(input) {
    const { systemId, factionId, spawnSiteId, atMs } = input || {};
    if (!positiveId(systemId) || !positiveId(factionId) || typeof spawnSiteId !== "string" || spawnSiteId.length === 0
      || !Number.isFinite(atMs)) {
      return { ok: false, reason: "BAD_INPUT" };
    }
    const read = readShare(systemId, factionId, atMs);
    if (!read.ok) return read;
    const bucket = Math.floor(atMs / settings.rollBucketMs);
    const unit = deriveSeed(worldSeed, STREAM, systemId, spawnSiteId, bucket) / UINT32_RANGE;
    return { ok: true, navy: unit < read.share, share: read.share, unit };
  }

  function readShare(systemId, factionId, atMs) {
    if (!Number.isInteger(worldSeed)) return { ok: false, reason: "NO_SEED" };
    const world = getWorld();
    if (!world || typeof world.getControlState !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
    const read = world.getControlState(systemId);
    if (!read || read.ok !== true) return { ok: false, reason: (read && read.reason) || "NO_RESULT" };
    const sys = read.system;
    if (!sys || sys.controllerFactionId !== factionId) return { ok: false, reason: "CONTROL_CHANGED" };
    const occupation = getOccupation();
    if (!occupation || typeof occupation.effectiveScoreOf !== "function") return { ok: false, reason: "NO_SCORE" };
    const score = occupation.effectiveScoreOf(sys, factionId, atMs);
    return { ok: true, share: computeNavyShare({ occupationState: sys.occupationState, score }, settings) };
  }

  function decideSite(input) {
    const { systemId, factionId, instanceId, atMs } = input || {};
    if (!positiveId(systemId) || !positiveId(factionId) || !positiveId(instanceId) || !Number.isFinite(atMs)) {
      return { ok: false, reason: "BAD_INPUT" };
    }
    const read = readShare(systemId, factionId, atMs);
    if (!read.ok) return read;
    const unit = deriveSeed(worldSeed, SITE_STREAM, systemId, instanceId) / UINT32_RANGE;
    return { ok: true, navy: unit < read.share, share: read.share, unit };
  }

  return Object.freeze({ decide, decideSite });
}

function startBeltNavy(deps) {
  try {
    const { config, adapter, clock } = deps || {};
    const settings = config && config.world && config.world.beltNavy;
    if (!settings || settings.standingAggroEnabled !== true) return { ok: false, reason: "disabled_by_config" };
    const methods = ["checkBeltNavyScene", "getBeltNavyScene", "checkHuntScene", "getHuntScene", "checkNpcSpawn",
      "getNpcSpawn", "readCharacterStanding", "checkStandingRead"];
    const absent = adapter ? methods.filter((name) => typeof adapter[name] !== "function") : methods;
    if (absent.length > 0) return { ok: false, reason: "BELT_NAVY_SEAM_UNAVAILABLE", detail: absent.join(",") };
    for (const check of [adapter.checkBeltNavyScene(), adapter.checkHuntScene(), adapter.checkNpcSpawn(),
      adapter.checkStandingRead()]) {
      if (!check || check.ok !== true) {
        return { ok: false, reason: "BELT_NAVY_SEAM_UNAVAILABLE",
          detail: check && (check.missing ? check.missing.join(",") : check.reason) };
      }
    }
    return { ok: true, beltNavy: createAggroService({ hunt: adapter.getHuntScene(), scene: adapter.getBeltNavyScene(),
      spawn: adapter.getNpcSpawn(), readStanding: (c, f) => adapter.readCharacterStanding(c, f),
      getStandings: deps.getStandings, clock, settings, telemetry: deps.telemetry || null, logger: deps.logger,
      setTimer: deps.setTimer, nowMs: deps.nowMs }) };
  } catch (err) {
    return { ok: false, reason: "BELT_NAVY_START_FAILED", detail: String((err && err.message) || err) };
  }
}

module.exports = { createBeltNavyRoll, startBeltNavy };
