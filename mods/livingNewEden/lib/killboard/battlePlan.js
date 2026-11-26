"use strict";

const { iskOf } = require("./pricing");
const { PRICE_BASIS, MAX_TEXT_KEY_LENGTH, MAX_ENUM_LENGTH } = require("./schema");

const RESULTS = Object.freeze({
  A_WIN: Object.freeze({ A: "W", B: "L" }),
  B_WIN: Object.freeze({ A: "L", B: "W" }),
  DRAW: Object.freeze({ A: "D", B: "D" }),
  BOTH_RETREAT: Object.freeze({ A: "D", B: "D" }),
});
const UNDECIDED = Object.freeze({ A: "U", B: "U" });
const SIDES = Object.freeze(["A", "B"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (detail) => ({ ok: false, reason: "PLAN_INVALID", detail });

function addSafe(a, b) {
  const s = a + b;
  return Number.isSafeInteger(s) ? s : null;
}

function sideInput(input, name) {
  const side = isObject(input) ? input[name === "A" ? "sideA" : "sideB"] : null;
  return isObject(side) ? side : { factionId: null, fleets: [] };
}

function factionsOf(side, garrison, name) {
  const out = new Set();
  if (isId(side.factionId)) out.add(side.factionId);
  for (const f of Array.isArray(side.fleets) ? side.fleets : []) {
    if (isObject(f) && isId(f.factionId)) out.add(f.factionId);
  }
  if (isObject(garrison) && garrison.side === name && isId(garrison.factionId)) out.add(garrison.factionId);
  return out;
}

function resultOf(result) {
  if (!isObject(result) || typeof result.outcome !== "string") return { outcome: null, sides: UNDECIDED };
  const sides = RESULTS[result.outcome];
  return sides ? { outcome: result.outcome, sides } : { outcome: null, sides: UNDECIDED };
}

function durationOf(result) {
  const v = isObject(result) ? result.estimatedDurationSec : null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const sec = Math.round(v);
  return Number.isSafeInteger(sec) ? sec : null;
}

function structureOf(result) {
  if (!isObject(result)) return { typeId: null, destroyed: null };
  const typeId = isId(result.structureTypeId) ? result.structureTypeId : null;
  const destroyed = typeof result.structureDestroyed === "boolean" ? (result.structureDestroyed ? 1 : 0) : null;
  return { typeId, destroyed };
}

function planBattle(battle, losses, prices) {
  if (!isObject(battle)) return invalid("battle");
  if (!isText(battle.battleId, MAX_TEXT_KEY_LENGTH)) return invalid("battleId");
  if (!isId(battle.systemId)) return invalid("systemId");
  if (!isTime(battle.settledAt)) return invalid("settledAt");
  if (!isTime(battle.createdAt)) return invalid("createdAt");
  for (const k of ["mode", "environment", "objective"]) {
    if (!isText(battle[k], MAX_ENUM_LENGTH)) return invalid(k);
  }
  if (!Array.isArray(losses)) return invalid("losses");
  const priceMap = prices && typeof prices.get === "function" ? prices : new Map();
  const input = isObject(battle.input) ? battle.input : {};
  const garrison = isObject(input.garrison) ? input.garrison : null;
  const sideIn = { A: sideInput(input, "A"), B: sideInput(input, "B") };
  const factions = { A: factionsOf(sideIn.A, garrison, "A"), B: factionsOf(sideIn.B, garrison, "B") };
  const fleetSide = new Map();
  const fleetsOf = { A: new Map(), B: new Map() };
  for (const name of SIDES) {
    for (const f of Array.isArray(sideIn[name].fleets) ? sideIn[name].fleets : []) {
      if (!isObject(f) || typeof f.fleetId !== "string") continue;
      if (!fleetSide.has(f.fleetId)) fleetSide.set(f.fleetId, name);
      if (isId(f.factionId)) fleetsOf[name].set(f.factionId, (fleetsOf[name].get(f.factionId) || 0) + 1);
    }
  }
  const { outcome, sides: resultBySide } = resultOf(battle.result);

  const perFaction = { A: new Map(), B: new Map() };
  const total = { A: { ships: 0, isk: 0 }, B: { ships: 0, isk: 0 } };
  let unpriced = 0;
  let unattributed = 0;
  for (let i = 0; i < losses.length; i += 1) {
    const loss = losses[i];
    if (!isObject(loss) || !Number.isSafeInteger(loss.count) || loss.count < 1) return invalid(`losses[${i}]`);
    let side = typeof loss.fleetId === "string" ? fleetSide.get(loss.fleetId) : undefined;
    if (side === undefined && isId(loss.factionId)) {
      const inA = factions.A.has(loss.factionId);
      const inB = factions.B.has(loss.factionId);
      if (inA !== inB) side = inA ? "A" : "B";
    }
    if (side === undefined) {
      unattributed = addSafe(unattributed, loss.count) ?? unattributed;
      continue;
    }
    const price = isId(loss.typeId) && priceMap.has(loss.typeId) ? priceMap.get(loss.typeId) : null;
    let isk = price === null || price === undefined ? null : iskOf(loss.count, price);
    const sideIsk = isk === null ? null : addSafe(total[side].isk, isk);
    if (sideIsk === null) isk = null;
    if (isk === null) unpriced = addSafe(unpriced, loss.count) ?? unpriced;
    const ships = addSafe(total[side].ships, loss.count);
    if (ships === null) return invalid(`losses[${i}].count`);
    total[side].ships = ships;
    if (isk !== null) total[side].isk = sideIsk;
    const factionId = isId(loss.factionId) ? loss.factionId : null;
    if (factionId !== null && factions[side].has(factionId)) {
      const cur = perFaction[side].get(factionId) || { ships: 0, isk: 0 };
      cur.ships += loss.count;
      if (isk !== null) cur.isk += isk;
      perFaction[side].set(factionId, cur);
    }
  }

  const structure = structureOf(battle.result);
  const row = Object.freeze({
    battleId: battle.battleId, settledAt: battle.settledAt, createdAt: battle.createdAt, systemId: battle.systemId,
    mode: battle.mode, environment: battle.environment, objective: battle.objective, outcome,
    aFactionId: isId(sideIn.A.factionId) ? sideIn.A.factionId : null,
    bFactionId: isId(sideIn.B.factionId) ? sideIn.B.factionId : null,
    aFleets: Array.isArray(sideIn.A.fleets) ? sideIn.A.fleets.length : 0,
    bFleets: Array.isArray(sideIn.B.fleets) ? sideIn.B.fleets.length : 0,
    aShipsLost: total.A.ships, bShipsLost: total.B.ships, aIskLost: total.A.isk, bIskLost: total.B.isk,
    unpricedShips: unpriced, structureTypeId: structure.typeId, structureDestroyed: structure.destroyed,
    durationSec: durationOf(battle.result), priceBasis: PRICE_BASIS,
  });
  const sides = [];
  const deltas = [];
  for (const name of SIDES) {
    const other = name === "A" ? "B" : "A";
    const result = resultBySide[name];
    for (const factionId of [...factions[name]].sort((a, b) => a - b)) {
      const own = perFaction[name].get(factionId) || { ships: 0, isk: 0 };
      sides.push(Object.freeze({ factionId, side: name, fleets: fleetsOf[name].get(factionId) || 0,
        shipsLost: own.ships, iskLost: own.isk, result }));
      deltas.push(Object.freeze({ factionId, battles: 1, wins: result === "W" ? 1 : 0, losses: result === "L" ? 1 : 0,
        draws: result === "D" ? 1 : 0, undecided: result === "U" ? 1 : 0, shipsLost: own.ships, iskLost: own.isk,
        shipsKilled: total[other].ships, iskKilled: total[other].isk }));
    }
  }
  return { ok: true, row, sides: Object.freeze(sides), deltas: Object.freeze(deltas), unattributed };
}

module.exports = { planBattle };
