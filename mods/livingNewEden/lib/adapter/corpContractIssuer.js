"use strict";

const SYNTHETIC_ISSUER = Symbol("lne.syntheticCorpIssuer");
const WRAPPED = Symbol("lne.corpIssuerAuthorityWrapped");

const toId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

function markSyntheticIssuer(session, roleMask) {
  const s = session && typeof session === "object" ? session : {};
  const out = { ...s };
  if (typeof roleMask === "bigint") out.corprole = roleMask;
  out[SYNTHETIC_ISSUER] = {
    characterId: toId(s.characterID),
    corporationId: toId(s.corporationID),
    roleMask: typeof roleMask === "bigint" ? roleMask : 0n,
  };
  return out;
}

function syntheticAuthorityOf(session, getCorporationRecord) {
  const marker = session && typeof session === "object" ? session[SYNTHETIC_ISSUER] : null;
  if (!marker || typeof marker !== "object") return null;
  const characterID = toId(marker.characterId);
  const corporationID = toId(marker.corporationId);
  if (!characterID || !corporationID) return null;
  if (toId(session.characterID) !== characterID || toId(session.corporationID) !== corporationID) return null;
  const corporation = getCorporationRecord(corporationID);
  if (!corporation || corporation.deleted) return null;
  if (toId(corporation.ceoID ?? corporation.ceoId) !== characterID) return null;
  return {
    characterID,
    corporationID,
    corporation,
    member: null,
    sessionCorporationRoles: marker.roleMask,
    isCEO: true,
    isDirector: true,
  };
}

function wrapCorpIssuerAuthority(authorityExports, corporationStateExports) {
  if (!authorityExports || typeof authorityExports.getPersistedCorporationAuthority !== "function"
      || !corporationStateExports || typeof corporationStateExports.getCorporationRecord !== "function") {
    return { ok: false, reason: "AUTHORITY_SEAM_UNAVAILABLE" };
  }
  if (authorityExports[WRAPPED] === true) return { ok: true, alreadyInstalled: true };
  const original = authorityExports.getPersistedCorporationAuthority;
  const wrapper = function (...args) {
    const result = original.apply(this, args);
    if (result) return result;
    const session = args[0];
    if (!session || typeof session !== "object" || !session[SYNTHETIC_ISSUER]) return result;
    try {
      return syntheticAuthorityOf(session, (id) => corporationStateExports.getCorporationRecord(id)) || result;
    } catch (_err) {
      return result;
    }
  };
  wrapper._lneOriginal = original;
  authorityExports.getPersistedCorporationAuthority = wrapper;
  authorityExports[WRAPPED] = true;
  return { ok: true, alreadyInstalled: false };
}

function createCorpIssuerAuthorityInstaller(requireGame, log) {
  let state = null;
  const refuse = (reason) => {
    if (state !== null) return;
    state = "refused";
    try {
      log(`trade: corporation issuer authority not wrapped - ${reason}; corporation contracts may be refused`);
    } catch (_err) {
    }
  };
  return function ensureCorpIssuerAuthority() {
    if (state === "wrapped") return;
    try {
      const auth = requireGame("services/corporation/corporationAuthority");
      const corp = requireGame("services/corporation/corporationState");
      const r = auth.ok && corp.ok ? wrapCorpIssuerAuthority(auth.exports, corp.exports)
        : { ok: false, reason: auth.ok ? corp.reason : auth.reason };
      if (r.ok) state = "wrapped";
      else refuse(r.reason);
    } catch (err) {
      refuse(err && err.message);
    }
  };
}

module.exports = {
  SYNTHETIC_ISSUER, markSyntheticIssuer, syntheticAuthorityOf, wrapCorpIssuerAuthority, createCorpIssuerAuthorityInstaller,
};
