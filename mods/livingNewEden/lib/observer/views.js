"use strict";

const VIEW_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const VIEW_PARAM_RE = /^[a-z][a-zA-Z0-9]{0,15}$/;

function validMapLayer(layer) {
  return layer !== null && typeof layer === "object" && typeof layer.kind === "string"
    && VIEW_ID_RE.test(layer.kind) && Number.isFinite(layer.order);
}

const MAX_OPT_PARAMS = 3;

function validOptParams(def) {
  const list = def.optParams;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_OPT_PARAMS || def.listed !== false) return false;
  if (!list.every((n) => typeof n === "string" && VIEW_PARAM_RE.test(n) && n !== def.param)) return false;
  return new Set(list).size === list.length;
}

function createViewRegistry() {
  const views = new Map();
  let added = 0;

  function registerView(id, def) {
    if (typeof id !== "string" || !VIEW_ID_RE.test(id)) return { ok: false, reason: "VIEW_ID_INVALID" };
    if (!def || typeof def !== "object" || typeof def.title !== "string" || def.title === ""
      || typeof def.getData !== "function"
      || (def.cacheKey !== undefined && typeof def.cacheKey !== "function")
      || (def.order !== undefined && !Number.isFinite(def.order))
      || (def.listed !== undefined && typeof def.listed !== "boolean")
      || (def.mapLayer !== undefined && (!validMapLayer(def.mapLayer) || def.listed !== false))
      || (def.param !== undefined && (typeof def.param !== "string" || !VIEW_PARAM_RE.test(def.param)
        || def.listed !== false))
      || (def.optParams !== undefined && !validOptParams(def))) {
      return { ok: false, reason: "VIEW_DEF_INVALID" };
    }
    if (views.has(id)) return { ok: false, reason: "VIEW_EXISTS" };
    const mapLayer = def.mapLayer === undefined ? null
      : Object.freeze({ kind: def.mapLayer.kind, order: def.mapLayer.order });
    const entry = Object.freeze({
      id, title: def.title, getData: def.getData, cacheKey: def.cacheKey || null,
      order: def.order === undefined ? null : def.order, listed: def.listed !== false, mapLayer, seq: added,
      param: def.param === undefined ? null : def.param,
      optParams: def.optParams === undefined ? null : Object.freeze([...def.optParams]),
    });
    added += 1;
    views.set(id, entry);
    return {
      ok: true,
      unregister() {
        if (views.get(id) === entry) views.delete(id);
      },
    };
  }

  function getView(id) {
    const entry = views.get(id);
    if (!entry) return null;
    return { id: entry.id, title: entry.title, getData: entry.getData, cacheKey: entry.cacheKey, order: entry.order,
      listed: entry.listed, mapLayer: entry.mapLayer, param: entry.param, optParams: entry.optParams };
  }

  function listViews() {
    const rank = (e) => (e.order === null ? e.seq : e.order);
    return [...views.values()]
      .filter((e) => e.listed)
      .sort((a, b) => rank(a) - rank(b) || a.seq - b.seq)
      .map((e) => ({ id: e.id, title: e.title }));
  }

  function listMapLayers() {
    return [...views.values()]
      .filter((e) => e.mapLayer !== null)
      .sort((a, b) => a.mapLayer.order - b.mapLayer.order || a.seq - b.seq)
      .map((e) => ({ id: e.id, title: e.title, kind: e.mapLayer.kind, order: e.mapLayer.order }));
  }

  return Object.freeze({ registerView, getView, listViews, listMapLayers });
}

module.exports = { VIEW_ID_RE, createViewRegistry };
