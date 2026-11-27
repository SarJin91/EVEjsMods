"use strict";

process.env.EVEJS_DAILY_GOALS_PERSIST_NO_INSTALL = "1";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { isDeepStrictEqual } = require("node:util");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const loader = require(path.join(modDir, "loader.js"));
const configModule = require(path.join(modDir, "config.js"));
const viability = require(path.join(modDir, "lib", "viability.js"));
const wraps = require(path.join(modDir, "lib", "wraps.js"));

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? null : String(process.argv[onlyAt + 1] || "").split(",").filter(Boolean);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function makeConfig(overrides = {}) {
  return Object.freeze({ ...configModule.DEFAULTS, ...overrides, problems: Object.freeze([]) });
}

function makeFakeStore() {
  const cache = { dailyGoals: {}, other: { a: 1 } };
  const dirty = new Set();
  const calls = [];
  const store = {
    read(table, pth) {
      const segments = String(pth || "/").split("/").filter(Boolean);
      if (segments.length === 0) return { success: true, errorMsg: null, data: cache[table] };
      return { success: true, errorMsg: null, data: cache[table][segments[0]] };
    },
    write(table, pth, data, options = {}) {
      calls.push({ table, pth, data, options: arguments[3] });
      const segments = String(pth || "/").split("/").filter(Boolean);
      if (segments.length > 0) {
        cache[table][segments[0]] = data;
        dirty.add(table);
        return { success: true, errorMsg: null, path: "row" };
      }
      const sameReference = cache[table] === data;
      const changedSegments = Array.isArray(options.knownChangedPaths) && options.knownChangedPaths.length > 0;
      const unchanged = !sameReference && !changedSegments && options.force !== true &&
        isDeepStrictEqual(cache[table], data);
      if (unchanged) return { success: true, errorMsg: null };
      if (!sameReference) cache[table] = data;
      if (!(options.transient === true && options.force !== true)) dirty.add(table);
      return { success: true, errorMsg: null };
    },
  };
  return { store, cache, dirty, calls };
}

function redeemInPlace(store) {
  const root = store.read("dailyGoals", "/").data;
  root.byCharacter = root.byCharacter || {};
  root.byCharacter["140000005"] = { goals: [{ uuid: "g1", redeemed: true }] };
  return store.write("dailyGoals", "/", { ...root, version: 1 });
}

function makeRuntime(overrides = {}) {
  const lines = [];
  const errors = [];
  let clock = 1000000;
  const runtime = loader._testing.createRuntime({
    config: makeConfig(overrides),
    now: () => clock,
    logFn: (message) => lines.push(message),
    logErrorFn: (message) => errors.push(message),
  });
  return { runtime, lines, errors, advance: (ms) => { clock += ms; } };
}

function makeFakeGoals() {
  const behaviour = { redeem: { success: false, errorMsg: "GOAL_NOT_FOUND" }, claim: { success: false, errorMsg: "NOT_EARNED" } };
  return {
    behaviour,
    exports: {
      getCurrentGoals: () => [],
      redeemGoal: (characterID, uuid) => ({ ...behaviour.redeem, characterID, uuid }),
      claimMonthlyMilestone: (characterID, uuid) => ({ ...behaviour.claim, characterID, uuid }),
    },
  };
}

function gatewayRedeem(goals, characterID, uuid) {
  let result = uuid ? goals.redeemGoal(characterID, uuid) : { success: false };
  if (!result.success && uuid) result = goals.claimMonthlyMilestone(characterID, uuid);
  return result.success ? 200 : 404;
}

test("T1 viability: real v0.12.9 server files have every seam token once", () => {
  const report = viability.inspect(runtimeRoot);
  assert.strictEqual(report.ok, true, JSON.stringify(report.reports.filter((entry) => !entry.ok)));
  const broken = viability.inspect(runtimeRoot, [
    { key: "gameStore", file: "server/src/gameStore/index.js", required: ["no such seam token"] },
  ]);
  assert.strictEqual(broken.ok, false);
  assert.match(broken.reports[0].reason, /count 0, expected 1/u);
});

test("T2 config: on by default, env flag off, invalid value refused", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dgp-cfg-"));
  const defaults = configModule.load(empty, {});
  assert.strictEqual(defaults.enabled, true);
  assert.strictEqual(defaults.redeemLog, true);
  assert.deepStrictEqual(defaults.problems, []);
  assert.strictEqual(configModule.load(empty, { EVEJS_DAILY_GOALS_PERSIST: "0" }).enabled, false);
  const bad = configModule.load(empty, { EVEJS_DAILY_GOALS_PERSIST_LOG_INTERVAL_MS: "-5" });
  assert.strictEqual(bad.problems.length, 1);
  const disabled = loader.install({ runtimeRoot, environment: { EVEJS_DAILY_GOALS_PERSIST: "off" }, logFn: () => {} });
  assert.strictEqual(disabled.reason, "disabled");
  const invalid = loader.install({ runtimeRoot, environment: { EVEJS_DAILY_GOALS_PERSIST: "maybe" }, logErrorFn: () => {} });
  assert.strictEqual(invalid.reason, "invalid-config");
  fs.rmSync(empty, { recursive: true, force: true });
});

test("T3 S1: in-place mutation + root write is lost in vanilla, dirty with the mod", () => {
  const vanilla = makeFakeStore();
  redeemInPlace(vanilla.store);
  vanilla.dirty.clear();
  redeemInPlace(vanilla.store);
  assert.strictEqual(vanilla.dirty.has("dailyGoals"), false, "fixture must reproduce the vendor bug");

  const modded = makeFakeStore();
  const { runtime } = makeRuntime();
  assert.deepStrictEqual(runtime.applyStore(modded.store), { ok: true });
  redeemInPlace(modded.store);
  modded.dirty.clear();
  const result = redeemInPlace(modded.store);
  assert.deepStrictEqual(result, { success: true, errorMsg: null });
  assert.strictEqual(modded.dirty.has("dailyGoals"), true);
  assert.strictEqual(modded.cache.dailyGoals.byCharacter["140000005"].goals[0].redeemed, true);
  assert.strictEqual(runtime.stats.forcedWrites, 2);
});

test("T4 S1 passthrough: other table, row path, transient, own options untouched", () => {
  const fake = makeFakeStore();
  const { runtime } = makeRuntime();
  runtime.applyStore(fake.store);
  const callerOptions = { knownChangedPaths: ["/byCharacter"] };
  fake.store.write("dailyGoals", "/", { x: 1 }, callerOptions);
  assert.deepStrictEqual(callerOptions, { knownChangedPaths: ["/byCharacter"] }, "caller options not mutated");
  assert.deepStrictEqual(fake.calls[0].options, { knownChangedPaths: ["/byCharacter"], force: true });
  fake.store.write("other", "/", { a: 1 });
  assert.strictEqual(fake.calls[1].options, undefined);
  assert.strictEqual(fake.dirty.has("other"), false);
  fake.store.write("dailyGoals", "/byCharacter", {});
  assert.strictEqual(fake.calls[2].options, undefined);
  const transient = { transient: true };
  fake.store.write("dailyGoals", "/", { y: 1 }, transient);
  assert.strictEqual(fake.calls[3].options, transient);
  assert.strictEqual(runtime.stats.forcedWrites, 1);
  const wrappedWrite = fake.store.write;
  assert.deepStrictEqual(wraps.wrapStoreWrite(fake.store, { state: runtime.state, stats: runtime.stats, onError: () => {} }), {
    ok: false,
    reason: "already-wrapped",
  });
  assert.strictEqual(fake.store.write, wrappedWrite);
  const throwing = { read() {}, write() { throw new Error("gameStore shutdown is in progress"); } };
  makeRuntime().runtime.applyStore(throwing);
  assert.throws(() => throwing.write("dailyGoals", "/", {}), /shutdown is in progress/u);
});

test("T5 DRIFT: missing export makes the mod inert, partial exports stay pending", () => {
  const { runtime, errors } = makeRuntime();
  assert.deepStrictEqual(runtime.applyStore({}), { ok: false, reason: "pending" });
  assert.strictEqual(runtime.state.inert, false);
  assert.deepStrictEqual(runtime.applyStore({ read() {} }), { ok: false, reason: "drift" });
  assert.strictEqual(runtime.state.inert, true);
  assert.match(errors[0], /^DRIFT gameStore\.write - mod inert/u);
  const second = makeRuntime();
  const fake = makeFakeStore();
  second.runtime.applyStore(fake.store);
  assert.deepStrictEqual(second.runtime.applyGoals({ getCurrentGoals() {}, redeemGoal() {} }), { ok: false, reason: "drift" });
  fake.store.write("dailyGoals", "/", { z: 1 });
  assert.strictEqual(fake.calls[0].options, undefined);
});

test("T6 S2: 404 logs char, uuid and both codes; rate-limited per key and globally", () => {
  const { runtime, lines, advance } = makeRuntime({ logIntervalMs: 60000, logMaxPerInterval: 2 });
  const goals = makeFakeGoals();
  assert.deepStrictEqual(runtime.applyGoals(goals.exports), { ok: true });
  assert.strictEqual(gatewayRedeem(goals.exports, 140000005, "abc-1"), 404);
  assert.deepStrictEqual(lines.slice(-1), [
    "redeem 404 char=140000005 uuid=abc-1 daily=GOAL_NOT_FOUND monthly=NOT_EARNED",
  ]);
  gatewayRedeem(goals.exports, 140000005, "abc-1");
  gatewayRedeem(goals.exports, 140000005, "abc-1");
  assert.strictEqual(lines.length, 2, "repeats inside the interval are suppressed");
  gatewayRedeem(goals.exports, 140000005, "abc-2");
  gatewayRedeem(goals.exports, 140000005, "abc-3");
  assert.strictEqual(lines.length, 3, "global cap 2 lines per interval");
  advance(60000);
  gatewayRedeem(goals.exports, 140000005, "abc-1");
  assert.match(lines[lines.length - 1], /uuid=abc-1 .*\(\+2 suppressed\)$/u);
  advance(60000);
  const before = lines.length;
  goals.behaviour.redeem = { success: true, granted: true };
  assert.strictEqual(gatewayRedeem(goals.exports, 140000005, "abc-9"), 200);
  goals.behaviour.redeem = { success: false, errorMsg: "GOAL_NOT_FOUND" };
  goals.behaviour.claim = { success: true, granted: true };
  assert.strictEqual(gatewayRedeem(goals.exports, 140000005, "abc-9"), 200);
  goals.behaviour.claim = { success: false, errorMsg: "NOT_EARNED" };
  goals.exports.claimMonthlyMilestone(140000005, "abc-9");
  goals.exports.redeemGoal(140000005, "abc-9");
  goals.exports.claimMonthlyMilestone(140000006, "abc-9");
  assert.strictEqual(lines.length, before);
  const stats = runtime.redeemLog.stats();
  assert.strictEqual(stats.logged, 3);
  assert.strictEqual(stats.suppressed, 3);
});

test("T7 S2 safety: a failing log never reaches the gateway; redeemLog off skips the wrap", () => {
  const { runtime, errors } = makeRuntime();
  const goals = makeFakeGoals();
  runtime.applyGoals(goals.exports);
  runtime.redeemLog.report = () => { throw new Error("boom"); };
  assert.strictEqual(gatewayRedeem(goals.exports, 1, "u"), 404);
  assert.match(errors[0], /redeem 404 log failed - ignored/u);
  const off = makeRuntime({ redeemLog: false });
  const plain = makeFakeGoals();
  const original = plain.exports.redeemGoal;
  assert.deepStrictEqual(off.runtime.applyGoals(plain.exports), { ok: true });
  assert.strictEqual(plain.exports.redeemGoal, original);
});

test("T8 Module._load hook wraps the real-path targets when they load", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dgp-hook-"));
  const storeFile = path.join(root, "server", "src", "gameStore", "index.js");
  const goalsFile = path.join(root, "server", "src", "services", "dailyGoals", "dailyGoalsState.js");
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.mkdirSync(path.dirname(goalsFile), { recursive: true });
  fs.writeFileSync(storeFile, "module.exports = { read() { return {}; }, write(t, p, d, o) { return { o }; } };\n");
  fs.writeFileSync(
    goalsFile,
    "const database = require('../../gameStore');\n" +
      "module.exports = { getCurrentGoals() {}, redeemGoal() { return { success: true }; },\n" +
      "  claimMonthlyMilestone() { return { success: true }; }, write: (d) => database.write('dailyGoals', '/', d) };\n",
  );
  const { runtime } = makeRuntime();
  const savedLoad = Module._load;
  try {
    const hookState = loader._testing.installModuleHook(runtime, root, () => {});
    const goals = require(goalsFile);
    assert.strictEqual(hookState.pending.size, 0);
    assert.deepStrictEqual(goals.write({}), { o: { force: true } });
    assert.strictEqual(goals.redeemGoal[wraps.WRAPPED], true);
  } finally {
    Module._load = savedLoad;
    delete require.cache[storeFile];
    delete require.cache[goalsFile];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T9 deployment: docker entrypoint requires the loader in both blocks", () => {
  const entrypoint = fs.readFileSync(path.join(runtimeRoot, "docker", "entrypoint.sh"), "utf8");
  const count = entrypoint.split("--require /app/mods/dailyGoalsPersist/loader.js").length - 1;
  assert.strictEqual(count, 2);
});

let passed = 0;
let failed = 0;
const selected = tests.filter((entry) => !only || only.some((fragment) => entry.name.includes(fragment)));
for (const entry of selected) {
  try {
    entry.fn();
    passed += 1;
    console.log(`PASS ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${entry.name}`);
    console.log(error && error.stack ? error.stack : error);
  }
}
console.log(`${passed}/${selected.length} PASS`);
process.exitCode = failed > 0 ? 1 : 0;
