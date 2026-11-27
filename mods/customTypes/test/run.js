"use strict";

process.env.EVEJS_CUSTOMTYPES_NO_INSTALL = "1";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const srcRoot = path.join(runtimeRoot, "server", "src");
const loader = require(path.join(modDir, "loader.js"));
const configModule = require(path.join(modDir, "config.js"));
const packLib = require(path.join(modDir, "lib", "pack.js"));
const viability = require(path.join(modDir, "lib", "viability.js"));
const limits = require(path.join(modDir, "lib", "limits.js"));
const generator = require(path.join(modDir, "tools", "genPiBlueprints.js"));
const officerGenerator = require(path.join(modDir, "tools", "genOfficerBlueprints.js"));
const shopCatalog = require(path.join(modDir, "lib", "shop", "catalog.js"));
const shopPlan = require(path.join(modDir, "lib", "shop", "plan.js"));
const shopRunner = require(path.join(modDir, "lib", "shop", "runner.js"));
const shopIssuer = require(path.join(modDir, "lib", "shop", "issuer.js"));
const shopVendor = require(path.join(modDir, "lib", "shop", "vendor.js"));

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? null : String(process.argv[onlyAt + 1] || "").split(",").filter(Boolean);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const clone = (value) => JSON.parse(JSON.stringify(value));

const VANILLA_TYPES = Object.freeze([
  { typeID: 971, groupID: 106, categoryID: 9, groupName: "Cruiser Blueprint", name: "Vexor Blueprint",
    basePrice: 83250000, marketGroupID: 276, iconID: null, graphicID: 62, portionSize: 1, volume: 0.01,
    published: true },
  { typeID: 626, groupID: 26, categoryID: 6, groupName: "Cruiser", name: "Vexor", published: true },
  { typeID: 2073, groupID: 1032, categoryID: 42, groupName: "Planet Organic - Raw Resource",
    name: "Microorganisms", iconID: 10034, published: true },
  { typeID: 2393, groupID: 1042, categoryID: 43, groupName: "Basic Commodities - Tier 1", name: "Bacteria",
    iconID: 10029, published: true },
  { typeID: 3380, groupID: 268, categoryID: 16, groupName: "Production", name: "Industry", published: true },
  { typeID: 33196, groupID: 447, categoryID: 9, groupName: "Construction Component Blueprints",
    name: "Spatial Attunement Unit Blueprint", iconID: 2185, basePrice: 5000000, portionSize: 1, volume: 0.01,
    published: true },
  { typeID: 3388, groupID: 268, categoryID: 16, groupName: "Production", name: "Advanced Industry", published: true },
  { typeID: 2389, groupID: 1042, categoryID: 43, groupName: "Basic Commodities - Tier 1", name: "Plasmoids",
    iconID: 10017, published: true },
  { typeID: 3645, groupID: 1042, categoryID: 43, groupName: "Basic Commodities - Tier 1", name: "Water",
    iconID: 1178, published: true },
  { typeID: 9838, groupID: 1034, categoryID: 43, groupName: "Refined Commodities - Tier 2", name: "Superconductors",
    iconID: 1363, published: true },
  { typeID: 2344, groupID: 1040, categoryID: 43, groupName: "Specialized Commodities - Tier 3", name: "Condensates",
    iconID: 10039, published: true },
  { typeID: 9848, groupID: 1040, categoryID: 43, groupName: "Specialized Commodities - Tier 3", name: "Robotics",
    iconID: 1368, published: true },
  { typeID: 2870, groupID: 1041, categoryID: 43, groupName: "Advanced Commodities - Tier 4",
    name: "Organic Mortar Applicators", iconID: 10076, published: true },
  { typeID: 81080, groupID: 4736, categoryID: 46, groupName: "Skyhook", name: "Orbital Skyhook", graphicID: 27169,
    marketGroupID: 1410, portionSize: 1, volume: 8000, published: true },
  { typeID: 81086, groupID: 1045, categoryID: 9, groupName: "Sovereignty Structure Blueprint",
    name: "Orbital Skyhook Blueprint", basePrice: 5500000000, graphicID: 27169, marketGroupID: 3651, portionSize: 1,
    volume: 0.01, published: true },
  ...[[34, "Tritanium"], [35, "Pyerite"], [36, "Mexallon"], [37, "Isogen"], [38, "Nocxium"], [39, "Zydrine"],
    [40, "Megacyte"]].map(([typeID, name]) => ({ typeID, groupID: 18, categoryID: 4, groupName: "Mineral", name,
    published: true })),
  ...[[16631, 426, "Mobile Projectile Sentry", "Small Artillery Battery"], [16690, 449, "Mobile Hybrid Sentry", "Small Railgun Battery"],
    [17167, 430, "Mobile Laser Sentry", "Small Beam Laser Battery"], [16696, 417, "Mobile Missile Sentry", "Cruise Missile Battery"]]
    .map(([typeID, groupID, groupName, name]) => ({ typeID, groupID, categoryID: 23, groupName, name, basePrice: 500000,
      portionSize: 1, volume: 500, published: true })),
  ...[[2816, 854, "Starbase - Projectile Battery Blueprints", "Small Artillery Battery Blueprint"],
    [2815, 855, "Starbase - Hybrid Battery Blueprints", "Small Railgun Battery Blueprint"],
    [2826, 853, "Starbase - Laser Battery Blueprints", "Small Beam Laser Battery Blueprint"],
    [2823, 871, "Starbase - Missile Battery Blueprints", "Cruise Missile Battery Blueprint"]]
    .map(([typeID, groupID, groupName, name]) => ({ typeID, groupID, categoryID: 9, groupName, name, published: true })),
]);

const PI_PACK = "pi-blueprints.json";
const DRILL_PACK = "planetary-drill.json";
const VARIANT_TYPE_IDS = Object.freeze(Array.from({ length: 15 }, (_, index) => 340102 + index));
const VARIANT_BLUEPRINT_IDS = Object.freeze(VARIANT_TYPE_IDS.map((typeID) => typeID + 100));
const VEXOR_MINERALS = Object.freeze([
  [34, 540000], [35, 180000], [36, 36000], [37, 10000], [38, 1500], [39, 350], [40, 140],
].map(([typeID, quantity]) => Object.freeze({ quantity, typeID })));

const VEXOR_DEFINITION = Object.freeze({
  blueprintTypeID: 971, blueprintName: "Vexor Blueprint", blueprintGroupID: 106, blueprintCategoryID: 9,
  blueprintCategoryName: "Blueprint", productTypeID: 626, productCategoryID: 6, productCategoryName: "Ship",
  maxProductionLimit: 10, published: true,
  activities: { manufacturing: { materials: [{ quantity: 540000, typeID: 34 }], products: [{ quantity: 1, typeID: 626 }],
    skills: [{ level: 1, typeID: 3380 }], time: 12000 } },
});

function blueprintTable() {
  return {
    blueprintDefinitions: [clone(VEXOR_DEFINITION)],
    blueprintDefinitionsByTypeID: { 971: clone(VEXOR_DEFINITION) },
    blueprintTypeIDsByProductTypeID: { 626: 971 },
    manufacturingBlueprintTypeIDs: [971],
  };
}

function makeFakeStore(tables, processRole = "world") {
  return {
    _processRole: processRole,
    reads: 0,
    read(table, pth) {
      this.reads += 1;
      if (!(table in tables)) return { success: false, errorMsg: "TABLE_NOT_FOUND", data: null };
      return pth === "/" ? { success: true, errorMsg: null, data: tables[table] } : { success: false, data: null };
    },
    tableExists(table) {
      return table in tables;
    },
  };
}

function makeFakeReference(raw) {
  const cache = new Map();
  function readStaticTable(tableName) {
    if (cache.has(tableName)) return cache.get(tableName);
    const payload = raw[tableName] || {};
    cache.set(tableName, payload);
    return payload;
  }
  const rowKey = { itemTypes: "types", shipTypes: "ships", movementAttributes: "attributes" };
  function readStaticRows(tableName) {
    const payload = readStaticTable(tableName);
    const rows = rowKey[tableName] ? payload[rowKey[tableName]] : undefined;
    return Array.isArray(rows) ? rows : [];
  }
  return { TABLE: { ITEM_TYPES: "itemTypes", TYPE_DOGMA: "typeDogma" }, readStaticTable, readStaticRows };
}

function realEntries(file = null) {
  const loaded = packLib.loadPackFiles(loader.DATA_DIR);
  assert.deepStrictEqual(loaded.problems, []);
  return file ? loaded.entries.filter((entry) => entry.file === file) : loaded.entries;
}

const PI_SCHEMATICS = Object.freeze([
  { schematicID: 131, cycleTime: 1800, inputs: [{ typeID: 2073, quantity: 3000 }], outputs: [{ typeID: 2393, quantity: 20 }] },
  { schematicID: 65, cycleTime: 3600, inputs: [{ typeID: 2389, quantity: 40 }, { typeID: 3645, quantity: 40 }],
    outputs: [{ typeID: 9838, quantity: 5 }] },
  { schematicID: 112, cycleTime: 3600,
    inputs: [{ typeID: 2344, quantity: 6 }, { typeID: 2393, quantity: 40 }, { typeID: 9848, quantity: 6 }],
    outputs: [{ typeID: 2870, quantity: 1 }] },
]);
const PI_SPEC = JSON.parse(fs.readFileSync(path.join(modDir, "tools", "pi-blueprints.spec.json"), "utf8"));

function typesByIDOf(rows) {
  return new Map(rows.map((row) => [row.typeID, { name: row.name, iconID: row.iconID == null ? null : row.iconID,
    groupID: row.groupID }]));
}

function fixtureEntries(withDrill = true) {
  const built = generator.buildPiBlueprintPack(clone(PI_SCHEMATICS), typesByIDOf(VANILLA_TYPES), PI_SPEC);
  assert.ok(built.ok, built.reason);
  return [{ file: PI_PACK, pack: built.pack }, ...(withDrill ? realEntries(DRILL_PACK) : [])];
}

function makeRuntime({
  entries = fixtureEntries(), cleanup = false, environment = {}, guard = { ok: true, count: 0 },
  shopEnabled = false, makeShopRunner = null,
} = {}) {
  const logs = [];
  const errors = [];
  const runtime = loader._testing.createRuntime({
    config: { enabled: true, cleanup, shop: configModule.SHOP_DEFAULTS },
    entries,
    environment,
    logFn: (message) => logs.push(message),
    logErrorFn: (message) => errors.push(message),
    makeShopVendor: () => ({ countOutstandingHolding: () => guard }),
    shopEnabled,
    makeShopRunner,
  });
  return { runtime, logs, errors };
}

function countType(rows, typeID) {
  return rows.filter((row) => row.typeID === typeID).length;
}

test("T1 real industryStaticData: pack blueprint visible through getBlueprintDefinitionByTypeID, once after two hooks", () => {
  const storePath = require.resolve(path.join(srcRoot, "gameStore"));
  assert.ok(!require.cache[storePath], "real gameStore must not be loaded in the test process");
  const tables = { itemTypes: { types: clone(VANILLA_TYPES) }, industryBlueprints: blueprintTable() };
  const store = makeFakeStore(tables);
  const fakeModule = new Module(storePath);
  fakeModule.filename = storePath;
  fakeModule.loaded = true;
  fakeModule.exports = store;
  require.cache[storePath] = fakeModule;

  const { runtime, logs, errors } = makeRuntime();
  const hookState = loader._testing.installModuleHook(runtime, runtimeRoot, (message) => errors.push(message));
  let industry;
  let reference;
  try {
    industry = require(path.join(srcRoot, "services", "industry", "industryStaticData"));
    reference = require(path.join(srcRoot, "services", "_shared", "referenceData"));
  } finally {
    Module._load = hookState.previousLoad;
  }
  assert.deepStrictEqual(errors, []);
  assert.ok(logs.includes("pack pi-blueprints: 3 types, 3 blueprints"), logs.join(" | "));
  assert.ok(logs.includes("pack planetary-drill: 32 types, 16 blueprints"), logs.join(" | "));
  assert.ok(logs.includes("industryBlueprints: +19 custom blueprint definitions"), logs.join(" | "));
  assert.strictEqual(industry.getBlueprintDefinitionByProductTypeID(340100).blueprintTypeID, 340101);

  const definition = industry.getBlueprintDefinitionByTypeID(340431);
  assert.ok(definition, "custom definition visible");
  assert.deepStrictEqual(Object.keys(definition.activities), ["manufacturing"]);
  assert.deepStrictEqual(definition.activities.manufacturing.materials, [{ quantity: 3000, typeID: 2073 }]);
  assert.deepStrictEqual(definition.activities.manufacturing.products, [{ quantity: 20, typeID: 2393 }]);
  assert.strictEqual(definition.activities.manufacturing.time, 1800);
  assert.strictEqual(definition.blueprintName, "Bacteria Blueprint");
  assert.strictEqual(definition.blueprintCategoryID, 9);
  assert.strictEqual(industry.getBlueprintDefinitionByProductTypeID(2393).blueprintTypeID, 340431);
  assert.strictEqual(industry.getBlueprintDefinitionByTypeID(971).productTypeID, 626, "vanilla kept");

  assert.deepStrictEqual(runtime.applyIndustry(industry), { ok: true });
  const table = tables.industryBlueprints;
  assert.strictEqual(table.blueprintDefinitions.filter((row) => row.blueprintTypeID === 340431).length, 1);
  assert.strictEqual(table.blueprintTypeIDsByProductTypeID["2393"], 340431);
  assert.deepStrictEqual(table.manufacturingBlueprintTypeIDs, [971, 340365, 340412, 340431, 340101, ...VARIANT_BLUEPRINT_IDS]);
  assert.strictEqual(table.blueprintDefinitionsByTypeID["340431"].productTypeID, 2393);
  assert.strictEqual(industry.getBlueprintDefinitionByProductTypeID(340104).blueprintTypeID, 340204);
  assert.strictEqual(runtime.stats.definitionsAdded, 19);

  assert.strictEqual(reference.readStaticTable[loader.WRAPPED], true);
  const rows = reference.readStaticRows(reference.TABLE.ITEM_TYPES);
  assert.strictEqual(countType(rows, 340431), 1);
  const row = rows.find((entry) => entry.typeID === 340431);
  assert.deepStrictEqual([row.categoryID, row.groupID, row.iconID, row.basePrice, row.marketGroupID],
    [9, 447, 10029, 0, null]);
  assert.strictEqual(row.name, "Bacteria Blueprint");
  assert.strictEqual(row.published, false);
  assert.strictEqual(definition.published, false);
  assert.strictEqual(rows.filter((t) => t.categoryID === 9 && t.published !== false).some((t) => t.typeID === 340431), false);
});

test("T2 itemTypes row added once in both read orders; typeDogma copy; double wrap is a no-op", () => {
  for (const order of ["table-first", "rows-first"]) {
    const reference = makeFakeReference({
      itemTypes: { types: clone(VANILLA_TYPES) },
      typeDogma: { typesByTypeID: {
        33196: { typeID: 33196, typeName: "Spatial Attunement Unit Blueprint", attributes: { 1955: 2 } } } },
    });
    const { runtime, errors } = makeRuntime();
    runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
    const originalTable = reference.readStaticTable;
    assert.deepStrictEqual(runtime.applyReference(reference), { ok: true });
    assert.deepStrictEqual(runtime.applyReference(reference), { ok: true });
    assert.notStrictEqual(reference.readStaticTable, originalTable);
    if (order === "table-first") {
      const payload = reference.readStaticTable("itemTypes");
      assert.strictEqual(reference.readStaticTable("itemTypes"), payload, "same memoised payload");
    }
    reference.readStaticRows("itemTypes");
    const rows = reference.readStaticRows("itemTypes");
    reference.readStaticTable("itemTypes");
    assert.strictEqual(countType(rows, 340431), 1, order);
    assert.strictEqual(rows.length, VANILLA_TYPES.length + 35, order);
    const dogma = reference.readStaticTable("typeDogma").typesByTypeID["340431"];
    assert.deepStrictEqual(dogma, { typeID: 340431, typeName: "Bacteria Blueprint", attributes: { 1955: 2 } });
    assert.deepStrictEqual(errors, [], order);
  }
});

test("T3b overrides.description accepted (copied only onto a row with the field); non-string or too long refused", () => {
  const vanilla = { itemTypeRows: clone(VANILLA_TYPES), blueprintDefinitions: [VEXOR_DEFINITION] };
  const pack = (description) => ({ packID: "desc", types: [{ typeID: 340600, sourceTypeID: 971,
    overrides: { name: "Desc Blueprint", description } }], blueprints: [] });
  const ok = packLib.buildPlan([{ file: "d.json", pack: pack("How to use it.") }], clone(vanilla));
  assert.strictEqual(ok.rejected.length, 0);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ok.packs[0].typeRows[0], "description"), false);
  const withField = clone(vanilla);
  withField.itemTypeRows.find((row) => row.typeID === 971).description = "vanilla";
  const copied = packLib.buildPlan([{ file: "d.json", pack: pack("How to use it.") }], withField);
  assert.strictEqual(copied.packs[0].typeRows[0].description, "How to use it.");
  for (const bad of [42, "", "x".repeat(2001)]) {
    const plan = packLib.buildPlan([{ file: "d.json", pack: pack(bad) }], clone(vanilla));
    assert.strictEqual(plan.rejected.length, 1);
    assert.match(plan.rejected[0].reason, /description must be a non-empty string/u);
  }
  const drill = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "..", "data", "planetary-drill.json"), "utf8"));
  assert.match(drill.types[0].overrides.description, /Planetary Drill \(Aqueous Liquids\)/u);
  assert.deepStrictEqual(drill.types.filter((entry) => entry.overrides.description.includes("[PI:")).map((entry) => entry.typeID), []);
});

test("T3 pack with a product collision or a typeID out of range is refused whole", () => {
  const collision = {
    packID: "collision",
    types: [{ typeID: 340500, sourceTypeID: 971, overrides: { name: "Second Vexor Blueprint" } }],
    blueprints: [{ blueprintTypeID: 340500, productTypeID: 626, maxProductionLimit: 1,
      activities: { manufacturing: { products: [{ quantity: 1, typeID: 626 }], time: 10 } } }],
  };
  const outOfRange = { packID: "range", types: [{ typeID: 95000, sourceTypeID: 971 }], blueprints: [] };
  const entries = [
    { file: "a.json", pack: collision },
    { file: "b.json", pack: outOfRange },
    ...fixtureEntries(),
  ];
  const plan = packLib.buildPlan(entries, { itemTypeRows: clone(VANILLA_TYPES), blueprintDefinitions: [VEXOR_DEFINITION] });
  assert.deepStrictEqual(plan.packs.map((pack) => pack.packID), ["pi-blueprints", "planetary-drill"]);
  assert.strictEqual(plan.rejected.length, 2);
  assert.match(plan.rejected[0].reason, /product 626 already has a blueprint/u);
  assert.match(plan.rejected[1].reason, /outside 340000-349999/u);

  const reference = makeFakeReference({ itemTypes: { types: clone(VANILLA_TYPES) } });
  const { runtime, errors } = makeRuntime({ entries: [{ file: "a.json", pack: collision }] });
  runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
  runtime.applyReference(reference);
  const rows = reference.readStaticRows("itemTypes");
  assert.strictEqual(rows.length, VANILLA_TYPES.length);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /^pack collision \(a\.json\) refused: .*whole pack skipped$/u);
});

test("T4 ENABLED=false (default) or DRIFT: no hook, exports and caches untouched", () => {
  assert.strictEqual(configModule.load(path.join(modDir, "no-such-dir"), {}).enabled, false);
  assert.strictEqual(configModule.DEFAULTS.cleanup, false);
  const reference = makeFakeReference({ itemTypes: { types: clone(VANILLA_TYPES) } });
  const before = { table: reference.readStaticTable, rows: reference.readStaticRows, load: Module._load };
  const disabled = loader.install({ environment: { EVEJS_CUSTOMTYPES_ENABLED: "0" } });
  assert.strictEqual(disabled.active, false);
  assert.strictEqual(disabled.reason, "disabled");
  const drift = loader.install({
    environment: { EVEJS_CUSTOMTYPES_ENABLED: "1" },
    inspect: () => ({ ok: false, reports: [{ key: "referenceData", ok: false, reason: "seam count 0" }] }),
    logErrorFn: () => {},
  });
  assert.strictEqual(drift.reason, "not-viable");
  const bad = loader.install({ environment: { EVEJS_CUSTOMTYPES_ENABLED: "maybe" }, logErrorFn: () => {} });
  assert.strictEqual(bad.reason, "invalid-config");
  assert.strictEqual(Module._load, before.load);
  assert.strictEqual(globalThis[loader.INSTALL_FLAG], undefined);
  assert.strictEqual(reference.readStaticTable, before.table);
  assert.strictEqual(reference.readStaticRows, before.rows);
  assert.strictEqual(countType(reference.readStaticRows("itemTypes"), 340431), 0);
});

test("T5 vendor facts: seams of the probe present in EveJS sources", () => {
  const report = viability.inspect(runtimeRoot);
  assert.ok(report.ok, report.reports.filter((entry) => !entry.ok).map((entry) => `${entry.key}: ${entry.reason}`).join("; "));
  const read = (relative) => fs.readFileSync(path.join(srcRoot, ...relative.split("/")), "utf8").replace(/\r\n/gu, "\n");
  const staticData = read("services/industry/industryStaticData.js");
  assert.match(staticData, /module\.exports = \{\n {2}clearIndustryStaticCaches,\n/u);
  assert.match(staticData, /payload\.blueprintDefinitions/u);
  assert.match(read("services/industry/industryConstants.js"), /const INDUSTRY_BLUEPRINT_TABLE = "industryBlueprints";/u);
  assert.match(read("services/industry/industryRuntimeState.js"), /MISMATCH_TIME/u);
});

test("T6 shipped data/pi-blueprints.json vs SDE: 68 BP, typeID = 340300 + schematicID, 340431 = schematic 131", () => {
  const [{ pack }] = realEntries(PI_PACK);
  assert.strictEqual(pack.types.length, 68);
  assert.strictEqual(pack.blueprints.length, 68);
  const typeIDs = new Set(pack.types.map((entry) => entry.typeID));
  assert.ok(pack.blueprints.every((entry) => typeIDs.has(entry.blueprintTypeID)), "every blueprint has its type");
  assert.deepStrictEqual([pack.types[0].typeID, pack.types[67].typeID], [340365, 340435]);
  const bacteria = pack.blueprints.find((entry) => entry.blueprintTypeID === 340431);
  assert.deepStrictEqual(bacteria, { blueprintTypeID: 340431, productTypeID: 2393, maxProductionLimit: 100,
    activities: { manufacturing: { materials: [{ quantity: 3000, typeID: 2073 }], products: [{ quantity: 20, typeID: 2393 }],
      skills: [{ level: 1, typeID: 3380 }], time: 1800 } } });
  const sdeFile = path.join(runtimeRoot, "_local", "sde", "eve-online-static-data-3396210-jsonl", "planetSchematics.jsonl");
  if (!fs.existsSync(sdeFile)) return;
  const bytes = fs.readFileSync(sdeFile);
  const lfText = bytes.toString("utf8").replace(/\r\n/gu, "\n");
  assert.ok(pack.source.includes(`planetSchematics.jsonl ${crypto.createHash("sha1").update(lfText).digest("hex")}`),
    pack.source);
  const parsed = generator.parseSchematicsJsonl(bytes.toString("utf8"));
  assert.ok(parsed.ok, parsed.reason);
  assert.strictEqual(parsed.schematics.length, 68);
  const blueprints = new Map(pack.blueprints.map((entry) => [entry.blueprintTypeID, entry]));
  for (const schematic of parsed.schematics) {
    const blueprint = blueprints.get(340300 + schematic.schematicID);
    assert.ok(blueprint, `schematic ${schematic.schematicID}`);
    assert.strictEqual(blueprint.productTypeID, schematic.outputs[0].typeID, `schematic ${schematic.schematicID}`);
    const manufacturing = blueprint.activities.manufacturing;
    const byTypeID = (a, b) => a.typeID - b.typeID;
    assert.deepStrictEqual(manufacturing.materials,
      schematic.inputs.map((input) => ({ quantity: input.quantity, typeID: input.typeID })).sort(byTypeID),
      `materials of schematic ${schematic.schematicID}`);
    assert.deepStrictEqual(manufacturing.products,
      [{ quantity: schematic.outputs[0].quantity, typeID: schematic.outputs[0].typeID }], `product ${schematic.schematicID}`);
    assert.strictEqual(manufacturing.time, Math.round(schematic.cycleTime * PI_SPEC.timeFactor),
      `time of schematic ${schematic.schematicID}`);
  }
});


test("T7 CLEANUP: world process only, accepted packs only, items with contents skipped, bootWorld passed through", async () => {
  const items = [
    { itemID: 1, typeID: 340431, locationID: 60003760 }, { itemID: 2, typeID: 34, locationID: 60003760 },
    { itemID: 3, typeID: 340431, locationID: 60003760 }, { itemID: 4, typeID: 34, locationID: 3 },
    { itemID: 5, typeID: 340431, locationID: 60003760 }, { itemID: 6, typeID: 340700, locationID: 60003760 },
  ];
  const vanillaWithForge = [...clone(VANILLA_TYPES), { typeID: 340700, groupID: 26, categoryID: 6, name: "Forge Item" }];
  let removed = [];
  const itemStore = {
    listItemsMatching: (predicate) => clone(items.filter(predicate)),
    removeInventoryItem: (itemID) => {
      removed.push(itemID);
      return { success: true };
    },
  };
  function worldRuntime(entries, role = "world", guard = undefined) {
    const made = makeRuntime({ entries, cleanup: true, environment: { EVEJS_GAMESTORE_OWNER_ROLE: "world" }, guard });
    made.runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }, role));
    made.runtime.apply("items", itemStore);
    made.runtime.applyReference(makeFakeReference({ itemTypes: { types: clone(vanillaWithForge) } }));
    return made;
  }

  const other = worldRuntime(fixtureEntries(false), "market");
  assert.deepStrictEqual(other.runtime.runCleanup(), { ok: false, reason: "not-world" });
  assert.deepStrictEqual(removed, []);

  const forgeCollision = { packID: "forge", types: [{ typeID: 340700, sourceTypeID: 971 }], blueprints: [] };
  const refused = worldRuntime([{ file: "forge.json", pack: forgeCollision }]);
  assert.deepStrictEqual(refused.runtime.runCleanup(), { ok: true, removed: 0, failed: 0, skippedWithContents: 0 });
  assert.match(refused.errors.join(" | "), /pack forge \(forge\.json\) refused: type 340700 already exists in the SDE/u);
  assert.deepStrictEqual(removed, []);

  const blind = makeRuntime({ entries: fixtureEntries(false), cleanup: true,
    environment: { EVEJS_GAMESTORE_OWNER_ROLE: "world" } });
  blind.runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }, "world"));
  blind.runtime.apply("items", itemStore);
  blind.runtime.applyReference(makeFakeReference({ itemTypes: { types: [] } }));
  assert.deepStrictEqual(blind.runtime.runCleanup(), { ok: false, reason: "no-vanilla-rows" });
  assert.ok(blind.errors.includes("CLEANUP refused: vanilla itemTypes rows were not read - nothing removed"),
    blind.errors.join(" | "));
  assert.deepStrictEqual(removed, []);

  const held = worldRuntime(fixtureEntries(false), "world", { ok: true, count: 2, outstanding: 2, inProgress: 0 });
  assert.deepStrictEqual(held.runtime.runCleanup(),
    { ok: false, reason: "contracts-outstanding", count: 2, outstanding: 2, inProgress: 0 });
  assert.ok(held.errors.includes("CLEANUP refused: 2 outstanding contracts hold custom types - "
    + "set EVEJS_CUSTOMTYPES_SHOP_DELIST=1 first"), held.errors.join(" | "));
  assert.deepStrictEqual(removed, []);

  const courier = worldRuntime(fixtureEntries(false), "world", { ok: true, count: 1, outstanding: 0, inProgress: 1 });
  assert.deepStrictEqual(courier.runtime.runCleanup(),
    { ok: false, reason: "contracts-outstanding", count: 1, outstanding: 0, inProgress: 1 });
  assert.ok(courier.errors.some((line) => /courier/u.test(line)), courier.errors.join(" | "));
  assert.ok(!courier.errors.some((line) => /SHOP_DELIST/u.test(line)), courier.errors.join(" | "));
  assert.deepStrictEqual(removed, []);

  removed = [];
  const world = worldRuntime(fixtureEntries(false));
  const booted = Promise.resolve("booted");
  const bootstrap = { bootWorld: function bootWorld(options) { return options === 7 ? booted : null; } };
  assert.deepStrictEqual(world.runtime.applyBootstrap(bootstrap), { ok: true });
  const result = bootstrap.bootWorld(7);
  assert.strictEqual(result, booted);
  await result;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(removed, [1, 5]);
  assert.strictEqual(world.runtime.stats.skippedWithContents, 1);
  assert.ok(world.logs.includes("CLEANUP: item 3 (type 340431) has contents - skipped, not removed"), world.logs.join(" | "));
  assert.ok(world.logs.includes("CLEANUP removed 2 items of 3 custom types (0 failed, 1 skipped with contents)"),
    world.logs.join(" | "));
});

test("T8 data/planetary-drill.json: guards pass; BP 340101 -> 340100 with exactly the Vexor 971 ME0 minerals", () => {
  const plan = packLib.buildPlan(realEntries(DRILL_PACK), { itemTypeRows: clone(VANILLA_TYPES), blueprintDefinitions: [VEXOR_DEFINITION] });
  assert.deepStrictEqual(plan.rejected, []);
  const [pack] = plan.packs;
  assert.strictEqual(pack.packID, "planetary-drill");
  const rows = new Map(pack.typeRows.map((row) => [row.typeID, row]));
  const drill = rows.get(340100);
  assert.deepStrictEqual([drill.name, drill.groupID, drill.categoryID, drill.marketGroupID, drill.published, drill.volume],
    ["Planetary Drill", 4736, 46, null, true, 8000]);
  const blueprint = rows.get(340101);
  assert.deepStrictEqual([blueprint.name, blueprint.groupID, blueprint.categoryID, blueprint.basePrice, blueprint.published],
    ["Planetary Drill Blueprint", 1045, 9, 0, false]);
  const [definition, ...variantDefinitions] = pack.definitions;
  assert.deepStrictEqual([definition.blueprintTypeID, definition.productTypeID, definition.maxProductionLimit],
    [340101, 340100, 10]);
  assert.strictEqual(pack.typeRows.length, 32);
  assert.deepStrictEqual(variantDefinitions.map((entry) => [entry.blueprintTypeID, entry.productTypeID]),
    VARIANT_TYPE_IDS.map((typeID) => [typeID + 100, typeID]));
  for (const typeID of VARIANT_TYPE_IDS) {
    const variant = rows.get(typeID);
    const variantBlueprint = rows.get(typeID + 100);
    assert.match(variant.name, /^Planetary Drill \([A-Za-z -]+\)$/u, String(typeID));
    assert.deepStrictEqual([variant.groupID, variant.categoryID, variant.marketGroupID, variant.published], [4736, 46, null, true]);
    assert.deepStrictEqual([variantBlueprint.name, variantBlueprint.groupID, variantBlueprint.categoryID, variantBlueprint.basePrice,
      variantBlueprint.published], [`${variant.name} Blueprint`, 1045, 9, 0, false]);
    const variantDefinition = variantDefinitions.find((entry) => entry.productTypeID === typeID);
    const expected = clone(definition.activities);
    expected.manufacturing.products = [{ quantity: 1, typeID }];
    assert.deepStrictEqual(variantDefinition.activities, expected, String(typeID));
    assert.strictEqual(variantDefinition.maxProductionLimit, definition.maxProductionLimit);
  }
  assert.deepStrictEqual(Object.keys(definition.activities).sort(),
    ["copying", "manufacturing", "research_material", "research_time"], "no invention");
  const manufacturing = definition.activities.manufacturing;
  assert.deepStrictEqual(manufacturing.materials, VEXOR_MINERALS);
  assert.deepStrictEqual(manufacturing.products, [{ quantity: 1, typeID: 340100 }]);
  assert.deepStrictEqual(manufacturing.skills, [{ level: 1, typeID: 3380 }]);
  assert.deepStrictEqual([manufacturing.time, definition.activities.copying.time,
    definition.activities.research_material.time, definition.activities.research_time.time], [12000, 9600, 4200, 4200]);
  const sdeFile = path.join(runtimeRoot, "_local", "sde", "eve-online-static-data-3396210-jsonl", "blueprints.jsonl");
  if (fs.existsSync(sdeFile)) {
    const line = fs.readFileSync(sdeFile, "utf8").split(/\r?\n/u).find((text) => text.startsWith("{\"_key\": 971,"));
    const vexor = JSON.parse(line);
    assert.deepStrictEqual(manufacturing.materials, vexor.activities.manufacturing.materials);
    assert.deepStrictEqual([manufacturing.time, manufacturing.skills, definition.maxProductionLimit],
      [vexor.activities.manufacturing.time, vexor.activities.manufacturing.skills, vexor.maxProductionLimit]);
    for (const key of ["copying", "research_material", "research_time"]) {
      assert.strictEqual(definition.activities[key].time, vexor.activities[key].time, key);
    }
  }
  const shipped = [PI_PACK, DRILL_PACK].flatMap((file) =>
    JSON.parse(fs.readFileSync(path.join(loader.DATA_DIR, file), "utf8")).types);
  const drillSource = shipped.find((entry) => entry.typeID === 340101);
  assert.deepStrictEqual([drillSource.sourceTypeID, drillSource.overrides.groupID], [33196, 1045]);
  const dogmaFile = path.join(runtimeRoot, "_local", "sde", "eve-online-static-data-3396210-jsonl", "typeDogma.jsonl");
  if (fs.existsSync(dogmaFile)) {
    const withDogma = new Set(fs.readFileSync(dogmaFile, "utf8").split(/\r?\n/u).filter(Boolean)
      .map((text) => JSON.parse(text)._key));
    assert.strictEqual(withDogma.has(81086), false, "vendor fact: Orbital Skyhook Blueprint has no typeDogma record");
    assert.deepStrictEqual([...new Set(shipped.map((entry) => entry.sourceTypeID))].filter((id) => !withDogma.has(id)), [],
      "every shipped source has a typeDogma record");
  }
});

test("T9 generator (fixture P1/P2/P4): materials, product x quantity, time, skills; deterministic; refusals", () => {
  const typesByID = typesByIDOf(VANILLA_TYPES);
  const built = generator.buildPiBlueprintPack(clone(PI_SCHEMATICS), typesByID, PI_SPEC);
  assert.ok(built.ok, built.reason);
  const { pack, summary } = built;
  assert.deepStrictEqual(summary, { count: 3, byTier: { P1: 1, P2: 1, P3: 0, P4: 1 }, typeIDMin: 340365, typeIDMax: 340431 });
  assert.deepStrictEqual(pack.types.map((entry) => entry.typeID), [340365, 340412, 340431]);
  assert.deepStrictEqual(pack.blueprints.map((entry) => entry.blueprintTypeID), [340365, 340412, 340431]);
  const [superconductors, mortar, bacteria] = pack.blueprints;
  for (const blueprint of pack.blueprints) assert.deepStrictEqual(Object.keys(blueprint.activities), ["manufacturing"]);
  assert.deepStrictEqual(bacteria.activities.manufacturing, { materials: [{ quantity: 3000, typeID: 2073 }],
    products: [{ quantity: 20, typeID: 2393 }], skills: [{ level: 1, typeID: 3380 }], time: 1800 });
  assert.deepStrictEqual(superconductors.activities.manufacturing.materials,
    [{ quantity: 40, typeID: 2389 }, { quantity: 40, typeID: 3645 }]);
  assert.deepStrictEqual(superconductors.activities.manufacturing.products, [{ quantity: 5, typeID: 9838 }]);
  assert.deepStrictEqual(superconductors.activities.manufacturing.skills, [{ level: 2, typeID: 3380 }]);
  assert.deepStrictEqual(mortar.activities.manufacturing, {
    materials: [{ quantity: 6, typeID: 2344 }, { quantity: 40, typeID: 2393 }, { quantity: 6, typeID: 9848 }],
    products: [{ quantity: 1, typeID: 2870 }], skills: [{ level: 4, typeID: 3380 }, { level: 3, typeID: 3388 }], time: 3600 });
  assert.deepStrictEqual([mortar.productTypeID, mortar.maxProductionLimit], [2870, 100]);
  assert.deepStrictEqual(pack.types[1], { typeID: 340412, sourceTypeID: 33196, overrides: {
    name: "Organic Mortar Applicators Blueprint", groupID: 447, iconID: 10076, basePrice: 0, marketGroupID: null } });

  const reversed = clone(PI_SCHEMATICS).reverse().map((schematic) => ({ ...schematic, inputs: schematic.inputs.reverse() }));
  const viaJsonl = generator.parseSchematicsJsonl(reversed.map((schematic) => JSON.stringify({ _key: schematic.schematicID,
    cycleTime: schematic.cycleTime, types: [...schematic.outputs.map((o) => ({ _key: o.typeID, isInput: false, quantity: o.quantity })),
      ...schematic.inputs.map((i) => ({ _key: i.typeID, isInput: true, quantity: i.quantity }))].reverse() })).join("\r\n"));
  assert.ok(viaJsonl.ok, viaJsonl.reason);
  const again = generator.buildPiBlueprintPack(viaJsonl.schematics, new Map([...typesByID].reverse()), PI_SPEC);
  assert.strictEqual(generator.serializePack(again.pack), generator.serializePack(pack));
  assert.ok(generator.serializePack(pack).endsWith("}\n"));

  const quantity7 = clone(PI_SCHEMATICS);
  quantity7[1].outputs[0].quantity = 7;
  assert.deepStrictEqual(generator.buildPiBlueprintPack(quantity7, typesByID, PI_SPEC),
    { ok: false, reason: "schematic 65: output quantity 7 matches no tier" });
  const nameTaken = new Map(typesByID).set(1, { name: " bacteria blueprint", iconID: null, groupID: 1 });
  const named = generator.buildPiBlueprintPack(clone(PI_SCHEMATICS), nameTaken, PI_SPEC);
  assert.strictEqual(named.ok, false);
  assert.match(named.reason, /^schematic 131: name "Bacteria Blueprint" already used/u);
  const idTaken = new Map(typesByID).set(340431, { name: "Somebody Else", iconID: null, groupID: 1 });
  assert.deepStrictEqual(generator.buildPiBlueprintPack(clone(PI_SCHEMATICS), idTaken, PI_SPEC),
    { ok: false, reason: "schematic 131: typeID 340431 already exists in the SDE" });
});

test("T10 README PI table = render of the shipped pack (no drift; names re-checked against the pack)", () => {
  const block = generator.extractReadmeTable(fs.readFileSync(path.join(modDir, "README.md"), "utf8"));
  assert.ok(block, "README has the pi-blueprints-table markers");
  const [{ pack }] = realEntries(PI_PACK);
  const rendered = generator.renderReadmeTable(pack, PI_SPEC, generator.namesFromReadmeTable(block));
  assert.ok(rendered.ok, rendered.reason);
  assert.strictEqual(rendered.rows, 68);
  assert.strictEqual(block, rendered.text,
    "README table drifted: node mods/customTypes/tools/genPiBlueprints.js --readme-table --sde <SDE jsonl dir>");
  assert.ok(block.includes("| 340431 | Bacteria Blueprint | P1 | Bacteria (2393) | 20 | 1800 s | 3000 Microorganisms (2073) |"));
});

const SENTRY_PACK = "mobile-sentries.json";
const SENTRY_TABLE = Object.freeze([
  [340500, 16631, 426, 340510, 854, [[34, 7729], [35, 2648], [36, 771]], 6000, 30, 4800, 2100],
  [340501, 16690, 449, 340511, 855, [[34, 7729], [35, 2648], [36, 771]], 6000, 30, 4800, 2100],
  [340502, 17167, 430, 340512, 853, [[34, 7200], [35, 3309], [36, 621]], 6000, 30, 4800, 2100],
  [340503, 16696, 417, 340513, 871, [[34, 8258], [35, 5426], [36, 707]], 12000, 10, 9600, 4200],
]);

test("T11 data/mobile-sentries.json: 8 types, 4 BP; sentries keep the battery group (cat 23); BP materials = plain minerals", () => {
  const entries = realEntries(SENTRY_PACK);
  assert.strictEqual(entries[0].pack.version, 2);
  const plan = packLib.buildPlan(entries, { itemTypeRows: clone(VANILLA_TYPES), blueprintDefinitions: [VEXOR_DEFINITION] });
  assert.deepStrictEqual(plan.rejected, []);
  const [pack] = plan.packs;
  assert.strictEqual(pack.packID, "mobile-sentries");
  assert.strictEqual(pack.typeRows.length, 8);
  assert.strictEqual(pack.definitions.length, 4);
  const shipped = new Map(entries[0].pack.types.map((entry) => [entry.typeID, entry]));
  const rows = new Map(pack.typeRows.map((row) => [row.typeID, row]));
  for (const [typeID, sourceTypeID, groupID, blueprintTypeID, blueprintGroupID, materials, time, max, copy, research] of SENTRY_TABLE) {
    assert.strictEqual(shipped.get(typeID).sourceTypeID, sourceTypeID);
    assert.strictEqual("groupID" in shipped.get(typeID).overrides, false, `${typeID}: no groupID override`);
    const row = rows.get(typeID);
    assert.deepStrictEqual([row.groupID, row.categoryID, row.published, row.marketGroupID], [groupID, 23, true, null], String(typeID));
    assert.match(row.name, /^Mobile Sentry \((Projectile|Hybrid|Laser|Missile)\)$/u);
    const blueprint = rows.get(blueprintTypeID);
    assert.deepStrictEqual([shipped.get(blueprintTypeID).sourceTypeID, blueprint.name, blueprint.groupID, blueprint.categoryID,
      blueprint.basePrice, blueprint.published], [33196, `${row.name} Blueprint`, blueprintGroupID, 9, 0, false]);
    const definition = pack.definitions.find((entry) => entry.blueprintTypeID === blueprintTypeID);
    assert.deepStrictEqual([definition.productTypeID, definition.maxProductionLimit], [typeID, max]);
    assert.deepStrictEqual(definition.activities, {
      copying: { time: copy },
      manufacturing: { materials: materials.map(([id, quantity]) => ({ quantity, typeID: id })),
        products: [{ quantity: 1, typeID }], skills: [{ level: 5, typeID: 3380 }], time },
      research_material: { time: research },
      research_time: { time: research },
    }, String(blueprintTypeID));
  }

  const reference = makeFakeReference({ itemTypes: { types: clone(VANILLA_TYPES) } });
  const { runtime, logs, errors } = makeRuntime({ entries });
  runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
  runtime.applyReference(reference);
  reference.readStaticRows("itemTypes");
  assert.deepStrictEqual(errors, []);
  assert.ok(logs.includes("pack mobile-sentries: 8 types, 4 blueprints"), logs.join(" | "));
});

const MATERIAL_PATH_FINGERPRINTS = Object.freeze([
  ["services/industry/industryRuntimeState.js", "resolveMonitorAvailableMaterials(session, request)",
    "63ad2ed35bb8cbc3f6980b61cfead358444116c9"],
  ["services/industry/industryRuntimeState.js", "resolveAvailableMaterials(ownerID, inputLocation)",
    "6c98d5aa78038ddd047b8eec9971f00b67269f38"],
  ["services/industry/industryRuntimeState.js", "getBlueprintByItemID(itemID, session = null)",
    "05f50594fb46bed9b80882e33bba49f0572ebdf3"],
  ["services/industry/industryStaticData.js", "ensureBlueprintCache()", "7347858c8e60c7b5a2e74952ca374f7945e39d78"],
  ["services/industry/industryStaticData.js", "getBlueprintDefinitionByTypeID(blueprintTypeID)",
    "f39268373d40747d389fb2aaf450ed425b056247"],
  ["services/industry/industryParityHelpers.js", "getIndustryActivity(definition, activityID)",
    "65a90934f44157ee7e5c0103c6b192a35ee37f7d"],
]);

test("T12 sentry BP materials reach the vendor Industry material path (real industryStaticData, DRIFT fingerprint)", () => {
  for (const [file, header, expected] of MATERIAL_PATH_FINGERPRINTS) {
    const source = fs.readFileSync(path.join(srcRoot, ...file.split("/")), "utf8").replace(/\r\n/gu, "\n");
    const body = viability.functionBodyOf(source, `function ${header} {`);
    assert.ok(body, `DRIFT ${file}: function ${header} not found`);
    assert.strictEqual(crypto.createHash("sha1").update(body).digest("hex"), expected, `DRIFT ${file}: ${header}`);
  }
  const runtimeSource = fs.readFileSync(path.join(srcRoot, "services", "industry", "industryRuntimeState.js"), "utf8")
    .replace(/\r\n/gu, "\n");
  assert.match(runtimeSource, /getBlueprintDefinitionByTypeID,\n(?:\s+\w+,\n)*\} = require\(path\.join\(__dirname, "\.\/industryStaticData"\)\);/u,
    "DRIFT industryRuntimeState: getBlueprintDefinitionByTypeID no longer imported from industryStaticData");

  const storePath = require.resolve(path.join(srcRoot, "gameStore"));
  const industryPath = require.resolve(path.join(srcRoot, "services", "industry", "industryStaticData"));
  const saved = { store: require.cache[storePath], industry: require.cache[industryPath] };
  const tables = { itemTypes: { types: clone(VANILLA_TYPES) }, industryBlueprints: blueprintTable() };
  const fakeModule = new Module(storePath);
  fakeModule.filename = storePath;
  fakeModule.loaded = true;
  fakeModule.exports = makeFakeStore(tables);
  require.cache[storePath] = fakeModule;
  delete require.cache[industryPath];
  const { runtime, logs, errors } = makeRuntime({ entries: realEntries(SENTRY_PACK) });
  const reference = makeFakeReference({ itemTypes: tables.itemTypes });
  runtime.applyReference(reference);
  const hookState = loader._testing.installModuleHook(runtime, runtimeRoot, (message) => errors.push(message));
  let industry;
  try {
    industry = require(industryPath);
  } finally {
    Module._load = hookState.previousLoad;
    if (saved.store) require.cache[storePath] = saved.store;
    else delete require.cache[storePath];
    if (saved.industry) require.cache[industryPath] = saved.industry;
    else delete require.cache[industryPath];
  }
  assert.deepStrictEqual(errors, []);
  assert.ok(logs.includes("industryBlueprints: +4 custom blueprint definitions"), logs.join(" | "));
  for (const [typeID, , , blueprintTypeID, , materials] of SENTRY_TABLE) {
    const definition = industry.getBlueprintDefinitionByTypeID(blueprintTypeID);
    assert.ok(definition, `definition ${blueprintTypeID}`);
    assert.strictEqual(definition.blueprintCategoryID, 9);
    assert.strictEqual(industry.getBlueprintDefinitionByProductTypeID(typeID).blueprintTypeID, blueprintTypeID);
    assert.deepStrictEqual(definition.activities.manufacturing.materials,
      materials.map(([id, quantity]) => ({ quantity, typeID: id })), String(blueprintTypeID));
  }
});

test("T13 ConnectJob trace: pack BP only, reply/exception unchanged, 1 line per window, DRIFT/off/bad config", () => {
  const report = viability.inspectMonitor(runtimeRoot);
  assert.ok(report.ok, report.reports.filter((entry) => !entry.ok).map((entry) => `${entry.key}: ${entry.reason}`).join("; "));
  const cfg = configModule.load(NO_TRACE_DIR, {});
  assert.deepStrictEqual([cfg.trace.enabled, cfg.trace.windowMinutes, cfg.traceProblems], [true, 10, []]);
  const bad = configModule.load(NO_TRACE_DIR, { EVEJS_CUSTOMTYPES_CONNECTJOB_TRACE: "maybe",
    EVEJS_CUSTOMTYPES_CONNECTJOB_TRACE_MINUTES: "0" });
  assert.deepStrictEqual([bad.trace.enabled, bad.traceProblems.length, bad.problems], [false, 2, []]);
  assert.strictEqual(configModule.load(NO_TRACE_DIR, { EVEJS_CUSTOMTYPES_CONNECTJOB_TRACE_MINUTES: "3" }).trace.windowMinutes, 3);

  let clock = 1000000;
  const logs = [];
  const errors = [];
  const runtime = loader._testing.createRuntime({
    config: { enabled: true, cleanup: false, shop: configModule.SHOP_DEFAULTS, trace: cfg.trace },
    entries: realEntries(SENTRY_PACK), environment: {}, traceEnabled: true, now: () => clock,
    logFn: (message) => logs.push(message), logErrorFn: (message) => errors.push(message),
  });
  runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
  runtime.applyReference(makeFakeReference({ itemTypes: { types: clone(VANILLA_TYPES) } }));
  runtime.ensurePlan();
  const definition = runtime.state.plan.packs[0].definitions.find((entry) => entry.blueprintTypeID === 340510);
  const blueprints = {
    7: { typeID: 340510, itemID: 7, ownerID: 140001221, facilityID: 60012595, locationID: 60012595, flagID: 4,
      original: true, jobID: null },
    8: { typeID: 971, itemID: 8, ownerID: 140001221, facilityID: 60012595, locationID: 60012595, flagID: 4, original: true },
  };
  let blueprintThrows = false;
  assert.deepStrictEqual(runtime.apply("payloads", { parseIndustryRequest: (raw) => raw }), { ok: true });
  assert.deepStrictEqual(runtime.apply("runtimeState", { getBlueprintByItemID: (id) => {
    if (blueprintThrows) throw new Error("boom");
    return blueprints[id] || null;
  } }), { ok: true });
  runtime.deps.industry = { getBlueprintDefinitionByTypeID: (typeID) => (typeID === 340510 ? definition : null) };
  let replyThrows = null;
  class FakeMonitor {
    Handle_ConnectJob(args) {
      if (replyThrows) throw replyThrows;
      return [662, { type: "dict", entries: [[34, 103616], [35, 132773], [36, 500]] }, args];
    }
  }
  const original = FakeMonitor.prototype.Handle_ConnectJob;
  assert.deepStrictEqual(runtime.apply("monitor", FakeMonitor), { ok: true });
  assert.deepStrictEqual(runtime.apply("monitor", FakeMonitor), { ok: true });
  assert.strictEqual(FakeMonitor.prototype.Handle_ConnectJob[loader.WRAPPED], true);
  assert.ok(logs.includes("ConnectJob trace on - wrapped industryMonitor.Handle_ConnectJob (pack blueprints only, "
    + "1 line per character/blueprint/activity per 10 min)"), logs.join(" | "));
  const service = new FakeMonitor();
  const session = { characterID: 140001221 };
  const packRequest = { blueprintID: 7, blueprintTypeID: 340510, activityID: 1, facilityID: 60012595, runs: 1,
    inputLocation: { itemID: 60012595, flagID: 4, ownerID: 140001221 } };
  logs.length = 0;

  const vanillaArgs = [{ blueprintID: 8, blueprintTypeID: 971, activityID: 1 }];
  const vanillaReply = service.Handle_ConnectJob(vanillaArgs, session);
  assert.strictEqual(vanillaReply[2], vanillaArgs);
  assert.deepStrictEqual(logs, []);

  const packArgs = [packRequest];
  const reply = service.Handle_ConnectJob(packArgs, session);
  assert.deepStrictEqual(reply, original.call(service, packArgs, session));
  assert.strictEqual(reply[2], packArgs);
  assert.deepStrictEqual(logs, ["CONNECTJOB_TRACE char=140001221 bpItem=7 bpType=340510 activity=1 facility=60012595 "
    + "input=60012595/4/140001221 bpOwner=140001221 bpFacility=60012595 bpLocation=60012595 bpFlag=4 bpOriginal=true "
    + "bpJob=0 runs=1 def=34x7729,35x2648,36x771 avail=34x103616,35x132773,36x500 short=36 monitor=662 result=ok"]);

  service.Handle_ConnectJob(packArgs, session);
  assert.strictEqual(logs.length, 1);
  service.Handle_ConnectJob([{ ...packRequest, activityID: 4 }], session);
  assert.strictEqual(logs.length, 2);
  assert.match(logs[1], / activity=4 .* def=none avail=/u);
  clock += 10 * 60 * 1000;
  service.Handle_ConnectJob(packArgs, session);
  assert.strictEqual(logs.length, 3);

  clock += 10 * 60 * 1000;
  replyThrows = new TypeError("bad request");
  assert.throws(() => service.Handle_ConnectJob(packArgs, session), (error) => error === replyThrows);
  assert.match(logs[3], / avail=none short=34,35,36 monitor=0 result=error:TypeError:bad request$/u);
  replyThrows = null;

  clock += 10 * 60 * 1000;
  blueprintThrows = true;
  assert.deepStrictEqual(service.Handle_ConnectJob(packArgs, session)[0], 662);
  assert.strictEqual(logs.length, 4);
  assert.strictEqual(runtime.traceStats().failures, 1);
  assert.deepStrictEqual(errors.filter((message) => !/ConnectJob trace failed - ignored/u.test(message)), []);

  const off = makeRuntime({ entries: realEntries(SENTRY_PACK) });
  class OffMonitor { Handle_ConnectJob() { return null; } }
  const offOriginal = OffMonitor.prototype.Handle_ConnectJob;
  assert.deepStrictEqual(off.runtime.apply("monitor", OffMonitor), { ok: true });
  assert.strictEqual(OffMonitor.prototype.Handle_ConnectJob, offOriginal);
  const drifted = loader._testing.createRuntime({
    config: { enabled: true, cleanup: false, shop: configModule.SHOP_DEFAULTS, trace: cfg.trace },
    entries: realEntries(SENTRY_PACK), traceEnabled: true, logFn: () => {}, logErrorFn: (message) => errors.push(message),
  });
  assert.deepStrictEqual(drifted.apply("monitor", class Other {}), { ok: false, reason: "drift" });
  assert.strictEqual(drifted.state.inert, false);
  assert.ok(errors.includes("DRIFT industryMonitorService.Handle_ConnectJob - ConnectJob trace off (custom types unaffected)"));
});

test("T14 gameStore.preloadAll replaces the industryBlueprints cache object: pack BP definitions added again", () => {
  const storeSource = fs.readFileSync(path.join(srcRoot, "gameStore", "index.js"), "utf8").replace(/\r\n/gu, "\n");
  const preloadBody = viability.functionBodyOf(storeSource, "function preloadAll() {");
  assert.ok(preloadBody && preloadBody.includes("const bytes = loadTable(table);"), "DRIFT gameStore.preloadAll: loadTable per table");
  const loadBody = viability.functionBodyOf(storeSource, "function loadTable(table) {");
  assert.ok(loadBody && loadBody.includes("cache[table] = parsed.data;") && loadBody.includes("cache[table] = parsedMain.data;"),
    "DRIFT gameStore.loadTable: cache[table] gets a new parsed object");
  assert.match(storeSource, /\n {2}read,\n[\s\S]*\n {2}preloadAll,\n/u, "DRIFT gameStore exports read/preloadAll");
  const bootSource = fs.readFileSync(path.join(srcRoot, "..", "bootstrap.js"), "utf8").replace(/\r\n/gu, "\n");
  assert.ok(bootSource.includes("const database = require(path.join(__dirname, \"./src/gameStore\"));")
    && bootSource.includes("    database.preloadAll();"), "DRIFT bootstrap: database.preloadAll() on the exports object");
  assert.strictEqual(viability.inspect(runtimeRoot).ok, true);

  const storePath = require.resolve(path.join(srcRoot, "gameStore"));
  const industryPath = require.resolve(path.join(srcRoot, "services", "industry", "industryStaticData"));
  const saved = { store: require.cache[storePath], industry: require.cache[industryPath] };
  const tables = { itemTypes: { types: clone(VANILLA_TYPES) }, industryBlueprints: blueprintTable() };
  const store = makeFakeStore(tables);
  const preloadCalls = [];
  const preloadResult = { preloaded: true };
  let readThrows = false;
  const plainRead = store.read;
  store.read = function read(table, pth) {
    if (readThrows) throw new Error("read failed");
    return plainRead.call(this, table, pth);
  };
  const originalPreload = function preloadAll() {
    preloadCalls.push({ self: this, args: [...arguments] });
    tables.industryBlueprints = blueprintTable();
    return preloadResult;
  };
  store.preloadAll = originalPreload;
  const fakeModule = new Module(storePath);
  fakeModule.filename = storePath;
  fakeModule.loaded = true;
  fakeModule.exports = store;
  require.cache[storePath] = fakeModule;
  delete require.cache[industryPath];
  const { runtime, logs, errors } = makeRuntime({ entries: realEntries(SENTRY_PACK) });
  runtime.applyReference(makeFakeReference({ itemTypes: tables.itemTypes }));
  const hookState = loader._testing.installModuleHook(runtime, runtimeRoot, (message) => errors.push(message));
  let industry;
  try {
    industry = require(industryPath);
  } finally {
    Module._load = hookState.previousLoad;
    if (saved.store) require.cache[storePath] = saved.store;
    else delete require.cache[storePath];
    if (saved.industry) require.cache[industryPath] = saved.industry;
    else delete require.cache[industryPath];
  }
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(store.preloadAll[loader.WRAPPED], true, "gameStore.preloadAll wrapped through the hook");
  assert.ok(industry.getBlueprintDefinitionByTypeID(340512), "before preloadAll");

  const before = tables.industryBlueprints;
  assert.strictEqual(store.preloadAll("x"), preloadResult);
  assert.deepStrictEqual(preloadCalls.map((call) => [call.self === store, call.args]), [[true, ["x"]]]);
  assert.notStrictEqual(tables.industryBlueprints, before);
  assert.ok(logs.includes("industryBlueprints: +4 custom blueprint definitions (again after gameStore.preloadAll)"), logs.join(" | "));
  for (const [typeID, , , blueprintTypeID, , materials] of SENTRY_TABLE) {
    const definition = industry.getBlueprintDefinitionByTypeID(blueprintTypeID);
    assert.ok(definition, `definition ${blueprintTypeID} after preloadAll`);
    assert.deepStrictEqual(definition.activities.manufacturing.materials,
      materials.map(([id, quantity]) => ({ quantity, typeID: id })), String(blueprintTypeID));
    assert.strictEqual(industry.getBlueprintDefinitionByProductTypeID(typeID).blueprintTypeID, blueprintTypeID);
    assert.strictEqual(tables.industryBlueprints.blueprintDefinitions.filter((row) => row.blueprintTypeID === blueprintTypeID).length, 1);
  }
  assert.strictEqual(industry.getBlueprintDefinitionByTypeID(971).productTypeID, 626, "vanilla kept");
  assert.strictEqual(runtime.stats.definitionsAdded, 4, "a re-add is not counted again");

  const wrapped = store.preloadAll;
  assert.deepStrictEqual(runtime.apply("store", store), { ok: true });
  assert.strictEqual(store.preloadAll, wrapped);
  readThrows = true;
  assert.strictEqual(store.preloadAll(), preloadResult);
  readThrows = false;
  assert.strictEqual(runtime.stats.failures, 1);

  tables.industryBlueprints = blueprintTable();
  industry.clearIndustryStaticCaches();
  assert.strictEqual(industry.getBlueprintDefinitionByTypeID(340512), null);

  const early = makeRuntime({ entries: realEntries(SENTRY_PACK) });
  const earlyTables = { industryBlueprints: blueprintTable() };
  const earlyStore = makeFakeStore(earlyTables);
  earlyStore.preloadAll = () => { earlyTables.industryBlueprints = blueprintTable(); };
  early.runtime.applyReference(makeFakeReference({ itemTypes: { types: clone(VANILLA_TYPES) } }));
  assert.deepStrictEqual(early.runtime.apply("store", earlyStore), { ok: true });
  earlyStore.preloadAll();
  assert.strictEqual(earlyTables.industryBlueprints.blueprintDefinitions.length, 1);
  assert.deepStrictEqual(early.runtime.applyIndustry(industry), { ok: true });
  assert.strictEqual(earlyTables.industryBlueprints.blueprintDefinitions.length, 5);
  assert.deepStrictEqual(early.errors, []);
});
const NO_TRACE_DIR = path.join(modDir, "no-such-dir");

const NO_DIR = path.join(modDir, "no-such-dir");
const shopConfig = (env = {}) => configModule.load(NO_DIR, env).shop;
const HUBS = Object.freeze([60003760, 60008494, 60011866, 60004588, 60005686]);
const ORE = 1000129;
const ORE_CEO = 3004501;

function fixturePlan(withDrill = true) {
  const plan = packLib.buildPlan(fixtureEntries(withDrill), { itemTypeRows: clone(VANILLA_TYPES), blueprintDefinitions: [VEXOR_DEFINITION] });
  assert.deepStrictEqual(plan.rejected, []);
  return plan;
}

test("T-S1 shop config: defaults, lists, prices, overrides; a bad shop key goes to shopProblems only", () => {
  const defaults = configModule.load(NO_DIR, {});
  assert.deepStrictEqual(defaults.shopProblems, []);
  const shop = defaults.shop;
  assert.deepStrictEqual([shop.enabled, shop.delist, [...shop.stations], shop.issuerCorporationID, shop.issuerAccountKey,
    shop.contractsPerType, shop.blueprintKind, shop.copyRuns, shop.contractDays, shop.renewHours, shop.passSeconds,
    shop.firstPassSeconds, shop.maxActionsPerPass, shop.backoffMaxMinutes, shop.priceOverrides.size],
  [false, false, HUBS, ORE, 1000, 3, "original", 10, 30, 24, 30, 30, 40, 30, 0]);
  assert.deepStrictEqual({ ...shop.price }, { P1: 2000000, P2: 8000000, P3: 25000000, P4: 60000000, drill: 150000000, default: 10000000,
    officer: 1000000000 });

  const parsed = configModule.load(NO_DIR, {
    EVEJS_CUSTOMTYPES_ENABLED: "1", EVEJS_CUSTOMTYPES_SHOP_ENABLED: "1", EVEJS_CUSTOMTYPES_SHOP_STATIONS: " 60003760 , 60008494 ",
    EVEJS_CUSTOMTYPES_SHOP_PRICE_P1: "3000000", EVEJS_CUSTOMTYPES_SHOP_PRICE_OVERRIDES: "340431=5000000, 340101=1",
    EVEJS_CUSTOMTYPES_SHOP_BLUEPRINT_KIND: "Copy", EVEJS_CUSTOMTYPES_SHOP_CONTRACTS_PER_TYPE: "5",
  });
  assert.deepStrictEqual([parsed.problems, parsed.shopProblems], [[], []]);
  assert.deepStrictEqual([parsed.shop.enabled, [...parsed.shop.stations], parsed.shop.price.P1, parsed.shop.blueprintKind,
    parsed.shop.contractsPerType, [...parsed.shop.priceOverrides]],
  [true, [60003760, 60008494], 3000000, "copy", 5, [[340431, 5000000], [340101, 1]]]);

  for (const [key, value, pattern] of [
    ["CONTRACTS_PER_TYPE", "0", /CONTRACTS_PER_TYPE must be an integer 1-10/u],
    ["BLUEPRINT_KIND", "x", /BLUEPRINT_KIND must be original or copy/u],
    ["RENEW_HOURS", "168", /RENEW_HOURS \(168\) must be below EVEJS_CUSTOMTYPES_SHOP_CONTRACT_DAYS\*24 \(168\)/u],
    ["STATIONS", "60003760,60003760", /STATIONS must be a list of 1-20 distinct station IDs/u],
    ["PRICE_OVERRIDES", "340431:5", /PRICE_OVERRIDES must be a list typeID=isk/u],
    ["PRICE_P4", "1000000000001", /PRICE_P4 must be an ISK amount/u],
  ]) {
    const env = { EVEJS_CUSTOMTYPES_ENABLED: "1", [`EVEJS_CUSTOMTYPES_SHOP_${key}`]: value };
    if (key === "RENEW_HOURS") env.EVEJS_CUSTOMTYPES_SHOP_CONTRACT_DAYS = "7";
    const loaded = configModule.load(NO_DIR, env);
    assert.deepStrictEqual(loaded.problems, [], key);
    assert.strictEqual(loaded.enabled, true, `${key}: the mod (types) stays on`);
    assert.strictEqual(loaded.shopProblems.length, 1, key);
    assert.match(loaded.shopProblems[0], pattern, key);
  }
  const orphan = configModule.load(NO_DIR, { EVEJS_CUSTOMTYPES_SHOP_ENABLED: "1" });
  assert.deepStrictEqual(orphan.problems, []);
  assert.deepStrictEqual(orphan.shopProblems, ["EVEJS_CUSTOMTYPES_SHOP_ENABLED=1 needs EVEJS_CUSTOMTYPES_ENABLED=1"]);
});

test("T-S2 shop catalog (P1-P4 from Industry, drill, override) and planner decisions", () => {
  const plan = fixturePlan();
  const catalog = shopCatalog.buildCatalog(plan, shopConfig({ EVEJS_CUSTOMTYPES_SHOP_PRICE_OVERRIDES: "340412=7" }));
  assert.strictEqual(catalog.length, 19);
  const byType = new Map(catalog.map((entry) => [entry.typeID, entry]));
  assert.deepStrictEqual([340431, 340365, 340412, 340101, 340204].map((id) => [byType.get(id).priceClass, byType.get(id).price]),
    [["P1", 2000000], ["P2", 8000000], ["P4", 7], ["drill", 150000000], ["drill", 150000000]]);
  assert.deepStrictEqual([byType.get(340431).name, byType.get(340431).kindTag, byType.get(340431).runs], ["Bacteria Blueprint", "o", null]);
  assert.deepStrictEqual(catalog.map((entry) => entry.typeID), [...catalog.map((entry) => entry.typeID)].sort((a, b) => a - b));
  const other = shopCatalog.buildCatalog({ packs: [{ packID: "other", definitions: [{ blueprintTypeID: 340900, blueprintName: "X Blueprint",
    maxProductionLimit: 5, activities: {} }] }] }, shopConfig({ EVEJS_CUSTOMTYPES_SHOP_BLUEPRINT_KIND: "copy",
    EVEJS_CUSTOMTYPES_SHOP_COPY_RUNS: "50" }));
  assert.deepStrictEqual([other[0].priceClass, other[0].price, other[0].runs, other[0].kindTag], ["default", 10000000, 5, "c5"]);
  assert.deepStrictEqual(shopCatalog.unknownOverrideTypeIDs(catalog, shopConfig({ EVEJS_CUSTOMTYPES_SHOP_PRICE_OVERRIDES: "340412=7,999=1" })), [999]);
  assert.strictEqual(shopPlan.titleOf(byType.get(340431)), "Bacteria Blueprint (BPO)");

  const nowFt = 1000000n;
  const lead = 100n;
  const base = { nowFt, renewLeadFt: lead, stations: [...HUBS], catalog, perType: 3, kindTag: "o", ours: [],
    busyStations: new Set(), delist: false, maxActions: 40, outstandingStatus: 0 };
  const empty = shopPlan.planPass(base);
  assert.deepStrictEqual([empty.creates.length, empty.deletes.length, empty.stats.target, empty.stats.deficit, empty.stats.budgetCut],
    [40, 0, 285, 285, true]);
  assert.deepStrictEqual(empty.creates[0], { stationID: 60003760, typeID: 340101, price: 150000000, title: "Planetary Drill Blueprint (BPO)" });
  assert.strictEqual(shopPlan.planPass({ ...base, maxActions: 500 }).creates.length, 285);

  const one = [byType.get(340431)];
  const A = 60003760;
  const B = 60008494;
  const c = (contractID, extra = {}) => ({ contractID, stationID: A, typeID: 340431, price: 2000000, kindTag: "o", status: 0,
    dateExpiredFt: nowFt + 1000n, pending: false, ...extra });
  const small = { ...base, stations: [A, B], catalog: one, maxActions: 100 };
  const full = [c(1), c(2), c(3), c(11, { stationID: B }), c(12, { stationID: B }), c(13, { stationID: B })];
  const steady = shopPlan.planPass({ ...small, ours: full });
  assert.deepStrictEqual([steady.creates, steady.deletes, steady.stats.live, steady.stats.target], [[], [], 6, 6]);

  const expiring = shopPlan.planPass({ ...small, ours: [c(1), c(2), c(3, { dateExpiredFt: nowFt + lead - 1n }), ...full.slice(3)] });
  assert.deepStrictEqual(expiring.deletes, [{ contractID: 3, cause: "EXPIRING" }]);
  assert.deepStrictEqual(expiring.creates.map((entry) => entry.stationID), [A], "refilled in the same pass");

  const price = shopPlan.planPass({ ...small, ours: [c(1), c(2), c(3, { price: 1 }), ...full.slice(3)] });
  assert.deepStrictEqual([price.deletes, price.creates], [[{ contractID: 3, cause: "STALE_PRICE" }], []]);
  const kind = shopPlan.planPass({ ...small, ours: [c(1), c(2), c(3, { kindTag: "c10" }), ...full.slice(3)] });
  assert.deepStrictEqual(kind.deletes, [{ contractID: 3, cause: "STALE_KIND" }]);
  const moved = shopPlan.planPass({ ...small, ours: [...full, c(20, { stationID: 60011866 })] });
  assert.deepStrictEqual(moved.deletes, [{ contractID: 20, cause: "STALE_STATION" }]);

  const excess = shopPlan.planPass({ ...small, ours: [...full, c(4)] });
  assert.deepStrictEqual([excess.deletes, excess.creates], [[{ contractID: 4, cause: "EXCESS" }], []]);

  const busy = shopPlan.planPass({ ...small, ours: [c(1, { dateExpiredFt: 0n }), c(11, { stationID: B, dateExpiredFt: 0n })],
    busyStations: new Set([A]) });
  assert.deepStrictEqual(busy.deletes, [{ contractID: 11, cause: "EXPIRING" }]);
  assert.deepStrictEqual(busy.creates.map((entry) => entry.stationID), [B, B, B], "no action at the busy hub");
  assert.strictEqual(busy.stats.skippedBusy, 1);

  const pending = shopPlan.planPass({ ...small, ours: [c(1), c(2), c(3, { pending: true, dateExpiredFt: 0n }), ...full.slice(3)] });
  assert.deepStrictEqual([pending.deletes, pending.creates, pending.stats.live], [[], [], 6], "a pending contract is live");

  const unknown = shopPlan.planPass({ ...small, ours: [...full, c(30, { typeID: 345555 }), c(31, { status: 4, dateExpiredFt: 0n })] });
  assert.deepStrictEqual([unknown.deletes, unknown.creates, unknown.stats.unknownType], [[], [], 1]);

  const delist = shopPlan.planPass({ ...small, delist: true, ours: [...full.slice(0, 3), c(14, { stationID: B, pending: true }),
    c(30, { typeID: 345555 })] });
  assert.deepStrictEqual([delist.deletes.map((entry) => `${entry.contractID}:${entry.cause}`), delist.creates],
    [["1:DELIST", "2:DELIST", "3:DELIST", "30:DELIST"], []]);
  assert.strictEqual(delist.stats.live, 4, "live before the deletes (3 delisted + 1 pending)");

  const ct1 = [c(1), c(2), c(40, { typeID: 345555 }), c(41, { typeID: 345555, pending: true })];
  const ct1Delist = shopPlan.planPass({ ...small, delist: true, ours: ct1 });
  assert.deepStrictEqual(ct1Delist.deletes.map((entry) => `${entry.contractID}:${entry.cause}`), ["1:DELIST", "2:DELIST", "40:DELIST"]);
  assert.deepStrictEqual([ct1Delist.stats.unknownType, ct1Delist.stats.live], [2, 2]);
  const ct1Keep = shopPlan.planPass({ ...small, ours: ct1 });
  assert.ok(!ct1Keep.deletes.some((entry) => entry.contractID === 40 || entry.contractID === 41), "without delist: never touched");
  assert.strictEqual(ct1Keep.stats.unknownType, 2);
});

test("T-S2b shop catalog: the 4 Mobile Sentry blueprints in price class default (no catalog code change)", () => {
  const plan = packLib.buildPlan([...fixtureEntries(), ...realEntries(SENTRY_PACK)],
    { itemTypeRows: clone(VANILLA_TYPES), blueprintDefinitions: [VEXOR_DEFINITION] });
  assert.deepStrictEqual(plan.rejected, []);
  const catalog = shopCatalog.buildCatalog(plan, shopConfig());
  assert.strictEqual(catalog.length, 19 + 4);
  const sentries = catalog.filter((entry) => entry.packID === "mobile-sentries");
  assert.deepStrictEqual(sentries.map((entry) => [entry.typeID, entry.priceClass, entry.price, entry.maxRuns]),
    [[340510, "default", 10000000, 30], [340511, "default", 10000000, 30], [340512, "default", 10000000, 30],
      [340513, "default", 10000000, 10]]);
  assert.strictEqual(sentries[0].name, "Mobile Sentry (Projectile) Blueprint");
});

test("CT1b shop runner DELIST: live after the pass subtracts only catalog delists (a pending one stays live)", async () => {
  const clock = { ms: 1790000000000 };
  const cfg = shopConfig({ EVEJS_CUSTOMTYPES_SHOP_STATIONS: "60003760", EVEJS_CUSTOMTYPES_SHOP_DELIST: "1" });
  const plan = fixturePlan(false);
  const vendor = makeFakeShopVendor(clock);
  const catalogType = shopCatalog.buildCatalog(plan, cfg)[0].typeID;
  const tag = "Blueprint sold by ORE. [customTypes:shop:v1:o]";
  for (const [contractID, typeID] of [[801, catalogType], [802, catalogType], [803, 345555]]) {
    vendor.world.items.set(contractID, { itemID: contractID, ownerID: 1, locationID: -contractID, flagID: 0, typeID });
    vendor.world.contracts.set(contractID, { contractID, issuerCorpID: ORE, stationID: 60003760, typeID, itemID: contractID,
      price: 1, description: tag, status: 0, dateExpiredFt: shopRunner.fileTimeOfMs(clock.ms + 86400000) });
  }
  const read = vendor.readOurs;
  vendor.readOurs = (issuer) => {
    const result = read(issuer);
    for (const entry of result.ours) entry.pending = entry.contractID === 802;
    return result;
  };
  const runner = shopRunner.createShopRunner({ cfg, vendor, catalogOf: () => shopCatalog.buildCatalog(plan, cfg),
    log: () => {}, now: () => clock.ms, setTimer: () => {} });
  assert.deepStrictEqual(runner.start(), { ok: true });
  const pass = await runner.runPass();
  assert.deepStrictEqual([pass.deleted, pass.created, pass.live], [2, 0, 1], "801 + 803 delisted, 802 pending stays live");
});

test("SO1 shop config: officer price, hubs and count per type", () => {
  const shop = shopConfig();
  assert.deepStrictEqual([shop.price.officer, [...shop.officerStations], shop.officerContractsPerType], [1000000000, [60003760], 1]);
  const zero = configModule.load(NO_DIR, { EVEJS_CUSTOMTYPES_ENABLED: "1", EVEJS_CUSTOMTYPES_SHOP_OFFICER_CONTRACTS_PER_TYPE: "0",
    EVEJS_CUSTOMTYPES_SHOP_OFFICER_STATIONS: "60008494, 60003760" });
  assert.deepStrictEqual([zero.shopProblems, zero.shop.officerContractsPerType, [...zero.shop.officerStations]],
    [[], 0, [60008494, 60003760]]);
  for (const [key, value, pattern] of [
    ["OFFICER_CONTRACTS_PER_TYPE", "11", /OFFICER_CONTRACTS_PER_TYPE must be an integer 0-10/u],
    ["OFFICER_STATIONS", "abc", /OFFICER_STATIONS must be a list of 1-20 distinct station IDs/u],
    ["PRICE_OFFICER", "0", /PRICE_OFFICER must be an ISK amount/u],
  ]) {
    const loaded = configModule.load(NO_DIR, { EVEJS_CUSTOMTYPES_ENABLED: "1", [`EVEJS_CUSTOMTYPES_SHOP_${key}`]: value });
    assert.deepStrictEqual([loaded.problems, loaded.enabled, loaded.shopProblems.length], [[], true, 1], key);
    assert.match(loaded.shopProblems[0], pattern, key);
  }
});

function officerPlan() {
  const definition = (blueprintTypeID, level) => ({ blueprintTypeID, blueprintName: `BP ${blueprintTypeID}`, maxProductionLimit: 1,
    activities: { manufacturing: { skills: level ? [{ typeID: 3380, level }] : [] } } });
  return { packs: [{ packID: "officer-blueprints", definitions: [definition(350001, 0), definition(350002, 0)] },
    { packID: "pi-blueprints", definitions: [definition(340431, 1)] }] };
}

test("SO2 shop catalog: officer-blueprints entries carry class, price, own hubs and count; others null", () => {
  const cfg = shopConfig({ EVEJS_CUSTOMTYPES_SHOP_OFFICER_STATIONS: "60003760,60008494",
    EVEJS_CUSTOMTYPES_SHOP_OFFICER_CONTRACTS_PER_TYPE: "2", EVEJS_CUSTOMTYPES_SHOP_PRICE_OVERRIDES: "350002=5" });
  const catalog = shopCatalog.buildCatalog(officerPlan(), cfg);
  assert.deepStrictEqual(catalog.map((entry) => [entry.typeID, entry.priceClass, entry.price, entry.stations, entry.perType]), [
    [340431, "P1", 2000000, null, null],
    [350001, "officer", 1000000000, [60003760, 60008494], 2],
    [350002, "officer", 5, [60003760, 60008494], 2],
  ]);
  assert.notStrictEqual(catalog[1].stations, cfg.officerStations, "a copy of the config list");
  assert.strictEqual(shopCatalog.OFFICER_PACK_ID, "officer-blueprints");
});

function officerPassBase(perType) {
  const cfg = shopConfig({ EVEJS_CUSTOMTYPES_SHOP_OFFICER_CONTRACTS_PER_TYPE: String(perType) });
  const catalog = shopCatalog.buildCatalog(officerPlan(), cfg).filter((entry) => entry.typeID !== 350002);
  return { nowFt: 1000000n, renewLeadFt: 100n, stations: [60003760, 60008494], catalog, perType: 3, kindTag: "o", ours: [],
    busyStations: new Set(), delist: false, maxActions: 100, outstandingStatus: 0 };
}

const officerContract = (contractID, stationID) => ({ contractID, stationID, typeID: 350001, price: 1000000000, kindTag: "o",
  status: 0, dateExpiredFt: 1000000n + 1000n, pending: false });

test("SO3 shop plan: an officer entry creates only at its hubs, elsewhere STALE_STATION; target sums per entry", () => {
  const base = officerPassBase(1);
  const empty = shopPlan.planPass(base);
  assert.deepStrictEqual(empty.creates.map((entry) => `${entry.stationID}:${entry.typeID}`),
    ["60003760:340431", "60003760:340431", "60003760:340431", "60003760:350001",
      "60008494:340431", "60008494:340431", "60008494:340431"]);
  assert.strictEqual(empty.stats.target, 1 + 2 * 3);
  const moved = shopPlan.planPass({ ...base, ours: [officerContract(5, 60003760), officerContract(6, 60008494)] });
  assert.deepStrictEqual(moved.deletes, [{ contractID: 6, cause: "STALE_STATION" }]);
  assert.ok(!moved.creates.some((entry) => entry.typeID === 350001), "officer pair at hub A is full");
});

test("SO4 shop plan: officer perType 0 deletes live ones as EXCESS, no create", () => {
  const base = officerPassBase(0);
  const pass = shopPlan.planPass({ ...base, ours: [officerContract(5, 60003760), officerContract(7, 60003760)] });
  assert.deepStrictEqual(pass.deletes, [{ contractID: 7, cause: "EXCESS" }, { contractID: 5, cause: "EXCESS" }]);
  assert.ok(!pass.creates.some((entry) => entry.typeID === 350001));
  assert.strictEqual(pass.stats.target, 2 * 3);
});

function makeFakeShopVendor(clock) {
  const world = { nextItemID: 9000, nextContractID: 700, items: new Map(), contracts: new Map(), grants: 0, creates: 0,
    failReads: false, throwCreateOnce: false };
  const ft = (ms) => shopRunner.fileTimeOfMs(ms);
  const matches = (item, runs) => (runs === null ? item.singleton === 1 && item.original === true
    : item.singleton === 2 && item.original === false && item.runs === runs);
  const vendor = {
    world,
    ensureAuthority: () => ({ ok: true, alreadyInstalled: true }),
    validateIssuer: (id) => (id === ORE ? { ok: true, ceoID: ORE_CEO, name: "Outer Ring Excavations" } : { ok: false, reason: "ISSUER_NOT_FOUND" }),
    validateStation: (id) => (HUBS.includes(id) ? { ok: true } : { ok: false, reason: "STATION_NOT_FOUND" }),
    readOurs(issuer) {
      if (world.failReads) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "fake" };
      const ours = [...world.contracts.values()].filter((entry) => entry.issuerCorpID === issuer).map((entry) => ({
        contractID: entry.contractID, stationID: entry.stationID, typeID: entry.typeID, price: entry.price,
        kindTag: shopVendor.TAG_PATTERN.exec(entry.description)[1], status: entry.status, dateExpiredFt: entry.dateExpiredFt,
        pending: false }));
      return { ok: true, ours, busyStations: new Set(), outstandingStatus: 0 };
    },
    takeStock({ issuer, stationID, typeID, runs }) {
      let best = null;
      let stale = 0;
      for (const item of world.items.values()) {
        if (item.ownerID !== issuer || item.locationID !== stationID || item.flagID !== 62 || item.typeID !== typeID) continue;
        if (matches(item, runs)) best = best === null ? item.itemID : Math.min(best, item.itemID);
        else stale += 1;
      }
      return { ok: true, itemID: best, stale };
    },
    grantBlueprint({ issuer, stationID, typeID, runs }) {
      world.grants += 1;
      const itemID = world.nextItemID++;
      world.items.set(itemID, { itemID, ownerID: issuer, locationID: stationID, flagID: 62, typeID,
        singleton: runs === null ? 1 : 2, original: runs === null, runs });
      return { ok: true, itemID };
    },
    async createListing({ issuer, stationID, itemID, price, minutesExpire, title, description }) {
      if (world.throwCreateOnce) {
        world.throwCreateOnce = false;
        throw new Error("process killed before createContract");
      }
      const item = world.items.get(itemID);
      if (!item || item.ownerID !== issuer || item.locationID !== stationID || item.flagID !== 62) {
        return { ok: false, reason: "CONTRACT_CREATE_FAILED", detail: `Item ${itemID} is not at the contract start location.` };
      }
      const contractID = world.nextContractID++;
      item.ownerID = 1;
      item.locationID = -contractID;
      item.flagID = 0;
      world.creates += 1;
      world.contracts.set(contractID, { contractID, issuerCorpID: issuer, stationID, typeID: item.typeID, itemID, price, title,
        description, status: 0, dateExpiredFt: ft(clock.ms + minutesExpire * 60000) });
      return { ok: true, contractID };
    },
    async deleteListing({ issuer, contractID }) {
      const contract = world.contracts.get(contractID);
      if (!contract || contract.status !== 0) return { ok: false, reason: "CONTRACT_DELETE_FAILED", pending: true, detail: "not_settled" };
      contract.status = 8;
      Object.assign(world.items.get(contract.itemID), { ownerID: issuer, locationID: contract.stationID, flagID: 62 });
      return { ok: true };
    },
    accept(contractID) {
      const contract = world.contracts.get(contractID);
      contract.status = 4;
      Object.assign(world.items.get(contract.itemID), { ownerID: 90000001, locationID: contract.stationID, flagID: 4 });
    },
    liveByPair() {
      const counts = new Map();
      for (const contract of world.contracts.values()) {
        if (contract.status !== 0) continue;
        const key = `${contract.stationID}:${contract.typeID}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return counts;
    },
  };
  return vendor;
}

test("T-S3 shop runner on a fake vendor: fill, refill after a sale, relist on expiry, restart, idempotent, backoff", async () => {
  const clock = { ms: 1790000000000 };
  const cfg = shopConfig({ EVEJS_CUSTOMTYPES_SHOP_STATIONS: "60003760,60008494", EVEJS_CUSTOMTYPES_SHOP_CONTRACTS_PER_TYPE: "2",
    EVEJS_CUSTOMTYPES_SHOP_MAX_ACTIONS_PER_PASS: "500" });
  const plan = fixturePlan(false);
  const vendor = makeFakeShopVendor(clock);
  const logs = [];
  const timers = [];
  const makeRunner = () => shopRunner.createShopRunner({
    cfg, vendor, catalogOf: () => shopCatalog.buildCatalog(plan, cfg), log: (line) => logs.push(line),
    now: () => clock.ms, setTimer: (fn, ms) => timers.push(ms),
  });
  let runner = makeRunner();
  assert.deepStrictEqual(runner.start(), { ok: true });
  assert.deepStrictEqual(timers, [30000]);
  assert.ok(logs.includes("shop active - issuer Outer Ring Excavations (1000129), 2 hubs, 3 blueprints, 2 per type"), logs.join(" | "));

  const first = await runner.runPass();
  assert.deepStrictEqual([first.ok, first.created, first.granted, first.deleted, first.live, first.target], [true, 12, 12, 0, 12, 12]);
  assert.match(logs[logs.length - 1], /^shop pass: created 12, deleted 0 \(expiring 0, stale 0, excess 0\), granted 12, failed 0, live 12\/12, stock-stale 0, busy 0, \d+ ms$/u);
  const contract = [...vendor.world.contracts.values()][0];
  assert.deepStrictEqual([contract.title, contract.description, contract.price],
    ["Superconductors Blueprint (BPO)", "Blueprint sold by Outer Ring Excavations. [customTypes:shop:v1:o]", 8000000]);
  const quiet = logs.length;
  const second = await runner.runPass();
  assert.deepStrictEqual([second.created, second.deleted, second.granted, logs.length], [0, 0, 0, quiet], "steady pass: no action, no log");

  vendor.accept(contract.contractID);
  const refill = await runner.runPass();
  assert.deepStrictEqual([refill.created, refill.granted, refill.live], [1, 1, 12]);

  const target = [...vendor.world.contracts.values()].find((entry) => entry.status === 0);
  target.dateExpiredFt = shopRunner.fileTimeOfMs(clock.ms + 3600000);
  const grants = vendor.world.grants;
  const relist = await runner.runPass();
  assert.deepStrictEqual([relist.deleted, relist.created, relist.granted, vendor.world.grants], [1, 1, 0, grants]);
  const relisted = [...vendor.world.contracts.values()].find((entry) => entry.status === 0 && entry.itemID === target.itemID);
  assert.ok(relisted && relisted.contractID !== target.contractID, "same item, new contract");

  vendor.accept(relisted.contractID);
  vendor.world.throwCreateOnce = true;
  const crashed = await runner.runPass();
  assert.deepStrictEqual([crashed.created, crashed.granted, crashed.failed], [0, 1, 1]);
  const grantsAfterCrash = vendor.world.grants;
  runner = makeRunner();
  runner.start();
  const restarted = await runner.runPass();
  assert.deepStrictEqual([restarted.created, restarted.granted, vendor.world.grants], [1, 0, grantsAfterCrash], "stock used, no new grant");

  for (let pass = 0; pass < 2; pass += 1) {
    const again = await runner.runPass();
    assert.deepStrictEqual([again.created, again.deleted, again.granted, again.failed], [0, 0, 0, 0]);
  }
  assert.deepStrictEqual([...vendor.liveByPair().values()], [2, 2, 2, 2, 2, 2]);

  const extra = vendor.grantBlueprint({ issuer: ORE, stationID: 60003760, typeID: 340431, runs: null });
  await vendor.createListing({ issuer: ORE, stationID: 60003760, itemID: extra.itemID, price: 2000000, minutesExpire: 43200,
    title: "Bacteria Blueprint (BPO)", description: "x [customTypes:shop:v1:o]" });
  const trimmed = await runner.runPass();
  assert.deepStrictEqual([trimmed.deleted, trimmed.created], [1, 0]);
  assert.strictEqual(vendor.liveByPair().get("60003760:340431"), 2);

  vendor.world.failReads = true;
  const intervals = [];
  for (let pass = 0; pass < 7; pass += 1) {
    await runner.runPass();
    intervals.push(runner.state.intervalMs);
  }
  assert.deepStrictEqual(intervals, [60000, 120000, 240000, 480000, 960000, 1800000, 1800000]);
  vendor.world.failReads = false;
  vendor.accept([...vendor.world.contracts.values()].find((entry) => entry.status === 0).contractID);
  await runner.runPass();
  assert.strictEqual(runner.state.intervalMs, 30000);

  for (const [role, expected] of [["world", 1], ["market", 0]]) {
    const started = [];
    const made = makeRuntime({ shopEnabled: true, environment: { EVEJS_GAMESTORE_OWNER_ROLE: "world" },
      makeShopRunner: (options) => ({ start: () => { started.push(options.cfg); return { ok: true }; }, stats: {} }) });
    made.runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }, role));
    const bootstrap = { bootWorld: () => Promise.resolve("booted") };
    assert.deepStrictEqual(made.runtime.apply("bootstrap", bootstrap), { ok: true });
    await bootstrap.bootWorld();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(made.runtime.startShop().ok, false, "second start refused");
    assert.strictEqual(started.length, expected, role);
  }
});

test("T-S4 shop issuer wrap: marked CEO session only, original result otherwise, composes with a second wrap", () => {
  const corp = { getCorporationRecord: (id) => (id === ORE ? { corporationID: ORE, ceoID: ORE_CEO } : null) };
  const authority = { getPersistedCorporationAuthority: (session) => (session && session.playerCorp ? { corporationID: 98000001 } : null) };
  assert.deepStrictEqual(shopIssuer.wrapShopIssuerAuthority(authority, corp), { ok: true, alreadyInstalled: false });
  assert.deepStrictEqual(shopIssuer.wrapShopIssuerAuthority(authority, corp), { ok: true, alreadyInstalled: true });
  const role = 72057594037927936n;
  const marked = shopIssuer.markShopIssuer({ characterID: ORE_CEO, corporationID: ORE, corpAccountKey: 1000 }, role);
  const answer = authority.getPersistedCorporationAuthority(marked);
  assert.deepStrictEqual([answer.isCEO, answer.isDirector, answer.corporationID, answer.characterID, answer.sessionCorporationRoles],
    [true, true, ORE, ORE_CEO, role]);
  assert.strictEqual(marked.corprole, role);
  assert.strictEqual(authority.getPersistedCorporationAuthority({ characterID: ORE_CEO, corporationID: ORE }), null, "unmarked");
  assert.deepStrictEqual(authority.getPersistedCorporationAuthority({ playerCorp: true }), { corporationID: 98000001 }, "original kept");
  assert.strictEqual(authority.getPersistedCorporationAuthority(shopIssuer.markShopIssuer({ characterID: 1, corporationID: ORE }, role)),
    null, "CEO differs from the record");
  const forged = { ...marked, characterID: 1 };
  assert.strictEqual(authority.getPersistedCorporationAuthority(forged), null, "ids changed after marking");

  const OTHER = Symbol("other.issuer");
  const inner = authority.getPersistedCorporationAuthority;
  authority.getPersistedCorporationAuthority = (session) => inner(session) || (session && session[OTHER] ? { other: true } : null);
  assert.deepStrictEqual(authority.getPersistedCorporationAuthority({ [OTHER]: true }), { other: true });
  assert.strictEqual(authority.getPersistedCorporationAuthority(marked).isCEO, true);
  assert.deepStrictEqual(shopIssuer.wrapShopIssuerAuthority({}, corp), { ok: false, reason: "AUTHORITY_SEAM_UNAVAILABLE" });

  const calls = [];
  const fakeContracts = {
    CORP_ROLE_CONTRACT_MANAGER: role,
    createContract: async (info, session) => {
      calls.push({ info, session });
      return calls.length === 1 ? { success: true, contractIDs: [701] } : { success: true, rejected: true, errorMsg: "NO", contractIDs: [] };
    },
    deleteContract: async () => { throw new Error("Another contract operation is already pending."); },
  };
  const vendor = shopVendor.createShopVendor({ requireModule: (relative) => {
    if (relative === shopVendor.MODULES.contracts) return fakeContracts;
    if (relative === shopVendor.MODULES.items) return { ITEM_FLAGS: { CORP_DELIVERIES: 62 } };
    throw new Error(`not loaded: ${relative}`);
  } });
  return (async () => {
    const listing = { issuer: ORE, ceoID: ORE_CEO, accountKey: 1000, stationID: 60003760, itemID: 5, price: 2000000,
      minutesExpire: 43200, title: "Bacteria Blueprint (BPO)", description: "Blueprint sold by ORE. [customTypes:shop:v1:o]" };
    assert.deepStrictEqual(await vendor.createListing(listing), { ok: true, contractID: 701 });
    assert.deepStrictEqual(await vendor.createListing(listing), { ok: false, reason: "CONTRACT_CREATE_FAILED", rejected: true, detail: "NO" });
    const { info, session } = calls[0];
    assert.deepStrictEqual([info.contractType, info.forCorp, info.startStationDivision, info.itemList, info.isPrivate, info.price],
      [1, true, 62, [[5, 1]], false, 2000000]);
    assert.strictEqual(authority.getPersistedCorporationAuthority(session).isCEO, true, "the vendor gets a marked session");
    assert.deepStrictEqual(await vendor.deleteListing({ issuer: ORE, ceoID: ORE_CEO, contractID: 701 }),
      { ok: false, reason: "CONTRACT_DELETE_FAILED", pending: true, detail: "Another contract operation is already pending." });
    assert.deepStrictEqual(vendor.validateIssuer(ORE).ok, false, "a missing seam is a refusal, not a throw");
  })();
});

test("CT2 CLEANUP guard countOutstandingHolding: OUTSTANDING + IN_PROGRESS by enum name; enum without IN_PROGRESS refuses", () => {
  const typeIDs = new Set([340431]);
  const row = (typeID, inCrate = true) => ({ typeID, inCrate });
  const records = [
    { status: 0, items: [row(340431)] }, { status: 1, items: [row(340431)] },
    { status: 4, items: [row(340431)] }, { status: 1, items: [row(34)] }, { status: 0, items: [row(340431, false)] },
  ];
  const vendorOf = (CONTRACT_STATUS) => shopVendor.createShopVendor({ requireModule: (relative) => {
    if (relative === shopVendor.MODULES.contracts) return { CONTRACT_STATUS, listContractRecords: () => records };
    throw new Error(`not loaded: ${relative}`);
  } });
  assert.deepStrictEqual(vendorOf({ OUTSTANDING: 0, IN_PROGRESS: 1, FINISHED: 4 }).countOutstandingHolding(typeIDs),
    { ok: true, count: 2, outstanding: 1, inProgress: 1 });
  assert.deepStrictEqual(vendorOf({ OUTSTANDING: 0 }).countOutstandingHolding(typeIDs),
    { ok: false, reason: "SEAM_UNAVAILABLE", detail: "CONTRACT_STATUS" });
});

test("CT3 readOurs: CONTRACT_STATUS.OUTSTANDING read strictly; a bad enum skips the pass before listContractRecords", async () => {
  const calls = { list: 0, pending: 0 };
  const vendorOf = (CONTRACT_STATUS) => shopVendor.createShopVendor({ requireModule: (relative) => {
    if (relative === shopVendor.MODULES.contracts) {
      return { CONTRACT_STATUS, listContractRecords: () => { calls.list += 1; return []; }, toFileTimeBigInt: () => 0n };
    }
    if (relative === shopVendor.MODULES.settlements) {
      return { listPendingContractSettlements: () => { calls.pending += 1; return []; } };
    }
    throw new Error(`not loaded: ${relative}`);
  } });
  const good = vendorOf({ OUTSTANDING: 0, IN_PROGRESS: 1 }).readOurs(ORE);
  assert.deepStrictEqual([good.ok, good.outstandingStatus, good.ours.length], [true, 0, 0]);
  assert.strictEqual(vendorOf({ OUTSTANDING: 7 }).readOurs(ORE).outstandingStatus, 7);
  assert.deepStrictEqual([calls.list, calls.pending], [2, 2]);
  for (const bad of [{}, { OUTSTANDING: "0" }]) {
    assert.deepStrictEqual(vendorOf(bad).readOurs(ORE), { ok: false, reason: "SEAM_UNAVAILABLE", detail: "CONTRACT_STATUS" });
  }
  assert.deepStrictEqual([calls.list, calls.pending], [2, 2], "no vendor reads after a bad enum");

  const clock = { ms: 1790000000000 };
  const cfg = shopConfig({ EVEJS_CUSTOMTYPES_SHOP_STATIONS: "60003760" });
  const vendor = makeFakeShopVendor(clock);
  vendor.readOurs = vendorOf({}).readOurs;
  const errors = [];
  const runner = shopRunner.createShopRunner({ cfg, vendor, catalogOf: () => shopCatalog.buildCatalog(fixturePlan(false), cfg),
    log: () => {}, logError: (line) => errors.push(line), now: () => clock.ms, setTimer: () => {} });
  assert.deepStrictEqual(runner.start(), { ok: true });
  const pass = await runner.runPass();
  assert.deepStrictEqual([pass.failed, pass.created, pass.deleted, pass.granted, vendor.world.creates, vendor.world.grants],
    [1, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(errors, ["shop: pass failed - SEAM_UNAVAILABLE (CONTRACT_STATUS)"]);
});

test("CT4 readOurs live contract read: parity with listContractRecords on/off, a bad read falls back", () => {
  const ours = (id, status, station) => ({ contractID: id, forCorp: true, issuerCorpID: ORE, status, startStationID: station,
    price: 2000000, dateExpired: "134000000000000000", description: "Bp. [customTypes:shop:v1:o]",
    items: [{ typeID: 340431, inCrate: true }] });
  const table = {
    _meta: { version: 1, nextContractID: 980000010 },
    980000001: ours(980000001, 0, 60003760),
    980000002: ours(980000002, 4, 60008494),
    980000003: { ...ours(980000003, 0, 60003760), issuerCorpID: 1000125 },
    980000004: { ...ours(980000004, 0, 60003760), description: "no tag" },
    980000005: null,
  };
  const calls = { list: 0 };
  let storeResult = { success: true, errorMsg: null, data: table };
  const vendorOf = (liveContractRead) => shopVendor.createShopVendor({ liveContractRead, requireModule: (relative) => {
    if (relative === shopVendor.MODULES.contracts) {
      return { TABLE: "contractRuntime", CONTRACT_STATUS: { OUTSTANDING: 0 }, toFileTimeBigInt: (v) => BigInt(v || 0),
        listContractRecords: () => {
          calls.list += 1;
          return Object.entries(table).filter(([k, v]) => k !== "_meta" && v && typeof v === "object")
            .map(([, v]) => JSON.parse(JSON.stringify(v)));
        } };
    }
    if (relative === shopVendor.MODULES.settlements) {
      return { listPendingContractSettlements: () => [{ contractID: 980000002 }] };
    }
    if (relative === shopVendor.MODULES.store) return { read: (t, p) => (t === "contractRuntime" && p === "/" ? storeResult : null) };
    throw new Error(`not loaded: ${relative}`);
  } });
  const off = vendorOf(false).readOurs(ORE);
  assert.strictEqual(calls.list, 1);
  assert.deepStrictEqual(off.ours.map((c) => c.contractID), [980000001, 980000002]);
  const on = vendorOf(true).readOurs(ORE);
  assert.strictEqual(calls.list, 1, "the live read does not call listContractRecords");
  assert.deepStrictEqual(on, off);
  for (const bad of [{ success: false, errorMsg: "TABLE_NOT_FOUND", data: null }, { success: true, data: [] }]) {
    storeResult = bad;
    assert.deepStrictEqual(vendorOf(true).readOurs(ORE), off);
  }
  assert.strictEqual(calls.list, 3, "a failed / bad read = the vendor list");
  assert.strictEqual(shopConfig({}).liveContractRead, false, "default off");
  assert.strictEqual(shopConfig({ EVEJS_CUSTOMTYPES_SHOP_LIVE_CONTRACT_READ: "1" }).liveContractRead, true);
});

test("T-S5 shop vendor facts (EveJS sources): exports, authority required at call time, flag 62, singleton, NPC runtime", () => {
  const report = viability.inspectShop(runtimeRoot);
  const read = (relative) => fs.readFileSync(path.join(srcRoot, ...relative.split("/")), "utf8").replace(/\r\n/gu, "\n");
  const contracts = read("services/contracts/contractRuntimeState.js");
  const limitForAll = viability.functionBodyOf(contracts, "function assertOutstandingContractLimit(info, session) {");
  if (limitForAll) {
    assert.ok(limitForAll.includes("throwContractUserError(\"ConTooManyContractsMax\""), "the limit throws");
    assert.ok(viability.functionBodyOf(contracts, "async function createContract(rawInfo, session, options = {}) {")
      .includes("const prepared = prepareContractCreationRequest(rawInfo, session);"), "createContract prepares");
    assert.ok(viability.functionBodyOf(contracts, "function prepareContractCreationRequest(rawInfo, session) {")
      .includes("\n  assertOutstandingContractLimit(info, session);\n"), "the limit in the request prepare");
    assert.strictEqual(contracts.split("assertOutstandingContractLimit(").length - 1, 2, "definition + one call");
    assert.strictEqual(report.ok, false, "the shop must DRIFT while the limit applies to its item exchanges");
    const bad = report.reports.filter((entry) => !entry.ok);
    assert.deepStrictEqual(bad.map((entry) => [entry.key, entry.reason]), [["contractRuntimeState",
      "seam \"function getAuctionCreationTerms(info, session) {\" has no ConTooManyContractsMax in its body"]]);
  } else {
    assert.ok(report.ok, report.reports.filter((entry) => !entry.ok).map((entry) => `${entry.key}: ${entry.reason}`).join("; "));
  }
  const exportsBlock = contracts.slice(contracts.lastIndexOf("\nmodule.exports = {"));
  for (const name of ["CONTRACT_STATUS", "CORP_ROLE_CONTRACT_MANAGER", "toFileTimeBigInt", "listContractRecords", "getContractRecord",
    "createContract", "deleteContract"]) {
    assert.match(exportsBlock, new RegExp(`\\n {2}${name},\\n`, "u"), name);
  }
  assert.match(contracts, /const CONTRACT_STATUS = Object\.freeze\(\{\n {2}OUTSTANDING: 0,/u);
  const AUTH = "require(\"../corporation/corporationAuthority\")";
  for (const header of ["function getSessionCorporationID(session) {", "function sessionHasCorpContractManagerRole(session) {",
    "function canAccessCorporationContractItem(session, ownerID, locationID, flagID, takeRequired = false) {"]) {
    assert.ok(viability.functionBodyOf(contracts, header).includes(AUTH), header);
  }
  const delivery = viability.functionBodyOf(contracts, "function getOwnerDeliveryFlag(forCorp) {");
  assert.ok(delivery && delivery.includes("return forCorp ? ITEM_FLAGS.CORP_DELIVERIES : ITEM_FLAGS.HANGAR;"), delivery);
  assert.match(contracts, /const CORP_CONTRACT_ITEM_FLAGS = new Set\(\[\n {2}ITEM_FLAGS\.CORP_DELIVERIES,/u);
  assert.strictEqual(contracts.split("ConTooManyContractsMax").length - 1, 1);
  if (!limitForAll) {
    assert.ok(viability.functionBodyOf(contracts, "function getAuctionCreationTerms(info, session) {").includes("ConTooManyContractsMax"));
  }
  assert.match(contracts, /rejected: true/u);
  const industry = read("services/industry/industryRuntimeState.js");
  const seed = viability.functionBodyOf(industry, "function seedBlueprintForOwner(ownerID, locationID, options = {}) {");
  assert.ok(seed.includes("singleton: isOriginal ? 1 : 2,"), "seedBlueprintForOwner singleton");
  assert.ok(seed.includes("const isOriginal = options.original !== false;"));
  assert.ok(seed.includes("runsRemaining: isOriginal ? -1 :"));
  assert.ok(seed.includes("data: {\n      item: blueprintItem,"), "result.data.item");
  const runtimeState = read("services/corporation/corporationRuntimeState.js");
  const update = viability.functionBodyOf(runtimeState, "function updateCorporationRuntime(corporationID, updater) {");
  assert.ok(update.includes("runtimeTable.corporations[String(corporationRecord.corporationID)] ||\n      normalizeCorporationRuntime(undefined, corporationRecord, runtimeTable)"),
    update);
  const settlements = read("services/contracts/contractSettlementState.js");
  assert.ok(settlements.includes("readRoot().byContractID")
    || (viability.functionBodyOf(settlements, "function readPendingSettlements() {") || "").includes("return root.byContractID;"),
  "sagas keyed by contractID");
  if (settlements.includes("function readPendingSettlements() {")) {
    assert.ok(viability.functionBodyOf(settlements, "function listPendingContractSettlements() {")
      .includes("return Object.values(readPendingSettlements())"), "the list reads the pending sagas");
    assert.ok(viability.functionBodyOf(settlements, "function readPendingSettlements() {")
      .includes("code: \"CONTRACT_SETTLEMENT_READ_FAILED\","), "a failed read throws");
    const throwing = shopVendor.createShopVendor({ requireModule: (relative) => {
      if (relative === shopVendor.MODULES.contracts) {
        return { CONTRACT_STATUS: { OUTSTANDING: 0 }, listContractRecords: () => [], toFileTimeBigInt: () => 0n };
      }
      if (relative === shopVendor.MODULES.settlements) {
        return { listPendingContractSettlements: () => {
          throw Object.assign(new Error("Could not read pending contract settlements"), { code: "CONTRACT_SETTLEMENT_READ_FAILED" });
        } };
      }
      throw new Error(`not loaded: ${relative}`);
    } });
    assert.deepStrictEqual(throwing.readOurs(ORE), { ok: false, reason: "SEAM_UNAVAILABLE",
      detail: "Could not read pending contract settlements" });
  }
  assert.ok(contracts.includes("kind: \"create\",\n    requestFingerprint,\n    payload,"), "create saga payload carries baseRecord");
});

const OFFICER_PACK = "officer-blueprints.json";
const OFFICER_SPEC = JSON.parse(fs.readFileSync(path.join(modDir, "tools", "officer-blueprints.spec.json"), "utf8"));
const MINERAL_IDS = Object.freeze([34, 35, 36, 37, 38, 39, 40, 11399]);
const MOON_IDS = Object.freeze([16682, 16683, 17317]);

function officerSde(extraTypes = []) {
  const row = ([typeID, name, groupID, metaGroupID, metaLevel, variationParentTypeID, extra = {}]) => ({ typeID, name, groupID,
    iconID: 84, metaGroupID, metaLevel, published: true, variationParentTypeID, ...extra });
  const tagIDs = Object.values(OFFICER_SPEC.families).flatMap((family) => family.tags.map(([typeID]) => typeID));
  const rows = [
    ...[3380, 3388, 33196, ...MINERAL_IDS, ...MOON_IDS, ...tagIDs].map((typeID) => [typeID, `Type ${typeID}`, 1, null, 0, null]),
    [10838, "Large Shield Booster I", 40, 1, 0, null], [10839, "Large Shield Booster Blueprint", 120, 1, 0, null],
    [10858, "Large Shield Booster II", 40, 2, 5, 10838],
    [15000, "Dread Guristas Large Shield Booster", 40, 4, 8, 10838], [15001, "Domination Large Shield Booster", 40, 4, 9, 10838],
    [15100, "Pith X-Type Large Shield Booster", 40, 6, 14, 10838], [15101, "Pith C-Type Large Shield Booster", 40, 6, 12, 10838],
    [14703, "Estamel's Modified Large Shield Booster", 40, 5, 17, 10838],
    [16000, "Unit X-1’s Modified Large Shield Booster", 40, 5, 17, 10838],
    [16001, "Draclira's Modified Large Shield Booster", 40, 5, 17, 10838],
    [3000, "125mm Railgun I", 74, 1, 0, null], [3001, "125mm Railgun Blueprint", 154, 1, 0, null],
    [3005, "125mm Railgun II", 74, 2, 5, 3000], [3020, "Shadow Serpentis 125mm Railgun", 74, 4, 8, 3000],
    [3010, "Tuvan's Modified 125mm Railgun", 74, 5, 17, 3000],
    [4000, "Drone Link Augmentor I", 645, 1, 0, null], [4001, "Drone Link Augmentor Blueprint", 120, 1, 0, null],
    [4002, "Drone Link Augmentor II", 645, 2, 5, 4000], [4010, "Unit D-1's Modified Drone Link Augmentor", 645, 5, 17, 4000],
    ...extraTypes,
  ];
  return {
    types: new Map(rows.map((entry) => [entry[0], row(entry)])),
    groupCategory: new Map([[1, 4], [40, 7], [74, 7], [645, 7], [120, 9], [154, 9]]),
    blueprintByProduct: new Map([[10838, 10839], [3000, 3001], [4000, 4001], [16001, 16002]]),
    dogma: new Map([[10838, { effects: new Set([16]), chargeSize: null }], [3000, { effects: new Set([42]), chargeSize: 1 }],
      [4000, { effects: new Set(), chargeSize: null }]]),
  };
}

const officerSpec = (allocations = {}, patch = {}) => ({ ...clone(OFFICER_SPEC), allocations, ...patch });
const FIXTURE_ALLOCATIONS = Object.freeze({ 3010: 341010, 14703: 341011, 16000: 341012 });
const materialsOf = (built, productTypeID) => {
  const blueprint = built.pack.blueprints.find((entry) => entry.productTypeID === productTypeID);
  return Object.fromEntries(blueprint.activities.manufacturing.materials.map((entry) => [entry.typeID, entry.quantity]));
};
const mineralsAt = (factor) => Object.fromEntries(OFFICER_SPEC.minerals.map(([typeID, quantity]) =>
  [typeID, Math.max(1, Math.round(quantity * factor))]));

test("OB1 officer generator: full family (prefixed faction wins over higher metaLevel, deadspace, T2 x3, tags, moon, L)", () => {
  const built = officerGenerator.buildOfficerBlueprintPack(officerSde(), officerSpec(FIXTURE_ALLOCATIONS), { allocate: false });
  assert.ok(built.ok, built.reason);
  const blueprint = built.pack.blueprints.find((entry) => entry.productTypeID === 14703);
  assert.deepStrictEqual([blueprint.blueprintTypeID, blueprint.maxProductionLimit, Object.keys(blueprint.activities)],
    [341011, 1, ["manufacturing"]]);
  const manufacturing = blueprint.activities.manufacturing;
  assert.deepStrictEqual(materialsOf(built, 14703), { ...mineralsAt(1), 10858: 3, 15000: 1, 15100: 1, 16682: 400, 16683: 200,
    17317: 200, 17206: 10, 17245: 5 });
  assert.deepStrictEqual(manufacturing.materials.map((entry) => entry.typeID),
    [...manufacturing.materials.map((entry) => entry.typeID)].sort((a, b) => a - b));
  assert.deepStrictEqual([manufacturing.time, manufacturing.products, manufacturing.skills],
    [604800, [{ quantity: 1, typeID: 14703 }], [{ level: 5, typeID: 3380 }, { level: 5, typeID: 3388 }]]);
  const type = built.pack.types.find((entry) => entry.typeID === 341011);
  assert.deepStrictEqual([type.sourceTypeID, type.overrides.name, type.overrides.groupID, type.overrides.iconID, type.overrides.basePrice,
    type.overrides.published, type.overrides.marketGroupID], [33196, "Estamel's Modified Large Shield Booster Blueprint", 120, 84, 0, true, null]);
  assert.match(type.overrides.description, /^Blueprint of Estamel's Modified Large Shield Booster\. Officer-grade manufacturing: 1x Dread Guristas Large Shield Booster, 1x Pith X-Type Large Shield Booster, 3x Large Shield Booster II, faction diamond tags,.* One run takes 7 days\. Type 3380 V, Type 3388 V\.$/u);
  assert.deepStrictEqual([built.report.bySize.L, built.report.byFamily.guristas, built.newAllocations], [2, 1, 0]);
});

test("OB2 officer generator: turret S x weapon, faction only x2, max(1), generic (no tags, moon x2), VANILLA / NO_FACTION exclusions", () => {
  const spec = officerSpec(FIXTURE_ALLOCATIONS, { minerals: [...OFFICER_SPEC.minerals.slice(0, 6), [40, 1], [11399, 1000]] });
  const built = officerGenerator.buildOfficerBlueprintPack(officerSde(), spec, { allocate: false });
  assert.ok(built.ok, built.reason);
  assert.deepStrictEqual(materialsOf(built, 3010), { 34: 750000, 35: 187500, 36: 75000, 37: 18750, 38: 7500, 39: 3750, 40: 1,
    11399: 375, 3005: 3, 3020: 2, 16682: 150, 16683: 75, 17317: 75, 17216: 4, 17267: 2 });
  assert.strictEqual(built.pack.blueprints.find((entry) => entry.productTypeID === 3010).activities.manufacturing.time, 151200);
  const generic = materialsOf(built, 16000);
  assert.deepStrictEqual(generic, { ...mineralsAt(1), 40: 1, 10858: 3, 15001: 1, 15100: 1, 16682: 800, 16683: 400, 17317: 400 });
  assert.deepStrictEqual(built.report.excluded, [
    { typeID: 4010, name: "Unit D-1's Modified Drone Link Augmentor", reason: "NO_FACTION_OR_DEADSPACE" },
    { typeID: 16001, name: "Draclira's Modified Large Shield Booster", reason: "VANILLA_BLUEPRINT" },
  ]);
  assert.deepStrictEqual([built.report.built, built.report.bySize.S, built.report.byFamily.generic, built.report.byFamily.serpentis],
    [3, 1, 1, 1]);
  assert.match(built.pack.types.find((entry) => entry.typeID === 341012).overrides.description,
    /manufacturing: 1x Domination Large Shield Booster, 1x Pith X-Type Large Shield Booster, 3x Large Shield Booster II, advanced moon/u);
});

test("OB3 officer generator: allocation refused without --allocate; deterministic; new lower officer keeps old IDs; SDE ID skipped", () => {
  const sde = officerSde([[341000, "Somebody Else", 1, null, 0, null]]);
  const refused = officerGenerator.buildOfficerBlueprintPack(sde, officerSpec(), { allocate: false });
  assert.deepStrictEqual(refused, { ok: false, reason: "officer 3010 has no allocation (run --allocate)" });
  const first = officerGenerator.buildOfficerBlueprintPack(sde, officerSpec(), { allocate: true });
  const second = officerGenerator.buildOfficerBlueprintPack(sde, officerSpec(), { allocate: true });
  assert.ok(first.ok, first.reason);
  assert.deepStrictEqual([first.allocations, first.newAllocations], [{ 3010: 341001, 14703: 341002, 16000: 341003 }, 3]);
  assert.strictEqual(generator.serializePack(second.pack), generator.serializePack(first.pack));
  const reversed = { ...sde, types: new Map([...sde.types].reverse()) };
  assert.strictEqual(generator.serializePack(officerGenerator.buildOfficerBlueprintPack(reversed, officerSpec(), { allocate: true }).pack),
    generator.serializePack(first.pack), "Map order does not matter");

  const grown = officerSde([[341000, "Somebody Else", 1, null, 0, null], [3009, "Cormack's Modified 125mm Railgun", 74, 5, 17, 3000]]);
  const next = officerGenerator.buildOfficerBlueprintPack(grown, officerSpec(first.allocations), { allocate: true });
  assert.ok(next.ok, next.reason);
  assert.deepStrictEqual([next.allocations, next.newAllocations], [{ ...first.allocations, 3009: 341004 }, 1]);
  assert.deepStrictEqual(next.pack.types.map((entry) => entry.typeID), [341001, 341002, 341003, 341004]);

  for (const [allocations, pattern] of [[{ 14703: 341000 }, /341000 \(officer 14703\) already exists in the SDE/u],
    [{ 14703: 341005, 3010: 341005 }, /341005 allocated to officers 3010 and 14703/u], [{ 14703: 342000 }, /outside 341000-341999/u]]) {
    const result = officerGenerator.buildOfficerBlueprintPack(sde, officerSpec(allocations), { allocate: true });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, pattern);
  }
  const rewritten = officerGenerator.renderSpecWithAllocations("{\r\n  \"a\": [1, 2],\r\n  \"allocations\": {}\r\n}\r\n", { 9: 341001, 10: 341000 });
  assert.deepStrictEqual(rewritten, { ok: true, text: "{\n  \"a\": [1, 2],\n  \"allocations\": {\n    \"9\": 341001,\n    \"10\": 341000\n  }\n}\n" });
});

test("OB4 shipped data/officer-blueprints.json: packID, 593 BP in 341000-341999, manufacturing only, allocations = spec", () => {
  const [{ pack }] = realEntries(OFFICER_PACK);
  assert.strictEqual(pack.packID, shopCatalog.OFFICER_PACK_ID);
  assert.strictEqual(pack.packID, OFFICER_SPEC.packID);
  assert.strictEqual(pack.types.length, 593);
  assert.strictEqual(pack.blueprints.length, 593);
  const typeIDs = pack.types.map((entry) => entry.typeID);
  assert.ok(typeIDs.every((typeID) => typeID >= 341000 && typeID <= 341999), "range");
  assert.strictEqual(new Set(typeIDs).size, typeIDs.length, "unique");
  assert.deepStrictEqual(pack.blueprints.map((entry) => entry.blueprintTypeID), typeIDs);
  const allocated = new Set(Object.values(OFFICER_SPEC.allocations));
  assert.strictEqual(allocated.size, Object.keys(OFFICER_SPEC.allocations).length, "spec allocations unique");
  for (const blueprint of pack.blueprints) {
    const label = String(blueprint.blueprintTypeID);
    assert.deepStrictEqual(Object.keys(blueprint.activities), ["manufacturing"], label);
    const manufacturing = blueprint.activities.manufacturing;
    assert.deepStrictEqual(manufacturing.products, [{ quantity: 1, typeID: blueprint.productTypeID }], label);
    assert.deepStrictEqual(manufacturing.skills, [{ level: 5, typeID: 3380 }, { level: 5, typeID: 3388 }], label);
    const ids = manufacturing.materials.map((entry) => entry.typeID);
    assert.deepStrictEqual(ids, [...new Set(ids)].sort((a, b) => a - b), label);
    assert.strictEqual(blueprint.maxProductionLimit, 1, label);
    assert.strictEqual(OFFICER_SPEC.allocations[String(blueprint.productTypeID)], blueprint.blueprintTypeID, label);
  }
  assert.ok(pack.types.every((entry) => entry.sourceTypeID === 33196 && entry.overrides.iconID > 0
    && entry.overrides.description.length <= 2000), "source, icon, description");
});

function shippedPackFacts(entries) {
  const rows = clone(VANILLA_TYPES);
  const known = new Set(rows.map((row) => row.typeID));
  const groups = new Set(rows.map((row) => row.groupID));
  const add = (typeID) => {
    if (typeID >= packLib.TYPE_ID_MIN || known.has(typeID)) return;
    known.add(typeID);
    rows.push({ typeID, groupID: 1, categoryID: 4, groupName: "Fixture", name: `Type ${typeID}`, published: true });
  };
  for (const { pack } of entries) {
    for (const entry of pack.types) {
      add(entry.sourceTypeID);
      const groupID = entry.overrides && entry.overrides.groupID;
      if (Number.isSafeInteger(groupID) && !groups.has(groupID)) {
        groups.add(groupID);
        rows.push({ typeID: 3000000 + groupID, groupID, categoryID: 9, groupName: `Blueprint group ${groupID}`,
          name: `Group ${groupID} Blueprint`, published: true });
      }
    }
    for (const blueprint of pack.blueprints || []) {
      add(blueprint.productTypeID);
      for (const activity of Object.values(blueprint.activities)) {
        for (const list of [activity.materials, activity.products, activity.skills]) for (const item of list || []) add(item.typeID);
      }
    }
  }
  return { itemTypeRows: rows, blueprintDefinitions: [VEXOR_DEFINITION] };
}

const ARCHAEOLOGY_PACK = "archaeology-relics.json";
const ARCHAEOLOGY_SOURCE_ROWS = Object.freeze([
  { typeID: 30834, groupID: 538, categoryID: 7, groupName: "Data Miners", name: "Data Analyzer II", iconID: 2856,
    published: true },
  { typeID: 30832, groupID: 538, categoryID: 7, groupName: "Data Miners", name: "Relic Analyzer II", iconID: 2857,
    published: true },
  { typeID: 30835, groupID: 918, categoryID: 9, groupName: "Data Miner Blueprint", name: "Data Analyzer II Blueprint",
    iconID: 2856, published: true },
  { typeID: 30833, groupID: 918, categoryID: 9, groupName: "Data Miner Blueprint", name: "Relic Analyzer II Blueprint",
    iconID: 2857, published: true },
  { typeID: 16686, groupID: 314, categoryID: 17, groupName: "Miscellaneous", name: "Manufacturing Tools",
    published: true, iconID: 2225 },
]);
const ANALYZER_DOGMA = Object.freeze({ attributes: Object.freeze({ 1909: 60, 1910: 30, 1911: 3 }) });

function archaeologyFacts(facts) {
  const ids = new Set(ARCHAEOLOGY_SOURCE_ROWS.map((row) => row.typeID));
  const next = { ...facts, itemTypeRows: [...facts.itemTypeRows.filter((row) => !ids.has(row.typeID)),
    ...clone(ARCHAEOLOGY_SOURCE_ROWS)] };
  const before = typeof facts.dogmaOf === "function" ? facts.dogmaOf : () => null;
  next.dogmaOf = (typeID) => (typeID === 30834 || typeID === 30832 ? clone(ANALYZER_DOGMA) : before(typeID));
  return next;
}

test("A12 data/archaeology-relics.json: 341600-341605, sources 30834/30835/30832/30833/16686, virus strength in the "
  + "limits, BP -> product (3 runs, recipe of the source), no market group, not in the shop", () => {
  const entries = realEntries(ARCHAEOLOGY_PACK);
  const [{ pack: shipped }] = entries;
  assert.deepStrictEqual(shipped.types.map((entry) => [entry.typeID, entry.sourceTypeID]),
    [[341600, 30834], [341601, 30835], [341602, 30832], [341603, 30833], [341604, 16686], [341605, 16686]]);
  assert.ok(shipped.types.every((entry) => entry.overrides.marketGroupID === null && entry.overrides.iconID > 0));
  assert.deepStrictEqual([shipped.types[0].dogma, shipped.types[2].dogma],
    [{ attributes: { 1910: 35 } }, { attributes: { 1910: 32 } }]);
  for (const entry of shipped.types.filter((e) => e.dogma)) {
    for (const [id, value] of Object.entries(entry.dogma.attributes)) {
      assert.strictEqual(limits.checkDogmaOverride(Number(id), value, ANALYZER_DOGMA.attributes[id],
        "virusStrength"), null);
    }
  }
  const plan = packLib.buildPlan(entries, archaeologyFacts(shippedPackFacts(entries)));
  assert.deepStrictEqual(plan.rejected, []);
  const [pack] = plan.packs;
  assert.strictEqual(pack.packID, "archaeology-relics");
  assert.deepStrictEqual(pack.typeRows.map((row) => [row.typeID, row.groupID, row.categoryID, row.marketGroupID]), [
    [341600, 538, 7, null], [341601, 918, 9, null], [341602, 538, 7, null], [341603, 918, 9, null],
    [341604, 314, 17, null], [341605, 314, 17, null]]);
  assert.deepStrictEqual(pack.definitions.map((d) => [d.blueprintTypeID, d.productTypeID, d.maxProductionLimit,
    Object.keys(d.activities).sort().join(",")]), [[341601, 341600, 3, "copying,manufacturing"],
    [341603, 341602, 3, "copying,manufacturing"]]);
  assert.deepStrictEqual(shopCatalog.buildCatalog(plan, shopConfig()), []);
  const others = realEntries().filter((entry) => entry.file !== ARCHAEOLOGY_PACK).flatMap(({ pack: p }) => [
    ...p.types.map((entry) => entry.typeID), ...(p.blueprints || []).map((b) => b.productTypeID)]);
  assert.deepStrictEqual(others.filter((typeID) => typeID >= 341600 && typeID <= 341619), []);
  for (const [bp, src] of [[341601, 30835], [341603, 30833]]) {
    const sde = sdeRow("blueprints.jsonl", src);
    if (!sde) continue;
    const def = pack.definitions.find((d) => d.blueprintTypeID === bp);
    const m = sde.activities.manufacturing;
    assert.deepStrictEqual([def.activities.manufacturing.materials, def.activities.manufacturing.skills,
      def.activities.manufacturing.time, def.activities.copying.time], [m.materials, m.skills, m.time,
      sde.activities.copying.time]);
  }
  for (const src of [30834, 30832]) {
    const sde = sdeRow("typeDogma.jsonl", src);
    if (!sde) continue;
    const attrs = Object.fromEntries(sde.dogmaAttributes.map((a) => [a.attributeID, a.value]));
    assert.deepStrictEqual([attrs[1909], attrs[1910], attrs[1911]], [60, 30, 3]);
  }
  for (const src of [30833, 30835, 16686]) {
    if (sdeRow("typeDogma.jsonl", src) !== undefined) assert.ok(sdeRow("typeDogma.jsonl", src), `${src} has a typedogma record`);
  }
});

test("OB5 buildPlan: the 9 shipped packs together accepted, officer BP server rows unpublished, no product collision", () => {
  const entries = realEntries();
  assert.deepStrictEqual(entries.map((entry) => entry.file),
    [ARCHAEOLOGY_PACK, HEAVY_SENTRY_PACK, "listening-post.json", SENTRY_PACK, OFFICER_PACK, PI_PACK, DRILL_PACK,
      SEASON_TROPHY_PACK, TRIG_PACK]);
  const facts = archaeologyFacts(listeningPostFacts(entries));
  const largeIds = new Set(LARGE_BATTERY_ROWS.map((row) => row.typeID));
  facts.itemTypeRows = [...facts.itemTypeRows.filter((row) => !largeIds.has(row.typeID)), ...clone(LARGE_BATTERY_ROWS)];
  const plan = packLib.buildPlan(entries, facts);
  assert.deepStrictEqual(plan.rejected, []);
  assert.deepStrictEqual(plan.packs.map((pack) => pack.packID), ["archaeology-relics", "heavy-sentries",
    "listening-post", "mobile-sentries", "officer-blueprints", "pi-blueprints", "planetary-drill", "season-trophies",
    "trig-bridge"]);
  const officer = plan.packs.find((pack) => pack.packID === "officer-blueprints");
  assert.strictEqual(officer.definitions.length, 593);
  assert.ok(officer.typeRows.every((row) => row.published === false && row.categoryID === 9), "Category 9");
  assert.ok(officer.definitions.every((definition) => definition.published === false));
  const products = plan.packs.flatMap((pack) => pack.definitions.map((definition) => definition.productTypeID));
  assert.strictEqual(new Set(products).size, products.length, "one blueprint per product");
  const catalog = shopCatalog.buildCatalog(plan, shopConfig());
  const officerEntries = catalog.filter((entry) => entry.packID === "officer-blueprints");
  assert.strictEqual(officerEntries.length, 593);
  assert.ok(officerEntries.every((entry) => entry.priceClass === "officer" && entry.perType === 1
    && entry.stations.length === 1 && entry.stations[0] === 60003760), "Jita only, 1 per type");
});

const SEASON_TROPHY_PACK = "season-trophies.json";

test("ST1 data/season-trophies.json: 341620-341623 clones of 16686 (group 314, cat 17), names, no blueprint, unique "
  + "between the packs", () => {
  const entries = realEntries(SEASON_TROPHY_PACK);
  const [{ pack: shipped }] = entries;
  assert.deepStrictEqual(shipped.types.map((entry) => [entry.typeID, entry.sourceTypeID]),
    [[341620, 16686], [341621, 16686], [341622, 16686], [341623, 16686]]);
  const facts = shippedPackFacts(entries);
  facts.itemTypeRows = [...facts.itemTypeRows.filter((row) => row.typeID !== 16686), { typeID: 16686, groupID: 314,
    categoryID: 17, groupName: "Miscellaneous", name: "Manufacturing Tools", published: true, iconID: 2225 }];
  const plan = packLib.buildPlan(entries, facts);
  assert.deepStrictEqual(plan.rejected, []);
  const [pack] = plan.packs;
  assert.deepStrictEqual(pack.typeRows.map((row) => [row.typeID, row.name, row.groupID, row.categoryID, row.published,
    row.marketGroupID, row.iconID]), [
    [341620, "Season Trophy: Champion", 314, 17, true, null, 21622],
    [341621, "Season Trophy: Hero", 314, 17, true, null, 21622],
    [341622, "Season Trophy: Veteran", 314, 17, true, null, 21622],
    [341623, "Season Trophy: Participant", 314, 17, true, null, 21622]]);
  assert.deepStrictEqual([pack.definitions, shopCatalog.buildCatalog(plan, shopConfig())], [[], []]);
  const others = realEntries().filter((entry) => entry.file !== SEASON_TROPHY_PACK).flatMap(({ pack: p }) => [
    ...p.types.map((entry) => entry.typeID), ...(p.blueprints || []).map((b) => b.productTypeID)]);
  assert.deepStrictEqual(others.filter((typeID) => typeID >= 341620 && typeID <= 341623), []);
  const sde = sdeRow("typeDogma.jsonl", 16686);
  if (sde) assert.deepStrictEqual([sde.dogmaAttributes.length, (sde.dogmaEffects || []).length], [1, 0]);
});

const TRIG_PACK = "trig-bridge.json";
const SDE_DIR = path.join(runtimeRoot, "_local", "sde", "eve-online-static-data-3396210-jsonl");
const sdeRow = (file, key) => {
  const sdeFile = path.join(SDE_DIR, file);
  if (!fs.existsSync(sdeFile)) return undefined;
  const line = fs.readFileSync(sdeFile, "utf8").split(/\r?\n/u).find((text) => text.startsWith(`{"_key": ${key},`));
  return line ? JSON.parse(line) : null;
};

test("TB1 data/trig-bridge.json: core 341640 (not a fuel), BP 341641 (cat 9, Abyss materials, 36961 copying), shop, log line", () => {
  const entries = realEntries(TRIG_PACK);
  const [{ pack: shipped }] = entries;
  const plan = packLib.buildPlan(entries, shippedPackFacts(entries));
  assert.deepStrictEqual(plan.rejected, []);
  const [pack] = plan.packs;
  assert.strictEqual(pack.packID, "trig-bridge");
  assert.deepStrictEqual(shipped.types.map((entry) => entry.typeID), [341640, 341641], "341642 reserved, not shipped");
  const rows = new Map(pack.typeRows.map((row) => [row.typeID, row]));
  const core = rows.get(341640);
  assert.strictEqual(shipped.types[0].sourceTypeID, 2870);
  assert.deepStrictEqual([core.name, core.groupID, core.categoryID, core.published, core.marketGroupID, core.iconID],
    ["Triglavian Conduit Core", 1041, 43, true, null, 21982]);
  assert.ok(core.groupID !== 1136 && !/fuel\s*block/iu.test(core.groupName) && core.typeID !== 16273, "not a fuel");
  assert.match(shipped.types[0].overrides.description, /Deposit it into your alliance's Ansiblex with Cargo Deposit/u);
  const blueprint = rows.get(341641);
  assert.deepStrictEqual([shipped.types[1].sourceTypeID, blueprint.name, blueprint.groupID, blueprint.categoryID, blueprint.basePrice],
    [33196, "Triglavian Conduit Core Blueprint", 447, 9, 0]);
  const [definition] = pack.definitions;
  assert.deepStrictEqual([definition.blueprintTypeID, definition.productTypeID, definition.maxProductionLimit], [341641, 341640, 2]);
  assert.deepStrictEqual(definition.activities, {
    copying: { time: 720000 },
    manufacturing: { materials: [{ quantity: 200, typeID: 48112 }, { quantity: 400, typeID: 47975 }, { quantity: 50, typeID: 48121 }],
      products: [{ quantity: 1, typeID: 341640 }], skills: [{ level: 1, typeID: 3400 }], time: 259200 },
  });
  const catalog = shopCatalog.buildCatalog(plan, shopConfig()).filter((entry) => entry.packID === "trig-bridge");
  assert.deepStrictEqual(catalog.map((entry) => [entry.typeID, entry.price]), [[341641, 500000000]]);

  const loot = fs.readFileSync(path.join(srcRoot, "abyssal", "catalog", "abyssalLootTables.generated.data", "tier-0.json"), "utf8");
  for (const typeID of [48112, 47975, 48121]) assert.match(loot, new RegExp(`"itemTypeID": ${typeID},`, "u"), String(typeID));
  const ansiblex = sdeRow("blueprints.jsonl", 36961);
  if (ansiblex) {
    assert.deepStrictEqual([ansiblex.activities.manufacturing.skills, ansiblex.maxProductionLimit, ansiblex.activities.copying.time],
      [definition.activities.manufacturing.skills, 2, 720000]);
  }
  if (sdeRow("typeDogma.jsonl", 2870) !== undefined) {
    assert.ok(sdeRow("typeDogma.jsonl", 2870) && sdeRow("typeDogma.jsonl", 33196), "sources have a typeDogma record");
    assert.strictEqual(sdeRow("typeDogma.jsonl", 48121), null, "48121 has no typeDogma record");
  }
  const fuelGroup = sdeRow("groups.jsonl", 1041);
  if (fuelGroup) assert.deepStrictEqual([fuelGroup.categoryID, fuelGroup.name.en], [43, "Advanced Commodities - Tier 4"]);

  const reference = makeFakeReference({ itemTypes: { types: shippedPackFacts(entries).itemTypeRows } });
  const { runtime, logs, errors } = makeRuntime({ entries });
  runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
  runtime.applyReference(reference);
  reference.readStaticRows("itemTypes");
  assert.deepStrictEqual(errors, []);
  assert.ok(logs.includes("pack trig-bridge: 2 types, 1 blueprints"), logs.join(" | "));
});

const LISTENING_POST_PACK = "listening-post.json";
const SCANNER_ARRAY_DOGMA = Object.freeze({ typeID: 16216, typeName: "Scanner Array", attributeCount: 4, effectCount: 3,
  attributes: Object.freeze({ 9: 10000, 263: 5000, 265: 2000, 552: 2000 }), effects: Object.freeze([901, 1022, 1023]) });
const SCANNER_ARRAY_ROW = Object.freeze({ typeID: 16216, groupID: 709, categoryID: 23, groupName: "Scanner Array",
  name: "Scanner Array", portionSize: 1, volume: 4000, published: true });

function listeningPostFacts(entries) {
  const facts = shippedPackFacts(entries);
  facts.itemTypeRows = [...facts.itemTypeRows.filter((row) => row.typeID !== 16216), clone(SCANNER_ARRAY_ROW)];
  facts.dogmaOf = (typeID) => (typeID === 16216 ? clone(SCANNER_ARRAY_DOGMA) : null);
  return facts;
}

test("LP1 data/listening-post.json: 340520 clone of 16216 (group 709, cat 23) with HP 50000/50000/100000, BP 340521 "
  + "plain minerals, shop 100 mln; typeIDs 340520-340539 collide with no shipped pack", () => {
  const entries = realEntries(LISTENING_POST_PACK);
  const [{ pack: shipped }] = entries;
  assert.deepStrictEqual(shipped.types.map((entry) => [entry.typeID, entry.sourceTypeID]), [[340520, 16216], [340521, 33196]]);
  assert.deepStrictEqual(shipped.types[0].dogma, { attributes: { 9: 50000, 263: 50000, 265: 100000 } });
  const plan = packLib.buildPlan(entries, listeningPostFacts(entries));
  assert.deepStrictEqual(plan.rejected, []);
  const [pack] = plan.packs;
  const rows = new Map(pack.typeRows.map((row) => [row.typeID, row]));
  const post = rows.get(340520);
  assert.deepStrictEqual([post.name, post.groupID, post.categoryID, post.published, post.marketGroupID, post.iconID],
    ["Listening Post", 709, 23, true, null, 24666]);
  const blueprint = rows.get(340521);
  assert.deepStrictEqual([blueprint.name, blueprint.groupID, blueprint.categoryID, blueprint.basePrice],
    ["Listening Post Blueprint", 447, 9, 0]);
  const [definition] = pack.definitions;
  assert.deepStrictEqual([definition.blueprintTypeID, definition.productTypeID, definition.maxProductionLimit], [340521, 340520, 10]);
  assert.deepStrictEqual(definition.activities.manufacturing, {
    materials: [{ quantity: 12000, typeID: 34 }, { quantity: 4000, typeID: 35 }, { quantity: 1500, typeID: 36 },
      { quantity: 500, typeID: 37 }],
    products: [{ quantity: 1, typeID: 340520 }], skills: [{ level: 5, typeID: 3380 }], time: 6000 });
  const catalog = shopCatalog.buildCatalog(plan, shopConfig()).filter((entry) => entry.packID === "listening-post");
  assert.deepStrictEqual(catalog.map((entry) => [entry.typeID, entry.price]), [[340521, 100000000]]);
  const others = realEntries().filter((entry) => entry.file !== LISTENING_POST_PACK && entry.file !== "heavy-sentries.json")
    .flatMap(({ pack: p }) => [
    ...p.types.map((entry) => entry.typeID), ...(p.blueprints || []).map((b) => b.productTypeID)]);
  assert.deepStrictEqual(others.filter((typeID) => typeID >= 340520 && typeID <= 340539), []);
  const sde = sdeRow("typeDogma.jsonl", 16216);
  if (sde) {
    const attrs = Object.fromEntries(sde.dogmaAttributes.map((a) => [a.attributeID, a.value]));
    assert.deepStrictEqual([attrs[9], attrs[263], attrs[265], attrs[552]], [10000, 5000, 2000, 2000]);
  }
  const group = sdeRow("groups.jsonl", 709);
  if (group) assert.deepStrictEqual([group.categoryID, group.anchorable, group.name.en], [23, true, "Scanner Array"]);

  const facts = listeningPostFacts(entries);
  const reference = makeFakeReference({ itemTypes: { types: facts.itemTypeRows },
    typeDogma: { typesByTypeID: { 16216: clone(SCANNER_ARRAY_DOGMA) }, attributeTypesByID: {} } });
  const { runtime, logs, errors } = makeRuntime({ entries });
  runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
  runtime.applyReference(reference);
  reference.readStaticRows("itemTypes");
  assert.deepStrictEqual(errors, []);
  assert.ok(logs.includes("pack listening-post: 2 types, 1 blueprints"), logs.join(" | "));
  const copy = reference.readStaticTable("typeDogma").typesByTypeID["340520"];
  assert.deepStrictEqual([copy.attributes["9"], copy.attributes["263"], copy.attributes["265"], copy.attributes["552"]],
    [50000, 50000, 100000, 2000]);
});

const HEAVY_SENTRY_PACK = "heavy-sentries.json";
const LARGE_BATTERY_ROWS = Object.freeze([[16689, 426, "Large Artillery Battery"], [16692, 449, "Large Railgun Battery"],
  [16694, 430, "Large Beam Laser Battery"], [17773, 417, "XL Torpedo Battery"]]
  .map(([typeID, groupID, name]) => Object.freeze({ typeID, groupID, categoryID: 23, groupName: `Group ${groupID}`, name,
    basePrice: 5000000, portionSize: 1, volume: 5000, published: true })));
const HEAVY_TABLE = Object.freeze([
  [340522, 16689, 426, 340526, 854, 77290, 26480, 7710],
  [340523, 16692, 449, 340527, 855, 77290, 26480, 7710],
  [340524, 16694, 430, 340528, 853, 72000, 33090, 6210],
  [340525, 17773, 417, 340529, 871, 82580, 54260, 7070],
]);

function heavySentryFacts(entries) {
  const facts = shippedPackFacts(entries);
  const ids = new Set(LARGE_BATTERY_ROWS.map((row) => row.typeID));
  facts.itemTypeRows = [...facts.itemTypeRows.filter((row) => !ids.has(row.typeID)), ...clone(LARGE_BATTERY_ROWS)];
  return facts;
}

test("HS1 data/heavy-sentries.json: 340522-340525 clones of the large batteries (group kept, cat 23), BP 340526-340529 "
  + "minerals of, 24000 s, max 10, shop 750 mln; no typeID collision with another shipped pack", () => {
  const entries = realEntries(HEAVY_SENTRY_PACK);
  const [{ pack: shipped }] = entries;
  assert.deepStrictEqual(shipped.types.map((entry) => entry.typeID),
    [340522, 340523, 340524, 340525, 340526, 340527, 340528, 340529]);
  assert.ok(shipped.types.every((entry) => !("dogma" in entry)), "no dogma override in v1");
  const plan = packLib.buildPlan(entries, heavySentryFacts(entries));
  assert.deepStrictEqual(plan.rejected, []);
  const [pack] = plan.packs;
  assert.strictEqual(pack.packID, "heavy-sentries");
  const rows = new Map(pack.typeRows.map((row) => [row.typeID, row]));
  const source = new Map(shipped.types.map((entry) => [entry.typeID, entry]));
  for (const [typeID, sourceTypeID, groupID, blueprintTypeID, blueprintGroupID, trit, pye, mex] of HEAVY_TABLE) {
    assert.strictEqual(source.get(typeID).sourceTypeID, sourceTypeID, String(typeID));
    assert.strictEqual("groupID" in source.get(typeID).overrides, false, `${typeID}: no groupID override`);
    const row = rows.get(typeID);
    assert.deepStrictEqual([row.groupID, row.categoryID, row.published, row.marketGroupID], [groupID, 23, true, null]);
    assert.match(row.name, /^Heavy Sentry \((Projectile|Hybrid|Laser|Missile)\)$/u);
    assert.match(source.get(typeID).overrides.description, /XL/u);
    const blueprint = rows.get(blueprintTypeID);
    assert.deepStrictEqual([source.get(blueprintTypeID).sourceTypeID, blueprint.name, blueprint.groupID, blueprint.categoryID,
      blueprint.basePrice], [33196, `${row.name} Blueprint`, blueprintGroupID, 9, 0]);
    const definition = pack.definitions.find((entry) => entry.blueprintTypeID === blueprintTypeID);
    assert.deepStrictEqual([definition.productTypeID, definition.maxProductionLimit], [typeID, 10]);
    assert.deepStrictEqual(definition.activities, {
      copying: { time: 9600 },
      manufacturing: { materials: [[34, trit], [35, pye], [36, mex], [37, 5000], [38, 1000], [39, 250]]
        .map(([id, quantity]) => ({ quantity, typeID: id })),
      products: [{ quantity: 1, typeID }], skills: [{ level: 5, typeID: 3380 }], time: 24000 },
      research_material: { time: 4200 },
      research_time: { time: 4200 },
    }, String(blueprintTypeID));
  }
  const catalog = shopCatalog.buildCatalog(plan, shopConfig()).filter((entry) => entry.packID === "heavy-sentries");
  assert.deepStrictEqual(catalog.map((entry) => [entry.typeID, entry.price]),
    [[340526, 750000000], [340527, 750000000], [340528, 750000000], [340529, 750000000]]);
  const others = realEntries().filter((entry) => entry.file !== HEAVY_SENTRY_PACK).flatMap(({ pack: p }) => [
    ...p.types.map((entry) => entry.typeID), ...(p.blueprints || []).map((b) => b.productTypeID)]);
  assert.deepStrictEqual(others.filter((typeID) => typeID >= 340522 && typeID <= 340529), []);
  for (const [, sourceTypeID] of HEAVY_TABLE) {
    const sde = sdeRow("typeDogma.jsonl", sourceTypeID);
    if (!sde) continue;
    const attrs = Object.fromEntries(sde.dogmaAttributes.map((a) => [a.attributeID, a.value]));
    assert.deepStrictEqual([attrs[263], attrs[265], attrs[9], attrs[552]], [100000, 1500000, 100000, 18000], String(sourceTypeID));
  }
  for (const vanilla of [2805, 2804, 2830, 2822]) {
    const bp = sdeRow("blueprints.jsonl", vanilla);
    if (bp) {
      assert.deepStrictEqual([bp.maxProductionLimit, bp.activities.copying.time, bp.activities.research_material.time],
        [10, 9600, 4200], String(vanilla));
    }
  }

  const reference = makeFakeReference({ itemTypes: { types: heavySentryFacts(entries).itemTypeRows } });
  const { runtime, logs, errors } = makeRuntime({ entries });
  runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
  runtime.applyReference(reference);
  reference.readStaticRows("itemTypes");
  assert.deepStrictEqual(errors, []);
  assert.ok(logs.includes("pack heavy-sentries: 8 types, 4 blueprints"), logs.join(" | "));
});

const RIFTER = Object.freeze({ typeID: 587, groupID: 25, categoryID: 6, groupName: "Frigate", name: "Rifter", mass: 1067000,
  volume: 27289, capacity: 140, radius: 31, iconID: null, published: true });
const RIFTER_ATTRIBUTES = Object.freeze({ 4: 1067000, 12: 4, 13: 3, 14: 3, 20: -5, 37: 355, 70: 3.2, 109: 0.67, 162: 31,
  552: 35, 600: 5, 1137: 3 });
const ATTRIBUTE_NAMES = Object.freeze({ 4: "mass", 12: "lowSlots", 13: "medSlots", 14: "hiSlots", 20: "speedFactor",
  37: "maxVelocity", 70: "agility", 109: "kineticDamageResonance", 162: "radius", 552: "signatureRadius",
  600: "warpSpeedMultiplier", 1137: "rigSlots" });
const rifterDogma = () => ({ typeID: 587, typeName: "Rifter", attributeCount: 12, effectCount: 0,
  attributes: Object.fromEntries(Object.entries(RIFTER_ATTRIBUTES).map(([id, value]) => [String(id), value])), effects: [] });
const shipFacts = (extra = {}) => ({
  itemTypeRows: [...clone(VANILLA_TYPES), clone(RIFTER)], blueprintDefinitions: [VEXOR_DEFINITION],
  dogmaOf: (typeID) => (typeID === 587 ? rifterDogma() : null),
  attributeNameOf: (attributeID) => ATTRIBUTE_NAMES[attributeID] || null,
  ...extra,
});
function shipPack({ attributes = null, overrides = {}, second = false, blueprints = null, extra = {} } = {}) {
  const types = [{ typeID: 342000, sourceTypeID: 587, overrides: { name: "Rifter Mk II", ...overrides },
    ...(attributes ? { dogma: { attributes } } : {}) }];
  if (second) types.push({ typeID: 342002, sourceTypeID: 587, overrides: { name: "Rifter Mk III", mass: 1100000 } });
  const blueprint = (blueprintTypeID, productTypeID, shop) => ({ blueprintTypeID, productTypeID, maxProductionLimit: 10,
    activities: { manufacturing: { products: [{ quantity: 1, typeID: productTypeID }], time: 10 } }, ...(shop ? { shop } : {}) });
  const list = [];
  for (const [blueprintTypeID, productTypeID, shop] of blueprints || []) {
    types.push({ typeID: blueprintTypeID, sourceTypeID: 971, overrides: { name: `Blueprint ${blueprintTypeID}` } });
    list.push(blueprint(blueprintTypeID, productTypeID, shop));
  }
  return { packID: "design-rifter", version: 1, types, blueprints: list, ...extra };
}
const shipEntry = (options) => ({ file: "design-rifter.json", pack: shipPack(options) });

test("CS1 dogma override on an existing attribute: typeDogma copy has it, attributeCount unchanged; a missing one refuses the pack", () => {
  const entries = [shipEntry({ attributes: { 37: 420, 14: 4 } }), ...fixtureEntries()];
  const reference = makeFakeReference({
    itemTypes: { types: [...clone(VANILLA_TYPES), clone(RIFTER)] },
    typeDogma: { typesByTypeID: { 587: rifterDogma() },
      attributeTypesByID: Object.fromEntries(Object.entries(ATTRIBUTE_NAMES).map(([id, name]) => [id, { attributeID: Number(id), name }])) },
  });
  const { runtime, logs, errors } = makeRuntime({ entries });
  runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
  runtime.applyReference(reference);
  reference.readStaticRows("itemTypes");
  const copy = reference.readStaticTable("typeDogma").typesByTypeID["342000"];
  assert.deepStrictEqual(errors, []);
  assert.ok(logs.includes("pack design-rifter: 1 types (1 ships), 0 blueprints"), logs.join(" | "));
  assert.deepStrictEqual([copy.typeID, copy.typeName, copy.attributes["37"], copy.attributes["14"], copy.attributeCount],
    [342000, "Rifter Mk II", 420, 4, 12]);
  assert.strictEqual(Object.keys(copy.attributes).length, 12);
  assert.strictEqual(reference.readStaticTable("typeDogma").typesByTypeID["587"].attributes["37"], 355, "source untouched");

  const missing = packLib.buildPlan([shipEntry({ attributes: { 9999: 1 } }), ...fixtureEntries()], shipFacts());
  assert.deepStrictEqual(missing.packs.map((pack) => pack.packID), ["pi-blueprints", "planetary-drill"]);
  assert.strictEqual(missing.rejected.length, 1);
  assert.match(missing.rejected[0].reason, /dogma attribute 9999 not on source 587/u);
  const noTable = packLib.buildPlan([shipEntry({ attributes: { 37: 420 } })], shipFacts({ dogmaOf: undefined }));
  assert.deepStrictEqual(noTable.rejected.map((entry) => entry.reason), ["typeDogma table unavailable"]);
  const v1 = packLib.buildPlan([shipEntry()], shipFacts({ dogmaOf: undefined }));
  assert.deepStrictEqual(v1.rejected, [], "a pack without dogma needs no typeDogma table");
});

test("CS2 guards: infinite, negative, sign change, resonance, slots, unknown shop key -> whole pack refused with the name", () => {
  const unchanged = packLib.buildPlan([shipEntry({ attributes: { ...RIFTER_ATTRIBUTES } })], shipFacts());
  assert.deepStrictEqual(unchanged.rejected, [], "an unchanged clone always passes");
  const cases = [
    [{ attributes: { 37: Infinity } }, /dogma attribute 37 \(maxVelocity\) must be a finite number/u],
    [{ attributes: { 37: -1 } }, /dogma attribute 37 \(maxVelocity\) must be >= 0/u],
    [{ attributes: { 20: 5 } }, /dogma attribute 20 \(speedFactor\) must be <= 0/u],
    [{ attributes: { 109: 0.05 } }, /dogma attribute 109 \(kineticDamageResonance\) must be within 0\.1-1/u],
    [{ attributes: { 109: 1.5 } }, /dogma attribute 109 \(kineticDamageResonance\) must be within 0\.1-1/u],
    [{ attributes: { 14: 9 } }, /dogma attribute 14 \(hiSlots\) must be within 0-8/u],
    [{ attributes: { 12: 2.5 } }, /dogma attribute 12 \(lowSlots\) must be an integer/u],
    [{ attributes: { 1137: 4 } }, /dogma attribute 1137 \(rigSlots\) must be within 0-3/u],
    [{ overrides: { mass: 0 } }, /type 342000: mass must be a finite number > 0/u],
    [{ blueprints: [[342001, 342000, { listed: true, discount: 1 }]] }, /blueprint 342001: unknown shop keys discount/u],
    [{ blueprints: [[342001, 342000, { price: 0 }]] }, /blueprint 342001: shop\.price must be an ISK amount/u],
  ];
  for (const [options, pattern] of cases) {
    const plan = packLib.buildPlan([shipEntry(options), ...fixtureEntries(false)], shipFacts());
    assert.deepStrictEqual(plan.packs.map((pack) => pack.packID), ["pi-blueprints"], String(pattern));
    assert.strictEqual(plan.rejected.length, 1, String(pattern));
    assert.match(plan.rejected[0].reason, pattern);
  }
  assert.strictEqual(limits.checkDogmaOverride(14, 9, 9, "hiSlots"), null);
  assert.strictEqual(limits.checkDogmaOverride(109, 0.05, 0.05, "kineticDamageResonance"), null);
  assert.strictEqual(limits.checkDogmaOverride(999, 1e9, 5, null), null);
  assert.deepStrictEqual({ ...limits.LIMITS }, { RESONANCE_MIN: 0.1, RESONANCE_MAX: 1, SLOT_MAX: 8, RIG_SLOT_MAX: 3 });
});

test("CS3 ship pack: one row each in shipTypes / shipDogmaAttributes / movementAttributes, both read orders, two reads", () => {
  for (const order of ["rows-first", "table-first"]) {
    const reference = makeFakeReference({
      itemTypes: { types: [...clone(VANILLA_TYPES), clone(RIFTER)] },
      typeDogma: { typesByTypeID: { 587: rifterDogma() }, attributeTypesByID: {} },
      shipTypes: { source: "fixture", count: 1, ships: [clone(RIFTER)] },
      shipDogmaAttributes: { shipAttributesByTypeID: { 587: { typeID: 587, typeName: "Rifter", attributeCount: 12,
        attributes: rifterDogma().attributes } } },
      movementAttributes: { attributes: [{ typeID: 587, typeName: "Rifter", mass: 1067000, maxVelocity: 355, inertia: 3.2,
        radius: 31, signatureRadius: 35, warpSpeedMultiplier: 5, alignTime: null, maxAccelerationTime: null }] },
    });
    const entries = [shipEntry({ attributes: { 4: 1200000, 37: 420, 600: 6 }, overrides: { mass: 1100000, radius: 40 }, second: true })];
    const { runtime, errors } = makeRuntime({ entries });
    runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
    runtime.applyReference(reference);
    for (let pass = 0; pass < 2; pass += 1) {
      if (order === "rows-first") {
        reference.readStaticRows("shipTypes");
        reference.readStaticRows("movementAttributes");
      }
      for (const table of ["shipTypes", "shipDogmaAttributes", "movementAttributes"]) reference.readStaticTable(table);
    }
    assert.deepStrictEqual(errors, [], order);
    const ships = reference.readStaticRows("shipTypes");
    const movement = reference.readStaticRows("movementAttributes");
    const dogma = reference.readStaticTable("shipDogmaAttributes").shipAttributesByTypeID;
    for (const typeID of [342000, 342002]) {
      assert.strictEqual(countType(ships, typeID), 1, `${order} ships ${typeID}`);
      assert.strictEqual(countType(movement, typeID), 1, `${order} movement ${typeID}`);
      assert.strictEqual(dogma[String(typeID)].typeID, typeID, `${order} dogma ${typeID}`);
    }
    const shipRow = ships.find((row) => row.typeID === 342000);
    assert.deepStrictEqual([shipRow.published, shipRow.name, shipRow.mass, shipRow.radius], [false, "Rifter Mk II", 1100000, 40]);
    const pick = (row) => [row.typeName, row.mass, row.maxVelocity, row.inertia, row.radius, row.signatureRadius, row.warpSpeedMultiplier];
    assert.deepStrictEqual(pick(movement.find((row) => row.typeID === 342000)), ["Rifter Mk II", 1200000, 420, 3.2, 40, 35, 6], order);
    assert.deepStrictEqual(pick(movement.find((row) => row.typeID === 342002)), ["Rifter Mk III", 1100000, 355, 3.2, 31, 35, 5], order);
    assert.deepStrictEqual([dogma["342000"].typeName, dogma["342000"].attributes["37"], dogma["342000"].attributeCount],
      ["Rifter Mk II", 420, 12]);
    assert.strictEqual(dogma["587"].attributes["37"], 355, "source entry untouched");
    assert.deepStrictEqual([runtime.stats.shipRowsAdded, runtime.stats.shipDogmaAdded, runtime.stats.movementRowsAdded], [2, 2, 2], order);
  }
});

test("CS4 shop hint: listed false -> not in buildCatalog; shop.price -> entry price, PRICE_OVERRIDES (env) wins", () => {
  const entries = [shipEntry({ second: true, blueprints: [[342001, 342000, { listed: true, price: 250000000 }],
    [342003, 342002, { listed: false }]] })];
  const plan = packLib.buildPlan(entries, shipFacts());
  assert.deepStrictEqual(plan.rejected, []);
  const catalog = shopCatalog.buildCatalog(plan, shopConfig());
  assert.deepStrictEqual(catalog.map((entry) => [entry.typeID, entry.priceClass, entry.price]), [[342001, "default", 250000000]]);
  const overridden = shopCatalog.buildCatalog(plan, shopConfig({ EVEJS_CUSTOMTYPES_SHOP_PRICE_OVERRIDES: "342001=7" }));
  assert.deepStrictEqual(overridden.map((entry) => [entry.typeID, entry.price]), [[342001, 7]]);
});

test("CS5 vendor facts: ship table seams present in EveJS sources; ship DRIFT refuses only packs with a ship", () => {
  const report = viability.inspectShips(runtimeRoot);
  assert.ok(report.ok, report.reports.filter((entry) => !entry.ok).map((entry) => `${entry.key}: ${entry.reason}`).join("; "));
  const entries = [shipEntry(), ...fixtureEntries()];
  const plan = packLib.buildPlan(entries, shipFacts({ shipTablesDrift: true }));
  assert.deepStrictEqual(plan.packs.map((pack) => pack.packID), ["pi-blueprints", "planetary-drill"]);
  assert.deepStrictEqual(plan.rejected.map((entry) => entry.reason), ["ship tables drift"]);
  const reference = makeFakeReference({ itemTypes: { types: [...clone(VANILLA_TYPES), clone(RIFTER)] } });
  const logs = [];
  const errors = [];
  const runtime = loader._testing.createRuntime({ config: { enabled: true, cleanup: false, shop: configModule.SHOP_DEFAULTS },
    entries, logFn: (message) => logs.push(message), logErrorFn: (message) => errors.push(message), shipsDrift: true });
  runtime.apply("store", makeFakeStore({ industryBlueprints: blueprintTable() }));
  runtime.applyReference(reference);
  const rows = reference.readStaticRows("itemTypes");
  assert.strictEqual(countType(rows, 342000), 0);
  assert.strictEqual(countType(rows, 340431), 1);
  assert.deepStrictEqual(errors, ["pack design-rifter (design-rifter.json) refused: ship tables drift - whole pack skipped"]);
});

test("CS6 icons[] structure (server never reads the PNG) and pack v2 strict keys", () => {
  const sha = "a".repeat(64);
  const icon = (patch = {}) => ({ iconID: 950000, templateIconID: 21, file: "icons/950000.png", sha256: sha, ...patch });
  const withIcons = (icons, iconID = 950000) => ({ file: "i.json", pack: { packID: "icons", version: 1,
    types: [{ typeID: 342100, sourceTypeID: 971, overrides: { name: "Iconic Blueprint", iconID } }], icons } });
  const ok = packLib.buildPlan([withIcons([icon()])], shipFacts());
  assert.deepStrictEqual([ok.rejected, ok.packs[0].iconIDs], [[], [950000]]);
  for (const [icons, pattern] of [
    [[icon({ iconID: 949999 })], /outside 950000-959999/u],
    [[icon({ file: "../x.png" })], /file must be icons/u],
    [[icon({ iconID: 950001, file: "icons/950001.png" })], /icon 950001 is used by no type/u],
  ]) {
    const plan = packLib.buildPlan([withIcons(icons)], shipFacts());
    assert.strictEqual(plan.rejected.length, 1, String(pattern));
    assert.match(plan.rejected[0].reason, pattern);
  }
  const twice = packLib.buildPlan([withIcons([icon()]), { file: "j.json", pack: { ...withIcons([icon()]).pack, packID: "icons2",
    types: [{ typeID: 342101, sourceTypeID: 971, overrides: { name: "Other", iconID: 950000 } }] } }], shipFacts());
  assert.match(twice.rejected[0].reason, /icon 950000 declared twice/u, "unique across packs");
  const strict = packLib.buildPlan([{ file: "k.json", pack: shipPack({ extra: { foo: 1 } }) }], shipFacts());
  assert.match(strict.rejected[0].reason, /unknown pack keys foo/u);
});

async function main() {
  let passed = 0;
  let failed = 0;
  const selected = tests.filter((entry) => !only || only.some((fragment) => entry.name.includes(fragment)));
  for (const entry of selected) {
    try {
      await entry.fn();
      passed += 1;
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${entry.name}`);
      console.log(error && error.stack ? error.stack : error);
    }
  }
  console.log(`${passed}/${selected.length} PASS`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
