"use strict";

const GATE_PICKET_ANCHOR_KIND = "stargate";
const PERMILLE_MAX = 1000;
const GATE_PICKET_MAX_GATES = 8;
const MAX_TIERS = 8;
const TIER_RE = /^(\d{1,4}):(\d{1,2})$/;

function parseGatePicketTiers(text) {
  if (typeof text !== "string") return null;
  const tokens = text.split(",").map((t) => t.trim());
  if (tokens.length === 0 || tokens.length > MAX_TIERS) return null;
  const tiers = [];
  for (const token of tokens) {
    const m = TIER_RE.exec(token);
    if (!m) return null;
    const chancePermille = Number(m[1]);
    const gates = Number(m[2]);
    if (chancePermille > PERMILLE_MAX || gates < 1 || gates > GATE_PICKET_MAX_GATES) return null;
    const prev = tiers.length > 0 ? tiers[tiers.length - 1] : null;
    if (prev && (chancePermille <= prev.chancePermille || gates < prev.gates)) return null;
    tiers.push(Object.freeze({ chancePermille, gates }));
  }
  return Object.freeze(tiers);
}

function gatePicketCount(chancePermille, tiers, maxGates) {
  if (!Number.isFinite(chancePermille) || !Array.isArray(tiers)) return 0;
  const cap = Number.isSafeInteger(maxGates) && maxGates > 0 ? maxGates : 0;
  let gates = 0;
  for (const tier of tiers) {
    if (tier && chancePermille >= tier.chancePermille) gates = tier.gates;
  }
  return Math.min(gates, cap);
}

module.exports = { parseGatePicketTiers, gatePicketCount, GATE_PICKET_ANCHOR_KIND, GATE_PICKET_MAX_GATES, MAX_TIERS };
