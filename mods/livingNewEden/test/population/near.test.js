"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const config = require("../../config");
const { loadDriver } = require("../notices/storeHelper");
const { createPopulationService } = require("../../lib/population/service");
const { startPopulation } = require("../../lib/population");
const { createNearLayer, displayNameOf } = require("../../lib/population/near");
const { createPilotStore } = require("../../lib/population/store");
const VIEW = require("../../lib/population/view");
const { STATE, INTENT, ARCHETYPE, FLAG_NEAR } = require("../../lib/population/schema");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { createViewRegistry } = require("../../lib/observer/views");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 77;
const T0 = 1700000000000;
const N = 300;

const { fakePresence } = F;

function makeService(store, opts = {}) {
  const graph = opts.graph || F.fakeGraph();
  const clock = { t: T0, now() { return this.t; } };
  const svc = createPopulationService({ store, worldSeed: SEED, clock,
    settings: F.settings({ enabled: true, size: N, seedRowsPerSlice: 100, flushRowsPerSlice: 400,
      maxEventsPerPass: 5000, maxPassMs: 50, maxRoutesPerPass: 100, ...(opts.settings || {}) }),
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }),
    listStations: F.listStations, buildHubDistance, getPresence: opts.presence ? () => opts.presence : undefined,
    yieldTurn: () => Promise.resolve(), nowMs: () => 0 });
  return { svc, clock, graph };
}

const views = (svc) => Array.from({ length: N }, (_, i) => svc.pilot(i + 1));

function lineStore(perSystem) {
  const pilots = createPilotStore(12 * perSystem);
  let id = 0;
  for (let s = 1; s <= 12; s += 1) {
    for (let k = 0; k < perSystem; k += 1) {
      id += 1;
      pilots.put({ pilotId: id, systemId: F.sid(s), prevId: 0, destId: 0, homeId: F.sid(s), shipTypeId: 648,
        archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.DOCKED, seq: 0, sinceAt: T0,
        dueAt: T0 + 3600000, flags: 0 });
    }
  }
  return pilots;
}

function nearLayerOf(pilots, presence, nearOverrides) {
  const S = F.settings({ near: { enabled: true, ...nearOverrides } });
  const graph = F.fakeGraph();
  const counters = {};
  const near = createNearLayer({ S, worldSeed: SEED, pilots, getPresence: () => presence, getGraph: () => graph,
    getTable: () => F.table(S, graph), bump: (n, k = 1) => { counters[n] = (counters[n] || 0) + k; } });
  return { near, counters, S };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();

  test("PN2 tiers: rebuilt once per presence version; the pre-warm reads only the systems that entered", () => {
    const base = lineStore(3);
    const calls = { idsIn: [], get: 0 };
    const pilots = { ...base, idsIn(id) { calls.idsIn.push(id); return base.idsIn(id); },
      get(id) { calls.get += 1; return base.get(id); } };
    const presence = fakePresence(F.fakeGraph());
    const { near, counters } = nearLayerOf(pilots, presence, { nearJumps: 2, maxPrewarmPerPass: 5 });
    const changes = [];
    assert.strictEqual(near.onTierChange((c) => changes.push(c)).ok, true);
    presence.set([F.sid(3)]);
    assert.strictEqual(near.refresh(), true);
    for (let i = 0; i < 4; i += 1) assert.strictEqual(near.refresh(), false, "same version: no rebuild");
    assert.deepStrictEqual([presence.calls.within, presence.calls.observed], [1, 1]);
    assert.deepStrictEqual([F.sid(1), F.sid(3), F.sid(5), F.sid(6)].map((s) => near.tierOf(s)),
      ["NEAR", "LIVE", "NEAR", "FAR"]);
    assert.deepStrictEqual([...calls.idsIn].sort((a, b) => a - b), [1, 2, 3, 4, 5].map(F.sid),
      "only the 5 systems that entered NEAR / LIVE are read");
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].changes.length, 5);
    const done = [near.prewarmPass(T0), near.prewarmPass(T0), near.prewarmPass(T0), near.prewarmPass(T0)];
    assert.deepStrictEqual(done, [5, 5, 5, 0]);
    assert.strictEqual(counters["deferred.PREWARM_BUDGET"], 2);
    assert.strictEqual(counters.prewarmed, 15);
    assert.strictEqual(calls.get, 15);
    const warm = (lo, hi) => Array.from({ length: 36 }, (_, i) => i + 1)
      .filter((id) => (base.flagsOf(id) & FLAG_NEAR) !== 0).every((id) => id >= lo && id <= hi);
    assert.ok(warm(1, 15), "only the pilots of the systems 1..5");
    const v = near.viewOf(7, base.flagsOf(7));
    assert.deepStrictEqual(v, { substate: "DOCKED", name: displayNameOf(SEED, 7) });
    assert.ok(typeof v.name === "string" && v.name.length > 3);
    calls.idsIn.length = 0;
    presence.set([F.sid(9)]);
    assert.strictEqual(near.refresh(), true);
    assert.strictEqual(presence.calls.within, 2);
    assert.deepStrictEqual([...calls.idsIn].sort((a, b) => a - b), [1, 2, 3, 4, 5, 7, 8, 9, 10, 11].map(F.sid));
    assert.strictEqual(changes[1].changes.length, 10);
    for (let i = 0; i < 3; i += 1) near.prewarmPass(T0);
    assert.ok(warm(19, 33), "only the pilots of the systems 7..11");
    assert.strictEqual(near.status().near + near.status().live, 15);
  });

  test("PN3 arrivalsInto: jumps into a system in (at, pilotId) order, one entry per pilot, bounded by the ring", () => {
    const pilots = lineStore(1);
    const presence = fakePresence(F.fakeGraph());
    const { near } = nearLayerOf(pilots, presence, { nearJumps: 1, arrivalRingSize: 4 });
    presence.set([F.sid(6)]);
    near.refresh();
    const jump = (id, from, to, at) => {
      pilots.apply(id, { systemId: to, prevId: from });
      near.afterCommit(id, from, true, at);
    };
    jump(5, F.sid(5), F.sid(6), 100);
    jump(4, F.sid(4), F.sid(5), 60);
    jump(7, F.sid(7), F.sid(6), 100);
    jump(3, F.sid(3), F.sid(4), 70);
    const ids = (list) => list.map((a) => [a.pilotId, a.at, a.fromId]);
    assert.deepStrictEqual(ids(near.arrivalsInto(F.sid(6), 0)), [[5, 100, F.sid(5)], [7, 100, F.sid(7)]]);
    jump(8, F.sid(8), F.sid(7), 50);
    assert.deepStrictEqual(ids(near.arrivalsInto(F.sid(6), 0, 1)), [[5, 100, F.sid(5)]], "limit");
    jump(5, F.sid(6), F.sid(5), 150);
    jump(5, F.sid(5), F.sid(6), 200);
    assert.deepStrictEqual(ids(near.arrivalsInto(F.sid(6), 0)), [[7, 100, F.sid(7)], [5, 200, F.sid(5)]]);
    assert.deepStrictEqual(ids(near.arrivalsInto(F.sid(6), 100)), [[5, 200, F.sid(5)]], "after sinceMs only");
    jump(6, F.sid(6), F.sid(5), 210);
    jump(4, F.sid(5), F.sid(6), 220);
    jump(9, F.sid(9), F.sid(8), 230);
    assert.deepStrictEqual(ids(near.arrivalsInto(F.sid(6), 0)), [[5, 200, F.sid(5)], [4, 220, F.sid(5)]],
      "pilot 7 at 100 fell out of the ring");
    assert.deepStrictEqual(near.arrivalsInto(F.sid(1), 0), []);
  });

  if (!driver.ok) {
    skip("PN1 population near off", `no sqlite driver: ${driver.detail || driver.reason}`);
    skip("PN4 population near attraction", `no sqlite driver: ${driver.detail || driver.reason}`);
    skip("PN5 population observer views", `no sqlite driver: ${driver.detail || driver.reason}`);
    return;
  }

  test("PN1 near off: the same seed gives the state bit for bit; tierOf FAR, no arrival, no near status", async () => {
    const run = async (opts) => {
      let out = null;
      await F.withStore(driver, async (store) => {
        const m = makeService(store, opts);
        if (opts.presence) opts.presence.set(opts.live);
        await m.svc.boot();
        const t1 = T0 + 6 * 3600000;
        m.svc.runPass(t1);
        m.svc.runPass(t1 + 60000);
        m.svc.runPass(t1 + 300000);
        out = { svc: m.svc, views: views(m.svc) };
        m.svc.stop();
        out.rows = F.dbRows(store);
      });
      return out;
    };
    const sub1 = await run({});
    const graph = F.fakeGraph();
    const off = await run({ graph, presence: fakePresence(graph), live: [F.sid(6)] });
    const graph2 = F.fakeGraph();
    const emptyOn = await run({ graph: graph2, presence: fakePresence(graph2), live: [],
      settings: { near: { enabled: true } } });
    assert.ok(sub1.views.some((v) => v.seq > 1), "pilots moved");
    assert.deepStrictEqual(off.views, sub1.views, "near off with players =");
    assert.deepStrictEqual(off.rows, sub1.rows, "the flushed rows too");
    assert.deepStrictEqual(emptyOn.rows, sub1.rows, "near on without an observed system =");
    assert.strictEqual(off.svc.tierOf(F.sid(6)), "FAR");
    assert.deepStrictEqual(off.svc.arrivalsInto(F.sid(6), 0), []);
    assert.strictEqual(off.svc.onTierChange(() => {}).ok, false);
    assert.strictEqual(off.svc.getStatus().near, undefined);
    assert.strictEqual(off.svc.getStatus().counters.prewarmed, 0);
  });

  test("PN4 attraction: attractPermille 1000 -> a TRAVEL from a NEAR system goes to the LIVE system", async () => {
    await F.withStore(driver, async (store) => {
      const graph = F.fakeGraph();
      const presence = fakePresence(graph);
      presence.set([F.sid(6)]);
      const m = makeService(store, { graph, presence,
        settings: { maxRoutesPerPass: 1000, near: { enabled: true, attractPermille: 1000, nearJumps: 2 } } });
      await m.svc.boot();
      const nearSystems = new Set([4, 5, 7, 8].map(F.sid));
      const before = views(m.svc);
      m.svc.runPass(T0 + 6 * 3600000);
      const after = views(m.svc);
      const trips = after.filter((v, i) => nearSystems.has(before[i].systemId) && before[i].state !== "TRAVEL"
        && v.seq === before[i].seq + 1 && v.intent === "TRAVEL");
      assert.ok(trips.length >= 3, `trips from NEAR: ${trips.length}`);
      assert.deepStrictEqual([...new Set(trips.map((v) => v.destId))], [F.sid(6)], "every trip goes to LIVE");
      assert.ok(m.svc.getStatus().counters.attracted >= trips.length);
      assert.strictEqual(m.svc.tierOf(F.sid(6)), "LIVE");
      assert.strictEqual(m.svc.tierOf(F.sid(5)), "NEAR");
      const warm = after.filter((v) => v.near);
      assert.ok(warm.length > 0 && warm.every((v) => m.svc.tierOf(v.systemId) !== "FAR"));
      assert.ok(warm.every((v) => ["DOCKED", "UNDOCKING", "AT_GATE", "IN_SPACE"].includes(v.near.substate)));
    });
  });

  test("PN5 observer: layer-population marks order 8, panel population order 76, shapes; env switches them off", async () => {
    const env = { EVEJS_DATA_ROOT: os.tmpdir() };
    const on = config.resolveConfig({ env, modDir: MOD_DIR });
    assert.deepStrictEqual(on.errors, []);
    assert.deepStrictEqual([on.config.population.observer.panelEnabled, on.config.population.observer.layerEnabled],
      [true, true]);
    const off = config.resolveConfig({ env: { ...env, EVEJS_LNE_POPULATION_OBSERVER_PANEL_ENABLED: "0",
      EVEJS_LNE_POPULATION_OBSERVER_LAYER_ENABLED: "0" }, modDir: MOD_DIR });
    assert.deepStrictEqual([off.config.population.observer.panelEnabled, off.config.population.observer.layerEnabled],
      [false, false]);
    const start = (store, registry, observer) => {
      const graph = F.fakeGraph();
      const clock = { t: T0, now() { return this.t; } };
      return startPopulation({ config: { observer: { galaxyEnabled: true },
        population: F.populationConfig({ enabled: true, size: N, seedRowsPerSlice: 100, observer }) },
      persistence: { ok: true, store, worldSeed: SEED }, clock, views: registry,
      setTimer: () => ({ cancel() {}, hasRef: () => false }),
      getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), listStations: F.listStations,
      buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0 });
    };
    await F.withStore(driver, async (store) => {
      const none = createViewRegistry();
      const s0 = start(store, none, off.config.population.observer);
      assert.ok(s0.ok);
      assert.deepStrictEqual([none.getView(VIEW.VIEW_ID), none.getView(VIEW.LAYER_ID)], [null, null]);
      await s0.population.whenReady();
      s0.population.stop();
      const registry = createViewRegistry();
      const s = start(store, registry, { maxSystems: 3 });
      assert.ok(s.ok, JSON.stringify(s));
      assert.strictEqual(await s.population.whenReady(), "running");
      const layer = registry.getView(VIEW.LAYER_ID);
      assert.deepStrictEqual([layer.listed, layer.mapLayer, layer.cacheKey()],
        [false, { kind: "marks", order: 8 }, `p${Math.floor(T0 / 60000)}`]);
      const data = layer.getData();
      assert.strictEqual(data.available, true);
      assert.strictEqual(data.items.length, 3, "top maxSystems systems");
      const counts = F.dbRows(store).reduce((m, r) => m.set(r.system_id, (m.get(r.system_id) || 0) + 1), new Map());
      const top3 = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map((e) => e[0])
        .sort((a, b) => a - b);
      assert.deepStrictEqual(data.items.map((it) => it[0]), top3);
      for (const it of data.items) {
        assert.strictEqual(it.length, 5);
        assert.ok(VIEW.STYLE.includes(it[1]), it[1]);
        assert.strictEqual(it[2], String(s.population.countIn(it[0])));
        assert.ok(Array.isArray(it[3]) && it[3][0] === `pilots ${it[2]}`);
        assert.strictEqual(it[4], null);
      }
      const sandbox = { window: {} };
      vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
        { filename: "galaxy.js" });
      const pure = sandbox.window.LneGalaxy._pure;
      assert.deepStrictEqual(data.legend.map((l) => pure.markShape(l[3])), VIEW.STYLE.map(() => "ring"));
      const panel = registry.getView(VIEW.VIEW_ID);
      assert.deepStrictEqual([panel.listed, panel.order, panel.mapLayer], [true, 76, null]);
      const p = panel.getData();
      assert.deepStrictEqual([p.available, p.size, p.tiers, p.eventsPerSec, p.nearEnabled], [true, N, null, null, false]);
      assert.deepStrictEqual(Object.keys(p.byState), ["DOCKED", "ACTIVE", "TRAVEL", "POD"]);
      assert.ok(registry.listViews().some((v) => v.id === VIEW.VIEW_ID));
      s.population.stop();
      assert.deepStrictEqual([registry.getView(VIEW.VIEW_ID), registry.getView(VIEW.LAYER_ID)], [null, null],
        "stop() unregisters both");
    });
  });
};
