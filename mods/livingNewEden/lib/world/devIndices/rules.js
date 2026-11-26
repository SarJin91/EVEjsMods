"use strict";

const S = require("./schema");

const HOUR_MS = 3600000;
const MS_PERMILLE_PER_HOUR = 3600000000;
const PERMILLE = 1000;
const KINDS = S.KINDS;
const TREND_KEY = Object.freeze({ mil: "milTrend", ind: "indTrend", trade: "tradeTrend" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

function levelOf(points, P) {
  const p = Number.isSafeInteger(points) && points > 0 ? points : 0;
  return Math.min(S.MAX_LEVEL, Math.floor(p / P.levelWidth));
}

function msPerPointOf(decayPermille, P) {
  return Math.max(1, Math.floor(MS_PERMILLE_PER_HOUR / (P.decayPointsPerHour * decayPermille)));
}

function decayPermilleOf(occupationState, P) {
  return S.CONTESTED_STATES.includes(occupationState) ? P.contestedDecayPermille : S.NEUTRAL_DECAY_PERMILLE;
}

function decayRow(row, now, P) {
  if (!row || !(now > row.anchorAt)) return row;
  const ms = msPerPointOf(row.decayPermille, P);
  const from = Math.max(row.anchorAt, now - P.maxDecayGapMs);
  const dec = Math.floor((now - from) / ms);
  const next = { ...row };
  for (const k of KINDS) next[k] = Math.max(0, row[k] - dec);
  const allZero = KINDS.every((k) => next[k] === 0);
  next.anchorAt = allZero ? now : from + dec * ms;
  if (next.anchorAt === row.anchorAt && KINDS.every((k) => next[k] === row[k])) return row;
  return Object.freeze(next);
}

function captureLoss(row, current, P) {
  const controller = current && isId(current.controllerFactionId) ? current.controllerFactionId : null;
  const decayPermille = decayPermilleOf(current ? current.occupationState : null, P);
  const lost = row.controllerFactionId !== null && controller !== row.controllerFactionId;
  if (!lost && row.controllerFactionId === controller && row.decayPermille === decayPermille) return { row, lost };
  const next = { ...row, controllerFactionId: controller, decayPermille };
  if (lost) {
    next.mil = Math.floor((row.mil * (PERMILLE - P.captureLossMilPermille)) / PERMILLE);
    next.ind = Math.floor((row.ind * (PERMILLE - P.captureLossIndPermille)) / PERMILLE);
    next.trade = Math.floor((row.trade * (PERMILLE - P.captureLossTradePermille)) / PERMILLE);
  }
  return { row: Object.freeze(next), lost };
}

function foldBattle(battle, controllerFactionId, P) {
  const sides = battle && Array.isArray(battle.sides) ? battle.sides : [];
  const own = isId(controllerFactionId) ? sides.filter((s) => s && s.factionId === controllerFactionId) : [];
  if (own.length === 0) return { trade: -P.battleNearbyTradePoints };
  if (own.some((s) => s.result === "L")) return { mil: -P.battleLossMilPoints, trade: -P.battleLossTradePoints };
  if (own.some((s) => s.result === "W")) return { mil: P.battleWinMilPoints };
  return {};
}

function foldKill(kill, window, P) {
  const bucket = Math.floor(kill.killAt / HOUR_MS) * HOUR_MS;
  const w = window && Number.isSafeInteger(window.at) ? window : { at: 0, points: 0 };
  const open = bucket > w.at ? { at: bucket, points: 0 } : { at: w.at, points: w.points };
  const delta = Math.max(0, Math.min(P.ratKillMilPoints, P.killPointsCapPerHour - open.points));
  return { delta, window: { at: open.at, points: open.points + delta }, capped: delta < P.ratKillMilPoints };
}

function emptyRow(systemId, now) {
  return { systemId, mil: 0, ind: 0, trade: 0, milTrend: 0, indTrend: 0, tradeTrend: 0, controllerFactionId: null,
    decayPermille: S.NEUTRAL_DECAY_PERMILLE, anchorAt: now, lastInputAt: null, killWindowAt: 0, killWindowPoints: 0,
    investedIskTotal: 0, createdAt: now, updatedAt: now, version: 0 };
}

function applyDelta(row, systemId, delta, now, P) {
  const d = delta || {};
  const touched = KINDS.filter((k) => Number.isSafeInteger(d[k]) && d[k] !== 0);
  if (!row && !touched.some((k) => d[k] > 0)) return null;
  const next = row ? { ...row } : emptyRow(systemId, now);
  if (touched.length === 0) return row;
  for (const k of touched) {
    next[k] = Math.min(P.maxPoints, Math.max(0, next[k] + d[k]));
    next[TREND_KEY[k]] = sign(d[k]);
  }
  next.lastInputAt = now;
  return Object.freeze(next);
}

function trendOf(row, now, P) {
  if (!row || row.lastInputAt === null || now - row.lastInputAt >= P.trendWindowMs) return { mil: 0, ind: 0, trade: 0 };
  return { mil: row.milTrend, ind: row.indTrend, trade: row.tradeTrend };
}

function foldEconomy(fact, P) {
  const source = fact && fact.source;
  if (source === "mining") return { ind: P.miningTripIndPoints };
  if (source === "production") return { ind: P.productionJobIndPoints };
  if (source === "convoys") return { trade: P.convoyTradePoints };
  if (source === "trade") {
    const isk = Number.isSafeInteger(fact.iskDelivered) && fact.iskDelivered > 0 ? fact.iskDelivered : 0;
    const points = Math.min(P.tradeDeliveryMaxPoints, Math.max(1, Math.floor(isk / P.tradeDeliveryIskPerPoint)));
    return fact.side === "sell" ? { trade: points } : { trade: points, ind: P.tradeDeliveryIndPoints };
  }
  return {};
}

const AMOUNT_RE = /^(\d{1,16})(?:\.(\d{1,9}))?([kmb])?$/i;
const AMOUNT_UNITS = Object.freeze({ "": 1n, k: 1000n, m: 1000000n, b: 1000000000n });

function parseInvestAmount(text) {
  const m = AMOUNT_RE.exec(String(text === undefined || text === null ? "" : text).trim());
  if (!m) return null;
  const unit = AMOUNT_UNITS[(m[3] || "").toLowerCase()];
  const frac = m[2] || "";
  const scale = 10n ** BigInt(frac.length);
  const scaled = (BigInt(m[1]) * scale + BigInt(frac || "0")) * unit;
  if (scaled % scale !== 0n) return null;
  const isk = scaled / scale;
  if (isk < 1n || isk > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(isk);
}

function investPoints(amount, P) {
  return Number.isSafeInteger(amount) && amount > 0 ? Math.floor(amount / P.investIskPerPoint) : 0;
}

const levelIn = (levels, k) => (levels && Number.isSafeInteger(levels[k]) && levels[k] > 0
  ? Math.min(S.MAX_LEVEL, levels[k]) : 0);

function effectsOf(levels, P) {
  const minLevel = P.anomalyMinLevel;
  return Object.freeze({
    garrisonPoints: P.garrisonEnabled === true ? levelIn(levels, "mil") * P.garrisonPointsPerLevel : 0,
    wtsDiscountPermille: P.tradeDiscountEnabled === true
      ? Math.min(P.tradeDiscountMaxPermille, levelIn(levels, "trade") * P.tradeDiscountPermillePerLevel) : 0,
    sites: P.anomaliesEnabled === true && (levelIn(levels, "ind") >= minLevel || levelIn(levels, "mil") >= minLevel),
  });
}

module.exports = { HOUR_MS, levelOf, msPerPointOf, decayPermilleOf, decayRow, captureLoss, foldBattle, foldKill,
  emptyRow, applyDelta, trendOf, foldEconomy, parseInvestAmount, investPoints, effectsOf };
