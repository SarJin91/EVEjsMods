"use strict";

const assert = require("node:assert");

const { loadDriver } = require("../notices/storeHelper");
const { createPopulationService } = require("../../lib/population/service");
const { createNearLayer } = require("../../lib/population/near");
const { createPilotStore } = require("../../lib/population/store");
const { candidateOf } = require("../../lib/population/live");
const { STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { ARCHETYPES } = require("../../lib/population/data/archetypes");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const F = require("./fixture");

const SEED = 77;
const T0 = 1700000000000;
const N = 300;
const LIVE = F.sid(5);
const SYS = F.sid(6);
const STEP_MS = 10000;
const MAX_STEPS = 2000;

function presenceOf(graph, live) {
  return {
    getVersion: () => 1,
    observedSystems: () => [...live],
    observedWithin(radius) {
      const map = new Map(live.map((id) => [id, 0]));
      let frontier = [...live];
      for (let d = 1; d <= radius; d += 1) {
        const next = [];
        for (const id of frontier) {
          for (const n of graph.getNeighbors(id) || []) {
            if (map.has(n)) continue;
            map.set(n, d);
            next.push(n);
          }
        }
        frontier = next;
      }
      return { ok: true, systems: [...map] };
    },
  };
}

async function liveService(store, live = {}) {
  const graph = F.fakeGraph();
  const clock = { t: T0, now() { return this.t; } };
  const svc = createPopulationService({ store, worldSeed: SEED, clock,
    settings: F.settings({ enabled: true, size: N, seedRowsPerSlice: 100, flushRowsPerSlice: 400,
      maxEventsPerPass: 5000, maxPassMs: 50, maxRoutesPerPass: 100, near: { enabled: true, attractPermille: 0 },
      live: { trafficEnabled: true, ...live } }),
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), listStations: F.listStations,
    buildHubDistance, getPresence: () => presenceOf(graph, [LIVE]), yieldTurn: () => Promise.resolve(),
    nowMs: () => 0, liveMaxOwned: 12 });
  assert.strictEqual(await svc.boot(), "running");
  return svc;
}

function runUntil(svc, pick) {
  for (let k = 0; k < MAX_STEPS; k += 1) {
    const now = T0 + k * STEP_MS;
    svc.runPass(now);
    const c = svc.liveCandidatesIn(LIVE, now - 60000, 10).find(pick);
    if (c) return { candidate: c, now };
  }
  throw new Error("no candidate");
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("PT2 population live ownership", `no sqlite driver: ${driver.detail || driver.reason}`);
    skip("PT3 population live outcomes", `no sqlite driver: ${driver.detail || driver.reason}`);
    skip("PT6 population live used ring entry", `no sqlite driver: ${driver.detail || driver.reason}`);
    return;
  }

  test("PT2 ownership: claim out of the queue, ALREADY_OWNED, second release no-op, ownMaxMs EXPIRED, restart = none",
    async () => {
      await F.withStore(driver, async (store, reopen) => {
        const svc = await liveService(store);
        svc.runPass(T0);
        const id = svc.listIn(SYS, 1)[0].pilotId;
        const before = svc.pilot(id);
        const c = svc.claimLive(id, SYS, T0);
        assert.strictEqual(c.ok, true, JSON.stringify(c));
        assert.deepStrictEqual(svc.claimLive(id, SYS, T0), { ok: false, reason: "ALREADY_OWNED" });
        assert.deepStrictEqual(svc.claimLive(id, F.sid(1), T0).reason, "NOT_IN_SYSTEM");
        const late = Math.max(before.dueAt, T0) + 3600000;
        svc.runPass(late - 1);
        assert.strictEqual(svc.pilot(id).seq, before.seq, "owned = no transition");
        const st = svc.getStatus();
        assert.deepStrictEqual([st.counters["live.ownTimeout"], st.counters["live.EXPIRED"], st.liveOwned], [1, 1, 0]);
        assert.deepStrictEqual(svc.releaseLive(id, c.token, "DOCKED", late), { ok: true, applied: false },
          "an expired token");
        const c2 = svc.claimLive(id, SYS, late);
        assert.ok(c2.ok && c2.token > c.token);
        const r1 = svc.releaseLive(id, c2.token, "LEFT", late);
        assert.strictEqual(r1.applied, true);
        assert.deepStrictEqual(svc.releaseLive(id, c2.token, "LEFT", late), { ok: true, applied: false });
        assert.deepStrictEqual(svc.releaseLive(id, c2.token, "NOPE", late), { ok: false, reason: "BAD_OUTCOME" });
        const c3 = svc.claimLive(id, SYS, late);
        assert.ok(c3.ok);
        svc.stop();
        assert.deepStrictEqual(svc.releaseLive(id, c3.token, "LEFT", late), { ok: true, applied: false }, "stopped");
        const again = await liveService(reopen());
        assert.strictEqual(again.getStatus().liveOwned, 0);
        assert.deepStrictEqual(again.releaseLive(id, c3.token, "KILLED", late), { ok: true, applied: false });
        assert.strictEqual(again.pilot(id).state === "POD", false);
        const c4 = again.claimLive(id, again.pilot(id).systemId, late);
        assert.ok(c4.ok && c4.token > c3.token, "tokens grow in the process");
        again.stop();
        const off = await liveService(reopen(), { trafficEnabled: false });
        assert.deepStrictEqual(off.claimLive(id, SYS, late), { ok: false, reason: "LIVE_DISABLED" });
        assert.deepStrictEqual(off.liveCandidatesIn(LIVE, 0, 10), []);
        assert.strictEqual(off.getStatus().liveOwned, undefined);
        off.stop();
      });
    });

  test("PT3 outcomes: JUMPED = the hop into route[at+1]; KILLED -> POD -> home with another hull; requeue; DEPART",
    async () => {
      await F.withStore(driver, async (store) => {
        const svc = await liveService(store);
        const { candidate: cand, now } = runUntil(svc, (x) => x.exit === "GATE" && x.role === "HAULER");
        const p0 = svc.pilot(cand.pilotId);
        assert.deepStrictEqual([p0.state, p0.systemId, cand.fromSystemId], ["TRAVEL", LIVE, p0.prevId]);
        const c = svc.claimLive(cand.pilotId, LIVE, now);
        assert.ok(svc.liveCandidatesIn(LIVE, 0, 50).every((x) => x.pilotId !== cand.pilotId), "owned = no candidate");
        const r = svc.releaseLive(cand.pilotId, c.token, "JUMPED", now + 1000);
        assert.strictEqual(r.applied, true);
        const p1 = svc.pilot(cand.pilotId);
        assert.deepStrictEqual([p1.systemId, p1.prevId, p1.seq], [cand.toSystemId, LIVE, p0.seq + 1]);

        const victim = svc.listIn(SYS, 50).find((v) => v.state !== "POD");
        const k = svc.claimLive(victim.pilotId, SYS, now);
        const kr = svc.releaseLive(victim.pilotId, k.token, "KILLED", now);
        assert.deepStrictEqual([kr.applied, kr.state], [true, "POD"]);
        const pod = svc.pilot(victim.pilotId);
        assert.deepStrictEqual([pod.state, pod.dueAt], ["POD", now + 1800000]);
        assert.deepStrictEqual(svc.claimLive(victim.pilotId, SYS, now), { ok: false, reason: "POD" });
        svc.runPass(now + 1800000);
        const home = svc.pilot(victim.pilotId);
        assert.deepStrictEqual([home.state, home.intent, home.systemId], ["DOCKED", "RESHIP", victim.homeId]);
        assert.notStrictEqual(home.shipTypeId, victim.shipTypeId, "another hull");

        const t = now + 1800000;
        for (const outcome of ["DOCKED", "LEFT", "REFUSED"]) {
          const v = svc.listIn(SYS, 50).find((x) => x.state !== "POD");
          const before = svc.pilot(v.pilotId);
          const o = svc.claimLive(v.pilotId, SYS, t);
          assert.deepStrictEqual(svc.releaseLive(v.pilotId, o.token, outcome, t).applied, true);
          const after = svc.pilot(v.pilotId);
          assert.deepStrictEqual([after.state, after.systemId, after.seq, after.dueAt],
            [before.state, before.systemId, before.seq, Math.max(before.dueAt, t)], outcome);
        }
        const counters = svc.getStatus().counters;
        assert.deepStrictEqual(["JUMPED", "KILLED", "DOCKED", "LEFT", "REFUSED"].map((n) => counters[`live.${n}`]),
          [1, 1, 1, 1, 1]);
        svc.stop();
      });

      const S = F.settings({ near: { enabled: true, nearJumps: 1 } });
      const ring = (departures) => {
        const pilots = createPilotStore(2);
        pilots.put({ pilotId: 1, systemId: F.sid(6), prevId: 0, destId: 0, homeId: F.sid(6), shipTypeId: 648,
          archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.DOCKED, seq: 0, sinceAt: T0, dueAt: T0,
          flags: 0 });
        const graph = F.fakeGraph();
        const near = createNearLayer({ S, worldSeed: SEED, pilots, getPresence: () => presenceOf(graph, [F.sid(6)]),
          getGraph: () => graph, getTable: () => F.table(S, graph), bump: () => {}, departures });
        near.refresh();
        pilots.apply(1, { intent: INTENT.TRAVEL, state: STATE.TRAVEL, destId: F.sid(8) });
        near.afterCommit(1, F.sid(6), false, T0 + 5, STATE.DOCKED);
        return near;
      };
      const on = ring(true);
      assert.deepStrictEqual(on.eventsInto(F.sid(6), 0, 10).map((e) => [e.pilotId, e.kind, e.fromId]),
        [[1, "DEPART", 0]]);
      assert.deepStrictEqual(on.arrivalsInto(F.sid(6), 0, 10), []);
      assert.deepStrictEqual(ring(false).eventsInto(F.sid(6), 0, 10), []);
      const p = { pilotId: 1, systemId: F.sid(6), prevId: 0, shipTypeId: 648, state: STATE.TRAVEL, intent: INTENT.TRAVEL };
      const rs = { route: [F.sid(6), F.sid(7), F.sid(8)], at: 0 };
      const dep = candidateOf(p, { kind: "DEPART", at: 5 }, rs, F.sid(6));
      assert.deepStrictEqual([dep.candidate.role, dep.candidate.exit, dep.candidate.toSystemId], ["UNDOCK", "GATE",
        F.sid(7)]);
      assert.strictEqual(candidateOf(p, { kind: "DEPART", at: 5 }, null, F.sid(6)).reason, "NO_ROUTE");
      const mine = candidateOf({ ...p, state: STATE.ACTIVE, intent: INTENT.MINE, prevId: F.sid(5) },
        { kind: "ARRIVE", at: 5 }, null, F.sid(6));
      assert.deepStrictEqual([mine.candidate.role, mine.candidate.exit, mine.candidate.fromSystemId],
        ["MINER", "NONE", F.sid(5)]);
      assert.strictEqual(candidateOf({ ...p, state: STATE.ACTIVE, intent: INTENT.RAT }, { kind: "ARRIVE", at: 5 }, null,
        F.sid(6)).reason, "LOCAL_ONLY");
      assert.ok(ARCHETYPES[ARCHETYPE.TRADER].hulls.length > 1);
    });

  test("PT6 a used ring entry: DOCKED within maxEventAgeMs = no second ship of the pilot; REFUSED = tried again",
    async () => {
      await F.withStore(driver, async (store) => {
        const svc = await liveService(store);
        let list = [];
        let now = T0;
        for (let k = 0; k < MAX_STEPS && list.length < 2; k += 1) {
          now = T0 + k * STEP_MS;
          svc.runPass(now);
          list = svc.liveCandidatesIn(LIVE, now - 60000, 10);
        }
        assert.ok(list.length >= 2, "two candidates");
        const [a, b] = list;
        const ca = svc.claimLive(a.pilotId, LIVE, now);
        const cb = svc.claimLive(b.pilotId, LIVE, now);
        assert.ok(ca.ok && cb.ok);
        assert.strictEqual(svc.releaseLive(a.pilotId, ca.token, "DOCKED", now + 1000).applied, true);
        assert.strictEqual(svc.releaseLive(b.pilotId, cb.token, "REFUSED", now + 1000).applied, true);
        const later = now + 15000;
        const again = svc.liveCandidatesIn(LIVE, later - 60000, 10).map((x) => x.pilotId);
        assert.ok(!again.includes(a.pilotId), "DOCKED: the used entry gives no second ship");
        assert.ok(again.includes(b.pilotId), "REFUSED: the entry is tried again");
        svc.stop();
      });
    });
};
