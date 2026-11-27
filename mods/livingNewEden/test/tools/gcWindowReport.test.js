"use strict";

const assert = require("node:assert");

const { summarizeRun } = require("../../tools/gcWindowReport");

const MB = 1024 * 1024;
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const FIVE_MIN = 5 * 60000;

function snap(i, o) {
  const opts = o || {};
  return {
    schemaVersion: 1,
    seq: 100 + i,
    capturedAtMs: T0 + i * FIVE_MIN,
    process: { pid: opts.pid || 7, uptimeSeconds: 3600 + i * 300, rssBytes: (4000 + i * 10) * MB,
      heapUsedBytes: (3000 + i) * MB, heapTotalBytes: 3300 * MB },
    tick: { intervalMs: { samples: 3000, capacity: 3000, spanMs: opts.spanMs === undefined ? 300000 : opts.spanMs,
      avg: 100, p50: 100, p95: opts.p95 || 120, max: opts.max || 300 } },
    gc: {
      count: 1000 + i * 400,
      totalMs: 10000 + i * 3000,
      kinds: {
        minor: { count: 990 + i * 398, totalMs: 7000 + i * 2600, maxMs: 53 },
        major: { count: 10 + i * 2, totalMs: 3000 + i * 400, maxMs: opts.majorMax || 495 },
        incremental: { count: 0, totalMs: 0, maxMs: 0 },
        weakCallback: { count: 0, totalMs: 0, maxMs: 0 },
        unknown: { count: 0, totalMs: 0, maxMs: 0 },
      },
    },
    governor: { counts: { emergencySamples: 5 + i, unplayableSamples: i * 2 } },
  };
}

module.exports = ({ test }) => {
  test("GCW1 gcWindowReport: deltas, GC % of wall, p95 median/max without snapshot 0, majorMaxMs", () => {
    const snaps = [
      snap(0, { p95: 900, max: 2000 }),
      snap(1, { p95: 110, max: 250 }),
      snap(2, { p95: 140, max: 400, majorMax: 510 }),
    ];
    const r = summarizeRun(snaps);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.row, {
      minutes: 10,
      minorCount: 796,
      minorTotalMs: 5200,
      minorAvgMs: 6.53,
      majorCount: 4,
      majorTotalMs: 800,
      majorMaxMs: 510,
      gcPercentWall: 1,
      intervalP95Median: 125,
      intervalP95Max: 140,
      intervalMax: 400,
      emergencySamples: 2,
      unplayableSamples: 4,
      rssStartMB: 4000,
      rssEndMB: 4020,
      heapUsedEndMB: 3002,
      windowsShort: 0,
    });
    const flat = summarizeRun([snap(0), snap(1), snap(2)]);
    assert.strictEqual(flat.ok, true);
    assert.strictEqual(flat.row.majorMaxMs, null, "no growth of major maxMs -> unknown in the window");
  });

  test("GCW2 gcWindowReport: PROCESS_RESTARTED, TELEMETRY_UNAVAILABLE, TOO_FEW_SNAPSHOTS", () => {
    const got = [
      summarizeRun([snap(0), snap(1), snap(2, { pid: 8 })]).reason,
      summarizeRun([snap(0), { available: false, reason: "telemetry_disabled" }]).reason,
      summarizeRun([snap(0)]).reason,
      summarizeRun([snap(1), snap(0)]).reason,
    ];
    assert.deepStrictEqual(got,
      ["PROCESS_RESTARTED", "TELEMETRY_UNAVAILABLE", "TOO_FEW_SNAPSHOTS", "PROCESS_RESTARTED"]);
  });

  test("GCW3 gcWindowReport: view / envelope / bare shapes give one row; short spanMs counts windowsShort", () => {
    const bare = [snap(0), snap(1), snap(2)];
    const view = bare.map((s) => ({ available: true, snapshot: s }));
    const envelope = bare.map((s) => ({ ok: true, id: "telemetry", cached: false, stale: false,
      data: { available: true, snapshot: s } }));
    const a = summarizeRun(bare);
    assert.strictEqual(a.ok, true);
    assert.deepStrictEqual(summarizeRun(view).row, a.row);
    assert.deepStrictEqual(summarizeRun(envelope).row, a.row);
    const short = summarizeRun([snap(0), snap(1, { spanMs: 269000 }), snap(2, { spanMs: 270000 })]);
    assert.strictEqual(short.row.windowsShort, 1);
  });
};
