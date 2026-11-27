"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { computeNavyShare } = require("../../../lib/world/beltNavy/shareRules");
const { createBeltNavyRoll } = require("../../../lib/world/beltNavy");
const { resolveConfig } = require("../../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const PARAMS = Object.freeze({ shareMin: 0.25, shareMax: 0.75, consolidatingWeight: 0.5, rollBucketMs: 3600000 });
const SYSTEM = 30001984;
const CALDARI = 500001;
const SEED = 1234567;
const AT = 1793000000000;

function fakeRoll(over = {}) {
  const sys = { controllerFactionId: CALDARI, occupationState: "STABLE", influence: [] };
  const reads = [];
  const scores = [];
  const world = { getControlState: (id) => { reads.push(id); return { ok: true, system: sys }; } };
  const occupation = { effectiveScoreOf: (s, f, at) => { scores.push([s, f, at]); return 100; } };
  const deps = { getWorld: () => world, getOccupation: () => occupation, worldSeed: SEED, settings: PARAMS, ...over };
  return { roll: createBeltNavyRoll(deps), sys, reads, scores };
}

const input = (over = {}) => ({ systemId: SYSTEM, factionId: CALDARI, spawnSiteId: `${SYSTEM}:40000001:1`, atMs: AT, ...over });

module.exports = ({ test }) => {
  test("BNS1 computeNavyShare: control points and all 6 occupation states", () => {
    const share = (occupationState, score) => computeNavyShare({ occupationState, score }, PARAMS);
    assert.strictEqual(share("STABLE", 100), 0.75);
    assert.strictEqual(share("RECON", 100), 0.75);
    assert.strictEqual(share("CONSOLIDATING", 50), 0.375);
    assert.strictEqual(share("CONSOLIDATING", 100), 0.5);
    for (const state of ["OCCUPIED", "CONTESTED", "INVASION"]) assert.strictEqual(share(state, 100), 0.25, state);
    assert.strictEqual(share("STABLE", 0), 0.25, "influence 0");
    assert.strictEqual(share("STABLE", 50), 0.5);
    assert.strictEqual(share("STABLE", 250), 0.75, "score clamped from above");
    assert.strictEqual(share("STABLE", -5), 0.25, "score clamped from below");
    assert.strictEqual(share("STABLE", NaN), 0.25, "not a number counts as 0");
    assert.strictEqual(share("UNKNOWN_STATE", 100), 0.25, "an unknown state gets the minimum");
  });

  test("BNS2 decide: one spawn one result, key parts, score of the controller, refusals", () => {
    const { roll, sys, reads, scores } = fakeRoll();
    const first = roll.decide(input());
    assert.deepStrictEqual(Object.keys(first), ["ok", "navy", "share", "unit"]);
    assert.strictEqual(first.share, 0.75);
    assert.strictEqual(first.navy, first.unit < 0.75);
    assert.ok(first.unit >= 0 && first.unit < 1, String(first.unit));
    assert.deepStrictEqual(reads, [SYSTEM]);
    assert.deepStrictEqual(scores, [[sys, CALDARI, AT]]);

    assert.deepStrictEqual(roll.decide(input()), first, "same input, same result");
    assert.deepStrictEqual(fakeRoll().roll.decide(input()), first, "a restart: new instance, same result");
    assert.strictEqual(roll.decide(input({ atMs: AT + 1 })).unit, first.unit, "same time bucket");
    const unitOf = (over) => roll.decide(input(over)).unit;
    assert.notStrictEqual(unitOf({ spawnSiteId: `${SYSTEM}:40000001:2` }), first.unit, "spawn id");
    assert.notStrictEqual(unitOf({ atMs: AT + PARAMS.rollBucketMs }), first.unit, "time bucket");
    assert.notStrictEqual(fakeRoll({ worldSeed: SEED + 1 }).roll.decide(input()).unit, first.unit, "world seed");
    assert.notStrictEqual(fakeRoll({ getWorld: () => ({ getControlState: () => ({ ok: true,
      system: { ...sys, controllerFactionId: 7 } }) }) }).roll.decide(input({ systemId: SYSTEM + 1, factionId: 7 })).unit,
    first.unit, "system");

    const reason = (over, given) => fakeRoll(over).roll.decide(given || input()).reason;
    const worldOf = (read) => ({ getWorld: () => ({ getControlState: () => read }) });
    assert.strictEqual(reason(worldOf({ ok: true, system: { ...sys, controllerFactionId: 500002 } })), "CONTROL_CHANGED");
    assert.strictEqual(reason(worldOf({ ok: true, system: null })), "CONTROL_CHANGED", "no row");
    assert.strictEqual(reason(worldOf({ ok: false, reason: "TX_ACTIVE" })), "TX_ACTIVE");
    assert.strictEqual(reason({ getOccupation: () => ({ getStatus() {} }) }), "NO_SCORE", "the disabled stub");
    assert.strictEqual(reason({ getOccupation: () => null }), "NO_SCORE");
    assert.strictEqual(reason({ getWorld: () => null }), "WORLD_UNAVAILABLE");
    assert.strictEqual(reason({ worldSeed: undefined }), "NO_SEED");
    assert.strictEqual(reason({}, input({ spawnSiteId: undefined })), "BAD_INPUT");
    assert.strictEqual(reason({}, input({ systemId: 0 })), "BAD_INPUT");
    assert.strictEqual(reason({}, input({ atMs: NaN })), "BAD_INPUT");
    assert.strictEqual(fakeRoll().roll.decide(null).reason, "BAD_INPUT");
  });

  test("BNS3 roll over many spawns: the hit rate follows the share, adjacent buckets are independent", () => {
    const { roll } = fakeRoll();
    const spawns = 4000;
    let hits = 0;
    let sameSide = 0;
    for (let i = 0; i < spawns; i += 1) {
      const site = { spawnSiteId: `${SYSTEM}:${40000000 + i}:1` };
      const now = roll.decide(input(site));
      if (now.navy) hits += 1;
      if (now.navy === roll.decide(input({ ...site, atMs: AT + PARAMS.rollBucketMs })).navy) sameSide += 1;
    }
    const rate = hits / spawns;
    assert.ok(rate > 0.72 && rate < 0.78, `rate ${rate}`);
    const agree = sameSide / spawns;
    assert.ok(agree > 0.59 && agree < 0.66, `agree ${agree}`);
  });

  test("BNS4 config: defaults of world.beltNavy and the shareMin above shareMax warning", () => {
    const beltNavy = resolveConfig({ modDir: MOD_DIR, env: {} }).config.world.beltNavy;
    assert.deepStrictEqual([beltNavy.shareEnabled, beltNavy.shareMin, beltNavy.shareMax, beltNavy.consolidatingWeight,
      beltNavy.rollBucketMs], [true, 0.25, 0.75, 0.5, 3600000]);
    const warned = (env) => resolveConfig({ modDir: MOD_DIR, env }).warnings.filter((w) => w.includes("shareMin"));
    assert.deepStrictEqual(warned({}), []);
    assert.strictEqual(warned({ EVEJS_LNE_WORLD_BELT_NAVY_SHARE_MIN: "0.9" }).length, 1);
    const clamped = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_BELT_NAVY_ROLL_BUCKET_MS: "1" } });
    assert.strictEqual(clamped.config.world.beltNavy.rollBucketMs, 60000);
  });
};
