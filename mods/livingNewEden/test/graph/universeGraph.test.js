"use strict";

const assert = require("node:assert");

const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { rawWorld, loadSecurityBand, NO_POSITION_ID } = require("./fixtures/staticMap.fixture");

function fixtureMap() {
  const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand());
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  return read.map;
}

function system(id, regionId = 10000001, constellationId = 20000001) {
  return { id, name: `S${id}`, regionId, constellationId, security: 0.5, trueSecurity: 0.5, secClass: "highsec",
    factionId: 0 };
}

module.exports = ({ test }) => {
  test("obs02-G1 positions: frozen {x,y,z} in StaticSystem and vertex, missing/NaN -> null, counted", () => {
    const world = rawWorld();
    const before = JSON.parse(JSON.stringify(world));
    world.solarSystems[0].position = { x: Number.NaN, y: 1, z: 2 };
    const read = readStaticMapFrom({ ensureLoaded: () => world }, loadSecurityBand());
    assert.strictEqual(read.ok, true);
    const bySystem = new Map(read.map.systems.map((s) => [s.id, s]));
    assert.deepStrictEqual(bySystem.get(30000002).position, { x: 1e16, y: 1e16, z: -5e15 });
    assert.ok(Object.isFrozen(bySystem.get(30000002).position));
    assert.strictEqual(bySystem.get(30000001).position, null, "NaN -> null");
    assert.strictEqual(bySystem.get(NO_POSITION_ID).position, null, "no field -> null");
    world.solarSystems[0].position = before.solarSystems[0].position;
    assert.deepStrictEqual(world, before, "EveJS arrays not mutated");

    const built = buildUniverseGraph(read.map);
    assert.strictEqual(built.stats.systemsWithoutPosition, 2);
    const v = built.graph.getSystem(30000002);
    assert.deepStrictEqual(v.position, { x: 1e16, y: 1e16, z: -5e15 });
    assert.ok(Object.isFrozen(v.position));
    assert.strictEqual(built.graph.getSystem(NO_POSITION_ID).position, null);
    assert.strictEqual(buildUniverseGraph(fixtureMap()).stats.systemsWithoutPosition, 1);
  });

  test("G1 graph: fixture counts, neighbors sorted, region index, sec classes, frozen", () => {
    const built = buildUniverseGraph(fixtureMap());
    assert.strictEqual(built.ok, true);
    const { graph, stats } = built;
    assert.strictEqual(stats.systems, 20);
    assert.strictEqual(stats.regions, 3);
    assert.strictEqual(stats.constellations, 5);
    assert.strictEqual(stats.edges, 12);
    assert.deepStrictEqual(stats.bySecClass, { highsec: 4, lowsec: 5, nullsec: 5, wormhole: 6, other: 0 });
    assert.deepStrictEqual([...graph.getNeighbors(30000007)], [30000006, 30000008]);
    assert.deepStrictEqual([...graph.getNeighbors("30000002")], [30000001, 30000003]);
    assert.deepStrictEqual([...graph.getNeighbors(30000013)], []);
    assert.strictEqual(graph.getNeighbors(39999999), null);
    assert.deepStrictEqual([...graph.getSystemsInRegion(10000002)],
      [30000008, 30000009, 30000010, 30000011, 30000012, 30000013, 30000014]);
    assert.deepStrictEqual([...graph.getSystemsInConstellation(20000002)], [30000005, 30000006, 30000007]);
    assert.deepStrictEqual([...graph.getConstellationsInRegion(10000001)], [20000001, 20000002]);
    assert.deepStrictEqual([...graph.getRegionIds()], [10000001, 10000002, 11000001]);
    assert.strictEqual(graph.getSystemIds().length, 20);
    assert.deepStrictEqual([...graph.getSystemsBySecClass("wormhole")],
      [31000001, 31000002, 31000003, 31000004, 31000005, 31000006]);
    assert.deepStrictEqual([...graph.getSystemsBySecClass("other")], []);
    assert.deepStrictEqual([...graph.getSystemsInRegion(99)], []);
    assert.strictEqual(graph.hasSystem(30000001), true);
    assert.strictEqual(graph.hasSystem(30009999), false);
    const s = graph.getSystem(30000007);
    assert.deepStrictEqual([s.regionId, s.constellationId, s.secClass, s.security, s.trueSecurity],
      [10000001, 20000002, "lowsec", 0.05, 0.04]);
    assert.strictEqual(graph.getSystem(1), null);
    for (const value of [graph, stats, stats.bySecClass, s, graph.getNeighbors(30000007), graph.getSystemIds(),
      graph.getSystemsInRegion(10000002), graph.getSystemsBySecClass("highsec"), graph.getNeighbors(30000013)]) {
      assert.ok(Object.isFrozen(value));
    }
  });

  test("G2 graph: one-sided gate once both ways, invalid gates skipped, duplicate id, empty snapshot", () => {
    const { graph, stats } = buildUniverseGraph(fixtureMap());
    assert.strictEqual(stats.oneSidedEdges, 1);
    assert.deepStrictEqual([...graph.getNeighbors(30000004)], [30000003, 30000005]);
    assert.deepStrictEqual([...graph.getNeighbors(30000003)], [30000002, 30000004]);
    assert.strictEqual(stats.invalidEdges, 2, "30000014->30009999 and the loop 30000010->30000010");
    assert.deepStrictEqual([...graph.getNeighbors(30000010)], [30000009, 30000011]);
    assert.deepStrictEqual([...graph.getNeighbors(30000014)], [30000012]);
    assert.strictEqual(stats.invalidSystems, 0);

    const dup = buildUniverseGraph({
      systems: [system(30000001), { ...system(30000001), name: "second" }, system(30000002), system(0)],
      gates: [{ gateId: 1, fromSystemId: 30000001, toSystemId: 30000002 },
        { gateId: 2, fromSystemId: 30000002, toSystemId: 30000001 },
        { gateId: 3, fromSystemId: 30000001, toSystemId: 30000002 }],
    });
    assert.strictEqual(dup.ok, true);
    assert.strictEqual(dup.stats.invalidSystems, 2, "duplicate id and id 0");
    assert.strictEqual(dup.graph.getSystem(30000001).name, "S30000001", "the first record stays");
    assert.strictEqual(dup.stats.edges, 1);
    assert.strictEqual(dup.stats.oneSidedEdges, 0);

    assert.deepStrictEqual(buildUniverseGraph({ systems: [system(-5)], gates: [] }),
      { ok: false, reason: "GRAPH_EMPTY" });
    assert.deepStrictEqual(buildUniverseGraph({ systems: [] }), { ok: false, reason: "SNAPSHOT_INVALID" });
    assert.deepStrictEqual(buildUniverseGraph(null), { ok: false, reason: "SNAPSHOT_INVALID" });
  });

  test("G3 graph names: station names per region/constellation, null when missing, counts", () => {
    const { graph, stats } = buildUniverseGraph(fixtureMap());
    assert.strictEqual(graph.getRegionName(10000001), "Alpha");
    assert.strictEqual(graph.getRegionName("10000002"), "Beta");
    assert.strictEqual(graph.getRegionName(11000001), null, "empty name in the data -> null");
    assert.strictEqual(graph.getRegionName(99), null);
    assert.strictEqual(graph.getConstellationName(20000001), "Alpha One");
    for (const id of [20000002, 20000003, 20000004, 21000001]) assert.strictEqual(graph.getConstellationName(id), null);
    assert.strictEqual(stats.regionsWithoutName, 1);
    assert.strictEqual(stats.constellationsWithoutName, 4);
    const plain = buildUniverseGraph({ systems: [system(30000001)], gates: [], regionNames: { 10000001: "R" } });
    assert.strictEqual(plain.graph.getRegionName(10000001), "R", "plain object accepted");
    assert.strictEqual(plain.stats.constellationsWithoutName, 1);
  });
};
