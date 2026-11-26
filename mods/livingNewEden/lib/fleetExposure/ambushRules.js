"use strict";

const { deriveSeed, createRng } = require("../util/rng");
const { parseHullGroupList } = require("../fleets/schema");

const AMBUSH_SEED_KIND = "convoy-ambush";
const DRAW_RANGE = 1000;
const NO_DRAW = Object.freeze({ hit: false, draw: -1 });
const CHANCE_KEY_BY_CLASS = Object.freeze({ highsec: "ambushChancePermilleHighsec",
  lowsec: "ambushChancePermilleLowsec", nullsec: "ambushChancePermilleNullsec" });
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function rollAmbush(input) {
  const { worldSeed, fleetId, legSeq, systemIndex, chancePermille } = input || {};
  if (!Number.isInteger(worldSeed) || typeof fleetId !== "string" || fleetId === "" || !Number.isSafeInteger(legSeq)
    || !Number.isSafeInteger(systemIndex) || systemIndex < 0 || !Number.isFinite(chancePermille)) return { ...NO_DRAW };
  const rng = createRng(deriveSeed(worldSeed, AMBUSH_SEED_KIND, fleetId, legSeq, systemIndex));
  const draw = rng.nextUint32() % DRAW_RANGE;
  return { hit: draw < chancePermille, draw };
}

function chancePermilleOf(secClass, S) {
  if (typeof secClass !== "string" || !hasOwn(CHANCE_KEY_BY_CLASS, secClass) || !S) return 0;
  const v = S[CHANCE_KEY_BY_CLASS[secClass]];
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function ambushGroupsOf(S) {
  return (S && parseHullGroupList(S.ambushHullGroups)) || [];
}

function ambushRequests(groups, n, factionId) {
  if (!Array.isArray(groups) || groups.length === 0 || !Number.isSafeInteger(n) || n < 1) return [];
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ memberKey: `amb${i}`, hullGroup: groups[i % groups.length], factionId });
  return out;
}

function targetsSig(ids) {
  return Array.isArray(ids) ? [...ids].sort((a, b) => a - b).join(",") : "";
}

module.exports = { AMBUSH_SEED_KIND, rollAmbush, chancePermilleOf, ambushGroupsOf, ambushRequests, targetsSig };
