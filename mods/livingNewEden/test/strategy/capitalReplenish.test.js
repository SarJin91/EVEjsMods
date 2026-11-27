"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planCapitalReplenish } = require("../../lib/strategy/ai/capitalReplenish");
const { decideReview } = require("../../lib/strategy/ai");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { capitalAttachParamsOf, escalationParamsOf, capitalLevelParamsOf, capitalReplenishParamsOf } =
  require("../../lib/strategy/reviewService");
const { capitalClassesOf } = require("../../lib/strategy/data/factionHullClasses");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
const { resolveConfig } = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");
const { harness: S } = require("./ai/replenishReturn.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOME = 20;
const CARRIER = 11004;
const DREAD = 11002;
const TITAN = 11001;
const CLASSES = Object.freeze({ titan: TITAN, dreadnought: DREAD, carrier: CARRIER });
const POWER = buildPowerTable(expandStrengthGroups(GROUPS));
const GARRISON = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);
const PROD = Object.freeze({ mobilizeHulls: "required", miningNeedsHulls: false, hullGroups: [...HULL_GROUPS] });

const cfgOf = (env) => resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
const ESC_ON = { EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1", EVEJS_LNE_STRATEGY_ESCALATION_ENABLED: "1" };
const CFG = cfgOf(ESC_ON).config;
const PARAMS = Object.freeze({ maxBfsSystems: 2000, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, powerTable: POWER, production: PROD,
  capitalAttach: capitalAttachParamsOf(CFG), escalation: escalationParamsOf(CFG), capitalLevel: capitalLevelParamsOf(CFG),
  replenish: Object.freeze({ maxReplenishPerReview: 2, maxShipsPerFleet: 500 }),
  capitalReplenish: Object.freeze({ maxPerReview: 1 }) });
const prodOf = (stations) => ({ mode: "ready", recipesVersion: 1, recipes: {}, inProduction: {}, activeJobsTotal: 0,
  truncated: false, stations: stations.map((s) => ({ kind: "npc", lines: 1, activeJobs: [], minerals: {}, ...s })) });
const fleetOf = (fleetId, systemId, composition, extra = {}) => ({ fleetId, version: 3, state: "IDLE",
  fleetRole: "garrison", systemId, refitPending: false, operationId: null, homeSystemId: systemId, composition,
  shipCount: composition.reduce((n, e) => n + e.count, 0), strength: strengthOf(composition, POWER), ...extra });
const FULL = Object.freeze(GARRISON.map((e) => ({ ...e, typeId: null })));

function snap(o = {}) {
  const row = (systemId) => ({ systemId, controllerFactionId: F, occupationState: "STABLE", controllerGarrison: 0,
    hostileStations: 0, observed: false });
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: HOME, doctrineId: "cr", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    doctrine: { doctrineId: "cr", templates: { garrison: GARRISON, hunter: GARRISON } },
    stationsMode: "ready", stations: [{ systemId: HOME, stationId: "st20" }, { systemId: 24, stationId: "st24" }],
    systems: [row(HOME), row(24)], fleets: o.fleets || [fleetOf("g1", HOME, FULL)], fleetsTruncated: false,
    intel: [], production: prodOf([{ stationId: "st20", systemId: HOME, hulls: o.st20 || { carrier: 1 } },
      { stationId: "st24", systemId: 24, hulls: o.st24 || { carrier: 1 } }]), capitalClasses: CLASSES };
}

function run(o = {}) {
  const s = snap(o);
  const params = { ...PARAMS, ...(o.params || {}) };
  const ledger = createHullLedger(s, params);
  const r = planCapitalReplenish({ snapshot: s, params, ledger, budget: { resourceUnits: 1e6, reserveUnits: 1e6 },
    room: o.room === undefined ? 2 : o.room, slotBase: o.slotBase || 0, skip: o.skip || new Set() });
  return { r, ledger };
}

module.exports = ({ test, skip }) => {
  test("CR2 HQ garrison (level 2) at st20 with a carrier -> REPLENISH {carrier, typeId, 1}, capital true, cost 1 ship, "
    + "ledger -1, note CAPITAL_REPLENISH", () => {
    const { r, ledger } = run({ slotBase: 1 });
    assert.deepStrictEqual(r.intents, [{ type: "REPLENISH", slot: 1, fleetId: "g1", expectedVersion: 3, stationId: "st20",
      systemId: HOME, add: [{ hullGroup: "carrier", typeId: CARRIER, count: 1 }],
      cost: { resourceUnits: 10, reserveUnits: 1 }, capital: true }]);
    assert.deepStrictEqual([r.notes, r.fleetIds, r.cost], [["CAPITAL_REPLENISH"], ["g1"],
      { resourceUnits: 10, reserveUnits: 1 }]);
    assert.deepStrictEqual([ledger.available("st20", "carrier"), ledger.available("st24", "carrier")], [0, 1]);
  });

  test("CR3 no intent: a fleet with a dreadnought, level 0 (calm non-HQ post), room 0, maxPerReview 0, a fleet of "
    + "planReplenish, no carrier (CAPITAL_REPLENISH_NO_STOCK), a hunter with only a titan in stock", () => {
    const withDread = [...FULL, { hullGroup: "dreadnought", typeId: DREAD, count: 1 }];
    const none = (x, notes = []) => assert.deepStrictEqual([x.r.intents, x.r.notes, x.ledger.available("st20", "carrier")],
      [[], notes, 1]);
    none(run({ fleets: [fleetOf("g1", HOME, withDread)] }));
    const calm = run({ fleets: [fleetOf("g1", 24, FULL)] });
    assert.deepStrictEqual([calm.r.intents, calm.ledger.available("st24", "carrier")], [[], 1]);
    none(run({ room: 0 }));
    none(run({ params: { capitalReplenish: { maxPerReview: 0 } } }));
    none(run({ skip: new Set(["g1"]) }));
    none(run({ params: { capitalReplenish: null } }));
    const empty = run({ st20: { cruiser: 3 } });
    assert.deepStrictEqual([empty.r.intents, empty.r.notes], [[], ["CAPITAL_REPLENISH_NO_STOCK"]]);
    const open = capitalAttachParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1" }).config);
    const hunter = run({ fleets: [fleetOf("h1", HOME, FULL, { fleetRole: "hunter" })], st20: { titan: 1 },
      params: { capitalAttach: open } });
    assert.deepStrictEqual(hunter.r.intents, []);
    const garrison = run({ st20: { titan: 1 }, params: { capitalAttach: open } });
    assert.deepStrictEqual(garrison.r.intents.map((i) => i.add), [[{ hullGroup: "titan", typeId: TITAN, count: 1 }]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("CR4 effect on a real store: wrong typeId -> REPLENISH_INVALID (fleet, stock, faction unchanged); the "
    + "planned one -> carrier with typeId in the fleet, stock -1, faction -1 ship, counter capitalReplenished", () =>
    H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(43) }), graph: R.graphOf(),
        controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
      const typeId = capitalClassesOf(R.AMARR).carrier;
      assert.ok(Number.isSafeInteger(typeId), "Amarr has a carrier class");
      const holder = { mode: "refuse", fleetId: null };
      const hooks = { beforeEffect: (d) => {
        const mine = (i) => i.type === "REPLENISH" && i.capital === true && i.fleetId === holder.fleetId;
        if (d.factionId !== R.AMARR || !d.intents.some(mine) || holder.mode === "done") return d;
        const wrong = holder.mode === "refuse";
        holder.mode = wrong ? "apply" : "done";
        return wrong ? { ...d, intents: d.intents.map((i) => (mine(i)
          ? { ...i, add: [{ ...i.add[0], typeId: typeId + 1 }] } : i)) } : d;
      } };
      const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
        EVEJS_LNE_UPKEEP_ENABLED: "0", EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1",
        EVEJS_LNE_STRATEGY_CAPITAL_REPLENISH_ENABLED: "1" }, { hooks, production: true });
      assert.deepStrictEqual(capitalReplenishParamsOf(env.config), { maxPerReview: 1 });
      const row = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
        + "ORDER BY station_id", R.AMARR)[0];
      assert.ok(env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: row.station_id, key: "cr4:seed",
        reason: "TEST", at: clock.now(), deltas: [{ itemKind: "hull", itemKey: "group:carrier", delta: 1 }] })).ok);
      const created = env.fleets.createFleet({ factionId: R.AMARR, currentSystemId: row.system_id,
        homeSystemId: row.system_id, fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 2 },
          { hullGroup: "battlecruiser", count: 4 }, { hullGroup: "logistics", count: 2 },
          { hullGroup: "tackle", count: 2 }] }, "cr4:create");
      assert.ok(created.ok, JSON.stringify(created));
      holder.fleetId = created.fleetId;
      const fleetRow = () => env.q("SELECT composition_json AS c, ship_count AS n, version AS v FROM virtual_fleets "
        + "WHERE fleet_id = ?", created.fleetId)[0];
      const carriersAt = () => (env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND "
        + "item_key = 'group:carrier'", row.station_id)[0] || { quantity: 0 }).quantity;
      const res = () => env.q("SELECT resource_units AS r FROM world_factions WHERE faction_id = ?", R.AMARR)[0].r;
      const f0 = fleetRow();
      const res0 = res();

      await R.passesAt(env, shared, R.START_MS + R.I);
      const st1 = env.strategy.getStatus().ai.review;
      assert.strictEqual(holder.mode, "apply", `the capital REPLENISH was planned ${JSON.stringify(st1)}`);
      assert.deepStrictEqual([fleetRow(), carriersAt(), res()], [f0, 1, res0], "refused as a whole");
      assert.deepStrictEqual([st1.counters.replenishRefused, st1.lastRefusal], [1, "REPLENISH:REPLENISH_INVALID"]);

      await R.passesAt(env, shared, R.START_MS + 2 * R.I);
      assert.strictEqual(holder.mode, "done", "the second capital REPLENISH was planned");
      const f1 = fleetRow();
      const rate = env.config.strategy.mobilizeResourcePerShip;
      assert.deepStrictEqual([JSON.parse(f1.c).filter((e) => e.hullGroup === "carrier"), f1.n, carriersAt(), res()],
        [[{ hullGroup: "carrier", typeId, count: 1 }], f0.n + 1, 0, res0 - rate],
        JSON.stringify(env.strategy.getStatus().ai.review));
      const c = env.strategy.getStatus().ai.review.counters;
      assert.deepStrictEqual([c.capitalReplenished, c.replenished, c.replenishRefused], [1, 1, 1]);
      env.strategy.stop("test");
      env.production.stop("test");
    }));

  test("CR5 config: defaults off / 1, clamp 0..4, params null without the flag / attach / replenish, same review "
    + "bound; flag off -> decideReview byte-identical; on -> the capital REPLENISH after the plain one", () => {
    const d = cfgOf({});
    assert.deepStrictEqual([d.config.strategy.capitalReplenishEnabled, d.config.strategy.capitalReplenishMaxPerReview],
      [false, 1]);
    assert.strictEqual(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_REPLENISH_MAX_PER_REVIEW: "9" }).config.strategy
      .capitalReplenishMaxPerReview, 4);
    const flag = { EVEJS_LNE_STRATEGY_CAPITAL_REPLENISH_ENABLED: "1" };
    assert.strictEqual(capitalReplenishParamsOf(d.config), null);
    assert.strictEqual(capitalReplenishParamsOf(cfgOf(flag).config), null, "needs the capital attach");
    assert.strictEqual(capitalReplenishParamsOf(cfgOf({ ...ESC_ON, ...flag,
      EVEJS_LNE_LOGISTICS_REPLENISH_ENABLED: "0" }).config), null, "needs the replenish");
    const on = cfgOf({ ...ESC_ON, ...flag }).config;
    assert.deepStrictEqual(capitalReplenishParamsOf(on), { maxPerReview: 1 });
    assert.deepStrictEqual(rowBoundsOfConfig(on), rowBoundsOfConfig(CFG));

    const attach = capitalAttachParamsOf(cfgOf({ EVEJS_LNE_STRATEGY_CAPITAL_ATTACH_ENABLED: "1" }).config);
    const s = S.snap({ stations: [S.st("st10", 10, { cruiser: 2, carrier: 1 })],
      fleets: [S.fleet("f1", 10, 8), S.fleet("g1", 10, 10, { fleetRole: "garrison" })] });
    s.capitalClasses = CLASSES;
    const P = { ...S.PARAMS, capitalAttach: attach };
    const base = decideReview(s, P);
    assert.strictEqual(base.outcome, "REVIEWED", JSON.stringify(base.reason));
    assert.strictEqual(JSON.stringify(decideReview(s, { ...P, capitalReplenish: null })), JSON.stringify(base));
    const plain = base.intents.filter((i) => i.type === "REPLENISH");
    assert.deepStrictEqual(plain.map((i) => [i.fleetId, i.slot, i.capital]), [["f1", 0, undefined]]);
    const withCap = decideReview(s, { ...P, capitalReplenish: { maxPerReview: 1 } });
    const reps = withCap.intents.filter((i) => i.type === "REPLENISH");
    assert.deepStrictEqual(reps[0], plain[0]);
    assert.deepStrictEqual(reps.slice(1).map((i) => [i.fleetId, i.slot, i.add, i.capital]),
      [["g1", 1, [{ hullGroup: "carrier", typeId: CARRIER, count: 1 }], true]]);
    assert.ok(withCap.notes.includes("CAPITAL_REPLENISH"), JSON.stringify(withCap.notes));
    const tight = decideReview(s, { ...P, replenish: { ...P.replenish, maxReplenishPerReview: 1 },
      capitalReplenish: { maxPerReview: 1 } });
    assert.deepStrictEqual(tight.intents.filter((i) => i.type === "REPLENISH").map((i) => i.fleetId), ["f1"]);
  });
};
