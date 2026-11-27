"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const fp = require("../../lib/adapter/factionProfiles");
const cp = require("../../lib/adapter/capitalProfiles");
const data = require("../../lib/adapter/data/factionLiveProfiles");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { HULL_CLASSES, NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
const { createNpcSpawn } = require("../../lib/adapter/npcSpawn");
const loader = require("../../loader");
const { npcSetupTables } = require("../_support/setupTables");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_SRC = path.join(REPO_ROOT, "server", "src");
const SOE = 500016;
const HULLS = { frigate: 33468, destroyer: 16240, cruiser: 33470, battlecruiser: 16229, battleship: 33472 };
const PRESENTATION = { frigate: 57797, destroyer: 25125, cruiser: 57798, battlecruiser: 46076, battleship: 57799 };

const readText = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

module.exports = ({ test, skip }) => {
  const setupTables = npcSetupTables();
  if (!setupTables.ok) skip("F4 NPC setup table part", setupTables.reason);
  test("F1 builder: 5 npcProfiles rows lne_faction_500016_<class> (Astero/Catalyst/Stratios/Brutix/Nestor), SoE "
    + "faction + corporation, serpentis, security 0, bounty 0, unique IDs; byClass keys = HULL_CLASSES", () => {
    for (const f of Object.keys(data.FACTION_LIVE_PROFILES)) {
      assert.deepStrictEqual(Object.keys(data.FACTION_LIVE_PROFILES[f].byClass), [...HULL_CLASSES], f);
    }
    const r = fp.buildFactionProfileRows({ data });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(Object.keys(r.rows), ["npcProfiles"]);
    const rows = r.rows.npcProfiles;
    assert.strictEqual(rows.length, 5);
    assert.deepStrictEqual(rows.map((p) => [p.profileID, p.shipTypeID, p.presentationTypeID]),
      HULL_CLASSES.map((c) => [`lne_faction_${SOE}_${c}`, HULLS[c], PRESENTATION[c]]));
    for (const p of rows) {
      assert.deepStrictEqual([p.factionID, p.corporationID, p.hardwareFamily, p.securityStatus, p.bounty,
        p.entityType, p.preferredTargetMode, p.spawnDistanceMeters, p.lootTableID],
      [SOE, 1000130, "serpentis", 0, 0, "npc", "invoker", 5000, "parity_faction_warfare_entities_pending_loot"],
      p.profileID);
      assert.ok(p.name.startsWith("Sisters of EVE ") && p.shipNameTemplate === p.name, p.profileID);
    }
    assert.strictEqual(new Set(rows.map((p) => p.profileID)).size, 5, "unique profile IDs");
    assert.deepStrictEqual(r.index, fp.navyTableOf(data));
    assert.deepStrictEqual(fp.buildFactionProfileRows({ data: {} }), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(fp.buildFactionProfileRows(null), { ok: false, reason: "INVALID_INPUT" });
    assert.ok(!Object.prototype.hasOwnProperty.call(NAVY_PROFILES_BY_FACTION_ID, String(SOE)), "SOE has no navy profile");
  });

  test("F2 coverage: resolveProfiles({factionId:500016, hullGroup}) for every group of HULL_CLASS_BY_GROUP -> "
    + "lne_faction_500016_<class> with the merged navy table; without the merge -> NO_PROFILE", () => {
    const requireGame = () => { throw new Error("no game in this test"); };
    const spawnOf = (navyProfiles) => createNpcSpawn({ requireGame, navyProfiles, data: liveProfiles });
    const merged = spawnOf(Object.freeze({ ...NAVY_PROFILES_BY_FACTION_ID, ...fp.navyTableOf(data) }));
    const plain = spawnOf(NAVY_PROFILES_BY_FACTION_ID);
    const groups = Object.keys(liveProfiles.HULL_CLASS_BY_GROUP);
    assert.ok(groups.length >= 5);
    for (const hullGroup of groups) {
      const req = [{ factionId: SOE, hullGroup, memberKey: `m-${hullGroup}` }];
      assert.deepStrictEqual(merged.resolveProfiles(req, { seedPrefix: "f2" }),
        { ok: true, profiles: [`lne_faction_${SOE}_${liveProfiles.HULL_CLASS_BY_GROUP[hullGroup]}`] }, hullGroup);
      const off = plain.resolveProfiles(req, { seedPrefix: "f2" });
      assert.deepStrictEqual([off.ok, off.reason], [false, "NO_PROFILE"], hullGroup);
    }
  });

  test("F3 wrap chain: capital + faction on one catalog -> rows of both, the same array per call; faction build "
    + "throws -> the inner result unchanged; capital re-install -> alreadyInstalled; loader hook on/off", () => {
    const vendor = Object.freeze([{ profileID: "capital_blood_dreadnought" }]);
    const original = (t) => (t === "npcProfiles" ? vendor : []);
    const capitalRow = Object.freeze({ profileID: "lne_capital_500003_titan" });
    const capitalBuild = () => ({ ok: true, rows: { npcProfiles: Object.freeze([capitalRow]) }, index: {}, skipped: [] });
    cp._resetForTest();
    fp._resetForTest();
    try {
      assert.deepStrictEqual(fp.installedNavyTable(), {}, "not installed");
      const cat = { getCapitalNpcGeneratedRows: original };
      assert.deepStrictEqual(cp.install(cat, { build: capitalBuild }), { ok: true, alreadyInstalled: false });
      const outcomes = [];
      assert.deepStrictEqual(fp.install(cat, { build: () => fp.buildFactionProfileRows({ data }),
        onOutcome: (o, d) => outcomes.push([o, d.rowsInjected]) }), { ok: true, alreadyInstalled: false });
      const rows = cat.getCapitalNpcGeneratedRows("npcProfiles");
      assert.strictEqual(cat.getCapitalNpcGeneratedRows("npcProfiles"), rows, "same array");
      assert.deepStrictEqual(rows.map((p) => p.profileID), ["capital_blood_dreadnought", "lne_capital_500003_titan",
        ...HULL_CLASSES.map((c) => `lne_faction_${SOE}_${c}`)]);
      assert.strictEqual(cat.getCapitalNpcGeneratedRows.name, fp.LABEL);
      assert.deepStrictEqual(outcomes, [["built", 5]]);
      assert.deepStrictEqual(fp.installedNavyTable(), fp.navyTableOf(data));
      assert.deepStrictEqual(cp.install(cat, { build: capitalBuild }), { ok: true, alreadyInstalled: true });
      assert.deepStrictEqual(fp.install(cat, { build: () => null }), { ok: true, alreadyInstalled: true });

      fp._resetForTest();
      const cat2 = { getCapitalNpcGeneratedRows: original };
      cp.install(cat2, { build: capitalBuild });
      const inner = cat2.getCapitalNpcGeneratedRows("npcProfiles");
      fp.install(cat2, { build: () => { throw new Error("boom"); } });
      assert.strictEqual(cat2.getCapitalNpcGeneratedRows("npcProfiles"), inner, "inner result unchanged");
      assert.deepStrictEqual(fp.installedNavyTable(), {}, "build failed -> no profile reaches the spawn");
      assert.strictEqual(fp.stats().buildFailed, 1);
      assert.deepStrictEqual(fp.install({}, { build: () => null }), { ok: false, reason: "NOT_A_FUNCTION" });
    } finally {
      cp._resetForTest();
      fp._resetForTest();
    }

    const CATALOG = path.join(path.sep, "x", "server", "src", "space", "npc", "capitals", "capitalNpcCatalog");
    const PARENT_NPC = { filename: path.join(path.sep, "x", "server", "src", "space", "npc", "npcData.js") };
    const lines = [];
    const logger = { log: (l) => lines.push(l), logError: () => {}, debug: () => {} };
    const run = (factionProfilesEnabled) => {
      const catalogExports = { getCapitalNpcGeneratedRows: original };
      const moduleApi = { _cache: {}, _load: (request) => (request === CATALOG ? catalogExports : {}) };
      const ctx = { state: {}, logger, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
        config: { enabled: true, debug: false, dataDir: "/x", modules: { materialization: { enabled: false } },
          materialization: { capitalLiveEnabled: false, factionProfilesEnabled } } }) };
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), logger);
      moduleApi._load(CATALOG, PARENT_NPC);
      return { ctx, catalogExports };
    };
    try {
      const off = run(false);
      assert.deepStrictEqual([off.ctx.state.factionProfiles, off.catalogExports.getCapitalNpcGeneratedRows === original],
        ["disabled", true]);
      const on = run(true);
      assert.strictEqual(on.ctx.state.factionProfiles, "wrapped", "no modules.materialization cascade");
      const got = on.catalogExports.getCapitalNpcGeneratedRows("npcProfiles");
      assert.strictEqual(got.length, 6);
      assert.ok(lines.includes("factionLiveProfiles: wrapped - 5 NPC profile row(s) injected"), lines.join("\n"));
    } finally {
      fp._resetForTest();
    }
  });

  const DESTRUCTURE_RE = /const\s*\{\s*getCapitalNpcGeneratedRows\s*,?\s*\}\s*=\s*require\(\s*path\.join\(\s*__dirname\s*,\s*["']\.\/capitals\/capitalNpcCatalog["']\s*\)\s*\)/;
  const SERPENTIS_RE = /\bserpentis\s*:\s*Object\.freeze\(\s*\{/;
  const serpentisWeapons = (hw) => {
    const m = SERPENTIS_RE.exec(hw);
    if (!m) return null;
    const end = hw.indexOf("chargeTypeIDs", m.index);
    return hw.slice(m.index, end < 0 ? hw.length : end);
  };
  const hasTypeId = (block, typeID) => new RegExp(`(^|[^0-9])${Number(typeID)}([^0-9]|$)`).test(block);

  test("F4b vendor fact readers: whitespace-tolerant - the vendor shape, a one-line / reindented shape "
    + "and the serpentis block pass; another symbol, another block or a longer typeID do not", () => {
    for (const text of ["const {\n  getCapitalNpcGeneratedRows,\n} = require(path.join(__dirname, \"./capitals/capitalNpcCatalog\"));",
      "const { getCapitalNpcGeneratedRows } = require(path.join(__dirname, './capitals/capitalNpcCatalog'));",
      "const {\r\n\tgetCapitalNpcGeneratedRows\r\n}=require( path.join( __dirname, \"./capitals/capitalNpcCatalog\" ) );"]) {
      assert.ok(DESTRUCTURE_RE.test(text), text);
    }
    assert.ok(!DESTRUCTURE_RE.test("const { getCapitalNpcRows } = require(path.join(__dirname, \"./capitals/capitalNpcCatalog\"));"));
    const hw = "module.exports = {\n  guristas: Object.freeze({ weaponTypeIDs: [13999], chargeTypeIDs: [1] }),\n"
      + "    serpentis :Object.freeze( {\n\tweaponTypeIDs: [13888,13884,\n 13891], chargeTypeIDs: [13777] }),\n};";
    const block = serpentisWeapons(hw);
    assert.ok(block, "serpentis block");
    for (const id of [13888, 13884, 13891]) assert.ok(hasTypeId(block, id), String(id));
    assert.ok(!hasTypeId(block, 13999), "guristas weapon");
    assert.ok(!hasTypeId(block, 1388), "prefix of a longer typeID");
    assert.ok(!hasTypeId(block, 13777), "after chargeTypeIDs");
    assert.strictEqual(serpentisWeapons("guristas: Object.freeze({})"), null);
  });

  test("F4 vendor facts: FW profiles 75361-75365 and their behaviour profiles, the 4 serpentis loadouts with weapons "
    + "of the serpentis hardware policy, the placeholder loot; npcData destructures getCapitalNpcGeneratedRows", () => {
    const npcData = readText(path.join(SERVER_SRC, "space", "npc", "npcData.js"));
    assert.ok(DESTRUCTURE_RE.test(npcData), "destructuring");
    const hw = readText(path.join(SERVER_SRC, "space", "npc", "npcHardwareCatalog.js"));
    const weapons = serpentisWeapons(hw);
    assert.ok(weapons, "serpentis hardware block");
    const classes = Object.values(data.FACTION_LIVE_PROFILES[SOE].byClass);
    if (!setupTables.ok) return;
    const table = (name, list, key) => new Map(setupTables.tables[name][list].map((r) => [r[key], r]));
    const profiles = table("npcProfiles", "profiles", "profileID");
    const behaviours = table("npcBehaviorProfiles", "behaviorProfiles", "behaviorProfileID");
    const loadouts = table("npcLoadouts", "loadouts", "loadoutID");
    const loot = table("npcLootTables", "lootTables", "lootTableID");
    for (const [i, cls] of HULL_CLASSES.entries()) {
      const fw = profiles.get(`parity_faction_warfare_entities_${75361 + i}_federation_${cls}`);
      assert.ok(fw && fw.shipTypeID === 75361 + i, `FW profile ${75361 + i} ${cls}`);
      assert.strictEqual(fw.behaviorProfileID, data.FACTION_LIVE_PROFILES[SOE].byClass[cls].behaviorProfileId);
    }
    for (const c of classes) {
      assert.ok(behaviours.has(c.behaviorProfileId), c.behaviorProfileId);
      const lo = loadouts.get(c.loadoutId);
      assert.ok(lo && lo.modules.length > 0, c.loadoutId);
      for (const m of lo.modules) assert.ok(hasTypeId(weapons, m.typeID), `${c.loadoutId} ${m.typeID}`);
    }
    assert.ok(loot.has(data.PLACEHOLDER_LOOT_TABLE_ID));
    assert.ok(![...profiles.values()].some((p) => p.factionID === SOE), "no vendor SoE profile");
  });

  test("F5: the slim of an LNE faction NPC is never the player hull "
    + "presentationTypeID = the NPC entity type of the class (not shipTypeID), presentationName = the profile name; "
    + "vendor fact: buildNpcSlimPresentation takes presentationTypeID and presentationName first", () => {
    const rows = fp.buildFactionProfileRows({ data }).rows.npcProfiles;
    for (const [i, c] of HULL_CLASSES.entries()) {
      const p = rows[i];
      assert.notStrictEqual(p.presentationTypeID, p.shipTypeID, `${c}: player hull as the slim = empty ship`);
      assert.strictEqual(p.presentationTypeID, PRESENTATION[c], c);
      assert.strictEqual(p.presentationName, p.name, c);
    }
    const broken = { ...data, FACTION_LIVE_PROFILES: { [SOE]: { ...data.FACTION_LIVE_PROFILES[SOE],
      byClass: { ...data.FACTION_LIVE_PROFILES[SOE].byClass,
        cruiser: { ...data.FACTION_LIVE_PROFILES[SOE].byClass.cruiser, presentationTypeId: undefined } } } } };
    assert.deepStrictEqual(fp.buildFactionProfileRows({ data: broken }), { ok: false, reason: "INVALID_INPUT" });
    const pres = readText(path.join(SERVER_SRC, "space", "npc", "npcPresentation.js"));
    assert.ok(/const\s+presentationTypeID\s*=\s*toPositiveInt\(\s*profile\.presentationTypeID/.test(pres), "type");
    assert.ok(/slimName:\s*String\(\s*profile\.presentationName\s*\|\|/.test(pres), "name");
  });
};
