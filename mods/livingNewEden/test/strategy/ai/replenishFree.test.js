"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planReplenish } = require("../../../lib/strategy/ai/replenish");
const { decideReview } = require("../../../lib/strategy/ai");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const { rowBoundsOfConfig } = require("../../../lib/strategy/reviewBound");
const { resolveConfig } = require("../../../config");
const { createManualClock } = require("../../../lib/util/clock");
const { createRng } = require("../../../lib/util/rng");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");
const { harness: S } = require("./replenishReturn.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const FREE = Object.freeze({ ...S.PARAMS, replenish: Object.freeze({ ...S.PARAMS.replenish, freeHulls: true }) });
const RICH = Object.freeze({ affordable: Object.freeze({ resourceUnits: 100000, reserveUnits: 10000 }) });

function scene(req, o) {
  const s = S.snap(o);
  s.doctrine.hullsRequired = req;
  return s;
}

const plan = (s, params, supply = RICH) => {
  const ledger = createHullLedger(s, params);
  return { r: planReplenish(s, supply, params, ledger), ledger };
};

module.exports = ({ test, skip }) => {
  test("CRF1 flag off: default false, no new warning, same review bound; hullsRequired false keeps "
    + "REPLENISH_NO_STOCK, decision byte-identical with freeHulls false / absent", () => {
    const def = resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.strictEqual(def.config.logistics.replenishFreeHullsEnabled, false);
    const on = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_LOGISTICS_REPLENISH_FREE_HULLS_ENABLED: "1" } });
    assert.strictEqual(on.config.logistics.replenishFreeHullsEnabled, true);
    assert.deepStrictEqual(on.warnings, def.warnings);
    assert.strictEqual(rowBoundsOfConfig(on.config).review, rowBoundsOfConfig(def.config).review);

    const s = scene(false, { stations: [S.st("st5", 5), S.st("st10", 10, { cruiser: 20 })], fleets: [S.fleet("f1", 5, 2)] });
    const off = decideReview(s, S.PARAMS);
    assert.strictEqual(off.outcome, "REVIEWED", JSON.stringify(off.reason));
    assert.deepStrictEqual(off.intents.filter((i) => i.type === "REPLENISH"), []);
    assert.ok(off.notes.includes("REPLENISH_NO_STOCK"), JSON.stringify(off.notes));
    const falseKey = { ...S.PARAMS, replenish: { ...S.PARAMS.replenish, freeHulls: false } };
    assert.strictEqual(JSON.stringify(decideReview(s, falseKey)), JSON.stringify(off));
  });

  test("CRF2 hullsRequired false + flag on: REPLENISH 8 at the first station of the system, freeHulls, no take; cut "
    + "by maxShipsPerFleet and budget; outside a station system nothing; decideReview + replenishReturn: no NO_STOCK",
  () => {
    const stations = [S.st("st5b", 5), S.st("st5a", 5), S.st("st10", 10, { cruiser: 20 })];
    const s = scene(false, { stations, fleets: [S.fleet("f1", 5, 2)] });
    const { r, ledger } = plan(s, FREE);
    assert.strictEqual(ledger.needs("invasion"), false);
    assert.deepStrictEqual(r.intents, [{ type: "REPLENISH", slot: 0, fleetId: "f1", expectedVersion: 1, stationId: "st5a",
      systemId: 5, add: [{ hullGroup: "cruiser", count: 8 }], cost: { resourceUnits: 80, reserveUnits: 8 },
      freeHulls: true }]);
    assert.deepStrictEqual([r.notes, r.fleetIds, r.cost], [["REPLENISH"], ["f1"], { resourceUnits: 80, reserveUnits: 8 }]);
    assert.deepStrictEqual([ledger.available("st5a", "cruiser"), ledger.available("st10", "cruiser")], [0, 20], "no take");
    const ships = plan(s, { ...FREE, replenish: { ...FREE.replenish, maxShipsPerFleet: 5 } }).r;
    assert.deepStrictEqual(ships.intents[0].add, [{ hullGroup: "cruiser", count: 3 }]);
    const poor = plan(s, FREE, { affordable: { resourceUnits: 50, reserveUnits: 100 } }).r;
    assert.deepStrictEqual([poor.intents[0].add, poor.cost], [[{ hullGroup: "cruiser", count: 5 }],
      { resourceUnits: 50, reserveUnits: 5 }]);
    const away = plan(scene(false, { stations, fleets: [S.fleet("f1", 3, 2)] }), FREE).r;
    assert.deepStrictEqual([away.intents, away.notes], [[], []]);
    const d = decideReview(s, { ...FREE, replenishReturn: S.RR_ON });
    assert.strictEqual(d.outcome, "REVIEWED", JSON.stringify(d.reason));
    assert.deepStrictEqual(d.intents.filter((i) => i.type === "REPLENISH").map((i) => [i.fleetId, i.freeHulls]),
      [["f1", true]]);
    assert.ok(d.notes.includes("REPLENISH") && !d.notes.some((n) => n.startsWith("REPLENISH_NO_STOCK"))
      && !d.notes.some((n) => n.startsWith("REPLENISH_RETURN")), JSON.stringify(d.notes));
  });

  test("CRF3 hullsRequired true + flag on: decision byte-identical to the flag off (stock / no stock)", () => {
    for (const stations of [[S.st("st5", 5, { cruiser: 3 })], [S.st("st5", 5)]]) {
      const s = scene(true, { stations, fleets: [S.fleet("f1", 5, 2)] });
      const off = decideReview(s, S.PARAMS);
      assert.strictEqual(off.outcome, "REVIEWED", JSON.stringify(off.reason));
      assert.strictEqual(JSON.stringify(decideReview(s, FREE)), JSON.stringify(off));
      assert.ok(off.intents.every((i) => i.freeHulls === undefined));
    }
    const s = scene(true, { stations: [S.st("st5", 5, { cruiser: 3 })], fleets: [S.fleet("f1", 5, 2)] });
    assert.deepStrictEqual(decideReview(s, FREE).intents.filter((i) => i.type === "REPLENISH").map((i) => i.add),
      [[{ hullGroup: "cruiser", count: 3 }]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("CRF4 effect on a real store: freeHulls from a faction that needs hulls -> REPLENISH_INVALID (fleet, "
    + "stock, faction unchanged); doctrine hullsRequired false in the snapshot -> fleet +4, cost, stock unchanged",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(41) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const holder = { mode: "refuse" };
    const hooks = { beforeEffect: (d, snapshot) => {
      if (d.factionId !== R.AMARR || !d.intents.some((i) => i.type === "REPLENISH")) return d;
      if (holder.mode === "free") snapshot.doctrine.hullsRequired = false;
      holder.mode = holder.mode === "refuse" ? "free" : "done";
      return { ...d, intents: d.intents.map((i) => (i.type === "REPLENISH" ? { ...i, freeHulls: true } : i)) };
    } };
    const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_ENABLED: "0", EVEJS_LNE_LOGISTICS_REPLENISH_FREE_HULLS_ENABLED: "1" },
    { hooks, production: true });
    assert.strictEqual(env.config.logistics.replenishFreeHullsEnabled, true);
    const row = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", R.AMARR)[0];
    assert.ok(env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: row.station_id, key: "crf4:seed",
      reason: "TEST", at: clock.now(), deltas: [{ itemKind: "hull", itemKey: "group:cruiser", delta: 4 }] })).ok);
    const created = env.fleets.createFleet({ factionId: R.AMARR, currentSystemId: row.system_id,
      homeSystemId: row.system_id, fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 2 },
        { hullGroup: "battlecruiser", count: 4 }, { hullGroup: "logistics", count: 2 },
        { hullGroup: "tackle", count: 2 }] }, "crf4:create");
    assert.ok(created.ok, JSON.stringify(created));
    const fleetRow = () => env.q("SELECT composition_json AS c, ship_count AS n, version AS v FROM virtual_fleets "
      + "WHERE fleet_id = ?", created.fleetId)[0];
    const cruisersAt = () => (env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND "
      + "item_key = 'group:cruiser'", row.station_id)[0] || { quantity: 0 }).quantity;
    const res = () => env.q("SELECT resource_units AS r FROM world_factions WHERE faction_id = ?", R.AMARR)[0].r;
    const f0 = fleetRow();
    const res0 = res();

    await R.passesAt(env, shared, R.START_MS + R.I);
    const st1 = env.strategy.getStatus().ai.review;
    assert.strictEqual(holder.mode, "free", "the REPLENISH was planned");
    assert.deepStrictEqual([fleetRow(), cruisersAt(), res()], [f0, 4, res0], "refused as a whole");
    assert.deepStrictEqual([st1.counters.replenishRefused, st1.lastRefusal], [1, "REPLENISH:REPLENISH_INVALID"]);

    await R.passesAt(env, shared, R.START_MS + 2 * R.I);
    assert.strictEqual(holder.mode, "done", "the second REPLENISH was planned");
    const f1 = fleetRow();
    const cruisers = JSON.parse(f1.c).filter((e) => e.hullGroup === "cruiser").reduce((n, e) => n + e.count, 0);
    const rate = env.config.strategy.mobilizeResourcePerShip;
    assert.deepStrictEqual([cruisers, f1.n, cruisersAt(), res()], [6, 14, 4, res0 - 4 * rate],
      JSON.stringify(env.strategy.getStatus().ai.review));
    const c = env.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c.replenished, c.replenishHulls, c.replenishRefused], [1, 4, 1]);
    env.strategy.stop("test");
    env.production.stop("test");
  }));
};
