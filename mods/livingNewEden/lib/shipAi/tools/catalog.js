"use strict";

const { STANDING_FLEET_STATES } = require("../../world/occupation/schema");
const { TOOLS_DB, ITEM_HINT, ITEM_HINT_SHORT } = require("./catalogDb");

const SUGGESTIONS = 3;
const NAME_MAX_LEN = 48;
const PERCENT = 10;
const MILLI = 1000;
const SEC_DECIMALS = 10;
const PRESENT_STATES = Object.freeze([...STANDING_FLEET_STATES, "ENGAGED"]);
const HOSTILITY = Object.freeze({ HOSTILE: "hostile", NOT_HOSTILE: "not_hostile", UNKNOWN: "unknown" });

const fail = (reason, extra) => ({ ok: false, reason, ...(extra || {}) });
const pct = (permille) => (Number.isFinite(permille) ? Math.round(permille / PERCENT) : null);
const sec1 = (v) => (Number.isFinite(v) ? Math.round(v * SEC_DECIMALS) / SEC_DECIMALS : null);
const iskOf = (milli) => (Number.isFinite(milli) ? Math.round(milli / MILLI) : null);

function presenceOf(deps, playerId) {
  const res = deps.presence();
  if (!res || !res.ok || !Array.isArray(res.characters)) return null;
  return res.characters.find((r) => r && r.characterId === playerId) || null;
}

const nameIndexes = new WeakMap();
function nameIndexOf(graph) {
  let index = nameIndexes.get(graph);
  if (index) return index;
  index = new Map();
  for (const id of graph.getSystemIds()) {
    const s = graph.getSystem(id);
    if (s && s.name) index.set(s.name.toLowerCase(), id);
  }
  nameIndexes.set(graph, index);
  return index;
}

function resolveSystem(graph, query) {
  const q = String(query).trim().toLowerCase();
  const index = nameIndexOf(graph);
  if (index.has(q)) return { ok: true, id: index.get(q) };
  const starts = [];
  const contains = [];
  if (q !== "") {
    for (const [name, id] of index) {
      if (name.startsWith(q)) starts.push(id);
      else if (name.includes(q)) contains.push(id);
    }
  }
  const nameOf = (id) => graph.getSystem(id).name;
  const pick = [...starts.map(nameOf).sort(), ...contains.map(nameOf).sort()].slice(0, SUGGESTIONS);
  return fail("UNKNOWN_SYSTEM", { suggestions: pick });
}

function systemView(graph, id) {
  const s = graph.getSystem(id);
  if (!s) return null;
  return { name: s.name, security: sec1(s.security), secClass: s.secClass, region: graph.getRegionName(s.regionId) };
}

function systemsAround(graph, fromId, maxJumps) {
  const dist = new Map([[fromId, 0]]);
  let frontier = [fromId];
  for (let j = 1; j <= maxJumps && frontier.length > 0; j += 1) {
    const next = [];
    for (const id of frontier) {
      for (const n of graph.getNeighbors(id) || []) {
        if (!dist.has(n)) {
          dist.set(n, j);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

function hostilityOf(deps, playerId, factionId, pirates) {
  if (pirates && pirates.has(factionId)) return HOSTILITY.HOSTILE;
  const standing = deps.standing(playerId, factionId);
  if (standing === null) return HOSTILITY.UNKNOWN;
  return standing < 0 ? HOSTILITY.HOSTILE : HOSTILITY.NOT_HOSTILE;
}

function fleetsAround(deps, playerId, systemId, maxJumps) {
  const graph = deps.graph();
  if (!graph || !graph.hasSystem(systemId)) return fail("GRAPH_UNAVAILABLE");
  const dist = systemsAround(graph, systemId, maxJumps);
  const read = deps.fleetsIn([...dist.keys()], PRESENT_STATES);
  if (!read || !read.ok || !(read.bySystem instanceof Map)) return fail((read && read.reason) || "FLEETS_UNAVAILABLE");
  const pirates = deps.pirates();
  const entries = [];
  for (const [sysId, fleets] of read.bySystem) {
    for (const f of fleets) {
      entries.push({ factionId: f.factionId, role: f.fleetRole || null, ships: f.shipCount, jumps: dist.get(sysId),
        systemId: sysId, hostility: hostilityOf(deps, playerId, f.factionId, pirates) });
    }
  }
  return { ok: true, entries };
}

function shipStatus(ctx) {
  const t = ctx.deps.telemetry(ctx.playerId);
  if (!t || !t.ok) return fail((t && t.reason) || "SEAM_UNAVAILABLE");
  return { ok: true, data: { ship: t.shipTypeId ? ctx.deps.typeName(t.shipTypeId) : null, docked: t.docked,
    shieldPct: pct(t.shieldPermille), armorPct: pct(t.armorPermille), structurePct: pct(t.structurePermille),
    capacitorPct: pct(t.capacitorPermille), speedMps: t.speedMps, warping: t.warping } };
}

function location(ctx) {
  const rec = presenceOf(ctx.deps, ctx.playerId);
  if (!rec) return fail("NO_PRESENCE");
  const graph = ctx.deps.graph();
  if (!graph || !graph.hasSystem(rec.systemId)) return fail("GRAPH_UNAVAILABLE");
  const rows = ctx.S.toolMaxRows;
  const st = ctx.deps.stations(rec.systemId);
  const stations = st && st.ok && Array.isArray(st.stations) ? st.stations.slice(0, rows).map((s) => s.name) : [];
  return { ok: true, data: { ...systemView(graph, rec.systemId), state: rec.state,
    neighbours: (graph.getNeighbors(rec.systemId) || []).slice(0, rows).map((id) => graph.getSystem(id).name),
    stations } };
}

function factionRows(deps, fleets, rows) {
  const pirates = deps.pirates();
  const by = new Map();
  for (const f of fleets) {
    const row = by.get(f.factionId) || { faction: deps.factionName(f.factionId), fleets: 0, ships: 0,
      pirate: Boolean(pirates && pirates.has(f.factionId)), inSpace: 0, roles: new Set() };
    row.fleets += 1;
    row.ships += f.shipCount;
    if (f.inSpace === true) row.inSpace += 1;
    if (typeof f.fleetRole === "string" && f.fleetRole !== "") row.roles.add(f.fleetRole);
    by.set(f.factionId, row);
  }
  return [...by.values()].sort((a, b) => b.ships - a.ships).slice(0, rows)
    .map((r) => ({ ...r, roles: [...r.roles].sort().slice(0, rows) }));
}

function localScan(ctx) {
  const rec = presenceOf(ctx.deps, ctx.playerId);
  if (!rec) return fail("NO_PRESENCE");
  const res = ctx.deps.presence();
  const pilots = res.characters.filter((r) => r && r.systemId === rec.systemId).length;
  const read = ctx.deps.fleetsIn([rec.systemId], PRESENT_STATES);
  if (!read || !read.ok || !(read.bySystem instanceof Map)) return fail((read && read.reason) || "FLEETS_UNAVAILABLE");
  const fleets = read.bySystem.get(rec.systemId) || [];
  const npcs = typeof ctx.deps.localNpcs === "function" ? ctx.deps.localNpcs(rec.systemId) : null;
  return { ok: true, data: { pilotsInLocal: pilots, npcPilotsInLocal: npcs, lneFleets: fleets.length,
    lneShips: fleets.reduce((n, f) => n + f.shipCount, 0), factions: factionRows(ctx.deps, fleets, ctx.S.toolMaxRows) } };
}

function nearbyThreats(ctx) {
  const rec = presenceOf(ctx.deps, ctx.playerId);
  if (!rec) return fail("NO_PRESENCE");
  const r = fleetsAround(ctx.deps, ctx.playerId, rec.systemId, ctx.S.threatMaxJumps);
  if (!r.ok) return r;
  const graph = ctx.deps.graph();
  const listed = r.entries.filter((e) => e.hostility !== HOSTILITY.NOT_HOSTILE)
    .sort((a, b) => a.jumps - b.jumps || b.ships - a.ships);
  return { ok: true, data: { maxJumps: ctx.S.threatMaxJumps,
    hostile: listed.filter((e) => e.hostility === HOSTILITY.HOSTILE).length,
    unknown: listed.filter((e) => e.hostility === HOSTILITY.UNKNOWN).length,
    fleets: listed.slice(0, ctx.S.toolMaxRows).map((e) => ({ faction: ctx.deps.factionName(e.factionId), role: e.role,
      ships: e.ships, jumps: e.jumps, system: graph.getSystem(e.systemId).name, hostility: e.hostility })) } };
}

function route(ctx, args) {
  const rec = presenceOf(ctx.deps, ctx.playerId);
  if (!rec) return fail("NO_PRESENCE");
  const graph = ctx.deps.graph();
  if (!graph || !graph.hasSystem(rec.systemId) || typeof graph.findRoute !== "function") return fail("GRAPH_UNAVAILABLE");
  const dest = resolveSystem(graph, args.dest);
  if (!dest.ok) return dest;
  const found = graph.findRoute(rec.systemId, dest.id);
  if (!found || !found.ok) return fail((found && found.reason) || "NO_ROUTE");
  const path = found.route.map((id) => graph.getSystem(id));
  return { ok: true, data: { from: path[0].name, to: path[path.length - 1].name, jumps: found.jumps,
    lowsecSystems: path.filter((s) => s.secClass === "lowsec").length,
    nullsecSystems: path.filter((s) => s.secClass === "nullsec").length,
    path: path.slice(1, 1 + ctx.S.toolMaxRows).map((s) => ({ name: s.name, security: sec1(s.security) })) } };
}

function systemInfo(ctx, args) {
  const graph = ctx.deps.graph();
  if (!graph) return fail("GRAPH_UNAVAILABLE");
  const sys = resolveSystem(graph, args.name);
  if (!sys.ok) return sys;
  const cs = ctx.deps.controlState(sys.id);
  const row = cs && cs.ok && cs.system ? cs.system : null;
  return { ok: true, data: { ...systemView(graph, sys.id),
    owner: row && Number.isSafeInteger(row.controllerFactionId) ? ctx.deps.factionName(row.controllerFactionId) : null,
    occupation: row && typeof row.occupationState === "string" ? row.occupationState : null } };
}

function factionSituation(ctx) {
  const rec = presenceOf(ctx.deps, ctx.playerId);
  if (!rec) return fail("NO_PRESENCE");
  const graph = ctx.deps.graph();
  const sys = graph ? graph.getSystem(rec.systemId) : null;
  if (!sys) return fail("GRAPH_UNAVAILABLE");
  const read = ctx.deps.systems(graph.getSystemsInRegion(sys.regionId));
  if (!read || !read.ok || !Array.isArray(read.systems)) return fail((read && read.reason) || "WORLD_UNAVAILABLE");
  const by = new Map();
  for (const row of read.systems) {
    const id = row.controllerFactionId;
    if (!Number.isSafeInteger(id)) continue;
    const e = by.get(id) || { faction: ctx.deps.factionName(id), systems: 0, contested: 0 };
    e.systems += 1;
    if (row.occupationState && row.occupationState !== "STABLE") e.contested += 1;
    by.set(id, e);
  }
  return { ok: true, data: { region: graph.getRegionName(sys.regionId), systems: read.systems.length,
    factions: [...by.values()].sort((a, b) => b.contested - a.contested || b.systems - a.systems)
      .slice(0, ctx.S.toolMaxRows) } };
}

function itemOf(ctx, name) {
  const r = ctx.deps.itemByName(name);
  if (!r || !r.ok) return fail((r && r.reason) || "SEAM_UNAVAILABLE");
  if (r.found) return { ok: true, item: r.item };
  const s = typeof ctx.deps.itemSearch === "function" ? ctx.deps.itemSearch(name, ctx.S.toolMaxRows) : null;
  if (!s || !s.ok || !Array.isArray(s.candidates) || s.candidates.length === 0) return fail("UNKNOWN_ITEM");
  const one = s.candidates[0];
  if (s.matched === "all" && s.candidates.length === 1 && s.more === 0 && one.byName === true) {
    return { ok: true, item: { typeId: one.typeId, name: one.name, groupName: one.groupName, categoryId: one.categoryId,
      volume: one.volume } };
  }
  return fail("UNKNOWN_ITEM", { candidates: s.candidates.map((c) => ({ item: c.name, group: c.groupName })),
    ...(s.more > 0 ? { more: s.more } : {}) });
}

async function marketPrice(ctx, args) {
  const it = itemOf(ctx, args.item);
  if (!it.ok) return it;
  const rec = presenceOf(ctx.deps, ctx.playerId);
  const graph = ctx.deps.graph();
  const sys = rec && graph ? graph.getSystem(rec.systemId) : null;
  if (!sys) return fail("NO_PRESENCE");
  const r = await ctx.deps.prices(it.item.typeId, sys.regionId);
  const p = r && r.ok && r.prices instanceof Map ? r.prices.get(it.item.typeId) : null;
  if (!p) return fail((r && r.reason) || "NO_PRICE");
  return { ok: true, data: { item: it.item.name, region: graph.getRegionName(sys.regionId), buyIsk: iskOf(p.bidMilli),
    sellIsk: iskOf(p.askMilli), baseIsk: iskOf(p.baseMilli) } };
}

function itemInfo(ctx, args) {
  const it = itemOf(ctx, args.item);
  if (!it.ok) return it;
  return { ok: true, data: { item: it.item.name, group: it.item.groupName, categoryId: it.item.categoryId,
    volumeM3: it.item.volume } };
}

function wallet(ctx) {
  const r = ctx.deps.wallet(ctx.playerId);
  if (!r || !r.ok) return fail((r && r.reason) || "SEAM_UNAVAILABLE");
  return Number.isFinite(r.balanceIsk) ? { ok: true, data: { iskBalance: Math.floor(r.balanceIsk) } }
    : fail("NO_WALLET");
}

function skillsSummary(ctx) {
  const r = ctx.deps.skills(ctx.playerId, ctx.S.toolMaxRows);
  if (!r || !r.ok) return fail((r && r.reason) || "SEAM_UNAVAILABLE");
  return { ok: true, data: { totalSp: r.totalSp, topGroups: r.groups.map((g) => ({ group: g.name, sp: g.sp })) } };
}

const RECENT_EVENTS_MAX = 5;
function recentEvents(ctx) {
  const r = ctx.deps.recentEvents(ctx.playerId, Math.min(RECENT_EVENTS_MAX, ctx.S.toolMaxRows));
  if (!r || !r.ok) return fail((r && r.reason) || "EVENTS_UNAVAILABLE");
  return { ok: true, data: { events: r.events } };
}

const NAME_ARG = (key) => Object.freeze({ [key]: Object.freeze({ type: "string", maxLen: NAME_MAX_LEN }) });
const NO_ARGS = Object.freeze({});
const tool = (name, description, args, run) => Object.freeze({ name, description, args, run });

const TOOLS = Object.freeze([
  tool("ship_status", "your ship: hull type, shield / armor / structure / capacitor %, speed, docked", NO_ARGS,
    shipStatus),
  tool("location", "current system, security, region, neighbour systems and NPC stations", NO_ARGS, location),
  tool("local_scan", "player and NPC pilot counts in Local, the faction fleets in this system (ships, roles)", NO_ARGS,
    localScan),
  tool("nearby_threats", "hostile faction fleets here and within a few jumps", NO_ARGS, nearbyThreats),
  tool("route", "jumps to a system, lowsec / nullsec count, the first systems", NAME_ARG("dest"), route),
  tool("system_info", "security, region, owner faction and occupation of a system", NAME_ARG("name"), systemInfo),
  tool("faction_situation", "owner factions and contested systems of the current region", NO_ARGS, factionSituation),
  tool("market_price", `buy / sell price of an item in the current region; ${ITEM_HINT_SHORT}`, NAME_ARG("item"),
    marketPrice),
  tool("item_info", `group, category and volume of an item; ${ITEM_HINT}`, NAME_ARG("item"), itemInfo),
  tool("wallet", "your ISK balance", NO_ARGS, wallet),
  tool("skills_summary", "your skill points and the top skill groups", NO_ARGS, skillsSummary),
  tool("recent_events", "your last game events: losses, docking, new systems and regions, warnings", NO_ARGS,
    recentEvents),
]);

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const MEMO_MAX = 16;
const catalogMemo = new Map();
const DB_NAMES = new Set(TOOLS_DB.map((t) => t.name));

const csvNames = (csv) => (typeof csv === "string" ? csv.split(",").map((p) => p.trim()).filter((p) => p !== "") : []);

function catalogOf(S) {
  const enabled = Boolean(S) && S.dbReadEnabled === true;
  const csv = enabled && typeof S.dbReadDisabledTools === "string" ? S.dbReadDisabledTools : "";
  const key = `${enabled}|${csv}`;
  let entry = catalogMemo.get(key);
  if (entry) return entry;
  const off = new Set(csvNames(csv));
  const list = Object.freeze(enabled ? [...TOOLS, ...TOOLS_DB.filter((t) => !off.has(t.name))] : [...TOOLS]);
  entry = Object.freeze({ list, byName: new Map(list.map((t) => [t.name, t])) });
  if (catalogMemo.size >= MEMO_MAX) catalogMemo.clear();
  catalogMemo.set(key, entry);
  return entry;
}

const toolsFor = (S) => catalogOf(S).list;
const toolMapFor = (S) => catalogOf(S).byName;
const unknownDisabledTools = (S) => (S && S.dbReadEnabled === true
  ? csvNames(S.dbReadDisabledTools).filter((n) => !DB_NAMES.has(n)) : []);

function catalogueLines(tools) {
  return tools.map((t) => {
    const keys = Object.keys(t.args);
    const args = keys.length === 0 ? "" : ` ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, "..."])))}`;
    return `- ${t.name}${args}: ${t.description}`;
  }).join("\n");
}

module.exports = { TOOLS, TOOL_BY_NAME, HOSTILITY, PRESENT_STATES, fleetsAround, presenceOf, resolveSystem, systemsAround,
  catalogueLines, toolsFor, toolMapFor, unknownDisabledTools, itemOf };
