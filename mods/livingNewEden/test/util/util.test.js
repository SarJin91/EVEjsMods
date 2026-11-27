"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const rng = require("../../lib/util/rng");
const { createClock, createManualClock } = require("../../lib/util/clock");
const { createIdGenerator, isId } = require("../../lib/util/ids");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const N = 10000;

function draws(r, count, method = "nextUint32") {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(r[method]());
  return out;
}

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

module.exports = ({ test }) => {
  test("U1 rng: same seed same 10000 draws, other seed differs, resume from state, float mean, nextInt bounds", () => {
    assert.deepStrictEqual(draws(rng.createRng(42), N), draws(rng.createRng(42), N));
    const a = draws(rng.createRng(42), 10);
    const b = draws(rng.createRng(43), 10);
    assert.ok(a.some((value, i) => value !== b[i]), "seed 43 must differ from 42");

    const r = rng.createRng(42);
    draws(r, 100);
    const resumed = rng.rngFromState(r.getState());
    assert.deepStrictEqual(draws(resumed, 50), draws(r, 50));

    const floats = draws(rng.createRng(7), N, "nextFloat");
    assert.ok(floats.every((x) => x >= 0 && x < 1), "nextFloat in [0,1)");
    const mean = floats.reduce((sum, x) => sum + x, 0) / N;
    assert.ok(mean >= 0.49 && mean <= 0.51, `mean ${mean}`);

    const dice = rng.createRng(9);
    const seen = new Set();
    for (let i = 0; i < 1000; i += 1) {
      const value = dice.nextInt(1, 6);
      assert.ok(Number.isInteger(value) && value >= 1 && value <= 6, String(value));
      seen.add(value);
    }
    assert.ok(seen.has(1) && seen.has(6), "both bounds hit");
    assert.throws(() => dice.nextInt(6, 1), RangeError);
    assert.throws(() => rng.createRng(Number.NaN), TypeError);
  });

  test("U2 hash/deriveSeed golden values, deterministicUnit, independent streams", () => {
    assert.strictEqual(rng.stableHash32(""), 2166136261, "FNV offset basis");
    assert.strictEqual(rng.stableHash32("a"), 3826002220);
    assert.strictEqual(rng.stableHash32("battle", 123), 606780735);
    assert.strictEqual(rng.deriveSeed(1, "battle", "battle_x"), 1597265986);
    assert.strictEqual(rng.deriveSeed(0xFFFFFFFF, "stream", "ids"), 3755674027);
    const unit = rng.deterministicUnit("battle", 123);
    assert.ok(unit >= 0 && unit < 1, String(unit));

    const busy = rng.createStreams(5);
    const quiet = rng.createStreams(5);
    draws(busy.stream("strategy"), 50);
    assert.deepStrictEqual(draws(busy.stream("battle"), 10), draws(quiet.stream("battle"), 10));
    assert.strictEqual(busy.stream("battle"), busy.stream("battle"), "same instance");
    assert.throws(() => busy.stream("nope"), /unknown rng stream/);
    const seed = rng.randomSeed();
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF, String(seed));
  });

  test("U3 clock + config: effectiveTimeScale needs both keys, travel scaled only unobserved, now() non-decreasing", () => {
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const plain = resolve({});
    assert.strictEqual(config.effectiveTimeScale(plain.config), 1);
    assert.ok(!plain.warnings.some((w) => w.includes("testing.")), plain.warnings.join("\n"));
    const scaleOnly = resolve({ EVEJS_LNE_TEST_TIME_SCALE: "10" });
    assert.strictEqual(config.effectiveTimeScale(scaleOnly.config), 1);
    assert.ok(scaleOnly.warnings.some((w) => w.includes("ignored")), scaleOnly.warnings.join("\n"));
    const both = resolve({ EVEJS_LNE_TEST_TIME_SCALE: "10", EVEJS_LNE_TEST_ACCELERATION: "1" });
    assert.strictEqual(config.effectiveTimeScale(both.config), 10);
    assert.ok(both.warnings.some((w) => w.includes("accelerated")), both.warnings.join("\n"));
    assert.strictEqual(config.effectiveTimeScale({}), 1);

    const fast = createClock({ timeScale: 10 });
    assert.strictEqual(fast.travelDurationMs(60000, { observed: false }), 6000);
    assert.strictEqual(fast.travelDurationMs(60000), 60000);
    assert.throws(() => fast.travelDurationMs(-1), RangeError);
    assert.strictEqual(createClock({ timeScale: 1000 }).timeScale, 1);

    const ticks = [1000, 900, 1100];
    const clock = createClock({ nowFn: () => ticks.shift() });
    assert.deepStrictEqual([clock.now(), clock.now(), clock.now()], [1000, 1000, 1100]);

    const manual = createManualClock(5);
    manual.advance(10);
    assert.strictEqual(manual.now(), 15);
    assert.throws(() => manual.advance(-1), RangeError);
  });

  test("U4 ids: deterministic, unique, valid, unknown prefix throws, counter grows", () => {
    const make = () => createIdGenerator({
      clock: createManualClock(1700000000000),
      rng: rng.createStreams(7).stream("ids"),
    });
    const a = make();
    const b = make();
    const first = [1, 2, 3, 4, 5].map(() => a.next("fleet"));
    assert.deepStrictEqual(first, [1, 2, 3, 4, 5].map(() => b.next("fleet")));
    assert.ok(first[0].includes("_0001_") && first[1].includes("_0002_"), first.join(" "));

    const gen = make();
    const ids = new Set();
    for (let i = 0; i < 1000; i += 1) {
      const id = gen.next("fleet");
      assert.ok(isId(id, "fleet"), id);
      ids.add(id);
    }
    assert.strictEqual(ids.size, 1000);
    assert.strictEqual(gen.getCounter(), 1000);
    assert.ok(!isId(first[0], "battle"));
    assert.throws(() => gen.next("ship"), /unknown id prefix/);
    assert.throws(() => createIdGenerator({}), TypeError);
  });

  test("U5 static facts: no Math.random in lib/loader/config, lib/util requires only node:crypto in rng.js/fingerprint.js", () => {
    const files = [...jsFiles(path.join(MOD_DIR, "lib")), path.join(MOD_DIR, "loader.js"), path.join(MOD_DIR, "config.js")];
    const offenders = files.filter((file) => fs.readFileSync(file, "utf8").includes("Math.random"));
    assert.deepStrictEqual(offenders, []);

    const utilDir = path.join(MOD_DIR, "lib", "util");
    const problems = [];
    for (const file of jsFiles(utilDir)) {
      const requires = fs.readFileSync(file, "utf8").match(/require\([^)]*\)/g) || [];
      const allowedBy = { "rng.js": ['require("node:crypto")', 'require("./ids")'],
        "fingerprint.js": ['require("node:crypto")'], "paths.js": ['require("node:path")'] };
      const allowed = allowedBy[path.basename(file)] || [];
      for (const call of requires) if (!allowed.includes(call)) problems.push(`${path.basename(file)}: ${call}`);
    }
    assert.deepStrictEqual(problems, []);
  });
};
