"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planUpkeep, gainOf, upgradeGrowthOf } = require("../../lib/strategy/ai/upkeep");
const { planDeficitRelief } = require("../../lib/strategy/ai/deficitRelief");
const { planUpgrades } = require("../../lib/strategy/ai/industry");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { createMiningRates, fleetRatePermille, BOOSTER_ORDER } = require("../../lib/economy/mining/rates");
const { HULL_GROUPS, INDUSTRY_HULL_GROUPS, parseHullGroupList } = require("../../lib/fleets/schema");
const { carrierCapacitiesM3 } = require("../../lib/economy/logistics/cargo");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { CAPITAL_CARRIER_GROUPS } = require("../../lib/economy/data/cargoVolumes");
const { UPKEEP_ABANDON_ROWS, UPKEEP_DISBAND_ROWS } = require("../../lib/strategy/reviewRows");
const { rowBoundsOfConfig, rowBoundOverflow } = require("../../lib/strategy/reviewBound");
const { createReviewService } = require("../../lib/strategy/reviewService");
const config = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const AT = 1760000000000 - (1760000000000 % HOUR) + 1234;
const NEW_KEYS = ["deficitReliefEnabled", "deficitReliefAfterUnpaidPeriods", "deficitReliefMarginPermille",
  "maxDisbandsPerReview"];

const UP = Object.freeze({ periodMs: HOUR, maxCatchUpPeriods: 48, incomePerSystem: 3, incomePerStation: 10,
  reservePerStation: 2, maxReserveUnits: 1000, costPerSystem: 1, capturedCostPerSystem: 2, costPerShipPermille: 100,
  offensiveReservePeriods: 24, abandonAfterUnpaidPeriods: 24, maxAbandonsPerReview: 1, tradeIncomeSharePermille: 200,
  hoardCapPeriods: 168, maxResourceUnits: 1000000000, maxUnpaidPeriods: 1000, shipCapKinds: "empire,pirate,neutral" });
const ON = Object.freeze({ ...UP, deficitReliefEnabled: true, deficitReliefAfterUnpaidPeriods: 3,
  deficitReliefMarginPermille: 20, maxDisbandsPerReview: 1 });

function serpentis(o = {}) {
  const captured = Array.from({ length: 46 }, (_v, i) => ({ systemId: 30001000 + i, state: "STABLE",
    detachedSinceAt: (o.detached && i === 0) || i < (o.detachedCount || 0) ? AT - 5 * HOUR : null,
    factorPermille: 1000 }));
  return { factionId: 500020, round: 3, at: AT, entry: { kind: o.kind || "pirate" }, fleetsTruncated: false,
    faction: { status: "ACTIVE", resourceUnits: 0, reserveUnits: 0, version: 2 },
    upkeep: { mode: "ready", paidUntil: AT - (AT % HOUR) - HOUR, unpaidPeriods: o.unpaid === undefined ? 24 : o.unpaid,
      controlledCount: 50, captured, capturedTruncated: false, liveShips: 907, stationCount: 7, tradeReady: false } };
}

const DEF = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const rates = createMiningRates(DEF.mining);
const FREE = parseHullGroupList(DEF.production.freeHullGroups);
const SYS1 = 30000001;
function industryParams() {
  const minerOrder = HULL_GROUPS.filter((g) => rates.rateOf(g) > 0 && !BOOSTER_ORDER.includes(g) && !FREE.includes(g))
    .sort((a, b) => rates.rateOf(b) - rates.rateOf(a) || HULL_GROUPS.indexOf(a) - HULL_GROUPS.indexOf(b));
  return { industryEnabled: DEF.production.industryEnabled, maxUpgradesPerReview: DEF.strategy.maxUpgradesPerReview,
    minersPerFleetBase: DEF.mining.minersPerFleetBase, boosterOrder: [...BOOSTER_ORDER],
    boostedMiners: { porpoise: DEF.mining.boostedMinersPorpoise, orca: DEF.mining.boostedMinersOrca,
      rorqual: DEF.mining.boostedMinersRorqual },
    minerOrder, freeMiner: FREE.find((g) => rates.rateOf(g) > 0) || null,
    miningGroups: [...BOOSTER_ORDER, ...minerOrder].filter((g) => !FREE.includes(g)),
    industryGroups: INDUSTRY_HULL_GROUPS.filter((g) => !FREE.includes(g)), hullGroups: [...HULL_GROUPS],
    fleetRate: (c) => fleetRatePermille(c, rates).sum };
}
const catalog = createIndustryCatalog().catalog;
const IPARAMS = { production: { mobilizeHulls: "required", miningNeedsHulls: false, hullGroups: [...HULL_GROUPS],
  freeHullGroups: FREE }, industry: industryParams(), mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
logistics: { volumes: { capacityM3: carrierCapacitiesM3(DEF.logistics, catalog),
  capitalCarrierGroups: CAPITAL_CARRIER_GROUPS } } };
const fleetOf = (fleetId, fleetRole, composition) => ({ fleetId, version: 3, state: "IDLE", fleetRole,
  systemId: SYS1, homeSystemId: SYS1, refitPending: false, operationId: null, composition });
function industrySnap(hulls, fleets) {
  const stations = [{ stationId: "st1", systemId: SYS1, kind: "npc", lines: 2, activeJobs: [], minerals: {}, hulls }];
  return { factionId: 500003, at: AT, round: 3, faction: { status: "ACTIVE", homeSystemId: SYS1 },
    doctrine: { templates: { mining: [{ hullGroup: "mining_frigate", count: 3 }] } }, stationsMode: "ready",
    stations: [{ stationId: "st1", systemId: SYS1 }], neighbors: () => [], systems: [], intel: [], fleets,
    fleetsTruncated: false, operations: [],
    production: { mode: "ready", recipes: {}, stations, inProduction: {}, activeJobsTotal: 0, truncated: false },
    mining: { mode: "ready", sites: [], openByBelt: [], busyFleetIds: [] },
    logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false } };
}

const relFleet = (fleetId, shipCount, extra = {}) => ({ fleetId, version: 3, state: "IDLE", fleetRole: "invasion",
  systemId: 24, refitPending: false, operationId: null, shipCount, ...extra });
function relief(fleets, ships, max = 1, usedIds = []) {
  const snapshot = { faction: { status: "ACTIVE" }, stationsMode: "ready", fleetsTruncated: false,
    operationsTruncated: false, stations: [{ systemId: 24, stationId: "st24" }], production: { mode: "ready" },
    doctrine: { hullsRequired: true }, fleets };
  const used = new Set(usedIds);
  const params = { upkeep: { maxDisbandsPerReview: max }, production: { mobilizeHulls: "required" } };
  const r = planDeficitRelief(snapshot, { stationSystems: [24] }, params, ships === undefined ? undefined
    : { ships }, used);
  return { ...r, used };
}

module.exports = ({ test, skip }) => {
  test("UDR1 planUpkeep Serpentis: flag off = before (abandon, no relief); on: no gain -> no abandon + "
    + "UPKEEP_ABANDON_NO_GAIN + relief 177; detached -> abandoned, no relief; unpaid 2 / empire without A -> no relief",
  () => {
    const off = planUpkeep(serpentis(), null, { upkeep: UP });
    const i0 = off.intents[0];
    assert.deepStrictEqual([i0.income, i0.cost, i0.unpaidPeriodsTo, i0.abandon], [220, 232, 25, [30001045]]);
    assert.ok(!("relief" in off), "off: no relief field");
    assert.deepStrictEqual(planUpkeep(serpentis(), null, { upkeep: { ...ON, deficitReliefEnabled: false } }), off);
    const on = planUpkeep(serpentis(), null, { upkeep: ON });
    assert.deepStrictEqual([on.intents[0].abandon, on.relief], [[], { ships: 177 }]);
    assert.ok(on.notes.includes("UPKEEP_ABANDON_NO_GAIN"), JSON.stringify(on.notes));
    const plainGain = gainOf({ detachedSinceAt: null, factorPermille: 1000 }, UP);
    assert.deepStrictEqual([plainGain, gainOf({ detachedSinceAt: AT, factorPermille: 1000 }, UP)], [0, 3]);
    const cut = planUpkeep(serpentis({ detached: true }), null, { upkeep: ON });
    assert.deepStrictEqual([cut.intents[0].abandon, cut.relief], [[30001000], undefined]);
    assert.ok(!cut.notes.includes("UPKEEP_ABANDON_NO_GAIN"));
    const fresh = planUpkeep(serpentis({ unpaid: 1 }), null, { upkeep: ON });
    assert.deepStrictEqual([fresh.unpaidPeriods, "relief" in fresh], [2, false]);
    const empire = planUpkeep(serpentis({ kind: "empire" }), null, { upkeep: ON });
    assert.strictEqual("relief" in empire, false, "empire without homeSpaceIncomeEnabled");
    const empireA = planUpkeep(serpentis({ kind: "empire" }), null, { upkeep: { ...ON, homeSpaceIncomeEnabled: true } });
    assert.deepStrictEqual(empireA.relief, { ships: 177 });
  });

  test("UDR2 planUpgrades maxGrowth: mining +3 skipped at 0 (UPGRADE_DEFICIT, ledger untouched), passes at 3; "
    + "logistics N -> 1 passes at 0; undefined = before", () => {
    const venture = [{ hullGroup: "mining_frigate", count: 3 }];
    const mining = () => industrySnap({ porpoise: 1, exhumer: 2 }, [fleetOf("m1", "mining", venture)]);
    const s = mining();
    const before = planUpgrades(s, IPARAMS, createHullLedger(s, IPARAMS));
    assert.strictEqual(before.intents.length, 1, JSON.stringify(before));
    const ledger = createHullLedger(s, IPARAMS);
    const blocked = planUpgrades(s, IPARAMS, ledger, { maxGrowth: 0 });
    assert.deepStrictEqual([blocked.intents, blocked.notes, ledger.available("st1", "exhumer")],
      [[], ["UPGRADE_DEFICIT"], 2]);
    assert.deepStrictEqual(planUpgrades(s, IPARAMS, createHullLedger(s, IPARAMS), { maxGrowth: 3 }), before);
    assert.deepStrictEqual(planUpgrades(s, IPARAMS, createHullLedger(s, IPARAMS), undefined), before);
    assert.deepStrictEqual(planUpgrades(s, IPARAMS, createHullLedger(s, IPARAMS), { maxGrowth: null }), before);
    const hauler = industrySnap({ freighter: 1 }, [fleetOf("l1", "logistics", [{ hullGroup: "industrial", count: 2 },
      { hullGroup: "frigate", count: 2 }])]);
    const lg = planUpgrades(hauler, IPARAMS, createHullLedger(hauler, IPARAMS), { maxGrowth: 0 });
    assert.deepStrictEqual([lg.fleetIds, lg.notes], [["l1"], ["FLEET_UPGRADE_LOGISTICS"]]);
  });

  test("UDR3 planDeficitRelief: smallest IDLE invasion in the station system; HOLDING, garrison, outside, used "
    + "skipped; max 2 with relief below the first fleet -> 1 intent; no candidate -> UPKEEP_DEMOBILIZE_NO_FLEET", () => {
    const fleets = [relFleet("a", 12), relFleet("b", 8), relFleet("c", 3, { state: "HOLDING" }),
      relFleet("d", 2, { fleetRole: "garrison" }), relFleet("e", 1, { systemId: 25 }), relFleet("f", 2)];
    const r = relief(fleets, 177, 1, ["f"]);
    assert.deepStrictEqual(r.intents, [{ type: "DISBAND", fleetId: "b", expectedVersion: 3, systemId: 24,
      stationId: "st24", reason: "UPKEEP", returnHulls: true, fleetRole: "invasion" }]);
    assert.deepStrictEqual(r.notes, ["UPKEEP_DEMOBILIZE:8"]);
    assert.ok(r.used.has("b"));
    const small = relief(fleets, 5, 2, ["f"]);
    assert.deepStrictEqual([small.intents.map((i) => i.fleetId), small.notes], [["b"], ["UPKEEP_DEMOBILIZE:8"]]);
    const none = relief([relFleet("d", 2, { fleetRole: "garrison" }), relFleet("e", 1, { systemId: 25 })], 177);
    assert.deepStrictEqual([none.intents, none.notes], [[], ["UPKEEP_DEMOBILIZE_NO_FLEET"]]);
    assert.deepStrictEqual([relief(fleets, undefined).notes, relief(fleets, 0).notes, relief(fleets, 9, 0).notes],
      [[], [], []]);
  });

  test("UDR6: 30 detached systems (base 142 > income 130 - margin), unpaid 5, flag on -> no relief "
    + "UPKEEP_DEMOBILIZE_NO_GAIN; flag off -> no note; ships make the gap (unpaid 5) -> relief 177", () => {
    const cut = planUpkeep(serpentis({ unpaid: 5, detachedCount: 30 }), null, { upkeep: ON });
    assert.deepStrictEqual([cut.intents[0].income, cut.intents[0].cost, cut.unpaidPeriods, cut.intents[0].abandon],
      [130, 232, 6, []]);
    assert.strictEqual("relief" in cut, false, JSON.stringify(cut.relief));
    assert.ok(cut.notes.includes("UPKEEP_DEMOBILIZE_NO_GAIN"), JSON.stringify(cut.notes));
    const off = planUpkeep(serpentis({ unpaid: 5, detachedCount: 30 }), null, { upkeep: UP });
    assert.ok(!off.notes.includes("UPKEEP_DEMOBILIZE_NO_GAIN") && !("relief" in off));
    const ships = planUpkeep(serpentis({ unpaid: 5 }), null, { upkeep: ON });
    assert.deepStrictEqual([ships.relief, ships.notes.includes("UPKEEP_DEMOBILIZE_NO_GAIN")], [{ ships: 177 }, false]);
  });

  test("UDR7: upgradeGrowthOf - police / empire without A with shipRoom 0, unpaid 0 -> null (the "
    + "upgrade as without the flag); pirate -> shipRoom; unpaid > 0 -> 0 for any kind; flag off -> undefined", () => {
    const P = { ...ON, shipCapEnabled: true };
    const snap = (kind) => ({ entry: { kind } });
    const plan = { unpaidPeriods: 0, shipRoom: 0 };
    assert.deepStrictEqual([upgradeGrowthOf(snap("police"), plan, P), upgradeGrowthOf(snap("empire"), plan, P),
      upgradeGrowthOf(snap("empire"), plan, { ...P, homeSpaceIncomeEnabled: true }),
      upgradeGrowthOf(snap("pirate"), plan, P), upgradeGrowthOf(snap("police"), { unpaidPeriods: 2, shipRoom: 5 }, P),
      upgradeGrowthOf(snap("pirate"), { unpaidPeriods: 0 }, P),
      upgradeGrowthOf(snap("police"), plan, { ...P, deficitReliefEnabled: false })],
    [null, null, 0, 0, 0, null, undefined]);
    const s = industrySnap({ porpoise: 1, exhumer: 2 }, [fleetOf("m1", "mining",
      [{ hullGroup: "mining_frigate", count: 3 }])]);
    const before = planUpgrades(s, IPARAMS, createHullLedger(s, IPARAMS));
    const police = planUpgrades(s, IPARAMS, createHullLedger(s, IPARAMS),
      { maxGrowth: upgradeGrowthOf(snap("police"), plan, P) });
    assert.deepStrictEqual([police, before.intents.length], [before, 1]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  async function demobilizeRun(reopen, on) {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const holder = { fleetId: null, row: null, injected: false, mark: false, effect: null };
    const hooks = { beforeEffect: (d, snapshot) => {
      if (holder.injected || d.factionId !== R.AMARR || !d.intents.some((i) => i.type === "FACTION_TOUCH")) return d;
      const f = snapshot.fleets.find((x) => x.fleetId === holder.fleetId);
      if (!f) return d;
      holder.injected = true;
      holder.mark = true;
      return { ...d, intents: [{ type: "DISBAND", fleetId: f.fleetId, expectedVersion: f.version,
        systemId: holder.row.system_id, stationId: holder.row.station_id, reason: "UPKEEP", returnHulls: true,
        fleetRole: "invasion" }, ...d.intents.filter((i) => i.type === "FACTION_TOUCH")] };
    } };
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && holder.mark) {
        holder.mark = false;
        holder.effect = r.effect;
      }
      return r;
    }, o) });
    const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_DEFICIT_RELIEF_ENABLED: on ? "1" : "0", EVEJS_LNE_STRATEGY_STRANDED_RETURN_ENABLED: "0" },
    { hooks, production: true, wrapScheduler });
    holder.row = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", R.AMARR)[0];
    assert.ok(holder.row, "an Amarr station");
    const created = env.fleets.createFleet({ factionId: R.AMARR, currentSystemId: holder.row.system_id,
      homeSystemId: holder.row.system_id, fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 2 }] },
    "udr4:relief");
    assert.ok(created.ok, JSON.stringify(created));
    holder.fleetId = created.fleetId;
    const cruisers = () => (env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND "
      + "item_key = 'group:cruiser'", holder.row.station_id)[0] || { quantity: 0 }).quantity;
    const before = cruisers();
    await R.passesAt(env, shared, R.START_MS + R.I);
    const state = () => env.q("SELECT state FROM virtual_fleets WHERE fleet_id = ?", created.fleetId)[0].state;
    const out = { injected: holder.injected, added: cruisers() - before, state: state(),
      review: env.strategy.getStatus().ai.review };
    if (on && holder.effect) {
      const replay = env.tx((db) => holder.effect(db));
      out.replay = { ok: replay.ok, disband: replay.applied ? replay.applied.DISBAND : null,
        added: cruisers() - before, state: state() };
    }
    env.strategy.stop("test");
    env.production.stop("test");
    return out;
  }

  needsDriver("UDR4 real store: DISBAND UPKEEP with the flag -> DESTROYED, hulls back, upkeepDisband* counters; the "
    + "replayed effect is a duplicate; flag off -> DISBAND_ROLE_INVALID, nothing written", async () => {
    const on = await H.withStore(driver, (reopen) => demobilizeRun(reopen, true));
    const c = on.review.counters;
    assert.deepStrictEqual([on.injected, on.state, on.added], [true, "DESTROYED", 2], JSON.stringify(on.review));
    assert.deepStrictEqual([c.upkeepDisbanded, c.upkeepDisbandShips, c.upkeepDisbandHullsLost, c.upkeepDisbandRefused,
      c.logisticsDisbanded, c.strandedDisbanded, c.logisticsRetireRefused], [1, 2, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(on.replay, { ok: true, disband: undefined, added: 2, state: "DESTROYED" });
    const off = await H.withStore(driver, (reopen) => demobilizeRun(reopen, false));
    const k = off.review.counters;
    assert.deepStrictEqual([off.injected, off.state, off.added, off.review.lastRefusal],
      [true, "IDLE", 0, "DISBAND:DISBAND_ROLE_INVALID"]);
    assert.deepStrictEqual([k.upkeepDisbanded, k.upkeepDisbandRefused, k.logisticsRetireRefused], [0, 1, 0]);
  });

  test("UDR5 reviewRowBound: on = off - abandonRows + max(abandonRows, 23), no overflow at a limit of 1300 (compose default before) "
    + "params.upkeep "
    + "has the 4 new keys; warning without upkeep.enabled", () => {
    const offC = DEF;
    const LIMIT = { EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "1300" };
    const onR = config.resolveConfig({ modDir: MOD_DIR, env: { ...LIMIT, EVEJS_LNE_UPKEEP_DEFICIT_RELIEF_ENABLED: "1" } });
    assert.deepStrictEqual(onR.errors, []);
    assert.deepStrictEqual(onR.warnings.filter((w) => w.startsWith("one strategy review may write")), []);
    const abandonRows = offC.upkeep.maxAbandonsPerReview * (UPKEEP_ABANDON_ROWS + offC.world.maxFactionsPerSystem);
    assert.strictEqual(UPKEEP_DISBAND_ROWS, 23);
    const offB = rowBoundsOfConfig(offC);
    const onB = rowBoundsOfConfig(onR.config);
    assert.strictEqual(onB.review, offB.review - abandonRows + Math.max(abandonRows, 23));
    assert.strictEqual(rowBoundOverflow(onB, onR.config.persistence.maxRowsPerTransaction), null);
    console.log(`     UDR5 review bound: off=${offB.review} on=${onB.review} (abandonRows ${abandonRows})`);
    const svc = (c) => createReviewService({ store: {}, journal: {},
      strategyRepository: { limits: { maxResourceUnits: 1 } }, intelRepository: {}, registry: {},
      kinds: { list: [], get: () => null }, powerTable: {}, scoring: {}, scheduler: {}, fleets: {},
      clock: { now: () => 0 }, worldSeed: 1, config: c, hostility: () => true, isCampaignOk: () => true,
      industryCatalog: {} });
    assert.deepStrictEqual(NEW_KEYS.map((k) => svc(offC).params.upkeep[k]), [false, 3, 20, 1]);
    assert.strictEqual(svc(onR.config).params.upkeep.deficitReliefEnabled, true);
    const warned = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_UPKEEP_DEFICIT_RELIEF_ENABLED: "1",
      EVEJS_LNE_UPKEEP_ENABLED: "0" } }).warnings;
    assert.ok(warned.includes("upkeep.deficitReliefEnabled without upkeep.enabled - no effect"), warned.join("; "));
  });
};
