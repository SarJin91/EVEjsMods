"use strict";

const { holdOf } = require("../stations/siege/siegeMachine");
const { SIEGE_ROLES } = require("../stations/siege/schema");
const { BATTLE_FLEET_STATES } = require("./schema");

const PERMILLE = 1000;
const OWNER_FACTION = "faction";
const OWNER_PLAYER = "player";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const NOT_CONTESTED = () => false;
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function ownerIdOf(s) {
  if (s.ownerKind === OWNER_FACTION) return isId(s.factionId) ? s.factionId : null;
  if (s.ownerKind === OWNER_PLAYER) return isId(s.characterId) ? s.characterId : null;
  return null;
}

const usable = (s) => s && typeof s.sentryId === "string" && isId(s.itemId) && isId(s.typeId)
  && ownerIdOf(s) !== null && Number.isSafeInteger(s.hp) && s.hp >= 1 && Number.isFinite(s.dps) && s.dps >= 0
  && Number.isFinite(s.signature) && s.signature > 0 && Number.isFinite(s.designSig) && s.designSig > 0;

function planSentryBattle(input) {
  const i = input && typeof input === "object" ? input : {};
  const settings = i.settings && typeof i.settings === "object" ? i.settings : {};
  const fleets = (Array.isArray(i.fleets) ? i.fleets : []).filter((f) => f && typeof f.fleetId === "string"
    && isId(f.factionId) && Number.isSafeInteger(f.version) && SIEGE_ROLES.includes(f.fleetRole)
    && BATTLE_FLEET_STATES.includes(f.state));
  const sentries = (Array.isArray(i.sentries) ? i.sentries : []).filter(usable)
    .sort((a, b) => byId(a.sentryId, b.sentryId));
  if (sentries.length === 0) return { battle: null, reason: "NO_SENTRY" };
  const hostileTo = typeof i.isHostileTo === "function" ? i.isHostileTo : () => false;
  const factions = [...new Set(fleets.map((f) => f.factionId))].sort((a, b) => a - b);
  const candidates = [];
  for (const g of factions) {
    const targets = sentries.filter((s) => hostileTo(s, g) === true);
    if (targets.length === 0) continue;
    const dps = holdOf(fleets, g, NOT_CONTESTED, i.groups || {}).attackerDps;
    if (dps > 0) candidates.push({ factionId: g, dps, targets });
  }
  if (candidates.length === 0) return { battle: null, reason: "NO_HOSTILE" };
  const grid = gridOf(i.grid);
  const pool = grid === null ? candidates : gridCandidatesOf(candidates, fleets, grid, i.groups || {});
  if (pool.length === 0) return { battle: null, reason: "NO_GRID_CONTACT" };
  let pick = pool[0];
  for (const c of pool) if (c.dps > pick.dps) pick = c;
  const maxFleets = isId(settings.maxFleetsPerSide) ? settings.maxFleetsPerSide : 1;
  const maxSentries = isId(settings.maxSentriesPerBattle) ? settings.maxSentriesPerBattle : 1;
  const taken = isId(settings.damageTakenPermille) ? settings.damageTakenPermille : PERMILLE;
  const sideFleets = grid === null ? fleets.filter((f) => f.factionId === pick.factionId) : pick.fleets;
  const side = sideFleets
    .sort((a, b) => (Number(b.shipCount) || 0) - (Number(a.shipCount) || 0) || byId(a.fleetId, b.fleetId))
    .slice(0, maxFleets).map((f) => ({ fleetId: f.fleetId, expectedVersion: f.version }));
  const entries = pick.targets.slice(0, maxSentries).map((s) => ({ sentryId: s.sentryId, itemId: s.itemId,
    typeId: s.typeId, ownerKind: s.ownerKind, ownerId: ownerIdOf(s), hp: s.hp,
    ehp: Math.ceil((s.hp * PERMILLE) / taken), dps: s.dps, signature: s.signature, designSig: s.designSig }));
  const battle = { factionId: pick.factionId, fleets: side,
    fixedDefenses: { attackerRetreatLossPermille: settings.attackerRetreatLossPermille, entries } };
  if (grid !== null) battle.gridKey = pick.gridKey;
  return { battle, more: pool.length > 1 };
}

function gridOf(g) {
  return g && typeof g === "object" && g.gridOfFleet instanceof Map && g.gridOfSentry instanceof Map ? g : null;
}

function gridCandidatesOf(candidates, fleets, grid, groups) {
  const out = [];
  for (const c of candidates) {
    const own = fleets.filter((f) => f.factionId === c.factionId);
    const keys = [...new Set(own.map((f) => grid.gridOfFleet.get(f.fleetId))
      .filter((k) => typeof k === "string"))].sort(byId);
    for (const k of keys) {
      const targets = c.targets.filter((s) => grid.gridOfSentry.get(s.sentryId) === k);
      if (targets.length === 0) continue;
      const inGrid = own.filter((f) => grid.gridOfFleet.get(f.fleetId) === k);
      const dps = holdOf(inGrid, c.factionId, NOT_CONTESTED, groups).attackerDps;
      if (dps > 0) out.push({ factionId: c.factionId, gridKey: k, dps, targets, fleets: inGrid });
    }
  }
  return out;
}

module.exports = { planSentryBattle, ownerIdOf };
