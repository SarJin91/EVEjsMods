"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { createToolDeps } = require("../../lib/shipAi/tools/deps");
const { TOOL_BY_NAME } = require("../../lib/shipAi/tools/catalog");
const { TOOL_RULE, PERSONA } = require("../../lib/shipAi/data/persona");
const localPilots = require("../../lib/adapter/localPilots");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const OTHER = 9002;
const JITA = 30000142;
const PERIMETER = 30000144;
const GURISTAS = 500010;
const CALDARI = 500001;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings() {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0 } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function graphOf() {
  const built = buildUniverseGraph({ systems: [
    { id: JITA, name: "Jita", regionId: 10000002, constellationId: 20000020, security: 0.946, secClass: "highsec" },
    { id: PERIMETER, name: "Perimeter", regionId: 10000002, constellationId: 20000020, security: 0.95,
      secClass: "highsec" },
  ], gates: [{ fromSystemId: JITA, toSystemId: PERIMETER }, { fromSystemId: PERIMETER, toSystemId: JITA }],
  regionNames: new Map([[10000002, "The Forge"]]) });
  assert.ok(built.ok, JSON.stringify(built));
  return built.graph;
}

const row = (fleetId, factionId, state, systemId, shipCount, fleetRole) => ({ fleetId, factionId, state,
  currentSystemId: systemId, shipCount, fleetRole });

const ROWS = [row("fleet_g1", GURISTAS, "TRAVELLING", PERIMETER, 5, "gank"),
  row("fleet_g2", GURISTAS, "MATERIALIZED", JITA, 4, "hunt"),
  row("fleet_g3", GURISTAS, "RETREATING", JITA, 2, "patrol"),
  row("fleet_c1", CALDARI, "IDLE", JITA, 6, "garrison"), row("fleet_x1", GURISTAS, "TRAVELLING", PERIMETER, 3, "convoy")];

function fleetsFake() {
  const spy = { getFleets: [] };
  const repository = {
    listFleetsInSystems: (_tx, ids, opts) => ({ ok: true, bySystem: new Map(ids.map((id) => [id, ROWS
      .filter((f) => f.currentSystemId === id && opts.states.includes(f.state)).slice(0, opts.limitPerSystem)])) }),
    getFleets: (_tx, ids) => {
      spy.getFleets.push([...ids]);
      const fleets = ROWS.filter((f) => ids.includes(f.fleetId));
      return { ok: true, fleets, missing: ids.filter((id) => !fleets.some((f) => f.fleetId === id)) };
    },
  };
  return { spy, fleets: { repository } };
}

const materializationStatus = () => ({ state: "running", live: [],
  presence: { entries: [
    { fleetId: "fleet_g1", systemId: JITA, factionId: GURISTAS, phase: "VISIBLE", entityIds: [11, 12, 13],
      transit: { systemIndex: 1, despawnAt: 1, toSystemId: PERIMETER } },
    { fleetId: "fleet_g3", systemId: JITA, factionId: GURISTAS, phase: "VISIBLE", entityIds: [21], transit: null },
    { fleetId: "fleet_gone", systemId: JITA, factionId: GURISTAS, phase: "ENDING", entityIds: [31] }] },
  hunts: { hunts: [{ huntId: "h1", fleetId: "fleet_g2", systemId: JITA, factionId: GURISTAS, state: "LIVE", alive: 4,
    despawned: false }, { huntId: "h2", fleetId: "fleet_old", systemId: JITA, factionId: GURISTAS, state: "LIVE",
    alive: 0, despawned: true }] },
  patrols: { list: [] },
  exposures: { entries: [{ fleetId: "fleet_x1", systemId: JITA, factionId: GURISTAS, phase: "ENDING", ships: 3,
    destroyed: 0 }] },
  sentryHolds: { entries: [] } });

function adapterOf(seam) {
  return {
    readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "Pilot One", systemId: JITA,
      state: "space" }, { characterId: OTHER, name: "Other Pilot", systemId: JITA, state: "docked" }] }),
    readPirateFactionIds: () => ({ ok: true, ids: new Set([GURISTAS]) }),
    readCharacterStanding: () => ({ ok: true, found: true, standing: 1 }),
    readFactionNames: () => ({ ok: true, names: new Map([[GURISTAS, "Guristas Pirates"], [CALDARI, "Caldari State"]]) }),
    localPilotsSeams: () => ({ ok: true, seam }),
  };
}

function depsOf(o) {
  const graph = graphOf();
  const store = { transaction: (_name, fn) => ({ ok: true, value: fn({}) }) };
  return createToolDeps({ adapter: adapterOf(o.seam), sensors: null, S: o.S, getGraph: () => ({ getGraph: () => ({
    ok: true, graph }) }), getFleets: () => o.fleets, getWorld: () => null, getStore: () => store,
  ...(o.status ? { getMaterialization: () => ({ getStatus: o.status }) } : {}) });
}

const member = (id) => ({ character: { sequential: id }, corporation: { sequential: 1000127 }, alliance: null,
  no_alliance: true, faction: null, no_faction: true, classification: "CLASSIFICATION_UNSPECIFIED" });

module.exports = ({ test }) => {
  test("LF1 local_scan / nearby_threats: TRAVELLING crossing + RETREATING presence fleet + standing rows, hunt once, "
    + "ENDING / despawned never; NPC pilots of Local from the real seam; no IDs; no materialization = rows only", () => {
    localPilots._resetForTest();
    try {
      const S2 = settings();
      const emitter = new EventEmitter();
      assert.strictEqual(localPilots.install({ on: emitter.on.bind(emitter) }).ok, true);
      const seam = localPilots.createLocalPilotsSeam({ requireGame: () => ({ ok: false, reason: "x" }) });
      assert.deepStrictEqual(seam.setRoster(JITA, [member(91000001), member(91000002), member(91000003)]),
        { ok: true, size: 3 });
      assert.deepStrictEqual(seam.rosterSize(PERIMETER), { ok: true, pilots: 0 });
      assert.deepStrictEqual(seam.rosterSize(0), { ok: false, reason: "BAD_SYSTEM" });
      const { spy, fleets } = fleetsFake();
      const deps = depsOf({ S: S2, seam, fleets, status: materializationStatus });
      const ctx = { playerId: PLAYER, deps, nowMs: 1, S: S2 };

      const scan = TOOL_BY_NAME.get("local_scan").run(ctx, {});
      assert.strictEqual(scan.ok, true, JSON.stringify(scan));
      assert.deepStrictEqual(scan.data, { pilotsInLocal: 2, npcPilotsInLocal: 3, lneFleets: 4, lneShips: 14,
        factions: [
          { faction: "Guristas Pirates", fleets: 3, ships: 8, pirate: true, inSpace: 2,
            roles: ["gank", "hunt", "patrol"] },
          { faction: "Caldari State", fleets: 1, ships: 6, pirate: false, inSpace: 0, roles: ["garrison"] }] });
      assert.deepStrictEqual(spy.getFleets, [["fleet_g1", "fleet_g3"]], "one getFleets for the added fleets only");
      const json = JSON.stringify(scan);
      for (const banned of ["fleet_", String(PLAYER), String(OTHER), "Other Pilot", "91000001"]) {
        assert.ok(!json.includes(banned), `no ${banned} in ${json}`);
      }

      const threats = TOOL_BY_NAME.get("nearby_threats").run(ctx, {});
      assert.strictEqual(threats.ok, true, JSON.stringify(threats));
      assert.deepStrictEqual(threats.data.fleets.filter((f) => f.jumps === 0).map((f) => [f.faction, f.role, f.ships])
        .sort(), [["Guristas Pirates", "gank", 3], ["Guristas Pirates", "hunt", 4], ["Guristas Pirates", "patrol", 1]]);
      assert.strictEqual(threats.data.hostile, 3);

      localPilots._resetForTest();
      const rowsOnly = TOOL_BY_NAME.get("local_scan").run({ ...ctx, deps: depsOf({ S: S2, seam, fleets }) }, {});
      assert.deepStrictEqual([rowsOnly.data.lneFleets, rowsOnly.data.lneShips, rowsOnly.data.npcPilotsInLocal],
        [2, 10, null]);
    } finally {
      localPilots._resetForTest();
    }
  });

  test("LF2 tool rule: a data question is read with the tools at once, never 'shall I check?' (text + native, en "
    + "and pl persona name the tools)", () => {
    for (const mode of ["text", "native"]) {
      const t = TOOL_RULE[mode].join(" ");
      assert.ok(/at once/.test(t) && /Never\s+ask the pilot whether you should check/.test(t), `${mode}: ${t}`);
      assert.strictEqual((t.match(/\{max\}/g) || []).length, 1, "one {max} (loop.js replaces the first)");
    }
    assert.ok(PERSONA.en.rules.join(" ").includes("the sensor tools"));
    assert.ok(PERSONA.pl.rules.join(" ").includes("narzędzi sensorów"));
  });
};
