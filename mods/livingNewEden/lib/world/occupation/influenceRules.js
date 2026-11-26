"use strict";

const { round2, MS_PER_HOUR, SCORE_DECIMALS, STABLE } = require("./schema");

function battleInfluence(settled, rowsByFaction, params) {
  const none = { influence: [], changed: false, winnerFactionId: null, loserFactionId: null };
  if (!settled || (settled.winnerSide !== "A" && settled.winnerSide !== "B")) return none;
  const winner = settled.winnerFactionId;
  const loserSide = settled.winnerSide === "A" ? "B" : "A";
  const loser = settled.sides && settled.sides[loserSide] ? settled.sides[loserSide].factionId : null;
  if (!Number.isSafeInteger(winner) || winner <= 0) return none;
  const nonOccupier = params.nonOccupierFactionIds instanceof Set && params.nonOccupierFactionIds.has(winner);
  const out = [];
  const hasRow = (f) => rowsByFaction.has(f);
  if (!nonOccupier && (hasRow(winner) || rowsByFaction.size < params.maxFactionsPerSystem)) {
    const cur = hasRow(winner) ? rowsByFaction.get(winner) : 0;
    const next = round2(cur + params.battleWinPoints);
    if (next !== cur || !hasRow(winner)) out.push({ factionId: winner, influenceScore: next });
  }
  if (Number.isSafeInteger(loser) && loser > 0 && loser !== winner && hasRow(loser)) {
    const cur = rowsByFaction.get(loser);
    const next = round2(cur - params.battleLossPoints);
    if (next !== cur) out.push({ factionId: loser, influenceScore: next });
  }
  out.sort((a, b) => a.factionId - b.factionId);
  return { influence: out, changed: out.length > 0, winnerFactionId: nonOccupier ? null : winner,
    loserFactionId: Number.isSafeInteger(loser) && loser !== winner ? loser : null };
}

function stableDrift(scores, controller, hours, p) {
  const h = Number.isFinite(hours) && hours > 0 ? hours : 0;
  if (h === 0 || !(scores instanceof Map)) return [];
  const out = [];
  for (const f of [...scores.keys()].sort((a, b) => a - b)) {
    const cur = scores.get(f);
    let next = cur;
    if (f === controller) {
      if (cur < p.stableBaselineScore) next = Math.min(p.stableBaselineScore, cur + h * p.stableRecoverPointsPerHour);
    } else if (cur > p.stableForeignFloorScore) {
      next = Math.max(p.stableForeignFloorScore, cur - h * p.stableForeignDecayPointsPerHour);
    }
    const score = round2(next);
    if (score !== cur) out.push({ factionId: f, influenceScore: score });
  }
  return out;
}

function driftHours(anchor, at) {
  if (anchor === null || anchor === undefined || !Number.isFinite(at)) return 0;
  return Math.max(0, at - anchor) / MS_PER_HOUR;
}

function rowsOf(sys) {
  const rows = new Map();
  for (const i of (sys && Array.isArray(sys.influence) ? sys.influence : [])) {
    if (i && Number.isSafeInteger(i.factionId) && Number.isFinite(i.influenceScore)) {
      rows.set(i.factionId, i.influenceScore);
    }
  }
  return rows;
}

const anchorOf = (sys) => (sys.influenceEvaluatedAt === undefined ? null : sys.influenceEvaluatedAt);

function effectiveScores(sys, at, p) {
  const rows = rowsOf(sys);
  if (!sys || sys.occupationState !== STABLE) return rows;
  for (const d of stableDrift(rows, sys.controllerFactionId, driftHours(anchorOf(sys), at), p)) {
    rows.set(d.factionId, d.influenceScore);
  }
  return rows;
}

function planInfluenceDrop(sys, spec, p) {
  const rows = rowsOf(sys);
  const F = spec.factionId;
  let drift = [];
  let statePatch = {};
  let banked = false;
  if (sys && sys.occupationState === STABLE) {
    const anchor = anchorOf(sys);
    const at = spec.at;
    const C = sys.controllerFactionId;
    const raw = rows.has(C) ? rows.get(C) : 0;
    const r = p.stableRecoverPointsPerHour;
    const B = p.stableBaselineScore;
    const h = driftHours(anchor, at);
    const stepped = anchor !== null && at > anchor && raw < B && raw + h * r < B;
    let hEff = h;
    let newAnchor;
    if (stepped) {
      const stepMs = r > 0 ? MS_PER_HOUR / (SCORE_DECIMALS * r) : Infinity;
      const advanceMs = r > 0 ? Math.floor(Math.floor((at - anchor) / stepMs) * stepMs) : 0;
      hEff = advanceMs / MS_PER_HOUR;
      newAnchor = anchor + advanceMs;
      banked = newAnchor < at;
    } else {
      newAnchor = Math.max(anchor === null ? at : anchor, at);
    }
    drift = stableDrift(rows, C, hEff, p);
    if (newAnchor !== anchor) statePatch = { influenceEvaluatedAt: newAnchor };
  }
  const merged = new Map(drift.map((d) => [d.factionId, d.influenceScore]));
  const before = merged.has(F) ? merged.get(F) : (rows.has(F) ? rows.get(F) : 0);
  const next = round2(Math.max(0, before - spec.points));
  if (rows.has(F) && next !== before) merged.set(F, next);
  const influence = [...merged.entries()].sort((a, b) => a[0] - b[0])
    .map(([factionId, influenceScore]) => ({ factionId, influenceScore }));
  return { before, next, influence, statePatch, drifted: drift.length, banked };
}

module.exports = { battleInfluence, stableDrift, driftHours, effectiveScores, planInfluenceDrop };
