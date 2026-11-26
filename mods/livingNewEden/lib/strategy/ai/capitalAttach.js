"use strict";

const { fitIskOf } = require("./warChest");

const CAPITAL_ATTACH_ROLES_ALLOWED = Object.freeze(["invasion", "garrison", "patrol", "hunter"]);
const NONE = "none";
const NOTE_NOT_AT_STATION = "CAPITAL_NOT_AT_STATION";
const NOTE_SKIPPED_ISK = "CAPITAL_SKIPPED_ISK";
const NOTE_LEVEL_GATED = "CAPITAL_LEVEL_GATED";
const HUNTER_ROLE = "hunter";

const CAPITAL_LEVEL_TIER = Object.freeze({ carrier: 1, dreadnought: 1, force_auxiliary: 1, supercarrier: 2, titan: 2 });
const SUPER_TIER = 2;

const byItemKey = (a, b) => (a.itemKey < b.itemKey ? -1 : (a.itemKey > b.itemKey ? 1 : 0));

function parseCapitalClassList(text, classes) {
  if (typeof text !== "string" || !Array.isArray(classes)) return null;
  const trimmed = text.trim();
  if (trimmed === NONE) return [];
  const out = [];
  for (const raw of trimmed.split(",")) {
    const name = raw.trim();
    if (name === "" || !classes.includes(name) || out.includes(name)) return null;
    out.push(name);
  }
  return out;
}

const off = () => ({ entries: [], items: [], fitIsk: 0, note: null, eligible: false });
const nat = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function classesOf(a) {
  const attach = a && a.attach;
  if (!attach || !Array.isArray(attach.order)) return { owned: [], candidates: [] };
  const template = Array.isArray(a.template) ? a.template : [];
  const groups = new Set(template.map((e) => e.hullGroup));
  const free = Array.isArray(attach.freeGroups) ? attach.freeGroups : [];
  const classes = a.capitalClasses && typeof a.capitalClasses === "object" ? a.capitalClasses : {};
  const owned = attach.order.filter((cls) => Object.prototype.hasOwnProperty.call(classes, cls)
    && nat(classes[cls]) > 0 && !groups.has(cls) && !free.includes(cls));
  const minLevelOf = attach.minLevelOf && typeof attach.minLevelOf === "object" ? attach.minLevelOf : null;
  const level = Number.isSafeInteger(a.level) && a.level > 0 ? a.level : 0;
  const leveled = minLevelOf === null ? owned : owned.filter((cls) => {
    const min = Object.prototype.hasOwnProperty.call(minLevelOf, cls) ? minLevelOf[cls] : null;
    return Number.isSafeInteger(min) && level >= min;
  });
  const candidates = a.role === HUNTER_ROLE ? leveled.filter((cls) => CAPITAL_LEVEL_TIER[cls] !== SUPER_TIER)
    : leveled;
  return { owned, candidates };
}

function eligibleClassesOf(a) {
  return classesOf(a).candidates;
}

function planCapitalAttach(a) {
  const attach = a && a.attach;
  if (!attach || !Array.isArray(attach.roles) || !attach.roles.includes(a.role) || !Array.isArray(attach.order)
    || !(nat(attach.max) >= 1)) return off();
  const template = Array.isArray(a.template) ? a.template : [];
  const groups = new Set(template.map((e) => e.hullGroup));
  const classes = a.capitalClasses && typeof a.capitalClasses === "object" ? a.capitalClasses : {};
  const { owned, candidates } = classesOf(a);
  if (owned.length === 0) return off();
  if (candidates.length === 0) {
    return { entries: [], items: [], fitIsk: 0, note: NOTE_LEVEL_GATED, eligible: false, gated: true };
  }
  const ships = template.reduce((s, e) => s + nat(e.count), 0);
  const room = Math.min(nat(attach.max), nat(attach.maxGroups) - groups.size, nat(attach.maxEntries) - template.length,
    nat(attach.maxShips) - ships);
  const result = { entries: [], items: [], fitIsk: 0, note: null, eligible: true };
  if (room <= 0) return result;
  const iskLeft = Number.isSafeInteger(a.iskLeft) ? a.iskLeft : null;
  const war = iskLeft !== null && a.war ? a.war : null;
  let sawIsk = false;
  for (const cls of candidates) {
    if (result.entries.length >= room) break;
    if (!a.lg || typeof a.lg.available !== "function" || a.lg.available(a.stationId, cls) < 1) continue;
    const fit = war ? fitIskOf([{ hullGroup: cls, count: 1 }], war.valueByGroup, war.fitPermille) : 0;
    if (iskLeft !== null && result.fitIsk + fit > iskLeft) {
      sawIsk = true;
      continue;
    }
    result.entries.push({ hullGroup: cls, typeId: classes[cls], count: 1 });
    result.items.push({ itemKey: `group:${cls}`, count: 1 });
    result.fitIsk += fit;
  }
  result.items.sort(byItemKey);
  if (result.entries.length === 0) result.note = sawIsk ? NOTE_SKIPPED_ISK : NOTE_NOT_AT_STATION;
  return result;
}

module.exports = { CAPITAL_ATTACH_ROLES_ALLOWED, CAPITAL_LEVEL_TIER, parseCapitalClassList, planCapitalAttach,
  eligibleClassesOf, byItemKey };
