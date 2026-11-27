"use strict";

const assert = require("node:assert");

const { summarize, verdict } = require("../../tools/measure/worldFlagsReport");
const { createRegistry } = require("../../lib/telemetry/registry");
const { buildSnapshot } = require("../../lib/telemetry/snapshot");

const H15 = 15 * 3600000;
const T0 = 1700000000000;
const CALDARI = 500001;
const MINMATAR = 500002;
const SANSHA = 500019;

function snapshotOf(counts) {
  const reg = createRegistry({ histogramSamples: 8, maxMetrics: 256 });
  for (const [name, n] of Object.entries(counts)) assert.strictEqual(reg.count(name, n), true, name);
  return JSON.parse(JSON.stringify(buildSnapshot({ seq: 1, capturedAtMs: T0, startedAtMs: T0, intervalMs: 10000,
    histogramSamples: 8, status: { tick: "ok" }, process: { pid: 1 }, metrics: reg.read(),
    tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
    gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null } })));
}

const empire = (factionId, over = {}) => ({ factionId, unpaidPeriods: 0, resourceUnits: 500, incomeTotal: 1000,
  upkeepTotal: 800, liveShips: 300, liveFleets: 20, idleFleets: 5, fleetsInHq: 0, ...over });

function summary(over = {}) {
  return { ok: true, windowMs: 3 * H15, segments: 3, exitOk: true, checks: { runs: 3, pass: 3, fail: 0, error: 0 },
    battles: 40, shipsLost: 100, captures: 10, empireCaptures: 6,
    counters: { "review.hqHold": 0, "review.hqUnheld": 0, "review.hqReturnPlanned": 0, "review.patrolsLaunched": 20,
      "review.mobilized": 30, "review.launches": 50, "review.attacks": 15, "review.homeSpaceUnavailable": 0,
      "review.upkeepReserveBlocked": 4 },
    passP95MsMedian: 10, latenessP95MsMedian: 30000, logErrors: 1, logRowLimit: 0,
    empires: [empire(CALDARI), empire(MINMATAR)], empireLiveShips: 600, hqHeldFactions: 2, telemetryMissing: [], perDay: [],
    ...over };
}

module.exports = ({ test }) => {
  test("WR1 summarize: COUNTERS summed, window filter, empireCaptures, empireLiveShips, hqHeldFactions", () => {
    const days = [
      { index: 1, startVirtualAt: T0, stopVirtualAt: T0 + H15, logErrors: 1, logRowLimit: 0,
        report: { checks: { runs: 1, pass: 1, fail: 0, error: 0 } },
        telemetry: snapshotOf({ "strategy.review.hqHold": 3, "strategy.review.hqReturnPlanned": 1,
          "strategy.review.mobilized": 4, "strategy.review.runs": 9, "fleets.grid.movesPlanned": 5 }),
        status: [{ scheduler: { passP95Ms: 5, latenessP95Ms: 100 } }] },
      { index: 2, startVirtualAt: T0 + H15, stopVirtualAt: T0 + 2 * H15, logErrors: 0, logRowLimit: 1,
        report: { checks: { runs: 1, pass: 1, fail: 0, error: 0 } },
        telemetry: snapshotOf({ "strategy.review.hqHold": 2, "strategy.review.hqUnheld": 1,
          "strategy.review.mobilized": 6 }),
        status: [{ scheduler: { passP95Ms: 9, latenessP95Ms: 300 } }] },
    ];
    const s = summarize({ days,
      battles: [{ createdAt: T0, shipsLost: 2 }, { createdAt: T0 + H15, shipsLost: 3 },
        { createdAt: T0 + 2 * H15 - 1, shipsLost: 4 }, { createdAt: T0 + 2 * H15, shipsLost: 50 }],
      captures: [{ capturedAt: T0 + 10, controllerFactionId: CALDARI },
        { capturedAt: T0 + H15 + 10, controllerFactionId: SANSHA },
        { capturedAt: T0 - 1, controllerFactionId: MINMATAR }],
      factions: [empire(CALDARI, { liveShips: 200, fleetsInHq: 1 }), empire(MINMATAR, { liveShips: 150 }),
        empire(SANSHA, { liveShips: 99, fleetsInHq: 2 })],
      empireIds: [CALDARI, MINMATAR, 500004], hqFactionIds: [CALDARI, MINMATAR, SANSHA] });
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    assert.deepStrictEqual([s.windowMs, s.segments, s.exitOk], [2 * H15, 2, true]);
    assert.deepStrictEqual([s.battles, s.shipsLost, s.captures, s.empireCaptures], [3, 9, 2, 1]);
    assert.deepStrictEqual(s.counters, { "review.hqHold": 5, "review.hqUnheld": 1, "review.hqReturnPlanned": 1,
      "review.patrolsLaunched": 0, "review.mobilized": 10, "review.launches": 0, "review.attacks": 0,
      "review.homeSpaceUnavailable": 0, "review.upkeepReserveBlocked": 0 });
    assert.deepStrictEqual(s.empires.map((e) => e.factionId), [CALDARI, MINMATAR]);
    assert.deepStrictEqual([s.empireLiveShips, s.hqHeldFactions], [350, 2]);
    assert.deepStrictEqual([s.logErrors, s.logRowLimit, s.checks.runs], [1, 1, 2]);
    assert.deepStrictEqual(s.perDay.map((d) => [d.battles, d.captures, d.empireCaptures]), [[1, 1, 1], [2, 1, 0]]);
  });

  test("WR2 verdict: (a) both GO; (b) hq7 captures below -> Q3 fail + roles garrison; (c) upk7 ships 50 % -> U3 fail "
    + "+ permille 400", () => {
    const base = summary();
    const noise = summary({ captures: 11, battles: 42, shipsLost: 104 });
    const hq = summary({ hqHeldFactions: 3, counters: { ...base.counters, "review.hqHold": 12 } });
    const upk = summary({ empires: [empire(CALDARI, { incomeTotal: 1500 }), empire(MINMATAR, { incomeTotal: 1300 })] });
    const roles = { base: "base7", noise: "base8", hq: "hq7", upk: "upk7" };

    const a = verdict({ base7: base, base8: noise, hq7: hq, upk7: upk }, roles);
    assert.strictEqual(a.hq.verdict, "GO", JSON.stringify(a.hq.gates));
    assert.strictEqual(a.upk.verdict, "GO", JSON.stringify(a.upk.gates));
    assert.deepStrictEqual([a.hq.calibration, a.upk.calibration], [null, null]);

    const b = verdict({ base7: base, base8: noise, hq7: { ...hq, captures: 6 }, upk7: upk }, roles);
    assert.strictEqual(b.hq.verdict, "NO_GO");
    assert.strictEqual(b.hq.gates.Q3.pass, false, JSON.stringify(b.hq.gates.Q3));
    assert.deepStrictEqual([b.hq.gates.Q1.pass, b.hq.gates.Q2.pass, b.hq.gates.Q4.pass], [true, true, true]);
    assert.deepStrictEqual(b.hq.calibration.set, { "strategy.hqGarrisonRoles": "garrison" });

    const c = verdict({ base7: base, base8: noise, hq7: hq,
      upk7: { ...upk, empireLiveShips: 300 } }, roles);
    assert.strictEqual(c.upk.verdict, "NO_GO");
    assert.strictEqual(c.upk.gates.U3.pass, false, JSON.stringify(c.upk.gates.U3));
    assert.deepStrictEqual(c.upk.calibration.set, { "upkeep.homeSpaceIncomePermille": 400 });
    assert.strictEqual(c.hq.verdict, "GO");
  });

  test("WR3 no seg2.telemetry.json -> telemetryMissing [seg2]; upk7 U1/U3 FAIL, base7 Q1/U1/U3 FAIL, no GO", () => {
    const day = (index, telemetry) => ({ index, startVirtualAt: T0 + (index - 1) * H15, stopVirtualAt: T0 + index * H15,
      report: { checks: { runs: 1, pass: 1, fail: 0, error: 0 } }, telemetry, status: [] });
    const s = summarize({ days: [day(1, snapshotOf({ "strategy.review.mobilized": 4 })), day(2, null),
      day(3, snapshotOf({}))], battles: [], captures: [], factions: [], empireIds: [], hqFactionIds: [] });
    assert.deepStrictEqual(s.telemetryMissing, ["seg2"]);
    const base = summary();
    const noise = summary({ captures: 11, battles: 42, shipsLost: 104 });
    const hq = summary({ hqHeldFactions: 3, counters: { ...base.counters, "review.hqHold": 12 } });
    const upk = summary({ empires: [empire(CALDARI, { incomeTotal: 1500 }), empire(MINMATAR, { incomeTotal: 1300 })] });
    const roles = { base: "base7", noise: "base8", hq: "hq7", upk: "upk7" };
    const reason = "FAIL upk telemetryMissing: [seg2]";

    const a = verdict({ base7: base, base8: noise, hq7: hq, upk7: { ...upk, telemetryMissing: ["seg2"] } }, roles);
    assert.deepStrictEqual([a.upk.verdict, a.upk.gates.U1.pass, a.upk.gates.U3.pass, a.upk.calibration],
      ["NO_GO", false, false, null]);
    assert.ok(a.upk.gates.U3.detail.includes(reason), a.upk.gates.U3.detail.join("; "));
    assert.ok(a.upk.gates.U1.detail.includes("FAIL on telemetryMissing: [seg2]"), a.upk.gates.U1.detail.join("; "));
    assert.strictEqual(a.hq.verdict, "GO");

    const b = verdict({ base7: { ...base, telemetryMissing: ["seg2"] }, base8: noise, hq7: hq, upk7: upk }, roles);
    assert.deepStrictEqual([b.hq.verdict, b.hq.gates.Q1.pass, b.hq.calibration], ["NO_GO", false, null]);
    assert.deepStrictEqual([b.upk.verdict, b.upk.gates.U1.pass, b.upk.gates.U3.pass, b.upk.calibration],
      ["NO_GO", false, false, null]);
    assert.ok(b.upk.gates.U3.detail.includes("FAIL base telemetryMissing: [seg2]"), b.upk.gates.U3.detail.join("; "));
  });
};
