"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createRng, deriveSeed } = require("../../lib/util/rng");
const rules = require("../../lib/population/rules");
const { createWorldContext } = require("../../lib/population/worldContext");
const { createPopulationService } = require("../../lib/population/service");
const { STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { ARCHETYPES } = require("../../lib/population/data/archetypes");
const { buildHubDistance, hourPermilleAt } = require("../../lib/highsecLife/density");
const { populationContextSources } = require("../../lib/runtime/services");
const { loadDriver } = require("../notices/storeHelper");
const { mask } = require("../_support/sourceScan");
const F = require("./fixture");

const SEED = 4242;
const NOW = 1700000000000;
const N = 300;
const PIRATE = 500019;
const MOD_DIR = path.resolve(__dirname, "..", "..");

function fakeSources(o = {}) {
  const calls = { control: [], belts: [], battles: 0, events: 0, veins: 0, wrecks: 0 };
  const control = o.control || new Map();
  const src = {
    readControl(ids) {
      calls.control.push(ids.length);
      return { ok: true, systems: ids.filter((id) => control.has(id)).map((id) => ({ systemId: id,
        controllerFactionId: null, occupationState: "STABLE", occupierFactionId: null, ...control.get(id) })),
      missing: [] };
    },
    readOpenBattleSystems() {
      calls.battles += 1;
      return { ok: true, systemIds: o.battles || [], truncated: false };
    },
    readOpenEvents() {
      calls.events += 1;
      return { ok: true, events: o.events || [], truncated: false };
    },
    richVeinSystems() {
      calls.veins += 1;
      return new Set(o.veins || []);
    },
    readWreckSystems() {
      calls.wrecks += 1;
      return { ok: true, systemIds: o.wrecks || [], truncated: false };
    },
    readBelts(ids) {
      calls.belts.push(ids.length);
      return { ok: true, counts: new Map(ids.map((id) => [id, (o.noBelts || []).includes(id) ? 0 : 1])) };
    },
    pirateFactionIds: [PIRATE],
    hourCurvePermille: o.curve || new Array(24).fill(1000),
    hourPermilleAt,
    maxBatchReadIds: o.maxBatchReadIds,
  };
  for (const k of ["readControl", "readOpenBattleSystems", "readOpenEvents", "readWreckSystems", "readBelts"]) {
    if (typeof o[k] === "function") src[k] = o[k];
  }
  return { src, calls };
}

function built(S, T, o) {
  const { src, calls } = fakeSources(o);
  const counters = {};
  const wc = createWorldContext({ S, getTable: () => T, sources: src,
    bump: (n) => { counters[n] = (counters[n] || 0) + 1; } });
  let steps = 0;
  while (!wc.step(NOW).done && steps < 100) steps += 1;
  return { wc, view: wc.view(), calls, counters, steps: steps + 1 };
}

const rngOf = (id, seq) => createRng(deriveSeed(SEED, "pop", id, seq));

module.exports = ({ test }) => {
  const driver = loadDriver();
  const graph = F.fakeGraph();
  const route = (from, to) => graph.findRoute(from, to, { maxJumps: 12 });

  test("PX1 context off: rows and state = on the same seed, zero source calls; rules without opts.context", async () => {
    const S = F.settings();
    const T = F.table(S);
    for (let seq = 0; seq < 60; seq += 1) {
      const p = { ...rules.seedPilot(5, SEED, T, S, NOW).row, archetype: ARCHETYPE.MINER, state: STATE.ACTIVE, seq };
      assert.deepStrictEqual(rules.rollIntent(p, T, S, rngOf(5, seq), route, NOW, { note() {} }),
        rules.rollIntent(p, T, S, rngOf(5, seq), route, NOW));
    }
    if (!driver.ok) return;
    const run = async (withSources) => {
      const { src, calls } = fakeSources({ control: new Map([[F.sid(6), { controllerFactionId: PIRATE }]]) });
      let out = null;
      await F.withStore(driver, async (store) => {
        const clock = { t: NOW, now() { return this.t; } };
        const svc = createPopulationService({ store, worldSeed: 77, clock,
          settings: F.settings({ enabled: true, size: N, seedRowsPerSlice: 100, maxEventsPerPass: 5000, maxPassMs: 50,
            maxRoutesPerPass: 100 }),
          getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: F.fakeGraph() }) }),
          listStations: F.listStations, buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0,
          ...(withSources ? { contextSources: src } : {}) });
        await svc.boot();
        for (let i = 0; i < 8; i += 1) svc.runPass(NOW + i * 1800000);
        svc.stop();
        out = { rows: F.dbRows(store), status: svc.getStatus().byState, ctx: svc.getStatus().context };
      });
      return { out, calls };
    };
    const a = await run(true);
    const b = await run(false);
    assert.deepStrictEqual(a.out.rows, b.out.rows);
    assert.deepStrictEqual(a.out.status, b.out.status);
    assert.strictEqual(a.out.ctx, undefined, "no context status with the flag off");
    assert.deepStrictEqual([a.calls.control.length, a.calls.belts.length, a.calls.battles, a.calls.events,
      a.calls.wrecks], [0, 0, 0, 0, 0]);
  });

  test("PX2 danger: a pirate system is picked less often (N=300); danger 1000 x retreat 1000 -> DOCK", () => {
    const S = F.settings({ context: { enabled: true, dangerRetreatPermille: 1000 } });
    const T = F.table(S);
    const { view } = built(S, T, { control: new Map([[F.sid(6), { controllerFactionId: PIRATE }]]) });
    assert.strictEqual(view.dangerOf(F.sid(6)), 1000);
    assert.strictEqual(view.dangerOf(F.sid(1)), 0);
    const count = (opts) => {
      let hits = 0;
      for (let seq = 0; seq < N; seq += 1) {
        const p = { pilotId: 9, systemId: F.sid(1), prevId: 0, destId: 0, homeId: F.sid(1), shipTypeId: 1944,
          archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.ACTIVE, seq, sinceAt: NOW, dueAt: NOW, flags: 0 };
        const r = rules.rollIntent(p, T, S, rngOf(9, seq), route, NOW, opts);
        if (r.ok && r.next.destId === F.sid(6)) hits += 1;
      }
      return hits;
    };
    const plain = count(undefined);
    const avoided = count({ context: view });
    assert.ok(plain > 20 && avoided < plain * 0.6, `picks of the pirate system: ${plain} -> ${avoided}`);
    const notes = [];
    for (let seq = 0; seq < 30; seq += 1) {
      const p = { pilotId: 3, systemId: F.sid(6), prevId: 0, destId: 0, homeId: F.sid(1), shipTypeId: 16240,
        archetype: ARCHETYPE.RATTER, intent: INTENT.RAT, state: STATE.ACTIVE, seq, sinceAt: NOW, dueAt: NOW, flags: 0 };
      const r = rules.rollIntent(p, T, S, rngOf(3, seq), route, NOW, { context: view, note: (n) => notes.push(n) });
      assert.deepStrictEqual([r.ok, r.next.intent, r.next.state], [true, INTENT.DOCK, STATE.DOCKED]);
    }
    assert.strictEqual(notes.filter((n) => n === "context.retreats").length, 30);
  });

  test("PX3 refresh: slices, no store access, governor STRATEGIC, refused source keeps the weights, swap at SWAP",
    async () => {
      const S = F.settings({ contextSystemsPerSlice: 5, context: { enabled: true } });
      const T = F.table(S);
      const control = new Map([[F.sid(8), { occupationState: "INVASION" }], [F.sid(2), { occupierFactionId: PIRATE,
        occupationState: "OCCUPIED" }], [F.sid(4), { occupationState: "OCCUPIED", occupierFactionId: 500001 }]]);
      let refuse = false;
      const { src, calls } = fakeSources({ control, battles: [F.sid(11)], maxBatchReadIds: 3,
        readOpenBattleSystems: () => (refuse ? { ok: false, reason: "TX_FAILED" }
          : { ok: true, systemIds: [F.sid(11)], truncated: false }) });
      const readControl = src.readControl;
      src.readControl = (ids) => (refuse ? { ok: false, reason: "TX_ACTIVE" } : readControl(ids));
      const counters = {};
      const wc = createWorldContext({ S, getTable: () => T, sources: src,
        bump: (n) => { counters[n] = (counters[n] || 0) + 1; } });
      const v = wc.view();
      const phases = [];
      for (let i = 0; i < 40; i += 1) {
        const r = wc.step(NOW);
        phases.push(r.phase);
        if (r.done) break;
        assert.strictEqual(v.dangerOf(F.sid(8)), 0, "no half cycle before SWAP");
      }
      assert.strictEqual(T.size, 12);
      assert.deepStrictEqual(calls.belts, [5, 5, 2], "BELTS in slices of contextSystemsPerSlice");
      assert.deepStrictEqual(calls.control, [3, 3, 3, 3], "CONTROL capped at world.maxBatchReadIds (W201)");
      assert.deepStrictEqual([v.dangerOf(F.sid(8)), v.dangerOf(F.sid(2)), v.dangerOf(F.sid(4)), v.dangerOf(F.sid(11)),
        v.dangerOf(F.sid(1))], [700, 1000, 400, 1000, 0]);
      assert.strictEqual(phases[phases.length - 1], "IDLE");
      assert.strictEqual(counters.contextRefreshes, 1);
      assert.strictEqual(wc.pending(NOW + 1000), false, "next cycle after refreshMs");
      refuse = true;
      const t2 = NOW + S.context.refreshMs;
      while (!wc.step(t2).done) {}
      assert.deepStrictEqual([v.dangerOf(F.sid(8)), v.dangerOf(F.sid(11))], [700, 1000]);
      assert.strictEqual(counters["context.sourceFailed"], 5, "4 control slices + battles");
      assert.strictEqual(calls.belts.length, 3);
      assert.strictEqual(counters.contextRefreshes, 2);

      if (!driver.ok) return;
      await F.withStore(driver, async (store) => {
        let txs = 0;
        const spy = {};
        for (const k of Object.keys(store)) spy[k] = typeof store[k] === "function" ? store[k].bind(store) : store[k];
        spy.transaction = (...a) => {
          txs += 1;
          return store.transaction(...a);
        };
        const gov = { refuse: new Set(["STRATEGIC"]), admits(c) { return !this.refuse.has(c); } };
        const s2 = fakeSources({ control });
        const svc = createPopulationService({ store: spy, worldSeed: 77, clock: { now: () => NOW },
          settings: F.settings({ enabled: true, size: N, seedRowsPerSlice: 100, context: { enabled: true } }),
          getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: F.fakeGraph() }) }),
          getGovernor: () => gov, listStations: F.listStations, buildHubDistance, yieldTurn: () => Promise.resolve(),
          nowMs: () => 0, contextSources: s2.src });
        assert.strictEqual(await svc.boot(), "running", svc.getStatus().lastError);
        svc.runPass(NOW);
        assert.strictEqual(svc.getStatus().counters["deferred.CONTEXT_GOVERNOR"], 1, JSON.stringify(svc.getStatus()));
        assert.deepStrictEqual([s2.calls.belts.length, svc.getStatus().context.phase], [0, "IDLE"], "no progress");
        gov.refuse.clear();
        txs = 0;
        for (let i = 0; i < 6; i += 1) svc.runPass(NOW);
        assert.strictEqual(svc.getStatus().counters.contextRefreshes, 1);
        assert.strictEqual(txs, 0, "the context refresh never touches the store");
        assert.strictEqual(svc.getStatus().context.dangerSystems, 3);
        svc.stop();
      });
    });

  test("PX4 attraction (veins -> MINER, pirate_* -> RATTER), UTC hour, hull tier by seq, hourPermilleAt", () => {
    const S = F.settings({ context: { enabled: true, attractPermille: 1000, hourWeightPermille: 1000 } });
    const T = F.table(S);
    const { view } = built(S, T, { veins: [F.sid(5)], events: [{ systemId: F.sid(4), eventType: "pirate_den" }],
      noBelts: [F.sid(2)] });
    assert.deepStrictEqual([view.attracts(F.sid(5), 2), view.attracts(F.sid(4), 0), view.hasBelts(F.sid(2))],
      [true, true, false]);
    const dests = (archetype, hull) => {
      const out = [];
      for (let seq = 0; seq < N; seq += 1) {
        const p = { pilotId: 11, systemId: F.sid(1), prevId: 0, destId: 0, homeId: F.sid(1), shipTypeId: hull,
          archetype, intent: INTENT.DOCK, state: STATE.ACTIVE, seq, sinceAt: NOW, dueAt: NOW, flags: 0 };
        const r = rules.rollIntent(p, T, S, rngOf(11, seq), route, NOW, { context: view });
        if (r.ok && r.next.intent === INTENT.TRAVEL) out.push(r.next.destId);
      }
      return out;
    };
    const miner = dests(ARCHETYPE.MINER, 32880);
    assert.ok(miner.length > 10 && miner.every((d) => d === F.sid(5)), JSON.stringify(miner.slice(0, 10)));
    const ratter = dests(ARCHETYPE.RATTER, 16240);
    assert.ok(ratter.length > 10 && ratter.every((d) => d === F.sid(4)), JSON.stringify(ratter.slice(0, 10)));
    const departures = (curve) => {
      const v = built(S, T, { curve: new Array(24).fill(curve) }).view;
      let n = 0;
      for (let seq = 0; seq < N; seq += 1) {
        const p = { pilotId: 12, systemId: F.sid(1), prevId: 0, destId: 0, homeId: F.sid(1), shipTypeId: 1944,
          archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.DOCKED, seq, sinceAt: NOW, dueAt: NOW, flags: 0 };
        const r = rules.rollIntent(p, T, S, rngOf(12, seq), route, NOW, { context: v });
        if (r.ok && r.next.state !== STATE.DOCKED) n += 1;
      }
      return n;
    };
    const night = departures(400);
    const day = departures(1000);
    assert.ok(night < day * 0.6, `departures ${night} at 400 vs ${day} at 1000`);
    const hulls = ARCHETYPES[ARCHETYPE.TRADER].hulls;
    const reships = (current, seqFrom) => {
      const got = new Set();
      for (let k = 0; k < N; k += 1) {
        const seq = seqFrom + (k % 150);
        const p = { pilotId: 100 + k, systemId: F.sid(1), prevId: 0, destId: 0, homeId: F.sid(1), shipTypeId: current,
          archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.ACTIVE, seq, sinceAt: NOW, dueAt: NOW,
          flags: 0 };
        const r = rules.rollIntent(p, T, S, rngOf(100 + k, seq), route, NOW, { context: view });
        if (r.ok && r.next.intent === INTENT.RESHIP) got.add(r.next.shipTypeId);
      }
      return [...got].sort((a, b) => a - b);
    };
    assert.deepStrictEqual(reships(hulls[3], 0), [hulls[0]]);
    assert.deepStrictEqual(reships(hulls[0], 0), [hulls[0]], "no other hull in tier 0 -> the current one");
    const high = reships(hulls[0], 200 * hulls.length);
    assert.ok(high.length >= 4 && !high.includes(hulls[0]) && high.every((h) => hulls.includes(h)), JSON.stringify(high));
    const curve = Array.from({ length: 24 }, (_, h) => 100 + h * 50);
    for (let h = 0; h < 24; h += 1) {
      const at = Date.UTC(2026, 10, 20, h, 30);
      assert.strictEqual(hourPermilleAt(curve, at), curve[new Date(at).getUTCHours()]);
    }
    assert.strictEqual(hourPermilleAt(curve, Number.NaN), curve[0]);
    assert.strictEqual(hourPermilleAt([-5], 0), 0);
  });

  test("PX5: lib/population writes only its tables, imports no domain module; services.js sources read only "
    + "10 context keys", () => {
    const offenders = [];
    const dir = path.join(MOD_DIR, "lib", "population");
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith(".js")) files.push(path.join(d, e.name));
      }
    };
    walk(dir);
    for (const file of files) {
      const name = path.relative(dir, file).split(path.sep).join("/");
      const code = mask(fs.readFileSync(file, "utf8"), { strings: false });
      if (/\bapplyChange\b/.test(code)) offenders.push(`${name}: applyChange`);
      if (!/^(corps\/)?repository\.js$/.test(name) && /\b(INSERT|UPDATE)\b/.test(code)) {
        offenders.push(`${name}: SQL write`);
      }
      for (const m of code.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        if (/^\.\.\/(\.\.\/)*(world|battle|events|strategy)(\/|$)/.test(m[1])) offenders.push(`${name}: ${m[1]}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
    const labels = [];
    const store = { transaction(label, fn) {
      labels.push(label);
      return { ok: true, value: fn({ tx: true }) };
    } };
    const ctx = { persistence: { ok: true, store }, config: { highsecLife: { hourCurvePermille: new Array(24).fill(500)
      .join(",") }, world: { maxBatchReadIds: 1000 } },
    battle: { repository: { summarizeOpen: (tx, o) => ({ ok: true, battles: [{ systemId: 7, limit: o.limit }],
      truncated: false }) } },
    wrecks: { repository: { listActive: () => ({ ok: true, fields: [{ systemId: 8, pool: 3 }, { systemId: 9, pool: 0 }],
      truncated: false }) }, effectivePool: (f) => ({ total: f.pool }) },
    events: { listOpenEvents: () => ({ ok: true, events: [{ systemId: 4, eventType: "ded_complex", x: 1 }],
      truncated: false }), richVeinSystems: () => new Set([5]) } };
    const s = populationContextSources(ctx);
    assert.deepStrictEqual(s.readOpenBattleSystems(10), { ok: true, systemIds: [7], truncated: false });
    assert.deepStrictEqual(s.readWreckSystems(NOW, 10), { ok: true, systemIds: [8], truncated: false });
    assert.deepStrictEqual(s.readOpenEvents(10).events, [{ systemId: 4, eventType: "ded_complex" }]);
    assert.deepStrictEqual(labels, ["population.context.battles", "population.context.wrecks"]);
    assert.strictEqual(s.readControl([1]).reason, "WORLD_UNAVAILABLE");
    assert.strictEqual(s.readBelts([1]).reason, "ADAPTER_UNAVAILABLE");
    assert.strictEqual(s.pirateFactionIds.length, 5);
    assert.strictEqual(s.hourPermilleAt(s.hourCurvePermille, NOW), 500);
    assert.strictEqual(s.maxBatchReadIds, 1000);
    const keys = config.SCHEMA.filter((row) => row.key.startsWith("population.context.")).map((row) => row.key);
    assert.strictEqual(keys.length, 10, keys.join(","));
  });
};
