"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");
const { rig } = require("./exposureStep.test");
const A = require("../../lib/fleetExposure/ambushRules");
const live = require("../../lib/adapter/data/liveProfiles");
const { resolveConfig } = require("../../config");
const path = require("node:path");

const { S, FACTION_A } = H;
const { setup, convoyFleet, intoWindow, CHAR, PLAYER_SHIP, pos, GATE_OUT } = rig;
const MOD_DIR = path.resolve(__dirname, "..", "..");
const PIRATE = 500010;
const AT_GATE = pos(1e10 + 1000);
const ON = Object.freeze({ ambushEnabled: true, ambushChancePermilleNullsec: 1000, ambushDelayMs: 5000 });

function ambushRig(base, opts = {}) {
  const look = { sec: 0, faction: 0 };
  const penalties = [];
  const t = setup(base, { settings: { ...ON, ...(opts.settings || {}) },
    secClassOf: () => { look.sec += 1; return "nullsec"; },
    pirateFactionOf: () => { look.faction += 1; return PIRATE; },
    getStandings: () => ({ onConvoyPenalty: (p) => { penalties.push(p); return { ok: true, outcome: "CHARGED" }; } }) });
  const w = t.w;
  w.npcSpawn.engage = (sys, a, b, o) => {
    w.calls.push(["engage", sys, [...a], [...b], { ...o }]);
    return { ok: true };
  };
  w.npcSpawn.listAlive = (sys, ids) => ids.filter((id) => w.npc.has(id));
  w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N6, position: opts.playerAt || AT_GATE }];
  return { t, look, penalties };
}

const reservations = (t) => t.budget.getStatus({ includeReservations: true }).reservations
  .map((r) => r.reservationId).sort();
const pirateSpawns = (t) => t.w.calls.filter((x) => x[0] === "spawnShip" && x[4] !== "p_industrial");

function engaged(r, tag) {
  const c = convoyFleet(r.t, tag);
  intoWindow(r.t, c);
  r.t.pass();
  const carriers = r.t.w.ids();
  r.t.pass(r.t.settings.ambushDelayMs);
  const pirates = r.t.w.ids().filter((id) => !carriers.includes(id));
  return { c, carriers, pirates };
}

module.exports = ({ test, skip }) => {
  test("AM1 rollAmbush: the same (fleetId, legSeq, systemIndex) = the same draw, another index another draw; "
    + "0 never, 1000 always; chancePermilleOf wormhole 0; default hull groups are live hull classes", () => {
    const x = { worldSeed: 1234567, fleetId: "flt_a", legSeq: 3, systemIndex: 2, chancePermille: 500 };
    const a = A.rollAmbush(x);
    assert.deepStrictEqual(A.rollAmbush({ ...x }), a);
    assert.ok(a.draw >= 0 && a.draw < 1000);
    assert.notStrictEqual(A.rollAmbush({ ...x, systemIndex: 3 }).draw, a.draw);
    for (let i = 0; i < 20; i += 1) {
      assert.strictEqual(A.rollAmbush({ ...x, legSeq: i, chancePermille: 0 }).hit, false);
      assert.strictEqual(A.rollAmbush({ ...x, legSeq: i, chancePermille: 1000 }).hit, true);
    }
    assert.deepStrictEqual(A.rollAmbush({ ...x, worldSeed: 1.5 }), { hit: false, draw: -1 });
    const D = resolveConfig({ modDir: MOD_DIR, env: {} }).config.fleetExposure;
    assert.deepStrictEqual([A.chancePermilleOf("highsec", D), A.chancePermilleOf("lowsec", D),
      A.chancePermilleOf("nullsec", D), A.chancePermilleOf("wormhole", D), A.chancePermilleOf(null, D)],
    [100, 250, 350, 0, 0]);
    assert.strictEqual(D.ambushEnabled, false);
    const groups = A.ambushGroupsOf(D);
    assert.ok(groups.length > 0 && groups.every((g) => Object.hasOwn(live.HULL_CLASS_BY_GROUP, g)), groups.join());
    assert.deepStrictEqual(A.ambushRequests(["cruiser", "frigate"], 3, PIRATE).map((q) => [q.memberKey, q.hullGroup]),
      [["amb0", "cruiser"], ["amb1", "frigate"], ["amb2", "cruiser"]]);
  });

  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("AM2-AM5 exposure ambush", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("AM2 hit: after ambushDelayMs ambushShips pirates at the exit gate, publish, engage manual attackers-only on "
    + "the carriers, reservation fxa:; the same crossing in a fresh step = the same draw", () => H.withStore(driver,
    async (reopen) => {
      const r = ambushRig(reopen);
      const { t } = r;
      const c = convoyFleet(t, "am2");
      intoWindow(t, c);
      t.pass();
      const carriers = t.w.ids();
      t.pass(1000);
      assert.deepStrictEqual([pirateSpawns(t).length, t.counters().ambushRolled], [0, 0], "before ambushDelayMs");
      t.pass(t.settings.ambushDelayMs);
      const spawns = pirateSpawns(t);
      assert.strictEqual(spawns.length, t.settings.ambushShips);
      assert.ok(spawns.every((s) => s[1] === S.N6 && s[2].kind === "stargate" && s[2].itemID === GATE_OUT
        && s[3] === undefined), JSON.stringify(spawns));
      const prof = t.w.calls.filter((x) => x[0] === "resolveProfiles").pop()[1];
      const key = `${c.fleetId}:${c.legSeq}:2`;
      assert.deepStrictEqual(prof, { seedPrefix: `cab:${key}` });
      assert.strictEqual(t.w.count("publish"), 2, "carriers + pirates");
      const pirates = t.w.ids().filter((id) => !carriers.includes(id));
      const eng = t.w.calls.filter((x) => x[0] === "engage");
      assert.deepStrictEqual(eng, [["engage", S.N6, pirates, carriers, { targetMode: "manual", attackersOnly: true,
        aggroPlayers: false }]]);
      assert.deepStrictEqual(reservations(t), [`fx:${c.fleetId}:${c.legSeq}`, `fxa:${key}`]);
      const st = t.step.getStatus().entries[0].ambush;
      assert.deepStrictEqual([st.state, st.factionId, st.ships, t.counters().ambushStarted,
        t.counters().ambushEngaged], ["ENGAGED", PIRATE, 3, 1, 1]);
      assert.deepStrictEqual([r.look.sec, r.look.faction], [1, 1]);
      t.pass(1000);
      assert.deepStrictEqual([t.counters().ambushRolled, t.w.calls.filter((x) => x[0] === "engage").length], [1, 1],
        "one roll per crossing, no retarget without a change");
      const again = A.rollAmbush({ worldSeed: t.opened.worldSeed, fleetId: c.fleetId, legSeq: c.legSeq,
        systemIndex: 2, chancePermille: 1000 });
      assert.strictEqual(st.draw, again.draw);
      const r2 = ambushRig(t.base);
      r2.t.convoys.push(...t.convoys);
      r2.t.clock.set(t.clock.now());
      r2.t.pass();
      r2.t.pass(r2.t.settings.ambushDelayMs);
      const st2 = r2.t.step.getStatus().entries.find((e) => e.fleetId === c.fleetId).ambush;
      assert.deepStrictEqual([st2.key, st2.draw], [key, st.draw]);
    }));

  test("AM3 a pirate kills a carrier: CLAIM characterId null -> HELD, retarget, no standing charge; the fight holds; "
    + "cleared -> QUIET end with the loss", () => H.withStore(driver, async (reopen) => {
    const r = ambushRig(reopen);
    const { t } = r;
    const { carriers, pirates } = engaged(r, "am3");
    t.w.kill(carriers[0]);
    t.pass(1000);
    assert.strictEqual(t.spy.claims.length, 1);
    assert.deepStrictEqual([t.spy.claims[0].characterId, t.spy.claims[0].destroyed.length], [null, 1]);
    assert.strictEqual(t.step.getStatus().held, 1);
    assert.deepStrictEqual(r.penalties, [], "no charge without a character");
    assert.deepStrictEqual([t.counters().ambushCarriersLost, t.counters().ambushRetargeted], [1, 1]);
    assert.deepStrictEqual(t.w.calls.filter((x) => x[0] === "engage").pop()[3], [carriers[1]]);
    t.pass(t.settings.holdQuietMs);
    assert.strictEqual(t.step.getStatus().held, 1, "the fight keeps the convoy HELD");
    for (const id of pirates) t.w.npc.delete(id);
    t.pass(1000);
    assert.strictEqual(t.counters().ambushCleared, 1);
    assert.ok(!reservations(t).some((x) => x.startsWith("fxa:")), "budget back at CLEARED");
    t.pass(t.settings.holdQuietMs);
    t.pass(1000);
    assert.deepStrictEqual(t.spy.ends.map((e) => e.reason), ["QUIET"]);
    const end = t.step.getStatus().recentEnds.pop();
    assert.strictEqual(end.losses, 1, "the carrier loss is in the one settlement");
    assert.deepStrictEqual(reservations(t), []);
  }));

  test("AM4 cleanup: a fight keeps the crossing past despawnAt; TRANSIT_DONE despawns the pirates with the carriers, "
    + "both reservations back; a live ambush never in freeable(); a cleared one yields (PREEMPTED)", () =>
    H.withStore(driver, async (reopen) => {
      const r = ambushRig(reopen, { settings: { ambushDelayMs: 0 } });
      const { t } = r;
      const { c, carriers, pirates } = engaged(r, "am4");
      assert.deepStrictEqual(t.step.freeable(S.N6), { system: 0, global: 0 }, "a live ambush never yields");
      const engagedAt = t.step.getStatus().entries[0].ambush.engagedAt;
      const despawnAt = c.leg.departAt + 3 * c.leg.jumpMs - t.settings.transitEndMarginMs;
      t.clock.set(despawnAt);
      t.pass();
      assert.strictEqual(t.step.getStatus().visible, 1, "The fight holds the crossing");
      t.clock.set(Math.max(despawnAt, engagedAt + t.settings.ambushFightMs));
      t.pass();
      assert.strictEqual(t.counters().transitDone, 1);
      const gone = t.w.calls.filter((x) => x[0] === "despawn").pop()[1];
      assert.deepStrictEqual(gone, [...carriers, ...pirates]);
      assert.deepStrictEqual(reservations(t), []);

      const r2 = ambushRig(t.base, { settings: { ambushDelayMs: 0 } });
      const b = engaged(r2, "am4b");
      for (const id of b.pirates) r2.t.w.npc.delete(id);
      r2.t.pass(1000);
      assert.deepStrictEqual(r2.t.step.freeable(S.N6), { system: 2, global: 2 });
      const y = r2.t.step.yieldShips(S.N6, { system: 2, global: 0 }, r2.t.clock.now());
      assert.deepStrictEqual([y.ok, y.entries], [true, 1]);
      assert.deepStrictEqual(r2.t.w.calls.filter((x) => x[0] === "despawn").pop()[1], [...b.carriers, ...b.pirates]);
      assert.deepStrictEqual(reservations(r2.t), []);
    }));

  test("AM5 flag off / player out of range: no roll, no lookup, no pirate profile or spawn; vendor precondition "
    + "allowFriendlyNpcTargets on the carrier and the pirate behaviour", () => H.withStore(driver, async (reopen) => {
    const off = ambushRig(reopen, { settings: { ambushEnabled: false } });
    const c = convoyFleet(off.t, "am5a");
    intoWindow(off.t, c);
    for (let i = 0; i < 4; i += 1) off.t.pass(i === 0 ? 0 : 5000);
    const far = ambushRig(off.t.base, { playerAt: pos(0) });
    const c2 = convoyFleet(far.t, "am5b");
    intoWindow(far.t, c2);
    for (let i = 0; i < 4; i += 1) far.t.pass(i === 0 ? 0 : 5000);
    for (const x of [off, far]) {
      assert.strictEqual(x.t.step.getStatus().visible >= 1, true);
      assert.deepStrictEqual([pirateSpawns(x.t).length, x.t.counters().ambushRolled, x.look.sec, x.look.faction,
        x.t.w.calls.filter((k) => k[0] === "resolveProfiles" && String(k[1].seedPrefix).startsWith("cab:")).length],
      [0, 0, 0, 0, 0]);
      assert.strictEqual(x.t.step.getStatus().entries[0].ambush, null);
    }
    assert.strictEqual(live.HUNT_SEARCH_BEHAVIOR.allowFriendlyNpcTargets, true);
    assert.strictEqual(live.COMBAT_BEHAVIOR_MANUAL.allowFriendlyNpcTargets, true);
    assert.strictEqual(FACTION_A !== PIRATE, true);
  }));
};
