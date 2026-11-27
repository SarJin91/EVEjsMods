"use strict";

const assert = require("node:assert");

const { createSeasonService } = require("../../lib/seasons/service");
const { createCrisisRegistry, registerBuiltin } = require("../../lib/seasons/registry");
const { createInvasionSurge } = require("../../lib/seasons/crises/invasionSurge");
const { createPirateSurge } = require("../../lib/seasons/crises/pirateSurge");
const { applyDeltas, outcomeOf } = require("../../lib/seasons/meter");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const { HOUR, T0 } = F;
const FAC = 500026;
const OTHER = 500001;
const POINTS = Object.freeze({ invasionSpawnPoints: 30, invasionRepelPoints: 50, battlePoints: 3 });

function battle(systemId, a, b, outcome) {
  return { systemId, outcome, sideA: { factionId: a, destroyed: 1 }, sideB: { factionId: b, destroyed: 1 } };
}

module.exports = ({ test, skip }) => {
  test("S4 meter: invasion spawn / beachhead lost / battle -> deltas once; PIRATE_SURGE only in crisis regions", () => {
    assert.deepStrictEqual(applyDeltas({ meterDefense: 5, meterCrisis: 1 }, { defense: -3, crisis: 2 }),
      { meterDefense: 5, meterCrisis: 3 });
    assert.deepStrictEqual([outcomeOf(0, 0, 1000), outcomeOf(10, 10, 1000), outcomeOf(9, 10, 1000),
      outcomeOf(10, 5, 2000)], ["DRAW", "WON", "LOST", "WON"]);

    const regionOf = (systemId) => (systemId < 30000010 ? 10000001 : 10000002);
    const pirate = createPirateSurge({ points: POINTS, maxCrisisRegions: 3, factionKindOf: () => "pirate", regionOf });
    const entry = (p) => ({ eventType: "BATTLE_SETTLED", aggregateType: "battle", aggregateId: "b", payload: p });
    const crisis = { factionId: 500010, regionIds: [10000001], params: {} };
    assert.deepStrictEqual(pirate.scoreEntries([entry(battle(30000001, 500010, OTHER, "B_WIN")),
      entry(battle(30000002, 500010, OTHER, "A_WIN")), entry(battle(30000011, 500010, OTHER, "B_WIN")),
      entry(battle(30000003, 500010, OTHER, "DRAW"))], { crisis, refs: new Map(), regionOf }),
    { defense: 3, crisis: 3 });

    const driver = loadDriver();
    if (!driver.ok) {
      skip("S4 meter on a store", `better-sqlite3 unavailable (${driver.detail})`);
      return;
    }
    withStore(driver, ({ store }) => {
      const clock = { now: T0 };
      const journal = F.journalOf(clock);
      const scheduler = F.fakeScheduler();
      const registry = createCrisisRegistry();
      assert.ok(registerBuiltin(registry, createInvasionSurge({ points: POINTS, invaderFactionIds: [FAC] })).ok);
      F.tx(store, (db) => F.insertFaction(db, FAC, "ACTIVE"));
      F.tx(store, (db) => F.journalRow(db, journal, "test:inv:0", "invasion", "inv-0", "INVASION_SPAWNED",
        { factionId: FAC }));
      const S = F.settingsOf({ durationMs: 4 * HOUR, firstStartDelayMs: 0 });
      const svc = createSeasonService({ store, journal, scheduler, worldSeed: 1, settings: S, registry,
        clock: { now: () => clock.now } });
      assert.ok(svc.bootstrap().ok);
      assert.ok(F.runEvent(store, scheduler, svc.onStep, F.eventOf(scheduler, "season:1:step:PLANNED:0"), T0)
        .committed);
      F.tx(store, (db) => {
        F.journalRow(db, journal, "test:inv:1", "invasion", "inv-1", "INVASION_SPAWNED", { factionId: FAC });
        F.journalRow(db, journal, "test:inv:2", "invasion", "inv-2", "INVASION_SPAWNED", { factionId: OTHER });
        F.insertInvasion(db, "inv-1", FAC, "BEACHHEAD_LOST", 1);
        F.insertInvasion(db, "inv-3", FAC, "WITHDRAWN", 3);
        F.journalRow(db, journal, "test:inv:1:end", "invasion", "inv-1", "INVASION_ENDED", {});
        F.journalRow(db, journal, "test:inv:3:end", "invasion", "inv-3", "INVASION_ENDED", {});
        F.journalRow(db, journal, "test:bt:1", "battle", "b1", "BATTLE_SETTLED", battle(30000001, FAC, OTHER, "B_WIN"));
        F.journalRow(db, journal, "test:bt:2", "battle", "b2", "BATTLE_SETTLED", battle(30000001, OTHER, FAC, "B_WIN"));
      });
      const meter = () => F.tx(store, (db) => db.prepare(`SELECT meter_defense AS d, meter_crisis AS c, journal_cursor AS j
        FROM world_seasons WHERE season_no = 1`).get());
      const score = (at) => {
        clock.now = at;
        const key = [...scheduler.events.keys()].filter((k) => k.startsWith("season:score:")).sort().pop();
        assert.ok(F.runEvent(store, scheduler, svc.onScore, F.eventOf(scheduler, key), at).committed);
      };
      score(T0 + 60000);
      const head = F.tx(store, (db) => journal.headId(db).headId);
      let m = meter();
      assert.deepStrictEqual([Number(m.d), Number(m.c), Number(m.j)], [53, 33, head]);
      assert.strictEqual(svc.getStatus().journalLag, 0);
      score(T0 + 120000);
      m = meter();
      assert.deepStrictEqual([Number(m.d), Number(m.c)], [53, 33], "the same entries never count twice");
      assert.deepStrictEqual([svc.current().season.meterDefense, svc.current().season.meterCrisis], [53, 33]);
    });
  });
};
