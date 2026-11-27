"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const { createConfigSnapshotMemo, FUNCTIONS, CONFIG_SLOTS, MARK } = require("../lib/configSnapshotMemo");

const MISSING = path.join(__dirname, "missing.json");
const DOMAINS = Object.freeze(["server", "network", "gameplay", "client", "market", "debug"]);

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function atomicWrite(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeJson(tmp, value);
  fs.renameSync(tmp, file);
}

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath16-"));
  for (const d of DOMAINS) writeJson(path.join(dir, `${d}.json`), {});
  writeJson(path.join(dir, "server.json"), { imageServerUrl: "http://img/a", defaultCountryCode: "DE" });
  writeJson(path.join(dir, "version.json"), { evejsVersion: "261108.1", configSchemaVersion: 1 });
  return dir;
}

function makeConfig(dir) {
  const counters = { snapshots: 0 };
  const files = Object.fromEntries(DOMAINS.map((d) => [d, path.join(dir, `${d}.json`)]));
  const versionConfigPath = path.join(dir, "version.json");
  const cfg = { defaultCountryCode: "PL", imageServerUrl: "boot" };
  Object.defineProperty(cfg, "getConfigStateSnapshot", {
    value() {
      counters.snapshots += 1;
      const resolved = { defaultCountryCode: "GB", imageServerUrl: "", newCharacterExperienceMode: "tutorial",
        hyperNetKillSwitch: false, skillPurchaseEnabled: true, list: [1, 2] };
      for (const d of DOMAINS) {
        if (!fs.existsSync(files[d])) continue;
        const raw = JSON.parse(fs.readFileSync(files[d], "utf8"));
        if (raw.invalid) throw new Error(`${d}.json invalid`);
        Object.assign(resolved, raw);
      }
      return { resolvedConfig: { ...resolved }, configFilePaths: { ...files }, versionConfigPath };
    },
  });
  return { cfg, counters, files };
}

function loadVendor(text, filename, cfg) {
  const fn = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${text}\n})`, { filename });
  const mod = { exports: {} };
  const fakeRequire = (request) => {
    if (request === "path") return path;
    const base = path.basename(request);
    if (base === "config") return cfg;
    if (base === "protocolProfile") return { CLIENT_COMPATIBILITY_PROFILE: {} };
    if (base === "sessionRegistry") return { getSessions: () => [] };
    if (base === "storeState") return { buildClientGlobalConfigEntries: () => [["storeKey", 1]] };
    throw new Error(`unexpected require ${request}`);
  };
  fn(mod.exports, fakeRequire, mod, filename, path.dirname(filename));
  return mod.exports;
}

function register(ctx) {
  const { test, config, loader, SERVER_SRC } = ctx;
  const gcFile = path.join(SERVER_SRC, "services", "machoNet", "globalConfig.js");
  const haveSrc = fs.existsSync(gcFile);
  const gcText = haveSrc ? fs.readFileSync(gcFile, "utf8") : "";
  const norm = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");

  function pair(revalidateMs, dir = makeDir(), parityCheck = false) {
    const clock = { t: 0 };
    const lines = [];
    const plainCfg = makeConfig(dir);
    const plain = loadVendor(gcText, gcFile, plainCfg.cfg);
    const wrappedCfg = makeConfig(dir);
    const exp = loadVendor(gcText, gcFile, wrappedCfg.cfg);
    const memo = createConfigSnapshotMemo({ revalidateMs, parityCheck, now: () => clock.t, log: (l) => lines.push(l) });
    assert.deepStrictEqual(memo.checkSource(gcText), { ok: true });
    memo.setVendorConfig(wrappedCfg.cfg);
    assert.deepStrictEqual(memo.patchExports(exp), { ok: true });
    return { dir, clock, lines, plain, exp, memo, disk: wrappedCfg.counters, cfg: wrappedCfg.cfg, files: wrappedCfg.files };
  }

  function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  test("H16-1 vendor facts 261108.1: 5 exports + fingerprints, consumers destructure, snapshot non-writable", () => {
    if (!haveSrc) return;
    const gc = gcText.replace(/\r\n/g, "\n");
    const block = /\nmodule\.exports = \{\n([\s\S]*?)\n\};/.exec(gc);
    assert.ok(block, "module.exports globalConfig");
    for (const name of FUNCTIONS) assert.ok(block[1].split("\n").includes(`  ${name},`), `eksport ${name}`);
    assert.deepStrictEqual(createConfigSnapshotMemo({ revalidateMs: 0 }).checkSource(gcText), { ok: true });
    const destructures = (rel, name) =>
      new RegExp(`const \\{[^}]*\\b${name}\\b[^}]*\\} = require\\(path\\.join\\([^)]*globalConfig"`).test(norm(rel));
    assert.ok(destructures(path.join("network", "tcp", "handshake.js"), "getRuntimeConfig"), "handshake getRuntimeConfig");
    assert.ok(destructures(path.join("network", "tcp", "handshake.js"), "normalizeCountryCode"), "handshake normalizeCountryCode");
    assert.ok(destructures(path.join("services", "cache", "cacheService.js"), "getRuntimeConfig"), "cacheService");
    assert.ok(destructures(path.join("services", "machoNet", "machoNetService.js"), "buildGlobalConfigDict"), "machoNetService");
    assert.ok(destructures(path.join("network", "tcp", "index.js"), "normalizeCountryCode"), "tcp/index");
    const manager = norm(path.join("config", "manager.js"));
    assert.ok(manager.includes("    getConfigStateSnapshot: { value: loadState },"), "getConfigStateSnapshot through defineProperties");
    assert.ok(manager.includes("      configFilePaths: { ...configFilePaths },\n      versionConfigPath,"), "paths in the snapshot");
  });

  test("H16-2 parity and hit: 1 read per 2 calls, deepStrictEqual with the vendor, new instances, explicit argument unchanged", () => {
    if (!haveSrc) return;
    const p = pair(1000);
    try {
      const r1 = p.exp.getRuntimeConfig();
      assert.strictEqual(p.disk.snapshots, 2);
      const r2 = p.exp.getRuntimeConfig();
      assert.strictEqual(p.disk.snapshots, 2, "hit without disk");
      assert.deepStrictEqual(r1, p.plain.getRuntimeConfig());
      assert.deepStrictEqual(r2, r1);
      assert.notStrictEqual(r1, r2);
      r1.imageServerUrl = "mutated";
      r2.list.push(3);
      assert.deepStrictEqual(p.exp.getRuntimeConfig(), p.plain.getRuntimeConfig(), "mutating the result does not break the memo");
      for (const v of ["pl", "kr", "", undefined, "xx1"]) {
        assert.strictEqual(p.exp.normalizeCountryCode(v), p.plain.normalizeCountryCode(v), String(v));
      }
      assert.deepStrictEqual(p.exp.buildGlobalConfigDict(), p.plain.buildGlobalConfigDict());
      assert.deepStrictEqual(p.exp.buildGlobalConfigEntries(), p.plain.buildGlobalConfigEntries());
      assert.strictEqual(p.exp.getRuntimeGlobalConfigValue("imageserverurl"), "http://img/a");
      assert.strictEqual(p.disk.snapshots, 2, "wrappers 2-5 without disk");
      const explicit = { imageServerUrl: "E" };
      assert.deepStrictEqual(p.exp.buildGlobalConfigDict(explicit), p.plain.buildGlobalConfigDict(explicit));
      assert.strictEqual(p.exp.normalizeCountryCode("zz", null), p.plain.normalizeCountryCode("zz", null));
      assert.strictEqual(p.exp.normalizeCountryCode("z", "FR"), "FR");
      assert.strictEqual(p.exp.normalizeCountryCode("z", null), "GB");
      assert.throws(() => p.exp.getRuntimeGlobalConfigValue("imageserverurl", null), TypeError);
      assert.throws(() => p.plain.getRuntimeGlobalConfigValue("imageserverurl", null), TypeError);
      assert.strictEqual(p.disk.snapshots, 2);
      const s = p.memo.stats();
      assert.deepStrictEqual([s.state, s.misses, s.hits, s.passthroughErrors], ["cached", 1, 10, 0]);
      assert.ok(/^stats configMemo=on hits=10 misses=1 reval=0 keyChg=0 errPass=0 parity=0$/.test(p.memo.drainStatsLines()[0]));
      for (const name of FUNCTIONS) assert.ok(p.exp[name][MARK], `${name} wrapped`);
      assert.deepStrictEqual(p.memo.patchExports(p.exp), { ok: true }, "idempotentne");
      assert.ok(p.exp.getRuntimeConfig[MARK] && !p.exp.getRuntimeConfig[MARK][MARK], "no double wrap");
    } finally {
      cleanup(p.dir);
    }
  });

  test("H16-3 invalidation: temp+rename with revalidateMs=0 = new read; 1000 ms window; deleting the file changes the key", () => {
    if (!haveSrc) return;
    const p = pair(0);
    try {
      assert.strictEqual(p.exp.getRuntimeConfig().imageServerUrl, "http://img/a");
      p.exp.getRuntimeConfig();
      assert.strictEqual(p.disk.snapshots, 2);
      atomicWrite(p.files.server, { imageServerUrl: "http://img/changed-b", defaultCountryCode: "DE" });
      assert.strictEqual(p.exp.getRuntimeConfig().imageServerUrl, "http://img/changed-b");
      assert.strictEqual(p.disk.snapshots, 3);
      assert.strictEqual(p.memo.stats().keyChanges, 1);
      assert.strictEqual(p.memo.stats().revalidations, 1);
    } finally {
      cleanup(p.dir);
    }
    const w = pair(1000);
    try {
      w.exp.getRuntimeConfig();
      atomicWrite(w.files.network, { pingMs: 12345 });
      w.clock.t = 999;
      assert.strictEqual(w.exp.getRuntimeConfig().pingMs, undefined, "old content inside the window");
      w.clock.t = 1000;
      assert.strictEqual(w.exp.getRuntimeConfig().pingMs, 12345, "new content after the window");
      fs.unlinkSync(w.files.network);
      w.clock.t = 2000;
      assert.strictEqual(w.exp.getRuntimeConfig().pingMs, undefined, "deleted file = new key");
      assert.strictEqual(w.memo.stats().keyChanges, 2);
    } finally {
      cleanup(w.dir);
    }
  });

  test("H16-4 vendor fallback without cache; fingerprint drift = all 5 wrappers call the original with the same arguments", () => {
    if (!haveSrc) return;
    const p = pair(1000);
    try {
      assert.strictEqual(p.exp.getRuntimeConfig().defaultCountryCode, "DE");
      writeJson(p.files.debug, { invalid: true });
      p.clock.t = 5000;
      assert.strictEqual(p.exp.getRuntimeConfig(), p.cfg, "fallback = the vendor config object");
      assert.strictEqual(p.exp.getRuntimeConfig(), p.cfg);
      assert.strictEqual(p.exp.normalizeCountryCode(undefined), "PL");
      assert.strictEqual(p.disk.snapshots, 2 + 3, "every call goes to the vendor, the fallback is not cached");
      const s = p.memo.stats();
      assert.deepStrictEqual([s.passthroughErrors, s.misses, s.hits], [3, 1, 0]);
    } finally {
      cleanup(p.dir);
    }
    for (const name of FUNCTIONS) {
      const tampered = gcText.replace(new RegExp(`^function ${name}\\(`, "m"), `function ${name}( `);
      const memo = createConfigSnapshotMemo({ revalidateMs: 0, log: () => {} });
      assert.deepStrictEqual(memo.checkSource(tampered), { ok: false, reason: `drift:${name}` });
      assert.strictEqual(memo.status().state, `disabled:drift:${name}`);
    }
    const calls = [];
    const record = (name) => {
      const fn = function () { calls.push([name, arguments.length, ...arguments]); return name; };
      Object.defineProperty(fn, "name", { value: name });
      return fn;
    };
    const spies = {};
    for (const name of FUNCTIONS) spies[name] = record(name);
    const memo = createConfigSnapshotMemo({ revalidateMs: 0, log: () => {} });
    memo.setVendorConfig({ getConfigStateSnapshot() { throw new Error("x"); } });
    assert.deepStrictEqual(memo.patchExports(spies), { ok: true });
    assert.deepStrictEqual(memo.checkSource(""), { ok: false, reason: "drift:getRuntimeConfig" });
    for (const name of FUNCTIONS) assert.strictEqual(spies[name](), name);
    spies.getRuntimeGlobalConfigValue("k");
    assert.deepStrictEqual(calls, [...FUNCTIONS.map((name) => [name, 0]), ["getRuntimeGlobalConfigValue", 1, "k"]]);
    assert.deepStrictEqual(Object.keys(CONFIG_SLOTS).sort(), FUNCTIONS.filter((n) => n !== "getRuntimeConfig").sort());
  });

  test("H16-6: fingerprint manager.loadState/readVersion (drift = disabled, loader does not wrap); clock moved back = stat; back-off after a snapshot exception", () => {
    if (!haveSrc) return;
    const managerText = fs.readFileSync(path.join(SERVER_SRC, "config", "manager.js"), "utf8");
    const fresh = () => createConfigSnapshotMemo({ revalidateMs: 0, log: () => {} });
    assert.deepStrictEqual(fresh().checkManagerSource(managerText), { ok: true });
    assert.deepStrictEqual(fresh().checkManagerSource(managerText.replace(/\r?\n/g, "\r\n")), { ok: true }, "CRLF");
    const addSource = managerText.replace("    const version = readVersion(errors);",
      "    const override = readJsonFile(legacyLocalConfigPath);\n    const version = readVersion(errors);");
    assert.notStrictEqual(addSource, managerText);
    const tamperVersion = managerText.replace("  function readVersion(errors) {\n", "  function readVersion(errors) {\n    readJsonFile(legacySharedConfigPath);\n")
      .replace("  function readVersion(errors) {\r\n", "  function readVersion(errors) {\r\n    readJsonFile(legacySharedConfigPath);\r\n");
    assert.notStrictEqual(tamperVersion, managerText);
    for (const [text, reason] of [[addSource, "drift:manager.loadState"], [tamperVersion, "drift:manager.readVersion"],
      ["", "drift:manager.loadState"]]) {
      const memo = fresh();
      assert.deepStrictEqual(memo.checkManagerSource(text), { ok: false, reason });
      assert.strictEqual(memo.status().state, `disabled:${reason}`);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath16-src-"));
    const dir = makeDir();
    try {
      const fakeGc = path.join(root, "services", "machoNet", "globalConfig.js");
      fs.mkdirSync(path.dirname(fakeGc), { recursive: true });
      fs.mkdirSync(path.join(root, "config"));
      fs.writeFileSync(fakeGc, gcText);
      fs.writeFileSync(path.join(root, "config", "manager.js"), addSource);
      const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
      const base = { ...config, ...quiet, prewarmLocations: false, schedulerMaxPending: 0, schedulerRequestTimeoutMs: 0 };
      const lines = [];
      const st = loader.createState({ ...base, configSnapshotMemo: true }, null, { log: (l) => lines.push(l) });
      const c = makeConfig(dir);
      const exp = loadVendor(gcText, fakeGc, c.cfg);
      const before = { ...exp };
      loader.patchTarget("vendorConfig", c.cfg, st, path.join(root, "config", "index.js"));
      loader.patchTarget("globalConfig", exp, st, fakeGc);
      for (const key of Object.keys(before)) assert.strictEqual(exp[key], before[key], `drift manager: ${key}`);
      assert.strictEqual(st.configMemo.status().state, "disabled:drift:manager.loadState");
      st.gameSeen = true;
      assert.ok(loader.probeMessage(st).includes("configSnapshotMemo disabled: drift:manager.loadState"), loader.probeMessage(st));
      assert.deepStrictEqual(lines, ["WARN configSnapshotMemo disabled: drift:manager.loadState"]);
    } finally {
      cleanup(root);
      cleanup(dir);
    }
    const p = pair(1000);
    try {
      p.clock.t = 5000;
      p.exp.getRuntimeConfig();
      atomicWrite(p.files.network, { pingMs: 7 });
      p.clock.t = 4000;
      assert.strictEqual(p.exp.getRuntimeConfig().pingMs, 7, "clock moved back = stat");
      assert.strictEqual(p.memo.stats().keyChanges, 1);
      p.clock.t = 4500;
      assert.strictEqual(p.exp.getRuntimeConfig().pingMs, 7);
      assert.strictEqual(p.memo.stats().hits, 1, "window counted from the new checkedAt");
    } finally {
      cleanup(p.dir);
    }
    const b = pair(1000);
    try {
      writeJson(b.files.debug, { invalid: true });
      assert.strictEqual(b.exp.getRuntimeConfig(), b.cfg, "vendor fallback");
      assert.strictEqual(b.disk.snapshots, 1);
      b.clock.t = 500;
      assert.strictEqual(b.exp.getRuntimeConfig(), b.cfg);
      assert.strictEqual(b.exp.normalizeCountryCode(undefined), "PL");
      assert.strictEqual(b.disk.snapshots, 3, "back-off: vendor read only");
      b.clock.t = 1000;
      assert.strictEqual(b.exp.getRuntimeConfig(), b.cfg);
      assert.strictEqual(b.disk.snapshots, 4, "after the window a new path attempt, no second read");
      writeJson(b.files.debug, {});
      b.clock.t = 2000;
      assert.strictEqual(b.exp.getRuntimeConfig().defaultCountryCode, "DE");
      b.exp.getRuntimeConfig();
      assert.strictEqual(b.disk.snapshots, 6, "fixed config: paths + read, then a hit");
      const s = b.memo.stats();
      assert.deepStrictEqual([s.passthroughErrors, s.misses, s.hits, s.state], [4, 1, 1, "cached"]);
    } finally {
      cleanup(b.dir);
    }
  });

  test("H16-5 flag off = exports untouched; config 3 keys + cap; loader wraps on first load, probe passed", () => {
    const cfgMod = require("../config");
    const def = cfgMod.loadConfig({ env: {}, settingsPath: MISSING });
    assert.deepStrictEqual([def.configSnapshotMemo, def.configSnapshotMemoRevalidateMs, def.configSnapshotMemoParityCheck,
      config.configSnapshotMemo], [false, 1000, false, false]);
    const warns = [];
    const env = cfgMod.loadConfig({ env: { HOTPATH_CONFIG_SNAPSHOT_MEMO: "1", HOTPATH_CONFIG_SNAPSHOT_MEMO_REVALIDATE_MS: "90000",
      HOTPATH_CONFIG_SNAPSHOT_MEMO_PARITY: "on" }, settingsPath: MISSING, warn: (m) => warns.push(m) });
    assert.deepStrictEqual([env.configSnapshotMemo, env.configSnapshotMemoRevalidateMs, env.configSnapshotMemoParityCheck], [true, 60000, true]);
    assert.deepStrictEqual(warns, ["WARN configSnapshotMemoRevalidateMs=90000 capped to 60000"]);
    const zero = cfgMod.loadConfig({ env: { HOTPATH_CONFIG_SNAPSHOT_MEMO_REVALIDATE_MS: "0" }, settingsPath: MISSING });
    assert.strictEqual(zero.configSnapshotMemoRevalidateMs, 0);
    assert.strictEqual(loader.targetOf("/app/server/src/services/machoNet/globalConfig.js"), "globalConfig");
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const base = { ...config, ...quiet, prewarmLocations: false, schedulerMaxPending: 0, schedulerRequestTimeoutMs: 0 };
    const offState = loader.createState(base, null);
    assert.strictEqual(offState.configMemo, null);
    assert.ok(!offState.requestPattern.test("../../services/machoNet/globalConfig"));
    if (!haveSrc) return;
    const dir = makeDir();
    try {
      const offCfg = makeConfig(dir);
      const offExp = loadVendor(gcText, gcFile, offCfg.cfg);
      const before = { ...offExp };
      loader.patchTarget("vendorConfig", offCfg.cfg, offState, path.join(SERVER_SRC, "config", "index.js"));
      loader.patchTarget("globalConfig", offExp, offState, gcFile);
      for (const key of Object.keys(before)) assert.strictEqual(offExp[key], before[key], `flag off: ${key}`);
      const lines = [];
      const onState = loader.createState({ ...base, configSnapshotMemo: true }, null, { log: (l) => lines.push(l) });
      assert.ok(onState.requestPattern.test("../../services/machoNet/globalConfig") && onState.requestPattern.test("/app/server/src/config"));
      const onCfg = makeConfig(dir);
      const onExp = loadVendor(gcText, gcFile, onCfg.cfg);
      loader.patchTarget("vendorConfig", onCfg.cfg, onState, path.join(SERVER_SRC, "config", "index.js"));
      loader.patchTarget("globalConfig", onExp, onState, gcFile);
      for (const symbol of loader.CONFIG_MEMO_REQUIRED) assert.ok(onState.patched.has(symbol), symbol);
      for (const name of FUNCTIONS) assert.ok(onExp[name][MARK], name);
      onExp.getRuntimeConfig();
      onExp.buildGlobalConfigDict();
      assert.strictEqual(onCfg.counters.snapshots, 2);
      onState.gameSeen = true;
      assert.strictEqual(loader.checkConfigMemoDrift(onState), false);
      assert.ok(/^probe: passed \(2 /.test(loader.probeMessage(onState)), loader.probeMessage(onState));
      assert.deepStrictEqual(lines, []);
    } finally {
      cleanup(dir);
    }
  });
}

module.exports = { register };
