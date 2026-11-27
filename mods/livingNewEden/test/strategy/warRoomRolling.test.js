"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startTrade } = require("../../lib/economy/trade");
const { startTreasury } = require("../../lib/economy/treasury");
const { warRoomOf, warRoomRollingOf, DAY_MS } = require("../../lib/strategy/ai/warChest");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { decideReview } = require("../../lib/strategy/ai");
const { createHullValueTable } = require("../../lib/economy/treasury/hullValues");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const { REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE } = require("../../lib/economy/data/mineralRefPrices");
const { treasuryParamsOf, TREASURY_PARAM_KEYS } = require("../../lib/strategy/reviewService");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const DAY = DAY_MS;
const HOUR = 3600000;
const B = 24e9;
const T0 = Object.freeze({ savingsDrawPermillePerDay: 0, lossesInRoomPermille: 300 });
const BASE = Object.freeze({ balanceIsk: 0, incomeDaily: B, fleetUpkeepDaily: 0, adminDaily: 0 });
const spend = (warSpend, extra = {}) => ({ warSpend, productionFees: 0, tradeOut: 0, losses: 0, ...extra });
const ZERO = Object.freeze(spend(0));

const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("RW1 warRoomRollingOf: quarter day 7e9 (calendar 4e9), midnight 4e9 (calendar 0), yesterday null, losses, "
    + "saturation", () => {
    const a = warRoomRollingOf({ ...BASE, at: 10 * DAY + DAY / 4, today: spend(2e9), yesterday: spend(20e9) }, T0);
    assert.deepStrictEqual(a, { dayBudget: B, accrued: B, spentToday: 2e9, spentYesterdayShare: 15e9,
      spentWindow: 17e9, room: 7e9 });
    assert.strictEqual(warRoomOf({ ...BASE, at: 10 * DAY + DAY / 4, today: spend(2e9) }, T0).room, 4e9);
    const b = warRoomRollingOf({ ...BASE, at: 11 * DAY, today: null, yesterday: spend(20e9) }, T0);
    assert.deepStrictEqual([b.spentYesterdayShare, b.room], [20e9, 4e9]);
    assert.strictEqual(warRoomOf({ ...BASE, at: 11 * DAY, today: null }, T0).room, 0);
    const c = warRoomRollingOf({ ...BASE, at: 10 * DAY + 5 * HOUR, today: spend(3e9), yesterday: null }, T0);
    assert.deepStrictEqual([c.spentYesterdayShare, c.room], [0, B - 3e9]);
    const d = warRoomRollingOf({ ...BASE, at: 11 * DAY, today: null, yesterday: spend(0, { losses: 10e9 }) }, T0);
    assert.deepStrictEqual([d.spentYesterdayShare, d.room], [3e9, 21e9]);
    const big = spend(1e15, { productionFees: 1e15, tradeOut: 1e15, losses: 1e15 });
    const e = warRoomRollingOf({ balanceIsk: 1e15, incomeDaily: 1e15, fleetUpkeepDaily: 0, adminDaily: 0,
      at: 11 * DAY + 7, today: big, yesterday: big }, { savingsDrawPermillePerDay: 1000, lossesInRoomPermille: 1000 });
    for (const v of Object.values(e)) assert.ok(Number.isSafeInteger(v) && v >= 0 && v <= 1e15, JSON.stringify(e));
    assert.deepStrictEqual([e.dayBudget, e.spentWindow, e.room], [1e15, 1e15, 0]);
  });

  test("RW2 properties: yesterday = B -> rolling = calendar +-1; greedy 3 days: day spend <= B, 00:00 room = "
    + "max(0, B - yesterday)", () => {
    const today = spend(1e9);
    const ats = [...Array.from({ length: 48 }, (_, i) => i * (HOUR / 2)), DAY - 1];
    assert.strictEqual(ats.length, 49);
    for (const f of ats) {
      const at = 20 * DAY + f;
      const r = warRoomRollingOf({ ...BASE, at, today, yesterday: spend(B) }, T0).room;
      const k = warRoomOf({ ...BASE, at, today }, T0).room;
      assert.ok(Math.abs(r - k) <= 1, `f ${f}: ${r} vs ${k}`);
    }
    const spent = new Map();
    for (let h = 0; h < 72; h += 1) {
      const at = 30 * DAY + h * HOUR;
      const day = Math.floor(at / DAY);
      const room = () => warRoomRollingOf({ ...BASE, at, today: spent.has(day) ? spend(spent.get(day)) : null,
        yesterday: spent.has(day - 1) ? spend(spent.get(day - 1)) : null }, T0).room;
      if (h % 24 === 0) {
        assert.strictEqual(room(), Math.max(0, B - (spent.get(day - 1) || 0)), `00:00 of day ${day}`);
      }
      for (let r = room(), n = 0; r > 0 && n < 100; r = room(), n += 1) {
        spent.set(day, (spent.get(day) || 0) + Math.min(r, 1e9));
      }
    }
    assert.strictEqual(spent.size, 3);
    for (const [day, v] of spent) assert.ok(v <= B, `day ${day}: ${v}`);
  });

  needsDriver("RW3 readForReview: flag on -> today/yesterday of day/day-1, only day-2 -> null + zeros, day+1 ignored; "
    + "flag off -> no yesterday", () => H.withStore(driver, async (reopen) => {
    const F = 500003;
    const shared = H.sharedOf();
    const opened = reopen();
    const on = { EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TRADE_CONTRACTS_ENABLED: "0",
      EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1" };
    const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
    const serviceOf = (env) => {
      const cfg = resolve(env).config;
      const persistence = { ok: true, store: opened.store, journal };
      const tr = startTrade({ config: cfg, persistence, clock: shared.clock, ids: shared.ids });
      assert.ok(tr.ok, JSON.stringify(tr));
      const t = startTreasury({ config: cfg, persistence, clock: shared.clock, getTrade: () => tr.trade });
      assert.ok(t.ok, JSON.stringify(t));
      return t.treasury;
    };
    const tx = (fn) => {
      const r = opened.store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const rolling = serviceOf({ ...on, EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED: "1" });
    const calendar = serviceOf(on);
    const D = 20000;
    const at = D * DAY + 3 * HOUR;
    const put = (day, v) => tx((db) => db.prepare(`INSERT INTO world_faction_treasury_days (faction_id, day,
      production_fees, losses, trade_out, war_spend, balance_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1)`)
      .run(F, day, v, v + 1, v + 2, v + 3));
    const clear = () => tx((db) => db.prepare("DELETE FROM world_faction_treasury_days WHERE faction_id = ?").run(F));
    const read = (s) => {
      const r = tx((db) => s.readForReview(db, F, { at, npcStations: 0, kind: "empire" }));
      assert.ok(r.ok, JSON.stringify(r));
      return r.treasury;
    };
    const want = (v) => ({ tradeOut: v + 2, warSpend: v + 3, productionFees: v, losses: v + 1 });

    put(D, 100);
    put(D - 1, 200);
    const both = read(rolling);
    assert.deepStrictEqual([both.today, both.yesterday, both.factionTradeOutToday], [want(100), want(200), 102]);
    const off = read(calendar);
    assert.ok(!("yesterday" in off), JSON.stringify(off));
    const { yesterday: _y, ...rest } = both;
    assert.deepStrictEqual(off, rest);

    clear();
    put(D - 2, 300);
    const old = read(rolling);
    assert.deepStrictEqual([old.today, old.yesterday], [{ tradeOut: 0, warSpend: 0, productionFees: 0, losses: 0 },
      null]);

    clear();
    put(D + 1, 400);
    put(D, 500);
    const ahead = read(rolling);
    assert.deepStrictEqual([ahead.today, ahead.yesterday], [want(500), null]);
  }));

  test("RW4 decideReview: flag false = no key; true at 01:00 with an unspent yesterday -> capture LAUNCH the calendar "
    + "refuses, warChest.spentWindow = warRoomRollingOf", () => {
    const AMARR = 500003;
    const SANSHA = 500019;
    const SAMINER = 30001721;
    const AT = Math.floor(1760000000000 / DAY) * DAY + HOUR;
    const kinds = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
      { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
    assert.ok(kinds.ok, JSON.stringify(kinds));
    const graph = (() => {
      const built = buildUniverseGraph(k3StaticMap());
      assert.ok(built.ok);
      return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 16, maxJumps: 40 }).publicApi });
    })();
    const registry = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
      operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
      maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 }).registry;
    const theatre = [...registry.getCampaign("k3-stain").systemIds].sort((a, b) => a - b);
    const hostility = createHostility();
    const resolved = (env) => resolve({ EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1",
      ...env }).config;
    const tCal = treasuryParamsOf(resolved({}));
    const tRoll = treasuryParamsOf(resolved({ EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED: "1" }));
    assert.deepStrictEqual([tCal.warRoomRollingEnabled, tRoll.warRoomRollingEnabled], [false, true]);
    const { warRoomRollingEnabled: _w, ...bare } = tCal;
    const c = resolve({}).config;
    const values = createHullValueTable(createRecipeTable(RECIPES, recipeParamsOf(c.production)), REF_PRICE_MILLI,
      HULL_VALUE_FACTOR_PERMILLE).all();
    const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
    const PROD = { maxJobsPerReview: 8, maxRunsPerJob: 2, maxActiveJobsPerFaction: 64, targetStockFleets: 4,
      mobilizeHulls: "legacy", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] };
    const P = { maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5, maxAssemblyJumps: 15,
      maxBfsSystems: 2000, mobilizeFallbackJumps: 30, mobilizeFallbackMaxSystems: 9000, maxTargetCandidates: 40,
      targetPickTopK: 3, maxOperationsPerReview: 1, maxFleetsPerOperation: 4, maxFleetsPerFaction: 12,
      maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1, attackStrengthRatio: 1.2,
      intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR,
      operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2, kinds: kinds.kinds.list,
      scoring: TARGET_SCORING_V1, powerTable: buildPowerTable(GROUPS), frontLimitCap: 2, routeMaxJumps: 40,
      maxCapturedSystemsPerFaction: 24, captureRequiresAdjacency: false, defense: { enabled: true, maxPerReview: 1 },
      maxThreatsRead: 32, maxLostHomeRead: 32, production: PROD };
    const plenty = Object.fromEntries(Object.keys(RECIPES.GROUPS).flatMap((g) => Object.keys(RECIPES.GROUPS[g]
      .minerals)).map((k) => [k, 1e12]));
    const snap = () => {
      const entry = registry.getFaction(AMARR);
      const doctrine = registry.getDoctrine(entry.doctrineId);
      const ids = [...new Set([...theatre, SAMINER])].sort((a, b) => a - b);
      return { v: 1, factionId: AMARR, round: 7, at: AT, seed: 12345,
        faction: { status: "ACTIVE", homeSystemId: entry.hqSystemId, doctrineId: doctrine.doctrineId,
          resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
        entry: { kind: entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
          homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
        doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
          operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates,
          fieldsDefense: doctrine.fieldsDefense, captureTargets: doctrine.captureTargets },
        theatre, neighbors: (id) => graph.getNeighbors(id),
        regionOf: (id) => (graph.getSystem(id) ? graph.getSystem(id).regionId : null),
        isHostile: (x) => x !== AMARR && !entry.allies.includes(x) && hostility(AMARR, x),
        stationsMode: "ready", stations: [{ systemId: SAMINER, stationId: "st0" }], captureAnchors: [SAMINER],
        systems: ids.map((systemId) => ({ systemId, controllerFactionId: theatre.includes(systemId) ? SANSHA : null,
          occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, homeFactionId: null })),
        fleets: [{ fleetId: "f1", version: 1, state: "IDLE", fleetRole: "invasion", systemId: SAMINER,
          refitPending: false, shipCount: 4, strength: 1e6, operationId: null, legSeq: 0, homeSystemId: SAMINER,
          composition: [{ hullGroup: "cruiser", count: 4, typeId: null }] }],
        fleetsTruncated: false, operations: [], operationsTruncated: false,
        intel: theatre.map((systemId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
          hostileStrength: 0, hostileStations: 0, controllerFactionId: SANSHA })), sightings: [],
        threats: { mode: "off", items: [] }, lostHome: { mode: "off", systemIds: [] }, capturedIds: [],
        upkeep: { mode: "off" }, territoryTruncated: false, occupations: [],
        production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0,
          truncated: false, stations: [{ stationId: "st0", systemId: SAMINER, kind: "npc", lines: 16, activeJobs: [],
            minerals: plenty, hulls: {} }] },
        treasury: { mode: "ready", seeded: true, kind: "empire", initialIsk: 5e12, balanceIsk: 4e11,
          accountMode: "NORMAL", paidUntil: AT - HOUR, valueByGroup: values, tradeHeldIsk: 0, tradeEligible: true,
          factionTradeOutToday: 0, galaxyTradeOutToday: 0, today: ZERO, yesterday: ZERO } };
    };
    const cal = decideReview(snap(), { ...P, treasury: tCal });
    assert.strictEqual(cal.outcome, "REVIEWED", cal.reason);
    assert.deepStrictEqual(decideReview(snap(), { ...P, treasury: bare }), cal);
    assert.deepStrictEqual(Object.keys(cal.warChest), ["dayBudget", "room", "spentToday"]);
    const captures = (d) => d.intents.filter((i) => i.type === "LAUNCH" && i.warIsk === tCal.captureLaunchIsk);
    assert.ok(cal.warChest.room < tCal.captureLaunchIsk, JSON.stringify(cal.warChest));
    assert.deepStrictEqual(captures(cal), [], JSON.stringify(cal.intents));
    assert.ok(cal.notes.includes("WAR_CHEST_SHORT"), cal.notes.join());

    const roll = decideReview(snap(), { ...P, treasury: tRoll });
    assert.strictEqual(roll.outcome, "REVIEWED", roll.reason);
    const upkeep = Math.floor((4 * values.cruiser * tRoll.fleetUpkeepPermillePerDay) / 1000);
    const want = warRoomRollingOf({ balanceIsk: 4e11, incomeDaily: tRoll.baseIncomeIskPerDayEmpire,
      fleetUpkeepDaily: upkeep, adminDaily: 0, at: AT, today: ZERO, yesterday: ZERO }, tRoll);
    assert.deepStrictEqual(roll.warChest, { dayBudget: want.dayBudget, room: want.room, spentToday: want.spentToday,
      spentWindow: want.spentWindow });
    assert.strictEqual(captures(roll).length, 1, `${JSON.stringify(roll.intents)} ${roll.notes.join()}`);
    assert.ok(!roll.notes.includes("WAR_CHEST_SHORT"), roll.notes.join());
  });

  test("RW5 config: SCHEMA row, TREASURY_PARAM_KEYS, .env.example, compose :-0, warning", () => {
    const row = config.SCHEMA.find((r) => r.key === "treasury.warRoomRollingEnabled");
    assert.ok(row);
    assert.deepStrictEqual([row.type, row.default, row.env], ["boolean", false,
      "EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED"]);
    assert.ok(TREASURY_PARAM_KEYS.includes("warRoomRollingEnabled"));
    const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    assert.ok(example.includes("# EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED="));
    const compose = fs.readFileSync(path.join(REPO_DIR, "compose.yaml"), "utf8");
    assert.ok(compose.includes("EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED: "
      + "${EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED:-0}"));
    const warn = (env) => resolve({ EVEJS_LNE_TREASURY_ENABLED: "1", ...env }).warnings
      .filter((w) => w.startsWith("treasury.warRoomRollingEnabled"));
    assert.strictEqual(warn({ EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED: "1" }).length, 1);
    assert.strictEqual(warn({ EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED: "1",
      EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1" }).length, 0);
  });
};
