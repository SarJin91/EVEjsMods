"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");
const { rig } = require("./exposureStep.test");

const { S, FACTION_A } = H;
const { setup, convoyFleet, intoWindow, CHAR, PLAYER_SHIP, pos } = rig;
const CHAR2 = 90000002;
const SHIP2 = 1090000002;
const AT_GATE = pos(1e10 + 1000);

function escortRig(base, opts = {}) {
  const calls = [];
  const fj = { onEscortCrossing: (c) => {
    calls.push(c);
    if (opts.throwOnce && calls.length === 1) throw new Error("facade fault");
    return { ok: true, credited: c.characterIds.length, outcome: "APPLIED" };
  } };
  const t = setup(base, { escortEnabled: true, getFrontJobs: () => fj });
  return { t, calls };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("E4 exposure escort credit", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("E4 escort: 3 passes in range + TRANSIT_DONE -> one call; aggressor never; QUIET end once; WIPED none",
    () => H.withStore(driver, async (reopen) => {
      const { t, calls } = escortRig(reopen);
      const c = convoyFleet(t, "e4a");
      t.w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N6, position: AT_GATE }];
      const despawnAt = intoWindow(t, c);
      t.pass();
      for (let i = 0; i < 3; i += 1) t.pass(1000);
      assert.strictEqual(calls.length, 0, "no call before the end");
      t.clock.set(despawnAt);
      t.pass();
      assert.strictEqual(t.counters().transitDone, 1);
      assert.deepStrictEqual(calls, [{ ownerFactionId: FACTION_A, systemId: S.N6, characterIds: [CHAR],
        atMs: despawnAt }]);
      assert.strictEqual(t.counters().escortCrossings, 1);

      const b = escortRig(t.base, { throwOnce: true });
      const c2 = convoyFleet(b.t, "e4b");
      b.t.w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N6, position: AT_GATE },
        { characterId: CHAR2, entityId: SHIP2, systemId: S.N6, position: AT_GATE }];
      intoWindow(b.t, c2);
      b.t.pass();
      for (let i = 0; i < 3; i += 1) b.t.pass(1000);
      const [ship] = b.t.w.ids();
      b.t.w.aggressors.set(ship, { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      b.t.pass(1000);
      assert.strictEqual(b.t.step.getStatus().held, 1);
      b.t.w.stamps.set(ship, { aggressorEntityId: PLAYER_SHIP, aggressedAtMs: 7 });
      b.t.pass(1000);
      b.t.pass(b.t.settings.holdQuietMs);
      assert.strictEqual(b.t.step.getStatus().exiting, 1);
      const realEnd = b.t.facade.endInTx;
      let refused = 0;
      b.t.facade.endInTx = (db, req) => {
        if (refused === 0) {
          refused += 1;
          return { ok: false, reason: "VERSION_CONFLICT" };
        }
        return realEnd(db, req);
      };
      b.t.pass(1000);
      assert.deepStrictEqual([b.t.step.getStatus().ending, b.calls.length], [1, 0], "a failed end credits nothing");
      b.t.pass(1000);
      assert.deepStrictEqual(b.t.spy.ends.map((e) => e.reason), ["QUIET"], "the retry reached the real end");
      assert.deepStrictEqual(b.calls.map((x) => x.characterIds), [[CHAR2]], "the aggressor is never credited");
      assert.deepStrictEqual([b.t.counters().escortCrossings, b.t.counters().escortRefused], [1, 1],
        "the facade threw once: counted, never retried");
      b.t.pass(1000);
      assert.strictEqual(b.calls.length, 1, "one call for the crossing");

      const w = escortRig(t.base);
      const c3 = convoyFleet(w.t, "e4c");
      w.t.w.players = [{ characterId: CHAR2, entityId: SHIP2, systemId: S.N6, position: AT_GATE }];
      intoWindow(w.t, c3);
      w.t.pass();
      for (let i = 0; i < 3; i += 1) w.t.pass(1000);
      const [x, y] = w.t.w.ids();
      w.t.w.kill(x);
      w.t.pass(1000);
      w.t.w.kill(y);
      w.t.pass(1000);
      assert.deepStrictEqual(w.t.spy.ends.map((e) => e.reason), ["WIPED"]);
      assert.deepStrictEqual([w.calls.length, w.t.counters().escortCrossings], [0, 0]);
    }));

  test("ESC1: a HELD convoy ended SCENE_GONE with carriers without a written loss credits nobody "
    + "the crossing is done (no second exposure in its window)", () => H.withStore(driver, async (reopen) => {
    const { t, calls } = escortRig(reopen);
    const c = convoyFleet(t, "esc1");
    t.w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N6, position: AT_GATE },
      { characterId: CHAR2, entityId: SHIP2, systemId: S.N6, position: AT_GATE }];
    intoWindow(t, c);
    t.pass();
    for (let i = 0; i < 3; i += 1) t.pass(1000);
    const [ship] = t.w.ids();
    t.w.aggressors.set(ship, { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
    t.pass(1000);
    assert.strictEqual(t.step.getStatus().held, 1);
    for (const id of t.w.ids()) t.w.npc.delete(id);
    t.pass(1000);
    assert.deepStrictEqual(t.spy.ends.map((e) => e.reason), ["SCENE_GONE"]);
    assert.deepStrictEqual([calls.length, t.counters().escortCrossings], [0, 0], "SCENE_GONE never credits");
    const started = t.counters().startedConvoy;
    t.pass(1000);
    t.pass(1000);
    assert.strictEqual(t.counters().startedConvoy, started, "the crossing ended HELD is not shown again");
  }));

  test("ESC2: two attackers of one convoy, the reads show only the second, the first kills a ship "
    + "between passes -> neither is credited at the QUIET end; the honest escort is", () => H.withStore(driver,
    async (reopen) => {
      const CHAR3 = 90000003;
      const SHIP3 = 1090000003;
      const { t, calls } = escortRig(reopen);
      const c = convoyFleet(t, "esc2");
      t.w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N6, position: AT_GATE },
        { characterId: CHAR2, entityId: SHIP2, systemId: S.N6, position: AT_GATE },
        { characterId: CHAR3, entityId: SHIP3, systemId: S.N6, position: AT_GATE }];
      intoWindow(t, c);
      t.pass();
      for (let i = 0; i < 3; i += 1) t.pass(1000);
      const [x, y] = t.w.ids();
      t.w.aggressors.set(x, { aggressorId: SHIP2, aggressorKind: "player" });
      t.pass(1000);
      assert.strictEqual(t.step.getStatus().held, 1);
      t.w.npc.delete(y);
      t.w.tracker.note({ itemID: y }, { success: true }, { killerCharacterId: CHAR });
      t.pass(1000);
      t.w.stamps.set(x, { aggressorEntityId: SHIP2, aggressedAtMs: 7 });
      t.pass(1000);
      t.pass(t.settings.holdQuietMs);
      assert.strictEqual(t.step.getStatus().exiting, 1);
      t.pass(1000);
      assert.deepStrictEqual(t.spy.ends.map((e) => e.reason), ["QUIET"]);
      assert.deepStrictEqual(calls.map((k) => k.characterIds), [[CHAR3]], "no attacker credited");
    }));
};
