"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { settingsOf } = require("../../lib/population/schema");
const { buildSystemTable } = require("../../lib/population/context");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");

const BASE = 30000000;
const sid = (n) => BASE + n;
const WH = 31000001;
const STATIONS = new Map([[sid(1), 2], [sid(3), 3], [sid(6), 1], [sid(8), 1], [sid(11), 2], [WH, 1]]);
const HUB = sid(3);

function fakeGraph() {
  const systems = new Map();
  const add = (id, secClass, regionId) => systems.set(id, { id, secClass, regionId });
  for (let i = 1; i <= 6; i += 1) add(sid(i), "highsec", 10);
  for (let i = 7; i <= 9; i += 1) add(sid(i), "lowsec", 20);
  for (let i = 10; i <= 12; i += 1) add(sid(i), "nullsec", 30);
  add(WH, "wormhole", 40);
  const neighbors = (id) => {
    if (!systems.has(id)) return null;
    if (id === WH) return [];
    const n = id - BASE;
    return [n - 1, n + 1].filter((k) => k >= 1 && k <= 12).map(sid);
  };
  let routeCalls = 0;
  const graph = {
    getSystem: (id) => systems.get(id) || null,
    getNeighbors: neighbors,
    getSystemsBySecClass: (c) => [...systems.values()].filter((s) => s.secClass === c).map((s) => s.id),
    getSystemIds: () => [...systems.keys()],
    findRoute(from, to, c) {
      routeCalls += 1;
      if (!systems.has(from) || !systems.has(to)) return { ok: false, reason: "UNKNOWN_SYSTEM" };
      const prev = new Map([[from, null]]);
      let frontier = [from];
      while (frontier.length > 0 && !prev.has(to)) {
        const next = [];
        for (const id of frontier) {
          for (const n of neighbors(id)) {
            if (prev.has(n)) continue;
            prev.set(n, id);
            next.push(n);
          }
        }
        frontier = next;
      }
      if (!prev.has(to)) return { ok: false, reason: "UNREACHABLE" };
      const route = [];
      for (let at = to; at !== null; at = prev.get(at)) route.unshift(at);
      if (c && Number.isInteger(c.maxJumps) && route.length - 1 > c.maxJumps) return { ok: false, reason: "TOO_FAR" };
      return { ok: true, route, jumps: route.length - 1 };
    },
    routeCalls: () => routeCalls,
  };
  return graph;
}

const listStations = (id) => ({ ok: true, stations: new Array(STATIONS.get(id) || 0).fill({ stationId: 1 }) });

let defaultsCache = null;
function populationConfig(overrides = {}) {
  if (!defaultsCache) {
    defaultsCache = {};
    for (const row of config.SCHEMA) {
      if (!row.key.startsWith("population.")) continue;
      const parts = row.key.slice("population.".length).split(".");
      let at = defaultsCache;
      for (const part of parts.slice(0, -1)) at = at[part] || (at[part] = {});
      at[parts[parts.length - 1]] = row.default;
    }
  }
  const { near, observer, live, context, activeLife, standings, corps, groups, hulls, lifecycle, ...rest } = overrides;
  return { ...defaultsCache, hubSystemIds: String(HUB), ...rest, near: { ...defaultsCache.near, ...(near || {}) },
    observer: { ...defaultsCache.observer, ...(observer || {}) }, live: { ...defaultsCache.live, ...(live || {}) },
    context: { ...defaultsCache.context, ...(context || {}) },
    activeLife: { ...defaultsCache.activeLife, ...(activeLife || {}) },
    standings: { ...defaultsCache.standings, ...(standings || {}) },
    corps: { ...defaultsCache.corps, ...(corps || {}) }, groups: { ...defaultsCache.groups, ...(groups || {}) },
    hulls: { ...defaultsCache.hulls, ...(hulls || {}) },
    lifecycle: { ...defaultsCache.lifecycle, ...(lifecycle || {}) } };
}

const settings = (overrides) => settingsOf({ population: populationConfig(overrides) });

function table(S, graph = fakeGraph()) {
  return buildSystemTable({ graph, stationCountOf: (id) => STATIONS.get(id) || 0,
    hubDistance: buildHubDistance(graph, S.hubSystemIds, S.maxHubJumps), S });
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-pop-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  const open = () => {
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return store;
  };
  const reopen = () => {
    if (store) store.close("test_reopen");
    return open();
  };
  return (async () => {
    try {
      seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
      return await fn(open(), reopen);
    } finally {
      if (store) store.close("test_cleanup");
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (_err) {
      }
    }
  })();
}

function dbRows(store) {
  const r = store.transaction("test.read", (tx) => tx.prepare("SELECT * FROM world_npc_pilots ORDER BY pilot_id").all()
    .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]))));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function fakePresence(graph) {
  const calls = { version: 0, observed: 0, within: 0 };
  let live = [];
  let version = 0;
  return {
    calls,
    set(ids) {
      live = [...ids];
      version += 1;
    },
    getVersion() {
      calls.version += 1;
      return version;
    },
    observedSystems() {
      calls.observed += 1;
      return [...live];
    },
    observedWithin(radius) {
      calls.within += 1;
      const map = new Map(live.map((id) => [id, 0]));
      let frontier = [...live];
      for (let d = 1; d <= radius; d += 1) {
        const next = [];
        for (const id of frontier) {
          for (const n of graph.getNeighbors(id) || []) {
            if (map.has(n)) continue;
            map.set(n, d);
            next.push(n);
          }
        }
        frontier = next;
      }
      return { ok: true, systems: [...map].sort((a, b) => a[0] - b[0]) };
    },
  };
}

module.exports = { BASE, sid, WH, HUB, STATIONS, fakeGraph, listStations, populationConfig, settings, table, withStore,
  dbRows, fakePresence };
