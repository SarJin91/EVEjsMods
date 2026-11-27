"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { rig } = require("./exposureStep.test");
const F = require("../../lib/fleetExposure/factionEscortRules");
const { COUNTER_NAMES } = require("../../lib/materialization/exposureStep");
const { carriersOf } = require("../../lib/economy/logistics/cargo");
const { CARRIER_GROUPS } = require("../../lib/economy/data/cargoVolumes");
const { resolveConfig } = require("../../config");

const { S } = H;
const { setup, convoyFleet, intoWindow, CHAR, PLAYER_SHIP, pos, stagedMiner } = rig;
const MOD_DIR = path.resolve(__dirname, "..", "..");
const PIRATE = 500010;
const EXIT = pos(1e10);
const AT_GATE = pos(1e10 + 1000);
const NEAR_ENTRY = pos(-1e10 + 1000);
const ON = Object.freeze({ convoyEscortsEnabled: true });
const ENV = "EVEJS_LNE_FLEET_EXPOSURE_";

function escortRig(base, opts = {}) {
  const t = setup(base, { ...opts, settings: { ...ON, ...(opts.settings || {}) } });
  const w = t.w;
  const read = w.scene.readShips;
  w.scene.readShips = (sys, ids) => {
    const r = read(sys, ids);
    return { ...r, ships: r.ships.map((s) => ({ ...s, vendorOrder: { attackTargetId: w.npc.get(s.entityId).target
      || 0 } })) };
  };
  w.scene.attackTargets = (sys, ids, targets) => {
    w.calls.push(["attackTargets", sys, [...ids], [...targets]]);
    for (const id of ids) if (w.npc.has(id)) w.npc.get(id).target = targets[0];
    return { ok: true, failed: [] };
  };
  w.scene.setSearch = (sys, ids) => {
    w.calls.push(["setSearch", sys, [...ids]]);
    for (const id of ids) if (w.npc.has(id)) w.npc.get(id).target = 0;
    return { ok: true, failed: [] };
  };
  w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N6, position: opts.playerAt || AT_GATE }];
  return t;
}

function ambushOpts(o = {}) {
  return { playerAt: o.playerAt, secClassOf: () => "nullsec", pirateFactionOf: () => PIRATE,
    settings: { ambushEnabled: true, ambushChancePermilleNullsec: 1000, ambushDelayMs: o.delayMs || 0 } };
}

function withAmbush(t) {
  t.w.npcSpawn.engage = (sys, x, y) => {
    t.w.calls.push(["engage", sys, [...x], [...y]]);
    return { ok: true };
  };
  t.w.npcSpawn.listAlive = (sys, ids) => ids.filter((id) => t.w.npc.has(id));
  return t;
}

const orders = (t) => t.w.calls.filter((x) => x[0] === "attackTargets");
const spawnProfiles = (t) => t.w.calls.filter((x) => x[0] === "spawnShip").map((x) => x[4]);
const reservations = (t) => t.budget.getStatus({ includeReservations: true }).reservations.map((r) => r.reservationId);

function shown(t, tag) {
  const c = convoyFleet(t, tag);
  const despawnAt = intoWindow(t, c);
  t.pass();
  const ids = t.w.ids();
  return { c, despawnAt, carriers: ids.slice(0, 2), escort: ids.slice(2, 4) };
}

module.exports = ({ test, skip }) => {
  const pureChecks = () => {
    const carriers = ["industrial", "freighter"];
    assert.strictEqual(F.exposeGroupsOf(carriers, ["frigate"], false), carriers);
    assert.deepStrictEqual(F.exposeGroupsOf(carriers, ["frigate", "industrial", "cruiser"], true),
      ["industrial", "freighter", "frigate", "cruiser"]);
    const D = resolveConfig({ modDir: MOD_DIR, env: {} }).config.fleetExposure;
    assert.deepStrictEqual([D.convoyEscortsEnabled, D.convoyEscortHullGroups, D.convoyEscortTargetPlayers,
      D.convoyEscortMaxOrdersPerPass, D.convoyEscortMaxTargets], [false, "frigate,destroyer,cruiser", true, 8, 16]);
    assert.deepStrictEqual(F.escortGroupsOf(D), ["frigate", "destroyer", "cruiser"]);
    assert.deepStrictEqual(F.escortGroupsOf({ convoyEscortHullGroups: "nope" }), []);
    const bad = resolveConfig({ modDir: MOD_DIR, env: { [`${ENV}CONVOY_ESCORTS_ENABLED`]: "1",
      [`${ENV}CONVOY_HULL_GROUPS`]: "industrial,frigate" } });
    assert.ok(bad.errors.some((x) => x.includes("convoyEscortHullGroups") && x.includes("frigate")), bad.errors.join());
    const quiet = resolveConfig({ modDir: MOD_DIR, env: { [`${ENV}CONVOY_HULL_GROUPS`]: "industrial,frigate" } });
    assert.ok(!quiet.errors.some((x) => x.includes("convoyEscortHullGroups")), "flag off: no error");
    assert.deepStrictEqual([F.wakeReasonOf({ phase: "VISIBLE" }), F.wakeReasonOf({ phase: "HELD" }),
      F.wakeReasonOf({ phase: "EXITING" }), F.wakeReasonOf({ phase: "VISIBLE", ambushEngaged: true }),
      F.wakeReasonOf({ phase: "VISIBLE", playerAggression: true })], [null, "CLAIM", "CLAIM", "AMBUSH", "PLAYER"]);
    const players = [{ entityId: 11, position: pos(10) }, { entityId: 12, position: pos(5), capsule: true },
      { entityId: 13, position: pos(3) }, { entityId: 14, position: pos(1), inWarp: true }];
    const x = { escortShips: [{ entityId: 1, position: pos(0) }], players, hostileShips: new Set([11, 12, 13, 14]),
      pirates: [21, 13, 22], targetPlayers: true };
    assert.deepStrictEqual(F.escortTargetsOf(x).map((q) => q.entityId), [13, 11, 21, 22]);
    assert.deepStrictEqual(F.escortTargetsOf({ ...x, targetPlayers: false }).map((q) => q.entityId), [21, 13, 22]);
    assert.deepStrictEqual(F.escortTargetsOf({ ...x, hostileShips: new Set(), pirates: [] }), []);
    for (const n of ["factionEscortShips", "factionEscortTrimmed", "factionEscortNoProfile", "factionEscortWakes",
      "factionEscortOrders", "factionEscortOrderFailed", "factionEscortLost", "factionEscortTargetsFull"]) {
      assert.ok(COUNTER_NAMES.includes(n), n);
    }
  };

  const driver = H.loadDriver();
  if (!driver.ok) {
    test("FE1 pure rules + config (the store part needs better-sqlite3)", pureChecks);
    skip("FE1-FE5 faction escort", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FE1 composition: rules + config; flag off = 2 carriers (no escort state); on = 4 ships, carriers first; "
    + "maxShipsPerExposure 3 = 2 carriers + 1 escort (factionEscortTrimmed 1); an escort without a combat profile "
    + "stays virtual (no ORE fallback)", () => H.withStore(driver, async (reopen) => {
    pureChecks();
    const off = escortRig(reopen, { settings: { convoyEscortsEnabled: false } });
    shown(off, "fe1off");
    assert.deepStrictEqual(spawnProfiles(off), ["p_industrial", "p_industrial"]);
    assert.strictEqual(off.step.getStatus().entries[0].factionEscort, null);
    assert.ok(Object.keys(off.counters()).filter((k) => k.startsWith("factionEscort"))
      .every((k) => off.counters()[k] === 0));

    const on = escortRig(off.base);
    shown(on, "fe1on");
    assert.deepStrictEqual(spawnProfiles(on), ["p_industrial", "p_industrial", "p_frigate", "p_frigate"]);
    assert.deepStrictEqual(on.step.getStatus().entries[0].factionEscort, { awake: false, wokeBy: null, ships: 2,
      lost: 0, orders: 0, targets: 0 });
    assert.deepStrictEqual([on.counters().factionEscortShips, on.counters().factionEscortTrimmed], [2, 0]);
    assert.strictEqual(on.w.calls.find((x) => x[0] === "warpShips")[1].length, 4, "the escort warps with the carriers");

    const cut = escortRig(off.base, { settings: { maxShipsPerExposure: 3 } });
    shown(cut, "fe1cut");
    assert.deepStrictEqual(spawnProfiles(cut), ["p_industrial", "p_industrial", "p_frigate"]);
    assert.deepStrictEqual([cut.counters().factionEscortShips, cut.counters().factionEscortTrimmed], [1, 1]);

    const noProf = escortRig(off.base);
    noProf.w.profileOk = (r) => r.hullGroup !== "frigate";
    shown(noProf, "fe1np");
    assert.deepStrictEqual(spawnProfiles(noProf), ["p_industrial", "p_industrial"]);
    assert.deepStrictEqual([noProf.counters().factionEscortNoProfile, noProf.counters().factionEscortTrimmed,
      noProf.step.getStatus().entries[0].factionEscort], [2, 0, null]);
  }));

  test("FE2 wake and orders: none before an aggression; a player attack -> CLAIM -> HELD -> attackTargets per live "
    + "escort on the player ship, none for the carriers, no repeat; startExit -> setSearch before the exit warp; "
    + "ambush WAITING = no order, ENGAGED = the pirates", () => H.withStore(driver, async (reopen) => {
    const t = escortRig(reopen);
    const { carriers, escort } = shown(t, "fe2");
    t.pass(1000);
    assert.strictEqual(orders(t).length, 0, "asleep before an aggression");
    t.w.aggressors.set(escort[0], { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
    t.pass(1000);
    assert.strictEqual(t.step.getStatus().held, 1);
    assert.deepStrictEqual(orders(t).map((x) => x.slice(1)), [[S.N6, [escort[0]], [PLAYER_SHIP]],
      [S.N6, [escort[1]], [PLAYER_SHIP]]]);
    assert.ok(!orders(t).some((x) => carriers.includes(x[2][0])));
    const st = t.step.getStatus().entries[0].factionEscort;
    assert.deepStrictEqual([st.awake, st.wokeBy, st.orders, st.targets, t.counters().factionEscortWakes],
      [true, "CLAIM", 2, 1, 1]);
    t.pass(1000);
    assert.strictEqual(orders(t).length, 2, "a ship with the target gets no new order");
    t.pass(t.settings.holdQuietMs);
    assert.strictEqual(t.step.getStatus().exiting, 1);
    const at = (name) => t.w.calls.map((x) => x[0]).lastIndexOf(name);
    assert.deepStrictEqual(t.w.calls[at("setSearch")].slice(1), [S.N6, escort]);
    assert.ok(at("setSearch") < at("warpShips"), "search before the exit warp");

    const a = withAmbush(escortRig(t.base, ambushOpts({ playerAt: NEAR_ENTRY, delayMs: 5000 })));
    a.w.scene.warpShips = (sys, ids) => ({ ok: true, warped: ids.length, failed: [] });
    const b = shown(a, "fe2amb");
    a.pass(a.settings.ambushDelayMs);
    assert.strictEqual(a.step.getStatus().entries[0].ambush.state, "WAITING");
    assert.strictEqual(orders(a).length, 0, "WAITING: the pirates are no target yet");
    const pirates = a.w.ids().filter((id) => !b.carriers.includes(id) && !b.escort.includes(id));
    for (const id of [...b.carriers, ...b.escort]) a.w.npc.get(id).position = { ...EXIT };
    a.pass(1000);
    assert.strictEqual(a.step.getStatus().entries[0].ambush.state, "ENGAGED");
    assert.deepStrictEqual(orders(a).map((x) => [x[2], x[3]]), [[[b.escort[0]], [pirates[0]]],
      [[b.escort[1]], [pirates[1]]]]);
    assert.strictEqual(a.step.getStatus().entries[0].factionEscort.wokeBy, "AMBUSH");
  }));

  test("FE3 escort loss: kill -> CLAIM destroyed [frigate] -> QUIET end with the loss; the player escort with samples "
    + "is still credited (intact carrier); ambushCarriersLost 0; carriersOf unchanged (scaleCargo)", () =>
    H.withStore(driver, async (reopen) => {
      const credits = [];
      const fj = { onEscortCrossing: (x) => {
        credits.push(x);
        return { ok: true, credited: x.characterIds.length, outcome: "APPLIED" };
      } };
      const t = escortRig(reopen, { escortEnabled: true, getFrontJobs: () => fj });
      const { c, escort } = shown(t, "fe3");
      const before = t.fleetOf(c.fleetId).composition.map((x) => ({ ...x }));
      for (let i = 0; i < 3; i += 1) t.pass(1000);
      t.w.kill(escort[0]);
      t.pass(1000);
      assert.strictEqual(t.spy.claims.length, 1);
      const claimed = t.spy.claims[0];
      assert.deepStrictEqual(claimed.destroyed.map((k) => claimed.members.find((m) => m.memberKey === k).hullGroup),
        ["frigate"]);
      for (let i = 0; i < 6 && t.spy.ends.length === 0; i += 1) t.pass(t.settings.holdQuietMs);
      assert.deepStrictEqual(t.spy.ends.map((x) => x.reason), ["QUIET"]);
      assert.strictEqual(t.step.getStatus().recentEnds.pop().losses, 1);
      assert.deepStrictEqual([t.counters().factionEscortLost, t.counters().ambushCarriersLost], [1, 0]);
      assert.deepStrictEqual(credits.map((x) => x.characterIds), [[CHAR]], "An escort loss keeps the credit");
      const after = t.fleetOf(c.fleetId).composition;
      const frig = (comp) => comp.filter((x) => x.hullGroup === "frigate").reduce((n, x) => n + x.count, 0);
      assert.deepStrictEqual([frig(before), frig(after)], [2, 1]);
      assert.strictEqual(carriersOf(after), carriersOf(before), "the delivery scale is the carriers only");
    }));

  test("FE4 holds: escort on -> seedCargo for the 2 carriers only; a carrier group without cargo "
    + "(cargoCarrierGroups) gets no hold; a failed warp -> no seedCargo, cargoSeeded 0", () =>
    H.withStore(driver, async (reopen) => {
      const CARGO = { "mineral/type:34": 1000000 };
      let base = reopen;
      const run = (tag, opts, warpFails) => {
        const t = escortRig(base, opts);
        base = t.base;
        const seeds = [];
        t.w.npcSpawn.seedCargo = (id, items) => {
          seeds.push(id);
          return { ok: true, written: items.length };
        };
        if (warpFails) t.w.scene.warpShips = () => ({ ok: false, reason: "WARP_FAILED" });
        const c = convoyFleet(t, tag);
        t.convoys[t.convoys.length - 1] = { ...t.convoys[t.convoys.length - 1], cargo: CARGO, carriersAtLoad: 2 };
        intoWindow(t, c);
        t.pass();
        return { t, seeds, ids: t.w.ids() };
      };
      const on = run("fe4on", { settings: { cargoLootEnabled: true } });
      assert.deepStrictEqual(on.seeds, on.ids.slice(0, 2));
      assert.strictEqual(on.t.counters().cargoSeeded, 2);
      const low1 = run("fe4low1", { settings: { cargoLootEnabled: true, convoyEscortsEnabled: false,
        convoyHullGroups: "industrial,frigate" }, cargoCarrierGroups: CARRIER_GROUPS });
      assert.strictEqual(low1.ids.length, 4, "frigate shown as a carrier group");
      assert.deepStrictEqual(low1.seeds, low1.ids.slice(0, 2), "no hold for a group without cargo");
      const failed = run("fe4warp", { settings: { cargoLootEnabled: true } }, true);
      assert.deepStrictEqual([failed.seeds.length, failed.t.counters().cargoSeeded, failed.t.counters().spawnFailed,
        failed.ids.length], [0, 0, 1, 0]);
    }));

  test("FE5 idempotence and cleanup: a second killmail of a written escort loss is dropped (one loss); TRANSIT_DONE "
    + "despawns all 4 ships once, the fx: reservation back; a fresh step (restart) shows the escort asleep", () =>
    H.withStore(driver, async (reopen) => {
      const t = escortRig(reopen);
      const { escort } = shown(t, "fe5");
      t.w.kill(escort[0]);
      t.pass(1000);
      assert.strictEqual(t.step.getStatus().held, 1);
      const key = t.step.getStatus().entries[0].fleetId;
      const memberKey = t.spy.claims[0].destroyed[0];
      t.w.tracker.track(key, [{ memberKey, entityId: escort[0] }]);
      t.w.kill(escort[0]);
      t.pass(1000);
      assert.deepStrictEqual([t.counters().lossDropped, t.counters().factionEscortLost], [1, 1]);
      for (let i = 0; i < 6 && t.spy.ends.length === 0; i += 1) t.pass(t.settings.holdQuietMs);
      assert.strictEqual(t.step.getStatus().recentEnds.pop().losses, 1);

      const d = escortRig(t.base);
      const s = shown(d, "fe5b");
      d.clock.set(s.despawnAt);
      d.pass();
      const gone = d.w.calls.filter((x) => x[0] === "despawn");
      assert.deepStrictEqual([d.counters().transitDone, gone.length], [1, 1]);
      assert.deepStrictEqual(gone[0][1], [...s.carriers, ...s.escort]);
      assert.deepStrictEqual(reservations(d), []);

      const r = withAmbush(escortRig(d.base, ambushOpts()));
      const s2 = shown(r, "fe5c");
      r.pass(1000);
      const awake = r.step.getStatus().entries.find((x) => x.fleetId === s2.c.fleetId);
      assert.deepStrictEqual([awake.phase, awake.factionEscort.awake, awake.factionEscort.wokeBy],
        ["VISIBLE", true, "AMBUSH"]);
      const fresh = escortRig(r.base);
      fresh.convoys.push(...r.convoys);
      fresh.clock.set(r.clock.now());
      fresh.pass();
      const again = fresh.step.getStatus().entries.find((x) => x.fleetId === s2.c.fleetId);
      assert.ok(again, "the fresh step shows the crossing again");
      assert.deepStrictEqual([again.factionEscort.awake, again.factionEscort.orders], [false, 0]);
    }));

  test("FE6: a one-volley kill (no live aggressor) -> the killer ship is the escort target; a loss "
    + "of an ENDING entry is dropped and not counted as an escort loss; a MINER member of a shared hull group "
    + "keeps the ORE fallback", () => H.withStore(driver, async (reopen) => {
    const t = escortRig(reopen);
    const { carriers, escort } = shown(t, "fe6");
    t.w.npc.delete(carriers[0]);
    t.w.tracker.note({ itemID: carriers[0] }, { success: true }, { killerCharacterId: CHAR });
    t.pass(1000);
    assert.strictEqual(t.step.getStatus().held, 1);
    assert.deepStrictEqual(orders(t).map((x) => [x[2], x[3]]), [[[escort[0]], [PLAYER_SHIP]],
      [[escort[1]], [PLAYER_SHIP]]]);
    assert.strictEqual(t.step.getStatus().entries[0].factionEscort.targets, 1);

    const g = escortRig(t.base);
    const s = shown(g, "fe6end");
    g.w.kill(s.carriers[0]);
    g.pass(1000);
    const members = g.spy.claims[0].members;
    g.facade.endInTx = () => ({ ok: false, reason: "END_TEST" });
    for (let i = 0; i < 6 && g.step.getStatus().ending === 0; i += 1) g.pass(g.settings.holdQuietMs);
    assert.strictEqual(g.step.getStatus().ending, 1);
    const key = g.step.getStatus().entries[0].fleetId;
    const frig = members.find((m) => m.hullGroup === "frigate");
    g.w.tracker.track(key, [{ memberKey: frig.memberKey, entityId: s.escort[0] }]);
    const dropped = g.counters().lossDropped;
    g.w.tracker.note({ itemID: s.escort[0] }, { success: true });
    g.pass(1000);
    assert.deepStrictEqual([g.counters().lossDropped - dropped, g.counters().factionEscortLost,
      g.step.getStatus().entries[0].factionEscort.lost], [1, 0, 0]);

    const m = escortRig(g.base, { settings: { minerHullGroups: "frigate" } });
    m.w.profileOk = (req) => req.factionId === 500014;
    stagedMiner(m, "fe6m", [{ hullGroup: "frigate", count: 2 }]);
    m.w.player(S.N0);
    m.pass();
    assert.deepStrictEqual(spawnProfiles(m), ["p_mining_barge", "p_mining_barge"]);
    assert.deepStrictEqual([m.counters().startedMiner, m.counters().profileFallback,
      m.counters().factionEscortNoProfile], [1, 2, 0]);
  }));
};
