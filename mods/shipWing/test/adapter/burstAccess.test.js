"use strict";

const assert = require("node:assert");
const { createBurstAccess, createBurstAccessFromGame, BURST_AFFINITY_BASE, BURST_ACCESS_COUNTER_NAMES } =
  require("../../lib/adapter/burstAccess");

const OWNER = 90000001;
const GID = BURST_AFFINITY_BASE + OWNER;

module.exports = ({ test }) => {
  test("BA1 groupIdOf = base + owner (0 for a bad ID); stamp writes only when different (wrote), never over a "
    + "FOREIGN explicit group, BAD_ENTITY without an entity; clear removes only its own gid", () => {
    const access = createBurstAccess({ deps: { collectModifierEntriesForItem: () => [] } });
    assert.deepStrictEqual([access.groupIdOf(OWNER), access.groupIdOf(0), access.groupIdOf(-5),
      access.groupIdOf("x"), access.groupIdOf(1.5)], [GID, 0, 0, 0, 0]);

    const host = { itemID: 1000000400, kind: "ship" };
    assert.deepStrictEqual(access.stamp(host, GID), { ok: true, wrote: true });
    assert.deepStrictEqual([host.commandBurstAffinityExplicit, host.commandBurstAffinityGroupID], [true, GID]);
    assert.deepStrictEqual(access.stamp(host, GID), { ok: true, wrote: false }, "the same value: no write");
    assert.deepStrictEqual(access.stamp(null, GID), { ok: false, reason: "BAD_ENTITY" });
    assert.deepStrictEqual(access.stamp(host, 0), { ok: false, reason: "BAD_ENTITY" });

    const foreign = { itemID: 1000000401, kind: "ship", commandBurstAffinityExplicit: true,
      commandBurstAffinityGroupID: 777 };
    assert.deepStrictEqual(access.stamp(foreign, GID), { ok: false, reason: "FOREIGN" });
    assert.strictEqual(foreign.commandBurstAffinityGroupID, 777, "never overwritten");
    assert.strictEqual(access.clear(foreign, GID), false, "not ours: kept");
    assert.deepStrictEqual([foreign.commandBurstAffinityExplicit, foreign.commandBurstAffinityGroupID], [true, 777]);

    assert.strictEqual(access.clear(host, GID + 1), false, "another owner's gid: kept");
    assert.strictEqual(access.clear(host, GID), true);
    assert.ok(!("commandBurstAffinityExplicit" in host) && !("commandBurstAffinityGroupID" in host));
    assert.strictEqual(access.clear(host, GID), false, "idempotent");
    const rr = { itemID: 1000000402, kind: "ship", remoteRepairBurstAffinityGroupID: 3980000000000001 };
    access.stamp(rr, GID);
    access.clear(rr, GID);
    assert.strictEqual(rr.remoteRepairBurstAffinityGroupID, 3980000000000001);
  });

  test("BA2 collect passes the vendor entries (twin, item, simMs); a vendor throw = [] + burst.collect.error; "
    + "verify: ok / mismatch / rrOverride / unknown without _testing; the loader entry needs the `burst` probe", () => {
    const calls = [];
    let fail = false;
    let resolver = (e) => e.commandBurstAffinityGroupID;
    const access = createBurstAccess({ deps: {
      collectModifierEntriesForItem: (twin, item, simMs) => {
        calls.push([twin.itemID, item.itemID, simMs]);
        if (fail) throw new Error("vendor failure");
        return [{ value: 1 }];
      },
      affinityResolver: () => resolver,
    } });
    const twin = { itemID: 4200000000000001, kind: "ship" };
    assert.deepStrictEqual(access.collect(twin, { itemID: 21 }, 5000), [{ value: 1 }]);
    fail = true;
    assert.deepStrictEqual(access.collect(twin, { itemID: 21 }, 6000), []);
    assert.deepStrictEqual(calls, [[twin.itemID, 21, 5000], [twin.itemID, 21, 6000]]);
    assert.deepStrictEqual(access.collect(null, { itemID: 21 }, 1), [], "no twin: no vendor call");
    assert.deepStrictEqual(access.stats().counters, { "burst.collect.error": 1 });
    assert.ok(BURST_ACCESS_COUNTER_NAMES.every((n) => n.startsWith("burst.")));

    const host = { itemID: 1000000400, kind: "ship" };
    access.stamp(host, GID);
    assert.strictEqual(access.verify(host, GID), "ok");
    assert.strictEqual(access.verify(host, GID + 1), "mismatch");
    host.remoteRepairBurstAffinityGroupID = 3980000000000001;
    assert.strictEqual(access.verify(host, GID), "rrOverride");
    delete host.remoteRepairBurstAffinityGroupID;
    resolver = null;
    assert.strictEqual(access.verify(host, GID), "unknown", "no _testing: no check");
    resolver = () => {
      throw new Error("boom");
    };
    assert.strictEqual(access.verify(host, GID), "unknown");

    assert.deepStrictEqual(createBurstAccessFromGame({ isConsumerAvailable: () => false, requireGame: () => null }),
      { ok: false, reason: "probe_burst_unavailable" });
    const made = createBurstAccessFromGame({ isConsumerAvailable: (n) => n === "burst",
      requireGame: () => ({ ok: true, exports: { collectModifierEntriesForItem: () => ["e"] } }) });
    assert.strictEqual(made.ok, true);
    assert.deepStrictEqual(made.access.collect(twin, { itemID: 1 }, 1), ["e"]);
    assert.strictEqual(made.access.verify(host, GID), "unknown", "the optional _testing missing");
  });
};
