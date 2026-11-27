"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { loadMapNames } = require("../../lib/adapter/mapNames");
const { classifySystem, readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { SEC_CLASS_BY_BAND } = require("../../lib/adapter/staticMapData");
const { rawWorld, loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");

module.exports = ({ test }) => {
  test("A1 staticMap: sec thresholds match getSystemSecurityClass, wormhole and other by ID", () => {
    const band = loadSecurityBand();
    const cases = [[-0.2, "nullsec"], [0.0, "nullsec"], [0.04, "lowsec"], [0.3, "lowsec"], [0.449, "lowsec"],
      [0.45, "highsec"], [0.5, "highsec"], [1.0, "highsec"]];
    for (const [security, expected] of cases) {
      const row = { solarSystemID: 30000001, security };
      assert.strictEqual(classifySystem(row, band), expected, String(security));
      assert.strictEqual(SEC_CLASS_BY_BAND[band.getSystemSecurityClass(row)], expected, `oracle ${security}`);
    }
    assert.strictEqual(classifySystem({ solarSystemID: 31000001, security: -0.99 }, band), "wormhole");
    assert.strictEqual(classifySystem({ solarSystemID: 32000001, security: -0.99 }, band), "other");
    assert.strictEqual(classifySystem({ solarSystemID: 34000001, security: -0.99 }, band), "other");
  });

  test("A2 staticMap: fixture read normalized and untouched; empty, drift and throw refused", () => {
    const band = loadSecurityBand();
    const world = rawWorld();
    const before = JSON.parse(JSON.stringify(world));
    const read = readStaticMapFrom({ ensureLoaded: () => world }, band);
    assert.strictEqual(read.ok, true, JSON.stringify(read));
    assert.strictEqual(read.map.source, "worldData");
    assert.strictEqual(read.map.systems.length, 20);
    assert.strictEqual(read.map.gates.length, world.stargates.length);
    assert.deepStrictEqual(read.map.systems[6], { id: 30000007, name: "S30000007", regionId: 10000001,
      constellationId: 20000002, security: 0.05, trueSecurity: 0.04, secClass: "lowsec", factionId: 0,
      position: { x: 6e16, y: 0, z: -3e16 } });
    assert.deepStrictEqual(read.map.gates[0], { gateId: 50000001, fromSystemId: 30000001, toSystemId: 30000002 });
    assert.deepStrictEqual([...read.map.regionNames], [[10000001, "Alpha"], [10000002, "Beta"]]);
    assert.deepStrictEqual([...read.map.constellationNames], [[20000001, "Alpha One"]]);
    assert.deepStrictEqual(world, before, "EveJS arrays not mutated");

    const of = (cache) => readStaticMapFrom({ ensureLoaded: () => cache }, band);
    assert.deepStrictEqual(of({ ...world, solarSystems: [] }),
      { ok: false, reason: "STATIC_TABLE_EMPTY", detail: "solarSystems" });
    assert.deepStrictEqual(of({ ...world, stargates: [] }),
      { ok: false, reason: "STATIC_TABLE_EMPTY", detail: "stargates" });
    assert.strictEqual(of({}).reason, "STATIC_SHAPE_DRIFT");
    assert.strictEqual(of(null).reason, "STATIC_SHAPE_DRIFT");
    const noDestination = world.stargates.map((g) => ({ itemID: g.itemID, solarSystemID: g.solarSystemID }));
    assert.deepStrictEqual(of({ ...world, stargates: noDestination }),
      { ok: false, reason: "STATIC_SHAPE_DRIFT", detail: "stargates.destinationSolarSystemID" });
    assert.deepStrictEqual(readStaticMapFrom({ ensureLoaded: () => { throw new Error("tables gone"); } }, band),
      { ok: false, reason: "STATIC_READ_FAILED", detail: "tables gone" });
    const noStations = of({ solarSystems: world.solarSystems, stargates: world.stargates });
    assert.strictEqual(noStations.ok, true);
    assert.strictEqual(noStations.map.regionNames.size, 0, "no stations -> no names, no refusal");
  });

  test("A3 mapNames: data file first, stations fallback, null otherwise; broken/missing file; real file", () => {
    const band = loadSecurityBand();
    const mapNames = { ok: true, source: "test", regions: new Map([[10000001, "Derelik"], [11000001, "A-R00001"]]),
      constellations: new Map([[20000002, "Kalevala Expanse"]]) };
    const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, band, { mapNames });
    assert.deepStrictEqual([...read.map.regionNames].sort((a, b) => a[0] - b[0]),
      [[10000001, "Derelik"], [10000002, "Beta"], [11000001, "A-R00001"]], "data file wins, station fills Beta");
    assert.deepStrictEqual([...read.map.constellationNames].sort((a, b) => a[0] - b[0]),
      [[20000001, "Alpha One"], [20000002, "Kalevala Expanse"]]);
    assert.strictEqual(read.map.nameSource, "mapNames(test)+stations");
    assert.strictEqual(read.map.namesWarning, null);

    const broken = loadMapNames({ readFileSync: () => "{not json" });
    assert.strictEqual(broken.reason, "MAP_NAMES_INVALID");
    assert.strictEqual(loadMapNames({ readFileSync: () => "{\"regions\":[]}" }).reason, "MAP_NAMES_INVALID");
    const missing = loadMapNames({ filePath: path.join(os.tmpdir(), "lne-no-such-dir", "mapNames.json") });
    assert.deepStrictEqual(missing, { ok: false, reason: "MAP_NAMES_UNREADABLE", detail: "ENOENT" });
    const fallback = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, band, { mapNames: missing });
    assert.strictEqual(fallback.ok, true, "a missing data file never fails the map");
    assert.deepStrictEqual(fallback.map.namesWarning, { reason: "MAP_NAMES_UNREADABLE", detail: "ENOENT" });
    assert.strictEqual(fallback.map.nameSource, "stations");
    assert.strictEqual(fallback.map.regionNames.get(10000001), "Alpha");

    const real = loadMapNames();
    assert.strictEqual(real.ok, true, JSON.stringify(real));
    assert.deepStrictEqual([real.source, real.regions.size, real.constellations.size], ["SDE 3396210", 114, 1184]);
  });

  test("OR-A2 mapNames: SDE 500021 \"Unknown\" -> label Sleepers, other faction names unchanged", () => {
    const text = JSON.stringify({ source: "t", regions: { 10000001: "Derelik" }, constellations: {},
      factions: { 500021: "Unknown", 500025: "Rogue Drones", 500001: "Caldari State" } });
    const r = loadMapNames({ readFileSync: () => text });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.factions.get(500021), "Sleepers");
    assert.strictEqual(r.factions.get(500025), "Rogue Drones");
    assert.strictEqual(r.factions.get(500001), "Caldari State");
  });
};
