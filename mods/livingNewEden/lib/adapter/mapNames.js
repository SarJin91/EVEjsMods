"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAP_NAMES_FILE = path.join(__dirname, "..", "..", "data", "mapNames.json");
const FACTION_LABEL_OVERRIDES = Object.freeze({ 500021: "Sleepers" });
const MAX_PARSE_DETAIL_LENGTH = 120;

function messageOf(err) {
  return String((err && (err.code || err.message)) || err);
}

function toNameMap(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const out = new Map();
  for (const [key, value] of Object.entries(object)) {
    const id = Number(key);
    if (Number.isSafeInteger(id) && id > 0 && typeof value === "string" && value.trim() !== "") out.set(id, value);
  }
  return out;
}

function loadMapNames(opts = {}) {
  const filePath = opts.filePath || MAP_NAMES_FILE;
  const readFileSync = typeof opts.readFileSync === "function" ? opts.readFileSync : fs.readFileSync;
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, reason: "MAP_NAMES_UNREADABLE", detail: messageOf(err) };
  }
  let payload;
  try {
    payload = JSON.parse(String(text));
  } catch (err) {
    return { ok: false, reason: "MAP_NAMES_INVALID", detail: messageOf(err).slice(0, MAX_PARSE_DETAIL_LENGTH) };
  }
  const regions = toNameMap(payload && payload.regions);
  const constellations = toNameMap(payload && payload.constellations);
  if (regions === null || constellations === null || regions.size + constellations.size === 0) {
    return { ok: false, reason: "MAP_NAMES_INVALID", detail: "regions/constellations" };
  }
  const factions = toNameMap(payload.factions) || new Map();
  for (const [key, label] of Object.entries(FACTION_LABEL_OVERRIDES)) factions.set(Number(key), label);
  return { ok: true, source: String(payload.source || "unknown"), regions, constellations, factions };
}

module.exports = { MAP_NAMES_FILE, FACTION_LABEL_OVERRIDES, loadMapNames };
