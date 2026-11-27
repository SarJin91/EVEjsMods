"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const SHIP_CATEGORY_ID = 6;
const CLUSTER_MIN_SYSTEMS = 15;
const CLUSTER_MAX_SYSTEMS = 40;
const KNOWN_SPACE_MAX_ID = 30999999;

function readJsonl(file) {
  const rows = [];
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

async function streamJsonl(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    n += 1;
    if (onRow) onRow(JSON.parse(line));
  }
  return n;
}

function en(name) {
  if (typeof name === "string") return name;
  return (name && (name.en || Object.values(name)[0])) || "";
}

function toInt(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fb;
}

function rowsOf(file, key) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = data[key];
  return Array.isArray(rows) ? rows : Object.values(rows || {});
}

function summarizeKeys(rows) {
  const keys = new Set();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) keys.add(k);
  return [...keys];
}

function securityClass(security) {
  let s = Math.min(1, Math.max(0, Number(security) || 0));
  if (s > 0 && s < 0.05) s = 0.05;
  if (s <= 0) return 0;
  if (s < 0.45) return 1;
  return 2;
}

async function inspectSources(sdeDir, staticDir) {
  const out = {};
  const regions = new Map(readJsonl(path.join(sdeDir, "mapRegions.jsonl")).map((r) => [toInt(r._key), r]));
  const consts = new Map(readJsonl(path.join(sdeDir, "mapConstellations.jsonl")).map((r) => [toInt(r._key), r]));
  const rawSystems = readJsonl(path.join(sdeDir, "mapSolarSystems.jsonl"));
  const rawGates = readJsonl(path.join(sdeDir, "mapStargates.jsonl"));
  const factions = new Map(readJsonl(path.join(sdeDir, "factions.jsonl")).map((r) => [toInt(r._key), r]));
  const stations = readJsonl(path.join(sdeDir, "npcStations.jsonl"));

  const systems = rawSystems.map((raw) => {
    const c = consts.get(toInt(raw.constellationID)) || {};
    const r = regions.get(toInt(raw.regionID)) || {};
    return {
      regionID: toInt(raw.regionID),
      constellationID: toInt(raw.constellationID),
      solarSystemID: toInt(raw._key),
      solarSystemName: en(raw.name),
      security: Number(raw.securityStatus) || 0,
      factionID: toInt(raw.factionID, toInt(c.factionID, toInt(r.factionID, 0))),
      securityClass: raw.securityClass || "",
      _wormholeClassID: toInt(c.wormholeClassID, toInt(r.wormholeClassID, 0)),
      _factionSource: raw.factionID ? "system" : c.factionID ? "constellation" : r.factionID ? "region" : "none",
    };
  });
  const sysByID = new Map(systems.map((s) => [s.solarSystemID, s]));

  out.counts = {
    solarSystems: systems.length,
    knownSpace: systems.filter((s) => s.solarSystemID <= KNOWN_SPACE_MAX_ID).length,
    wormholeSpace: systems.filter((s) => s.solarSystemID >= 31000000 && s.solarSystemID <= 31999999).length,
    regions: regions.size,
    constellations: consts.size,
    stargates: rawGates.length,
    undirectedGateLinks: new Set(rawGates.map((g) => {
      const a = toInt(g.solarSystemID); const b = toInt(g.destination && g.destination.solarSystemID);
      return a < b ? `${a}-${b}` : `${b}-${a}`;
    })).size,
    factions: factions.size,
    npcStations: stations.length,
    bySecurityClassKnownSpace: [0, 1, 2].map((k) => systems.filter(
      (s) => s.solarSystemID <= KNOWN_SPACE_MAX_ID && securityClass(s.security) === k).length),
    factionSource: ["system", "constellation", "region", "none"].map((k) => [k,
      systems.filter((s) => s._factionSource === k).length]),
  };
  out.samples = {
    solarSystem: systems.find((s) => s.solarSystemID === 30000142),
    stargate: rawGates[0],
    faction: (() => { const f = factions.get(500010); return f && { _key: f._key, name: en(f.name),
      corporationID: f.corporationID, militiaCorporationID: f.militiaCorporationID, solarSystemID: f.solarSystemID }; })(),
  };

  const groupCategory = new Map();
  await streamJsonl(path.join(sdeDir, "groups.jsonl"), (g) => groupCategory.set(toInt(g._key), toInt(g.categoryID)));
  let shipTypes = 0;
  let shipTypesPublished = 0;
  let types = 0;
  await streamJsonl(path.join(sdeDir, "types.jsonl"), (t) => {
    types += 1;
    if (groupCategory.get(toInt(t.groupID)) === SHIP_CATEGORY_ID) {
      shipTypes += 1;
      if (t.published === true) shipTypesPublished += 1;
    }
  });
  out.counts.types = types;
  out.counts.shipTypes = shipTypes;
  out.counts.shipTypesPublished = shipTypesPublished;
  out.counts.typeDogmaRows = await streamJsonl(path.join(sdeDir, "typeDogma.jsonl"));

  const npc = {};
  for (const [table, key] of [["npcProfiles", "profiles"], ["npcSpawnGroups", "spawnGroups"],
    ["npcLoadouts", "loadouts"], ["npcSpawnPools", "spawnPools"], ["npcStartupRules", "startupRules"],
    ["npcBehaviorProfiles", "behaviorProfiles"], ["npcLootTables", "lootTables"]]) {
    const file = path.join(staticDir, table, "data.json");
    if (!fs.existsSync(file)) { npc[table] = { missing: true }; continue; }
    const rows = rowsOf(file, key);
    npc[table] = { rowKey: key, count: rows.length, fields: summarizeKeys(rows) };
  }
  const profiles = rowsOf(path.join(staticDir, "npcProfiles", "data.json"), "profiles");
  const byFaction = {};
  for (const p of profiles) byFaction[p.factionID || 0] = (byFaction[p.factionID || 0] || 0) + 1;
  npc.npcProfilesByFactionID = byFaction;
  out.npcStatic = npc;

  const stationsBySystem = new Map();
  for (const st of stations) stationsBySystem.set(toInt(st.solarSystemID), (stationsBySystem.get(toInt(st.solarSystemID)) || 0) + 1);
  const adj = new Map();
  for (const g of rawGates) {
    const a = toInt(g.solarSystemID); const b = toInt(g.destination && g.destination.solarSystemID);
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }
  const isNpcNull = (s) => s && s.solarSystemID <= KNOWN_SPACE_MAX_ID && securityClass(s.security) === 0 && s.factionID > 0;
  const regionStats = new Map();
  for (const s of systems) {
    if (s.solarSystemID > KNOWN_SPACE_MAX_ID || securityClass(s.security) !== 0) continue;
    const r = regionStats.get(s.regionID) || { regionID: s.regionID, regionName: en((regions.get(s.regionID) || {}).name),
      nullSystems: 0, npcNullSystems: 0, factions: {}, npcStations: 0, constellations: new Map() };
    r.nullSystems += 1;
    if (isNpcNull(s)) {
      r.npcNullSystems += 1;
      r.factions[s.factionID] = (r.factions[s.factionID] || 0) + 1;
      r.npcStations += stationsBySystem.get(s.solarSystemID) || 0;
      const c = r.constellations.get(s.constellationID) || { constellationID: s.constellationID,
        name: en((consts.get(s.constellationID) || {}).name), systems: [], stations: 0, factionID: s.factionID };
      c.systems.push(s.solarSystemID);
      c.stations += stationsBySystem.get(s.solarSystemID) || 0;
      r.constellations.set(s.constellationID, c);
    }
    regionStats.set(s.regionID, r);
  }
  const npcRegions = [...regionStats.values()].filter((r) => r.npcNullSystems > 0)
    .sort((a, b) => b.npcNullSystems - a.npcNullSystems);
  out.d5 = npcRegions.map((r) => {
    const constList = [...r.constellations.values()];
    const constOf = new Map();
    for (const c of constList) for (const id of c.systems) constOf.set(id, c.constellationID);
    const cAdj = new Map(constList.map((c) => [c.constellationID, new Set()]));
    let borderToPlayerNull = 0;
    let borderToLowHigh = 0;
    for (const c of constList) {
      for (const id of c.systems) {
        for (const n of adj.get(id) || []) {
          const ns = sysByID.get(n);
          if (constOf.has(n) && constOf.get(n) !== c.constellationID) cAdj.get(c.constellationID).add(constOf.get(n));
          if (!constOf.has(n) && ns && securityClass(ns.security) === 0 && !isNpcNull(ns)) borderToPlayerNull += 1;
          if (!constOf.has(n) && ns && securityClass(ns.security) > 0) borderToLowHigh += 1;
        }
      }
    }
    const clusters = [];
    const seen = new Set();
    const sizeOf = (ids) => ids.reduce((sum, id) => sum + r.constellations.get(id).systems.length, 0);
    for (const c of constList) {
      const tryAdd = (ids) => {
        const key = [...ids].sort((a, b) => a - b).join(",");
        if (seen.has(key)) return;
        seen.add(key);
        const n = sizeOf(ids);
        if (n >= CLUSTER_MIN_SYSTEMS && n <= CLUSTER_MAX_SYSTEMS) {
          clusters.push({ constellationIDs: [...ids].sort((a, b) => a - b), systems: n,
            stations: ids.reduce((sum, id) => sum + r.constellations.get(id).stations, 0) });
        }
      };
      tryAdd([c.constellationID]);
      for (const n1 of cAdj.get(c.constellationID)) {
        tryAdd([c.constellationID, n1]);
        for (const n2 of new Set([...cAdj.get(c.constellationID), ...cAdj.get(n1)])) {
          if (n2 !== c.constellationID && n2 !== n1) tryAdd([c.constellationID, n1, n2]);
        }
      }
    }
    clusters.sort((a, b) => b.stations - a.stations || a.systems - b.systems);
    return {
      regionID: r.regionID,
      regionName: r.regionName,
      nullSystems: r.nullSystems,
      npcNullSystems: r.npcNullSystems,
      factions: Object.fromEntries(Object.entries(r.factions).map(([id, n]) => [`${id} ${en((factions.get(+id) || {}).name)}`, n])),
      npcStations: r.npcStations,
      gateLinksToPlayerNull: borderToPlayerNull,
      gateLinksToLowHigh: borderToLowHigh,
      constellations: constList.map((c) => ({ id: c.constellationID, name: c.name, systems: c.systems.length,
        stations: c.stations, adjacent: [...cAdj.get(c.constellationID)] })),
      clusterCandidates: clusters.slice(0, 5),
    };
  });
  return out;
}

function inspectBuilt(dataDir) {
  const out = {};
  for (const [table, key] of [["solarSystems", "solarSystems"], ["stargates", "stargates"], ["stations", "stations"],
    ["shipTypes", "ships"], ["factions", "records"], ["npcProfiles", "profiles"], ["npcSpawnGroups", "spawnGroups"],
    ["npcLoadouts", "loadouts"], ["explorationWormholeStatic", "systems"]]) {
    const file = path.join(dataDir, table, "data.json");
    if (!fs.existsSync(file)) { out[table] = { missing: file }; continue; }
    const rows = rowsOf(file, key);
    out[table] = { count: rows.length, fields: summarizeKeys(rows), sample: rows[0] };
  }
  const typeDogma = path.join(dataDir, "typeDogma", "data.json");
  out.typeDogma = fs.existsSync(typeDogma) ? { bytes: fs.statSync(typeDogma).size } : { missing: typeDogma };
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--built") {
    console.log(JSON.stringify(inspectBuilt(path.resolve(args[1])), null, 2));
    return;
  }
  if (args.length < 2) {
    console.error("usage: inspectStaticData.js <sdeDir> <staticTablesDir> | --built <gameStoreDataDir>");
    process.exitCode = 2;
    return;
  }
  const out = await inspectSources(path.resolve(args[0]), path.resolve(args[1]));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || String(error));
  process.exitCode = 1;
});
