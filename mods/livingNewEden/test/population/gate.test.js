"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createPopulationService } = require("../../lib/population/service");
const { createPilotStore } = require("../../lib/population/store");
const { MEMORY_ESTIMATE } = require("../../lib/population/schema");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { findCompose } = require("../config/composeKeys.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const DAY = 86400000;
const N = 50;

function fakeStore() {
  const tx = { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 1 }) }) };
  return { limits: { maxRowsPerTransaction: 500 }, transaction: (_name, fn) => ({ ok: true, value: fn(tx) }),
    labelTx() {} };
}

function fakeTelemetry(withProbe = true) {
  const calls = [];
  const probes = [];
  const t = {
    calls, probes,
    observe: (name, v) => calls.push(["observe", name, v]),
    count: (name, v) => calls.push(["count", name, v]),
    gauge: (name, v) => calls.push(["gauge", name, v]),
  };
  if (withProbe) {
    t.registerMemoryProbe = (name, fn) => {
      const p = { name, fn, unregistered: 0 };
      probes.push(p);
      return { ok: true, unregister() {
        p.unregistered += 1;
      } };
    };
  }
  return t;
}

async function boot(settings, telemetry, perf) {
  const clock = { t: T0, now() { return this.t; } };
  const graph = F.fakeGraph();
  const svc = createPopulationService({ store: fakeStore(), worldSeed: 5, clock, settings, telemetry,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), listStations: F.listStations,
    buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => perf.t });
  assert.strictEqual(await svc.boot(), "running");
  return { svc, clock };
}

const observed = (tel) => tel.calls.filter((c) => c[0] === "observe" && c[1] !== "population.routeMs").map((c) => c[1]);

module.exports = ({ test }) => {
  test("PG4 gateWarmupMs window (0 = calls of before), memory probe population.memory, key coverage", async () => {
    const base = { enabled: true, size: N, maxEventsPerPass: 5000, maxPassMs: 50 };
    const runs = [];
    for (const S of [F.settings({ ...base, gateWarmupMs: 0 }), (() => {
      const { gateWarmupMs: _drop, ...rest } = F.settings(base);
      return Object.freeze(rest);
    })()]) {
      const tel = fakeTelemetry();
      const perf = { t: 0 };
      const { svc, clock } = await boot(S, tel, perf);
      for (let i = 1; i <= 2; i += 1) {
        clock.t += DAY;
        perf.t += 5000;
        svc.runPass(clock.t);
      }
      runs.push(tel.calls);
    }
    assert.deepStrictEqual(runs[0], runs[1]);
    const names0 = runs[0].filter((c) => c[0] === "observe").map((c) => c[1]);
    assert.ok(names0.includes("population.passMs") && names0.includes("population.flushMs"), names0.join(","));
    assert.ok(!names0.some((n) => n.includes("warmup")), names0.join(","));

    const tel = fakeTelemetry();
    const perf = { t: 0 };
    const { svc, clock } = await boot(F.settings({ ...base, gateWarmupMs: 1000 }), tel, perf);
    clock.t += DAY;
    perf.t = 500;
    svc.runPass(clock.t);
    assert.deepStrictEqual(observed(tel), ["population.warmupPassMs", "population.warmupFlushMs"]);
    tel.calls.length = 0;
    clock.t += DAY;
    perf.t = 1000;
    svc.runPass(clock.t);
    assert.deepStrictEqual(observed(tel), ["population.passMs", "population.flushMs"]);

    assert.strictEqual(tel.probes.length, 1);
    assert.strictEqual(tel.probes[0].name, "population.memory");
    const m = tel.probes[0].fn();
    const st = svc.getStatus();
    assert.strictEqual(m.entries, N + st.queue);
    assert.ok(Number.isFinite(m.approxBytes) && m.approxBytes > 0, JSON.stringify(m));
    svc.stop();
    assert.strictEqual(tel.probes[0].unregistered, 1);
    svc.stop();
    assert.strictEqual(tel.probes[0].unregistered, 1);

    const bare = fakeTelemetry(false);
    const b = await boot(F.settings(base), bare, { t: 0 });
    b.clock.t += DAY;
    assert.strictEqual(b.svc.runPass(b.clock.t).ok, true);
    b.svc.stop();

    const store = createPilotStore(10);
    store.put({ pilotId: 1, systemId: 1, prevId: 0, destId: 0, homeId: 1, shipTypeId: 1, archetype: 1, intent: 1,
      state: 1, seq: 0, sinceAt: 0, dueAt: 0, flags: 0 });
    const a0 = store.approxBytes();
    store.setRoute(1, { route: Int32Array.from([1, 2, 3]), at: 0 });
    const a1 = store.approxBytes();
    assert.strictEqual(a1 - a0, MEMORY_ESTIMATE.MAP_ENTRY_BYTES + 3 * MEMORY_ESTIMATE.ROUTE_HOP_BYTES);
    store.setRoute(1, { route: Int32Array.from([1, 2, 3, 4, 5]), at: 0 });
    assert.strictEqual(store.approxBytes() - a0, MEMORY_ESTIMATE.MAP_ENTRY_BYTES + 5 * MEMORY_ESTIMATE.ROUTE_HOP_BYTES);
    store.setRoute(1, null);
    assert.strictEqual(store.approxBytes(), a0);

    const env = "EVEJS_LNE_POPULATION_GATE_WARMUP_MS";
    const composeFile = findCompose();
    if (composeFile) assert.ok(fs.readFileSync(composeFile, "utf8").includes(`${env}: \${${env}:-}`));
    assert.ok(fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8").includes(`# ${env}=`));
    const rootEnv = path.resolve(MOD_DIR, "..", "..", ".env.example");
    if (fs.existsSync(rootEnv)) assert.ok(fs.readFileSync(rootEnv, "utf8").includes(`# ${env}=`));
  });
};
