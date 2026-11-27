"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { expansionCandidates, isExpansionTarget } = require("../../lib/strategy/ai/expansion");
const { CAMPAIGNS_V1 } = require("../../lib/strategy/data/campaigns");
const { createHostility } = require("../../lib/battle/data/hostility");
const { HULL_ITEM_KIND } = require("../../lib/stations/stockKeys");
const { buildSdeWorld, loadSecurityBand } = require("./sdeWorld");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_SDE_DIR = path.resolve(MOD_DIR, "..", "..", "_local", "sde", "eve-online-static-data-3396210-jsonl");
const DEFAULT_FACTION = 500019;
const UNLIMITED = 1000000;

function parseArgs(argv) {
  const opts = { db: null, sde: DEFAULT_SDE_DIR, faction: DEFAULT_FACTION, jumps: null, md: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === "--db") opts.db = next();
    else if (a === "--sde") opts.sde = next();
    else if (a === "--faction") opts.faction = Number(next());
    else if (a === "--jumps") opts.jumps = Number(next());
    else if (a === "--md") opts.md = next();
    else if (a === "--json") opts.json = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.db) throw new Error("--db is required");
  if (!Number.isSafeInteger(opts.faction) || opts.faction <= 0) throw new Error("--faction needs an id");
  if (opts.jumps !== null && (!Number.isSafeInteger(opts.jumps) || opts.jumps < 0)) throw new Error("--jumps needs n >= 0");
  return opts;
}

function classify(input) {
  const { faction, reach, rows, active, getSystem, theatre, expansion, expansionAll } = input;
  const isHostile = input.isHostile || (() => false);
  const liveBySystem = input.liveBySystem || new Map();
  const inList = new Set(expansion);
  const rankAll = new Map(expansionAll.map((id, i) => [id, i + 1]));
  const counts = { reached: reach.size, free: 0, own: 0, active: 0, passive: 0 };
  const raid = { hostileActive: 0, hostilePassive: 0, withHostileStation: 0 };
  const hostile = [];
  for (const [id, jumps] of [...reach].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const row = rows.get(id) || null;
    const c = row ? row.controller : null;
    const cat = c === null ? "free" : c === faction ? "own" : active.has(c) ? "active" : "passive";
    counts[cat] += 1;
    if (cat !== "active" && cat !== "passive") continue;
    const v = getSystem(id);
    const hostileController = isHostile(faction, c) === true;
    const hostileLiveStations = (liveBySystem.get(id) || []).filter((x) => isHostile(faction, x.factionId) === true)
      .reduce((s, x) => s + x.count, 0);
    const expansionTarget = isExpansionTarget(v);
    if (hostileController && expansionTarget && !theatre.has(id)) {
      raid[cat === "active" ? "hostileActive" : "hostilePassive"] += 1;
      if (hostileLiveStations > 0) raid.withHostileStation += 1;
    }
    hostile.push({ systemId: id, name: v ? v.name : null, jumps, controller: c, category: cat,
      hostile: hostileController, hostileLiveStations, secClass: v ? v.secClass : null,
      expansionTarget, inTheatre: theatre.has(id), occupationState: row.state,
      stable: row.state === "STABLE", occupier: row.occupier, influence: row.influence,
      expansionRank: rankAll.get(id) || null, inExpansionList: inList.has(id) });
  }
  const listCats = { free: 0, own: 0, active: 0, passive: 0 };
  for (const id of expansion) {
    const row = rows.get(id) || null;
    const c = row ? row.controller : null;
    listCats[c === null ? "free" : c === faction ? "own" : active.has(c) ? "active" : "passive"] += 1;
  }
  return { counts, raid, hostile, expansion: { size: expansion.length, sizeWithoutLimit: expansionAll.length,
    categories: listCats } };
}

function probe(opts) {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, reason: "SERVER_SRC_NOT_FOUND" };
  const driver = resolveSqliteDriver(found.srcDir);
  if (!driver || !driver.ok) return { ok: false, reason: "SQLITE_DRIVER_UNAVAILABLE" };
  const sde = buildSdeWorld(opts.sde);
  if (!sde.ok) return sde;
  const band = loadSecurityBand(found.srcDir);
  if (!band.ok) return band;
  const map = readStaticMapFrom(sde.world.worldData, band.band, {});
  if (!map.ok) return map;
  const resolved = resolveConfig({ modDir: MOD_DIR, env: {} });
  if (!resolved.ok) return { ok: false, reason: "CONFIG_INVALID" };
  const S = resolved.config.strategy;
  const jumps = opts.jumps !== null && opts.jumps !== undefined ? opts.jumps
    : Math.max(0, Math.min(S.captureRangeFromStationJumps, resolved.config.graph.routeMaxJumps));
  const systems = new Map(map.map.systems.map((v) => [v.id, v]));
  const adj = new Map();
  for (const g of map.map.gates) {
    if (!(g.fromSystemId > 0 && g.toSystemId > 0)) continue;
    if (!adj.has(g.fromSystemId)) adj.set(g.fromSystemId, new Set());
    adj.get(g.fromSystemId).add(g.toSystemId);
  }
  const neighbors = (id) => (adj.has(id) ? [...adj.get(id)].sort((a, b) => a - b) : []);
  const getSystem = (id) => systems.get(id) || null;
  const theatre = new Set(CAMPAIGNS_V1.filter((c) => c.ownerFactionId === opts.faction).flatMap((c) => c.systemIds));
  const db = new driver.Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    const anchors = db.prepare(`SELECT DISTINCT system_id AS id FROM world_stations WHERE owner_faction_id = ?
      AND state = 'ONLINE' ORDER BY 1`).all(opts.faction).map((r) => r.id);
    const liveStations = db.prepare(`SELECT count(*) AS n FROM world_stations WHERE owner_faction_id = ?
      AND state <> 'DESTROYED'`).get(opts.faction).n;
    const active = new Set(db.prepare("SELECT faction_id FROM world_factions WHERE status = 'ACTIVE'").all()
      .map((r) => r.faction_id));
    const reach = bfs(anchors, neighbors, { maxJumps: jumps, maxSystems: S.maxBfsSystems });
    const rows = new Map();
    const rowOf = db.prepare(`SELECT s.controller_faction_id AS controller, s.occupation_state AS state,
      s.occupier_faction_id AS occupier, i.influence_score AS influence FROM world_system_state s
      LEFT JOIN world_system_influence i ON i.system_id = s.system_id AND i.faction_id = ? WHERE s.system_id = ?`);
    for (const id of reach.keys()) {
      const r = rowOf.get(opts.faction, id);
      if (r) rows.set(id, { controller: r.controller, state: r.state, occupier: r.occupier, influence: r.influence });
    }
    const input = { enabled: true, stationSystems: anchors, theatre: [...theatre], neighbors, getSystem, jumps,
      maxSystems: S.maxBfsSystems };
    const expansion = expansionCandidates({ ...input, limit: S.maxExpansionSystems });
    const expansionAll = expansionCandidates({ ...input, limit: UNLIMITED });
    const liveBySystem = new Map();
    for (const r of db.prepare(`SELECT system_id AS systemId, owner_faction_id AS factionId, count(*) AS count
      FROM world_stations WHERE state <> 'DESTROYED' GROUP BY system_id, owner_faction_id ORDER BY 1, 2`).all()) {
      if (!reach.has(r.systemId)) continue;
      if (!liveBySystem.has(r.systemId)) liveBySystem.set(r.systemId, []);
      liveBySystem.get(r.systemId).push({ factionId: Number(r.factionId), count: Number(r.count) });
    }
    const hullStock = {};
    for (const r of db.prepare(`SELECT k.item_key AS itemKey, sum(k.quantity) AS quantity FROM world_station_stock k
      JOIN world_stations s ON s.station_id = k.station_id WHERE s.owner_faction_id = ? AND s.state = 'ONLINE'
      AND k.item_kind = ? GROUP BY k.item_key ORDER BY 1`).all(opts.faction, HULL_ITEM_KIND)) {
      hullStock[r.itemKey] = Number(r.quantity);
    }
    const out = classify({ faction: opts.faction, reach, rows, active, getSystem, theatre, expansion, expansionAll,
      isHostile: createHostility(), liveBySystem });
    return { ok: true, db: opts.db, faction: opts.faction, jumps, maxExpansionSystems: S.maxExpansionSystems,
      maxRaidScanSystems: S.maxRaidScanSystems, anchors, liveStations, hullStock,
      activeFactions: [...active].sort((a, b) => a - b), ...out };
  } finally {
    db.close();
  }
}

function formatMd(r) {
  const lines = [`### Probe: other factions in the range of ${r.faction}`, "",
    `- db: ${r.db}`, `- ONLINE station systems (anchors): ${r.anchors.length} (${r.anchors.join(", ")}); live stations: ${r.liveStations}`,
    `- range: ${r.jumps} jumps; reached ${r.counts.reached} systems: free ${r.counts.free}, own ${r.counts.own}, `
      + `other active ${r.counts.active}, passive ${r.counts.passive}`,
    `- expansion list (limit ${r.maxExpansionSystems}): ${r.expansion.size} (without limit ${r.expansion.sizeWithoutLimit}); `
      + `in the list: free ${r.expansion.categories.free}, own ${r.expansion.categories.own}, `
      + `other active ${r.expansion.categories.active}, passive ${r.expansion.categories.passive}`,
    `- raid-eligible (nullsec, not excluded, outside theatre, hostile controller): active ${r.raid.hostileActive}, `
      + `passive ${r.raid.hostilePassive}, with a live hostile station ${r.raid.withHostileStation}`
      + ` (maxRaidScanSystems ${r.maxRaidScanSystems})`,
    `- hull stock on ONLINE stations: ${Object.keys(r.hullStock).length === 0 ? "none"
      : Object.entries(r.hullStock).map(([k, q]) => `${k}=${q}`).join(", ")}`, ""];
  if (r.hostile.length === 0) lines.push("No system of another faction in the range.");
  else {
    lines.push("| system | name | jumps | controller | category | hostile | hostile live stations | secClass "
      + "| expansionTarget | theatre | state | occupier | influence | rank (no limit) | in list |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const h of r.hostile) {
      lines.push(`| ${h.systemId} | ${h.name || "-"} | ${h.jumps} | ${h.controller} | ${h.category} | ${h.hostile} `
        + `| ${h.hostileLiveStations} | ${h.secClass} | ${h.expansionTarget} `
        + `| ${h.inTheatre} | ${h.occupationState} | ${h.occupier === null ? "-" : h.occupier} `
        + `| ${h.influence === null ? "-" : h.influence} | ${h.expansionRank || "-"} | ${h.inExpansionList} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stdout.write(`probe: FAIL ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const r = probe(opts);
  if (!r.ok) {
    process.stdout.write(`probe: FAIL ${r.reason}${r.detail ? ` ${r.detail}` : ""}\n`);
    process.exitCode = 1;
    return;
  }
  const md = formatMd(r);
  if (opts.md) fs.writeFileSync(opts.md, md);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(r, null, 2));
  process.stdout.write(md);
}

if (require.main === module) main();

module.exports = { probe, classify, formatMd, parseArgs };
