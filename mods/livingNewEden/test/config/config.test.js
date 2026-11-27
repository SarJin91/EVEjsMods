"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");

const MOD_DIR = path.join(path.sep, "repo", "mods", "livingNewEden");
const KEY = "limits.maxDueEventsPerPass";
const ENV = "EVEJS_LNE_MAX_DUE_EVENTS_PER_PASS";

function has(list, text) {
  return list.some((line) => line.includes(text));
}

function resolve(env, extra = {}) {
  return config.resolveConfig({ modDir: MOD_DIR, env, ...extra });
}

module.exports = ({ test }) => {
  test("C1 layers: env > .env > settings.json > default, sources, override and typo warnings", () => {
    const settings = { limits: { maxDueEventsPerPass: 10 } };
    const envFile = { [ENV]: "20" };
    const all = resolve({ [ENV]: "30", EVEJS_LNE_ENABLE: "0", EVEJS_LNE_NO_INSTALL: "1" }, { settings, envFile });
    assert.strictEqual(all.ok, true);
    assert.strictEqual(all.config.limits.maxDueEventsPerPass, 30);
    assert.strictEqual(all.sources[KEY], "environment");
    assert.ok(has(all.warnings, "overrides the launcher setting"), all.warnings.join("\n"));
    assert.ok(has(all.warnings, "EVEJS_LNE_ENABLE is not a setting"), all.warnings.join("\n"));
    assert.ok(!has(all.warnings, "EVEJS_LNE_NO_INSTALL"), "reserved env must not warn");

    const noEnv = resolve({}, { settings, envFile });
    assert.strictEqual(noEnv.config.limits.maxDueEventsPerPass, 20);
    assert.strictEqual(noEnv.sources[KEY], ".env");
    const settingsOnly = resolve({}, { settings });
    assert.strictEqual(settingsOnly.config.limits.maxDueEventsPerPass, 10);
    assert.strictEqual(settingsOnly.sources[KEY], "settings.json");
    const bare = resolve({});
    assert.strictEqual(bare.config.limits.maxDueEventsPerPass, 64);
    assert.strictEqual(bare.sources[KEY], "default");
    assert.deepStrictEqual(bare.warnings, []);
    assert.ok(Object.isFrozen(bare.config.limits), "config is frozen deep");

    const off = resolve({ EVEJS_LNE_ENABLED: "0" });
    assert.strictEqual(off.config.enabled, false);
    assert.strictEqual(off.sources.enabled, "environment");
    assert.strictEqual(config.isModuleEnabled(off.config, "graph"), false);
    assert.strictEqual(config.isModuleEnabled(bare.config, "graph"), true);
    assert.strictEqual(config.isModuleEnabled(bare.config, "sites"), false, "Danger module off by default");
    assert.strictEqual(config.isModuleEnabled(bare.config, "nope"), false);

    assert.strictEqual(config.parseSettingsJson("\uFEFF{}").ok, true);
    assert.strictEqual(config.parseEnvFile("\uFEFFEVEJS_LNE_DEBUG=1").values.EVEJS_LNE_DEBUG, "1");
  });

  test("C2 bad values: unparsable -> default, clamp, reject, timeScale ignored/accelerated warning; dataDir from env", () => {
    const abc = resolve({ [ENV]: "abc" });
    assert.strictEqual(abc.ok, true);
    assert.strictEqual(abc.config.limits.maxDueEventsPerPass, 64);
    assert.ok(has(abc.warnings, ENV), abc.warnings.join("\n"));

    const big = resolve({ [ENV]: "99999" });
    assert.strictEqual(big.config.limits.maxDueEventsPerPass, 1024);
    assert.ok(has(big.warnings, `${ENV}="99999" above maximum 1024 - clamped to 1024`), big.warnings.join("\n"));

    const rejected = resolve({ EVEJS_LNE_TEST_TIME_SCALE: "1000" });
    assert.strictEqual(rejected.config.testing.timeScale, 1);
    assert.ok(has(rejected.warnings, "EVEJS_LNE_TEST_TIME_SCALE"), rejected.warnings.join("\n"));
    const fast = resolve({ EVEJS_LNE_TEST_TIME_SCALE: "10" });
    assert.strictEqual(fast.config.testing.timeScale, 10);
    assert.ok(has(fast.warnings, "testing.timeScale=10 ignored"), fast.warnings.join("\n"));
    assert.ok(!has(fast.warnings, "accelerated virtual time"), fast.warnings.join("\n"));
    const opted = resolve({ EVEJS_LNE_TEST_TIME_SCALE: "10", EVEJS_LNE_TEST_ACCELERATION: "1" });
    assert.ok(has(opted.warnings, "accelerated virtual time"), opted.warnings.join("\n"));

    assert.strictEqual(resolve({ EVEJS_DATA_ROOT: "/tmp/x" }).config.dataDir,
      path.join(path.resolve("/tmp/x"), "mods", "livingNewEden"));
    assert.strictEqual(resolve({}).config.dataDir,
      path.join(path.resolve(MOD_DIR, "..", ".."), "_local", "mods", "livingNewEden"));
  });

  test("C5 (B4) test profile: bad dbFile -> world.sqlite + warning, bench.sqlite warns, bench clamp", () => {
    const bad = resolve({ EVEJS_LNE_PERSISTENCE_DB_FILE: "../x.sqlite" });
    assert.strictEqual(bad.ok, true);
    assert.strictEqual(bad.config.persistence.dbFile, "world.sqlite");
    assert.ok(has(bad.warnings, "EVEJS_LNE_PERSISTENCE_DB_FILE=\"../x.sqlite\" is not a file name"),
      bad.warnings.join("\n"));
    for (const name of ["benchXsqlite", "a/sqlite"]) {
      const odd = resolve({ EVEJS_LNE_PERSISTENCE_DB_FILE: name });
      assert.strictEqual(odd.config.persistence.dbFile, "world.sqlite", name);
    }
    const bench = resolve({ EVEJS_LNE_PERSISTENCE_DB_FILE: "bench.sqlite" });
    assert.strictEqual(bench.config.persistence.dbFile, "bench.sqlite");
    assert.ok(has(bench.warnings, "persistence.dbFile=bench.sqlite - test profile, not the world database"),
      bench.warnings.join("\n"));
    const many = resolve({ EVEJS_LNE_TEST_BENCH_FLEETS: "9999" });
    assert.strictEqual(many.config.testing.benchFleets, 5000);
    assert.ok(has(many.warnings, "testing.benchFleets=5000 - test fleets"), many.warnings.join("\n"));
  });

  test("C3 loadConfig on files: values read, broken files -> errors and all asleep, absent -> defaults, silent", () => {
    const methods = ["log", "info", "warn", "error", "debug"];
    const saved = methods.map((m) => console[m]);
    let calls = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-config-"));
    try {
      for (const m of methods) console[m] = () => { calls += 1; };
      const settingsFilePath = path.join(dir, "settings.json");
      const envFilePath = path.join(dir, ".env");
      const opts = { modDir: dir, env: {}, settingsFilePath, envFilePath };

      fs.writeFileSync(settingsFilePath, JSON.stringify({ debug: true, limits: { maxVirtualFleets: 200 } }));
      fs.writeFileSync(envFilePath, "# comment\nEVEJS_LNE_MAX_CATCH_UP_EVENTS_PER_PASS=8\n");
      const good = config.loadConfig(opts);
      assert.strictEqual(good.ok, true, good.errors.join("\n"));
      assert.strictEqual(good.config.debug, true);
      assert.strictEqual(good.config.limits.maxVirtualFleets, 200);
      assert.strictEqual(good.config.limits.maxCatchUpEventsPerPass, 8);

      fs.writeFileSync(settingsFilePath, "{bad");
      fs.rmSync(envFilePath);
      fs.mkdirSync(envFilePath);
      const broken = config.loadConfig(opts);
      assert.strictEqual(broken.ok, false);
      assert.strictEqual(broken.errors.length, 2, broken.errors.join("\n"));
      assert.strictEqual(broken.config.enabled, false);
      for (const name of config.MODULE_NAMES) assert.strictEqual(broken.config.modules[name].enabled, false, name);

      fs.rmSync(settingsFilePath);
      fs.rmdirSync(envFilePath);
      const absent = config.loadConfig(opts);
      assert.strictEqual(absent.ok, true);
      assert.strictEqual(absent.config.limits.maxVirtualFleets, 1000, "Default");
      assert.deepStrictEqual(absent.warnings, []);
    } finally {
      methods.forEach((m, i) => { console[m] = saved[i]; });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.strictEqual(calls, 0, "config.js must never print");
  });

  test("CF-D changed defaults: value + source default, env override wins", () => {
    const changed = [{ key: "limits.maxVirtualFleets", env: "EVEJS_LNE_MAX_VIRTUAL_FLEETS", def: 1000, override: 542 },
      { key: "sovStructures.enabled", env: "EVEJS_LNE_SOV_STRUCTURES_ENABLED", def: true, override: false },
      { key: "fortress.haltMemoryDetourMaxJumps", env: "EVEJS_LNE_FORTRESS_HALT_MEMORY_DETOUR_MAX_JUMPS",
        def: 30, override: 12 }];
    const read = (cfg, key) => key.split(".").reduce((node, part) => node[part], cfg);
    for (const { key, env, def, override } of changed) {
      const bare = resolve({});
      assert.strictEqual(read(bare.config, key), def, key);
      assert.strictEqual(bare.sources[key], "default", key);
      const over = resolve({ [env]: String(override) });
      assert.strictEqual(read(over.config, key), override, key);
      assert.strictEqual(over.sources[key], "environment", key);
    }
    const bare = resolve({});
    assert.ok(bare.config.fortress.haltMemoryDetourMaxJumps <= bare.config.graph.routeMaxJumps, "detour <= route");
  });

  test("GD4 galaxy-density: defaults with every review module on -> 976 review rows (returns, defense) "
    + "no warnings", () => {
    const { reviewRowBound } = require("../../lib/strategy/reviewRows");
    const bare = resolve({});
    assert.deepStrictEqual(bare.warnings, []);
    const c = bare.config;
    const on = [c.modules.strategy.enabled, c.mining.enabled, c.production.enabled, c.upkeep.enabled,
      c.logistics.enabled, c.construction.enabled, c.stations.enabled, c.siege.enabled, c.siege.reliefEnabled,
      c.trade.enabled];
    assert.ok(on.every((v) => v === true), JSON.stringify(on));
    const { reliefRows } = require("../../lib/strategy/reviewRows");
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview }];
    assert.strictEqual(c.strategy.defenseEnabled, true);
    const rows = reviewRowBound(...args, { maxDefensePerReview: c.strategy.maxDefensePerReview });
    assert.strictEqual(rows, 976);
    assert.strictEqual(rows - reviewRowBound(...args, null), reliefRows(c.strategy.maxFleetsPerOperation));
    assert.ok(rows <= c.persistence.maxRowsPerTransaction, `${rows} > ${c.persistence.maxRowsPerTransaction}`);
  });

  test("GD4b galaxy-density: defense disabled -> 941 review rows, no warnings", () => {
    const { reviewRowBound } = require("../../lib/strategy/reviewRows");
    const OFF = { EVEJS_LNE_STRATEGY_DEFENSE_ENABLED: "0" };
    const cfg = resolve(OFF);
    assert.deepStrictEqual(cfg.warnings, []);
    assert.strictEqual(cfg.config.strategy.defenseEnabled, false);
    const c = cfg.config;
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview }];
    const rows = reviewRowBound(...args, null);
    assert.strictEqual(rows, 941);
    assert.ok(rows <= c.persistence.maxRowsPerTransaction, `${rows} > ${c.persistence.maxRowsPerTransaction}`);
  });

  test("TA4 concord-empire-tribute config: tribute.* defaults (enabled false), GD4 args + tribute {} -> 956, "
    + "TRIBUTE_MARKER_ROWS = economy/schema, warning with tribute on and logistics off (976 / 977)", () => {
    const { reviewRowBound, TRIBUTE_MARKER_ROWS } = require("../../lib/strategy/reviewRows");
    const economy = require("../../lib/economy/schema");
    const bare = resolve({});
    assert.deepStrictEqual(bare.warnings, []);
    const c = bare.config;
    assert.deepStrictEqual({ ...c.tribute }, { enabled: false, ratePermille: 100, periodMs: 86400000, reserveRuns: 8,
      minLoadVolume: 100000, recipientMaxMineralUnits: 0, recipientBuildsHulls: false,
      maxRecipientStations: 4 });
    assert.strictEqual(TRIBUTE_MARKER_ROWS, economy.TRIBUTE_MARKER_ROWS);
    assert.strictEqual(TRIBUTE_MARKER_ROWS, 1);
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview },
      { maxDefensePerReview: c.strategy.maxDefensePerReview }];
    assert.strictEqual(reviewRowBound(...args), 976, "no 10th argument = tribute off");
    assert.strictEqual(reviewRowBound(...args, null), 976);
    assert.strictEqual(reviewRowBound(...args, {}), 977);
    const on = resolve({ EVEJS_LNE_TRIBUTE_ENABLED: "1" });
    assert.deepStrictEqual(on.warnings, []);
    assert.strictEqual(on.config.tribute.enabled, true);
    const noLogistics = resolve({ EVEJS_LNE_TRIBUTE_ENABLED: "1", EVEJS_LNE_LOGISTICS_ENABLED: "0" });
    const warning = "tribute.enabled with logistics or production off - no tribute convoy is planned";
    assert.ok(noLogistics.warnings.includes(warning), noLogistics.warnings.join("\n"));
    assert.ok(!resolve({ EVEJS_LNE_LOGISTICS_ENABLED: "0" }).warnings.some((w) => w.startsWith("tribute.")));
  });

  test("SLR4 tribute-c (flip): logistics.strandedReturnEnabled true / strandedReturnMaxJumps 40 "
    + "(clamp 1..150), warning above graph.routeMaxJumps only with the flag; reviewRowBound counts the retire budget "
    + "with retireEnabled=false and strandedReturnEnabled=true, defaults unchanged (GD4 976)", () => {
    const { reviewRowBound, RETIRE_ROWS } = require("../../lib/strategy/reviewRows");
    const bare = resolve({});
    const c = bare.config;
    assert.deepStrictEqual([c.logistics.strandedReturnEnabled, c.logistics.strandedReturnMaxJumps], [true, 40]);
    assert.strictEqual(resolve({ EVEJS_LNE_LOGISTICS_STRANDED_RETURN_MAX_JUMPS: "500" }).config.logistics
      .strandedReturnMaxJumps, 150);
    const warning = "logistics.strandedReturnMaxJumps=41 above graph.routeMaxJumps=40 - a station further away "
      + "cannot be routed to";
    assert.deepStrictEqual(resolve({ EVEJS_LNE_LOGISTICS_STRANDED_RETURN_MAX_JUMPS: "41",
      EVEJS_LNE_LOGISTICS_STRANDED_RETURN_ENABLED: "0", EVEJS_LNE_LOGISTICS_STRANDED_FROM_STATIONS_ENABLED: "0" })
      .warnings, []);
    assert.deepStrictEqual(resolve({ EVEJS_LNE_LOGISTICS_STRANDED_RETURN_MAX_JUMPS: "41" }).warnings, [warning]);
    const args = (l) => [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      l, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview },
      { maxDefensePerReview: c.strategy.maxDefensePerReview }];
    const base = reviewRowBound(...args(c.logistics));
    assert.strictEqual(base, 976);
    const noRetire = reviewRowBound(...args({ ...c.logistics, retireEnabled: false, strandedReturnEnabled: false }));
    assert.strictEqual(base - noRetire, c.logistics.maxRetiresPerReview * RETIRE_ROWS);
    assert.strictEqual(reviewRowBound(...args({ ...c.logistics, retireEnabled: false, strandedReturnEnabled: true })),
      base);
    assert.strictEqual(reviewRowBound(...args({ ...c.logistics, strandedReturnEnabled: true })), base);
    assert.deepStrictEqual([c.logistics.strandedFromStationsEnabled, c.logistics.strandedMaxStationBfs], [true, 4]);
    assert.deepStrictEqual(["0", "33"].map((v) => resolve({ EVEJS_LNE_LOGISTICS_STRANDED_MAX_STATION_BFS: v })
      .config.logistics.strandedMaxStationBfs), [1, 32]);
    const fsWarning = "logistics.strandedFromStationsEnabled has no effect while logistics.strandedReturnEnabled=false";
    assert.deepStrictEqual(resolve({ EVEJS_LNE_LOGISTICS_STRANDED_FROM_STATIONS_ENABLED: "1",
      EVEJS_LNE_LOGISTICS_STRANDED_RETURN_ENABLED: "0" }).warnings, [fsWarning]);
    assert.deepStrictEqual(resolve({ EVEJS_LNE_LOGISTICS_STRANDED_RETURN_ENABLED: "0" }).warnings, [fsWarning]);
    assert.deepStrictEqual(resolve({ EVEJS_LNE_LOGISTICS_STRANDED_FROM_STATIONS_ENABLED: "1" }).warnings, []);
    assert.strictEqual(reviewRowBound(...args({ ...c.logistics, strandedFromStationsEnabled: true })), base);
  });

  test("GD5 SWEEP galaxy-density: strategy.maxReturnsPerReview=11 -> review bound 1001 > 1000 -> warning", () => {
    const OFF = { EVEJS_LNE_STRATEGY_DEFENSE_ENABLED: "0", EVEJS_LNE_TREASURY_ENABLED: "0",
      EVEJS_LNE_STRATEGY_MERGE_ENABLED: "0", EVEJS_LNE_SENTRIES_FACTION_ENABLED: "0" };
    const at10 = resolve({ ...OFF, EVEJS_LNE_STRATEGY_MAX_RETURNS_PER_REVIEW: "10" });
    assert.deepStrictEqual(at10.warnings, []);
    const at11 = resolve({ ...OFF, EVEJS_LNE_STRATEGY_MAX_RETURNS_PER_REVIEW: "11" });
    assert.strictEqual(at11.config.strategy.maxReturnsPerReview, 11);
    assert.deepStrictEqual(at11.warnings, ["one strategy review may write 1001 rows > persistence.maxRowsPerTransaction="
      + "1000 - lower strategy.max*PerReview"]);
  });

  test("PB7 physical budget config (P3): perSystem above global -> warning, the global limit binds", () => {
    const inverted = resolve({ EVEJS_LNE_MAX_LIVE_MATERIALIZATIONS_PER_SYSTEM: "200",
      EVEJS_LNE_MAX_LIVE_MATERIALIZATIONS_GLOBAL: "100" });
    assert.strictEqual(inverted.config.limits.maxLiveMaterializationsPerSystem, 200);
    assert.deepStrictEqual(inverted.warnings, ["limits.maxLiveMaterializationsPerSystem=200 above "
      + "limits.maxLiveMaterializationsGlobal=100 - the global limit binds"]);
  });

  test("trade config: privateOfferTtlMs > contractTtlMs warns when trade.enabled=true (regardless of strategy), not when trade disabled", () => {
    const base = { EVEJS_LNE_TRADE_ENABLED: "1", EVEJS_LNE_TRADE_PRIVATE_OFFER_TTL_MS: "259200000", EVEJS_LNE_TRADE_CONTRACT_TTL_MS: "86400000" };
    const tradeOnStrategyOff = resolve({ ...base, EVEJS_LNE_STRATEGY_ENABLED: "0" });
    assert.ok(has(tradeOnStrategyOff.warnings, "trade.privateOfferTtlMs > trade.contractTtlMs"), tradeOnStrategyOff.warnings.join("\n"));
    const tradeOnStrategyOn = resolve({ ...base, EVEJS_LNE_STRATEGY_ENABLED: "1" });
    assert.ok(has(tradeOnStrategyOn.warnings, "trade.privateOfferTtlMs > trade.contractTtlMs"), tradeOnStrategyOn.warnings.join("\n"));
    const tradeOff = resolve({ ...base, EVEJS_LNE_TRADE_ENABLED: "0", EVEJS_LNE_STRATEGY_ENABLED: "1" });
    assert.ok(!has(tradeOff.warnings, "trade.privateOfferTtlMs > trade.contractTtlMs"), tradeOff.warnings.join("\n"));
  });

  test("FLG3 bug-fleet-limit-garrisons: defaults read 256 fleets, no fleet-sum warning "
    + "maxFleetsReadPerReview=64 -> warning names the garrisons (32+10+4+2+150 = 198)", () => {
    const def = resolve({});
    assert.strictEqual(def.config.strategy.maxFleetsReadPerReview, 256);
    assert.ok(!has(def.warnings, "strategy.maxFleetsReadPerReview="), def.warnings.join("\n"));
    const low = resolve({ EVEJS_LNE_STRATEGY_MAX_FLEETS_READ_PER_REVIEW: "64" });
    const line = low.warnings.find((w) => w.includes("strategy.maxFleetsReadPerReview=64"));
    assert.ok(line && line.includes("garrison") && line.includes("hunt.maxHuntersPerFaction")
      && line.includes("= 198 (32 + 10 + 4 + 2 + 150)"), low.warnings.join("\n"));
  });

  test("PRC1 perf-review-cleanups (flip): reactive 'nothing to do' warns only when reactiveEnabled is explicit", () => {
    const TEXT = "reactive review has nothing to do";
    const off = { EVEJS_LNE_STRATEGY_DEFENSE_ENABLED: "0", EVEJS_LNE_SIEGE_RELIEF_ENABLED: "0" };
    const byDefault = resolve(off);
    assert.strictEqual(byDefault.config.strategy.reactiveEnabled, true);
    assert.strictEqual(byDefault.sources["strategy.reactiveEnabled"], "default");
    assert.ok(!has(byDefault.warnings, TEXT), byDefault.warnings.join("\n"));
    const fromEnv = resolve({ ...off, EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "1" });
    assert.ok(has(fromEnv.warnings, TEXT), fromEnv.warnings.join("\n"));
    const fromEnvFile = resolve(off, { envFile: { EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "1" } });
    assert.ok(has(fromEnvFile.warnings, TEXT), fromEnvFile.warnings.join("\n"));
    const fromSettings = resolve(off, { settings: { strategy: { reactiveEnabled: true } } });
    assert.strictEqual(fromSettings.sources["strategy.reactiveEnabled"], "settings.json");
    assert.ok(has(fromSettings.warnings, TEXT), fromSettings.warnings.join("\n"));
  });

  test("GFR1 BUG idle-fleets: occupation.garrisonFromRoles default, none, unknown role refused", () => {
    const ENV_KEY = "EVEJS_LNE_OCCUPATION_GARRISON_FROM_ROLES";
    const def = resolve({});
    assert.strictEqual(def.config.occupation.garrisonFromRoles, "invasion,patrol,scout,reserve");
    assert.ok(!has(def.warnings, "occupation.garrisonFromRoles"), def.warnings.join("\n"));
    const none = resolve({ [ENV_KEY]: "none" });
    assert.strictEqual(none.config.occupation.garrisonFromRoles, "none");
    assert.ok(!has(none.warnings, ENV_KEY), none.warnings.join("\n"));
    for (const bad of ["scout,ghost", "scout,scout", "scout,"]) {
      const r = resolve({ [ENV_KEY]: bad });
      assert.strictEqual(r.config.occupation.garrisonFromRoles, "invasion,patrol,scout,reserve", bad);
      assert.ok(has(r.warnings, `${ENV_KEY}=`) && has(r.warnings, "FLEET_ROLES"), r.warnings.join("\n"));
    }
  });
};
