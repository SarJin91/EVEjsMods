"use strict";

const assert = require("node:assert");

const { createTxTap, TOP_NAMES } = require("../../tools/campaign/txTap");
const { CHECKPOINT_TIMING } = require("../../lib/persistence/store");

module.exports = function register({ test }) {
  test("TXP1 txTap: ro / rw / failed / checkpoint frames per day, takeDay resets the day, totals and state stay", () => {
    const tap = createTxTap({ slowMs: 100 });
    tap.onTiming("open", 5);
    tap.onTiming("scheduler.claim", 0.004, "ok", 0);
    tap.onTiming("scheduler.complete", 150.126, "ok", 3);
    tap.onTiming("fleets.create", 2, "TX_CONSTRAINT", 0);
    tap.onTiming(CHECKPOINT_TIMING, 12.5, "ok", 120, "target");
    const d1 = tap.takeDay();
    assert.deepStrictEqual(d1, {
      tx: { n: 3, ro: 1, rw: 1, failed: 1, ms: 152.13, maxMs: 150.13, slow: 1 },
      checkpoint: { n: 1, ms: 12.5, maxMs: 12.5, frames: 120 },
    });
    assert.deepStrictEqual(tap.takeDay(), {
      tx: { n: 0, ro: 0, rw: 0, failed: 0, ms: 0, maxMs: 0, slow: 0 },
      checkpoint: { n: 0, ms: 0, maxMs: 0, frames: 0 },
    });
    tap.onTiming("scheduler.claim", 1, "ok", 0);
    const t = tap.totals();
    assert.deepStrictEqual(t.find((r) => r.name === "scheduler.claim"), { name: "scheduler.claim", n: 2, ro: 2,
      ms: 1, maxMs: 1 });
    assert.strictEqual(t.length, 3);
    const next = createTxTap({ state: tap.state() });
    assert.deepStrictEqual(next.totals(), t);
    assert.strictEqual(next.takeDay().tx.n, 1);
  });

  test("TXP2 txTap totals: n desc, then name, top 20", () => {
    const tap = createTxTap();
    for (let i = 0; i < 25; i += 1) {
      const name = `tx.${String(i).padStart(2, "0")}`;
      for (let k = 0; k < (i % 5) + 1; k += 1) tap.onTiming(name, 1, "ok", 1);
    }
    const t = tap.totals();
    assert.strictEqual(t.length, TOP_NAMES);
    assert.strictEqual(TOP_NAMES, 20);
    assert.deepStrictEqual(t.slice(0, 6).map((r) => `${r.name}:${r.n}`),
      ["tx.04:5", "tx.09:5", "tx.14:5", "tx.19:5", "tx.24:5", "tx.03:4"]);
    for (let i = 1; i < t.length; i += 1) {
      assert.ok(t[i - 1].n > t[i].n || (t[i - 1].n === t[i].n && t[i - 1].name < t[i].name), `order at ${i}`);
    }
  });
};
