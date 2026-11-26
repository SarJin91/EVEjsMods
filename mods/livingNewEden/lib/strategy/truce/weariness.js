"use strict";

const {
  STATE_WAR, STATE_TRUCE, EVENT_WAR_PAIR_CHANGED, EVENT_WAR_PAIR_TRUCE, MAX_PAIR_COUNTER, MAX_TRUCES_TOTAL,
} = require("./schema");

const PERMILLE = 1000;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const sat = (v) => Math.min(v, MAX_PAIR_COUNTER);

function pairOf(a, b) {
  if (!isId(a) || !isId(b) || a === b) return null;
  return a < b ? { lo: a, hi: b } : { lo: b, hi: a };
}

function effectiveStateOf(row, at) {
  if (row && row.state === STATE_TRUCE && Number.isSafeInteger(row.truceUntil) && row.truceUntil > at) {
    return { state: STATE_TRUCE, truceUntil: row.truceUntil, initiator: row.initiator === undefined ? null
      : row.initiator };
  }
  return { state: STATE_WAR, truceUntil: null, initiator: null };
}

function weary(lx, ly, wx, battles, P) {
  return lx >= P.minLosses && lx * PERMILLE >= P.lossRatioPermille * Math.max(1, ly)
    && wx * PERMILLE <= P.maxWinPermille * battles;
}

function stepWarPair(row, b, P) {
  if (effectiveStateOf(row, b.at).state === STATE_TRUCE) return { row, event: null };
  const fresh = row === null || row.state === STATE_TRUCE || b.at - row.lastBattleAt > P.windowMs;
  const base = fresh
    ? { seriesStartAt: b.at, lastBattleAt: b.at, battles: 0, lossesLo: 0, lossesHi: 0, winsLo: 0, winsHi: 0 }
    : row;
  const cooldownUntil = row === null ? null : row.cooldownUntil;
  const trucesTotal = row === null ? 0 : row.trucesTotal;
  const next = {
    lo: b.lo, hi: b.hi, state: STATE_WAR, seriesStartAt: base.seriesStartAt,
    lastBattleAt: Math.max(base.lastBattleAt, b.at),
    battles: sat(base.battles + 1),
    lossesLo: sat(base.lossesLo + b.lossesLo), lossesHi: sat(base.lossesHi + b.lossesHi),
    winsLo: sat(base.winsLo + (b.winner === b.lo ? 1 : 0)), winsHi: sat(base.winsHi + (b.winner === b.hi ? 1 : 0)),
    truceUntil: null, initiator: null, cooldownUntil, trucesTotal,
  };
  if (cooldownUntil === null || b.at >= cooldownUntil) {
    const loWeary = weary(next.lossesLo, next.lossesHi, next.winsLo, next.battles, P);
    const hiWeary = weary(next.lossesHi, next.lossesLo, next.winsHi, next.battles, P);
    let initiator = null;
    if (loWeary && hiWeary) initiator = next.lossesHi > next.lossesLo ? b.hi : b.lo;
    else if (loWeary) initiator = b.lo;
    else if (hiWeary) initiator = b.hi;
    if (initiator !== null) {
      const truceUntil = b.at + P.truceMs;
      return { row: { ...next, state: STATE_TRUCE, truceUntil, initiator, cooldownUntil: truceUntil + P.cooldownMs,
        trucesTotal: Math.min(trucesTotal + 1, MAX_TRUCES_TOTAL), seriesStartAt: b.at, battles: 0, lossesLo: 0,
        lossesHi: 0, winsLo: 0, winsHi: 0 }, event: EVENT_WAR_PAIR_TRUCE };
    }
  }
  return { row: next, event: EVENT_WAR_PAIR_CHANGED };
}

module.exports = { pairOf, effectiveStateOf, stepWarPair };
