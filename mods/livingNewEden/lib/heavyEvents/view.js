"use strict";

const S = require("./schema");
const P = require("./power/schema");
const powerCatalog = require("./power/catalog");
const worldCatalog = require("./world/catalog");
const { LAYER, LAYERS, layerOfRow } = require("./layer");

const VIEW_ID = "heavy-events";
const VIEW_ORDER = 66;
const WORK_CLASS = "MAINTENANCE";
const ROW_KEYS = Object.freeze(["eventId", "eventType", "tier", "systemId", "system", "factionId", "faction",
  "beneficiaryFactionId", "beneficiary", "state", "open", "phase", "scaleSteps", "abandons", "createdAt", "expiresAt",
  "engagedAt", "endedAt", "endReason", "rewardState",
  "layer", "variant", "affix", "pocket", "pocketCount", "beaconVisibility", "signalStrength"]);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function layerParamOf(req) {
  const value = req && req.query && typeof req.query.get === "function" ? call(() => req.query.get("layer"), null)
    : null;
  return LAYERS.includes(value) ? value : null;
}

function factionNamesOf(adapter) {
  const r = adapter && typeof adapter.readFactionNames === "function" ? call(() => adapter.readFactionNames(), null)
    : null;
  return r && r.ok === true && r.names instanceof Map ? r.names : new Map();
}

function buildHeavyEventsView(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const maxEnded = Number.isSafeInteger(deps.maxEnded) && deps.maxEnded >= 0 ? deps.maxEnded : 0;
  const pc = deps.config && deps.config.powerSites ? deps.config.powerSites : {};
  const powerParams = Object.freeze({
    trailPockets: Number.isSafeInteger(pc.trailPockets) ? pc.trailPockets : 3,
    musterWaves: Number.isSafeInteger(pc.musterWaves) ? pc.musterWaves : 3,
    musterWaveGrowthPermille: Number.isSafeInteger(pc.musterWaveGrowthPermille) ? pc.musterWaveGrowthPermille : 300,
  });
  const wc = deps.config && deps.config.eventAnomalies ? deps.config.eventAnomalies : {};
  const worldParams = Object.freeze({
    trailPockets: Number.isSafeInteger(wc.trailPockets) ? wc.trailPockets : powerParams.trailPockets,
    musterWaves: Number.isSafeInteger(wc.musterWaves) ? wc.musterWaves : powerParams.musterWaves,
    musterWaveGrowthPermille: Number.isSafeInteger(wc.musterWaveGrowthPermille) ? wc.musterWaveGrowthPermille
      : powerParams.musterWaveGrowthPermille,
  });

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function" || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function systemNameOf() {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(() => deps.graph.getGraph(), null) : null;
    const graph = res && res.ok === true && res.graph ? res.graph : null;
    return (id) => {
      const vertex = graph ? call(() => graph.getSystem(id), null) : null;
      return vertex && typeof vertex.name === "string" ? vertex.name : null;
    };
  }

  const nameOf = (id) => (id === null ? null : (names.get(id) || null));

  function rowOf(e, systemName) {
    const layer = layerOfRow(e) || (P.isPowerType(e.eventType) ? LAYER.POWER : LAYER.HEAVY);
    const base = { eventId: e.eventId, eventType: e.eventType, tier: e.tier, systemId: e.systemId,
      system: systemName(e.systemId), factionId: e.factionId, faction: nameOf(e.factionId),
      beneficiaryFactionId: e.beneficiaryFactionId, beneficiary: nameOf(e.beneficiaryFactionId), state: e.state,
      open: e.open, phase: e.phase, scaleSteps: e.scaleSteps, abandons: e.abandons, createdAt: e.createdAt,
      expiresAt: e.expiresAt, engagedAt: e.engagedAt, endedAt: e.endedAt, endReason: e.endReason,
      rewardState: e.rewardState };
    if (layer === "heavy") {
      return { ...base, layer, variant: null, affix: null, pocket: 0, pocketCount: null,
        beaconVisibility: null, signalStrength: null };
    }
    const variant = e.variant || null;
    const affix = e.affix || null;
    const pocket = Number.isSafeInteger(e.pocket) ? e.pocket : 0;
    const worldLike = layer === LAYER.WORLD || layer === LAYER.INCURSION;
    const params = worldLike ? worldParams : powerParams;
    const pocketCount = powerCatalog.pocketCountOf(e.eventType, e.tier, variant, params);
    const beaconVisibility = powerCatalog.visibilityOfPocket(e.eventType, e.tier, variant, pocket, params);
    const signalStrength = worldLike
      ? (Object.prototype.hasOwnProperty.call(worldCatalog.META, variant) ? worldCatalog.META[variant].signal : null)
      : (powerCatalog.META[e.eventType]?.signal || null);
    return { ...base, layer, variant, affix, pocket, pocketCount, beaconVisibility, signalStrength };
  }

  function getData(req) {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const layerFilter = layerParamOf(req);
    const tx = store.transaction("observer.heavyEvents", (db) => {
      const open = repository.listOpenInTx(db, { limit: S.OPEN_SCAN_LIMIT });
      if (!open.ok) return open;
      if (maxEnded === 0) return { ok: true, open: open.rows, truncated: open.truncated, ended: [] };
      const ended = repository.listEndedInTx(db, { limit: maxEnded });
      if (!ended.ok) return ended;
      return { ok: true, open: open.rows, truncated: open.truncated, ended: ended.rows };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const systemName = systemNameOf();
    const mapRow = (e) => rowOf(e, systemName);
    let openRows = read.open.map(mapRow);
    let endedRows = read.ended.map(mapRow);
    if (layerFilter !== null) {
      openRows = openRows.filter((r) => r.layer === layerFilter);
      endedRows = endedRows.filter((r) => r.layer === layerFilter);
    }
    return { available: true, open: openRows, ended: endedRows, truncated: read.truncated, layerFilter };
  }

  function cacheKey(req) {
    const layerFilter = layerParamOf(req);
    return `${layerFilter === null ? "all" : layerFilter}`;
  }

  return { title: "Heavy events", order: VIEW_ORDER, listed: true, getData, cacheKey };
}

function registerHeavyEventsView(deps) {
  const views = deps && deps.views;
  if (!views || typeof views.registerView !== "function") return null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const def = buildHeavyEventsView({ store: deps.store, repository: deps.repository, getGovernor: deps.getGovernor,
    graph: deps.graph || null, factionNames: factionNamesOf(deps.adapter || null), maxEnded: deps.maxEnded,
    config: deps.config || null });
  const r = call(() => views.registerView(VIEW_ID, def), null);
  if (r && r.ok) return r;
  log(`view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
  return null;
}

module.exports = { VIEW_ID, ROW_KEYS, buildHeavyEventsView, registerHeavyEventsView };
