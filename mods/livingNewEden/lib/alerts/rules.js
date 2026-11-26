"use strict";

const { ALARMS } = require("../telemetry/snapshot");

const KINDS = Object.freeze(["BOOT", "ALARM", "SHED", "PROBE_DRIFT", "SERVICES_REFUSED", "SERVICE_FAILED",
  "RESTART_GUARD_TRIPPED"]);
const GUARD_REFUSAL = "crash_loop_guard";
const LEVEL_RANK = Object.freeze({ error: 0, warn: 1, info: 2 });
const FORMATS = Object.freeze(["json", "discord", "slack"]);
const SOURCE = "livingNewEden";
const CHAT_MAX_CHARS = 1900;
const CODE_MAX_CHARS = 64;
const AFFECTS_MAX = 10;
const NOT_A_REFUSAL = "disabled_by_config";
const ALARM_BY_ID = Object.freeze(Object.fromEntries(ALARMS.map((a) => [a.id, a])));

function codeOf(value) {
  const text = String(value === undefined || value === null ? "" : value).replace(/[^A-Za-z0-9_.:|-]/g, "_");
  return text.slice(0, CODE_MAX_CHARS) || "unknown";
}

function event(kind, id, level, count, text) {
  return { kind, key: `${kind}:${id}`, level, count, text };
}

function countOf(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function detectEvents(prev, cur, p) {
  const out = [];
  const first = prev === null || prev === undefined;
  if (first) {
    if (p.notifyBoot === true) {
      const unclean = cur.boot && cur.boot.unclean === true;
      out.push(event("BOOT", "start", "info", 1, unclean ? "server started after an unclean stop" : "server started"));
    }
    const probe = cur.probe;
    if (probe && countOf(probe.drift) + countOf(probe.missing) > 0) {
      const affects = (Array.isArray(probe.affects) ? probe.affects : []).slice(0, AFFECTS_MAX).map(codeOf);
      out.push(event("PROBE_DRIFT", "probe", "warn", 1, `probe: ${countOf(probe.drift)} drift, `
        + `${countOf(probe.missing)} missing; modules off: ${affects.length > 0 ? affects.join(",") : "none"}`));
    }
    const tripped = Boolean(cur.boot && cur.boot.tripped === true);
    if (tripped) {
      const starts = countOf(cur.boot.streak) + 1;
      out.push(event("RESTART_GUARD_TRIPPED", "guard", "error", 1, `restart guard: ${starts} starts without a clean `
        + "stop - world services not started; reset: delete runtime/boots.json"));
    }
    if (typeof cur.refusal === "string" && cur.refusal !== "" && cur.refusal !== NOT_A_REFUSAL
      && !(tripped && cur.refusal === GUARD_REFUSAL)) {
      const reason = codeOf(cur.refusal);
      out.push(event("SERVICES_REFUSED", reason, "error", 1, `services not started - ${reason}`));
    }
  }
  const sameSeq = !first && cur.seq !== null && cur.seq === prev.seq;
  if (!first && !sameSeq) {
    const before = prev.alarms || {};
    const now = cur.alarms || {};
    for (const id of p.alarmIds) {
      const delta = countOf(now[id]) - countOf(before[id]);
      if (delta <= 0) continue;
      const alarm = ALARM_BY_ID[id];
      if (!alarm) continue;
      out.push(event("ALARM", alarm.id, alarm.level, delta, `${alarm.message} (total ${countOf(now[id])})`));
    }
    const shed = countOf(cur.shedEscalations) - countOf(prev.shedEscalations);
    if (shed > 0) out.push(event("SHED", "governor", "warn", shed, "governor escalated to SHED (p95 tick unplayable)"));
  }
  const prevFailed = first ? [] : (prev.failed || []);
  for (const f of cur.failed || []) {
    if (prevFailed.some((x) => x.name === f.name && x.reason === f.reason)) continue;
    const name = codeOf(f.name);
    const reason = codeOf(f.reason);
    out.push(event("SERVICE_FAILED", `${name}:${reason}`, "error", 1, `service ${name} failed - ${reason}`));
  }
  return out;
}

function rankOf(e) {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, e.level) ? LEVEL_RANK[e.level] : LEVEL_RANK.info;
}

function planDelivery(st, incoming, nowMs, p) {
  const queue = (st.queue || []).map((e) => ({ ...e }));
  const last = {};
  for (const [key, at] of Object.entries(st.lastSentByKey || {})) {
    if (nowMs - at < p.repeatMs) last[key] = at;
  }
  let dropped = 0;
  let suppressed = 0;
  const suppressedByKey = {};
  for (const ev of incoming || []) {
    const queued = queue.find((e) => e.key === ev.key);
    if (queued) {
      queued.count += ev.count;
      queued.text = ev.text;
      continue;
    }
    if (last[ev.key] !== undefined) {
      suppressed += 1;
      const held = suppressedByKey[ev.key];
      suppressedByKey[ev.key] = { count: (held ? held.count : 0) + ev.count, text: ev.text };
      continue;
    }
    queue.push({ ...ev });
  }
  while (queue.length > p.maxQueue) {
    queue.shift();
    dropped += 1;
  }
  let batch = null;
  const due = st.lastSendAtMs === null || st.lastSendAtMs === undefined || nowMs - st.lastSendAtMs >= p.minSendIntervalMs;
  if (st.sending !== true && queue.length > 0 && due) {
    const picked = queue.map((e, i) => [e, i])
      .sort((a, b) => rankOf(a[0]) - rankOf(b[0]) || a[1] - b[1])
      .slice(0, p.maxEventsPerMessage);
    const taken = new Set(picked.map(([, i]) => i));
    batch = picked.map(([e]) => e);
    for (const e of batch) last[e.key] = nowMs;
    return { queue: queue.filter((_e, i) => !taken.has(i)), dropped, suppressed, suppressedByKey, batch,
      lastSentByKey: last };
  }
  return { queue, dropped, suppressed, suppressedByKey, batch, lastSentByKey: last };
}

function lineOf(e, server) {
  return `[LNE ${server}] ${String(e.level).toUpperCase()} ${e.kind} ${e.key} x${e.count} - ${e.text}`;
}

function chatText(lines) {
  const all = lines.join("\n");
  if (all.length <= CHAT_MAX_CHARS) return all;
  let shown = [];
  for (let i = 0; i < lines.length; i += 1) {
    const next = [...shown, lines[i]];
    const rest = lines.length - next.length;
    const text = rest > 0 ? `${next.join("\n")}\n… +${rest}` : next.join("\n");
    if (text.length > CHAT_MAX_CHARS) break;
    shown = next;
  }
  if (shown.length === 0) {
    const suffix = `\n… +${lines.length - 1}`;
    shown = [lines[0].slice(0, CHAT_MAX_CHARS - suffix.length)];
  }
  const rest = lines.length - shown.length;
  return rest > 0 ? `${shown.join("\n")}\n… +${rest}` : shown.join("\n");
}

function buildPayload(batch, p) {
  const server = String(p.serverLabel);
  let body;
  if (p.format === "discord" || p.format === "slack") {
    const text = chatText(batch.map((e) => lineOf(e, server)));
    body = JSON.stringify(p.format === "discord" ? { content: text } : { text });
  } else {
    body = JSON.stringify({
      source: SOURCE,
      server,
      at: new Date(p.wallMs).toISOString(),
      uptimeSeconds: Math.max(0, Math.round(p.uptimeSeconds)),
      events: batch.map((e) => ({ kind: e.kind, key: e.key, level: e.level, count: e.count, text: e.text })),
    });
  }
  if (Buffer.byteLength(body, "utf8") > p.maxBodyBytes) return { ok: false, reason: "BODY_TOO_LARGE" };
  return { ok: true, body };
}

function checkWebhookUrl(text, allowPlainHttp) {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "URL_EMPTY" };
  let url;
  try {
    url = new URL(text.trim());
  } catch (_err) {
    return { ok: false, reason: "URL_INVALID" };
  }
  if (url.protocol !== "https:" && !(allowPlainHttp === true && url.protocol === "http:")) {
    return { ok: false, reason: "URL_SCHEME" };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "URL_CREDENTIALS" };
  if (url.hostname === "") return { ok: false, reason: "URL_INVALID" };
  return { ok: true, url };
}

module.exports = { KINDS, FORMATS, LEVEL_RANK, CHAT_MAX_CHARS, codeOf, detectEvents, planDelivery, buildPayload,
  checkWebhookUrl };
