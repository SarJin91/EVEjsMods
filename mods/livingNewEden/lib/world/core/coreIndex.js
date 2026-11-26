"use strict";

const STATION_ID_RE = /^(npc|upw)-[0-9-]+$/;
const CLAIM_STATES = Object.freeze(["RECON", "CONTESTED", "INVASION"]);
const CORE_PROTECTED = "CORE_PROTECTED";
const CORE_VIOLATION_KINDS = Object.freeze(["FOREIGN_CONTROLLER", "NO_CONTROLLER", "FOREIGN_CLAIM",
  "HOME_MISMATCH", "STATION_LOST", "STATION_MISSING"]);

function buildCoreIndex(cores, opts) {
  if (!opts || opts.enabled !== true) {
    return Object.freeze({
      version: opts?.version ?? 1,
      enabled: false,
      systems: new Map(),
      stations: new Map(),
      byFaction: new Map(),
      issues: [],
    });
  }

  const issues = [];
  const systems = new Map();
  const stations = new Map();
  const byFaction = new Map();
  const seenFactionIds = new Set();
  const seenSystemIds = new Set();
  const seenStationIds = new Set();

  for (const c of cores || []) {
    if (!Number.isSafeInteger(c.factionId) || c.factionId <= 0) {
      issues.push(`core:${c.factionId}: invalid factionId`);
      continue;
    }
    if (seenFactionIds.has(c.factionId)) {
      issues.push(`core:${c.factionId}: duplicate factionId`);
      continue;
    }

    if (!Array.isArray(c.systemIds) || c.systemIds.length < 1 || c.systemIds.length > opts.maxSystems) {
      issues.push(`core:${c.factionId}: systemIds length must be 1..${opts.maxSystems}`);
      continue;
    }
    let sysBad = false;
    for (const sid of c.systemIds) {
      if (!Number.isSafeInteger(sid) || sid <= 0) {
        issues.push(`core:${c.factionId}: invalid systemId ${sid}`);
        sysBad = true;
        break;
      }
      if (seenSystemIds.has(sid)) {
        issues.push(`core:${c.factionId}: duplicate systemId ${sid} (already used by another core)`);
        sysBad = true;
        break;
      }
    }
    if (sysBad) continue;

    if (c.stationId !== null) {
      if (typeof c.stationId !== "string" || !STATION_ID_RE.test(c.stationId)) {
        issues.push(`core:${c.factionId}: stationId does not match pattern`);
        continue;
      }
      if (seenStationIds.has(c.stationId)) {
        issues.push(`core:${c.factionId}: duplicate stationId ${c.stationId}`);
        continue;
      }
    }

    seenFactionIds.add(c.factionId);
    for (const sid of c.systemIds) {
      systems.set(sid, c.factionId);
      seenSystemIds.add(sid);
    }
    if (c.stationId !== null) {
      stations.set(c.stationId, c.factionId);
      seenStationIds.add(c.stationId);
    }
    byFaction.set(c.factionId, { systemIds: Object.freeze([...c.systemIds]), stationId: c.stationId });
  }

  return Object.freeze({
    version: opts.version,
    enabled: true,
    systems: Object.freeze(systems),
    stations: Object.freeze(stations),
    byFaction: Object.freeze(byFaction),
    issues: Object.freeze(issues),
  });
}

function coreOwnerOf(index, systemId) {
  if (!index || !index.enabled) return null;
  return index.systems.get(systemId) ?? null;
}

function isCoreStation(index, stationId) {
  if (!index || !index.enabled) return false;
  return index.stations.has(stationId);
}

function coreSystemIds(index) {
  if (!index || !index.enabled) return [];
  const ids = [];
  for (const core of index.byFaction.values()) ids.push(...core.systemIds);
  return ids.sort((a, b) => a - b);
}

function coreStationIds(index) {
  if (!index || !index.enabled) return [];
  return [...index.stations.keys()].sort();
}

function auditCores(index, rows, stations) {
  if (!index || !index.enabled) {
    return { ok: true, violations: [], outOfScope: [], heldByFaction: new Map(), protectedSystems: 0 };
  }

  const violations = [];
  const outOfScope = [];
  const heldByFaction = new Map();

  const bySystem = new Map();
  for (const r of rows || []) {
    bySystem.set(r.systemId, r);
  }

  const byStation = new Map();
  if (stations) {
    for (const s of stations) {
      byStation.set(s.stationId, s);
    }
  }

  for (const [factionId, core] of index.byFaction) {
    let held = 0;
    for (const sysId of core.systemIds) {
      const row = bySystem.get(sysId);
      if (!row) {
        outOfScope.push(sysId);
        continue;
      }
      const owner = factionId;
      const ctrl = row.controllerFactionId ?? null;
      const occ = row.occupierFactionId ?? null;
      const state = row.occupationState;
      const home = row.homeFactionId;

      if (ctrl !== null && ctrl !== owner) {
        violations.push({ factionId: owner, ref: sysId, kind: "FOREIGN_CONTROLLER" });
      }
      else if (ctrl === null) {
        violations.push({ factionId: owner, ref: sysId, kind: "NO_CONTROLLER" });
      }
      if (CLAIM_STATES.includes(state) && occ !== null && occ !== owner) {
        violations.push({ factionId: owner, ref: sysId, kind: "FOREIGN_CLAIM" });
      }
      if (home !== undefined && home !== owner) {
        violations.push({ factionId: owner, ref: sysId, kind: "HOME_MISMATCH" });
      }

      if (ctrl === owner) held += 1;
    }

    if (core.stationId !== null && Array.isArray(stations)) {
      const st = byStation.get(core.stationId);
      if (!st) {
        violations.push({ factionId: factionId, ref: core.stationId, kind: "STATION_MISSING" });
      } else if (st.ownerFactionId !== factionId || st.state === "DESTROYED") {
        violations.push({ factionId: factionId, ref: core.stationId, kind: "STATION_LOST" });
      }
    }

    if (held > 0) heldByFaction.set(factionId, held);
  }

  return Object.freeze({
    ok: true,
    violations: Object.freeze(violations),
    outOfScope: Object.freeze(outOfScope),
    heldByFaction: Object.freeze(heldByFaction),
    protectedSystems: index.systems.size,
  });
}

module.exports = {
  buildCoreIndex,
  coreOwnerOf,
  isCoreStation,
  coreSystemIds,
  coreStationIds,
  auditCores,
  CORE_PROTECTED,
  CORE_VIOLATION_KINDS,
  CLAIM_STATES,
};