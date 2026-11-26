"use strict";

const { deriveSeed, createRng } = require("../../util/rng");
const { hasWormholeEdges } = require("../../fleets/travel");
const { crossingOf } = require("../../fleets/crossing");
const { FORTRESS_SENTRY_PREFIX } = require("../../sentries/schema");

const SEED_KIND = "fortress-checkpoint";
const PERMILLE = 1000;
const ITEM_ID_SCALE = 1000;
const STALE_REASONS = Object.freeze(["TARGET_GONE", "LEG_MOVED", "LEG_HAS_WORMHOLES", "NOT_CROSSING", "NOT_HOSTILE",
  "EXEMPT"]);

function crossingOfFortress(leg, fortress) {
  if (!leg || !Array.isArray(leg.systems) || leg.systems.length < 3 || !fortress) return null;
  const i = leg.systems.indexOf(fortress.systemId);
  if (i <= 0 || i >= leg.systems.length - 1) return null;
  if (!Number.isSafeInteger(leg.departAt) || !Number.isSafeInteger(leg.jumpMs)) return null;
  return { systemIndex: i, at: leg.departAt + i * leg.jumpMs };
}

function decideCheckpoint(facts, params) {
  const { p, target } = facts;
  const stale = (reason) => ({ action: "STALE", reason });
  if (!target || target.state === "DESTROYED") return stale("TARGET_GONE");
  if (target.state !== "TRAVELLING" || target.legSeq !== p.legSeq) return stale("LEG_MOVED");
  if (target.route && hasWormholeEdges(target.route)) return stale("LEG_HAS_WORMHOLES");
  const x = crossingOf(target, p.systemId);
  if (!x || x.i !== p.systemIndex || p.at < x.from || p.at >= x.from + x.jumpMs) return stale("NOT_CROSSING");
  if (facts.hostile !== true) return stale("NOT_HOSTILE");
  if (facts.exempt === true) return stale("EXEMPT");
  if (facts.observed === true) return { action: "OBSERVED" };
  const roll = createRng(deriveSeed(facts.worldSeed, SEED_KIND, `${p.systemId}:${p.fleetId}:${p.legSeq}`)).nextFloat();
  return { action: roll * PERMILLE < params.interceptChancePermille ? "HALT" : "PASS", roll };
}

function defensesOf(fortress, S) {
  const entries = [];
  for (let i = 0; i < S.batteryCount; i += 1) {
    entries.push({ sentryId: `${FORTRESS_SENTRY_PREFIX}${fortress.systemId}:${i}`,
      itemId: fortress.systemId * ITEM_ID_SCALE + i + 1, typeId: S.batteryTypeId, ownerKind: "faction",
      ownerId: fortress.factionId, hp: S.batteryHp, ehp: S.batteryHp, dps: S.batteryDps,
      signature: S.batterySignature, designSig: S.batteryDesignSig });
  }
  return { attackerRetreatLossPermille: S.attackerRetreatLossPermille, entries };
}

module.exports = { crossingOfFortress, decideCheckpoint, defensesOf, STALE_REASONS, SEED_KIND };
