"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { fork } = require("node:child_process");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const LIVE_SIM = path.join(MOD_DIR, "tools", "liveSim.js");
const PRELOAD = path.join(MOD_DIR, "tools", "liveSim", "sqliteShim", "preload.js");
const MS_PER_HOUR = 3600000;

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lne-livesim-${name}-`));
}

function rmQuiet(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (_err) {
  }
}

const OPTS = Object.freeze({ speed: 10, offline: "capped", offlineHours: null, offlineMaxHours: 6, anchorEveryS: 5 });

function writeMiniSde(dir) {
  const name = (en) => ({ en });
  const pos = (x) => ({ x: x * 1e16, y: 0, z: 0 });
  const lines = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "mapRegions.jsonl"), lines([{ _key: 10000001, name: name("Mini Region"),
    factionID: 500001 }]));
  fs.writeFileSync(path.join(dir, "mapConstellations.jsonl"), lines([{ _key: 20000001, regionID: 10000001,
    name: name("Mini Constellation") }]));
  const systems = [[30000001, 0.9], [30000002, 0.5], [30000003, 0.2]].map(([id, sec], i) => ({ _key: id,
    constellationID: 20000001, regionID: 10000001, name: name(`Mini ${i + 1}`), position: pos(i), radius: 1e12,
    securityStatus: sec, securityClass: "B" }));
  fs.writeFileSync(path.join(dir, "mapSolarSystems.jsonl"), lines(systems));
  const gate = (key, from, to) => ({ _key: key, solarSystemID: from, destination: { solarSystemID: to } });
  fs.writeFileSync(path.join(dir, "mapStargates.jsonl"), lines([gate(50000001, 30000001, 30000002),
    gate(50000002, 30000002, 30000001), gate(50000003, 30000002, 30000003), gate(50000004, 30000003, 30000002)]));
  fs.writeFileSync(path.join(dir, "npcStations.jsonl"), lines([{ _key: 60000001, typeID: 1529, ownerID: 1000035,
    solarSystemID: 30000001, position: pos(0) }]));
  fs.writeFileSync(path.join(dir, "_sde.jsonl"), lines([{ _key: "sde", buildNumber: 1 }]));
}

function runChild(args, onLine) {
  return new Promise((resolve) => {
    const child = fork(LIVE_SIM, args, { execArgv: [...process.execArgv, "--disable-warning=ExperimentalWarning",
      "--require", PRELOAD], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const out = [];
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += String(chunk);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        out.push(line);
        if (onLine) onLine(line, child);
      }
    });
    child.stderr.on("data", (chunk) => out.push(`stderr: ${String(chunk).trim()}`));
    child.on("exit", (code, signal) => resolve({ code, signal, lines: out }));
  });
}

function get(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: 3000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", (err) => resolve(`error ${err.message}`));
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

module.exports = ({ test, skip, bench, benchEnabled }) => {
  const { resumeAnchor, createScaledClock, readAnchor, writeAnchor, wallIntervalOf, schedulerParity,
    ANCHOR_FILE } = require("../../tools/liveSim/clock");

  test("LSIM-T1 resumeAnchor: first start, capped (gap x old speed, cap), pause, --offline-hours", () => {
    const first = resumeAnchor(null, OPTS, 1000000);
    assert.deepStrictEqual({ v: first.anchor.virtualAt, w: first.anchor.wallAt, f: first.anchor.firstVirtualAt,
      r: first.anchor.runs, gap: first.gapMs }, { v: 1000000, w: 1000000, f: 1000000, r: 1, gap: 0 });
    const prev = { ...first.anchor, virtualAt: 5000000, wallAt: 2000000, speed: 20, runs: 3, cleanStop: false };
    const capped = resumeAnchor(prev, OPTS, 2060000);
    assert.strictEqual(capped.anchor.virtualAt, 5000000 + 60000 * 20);
    assert.strictEqual(capped.anchor.wallAt, 2060000);
    assert.strictEqual(capped.anchor.runs, 4);
    assert.strictEqual(capped.anchor.speed, 10);
    assert.strictEqual(capped.anchor.firstVirtualAt, 1000000);
    const long = resumeAnchor(prev, OPTS, 2000000 + 10 * MS_PER_HOUR);
    assert.strictEqual(long.anchor.virtualAt, 5000000 + 6 * MS_PER_HOUR);
    const pauseClean = resumeAnchor({ ...prev, cleanStop: true }, { ...OPTS, offline: "pause" }, 9000000);
    assert.strictEqual(pauseClean.anchor.virtualAt, 5000000);
    const pauseKill = resumeAnchor(prev, { ...OPTS, offline: "pause" }, 9000000);
    assert.strictEqual(pauseKill.anchor.virtualAt, 5000000 + 5000 * 20);
    const hours = resumeAnchor(prev, { ...OPTS, offlineHours: 2 }, 9000000);
    assert.strictEqual(hours.anchor.virtualAt, 5000000 + 2 * MS_PER_HOUR);
    const back = resumeAnchor(prev, OPTS, 1000);
    assert.ok(back.anchor.virtualAt >= prev.virtualAt);
    for (const r of [capped, long, pauseClean, pauseKill, hours, back]) assert.ok(r.anchor.virtualAt >= prev.virtualAt);
  });

  test("LSIM-T1 resumeAnchor after a kill: the window of the old run in every mode", () => {
    const first = resumeAnchor(null, { ...OPTS, anchorEveryS: 60 }, 1000000);
    assert.strictEqual(first.anchor.anchorEveryS, 60);
    const killed = { ...first.anchor, virtualAt: 5000000, wallAt: 2000000, speed: 20, cleanStop: false };
    const window = 60 * 1000 * 20;
    const now = 2000000 + 10;
    const cases = [["pause", { offline: "pause" }], ["hours 0", { offlineHours: 0 }],
      ["max-hours 0", { offlineMaxHours: 0 }], ["wall just after", {}]];
    for (const [label, o] of cases) {
      const r = resumeAnchor(killed, { ...OPTS, ...o }, now);
      assert.strictEqual(r.anchor.virtualAt, 5000000 + window, label);
      assert.strictEqual(r.anchor.anchorEveryS, 5, `${label}: the new run writes its own window`);
    }
    for (const [label, o] of cases.slice(0, 3)) {
      assert.strictEqual(resumeAnchor({ ...killed, cleanStop: true }, { ...OPTS, ...o }, now).anchor.virtualAt,
        5000000, label);
    }
    const { anchorEveryS, ...old } = killed;
    assert.strictEqual(anchorEveryS, 60);
    assert.strictEqual(resumeAnchor(old, { ...OPTS, offline: "pause" }, now).anchor.virtualAt, 5000000 + 5000 * 20);
  });

  test("LSIM-T1 resumeAnchor: pendingVirtualAt (kill in startAll) and maxWriteGapS (late write)", () => {
    const first = resumeAnchor(null, { ...OPTS, anchorEveryS: 60 }, 1000000).anchor;
    const clean = { ...first, virtualAt: 5000000, wallAt: 2000000, speed: 20, cleanStop: true };
    const window = 60 * 1000 * 20;
    const pending = resumeAnchor({ ...clean, pendingVirtualAt: 7000000 }, { ...OPTS, offline: "pause" }, 2000010);
    assert.strictEqual(pending.anchor.virtualAt, 7000000 + window, "clean stop + pending = killed from pending");
    assert.strictEqual(resumeAnchor({ ...clean, pendingVirtualAt: 5000000 }, { ...OPTS, offline: "pause" }, 2000010)
      .anchor.virtualAt, 5000000 + window, "pause: pending === virtualAt -> killed");
    assert.strictEqual(resumeAnchor({ ...clean, pendingVirtualAt: 5000000 }, { ...OPTS, offlineHours: 0 }, 2000010)
      .anchor.virtualAt, 5000000 + window, "--offline-hours 0: pending === virtualAt -> killed");
    assert.strictEqual(resumeAnchor({ ...clean, pendingVirtualAt: 4000000 }, { ...OPTS, offline: "pause" }, 2000010)
      .anchor.virtualAt, 5000000 + window, "pending < virtualAt -> base virtualAt");
    const gap = resumeAnchor({ ...clean, cleanStop: false, maxWriteGapS: 90 }, { ...OPTS, offline: "pause" }, 2000010);
    assert.strictEqual(gap.anchor.virtualAt, 5000000 + 90 * 1000 * 20, "the window is maxWriteGapS > anchorEveryS");
    const small = resumeAnchor({ ...clean, cleanStop: false, maxWriteGapS: 3 }, { ...OPTS, offline: "pause" }, 2000010);
    assert.strictEqual(small.anchor.virtualAt, 5000000 + window);
    for (const r of [pending, gap]) {
      assert.deepStrictEqual(["pendingVirtualAt" in r.anchor, "maxWriteGapS" in r.anchor], [false, false]);
    }
    const dir = tmpDir("anchor-pending");
    try {
      for (const [field, value] of [["pendingVirtualAt", "x"], ["maxWriteGapS", -1], ["maxWriteGapS", "5"]]) {
        fs.writeFileSync(path.join(dir, ANCHOR_FILE), JSON.stringify({ ...clean, [field]: value }));
        const r = readAnchor(dir);
        assert.deepStrictEqual([r.ok, r.reason], [false, "ANCHOR_INVALID"], `${field}=${value}`);
        assert.ok(r.detail.endsWith(`bad ${field}`), r.detail);
      }
      fs.writeFileSync(path.join(dir, ANCHOR_FILE), JSON.stringify({ ...clean, pendingVirtualAt: 7000000, maxWriteGapS: 4 }));
      assert.strictEqual(readAnchor(dir).ok, true);
    } finally {
      rmQuiet(dir);
    }
  });

  test("LSIM-T8 parseComposeEnv: defaults, fixed values, other prefixes skipped, unknown shapes refused", () => {
    const { parseComposeEnv, compareWithSchema } = require("../../tools/liveSim/compose");
    const head = "name: x\n\nservices:\n  init:\n    image: a\n    environment:\n      OTHER: 1\n  server:\n"
      + "    image: b\n    depends_on:\n      market:\n        condition: ok\n    environment:\n";
    const tail = "    ports:\n      - \"1:1\"\n\nvolumes:\n  data:\n";
    const ok = parseComposeEnv(`${head}`
      + "      EVEJS_URL: \"${EVEJS_URL:-http://h:${EVEJS_PORT:-1}/}\"\n"
      + "      # EVEJS_LNE_COMMENTED: ${EVEJS_LNE_COMMENTED:-9}\n"
      + "      EVEJS_LNE_RETENTION_ENABLED: ${EVEJS_LNE_RETENTION_ENABLED:-1}\r\n"
      + "      EVEJS_LNE_HUNT_ENABLED: \"${EVEJS_LNE_HUNT_ENABLED:-0}\"  # a comment\n"
      + "      EVEJS_LNE_OBSERVER_HOST: 0.0.0.0\n"
      + "      EVEJS_LNE_OBSERVER_MAX_STALE_MS: '7000'\n"
      + "      EVEJS_LNE_ALERTS_WEBHOOK_URL: ${EVEJS_LNE_ALERTS_WEBHOOK_URL:-}\n"
      + `${tail}`);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.deepStrictEqual([ok.service, ok.keys, ok.fixed], ["server", 5, 2]);
    assert.deepStrictEqual(ok.values, { EVEJS_LNE_RETENTION_ENABLED: "1", EVEJS_LNE_HUNT_ENABLED: "0",
      EVEJS_LNE_OBSERVER_HOST: "0.0.0.0", EVEJS_LNE_OBSERVER_MAX_STALE_MS: "7000" });
    assert.deepStrictEqual(ok.entries.map((e) => [e.name, e.value, e.fixed]), [
      ["EVEJS_LNE_RETENTION_ENABLED", "1", false], ["EVEJS_LNE_HUNT_ENABLED", "0", false],
      ["EVEJS_LNE_OBSERVER_HOST", "0.0.0.0", true], ["EVEJS_LNE_OBSERVER_MAX_STALE_MS", "7000", true],
      ["EVEJS_LNE_ALERTS_WEBHOOK_URL", "", false]]);
    const cmp =compareWithSchema({ ...ok.values, EVEJS_LNE_NO_SUCH: "1",
      EVEJS_LNE_RETENTION_MAX_SCAN_ROWS_PER_PASS: "x" });
    assert.ok(cmp.differ.includes("retention.enabled") && cmp.differ.includes("hunt.enabled"), cmp.differ.join());
    assert.deepStrictEqual(cmp.unknown, ["EVEJS_LNE_NO_SUCH"]);
    assert.deepStrictEqual(cmp.invalid, ["EVEJS_LNE_RETENTION_MAX_SCAN_ROWS_PER_PASS"]);
    const bad = [
      ["      EVEJS_LNE_HUNT_ENABLED: ${EVEJS_LNE_HUNT_ENABLED}\n", "is not ${EVEJS_LNE_HUNT_ENABLED:-default}"],
      ["      EVEJS_LNE_HUNT_ENABLED: ${EVEJS_LNE_HUNT_ENABLED-0}\n", "is not"],
      ["      EVEJS_LNE_HUNT_ENABLED: ${EVEJS_LNE_OTHER:-0}\n", "is not"],
      ["      EVEJS_LNE_HUNT_ENABLED: ${EVEJS_LNE_HUNT_ENABLED:-${X:-1}}\n", "is not"],
      ["      EVEJS_LNE_HUNT_ENABLED:\n", "empty value"],
      ["      EVEJS_LNE_HUNT_ENABLED: \"0\n", "quoted value"],
      ["      - EVEJS_LNE_HUNT_ENABLED=0\n", "list form"],
      ["      EVEJS_LNE_HUNT_ENABLED: 0\n      EVEJS_LNE_HUNT_ENABLED: 1\n", "twice"],
    ];
    for (const [line, detail] of bad) {
      const r = parseComposeEnv(`${head}${line}${tail}`);
      assert.deepStrictEqual([r.ok, r.reason], [false, "ARGS_INVALID"], line);
      assert.ok(r.detail.includes(detail) && /compose line \d+/.test(r.detail), `${line} -> ${r.detail}`);
    }
    const flow = parseComposeEnv("services:\n  server:\n    environment: { EVEJS_LNE_HUNT_ENABLED: 0 }\n");
    assert.ok(!flow.ok && flow.detail.includes("flow form"), flow.detail);
    const two = parseComposeEnv("services:\n  a:\n    environment:\n      EVEJS_LNE_HUNT_ENABLED: 0\n"
      + "  b:\n    environment:\n      EVEJS_LNE_HUNT_ENABLED: 1\n");
    assert.ok(!two.ok && two.detail.includes("more than one service (a, b)"), two.detail);
    const none = parseComposeEnv(`${head}      OTHER: 2\n${tail}`);
    assert.ok(!none.ok && none.detail.includes("no service"), none.detail);
    assert.strictEqual(parseComposeEnv("x: 1\n").ok, false);
    const real = parseComposeEnv(fs.readFileSync(path.join(MOD_DIR, "..", "..", "compose.yaml"), "utf8"));
    assert.strictEqual(real.ok, true, JSON.stringify(real));
    assert.strictEqual(real.service, "server");
    assert.ok(real.keys > 100, `keys ${real.keys}`);
    assert.strictEqual(real.values.EVEJS_LNE_RETENTION_ENABLED, "1");
    assert.deepStrictEqual(compareWithSchema(real.values).unknown, []);
  });

  test("LSIM-T9 layers: SCHEMA < --settings < compose < --env-file < --set; no compose = one warning line", () => {
    const { buildLiveConfig } = require("../../tools/liveSim/profile");
    const { composeLines } = require("../../tools/liveSim");
    const { SCHEMA } = require("../../config");
    const dir = tmpDir("layers");
    try {
      const settings = path.join(dir, "settings.json");
      fs.writeFileSync(settings, JSON.stringify({ observer: { maxStaleMs: 1000 }, retention: { maxScanRowsPerPass: 77 } }));
      const envFile = path.join(dir, "copy.env");
      fs.writeFileSync(envFile, "EVEJS_LNE_OBSERVER_MAX_STALE_MS=3000\n");
      const composeEnv = { EVEJS_LNE_OBSERVER_MAX_STALE_MS: "2000", EVEJS_LNE_RETENTION_ENABLED: "1" };
      const stale = (opts) => {
        const r = buildLiveConfig({ set: {}, envFile: null, settings: null, port: null, ...opts }, { dataDir: dir });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return [r.config.observer.maxStaleMs, r.config.retention.enabled];
      };
      const schemaRetention = SCHEMA.find((x) => x.key === "retention.enabled").default;
      assert.strictEqual(schemaRetention, false);
      assert.deepStrictEqual(stale({ settings }), [1000, false]);
      assert.deepStrictEqual(stale({ settings, composeEnv }), [2000, true]);
      assert.deepStrictEqual(stale({ settings, composeEnv, envFile }), [3000, true]);
      assert.deepStrictEqual(stale({ settings, composeEnv, envFile, set: { "observer.maxStaleMs": "4000" } }), [4000, true]);
      fs.writeFileSync(envFile, "EVEJS_LNE_RETENTION_ENABLED=0\n");
      assert.deepStrictEqual(stale({ composeEnv, envFile }), [2000, false]);
      const r = buildLiveConfig({ set: {}, envFile: null, settings, port: null,
        composeEnv: { EVEJS_LNE_OBSERVER_MAX_STALE_MS: "abc" } }, { dataDir: dir });
      assert.strictEqual(r.config.observer.maxStaleMs, 1000);
      assert.ok(r.warnings.some((w) => w.startsWith("EVEJS_LNE_OBSERVER_MAX_STALE_MS=")), r.warnings.join("\n"));
      assert.strictEqual(r.config.retention.maxScanRowsPerPass, 77);
      const noCompose = composeLines({ ok: true, file: null, parsed: null });
      assert.strictEqual(noCompose.length, 1);
      assert.ok(noCompose[0].startsWith("liveSim: warning - config without compose defaults"), noCompose[0]);
      const withCompose = composeLines({ ok: true, file: "c.yaml", parsed: { service: "server", keys: 3, fixed: 0,
        values: composeEnv } });
      assert.deepStrictEqual(withCompose, ["liveSim: compose defaults 2 keys from service server (3 entries, 0 fixed, "
        + "1 empty) - 2 differ from SCHEMA - c.yaml"]);
    } finally {
      rmQuiet(dir);
    }
  });

  test("LSIM-T9b --compose + --env-file as on Docker: interpolated entry, fixed entry, keys outside compose skipped "
    + "", () => {
    const { buildLiveConfig } = require("../../tools/liveSim/profile");
    const { parseComposeEnv } = require("../../tools/liveSim/compose");
    const { SCHEMA } = require("../../config");
    const dir = tmpDir("docker-env");
    try {
      const parsed = parseComposeEnv("services:\n  server:\n    environment:\n"
        + "      EVEJS_LNE_RETENTION_ENABLED: ${EVEJS_LNE_RETENTION_ENABLED:-1}\n"
        + "      EVEJS_LNE_OBSERVER_MAX_STALE_MS: \"2000\"\n");
      assert.strictEqual(parsed.ok, true, JSON.stringify(parsed));
      const envFile = path.join(dir, "root.env");
      fs.writeFileSync(envFile, "EVEJS_LNE_RETENTION_ENABLED=\nEVEJS_LNE_OBSERVER_MAX_STALE_MS=3000\n"
        + "EVEJS_LNE_SCHEDULER_INTERVAL_MS=5000\nEVEJS_LNE_HUNT_ENABLED=0\nOTHER_KEY=1\n");
      const run = (set) => {
        const r = buildLiveConfig({ set, envFile, settings: null, port: null, composeEnv: parsed.values,
          composeEntries: parsed.entries }, { dataDir: dir });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r;
      };
      const r = run({});
      assert.strictEqual(r.config.retention.enabled, true, "an empty env-file value keeps the compose default");
      assert.strictEqual(r.config.observer.maxStaleMs, 2000, "a fixed compose value wins over the env file");
      assert.strictEqual(r.config.scheduler.intervalMs, SCHEMA.find((x) => x.key === "scheduler.intervalMs").default);
      assert.strictEqual(r.config.hunt.enabled, true);
      const skipped = r.warnings.filter((w) => w.startsWith("env-file: ") && w.includes("outside compose"));
      assert.deepStrictEqual(skipped, ["env-file: 2 EVEJS_LNE_* keys outside compose environment: skipped as on Docker "
        + "(EVEJS_LNE_HUNT_ENABLED, EVEJS_LNE_SCHEDULER_INTERVAL_MS)"]);
      const fixed = r.warnings.filter((w) => w.startsWith("env-file: ") && w.includes("fixed in compose"));
      assert.deepStrictEqual(fixed, ["env-file: 1 keys fixed in compose: compose value kept as on Docker "
        + "(EVEJS_LNE_OBSERVER_MAX_STALE_MS)"]);
      const s = run({ "hunt.enabled": "false" });
      assert.strictEqual(s.config.hunt.enabled, false);
      assert.deepStrictEqual(s.warnings.filter((w) => w.includes("outside compose")), ["env-file: 1 EVEJS_LNE_* keys "
        + "outside compose environment: skipped as on Docker (EVEJS_LNE_SCHEDULER_INTERVAL_MS)"]);
    } finally {
      rmQuiet(dir);
    }
  });

  test("LSIM-T1 createScaledClock: +1000 wall ms at speed 10 -> +10000 virtual ms; anchor file round trip", () => {
    let wall = 500000;
    const clock = createScaledClock({ anchor: { virtualAt: 9000000, wallAt: 500000 }, speed: 10, wallNow: () => wall });
    assert.strictEqual(clock.now(), 9000000);
    wall += 1000;
    assert.strictEqual(clock.now(), 9010000);
    assert.strictEqual(clock.timeScale, 1);
    assert.strictEqual(clock.travelDurationMs(60000, { observed: false }), 60000);
    const dir = tmpDir("anchor");
    try {
      assert.deepStrictEqual(readAnchor(dir), { ok: true, anchor: null });
      const a = resumeAnchor(null, OPTS, 1000).anchor;
      assert.strictEqual(writeAnchor(dir, a).ok, true);
      assert.strictEqual(readAnchor(dir).anchor.virtualAt, 1000);
      fs.writeFileSync(path.join(dir, ANCHOR_FILE), JSON.stringify({ ...a, schema: 2 }));
      assert.strictEqual(readAnchor(dir).reason, "ANCHOR_INVALID");
      fs.writeFileSync(path.join(dir, ANCHOR_FILE), "{not json");
      assert.strictEqual(readAnchor(dir).reason, "ANCHOR_INVALID");
    } finally {
      rmQuiet(dir);
    }
  });

  test("LSIM-T2 buildLiveConfig: forced values with one line each, process.env ignored, SCHEMA rows", () => {
    const { buildLiveConfig, dangerModuleKeys, FORCED_OFF, FEATURE_OFF, SEAMLESS_OFF } = require("../../tools/liveSim/profile");
    const { SCHEMA } = require("../../config");
    const { BENCH_EXCLUSIONS } = require("../../tools/benchCampaign");
    const dir = tmpDir("cfg");
    const saved = process.env.EVEJS_LNE_SCHEDULER_INTERVAL_MS;
    try {
      const envFile = path.join(dir, "copy.env");
      fs.writeFileSync(envFile, "EVEJS_LNE_TEST_ACCELERATION=1\nEVEJS_LNE_ALERTS_ENABLED=1\n");
      process.env.EVEJS_LNE_SCHEDULER_INTERVAL_MS = "5000";
      const r = buildLiveConfig({ set: { "observer.host": "0.0.0.0", "modules.materialization.enabled": "1" },
        envFile, settings: null, port: null }, { dataDir: dir });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.config.observer.host, "127.0.0.1");
      assert.strictEqual(r.config.observer.port, SCHEMA.find((x) => x.key === "observer.port").default);
      assert.strictEqual(r.config.modules.materialization.enabled, false);
      assert.strictEqual(r.config.testing.accelerationEnabled, false);
      assert.strictEqual(r.config.alerts.enabled, false);
      assert.strictEqual(r.config.dataDir, path.resolve(dir));
      assert.strictEqual(r.config.scheduler.intervalMs, 1000, "process.env is not a layer");
      for (const key of ["observer.host=127.0.0.1", "modules.materialization.enabled=false",
        "testing.accelerationEnabled=false", "alerts.enabled=false"]) {
        assert.strictEqual(r.forced.filter((l) => l.startsWith(`liveSim: forced ${key} (`)).length, 1, key);
      }
      assert.deepStrictEqual(SEAMLESS_OFF.map((x) => x.key), ["world.beltNavy.standingAggroEnabled",
        "playerSiege.enabled", "sentries.enabled"]);
      assert.deepStrictEqual([r.config.world.beltNavy.standingAggroEnabled, r.config.playerSiege.enabled,
        r.config.sentries.enabled], [false, false, false]);
      for (const row of SEAMLESS_OFF) {
        assert.strictEqual(r.forced.filter((l) => l.startsWith(`liveSim: forced ${row.key}=false (`)).length, 1, row.key);
      }
      assert.strictEqual(r.forced.some((l) => l.includes("modules.sites.enabled")), false);
      assert.strictEqual(r.configResult.config, r.config);
      const unknown = buildLiveConfig({ set: { "no.such.key": "1" } }, { dataDir: dir });
      assert.deepStrictEqual([unknown.ok, unknown.reason], [false, "CONFIG_UNKNOWN_KEY"]);
      const invalid = buildLiveConfig({ set: {} }, { dataDir: dir,
        loadConfigFn: () => ({ ok: false, errors: ["settings.json: bad", "x"] }) });
      assert.deepStrictEqual([invalid.ok, invalid.reason, invalid.detail], [false, "CONFIG_INVALID", "settings.json: bad; x"]);
    } finally {
      if (saved === undefined) delete process.env.EVEJS_LNE_SCHEDULER_INTERVAL_MS;
      else process.env.EVEJS_LNE_SCHEDULER_INTERVAL_MS = saved;
      rmQuiet(dir);
    }
    for (const row of [...FORCED_OFF, ...FEATURE_OFF, ...SEAMLESS_OFF]) {
      const s = SCHEMA.find((x) => x.key === row.key);
      assert.ok(s && s.type === "boolean", `${row.key} is a boolean SCHEMA row`);
      assert.ok(row.reason.length > 0);
    }
    const danger = dangerModuleKeys();
    assert.strictEqual(danger.length, 6);
    for (const key of danger) assert.ok(BENCH_EXCLUSIONS.has(key.split(".")[1]), key);
  });

  test("LSIM-T3 prepareDataDir: server folder and unmarked folder refused, --reset only with the marker", () => {
    const { prepareDataDir } = require("../../tools/liveSim/dataDir");
    const { resolveDataDir } = require("../../config");
    const server = prepareDataDir({ dataDir: resolveDataDir({}, MOD_DIR), reset: false });
    assert.deepStrictEqual([server.ok, server.reason], [false, "DATA_DIR_REFUSED"]);
    const root = tmpDir("data");
    const envServer = prepareDataDir({ dataDir: resolveDataDir({ EVEJS_DATA_ROOT: root }, MOD_DIR), reset: false },
      { env: { EVEJS_DATA_ROOT: root } });
    assert.strictEqual(envServer.reason, "DATA_DIR_REFUSED");
    const inMod = prepareDataDir({ dataDir: path.join(MOD_DIR, "liveSimData"), reset: false });
    assert.strictEqual(inMod.reason, "DATA_DIR_REFUSED");
    try {
      const foreign = path.join(root, "foreign");
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(foreign, "keep.sqlite"), "x");
      for (const reset of [false, true]) {
        const r = prepareDataDir({ dataDir: foreign, reset });
        assert.deepStrictEqual([r.ok, r.reason], [false, "DATA_DIR_REFUSED"]);
      }
      assert.ok(fs.existsSync(path.join(foreign, "keep.sqlite")), "never deleted without the marker");
      const fresh = prepareDataDir({ dataDir: path.join(root, "new"), reset: false });
      assert.deepStrictEqual([fresh.ok, fresh.fresh], [true, true]);
      const marked = path.join(root, "new");
      fs.writeFileSync(path.join(marked, ANCHOR_FILE), "{}");
      fs.writeFileSync(path.join(marked, "world.sqlite"), "x");
      const kept = prepareDataDir({ dataDir: marked, reset: false });
      assert.deepStrictEqual([kept.ok, kept.fresh], [true, false]);
      assert.ok(fs.existsSync(path.join(marked, "world.sqlite")));
      const reset = prepareDataDir({ dataDir: marked, reset: true });
      assert.deepStrictEqual([reset.ok, reset.fresh, reset.reset], [true, true, true]);
      assert.deepStrictEqual(fs.readdirSync(marked), []);
    } finally {
      rmQuiet(root);
    }
  });

  test("LSIM-T4 createShutdownHooks: order, duplicate refused, a throwing hook does not stop the next, one run", async () => {
    const { createShutdownHooks } = require("../../tools/liveSim/shutdown");
    const { registerShutdown } = require("../../lib/adapter/gameStoreHooks");
    const hooks = createShutdownHooks({ timeoutMs: 1000 });
    const calls = [];
    assert.strictEqual(registerShutdown(hooks.gameStoreLike, "a", (sig) => calls.push(`a:${sig}`)).ok, true);
    assert.strictEqual(registerShutdown(hooks.gameStoreLike, "b", () => {
      calls.push("b");
      throw new Error("boom");
    }).ok, true);
    const c = registerShutdown(hooks.gameStoreLike, "c", async () => calls.push("c"));
    assert.strictEqual(c.ok, true);
    const dup = registerShutdown(hooks.gameStoreLike, "a", () => null);
    assert.deepStrictEqual([dup.ok, dup.reason], [false, "SHUTDOWN_HOOK_REJECTED"]);
    assert.strictEqual(registerShutdown(hooks.gameStoreLike, " ", () => null).reason, "SHUTDOWN_HOOK_REJECTED");
    assert.strictEqual(hooks.size(), 3);
    const p1 = hooks.run("SIGINT");
    const p2 = hooks.run("SIGTERM");
    assert.strictEqual(p1, p2);
    const r = await p1;
    assert.deepStrictEqual(calls, ["a:SIGINT", "b", "c"]);
    assert.strictEqual(r.success, false);
    assert.deepStrictEqual(r.results.map((x) => [x.name, x.success]), [["a", true], ["b", false], ["c", true]]);
    assert.strictEqual(r.results[1].error, "boom");
    c.unregister();
    assert.strictEqual(hooks.size(), 2);
  });

  test("LSIM-T4 createLiveAdapter: keys of createAdapter, registerShutdownHook ok, BENCH_UNSUPPORTED counted", async () => {
    const { createLiveAdapter } = require("../../tools/liveSim/liveAdapter");
    const { createShutdownHooks } = require("../../tools/liveSim/shutdown");
    const { realAdapterMethodNames, BENCH_UNSUPPORTED } = require("../../tools/campaign/benchAdapter");
    const world = { worldData: { ensureLoaded: () => ({ solarSystems: [], stargates: [], stations: [] }),
      getStationByID: () => null }, asteroidData: { getBeltsForSystem: () => [] }, sdeBuild: 1 };
    const shutdown = createShutdownHooks();
    const live = createLiveAdapter({ world, driver: { ok: false, reason: "test" }, policy: null, band: null, shutdown });
    assert.deepStrictEqual(Object.keys(live.adapter).sort(), realAdapterMethodNames());
    let stopped = null;
    const hook = live.adapter.registerShutdownHook("services", (sig) => {
      stopped = sig;
    });
    assert.strictEqual(hook.ok, true);
    assert.strictEqual(live.adapter.registerShutdownHook("services", () => null).reason, "SHUTDOWN_HOOK_REJECTED");
    assert.strictEqual(live.adapter.readPresence({}), BENCH_UNSUPPORTED);
    live.adapter.readPresence({});
    assert.deepStrictEqual(live.adapter.readSdeBuild(), { ok: true, build: 1 });
    assert.strictEqual(live.adapter.getProcessRole(), "world");
    assert.deepStrictEqual(live.getUnsupported(), { readPresence: 2 });
    await shutdown.run("SIGINT");
    assert.strictEqual(stopped, "SIGINT");
    const statics = { ...world, statics: {}, worldData: { ...world.worldData,
      getStationsForSystem: (id) => (id === 30000142 ? [{ stationID: 60003760, corporationID: 1000035 }] : []) } };
    const pop = createLiveAdapter({ world: statics, driver: { ok: false, reason: "test" }, policy: null, band: null,
      shutdown: createShutdownHooks(), stationsFromStatics: true });
    const st = pop.adapter.listNpcStationsInSystem(30000142);
    assert.ok(st.ok === true && st.stations.length === 1 && st.stations[0].stationId === 60003760, JSON.stringify(st));
    assert.deepStrictEqual(pop.getUnsupported(), {});
    const off = createLiveAdapter({ world: statics, driver: { ok: false, reason: "test" }, policy: null, band: null,
      shutdown: createShutdownHooks(), stationsFromStatics: false });
    assert.deepStrictEqual(off.adapter.listNpcStationsInSystem(30000142), BENCH_UNSUPPORTED);
    assert.deepStrictEqual(off.getUnsupported(), { listNpcStationsInSystem: 1 });
  });

  test("LSIM-T5 boundary: loader.js and lib/** never require liveSim; scheduler pass timer parity", () => {
    const files = [path.join(MOD_DIR, "loader.js")];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) files.push(p);
      }
    };
    walk(path.join(MOD_DIR, "lib"));
    assert.ok(files.length > 100, `scanned ${files.length}`);
    const hits = files.filter((f) => {
      const text = fs.readFileSync(f, "utf8");
      return text.includes("tools/liveSim") || /require\s*\([^)]*liveSim/.test(text);
    }).map((f) => path.relative(MOD_DIR, f));
    assert.deepStrictEqual(hits, []);
    assert.strictEqual(wallIntervalOf(1000, 10), 100);
    assert.strictEqual(wallIntervalOf(1000, 100), 100);
    assert.strictEqual(wallIntervalOf(1000, 1), 1000);
    assert.strictEqual(schedulerParity(1000, 10).warning, false);
    assert.deepStrictEqual(schedulerParity(1000, 100), { wallMs: 100, parityLimit: 10, warning: true });
  });

  test("LSIM-T11 check timer terms and --checks-every-virtual-h", () => {
    const { nextCheckDelayMs, advanceCheckAt, MIN_CHECK_WALL_MS, MAX_TIMER_MS } = require("../../tools/liveSim/checks");
    const { parseArgs } = require("../../tools/liveSim/args");
    assert.strictEqual(MIN_CHECK_WALL_MS, 250);
    assert.strictEqual(MAX_TIMER_MS, 2147483647, "the setTimeout limit");
    assert.strictEqual(nextCheckDelayMs(1e12, 0, 1), MAX_TIMER_MS, "no setTimeout overflow");
    assert.strictEqual(nextCheckDelayMs(1000 + 36000, 1000, 100), 360, "virtual ms / speed");
    assert.strictEqual(nextCheckDelayMs(1000 + 36001, 1000, 100), 361, "ceil");
    assert.strictEqual(nextCheckDelayMs(1100, 1000, 10), 250, "the floor");
    assert.strictEqual(nextCheckDelayMs(500, 1000, 10), 250, "a past term");
    assert.strictEqual(advanceCheckAt(1000, 1500, 1000), 2000, "a normal step");
    assert.strictEqual(advanceCheckAt(1000, 2000, 1000), 3000, "next <= now -> now + every");
    assert.strictEqual(advanceCheckAt(1000, 5500, 1000), 6500, "skipped terms are gone, no series");
    assert.strictEqual(parseArgs([]).opts.checksEveryVirtualH, 24);
    assert.strictEqual(parseArgs(["--checks-every-virtual-h", "0"]).opts.checksEveryVirtualH, 0);
    assert.strictEqual(parseArgs(["--checks-every-virtual-h", "0.5"]).opts.checksEveryVirtualH, 0.5);
    const bad = parseArgs(["--checks-every-virtual-h", "-1"]);
    assert.deepStrictEqual([bad.ok, bad.reason], [false, "ARGS_INVALID"]);
  });

  const { loadDriver } = require("../../tools/benchScheduler");
  const driver = loadDriver();
  if (!driver.ok) {
    skip("LSIM-T10/T6 liveSim checks and smoke run", `SQLite driver unavailable (${driver.detail || driver.reason})`);
    return;
  }

  test("LSIM-T10 runLiveCheck: a capture without adjacency -> FAIL nonAdjacentCaptures, repaired -> PASS, "
    + "sovUnavailable from telemetry, no store -> ERROR", () => {
    const { runLiveCheck, takeCheckSnapshot, formatLiveCheck, checkRecord } = require("../../tools/liveSim/checks");
    const { seedDbFile } = require("../_support/dbTemplate");
    const { resolveConfig } = require("../../config");
    const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const config = { ...base, strategy: { ...base.strategy, maxCapturedSystemsPerFaction: 1000,
      captureRequiresAdjacency: true } };
    const dir = tmpDir("checks");
    const file = path.join(dir, "t.sqlite");
    seedDbFile(driver, file);
    const db = new driver.Database(file);
    try {
      const sys = db.prepare(`INSERT INTO world_system_state (system_id, security_class, controller_faction_id,
        occupation_state, threat_level, last_state_change_at, updated_at, version, occupier_faction_id, captured_at,
        home_faction_id) VALUES (?, 'nullsec', ?, ?, 0, 0, 0, 1, ?, ?, ?)`);
      const neighbours = { 31: [32], 32: [31, 33], 33: [32, 34], 34: [33, 35], 35: [34] };
      const graph = { getNeighbors: (id) => neighbours[id] || [], getSystemIds: () => [31, 32, 33, 34, 35],
        getSystem: () => ({ factionId: null }) };
      let snapshot = { channels: { world: {} } };
      const ctx = { persistence: { store: { transaction: (n, fn) => ({ ok: true, value: fn(db) }) } },
        graph: { getGraph: () => ({ ok: true, graph }) }, telemetry: { getSnapshot: () => snapshot } };
      sys.run(31, 500020, "STABLE", null, null, 500020);
      const s = takeCheckSnapshot(ctx);
      assert.strictEqual(s.ok, true, JSON.stringify(s));
      sys.run(32, 500020, "OCCUPIED", 500020, 1000, null);
      sys.run(35, 500020, "OCCUPIED", 500020, 1001, null);
      db.prepare(`INSERT INTO world_sov_projection_log (system_id, last_controller, last_action, last_seq, updated_at,
        version) VALUES (40, 500020, 'GAIN', 1, 0, 1)`).run();
      const now = Date.UTC(2026, 10, 10, 12, 30);
      const ticks = [100, 112];
      const r = runLiveCheck({ ctx, config, prev: s.snap, now }, { perfNow: () => ticks.shift() });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(r.result.failing, ["nonAdjacentCaptures"], JSON.stringify(r.result.counts));
      assert.strictEqual(r.result.counts.disabledModuleRows, 0);
      assert.strictEqual(r.ms, 12);
      const line = formatLiveCheck(r, now);
      assert.ok(line.startsWith("liveSim: checks FAIL nonAdjacentCaptures=1 v=2026-11-10T12:30Z 12ms notes="), line);
      const rec = JSON.parse(JSON.stringify(checkRecord(r, { wallAt: 5, virtualAt: now })));
      assert.deepStrictEqual([rec.kind, rec.ok, rec.pass, rec.wallAt, rec.virtualAt], ["checks", true, false, 5, now]);
      assert.deepStrictEqual(rec.details.nonAdjacentCaptures, [{ systemId: 35, factionId: 500020 }]);
      assert.deepStrictEqual(Object.keys(rec.details), ["nonAdjacentCaptures"]);
      assert.strictEqual(rec.coreHeld, undefined);

      db.prepare("DELETE FROM world_system_state WHERE system_id = 35").run();
      const fixed = runLiveCheck({ ctx, config, prev: s.snap, now });
      assert.strictEqual(fixed.ok, true, JSON.stringify(fixed));
      assert.ok(formatLiveCheck(fixed, now).startsWith("liveSim: checks PASS v=2026-11-10T12:30Z "),
        formatLiveCheck(fixed, now));

      snapshot = { channels: { world: { "invasions.sovUnavailable": 2 } } };
      const sov = runLiveCheck({ ctx, config, prev: s.snap, now });
      assert.deepStrictEqual(sov.result.failing, ["sovUnavailable"]);
      assert.ok(formatLiveCheck(sov, now).startsWith("liveSim: checks FAIL sovUnavailable=2 "));

      const noStore = runLiveCheck({ ctx: { persistence: { store: {} } }, config, prev: null, now });
      assert.deepStrictEqual([noStore.ok, noStore.reason], [false, "NO_STORE"]);
      assert.ok(formatLiveCheck(noStore, now).startsWith("liveSim: checks ERROR NO_STORE v=2026-11-10T12:30Z "));
      assert.deepStrictEqual(takeCheckSnapshot({}), { ok: false, reason: "NO_STORE" });
      const errRec = checkRecord(noStore, { wallAt: 5, virtualAt: now });
      assert.deepStrictEqual([errRec.kind, errRec.ok, errRec.reason], ["checks", false, "NO_STORE"]);
    } finally {
      db.close();
      rmQuiet(dir);
    }
  });

  async function smoke(args) {
    const gets = [];
    let port = null;
    const r = await runChild(args, (line) => {
      const m = /^observer: listening http:\/\/127\.0\.0\.1:(\d+)\//.exec(line);
      if (m) port = Number(m[1]);
      if (line.startsWith("liveSim: running") && port !== null) {
        gets.push(Promise.all([get(port, "/"), get(port, "/api/views/status")]));
      }
    });
    return { ...r, port, codes: gets.length > 0 ? await gets[0] : null };
  }

  test("LSIM-T6 liveSim smoke: speed 100, observer answers, virtual time x speed, clean stop", async () => {
    const root = tmpDir("smoke");
    try {
      const sde = path.join(root, "sde");
      fs.mkdirSync(sde);
      writeMiniSde(sde);
      const report = path.join(root, "r.json");
      const r = await smoke(["--sde", sde, "--speed", "100", "--port", "0", "--duration-s", "1.5", "--data-dir",
        path.join(root, "data"), "--report-json", report, "--compose", path.join(MOD_DIR, "..", "..", "compose.yaml"),
        "--checks-every-virtual-h", "0.01"]);
      const tail = r.lines.slice(-15).join("\n");
      assert.strictEqual(r.code, 0, tail);
      const composeLine = r.lines.filter((l) => /^liveSim: compose defaults \d+ keys from service server .* [1-9]\d* differ from SCHEMA/.test(l));
      assert.strictEqual(composeLine.length, 1, r.lines.filter((l) => l.startsWith("liveSim:")).join("\n"));
      assert.strictEqual(r.lines.some((l) => l.includes("config without compose defaults")), false);
      assert.ok(r.port > 0, tail);
      assert.deepStrictEqual(r.codes, [200, 200], tail);
      assert.ok(r.lines.includes("liveSim: stopped (duration)"), tail);
      const rep = JSON.parse(fs.readFileSync(report, "utf8"));
      assert.ok(rep.virtualElapsedMs >= 0.8 * 100 * rep.wallElapsedMs, JSON.stringify(rep));
      const allowed = ["space/runtime/systemSecurityBand.js", "space/npc/pirateFactionPolicy.js", "common/numbers.js"];
      assert.deepStrictEqual(rep.serverFilesLoaded.filter((f) => !allowed.includes(f)), []);
      const persistence = rep.services.find((s) => s.name === "persistence");
      assert.strictEqual(persistence.state, "stopped");
      for (const name of ["beltNavy", "playerSiege", "sentries"]) {
        const s = rep.services.find((x) => x.name === name);
        assert.deepStrictEqual([s.state, s.reason], ["disabled", "disabled_by_config"], name);
      }
      const retention = rep.services.find((s) => s.name === "retention");
      assert.ok(retention && retention.reason !== "disabled_by_config", JSON.stringify(retention));
      const anchor = JSON.parse(fs.readFileSync(path.join(root, "data", ANCHOR_FILE), "utf8"));
      assert.deepStrictEqual([anchor.cleanStop, anchor.runs, anchor.virtualAt], [true, 1, rep.stopVirtualAt]);
      assert.ok(Number.isInteger(anchor.maxWriteGapS) && anchor.maxWriteGapS >= 0, JSON.stringify(anchor));
      const checkLines = r.lines.filter((l) => /^liveSim: checks (PASS|FAIL) /.test(l));
      assert.ok(checkLines.length >= 1, r.lines.filter((l) => l.startsWith("liveSim:")).join("\n"));
      assert.deepStrictEqual(r.lines.filter((l) => l.startsWith("liveSim: checks ERROR")
        || l.startsWith("liveSim: checks snapshot failed")), []);
      assert.ok(rep.checks.runs >= 1 && rep.checks.everyVirtualH === 0.01, JSON.stringify(rep.checks));
    } finally {
      rmQuiet(root);
    }
  });

  if (benchEnabled) bench("LSIM-T7 liveSim restart: second run on the same folder with --offline-hours 2", async () => {
    const root = tmpDir("restart");
    try {
      const sde = path.join(root, "sde");
      fs.mkdirSync(sde);
      writeMiniSde(sde);
      const data = path.join(root, "data");
      const base = ["--sde", sde, "--speed", "100", "--port", "0", "--duration-s", "1.5", "--data-dir", data];
      const r1 = await smoke([...base, "--report-json", path.join(root, "r1.json")]);
      assert.strictEqual(r1.code, 0, r1.lines.slice(-10).join("\n"));
      const r2 = await smoke([...base, "--offline-hours", "2", "--report-json", path.join(root, "r2.json")]);
      assert.strictEqual(r2.code, 0, r2.lines.slice(-10).join("\n"));
      const rep1 = JSON.parse(fs.readFileSync(path.join(root, "r1.json"), "utf8"));
      const rep2 = JSON.parse(fs.readFileSync(path.join(root, "r2.json"), "utf8"));
      assert.ok(rep2.startVirtualAt >= rep1.stopVirtualAt + 2 * MS_PER_HOUR);
      assert.strictEqual(rep2.runs, 2);
      assert.strictEqual(rep2.services.find((s) => s.name === "persistence").state, "stopped");
      assert.ok(r2.lines.some((l) => l.startsWith("scheduler: catch-up start") || /recovered=[1-9]/.test(l)),
        r2.lines.filter((l) => l.startsWith("scheduler:")).join("\n"));
    } finally {
      rmQuiet(root);
    }
  });
};
