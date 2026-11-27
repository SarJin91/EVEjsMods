"use strict";

const assert = require("node:assert");
const path = require("node:path");

const DATA = require("../../lib/economy/data/commodities");
const { createCommodityCatalog } = require("../../lib/economy/extraction/catalog");
const { systemYield } = require("../../lib/economy/extraction/yield");
const { TIER_WEIGHTS } = require("../../lib/economy/extraction/data/tierWeights");
const { createExtractionService } = require("../../lib/economy/extraction/extractionService");
const { startExtraction } = require("../../lib/economy/extraction/index");
const S = require("../../lib/economy/extraction/schema");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const CATALOG = createCommodityCatalog(DATA).catalog;
const P0S = Object.keys(DATA.P1_OF_P0).map(Number).sort((a, b) => a - b);
const PLANET_TYPE = 11;
const PERIOD = 21600000;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const F1 = 500001;
const F2 = 500002;
const F3 = 500003;
const CHAIN = Array.from({ length: 12 }, (_, i) => 1001 + i);

function makeConfig(over = {}) {
  return { extraction: { ...BASE.extraction, enabled: true, ...over }, stations: { ...BASE.stations },
    modules: BASE.modules };
}

function fakeGraph() {
  const neighbors = (id) => CHAIN.filter((x) => Math.abs(x - id) === 1);
  return {
    getNeighbors: neighbors,
    getSystem: (id) => (CHAIN.includes(id) ? { systemId: id, name: `S${id}`, secClass: "nullsec" } : null),
    findRoute(from, to, c) {
      if (!CHAIN.includes(from) || !CHAIN.includes(to)) return { ok: false, reason: "UNKNOWN_SYSTEM" };
      const jumps = Math.abs(from - to);
      if (c && Number.isSafeInteger(c.maxJumps) && jumps > c.maxJumps) return { ok: false, reason: "TOO_FAR" };
      return { ok: true, jumps };
    },
  };
}

const celestialsOf = (id) => ({ moons: [id * 100 + 1, id * 100 + 2], planets: [{ planetId: id * 10 + 1, typeId: PLANET_TYPE }] });

function fakeAdapter(calls) {
  return {
    readSystemCelestials(ids, opts) {
      calls.push(opts && opts.maxSystems);
      return { ok: true, systems: new Map(ids.map((id) => [id, celestialsOf(id)])), truncated: false };
    },
    readPlanetResources: (types) => ({ ok: true, byType: new Map(types.map((t) => [t, P0S])) }),
  };
}

function expectedYield(systemId, factor = 1000) {
  const y = systemYield({ systemId, secClass: "nullsec", ...celestialsOf(systemId) }, CATALOG,
    { p0ByPlanetType: new Map([[PLANET_TYPE, P0S]]) }, { maxMoonsPerSystem: BASE.extraction.maxMoonsPerSystem,
      maxPlanetsPerSystem: BASE.extraction.maxPlanetsPerSystem,
      moonPortionsPerMoonPerPeriod: BASE.extraction.moonPortionsPerMoonPerPeriod,
      piP1UnitsPerPlanetPerPeriod: BASE.extraction.piP1UnitsPerPlanetPerPeriod,
      bandPermille: { highsec: 500, lowsec: 800, nullsec: BASE.extraction.nullsecYieldPermille },
      tierWeights: TIER_WEIGHTS });
  const out = [];
  for (const [kind, bag] of [["moon", y.moon], ["pi", y.pi]]) {
    for (const [key, v] of Object.entries(bag)) {
      const n = factor === 1000 ? v : Math.floor((v * factor) / 1000);
      if (n > 0) out.push([kind, key, n]);
    }
  }
  return out;
}

function sumStock(lists) {
  const m = new Map();
  for (const list of lists) for (const [k, key, n] of list) m.set(`${k}|${key}`, (m.get(`${k}|${key}`) || 0) + n);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => [...k.split("|"), n]);
}

module.exports = ({ test, skip }) => {
  const { loadDriver, withStore } = require("../notices/storeHelper");
  const driver = loadDriver();
  if (!driver.ok) {
    for (const id of ["EP1", "EP2", "EP3", "EP4", "EP5", "EP6"]) skip(`${id} extraction service`, `driver (${driver.detail})`);
    return;
  }
  const { createJournal } = require("../../lib/persistence/journal");
  const { createStationRepository } = require("../../lib/stations/stationRepository");
  const { createRepairLocator } = require("../../lib/stations/repairLocator");
  const { HULL_GROUPS } = require("../../lib/fleets/schema");

  function rig(store, spec) {
    const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 16384, maxRows: 500 });
    const limits = { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: spec.maxStockItems || 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 };
    const repo = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS, limits });
    const graph = fakeGraph();
    const locator = createRepairLocator({ repository: repo, getGraph: () => graph, getMode: () => "ready",
      limits: { repairSearchMaxJumps: 20, repairSearchMaxSystems: 200, repairMaxCandidates: 4 },
      repairNodesOf: spec.repairNodesOf });
    const created = store.transaction("ep.seed", (tx) => {
      for (const [stationId, [f, systemId]] of Object.entries(spec.stations || {})) {
        const r = repo.createStation(tx, { stationId, kind: "upwell", structureFamily: "astrahus", systemId,
          ownerFactionId: f, ownerCorporationId: 1000101, origin: "seed", at: T0 }, `ep:${stationId}`);
        assert.ok(r.ok, JSON.stringify(r));
      }
      return { ok: true };
    });
    assert.ok(created.ok, JSON.stringify(created));
    const controlled = spec.controlled;
    const world = {
      listControlledByFaction(tx, f, opts) {
        const all = (controlled[f] || []).slice().sort((a, b) => a.systemId - b.systemId);
        const systems = all.slice(0, opts.limit);
        return { ok: true, systems, nextAfterSystemId: all.length > opts.limit ? systems[systems.length - 1].systemId
          : null };
      },
    };
    const calls = [];
    const h = { journal, repo, graph, locator, calls, stockRepo: repo };
    h.make = (config, extra = {}) => createExtractionService({ store, journal, scheduler: { enqueue: () => ({ ok: true }) },
      clock: { now: () => T0 }, config, catalog: CATALOG, tierWeights: TIER_WEIGHTS, adapter: fakeAdapter(calls),
      rowsCap: extra.rowsCap || 498, nowMs: () => 0,
      getRegistry: () => ({ listActiveFactions: () => Object.keys(controlled).map((f) => ({ factionId: Number(f) })) }),
      getWorld: () => world,
      getStations: () => extra.stations || ({ getMode: () => "ready", locator, repository: extra.repository || h.stockRepo }),
      getGraph: () => graph });
    h.pulse = (svc, at) => {
      const res = svc.pulseHandler({}, { now: at, anchorAt: at });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      const r = store.transaction("ep.pulse", (tx) => res.effect(tx));
      assert.ok(r.ok && r.value && r.value.ok, JSON.stringify(r));
      res.onCommitted(r.value);
      return r.value;
    };
    h.stock = (stationId) => {
      const r = store.transaction("ep.stock", (tx) => repo.getStock(tx, stationId));
      return r.value.items.map((i) => [i.itemKind, i.itemKey, i.quantity]);
    };
    h.marked = (f, at) => {
      const r = store.transaction("ep.marker", (tx) => journal.findByKey(tx, S.markerKey(f, Math.floor(at / PERIOD))));
      return r.value.found === true;
    };
    return h;
  }

  test("EP1 happy path: 2 systems (station + 2 jumps away) -> moon/pi in the stock, marker, maxSystems from config", () => {
    withStore(driver, ({ store }) => {
      const h = rig(store, { stations: { "st-a": [F1, 1001] },
        controlled: { [F1]: [{ systemId: 1001, occupierFactionId: null }, { systemId: 1003, occupierFactionId: null }] } });
      const svc = h.make(makeConfig());
      const v = h.pulse(svc, T0 + 1000);
      assert.deepStrictEqual(v.cycles.map((c) => c.factionId), [F1]);
      const stock = h.stock("st-a");
      assert.deepStrictEqual(stock, sumStock([expectedYield(1001), expectedYield(1003)]));
      assert.ok(stock.some((r) => r[0] === "moon") && stock.some((r) => r[0] === "pi"), JSON.stringify(stock));
      assert.strictEqual(h.marked(F1, T0 + 1000), true);
      assert.deepStrictEqual(h.calls, [BASE.extraction.maxSystemsPerFaction]);
      const st = svc.getStatus();
      assert.strictEqual(st.counters.factionsMarked, 1);
      assert.strictEqual(st.counters.systemsYielding, 2);
      assert.strictEqual(st.lastCycleByFaction[0].factionId, F1);
    });
  });

  test("EP2 idempotency: same bucket and restart change nothing; forced refusal rolls back, next pulse delivers", () => {
    withStore(driver, ({ store }) => {
      const h = rig(store, { stations: { "st-a": [F1, 1001] },
        controlled: { [F1]: [{ systemId: 1001, occupierFactionId: null }] } });
      let refuseOnce = true;
      const flaky = Object.assign({ ...h.repo }, { applyStockChange(tx, change) {
        if (refuseOnce) {
          refuseOnce = false;
          return { ok: false, reason: "VERSION_CONFLICT" };
        }
        return h.repo.applyStockChange(tx, change);
      } });
      const svc = h.make(makeConfig(), { repository: flaky });
      const v1 = h.pulse(svc, T0 + 1000);
      assert.strictEqual(v1.tally.refused, 1);
      assert.strictEqual(h.marked(F1, T0 + 1000), false);
      assert.deepStrictEqual(h.stock("st-a"), []);
      h.pulse(svc, T0 + 301000);
      const once = h.stock("st-a");
      assert.deepStrictEqual(once, sumStock([expectedYield(1001)]));
      assert.strictEqual(h.marked(F1, T0 + 1000), true);
      const again = h.pulse(svc, T0 + 601000);
      assert.deepStrictEqual(again.cycles, []);
      const restarted = h.make(makeConfig());
      const v3 = h.pulse(restarted, T0 + 901000);
      assert.deepStrictEqual(v3.cycles, []);
      assert.deepStrictEqual(h.stock("st-a"), once);
      h.pulse(restarted, T0 + PERIOD + 1000);
      assert.deepStrictEqual(h.stock("st-a"), sumStock([expectedYield(1001), expectedYield(1001)]));
    });
  });

  test("EP3 claim x claimedYieldPermille, a system out of maxDeliveryJumps -> lostNoStation", () => {
    withStore(driver, ({ store }) => {
      const h = rig(store, { stations: { "st-a": [F1, 1001] },
        controlled: { [F1]: [{ systemId: 1001, occupierFactionId: null }, { systemId: 1002, occupierFactionId: F2 },
          { systemId: 1010, occupierFactionId: null }] } });
      const svc = h.make(makeConfig());
      const v = h.pulse(svc, T0 + 1000);
      assert.deepStrictEqual(h.stock("st-a"), sumStock([expectedYield(1001), expectedYield(1002, 500)]));
      const far = expectedYield(1010).reduce((n, r) => n + r[2], 0);
      assert.ok(far > 0);
      assert.strictEqual(v.tally.lostNoStation, far);
      assert.strictEqual(v.tally.claimedSystems, 1);
      assert.strictEqual(svc.getStatus().counters.lostNoStation, far);
      assert.strictEqual(v.cycles[0].lostUnits, far);
    });
  });

  test("EP4 flag off: no handler, no event; STOCK_ITEMS_LIMIT = lost yield and a marker", () => {
    let registered = 0;
    let enqueued = 0;
    const scheduler = { getStatus: () => ({ state: "ready" }), registerHandler: () => { registered += 1; return { ok: true }; },
      enqueue: () => { enqueued += 1; return { ok: true }; } };
    const off = startExtraction({ config: makeConfig({ enabled: false }),
      persistence: { ok: true, store: {}, journal: {} }, clock: { now: () => T0 }, scheduler,
      world: { repository: { listControlledByFaction() {} } } });
    assert.deepStrictEqual(off, { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual([registered, enqueued], [0, 0]);
    withStore(driver, ({ store }) => {
      const h = rig(store, { stations: { "st-a": [F1, 1001] }, maxStockItems: 1,
        controlled: { [F1]: [{ systemId: 1001, occupierFactionId: null }] } });
      const svc = h.make(makeConfig());
      const v = h.pulse(svc, T0 + 1000);
      const units = expectedYield(1001).reduce((n, r) => n + r[2], 0);
      assert.ok(expectedYield(1001).length > 1);
      assert.strictEqual(v.tally.lostStockFull, units);
      assert.deepStrictEqual(h.stock("st-a"), []);
      assert.strictEqual(h.marked(F1, T0 + 1000), true);
    });
  });

  test("EP5 budgets: maxFactionsPerPulse and maxRowsPerPulse keep the order, a deferred faction comes next pulse", () => {
    withStore(driver, ({ store }) => {
      const spec = { stations: { "st-a": [F1, 1001], "st-b": [F2, 1005], "st-c": [F3, 1009] },
        controlled: { [F1]: [{ systemId: 1001, occupierFactionId: null }],
          [F2]: [{ systemId: 1005, occupierFactionId: null }], [F3]: [{ systemId: 1009, occupierFactionId: null }] } };
      const h = rig(store, spec);
      const svc = h.make(makeConfig({ maxFactionsPerPulse: 2 }));
      assert.deepStrictEqual(h.pulse(svc, T0 + 1000).cycles.map((c) => c.factionId), [F1, F2]);
      assert.strictEqual(h.marked(F3, T0 + 1000), false);
      assert.deepStrictEqual(h.pulse(svc, T0 + 301000).cycles.map((c) => c.factionId), [F3]);
      const bound = (systemId) => S.factionRowBound([expectedYield(systemId).length]);
      const tight = h.make(makeConfig(), { rowsCap: bound(1001) + bound(1005) - 1 });
      const at = T0 + PERIOD + 1000;
      const p1 = h.pulse(tight, at);
      assert.deepStrictEqual(p1.cycles.map((c) => c.factionId), [F1]);
      assert.strictEqual(p1.tally.rowsDeferred, 1);
      assert.strictEqual(h.marked(F2, at), false);
      assert.deepStrictEqual(h.pulse(tight, at + 300000).cycles.map((c) => c.factionId)[0], F2);
      assert.strictEqual(h.marked(F2, at), true);
      assert.strictEqual(tight.getStatus().counters.rowsDeferred >= 1, true);
    });
  });

  test("EP6: refusal does not block, its rows count; station past a hive node in range; no findRoute", () => {
    withStore(driver, ({ store }) => {
      const spec = { stations: { "st-a": [F1, 1004], "st-c": [F2, 1007], "st-b2": [F2, 1005], "st-b1": [F2, 1005] },
        repairNodesOf: (tx, f) => ({ ok: true, systems: new Set(f === F1 ? [1002] : []) }),
        controlled: { [F1]: [{ systemId: 1001, occupierFactionId: null }],
          [F2]: [{ systemId: 1006, occupierFactionId: null }] } };
      const h = rig(store, spec);
      let routeCalls = 0;
      h.graph.findRoute = () => {
        routeCalls += 1;
        return { ok: false, reason: "ROUTE_FAILED" };
      };
      const v = h.pulse(h.make(makeConfig()), T0 + 1000);
      assert.deepStrictEqual(v.cycles.map((c) => c.factionId), [F1, F2]);
      assert.deepStrictEqual(h.stock("st-a"), sumStock([expectedYield(1001)]));
      assert.deepStrictEqual(h.stock("st-b1"), sumStock([expectedYield(1006)]));
      assert.deepStrictEqual([h.stock("st-b2"), h.stock("st-c")], [[], []]);
      assert.strictEqual(v.tally.lostNoStation, 0);
      assert.strictEqual(routeCalls, 0);
      const flaky = Object.assign({ ...h.repo }, { applyStockChange(tx, change) {
        if (change.stationId === "st-a") return { ok: false, reason: "VERSION_CONFLICT" };
        return h.repo.applyStockChange(tx, change);
      } });
      const at = T0 + PERIOD + 1000;
      const wide = h.pulse(h.make(makeConfig(), { repository: flaky }), at);
      assert.strictEqual(wide.tally.refused, 1);
      assert.deepStrictEqual(wide.cycles.map((c) => c.factionId), [F2]);
      assert.strictEqual(h.marked(F1, at), false);
      const bound = (systemId) => S.factionRowBound([expectedYield(systemId).length]);
      const at2 = T0 + 2 * PERIOD + 1000;
      const tight = h.pulse(h.make(makeConfig(), { repository: flaky, rowsCap: bound(1001) + bound(1006) - 1 }), at2);
      assert.strictEqual(tight.tally.refused, 1);
      assert.strictEqual(tight.tally.rowsDeferred, 1);
      assert.deepStrictEqual(tight.cycles, []);
      assert.strictEqual(routeCalls, 0);
    });
    withStore(driver, ({ store }) => {
      const h = rig(store, { stations: { "st-e": [F3, 1011], "st-d": [F3, 1009] },
        controlled: { [F3]: [1006, 1010, 1012].map((systemId) => ({ systemId, occupierFactionId: null })) } });
      let neighbourCalls = 0;
      const plain = h.graph.getNeighbors;
      h.graph.getNeighbors = (id) => {
        neighbourCalls += 1;
        return plain(id);
      };
      const svc = h.make(makeConfig({ maxDeliveryJumps: 1 }), { stations: { getMode: () => "ready", repository: h.repo } });
      assert.strictEqual(svc.getMode(), "ready");
      const v = h.pulse(svc, T0 + 1000);
      assert.deepStrictEqual(h.stock("st-d"), sumStock([expectedYield(1010)]));
      assert.deepStrictEqual(h.stock("st-e"), sumStock([expectedYield(1012)]));
      assert.strictEqual(v.tally.lostNoStation, expectedYield(1006).reduce((n, r) => n + r[2], 0));
      assert.strictEqual(neighbourCalls, 2);
    });
  });
};
