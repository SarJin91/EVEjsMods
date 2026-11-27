"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSnapshot } = require("../../lib/telemetry/snapshot");
const { extractRow } = require("../../tools/scaling/extract");
const agg = require("../../tools/scaling/aggregate");
const { renderMarkdown } = require("../../tools/scaling/render");
const tool = require("../../tools/scalingBench");

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const STEP_MS = 10000;
const SPAN_MS = 300000;
const MB = 1024 * 1024;

function summary(p95, extra) {
  return { samples: 3000, capacity: 3000, spanMs: SPAN_MS, avg: p95 * 0.9, p50: p95 * 0.9, p95, max: p95 * 2,
    ...(extra || {}) };
}

function telemetryState(over) {
  return {
    seq: 42, capturedAtMs: T0, startedAtMs: T0 - 900000, intervalMs: 10000, histogramSamples: 3000,
    status: { snapshotWrite: "ok" },
    process: { pid: 7, uptimeSeconds: 900, rssBytes: 4000 * MB, heapUsedBytes: 3000 * MB, heapTotalBytes: 3300 * MB,
      externalBytes: 10 * MB, cpu: { sampleWindowMs: 10000, userPercentOfOneCore: 40, systemPercentOfOneCore: 5,
        eventLoopUtilizationPercent: 55 } },
    metrics: {
      counters: { "scheduler.completed": 500, "scheduler.passes": 90, "journal.duplicates": 0 },
      gauges: { "scheduler.dueBacklog": 12 },
      histograms: { "tick.intervalMs": summary(104.7), "scheduler.passMs": summary(8) },
    },
    tick: { sceneCount: 3, tickedSceneCount: 3, samplesTotal: 9000, lastSampleAgeMs: 50, wrapErrors: 0 },
    gcKinds: { major: { count: 3, totalMs: 600, maxMs: 250 }, minor: { count: 900, totalMs: 4000, maxMs: 30 } },
    capture: { lastWriteMs: 2, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: "/x/latest.json" },
    governor: { mode: "NORMAL", changes: 0, counts: { emergencySamples: 0, unplayableSamples: 0 } },
    spikes: { enabled: true, bySource: { lne: 0, gc: 1, evejsTick: 2, unattributed: 0 } },
    ...(over || {}),
  };
}

function row(i, o) {
  const opts = o || {};
  const r = {
    seq: 1000 + i,
    capturedAtMs: T0 + i * STEP_MS,
    startedAtMs: opts.startedAtMs || T0 - 900000,
    "process.uptimeSeconds": opts.uptime === undefined ? 900 + i * 10 : opts.uptime,
    "process.rssBytes": 4000 * MB,
    "process.heapUsedBytes": 3000 * MB,
    "process.cpu.eventLoopUtilizationPercent": 50,
    "tick.intervalMs.spanMs": SPAN_MS,
    "tick.intervalMs.p95": opts.p95 === undefined ? 100 : opts.p95,
    "tick.intervalMs.max": 200,
    "channels.scheduler.dueBacklog": opts.backlog === undefined ? 100 : opts.backlog,
    "channels.scheduler.completed": opts.completed === undefined ? 10 * i : opts.completed,
    "channels.scheduler.passes": i,
    "channels.scheduler.quarantined": opts.quarantined === undefined ? 0 : opts.quarantined,
    "journal.duplicates": opts.duplicates === undefined ? 0 : opts.duplicates,
    "governor.mode": "NORMAL",
    alarms: [],
  };
  if (opts.rssMb !== undefined) r["process.rssBytes"] = opts.rssMb * MB;
  if (opts.pass !== undefined) {
    r["channels.scheduler.passMs.p95"] = opts.pass;
    r["channels.scheduler.passMs.spanMs"] = opts.passSpan === undefined ? 0 : opts.passSpan;
    r["channels.scheduler.passMs.samples"] = opts.passSamples === undefined ? 50 : opts.passSamples;
  }
  if (opts.lateness !== undefined) {
    r["channels.scheduler.lateness.p95"] = opts.lateness;
    r["channels.scheduler.lateness.spanMs"] = 0;
    r["channels.scheduler.lateness.samples"] = 50;
  }
  if (opts.budgetExhausted !== undefined) r["channels.scheduler.budgetExhausted"] = opts.budgetExhausted;
  return r;
}

function rows(n, fn) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(row(i, fn ? fn(i) : undefined));
  return out;
}

function header(label, axis, benchFleets) {
  return { type: "header", tool: "scalingBench", format: 1, label, axis, benchFleets, demoMultiplier: 1, note: "",
    file: "/x/latest.json", startedAtMs: T0 };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lne-scaling-"));
}

function silentIo(extra) {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s), env: {},
    onSigint() {}, offSigint() {}, ...(extra || {}) } };
}

module.exports = ({ test }) => {
  test("SB1 scalingBench extract: real buildSnapshot -> row fields, absent channel null, schemaVersion 2 refused", () => {
    const snap = buildSnapshot(telemetryState());
    const r = extractRow(JSON.parse(JSON.stringify(snap)));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const got = {
      p95: r.row["tick.intervalMs.p95"], span: r.row["tick.intervalMs.spanMs"], rss: r.row["process.rssBytes"],
      uptime: r.row["process.uptimeSeconds"], backlog: r.row["channels.scheduler.dueBacklog"],
      completed: r.row["channels.scheduler.completed"], passP95: r.row["channels.scheduler.passMs.p95"],
      mode: r.row["governor.mode"], majorCount: r.row["gc.kinds.major.count"], gcLne: r.row["spikes.bySource.gc"],
      liveShips: r.row["channels.materialization.liveShips"], spawn: r.row["channels.materialization.spawnMs.p95"],
      seq: r.row.seq, startedAtMs: r.row.startedAtMs,
    };
    assert.deepStrictEqual(got, { p95: 104.7, span: SPAN_MS, rss: 4000 * MB, uptime: 900, backlog: 12, completed: 500,
      passP95: 8, mode: "NORMAL", majorCount: 3, gcLne: 1, liveShips: null, spawn: null, seq: 42,
      startedAtMs: T0 - 900000 });
    const bare = extractRow(JSON.parse(JSON.stringify(buildSnapshot(telemetryState({ governor: null, spikes: null })))));
    assert.strictEqual(bare.ok, true);
    assert.deepStrictEqual([bare.row["governor.mode"], bare.row["spikes.bySource.lne"]], [null, null]);
    assert.deepStrictEqual(extractRow({ ...snap, schemaVersion: 2 }), { ok: false, reason: "SCHEMA_UNSUPPORTED" });
    assert.deepStrictEqual(extractRow([]), { ok: false, reason: "NOT_A_SNAPSHOT" });
  });

  test("SB2 scalingBench aggregate: windows, verdict bounds, warm-up, restart segments, backlog flag, safety FAIL", () => {
    const stage = rows(91);
    assert.deepStrictEqual(agg.pickWindows(stage, "tick.intervalMs").map((r) => r.seq), [1000, 1030, 1060, 1090]);
    const th = agg.DEFAULT_THRESHOLDS;
    assert.deepStrictEqual([119.9, 120, 129.9, 130, null].map((p) => agg.verdictOf(p, th)),
      ["OK", "WARN", "WARN", "FAIL", "NO_DATA"]);

    const warm = rows(101, (i) => (i < 10 ? { uptime: 500 + i * 10, p95: 900 } : { uptime: 600 + (i - 10) * 10 }));
    const sw = agg.summarizeStage(header("S2", "base", 0), warm, th, { type: "footer" });
    assert.deepStrictEqual([sw.rows, sw.measuredRows, sw.verdict, sw.tick.p95Median, sw.interrupted],
      [101, 91, "OK", 100, false]);

    const restart = rows(91, (i) => (i < 46 ? { completed: 10 * i }
      : { startedAtMs: T0 + 500000, completed: 5 + 10 * (i - 46), uptime: 900 + (i - 46) * 10 }));
    assert.deepStrictEqual(agg.counterDelta(restart, "channels.scheduler.completed"), { delta: 450 + 440, segments: 2 });
    const sr = agg.summarizeStage(header("S3", "virtual", 100), restart, th, null);
    assert.deepStrictEqual([sr.restarts, sr.interrupted], [1, true]);

    const growing = agg.summarizeStage(header("g", "virtual", 100), rows(91, (i) => ({ backlog: 100 + 2 * i })), th, null);
    const flat = agg.summarizeStage(header("f", "virtual", 100), rows(91), th, null);
    assert.deepStrictEqual([growing.flags, growing.verdict, flat.flags, flat.verdict],
      [["BACKLOG_GROWING"], "WARN", [], "OK"]);

    const q = agg.summarizeStage(header("q", "virtual", 100), rows(91, (i) => ({ quarantined: i < 50 ? 0 : 1 })), th, null);
    assert.deepStrictEqual([q.tick.p95Median, q.safety.quarantinedDelta, q.flags, q.verdict],
      [100, 1, ["QUARANTINED"], "FAIL"]);

    const dupRows = rows(91, (i) => ({ duplicates: 3 * i }));
    const d = agg.summarizeStage(header("d", "virtual", 100), dupRows, th, null);
    assert.deepStrictEqual([d.safety.duplicatesDelta, d.flags, d.verdict, d.safety.audit], [270, [], "OK", null]);
    const audited = (n) => agg.auditSummaryOf({ tool: "auditWorldDb", findings: [
      { id: "duplicateKeys", severity: "ERROR", count: 0, sample: [] },
      { id: "duplicateSettlements", severity: "ERROR", count: n, sample: [] }] });
    assert.deepStrictEqual(audited(2), { ok: true, duplicateSettlements: 2, errors: 1 });
    const bad = agg.summarizeStage(header("d", "virtual", 100), dupRows, th, null, { file: "a.json", ...audited(2) });
    assert.deepStrictEqual([bad.flags, bad.verdict, bad.safety.audit.duplicateSettlements],
      [["AUDIT_DUPLICATE_SETTLEMENTS"], "FAIL", 2]);
    const clean = agg.summarizeStage(header("d", "virtual", 100), dupRows, th, null, { file: "a.json", ...audited(0) });
    assert.deepStrictEqual([clean.flags, clean.verdict], [[], "OK"]);
    assert.deepStrictEqual([agg.auditSummaryOf({ tool: "x", findings: [] }).reason,
      agg.auditSummaryOf({ tool: "auditWorldDb", findings: [] }).reason], ["NOT_AN_AUDIT", "NO_DUPLICATE_SETTLEMENTS"]);
  });

  test("SB3 scalingBench report: lastOk / stoppedAt / candidate via the CLI, no --ai-fleets note, stable Markdown",
    async () => {
      const dir = tmpDir();
      try {
        const files = [];
        const stages = [["S1", "control", 0, 90], ["S2", "base", 0, 100], ["S3", "virtual", 200, 110],
          ["S4", "virtual", 600, 125]];
        for (const [label, axis, bench, p95] of stages) {
          const f = path.join(dir, `${label}.jsonl`);
          const lines = [header(label, axis, bench), ...rows(91, () => ({ p95 })).map((r) => ({ type: "row", ...r })),
            { type: "footer", rows: 91, readErrors: 0, unchangedReads: 0, endedAtMs: T0 + 900000 }];
          fs.writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
          files.push("--in", f);
        }
        const jsonOut = path.join(dir, "table.json");
        const mdOut = path.join(dir, "table.md");
        const a = silentIo({});
        const code = await tool.main(["report", ...files, "--ai-fleets", "180", "--json", jsonOut, "--md", mdOut], a.io);
        assert.strictEqual(code, 0, a.lines.err.join("\n"));
        const report = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
        assert.deepStrictEqual(report.stages.map((s) => s.verdict), ["OK", "OK", "OK", "WARN"]);
        assert.deepStrictEqual(
          { lastOk: report.recommendation.lastOk, stoppedAt: report.recommendation.stoppedAt,
            candidate: report.recommendation.candidateMaxVirtualFleets },
          { lastOk: "S3", stoppedAt: "S4", candidate: Math.floor((180 + 200) / 2) });
        assert.strictEqual(renderMarkdown(report), renderMarkdown(JSON.parse(JSON.stringify(report))));
        assert.strictEqual(fs.readFileSync(mdOut, "utf8"), renderMarkdown(report));

        const b = silentIo({});
        assert.strictEqual(await tool.main(["report", ...files, "--json", jsonOut], b.io), 0);
        const noAi = JSON.parse(fs.readFileSync(jsonOut, "utf8")).recommendation;
        assert.strictEqual(noAi.candidateMaxVirtualFleets, null);
        assert.ok(noAi.notes.some((n) => n.includes("--ai-fleets")), JSON.stringify(noAi.notes));
        assert.ok(noAi.notes.some((n) => n.startsWith("S2: no audit")), JSON.stringify(noAi.notes));

        const auditFile = path.join(dir, "S3-audit.json");
        fs.writeFileSync(auditFile, JSON.stringify({ tool: "auditWorldDb", formatVersion: 1, findings: [
          { id: "duplicateSettlements", severity: "ERROR", count: 1, sample: [] }] }));
        const c = silentIo({});
        assert.strictEqual(await tool.main(["report", ...files, "--audit", `S3=${auditFile}`, "--json", jsonOut], c.io),
          0, c.lines.err.join("\n"));
        const withAudit = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
        assert.deepStrictEqual([withAudit.stages.map((s) => s.verdict), withAudit.recommendation.lastOk,
          withAudit.recommendation.stoppedAt], [["OK", "OK", "FAIL", "WARN"], "S2", "S3"]);
        const e = silentIo({});
        assert.strictEqual(await tool.main(["report", ...files, "--audit", `S9=${auditFile}`], e.io), 1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

  test("SB4 scalingBench sampler: unchanged seq, read errors go on, footer at the end; CLI usage exits", async () => {
    const snap = (seq) => JSON.stringify({ schemaVersion: 1, seq, capturedAtMs: T0 + seq });
    const reads = [() => snap(1), () => snap(1), () => {
      const e = new Error("ENOENT: no such file");
      e.code = "ENOENT";
      throw e;
    }, () => "{bad", () => snap(2), () => JSON.stringify({ schemaVersion: 2, seq: 3 })];
    let clock = 0;
    let n = 0;
    const written = [];
    const result = await tool.sampleLoop({
      readFile: async () => reads[n++](),
      appendLine: (line) => written.push(line),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      file: "/x/latest.json", everyMs: 10000, durationMs: 50000,
      header: { label: "S2", axis: "base", benchFleets: 0, demoMultiplier: 1, note: "" },
    });
    assert.deepStrictEqual(result, { rows: 2, readErrors: 3, unchangedReads: 1 });
    const types = written.map((l) => JSON.parse(l));
    assert.deepStrictEqual(types.map((o) => o.type), ["header", "row", "row", "footer"]);
    assert.deepStrictEqual([n, types[1].seq, types[2].seq, types[3].rows, types[3].endedAtMs, types[0].label],
      [6, 1, 2, 2, 50000, "S2"]);

    const dir = tmpDir();
    try {
      const a = silentIo({});
      assert.strictEqual(await tool.main(["sample", "--axis", "base", "--minutes", "1",
        "--out", path.join(dir, "x.jsonl")], a.io), 1);
      assert.ok(a.lines.err[0].includes("--label"), a.lines.err.join("\n"));
      const existing = path.join(dir, "S2.jsonl");
      fs.writeFileSync(existing, "keep\n");
      const b = silentIo({});
      assert.strictEqual(await tool.main(["sample", "--label", "S2", "--axis", "base", "--minutes", "1",
        "--out", existing], b.io), 1);
      assert.strictEqual(fs.readFileSync(existing, "utf8"), "keep\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SB6 scalingBench aggregate: channel p95 without spanMs -> median of rows, windows first, tick verdict"
    + " windows only, budgetExhaustedShare", () => {
    const th = agg.DEFAULT_THRESHOLDS;
    const mixed = rows(12, (i) => (i < 9 ? { pass: 10 * (i + 1), lateness: 1000 * (i + 1) }
      : { pass: 999, passSamples: 0 }));
    const s = agg.summarizeStage(header("S2", "base", 0), mixed, th, null);
    assert.deepStrictEqual([s.scheduler.passP95Median, s.scheduler.passP95Source, s.scheduler.latenessP95Median,
      s.scheduler.latenessP95Source, s.tick.workP95Median, s.tick.workP95Source],
    [50, "rows", 5000, "rows", null, null]);
    assert.deepStrictEqual(agg.p95Median(mixed, "channels.scheduler.passMs"), { value: 50, source: "rows" });
    const spanned = rows(9, (i) => ({ pass: 10 * (i + 1), passSpan: SPAN_MS }));
    assert.deepStrictEqual(agg.p95Median(spanned, "channels.scheduler.passMs"), { value: 10, source: "windows" });
    const noTick = rows(9, (i) => ({ pass: 10 * (i + 1) }));
    for (const r of noTick) delete r["tick.intervalMs.spanMs"];
    const nd = agg.summarizeStage(header("S3", "virtual", 100), noTick, th, null);
    assert.deepStrictEqual([nd.verdict, nd.windows, nd.scheduler.passP95Source], ["NO_DATA", 0, "rows"]);
    const busy = agg.summarizeStage(header("S4", "virtual", 100),
      rows(101, (i) => ({ budgetExhausted: Math.min(i, 99) })), th, null);
    assert.strictEqual(busy.scheduler.budgetExhaustedShare, 0.99);
  });

  test("SB7 scalingBench report: RSS_GROWING against the instrument baseline, none -> absolute, longrun unchanged,"
    + " unknown baseline exit 1", async () => {
    const dir = tmpDir();
    try {
      const write = (label, axis, bench, mbPerHour) => {
        const f = path.join(dir, `${label}.jsonl`);
        const lines = [header(label, axis, bench),
          ...rows(91, (i) => ({ rssMb: 4000 + (mbPerHour * i * STEP_MS) / 3600000 })).map((r) => ({ type: "row", ...r })),
          { type: "footer", rows: 91, readErrors: 0, unchangedReads: 0, endedAtMs: T0 + 900000 }];
        fs.writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
        return ["--in", f];
      };
      const files = [...write("S0", "instrument", 0, 800), ...write("S2", "base", 0, 500),
        ...write("S3", "virtual", 200, 1000)];
      const jsonOut = path.join(dir, "table.json");
      const run = async (extra) => {
        const a = silentIo({});
        const code = await tool.main(["report", ...extra, "--json", jsonOut], a.io);
        return { code, err: a.lines.err.join("\n"),
          report: code === 0 ? JSON.parse(fs.readFileSync(jsonOut, "utf8")) : null };
      };
      const view = (rep) => rep.stages.map((s) => [s.label, s.verdict, s.flags.includes("RSS_GROWING"),
        s.memory.rssFlagMode, s.memory.rssBaselineLabel, s.memory.rssFlagThresholdMbPerHour]);
      const rel = await run(files);
      assert.strictEqual(rel.code, 0, rel.err);
      assert.deepStrictEqual(view(rel.report), [
        ["S0", "WARN", true, "absolute", null, 100],
        ["S2", "OK", false, "baseline", "S0", 900],
        ["S3", "WARN", true, "baseline", "S0", 900]]);
      assert.deepStrictEqual(rel.report.rssBaseline, { mode: "baseline", label: "S0", slopeMbPerHour: 800 });

      const none = await run([...files, "--rss-baseline", "none"]);
      assert.deepStrictEqual(none.report.stages.map((s) => s.verdict), ["WARN", "WARN", "WARN"]);
      assert.strictEqual(none.report.rssBaseline.mode, "absolute");

      const lr = await run([...write("LR-A", "base", 0, 500), ...write("LR-B", "base", 0, 500)]);
      assert.deepStrictEqual(lr.report.stages.map((s) => [s.verdict, s.flags, s.memory.rssFlagMode]),
        [["WARN", ["RSS_GROWING"], "absolute"], ["WARN", ["RSS_GROWING"], "absolute"]]);
      assert.deepStrictEqual(lr.report.rssBaseline, { mode: "absolute", label: null, slopeMbPerHour: null });

      const unknown = await run([...files, "--rss-baseline", "S9"]);
      assert.strictEqual(unknown.code, 1);
      assert.ok(unknown.err.includes("--rss-baseline"), unknown.err);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SB8 scalingBench fleets: live fleets from the audit, column and notes, saturation note", () => {
    const th = agg.DEFAULT_THRESHOLDS;
    const findings = [{ id: "duplicateSettlements", severity: "ERROR", count: 0, sample: [] }];
    const withGrowth = agg.auditSummaryOf({ tool: "auditWorldDb", findings,
      growth: { fleets: { byState: { DESTROYED: 175, IDLE: 1286, ENGAGED: 298 } } } });
    assert.deepStrictEqual([withGrowth.liveFleets, withGrowth.destroyedFleets], [1584, 175]);
    const bare = agg.auditSummaryOf({ tool: "auditWorldDb", findings });
    assert.deepStrictEqual([bare.liveFleets ?? null, bare.destroyedFleets ?? null], [null, null]);
    assert.deepStrictEqual([agg.auditSummaryOf({ tool: "x", findings: [] }).reason,
      agg.auditSummaryOf({ tool: "auditWorldDb", findings: [] }).reason], ["NOT_AN_AUDIT", "NO_DUPLICATE_SETTLEMENTS"]);

    const stage = (audit, budget) => agg.summarizeStage(header("S5", "virtual", 1750),
      rows(101, (i) => ({ budgetExhausted: Math.round(i * budget) })), th, null, audit);
    const audited = stage({ file: "S5-audit.json", ...withGrowth }, 0.99);
    assert.deepStrictEqual(audited.fleets, { live: 1584, destroyed: 175 });
    const md = (s) => renderMarkdown({ thresholds: th, aiFleets: 218, stages: [s],
      recommendation: agg.recommend([s], { aiFleets: 218, thresholds: th }) });
    const line = (s) => md(s).split("\n").find((l) => l.startsWith("| S5 "));
    assert.ok(line(audited).includes("| 1584 (218 + 1750 nom.) |"), line(audited));
    const notes = agg.recommend([audited], { aiFleets: 218, thresholds: th }).notes;
    assert.ok(notes.includes("S5: live fleets 1584 != nominal 1968 (audit)"), JSON.stringify(notes));
    assert.ok(notes.some((n) => n.startsWith("S5: scheduler budget exhausted in 99 %") && n.includes("saturated")),
      JSON.stringify(notes));

    const plain = stage(null, 0.5);
    assert.deepStrictEqual(plain.fleets, { live: null, destroyed: null });
    assert.ok(line(plain).includes("| 218 + 1750 |"), line(plain));
    assert.ok(!agg.recommend([plain], { aiFleets: 218, thresholds: th }).notes.some((n) => n.includes("saturated")));
  });
};
