"use strict";

const { defaultAmmoOfType } = require("../adapter/data/sentryTypes");

const VIEW_ID = "sentries";
const SYSTEM_VIEW_ID = "sentries-system";
const SYSTEM_PARAM = "system";
const VIEW_ORDER = 57;
const WORK_CLASS = "MAINTENANCE";
const PERMILLE = 1000;
const ROW_KEYS = Object.freeze(["sentryId", "systemId", "system", "ownerKind", "owner", "state", "anchor", "hpPermille",
  "ammo", "ammoCapacity"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildSentriesViews(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function" || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function systemName(id) {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(() => deps.graph.getGraph(), null) : null;
    const vertex = res && res.ok === true && res.graph ? call(() => res.graph.getSystem(id), null) : null;
    return vertex && typeof vertex.name === "string" ? vertex.name : null;
  }

  function vendorOf(seam, row, corpNames) {
    const out = { hpPermille: null, ammo: null, ammoCapacity: null, owner: null };
    if (row.ownerKind === "faction") out.owner = names.get(row.factionId) || null;
    else if (seam && typeof seam.readCorporationName === "function") {
      if (!corpNames.has(row.ownerCorpId)) {
        const r = call(() => seam.readCorporationName(row.ownerCorpId), null);
        corpNames.set(row.ownerCorpId, r && r.ok === true ? r.name : null);
      }
      out.owner = corpNames.get(row.ownerCorpId);
    }
    if (row.state !== "ACTIVE" || !isId(row.itemId) || !seam) return out;
    const item = typeof seam.readSentryItem === "function" ? call(() => seam.readSentryItem(row.itemId), null) : null;
    if (item && item.ok === true && isId(item.item.hpMax) && Number.isSafeInteger(item.item.hp)) {
      out.hpPermille = Math.round((item.item.hp * PERMILLE) / item.item.hpMax);
    }
    const ammo = defaultAmmoOfType(row.typeId);
    if (ammo && typeof seam.readAmmo === "function") {
      const a = call(() => seam.readAmmo(row.itemId, ammo.typeId), null);
      if (a && a.ok === true) {
        out.ammo = a.units;
        out.ammoCapacity = a.capacityUnits;
      }
    }
    return out;
  }

  function getData(systemId) {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.sentries", (db) => {
      const counts = repository.countLiveBySystem(db, maxRows);
      if (!counts.ok) return counts;
      const live = repository.listLive(db, { limit: maxRows, systemId });
      if (!live.ok) return live;
      return { ok: true, counts, live };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const seam = typeof deps.getSeam === "function" ? call(deps.getSeam, null) : null;
    const corpNames = new Map();
    const rows = read.live.sentries.map((row) => {
      const v = vendorOf(seam, row, corpNames);
      return { sentryId: row.sentryId, systemId: row.systemId, system: systemName(row.systemId), ownerKind: row.ownerKind,
        owner: v.owner === null ? (row.ownerKind === "faction" ? row.factionId : row.ownerCorpId) : v.owner,
        state: row.state, anchor: `${row.anchorKind}:${row.anchorId}`, hpPermille: v.hpPermille, ammo: v.ammo,
        ammoCapacity: v.ammoCapacity };
    });
    const systems = read.counts.systems.filter((s) => systemId === null || s.systemId === systemId)
      .map((s) => ({ systemId: s.systemId, system: systemName(s.systemId), live: s.count }));
    return { available: true, systemId, systems, systemsTruncated: read.counts.truncated, sentries: rows,
      truncated: read.live.truncated };
  }

  return {
    sentries: { title: "Sentries", order: VIEW_ORDER, getData: () => getData(null) },
    system: { title: "Sentries of a system", listed: false, param: SYSTEM_PARAM,
      getData: (req) => getData(req && isId(req.param) ? req.param : null) },
  };
}

module.exports = { VIEW_ID, SYSTEM_VIEW_ID, ROW_KEYS, buildSentriesViews };
