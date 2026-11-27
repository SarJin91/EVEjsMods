"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  REASONS,
  parseSpikeLog,
  summarizeSpikeLog,
  parsePauseProfileEvents,
  classifySample,
  aggregateFromPauseProfile,
  correlateRestWithProfile,
  analyzeTelemetrySpikes,
  formatTable,
  main,
} = require("../../tools/restDiagnosis");
const { createSpikeAttribution } = require("../../lib/telemetry/spikeAttribution");
const { buildTelemetryView } = require("../../lib/observer/builtinViews");

const WALL_BASE = Date.UTC(2026, 10, 1, 10, 0, 0);

function realAttribution() {
  let perf = 0;
  const lines = [];
  const attr = createSpikeAttribution({ thresholdMs: 100, perfNow: () => perf, wallNow: () => WALL_BASE + perf,
    log: (line) => {
      lines.push(line);
      return true;
    } });
  attr.onTick({ workMs: 10, intervalMs: 50, latenessMs: 0, atMs: 1000 });
  attr.onTick({ workMs: 20, intervalMs: 400, latenessMs: 300, atMs: 1400 });
  attr.noteGc("major", 1100, 30);
  perf = 1500;
  attr.resolve(perf);
  perf = 1600;
  attr.resolve(perf);
  return { status: attr.getStatus(), lines };
}

function routerEnvelope(snapshot) {
  const view = buildTelemetryView({ ctx: { telemetry: { getSnapshot: () => snapshot } } });
  const dataJson = JSON.stringify(view.getData());
  return JSON.parse(`{"ok":true,"id":"telemetry","title":"Telemetry","generatedAtMs":1,"cached":false,`
    + `"stale":false,"data":${dataJson}}`);
}

function sample(overrides) {
  return { type: "sample", utc: new Date(WALL_BASE).toISOString(), monoMs: 0, intervalStartMonoMs: 0,
    intervalEndMonoMs: 1000, gapMs: 1000, lagMs: 0, wallGapMs: 1000, cpuUserMs: 10, cpuSystemMs: 2,
    eventLoop: { utilization: 0.1, delayP99Ms: 1, delayMaxMs: 2 },
    resourceDelta: { fsRead: 0, fsWrite: 0, minorPageFault: 0, majorPageFault: 0, voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0 }, ...overrides };
}

function quiet(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  return Promise.resolve().then(fn).finally(() => {
    console.log = log;
    console.error = err;
  });
}

function serveOnce(body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

module.exports = ({ test }) => {
  test("R1 restDiagnosis: telemetry reads real getStatus() in the router envelope and the bare snapshot", () => {
    const { status } = realAttribution();
    const snapshot = { schemaVersion: 1, seq: 7, spikes: status };
    for (const input of [routerEnvelope(snapshot), snapshot]) {
      const r = analyzeTelemetrySpikes(input);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.total, 1);
      assert.deepStrictEqual(r.rows, [{ source: "unattributed", count: 1, pct: 100 }]);
      assert.strictEqual(r.last.source, "unattributed");
      assert.strictEqual(r.last.restMs, 270);
      assert.strictEqual(r.last.gcMs, 30);
    }
  });

  test("R2 restDiagnosis: unknown shape / spikes off / telemetry off -> refusal and exit 1", async () => {
    const fake = { ok: true, snapshot: { spikes: [{ source: "unattributed", restMs: 100 }] } };
    assert.strictEqual(analyzeTelemetrySpikes(fake).reason, REASONS.UNKNOWN_SHAPE);
    assert.strictEqual(analyzeTelemetrySpikes({ ok: true, data: { foo: 1 } }).reason, REASONS.UNKNOWN_SHAPE);
    assert.strictEqual(analyzeTelemetrySpikes(routerEnvelope({ seq: 1, spikes: null })).reason,
      REASONS.SPIKES_DISABLED);
    assert.strictEqual(analyzeTelemetrySpikes({ ok: true, data: { available: false, reason: "telemetry_disabled" } })
      .reason, REASONS.TELEMETRY_UNAVAILABLE);

    const bad = await serveOnce({ ok: true, data: { available: true, snapshot: fake.snapshot } });
    const good = await serveOnce(routerEnvelope({ seq: 1, spikes: realAttribution().status }));
    try {
      const codes = await quiet(async () => [
        await main(["node", "x", "--telemetry", "--host", "127.0.0.1", "--port", String(bad.address().port)]),
        await main(["node", "x", "--telemetry", "--json", "--host", "127.0.0.1", "--port",
          String(good.address().port)]),
      ]);
      assert.deepStrictEqual(codes, [1, 0]);
    } finally {
      bad.close();
      good.close();
    }
  });

  test("R3 restDiagnosis: the real spike line parses and sums per component", () => {
    const { lines } = realAttribution();
    assert.strictEqual(lines.length, 1);
    const text = `server-1  | noise\nserver-1  | [LivingNewEden] ${lines[0]}\r\n`;
    const spikes = parseSpikeLog(text);
    assert.strictEqual(spikes.length, 1);
    assert.deepStrictEqual(spikes[0], { intervalMs: 400, atWallMs: WALL_BASE + 1400, source: "unattributed",
      tickWorkMs: 10, gcMs: 30, lneMs: 0, restMs: 270 });
    const s = summarizeSpikeLog([...spikes, { ...spikes[0], restMs: 30, gcMs: 0, source: "gc" }]);
    assert.strictEqual(s.lines, 2);
    assert.strictEqual(s.restMs, 300);
    assert.strictEqual(s.bySource.unattributed, 1);
    assert.strictEqual(s.rows.reduce((a, r) => a + r.totalMs, 0), s.total);
  });

  test("R4 restDiagnosis: profile lag split disjointly; Windows null -> no db signal", () => {
    const events = [
      sample({ lagMs: 80, intervalStartMonoMs: 0, intervalEndMonoMs: 1080, cpuUserMs: 900,
        resourceDelta: { fsRead: 3, fsWrite: 1, majorPageFault: 5, involuntaryContextSwitches: 40 } }),
      { type: "gc", endMonoMs: 500, totalDurationMs: 20 },
      sample({ lagMs: 60, intervalStartMonoMs: 1080, intervalEndMonoMs: 2140, cpuUserMs: 900 }),
      sample({ type: "stall", lagMs: 1200, intervalStartMonoMs: 2140, intervalEndMonoMs: 4340,
        resourceDelta: { fsRead: 0, fsWrite: 0, majorPageFault: null, involuntaryContextSwitches: null } }),
    ];
    const agg = aggregateFromPauseProfile(events);
    const byCause = Object.fromEntries(agg.rows.map((r) => [r.cause, r.totalMs]));
    assert.deepStrictEqual(byCause, { gc: 20, io: 60, cpu: 60, offCpu: 1200 });
    assert.strictEqual(agg.totalLag, 80 + 60 + 1200);
    assert.strictEqual(agg.dbSignalAvailable, false);
    const win = classifySample(events[3]);
    assert.strictEqual(win.dbSignal, false);
    assert.strictEqual(win.cause, "offCpu");
    assert.strictEqual(classifySample(sample({ lagMs: 10, resourceDelta: { majorPageFault: 4 } })).cause, "db");
  });

  test("R5 restDiagnosis: rest of spikes goes to the overlapping profile sample, rows sum to total rest", () => {
    const spikes = parseSpikeLog(realAttribution().lines[0]);
    spikes.push({ intervalMs: 300, atWallMs: null, source: "unattributed", tickWorkMs: 0, gcMs: 0, lneMs: 0,
      restMs: 50 });
    const events = [
      sample({ utc: new Date(WALL_BASE + 1300).toISOString(), resourceDelta: { fsWrite: 2 } }),
      sample({ utc: new Date(WALL_BASE + 2300).toISOString(), cpuUserMs: 900 }),
    ];
    const r = correlateRestWithProfile(spikes, events);
    const byCause = Object.fromEntries(r.rows.map((row) => [row.cause, row.totalMs]));
    assert.deepStrictEqual(byCause, { io: 270, unmatched: 50 });
    assert.strictEqual(r.totalRest, 320);
    assert.strictEqual(r.matched, 1);
  });

  test("restDiagnosis: formatTable produces markdown table", () => {
    const rows = [
      { cause: "io", count: 10, totalMs: 500, p95: 80, maxMs: 120 },
      { cause: "cpu", count: 5, totalMs: 200, p95: 60, maxMs: 90 },
    ];
    const table = formatTable(rows, 700);
    assert(table.includes("| cause | count | totalMs | p95 | maxMs | %rest |"), "has header");
    assert(table.includes("| io | 10 | 500 | 80 | 120 | 71.4 |"), "has io row");
    assert(table.includes("| cpu | 5 | 200 | 60 | 90 | 28.6 |"), "has cpu row");
    assert(table.includes("| TOTAL | 15 | 700 | - | - | 100.0 |"), "has total row");
  });

  test("restDiagnosis: parsePauseProfileEvents skips malformed lines", () => {
    const content = "{\"type\":\"sample\",\"lagMs\":10}\r\nnot json\n{\"type\":\"stall\",\"lagMs\":20}\n";
    const tmp = path.join(os.tmpdir(), `lne-pause-test-${process.pid}.jsonl`);
    fs.writeFileSync(tmp, content);
    try {
      const parsed = parsePauseProfileEvents(tmp);
      assert.strictEqual(parsed.length, 2, "parses 2 valid lines, skips 1 invalid");
      assert.strictEqual(parsed[0].lagMs, 10);
      assert.strictEqual(parsed[1].lagMs, 20);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
};
