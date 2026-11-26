"use strict";

const { createRng, deriveSeed } = require("../../util/rng");
const { GANK_HULLS, FALLBACK_EMPIRE } = require("./data");

const PERMILLE = 1000;
const HOUR_MS = 3600000;
const HOURS_PER_DAY = 24;
const ROLL = Object.freeze({ QUIET: "QUIET", GANK: "GANK" });

function bucketOf(now, bucketMs) {
  return Math.floor(now / bucketMs);
}

function planGank(systemId, bucket, worldSeed, hourCurvePermille, G) {
  const rng = createRng(deriveSeed(worldSeed >>> 0, "hs-gank", systemId, bucket));
  const at = bucket * G.bucketMs + rng.nextInt(0, G.bucketMs - 1);
  const hour = Math.floor(at / HOUR_MS) % HOURS_PER_DAY;
  const curve = Array.isArray(hourCurvePermille) && Number.isSafeInteger(hourCurvePermille[hour])
    ? hourCurvePermille[hour] : PERMILLE;
  const hit = rng.nextInt(0, PERMILLE - 1) < Math.floor((G.chancePermille * curve) / PERMILLE);
  const victimKind = rng.nextInt(0, PERMILLE - 1) < G.freighterPermille ? "freighter" : "industrial";
  const gankers = victimKind === "freighter"
    ? rng.nextInt(G.gankersFreighterMin, G.gankersFreighterMax)
    : rng.nextInt(G.gankersHaulerMin, G.gankersHaulerMax);
  if (!hit) return { roll: ROLL.QUIET, at };
  return { roll: ROLL.GANK, at, victimKind, gankers };
}

function hullsOf(factionId) {
  return GANK_HULLS[factionId] || GANK_HULLS[FALLBACK_EMPIRE];
}

module.exports = { ROLL, bucketOf, planGank, hullsOf };
