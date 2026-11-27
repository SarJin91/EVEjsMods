"use strict";

const assert = require("node:assert");
const path = require("node:path");

const DATA = require("../../lib/economy/data/commodities");
const { createCommodityCatalog } = require("../../lib/economy/extraction/catalog");
const { TIER_WEIGHTS } = require("../../lib/economy/extraction/data/tierWeights");
const { createExtractionService } = require("../../lib/economy/extraction/extractionService");
const { planTransfers } = require("../../lib/economy/extraction/demand");
const XS = require("../../lib/economy/extraction/schema");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { CLASSES } = require("../../lib/retention/classes");
const { planCommodityBuys } = require("../../lib/strategy/ai/tradeCommodities");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const CATALOG = createCommodityCatalog(DATA).catalog;
const PERIOD = BASE.extraction.periodMs;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const B0 = Math.floor((T0 + 1000) / PERIOD);
const F1 = 500001;
const CHAIN = Array.from({ length: 6 }, (_, i) => 1001 + i);

function cfgOf({ x = {}, p = {}, st = {} } = {}) {
  return { extraction: { ...BASE.extraction, enabled: true, ...x },
    production: { ...BASE.production, linesPerUpwellStation: 2, ...p }, stations: { ...BASE.stations, ...st },
    modules: BASE.modules };
}

function graphOf(calls = { neighbors: 0 }) {
  return { calls, getNeighbors: (id) => {
    calls.neighbors += 1;
    return CHAIN.filter((x) => Math.abs(x - id) === 1);
  }, getSystem: (id) => (CHAIN.includes(id) ? { systemId: id, secClass: "nullsec" } : null) };
}
const adapter = { readSystemCelestials: (ids) => ({ ok: true, systems: new Map(ids.map((id) => [id,
  { moons: [], planets: [] }])) }), readPlanetResources: (t) => ({ ok: true, byType: new Map(t.map((x) => [x, []])) }) };

const LOW1_UPWELL = [["pi", "type:9848", 2], ["pi", "type:3689", 10], ["pi", "type:9836", 10], ["pi", "type:44", 6],
  ["pi", "type:3683", 33], ["pi", "type:9832", 14]];
const DONOR = [["pi", "type:44", 100], ["pi", "type:3689", 100], ["pi", "type:9832", 100]];

module.exports = ({ test, skip }) => {
  test("UT1 planTransfers (order, fuel first, maxTypes, maxPairs, rotate, no donor) + keys, bound, config W203/W213", () => {
    const recipients = [
      { stationId: "up-2", donorId: "npc-d", short: new Map([[9848, 4], [3683, 7]]) },
      { stationId: "up-1", donorId: "npc-d", short: new Map([[2393, 5], [9848, 4]]) },
      { stationId: "up-3", donorId: null, short: new Map([[44, 3]]) },
    ];
    const surplus = new Map([["npc-d", new Map([[2393, 5], [9848, 6], [3683, 100]])]]);
    const before = JSON.stringify([...surplus].map(([k, m]) => [k, [...m]]));
    const run = (o) => planTransfers({ recipients, surplus, fuelTypes: new Set([9848]), maxPairs: 4, maxTypes: 8,
      rotate: 0, ...o });
    const g = (pairs) => pairs.map((p) => [p.src, p.dst, p.gives.map((x) => [x.typeId, x.units])]);
    const rest = (r) => r.rest.map((x) => [x.stationId, x.donorId, x.typeId, x.units]);
    const a = run({});
    assert.deepStrictEqual(g(a.pairs), [["npc-d", "up-1", [[9848, 4], [2393, 5]]], ["npc-d", "up-2", [[9848, 2],
      [3683, 7]]]]);
    assert.deepStrictEqual(rest(a), [["up-2", "npc-d", 9848, 2], ["up-3", null, 44, 3]]);
    assert.deepStrictEqual([a.noDonor, a.truncated, a.typesTruncated], [1, 0, 0]);
    const t1 = run({ maxTypes: 1 });
    assert.deepStrictEqual(g(t1.pairs), [["npc-d", "up-1", [[9848, 4]]], ["npc-d", "up-2", [[9848, 2]]]]);
    assert.deepStrictEqual([t1.typesTruncated, rest(t1)], [2, [["up-1", "npc-d", 2393, 5], ["up-2", "npc-d", 3683, 7],
      ["up-2", "npc-d", 9848, 2], ["up-3", null, 44, 3]]]);
    const p1 = run({ maxPairs: 1 });
    assert.deepStrictEqual([g(p1.pairs), p1.truncated, rest(p1)], [[["npc-d", "up-1", [[9848, 4], [2393, 5]]]], 1,
      [["up-2", "npc-d", 3683, 7], ["up-2", "npc-d", 9848, 4], ["up-3", null, 44, 3]]]);
    const r1 = run({ rotate: 4 });
    assert.deepStrictEqual(g(r1.pairs), [["npc-d", "up-2", [[9848, 4], [3683, 7]]], ["npc-d", "up-1", [[9848, 2],
      [2393, 5]]]]);
    assert.strictEqual(JSON.stringify([...surplus].map(([k, m]) => [k, [...m]])), before, "surplus not changed");
    assert.strictEqual(XS.transferKey("npc-a", "up-b", 12, "out"), "xfer:npc-a:up-b:12:out");
    assert.strictEqual(XS.transferRowBound({ pairs: 4, types: 8 }), 80);

    const env = (e) => resolveConfig({ modDir: MOD_DIR, env: e });
    const X = BASE.extraction;
    assert.deepStrictEqual([X.upwellTransferEnabled, X.maxTransfersPerFaction, X.maxTransferTypesPerPair], [false, 4, 8]);
    const count = (e, id) => env(e).warnings.filter((w) => w.includes(`(${id})`)).length;
    const on = { EVEJS_LNE_EXTRACTION_ENABLED: "1", EVEJS_LNE_EXTRACTION_UPWELL_TRANSFER_ENABLED: "1" };
    const fuel = { ...on, EVEJS_LNE_EXTRACTION_FUEL_ENABLED: "1" };
    assert.deepStrictEqual([count(fuel, "W203"), count({ ...fuel, EVEJS_LNE_EXTRACTION_MAX_TRANSFERS_PER_FACTION: "64",
      EVEJS_LNE_EXTRACTION_MAX_TRANSFER_TYPES_PER_PAIR: "64" }, "W203")], [0, 1]);
    assert.deepStrictEqual([count(on, "W213"), count(fuel, "W213"),
      count({ EVEJS_LNE_EXTRACTION_UPWELL_TRANSFER_ENABLED: "1", EVEJS_LNE_EXTRACTION_FUEL_ENABLED: "1" }, "W213"),
      count({ EVEJS_LNE_EXTRACTION_ENABLED: "1", EVEJS_LNE_EXTRACTION_FUEL_ENABLED: "1" }, "W213")], [1, 0, 1, 0]);
  });

  const { loadDriver, withStore } = require("../notices/storeHelper");
  const driver = loadDriver();
  if (!driver.ok) {
    for (const id of ["UT2", "UT3", "UT4", "UT5"]) skip(`${id} moon/PI transfer`, `driver (${driver.detail})`);
    return;
  }
  const { createJournal } = require("../../lib/persistence/journal");
  const { createStationRepository } = require("../../lib/stations/stationRepository");

  function rig(store, cfg, stations, opts = {}) {
    const clock = { now: () => T0 + 1000 };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const repo = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
      limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
        maxStockItemsPerStation: opts.itemsLimit || 256, maxStockQuantity: 1000000000000,
        maxDeltasPerChange: cfg.stations.maxDeltasPerChange } });
    const h = { journal, repo, graph: graphOf() };
    h.tx = (fn) => {
      const r = store.transaction("ut", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    let npc = 60000000;
    h.tx((tx) => {
      for (const [stationId, [kind, systemId]] of Object.entries(stations)) {
        npc += 1;
        const spec = kind === "npc" ? { stationId, kind, npcStationId: npc, systemId }
          : { stationId, kind, structureFamily: "astrahus", systemId };
        const r = repo.createStation(tx, { ...spec, ownerFactionId: F1, ownerCorporationId: 1000101, origin: "seed",
          at: T0 }, `ut:${stationId}`);
        assert.ok(r.ok, JSON.stringify(r));
      }
      return { ok: true };
    });
    let seeds = 0;
    h.seed = (stationId, rows) => h.tx((tx) => {
      seeds += 1;
      const r = repo.applyStockChange(tx, { stationId, key: `ut:seed:${seeds}`, reason: "TEST", at: T0,
        deltas: rows.map(([itemKind, itemKey, delta]) => ({ itemKind, itemKey, delta })) });
      assert.ok(r.ok, JSON.stringify(r));
      return { ok: true };
    });
    h.stock = (stationId) => new Map(h.tx((tx) => repo.getStock(tx, stationId)).items
      .map((i) => [i.itemKey, i.quantity]));
    h.found = (key) => h.tx((tx) => journal.findByKey(tx, key)).found === true;
    h.keys = (like) => h.tx((tx) => tx.prepare("SELECT idempotency_key AS k FROM world_event_journal WHERE "
      + "idempotency_key LIKE ? ORDER BY journal_id").all(like).map((r) => r.k));
    h.dump = () => h.tx((tx) => tx.prepare("SELECT idempotency_key, aggregate_type, aggregate_id, event_type, payload "
      + "FROM world_event_journal WHERE idempotency_key NOT LIKE 'ut:%' ORDER BY journal_id").all());
    h.extraction = (c, extra = {}) => createExtractionService({ store, journal, scheduler: { enqueue: () => ({ ok: true }) },
      clock, config: c, catalog: CATALOG, tierWeights: TIER_WEIGHTS, adapter, rowsCap: extra.rowsCap || 998,
      nowMs: () => 0, getRegistry: () => ({ listActiveFactions: () => [{ factionId: F1 }] }),
      getWorld: () => ({ listControlledByFaction: () => ({ ok: true, systems: [], nextAfterSystemId: null }) }),
      getStations: () => ({ getMode: () => "ready", repository: repo }), getGraph: () => extra.graph || h.graph,
      getProduction: extra.getProduction });
    h.pulse = (svc, at) => {
      const res = svc.pulseHandler({}, { now: at, anchorAt: at });
      const r = store.transaction("ut.pulse", (tx) => {
        const before = tx.prepare("SELECT total_changes() AS n").get().n;
        const v = res.effect(tx);
        v.rows = tx.prepare("SELECT total_changes() AS n").get().n - before;
        return v;
      });
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      res.onCommitted(r.value);
      return r.value;
    };
    h.needs = (svc) => h.tx((tx) => {
      const before = tx.prepare("SELECT total_changes() AS n").get().n;
      const r = svc.readNeeds(tx, F1);
      assert.strictEqual(tx.prepare("SELECT total_changes() AS n").get().n, before, "readNeeds writes nothing");
      return r;
    });
    return h;
  }

  const TWO = { "npc-a": ["npc", 1001], "up-b": ["upwell", 1002] };
  const low1 = (store, c, opts) => {
    const h = rig(store, c, TWO, opts);
    h.seed("npc-a", DONOR);
    h.seed("up-b", LOW1_UPWELL);
    return h;
  };

  test("UT2 pulse: pass B -> transfer -> fuel closes (flag off = unfueled), second pulse and restart = no-op", () => {
    const c = cfgOf({ x: { fuelEnabled: true, upwellTransferEnabled: true } });
    withStore(driver, ({ store }) => {
      const h = low1(store, c);
      const svc = h.extraction(c);
      const v = h.pulse(svc, T0 + 1000);
      assert.deepStrictEqual([v.tally.conversions, v.tally.transfers, v.tally.transferUnits, v.tally.fuelBurned,
        v.tally.unfueled, v.tally.transfersRefused, v.tally.transferNoDonor], [1, 1, 84, 1, 0, 0, 0]);
      assert.deepStrictEqual(h.keys("pic:%").concat(h.keys("xfer:%"), h.keys("fuel:%")),
        [XS.conversionKey("up-b", B0, 9848), XS.transferKey("npc-a", "up-b", B0, "out"),
          XS.transferKey("npc-a", "up-b", B0, "in"), XS.fuelKey("up-b", B0)]);
      assert.deepStrictEqual(h.dump().map((r) => r.idempotency_key).filter((k) => /^(pic|xfer|fuel):/.test(k)),
        [XS.conversionKey("up-b", B0, 9848), XS.transferKey("npc-a", "up-b", B0, "out"),
          XS.transferKey("npc-a", "up-b", B0, "in"), XS.fuelKey("up-b", B0)]);
      const upB = new Map([["type:3689", 18], ["type:44", 18], ["type:9832", 42], ["type:9848", 3]]);
      const npcA = new Map([["type:3689", 76], ["type:44", 82], ["type:9832", 58]]);
      assert.deepStrictEqual([h.stock("up-b"), h.stock("npc-a")], [upB, npcA]);
      const marker = h.tx((tx) => h.journal.findByKey(tx, XS.markerKey(F1, B0))).entry.payload;
      assert.deepStrictEqual([marker.transfers, marker.fuelled, marker.conversions], [1, 1, 1]);
      assert.strictEqual(svc.getStatus().counters.transfers, 1);
      assert.deepStrictEqual(h.pulse(svc, T0 + 301000).cycles, []);
      assert.deepStrictEqual(h.pulse(h.extraction(c), T0 + 601000).cycles, []);
      assert.deepStrictEqual([h.stock("up-b"), h.stock("npc-a")], [upB, npcA]);
    });
    withStore(driver, ({ store }) => {
      const off = cfgOf({ x: { fuelEnabled: true } });
      const h = low1(store, off);
      const v = h.pulse(h.extraction(off), T0 + 1000);
      assert.deepStrictEqual([v.tally.conversions, v.tally.fuelBurned, v.tally.unfueled, v.tally.transfers], [1, 0, 1, 0]);
      assert.deepStrictEqual(h.keys("xfer:%"), []);
    });
  });

  test("UT3 refusals: STOCK_ITEMS_LIMIT on in rolls the pair back, no donor in range; rows <= bound + transfer", () => {
    const c = cfgOf({ x: { fuelEnabled: true, upwellTransferEnabled: true } });
    withStore(driver, ({ store }) => {
      const h = rig(store, c, TWO, { itemsLimit: 2 });
      h.seed("npc-a", [["pi", "type:44", 100], ["pi", "type:3689", 100]]);
      h.seed("up-b", [["pi", "type:9832", 1]]);
      const v = h.pulse(h.extraction(c), T0 + 1000);
      assert.deepStrictEqual([v.tally.transfers, v.tally.transfersRefused, v.tally.unfueled, v.cycles.length],
        [0, 1, 1, 1]);
      assert.deepStrictEqual(h.keys("xfer:%"), []);
      assert.deepStrictEqual(h.stock("npc-a"), new Map([["type:3689", 100], ["type:44", 100]]));
      assert.strictEqual(h.found(XS.markerKey(F1, B0)), true);
    });
    withStore(driver, ({ store }) => {
      const far = cfgOf({ x: { fuelEnabled: true, upwellTransferEnabled: true, maxDeliveryJumps: 0 } });
      const h = rig(store, far, { "npc-a": ["npc", 1001], "up-b": ["upwell", 1003] });
      h.seed("npc-a", DONOR);
      const v = h.pulse(h.extraction(far), T0 + 1000);
      assert.deepStrictEqual([v.tally.transferNoDonor, v.tally.transfers, v.cycles.length], [1, 0, 1]);
      assert.deepStrictEqual(h.keys("xfer:%"), []);
    });
    withStore(driver, ({ store }) => {
      const h = low1(store, c);
      const fuelTypes = CATALOG.fuelPerPeriod(c.extraction.fuelBlocksPerUpwellPerPeriod).length;
      const sub3 = XS.factionRowBound([]) + XS.demandRowBound({ conversions: c.extraction.maxConversionsPerFaction,
        maxSchematicDeltas: CATALOG.maxSchematicDeltas, fuelStations: 1, fuelTypes });
      const bound = sub3 + XS.transferRowBound({ pairs: 1, types: Math.min(c.extraction.maxTransferTypesPerPair,
        c.stations.maxDeltasPerChange) });
      const over = h.pulse(h.extraction(c, { rowsCap: bound - 1 }), T0 + 1000);
      assert.deepStrictEqual([over.cycles.length, over.tally.refused, over.refusal],
        [0, 1, `${F1}:ROWS_OVER_BUDGET ${bound}>${bound - 1}`]);
      const fits = h.pulse(h.extraction(c, { rowsCap: bound }), T0 + 1000);
      assert.deepStrictEqual([fits.cycles.length, fits.tally.transfers], [1, 1]);
      assert.ok(fits.rows <= bound, `${fits.rows} > ${bound}`);
    });
  });

  test("UT4 readNeeds: Upwell short -> NPC donor need (viaTransfer, merged), reserve + gives, shortKeys, buy on donor", () => {
    const stations = { "npc-a": ["npc", 1001], "up-b": ["upwell", 1002], "up-c": ["upwell", 1006] };
    const x = { fuelEnabled: true, maxDeliveryJumps: 2, advancedReserveGroups: "frigate", maxNeedsPerFaction: 256 };
    const off = cfgOf({ x, p: { linesPerUpwellStation: 0 } });
    const on = cfgOf({ x: { ...x, upwellTransferEnabled: true }, p: { linesPerUpwellStation: 0 } });
    const production = () => ({ getAdvanced: () => ({}), activeGroupsByStation: () => ({ ok: true, byStation: new Map() }) });
    withStore(driver, ({ store }) => {
      const h = rig(store, off, stations);
      h.seed("npc-a", [["pi", "type:9832", 100]]);
      const base = h.needs(h.extraction(off, { getProduction: production }));
      const got = h.needs(h.extraction(on, { getProduction: production }));
      assert.ok(base.ok && got.ok, JSON.stringify([base, got]));
      const find = (r, s, t) => r.needs.find((n) => n.stationId === s && n.typeId === t);
      const reserveOf = (r, s, t) => (r.stations.find((st) => st.stationId === s).reserve
        .find((e) => e.typeId === t) || { units: 0 }).units;
      const own44 = find(base, "npc-a", 44);
      const up44 = find(base, "up-b", 44);
      assert.ok(own44 && up44 && own44.kind === "npc" && up44.kind === "upwell", JSON.stringify(base.needs));
      assert.deepStrictEqual(find(got, "npc-a", 44), { stationId: "npc-a", kind: "npc", itemKind: "pi", typeId: 44,
        need: own44.need + up44.need, viaTransfer: up44.need });
      assert.strictEqual(got.needs.filter((n) => n.stationId === "npc-a" && n.typeId === 44).length, 1);
      const up9832 = find(base, "up-b", 9832).need;
      const gross9832 = reserveOf(base, "npc-a", 9832);
      assert.ok(100 - gross9832 >= up9832, `${gross9832} / ${up9832}`);
      assert.deepStrictEqual([find(got, "npc-a", 9832), find(got, "up-b", 9832)], [undefined, undefined]);
      assert.strictEqual(reserveOf(got, "npc-a", 9832), gross9832 + up9832);
      assert.deepStrictEqual(got.needs.filter((n) => n.stationId === "up-b"), []);
      assert.deepStrictEqual(got.needs.filter((n) => n.stationId === "up-c"),
        base.needs.filter((n) => n.stationId === "up-c"));
      assert.ok(got.shortKeys.includes("npc-a|type:44") && !got.shortKeys.some((k) => k.startsWith("up-b|")));
      assert.deepStrictEqual(got.shortKeys, [...got.shortKeys].sort());

      const mapped = got.needs.map((n) => ({ stationId: n.stationId, kind: n.kind, itemKind: n.itemKind,
        itemKey: `type:${n.typeId}`, typeId: n.typeId, need: n.need }));
      const T = { maxOffersPerReview: 50, commodityOffersPerReview: 50, maxOpenOffersPerFaction: 50,
        maxOpenOffersPerStation: 50, wtsStationSlotHeadroom: 0, maxIskPerOffer: 1e12, maxQuantityPerOffer: 1e9,
        minIskPerOffer: 1, offerTtlMs: 1000, targetOpenContracts: 0 };
      const plan = (needs) => {
        const out = { intents: [], notes: [] };
        planCommodityBuys({ trade: { commodity: { needs, kinds: { "type:44": "pi" }, quotes: { "type:44": { ok: true,
          unitMilli: 1000, refMilli: 1000, capMilli: 2000, source: "test" } } }, stations: [{ stationId: "npc-a",
          kind: "npc", systemId: 1001, ownerCorporationId: 1000101 }], open: [] }, T, at: T0, newOffers: [],
        state: { offersCreated: 0, openFactionCount: 0, budgetLeft: 1e12, openPerStation: new Map() },
        intents: out.intents, notes: out.notes });
        return out;
      };
      const bought = plan(mapped.filter((n) => n.stationId !== "up-c"));
      assert.deepStrictEqual(bought.intents.map((o) => [o.stationId, o.itemKey, o.quantity]),
        [["npc-a", "type:44", own44.need + up44.need]]);
      assert.ok(!bought.notes.some((n) => n.startsWith("TRADE_COMMODITY_UPWELL")), JSON.stringify(bought.notes));
      assert.ok(got.needs.filter((n) => n.stationId === "up-c").length >= 2, JSON.stringify(got.needs));
      assert.strictEqual(got.noDonorStations, 1);
      const all = plan(mapped);
      assert.ok(all.notes.includes("TRADE_COMMODITY_UPWELL:1"), JSON.stringify(all.notes));
      assert.strictEqual(base.noDonorStations, 2);
      const cut = cfgOf({ x: { ...x, maxNeedsPerFaction: 1 }, p: { linesPerUpwellStation: 0 } });
      const one = h.needs(h.extraction(cut, { getProduction: production }));
      assert.deepStrictEqual([one.needs.length, one.truncated, one.noDonorStations], [1, true, 2]);
    });
  });

  test("UT5 flag off bit for bit (no key vs false: journal, stocks, readNeeds, 0 getNeighbors) + retention xfer:", () => {
    const { upwellTransferEnabled: _a, maxTransfersPerFaction: _b, maxTransferTypesPerPair: _c, ...noKey } =
      cfgOf({ x: { fuelEnabled: true } }).extraction;
    const configs = [{ ...cfgOf(), extraction: noKey }, cfgOf({ x: { fuelEnabled: true, upwellTransferEnabled: false } })];
    const runs = configs.map((c) => {
      let out = null;
      withStore(driver, ({ store }) => {
        const h = low1(store, c);
        const v = h.pulse(h.extraction(c), T0 + 1000);
        const calls = { neighbors: 0 };
        const needs = h.needs(h.extraction(c, { graph: graphOf(calls) }));
        out = { journal: h.dump(), stocks: [h.stock("npc-a"), h.stock("up-b")], needs, neighbors: calls.neighbors,
          tally: v.tally };
      });
      return out;
    });
    assert.deepStrictEqual(runs[0], runs[1]);
    assert.ok(runs[0].journal.some((r) => r.idempotency_key === XS.markerKey(F1, B0)));
    assert.deepStrictEqual([runs[0].neighbors, runs[0].tally.transfers, runs[0].tally.unfueled], [0, 0, 1]);
    assert.ok(!runs[0].journal.some((r) => r.idempotency_key.startsWith("xfer:")));
    const marker = JSON.parse(runs[0].journal.find((r) => r.idempotency_key === XS.markerKey(F1, B0)).payload);
    assert.deepStrictEqual(Object.keys(marker).sort(), ["bucket", "conversions", "factionId", "fuelled", "lostUnits",
      "moonUnits", "piUnits", "stations", "systems"], "marker payload as");
    assert.ok(runs[0].needs.needs.length > 0 && runs[0].needs.needs.every((n) => !("viaTransfer" in n)));

    const cls = CLASSES.find((k) => k.id === "journal-extraction-xfer");
    const hit = (key) => CLASSES.filter((k) => key.startsWith(k.prefix) && k.pattern.test(key)).map((k) => k.id);
    assert.deepStrictEqual([hit("xfer:npc-a:up-b:12:out"), hit(XS.transferKey("npc-a", "up-b", 12, "in")),
      hit("xfer:a:b:12:mid")], [["journal-extraction-xfer"], ["journal-extraction-xfer"], []]);
    assert.strictEqual(cls.minAgeOf(BASE), Math.max(BASE.extraction.markerRetentionMs, BASE.extraction.periodMs));
  });
};
