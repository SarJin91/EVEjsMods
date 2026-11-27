"use strict";

const assert = require("node:assert");

const { createSeasonService } = require("../../lib/seasons/service");
const { createCrisisRegistry, registerBuiltin, MAX_KINDS, RESERVED } = require("../../lib/seasons/registry");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const { HOUR, T0 } = F;

module.exports = ({ test, skip }) => {
  test("S2 register refuses BAD_KIND / RESERVED / DUPLICATE / FULL; unregister; KIND_GONE season goes on", () => {
    const registry = createCrisisRegistry();
    assert.strictEqual(MAX_KINDS, 8);
    assert.deepStrictEqual([...RESERVED], ["INVASION_SURGE", "PIRATE_SURGE"]);
    assert.strictEqual(registry.register(F.stubKind("bad")).reason, "BAD_KIND");
    assert.strictEqual(registry.register(F.stubKind("GOOD_KIND", { weight: 0 })).reason, "BAD_KIND");
    assert.strictEqual(registry.register(F.stubKind("GOOD_KIND", { journalAggregates: ["Bad"] })).reason, "BAD_KIND");
    assert.strictEqual(registry.register(F.stubKind("GOOD_KIND", { propose: null })).reason, "BAD_KIND");
    assert.strictEqual(registry.register(F.stubKind("INVASION_SURGE")).reason, "RESERVED");
    assert.ok(registerBuiltin(registry, F.stubKind("INVASION_SURGE")).ok, "built-in path skips RESERVED");
    const first = registry.register(F.stubKind("KIND_A"));
    assert.ok(first.ok);
    assert.strictEqual(registry.register(F.stubKind("KIND_A")).reason, "DUPLICATE");
    for (const k of ["KIND_B", "KIND_C", "KIND_D", "KIND_E", "KIND_F", "KIND_G"]) {
      assert.ok(registry.register(F.stubKind(k)).ok, k);
    }
    assert.strictEqual(registry.list().length, 8);
    assert.strictEqual(registry.register(F.stubKind("KIND_H")).reason, "FULL");
    assert.deepStrictEqual(registry.list()[0], { kind: "INVASION_SURGE", owner: "test", version: 1, weight: 10 });
    first.unregister();
    assert.strictEqual(registry.get("KIND_A"), null);
    assert.ok(registry.register(F.stubKind("KIND_H")).ok, "a slot is free again");

    const driver = loadDriver();
    if (!driver.ok) {
      skip("S2 kindGone on a store", `better-sqlite3 unavailable (${driver.detail})`);
      return;
    }
    withStore(driver, ({ store }) => {
      const clock = { now: T0 };
      const journal = F.journalOf(clock);
      const scheduler = F.fakeScheduler();
      const reg = createCrisisRegistry();
      const kind = reg.register(F.stubKind("TEST_KIND", { scoreEntries: (entries) => ({ defense: entries.length,
        crisis: 0 }) }));
      assert.ok(kind.ok);
      const S = F.settingsOf({ durationMs: 4 * HOUR, firstStartDelayMs: 0 });
      const svc = createSeasonService({ store, journal, scheduler, worldSeed: 1, settings: S, registry: reg,
        clock: { now: () => clock.now } });
      assert.ok(svc.bootstrap().ok);
      assert.ok(F.runEvent(store, scheduler, svc.onStep, F.eventOf(scheduler, "season:1:step:PLANNED:0"), T0)
        .committed);
      F.tx(store, (db) => F.journalRow(db, journal, "test:battle:1", "battle", "b1", "BATTLE_SETTLED", {}));
      kind.unregister();
      clock.now = T0 + 60000;
      const scoreKey = [...scheduler.events.keys()].find((k) => k.startsWith("season:score:"));
      assert.ok(F.runEvent(store, scheduler, svc.onScore, F.eventOf(scheduler, scoreKey), clock.now).committed);
      const head = F.tx(store, (db) => journal.headId(db).headId);
      let row = F.tx(store, (db) => db.prepare("SELECT * FROM world_seasons WHERE season_no = 1").get());
      assert.deepStrictEqual([Number(row.journal_cursor), Number(row.meter_defense)], [head, 0]);
      assert.strictEqual(svc.getStatus().counters.kindGone, 1);
      clock.now = T0 + 4 * HOUR;
      const finale = [...scheduler.events.keys()].find((k) => k.startsWith("season:1:step:ACTIVE:3")
        || k.startsWith("season:1:step:ACTIVE:0"));
      assert.ok(F.runEvent(store, scheduler, svc.onStep, F.eventOf(scheduler, finale), clock.now).committed);
      row = F.tx(store, (db) => db.prepare("SELECT * FROM world_seasons WHERE season_no = 1").get());
      assert.deepStrictEqual([row.state, row.outcome], ["ARCHIVED", "DRAW"]);
      assert.strictEqual(F.tx(store, (db) => db.prepare("SELECT count(*) AS n FROM world_seasons").get().n), 1);
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([c["crisisHook.KIND_GONE"], c.noCrisis], [1, 1]);
    });
  });
};
