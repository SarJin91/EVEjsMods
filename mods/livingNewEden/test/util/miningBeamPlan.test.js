"use strict";

const assert = require("node:assert");

const { planBeams, applyBeams } = require("../../lib/util/miningBeamPlan");

const VIEW = 150000;
const REFRESH = 30000;
const pos = (x) => ({ x, y: 0, z: 0 });
const miner = (entityId, x, beltId) => ({ entityId, position: pos(x), beltId: beltId === undefined ? 40001 : beltId });
const player = (characterId, x, inWarp) => ({ characterId, position: pos(x), inWarp: inWarp === true });
const ok = (started) => ({ ok: true, started, stopped: 0, noRock: [], skipped: [], fxSent: started.length,
  budgetCut: 0 });

function plan(now, miners, players, state, suppress) {
  return planBeams({ now, miners, players, state, viewMeters: VIEW, refreshMs: REFRESH,
    ...(suppress ? { suppress: true } : {}) });
}

module.exports = ({ test }) => {
  test("MBP1 viewers in range, new viewer = full refresh, new miner = increment, no viewer or suppress = stop all, "
    + "refreshMs = full again, applyBeams keeps only started", () => {
    const far = plan(0, [miner(1, 0)], [player(9, VIEW + 1), player(8, 0, true)], null);
    assert.deepStrictEqual([far.start, far.stop, far.viewers.size], [[], [], 0], "out of range or in warp");

    const first = plan(1000, [miner(1, 0), miner(2, 10, null)], [player(9, VIEW)], null);
    assert.deepStrictEqual(first, { start: [{ entityId: 1, beltId: 40001 }, { entityId: 2, beltId: null }], stop: [],
      release: [], viewers: new Set([9]), full: true, nextAt: 1000 + REFRESH, now: 1000, retryMs: null,
      retryAt: -Infinity });
    let state = applyBeams(null, first, ok([{ entityId: 1, rockId: 501 }]));
    assert.deepStrictEqual([...state.shown], [[1, 501]], "only started");

    const inc = plan(2000, [miner(1, 0), miner(2, 10, null), miner(3, 20)], [player(9, 0)], state);
    assert.deepStrictEqual([inc.full, inc.start.map((s) => s.entityId), inc.stop], [false, [2, 3], []],
      "a new miner does not restart a shown beam");
    state = applyBeams(state, inc, ok([{ entityId: 2, rockId: 502 }, { entityId: 3, rockId: 503 }]));
    assert.deepStrictEqual([...state.shown], [[1, 501], [2, 502], [3, 503]]);

    const left = plan(2500, [miner(1, 0), miner(3, 20)], [player(9, 0)], state);
    assert.deepStrictEqual([left.full, left.start, left.stop], [false, [], [{ entityId: 2, rockId: 502 }]]);
    state = applyBeams(state, left, ok([]));
    assert.deepStrictEqual([...state.shown], [[1, 501], [3, 503]]);

    const joined = plan(3000, [miner(1, 0), miner(3, 20)], [player(9, 0), player(7, 5)], state);
    assert.deepStrictEqual([joined.full, joined.start.length, joined.stop.length, joined.nextAt],
      [true, 2, 2, 3000 + REFRESH], "a new viewer");
    state = applyBeams(state, joined, ok([{ entityId: 1, rockId: 501 }, { entityId: 3, rockId: 503 }]));

    const quiet = plan(3000 + REFRESH - 1, [miner(1, 0), miner(3, 20)], [player(9, 0), player(7, 5)], state);
    assert.deepStrictEqual([quiet.start, quiet.stop], [[], []]);
    const due = plan(3000 + REFRESH, [miner(1, 0), miner(3, 20)], [player(9, 0), player(7, 5)], state);
    assert.deepStrictEqual([due.full, due.start.length, due.stop.length], [true, 2, 2], "refreshMs");

    const gone = plan(4000, [miner(1, 0), miner(3, 20)], [], state);
    assert.deepStrictEqual([gone.start, gone.stop], [[], [{ entityId: 1, rockId: 501 }, { entityId: 3, rockId: 503 }]]);
    const held = plan(4000, [miner(1, 0), miner(3, 20)], [player(9, 0)], state, true);
    assert.deepStrictEqual([held.start, held.stop.length, held.viewers.size], [[], 2, 0], "suppress");
    const after = applyBeams(state, held, ok([]));
    assert.deepStrictEqual([after.shown.size, after.viewers.size], [0, 0]);

    const failed = applyBeams(state, due, { ok: false, reason: "FX_FAILED" });
    assert.deepStrictEqual([[...failed.shown], failed.viewers.size], [[...state.shown], 0],
      "a refusal keeps the beams and forgets the viewers");
  });

  test("MBP2 approach: an approaching miner waits for retryAt, a miner gone from MINING or suppress = release, "
    + "busy kept with rock 0, no retryMs = every unshown miner each pass", () => {
    const RETRY = 5000;
    const players = [player(9, 0)];
    const first = planBeams({ now: 1000, miners: [miner(1, 0), miner(2, 10)], players, state: null, viewMeters: VIEW,
      refreshMs: REFRESH, retryMs: RETRY });
    assert.deepStrictEqual([first.start.map((s) => s.entityId), first.release, first.retryAt], [[1, 2], [], 6000]);
    let state = applyBeams(null, first, { ...ok([]), approaching: [{ entityId: 1, rockId: 501 }], busy: [2] });
    assert.deepStrictEqual([[...state.approaching], state.retryAt], [[[1, 501], [2, 0]], 6000]);

    const early = planBeams({ now: 2000, miners: [miner(1, 0), miner(2, 10), miner(3, 20)], players, state,
      viewMeters: VIEW, refreshMs: REFRESH, retryMs: RETRY });
    assert.deepStrictEqual([early.full, early.start.map((s) => s.entityId), early.retryAt], [false, [3], 6000],
      "only the new miner before retryAt");
    state = applyBeams(state, early, ok([{ entityId: 3, rockId: 503 }]));
    assert.deepStrictEqual([[...state.approaching], state.retryAt], [[[1, 501], [2, 0]], 6000], "retryAt kept");

    const due = planBeams({ now: 6000, miners: [miner(1, 0), miner(3, 20)], players, state, viewMeters: VIEW,
      refreshMs: REFRESH, retryMs: RETRY });
    assert.deepStrictEqual([due.start.map((s) => s.entityId), due.release, due.retryAt], [[1], [2], 11000],
      "after retryAt the approaching miner comes back, the one gone is released");
    state = applyBeams(state, due, { ...ok([{ entityId: 1, rockId: 501 }]), released: [1] });
    assert.deepStrictEqual([[...state.shown].map(([id]) => id).sort(), state.approaching.size, state.retryAt],
      [[1, 3], 0, -Infinity]);

    const again = applyBeams(state, due, { ...ok([]), approaching: [{ entityId: 1, rockId: 501 }] });
    const held = planBeams({ now: 7000, miners: [miner(1, 0)], players, state: again, viewMeters: VIEW,
      refreshMs: REFRESH, retryMs: RETRY, suppress: true });
    assert.deepStrictEqual([held.start, held.release], [[], [1]], "suppress releases every approaching miner");
    assert.strictEqual(applyBeams(again, held, ok([])).approaching.size, 0);
    const kept = applyBeams(again, held, { ok: false, reason: "FX_FAILED" });
    assert.deepStrictEqual([[...kept.approaching], kept.retryAt], [[[1, 501]], again.retryAt], "a refusal keeps them");

    const legacy = planBeams({ now: 2000, miners: [miner(1, 0), miner(2, 10)], players,
      state: { ...state, approaching: new Map([[2, 0]]) }, viewMeters: VIEW, refreshMs: REFRESH });
    assert.deepStrictEqual(legacy.start.map((s) => s.entityId), [2], "no retryMs = every unshown miner");
  });
};
