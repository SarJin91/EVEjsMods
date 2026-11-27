"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSdeWorld } = require("../../tools/campaign/sdeWorld");

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lne-livesim-statics-${name}-`));
}

function rmQuiet(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (_err) {
  }
}

function writeMiniSde(dir, withInterior = true) {
  const name = (en) => ({ en });
  const lines = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "mapRegions.jsonl"), lines([{ _key: 10000001, name: name("Mini Region") }]));
  fs.writeFileSync(path.join(dir, "mapConstellations.jsonl"), lines([{ _key: 20000001, regionID: 10000001,
    name: name("Mini Constellation") }]));
  fs.writeFileSync(path.join(dir, "mapSolarSystems.jsonl"), lines([30000001, 30000002].map((id, i) => ({ _key: id,
    constellationID: 20000001, regionID: 10000001, name: name(`Mini ${i + 1}`), position: { x: i * 1e16, y: 0, z: 0 },
    radius: 1e12, securityStatus: 0.9, securityClass: "B" }))));
  const gate = (key, from, to, x) => ({ _key: key, solarSystemID: from, typeID: 29633,
    destination: { solarSystemID: to, stargateID: 1 }, position: { x, y: 1, z: 2 } });
  fs.writeFileSync(path.join(dir, "mapStargates.jsonl"), lines([gate(50000001, 30000001, 30000002, 1e11),
    gate(50000005, 30000002, 30000001, 3e11), gate(50000004, 30000002, 30000001, 2e11)]));
  fs.writeFileSync(path.join(dir, "npcStations.jsonl"), lines([{ _key: 60000001, typeID: 1529, ownerID: 1000035,
    solarSystemID: 30000001, orbitID: 40000002, position: { x: 5e10, y: 3, z: 4 } }]));
  if (withInterior) {
    fs.writeFileSync(path.join(dir, "mapStars.jsonl"), lines([{ _key: 40000001, solarSystemID: 30000001,
      typeID: 45041, radius: 1e8 }]));
    fs.writeFileSync(path.join(dir, "mapPlanets.jsonl"), lines([{ _key: 40000002, solarSystemID: 30000001, typeID: 11,
      celestialIndex: 1, orbitID: 40000001, position: { x: 4e10, y: 5, z: 6 }, statistics: { density: 1 } }]));
    fs.writeFileSync(path.join(dir, "mapAsteroidBelts.jsonl"), lines([{ _key: 40000003, solarSystemID: 30000001,
      typeID: 15, celestialIndex: 1, orbitID: 40000002, orbitIndex: 1, position: { x: 4.1e10, y: 7, z: 8 } }]));
  }
  fs.writeFileSync(path.join(dir, "_sde.jsonl"), lines([{ _key: "sde", buildNumber: 1 }]));
}

module.exports = ({ test }) => {
  const dir = tmpDir("mini");
  const bare = tmpDir("bare");
  writeMiniSde(dir);
  writeMiniSde(bare, false);
  const plain = buildSdeWorld(dir);
  const off = buildSdeWorld(dir, { statics: false });
  const on = buildSdeWorld(dir, { statics: true });
  const bareOn = buildSdeWorld(bare, { statics: true });
  rmQuiet(dir);
  rmQuiet(bare);

  test("LSS-T1 buildSdeWorld without the option = the bench world; statics:true keeps the base fields", () => {
    for (const r of [plain, off, on, bareOn]) assert.strictEqual(r.ok, true, r.detail);
    for (const r of [plain, off]) {
      assert.deepStrictEqual(Object.keys(r.world),
        ["worldData", "asteroidData", "sdeBuild", "systemCount", "stationCount", "beltCount"]);
      assert.deepStrictEqual(Object.keys(r.world.worldData), ["ensureLoaded", "getSolarSystemByID", "getStationByID"]);
      assert.strictEqual("statics" in r.world, false);
    }
    assert.deepStrictEqual(Object.keys(on.world.worldData), ["ensureLoaded", "getSolarSystemByID", "getStationByID",
      "getStargatesForSystem", "getStationsForSystem", "getAsteroidBeltsForSystem", "getCelestialsForSystem"]);
    assert.deepStrictEqual(on.world.worldData.ensureLoaded(), plain.world.worldData.ensureLoaded());
    assert.deepStrictEqual(on.world.worldData.getStationByID(60000001), plain.world.worldData.getStationByID(60000001));
    assert.strictEqual("orbitID" in on.world.worldData.getStationByID(60000001), false, "base rows not extended");
    assert.strictEqual(on.world.asteroidData.getBeltsForSystem(30000001).length,
      plain.world.asteroidData.getBeltsForSystem(30000001).length);
    assert.deepStrictEqual([on.world.beltCount, on.world.systemCount, on.world.stationCount, on.world.sdeBuild],
      [plain.world.beltCount, plain.world.systemCount, plain.world.stationCount, plain.world.sdeBuild]);
  });

  test("LSS-T2 the 4 getters: sorted, copies, vendor names, counts; optional interior files", () => {
    const wd = on.world.worldData;
    assert.deepStrictEqual(wd.getStargatesForSystem(30000002).map((g) => g.itemID), [50000004, 50000005]);
    const gates = wd.getStargatesForSystem(30000001);
    gates.push({ itemID: 1 });
    assert.strictEqual(wd.getStargatesForSystem(30000001).length, 1, "a copy of the list");
    for (const g of ["getStargatesForSystem", "getStationsForSystem", "getAsteroidBeltsForSystem",
      "getCelestialsForSystem"]) {
      assert.deepStrictEqual(wd[g](39999999), [], g);
    }
    const [sun, planet] = wd.getCelestialsForSystem("30000001");
    assert.deepStrictEqual([sun.position, sun.groupID, sun.kind, sun.itemName], [{ x: 0, y: 0, z: 0 }, 6, "sun",
      "Mini 1 - Star"]);
    assert.deepStrictEqual([planet.itemName, planet.groupID, planet.kind, planet.orbitID], ["Mini 1 I", 7, "planet",
      40000001]);
    const [belt] = wd.getAsteroidBeltsForSystem(30000001);
    assert.deepStrictEqual([belt.itemName, belt.kind, belt.orbitID], ["Mini 1 I - Asteroid Belt 1", "asteroidBelt",
      40000002]);
    assert.deepStrictEqual([gates[0].itemName, gates[0].destinationSolarSystemID], ["Stargate (Mini 2)", 30000002]);
    const [station] = wd.getStationsForSystem(30000001);
    assert.deepStrictEqual([station.stationID, station.itemID, station.orbitID, station.stationName],
      [60000001, 60000001, 40000002, null]);
    assert.deepStrictEqual({ ...on.world.statics }, { suns: 1, planets: 1, belts: 1, gates: 3, stations: 1 });
    assert.deepStrictEqual(bareOn.world.worldData.getCelestialsForSystem(30000001), []);
    assert.deepStrictEqual(bareOn.world.worldData.getAsteroidBeltsForSystem(30000001), []);
    assert.deepStrictEqual({ ...bareOn.world.statics }, { suns: 0, planets: 0, belts: 0, gates: 3, stations: 1 });
  });

  const { createLiveAdapter } = require("../../tools/liveSim/liveAdapter");
  const { BENCH_UNSUPPORTED } = require("../../tools/campaign/benchAdapter");
  const shutdown = { gameStoreLike: { registerShutdownHook() {} } };

  test("LSS-T3 createLiveAdapter with statics: readGridAnchors / readSystemInterior through the cores", () => {
    const live = createLiveAdapter({ world: on.world, driver: null, policy: null, band: null, shutdown });
    const a = live.adapter.readGridAnchors(30000001, { maxAnchors: 64 });
    assert.strictEqual(a.ok, true, a.detail);
    assert.deepStrictEqual(a.anchors.map((x) => x.kind), ["gate", "station", "sun", "belt"]);
    assert.strictEqual(a.anchors[0].toSystemId, 30000002);
    assert.deepStrictEqual({ ...a.anchors[2].position }, { x: 0, y: 0, z: 0 });
    assert.strictEqual(a.truncated, false);
    const cut = live.adapter.readGridAnchors(30000001, { maxAnchors: 2 });
    assert.deepStrictEqual([cut.anchors.map((x) => x.kind), cut.truncated], [["gate", "station"], true]);
    const s = live.adapter.readSystemInterior(30000001, { maxObjects: 64 });
    assert.strictEqual(s.ok, true, s.detail);
    assert.deepStrictEqual(s.objects.map((o) => o.kind), ["sun", "planet", "gate", "station", "belt"]);
    const byKind = Object.fromEntries(s.objects.map((o) => [o.kind, o]));
    assert.deepStrictEqual([byKind.belt.parentId, byKind.station.parentId, byKind.gate.toSystemId],
      [40000002, 40000002, 30000002]);
    assert.strictEqual(s.system.name, "Mini 1");
    const unsupported = live.getUnsupported();
    assert.deepStrictEqual(["readGridAnchors" in unsupported, "readSystemInterior" in unsupported], [false, false]);
  });

  test("LSS-T4 without statics: BENCH_UNSUPPORTED counted; --no-statics", () => {
    const live = createLiveAdapter({ world: plain.world, driver: null, policy: null, band: null, shutdown });
    assert.strictEqual(live.adapter.readGridAnchors(30000001, { maxAnchors: 64 }), BENCH_UNSUPPORTED);
    assert.strictEqual(live.adapter.readSystemInterior(30000001, { maxObjects: 64 }), BENCH_UNSUPPORTED);
    assert.deepStrictEqual(live.getUnsupported(), { readGridAnchors: 1, readSystemInterior: 1 });
    const { parseArgs } = require("../../tools/liveSim/args");
    assert.strictEqual(parseArgs([]).opts.statics, true);
    assert.strictEqual(parseArgs(["--no-statics"]).opts.statics, false);
  });
};
