"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { createNearLayer } = require("../../lib/population/near");
const { createPilotStore } = require("../../lib/population/store");
const { candidateOf, createLiveOwnership, activityIntentCodes } = require("../../lib/population/live");
const { STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { trafficActivityIntentsOf } = require("../../lib/highsecLife/schema");
const { findCompose, readCompose } = require("../config/composeKeys.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 77;
const T0 = 1700000000000;
const LIVE = F.sid(6);

function row(pilotId, systemId, state, intent) {
  return { pilotId, systemId, prevId: 0, destId: 0, homeId: systemId, shipTypeId: 648, archetype: ARCHETYPE.RATTER,
    intent, state, seq: 0, sinceAt: T0, dueAt: T0 + 3600000, flags: 0 };
}

function nearRig(activityIntents) {
  const pilots = createPilotStore(16);
  pilots.put(row(1, LIVE, STATE.DOCKED, INTENT.DOCK));
  pilots.put(row(2, LIVE, STATE.DOCKED, INTENT.DOCK));
  pilots.put(row(3, F.sid(5), STATE.ACTIVE, INTENT.RAT));
  pilots.put(row(4, LIVE, STATE.ACTIVE, INTENT.MINE));
  pilots.put(row(5, F.sid(12), STATE.DOCKED, INTENT.DOCK));
  pilots.put(row(6, LIVE, STATE.DOCKED, INTENT.DOCK));
  const S = F.settings({ near: { enabled: true, nearJumps: 1, arrivalRingSize: 16, activityRingSize: 16 } });
  const graph = F.fakeGraph();
  const presence = F.fakePresence(graph);
  presence.set([LIVE]);
  const counters = {};
  const near = createNearLayer({ S, worldSeed: SEED, pilots, getPresence: () => presence, getGraph: () => graph,
    getTable: () => F.table(S, graph), bump: (n, k = 1) => { counters[n] = (counters[n] || 0) + k; },
    ...(activityIntents ? { activityIntents } : {}) });
  near.refresh();
  const undock = (id, intent, at, withIntent = true) => {
    const before = pilots.get(id);
    pilots.apply(id, { state: STATE.ACTIVE, intent });
    if (withIntent) near.afterCommit(id, before.systemId, false, at, before.state, before.intent);
    else near.afterCommit(id, before.systemId, false, at, before.state);
  };
  undock(1, INTENT.RAT, T0 + 100);
  undock(2, INTENT.EXPLORE, T0 + 101);
  pilots.apply(3, { systemId: LIVE, prevId: F.sid(5) });
  near.afterCommit(3, F.sid(5), true, T0 + 102, STATE.ACTIVE, INTENT.RAT);
  undock(4, INTENT.RAT, T0 + 103);
  undock(5, INTENT.RAT, T0 + 104);
  undock(6, INTENT.RAT, T0 + 105, false);
  return { near, counters, pilots };
}

function fakeNear(arrivals, activities) {
  return { ringSize: 16, activityRingSize: 16, eventsInto: () => Object.freeze(arrivals),
    activitiesInto: () => Object.freeze(activities) };
}

function liveRig(activityIntents) {
  const pilots = createPilotStore(8);
  pilots.put({ ...row(1, LIVE, STATE.DOCKED, INTENT.DOCK), prevId: F.sid(5) });
  pilots.put(row(2, LIVE, STATE.ACTIVE, INTENT.RAT));
  pilots.put({ ...row(3, LIVE, STATE.ACTIVE, INTENT.RAT), prevId: F.sid(5) });
  const counters = {};
  const near = fakeNear([{ pilotId: 1, systemId: LIVE, fromId: F.sid(5), at: T0 + 10, kind: "ARRIVE" },
    { pilotId: 3, systemId: LIVE, fromId: F.sid(5), at: T0 + 11, kind: "ARRIVE" }],
  [{ pilotId: 2, systemId: LIVE, at: T0 + 12, intent: INTENT.RAT, kind: "ACTIVITY" },
    { pilotId: 3, systemId: LIVE, at: T0 + 13, intent: INTENT.RAT, kind: "ACTIVITY" }]);
  const S = F.settings({ near: { enabled: true }, live: { trafficEnabled: true } });
  const live = createLiveOwnership({ S, pilots, queue: { remove() {}, schedule() {} }, near, step() {}, commit() {},
    bump: (n) => { counters[n] = (counters[n] || 0) + 1; }, keyOf: (id) => id, maxOwned: 8,
    ...(activityIntents ? { activityIntents } : {}) });
  return { live, counters };
}

module.exports = ({ test, skip }) => {
  test("PAE1 near: an activity event only on dock to RAT in a NEAR / LIVE system, own ring, ARRIVE untouched", () => {
    const { near, counters, pilots } = nearRig([INTENT.RAT]);
    const acts = near.activitiesInto(LIVE, 0, 10);
    assert.deepStrictEqual(acts.map((e) => [e.pilotId, e.at, e.intent, e.kind]),
      [[1, T0 + 100, INTENT.RAT, "ACTIVITY"]], "EXPLORE, jump, ACTIVE to ACTIVE, FAR, no fromIntent = none");
    assert.deepStrictEqual(near.arrivalsInto(LIVE, 0).map((a) => [a.pilotId, a.fromId]), [[3, F.sid(5)]]);
    assert.deepStrictEqual([counters["near.activityEvents"], counters["near.activitySkipped"]], [1, 1]);
    assert.deepStrictEqual(near.activitiesInto(F.sid(12), 0, 10), []);
    const arrivalsBefore = near.arrivalsInto(LIVE, 0);
    for (let k = 0; k < 40; k += 1) {
      pilots.apply(1, { state: STATE.DOCKED, intent: INTENT.DOCK });
      pilots.apply(1, { state: STATE.ACTIVE, intent: INTENT.RAT });
      near.afterCommit(1, LIVE, false, T0 + 200 + k, STATE.DOCKED, INTENT.DOCK);
    }
    assert.strictEqual(near.status().activities, 16, "bounded by activityRingSize");
    assert.deepStrictEqual(near.activitiesInto(LIVE, 0, 10).map((e) => [e.pilotId, e.at]), [[1, T0 + 239]]);
    assert.deepStrictEqual(near.arrivalsInto(LIVE, 0), arrivalsBefore);
    assert.deepStrictEqual(near.eventsInto(LIVE, 0, 10).map((e) => e.kind), ["ARRIVE"]);

    const off = nearRig(null);
    assert.deepStrictEqual(off.near.activitiesInto(LIVE, 0, 10), []);
    assert.deepStrictEqual([off.near.status().activities, off.near.activityRingSize], [0, 0]);
    assert.strictEqual(off.counters["near.activityEvents"], undefined);
    assert.ok(near.approxBytes() > off.near.approxBytes());
  });

  test("PAE2 live: ACTIVITY and ARRIVE of an active ratter become RATTER candidates after the arrivals, one per pilot",
    () => {
      const on = new Set([INTENT.RAT, INTENT.EXPLORE]);
      const p = { pilotId: 2, systemId: LIVE, prevId: F.sid(5), shipTypeId: 648, state: STATE.ACTIVE,
        intent: INTENT.RAT };
      const ev = { kind: "ACTIVITY", at: 5, intent: INTENT.RAT };
      const c = candidateOf(p, ev, null, LIVE, on).candidate;
      assert.deepStrictEqual([c.role, c.exit, c.fromSystemId, c.toSystemId, c.kind], ["RATTER", "NONE", 0, 0,
        "ACTIVITY"]);
      assert.strictEqual(candidateOf({ ...p, intent: INTENT.EXPLORE }, ev, null, LIVE, on).reason, "LOCAL_ONLY");
      assert.strictEqual(candidateOf(p, ev, null, LIVE).reason, "LOCAL_ONLY");
      const arrive = candidateOf(p, { kind: "ARRIVE", at: 5 }, null, LIVE, on).candidate;
      assert.deepStrictEqual([arrive.role, arrive.exit, arrive.fromSystemId], ["RATTER", "NONE", F.sid(5)]);
      assert.strictEqual(candidateOf(p, { kind: "ARRIVE", at: 5 }, null, LIVE, new Set()).reason, "LOCAL_ONLY");
      assert.strictEqual(candidateOf({ ...p, intent: INTENT.EXPLORE }, { kind: "ARRIVE", at: 5 }, null, LIVE, on)
        .candidate.role, "EXPLORER");
      assert.deepStrictEqual(activityIntentCodes(["EXPLORE", "RAT", "MINE", "bogus", 4, "RAT"]),
        [INTENT.RAT, INTENT.EXPLORE]);
      assert.deepStrictEqual(activityIntentCodes(undefined), []);

      const one = liveRig(new Set([INTENT.RAT]));
      assert.deepStrictEqual(one.live.candidatesIn(LIVE, 0, 1).map((x) => [x.pilotId, x.kind]), [[1, "ARRIVE"]]);
      assert.strictEqual(one.counters["live.activityCandidates"], undefined);
      const all = one.live.candidatesIn(LIVE, 0, 5);
      assert.deepStrictEqual(all.map((x) => [x.pilotId, x.kind, x.role]), [[1, "ARRIVE", "HAULER"],
        [3, "ARRIVE", "RATTER"], [2, "ACTIVITY", "RATTER"]]);
      assert.strictEqual(one.counters["live.activityCandidates"], 1);
      const none = liveRig(null);
      assert.deepStrictEqual(none.live.candidatesIn(LIVE, 0, 5).map((x) => x.pilotId), [1]);
    });

  test("PAE3 trafficActivityIntentsOf: RAT / EXPLORE only with highsecLife, traffic and civilian hulls on", () => {
    const cfg = (h, t) => ({ highsecLife: { enabled: true, civilianHullsEnabled: true, ...h,
      traffic: { enabled: true, ratterEnabled: true, explorerEnabled: true, ...t } } });
    assert.deepStrictEqual(trafficActivityIntentsOf(cfg()), ["RAT", "EXPLORE"]);
    assert.deepStrictEqual(trafficActivityIntentsOf(cfg({}, { explorerEnabled: false })), ["RAT"]);
    assert.deepStrictEqual(trafficActivityIntentsOf(cfg({}, { ratterEnabled: false })), ["EXPLORE"]);
    assert.deepStrictEqual(trafficActivityIntentsOf(cfg({}, { ratterEnabled: false, explorerEnabled: false })), []);
    assert.deepStrictEqual(trafficActivityIntentsOf(cfg({ civilianHullsEnabled: false })), []);
    assert.deepStrictEqual(trafficActivityIntentsOf(cfg({ enabled: false })), []);
    assert.deepStrictEqual(trafficActivityIntentsOf(cfg({}, { enabled: false })), []);
    for (const bad of [null, undefined, 7, "x", {}, { highsecLife: null }, { highsecLife: { enabled: true } },
      { highsecLife: { enabled: true, civilianHullsEnabled: true, traffic: "on" } }]) {
      assert.deepStrictEqual(trafficActivityIntentsOf(bad), []);
    }
  });

  const composeFile = findCompose();
  test("PAE5 config: activityRingSize default and clamp, role flags off, no-effect warning, compose lines", () => {
    const env = (e) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...e } });
    const base = env({}).config;
    assert.strictEqual(base.population.near.activityRingSize, 128);
    assert.deepStrictEqual([base.highsecLife.traffic.ratterEnabled, base.highsecLife.traffic.explorerEnabled],
      [false, false]);
    assert.deepStrictEqual(trafficActivityIntentsOf(base), []);
    assert.strictEqual(env({ EVEJS_LNE_POPULATION_NEAR_ACTIVITY_RING_SIZE: "5" }).config.population.near
      .activityRingSize, 16);
    assert.strictEqual(env({ EVEJS_LNE_POPULATION_NEAR_ACTIVITY_RING_SIZE: "99999" }).config.population.near
      .activityRingSize, 10000);
    const warned = env({ EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_ENABLED: "1", EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_RATTER_ENABLED: "1" })
      .warnings;
    assert.ok(warned.includes("highsecLife.traffic.ratterEnabled without highsecLife.civilianHullsEnabled - no effect"),
      warned.join(" | "));
    if (!composeFile) return;
    const { env: composeEnv } = readCompose(composeFile);
    for (const name of ["EVEJS_LNE_POPULATION_NEAR_ACTIVITY_RING_SIZE", "EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_RATTER_ENABLED",
      "EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_EXPLORER_ENABLED"]) {
      assert.strictEqual(composeEnv[name], "", name);
    }
  });
  if (!composeFile) skip("PAE5 compose lines", "compose.yaml not found above the mod (Docker image)");
};
