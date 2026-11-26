"use strict";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;

const NONE = Object.freeze({ factionId: null, source: "NONE", lpCorporationId: null });

function resolveRewardIssuer(sys, vertex, data) {
  if (!sys || !data || !Array.isArray(data.eligible)) return NONE;
  const controller = sys.controllerFactionId;
  const ok = (f) => isId(f) && f !== controller && data.eligible.includes(f);
  const pick = (f, source) => {
    const corp = data.lpCorpByFaction ? data.lpCorpByFaction[f] : undefined;
    return Object.freeze({ factionId: f, source, lpCorporationId: isId(corp) ? corp : null });
  };
  if (ok(sys.homeFactionId)) return pick(sys.homeFactionId, "HOME");
  const sde = vertex && typeof vertex === "object" ? vertex.factionId : null;
  if (ok(sde)) return pick(sde, "SDE");
  const rival = data.rivalByPirate && isId(controller) ? data.rivalByPirate[controller] : undefined;
  if (ok(rival)) return pick(rival, "RIVAL");
  return NONE;
}

function planShares(rows, p) {
  if (!Array.isArray(rows) || !p || !isNonNegInt(p.iskPool) || !isNonNegInt(p.lpPool) || !isId(p.minKills)
    || !isId(p.maxRecipients)) {
    return { ok: false, reason: "REWARD_INVALID_INPUT" };
  }
  for (const r of rows) {
    if (!r || !isId(r.characterId) || !isId(r.kills)) return { ok: false, reason: "REWARD_INVALID_INPUT" };
  }
  const picked = rows.filter((r) => r.kills >= p.minKills)
    .sort((a, b) => (b.kills - a.kills) || (a.characterId - b.characterId))
    .slice(0, p.maxRecipients);
  const total = picked.reduce((s, r) => s + r.kills, 0);
  const shares = [];
  for (const r of picked) {
    if (!Number.isSafeInteger(p.iskPool * r.kills) || !Number.isSafeInteger(p.lpPool * r.kills)) {
      return { ok: false, reason: "REWARD_OVERFLOW" };
    }
    const isk = Math.floor((p.iskPool * r.kills) / total);
    const lp = Math.floor((p.lpPool * r.kills) / total);
    if (isk === 0 && lp === 0) continue;
    shares.push(Object.freeze({ characterId: r.characterId, kills: r.kills, isk, lp }));
  }
  return { ok: true, shares };
}

function rewardRowsBound(maxRecipients, maxContributorsPerSystem) {
  return 1 + maxRecipients + maxContributorsPerSystem;
}

module.exports = { resolveRewardIssuer, planShares, rewardRowsBound };
