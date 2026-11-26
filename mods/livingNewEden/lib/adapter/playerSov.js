"use strict";

const HUB_TYPE_ID = 32458;
const STATE_PATH = "services/sovereignty/sovState";
const GM_PATH = "services/sovereignty/sovGmState";
const STORE_PATH = "services/sovereignty/sovStore";
const UNAVAILABLE = "PLAYER_SOV_SEAM_UNAVAILABLE";
const SEAM_ERROR = "SEAM_ERROR";

const posInt = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const messageOf = (err) => String((err && err.message) || err).slice(0, 160);

function safeVirtual(isVirtualAlliance, allianceId) {
  try {
    return typeof isVirtualAlliance === "function" && isVirtualAlliance(allianceId) === true;
  } catch (_err) {
    return false;
  }
}

function hubOf(system) {
  const list = system && Array.isArray(system.structures) ? system.structures : [];
  for (const s of list) {
    if (s && posInt(s.typeID) === HUB_TYPE_ID && posInt(s.itemID) !== null) return s;
  }
  return null;
}

function neutralPlayerHubOf(system, isVirtualAlliance) {
  const hub = hubOf(system);
  const flags = hub && hub.devFlags && typeof hub.devFlags === "object" ? hub.devFlags : null;
  if (!flags || flags.sovereigntyNeutralHub !== true || flags.sovereigntyCaptured === true) return null;
  const allianceId = posInt(flags.sovereigntyDeployedByAllianceID);
  const corpId = posInt(flags.sovereigntyDeployedByCorporationID);
  if (allianceId === null || corpId === null || safeVirtual(isVirtualAlliance, allianceId)) return null;
  return { itemId: posInt(hub.itemID), allianceId, corpId };
}

function claimOf(system) {
  const allianceId = system ? posInt(system.allianceID) : null;
  if (allianceId === null) return null;
  const hub = hubOf(system);
  const hubItemId = posInt(system.claimStructureID) ?? posInt(system.infrastructureHubID)
    ?? (hub ? posInt(hub.itemID) : null);
  return { allianceId, corpId: posInt(system.corporationID), hubItemId };
}

function readPlayerSovFrom(vendor, opts) {
  const sovState = vendor && vendor.sovState;
  if (!sovState || typeof sovState.listAllSovereigntySystemStates !== "function") {
    return { ok: false, reason: UNAVAILABLE, detail: "sovState.listAllSovereigntySystemStates" };
  }
  const isVirtualAlliance = opts && opts.isVirtualAlliance;
  try {
    const list = sovState.listAllSovereigntySystemStates();
    if (!Array.isArray(list)) return { ok: false, reason: SEAM_ERROR, detail: "not an array" };
    const rows = [];
    for (const system of list) {
      const systemId = system ? posInt(system.solarSystemID) : null;
      if (systemId === null) continue;
      const claim = claimOf(system);
      if (claim && safeVirtual(isVirtualAlliance, claim.allianceId)) {
        rows.push({ systemId, allianceId: null, corpId: null, hubItemId: null, neutralHub: null, virtualClaim: true });
        continue;
      }
      const neutralHub = neutralPlayerHubOf(system, isVirtualAlliance);
      if (!claim && !neutralHub) continue;
      rows.push({ systemId, allianceId: claim ? claim.allianceId : null, corpId: claim ? claim.corpId : null,
        hubItemId: claim ? claim.hubItemId : null, neutralHub, virtualClaim: false });
    }
    return { ok: true, rows, scanned: list.length };
  } catch (err) {
    return { ok: false, reason: SEAM_ERROR, detail: messageOf(err) };
  }
}

function readSystem(vendor, systemId) {
  const sovState = vendor && vendor.sovState;
  if (!sovState || typeof sovState.getSystemState !== "function") {
    return { ok: false, reason: UNAVAILABLE, detail: "sovState.getSystemState" };
  }
  if (posInt(systemId) === null) return { ok: false, reason: "INVALID_INPUT", detail: "systemId" };
  try {
    return { ok: true, system: sovState.getSystemState(systemId) || null };
  } catch (err) {
    return { ok: false, reason: SEAM_ERROR, detail: messageOf(err) };
  }
}

async function callVendor(vendor, name, args) {
  if (!vendor || !vendor.sovGmState || typeof vendor.sovGmState[name] !== "function"
    || typeof vendor.executeSovCall !== "function") {
    return { ok: false, reason: UNAVAILABLE, detail: `sovGmState.${name}`, permanent: false };
  }
  try {
    const r = await vendor.executeSovCall(vendor.sovGmState, name, args);
    return r && r.ok === true ? { ok: true }
      : { ok: false, reason: String((r && r.reason) || "VENDOR_REFUSED"), permanent: Boolean(r && r.permanent) };
  } catch (err) {
    return { ok: false, reason: SEAM_ERROR, detail: messageOf(err), permanent: false };
  }
}

async function releasePlayerSovFrom(vendor, systemId, expect) {
  const e = expect || {};
  if (posInt(e.allianceId) === null || posInt(e.hubItemId) === null) {
    return { ok: false, reason: "INVALID_INPUT", detail: "expect", permanent: true };
  }
  const read = readSystem(vendor, systemId);
  if (!read.ok) return { ...read, permanent: false };
  const claim = claimOf(read.system);
  const hub = hubOf(read.system);
  if (!claim && !hub) return { ok: true, outcome: "alreadyGone" };
  const flags = hub && hub.devFlags && typeof hub.devFlags === "object" ? hub.devFlags : {};
  const claimMatch = claim !== null && claim.allianceId === e.allianceId && claim.hubItemId === e.hubItemId;
  const neutralMatch = claim === null && hub !== null && flags.sovereigntyNeutralHub === true
    && flags.sovereigntyCaptured !== true && posInt(hub.itemID) === e.hubItemId
    && posInt(flags.sovereigntyDeployedByAllianceID) === e.allianceId;
  if (!claimMatch && !neutralMatch) return { ok: true, outcome: "ownerChanged" };
  const r = await callVendor(vendor, "loseSystemSovereignty", [systemId]);
  return r.ok ? { ok: true, outcome: "released" } : r;
}

async function capturePlayerSovFrom(vendor, systemId, expect) {
  const e = expect || {};
  if (posInt(e.allianceId) === null || posInt(e.corpId) === null || posInt(e.hubItemId) === null) {
    return { ok: false, reason: "INVALID_INPUT", detail: "expect" };
  }
  const read = readSystem(vendor, systemId);
  if (!read.ok) return read;
  const hub = hubOf(read.system);
  if (!hub || posInt(hub.itemID) !== e.hubItemId) return { ok: true, outcome: "ownerChanged" };
  const flags = hub.devFlags && typeof hub.devFlags === "object" ? hub.devFlags : {};
  if (flags.sovereigntyNeutralHub !== true || flags.sovereigntyCaptured === true || claimOf(read.system) !== null) {
    return { ok: true, outcome: "notNeutral" };
  }
  if (posInt(flags.sovereigntyDeployedByAllianceID) !== e.allianceId) return { ok: true, outcome: "ownerChanged" };
  const r = await callVendor(vendor, "anchorSovereigntyHub", [systemId, e.allianceId, e.corpId]);
  return r.ok ? { ok: true, outcome: "captured" } : r;
}

function createPlayerSovSeam(deps) {
  const disabled = () => {
    try {
      return typeof deps.disabledReason === "function" ? deps.disabledReason() : null;
    } catch (_err) {
      return null;
    }
  };

  function load(path) {
    try {
      const r = deps.requireGame(path);
      return r && r.ok === true && r.exports ? r.exports : null;
    } catch (_err) {
      return null;
    }
  }

  function vendor() {
    const off = disabled();
    if (off !== null) return { ok: false, reason: UNAVAILABLE, detail: off };
    const sovState = load(STATE_PATH);
    if (!sovState) return { ok: false, reason: UNAVAILABLE, detail: STATE_PATH };
    return { ok: true, vendor: { sovState, sovGmState: load(GM_PATH), executeSovCall: deps.executeSovCall } };
  }

  function checkSeams() {
    const v = vendor();
    if (!v.ok) return v;
    const missing = [];
    if (typeof v.vendor.sovState.listAllSovereigntySystemStates !== "function") missing.push("listAllSovereigntySystemStates");
    if (typeof v.vendor.sovState.getSystemState !== "function") missing.push("getSystemState");
    const gm = v.vendor.sovGmState;
    if (!gm || typeof gm.loseSystemSovereignty !== "function") missing.push("loseSystemSovereignty");
    if (!gm || typeof gm.anchorSovereigntyHub !== "function") missing.push("anchorSovereigntyHub");
    return missing.length === 0 ? { ok: true } : { ok: false, reason: UNAVAILABLE, detail: missing.join(",") };
  }

  function readPlayerSov(opts) {
    const v = vendor();
    return v.ok ? readPlayerSovFrom(v.vendor, opts || {}) : v;
  }

  async function releasePlayerSov(systemId, expect) {
    const v = vendor();
    return v.ok ? releasePlayerSovFrom(v.vendor, systemId, expect) : { ...v, permanent: false };
  }

  async function capturePlayerSov(systemId, expect) {
    const v = vendor();
    return v.ok ? capturePlayerSovFrom(v.vendor, systemId, expect) : v;
  }

  function readSovereigntyTableUpdatedAt() {
    const off = disabled();
    if (off !== null) return { ok: false, reason: UNAVAILABLE, detail: off };
    const sovStore = load(STORE_PATH);
    if (!sovStore || typeof sovStore.readSovereigntyTableUpdatedAt !== "function") {
      return { ok: false, reason: UNAVAILABLE, detail: STORE_PATH };
    }
    try {
      return { ok: true, updatedAt: sovStore.readSovereigntyTableUpdatedAt() ?? null };
    } catch (err) {
      return { ok: false, reason: SEAM_ERROR, detail: messageOf(err) };
    }
  }

  return Object.freeze({ checkSeams, readPlayerSov, releasePlayerSov, capturePlayerSov, readSovereigntyTableUpdatedAt });
}

module.exports = {
  HUB_TYPE_ID,
  neutralPlayerHubOf,
  readPlayerSovFrom,
  releasePlayerSovFrom,
  capturePlayerSovFrom,
  createPlayerSovSeam,
};
