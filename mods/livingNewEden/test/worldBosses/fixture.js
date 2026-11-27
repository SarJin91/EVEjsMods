"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { settingsOf } = require("../../lib/worldBosses/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1763600000000;
const EXCLUDED = Object.freeze([200]);

function makeGraph() {
  const systems = new Map();
  const edges = new Map();
  const add = (id, regionId, secClass) => {
    systems.set(id, Object.freeze({ id, name: `S${id}`, regionId, secClass, position: { x: id * 10, y: 0, z: 0 } }));
    edges.set(id, []);
  };
  const link = (a, b) => {
    edges.get(a).push(b);
    edges.get(b).push(a);
  };
  for (let id = 1; id <= 12; id += 1) add(id, 100, "nullsec");
  add(13, 200, "nullsec");
  add(14, 100, "nullsec");
  add(15, 100, "highsec");
  add(16, 100, "nullsec");
  for (let id = 1; id < 12; id += 1) link(id, id + 1);
  link(6, 13);
  link(3, 15);
  link(16, 13);
  return Object.freeze({
    getSystem: (id) => systems.get(Number(id)) || null,
    getNeighbors: (id) => (edges.has(Number(id)) ? [...edges.get(Number(id))].sort((a, b) => a - b) : null),
    getSystemsBySecClass: (c) => [...systems.values()].filter((s) => s.secClass === c).map((s) => s.id)
      .sort((a, b) => a - b),
  });
}

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { ...(env || {}) } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r;
}

const FAST_ENV = Object.freeze({ EVEJS_LNE_WORLD_BOSSES_ENABLED: "1", EVEJS_LNE_WORLD_BOSSES_ROLL_ENABLED: "1",
  EVEJS_LNE_WORLD_BOSSES_ROLL_CHANCE_PERMILLE: "1000", EVEJS_LNE_WORLD_BOSSES_COOLDOWN_MS: "0",
  EVEJS_LNE_WORLD_BOSSES_SPAWN_MIN_JUMPS: "2", EVEJS_LNE_WORLD_BOSSES_SPAWN_MAX_JUMPS: "4",
  EVEJS_LNE_WORLD_BOSSES_DWELL_MS: "60000", EVEJS_LNE_WORLD_BOSSES_HOP_MS: "10000" });

function settingsFor(env) {
  const r = configOf({ ...FAST_ENV, ...(env || {}) });
  const s = settingsOf(r.config, { defaultExcludedRegionIds: EXCLUDED, routeMaxJumps: 40 });
  assert.ok(s.ok, JSON.stringify(s));
  return s.settings;
}

function fakes(observed) {
  const drops = [];
  const sitesCreated = [];
  const cleanups = [];
  return {
    drops, sitesCreated, cleanups,
    presence: { observedSystems: () => [...(observed || [1])] },
    occupation: { dropInfluenceInTx: (tx, spec, key) => {
      drops.push({ ...spec, key });
      return { ok: true, outcome: "APPLIED" };
    } },
    worldRepository: { getSystem: (tx, id) => ({ ok: true, system: { systemId: id, controllerFactionId: 500001 } }) },
    sites: {
      createSiteInTx: (tx, req) => {
        sitesCreated.push(req);
        return { ok: true, siteKey: `${req.eventId}:${req.slot}`, created: true, state: "CREATING" };
      },
      cleanupSitesInTx: (tx, eventId, reason) => {
        cleanups.push([eventId, reason]);
        return { ok: true, released: 1 };
      },
    },
  };
}

module.exports = { T0, EXCLUDED, makeGraph, configOf, settingsFor, fakes, FAST_ENV };
