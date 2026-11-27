"use strict";

const assert = require("node:assert");

const SC = require("../../lib/seasons/schema");
const { createSeasonService } = require("../../lib/seasons/service");
const { createCrisisRegistry, registerBuiltin } = require("../../lib/seasons/registry");
const { createInvasionSurge } = require("../../lib/seasons/crises/invasionSurge");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const { HOUR, T0 } = F;
const SETTINGS = Object.freeze({ durationMs: 4 * HOUR, stageCount: 4, firstStartDelayMs: 60000, breakMs: 600000,
  planRetryMs: 60000, scoreIntervalMs: 60000 });

function rowOf(store) {
  return F.tx(store, (db) => db.prepare("SELECT * FROM world_seasons ORDER BY season_no").all());
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("S3 season cycle on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("S3 PLANNED -> ACTIVE -> stage -> FINALE -> ARCHIVED + next PLANNED; a step twice = STALE; restart rebuilds the "
    + "step; faction not ACTIVE -> crisisRepicked; no kind -> startDeferred", () => {
    assert.ok(MIGRATIONS.some((m) => m.version === 115 && m.name === "galactic_seasons" && m.up === SC.upSeasons));
    assert.ok(LATEST_SCHEMA_VERSION >= 115);
    assert.deepStrictEqual(["world_seasons", "world_season_scores", "world_season_rewards"].map((t) => TABLE_POLICY[t]),
      [ACTION.KEEP, ACTION.KEEP, ACTION.KEEP]);
    const S = F.settingsOf(SETTINGS);

    withStore(driver, ({ store }) => {
      const clock = { now: T0 };
      const journal = F.journalOf(clock);
      const scheduler = F.fakeScheduler();
      const registry = createCrisisRegistry();
      const points = { invasionSpawnPoints: 30, invasionRepelPoints: 50, battlePoints: 3 };
      assert.ok(registerBuiltin(registry, createInvasionSurge({ points, invaderFactionIds: [500027, 500026] })).ok);
      F.tx(store, (db) => {
        F.insertFaction(db, 500026, "ACTIVE");
        F.insertFaction(db, 500027, "ACTIVE");
      });
      const make = () => createSeasonService({ store, journal, scheduler, worldSeed: 1, settings: S, registry,
        clock: { now: () => clock.now } });
      const svc1 = make();
      assert.strictEqual(svc1.currentSeasonKey(), null);
      const boot = svc1.bootstrap();
      assert.ok(boot.ok, JSON.stringify(boot));
      let rows = rowOf(store);
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual([rows[0].season_no, rows[0].state, rows[0].open, rows[0].crisis_kind],
        [1, "PLANNED", 1, "INVASION_SURGE"]);
      const startsAt = T0 + 60000;
      assert.deepStrictEqual([Number(rows[0].starts_at), Number(rows[0].ends_at)], [startsAt, startsAt + 4 * HOUR]);
      const F1 = JSON.parse(rows[0].crisis_json).factionId;
      assert.ok([500026, 500027].includes(F1));
      assert.ok(scheduler.events.has(SC.keyOfScore(Math.floor(T0 / 60000) + 1)), "SEASON_SCORE head");

      const planned = F.eventOf(scheduler, "season:1:step:PLANNED:0");
      const early = F.runEvent(store, scheduler, svc1.onStep, planned, T0);
      assert.deepStrictEqual([early.res.ok, early.res.deferUntil], [false, startsAt]);
      clock.now = startsAt;
      assert.ok(F.runEvent(store, scheduler, svc1.onStep, planned, startsAt).committed);
      rows = rowOf(store);
      assert.deepStrictEqual([rows[0].state, rows[0].stage], ["ACTIVE", 0]);
      assert.ok(F.tx(store, (db) => journal.findByKey(db, "season:1:start")).found);
      assert.strictEqual(svc1.currentSeasonKey(), "s1");
      const again = F.runEvent(store, scheduler, svc1.onStep, planned, startsAt);
      assert.strictEqual(again.res.outcome, "STALE");
      assert.strictEqual(svc1.getStatus().counters.stale, 1);
      assert.strictEqual(svc1.getStatus().counters.started, 1);

      const svc2 = make();
      const steps = () => [...scheduler.events.keys()].filter((k) => k.startsWith("season:1:step:"));
      const before = steps();
      assert.ok(svc2.bootstrap().ok);
      assert.deepStrictEqual(steps(), before, "the chains meet on the key");
      assert.strictEqual(svc2.current().season.state, "ACTIVE");
      scheduler.events.delete("season:1:step:ACTIVE:0");
      assert.ok(svc2.bootstrap().ok);
      const active0 = F.eventOf(scheduler, "season:1:step:ACTIVE:0");
      assert.strictEqual(active0.dueAt, startsAt + HOUR);

      clock.now = startsAt + HOUR;
      assert.ok(F.runEvent(store, scheduler, svc2.onStep, active0, clock.now).committed);
      assert.deepStrictEqual([rowOf(store)[0].state, rowOf(store)[0].stage], ["ACTIVE", 1]);
      assert.ok(F.tx(store, (db) => journal.findByKey(db, "season:1:stage:1")).found);
      clock.now = startsAt + 3.5 * HOUR;
      assert.ok(F.runEvent(store, scheduler, svc2.onStep, F.eventOf(scheduler, "season:1:step:ACTIVE:1"),
        clock.now).committed);
      assert.deepStrictEqual([rowOf(store)[0].state, rowOf(store)[0].stage], ["FINALE", 3]);
      assert.ok(F.tx(store, (db) => journal.findByKey(db, "season:1:finale")).found);
      assert.strictEqual(svc2.getStatus().counters.stageSkipped, 1);

      clock.now = startsAt + 4 * HOUR;
      assert.ok(F.runEvent(store, scheduler, svc2.onStep, F.eventOf(scheduler, "season:1:step:FINALE:3"),
        clock.now).committed);
      rows = rowOf(store);
      assert.deepStrictEqual([rows[0].state, rows[0].open, rows[0].outcome, rows[0].close_reason],
        ["ARCHIVED", 0, "DRAW", "FINISHED"]);
      assert.ok(F.tx(store, (db) => journal.findByKey(db, "season:1:end")).found);
      assert.deepStrictEqual([rows[1].season_no, rows[1].state, Number(rows[1].starts_at)],
        [2, "PLANNED", startsAt + 4 * HOUR + 600000]);
      const F2 = JSON.parse(rows[1].crisis_json).factionId;
      assert.notStrictEqual(F2, F1);
      assert.strictEqual(svc2.currentSeasonKey(), "s1", "PLANNED -> the last ARCHIVED");
      assert.strictEqual(svc2.getStatus().counters["closed.DRAW"], 1);

      F.tx(store, (db) => F.insertFaction(db, F2, "DORMANT"));
      clock.now = Number(rows[1].starts_at);
      assert.ok(F.runEvent(store, scheduler, svc2.onStep, F.eventOf(scheduler, "season:2:step:PLANNED:0"),
        clock.now).committed);
      rows = rowOf(store);
      assert.deepStrictEqual([rows[1].state, JSON.parse(rows[1].crisis_json).factionId], ["ACTIVE", F1]);
      assert.strictEqual(svc2.getStatus().counters.crisisRepicked, 1);
    });

    withStore(driver, ({ store }) => {
      const clock = { now: T0 };
      const journal = F.journalOf(clock);
      const scheduler = F.fakeScheduler();
      const registry = createCrisisRegistry();
      const reg = registry.register(F.stubKind("TEST_KIND"));
      assert.ok(reg.ok);
      const svc = createSeasonService({ store, journal, scheduler, worldSeed: 1, settings: S, registry,
        clock: { now: () => clock.now } });
      assert.ok(svc.bootstrap().ok);
      reg.unregister();
      clock.now = T0 + 60000;
      assert.ok(F.runEvent(store, scheduler, svc.onStep, F.eventOf(scheduler, "season:1:step:PLANNED:0"),
        clock.now).committed);
      const [row] = rowOf(store);
      assert.deepStrictEqual([row.state, row.planned_retries, Number(row.starts_at), Number(row.ends_at)],
        ["PLANNED", 1, T0 + 120000, T0 + 120000 + 4 * HOUR]);
      assert.strictEqual(svc.getStatus().counters.startDeferred, 1);
      assert.strictEqual(F.eventOf(scheduler, "season:1:step:PLANNED:0:r1").dueAt, T0 + 120000);
    });
  });
};
