"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, SCHEMA } = require("../../config");

const MOD_DIR = path.resolve(path.sep, "repo", "mods", "shipWing");

function files(map) {
  return (file) => {
    const name = path.basename(file);
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
    const err = new Error(`ENOENT: ${file}`);
    err.code = "ENOENT";
    throw err;
  };
}

module.exports = ({ test }) => {
  test("C1 layers: defaults < settings.json < .env < environment; dataDir from EVEJS_DATA_ROOT", () => {
    const none = loadConfig({ env: {}, modDir: MOD_DIR, readFile: files({}) });
    assert.strictEqual(none.ok, true);
    assert.deepStrictEqual(none.warnings, []);
    for (const r of SCHEMA) assert.strictEqual(none.config[r.key], r.def, r.key);
    assert.strictEqual(none.config.enabled, false);
    assert.strictEqual(none.config.dataDir, path.join(path.resolve(MOD_DIR, "..", ".."), "_local", "mods", "shipWing"));
    assert.strictEqual(none.config.stateFile, path.join(none.config.dataDir, "wings.json"));

    const r = loadConfig({
      env: { EVEJS_SHIPWING_FOLLOW_RANGE_METERS: "200", EVEJS_SHIPWING_DEBUG: "", EVEJS_DATA_ROOT: " /data/evejs " },
      modDir: MOD_DIR,
      readFile: files({
        "settings.json": JSON.stringify({ enabled: true, maxWingPerPilot: 3, chatTrigger: "!copy" }),
        ".env": "# comment\nEVEJS_SHIPWING_MAX_WING_PER_PILOT=4\nEVEJS_SHIPWING_FOLLOW_RANGE_METERS=\"100\"\n",
      }),
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.warnings, []);
    assert.strictEqual(r.config.enabled, true);
    assert.strictEqual(r.sources.enabled, "settings.json");
    assert.strictEqual(r.config.maxWingPerPilot, 4);
    assert.strictEqual(r.sources.maxWingPerPilot, ".env");
    assert.strictEqual(r.config.followRangeMeters, 200);
    assert.strictEqual(r.sources.followRangeMeters, "environment");
    assert.strictEqual(r.config.chatTrigger, "!copy");
    assert.strictEqual(r.config.debug, false, "empty env value = unset");
    assert.strictEqual(r.config.dataDir, path.join(path.resolve("/data/evejs"), "mods", "shipWing"));
  });

  test("C2 bad values -> default + warning; broken settings.json -> ok:false; never throws", () => {
    const r = loadConfig({
      env: { EVEJS_SHIPWING_MAX_WING_PER_PILOT: "abc", EVEJS_SHIPWING_TICK_INTERVAL_MS: "5",
        EVEJS_SHIPWING_ENABLED: "maybe", EVEJS_SHIPWING_NOPE: "1" },
      modDir: MOD_DIR,
      readFile: files({ "settings.json": JSON.stringify({ chatTrigger: "wing", unknownKey: 1 }), ".env": "garbage" }),
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.config.maxWingPerPilot, 2);
    assert.strictEqual(r.config.tickIntervalMs, 500);
    assert.strictEqual(r.config.enabled, false);
    assert.strictEqual(r.config.chatTrigger, "!wing");
    assert.strictEqual(r.warnings.length, 7, r.warnings.join("\n"));
    assert.ok(r.warnings.some((w) => w.includes("EVEJS_SHIPWING_MAX_WING_PER_PILOT must be an integer 1..10")));
    assert.ok(r.warnings.some((w) => w.includes("unknown key EVEJS_SHIPWING_NOPE")));

    const broken = loadConfig({ env: { EVEJS_SHIPWING_ENABLED: "1" }, modDir: MOD_DIR,
      readFile: files({ "settings.json": "{ nope" }) });
    assert.strictEqual(broken.ok, false);
    assert.ok(broken.errors[0].startsWith("settings.json: not valid JSON"));
    assert.strictEqual(broken.config.enabled, true, "env still read; the world process refuses with config_invalid");

    const unreadable = loadConfig({ env: {}, modDir: MOD_DIR, readFile: () => { throw new Error("EACCES"); } });
    assert.strictEqual(unreadable.ok, false);
    assert.strictEqual(unreadable.config.enabled, false);
    const thrown = loadConfig({ env: {}, modDir: 42, readFile: files({}) });
    assert.strictEqual(thrown.ok, false);
    assert.ok(thrown.errors[0].startsWith("config_load_failed"));
    assert.strictEqual(thrown.config.enabled, false);
  });

  test("C3 clientWindow* keys: defaults, env names, ranges; warning when clientWindowEnabled is on "
    + "while enabled is off", () => {
    const none = loadConfig({ env: {}, modDir: MOD_DIR, readFile: files({}) });
    assert.deepStrictEqual([none.config.clientWindowEnabled, none.config.clientWindowStateMinIntervalMs,
      none.config.clientWindowMaxCommandsPerSecond, none.config.clientWindowMaxShipsPerCommand,
      none.config.clientWindowReportMinIntervalMs], [false, 1000, 5, 20, 60000]);
    const r = loadConfig({ env: {
      EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_CLIENT_WINDOW_ENABLED: "1",
      EVEJS_SHIPWING_CLIENT_WINDOW_STATE_MIN_INTERVAL_MS: "100",
      EVEJS_SHIPWING_CLIENT_WINDOW_MAX_COMMANDS_PER_SECOND: "50",
      EVEJS_SHIPWING_CLIENT_WINDOW_MAX_SHIPS_PER_COMMAND: "101",
      EVEJS_SHIPWING_CLIENT_WINDOW_REPORT_MIN_INTERVAL_MS: "999",
    }, modDir: MOD_DIR, readFile: files({}) });
    assert.strictEqual(r.config.clientWindowEnabled, true);
    assert.strictEqual(r.config.clientWindowStateMinIntervalMs, 100);
    assert.strictEqual(r.config.clientWindowMaxCommandsPerSecond, 50);
    assert.strictEqual(r.config.clientWindowMaxShipsPerCommand, 20, "101 is out of range");
    assert.strictEqual(r.config.clientWindowReportMinIntervalMs, 60000, "999 is out of range");
    assert.deepStrictEqual(r.warnings, [
      "environment: EVEJS_SHIPWING_CLIENT_WINDOW_MAX_SHIPS_PER_COMMAND must be an integer 1..100 - keeping 20",
      "environment: EVEJS_SHIPWING_CLIENT_WINDOW_REPORT_MIN_INTERVAL_MS must be an integer 1000..3600000 "
        + "- keeping 60000",
    ]);
    const lone = loadConfig({ env: { EVEJS_SHIPWING_CLIENT_WINDOW_ENABLED: "1" }, modDir: MOD_DIR,
      readFile: files({}) });
    assert.deepStrictEqual(lone.warnings, ["clientWindowEnabled has no effect while enabled is off"]);
    assert.strictEqual(lone.ok, true);

    const w2Keys = ["clientWindowPollMs", "clientWindowHpRefreshMs", "clientWindowRowReasonMs", "clientWindowAutoOpen",
      "clientWindowMaxRows", "clientWindowEventMinIntervalMs"];
    assert.deepStrictEqual(w2Keys.map((k) => none.config[k]), [5000, 1000, 8000, true, 30, 1000]);
    assert.deepStrictEqual(w2Keys.map((k) => SCHEMA.find((s) => s.key === k).env), [
      "EVEJS_SHIPWING_CLIENT_WINDOW_POLL_MS", "EVEJS_SHIPWING_CLIENT_WINDOW_HP_REFRESH_MS",
      "EVEJS_SHIPWING_CLIENT_WINDOW_ROW_REASON_MS", "EVEJS_SHIPWING_CLIENT_WINDOW_AUTO_OPEN",
      "EVEJS_SHIPWING_CLIENT_WINDOW_MAX_ROWS", "EVEJS_SHIPWING_CLIENT_WINDOW_EVENT_MIN_INTERVAL_MS"]);
    const w2 = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const chars = SCHEMA.find((s) => s.key === "clientWindowActiveChars");
    assert.deepStrictEqual([none.config.clientWindowActiveChars, chars.env,
      w2({ EVEJS_SHIPWING_CLIENT_WINDOW_ACTIVE_CHARS: "0" }).config.clientWindowActiveChars,
      w2({ EVEJS_SHIPWING_CLIENT_WINDOW_ACTIVE_CHARS: "61" }).config.clientWindowActiveChars],
    [24, "EVEJS_SHIPWING_CLIENT_WINDOW_ACTIVE_CHARS", 0, 24]);
    const set = w2({ EVEJS_SHIPWING_CLIENT_WINDOW_POLL_MS: "0", EVEJS_SHIPWING_CLIENT_WINDOW_HP_REFRESH_MS: "250",
      EVEJS_SHIPWING_CLIENT_WINDOW_ROW_REASON_MS: "60000", EVEJS_SHIPWING_CLIENT_WINDOW_AUTO_OPEN: "0",
      EVEJS_SHIPWING_CLIENT_WINDOW_MAX_ROWS: "100", EVEJS_SHIPWING_CLIENT_WINDOW_EVENT_MIN_INTERVAL_MS: "0" });
    assert.deepStrictEqual([w2Keys.map((k) => set.config[k]), set.warnings], [[0, 250, 60000, false, 100, 0], []]);
    const out = w2({ EVEJS_SHIPWING_CLIENT_WINDOW_POLL_MS: "60001", EVEJS_SHIPWING_CLIENT_WINDOW_HP_REFRESH_MS: "249",
      EVEJS_SHIPWING_CLIENT_WINDOW_ROW_REASON_MS: "999", EVEJS_SHIPWING_CLIENT_WINDOW_MAX_ROWS: "9",
      EVEJS_SHIPWING_CLIENT_WINDOW_EVENT_MIN_INTERVAL_MS: "60001" });
    assert.deepStrictEqual(w2Keys.map((k) => out.config[k]), [5000, 1000, 8000, true, 30, 1000]);
    assert.strictEqual(out.warnings.length, 5, out.warnings.join("\n"));
    const slow = w2({ EVEJS_SHIPWING_CLIENT_WINDOW_POLL_MS: "999" });
    assert.deepStrictEqual([slow.config.clientWindowPollMs, slow.warnings], [1000,
      ["clientWindowPollMs raised to 1000"]]);
    assert.strictEqual(w2({ EVEJS_SHIPWING_CLIENT_WINDOW_POLL_MS: "1" }).config.clientWindowPollMs, 1000);
  });

  test("C4 clientWindowHandshakeHashes (hashList: 64 hex, commas, 1..8; bad -> warning + default) and "
    + "clientWindowOpenMinIntervalMs", () => {
    const def = "7aaa72247049b38d3f656f3b2c602877a8bcf0d9ff0af68f1795ff1327565ba7";
    const a = "a".repeat(64);
    const none = loadConfig({ env: {}, modDir: MOD_DIR, readFile: files({}) });
    assert.deepStrictEqual(none.config.clientWindowHandshakeHashes, [def]);
    assert.strictEqual(none.config.clientWindowOpenMinIntervalMs, 1000);
    const env = (value) => loadConfig({ env: { EVEJS_SHIPWING_CLIENT_WINDOW_HANDSHAKE_HASHES: value },
      modDir: MOD_DIR, readFile: files({}) });
    assert.deepStrictEqual(env(` ${a.toUpperCase()} , ${def}`).config.clientWindowHandshakeHashes, [a, def]);
    for (const bad of ["abc", `${a},xyz`, Array.from({ length: 9 }, () => a).join(","), `${a},`]) {
      const r = env(bad);
      assert.deepStrictEqual(r.config.clientWindowHandshakeHashes, [def], bad);
      assert.strictEqual(r.warnings.length, 1, bad);
      assert.ok(r.warnings[0].startsWith("environment: EVEJS_SHIPWING_CLIENT_WINDOW_HANDSHAKE_HASHES must be 1..8 "),
        r.warnings[0]);
    }
    const settings = loadConfig({ env: {}, modDir: MOD_DIR,
      readFile: files({ "settings.json": JSON.stringify({ clientWindowHandshakeHashes: [a] }) }) });
    assert.deepStrictEqual(settings.config.clientWindowHandshakeHashes, [a]);
    const open = loadConfig({ env: { EVEJS_SHIPWING_CLIENT_WINDOW_OPEN_MIN_INTERVAL_MS: "0" }, modDir: MOD_DIR,
      readFile: files({}) });
    assert.strictEqual(open.config.clientWindowOpenMinIntervalMs, 0);
  });

  test("C5 enum activeCapUnstablePolicy: refuse (any case) -> refuse; xyz -> warning with the key "
    + "default shed; active flag off by default; stop <= start -> warning", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({});
    assert.deepStrictEqual([def.config.activeModulesEnabled, def.config.activeCapUnstablePolicy], [false, "shed"]);
    const ok = load({ EVEJS_SHIPWING_ACTIVE_CAP_UNSTABLE_POLICY: " Refuse " });
    assert.deepStrictEqual([ok.config.activeCapUnstablePolicy, ok.sources.activeCapUnstablePolicy, ok.warnings],
      ["refuse", "environment", []]);
    const bad = load({ EVEJS_SHIPWING_ACTIVE_CAP_UNSTABLE_POLICY: "xyz" });
    assert.strictEqual(bad.config.activeCapUnstablePolicy, "shed");
    assert.deepStrictEqual(bad.warnings, ["environment: EVEJS_SHIPWING_ACTIVE_CAP_UNSTABLE_POLICY must be one of "
      + "shed|disable|refuse - keeping \"shed\""]);
    assert.strictEqual(bad.ok, true, "a warning, not an error");
    const hyst = load({ EVEJS_SHIPWING_ACTIVE_LOCAL_REP_START_PCT: "80",
      EVEJS_SHIPWING_ACTIVE_LOCAL_REP_STOP_PCT: "80" });
    assert.ok(hyst.warnings.some((w) => w.startsWith("activeLocalRepStopPct (80) is not above")), hyst.warnings);
  });

  test("C6 () activeCapIncludeWeapons default false (env 1 -> true); stop <= start -> "
    + "both keys back to the defaults 70/95 (source default), one warning that says so", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({});
    assert.deepStrictEqual([def.config.activeCapIncludeWeapons, def.config.activeLocalRepStartPct,
      def.config.activeLocalRepStopPct, def.warnings], [false, 70, 95, []]);
    assert.strictEqual(load({ EVEJS_SHIPWING_ACTIVE_CAP_INCLUDE_WEAPONS: "1" }).config.activeCapIncludeWeapons, true);
    for (const [start, stop] of [["80", "80"], ["90", "50"]]) {
      const r = load({ EVEJS_SHIPWING_ACTIVE_LOCAL_REP_START_PCT: start, EVEJS_SHIPWING_ACTIVE_LOCAL_REP_STOP_PCT: stop });
      assert.deepStrictEqual([r.config.activeLocalRepStartPct, r.config.activeLocalRepStopPct,
        r.sources.activeLocalRepStartPct, r.sources.activeLocalRepStopPct, r.ok], [70, 95, "default", "default", true]);
      assert.deepStrictEqual(r.warnings, [`activeLocalRepStopPct (${stop}) is not above activeLocalRepStartPct `
        + `(${start}) - using the defaults 70 and 95`]);
    }
    const ok = load({ EVEJS_SHIPWING_ACTIVE_LOCAL_REP_START_PCT: "50", EVEJS_SHIPWING_ACTIVE_LOCAL_REP_STOP_PCT: "60" });
    assert.deepStrictEqual([ok.config.activeLocalRepStartPct, ok.config.activeLocalRepStopPct, ok.warnings],
      [50, 60, []]);
  });

  test("SL5 (safe logoff) safeLogoffAbortOnOrder and safeLogoffBlockWhileDeployed default false; env 1 -> true",
    () => {
      const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
      const def = load({});
      assert.deepStrictEqual([def.config.safeLogoffAbortOnOrder, def.config.safeLogoffBlockWhileDeployed,
        def.warnings], [false, false, []]);
      const on = load({ EVEJS_SHIPWING_SAFE_LOGOFF_ABORT_ON_ORDER: "1",
        EVEJS_SHIPWING_SAFE_LOGOFF_BLOCK_WHILE_DEPLOYED: "1" });
      assert.deepStrictEqual([on.config.safeLogoffAbortOnOrder, on.config.safeLogoffBlockWhileDeployed,
        on.sources.safeLogoffAbortOnOrder], [true, true, "environment"]);
      assert.deepStrictEqual(on.warnings, ["safeLogoffAbortOnOrder has no effect while enabled is off",
        "safeLogoffBlockWhileDeployed has no effect while enabled is off"]);
      assert.deepStrictEqual(load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_SAFE_LOGOFF_ABORT_ON_ORDER: "1",
        EVEJS_SHIPWING_SAFE_LOGOFF_BLOCK_WHILE_DEPLOYED: "1" }).warnings, []);
    });

  test("C16 (BUG nos-rr) activeCapNosCreditPct default 0 (0..100; 150 -> warning + 0) "
    + "activeCapShedRemoteLast default false; env names", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({});
    assert.deepStrictEqual([def.config.activeCapNosCreditPct, def.config.activeCapShedRemoteLast, def.warnings],
      [0, false, []]);
    const set = load({ EVEJS_SHIPWING_ACTIVE_CAP_NOS_CREDIT_PCT: "100", EVEJS_SHIPWING_ACTIVE_CAP_SHED_REMOTE_LAST: "1" });
    assert.deepStrictEqual([set.config.activeCapNosCreditPct, set.config.activeCapShedRemoteLast, set.warnings],
      [100, true, []]);
    const bad = load({ EVEJS_SHIPWING_ACTIVE_CAP_NOS_CREDIT_PCT: "150" });
    assert.strictEqual(bad.config.activeCapNosCreditPct, 0);
    assert.strictEqual(bad.warnings.length, 1);
    assert.ok(bad.warnings[0].includes("EVEJS_SHIPWING_ACTIVE_CAP_NOS_CREDIT_PCT"), bad.warnings[0]);
  });

  test("C10 (command burst) burstEnabled default false; env EVEJS_SHIPWING_BURST_ENABLED=1 -> true "
    + "on without enabled -> warning; with enabled -> none", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({});
    assert.deepStrictEqual([def.config.burstEnabled, def.warnings], [false, []]);
    const alone = load({ EVEJS_SHIPWING_BURST_ENABLED: "1" });
    assert.deepStrictEqual([alone.config.burstEnabled, alone.sources.burstEnabled, alone.ok, alone.warnings],
      [true, "environment", true, ["burstEnabled has no effect while enabled is off"]]);
    assert.deepStrictEqual(load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_BURST_ENABLED: "1" }).warnings, []);
    assert.ok(SCHEMA.some((r) => r.key === "burstEnabled" && r.env === "EVEJS_SHIPWING_BURST_ENABLED"));
    assert.deepStrictEqual(SCHEMA.filter((r) => r.key.startsWith("boardBackCargo"))
      .map((r) => [r.key, r.def, r.min, r.max]),
    [["boardBackCargoUnloadEnabled", false, undefined, undefined], ["boardBackCargoMaxStacks", 50, 1, 500]]);
  });

  test("C11 (command burst) burstShipStatsEnabled default true without a warning "
    + "burstMaxRebuildsPerTick default 8, 1..1000; burstShipStatsEnabled set without burstEnabled -> warning", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({});
    assert.deepStrictEqual([def.config.burstShipStatsEnabled, def.config.burstMaxRebuildsPerTick, def.warnings],
      [true, 8, []]);
    const on = load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_BURST_SHIP_STATS_ENABLED: "1" });
    assert.deepStrictEqual(on.warnings, ["burstShipStatsEnabled has no effect while burstEnabled is off"]);
    const both = load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_BURST_ENABLED: "1",
      EVEJS_SHIPWING_BURST_SHIP_STATS_ENABLED: "0", EVEJS_SHIPWING_BURST_MAX_REBUILDS_PER_TICK: "1" });
    assert.deepStrictEqual([both.config.burstShipStatsEnabled, both.config.burstMaxRebuildsPerTick, both.warnings],
      [false, 1, []]);
    const bad = load({ EVEJS_SHIPWING_BURST_MAX_REBUILDS_PER_TICK: "0" });
    assert.deepStrictEqual([bad.config.burstMaxRebuildsPerTick, bad.warnings.length], [8, 1]);
  });

  test("C7 logi keys: defaults (off, 90, 1000, 5000, 3000, cap transfer off); logiEnabled without "
    + "activeModulesEnabled -> warning and off; with it -> on", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({}).config;
    assert.deepStrictEqual([def.logiEnabled, def.logiRepairThresholdPct, def.logiRetargetMs, def.logiApproachMeters,
      def.logiMoveLeaseMs, def.logiCapTransferEnabled], [false, 90, 1000, 5000, 3000, false]);
    const alone = load({ EVEJS_SHIPWING_LOGI_ENABLED: "1" });
    assert.deepStrictEqual([alone.config.logiEnabled, alone.ok, alone.warnings], [false, true,
      ["logiEnabled has no effect while activeModulesEnabled is off - remote repair off"]]);
    const on = load({ EVEJS_SHIPWING_LOGI_ENABLED: "1", EVEJS_SHIPWING_ACTIVE_MODULES_ENABLED: "1",
      EVEJS_SHIPWING_LOGI_REPAIR_THRESHOLD_PCT: "101" });
    assert.deepStrictEqual([on.config.logiEnabled, on.config.logiRepairThresholdPct], [true, 90]);
  });

  test("C9 prop keys: defaults (off, 5000); activePropEnabled without activeModulesEnabled -> warning and "
    + "off; with it -> on; distance out of 0..250000 -> default", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({}).config;
    assert.deepStrictEqual([def.activePropEnabled, def.activePropMinDistanceMeters], [false, 5000]);
    const alone = load({ EVEJS_SHIPWING_ACTIVE_PROP_ENABLED: "1" });
    assert.deepStrictEqual([alone.config.activePropEnabled, alone.ok, alone.warnings], [false, true,
      ["activePropEnabled has no effect while activeModulesEnabled is off - AB/MWD off"]]);
    const on = load({ EVEJS_SHIPWING_ACTIVE_PROP_ENABLED: "1", EVEJS_SHIPWING_ACTIVE_MODULES_ENABLED: "1",
      EVEJS_SHIPWING_ACTIVE_PROP_MIN_DISTANCE_METERS: "250001" });
    assert.deepStrictEqual([on.config.activePropEnabled, on.config.activePropMinDistanceMeters], [true, 5000]);
    assert.strictEqual(load({ EVEJS_SHIPWING_ACTIVE_PROP_MIN_DISTANCE_METERS: "0" }).config
      .activePropMinDistanceMeters, 0);
  });

  test("C15 ewar keys: defaults (off, 2000, 32, 10000), env names; ewarEnabled without "
    + "activeModulesEnabled / combatEnabled -> one warning each; with both -> none; out of range -> default", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const keys = ["ewarEnabled", "ewarRetryMs", "ewarMaxCyclesPerTick", "ewarOrphanSweepMs"];
    const def = load({}).config;
    assert.deepStrictEqual(keys.map((k) => def[k]), [false, 2000, 32, 10000]);
    assert.deepStrictEqual(keys.map((k) => SCHEMA.find((s) => s.key === k).env), ["EVEJS_SHIPWING_EWAR_ENABLED",
      "EVEJS_SHIPWING_EWAR_RETRY_MS", "EVEJS_SHIPWING_EWAR_MAX_CYCLES_PER_TICK", "EVEJS_SHIPWING_EWAR_ORPHAN_SWEEP_MS"]);
    const alone = load({ EVEJS_SHIPWING_EWAR_ENABLED: "1" });
    assert.deepStrictEqual([alone.config.ewarEnabled, alone.ok, alone.warnings], [true, true,
      ["ewarEnabled without activeModulesEnabled - twins use no EWAR",
        "ewarEnabled without combatEnabled - twins have no EWAR target"]]);
    const on = load({ EVEJS_SHIPWING_EWAR_ENABLED: "1", EVEJS_SHIPWING_ACTIVE_MODULES_ENABLED: "1",
      EVEJS_SHIPWING_COMBAT_ENABLED: "1", EVEJS_SHIPWING_EWAR_RETRY_MS: "99",
      EVEJS_SHIPWING_EWAR_ORPHAN_SWEEP_MS: "600001" });
    assert.deepStrictEqual([on.config.ewarEnabled, on.config.ewarRetryMs, on.config.ewarOrphanSweepMs],
      [true, 2000, 10000]);
    assert.ok(!on.warnings.some((w) => w.startsWith("ewarEnabled")), on.warnings.join(" | "));
  });

  test("C8 () logiRetargetMs >= logiMoveLeaseMs -> both keys back to the defaults 1000/3000 "
    + "(source default), one warning that says so; retarget < lease -> kept", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    for (const [retarget, lease] of [["3000", "3000"], ["5000", "2000"]]) {
      const r = load({ EVEJS_SHIPWING_LOGI_RETARGET_MS: retarget, EVEJS_SHIPWING_LOGI_MOVE_LEASE_MS: lease });
      assert.deepStrictEqual([r.config.logiRetargetMs, r.config.logiMoveLeaseMs, r.sources.logiRetargetMs,
        r.sources.logiMoveLeaseMs, r.ok], [1000, 3000, "default", "default", true]);
      assert.deepStrictEqual(r.warnings, [`logiRetargetMs (${retarget}) is not below logiMoveLeaseMs `
        + `(${lease}) - using the defaults 1000 and 3000`]);
    }
    const ok = load({ EVEJS_SHIPWING_LOGI_RETARGET_MS: "500", EVEJS_SHIPWING_LOGI_MOVE_LEASE_MS: "600" });
    assert.deepStrictEqual([ok.config.logiRetargetMs, ok.config.logiMoveLeaseMs, ok.warnings], [500, 600, []]);
  });

  test("C12 hpWarnPct / hpCriticalPct: defaults 90/50, env names, 1..99; critical >= warn -> both "
    + "defaults (source default) and one warning; settings.json layer", () => {
    const load = (env, settings) => loadConfig({ env, modDir: MOD_DIR,
      readFile: files(settings ? { "settings.json": JSON.stringify(settings) } : {}) });
    const none = load({});
    assert.deepStrictEqual([none.config.hpWarnPct, none.config.hpCriticalPct, none.warnings], [90, 50, []]);
    assert.deepStrictEqual(["hpWarnPct", "hpCriticalPct"].map((k) => SCHEMA.find((s) => s.key === k).env),
      ["EVEJS_SHIPWING_HP_WARN_PCT", "EVEJS_SHIPWING_HP_CRITICAL_PCT"]);
    const set = load({ EVEJS_SHIPWING_HP_WARN_PCT: "99", EVEJS_SHIPWING_HP_CRITICAL_PCT: "1" });
    assert.deepStrictEqual([set.config.hpWarnPct, set.config.hpCriticalPct, set.warnings], [99, 1, []]);
    const out = load({ EVEJS_SHIPWING_HP_WARN_PCT: "100", EVEJS_SHIPWING_HP_CRITICAL_PCT: "0" });
    assert.deepStrictEqual([out.config.hpWarnPct, out.config.hpCriticalPct, out.warnings.length], [90, 50, 2]);
    for (const [warn, critical] of [["50", "50"], ["30", "60"]]) {
      const r = load({ EVEJS_SHIPWING_HP_WARN_PCT: warn, EVEJS_SHIPWING_HP_CRITICAL_PCT: critical });
      assert.deepStrictEqual([r.config.hpWarnPct, r.config.hpCriticalPct, r.sources.hpWarnPct, r.sources.hpCriticalPct,
        r.ok], [90, 50, "default", "default", true]);
      assert.deepStrictEqual(r.warnings, [`hpCriticalPct (${critical}) is not below hpWarnPct (${warn}) `
        + "- using the defaults 90 and 50"]);
    }
    const alone = load({ EVEJS_SHIPWING_HP_CRITICAL_PCT: "95" });
    assert.deepStrictEqual([alone.config.hpWarnPct, alone.config.hpCriticalPct, alone.warnings.length], [90, 50, 1]);
    const file = load({}, { hpWarnPct: 60, hpCriticalPct: 20 });
    assert.deepStrictEqual([file.config.hpWarnPct, file.config.hpCriticalPct, file.sources.hpWarnPct],
      [60, 20, "settings.json"]);
    assert.strictEqual(none.config.clientWindowButtonColors, true);
    assert.strictEqual(SCHEMA.find((s) => s.key === "clientWindowButtonColors").env,
      "EVEJS_SHIPWING_CLIENT_WINDOW_BUTTON_COLORS");
    const off = load({ EVEJS_SHIPWING_CLIENT_WINDOW_BUTTON_COLORS: "0" });
    assert.deepStrictEqual([off.config.clientWindowButtonColors, off.warnings], [false, []]);
  });

  test("C13 commandMirrorEngageEnabled default true / commandMirrorEngageCopyDefault default false "
    + "env names, no warning by default; set on purpose without the parent flag -> one warning each", () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({});
    assert.deepStrictEqual([def.config.commandMirrorEngageEnabled, def.config.commandMirrorEngageCopyDefault,
      def.warnings], [true, false, []]);
    assert.ok(SCHEMA.some((r) => r.key === "commandMirrorEngageEnabled"
      && r.env === "EVEJS_SHIPWING_COMMAND_MIRROR_ENGAGE_ENABLED"));
    assert.ok(SCHEMA.some((r) => r.key === "commandMirrorEngageCopyDefault"
      && r.env === "EVEJS_SHIPWING_COMMAND_MIRROR_ENGAGE_COPY_DEFAULT"));
    const onPurpose = load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_COMMAND_MIRROR_ENGAGE_ENABLED: "1" });
    assert.deepStrictEqual(onPurpose.warnings, ["commandMirrorEngageEnabled has no effect while commandMirrorEnabled is off"]);
    const copy = load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_COMMAND_MIRROR_ENABLED: "1",
      EVEJS_SHIPWING_COMMAND_MIRROR_ENGAGE_ENABLED: "0", EVEJS_SHIPWING_COMMAND_MIRROR_ENGAGE_COPY_DEFAULT: "1" });
    assert.deepStrictEqual(copy.warnings,
      ["commandMirrorEngageCopyDefault has no effect while commandMirrorEngageEnabled is off"]);
    const both = load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_COMMAND_MIRROR_ENABLED: "1",
      EVEJS_SHIPWING_COMMAND_MIRROR_ENGAGE_ENABLED: "1", EVEJS_SHIPWING_COMMAND_MIRROR_ENGAGE_COPY_DEFAULT: "1" });
    assert.deepStrictEqual([both.config.commandMirrorEngageEnabled, both.config.commandMirrorEngageCopyDefault,
      both.warnings], [true, true, []]);
  });

  test("C14 auto target keys: defaults, env names, no warning by default; set on purpose -> warnings",
    () => {
      const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
      const def = load({});
      assert.deepStrictEqual([def.config.combatAutoTargetEnabled, def.config.combatAutoTargetRangeMeters,
        def.config.combatAutoScansPerTick, def.config.combatAutoScanMaxEntities, def.warnings],
      [true, 30000, 4, 2000, []]);
      assert.deepStrictEqual(["combatAutoTargetEnabled", "combatAutoTargetRangeMeters", "combatAutoScansPerTick",
        "combatAutoScanMaxEntities"].map((k) => SCHEMA.find((s) => s.key === k).env),
      ["EVEJS_SHIPWING_COMBAT_AUTO_TARGET_ENABLED", "EVEJS_SHIPWING_COMBAT_AUTO_TARGET_RANGE_METERS",
        "EVEJS_SHIPWING_COMBAT_AUTO_SCANS_PER_TICK", "EVEJS_SHIPWING_COMBAT_AUTO_SCAN_MAX_ENTITIES"]);
      const flag = load({ EVEJS_SHIPWING_COMBAT_AUTO_TARGET_ENABLED: "1" });
      assert.deepStrictEqual(flag.warnings, ["combatAutoTargetEnabled has no effect while combatEnabled is off"]);
      const range = load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_COMBAT_ENABLED: "1",
        EVEJS_SHIPWING_COMBAT_AUTO_TARGET_RANGE_METERS: "20000" });
      assert.deepStrictEqual([range.config.combatAutoTargetRangeMeters, range.warnings], [20000,
        ["combatAutoTargetRangeMeters (20000) is above combatEngageRangeMeters (15000) - the engage range limits "
          + "auto targets"]]);
    });

  test("CFG combatAllowNpcStructureTargets: default true, no warning; env "
    + "EVEJS_SHIPWING_COMBAT_ALLOW_NPC_STRUCTURE_TARGETS=0 -> false; set on purpose without combatEnabled -> warning",
  () => {
    const load = (env) => loadConfig({ env, modDir: MOD_DIR, readFile: files({}) });
    const def = load({});
    assert.deepStrictEqual([def.config.combatAllowNpcStructureTargets, def.warnings], [true, []]);
    assert.strictEqual(SCHEMA.find((s) => s.key === "combatAllowNpcStructureTargets").env,
      "EVEJS_SHIPWING_COMBAT_ALLOW_NPC_STRUCTURE_TARGETS");
    const off = load({ EVEJS_SHIPWING_COMBAT_ALLOW_NPC_STRUCTURE_TARGETS: "0" });
    assert.deepStrictEqual([off.config.combatAllowNpcStructureTargets, off.warnings], [false, []]);
    const set = load({ EVEJS_SHIPWING_COMBAT_ALLOW_NPC_STRUCTURE_TARGETS: "1" });
    assert.deepStrictEqual(set.warnings, ["combatAllowNpcStructureTargets has no effect while combatEnabled is off"]);
    const on = load({ EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_COMBAT_ENABLED: "1",
      EVEJS_SHIPWING_COMBAT_ALLOW_NPC_STRUCTURE_TARGETS: "1" });
    assert.deepStrictEqual(on.warnings, []);
  });

  test("COV1 settings.override.json beats EVEJS_SHIPWING_*; bad or unknown key -> warning, the "
    + "layer below; kill switch; broken file -> warning, never an error; overrideValues replaces the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipwing-override-"));
    try {
      const file = path.join(dir, "mods", "shipWing", "settings.override.json");
      const env = { EVEJS_DATA_ROOT: dir, EVEJS_SHIPWING_MAX_WING_PER_PILOT: "4" };
      const load = (extraEnv, extra) => loadConfig({ env: { ...env, ...extraEnv }, modDir: MOD_DIR, readFile: files({}),
        ...extra });
      const none = load({});
      assert.deepStrictEqual([none.config.maxWingPerPilot, none.sources.maxWingPerPilot, none.warnings],
        [4, "environment", []]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 1,
        values: { maxWingPerPilot: 6, followRangeMeters: "x", nope: 1 } }));
      const r = load({});
      assert.deepStrictEqual([r.ok, r.config.maxWingPerPilot, r.sources.maxWingPerPilot], [true, 6, "override"]);
      assert.strictEqual(r.config.followRangeMeters, 1500);
      assert.deepStrictEqual(r.warnings, [
        "settings.override.json: followRangeMeters must be an integer 0..100000 - keeping 1500",
        "settings.override.json: unknown key \"nope\" - ignored", "1 keys overridden in game (settings.override.json)"]);
      const killed = load({ EVEJS_MOD_SETTINGS_OVERRIDES_IGNORE: "1" });
      assert.deepStrictEqual([killed.config.maxWingPerPilot, killed.sources.maxWingPerPilot], [4, "environment"]);
      assert.strictEqual(load({}, { overrideValues: { maxWingPerPilot: 7 } }).config.maxWingPerPilot, 7);
      const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`nope${i}`, 1]));
      many[`x\n${"y".repeat(200)}`] = 1;
      const capped = load({}, { overrideValues: many }).warnings;
      assert.strictEqual(capped.length, 11, capped.join("\n"));
      assert.strictEqual(capped[10], "settings.override.json: +4 more unknown keys - ignored");
      const cut = load({}, { overrideValues: { [`x\n${"y".repeat(200)}`]: 1 } }).warnings;
      assert.deepStrictEqual(cut, [`settings.override.json: unknown key ${JSON.stringify(`x\n${"y".repeat(78)}...`)} `
        + "- ignored"]);
      fs.writeFileSync(file, "{broken");
      const broken = load({});
      assert.deepStrictEqual([broken.ok, broken.errors, broken.config.maxWingPerPilot], [true, [], 4]);
      assert.deepStrictEqual(broken.warnings, ["settings.override.json: not valid JSON - ignored"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
