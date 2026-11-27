"use strict";

const assert = require("node:assert");
const path = require("node:path");

const S = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const { estimateProgress } = require("../../lib/world/occupation/progress");
const { createHostility } = require("../../lib/battle/data/hostility");
const { createHive } = require("../../lib/strategy/hive");
const { resolveConfig } = require("../../config");

const H = 3600000;
const STEP = 900000;
const HIVE = 500025;
const ATT = 500003;
const isHostile = createHostility();
const C = resolveConfig({ modDir: path.resolve(__dirname, "..", ".."), env: { EVEJS_DATA_ROOT: "x" } }).config;
const PARAMS = Object.freeze({ ...C.occupation, maxFactionsPerSystem: C.world.maxFactionsPerSystem });

function claimView(controller, home, occupier, factor) {
  return { systemId: 30001052, state: S.CONTESTED, controller, occupier, previousController: null, sinceAt: 0,
    seq: 1, evaluatedAt: null, capturedAt: null, detachedSinceAt: null, home, coreOwner: null,
    influence: new Map([[controller, { score: 60, garrison: 0 }]]),
    presence: new Map([[occupier, { strength: 100, fleets: [] }]]), stations: new Map(),
    inRange: (f) => f === occupier, isHostile, presenceTruncated: false, deferred: false, at: 0, rangeKnown: true,
    consolidates: () => true, drawsGarrison: () => true, captureSlowFactor: factor };
}

function run(view, stop, untilAt = 24 * H) {
  const states = [];
  for (let at = STEP; at <= untilAt; at += STEP) {
    view.at = at;
    const ev = M.evaluate(view, { kind: M.TRIGGERS.TICK }, PARAMS);
    for (const e of ev.influence) view.influence.set(e.factionId, { score: e.influenceScore, garrison: e.garrisonStrength });
    view.evaluatedAt = at;
    if (ev.to) {
      view.state = ev.to;
      view.sinceAt = at;
      states.push([ev.to, at]);
      if (ev.to === stop) return { at, view, states };
    }
  }
  return { at: null, view, states };
}

module.exports = ({ test }) => {
  test("HVC1: capturePaced - hive home OCCUPIED after ~6 h at factor 3, ~2 h at factor "
    + "1; a retake keeps the pace; estimateProgress = evaluate for INVASION; captureSlowFactorOf of the facade", () => {
    assert.deepStrictEqual([PARAMS.holdPointsPerHour, PARAMS.decayPointsPerHour, PARAMS.invasionHoldMs], [30, 15, H]);
    assert.strictEqual(isHostile(ATT, HIVE), true, "Amarr and the hive are hostile");

    const slow = run(claimView(HIVE, HIVE, ATT, 3), S.OCCUPIED);
    const fast = run(claimView(HIVE, HIVE, ATT, 1), S.OCCUPIED);
    assert.deepStrictEqual(fast.states, [[S.INVASION, H], [S.OCCUPIED, 2 * H]], JSON.stringify(fast.states));
    assert.deepStrictEqual(slow.states, [[S.INVASION, 3 * H], [S.OCCUPIED, 6 * H]], JSON.stringify(slow.states));
    const retake = run(claimView(ATT, HIVE, HIVE, 1), S.OCCUPIED);
    assert.strictEqual(retake.at, 2 * H, JSON.stringify(retake.states));
    assert.strictEqual(M.capturePaced({ captureSlowFactor: 1, state: S.CONTESTED }, PARAMS), PARAMS);
    assert.strictEqual(M.capturePaced({}, PARAMS), PARAMS);
    const paced = M.capturePaced({ captureSlowFactor: 3, state: S.CONTESTED }, PARAMS);
    assert.deepStrictEqual([paced.holdPointsPerHour, paced.decayPointsPerHour, paced.invasionHoldMs,
      paced.stationPointsPerHour, paced.battleWinPoints], [10, 5, 3 * H, PARAMS.stationPointsPerHour,
      PARAMS.battleWinPoints]);

    const v = claimView(HIVE, HIVE, ATT, 3);
    const half = run(v, S.INVASION);
    assert.strictEqual(half.at, 3 * H);
    v.at = 4 * H;
    const ev4 = M.evaluate(v, { kind: M.TRIGGERS.TICK }, PARAMS);
    for (const e of ev4.influence) v.influence.set(e.factionId, { score: e.influenceScore, garrison: e.garrisonStrength });
    v.evaluatedAt = 4 * H;
    const p = estimateProgress(v, PARAMS);
    assert.strictEqual(ev4.to, null);
    assert.strictEqual(p.status, "ADVANCING", JSON.stringify(p));
    assert.strictEqual(p.next, S.OCCUPIED);
    assert.strictEqual(p.etaMs, 2 * H, JSON.stringify(p));
    const atEta = { ...v, at: 4 * H + p.etaMs };
    assert.strictEqual(M.evaluate(atEta, { kind: M.TRIGGERS.TICK }, PARAMS).to, S.OCCUPIED);
    assert.strictEqual(M.evaluate({ ...v, at: 4 * H + p.etaMs - STEP }, { kind: M.TRIGGERS.TICK }, PARAMS).to, null);
    const quick = estimateProgress({ ...v, captureSlowFactor: 1 }, PARAMS);
    assert.ok(quick.etaMs < p.etaMs, JSON.stringify(quick));

    const registry = { listActiveFactions: () => [{ factionId: HIVE, doctrineId: "rogue-hive-v1" }],
      getDoctrine: () => ({ hive: true }) };
    const on = createHive({ registry, settings: { ...C.hive, enabled: true, captureSlowFactor: 3 } });
    assert.deepStrictEqual([on.captureSlowFactorOf(HIVE, HIVE), on.captureSlowFactorOf(ATT, HIVE),
      on.captureSlowFactorOf(HIVE, null), on.captureSlowFactorOf(ATT, ATT)], [3, 1, 1, 1]);
    const off = createHive({ registry, settings: { ...C.hive, enabled: false } });
    assert.strictEqual(off.captureSlowFactorOf(HIVE, HIVE), 1);
  });

  test("HVC2: the factor slows only the claim states; a home retaken by the hive at "
    + "k = 7 and k = 20 goes OCCUPIED -> CONSOLIDATING -> STABLE on the same timeline as at k = 1", () => {
    const registry = { listActiveFactions: () => [{ factionId: HIVE, doctrineId: "rogue-hive-v1" }],
      getDoctrine: () => ({ hive: true }) };
    const facade = (k) => createHive({ registry, settings: { ...C.hive, enabled: true, captureSlowFactor: k } });
    const retake = (k) => {
      const hive = facade(k);
      const v = claimView(ATT, HIVE, HIVE, 1);
      const states = [];
      let reclaimed = null;
      for (let at = STEP; at <= 48 * H; at += STEP) {
        v.at = at;
        v.captureSlowFactor = hive.captureSlowFactorOf(v.controller, v.home);
        const ev = M.evaluate(v, { kind: M.TRIGGERS.TICK }, PARAMS);
        for (const e of ev.influence) v.influence.set(e.factionId, { score: e.influenceScore, garrison: e.garrisonStrength });
        v.evaluatedAt = at;
        if (!ev.to) continue;
        const p = ev.statePatch;
        Object.assign(v, { state: ev.to, sinceAt: at, controller: p.controllerFactionId, occupier: p.occupierFactionId,
          previousController: p.previousControllerFactionId, capturedAt: p.capturedAt,
          detachedSinceAt: p.detachedSinceAt });
        v.inRange = (f) => f === HIVE;
        states.push([ev.to, at]);
        if (ev.notes.includes("HOME_RECLAIMED")) reclaimed = { at, capturedAt: p.capturedAt, k: v.captureSlowFactor };
        if (ev.to === S.STABLE) break;
      }
      return { states, reclaimed, factorHeld: hive.captureSlowFactorOf(HIVE, HIVE) };
    };
    const slow = retake(7);
    const normal = retake(1);
    assert.deepStrictEqual(retake(20).states, normal.states, "k = 20");
    assert.deepStrictEqual(slow.reclaimed, { at: 2 * H, capturedAt: null, k: 1 }, JSON.stringify(slow.states));
    assert.strictEqual(slow.factorHeld, 7);
    assert.deepStrictEqual(slow.states.map(([s]) => s), [S.INVASION, S.OCCUPIED, S.CONSOLIDATING, S.STABLE],
      JSON.stringify(slow.states));
    assert.deepStrictEqual(slow.states, normal.states);
    for (const state of [S.OCCUPIED, S.CONSOLIDATING, S.STABLE]) {
      assert.strictEqual(M.capturePaced({ captureSlowFactor: 7, state }, PARAMS), PARAMS, state);
    }
    assert.strictEqual(M.capturePaced({ captureSlowFactor: 7, state: S.RECON }, PARAMS).invasionHoldMs, 7 * H);
  });
};
