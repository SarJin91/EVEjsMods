"use strict";

const assert = require("node:assert");

const { createPhysicalBudget, REASONS, COUNTER_NAMES } = require("../../lib/materialization/physicalBudget");
const { isMetricName } = require("../../lib/telemetry/registry");

const SYS_A = 30000142;
const SYS_B = 30000144;
const SYS_C = 30002187;

function makeClock(start = 1700000000000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

function makeTelemetry() {
  const counts = new Map();
  const gauges = new Map();
  const names = new Set();
  return {
    counts, gauges, names,
    count(name, n = 1) { names.add(name); counts.set(name, (counts.get(name) || 0) + n); return true; },
    gauge(name, v) { names.add(name); gauges.set(name, v); return true; },
  };
}

function req(id, systemId, shipCount, extra = {}) {
  return { reservationId: id, ownerKind: "battle", ownerId: `b-${id}`, systemId, shipCount, ...extra };
}

function stateOf(budget) {
  const { counters, ...rest } = budget.getStatus({ includeReservations: true });
  return rest;
}

module.exports = ({ test }) => {
  test("PB1 physical budget: per-system limit", () => {
    const b = createPhysicalBudget({ limits: { perSystem: 4, global: 10 }, clock: makeClock() });
    assert.strictEqual(b.reserve(req("a1", SYS_A, 3)).reason, REASONS.RESERVED);
    assert.strictEqual(b.reserve(req("a2", SYS_A, 1)).reason, REASONS.RESERVED);
    const over = b.reserve(req("a3", SYS_A, 1));
    assert.deepStrictEqual(over, { ok: false, reason: REASONS.SYSTEM_LIMIT, available: 0 });
    const other = b.reserve(req("b1", SYS_B, 4));
    assert.strictEqual(other.ok, true);
    assert.strictEqual(other.reason, REASONS.RESERVED);
    const s = b.getStatus();
    assert.strictEqual(s.reservedShips, 8);
    assert.strictEqual(s.availableShips, 2);
    assert.deepStrictEqual(s.reservedBySystem, { [SYS_A]: 4, [SYS_B]: 4 });
  });

  test("PB2 physical budget: global limit, check order (global first), limit 0, smaller limit binds", () => {
    const b = createPhysicalBudget({ limits: { perSystem: 4, global: 6 } });
    assert.strictEqual(b.reserve(req("a", SYS_A, 4)).ok, true);
    assert.strictEqual(b.reserve(req("b", SYS_B, 2)).ok, true);
    assert.deepStrictEqual(b.reserve(req("c", SYS_C, 1)), { ok: false, reason: REASONS.GLOBAL_LIMIT, available: 0 });
    assert.strictEqual(b.canReserve(req("a2", SYS_A, 1)).reason, REASONS.GLOBAL_LIMIT);

    const zero = createPhysicalBudget({ limits: { perSystem: 4, global: 0 } });
    assert.deepStrictEqual(zero.reserve(req("z", SYS_A, 1)), { ok: false, reason: REASONS.GLOBAL_LIMIT, available: 0 });
    const zeroSys = createPhysicalBudget({ limits: { perSystem: 0, global: 10 } });
    assert.deepStrictEqual(zeroSys.reserve(req("z", SYS_A, 1)),
      { ok: false, reason: REASONS.SYSTEM_LIMIT, available: 0 });

    const inverted = createPhysicalBudget({ limits: { perSystem: 6, global: 3 } });
    assert.deepStrictEqual(inverted.getLimits(), { perSystem: 6, global: 3 });
    assert.deepStrictEqual(inverted.reserve(req("i", SYS_A, 4)),
      { ok: false, reason: REASONS.GLOBAL_LIMIT, available: 3 });
    assert.strictEqual(inverted.reserve(req("i", SYS_A, 3)).ok, true);

    assert.throws(() => createPhysicalBudget({ limits: { perSystem: -1, global: 3 } }), RangeError);
    assert.throws(() => createPhysicalBudget({ limits: { perSystem: 1, global: 2.5 } }), RangeError);
  });

  test("PB3 physical budget: refusal is all-or-nothing (over limit and invalid requests change nothing)", () => {
    const b = createPhysicalBudget({ limits: { perSystem: 4, global: 10 }, clock: makeClock() });
    assert.strictEqual(b.reserve(req("a", SYS_A, 3)).ok, true);
    const before = stateOf(b);
    assert.strictEqual(b.reserve(req("over", SYS_A, 2)).reason, REASONS.SYSTEM_LIMIT);
    assert.deepStrictEqual(b.reserve(req("g", SYS_B, 8)), { ok: false, reason: REASONS.GLOBAL_LIMIT, available: 7 });
    const invalid = [
      req("x1", SYS_B, 0), req("x2", SYS_B, 2.5), req("x3", SYS_B, "3"), req("x4", 0, 1),
      req("x5", SYS_B, 1, { ownerKind: "site" }), req("", SYS_B, 1), req("   ", SYS_B, 1),
      req("x6", SYS_B, 1, { ownerId: "" }), null, undefined,
    ];
    for (const r of invalid) {
      assert.deepStrictEqual(b.reserve(r), { ok: false, reason: REASONS.INVALID_REQUEST }, JSON.stringify(r));
    }
    assert.deepStrictEqual(stateOf(b), before);
    assert.strictEqual(b.getStatus().counters.deniedInvalid, invalid.length);
    assert.strictEqual(b.getReservation("over"), null);
  });

  test("PB4 physical budget: idempotency by id, conflict, double release, capacity returns, canReserve is a probe", () => {
    const clock = makeClock();
    const b = createPhysicalBudget({ limits: { perSystem: 4, global: 4 }, clock });
    const first = b.reserve(req("mat:battle:b1:1", SYS_A, 4, { metadata: { side: "both" } }));
    assert.strictEqual(first.reason, REASONS.RESERVED);
    assert.strictEqual(first.reservation.reservedAtMs, clock.now());
    first.reservation.metadata.side = "mutated";
    clock.advance(1000);
    const again = b.reserve(req("mat:battle:b1:1", SYS_A, 4, { metadata: { other: 1 } }));
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.reason, REASONS.ALREADY_RESERVED);
    assert.deepStrictEqual(again.reservation.metadata, { side: "both" });
    assert.strictEqual(b.getStatus().reservedShips, 4);
    const conflict = b.reserve(req("mat:battle:b1:1", SYS_A, 3));
    assert.strictEqual(conflict.ok, false);
    assert.strictEqual(conflict.reason, REASONS.RESERVATION_ID_CONFLICT);

    const probeBefore = b.getStatus();
    assert.strictEqual(b.canReserve(req("mat:battle:b1:1", SYS_A, 4)).reason, REASONS.ALREADY_RESERVED);
    assert.strictEqual(b.canReserve(req("n", SYS_B, 1)).reason, REASONS.GLOBAL_LIMIT);
    assert.strictEqual(b.canReserve(req("n", SYS_B, 0)).reason, REASONS.INVALID_REQUEST);
    assert.deepStrictEqual(b.getStatus(), probeBefore);

    const rel = b.release("mat:battle:b1:1");
    assert.strictEqual(rel.ok, true);
    assert.strictEqual(rel.reason, REASONS.RELEASED);
    assert.strictEqual(rel.reservation.shipCount, 4);
    assert.deepStrictEqual(b.release("mat:battle:b1:1"), { ok: false, reason: REASONS.NOT_RESERVED });
    assert.strictEqual(b.getStatus().reservedShips, 0);
    assert.deepStrictEqual(b.getStatus().reservedBySystem, {});
    assert.strictEqual(b.canReserve(req("n", SYS_B, 4)).reason, REASONS.CAPACITY_AVAILABLE);
    assert.strictEqual(b.reserve(req("mat:battle:b1:2", SYS_A, 4)).reason, REASONS.RESERVED);
    assert.deepStrictEqual(b.getStatus().counters, { granted: 2, idempotent: 1, released: 1, releaseMisses: 1,
      deniedGlobal: 0, deniedSystem: 0, deniedConflict: 1, deniedInvalid: 0 });
  });

  test("PB5 physical budget: releaseOwner by owner and by kind", () => {
    const b = createPhysicalBudget({ limits: { perSystem: 10, global: 20 } });
    const own = (id, kind, owner, sys, n) => b.reserve({ reservationId: id, ownerKind: kind, ownerId: owner,
      systemId: sys, shipCount: n });
    assert.strictEqual(own("r1", "battle", "b1", SYS_A, 2).ok, true);
    assert.strictEqual(own("r2", "battle", "b1", SYS_B, 3).ok, true);
    assert.strictEqual(own("r3", "battle", "b2", SYS_A, 1).ok, true);
    assert.strictEqual(own("r4", "fleet", "f1", SYS_C, 4).ok, true);
    assert.deepStrictEqual(b.releaseOwner("battle", "b1"), { ok: true, released: 2, ships: 5 });
    assert.strictEqual(b.getReservation("r3").ownerId, "b2");
    assert.strictEqual(b.getReservation("r4").ownerId, "f1");
    assert.deepStrictEqual(b.releaseOwner("battle"), { ok: true, released: 1, ships: 1 });
    assert.strictEqual(b.getReservation("r3"), null);
    assert.deepStrictEqual(b.releaseOwner("site"), { ok: false, reason: REASONS.INVALID_REQUEST });
    const s = b.getStatus({ includeReservations: true });
    assert.strictEqual(s.reservedShips, 4);
    assert.deepStrictEqual(s.reservedByOwnerKind, { fleet: 4 });
    assert.deepStrictEqual(s.reservations.map((r) => r.reservationId), ["r4"]);
    assert.deepStrictEqual(b.releaseOwner("battle"), { ok: true, released: 0, ships: 0 });
  });

  test("PB6 physical budget: telemetry counters and gauges, valid metric names, telemetry null", () => {
    const tel = makeTelemetry();
    const b = createPhysicalBudget({ limits: { perSystem: 4, global: 6 }, telemetry: tel });
    assert.strictEqual(tel.gauges.get("materialization.budget.reservedShips"), 0);
    b.reserve(req("a", SYS_A, 4));
    b.reserve(req("a", SYS_A, 4));
    b.reserve(req("a", SYS_A, 2));
    b.reserve(req("s", SYS_A, 1));
    b.reserve(req("b", SYS_B, 2));
    b.reserve(req("c", SYS_C, 1));
    b.reserve(req("x", SYS_C, 0));
    b.canReserve(req("y", SYS_C, 1));
    b.release("b");
    b.release("b");
    b.releaseOwner("battle", "b-a");
    b.reserve(req("d", SYS_B, 1));
    const counted = Object.fromEntries(COUNTER_NAMES.map((n) => [n, tel.counts.get(`materialization.budget.${n}`) || 0]));
    assert.deepStrictEqual(counted, { granted: 3, idempotent: 1, released: 2, releaseMisses: 1, deniedGlobal: 1,
      deniedSystem: 1, deniedConflict: 1, deniedInvalid: 1 });
    assert.deepStrictEqual(counted, b.getStatus().counters);
    assert.strictEqual(tel.gauges.get("materialization.budget.reservedShips"), 1);
    assert.strictEqual(tel.gauges.get("materialization.budget.reservations"), 1);
    assert.strictEqual(tel.gauges.get("materialization.budget.systems"), 1);
    for (const name of tel.names) assert.ok(isMetricName(name), name);
    assert.strictEqual(tel.names.size, COUNTER_NAMES.length + 3);

    const silent = createPhysicalBudget({ limits: { perSystem: 1, global: 1 }, telemetry: null });
    assert.strictEqual(silent.reserve(req("q", SYS_A, 1)).ok, true);
    assert.strictEqual(silent.reserve(req("r", SYS_A, 1)).ok, false);
    assert.strictEqual(silent.release("q").ok, true);
    assert.strictEqual(silent.release("q").ok, false);
  });
};
