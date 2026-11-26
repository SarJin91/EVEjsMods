"use strict";

const CONSUMER = "gridAnchors";
const UNAVAILABLE = "GRID_ANCHORS_UNAVAILABLE";
const MAX_DETAIL = 200;
const POS_TOWER_GROUP_ID = 365;
const SUN_GROUP_ID = 6;
const ANCHORED = "anchored";
const ONLINE = "online";
const KIND_ORDER = Object.freeze({ gate: 0, station: 1, structure: 2, pos: 3, sun: 4, belt: 5 });

const PATHS = Object.freeze({
  worldData: "space/worldData",
  structures: "services/structure/structureState",
  itemStore: "services/inventory/itemStore",
});
const REQUIRED = Object.freeze({
  worldData: Object.freeze(["getStargatesForSystem", "getStationsForSystem", "getAsteroidBeltsForSystem",
    "getCelestialsForSystem"]),
  structures: Object.freeze(["peekStructuresForSystem"]),
  itemStore: Object.freeze(["listStarbaseItems"]),
});

const isObj = (v) => v !== null && typeof v === "object";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const idOf = (v) => {
  const n = Math.trunc(Number(v));
  return isId(n) ? n : null;
};
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const refuse = (reason, detail) => (detail === undefined ? { ok: false, reason } : { ok: false, reason, detail });
const textOrNull = (v) => (typeof v === "string" && v !== "" ? v : null);

function posOf(row) {
  const p = isObj(row) && isObj(row.position) ? row.position : row;
  if (!isObj(p)) return null;
  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? Object.freeze({ x, y, z }) : null;
}

const rowsOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);

function checkVendor(vendor) {
  if (!isObj(vendor)) return refuse(UNAVAILABLE, "vendor");
  for (const key of Object.keys(PATHS)) {
    const mod = vendor[key];
    if (!isObj(mod) && typeof mod !== "function") return refuse(UNAVAILABLE, PATHS[key]);
    for (const name of REQUIRED[key]) {
      if (typeof mod[name] !== "function") return refuse(UNAVAILABLE, `${PATHS[key]}.${name}`);
    }
  }
  return { ok: true };
}

function readGridAnchorsFrom(vendor, systemId, opts) {
  if (!isId(systemId)) return refuse("INVALID_INPUT", "systemId");
  const max = opts && isId(opts.maxAnchors) ? opts.maxAnchors : 0;
  if (max === 0) return refuse("INVALID_INPUT", "maxAnchors");
  const check = checkVendor(vendor);
  if (!check.ok) return check;
  try {
    const anchors = [];
    const push = (kind, row, extra = {}) => {
      const id = idOf(extra.id !== undefined ? extra.id : row.itemID);
      const position = posOf(row);
      if (id === null || position === null) return;
      anchors.push(Object.freeze({ kind, id, position, toSystemId: extra.toSystemId ?? null,
        lneStationId: extra.lneStationId ?? null, lneSovStructureId: extra.lneSovStructureId ?? null,
        ownerCorpId: extra.ownerCorpId ?? null }));
    };
    const wd = vendor.worldData;
    for (const g of rowsOf(wd.getStargatesForSystem(systemId))) {
      push("gate", g, { toSystemId: idOf(g.destinationSolarSystemID) });
    }
    for (const s of rowsOf(wd.getStationsForSystem(systemId))) {
      push("station", s, { id: s.stationID, ownerCorpId: idOf(s.corporationID) });
    }
    for (const r of rowsOf(vendor.structures.peekStructuresForSystem(systemId, { includeDestroyed: false }))) {
      if (r.destroyedAt) continue;
      const flags = isObj(r.devFlags) ? r.devFlags : {};
      push("structure", r, { id: r.structureID, ownerCorpId: idOf(r.ownerCorpID),
        lneStationId: textOrNull(flags.lneStationId), lneSovStructureId: textOrNull(flags.lneSovStructureId) });
    }
    for (const item of rowsOf(vendor.itemStore.listStarbaseItems({ systemID: systemId, groupID: POS_TOWER_GROUP_ID }))) {
      if (item.groupID !== undefined && Number(item.groupID) !== POS_TOWER_GROUP_ID) continue;
      const st = isObj(item.spaceState) ? item.spaceState : null;
      if (!st || String(st.anchorState || "").toLowerCase() !== ANCHORED
        || String(st.onlineState || "").toLowerCase() !== ONLINE) continue;
      push("pos", st, { id: item.itemID, ownerCorpId: idOf(item.ownerID) });
    }
    for (const c of rowsOf(wd.getCelestialsForSystem(systemId))) {
      if (c.kind === "sun" || Number(c.groupID) === SUN_GROUP_ID) push("sun", c);
    }
    for (const b of rowsOf(wd.getAsteroidBeltsForSystem(systemId))) push("belt", b);
    anchors.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.id - b.id));
    const truncated = anchors.length > max;
    return { ok: true, anchors: truncated ? anchors.slice(0, max) : anchors, truncated };
  } catch (err) {
    return refuse(UNAVAILABLE, detailOf(err));
  }
}

function createGridAnchorSeam(deps) {
  const requireGame = deps && typeof deps.requireGame === "function" ? deps.requireGame : null;
  let vendor = null;
  const load = () => {
    if (vendor !== null) return vendor;
    if (requireGame === null) return null;
    const out = {};
    for (const key of Object.keys(PATHS)) {
      const r = requireGame(PATHS[key]);
      if (!r || r.ok !== true) return null;
      out[key] = r.exports;
    }
    vendor = out;
    return vendor;
  };
  const withVendor = (fn) => {
    try {
      const v = load();
      return v === null ? refuse(UNAVAILABLE, "requireGame") : fn(v);
    } catch (err) {
      return refuse(UNAVAILABLE, detailOf(err));
    }
  };
  return Object.freeze({
    readGridAnchors: (systemId, opts) => withVendor((v) => readGridAnchorsFrom(v, systemId, opts)),
  });
}

module.exports = { CONSUMER, UNAVAILABLE, PATHS, KIND_ORDER, readGridAnchorsFrom, createGridAnchorSeam };
