"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { summarize, verdict, THRESHOLDS, PHASE_FLAGS } = require("../../tools/measure/highsecLifeReport");
const { createRegistry } = require("../../lib/telemetry/registry");
const { buildSnapshot } = require("../../lib/telemetry/snapshot");
const { buildStatusView, buildTelemetryView } = require("../../lib/observer/builtinViews");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;

const H1_ENV = Object.freeze({ EVEJS_LNE_VIRTUALCORPS_ENABLED: "1", EVEJS_LNE_LOCAL_PILOTS_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_ENABLED: "1", EVEJS_LNE_HIGHSEC_LIFE_CIVILIANS_ENABLED: "1",
  EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_ENABLED: "1" });

const envelope = (id, data) => JSON.parse(JSON.stringify({ ok: true, id, generatedAtMs: T0, cached: false,
  stale: false, data }));

function telemetryOf({ counts = {}, gauges = {}, observes = {} }) {
  const reg = createRegistry({ histogramSamples: 8, maxMetrics: 256 });
  for (const [name, n] of Object.entries(counts)) assert.strictEqual(reg.count(name, n), true, name);
  for (const [name, v] of Object.entries(gauges)) assert.strictEqual(reg.gauge(name, v), true, name);
  for (const [name, list] of Object.entries(observes)) {
    for (const v of list) assert.strictEqual(reg.observe(name, v), true, name);
  }
  const snapshot = buildSnapshot({ seq: 1, capturedAtMs: T0, startedAtMs: T0, intervalMs: 10000, histogramSamples: 8,
    status: { tick: "ok" }, process: { pid: 1 }, metrics: reg.read(),
    tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
    gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null } });
  return envelope("telemetry", buildTelemetryView({ ctx: { telemetry: { getSnapshot: () => snapshot } } }).getData());
}

function statusOf(env, services) {
  const r = config.resolveConfig({ env, modDir: MOD_DIR });
  assert.deepStrictEqual(r.errors, []);
  const ctx = { config: r.config, state: { configResult: { warnings: r.warnings, errors: r.errors, sources: {} } },
    services: { getStatus: () => ({ available: true, services }) } };
  return envelope("status", buildStatusView({ ctx, getObserverStats: () => ({}) }).getData());
}

function summaryOf(role, over = {}) {
  const flags = { "localPilots.enabled": true, ...PHASE_FLAGS[role] };
  return { name: role, overall: "ok", serviceState: role === "base" ? "disabled" : "running", flags,
    configWarnings: [], counters: { civiliansShortfall: 0, trafficSpawned: 20, trafficDespawned: 18, chatterLines: 100,
      chatterRumours: 3, chatterRateLimited: 0, chatterSendFailed: 1, gankFields: 5 },
    gauges: role === "base" ? {} : { civiliansWanted: 60, civiliansAssigned: 58, trafficLive: 2 },
    histogramsP95: { trafficPassMs: 0.8, chatterPassMs: 0.4, gankPassMs: 1.2 },
    schedulerLatenessP95: role === "base" ? 3000 : 3500, txRowLimit: 0,
    runningLine: role === "base" ? null : { systems: 412, ensured: 0, linked: 20, refused: 0, failed: 0 },
    logFailures: { traffic: 0, gank: 0, chatter: 0, off: [] }, hours: 24, presenceMin: 60, valuesPresent: true,
    telemetryAvailable: true, settings: { civilianCorps: 20, maxShipsGlobal: 12, maxLinesPerMinute: 6 }, ...over };
}

module.exports = ({ test }) => {
  test("HR1 summarize: status + telemetry envelopes and log -> flags, metrics, runningLine, logFailures", () => {
    const status = statusOf(H1_ENV, [{ name: "highsecLife", state: "running", reason: null },
      { name: "virtualCorps", state: "running", reason: null }]);
    const telemetry = telemetryOf({
      counts: { "highsecLife.trafficSpawned": 7, "highsecLife.trafficDespawned": 5, "highsecLife.civiliansShortfall": 2,
        "persistence.tx.TX_ROW_LIMIT": 1, "fleets.grid.visitsWritten": 9 },
      gauges: { "highsecLife.civiliansWanted": 45, "highsecLife.civiliansAssigned": 43, "highsecLife.trafficLive": 2 },
      observes: { "highsecLife.trafficPassMs": [1, 2, 3], [`${THRESHOLDS.schedulerLateness.channel}.`
        + `${THRESHOLDS.schedulerLateness.name}`]: [100, 200, 4000] } });
    const logText = [
      "server-1  | [LNE] highsecLife: running - 400 systems, civilians ensured 1, linked 2, refused 0, failed 3",
      "server-1  | [LNE] highsecLife: running - 412 systems, civilians ensured 20, linked 0, refused 0, failed 0",
      "server-1  | [LNE] highsecLife: traffic running (poll 15000ms, max 4/system, 12 global)",
      "server-1  | [LNE] highsecLife: traffic spawn failed (NO_SCENE); further failures only counted",
      "server-1  | [LNE] scheduler: catch-up start lag=1 backlog=2",
    ].join("\r\n");
    const s = summarize({ name: "H1", hours: 1, presenceMin: 60, status, telemetry, logText });
    assert.strictEqual(THRESHOLDS.schedulerLateness.name, "lateness");
    assert.deepStrictEqual(s.flags, { "localPilots.enabled": true, "highsecLife.enabled": true,
      "highsecLife.civilians.enabled": true, "highsecLife.traffic.enabled": true, "highsecLife.chatter.enabled": false,
      "highsecLife.gank.enabled": false });
    assert.strictEqual(s.overall, "degraded");
    assert.strictEqual(s.serviceState, "running");
    assert.deepStrictEqual(s.configWarnings.filter((w) => w.includes("highsecLife")), []);
    assert.deepStrictEqual(s.gauges, { civiliansWanted: 45, civiliansAssigned: 43, trafficLive: 2 });
    assert.strictEqual(s.counters.trafficSpawned, 7);
    assert.strictEqual(s.counters.trafficDespawned, 5);
    assert.strictEqual(s.counters.civiliansShortfall, 2);
    assert.strictEqual(s.counters.chatterLines, 0);
    assert.deepStrictEqual(s.histogramsP95, { trafficPassMs: 3 });
    assert.strictEqual(s.schedulerLatenessP95, 4000);
    assert.strictEqual(s.txRowLimit, 1);
    assert.deepStrictEqual(s.runningLine, { systems: 412, ensured: 20, linked: 0, refused: 0, failed: 0 });
    assert.deepStrictEqual(s.logFailures, { traffic: 1, gank: 0, chatter: 0, off: [] });
    assert.deepStrictEqual(s.settings, { civilianCorps: 20, maxShipsGlobal: 12, maxLinesPerMinute: 6 });
    assert.deepStrictEqual([s.valuesPresent, s.telemetryAvailable, s.hours, s.presenceMin], [true, true, 1, 60]);
  });

  test("HR2 verdict: H3 all pass GO; sendFailed 5 of 100 NO_GO (HL3); no gank flag in values INCOMPLETE", () => {
    const roles = { base: "H0", phase: "H3", role: "h3" };
    const a = verdict({ H0: summaryOf("base"), H3: summaryOf("h3") }, roles);
    assert.strictEqual(a.verdict, "GO", JSON.stringify(a.gates));
    assert.deepStrictEqual(Object.keys(a.gates), ["HL0", "HL1", "HL2", "HL3", "HL4", "HL5"]);

    const h3 = summaryOf("h3");
    const b = verdict({ H0: summaryOf("base"), H3: { ...h3, counters: { ...h3.counters, chatterSendFailed: 5 } } },
      roles);
    assert.strictEqual(b.verdict, "NO_GO");
    assert.strictEqual(b.gates.HL3.pass, false);
    assert.ok(b.gates.HL3.detail.some((d) => d.startsWith("FAIL chatterSendFailed=5")), b.gates.HL3.detail.join("; "));
    assert.deepStrictEqual(Object.entries(b.gates).filter(([, g]) => !g.pass).map(([k]) => k), ["HL3"]);

    const c = verdict({ H0: summaryOf("base"), H3: summaryOf("h3", { flags: { ...h3.flags,
      "highsecLife.gank.enabled": null } }) }, roles);
    assert.strictEqual(c.verdict, "INCOMPLETE");
    assert.ok(c.missing.some((m) => m.includes("highsecLife.gank.enabled")), c.missing.join("; "));
  });
};
