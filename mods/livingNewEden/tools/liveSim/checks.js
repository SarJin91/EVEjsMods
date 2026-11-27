"use strict";

const { performance } = require("node:perf_hooks");

const { checkCampaignInvariants, snapshotForChecks } = require("../campaign/checks");

const CHECK_TX = "livesim.checks";
const SNAPSHOT_TX = "livesim.checks.snapshot";
const CHECK_RECORD_KIND = "checks";
const MIN_CHECK_WALL_MS = 250;
const MAX_TIMER_MS = 2 ** 31 - 1;
const FAIL_NAMES_MAX = 20;
const SOV_UNAVAILABLE_CHANNEL = "world";
const SOV_UNAVAILABLE_NAME = "invasions.sovUnavailable";

function messageOf(err) {
  return String((err && err.message) || err);
}

function storeOf(ctx) {
  const store = ctx && ctx.persistence && ctx.persistence.store;
  return store && typeof store.transaction === "function" ? store : null;
}

function txRefusal(r) {
  const detail = r && (r.detail || (r.error ? messageOf(r.error) : null));
  return { reason: (r && r.reason) || "TX_FAILED", ...(detail ? { detail: String(detail) } : {}) };
}

function graphOf(ctx) {
  try {
    const g = ctx && ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
    return g && g.ok ? g.graph : null;
  } catch (_err) {
    return null;
  }
}

function createOwnSpaceOf(graph) {
  const memo = new Map();
  return (f) => {
    if (!memo.has(f)) {
      memo.set(f, new Set(graph ? graph.getSystemIds().filter((id) => graph.getSystem(id).factionId === f) : []));
    }
    return memo.get(f);
  };
}

function sovUnavailableOf(ctx) {
  try {
    const snap = ctx && ctx.telemetry && typeof ctx.telemetry.getSnapshot === "function" ? ctx.telemetry.getSnapshot() : null;
    const channel = snap && snap.channels ? snap.channels[SOV_UNAVAILABLE_CHANNEL] : null;
    const v = channel ? channel[SOV_UNAVAILABLE_NAME] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch (_err) {
    return 0;
  }
}

function takeCheckSnapshot(ctx) {
  const store = storeOf(ctx);
  if (!store) return { ok: false, reason: "NO_STORE" };
  try {
    const r = store.transaction(SNAPSHOT_TX, (db) => snapshotForChecks(db));
    if (!r || r.ok !== true) return { ok: false, ...txRefusal(r) };
    return { ok: true, snap: r.value };
  } catch (err) {
    return { ok: false, reason: "CHECK_THREW", detail: messageOf(err) };
  }
}

function runLiveCheck(input, deps = {}) {
  const perfNow = typeof deps.perfNow === "function" ? deps.perfNow : () => performance.now();
  const t0 = perfNow();
  const elapsed = () => perfNow() - t0;
  try {
    const ctx = input.ctx;
    const store = storeOf(ctx);
    if (!store) return { ok: false, ms: elapsed(), reason: "NO_STORE" };
    const graph = graphOf(ctx);
    const checkCtx = { config: input.config, prev: input.prev || null, graph, ownSpaceOf: createOwnSpaceOf(graph),
      now: input.now, restarted: false, claimedAfterFirstPass: 0, sovUnavailable: sovUnavailableOf(ctx),
      disabledTables: [] };
    const tx = store.transaction(CHECK_TX, (db) => ({ result: checkCampaignInvariants(db, checkCtx),
      snap: snapshotForChecks(db) }));
    const ms = elapsed();
    if (!tx || tx.ok !== true) return { ok: false, ms, ...txRefusal(tx) };
    const { result, snap } = tx.value;
    if (!result || result.ok !== true) {
      return { ok: false, ms, reason: (result && result.reason) || "CHECK_FAILED",
        ...(result && result.detail ? { detail: String(result.detail) } : {}) };
    }
    return { ok: true, ms, result, snap };
  } catch (err) {
    return { ok: false, ms: elapsed(), reason: "CHECK_THREW", detail: messageOf(err) };
  }
}

function virtualIsoOf(virtualAt) {
  return new Date(virtualAt).toISOString();
}

function formatLiveCheck(r, virtualAt) {
  const v = `${virtualIsoOf(virtualAt).slice(0, 16)}Z`;
  const ms = `${Number(r.ms || 0).toFixed(0)}ms`;
  if (!r.ok) return `liveSim: checks ERROR ${r.reason}${r.detail ? ` ${r.detail}` : ""} v=${v} ${ms}`;
  const res = r.result;
  const notes = `notes=${(res.notes || []).length}`;
  if (res.pass === true) return `liveSim: checks PASS v=${v} ${ms} ${notes}`;
  const failing = res.failing || [];
  const parts = failing.slice(0, FAIL_NAMES_MAX).map((k) => `${k}=${res.counts[k]}`);
  if (failing.length > FAIL_NAMES_MAX) parts.push(`+${failing.length - FAIL_NAMES_MAX}`);
  if (parts.length === 0) parts.push("pass=false");
  return `liveSim: checks FAIL ${parts.join(" ")} v=${v} ${ms} ${notes}`;
}

function checkRecord(r, { wallAt, virtualAt }) {
  const head = { kind: CHECK_RECORD_KIND, wallAt, virtualAt, virtualIso: virtualIsoOf(virtualAt), ms: r.ms };
  if (!r.ok) return { ...head, ok: false, reason: r.reason, detail: r.detail === undefined ? null : r.detail };
  const res = r.result;
  const details = {};
  for (const k of res.failing) if (res.details && res.details[k] !== undefined) details[k] = res.details[k];
  return { ...head, ok: true, pass: res.pass, failing: res.failing, counts: res.counts, notes: res.notes, details };
}

function nextCheckDelayMs(nextAt, now, speed) {
  return Math.min(MAX_TIMER_MS, Math.max(MIN_CHECK_WALL_MS, Math.ceil((nextAt - now) / speed)));
}

function advanceCheckAt(prevAt, now, everyMs) {
  const next = prevAt + everyMs;
  return next <= now ? now + everyMs : next;
}

module.exports = { runLiveCheck, takeCheckSnapshot, formatLiveCheck, checkRecord, nextCheckDelayMs, advanceCheckAt,
  createOwnSpaceOf, graphOf, sovUnavailableOf, CHECK_RECORD_KIND, MIN_CHECK_WALL_MS, MAX_TIMER_MS };
