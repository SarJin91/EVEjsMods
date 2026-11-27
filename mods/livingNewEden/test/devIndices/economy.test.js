"use strict";

const assert = require("node:assert");

const R = require("../../lib/world/devIndices/rules");
const ECO = require("../../lib/world/devIndices/sources/economy");
const { createDevIndicesRepository } = require("../../lib/world/devIndices/repository");
const { createMemoryIndex } = require("../../lib/world/devIndices/memoryIndex");
const { createSweep } = require("../../lib/world/devIndices/sweep");
const { createKillboardRepository } = require("../../lib/killboard/repository");
const { listDeliveredJobsAfter } = require("../../lib/economy/production/jobRepository");
const { listDeliveredConvoysAfter } = require("../../lib/economy/logistics/convoyRepository");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const A = 500001;
const B = 500002;

function insertFleet(db, fleetId, factionId) {
  db.prepare(`INSERT INTO virtual_fleets (fleet_id, faction_id, current_system_id, leg_seq, fleet_role,
    composition_json, ship_count, supply_state, state, created_at, updated_at, version)
    VALUES (?, ?, 1, 0, 'mining', '[]', 1, 100, 'IDLE', ?, ?, 1)`).run(fleetId, factionId, F.T0, F.T0);
}

function insertTrip(db, tripId, factionId, fleetId, beltSystemId, state, endedAt) {
  db.prepare(`INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id, origin_system_id,
    belt_system_id, state, sec_class, richness_permille, dispatched_at, ended_at, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'highsec', 500, ?, ?, ?, ?, 1)`)
    .run(tripId, `di6:${tripId}`, factionId, fleetId, beltSystemId, state, endedAt - F.HOUR, endedAt, endedAt, endedAt);
}

function insertOffer(db, offerId, systemId, acceptor, delivered, unitMilli, endedAt) {
  db.prepare(`INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id,
    item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, price_source, state,
    acceptor_character_id, delivered_quantity, created_at, expires_at, updated_at, ended_at, version)
    VALUES (?, ?, 's1', ?, 1000001, 'mineral', 'type:34', 34, 100, ?, 1000000, ?, 'base', 'DELIVERED', ?, ?, ?, ?, ?, ?, 1)`)
    .run(offerId, A, systemId, unitMilli, unitMilli, acceptor, delivered, endedAt - F.HOUR, endedAt + F.HOUR, endedAt,
      endedAt);
}

function rig(store, env, economyReaders) {
  const P = F.settingsFor(env);
  const memory = createMemoryIndex({ P, clock: { now: () => F.T0 } });
  memory.markWarm();
  const world = F.makeWorld({ 1: { controllerFactionId: A, occupationState: "STABLE" },
    2: { controllerFactionId: B, occupationState: "STABLE" } });
  const graph = F.makeGraph();
  const sweep = createSweep({ store, repo: createDevIndicesRepository(), kbRepo: createKillboardRepository(), memory,
    settings: P, getGraph: () => graph, getWorldRepository: () => world, nowMs: () => 0, getFactionIds: () => [A, B],
    ...(economyReaders ? { economyReaders } : {}) });
  return { P, sweep, memory };
}

function insertSideOffer(db, offerId, systemId, acceptor, side, endedAt) {
  db.prepare(`INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id,
    item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, price_source, state,
    acceptor_character_id, delivered_quantity, created_at, expires_at, updated_at, ended_at, version, side)
    VALUES (?, ?, ?, ?, 1000001, 'mineral', 'type:34', 34, 100, 50000000, 5000000, 50000000, 'base', ?, ?, ?, ?, ?, ?,
    ?, 1, ?)`)
    .run(offerId, A, `s_${offerId}`, systemId, acceptor ? "DELIVERED" : "EXPIRED", acceptor, acceptor ? 100 : 0,
      endedAt - F.HOUR, endedAt + F.HOUR, endedAt, endedAt, side);
}

function tradeCursor(store) {
  const r = store.transaction("test.di9.cursor", (db) => db.prepare("SELECT after_at, after_key, facts, version FROM "
    + "world_dev_cursors WHERE source = 'trade'").get());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function devRows(store) {
  const r = store.transaction("test.di6.rows", (db) => ({
    rows: db.prepare("SELECT system_id, mil_points, ind_points, trade_points FROM world_system_dev ORDER BY system_id")
      .all().map((x) => [x.system_id, x.mil_points, x.ind_points, x.trade_points]),
    cursors: db.prepare("SELECT source, after_key, facts FROM world_dev_cursors WHERE after_no = 0 AND source IN "
      + "('mining', 'production', 'convoys', 'trade') ORDER BY source").all().map((x) => [x.source, x.after_key, x.facts]),
  }));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

module.exports = ({ test, skip }) => {
  test("DI6 economy: foldEconomy, merge per faction by (ended_at, id), page limit, tie by id", () => {
    const P = F.settingsFor();
    assert.deepStrictEqual(["mining", "production", "convoys"].map((source) => R.foldEconomy({ source, systemId: 1 }, P)),
      [{ ind: 10 }, { ind: 15 }, { trade: 20 }]);
    const trade = (isk) => R.foldEconomy({ source: "trade", systemId: 1, iskDelivered: isk }, P);
    assert.deepStrictEqual([trade(500000), trade(5000000), trade(1000000000000), trade(0)],
      [{ trade: 1, ind: 10 }, { trade: 5, ind: 10 }, { trade: 50, ind: 10 }, { trade: 1, ind: 10 }]);
    assert.deepStrictEqual(R.foldEconomy({ source: "x" }, P), {});

    const rowsOf = (factionId) => Array.from({ length: 8 }, (_, i) => ({ id: `${factionId === A ? "a" : "b"}${i}`,
      endedAt: F.T0 - F.HOUR + Math.floor(i / 2) * F.MIN, systemId: 1 }));
    const seen = [];
    const readers = { mining: (tx, spec) => {
      seen.push([spec.factionId, spec.untilAt, spec.limit]);
      return { ok: true, rows: rowsOf(spec.factionId) };
    } };
    const cursor = ECO.economyCursor("mining", null, F.T0, P);
    assert.strictEqual(cursor.event, ECO.BOOTSTRAP);
    assert.deepStrictEqual([cursor.cursor.afterAt, cursor.cursor.afterKey], [F.T0 - P.bootstrapLookbackMs, ""]);
    const page = ECO.readEconomyFacts({}, readers, "mining", cursor.cursor, [A, B], F.T0, P);
    assert.ok(page.ok, JSON.stringify(page));
    assert.deepStrictEqual(seen, [[A, F.T0 - P.sourceLagMs, P.sourcePageRows], [B, F.T0 - P.sourceLagMs,
      P.sourcePageRows]], "lag + limit per faction");
    const P10 = F.settingsFor({ EVEJS_LNE_DEV_INDICES_SOURCE_PAGE_ROWS: "10" });
    const cut = ECO.readEconomyFacts({}, readers, "mining", cursor.cursor, [A, B], F.T0, P10);
    assert.deepStrictEqual(cut.facts.map((f) => f.key), ["a0", "a1", "b0", "b1", "a2", "a3", "b2", "b3", "a4", "a5"]);
    assert.deepStrictEqual([cut.endAt, cut.endKey], [F.T0 - F.HOUR + 2 * F.MIN, "a5"]);
    const refused = ECO.readEconomyFacts({}, { mining: () => ({ ok: false, reason: "TX_REQUIRED" }) }, "mining",
      cursor.cursor, [A], F.T0, P);
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "TX_REQUIRED"]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("DI6 economy sweep on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("DI6 economy sweep on a store: ind/trade points, wormhole skipped, lag waits, once, 4 cursors", () => {
    withStore(driver, ({ store }) => {
      assert.ok(store.transaction("test.di6.seed", (db) => {
        insertFleet(db, "fa", A);
        insertFleet(db, "fb", B);
        insertTrip(db, "tA1", A, "fa", 1, "DELIVERED", F.T0 - 2 * F.HOUR);
        insertTrip(db, "tB1", B, "fb", 1, "DELIVERED", F.T0 - 2 * F.HOUR);
        insertTrip(db, "tA2", A, "fa", 4, "DELIVERED", F.T0 - F.HOUR);
        insertTrip(db, "tA3", A, "fa", 2, "DELIVERED", F.T0 - 5 * F.MIN);
        insertTrip(db, "tA4", A, "fa", 1, "ABORTED", F.T0 - F.HOUR);
        insertOffer(db, "to_1", 1, 90000001, 100, 50000000, F.T0 - 30 * F.MIN);
        insertOffer(db, "to_2", 1, null, 100, 50000000, F.T0 - 20 * F.MIN);
      }).ok);
      const h = rig(store);
      const first = h.sweep.runPass(F.T0);
      assert.deepStrictEqual(first, { ok: true, systems: 1, facts: { kb_battles: 0, kb_kills: 0, mining: 3,
        production: 0, convoys: 0, trade: 1 } });
      assert.deepStrictEqual(devRows(store), { rows: [[1, 0, 30, 5]], cursors: [["convoys", "", 0], ["mining", "tA2", 3],
        ["production", "", 0], ["trade", "to_2", 1]] }, "Trade cursor = the last READ offer");
      const c = h.sweep.getStatus().counters;
      assert.deepStrictEqual([c["sweep.facts.mining"], c["sweep.facts.trade"], c["sweep.skippedSec"]], [3, 1, 1]);
      assert.strictEqual(h.memory.levelsOf(1).indPoints, 30);

      assert.deepStrictEqual(h.sweep.runPass(F.T0).facts, { kb_battles: 0, kb_kills: 0, mining: 0, production: 0,
        convoys: 0, trade: 0 }, "the same pass again = nothing");
      const later = h.sweep.runPass(F.T0 + 10 * F.MIN);
      assert.strictEqual(later.facts.mining, 1, "tA3 after the lag");
      assert.deepStrictEqual(devRows(store).rows, [[1, 0, 30, 5], [2, 0, 10, 0]]);
      assert.strictEqual(h.sweep.runPass(F.T0 + 20 * F.MIN).facts.mining, 0, "counted once");

      const other = store.transaction("test.di6.readers", (db) => [listDeliveredJobsAfter(db, { factionId: A,
        afterAt: 0, afterKey: "", untilAt: F.T0, limit: 10 }), listDeliveredConvoysAfter(db, { factionId: A, afterAt: 0,
        afterKey: "", untilAt: F.T0, limit: 10 }), listDeliveredJobsAfter(db, { factionId: 0 })]).value;
      assert.deepStrictEqual(other.map((r) => [r.ok, r.ok ? r.rows.length : r.reason]),
        [[true, 0], [true, 0], [false, "PRODUCTION_INVALID_INPUT"]]);
    });
  });

  test("DI9 trade cursor follows the read rows: expired offers move it, WTB/WTS both trade, ind only WTB, truncation", () => {
    const ENV = { EVEJS_LNE_DEV_INDICES_SOURCE_PAGE_ROWS: "10" };
    const scans = [];
    const readers = { ...ECO.READERS, trade: (tx, spec) => {
      const r = ECO.READERS.trade(tx, spec);
      scans.push(r.scanned);
      return r;
    } };
    const T = (i) => F.T0 - 50 * F.MIN + i * 1000;
    const id = (i) => `ex_${String(i).padStart(2, "0")}`;
    withStore(driver, ({ store }) => {
      const h = rig(store, ENV, readers);
      const n = h.P.sourcePageRows + 3;
      assert.ok(store.transaction("test.di9.seed", (db) => {
        for (let i = 0; i < n; i += 1) insertSideOffer(db, id(i), 1, null, i % 2 ? "sell" : "buy", T(i));
      }).ok);
      assert.strictEqual(h.sweep.runPass(F.T0).facts.trade, 0);
      const c1 = tradeCursor(store);
      assert.deepStrictEqual([c1.after_key, c1.after_at, c1.facts, scans],
        [id(h.P.sourcePageRows - 1), T(h.P.sourcePageRows - 1), 0, [h.P.sourcePageRows]]);
      assert.ok(store.transaction("test.di9.facts", (db) => {
        insertSideOffer(db, "pl_buy", 1, 90000001, "buy", T(n));
        insertSideOffer(db, "pl_sell", 1, 90000002, "sell", T(n + 1));
      }).ok);
      assert.strictEqual(h.sweep.runPass(F.T0).facts.trade, 2);
      assert.deepStrictEqual(devRows(store).rows, [[1, 0, h.P.tradeDeliveryIndPoints, 10]]);
      const c2 = tradeCursor(store);
      assert.deepStrictEqual([c2.after_key, c2.facts, scans[1]], ["pl_sell", 2, 5]);
      assert.strictEqual(h.sweep.runPass(F.T0).facts.trade, 0);
      assert.deepStrictEqual([scans[2], tradeCursor(store).version], [0, c2.version]);
    });
    withStore(driver, ({ store }) => {
      const h = rig(store, { ...ENV, EVEJS_LNE_DEV_INDICES_MAX_SYSTEMS_PER_PASS: "1" }, readers);
      assert.ok(store.transaction("test.di9.cut", (db) => {
        insertSideOffer(db, id(0), 1, null, "buy", T(0));
        insertSideOffer(db, "pl_1", 1, 90000001, "buy", T(1));
        insertSideOffer(db, id(2), 1, null, "buy", T(2));
        insertSideOffer(db, "pl_2", 2, 90000001, "buy", T(3));
        insertSideOffer(db, id(4), 1, null, "buy", T(4));
      }).ok);
      assert.strictEqual(h.sweep.runPass(F.T0).facts.trade, 1);
      assert.deepStrictEqual([tradeCursor(store).after_key, h.sweep.getStatus().counters["sweep.truncated"]], ["pl_1", 1]);
    });
  });
};
