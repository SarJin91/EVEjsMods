"use strict";

const { FILETIME_EPOCH_OFFSET, FILETIME_TICKS_PER_MS } = require("../../lib/adapter/sovNative");

function filetime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  return (FILETIME_EPOCH_OFFSET + BigInt(Math.trunc(ms)) * FILETIME_TICKS_PER_MS).toString();
}

function deepFreeze(obj) {
  if (obj !== null && typeof obj === "object") {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  }
  return obj;
}

function normalizeOutcome(outcome) {
  return deepFreeze({
    schemaVersion: 1,
    targetID: outcome.targetId,
    solarSystemID: outcome.systemId,
    campaignEpoch: outcome.campaignEpoch,
    defenderAllianceID: outcome.defenderAllianceId,
    result: outcome.result,
    completedAtTime: filetime(outcome.completedAtMs),
    destroyedNotificationDeliveredAtTime: "0",
    nodeIDs: outcome.nodeIDs || [],
    drop: null,
  });
}

function createFakeSovNative() {
  const systems = new Map();
  let updatedAtCounter = 0;
  const faults = {
    getSystemState: null,
    getSystemSovClaim: null,
    readSovereigntyTableUpdatedAt: null,
  };

  function getSystemState(systemId) {
    if (faults.getSystemState === "throw") throw new Error("INJECTED_FAULT");
    if (faults.getSystemState === "returnNull") return null;
    const sys = systems.get(systemId);
    if (!sys) return null;
    return deepFreeze({
      solarSystemID: systemId,
      allianceID: sys.claim?.allianceId ?? null,
      corporationID: sys.claim?.corporationId ?? null,
      claimStructureID: sys.claim?.claimStructureId ?? null,
      infrastructureHubID: sys.claim?.infrastructureHubId ?? null,
      claimTime: sys.claim?.claimTime ?? "0",
      fuelAccessGroupID: null,
      devIndices: { militaryPoints: 0, industrialPoints: 0, claimedForDays: 0, militaryIncreasing: false, industrialIncreasing: false },
      campaignOutcomeReceipts: Object.fromEntries(sys.outcomes),
      structures: [],
      recentActivity: [],
      currentData: [],
    });
  }

  function getSystemSovClaim(systemId) {
    if (faults.getSystemSovClaim === "throw") throw new Error("INJECTED_FAULT");
    const sys = systems.get(systemId);
    if (!sys || !sys.claim) return null;
    return deepFreeze({
      allianceID: sys.claim.allianceId,
      corporationID: sys.claim.corporationId,
      claimStructureID: sys.claim.claimStructureId,
    });
  }

  function readSovereigntyTableUpdatedAt() {
    if (faults.readSovereigntyTableUpdatedAt === "throw") throw new Error("INJECTED_FAULT");
    updatedAtCounter++;
    return new Date(Date.now() + updatedAtCounter).toISOString();
  }

  function setOutcomes(systemId, outcomes) {
    let sys = systems.get(systemId);
    if (!sys) {
      sys = { claim: null, outcomes: new Map() };
      systems.set(systemId, sys);
    }
    sys.outcomes.clear();
    for (const o of outcomes) {
      const key = `${o.targetId}:${o.campaignEpoch}`;
      sys.outcomes.set(key, normalizeOutcome({ ...o, systemId }));
    }
  }

  function setClaim(systemId, allianceId, corporationId = null, claimStructureId = null, infrastructureHubId = null) {
    let sys = systems.get(systemId);
    if (!sys) {
      sys = { claim: null, outcomes: new Map() };
      systems.set(systemId, sys);
    }
    if (allianceId === null) {
      sys.claim = null;
    } else {
      sys.claim = {
        allianceId,
        corporationId: corporationId || allianceId + 1000,
        claimStructureId: claimStructureId || 32458,
        infrastructureHubId: infrastructureHubId || 32458,
        claimTime: filetime(Date.now()),
      };
    }
  }

  function clearClaim(systemId) {
    setClaim(systemId, null);
  }

  return Object.freeze({
    getSystemState,
    getSystemSovClaim,
    readSovereigntyTableUpdatedAt,
    setOutcomes,
    setClaim,
    clearClaim,
    filetime,
    faults,
  });
}

module.exports = { createFakeSovNative, filetime, FILETIME_EPOCH_OFFSET, FILETIME_TICKS_PER_MS };