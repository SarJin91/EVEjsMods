"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { effectivePool } = require("../../lib/world/wreckPool");
const { ACTION, salvageTimes, planSalvageOutbound, planSalvageRecovery, planSalvageReturn, planSalvageDelivery } =
  require("../../lib/fleets/salvageOps");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const P = Object.freeze({ baseTravelMs: 120000, perJumpTravelMs: 60000, baseRecoveryMs: 45000,
  perWreckRecoveryMs: 30000, maxRecoveryMs: 1800000 });

module.exports = ({ test }) => {
  test("SV1 salvage planner (pure): LAUNCH intent + times + cap, phase decisions, delivery deltas, config", () => {
    const at = 1000;
    const spec = { fieldId: "wf:b1", factionId: 500019, systemId: 30000205, homeStationId: "st-a",
      homeSystemId: 30000201, jumps: 2, shipsLost: 3, at };
    const out = planSalvageOutbound(spec, P);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual([out.travelMs, out.recoveryMs], [120000 + 2 * 60000, 45000 + 3 * 30000]);
    const i = out.intent;
    assert.deepStrictEqual([i.type, i.kind, i.operationType, i.objective, i.originSystemId, i.target.systemId,
      i.target.ref, i.mobilize, i.fleets, i.dueAt],
    ["LAUNCH", "salvage", "salvage", "salvage", 30000201, 30000205, "wf:b1", [], [], at + 240000]);
    assert.strictEqual(salvageTimes(P, { jumps: 0, shipsLost: 1000 }).recoveryMs, P.maxRecoveryMs, "capped");
    assert.deepStrictEqual([planSalvageOutbound({ ...spec, homeSystemId: 0 }, P).reason,
      planSalvageOutbound(spec, { ...P, maxRecoveryMs: -1 }).detail], ["SALVAGE_PLAN_INVALID", "params.maxRecoveryMs"]);

    const field = { fieldId: "wf:b1", state: "ACTIVE", createdAt: 0, expiresAt: 604800000, decayFloorPpm: 250000,
      salvageUnits: 6, lootUnits: 5, salvagedSalvageUnits: 0, salvagedLootUnits: 0, version: 1 };
    const job = { recoveryMs: 135000, travelMs: 180000, factionId: 500019, salvageUnits: 5, lootUnits: 4 };
    assert.deepStrictEqual(planSalvageRecovery(job, field, 10), { ok: true, action: ACTION.RECOVER, nextAt: 135010 });
    for (const gone of [null, { ...field, state: "EXPIRED" }, { ...field, expiresAt: 10 }]) {
      assert.deepStrictEqual(planSalvageRecovery(job, gone, 10), { ok: true, action: ACTION.EXHAUST,
        reason: "FIELD_GONE" });
      assert.strictEqual(planSalvageReturn(job, gone, 10).reason, "FIELD_GONE");
    }
    const half = 302400000;
    const pool = effectivePool(field, half);
    assert.deepStrictEqual(planSalvageReturn(job, field, half), { ok: true, action: ACTION.RETURN,
      nextAt: half + 180000, haul: { salvage: pool.salvage, loot: pool.loot }, salvaged: { salvageUnits: 6,
        lootUnits: 5 } });
    assert.deepStrictEqual(planSalvageReturn(job, { ...field, salvagedSalvageUnits: 6, salvagedLootUnits: 5 }, half),
      { ok: true, action: ACTION.EXHAUST, reason: "EMPTY" }, "taken before -> nothing left");

    const own = { ownerFactionId: 500019, state: "ONLINE" };
    assert.deepStrictEqual(planSalvageDelivery(job, own, 1000), { ok: true, action: ACTION.DELIVER, units: 9,
      deltas: [{ itemKind: "supply", itemKey: "unit:loot", delta: 4 },
        { itemKind: "supply", itemKey: "unit:salvage", delta: 5 }] });
    assert.strictEqual(planSalvageDelivery(job, own, 3).units, 6, "each delta capped at maxStockQuantity");
    for (const lost of [null, { ...own, ownerFactionId: 500010 }, { ...own, state: "DESTROYED" }]) {
      assert.deepStrictEqual(planSalvageDelivery(job, lost, 1000), { ok: true, action: ACTION.FAIL,
        reason: "HOME_LOST" });
    }

    const c = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config.salvage;
    assert.deepStrictEqual([c.enabled, c.maxActiveJobs, c.maxNewJobsPerPulse, c.pulseIntervalMs, c.baseTravelMs,
      c.perJumpTravelMs, c.baseRecoveryMs, c.perWreckRecoveryMs, c.maxRecoveryMs, c.maxJumps],
    [true, 48, 6, 60000, 120000, 60000, 45000, 30000, 1800000, 10]);
    const off = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SALVAGE_ENABLED: "0" } }).config.salvage;
    assert.strictEqual(off.enabled, false);
  });

  test("WE2 planSalvageReturn takes claimPermille of the base remainder (haul + rest = pool "
    + "before), a 1/1 field stays (EMPTY), 1000 / undefined = the whole pool, 1001 / 0.5 refused", () => {
    const field = { fieldId: "wf:b2", state: "ACTIVE", createdAt: 0, expiresAt: 604800000, decayFloorPpm: 250000,
      salvageUnits: 12, lootUnits: 8, salvagedSalvageUnits: 0, salvagedLootUnits: 0, version: 1 };
    const job = { travelMs: 180000 };
    const half = 302400000;
    const before = effectivePool(field, half);
    const r = planSalvageReturn(job, field, half, 500);
    assert.deepStrictEqual([r.action, r.salvaged], [ACTION.RETURN, { salvageUnits: 6, lootUnits: 4 }],
      JSON.stringify(r));
    const after = effectivePool({ ...field, salvagedSalvageUnits: 6, salvagedLootUnits: 4 }, half);
    assert.deepStrictEqual(r.haul, { salvage: before.salvage - after.salvage, loot: before.loot - after.loot });
    assert.deepStrictEqual([r.haul.salvage + after.salvage, r.haul.loot + after.loot], [before.salvage, before.loot]);
    assert.ok(after.total >= 1, "the field stays a salvage anomaly candidate");
    assert.deepStrictEqual(planSalvageReturn(job, { ...field, salvageUnits: 1, lootUnits: 1 }, half, 500),
      { ok: true, action: ACTION.EXHAUST, reason: "EMPTY" }, "a 1-unit field is left for the player");
    for (const all of [1000, undefined]) {
      const w = planSalvageReturn(job, field, half, all);
      assert.deepStrictEqual([w.action, w.salvaged, w.haul], [ACTION.RETURN, { salvageUnits: 12, lootUnits: 8 },
        { salvage: before.salvage, loot: before.loot }]);
    }
    for (const bad of [1001, 0.5, -1]) {
      assert.deepStrictEqual([planSalvageReturn(job, field, half, bad).reason], ["SALVAGE_PLAN_INVALID"], String(bad));
    }
  });

  test("WE5 salvage.claimPermille default 500, env 1500 -> clamp 1000", () => {
    const c = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config.salvage;
    assert.strictEqual(c.claimPermille, 500);
    const hi = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SALVAGE_CLAIM_PERMILLE: "1500" } });
    assert.strictEqual(hi.config.salvage.claimPermille, 1000);
  });
};
