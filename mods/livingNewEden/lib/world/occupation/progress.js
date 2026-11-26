"use strict";

const S = require("./schema");
const M = require("./machine");
const SOV = require("../sovStructures/schema");

const PROBE_BASE = 50;
const PROBE_HOURS = 0.25;
const PROBE_MS = PROBE_HOURS * S.MS_PER_HOUR;
const RATIO_PER_MILLE = 1000;

const STATUS = Object.freeze({ ADVANCING: "ADVANCING", READY: "READY", BLOCKED: "BLOCKED", COUNTDOWN: "COUNTDOWN",
  REVERTING: "REVERTING" });
const BLOCKERS = Object.freeze(["NO_ATTACKER_FLEET", "FIELD_DISPUTED", "FIELD_LOST", "NO_GARRISON", "OUT_OF_RANGE",
  "RANGE_UNKNOWN", "DEFENDER_STATION", "SCORE_STALLED", "NO_CONSOLIDATION", "CORE_PROTECTED", "DATA_PENDING",
  "FLEETS_TRUNCATED", "SOV_FOREIGN_STRUCTURE", "SOV_SIEGE_OBSERVED"]);
const LIMIT_SOV = "SOV";
const LIMIT_TIME = "TIME";
const LIMIT_SCORE = "SCORE";
const LIMIT_DEFENDER = "DEFENDER";
const LIMIT_RESIDUAL = "RESIDUAL";

const strengthOf = (view, f) => (f !== null && view.presence.has(f) ? view.presence.get(f).strength : 0);
const stationsOf = (view, f) => (f !== null && view.stations.has(f) ? view.stations.get(f) : 0);
const inRange = (view, f) => f !== null && view.inRange(f) === true;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const alignUp = (t, interval) => Math.ceil(t / interval) * interval;

function ratesOf(view, H, ids, params) {
  const influence = new Map([...ids].map((f) => [f, { score: PROBE_BASE, garrison: 0 }]));
  const probe = { ...view, influence, evaluatedAt: 0, sinceAt: 0 };
  const scores = M.accrue(probe, H, PROBE_MS, params, []).scores;
  const rates = new Map();
  for (const f of ids) rates.set(f, scores.has(f) ? (scores.get(f) - PROBE_BASE) / PROBE_HOURS : 0);
  return rates;
}

function contextOf(view, params) {
  const at = Math.max(view.at, view.sinceAt, view.evaluatedAt ?? 0);
  const H = M.holderOf(view);
  const C = view.controller;
  const P = view.occupier;
  const acc = M.accrue(view, H, at, params, []);
  const ids = new Set(acc.scores.keys());
  for (const f of [P, C]) if (f !== null) ids.add(f);
  const rates = ratesOf(view, H, ids, params);
  const held = S.HELD_STATES.includes(view.state);
  const hostile = held && C !== null
    ? [...acc.scores.keys()].filter((f) => f !== C && view.isHostile(f, C)).sort((a, b) => a - b) : [];
  const heartland = view.capturedAt === null || view.capturedAt === undefined;
  const hostileHolderOfC = H !== null && C !== null && view.isHostile(H, C);
  const K = view.coreOwner ?? null;
  return { view, params, at, H, C, P, K, since: view.sinceAt, scores: acc.scores, rates, hostile,
    s: (f) => (f !== null && acc.scores.has(f) ? acc.scores.get(f) : 0),
    rate: (f) => (rates.has(f) ? rates.get(f) : 0),
    rangeP: inRange(view, P),
    rangeC: inRange(view, C),
    rangeKnown: view.rangeKnown !== false,
    rangeEffC: inRange(view, C) || heartland,
    interruptByH: hostileHolderOfC && !(K !== null && H !== K) };
}

function timeCondition(c, xMs) {
  return { limiting: LIMIT_TIME, ratio: xMs > 0 ? (c.at - c.since) / xMs : 1, ms: Math.max(0, c.since + xMs - c.at) };
}

function upCondition(c, limiting, f, thr) {
  const cur = c.s(f);
  const rate = c.rate(f);
  let ms = 0;
  if (cur < thr) ms = rate > 0 ? ((thr - cur) / rate) * S.MS_PER_HOUR : Infinity;
  return { limiting, ratio: thr > 0 ? cur / thr : 1, ms };
}

function downCondition(c, limiting, factions, thr) {
  let top = 0;
  let ms = 0;
  for (const f of factions) {
    const cur = c.s(f);
    top = Math.max(top, cur);
    if (cur <= thr) continue;
    const rate = c.rate(f);
    ms = Math.max(ms, rate < 0 ? ((cur - thr) / -rate) * S.MS_PER_HOUR : Infinity);
  }
  return { limiting, ratio: top <= thr ? 1 : thr / top, ms };
}

function rangeBlocker(c, blockers) {
  blockers.push(c.rangeKnown ? "OUT_OF_RANGE" : "RANGE_UNKNOWN");
}

const leftOf = (c, xMs) => Math.max(0, c.since + xMs - c.at);

function ruleRecon(c) {
  const { reconTimeoutMs } = c.params;
  const left = leftOf(c, reconTimeoutMs);
  const over = c.at >= c.since + reconTimeoutMs;
  return { next: null, conditions: [], blockers: [], fallback: { to: S.STABLE, etaMs: left },
    status: over ? STATUS.REVERTING : STATUS.COUNTDOWN, ratio: reconTimeoutMs > 0 ? left / reconTimeoutMs : 0 };
}

function ruleContested(c) {
  const { view, params, P, H } = c;
  const blockers = [];
  const out = { next: S.INVASION, conditions: [upCondition(c, LIMIT_SCORE, P, params.invasionMinScore)], blockers,
    fallback: null, status: null };
  if (strengthOf(view, P) === 0) {
    blockers.push("NO_ATTACKER_FLEET");
    out.fallback = { to: S.STABLE, etaMs: leftOf(c, params.contestTimeoutMs) };
    if (c.at >= c.since + params.contestTimeoutMs) out.status = STATUS.REVERTING;
  } else if (H !== P) blockers.push("FIELD_DISPUTED");
  if (!c.rangeP) rangeBlocker(c, blockers);
  return out;
}

function ruleInvasion(c) {
  const { view, params, P, C, H } = c;
  const blockers = [];
  const out = { next: S.OCCUPIED, blockers, fallback: null, status: null, conditions: [
    timeCondition(c, params.invasionHoldMs),
    upCondition(c, LIMIT_SCORE, P, params.occupyMinScore),
    downCondition(c, LIMIT_DEFENDER, C === null ? [] : [C], params.occupyMaxDefenderScore)] };
  if (H !== P) {
    blockers.push(strengthOf(view, P) === 0 ? "NO_ATTACKER_FLEET" : "FIELD_LOST");
    out.fallback = { to: S.CONTESTED, etaMs: null };
    out.status = STATUS.REVERTING;
    return out;
  }
  if (stationsOf(view, C) > 0 && params.requireNoDefenderStations === true) blockers.push("DEFENDER_STATION");
  if (!c.rangeP) rangeBlocker(c, blockers);
  const sov = sovCondition(c);
  if (sov !== null) {
    out.conditions.push(sov.condition);
    blockers.push(...sov.blockers);
    out.sov = sov.info;
  }
  return out;
}

function sovCondition(c) {
  const { view, P, C, at } = c;
  const sov = view.sov === undefined ? null : view.sov;
  if (sov === null || P === null || (view.home !== null && view.home !== undefined && P === view.home)) return null;
  if (typeof sov.needs === "function" && sov.needs(P) === false) return null;
  const live = (sov.structures || []).filter((s) => s.state === SOV.ANCHORING || s.state === SOV.ONLINE);
  const anchorMs = Number.isSafeInteger(sov.anchorMs) && sov.anchorMs > 0 ? sov.anchorMs : 0;
  const holdMs = Number.isSafeInteger(sov.siegeHoldMs) && sov.siegeHoldMs > 0 ? sov.siegeHoldMs : 0;
  const blockers = [];
  const own = live.find((s) => s.factionId === P) || null;
  const foreign = live.find((s) => s.factionId !== P) || null;
  let have = "none";
  let etaMs = null;
  let ms = anchorMs;
  let ratio = 0;
  if (foreign !== null) {
    if (foreign.factionId !== C) blockers.push(SOV.NOTES.FOREIGN);
    else {
      const left = foreign.attackerFactionId === P && Number.isSafeInteger(foreign.attackStartedAt)
        ? Math.max(0, foreign.attackStartedAt + holdMs - at) : holdMs;
      etaMs = left;
      ms = left + anchorMs;
      if (left === 0 && sov.observed === true && sov.pauseWhenObserved === true) blockers.push(SOV.NOTES.SIEGE_OBSERVED);
    }
  } else if (own !== null && own.state === SOV.ONLINE) {
    have = SOV.ONLINE;
    etaMs = 0;
    ms = 0;
    ratio = 1;
  } else if (own !== null) {
    have = SOV.ANCHORING;
    etaMs = Number.isSafeInteger(own.dueAt) ? Math.max(0, own.dueAt - at) : null;
    ms = etaMs === null ? anchorMs : etaMs;
    ratio = anchorMs > 0 && etaMs !== null ? clamp01(1 - etaMs / anchorMs) : 0;
  }
  return { condition: { limiting: LIMIT_SOV, ratio, ms }, blockers,
    info: Object.freeze({ kind: "sov", have, etaMs }) };
}

function ruleOccupied(c) {
  const { view, params, C, H } = c;
  const blockers = [];
  const out = { next: S.CONSOLIDATING, blockers, fallback: null, status: null,
    conditions: [timeCondition(c, params.occupiedSettleMs)] };
  if (c.interruptByH) {
    blockers.push("FIELD_LOST");
    out.fallback = { to: S.CONTESTED, etaMs: null };
    out.status = STATUS.REVERTING;
    return out;
  }
  if (H !== C) blockers.push(strengthOf(view, C) === 0 ? "NO_GARRISON" : "FIELD_DISPUTED");
  if (!c.rangeEffC) rangeBlocker(c, blockers);
  if (consolidates(view, C) === false) blockers.push("NO_CONSOLIDATION");
  return out;
}

function consolidates(view, f) {
  if (f === null || typeof view.consolidates !== "function") return true;
  return view.consolidates(f);
}

function ruleConsolidating(c) {
  const { view, params, C } = c;
  const blockers = [];
  const out = { next: S.STABLE, blockers, fallback: null, status: null, conditions: [
    timeCondition(c, params.consolidateMs),
    upCondition(c, LIMIT_SCORE, C, params.stableMinScore),
    downCondition(c, LIMIT_RESIDUAL, c.hostile, params.stableMaxResidualScore)] };
  if (c.interruptByH) {
    blockers.push("FIELD_LOST");
    out.fallback = { to: S.CONTESTED, etaMs: null };
    out.status = STATUS.REVERTING;
    return out;
  }
  if (consolidates(view, C) === false) blockers.push("NO_CONSOLIDATION");
  if (c.rangeKnown && !c.rangeEffC) blockers.push("OUT_OF_RANGE");
  if (strengthOf(view, C) === 0) blockers.push("NO_GARRISON");
  if (blockers.length > 0) {
    out.fallback = { to: S.OCCUPIED, etaMs: null };
    out.status = STATUS.REVERTING;
    return out;
  }
  if (!c.rangeKnown && view.capturedAt !== null) blockers.push("RANGE_UNKNOWN");
  return out;
}

const RULES = Object.freeze({
  [S.RECON]: ruleRecon,
  [S.CONTESTED]: ruleContested,
  [S.INVASION]: ruleInvasion,
  [S.OCCUPIED]: ruleOccupied,
  [S.CONSOLIDATING]: ruleConsolidating,
});

function gridOf(c) {
  const { view, params, C } = c;
  const idle = view.state === S.OCCUPIED && (!c.rangeEffC || strengthOf(view, C) === 0);
  return idle ? params.idleEvalIntervalMs : params.evalIntervalMs;
}

function floorDue(t, interval, view) {
  return Math.max(alignUp(t, interval), view.phaseDueAt ?? 0);
}

function summarize(conditions) {
  let ratio = 1;
  let limiting = null;
  let maxMs = 0;
  for (const cond of conditions) {
    const r = clamp01(cond.ratio);
    if (limiting === null || r < ratio) {
      ratio = r;
      limiting = cond.limiting;
    }
    maxMs = Math.max(maxMs, cond.ms);
  }
  return { ratio, limiting, maxMs };
}

function coreRevert(c, rule) {
  const { view } = c;
  if (c.K === null || !S.CLAIM_STATES.includes(view.state) || c.P === null || c.P === c.K) return false;
  rule.blockers.length = 0;
  rule.blockers.push("CORE_PROTECTED");
  rule.fallback = { to: view.state === S.INVASION ? S.CONTESTED : S.STABLE, etaMs: null };
  rule.status = STATUS.REVERTING;
  return true;
}

function assemble(c, rule) {
  const { view, at, P, C } = c;
  const interval = gridOf(c);
  const nextEvalMs = Math.max(0, floorDue(at + 1, interval, view) - at);
  const { ratio: conditionsRatio, limiting, maxMs } = summarize(rule.conditions);
  const ratio = rule.ratio === undefined ? conditionsRatio : clamp01(rule.ratio);
  const fallback = rule.fallback === null ? null
    : { to: rule.fallback.to, etaMs: rule.fallback.etaMs === null ? nextEvalMs : rule.fallback.etaMs };
  const blockers = [...rule.blockers];
  let status = rule.status;
  let etaMs = null;
  if (view.deferred === true || view.presenceTruncated === true) {
    blockers.length = 0;
    blockers.push(view.deferred === true ? "DATA_PENDING" : "FLEETS_TRUNCATED");
    status = STATUS.BLOCKED;
  } else if (status === null) {
    if (blockers.length === 0 && maxMs === Infinity) blockers.push("SCORE_STALLED");
    if (blockers.length > 0) status = STATUS.BLOCKED;
    else {
      status = maxMs <= 0 ? STATUS.READY : STATUS.ADVANCING;
      etaMs = maxMs <= 0 ? nextEvalMs : Math.max(0, floorDue(at + maxMs, interval, view) - at);
    }
  }
  const held = S.HELD_STATES.includes(view.state);
  return { state: view.state, attacker: P, defender: held ? (view.previousController ?? null) : C, ratio, status,
    blockers, limiting, next: rule.next, etaMs, fallback, scores: c.scores, hostile: c.hostile,
    ...(rule.sov ? { sov: rule.sov } : {}) };
}

function estimateProgress(view, params) {
  try {
    if (!view || !params || !Object.prototype.hasOwnProperty.call(RULES, view.state)) return null;
    params = M.capturePaced(view, params);
    const c = contextOf(view, params);
    const rule = RULES[view.state](c);
    coreRevert(c, rule);
    return assemble(c, rule);
  } catch (_err) {
    return null;
  }
}

const MARK_TABLE = Object.freeze({
  [S.RECON]: Object.freeze({ attacker: ["INVASION_MIN", "OCCUPY_MIN"], defender: ["DEFENDER_MAX"] }),
  [S.CONTESTED]: Object.freeze({ attacker: ["INVASION_MIN", "OCCUPY_MIN"], defender: ["DEFENDER_MAX"] }),
  [S.INVASION]: Object.freeze({ attacker: ["OCCUPY_MIN"], defender: ["DEFENDER_MAX"] }),
  [S.OCCUPIED]: Object.freeze({ attacker: ["STABLE_MIN"], hostile: ["RESIDUAL_MAX"] }),
  [S.CONSOLIDATING]: Object.freeze({ attacker: ["STABLE_MIN"], hostile: ["RESIDUAL_MAX"] }),
});
const MARK_PARAM = Object.freeze({ INVASION_MIN: "invasionMinScore", OCCUPY_MIN: "occupyMinScore",
  DEFENDER_MAX: "occupyMaxDefenderScore", STABLE_MIN: "stableMinScore", RESIDUAL_MAX: "stableMaxResidualScore" });

function thresholdMarks(state, role, params) {
  const row = Object.prototype.hasOwnProperty.call(MARK_TABLE, state) ? MARK_TABLE[state] : null;
  if (!row || !params || !Object.prototype.hasOwnProperty.call(row, role)) return [];
  return row[role].map((code) => ({ score: params[MARK_PARAM[code]], code }));
}

function progressToJson(progress) {
  if (!progress) return null;
  const { state, attacker, defender, ratio, status, blockers, limiting, next, etaMs, fallback } = progress;
  return { state, attacker, defender, ratio: Math.round(ratio * RATIO_PER_MILLE), status, blockers: [...blockers],
    limiting, next, etaMs, fallback: fallback ? { ...fallback } : null,
    ...(progress.sov ? { sov: { ...progress.sov } } : {}) };
}

module.exports = { STATUS, BLOCKERS, estimateProgress, thresholdMarks, progressToJson };
