"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE = "compose.yaml";
const COMPOSE_SEARCH_MAX_DEPTH = 5;
const NAME_RE = /EVEJS_LNE_[A-Z0-9_]+/g;
const ENTRY_RE = /^\s*(EVEJS_LNE_[A-Z0-9_]+)\s*:\s*(.*?)\s*$/;
const DEFAULT_RE = /^\$\{(EVEJS_LNE_[A-Z0-9_]+):?-(.*)\}$/;
const NO_DEFAULT_RE = /^\$\{EVEJS_LNE_[A-Z0-9_]+\}$/;
const NOT_A_SETTING = Object.freeze({});
const COMPOSE_ROW_LIMIT = 1800;

function findCompose() {
  let dir = path.dirname(MOD_DIR);
  for (let i = 0; i < COMPOSE_SEARCH_MAX_DEPTH; i += 1) {
    const file = path.join(dir, COMPOSE_FILE);
    if (fs.existsSync(file)) return file;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function unquote(v) {
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

function readCompose(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const names = [...new Set(text.match(NAME_RE) || [])].sort();
  const env = {};
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const value = unquote(m[2].replace(/\s+#.*$/, ""));
    if (NO_DEFAULT_RE.test(value)) continue;
    const d = DEFAULT_RE.exec(value);
    env[m[1]] = d ? unquote(d[2]) : value;
  }
  return { names, env };
}

module.exports = ({ test, skip }) => {
  const file = findCompose();
  if (!file) {
    skip("CK1-2 compose keys", "compose.yaml not found above the mod (Docker image)");
    return;
  }

  test("CK1 compose keys: every EVEJS_LNE_* name of compose.yaml is a SCHEMA env or reserved", () => {
    const known = new Set([...config.SCHEMA.map((row) => row.env), ...config.RESERVED_ENV]);
    const { names } = readCompose(file);
    assert.ok(names.length > 0, `${file}: no EVEJS_LNE_* name`);
    const unknown = names.filter((n) => !known.has(n) && !NOT_A_SETTING[n]);
    assert.deepStrictEqual(unknown, [], `compose.yaml names outside SCHEMA (typo = silent default): ${unknown.join(", ")}`);
  });

  test("CK2 compose keys: resolveConfig accepts every compose default value", () => {
    const { env } = readCompose(file);
    assert.ok(Object.keys(env).length > 0, `${file}: no EVEJS_LNE_* entry with a value`);
    const r = config.resolveConfig({ env, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
    const rejected = r.warnings.filter((w) => Object.keys(env).some((n) => w.startsWith(`${n}=`)));
    const other = r.warnings.filter((w) => !rejected.includes(w));
    if (other.length > 0) console.log(`     CK2 cross-key warnings (allowed): ${other.join("; ")}`);
    assert.deepStrictEqual(rejected, [], `compose values rejected by the config: ${rejected.join("; ")}`);
  });

  test("CK3 compose keys: the 10 grid flags pass through compose with default 0", () => {
    const GRID_FLAGS = [
      "EVEJS_LNE_GRID_ENABLED",
      "EVEJS_LNE_GRID_MOVES_ENABLED",
      "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED",
      "EVEJS_LNE_GRID_DEFENSE_ENABLED",
      "EVEJS_LNE_GRID_CROSSINGS_ENABLED",
      "EVEJS_LNE_SIEGE_GRID_ENABLED",
      "EVEJS_LNE_GRID_CROSSINGS_BLOCKADE_GATE_ENABLED",
      "EVEJS_LNE_SENTRIES_BATTLE_GRID_ENABLED",
      "EVEJS_LNE_MATERIALIZATION_GRID_ANCHOR_ENABLED",
      "EVEJS_LNE_GRID_DEFENSE_STRIKE_PURSUIT_ENABLED",
    ];
    const { names, env } = readCompose(file);
    const missing = GRID_FLAGS.filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `grid flags missing in compose.yaml: ${missing.join(", ")}`);
    const notZero = GRID_FLAGS.filter((n) => env[n] !== "0").map((n) => `${n}=${env[n]}`);
    assert.deepStrictEqual(notZero, [], `grid flags with a compose default other than 0: ${notZero.join(", ")}`);
  });

  test(`CK4 compose keys: phase A + fortress fit the compose row limit ${COMPOSE_ROW_LIMIT}`, () => {
    const { rowBoundsOfConfig, rowBoundOverflow } = require("../../lib/strategy/reviewBound");
    const PHASE_A_FLAGS = [
      "EVEJS_LNE_GRID_ENABLED",
      "EVEJS_LNE_GRID_MOVES_ENABLED",
      "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED",
      "EVEJS_LNE_GRID_DEFENSE_ENABLED",
      "EVEJS_LNE_GRID_CROSSINGS_ENABLED",
      "EVEJS_LNE_GRID_CROSSINGS_BLOCKADE_GATE_ENABLED",
      "EVEJS_LNE_SIEGE_GRID_ENABLED",
      "EVEJS_LNE_SENTRIES_BATTLE_GRID_ENABLED",
    ];
    const env = { ...readCompose(file).env, EVEJS_LNE_FORTRESS_CHECKPOINT_ENABLED: "1", EVEJS_LNE_HUNT_ENABLED: "1" };
    for (const n of PHASE_A_FLAGS) env[n] = "1";
    const r = config.resolveConfig({ env, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
    assert.strictEqual(r.config.persistence.maxRowsPerTransaction, COMPOSE_ROW_LIMIT);
    const bound = r.warnings.filter((w) => w.startsWith("one strategy review may write"));
    assert.deepStrictEqual(bound, [], `review bound warning: ${bound.join("; ")}`);
    const bounds = rowBoundsOfConfig(r.config);
    assert.strictEqual(rowBoundOverflow(bounds, COMPOSE_ROW_LIMIT), null);
    console.log(`     CK4 phase A review bound: review=${bounds.review}`);

    const r1000 = config.resolveConfig({ env: { ...env, EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "1000" },
      modDir: MOD_DIR });
    assert.deepStrictEqual(r1000.errors, []);
    const b1000 = rowBoundsOfConfig(r1000.config);
    if (b1000.review > 1000) assert.notStrictEqual(rowBoundOverflow(b1000, 1000), null);
  });

  test("CK5 compose keys: power sites keys pass through with the mod defaults, the gate timings resolve", () => {
    const POWER_KEYS = ["enabled", "planIntervalMs", "maxOpen", "maxOpenPerFaction", "systemCooldownMs",
      "plannedTtlMinMs", "plannedTtlMaxMs", "pocketTtlMs", "trailPockets", "escapeAfterMs", "musterWaves",
      "musterWaveIntervalMs", "musterWaveGrowthPermille", "minFreeSiteSlots", "outpostWeight", "cacheWeight",
      "trailWeight", "huntWeight", "convoyWeight", "musterWeight"];
    const { env } = readCompose(file);
    const wrong = [];
    for (const name of POWER_KEYS) {
      const row = config.SCHEMA.find((r) => r.key === `powerSites.${name}`);
      assert.ok(row, `no SCHEMA row powerSites.${name}`);
      const want = row.type === "boolean" ? (row.default ? "1" : "0") : String(row.default);
      if (env[row.env] !== want) wrong.push(`${row.env}=${env[row.env]} (mod default ${want})`);
    }
    assert.deepStrictEqual(wrong, [], `power sites keys missing or off the mod default: ${wrong.join(", ")}`);

    const GATE = {
      EVEJS_LNE_POWER_SITES_ENABLED: "1",
      EVEJS_LNE_POWER_SITES_PLAN_INTERVAL_MS: "300000",
      EVEJS_LNE_POWER_SITES_PLANNED_TTL_MIN_MS: "600000",
      EVEJS_LNE_POWER_SITES_PLANNED_TTL_MAX_MS: "900000",
      EVEJS_LNE_POWER_SITES_ESCAPE_AFTER_MS: "60000",
      EVEJS_LNE_POWER_SITES_MUSTER_WAVE_INTERVAL_MS: "60000",
    };
    const r = config.resolveConfig({ env: { ...env, ...GATE }, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
    const rejected = r.warnings.filter((w) => w.includes("POWER_SITES_") || w.includes("powerSites."));
    assert.deepStrictEqual(rejected, [], `gate timings rejected: ${rejected.join("; ")}`);
    const p = r.config.powerSites;
    assert.deepStrictEqual([p.enabled, p.planIntervalMs, p.plannedTtlMinMs, p.plannedTtlMaxMs, p.escapeAfterMs,
      p.musterWaveIntervalMs], [true, 300000, 600000, 900000, 60000, 60000]);
  });

  test(`CK6 compose keys: replenish return passes through with 0 and fits the row limit ${COMPOSE_ROW_LIMIT} with phase A`,
    () => {
    const { rowBoundsOfConfig, rowBoundOverflow } = require("../../lib/strategy/reviewBound");
    const FLAG = "EVEJS_LNE_LOGISTICS_REPLENISH_RETURN_ENABLED";
    const compose = readCompose(file);
    assert.ok(compose.names.includes(FLAG), `${FLAG} missing in compose.yaml`);
    assert.strictEqual(compose.env[FLAG], "0");
    const ON = ["EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED", "EVEJS_LNE_STRATEGY_ATTACK_LOSS_MEMORY_ENABLED",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_ISK_GATE_ENABLED", "EVEJS_LNE_FORTRESS_CHECKPOINT_ENABLED",
      "EVEJS_LNE_FORTRESS_ROUTE_AVERSION_ENABLED", "EVEJS_LNE_FORTRESS_HALT_MEMORY_ENABLED", "EVEJS_LNE_HUNT_ENABLED",
      "EVEJS_LNE_GRID_ENABLED", "EVEJS_LNE_GRID_MOVES_ENABLED", "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED",
      "EVEJS_LNE_GRID_DEFENSE_ENABLED", "EVEJS_LNE_GRID_CROSSINGS_ENABLED",
      "EVEJS_LNE_GRID_CROSSINGS_BLOCKADE_GATE_ENABLED", "EVEJS_LNE_SIEGE_GRID_ENABLED",
      "EVEJS_LNE_SENTRIES_BATTLE_GRID_ENABLED", FLAG];
    const env = { ...compose.env };
    for (const n of ON) env[n] = "1";
    const r = config.resolveConfig({ env, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
    const l = r.config.logistics;
    assert.deepStrictEqual([l.enabled, l.replenishEnabled, l.replenishReturnEnabled], [true, true, true]);
    assert.strictEqual(r.config.persistence.maxRowsPerTransaction, COMPOSE_ROW_LIMIT);
    const rowWarn = r.warnings.filter((w) => w.startsWith("one strategy review may write") || w.includes("replenish"));
    assert.deepStrictEqual(rowWarn, [], `row / replenish warnings: ${rowWarn.join("; ")}`);
    const bounds = rowBoundsOfConfig(r.config);
    assert.strictEqual(rowBoundOverflow(bounds, COMPOSE_ROW_LIMIT), null);
    const off = rowBoundsOfConfig(config.resolveConfig({ env: { ...env, [FLAG]: "0" }, modDir: MOD_DIR }).config);
    assert.ok(off.review < bounds.review, `flag adds no review rows: off=${off.review} on=${bounds.review}`);
    console.log(`     CK6 replenish return review bound: on=${bounds.review} off=${off.review}`);
  });

  test("CKH1 compose keys: the 5 highsec life flags and local pilots pass through compose with default 0", () => {
    const FLAGS = [
      "EVEJS_LNE_LOCAL_PILOTS_ENABLED",
      "EVEJS_LNE_HIGHSEC_LIFE_ENABLED",
      "EVEJS_LNE_HIGHSEC_LIFE_CIVILIANS_ENABLED",
      "EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_ENABLED",
      "EVEJS_LNE_HIGHSEC_LIFE_CHATTER_ENABLED",
      "EVEJS_LNE_HIGHSEC_LIFE_GANK_ENABLED",
    ];
    const { names, env } = readCompose(file);
    const missing = FLAGS.filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `highsec life flags missing in compose.yaml: ${missing.join(", ")}`);
    const notZero = FLAGS.filter((n) => env[n] !== "0").map((n) => `${n}=${env[n]}`);
    assert.deepStrictEqual(notZero, [], `highsec life flags with a compose default other than 0: ${notZero.join(", ")}`);
  });

  test("CK7 compose keys: the 17 battle AI keys pass through compose with the SCHEMA defaults", () => {
    const NAMES = [
      "EVEJS_LNE_BATTLE_ASSEMBLY_ENABLED",
      "EVEJS_LNE_BATTLE_ASSEMBLY_GRACE_MS",
      "EVEJS_LNE_BATTLE_ASSEMBLY_RECHECK_MS",
      "EVEJS_LNE_BATTLE_ASSEMBLY_MAX_ROUNDS",
      "EVEJS_LNE_BATTLE_DECLINE_ENABLED",
      "EVEJS_LNE_BATTLE_DECLINE_RATIO_PERMILLE",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_MEMORY_ENABLED",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_THRESHOLD",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_COOLDOWN_MS",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_WINDOW_MS",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_MAX_MULTIPLIER",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_STEP_PERMILLE",
      "EVEJS_LNE_STRATEGY_MAX_ATTACK_LOSS_ROWS_PER_FACTION",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_SETTLE_ROWS",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_ISK_GATE_ENABLED",
      "EVEJS_LNE_STRATEGY_ATTACK_LOSS_SHARE_PERMILLE",
      "EVEJS_LNE_STRATEGY_MAX_ATTACK_LOSS_ROOM_PERMILLE",
    ];
    const { names, env } = readCompose(file);
    const missing = NAMES.filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `battle AI keys missing in compose.yaml: ${missing.join(", ")}`);
    const wrong = [];
    for (const name of NAMES) {
      const row = config.SCHEMA.find((r) => r.env === name);
      assert.ok(row, `no SCHEMA row with env ${name}`);
      const want = row.type === "boolean" ? (row.default ? "1" : "0") : String(row.default);
      if (env[name] !== want) wrong.push(`${name}=${env[name]} (SCHEMA default ${want})`);
    }
    assert.deepStrictEqual(wrong, [], `battle AI keys off the SCHEMA default: ${wrong.join(", ")}`);
  });

  test("CKW1 compose keys: the 4 world flags knobs pass through with an empty default, the 3 flags with 0", () => {
    const EMPTY = [
      "EVEJS_LNE_STRATEGY_HQ_GARRISON_MIN_FLEETS",
      "EVEJS_LNE_STRATEGY_HQ_GARRISON_ROLES",
      "EVEJS_LNE_STRATEGY_HQ_GARRISON_MAX_JUMPS",
      "EVEJS_LNE_UPKEEP_HOME_SPACE_INCOME_PERMILLE",
    ];
    const ZERO = [
      "EVEJS_LNE_STRATEGY_HQ_GARRISON_ENABLED",
      "EVEJS_LNE_UPKEEP_HOME_SPACE_INCOME_ENABLED",
      "EVEJS_LNE_AMBIENT_RATS_HIGHSEC_NAVY",
    ];
    const { names, env } = readCompose(file);
    const missing = [...EMPTY, ...ZERO].filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `world flags keys missing in compose.yaml: ${missing.join(", ")}`);
    const notEmpty = EMPTY.filter((n) => env[n] !== "").map((n) => `${n}=${env[n]}`);
    assert.deepStrictEqual(notEmpty, [], `world flags knobs with a compose default: ${notEmpty.join(", ")}`);
    const notZero = ZERO.filter((n) => env[n] !== "0").map((n) => `${n}=${env[n]}`);
    assert.deepStrictEqual(notZero, [], `world flags with a compose default other than 0: ${notZero.join(", ")}`);
  });

  test("CKB1 compose keys: battleship power keys pass through with the SCHEMA defaults, doctrines stay off", () => {
    const NAMES = ["EVEJS_LNE_STRATEGY_BATTLESHIP_POWER_CALIBRATED", "EVEJS_LNE_STRATEGY_BATTLESHIP_POWER_PERMILLE"];
    const { names, env } = readCompose(file);
    const missing = NAMES.filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `battleship power keys missing in compose.yaml: ${missing.join(", ")}`);
    const got = NAMES.map((name) => {
      const row = config.SCHEMA.find((r) => r.env === name);
      assert.ok(row, `no SCHEMA row with env ${name}`);
      const want = row.type === "boolean" ? (row.default ? "1" : "0") : String(row.default);
      return [env[name], want];
    });
    assert.deepStrictEqual(got, [["0", "0"], ["520", "520"]]);
    assert.strictEqual(env.EVEJS_LNE_STRATEGY_BATTLESHIP_DOCTRINES, "off");
  });

  test("CKS1 compose keys: the ship AI keys pass through with the switches off, the recommended values resolve", () => {
    const ZERO = ["EVEJS_LNE_SHIP_AI_ENABLED", "EVEJS_LNE_SHIP_AI_VOICE_ENABLED"];
    const EMPTY = ["EVEJS_LNE_SHIP_AI_THINKING_CHAT", "EVEJS_LNE_SHIP_AI_THINKING_PROACTIVE",
      "EVEJS_LNE_SHIP_AI_API_KEY", "EVEJS_LNE_SHIP_AI_ALLOW_CHARACTER_IDS", "EVEJS_LNE_SHIP_AI_CHANNEL",
      "EVEJS_LNE_SHIP_AI_LANGUAGE", "EVEJS_LNE_SHIP_AI_TOOL_MODE", "EVEJS_LNE_SHIP_AI_REASONING_OFF",
      "EVEJS_LNE_SHIP_AI_VOICE_ENGINE",
      "EVEJS_LNE_SHIP_AI_VOICE_NAME", "EVEJS_LNE_SHIP_AI_VOICE_FALLBACK_BROWSER", "EVEJS_LNE_SHIP_AI_VOICE_RADIO_FILTER"];
    const { names, env } = readCompose(file);
    const missing = [...ZERO, ...EMPTY].filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `ship AI keys missing in compose.yaml: ${missing.join(", ")}`);
    const wrong = [...ZERO.filter((n) => env[n] !== "0"), ...EMPTY.filter((n) => env[n] !== "")]
      .map((n) => `${n}=${env[n]}`);
    assert.deepStrictEqual(wrong, [], `ship AI keys off the compose default: ${wrong.join(", ")}`);
    const off = config.resolveConfig({ env, modDir: MOD_DIR }).config.shipAi;
    assert.deepStrictEqual([off.enabled, off.voiceEnabled, off.thinkingChat, off.thinkingProactive],
      [false, false, false, false]);

    const PM = { EVEJS_LNE_SHIP_AI_ENABLED: "1", EVEJS_LNE_SHIP_AI_THINKING_CHAT: "1",
      EVEJS_LNE_SHIP_AI_THINKING_PROACTIVE: "1", EVEJS_LNE_SHIP_AI_VOICE_ENABLED: "1" };
    const r = config.resolveConfig({ env: { ...env, ...PM }, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
    const rejected = r.warnings.filter((w) => w.includes("SHIP_AI_") || w.includes("shipAi."));
    assert.deepStrictEqual(rejected, [], `ship AI recommended values rejected: ${rejected.join("; ")}`);
    const on = r.config.shipAi;
    assert.deepStrictEqual([on.enabled, on.voiceEnabled, on.thinkingChat, on.thinkingProactive, on.voiceEngine],
      [true, true, true, true, "browser"]);
    assert.deepStrictEqual([off.voiceName, off.voiceFallbackBrowser, off.voiceRadioFilter], ["", true, true]);
    const voice = config.resolveConfig({ env: { ...env, EVEJS_LNE_SHIP_AI_VOICE_NAME: "Paulina",
      EVEJS_LNE_SHIP_AI_VOICE_FALLBACK_BROWSER: "0", EVEJS_LNE_SHIP_AI_VOICE_RADIO_FILTER: "0" }, modDir: MOD_DIR });
    assert.deepStrictEqual(voice.warnings.filter((w) => w.includes("SHIP_AI_VOICE")), []);
    const v = voice.config.shipAi;
    assert.deepStrictEqual([v.voiceName, v.voiceFallbackBrowser, v.voiceRadioFilter], ["Paulina", false, false]);
  });

  test("CKU1 compose keys: the upkeep knobs pass through with an empty default, the flags with 0", () => {
    const EMPTY = ["EVEJS_LNE_UPKEEP_OFFENSIVE_RESERVE_PERIODS", "EVEJS_LNE_UPKEEP_DEFICIT_RELIEF_AFTER_UNPAID_PERIODS",
      "EVEJS_LNE_UPKEEP_DEFICIT_RELIEF_MARGIN_PERMILLE", "EVEJS_LNE_UPKEEP_MAX_DISBANDS_PER_REVIEW"];
    const ZERO = ["EVEJS_LNE_UPKEEP_DEFICIT_RELIEF_ENABLED"];
    const { names, env } = readCompose(file);
    const missing = [...EMPTY, ...ZERO].filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `upkeep keys missing in compose.yaml: ${missing.join(", ")}`);
    const wrong = [...EMPTY.filter((n) => env[n] !== ""), ...ZERO.filter((n) => env[n] !== "0")]
      .map((n) => `${n}=${env[n]}`);
    assert.deepStrictEqual(wrong, [], `upkeep keys off the compose default: ${wrong.join(", ")}`);
    const row = config.SCHEMA.find((r) => r.env === "EVEJS_LNE_UPKEEP_OFFENSIVE_RESERVE_PERIODS");
    assert.ok(row, "no SCHEMA row with env EVEJS_LNE_UPKEEP_OFFENSIVE_RESERVE_PERIODS");
    assert.strictEqual(row.default, 24);
    const r = config.resolveConfig({ env: { EVEJS_LNE_UPKEEP_OFFENSIVE_RESERVE_PERIODS: "" }, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
    assert.strictEqual(r.config.upkeep.offensiveReservePeriods, 24);
    const pm = config.resolveConfig({ env: { ...env, EVEJS_LNE_UPKEEP_OFFENSIVE_RESERVE_PERIODS: "12" }, modDir: MOD_DIR });
    assert.strictEqual(pm.config.upkeep.offensiveReservePeriods, 12);
    const u = config.resolveConfig({ env, modDir: MOD_DIR }).config.upkeep;
    assert.deepStrictEqual([u.deficitReliefEnabled, u.deficitReliefAfterUnpaidPeriods, u.deficitReliefMarginPermille,
      u.maxDisbandsPerReview], [false, 3, 20, 1]);
  });

  test("CKO1 compose keys: siege repel cooldown 0, claim hold states empty, garrison consolidate 0; recommended values", () => {
    const NAMES = { cool: "EVEJS_LNE_SIEGE_REPEL_COOLDOWN_MS", states: "EVEJS_LNE_STRATEGY_CLAIM_HOLD_STATES",
      consol: "EVEJS_LNE_STRATEGY_GARRISON_CONSOLIDATE_ENABLED" };
    const { names, env } = readCompose(file);
    const missing = Object.values(NAMES).filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `conquest audit keys missing in compose.yaml: ${missing.join(", ")}`);
    assert.deepStrictEqual([env[NAMES.cool], env[NAMES.states], env[NAMES.consol]], ["0", "", "0"]);
    const d = config.resolveConfig({ env, modDir: MOD_DIR });
    assert.deepStrictEqual(d.errors, [], `resolveConfig errors: ${d.errors.join("; ")}`);
    assert.deepStrictEqual([d.config.siege.repelCooldownMs, d.config.strategy.claimHoldStates,
      d.config.strategy.garrisonConsolidateEnabled], [0, "CONTESTED,INVASION", false]);
    const pm = config.resolveConfig({ env: { ...env, [NAMES.cool]: "86400000",
      [NAMES.states]: "CONTESTED,INVASION,OCCUPIED,CONSOLIDATING", [NAMES.consol]: "1" }, modDir: MOD_DIR });
    assert.deepStrictEqual(pm.errors, [], `resolveConfig errors: ${pm.errors.join("; ")}`);
    assert.deepStrictEqual([pm.config.siege.repelCooldownMs, pm.config.strategy.claimHoldStates,
      pm.config.strategy.garrisonConsolidateEnabled], [86400000, "CONTESTED,INVASION,OCCUPIED,CONSOLIDATING", true]);
    const ours = pm.warnings.filter((w) => Object.values(NAMES).some((n) => w.startsWith(`${n}=`))
      || w.startsWith("siege.repelCooldownMs=") || w.startsWith("strategy.claimHoldMaxMs="));
    assert.deepStrictEqual(ours, [], `recommended values warned: ${ours.join("; ")}`);
  });

  test("CKC1 compose keys: the ship AI callout keys pass through empty = on and 250000 m", () => {
    const NAMES = ["EVEJS_LNE_SHIP_AI_CALLOUT_ENABLED", "EVEJS_LNE_SHIP_AI_CALLOUT_GRID_RANGE_METERS"];
    const { names, env } = readCompose(file);
    const missing = NAMES.filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `callout keys missing in compose.yaml: ${missing.join(", ")}`);
    assert.deepStrictEqual(NAMES.map((n) => env[n]), ["", ""]);
    const c = config.resolveConfig({ env, modDir: MOD_DIR }).config.shipAi;
    assert.deepStrictEqual([c.calloutEnabled, c.calloutGridRangeMeters], [true, 250000]);
    assert.deepStrictEqual([c.calloutInboundEnabled, c.calloutInboundMax], [true, 8]);
  });

  test("CKE1 compose keys: the escalation keys pass through with the flags 0, the knobs empty, the attach order", () => {
    const ORDER = "dreadnought,carrier,force_auxiliary,supercarrier,titan";
    const FLAGS = ["strategy.escalationEnabled", "playerHunt.escalationEnabled", "playerHunt.detachmentMatchEnabled"];
    const KNOBS = ["strategy.escalationFleetsL1", "strategy.escalationFleetsL2", "strategy.escalationFleetsL3",
      "strategy.escalationValueBonus", "strategy.escalationLossStep", "strategy.escalationMaxLevel",
      "strategy.escalationCapitalMinLevel", "strategy.escalationSuperMinLevel", "playerHunt.escalationWindowMs",
      "playerHunt.escalationMaxHeat", "playerHunt.escalationScalePermille", "playerHunt.escalationMaxApproachJumps"];
    const rowOf = (key) => {
      const row = config.SCHEMA.find((r) => r.key === key);
      assert.ok(row, `no SCHEMA row ${key}`);
      return row;
    };
    const keys = [...FLAGS, ...KNOBS, "strategy.capitalAttachOrder"];
    assert.strictEqual(keys.length, 16);
    const { names, env } = readCompose(file);
    const missing = keys.map((k) => rowOf(k).env).filter((n) => !names.includes(n));
    assert.deepStrictEqual(missing, [], `escalation keys missing in compose.yaml: ${missing.join(", ")}`);
    const wrong = [...FLAGS.filter((k) => env[rowOf(k).env] !== "0"), ...KNOBS.filter((k) => env[rowOf(k).env] !== "")]
      .map((k) => `${rowOf(k).env}=${env[rowOf(k).env]}`);
    assert.deepStrictEqual(wrong, [], `escalation keys off the compose default: ${wrong.join(", ")}`);
    assert.strictEqual(env[rowOf("strategy.capitalAttachOrder").env], ORDER);
    const r = config.resolveConfig({ env, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
    const valueOf = (key) => key.split(".").reduce((o, p) => o[p], r.config);
    assert.deepStrictEqual(FLAGS.map(valueOf), [false, false, false]);
    const offDefault = KNOBS.filter((k) => valueOf(k) !== rowOf(k).default).map((k) => `${k}=${valueOf(k)}`);
    assert.deepStrictEqual(offDefault, [], `knobs off the SCHEMA default: ${offDefault.join(", ")}`);
    const order = valueOf("strategy.capitalAttachOrder");
    assert.strictEqual(Array.isArray(order) ? order.join(",") : order, ORDER);
    const ours = r.warnings.filter((w) => /escalation|capitalattach/i.test(w));
    assert.deepStrictEqual(ours, [], `escalation / capital attach warnings: ${ours.join("; ")}`);
  });

  test(`CKT1 compose keys: phase A + fortress + transit mode on fit the compose row limit ${COMPOSE_ROW_LIMIT}; `
    + "keys empty", () => {
    const { rowBoundsOfConfig, rowBoundOverflow } = require("../../lib/strategy/reviewBound");
    const { transitTxRowsOf } = require("../../lib/strategy/reviewRows");
    const PHASE_A_FLAGS = ["EVEJS_LNE_GRID_ENABLED", "EVEJS_LNE_GRID_MOVES_ENABLED",
      "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED", "EVEJS_LNE_GRID_DEFENSE_ENABLED", "EVEJS_LNE_GRID_CROSSINGS_ENABLED",
      "EVEJS_LNE_GRID_CROSSINGS_BLOCKADE_GATE_ENABLED", "EVEJS_LNE_SIEGE_GRID_ENABLED",
      "EVEJS_LNE_SENTRIES_BATTLE_GRID_ENABLED"];
    const { names, env: composeEnv } = readCompose(file);
    const SUB2 = ["maxChecksPerLeg", "maxCheckpointsPerTransaction", "maxEventsPerPass", "haltsPerControllerHour",
      "contactRoles", "contactScanFleets", "defenderBonusPermille", "picketPermillePerBattery", "picketMaxBatteries",
      "picketBatteryHp", "picketBatteryDps", "picketBatterySignature", "picketBatteryDesignSig", "picketBatteryTypeId",
      "picketAttackerRetreatLossPermille"].map((k) => config.SCHEMA.find((r) => r.key === `transit.${k}`).env);
    const off = SUB2.filter((n) => !names.includes(n) || composeEnv[n] !== "").map((n) => `${n}=${composeEnv[n]}`);
    assert.deepStrictEqual(off, [], `transit keys missing or not empty in compose.yaml: ${off.join(", ")}`);
    const env = { ...composeEnv, EVEJS_LNE_FORTRESS_CHECKPOINT_ENABLED: "1", EVEJS_LNE_HUNT_ENABLED: "1",
      EVEJS_LNE_TRANSIT_ENABLED: "1", EVEJS_LNE_TRANSIT_MODE: "on" };
    for (const n of PHASE_A_FLAGS) env[n] = "1";
    const r = config.resolveConfig({ env, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
    assert.deepStrictEqual([r.config.persistence.maxRowsPerTransaction, transitTxRowsOf(r.config)],
      [COMPOSE_ROW_LIMIT, 2]);
    const bounds = rowBoundsOfConfig(r.config);
    assert.strictEqual(rowBoundOverflow(bounds, COMPOSE_ROW_LIMIT), null);
    const ours = r.warnings.filter((w) => w.startsWith("transit.") || w.startsWith("one strategy review may write"));
    assert.deepStrictEqual(ours, [], `transit / review bound warnings: ${ours.join("; ")}`);
    console.log(`     CKT1 phase A + fortress + transit on review bound: review=${bounds.review}`);
  });

  test(`CKM1 compose keys: moon/PI + trade + phase A + fortress + transit on fit the compose row limit ${COMPOSE_ROW_LIMIT}`,
    () => {
      const { rowBoundsOfConfig, rowBoundOverflow, advancedStartRowsOfConfig } =
        require("../../lib/strategy/reviewBound");
      const ADV = "EVEJS_LNE_PRODUCTION_ADVANCED_INPUTS_ENABLED";
      const MOON_PI_TRADE = ["EVEJS_LNE_EXTRACTION_ENABLED", "EVEJS_LNE_EXTRACTION_FUEL_ENABLED",
        "EVEJS_LNE_EXTRACTION_UPWELL_TRANSFER_ENABLED", "EVEJS_LNE_TRADE_COMMODITY_OFFERS_ENABLED",
        "EVEJS_LNE_TRADE_COMMODITY_BUY_ORDERS_ENABLED", "EVEJS_LNE_TRADE_MARKET_SELL_ORDERS_ENABLED", ADV];
      const ON = ["EVEJS_LNE_GRID_ENABLED", "EVEJS_LNE_GRID_MOVES_ENABLED", "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED",
        "EVEJS_LNE_GRID_DEFENSE_ENABLED", "EVEJS_LNE_GRID_CROSSINGS_ENABLED",
        "EVEJS_LNE_GRID_CROSSINGS_BLOCKADE_GATE_ENABLED", "EVEJS_LNE_SIEGE_GRID_ENABLED",
        "EVEJS_LNE_SENTRIES_BATTLE_GRID_ENABLED", "EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED",
        "EVEJS_LNE_FORTRESS_CHECKPOINT_ENABLED", "EVEJS_LNE_HUNT_ENABLED", "EVEJS_LNE_TRANSIT_ENABLED",
        ...MOON_PI_TRADE];
      const env = { ...readCompose(file).env, EVEJS_LNE_TRANSIT_MODE: "on" };
      for (const n of ON) env[n] = "1";
      const r = config.resolveConfig({ env, modDir: MOD_DIR });
      assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
      assert.strictEqual(r.config.persistence.maxRowsPerTransaction, COMPOSE_ROW_LIMIT);
      const ours = r.warnings.filter((w) => w.startsWith("one strategy review may write") || w.includes("(W204)")
        || w.includes("ROW_BOUND"));
      assert.deepStrictEqual(ours, [], `row bound warnings: ${ours.join("; ")}`);
      const bounds = rowBoundsOfConfig(r.config);
      assert.strictEqual(rowBoundOverflow(bounds, COMPOSE_ROW_LIMIT), null);
      assert.notStrictEqual(rowBoundOverflow(bounds, 1300), null);
      const off = rowBoundsOfConfig(config.resolveConfig({ env: { ...env, [ADV]: "0" }, modDir: MOD_DIR }).config);
      const p = r.config.production;
      const starts = p.maxJobsPerReview + (p.industryEnabled === true ? p.maxIndustryJobsPerReview : 0);
      assert.strictEqual(bounds.review - off.review, advancedStartRowsOfConfig(r.config) * starts);
      const noMoon = { ...env };
      for (const n of MOON_PI_TRADE) noMoon[n] = "0";
      const none = rowBoundsOfConfig(config.resolveConfig({ env: noMoon, modDir: MOD_DIR }).config);
      assert.strictEqual(none.review, off.review);
      console.log(`     CKM1 moon/PI + trade profile review bound: review=${bounds.review} (advanced off ${off.review})`);
    });
};

module.exports.findCompose = findCompose;
module.exports.readCompose = readCompose;
