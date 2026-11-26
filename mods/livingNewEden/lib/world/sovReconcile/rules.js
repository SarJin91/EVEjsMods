"use strict";

const {
  FACT_KINDS,
  LOSS_KINDS,
  REPROJECT_KINDS,
  CLASSIFY_KINDS,
  SETTLE_ACTIONS,
  FACT_KEY_PREFIX,
  MAX_CAMPAIGN_EPOCH_LENGTH,
  HOLD_STATES_FOR_LOSS,
} = require("./schema");

function isSafePositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function classifyForeign(row, outcomes, isModAlliance) {
  if (
    !isSafePositiveInt(row.allianceId) ||
    !isSafeNonNegativeInt(row.boundSeq) ||
    !isSafePositiveInt(row.boundAt) ||
    !isSafePositiveInt(row.foreignAt)
  ) {
    return { ok: false, reason: "ROW_INCOMPLETE" };
  }

  if (typeof isModAlliance !== "function") {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  const attackerOutcomes = outcomes
    .filter((o) => o.result === "attacker" && o.defenderAllianceId === row.allianceId && o.completedAtMs >= row.boundAt)
    .sort((a, b) => b.completedAtMs - a.completedAtMs);

  if (attackerOutcomes.length > 0) {
    const newest = attackerOutcomes[0];
    return { ok: true, kind: "HUB_DESTROYED", foreignAt: row.foreignAt, attackerOutcome: newest };
  }

  let claimAllianceId = null;
  try {
    const claim = row.claim;
    if (claim && isSafePositiveInt(claim.allianceId)) {
      claimAllianceId = claim.allianceId;
    }
  } catch (_e) {
  }

  if (claimAllianceId === null) {
    return { ok: true, kind: "CLAIM_LOST", foreignAt: row.foreignAt };
  }

  if (claimAllianceId === row.allianceId) {
    return { ok: true, kind: "RESTORED", foreignAt: row.foreignAt };
  }

  let isMod = false;
  try {
    isMod = isModAlliance(claimAllianceId) === true;
  } catch (_e) {
    isMod = false;
  }

  if (isMod) {
    return { ok: true, kind: "MOD_OTHER", foreignAt: row.foreignAt };
  }

  return { ok: true, kind: "PLAYER_CLAIM", foreignAt: row.foreignAt };
}

function listDefended({ allianceId, boundAt, outcomes }) {
  if (!isSafePositiveInt(allianceId) || !isSafePositiveInt(boundAt) || !Array.isArray(outcomes)) {
    return [];
  }
  const filtered = outcomes
    .filter((o) => o.result === "defender" && o.defenderAllianceId === allianceId && o.completedAtMs >= boundAt)
    .map((o) => ({ ...o }))
    .sort((a, b) => a.completedAtMs - b.completedAtMs);
  return Object.freeze(filtered);
}

function planSettlement({ row, logRow, world, now, maxDeferMs, hubLossInfluencePoints, coreProtected }) {
  if (!row || typeof row !== "object") return { ok: false, reason: "INVALID_INPUT" };

  if (!logRow || logRow.boundSeq !== row.boundSeq || logRow.allianceId !== row.allianceId) {
    return { ok: true, action: "STALE", points: 0, at: row.foreignAt };
  }

  const kind = row.kind;
  if (kind === "RESTORED") {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  if (REPROJECT_KINDS.includes(kind)) {
    return { ok: true, action: "REPROJECT", points: 0, at: row.foreignAt };
  }

  if (!LOSS_KINDS.includes(kind)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  const controllerFactionId = world && isSafePositiveInt(world.controllerFactionId) ? world.controllerFactionId : null;

  if (world === null || controllerFactionId !== row.factionId) {
    return { ok: true, action: "SUPERSEDED", points: 0, at: row.foreignAt };
  }

  const occState = world && world.occupationState ? String(world.occupationState) : null;
  const isHoldState = HOLD_STATES_FOR_LOSS.includes(occState);

  if (isHoldState) {
    if (coreProtected === true) {
      return { ok: true, action: "DROP_ONLY", points: hubLossInfluencePoints, at: row.foreignAt };
    }
    return { ok: true, action: "LOSS_APPLIED", points: hubLossInfluencePoints, at: row.foreignAt };
  }

  const deadline = row.foreignAt + maxDeferMs;
  if (now < deadline) {
    return { ok: true, action: "DEFERRED", points: 0, at: row.foreignAt, until: deadline };
  }

  return { ok: true, action: "DROP_ONLY", points: hubLossInfluencePoints, at: row.foreignAt };
}

function factKey(systemId, boundSeq, foreignAt, kind) {
  if (!isSafePositiveInt(systemId)) return { ok: false, reason: "INVALID_SYSTEM_ID" };
  if (!isSafeNonNegativeInt(boundSeq)) return { ok: false, reason: "INVALID_BOUND_SEQ" };
  if (!isSafePositiveInt(foreignAt)) return { ok: false, reason: "INVALID_INPUT" };
  const validKinds = [...LOSS_KINDS, ...REPROJECT_KINDS];
  if (!validKinds.includes(kind)) return { ok: false, reason: "INVALID_KIND" };

  const key = `${FACT_KEY_PREFIX}${systemId}:${boundSeq}:${foreignAt}:${kind}`;
  if (key.length > MAX_CAMPAIGN_EPOCH_LENGTH + 50) {
    return { ok: false, reason: "INVALID_KEY_LENGTH" };
  }
  return { ok: true, key };
}

function defendedKey(systemId, campaignEpoch) {
  if (!isSafePositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
  if (typeof campaignEpoch !== "string" || campaignEpoch === "") return { ok: false, reason: "INVALID_INPUT" };
  if (campaignEpoch.length > MAX_CAMPAIGN_EPOCH_LENGTH) return { ok: false, reason: "INVALID_RECEIPT" };
  return { ok: true, key: `${FACT_KEY_PREFIX}${systemId}:camp:${campaignEpoch}` };
}

module.exports = {
  classifyForeign,
  listDefended,
  planSettlement,
  factKey,
  defendedKey,
};