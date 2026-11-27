"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { streamLines, readSdeHeader } = require("../strength/sdeReader");

const FILES = Object.freeze(["_sde.jsonl", "factions.jsonl", "npcCorporations.jsonl", "npcStations.jsonl",
  "mapSolarSystems.jsonl", "mapConstellations.jsonl", "mapRegions.jsonl", "mapStargates.jsonl"]);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nameOf = (v) => (v && typeof v === "object" ? String(v.en === undefined ? "" : v.en) : String(v || ""));

function parseRow(file, lineNo, line) {
  const row = JSON.parse(line);
  if (!row || row._key === undefined || row._key === null) throw new Error(`${file}:${lineNo}: row without _key`);
  return row;
}

async function eachRow(sdeDir, name, onRow, { stream = false } = {}) {
  const file = path.join(sdeDir, name);
  let lineNo = 0;
  const onLine = (line) => {
    lineNo += 1;
    if (line.trim() === "") return;
    onRow(parseRow(file, lineNo, line));
  };
  if (stream) await streamLines(file, onLine);
  else for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) onLine(line);
}

async function readFactionInputs(sdeDir) {
  const missing = FILES.filter((name) => !fs.existsSync(path.join(sdeDir, name)));
  if (missing.length > 0) throw new Error(`${sdeDir}: missing SDE files ${missing.join(", ")}`);
  const sde = readSdeHeader(sdeDir);
  const out = { sde, factions: [], corporations: [], stations: [], systems: [], constellations: [], regions: [],
    gates: [], deletedCorporations: 0 };
  await eachRow(sdeDir, "factions.jsonl", (r) => out.factions.push({ factionId: Number(r._key), name: nameOf(r.name),
    corporationId: num(r.corporationID), militiaCorporationId: num(r.militiaCorporationID),
    hqSystemId: num(r.solarSystemID) }));
  await eachRow(sdeDir, "npcCorporations.jsonl", (r) => {
    if (r.deleted === true) {
      out.deletedCorporations += 1;
      return;
    }
    out.corporations.push({ corporationId: Number(r._key), factionId: num(r.factionID), name: nameOf(r.name),
      ticker: String(r.tickerName || ""), ceoId: num(r.ceoID) });
  });
  await eachRow(sdeDir, "npcStations.jsonl", (r) => out.stations.push({ stationId: Number(r._key),
    systemId: num(r.solarSystemID), ownerId: num(r.ownerID) }), { stream: true });
  await eachRow(sdeDir, "mapSolarSystems.jsonl", (r) => out.systems.push({ systemId: Number(r._key),
    regionId: num(r.regionID), constellationId: num(r.constellationID), securityStatus: num(r.securityStatus),
    factionId: num(r.factionID) }), { stream: true });
  await eachRow(sdeDir, "mapConstellations.jsonl", (r) => out.constellations.push({ constellationId: Number(r._key),
    factionId: num(r.factionID) }));
  await eachRow(sdeDir, "mapRegions.jsonl", (r) => out.regions.push({ regionId: Number(r._key),
    factionId: num(r.factionID) }));
  await eachRow(sdeDir, "mapStargates.jsonl", (r) => out.gates.push({ fromSystemId: num(r.solarSystemID),
    toSystemId: num(r.destination && r.destination.solarSystemID) }), { stream: true });
  return out;
}

module.exports = { readFactionInputs, FILES };
