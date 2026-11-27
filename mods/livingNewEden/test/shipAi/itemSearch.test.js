"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { searchItemTypesFrom } = require("../../lib/adapter/itemSearch");
const { toolsFor } = require("../../lib/shipAi/tools/catalog");
const { createToolDeps } = require("../../lib/shipAi/tools/deps");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const STATION = 60003760;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const T = (typeID, name, groupName, categoryID, raceID, extra) => ({ typeID, name, groupName, categoryID, raceID,
  published: true, volume: 1, ...(extra || {}) });
const TYPES = [
  T(603, "Merlin", "Frigate", 6, 1), T(602, "Kestrel", "Frigate", 6, 1), T(582, "Bantam", "Frigate", 6, 1),
  T(587, "Rifter", "Frigate", 6, 2), T(11381, "Harpy", "Assault Frigate", 6, 1),
  T(3330, "Caldari Frigate", "Spaceship Command", 16, 1),
  T(400, "Small Shield Booster I", "Shield Booster", 7, null),
  T(401, "Small Shield Booster I Blueprint", "Shield Booster Blueprint", 9, null, { volume: 0.01 }),
  T(10850, "Medium Shield Booster I Blueprint", "Shield Booster Blueprint", 9, null),
  T(10851, "Small Shield Booster II Blueprint", "Shield Booster Blueprint", 9, null, { published: false }),
  T(34, "Tritanium", "Mineral", 4, null),
];
const registryOf = (types) => ({ listItemTypes: () => types.map((t) => ({ ...t })) });
const names = (r) => r.candidates.map((c) => c.name);

function depsOf(registry, withSearch) {
  const sensors = { itemByName: () => ({ ok: true, found: false }),
    ...(withSearch ? { itemSearch: (q, n) => searchItemTypesFrom(registry, q, n) } : {}) };
  const db = { findItem: (id, typeId) => (typeId === 401 ? { ok: true, totalQty: 2, more: 0, places: [
    { locationId: STATION, kind: "station", qty: 2, holderTypeId: null, siteId: STATION, siteKind: "station" }] }
    : { ok: true, totalQty: 0, more: 0, places: [] }) };
  const adapter = { readNpcStations: (ids) => ({ ok: true, stations: new Map(ids.map((id) => [id, { name: "Jita IV" }])) }),
    readItemTypeFacts: () => ({ ok: true, facts: new Map() }) };
  return createToolDeps({ adapter, sensors, S: settings(), getGraph: () => null, getFleets: () => null,
    getWorld: () => null, getStore: () => null, db });
}
const toolOf = (S2, name) => toolsFor(S2).find((t) => t.name === name);

module.exports = ({ test }) => {
  test("IS1 searchItemTypesFrom: race + group, name before group, bp alias, plural, unpublished never", () => {
    const reg = registryOf(TYPES);
    const cf = searchItemTypesFrom(reg, "Caldari frigate", 8);
    assert.strictEqual(cf.matched, "all");
    assert.deepStrictEqual(names(cf), ["Caldari Frigate", "Bantam", "Merlin", "Kestrel", "Harpy"]);
    assert.deepStrictEqual(names(searchItemTypesFrom(reg, "caldari frigates", 8)), names(cf), "plural");
    assert.deepStrictEqual(searchItemTypesFrom(reg, "Caldari frigate", 2).more, 3);
    const bp = searchItemTypesFrom(reg, "bp small shield booster", 8);
    assert.deepStrictEqual(bp, { ok: true, matched: "all", more: 0, candidates: [{ typeId: 401,
      name: "Small Shield Booster I Blueprint", groupName: "Shield Booster Blueprint", categoryId: 9, volume: 0.01,
      byName: true }] });
    assert.deepStrictEqual(names(searchItemTypesFrom(reg, "small shield booster", 8))[0], "Small Shield Booster I",
      "a blueprint not asked for comes after the module");
    assert.deepStrictEqual(names(searchItemTypesFrom(reg, "small shield repair booster", 8)).slice(0, 1),
      ["Small Shield Booster I"], "3+ words: one may miss (partial)");
    assert.strictEqual(searchItemTypesFrom(reg, "small shield repair booster", 8).matched, "partial");
    assert.deepStrictEqual(searchItemTypesFrom(reg, "unobtainium", 8), { ok: true, matched: "none", candidates: [],
      more: 0 });
    assert.deepStrictEqual(searchItemTypesFrom({}, "Caldari frigate", 8), { ok: false, reason: "SEAM_UNAVAILABLE" });
    assert.deepStrictEqual(searchItemTypesFrom({ listItemTypes: () => { throw new Error("x"); } }, "x", 8),
      { ok: false, reason: "SEAM_UNAVAILABLE" });
  });

  test("IS2 tools: find_item resolves a fragment name, item_info gives candidates without IDs (regression)", () => {
    const S2 = settings({ toolMaxRows: 2 });
    const reg = registryOf(TYPES);
    const ctx = { playerId: PLAYER, deps: depsOf(reg, true), S: S2, nowMs: () => 0 };
    const found = toolOf(S2, "find_item").run(ctx, { item: "Small Shield Booster Blueprint" });
    assert.deepStrictEqual(found, { ok: true, data: { item: "Small Shield Booster I Blueprint", totalQty: 2,
      places: [{ place: "Jita IV", in: "station", qty: 2 }], more: 0 } });
    const info = toolOf(S2, "item_info").run(ctx, { item: "Caldari frigate" });
    assert.deepStrictEqual(info, { ok: false, reason: "UNKNOWN_ITEM", more: 3, candidates: [
      { item: "Caldari Frigate", group: "Spaceship Command" }, { item: "Bantam", group: "Frigate" }] });
    assert.ok(!/typeId|\b582\b|\b3330\b/.test(JSON.stringify(info)), "no ID in the tool JSON");
    assert.deepStrictEqual(toolOf(S2, "item_info").run(ctx, { item: "caldari assault frigate" }), { ok: false,
      reason: "UNKNOWN_ITEM", candidates: [{ item: "Harpy", group: "Assault Frigate" }] },
    "one type by race + group only = a candidate, never the item");
    assert.deepStrictEqual(toolOf(S2, "item_info").run(ctx, { item: "unobtainium" }),
      { ok: false, reason: "UNKNOWN_ITEM" });
    const noSearch = { ...ctx, deps: depsOf(reg, false) };
    assert.deepStrictEqual(toolOf(S2, "find_item").run(noSearch, { item: "Small Shield Booster Blueprint" }),
      { ok: false, reason: "UNKNOWN_ITEM" });
    assert.ok(toolOf(S2, "item_info").description.includes("\"Small Shield Booster Blueprint\", \"Caldari frigate\""));
    for (const n of ["find_item", "item_info", "market_price"]) {
      assert.ok(toolOf(S2, n).description.includes("English name or fragments"), n);
    }
  });

  test("IS3 vendor facts: listItemTypes exported, declared for shipAiTools", () => {
    const src = fs.readFileSync(path.join(SERVER_SRC, "services", "inventory", "itemTypeRegistry.js"), "utf8")
      .replace(/\r\n/g, "\n");
    assert.ok(src.includes("function listItemTypes() {\n  return [...loadRegistry().byTypeID.values()]"));
    assert.ok(/module\.exports = \{\n  listItemTypes,/.test(src));
    const mod = GAME_MODULES.find((m) => m.path === "services/inventory/itemTypeRegistry");
    const sym = mod && mod.symbols.find((s) => s.name === "listItemTypes");
    assert.ok(sym && sym.consumers.includes("shipAiTools"), JSON.stringify(sym));
  });
};
