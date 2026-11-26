"use strict";

const { EVASIVE_ROLES } = require("../../battle/data/contactRules");
const { deriveSeed, createRng } = require("../../util/rng");
const { hasWormholeEdges } = require("../../fleets/travel");
const { crossingOf } = require("../../fleets/crossing");
const { TRANSIT_PICKET_PREFIX } = require("../../sentries/schema");

const PERMILLE = 1000;
const EXEMPT_REASONS = Object.freeze(["WORMHOLE", "FACTION", "ROLE", "NO_OPERATION", "OPERATION"]);
const SEED_KIND = "transit-checkpoint";
const STALE_REASONS = Object.freeze(["TARGET_GONE", "LEG_MOVED", "LEG_HAS_WORMHOLES", "NOT_CROSSING", "EXEMPT",
  "NOT_CONTROLLED", "NOT_HOSTILE", "BATTLE_UNAVAILABLE"]);
const FINAL_STALE = Object.freeze(STALE_REASONS.slice(0, 5));
const KINDS = Object.freeze(["PICKET", "CONTACT"]);
const ITEM_ID_SCALE = 1000;
const PICKET_ITEM_OFFSET = 500;

const nonNeg = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

function chancePermilleOf(entry, S, extraPermille = 0) {
  if (!entry) return 0;
  const control = Math.floor(S.controlPermille * nonNeg(entry.influence) / 100);
  const garrison = Math.min(S.garrisonCapPermille,
    Math.floor(nonNeg(entry.garrison) * S.garrisonPermillePer1000 / PERMILLE));
  const sentries = Math.min(S.sentryCapPermille, Math.floor(nonNeg(entry.gateSentries)) * S.sentryPermilleEach);
  const extra = Math.floor(nonNeg(extraPermille));
  const sum = S.basePermille + control + garrison + sentries + extra;
  return Math.max(0, Math.min(S.maxChancePermille, sum));
}

function classPermilleOf({ fleetRole, shipCount }, S) {
  if (EVASIVE_ROLES.includes(fleetRole)) return S.evasiveRolePermille;
  if (Number.isSafeInteger(shipCount) && shipCount <= S.smallGangMaxShips) return S.smallGangPermille;
  if (Number.isSafeInteger(shipCount) && shipCount >= S.largeFleetMinShips) return S.largeFleetPermille;
  return PERMILLE;
}

function exemptOf(mover, S) {
  if (mover.wormholes === true) return "WORMHOLE";
  if (S.exemptFactionIds.includes(mover.factionId)) return "FACTION";
  if (S.exemptRoles.includes(mover.fleetRole)) return "ROLE";
  if (mover.operationType === null || mover.operationType === undefined) return "NO_OPERATION";
  if (S.exemptOperationTypes.includes(mover.operationType)) return "OPERATION";
  return null;
}

function hostileCrossingsOfLeg(leg, indexGet, isHostile, mover, S) {
  const exempt = exemptOf(mover, S);
  if (exempt !== null) return { crossings: [], truncated: false, exempt };
  const systems = leg && Array.isArray(leg.systems) ? leg.systems : [];
  const inner = Math.max(0, systems.length - 2);
  const last = Math.min(inner, S.listenerMaxSystems);
  const classPermille = classPermilleOf(mover, S);
  const crossings = [];
  for (let i = 1; i <= last; i += 1) {
    const systemId = systems[i];
    const entry = indexGet(systemId);
    if (!entry || isHostile(mover.factionId, entry.controllerFactionId) !== true) continue;
    crossings.push({ systemIndex: i, systemId, at: leg.departAt + i * leg.jumpMs,
      chancePermille: Math.floor(entry.chanceBase * classPermille / PERMILLE) });
  }
  return { crossings, truncated: inner > S.listenerMaxSystems, exempt: null };
}

function routeContactPermille(chances) {
  if (!Array.isArray(chances) || chances.length === 0) return 0;
  let q = 1;
  for (const p of chances) q *= 1 - Math.max(0, Math.min(PERMILLE, p)) / PERMILLE;
  return PERMILLE - Math.round(q * PERMILLE);
}

function shipCountOf(composition) {
  if (!Array.isArray(composition)) return null;
  let sum = 0;
  for (const e of composition) {
    if (!e || !Number.isSafeInteger(e.count) || e.count < 0) return null;
    sum += e.count;
  }
  return sum;
}

const haltLimitOf = (S) => Math.min(S.haltsPerControllerHour, S.maxRowsPerTransaction);

function decideCheckpoint(facts, S) {
  const { p, target } = facts;
  const stale = (reason) => ({ action: "STALE", reason });
  if (!target || target.state === "DESTROYED") return stale("TARGET_GONE");
  if (target.state !== "TRAVELLING" || target.legSeq !== p.legSeq) return stale("LEG_MOVED");
  if (target.route && hasWormholeEdges(target.route)) return stale("LEG_HAS_WORMHOLES");
  const x = crossingOf(target, p.systemId);
  if (!x || x.i !== p.systemIndex || p.at < x.from || p.at >= x.from + x.jumpMs) return stale("NOT_CROSSING");
  if (facts.exemptReason !== null && facts.exemptReason !== undefined) return stale("EXEMPT");
  if (facts.controllerFactionId === null || facts.controllerFactionId === undefined || facts.secClassOk !== true) {
    return stale("NOT_CONTROLLED");
  }
  if (facts.hostile !== true) return stale("NOT_HOSTILE");
  if (facts.observed === true) return { action: "OBSERVED" };
  if (facts.cooldown === true) return { action: "COOLDOWN" };
  const chancePermille = Math.max(0, Math.min(PERMILLE, Math.floor(nonNeg(facts.chancePermille))));
  const roll = createRng(deriveSeed(facts.worldSeed, SEED_KIND, `${p.systemId}:${p.fleetId}:${p.legSeq}`)).nextFloat();
  if (roll * PERMILLE >= chancePermille) return { action: "PASS", roll, chancePermille };
  if (S.haltsPerControllerHour === 0 || facts.haltsThisHour >= haltLimitOf(S)) {
    return { action: "BUDGET", roll, chancePermille };
  }
  if (facts.battleReady !== true) return stale("BATTLE_UNAVAILABLE");
  const kind = facts.defenders > 0 && facts.moverEvasive !== true ? "CONTACT" : "PICKET";
  return { action: "HALT", roll, chancePermille, kind };
}

function chainsAfter(decision) {
  if (!decision || decision.action === "HALT") return false;
  return !(decision.action === "STALE" && FINAL_STALE.includes(decision.reason));
}

function picketDefensesOf(systemId, controllerFactionId, systemChancePermille, S) {
  const wanted = Math.ceil(nonNeg(systemChancePermille) / S.picketPermillePerBattery);
  const batteries = Math.max(1, Math.min(S.picketMaxBatteries, wanted));
  const entries = [];
  for (let i = 0; i < batteries; i += 1) {
    entries.push({ sentryId: `${TRANSIT_PICKET_PREFIX}${systemId}:${i}`,
      itemId: systemId * ITEM_ID_SCALE + PICKET_ITEM_OFFSET + i + 1, typeId: S.picketBatteryTypeId,
      ownerKind: "faction", ownerId: controllerFactionId, hp: S.picketBatteryHp, ehp: S.picketBatteryHp,
      dps: S.picketBatteryDps, signature: S.picketBatterySignature, designSig: S.picketBatteryDesignSig });
  }
  return { attackerRetreatLossPermille: S.picketAttackerRetreatLossPermille, entries };
}

function nextHostileOf(leg, afterIndex, states, isHostile, moverFactionId, S) {
  const systems = leg && Array.isArray(leg.systems) ? leg.systems : [];
  const last = Math.min(Math.max(0, systems.length - 2), S.listenerMaxSystems);
  for (let i = Math.max(1, afterIndex + 1); i <= last; i += 1) {
    const st = states && typeof states.get === "function" ? states.get(systems[i]) : null;
    if (!st || st.controllerFactionId === null || st.controllerFactionId === undefined
      || !S.secClasses.includes(st.securityClass) || isHostile(moverFactionId, st.controllerFactionId) !== true) {
      continue;
    }
    return { systemIndex: i, systemId: systems[i], at: leg.departAt + i * leg.jumpMs };
  }
  return null;
}

module.exports = { chancePermilleOf, classPermilleOf, exemptOf, hostileCrossingsOfLeg, routeContactPermille,
  shipCountOf, haltLimitOf, decideCheckpoint, chainsAfter, picketDefensesOf, nextHostileOf, EXEMPT_REASONS,
  SEED_KIND, STALE_REASONS, FINAL_STALE, KINDS };
