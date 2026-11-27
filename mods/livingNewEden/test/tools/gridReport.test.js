"use strict";

const assert = require("node:assert");

const { summarize, verdict, THRESHOLDS } = require("../../tools/measure/gridReport");
const { createRegistry } = require("../../lib/telemetry/registry");
const { buildSnapshot } = require("../../lib/telemetry/snapshot");

const H12 = 12 * 3600000;
const T0 = 1700000000000;

function snapshotOf(counts, anchorReadMs) {
  const reg = createRegistry({ histogramSamples: 8, maxMetrics: 256 });
  for (const [name, n] of Object.entries(counts)) assert.strictEqual(reg.count(name, n), true, name);
  for (const v of anchorReadMs) assert.strictEqual(reg.observe("fleets.grid.anchorReadMs", v), true);
  return JSON.parse(JSON.stringify(buildSnapshot({ seq: 1, capturedAtMs: T0, startedAtMs: T0, intervalMs: 10000,
    histogramSamples: 8, status: { tick: "ok" }, process: { pid: 1 }, metrics: reg.read(),
    tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
    gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null } })));
}

function summary(over = {}) {
  return { ok: true, windowMs: 4 * H12, segments: 4, exitOk: true, checks: { runs: 4, pass: 4, fail: 0, error: 0 },
    battles: 40, battlesWithGrid: 20, battlesByGridKind: {}, battlesByObjective: {}, shipsLost: 100, captures: 8,
    counters: { "fleets.grid.visitsWritten": 500, "fleets.grid.movesPlanned": 300, "fleets.grid.defense.alerts": 30,
      "fleets.grid.defense.pursuits": 12, "battle.contacts.gridQueued": 25, "fleets.grid.defense.crossingChecks": 40,
      "fleets.grid.defense.crossingsCaught": 3 },
    histogramsP95Max: { "fleets.grid.anchorReadMs": 0.4, "fleets.grid.moveMs": 60000,"fleets.grid.defense.decideMs": 0.8,
      "fleets.grid.defense.crossingListenerMs": null },
    passP95MsMedian: 10, latenessP95MsMedian: 30000, visitRows: 200, liveFleets: 400, logErrors: 1, logRowLimit: 0,
    unsupported: {}, telemetryMissing: [], perDay: [], ...over };
}

module.exports = ({ test }) => {
  test("GR1 summarize: counters summed, p95 max, window filter, battlesWithGrid", () => {
    const days = [
      { index: 1, startVirtualAt: T0, stopVirtualAt: T0 + H12, logErrors: 1, logRowLimit: 0,
        report: { checks: { runs: 1, pass: 1, fail: 0, error: 0 }, unsupported: { readGridAnchors: 2 } },
        telemetry: snapshotOf({ "fleets.grid.visitsWritten": 5, "fleets.grid.defense.alerts": 2,
          "battle.contacts.gridQueued": 1, "battle.contactChecks": 9, "fleets.travel.routeTooFar": 4,
          "lowsec.campGateHeld": 1, "sentries.battleGridRounds": 3, "sentries.active": 7 }, [1, 4]),
        status: [{ scheduler: { passP95Ms: 5, latenessP95Ms: 100 } }, { scheduler: { passP95Ms: 7 } }] },
      { index: 2, startVirtualAt: T0 + H12, stopVirtualAt: T0 + 2 * H12, logErrors: 0, logRowLimit: 1,
        report: { checks: { runs: 1, pass: 0, fail: 1, error: 0 }, unsupported: { readGridAnchors: 1 } },
        telemetry: snapshotOf({ "fleets.grid.visitsWritten": 3, "materialization.gridAnchorUsed": 2 }, [9]),
        status: [{ scheduler: { passP95Ms: 9, latenessP95Ms: 300 } }] },
    ];
    const battles = [
      { createdAt: T0 + 10, gridKind: "gate", objective: "intercept", mode: "VIRTUAL", shipsLost: 3 },
      { createdAt: T0 + H12 + 5, gridKind: null, objective: null, mode: "VIRTUAL", shipsLost: 2 },
      { createdAt: T0 + 2 * H12 + 5, gridKind: "station", objective: "siege", mode: "VIRTUAL", shipsLost: 50 },
    ];
    const captures = [{ capturedAt: T0 - 1 }];
    const s = summarize({ days, battles, captures, visitRows: 4, liveFleets: 9 });
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    assert.deepStrictEqual([s.windowMs, s.segments, s.exitOk, s.battles, s.battlesWithGrid, s.shipsLost, s.captures],
      [2 * H12, 2, true, 2, 1, 5, 0]);
    assert.deepStrictEqual([s.battlesByGridKind, s.battlesByObjective], [{ gate: 1, none: 1 },
      { intercept: 1, none: 1 }]);
    assert.deepStrictEqual(s.counters, { "fleets.grid.visitsWritten": 8, "fleets.grid.defense.alerts": 2,
      "battle.contacts.gridQueued": 1, "lowsec.campGateHeld": 1, "sentries.battleGridRounds": 3,
      "materialization.gridAnchorUsed": 2 });
    assert.strictEqual(s.histogramsP95Max["fleets.grid.anchorReadMs"], 9);
    assert.strictEqual(s.histogramsP95Max["fleets.grid.moveMs"], null);
    assert.deepStrictEqual([s.checks, s.unsupported, s.logErrors, s.logRowLimit, s.visitRows, s.liveFleets],
      [{ runs: 2, pass: 1, fail: 1, error: 0 }, { readGridAnchors: 3 }, 1, 1, 4, 9]);
    assert.deepStrictEqual([s.passP95MsMedian, s.latenessP95MsMedian], [7, 200]);
    assert.deepStrictEqual(s.perDay.map((d) => [d.battles, d.battlesWithGrid, d.shipsLost]), [[1, 1, 3], [1, 0, 2]]);
    const torn = summarize({ days: [{ ...days[0], report: { error: "x" } }, days[1]], battles: [], captures: [] });
    assert.strictEqual(torn.exitOk, false);
    const gap = summarize({ days: [days[0], { ...days[1], index: 3 }], battles: [], captures: [] });
    assert.strictEqual(gap.exitOk, false);
    assert.strictEqual(summarize({ days: [] }).reason, "INVALID_INPUT");
  });

  test("GR2 verdict: all pass -> GO; captures above the band -> NO_GO rule 1; recordErrors -> G1 fail, no "
    + "calibration", () => {
    const roles = { base: "off7", noise: "off8", on: "on7", nostat: "nostat7" };
    const base = { off7: summary(), off8: summary({ battles: 42, shipsLost: 104, captures: 9 }),
      nostat7: summary({ battlesWithGrid: 0, counters: { "fleets.grid.anchorsUnavailable": 7 } }) };
    const a = verdict({ ...base, on7: summary({ battles: 38, captures: 9 }) }, roles);
    assert.strictEqual(a.verdict, "GO", JSON.stringify(a.gates));
    assert.strictEqual(a.calibration, null);
    assert.deepStrictEqual(Object.entries(a.gates).map(([g, r]) => [g, r.pass]),
      [["G1", true], ["G2", true], ["G3", true], ["G4", true], ["G5", true]]);
    const b = verdict({ ...base, on7: summary({ captures: 11 }) }, roles);
    assert.deepStrictEqual([b.verdict, b.gates.G2.pass, b.gates.G1.pass, b.gates.G3.pass, b.gates.G5.pass],
      ["NO_GO", false, true, true, true]);
    assert.deepStrictEqual(b.calibration, { rule: "1", set: { ...THRESHOLDS.calibration[1] } });
    assert.deepStrictEqual(b.calibration.set, { "grid.defense.locateMs": 45000, "grid.defense.maxPursuersPerIntruder": 4 });
    const on = summary();
    const c = verdict({ ...base, on7: { ...on, counters: { ...on.counters, "fleets.grid.recordErrors": 1 } } }, roles);
    assert.deepStrictEqual([c.verdict, c.gates.G1.pass, c.calibration], ["NO_GO", false, null]);
    assert.ok(c.gates.G1.detail.some((l) => l.includes("fleets.grid.recordErrors=1")), c.gates.G1.detail.join("; "));
  });

  test("GR3 no seg2.telemetry.json -> telemetryMissing [seg2], G1/G3/G5 FAIL, NO_GO, no calibration", () => {
    const day = (index, telemetry) => ({ index, startVirtualAt: T0 + (index - 1) * H12, stopVirtualAt: T0 + index * H12,
      report: { checks: { runs: 1, pass: 1, fail: 0, error: 0 } }, telemetry, status: [] });
    const s = summarize({ days: [day(1, snapshotOf({ "fleets.grid.visitsWritten": 5 }, [])), day(2, null),
      day(3, snapshotOf({}, []))], battles: [], captures: [] });
    assert.deepStrictEqual(s.telemetryMissing, ["seg2"]);
    const roles = { base: "off7", noise: "off8", on: "on7", nostat: "nostat7" };
    const all = { off7: summary(), off8: summary({ battles: 42, shipsLost: 104, captures: 9 }),
      nostat7: summary({ battlesWithGrid: 0, counters: { "fleets.grid.anchorsUnavailable": 7 } }) };
    const v = verdict({ ...all, on7: summary({ captures: 11, telemetryMissing: ["seg2"] }) }, roles);
    assert.deepStrictEqual([v.verdict, v.gates.G1.pass, v.gates.G3.pass, v.gates.G5.pass, v.gates.G4.pass,
      v.calibration], ["NO_GO", false, false, false, true, null]);
    for (const g of ["G1", "G3", "G5"]) {
      assert.ok(v.gates[g].detail.includes("FAIL on telemetryMissing: [seg2]"), v.gates[g].detail.join("; "));
    }
    const { telemetryMissing, ...bare } = summary();
    assert.deepStrictEqual(telemetryMissing, []);
    assert.strictEqual(verdict({ ...all, on7: bare }, roles).gates.G1.pass, false);
  });
};
