"use strict";

const { HULL_GROUPS } = require("../../fleets/schema");
const { MEMBER_STATE, FIRST_PHASE } = require("../schema");
const P = require("./schema");
const { isWorldVariant, worldTierDefOf } = require("../world/catalog");

const g =(hullGroup, count, role) => Object.freeze(role ? { hullGroup, count, role } : { hullGroup, count });
const list = (...items) => Object.freeze(items);
const pocket = (visibility, ...phases) => Object.freeze({ visibility, phases: list(...phases) });
const tier = (fleetSize, pockets, scaling) => Object.freeze({ fleetSize, pockets, scaling });

const A = P.VISIBILITY.ANOMALY;
const S = P.VISIBILITY.SIGNATURE;
const OBJ = P.ROLE.OBJECTIVE;
const HAUL = P.ROLE.HAULER;
const PERMILLE = 1000;

const META = Object.freeze({
  [P.TYPE.OUTPOST]: Object.freeze({ signal: "strong", ttlPermille: 1000, rewardProfile: "power_small" }),
  [P.TYPE.CACHE]: Object.freeze({ signal: "weak", ttlPermille: null, ttlPermilleKey: "cacheTtlPermille",
    rewardProfile: "power_cache" }),
  [P.TYPE.TRAIL]: Object.freeze({ signal: "normal", ttlPermille: 1000, rewardProfile: "power_cache" }),
  [P.TYPE.HUNT]: Object.freeze({ signal: "weak", ttlPermille: 1000, rewardProfile: "power_rare" }),
  [P.TYPE.CONVOY]: Object.freeze({ signal: "strong", ttlPermille: 750, rewardProfile: "power_small" }),
  [P.TYPE.MUSTER]: Object.freeze({ signal: "strong", ttlPermille: 1000, rewardProfile: "power_small" }),
});

const TIERS = Object.freeze({
  [P.TYPE.OUTPOST]: Object.freeze({
    brawl: list(
      tier(2, list(pocket(A, list(g("destroyer", 3), g("frigate", 2)), list(g("cruiser", 2)))),
        list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("cruiser", 3), g("destroyer", 2)), list(g("battlecruiser", 1), g("logistics", 1)))),
        list(g("cruiser", 1)))),
    kite: list(
      tier(2, list(pocket(A, list(g("frigate", 3), g("tackle", 2)), list(g("cruiser", 1), g("ewar", 1)))),
        list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("cruiser", 2), g("tackle", 2), g("ewar", 1)),
        list(g("battlecruiser", 1), g("cruiser", 1)))), list(g("cruiser", 1)))),
  }),
  [P.TYPE.CACHE]: Object.freeze({
    guard: list(
      tier(2, list(pocket(S, list(g("cruiser", 3), g("tackle", 1)))), list(g("cruiser", 1))),
      tier(4, list(pocket(S, list(g("cruiser", 3), g("battlecruiser", 1), g("logistics", 1)))),
        list(g("battlecruiser", 1)))),
    sentinel: list(
      tier(2, list(pocket(S, list(g("battlecruiser", 1), g("destroyer", 3)))), list(g("cruiser", 1))),
      tier(4, list(pocket(S, list(g("battleship", 1), g("cruiser", 2)))), list(g("battlecruiser", 1)))),
  }),
  [P.TYPE.TRAIL]: Object.freeze({
    courier: list(
      tier(2, list(pocket(A, list(g("frigate", 3), g("destroyer", 1))),
        pocket(S, list(g("destroyer", 2), g("cruiser", 1))),
        pocket(S, list(g("cruiser", 2), g("battlecruiser", 1)))), list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("destroyer", 3), g("cruiser", 1))),
        pocket(S, list(g("cruiser", 3), g("ewar", 1))),
        pocket(S, list(g("battlecruiser", 2), g("battleship", 1)))), list(g("cruiser", 1)))),
    decoy: list(
      tier(2, list(pocket(A, list(g("frigate", 3), g("destroyer", 1))),
        pocket(S, list(g("destroyer", 2), g("cruiser", 1))),
        pocket(S, list(g("cruiser", 2), g("battlecruiser", 1)))), list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("destroyer", 3), g("cruiser", 1))),
        pocket(S, list(g("cruiser", 3), g("tackle", 1))),
        pocket(S, list(g("battlecruiser", 2), g("battleship", 1)))), list(g("cruiser", 1)))),
  }),
  [P.TYPE.HUNT]: Object.freeze({
    guarded: list(
      tier(2, list(pocket(S, list(g("cruiser", 3), g("logistics", 1), g("battlecruiser", 1, OBJ)))),
        list(g("cruiser", 1))),
      tier(4, list(pocket(S, list(g("battlecruiser", 2), g("cruiser", 2), g("logistics", 1),
        g("battleship", 1, OBJ)))), list(g("battlecruiser", 1)))),
    duelist: list(
      tier(2, list(pocket(S, list(g("tackle", 2), g("ewar", 1), g("battleship", 1, OBJ)))), list(g("cruiser", 1))),
      tier(4, list(pocket(S, list(g("tackle", 2), g("ewar", 1), g("battleship", 1, OBJ)))),
        list(g("battlecruiser", 1)))),
  }),
  [P.TYPE.CONVOY]: Object.freeze({
    light: list(
      tier(2, list(pocket(A, list(g("destroyer", 2), g("cruiser", 2), g("industrial", 3, HAUL)))),
        list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("cruiser", 3), g("tackle", 1), g("ewar", 1), g("industrial", 4, HAUL)))),
        list(g("cruiser", 1)))),
    armored: list(
      tier(2, list(pocket(A, list(g("cruiser", 2), g("logistics", 1), g("industrial", 3, HAUL)))),
        list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("battlecruiser", 2), g("logistics", 1), g("industrial", 4, HAUL)))),
        list(g("cruiser", 1)))),
  }),
  [P.TYPE.MUSTER]: Object.freeze({
    swarm: list(
      tier(2, list(pocket(A, list(g("frigate", 2), g("destroyer", 2), g("cruiser", 1)))), list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("frigate", 2), g("destroyer", 2), g("cruiser", 1)))), list(g("cruiser", 1)))),
    line: list(
      tier(2, list(pocket(A, list(g("tackle", 1), g("destroyer", 2), g("cruiser", 1), g("ewar", 1)))),
        list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("tackle", 1), g("destroyer", 2), g("cruiser", 1), g("ewar", 1)))),
        list(g("cruiser", 1)))),
  }),
});

const MUSTER_BATTLECRUISER_FROM_WAVE = 3;
const MUSTER_EXTRA = g("battlecruiser", 1);
const MUSTER_EXTRA_WAVES_PER_TIER = 1;
const TRAIL_BASE_POCKETS = 3;
const EXCLUDED_GROUPS = Object.freeze(["carrier", "supercarrier", "titan", "force_auxiliary"]);

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function tierDefOf(type, tierNo, variant) {
  if (typeof type !== "string" || !has(TIERS, type)) return { ok: false, reason: "UNKNOWN_TYPE" };
  if (isWorldVariant(type, variant)) return worldTierDefOf(type, tierNo, variant);
  if (typeof variant !== "string" || !has(TIERS[type], variant)) return { ok: false, reason: "UNKNOWN_VARIANT" };
  const tiers = TIERS[type][variant];
  if (!Number.isSafeInteger(tierNo) || tierNo < 1 || tierNo > tiers.length) return { ok: false, reason: "UNKNOWN_TIER" };
  return { ok: true, def: Object.freeze({ ...tiers[tierNo - 1], ...META[type] }) };
}

function musterWaveOf(base, k, growthPermille) {
  const factor = PERMILLE + (k - FIRST_PHASE) * growthPermille;
  const out = base.map((x) => g(x.hullGroup, Math.floor((x.count * factor + PERMILLE / 2) / PERMILLE), x.role));
  if (k >= MUSTER_BATTLECRUISER_FROM_WAVE) out.push(MUSTER_EXTRA);
  return list(...out);
}

function pocketsOf(type, tierNo, variant, params) {
  const t = tierDefOf(type, tierNo, variant);
  if (!t.ok) return t;
  const p = params || {};
  if (type === P.TYPE.TRAIL) {
    const n = p.trailPockets;
    if (!Number.isSafeInteger(n) || n < 2) return { ok: false, reason: "INVALID_PARAMS" };
    const last = TRAIL_BASE_POCKETS - 1;
    const pockets = [];
    for (let i = 0; i < n; i += 1) pockets.push(t.def.pockets[Math.round((i * last) / (n - 1))]);
    return { ok: true, pockets: list(...pockets), def: t.def };
  }
  if (type === P.TYPE.MUSTER) {
    if (!Number.isSafeInteger(p.musterWaves) || p.musterWaves < 1 || !isCount(p.musterWaveGrowthPermille)) {
      return { ok: false, reason: "INVALID_PARAMS" };
    }
    const waves = p.musterWaves + (tierNo - 1) * MUSTER_EXTRA_WAVES_PER_TIER;
    const base = t.def.pockets[0];
    const phases = [];
    for (let k = FIRST_PHASE; k < FIRST_PHASE + waves; k += 1) {
      phases.push(musterWaveOf(base.phases[0], k, p.musterWaveGrowthPermille));
    }
    return { ok: true, pockets: list(pocket(base.visibility, ...phases)), def: t.def };
  }
  return { ok: true, pockets: t.def.pockets, def: t.def };
}

function phasesOf(type, tierNo, variant, params) {
  const r = pocketsOf(type, tierNo, variant, params);
  if (!r.ok) return r;
  const phases = [];
  const pocketOf = [];
  r.pockets.forEach((pk, index) => {
    for (const ph of pk.phases) {
      phases.push(ph);
      pocketOf.push(index);
    }
  });
  return { ok: true, phases: list(...phases), pocketOf, def: r.def, pockets: r.pockets };
}

function phaseCountOf(type, tierNo, variant, params) {
  const r = phasesOf(type, tierNo, variant, params);
  return r.ok ? r.phases.length : null;
}

function pocketCountOf(type, tierNo, variant, params) {
  const r = pocketsOf(type, tierNo, variant, params);
  return r.ok ? r.pockets.length : null;
}

function pocketOfPhase(type, tierNo, variant, phase, params) {
  const r = phasesOf(type, tierNo, variant, params);
  if (!r.ok || !Number.isSafeInteger(phase) || phase < FIRST_PHASE || phase >= FIRST_PHASE + r.phases.length) {
    return null;
  }
  return r.pocketOf[phase - FIRST_PHASE];
}

function phaseOfPocket(type, tierNo, variant, pocketNo, params) {
  const r = phasesOf(type, tierNo, variant, params);
  if (!r.ok || !Number.isSafeInteger(pocketNo) || pocketNo < 0 || pocketNo >= r.pockets.length) {
    return null;
  }
  const idx = r.pocketOf.indexOf(pocketNo);
  return idx >= 0 ? FIRST_PHASE + idx : null;
}

function visibilityOfPocket(type, tierNo, variant, pocketNo, params) {
  const r = pocketsOf(type, tierNo, variant, params);
  if (!r.ok || !Number.isSafeInteger(pocketNo) || pocketNo < 0 || pocketNo >= r.pockets.length) return null;
  return r.pockets[pocketNo].visibility;
}

function sumCompositions(parts) {
  const by = new Map();
  for (const part of parts) for (const x of part) by.set(x.hullGroup, (by.get(x.hullGroup) || 0) + x.count);
  return HULL_GROUPS.filter((name) => (by.get(name) || 0) > 0).map((name) => g(name, by.get(name)));
}

function maxComposition(type, tierNo, variant, maxUpscaleSteps, params) {
  if (!isCount(maxUpscaleSteps)) return { ok: false, reason: "INVALID_PARAMS" };
  const r = phasesOf(type, tierNo, variant, params);
  if (!r.ok) return r;
  const parts = [...r.phases];
  for (let s = 0; s < maxUpscaleSteps; s += 1) parts.push(r.def.scaling);
  const composition = sumCompositions(parts);
  return { ok: true, composition, total: composition.reduce((a, x) => a + x.count, 0) };
}

function membersOf(type, tierNo, variant, maxUpscaleSteps, params) {
  if (!isCount(maxUpscaleSteps)) return { ok: false, reason: "INVALID_PARAMS" };
  const r = phasesOf(type, tierNo, variant, params);
  if (!r.ok) return r;
  const members = [];
  r.phases.forEach((phase, index) => {
    const n = FIRST_PHASE + index;
    let i = 0;
    for (const x of phase) {
      for (let c = 0; c < x.count; c += 1) {
        const m = { key: `p${n}:${i}`, phase: n, step: null, hullGroup: x.hullGroup, state: MEMBER_STATE.RESERVED };
        if (x.role) m.role = x.role;
        members.push(m);
        i += 1;
      }
    }
  });
  for (let step = 1; step <= maxUpscaleSteps; step += 1) {
    let i = 0;
    for (const x of r.def.scaling) {
      for (let c = 0; c < x.count; c += 1) {
        members.push({ key: `u${step}:${i}`, phase: null, step, hullGroup: x.hullGroup, state: MEMBER_STATE.RESERVED });
        i += 1;
      }
    }
  }
  return { ok: true, members };
}

function hasWaves(type) {
  return type === "defense" || type === P.TYPE.MUSTER;
}

function waveMembersOf(type, tier, variant, k, params) {
  if (type !== P.TYPE.MUSTER) return { ok: false, reason: "UNKNOWN_TYPE" };
  if (typeof variant !== "string" || (!Object.prototype.hasOwnProperty.call(TIERS[type], variant)
    && !isWorldVariant(type, variant))) return { ok: false, reason: "UNKNOWN_VARIANT" };
  const all = membersOf(type, tier, variant, 0, params);
  if (!all.ok) return all;
  if (!Number.isSafeInteger(k) || k < FIRST_PHASE) return { ok: false, reason: "INVALID_PARAMS" };
  return { ok: true, members: all.members.filter((m) => m.phase === k) };
}

module.exports = {
  TIERS,
  META,
  MUSTER_BATTLECRUISER_FROM_WAVE,
  TRAIL_BASE_POCKETS,
  EXCLUDED_GROUPS,
  tierDefOf,
  pocketsOf,
  phasesOf,
  phaseCountOf,
  pocketCountOf,
  pocketOfPhase,
  phaseOfPocket,
  visibilityOfPocket,
  maxComposition,
  membersOf,
  hasWaves,
  waveMembersOf,
};
