"use strict";

const { effectivePool } = require("./wreckPool");

const LAYER_ID = "layer-wrecks";
const LAYER_ORDER = 12;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyWrecksMs";
const MS_DECIMALS = 10;
const MS_PER_HOUR = 3600000;
const SHAPE = "triangle";

const WRECK_STYLES = Object.freeze([
  Object.freeze({ styleId: "wrecks-small", label: "small wreck field", colour: "#8a7a5c", scale: 0.8 }),
  Object.freeze({ styleId: "wrecks-medium", label: "medium wreck field", colour: "#c89b3c", scale: 1 }),
  Object.freeze({ styleId: "wrecks-large", label: "large wreck field", colour: "#ffcc33", scale: 1.4 }),
]);
const LEGEND = Object.freeze(WRECK_STYLES.map((s) => Object.freeze([s.styleId, s.label, s.colour, SHAPE, s.scale])));

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function tierOf(total, medium, large) {
  if (total >= large) return 2;
  if (total >= medium) return 1;
  return 0;
}

function buildWrecksLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxFields = int(deps.maxFields, 1);
  const maxSystems = int(deps.maxSystems, 0);
  const maxLines = int(deps.maxLines, 0);
  const refreshMs = int(deps.refreshMs, 1);
  const medium = int(deps.tierMediumUnits, 1);
  const large = int(deps.tierLargeUnits, 1);
  const fieldTtlMs = Number.isSafeInteger(deps.fieldTtlMs) && deps.fieldTtlMs > 0 ? deps.fieldTtlMs : null;

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(GALAXY_WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function observe(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_BUILD_MS, Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    } catch (_err) {
    }
  }

  const keyAt = (now) => `k${Math.floor(now / refreshMs)}`;

  function fieldLine(f, pool, now) {
    const hours = Math.max(0, Math.ceil((f.expiresAt - now) / MS_PER_HOUR));
    const anomaly = f.materializedAt !== null && f.materializedAt !== undefined;
    const npc = !anomaly && ((Number(f.salvagedSalvageUnits) || 0) + (Number(f.salvagedLootUnits) || 0)) > 0;
    return `battle ${f.battleId === null ? f.fieldId : f.battleId} · ${f.outcome === null ? "-" : f.outcome} · `
      + `${f.shipsLost} ships lost · winner ${f.winnerFactionId === null ? "-" : f.winnerFactionId} · `
      + `left ${pool.salvage}/${pool.loot}${npc ? " · salvaged by NPC" : ""}${anomaly ? " · in space (anomaly)" : ""} · `
      + `expires in ${hours} h`;
  }

  function endedNote(db, now) {
    if (fieldTtlMs === null || typeof repository.countEndedSince !== "function") return "";
    try {
      const r = repository.countEndedSince(db, { since: now - fieldTtlMs });
      if (!r || !r.ok || !r.byReason) return "";
      const parts = Object.keys(r.byReason).filter((k) => r.byReason[k] > 0).sort()
        .map((k) => `${k} ${r.byReason[k]}`);
      return parts.length > 0 ? ` · recent ended: ${parts.join(" · ")}` : "";
    } catch (_err) {
      return "";
    }
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    if (maxSystems === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: "0 wreck fields (layer limit 0)" };
    }
    const t0 = nowMs();
    let ended = "";
    const tx = store.transaction("observer.galaxyWrecks", (db) => {
      const listed = repository.listActive(db, { at: now, limit: maxFields });
      if (listed && listed.ok) ended = endedNote(db, now);
      return listed;
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    const bySystem = new Map();
    let emptied = 0;
    for (const f of read.fields) {
      const pool = effectivePool(f, now);
      if (pool.expired) continue;
      if (pool.total === 0) {
        emptied += 1;
        continue;
      }
      let sys = bySystem.get(f.systemId);
      if (!sys) {
        sys = { systemId: f.systemId, salvage: 0, loot: 0, total: 0, fields: [] };
        bySystem.set(f.systemId, sys);
      }
      sys.salvage += pool.salvage;
      sys.loot += pool.loot;
      sys.total += pool.total;
      sys.fields.push({ f, pool });
    }
    const built = [...bySystem.values()];
    let fields = 0;
    for (const s of built) fields += s.fields.length;
    built.sort((a, b) => b.total - a.total || a.systemId - b.systemId);
    const truncated = built.length > maxSystems;
    const items = built.slice(0, maxSystems).map((s) => {
      const style = WRECK_STYLES[tierOf(s.total, medium, large)];
      const newest = [...s.fields].sort(({ f: a }, { f: b }) => b.createdAt - a.createdAt
        || (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0));
      const lines = [`${s.fields.length} fields · salvage ${s.salvage} · loot ${s.loot} (decayed)`];
      for (const e of newest.slice(0, maxLines)) lines.push(fieldLine(e.f, e.pool, now));
      const more = s.fields.length - Math.min(maxLines, s.fields.length);
      if (more > 0) lines.push(`+${more} more`);
      return [s.systemId, style.styleId, String(s.total), lines];
    });
    observe(nowMs() - t0);
    const note = `${fields} wreck fields in ${built.length} systems (label = effective salvage + loot units)`;
    const hidden = emptied > 0 ? ` · ${emptied} emptied fields hidden` : "";
    return { available: true, key: keyAt(now), legend, items,
      note: `${truncated || read.truncated ? `${note} (truncated)` : note}${hidden}${ended}` };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Wreck fields", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey,
    getData };
}

module.exports = { LAYER_ID, LEGEND, WRECK_STYLES, buildWrecksLayerView };
