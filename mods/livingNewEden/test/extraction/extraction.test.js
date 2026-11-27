"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DATA = require("../../lib/economy/data/commodities");
const { createCommodityCatalog } = require("../../lib/economy/extraction/catalog");
const { systemYield } = require("../../lib/economy/extraction/yield");
const { TIER_WEIGHTS } = require("../../lib/economy/extraction/data/tierWeights");
const { readSystemCelestialsFrom, readPlanetResourcesFrom } = require("../../lib/adapter/celestials");
const { buildCommodityCatalog } = require("../../tools/extraction/buildCommodityCatalog");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const P0S = Object.keys(DATA.P1_OF_P0).map(Number).sort((a, b) => a - b);
const PLANET_TYPE = 11;

const clone = (v) => JSON.parse(JSON.stringify(v));
const vendorText = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");

function params(over = {}) {
  const e = BASE.extraction;
  return { maxMoonsPerSystem: e.maxMoonsPerSystem, maxPlanetsPerSystem: e.maxPlanetsPerSystem,
    moonPortionsPerMoonPerPeriod: e.moonPortionsPerMoonPerPeriod,
    piP1UnitsPerPlanetPerPeriod: e.piP1UnitsPerPlanetPerPeriod,
    bandPermille: { highsec: e.highsecYieldPermille, lowsec: e.lowsecYieldPermille, nullsec: e.nullsecYieldPermille },
    tierWeights: TIER_WEIGHTS, ...over };
}

const moonsFrom = (first, n) => Array.from({ length: n }, (_, i) => first + i);

module.exports = ({ test, skip }) => {
  const built = createCommodityCatalog(DATA);
  const catalog = built.ok ? built.catalog : null;
  const facts = { p0ByPlanetType: new Map([[PLANET_TYPE, P0S.slice(0, 5)]]) };

  test("XC1 commodities: 5 tiers with ores, material tiers, PI tier rule, P1_OF_P0, one fuel PI set, refusals", () => {
    assert.ok(built.ok, JSON.stringify(built));
    assert.ok(typeof DATA.SOURCE.sourceHash === "string" && DATA.SOURCE.sourceHash.length === 64);
    assert.deepStrictEqual(DATA.MOON_TIERS, ["r4", "r8", "r16", "r32", "r64"]);
    for (const tier of DATA.MOON_TIERS) assert.ok(catalog.oresOfTier(tier).length >= 1, tier);
    for (const ore of Object.values(DATA.MOON_ORES)) {
      for (const m of Object.keys(ore.materials)) {
        assert.ok(DATA.MOON_TIERS.includes(DATA.MOON_MATERIAL_TIER[m]), `material ${m}`);
        assert.strictEqual(catalog.kindOf(Number(m)), "moon");
      }
    }
    for (const [out, , , inputs] of DATA.SCHEMATICS) {
      assert.strictEqual(DATA.PI_TIER[out], 1 + Math.max(...inputs.map(([i]) => DATA.PI_TIER[i])), `schematic ${out}`);
    }
    assert.deepStrictEqual([0, 1, 2, 3, 4].map((t) => Object.values(DATA.PI_TIER).filter((x) => x === t).length > 0),
      [true, true, true, true, true]);
    for (const [p0, p1] of Object.entries(DATA.P1_OF_P0)) {
      assert.ok(catalog.schematicFor(p1), `P1 ${p1} of ${p0}`);
      assert.strictEqual(catalog.p1OfP0(Number(p0)), p1);
    }
    const piSets = Object.values(DATA.FUEL_BLOCKS).map((b) => JSON.stringify(b.pi));
    assert.ok(piSets.length === 4 && new Set(piSets).size === 1, "the 4 fuel blocks share one PI input");
    assert.ok(catalog.fuelPiPerBlock().every(([id, q, batch]) => catalog.kindOf(id) === "pi" && q > 0 && batch === 40));
    assert.strictEqual(catalog.kindOf(34), null);

    const cyclic = clone(DATA);
    const p0 = P0S[0];
    cyclic.SCHEMATICS.push([p0, 1, 60, [[DATA.P1_OF_P0[String(p0)], 1]]]);
    const c = createCommodityCatalog(cyclic);
    assert.deepStrictEqual([c.ok, c.reason], [false, "CATALOG_INVALID"]);
    assert.match(c.detail, /cycle/);
    const noSource = clone(DATA);
    delete noSource.SOURCE;
    assert.deepStrictEqual(createCommodityCatalog(noSource),
      { ok: false, reason: "CATALOG_INVALID", detail: "SOURCE" });

    const dogma = new Map();
    const typeMaterials = new Map();
    for (const [i, id] of [101, 102, 103, 104].entries()) {
      dogma.set(id, { 790: 900 + i, 2711: id, 2699: 1, 2727: 5000 });
      typeMaterials.set(id, [{ typeId: 500 + i, quantity: 10 }]);
    }
    const refused = buildCommodityCatalog({ sde: { buildNumber: 1, releaseDate: "x" }, dogma, typeMaterials,
      schematics: [], blueprints: new Map() });
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "MOON_TIERS_MISMATCH"]);
  });

  test("XC2 systemYield: deterministic, wormhole empty, moon cap, band scaling, integers, r64 nullsec only", () => {
    const planets = [{ planetId: 40000102, typeId: PLANET_TYPE }, { planetId: 40000101, typeId: PLANET_TYPE },
      { planetId: 40000103, typeId: 99999 }];
    const sys = { systemId: 30000001, secClass: "nullsec", moons: moonsFrom(40000001, 12), planets };
    const a = systemYield(sys, catalog, facts, params());
    assert.ok(a.ok, JSON.stringify(a));
    assert.deepStrictEqual(systemYield(sys, catalog, facts, params()), a);
    assert.deepStrictEqual([a.moonsUsed, a.planetsUsed], [8, 3]);
    assert.ok(Object.keys(a.moon).length > 0 && Object.keys(a.pi).length > 0);
    for (const v of [...Object.values(a.moon), ...Object.values(a.pi)]) assert.ok(Number.isSafeInteger(v) && v >= 1);
    for (const k of Object.keys(a.pi)) assert.strictEqual(catalog.piTierOf(Number(k.slice(5))), 1, k);

    assert.deepStrictEqual(systemYield({ ...sys, secClass: "wormhole" }, catalog, facts, params()),
      { ok: true, moon: {}, pi: {}, moonsUsed: 0, planetsUsed: 0 });
    const capped = systemYield(sys, catalog, facts, params({ maxMoonsPerSystem: 2 }));
    assert.strictEqual(capped.moonsUsed, 2);
    assert.deepStrictEqual(capped.moon, systemYield({ ...sys, moons: sys.moons.slice(0, 2) }, catalog, facts,
      params()).moon);
    const doubled = systemYield(sys, catalog, facts, params({ bandPermille: { highsec: 500, lowsec: 800,
      nullsec: 2000 } }));
    for (const [k, v] of Object.entries(a.moon)) assert.strictEqual(doubled.moon[k], 2 * v, k);
    for (const [k, v] of Object.entries(a.pi)) assert.strictEqual(doubled.pi[k], 2 * v, k);
    assert.strictEqual(systemYield({ ...sys, moons: [0] }, catalog, facts, params()).reason, "INVALID_INPUT");

    const tiersOf = (secClass) => {
      const r = systemYield({ systemId: 30000002, secClass, moons: moonsFrom(40100001, 200), planets: [] }, catalog,
        facts, params({ maxMoonsPerSystem: 200 }));
      assert.ok(r.ok, JSON.stringify(r));
      return new Set(Object.keys(r.moon).map((k) => DATA.MOON_MATERIAL_TIER[k.slice(5)]));
    };
    assert.ok(tiersOf("nullsec").has("r64"), "nullsec: r64 on 200 moons");
    const high = tiersOf("highsec");
    assert.ok(!high.has("r64") && !high.has("r32"), `highsec tiers ${[...high]}`);
  });

  test("XC4 adapter celestials / planet P0: moons, planets, skip without typeID, throwing getter, P0 filter; vendor "
    + "facts", () => {
    const rows = { 30000001: [{ itemID: 40000002, groupID: 8 }, { itemID: 40000001, kind: "moon" },
      { itemID: 40000004, groupName: "Planet", typeID: 2016 }, { itemID: 40000003, kind: "planet", typeID: 11 },
      { itemID: 40000005, kind: "planet" }, { itemID: 40000006, groupID: 6, typeID: 45031 }] };
    const worldData = { getCelestialsForSystem: (id) => rows[id] || [] };
    const r = readSystemCelestialsFrom(worldData, [30000001, 30000009], { maxSystems: 1 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.truncated, true);
    assert.deepStrictEqual(r.systems.get(30000001), { moons: [40000001, 40000002],
      planets: [{ planetId: 40000003, typeId: 11 }, { planetId: 40000004, typeId: 2016 }] });
    const throwing = Object.defineProperty({}, "getCelestialsForSystem", { get() { throw new Error("boom"); } });
    assert.deepStrictEqual(readSystemCelestialsFrom(throwing, [30000001], { maxSystems: 1 }),
      { ok: false, reason: "CELESTIALS_UNAVAILABLE", detail: "boom" });
    const failing = { getCelestialsForSystem: () => { throw new Error("rows"); } };
    assert.strictEqual(readSystemCelestialsFrom(failing, [30000001], { maxSystems: 1 }).reason,
      "CELESTIALS_UNAVAILABLE");
    assert.strictEqual(readSystemCelestialsFrom(null, [30000001], { maxSystems: 1 }).reason, "CELESTIALS_UNAVAILABLE");

    const psd = { getPlanetResourceTypeIDs: (t) => (t === 11 ? [2287, "2073", 0, -1, 2287, 2073.5] : []) };
    const p = readPlanetResourcesFrom(psd, [11, 2016, 11]);
    assert.ok(p.ok, JSON.stringify(p));
    assert.deepStrictEqual([...p.byType], [[11, [2073, 2287]], [2016, []]]);
    assert.strictEqual(readPlanetResourcesFrom({}, [11]).reason, "PLANET_DATA_UNAVAILABLE");
    assert.strictEqual(readPlanetResourcesFrom(psd, moonsFrom(1, 17)).reason, "PLANET_DATA_UNAVAILABLE");

    assert.ok(vendorText("services/planet/planetMgrService.js")
      .includes('row.kind !== "planet" && row.groupName !== "Planet"'));
    assert.ok(vendorText("services/starbase/starbaseAnchoringPolicy.js").includes('celestial.kind === "moon"'));
    const exported = (rel, fn, arg) => new RegExp(`\\nfunction ${fn}\\(${arg}\\) \\{[\\s\\S]*`
      + `\\nmodule\\.exports = \\{[^}]*\\n {2}${fn},`).test(vendorText(rel));
    assert.ok(exported("services/planet/planetStaticData.js", "getPlanetResourceTypeIDs", "planetTypeID"));
    assert.ok(exported("space/worldData.js", "getCelestialsForSystem", "solarSystemID"));
  });

  test("XC5 config extraction.*: defaults, clamp, enabled false", () => {
    assert.deepStrictEqual(BASE.extraction, { enabled: false, maxMoonsPerSystem: 8, maxPlanetsPerSystem: 6,
      moonPortionsPerMoonPerPeriod: 5, piP1UnitsPerPlanetPerPeriod: 60, highsecYieldPermille: 500,
      lowsecYieldPermille: 800, nullsecYieldPermille: 1000,
      periodMs: 21600000, pulseIntervalMs: 300000, maxFactionsPerPulse: 4, maxMarkerChecksPerPulse: 64,
      maxSystemsPerFaction: 64, maxStationsPerFaction: 16, maxDeliveryJumps: 5, claimedYieldPermille: 500,
      maxCachedSystems: 4096, maxRowsPerPulse: 1000, markerRetentionMs: 604800000,
      fuelEnabled: false, fuelBlocksPerUpwellPerPeriod: 60, unfueledLinesPermille: 500, fuelReservePeriods: 4,
      maxConversionsPerFaction: 8, maxNeedsPerFaction: 32, advancedReserveRuns: 2,
      advancedReserveGroups: "battleship",
      upwellTransferEnabled: false, maxTransfersPerFaction: 4, maxTransferTypesPerPair: 8 });
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_EXTRACTION_MAX_MOONS_PER_SYSTEM: "999",
      EVEJS_LNE_EXTRACTION_MAX_PLANETS_PER_SYSTEM: "-3", EVEJS_LNE_EXTRACTION_NULLSEC_YIELD_PERMILLE: "5000",
      EVEJS_LNE_EXTRACTION_PI_P1_UNITS_PER_PLANET_PER_PERIOD: "2000000" } });
    assert.ok(r.ok, JSON.stringify(r.errors));
    const e = r.config.extraction;
    assert.deepStrictEqual([e.maxMoonsPerSystem, e.maxPlanetsPerSystem, e.nullsecYieldPermille,
      e.piP1UnitsPerPlanetPerPeriod, e.enabled], [64, 0, 2000, 1000000, false]);
  });

  const { loadDriver, withStore } = require("../notices/storeHelper");
  const driver = loadDriver();
  if (!driver.ok) {
    skip("XC3 station stock kinds moon / pi", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("XC3 station stock: moon / pi with type:<id> ok, group / unit keys INVALID_INPUT", () => {
    const { createJournal } = require("../../lib/persistence/journal");
    const { createStationRepository } = require("../../lib/stations/stationRepository");
    const { HULL_GROUPS } = require("../../lib/fleets/schema");
    const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
    withStore(driver, ({ store }) => {
      const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
      const repo = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
        limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
          maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
      const r = store.transaction("xc3", (tx) => {
        const st = repo.createStation(tx, { stationId: "st:xc3", kind: "upwell", structureFamily: "astrahus",
          systemId: 30000142, ownerFactionId: 500010, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "xc3:st");
        assert.ok(st.ok, JSON.stringify(st));
        const change = (key, itemKind, itemKey) => repo.applyStockChange(tx, { stationId: "st:xc3", key, reason: "xc3",
          at: NOW, deltas: [{ itemKind, itemKey, delta: 7 }] });
        const ok = change("xc3:ok", "moon", "type:16633");
        assert.ok(ok.ok, JSON.stringify(ok));
        assert.ok(change("xc3:pi", "pi", "type:2393").ok);
        assert.strictEqual(change("xc3:bad1", "moon", "group:frigate").reason, "INVALID_INPUT");
        assert.strictEqual(change("xc3:bad2", "pi", "unit:x").reason, "INVALID_INPUT");
        return repo.getStock(tx, "st:xc3").items.map((i) => [i.itemKind, i.itemKey, i.quantity]);
      });
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(r.value, [["moon", "type:16633", 7], ["pi", "type:2393", 7]]);
    });
  });
};
