"use strict";

const assert = require("node:assert");

const ORE_TYPES = require("../../../lib/economy/data/oreTypes");
const S = require("../../../lib/economy/trade/schema");
const { buildTradeCatalog, MAX_CATALOG_TYPES, MAX_ORE_BASES } = require("../../../lib/economy/trade/tradeCatalog");
const { readItemTypeFactsFrom } = require("../../../lib/adapter/itemTypeFacts");

function factsFor(typeIds, skip = []) {
  const registry = {
    resolveItemByTypeID: (id) => (skip.includes(id) ? null
      : { typeID: id, name: id === 1230 ? "Veldspar" : `Ore ${id}`, volume: id === 1230 ? 0.1 : 0.15, portionSize: 100 }),
  };
  return readItemTypeFactsFrom(registry, typeIds);
}

module.exports = ({ test }) => {
  test("TCAT1 tiers-3a buildTradeCatalog: minerals, ores from facts, missing, truncated, flag off, oreState", () => {
    assert.strictEqual(MAX_CATALOG_TYPES, 192);
    assert.strictEqual(MAX_ORE_BASES, 24);
    const mineralKeys = S.MINERAL_TYPE_IDS.map((t) => `type:${t}`);

    const cat = buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: factsFor(ORE_TYPES.BASE_TYPE_IDS, [1232]),
      oreOffersEnabled: true });
    const minerals = cat.entries.filter((e) => e.itemKind === "mineral");
    assert.deepStrictEqual(minerals.map((e) => e.itemKey), mineralKeys, "mineral keys as before 3a");
    assert.deepStrictEqual(cat.entries.slice(0, 7).map((e) => e.itemKind), Array(7).fill("mineral"), "minerals first");
    assert.ok(cat.entries.length <= MAX_CATALOG_TYPES);
    const ores = cat.entries.filter((e) => e.itemKind === "ore");
    assert.strictEqual(ores.length, 23, "24 bases, Dark Ochre without a fact");
    assert.deepStrictEqual(cat.get("type:1230"), { itemKind: "ore", itemKey: "type:1230", typeId: 1230,
      family: "Veldspar", name: "Veldspar", volumeUnits: 10, portionSize: 100, minerals: [["type:34", 400]] });
    assert.deepStrictEqual(cat.get("type:19").minerals.map((p) => p[0]),
      ["type:34", "type:37", "type:38", "type:39", "type:40"], "minerals by key asc");
    assert.deepStrictEqual(cat.summary.missing, [1232]);
    assert.strictEqual(cat.get("type:1232"), null);
    assert.deepStrictEqual(cat.summary.truncated, []);
    assert.strictEqual(cat.summary.oreState, "on");
    assert.strictEqual(cat.priceTypeIds.length, 7 + 23);
    assert.strictEqual(cat.volumes["type:1230"], 10);
    assert.strictEqual(cat.volumes["type:34"], 1);
    assert.strictEqual(cat.offerable("ore", "type:1230", 1230), true);
    assert.strictEqual(cat.offerable("ore", "type:1230", 1228), false, "typeId must match");
    assert.strictEqual(cat.offerable("ore", "type:34", 34), false, "mineral key is no ore");
    assert.strictEqual(cat.offerable("mineral", "type:34", 34), true);
    assert.strictEqual(cat.offerable("hull", "type:587", 587), false);
    assert.ok(Object.isFrozen(cat) && Object.isFrozen(cat.entries) && Object.isFrozen(cat.get("type:1230").minerals));

    const extra = { 900001: { typeId: 900001, baseTypeId: 900001, grade: 1, family: "Extra", minerals: { "type:34": 10 } },
      900002: { typeId: 900002, baseTypeId: 900002, grade: 1, family: null, minerals: { "type:35": 10 } } };
    const big = { ORE_TYPES: { ...ORE_TYPES.ORE_TYPES, ...extra },
      BASE_TYPE_IDS: [...ORE_TYPES.BASE_TYPE_IDS, 900001, 900002],
      FAMILY_BY_BASE: { ...ORE_TYPES.FAMILY_BY_BASE, 900001: "Extra" } };
    const bigCat = buildTradeCatalog({ oreTypes: big, factsRead: factsFor([...ORE_TYPES.BASE_TYPE_IDS, 900001]
      .filter((id) => id !== 82205)), oreOffersEnabled: true });
    assert.deepStrictEqual(bigCat.summary.truncated, [82205, 900002], "unnamed bases last, highest truncated");
    assert.ok(bigCat.get("type:900001"), "named extra base in");
    assert.strictEqual(bigCat.summary.ores, MAX_ORE_BASES);

    const off = buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: factsFor(ORE_TYPES.BASE_TYPE_IDS),
      oreOffersEnabled: false });
    assert.deepStrictEqual([...off.priceTypeIds], S.MINERAL_TYPE_IDS);
    assert.deepStrictEqual(Object.keys(off.volumes), mineralKeys);
    assert.strictEqual(off.get("type:1230").itemKind, "ore");
    assert.strictEqual(off.offerable("ore", "type:1230", 1230), false);
    assert.strictEqual(off.summary.oreState, "off");

    const noSeam = buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: null, oreOffersEnabled: true });
    assert.strictEqual(noSeam.summary.oreState, "no_seam");
    assert.strictEqual(noSeam.summary.ores, 0);
    assert.deepStrictEqual([...noSeam.priceTypeIds], S.MINERAL_TYPE_IDS);
    const refused = buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" },
      oreOffersEnabled: true });
    assert.strictEqual(refused.summary.oreState, "facts_refused");
    assert.strictEqual(refused.summary.oreReason, "ITEM_TYPES_UNAVAILABLE");
    assert.strictEqual(refused.get("type:1230"), null);
    const bare = buildTradeCatalog({});
    assert.strictEqual(bare.summary.oreState, "no_ore_types");
    assert.deepStrictEqual(bare.entries.map((e) => e.itemKey), mineralKeys);
  });
};
