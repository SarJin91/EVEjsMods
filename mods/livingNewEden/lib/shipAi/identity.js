"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const MAX_DETAIL = 120;
const detailOf = (value) => String(value ?? "").slice(0, MAX_DETAIL);
const refuse = (reason, detail) => ({ ok: false, reason, detail: detailOf(detail) });

function buildAiRecord({ aiId, name, corporationId, bio, identityKey }) {
  return {
    characterId: aiId,
    characterName: name,
    corporationID: corporationId,
    allianceID: 0,
    gender: S.AI_GENDER,
    typeID: S.AI_TYPE_ID,
    description: bio,
    accountId: 0,
    lneIdentityKey: identityKey,
    lneVersion: 1,
  };
}

function readPrefs(store, repo, playerId) {
  const res = store.transaction("shipAi.identity.read", (db) => {
    const got = repo.getByPlayer(db, playerId);
    if (!got.ok || got.row) return got;
    const counted = repo.countRows(db);
    return counted.ok ? { ok: true, row: null, count: counted.count } : counted;
  });
  if (!res.ok) return refuse("IDENTITY_FAILED", `read: ${res.reason}`);
  if (!res.value || !res.value.ok) return refuse("IDENTITY_FAILED", `read: ${res.value && res.value.reason}`);
  return res.value;
}

function insertPrefs(store, repo, spec) {
  const res = store.transaction("shipAi.identity.insert", (db) => {
    const got = repo.getByPlayer(db, spec.playerId);
    if (!got.ok || got.row) return got;
    return repo.insert(db, spec);
  });
  if (!res.ok) return refuse("IDENTITY_FAILED", `insert: ${res.reason}`);
  if (!res.value || !res.value.ok) return refuse("IDENTITY_FAILED", `insert: ${res.value && res.value.reason}`);
  return res.value;
}

function ensureIdentity(deps, playerId) {
  const d = deps || {};
  const { store, repo, settings, identities } = d;
  if (!isId(playerId)) return refuse("IDENTITY_FAILED", "playerId");
  if (!store || !repo || !settings || !identities || typeof d.nowMs !== "function") {
    return refuse("IDENTITY_FAILED", "deps");
  }
  try {
    const prefs = readPrefs(store, repo, playerId);
    if (!prefs.ok) return prefs;
    if (prefs.row) return { ok: true, aiId: prefs.row.aiId, name: prefs.row.name, created: false };
    const identityKey = S.identityKeyOf(playerId);
    const found = identities.findByMarker(identityKey);
    if (!found || !found.ok) return refuse("IDENTITY_FAILED", `marker: ${found && found.reason}`);
    let aiId = 0;
    let name = settings.defaultName;
    let created = false;
    if (found.found === true && isId(found.characterId)) {
      aiId = found.characterId;
      if (typeof found.name === "string" && found.name !== "") name = found.name;
    } else {
      if (prefs.count >= settings.maxIdentities) {
        return refuse("IDENTITY_LIMIT", `${prefs.count}/${settings.maxIdentities}`);
      }
      const reserved = identities.reserveCharacterId();
      if (!reserved || !reserved.ok || !isId(reserved.characterId)) {
        return refuse("IDENTITY_FAILED", `reserve: ${reserved && reserved.reason}`);
      }
      aiId = reserved.characterId;
      const written = identities.writeCharacter(buildAiRecord({ aiId, name, corporationId: settings.corporationId,
        bio: settings.bio, identityKey }));
      if (!written || !written.ok) return refuse("IDENTITY_FAILED", `write: ${written && written.reason}`);
      const flushed = identities.flush(["characters"]);
      if (!flushed || !flushed.ok) return refuse("IDENTITY_FAILED", `flush: ${flushed && flushed.reason}`);
      created = true;
    }
    const inserted = insertPrefs(store, repo, { playerId, aiId, name, nowMs: d.nowMs() });
    if (!inserted.ok) return inserted;
    const row = inserted.row;
    return { ok: true, aiId: row.aiId, name: row.name, created: created && row.aiId === aiId };
  } catch (err) {
    return refuse("IDENTITY_FAILED", (err && err.message) || err);
  }
}

module.exports = { ensureIdentity, buildAiRecord };
