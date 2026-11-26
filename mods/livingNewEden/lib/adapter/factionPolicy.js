"use strict";

const MAX_DETAIL_LENGTH = 200;
const MANIFEST_FILE_NAME = "manifest.json";

function messageOf(err) {
  return String((err && (err.code || err.message)) || err).slice(0, MAX_DETAIL_LENGTH);
}

function invertFactionTable(table) {
  const out = new Map();
  for (const [key, value] of Object.entries(table)) {
    const id = Number(key);
    if (Number.isSafeInteger(id) && id > 0 && typeof value === "string" && value !== "" && !out.has(value)) {
      out.set(value, id);
    }
  }
  return out;
}

function resolveSystemFactionsFrom(policy, systemIds) {
  if (!policy || typeof policy.resolvePirateFactionForSystem !== "function") {
    return { ok: false, reason: "FACTION_POLICY_DRIFT", detail: "resolvePirateFactionForSystem" };
  }
  const table = policy.PIRATE_FACTION_BY_FACTION_ID;
  if (!table || typeof table !== "object") {
    return { ok: false, reason: "FACTION_POLICY_DRIFT", detail: "PIRATE_FACTION_BY_FACTION_ID" };
  }
  const byKey = invertFactionTable(table);
  if (byKey.size === 0) {
    return { ok: false, reason: "FACTION_POLICY_DRIFT", detail: "PIRATE_FACTION_BY_FACTION_ID empty" };
  }
  if (!Array.isArray(systemIds)) {
    return { ok: false, reason: "FACTION_POLICY_FAILED", detail: "systemIds", systemId: 0 };
  }
  const entries = [];
  for (const systemId of systemIds) {
    let resolved;
    try {
      resolved = policy.resolvePirateFactionForSystem(systemId);
    } catch (err) {
      return { ok: false, reason: "FACTION_POLICY_FAILED", detail: messageOf(err), systemId };
    }
    const factionKey = resolved && typeof resolved.factionKey === "string" ? resolved.factionKey : "";
    entries.push(Object.freeze({
      systemId,
      factionKey,
      factionId: byKey.has(factionKey) ? byKey.get(factionKey) : null,
      source: resolved && typeof resolved.source === "string" ? resolved.source : "unknown",
      specialSpace: Boolean(resolved && resolved.specialSpace),
    }));
  }
  return { ok: true, entries };
}

function readSdeBuildFrom(storeRoot, readFileSync, join) {
  if (typeof storeRoot !== "string" || storeRoot === "") {
    return { ok: false, reason: "SDE_BUILD_UNAVAILABLE", detail: "store root unknown" };
  }
  let manifest;
  try {
    manifest = JSON.parse(String(readFileSync(join(storeRoot, MANIFEST_FILE_NAME), "utf8")));
  } catch (err) {
    return { ok: false, reason: "SDE_BUILD_UNAVAILABLE", detail: messageOf(err) };
  }
  const build = manifest && manifest.build;
  if (!Number.isSafeInteger(build) || build <= 0) {
    return { ok: false, reason: "SDE_BUILD_UNAVAILABLE", detail: "manifest.json build" };
  }
  return { ok: true, build };
}

module.exports = { resolveSystemFactionsFrom, readSdeBuildFrom };
