"use strict";

const PATH = "services/corporation/corporationState";
const MAX_IDS = 32;
const MAX_NAME = 64;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function cleanName(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return text === "" ? null : text;
}

function namesOf(vendor, fnName, field, ids) {
  const out = new Map();
  const fn = vendor && typeof vendor[fnName] === "function" ? vendor[fnName] : null;
  for (const id of ids) {
    let name = null;
    if (fn !== null) {
      try {
        const record = fn.call(vendor, id);
        name = record && typeof record === "object" ? cleanName(record[field]) : null;
      } catch (_err) {
        name = null;
      }
    }
    out.set(id, name);
  }
  return out;
}

function readPlayerOrgNamesFrom(vendor, spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  const allianceIds = s.allianceIds === undefined ? [] : s.allianceIds;
  const corpIds = s.corpIds === undefined ? [] : s.corpIds;
  for (const [name, ids] of [["allianceIds", allianceIds], ["corpIds", corpIds]]) {
    if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every(isId)) {
      return { ok: false, reason: "INVALID_INPUT", detail: name };
    }
  }
  return { ok: true, alliances: namesOf(vendor, "getAllianceRecord", "allianceName", [...new Set(allianceIds)]),
    corps: namesOf(vendor, "getCorporationRecord", "corporationName", [...new Set(corpIds)]) };
}

function createPlayerOrgNames(deps) {
  let vendor;
  function load() {
    let off = null;
    try {
      off = typeof deps.disabledReason === "function" ? deps.disabledReason() : null;
    } catch (_err) {
      off = "DISABLED_REASON_FAILED";
    }
    if (off !== null && off !== undefined) return null;
    if (vendor !== undefined && vendor !== null) return vendor;
    try {
      const loaded = deps.requireGame(PATH);
      vendor = loaded && loaded.ok === true && loaded.exports ? loaded.exports : null;
    } catch (_err) {
      vendor = null;
    }
    return vendor;
  }
  return Object.freeze({ read: (spec) => readPlayerOrgNamesFrom(load(), spec) });
}

const MAX_CHARACTER_IDS = 64;

function readCharacterNamesFrom(characterState, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_CHARACTER_IDS || !ids.every(isId)) {
    return { ok: false, reason: "INVALID_INPUT", detail: "ids" };
  }
  return { ok: true, names: namesOf(characterState, "peekCharacterRecord", "characterName", [...new Set(ids)]) };
}

module.exports = { readPlayerOrgNamesFrom, createPlayerOrgNames, readCharacterNamesFrom, MAX_IDS, MAX_NAME,
  MAX_CHARACTER_IDS };
