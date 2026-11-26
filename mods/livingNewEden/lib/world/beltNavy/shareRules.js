"use strict";

const { STABLE, RECON, CONSOLIDATING, SCORE_MIN, SCORE_MAX } = require("../occupation/schema");

function stateWeight(occupationState, consolidatingWeight) {
  if (occupationState === STABLE || occupationState === RECON) return 1;
  if (occupationState === CONSOLIDATING) return consolidatingWeight;
  return 0;
}

function computeNavyShare(s, p) {
  const raw = Number(s.score);
  const score = Number.isFinite(raw) ? Math.min(SCORE_MAX, Math.max(SCORE_MIN, raw)) : SCORE_MIN;
  const weight = stateWeight(s.occupationState, p.consolidatingWeight);
  return p.shareMin + (p.shareMax - p.shareMin) * (score / SCORE_MAX) * weight;
}

module.exports = { computeNavyShare };
