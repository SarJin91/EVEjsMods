"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { createRng, deriveSeed } = require("../../lib/util/rng");
const rules = require("../../lib/population/rules");
const { settingsOf, STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { ARCHETYPES } = require("../../lib/population/data/archetypes");
const { createPopulationService } = require("../../lib/population/service");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { findCompose } = require("../config/composeKeys.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 4242;
const NOW = 1700000000000;
const HOUR = 3600000;
const KEYS = ["ENABLED", "DOCK_DWELL_PERMILLE", "DOCK_DWELL_FLOOR_MS", "DOCK_WEIGHT_PERMILLE", "TARGET_DOCKED_PERMILLE"]
  .map((k) => `EVEJS_LNE_POPULATION_ACTIVE_LIFE_${k}`);

function countingRng(seed) {
  const r = createRng(seed);
  const rng = { draws: 0, nextFloat() {
    rng.draws += 1;
    return r.nextFloat();
  } };
  return rng;
}

function settingsWithoutSection(overrides) {
  const { activeLife: _drop, ...population } = F.populationConfig(overrides);
  return settingsOf({ population });
}

const STAY_CONTEXT = Object.freeze({ hourPermille: () => 0, dangerOf: () => 0, attractList: () => [],
  hasBelts: () => true, attracts: () => false });

function walk(S, T, graph, pilots) {
  const route = (from, to) => graph.findRoute(from, to, { maxJumps: S.maxTripJumps });
  const trace = [];
  for (const row of pilots) {
    let p = { ...row };
    let rs = null;
    let now = NOW;
    for (let i = 0; i < 50; i += 1) {
      const rng = countingRng(deriveSeed(SEED, "pop", p.pilotId, p.seq));
      let next;
      if (i % 13 === 12 && p.state !== STATE.TRAVEL) next = rules.killed(p, S, now).next;
      else if (p.state === STATE.POD) next = rules.podRespawn(p, S, rng, now).next;
      else if (p.state === STATE.TRAVEL) {
        if (!rs) next = rules.dwellInPlace(p, T, S, rng, now).next;
        else {
          const h = rules.hop(p, rs, now, S, rng, T);
          rs = h.arrived ? null : { route: rs.route, at: h.at };
          next = h.next;
        }
      } else {
        const r = rules.rollIntent(p, T, S, rng, route, now);
        if (r.ok) {
          rs = r.route ? { route: r.route, at: 0 } : null;
          next = r.next;
        } else {
          rs = null;
          next = rules.dwellInPlace(p, T, S, rng, now).next;
        }
      }
      trace.push([p.pilotId, i, rng.draws, JSON.stringify(next)]);
      p = { ...p, ...next, seq: p.seq + 1, sinceAt: now };
      now = Math.max(now + 1, p.dueAt);
    }
  }
  return trace;
}

function fakeStore() {
  const tx = { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 1 }) }) };
  return { limits: { maxRowsPerTransaction: 500 }, transaction: (_name, fn) => ({ ok: true, value: fn(tx) }),
    labelTx() {} };
}

async function dockedShare(S, hours, skipHours, worldSeed = 9) {
  const clock = { t: NOW, now() { return this.t; } };
  const graph = F.fakeGraph();
  const svc = createPopulationService({ store: fakeStore(), worldSeed, clock, settings: S,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), listStations: F.listStations,
    buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0 });
  assert.strictEqual(await svc.boot(), "running");
  let sum = 0;
  let samples = 0;
  const end = NOW + hours * HOUR;
  while (clock.t < end) {
    clock.t += 60000;
    svc.runPass(clock.t);
    if (clock.t - NOW < skipHours * HOUR) continue;
    const st = svc.getStatus();
    sum += st.byState.DOCKED / st.size;
    samples += 1;
  }
  const status = svc.getStatus();
  svc.stop();
  return { share: sum / samples, status };
}

module.exports = ({ test }) => {
  const S_NONE = settingsWithoutSection();
  const T = F.table(S_NONE);

  test("AL1 activeLife off = the transitions (next + rng draws) of a config without the section", () => {
    const S_OFF = F.settings({ activeLife: { enabled: false } });
    assert.strictEqual(S_OFF.activeLife.enabled, false);
    assert.strictEqual(S_NONE.activeLife.enabled, false);
    assert.ok(!("weightsByArchetype" in S_OFF.activeLife));
    const pilots = [];
    for (let id = 1; id <= 300; id += 1) {
      const r = rules.seedPilot(id, SEED, T, S_NONE, NOW);
      assert.ok(r.ok);
      pilots.push(r.row);
    }
    const graph = F.fakeGraph();
    const a = walk(S_NONE, T, graph, pilots);
    const b = walk(S_OFF, T, graph, pilots);
    assert.strictEqual(a.length, 300 * 50);
    assert.deepStrictEqual(b, a);
    assert.strictEqual(rules.dockedDwell(S_OFF, 1234567), 1234567);
    const arch = ARCHETYPES[ARCHETYPE.TRADER];
    assert.strictEqual(rules.weightsOf(arch, { archetype: ARCHETYPE.TRADER }, S_OFF), arch.weights);
  });

  test("AL2 activeLife on: every DOCKED producer dwells dockedDwell(base), ACTIVE / TRAVEL unchanged", () => {
    const ctx = { context: { enabled: true, hourWeightPermille: 1000 } };
    const OFF = F.settings(ctx);
    const ON = F.settings({ ...ctx, activeLife: { enabled: true, dockWeightPermille: 1000 } });
    const L = ON.activeLife;
    assert.strictEqual(rules.dockedDwell(ON, 4000000), 1000000);
    assert.strictEqual(rules.dockedDwell(ON, 600000), L.dockDwellFloorMs);
    const graph = F.fakeGraph();
    const route = (from, to) => graph.findRoute(from, to, { maxJumps: OFF.maxTripJumps });
    const seen = new Set();
    const check = (off, on, label) => {
      assert.deepStrictEqual({ ...on, dueAt: 0 }, { ...off, dueAt: 0 }, label);
      if (off.state === STATE.DOCKED) {
        assert.strictEqual(on.dueAt - NOW, rules.dockedDwell(ON, off.dueAt - NOW), label);
        seen.add(`DOCKED:${off.intent}`);
      } else {
        assert.strictEqual(on.dueAt, off.dueAt, label);
        seen.add(`${off.state === STATE.ACTIVE ? "ACTIVE" : "TRAVEL"}`);
      }
    };
    const rng = (id, seq) => createRng(deriveSeed(SEED, "pop", id, seq));
    for (const archetype of [ARCHETYPE.TRADER, ARCHETYPE.MINER, ARCHETYPE.RATTER]) {
      for (let seq = 0; seq < 60; seq += 1) {
        const p = { pilotId: 7, systemId: F.sid(1), prevId: 0, destId: 0, homeId: F.sid(1), shipTypeId: 0, archetype,
          intent: INTENT.DOCK, state: STATE.ACTIVE, seq, sinceAt: NOW, dueAt: NOW, flags: 0 };
        const a = rules.rollIntent(p, T, OFF, rng(7, seq), route, NOW);
        const b = rules.rollIntent(p, T, ON, rng(7, seq), route, NOW);
        assert.strictEqual(a.ok, b.ok);
        if (a.ok) check(a.next, b.next, `rollIntent ${archetype}/${seq}`);
        const d = { ...p, state: STATE.DOCKED };
        const notes = [];
        const opts = { context: STAY_CONTEXT, note: (n) => notes.push(n) };
        check(rules.rollIntent(d, T, OFF, rng(7, seq), route, NOW, opts).next,
          rules.rollIntent(d, T, ON, rng(7, seq), route, NOW, opts).next, `stayedDocked ${seq}`);
        assert.ok(notes.includes("context.stayedDocked"));
      }
    }
    const pod = { pilotId: 3, systemId: F.sid(5), homeId: F.sid(1), shipTypeId: 648, archetype: ARCHETYPE.TRADER,
      state: STATE.POD, seq: 4 };
    check(rules.podRespawn(pod, OFF, rng(3, 4), NOW).next, rules.podRespawn(pod, ON, rng(3, 4), NOW).next, "POD");
    const trav = { pilotId: 4, systemId: F.sid(2), prevId: F.sid(1), destId: F.sid(3), homeId: F.sid(1),
      shipTypeId: 648, archetype: ARCHETYPE.TRADER, intent: INTENT.TRAVEL, state: STATE.TRAVEL, seq: 9,
      sinceAt: NOW - 3 * HOUR, dueAt: NOW, flags: 0 };
    const rs = { route: [F.sid(1), F.sid(2), F.sid(3)], at: 1 };
    check(rules.hop(trav, rs, NOW, OFF, rng(4, 9), T).next, rules.hop(trav, rs, NOW, ON, rng(4, 9), T).next, "hop");
    check(rules.fastForward(trav, rs, NOW, OFF, T).next, rules.fastForward(trav, rs, NOW, ON, T).next, "ff");
    const space = { ...trav, systemId: F.sid(4), destId: F.sid(5) };
    const rs2 = { route: [F.sid(4), F.sid(5)], at: 0 };
    check(rules.hop(space, rs2, NOW, OFF, rng(4, 9), T).next, rules.hop(space, rs2, NOW, ON, rng(4, 9), T).next,
      "hop space");
    const lost = { ...trav, systemId: 99, state: STATE.TRAVEL };
    check(rules.dwellInPlace(lost, T, OFF, rng(4, 9), NOW).next, rules.dwellInPlace(lost, T, ON, rng(4, 9), NOW).next,
      "unknown system");
    for (const k of [`DOCKED:${INTENT.DOCK}`, `DOCKED:${INTENT.RESHIP}`, "ACTIVE", "TRAVEL"]) {
      assert.ok(seen.has(k), `covered ${k}: ${[...seen].join(",")}`);
    }
    const D = F.settings({ activeLife: { enabled: true } });
    for (const [code, arch] of Object.entries(ARCHETYPES)) {
      const w = rules.weightsOf(arch, { archetype: Number(code) }, D);
      assert.deepStrictEqual(w, arch.weights.map((x, i) => (i === 0 ? Math.floor(x / 2) : x)), `archetype ${code}`);
      assert.ok(Object.isFrozen(w));
    }
  });

  test("AL3 NO_ROUTE in a station system: MINER in space, TRADER docked short; a hub out of reach is skipped", () => {
    const OFF = F.settings();
    const ON = F.settings({ activeLife: { enabled: true } });
    const rng = (seq) => createRng(deriveSeed(SEED, "pop", 11, seq));
    const notes = [];
    const opts = { note: (n) => notes.push(n) };
    const base = { pilotId: 11, systemId: F.sid(1), prevId: 0, destId: F.sid(9), homeId: F.sid(1), shipTypeId: 32880,
      intent: INTENT.TRAVEL, state: STATE.ACTIVE, seq: 2, sinceAt: NOW, dueAt: NOW, flags: 0 };
    const miner = { ...base, archetype: ARCHETYPE.MINER };
    assert.strictEqual(rules.dwellInPlace(miner, T, OFF, rng(2), NOW).next.state, STATE.DOCKED);
    const m = rules.dwellInPlace(miner, T, ON, rng(2), NOW, opts).next;
    assert.deepStrictEqual([m.state, m.intent], [STATE.ACTIVE, INTENT.MINE]);
    assert.ok(m.dueAt - NOW >= ON.dwellMinMs && m.dueAt - NOW <= ON.dwellMaxMs);
    assert.deepStrictEqual(notes, ["activeLife.noRouteInSpace"]);
    const trader = { ...base, archetype: ARCHETYPE.TRADER };
    const tOff = rules.dwellInPlace(trader, T, OFF, rng(2), NOW).next;
    const tOn = rules.dwellInPlace(trader, T, ON, rng(2), NOW, opts).next;
    assert.deepStrictEqual([tOn.state, tOn.intent], [STATE.DOCKED, INTENT.DOCK]);
    assert.strictEqual(tOn.dueAt - NOW, rules.dockedDwell(ON, tOff.dueAt - NOW));
    assert.ok(tOn.dueAt - NOW < tOff.dueAt - NOW);
    const commuter = { ...base, archetype: ARCHETYPE.COMMUTER, systemId: F.sid(11) };
    assert.strictEqual(rules.dwellInPlace(commuter, T, ON, rng(2), NOW, opts).next.state, STATE.DOCKED);
    assert.strictEqual(notes.length, 1);

    const hubCfg = { maxTripJumps: 8, hubPermille: 1000 };
    const S0 = F.settings(hubCfg);
    const S1 = F.settings({ ...hubCfg, activeLife: { enabled: true } });
    const T1 = F.table(S1);
    assert.strictEqual(T1.hubJumps[T1.indexOf.get(F.sid(12))], 9);
    const anyRoute = (from, to) => ({ ok: true, route: [from, to] });
    const far = { ...base, archetype: ARCHETYPE.TRADER, systemId: F.sid(12), homeId: F.sid(8) };
    const destsOff = new Set();
    const destsOn = new Set();
    const hubNotes = [];
    for (let seq = 0; seq < 60; seq += 1) {
      const p = { ...far, seq };
      const a = rules.rollIntent(p, T1, S0, rng(seq), anyRoute, NOW);
      if (a.ok && a.next.state === STATE.TRAVEL) destsOff.add(a.next.destId);
      const b = rules.rollIntent(p, T1, S1, rng(seq), anyRoute, NOW, { note: (n) => hubNotes.push(n) });
      if (b.ok && b.next.state === STATE.TRAVEL) destsOn.add(b.next.destId);
    }
    assert.ok(destsOff.has(F.HUB), `off picks the hub: ${[...destsOff]}`);
    assert.ok(!destsOn.has(F.HUB), `on never picks the hub: ${[...destsOn]}`);
    assert.ok(destsOn.has(F.sid(11)), `on picks the current region: ${[...destsOn]}`);
    assert.ok(hubNotes.length > 0 && hubNotes.every((n) => n === "activeLife.hubSkipped"), hubNotes.join(","));
  });

  test("AL4 simulation N = 300, 48 h, 3 world seeds: mean DOCKED ratio on/off <= 0.70 (fakeGraph)", async () => {
    const base = { enabled: true, size: 300, maxEventsPerPass: 5000, maxPassMs: 50, maxRoutesPerPass: 1000 };
    const SEEDS = [1, 5, 9];
    const ratios = [];
    let off = null;
    let on = null;
    for (const seed of SEEDS) {
      off = await dockedShare(F.settings(base), 48, 6, seed);
      on = await dockedShare(F.settings({ ...base, activeLife: { enabled: true } }), 48, 6, seed);
      ratios.push(on.share / off.share);
    }
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const msg = `DOCKED ratio per seed ${ratios.map((r) => r.toFixed(3)).join(",")} mean=${mean.toFixed(3)}`;
    assert.ok(ratios.every((r) => r < 1), msg);
    assert.ok(mean <= 0.70, msg);
    assert.strictEqual(off.status.activeLife.enabled, false);
    assert.strictEqual(on.status.activeLife.enabled, true);
    assert.strictEqual(on.status.activeLife.targetDockedPermille, 400);
    assert.strictEqual(on.status.activeLife.dockedPermille,
      Math.floor((on.status.byState.DOCKED * 1000) / on.status.size));
    assert.strictEqual(on.status.activeLife.dockedOverTarget, on.status.activeLife.dockedPermille > 400);
    assert.ok(on.status.counters["activeLife.noRouteInSpace"] >= 0);
    assert.strictEqual(off.status.counters["activeLife.noRouteInSpace"], 0);
    assert.strictEqual(off.status.counters["activeLife.hubSkipped"], 0);
  });

  test("AL5 config: defaults, ranges, W246, compose and both .env.example", () => {
    const env0 = { EVEJS_DATA_ROOT: os.tmpdir() };
    const def = resolveConfig({ modDir: MOD_DIR, env: env0 });
    assert.deepStrictEqual(def.config.population.activeLife, { enabled: false, dockDwellPermille: 250,
      dockDwellFloorMs: 300000, dockWeightPermille: 500, targetDockedPermille: 400 });
    assert.ok(!def.warnings.some((w) => /W246/.test(w)));
    const clamped = resolveConfig({ modDir: MOD_DIR, env: { ...env0, EVEJS_LNE_POPULATION_ACTIVE_LIFE_DOCK_DWELL_PERMILLE: "5",
      EVEJS_LNE_POPULATION_ACTIVE_LIFE_DOCK_WEIGHT_PERMILLE: "5000" } }).config.population.activeLife;
    assert.deepStrictEqual([clamped.dockDwellPermille, clamped.dockWeightPermille], [50, 1000]);
    const w = resolveConfig({ modDir: MOD_DIR, env: { ...env0, EVEJS_LNE_POPULATION_ACTIVE_LIFE_ENABLED: "1" } })
      .warnings;
    assert.ok(w.includes("population.activeLife.enabled without population.enabled - no effect (W246)"), w.join(" | "));
    const both = resolveConfig({ modDir: MOD_DIR, env: { ...env0, EVEJS_LNE_POPULATION_ENABLED: "1",
      EVEJS_LNE_POPULATION_ACTIVE_LIFE_ENABLED: "1" } });
    assert.ok(!both.warnings.some((x) => /W246/.test(x)));
    assert.strictEqual(settingsOf(both.config).activeLife.enabled, true);

    const modEnv = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    assert.deepStrictEqual(KEYS.filter((k) => !modEnv.includes(`# ${k}=`)), []);
    const composeFile = findCompose();
    if (!composeFile) return;
    const compose = fs.readFileSync(composeFile, "utf8");
    assert.ok(compose.includes(`${KEYS[0]}: \${${KEYS[0]}:-0}`));
    assert.deepStrictEqual(KEYS.slice(1).filter((k) => !compose.includes(`${k}: \${${k}:-}`)), []);
    const rootEnv = fs.readFileSync(path.join(path.dirname(composeFile), ".env.example"), "utf8");
    assert.deepStrictEqual(KEYS.filter((k) => !rootEnv.includes(`# ${k}=`)), []);
  });
};

module.exports.dockedShare = dockedShare;
