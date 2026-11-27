"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { SCHEMA, resolveConfig } = require("../../config");
const { detectEvents, planDelivery, buildPayload, CHAT_MAX_CHARS } = require("../../lib/alerts/rules");
const { startAlerts, observe } = require("../../lib/alerts");
const { buildSnapshot, ALARMS } = require("../../lib/telemetry/snapshot");
const { probeModules } = require("../../lib/adapter/probe");
const { isSecretRow, redactConfigValues, redactMessages, describeConfig } = require("../../lib/observer/effectiveConfig");
const { buildStatusView } = require("../../lib/observer/builtinViews");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const URL_TEXT = "https://hooks.example.test/api/webhooks/123/SECRETPATH?token=QQQ";
const LEAKS = ["SECRETPATH", "QQQ", "api/webhooks"];

function resolved(env) {
  return resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
}

function observed(over = {}) {
  return { seq: 1, alarms: {}, shedEscalations: 0, refusal: null, failed: [], probe: { drift: 0, missing: 0, affects: [] },
    boot: { unclean: null }, ...over };
}

function ev(kind, id, level, count = 1) {
  return { kind, key: `${kind}:${id}`, level, count, text: "t" };
}

const P = Object.freeze({ repeatMs: 1000, minSendIntervalMs: 500, maxQueue: 3, maxEventsPerMessage: 2 });

function fakeTimers() {
  const list = [];
  return {
    list,
    setTimer(fn) {
      const t = { fn, cancelled: false };
      list.push(t);
      return { cancel: () => { t.cancelled = true; }, hasRef: () => false };
    },
    runNext() {
      const t = list.filter((x) => !x.cancelled).shift();
      assert.ok(t, "a timer is armed");
      t.cancelled = true;
      t.fn();
    },
  };
}

function spyLogger() {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

module.exports = ({ test }) => {
  test("AL1 detectEvents: first poll BOOT/PROBE_DRIFT/SERVICES_REFUSED once, ALARM deltas of the list, SHED, "
    + "SERVICE_FAILED once, same seq -> no ALARM/SHED", () => {
    const p = { alarmIds: ["journal.conflict", "persistence.backup.failed"], notifyBoot: true };
    const first = observed({ refusal: "probe_core_drift", probe: { drift: 1, missing: 1, affects: ["core", "x y"] },
      alarms: { "journal.conflict": 4 } });
    const e1 = detectEvents(null, first, p);
    assert.deepStrictEqual(e1.map((e) => e.key), ["BOOT:start", "PROBE_DRIFT:probe", "SERVICES_REFUSED:probe_core_drift"]);
    assert.ok(e1[1].text.includes("modules off: core,x_y"), e1[1].text);
    assert.deepStrictEqual(detectEvents(null, observed({ refusal: "disabled_by_config" }), { ...p, notifyBoot: false }), []);

    const cur = observed({ seq: 2, refusal: "probe_core_drift", probe: first.probe, shedEscalations: 2,
      alarms: { "journal.conflict": 6, "persistence.tx.TX_FAILED": 9 },
      failed: [{ name: "trade", reason: "TRADE_START_FAILED" }] });
    const e2 = detectEvents(first, cur, p);
    assert.deepStrictEqual(e2.map((e) => [e.key, e.level, e.count]), [
      ["ALARM:journal.conflict", "error", 2],
      ["SHED:governor", "warn", 2],
      ["SERVICE_FAILED:trade:TRADE_START_FAILED", "error", 1],
    ]);
    assert.ok(e2[0].text.includes("(total 6)"), e2[0].text);
    assert.deepStrictEqual(detectEvents(cur, { ...cur, alarms: { "journal.conflict": 99 }, shedEscalations: 5 }, p), []);

    const g = detectEvents(null, observed({ refusal: "crash_loop_guard", boot: { unclean: true, tripped: true, streak: 2 } }), p);
    assert.deepStrictEqual(g.map((e) => [e.key, e.level]), [["BOOT:start", "info"], ["RESTART_GUARD_TRIPPED:guard", "error"]]);
    assert.strictEqual(g[0].text, "server started after an unclean stop");
    assert.ok(g[1].text.startsWith("restart guard: 3 starts without a clean stop"), g[1].text);
    assert.deepStrictEqual(detectEvents(null, observed({ refusal: "probe_core_drift",
      boot: { unclean: true, tripped: true, streak: 2 } }), { ...p, notifyBoot: false }).map((e) => e.key),
    ["RESTART_GUARD_TRIPPED:guard", "SERVICES_REFUSED:probe_core_drift"]);
  });

  test("AL2 planDelivery: cooldown merges or suppresses, overflow drops the oldest, minSendIntervalMs holds, "
    + "error > warn > info, maxEventsPerMessage", () => {
    let st = { queue: [], lastSentByKey: {}, lastSendAtMs: null };
    const r1 = planDelivery(st, [ev("BOOT", "start", "info"), ev("SHED", "governor", "warn"),
      ev("ALARM", "journal.conflict", "error", 2)], 0, P);
    assert.deepStrictEqual(r1.batch.map((e) => e.key), ["ALARM:journal.conflict", "SHED:governor"]);
    assert.deepStrictEqual(r1.queue.map((e) => e.key), ["BOOT:start"]);
    st = { queue: r1.queue, lastSentByKey: r1.lastSentByKey, lastSendAtMs: 0 };
    const r2 = planDelivery(st, [ev("SHED", "governor", "warn"), ev("BOOT", "start", "info", 3)], 100, P);
    assert.deepStrictEqual([r2.suppressed, r2.batch, r2.queue.map((e) => [e.key, e.count])],
      [1, null, [["BOOT:start", 4]]]);
    assert.deepStrictEqual(r2.suppressedByKey, { "SHED:governor": { count: 1, text: "t" } });
    const merged = planDelivery({ queue: [{ ...ev("ALARM", "x", "warn"), text: "a (total 1)" }], lastSentByKey: {},
      lastSendAtMs: 0, sending: true }, [{ ...ev("ALARM", "x", "warn", 2), text: "a (total 3)" }], 1, P);
    assert.deepStrictEqual(merged.queue.map((e) => [e.count, e.text]), [[3, "a (total 3)"]]);
    const r3 = planDelivery({ ...st, queue: r2.queue, lastSentByKey: r2.lastSentByKey }, [ev("ALARM", "a", "warn"),
      ev("ALARM", "b", "warn"), ev("ALARM", "c", "warn")], 200, P);
    assert.deepStrictEqual([r3.dropped, r3.queue.map((e) => e.key)], [1, ["ALARM:a", "ALARM:b", "ALARM:c"]]);
    const r4 = planDelivery({ queue: [], lastSentByKey: r2.lastSentByKey, lastSendAtMs: 0 },
      [ev("SHED", "governor", "warn")], 1000, P);
    assert.deepStrictEqual([r4.suppressed, r4.batch.map((e) => e.key)], [0, ["SHED:governor"]]);
    const r5 = planDelivery({ queue: [], lastSentByKey: {}, lastSendAtMs: null, sending: true },
      [ev("SHED", "governor", "warn")], 0, P);
    assert.deepStrictEqual([r5.batch, r5.queue.length], [null, 1]);
  });

  test("AL3 service: off / no URL / http without allowPlainHttp refuse with 0 sends; failed send retried to "
    + "maxAttempts then dropped; log and status hold the host only", async () => {
    const sends = [];
    const fakeSend = (url, body) => {
      sends.push({ href: url.href, body });
      return Promise.resolve({ ok: false, reason: "HTTP_STATUS", status: 500 });
    };
    const base = { EVEJS_LNE_ALERTS_WEBHOOK_URL: URL_TEXT };
    const refusals = [
      [{ ...base }, "disabled_by_config"],
      [{ EVEJS_LNE_ALERTS_ENABLED: "1" }, "ALERTS_NO_WEBHOOK"],
      [{ EVEJS_LNE_ALERTS_ENABLED: "1", EVEJS_LNE_ALERTS_WEBHOOK_URL: "http://127.0.0.1:9/x" }, "ALERTS_URL_INVALID"],
    ].map(([env]) => {
      const timers = fakeTimers();
      const r = startAlerts({ config: resolved(env).config, ctx: {}, send: fakeSend, setTimer: timers.setTimer });
      return [r.ok, r.reason, r.detail || null, timers.list.length];
    });
    assert.deepStrictEqual(refusals, [[false, "disabled_by_config", null, 0], [false, "ALERTS_NO_WEBHOOK", null, 0],
      [false, "ALERTS_URL_INVALID", "URL_SCHEME", 0]]);
    assert.strictEqual(sends.length, 0);

    const r = resolved({ ...base, EVEJS_LNE_ALERTS_ENABLED: "1", EVEJS_LNE_ALERTS_MIN_SEND_INTERVAL_MS: "0",
      EVEJS_LNE_ALERTS_MAX_ATTEMPTS: "2" });
    assert.deepStrictEqual(r.warnings, []);
    const timers = fakeTimers();
    const logger = spyLogger();
    let now = 1000;
    const ctx = { services: { getStatus: () => ({ refusal: null, services: [] }) } };
    const started = startAlerts({ config: r.config, ctx, logger, send: fakeSend, setTimer: timers.setTimer,
      wallNow: () => now, uptime: () => 7 });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    assert.strictEqual(sends.length, 0, "nothing inside start()");
    timers.runNext();
    await tick();
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].href, URL_TEXT);
    assert.deepStrictEqual(JSON.parse(sends[0].body).events.map((e) => [e.kind, e.count]), [["BOOT", 1]]);
    now += 15000;
    started.alerts.pollNow();
    await tick();
    now += 15000;
    started.alerts.pollNow();
    await tick();
    const st = started.alerts.getStatus();
    assert.deepStrictEqual([sends.length, st.state, st.queue, st.counts, st.lastError, st.host],
      [2, "running", 0, { sent: 0, failed: 2, dropped: 1, suppressed: 0 }, { reason: "HTTP_STATUS", status: 500 },
        "hooks.example.test"]);
    started.alerts.stop("test");
    const text = JSON.stringify({ st, lines: logger.lines });
    for (const leak of LEAKS) assert.ok(!text.includes(leak), `${leak} leaked: ${text}`);
    assert.ok(logger.lines.some((l) => l.startsWith("alerts: running host=hooks.example.test format=json")), text);
    assert.strictEqual(logger.lines.filter((l) => l.startsWith("alerts: send failed - HTTP_STATUS status=500")).length, 1);
  });

  test("AL4 masking: alerts.webhookUrl is secret, *** in the config copy / status / effective-config, a bad URL "
    + "warning holds no value, getStatus has the host only", () => {
    const row = SCHEMA.find((x) => x.key === "alerts.webhookUrl");
    assert.strictEqual(isSecretRow(row), true);
    const good = resolved({ EVEJS_LNE_ALERTS_WEBHOOK_URL: URL_TEXT });
    assert.deepStrictEqual(good.warnings, []);
    assert.strictEqual(good.config.alerts.webhookUrl, URL_TEXT);
    assert.strictEqual(redactConfigValues(good.config, SCHEMA).alerts.webhookUrl, "***");
    const d = describeConfig({ schema: SCHEMA, config: good.config, sources: good.sources, warnings: [], errors: [],
      services: null, originChars: 0 });
    assert.strictEqual(d.overrides.find((o) => o.key === "alerts.webhookUrl").value, "***");
    const status = buildStatusView({ ctx: { config: good.config, state: { configResult: good } }, config: {},
      getObserverStats: () => ({}), schema: SCHEMA }).getData();
    assert.strictEqual(status.config.values.alerts.webhookUrl, "***");

    const bad = resolved({ EVEJS_LNE_ALERTS_WEBHOOK_URL: "https://user:pw@hooks.example.test/SECRETPATH" });
    assert.strictEqual(bad.warnings.length, 1);
    assert.ok(bad.warnings[0].includes("<secret>"), bad.warnings[0]);
    assert.deepStrictEqual(redactMessages(bad.warnings, SCHEMA), ["<redacted: alerts.webhookUrl>"]);
    const text = JSON.stringify({ d, status, bad: bad.warnings });
    for (const leak of [...LEAKS, "user:pw"]) assert.ok(!text.includes(leak), `${leak} leaked`);

    const started = startAlerts({ config: resolved({ EVEJS_LNE_ALERTS_ENABLED: "1",
      EVEJS_LNE_ALERTS_WEBHOOK_URL: URL_TEXT }).config, ctx: {}, send: () => Promise.resolve({ ok: true, status: 204 }),
    setTimer: fakeTimers().setTimer });
    const st = started.alerts.getStatus();
    started.alerts.stop("test");
    assert.strictEqual(st.host, "hooks.example.test");
    assert.ok(!JSON.stringify(st).includes("SECRETPATH"));
  });

  test("AL5 buildPayload: json white list, discord cut at 1900 chars with '… +N', BODY_TOO_LARGE", () => {
    const leaky = { ...ev("ALARM", "journal.conflict", "error", 2), attempts: 1, player: "Some Pilot" };
    const spec = { format: "json", serverLabel: "lne", wallMs: Date.UTC(2026, 10, 2), uptimeSeconds: 12.4,
      maxBodyBytes: 8192 };
    const json = JSON.parse(buildPayload([leaky], spec).body);
    assert.deepStrictEqual(Object.keys(json), ["source", "server", "at", "uptimeSeconds", "events"]);
    assert.deepStrictEqual(json.events, [{ kind: "ALARM", key: "ALARM:journal.conflict", level: "error", count: 2,
      text: "t" }]);
    assert.deepStrictEqual([json.source, json.at, json.uptimeSeconds], ["livingNewEden", "2026-11-02T00:00:00.000Z", 12]);

    const many = Array.from({ length: 60 }, (_x, i) => ({ ...ev("ALARM", `id${i}`, "warn"), text: "x".repeat(60) }));
    const discord = JSON.parse(buildPayload(many, { ...spec, format: "discord", maxBodyBytes: 65536 }).body);
    assert.deepStrictEqual(Object.keys(discord), ["content"]);
    assert.ok(discord.content.length <= CHAT_MAX_CHARS, String(discord.content.length));
    const shown = discord.content.split("\n").filter((l) => l.startsWith("[LNE lne] WARN ALARM")).length;
    assert.ok(discord.content.endsWith(`… +${60 - shown}`), discord.content.slice(-20));
    const slack = JSON.parse(buildPayload(many.slice(0, 1), { ...spec, format: "slack" }).body);
    assert.deepStrictEqual(slack, { text: "[LNE lne] WARN ALARM ALARM:id0 x1 - " + "x".repeat(60) });
    assert.deepStrictEqual(buildPayload(many, { ...spec, maxBodyBytes: 512 }), { ok: false, reason: "BODY_TOO_LARGE" });
  });

  test("AL6 observe() on the real source shapes (buildSnapshot, probeModules, registry status, restart guard); "
    + "a failed batch gets back the counts suppressed while it was in flight", async () => {
    const snapshot = (seq, conflicts) => buildSnapshot({ seq, capturedAtMs: 0, startedAtMs: 0, intervalMs: 1000,
      histogramSamples: 8, status: { snapshotWrite: "ok" }, process: {},
      metrics: { counters: { "journal.conflicts": conflicts, "governor.escalations.p95Unplayable": 3 }, gauges: {},
        histograms: {} },
      tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
      gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null } });
    const report = probeModules([
      { path: "./a", symbols: [{ name: "f", kind: "export", consumers: ["fleets"] }] },
      { path: "./b", symbols: [{ name: "g", kind: "export", consumers: ["battle"] }] },
    ], { load: (p) => (p === "./a" ? { ok: true, exports: {} } : { ok: false, reason: "nope" }) });
    let snap = snapshot(1, 2);
    const ctx = {
      telemetry: { getSnapshot: () => snap },
      adapter: { getProbeReport: () => report },
      services: { getStatus: () => ({ refusal: null, services: [{ name: "trade", state: "failed", reason: "X" },
        { name: "world", state: "running", reason: null }] }) },
      restartGuard: { getStatus: () => ({ state: "ok", tripped: false, previousUnclean: true, streak: 1 }) },
    };
    assert.deepStrictEqual(observe(ctx), { seq: 1, alarms: { "journal.conflict": 2 }, shedEscalations: 3, refusal: null,
      failed: [{ name: "trade", reason: "X" }], probe: { drift: 1, missing: 1, affects: ["fleets", "battle"] },
      boot: { unclean: true, tripped: false, streak: 1 } });
    assert.deepStrictEqual(observe({}).boot, { unclean: null, tripped: false, streak: 0 });

    const sends = [];
    let finish = null;
    const send = (_url, body) => {
      sends.push(JSON.parse(body).events.map((e) => [e.key, e.count, e.text]));
      if (sends.length === 1) return new Promise((resolve) => { finish = resolve; });
      return Promise.resolve({ ok: true, status: 204 });
    };
    const r = resolved({ EVEJS_LNE_ALERTS_ENABLED: "1", EVEJS_LNE_ALERTS_WEBHOOK_URL: URL_TEXT,
      EVEJS_LNE_ALERTS_MIN_SEND_INTERVAL_MS: "0", EVEJS_LNE_ALERTS_NOTIFY_BOOT: "0" });
    const svc = { ...ctx, services: { getStatus: () => ({ refusal: null, services: [] }) }, adapter: {} };
    const started = startAlerts({ config: r.config, ctx: svc, send, setTimer: fakeTimers().setTimer, wallNow: () => 1 });
    started.alerts.pollNow();
    snap = snapshot(2, 3);
    started.alerts.pollNow();
    snap = snapshot(3, 5);
    started.alerts.pollNow();
    assert.strictEqual(started.alerts.getStatus().counts.suppressed, 1);
    finish({ ok: false, reason: "HTTP_STATUS", status: 500 });
    await tick();
    started.alerts.pollNow();
    await tick();
    started.alerts.stop("test");
    const msg = ALARMS.find((x) => x.id === "journal.conflict").message;
    assert.deepStrictEqual(sends, [[["ALARM:journal.conflict", 1, `${msg} (total 3)`]],
      [["ALARM:journal.conflict", 3, `${msg} (total 5)`]]]);
  });
};
