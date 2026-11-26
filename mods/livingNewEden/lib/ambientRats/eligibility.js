"use strict";

const { BANDS, EXCLUDED_SOURCE_FACTION_IDS, GROUPS_KEY_BY_BAND, HIGHSEC_FORBIDDEN_KINDS, parseBands,
  parseFactionKinds } = require("./schema");

const refuse = (reason) => ({ ok: false, reason });

function listOf(value, parse) {
  if (Array.isArray(value)) return value;
  return parse(value) || [];
}

function hasId(ids, id) {
  if (ids instanceof Set) return ids.has(id) || ids.has(String(id));
  if (Array.isArray(ids)) return ids.some((x) => Number(x) === id);
  return false;
}

function decideEligibility(input, tables, settings) {
  const i = input && typeof input === "object" ? input : {};
  const t = tables && typeof tables === "object" ? tables : {};
  const s = settings && typeof settings === "object" ? settings : {};
  if (i.eligible === false || !BANDS.includes(i.band)) return refuse("BAND_INELIGIBLE");
  const highsecNavy = i.band === "highsec" && s.highsecNavy === true;
  if (!highsecNavy && !listOf(s.bands, parseBands).includes(i.band)) return refuse("BAND_OFF");
  if (highsecNavy && t.concordGateAggroNpcs !== false) return refuse("CONCORD_AGGRO_NPC");
  const factionId = i.controllerFactionId;
  if (!Number.isSafeInteger(factionId) || factionId <= 0) return refuse("NO_CONTROLLER");
  if (highsecNavy && HIGHSEC_FORBIDDEN_KINDS.includes(i.kind)) return refuse("HIGHSEC_PIRATE");
  if (!listOf(s.factionKinds, parseFactionKinds).includes(i.kind)) return refuse("KIND_OFF");
  if (s.scope === "captured" && factionId === i.homeFactionId) return refuse("NOT_CAPTURED");

  let source = null;
  if (i.kind === "empire") {
    if (hasId(t.navyFactionIds, factionId)) source = { type: "navy" };
  } else if (!EXCLUDED_SOURCE_FACTION_IDS.includes(factionId)) {
    const keys = t.pirateKeyByFactionId && typeof t.pirateKeyByFactionId === "object" ? t.pirateKeyByFactionId : {};
    const factionKey = Object.prototype.hasOwnProperty.call(keys, factionId) ? keys[factionId] : null;
    if (typeof factionKey === "string" && factionKey !== "") source = { type: "pirate", factionKey };
  }
  if (source === null) return refuse("NO_SOURCE");

  const groupsTarget = s[GROUPS_KEY_BY_BAND[i.band]];
  if (!Number.isSafeInteger(groupsTarget) || groupsTarget <= 0) return refuse("NO_GROUPS");
  return { ok: true, factionId, kind: i.kind, band: i.band, source, groupsTarget };
}

module.exports = { decideEligibility };
