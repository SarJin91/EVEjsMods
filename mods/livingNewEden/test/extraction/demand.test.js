"use strict";

const assert = require("node:assert");
const path = require("node:path");

const DATA = require("../../lib/economy/data/commodities");
const { createCommodityCatalog } = require("../../lib/economy/extraction/catalog");
const { TIER_WEIGHTS } = require("../../lib/economy/extraction/data/tierWeights");
const { createExtractionService } = require("../../lib/economy/extraction/extractionService");
const XS = require("../../lib/economy/extraction/schema");
const ES = require("../../lib/economy/schema");
const { createProductionService } = require("../../lib/economy/production/productionService");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { affordableRuns } = require("../../lib/strategy/ai/production");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { buildCommodityCatalog } = require("../../tools/extraction/buildCommodityCatalog");
const { buildAdvancedBills } = require("../../tools/extraction/buildAdvancedBills");
const { resolveConfig } = require("../../config");
const RR = require("../../lib/strategy/reviewRows");
const { rowBoundsOfConfig, advancedStartRowsOfConfig, maxAdvancedDeltasOf } = require("../../lib/strategy/reviewBound");
const { MINERALS } = require("../../lib/economy/data/mineralYield");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const CATALOG = createCommodityCatalog(DATA).catalog;
const PERIOD = BASE.extraction.periodMs;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const B0 = Math.floor((T0 + 1000) / PERIOD);
const F1 = 500001;
const CHAIN = Array.from({ length: 6 }, (_, i) => 1001 + i);

function cfgOf({ x = {}, p = {}, st = {} } = {}) {
  return { extraction: { ...BASE.extraction, enabled: true, ...x },
    production: { ...BASE.production, linesPerUpwellStation: 2, ...p }, stations: { ...BASE.stations, ...st },
    modules: BASE.modules };
}

const graph = { getNeighbors: (id) => CHAIN.filter((x) => Math.abs(x - id) === 1),
  getSystem: (id) => (CHAIN.includes(id) ? { systemId: id, secClass: "nullsec" } : null) };
const adapter = { readSystemCelestials: (ids) => ({ ok: true, systems: new Map(ids.map((id) => [id,
  { moons: [id * 100 + 1], planets: [] }])) }), readPlanetResources: (t) => ({ ok: true, byType: new Map(t.map((x) => [x, []])) }) };

const fuelRows = (n) => CATALOG.fuelPerPeriod(BASE.extraction.fuelBlocksPerUpwellPerPeriod)
  .map(([t, q]) => ["pi", `type:${t}`, q * n]);
const mineralRows = (group, runs) => Object.entries(RECIPES.GROUPS[group].minerals).map(([k, v]) => ["mineral", k, v * runs]);
const billRows = (kind, group, scale = (n) => n) => CATALOG.advancedBillOf(group)[kind]
  .map(([t, n]) => [kind, `type:${t}`, scale(n)]).filter((r) => r[2] > 0);

module.exports = ({ test, skip }) => {
  test("AB1 data and tool: generator 2, ADVANCED_BILLS of HULL_GROUPS, builder fixture (reaction, fuel, cycle, depth)", () => {
    assert.strictEqual(DATA.SOURCE.generator, 2);
    assert.deepStrictEqual(Object.keys(DATA.ADVANCED_BILLS).sort(), [...HULL_GROUPS].sort());
    for (const [g, bill] of Object.entries(DATA.ADVANCED_BILLS)) {
      for (const k of Object.keys(bill.moon)) assert.ok(DATA.MOON_MATERIAL_TIER[k.slice(5)], `${g} moon ${k}`);
      for (const k of Object.keys(bill.pi)) assert.ok(DATA.PI_TIER[k.slice(5)] >= 1, `${g} pi ${k}`);
    }
    for (const g of ["carrier", "dreadnought"]) assert.ok(Object.keys(DATA.ADVANCED_BILLS[g].pi).length > 0, g);
    assert.ok(["logistics", "ewar", "tackle"].some((g) => Object.keys(DATA.ADVANCED_BILLS[g].moon).length > 0));
    assert.ok(createCommodityCatalog(DATA).ok);
    assert.ok(CATALOG.maxSchematicDeltas === 4 && CATALOG.advancedBillOf("nope").pi.length === 0);

    const dogma = new Map();
    const typeMaterials = new Map();
    for (let i = 0; i < 5; i += 1) {
      dogma.set(101 + i, { 790: 900 + i, 2711: 101 + i, 2699: 1, 2727: 5000 });
      typeMaterials.set(101 + i, [{ typeId: 500 + i, quantity: 10 }]);
    }
    const schematics = [{ _key: 1, cycleTime: 1800, types: [{ _key: 2001, quantity: 3000, isInput: true },
      { _key: 2002, quantity: 20, isInput: false }] }];
    const bp = (materials, productQuantity = 1, blueprintTypeId = 1) => ({ blueprintTypeId,
      materials: materials.map(([typeId, quantity]) => ({ typeId, quantity })), productQuantity });
    const chain = [210, 211, 212, 213, 214, 215, 216, 217];
    const blueprints = new Map([[4051, bp([[2002, 4]], 40, 4052)],
      [900, bp([[200, 15], [34, 1000], [4051, 10], [202, 1], [999, 1], [210, 1]])], [202, bp([[203, 1]])],
      [203, bp([[202, 1]])], ...chain.slice(0, -1).map((id, i) => [id, bp([[chain[i + 1], 1]])])]);
    const reactions = new Map([[200, bp([[500, 100], [501, 100]], 200, 800)]]);
    const inputs = { sde: { buildNumber: 1, releaseDate: "x" }, dogma, typeMaterials, schematics, blueprints,
      fuelBlockTypeIds: [4051] };
    const plain = buildCommodityCatalog(inputs);
    assert.ok(plain.ok, JSON.stringify(plain));
    assert.deepStrictEqual(plain.data.ADVANCED_BILLS, {});
    const full = { ...inputs, reactions, representatives: [["g1", 900]], recipeHashes: { hull: "h", capital: "c",
      industry: "i" } };
    const a = buildCommodityCatalog(full);
    const b = buildCommodityCatalog(full);
    assert.ok(a.ok, JSON.stringify(a));
    assert.strictEqual(a.source, b.source);
    assert.notStrictEqual(a.data.SOURCE.sourceHash, plain.data.SOURCE.sourceHash);
    assert.deepStrictEqual(a.data.ADVANCED_BILLS, { g1: { moon: { "type:500": 8, "type:501": 8 },
      pi: { "type:2002": 1 } } });
    assert.deepStrictEqual(a.summary.advancedSkipped, [202, 216, 999]);
    assert.strictEqual(buildAdvancedBills({ representatives: [["g", 77]], blueprints, reactions, moonMaterialTier: {},
      piTier: {}, fuelBlocks: {}, maxDepth: 6 }).reason, "ADVANCED_NO_REPRESENTATIVE");
  });

  test("AB6: review bound + advanced start rows (flag off bit for bit), W204 at defaults, W203", () => {
    assert.strictEqual(RR.PRODUCTION_START_MINERALS, Object.keys(MINERALS).length, "reviewRows literal = MINERALS");
    assert.strictEqual(RR.STOCK_CHANGE_FIXED_ROWS, XS.STOCK_FIXED_ROWS, "reviewRows literal = extraction/schema");
    const maxA = Math.max(...Object.keys(DATA.ADVANCED_BILLS).map((g) => CATALOG.advancedBillOf(g).moon.length
      + CATALOG.advancedBillOf(g).pi.length));
    assert.strictEqual(maxAdvancedDeltasOf(), maxA);
    assert.deepStrictEqual([RR.advancedStartRows(37, 32), RR.advancedStartRows(37, 44), RR.advancedStartRows(37, 4),
      RR.advancedStartRows(0, 32), RR.advancedStartRows(5, undefined)], [39, 37, 37 + 2 * 10, 0, 5]);
    const env = (e) => resolveConfig({ modDir: MOD_DIR, env: e });
    const off = env({});
    const on = env({ EVEJS_LNE_PRODUCTION_ADVANCED_INPUTS_ENABLED: "1" });
    const zero = env({ EVEJS_LNE_PRODUCTION_ADVANCED_INPUTS_ENABLED: "1", EVEJS_LNE_PRODUCTION_ADVANCED_INPUTS_PERMILLE: "0" });
    const P = off.config.production;
    const starts = P.maxJobsPerReview + (P.industryEnabled === true ? P.maxIndustryJobsPerReview : 0);
    const extra = RR.advancedStartRows(maxA, off.config.stations.maxDeltasPerChange);
    assert.deepStrictEqual([advancedStartRowsOfConfig(off.config), advancedStartRowsOfConfig(on.config),
      advancedStartRowsOfConfig(zero.config)], [0, extra, 0]);
    const review = (c) => rowBoundsOfConfig(c).review;
    const { advancedInputsEnabled: _a, ...noKey } = P;
    assert.strictEqual(review(off.config), review({ ...off.config, production: noKey }));
    assert.strictEqual(review(zero.config), review(off.config), "permille 0 = no advanced inputs");
    assert.strictEqual(review(on.config) - review(off.config), extra * starts);
    const limit = off.config.persistence.maxRowsPerTransaction;
    assert.ok(review(off.config) <= limit && review(on.config) > limit, `${review(off.config)} / ${review(on.config)}`);
    const w204 = (r) => r.warnings.filter((w) => w.includes("(W204)"));
    assert.deepStrictEqual([w204(off).length, w204(on).length, w204(zero).length], [0, 1, 0]);
    assert.ok(on.warnings.some((w) => w.startsWith(`one strategy review may write ${review(on.config)} rows`)));
    const w203 = (e) => env({ EVEJS_LNE_EXTRACTION_ENABLED: "1", ...e }).warnings.filter((w) => w.includes("(W203)"));
    const fuelTypes = CATALOG.fuelPerPeriod(BASE.extraction.fuelBlocksPerUpwellPerPeriod).length;
    const rowsAt = (conv, st) => XS.MARKER_ROWS + XS.demandRowBound({ conversions: conv,
      maxSchematicDeltas: CATALOG.maxSchematicDeltas, fuelStations: st, fuelTypes });
    assert.ok(rowsAt(BASE.extraction.maxConversionsPerFaction, BASE.extraction.maxStationsPerFaction) <= 998, "defaults fit");
    assert.deepStrictEqual([w203({ EVEJS_LNE_EXTRACTION_FUEL_ENABLED: "1" }).length,
      w203({ EVEJS_LNE_EXTRACTION_FUEL_ENABLED: "1", EVEJS_LNE_EXTRACTION_MAX_STATIONS_PER_FACTION: "256" }).length,
      w203({ EVEJS_LNE_EXTRACTION_MAX_CONVERSIONS_PER_FACTION: "256" }).length,
      w203({ EVEJS_LNE_EXTRACTION_MAX_CONVERSIONS_PER_FACTION: "256",
        EVEJS_LNE_PRODUCTION_ADVANCED_INPUTS_ENABLED: "1" }).length], [0, 1, 0, 1],
    "defaults / 256 fuel stations / no demand flag / 256 conversions with the advanced inputs");
    const big = w203({ EVEJS_LNE_EXTRACTION_FUEL_ENABLED: "1", EVEJS_LNE_EXTRACTION_MAX_STATIONS_PER_FACTION: "256" })[0];
    assert.ok(big.includes(`${rowsAt(BASE.extraction.maxConversionsPerFaction, 256)} demand rows > 998`), big);
  });

  const { loadDriver, withStore } = require("../notices/storeHelper");
  const driver = loadDriver();
  if (!driver.ok) {
    for (const id of ["AB2", "AB3", "AB4", "AB5", "AB6b"]) skip(`${id} moon/PI demand`, `driver (${driver.detail})`);
    return;
  }
  const { createJournal } = require("../../lib/persistence/journal");
  const { createStationRepository } = require("../../lib/stations/stationRepository");
  const { createJobRepository } = require("../../lib/economy/production/jobRepository");

  function rig(store, cfg, stations, controlled = []) {
    const clock = { now: () => T0 + 1000 };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const repo = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
      limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
        maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000,
        maxDeltasPerChange: cfg.stations.maxDeltasPerChange } });
    const jobs = createJobRepository({ journal, clock, hullGroups: HULL_GROUPS });
    const h = { journal, repo, jobs };
    h.tx = (fn) => {
      const r = store.transaction("ab", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    h.tx((tx) => {
      for (const [stationId, systemId] of Object.entries(stations)) {
        const r = repo.createStation(tx, { stationId, kind: "upwell", structureFamily: "astrahus", systemId,
          ownerFactionId: F1, ownerCorporationId: 1000101, origin: "seed", at: T0 }, `ab:${stationId}`);
        assert.ok(r.ok, JSON.stringify(r));
      }
      return { ok: true };
    });
    let seeds = 0;
    h.seed = (stationId, rows) => h.tx((tx) => {
      const deltas = rows.map(([itemKind, itemKey, delta]) => ({ itemKind, itemKey, delta }));
      for (let i = 0; i < deltas.length; i += cfg.stations.maxDeltasPerChange) {
        seeds += 1;
        const r = repo.applyStockChange(tx, { stationId, key: `ab:seed:${seeds}`, reason: "TEST", at: T0,
          deltas: deltas.slice(i, i + cfg.stations.maxDeltasPerChange) });
        assert.ok(r.ok, JSON.stringify(r));
      }
      return { ok: true };
    });
    h.stock = (stationId) => new Map(h.tx((tx) => repo.getStock(tx, stationId)).items
      .map((i) => [`${i.itemKind}|${i.itemKey}`, i.quantity]));
    h.found = (key) => h.tx((tx) => journal.findByKey(tx, key)).found === true;
    h.journalRows = () => h.tx((tx) => tx.prepare("SELECT COUNT(*) AS n FROM world_event_journal").get().n);
    h.facade = (repository = repo) => ({ getMode: () => "ready", repository });
    let ids = 0;
    h.production = (c, extra = {}) => createProductionService({ store, jobs, scheduler: { enqueue: () => ({ ok: true }) },
      getStations: () => h.facade(extra.repository), clock, ids: { next: (p) => `${p}${(ids += 1)}` }, config: c,
      recipes: createRecipeTable(RECIPES, recipeParamsOf(c.production)), getExtraction: extra.getExtraction,
      commodities: c.production.advancedInputsEnabled ? CATALOG : null });
    h.extraction = (c, extra = {}) => createExtractionService({ store, journal, scheduler: { enqueue: () => ({ ok: true }) },
      clock, config: c, catalog: CATALOG, tierWeights: TIER_WEIGHTS, adapter, rowsCap: extra.rowsCap || 998,
      nowMs: () => 0, getRegistry: () => ({ listActiveFactions: () => [{ factionId: F1 }] }),
      getWorld: () => ({ listControlledByFaction: () => ({ ok: true, systems: controlled.map((systemId) => ({ systemId,
        occupierFactionId: null })), nextAfterSystemId: null }) }),
      getStations: () => h.facade(extra.repository), getGraph: () => graph, getProduction: extra.getProduction });
    h.pulse = (svc, at) => {
      const res = svc.pulseHandler({}, { now: at, anchorAt: at });
      const r = store.transaction("ab.pulse", (tx) => {
        const before = tx.prepare("SELECT total_changes() AS n").get().n;
        const v = res.effect(tx);
        v.rows = tx.prepare("SELECT total_changes() AS n").get().n - before;
        return v;
      });
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      res.onCommitted(r.value);
      return r.value;
    };
    h.start = (pr, stationId, hullGroup, ik, at = T0 + 1000) => h.tx((tx) => pr.startJobInTx(tx,
      { factionId: F1, stationId, hullGroup, runs: 1, at }, ik));
    return h;
  }

  test("AB2 production: optional takes the stock, required refuses pi, chunks consume:<i> roll back, affordableRuns", () => {
    withStore(driver, ({ store }) => {
      const opt = cfgOf({ p: { advancedInputsEnabled: true } });
      const h = rig(store, opt, { "up-o": 1001, "up-r": 1001 });
      h.seed("up-o", [...mineralRows("cruiser", 1), ...billRows("moon", "cruiser", (n) => Math.floor(n / 2)),
        ...billRows("pi", "cruiser", (n) => Math.floor(n / 2))]);
      const need = [...CATALOG.advancedBillOf("cruiser").moon, ...CATALOG.advancedBillOf("cruiser").pi];
      const r = h.start(h.production(opt), "up-o", "cruiser", "ab2:o");
      assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
      assert.strictEqual(r.advancedShort, need.reduce((s, [, n]) => s + n - Math.floor(n / 2), 0));
      assert.strictEqual(r.advanced, need.reduce((s, [, n]) => s + Math.floor(n / 2), 0));
      assert.ok(r.advancedShort > 0 && h.tx((tx) => h.jobs.getJob(tx, r.jobId)).job.state === "ACTIVE");
      assert.deepStrictEqual([...h.stock("up-o").keys()], []);

      const req = cfgOf({ p: { advancedInputsEnabled: true, advancedInputsMode: "required" } });
      h.seed("up-r", [...mineralRows("cruiser", 1), ...billRows("moon", "cruiser")]);
      const before = [h.stock("up-r"), h.journalRows()];
      const refused = h.start(h.production(req), "up-r", "cruiser", "ab2:r");
      assert.deepStrictEqual([refused.ok, refused.reason, refused.itemKind], [false, "INSUFFICIENT_STOCK", "pi"]);
      assert.deepStrictEqual([h.stock("up-r"), h.journalRows()], before);
    });
    withStore(driver, ({ store }) => {
      const c = cfgOf({ p: { advancedInputsEnabled: true, advancedInputsMode: "required" }, st: { maxDeltasPerChange: 4 } });
      const h = rig(store, c, { "up-c": 1001 });
      h.seed("up-c", [...mineralRows("cruiser", 2), ...billRows("moon", "cruiser", (n) => 2 * n),
        ...billRows("pi", "cruiser", (n) => 2 * n)]);
      const stock = h.stock("up-c");
      const flaky = { ...h.repo, applyStockChange: (tx, ch) => (ch.key.endsWith(":consume:1")
        ? { ok: false, reason: "VERSION_CONFLICT" } : h.repo.applyStockChange(tx, ch)) };
      const bad = h.start(h.production(c, { repository: flaky }), "up-c", "cruiser", "ab2:c1");
      assert.deepStrictEqual([bad.ok, bad.reason, bad.stage], [false, "VERSION_CONFLICT", "consume"]);
      assert.deepStrictEqual(h.stock("up-c"), stock);
      const pr = h.production(c);
      const ok = h.start(pr, "up-c", "cruiser", "ab2:c2");
      assert.ok(ok.ok, JSON.stringify(ok));
      assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((i) => h.found(i === 0 ? ES.consumeKey(ok.jobId)
        : ES.consumeChunkKey(ok.jobId, i))), [true, true, true, true, true, false]);
      assert.strictEqual(h.found(ES.consumeKey(bad.jobId || "pj1")), false);
      assert.strictEqual(ok.advancedShort, undefined);
      const recipe = { minerals: { "type:34": 10 }, advanced: { "type:2312": 4 } };
      assert.strictEqual(affordableRuns({ "type:34": 100 }, recipe), 10);
      assert.strictEqual(affordableRuns({ "type:34": 100 }, recipe, { "type:2312": 9 }), 2);
      assert.strictEqual(affordableRuns({ "type:34": 100 }, { minerals: recipe.minerals }, { "type:2312": 0 }), 10);
    });
  });

  test("AB3 fuel: burn fuel:<s>:<b> once per bucket, empty Upwell unfueled -> 1 line, fuelled in b and b+1", () => {
    withStore(driver, ({ store }) => {
      const c = cfgOf({ x: { fuelEnabled: true } });
      const h = rig(store, c, { "up-e": 1003, "up-f": 1001 });
      h.seed("up-f", fuelRows(5));
      h.seed("up-e", mineralRows("frigate", 2));
      const svc = h.extraction(c);
      const v = h.pulse(svc, T0 + 1000);
      assert.deepStrictEqual([v.tally.fuelBurned, v.tally.unfueled, v.tally.conversions], [1, 1, 0]);
      assert.deepStrictEqual([h.found(XS.fuelKey("up-f", B0)), h.found(XS.fuelKey("up-e", B0))], [true, false]);
      const burned = h.stock("up-f");
      assert.deepStrictEqual(burned, new Map(fuelRows(4).map((r) => [`pi|${r[1]}`, r[2]])));
      assert.deepStrictEqual(h.pulse(svc, T0 + 301000).cycles, []);
      assert.deepStrictEqual(h.pulse(h.extraction(c), T0 + 601000).cycles, []);
      assert.deepStrictEqual(h.stock("up-f"), burned);
      const fuelled = (at) => [...h.tx((tx) => svc.fuelledOf(tx, ["up-e", "up-f"], at)).fuelled];
      assert.deepStrictEqual([fuelled(T0 + 1000), fuelled(T0 + PERIOD + 1000), fuelled(T0 + 2 * PERIOD + 1000)],
        [["up-f"], ["up-f"], []]);
      const pr = h.production(c, { getExtraction: () => svc });
      const lines = (p) => h.tx((tx) => p.readStationState(tx, F1, [{ stationId: "up-e", kind: "upwell" },
        { stationId: "up-f", kind: "upwell" }], { at: T0 + 1000 })).stations.map((s) => s.lines);
      assert.deepStrictEqual(lines(pr), [1, 2]);
      assert.ok(h.start(pr, "up-e", "frigate", "ab3:1").ok);
      assert.strictEqual(h.start(pr, "up-e", "frigate", "ab3:2").reason, "NO_FREE_LINE");
      const loose = h.production(c, { getExtraction: () => ({ fuelledOf: () => ({ ok: true, enforced: false }) }) });
      assert.deepStrictEqual(lines(loose), [2, 2]);
      assert.ok(h.start(loose, "up-e", "frigate", "ab3:3").ok);
    });
  });

  test("AB4 PI conversion pic:<s>:<b>:44, maxConversionsPerFaction 1 truncates; readNeeds sorted, cut, no write", () => {
    withStore(driver, ({ store }) => {
      const c = cfgOf({ x: { fuelEnabled: true, maxConversionsPerFaction: 1, maxNeedsPerFaction: 3 } });
      const h = rig(store, c, { "up-c": 1001 });
      h.seed("up-c", [["pi", "type:2399", 80], ["pi", "type:2400", 80], ["pi", "type:2398", 80],
        ["pi", "type:2390", 40], ["pi", "type:3645", 40]]);
      const svc = h.extraction(c);
      const v = h.pulse(svc, T0 + 1000);
      assert.deepStrictEqual([v.tally.conversions, v.tally.conversionUnits, v.tally.conversionsTruncated,
        v.tally.unfueled], [1, 10, 1, 1]);
      assert.deepStrictEqual([h.found(XS.conversionKey("up-c", B0, 44)), h.found(XS.conversionKey("up-c", B0, 9832))],
        [true, false]);
      assert.deepStrictEqual([...h.stock("up-c")], [["pi|type:2390", 40], ["pi|type:2398", 80], ["pi|type:3645", 40],
        ["pi|type:44", 10]]);
      const needs = h.tx((tx) => {
        const before = tx.prepare("SELECT total_changes() AS n").get().n;
        const r = svc.readNeeds(tx, F1);
        assert.strictEqual(tx.prepare("SELECT total_changes() AS n").get().n, before);
        return r;
      });
      assert.ok(needs.ok, JSON.stringify(needs));
      assert.deepStrictEqual(needs.needs.map((n) => [n.typeId, n.need]), [[3683, 132], [9832, 51], [3689, 24]]);
      assert.deepStrictEqual([needs.truncated, needs.enforced], [true, { fuel: true, advanced: false }]);
      assert.ok(needs.shortKeys.length > needs.needs.length, JSON.stringify(needs.shortKeys));
      assert.deepStrictEqual(needs.shortKeys, [...needs.shortKeys].sort());
      for (const n of needs.needs) assert.ok(needs.shortKeys.includes(`${n.stationId}|type:${n.typeId}`));
      const reserve = needs.stations[0].reserve;
      assert.ok(reserve.some((r) => r.typeId === 2399 && r.itemKind === "pi" && r.units > 0), JSON.stringify(reserve));
    });
  });

  test("AB5 flags off: minerals-only consume (payload as today), nominal lines, pulse bound, readNeeds empty", () => {
    withStore(driver, ({ store }) => {
      const c = cfgOf();
      const h = rig(store, c, { "up-a": 1001 }, [1001]);
      h.seed("up-a", mineralRows("frigate", 1));
      const calls = { apply: [], getStock: 0, getStocks: 0, list: 0, fuelledOf: 0 };
      const spy = { ...h.repo,
        applyStockChange: (tx, ch) => { calls.apply.push(ch); return h.repo.applyStockChange(tx, ch); },
        getStock: (...a) => { calls.getStock += 1; return h.repo.getStock(...a); },
        getStocks: (...a) => { calls.getStocks += 1; return h.repo.getStocks(...a); },
        listStationsOfFaction: (...a) => { calls.list += 1; return h.repo.listStationsOfFaction(...a); } };
      const ext = { fuelledOf: () => { calls.fuelledOf += 1; return { ok: true, enforced: false }; } };
      const pr = h.production(c, { repository: spy, getExtraction: () => ext });
      assert.strictEqual(pr.getAdvanced(), null);
      const r = h.start(pr, "up-a", "frigate", "ab5:1");
      assert.ok(r.ok && !("advanced" in r) && !("advancedShort" in r), JSON.stringify(r));
      const bill = createRecipeTable(RECIPES, recipeParamsOf(c.production)).billFor("frigate", 1);
      const deltas = Object.keys(bill).sort().map((k) => ({ itemKind: "mineral", itemKey: k, delta: -bill[k] }));
      assert.deepStrictEqual(calls.apply.map((ch) => [ch.key, ch.deltas]), [[ES.consumeKey(r.jobId), deltas]]);
      const entry = h.tx((tx) => h.journal.findByKey(tx, ES.consumeKey(r.jobId))).entry;
      assert.deepStrictEqual(entry.payload, { stationId: "up-a", reason: ES.PRODUCTION_REASON, deltas });
      assert.deepStrictEqual([calls.getStock, calls.fuelledOf], [0, 0]);
      assert.deepStrictEqual(h.tx((tx) => pr.readStationState(tx, F1, [{ stationId: "up-a", kind: "upwell" }]))
        .stations.map((s) => s.lines), [pr.linesOf("upwell")]);

      const first = h.pulse(h.extraction(c, { repository: spy, getProduction: () => pr }), T0 + 1000);
      const n = h.stock("up-a").size;
      assert.ok(first.cycles.length === 1 && n > 0);
      const bound = XS.factionRowBound([n]);
      assert.ok(first.rows <= bound, `${first.rows} > ${bound}`);
      const fits = h.pulse(h.extraction(c, { repository: spy, rowsCap: bound }), T0 + PERIOD + 1000);
      const over = h.pulse(h.extraction(c, { repository: spy, rowsCap: bound - 1 }), T0 + 2 * PERIOD + 1000);
      assert.deepStrictEqual([fits.cycles.length, over.cycles.length, over.tally.refused], [1, 0, 1]);
      assert.strictEqual(h.tx((tx) => tx.prepare("SELECT COUNT(*) AS n FROM world_event_journal WHERE "
        + "idempotency_key LIKE 'fuel:%' OR idempotency_key LIKE 'pic:%'").get().n), 0);
      assert.strictEqual(calls.getStocks, 0);
      const listed = calls.list;
      const needs = h.tx((tx) => h.extraction(c, { repository: spy }).readNeeds(tx, F1));
      assert.deepStrictEqual(needs, { ok: true, enforced: { fuel: false, advanced: false }, stations: [], needs: [],
        truncated: false, shortKeys: [] });
      assert.strictEqual(calls.list, listed);
      assert.strictEqual(h.tx((tx) => h.extraction(c).fuelledOf(tx, ["up-a"], T0)).enforced, false);
    });
  });

  test("AB6b: measured rows of the largest advanced start <= PRODUCTION_START_ROWS + advancedStartRows", () => {
    withStore(driver, ({ store }) => {
      const c = cfgOf({ p: { advancedInputsEnabled: true, advancedInputsMode: "required" } });
      const count = (g) => CATALOG.advancedBillOf(g).moon.length + CATALOG.advancedBillOf(g).pi.length;
      const group = Object.keys(DATA.ADVANCED_BILLS).filter((g) => RECIPES.GROUPS[g])
        .sort((a, b) => count(b) - count(a) || (a < b ? -1 : 1))[0];
      const h = rig(store, c, { "up-t": 1001 });
      h.seed("up-t", [...mineralRows(group, 1), ...billRows("moon", group), ...billRows("pi", group)]);
      const pr = h.production(c);
      const r = store.transaction("ab6b", (tx) => {
        const before = tx.prepare("SELECT total_changes() AS n").get().n;
        const v = pr.startJobInTx(tx, { factionId: F1, stationId: "up-t", hullGroup: group, runs: 1, at: T0 + 1000 },
          "ab6b:1");
        return { ...v, rows: tx.prepare("SELECT total_changes() AS n").get().n - before };
      });
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      const bound = RR.PRODUCTION_START_ROWS + RR.advancedStartRows(maxAdvancedDeltasOf(), c.stations.maxDeltasPerChange)
        + c.production.pruneBatch;
      assert.ok(r.value.rows > RR.PRODUCTION_START_ROWS && r.value.rows <= bound, `${group}: ${r.value.rows} / ${bound}`);
    });
  });
};
