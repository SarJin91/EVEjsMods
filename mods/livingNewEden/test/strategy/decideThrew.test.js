"use strict";

const assert = require("node:assert");

const { convoyItemsOf } = require("../../lib/strategy/data/convoyItems");
const { decideReview, decideReactive } = require("../../lib/strategy/ai");
const { createDecideThrewLog } = require("../../lib/strategy/decideThrewLog");
const { judgeFaction } = require("../../lib/strategy/activity/verdict");
const { createViewRegistry } = require("../../lib/observer/views");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const FRAME = /lib[\\/]strategy[\\/]ai[\\/]\w+\.js:\d+:\d+/;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("DT1 convoyItemsOf: readOpen map -> sorted items; array / null / no items / bad key -> no item", () => {
    assert.deepStrictEqual(convoyItemsOf({ items: { "mineral/type:35": 742860, "hull/group:cruiser": 6 } }), [
      { itemKind: "hull", itemKey: "group:cruiser", quantity: 6 },
      { itemKind: "mineral", itemKey: "type:35", quantity: 742860 }]);
    for (const c of [null, undefined, {}, { items: null }, { items: [{ itemKind: "mineral", itemKey: "type:34",
      quantity: 1 }] }, { items: { nokind: 1, "/type:34": 2, "mineral/": 3 } }]) {
      assert.deepStrictEqual(convoyItemsOf(c), [], JSON.stringify(c));
    }
  });

  test("DT2 decideReview / decideReactive that throw -> SKIPPED, DECIDE_THREW: <message>, threwAt = first frame",
    () => {
      const d = decideReview({ factionId: 500003, round: 7, seed: 1 }, {});
      assert.deepStrictEqual([d.outcome, d.intents, d.notes], ["SKIPPED", [], []]);
      assert.ok(/^DECIDE_THREW: \S/.test(d.reason), d.reason);
      assert.ok(FRAME.test(d.threwAt), d.threwAt);
      const r = decideReactive({ factionId: 500003, round: 7 }, null);
      assert.strictEqual(r.outcome, "SKIPPED");
      assert.ok(/^DECIDE_THREW: \S/.test(r.reason), r.reason);
      assert.ok(FRAME.test(r.threwAt), r.threwAt);
    });

  test("DT3 decide threw log: one line per faction per interval, other faction and after the interval again, "
    + "only DECIDE_THREW, a throwing logger never escapes", () => {
    const clock = createManualClock(1000);
    const lines = [];
    const w = createDecideThrewLog({ log: (l) => lines.push(l), clock, intervalMs: 600000 });
    const threw = { outcome: "SKIPPED", reason: "DECIDE_THREW: object is not iterable", threwAt: "planTrade (t.js:1:2)" };
    assert.strictEqual(w.note(500003, threw), true);
    assert.deepStrictEqual(lines, ["strategy: 500003 decide threw: object is not iterable at planTrade (t.js:1:2)"]);
    clock.advance(599999);
    assert.strictEqual(w.note(500003, threw), false);
    assert.strictEqual(w.note(500001, { ...threw, threwAt: null }), true);
    assert.strictEqual(lines[1], "strategy: 500001 decide threw: object is not iterable at unknown frame");
    clock.advance(1);
    assert.strictEqual(w.note(500003, threw), true);
    for (const d of [null, { outcome: "REVIEWED", reason: null }, { outcome: "SKIPPED", reason: "REVIEW_X" },
      { outcome: "SKIPPED", notes: ["GRAPH_NOT_READY"] }]) assert.strictEqual(w.note(500004, d), false);
    assert.strictEqual(lines.length, 3);
    const seen = [];
    const rl = createDecideThrewLog({ log: (l) => seen.push(l), clock, intervalMs: 600000, label: "reactive decide" });
    assert.strictEqual(rl.note(500003, threw), true);
    assert.ok(seen[0].startsWith("strategy: 500003 reactive decide threw: "), seen[0]);
    const broken = createDecideThrewLog({ log: () => { throw new Error("log down"); }, clock, intervalMs: 600000 });
    assert.strictEqual(broken.note(500003, threw), false);
  });

  needsDriver("DT4 k3 review: a DECIDE_THREW decision of Amarr -> memory reason + panel activity sentence with the "
    + "message; verdict without reason keeps DECIDE_THREW", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(29) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const hooks = { beforeEffect: (d) => (d.factionId !== R.AMARR ? d : { ...d, outcome: "SKIPPED",
      reason: "DECIDE_THREW: object is not iterable", threwAt: "planTrade (trade.js:563:33)", supply: null,
      target: null, notes: [], stuck: 0, intents: [] }) };
    const views = createViewRegistry();
    const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
      { hooks, strategyViews: views });
    await R.passesAt(env, shared, R.START_MS + R.I);
    const data = views.getView("activity").getData();
    const amarr = data.factions.find((x) => x.factionId === R.AMARR);
    assert.ok(amarr, JSON.stringify(data.factions.map((x) => x.factionId)));
    assert.deepStrictEqual([amarr.verdict.code, amarr.verdict.sentence], ["ERROR",
      "Review decision threw an exception (DECIDE_THREW: object is not iterable; details in the log)."]);
    const other = data.factions.find((x) => x.factionId === R.SANSHA);
    assert.notStrictEqual(other.verdict.code, "ERROR", JSON.stringify(other.verdict));
    env.strategy.stop("test");
    env.stations.stop("test");
    const old = judgeFaction({ now: 1e9, intervalMs: R.I, staleFactor: 3, startedAt: 1e9 - R.I,
      strategy: { state: "running", reason: null, aiState: "on", aiReason: null, seedState: "done" },
      failedServices: [], row: { status: "ACTIVE", lastReviewAt: 1e9 - 60000 },
      memory: { round: 1, outcome: "SKIPPED", notes: [], applied: null, refused: 0 },
      reviewEvent: { found: true, state: "QUEUED", attempts: 0, lastError: null, dueAt: 1e9 + R.I },
      activityCount: 0, lastRefusal: null });
    assert.strictEqual(old.sentence, "Review decision threw an exception (DECIDE_THREW; details in the log).");
  }));
};
