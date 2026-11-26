"use strict";

const { HULL_GROUPS, parseHullGroupList } = require("../../fleets/schema");
const { hullTargets, rankMobilizationStations, huntersNeedHullsOf, tributeOnOf, hullsRequiredOf } =
  require("../../strategy/ai/production");
const { ladderPlanOf, recipePermilleOf } = require("../../strategy/ai/capitalLadder");
const { capitalClassesOf } = require("../../strategy/data/factionHullClasses");
const { CLASS_TIERS } = require("../../fleets/data/capitalClasses");
const S = require("../schema");

const VIEW_ID = "production";
const VIEW_ORDER = 58;
const WORK_CLASS = "MAINTENANCE";
const DAY_MS = 86400000;
const ONLINE = "ONLINE";

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildProductionView(deps) {
  const { store, jobs, clock, config } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const targetParams = Object.freeze({ targetStockFleets: config.production.targetStockFleets,
    miningNeedsHulls: config.production.miningNeedsHulls, hullGroups: HULL_GROUPS,
    freeHullGroups: Object.freeze(parseHullGroupList(config.production.freeHullGroups) || []),
    huntersNeedHulls: huntersNeedHullsOf(config) });
  const tribute = tributeOnOf(config) ? { recipientBuildsHulls: config.tribute.recipientBuildsHulls } : null;
  const ladderOn = config.production.capitalLadderEnabled === true;
  const ladderParams = ladderOn ? Object.freeze({ production: Object.freeze({ ...config.production, ...targetParams,
    capitalTiers: CLASS_TIERS }) }) : null;

  function secClassReader() {
    const g = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
    const live = g && typeof g.getGraph === "function" ? call(() => g.getGraph(), null) : null;
    const graph = live && live.ok ? live.graph : g;
    return (id) => call(() => {
      const v = graph && typeof graph.getSystem === "function" ? graph.getSystem(id) : null;
      return v && typeof v.secClass === "string" ? v.secClass : null;
    }, null);
  }

  function ladderOf(f, ctx) {
    const r = deps.registry;
    const entry = r && typeof r.getFaction === "function" ? call(() => r.getFaction(f), null) : null;
    const snapshot = { entry: entry ? { kind: entry.kind } : null,
      faction: { status: ctx.active ? "ACTIVE" : "INACTIVE" }, stationsMode: "ready", doctrine: ctx.doctrine,
      capitalClasses: capitalClassesOf(f), fleets: [], fleetsTruncated: false,
      production: { mode: "ready", truncated: false, recipes: ctx.recipes, recipesVersion: ctx.recipesVersion,
        activeJobsTotal: ctx.activeJobs, stations: ctx.stations } };
    const plan = ladderPlanOf(snapshot, ladderParams);
    if (!plan.on) return null;
    const mc = plan.stationId ? ctx.stations.find((s) => s.stationId === plan.stationId) : null;
    const recipe = plan.cls ? ctx.recipes[plan.cls] : null;
    return { cls: plan.cls, have: plan.have, quota: plan.quota, bufferPermille: plan.bufferPermille,
      station: plan.stationId, recipePermille: mc && recipe ? recipePermilleOf(mc.minerals, recipe) : null,
      notes: plan.notes };
  }

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  const maxActiveJobs = config.observer.productionMaxActiveJobs;
  const refreshMs = config.observer.productionRefreshMs;

  function stationsRepository() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    return (st && st.repository) || null;
  }

  function readStations(db) {
    const repo = stationsRepository();
    if (!repo || typeof repo.listLiveStations !== "function") {
      return { ok: true, stations: [], hulls: [], minerals: [] };
    }
    const live = repo.listLiveStations(db, {});
    if (!live.ok) return live;
    const stations = [];
    const hulls = [];
    const minerals = [];
    for (const s of live.records) {
      if (s.state === ONLINE) {
        stations.push({ station_id: s.stationId, kind: s.kind, system_id: s.systemId,
          owner_faction_id: s.ownerFactionId });
      }
      const stock = repo.getStock(db, s.stationId);
      if (!stock.ok) return stock;
      for (const it of stock.items) {
        if (it.itemKind === S.MINERAL_ITEM_KIND && s.state === ONLINE) {
          minerals.push({ station_id: s.stationId, item_key: it.itemKey, quantity: it.quantity });
        }
        if (it.itemKind !== S.HULL_ITEM_KIND) continue;
        hulls.push({ faction_id: s.ownerFactionId, station_id: s.stationId, item_key: it.itemKey,
          quantity: it.quantity });
      }
    }
    const order = (a, b) => a.owner_faction_id - b.owner_faction_id
      || (a.station_id < b.station_id ? -1 : a.station_id > b.station_id ? 1 : 0);
    stations.sort(order);
    return { ok: true, stations, hulls, minerals };
  }

  function stockChanges() {
    const repo = stationsRepository();
    return repo && typeof repo.getChangeCount === "function" ? call(() => repo.getChangeCount(), 0) : 0;
  }

  function doctrineOf(f) {
    const r = deps.registry;
    if (!r || typeof r.getFaction !== "function") return null;
    const entry = call(() => r.getFaction(f), null);
    const doctrine = entry && typeof r.getDoctrine === "function"
      ? call(() => r.getDoctrine(entry.doctrineId), null) : null;
    if (!doctrine || doctrine.hullsRequired !== false) return doctrine;
    const required = hullsRequiredOf(doctrine, tribute, () => typeof r.isTributeRecipient === "function"
      && call(() => r.isTributeRecipient(f), false) === true);
    return required ? { ...doctrine, hullsRequired: true } : doctrine;
  }

  function recipesOf() {
    const table = typeof deps.getRecipes === "function" ? call(deps.getRecipes, null) : null;
    const out = {};
    if (!table || !Array.isArray(table.groups) || typeof table.lookup !== "function") return out;
    for (const g of table.groups) {
      const r = call(() => table.lookup(g), null);
      if (r && r.minerals) out[g] = { minerals: r.minerals };
    }
    return out;
  }

  function getData() {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const since = Math.max(0, clock.now() - DAY_MS);
    const tx = store.transaction("observer.production", (db) => {
      const totals = jobs.listTotals(db);
      if (!totals.ok) return totals;
      const active = jobs.listActiveAll(db, maxActiveJobs);
      if (!active.ok) return active;
      const ended = jobs.recentEnded(db, since);
      if (!ended.ok) return ended;
      const st = readStations(db);
      if (!st.ok) return st;
      return { ok: true, totals: totals.totals, active: active.jobs, ended: ended.rows, stations: st.stations,
        hulls: st.hulls, minerals: st.minerals };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const activeIds = call(() => (deps.registry && typeof deps.registry.listActiveFactions === "function"
      ? deps.registry.listActiveFactions().map((x) => x.factionId) : []), []);
    const ids = new Set(activeIds);
    const secClassOf = ladderOn ? secClassReader() : null;
    for (const r of read.totals) ids.add(r.factionId);
    for (const r of read.active) ids.add(r.factionId);
    for (const r of read.hulls) ids.add(r.faction_id);
    const st = call(() => deps.getStatus(), {}) || {};
    const recipes = recipesOf();
    const mineralsOf = (stationId) => {
      const out = {};
      for (const m of read.minerals) if (m.station_id === stationId) out[m.item_key] = m.quantity;
      return out;
    };
    const factions = [...ids].filter((id) => Number.isSafeInteger(id)).sort((a, b) => a - b).map((f) => {
      const own = read.active.filter((j) => j.factionId === f);
      const stations = read.stations.filter((s) => s.owner_faction_id === f).map((s) => {
        const list = own.filter((j) => j.stationId === s.station_id);
        return { station: s.station_id, kind: s.kind, system: s.system_id,
          lines: `${list.length}/${call(() => deps.linesOf(s.kind), 0)}`,
          jobs: list.map((j) => ({ hullGroup: j.hullGroup, runs: j.runs, dueAt: j.dueAt, waitRound: j.waitRound })) };
      });
      const pool = {};
      const perStation = {};
      for (const h of read.hulls.filter((x) => x.faction_id === f)) {
        const g = h.item_key.startsWith("group:") ? h.item_key.slice("group:".length) : h.item_key;
        pool[g] = (pool[g] || 0) + h.quantity;
        perStation[h.station_id] = { ...(perStation[h.station_id] || {}), [g]: h.quantity };
      }
      const inProduction = {};
      for (const j of own) inProduction[j.hullGroup] = (inProduction[j.hullGroup] || 0) + j.runs;
      const doctrine = doctrineOf(f);
      const desired = doctrine ? hullTargets(doctrine, targetParams) : {};
      const ownStations = read.stations.filter((s) => s.owner_faction_id === f).map((s) => ({
        stationId: s.station_id, systemId: s.system_id, lines: call(() => deps.linesOf(s.kind), 0),
        activeJobs: own.filter((j) => j.stationId === s.station_id), hulls: perStation[s.station_id] || {},
        minerals: mineralsOf(s.station_id) }));
      const ranked = rankMobilizationStations(ownStations, desired, recipes, new Map());
      const ladder = ladderOn ? ladderOf(f, { active: activeIds.includes(f), doctrine, recipes,
        recipesVersion: st.recipesVersion || null, activeJobs: own.length,
        stations: ownStations.map((s) => ({ ...s, secClass: secClassOf(s.systemId) })) }) : null;
      const best = ranked.length > 0 ? { station: ranked[0].stationId, deficit: ranked[0].deficit } : null;
      const deficit = best ? best.deficit : { ...desired };
      const t = read.totals.find((x) => x.factionId === f) || null;
      const endedRows = read.ended.filter((r) => r.faction_id === f);
      const ofState = (state) => endedRows.filter((r) => r.state === state).reduce((n, r) => n + r.hulls, 0);
      return {
        faction: names.get(f) || f,
        stations,
        hullPool: { total: Object.values(pool).reduce((n, v) => n + v, 0), groups: pool, perStation },
        inProduction,
        deficit,
        deficitStation: best ? best.station : null,
        totals: t ? { jobsStarted: t.jobsStarted, jobsDelivered: t.jobsDelivered, jobsLost: t.jobsLost,
          hullsStarted: t.hullsStarted, hullsDelivered: t.hullsDelivered, hullsLost: t.hullsLost,
          mineralsConsumed: t.mineralsConsumed } : null,
        last24h: { hullsDelivered: ofState(S.JOB_DELIVERED), hullsLost: ofState(S.JOB_LOST) },
        ...(ladderOn ? { ladder } : {}),
      };
    });
    return { available: true, state: st.state || null, lastRefusal: st.lastRefusal || null,
      recipesVersion: st.recipesVersion || null, counters: st.counters || null, factions };
  }

  function cacheKey() {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    const st = call(() => deps.getStatus(), {}) || {};
    return `p${jobs.getChangeCount()}|${st.seq === undefined ? 0 : st.seq}|${stockChanges()}|`
      + `${Math.floor(clock.now() / refreshMs)}`;
  }

  return { title: "Hull production", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildProductionView };
