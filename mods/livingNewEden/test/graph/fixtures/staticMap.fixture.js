"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { findServerSrcOnDisk } = require("../../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;

const SYSTEM_ROWS = [
  [30000001, 10000001, 20000001, 1.0], [30000002, 10000001, 20000001, 0.9],
  [30000003, 10000001, 20000001, 0.5], [30000004, 10000001, 20000001, 0.45],
  [30000005, 10000001, 20000002, 0.449], [30000006, 10000001, 20000002, 0.3],
  [30000007, 10000001, 20000002, 0.04],
  [30000008, 10000002, 20000003, 0.0], [30000009, 10000002, 20000003, -0.2],
  [30000010, 10000002, 20000003, -0.5], [30000011, 10000002, 20000003, 0.1],
  [30000012, 10000002, 20000004, -1.0], [30000013, 10000002, 20000004, -0.3],
  [30000014, 10000002, 20000004, 0.2],
  ...[31000001, 31000002, 31000003, 31000004, 31000005, 31000006].map((id) => [id, 11000001, 21000001, -0.99]),
];

const CHAIN = [30000001, 30000002, 30000003, 30000004, 30000005, 30000006, 30000007, 30000008, 30000009,
  30000010, 30000011, 30000012, 30000014];

const NO_POSITION_ID = 30000014;
const POSITION_STEP_M = 1e16;
function positionOf(i) {
  return { x: i * POSITION_STEP_M, y: (i % 3) * POSITION_STEP_M, z: (0 - i) * POSITION_STEP_M / 2 + 0 };
}

function rawWorld() {
  const solarSystems = SYSTEM_ROWS.map(([id, regionID, constellationID, security], i) => ({
    regionID, constellationID, solarSystemID: id, solarSystemName: `S${id}`, security, factionID: 0, radius: 1,
    ...(id === NO_POSITION_ID ? {} : { position: positionOf(i) }),
  }));
  const stargates = [];
  let itemID = 50000001;
  const gate = (from, to) => {
    stargates.push({ itemID, solarSystemID: from, destinationSolarSystemID: to, destinationID: itemID + 1 });
    itemID += 1;
  };
  for (let i = 0; i + 1 < CHAIN.length; i += 1) {
    gate(CHAIN[i], CHAIN[i + 1]);
    if (CHAIN[i] !== 30000003) gate(CHAIN[i + 1], CHAIN[i]);
  }
  gate(30000014, 30009999);
  gate(30000010, 30000010);
  const stations = [
    { stationID: 60000001, solarSystemID: 30000001, regionID: 10000001, regionName: "Alpha",
      constellationID: 20000001, constellationName: "Alpha One" },
    { stationID: 60000002, solarSystemID: 30000009, regionID: 10000002, regionName: "Beta",
      constellationID: 20000003, constellationName: "" },
    { stationID: 60000003, solarSystemID: 31000001, regionID: 11000001, regionName: "",
      constellationID: 21000001, constellationName: "" },
  ];
  return { solarSystems, stargates, stations };
}

function loadSecurityBand() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) throw new Error(`EveJS server/src not found above the mod (${found.reason})`);
  return require(path.join(found.srcDir, "space", "runtime", "systemSecurityBand.js"));
}

module.exports = { rawWorld, loadSecurityBand, NO_POSITION_ID };
