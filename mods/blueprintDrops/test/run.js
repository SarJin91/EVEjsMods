"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const modDir = path.resolve(__dirname, "..");
const srcRoot = path.resolve(modDir, "../..", "server", "src");
const R = require(path.join(modDir, "lib", "resonators.js"));
const dataJson = JSON.parse(fs.readFileSync(path.join(modDir, "data", "pirateNpcGroups.json"), "utf8"));

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > 0 ? String(process.argv[onlyArg + 1] || "").split(",").filter(Boolean) : [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const read = (rel) => fs.readFileSync(path.join(srcRoot, rel), "utf8");
const DATA = R.loadData(dataJson).data;

function defaults(over = {}) {
  return {
    resonatorsEnabled: true,
    resonatorChance: { frigate: 0.10, destroyer: 0.12, cruiser: 0.15, battlecruiser: 0.18, battleship: 0.25, capital: 0.50, hauler: 0 },
    resonatorQuantity: { frigate: [1, 3], destroyer: [1, 4], cruiser: [2, 6], battlecruiser: [3, 8], battleship: [4, 12], capital: [40, 80], hauler: [0, 0] },
    resonatorEliteChance: 0.50,
    resonatorEliteQuantityMultiplier: 3,
    resonatorComponentsEnabled: true,
    componentChance: 0.30,
    componentAipsPerResonator: 0.5,
    componentLsbuPerResonator: 0.25,
    componentCtrChance: { battleship: 0.05, capital: 1 },
    componentCtrEliteChance: 0.25,
    soeFromAllPirates: false,
    soeChanceMultiplier: 0.25,
    resonatorLogDrops: false,
    resonatorSummaryEvery: 50,
    ...over,
  };
}
function seq(values) {
  let i = 0;
  return () => {
    assert.ok(i < values.length, "rng called more often than expected");
    return values[i++];
  };
}
const src = (factionID, band, tier = "normal") => ({ factionID, resonatorTypeID: DATA.factions.get(factionID).resonatorTypeID, band, tier, via: "group" });
const qty = (rows, typeID) => (rows.find((r) => r.typeID === typeID) || {}).quantity || 0;

test("T1 vendor facts", () => {
  const wreck = read("space/npc/nativeNpcWreckService.js");
  assert.match(wreck, /const \{\s*rollNpcLootEntries,\s*\} = require\(path\.join\(__dirname, "\.\/npcLoot"\)\)/);
  const call = wreck.slice(wreck.indexOf("rollNpcLootEntries(lootTable, {"));
  assert.ok(call.length > 0 && /source: \{[\s\S]{0,200}npcTypeID: wreckRecord\.sourceTypeID/.test(call), "source.npcTypeID");
  assert.match(call.slice(0, 600), /profileID: nativeEntityRecord && nativeEntityRecord\.profileID/);
  assert.match(wreck, /const copyCount = lootEntry\.singleton === 2 \? lootEntry\.quantity : 1;/);
  assert.match(read("space/npc/npcLoot.js"), /module\.exports = \{[\s\S]*?\brollNpcLootEntries,/);
  assert.match(read("space/npc/npcData.js"), /module\.exports = \{[\s\S]*?\bgetNpcProfile,/);
  assert.match(read("space/npc/npcPresentation.js"), /warFactionID: toPositiveInt\(profile\.factionID/);
});

test("T2 resolveSource", () => {
  assert.deepStrictEqual(R.resolveSource({ profileFactionID: 500010, npcGroupID: 562 }, DATA),
    { factionID: 500010, resonatorTypeID: 83469, band: "frigate", tier: "normal", via: "profile" });
  assert.deepStrictEqual(R.resolveSource({ profileFactionID: 0, npcGroupID: 850 }, DATA),
    { factionID: 500010, resonatorTypeID: 83469, band: "battleship", tier: "elite", via: "group" });
  assert.strictEqual(R.resolveSource({ profileFactionID: 500001, npcGroupID: 999999 }, DATA), null);
  assert.strictEqual(R.resolveSource({ profileFactionID: 500010, npcGroupID: 999999 }, DATA), null);
  assert.strictEqual(R.resolveSource({}, DATA), null);
  assert.strictEqual(R.resolveSource(undefined, DATA), null);
});

test("T3 rollResonators", () => {
  const s = defaults();
  assert.deepStrictEqual(R.rollResonators(src(500010, "frigate"), s, seq([0.10])), []);
  assert.strictEqual(qty(R.rollResonators(src(500010, "cruiser"), s, seq([0, 0, 0.9])), 83469), 2);
  assert.strictEqual(qty(R.rollResonators(src(500010, "cruiser"), s, seq([0, 0.9999, 0.9])), 83469), 6);
  assert.strictEqual(qty(R.rollResonators(src(500010, "frigate", "elite"), s, seq([0.4, 0, 0.9])), 83469), 3);
  assert.deepStrictEqual(R.rollResonators(src(500010, "frigate", "elite"), s, seq([0.5])), []);
  const f = R.rollResonators(src(500010, "frigate"), s, seq([0, 0.9999, 0, 0.4, 0.8]));
  assert.deepStrictEqual(f, [{ typeID: 83469, quantity: 3 }, { typeID: 57478, quantity: 2 }]);
  assert.deepStrictEqual(R.rollResonators(src(500010, "frigate"), s, seq([0, 0, 0.30])), [{ typeID: 83469, quantity: 1 }]);
  assert.strictEqual(qty(R.rollResonators(src(500010, "battleship"), s, seq([0, 0, 0.9, 0.01])), 57479), 1);
  assert.strictEqual(qty(R.rollResonators(src(500010, "battleship"), s, seq([0, 0, 0.9, 0.05])), 57479), 0);
  assert.deepStrictEqual(R.rollResonators(src(500010, "hauler"), s, seq([0])), []);
  assert.deepStrictEqual(R.rollResonators(src(500010, "frigate"), defaults({ resonatorComponentsEnabled: false }), seq([0, 0])), [{ typeID: 83469, quantity: 1 }]);
  assert.strictEqual(qty(R.rollResonators(src(500010, "capital", "elite"), s, seq([0.4, 0, 0.9, 0.9])), 57479), 1);
  assert.strictEqual(qty(R.rollResonators(src(500010, "battleship", "elite"), s, seq([0.4, 0, 0.9, 0.25])), 57479), 0);
});

test("T3b SoE roll", () => {
  const s = defaults({ soeFromAllPirates: true });
  const opts = { soeTypeID: 83473 };
  const a = R.rollResonators(src(500020, "frigate"), s, seq([0.3, 0.01, 0, 0, 0.1, 0.5]), opts);
  assert.strictEqual(qty(a, 83472), 0);
  assert.strictEqual(qty(a, 83473), 1);
  assert.strictEqual(qty(a, 57478), 1);
  assert.strictEqual(qty(a, 57486), 0);
  const b = R.rollResonators(src(500020, "frigate"), s, seq([0, 0, 0.025, 0.9]), opts);
  assert.strictEqual(qty(b, 83472), 1);
  assert.strictEqual(qty(b, 83473), 0);
  const c = R.rollResonators(src(500020, "battleship"), s, seq([0, 0, 0, 0, 0, 0]), opts);
  assert.strictEqual(qty(c, 83472), 4);
  assert.strictEqual(qty(c, 83473), 4);
  assert.strictEqual(qty(c, 57478), 4);
  assert.strictEqual(qty(c, 57486), 2);
  assert.strictEqual(c.filter((r) => r.typeID === 57479).length, 1);
  const d = R.rollResonators(src(500020, "frigate"), defaults({ soeFromAllPirates: true, soeChanceMultiplier: 0 }), seq([0, 0, 0.9]), opts);
  assert.strictEqual(qty(d, 83473), 0);
  assert.strictEqual(qty(R.rollResonators(src(500020, "frigate"), defaults(), seq([0, 0, 0.9]), opts), 83473), 0);
  let rngState = 12345;
  const rng = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
  let soe = 0;
  for (let i = 0; i < 4000; i += 1) if (qty(R.rollResonators(src(500010, "frigate"), s, rng, opts), 83473) > 0) soe += 1;
  assert.ok(soe > 4000 * 0.015 && soe < 4000 * 0.035, `SoE drops ${soe}`);
});

test("T4 config and enabling", () => {
  assert.strictEqual(R.validateSettings(defaults()).ok, true);
  const badChance = R.validateSettings(defaults({ resonatorChance: { ...defaults().resonatorChance, cruiser: 1.5 } }));
  assert.strictEqual(badChance.reason, "BAD_CONFIG");
  const badRange = R.validateSettings(defaults({ resonatorQuantity: { ...defaults().resonatorQuantity, frigate: [5, 2] } }));
  assert.strictEqual(badRange.reason, "BAD_CONFIG");
  assert.strictEqual(R.validateSettings(defaults({ soeChanceMultiplier: -1 })).reason, "BAD_CONFIG");
  assert.strictEqual(R.validateSettings(defaults({ componentChance: 0 })).ok, true);
  assert.strictEqual(R.validateSettings(defaults({ componentChance: 1 })).ok, true);
  for (const v of [1.5, -0.1, undefined, "0.3", NaN]) {
    assert.deepStrictEqual(R.validateSettings(defaults({ componentChance: v })), { ok: false, reason: "BAD_CONFIG", detail: "componentChance" }, String(v));
  }
  assert.strictEqual(R.resolveResonatorFlag({ resonatorsEnabled: false }, { EVEJS_BPDROPS_RESONATORS_ENABLED: "1" }), true);
  assert.strictEqual(R.resolveResonatorFlag({ resonatorsEnabled: true }, { EVEJS_BPDROPS_RESONATORS_ENABLED: "false" }), false);
  assert.strictEqual(R.resolveResonatorFlag({ resonatorsEnabled: false }, {}), false);
  const all = new Set([83467, 83468, 83469, 83470, 83471, 83472, 83473, 57478, 57479, 57486]);
  assert.deepStrictEqual(R.checkTypes(DATA, (id) => all.has(id)), { ok: true, componentsOk: true, missingComponents: [] });
  const noRes = R.checkTypes(DATA, (id) => id !== 83470 && all.has(id));
  assert.strictEqual(noRes.reason, "MISSING_TYPE");
  const noComp = R.checkTypes(DATA, (id) => id !== 57479 && all.has(id));
  assert.strictEqual(noComp.ok, true);
  assert.strictEqual(noComp.componentsOk, false);
  const okData = R.loadData(dataJson);
  assert.deepStrictEqual(R.startupState(defaults(), okData), { on: true });
  const badCfg = R.startupState(defaults({ resonatorChance: { ...defaults().resonatorChance, frigate: 2 } }), okData);
  assert.deepStrictEqual([badCfg.on, badCfg.reason, badCfg.detail], [false, "BAD_CONFIG", "resonatorChance.frigate"]);
  assert.deepStrictEqual(R.startupState(defaults({ resonatorsEnabled: false }), okData), { on: false, reason: "DISABLED" });
  const badData = R.startupState(defaults(), { ok: false });
  assert.deepStrictEqual([badData.on, badData.reason], [false, "BAD_DATA"]);
});

test("T6 buildWreckEntries", () => {
  const types = (ids) => new Map(ids.map((id) => [id, { typeID: id, name: `t${id}`, groupID: 0 }]));
  const itemTypes = types([83469, 57478, 57486, 57479]);
  itemTypes.set(9001, { typeID: 9001, name: "npc frig", groupID: 562 });
  itemTypes.set(9002, { typeID: 9002, name: "npc bs elite", groupID: 850 });
  itemTypes.set(9003, { typeID: 9003, name: "npc other", groupID: 999999 });
  const profiles = { p1: { factionID: 500010 } };
  const deps = (over = {}) => ({ data: DATA, itemTypes, soeTypeID: null, componentsOk: true,
    getProfile: (id) => profiles[id] || null, settings: defaults(), rng: seq([]), ...over });
  const e = (id, quantity) => ({ itemType: itemTypes.get(id), typeID: id, name: `t${id}`, quantity, singleton: false });
  const a = R.buildWreckEntries({ profileID: "p1", npcTypeID: 9001 }, deps({ rng: seq([0, 0, 0, 0, 0]) }));
  assert.strictEqual(a.resolved.via, "profile");
  assert.deepStrictEqual(a.entries, [e(83469, 1), e(57478, 1), e(57486, 1)]);
  const b = R.buildWreckEntries({ profileID: "missing", npcTypeID: 9002 }, deps({ rng: seq([0.4, 0, 0, 0.9]) }));
  assert.strictEqual(b.resolved.via, "group");
  assert.deepStrictEqual(b.entries, [e(83469, 12), e(57478, 6), e(57486, 3)]);
  const noLsbu = new Map(itemTypes);
  noLsbu.delete(57486);
  const c = R.buildWreckEntries({ npcTypeID: 9001 }, deps({ itemTypes: noLsbu, rng: seq([0, 0, 0, 0, 0]) }));
  assert.strictEqual(c.rolled.length, 3);
  assert.deepStrictEqual(c.entries.map((x) => x.typeID), [83469, 57478]);
  assert.deepStrictEqual(R.buildWreckEntries({ npcTypeID: 9003 }, deps()), { entries: [], resolved: null, rolled: [] });
});

test("T7 startupReport", () => {
  const okData = R.loadData(dataJson);
  const a = R.startupReport(defaults(), okData);
  assert.strictEqual(a.line, `resonators: on (groups=${DATA.groups.size}, factions=${DATA.factions.size}, soeFromAllPirates=off, types checked at the first wreck)`);
  assert.strictEqual(a.forceOff, false);
  const a2 = R.startupReport(defaults({ soeFromAllPirates: true }), okData);
  assert.strictEqual(a2.line, `resonators: on (groups=${DATA.groups.size}, factions=${DATA.factions.size}, soeFromAllPirates=on, types checked at the first wreck)`);
  const b = R.startupReport(defaults({ resonatorsEnabled: false }), okData);
  assert.deepStrictEqual([b.line, b.forceOff], ["resonators: off", false]);
  const c = R.startupReport(defaults({ resonatorChance: { ...defaults().resonatorChance, frigate: 2 } }), okData);
  assert.deepStrictEqual([c.line, c.forceOff], ["resonators: off (BAD_CONFIG: resonatorChance.frigate)", true]);
  const d = R.startupReport(defaults(), { ok: true, data: {} });
  assert.strictEqual(d.start.reason, "INIT_FAILED");
  assert.ok(d.line.startsWith("resonators: off (INIT_FAILED: "), d.line);
  assert.strictEqual(d.forceOff, true);
  const throwing = defaults();
  Object.defineProperty(throwing, "resonatorChance", { get() { throw new Error("boom"); } });
  const d2 = R.startupReport(throwing, okData);
  assert.deepStrictEqual([d2.start.reason, d2.line, d2.forceOff], ["INIT_FAILED", "resonators: off (INIT_FAILED: boom)", true]);
});

test("T8 shouldRollBlueprint", () => {
  const { shouldRollBlueprint } = require(path.join(modDir, "lib", "lootRoll.js"));
  for (const o of [undefined, null, {}, { source: { npcTypeID: 2387 } }, { extraRoll: false }, { extraRoll: "true" }]) {
    assert.strictEqual(shouldRollBlueprint(o), true, JSON.stringify(o));
  }
  const lneCalls = [{ source: { npcTypeID: 2387 } }, ...Array.from({ length: 9 }, () => ({ extraRoll: true }))];
  assert.strictEqual(lneCalls.filter(shouldRollBlueprint).length, 1);
  assert.strictEqual(shouldRollBlueprint(lneCalls[0]), true, "roll 0 rolls");
  const loaderSrc = fs.readFileSync(path.join(modDir, "loader.js"), "utf8");
  assert.match(loaderSrc, /shouldRollBlueprint\(rest\[0\]\) \? rollBlueprint\(lootTable\) : null/);
  assert.strictEqual((loaderSrc.match(/(?<!function )rollBlueprint\(lootTable\)/g) || []).length, 1, "no ungated call");
});

test("BD-CT1 isDropPoolBlueprint", () => {
  const { isDropPoolBlueprint, CUSTOM_TYPE_ID_MIN, CUSTOM_TYPE_ID_MAX } = require(path.join(modDir, "lib", "blueprintPool.js"));
  assert.deepStrictEqual([CUSTOM_TYPE_ID_MIN, CUSTOM_TYPE_ID_MAX], [340000, 349999]);
  const bp = (typeID, extra) => ({ typeID, categoryID: 9, name: "X Blueprint", ...extra });
  assert.strictEqual(isDropPoolBlueprint(bp(691)), true, "vanilla, published missing");
  assert.strictEqual(isDropPoolBlueprint(bp(691, { published: true })), true, "vanilla published");
  assert.strictEqual(isDropPoolBlueprint(bp(691, { published: false })), false, "published false");
  assert.strictEqual(isDropPoolBlueprint(bp(341000, { published: true })), false, "customTypes range");
  assert.strictEqual(isDropPoolBlueprint(bp(340000, { published: true })), false, "range min");
  assert.strictEqual(isDropPoolBlueprint(bp(349999, { published: true })), false, "range max");
  assert.strictEqual(isDropPoolBlueprint(bp(339999, { published: true })), true, "below range");
  assert.strictEqual(isDropPoolBlueprint(bp(350000, { published: true })), true, "above range");
  assert.strictEqual(isDropPoolBlueprint({ typeID: 691, categoryID: 7, published: true }), false, "not a blueprint");
  assert.strictEqual(isDropPoolBlueprint(null), false, "null");
  assert.strictEqual(isDropPoolBlueprint(undefined), false, "undefined");
  const loaderSrc = fs.readFileSync(path.join(modDir, "loader.js"), "utf8");
  assert.match(loaderSrc, /if \(!isDropPoolBlueprint\(itemType\)\) continue;/);
  assert.doesNotMatch(loaderSrc, /categoryID !== 9/);
});

test("T9 wrapper gates the blueprint draw", () => {
  const Module = require("node:module");
  const npcLootPath = path.normalize(path.join(srcRoot, "space", "npc", "npcLoot.js"));
  const loaderPath = path.join(modDir, "loader.js");
  const calls = [];
  const fakeExp = {
    rollNpcLootEntries(table, options) {
      calls.push({ self: this, table, options, extra: arguments.length });
      return [{ typeID: 34, quantity: 5 }];
    },
  };
  const realLoad = Module._load;
  const realRandom = Math.random;
  const realLog = console.log;
  let draws = 0;
  try {
    Module._load = function stubLoad(request, parent, isMain) {
      let file = null;
      try { file = path.normalize(Module._resolveFilename(request, parent, isMain)); } catch (_e) {}
      return file === npcLootPath ? fakeExp : realLoad.apply(this, arguments);
    };
    console.log = () => {};
    delete require.cache[require.resolve(loaderPath)];
    global.__blueprintDropsInstalled = false;
    require(loaderPath);
    const exp = Module._load(npcLootPath, module, false);
    assert.strictEqual(exp, fakeExp);
    assert.notStrictEqual(exp.rollNpcLootEntries.name, "rollNpcLootEntries", "wrapper installed");
    Math.random = () => { draws += 1; return 0.999; };
    const table = { lootTableID: "loot_belt_normal_small" };
    for (const opts of [undefined, {}, { extraRoll: false }]) {
      draws = 0;
      const out = exp.rollNpcLootEntries(table, opts);
      assert.deepStrictEqual(out, [{ typeID: 34, quantity: 5 }], "vendor entries passed through");
      assert.strictEqual(draws, 1, `native options ${JSON.stringify(opts)} -> one blueprint draw`);
    }
    draws = 0;
    const extra = { extraRoll: true };
    assert.deepStrictEqual(exp.rollNpcLootEntries(table, extra, "x"), [{ typeID: 34, quantity: 5 }]);
    assert.strictEqual(draws, 0, "{ extraRoll: true } -> no blueprint draw");
    const last = calls[calls.length - 1];
    assert.strictEqual(last.self, exp, "this passed through");
    assert.strictEqual(last.table, table);
    assert.strictEqual(last.options, extra, "options passed through unchanged");
    assert.strictEqual(last.extra, 3, "every argument passed through");
  } finally {
    Module._load = realLoad;
    Math.random = realRandom;
    console.log = realLog;
  }
});

test("T10 resonator drop reduction", () => {
  assert.strictEqual(R.roundRandom(2, seq([])), 2);
  assert.strictEqual(R.roundRandom(0, seq([])), 0);
  assert.strictEqual(R.roundRandom(0.25, seq([0.2])), 1);
  assert.strictEqual(R.roundRandom(0.25, seq([0.25])), 0);
  const s1 = defaults({ componentChance: 1 });
  assert.deepStrictEqual(R.rollResonators(src(500010, "frigate"), s1, seq([0, 0, 0, 0.9, 0.2])), [{ typeID: 83469, quantity: 1 }, { typeID: 57486, quantity: 1 }]);
  assert.deepStrictEqual(R.rollResonators(src(500010, "frigate"), s1, seq([0, 0, 0, 0.9, 0.25])), [{ typeID: 83469, quantity: 1 }]);
  const bs = R.rollResonators(src(500010, "battleship"), defaults({ componentChance: 0 }), seq([0, 0, 0]));
  assert.deepStrictEqual(bs, [{ typeID: 83469, quantity: 4 }, { typeID: 57479, quantity: 1 }]);
  let st = 0x5eed;
  const rng = () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const N = 10000;
  const share = (band) => {
    let res = 0;
    let aips = 0;
    for (let i = 0; i < N; i += 1) {
      const out = R.rollResonators(src(500010, band), defaults(), rng);
      if (qty(out, 83469) > 0) res += 1;
      if (qty(out, 57478) > 0) aips += 1;
    }
    return { res: res / N, aips: aips / N };
  };
  const fr = share("frigate");
  assert.ok(fr.res > 0.088 && fr.res < 0.112, `frigate resonator ${fr.res}`);
  assert.ok(fr.aips > 0.019 && fr.aips < 0.031, `frigate AIPS ${fr.aips}`);
  const bsh = share("battleship");
  assert.ok(bsh.res > 0.235 && bsh.res < 0.265, `battleship resonator ${bsh.res}`);
  assert.ok(bsh.aips > 0.065 && bsh.aips < 0.085, `battleship AIPS ${bsh.aips}`);
  const { DEFAULTS } = require(path.join(modDir, "lib", "settings.js"));
  for (const key of Object.keys(defaults())) {
    if (key === "resonatorsEnabled" || key === "soeFromAllPirates") continue;
    assert.deepStrictEqual(defaults()[key], DEFAULTS[key], `defaults() mirrors DEFAULTS.${key}`);
  }
  const settingsJson = JSON.parse(fs.readFileSync(path.join(modDir, "settings.json"), "utf8"));
  for (const key of ["resonatorChance", "resonatorEliteChance", "componentChance", "componentAipsPerResonator", "componentLsbuPerResonator"]) {
    assert.ok(!(key in settingsJson), `settings.json must not override ${key}`);
  }
});

test("T11 mergeSettings and dropRates tool", () => {
  const S = require(path.join(modDir, "lib", "settings.js"));
  const m = S.mergeSettings({ resonatorChance: { frigate: 0.2 }, chanceSmall: 0.5 });
  assert.strictEqual(m.resonatorChance.frigate, 0.2);
  assert.strictEqual(m.resonatorChance.capital, S.DEFAULTS.resonatorChance.capital, "per-band merge");
  assert.strictEqual(m.chanceSmall, 0.5);
  assert.deepStrictEqual([S.DEFAULTS.chanceSmall, S.DEFAULTS.chanceMedium, S.DEFAULTS.chanceLarge, S.DEFAULTS.chanceOther],
    [0.04, 0.08, 0.16, 0.06], "default chances x4");
  assert.strictEqual(m.chanceMedium, 0.08);
  assert.deepStrictEqual(S.mergeSettings(null), S.mergeSettings({}));
  const d = S.mergeSettings({ factionLootTierChance: { normal: { uncommon: 0.1 } }, factionLootBpcRuns: { bpcModule: [2, 2] },
    factionLootCategoryWeights: { epic: { bpcHull: 3 } } });
  assert.deepStrictEqual(d.factionLootTierChance.normal, { uncommon: 0.1, rare: 0.003, epic: 0.0002 });
  assert.deepStrictEqual(d.factionLootTierChance.officer, S.DEFAULTS.factionLootTierChance.officer);
  assert.deepStrictEqual(d.factionLootBpcRuns, { bpcModule: [2, 2], bpcHull: [1, 1] });
  assert.deepStrictEqual(d.factionLootCategoryWeights.epic, { bpcModule: 4, bpcHull: 3 });
  d.factionLootTierChance.mission.epic = 9;
  assert.strictEqual(S.DEFAULTS.factionLootTierChance.mission.epic, 0.0001, "DEFAULTS not aliased");
  const T = require(path.join(modDir, "tools", "dropRates.js"));
  const ids = { resonatorTypeID: 83469, soeTypeID: 83473 };
  const rows = T.simulate(S.mergeSettings({}), ids, { wrecks: 2000, seed: 7 });
  assert.deepStrictEqual(rows.map((r) => r.label), T.ROWS.map((r) => r.label));
  assert.deepStrictEqual(T.simulate(S.mergeSettings({}), ids, { wrecks: 2000, seed: 7 }), rows, "seeded = repeatable");
  assert.ok(Math.abs(rows[0].oldResonator - 0.296875) < 1e-9, "old frigate 1-(0.75)(1-0.0625)");
  for (const r of rows) assert.ok(r.lsbu <= r.aips + 0.02 && r.aips <= r.resonator && r.resonator <= r.oldResonator, r.label);
  const table = T.formatTable(rows).split("\n");
  assert.strictEqual(table.length, 2 + T.ROWS.length);
  assert.match(table[2], /^\| frigate \| 29\.7% -> \d+\.\d% \(\d+\.\dx fewer\) \|/);
});

test("T5 data file", () => {
  assert.strictEqual(R.loadData(dataJson).ok, true);
  const ids = dataJson.groups.map((g) => g.groupID);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b));
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const g of dataJson.groups) {
    assert.ok(dataJson.factions[String(g.factionID)], `faction of ${g.groupID}`);
    assert.ok(R.BANDS.includes(g.band) && R.TIERS.includes(g.tier), `band/tier of ${g.groupID}`);
  }
  for (const id of [562, 560, 850, 4800, 612, 1056, 1287, 703, 553]) assert.ok(DATA.groups.has(id), `group ${id}`);
  const g553 = dataJson.groups.find((g) => g.groupID === 553);
  assert.deepStrictEqual([g553.factionID, g553.band, g553.tier], [500011, "battleship", "elite"]);
  const resIDs = Object.values(dataJson.factions).map((f) => f.resonatorTypeID).sort((a, b) => a - b);
  assert.deepStrictEqual(resIDs, [83467, 83468, 83469, 83470, 83471, 83472, 83473]);
  assert.strictEqual(R.loadData({ ...dataJson, groups: [...dataJson.groups, dataJson.groups[0]] }).reason, "BAD_DATA");
});

const SC = require(path.join(modDir, "lib", "salvageCopies.js"));

test("T12 vendor facts: salvage loot container drops singleton 2", () => {
  const custody = read("services/inventory/salvageItemCustody.js");
  assert.match(custody, /const singleton = itemRecord && itemRecord\.singleton === true;/);
  assert.match(custody, /singleton: singleton \? 1 : 0,/);
  assert.match(custody, /module\.exports = \{\s*transferNativeWreckLootToContainer,\s*\}/);
  const salvager = read("space/modules/salvagerRuntime.js");
  assert.match(salvager, /transferNativeWreckLootToContainer,\s*\} = require\(/, "salvager destructures at load -> first-load hook");
  const bp = read("services/inventory/blueprintRewardState.js");
  for (const name of ["buildBlueprintCopyState", "resolveBlueprintLootCopyState", "ensureGrantedBlueprintCopyState"]) {
    assert.match(bp, new RegExp(`module\\.exports = \\{[\\s\\S]*?\\b${name},`), name);
  }
  assert.match(read("services/inventory/itemStore.js"), /const normalizedSingleton = rawSingleton === 2 \? 2 : rawSingleton > 0 \? 1 : 0;/);
  assert.match(read("services/industry/industryRuntimeState.js"), /module\.exports = \{[\s\S]*?\bremoveBlueprintState,/);
  assert.match(read("space/npc/nativeNpcStore.js"), /module\.exports = \{[\s\S]*?\blistNativeWreckItemsForWreck,[\s\S]*?\bremoveNativeWreckItem,/);
});

function salvageHarness(contents, over = {}) {
  const bpReal = require(path.join(srcRoot, "services", "inventory", "blueprintRewardState.js"));
  const log = { grants: [], states: [], removedStates: [], removedItems: [] };
  let nextID = 500;
  const deps = {
    nativeNpcStore: {
      listNativeWreckItemsForWreck: () => contents,
      removeNativeWreckItem: (id) => { log.removedItems.push(id); return { success: true }; },
    },
    itemStore: {
      ITEM_FLAGS: { HANGAR: 4 },
      grantItemsToOwnerLocation(ownerID, locationID, flagID, entries) {
        log.grants.push({ ownerID, locationID, flagID, entries });
        if (over.failGrantType && entries[0].itemType.typeID === over.failGrantType) return { success: false, errorMsg: "WRITE_ERROR" };
        const e = entries[0];
        const items = [];
        const singleton = e.options.singleton;
        for (let i = 0; i < (singleton ? e.quantity : 1); i += 1) {
          items.push({ itemID: nextID++, typeID: e.itemType.typeID, categoryID: e.itemType.categoryID, singleton,
            quantity: singleton === 2 ? -2 : singleton ? -1 : e.quantity, customInfo: e.options.customInfo });
        }
        return { success: true, data: { items, changes: items.map((item) => ({ created: true, item })) } };
      },
    },
    resolveItemByTypeID: (typeID) => ({ typeID, name: `T${typeID}`, categoryID: typeID >= 1000 ? 9 : 7, groupID: typeID === 1890 ? 1890 : 100 }),
    blueprintRewardState: {
      buildBlueprintCopyState: bpReal.buildBlueprintCopyState,
      resolveBlueprintLootCopyState: bpReal.resolveBlueprintLootCopyState,
      ensureGrantedBlueprintCopyState(items, state) {
        if (over.failState) return { success: false, errorMsg: "BLUEPRINT_COPY_STATE_FLUSH_FAILED" };
        for (const item of items) log.states.push({ itemID: item.itemID, singleton: item.singleton, ...state });
        return { success: true };
      },
    },
    industry: { removeBlueprintState: (id) => { log.removedStates.push(id); return true; } },
    readMarker: (record) => { try { return JSON.parse(record.customInfo || "").evejsBlueprintDrop || null; } catch (_e) { return null; } },
  };
  return { deps, log };
}

test("T13 salvage wrapper keeps copies, passes other wrecks to the vendor", () => {
  const W = { wreckID: 77 };
  const contents = [
    { wreckItemID: 1, wreckID: 77, ownerID: 1000051, typeID: 1001, categoryID: 9, itemName: "BPC", quantity: 1, singleton: 2,
      blueprintState: { runsRemaining: 3, materialEfficiency: 4, timeEfficiency: 6 } },
    { wreckItemID: 2, wreckID: 77, ownerID: 1000051, typeID: 1001, categoryID: 9, itemName: "BPC", quantity: 1, singleton: 2 },
    { wreckItemID: 3, wreckID: 77, ownerID: 1000051, typeID: 1002, categoryID: 9, itemName: "Marked", quantity: 1, singleton: true,
      customInfo: JSON.stringify({ evejsBlueprintDrop: { runs: 5, me: 0, te: 20 } }) },
    { wreckItemID: 4, wreckID: 77, ownerID: 1000051, typeID: 1003, categoryID: 9, itemName: "BPO", quantity: 1, singleton: true },
    { wreckItemID: 5, wreckID: 77, ownerID: 0, typeID: 10, categoryID: 7, itemName: "Module", quantity: 3, singleton: false },
  ];
  const { deps, log } = salvageHarness(contents);
  const origCalls = [];
  const orig = function vendor() { origCalls.push({ self: this, args: [...arguments] }); return { success: true, changes: ["vendor"], removedSourceRecords: [] }; };
  const logged = [];
  const wrapped = SC.createSalvageCopiesWrapper(orig, () => deps, (n, id) => logged.push([n, id]));
  const out = wrapped(W, 900, 1000051);
  assert.strictEqual(out.success, true);
  assert.strictEqual(origCalls.length, 0, "a wreck with copies does not reach the vendor loop");
  assert.deepStrictEqual(log.grants.map((g) => [g.entries[0].itemType.typeID, g.entries[0].options.singleton, g.entries[0].quantity]),
    [[1001, 2, 1], [1001, 2, 1], [1002, 2, 1], [1003, 1, 1], [10, 0, 3]], "copies singleton 2, BPO 1, module stack");
  assert.ok(log.grants.every((g) => g.locationID === 900 && g.flagID === 4));
  assert.strictEqual(log.grants[4].ownerID, 1000051, "fallback owner as the vendor");
  assert.strictEqual(log.states.length, 3);
  assert.deepStrictEqual([log.states[0].runsRemaining, log.states[0].materialEfficiency, log.states[0].timeEfficiency, log.states[0].original], [3, 4, 6, false]);
  assert.ok(log.states[1].runsRemaining >= 1 && log.states[1].runsRemaining <= 5, "copy without stats: vendor roll 1-5 runs");
  assert.deepStrictEqual([log.states[2].runsRemaining, log.states[2].materialEfficiency, log.states[2].timeEfficiency], [5, 0, 20], "marker spec");
  assert.ok(log.states.every((s) => s.singleton === 2));
  assert.deepStrictEqual(log.removedItems, [1, 2, 3, 4, 5]);
  assert.strictEqual(out.removedSourceRecords.length, 5);
  assert.strictEqual(out.changes.length, 5, "every created item reported");
  assert.deepStrictEqual(logged, [[3, 77]]);
  assert.strictEqual(out.copies, undefined, "vendor result shape");
  const again = salvageHarness(contents);
  SC.createSalvageCopiesWrapper(orig, () => again.deps)(W, 900, 1000051);
  assert.deepStrictEqual(again.log.states[1].runsRemaining, log.states[1].runsRemaining);

  const plain = salvageHarness([contents[3], contents[4]]);
  const self = { tag: 1 };
  const r = SC.createSalvageCopiesWrapper(orig, () => plain.deps).call(self, W, 900, 5, "x");
  assert.deepStrictEqual(r, { success: true, changes: ["vendor"], removedSourceRecords: [] });
  assert.strictEqual(origCalls.length, 1);
  assert.strictEqual(origCalls[0].self, self);
  assert.deepStrictEqual(origCalls[0].args, [W, 900, 5, "x"]);
  assert.strictEqual(plain.log.grants.length, 0);
  SC.createSalvageCopiesWrapper(orig, () => { throw new Error("boom"); })(W, 900, 0);
  assert.strictEqual(origCalls.length, 2);

  const bad = salvageHarness(contents, { failGrantType: 10 });
  const f = SC.createSalvageCopiesWrapper(orig, () => bad.deps)(W, 900, 1000051);
  assert.deepStrictEqual([f.success, f.errorMsg, f.removedSourceRecords.length], [false, "WRITE_ERROR", 0]);
  assert.strictEqual(f.changes.length, 4);
  assert.deepStrictEqual(bad.log.removedItems, []);
  assert.deepStrictEqual(bad.log.removedStates, bad.log.states.map((s) => s.itemID));
  const bs = salvageHarness(contents, { failState: true });
  const g = SC.createSalvageCopiesWrapper(orig, () => bs.deps)(W, 900, 1000051);
  assert.deepStrictEqual([g.success, g.errorMsg, bs.log.removedStates.length, bs.log.removedItems.length], [false, "BLUEPRINT_COPY_STATE_FLUSH_FAILED", 1, 0]);
});

test("T14 loader hooks salvageItemCustody on first load", () => {
  const Module = require("node:module");
  const target = path.normalize(path.join(srcRoot, "services", "inventory", "salvageItemCustody.js"));
  const loaderPath = path.join(modDir, "loader.js");
  const vendorFn = function transferNativeWreckLootToContainer() { return { success: true }; };
  const fakeExp = { transferNativeWreckLootToContainer: vendorFn };
  const realLoad = Module._load;
  const realLog = console.log;
  try {
    Module._load = function stubLoad(request, parent, isMain) {
      let file = null;
      try { file = path.normalize(Module._resolveFilename(request, parent, isMain)); } catch (_e) {}
      return file === target ? fakeExp : realLoad.apply(this, arguments);
    };
    console.log = () => {};
    delete require.cache[require.resolve(loaderPath)];
    global.__blueprintDropsInstalled = false;
    require(loaderPath);
    const exp = Module._load(target, module, false);
    assert.strictEqual(exp, fakeExp);
    assert.strictEqual(exp.transferNativeWreckLootToContainer.name, "transferNativeWreckLootToContainerWithCopies");
    assert.deepStrictEqual(exp.transferNativeWreckLootToContainer({ wreckID: 1 }, 2, 3), { success: true });
  } finally {
    Module._load = realLoad;
    console.log = realLog;
  }
});

const FL = require(path.join(modDir, "lib", "factionLoot.js"));
const S = require(path.join(modDir, "lib", "settings.js"));
const flJson = JSON.parse(fs.readFileSync(path.join(modDir, "data", "factionLoot.json"), "utf8"));
const FLD = FL.loadData(flJson).data;
const MVP = [500010, 500011, 500012, 500019, 500020, 500025, 500001, 500002, 500003, 500004];
const PIRATES = [500010, 500011, 500012, 500019, 500020];
const SUB5 = [500007, 500008, 500015, 500016, 500018, 500024, 500026];
const flSettings = (over = {}) => S.mergeSettings({ factionLootEnabled: true, ...over });
const flItemType = (id) => ({ typeID: id, name: `t${id}` });
const flResolved = (factionID, band, tier) => ({ factionID, band, tier, size: FL.SIZE_OF_BAND[band], via: "group" });
function flRoll(resolved, rng, over = {}) {
  const { settings = flSettings(), options = { source: { npcTypeID: 9001 } }, vendorEntries = [], caps = FL.createRateCaps({ rare: 1000 }), nowMs = 0,
    lootTable = null, vendorEntryCount, buildCopyState } = over;
  return FL.rollFactionLoot({ lootTable, options, vendorEntries, vendorEntryCount },
    { settings, data: FLD, resolved, rng, nowMs, caps, getItemType: flItemType, buildCopyState });
}

test("T15 vendor facts (faction loot)", () => {
  const wreck = read("space/npc/nativeNpcWreckService.js");
  assert.match(wreck, /const \{\s*rollNpcLootEntries,\s*\} = require\(path\.join\(__dirname, "\.\/npcLoot"\)\)/);
  const call = wreck.slice(wreck.indexOf("rollNpcLootEntries(lootTable, {")).slice(0, 700);
  assert.match(call, /npcTypeID: wreckRecord\.sourceTypeID/);
  assert.match(call, /profileID: nativeEntityRecord && nativeEntityRecord\.profileID/);
  assert.match(call, /factionName: nativeEntityRecord && nativeEntityRecord\.factionName/);
  const loot = read("space/npc/npcLoot.js");
  const eligible = loot.slice(loot.indexOf("function isRuleEligibleBaseItem("), loot.indexOf("function hasAnyPattern("));
  assert.match(eligible, /!isBlueprintType\(itemType\)/, "vendor rule pools refuse blueprints (own pools)");
  assert.match(read("space/npc/npcData.js"), /module\.exports = \{[\s\S]*?\bgetNpcProfile,/);
});

test("T16 faction loot data", () => {
  assert.strictEqual(FL.loadData(flJson).ok, true);
  assert.strictEqual(flJson.chargeSizeAttributeID, 128, "builder checked chargeSize in dogmaAttributes");
  assert.deepStrictEqual([...FLD.factions.keys()].sort(), [...MVP, ...SUB5].sort());
  for (const id of [500021, 500027]) assert.ok(!FLD.factions.has(id), `${id} without pools`);
  const nonEmpty = (p) => !!p && (Array.isArray(p) ? p.length > 0 : Object.values(p).some((ids) => ids.length > 0));
  for (const id of MVP) {
    const pools = flJson.factions[id].pools;
    assert.ok(["tag", "ammo", "material"].some((c) => nonEmpty(pools[c])), `uncommon of ${id}`);
    if (PIRATES.includes(id)) assert.ok(nonEmpty(pools.module), `rare of ${id}`);
    for (const p of Object.values(pools)) {
      for (const ids of Array.isArray(p) ? [p] : Object.values(p)) assert.strictEqual(new Set(ids).size, ids.length, `duplicates in ${id}`);
    }
  }
  const g = (id) => FLD.npcGroups.get(id);
  assert.deepStrictEqual([g(550).factionID, g(550).band, g(550).tier], [500011, "frigate", "normal"]);
  const byName = (n) => flJson.npcGroups.find((r) => r.name === n);
  assert.strictEqual(byName("Asteroid Guristas Commander Frigate").tier, "commander");
  assert.deepStrictEqual([byName("Deadspace Overseer Battleship").tier, byName("Deadspace Overseer Battleship").band], ["overseer", "battleship"]);
  assert.strictEqual(byName("Sentry Gun").band, null);
  assert.strictEqual(FL.loadData({ ...flJson, npcGroups: [...flJson.npcGroups, flJson.npcGroups[0]] }).reason, "BAD_DATA");
  for (const id of PIRATES) assert.ok(nonEmpty(flJson.factions[id].pools.ammo), `ammo of ${id}`);
  const serp = flJson.factions[500020].pools;
  assert.ok(serp.ammo.small.includes(20040) && flJson.factions[500019].pools.ammo.small.includes(20821)
    && flJson.factions[500011].pools.ammo.small.includes(19992), "Shadow / Sanshas / Arch Angel ammo");
  for (const id of [14236, 14238, 14240, 41199]) assert.ok(serp.module.any.includes(id), `script module ${id} in any`);
  const allIDs = new Set();
  for (const f of Object.values(flJson.factions)) for (const p of Object.values(f.pools)) for (const ids of Array.isArray(p) ? [p] : Object.values(p)) ids.forEach((x) => allIDs.add(x));
  for (const id of [37293, 40736, 40762, 40737, 40764, 37612]) assert.ok(!allIDs.has(id), `${id} excluded`);
  const trig = flJson.factions[500026].pools;
  assert.ok(nonEmpty(trig.material) && trig.material.includes(48121), "triglavian material");
  assert.ok(!trig.material.some((id) => id >= 85390 && id <= 85402), "no mutaplasmid residue");
  assert.ok(nonEmpty(flJson.factions[500008].pools.module), "khanid rare");
  assert.ok(nonEmpty(flJson.factions[500018].pools.bpcHull), "mordu hull BPCs");
  assert.deepStrictEqual([g(4028).band, FLD.npcTypeBands.get(52182), FLD.npcTypeBands.get(52184)], [null, "frigate", "battleship"]);
  assert.deepStrictEqual([g(1307).factionID, g(4034).factionID, g(4035).factionID, g(1768).factionID], [500021, 500027, 500024, 500024]);
  assert.strictEqual(FL.loadData({ ...flJson, npcTypeBands: { 52182: "huge" } }).reason, "BAD_DATA");
  assert.deepStrictEqual([47489, 48570, 50090, 48575].map((id) => FLD.npcTypeBands.get(id)), ["frigate", "frigate", "frigate", "frigate"]);
  assert.strictEqual(FLD.npcTypeBands.get(54008), "battleship", "Scout Imperial Navy Apocalypse");
  assert.deepStrictEqual(flJson.factions[500024].pools.material, [34556, 34557, 34558, 34559, 34560, 34575, 36902]);
});

test("T17 rollFactionLoot (pure, injected rng)", () => {
  const officer = flResolved(500010, "frigate", "officer");
  let dropped = 0;
  for (let i = 0; i < 200; i += 1) {
    const a = flRoll(flResolved(500010, "battleship", "commander"), FL.createSeededRng(`s${i}`));
    assert.deepStrictEqual(flRoll(flResolved(500010, "battleship", "commander"), FL.createSeededRng(`s${i}`)), a);
    dropped += a.entries.length;
  }
  assert.ok(dropped > 0, "seeded rolls drop something");
  const never = () => assert.fail("rng called");
  assert.strictEqual(flRoll(officer, never, { options: { extraRoll: true, source: { npcTypeID: 9001 } } }).reason, "EXTRA_ROLL");
  assert.strictEqual(flRoll(officer, never, { options: { source: {} } }).reason, "NO_SOURCE");
  assert.strictEqual(flRoll(officer, never, { settings: flSettings({ factionLootEnabled: false }) }).reason, "OFF");
  assert.strictEqual(flRoll(flResolved(500010, null, "normal"), never).reason, "UNRESOLVED");
  const types = new Map([[9100, { groupID: 693 }], [9101, { groupID: 27 }]]);
  const concord = FL.resolveSource({ npcTypeID: 9100 }, { data: FLD, getProfile: () => null, getType: (id) => types.get(id) || null });
  assert.deepStrictEqual([concord.factionID, concord.band, concord.tier, concord.via], [500006, "frigate", "mission", "group"]);
  assert.strictEqual(flRoll(concord, never).reason, "SKIPPED_FACTION");
  const lne = FL.resolveSource({ npcTypeID: 9101, factionName: "Serpentis" }, { data: FLD, getProfile: () => null, getType: (id) => types.get(id) || null });
  assert.deepStrictEqual([lne.factionID, lne.band, lne.tier, lne.via], [500020, "battleship", "normal", "alias"]);
  const subTypes = new Map([[52184, { groupID: 4028 }], [34337, { groupID: 1307 }]]);
  const sub = (npcTypeID) => FL.resolveSource({ npcTypeID }, { data: FLD, getProfile: () => null, getType: (id) => subTypes.get(id) || null });
  const trig = sub(52184);
  assert.deepStrictEqual([trig.factionID, trig.band, trig.tier], [500026, "battleship", "normal"]);
  const trigRoll = flRoll(trig, () => 0, { options: { source: { npcTypeID: 52184 } } });
  assert.deepStrictEqual([trigRoll.reason, trigRoll.drops.map((d) => d.category)], ["ROLLED", ["material"]]);
  assert.strictEqual(flRoll(trig, never, { options: { source: { npcTypeID: 52184 } },
    lootTable: { lootTableID: "parity_abyssal_entities_pending_loot", emptyRule: true }, vendorEntryCount: 0 }).reason, "SKIPPED_TABLE");
  assert.deepStrictEqual(S.DEFAULTS.factionLootSkipTables, ["parity_abyssal_entities_pending_loot"]);
  assert.strictEqual(FL.validateSettings(flSettings({ factionLootSkipTables: [1] })).detail, "factionLootSkipTables");
  const sleeper = sub(34337);
  assert.deepStrictEqual([sleeper.factionID, flRoll(sleeper, () => 0, { options: { source: { npcTypeID: 34337 } } }).reason], [500021, "NO_POOLS"]);
  const all = flRoll(officer, () => 0);
  assert.strictEqual(all.entries.length, Math.min(S.DEFAULTS.factionLootMaxEntriesPerWreck, FL.RARITIES.length - 1));
  assert.deepStrictEqual(all.drops.map((d) => d.rarity), ["rare", "uncommon"]);
  assert.strictEqual(flRoll(officer, () => 0, { settings: flSettings({ factionLootMaxEntriesPerWreck: 1 }) }).entries.length, 1);
  assert.strictEqual(flRoll(officer, () => 0.999).entries.length, 0);
  const pool = FLD.factions.get(500010).pools.module.small;
  const vendorEntries = pool.slice(0, -1).map((typeID) => ({ typeID }));
  const r = flRoll(officer, () => 0, { vendorEntries });
  assert.strictEqual(r.drops[0].category, "module");
  assert.strictEqual(r.entries[0].typeID, pool[pool.length - 1]);
  for (const e of all.entries) {
    assert.deepStrictEqual(Object.keys(e), ["itemType", "typeID", "name", "quantity", "singleton"]);
    assert.strictEqual(e.singleton, false);
    assert.strictEqual(e.itemType.typeID, e.typeID);
  }
  assert.deepStrictEqual([all.drops[1].category, all.entries[1].quantity], ["tag", 1 * 3], "uncommon stack: min x officer multiplier");
});

test("T18 rare cap per hour", () => {
  const officer = flResolved(500010, "frigate", "officer");
  const caps = FL.createRateCaps({ rare: 2 });
  const at = (nowMs) => flRoll(officer, () => 0, { caps, nowMs });
  assert.deepStrictEqual(at(1000).capped, []);
  assert.deepStrictEqual(at(2000).capped, []);
  const third = at(3000);
  assert.deepStrictEqual([third.capped, third.drops.map((d) => d.rarity)], [["rare"], ["uncommon"]]);
  assert.deepStrictEqual(at(3000 + 3600000).capped, [], "refilled after an hour");
  const zero = flRoll(officer, () => 0, { caps: FL.createRateCaps({ rare: 0 }) });
  assert.deepStrictEqual([zero.capped, zero.drops.map((d) => d.rarity)], [["rare"], ["uncommon"]]);
  const one = FL.createRateCaps({ rare: 1 });
  const drone = flRoll(flResolved(500025, "battleship", "officer"), () => 0, { caps: one });
  assert.deepStrictEqual([drone.capped, drone.drops.map((d) => d.rarity)], [[], ["uncommon"]]);
  const after = flRoll(officer, () => 0, { caps: one });
  assert.deepStrictEqual([after.capped, after.drops.map((d) => d.rarity)], [[], ["rare", "uncommon"]], "token still there");
});

function bootFactionLoader(overrideValues, fn) {
  const Module = require("node:module");
  const os = require("node:os");
  const norm = (rel) => path.normalize(path.join(srcRoot, ...rel.split("/")));
  const targets = { npcLoot: norm("space/npc/npcLoot.js"), ref: norm("services/_shared/referenceData.js"), npcData: norm("space/npc/npcData.js"),
    store: norm("space/npc/nativeNpcStore.js") };
  const rows = [{ typeID: 9001, name: "npc", groupID: 800 }];
  for (const f of Object.values(flJson.factions)) {
    for (const p of Object.values(f.pools)) for (const ids of Array.isArray(p) ? [p] : Object.values(p)) for (const id of ids) rows.push(flItemType(id));
  }
  for (const p of Object.values(flJson.common)) for (const ids of Array.isArray(p) ? [p] : Object.values(p)) for (const id of ids) rows.push(flItemType(id));
  const fakes = {
    [targets.npcLoot]: { rollNpcLootEntries: (table) => (table && table.emptyRule ? [] : [{ typeID: 34, quantity: 5 }]) },
    [targets.ref]: { TABLE: { ITEM_TYPES: "itemTypes" }, readStaticRows: () => rows },
    [targets.npcData]: { getNpcProfile: () => null },
    [targets.store]: { upsertNativeWreckItem: (record) => record, getNativeWreckItem: () => null },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bpdrops-fl-"));
  const realLoad = Module._load;
  const realRandom = Math.random;
  const realLog = console.log;
  const realRoot = process.env.EVEJS_DATA_ROOT;
  const logs = [];
  try {
    if (overrideValues) {
      fs.mkdirSync(path.join(dir, "mods", "blueprintDrops"), { recursive: true });
      fs.writeFileSync(path.join(dir, "mods", "blueprintDrops", "settings.override.json"), JSON.stringify({ schemaVersion: 1, values: overrideValues }));
    }
    process.env.EVEJS_DATA_ROOT = dir;
    Module._load = function stubLoad(request, parent, isMain) {
      let file = null;
      try { file = path.normalize(Module._resolveFilename(request, parent, isMain)); } catch (_e) {}
      return file && fakes[file] ? fakes[file] : realLoad.apply(this, arguments);
    };
    console.log = (line) => logs.push(String(line));
    const loaderPath = path.join(modDir, "loader.js");
    delete require.cache[require.resolve(loaderPath)];
    global.__blueprintDropsInstalled = false;
    require(loaderPath);
    const exp = Module._load(targets.npcLoot, module, false);
    const store = Module._load(targets.store, module, false);
    let draws = 0;
    Math.random = () => { draws += 1; return 0.999; };
    fn({ exp, store, logs, draws: () => draws, resetDraws: () => { draws = 0; } });
  } finally {
    Module._load = realLoad;
    Math.random = realRandom;
    console.log = realLog;
    if (realRoot === undefined) delete process.env.EVEJS_DATA_ROOT; else process.env.EVEJS_DATA_ROOT = realRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("T19 faction loot config and wrapper", () => {
  assert.strictEqual(S.DEFAULTS.factionLootEnabled, false);
  assert.ok(!("factionLootEnabled" in JSON.parse(fs.readFileSync(path.join(modDir, "settings.json"), "utf8"))));
  const C = require(path.join(modDir, "config.js"));
  const noFile = path.join(modDir, "no-such-override.json");
  const flag = (value, over) => C.loadConfig({ env: value === undefined ? {} : { EVEJS_BPDROPS_FACTION_LOOT_ENABLED: value },
    overrideFilePath: noFile, ...(over ? { overrideValues: over } : {}) }).settings.factionLootEnabled;
  assert.deepStrictEqual([flag(undefined), flag("1"), flag("true"), flag("yes"), flag("1", { factionLootEnabled: false })],
    [false, true, true, false, false]);
  assert.deepStrictEqual([FL.resolveFactionLootFlag({ factionLootEnabled: true }, { EVEJS_BPDROPS_FACTION_LOOT_ENABLED: "0" }),
    FL.resolveFactionLootFlag({ factionLootEnabled: true }, { EVEJS_BPDROPS_FACTION_LOOT_ENABLED: "yes" })], [false, true]);
  const bad = flSettings({ factionLootTierChance: { officer: { uncommon: 2, rare: 0 } } });
  assert.deepStrictEqual(FL.validateSettings(bad), { ok: false, reason: "BAD_CONFIG", detail: "factionLootTierChance.officer.uncommon" });
  assert.deepStrictEqual(FL.startupReport(bad, FL.loadData(flJson)).forceOff, true);
  assert.strictEqual(FL.validateSettings(flSettings()).ok, true);
  const table = { lootTableID: "loot_belt_normal_small" };
  const source = { npcTypeID: 9001, profileID: "p" };
  let rngCalls = 0;
  const counting = () => { rngCalls += 1; return 0; };
  bootFactionLoader(null, ({ exp, logs, draws }) => {
    assert.ok(logs.some((l) => l.endsWith("faction loot: off (factionLootEnabled: false)")), logs.join("\n"));
    assert.deepStrictEqual(exp.rollNpcLootEntries(table, { random: counting, source }), [{ typeID: 34, quantity: 5 }]);
    assert.strictEqual(rngCalls, 0, "OFF: the wrapper never calls rng");
    assert.strictEqual(draws(), 1, "blueprint draw");
  });
  bootFactionLoader({ factionLootEnabled: true }, ({ exp, logs, draws, resetDraws }) => {
    assert.ok(logs.some((l) => l.includes(`faction loot: on (${FLD.factions.size} factions, `)), logs.join("\n"));
    const out = exp.rollNpcLootEntries(table, { random: () => 0, source });
    assert.deepStrictEqual(out[0], { typeID: 34, quantity: 5 });
    assert.deepStrictEqual(out.map((e) => e.singleton), [undefined, 2, false, false]);
    assert.ok(logs.some((l) => /faction loot: on \(\d+ factions, types=\d+, missing=0\)/.test(l)), "first wreck line");
    assert.strictEqual(draws(), 1);
    resetDraws();
    assert.deepStrictEqual(exp.rollNpcLootEntries(table, { extraRoll: true, random: () => 0, source }), [{ typeID: 34, quantity: 5 }]);
    assert.strictEqual(draws(), 0);
    const realRoll = FL.rollFactionLoot;
    FL.rollFactionLoot = () => { throw new Error("boom"); };
    try {
      resetDraws();
      assert.deepStrictEqual(exp.rollNpcLootEntries(table, { random: () => 0, source }), [{ typeID: 34, quantity: 5 }]);
      assert.strictEqual(draws(), 1);
      assert.ok(logs.some((l) => l.endsWith("faction loot roll failed: boom")));
    } finally {
      FL.rollFactionLoot = realRoll;
    }
  });
  bootFactionLoader({ factionLootEnabled: true, factionLootMaxEntriesPerWreck: 99 }, ({ exp, logs, draws }) => {
    assert.ok(logs.some((l) => l.endsWith("faction loot: off (BAD_CONFIG: factionLootMaxEntriesPerWreck)")), logs.join("\n"));
    assert.deepStrictEqual(exp.rollNpcLootEntries(table, { random: () => 0, source }), [{ typeID: 34, quantity: 5 }]);
    assert.strictEqual(draws(), 1);
  });
  const loaderSrc = fs.readFileSync(path.join(modDir, "loader.js"), "utf8");
  assert.match(loaderSrc, /appendResonators\(entries, rest\[0\]\);[\s\S]{0,200}try \{\s*appendFactionLoot\(entries, lootTable, rest\[0\], vendorCount\);/);
  assert.ok(!/Math\.random/.test(fs.readFileSync(path.join(modDir, "lib", "factionLoot.js"), "utf8")), "no Math.random in lib/factionLoot.js");
});

const PLACEHOLDER = { lootTableID: "parity_irregular_entities_pending_loot", minEntries: 0, maxEntries: 0, disableRandomLoot: true, emptyRule: true };
const fillerOnly = (over = {}) => flSettings({ factionLootUncommonScale: 0, factionLootRareScale: 0, ...over });

test("T20 filler: a placeholder with 0 vendor entries gets 1-3 common entries of the hull size", () => {
  assert.strictEqual(S.DEFAULTS.factionLootFillerEnabled, true);
  assert.ok(flJson.common.ammo.medium.length && flJson.common.module.medium.length && flJson.common.salvage.length, "builder wrote common");
  const medium = new Set([...FLD.common.ammo.medium, ...FLD.common.module.medium, ...FLD.common.salvage]);
  const cruiser = flResolved(500010, "cruiser", "normal");
  const counts = new Set();
  for (let i = 0; i < 60; i += 1) {
    const r = flRoll(cruiser, FL.createSeededRng(`f${i}`), { settings: fillerOnly(), lootTable: PLACEHOLDER, vendorEntryCount: 0 });
    counts.add(r.entries.length);
    assert.ok(r.drops.every((d) => d.rarity === "common" && medium.has(d.typeID)), JSON.stringify(r.drops));
    assert.strictEqual(new Set(r.entries.map((e) => e.typeID)).size, r.entries.length, "no duplicate");
  }
  assert.deepStrictEqual([...counts].sort(), [1, 2, 3]);
  assert.strictEqual(flRoll(cruiser, () => 0, { settings: fillerOnly(), lootTable: PLACEHOLDER, vendorEntryCount: 1 }).entries.length, 0);
  const belt = { lootTableID: "loot_belt_normal_small", mode: "rule", minEntries: 1, maxEntries: 4, emptyChance: 0.11 };
  assert.strictEqual(flRoll(cruiser, () => 0, { settings: fillerOnly(), lootTable: belt, vendorEntryCount: 0 }).entries.length, 0);
  const both = flRoll(flResolved(500010, "frigate", "officer"), () => 0, { lootTable: PLACEHOLDER, vendorEntryCount: 0,
    settings: flSettings({ factionLootFillerEntries: [3, 3] }) });
  assert.deepStrictEqual(both.drops.map((d) => d.rarity), ["common", "common", "common", "rare", "uncommon"]);
  assert.strictEqual(S.DEFAULTS.factionLootFillerTierQuantity, false);
  const fillerQty = (tierQuantity) => flRoll(flResolved(500010, "frigate", "officer"), () => 0, { lootTable: PLACEHOLDER, vendorEntryCount: 0,
    settings: fillerOnly({ factionLootFillerEntries: [3, 3], factionLootFillerTierQuantity: tierQuantity }) }).drops;
  const plain = fillerQty(false);
  const tripled = fillerQty(true);
  assert.ok(plain.some((d) => d.category !== "module"), JSON.stringify(plain));
  for (const [i, d] of plain.entries()) {
    if (d.category === "module") continue;
    const [lo, hi] = S.DEFAULTS.factionLootQuantity[d.category];
    assert.ok(d.quantity >= lo && d.quantity <= hi, JSON.stringify(d));
    assert.strictEqual(tripled[i].quantity, d.quantity * 3);
  }
  assert.strictEqual(FL.validateSettings(flSettings({ factionLootFillerTierQuantity: 1 })).detail, "factionLootFillerTierQuantity");
  bootFactionLoader({ factionLootEnabled: true }, ({ exp }) => {
    const out = exp.rollNpcLootEntries(PLACEHOLDER, { random: () => 0, source: { npcTypeID: 9001 } });
    const common = new Set([...FLD.common.ammo.small, ...FLD.common.module.small, ...FLD.common.salvage]);
    assert.ok(out.length >= 1 && common.has(out[0].typeID), JSON.stringify(out));
  });
  assert.match(fs.readFileSync(path.join(modDir, "loader.js"), "utf8"),
    /const entries = orig\.call\(this, lootTable, \.\.\.rest\);\s*const vendorCount = Array\.isArray\(entries\) \? entries\.length : null;/);
});

test("T21 filler gates: excluded table, no band, filler off", () => {
  const cruiser = flResolved(500010, "cruiser", "normal");
  for (const id of S.DEFAULTS.factionLootFillerExcludeTables) {
    assert.strictEqual(flRoll(cruiser, () => 0, { settings: fillerOnly(), lootTable: { ...PLACEHOLDER, lootTableID: id }, vendorEntryCount: 0 }).entries.length, 0, id);
  }
  assert.strictEqual(S.DEFAULTS.factionLootFillerExcludeTables.length, 4);
  assert.strictEqual(flRoll(flResolved(500010, null, "normal"), () => 0, { lootTable: PLACEHOLDER, vendorEntryCount: 0 }).reason, "UNRESOLVED");
  assert.strictEqual(flRoll(cruiser, () => 0, { settings: fillerOnly({ factionLootFillerEnabled: false }), lootTable: PLACEHOLDER, vendorEntryCount: 0 }).entries.length, 0);
  const noFaction = flRoll(flResolved(null, "frigate", "normal"), () => 0, { lootTable: PLACEHOLDER, vendorEntryCount: 0 });
  assert.deepStrictEqual([noFaction.reason, noFaction.drops.length > 0], ["ROLLED", true]);
  assert.deepStrictEqual(FL.validateSettings(flSettings({ factionLootFillerEntries: [3, 1] })), { ok: false, reason: "BAD_CONFIG", detail: "factionLootFillerEntries" });
});

const vendorCopyState = require(path.join(srcRoot, "services", "inventory", "blueprintRewardState.js")).buildBlueprintCopyState;
const epicCaps = () => FL.createRateCaps({ rare: 1000, epic: 1000 });
const epicOnly = (over = {}) => flSettings({ factionLootUncommonScale: 0, factionLootRareScale: 0, factionLootEpicScale: 1000, ...over });

test("T22 vendor facts (native blueprint copies)", () => {
  const state = read("services/inventory/blueprintRewardState.js");
  assert.match(state, /function buildBlueprintCopyState\(spec = \{\}\) \{/);
  assert.match(state, /module\.exports = \{[\s\S]*?\bbuildBlueprintCopyState,/);
  assert.deepStrictEqual(vendorCopyState({ runsRemaining: 2, materialEfficiency: 0, timeEfficiency: 0 }),
    { original: false, runsRemaining: 2, materialEfficiency: 0, timeEfficiency: 0, jobID: null });
  const wreck = read("space/npc/nativeNpcWreckService.js");
  const items = wreck.slice(wreck.indexOf("function buildNativeLootWreckItems("), wreck.indexOf("function refreshNativeWreckRuntimeEntity("));
  assert.match(items, /const copyCount = lootEntry\.singleton === 2 \? lootEntry\.quantity : 1;/);
  assert.match(items, /blueprintState: lootEntry\.blueprintStates && lootEntry\.blueprintStates\[index\] \|\| lootEntry\.blueprintState,/);
  for (const id of MVP) {
    const pools = flJson.factions[id].pools;
    for (const cat of ["bpcModule", "bpcHull"]) {
      for (const ids of Object.values(pools[cat] || {})) for (const bp of ids) assert.ok(flJson.bpcMaxRuns[bp] >= 1, `maxRuns of ${bp}`);
    }
  }
  assert.ok(Object.values(flJson.factions[500001].pools.bpcModule).flat().length > 0, "caldari navy module BPCs");
  assert.ok(Object.values(flJson.factions[500010].pools.bpcHull).flat().length > 0, "guristas hull BPCs");
  assert.strictEqual(flJson.factions[500025].pools.bpcHull, undefined, "rogue drones: no hulls");
});

test("T23 epic: native copy, runs, no copySpec, bpcHull gate", () => {
  const officerBs = flResolved(500001, "battleship", "officer");
  const r = flRoll(officerBs, () => 0, { caps: epicCaps(), buildCopyState: vendorCopyState });
  assert.strictEqual(r.drops[0].rarity, "epic", JSON.stringify(r.drops));
  const e = r.entries[0];
  assert.deepStrictEqual(Object.keys(e), ["itemType", "typeID", "name", "quantity", "singleton", "blueprintState"]);
  assert.deepStrictEqual([e.quantity, e.singleton, e.blueprintState.original, e.blueprintState.materialEfficiency, e.blueprintState.timeEfficiency],
    [1, 2, false, 0, 0]);
  assert.ok(!("copySpec" in e));
  const runs = new Set();
  const cats = new Set();
  for (let i = 0; i < 200; i += 1) {
    const x = flRoll(officerBs, FL.createSeededRng(`e${i}`), { settings: epicOnly(), caps: epicCaps(), buildCopyState: vendorCopyState });
    for (const d of x.drops) {
      cats.add(d.category);
      const limit = Math.min(S.DEFAULTS.factionLootBpcRuns[d.category][1], flJson.bpcMaxRuns[d.typeID]);
      assert.ok(d.runs >= 1 && d.runs <= limit, `runs ${d.runs} of ${d.typeID}`);
      runs.add(d.runs);
    }
  }
  assert.deepStrictEqual([...cats].sort(), ["bpcHull", "bpcModule"]);
  assert.ok(runs.has(1) && runs.has(3), [...runs].join(","));
  let modules = 0;
  for (let i = 0; i < 200; i += 1) {
    const x = flRoll(flResolved(500001, "frigate", "normal"), FL.createSeededRng(`n${i}`), { settings: epicOnly(), caps: epicCaps(), buildCopyState: vendorCopyState });
    assert.ok(x.drops.every((d) => d.category !== "bpcHull"), JSON.stringify(x.drops));
    modules += x.drops.length;
  }
  assert.ok(modules > 0);
  const one = FL.createRateCaps({ rare: 1000, epic: 1 });
  const bad = flRoll(officerBs, () => 0, { caps: one, buildCopyState: () => { throw new Error("x"); } });
  assert.deepStrictEqual([bad.skipped, bad.drops.map((d) => d.rarity)], [["BPC_STATE"], ["rare", "uncommon"]]);
  assert.strictEqual(flRoll(officerBs, () => 0, { caps: one, buildCopyState: vendorCopyState }).drops[0].rarity, "epic", "token kept");
  bootFactionLoader({ factionLootEnabled: true, factionLootLog: true }, ({ exp, store, logs }) => {
    const out = exp.rollNpcLootEntries({ lootTableID: "loot_belt_normal_small" }, { random: () => 0, source: { npcTypeID: 9001 } });
    const epic = out.find((x) => x.singleton === 2);
    assert.ok(epic && epic.blueprintState.runsRemaining >= 1, JSON.stringify(out));
    assert.strictEqual(store.upsertNativeWreckItem({ sourceKind: "loot", typeID: epic.typeID, customInfo: "" }).customInfo, "");
    assert.ok(logs.some((l) => / epic=t\d+ runs=\d+ \[/.test(l)), logs.join("\n"));
  });
});

test("T24 epic cap per hour, dropRates --faction", () => {
  const caps = FL.createRateCaps({ rare: 1000, epic: 1 });
  const officerBs = flResolved(500001, "battleship", "officer");
  const first = flRoll(officerBs, () => 0, { caps, nowMs: 1000, buildCopyState: vendorCopyState });
  const second = flRoll(officerBs, () => 0, { caps, nowMs: 2000, buildCopyState: vendorCopyState });
  assert.deepStrictEqual([first.capped, first.drops[0].rarity], [[], "epic"]);
  assert.deepStrictEqual([second.capped, second.drops.map((d) => d.rarity)], [["epic"], ["rare", "uncommon"]]);
  assert.strictEqual(S.DEFAULTS.factionLootEpicCapPerHour, 12);
  const DR = require(path.join(modDir, "tools", "dropRates.js"));
  const rows = DR.simulateFaction(S.mergeSettings({}), FLD, { wrecks: 10000, seed: 99 });
  assert.strictEqual(rows.length, FLD.factions.size * DR.FACTION_TIERS.length * DR.FACTION_BANDS.length);
  const officer = rows.find((x) => x.faction === "caldari" && x.tier === "officer" && x.band === "battleship");
  assert.ok(officer.epic > 0.02 && officer.epic < 0.07, String(officer.epic));
  assert.ok(rows.filter((x) => x.faction === "rogue_drones").every((x) => x.epic === 0 && x.rare === 0));
  assert.match(DR.formatFactionTable(rows), /^\| faction \| tier \| hull \|/);
});

let passed = 0;
let failed = 0;
const selected = tests.filter((t) => !only.length || only.some((o) => t.name.includes(o)));
for (const t of selected) {
  try {
    t.fn();
    passed += 1;
    console.log(`PASS ${t.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${t.name}\n  ${error && error.stack || error}`);
  }
}
console.log(`${passed}/${selected.length} PASS`);
process.exitCode = failed ? 1 : 0;
