"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { readLocalResourcesFrom } = require("../../lib/adapter/localResources");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { probeModules } = require("../../lib/adapter/probe");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const LR = "localResources";
const FAMILIES = ["Veldspar", "Scordite", "Crokite", "Dark Ochre", "Gneiss", "Omber", "Kernite", "Bistot"];

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function exportBlock(source) {
  const start = source.search(/^module\.exports = \{/m);
  assert.ok(start >= 0, "module.exports block");
  const rest = source.slice(start);
  return rest.slice(0, rest.search(/^\};/m));
}

function makeMods({ belts = { 1: 3, 2: 0, 3: 1 }, enriched = true, raw = true, ice = true, anomaly = true } = {}) {
  const calls = { belts: 0, pool: 0, raw: 0, ice: 0, tier: 0, catalog: 0 };
  const pools = {
    1: [{ typeID: 1230, name: "Veldspar", familyName: "Veldspar", spawnWeight: 1 },
      { typeID: 17470, name: "Concentrated Veldspar", enriched: true },
      { typeID: 11396, name: "Mercoxit" }, { typeID: 1230, name: "dup" }, { typeID: -1 }, { typeID: "x" }],
    3: [{ typeID: 1228, name: "S".repeat(80) }],
  };
  const iceRows = { 1: Object.freeze({ iceTypeIDs: Object.freeze([16262]), iceTypeNames: Object.freeze(["Clear Icicle"]),
    sourceDungeonID: 9 }) };
  const catalog = {
    lowsec_0_1_to_0_4: [{ sourceDungeonID: 1, templateID: "client-dungeon:1", expectedName: "Small Crokite, Dark Ochre and Gneiss Deposit" }],
    highsec_0_5_to_0_8: [{ sourceDungeonID: 2, templateID: "client-dungeon:2", expectedName: "Small Kernite and Omber Deposit" }],
  };
  const mods = {
    asteroidData: { getBeltsForSystem(id) { calls.belts += 1; return Array.from({ length: belts[id] || 0 }, (_, i) => ({ itemID: i })); } },
    asteroidService: { handleSceneCreated() {}, _testing: enriched ? {
      buildEnrichedSystemOrePool(id) { calls.pool += 1; return { orePool: pools[id] || [], securityClass: "C", securityStatus: 0.5 }; },
    } : { buildSystemOrePool() {} } },
    miningVisuals: raw ? { getSolarSystemOreTypeRecords(id) { calls.raw += 1; return (pools[id] || []).map((r) => ({ ...r })); } } : {},
    iceAuthority: ice ? { getIceSystemAuthorityRow(id) {
      calls.ice += 1;
      if (ice === "throw") throw new Error("Synthetic nullsec ice authority system not found");
      return iceRows[id] || null;
    } } : {},
    anomalyAuthority: anomaly ? {
      resolveSecurityTierForSystemID(id) {
        calls.tier += 1;
        if (anomaly === "throw") throw new Error("tier boom");
        return id === 1 ? "highsec_0_5_to_0_8" : "lowsec_0_1_to_0_4";
      },
      listCatalogEntries(tier) { calls.catalog += 1; return (catalog[tier] || []).map((e) => ({ ...e })); },
    } : {},
  };
  return { mods, calls };
}

module.exports = ({ test }) => {
  test("LS1 tiers-2 readLocalResourcesFrom: ENRICHED/RAW/DRIFT, belts 0 -> NONE, ice, anomaly memo, FAILED, fields", () => {
    const { mods, calls } = makeMods();
    const r = readLocalResourcesFrom(mods, [1, 2, 3, 1], FAMILIES);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.drift, []);
    assert.deepStrictEqual(r.issues, []);
    assert.deepStrictEqual([...r.systems.keys()], [1, 2, 3], "duplicates skipped");
    const s1 = r.systems.get(1);
    assert.deepStrictEqual(Object.keys(s1), ["systemId", "beltCount", "poolSource", "ores", "ice", "anomaly"]);
    assert.strictEqual(s1.beltCount, 3);
    assert.strictEqual(s1.poolSource, "ENRICHED");
    assert.deepStrictEqual(s1.ores, [{ typeId: 1230, name: "Veldspar" }, { typeId: 11396, name: "Mercoxit" },
      { typeId: 17470, name: "Concentrated Veldspar" }], "unique positive ids, sorted, only typeId + name");
    assert.deepStrictEqual(s1.ice, { typeIds: [16262], names: ["Clear Icicle"] });
    assert.deepStrictEqual(s1.anomaly, { tier: "highsec_0_5_to_0_8", families: ["Kernite", "Omber"] });
    assert.deepStrictEqual(r.systems.get(2).ores, []);
    assert.strictEqual(r.systems.get(2).poolSource, "NONE");
    assert.deepStrictEqual(r.systems.get(2).ice, { typeIds: [], names: [] }, "row null -> empty");
    assert.strictEqual(calls.pool, 2, "pool only for systems with belts");
    assert.strictEqual(r.systems.get(3).ores[0].name.length, 64);
    assert.strictEqual(calls.catalog, 2);
    assert.deepStrictEqual(r.systems.get(3).anomaly.families, ["Crokite", "Dark Ochre", "Gneiss"]);

    const rawRead = readLocalResourcesFrom(makeMods({ enriched: false }).mods, [1], FAMILIES);
    assert.strictEqual(rawRead.ok, true);
    assert.strictEqual(rawRead.systems.get(1).poolSource, "RAW");
    assert.deepStrictEqual(rawRead.drift, ["asteroidService._testing.buildEnrichedSystemOrePool"]);
    assert.deepStrictEqual(rawRead.systems.get(1).ores.map((o) => o.typeId), [1230, 11396, 17470]);
    const none = readLocalResourcesFrom(makeMods({ enriched: false, raw: false }).mods, [1], FAMILIES);
    assert.strictEqual(none.ok, false);
    assert.strictEqual(none.reason, "LOCAL_RESOURCES_DRIFT");
    const noBelts = readLocalResourcesFrom({ ...mods, asteroidData: null }, [1], FAMILIES);
    assert.deepStrictEqual(noBelts, { ok: false, reason: "LOCAL_RESOURCES_DRIFT", detail: "asteroidData.getBeltsForSystem" });
    const partial = readLocalResourcesFrom(makeMods({ ice: false, anomaly: false }).mods, [1], FAMILIES);
    assert.strictEqual(partial.ok, true);
    assert.strictEqual(partial.systems.get(1).ice, null);
    assert.strictEqual(partial.systems.get(1).anomaly, null);
    assert.deepStrictEqual(partial.drift, ["iceSystemAuthority.getIceSystemAuthorityRow",
      "oreAnomalySecurityAuthority.resolveSecurityTierForSystemID", "oreAnomalySecurityAuthority.listCatalogEntries"]);
    const throwing = readLocalResourcesFrom(makeMods({ ice: "throw", anomaly: "throw" }).mods, [1, 3], FAMILIES);
    assert.strictEqual(throwing.ok, true);
    assert.strictEqual(throwing.systems.get(1).ice, null);
    assert.strictEqual(throwing.systems.get(1).anomaly, null);
    assert.strictEqual(throwing.systems.get(1).ores.length, 3, "ores still read");
    assert.deepStrictEqual(throwing.issues.map((i) => [i.source, i.systemId]), [["ice", 1], ["anomaly", 1], ["ice", 3], ["anomaly", 3]]);
    const boom = makeMods();
    boom.mods.asteroidService._testing.buildEnrichedSystemOrePool = () => { throw new Error("x".repeat(500)); };
    const failed = readLocalResourcesFrom(boom.mods, [1], FAMILIES);
    assert.strictEqual(failed.reason, "LOCAL_RESOURCES_FAILED");
    assert.ok(failed.detail.startsWith("pool:1: ") && failed.detail.length <= 200);
    const shape = makeMods();
    shape.mods.asteroidService._testing.buildEnrichedSystemOrePool = () => ({ pool: [] });
    assert.strictEqual(readLocalResourcesFrom(shape.mods, [1], FAMILIES).detail, "pool:1: orePool shape");
    const many = Array.from({ length: 257 }, (_, i) => i + 1);
    assert.deepStrictEqual(readLocalResourcesFrom(mods, many, FAMILIES),
      { ok: false, reason: "LOCAL_RESOURCES_FAILED", detail: "systemIds" });
    for (const bad of [[], null, [0], [1.5], ["1"]]) {
      assert.strictEqual(readLocalResourcesFrom(mods, bad, FAMILIES).detail, "systemIds", JSON.stringify(bad));
    }
  });

  test("LS2 tiers-2 vendor facts, GAME_MODULES entries of localResources, probe DRIFT, adapter surface", () => {
    const service = readSource("space/asteroids/asteroidService.js");
    const block = exportBlock(service);
    const testingAt = block.indexOf("_testing: {");
    assert.ok(testingAt > 0, "asteroidService exports _testing");
    assert.match(block.slice(testingAt), /^ {4}buildEnrichedSystemOrePool,$/m);
    assert.match(functionBody(service, "buildEnrichedSystemOrePool"), /return \{\n\s*orePool,/);
    assert.match(exportBlock(readSource("services/mining/miningVisuals.js")), /^ {2}getSolarSystemOreTypeRecords,$/m);
    const ice = readSource("services/mining/iceSystemAuthority.js");
    assert.match(exportBlock(ice), /^ {2}getIceSystemAuthorityRow,$/m);
    assert.ok(ice.includes("iceTypeIDs:") && ice.includes("iceTypeNames:"));
    const anomaly = readSource("services/mining/oreAnomalySecurityAuthority.js");
    const anomalyBlock = exportBlock(anomaly);
    assert.match(anomalyBlock, /^ {2}resolveSecurityTierForSystemID,$/m);
    assert.match(anomalyBlock, /^ {2}listCatalogEntries,$/m);
    assert.ok(anomaly.includes("expectedName"));

    assert.ok(!MODULE_NAMES.includes(LR), "localResources is not a module name");
    const expected = {
      "space/asteroids/asteroidData": ["getBeltsForSystem"],
      "space/asteroids/asteroidService": ["_testing"],
      "services/mining/miningVisuals": ["getSolarSystemOreTypeRecords"],
      "services/mining/iceSystemAuthority": ["getIceSystemAuthorityRow"],
      "services/mining/oreAnomalySecurityAuthority": ["resolveSecurityTierForSystemID", "listCatalogEntries"],
    };
    for (const [p, names] of Object.entries(expected)) {
      const entry = GAME_MODULES.find((e) => e.path === p);
      assert.ok(entry, p);
      for (const name of names) {
        const s = entry.symbols.find((x) => x.name === name);
        assert.ok(s && s.kind === "export" && s.consumers.includes(LR), `${p}.${name}`);
        assert.ok(s.wrap !== true && s.firstLoad !== true, `${p}.${name} not wrapped`);
      }
    }
    assert.strictEqual(GAME_MODULES.find((e) => e.path === "space/asteroids/asteroidService").symbols[0].valueType, "object");
    const users = GAME_MODULES.filter((e) => e.symbols.some((s) => s.consumers.includes(LR))).map((e) => e.path);
    assert.deepStrictEqual(users.sort(), Object.keys(expected).sort());

    const entry = GAME_MODULES.find((e) => e.path === "services/mining/iceSystemAuthority");
    const report = probeModules([entry], { load: () => ({ ok: true, exports: { listIceSystemIDs() {} } }) });
    assert.strictEqual(report.modules[0].status, "DRIFT");
    assert.ok(!Object.prototype.hasOwnProperty.call(report.disabledModules, "trade"));
    for (const name of Object.keys(report.disabledModules)) assert.ok(!MODULE_NAMES.includes(name), name);

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof blind.readLocalResources, "function");
    assert.deepStrictEqual(blind.readLocalResources([30000142], FAMILIES),
      { ok: false, reason: "LOCAL_RESOURCES_DRIFT", detail: "asteroidData.getBeltsForSystem" });
  });
};
