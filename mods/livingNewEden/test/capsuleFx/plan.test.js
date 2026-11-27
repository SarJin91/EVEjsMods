"use strict";

const assert = require("node:assert");

const plan = require("../../lib/capsuleFx/plan");

const CFG = Object.freeze({ civilianEnabled: true, ratsEnabled: true, missionRatsEnabled: false,
  lneFleetsEnabled: true, warpDelayMs: 2500, despawnAfterWarpMs: 4000, maxLifetimeMs: 20000, warpDistanceAu: 3,
  spawnOffsetMeters: 300, maxPerSystem: 2, maxGlobal: 3, maxPending: 64, pendingMaxAgeMs: 3000,
  maxSpawnsPerPass: 2, maxActionsPerPass: 2 });

function facts(wreckId, sceneKey = "a", source = "rats") {
  return { wreckId, source, sceneKey, systemId: 1, position: { x: 10, y: 20, z: 30 }, radius: 50 };
}

module.exports = ({ test }) => {
  test("CFP1 budgets and schedule: per system, global, queue, duplicate, source flag", () => {
    const s = plan.createState();
    assert.deepStrictEqual(plan.admit(s, facts(1, "a", "ratsMission"), CFG, 0), { ok: false, reason: "SOURCE_OFF" });
    assert.deepStrictEqual(plan.admit(s, facts(1), CFG, 0), { ok: true });
    assert.deepStrictEqual(plan.admit(s, facts(1), CFG, 0), { ok: false, reason: "DUPLICATE" });
    assert.deepStrictEqual(plan.admit(s, facts(2), CFG, 0), { ok: true });
    assert.deepStrictEqual(plan.admit(s, facts(3), CFG, 0), { ok: false, reason: "SYSTEM_FULL" });
    assert.deepStrictEqual(plan.admit(s, facts(4, "b"), CFG, 0), { ok: true });
    assert.deepStrictEqual(plan.admit(s, facts(5, "c"), CFG, 0), { ok: false, reason: "GLOBAL_FULL" });
    const q = plan.createState();
    const small = { ...CFG, maxPending: 1, maxGlobal: 10 };
    assert.strictEqual(plan.admit(q, facts(1), small, 0).ok, true);
    assert.deepStrictEqual(plan.admit(q, facts(2, "b"), small, 0), { ok: false, reason: "QUEUE_FULL" });
    assert.strictEqual(q.pending.length, 1);
    plan.release(s, "a", 1);
    assert.deepStrictEqual([s.perSystem.get("a"), s.seenWrecks.has(1)], [1, false]);
    assert.deepStrictEqual(plan.schedule(1000, CFG), { warpAtMs: 3500, removeAtMs: 21000 });
    assert.deepStrictEqual(plan.schedule(0, { ...CFG, maxLifetimeMs: 2000 }), { warpAtMs: 2500, removeAtMs: 6500 });
  });

  test("CFP2 budgets and schedule: stale, per pass limits, remove before warp", () => {
    const s = plan.createState();
    const wide = { ...CFG, maxPerSystem: 50, maxGlobal: 50 };
    for (let i = 1; i <= 4; i += 1) plan.admit(s, facts(i), wide, i === 1 ? 0 : 5000);
    const due = plan.dueActions(s, 5000, wide);
    assert.deepStrictEqual(due.stale.map((e) => e.wreckId), [1]);
    assert.deepStrictEqual(due.spawn.map((e) => e.wreckId), [2, 3]);
    const active = (id, extra) => ({ entityId: id, warpAtMs: 100, removeAtMs: 1000, warpedAtMs: null,
      warpFailed: false, ...extra });
    const t = plan.createState();
    t.active.set(1, active(1, { removeAtMs: 50 }));
    t.active.set(2, active(2));
    t.active.set(3, active(3));
    t.active.set(4, active(4, { warpFailed: true }));
    t.active.set(5, active(5, { warpedAtMs: 100 }));
    const d = plan.dueActions(t, 200, CFG);
    assert.deepStrictEqual([d.remove.map((e) => e.entityId), d.warp.map((e) => e.entityId)], [[1], [2]]);
    assert.deepStrictEqual(plan.dueActions(plan.createState(), 0, CFG), { spawn: [], stale: [], warp: [], remove: [] });
  });

  test("CFP3 direction is a deterministic unit vector, the warp point is warpDistanceAu away", () => {
    const seen = new Set();
    for (let id = 1; id <= 50; id += 1) {
      const d = plan.directionOf(id);
      assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9, `unit ${id}`);
      assert.deepStrictEqual(plan.directionOf(id), d);
      seen.add(`${d.x.toFixed(6)}:${d.y.toFixed(6)}`);
    }
    assert.ok(seen.size > 45, `distinct directions ${seen.size}`);
    const f = facts(7);
    const dir = plan.directionOf(7);
    const at = plan.spawnPointOf(f, dir, CFG);
    assert.ok(Math.abs(Math.hypot(at.x - 10, at.y - 20, at.z - 30) - 350) < 1e-6, "radius + offset");
    const to = plan.warpPointOf(at, dir, CFG);
    const au = Math.hypot(to.x - at.x, to.y - at.y, to.z - at.z) / plan.METERS_PER_AU;
    assert.ok(Math.abs(au - 3) < 1e-9, `warp ${au} AU`);
  });
};
