"use strict";

const { MS_PER_HOUR } = require("./schema");

function rateBucket(atMs) {
  return Math.floor(atMs / MS_PER_HOUR);
}

const rateKey = (characterId, systemId) => `${characterId}:${systemId}`;

function scoreOf(sys, factionId) {
  if (!sys || !Array.isArray(sys.influence) || !factionId) return 0;
  const row = sys.influence.find((i) => i && i.factionId === factionId);
  return row && Number.isFinite(row.influenceScore) ? row.influenceScore : 0;
}

function planKillDrop(kill, sys, opts) {
  if (!kill || !Number.isSafeInteger(kill.characterId) || kill.characterId <= 0 || !Number.isSafeInteger(kill.victimFactionId)
    || kill.victimFactionId <= 0 || !Number.isSafeInteger(kill.systemId) || kill.systemId <= 0
    || !Number.isSafeInteger(kill.atMs) || kill.atMs < 0) {
    return { ok: false, reason: "KILL_INVALID_INPUT" };
  }
  if (!sys) return { ok: false, reason: "NO_ROW" };
  const raw = sys.controllerFactionId;
  const controller = Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (controller !== null && kill.victimFactionId === controller) {
    return { ok: true, controller, target: controller, nonController: false };
  }
  if (opts && opts.nonController === true && scoreOf(sys, kill.victimFactionId) > 0) {
    return { ok: true, controller, target: kill.victimFactionId, nonController: true };
  }
  return { ok: false, reason: controller === null ? "NO_CONTROLLER" : "NOT_CONTROLLER" };
}

function planLiberationCheck(score, params) {
  const s = Number.isFinite(score) ? score : 0;
  return s < params.minControllerScore
    ? { liberate: true, reason: "BELOW_THRESHOLD" }
    : { liberate: false, reason: "RECOVERED" };
}

module.exports = { rateBucket, rateKey, scoreOf, planKillDrop, planLiberationCheck };
