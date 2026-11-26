"use strict";

const { stableHash32 } = require("../../util/rng");
const { fingerprint } = require("../../util/fingerprint");
const { EVASIVE_ROLES } = require("../../battle/data/contactRules");
const { NON_COMBAT_ROLES } = require("./decide");

const EVENT_TYPE = "FLEET_GRID_CROSSING";
const GATES = Object.freeze(["in", "out"]);
const PAYLOAD_KEYS = Object.freeze(["at", "check", "fleetId", "gate", "legSeq", "systemId", "systemIndex"]);
const HALT_PREFIX = "gxh:";
const HALT_HASH_HEX = 40;
const PERMILLE = 1000;
const MAX_ID = 64;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNeg = (v) => Number.isSafeInteger(v) && v >= 0;
const isFleetId = (v) => typeof v === "string" && v.length >= 1 && v.length <= MAX_ID && !v.includes(":");
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const crossingKey = (fleetId, legSeq, systemIndex, gate) => `gridx:${fleetId}:${legSeq}:${systemIndex}:${gate}`;
const haltKeyOf = (key) => `${HALT_PREFIX}${fingerprint(`${key}:halt`).slice(0, HALT_HASH_HEX)}`;

function rollOf(worldSeed, key) {
  return stableHash32(Number.isSafeInteger(worldSeed) ? worldSeed : 0, key) % PERMILLE;
}

function parseCrossingPayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== PAYLOAD_KEYS.join()) return null;
  if (!isNonNeg(p.at) || !isNonNeg(p.check) || !isFleetId(p.fleetId) || !GATES.includes(p.gate)
    || !isNonNeg(p.legSeq) || !isId(p.systemId) || !isId(p.systemIndex)) return null;
  return p;
}

const crossingPayload = (v) => ({ fleetId: v.fleetId, legSeq: v.legSeq, systemIndex: v.systemIndex,
  systemId: v.systemId, gate: v.gate, check: v.check, at: v.at });

function decideCrossing(input) {
  try {
    const { transit, settings: S } = input;
    if (EVASIVE_ROLES.includes(transit.fleetRole)) return { kind: "EVASIVE" };
    if (NON_COMBAT_ROLES.includes(transit.fleetRole) && S.chaseNonCombat !== true) return { kind: "NON_COMBAT_SKIPPED" };
    const exposed = input.gate === "in" ? transit.alignRaw > S.lockMs : input.exposureMs > S.lockMs;
    if (!exposed) return { kind: "TOO_FAST" };
    const guards = (input.guards || []).filter((g) => g && g.fleetId !== transit.fleetId && Number.isFinite(g.strength)
      && g.strength > 0);
    if (guards.length === 0) return { kind: "NO_GUARD" };
    const cooldown = input.cooldownFactions instanceof Set ? input.cooldownFactions : new Set();
    const open = guards.filter((g) => !cooldown.has(g.factionId));
    if (open.length === 0) return { kind: "COOLDOWN" };
    const sums = new Map();
    for (const g of open) sums.set(g.factionId, (sums.get(g.factionId) || 0) + g.strength);
    const [factionId, sum] = [...sums.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0];
    const need = (Number.isFinite(transit.strength) ? transit.strength : 0) * S.minStrengthPermille / PERMILLE;
    if (sum < need) return { kind: "OUTMATCHED" };
    if (!(input.roll < S.catchChancePermille)) return { kind: "ESCAPED" };
    const guardIds = open.filter((g) => g.factionId === factionId).map((g) => g.fleetId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { kind: "CATCH", factionId, guardIds };
  } catch (_err) {
    return { kind: "NO_GUARD" };
  }
}

module.exports = { EVENT_TYPE, GATES, decideCrossing, crossingKey, haltKeyOf, rollOf, parseCrossingPayload,
  crossingPayload };
