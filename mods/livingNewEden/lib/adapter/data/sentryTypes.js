"use strict";

const SENTRY_KINDS = Object.freeze(["sentry", "heavy_sentry", "listening_post"]);
const SENTRY_KIND = "sentry";
const HEAVY_SENTRY_KIND = "heavy_sentry";
const LISTENING_POST_KIND = "listening_post";
const HEAVY_AMMO = Object.freeze({
  projectile: Object.freeze({ typeId: 17668, damage: 96 }),
  hybrid: Object.freeze({ typeId: 17648, damage: 96 }),
  laser: Object.freeze({ typeId: 17686, damage: 96 }),
  missile: Object.freeze({ typeId: 17859, damage: 5885 }),
});
const POST_ATTRIBUTES = Object.freeze({ 9: 50000, 263: 50000, 265: 100000, 552: 2000 });

const SENTRY_TYPES = Object.freeze([
  Object.freeze({ typeId: 340500, kind: SENTRY_KIND, family: "projectile", sourceTypeId: 16631, passive: false }),
  Object.freeze({ typeId: 340501, kind: SENTRY_KIND, family: "hybrid", sourceTypeId: 16690, passive: false }),
  Object.freeze({ typeId: 340502, kind: SENTRY_KIND, family: "laser", sourceTypeId: 17167, passive: false }),
  Object.freeze({ typeId: 340503, kind: SENTRY_KIND, family: "missile", sourceTypeId: 16696, passive: false }),
  Object.freeze({ typeId: 340520, kind: LISTENING_POST_KIND, family: null, sourceTypeId: 16216, passive: true,
    attributes: POST_ATTRIBUTES }),
  Object.freeze({ typeId: 340522, kind: HEAVY_SENTRY_KIND, family: "projectile", sourceTypeId: 16689, passive: false,
    ammo: HEAVY_AMMO.projectile }),
  Object.freeze({ typeId: 340523, kind: HEAVY_SENTRY_KIND, family: "hybrid", sourceTypeId: 16692, passive: false,
    ammo: HEAVY_AMMO.hybrid }),
  Object.freeze({ typeId: 340524, kind: HEAVY_SENTRY_KIND, family: "laser", sourceTypeId: 16694, passive: false,
    ammo: HEAVY_AMMO.laser }),
  Object.freeze({ typeId: 340525, kind: HEAVY_SENTRY_KIND, family: "missile", sourceTypeId: 17773, passive: false,
    ammo: HEAVY_AMMO.missile }),
]);
const WEAPON_TYPES = Object.freeze(SENTRY_TYPES.filter((t) => t.kind === SENTRY_KIND));

const ID_SET = new Set(SENTRY_TYPES.map((t) => t.typeId));
const SENTRY_TYPE_IDS = Object.freeze(SENTRY_TYPES.map((t) => t.typeId));

function isSentryTypeId(typeId) {
  return ID_SET.has(Number(typeId));
}

const DEFAULT_AMMO = Object.freeze({
  projectile: Object.freeze({ typeId: 193, units: 2000, damage: 24 }),
  hybrid: Object.freeze({ typeId: 230, units: 2000, damage: 24 }),
  laser: Object.freeze({ typeId: 254, units: 1, damage: 24 }),
  missile: Object.freeze({ typeId: 203, units: 400, damage: 375 }),
});
const FACTION_FAMILY = Object.freeze({ 500001: "missile", 500002: "projectile", 500003: "laser", 500004: "hybrid",
  500010: "missile", 500011: "projectile", 500012: "laser", 500019: "laser", 500020: "hybrid" });
const DEFAULT_FAMILY = "hybrid";

function familyOfFaction(factionId) {
  return Object.prototype.hasOwnProperty.call(FACTION_FAMILY, String(factionId)) ? FACTION_FAMILY[factionId]
    : DEFAULT_FAMILY;
}

function sentryTypeOfFaction(factionId) {
  const family = familyOfFaction(factionId);
  return WEAPON_TYPES.find((t) => t.family === family).typeId;
}

function defaultAmmoOfType(typeId) {
  const t = WEAPON_TYPES.find((x) => x.typeId === Number(typeId));
  if (t) return DEFAULT_AMMO[t.family];
  const heavy = SENTRY_TYPES.find((x) => x.typeId === Number(typeId) && x.kind === HEAVY_SENTRY_KIND);
  return heavy ? heavy.ammo : null;
}

function kindOfType(typeId) {
  const t = SENTRY_TYPES.find((x) => x.typeId === Number(typeId));
  return t ? t.kind : null;
}

function sentryTypeOf(typeId) {
  return SENTRY_TYPES.find((x) => x.typeId === Number(typeId)) || null;
}

function isPassiveKind(kind) {
  return kind === LISTENING_POST_KIND;
}

function typeIdsOfKind(kind) {
  return SENTRY_TYPES.filter((t) => t.kind === kind).map((t) => t.typeId);
}

const LOOK_CANDIDATES = Object.freeze([1194, 3739, 3740, 3741, 3742, 3743]);

module.exports = { SENTRY_TYPES, SENTRY_TYPE_IDS, WEAPON_TYPES, SENTRY_KINDS, DEFAULT_AMMO, HEAVY_AMMO, FACTION_FAMILY,
  LOOK_CANDIDATES, isSentryTypeId, familyOfFaction, sentryTypeOfFaction, defaultAmmoOfType, kindOfType, sentryTypeOf,
  isPassiveKind, typeIdsOfKind };
