"use strict";

function createSovClaimReader(deps) {
  const { requireGame } = deps;
  let sovState = null;
  let loadFailed = false;

  function ensureLoaded() {
    if (sovState !== null || loadFailed) return;
    const loaded = requireGame("services/sovereignty/sovState");
    if (!loaded.ok) { loadFailed = true; return; }
    if (!loaded.exports || typeof loaded.exports.getSystemSovClaim !== "function") { loadFailed = true; return; }
    sovState = loaded.exports;
  }

  function claimOf(systemId) {
    ensureLoaded();
    if (loadFailed || !sovState) return { ok: false, reason: "SOV_UNAVAILABLE", detail: "sovState not loaded" };
    try {
      const claim = sovState.getSystemSovClaim(systemId);
      if (!claim) return { ok: true, claimed: false, allianceId: null };
      const allianceId = Number.isSafeInteger(claim.allianceID) && claim.allianceID > 0 ? claim.allianceID : null;
      return { ok: true, claimed: allianceId !== null, allianceId };
    } catch (err) {
      return { ok: false, reason: "SOV_UNAVAILABLE", detail: String(err) };
    }
  }

  function available() {
    ensureLoaded();
    return !loadFailed && sovState !== null;
  }

  return Object.freeze({ claimOf, available });
}

module.exports = { createSovClaimReader };