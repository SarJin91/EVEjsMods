"use strict";

const assert = require("node:assert");

const { createRng, deriveSeed } = require("../../lib/util/rng");
const rules = require("../../lib/population/rules");
const { STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { ARCHETYPES } = require("../../lib/population/data/archetypes");
const { CIVILIAN_HULLS } = require("../../lib/adapter/data/civilianLiveProfiles");
const F = require("./fixture");

const SEED = 4242;
const NOW = 1700000000000;

module.exports = ({ test }) => {
  const S = F.settings();
  const T = F.table(S);

  test("PA1 rules: seedPilot deterministic, bands by bandPermille, hulls from the mod data, rollIntent by seq", () => {
    const a = rules.seedPilot(7, SEED, T, S, NOW);
    const b = rules.seedPilot(7, SEED, T, S, NOW);
    assert.ok(a.ok);
    assert.deepStrictEqual(a, b);
    assert.notDeepStrictEqual(rules.seedPilot(8, SEED, T, S, NOW).row, a.row);
    const band = { highsec: 0, lowsec: 0, nullsec: 0 };
    for (let id = 1; id <= 300; id += 1) {
      const r = rules.seedPilot(id, SEED, T, S, NOW);
      assert.ok(r.ok);
      const sys = T.sys(r.row.homeId);
      assert.ok(sys && sys.stations > 0, `home ${r.row.homeId} has a station`);
      assert.notStrictEqual(r.row.homeId, F.WH, "never a wormhole home");
      assert.strictEqual(r.row.state, STATE.DOCKED);
      assert.ok(r.row.dueAt >= NOW && r.row.dueAt < NOW + S.dwellMaxMs);
      band[sys.band] += 1;
    }
    assert.ok(Math.abs(band.highsec - 210) <= 35, JSON.stringify(band));
    assert.ok(Math.abs(band.lowsec - 45) <= 25, JSON.stringify(band));
    assert.ok(Math.abs(band.nullsec - 45) <= 25, JSON.stringify(band));
    const known = new Set(CIVILIAN_HULLS.map((h) => h.shipTypeId));
    for (const [code, arch] of Object.entries(ARCHETYPES)) {
      for (const h of arch.hulls) assert.ok(known.has(h), `archetype ${code} hull ${h} not in the mod data`);
      assert.strictEqual(arch.weights.reduce((s, w) => s + w, 0), 1000, `archetype ${code} weights`);
    }
    const graph = F.fakeGraph();
    const route = (from, to) => graph.findRoute(from, to, { maxJumps: S.maxTripJumps });
    const spent = () => ({ ok: false, reason: "ROUTE_BUDGET" });
    let budgetHits = 0;
    for (let seq = 0; seq < 40; seq += 1) {
      const p = { ...a.row, archetype: ARCHETYPE.TRADER, seq };
      const rngOf = () => createRng(deriveSeed(SEED, "pop", p.pilotId, seq));
      assert.deepStrictEqual(rules.rollIntent(p, T, S, rngOf(), route, NOW), rules.rollIntent(p, T, S, rngOf(), route, NOW));
      const r = rules.rollIntent(p, T, S, rngOf(), spent, NOW);
      if (!r.ok && r.reason === "ROUTE_BUDGET") budgetHits += 1;
    }
    assert.ok(budgetHits > 0, "a TRADER rolls TRAVEL within 40 seqs (700 permille)");
  });

  test("PA2 machine: hop by hop with prevId, DOCKED at a station / ACTIVE without, fastForward never past dest", () => {
    const graph = F.fakeGraph();
    const rng = createRng(1);
    const p0 = { pilotId: 1, systemId: F.sid(1), prevId: 0, destId: F.sid(6), homeId: F.sid(1), shipTypeId: 32880,
      archetype: ARCHETYPE.MINER, intent: INTENT.TRAVEL, state: STATE.TRAVEL, seq: 3, sinceAt: NOW, dueAt: NOW, flags: 0 };
    const rs = { route: Int32Array.from(graph.findRoute(F.sid(1), F.sid(6)).route), at: 0 };
    let p = { ...p0 };
    const seen = [];
    for (let i = 0; i < 10; i += 1) {
      const h = rules.hop(p, rs, NOW, S, rng, T);
      assert.strictEqual(h.next.prevId, p.systemId);
      rs.at = h.at;
      p = { ...p, ...h.next };
      seen.push(p.systemId);
      if (h.arrived) break;
    }
    assert.deepStrictEqual(seen, [2, 3, 4, 5, 6].map(F.sid));
    assert.strictEqual(p.state, STATE.DOCKED, "sid(6) has a station");
    const q0 = { ...p0, destId: F.sid(5) };
    const rs5 = { route: Int32Array.from(graph.findRoute(F.sid(4), F.sid(5)).route), at: 0 };
    const h5 = rules.hop({ ...q0, systemId: F.sid(4) }, rs5, NOW, S, rng, T);
    assert.ok(h5.arrived);
    assert.strictEqual(h5.next.state, STATE.ACTIVE);
    assert.strictEqual(h5.next.intent, INTENT.MINE);
    const rsF = { route: Int32Array.from(graph.findRoute(F.sid(1), F.sid(6)).route), at: 0 };
    const f3 = rules.fastForward({ ...p0, sinceAt: NOW - Math.floor(3.5 * S.hopMeanMs) }, rsF, NOW, S, T);
    assert.deepStrictEqual([f3.hops, f3.next.systemId, f3.next.prevId, f3.arrived], [3, F.sid(4), F.sid(3), false]);
    const fMax = rules.fastForward({ ...p0, sinceAt: NOW - 100 * S.hopMeanMs }, rsF, NOW, S, T);
    assert.deepStrictEqual([fMax.hops, fMax.next.systemId, fMax.arrived, fMax.next.state],
      [5, F.sid(6), true, STATE.DOCKED]);
    const fNo = rules.fastForward({ ...p0, sinceAt: NOW - 100 * S.hopMeanMs }, null, NOW, S, T);
    assert.strictEqual(fNo.next.systemId, F.sid(6));
  });
};
