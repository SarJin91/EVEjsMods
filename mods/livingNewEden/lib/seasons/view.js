"use strict";

const { STATE, VIEW_ID, LAYER_ID, VIEW_ORDER, LAYER_ORDER } = require("./schema");
const { kindLabelOf, isRunningSeason, namerOf } = require("./hint");

const GALAXY_WORK_CLASS = "MAINTENANCE";
const PANEL_TOP = 10;
const PANEL_HISTORY = 10;
const STYLE_CRISIS = "crisis";
const LEGEND = Object.freeze([Object.freeze([STYLE_CRISIS, "season crisis region", "#ff40ff", "hexagon"])]);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function gateOf(deps) {
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const bucketMs = Math.max(1, Math.trunc(Number(deps.settings && deps.settings.bucketMs) || 0));
  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(GALAXY_WORK_CLASS), true) !== false;
  }
  function seasonNow() {
    const cur = call(() => deps.seasons.current(), null);
    return cur && cur.ok === true ? { ok: true, season: cur.season || null } : { ok: false, reason: "SEASON_UNAVAILABLE" };
  }
  const keyOf = (prefix) => (admitted() ? `${prefix}${Math.floor(deps.clock.now() / bucketMs)}` : null);
  return { admitted, seasonNow, keyOf };
}

function layerItemsOf(season, graph, names) {
  if (!isRunningSeason(season) || !graph) return [];
  const n = namerOf(names);
  const items = [];
  for (const regionId of season.regionIds) {
    const systems = call(() => graph.getSystemsInRegion(regionId), null);
    if (!systems || systems.length === 0) continue;
    const anchor = Math.min(...systems);
    items.push([anchor, STYLE_CRISIS, `S${season.seasonNo}`, [`Season ${season.seasonNo}: ${n.faction(season.factionId)}`,
      `${n.region(regionId)} stage ${season.stage + 1}/${season.stageCount}`], null]);
  }
  return items.sort((a, b) => a[0] - b[0]);
}

function buildSeasonLayer(deps) {
  const gate = gateOf(deps);
  function getData() {
    if (!gate.admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const cur = gate.seasonNow();
    if (!cur.ok) return { available: false, reason: cur.reason };
    const s = cur.season;
    const items = layerItemsOf(s, call(deps.getGraph, null), deps.names || null);
    let note = "no running season";
    if (isRunningSeason(s)) {
      note = s.regionIds.length === 0 ? `season ${s.seasonNo}: galaxy-wide crisis`
        : `season ${s.seasonNo}: ${items.length} crisis regions`;
    }
    return { available: true, key: gate.keyOf("l"), legend: LEGEND.map((l) => [...l]), items, note };
  }
  return { title: "Season", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER },
    cacheKey: () => gate.keyOf("l"), getData };
}

function seasonPanelOf(s, names, now) {
  if (!s) return null;
  const n = namerOf(names);
  return { seasonNo: s.seasonNo, state: s.state, crisisKind: s.crisisKind, crisisLabel: kindLabelOf(s.crisisKind),
    faction: Number.isSafeInteger(s.factionId) ? n.faction(s.factionId) : null, factionId: s.factionId,
    regions: s.regionIds.map((regionId) => ({ regionId, name: n.region(regionId) })), stage: s.stage,
    stageCount: s.stageCount, ...(s.state === STATE.PLANNED ? { startsIn: Math.max(0, s.startsAt - now) }
      : { endsIn: Math.max(0, s.endsAt - now) }), meterDefense: s.meterDefense, meterCrisis: s.meterCrisis };
}

function buildSeasonPanel(deps) {
  const gate = gateOf(deps);
  function getData() {
    if (call(() => deps.store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!gate.admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const cur = gate.seasonNow();
    if (!cur.ok) return { available: false, reason: cur.reason };
    const s = cur.season;
    const now = deps.clock.now();
    const open = s && s.state !== STATE.PLANNED ? s.seasonNo : null;
    const tx = deps.store.transaction("observer.seasons", (db) => deps.repo.observerInTx(db, open, PANEL_TOP,
      PANEL_HISTORY));
    const v = tx && tx.ok ? tx.value : tx;
    if (!tx || !tx.ok || !v || !v.ok) return { available: false, reason: String((v && v.reason) || "TX_FAILED") };
    const ids = [...new Set([...v.top.map((r) => r.characterId), ...v.history.map((h) => h.championId)
      .filter((id) => id !== null)])];
    const names = ids.length > 0 && typeof deps.characterNames === "function"
      ? call(() => deps.characterNames(ids), null) : null;
    const nameOf = (id) => {
      const nm = names && typeof names.get === "function" ? names.get(id) : null;
      return typeof nm === "string" && nm !== "" ? nm : String(id);
    };
    const status = typeof deps.getStatus === "function" ? call(deps.getStatus, null) : null;
    return { available: true, season: seasonPanelOf(s, deps.names || null, now),
      top: v.top.map((r) => ({ rank: r.rank, character: nameOf(r.characterId), characterId: r.characterId,
        points: r.points, kills: r.kills, defenses: r.defenses })),
      history: v.history.map((h) => ({ seasonNo: h.seasonNo, outcome: h.outcome, closedAt: h.closedAt,
        champion: h.championId === null ? null : nameOf(h.championId) })),
      rewards: v.rewards, counters: status && status.counters ? status.counters : null, generatedAt: now };
  }
  return { title: "Galactic season", order: VIEW_ORDER, listed: true, cacheKey: () => gate.keyOf("p"), getData };
}

module.exports = { VIEW_ID, LAYER_ID, VIEW_ORDER, LAYER_ORDER, LEGEND, layerItemsOf, buildSeasonLayer,
  buildSeasonPanel };
