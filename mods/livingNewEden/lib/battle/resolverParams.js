"use strict";

const { fingerprint } = require("../util/fingerprint");

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const RESOLVER_MODEL_V1 = deepFreeze({
  modelVersion: "internal-v1",
  objectiveMorale: { destroy: 1, capture: 1, defend: 1.2, delay: 1.5, escort: 1 },
  defenderMorale: 1,
  garrisonMoraleBonus: 0.3,
  garrisonSignature: 400,
  scoutRetreatPowerRatio: 1,
  stalemateRounds: 1,
  delayRounds: 3,
  destroyMinEnemyLoss: 0.5,
  escortMinSurvival: 0.5,
  convoyTargetWeight: 2,
  applicationMin: 0.05,
  alphaScale: 0.25,
  repMaxMitigation: 0.6,
  ewarPerShip: 1,
  ewarMaxReduction: 0.5,
  supplyMinFactor: 0.5,
  escapeBase: 0.5,
  escapeSpeedStep: 0.1,
  tacklePenalty: 0.6,
  tackleTargetsPerShip: 2,
  escapeMin: 0.05,
  escapeMax: 0.95,
  pursuitDamageFactor: 1,
  exactDrawMax: 64,
  escapeEnv: { highsec: 0.1, lowsec: 0, nullsec: 0, wormhole: -0.1, other: 0 },
});

const KNOBS = Object.freeze({
  maxRounds: "resolverMaxRounds",
  roundSec: "resolverRoundSec",
  workUnitsPerMs: "resolverWorkUnitsPerMs",
  dpsScale: "resolverDpsScale",
  ehpScale: "resolverEhpScale",
  repScale: "resolverRepScale",
  roundVariance: "resolverRoundVariance",
  retreatLossFraction: "resolverRetreatLossFraction",
  retreatPowerRatio: "resolverRetreatPowerRatio",
  garrisonDpsPerPoint: "resolverGarrisonDpsPerPoint",
  garrisonEhpPerPoint: "resolverGarrisonEhpPerPoint",
  modelConfidence: "resolverModelConfidence",
});

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const invalid = (detail) => ({ ok: false, reason: "RESOLVER_PARAMS_INVALID", detail });

function buildResolverParams(config) {
  const battle = config && config.battle;
  const fleets = config && config.fleets;
  if (!battle || typeof battle !== "object" || !fleets || typeof fleets !== "object") {
    return invalid("config.battle / config.fleets missing");
  }
  const limits = {
    maxFleetsPerSide: battle.maxFleetsPerSide,
    maxCompositionEntries: fleets.maxCompositionEntries,
    maxShipsPerFleet: fleets.maxShipsPerFleet,
    maxResolutionMs: battle.maxResolutionMs,
    maxResultBytes: battle.maxResultBytes,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) return invalid(`limits.${name}=${value}`);
  }
  const params = { limits };
  for (const [field, key] of Object.entries(KNOBS)) {
    const value = battle[key];
    if (!isFiniteNumber(value) || value < 0) return invalid(`battle.${key}=${value}`);
    params[field] = value;
  }
  params.model = RESOLVER_MODEL_V1;
  let paramsHash;
  try {
    paramsHash = fingerprint(params);
  } catch (err) {
    return invalid(`not JSON data: ${(err && err.message) || err}`);
  }
  return { ok: true, params: deepFreeze({ ...params, limits: { ...limits }, paramsHash }) };
}

module.exports = { RESOLVER_MODEL_V1, KNOBS, buildResolverParams };
