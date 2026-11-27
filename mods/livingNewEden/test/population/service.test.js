"use strict";

const assert = require("node:assert");

const { loadDriver } = require("../notices/storeHelper");
const { createPopulationService } = require("../../lib/population/service");
const { startPopulation } = require("../../lib/population");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const F = require("./fixture");

const SEED = 77;
const T0 = 1700000000000;
const N = 300;

function makeService(store, opts = {}) {
  const graph = opts.graph || F.fakeGraph();
  const clock = opts.clock || { t: T0, now() { return this.t; } };
  const svc = createPopulationService({ store, worldSeed: SEED, clock,
    settings: F.settings({ enabled: true, size: N, seedRowsPerSlice: 100, flushRowsPerSlice: 400,
      maxEventsPerPass: 5000, maxPassMs: 50, maxRoutesPerPass: 100, ...(opts.settings || {}) }),
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }),
    getGovernor: opts.governor ? () => opts.governor : undefined,
    listStations: F.listStations, buildHubDistance,
    yieldTurn: opts.yieldTurn || (() => Promise.resolve()),
    nowMs: opts.nowMs || (() => 0) });
  return { svc, clock };
}

async function booted(store, opts) {
  const m = makeService(store, opts);
  await m.svc.boot();
  return m;
}

const views = (svc) => Array.from({ length: N }, (_, i) => svc.pilot(i + 1));

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("PA3 population restart / seed", `no sqlite driver: ${driver.detail || driver.reason}`);
    skip("PA4 population budgets / governor", `no sqlite driver: ${driver.detail || driver.reason}`);
    return;
  }

  test("PA3 restart: an interrupted seed is finished with the same rows; flush + new service = same next step", async () => {
    let reference = null;
    await F.withStore(driver, async (store) => {
      const { svc } = await booted(store);
      assert.strictEqual(svc.getStatus().state, "running");
      assert.strictEqual(svc.getStatus().counters.seeded, N);
      reference = F.dbRows(store);
      assert.strictEqual(reference.length, N);
    });
    await F.withStore(driver, async (store) => {
      let a = null;
      a = makeService(store, { yieldTurn: (phase) => {
        if (phase === "seed") a.svc.stop();
        return Promise.resolve();
      } });
      await a.svc.boot();
      assert.strictEqual(F.dbRows(store).length, 100, "stopped after the first seed slice");
      const b = await booted(store);
      assert.strictEqual(b.svc.getStatus().state, "running");
      assert.strictEqual(b.svc.getStatus().counters.seeded, N - 100);
      assert.deepStrictEqual(F.dbRows(store), reference, "same rows as a seed without a break, no duplicate");
    });
    await F.withStore(driver, async (store, reopen) => {
      const opts = { settings: { flushIntervalMs: 5000, maxEventsPerPass: 50 } };
      const c = await booted(store, opts);
      const t1 = T0 + 6 * 3600000;
      let events = 0;
      for (let i = 0; i < 6; i += 1) events += c.svc.runPass(t1).events;
      assert.strictEqual(events, N);
      assert.strictEqual(c.svc.getStatus().counters.fastForward, N);
      c.clock.t = t1 + 5000;
      assert.strictEqual(c.svc.runPass(t1 + 5000).events, 0);
      assert.strictEqual(c.svc.getStatus().dirty, 0, "the flush wrote every dirty row");
      const before = views(c.svc);
      const d = await booted(store, { ...opts, clock: { t: t1 + 5000, now() { return this.t; } } });
      assert.deepStrictEqual(views(d.svc), before, "the restart restores the flushed state");
      const t2 = t1 + 300000;
      assert.strictEqual(c.svc.runPass(t2).events, 50);
      assert.strictEqual(d.svc.runPass(t2).events, 50);
      assert.deepStrictEqual(views(d.svc), views(c.svc), "the same seq gives the same next transition");
      c.svc.stop();
      const s2 = reopen();
      const e = await booted(s2, { ...opts, clock: { t: t2, now() { return this.t; } } });
      assert.deepStrictEqual(views(e.svc).map((v) => [v.seq, v.systemId, v.state]),
        views(c.svc).map((v) => [v.seq, v.systemId, v.state]), "stop() flushed the last dirty rows");
    });
  });

  test("PA5b start: flag on -> one armed timer after the boot, its fire runs a pass, stop() cancels it", async () => {
    await F.withStore(driver, async (store) => {
      const timers = [];
      const setTimer = (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return { cancel() { t.cancelled = true; }, hasRef: () => false };
      };
      const clock = { t: T0, now() { return this.t; } };
      const graph = F.fakeGraph();
      const started = startPopulation({ config: { population: F.populationConfig({ enabled: true, size: N,
        seedRowsPerSlice: 100 }) }, persistence: { ok: true, store, worldSeed: SEED }, clock, setTimer,
      getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), listStations: F.listStations,
      buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0 });
      assert.ok(started.ok, JSON.stringify(started));
      const pop = started.population;
      assert.strictEqual(await pop.whenReady(), "running");
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(timers.length, 1, "one timer armed after the boot");
      assert.strictEqual(timers[0].ms, 1000);
      clock.t = T0 + 6 * 3600000;
      timers[0].fn();
      assert.ok(pop.getStatus().lastPass.events > 0, JSON.stringify(pop.getStatus().lastPass));
      assert.strictEqual(timers.length, 2, "the pass re-arms the next timer");
      assert.strictEqual(timers[1].cancelled, false);
      pop.stop();
      assert.strictEqual(timers[1].cancelled, true, "stop() cancels the pending timer");
      assert.strictEqual(pop.getStatus().state, "stopped");
    });
  });

  test("PA4 budgets: events / time caps, governor, flush deferred then forced, only dirty rows, boot spread", async () => {
    await F.withStore(driver, async (store) => {
      const capped = await booted(store, { settings: { maxEventsPerPass: 10 } });
      assert.strictEqual(capped.svc.runPass(T0 + 6 * 3600000).events, 10);
      let ms = 0;
      const timed = await booted(store, { settings: { maxPassMs: 3 }, nowMs: () => (ms += 1) });
      const ev = timed.svc.runPass(T0 + 6 * 3600000).events;
      assert.ok(ev >= 1 && ev < 10, `events under maxPassMs: ${ev}`);
      const gov = { refuse: new Set(["OPERATIONAL"]), admits(c) { return !this.refuse.has(c); } };
      const g = await booted(store, { governor: gov });
      assert.strictEqual(g.svc.runPass(T0 + 6 * 3600000).events, 0);
      assert.strictEqual(g.svc.getStatus().counters["deferred.GOVERNOR"], 1);
    });
    await F.withStore(driver, async (store) => {
      const gov = { refuse: new Set(["MAINTENANCE"]), admits(c) { return !this.refuse.has(c); } };
      const f = await booted(store, { governor: gov, settings: { flushIntervalMs: 60000, flushMaxDeferMs: 3600000 } });
      const t1 = T0 + 30 * 60000;
      const moved = f.svc.runPass(t1).events;
      assert.ok(moved > 0 && moved < N, `some pilots moved: ${moved}`);
      assert.strictEqual(f.svc.getStatus().counters["deferred.FLUSH_GOVERNOR"], 1);
      assert.strictEqual(f.svc.getStatus().counters.flushForced, 0);
      assert.strictEqual(f.svc.getStatus().dirty, moved);
      assert.strictEqual(F.dbRows(store).filter((r) => r.seq > 0).length, 0, "nothing written while deferred");
      f.svc.runPass(T0 + 3600000);
      assert.strictEqual(f.svc.getStatus().counters.flushForced, 1, "forced at flushMaxDeferMs after the boot");
      const changed = views(f.svc).filter((v) => v.seq > 0).length;
      assert.ok(changed < N, `not every pilot changed: ${changed}`);
      assert.strictEqual(f.svc.getStatus().lastFlush.rows, changed, "only the dirty rows");
      assert.strictEqual(F.dbRows(store).filter((r) => r.seq > 0).length, changed);
      assert.strictEqual(f.svc.getStatus().dirty, 0);
      const late = T0 + 48 * 3600000;
      const s = await booted(store, { clock: { t: late, now() { return this.t; } } });
      for (const v of views(s.svc)) {
        assert.ok(v.dueAt >= late && v.dueAt <= late + 300000, `pilot ${v.pilotId} due ${v.dueAt - late}`);
      }
      assert.strictEqual(s.svc.getStatus().dirty, 0);
      const r = await booted(store, { clock: { t: late, now() { return this.t; } }, settings: { maxRoutesPerPass: 0 } });
      r.svc.runPass(late + 3600000);
      assert.ok(r.svc.getStatus().counters["deferred.ROUTE_BUDGET"] > 0);
      const waiting = views(r.svc).filter((v) => v.dueAt === late + 3600000 + 1000);
      assert.ok(waiting.length > 0 && waiting.every((v) => v.seq === F.dbRows(store)[v.pilotId - 1].seq));
    });
  });
};
