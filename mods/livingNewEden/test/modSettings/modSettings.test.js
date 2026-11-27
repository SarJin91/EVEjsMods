"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA, resolveConfig, loadConfig } = require("../../config");
const { OVERRIDE_FILE_NAME, IGNORE_ENV, overridePathOf, readOverrideFile } =
  require("../../lib/modSettings/overrideFile");
const { LOCK, createLocks, LNE_LOCKS } = require("../../lib/modSettings/locks");
const { staticLockOf } = require("../../lib/modSettings/lockSpec");
const { createLneProvider } = require("../../lib/modSettings/providers/lne");
const { createShipWingProvider } = require("../../lib/modSettings/providers/shipWing");
const { describeRows } = require("../../lib/modSettings/catalog");
const { startModSettings } = require("../../lib/modSettings");
const { isSecretRow, describeConfig } = require("../../lib/observer/effectiveConfig");
const { buildEffectiveConfigView } = require("../../lib/observer/views/effectiveConfig");
const { createAdapter } = require("../../lib/adapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SHIP_WING_DIR = path.resolve(MOD_DIR, "..", "shipWing");
const SHIP_WING_READER = path.join(SHIP_WING_DIR, "lib", "settingsOverride.js");
const SUMMARY_RE = /^\d+ keys overridden in game \(settings\.override\.json\)$/;
const ENV_NAME_RULE_EXCEPTIONS = Object.freeze(["archaeology.seasonKey", "chatterAi.maxTokens", "chatterAi.newsMaxTokens",
  "chatterAi.plotMaxTokens",
  "chatterAi.talkMaxTokens",
  "persistence.walPerTx.maxKeys",
  "seasons.maxPendingKeys",
  "shipAi.maxTokens", "shipAi.perCharacterDailyTokens", "shipAi.sharedKeyMaxRpm", "shipAi.summaryMaxTokens",
  "shipAi.thinkingMaxTokens",
  "trade.buyOrderWalletAccountKey", "trade.walletAccountKey", "world.sovReconcile.logOnceMaxKeys"]);

function envOf(key) {
  return SCHEMA.find((r) => r.key === key).env;
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-modsettings-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
}

function readerText(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("function readOverrideFile(");
  const end = text.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `no readOverrideFile in ${file}`);
  return text.slice(start, end + 2);
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function fakeAdapter(dirs) {
  return {
    listLoadedModDirs: () => ({ ok: true, dirs: Object.freeze([...dirs]) }),
    loadModConfig: (dir) => (dir === "shipWing"
      ? { ok: true, exports: require(path.join(SHIP_WING_DIR, "config.js")), modDir: SHIP_WING_DIR }
      : { ok: false, reason: "CONFIG_MISSING" }),
  };
}

function lneConfig(env) {
  return resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR }).config;
}

module.exports = ({ test }) => {
  test("MS1 overrideFile: missing, bad JSON / root / schemaVersion / values -> warning and no values, kill switch, valid",
    () => withDir((dir) => {
      const file = overridePathOf(dir);
      assert.strictEqual(path.basename(file), OVERRIDE_FILE_NAME);
      assert.strictEqual(IGNORE_ENV, "EVEJS_MOD_SETTINGS_OVERRIDES_IGNORE");
      assert.deepStrictEqual(readOverrideFile(file, {}),
        { ok: true, values: {}, revision: 0, present: false, ignored: false, warnings: [] });
      for (const [text, word] of [["{not json", "not valid JSON"], ["[1,2]", "root is not an object"],
        [JSON.stringify({ schemaVersion: 2, values: { enabled: true } }), "schemaVersion"],
        [JSON.stringify({ schemaVersion: 1, revision: 3, values: [1] }), "values is not an object"]]) {
        writeDoc(file, text);
        const r = readOverrideFile(file, {});
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.present, true);
        assert.deepStrictEqual(r.values, {});
        assert.strictEqual(r.warnings.length, 1);
        assert.ok(r.warnings[0].includes(word), r.warnings[0]);
        assert.ok(!r.warnings[0].includes(dir), "no host path in the warning");
      }
      writeDoc(file, "\uFEFF{\"schemaVersion\":1,\"revision\":7,\"updatedAtMs\":1,\"updatedBy\":9,"
        + "\"values\":{\"observer.refreshMs\":5000,\"__proto__\":{\"x\":1}}}");
      const ok = readOverrideFile(file, {});
      assert.deepStrictEqual([ok.present, ok.ignored, ok.revision, ok.warnings], [true, false, 7, []]);
      assert.strictEqual(ok.values["observer.refreshMs"], 5000);
      assert.strictEqual(Object.getPrototypeOf(ok.values), Object.prototype, "a __proto__ key stays a plain key");
      assert.ok(Object.prototype.hasOwnProperty.call(ok.values, "__proto__"));
      const off = readOverrideFile(file, { [IGNORE_ENV]: "1" });
      assert.deepStrictEqual([off.ignored, off.present, off.values], [true, false, {}]);
      assert.deepStrictEqual(off.warnings, [`${OVERRIDE_FILE_NAME} ignored - ${IGNORE_ENV}=1`]);
      assert.strictEqual(readOverrideFile(dir, {}).present, true, "a folder: unreadable -> warning, no throw");
    }));

  test("MS2 LNE config: override beats env (source override, one summary line), refused keys, kill switch, no file "
    + "= unchanged, characterIdList", () => withDir((dir) => {
    const refresh = envOf("observer.refreshSeconds");
    const base = { env: { [refresh]: "7" }, settings: {}, envFile: {}, modDir: MOD_DIR };
    const plain = resolveConfig(base);
    assert.deepStrictEqual(resolveConfig({ ...base, overrides: {} }), plain, "an empty override changes nothing");
    const r = resolveConfig({ ...base, overrides: { "observer.refreshSeconds": 9, "observer.journalLimit": "x",
      "no.such.key": 1, "chatterAi.apiKey": "k", "modSettings.allowedCharacterIds": "90000001" } });
    assert.strictEqual(r.config.observer.refreshSeconds, 9);
    assert.strictEqual(r.sources["observer.refreshSeconds"], "override");
    assert.strictEqual(r.sources["observer.journalLimit"], "default", "a bad value keeps the layer below");
    assert.ok(r.warnings.some((w) => w.startsWith("settings.override.json \"observer.journalLimit\"=\"x\" is not")));
    assert.strictEqual(r.config.modSettings.allowedCharacterIds, "", "the allow list is never taken from the override");
    assert.strictEqual(r.config.chatterAi.apiKey, "", "env-only never from the override");
    assert.strictEqual(r.warnings.filter((w) => SUMMARY_RE.test(w)).length, 1);
    assert.ok(r.warnings.includes("1 keys overridden in game (settings.override.json)"), r.warnings.join("\n"));
    assert.ok(r.warnings.some((w) => w.includes("\"no.such.key\" is not a setting")));
    assert.ok(r.warnings.some((w) => w.includes("\"chatterAi.apiKey\" cannot be set in game")));
    assert.ok(r.warnings.some((w) => w.includes("\"modSettings.allowedCharacterIds\" cannot be set in game")));
    assert.ok(!r.warnings.some((w) => w.includes("overrides the launcher setting")), "the env warning is env only");
    assert.deepStrictEqual(r.errors, [], "a bad override is never an error");

    const file = path.join(dir, "mods", "livingNewEden", OVERRIDE_FILE_NAME);
    const env = { [refresh]: "7", EVEJS_DATA_ROOT: dir };
    const opts = { modDir: MOD_DIR, env, settingsFilePath: path.join(dir, "none.json"), envFilePath: path.join(dir, "none") };
    const none = loadConfig(opts);
    assert.deepStrictEqual(none, resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR }),
      "no override file = the config as without the layer");
    writeDoc(file, { schemaVersion: 1, revision: 1, values: { "observer.refreshSeconds": 11 } });
    const read = loadConfig(opts);
    assert.deepStrictEqual([read.config.observer.refreshSeconds, read.sources["observer.refreshSeconds"]],
      [11, "override"]);
    const killed = loadConfig({ ...opts, env: { ...env, [IGNORE_ENV]: "1" } });
    assert.deepStrictEqual([killed.config.observer.refreshSeconds, killed.sources["observer.refreshSeconds"]],
      [7, "environment"]);
    const preview = loadConfig({ ...opts, overrideValues: { "observer.refreshSeconds": 12 } });
    assert.strictEqual(preview.config.observer.refreshSeconds, 12, "overrideValues replaces the file");
    assert.strictEqual(loadConfig({ ...opts, overrideValues: {} }).config.observer.refreshSeconds, 7);

    const ids = envOf("modSettings.allowedCharacterIds");
    const of = (v) => resolveConfig({ env: { [ids]: v }, settings: {}, envFile: {}, modDir: MOD_DIR });
    assert.strictEqual(of("90000001, 90000002").config.modSettings.allowedCharacterIds, "90000001, 90000002");
    const many = Array.from({ length: 33 }, (_, i) => String(90000001 + i)).join(",");
    for (const bad of ["0", "-1", "abc", "1,,2", "9007199254740993", many]) {
      const b = of(bad);
      assert.strictEqual(b.config.modSettings.allowedCharacterIds, "", bad);
      assert.ok(b.warnings.some((w) => w.startsWith(`${ids}=`)), bad);
    }
    assert.strictEqual(of(many.split(",").slice(0, 32).join(",")).warnings.length, 0, "32 IDs pass");
    const d = lneConfig({}).modSettings;
    assert.deepStrictEqual([d.enabled, d.allowedCharacterIds, d.mods, d.maxRowsPerPage],
      [false, "", "livingNewEden,shipWing,EveJS-AdvancedUtilityDrones-1.0.3,hotPathPerf,scenePerfFix,npcKillsGiveSp,"
        + "moonOreAnomalies,soloProgressionBalance,autopilotJumpZero,droneClassBalance,blueprintDrops,marketAllRegions,"
        + "dailyGoalsPersist,industryOrphanCleanup,skyhookOrphanFix,customTypes,planetaryDrill,missionStructureRestore",
      200]);
  }));

  test("MS3 shipWing: the reader copy has the same readOverrideFile text (SHA-1, LF) and constants; the provider "
    + "resolves an override over EVEJS_SHIPWING_*", () => {
    const lneFile = path.join(MOD_DIR, "lib", "modSettings", "overrideFile.js");
    assert.strictEqual(sha1(readerText(SHIP_WING_READER)), sha1(readerText(lneFile)));
    const copy = require(SHIP_WING_READER);
    for (const k of ["OVERRIDE_FILE_NAME", "IGNORE_ENV", "OVERRIDE_SCHEMA_VERSION"]) {
      assert.strictEqual(copy[k], require(lneFile)[k], k);
    }
    const loaded = fakeAdapter([]).loadModConfig("shipWing");
    const p = createShipWingProvider({ loaded, env: { EVEJS_SHIPWING_MAX_WING_PER_PILOT: "4" } }).provider;
    const r = p.resolve({ maxWingPerPilot: 6 });
    assert.deepStrictEqual([r.values.maxWingPerPilot, r.sources.maxWingPerPilot], [6, "override"]);
    assert.strictEqual(p.resolve(null).values.maxWingPerPilot, 4);
    assert.deepStrictEqual(createShipWingProvider({ loaded: { ok: false, reason: "CONFIG_MISSING" } }),
      { ok: false, reason: "CONFIG_MISSING" });
    assert.deepStrictEqual(p.validate("maxWingPerPilot", 11), { ok: false, reason: "OUT_OF_RANGE" });
    assert.deepStrictEqual(p.validate("maxWingPerPilot", "3"), { ok: false, reason: "BAD_TYPE" });
    assert.deepStrictEqual(p.validate("nope", 1), { ok: false, reason: "UNKNOWN_KEY" });
    assert.strictEqual(p.apply("enabled"), "restart");

    const blind = createAdapter({ moduleApi: { _cache: {} }, modsRoot: path.resolve(MOD_DIR, ".."),
      existsSync: () => false });
    assert.deepStrictEqual(blind.loadModConfig("shipWing"), { ok: false, reason: "CONFIG_MISSING" });
    assert.deepStrictEqual(blind.loadModConfig("../shipWing"), { ok: false, reason: "BAD_MOD_DIR" });
    const real = createAdapter({ moduleApi: { _cache: {} }, modsRoot: path.resolve(MOD_DIR, "..") });
    const got = real.loadModConfig("shipWing");
    assert.deepStrictEqual([got.ok, got.modDir], [true, SHIP_WING_DIR]);
  });

  test("MS4 locks: SELF, BOOT_CRITICAL, TEST_ONLY, SECRET; every secret row locked; env URL|KEY|TOKEN locked or listed",
    () => {
      const p = createLneProvider({ env: {} }).provider;
      const keys = new Set(SCHEMA.map((r) => r.key));
      const expect = { "modSettings.enabled": LOCK.SELF, "modSettings.allowedCharacterIds": LOCK.SELF,
        enabled: LOCK.BOOT_CRITICAL, "persistence.dbFile": LOCK.BOOT_CRITICAL, "observer.enabled": LOCK.BOOT_CRITICAL,
        "observer.host": LOCK.BOOT_CRITICAL, "observer.port": LOCK.BOOT_CRITICAL,
        "inGameMap.observerUrl": LOCK.BOOT_CRITICAL, "alerts.webhookUrl": LOCK.SECRET, "chatterAi.apiKey": LOCK.SECRET,
        "chatterAi.baseUrl": LOCK.SECRET, "chatterAi.dailyTokenBudget": LOCK.SECRET,
        "testing.timeScale": LOCK.TEST_ONLY };
      for (const [key, reason] of Object.entries(expect)) {
        assert.ok(keys.has(key), `${key} not in SCHEMA`);
        assert.deepStrictEqual(p.locked(key), { locked: true, reason }, key);
      }
      assert.ok(keys.has("observer.journalLimit"));
      assert.deepStrictEqual(p.locked("observer.journalLimit"), { locked: false });
      for (const row of SCHEMA) {
        if (isSecretRow(row) || row.envOnly === true) {
          assert.deepStrictEqual(p.locked(row.key), { locked: true, reason: LOCK.SECRET }, row.key);
        }
      }
      const open = SCHEMA.filter((r) => /URL|KEY|TOKEN/.test(r.env) && !p.locked(r.key).locked).map((r) => r.key);
      assert.deepStrictEqual(open.sort(), [...ENV_NAME_RULE_EXCEPTIONS]);
      assert.ok(p.rows().filter((r) => r.secret).every((r) => p.locked(r.key).reason === LOCK.SECRET));
      const sw = createShipWingProvider({ loaded: fakeAdapter([]).loadModConfig("shipWing"), env: {} }).provider;
      const swOpen = sw.rows().filter((r) => /URL|KEY|TOKEN/.test(r.env) && !sw.locked(r.key).locked);
      assert.deepStrictEqual(swOpen, [], "shipWing: no such row today");
      assert.ok(sw.rows().every((r) => !sw.locked(r.key).locked || r.secret), "shipWing: secrets only");
      assert.strictEqual(createLocks(LNE_LOCKS).locked(null).locked, false);
    });

  test("MS5 catalog and service: describe fields, secret mask, filter and paging; off -> disabled_by_config; on -> "
    + "listMods with provider:false for a mod outside the list", () => withDir((dir) => {
    const env = { EVEJS_DATA_ROOT: dir, [envOf("observer.journalLimit")]: "40" };
    const config = { ...lneConfig(env), dataDir: path.join(dir, "mods", "livingNewEden") };
    assert.deepStrictEqual(startModSettings({ config, adapter: fakeAdapter([]), env }),
      { ok: false, reason: "disabled_by_config" });

    const on = { ...config, modSettings: { ...config.modSettings, enabled: true, maxRowsPerPage: 20,
      mods: "livingNewEden,shipWing" } };
    writeDoc(path.join(dir, "mods", "livingNewEden", OVERRIDE_FILE_NAME),
      { schemaVersion: 1, revision: 2, values: { "observer.journalLimit": 60 } });
    const started = startModSettings({ config: on, adapter: fakeAdapter(["livingNewEden", "npcKillsGiveSp", "shipWing"]),
      env, modDir: MOD_DIR });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    const ms = started.modSettings;
    assert.deepStrictEqual(ms.listMods().map((m) => [m.modId, m.provider, m.reason]), [
      ["livingNewEden", true, null], ["npcKillsGiveSp", false, "NOT_ENABLED"], ["shipWing", true, null]]);

    const page = ms.describe("livingNewEden", { q: "observer.journallimit" });
    assert.strictEqual(page.ok, true, JSON.stringify(page));
    assert.strictEqual(page.total, 1);
    const row = page.rows[0];
    assert.deepStrictEqual([row.key, row.running, row.next, row.hasOverride, row.override, row.underlying,
      row.source, row.underlyingSource, row.pending, row.locked, row.apply],
    ["observer.journalLimit", 40, 60, true, 60, 40, "override", "environment", true, false, "restart"]);
    assert.deepStrictEqual(page.overrideFile, { present: true, ignored: false, revision: 2, warnings: [] });
    for (const f of ["label", "description", "group", "type", "default", "env", "lockReason"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, f), f);
    }
    const secret = ms.describe("livingNewEden", { q: "chatterAi.apiKey" }).rows[0];
    assert.deepStrictEqual([secret.default, secret.running, secret.next, secret.underlying, secret.lockReason],
      ["***", "***", "***", "***", "SECRET"]);
    const group = ms.describe("livingNewEden", { group: "modSettings", offset: 3, limit: 5 });
    assert.deepStrictEqual([group.total, group.offset, group.limit, group.rows.length], [11, 3, 5, 5]);
    assert.ok(group.rows.every((r) => r.lockReason === "SELF"));
    assert.ok(group.groups.some((g) => g.group === "modSettings" && g.count === 11));
    assert.strictEqual(ms.describe("livingNewEden", { limit: 5000 }).limit, 20, "limit <= maxRowsPerPage");
    const sw = ms.describe("shipWing", { q: "maxwingperpilot" });
    assert.deepStrictEqual([sw.ok, sw.rows[0].next, sw.rows[0].group], [true, 2, "max"]);
    assert.deepStrictEqual(ms.describe("npcKillsGiveSp"), { ok: false, reason: "NOT_ENABLED" });

    const noShipWing = startModSettings({ config: on, adapter: { listLoadedModDirs: () => ({ ok: true, dirs: [] }),
      loadModConfig: () => ({ ok: false, reason: "CONFIG_MISSING" }) }, env, modDir: MOD_DIR }).modSettings;
    assert.deepStrictEqual(noShipWing.listMods().find((m) => m.modId === "shipWing"),
      { modId: "shipWing", title: "shipWing", loaded: false, provider: false, reason: "CONFIG_MISSING" });
    ms.stop("test");
    assert.deepStrictEqual(ms.describe("livingNewEden"), { ok: false, reason: "STOPPED" });
    assert.strictEqual(ms.getStatus().state, "stopped");

    const lne = createLneProvider({ env, config }).provider;
    const direct = describeRows(lne, { running: {}, next: null, overrides: {} }, { maxRowsPerPage: 20, q: "zzzz" });
    assert.deepStrictEqual([direct.total, direct.rows], [0, []]);
  }));

  test("MS6 effective-config: an override flag counts as differs (source override) in the existing view", () => {
    const r = resolveConfig({ env: {}, settings: {}, envFile: {}, modDir: MOD_DIR,
      overrides: { "tribute.enabled": true } });
    const d = describeConfig({ schema: SCHEMA, config: r.config, sources: r.sources, warnings: r.warnings,
      errors: r.errors, services: null, originChars: 0 });
    const flag = d.flags.find((f) => f.key === "tribute.enabled");
    assert.deepStrictEqual([flag.value, flag.source, flag.differs, flag.pinned], [true, "override", true, false]);
    assert.strictEqual(d.summary.bySource.override, 1);
    const view = buildEffectiveConfigView({ ctx: { config: r.config, state: { configResult: r } }, schema: SCHEMA,
      store: () => null, settings: { refreshMs: 10000, originChars: 0 } }).getData();
    assert.strictEqual(view.available, true);
    assert.strictEqual(view.flags.find((f) => f.key === "tribute.enabled").source, "override");
    assert.ok(view.warnings.includes("1 keys overridden in game (settings.override.json)"));
  });

  test("MS7: the override refuses every locked row (secret, BOOT_CRITICAL, testing.* "
    + "modSettings.*) = locks.js over SCHEMA; unknown-key lines capped and quoted", () => {
    const locks = createLocks(LNE_LOCKS);
    const drift = SCHEMA.filter((row) => locks.locked(row).locked !== (staticLockOf(LNE_LOCKS, row) !== null))
      .map((row) => row.key);
    assert.deepStrictEqual(drift, [], "a word-rule secret must be listed in lockSpec secretKeys");
    const lockedRows = SCHEMA.filter((row) => locks.locked(row).locked);
    const base = { env: { [envOf("observer.port")]: "26411" }, settings: {}, envFile: {}, modDir: MOD_DIR };
    const plain = resolveConfig(base);
    const bogus = (row) => (row.type === "boolean" ? !row.default : row.type === "string" ? "https://evil.example/"
      : row.default === row.maximum ? row.minimum : row.maximum);
    const r = resolveConfig({ ...base, overrides: Object.fromEntries(lockedRows.map((row) => [row.key, bogus(row)])) });
    for (const row of lockedRows) {
      assert.strictEqual(r.sources[row.key], plain.sources[row.key], row.key);
      assert.ok(r.warnings.includes(`settings.override.json "${row.key}" cannot be set in game `
        + `(${locks.locked(row).reason}) - ignored`), row.key);
    }
    assert.deepStrictEqual(r.config, plain.config, "no locked row changes the config");
    assert.ok(!r.warnings.some((w) => SUMMARY_RE.test(w)));
    for (const key of ["chatterAi.baseUrl", "alerts.webhookUrl", "enabled", "observer.host", "testing.timeScale"]) {
      assert.ok(lockedRows.some((row) => row.key === key), key);
    }
    assert.strictEqual(r.config.observer.port, 26411);

    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`no.such.${i}`, 1]));
    many[`x\n${"y".repeat(200)}`] = 1;
    const u = resolveConfig({ ...base, overrides: many }).warnings.filter((w) => w.includes("not a setting"));
    assert.strictEqual(u.length, 11, u.join("\n"));
    assert.strictEqual(u[10], "settings.override.json: +4 more keys that are not a setting of this mod - ignored");
    assert.ok(u.every((w) => !w.includes("\n") && w.length < 200));
    const cut = resolveConfig({ ...base, overrides: { [`x\n${"y".repeat(200)}`]: 1 } }).warnings
      .find((w) => w.includes("not a setting"));
    assert.strictEqual(cut, `settings.override.json ${JSON.stringify(`x\n${"y".repeat(78)}...`)} is not a setting `
      + "of this mod - ignored");
  });
};
