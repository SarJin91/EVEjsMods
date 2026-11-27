"use strict";

const { SYSTEM_ID_SPACES } = require("../../lib/adapter/staticMapData");

const NPC_SOV_DATA_VERSION = 1;

const toInt = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
};

function serialize(sde, rows) {
  const out = [];
  out.push("\"use strict\";");
  out.push("");
  out.push(`const NPC_SOV_DATA_VERSION = ${NPC_SOV_DATA_VERSION};`);
  out.push(`const NPC_SOV_SDE_BUILD = ${Number(sde.buildNumber)};`);
  out.push("");
  out.push("const NPC_SOV_SYSTEMS = Object.freeze([");
  for (const r of rows) out.push(`  Object.freeze([${r[0]}, ${r[1]}, ${r[2]}]),`);
  out.push("]);");
  out.push("");
  out.push("module.exports = { NPC_SOV_DATA_VERSION, NPC_SOV_SDE_BUILD, NPC_SOV_SYSTEMS };");
  out.push("");
  return out.join("\n");
}

function buildNpcSovCatalog(inputs) {
  if (!inputs || !inputs.sde || !Number.isSafeInteger(Number(inputs.sde.buildNumber))
    || !Array.isArray(inputs.systems) || !Array.isArray(inputs.constellations) || !Array.isArray(inputs.regions)) {
    return { ok: false, reason: "INVALID_INPUT", detail: "sde, systems, constellations and regions are required" };
  }
  const constellations = new Map(inputs.constellations.map((c) => [toInt(c.constellationId, 0), c]));
  const regions = new Map(inputs.regions.map((r) => [toInt(r.regionId, 0), r]));
  const known = SYSTEM_ID_SPACES.known;
  const rows = [];
  const byFaction = new Map();
  for (const s of inputs.systems) {
    const systemId = toInt(s.systemId, 0);
    if (systemId < known.min || systemId > known.max) continue;
    const security = Number(s.securityStatus);
    if (!Number.isFinite(security) || security > 0) continue;
    const regionId = toInt(s.regionId, 0);
    const constellation = constellations.get(toInt(s.constellationId, 0)) || {};
    const region = regions.get(regionId) || {};
    const factionId = toInt(s.factionId, toInt(constellation.factionId, toInt(region.factionId, 0)));
    if (!(factionId > 0)) continue;
    rows.push([systemId, factionId, regionId]);
    byFaction.set(factionId, (byFaction.get(factionId) || 0) + 1);
  }
  rows.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i][0] === rows[i - 1][0]) {
      return { ok: false, reason: "INVALID_INPUT", detail: `duplicate systemId ${rows[i][0]}` };
    }
  }
  return { ok: true, rows, byFaction, source: serialize(inputs.sde, rows) };
}

module.exports = { buildNpcSovCatalog, NPC_SOV_DATA_VERSION };
