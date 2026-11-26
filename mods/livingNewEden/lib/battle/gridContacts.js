"use strict";

const { planContact } = require("./contacts");

const KIND_ANCHOR = "anchor";
const STATION_ONLINE = "ONLINE";
const STATION_DESTROYED = "DESTROYED";
const STATION_KIND_NPC = "npc";
const STATION_KIND_UPWELL = "upwell";

const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function stationAnchorRef(record) {
  if (!record || typeof record !== "object") return null;
  if (record.kind === STATION_KIND_NPC && isPositiveId(record.npcStationId)) return `station:${record.npcStationId}`;
  if (record.kind === STATION_KIND_UPWELL && isPositiveId(record.evejsItemId)) return `structure:${record.evejsItemId}`;
  return null;
}

function gridOfRef(grids) {
  const out = new Map();
  for (const g of Array.isArray(grids) ? grids : []) {
    if (!g || typeof g.gridKey !== "string" || !Array.isArray(g.anchors)) continue;
    for (const a of g.anchors) {
      if (a && typeof a.kind === "string" && isPositiveId(a.id)) out.set(`${a.kind}:${a.id}`, g.gridKey);
    }
  }
  return out;
}

function planGridContact(spec) {
  const fleets = Array.isArray(spec.fleets) ? spec.fleets : [];
  const trigger = typeof spec.triggerFleetId === "string" ? spec.triggerFleetId : null;
  const base = { isHostile: spec.isHostile, cooldowns: spec.cooldowns, at: spec.at, limits: spec.limits,
    evasiveOf: spec.evasiveOf };
  if (!(spec.positions instanceof Map)) {
    const all = planContact({ ...base, fleets, triggerFleetId: trigger });
    return { ...all, gridKey: null, fallback: true, warpSkipped: 0, gridsChecked: 0 };
  }
  const byGrid = new Map();
  let warpSkipped = 0;
  let triggerGrid = null;
  for (const f of fleets) {
    const pos = spec.positions.get(f.fleetId);
    if (!pos || pos.kind !== KIND_ANCHOR || typeof pos.gridKey !== "string") {
      warpSkipped += 1;
      continue;
    }
    if (!byGrid.has(pos.gridKey)) byGrid.set(pos.gridKey, []);
    byGrid.get(pos.gridKey).push(f);
    if (trigger !== null && f.fleetId === trigger) triggerGrid = pos.gridKey;
  }
  const order = [...byGrid.keys()].filter((k) => k !== triggerGrid).sort(byString);
  if (triggerGrid !== null) order.unshift(triggerGrid);
  let tooLarge = false;
  let cooldown = false;
  let gridsChecked = 0;
  for (const gridKey of order) {
    gridsChecked += 1;
    const r = planContact({ ...base, fleets: byGrid.get(gridKey), triggerFleetId: gridKey === triggerGrid ? trigger
      : null });
    if (r.contact) return { ...r, gridKey, fallback: false, warpSkipped, gridsChecked };
    if (r.reason === "TOO_LARGE") tooLarge = true;
    else if (r.reason === "ON_COOLDOWN") cooldown = true;
  }
  const none = (reason) => ({ ok: true, contact: null, reason, gridKey: null, fallback: false, warpSkipped,
    gridsChecked });
  if (tooLarge) return none("TOO_LARGE");
  if (cooldown) return none("ON_COOLDOWN");
  const all = planContact({ ...base, fleets, triggerFleetId: trigger });
  return none(all.contact ? "GRID_APART" : all.reason);
}

function gridGarrisonOf(spec) {
  const gridOf = spec.gridOf instanceof Map ? spec.gridOf : new Map();
  const records = Array.isArray(spec.records) ? spec.records : [];
  const inGrid = (s) => {
    const ref = stationAnchorRef(s);
    const g = ref === null ? undefined : gridOf.get(ref);
    return g === undefined ? spec.gridKey === spec.cpGridKey : g === spec.gridKey;
  };
  let stationA = 0;
  let stationB = 0;
  let ownStationB = false;
  const structureRecords = [];
  for (const s of records) {
    if (!s || typeof s !== "object" || !inGrid(s)) continue;
    structureRecords.push(s);
    if (s.state !== STATION_DESTROYED && s.ownerFactionId === spec.factionB) ownStationB = true;
    if (s.state !== STATION_ONLINE) continue;
    let points = 0;
    try {
      const p = spec.garrisonPoints(s);
      points = Number.isSafeInteger(p) && p > 0 ? p : 0;
    } catch (_err) {
      points = 0;
    }
    if (s.ownerFactionId === spec.factionA) stationA += points;
    else if (s.ownerFactionId === spec.factionB) stationB += points;
  }
  return { stationA, stationB, influenceAllowed: spec.gridKey === spec.cpGridKey || ownStationB, structureRecords };
}

module.exports = { planGridContact, gridGarrisonOf, stationAnchorRef, gridOfRef };
