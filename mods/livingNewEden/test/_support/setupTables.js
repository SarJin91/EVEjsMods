"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SETUP_DIR = path.join(REPO_ROOT, "tools", "DatabaseCreator");
const ENTRYPOINT = path.join(REPO_ROOT, "docker", "entrypoint.sh");
const BUILDERS = Object.freeze({
  npc: path.join(SETUP_DIR, "build-npc-tables.js"),
  encounters: path.join(SETUP_DIR, "build-npc-encounters.js"),
  capitals: path.join(SETUP_DIR, "build-capital-npc-authority.js"),
});

let cached = null;

function sdeBuildOf() {
  if (!fs.existsSync(ENTRYPOINT)) return null;
  const m = /SDE_BUILD="(\d+)"/.exec(fs.readFileSync(ENTRYPOINT, "utf8"));
  return m ? Number(m[1]) : null;
}

function sdeDirOf(build) {
  return path.join(REPO_ROOT, "_local", "sde", `eve-online-static-data-${build}-jsonl`);
}

function rowsOf(dir, file) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t));
  }
  return out;
}

function localName(value, fallback = "") {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.en || Object.values(value)[0] || fallback;
  return fallback;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function loadAuthority(dir) {
  const meta = rowsOf(dir, "_sde.jsonl").find((r) => r._key === "sde") || {};
  const categories = new Map(rowsOf(dir, "categories.jsonl").map((r) => [toInt(r._key), r]));
  const groups = new Map(rowsOf(dir, "groups.jsonl").map((r) => [toInt(r._key), r]));
  const typeByID = new Map();
  for (const raw of rowsOf(dir, "types.jsonl")) {
    const group = groups.get(toInt(raw.groupID));
    const category = group ? categories.get(toInt(group.categoryID)) : null;
    const groupID = toInt(raw.groupID);
    typeByID.set(toInt(raw._key), { typeID: toInt(raw._key), groupID,
      categoryID: groupID === 0 ? null : toInt(group && group.categoryID), groupName: localName(group && group.name),
      categoryName: localName(category && category.name), name: localName(raw.name, `Type ${raw._key}`),
      raceID: raw.raceID == null ? null : toInt(raw.raceID, 0), graphicID: toInt(raw.graphicID, 0) || null,
      radius: Number(raw.radius) || 0, volume: Number(raw.volume) || 0, capacity: Number(raw.capacity) || 0,
      published: raw.published === true });
  }
  const dogmaAttributes = Object.fromEntries(rowsOf(dir, "dogmaAttributes.jsonl").map((r) => [String(r._key), r]));
  const dogmaByTypeID = new Map(rowsOf(dir, "typeDogma.jsonl").map((r) => [String(r._key), r]));
  const corporationsByID = new Map(rowsOf(dir, "npcCorporations.jsonl")
    .map((r) => [toInt(r._key), { corporationID: toInt(r._key), factionID: toInt(r.factionID, 0) || 0 }]));
  const factions = rowsOf(dir, "factions.jsonl");
  const solarSystems = rowsOf(dir, "mapSolarSystems.jsonl").map((r) => ({ solarSystemID: toInt(r._key) }));
  return { sdeMeta: { buildNumber: meta.buildNumber, releaseDate: meta.releaseDate }, typeByID, dogmaByTypeID,
    dogmaAttributes, corporationsByID, factions, solarSystems };
}

function buildAll() {
  const build = sdeBuildOf();
  if (build === null) return { ok: false, reason: "docker/entrypoint.sh SDE_BUILD not found" };
  for (const [name, file] of Object.entries(BUILDERS)) {
    if (!fs.existsSync(file)) return { ok: false, reason: `setup builder ${name} not found (${file})` };
  }
  const dir = sdeDirOf(build);
  if (!fs.existsSync(path.join(dir, "types.jsonl"))) {
    return { ok: false, reason: `the NPC tables are generated at setup from the SDE; local SDE ${build} not found `
      + `(_local/sde/eve-online-static-data-${build}-jsonl)` };
  }
  const authority = loadAuthority(dir);
  const { buildNpcTables } = require(BUILDERS.npc);
  const { buildNpcEncounters } = require(BUILDERS.encounters);
  const { buildCapitalNpcAuthority } = require(BUILDERS.capitals);
  const npcTables = buildNpcTables(authority);
  const tables = { ...npcTables, ...buildNpcEncounters(authority, npcTables),
    capitalNpcAuthority: buildCapitalNpcAuthority(authority, "1970-01-01T00:00:00.000Z") };
  return { ok: true, build, tables };
}

function npcSetupTables() {
  if (cached === null) {
    try {
      cached = buildAll();
    } catch (err) {
      cached = { ok: false, reason: `setup builders failed: ${(err && err.message) || err}` };
    }
  }
  return cached;
}

module.exports = { REPO_ROOT, SETUP_DIR, npcSetupTables };
