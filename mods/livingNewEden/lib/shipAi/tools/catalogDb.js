"use strict";

const { UNKNOWN } = require("../../names/fallback");

const SEC_DECIMALS = 100;
const VOLUME_DECIMALS = 10;
const FILETIME_PER_MS = 10000;
const FILETIME_EPOCH_MS = 11644473600000;
const DATE_CHARS = 10;
const STRUCTURE = "structure";

const fail = (reason) => ({ ok: false, reason });
const refused = (r) => fail((r && r.reason) || "SEAM_UNAVAILABLE");
const round = (v, k) => (Number.isFinite(v) ? Math.round(v * k) / k : null);

function namer(deps, ids) {
  const names = deps.typeNames([...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))]);
  return (id) => (Number.isSafeInteger(id) && id > 0 ? names.get(id) || UNKNOWN.item : null);
}

function cargo(ctx) {
  const r = ctx.deps.cargo(ctx.playerId, ctx.S.toolMaxRows);
  if (!r || !r.ok) return refused(r);
  const nameOf = namer(ctx.deps, [r.shipTypeId, ...r.holds.flatMap((h) => h.items.map((i) => i.typeId))]);
  return { ok: true, data: { ship: nameOf(r.shipTypeId), docked: r.docked,
    cargoUsedM3: round(r.volumeM3, VOLUME_DECIMALS), holds: r.holds.map((h) => ({ hold: h.hold, items: h.items.map((i) => ({ item: nameOf(i.typeId), qty: i.qty })),
      more: h.more })) } };
}

function fitting(ctx) {
  const r = ctx.deps.fitting(ctx.playerId, ctx.S.toolMaxRows);
  if (!r || !r.ok) return refused(r);
  const nameOf = namer(ctx.deps, [r.shipTypeId,
    ...r.racks.flatMap((k) => k.modules.flatMap((m) => [m.typeId, m.chargeTypeId]))]);
  return { ok: true, data: { ship: nameOf(r.shipTypeId), racks: r.racks.map((k) => ({ rack: k.rack,
    modules: k.modules.map((m) => (m.chargeTypeId ? { module: nameOf(m.typeId), count: m.count,
      charge: nameOf(m.chargeTypeId), chargeQty: m.chargeQty } : { module: nameOf(m.typeId), count: m.count })),
    more: k.more })) } };
}

function dateOfFileTime(text) {
  if (typeof text !== "string" || !/^\d{1,20}$/.test(text)) return null;
  const ms = Number(text) / FILETIME_PER_MS - FILETIME_EPOCH_MS;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().slice(0, DATE_CHARS);
}

function pilotInfo(ctx) {
  const r = ctx.deps.pilot(ctx.playerId);
  if (!r || !r.ok) return refused(r);
  const names = r.homeStationId ? ctx.deps.stationNames([r.homeStationId]) : null;
  const home = names && names.ok ? names.names.get(r.homeStationId) || STRUCTURE : null;
  return { ok: true, data: { corporation: r.corporationName, securityStatus: round(r.securityStatus, SEC_DECIMALS),
    homeStation: home, created: dateOfFileTime(r.createdFileTime) } };
}

const ISK_DECIMALS = 1;
const STANDING_DECIMALS = 100;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const NAME_MAX_LEN = 48;

function siteNamer(deps, sites) {
  const names = deps.stationNames(sites.filter((s) => s.kind === "station").map((s) => s.id));
  return (id, kind) => {
    if (kind === "structure" || kind === "space") return kind;
    return kind === "station" && names.ok ? names.names.get(id) || null : null;
  };
}

function assets(ctx) {
  const r = ctx.deps.assets(ctx.playerId, ctx.S.toolMaxRows);
  if (!r || !r.ok) return refused(r);
  const placeOf = siteNamer(ctx.deps, r.locations.map((l) => ({ id: l.locationId, kind: l.kind })));
  return { ok: true, data: { locations: r.locations.map((l) => ({ place: placeOf(l.locationId, l.kind), kind: l.kind,
    items: l.items, ships: l.ships })), totalItems: r.totalItems, more: r.more } };
}

function findItem(ctx, args) {
  const it = v1().itemOf(ctx, args.item);
  if (!it.ok) return it;
  const r =ctx.deps.findItem(ctx.playerId, it.item.typeId, ctx.S.toolMaxRows);
  if (!r || !r.ok) return refused(r);
  const placeOf = siteNamer(ctx.deps, r.places.map((p) => ({ id: p.siteId, kind: p.siteKind })));
  const nameOf = namer(ctx.deps, r.places.map((p) => p.holderTypeId));
  return { ok: true, data: { item: it.item.name, totalQty: r.totalQty, places: r.places.map((p) => (p.holderTypeId
    ? { place: placeOf(p.siteId, p.siteKind), in: p.kind, holder: nameOf(p.holderTypeId), qty: p.qty }
    : { place: placeOf(p.siteId, p.siteKind), in: p.kind, qty: p.qty })), more: r.more } };
}

function walletHistory(ctx) {
  const now = ctx.nowMs();
  const r = ctx.deps.walletHistory(ctx.playerId, ctx.S.toolMaxRows, now, ctx.S.walletSumWindowMs);
  if (!r || !r.ok) return refused(r);
  return { ok: true, data: { entries: r.entries.map((e) => ({ minutesAgo: e.whenMsAgo === null ? null
    : Math.round(e.whenMsAgo / MS_PER_MINUTE), type: e.type, amountIsk: round(e.amountIsk, ISK_DECIMALS),
  balanceIsk: round(e.balanceIsk, ISK_DECIMALS) })), windowHours: Math.round(ctx.S.walletSumWindowMs / MS_PER_HOUR),
  incomeIsk: round(r.window.inIsk, ISK_DECIMALS), spendingIsk: round(r.window.outIsk, ISK_DECIMALS), more: r.more,
  ...(r.window.truncated === true ? { windowTruncated: true } : {}) } };
}

function skillQueue(ctx) {
  const r = ctx.deps.skillQueue(ctx.playerId, ctx.S.toolMaxRows);
  if (!r || !r.ok) return refused(r);
  const nameOf = namer(ctx.deps, r.queue.map((q) => q.typeId));
  return { ok: true, data: { training: r.active, queue: r.queue.map((q) => ({ skill: nameOf(q.typeId),
    toLevel: q.toLevel })), more: r.more } };
}

function standings(ctx) {
  const r = ctx.deps.standings(ctx.playerId, ctx.S.toolMaxRows);
  if (!r || !r.ok) return refused(r);
  const row = (s) => ({ owner: s.name || UNKNOWN.owner,
    standing: round(s.standing, STANDING_DECIMALS) });
  return { ok: true, data: { best: r.top.map(row), worst: r.bottom.map(row) } };
}

const PRICE_DECIMALS = 100;
const ACTIVITIES = Object.freeze(new Map([[1, "manufacturing"], [3, "time efficiency research"],
  [4, "material efficiency research"], [5, "copying"], [8, "invention"], [9, "reactions"], [11, "reactions"]]));

function systemNamer(deps) {
  const g = deps.graph();
  return (id) => {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const s = g && typeof g.getSystem === "function" ? g.getSystem(id) : null;
    return s && s.name ? s.name : UNKNOWN.system;
  };
}

function killmails(ctx) {
  const now = ctx.nowMs();
  const r = ctx.deps.killmails(ctx.playerId, ctx.S.toolMaxRows, now);
  if (!r || !r.ok) return refused(r);
  const nameOf = namer(ctx.deps, r.entries.flatMap((e) => [e.victimShipTypeId, e.ownShipTypeId]));
  const systemOf = systemNamer(ctx.deps);
  return { ok: true, data: { entries: r.entries.map((e) => ({ role: e.role,
    minutesAgo: e.whenMsAgo === null ? null : Math.round(e.whenMsAgo / MS_PER_MINUTE), system: systemOf(e.systemId),
    victimShip: nameOf(e.victimShipTypeId), ownShip: nameOf(e.ownShipTypeId), attackers: e.attackers,
    iskLost: round(e.iskLost, ISK_DECIMALS) })), more: r.more } };
}

function missions(ctx) {
  const r = ctx.deps.missions(ctx.playerId, ctx.S.toolMaxRows, ctx.nowMs());
  if (!r || !r.ok) return refused(r);
  const systemOf = systemNamer(ctx.deps);
  return { ok: true, data: { missions: r.missions.map((x) => ({ title: x.title, kind: x.kind, status: x.status,
    done: x.done, system: systemOf(x.systemId), expiresInHours: x.expiresInHours })), more: r.more } };
}

function industryJobs(ctx) {
  const r = ctx.deps.industryJobs(ctx.playerId, ctx.S.toolMaxRows, ctx.nowMs());
  if (!r || !r.ok) return refused(r);
  const nameOf = namer(ctx.deps, r.jobs.map((j) => j.productTypeId));
  return { ok: true, data: { jobs: r.jobs.map((j) => ({ activity: ACTIVITIES.get(j.activityId)
    || `activity ${j.activityId}`, product: nameOf(j.productTypeId), runs: j.runs, endsInMinutes: j.endsInMinutes,
  ready: j.ready })), more: r.more } };
}

async function marketOrders(ctx) {
  const r = await ctx.deps.marketOrders(ctx.playerId, ctx.S.toolMaxRows);
  if (!r || !r.ok) return refused(r);
  const nameOf = namer(ctx.deps, r.orders.map((x) => x.typeId));
  const placeOf = siteNamer(ctx.deps, r.orders.filter((x) => x.stationId !== null)
    .map((x) => ({ id: x.stationId, kind: siteKindOfId(x.stationId) })));
  return { ok: true, data: { orders: r.orders.map((x) => ({ side: x.side, item: nameOf(x.typeId),
    priceIsk: round(x.priceIsk, PRICE_DECIMALS), remaining: x.remaining, total: x.total,
    station: x.stationId === null ? null : placeOf(x.stationId, siteKindOfId(x.stationId)) })), more: r.more } };
}

const NPC_STATION_IDS = Object.freeze([60000000, 64000000]);
const siteKindOfId = (id) => (id >= NPC_STATION_IDS[0] && id < NPC_STATION_IDS[1] ? "station" : STRUCTURE);

const INVASION_ROUTE_ROWS_FACTOR = 4;
const v1 = () => require("./catalog");

function battlesNearby(ctx) {
  const { presenceOf, systemsAround } = v1();
  const rec = presenceOf(ctx.deps, ctx.playerId);
  if (!rec) return fail("NO_PRESENCE");
  const graph = ctx.deps.graph();
  if (!graph || !graph.hasSystem(rec.systemId)) return fail("GRAPH_UNAVAILABLE");
  const dist = systemsAround(graph, rec.systemId, ctx.S.threatMaxJumps);
  const rows = ctx.S.toolMaxRows;
  const r = ctx.deps.battlesIn([...dist.keys()], 1 + rows);
  if (!r || !r.ok || !(r.bySystem instanceof Map)) return fail((r && r.reason) || "BATTLES_UNAVAILABLE");
  const all = [];
  for (const [systemId, list] of r.bySystem) {
    for (const b of list) all.push({ systemId, jumps: dist.get(systemId), state: b.state, mode: b.mode });
  }
  all.sort((a, b) => a.jumps - b.jumps || a.systemId - b.systemId);
  const systemOf = systemNamer(ctx.deps);
  return { ok: true, data: { maxJumps: ctx.S.threatMaxJumps, battles: all.slice(0, rows).map((e) => ({
    system: systemOf(e.systemId), jumps: e.jumps, state: e.state, mode: e.mode })),
  more: Math.max(0, all.length - rows) } };
}

function jumpsTo(graph, from, to) {
  if (from === to) return 0;
  const found = typeof graph.findRoute === "function" ? graph.findRoute(from, to) : null;
  return found && found.ok && Number.isSafeInteger(found.jumps) ? found.jumps : null;
}

function invasions(ctx) {
  const rows = ctx.S.toolMaxRows;
  const cap = rows * INVASION_ROUTE_ROWS_FACTOR;
  const r = ctx.deps.invasionsOpen(cap + 1);
  if (!r || !r.ok || !Array.isArray(r.invasions)) return fail((r && r.reason) || "INVASIONS_UNAVAILABLE");
  const rec = v1().presenceOf(ctx.deps, ctx.playerId);
  const graph = ctx.deps.graph();
  const here = rec && graph && graph.hasSystem(rec.systemId) ? rec.systemId : null;
  const list = r.invasions.map((x, i) => ({ ...x, i, jumps: null }));
  if (here !== null && list.length <= cap) {
    for (const x of list) x.jumps = jumpsTo(graph, here, x.beachheadSystemId);
    list.sort((a, b) => (a.jumps === null) - (b.jumps === null) || (a.jumps || 0) - (b.jumps || 0) || a.i - b.i);
  } else if (here !== null) {
    const regionOf = (id) => {
      const s = graph.getSystem(id);
      return s ? s.regionId : null;
    };
    const mine = regionOf(here);
    const same = (x) => (mine !== null && regionOf(x.beachheadSystemId) === mine ? 0 : 1);
    list.sort((a, b) => same(a) - same(b) || a.i - b.i);
  }
  const systemOf = systemNamer(ctx.deps);
  return { ok: true, data: { invasions: list.slice(0, rows).map((x) => ({ faction: ctx.deps.factionName(x.factionId),
    system: systemOf(x.beachheadSystemId), jumps: x.jumps, state: x.state })),
  more: Math.max(0, list.length - rows) } };
}

const { parseRange, classifyEntries, summarizeScan } = require("../dscan/summary");
const DSCAN_CONTACT_PILOTS_FACTOR = 4;

function dscanTool(ctx, args) {
  const range = parseRange(args.range);
  if (!range.ok) return fail(range.reason);
  const { deps, S, playerId } = ctx;
  const r = deps.dscan(playerId, { rangeMeters: range.meters, maxEntries: S.dscanMaxEntries });
  if (!r || !r.ok || !Array.isArray(r.entries)) return refused(r);
  const ids = [];
  const seen = new Set();
  const pilots = r.entries.filter((x) => x && x.isPlayer === true);
  for (const e of pilots.slice(0, S.toolMaxRows * DSCAN_CONTACT_PILOTS_FACTOR)) {
    for (const id of [e.characterId, e.corporationId, e.allianceId]) {
      if (Number.isSafeInteger(id) && id > 0 && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  let contacts = new Map();
  if (ids.length > 0) {
    const c = typeof deps.contactStandings === "function" ? deps.contactStandings(playerId, ids) : null;
    contacts = c && c.ok && c.standings instanceof Map ? c.standings : null;
  }
  const own = r.own || {};
  const nowMs = typeof ctx.nowMs === "function" ? ctx.nowMs() : 0;
  const cx = { pirates: deps.pirates(), invaders: deps.invaderFactions(nowMs),
    standing: (factionId) => deps.standing(playerId, factionId), contacts,
    ownCorporationId: own.corporationId || null, ownAllianceId: own.allianceId || null,
    classOf: (typeId) => deps.typeClass(typeId), factionName: (factionId) => deps.factionName(factionId) };
  return { ok: true, data: summarizeScan(classifyEntries(r.entries, cx, S), r, cx, S) };
}

const NO_ARGS = Object.freeze({});
const ITEM_HINT_SHORT = "English name or fragments";
const ITEM_HINT = `item = ${ITEM_HINT_SHORT}, e.g. "Small Shield Booster Blueprint", "Caldari frigate"; `
  + "no exact name -> candidates";
const ITEM_ARG = Object.freeze({ item: Object.freeze({ type: "string", maxLen: NAME_MAX_LEN }) });
const tool = (name, description, args, run) => Object.freeze({ name, description, args, run, db: true });
const RANGE_ARG = Object.freeze({ range: Object.freeze({ type: "string", maxLen: 16, optional: true,
  default: "max" }) });

const TOOLS_DB = Object.freeze([
  tool("cargo", "cargo, drone bay and fleet hangar of your ship", NO_ARGS, cargo),
  tool("fitting", "modules fitted on your ship by rack, with loaded charges", NO_ARGS, fitting),
  tool("pilot_info", "your corporation, security status and home station", NO_ARGS, pilotInfo),
  tool("assets", "where your items and ships are, by station", NO_ARGS, assets),
  tool("find_item", `where you keep a given item and how many; ${ITEM_HINT_SHORT}`, ITEM_ARG, findItem),
  tool("wallet_history", "your last ISK journal entries and income / spending", NO_ARGS, walletHistory),
  tool("skill_queue", "your skill training queue", NO_ARGS, skillQueue),
  tool("standings", "your best and worst NPC faction / corporation standings", NO_ARGS, standings),
  tool("killmails", "your recent kills and losses", NO_ARGS, killmails),
  tool("missions", "your agent missions: title, status, system, expiry", NO_ARGS, missions),
  tool("industry_jobs", "your running industry jobs and when they finish", NO_ARGS, industryJobs),
  tool("market_orders", "your open market buy / sell orders", NO_ARGS, marketOrders),
  tool("battles_nearby", "ongoing faction battles within a few jumps", NO_ARGS, battlesNearby),
  tool("invasions", "open faction invasions, the nearest first", NO_ARGS, invasions),
  tool("dscan", "d-scan 360: ships by faction/class, hostiles; range max|N km|N AU", RANGE_ARG, dscanTool),
]);

module.exports = { TOOLS_DB, ITEM_HINT, ITEM_HINT_SHORT, dateOfFileTime, ACTIVITIES };
