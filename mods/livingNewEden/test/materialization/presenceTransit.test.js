"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");
const { harness: P } = require("./presenceStep.test");
const T = require("../../lib/fleetExposure/transitRules");
const { buildLeg } = require("../../lib/fleets/travel");
const { createTransitSweep } = require("../../lib/materialization/presenceTransit");
const { createUnavailableMaterialization } = require("../../lib/materialization/index");

const { S, FACTION_A } = H;
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const TWO = Object.freeze([{ hullGroup: "frigate", count: 2 }]);
const GATE_N5_N0 = 50000050;
const GATE_N5_N6 = 50000056;
const GATE_N6_N5 = 50000065;
const GATE_N6_N7 = 50000067;

function addGates(t) {
  t.w.objects.get(S.N5).push({ kind: "stargate", itemId: GATE_N5_N6, position: P.pos(7e10), toSystemId: S.N6 });
  t.w.objects.set(S.N6, [{ kind: "stargate", itemId: GATE_N6_N5, position: P.pos(-1e10), toSystemId: S.N5 },
    { kind: "stargate", itemId: GATE_N6_N7, position: P.pos(1e10), toSystemId: S.N7 }]);
  t.w.loaded.add(S.N6);
}

function travelling(t, tag, opType, objective, role = "invasion") {
  const env = t.env;
  const r = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.N0, homeSystemId: S.N0, fleetRole: role,
    composition: TWO }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  const op = env.fleets.createOperation({ operationType: opType, factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.N9, objective, dueAt: null, fleets: [{ fleetId: r.fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const p = env.fleets.planTravel({ fleetId: r.fleetId, targetSystemId: S.N9, constraints: AVOID }, `${tag}:plan`);
  assert.ok(p.ok, JSON.stringify(p));
  const f = t.fleetOf(r.fleetId);
  assert.deepStrictEqual([f.state, f.route.systems], ["TRAVELLING", [S.N0, S.N5, S.N6, S.N7, S.N9]]);
  return { fleetId: r.fleetId, leg: f.route, legSeq: f.legSeq };
}

const spawnsAt = (t, from) => t.w.calls.slice(from).filter((c) => c[0] === "spawnShip");
const transitCounters = (t) => {
  const c = t.counters();
  return [c.presenceStartedTransit, c.presenceTransitDone, c.presenceTransitMissed];
};

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PT1: an invasion TRAVELLING through the observed N5 (window 1) -> ships at the entry gate (to N0) "
    + "warp to the exit gate (to N6), zero rows; aggression -> claim PRESENCE with a crossing (halt: MATERIALIZED in "
    + "N5, row from_state STAGED); a kill, quiet -> END -> STAGED in N5, one loss once; a second crossing -> TRANSIT_DONE "
    + "at despawnAt and not shown again in its window", () => H.withStore(driver, async (reopen) => {
    const t = P.setup(reopen);
    assert.strictEqual(t.held.presence.transitEnabled, true, "on under presence.enabled");
    addGates(t);
    const inv = travelling(t, "pt1", "invasion", "capture");
    t.w.player(S.N5);
    t.clock.set(inv.leg.departAt + inv.leg.jumpMs + 1000);
    const despawnAt = inv.leg.departAt + 2 * inv.leg.jumpMs - t.held.transitEndMarginMs;
    assert.ok(despawnAt - t.clock.now() >= t.held.transitMinRemainingMs, `jumpMs ${inv.leg.jumpMs} too short`);
    const rows0 = t.rows();
    t.pass();
    const e = t.entryOf(inv.fleetId);
    assert.deepStrictEqual([e.phase, e.ships, e.claimable, e.transit], ["VISIBLE", 2, true,
      { systemIndex: 1, despawnAt, toSystemId: S.N6 }]);
    assert.deepStrictEqual(spawnsAt(t, 0).map((c) => [c[1], c[2].itemID, c[3]]),
      [[S.N5, GATE_N5_N0, "search"], [S.N5, GATE_N5_N0, "search"]]);
    const warp = t.w.calls.find((c) => c[0] === "warpShips");
    assert.deepStrictEqual(warp[1], e.entityIds);
    assert.ok(e.entityIds.every((id) => t.w.npc.get(id).position.x === 7e10), "warped to the gate to N6");
    assert.deepStrictEqual(t.rows(), rows0, "VISIBLE writes nothing");
    assert.deepStrictEqual(transitCounters(t), [1, 0, 0]);
    assert.strictEqual(t.fleetOf(inv.fleetId).state, "TRAVELLING");
    t.w.aggressors.set(e.entityIds[0], {});
    t.pass(1000);
    const f1 = t.fleetOf(inv.fleetId);
    assert.deepStrictEqual([t.entryOf(inv.fleetId).phase, f1.state, f1.currentSystemId], ["HELD", "MATERIALIZED", S.N5]);
    const row = () => t.env.tx((db) => db.prepare("SELECT kind, state, from_state, system_id FROM "
      + "world_fleet_exposures WHERE fleet_id = ?").all(inv.fleetId));
    assert.deepStrictEqual(row(), [{ kind: "PRESENCE", state: "HELD", from_state: "STAGED", system_id: S.N5 }]);
    t.w.kill(e.entityIds[1]);
    t.pass(1000);
    t.w.aggressors.clear();
    t.pass(t.held.holdQuietMs);
    assert.strictEqual(t.entryOf(inv.fleetId).phase, "EXITING");
    t.pass(1000);
    const f2 = t.fleetOf(inv.fleetId);
    assert.deepStrictEqual([f2.state, f2.currentSystemId, f2.shipCount, t.counters().presenceEnded],
      ["STAGED", S.N5, 1, 1]);
    assert.strictEqual(row()[0].state, "ENDED");
    t.pass(1000);
    assert.strictEqual(t.fleetOf(inv.fleetId).shipCount, 1, "one loss, once");

    const u = P.setup(t.base, { settings: { scanIntervalMs: 1000 } });
    addGates(u);
    const b = travelling(u, "pt1b", "invasion", "capture");
    u.w.player(S.N5);
    u.clock.set(b.leg.departAt + b.leg.jumpMs + 1000);
    u.pass();
    assert.strictEqual(u.entryOf(b.fleetId).phase, "VISIBLE");
    u.clock.set(u.entryOf(b.fleetId).transit.despawnAt);
    const mark = u.w.calls.length;
    u.pass();
    assert.deepStrictEqual([u.entryOf(b.fleetId), transitCounters(u)], [null, [1, 1, 0]]);
    u.pass(1000);
    assert.ok(u.clock.now() < b.leg.departAt + 2 * b.leg.jumpMs, "still in the window");
    assert.deepStrictEqual([u.entryOf(b.fleetId), spawnsAt(u, mark).length], [null, 0], "not shown again");
  }));

  needsDriver("PT2: the cursor reads 2 pages (scanMaxTravelling 2, 3 fleets: TRAVELLING page 1, page 2, then "
    + "RETREATING); the fleets of page 1 indexed in window 0 show up in N6 (window 2) without a new read of their page; "
    + "window 1 in N5 observed before the first read of page 2 -> presenceTransitMissed 1 (the plan of the page query: "
    + "fleets.test F1)", () => H.withStore(driver, async (reopen) => {
    const t = P.setup(reopen, { settings: { scanMaxTravelling: 2 } });
    addGates(t);
    const ids = [travelling(t, "pt2a", "invasion", "capture"), travelling(t, "pt2b", "invasion", "capture"),
      travelling(t, "pt2c", "invasion", "capture")];
    const leg = ids[0].leg;
    const sorted = ids.map((x) => x.fleetId).sort();
    t.w.player(S.N5);
    t.clock.set(Math.max(...ids.map((x) => x.leg.departAt)) + 1000);
    assert.ok(t.clock.now() < leg.departAt + leg.jumpMs, "window 0");
    t.pass();
    const s1 = t.step.getStatus().transit;
    assert.deepStrictEqual([s1.legs, s1.cursor, t.step.getStatus().entries.length],
      [2, { state: "TRAVELLING", after: sorted[1] }, 0], "page 1 indexed, nothing crosses N5 yet");
    t.w.players = [{ characterId: P.CHAR, entityId: P.PLAYER_SHIP, systemId: S.N5 },
      { characterId: P.CHAR + 1, entityId: P.PLAYER_SHIP + 1, systemId: S.N6 }];
    t.clock.set(leg.departAt + 2 * leg.jumpMs + 1000);
    t.pass();
    const s2 = t.step.getStatus().transit;
    assert.deepStrictEqual([s2.legs, s2.cursor.state, t.counters().presenceTransitPages,
      t.counters().presenceTransitIndexed], [3, "RETREATING", 2, 3]);
    const shown = t.step.getStatus().entries.filter((e) => e.transit).map((e) => [e.fleetId, e.systemId,
      e.transit.systemIndex]).sort();
    assert.deepStrictEqual(shown, sorted.map((id) => [id, S.N6, 2]), "page 1 fleets from the index, page 2 fresh");
    assert.strictEqual(t.counters().presenceTransitMissed, 1, "window 1 of the page 2 fleet in N5");
    assert.ok(t.w.calls.filter((c) => c[0] === "spawnShip").every((c) => c[2].itemID === GATE_N6_N5));
  }));

  needsDriver("PT3: a leg with a wormhole edge through N5 -> no entry, not indexed (P5); a fleet of a return "
    + "operation in window 1 + aggression -> despawn UNCLAIMABLE, zero writes; a convoy (logistics) with the CONVOY "
    + "path on -> skipped by the transit", () => H.withStore(driver, async (reopen) => {
    const base = P.setup(reopen).base;
    const convoyOn = { ...base, facade: { ...base.facade,
      isKindEnabled: (k) => (k === "CONVOY" ? true : base.facade.isKindEnabled(k)) } };
    const t = P.setup(convoyOn);
    addGates(t);
    const wh = travelling(t, "pt3w", "invasion", "capture");
    const built = buildLeg({ systems: wh.leg.systems, departAt: wh.leg.departAt, jumpMs: wh.leg.jumpMs,
      graphVersion: 1, mode: wh.leg.mode, observed: wh.leg.observed, constraints: {},
      wormholeEdges: [{ i: 1, pairKey: "wh:1", expiresAt: wh.leg.arriveAt + 1 }] });
    assert.ok(built.ok, JSON.stringify(built));
    t.env.tx((db) => db.prepare("UPDATE virtual_fleets SET route_json = ? WHERE fleet_id = ?")
      .run(JSON.stringify(built.leg), wh.fleetId));
    assert.deepStrictEqual(T.legIndexKeys(t.fleetOf(wh.fleetId)), []);
    const ret = travelling(t, "pt3r", "return", "return");
    const cv = travelling(t, "pt3c", "logistics", "deliver", "logistics");
    t.w.player(S.N5);
    t.clock.set(Math.max(wh.leg.departAt, ret.leg.departAt, cv.leg.departAt) + ret.leg.jumpMs + 1000);
    t.pass();
    const entries = t.step.getStatus().entries;
    assert.deepStrictEqual(entries.map((e) => [e.fleetId, e.claimable]), [[ret.fleetId, false]],
      "only the return fleet: no wormhole leg, no convoy");
    assert.deepStrictEqual(t.step.getStatus().transit.legs, 2, "the wormhole leg is not indexed");
    const rows0 = t.rows();
    for (const id of entries[0].entityIds) t.w.aggressors.set(id, {});
    t.pass(1000);
    assert.deepStrictEqual([t.entryOf(ret.fleetId), t.counters().presenceUnclaimable, t.rows()], [null, 1, rows0]);
    assert.strictEqual(t.fleetOf(ret.fleetId).state, "TRAVELLING");
  }));

  needsDriver("PT4: 6 player systems (5 on an indexed leg + N10) under maxSystemsPerScan 2 -> the window "
    + "rotates over every system (the transit systems no longer take it by systemId): an IDLE fleet of each system is "
    + "shown within ceil(6 / 2) = 3 scans, presenceScanSystemsSkipped 4 per scan", () =>
    H.withStore(driver, async (reopen) => {
      const t = P.setup(reopen, { settings: { maxSystemsPerScan: 2 } });
      addGates(t);
      const inv = travelling(t, "pt4", "invasion", "capture");
      const systems = [S.N0, S.N5, S.N6, S.N7, S.N9, S.N10];
      const onLeg = T.legIndexKeys(t.fleetOf(inv.fleetId)).filter((s) => systems.includes(s));
      assert.ok(onLeg.length > 2, `more leg systems than the window: ${JSON.stringify(onLeg)}`);
      const idle = new Map();
      systems.forEach((sys, i) => {
        if (!t.w.objects.has(sys)) t.w.objects.set(sys, []);
        t.w.objects.get(sys).push({ kind: "station", itemId: 60000100 + i, position: P.pos(3e9) });
        t.w.loaded.add(sys);
        const r = t.env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: sys, homeSystemId: sys,
          fleetRole: "garrison", composition: TWO }, `pt4-${i}:create`);
        assert.ok(r.ok, JSON.stringify(r));
        idle.set(r.fleetId, sys);
      });
      t.w.players = systems.map((sys, i) => ({ characterId: P.CHAR + i, entityId: P.PLAYER_SHIP + i, systemId: sys }));
      const shownSystems = () => [...idle.keys()].filter((id) => t.entryOf(id)).map((id) => idle.get(id)).sort();
      t.pass();
      assert.strictEqual(shownSystems().length, 2, "one window of 2 systems");
      t.pass(t.settings.scanIntervalMs);
      t.pass(t.settings.scanIntervalMs);
      assert.deepStrictEqual(shownSystems(), [...systems].sort(), "every system scanned within 3 scans");
      assert.deepStrictEqual([t.counters().presenceScans, t.counters().presenceScanSystemsSkipped], [3, 12]);
    }));

  needsDriver("PT5: a repository without listFleetsByState -> presenceTransitRefused 1, the standing "
    + "presence goes on; a kill pending while the system read of the entries fails, the fleet starts travelling -> "
    + "refreshShown FLEET_MOVED counts presenceLossDropped 1", () => H.withStore(driver, async (reopen) => {
    const t = P.setup(reopen);
    const r = t.env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.N0, homeSystemId: S.N0,
      fleetRole: "garrison", composition: TWO }, "pt5:create");
    assert.ok(r.ok, JSON.stringify(r));
    const g = r.fleetId;
    t.w.player(S.N0);
    const real = t.env.fleets;
    t.env.fleets = { ...real, repository: { ...real.repository, listFleetsByState: undefined } };
    try {
      t.pass();
    } finally {
      t.env.fleets = real;
    }
    assert.deepStrictEqual([t.counters().presenceTransitRefused, t.entryOf(g) && t.entryOf(g).phase], [1, "VISIBLE"]);
    t.w.kill(t.entryOf(g).entityIds[0]);
    t.w.scene.readPlayerShips = () => ({ ok: false, reason: "READ_FAILED" });
    const op = real.createOperation({ operationType: "invasion", factionId: FACTION_A, originSystemId: S.N0,
      targetSystemId: S.N9, objective: "capture", dueAt: null,
      fleets: [{ fleetId: g, expectedVersion: t.fleetOf(g).version }] }, "pt5:op");
    assert.ok(op.ok, JSON.stringify(op));
    const p = real.planTravel({ fleetId: g, targetSystemId: S.N9, constraints: AVOID }, "pt5:plan");
    assert.ok(p.ok, JSON.stringify(p));
    assert.strictEqual(t.counters().presenceLossDropped, 0);
    t.pass(t.settings.scanIntervalMs);
    const after = t.entryOf(g);
    assert.deepStrictEqual([after === null || Boolean(after.transit), t.counters().presenceLossDropped], [true, 1]);
  }));

  test("IN1 inboundTo: [A,B,C,D] 60 s, k=0 -> B with the eta to the end of the window; k=2 -> D (the last jump "
    + "not in legIndexKeys), C passed = none; after the leg = none; RETREATING / before departAt / wormhole = none; "
    + "two fleets sorted by eta, cut to max", () => {
    const [A, B, C, D, E] = [101, 102, 103, 104, 109];
    const JUMP = 60000;
    const T0 = 1000000;
    const legOf = (systems, departAt, extra) => {
      const r = buildLeg({ systems, departAt, jumpMs: JUMP, graphVersion: 1, mode: "travel", observed: false,
        ...(extra || {}) });
      assert.ok(r.ok, JSON.stringify(r));
      return r.leg;
    };
    const fleet = (fleetId, state, route) => ({ fleetId, legSeq: 1, state, route });
    const pages = {
      TRAVELLING: [fleet("f1", "TRAVELLING", legOf([A, B, C, D], T0)),
        fleet("f3", "TRAVELLING", legOf([A, B, C, D], T0 + 10 * JUMP)),
        fleet("f4", "TRAVELLING", legOf([A, B, C, D], T0, { constraints: {},
          wormholeEdges: [{ i: 0, pairKey: "wh-ab", expiresAt: T0 + 100 * JUMP }] })),
        fleet("f5", "TRAVELLING", legOf([E, B], T0 - 30000))],
      RETREATING: [fleet("f2", "RETREATING", { ...legOf([A, B, C, D], T0), mode: "retreat" })],
    };
    const repo = { listFleetsByState: (_db, state) => ({ ok: true, fleets: pages[state] || [], nextAfterFleetId: null }) };
    const sweep = createTransitSweep({ settings: { scanMaxTravelling: 16, transitPagesPerScan: 2, transitIndexMax: 64 },
      heldSettings: { transitEndMarginMs: 0 } });
    const now0 = T0 + 10000;
    assert.ok(sweep.sweepInTx({}, repo, now0).ok);
    assert.deepStrictEqual(sweep.inboundTo(B, now0, 8), [{ fleetId: "f5", legSeq: 1, etaMs: 20000 },
      { fleetId: "f1", legSeq: 1, etaMs: 50000 }]);
    assert.deepStrictEqual(sweep.inboundTo(B, now0, 1).map((x) => x.fleetId), ["f5"], "cut to max");
    assert.deepStrictEqual(sweep.inboundTo(C, now0, 8), [], "k=0: C is two jumps away");
    const now2 = T0 + 2 * JUMP + 5000;
    assert.deepStrictEqual(sweep.inboundTo(D, now2, 8), [{ fleetId: "f1", legSeq: 1, etaMs: 55000 }]);
    assert.deepStrictEqual([sweep.inboundTo(C, now2, 8), sweep.inboundTo(B, now2, 8)], [[], []], "passed");
    assert.deepStrictEqual(sweep.inboundTo(D, T0 + 3 * JUMP, 8), [], "the leg is over");
  });

  needsDriver("IN3 presenceStep.inboundFleets: transitEnabled false -> TRANSIT_OFF; on, one sweep -> the "
    + "TRAVELLING fleet heading into N5; stop -> STOPPED; the stub -> UNAVAILABLE", () => H.withStore(driver,
    async (reopen) => {
      const off = P.setup(reopen, { settings: { transitEnabled: false } });
      assert.deepStrictEqual(off.step.inboundFleets(S.N5, off.clock.now(), 8), { ok: false, reason: "TRANSIT_OFF" });
      const t = P.setup(off.base);
      const inv = travelling(t, "in3", "invasion", "capture");
      t.clock.set(inv.leg.departAt + 1000);
      t.pass();
      assert.deepStrictEqual(t.step.inboundFleets(S.N5, t.clock.now(), 8), { ok: true,
        fleets: [{ fleetId: inv.fleetId, legSeq: inv.legSeq, etaMs: inv.leg.jumpMs - 1000 }] });
      assert.deepStrictEqual(t.step.inboundFleets(S.N6, t.clock.now(), 8), { ok: true, fleets: [] });
      t.step.stop();
      assert.deepStrictEqual(t.step.inboundFleets(S.N5, t.clock.now(), 8), { ok: false, reason: "STOPPED" });
      assert.deepStrictEqual(createUnavailableMaterialization("x").inboundFleets(1, 0, 8),
        { ok: false, reason: "UNAVAILABLE" });
    }));
};
