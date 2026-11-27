"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { recordBoot, recordCleanStop, createRestartGuard } = require("../../lib/runtime/restartGuard");
const { createServiceRegistry } = require("../../lib/runtime/services");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const P = Object.freeze({ maxUncleanBoots: 3, windowMs: 1000, maxEntries: 5 });
const COMPOSE_SEARCH_MAX_DEPTH = 5;

function fakeFs(files = {}) {
  const calls = [];
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    files,
    calls,
    readFileSync(p) {
      calls.push(["read", p]);
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw enoent();
      return files[p];
    },
    writeFileSync(p, text) {
      calls.push(["write", p]);
      files[p] = String(text);
    },
    renameSync(a, b) {
      calls.push(["rename", a, b]);
      if (!Object.prototype.hasOwnProperty.call(files, a)) throw enoent();
      files[b] = files[a];
      delete files[a];
    },
    mkdirSync(p) {
      calls.push(["mkdir", p]);
    },
  };
}

function spyLogger() {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (m) => lines.push(String(m)), logError: (m) => errors.push(String(m)) };
}

function fakeAdapter() {
  return {
    getProbeReport: () => ({ counts: { ok: 1, drift: 0, missing: 0 }, disabledModules: {} }),
    getDisabledModules: () => ({}),
    registerShutdownHook: () => ({ ok: true, unregister() {} }),
  };
}

function bootAdapter(opts) {
  return {
    getProbeReport: () => ({ counts: { ok: 1, drift: opts.drift ? 1 : 0, missing: 0 }, disabledModules: {} }),
    getDisabledModules: () => (opts.drift ? { core: "gameStore.x" } : {}),
    registerShutdownHook: opts.noHook ? undefined : (_name, hook) => {
      opts.hook = hook;
      return { ok: true, unregister() { opts.hook = null; } };
    },
  };
}

function defs() {
  const ok = () => ({ ok: true });
  return [
    { name: "telemetry", module: null, probeGated: false, start: ok },
    { name: "world", module: null, probeGated: false, start: ok },
    { name: "alerts", module: null, probeGated: false, runsOnRefusal: true, start: ok },
    { name: "observer", module: null, probeGated: false, runsOnRefusal: true, start: ok },
  ];
}

function findCompose() {
  let dir = path.dirname(MOD_DIR);
  for (let i = 0; i < COMPOSE_SEARCH_MAX_DEPTH; i += 1) {
    const file = path.join(dir, "compose.yaml");
    if (fs.existsSync(file)) return file;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

module.exports = ({ test }) => {
  test("RG1 recordBoot/recordCleanStop: 2 unclean + boot 3 trips and latches, clean stop breaks the series, window, "
    + "maxEntries; edge: bad JSON -> .bad-<ms> without trip, flag off = 0 fsApi calls", () => {
    let r = recordBoot(null, 100, P);
    assert.deepStrictEqual([r.tripped, r.previousUnclean, r.streak], [false, null, 0]);
    r = recordBoot(r.file, 200, P);
    assert.deepStrictEqual([r.tripped, r.previousUnclean, r.streak], [false, true, 1]);
    r = recordBoot(r.file, 300, P);
    assert.deepStrictEqual([r.tripped, r.latched, r.streak, r.file.latched], [true, true, 2, true]);
    const again = recordBoot(r.file, 400, P);
    assert.deepStrictEqual([again.tripped, again.file.boots.length], [true, 3]);
    assert.strictEqual(recordCleanStop(r.file, 450), r.file);

    let c = recordBoot(null, 100, P);
    c = recordBoot(recordCleanStop(c.file, 150), 200, P);
    assert.deepStrictEqual([c.previousUnclean, c.streak], [false, 0]);
    c = recordBoot(c.file, 300, P);
    assert.deepStrictEqual([c.tripped, c.streak], [false, 1]);
    const w = recordBoot(recordBoot(recordBoot(null, 100, P).file, 600, P).file, 1500, P);
    assert.deepStrictEqual([w.tripped, w.streak], [false, 1]);
    let m = { v: 1, boots: [] };
    for (let i = 1; i <= 7; i += 1) m = recordBoot(recordCleanStop(m, i * 10 - 1), i * 10, P).file;
    assert.deepStrictEqual(m.boots.map((b) => b.atMs), [30, 40, 50, 60, 70]);

    const dir = path.join(os.tmpdir(), "lne-rg1-data");
    const file = path.join(dir, "runtime", "boots.json");
    const bad = fakeFs({ [file]: "{not json" });
    const settings = { enabled: true, ...P };
    const g = createRestartGuard({ fsApi: bad, dir, modDir: MOD_DIR, wallNow: () => 5000, settings });
    const b = g.onBoot();
    assert.deepStrictEqual([b.ok, b.tripped, b.previousUnclean], [true, false, null]);
    assert.strictEqual(bad.files[`${file}.bad-5000`], "{not json");
    assert.deepStrictEqual(JSON.parse(bad.files[file]).boots, [{ atMs: 5000, cleanStopAtMs: null }]);
    assert.deepStrictEqual(g.onCleanStop(), { ok: true });
    assert.strictEqual(JSON.parse(bad.files[file]).boots[0].cleanStopAtMs, 5000);
    const foreign = fakeFs({ [file]: JSON.stringify({ v: 2, boots: [] }) });
    assert.strictEqual(createRestartGuard({ fsApi: foreign, dir, modDir: MOD_DIR, wallNow: () => 7, settings })
      .onBoot().ok, true);
    assert.ok(Object.prototype.hasOwnProperty.call(foreign.files, `${file}.bad-7`));

    const off = fakeFs();
    const go = createRestartGuard({ fsApi: off, dir, modDir: MOD_DIR, settings: { ...settings, enabled: false } });
    assert.deepStrictEqual([go.onBoot(), go.onCleanStop().ok, off.calls], [{ ok: false, reason: "disabled_by_config" },
      false, []]);
    const inMod = createRestartGuard({ fsApi: fakeFs(), dir: MOD_DIR, modDir: MOD_DIR, settings }).onBoot();
    assert.deepStrictEqual(inMod, { ok: false, reason: "GUARD_DIR_IN_MOD_DIR" });
    const broken = fakeFs();
    broken.readFileSync = () => { throw Object.assign(new Error("x"), { code: "EACCES" }); };
    assert.deepStrictEqual(createRestartGuard({ fsApi: broken, dir, modDir: MOD_DIR, settings }).onBoot(),
      { ok: false, reason: "GUARD_IO_FAILED", detail: "EACCES" });
  });

  test("RG2 registry: latched guard -> crash_loop_guard, only observer+alerts running; GUARD_IO_FAILED -> normal "
    + "start; clean stop closes the series; real guard trips on the 3rd start", () => {
    const config = { enabled: true, dataDir: path.join(os.tmpdir(), "lne-never-written"), modules: {} };
    let cleanStops = 0;
    const tripped = { onBoot: () => ({ ok: true, tripped: true, previousUnclean: true, streak: 2, file: "/d/boots.json" }),
      onCleanStop: () => { cleanStops += 1; }, getStatus: () => ({ tripped: true }) };
    const logger = spyLogger();
    const reg = createServiceRegistry({ logger, defs: defs(), restartGuard: tripped });
    const ctx = { config, adapter: fakeAdapter(), modDir: MOD_DIR };
    const r = reg.startAll(ctx);
    assert.deepStrictEqual([r.ok, r.reason], [false, "crash_loop_guard"]);
    assert.deepStrictEqual(reg.getStatus().services.map((s) => [s.name, s.state, s.reason]), [
      ["telemetry", "disabled", "crash_loop_guard"], ["world", "disabled", "crash_loop_guard"],
      ["alerts", "running", null], ["observer", "running", null]]);
    assert.strictEqual(ctx.restartGuard, tripped);
    assert.ok(logger.lines.includes("services not started - crash_loop_guard (3 starts without a clean stop; "
      + "reset: delete /d/boots.json)"), logger.lines.join("\n"));
    reg.stopAll("shutdown:SIGTERM");
    assert.strictEqual(cleanStops, 0, "a refusal never writes a clean stop");

    const failing = { onBoot: () => ({ ok: false, reason: "GUARD_IO_FAILED", detail: "EROFS" }),
      onCleanStop: () => { cleanStops += 1; }, getStatus: () => ({}) };
    const log2 = spyLogger();
    const reg2 = createServiceRegistry({ logger: log2, defs: defs(), restartGuard: failing });
    assert.strictEqual(reg2.startAll({ config, adapter: fakeAdapter(), modDir: MOD_DIR }).ok, true);
    assert.ok(reg2.getStatus().services.every((s) => s.state === "running"));
    assert.ok(log2.lines.includes("services: restart guard unavailable - GUARD_IO_FAILED (EROFS); starting without it"));
    reg2.stopAll("shutdown:SIGTERM");
    assert.strictEqual(cleanStops, 1);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rg2-"));
    try {
      const real = resolveConfig({ modDir: MOD_DIR, settings: {}, envFile: {},
        env: { EVEJS_DATA_ROOT: root, EVEJS_LNE_RESTART_GUARD_ENABLED: "1" } });
      assert.deepStrictEqual(real.warnings, []);
      const boot = () => createServiceRegistry({ logger: spyLogger(), defs: defs() })
        .startAll({ config: { ...real.config, enabled: true }, adapter: fakeAdapter(), modDir: MOD_DIR });
      const clean = createServiceRegistry({ logger: spyLogger(), defs: defs() });
      assert.strictEqual(clean.startAll({ config: { ...real.config, enabled: true }, adapter: fakeAdapter(),
        modDir: MOD_DIR }).ok, true);
      clean.stopAll("shutdown:SIGTERM");
      assert.deepStrictEqual([boot().ok, boot().ok, boot().reason], [true, true, "crash_loop_guard"]);
      const file = path.join(real.config.dataDir, "runtime", "boots.json");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepStrictEqual([saved.latched, saved.boots.length, saved.boots[0].cleanStopAtMs !== null],
        [true, 4, true]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("RG4 registry order: core drift x3 never latches, the start after the fix is ok; no shutdown "
    + "hook = start not counted; a latched guard drops the hook", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rg4-"));
    try {
      const real = resolveConfig({ modDir: MOD_DIR, settings: {}, envFile: {},
        env: { EVEJS_DATA_ROOT: root, EVEJS_LNE_RESTART_GUARD_ENABLED: "1" } });
      const file = path.join(real.config.dataDir, "runtime", "boots.json");
      const boot = (opts, logger = spyLogger()) => {
        const r = createServiceRegistry({ logger, defs: defs() })
          .startAll({ config: { ...real.config, enabled: true }, adapter: bootAdapter(opts), modDir: MOD_DIR });
        if (opts.hook) opts.hook("SIGTERM");
        return r.ok ? "ok" : r.reason;
      };
      const drift = { drift: true };
      assert.deepStrictEqual([boot(drift), boot(drift), boot(drift)],
        ["probe_core_drift", "probe_core_drift", "probe_core_drift"]);
      assert.strictEqual(fs.existsSync(file), false, "a core refusal is not counted");
      drift.drift = false;
      assert.strictEqual(boot(drift), "ok");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepStrictEqual([saved.latched, saved.boots.length, saved.boots[0].cleanStopAtMs !== null],
        [undefined, 1, true]);
      fs.rmSync(file);

      const logger = spyLogger();
      const noHook = { noHook: true };
      assert.deepStrictEqual([boot(noHook, logger), boot(noHook, logger), boot(noHook, logger), boot(noHook, logger)],
        ["ok", "ok", "ok", "ok"]);
      assert.strictEqual(fs.existsSync(file), false);
      assert.strictEqual(logger.lines.filter((l) => l === "services: restart guard - start not counted (no shutdown "
        + "hook)").length, 4, logger.lines.join("\n"));

      const crash = () => {
        const opts = {};
        createServiceRegistry({ logger: spyLogger(), defs: defs() })
          .startAll({ config: { ...real.config, enabled: true }, adapter: bootAdapter(opts), modDir: MOD_DIR });
        return opts;
      };
      assert.ok(crash().hook && crash().hook);
      const third = crash();
      assert.strictEqual(third.hook, null, "the latched refusal unregistered the hook");
      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).latched, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("RG3 compose.yaml server block: restart no by default, json-file 50m x 5, guard flag :-0", () => {
    const file = findCompose();
    if (file === null) {
      assert.ok(MOD_DIR.startsWith("/app/"), "compose.yaml not found above the mod directory");
      return;
    }
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const start = text.indexOf("\n  server:\n");
    assert.ok(start >= 0, "compose.yaml has a server service");
    const next = text.slice(start + 1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    const block = next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
    for (const line of ["    restart: \"${EVEJS_SERVER_RESTART:-no}\"", "      driver: json-file",
      "        max-size: \"${EVEJS_LOG_MAX_SIZE:-50m}\"", "        max-file: \"${EVEJS_LOG_MAX_FILE:-5}\"",
      "      EVEJS_LNE_RESTART_GUARD_ENABLED: ${EVEJS_LNE_RESTART_GUARD_ENABLED:-0}"]) {
      assert.ok(block.includes(`\n${line}\n`), `server block misses: ${line}`);
    }
  });
};
