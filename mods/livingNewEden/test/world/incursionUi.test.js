"use strict";

const assert = require("node:assert");

const { buildIncursionUiPayload, createIncursionUiPublisher } = require("../../lib/world/invasions/incursionUi");

const START = 1000000;
const HOUR = 3600000;

function row(over) {
  return { invasion_id: "inv-0", roll_round: 0, faction_id: 500021, beachhead_system_id: 30001867, state: "ACTIVE",
    started_at: START, withdraw_at: null, profile_id: "sleeper-tunnel-v1", ...over };
}

function fakeStore(rows) {
  const store = {
    rows,
    isOpen: () => true,
    transaction(name, fn) {
      try {
        return { ok: true, value: fn({ rows: store.rows }) };
      } catch (error) {
        return { ok: false, error };
      }
    },
  };
  return store;
}

const repository = { listOpen: (db, { limit } = {}) => ({ ok: true, invasions: db.rows.slice(0, limit) }) };

function harness(adapter, rows) {
  const store = fakeStore(rows);
  const counts = {};
  const gauges = {};
  const telemetry = { count: (n, k) => { counts[n] = (counts[n] || 0) + k; }, gauge: (n, v) => { gauges[n] = v; } };
  const intervals = [];
  const timers = { setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; intervals.push(h); return h; },
    clearInterval: () => {} };
  const lines = [];
  const publisher = createIncursionUiPublisher({ store, repository, adapter, clock: { now: () => START + HOUR },
    getGovernor: () => ({ admits: () => true }), config: { maxEntries: 16, templateNameID: 0, refreshMs: 60000 },
    telemetry, logger: { log: (l) => lines.push(l) }, timers });
  return { store, publisher, counts, gauges, intervals, lines };
}

module.exports = ({ test }) => {
  test("IU1 buildIncursionUiPayload: taleID, state, influence, staging system, templateNameID, bad row, maxEntries", () => {
    const rows = [
      row({ roll_round: 4, withdraw_at: START + 3 * HOUR }),
      row({ roll_round: 5, state: "WITHDRAWING", withdraw_at: START + HOUR, beachhead_system_id: 30002000 }),
      row({ roll_round: 6, beachhead_system_id: 0 }),
      row({ roll_round: 9, faction_id: 500026 }),
      row({ roll_round: 10 }),
    ];
    const now = START + HOUR + 0.0695 * HOUR;
    const out = buildIncursionUiPayload(rows, { now, templateNameID: 77, maxEntries: 3, withdrawAtOf: (r) => r.withdraw_at });
    assert.deepStrictEqual(out.map((e) => [e.taleID, e.state, e.influence, e.stagingSolarSystemID, e.aggressorFactionID]),
      [[9000000000005, 2, 0.64, 30001867, 500021], [9000000000006, 0, 0, 30002000, 500021],
        [9000000000010, 2, 1, 30001867, 500026]],
      "bad row (system 0) skipped, maxEntries 3 cuts the 5th row, no withdraw time -> 1");
    assert.deepStrictEqual(out[0].systems, [{ solarSystemID: 30001867, sceneType: 4, templateNameID: 77 }]);
    assert.deepStrictEqual([out[0].templateNameID, out[0].templateClassID, out[0].severity, out[0].hasChat],
      [77, 2, 4, false]);
    assert.deepStrictEqual(buildIncursionUiPayload(rows, { now, templateNameID: 0, maxEntries: 0 }), [], "0 = empty");
  });

  test("IU3 publisher: start publishes at once, unchanged cycle skipped, changed row published, stop publishes []", () => {
    const published = [];
    const adapter = { publishIncursions: (list) => { published.push(list); return { ok: true, count: list.length }; } };
    const h = harness(adapter, [row({ roll_round: 2 })]);
    h.publisher.start();
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0][0].taleID, 9000000000003);
    assert.strictEqual(h.intervals.length, 1);
    h.intervals[0].fn();
    assert.strictEqual(published.length, 1, "unchanged: no second call");
    assert.strictEqual(h.counts["world.incursionUi.unchanged"], 1);
    h.store.rows = [row({ roll_round: 2, state: "WITHDRAWING" })];
    h.publisher.runOnce();
    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[1][0].state, 0);
    assert.deepStrictEqual([h.counts["world.incursionUi.published"], h.gauges["world.incursionUi.entries"]], [2, 1]);
    h.publisher.stop();
    assert.deepStrictEqual(published[2], []);
    h.publisher.runOnce();
    assert.strictEqual(published.length, 3, "stopped: no more publishes");
  });

  test("IU4 resilience: a throwing / refusing adapter never escapes runOnce, publishFailed counted, retried", () => {
    let mode = "throw";
    const calls = [];
    const adapter = { publishIncursions: (list) => {
      calls.push(list);
      if (mode === "throw") throw new Error("boom");
      if (mode === "refuse") return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE" };
      return { ok: true, count: list.length };
    } };
    const h = harness(adapter, [row({ roll_round: 1 })]);
    assert.doesNotThrow(() => h.publisher.runOnce());
    mode = "refuse";
    assert.doesNotThrow(() => h.publisher.runOnce());
    assert.strictEqual(h.counts["world.incursionUi.publishFailed"], 2);
    assert.strictEqual(h.lines.length, 2, "one log line per reason");
    h.publisher.runOnce();
    assert.strictEqual(h.lines.length, 2, "the same reason is not logged again");
    mode = "ok";
    h.publisher.runOnce();
    assert.strictEqual(calls.length, 4, "lastSig kept after a refusal: every cycle retries");
    assert.strictEqual(h.counts["world.incursionUi.published"], 1);
    h.store.transaction = () => { throw new Error("store down"); };
    assert.doesNotThrow(() => h.publisher.runOnce());
    assert.strictEqual(h.counts["world.incursionUi.readFailed"], 1);
  });
};
