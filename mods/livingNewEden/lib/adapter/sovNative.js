"use strict";

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

function filetimeToMs(filetimeStr) {
  try {
    const ft = BigInt(filetimeStr);
    if (ft <= FILETIME_EPOCH_OFFSET) return 0;
    return Number((ft - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
  } catch (_e) {
    return 0;
  }
}

function isSafePositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createSovNativeReader(deps) {
  const { requireGame } = deps;
  let sovState = null;
  let sovStore = null;
  let loadFailed = false;

  function ensureSovState() {
    if (sovState !== null || loadFailed) return;
    const loaded = requireGame("services/sovereignty/sovState");
    if (!loaded.ok) { loadFailed = true; return; }
    if (!loaded.exports || typeof loaded.exports.getSystemState !== "function") { loadFailed = true; return; }
    sovState = loaded.exports;
  }

  function ensureSovStore() {
    if (sovStore !== null) return;
    const loaded = requireGame("services/sovereignty/sovStore");
    if (!loaded.ok || !loaded.exports || typeof loaded.exports.readSovereigntyTableUpdatedAt !== "function") {
      sovStore = false;
      return;
    }
    sovStore = loaded.exports;
  }

  function readCampaignOutcomes(systemId, opts = {}) {
    ensureSovState();
    if (loadFailed || !sovState) return { ok: false, reason: "SOV_UNAVAILABLE", detail: "sovState not loaded" };

    const numericSystemId = Number.isSafeInteger(systemId) && systemId > 0 ? systemId : 0;
    if (!numericSystemId) return { ok: false, reason: "INVALID_SYSTEM_ID" };

    const max = Number.isSafeInteger(opts.max) && opts.max > 0 ? opts.max : 100;
    const offsetMs = Number.isSafeInteger(opts.offsetMs) ? opts.offsetMs : 0;

    try {
      const system = sovState.getSystemState(numericSystemId);
      if (!system) return { ok: true, outcomes: [], truncated: false, skipped: 0 };

      const receipts = system.campaignOutcomeReceipts;
      if (!receipts || typeof receipts !== "object") return { ok: true, outcomes: [], truncated: false, skipped: 0 };

      const raw = [];
      let skipped = 0;

      for (const receipt of Object.values(receipts)) {
        if (!isSafePositiveInt(receipt.targetID)) { skipped++; continue; }
        if (!isSafePositiveInt(receipt.defenderAllianceID)) { skipped++; continue; }
        if (!receipt.campaignEpoch || typeof receipt.campaignEpoch !== "string" || receipt.campaignEpoch.trim() === "") { skipped++; continue; }
        if (receipt.solarSystemID !== numericSystemId) { skipped++; continue; }

        const completedAtMs = filetimeToMs(receipt.completedAtTime);
        if (completedAtMs <= offsetMs || completedAtMs === 0) { skipped++; continue; }

        const result = typeof receipt.result === "string" ? receipt.result.toLowerCase() : "";
        if (result !== "attacker" && result !== "defender") { skipped++; continue; }

        raw.push({
          targetId: receipt.targetID,
          campaignEpoch: receipt.campaignEpoch.trim(),
          defenderAllianceId: receipt.defenderAllianceID,
          result,
          completedAtMs,
          solarSystemId: receipt.solarSystemID,
        });
      }

      raw.sort((a, b) => {
        if (a.completedAtMs !== b.completedAtMs) return a.completedAtMs - b.completedAtMs;
        if (a.campaignEpoch !== b.campaignEpoch) return a.campaignEpoch.localeCompare(b.campaignEpoch);
        return a.targetId - b.targetId;
      });

      const truncated = raw.length > max;
      const outcomes = truncated ? raw.slice(-max) : raw;

      return { ok: true, outcomes, truncated, skipped };
    } catch (err) {
      return { ok: false, reason: "SOV_UNAVAILABLE", detail: String(err) };
    }
  }

  function readUpdatedAt() {
    ensureSovStore();
    if (!sovStore) return { ok: false, reason: "SOV_STORE_UNAVAILABLE", detail: "sovStore not loaded" };
    try {
      const updatedAt = sovStore.readSovereigntyTableUpdatedAt();
      return { ok: true, updatedAt };
    } catch (err) {
      return { ok: false, reason: "SOV_STORE_UNAVAILABLE", detail: String(err) };
    }
  }

  function checkSovNativeSeams() {
    ensureSovState();
    ensureSovStore();
    const missing = [];
    if (loadFailed || !sovState) missing.push("sovState.getSystemState");
    if (!sovStore) missing.push("sovStore.readSovereigntyTableUpdatedAt");
    if (missing.length > 0) return { ok: false, reason: "SEAM_MISSING", missing };
    return { ok: true };
  }

  function getSystemSovClaim(systemId) {
    ensureSovState();
    if (loadFailed || !sovState) return { ok: false, reason: "SOV_UNAVAILABLE", detail: "sovState not loaded" };
    try {
      const claim = sovState.getSystemSovClaim(systemId);
      if (!claim) return { ok: true, claimed: false, allianceId: null, corporationId: null };
      const allianceId = Number.isSafeInteger(claim.allianceID) && claim.allianceID > 0 ? claim.allianceID : null;
      const corporationId = Number.isSafeInteger(claim.corporationID) && claim.corporationID > 0 ? claim.corporationID : null;
      return { ok: true, claimed: allianceId !== null, allianceId, corporationId };
    } catch (err) {
      return { ok: false, reason: "SOV_UNAVAILABLE", detail: String(err) };
    }
  }

  return Object.freeze({ readCampaignOutcomes, readUpdatedAt, checkSovNativeSeams, getSystemSovClaim });
}

module.exports = { createSovNativeReader, FILETIME_EPOCH_OFFSET, FILETIME_TICKS_PER_MS, filetimeToMs };