"use strict";

const OP_KINDS = Object.freeze(["tx", "checkpoint", "sched", "trade", "observer", "telemetry", "adapter"]);
const SOURCES = Object.freeze(["lne", "gc", "evejsTick", "unattributed", "boot"]);
const ARGMAX_SOURCES = Object.freeze(["lne", "gc", "evejsTick", "unattributed"]);
const MAX_LABEL_CHARS = 80;
const LINE_MARKER = "telemetry: spike ";

const METRIC_SPIKES = "telemetry.spikes";
const METRIC_SPIKE_DROPPED = "telemetry.spikeDropped";
const METRIC_SPIKE_TRUNCATED = "telemetry.spikeTruncated";
const METRIC_SOURCE_LNE = "telemetry.spikeSource.lne";
const METRIC_SOURCE_GC = "telemetry.spikeSource.gc";
const METRIC_SOURCE_EVEJS_TICK = "telemetry.spikeSource.evejsTick";
const METRIC_SOURCE_UNATTRIBUTED = "telemetry.spikeSource.unattributed";
const METRIC_SOURCE_BOOT = "telemetry.spikeSource.boot";
const METRIC_LNE_TX = "telemetry.spikeLne.tx";
const METRIC_LNE_CHECKPOINT = "telemetry.spikeLne.checkpoint";
const METRIC_LNE_SCHED = "telemetry.spikeLne.sched";
const METRIC_LNE_TRADE = "telemetry.spikeLne.trade";
const METRIC_LNE_OBSERVER = "telemetry.spikeLne.observer";
const METRIC_LNE_TELEMETRY = "telemetry.spikeLne.telemetry";
const METRIC_LNE_ADAPTER = "telemetry.spikeLne.adapter";
const SOURCE_METRIC = Object.freeze({ lne: METRIC_SOURCE_LNE, gc: METRIC_SOURCE_GC,
  evejsTick: METRIC_SOURCE_EVEJS_TICK, unattributed: METRIC_SOURCE_UNATTRIBUTED, boot: METRIC_SOURCE_BOOT });
const LNE_KIND_METRIC = Object.freeze({ tx: METRIC_LNE_TX, checkpoint: METRIC_LNE_CHECKPOINT, sched: METRIC_LNE_SCHED,
  trade: METRIC_LNE_TRADE, observer: METRIC_LNE_OBSERVER, telemetry: METRIC_LNE_TELEMETRY, adapter: METRIC_LNE_ADAPTER });

function noop() {}

function isTime(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function isDuration(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function overlap(aStart, aEnd, bStart, bEnd) {
  const ms = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  return ms > 0 ? ms : 0;
}

function positiveInt(n, fallback) {
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
}

function createSpikeAttribution(opts) {
  const o = opts || {};
  const thresholdMs = isDuration(o.thresholdMs) && o.thresholdMs > 0 ? o.thresholdMs : Infinity;
  const ringSize = positiveInt(o.ringSize, 512);
  const maxPending = positiveInt(o.maxPending, 64);
  const maxOpsPerLine = positiveInt(o.maxOpsPerLine, 6);
  const perfNow = typeof o.perfNow === "function" ? o.perfNow : () => 0;
  const wallNow = typeof o.wallNow === "function" ? o.wallNow : () => 0;
  const log = typeof o.log === "function" ? o.log : noop;
  const countFn = typeof o.count === "function" ? o.count : noop;
  const bootGraceEndsAtMs = typeof o.bootGraceEndsAtMs === "function" ? o.bootGraceEndsAtMs : () => -Infinity;
  const extraSuffix = typeof o.extraSuffix === "function" ? o.extraSuffix : null;

  const opStart = new Float64Array(ringSize);
  const opEnd = new Float64Array(ringSize);
  const opKind = new Array(ringSize).fill("");
  const opLabel = new Array(ringSize).fill("");
  let opWrites = 0;
  const gcStart = new Float64Array(ringSize);
  const gcEnd = new Float64Array(ringSize);
  const gcKind = new Array(ringSize).fill("");
  let gcWrites = 0;
  const pGapStart = new Float64Array(maxPending);
  const pGapEnd = new Float64Array(maxPending);
  const pInterval = new Float64Array(maxPending);
  const pLateness = new Float64Array(maxPending);
  const pPrevWork = new Float64Array(maxPending);
  let pending = 0;
  let prevWorkMs = 0;
  let lastResolveAt = null;

  let total = 0;
  let dropped = 0;
  let truncatedTotal = 0;
  const bySource = {};
  for (const s of SOURCES) bySource[s] = 0;
  const byLneKind = {};
  for (const k of OP_KINDS) byLneKind[k] = 0;
  let last = null;

  function count(name, n) {
    try {
      countFn(name, n);
    } catch (_err) {
    }
  }

  function onTick(sample) {
    if (!sample) return;
    const workMs = sample.workMs;
    const prev = prevWorkMs;
    prevWorkMs = isDuration(workMs) ? workMs : 0;
    const intervalMs = sample.intervalMs;
    const atMs = sample.atMs;
    if (!isDuration(intervalMs) || !(intervalMs >= thresholdMs) || !isTime(atMs)) return;
    if (pending >= maxPending) {
      dropped += 1;
      count(METRIC_SPIKE_DROPPED, 1);
      return;
    }
    const lateness = sample.latenessMs;
    pGapStart[pending] = atMs - intervalMs;
    pGapEnd[pending] = atMs;
    pInterval[pending] = intervalMs;
    pLateness[pending] = isDuration(lateness) && lateness <= intervalMs ? lateness : 0;
    pPrevWork[pending] = prev;
    pending += 1;
  }

  function noteOp(kind, label, startMs, durationMs) {
    if (!isTime(startMs) || !isDuration(durationMs) || !OP_KINDS.includes(kind)) return;
    const i = opWrites % ringSize;
    opStart[i] = startMs;
    opEnd[i] = startMs + durationMs;
    opKind[i] = kind;
    opLabel[i] = typeof label === "string" ? label : "";
    opWrites += 1;
  }

  function noteGc(kind, startMs, durationMs) {
    if (!isTime(startMs) || !isDuration(durationMs)) return;
    const i = gcWrites % ringSize;
    gcStart[i] = startMs;
    gcEnd[i] = startMs + durationMs;
    gcKind[i] = typeof kind === "string" ? kind : "unknown";
    gcWrites += 1;
  }

  function ringTruncated(writes, starts, gapStart) {
    if (writes <= ringSize) return false;
    return starts[writes % ringSize] > gapStart;
  }

  function settle(i) {
    const gs = pGapStart[i];
    const ge = pGapEnd[i];
    const intervalMs = pInterval[i];
    const latenessMs = pLateness[i];
    const prevWork = pPrevWork[i];
    const nominal = intervalMs - latenessMs;

    const gcs = [];
    let gcMs = 0;
    const gcN = Math.min(gcWrites, ringSize);
    for (let k = 0; k < gcN; k += 1) {
      const ms = overlap(gcStart[k], gcEnd[k], gs, ge);
      if (ms <= 0) continue;
      gcMs += ms;
      gcs.push([Math.max(gcStart[k], gs), Math.min(gcEnd[k], ge)]);
    }
    let gcInWork = 0;
    for (const [s, e] of gcs) gcInWork += overlap(s, e, gs, gs + prevWork);
    const tickWorkMs = Math.max(0, prevWork - gcInWork);

    const ops = [];
    const opN = Math.min(opWrites, ringSize);
    for (let k = 0; k < opN; k += 1) {
      const ms = overlap(opStart[k], opEnd[k], gs, ge);
      if (ms <= 0) continue;
      ops.push({ kind: opKind[k], label: opLabel[k], ms, s: Math.max(opStart[k], gs), e: Math.min(opEnd[k], ge) });
    }
    const spans = ops.map((op) => [op.s, op.e]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of spans) {
      const top = merged.length > 0 ? merged[merged.length - 1] : null;
      if (top !== null && s <= top[1]) top[1] = Math.max(top[1], e);
      else merged.push([s, e]);
    }
    let unionMs = 0;
    let unionGcMs = 0;
    for (const [s, e] of merged) {
      unionMs += e - s;
      for (const [gs2, ge2] of gcs) unionGcMs += overlap(s, e, gs2, ge2);
    }
    const lneMs = Math.max(0, unionMs - unionGcMs);
    const tickExcess = Math.max(0, tickWorkMs - nominal);
    const restMs = Math.max(0, latenessMs - tickExcess - gcMs - lneMs);

    const scores = { lne: lneMs, gc: gcMs, evejsTick: tickExcess, unattributed: restMs };
    let source = SOURCES[0];
    for (const s of ARGMAX_SOURCES) if (scores[s] > scores[source]) source = s;
    if (gs < bootGraceEndsAtMs()) source = "boot";

    const kindMs = {};
    for (const op of ops) kindMs[op.kind] = (kindMs[op.kind] || 0) + op.ms;
    let topKind = null;
    for (const k of OP_KINDS) if (kindMs[k] > 0 && (topKind === null || kindMs[k] > kindMs[topKind])) topKind = k;

    const truncated = ringTruncated(opWrites, opStart, gs) || ringTruncated(gcWrites, gcStart, gs);

    total += 1;
    bySource[source] += 1;
    count(METRIC_SPIKES, 1);
    count(SOURCE_METRIC[source], 1);
    if (source === "lne" && topKind !== null) {
      byLneKind[topKind] += 1;
      count(LNE_KIND_METRIC[topKind], 1);
    }
    if (truncated) {
      truncatedTotal += 1;
      count(METRIC_SPIKE_TRUNCATED, 1);
    }

    const atWallMs = wallNow() - (perfNow() - ge);
    last = { atWallMs, intervalMs, source, tickWorkMs, gcMs, lneMs, restMs };

    ops.sort((a, b) => b.ms - a.ms);
    const shown = ops.slice(0, maxOpsPerLine)
      .map((op) => `${op.kind}:${op.label.slice(0, MAX_LABEL_CHARS)}/${Math.round(op.ms)}`);
    const more = ops.length > maxOpsPerLine ? `,+${ops.length - maxOpsPerLine}` : "";
    let at;
    try {
      at = new Date(atWallMs).toISOString();
    } catch (_err) {
      at = "-";
    }
    let extra = "";
    if (extraSuffix !== null) {
      try {
        const text = extraSuffix(gs, ge, { lneSpans: merged, gcSpans: gcs, tickSpan: [gs, gs + prevWork], restMs,
          source });
        if (typeof text === "string") extra = text;
      } catch (_err) {
      }
    }
    log(`${LINE_MARKER}${Math.round(intervalMs)}ms at=${at} source=${source} tickWork=${Math.round(tickWorkMs)}`
      + ` gc=${Math.round(gcMs)}/${gcs.length} lne=${Math.round(lneMs)} rest=${Math.round(restMs)}`
      + ` ops=${shown.length > 0 ? shown.join(",") : "-"}${more}${extra}${truncated ? " truncated" : ""}`);
  }

  function resolve(nowPerfMs) {
    if (!isTime(nowPerfMs)) return 0;
    if (lastResolveAt === null) {
      lastResolveAt = nowPerfMs;
      return 0;
    }
    const cutoff = lastResolveAt;
    lastResolveAt = nowPerfMs;
    let resolved = 0;
    let w = 0;
    for (let i = 0; i < pending; i += 1) {
      if (pGapEnd[i] <= cutoff) {
        try {
          settle(i);
        } catch (_err) {
        }
        resolved += 1;
        continue;
      }
      if (w !== i) {
        pGapStart[w] = pGapStart[i];
        pGapEnd[w] = pGapEnd[i];
        pInterval[w] = pInterval[i];
        pLateness[w] = pLateness[i];
        pPrevWork[w] = pPrevWork[i];
      }
      w += 1;
    }
    pending = w;
    return resolved;
  }

  function getStatus() {
    return { enabled: true, thresholdMs, total, bySource: { ...bySource }, byLneKind: { ...byLneKind }, pending,
      dropped, truncated: truncatedTotal, last: last === null ? null : { ...last } };
  }

  return Object.freeze({ onTick, noteOp, noteGc, resolve, getStatus });
}

module.exports = { OP_KINDS, SOURCES, LINE_MARKER, createSpikeAttribution };
