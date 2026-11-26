"use strict";

const ACTION = Object.freeze({
  GAIN: "GAIN",
  LOSS: "LOSS",
  TRANSFER: "TRANSFER",
  REINFORCE: "REINFORCE",
  NONE: "NONE",
});

const REASON = Object.freeze({
  CONTROLLER_GAINED: "CONTROLLER_GAINED",
  CONTROLLER_LOST: "CONTROLLER_LOST",
  CONTROLLER_TRANSFER: "CONTROLLER_TRANSFER",
  HUB_REINFORCE: "HUB_REINFORCE",
  NOT_CLAIMABLE: "NOT_CLAIMABLE",
  INVADER_FACTION: "INVADER_FACTION",
  NO_VIRTUAL_IDENTITY: "NO_VIRTUAL_IDENTITY",
  PLAYER_CLAIM_PROTECTED: "PLAYER_CLAIM_PROTECTED",
  ALREADY_SYNCED: "ALREADY_SYNCED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  NO_CLAIM: "NO_CLAIM",
});

const REASON_METRIC_SUFFIXES = Object.freeze([...Object.values(REASON).map((r) => r.toLowerCase()), "other"]);

function metricSuffix(reason) {
  return Object.prototype.hasOwnProperty.call(REASON, reason) ? reason.toLowerCase() : "other";
}

const PERMANENT_REASONS = Object.freeze([
  REASON.NOT_CLAIMABLE,
  REASON.INVADER_FACTION,
  REASON.PLAYER_CLAIM_PROTECTED,
]);

const TEMPORARY_REASONS = Object.freeze([
  REASON.NO_VIRTUAL_IDENTITY,
  REASON.ALREADY_SYNCED,
  REASON.BUDGET_EXCEEDED,
  REASON.NO_CLAIM,
]);

function isFailure(reason) {
  if (typeof reason !== "string") return false;
  return PERMANENT_REASONS.includes(reason) || TEMPORARY_REASONS.includes(reason);
}

function isPermanentFailure(reason) {
  return PERMANENT_REASONS.includes(reason);
}

function isTemporaryFailure(reason) {
  return TEMPORARY_REASONS.includes(reason);
}

class SovWriteBudget {
  constructor(options = {}) {
    if (typeof options.now !== "function") {
      throw new Error("SovWriteBudget requires a 'now' function (pass clock.now from adapter)");
    }
    this.maxTokens = Math.max(1, Math.trunc(options.maxTokens ?? 8));
    this.windowMs = Math.max(1000, Math.trunc(options.windowMs ?? 300000));
    this.now = options.now;

    this.tokens = this.maxTokens;
    this.windowStart = this.now();
  }

  _refill() {
    const now = this.now();
    const elapsed = now - this.windowStart;

    if (elapsed >= this.windowMs) {
      this.tokens = this.maxTokens;
      this.windowStart = now;
    }
    return this.tokens;
  }

  tryConsume() {
    this._refill();

    if (this.tokens > 0) {
      this.tokens -= 1;
      return {
        ok: true,
        tokensRemaining: this.tokens,
        retryAfterMs: null,
        queued: false,
      };
    }

    const now = this.now();
    const elapsed = now - this.windowStart;
    const retryAfterMs = this.windowMs - elapsed;

    return {
      ok: false,
      tokensRemaining: 0,
      retryAfterMs: Math.max(1, retryAfterMs),
      queued: false,
    };
  }

  getStatus() {
    this._refill();
    return {
      tokens: this.tokens,
      maxTokens: this.maxTokens,
      windowMs: this.windowMs,
      windowStart: this.windowStart,
    };
  }

  clone() {
    return new SovWriteBudget({
      maxTokens: this.maxTokens,
      windowMs: this.windowMs,
      now: this.now,
    });
  }
}

function createBudget(config) {
  if (typeof config.now !== "function") {
    throw new Error("createBudget requires config.now (pass clock.now from adapter)");
  }
  return new SovWriteBudget({
    maxTokens: config.maxSovWritesPerWindow,
    windowMs: config.sovWriteWindowMs,
    now: config.now,
  });
}

const DEFAULT_INVADER_FACTION_IDS = Object.freeze(new Set([500021, 500026, 500029]));

function playerHubProtected() {
  return { action: ACTION.NONE, reason: REASON.PLAYER_CLAIM_PROTECTED, allianceId: null, executorCorpId: null,
    skip: true };
}

function decideProjection(systemId, modState, virtualIdentity, evejsState, invaderFactionIds, options = {}) {
  const id = Math.trunc(Number(systemId));
  if (!Number.isSafeInteger(id) || id <= 0) {
    return {
      action: ACTION.NONE,
      reason: REASON.NOT_CLAIMABLE,
      allianceId: null,
      executorCorpId: null,
      skip: true,
    };
  }

  const controllerFactionId = modState?.controllerFactionId ?? null;
  const occupationState = modState?.occupationState ?? "STABLE";
  const phaseSeq = Math.trunc(modState?.phaseSeq ?? 0);
  const capturedAt = modState?.capturedAt ?? null;

  const invaderIds = invaderFactionIds ?? DEFAULT_INVADER_FACTION_IDS;

  if (!evejsState?.isClaimable) {
    return {
      action: ACTION.NONE,
      reason: REASON.NOT_CLAIMABLE,
      allianceId: null,
      executorCorpId: null,
      skip: true,
    };
  }

  if (controllerFactionId !== null && invaderIds.has(controllerFactionId)) {
    return {
      action: ACTION.NONE,
      reason: REASON.INVADER_FACTION,
      allianceId: null,
      executorCorpId: null,
      skip: true,
    };
  }

  if (controllerFactionId === null) {
    const currentClaim = evejsState?.currentClaim ?? null;
    if (currentClaim && currentClaim.isVirtualAlliance === true) {
      if (options.reinforceOnLoss === true) {
        return {
          action: ACTION.REINFORCE,
          reason: REASON.HUB_REINFORCE,
          allianceId: currentClaim.allianceID,
          executorCorpId: currentClaim.corporationID,
          skip: false,
        };
      }
      return {
        action: ACTION.LOSS,
        reason: REASON.CONTROLLER_LOST,
        allianceId: currentClaim.allianceID,
        executorCorpId: currentClaim.corporationID,
        skip: false,
      };
    }
    if (currentClaim && currentClaim.allianceID !== null && currentClaim.allianceID > 0) {
      return {
        action: ACTION.NONE,
        reason: REASON.PLAYER_CLAIM_PROTECTED,
        allianceId: null,
        executorCorpId: null,
        skip: true,
      };
    }
    return {
      action: ACTION.NONE,
      reason: REASON.NO_CLAIM,
      allianceId: null,
      executorCorpId: null,
      skip: true,
    };
  }

  if (!virtualIdentity || !virtualIdentity.allianceId || !virtualIdentity.executorCorpId) {
    return {
      action: ACTION.NONE,
      reason: REASON.NO_VIRTUAL_IDENTITY,
      allianceId: null,
      executorCorpId: null,
      skip: true,
    };
  }

  const currentClaim = evejsState?.currentClaim ?? null;

  if (currentClaim && currentClaim.allianceID !== null && currentClaim.allianceID > 0) {
    const isVirtual = currentClaim.isVirtualAlliance === true;

    if (isVirtual) {
      if (currentClaim.allianceID === virtualIdentity.allianceId) {
        return {
          action: ACTION.NONE,
          reason: REASON.ALREADY_SYNCED,
          allianceId: virtualIdentity.allianceId,
          executorCorpId: virtualIdentity.executorCorpId,
          skip: true,
        };
      }
      if (evejsState.playerHub === true) return playerHubProtected();
      return {
        action: ACTION.TRANSFER,
        reason: REASON.CONTROLLER_TRANSFER,
        allianceId: virtualIdentity.allianceId,
        executorCorpId: virtualIdentity.executorCorpId,
        skip: false,
      };
    }

    return {
      action: ACTION.NONE,
      reason: REASON.PLAYER_CLAIM_PROTECTED,
      allianceId: null,
      executorCorpId: null,
      skip: true,
    };
  }

  if (evejsState.playerHub === true) return playerHubProtected();
  return {
    action: ACTION.GAIN,
    reason: REASON.CONTROLLER_GAINED,
    allianceId: virtualIdentity.allianceId,
    executorCorpId: virtualIdentity.executorCorpId,
    skip: false,
  };
}

function buildSovCall(decision, systemId) {
  if (decision.action === ACTION.NONE || decision.skip) return null;

  const allianceId = decision.allianceId;
  const executorCorpId = decision.executorCorpId;

  if (!allianceId || !executorCorpId) return null;

  switch (decision.action) {
    case ACTION.GAIN:
      return {
        functionName: "anchorSovereigntyHub",
        args: [systemId, allianceId, executorCorpId],
      };
    case ACTION.LOSS:
      return {
        functionName: "loseSystemSovereignty",
        args: [systemId],
      };
    case ACTION.TRANSFER:
      return {
        functionName: "loseSystemSovereignty",
        args: [systemId],
      };
    case ACTION.REINFORCE:
      return {
        functionName: "reinforceSystemHub",
        args: [systemId],
      };
    default:
      return null;
  }
}

function decideWithBudget(systemId, modState, virtualIdentity, evejsState, invaderFactionIds, budget, options = {}) {
  const decision = decideProjection(systemId, modState, virtualIdentity, evejsState, invaderFactionIds, options);

  if (decision.action === ACTION.NONE && decision.skip) {
    return { decision, budgetResult: { ok: true, skipped: true } };
  }

  const budgetResult = budget.tryConsume();

  if (!budgetResult.ok) {
    return {
      decision: {
        action: ACTION.NONE,
        reason: REASON.BUDGET_EXCEEDED,
        allianceId: null,
        executorCorpId: null,
        skip: true,
      },
      budgetResult,
    };
  }

  return { decision, budgetResult };
}

module.exports = {
  ACTION,
  REASON,
  REASON_METRIC_SUFFIXES,
  metricSuffix,
  isFailure,
  isPermanentFailure,
  isTemporaryFailure,
  SovWriteBudget,
  createBudget,
  DEFAULT_INVADER_FACTION_IDS,
  decideProjection,
  buildSovCall,
  decideWithBudget,
};