"use strict";

const assert = require("node:assert");

const OCC = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const { validateChange, toJournalPayload } = require("../../lib/world/changeSet");
const { createHostility } = require("../../lib/battle/data/hostility");

const ATTACKER = 500003;
const DEFENDER = 500019;
const H = 3600000;
const isHostile = createHostility();
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8 });

const PARAMS = Object.freeze({ evalIntervalMs: 900000, idleEvalIntervalMs: 7200000, maxActiveSystems: 64,
  reconTimeoutMs: 2 * H, contestTimeoutMs: 6 * H, invasionHoldMs: 6 * H, occupiedSettleMs: 6 * H,
  consolidateMs: 24 * H, invasionMinScore: 30, occupyMinScore: 60, occupyMaxDefenderScore: 30, stableMinScore: 80,
  stableMaxResidualScore: 20, battleWinPoints: 20, battleLossPoints: 15, holdPointsPerHour: 10,
  stationPointsPerHour: 5, stationBonusCap: 3, decayPointsPerHour: 5, requireNoDefenderStations: true,
  garrisonFleetsTarget: 2, detachedUpkeepStep: 0.5, detachedUpkeepPeriodMs: 24 * H, detachedUpkeepMaxFactor: 4,
  maxFactionsPerSystem: 8, stableBaselineScore: 60, stableRecoverPointsPerHour: 1, stableForeignDecayPointsPerHour: 1,
  stableForeignFloorScore: 0, garrisonFromRoles: Object.freeze(["invasion", "patrol", "scout", "reserve"]) });

function view(o) {
  const range = new Set(o.range || []);
  return {
    systemId: o.systemId, state: o.state, controller: o.controller, occupier: o.occupier ?? null,
    previousController: o.previousController ?? null, sinceAt: o.sinceAt || 0, seq: o.seq || 0,
    evaluatedAt: null, capturedAt: null, detachedSinceAt: null, home: null, coreOwner: null,
    influence: new Map(Object.entries(o.influence || {}).map(([f, score]) => [Number(f), { score, garrison: 0 }])),
    presence: new Map(Object.entries(o.presence || {}).map(([f, strength]) => [Number(f), { strength, fleets: [] }])),
    stations: new Map(), inRange: (f) => range.has(f), isHostile, presenceTruncated: false, at: o.at || 0,
    rangeKnown: true,
  };
}

function occupationSteps(systemId) {
  const at = 7 * H;
  const contested = { systemId, state: OCC.CONTESTED, controller: DEFENDER, occupier: ATTACKER, at,
    range: [ATTACKER], presence: { [ATTACKER]: 100 }, influence: { [ATTACKER]: 50, [DEFENDER]: 40 } };
  const invade = M.evaluate(view(contested), { kind: "tick" }, PARAMS);
  assert.strictEqual(invade.to, OCC.INVASION, JSON.stringify(invade.notes));
  const invasion = { ...contested, state: OCC.INVASION, influence: { [ATTACKER]: 80, [DEFENDER]: 10 } };
  const capture = M.evaluate(view(invasion), { kind: "tick" }, PARAMS);
  assert.strictEqual(capture.to, OCC.OCCUPIED, JSON.stringify(capture.notes));
  const repelled = M.evaluate(view({ ...contested, presence: { [DEFENDER]: 100 } }), { kind: "tick" }, PARAMS);
  assert.strictEqual(repelled.to, OCC.STABLE, JSON.stringify(repelled.notes));
  const idle = M.evaluate(view({ ...contested, at: H, influence: { [ATTACKER]: 5, [DEFENDER]: 40 } }),
    { kind: "tick" }, PARAMS);
  assert.strictEqual(idle.to, null, JSON.stringify(idle.notes));
  const release = M.planRelease(view(invasion));
  assert.strictEqual(release.outcome, "RELEASED", JSON.stringify(release));
  const reconExpired = M.evaluate(view({ systemId, state: OCC.RECON, controller: DEFENDER, occupier: ATTACKER, at,
    range: [ATTACKER] }), { kind: "tick" }, PARAMS);
  assert.strictEqual(reconExpired.to, OCC.STABLE, JSON.stringify(reconExpired.notes));
  return { invade: invade.statePatch, capture: capture.statePatch, repelled: repelled.statePatch,
    idle: idle.statePatch, release: release.evaluation.statePatch, reconExpired: reconExpired.statePatch };
}

function worldPayload(change) {
  const v = validateChange(change, LIMITS);
  assert.ok(v.ok, JSON.stringify(v));
  return toJournalPayload(v.normalized);
}

function insertStation(db, stationId, systemId, ownerFactionId, at) {
  db.prepare(`INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family,
    system_id, owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
    evejs_item_id, destroyed_at, created_at, updated_at, version) VALUES (?, 'npc', NULL, 35834, 'Sansha', ?,
    ?, 1000125, 'ONLINE', NULL, 'Test Station', '{"x":0,"y":0,"z":0}', 'seed', NULL, NULL, ?, ?, 1)`)
    .run(stationId, systemId, ownerFactionId, at, at);
}

function siegeSpec(stationId, systemId, at) {
  return { stationId, siegeNo: 1, systemId, ownerFactionId: DEFENDER, attackerFactionId: ATTACKER,
    state: "SHIELD_ASSAULT", phaseEndsAt: at + H, plan: { v: 1 }, attackerShips: 5, attackerStrength: 100, at };
}

module.exports = { ATTACKER, DEFENDER, H, PARAMS, view, occupationSteps, worldPayload, insertStation, siegeSpec };
