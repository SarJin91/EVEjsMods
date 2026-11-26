"use strict";

const STATIC_ID = "galaxy-static";
const STATE_ID = "galaxy-state";
const SYSTEM_CARD_ID = "system-card";
const SYSTEM_INTERIOR_ID = "system-interior";

function keyOf(views, id) {
  const view = views.getView(id);
  if (!view) return { present: false, key: null };
  if (!view.cacheKey) return { present: true, key: null };
  try {
    const k = view.cacheKey();
    return { present: true, key: k === undefined || k === null ? null : String(k) };
  } catch (_err) {
    return { present: true, key: null };
  }
}

function buildGalaxyView(deps) {
  const { views, config } = deps;
  const ui = Object.freeze({ maxLabels: config.galaxyMaxLabels, systemCardRefreshMs: config.systemCardRefreshMs });
  const interior = Object.freeze({ zoom: config.systemInteriorZoom, zoomOutPermille: config.systemInteriorZoomOutPermille,
    pickPx: config.systemInteriorPickPx, refreshMs: config.systemInteriorRefreshMs,
    logBaseMilliAu: config.systemInteriorLogBaseMilliAu, startPx: config.systemInteriorStartPx,
    zoomMax: config.systemInteriorZoomMax, moonRingPermille: config.systemInteriorMoonRingPermille });

  function manifest() {
    const staticPart = keyOf(views, STATIC_ID);
    const statePart = keyOf(views, STATE_ID);
    const layers = (typeof views.listMapLayers === "function" ? views.listMapLayers() : [])
      .map((l) => ({ ...l, key: keyOf(views, l.id).key }));
    const out = { available: staticPart.present, staticKey: staticPart.key, stateKey: statePart.key,
      stateAvailable: statePart.present, layers,
      ui: { ...ui, systemCard: views.getView(SYSTEM_CARD_ID) !== null,
        systemInterior: views.getView(SYSTEM_INTERIOR_ID) ? { ...interior } : null } };
    if (!staticPart.present) out.reason = "GRAPH_UNAVAILABLE";
    return out;
  }

  function cacheKey() {
    const m = manifest();
    return JSON.stringify([m.available, m.staticKey, m.stateAvailable, m.stateKey,
      m.layers.map((l) => [l.id, l.kind, l.order, l.key]), m.ui.systemCard, m.ui.systemInterior !== null]);
  }

  return { title: "Galaxy map", order: 25, getData: manifest, cacheKey };
}

module.exports = { STATIC_ID, STATE_ID, buildGalaxyView };
