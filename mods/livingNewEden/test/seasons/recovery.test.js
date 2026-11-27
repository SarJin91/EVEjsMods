"use strict";

const assert = require("node:assert");

const { createSeasonService } = require("../../lib/seasons/service");
const { createCrisisRegistry } = require("../../lib/seasons/registry");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const { HOUR, T0 } = F;
const SETTINGS = Object.freeze({ durationMs: 4 * HOUR, stageCount: 4, firstStartDelayMs: 60000, breakMs: 600000,
  planRetryMs: 60000, scoreIntervalMs: 60000, stepRecoveryMax: 2 });

function rowOf(store) {
  return F.tx(store, (db) => db.prepare("SELECT * FROM world_seasons WHERE season_no = 1").get());
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("S6 season step recovery", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("S6 QUARANTINED step -> restart enqueues:q1 and the season starts; due moved ->:d<due> step "
    + "recovery keys run out (QUARANTINED / DONE) -> stepRecoveryExhausted, bootstrap ok", () => {
    const S = F.settingsOf(SETTINGS);
    withStore(driver, ({ store }) => {
      const clock = { now: T0 };
      const journal = F.journalOf(clock);
      const scheduler = F.fakeScheduler();
      const registry = createCrisisRegistry();
      assert.ok(registry.register(F.stubKind("TEST_KIND")).ok);
      const make = () => createSeasonService({ store, journal, scheduler, worldSeed: 1, settings: S, registry,
        clock: { now: () => clock.now } });
      assert.ok(make().bootstrap().ok);
      const startsAt = T0 + 60000;

      F.eventOf(scheduler, "season:1:step:PLANNED:0").state = "QUARANTINED";
      const svc = make();
      assert.ok(svc.bootstrap().ok);
      const q1 = F.eventOf(scheduler, "season:1:step:PLANNED:0:q1");
      assert.deepStrictEqual([q1.dueAt, q1.payload], [startsAt, { seasonNo: 1, state: "PLANNED", stage: 0, retries: 0 }]);
      assert.strictEqual(svc.getStatus().counters.stepRecovered, 1);
      clock.now = startsAt;
      assert.ok(F.runEvent(store, scheduler, svc.onStep, q1, clock.now).committed);
      assert.deepStrictEqual([rowOf(store).state, rowOf(store).stage], ["ACTIVE", 0]);
      assert.ok(make().bootstrap().ok);
      assert.ok(!scheduler.events.has("season:1:step:ACTIVE:0:q1"));

      const half = startsAt + HOUR / 2;
      F.tx(store, (db) => db.prepare("UPDATE world_seasons SET stage_due_at = ? WHERE season_no = 1").run(half));
      clock.now = half;
      assert.ok(F.runEvent(store, scheduler, svc.onStep, F.eventOf(scheduler, "season:1:step:ACTIVE:0"),
        clock.now).committed);
      assert.deepStrictEqual([rowOf(store).stage, Number(rowOf(store).stage_due_at)], [0, startsAt + HOUR]);
      const again = F.eventOf(scheduler, `season:1:step:ACTIVE:0:d${startsAt + HOUR}`);
      assert.strictEqual(again.dueAt, startsAt + HOUR);
      clock.now = startsAt + HOUR;
      assert.ok(F.runEvent(store, scheduler, svc.onStep, again, clock.now).committed);
      assert.strictEqual(rowOf(store).stage, 1);

      const boot = make();
      F.eventOf(scheduler, "season:1:step:ACTIVE:1").state = "QUARANTINED";
      assert.ok(boot.bootstrap().ok);
      F.eventOf(scheduler, "season:1:step:ACTIVE:1:q1").state = "QUARANTINED";
      assert.ok(boot.bootstrap().ok);
      F.eventOf(scheduler, "season:1:step:ACTIVE:1:q2").state = "DONE";
      const last = boot.bootstrap();
      assert.ok(last.ok, JSON.stringify(last));
      assert.ok(!scheduler.events.has("season:1:step:ACTIVE:1:q3"));
      assert.deepStrictEqual([boot.getStatus().counters.stepRecovered, boot.getStatus().counters.stepRecoveryExhausted],
        [2, 1]);
    });
  });
};
