"use strict";

const { createPoller } = require("../presence/poller");
const { detectEvents, planDelivery, buildPayload, checkWebhookUrl, FORMATS } = require("./rules");
const { createWebhookSender } = require("./webhook");

const STATE = Object.freeze({ RUNNING: "running", SENDING: "sending", STOPPED: "stopped" });
const METRIC_SENT = "telemetry.alerts.sent";
const METRIC_FAILED = "telemetry.alerts.failed";
const METRIC_DROPPED = "telemetry.alerts.dropped";
const METRIC_SUPPRESSED = "telemetry.alerts.suppressed";
const METRIC_EVENTS = "telemetry.alerts.events";
const METRIC_QUEUE = "telemetry.alerts.queue";

function noop() {}

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : null;
  } catch (_err) {
    return null;
  }
}

function codeOf(err) {
  const code = err && err.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "ERROR";
}

function observe(ctx) {
  const snap = call(ctx && ctx.telemetry, "getSnapshot");
  const alarms = {};
  for (const a of (snap && Array.isArray(snap.alarms) ? snap.alarms : [])) {
    if (a && typeof a.id === "string" && Number.isFinite(a.count)) alarms[a.id] = a.count;
  }
  const governor = snap && snap.channels && snap.channels.governor;
  const shed = governor ? governor["escalations.p95Unplayable"] : 0;
  const status = call(ctx && ctx.services, "getStatus");
  const failed = [];
  for (const s of (status && Array.isArray(status.services) ? status.services : [])) {
    if (s && s.state === "failed") failed.push({ name: String(s.name), reason: String(s.reason || "failed") });
  }
  const report = call(ctx && ctx.adapter, "getProbeReport");
  const counts = report && report.counts;
  const probe = counts ? { drift: Number(counts.drift) || 0, missing: Number(counts.missing) || 0,
    affects: Object.keys((report && report.disabledModules) || {}) } : null;
  const guard = call(ctx && ctx.restartGuard, "getStatus");
  const boot = {
    unclean: guard && typeof guard.previousUnclean === "boolean" ? guard.previousUnclean : null,
    tripped: Boolean(guard && guard.tripped === true),
    streak: guard && Number.isFinite(guard.streak) ? guard.streak : 0,
  };
  return {
    seq: snap && Number.isFinite(snap.seq) ? snap.seq : null,
    alarms,
    shedEscalations: Number.isFinite(shed) ? shed : 0,
    refusal: status && typeof status.refusal === "string" ? status.refusal : null,
    failed,
    probe,
    boot,
  };
}

function parseAlarmIds(text) {
  return String(text || "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function startAlerts(deps) {
  try {
    const config = (deps && deps.config) || {};
    const a = config.alerts || {};
    if (a.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    if (typeof a.webhookUrl !== "string" || a.webhookUrl.trim() === "") return { ok: false, reason: "ALERTS_NO_WEBHOOK" };
    const checked = checkWebhookUrl(a.webhookUrl, a.allowPlainHttp === true);
    if (!checked.ok) return { ok: false, reason: "ALERTS_URL_INVALID", detail: checked.reason };
    if (!FORMATS.includes(a.format)) return { ok: false, reason: "ALERTS_START_FAILED", detail: "alerts.format" };
    return { ok: true, alerts: createAlertsService(deps, a, checked.url) };
  } catch (err) {
    return { ok: false, reason: "ALERTS_START_FAILED", detail: codeOf(err) };
  }
}

function createAlertsService(deps, a, url) {
  const ctx = deps.ctx || {};
  const logger = deps.logger || { log: noop };
  const wallNow = typeof deps.wallNow === "function" ? deps.wallNow : () => Date.now();
  const uptime = typeof deps.uptime === "function" ? deps.uptime : () => process.uptime();
  const host = url.host;
  const alarmIds = Object.freeze(parseAlarmIds(a.alarmIds));
  const p = Object.freeze({ repeatMs: a.repeatMs, minSendIntervalMs: a.minSendIntervalMs, maxQueue: a.maxQueue,
    maxEventsPerMessage: a.maxEventsPerMessage });
  let sender = typeof deps.send === "function" ? deps.send : null;
  let state = STATE.RUNNING;
  let prev = null;
  let queue = [];
  let lastSentByKey = {};
  let lastSendAtMs = null;
  let lastError = null;
  let inFlightKeys = null;
  let heldByKey = {};
  const counts = { sent: 0, failed: 0, dropped: 0, suppressed: 0 };
  const logged = new Set();

  function telemetry() {
    return ctx.telemetry && typeof ctx.telemetry.count === "function" ? ctx.telemetry : null;
  }
  function metric(fn) {
    const t = telemetry();
    if (!t) return;
    try {
      fn(t);
    } catch (_err) {
    }
  }
  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }
  function logOnce(key, line) {
    if (logged.has(key)) return;
    logged.add(key);
    log(line);
  }
  function drop(n) {
    if (n <= 0) return;
    counts.dropped += n;
    metric((t) => t.count(METRIC_DROPPED, n));
  }
  function queueGauge() {
    metric((t) => t.gauge(METRIC_QUEUE, queue.length));
  }

  function send(target, body, timeoutMs) {
    if (sender === null) {
      const mod = target.protocol === "http:" ? require("node:http") : require("node:https");
      sender = createWebhookSender({ request: mod.request.bind(mod) });
    }
    return sender(target, body, timeoutMs);
  }

  function requeue(batch, sentAt) {
    const keep = [];
    let gone = 0;
    for (const e of batch) {
      const attempts = (e.attempts || 0) + 1;
      const held = heldByKey[e.key];
      if (attempts >= a.maxAttempts) gone += 1;
      else if (held) keep.push({ ...e, count: e.count + held.count, text: held.text, attempts });
      else keep.push({ ...e, attempts });
      if (lastSentByKey[e.key] === sentAt) delete lastSentByKey[e.key];
    }
    const merged = [...keep];
    for (const e of queue) {
      const same = merged.find((x) => x.key === e.key);
      if (same) {
        same.count += e.count;
        same.text = e.text;
      } else merged.push(e);
    }
    while (merged.length > a.maxQueue) {
      merged.shift();
      gone += 1;
    }
    queue = merged;
    drop(gone);
  }

  function settle(batch, sentAt, r) {
    if (state === STATE.STOPPED) return;
    state = STATE.RUNNING;
    inFlightKeys = null;
    if (r && r.ok === true) {
      heldByKey = {};
      counts.sent += 1;
      metric((t) => t.count(METRIC_SENT, 1));
    } else {
      const reason = r && typeof r.reason === "string" ? r.reason : "NET_ERROR";
      lastError = { reason };
      if (r && Number.isInteger(r.status)) lastError.status = r.status;
      if (r && typeof r.code === "string") lastError.code = r.code;
      counts.failed += 1;
      metric((t) => t.count(METRIC_FAILED, 1));
      if (a.logFailures === true) {
        const extra = `${lastError.status !== undefined ? ` status=${lastError.status}` : ""}`
          + `${lastError.code !== undefined ? ` code=${lastError.code}` : ""}`;
        logOnce(`SEND_${reason}${extra}`, `alerts: send failed - ${reason}${extra} host=${host}`);
      }
      requeue(batch, sentAt);
      heldByKey = {};
    }
    queueGauge();
  }

  function bodyOf(batch, nowMs) {
    const spec = { format: a.format, serverLabel: a.serverLabel, wallMs: nowMs, uptimeSeconds: uptime(),
      maxBodyBytes: a.maxBodyBytes };
    const items = [...batch];
    const back = [];
    while (items.length > 0) {
      const built = buildPayload(items, spec);
      if (built.ok) {
        queue = [...back.reverse(), ...queue];
        return { items, body: built.body };
      }
      if (items.length === 1) break;
      back.push(items.pop());
    }
    queue = [...back.reverse(), ...queue];
    drop(items.length);
    logOnce("BODY_TOO_LARGE", `alerts: event dropped - BODY_TOO_LARGE (alerts.maxBodyBytes=${a.maxBodyBytes})`);
    return null;
  }

  function dispatch(batch, nowMs) {
    const built = bodyOf(batch, nowMs);
    if (!built) return;
    state = STATE.SENDING;
    lastSendAtMs = nowMs;
    inFlightKeys = new Set(built.items.map((e) => e.key));
    heldByKey = {};
    let pending;
    try {
      pending = Promise.resolve(send(url, built.body, a.timeoutMs));
    } catch (err) {
      pending = Promise.resolve({ ok: false, reason: "NET_ERROR", code: codeOf(err) });
    }
    pending.then((r) => settle(built.items, nowMs, r), () => settle(built.items, nowMs, { ok: false, reason: "NET_ERROR" }));
  }

  function runPass() {
    if (state === STATE.STOPPED) return;
    const nowMs = wallNow();
    const cur = observe(ctx);
    const events = detectEvents(prev, cur, { alarmIds, notifyBoot: a.notifyBoot === true });
    prev = cur;
    if (events.length > 0) metric((t) => t.count(METRIC_EVENTS, events.length));
    const plan = planDelivery({ queue, lastSentByKey, lastSendAtMs, sending: state === STATE.SENDING }, events, nowMs, p);
    queue = plan.queue;
    lastSentByKey = plan.lastSentByKey;
    drop(plan.dropped);
    if (plan.suppressed > 0) {
      counts.suppressed += plan.suppressed;
      metric((t) => t.count(METRIC_SUPPRESSED, plan.suppressed));
      if (state === STATE.SENDING && inFlightKeys !== null) {
        for (const [key, s] of Object.entries(plan.suppressedByKey || {})) {
          if (!inFlightKeys.has(key)) continue;
          heldByKey[key] = { count: (heldByKey[key] ? heldByKey[key].count : 0) + s.count, text: s.text };
        }
      }
    }
    if (plan.batch) dispatch(plan.batch, nowMs);
    queueGauge();
  }

  const poller = createPoller({ runPass, intervalMs: a.pollMs, now: wallNow, setTimer: deps.setTimer,
    onError: (err) => logOnce(`PASS_${codeOf(err)}`, `alerts: poll failed - ${codeOf(err)}`) });

  metric((t) => {
    for (const name of [METRIC_SENT, METRIC_FAILED, METRIC_DROPPED, METRIC_SUPPRESSED, METRIC_EVENTS]) t.count(name, 0);
    t.gauge(METRIC_QUEUE, 0);
  });
  poller.start();
  poller.arm(0);
  log(`alerts: running host=${host} format=${a.format} pollMs=${a.pollMs} minSendIntervalMs=${a.minSendIntervalMs} `
    + `repeatMs=${a.repeatMs} alarms=${alarmIds.length}`);

  return Object.freeze({
    getStatus() {
      return { state, queue: queue.length, counts: { ...counts }, lastSendAtMs,
        lastError: lastError ? { ...lastError } : null, host };
    },
    stop(reason) {
      if (state === STATE.STOPPED) return;
      state = STATE.STOPPED;
      poller.stop();
      log(`alerts: stopped (${String(reason || "stop").replace(/[^A-Za-z0-9_.:-]/g, "_")}) queue=${queue.length}`);
      queue = [];
    },
    pollNow() {
      runPass();
    },
  });
}

module.exports = { startAlerts, observe, ALERTS_STATE: STATE };
