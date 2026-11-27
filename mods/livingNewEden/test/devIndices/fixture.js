"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { devIndicesSettingsOf } = require("../../lib/world/devIndices/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1763600000000;
const HOUR = 3600000;
const MIN = 60000;

const ON_ENV = Object.freeze({ EVEJS_LNE_DEV_INDICES_ENABLED: "1", EVEJS_LNE_KILLBOARD_ENABLED: "1",
  EVEJS_LNE_KILLBOARD_KILLMAILS_ENABLED: "1", EVEJS_LNE_KILLBOARD_INCLUDE_NPC_VICTIMS: "1" });

let cached = null;

function configOf(env) {
  if (!env && cached) return cached;
  const r = resolveConfig({ modDir: MOD_DIR, env: { ...ON_ENV, ...(env || {}) } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  if (!env) cached = r;
  return r;
}

function settingsFor(env) {
  const s = devIndicesSettingsOf(configOf(env).config);
  assert.ok(s.ok, JSON.stringify(s));
  return s.settings;
}

function makeGraph() {
  const systems = new Map([[1, "highsec"], [2, "highsec"], [3, "highsec"], [4, "wormhole"], [5, "lowsec"]]
    .map(([id, secClass]) => [id, Object.freeze({ id, name: `Sys${id}`, secClass })]));
  return Object.freeze({ getSystem: (id) => systems.get(Number(id)) || null });
}

function makeWorld(initial) {
  const map = new Map(Object.entries(initial || {}).map(([k, v]) => [Number(k), v]));
  return {
    set: (id, controllerFactionId, occupationState = "STABLE") => map.set(id, { controllerFactionId, occupationState }),
    getSystem: (tx, id) => {
      const s = map.get(id);
      return { ok: true, system: s ? { systemId: id, controllerFactionId: s.controllerFactionId,
        occupationState: s.occupationState } : null };
    },
  };
}

function insertBattle(db, no, settledAt, systemId, sides) {
  db.prepare(`INSERT INTO kb_battles (battle_no, battle_id, settled_at, created_at, system_id, mode, environment,
    objective, outcome, a_faction_id, b_faction_id, a_fleets, b_fleets, a_ships_lost, b_ships_lost, a_isk_lost,
    b_isk_lost, unpriced_ships, price_basis, ingested_at)
    VALUES (?, ?, ?, ?, ?, 'VIRTUAL', 'SPACE', 'PATROL', NULL, NULL, NULL, 1, 1, 0, 0, 0, 0, 0, 'base', ?)`)
    .run(no, `b${no}`, settledAt, settledAt, systemId, settledAt);
  sides.forEach(([factionId, result], i) => {
    db.prepare(`INSERT INTO kb_battle_sides (battle_no, faction_id, side, fleets, ships_lost, isk_lost, result)
      VALUES (?, ?, ?, 1, 0, 0, ?)`).run(no, factionId, i === 0 ? "A" : "B", result);
  });
}

function insertKill(db, killId, killAt, systemId, cls) {
  db.prepare(`INSERT INTO kb_kills (kill_id, kill_at, system_id, isk_lost, attacker_count, attackers_json, class,
    ingested_at) VALUES (?, ?, ?, 0, 1, '[]', ?, ?)`).run(killId, killAt, systemId, cls, killAt);
}

module.exports = { MOD_DIR, T0, HOUR, MIN, ON_ENV, configOf, settingsFor, makeGraph, makeWorld, insertBattle,
  insertKill };
