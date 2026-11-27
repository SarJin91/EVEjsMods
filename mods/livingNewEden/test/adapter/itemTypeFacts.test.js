"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { readItemTypeFactsFrom } = require("../../lib/adapter/itemTypeFacts");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const TC = "tradeCatalog";

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function makeRegistry(entries, throwFor = null) {
  const calls = [];
  return {
    calls,
    resolveItemByTypeID(typeID) {
      calls.push(typeID);
      if (typeID === throwFor) throw new Error(`boom ${"x".repeat(400)}`);
      return Object.prototype.hasOwnProperty.call(entries, typeID) ? entries[typeID] : null;
    },
  };
}

module.exports = ({ test }) => {
  test("IF1 tiers-3a readItemTypeFactsFrom: facts, missing, null fields, FAILED, INVALID, UNAVAILABLE, output fields", () => {
    const reg = makeRegistry({
      1230: { typeID: 1230, groupID: 462, name: "Veldspar", volume: 0.1, portionSize: 100, basePrice: 2 },
      1228: { typeID: 1228, name: "S".repeat(80), volume: 0, portionSize: 0 },
      18: { typeID: 18, name: null, volume: null, portionSize: null },
    });
    const r = readItemTypeFactsFrom(reg, [1230, 1228, 18, 22, 1230]);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(reg.calls, [1230, 1228, 18, 22], "duplicates skipped");
    assert.deepStrictEqual(r.facts.get(1230), { typeId: 1230, name: "Veldspar", volume: 0.1, portionSize: 100,
      basePrice: 2 });
    assert.deepStrictEqual(Object.keys(r.facts.get(1230)).sort(),
      ["basePrice", "name", "portionSize", "typeId", "volume"]);
    assert.deepStrictEqual(r.facts.get(1228), { typeId: 1228, name: "S".repeat(64), volume: null, portionSize: null,
      basePrice: null });
    assert.deepStrictEqual(r.facts.get(18), { typeId: 18, name: null, volume: null, portionSize: null,
      basePrice: null });
    assert.deepStrictEqual(r.missing, [22]);

    const thrown = readItemTypeFactsFrom(makeRegistry({}, 19), [18, 19]);
    assert.strictEqual(thrown.ok, false);
    assert.strictEqual(thrown.reason, "ITEM_TYPES_FAILED");
    assert.ok(thrown.detail.startsWith("19: boom") && thrown.detail.length <= 200, thrown.detail);

    const many = Array.from({ length: 65 }, (_, i) => i + 1);
    assert.deepStrictEqual(readItemTypeFactsFrom(reg, many), { ok: false, reason: "ITEM_TYPES_INVALID", detail: "typeIds" });
    for (const bad of [[], null, [0], [1.5], ["1"]]) {
      assert.strictEqual(readItemTypeFactsFrom(reg, bad).reason, "ITEM_TYPES_INVALID", JSON.stringify(bad));
    }
    assert.deepStrictEqual(readItemTypeFactsFrom(null, [1230]), { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" });
    assert.deepStrictEqual(readItemTypeFactsFrom({}, [1230]), { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" });
  });

  test("IF2 tiers-3a vendor facts of itemTypeRegistry, GAME_MODULES consumer tradeCatalog, blind adapter", () => {
    const src = readSource("services/inventory/itemTypeRegistry.js");
    const exportsAt = src.search(/^module\.exports = \{/m);
    assert.ok(exportsAt >= 0, "module.exports block");
    assert.match(src.slice(exportsAt), /^ {2}resolveItemByTypeID,$/m);
    const normalize = src.slice(src.indexOf("\nfunction normalizeEntry("), src.indexOf("\nfunction ", src.indexOf("\nfunction normalizeEntry(") + 1));
    assert.ok(normalize.includes("volume:") && normalize.includes("portionSize:"), "normalizeEntry volume / portionSize");
    assert.ok(src.includes("const FALLBACK_ITEMS = ["), "FALLBACK_ITEMS");
    assert.ok(src.includes("cachedRegistry = buildFallbackRegistry();"), "fallback registry cached");

    assert.ok(!MODULE_NAMES.includes(TC), "tradeCatalog is not a module name");
    const entry = GAME_MODULES.find((e) => e.path === "services/inventory/itemTypeRegistry");
    assert.ok(entry, "itemTypeRegistry in GAME_MODULES");
    const s = entry.symbols.find((x) => x.name === "resolveItemByTypeID");
    assert.ok(s && s.kind === "export" && s.consumers.includes(TC) && s.consumers.includes("salvageAnomaly"));
    assert.ok(s.wrap !== true && s.firstLoad !== true, "not wrapped, no first-load");
    const users = GAME_MODULES.filter((e) => e.symbols.some((x) => x.consumers.includes(TC))).map((e) => e.path);
    assert.deepStrictEqual(users, ["services/inventory/itemTypeRegistry"]);

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof blind.readItemTypeFacts, "function");
    assert.deepStrictEqual(blind.readItemTypeFacts([1230]), { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" });
  });
};
