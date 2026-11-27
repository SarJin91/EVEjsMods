"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { startStations } = require("../../lib/stations");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeService } = require("../../lib/economy/trade/tradeService");
const TS = require("../../lib/economy/trade/schema");
const STS = require("../../lib/stations/schema");
const { isId } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const { S, FACTION_A, FACTION_B } = H;
const F = FACTION_A;
const CORP = 1000162;
const DAY = 86400000;

const graphService = (graph) => ({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

async function boot(opened, shared, tradeOver = {}) {
  const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } }, stations: DEFAULTS.stations,
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    observer: { ...DEFAULTS.observer, ...H.CONFIG.observer } };
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const registry = { getFaction: (id) => ([FACTION_A, FACTION_B].includes(Number(id))
    ? { factionId: Number(id), startStations: [], doctrineId: "d" } : null),
  listFactions: () => [{ factionId: FACTION_A }], listActiveFactions: () => [{ factionId: FACTION_A }],
  isActive: (id) => [FACTION_A, FACTION_B].includes(Number(id)), getDoctrine: () => ({ templates: {} }) };
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph: graphService(shared.graph),
    clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  await st.stations.whenReady();
  const env = { stockOn: true };
  const budgets = createBudgetRepository({ journal, clock: shared.clock });
  const offers = createOfferRepository({ journal, budgets, ids: shared.ids, clock: shared.clock,
    getStockRepository: () => (env.stockOn ? st.stations.repository : null) });
  const tradeCfg = { ...DEFAULTS.trade, ...tradeOver };
  const service = createTradeService({ budgets, offers, config: { trade: tradeCfg }, clock: shared.clock,
    telemetry: null, logger: { log() {} } });
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, `${JSON.stringify(r)} ${(r.error && r.error.stack) || ""}`);
    return r.value;
  };
  return Object.assign(env, { store: opened.store, journal, stations: st.stations, repo: st.stations.repository,
    budgets, offers, service, tx, at: shared.clock.now() });
}

function addStation(env, id, factionId) {
  const r = env.tx((db) => env.repo.createStation(db, { stationId: id, kind: "npc",
    npcStationId: 60000000 + id.charCodeAt(id.length - 1), systemId: S.N0, ownerFactionId: factionId,
    ownerCorporationId: CORP, origin: "seed", at: env.at }, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function seed(env, stationId, itemKey, delta, tag) {
  const r = env.tx((db) => env.repo.applyStockChange(db, { stationId, key: `test:seed:${stationId}:${tag}`,
    reason: "TEST", at: env.at, deltas: [{ itemKind: "mineral", itemKey, delta }] }));
  assert.ok(r.ok, JSON.stringify(r));
}

function fund(env) {
  const r = env.tx((db) => env.budgets.fundInTx(db, { factionId: F, units: 100, paidUntilTo: env.at,
    iskPerUnit: 1000000, capIsk: 1e12, at: env.at }, "test:fund"));
  assert.ok(r.ok && r.fundedIsk > 0, JSON.stringify(r));
}

const typeOf = (itemKey) => Number(itemKey.split(":")[1]);
const buySpec = (env, stationId, itemKey, quantity = 1000) => ({ factionId: F, stationId, systemId: S.N0,
  issuerCorporationId: CORP, itemKind: "mineral", itemKey, typeId: typeOf(itemKey), quantity, unitPriceMilli: 1100,
  iskTotal: 1100, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid", expiresAt: env.at + DAY, at: env.at });
const sellSpec = (env, stationId, itemKey, quantity = 1000) => ({ ...buySpec(env, stationId, itemKey, quantity),
  side: "sell", priceSource: "ask", capPriceMilli: null });

const stockOf = (env, stationId, itemKey) => {
  const row = env.tx((db) => db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = ? "
    + "AND item_kind = 'mineral' AND item_key = ?").get(stationId, itemKey));
  return row ? row.quantity : 0;
};
const countOf = (env, sql) => env.tx((db) => db.prepare(sql).get().n);
const counts = (env) => ({ offers: countOf(env, "SELECT count(*) AS n FROM world_trade_offers"),
  journal: countOf(env, "SELECT count(*) AS n FROM world_event_journal"),
  stock: countOf(env, "SELECT COALESCE(SUM(quantity), 0) AS n FROM world_station_stock") });
const budgetOf = (env) => env.tx((db) => env.budgets.getBudget(db, F)).budget;
const offerOf = (env, id) => env.tx((db) => env.offers.getOffer(db, id)).offer;
const create = (env, spec, key) => env.tx((db) => env.offers.createOfferInTx(db, spec, key));
const payloadOf = (env, key) => env.tx((db) => db.prepare("SELECT payload FROM world_event_journal "
  + "WHERE idempotency_key = ?").get(key)).payload;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("WTS1 migration 37 world_trade_sell: old offer side 'buy', budget WTS totals 0, pair index unchanged; "
    + "sell on the pair of an open buy = OFFER_EXISTS", async () => {
    assert.deepStrictEqual([MIGRATIONS[36].version, MIGRATIONS[36].name], [37, "world_trade_sell"]);
    assert.ok(LATEST_SCHEMA_VERSION >= 37);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m37-"));
    const stores = [];
    const open = (migrations) => {
      const o = openStore({ filePath: path.join(tmp, "old.sqlite"), openDatabase: (f) => new driver.Database(f),
        exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
        randomSeed: () => 1, migrations });
      assert.ok(o.ok, JSON.stringify(o));
      return o;
    };
    const indexSql = (o) => o.store.transaction("t", (db) => db.prepare("SELECT sql FROM sqlite_master WHERE "
      + "name = 'world_trade_offers_station_item_open'").get().sql).value;
    try {
      const old = open(MIGRATIONS.slice(0, 36));
      assert.strictEqual(old.schemaVersion, 36);
      const before = indexSql(old);
      const w = old.store.transaction("t", (db) => {
        db.prepare("INSERT INTO world_trade_budgets (faction_id, isk_available, isk_reserved, created_at, updated_at, "
          + "version) VALUES (500019, 5000, 1100, 1, 1, 1)").run();
        db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id, "
          + "item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, price_source, state, "
          + "created_at, expires_at, updated_at, version) VALUES ('to_old', 500019, 'npc-a', 30000001, 1000162, "
          + "'mineral', 'type:34', 34, 1000, 1100, 1100, 1000, 'bid', 'PLANNED', 1, 2, 1, 1)").run();
      });
      assert.ok(w.ok, JSON.stringify(w));
      old.store.close("upgrade");
      const up = open(MIGRATIONS);
      stores.push(up.store);
      assert.deepStrictEqual([up.schemaVersion, up.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION - 36]);
      const got = up.store.transaction("t", (db) => [
        db.prepare("SELECT side FROM world_trade_offers WHERE offer_id = 'to_old'").get().side,
        db.prepare("SELECT wts_proceeds_total AS p, wts_treasury_total AS t, wts_burned_total AS b "
          + "FROM world_trade_budgets WHERE faction_id = 500019").get()]).value;
      assert.deepStrictEqual([got[0], { ...got[1] }], ["buy", { p: 0, t: 0, b: 0 }]);
      assert.strictEqual(indexSql(up), before);
      const journal = createJournal({ clock: { now: () => 10 }, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: { now: () => 10 } });
      const b = up.store.transaction("t", (db) => budgets.getBudget(db, 500019)).value.budget;
      assert.deepStrictEqual([b.wtsProceedsTotal, b.wtsTreasuryTotal, b.wtsBurnedTotal], [0, 0, 0]);
    } finally {
      for (const s of stores) s.close("test");
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    await H.withStore(driver, async (reopen) => {
      const env = await boot(reopen(), H.sharedOf());
      addStation(env, "npc-a", F);
      seed(env, "npc-a", "type:34", 5000, "34");
      fund(env);
      const buy = create(env, buySpec(env, "npc-a", "type:34"), "wts1:buy:offer");
      assert.ok(buy.ok && buy.offer.side === "buy", JSON.stringify(buy));
      const c0 = counts(env);
      const r = create(env, sellSpec(env, "npc-a", "type:34"), "wts1:sell:offer");
      assert.deepStrictEqual(r, { ok: false, reason: "OFFER_EXISTS" });
      assert.deepStrictEqual(counts(env), c0);
    });
  });

  needsDriver("WTS2 createOfferInTx sell: stock-out exactly once, budget unchanged, ts_ id; refusals write nothing; "
    + "buy payload byte for byte", () => H.withStore(driver, async (reopen) => {
    const env = await boot(reopen(), H.sharedOf());
    addStation(env, "npc-a", F);
    addStation(env, "npc-b", FACTION_B);
    seed(env, "npc-a", "type:34", 5000, "34");
    seed(env, "npc-b", "type:34", 5000, "34");
    assert.strictEqual(TS.STATION_STATE_DESTROYED, STS.DESTROYED_STATION_STATE);
    assert.strictEqual(TS.STATION_STATE_ONLINE, STS.INITIAL_STATION_STATE);
    assert.ok(STS.STATION_STATES.includes(TS.STATION_STATE_ONLINE));
    const notOnline = ["ANCHORING", "ARMOR_REINFORCE", "HULL_REINFORCE"];
    assert.deepStrictEqual(STS.STATION_STATES.filter((s) => s !== TS.STATION_STATE_ONLINE
      && s !== TS.STATION_STATE_DESTROYED).sort(), [...notOnline].sort());
    addStation(env, "npc-r", F);
    seed(env, "npc-r", "type:34", 5000, "34");
    fund(env);
    const budget0 = budgetOf(env);

    const r = create(env, sellSpec(env, "npc-a", "type:34"), "wts2:sell:offer");
    assert.ok(r.ok && r.duplicate === false, JSON.stringify(r));
    assert.ok(isId(r.offer.offerId, "ts"), r.offer.offerId);
    assert.deepStrictEqual([r.offer.side, r.offer.state, r.offer.priceSource, r.offer.capPriceMilli],
      ["sell", "PLANNED", "ask", null]);
    assert.strictEqual(stockOf(env, "npc-a", "type:34"), 4000);
    assert.deepStrictEqual(budgetOf(env), budget0);
    const out = env.tx((db) => env.journal.findByKey(db, TS.stockOutKey(r.offer.offerId)));
    assert.ok(out.found, JSON.stringify(out));
    assert.strictEqual(payloadOf(env, "wts2:sell:offer"), `{"expiresAt":${env.at + DAY},"factionId":${F},`
      + `"iskTotal":1100,"itemKey":"type:34","quantity":1000,"side":"sell","stationId":"npc-a","unitPriceMilli":1100}`);

    const again = create(env, sellSpec(env, "npc-a", "type:34"), "wts2:sell:offer");
    assert.ok(again.ok && again.duplicate === true && again.offer.offerId === r.offer.offerId, JSON.stringify(again));
    assert.strictEqual(stockOf(env, "npc-a", "type:34"), 4000);

    const c0 = counts(env);
    const refusals = [
      [sellSpec(env, "npc-a", "type:35", 1), "INSUFFICIENT_STOCK"],
      [sellSpec(env, "npc-b", "type:36"), "STATION_NOT_OWNED"],
      [{ ...sellSpec(env, "npc-a", "type:36"), itemKind: "ore" }, "TRADE_INVALID_INPUT"],
      [{ ...sellSpec(env, "npc-a", "type:36"), assigneeCharacterId: 9001 }, "TRADE_INVALID_INPUT"],
      [{ ...sellSpec(env, "npc-a", "type:36"), priceSource: "bid" }, "TRADE_INVALID_INPUT"],
    ];
    refusals.forEach(([spec, reason], i) => {
      const x = create(env, spec, `wts2:refuse:${i}:offer`);
      assert.strictEqual(x.ok, false, JSON.stringify(x));
      assert.strictEqual(x.reason, reason, `${i}: ${JSON.stringify(x)}`);
      assert.deepStrictEqual(counts(env), c0, `case ${i}`);
    });
    notOnline.forEach((state) => {
      env.tx((db) => db.prepare("UPDATE world_stations SET state = ? WHERE station_id = 'npc-r'").run(state));
      const x = create(env, sellSpec(env, "npc-r", "type:34"), `wts2:not-online:${state}:offer`);
      assert.deepStrictEqual(x, { ok: false, reason: "STATION_NOT_ONLINE", state }, state);
      assert.deepStrictEqual(counts(env), c0, state);
      assert.strictEqual(stockOf(env, "npc-r", "type:34"), 5000, state);
    });
    env.stockOn = false;
    assert.deepStrictEqual(create(env, sellSpec(env, "npc-a", "type:36"), "wts2:off:offer"),
      { ok: false, reason: "STATIONS_NOT_READY" });
    env.stockOn = true;
    assert.deepStrictEqual(counts(env), c0);

    const buy = create(env, buySpec(env, "npc-a", "type:36"), "wts2:buy:offer");
    assert.ok(buy.ok && isId(buy.offer.offerId, "to") && buy.offer.side === "buy", JSON.stringify(buy));
    assert.strictEqual(payloadOf(env, "wts2:buy:offer"), `{"expiresAt":${env.at + DAY},"factionId":${F},`
      + `"iskTotal":1100,"itemKey":"type:36","quantity":1000,"stationId":"npc-a","unitPriceMilli":1100}`);
  }));

  needsDriver("WTS3 sell -> CANCELLED: stock-back once; destroyed station lost; full stock up to the cap; INTAKE with "
    + "deliveredQuantity; no stock-out entry = SELL_STOCK_OUT_MISSING", () => H.withStore(driver, async (reopen) => {
    const env = await boot(reopen(), H.sharedOf());
    addStation(env, "npc-a", F);
    addStation(env, "npc-c", F);
    seed(env, "npc-a", "type:34", 5000, "34");
    seed(env, "npc-a", "type:37", 100, "37");
    seed(env, "npc-a", "type:38", 500, "38");
    seed(env, "npc-c", "type:35", 300, "35");
    const cancel = (offer, ik) => env.tx((db) => env.service.cancelOfferInTx(db, { factionId: F,
      offerId: offer.offerId, expectedVersion: offer.version, reason: "EXPIRED", at: env.at }, ik));

    const a = create(env, sellSpec(env, "npc-a", "type:34"), "wts3:a:offer").offer;
    assert.strictEqual(stockOf(env, "npc-a", "type:34"), 4000);
    const ca = cancel(a, "wts3:a");
    assert.ok(ca.ok && ca.offer.state === "CANCELLED", JSON.stringify(ca));
    assert.deepStrictEqual(ca.stockBack, { credited: 1000, lost: 0 });
    assert.strictEqual(stockOf(env, "npc-a", "type:34"), 5000);
    const ca2 = cancel(a, "wts3:a");
    assert.ok(ca2.ok && ca2.duplicate === true, JSON.stringify(ca2));
    assert.deepStrictEqual(ca2.stockBack, { credited: 0, lost: 0 });
    assert.strictEqual(stockOf(env, "npc-a", "type:34"), 5000);

    const d = create(env, sellSpec(env, "npc-c", "type:35", 300), "wts3:d:offer").offer;
    env.tx((db) => db.prepare("UPDATE world_stations SET state = 'DESTROYED' WHERE station_id = 'npc-c'").run());
    const cd = cancel(d, "wts3:d");
    assert.ok(cd.ok && cd.offer.state === "CANCELLED", JSON.stringify(cd));
    assert.deepStrictEqual(cd.stockBack, { credited: 0, lost: 300 });
    assert.strictEqual(stockOf(env, "npc-c", "type:35"), 0);

    addStation(env, "npc-e", F);
    seed(env, "npc-e", "type:35", 300, "35");
    const e = create(env, sellSpec(env, "npc-e", "type:35", 200), "wts3:e:offer").offer;
    assert.strictEqual(stockOf(env, "npc-e", "type:35"), 100);
    env.tx((db) => db.prepare("UPDATE world_stations SET owner_faction_id = ? WHERE station_id = 'npc-e'")
      .run(FACTION_B));
    const ce = cancel(e, "wts3:e");
    assert.ok(ce.ok && ce.offer.state === "CANCELLED", JSON.stringify(ce));
    assert.deepStrictEqual(ce.stockBack, { credited: 0, lost: 200 });
    assert.strictEqual(stockOf(env, "npc-e", "type:35"), 100);
    assert.strictEqual(env.tx((db) => env.journal.findByKey(db, TS.stockBackKey(e.offerId))).found, false);

    const max = DEFAULTS.stations.maxStockQuantity;
    const f = create(env, sellSpec(env, "npc-a", "type:37", 100), "wts3:f:offer").offer;
    assert.strictEqual(stockOf(env, "npc-a", "type:37"), 0);
    seed(env, "npc-a", "type:37", max - 30, "37-fill");
    const cf = cancel(f, "wts3:f");
    assert.ok(cf.ok, JSON.stringify(cf));
    assert.deepStrictEqual(cf.stockBack, { credited: 30, lost: 70 });
    assert.strictEqual(stockOf(env, "npc-a", "type:37"), max);

    const g = create(env, sellSpec(env, "npc-a", "type:38", 500), "wts3:g:offer").offer;
    const step = (offer, from, to, reason, patch) => env.tx((db) => env.offers.transitionOfferInTx(db, {
      offerId: offer.offerId, expectedVersion: offer.version, from, to, reason, at: env.at, ...(patch ? { patch } : {}) },
    TS.transitionKey(offer.offerId, offer.stateSeq + 1, to)));
    const g1 = step(g, "PLANNED", "ISSUING", "");
    assert.ok(g1.ok, JSON.stringify(g1));
    const g2 = step(g1.offer, "ISSUING", "INTAKE", "");
    assert.ok(g2.ok && g2.offer.state === "INTAKE", JSON.stringify(g2));
    const bad = step(g2.offer, "INTAKE", "CANCELLED", "ISSUE_FAILED", { deliveredQuantity: 501 });
    assert.deepStrictEqual([bad.ok, bad.reason], [false, "TRADE_INVALID_INPUT"]);
    const g3 = step(g2.offer, "INTAKE", "CANCELLED", "ISSUE_FAILED", { deliveredQuantity: 200 });
    assert.ok(g3.ok && g3.offer.state === "CANCELLED" && g3.offer.deliveredQuantity === 200, JSON.stringify(g3));
    assert.deepStrictEqual(g3.stockBack, { credited: 200, lost: 0 });
    assert.strictEqual(stockOf(env, "npc-a", "type:38"), 200);

    env.tx((db) => db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, "
      + "issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, "
      + "price_source, state, created_at, expires_at, updated_at, version, side) VALUES ('ts_raw', ?, 'npc-a', ?, ?, "
      + "'mineral', 'type:39', 39, 10, 1100, 11, 1000, 'ask', 'PLANNED', ?, ?, ?, 1, 'sell')")
      .run(F, S.N0, CORP, env.at, env.at + DAY, env.at));
    const raw = offerOf(env, "ts_raw");
    const c0 = counts(env);
    const m = cancel(raw, "wts3:raw");
    assert.deepStrictEqual([m.ok, m.reason], [false, "SELL_STOCK_OUT_MISSING"]);
    assert.deepStrictEqual(counts(env), c0);
    assert.strictEqual(offerOf(env, "ts_raw").state, "PLANNED");
  }));

  needsDriver("WTS4 filters: ISK reserve and suppliers skip sell, readForReview marks only sell, wtsEnabled false = "
    + "WTS_DISABLED", () => H.withStore(driver, async (reopen) => {
    const env = await boot(reopen(), H.sharedOf());
    addStation(env, "npc-a", F);
    seed(env, "npc-a", "type:35", 5000, "35");
    fund(env);
    const buy = create(env, buySpec(env, "npc-a", "type:34"), "wts4:buy:offer").offer;
    const sell = create(env, sellSpec(env, "npc-a", "type:35"), "wts4:sell:offer").offer;
    assert.ok(buy && sell);
    assert.strictEqual(env.tx((db) => env.offers.sumOpenReserved(db, F)).total, 1100);
    env.tx((db) => {
      db.prepare("UPDATE world_trade_offers SET acceptor_character_id = 9001 WHERE offer_id = ?").run(buy.offerId);
      db.prepare("UPDATE world_trade_offers SET acceptor_character_id = 9002 WHERE offer_id = ?").run(sell.offerId);
    });
    const opts = { since: 0, limit: 10 };
    assert.deepStrictEqual(env.tx((db) => env.offers.listSuppliers(db, F, opts)).suppliers.map((x) => x.characterId),
      [9001]);
    assert.deepStrictEqual(env.tx((db) => env.offers.getSuppliersWithRejection(db, F, opts)).suppliers
      .map((x) => x.characterId), [9001]);

    const read = env.tx((db) => env.service.readForReview(db, F, { stations: [{ stationId: "npc-a", systemId: S.N0,
      kind: "npc", ownerCorporationId: CORP }], at: env.at, limit: 10 }));
    assert.ok(read.ok, JSON.stringify(read));
    const byId = new Map(read.trade.open.map((o) => [o.offerId, o]));
    assert.strictEqual(byId.get(sell.offerId).side, "sell");
    assert.ok(!Object.prototype.hasOwnProperty.call(byId.get(buy.offerId), "side"));

    assert.strictEqual(DEFAULTS.trade.wtsEnabled, false);
    const c0 = counts(env);
    const off = env.tx((db) => env.service.planOfferInTx(db, sellSpec(env, "npc-a", "type:36"), "wts4:off"));
    assert.deepStrictEqual(off, { ok: false, reason: "WTS_DISABLED" });
    assert.deepStrictEqual(counts(env), c0);
  }));

  needsDriver("WTS5 a throw after the sell stock-out in the same transaction: stock, offers and journal unchanged",
    () => H.withStore(driver, async (reopen) => {
      const env = await boot(reopen(), H.sharedOf());
      addStation(env, "npc-a", F);
      seed(env, "npc-a", "type:34", 5000, "34");
      const c0 = counts(env);
      const boom = new Error("WTS5 abort");
      let created = null;
      const r = env.store.transaction("test", (db) => {
        created = env.offers.createOfferInTx(db, sellSpec(env, "npc-a", "type:34"), "wts5:offer");
        throw boom;
      });
      assert.ok(created && created.ok && created.duplicate === false, JSON.stringify(created));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, boom);
      assert.deepStrictEqual(counts(env), c0);
      assert.strictEqual(stockOf(env, "npc-a", "type:34"), 5000);
    }));
};

Object.assign(module.exports, { harness: Object.freeze({ boot, addStation, seed, sellSpec, buySpec, stockOf, offerOf,
  create, CORP, DEFAULTS }) });
