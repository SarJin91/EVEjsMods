"use strict";

const LINE_MARKER = "telemetry: stall-diag ";
const MAX_LABEL_CHARS = 80;
const OVERFLOW_LABEL = "other";
const KILLMAIL_PREFIX = "vendor:killmail.getAll";
const JOB_PREFIX = "job:";
const VENDOR_PREFIX = "vendor:";
const MS_PER_MINUTE = 60000;

const METRIC_SLOW_TIMER = "telemetry.stallDiag.slowTimer";
const METRIC_SLOW_JOB = "telemetry.stallDiag.slowJob";
const METRIC_KILLMAIL_CLONE = "telemetry.stallDiag.killmailClone";
const METRIC_VENDOR_PAUSE = "telemetry.stallDiag.vendorPause";
const METRIC_CAPTURE_SKIPPED = "telemetry.stallDiag.captureSkipped";
const METRIC_LABEL_OVERFLOW = "telemetry.stallDiag.labelOverflow";
const METRIC_PROFILE_STARTED = "telemetry.stallDiag.profileStarted";
const METRIC_PROFILE_FAILED = "telemetry.stallDiag.profileFailed";
const METRIC_NAMES = Object.freeze([METRIC_SLOW_TIMER, METRIC_SLOW_JOB, METRIC_KILLMAIL_CLONE, METRIC_VENDOR_PAUSE,
  METRIC_CAPTURE_SKIPPED, METRIC_LABEL_OVERFLOW, METRIC_PROFILE_STARTED, METRIC_PROFILE_FAILED]);

function noop() {}

function isTime(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function isDuration(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function positiveInt(n, fallback) {
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
}

function overlap(aStart, aEnd, bStart, bEnd) {
  const ms = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  return ms > 0 ? ms : 0;
}

function mergeSpans(spans) {
  const sorted = spans.filter((s) => Array.isArray(s) && isTime(s[0]) && isTime(s[1]) && s[1] > s[0])
    .map((s) => [s[0], s[1]]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of sorted) {
    const top = merged.length > 0 ? merged[merged.length - 1] : null;
    if (top !== null && s <= top[1]) top[1] = Math.max(top[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function minusMs(a, b) {
  let ms = 0;
  for (const [s, e] of a) {
    let covered = 0;
    for (const [bs, be] of b) covered += overlap(s, e, bs, be);
    ms += Math.max(0, e - s - covered);
  }
  return ms;
}

function labelText(label) {
  return (typeof label === "string" && label !== "" ? label : "unknown").slice(0, MAX_LABEL_CHARS);
}

function metricOf(label) {
  if (label.startsWith(KILLMAIL_PREFIX)) return METRIC_KILLMAIL_CLONE;
  if (label.startsWith(JOB_PREFIX)) return METRIC_SLOW_JOB;
  if (label.startsWith(VENDOR_PREFIX)) return METRIC_VENDOR_PAUSE;
  return METRIC_SLOW_TIMER;
}

function createStallDiag(o) {
  const opts = o || {};
  const ringSize = positiveInt(opts.ringSize, 512);
  const maxLabels = positiveInt(opts.maxLabels, 64);
  const maxOpsPerLine = positiveInt(opts.maxOpsPerLine, 6);
  const slowCallbackMs = isDuration(opts.slowCallbackMs) ? opts.slowCallbackMs : 50;
  const countFn = typeof opts.count === "function" ? opts.count : noop;
  const summaryMinutes = Number.isSafeInteger(opts.summaryMinutes) && opts.summaryMinutes >= 0
    ? opts.summaryMinutes : 5;
  const trigger = opts.profileTrigger && typeof opts.profileTrigger.fire === "function" ? opts.profileTrigger : null;

  const fStart = new Float64Array(ringSize);
  const fEnd = new Float64Array(ringSize);
  const fLabel = new Array(ringSize).fill("");
  let fWrites = 0;
  const jAt = new Float64Array(ringSize);
  const jType = new Array(ringSize).fill("");
  let jWrites = 0;
  const gaps = [];

  let recorded = 0;
  let overflow = 0;
  let untimedTotal = 0;
  let restTotal = 0;
  let window = null;
  const knownJobs = new Set();

  function newWindow() {
    return { labels: new Map(), jobs: new Map(), killmail: { n: 0, sumMs: 0, maxMs: 0 }, spikes: 0, restMs: 0,
      untimedMs: 0 };
  }
  window = newWindow();

  function count(name, n) {
    try {
      countFn(name, n);
    } catch (_err) {
    }
  }

  function slotOf(map, label, make) {
    let slot = map.get(label);
    if (slot !== undefined) return slot;
    if (map.size >= maxLabels) {
      overflow += 1;
      count(METRIC_LABEL_OVERFLOW, 1);
      slot = map.get(OVERFLOW_LABEL);
      if (slot === undefined) {
        slot = make();
        map.set(OVERFLOW_LABEL, slot);
      }
      return slot;
    }
    slot = make();
    map.set(label, slot);
    return slot;
  }

  function noteForeign(label, startMs, ms) {
    try {
      if (!isTime(startMs) || !isDuration(ms)) return;
      const text = labelText(label);
      if (text.startsWith(KILLMAIL_PREFIX)) {
        const k = window.killmail;
        k.n += 1;
        k.sumMs += ms;
        if (ms > k.maxMs) k.maxMs = ms;
      }
      if (ms < slowCallbackMs) return;
      const i = fWrites % ringSize;
      fStart[i] = startMs;
      fEnd[i] = startMs + ms;
      fLabel[i] = text;
      fWrites += 1;
      recorded += 1;
      const slot = slotOf(window.labels, text, () => ({ sumMs: 0, n: 0, maxMs: 0 }));
      slot.sumMs += ms;
      slot.n += 1;
      if (ms > slot.maxMs) slot.maxMs = ms;
      count(metricOf(text), 1);
    } catch (_err) {
    }
  }

  function noteJob(type, atMs, ms) {
    try {
      if (!isTime(atMs)) return;
      const text = labelText(type);
      const i = jWrites % ringSize;
      jAt[i] = atMs;
      jType[i] = text;
      jWrites += 1;
      knownJobs.add(text);
      const slot = slotOf(window.jobs, text, () => ({ n: 0, syncMs: 0 }));
      slot.n += 1;
      if (isDuration(ms)) slot.syncMs += ms;
    } catch (_err) {
    }
  }

  function noteGap(gs, ge) {
    if (gaps.length >= ringSize) gaps.shift();
    gaps.push([gs, ge]);
  }

  function maybeTrigger(gs, parts) {
    if (trigger === null || parts.source !== "unattributed") return;
    if (!(parts.restMs >= trigger.restMs)) return;
    const graceEnd = typeof trigger.bootGraceEndsAtMs === "function" ? trigger.bootGraceEndsAtMs() : -Infinity;
    if (gs < graceEnd) return;
    try {
      trigger.fire(`rest=${Math.round(parts.restMs)}`);
    } catch (_err) {
    }
  }

  function suffixForGap(gs, ge, parts) {
    try {
      const p = parts || {};
      const restMs = isDuration(p.restMs) ? p.restMs : 0;
      if (p.source === "unattributed") noteGap(gs, ge);
      const byLabel = new Map();
      const spans = [];
      const fN = Math.min(fWrites, ringSize);
      for (let k = 0; k < fN; k += 1) {
        const ms = overlap(fStart[k], fEnd[k], gs, ge);
        if (ms <= 0) continue;
        byLabel.set(fLabel[k], (byLabel.get(fLabel[k]) || 0) + ms);
        spans.push([Math.max(fStart[k], gs), Math.min(fEnd[k], ge)]);
      }
      const jobs = new Map();
      const jN = Math.min(jWrites, ringSize);
      for (let k = 0; k < jN; k += 1) {
        if (jAt[k] < gs || jAt[k] > ge) continue;
        jobs.set(jType[k], (jobs.get(jType[k]) || 0) + 1);
      }
      const known = [...(p.lneSpans || []), ...(p.gcSpans || [])];
      if (Array.isArray(p.tickSpan)) known.push(p.tickSpan);
      const foreignMs = minusMs(mergeSpans(spans), mergeSpans(known));
      const untimedMs = Math.max(0, restMs - foreignMs);
      window.spikes += 1;
      window.restMs += restMs;
      window.untimedMs += untimedMs;
      restTotal += restMs;
      untimedTotal += untimedMs;
      maybeTrigger(gs, p);
      if (recorded === 0 && knownJobs.size === 0) return "";
      const shown = [...byLabel.entries()].sort((a, b) => b[1] - a[1]);
      const diag = shown.slice(0, maxOpsPerLine).map(([label, ms]) => `${label}/${Math.round(ms)}`);
      const more = shown.length > maxOpsPerLine ? `,+${shown.length - maxOpsPerLine}` : "";
      const jobText = [...jobs.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxOpsPerLine)
        .map(([type, n]) => `${type}:${n}`);
      return ` diag=${diag.length > 0 ? diag.join(",") : "-"}${more}`
        + `${jobText.length > 0 ? ` jobs=${jobText.join(",")}` : ""} untimed=${Math.round(untimedMs)}`;
    } catch (_err) {
      return "";
    }
  }

  function summaryLine(loop, cost) {
    const c = cost || {};
    const r = (n) => Math.round(isDuration(n) ? n : 0);
    const top = [...window.labels.entries()].sort((a, b) => b[1].sumMs - a[1].sumMs).slice(0, maxOpsPerLine)
      .map(([label, s]) => `${label}/${r(s.sumMs)}/${s.n}/max${r(s.maxMs)}`);
    const jobs = [...window.jobs.entries()].sort((a, b) => b[1].syncMs - a[1].syncMs).slice(0, maxOpsPerLine)
      .map(([type, s]) => `${type}:${s.n}/${r(s.syncMs)}`);
    const k = window.killmail;
    const loopText = loop && typeof loop === "object"
      ? `p50:${r(loop.p50)},p99:${r(loop.p99)},max:${r(loop.max)}` : "-";
    return `${LINE_MARKER}window=${summaryMinutes}m state=${typeof c.state === "string" ? c.state : "on"}`
      + ` top=${top.length > 0 ? top.join(",") : "-"} jobs=${jobs.length > 0 ? jobs.join(",") : "-"}`
      + ` killmail=${k.n}/${r(k.sumMs)}/max${r(k.maxMs)} loop=${loopText} spikes=${window.spikes}`
      + ` rest=${r(window.restMs)} untimed=${r(window.untimedMs)}`
      + ` cost=captures:${r(c.captures)}/skipped:${r(c.skipped)}/${r(c.captureMs)}`;
  }

  function resetWindow() {
    window = newWindow();
    gaps.length = 0;
  }

  function unattributedGaps() {
    return gaps.map((g) => [g[0], g[1]]);
  }

  function windowMs() {
    return summaryMinutes * MS_PER_MINUTE;
  }

  function getStatus() {
    return { enabled: true, recorded, labels: window.labels.size, overflow, untimedMs: Math.round(untimedTotal),
      restMs: Math.round(restTotal) };
  }

  return Object.freeze({ noteForeign, noteJob, suffixForGap, summaryLine, resetWindow, unattributedGaps, windowMs,
    getStatus });
}

module.exports = { LINE_MARKER, METRIC_NAMES, METRIC_CAPTURE_SKIPPED, METRIC_PROFILE_STARTED, METRIC_PROFILE_FAILED,
  createStallDiag };
