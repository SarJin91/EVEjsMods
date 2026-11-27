"use strict";

const assert = require("node:assert");

const { deferredOf, deferredMark } = require("../../tools/measure/histogramsDeferred");
const scalingExtract = require("../../tools/scaling/extract");
const scalingAgg = require("../../tools/scaling/aggregate");
const fcExtract = require("../../tools/measure/freeCorpsScale/extract");
const fcAgg = require("../../tools/measure/freeCorpsScale/aggregate");
const battleAi = require("../../tools/measure/battleAiReport");

const T0 = 1700000000000;
const H = 3600000;
const EVERY_MS = 10000;
const P95 = [100, 100, 110, 100, 105, 100];
const DEFERRED_AT = 2;

function snap(i, deferred) {
  const s = { schemaVersion: 1, seq: i + 1, capturedAtMs: T0 + i * EVERY_MS, startedAtMs: T0 - 2 * H,
    process: { uptimeSeconds: 7200 + i * 10, rssBytes: 1000 },
    tick: { intervalMs: { samples: 100, spanMs: EVERY_MS - 1000, p50: 50, p95: P95[i], max: 200 } },
    channels: { freeCorps: { passMs: { samples: 100, spanMs: EVERY_MS - 1000, p95: P95[i] / 10, max: 30 } } },
    capture: { lastWriteMs: 1, writeSkips: 0, writeErrors: 0, lastWriteError: "" } };
  if (deferred !== undefined) s.capture.steps = { registryReadMs: 1, histogramsDeferred: deferred };
  return s;
}

function series(withDeferred) {
  return P95.map((_, i) => snap(i, withDeferred ? (i === DEFERRED_AT ? 3 : 0) : undefined));
}

const MARK_KEYS = ["histogramsDeferred", "deferredWindows", "deferredRows", "deferredMax"];

function stripMarks(v) {
  if (Array.isArray(v)) return v.map(stripMarks);
  if (v === null || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!MARK_KEYS.includes(k)) out[k] = stripMarks(x);
  return out;
}

module.exports = ({ test }) => {
  test("HD1 histogramsDeferred helper: snapshot / row / absent, mark counts windows", () => {
    assert.strictEqual(deferredOf(snap(0, 4)), 4);
    assert.strictEqual(deferredOf({ "capture.steps.histogramsDeferred": 2 }), 2);
    assert.deepStrictEqual([deferredOf(snap(0)), deferredOf(snap(0, 0)), deferredOf(null),
      deferredOf({ "capture.steps.histogramsDeferred": null }), deferredOf({ capture: { steps: { histogramsDeferred: "5" } } })],
    [0, 0, 0, 0, 0]);
    assert.deepStrictEqual(deferredMark([snap(0, 0), snap(1, 3), { "capture.steps.histogramsDeferred": 7 }, null]),
      { histogramsDeferred: true, deferredWindows: 2, deferredMax: 7 });
    assert.deepStrictEqual(deferredMark(undefined), { histogramsDeferred: false, deferredWindows: 0, deferredMax: 0 });
  });

  test("HD2 scaling / freeCorpsScale / battleAiReport mark the deferred window and keep the numbers", () => {
    const stage = (withDeferred) => {
      const rows = series(withDeferred).map((s) => {
        const r = scalingExtract.extractRow(s);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r.row;
      });
      return scalingAgg.summarizeStage({ label: "S1", axis: "base" }, rows, null, { type: "footer" });
    };
    const sWith = stage(true);
    const sWithout = stage(false);
    assert.deepStrictEqual([sWith.histogramsDeferred, sWith.deferredRows, sWith.deferredWindows, sWith.deferredMax],
      [true, 1, 1, 3]);
    assert.deepStrictEqual([sWithout.histogramsDeferred, sWithout.deferredRows, sWithout.deferredWindows],
      [false, 0, 0]);
    assert.strictEqual(sWith.windows, P95.length);
    assert.deepStrictEqual(stripMarks(sWith), stripMarks(sWithout));

    const fc = (withDeferred) => {
      const rows = series(withDeferred).map((s) => {
        const r = fcExtract.extractRow(s);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return { type: "row", ...r.row };
      });
      return fcAgg.summarize({ headers: [{ type: "header", everyS: 10 }], rows });
    };
    const fWith = fc(true);
    const fWithout = fc(false);
    assert.deepStrictEqual([fWith.tick.histogramsDeferred, fWith.tick.deferredWindows,
      fWith.histograms.passMs.histogramsDeferred, fWith.histograms.passMs.deferredWindows], [true, 1, true, 1]);
    assert.deepStrictEqual([fWithout.tick.histogramsDeferred, fWithout.histograms.passMs.histogramsDeferred],
      [false, false]);
    assert.strictEqual(fWith.tick.p95Worst, 110);
    assert.deepStrictEqual(stripMarks(fWith), stripMarks(fWithout));

    const ai = (withDeferred) => {
      const days = series(withDeferred).map((s, i) => {
        const from = T0 + i * H;
        const telemetry = { ...s, channels: { strategy: { decideMs: { samples: 10, p95: P95[i] } } } };
        return { index: i + 1, startVirtualAt: from, stopVirtualAt: from + H,
          report: { startVirtualAt: from, stopVirtualAt: from + H, checks: { runs: 1, pass: 1, fail: 0, error: 0 } },
          telemetry, status: [], exitCode: 0 };
      });
      return battleAi.summarize({ days });
    };
    const aWith = ai(true);
    const aWithout = ai(false);
    assert.deepStrictEqual([aWith.histogramsDeferred, aWith.deferredWindows, aWith.deferredMax], [true, 1, 3]);
    assert.deepStrictEqual([aWithout.histogramsDeferred, aWithout.deferredWindows], [false, 0]);
    assert.strictEqual(aWith.histogramsP95Max["strategy.decideMs"], 110);
    assert.deepStrictEqual(stripMarks(aWith), stripMarks(aWithout));
  });
};
