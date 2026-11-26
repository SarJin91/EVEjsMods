"use strict";

const { STATE_NAMES, STATE, MEMORY_ESTIMATE } = require("./schema");

const FIELDS = Object.freeze(["systemId", "prevId", "destId", "homeId", "shipTypeId", "archetype", "intent", "state",
  "seq", "sinceAt", "dueAt", "flags", "corpId", "groupId", "gen", "career", "xp", "wealth"]);
const EMPTY_SET = Object.freeze(new Set());

function createPilotStore(capacity) {
  const cap = Math.max(0, Math.floor(capacity));
  const n = cap + 1;
  const present = new Uint8Array(n);
  const cols = {
    systemId: new Int32Array(n), prevId: new Int32Array(n), destId: new Int32Array(n), homeId: new Int32Array(n),
    shipTypeId: new Int32Array(n), archetype: new Uint8Array(n), intent: new Uint8Array(n), state: new Uint8Array(n),
    seq: new Float64Array(n), sinceAt: new Float64Array(n), dueAt: new Float64Array(n), flags: new Int32Array(n),
    corpId: new Int32Array(n),
    groupId: new Int32Array(n),
    gen: new Int32Array(n), career: new Uint8Array(n), xp: new Int32Array(n), wealth: new Int32Array(n),
  };
  const bySystem = new Map();
  const stateCounts = new Int32Array(STATE_NAMES.length + 1);
  const dirtyFlag = new Uint8Array(n);
  const dirtyList = [];
  const routes = new Map();
  let size = 0;
  let routeHops = 0;
  const fixedBytes = present.byteLength + dirtyFlag.byteLength + stateCounts.byteLength
    + Object.values(cols).reduce((sum, col) => sum + col.byteLength, 0);

  const hopsOf = (rs) => (rs && rs.route && Number.isSafeInteger(rs.route.length) ? rs.route.length : 0);

  function setRoute(id, rs) {
    routeHops -= hopsOf(routes.get(id));
    if (rs) {
      routeHops += hopsOf(rs);
      return routes.set(id, rs);
    }
    return routes.delete(id);
  }

  function approxBytes() {
    const K = MEMORY_ESTIMATE;
    return fixedBytes + dirtyList.length * K.ROUTE_HOP_BYTES + bySystem.size * K.MAP_ENTRY_BYTES
      + size * K.SET_ENTRY_BYTES + routes.size * K.MAP_ENTRY_BYTES + routeHops * K.ROUTE_HOP_BYTES;
  }

  const inRange = (id) => Number.isInteger(id) && id >= 1 && id <= cap;

  function indexAdd(systemId, id) {
    const set = bySystem.get(systemId);
    if (set) set.add(id);
    else bySystem.set(systemId, new Set([id]));
  }

  function indexRemove(systemId, id) {
    const set = bySystem.get(systemId);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) bySystem.delete(systemId);
  }

  function markDirty(id) {
    if (!present[id] || dirtyFlag[id]) return;
    dirtyFlag[id] = 1;
    dirtyList.push(id);
  }

  function put(row) {
    const id = row.pilotId;
    if (!inRange(id)) return false;
    if (present[id]) {
      indexRemove(cols.systemId[id], id);
      stateCounts[cols.state[id]] -= 1;
    } else {
      present[id] = 1;
      size += 1;
    }
    for (const f of FIELDS) cols[f][id] = row[f];
    indexAdd(row.systemId, id);
    stateCounts[row.state] += 1;
    return true;
  }

  function apply(id, next) {
    if (!present[id]) return false;
    const systemId = next.systemId !== undefined ? next.systemId : cols.systemId[id];
    if (systemId !== cols.systemId[id]) {
      indexRemove(cols.systemId[id], id);
      indexAdd(systemId, id);
    }
    if (next.state !== undefined && next.state !== cols.state[id]) {
      stateCounts[cols.state[id]] -= 1;
      stateCounts[next.state] += 1;
    }
    for (const f of FIELDS) if (next[f] !== undefined) cols[f][id] = next[f];
    markDirty(id);
    return true;
  }

  function setDue(id, dueAt) {
    if (present[id]) cols.dueAt[id] = dueAt;
  }

  function get(id) {
    if (!inRange(id) || !present[id]) return null;
    const p = { pilotId: id };
    for (const f of FIELDS) p[f] = cols[f][id];
    return p;
  }

  function takeDirty(limit) {
    const out = dirtyList.splice(0, Math.max(0, limit));
    for (const id of out) dirtyFlag[id] = 0;
    return out;
  }

  function listIn(systemId, limit) {
    const set = bySystem.get(systemId);
    if (!set) return [];
    return [...set].sort((a, b) => a - b).slice(0, limit);
  }

  function localIdsIn(systemId, limit) {
    const set = bySystem.get(systemId);
    if (!set || !(limit > 0)) return [];
    const out = [];
    for (const id of set) if (cols.state[id] !== STATE.POD) out.push(id);
    out.sort((a, b) => a - b);
    if (out.length > limit) out.length = limit;
    return out;
  }

  function setFlags(id, flags) {
    if (present[id]) cols.flags[id] = flags;
  }

  function idsIn(systemId) {
    return bySystem.get(systemId) || EMPTY_SET;
  }

  function forEachSystem(fn) {
    for (const [systemId, set] of bySystem) fn(systemId, set.size);
  }

  function archetypeCountsIn(systemId, out) {
    const set = bySystem.get(systemId);
    if (set) for (const id of set) out[cols.archetype[id]] += 1;
    return out;
  }

  return Object.freeze({
    capacity: cap,
    put, apply, setDue, get, markDirty, takeDirty, listIn, localIdsIn, setFlags, idsIn, forEachSystem, archetypeCountsIn,
    flagsOf: (id) => (inRange(id) && present[id] ? cols.flags[id] : 0),
    homeOf: (id) => (inRange(id) && present[id] ? cols.homeId[id] : 0),
    corpOf: (id) => (inRange(id) && present[id] ? cols.corpId[id] : 0),
    archetypeOf: (id) => (inRange(id) && present[id] ? cols.archetype[id] : 0),
    setCorp(id, corpId) {
      if (!inRange(id) || !present[id] || cols.corpId[id] === corpId) return false;
      cols.corpId[id] = corpId;
      markDirty(id);
      return true;
    },
    groupOf: (id) => (inRange(id) && present[id] ? cols.groupId[id] : 0),
    setGroup(id, groupId) {
      if (!inRange(id) || !present[id] || cols.groupId[id] === groupId) return false;
      cols.groupId[id] = groupId;
      markDirty(id);
      return true;
    },
    genOf: (id) => (inRange(id) && present[id] ? cols.gen[id] : 0),
    careerOf: (id) => (inRange(id) && present[id] ? cols.career[id] : 0),
    stateOf: (id) => (inRange(id) && present[id] ? cols.state[id] : 0),
    has: (id) => inRange(id) && present[id] === 1,
    countIn: (systemId) => {
      const set = bySystem.get(systemId);
      return set ? set.size : 0;
    },
    dirtyCount: () => dirtyList.length,
    size: () => size,
    stateCount: (code) => stateCounts[code] || 0,
    route: (id) => routes.get(id) || null,
    setRoute,
    approxBytes,
  });
}

module.exports = { createPilotStore, FIELDS };
