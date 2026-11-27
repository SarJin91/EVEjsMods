"use strict";

const assert = require("node:assert");
const { createCombatAccess, COMBAT_COUNTER_NAMES } = require("../../lib/adapter/combatAccess");
const { createTwinScene } = require("../../lib/adapter/twinScene");
const { ammoReceiptKey } = require("../../lib/core/combatTask");
const { createAmmoReceiptSweeper, parseAmmoReceiptKey } = require("../../lib/core/ammoReceipts");
const { createTickDriver } = require("../../lib/core/tickDriver");
const loader = require("../../loader");
const path = require("node:path");
const { resolveConfig } = require("../../config");

const OP = "consume-inventory-item-quantity";
const HOUR = 3600000;

function fakeLedger(receipts, opts = {}) {
  const ledger = new Map(receipts.map((r) => [encodeURIComponent(r.receiptKey), { ...r }]));
  const v = { ledger, calls: 0, fail: opts.fail || null, throws: opts.throws === true };
  v.prune = (predicate) => {
    v.calls += 1;
    if (v.throws) throw new Error("vendor broke");
    if (typeof predicate !== "function") {
      return { success: false, removed: 0, errorMsg: "INVALID_RECEIPT_PRUNE_PREDICATE" };
    }
    const doomed = [];
    for (const [storageKey, receipt] of ledger.entries()) {
      let dead = false;
      try {
        dead = predicate(JSON.parse(JSON.stringify(receipt))) === true;
      } catch (_err) {
        dead = false;
      }
      if (dead) doomed.push(storageKey);
    }
    if (doomed.length === 0) return { success: true, removed: 0, removedReceiptKeys: [] };
    if (v.fail) return { success: false, removed: 0, errorMsg: v.fail };
    const keys = doomed.map((k) => ledger.get(k).receiptKey);
    for (const k of doomed) ledger.delete(k);
    return { success: true, removed: doomed.length, removedReceiptKeys: keys };
  };
  v.keys = () => [...ledger.values()].map((r) => r.receiptKey).sort();
  return v;
}

function receipt(receiptKey, extra = {}) {
  return { schemaVersion: 3, receiptKey, state: "completed", operation: OP, fingerprint: {},
    completedAtMs: 1000, ...extra };
}

function accessOver(vendor) {
  return createCombatAccess({ deps: { pruneIdempotentGrantReceipts: (...args) => vendor.prune(...args) },
    scene: createTwinScene(), config: {} });
}

function sweeperConfig(extra = {}) {
  return { combatAmmoReceiptPruneMaxPerPass: 500, combatAmmoReceiptPruneMinAgeMs: HOUR,
    combatAmmoReceiptPruneIntervalMs: HOUR, ...extra };
}

function fakeLogger() {
  const lines = [];
  return { lines, log: (m) => lines.push(m), logError: (m) => lines.push(`ERR ${m}`), debug: () => {} };
}

module.exports = ({ test }) => {
  test("AR1 adapter pruneAmmoReceipts: only `wing-ammo:` + consume-inventory-item-quantity + isDead; at most "
    + "maxRemove per call; removed counted (combat.ammo.receipts.pruned); vendor refusal or throw -> "
    + "combat.ammo.receipts.pruneFailed, never throws", () => {
    const v = fakeLedger([
      receipt(ammoReceiptKey(501, 10, 5011)),
      receipt(ammoReceiptKey(501, 10, 5013)),
      receipt(ammoReceiptKey(502, 20, 5021)),
      receipt("native-wreck:1:2", { operation: "transfer-item-to-owner-location" }),
      receipt("wing-ammo-like:501:10:5011"),
      receipt(ammoReceiptKey(503, 30, 5031), { operation: "grant-item" }),
    ]);
    const access = accessOver(v);
    const seen = [];
    const out = access.pruneAmmoReceipts((r) => {
      seen.push(r.receiptKey);
      return true;
    }, 2);
    assert.deepStrictEqual(out, { ok: true, removed: 2, capped: true });
    assert.deepStrictEqual(seen, [ammoReceiptKey(501, 10, 5011), ammoReceiptKey(501, 10, 5013),
      ammoReceiptKey(502, 20, 5021)], "isDead sees only own receipts, and after the cap only up to one dead one");
    assert.deepStrictEqual(v.keys(), [ammoReceiptKey(502, 20, 5021), ammoReceiptKey(503, 30, 5031),
      "native-wreck:1:2", "wing-ammo-like:501:10:5011"].sort());
    assert.deepStrictEqual(access.pruneAmmoReceipts(() => true, 10), { ok: true, removed: 1, capped: false });
    assert.deepStrictEqual(v.keys(), [ammoReceiptKey(503, 30, 5031), "native-wreck:1:2",
      "wing-ammo-like:501:10:5011"].sort(), "another operation and another prefix stay");
    assert.strictEqual(access.stats().counters["combat.ammo.receipts.pruned"], 3);
    assert.deepStrictEqual(access.pruneAmmoReceipts(() => false, 10), { ok: true, removed: 0, capped: false });
    assert.deepStrictEqual(access.pruneAmmoReceipts(null, 10), { ok: false, reason: "INVALID_PRUNE_INPUT" });
    assert.deepStrictEqual(access.pruneAmmoReceipts(() => true, 0), { ok: false, reason: "INVALID_PRUNE_INPUT" });

    const failing = fakeLedger([receipt(ammoReceiptKey(1, 2, 3))], { fail: "IDEMPOTENT_GRANT_RECEIPT_PRUNE_FAILED" });
    const fa = accessOver(failing);
    assert.deepStrictEqual(fa.pruneAmmoReceipts(() => true, 10),
      { ok: false, reason: "IDEMPOTENT_GRANT_RECEIPT_PRUNE_FAILED" });
    const throwing = fakeLedger([], { throws: true });
    const ta = accessOver(throwing);
    assert.deepStrictEqual(ta.pruneAmmoReceipts(() => true, 10), { ok: false, reason: "ERROR" });
    assert.strictEqual(fa.stats().counters["combat.ammo.receipts.pruneFailed"], 1);
    assert.strictEqual(ta.stats().counters["combat.ammo.receipts.pruneFailed"], 1);
    for (const name of ["combat.ammo.receipts.pruned", "combat.ammo.receipts.pruneFailed"]) {
      assert.ok(COMBAT_COUNTER_NAMES.includes(name), name);
    }
  });

  test("AR2 sweeper boot: every `wing-ammo:` receipt without a record of its launch is removed, age not "
    + "checked; a record still in the store (LOST, read-only store) keeps its receipt; other receipts stay; "
    + "parseAmmoReceiptKey", () => {
    const v = fakeLedger([
      receipt(ammoReceiptKey(501, 10, 5011), { completedAtMs: 1e12 }),
      receipt(ammoReceiptKey(502, 20, 5021)),
      receipt(ammoReceiptKey(503, 30, 5031)),
      receipt(ammoReceiptKey(503, 29, 5031)),
      receipt("wing-ammo:broken"),
      receipt("site-hazard:1", { operation: "site-hazard-damage" }),
    ]);
    const access = accessOver(v);
    const records = [{ shipItemId: 503, launchedAtMs: 30, state: "LOST" }];
    const sweeper = createAmmoReceiptSweeper({ access, listRecords: () => records, config: sweeperConfig(),
      clock: { now: () => 1e12 + 1 } });
    assert.deepStrictEqual(sweeper.boot(), { ok: true, removed: 3, capped: false });
    assert.deepStrictEqual(v.keys(), [ammoReceiptKey(503, 30, 5031), "site-hazard:1", "wing-ammo:broken"].sort());
    assert.deepStrictEqual(parseAmmoReceiptKey(ammoReceiptKey(501, 10, 5011)),
      { shipItemId: 501, launchedAtMs: 10, realChargeItemId: 5011 });
    for (const bad of ["wing-ammo:broken", "wing-ammo:1:2", "wing-ammo:1:2:x", "x:1:2:3", "wing-ammo:-1:2:3", null]) {
      assert.strictEqual(parseAmmoReceiptKey(bad), null, String(bad));
    }
    const calls = v.calls;
    const broken = createAmmoReceiptSweeper({ access, listRecords: () => { throw new Error("io"); },
      config: sweeperConfig(), clock: { now: () => 0 } });
    assert.deepStrictEqual(broken.boot(), { ok: false, reason: "RECORDS_UNAVAILABLE" });
    assert.strictEqual(v.calls, calls);
  });

  test("AR3 sweeper tick: one pass per combatAmmoReceiptPruneIntervalMs (0 = boot only); a receipt younger than "
    + "combatAmmoReceiptPruneMinAgeMs or of a launch still in the store stays; the cap per pass "
    + "(combatAmmoReceiptPruneMaxPerPass) leaves the rest to the next pass", () => {
    const now = { t: 10 * HOUR };
    const v = fakeLedger([]);
    const records = [{ shipItemId: 504, launchedAtMs: 4, state: "ACTIVE" }];
    const sweeper = createAmmoReceiptSweeper({ access: accessOver(v), listRecords: () => records,
      config: sweeperConfig({ combatAmmoReceiptPruneMaxPerPass: 1 }), clock: { now: () => now.t } });
    assert.strictEqual(sweeper.tick(now.t), null, "before boot: no pass");
    sweeper.boot();
    for (const r of [
      receipt(ammoReceiptKey(501, 1, 5011), { completedAtMs: 5 * HOUR }),
      receipt(ammoReceiptKey(502, 2, 5021), { completedAtMs: 5 * HOUR }),
      receipt(ammoReceiptKey(503, 3, 5031), { completedAtMs: 100 * HOUR }),
      receipt(ammoReceiptKey(504, 4, 5041), { completedAtMs: 5 * HOUR }),
      receipt(ammoReceiptKey(505, 5, 5051), { completedAtMs: "x" }),
    ]) v.ledger.set(encodeURIComponent(r.receiptKey), r);
    assert.strictEqual(sweeper.tick(now.t + HOUR - 1), null, "before the interval: nothing");
    assert.deepStrictEqual(sweeper.tick(now.t + HOUR), { ok: true, removed: 1, capped: true });
    assert.strictEqual(sweeper.tick(now.t + HOUR + 1), null);
    assert.deepStrictEqual(sweeper.tick(now.t + 2 * HOUR), { ok: true, removed: 1, capped: false });
    assert.deepStrictEqual(sweeper.tick(now.t + 3 * HOUR), { ok: true, removed: 0, capped: false });
    assert.deepStrictEqual(v.keys(), [ammoReceiptKey(503, 3, 5031), ammoReceiptKey(504, 4, 5041),
      ammoReceiptKey(505, 5, 5051)].sort(), "young, live and timeless receipts stay");
    records.length = 0;
    assert.deepStrictEqual(sweeper.tick(now.t + 4 * HOUR), { ok: true, removed: 1, capped: false },
      "the record ended: its receipt goes");
    assert.deepStrictEqual(v.keys(), [ammoReceiptKey(503, 3, 5031), ammoReceiptKey(505, 5, 5051)].sort());

    const once = fakeLedger([receipt(ammoReceiptKey(1, 1, 1))]);
    const bootOnly = createAmmoReceiptSweeper({ access: accessOver(once), listRecords: () => [],
      config: sweeperConfig({ combatAmmoReceiptPruneIntervalMs: 0 }), clock: { now: () => 0 } });
    bootOnly.boot();
    once.ledger.set("x", receipt(ammoReceiptKey(2, 2, 2)));
    assert.strictEqual(bootOnly.tick(100 * HOUR), null, "interval 0 = boot only");
    assert.strictEqual(once.calls, 1);
  });

  test("AR4 loader startAmmoReceiptPrune: flag off or no combat access -> off, vendor not called; on -> one boot "
    + "pass and one log line, ctx.ammoReceipts for the tick; a vendor error -> counter + log line, the start goes "
    + "on; the tick driver calls onTick after wing.tick, a throw counted", () => {
    const defaults = resolveConfig({ modDir: path.join(__dirname, "..", ".."), env: {} }).config;
    assert.deepStrictEqual([defaults.combatAmmoReceiptPruneEnabled, defaults.combatEnabled], [true, false]);
    const base = { combatAmmoReceiptPruneEnabled: true, ...sweeperConfig() };
    const v = fakeLedger([receipt(ammoReceiptKey(501, 10, 5011)), receipt("other:1")]);
    const store = { list: () => [] };
    const off = { config: { ...base, combatAmmoReceiptPruneEnabled: false }, combatAccess: accessOver(v), store,
      logger: fakeLogger() };
    assert.strictEqual(loader.startAmmoReceiptPrune(off), "off");
    assert.strictEqual(loader.startAmmoReceiptPrune({ ...off, config: base, combatAccess: null }), "off");
    assert.strictEqual(v.calls, 0);

    const ctx = { config: base, combatAccess: accessOver(v), store, logger: fakeLogger() };
    assert.strictEqual(loader.startAmmoReceiptPrune(ctx), "ok");
    assert.deepStrictEqual(v.keys(), ["other:1"]);
    assert.deepStrictEqual(ctx.logger.lines, ["ammo receipts boot prune removed=1"]);
    for (const [n, tail] of [[2, ""], [3, " (capped, rest later)"]]) {
      const led = fakeLedger(Array.from({ length: n }, (_, i) => receipt(ammoReceiptKey(600 + i, 1, 1))));
      const c = { config: { ...base, combatAmmoReceiptPruneMaxPerPass: 2 }, combatAccess: accessOver(led), store,
        logger: fakeLogger() };
      assert.strictEqual(loader.startAmmoReceiptPrune(c), "ok");
      assert.deepStrictEqual(c.logger.lines, [`ammo receipts boot prune removed=2${tail}`]);
    }
    assert.ok(ctx.ammoReceipts && typeof ctx.ammoReceipts.tick === "function");

    const bad = fakeLedger([receipt(ammoReceiptKey(1, 2, 3))], { fail: "IDEMPOTENT_GRANT_RECEIPT_PRUNE_FAILED" });
    const failCtx = { config: base, combatAccess: accessOver(bad), store, logger: fakeLogger() };
    assert.strictEqual(loader.startAmmoReceiptPrune(failCtx), "IDEMPOTENT_GRANT_RECEIPT_PRUNE_FAILED");
    assert.deepStrictEqual(failCtx.logger.lines,
      ["ammo receipts boot prune failed - IDEMPOTENT_GRANT_RECEIPT_PRUNE_FAILED; continuing"]);
    assert.strictEqual(failCtx.combatAccess.stats().counters["combat.ammo.receipts.pruneFailed"], 1);

    const handles = [];
    const timers = { setInterval: (fn) => {
      handles.push(fn);
      return { unref() {} };
    }, clearInterval() {} };
    const order = [];
    let throwNext = false;
    const driver = createTickDriver({ wing: { tick: () => order.push("wing") }, tickIntervalMs: 500,
      telemetryIntervalMs: 60000, now: () => 77, timers, onTick: (nowMs) => {
        order.push(`onTick:${nowMs}`);
        if (throwNext) throw new Error("x");
      } });
    driver.start();
    handles[0]();
    throwNext = true;
    handles[0]();
    assert.deepStrictEqual(order, ["wing", "onTick:77", "wing", "onTick:77"]);
    assert.strictEqual(driver.stats().errors, 1);
  });
};
