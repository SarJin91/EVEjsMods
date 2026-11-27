"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const nw = require("../../lib/adapter/nativeWrecks");
const { SITE_ORIGIN, PROVIDER_ID, MANUAL_SITE_ID_BASE } = require("../../lib/adapter/dungeonSites");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { probeModules } = require("../../lib/adapter/probe");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SALVAGE = "salvageAnomaly";
const SYSTEM = 30000142;
const INSTANCE = 77;
const SITE_ID = MANUAL_SITE_ID_BASE + INSTANCE;
const SITE_KEY = "lne:salv:abc:0";
const SITE_POS = Object.freeze({ x: 1000, y: 2000, z: 3000 });

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function ownSummary(overrides = {}) {
  return {
    instanceID: INSTANCE,
    solarSystemID: SYSTEM,
    siteKey: SITE_KEY,
    siteOrigin: SITE_ORIGIN,
    lifecycleState: "active",
    position: { ...SITE_POS },
    metadata: { providerID: PROVIDER_ID, lneSiteKey: SITE_KEY, siteID: SITE_ID },
    ...overrides,
  };
}

function baseSpec(overrides = {}) {
  return {
    anomalyId: "salv:abc",
    slot: 0,
    siteKey: SITE_KEY,
    systemId: SYSTEM,
    offset: { x: 3000, y: 0, z: -4000 },
    shipTypeId: 17715,
    hullGroup: "cruiser",
    factionName: "Guristas",
    ownerId: 1000127,
    lootTableId: "parity_guristas_standard",
    lootRolls: 2,
    expiresAtMs: 5_000_000,
    nowMs: 1_000_000,
    fallbackWreckNames: [],
    ...overrides,
  };
}

const WRECK_TYPE = Object.freeze({ typeID: 26563, groupID: 186, categoryID: 2, groupName: "Wreck",
  name: "Guristas Medium Wreck" });

function makeMods(opts = {}) {
  const calls = [];
  const wrecks = new Map();
  const items = new Map();
  let nextWreck = 9_000_000;
  let nextItem = 9_500_000;
  let summary = opts.summary === undefined ? ownSummary() : opts.summary;
  const store = {
    TABLE: Object.freeze({ WRECKS: "npcWrecks", WRECK_ITEMS: "npcWreckItems" }),
    allocateWreckID(o) { calls.push(["allocateWreckID", o]); nextWreck += 1; return { success: true, data: nextWreck }; },
    allocateWreckItemID() { calls.push(["allocateWreckItemID"]); nextItem += 1; return { success: true, data: nextItem }; },
    upsertNativeWreck(record) {
      calls.push(["upsertNativeWreck", record.wreckID]);
      if (record.dungeonMaterializedSiteContent === true && !(record.dungeonSiteInstanceID > 0)) {
        return { success: false, errorMsg: "NPC_PRIVATE_SCOPE_INVALID" };
      }
      wrecks.set(record.wreckID, JSON.parse(JSON.stringify(record)));
      return { success: true };
    },
    upsertNativeWreckItem(record) {
      calls.push(["upsertNativeWreckItem", record.typeID, record.sourceKind]);
      if (opts.failItemAt !== undefined && items.size === opts.failItemAt) return { success: false, errorMsg: "WRITE_X" };
      items.set(record.wreckItemID, { ...record });
      return { success: true };
    },
    listNativeWrecks() { calls.push(["listNativeWrecks"]); return [...wrecks.values()].map((w) => ({ ...w })); },
    listNativeWreckItemsForWreck(id) {
      calls.push(["listNativeWreckItemsForWreck", id]);
      return [...items.values()].filter((i) => i.wreckID === id);
    },
    removeNativeWreckCascade(id) {
      calls.push(["removeNativeWreckCascade", id]);
      for (const [k, v] of items) if (v.wreckID === id) items.delete(k);
      wrecks.delete(id);
      return { success: true, data: { wreckID: id } };
    },
  };
  class Runtime {
    isSolarSystemSceneLoaded(id) { calls.push(["isSolarSystemSceneLoaded", id]); return this.scenes.has(id); }
  }
  const runtime = Object.assign(Object.create(Runtime.prototype), { scenes: new Set(opts.loaded ? [SYSTEM] : []) });
  let roll = 0;
  const mods = {
    store,
    wreckService: {
      spawnNativeWreck(systemId, wreckId, o) { calls.push(["spawnNativeWreck", systemId, wreckId, o]); return { success: true }; },
      destroyNativeWreck(wreckId, o) {
        calls.push(["destroyNativeWreck", wreckId, o]);
        store.removeNativeWreckCascade(wreckId);
        return { success: true };
      },
    },
    wreckUtils: {
      resolveEntityWreckType(ctx) { calls.push(["resolveEntityWreckType", ctx]); return opts.entityType === undefined ? WRECK_TYPE : opts.entityType; },
      resolveShipWreckType(id) { calls.push(["resolveShipWreckType", id]); return opts.shipType || null; },
    },
    npcData: { getNpcLootTable: (id) => (id === "missing" ? null
      : id === "empty_rule" ? { lootTableID: id, emptyRule: true, entries: [] }
        : id === "zero_entries" ? { lootTableID: id, minEntries: 0, maxEntries: 0 }
          : id === "zero_max_only" ? { lootTableID: id, maxEntries: 0 }
            : id === "no_random" ? { lootTableID: id, minEntries: 1, maxEntries: 3, disableRandomLoot: true }
              : id === "no_random_required" ? { lootTableID: id, maxEntries: 0, disableRandomLoot: true,
                requiredDrops: [{ typeID: 34, quantity: 1 }] }
                : id === "max_zero_min_one" ? { lootTableID: id, minEntries: 1, maxEntries: 0 }
                  : id === "based_zero" ? { lootTableID: id, baseRuleID: "loot_base", maxEntries: 0 }
                    : { lootTableID: id, mode: "rule", minEntries: 1, maxEntries: 4, selectors: [{ kind: "ammo" }] }) },
    npcLoot: {
      rollNpcLootEntries(table, options) {
        roll += 1;
        calls.push(["roll", table.lootTableID]);
        if (options !== undefined) calls.push(["rollOptions", options]);
        if (typeof opts.rollEntries === "function") return opts.rollEntries(roll);
        return [1, 2].map((k) => ({ itemType: { typeID: 100 * roll + k, name: `Loot ${roll}.${k}` }, quantity: k, singleton: false }));
      },
    },
    itemStore: {
      ITEM_FLAGS: Object.freeze({ HANGAR: 4 }),
      getItemMetadata: (typeID, name) => ({ typeID, name, groupID: 55, categoryID: 7, volume: 2.5 }),
    },
    typeRegistry: {
      resolveItemByTypeID: (id) => (opts.typeById && opts.typeById[id] ? { typeID: id, name: opts.typeById[id] } : null),
      resolveItemByName(name, o) {
        calls.push(["resolveItemByName", name, o]);
        if (name === "Not A Wreck") return { success: true, match: { typeID: 34, groupName: "Mineral", name } };
        if (name === "Cruiser Wreck") return { success: true, match: { ...WRECK_TYPE, typeID: 26500, name } };
        return { success: false, errorMsg: "ITEM_NOT_FOUND", suggestions: [] };
      },
    },
    runtime,
    dungeonRuntime: { findInstanceBySiteKey: (key) => (key === SITE_KEY ? summary : null) },
    gameStore: null,
  };
  if (opts.getOne) {
    store.getNativeWreck = (id) => {
      calls.push(["getNativeWreck", id]);
      const w = wrecks.get(Number(id));
      return w ? JSON.parse(JSON.stringify(w)) : null;
    };
  }
  return { mods, calls, wrecks, items, setSummary: (s) => { summary = s; } };
}

const names = (calls) => calls.map((c) => c[0]);

module.exports = ({ test }) => {
  test("NW1 vendor facts: seam exports, ensureScene trap, rematerialize filter, scene owner, loot rule", () => {
    for (const [key, fns] of Object.entries(nw.REQUIRED_FUNCTIONS)) {
      if (key === "runtime") continue;
      const src = readSource(`${nw.MODULE_PATHS[key]}.js`);
      for (const fn of fns) assert.match(src, new RegExp(`^ {2}${fn},?$`, "m"), `${nw.MODULE_PATHS[key]}.${fn}`);
    }
    assert.match(readSource("space/npc/nativeNpcStore.js"), /^ {2}TABLE,$/m);
    assert.match(readSource("space/runtime/spaceRuntime/sceneRegistry.js"),
      /^isSolarSystemSceneLoaded\(systemID\) \{\n.*\n\s*return numericSystemID > 0 && this\.scenes\.has\(numericSystemID\);/m);

    const wreckService = readSource("space/npc/nativeNpcWreckService.js");
    assert.ok(functionBody(wreckService, "resolveNativeWreckScene").includes("spaceRuntime.ensureScene(descriptor)"));
    for (const fn of ["spawnNativeWreck", "destroyNativeWreck"]) {
      assert.ok(functionBody(wreckService, fn).includes("resolveNativeWreckScene(wreckRecord, options)"), fn);
    }
    const vendorItem = functionBody(wreckService, "buildNativeWreckItemRecord");
    const vendorKeys = [...vendorItem.slice(vendorItem.indexOf("data: {")).matchAll(/^ {6}(\w+)[:,]/gm)].map((m) => m[1]);
    const { mods } = makeMods();
    const ported = nw.buildWreckItemRecord(mods, { wreckID: 5, ownerID: 6, transient: false },
      { typeID: 34, name: "Tritanium" }, { quantity: 3 });
    assert.deepStrictEqual(Object.keys(ported.data).sort(), [...vendorKeys].sort());
    assert.ok(functionBody(readSource("space/npc/nativeNpcStore.js"), "upsertNativeWreck").includes("...wreckRecord,"));
    assert.ok(functionBody(readSource("services/inventory/itemTypeRegistry.js"), "resolveItemByName")
      .includes("options.exactOnly === true"), "exactOnly lookup");

    const site = readSource("services/dungeon/dungeonUniverseSiteService.js");
    const remat = functionBody(site, "rematerializeStoredDungeonEncounterEntities");
    const at = remat.indexOf("for (const wreckRecord of nativeNpcStore.listNativeWrecksMatching((row) => (");
    assert.ok(at >= 0, "wreck loop over listNativeWrecksMatching");
    const wreckLoop = remat.slice(at, remat.indexOf("))) {", at));
    for (const check of ["row.dungeonMaterializedSiteContent === true",
      "toInt(row.systemID, 0) === systemID", "toInt(row.dungeonSiteInstanceID, 0) === instanceID",
      "toInt(row.dungeonSiteID, 0) === siteID"]) {
      assert.ok(wreckLoop.includes(check), check);
    }
    const clear = functionBody(site, "clearDungeonScopeFields");
    assert.ok(clear.includes("if (key.startsWith(\"dungeon\")) {"));
    for (const tag of [nw.TAG_ANOMALY, nw.TAG_SLOT]) assert.ok(!tag.startsWith("dungeon"), tag);
    const owner = functionBody(readSource("space/runtime/nativeRecordSceneOwnership.js"), "hasValidDungeonNativeSceneOwner");
    for (const check of ["record.dungeonMaterializedSiteContent !== true", "toInt(metadata.dungeonSiteID, 0) > 0",
      "toInt(metadata.dungeonSiteInstanceID, 0) > 0"]) {
      assert.ok(owner.includes(check), check);
    }
    const loot = readSource("services/_shared/spaceLootEntitlement.js");
    assert.match(loot, /if \(!isPlayerCharacterOwner\(ownerID\)\) \{\n\s*return true;\n\s*\}/);
    const version = /^const LOOT_RIGHTS_SNAPSHOT_VERSION = (\d+);$/m.exec(loot);
    assert.ok(version, "LOOT_RIGHTS_SNAPSHOT_VERSION");
    assert.strictEqual(nw.LOOT_RIGHTS_SNAPSHOT_VERSION, Number(version[1]));
  });

  test("NW2 buildWreckRecord: scope fields, tags, expiry, owner, position = site + offset", () => {
    const spec = baseSpec({ slot: 3 });
    const record = nw.buildWreckRecord(9001, spec, WRECK_TYPE, { siteId: SITE_ID, instanceId: INSTANCE, position: SITE_POS });
    assert.strictEqual(record.dungeonMaterializedSiteContent, true);
    assert.strictEqual(record.dungeonSiteID, SITE_ID);
    assert.strictEqual(record.dungeonSiteInstanceID, INSTANCE);
    assert.strictEqual(record.lneAnomalyId, "salv:abc");
    assert.strictEqual(record.lneSlot, 3);
    assert.strictEqual(record.expiresAtMs, 5_000_000);
    assert.strictEqual(record.createdAtMs, 1_000_000);
    assert.strictEqual(record.transient, false);
    assert.deepStrictEqual([record.ownerID, record.corporationID, record.lootRightCorpID], [1000127, 1000127, 1000127]);
    assert.strictEqual(record.lootRightsSnapshotVersion, nw.LOOT_RIGHTS_SNAPSHOT_VERSION);
    assert.strictEqual(record.lootAbandoned, false);
    assert.deepStrictEqual(record.position, { x: 4000, y: 2000, z: -1000 });
    assert.deepStrictEqual(record.direction, { x: 0.6, y: 0, z: -0.8 });
    assert.deepStrictEqual([record.systemID, record.locationID, record.wreckID], [SYSTEM, SYSTEM, 9001]);
    assert.deepStrictEqual([record.typeID, record.groupID, record.categoryID, record.itemName, record.sourceTypeID],
      [26563, 186, 2, "Guristas Medium Wreck", 17715]);
    assert.ok(!("sceneKey" in record) && !("sceneKind" in record), "solar system scene record");
  });

  test("NW3 place: roll -> items order, adoption, cascade, scene guard, refusals", () => {
    const a = makeMods();
    const placed = nw.placeWreckFrom(a.mods, baseSpec());
    assert.deepStrictEqual({ ...placed, wreckId: 0 },
      { ok: true, adopted: false, wreckId: 0, items: 4, factionItems: 0, spawned: false, vendorWrites: 5 });
    const order = names(a.calls).filter((n) => ["allocateWreckID", "upsertNativeWreck", "roll", "upsertNativeWreckItem",
      "spawnNativeWreck", "isSolarSystemSceneLoaded"].includes(n));
    assert.deepStrictEqual(order, ["allocateWreckID", "upsertNativeWreck", "roll", "upsertNativeWreckItem",
      "upsertNativeWreckItem", "roll", "upsertNativeWreckItem", "upsertNativeWreckItem", "isSolarSystemSceneLoaded"]);
    assert.ok(a.calls.filter((c) => c[0] === "upsertNativeWreckItem").every((c) => c[2] === "loot"));
    assert.deepStrictEqual(a.calls.find((c) => c[0] === "allocateWreckID")[1], { transient: false });
    const stored = a.wrecks.get(placed.wreckId);
    assert.strictEqual(stored.lneSlot, 0);
    assert.strictEqual([...a.items.values()][0].flagID, 4);

    const allocBefore = names(a.calls).filter((n) => n === "allocateWreckID").length;
    const again = nw.placeWreckFrom(a.mods, baseSpec());
    assert.deepStrictEqual(again, { ok: true, adopted: true, wreckId: placed.wreckId, items: 4, factionItems: 0,
      spawned: false,
      vendorWrites: 0 });
    assert.strictEqual(names(a.calls).filter((n) => n === "allocateWreckID").length, allocBefore);

    a.setSummary(ownSummary({ instanceID: INSTANCE + 1 }));
    const fresh = nw.placeWreckFrom(a.mods, baseSpec());
    assert.strictEqual(fresh.ok, true);
    assert.strictEqual(fresh.adopted, false);
    assert.notStrictEqual(fresh.wreckId, placed.wreckId);
    assert.ok(!a.wrecks.has(placed.wreckId), "stale wreck removed");
    assert.strictEqual(a.wrecks.get(fresh.wreckId).dungeonSiteInstanceID, INSTANCE + 1);
    assert.strictEqual(fresh.vendorWrites, 6, "stale removal + wreck + 4 items");

    const b = makeMods({ failItemAt: 1 });
    const failed = nw.placeWreckFrom(b.mods, baseSpec());
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.reason, "WRITE_FAILED");
    assert.ok(names(b.calls).includes("removeNativeWreckCascade"));
    assert.strictEqual(b.wrecks.size, 0);
    assert.strictEqual(b.items.size, 0);

    const c = makeMods({ loaded: true });
    const shown = nw.placeWreckFrom(c.mods, baseSpec({ lootRolls: 0 }));
    assert.strictEqual(shown.spawned, true);
    assert.deepStrictEqual(c.calls.find((x) => x[0] === "spawnNativeWreck"),
      ["spawnNativeWreck", SYSTEM, shown.wreckId, { broadcast: true }]);

    for (const summary of [ownSummary({ metadata: { providerID: "other", lneSiteKey: SITE_KEY, siteID: SITE_ID } }),
      ownSummary({ lifecycleState: "completed" }), null]) {
      const d = makeMods({ summary });
      const refused = nw.placeWreckFrom(d.mods, baseSpec());
      assert.strictEqual(refused.reason, "SITE_NOT_ACTIVE", JSON.stringify(summary && summary.lifecycleState));
      assert.ok(!names(d.calls).includes("allocateWreckID"));
    }
    const e = makeMods();
    assert.deepStrictEqual(nw.placeWreckFrom(e.mods, baseSpec({ siteKey: "dungeon:1" })),
      { ok: false, reason: "SPEC_INVALID", detail: "siteKey", vendorWrites: 0 });
    assert.deepStrictEqual(e.calls, []);

    const f = makeMods();
    const byName = nw.placeWreckFrom(f.mods, baseSpec({ shipTypeId: 0, lootRolls: 0,
      fallbackWreckNames: ["Not A Wreck", "Cruiser Wreck"] }));
    assert.strictEqual(byName.ok, true);
    assert.strictEqual(f.wrecks.get(byName.wreckId).typeID, 26500);
    assert.deepStrictEqual(f.calls.filter((x) => x[0] === "resolveItemByName").map((x) => x[2]),
      [{ exactOnly: true }, { exactOnly: true }]);
    const g = makeMods({ entityType: null });
    assert.strictEqual(nw.placeWreckFrom(g.mods, baseSpec()).reason, "WRECK_TYPE_NOT_FOUND");
    assert.ok(names(g.calls).includes("resolveShipWreckType"));
  });

  test("NW4 remove: destroy in a loaded scene, cascade without, gone, FOREIGN", () => {
    const a = makeMods();
    const placed = nw.placeWreckFrom(a.mods, baseSpec());
    assert.deepStrictEqual(nw.removeWreckFrom(a.mods, "salv:other", placed.wreckId, SYSTEM).reason, "FOREIGN");
    assert.ok(a.wrecks.has(placed.wreckId));
    assert.deepStrictEqual(nw.removeWreckFrom(a.mods, "salv:abc", placed.wreckId, SYSTEM),
      { ok: true, gone: false, vendorWrites: 1 });
    assert.ok(names(a.calls).includes("removeNativeWreckCascade") && !names(a.calls).includes("destroyNativeWreck"));
    assert.strictEqual(a.items.size, 0);
    assert.deepStrictEqual(nw.removeWreckFrom(a.mods, "salv:abc", placed.wreckId, SYSTEM),
      { ok: true, gone: true, vendorWrites: 0 });

    const b = makeMods({ loaded: true });
    const shown = nw.placeWreckFrom(b.mods, baseSpec());
    assert.deepStrictEqual(nw.removeWreckFrom(b.mods, "salv:abc", shown.wreckId, SYSTEM),
      { ok: true, gone: false, vendorWrites: 1 });
    assert.deepStrictEqual(b.calls.find((x) => x[0] === "destroyNativeWreck"),
      ["destroyNativeWreck", shown.wreckId, { broadcast: true }]);

    const c = makeMods();
    const own = nw.placeWreckFrom(c.mods, baseSpec());
    c.mods.runtime.scenes.add(SYSTEM + 1);
    assert.deepStrictEqual(nw.removeWreckFrom(c.mods, "salv:abc", own.wreckId, SYSTEM + 1),
      { ok: true, gone: false, vendorWrites: 1 });
    assert.ok(!names(c.calls).includes("destroyNativeWreck"), "record system not loaded -> cascade");
    assert.deepStrictEqual(c.calls.filter((x) => x[0] === "isSolarSystemSceneLoaded").pop(),
      ["isSolarSystemSceneLoaded", SYSTEM]);
  });

  test("NW5 facade methods and GAME_MODULES entries of salvageAnomaly", () => {
    const { mods } = makeMods();
    const loaded = nw.loadModsFrom((rel) => {
      const key = Object.keys(nw.MODULE_PATHS).find((k) => nw.MODULE_PATHS[k] === rel);
      return key ? { ok: true, exports: mods[key] } : { ok: false, reason: "file_not_found" };
    });
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.mods.gameStore, null, "no gameStore -> flush omitted");
    const facade = nw.createNativeWrecksFacade(loaded.mods);
    assert.deepStrictEqual(Object.keys(facade).filter((k) => k !== "ok"), ["listOwn", "getOwn", "place", "remove",
      "flush", "checkLootTables", "checkWreckNames", "readGrid"]);
    assert.deepStrictEqual([...nw.FACADE_METHODS], ["listOwn", "getOwn", "place", "remove", "flush", "checkLootTables",
      "checkWreckNames", "readGrid"]);
    assert.deepStrictEqual(facade.flush(), { ok: true, durable: null });
    assert.deepStrictEqual(facade.checkLootTables(["a", "missing"]), { ok: true, missing: ["missing"], randomAny: [] });
    assert.deepStrictEqual(facade.checkLootTables(["a", "empty_rule"]),
      { ok: true, missing: ["empty_rule"], randomAny: [] }, "a vendor emptyRule table counts as missing");
    assert.deepStrictEqual(facade.checkLootTables(["a", "zero_entries", "zero_max_only", "no_random"]),
      { ok: true, missing: ["zero_entries", "zero_max_only", "no_random"], randomAny: [] },
      "maxEntries 0 / disableRandomLoot = missing");
    assert.deepStrictEqual(facade.checkLootTables(["no_random_required", "max_zero_min_one", "based_zero"]),
      { ok: true, missing: [], randomAny: ["max_zero_min_one"] },
      "requiredDrops, minEntries 1 (vendor rolls 1) and a base rule still drop");
    assert.deepStrictEqual(facade.checkWreckNames(["Cruiser Wreck", "Not A Wreck", "Hauler Wreck"]),
      { ok: true, missing: ["Not A Wreck", "Hauler Wreck"] });
    assert.deepStrictEqual(facade.listOwn("salv:abc"), { ok: true, wrecks: [] });
    const blind = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(blind.getNativeWrecks().reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(blind.checkNativeWrecks().reason, "SEAM_UNAVAILABLE");

    assert.ok(![...MODULE_NAMES].includes(SALVAGE), "salvageAnomaly is not a module name");
    const entries = new Map(GAME_MODULES.map((e) => [e.path, e]));
    const salvageSymbols = [];
    for (const e of GAME_MODULES) {
      for (const s of e.symbols) {
        if (!s.consumers.includes(SALVAGE)) continue;
        salvageSymbols.push(`${e.path}.${s.name}`);
        assert.ok(s.wrap !== true && s.firstLoad !== true, `${e.path}.${s.name}`);
      }
    }
    const expected = [];
    for (const [key, fns] of Object.entries(nw.REQUIRED_FUNCTIONS)) {
      assert.ok(entries.has(nw.MODULE_PATHS[key]), nw.MODULE_PATHS[key]);
      for (const fn of fns) expected.push(`${nw.MODULE_PATHS[key]}.${fn}`);
    }
    expected.push("space/npc/nativeNpcStore.TABLE", "space/npc/nativeNpcStore.getNativeWreck", "space/runtime.scenes",
      "services/inventory/itemStore.ITEM_FLAGS",
      "gameStore/index.flushTableSync");
    assert.deepStrictEqual(salvageSymbols.sort(), expected.sort());
    const onlySalvage = GAME_MODULES.map((e) => ({ path: e.path,
      symbols: e.symbols.filter((s) => s.consumers.length === 1 && s.consumers[0] === SALVAGE) }))
      .filter((e) => e.symbols.length > 0);
    const salvageOnly = probeModules(onlySalvage, { load: () => ({ ok: true, exports: {} }) });
    assert.deepStrictEqual(Object.keys(salvageOnly.disabledModules), [SALVAGE]);
  });

  const count = (calls, name) => calls.filter((c) => c[0] === name).length;

  test("NW-S1 listOwn without items; getOwn by getNativeWreck, fallback = one scan, same result", () => {
    const a = makeMods({ getOne: true });
    const w0 = nw.placeWreckFrom(a.mods, baseSpec({ slot: 0 })).wreckId;
    const w1 = nw.placeWreckFrom(a.mods, baseSpec({ slot: 1 })).wreckId;
    const foreign = nw.placeWreckFrom(a.mods, baseSpec({ anomalyId: "salv:other", slot: 2 })).wreckId;
    a.calls.length = 0;
    const listed = nw.listOwnWrecksFrom(a.mods, "salv:abc");
    assert.deepStrictEqual(listed, { ok: true, wrecks: [{ slot: 0, wreckId: w0 }, { slot: 1, wreckId: w1 }] });
    assert.strictEqual(count(a.calls, "listNativeWreckItemsForWreck"), 0);
    assert.strictEqual(count(a.calls, "listNativeWrecks"), 1);

    a.calls.length = 0;
    const ids = [w1, foreign, 123, w0, -4, "x"];
    const got = nw.getOwnWrecksFrom(a.mods, "salv:abc", ids);
    assert.deepStrictEqual(got, listed, "foreign and missing skipped, sorted by slot");
    assert.strictEqual(count(a.calls, "listNativeWrecks"), 0);
    assert.strictEqual(count(a.calls, "getNativeWreck"), 4, "only positive safe ints");
    assert.deepStrictEqual(nw.getOwnWrecksFrom(a.mods, "salv:abc", []), { ok: true, wrecks: [] });
    assert.strictEqual(nw.getOwnWrecksFrom(a.mods, "salv:abc", null).reason, "READ_FAILED");

    delete a.mods.store.getNativeWreck;
    a.calls.length = 0;
    assert.deepStrictEqual(nw.getOwnWrecksFrom(a.mods, "salv:abc", ids), listed);
    assert.strictEqual(count(a.calls, "listNativeWrecks"), 1);
  });

  test("NW-S2 place adopt:false skips the scan; adopt invalid; remove through getNativeWreck", () => {
    const a = makeMods({ getOne: true });
    const placed = nw.placeWreckFrom(a.mods, baseSpec({ adopt: false }));
    assert.strictEqual(placed.ok, true);
    assert.strictEqual(placed.adopted, false);
    assert.ok(a.wrecks.has(placed.wreckId), "wreck written");
    assert.strictEqual(count(a.calls, "listNativeWrecks"), 0);
    assert.deepStrictEqual(nw.placeWreckFrom(a.mods, baseSpec({ adopt: "x" })),
      { ok: false, reason: "SPEC_INVALID", detail: "adopt", vendorWrites: 0 });
    assert.strictEqual(nw.placeWreckFrom(a.mods, baseSpec({ adopt: true })).adopted, true);
    assert.strictEqual(count(a.calls, "listNativeWrecks"), 1);

    const other = nw.placeWreckFrom(a.mods, baseSpec({ anomalyId: "salv:other", slot: 5, adopt: false }));
    a.calls.length = 0;
    assert.strictEqual(nw.removeWreckFrom(a.mods, "salv:abc", other.wreckId, SYSTEM).reason, "FOREIGN");
    assert.deepStrictEqual(nw.removeWreckFrom(a.mods, "salv:abc", placed.wreckId, SYSTEM),
      { ok: true, gone: false, vendorWrites: 1 });
    assert.deepStrictEqual(nw.removeWreckFrom(a.mods, "salv:abc", placed.wreckId, SYSTEM),
      { ok: true, gone: true, vendorWrites: 0 });
    assert.strictEqual(count(a.calls, "listNativeWrecks"), 0);
    assert.strictEqual(count(a.calls, "getNativeWreck"), 3);
  });

  test("NW-RS loot source NPC goes with the first roll only; invalid refused", () => {
    const a = makeMods();
    const placed = nw.placeWreckFrom(a.mods, baseSpec({ lootTableId: "loot_belt_normal_medium", lootRolls: 3,
      lootSourceNpcTypeId: 2387 }));
    assert.strictEqual(placed.ok, true);
    assert.strictEqual(count(a.calls, "roll"), 3);
    assert.deepStrictEqual(a.calls.filter((c) => c[0] === "rollOptions").map((c) => c[1]),
      [{ source: { npcTypeID: 2387 } }, { extraRoll: true }, { extraRoll: true }],
      "source once per wreck, on the first roll; later rolls marked extra");
    const b = makeMods();
    assert.strictEqual(nw.placeWreckFrom(b.mods, baseSpec({ lootSourceNpcTypeId: 0 })).ok, true);
    assert.deepStrictEqual(b.calls.filter((c) => c[0] === "rollOptions").map((c) => c[1]), [{ extraRoll: true }],
      "0 = no source: first roll in the old call shape, the second marked extra");
    const c = makeMods();
    assert.strictEqual(nw.placeWreckFrom(c.mods, baseSpec({ lootRolls: 10, lootSourceNpcTypeId: 2387 })).ok, true);
    const opts = c.calls.filter((x) => x[0] === "rollOptions").map((x) => x[1]);
    assert.strictEqual(count(c.calls, "roll"), 10);
    assert.strictEqual(opts.filter((o) => o.extraRoll === true).length, 9);
    assert.deepStrictEqual(opts[0], { source: { npcTypeID: 2387 } }, "roll 0 not extra");
    for (const bad of [-1, 1.5, "2387"]) {
      assert.deepStrictEqual(nw.placeWreckFrom(makeMods().mods, baseSpec({ lootSourceNpcTypeId: bad })),
        { ok: false, reason: "SPEC_INVALID", detail: "lootSourceNpcTypeId", vendorWrites: 0 }, String(bad));
    }
  });

  test("NW-S3 facade getOwn, GAME_MODULES getNativeWreck for salvage, vendor fact", () => {
    const { mods } = makeMods({ getOne: true });
    const facade = nw.createNativeWrecksFacade(mods);
    assert.strictEqual(typeof facade.getOwn, "function");
    assert.ok(nw.FACADE_METHODS.includes("getOwn"));
    assert.deepStrictEqual(facade.getOwn("salv:abc", [1]), { ok: true, wrecks: [] });
    assert.ok(!nw.REQUIRED_FUNCTIONS.store.includes("getNativeWreck"), "optional in the core");
    const entry = GAME_MODULES.find((e) => e.path === "space/npc/nativeNpcStore");
    const s = entry.symbols.find((x) => x.name === "getNativeWreck");
    assert.ok(s && s.consumers.includes(SALVAGE) && s.wrap !== true && s.firstLoad !== true);
    const src = readSource("space/npc/nativeNpcStore.js");
    assert.ok(src.includes("function getNativeWreck("), "definition");
    assert.match(src, /^ {2}getNativeWreck,$/m, "export");
  });

  test("NW-G1 readGrid: scene not loaded -> nothing else called; player in / out of range "
    + "isEmpty true / false / no entity; facade method", () => {
    const calls = [];
    const wrecks = new Map([[11, { isEmpty: true }], [12, { isEmpty: false }]]);
    const dynamic = new Map();
    const scene = {
      dynamicEntities: dynamic,
      getEntityByID(id) {
        calls.push(["getEntityByID", id]);
        return wrecks.get(id) || null;
      },
    };
    const loaded = new Set();
    const runtime = {
      isSolarSystemSceneLoaded(id) {
        calls.push(["isSolarSystemSceneLoaded", id]);
        return loaded.has(id);
      },
      scenes: { get(id) { calls.push(["scenes.get", id]); return id === 30000001 ? scene : undefined; } },
    };
    const mods = { runtime };
    const center = { x: 1000, y: 0, z: 0 };
    assert.deepStrictEqual(nw.readGridFrom(mods, 30000001, [11], center, 250000), { ok: true, sceneLoaded: false });
    assert.deepStrictEqual(calls, [["isSolarSystemSceneLoaded", 30000001]]);
    loaded.add(30000001);
    const read = () => nw.readGridFrom(mods, 30000001, [11, 12, 13], center, 250000);
    dynamic.set(1, { kind: "ship", charID: 0, position: { x: 1000, y: 0, z: 0 } });
    dynamic.set(2, { kind: "drone", charID: 90000001, position: { x: 1000, y: 0, z: 0 } });
    assert.deepStrictEqual(read(), { ok: true, sceneLoaded: true, playerOnGrid: false, playerCharacterId: null,
      wrecks: [
      { wreckId: 11, inScene: true, isEmpty: true }, { wreckId: 12, inScene: true, isEmpty: false },
      { wreckId: 13, inScene: false, isEmpty: null }] });
    dynamic.set(3, { kind: "ship", charID: 90000001, position: { x: 1000 + 250001, y: 0, z: 0 } });
    assert.strictEqual(read().playerOnGrid, false);
    dynamic.set(4, { kind: "ship", characterID: 90000002, position: { x: 1000, y: 200000, z: 0 } });
    assert.strictEqual(read().playerOnGrid, true);
    assert.strictEqual(read().playerCharacterId, 90000002, "OFS1: the pilot of the first ship in range");
    assert.strictEqual(nw.readGridFrom(mods, 30000001, [11], null, 250000).playerOnGrid, false);
    assert.strictEqual(nw.readGridFrom(mods, 0, [11], center, 250000).reason, "READ_FAILED");
    const broken = { runtime: { isSolarSystemSceneLoaded: () => true,
      scenes: { get: () => ({ getEntityByID() { throw new Error("boom"); } }) } } };
    assert.strictEqual(nw.readGridFrom(broken, 30000001, [11], center, 250000).reason, "READ_FAILED");
    const facade = nw.createNativeWrecksFacade(mods);
    assert.strictEqual(facade.readGrid(30000001, [11], center, 250000).wrecks[0].isEmpty, true);
  });
  test("NW-BP1 looted blueprint copies: singleton 2 kept, one item per copy, blueprintState carried", () => {
    const vendor = readSource("space/npc/nativeNpcWreckService.js");
    assert.ok(/Number\(value\) === 2\) return 2/.test(functionBody(vendor, "normalizeWreckSingleton")), "vendor keeps 2");
    const split = functionBody(vendor, "buildNativeLootWreckItems");
    assert.ok(split.includes("lootEntry.singleton === 2 ? lootEntry.quantity : 1") && split.includes("blueprintStates"),
      "vendor: one item per copy with its own blueprintState");
    const st = (n) => ({ original: false, runsRemaining: n, materialEfficiency: 0, timeEfficiency: 0 });
    const a = makeMods({ rollEntries: () => [
      { itemType: { typeID: 33523, name: "'Yurt' Mobile Depot Blueprint" }, quantity: 2, singleton: 2,
        blueprintState: st(1), blueprintStates: [st(1), st(3)] },
      { itemType: { typeID: 34, name: "Tritanium" }, quantity: 50, singleton: false },
      { itemType: { typeID: 2048, name: "Damage Control I Blueprint" }, quantity: 1, singleton: 2, blueprintState: st(5) },
      { itemType: { typeID: 46166, name: "Reaction Formula" }, quantity: 1, singleton: true },
    ] });
    const placed = nw.placeWreckFrom(a.mods, baseSpec({ lootRolls: 1 }));
    assert.strictEqual(placed.ok, true);
    assert.strictEqual(placed.items, 5, "2 copies + stack + 1 copy + original");
    const rows = [...a.items.values()].map((i) => [i.typeID, i.singleton, i.quantity,
      i.blueprintState ? i.blueprintState.runsRemaining : null]);
    assert.deepStrictEqual(rows, [[33523, 2, 1, 1], [33523, 2, 1, 3], [34, false, 50, null], [2048, 2, 1, 5],
      [46166, true, 1, null]]);
    assert.strictEqual(nw.buildWreckItemRecord(a.mods, { wreckID: 1, ownerID: 1 }, { typeID: 1 },
      { singleton: 2, quantity: 7 }).data.quantity, 1, "copy record quantity 1 like the vendor");
  });

  test("NW-FX1 place with fixedItems: minerals written after the loot rolls (sourceKind loot), adoption no dup",
    () => {
      const a = makeMods({ typeById: { 34: "Tritanium", 35: "Pyerite" } });
      const spec = baseSpec({ lootRolls: 1, fixedItems: [{ typeId: 34, quantity: 2000 }, { typeId: 35, quantity: 500 }] });
      const placed = nw.placeWreckFrom(a.mods, spec);
      assert.strictEqual(placed.ok, true, JSON.stringify(placed));
      assert.strictEqual(placed.items, 4, "2 loot items + 2 minerals");
      const writes = a.calls.filter((c) => c[0] === "upsertNativeWreckItem" || c[0] === "roll").map((c) => c.slice(0, 2));
      assert.deepStrictEqual(writes, [["roll", "parity_guristas_standard"], ["upsertNativeWreckItem", 101],
        ["upsertNativeWreckItem", 102], ["upsertNativeWreckItem", 34], ["upsertNativeWreckItem", 35]]);
      const minerals = [...a.items.values()].filter((i) => i.typeID < 100)
        .map((i) => [i.typeID, i.itemName, i.quantity, i.singleton, i.sourceKind]);
      assert.deepStrictEqual(minerals, [[34, "Tritanium", 2000, false, "loot"], [35, "Pyerite", 500, false, "loot"]]);
      const again = nw.placeWreckFrom(a.mods, spec);
      assert.deepStrictEqual([again.ok, again.adopted, again.wreckId, again.vendorWrites, a.items.size],
        [true, true, placed.wreckId, 0, 4]);
    });

  test("NW-FX2 fixedItems validation: bad shapes and an unknown type -> SPEC_INVALID fixedItems, no write", () => {
    const ok = { typeId: 34, quantity: 1 };
    for (const bad of [{}, [ok, ok, ok, ok, ok, ok, ok, ok, ok], [{ typeId: 0, quantity: 1 }],
      [{ typeId: 34, quantity: 0 }], [{ typeId: 34, quantity: 1.5 }], [{ typeId: "34", quantity: 1 }],
      [{ typeId: 34, quantity: nw.FIXED_ITEM_MAX_QUANTITY + 1 }], [{ typeId: 34, quantity: 1, extra: 1 }], [null]]) {
      assert.strictEqual(nw.validatePlaceSpec(baseSpec({ fixedItems: bad })), "fixedItems", JSON.stringify(bad));
    }
    assert.strictEqual(nw.validatePlaceSpec(baseSpec({ fixedItems: [ok] })), null);
    assert.strictEqual(nw.validatePlaceSpec(baseSpec({ fixedItems: [] })), null);
    const m = makeMods({ typeById: { 34: "Tritanium" } });
    assert.deepStrictEqual(nw.placeWreckFrom(m.mods, baseSpec({ fixedItems: [ok, { typeId: 99999, quantity: 1 }] })),
      { ok: false, reason: "SPEC_INVALID", detail: "fixedItems", vendorWrites: 0 });
    assert.ok(!names(m.calls).includes("allocateWreckID"));
  });
};

Object.assign(module.exports, { harness: Object.freeze({ makeMods, baseSpec, names }) });
