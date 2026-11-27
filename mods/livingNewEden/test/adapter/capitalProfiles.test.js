"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const cp = require("../../lib/adapter/capitalProfiles");
const data = require("../../lib/adapter/data/capitalLiveProfiles");
const { FACTION_HULL_CLASSES, classTypeOf } = require("../../lib/strategy/data/factionHullClasses");
const { CAPITAL_HULL_GROUPS } = require("../../lib/fleets/schema");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const loader = require("../../loader");
const { npcSetupTables } = require("../_support/setupTables");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_SRC = path.join(REPO_ROOT, "server", "src");
const FACTION_IDS = Object.keys(FACTION_HULL_CLASSES).map(Number);
const DOOMSDAY = 24550;
const RACE_IDENTITY = { blood: [1000134, 500012], guristas: [1000127, 500010], serpentis: [1000135, 500020],
  sanshas: [1000162, 500019], angel: [1000138, 500011] };

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function template(profileID) {
  const race = Object.keys(RACE_IDENTITY).find((r) => profileID.includes(r)
    || (r === "angel" && profileID.includes("domination"))) || "sanshas";
  const titan = profileID.endsWith("_titan");
  const fighters = profileID === "capital_true_sanshas_supercarrier";
  const behaviorProfile = { behaviorProfileID: `${profileID}_behavior`, name: profileID, thinkIntervalMs: 500,
    movementMode: "orbit", orbitDistanceMeters: 40000 };
  if (titan) Object.assign(behaviorProfile, { capitalSuperweaponModuleTypeID: DOOMSDAY,
    capitalSuperweaponTargetMode: "item" });
  if (fighters) {
    Object.assign(behaviorProfile, { capitalFighterWingTypeIDs: [159, 160, 161, 162, 163]
      .map((tubeFlagID, i) => ({ typeID: 32340 + i, tubeFlagID })), capitalFighterAbilitySlotID: 0,
    capitalFighterLaunchOnce: true });
  }
  return {
    profileID, name: profileID, shortName: profileID, description: "t", aliases: [profileID],
    faction: { id: race, name: race, corporationID: RACE_IDENTITY[race][0], factionID: RACE_IDENTITY[race][1],
      hardwareFamily: `${race}Family` },
    classID: titan ? "titan" : (fighters ? "supercarrier" : "dreadnought"), rarity: titan ? "officer" : "standard",
    shipTypeID: 37463, bounty: titan ? 240000000 : 60000000, spawnDistanceMeters: titan ? 140000 : 75000,
    ...(titan ? { titanSuperweaponHullTypeID: 11567 } : {}),
    loadout: { modules: [...(titan ? [{ typeID: DOOMSDAY, flagIDs: [11], moduleRole: "weapon" }] : []),
      { typeID: 41118, flagIDs: [12, 13] }], charges: [{ typeID: 17680, quantityPerModule: 1 }], cargo: [] },
    behaviorProfile,
    lootTable: { name: `${profileID} loot`, minEntries: 1, maxEntries: 2, entries: [{ typeID: 41501, weight: 1 }] },
  };
}

function templateIds() {
  const ids = new Set();
  for (const byClass of Object.values(data.TEMPLATE_BY_RACE_CLASS)) for (const id of Object.values(byClass)) ids.add(id);
  for (const id of Object.values(data.IDENTITY_TEMPLATE_BY_RACE)) ids.add(id);
  return [...ids];
}

function fullAuthority() {
  return templateIds().map(template);
}

function build(overrides = {}) {
  return cp.buildCapitalProfileRows({ authority: fullAuthority(), classTypeOf, factionIds: FACTION_IDS,
    classes: [...CAPITAL_HULL_GROUPS], fighters: false, superweapons: false, data, ...overrides });
}

function rowById(rows, table, key, id) {
  return rows[table].find((r) => r[key] === id);
}

module.exports = ({ test, skip }) => {
  const setupTables = npcSetupTables();
  if (!setupTables.ok) skip("CLP4 capitalNpcAuthority data part", setupTables.reason);
  test("CLP1 one profile lne_capital_<f>_<cls> per faction x class of FACTION_HULL_CLASSES: real hull, capitalNpc, "
    + "runtime class, linked rows, empire 0/0 bounty 0 no loot; IDs never the vendor's; missing template -> skipped",
  () => {
    const r = build();
    assert.strictEqual(r.ok, true);
    const pairs = [];
    for (const f of FACTION_IDS) for (const cls of Object.keys(FACTION_HULL_CLASSES[f])) pairs.push([f, cls]);
    assert.strictEqual(pairs.length, 32);
    assert.strictEqual(r.rows.npcProfiles.length, 32);
    for (const [f, cls] of pairs) {
      const id = `lne_capital_${f}_${cls}`;
      const p = rowById(r.rows, "npcProfiles", "profileID", id);
      assert.ok(p, id);
      const typeId = classTypeOf(f, cls);
      assert.deepStrictEqual([p.shipTypeID, p.presentationTypeID, p.capitalNpc, p.capitalClassID],
        [typeId, typeId, true, data.CAPITAL_CLASS_RUNTIME[cls]], id);
      assert.ok(rowById(r.rows, "npcLoadouts", "loadoutID", p.loadoutID), `${id} loadout`);
      assert.ok(rowById(r.rows, "npcBehaviorProfiles", "behaviorProfileID", p.behaviorProfileID), `${id} behaviour`);
      assert.deepStrictEqual(r.index[String(f)][cls], { profileId: id, typeId });
      const empire = data.EMPIRE_FACTION_IDS.includes(f);
      if (empire) {
        assert.deepStrictEqual([p.corporationID, p.factionID, p.bounty, p.lootTableID], [0, 0, 0, null], id);
      } else {
        const race = data.TEMPLATE_RACE_BY_FACTION_ID[f];
        assert.deepStrictEqual([p.corporationID, p.factionID], RACE_IDENTITY[race], id);
        assert.ok(p.bounty > 0 && rowById(r.rows, "npcLootTables", "lootTableID", p.lootTableID), `${id} loot`);
      }
    }
    assert.ok(r.skipped.length === 13 && r.skipped.every((s) => s.reason === "NO_TYPE"), JSON.stringify(r.skipped));
    const vendorIds = new Set(fullAuthority().flatMap((t) => [t.profileID, `${t.profileID}_loadout`,
      `${t.profileID}_loot`, t.behaviorProfile.behaviorProfileID]));
    const ours = [...r.rows.npcProfiles.map((x) => x.profileID), ...r.rows.npcLoadouts.map((x) => x.loadoutID),
      ...r.rows.npcBehaviorProfiles.map((x) => x.behaviorProfileID), ...r.rows.npcLootTables.map((x) => x.lootTableID)];
    assert.ok(ours.every((id) => id.startsWith("lne_capital_") && !vendorIds.has(id)));
    assert.strictEqual(new Set(ours).size, ours.length, "unique IDs");

    const four = cp.buildCapitalProfileRows({ authority: ["capital_blood_dreadnought", "capital_dark_blood_titan",
      "capital_guristas_dreadnought", "capital_true_sanshas_supercarrier"].map(template), classTypeOf,
    factionIds: FACTION_IDS, classes: [...CAPITAL_HULL_GROUPS], fighters: false, superweapons: false, data });
    assert.strictEqual(four.ok, true);
    assert.ok(four.rows.npcProfiles.some((p) => p.profileID === "lne_capital_500003_titan"));
    assert.ok(!four.rows.npcProfiles.some((p) => p.profileID === "lne_capital_500002_dreadnought"));
    assert.ok(four.skipped.some((s) => s.factionId === 500002 && s.cls === "dreadnought" && s.reason === "NO_TEMPLATE"));
    const titans = build({ classes: ["titan"] });
    assert.ok(titans.rows.npcProfiles.length > 0 && titans.rows.npcProfiles.every((p) => p.profileID.endsWith("_titan")));
    assert.deepStrictEqual(build({ authority: [] }), { ok: false, reason: "NO_TEMPLATES" });
    assert.deepStrictEqual(build({ classTypeOf: null }), { ok: false, reason: "INVALID_INPUT" });
  });

  test("CLP2 fighters / superweapons off -> no capitalFighter* / capitalSuperweapon* fields, no doomsday module, no "
    + "superweapon hull; on -> from the template (carrier 3 tubes, supercarrier 5)", () => {
    const off = build();
    const on = build({ fighters: true, superweapons: true });
    const beh = (r, id) => rowById(r.rows, "npcBehaviorProfiles", "behaviorProfileID", `${id}_behavior`);
    const lo = (r, id) => rowById(r.rows, "npcLoadouts", "loadoutID", `${id}_loadout`);
    const prof = (r, id) => rowById(r.rows, "npcProfiles", "profileID", id);
    for (const r of off.rows.npcBehaviorProfiles) {
      assert.ok(!Object.keys(r).some((k) => k.startsWith("capitalFighter") || k.startsWith("capitalSuperweapon")),
        r.behaviorProfileID);
    }
    for (const r of off.rows.npcLoadouts) assert.ok(!r.modules.some((m) => m.typeID === DOOMSDAY), r.loadoutID);
    assert.ok(off.rows.npcProfiles.every((p) => p.titanSuperweaponHullTypeID === null));
    const titan = "lne_capital_500003_titan";
    assert.deepStrictEqual([beh(on, titan).capitalSuperweaponModuleTypeID, beh(on, titan).capitalSuperweaponTargetMode],
      [DOOMSDAY, "item"]);
    assert.ok(lo(on, titan).modules.some((m) => m.typeID === DOOMSDAY));
    assert.ok(lo(off, titan).modules.some((m) => m.typeID === 41118), "the guns stay");
    assert.strictEqual(prof(on, titan).titanSuperweaponHullTypeID, 11567);
    assert.strictEqual(beh(on, "lne_capital_500001_carrier").capitalFighterWingTypeIDs.length, 3);
    assert.strictEqual(beh(on, "lne_capital_500020_supercarrier").capitalFighterWingTypeIDs.length, 5);
    assert.strictEqual(beh(on, "lne_capital_500020_supercarrier").capitalFighterLaunchOnce, true);
    const frozen = fullAuthority().map((t) => JSON.parse(JSON.stringify(t)));
    frozen.forEach(function freeze(o) { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } });
    assert.strictEqual(cp.buildCapitalProfileRows({ authority: frozen, classTypeOf, factionIds: FACTION_IDS,
      classes: [...CAPITAL_HULL_GROUPS], fighters: true, superweapons: false, data }).ok, true);
  });

  test("CM6: every lne_capital_*_force_auxiliary loadout is empty (modules, charges, cargo) "
    + "with superweapons off and on; the dreadnought of the same faction keeps the modules of the template; the FAX "
    + "profile and behaviour stay from the dreadnought template", () => {
    assert.deepStrictEqual([...data.UNARMED_CLASSES], ["force_auxiliary"]);
    for (const superweapons of [false, true]) {
      const r = build({ superweapons });
      const faxes = r.rows.npcProfiles.filter((p) => p.profileID.endsWith("_force_auxiliary"));
      assert.ok(faxes.length > 0);
      for (const p of faxes) {
        const lo = rowById(r.rows, "npcLoadouts", "loadoutID", p.loadoutID);
        assert.deepStrictEqual([lo.modules, lo.charges, lo.cargo], [[], [], []], p.profileID);
        const dreadId = p.profileID.replace(/_force_auxiliary$/, "_dreadnought");
        const dread = rowById(r.rows, "npcProfiles", "profileID", dreadId);
        if (!dread) continue;
        const dlo = rowById(r.rows, "npcLoadouts", "loadoutID", dread.loadoutID);
        assert.ok(dlo.modules.some((m) => m.typeID === 41118), `${dreadId} keeps the template modules`);
        assert.deepStrictEqual([p.capitalClassID, p.hardwareFamily, p.bounty, p.lootTableID === null],
          [dread.capitalClassID, dread.hardwareFamily, dread.bounty, dread.lootTableID === null], p.profileID);
        assert.ok(rowById(r.rows, "npcBehaviorProfiles", "behaviorProfileID", p.behaviorProfileID), p.profileID);
      }
    }
  });

  test("CLP3 wrap: vendor rows first, the same array at every call, a table without LNE rows = the vendor array; "
    + "build throws -> vendor result for good, buildFailed counted once, never a throw", () => {
    const vendorProfiles = Object.freeze([{ profileID: "capital_blood_dreadnought" }]);
    const vendorPools = Object.freeze([{ spawnPoolID: "capital_npc_all" }]);
    const original = (t) => (t === "npcProfiles" ? vendorProfiles : (t === "npcSpawnPools" ? vendorPools : []));
    let builds = 0;
    const wrapped = cp.wrapCapitalGeneratedRows(original, () => { builds += 1; return build(); });
    const a = wrapped("npcProfiles");
    assert.strictEqual(wrapped("npcProfiles"), a, "same array");
    assert.strictEqual(a[0], vendorProfiles[0], "vendor first");
    assert.strictEqual(a.length, 33);
    assert.strictEqual(wrapped("npcSpawnPools"), vendorPools, "no LNE rows -> the vendor array");
    assert.strictEqual(builds, 1);

    cp._resetForTest();
    try {
      const exportsObj = { getCapitalNpcGeneratedRows: original };
      const outcomes = [];
      assert.deepStrictEqual(cp.install(exportsObj, { build: () => { throw new Error("boom"); },
        onOutcome: (o, d) => outcomes.push([o, d.reason]) }), { ok: true, alreadyInstalled: false });
      assert.deepStrictEqual(cp.install(exportsObj, { build: () => build() }), { ok: true, alreadyInstalled: true });
      const w = exportsObj.getCapitalNpcGeneratedRows;
      assert.strictEqual(w("npcProfiles"), vendorProfiles);
      assert.strictEqual(w("npcProfiles"), vendorProfiles);
      assert.deepStrictEqual(outcomes, [["failed", "BUILD_THREW"]]);
      assert.strictEqual(cp.stats().buildFailed, 1);
      assert.deepStrictEqual(cp.readIndex(), { ok: false, reason: "NOT_BUILT" });
      const refused = cp.wrapCapitalGeneratedRows(original, () => ({ ok: false, reason: "NO_TEMPLATES" }));
      assert.strictEqual(refused("npcProfiles"), vendorProfiles);
      assert.deepStrictEqual(cp.install({}, { build: () => build() }), { ok: false, reason: "NOT_A_FUNCTION" });
    } finally {
      cp._resetForTest();
    }
  });

  test("CLP4 vendor facts: npcData destructures getCapitalNpcGeneratedRows from capitalNpcCatalog and compares "
    + "cached.generatedRows by identity; normalizeBehaviorOverrides has no capital fields; the definer exports the "
    + "symbol; every template of capitalLiveProfiles.js exists in capitalNpcAuthority/data.json", () => {
    const npcData = readSource("space/npc/npcData.js");
    assert.ok(npcData.includes("const {\n  getCapitalNpcGeneratedRows,\n} = require(path.join(__dirname, "
      + "\"./capitals/capitalNpcCatalog\"));"), "destructuring");
    assert.ok(npcData.includes("cached.generatedRows === generatedRows"), "identity cache");
    assert.ok(npcData.includes("const generatedRows = getCapitalNpcGeneratedRows(tableName);"));
    const behaviour = functionBody(readSource("space/npc/npcBehaviorLoop.js"), "normalizeBehaviorOverrides");
    assert.ok(!behaviour.includes("capitalFighterWingTypeIDs") && !behaviour.includes("capitalSuperweaponModuleTypeID"));
    const catalog = readSource("space/npc/capitals/capitalNpcCatalog.js");
    assert.ok(catalog.includes("\nfunction getCapitalNpcGeneratedRows(tableName) {\n"));
    assert.ok(catalog.includes("\n  getCapitalNpcGeneratedRows,\n"), "export");
    assert.ok(catalog.includes("capitalNpc: true,") && catalog.includes("capitalClassID: authorityEntry.classID,"));
    const authority = readSource("space/npc/capitals/capitalNpcAuthority.js");
    assert.ok(authority.includes("\n  CAPITAL_NPC_AUTHORITY,\n"), "authority export");
    const entries = GAME_MODULES.filter((e) => e.path === "space/npc/capitals/capitalNpcCatalog")
      .flatMap((e) => e.symbols);
    assert.deepStrictEqual(entries.map((s) => [s.name, s.firstLoad, s.wrap, [...s.consumers]]),
      [["getCapitalNpcGeneratedRows", true, true, ["capitalLive", "factionProfiles"]]]);
    if (setupTables.ok) {
      const json = setupTables.tables.capitalNpcAuthority;
      const byId = new Map(json.entries.map((e) => [e.profileID, e]));
      for (const id of templateIds()) assert.ok(byId.has(id), `template ${id}`);
      const fighter = byId.get("capital_true_sanshas_supercarrier").behaviorProfile.capitalFighterWingTypeIDs;
      assert.ok(Array.isArray(fighter) && fighter.length >= data.FIGHTER_TUBES.supercarrier);
      for (const race of Object.keys(data.TEMPLATE_BY_RACE_CLASS)) {
        const titan = data.TEMPLATE_BY_RACE_CLASS[race].titan;
        if (titan) assert.ok(byId.get(titan).behaviorProfile.capitalSuperweaponModuleTypeID > 0, titan);
      }
    }
  });

  test("CLP5 loader: flag off -> getCapitalNpcGeneratedRows stays the vendor function; on -> wrapped, the "
    + "templates come from the capitalNpcAuthority hook; the real adapter facade has capitalLiveIndex", () => {
    const CATALOG = path.join(path.sep, "x", "server", "src", "space", "npc", "capitals", "capitalNpcCatalog");
    const PARENT_NPC = { filename: path.join(path.sep, "x", "server", "src", "space", "npc", "npcData.js") };
    const PARENT_CAT = { filename: `${CATALOG}.js` };
    const silent = { log: () => {}, logError: () => {}, debug: () => {} };
    const run = (capitalLiveEnabled) => {
      const vendor = Object.freeze([{ profileID: "capital_blood_dreadnought" }]);
      const original = function getCapitalNpcGeneratedRows(t) { return t === "npcProfiles" ? vendor : []; };
      const catalogExports = { getCapitalNpcGeneratedRows: original };
      const authorityExports = { CAPITAL_NPC_AUTHORITY: Object.freeze(fullAuthority()) };
      const moduleApi = { _cache: {}, _load: (request) => (request === CATALOG ? catalogExports
        : (request === "./capitalNpcAuthority" ? authorityExports : {})) };
      const ctx = { state: {}, logger: silent, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
        config: { enabled: true, debug: false, dataDir: "/x", modules: { materialization: { enabled: true } },
          materialization: { capitalLiveEnabled, capitalClassesLive: "dreadnought,titan",
            capitalFightersEnabled: false, capitalSuperweaponsEnabled: false } } }) };
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), silent);
      moduleApi._load("./capitalNpcAuthority", PARENT_CAT);
      moduleApi._load(CATALOG, PARENT_NPC);
      return { ctx, catalogExports, original, vendor };
    };
    cp._resetForTest();
    try {
      const off = run(false);
      assert.deepStrictEqual([off.ctx.state.capitalLive, off.catalogExports.getCapitalNpcGeneratedRows === off.original],
        ["disabled", true]);
      assert.deepStrictEqual(cp.readIndex(), { ok: false, reason: "DISABLED" });
      const on = run(true);
      assert.strictEqual(on.ctx.state.capitalLive, "wrapped");
      const rows = on.catalogExports.getCapitalNpcGeneratedRows("npcProfiles");
      assert.strictEqual(rows[0], on.vendor[0]);
      assert.ok(rows.length > 1 && rows.slice(1).every((p) => /^lne_capital_\d+_(dreadnought|titan)$/.test(p.profileID)));
      assert.strictEqual(on.catalogExports.getCapitalNpcGeneratedRows("npcProfiles"), rows, "same array");

      const adapter = createAdapter({ moduleApi: { _cache: {} } });
      assert.strictEqual(typeof adapter.capitalLiveIndex, "function");
      const idx = adapter.capitalLiveIndex();
      assert.strictEqual(idx.ok, true);
      assert.deepStrictEqual(idx.index["500003"].titan, { profileId: "lne_capital_500003_titan",
        typeId: classTypeOf(500003, "titan") });
      assert.ok(!("carrier" in idx.index["500003"]), "capitalClassesLive respected");
    } finally {
      cp._resetForTest();
    }
  });
};
