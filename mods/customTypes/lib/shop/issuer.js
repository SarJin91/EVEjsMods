"use strict";

const SHOP_ISSUER = Symbol("customTypes.shopIssuer");
const WRAPPED = Symbol("customTypes.shopIssuerWrapped");

const toId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

function markShopIssuer(session, roleMask) {
  const source = session && typeof session === "object" ? session : {};
  const out = { ...source };
  if (typeof roleMask === "bigint") out.corprole = roleMask;
  out[SHOP_ISSUER] = {
    characterId: toId(source.characterID),
    corporationId: toId(source.corporationID),
    roleMask: typeof roleMask === "bigint" ? roleMask : 0n,
  };
  return out;
}

function shopAuthorityOf(session, getCorporationRecord) {
  const marker = session && typeof session === "object" ? session[SHOP_ISSUER] : null;
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

function wrapShopIssuerAuthority(authorityExports, corporationStateExports) {
  if (!authorityExports || typeof authorityExports.getPersistedCorporationAuthority !== "function"
      || !corporationStateExports || typeof corporationStateExports.getCorporationRecord !== "function") {
    return { ok: false, reason: "AUTHORITY_SEAM_UNAVAILABLE" };
  }
  if (authorityExports[WRAPPED] === true) return { ok: true, alreadyInstalled: true };
  const original = authorityExports.getPersistedCorporationAuthority;
  const wrapper = function getPersistedCorporationAuthority(...args) {
    const result = original.apply(this, args);
    if (result) return result;
    const session = args[0];
    if (!session || typeof session !== "object" || !session[SHOP_ISSUER]) return result;
    try {
      return shopAuthorityOf(session, (id) => corporationStateExports.getCorporationRecord(id)) || result;
    } catch (_error) {
      return result;
    }
  };
  wrapper._customTypesOriginal = original;
  authorityExports.getPersistedCorporationAuthority = wrapper;
  authorityExports[WRAPPED] = true;
  return { ok: true, alreadyInstalled: false };
}

module.exports = {
  SHOP_ISSUER,
  markShopIssuer,
  shopAuthorityOf,
  wrapShopIssuerAuthority,
};
