"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { summarize, main, verdict, readVariant, CALIBRATION } = require("../../tools/measure/fortressReport");
const { createRegistry } = require("../../lib/telemetry/registry");
const { buildSnapshot } = require("../../lib/telemetry/snapshot");

const FORT = 30100000;
const DAY = 86400000;
const T0 = 1700000000000;
const MEMORY_MS = 3600000;

function snapshotOf(counts, routeSearchMs) {
  const reg = createRegistry({ histogramSamples: 8, maxMetrics: 256 });
  for (const [name, n] of Object.entries(counts)) assert.strictEqual(reg.count(name, n), true, name);
  for (const v of routeSearchMs) assert.strictEqual(reg.observe("graph.routeSearchMs", v), true);
  return JSON.parse(JSON.stringify(buildSnapshot({ seq: 1, capturedAtMs: T0, startedAtMs: T0, intervalMs: 10000,
    histogramSamples: 8, status: { tick: "ok" }, process: { pid: 1 }, metrics: reg.read(),
    tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
    gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null } })));
}

const tr = (createdAt, fleetId, systems, extra = {}) => ({ createdAt, fleetId, to: "TRAVELLING", systems,
  wormhole: false, factionId: 500001, fleetRole: "logistics", ...extra });

module.exports = ({ test }) => {
  test("FR1 summarize: crossings inside only, day bounds + outside, unique fleets, HALT memory repeats, null "
    + "telemetry names, p95 total = max; --variant <empty dir> -> exit 1, one line", () => {
    const days = [
      { index: 1, startVirtualAt: T0, stopVirtualAt: T0 + DAY,
        telemetry: snapshotOf({ "fleets.travel.routeTooFar": 3, "fleets.travel.routeAdviceRefusedTooFar": 2,
          "fleets.travel.adviceRefused_scout": 2, "graph.routeAversionApplied": 1, "fortress.halts": 2 }, [1, 4]),
        status: [{ scheduler: { latenessP95Ms: 10, passP95Ms: 5 } }, { scheduler: { latenessP95Ms: 30, passP95Ms: null } },
          { check: "PASS" }] },
      { index: 2, startVirtualAt: T0 + DAY, stopVirtualAt: T0 + 2 * DAY,
        telemetry: snapshotOf({ "fleets.travel.routeTooFar": 1, "graph.routeAversionApplied": 2 }, [9]), status: [] },
    ];
    const transitions = [
      tr(T0 + 1, "f1", [1, FORT, 2]),
      tr(T0 + 2, "f1", [2, FORT, 3, 4]),
      tr(T0 + 3, "f2", [FORT, 5, 6], { factionId: 500010, fleetRole: "scout" }),
      tr(T0 + 4, "f3", [7, 8, FORT]),
      tr(T0 + 5, "f4", [9, FORT, 10], { wormhole: true, factionId: 500010, fleetRole: "scout" }),
      { ...tr(T0 + 6, "f5", [1, FORT, 2]), to: "RETREATING" },
      tr(T0 + DAY + 1, "f1", [3, FORT, 4]),
      tr(T0 - 1, "f9", [1, FORT, 2]),
      tr(T0 + 2 * DAY, "f9", [1, FORT, 2]),
    ];
    const halts = [
      { createdAt: T0 + 10, fleetId: "f1", factionId: 500001 },
      { createdAt: T0 + 10 + MEMORY_MS - 1, fleetId: "f1", factionId: 500001 },
      { createdAt: T0 + 10 + 3 * MEMORY_MS, fleetId: "f4", factionId: 500001 },
      { createdAt: T0 + DAY + 5, fleetId: "f7", factionId: 500010 },
    ];
    const battles = [{ createdAt: T0 + 11, battleId: "b1", outcome: "B_WIN", shipsLost: 3, shipsInput: 10 },
      { createdAt: T0 + DAY + 6, battleId: "b2", outcome: null, shipsLost: 0, shipsInput: 4 }];
    const s = summarize({ days, transitions, halts, battles, convoysEnded: [{ endedAt: T0 + 7, endReason: "LOST" }],
      expeditionsCutOff: [{ cutOffAt: T0 + DAY + 2 }], memoryRows: 2 }, { fortressId: FORT, haltMemoryMs: MEMORY_MS });
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    const [d1, d2] = s.days;
    assert.deepStrictEqual([d1.plans, d1.retreats, d1.crossings, d1.crossingsWh, d1.crossingsRetreat, d1.fleetsCrossing,
      d1.byFaction, d1.byRole, d1.avgLegJumps], [5, 1, 3, 1, 1, 2, { 500001: 2, 500010: 1 }, { logistics: 2, scout: 1 },
      2.2]);
    assert.deepStrictEqual([d2.plans, d2.crossings, d2.fleetsCrossing], [1, 1, 1]);
    assert.deepStrictEqual([d1.halts, d1.fleetsHalted, d1.maxHaltsOneFleet, d1.repeatHaltsSameFaction,
      d2.halts, d2.repeatHaltsSameFaction], [3, 2, 2, 1, 1, 0]);
    assert.deepStrictEqual([d1.battles, d1.shipsLost, d1.shipsInput, d1.outcomes, d2.outcomes],
      [1, 3, 10, { B_WIN: 1 }, { null: 1 }]);
    assert.deepStrictEqual([d1.convoysEndedBy, d1.expeditionsCutOff, d2.expeditionsCutOff], [{ LOST: 1 }, 0, 1]);
    assert.deepStrictEqual([d1.telemetry["travel.routeTooFar"], d1.telemetry["travel.routeAdviceRefusedTooFar"],
      d1.telemetry.tooFarTotal, d1.telemetry["fortress.halts"], d1.telemetry["fortress.passed"],
      d1.telemetry.adviceRefusedByRole], [3, 2, 5, 2, 0, { scout: 2 }]);
    assert.deepStrictEqual([d2.telemetry["travel.routeAdviceRefusedTooFar"], d2.telemetry.tooFarTotal,
      d2.telemetry.adviceRefusedByRole], [0, 1, null]);
    assert.deepStrictEqual([d1.latenessP95Ms, d1.passP95Ms, d2.latenessP95Ms], [{ max: 30, median: 20 },
      { max: 5, median: 5 }, null]);
    const t = s.total;
    assert.deepStrictEqual([t.plans, t.crossings, t.fleetsCrossing, t.halts, t.fleetsHalted, t.maxHaltsOneFleet,
      t.repeatHaltsSameFaction, t.outside, t.memoryRows, t.battles, t.shipsLost],
    [6, 4, 2, 4, 3, 2, 1, 2, 2, 2, 3]);
    assert.deepStrictEqual([t.telemetry["graph.routeAversionApplied"], t.telemetry["travel.routeTooFar"],
      t.telemetry.tooFarTotal, t.telemetry["graph.routeSearchMs.p95"]],
    [3, 4, 6, Math.max(d1.telemetry["graph.routeSearchMs.p95"], d2.telemetry["graph.routeSearchMs.p95"])]);
    assert.strictEqual(t.telemetry["graph.routeSearchMs.p95"], 9);
    const seg = (index, telemetry) => ({ index, startVirtualAt: T0 + (index - 1) * DAY,
      stopVirtualAt: T0 + index * DAY, telemetry, status: [] });
    const s2 = summarize({ days: [seg(1, snapshotOf({ "fleets.travel.routeAdviceRefusedNoPathTooFar": 4,
      "fleets.travel.routeAdviceRefusedNoPath": 4 }, [])), seg(2, null),
    seg(3, { fleets: { "travel.routeTooFar": 1 }, graph: {} })], transitions: [], halts: [], battles: [] },
    { fortressId: FORT, haltMemoryMs: MEMORY_MS });
    assert.strictEqual(s2.ok, true, JSON.stringify(s2));
    const [e1, e2, e3] = s2.days;
    assert.deepStrictEqual([e1.telemetry["travel.routeAdviceRefusedNoPathTooFar"], e1.telemetry.tooFarTotal],
      [4, 4]);
    assert.deepStrictEqual([e2.telemetry["travel.routeTooFar"], e2.telemetry["fortress.passed"],
      e2.telemetry.tooFarTotal, s2.total.telemetry.tooFarTotal, s2.total.telemetry["travel.routeTooFar"]],
    [null, null, null, null, null]);
    assert.deepStrictEqual([e3.telemetry["fortress.halts"], e3.telemetry["travel.routeAdviceRefusedNoPathTooFar"],
      e3.telemetry.tooFarTotal], [null, 0, 1]);
    assert.deepStrictEqual(summarize({ days: [] }, { fortressId: 0, haltMemoryMs: 1 }).reason, "INVALID_INPUT");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-fr1-"));
    try {
      const out = [];
      const err = [];
      const code = main(["--variant", `x=${dir}`], { out: (l) => out.push(l), err: (l) => err.push(l) });
      assert.deepStrictEqual([code, out.length, err.length], [1, 0, 1], JSON.stringify(err));
      assert.ok(err[0].includes("missing world.sqlite"), err[0]);
      assert.strictEqual(main(["--bogus"], { out() {}, err() {} }), 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FR2 verdict F1-F5: GO; R 0.5 -> F2 fail + calibration rule 1; FORTRESS_ROW_BOUND / disabled state -> F1 "
    + "fail, no calibration; readVariant reads seg<n>.log and seg<n>.exit", () => {
    const OPTS = { fortressId: FORT, haltMemoryMs: MEMORY_MS };
    const variant = ({ crossings, others = 100, tooFar = 10, state = "running", day = {}, halts = [] }) => {
      const days = [1, 2, 3].map((index) => ({ index, startVirtualAt: T0 + (index - 1) * DAY,
        stopVirtualAt: T0 + index * DAY, report: { checks: { runs: 2, pass: 2, fail: 0, error: 0 } },
        telemetry: { fleets: { "travel.routeTooFar": index === 1 ? tooFar : 0 }, graph: { routeSearchMs: { p95: 0.3 } },
          fortress: {} },
        status: [{ scheduler: { latenessP95Ms: 10, passP95Ms: 5 } }], fortressState: state, exitCode: 0,
        ...(day[index] || {}) }));
      const transitions = [];
      for (let i = 0; i < crossings; i += 1) transitions.push(tr(T0 + 1 + i, `x${i}`, [1, FORT, 2]));
      for (let i = 0; i < others; i += 1) transitions.push(tr(T0 + 1 + i, `o${i}`, [1, 3, 2]));
      const s = summarize({ days, transitions, halts, battles: [] }, OPTS);
      assert.strictEqual(s.ok, true, JSON.stringify(s));
      return s;
    };
    const halts = [{ createdAt: T0 + 100, fleetId: "h1", factionId: 500001 },
      { createdAt: T0 + DAY + 100, fleetId: "h2", factionId: 500010 }];
    const off = variant({ crossings: 100, state: "disabled:disabled_by_config" });
    const roles = { base: "off", on: "mem" };

    const a = verdict({ off, mem: variant({ crossings: 10, halts }) }, roles);
    assert.strictEqual(a.verdict, "GO", JSON.stringify(a.gates));
    assert.deepStrictEqual(Object.values(a.gates).map((g) => g.pass), [true, true, true, true, true]);
    assert.strictEqual(a.calibration, null);
    assert.ok(a.notes.some((n) => n.startsWith("SWEEP")), JSON.stringify(a.notes));

    const b = verdict({ off, mem: variant({ crossings: 50, halts }) }, roles);
    assert.deepStrictEqual([b.verdict, b.gates.F1.pass, b.gates.F2.pass, b.gates.F3.pass], ["NO_GO", true, false, true]);
    assert.deepStrictEqual(b.calibration, { rule: "1", set: { ...CALIBRATION[1] } });
    const bCtl = verdict({ off, ctl: variant({ crossings: 50, halts }) }, { base: "off", on: "ctl", ctl: "ctl" });
    assert.deepStrictEqual([bCtl.verdict, bCtl.calibration], ["NO_GO", null]);

    const c1 = verdict({ off, mem: variant({ crossings: 50, halts, day: { 2: { rowBoundRefusals: 1 } } }) }, roles);
    assert.deepStrictEqual([c1.verdict, c1.gates.F1.pass, c1.calibration], ["NO_GO", false, null]);
    assert.ok(c1.gates.F1.detail.some((l) => l.includes("FORTRESS_ROW_BOUND lines=1")), c1.gates.F1.detail.join("; "));
    const c2 = verdict({ off, mem: variant({ crossings: 10, halts, state: "disabled:FORTRESS_ROW_BOUND" }) }, roles);
    assert.deepStrictEqual([c2.verdict, c2.gates.F1.pass, c2.calibration], ["NO_GO", false, null]);
    assert.deepStrictEqual(verdict({ off }, roles).reason, "INVALID_INPUT");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-fr2-"));
    try {
      fs.writeFileSync(path.join(dir, "world.sqlite"), "");
      fs.writeFileSync(path.join(dir, "seg1.report.json"), JSON.stringify({ startVirtualAt: T0, stopVirtualAt: T0 + DAY,
        checks: { runs: 1, pass: 1, fail: 0, error: 0 } }));
      fs.writeFileSync(path.join(dir, "seg1.log"), ["liveSim: start", "services: telemetry=running fortress=running "
        + "blockade=disabled:disabled_by_config", "strategy: review refused TX_ROW_LIMIT (rows 1001)", ""].join("\n"));
      fs.writeFileSync(path.join(dir, "seg1.exit"), "0\n");
      class FakeDb {
        prepare() {
          return { all: () => [], get: () => ({ n: 0 }) };
        }

        close() {}
      }
      const s = readVariant(dir, { ...OPTS, Database: FakeDb });
      assert.strictEqual(s.ok, true, JSON.stringify(s));
      const d1 = s.days[0];
      assert.deepStrictEqual([d1.fortressState, d1.logRowLimit, d1.logErrors, d1.rowBoundRefusals, d1.exitCode,
        d1.exitOk, s.total.exitOk, s.total.fortressStates], ["running", 1, 0, 0, 0, true, true, ["running"]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
