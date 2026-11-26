"use strict";

const { HULL_GROUPS } = require("../fleets/schema");
const { STRENGTH_ALIASES } = require("./data/strengthAliases");
const { CAPITAL_STRENGTH_ROWS } = require("./data/capitalStrengthRows");

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const CATALOG_VERSION = 1;
const STRENGTH_FIELDS = Object.freeze(["dps", "alpha", "ehp", "repPerSec", "remoteRepPerSec", "applicationFactor",
  "ewarFactor", "tackleFactor", "speedClass", "signatureRadius", "maxVelocity", "designSig"]);
const GROUP_POSITIVE = new Set(["dps", "alpha", "ehp", "repPerSec", "applicationFactor", "speedClass",
  "signatureRadius", "maxVelocity", "designSig"]);
const TYPE_POSITIVE = new Set(["ehp", "speedClass", "signatureRadius", "maxVelocity", "designSig"]);
const FACTORS = new Set(["applicationFactor", "ewarFactor", "tackleFactor"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(detail) {
  return { ok: false, reason: "STRENGTH_CATALOG_INVALID", detail };
}

function checkRow(row, where, positive, maxSpeedClass) {
  if (!isObject(row)) return { error: `${where} is not an object` };
  const out = {};
  for (const field of STRENGTH_FIELDS) {
    const value = row[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${where}.${field} not a finite number` };
    if (positive.has(field) ? !(value > 0) : value < 0) return { error: `${where}.${field}=${value} out of range` };
    if (FACTORS.has(field) && value > 1) return { error: `${where}.${field}=${value} above 1` };
    if (field === "speedClass" && (!Number.isInteger(value) || value > maxSpeedClass)) {
      return { error: `${where}.speedClass=${value} not an integer 1..${maxSpeedClass}` };
    }
    out[field] = value;
  }
  return { row: Object.freeze(out) };
}

function checkParams(params) {
  if (!isObject(params)) return "params must be {groupConfidence, unknownTypeConfidence}";
  const { groupConfidence: g, unknownTypeConfidence: u } = params;
  for (const [name, value] of [["groupConfidence", g], ["unknownTypeConfidence", u]]) {
    if (typeof value !== "number" || !(value > 0 && value <= 1)) return `${name}=${value} not in (0, 1]`;
  }
  if (u > g) return `unknownTypeConfidence=${u} above groupConfidence=${g}`;
  return null;
}

function createStrengthCatalog(data, params, aliases) {
  const paramError = checkParams(params);
  if (paramError) return { ok: false, reason: "STRENGTH_PARAMS_INVALID", detail: paramError };
  const source = data === undefined || data === null ? require("./data/strengthCatalog") : data;
  if (!isObject(source) || !isObject(source.HEADER) || !isObject(source.GROUPS) || !isObject(source.TYPES)) {
    return invalid("data needs HEADER, GROUPS, TYPES");
  }
  const aliasMap = aliases === undefined || aliases === null ? STRENGTH_ALIASES : aliases;
  if (!isObject(aliasMap)) return invalid("aliases must be an object");
  const { HEADER, GROUPS, TYPES } = source;
  if (HEADER.catalogVersion !== CATALOG_VERSION) return invalid(`catalogVersion ${HEADER.catalogVersion}`);
  if (!Array.isArray(HEADER.speedClassBounds)) return invalid("HEADER.speedClassBounds missing");
  const maxSpeedClass = HEADER.speedClassBounds.length + 1;
  const names = Object.keys(GROUPS);
  for (const key of Object.keys(aliasMap)) {
    if (names.includes(key)) return invalid(`alias ${key} is also a catalogue group`);
    if (typeof aliasMap[key] !== "string" || !names.includes(aliasMap[key])) {
      return invalid(`alias ${key} -> ${aliasMap[key]} is not a catalogue group`);
    }
  }
  const covered = [...names, ...Object.keys(aliasMap)];
  const missing = HULL_GROUPS.filter((name) => !covered.includes(name));
  const extra = covered.filter((name) => !HULL_GROUPS.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    return invalid(`GROUPS + aliases must be HULL_GROUPS (missing ${missing.join(",") || "-"}, extra `
      + `${extra.join(",") || "-"})`);
  }

  const groupResults = new Map();
  for (const name of names) {
    const checked = checkRow(GROUPS[name], `GROUPS.${name}`, GROUP_POSITIVE, maxSpeedClass);
    if (checked.error) return invalid(checked.error);
    const result = (confidence, note) => Object.freeze({ ok: true, strength: checked.row, source: "group",
      confidence, note });
    groupResults.set(name, Object.freeze({
      plain: result(params.groupConfidence, null),
      unknown: result(params.unknownTypeConfidence, "UNKNOWN_TYPE"),
      mismatch: result(params.unknownTypeConfidence, "TYPE_GROUP_MISMATCH"),
    }));
  }

  const typeResults = new Map();
  for (const key of Object.keys(TYPES)) {
    const row = TYPES[key];
    if (!isObject(row) || row.typeId !== Number(key) || !Number.isSafeInteger(row.typeId)) {
      return invalid(`TYPES.${key}.typeId does not match its key`);
    }
    if (!names.includes(row.hullGroup)) return invalid(`TYPES.${key}.hullGroup ${row.hullGroup}`);
    const checked = checkRow(row, `TYPES.${key}`, TYPE_POSITIVE, maxSpeedClass);
    if (checked.error) return invalid(checked.error);
    typeResults.set(row.typeId, { hullGroup: row.hullGroup,
      result: Object.freeze({ ok: true, strength: checked.row, source: "type", confidence: 1, note: null }) });
  }

  const resolved = Object.freeze({ ...Object.fromEntries(names.map((name) => [name, name])), ...aliasMap });

  function lookup(hullGroup, typeId) {
    const target = typeof hullGroup === "string" && hasOwn(resolved, hullGroup) ? resolved[hullGroup] : undefined;
    const group = target === undefined ? undefined : groupResults.get(target);
    if (!group) {
      return Object.freeze({ ok: false, reason: "UNKNOWN_HULL_GROUP",
        hullGroup: typeof hullGroup === "string" ? hullGroup : null });
    }
    if (typeId === null || typeId === undefined) return group.plain;
    const type = typeResults.get(typeId);
    if (!type) return group.unknown;
    return type.hullGroup === target ? type.result : group.mismatch;
  }

  return { ok: true, catalog: Object.freeze({ header: HEADER, lookup }) };
}

function expandStrengthGroups(groups, aliases, overlay) {
  const aliasMap = aliases === undefined || aliases === null ? STRENGTH_ALIASES : aliases;
  const rows = overlay === undefined || overlay === null ? CAPITAL_STRENGTH_ROWS : overlay;
  const out = { ...groups };
  for (const key of Object.keys(aliasMap)) {
    if (!hasOwn(groups, key) && hasOwn(groups, aliasMap[key])) out[key] = groups[aliasMap[key]];
  }
  for (const key of Object.keys(rows)) {
    const row = rows[key];
    if (hasOwn(groups, key)) {
      const permille = row && row.powerPermille;
      if (Number.isSafeInteger(permille) && permille >= 1) {
        out[key] = Object.freeze({ ...groups[key], powerPermille: permille });
      }
    } else if (row && typeof row.dps === "number") {
      out[key] = row;
    }
  }
  return Object.freeze(out);
}

module.exports = { createStrengthCatalog, expandStrengthGroups, STRENGTH_FIELDS };
