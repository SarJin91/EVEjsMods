"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const ORE_TYPES = require("../../lib/economy/data/oreTypes");
const HULL_TYPES = require("../../lib/economy/data/hullTradeTypes");
const HULL_RECIPES = require("../../lib/economy/data/hullRecipes");
const { buildTradeCatalog, MAX_CATALOG_TYPES } = require("../../lib/economy/trade/tradeCatalog");
const { readItemTypeFactsFrom } = require("../../lib/adapter/itemTypeFacts");
const { createJournal } = require("../../lib/persistence/journal");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");

const MOD_DIR = path.join(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;

const REGISTRY = { resolveItemByTypeID: (id) => ({ typeID: id, name: `Ore ${id}`, volume: 0.1, portionSize: 100 }) };
const FACTS = readItemTypeFactsFrom(REGISTRY, ORE_TYPES.BASE_TYPE_IDS);

const catalogOf = (over) => buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: FACTS, oreOffersEnabled: true,
  hullTypes: HULL_TYPES, hullRecipes: HULL_RECIPES, hullOffersEnabled: true, ...over });

module.exports = ({ test, skip }) => {
  test("TCH1 c1 catalog flag on: hull entries, priceTypeIds <= 64, offerable, volumes, hullsFor, limit", () => {
    const cat = catalogOf({});
    const plain = buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: FACTS, oreOffersEnabled: true });
    assert.deepStrictEqual(cat.entries.filter((e) => e.itemKind !== "hull"), [...plain.entries]);
    assert.deepStrictEqual(cat.entries.slice(0, 7).map((e) => e.itemKey), ["type:34", "type:35", "type:36", "type:37",
      "type:38", "type:39", "type:40"]);
    const hulls = cat.entries.filter((e) => e.itemKind === "hull");
    assert.strictEqual(hulls.length, 32);
    assert.strictEqual(cat.summary.hulls, 32);
    assert.strictEqual(cat.summary.hullState, "on");
    assert.deepStrictEqual([...cat.summary.hullFallbacks], []);
    assert.deepStrictEqual([...cat.summary.hullTruncated], []);
    for (const e of hulls) {
      assert.strictEqual(e.itemKey, `group:${e.group}`);
      assert.strictEqual(e.typeId, HULL_TYPES.RACES[String(e.raceId)][e.group], `${e.raceId}:${e.group}`);
    }
    assert.ok(cat.priceTypeIds.length <= MAX_CATALOG_TYPES, String(cat.priceTypeIds.length));
    assert.strictEqual(new Set(cat.priceTypeIds).size, cat.priceTypeIds.length);
    assert.deepStrictEqual(cat.priceTypeIds.slice(0, plain.priceTypeIds.length), [...plain.priceTypeIds]);
    assert.deepStrictEqual([...cat.priceTypeIds.slice(plain.priceTypeIds.length)].sort((a, b) => a - b),
      [...new Set(hulls.map((e) => e.typeId))].sort((a, b) => a - b));
    assert.strictEqual(cat.volumes["group:cruiser"], 1000000);
    assert.strictEqual(cat.volumes["group:frigate"], 250000);
    assert.strictEqual(cat.volumes["type:34"], 1);

    const amarrCruiser = HULL_TYPES.RACES["4"].cruiser;
    assert.strictEqual(cat.offerable("hull", "group:cruiser", amarrCruiser), true);
    assert.strictEqual(cat.offerable("hull", "group:cruiser", HULL_TYPES.RACES["2"].cruiser), true, "any race type");
    assert.strictEqual(cat.offerable("hull", "group:frigate", amarrCruiser), false, "wrong group");
    assert.strictEqual(cat.offerable("hull", "group:cruiser", 999999), false, "unknown type");
    assert.strictEqual(cat.offerable("hull", "group:capital", 23757), false, "no capital");
    assert.strictEqual(cat.offerable("hull", "type:34", 34), false);
    assert.strictEqual(cat.get("group:cruiser"), null, "group keys are not served by get()");

    const amarr = cat.hullsFor(500003);
    assert.deepStrictEqual(Object.keys(amarr), ["frigate", "destroyer", "cruiser", "battlecruiser", "battleship",
      "logistics", "ewar", "tackle"]);
    for (const [g, e] of Object.entries(amarr)) {
      assert.deepStrictEqual(e, { itemKind: "hull", itemKey: `group:${g}`, typeId: HULL_TYPES.RACES["4"][g], group: g,
        raceId: 4, volumeUnits: e.volumeUnits });
    }
    assert.ok(Object.isFrozen(amarr));
    assert.strictEqual(cat.hullsFor(500003), amarr, "cached per faction");
    assert.deepStrictEqual(cat.hullsFor(500006), {});
    assert.deepStrictEqual(cat.hullsFor(500020).cruiser.typeId, HULL_TYPES.RACES["8"].cruiser, "Serpentis = Gallente");

    const wide = { RACES: {}, FACTION_RACE: HULL_TYPES.FACTION_RACE };
    let next = 900000;
    for (const r of ["1", "2", "4", "8"]) {
      wide.RACES[r] = {};
      for (const g of Object.keys(HULL_TYPES.RACES[r])) { wide.RACES[r][g] = next; next += 1; }
    }
    const full = catalogOf({ hullTypes: wide });
    assert.strictEqual(full.summary.ores, 24);
    assert.strictEqual(full.priceTypeIds.length, 63);
    assert.deepStrictEqual([full.summary.hulls, full.summary.hullTruncated.length], [32, 0]);
  });

  test("TCH2 c1 catalog flag off = before c1; fallback without table; no_recipes; panel catalog keys", async () => {
    const off = catalogOf({ hullOffersEnabled: false });
    const before = buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: FACTS, oreOffersEnabled: true });
    const noTable = catalogOf({ hullOffersEnabled: false, hullTypes: null });
    for (const other of [before, noTable]) {
      assert.deepStrictEqual(off.priceTypeIds, other.priceTypeIds);
      assert.deepStrictEqual(off.volumes, other.volumes);
    }
    assert.strictEqual(off.offerable("hull", "group:cruiser", HULL_TYPES.RACES["4"].cruiser), false);
    assert.deepStrictEqual(off.hullsFor(500003), {});
    assert.strictEqual(off.summary.hullState, "off");
    assert.strictEqual(off.summary.hulls, 32, "entries stay (panel, pattern)");

    const fb = catalogOf({ hullTypes: null });
    const fbHulls = fb.entries.filter((e) => e.itemKind === "hull");
    assert.deepStrictEqual(fbHulls.map((e) => [e.group, e.typeId, e.raceId]),
      ["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "logistics", "ewar", "tackle"]
        .map((g) => [g, HULL_RECIPES.GROUPS[g].representativeTypeId, null]));
    assert.strictEqual(fb.summary.hullState, "fallback");
    assert.deepStrictEqual([fb.hullsFor(500006), fb.hullsFor(500003)], [{}, {}]);
    const fbMap = catalogOf({ hullTypes: { FACTION_RACE: HULL_TYPES.FACTION_RACE } });
    assert.strictEqual(fbMap.summary.hullState, "fallback");
    assert.deepStrictEqual(Object.values(fbMap.hullsFor(500003)).map((e) => [e.group, e.raceId]),
      fbHulls.map((e) => [e.group, null]));
    assert.deepStrictEqual(fbMap.hullsFor(500006), {});
    const holes = { RACES: { ...HULL_TYPES.RACES, 8: { ...HULL_TYPES.RACES["8"], ewar: undefined } },
      FACTION_RACE: HULL_TYPES.FACTION_RACE };
    const holed = catalogOf({ hullTypes: holes });
    assert.deepStrictEqual([...holed.summary.hullFallbacks], ["8:ewar"]);
    assert.strictEqual(holed.hullsFor(500004).ewar.typeId, HULL_RECIPES.GROUPS.ewar.representativeTypeId);
    const none = catalogOf({ hullRecipes: null });
    assert.strictEqual(none.summary.hullState, "no_recipes");
    assert.strictEqual(none.summary.hulls, 0);
    assert.deepStrictEqual(none.priceTypeIds, before.priceTypeIds);

    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true } };
      const started = require("../../lib/economy/trade").startTrade({ config: cfg,
        persistence: { ok: true, store: opened.store, journal }, clock: shared.clock, views, ids: shared.ids,
        adapter: createFakeTradeAdapter(), logger: { log() {} }, getStations: () => ({ getMode: () => "ready" }),
        getGraph: () => null, setTimer: () => ({ cancel() {} }) });
      assert.ok(started.ok, JSON.stringify(started));
      const data = views.getView("trade").getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(Object.keys(data.catalog).sort(), ["commodities", "commodityMissing", "commodityState",
        "commodityTruncated", "efficiencyPermille", "hullFallbacks",
        "hullOffersEnabled", "hullState", "hullTruncated", "hulls", "minerals", "missing", "oreOffersEnabled",
        "oreReason", "oreState", "ores", "truncated"]);
      assert.deepStrictEqual([data.catalog.hulls, data.catalog.hullState, data.catalog.hullOffersEnabled],
        [32, "on", true]);
      started.trade.stop();
    });
    return undefined;
  });
};
