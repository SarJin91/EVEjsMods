"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSnapshot } = require("../../lib/telemetry/snapshot");
const { extractRow, PROFILE_KEYS } = require("../../tools/measure/populationGate/extract");
const { resolveConfig } = require("../../config");
const { THRESHOLDS, summarizePhase, verdict } = require("../../tools/measure/populationGate/aggregate");
const { decodeLog, scanSlowLines } = require("../../tools/measure/populationGate/logScan");
const { main } = require("../../tools/measure/populationGateReport");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const MB = 1024 * 1024;
const WARM_S = 600;

const PROFILE_A = Object.freeze({ "population.enabled": true, "population.size": 10000,
  "population.gateWarmupMs": 600000, "population.passIntervalMs": 1000, "population.flushRowsPerSlice": 1000,
  "population.near.enabled": false, "population.live.localEnabled": false, "population.live.trafficEnabled": false,
  "population.context.enabled": true, "highsecLife.enabled": true, "highsecLife.civilians.enabled": true,
  "highsecLife.traffic.enabled": true, "highsecLife.traffic.maxShipsGlobal": 12,
  "highsecLife.traffic.maxShipsPerSystem": 4, "localPilots.enabled": true, "telemetry.histogramSamples": 3000 });
const PROFILE_B = Object.freeze({ ...PROFILE_A, "population.near.enabled": true, "population.live.localEnabled": true,
  "population.live.trafficEnabled": true });
const PROFILE_0 = Object.freeze({ ...PROFILE_A, "population.enabled": false });

const hist = (name, samples, p95, max) => ({ [`channels.population.${name}.samples`]: samples,
  [`channels.population.${name}.capacity`]: 3000, [`channels.population.${name}.p95`]: p95,
  [`channels.population.${name}.max`]: max });

function phaseRows(label, opts = {}) {
  const minutes = opts.minutes || (label === "B" ? 65 : 125);
  const profile = opts.profile || (label === "B" ? PROFILE_B : label === "A" ? PROFILE_A : PROFILE_0);
  const ratePerHour = opts.modeChangesPerHour === undefined ? 1 : opts.modeChangesPerHour;
  const measured = label !== "0";
  const n = minutes;
  const rows = [];
  for (let i = 0; i <= n; i += 1) {
    const up = i * 60;
    const steady = up >= WARM_S;
    const views = i % 5 === 0 || i === n;
    const row = { type: "row", seq: i + 1, capturedAtMs: T0 + up * 1000, startedAtMs: T0, "process.pid": 100,
      "process.uptimeSeconds": up, "process.heap.afterMajor.lastUsedBytes": opts.heap || 4400 * MB,
      "gc.kinds.major.count": i, "gc.kinds.major.maxMs": 40, "governor.mode": "NORMAL",
      "channels.governor.modeChanges": (ratePerHour * up) / 3600, rejectedNames: [], alarms: [],
      "views.status": views, "views.population": views && measured,
      "status.services.population.state": views ? (measured ? "running" : "disabled") : null };
    if (views) for (const [k, v] of Object.entries(profile)) row[`status.config.${k}`] = v;
    if (measured) {
      Object.assign(row, hist("passMs", steady ? Math.min(3000, up - WARM_S) : 0, 2, 8),
        hist("warmupPassMs", Math.min(up, WARM_S), 9, 30),
        hist("flushMs", steady ? Math.floor((up - WARM_S) / 60) : 0, 9, 30),
        hist("contextMs", 10, 3, 5), hist("routeMs", 100, 0.1, 0.5),
        { "channels.population.lagMs": 1000, "channels.population.queue": 10000, "channels.population.dirty": 300,
          "memory.approxBytes": 4 * MB, "memory.entries": 20000 });
      if (views) {
        Object.assign(row, { "populationView.counters.flushFailed": 0, "populationView.counters.stationsReadFailed": 0,
          "populationView.counters.seeded": 10000, "populationView.counters.live.claimed": label === "B" ? 20 : 0 });
      }
    }
    if (label === "B") {
      Object.assign(row, { "channels.highsecLife.trafficLive": 6, "channels.highsecLife.trafficPilotShips": 3,
        "channels.highsecLife.trafficPilotDuplicates": 0, "channels.highsecLife.trafficMaxPerSystem": 3,
        "channels.population.liveOwned": 3 });
    }
    if (opts.over) Object.assign(row, opts.over(i, up) || {});
    rows.push(row);
  }
  return rows;
}

const phase = (label, opts = {}) => ({ label, header: { type: "header" }, rows: phaseRows(label, opts), footer: null,
  logText: label === "0" ? null : (opts.logText === undefined ? "" : opts.logText) });
const checkOf = (s, name) => s.checks.find((c) => c.name === name);
const iso = (ms) => new Date(ms).toISOString().replace("Z", "123456Z");

const PROFILE_L = Object.freeze({ ...PROFILE_A, "population.standings.enabled": true, "population.corps.enabled": true,
  "population.lifecycle.enabled": true, "population.lifecycle.careerEnabled": true,
  "population.lifecycle.corpsActivityEnabled": true });
const PROFILE_N = Object.freeze({ ...PROFILE_L, "population.lifecycle.enabled": false });

function tempoPhase(opts = {}) {
  const days = opts.days || 26;
  const open = opts.openEnd === undefined ? 30 : opts.openEnd;
  const rows = [];
  for (let i = 0; i <= days * 12; i += 1) {
    const day = i / 12;
    const row = { type: "row", seq: i + 1, capturedAtMs: T0 + i * 72000, startedAtMs: T0, "process.pid": 100,
      "process.uptimeSeconds": i * 72, "process.heap.afterMajor.lastUsedBytes": 4400 * MB, "governor.mode": "NORMAL",
      "channels.governor.modeChanges": 0, rejectedNames: [], alarms: [], "views.status": true,
      "views.population": true, "status.services.population.state": "running", "channels.population.lagMs": 1000,
      "channels.population.pilots": 10000, "memory.approxBytes": 4 * MB, "channels.population.passMs.p95": 30,
      "channels.population.passMs.max": 50, "populationView.generatedAt": T0 + i * 2 * 3600000,
      "populationView.lifecycle": true,
      "populationView.lifecycle.awayPermille": day >= 22 ? (opts.away || 160) : Math.round(day * 7),
      "populationView.counters.lifecycle.reborn": 15 * day, "populationView.counters.lifecycle.wakeFailed": 0,
      "populationView.counters.lifecycle.rookieFallback": 0, "populationView.counters.lifecycle.awayCapped": 0,
      "populationView.counters.corps.skippedInactive": 3 * i,
      "populationView.lifecycle.byCareer.UNASSIGNED": 0, "populationView.lifecycle.byCareer.ROOKIE": 2000,
      "populationView.lifecycle.byCareer.PILOT": 5000, "populationView.lifecycle.byCareer.SEASONED": 2000,
      "populationView.lifecycle.byCareer.VETERAN": 1000,
      "populationView.lifecycle.corps.open": 40 - ((40 - open) * day) / days };
    for (const [k, v] of Object.entries(PROFILE_L)) row[`status.config.${k}`] = v;
    if (opts.over) Object.assign(row, opts.over(i, day) || {});
    rows.push(row);
  }
  return { label: "T", header: { type: "header" }, rows, footer: null, logText: null };
}

function lifePhase(label, opts = {}) {
  const lc = label === "L";
  return phase(label, { minutes: 45, profile: lc ? PROFILE_L : PROFILE_N, logText: opts.logText,
    over: (i, up) => ({ "populationView.generatedAt": T0 + up * 1000, "populationView.lifecycle": lc,
      "populationView.byState.AWAY": lc ? 40 : (opts.awayN === undefined ? null : opts.awayN),
      "populationView.counters.lifecycle.wakeFailed": 0, "populationView.counters.lifecycle.awayCapped": 0,
      "populationView.counters.loadNormalized": lc ? 0 : 5,
      ...(opts.p95 === undefined ? {} : { "channels.population.passMs.p95": opts.p95 }) }) });
}

module.exports = ({ test }) => {
  test("PG1 summarizePhase: warm-up outside the thresholds, passMs / flushMs / lagMs rules, FAIL and INCOMPLETE", () => {
    const a = summarizePhase(phase("A", { over: (i, up) => (up === 300 ? hist("passMs", 700, 9, 19)
      : i % 7 === 3 ? { "governor.mode": "OVERLOADED", "channels.population.lagMs": 99999 } : null) }), THRESHOLDS);
    assert.deepStrictEqual(a.incomplete, [], JSON.stringify(a.checks));
    assert.strictEqual(a.ok, true, JSON.stringify(a.checks.filter((c) => c.result === "FAIL")));
    assert.deepStrictEqual([checkOf(a, "passMs p95").value, checkOf(a, "passMs max").value], [2, 8]);
    assert.strictEqual(checkOf(a, "warmupPassMs max").result, "INFO");
    assert.deepStrictEqual([checkOf(a, "flushMs p95").value, checkOf(a, "flushMs max").value], [9, 30]);
    assert.deepStrictEqual([checkOf(a, "lagMs p95 (NORMAL)").value, checkOf(a, "lagMs p95 (NORMAL)").result],
      [1000, "PASS"]);
    assert.strictEqual(checkOf(a, "population.memory approxBytes").result, "PASS");

    const fail = summarizePhase(phase("A", { over: (i) => (i === 60 ? { "channels.population.passMs.max": 25 } : null) }));
    const max = checkOf(fail, "passMs max");
    assert.deepStrictEqual([max.value, max.result, fail.ok], [25, "FAIL", false]);
    assert.ok(/major GC in the window: \+\d+/.test(max.note), max.note);

    const noCtx = summarizePhase(phase("A", { profile: { ...PROFILE_A, "population.context.enabled": false } }));
    assert.ok(noCtx.incomplete.includes("PROFILE_MISMATCH"), JSON.stringify(noCtx.incomplete));
    const restarted = summarizePhase(phase("A", { over: (i) => (i > 90 ? { "process.pid": 101 } : null) }));
    assert.ok(restarted.incomplete.includes("PROCESS_RESTARTED"), JSON.stringify(restarted.incomplete));
  });

  test("PG2 logScan UTF-16LE + timestamps; verdict governor FAIL, duplicate pilot ship NO_GO, heap WARN still GO", () => {
    const text = [
      `${iso(T0 + 60000)} persistence: slow tx population.seed 300ms rows=500`,
      `${iso(T0 + 5 * 60000)} population: slow pass 120ms events=3`,
      `${iso(T0 + 30 * 60000)} population: slow pass 130ms events=3`,
      `${iso(T0 + 31 * 60000)} fleets: slow pass 400ms`,
      "population: slow pass 1ms events=1",
    ].join("\r\n");
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    assert.strictEqual(decodeLog(buf), text);
    assert.strictEqual(decodeLog(Buffer.from(text, "utf8")), text);
    const scan = scanSlowLines(decodeLog(buf), { warmupEndsAtMs: T0 + 10 * 60000 });
    assert.deepStrictEqual([scan.boot.length, scan.warmup.length, scan.steady.length], [1, 1, 2]);
    assert.ok(scan.steady[0].includes("130ms") && scan.steady[1].startsWith("population:"));
    const withLog = summarizePhase(phase("A", { logText: text }));
    assert.strictEqual(checkOf(withLog, "slow lines (steady)").result, "FAIL");

    const s0 = summarizePhase(phase("0", { modeChangesPerHour: 2 }));
    const sA = summarizePhase(phase("A", { modeChangesPerHour: 5 }));
    const lone = verdict([summarizePhase(phase("A"))], {}, THRESHOLDS);
    assert.deepStrictEqual([lone.verdict, lone.reasons], ["INCOMPLETE",
      ["A: INCOMPLETE MISSING_PHASE", "INCOMPLETE MISSING_PHASE live"]]);
    const v1 = verdict([s0, sA, summarizePhase(phase("B"))], { A: "0" }, THRESHOLDS);
    assert.strictEqual(v1.verdict, "NO_GO", JSON.stringify(v1.reasons));
    const gov = checkOf(v1.phases[1], "governor modeChanges/h");
    assert.deepStrictEqual([gov.value, gov.limit, gov.result], [5, 4, "FAIL"]);

    const sB = summarizePhase(phase("B", { over: (i) => (i === 40 ? { "channels.highsecLife.trafficPilotDuplicates": 1 }
      : null) }));
    const v2 = verdict([s0, summarizePhase(phase("A")), sB], {}, THRESHOLDS);
    assert.strictEqual(v2.verdict, "NO_GO", JSON.stringify(v2.reasons));
    assert.ok(v2.reasons.some((r) => r.startsWith("B: FAIL trafficPilotDuplicates")), JSON.stringify(v2.reasons));

    const heavy = summarizePhase(phase("A", { heap: 4450 * MB }));
    const v3 = verdict([s0, heavy, summarizePhase(phase("B"))], {}, THRESHOLDS);
    assert.strictEqual(v3.verdict, "GO", JSON.stringify(v3.reasons));
    const heap = checkOf(v3.phases[1], "heap afterMajor delta");
    assert.deepStrictEqual([heap.value, heap.result], [50 * MB, "WARN"]);
  });

  test("PG3 sample: header, one row per new seq, views every --views-every-s, SIGINT footer; --out exists; "
    + "extractRow on buildSnapshot", async () => {
    const snapshot = (seq) => buildSnapshot({ seq, capturedAtMs: T0 + seq * 1000, startedAtMs: T0, intervalMs: 10000,
      histogramSamples: 3000, status: { snapshotWrite: "ok" },
      process: { pid: 42, uptimeSeconds: seq * 10, heapUsedBytes: 7, heap: { afterMajor: { lastUsedBytes: 5 } } },
      metrics: { counters: { "governor.modeChanges": 3, "population.events": 5 },
        gauges: { "population.lagMs": 100, "highsecLife.trafficPilotDuplicates": 0 },
        histograms: { "population.passMs": { samples: 700, capacity: 3000, spanMs: 0, avg: 1, p50: 1, p95: 2, max: 3 } } },
      tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
      gcKinds: { major: { count: 2, totalMs: 10, maxMs: 7 } },
      capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null },
      governor: { mode: "NORMAL" },
      rejectedNames: [{ name: "population.bad name", reason: "BAD_NAME" }, { name: "fleets.x", reason: "BAD_NAME" }],
      moduleCost: { memory: [{ name: "graph.routeCache", entries: 1, approxBytes: null },
        { name: "population.memory", entries: 3, approxBytes: 99 }] } });
    const envelope = (id, data) => ({ ok: true, id, data });
    const status = envelope("status", { overall: "ok", services: { services: [{ name: "population", state: "running" }] },
      config: { values: { population: { enabled: true, size: 10000, live: { localEnabled: false } },
        highsecLife: { traffic: { maxShipsGlobal: 12 } } } } });
    const population = envelope("population", { available: true, status: { state: "running" }, byState: { DOCKED: 5 },
      tiers: null, counters: { "live.claimed": 4, flushFailed: 0 } });

    const row = extractRow({ telemetry: envelope("telemetry", { available: true, snapshot: snapshot(1) }), status,
      population });
    assert.deepStrictEqual([row["process.pid"], row["channels.governor.modeChanges"], row["channels.population.passMs.p95"],
      row["channels.population.events"], row["memory.approxBytes"], row["gc.kinds.major.count"], row["governor.mode"],
      row["process.heap.afterMajor.lastUsedBytes"], row["channels.highsecLife.trafficPilotDuplicates"]],
    [42, 3, 2, 5, 99, 2, "NORMAL", 5, 0]);
    assert.deepStrictEqual(row.rejectedNames, ["population.bad name"]);
    assert.deepStrictEqual([row["status.config.population.enabled"], row["status.config.population.live.localEnabled"],
      row["status.config.highsecLife.traffic.maxShipsGlobal"], row["status.services.population.state"],
      row["populationView.counters.live.claimed"], row["populationView.byState.DOCKED"], row["channels.population.dirty"]],
    [true, false, 12, "running", 4, 5, null]);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-popgate-"));
    try {
      const out = path.join(tmp, "samples.jsonl");
      let now = 0;
      let reads = 0;
      let sigint = null;
      const calls = [];
      const io = {
        out() {}, err() {}, now: () => now,
        timeoutSignal: () => null,
        setTimer: (fn, ms) => {
          now += ms;
          setImmediate(fn);
          return {};
        },
        clearTimer() {},
        onSigint: (fn) => {
          sigint = fn;
        },
        offSigint() {},
        fetch: async (url) => {
          const p = url.slice("http://127.0.0.1:26410".length);
          calls.push(p);
          if (p === "/api/views/telemetry") {
            const k = reads;
            reads += 1;
            if (k === 8) sigint();
            return { status: 200, json: async () => envelope("telemetry",
              { available: true, snapshot: snapshot(k === 2 ? 2 : k + 1) }) };
          }
          return { status: 200, json: async () => (p === "/api/views/status" ? status : population) };
        },
      };
      const args = ["sample", "--label", "A", "--out", out, "--minutes", "5", "--every-s", "10", "--views-every-s", "60"];
      assert.strictEqual(await main(args, io), 0);
      const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.strictEqual(lines[0].type, "header");
      assert.strictEqual(lines[0].tool, "populationGateReport");
      assert.strictEqual(lines[lines.length - 1].type, "footer");
      const rows = lines.filter((l) => l.type === "row");
      assert.deepStrictEqual(rows.map((r) => r.seq), [1, 2, 4, 5, 6, 7, 8, 9]);
      assert.deepStrictEqual(rows.map((r) => r["views.status"]), [true, false, false, false, false, true, false, false]);
      assert.strictEqual(calls.filter((c) => c === "/api/views/population").length, 2);
      assert.strictEqual(await main(args, { ...io, fetch: io.fetch }), 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("PG6 phase T: tempo, AWAY share, reborn, careers, corps; FAIL / TOO_SHORT / PILOTS_CHANGED / CORPS_SHRINKING; "
    + "phase N with AWAY -> FAIL", () => {
    const good = summarizePhase(tempoPhase(), THRESHOLDS);
    assert.strictEqual(good.role, "tempo");
    assert.deepStrictEqual(good.incomplete, [], JSON.stringify(good.checks));
    assert.deepStrictEqual(good.checks.filter((c) => c.result === "FAIL" || c.result === "WARN"), []);
    assert.deepStrictEqual([checkOf(good, "away permille (median)").value, checkOf(good, "reborn per day").value,
      checkOf(good, "corps open ratio").result, checkOf(good, "tempo days").value], [160, 15, "PASS", 26]);
    assert.strictEqual(good.rates.modeChangesPerHour, null);

    const high = summarizePhase(tempoPhase({ away: 300 }));
    assert.strictEqual(checkOf(high, "away permille (median)").result, "FAIL");
    assert.ok(summarizePhase(tempoPhase({ days: 10 })).incomplete.includes("TOO_SHORT"));
    const pilots = checkOf(summarizePhase(tempoPhase({ over: (i) => (i === 100
      ? { "channels.population.pilots": 9999 } : null) })), "pilots constant");
    assert.deepStrictEqual([pilots.result, pilots.note], ["FAIL", "PILOTS_CHANGED"]);
    const shrink = checkOf(summarizePhase(tempoPhase({ openEnd: 15 })), "corps open ratio");
    assert.strictEqual(shrink.result, "WARN");
    assert.ok(shrink.note.startsWith("CORPS_SHRINKING"), shrink.note);

    const n = summarizePhase(lifePhase("N", { awayN: 5 }));
    const away = checkOf(n, "AWAY with the flag off");
    assert.deepStrictEqual([away.value > 0, away.result, away.note], [true, "FAIL", "AWAY_WITH_FLAG_OFF"]);
    const nOk = summarizePhase(lifePhase("N"));
    assert.deepStrictEqual([nOk.ok, nOk.incomplete, checkOf(nOk, "loadNormalized").value], [true, [], 5],
      JSON.stringify(nOk.checks.filter((c) => c.result === "FAIL")));
    assert.strictEqual(checkOf(nOk, "flushMs p95").result, "INFO");
  });

  test("PG7 verdict of the life cycle gate: T+L+N GO, no N, MIXED_GATES, SHIM_DRIVER WARN, 0/A/B unchanged", () => {
    const T = summarizePhase(tempoPhase());
    const L = summarizePhase(lifePhase("L", { p95: 2 }));
    const N = summarizePhase(lifePhase("N", { p95: 1.5 }));
    const go = verdict([T, L, N], {}, THRESHOLDS);
    assert.deepStrictEqual([go.verdict, go.reasons], ["GO", []]);
    const delta = checkOf(go.phases[1], "passMs p95 delta");
    assert.deepStrictEqual([delta.value, delta.result], [0.5, "PASS"]);
    assert.strictEqual(checkOf(go.phases[1], "lifecycle block").result, "PASS");

    const noN = verdict([T, L], {}, THRESHOLDS);
    assert.strictEqual(noN.verdict, "INCOMPLETE");
    assert.ok(noN.reasons.includes("INCOMPLETE MISSING_PHASE nolife"), JSON.stringify(noN.reasons));
    const mixed = verdict([T, summarizePhase(phase("A"))], {}, THRESHOLDS);
    assert.strictEqual(mixed.verdict, "INCOMPLETE");
    assert.ok(mixed.reasons.includes("INCOMPLETE MIXED_GATES"), JSON.stringify(mixed.reasons));

    const shimLog = "liveSim: sqlite driver = node:sqlite shim (timings are not a measurement)";
    const shim = verdict([T, summarizePhase(lifePhase("L", { p95: 2, logText: shimLog })), N], {}, THRESHOLDS);
    assert.strictEqual(shim.verdict, "GO", JSON.stringify(shim.reasons));
    const drv = checkOf(shim.phases[1], "sqlite driver");
    assert.deepStrictEqual([drv.result, drv.note], ["WARN", "SHIM_DRIVER"]);

    const pop = verdict([summarizePhase(phase("0")), summarizePhase(phase("A")), summarizePhase(phase("B"))], {},
      THRESHOLDS);
    assert.deepStrictEqual([pop.verdict, pop.reasons], ["GO", []]);

    const cfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
    const row = extractRow({ telemetry: { available: true, snapshot: { seq: 1 } },
      status: { ok: true, id: "status", data: { config: { values: cfg } } },
      population: { ok: true, id: "population", data: { status: { state: "running" }, byState: { AWAY: 3 },
        counters: { "lifecycle.reborn": 7 }, generatedAt: T0,
        lifecycle: { away: 3, awayPermille: 150, awayCap: 400, byCareer: { ROOKIE: 9 }, corps: { open: 12 } } } } });
    for (const key of PROFILE_KEYS) assert.notStrictEqual(row[`status.config.${key}`], null, key);
    assert.deepStrictEqual([row["populationView.lifecycle"], row["populationView.lifecycle.awayPermille"],
      row["populationView.lifecycle.byCareer.ROOKIE"], row["populationView.lifecycle.byCareer.VETERAN"],
      row["populationView.lifecycle.corps.open"], row["populationView.byState.AWAY"],
      row["populationView.counters.lifecycle.reborn"], row["populationView.counters.corps.dissolved"],
      row["populationView.generatedAt"]], [true, 150, 9, null, 12, 3, 7, 0, T0]);
  });
};
