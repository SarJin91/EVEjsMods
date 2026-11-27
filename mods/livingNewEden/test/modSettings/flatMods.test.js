"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { OVERRIDE_FILE_NAME, IGNORE_ENV } = require("../../lib/modSettings/overrideFile");
const { PROVIDER_MODS, createProvider } = require("../../lib/modSettings/providers");
const { ROW_TYPES } = require("../../lib/modSettings/providers/flatKit");
const hotPathPerf = require("../../lib/modSettings/providers/hotPathPerf");
const { startModSettings } = require("../../lib/modSettings");
const { createAdapter } = require("../../lib/adapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const MODS_ROOT = path.resolve(MOD_DIR, "..");
const AUD_DIR_NAME = "EveJS-AdvancedUtilityDrones-1.0.3";
const SUB6B_OVERRIDE_MODS = Object.freeze(["autopilotJumpZero", "dailyGoalsPersist", "industryOrphanCleanup",
  "marketAllRegions", "missionStructureRestore", "skyhookOrphanFix", "planetaryDrill", "customTypes",
  "soloProgressionBalance", "moonOreAnomalies", "blueprintDrops"]);
const READER_COPIES = Object.freeze(["shipWing", AUD_DIR_NAME, "hotPathPerf", "scenePerfFix", "npcKillsGiveSp",
  ...SUB6B_OVERRIDE_MODS].map((dir) => path.join(MODS_ROOT, dir, "lib", "settingsOverride.js")));
const LNE_READER = path.join(MOD_DIR, "lib", "modSettings", "overrideFile.js");
const ENTRYPOINT_MODS = Object.freeze(["scenePerfFix", "hotPathPerf", "shipWing", "moonOreAnomalies",
  "soloProgressionBalance", "autopilotJumpZero", "droneClassBalance", AUD_DIR_NAME, "npcKillsGiveSp", "blueprintDrops",
  "marketAllRegions", "dailyGoalsPersist", "industryOrphanCleanup", "skyhookOrphanFix", "customTypes", "planetaryDrill",
  "missionStructureRestore", "livingNewEden"]);

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-flatmods-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeOverride(dataRoot, dataId, values) {
  const file = path.join(dataRoot, "mods", dataId, OVERRIDE_FILE_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 1, values }));
  return file;
}

function readerText(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("function readOverrideFile(");
  const end = text.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `no readOverrideFile in ${file}`);
  return text.slice(start, end + 2).split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
}

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
const realAdapter = () => createAdapter({ moduleApi: { _cache: {} }, modsRoot: MODS_ROOT });
const modConfig = (dir) => require(path.join(MODS_ROOT, dir, "config.js"));

module.exports = ({ test }) => {
  test("A1 adapter loadModConfig(dir, {need, manifest}): manifest labels, missing export -> CONFIG_SHAPE, no opts = "
    + "the SCHEMA check, a broken manifest -> fields {}", () => withDir((dir) => {
    const adapter = realAdapter();
    const got = adapter.loadModConfig("hotPathPerf", { need: hotPathPerf.NEED, manifest: true });
    assert.strictEqual(got.ok, true, JSON.stringify(got));
    assert.strictEqual(got.manifest.displayName, "Hot Path Performance");
    assert.ok(typeof got.manifest.fields.slowCallMs.label === "string" && got.manifest.fields.slowCallMs.label !== "");
    assert.deepStrictEqual(adapter.loadModConfig("hotPathPerf", { need: { nope: "function" } }),
      { ok: false, reason: "CONFIG_SHAPE" });
    assert.deepStrictEqual(adapter.loadModConfig("hotPathPerf"), { ok: false, reason: "CONFIG_SHAPE" });
    assert.strictEqual(adapter.loadModConfig("shipWing").manifest, undefined, "no opts = the result");

    const fake = path.join(dir, "fakeMod");
    fs.mkdirSync(fake);
    const fakeAdapter = createAdapter({ moduleApi: { _cache: {} }, modsRoot: dir, existsSync: () => true,
      requireFn: () => ({ DEFAULTS: {} }) });
    const opts = { need: { DEFAULTS: "object" }, manifest: true };
    for (const text of [null, "{broken", "[1]", JSON.stringify({ displayName: "Fake", settings: { fields: "x" } })]) {
      if (text !== null) fs.writeFileSync(path.join(fake, "evejs-launcher.mod.json"), text);
      const r = fakeAdapter.loadModConfig("fakeMod", opts);
      assert.strictEqual(r.ok, true, String(text));
      assert.deepStrictEqual(r.manifest.fields, {}, String(text));
    }
  }));

  test("A2 reader copies: shipWing + 4 flat mods + 11 mods have the readOverrideFile text (SHA-1, LF) and "
    + "constants of LNE",
    () => {
      const want = sha1(readerText(LNE_READER));
      const lne = require(LNE_READER);
      for (const file of READER_COPIES) {
        assert.strictEqual(sha1(readerText(file)), want, file);
        const copy = require(file);
        for (const k of ["OVERRIDE_FILE_NAME", "IGNORE_ENV", "OVERRIDE_SCHEMA_VERSION"]) {
          assert.strictEqual(copy[k], lne[k], `${file} ${k}`);
        }
      }
    });

  test("A3 override layer in hotPathPerf, scenePerfFix, npcKillsGiveSp: override > env, bad type -> env, no file = "
    + "kill switch", () => withDir((dir) => {
    const quiet = () => {};
    const cases = [
      { mod: "hotPathPerf", key: "slowCallMs", env: { HOTPATH_SLOW_CALL_MS: "300" }, envValue: 300, over: 400,
        load: (cfg, env) => cfg.loadConfig({ env, warn: quiet }) },
      { mod: "scenePerfFix", key: "itemNameCacheMax", env: { EVEJS_SCENEPERF_NAME_CACHE_MAX: "6000" }, envValue: 6000,
        over: 7000, load: (cfg, env) => cfg.loadConfig({ env }) },
      { mod: "npcKillsGiveSp", key: "flushSeconds", env: { EVEJS_NPCKILLS_SP_FLUSH_SECONDS: "120" }, envValue: 120,
        over: 300, load: (cfg, env) => cfg.loadConfig({ env, envFilePath: path.join(dir, "none.env"),
          settingsFilePath: path.join(dir, "none.json") }).config },
    ];
    for (const c of cases) {
      const cfg = modConfig(c.mod);
      const env = { ...c.env, EVEJS_DATA_ROOT: dir };
      assert.strictEqual(cfg.resolveDataDir(env, path.join(MODS_ROOT, c.mod)), path.join(dir, "mods", c.mod));
      const none = c.load(cfg, env);
      assert.strictEqual(none[c.key], c.envValue, c.mod);
      assert.deepStrictEqual(none, c.load(cfg, { ...env, [IGNORE_ENV]: "1" }), `${c.mod}: no file = kill switch`);
      const file = writeOverride(dir, c.mod, { [c.key]: c.over, noSuchKey: 1 });
      assert.strictEqual(c.load(cfg, env)[c.key], c.over, `${c.mod}: override > env`);
      assert.strictEqual(c.load(cfg, { ...env, [IGNORE_ENV]: "1" })[c.key], c.envValue, `${c.mod}: kill switch`);
      assert.deepStrictEqual(Object.keys(c.load(cfg, env)), Object.keys(none), `${c.mod}: same shape`);
      writeOverride(dir, c.mod, { [c.key]: String(c.over) });
      assert.strictEqual(c.load(cfg, env)[c.key], c.envValue, `${c.mod}: a bad JSON type keeps env`);
      fs.rmSync(file);
    }
    const npc = modConfig("npcKillsGiveSp");
    const env = { EVEJS_NPCKILLS_SP_FLUSH_SECONDS: "120", EVEJS_DATA_ROOT: dir };
    const opts = { env, envFilePath: path.join(dir, "none.env"), settingsFilePath: path.join(dir, "none.json") };
    writeOverride(dir, "npcKillsGiveSp", { flushSeconds: 300, bonus: true });
    const r = npc.loadConfig(opts);
    assert.deepStrictEqual([r.sources.flushSeconds, r.sources.bonus, r.config.bonus],
      ["settings.override.json", "settings.override.json", true]);
    writeOverride(dir, "npcKillsGiveSp", { flushSeconds: 5 });
    const bad = npc.loadConfig(opts);
    assert.deepStrictEqual([bad.config.flushSeconds, bad.sources.flushSeconds], [120, "environment"]);
    assert.ok(bad.warnings.some((w) => w.startsWith("settings.override.json \"flushSeconds\" is not")), bad.warnings);
    assert.strictEqual(npc.loadConfig({ ...opts, overrideValues: { flushSeconds: 600 } }).config.flushSeconds, 600);
  }));

  test("A4 AUD: override > env > config JSON; without override env; playersFile ignored; sources[0]", () =>
    withDir((dir) => {
      const cfg = modConfig(AUD_DIR_NAME);
      const audDir = path.join(MODS_ROOT, AUD_DIR_NAME);
      fs.mkdirSync(path.join(dir, "config"));
      fs.writeFileSync(path.join(dir, "config", cfg.CONFIG_FILENAME), JSON.stringify({ scanIntervalMs: 700 }));
      const env = { [cfg.KEYS.scanIntervalMs]: "800", EVEJS_DATA_ROOT: dir };
      const load = (e, extra = {}) => cfg.load(audDir, e, { runtimeRoot: dir, ...extra });
      assert.strictEqual(load({ EVEJS_DATA_ROOT: dir }).scanIntervalMs, 700);
      const plain = load(env);
      assert.strictEqual(plain.scanIntervalMs, 800);
      assert.deepStrictEqual(plain, load({ ...env, [IGNORE_ENV]: "1" }), "no file = kill switch");
      assert.strictEqual(cfg.resolveDataDir(env, audDir), path.join(dir, "mods", "advancedUtilityDrones"));
      writeOverride(dir, "advancedUtilityDrones", { scanIntervalMs: 900, playersFile: "other.json", verbose: "yes" });
      const over = load(env);
      assert.deepStrictEqual([over.scanIntervalMs, over.playersFile, over.verbose], [900, "", false]);
      assert.deepStrictEqual(over.sources, ["settings.override.json", "environment", cfg.CONFIG_FILENAME]);
      assert.deepStrictEqual(over.problems, []);
      assert.deepStrictEqual(Object.keys(over), Object.keys(plain), "same shape");
      assert.strictEqual(load({ ...env, [IGNORE_ENV]: "1" }).scanIntervalMs, 800);
      assert.strictEqual(load({ EVEJS_DATA_ROOT: dir }).sources.includes("environment"), false);
      assert.strictEqual(load(env, { overrideValues: {} }).scanIntervalMs, 800, "an empty preview = no override");
      writeOverride(dir, "advancedUtilityDrones", { targetMode: "", salvageTargetMode: "  " });
      const blank = load(env);
      assert.deepStrictEqual([blank.sources, blank.targetMode], [plain.sources, plain.targetMode]);
    }));

  test("A5 flat providers: rows and types, resolve override / bad value, locks, AUD stateRefreshMs", () =>
    withDir((dir) => {
      const env = { EVEJS_DATA_ROOT: dir };
      const adapter = realAdapter();
      const cases = [["hotPathPerf", "slowCallMs", 400], ["scenePerfFix", "itemNameCacheMax", 7000],
        ["npcKillsGiveSp", "flushSeconds", 300], [AUD_DIR_NAME, "scanIntervalMs", 900]];
      const providers = {};
      for (const [modId, key, value] of cases) {
        const made = createProvider(modId, { adapter, env });
        assert.strictEqual(made.ok, true, `${modId} ${JSON.stringify(made)}`);
        const p = made.provider;
        providers[modId] = p;
        const rows = p.rows();
        assert.ok(rows.length > 0 && rows.every((r) => ROW_TYPES.includes(r.type)), modId);
        const r = p.resolve({ [key]: value });
        assert.deepStrictEqual([r.ok, r.values[key], r.sources[key]], [true, value, "override"], modId);
        const below = p.resolve(null).values[key];
        const bad = p.resolve({ [key]: "bad" });
        assert.strictEqual(bad.values[key], below, modId);
        assert.ok(bad.warnings.includes(`${key}: BAD_TYPE - ignored`), `${modId} ${bad.warnings}`);
        assert.ok(p.resolve({ nope: 1 }).warnings.includes("nope: unknown key - ignored"), modId);
        assert.strictEqual(p.apply(key), "restart");
        assert.deepStrictEqual(p.current(), p.resolve(null).values, `${modId}: no file`);
        assert.strictEqual(p.dataDir, path.join(dir, "mods", modId === AUD_DIR_NAME ? "advancedUtilityDrones" : modId));
      }
      assert.strictEqual(providers.hotPathPerf.title, "Hot Path Performance");
      assert.ok(providers.hotPathPerf.rows().find((r) => r.key === "slowCallMs").label);
      assert.deepStrictEqual(providers.scenePerfFix.locked("inertKinds"), { locked: true, reason: "UNSUPPORTED_TYPE" });
      const aud = providers[AUD_DIR_NAME];
      assert.deepStrictEqual(aud.locked("playersFile"), { locked: true, reason: "BOOT_CRITICAL" });
      assert.ok(aud.resolve({ playersFile: "x.json" }).warnings.includes("playersFile: locked (BOOT_CRITICAL) - ignored"));
      assert.deepStrictEqual(aud.validate("stateRefreshMs", "0,abc"), { ok: false, reason: "BAD_VALUE" });
      assert.strictEqual(aud.validate("stateRefreshMs", "0,1000").ok, true);
      assert.deepStrictEqual(aud.validate("rangeMeters", null), { ok: false, reason: "BAD_TYPE" });
      assert.strictEqual(aud.rows().find((r) => r.key === "rangeMode").type, "enum");
      assert.strictEqual(aud.resolve(null).values.stateRefreshMs, "0,1000,2500,5000");
      assert.strictEqual(aud.resolve({ rangeMode: "fixed" }).ok, false, "AUD problems = errors");
      const npcSources = providers.npcKillsGiveSp.resolve({ bonus: true }).sources;
      assert.deepStrictEqual([npcSources.bonus, npcSources.debug], ["override", "default"]);
      const envProvider = createProvider("hotPathPerf", { adapter, env: { ...env, HOTPATH_SLOW_CALL_MS: "300" } });
      assert.strictEqual(envProvider.provider.resolve(null).sources.slowCallMs, "env");
    }));

  test("A6/B5 startModSettings default config: 18 providers = the 18 loaded folders, droneClassBalance set LOCKED, "
    + "validator 18 ok / 33 refused", () =>
    withDir((dir) => {
      const env = { EVEJS_DATA_ROOT: dir };
      const base = resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR }).config;
      const config = { ...base, dataDir: path.join(dir, "mods", "livingNewEden"),
        modSettings: { ...base.modSettings, enabled: true } };
      const real = realAdapter();
      const adapter = { listLoadedModDirs: () => ({ ok: true, dirs: [...ENTRYPOINT_MODS] }),
        loadModConfig: (d, o) => real.loadModConfig(d, o) };
      const ms = startModSettings({ config, adapter, env, modDir: MOD_DIR }).modSettings;
      const list = ms.listMods();
      assert.strictEqual(list.length, 18);
      const served = list.filter((m) => m.provider).map((m) => m.modId).sort();
      assert.deepStrictEqual(served, [...PROVIDER_MODS].sort());
      assert.strictEqual(served.length, 18);
      assert.deepStrictEqual([...base.modSettings.mods.split(",")].sort(), [...PROVIDER_MODS].sort());
      assert.deepStrictEqual([...ENTRYPOINT_MODS].sort(), [...PROVIDER_MODS].sort(), "the folders of the entrypoint");
      assert.ok(list.every((m) => m.provider === true && m.loaded === true), JSON.stringify(list));
      assert.strictEqual(ms.describe("hotPathPerf", { key: "slowCallMs" }).rows[0].running, 250);
      const drone = ms.set({ modId: "droneClassBalance", key: "logMatches", value: false, expectedRevision: 0,
        actor: { characterId: 90000001, characterName: "Pilot", channel: "web" } });
      assert.deepStrictEqual([drone.ok, drone.reason], [false, "LOCKED"], JSON.stringify(drone));
      assert.strictEqual(fs.existsSync(path.join(dir, "mods", "droneClassBalance")), false, "no file written");
      ms.stop("test");

      const of = (csv) => resolveConfig({ env: { EVEJS_LNE_MOD_SETTINGS_MODS: csv }, settings: {}, envFile: {},
        modDir: MOD_DIR });
      const eighteen = of(ENTRYPOINT_MODS.join(","));
      assert.strictEqual(eighteen.config.modSettings.mods, ENTRYPOINT_MODS.join(","));
      const many = Array.from({ length: 33 }, (_, i) => `mod${i}`).join(",");
      const refused = of(many);
      assert.strictEqual(refused.config.modSettings.mods, base.modSettings.mods);
      assert.ok(refused.warnings.some((w) => w.startsWith("EVEJS_LNE_MOD_SETTINGS_MODS=")), refused.warnings);
    }));

  test("B1 override layer of 8 KEYS mods, moonOreAnomalies, soloProgressionBalance: override > env, bad type -> env, "
    + "no file = kill switch, same shape; missionStructureRestore as before; customTypes shop untouched", () =>
    withDir((dir) => {
      const cases = [
        ["autopilotJumpZero", "warpInDistanceMeters", { EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS: "100" }, 100, 200],
        ["dailyGoalsPersist", "logMaxKeys", { EVEJS_DAILY_GOALS_PERSIST_LOG_MAX_KEYS: "300" }, 300, 400],
        ["marketAllRegions", "cacheMaxTypes", { EVEJS_MARKET_ALL_REGIONS_CACHE_MAX_TYPES: "300" }, 300, 400],
        ["industryOrphanCleanup", "log", { EVEJS_INDUSTRY_ORPHAN_CLEANUP_LOG: "0" }, false, true],
        ["missionStructureRestore", "log", { EVEJS_MISSION_STRUCTURE_RESTORE_LOG: "0" }, false, true],
        ["skyhookOrphanFix", "enabled", { EVEJS_SKYHOOKFIX_ENABLED: "0" }, false, true],
        ["planetaryDrill", "cycleSeconds", { EVEJS_PDRILL_CYCLE_SECONDS: "120" }, 120, 600],
        ["customTypes", "cleanup", { EVEJS_CUSTOMTYPES_CLEANUP: "1" }, true, false],
        ["moonOreAnomalies", "verbose", { EVEJS_MOON_ORE_ANOMALIES_VERBOSE: "1" }, true, false],
        ["soloProgressionBalance", "miningYieldScale", { EVEJS_SOLO_MINING_YIELD_SCALE: "6" }, 6, 7],
      ];
      for (const [mod, key, envPart, envValue, over] of cases) {
        const cfg = modConfig(mod);
        const modDir = path.join(MODS_ROOT, mod);
        assert.strictEqual(cfg.KEYS[key], Object.keys(envPart)[0], `${mod}: env name of ${key}`);
        const env = { ...envPart, EVEJS_DATA_ROOT: dir };
        assert.strictEqual(cfg.resolveDataDir(env, modDir), path.join(dir, "mods", mod));
        const none = cfg.load(modDir, env);
        assert.strictEqual(none[key], envValue, mod);
        assert.deepStrictEqual(none, cfg.load(modDir, { ...env, [IGNORE_ENV]: "1" }), `${mod}: no file = kill switch`);
        const file = writeOverride(dir, mod, { [key]: over, noSuchKey: 1 });
        const got = cfg.load(modDir, env);
        assert.strictEqual(got[key], over, `${mod}: override > env`);
        assert.deepStrictEqual(Object.keys(got), Object.keys(none), `${mod}: same shape`);
        assert.strictEqual(cfg.load(modDir, { ...env, [IGNORE_ENV]: "1" })[key], envValue, `${mod}: kill switch`);
        assert.strictEqual(cfg.load(modDir, env, { overrideValues: {} })[key], envValue, `${mod}: empty preview`);
        writeOverride(dir, mod, { [key]: String(over) });
        assert.strictEqual(cfg.load(modDir, env)[key], envValue, `${mod}: a bad JSON type keeps env`);
        fs.rmSync(file);
      }
      const msr = modConfig("missionStructureRestore");
      const msrDir = path.join(MODS_ROOT, "missionStructureRestore");
      assert.deepStrictEqual({ ...msr.load(msrDir, { EVEJS_DATA_ROOT: dir }) },
        { enabled: true, log: true, problems: [] }, "missionStructureRestore without a file = before");
      assert.deepStrictEqual({ ...msr.load(msrDir, { EVEJS_DATA_ROOT: dir, EVEJS_MISSION_STRUCTURE_RESTORE: "0" }) },
        { enabled: false, log: true, problems: [] });
      const ct = modConfig("customTypes");
      const ctDir = path.join(MODS_ROOT, "customTypes");
      const ctEnv = { EVEJS_DATA_ROOT: dir, EVEJS_CUSTOMTYPES_ENABLED: "1", EVEJS_CUSTOMTYPES_SHOP_ENABLED: "1" };
      const shopNone = ct.load(ctDir, ctEnv).shop;
      writeOverride(dir, "customTypes", { cleanup: true, SHOP_ENABLED: false, stations: "1" });
      const ctOver = ct.load(ctDir, ctEnv);
      assert.deepStrictEqual([ctOver.cleanup, ctOver.shop], [true, shopNone], "customTypes: the shop is outside");
      const solo = modConfig("soloProgressionBalance");
      const soloDir = path.join(MODS_ROOT, "soloProgressionBalance");
      writeOverride(dir, "soloProgressionBalance", { smbExcludedGroupIds: "29, 30", smbRatioPermille: 0 });
      const s = solo.load(soloDir, { EVEJS_DATA_ROOT: dir });
      assert.deepStrictEqual([s.smbExcludedGroupIds, s.smbRatioPermille], [[29, 30], 750]);
      assert.ok(s.problems.some((p) => p.startsWith("smbRatioPermille")), "out of range = a problem, as from env");
    }));

  test("B2 flat providers: rows and types, resolve override, locks, solo smbExcludedGroupIds", () =>
    withDir((dir) => {
      const env = { EVEJS_DATA_ROOT: dir };
      const adapter = realAdapter();
      const cases = [["autopilotJumpZero", "warpInDistanceMeters", 200], ["dailyGoalsPersist", "logMaxKeys", 400],
        ["marketAllRegions", "cacheMaxTypes", 400], ["industryOrphanCleanup", "log", false],
        ["missionStructureRestore", "log", false], ["skyhookOrphanFix", "enabled", false],
        ["planetaryDrill", "cycleSeconds", 600], ["customTypes", "cleanup", true], ["moonOreAnomalies", "verbose", true],
        ["soloProgressionBalance", "smbExcludedGroupIds", "29,30"], ["blueprintDrops", "chanceSmall", 0.5]];
      const providers = {};
      for (const [modId, key, value] of cases) {
        const made = createProvider(modId, { adapter, env });
        assert.strictEqual(made.ok, true, `${modId} ${JSON.stringify(made)}`);
        const p = made.provider;
        providers[modId] = p;
        const rows = p.rows();
        assert.ok(rows.length > 0 && rows.every((r) => ROW_TYPES.includes(r.type)), modId);
        const r = p.resolve({ [key]: value });
        assert.deepStrictEqual([r.ok, r.values[key], r.sources[key]], [true, value, "override"], modId);
        assert.deepStrictEqual(p.current(), p.resolve(null).values, `${modId}: no file`);
        assert.strictEqual(p.apply(key), "restart");
        assert.strictEqual(p.dataDir, path.join(dir, "mods", modId));
      }
      assert.deepStrictEqual(providers.customTypes.rows().map((r) => r.key), ["enabled", "cleanup"]);
      assert.ok(/Destroys/.test(providers.customTypes.rows()[1].description), "cleanup warns");
      assert.deepStrictEqual(providers.planetaryDrill.locked("launchTypeID"), { locked: true, reason: "BOOT_CRITICAL" });
      assert.deepStrictEqual(providers.blueprintDrops.locked("resonatorChance"),
        { locked: true, reason: "UNSUPPORTED_TYPE" });
      assert.deepStrictEqual(providers.blueprintDrops.validate("chanceSmall", 2), { ok: false, reason: "OUT_OF_RANGE" });
      const eliteMul = providers.blueprintDrops.rows().find((r) => r.key === "resonatorEliteQuantityMultiplier");
      assert.strictEqual(eliteMul.type, "integer", "elite multiplier is an integer row");
      assert.strictEqual(providers.blueprintDrops.validate("resonatorEliteQuantityMultiplier", 0).ok, false);
      assert.strictEqual(providers.blueprintDrops.validate("resonatorEliteQuantityMultiplier", 1.5).ok, false);
      assert.strictEqual(providers.blueprintDrops.validate("resonatorEliteQuantityMultiplier", 2).ok, true);
      const flRow = providers.blueprintDrops.rows().find((r) => r.key === "factionLootEnabled");
      assert.deepStrictEqual([flRow.type, flRow.env], ["boolean", "EVEJS_BPDROPS_FACTION_LOOT_ENABLED"]);
      assert.ok(providers.blueprintDrops.rows().some((r) => r.key === "factionLootFillerTierQuantity" && r.type === "boolean"));
      const flEnv = createProvider("blueprintDrops", { adapter, env: { ...env, EVEJS_BPDROPS_FACTION_LOOT_ENABLED: "1" } });
      const flResolved = flEnv.provider.resolve(null);
      assert.deepStrictEqual([flResolved.values.factionLootEnabled, flResolved.sources.factionLootEnabled], [true, "env"]);
      const solo = providers.soloProgressionBalance;
      assert.deepStrictEqual(solo.validate("smbExcludedGroupIds", "29,x"), { ok: false, reason: "BAD_VALUE" });
      assert.deepStrictEqual(solo.validate("smbExcludedGroupIds", "29,0"), { ok: false, reason: "BAD_VALUE" });
      assert.deepStrictEqual(solo.validate("miningYieldScale", 0), { ok: false, reason: "OUT_OF_RANGE" });
      assert.strictEqual(solo.resolve(null).values.smbExcludedGroupIds, "29");
      assert.strictEqual(solo.resolve({ smbRatioPermille: 900 }).values.smbRatioPermille, 900);
      const autopilot = providers.autopilotJumpZero.rows().find((row) => row.key === "warpInDistanceMeters");
      assert.deepStrictEqual([autopilot.type, autopilot.min, autopilot.max], ["number", 0, 1000000]);
      const envMade = createProvider("marketAllRegions",
        { adapter, env: { ...env, EVEJS_MARKET_ALL_REGIONS_CACHE_MAX_TYPES: "300" } });
      assert.strictEqual(envMade.provider.resolve(null).sources.cacheMaxTypes, "env");
    }));

  test("B3 blueprintDrops config.js: no file = the old loadSettings, override > env resonator flag > settings.json, "
    + "nested tables skipped, loader reads config.js", () => withDir((dir) => {
    const bpDir = path.join(MODS_ROOT, "blueprintDrops");
    const cfg = modConfig("blueprintDrops");
    const { mergeSettings } = require(path.join(bpDir, "lib", "settings.js"));
    const { resolveResonatorFlag } = require(path.join(bpDir, "lib", "resonators.js"));
    const missing = path.join(dir, "none.json");
    const oldLoad = (env) => {
      const merged = mergeSettings(JSON.parse(fs.readFileSync(path.join(bpDir, "settings.json"), "utf8")) || {});
      merged.resonatorsEnabled = resolveResonatorFlag(merged, env);
      return merged;
    };
    const flagOn = { EVEJS_BPDROPS_RESONATORS_ENABLED: "1" };
    assert.deepStrictEqual(cfg.loadConfig({ env: {}, overrideFilePath: missing }), { settings: oldLoad({}),
      warnings: [] });
    assert.deepStrictEqual(cfg.loadConfig({ env: flagOn, overrideFilePath: missing }).settings, oldLoad(flagOn));
    writeOverride(dir, "blueprintDrops", { resonatorsEnabled: false, chanceSmall: 0.5, copyMaxRuns: "5",
      resonatorChance: { frigate: 1 } });
    const env = { ...flagOn, EVEJS_DATA_ROOT: dir };
    const over = cfg.loadConfig({ env }).settings;
    assert.deepStrictEqual([over.resonatorsEnabled, over.chanceSmall, over.copyMaxRuns, over.resonatorChance],
      [false, 0.5, oldLoad(flagOn).copyMaxRuns, oldLoad(flagOn).resonatorChance]);
    assert.deepStrictEqual(cfg.loadConfig({ env: { ...env, [IGNORE_ENV]: "1" } }).settings, oldLoad(flagOn));
    assert.strictEqual(cfg.loadConfig({ env, overrideValues: { resonatorsEnabled: true } }).settings.resonatorsEnabled,
      true);
    const loaderText = fs.readFileSync(path.join(bpDir, "loader.js"), "utf8");
    assert.ok(loaderText.includes("require(\"./config\").loadConfig()"), "loader calls config.loadConfig");
    assert.ok(!/readFileSync\([^)]*settings\.json/.test(loaderText), "loader does not read settings.json itself");
  }));

  test("B4 droneClassBalance read only: manifest rows, values of the exports, every key READ_ONLY", () =>
    withDir((dir) => {
      const made = createProvider("droneClassBalance", { adapter: realAdapter(), env: { EVEJS_DATA_ROOT: dir } });
      assert.strictEqual(made.ok, true, JSON.stringify(made));
      const p = made.provider;
      const dcbDir = path.join(MODS_ROOT, "droneClassBalance");
      const manifest = JSON.parse(fs.readFileSync(path.join(dcbDir, "evejs-launcher.mod.json"), "utf8"));
      const rows = p.rows();
      assert.strictEqual(rows.length, manifest.settings.fields.length);
      assert.ok(rows.every((r) => ROW_TYPES.includes(r.type)));
      assert.ok(rows.every((r) => p.locked(r.key).reason === "READ_ONLY" && p.locked(r.key).locked === true));
      const exportsObj = require(path.join(dcbDir, "config.js"));
      const cur = p.current();
      assert.strictEqual(cur["classes.Destroyer.bandwidthMultiplier"], exportsObj.classes.Destroyer.bandwidthMultiplier);
      assert.strictEqual(cur.logMatches, exportsObj.logMatches);
      const r = p.resolve({ logMatches: false });
      assert.deepStrictEqual([r.ok, r.values.logMatches, r.warnings], [true, exportsObj.logMatches,
        ["logMatches: locked (READ_ONLY) - ignored"]]);
      assert.ok(["default", "file"].includes(r.sources["classes.Destroyer.maxActiveDrones"]));
      assert.deepStrictEqual(p.validate("logMatches", true), { ok: false, reason: "BAD_VALUE" });
      assert.strictEqual(p.dataDir, path.join(dir, "mods", "droneClassBalance"));
    }));
};
