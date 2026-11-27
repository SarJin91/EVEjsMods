"use strict";

const assert = require("node:assert");
const R = require("../../tools/measure/battleAiReport");
const { ATTACK_LOSS_OPERATION_TYPES } = require("../../lib/strategy/schema");

const H = 3600000;

function segment(index, from, counters, decideP95, extra = {}) {
  return { index, startVirtualAt: from, stopVirtualAt: from + 15 * H,
    report: { startVirtualAt: from, stopVirtualAt: from + 15 * H, checks: { runs: 1, pass: 1, fail: 0, error: 0 } },
    telemetry: { channels: { battle: counters.battle || {},
      strategy: { ...(counters.strategy || {}), decideMs: { samples: 10, p95: decideP95 } } } },
    status: [{ scheduler: { passP95Ms: 4, latenessP95Ms: 1000 } }, { scheduler: { passP95Ms: 6, latenessP95Ms: 3000 } }],
    logErrors: 0, logRowLimit: 0, logAttackLossFailed: 0, exitCode: 0, ...extra };
}

function summary(patch = {}) {
  const counters = {};
  for (const n of R.COUNTER_NAMES) counters[n] = 0;
  return { ok: true, windowMs: 60 * H, segments: 4, exitOk: true, checks: { runs: 4, pass: 4, fail: 0, error: 0 },
    battles: 100, raidBattles: 60, raidBWin: 30, shipsLost: 400, raidShipsLostA: 200, captures: 20, lostPosts: 10,
    recaptures: { total: 3, home: 2, other: 1 }, grinders: 4, repeatLosses: 30,
    piecemeal: { base: 40, cases: 20, share: 0.5, firstBWinPiecemeal: 10, firstBWinWhole: 5 },
    histogramsP95Max: { "strategy.decideMs": 3, "strategy.reviewReadMs": 2 }, passP95MsMedian: 5,
    latenessP95MsMedian: 2000, logErrors: 0, logRowLimit: 0, logAttackLossFailed: 0,
    ...patch, counters: { ...counters, "strategy.review.launches": 100, ...(patch.counters || {}) } };
}

const ON = Object.freeze({
  asm: { "battle.contacts.assemblyDeferred": 5 },
  mem: { "battle.contacts.assemblyDeferred": 5, "strategy.attackLoss.recorded": 8, "strategy.attackLoss.blocked": 4 },
  dec: { "battle.contacts.assemblyDeferred": 5, "strategy.attackLoss.recorded": 8, "strategy.attackLoss.blocked": 4,
    "battle.contacts.declined": 6, "battle.contacts.declineFleetsRetreated": 10, "battle.contacts.declineStuck": 1 },
  isk: { "battle.contacts.assemblyDeferred": 5, "strategy.attackLoss.recorded": 8, "strategy.attackLoss.blocked": 4,
    "battle.contacts.declined": 6, "battle.contacts.declineFleetsRetreated": 10, "battle.contacts.declineStuck": 1,
    "strategy.attackLoss.iskGateBlocked": 3, "strategy.review.launches": 90 },
});

function passingSet() {
  const pm = (share) => ({ base: 40, cases: Math.round(share * 40), share, firstBWinPiecemeal: 0, firstBWinWhole: 0 });
  return {
    base: summary(),
    noise: summary(),
    asm: summary({ counters: ON.asm, piecemeal: pm(0.2) }),
    mem: summary({ counters: ON.mem, piecemeal: pm(0.2), repeatLosses: 10 }),
    dec: summary({ counters: ON.dec, piecemeal: pm(0.2), repeatLosses: 10 }),
    isk: summary({ counters: ON.isk, piecemeal: pm(0.2), repeatLosses: 10 }),
  };
}

const ROLES = Object.freeze({ base: "base", noise: "noise", asm: "asm", mem: "mem", dec: "dec", isk: "isk" });
const verdicts = (v) => Object.fromEntries(Object.entries(v.flags).map(([k, f]) => [k, f.verdict]));

module.exports = ({ test }) => {
  test("BR1 battle AI reader: summarize sums, window, raids, repeatLosses; recapturesOf", () => {
    assert.deepStrictEqual([...R.RAID_TYPES], [...ATTACK_LOSS_OPERATION_TYPES]);
    const from = 1000 * H;
    const days = [
      segment(2, from + 15 * H, { battle: { "contacts.assemblyDeferred": 3, "contacts.declined": 1 },
        strategy: { "attackLoss.recorded": 2, "review.launches": 7 } }, 9, { logErrors: 1 }),
      segment(1, from, { battle: { "contacts.assemblyDeferred": 4 }, strategy: { "review.launches": 5 } }, 4,
        { logAttackLossFailed: 1 }),
    ];
    const battles = [
      { createdAt: from + H, outcome: "B_WIN", factionA: 1, operationTypeA: "raid", shipsLost: 5, shipsLostA: 4 },
      { createdAt: from + 20 * H, outcome: "B_WIN", factionA: 1, operationTypeA: "invasion", shipsLost: 6,
        shipsLostA: 3 },
      { createdAt: from + 2 * H, outcome: "A_WIN", factionA: 2, operationTypeA: "defense", shipsLost: 2, shipsLostA: 2 },
      { createdAt: from + 31 * H, outcome: "B_WIN", factionA: 1, operationTypeA: "raid", shipsLost: 9, shipsLostA: 9 },
    ];
    const s = R.summarize({ days, battles, captures: [{ capturedAt: from + H }, { capturedAt: from - 1 }],
      odds: { grinders: [{ bWins: 6 }, { bWins: 7 }],
        piecemealV2: { base: 12, cases: 3, share: 0.25, firstOutcome: { piecemeal: { B_WIN: 2 }, whole: { B_WIN: 1 } } } },
      occupation: { lostPosts: { total: 2, hostile: 1, abandoned: 1 }, recaptures: { total: 1, home: 1, other: 0 } } });
    assert.strictEqual(s.ok, true);
    assert.deepStrictEqual([s.segments, s.windowMs, s.exitOk], [2, 30 * H, true]);
    assert.deepStrictEqual([s.battles, s.raidBattles, s.raidBWin, s.shipsLost, s.raidShipsLostA, s.captures],
      [3, 2, 2, 13, 7, 1]);
    assert.deepStrictEqual([s.grinders, s.repeatLosses, s.lostPosts], [2, 13, 2]);
    assert.deepStrictEqual(s.piecemeal, { base: 12, cases: 3, share: 0.25, firstBWinPiecemeal: 2, firstBWinWhole: 1 });
    assert.strictEqual(s.counters["battle.contacts.assemblyDeferred"], 7);
    assert.strictEqual(s.counters["battle.contacts.declined"], 1);
    assert.strictEqual(s.counters["strategy.attackLoss.recorded"], 2);
    assert.strictEqual(s.counters["strategy.review.launches"], 12);
    assert.strictEqual(s.counters["strategy.attackLoss.iskGateBlocked"], 0);
    assert.deepStrictEqual(Object.keys(s.counters).sort(), [...R.COUNTER_NAMES].sort());
    assert.strictEqual(s.histogramsP95Max["strategy.decideMs"], 9);
    assert.strictEqual(s.histogramsP95Max["strategy.reviewReadMs"], null);
    assert.deepStrictEqual([s.passP95MsMedian, s.latenessP95MsMedian], [5, 2000]);
    assert.deepStrictEqual([s.checks.runs, s.logErrors, s.logAttackLossFailed], [2, 1, 1]);
    assert.strictEqual(R.summarize({ days: [days[0]], battles: [] }).exitOk, false);

    const entries = [
      { aggregateId: "30001", payload: { state: { controllerFactionId: 5, capturedAt: null } } },
      { aggregateId: "30002", payload: JSON.stringify({ state: { controllerFactionId: 6 } }) },
      { aggregateId: "30001", payload: { state: { controllerFactionId: 7, capturedAt: 10 } } },
      { aggregateId: "30001", payload: { state: { occupationState: "STABLE" } } },
      { aggregateId: "30001", payload: { state: { controllerFactionId: 5 } } },
      { aggregateId: "30002", payload: { state: { controllerFactionId: null } } },
    ];
    assert.deepStrictEqual(R.recapturesOf(entries, new Map([["30001", 5]])), { total: 1, home: 1, other: 0 });
    assert.deepStrictEqual(R.recapturesOf(entries, () => 7), { total: 1, home: 0, other: 1 });
  });

  test("BR2 battle AI reader: verdict per flag GO / NO_GO / INCONCLUSIVE / BLOCKED", () => {
    const a = R.verdict(passingSet(), ROLES);
    assert.deepStrictEqual(verdicts(a), { assembly: "GO", memory: "GO", decline: "GO", iskGate: "GO" },
      JSON.stringify(a.flags, null, 1));
    const b = passingSet();
    b.asm.piecemeal = { ...b.base.piecemeal };
    assert.deepStrictEqual(verdicts(R.verdict(b, ROLES)),
      { assembly: "NO_GO", memory: "BLOCKED", decline: "BLOCKED", iskGate: "BLOCKED" });
    const c = passingSet();
    c.asm.repeatLosses = 2;
    c.mem.repeatLosses = 1;
    assert.deepStrictEqual(verdicts(R.verdict(c, ROLES)),
      { assembly: "GO", memory: "INCONCLUSIVE", decline: "BLOCKED", iskGate: "BLOCKED" });
    const d = passingSet();
    d.mem.logAttackLossFailed = 1;
    const vd = R.verdict(d, ROLES);
    assert.deepStrictEqual(verdicts(vd), { assembly: "GO", memory: "NO_GO", decline: "BLOCKED", iskGate: "BLOCKED" });
    assert.strictEqual(vd.flags.memory.gates.C1.pass, false);
    assert.ok(R.markdown({ results: [{ name: "base", summary: d.base }], verdict: vd }).includes("| memory | NO_GO |"));
  });
};
