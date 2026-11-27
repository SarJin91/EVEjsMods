"use strict";

const { HULL_GROUPS_V1 } = require("../../lib/fleets/schema");

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const ATTRIBUTES = {
  hp: 9,
  shieldCapacity: 263,
  armorHP: 265,
  shieldResonance: [271, 274, 273, 272],
  armorResonance: [267, 270, 269, 268],
  structureResonance: [113, 110, 109, 111],
  shieldRechargeRate: 479,
  maxVelocity: 37,
  signatureRadius: 552,
  hiSlots: 14,
  medSlots: 13,
  turretSlotsLeft: 102,
  launcherSlotsLeft: 101,
  droneBandwidth: 1271,
  damageMultiplier: 64,
  cycleMs: 51,
  damage: [114, 116, 117, 118],
  droneBandwidthUsed: 1272,
  armorDamageAmount: 84,
  shieldBonus: 68,
  durationMs: 73,
  rigSize: 1547,
  fighterTubes: 2216,
  fighterLightSlots: 2217,
  fighterHeavySlots: 2219,
  fighterSquadronMaxSize: 2215,
  fighterDamageMultiplier: 2226,
  fighterDamage: [2227, 2228, 2229, 2230],
  fighterDurationMs: 2233,
};

const REQUIRED_HULL_ATTRIBUTES = [9, 263, 265, 552, 37, 14];
const DEFAULT_RESONANCE = 1;

const REFERENCES = {
  1: { turret: 564, turretAmmo: 222, launcher: 499, missile: 210, armorRep: 11355, shieldRep: 3586 },
  2: { turret: 568, turretAmmo: 230, launcher: 501, missile: 209, armorRep: 11357, shieldRep: 3596 },
  3: { turret: 573, turretAmmo: 238, launcher: 13320, missile: 203, armorRep: 11359, shieldRep: 3606 },
  4: { turret: 20450, turretAmmo: 17648, launcher: 20539, missile: 17859, armorRep: 24569, shieldRep: 3616 },
};
const REFERENCE_DRONES = [2454, 2183, 2444];
const REFERENCE_FIGHTERS = { light: [23055, 23057, 23059, 23061], heavy: [32325, 32340, 32342, 32344] };
const FIGHTER_DESIGN_SIG_SIZE = { light: 1, heavy: 4 };

const g = (hullGroup, hullSize, weaponSize, remoteRepair, ewar, tackle) =>
  ({ hullGroup, hullSize, weaponSize, remoteRepair, ewar, tackle });

const GROUP_MAP = {
  25: g("frigate", 1, 1, false, 0, 0.5),
  324: g("frigate", 1, 1, false, 0, 0.5),
  830: g("frigate", 1, 1, false, 0, 0.5),
  834: g("frigate", 1, 3, false, 0, 0),
  420: g("destroyer", 1, 1, false, 0, 0.25),
  1305: g("destroyer", 1, 1, false, 0, 0.25),
  1534: g("destroyer", 1, 1, false, 0, 0.25),
  26: g("cruiser", 2, 2, false, 0, 0),
  358: g("cruiser", 2, 2, false, 0, 0),
  419: g("battlecruiser", 2, 2, false, 0, 0),
  540: g("battlecruiser", 2, 2, false, 0, 0),
  1201: g("battlecruiser", 2, 3, false, 0, 0),
  27: g("battleship", 3, 3, false, 0, 0),
  898: g("battleship", 3, 3, false, 0, 0),
  900: g("battleship", 3, 3, false, 0, 0),
  1527: g("logistics", 1, 1, true, 0, 0),
  832: g("logistics", 2, 2, true, 0, 0),
  893: g("ewar", 1, 1, false, 1, 0.25),
  833: g("ewar", 2, 2, false, 1, 0.5),
  906: g("ewar", 2, 2, false, 1, 0.5),
  831: g("tackle", 1, 1, false, 0, 1),
  541: g("tackle", 1, 1, false, 0, 1),
  894: g("tackle", 2, 2, false, 0, 1),
  28: g("industrial", 1, 1, false, 0, 0),
  380: g("industrial", 1, 1, false, 0, 0),
  1202: g("industrial", 1, 1, false, 0, 0),
  1283: g("industrial", 1, 1, false, 0, 0),
  463: g("industrial", 2, 2, false, 0, 0),
  543: g("industrial", 2, 2, false, 0, 0),
  941: g("industrial", 2, 2, false, 0, 0),
  513: g("industrial", 4, 4, false, 0, 0),
  902: g("industrial", 4, 4, false, 0, 0),
  883: g("industrial", 4, 4, false, 0, 0),
  30: g("capital", 4, 4, false, 0, 0),
  485: g("capital", 4, 4, false, 0, 0),
  4594: g("capital", 4, 4, false, 0, 0),
  547: g("capital", 4, 4, false, 0, 0),
  659: g("capital", 4, 4, false, 0, 0),
  5120: g("capital", 4, 4, false, 0, 0),
  1538: g("capital", 4, 4, true, 0, 0),
  29: null,
  31: null,
  237: null,
  381: null,
  963: null,
  1022: null,
  1972: null,
  2001: null,
  4902: null,
  5087: null,
};

const FIELDS = ["dps", "alpha", "ehp", "repPerSec", "remoteRepPerSec", "applicationFactor", "ewarFactor",
  "tackleFactor", "speedClass", "signatureRadius", "maxVelocity", "designSig"];
const REQUIRED_POSITIVE = ["dps", "alpha", "ehp", "repPerSec", "applicationFactor", "speedClass", "signatureRadius",
  "maxVelocity", "designSig"];
const ROUND_DIGITS = {
  dps: 1, alpha: 1, ehp: 1, repPerSec: 1, remoteRepPerSec: 1, signatureRadius: 1, maxVelocity: 1, designSig: 1,
  applicationFactor: 3, ewarFactor: 3, tackleFactor: 3, speedClass: 0,
};

const METHOD = deepFreeze({
  methodVersion: "strength-v2",
  catalogVersion: 1,
  description: "Hull attributes plus reference T1 armament per weapon size (blaster + antimatter, launcher + "
    + "Scourge, T1 drones per Mbit, T1 fighters per squadron - heavy tubes first, support skipped - T1 remote reps "
    + "for logistics), no hull bonuses, no skills, uniform damage profile; values are relative between groups, the "
    + "absolute scale is resolver config.",
  hullGroups: [...HULL_GROUPS_V1],
  attributes: ATTRIBUTES,
  requiredHullAttributes: REQUIRED_HULL_ATTRIBUTES,
  defaultResonance: DEFAULT_RESONANCE,
  references: REFERENCES,
  referenceDrones: REFERENCE_DRONES,
  referenceFighters: REFERENCE_FIGHTERS,
  fighterDesignSigSize: FIGHTER_DESIGN_SIG_SIZE,
  groupMap: GROUP_MAP,
  shieldPeakRegenFactor: 2.5,
  applicationMin: 0.05,
  speedClasses: 5,
  fields: FIELDS,
  requiredPositive: REQUIRED_POSITIVE,
  roundDigits: ROUND_DIGITS,
});

function referenceTypeIds(method = METHOD) {
  const ids = new Set(method.referenceDrones);
  for (const list of Object.values(method.referenceFighters || {})) for (const id of list) ids.add(id);
  for (const size of Object.keys(method.references)) {
    for (const id of Object.values(method.references[size])) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

module.exports = { METHOD, referenceTypeIds, deepFreeze, GROUP_MAP };
