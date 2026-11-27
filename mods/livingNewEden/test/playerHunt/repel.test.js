"use strict";

const assert = require("node:assert");

const { planRepel, REPEL_ROWS } = require("../../lib/playerHunt/repel");
const { END_ROWS } = require("../../lib/playerHunt/huntRepository");
const { startPlayerHunt } = require("../../lib/playerHunt");
const { repelKey } = require("../../lib/playerHunt/schema");
const { createUnavailableOccupation } = require("../../lib/world/occupation");
const OS = require("../../lib/world/occupation/schema");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("../world/occupationRepel.test");

const CHAR = 90000001;
const P = 500;

const m = (state) => ({ state });
const members = (spawned, destroyed, planned = 0) => [...Array(destroyed).fill(0).map(() => m("DESTROYED")),
  ...Array(spawned - destroyed).fill(0).map(() => m("SPAWNED")), ...Array(planned).fill(0).map(() => m("PLANNED"))];

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("RP1 planRepel table: DESTROYED, RETREATED without losses, 7/14 at 500 -> repel; 6/14, no losses, only "
    + "PLANNED -> no repel; a bad input -> repel false without a throw", () => {
    const rows = [
      [{ members: members(3, 3), reason: "WIPED", outcome: "DESTROYED" }, { repel: true, why: "DESTROYED" }],
      [{ members: members(4, 0), reason: "RETREATED", outcome: "RELEASED" }, { repel: true, why: "RETREATED" }],
      [{ members: members(14, 7), reason: "TIMEOUT", outcome: "RELEASED" }, { repel: true, why: "LOSSES" }],
      [{ members: members(14, 6), reason: "TIMEOUT", outcome: "RELEASED" }, { repel: false, why: "BELOW_THRESHOLD" }],
      [{ members: members(4, 0), reason: "TARGET_GONE", outcome: "RELEASED" }, { repel: false, why: "NO_LOSSES" }],
      [{ members: members(0, 0, 5), reason: "SPAWN_FAILED", outcome: "RELEASED" }, { repel: false, why: "NOT_SPAWNED" }],
      [{ members: members(0, 0, 5), reason: "RETREATED", outcome: "RELEASED" }, { repel: false, why: "NOT_SPAWNED" }],
    ];
    for (const [input, want] of rows) assert.deepStrictEqual(planRepel(input, { lossPermille: P }), want);
    for (const [input, params] of [[null, { lossPermille: P }], [{ members: "x" }, { lossPermille: P }],
      [{ members: members(2, 1) }, null], [{ members: members(2, 1) }, { lossPermille: 0 }],
      [{ members: [null, undefined, 7] }, { lossPermille: P }]]) {
      const r = planRepel(input, params);
      assert.strictEqual(r.repel, false, JSON.stringify(input));
    }
    assert.strictEqual(END_ROWS, 6 + REPEL_ROWS + 1);
    assert.strictEqual(REPEL_ROWS, 5);
  });

  needsDriver("RP4 endInTx of a won hunt: losses and repel once (influence - 15, INVASION -> CONTESTED) "
    + "second endInTx -> duplicate, repel null, one phunt:<id>:repel; RESTART recovery -> repel once; occupation stub "
    + "-> end ok, repel refused", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const opened = reopen();
    const env = R.bootRepel(opened, shared);
    const sys = H.S.N5;
    R.seedInvasion(env, sys, R.GURISTAS, R.SANSHA, { [R.SANSHA]: 50, [R.GURISTAS]: 40 });
    const persistence = { ok: true, store: env.store, journal: env.journal, worldSeed: opened.worldSeed };
    const started = startPlayerHunt({ config: env.config, persistence, clock: shared.clock,
      getFleets: () => env.fleets, getOccupation: () => env.occupation });
    assert.ok(started.ok, JSON.stringify(started));
    const ph = started.playerHunt;

    const liveHunt = (facade, tag, lost) => {
      const c = env.fleets.createFleet({ factionId: R.SANSHA, currentSystemId: sys, homeSystemId: sys,
        fleetRole: "invasion", composition: [{ hullGroup: "frigate", count: 4 }] }, `${tag}:create`);
      assert.ok(c.ok, JSON.stringify(c));
      const fleet = env.tx((db) => env.fleets.repository.getFleet(db, c.fleetId)).fleet;
      const claim = env.tx((db) => facade.claimInTx(db, { fleetId: c.fleetId, expectedVersion: fleet.version,
        characterId: CHAR, systemId: sys, mode: "SWEEP", standing: -6, at: shared.clock.now() }));
      assert.ok(claim.ok, JSON.stringify(claim));
      assert.ok(env.tx((db) => facade.markLiveInTx(db, { huntId: claim.huntId, expectedVersion: 1,
        at: shared.clock.now() })).ok);
      for (const member of claim.members.slice(0, lost)) {
        assert.ok(env.tx((db) => facade.markDestroyedInTx(db, { huntId: claim.huntId,
          memberKey: member.memberKey })).ok);
      }
      return claim.huntId;
    };

    const h1 = liveHunt(ph, "rp4:a", 2);
    shared.clock.advance(1000);
    const end = env.tx((db) => ph.endInTx(db, { huntId: h1, at: shared.clock.now(), reason: "TIMEOUT" }));
    assert.deepStrictEqual([end.ok, end.duplicate, end.outcome, end.losses, end.repel], [true, false, "RELEASED",
      [{ hullGroup: "frigate", typeId: null, count: 2 }], { applied: true, outcome: "APPLIED" }], JSON.stringify(end));
    assert.strictEqual(R.scoreOf(R.systemOf(env, sys), R.SANSHA), 35);
    assert.strictEqual(R.keyCount(env, "world_scheduled_events", OS.repelKey(sys, 2, h1)), 1);
    const again = env.tx((db) => ph.endInTx(db, { huntId: h1, at: shared.clock.now(), reason: "RESTART" }));
    assert.deepStrictEqual([again.ok, again.duplicate, again.repel], [true, true, null]);
    assert.strictEqual(R.keyCount(env, "world_event_journal", repelKey(h1)), 1);
    assert.strictEqual(R.scoreOf(R.systemOf(env, sys), R.SANSHA), 35, "no second drop");

    await R.pass(env);
    const done = R.systemOf(env, sys);
    assert.deepStrictEqual([done.occupationState, done.occupierFactionId], [OS.CONTESTED, R.SANSHA]);

    const h2 = liveHunt(ph, "rp4:b", 3);
    shared.clock.advance(1000);
    const rec = ph.recoverStale({ bootAt: shared.clock.now() });
    assert.deepStrictEqual([rec.ok, rec.ended, rec.repelApplied, rec.repelRefused], [true, 1, 1, 0],
      JSON.stringify(rec));
    assert.strictEqual(R.keyCount(env, "world_event_journal", repelKey(h2)), 1);
    assert.strictEqual(R.scoreOf(R.systemOf(env, sys), R.SANSHA), 20);
    const rec2 = ph.recoverStale({ bootAt: shared.clock.now() + 1000 });
    assert.deepStrictEqual([rec2.ended, rec2.repelApplied], [0, 0]);
    assert.strictEqual(R.keyCount(env, "world_event_journal", repelKey(h2)), 1);

    const offStarted = startPlayerHunt({ config: env.config, persistence, clock: shared.clock,
      getFleets: () => env.fleets, getOccupation: () => createUnavailableOccupation("OCCUPATION_DISABLED") });
    assert.ok(offStarted.ok, JSON.stringify(offStarted));
    const h3 = liveHunt(offStarted.playerHunt, "rp4:c", 4);
    const off = env.tx((db) => offStarted.playerHunt.endInTx(db, { huntId: h3, at: shared.clock.now(),
      reason: "WIPED" }));
    assert.deepStrictEqual([off.ok, off.duplicate, off.outcome, off.repel], [true, false, "DESTROYED",
      { applied: false, reason: "OCCUPATION_UNAVAILABLE" }]);
    assert.strictEqual(R.keyCount(env, "world_event_journal", repelKey(h3)), 0);
    assert.strictEqual(R.scoreOf(R.systemOf(env, sys), R.SANSHA), 20);
  }));
};
