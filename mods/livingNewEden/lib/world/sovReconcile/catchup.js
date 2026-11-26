"use strict";

function pickNudges({ rows, isProjecting, claimOf, isModAlliance, tokens, max, state }) {
  const nudge = [];
  const playerHeld = [];
  let skipped = 0;

  if (!Array.isArray(rows)) throw new TypeError("catchup.pickNudges: rows must be an array");
  if (typeof isProjecting !== "function") throw new TypeError("catchup.pickNudges: isProjecting must be a function");
  if (typeof claimOf !== "function") throw new TypeError("catchup.pickNudges: claimOf must be a function");
  if (typeof isModAlliance !== "function") throw new TypeError("catchup.pickNudges: isModAlliance must be a function");

  const maxNudges = Number.isSafeInteger(max) && max >= 0 ? max : 0;
  const tokenBudget = Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : 0;

  const eligible = [];
  for (const row of rows) {
    const systemId = Number.isSafeInteger(row.systemId) ? row.systemId : null;
    if (systemId === null || systemId <= 0) continue;

    let projecting = false;
    try { projecting = isProjecting(systemId) === true; } catch (_e) { projecting = false; }
    if (projecting) { skipped++; continue; }

    let claimed = false;
    let allianceId = null;
    try {
      const claim = claimOf(systemId) || {};
      claimed = Boolean(claim.claimed);
      allianceId = claim.allianceId !== undefined ? claim.allianceId : null;
    } catch (_e) {
      claimed = false;
      allianceId = null;
    }
    if (claimed && allianceId !== null && isModAlliance(allianceId) !== true) {
      playerHeld.push(systemId);
      skipped++;
      continue;
    }

    eligible.push(systemId);
  }

  if (maxNudges === 0 || tokenBudget === 0 || eligible.length === 0) {
    return { nudge, playerHeld, skipped };
  }

  const rotationIndex = state && Number.isSafeInteger(state.rotationIndex) ? state.rotationIndex : 0;
  const take = Math.min(maxNudges, tokenBudget, eligible.length);
  const startIdx = rotationIndex % eligible.length;

  for (let i = 0; i < take; i++) {
    const idx = (startIdx + i) % eligible.length;
    nudge.push(eligible[idx]);
  }

  if (state && typeof state === "object") {
    state.rotationIndex = (rotationIndex + take) % eligible.length;
  }

  return { nudge, playerHeld, skipped };
}

module.exports = { pickNudges };
