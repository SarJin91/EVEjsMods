"use strict";

const { stationAnchorRef, gridOfRef } = require("../../battle/gridContacts");
const { holdOf } = require("./siegeMachine");
const S = require("./schema");

const KIND_ANCHOR = "anchor";
const KIND_PLAYER = "player";
const KIND_LNE = "lne";
const ENGAGED = "ENGAGED";
const MOVER_STATES = Object.freeze(["IDLE", "STAGED"]);
const GRID_MOVE_ROWS = 2;
const GRID_STEP_ROWS = 6;
const DIGITS = /^[0-9]+$/;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function targetRefOf(t) {
  if (!t || typeof t !== "object") return null;
  if (t.kind === KIND_LNE) return stationAnchorRef(t.record);
  if (t.kind === KIND_PLAYER) return isId(t.structureId) ? `structure:${t.structureId}` : null;
  return null;
}

function parseRef(ref) {
  if (typeof ref !== "string") return null;
  const at = ref.indexOf(":");
  if (at <= 0) return null;
  const text = ref.slice(at + 1);
  if (!DIGITS.test(text)) return null;
  const id = Number(text);
  return isId(id) ? { kind: ref.slice(0, at), id } : null;
}

function gridScopeOf(input) {
  const gridOfFleet = new Map();
  const targetGridOf = new Map();
  const anchorOf = new Map();
  const positions = input && input.positions instanceof Map ? input.positions : new Map();
  for (const [fleetId, pos] of positions) {
    gridOfFleet.set(fleetId, pos && pos.kind === KIND_ANCHOR && typeof pos.gridKey === "string" ? pos.gridKey : null);
  }
  const gridOf = gridOfRef(input && input.grids);
  for (const t of Array.isArray(input && input.targets) ? input.targets : []) {
    if (!t) continue;
    const g = typeof t.ref === "string" ? gridOf.get(t.ref) : undefined;
    const anchor = g === undefined ? null : parseRef(t.ref);
    targetGridOf.set(t.targetId, anchor === null ? null : g);
    anchorOf.set(t.targetId, anchor);
  }
  return { gridOfFleet, targetGridOf, anchorOf };
}

function shipsOf(fleet, groups) {
  let n = 0;
  for (const e of fleet.composition || []) {
    if (groups[e.hullGroup] && Number.isSafeInteger(e.count) && e.count > 0) n += e.count;
  }
  return n;
}

function gridHoldOf(fleets, attackerFactionId, isHostile, groups, gridOfFleet, gridKey, opts) {
  const list = Array.isArray(fleets) ? fleets : [];
  const grids = gridOfFleet instanceof Map ? gridOfFleet : new Map();
  const inGrid = list.filter((f) => grids.get(f.fleetId) === gridKey);
  const field = holdOf(inGrid, attackerFactionId, isHostile, groups);
  const attackers = opts && opts.attackersAnywhere === true ? holdOf(list, attackerFactionId, isHostile, groups)
    : field;
  let awayShips = 0;
  for (const f of list) {
    if (f.factionId !== attackerFactionId || !S.SIEGE_ROLES.includes(f.fleetRole)) continue;
    if (!S.HOLD_STATES.includes(f.state) && f.state !== ENGAGED) continue;
    if (grids.get(f.fleetId) === gridKey) continue;
    awayShips += shipsOf(f, groups);
  }
  return { attackerShips: attackers.attackerShips, attackerDps: attackers.attackerDps,
    attackerStrength: attackers.attackerStrength, engaged: field.engaged, contested: field.contested, awayShips };
}

function moversOf(fleets, attackerFactionId, gridOfFleet, gridKey, maxMovers) {
  const grids = gridOfFleet instanceof Map ? gridOfFleet : new Map();
  const max = Number.isSafeInteger(maxMovers) && maxMovers > 0 ? maxMovers : 0;
  if (max === 0) return [];
  return (Array.isArray(fleets) ? fleets : []).filter((f) => f && f.factionId === attackerFactionId
    && S.SIEGE_ROLES.includes(f.fleetRole) && MOVER_STATES.includes(f.state)
    && typeof grids.get(f.fleetId) === "string" && grids.get(f.fleetId) !== gridKey)
    .sort((a, b) => byString(a.fleetId, b.fleetId)).slice(0, max)
    .map((f) => ({ fleetId: f.fleetId, legSeq: f.legSeq }));
}

module.exports = { targetRefOf, parseRef, gridScopeOf, gridHoldOf, moversOf, GRID_MOVE_ROWS, GRID_STEP_ROWS };
