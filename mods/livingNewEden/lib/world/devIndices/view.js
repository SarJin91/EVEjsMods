"use strict";

const R = require("./rules");
const S = require("./schema");

const MINUTE_MS = 60000;
const STYLE = Object.freeze({ mil: "dev-mil", ind: "dev-ind", trade: "dev-trade" });
const LEGEND = Object.freeze([
  Object.freeze([STYLE.mil, "development: military", "#ff6060", "ring"]),
  Object.freeze([STYLE.ind, "development: industry", "#ffb000", "ring"]),
  Object.freeze([STYLE.trade, "development: trade", "#40d040", "ring"]),
]);
const LABEL = Object.freeze({ mil: "MIL", ind: "IND", trade: "TRADE" });

const trendMark = (t) => (t > 0 ? "+" : t < 0 ? "-" : "");

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function levelLine(row, now, P) {
  const trend = R.trendOf(row, now, P);
  return S.KINDS.map((k) => `${LABEL[k]} ${R.levelOf(row[k], P)}${trendMark(trend[k])}`).join(" ");
}

function layerItemsOf(rows, now, P) {
  const picked = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const levels = S.KINDS.map((k) => R.levelOf(row[k], P));
    const top = Math.max(...levels);
    if (top < P.layerMinLevel) continue;
    const kind = S.KINDS[levels.indexOf(top)];
    picked.push({ row, top, kind });
  }
  picked.sort((a, b) => b.top - a.top || a.row.systemId - b.row.systemId);
  return picked.slice(0, P.layerMaxItems).sort((a, b) => a.row.systemId - b.row.systemId)
    .map((p) => [p.row.systemId, STYLE[p.kind], String(p.top), [levelLine(p.row, now, P)], null]);
}

function keyOf(memory, clock) {
  return `d${memory.version()}:${Math.floor(clock.now() / MINUTE_MS)}`;
}

function buildDevLayer(deps) {
  const { memory, settings: P, clock } = deps;
  function getData() {
    if (!memory.isWarm()) return { available: false, reason: "WARMING" };
    const now = clock.now();
    const items = layerItemsOf(memory.decayedRows(now), now, P);
    return { available: true, key: keyOf(memory, clock), legend: LEGEND.map((l) => [...l]), items,
      note: `${items.length} systems at level ${P.layerMinLevel}+` };
  }
  return { title: "Development indices", listed: false, mapLayer: { kind: "marks", order: S.LAYER_ORDER },
    cacheKey: () => keyOf(memory, clock), getData };
}

function buildDevPanel(deps) {
  const { memory, settings: P, clock } = deps;
  const nameOf = (id) => {
    const n = typeof deps.systemNameOf === "function" ? call(() => deps.systemNameOf(id), null) : null;
    return typeof n === "string" && n !== "" ? n : null;
  };
  function getData() {
    const status = call(deps.getStatus, null);
    if (!memory.isWarm()) return { available: false, reason: "WARMING", status };
    const top = {};
    for (const kind of S.KINDS) {
      top[kind] = memory.listTop(kind, { minLevel: 1, limit: P.panelTopRows })
        .map((t) => ({ ...t, system: nameOf(t.systemId) }));
    }
    return { available: true, status, top, cursors: status && status.cursors ? status.cursors : [],
      generatedAt: clock.now() };
  }
  return { title: "Development indices", order: S.VIEW_ORDER, listed: true, cacheKey: () => keyOf(memory, clock),
    getData };
}

module.exports = { VIEW_ID: S.VIEW_ID, LAYER_ID: S.LAYER_ID, LEGEND, STYLE, layerItemsOf, levelLine, buildDevLayer,
  buildDevPanel };
