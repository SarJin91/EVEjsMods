"use strict";

const P = require("../power/schema");
const W = require("./schema");

const g = (hullGroup, count, role) => Object.freeze(role ? { hullGroup, count, role } : { hullGroup, count });
const list = (...items) => Object.freeze(items);
const pocket = (visibility, ...phases) => Object.freeze({ visibility, phases: list(...phases) });
const tier = (fleetSize, pockets, scaling) => Object.freeze({ fleetSize, pockets, scaling });

const A = P.VISIBILITY.ANOMALY;
const S = P.VISIBILITY.SIGNATURE;
const OBJ = P.ROLE.OBJECTIVE;
const HAUL = P.ROLE.HAULER;

const META = Object.freeze({
  [W.KIND.WARCAMP]: Object.freeze({ signal: "strong", ttlPermille: 1000,
    rewardProfiles: list("power_small", "power_cache", "power_rare"), rewardText: "Faction loot chest" }),
  [W.KIND.HIDEOUT]: Object.freeze({ signal: "weak", ttlPermille: 1000,
    rewardProfiles: list("power_cache", "power_rare", "power_rare"), rewardText: "Commander loot chest" }),
  [W.KIND.STAGING]: Object.freeze({ signal: "strong", ttlPermille: 1000,
    rewardProfiles: list("power_cache", "power_rare", "power_rare"), rewardText: "Loot chest",
    payoutRewardText: "Loot chest + defender LP", invaderLoot: true }),
  [W.KIND.DESERTERS]: Object.freeze({ signal: "strong", ttlPermille: 1000,
    rewardProfiles: list("power_small", "power_cache", "power_cache"), rewardText: "Faction loot chest" }),
  [W.KIND.SMUGGLING]: Object.freeze({ signal: "strong", ttlPermille: 750,
    rewardProfiles: list("power_small", "power_cache", "power_cache"), rewardText: "Loot chest + minerals" }),
  [W.KIND.FRONTDEPOT]: Object.freeze({ signal: "weak", ttlPermille: 1500,
    rewardProfiles: list("power_cache", "power_cache", "power_rare"), rewardText: "Supply cache + minerals" }),
  [W.KIND.WRECKEDCONVOY]: Object.freeze({ signal: "weak", ttlPermille: 1000,
    rewardProfiles: list("power_small", "power_cache", "power_cache"), rewardText: "Salvaged cargo chest" }),
  [W.KIND.FLAGWRECK]: Object.freeze({ signal: "weak", ttlPermille: 1000,
    rewardProfiles: list("power_cache", "power_rare", "power_rare"), rewardText: "Flagship salvage chest" }),
  [W.KIND.BREACH]: Object.freeze({ signal: "normal", ttlPermille: 1000,
    rewardProfiles: list("power_cache", "power_rare", "power_rare"), rewardText: "Loot chest", invaderLoot: true }),
});

const TIERS = Object.freeze({
  [P.TYPE.MUSTER]: Object.freeze({
    [W.KIND.WARCAMP]: list(
      tier(2, list(pocket(A, list(g("destroyer", 2), g("cruiser", 2), g("frigate", 2)))), list(g("cruiser", 1))),
      tier(4, list(pocket(A, list(g("cruiser", 3), g("battlecruiser", 1), g("logistics", 1)))),
        list(g("battlecruiser", 1))),
      tier(6, list(pocket(A, list(g("battlecruiser", 2), g("battleship", 2), g("logistics", 1)))),
        list(g("battleship", 1)))),
    [W.KIND.STAGING]: list(
      tier(2, list(pocket(A, list(g("frigate", 3), g("destroyer", 2), g("cruiser", 2)))), list(g("cruiser", 1))),
      tier(4, list(pocket(A, list(g("cruiser", 3), g("battlecruiser", 2), g("destroyer", 2)))),
        list(g("battlecruiser", 1))),
      tier(6, list(pocket(A, list(g("battleship", 2), g("battlecruiser", 2), g("cruiser", 2), g("dreadnought", 1)))),
        list(g("battleship", 1)))),
  }),
  [P.TYPE.HUNT]: Object.freeze({
    [W.KIND.HIDEOUT]: list(
      tier(2, list(pocket(S, list(g("cruiser", 3), g("logistics", 1), g("battlecruiser", 1, OBJ)))),
        list(g("cruiser", 1))),
      tier(4, list(pocket(S, list(g("battlecruiser", 2), g("cruiser", 2), g("logistics", 1),
        g("battleship", 1, OBJ)))), list(g("battlecruiser", 1))),
      tier(6, list(pocket(S, list(g("battleship", 2), g("battlecruiser", 2), g("logistics", 2),
        g("dreadnought", 1, OBJ)))), list(g("battleship", 1)))),
    [W.KIND.FLAGWRECK]: list(
      tier(2, list(pocket(S, list(g("cruiser", 3), g("battlecruiser", 1), g("battleship", 1, OBJ)))),
        list(g("cruiser", 1))),
      tier(4, list(pocket(S, list(g("battlecruiser", 2), g("cruiser", 2), g("logistics", 1),
        g("battleship", 1, OBJ)))), list(g("battlecruiser", 1))),
      tier(6, list(pocket(S, list(g("battleship", 2), g("battlecruiser", 2), g("logistics", 1),
        g("dreadnought", 1, OBJ)))), list(g("battleship", 1)))),
  }),
  [P.TYPE.TRAIL]: Object.freeze({
    [W.KIND.BREACH]: list(
      tier(2, list(pocket(A, list(g("frigate", 3), g("destroyer", 1))),
        pocket(S, list(g("destroyer", 2), g("cruiser", 1))),
        pocket(S, list(g("cruiser", 2), g("battlecruiser", 1)))), list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("destroyer", 3), g("cruiser", 2))),
        pocket(S, list(g("cruiser", 3), g("battlecruiser", 1))),
        pocket(S, list(g("battlecruiser", 2), g("battleship", 1)))), list(g("cruiser", 1))),
      tier(6, list(pocket(A, list(g("cruiser", 3), g("battlecruiser", 2))),
        pocket(S, list(g("battlecruiser", 3), g("battleship", 1))),
        pocket(S, list(g("battleship", 2), g("battlecruiser", 2), g("dreadnought", 1)))),
        list(g("battlecruiser", 1)))),
  }),
  [P.TYPE.OUTPOST]: Object.freeze({
    [W.KIND.DESERTERS]: list(
      tier(2, list(pocket(A, list(g("destroyer", 2), g("cruiser", 2)), list(g("battlecruiser", 1), g("cruiser", 1)))),
        list(g("cruiser", 1))),
      tier(4, list(pocket(A, list(g("cruiser", 3), g("logistics", 1)), list(g("battleship", 1), g("battlecruiser", 1)))),
        list(g("battlecruiser", 1))),
      tier(6, list(pocket(A, list(g("battlecruiser", 2), g("cruiser", 2), g("logistics", 1)),
        list(g("battleship", 2), g("battlecruiser", 1)))), list(g("battleship", 1)))),
  }),
  [P.TYPE.CONVOY]: Object.freeze({
    [W.KIND.SMUGGLING]: list(
      tier(2, list(pocket(A, list(g("destroyer", 2), g("cruiser", 1), g("industrial", 3, HAUL)))),
        list(g("destroyer", 1))),
      tier(4, list(pocket(A, list(g("cruiser", 2), g("tackle", 1), g("industrial", 4, HAUL)))), list(g("cruiser", 1))),
      tier(6, list(pocket(A, list(g("battlecruiser", 2), g("cruiser", 2), g("logistics", 1), g("industrial", 5, HAUL)))),
        list(g("battlecruiser", 1)))),
  }),
  [P.TYPE.CACHE]: Object.freeze({
    [W.KIND.FRONTDEPOT]: list(
      tier(2, list(pocket(S, list(g("cruiser", 3), g("tackle", 1)))), list(g("cruiser", 1))),
      tier(4, list(pocket(S, list(g("cruiser", 3), g("battlecruiser", 1), g("logistics", 1)))),
        list(g("battlecruiser", 1))),
      tier(6, list(pocket(S, list(g("battleship", 1), g("battlecruiser", 2), g("cruiser", 2), g("logistics", 1)))),
        list(g("battleship", 1)))),
    [W.KIND.WRECKEDCONVOY]: list(
      tier(2, list(pocket(S, list(g("destroyer", 2), g("cruiser", 2)))), list(g("destroyer", 1))),
      tier(4, list(pocket(S, list(g("cruiser", 3), g("logistics", 1), g("battlecruiser", 1)))), list(g("cruiser", 1))),
      tier(6, list(pocket(S, list(g("battlecruiser", 2), g("cruiser", 2), g("logistics", 1)))),
        list(g("battlecruiser", 1)))),
  }),
});

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isWorldVariant(type, variant) {
  return typeof type === "string" && typeof variant === "string" && has(TIERS, type) && has(TIERS[type], variant);
}

function worldTierDefOf(type, tierNo, variant) {
  if (typeof type !== "string" || !has(TIERS, type)) return { ok: false, reason: "UNKNOWN_TYPE" };
  if (typeof variant !== "string" || !has(TIERS[type], variant)) return { ok: false, reason: "UNKNOWN_VARIANT" };
  const tiers = TIERS[type][variant];
  if (!Number.isSafeInteger(tierNo) || tierNo < 1 || tierNo > tiers.length) return { ok: false, reason: "UNKNOWN_TIER" };
  const meta = META[variant];
  return { ok: true, def: Object.freeze({ ...tiers[tierNo - 1], signal: meta.signal, ttlPermille: meta.ttlPermille,
    rewardProfile: meta.rewardProfiles[tierNo - 1] }) };
}

module.exports = { TIERS, META, isWorldVariant, worldTierDefOf };
