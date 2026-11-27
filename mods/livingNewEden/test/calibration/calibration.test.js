"use strict";

const assert = require("node:assert");
const path = require("node:path");

const MOD_DIR = path.join(__dirname, "..", "..");

let cached = null;
function setup() {
  if (cached) return cached;
  const config = require("../../config").resolveConfig({ modDir: MOD_DIR, env: {} }).config;
  const { createStrengthCatalog } = require("../../lib/battle/strength");
  const made = createStrengthCatalog(undefined, { groupConfidence: 0.9, unknownTypeConfidence: 0.6 });
  assert.strictEqual(made.ok, true);
  const { CALIBRATION_METHOD } = require("../../tools/calibration/method");
  const { METHOD } = require("../../tools/strength/method");
  const fx = require("./fixtures/killmails");
  const ctx = (split) => ({ method: CALIBRATION_METHOD, typeGroup: new Map(fx.TYPE_GROUP),
    groupCategory: new Map(fx.GROUP_CATEGORY), groupMap: METHOD.groupMap, systemSec: new Map(fx.SYSTEM_SEC),
    catalog: made.catalog, limits: { maxFleetsPerSide: config.battle.maxFleetsPerSide,
      maxShipsPerFleet: config.fleets.maxShipsPerFleet, maxCompositionEntries: config.fleets.maxCompositionEntries },
    split });
  cached = { config, catalog: made.catalog, method: CALIBRATION_METHOD, fx, ctx };
  return cached;
}

module.exports = ({ test }) => {
  test("K1 killmail dataset: clusters, sides, counts, rejects, order independent, no person ids", () => {
    const { buildBattles } = require("../../tools/calibration/dataset");
    const { fx, ctx } = setup();
    const out = buildBattles(fx.records(), ctx("train"));
    assert.deepStrictEqual(out.rejected, { CAPSULE: 1, VICTIM_NOT_PILOT: 1, VICTIM_NOT_SHIP: 1, NO_PILOT_ATTACKER: 1,
      NPC: 1, TOO_SMALL: 1 });
    assert.strictEqual(out.skippedEntries, 2, "unknown type + third party");
    assert.strictEqual(out.battles.length, 2);
    const bySystem = Object.fromEntries(out.battles.map((b) => [b.systemId, b]));
    const high = bySystem[fx.SYS_HIGH];
    assert.strictEqual(high.kills, 5);
    assert.strictEqual(high.env, "highsec");
    assert.strictEqual(high.spanSec, 300);
    assert.deepStrictEqual(high.sides, {
      A: [{ hullGroup: "cruiser", typeId: 620, count: 2, lost: 1 }, { hullGroup: "frigate", typeId: 587, count: 2, lost: 0 }],
      B: [{ hullGroup: "cruiser", typeId: 620, count: 1, lost: 1 }, { hullGroup: "frigate", typeId: 587, count: 3, lost: 2 }],
    });
    const nul = bySystem[fx.SYS_NULL];
    assert.strictEqual(nul.env, "nullsec");
    assert.deepStrictEqual(nul.sides, {
      A: [{ hullGroup: "cruiser", typeId: 620, count: 1, lost: 1 }, { hullGroup: "frigate", typeId: 587, count: 2, lost: 0 }],
      B: [{ hullGroup: "cruiser", typeId: 620, count: 2, lost: 2 }, { hullGroup: "frigate", typeId: 587, count: 1, lost: 0 }],
    });
    assert.ok(high.classes.includes("all") && high.classes.includes("smallGang"));
    const reversed = buildBattles(fx.records().reverse(), ctx("train"));
    assert.deepStrictEqual(reversed.battles.map((b) => b.battleId), out.battles.map((b) => b.battleId));
    assert.deepStrictEqual(reversed, out);
    const text = JSON.stringify(out);
    for (const field of ["character_id", "corporation_id", "alliance_id"]) assert.ok(!text.includes(field), field);
    for (const id of ["99000001", "99000002", "98000003"]) assert.ok(!text.includes(id), id);
  });

  test("K2 calibration metrics: W1, winner margin, durationMiss, class weight", () => {
    const { w1, winnerLabel, durationMiss, classWeight } = require("../../tools/calibration/metrics");
    const { method } = setup();
    assert.strictEqual(w1([0, 1], [0, 0]), 0.5);
    assert.strictEqual(w1([0.2, 0.7, 0.4], [0.4, 0.2, 0.7]), 0);
    assert.strictEqual(winnerLabel(0.1, 0.25, 0.1), "strong");
    assert.strictEqual(winnerLabel(0.3, 0.1, 0.1), "weak");
    assert.strictEqual(winnerLabel(0.3, 0.35, 0.1), "even");
    assert.strictEqual(durationMiss(200, 100), 1);
    assert.strictEqual(durationMiss(100, 200), 1);
    assert.strictEqual(classWeight("all", method.metrics.minClassBattles - 1, method), 0);
    assert.strictEqual(classWeight("all", method.metrics.minClassBattles, method), 1);
    assert.strictEqual(classWeight("wormhole", 50, method), 0.5);
  });

  test("K3 calibration search: deterministic best + path, a guard-rejected candidate never wins", () => {
    const { buildBattles } = require("../../tools/calibration/dataset");
    const { search } = require("../../tools/calibration/search");
    const { deepFreeze } = require("../../tools/strength/method");
    const resolver = require("../../lib/battle/resolverInternalV1");
    const { fx, ctx, method, config, catalog } = setup();
    const dataset = { battles: buildBattles(fx.records(), ctx("train")).battles };
    const mini = deepFreeze({ ...method, metrics: { ...method.metrics, seedsPerBattle: 5, minClassBattles: 1 },
      search: { passes: 2, steps: [
        { knobs: ["resolverDpsScale", "resolverEhpScale"], grids: [{ from: 0.1, to: 0.5, step: 0.2 },
          { from: 0.5, to: 1.5, step: 0.5 }] },
        { knobs: ["resolverMaxRounds"], grids: [{ from: 8, to: 16, step: 4 }] },
        { knobs: ["resolverRetreatLossFraction"], grids: [{ from: 0.3, to: 0.7, step: 0.2 }], efs: false },
      ] } });
    const start = { resolverDpsScale: 0.3, resolverEhpScale: 1, resolverMaxRounds: 12, resolverRetreatLossFraction: 0.5 };
    const base = { method: mini, resolver, catalog, config, guard: () => ({ ok: true, failures: [], table: [] }) };
    const a = search(dataset, null, start, base);
    const b = search(dataset, null, start, base);
    assert.deepStrictEqual(a.best, b.best);
    assert.deepStrictEqual(a.path, b.path);
    assert.ok(a.after.J <= a.before.J);
    const banned = a.best.resolverDpsScale;
    const guarded = search(dataset, null, start, { ...base, guard: (knobs) => (knobs.resolverDpsScale === banned
      ? { ok: false, failures: ["stub"], table: [] } : { ok: true, failures: [], table: [] }) });
    assert.notStrictEqual(guarded.best.resolverDpsScale, banned);
    assert.ok(guarded.guards.rejected > 0);
  });
};
