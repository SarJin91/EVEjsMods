"use strict";

const { HULL_GROUPS } = require("../fleets/schema");
const { TYPE, MEMBER_STATE, FIRST_PHASE } = require("./schema");
const { isPowerType } = require("./power/schema");
const powerCatalog = require("./power/catalog");

const g = (hullGroup, count) => Object.freeze({ hullGroup, count });
const list = (...items) => Object.freeze(items);

const TIERS = Object.freeze({
  [TYPE.REDOUBT]: Object.freeze([
    Object.freeze({ fleetSize: 3,
      phases: list(list(g("cruiser", 4), g("tackle", 2), g("logistics", 1)),
        list(g("battlecruiser", 2), g("battleship", 1))),
      scaling: list(g("battlecruiser", 2)) }),
    Object.freeze({ fleetSize: 5,
      phases: list(list(g("cruiser", 6), g("tackle", 2), g("ewar", 2), g("logistics", 2)),
        list(g("battlecruiser", 3), g("battleship", 3))),
      scaling: list(g("battlecruiser", 1), g("battleship", 1)) }),
    Object.freeze({ fleetSize: 8,
      phases: list(list(g("cruiser", 6), g("battlecruiser", 4), g("ewar", 2), g("logistics", 2)),
        list(g("battleship", 4), g("dreadnought", 1))),
      scaling: list(g("battleship", 2)) }),
  ]),
  [TYPE.FOUNDRY]: Object.freeze([
    Object.freeze({ fleetSize: 3,
      phases: list(list(g("destroyer", 4), g("cruiser", 2), g("industrial", 3)),
        list(g("battlecruiser", 2), g("battleship", 1))),
      scaling: list(g("cruiser", 2)) }),
    Object.freeze({ fleetSize: 5,
      phases: list(list(g("cruiser", 4), g("tackle", 2), g("industrial", 4), g("logistics", 1)),
        list(g("battlecruiser", 3), g("battleship", 2))),
      scaling: list(g("battlecruiser", 1), g("battleship", 1)) }),
  ]),
  [TYPE.DEFENSE]: Object.freeze([
    Object.freeze({ fleetSize: 4, phases: null, scaling: list(g("battlecruiser", 1)) }),
  ]),
});

const DEFENSE_BASE_WAVE = list(g("cruiser", 3), g("destroyer", 2), g("battlecruiser", 1));
const DEFENSE_BATTLESHIP_FROM_WAVE = 3;
const DEFENSE_EXTRA = g("battleship", 1);
const PERMILLE = 1000;

const SUBSTITUTE = Object.freeze({ dreadnought: "battleship", battleship: "battlecruiser", battlecruiser: "cruiser" });
const INTEGRITY_WEIGHT = Object.freeze({ frigate: 1, destroyer: 1, cruiser: 2, battlecruiser: 3, battleship: 5 });
const EXCLUDED_GROUPS = Object.freeze(["carrier", "supercarrier", "titan", "force_auxiliary"]);

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

const tierCountOf = (type) => (Object.prototype.hasOwnProperty.call(TIERS, type) ? TIERS[type].length : 0);

function tierDefOf(type, tier, variant) {
  if (isPowerType(type)) return powerCatalog.tierDefOf(type, tier, variant);
  if (tierCountOf(type) === 0) return { ok: false, reason: "UNKNOWN_TYPE" };
  if (!Number.isSafeInteger(tier) || tier < 1 || tier > TIERS[type].length) {
    return { ok: false, reason: "UNKNOWN_TIER" };
  }
  return { ok: true, def: TIERS[type][tier - 1] };
}

function defenseWaveOf(k, growthPermille) {
  const factor = PERMILLE + (k - FIRST_PHASE) * growthPermille;
  const out = DEFENSE_BASE_WAVE.map((x) => g(x.hullGroup, Math.floor((x.count * factor + PERMILLE / 2) / PERMILLE)));
  if (k >= DEFENSE_BATTLESHIP_FROM_WAVE) out.push(DEFENSE_EXTRA);
  return list(...out);
}

function phasesOf(type, tier, waveParams) {
  const t = tierDefOf(type, tier);
  if (!t.ok) return t;
  if (t.def.phases) return { ok: true, phases: t.def.phases, def: t.def };
  const w = waveParams || {};
  if (!Number.isSafeInteger(w.defenseWaves) || w.defenseWaves < 1 || !isCount(w.waveGrowthPermille)) {
    return { ok: false, reason: "INVALID_PARAMS" };
  }
  const phases = [];
  for (let k = FIRST_PHASE; k < FIRST_PHASE + w.defenseWaves; k += 1) {
    phases.push(defenseWaveOf(k, w.waveGrowthPermille));
  }
  return { ok: true, phases: list(...phases), def: t.def };
}

function phaseCountOf(type, tier, waveParams, variant) {
  if (isPowerType(type)) return powerCatalog.phaseCountOf(type, tier, variant, waveParams);
  const p = phasesOf(type, tier, waveParams);
  return p.ok ? p.phases.length : null;
}

function sumCompositions(parts) {
  const by = new Map();
  for (const part of parts) for (const x of part) by.set(x.hullGroup, (by.get(x.hullGroup) || 0) + x.count);
  return HULL_GROUPS.filter((name) => (by.get(name) || 0) > 0).map((name) => g(name, by.get(name)));
}

function maxComposition(type, tier, maxUpscaleSteps, waveParams) {
  if (!isCount(maxUpscaleSteps)) return { ok: false, reason: "INVALID_PARAMS" };
  const p = phasesOf(type, tier, waveParams);
  if (!p.ok) return p;
  const parts = [...p.phases];
  for (let s = 0; s < maxUpscaleSteps; s += 1) parts.push(p.def.scaling);
  const composition = sumCompositions(parts);
  return { ok: true, composition, total: composition.reduce((a, x) => a + x.count, 0) };
}

function membersOf(type, tier, maxUpscaleSteps, waveParams) {
  if (!isCount(maxUpscaleSteps)) return { ok: false, reason: "INVALID_PARAMS" };
  const p = phasesOf(type, tier, waveParams);
  if (!p.ok) return p;
  const members = [];
  p.phases.forEach((phase, index) => {
    const n = FIRST_PHASE + index;
    let i = 0;
    for (const x of phase) {
      for (let c = 0; c < x.count; c += 1) {
        members.push({ key: `p${n}:${i}`, phase: n, step: null, hullGroup: x.hullGroup, state: MEMBER_STATE.RESERVED });
        i += 1;
      }
    }
  });
  for (let step = 1; step <= maxUpscaleSteps; step += 1) {
    let i = 0;
    for (const x of p.def.scaling) {
      for (let c = 0; c < x.count; c += 1) {
        members.push({ key: `u${step}:${i}`, phase: null, step, hullGroup: x.hullGroup, state: MEMBER_STATE.RESERVED });
        i += 1;
      }
    }
  }
  return { ok: true, members };
}

function initialMembersOf(type, tier, maxUpscaleSteps, waveParams) {
  const all = membersOf(type, tier, maxUpscaleSteps, waveParams);
  if (!all.ok || type !== TYPE.DEFENSE) return all;
  return { ok: true, members: all.members.filter((m) => m.phase === null || m.phase === FIRST_PHASE) };
}

function waveMembersOf(type, tier, k, waveParams) {
  const all = membersOf(type, tier, 0, waveParams);
  if (!all.ok) return all;
  if (!Number.isSafeInteger(k) || k < FIRST_PHASE) return { ok: false, reason: "INVALID_PARAMS" };
  return { ok: true, members: all.members.filter((m) => m.phase === k) };
}

function defensePeakOf(tier, maxUpscaleSteps, waveParams) {
  if (!isCount(maxUpscaleSteps)) return { ok: false, reason: "INVALID_PARAMS" };
  const p = phasesOf(TYPE.DEFENSE, tier, waveParams);
  if (!p.ok) return p;
  const size = (part) => part.reduce((a, x) => a + x.count, 0);
  return { ok: true, total: Math.max(...p.phases.map(size)) + maxUpscaleSteps * size(p.def.scaling) };
}

const substituteOf = (hullGroup) => (Object.prototype.hasOwnProperty.call(SUBSTITUTE, hullGroup)
  ? SUBSTITUTE[hullGroup] : null);

const integrityWeightOf = (hullGroup) => (Object.prototype.hasOwnProperty.call(INTEGRITY_WEIGHT, hullGroup)
  ? INTEGRITY_WEIGHT[hullGroup] : 0);

function catalogHullGroups() {
  const out = new Set();
  for (const tiers of Object.values(TIERS)) {
    for (const def of tiers) {
      for (const phase of def.phases || []) for (const x of phase) out.add(x.hullGroup);
      for (const x of def.scaling) out.add(x.hullGroup);
    }
  }
  for (const x of [...DEFENSE_BASE_WAVE, DEFENSE_EXTRA]) out.add(x.hullGroup);
  for (const [from, to] of Object.entries(SUBSTITUTE)) out.add(from).add(to);
  for (const name of Object.keys(INTEGRITY_WEIGHT)) out.add(name);
  return [...out].sort();
}

module.exports = {
  TIERS,
  DEFENSE_BASE_WAVE,
  DEFENSE_BATTLESHIP_FROM_WAVE,
  SUBSTITUTE,
  INTEGRITY_WEIGHT,
  EXCLUDED_GROUPS,
  tierCountOf,
  tierDefOf,
  phasesOf,
  phaseCountOf,
  maxComposition,
  membersOf,
  initialMembersOf,
  waveMembersOf,
  defensePeakOf,
  substituteOf,
  integrityWeightOf,
  catalogHullGroups,
};
