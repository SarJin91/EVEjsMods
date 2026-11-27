"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../../../config");
const { createLocalResources } = require("../../../lib/economy/trade/localResources");
const { startTrade, createUnavailableTrade } = require("../../../lib/economy/trade");
const ORE = require("../../../lib/economy/data/oreTypes");
const { createJournal } = require("../../../lib/persistence/journal");
const { createViewRegistry } = require("../../../lib/observer/views");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.join(__dirname, "..", "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const driver = H.loadDriver();

const NEIGHBORS = { 1: [2, 3], 2: [1, 4], 3: [1], 4: [2], 5: [] };
const fakeGraph = { getNeighbors: (id) => NEIGHBORS[id] || null };

function makeRead() {
  const calls = [];
  const ctl = { mode: "ok", drift: [] };
  const ORES = { 1: [1230, 11396], 2: [1228], 3: [17470], 4: [20], 5: [] };
  const read = (ids, families) => {
    calls.push([...ids]);
    if (ctl.mode === "drift") return { ok: false, reason: "LOCAL_RESOURCES_DRIFT", detail: "asteroidData.getBeltsForSystem" };
    if (ctl.mode === "failed") return { ok: false, reason: "LOCAL_RESOURCES_FAILED", detail: "pool:1: boom" };
    assert.ok(families.includes("Veldspar") && families.includes("Dark Ochre"), "families from FAMILY_BY_BASE");
    const systems = new Map();
    for (const id of ids) {
      systems.set(id, { systemId: id, beltCount: (ORES[id] || []).length, poolSource: "ENRICHED",
        ores: (ORES[id] || []).map((typeId) => ({ typeId, name: null })),
        ice: id === 1 ? { typeIds: [16262], names: ["Clear Icicle"] } : { typeIds: [], names: [] },
        anomaly: { tier: "lowsec_0_1_to_0_4", families: id === 1 ? ["Gneiss", "Veldspar"] : [] } });
    }
    return { ok: true, systems, drift: ctl.drift, issues: [] };
  };
  return { read, calls, ctl };
}

function makeService(trade = {}, graph = fakeGraph) {
  const r = makeRead();
  const counts = {};
  const telemetry = { count: (name, n = 1) => { counts[name] = (counts[name] || 0) + n; } };
  const svc = createLocalResources({ readLocalResources: r.read, oreTypes: ORE, getGraph: () => graph,
    config: { trade: { localOreJumps: 1, localResourcesMaxSystemsPerRead: 16, ...trade } }, telemetry,
    logger: { log() {} }, clock: { now: () => 1000 } });
  return { svc, ...r, counts };
}

function fakeStations(records) {
  return {
    whenReady: () => Promise.resolve({ state: "ready" }),
    repository: {
      listLiveStations: (db, opts) => ({ ok: true, records: records.slice(0, opts.limit), truncated: false }),
      listStationsOfFaction: (db, factionId, opts) => {
        assert.deepStrictEqual(opts.states, ["ONLINE", "ARMOR_REINFORCE", "HULL_REINFORCE"]);
        return { ok: true, records: records.filter((s) => s.ownerFactionId === factionId) };
      },
    },
  };
}

function boot(opened, tradeOverrides, read, tag) {
  const shared = H.sharedOf();
  const views = createViewRegistry();
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, contractsEnabled: false, ...tradeOverrides } };
  const stations = fakeStations([{ stationId: "npc-60000001", name: "Station One", systemId: 1, ownerFactionId: F }]);
  const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
    clock: shared.clock, ids: shared.ids, views, adapter: { readLocalResources: read }, logger: { log() {} },
    getStations: () => stations, getGraph: () => ({ getGraph: () => ({ ok: true, graph: fakeGraph }) }) });
  assert.ok(started.ok, JSON.stringify(started));
  assert.strictEqual(started.trade.getMode(), "run-no-contracts");
  const fund = opened.store.transaction("test.fund", (db) => started.trade.fundFromUpkeepInTx(db,
    { factionId: F, units: 1, paidUntilTo: 3600000 }, `ls4:fund:${tag}`));
  assert.ok(fund.ok && fund.value.ok, JSON.stringify(fund));
  return { trade: started.trade, view: views.getView("trade") };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

module.exports = ({ test, skip }) => {
  test("LS3 tiers-2 local resources cache: radius, one read of N, pending, peek, graph null, DRIFT, FAILED, mapping", () => {
    const { svc, calls, counts } = makeService();
    const first = svc.localResourcesFor([1]);
    assert.deepStrictEqual(calls, [[1, 2, 3]], "radius 1: system, then distance, then systemId");
    const v1 = first.get(1);
    assert.strictEqual(v1.graphReady, true);
    assert.strictEqual(v1.pending, false);
    assert.strictEqual(v1.beltCount, 2);
    assert.strictEqual(v1.poolSource, "ENRICHED");
    assert.strictEqual(v1.unknownTypeIds, 1, "Mercoxit 11396 is outside the table");
    assert.deepStrictEqual(v1.ores, [{ baseTypeId: 1230, family: "Veldspar", distance: 0, source: "belt" },
      { baseTypeId: 1228, family: "Scordite", distance: 1, source: "belt" }], "17470 -> base 1230 deduped at distance 0");
    assert.deepStrictEqual(v1.ice, [{ typeId: 16262, name: "Clear Icicle", distance: 0 }]);
    assert.deepStrictEqual(v1.anomaly, { tier: "lowsec_0_1_to_0_4", families: ["Gneiss", "Veldspar"] });
    assert.strictEqual(counts["trade.localResourcesRead"], 3);
    svc.localResourcesFor([1]);
    assert.strictEqual(calls.length, 1);
    const seq = svc.getStatus().seq;
    svc.localResourcesFor([2]);
    assert.deepStrictEqual(calls[1], [4]);
    assert.strictEqual(svc.getStatus().seq, seq + 1);

    const small = makeService({ localResourcesMaxSystemsPerRead: 2 });
    const m = small.svc.localResourcesFor([1, 4]);
    assert.deepStrictEqual(small.calls, [[1, 2]]);
    assert.strictEqual(m.get(1).pending, true, "3 still missing");
    assert.strictEqual(m.get(4).pending, true);
    const peek = small.svc.localResourcesFor([1, 4], { read: false });
    assert.strictEqual(small.calls.length, 1, "peek never calls the adapter");
    assert.strictEqual(peek.get(1).pending, true);
    small.svc.localResourcesFor([1, 4]);
    assert.deepStrictEqual(small.calls[1], [3, 4]);
    assert.strictEqual(small.svc.localResourcesFor([1, 4], { read: false }).get(4).pending, false);
    assert.deepStrictEqual(small.svc.localResourcesFor([0, -1, 1.5]), new Map(), "invalid ids skipped");

    const blind = makeService({}, null);
    const b = blind.svc.localResourcesFor([1]).get(1);
    assert.deepStrictEqual(blind.calls, [[1]]);
    assert.strictEqual(b.graphReady, false);
    assert.deepStrictEqual(b.ores.map((o) => o.distance), [0]);

    const anom = makeService({ localOreIncludeAnomalies: true, localOreJumps: 0 });
    assert.deepStrictEqual(anom.svc.localResourcesFor([1]).get(1).ores, [
      { baseTypeId: 1230, family: "Veldspar", distance: 0, source: "belt" },
      { baseTypeId: 1229, family: "Gneiss", distance: 0, source: "anomaly" }]);

    const f = makeService({ localOreJumps: 0 });
    f.ctl.mode = "failed";
    assert.strictEqual(f.svc.localResourcesFor([1]).get(1).pending, true);
    assert.strictEqual(f.counts["trade.localResourcesFailed"], 1);
    assert.strictEqual(f.svc.getStatus().lastRefusal.reason, "LOCAL_RESOURCES_FAILED");
    f.ctl.mode = "ok";
    f.ctl.drift = ["asteroidService._testing.buildEnrichedSystemOrePool"];
    assert.strictEqual(f.svc.localResourcesFor([1]).get(1).pending, false, "retry after FAILED");
    assert.strictEqual(f.counts["trade.localResourcesDrift"], 1, "RAW fallback counted");
    assert.deepStrictEqual(f.svc.getStatus().drift, ["asteroidService._testing.buildEnrichedSystemOrePool"]);
    f.ctl.mode = "drift";
    assert.strictEqual(f.svc.localResourcesFor([5]), null);
    assert.strictEqual(f.svc.getStatus().state, "drift");
    const before = f.calls.length;
    assert.strictEqual(f.svc.localResourcesFor([1]), null);
    assert.strictEqual(f.calls.length, before, "no call after DRIFT");
    svc.stop();
    assert.strictEqual(svc.localResourcesFor([1]), null);
    assert.strictEqual(svc.warm([1]).reason, "STOPPED");

    assert.strictEqual(createUnavailableTrade("TRADE_OFF").localResourcesFor([1]), null);
  });

  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("LS5: a system that always fails does not block the others; after N failures it is unknown", () => {
    const r = makeRead();
    const read = (ids, families) => {
      if (ids.includes(3)) {
        r.calls.push([...ids]);
        return { ok: false, reason: "LOCAL_RESOURCES_FAILED", detail: "pool:3: boom" };
      }
      return r.read(ids, families);
    };
    const counts = {};
    const lines = [];
    const svc = createLocalResources({ readLocalResources: read, oreTypes: ORE, getGraph: () => fakeGraph,
      config: { trade: { localOreJumps: 1, localResourcesMaxSystemsPerRead: 16, localResourcesMaxFailures: 3 } },
      telemetry: { count: (name, n = 1) => { counts[name] = (counts[name] || 0) + n; } },
      logger: { log: (l) => lines.push(l) }, clock: { now: () => 1000 } });
    const drain = () => svc.localResourcesFor([1, 5]);
    for (let i = 0; i < 7; i += 1) drain();
    assert.deepStrictEqual(r.calls, [[1, 2, 3, 5], [1], [2], [3], [5], [3], [3]], "failed system to the end");
    const v = svc.localResourcesFor([1, 5], { read: false });
    assert.strictEqual(v.get(5).pending, false, "station 5 is not blocked");
    assert.strictEqual(v.get(5).unknown, false);
    assert.strictEqual(v.get(1).pending, false, "station 1 leaves pending after 3 failures");
    assert.strictEqual(v.get(1).unknown, true);
    assert.deepStrictEqual(v.get(1).ores.map((o) => o.baseTypeId), [1230, 1228]);
    assert.deepStrictEqual([svc.getStatus().unreadable, svc.getStatus().suspects], [[3], 0]);
    assert.strictEqual(counts["trade.localResourcesUnreadable"], 1);
    assert.strictEqual(lines.filter((l) => l.includes("system 3 unreadable")).length, 1);
    drain();
    assert.strictEqual(r.calls.length, 7);
    assert.strictEqual(svc.warm([1]).requested, 0);
    const once = makeService({ localOreJumps: 0, localResourcesMaxFailures: 2 });
    once.ctl.mode = "failed";
    once.svc.localResourcesFor([1]);
    once.ctl.mode = "ok";
    assert.deepStrictEqual([once.svc.localResourcesFor([1]).get(1).pending, once.svc.getStatus().unreadable], [false, []]);
    const row = config.SCHEMA.find((x) => x.key === "trade.localResourcesMaxFailures");
    assert.deepStrictEqual([row.default, row.min, row.max], [3, 1, 100]);
    assert.strictEqual(DEFAULTS.trade.localResourcesMaxFailures, 3);
    assert.ok(fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8")
      .includes("# EVEJS_LNE_TRADE_LOCAL_RESOURCES_MAX_FAILURES="));
  });

  needsDriver("LS4 tiers-2 warm-up after stations, panel section local + cacheKey, flag off, config keys", () => H.withStore(
    driver, async (reopen) => {
      const opened = reopen();
      const r = makeRead();
      const { trade, view } = boot(opened, { localResourcesWarmMaxSystems: 2 }, r.read, "warm");
      assert.strictEqual(trade.getStatus().localResources.warm.state, "pending");
      await settle();
      const warm = trade.getStatus().localResources.warm;
      assert.strictEqual(warm.state, "done", JSON.stringify(warm));
      assert.strictEqual(warm.truncated, true);
      assert.deepStrictEqual(r.calls, [[1, 2]]);
      assert.strictEqual(trade.localResourcesFor([1], { read: false }).get(1).pending, true);
      const key1 = view.cacheKey();
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(r.calls[1], [3], "panel read after the tx");
      assert.notStrictEqual(view.cacheKey(), key1, "cacheKey changes after the read");
      const local = data.local;
      assert.strictEqual(local.state, "ready");
      assert.strictEqual(local.graphReady, true);
      assert.strictEqual(local.jumps, 1);
      assert.strictEqual(local.truncated, false);
      assert.deepStrictEqual(Object.keys(local.stations[0]), ["faction", "stationId", "name", "systemId", "beltCount",
        "poolSource", "pending", "unknownTypeIds", "ores", "ice", "anomaly", "oreOffersOpen"]);
      assert.strictEqual(local.stations[0].pending, false);
      assert.deepStrictEqual(local.stations[0].ores.map((o) => o.baseTypeId), [1230, 1228]);
      trade.stop();
      assert.strictEqual(trade.localResourcesFor([1]), null);

      const r0 = makeRead();
      const zero = boot(opened, { localResourcesWarmMaxSystems: 0 }, r0.read, "zero");
      await settle();
      assert.strictEqual(zero.trade.getStatus().localResources.warm.state, "skipped");
      assert.deepStrictEqual(r0.calls, []);
      zero.trade.stop();
      const rOff = makeRead();
      const off = boot(opened, { localResourcesEnabled: false }, rOff.read, "off");
      await settle();
      assert.strictEqual(off.trade.localResourcesFor([1]), null);
      assert.strictEqual(off.view.getData().local.state, "off");
      assert.deepStrictEqual(rOff.calls, []);
      off.trade.stop();

      const keys = { "trade.localResourcesEnabled": [true], "trade.localOreJumps": [1, 0, 3],
        "trade.localResourcesMaxSystemsPerRead": [16, 1, 256], "trade.localResourcesWarmMaxSystems": [2048, 0, 8490],
        "trade.localOreIncludeAnomalies": [false] };
      const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
      for (const [key, [def, min, max]] of Object.entries(keys)) {
        const row = config.SCHEMA.find((x) => x.key === key);
        assert.ok(row, key);
        assert.strictEqual(row.default, def, key);
        if (min !== undefined) assert.deepStrictEqual([row.min, row.max], [min, max], key);
        assert.ok(example.includes(`# ${row.env}=`), row.env);
      }
    }));
};
