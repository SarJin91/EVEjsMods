"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const { resolveConfig } = require("../../../config");
const { logisticsParamsOf } = require("../../../lib/strategy/reviewService");
const { planLogistics } = require("../../../lib/strategy/ai/logistics");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const RECIPES = require("../../../lib/economy/data/hullRecipes");
const { HULL_GROUPS } = require("../../../lib/fleets/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AMARR = 500003;
const SAMINER = 30001721;
const HOME = 30001868;
const AT = 1760000000000;
const TRIT = "type:34";
const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
const PROD = Object.freeze({ maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });

function paramsOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return { production: PROD, maxBfsSystems: 2000, mobilizeResourcePerShip: 1, mobilizeReservePerShip: 0,
    logistics: logisticsParamsOf(r.config, null) };
}

const st = (stationId, systemId, minerals, activeJobs = [], lines = 2) => ({
  stationId, systemId, kind: "npc", lines, activeJobs, minerals, hulls: {}, deficit: {} });

function plan(env, dests, carriers = 2, srcStock = 10000000) {
  const P = paramsOf(env);
  const src = HOME + 10;
  const s = { v: 1, factionId: AMARR, round: 7, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: HOME, doctrineId: "d", resourceUnits: 20000, reserveUnits: 300,
      frontLimit: 1, version: 3 },
    doctrine: { doctrineId: "d", canOccupy: false, operationTypes: [], reachJumps: 10,
      templates: { invasion: [{ hullGroup: "cruiser", count: 5 }], logistics: [{ hullGroup: "industrial", count: 2 }] } },
    stationsMode: "ready", stations: [{ systemId: SAMINER, stationId: "stM" }], systems: [],
    neighbors: () => [], regionOf: () => null, isHostile: () => false,
    fleets: ["lf1", "lf2", "lf3"].map((fleetId) => ({ fleetId, state: "IDLE", fleetRole: "logistics", systemId: src,
      composition: [{ hullGroup: "industrial", count: carriers }], refitPending: false, version: 1 })),
    production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0, truncated: false,
      stations: [st("stM", SAMINER, {}, [{ hullGroup: "cruiser", runs: 1 }]),
        ...dests.map((d, i) => st(d, HOME + i, { [TRIT]: 100 })),
        st("stSrc", src, { [TRIT]: srcStock }, [], 0)] },
    logistics: { mode: "ready", open: [], busyFleetIds: [], truncated: false,
      carriers: { lf1: carriers, lf2: carriers, lf3: carriers } } };
  const ledger = createHullLedger(s, { production: PROD });
  const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
  const out = planLogistics(s, supply, P, { intents: [] }, ledger, null);
  const toDests = out.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY"
    && dests.includes(i.destStationId));
  return { out, toDests };
}

module.exports = ({ test }) => {
  test("NC1: logistics.maxMineralConvoysPerReview / mineralSurplusThreshold from env reach the AI "
    + "(0 honoured, no literal fallback)", () => {
    const dests = ["stA", "stB", "stC"];
    const P = paramsOf({});
    assert.strictEqual(P.logistics.mineralConvoyMinLoad, 100);
    assert.strictEqual(P.logistics.maxMineralConvoysPerReview, 4);
    assert.strictEqual(P.logistics.mineralSurplusThreshold, 1000);
    assert.strictEqual(P.logistics.maxHullConvoysPerReview, 8);
    assert.strictEqual(plan({}, dests).toDests.length, 2);
    assert.strictEqual(plan({ EVEJS_LNE_LOGISTICS_MAX_MINERAL_CONVOYS_PER_REVIEW: "1" }, dests).toDests.length, 1);
    assert.strictEqual(plan({ EVEJS_LNE_LOGISTICS_MAX_MINERAL_CONVOYS_PER_REVIEW: "0" }, dests).toDests.length, 0);
    assert.strictEqual(plan({}, ["stA"], 2, 50000).toDests.length, 1);
    assert.strictEqual(plan({ EVEJS_LNE_LOGISTICS_MINERAL_SURPLUS_THRESHOLD: "100000" }, ["stA"], 2, 50000)
      .toDests.length, 0);
  });

  test("NC2: mineralConvoyMinLoad from env - a MINERALS_TO_FACTORY cargo cut by the carrier capacity "
    + "below the threshold -> LOGISTICS_SMALL_LOAD (the threshold was NaN before)", () => {
    const tiny = { EVEJS_LNE_LOGISTICS_CARRIER_CAPACITY_M3: "1" };
    const ok = plan(tiny, ["stA"], 1);
    assert.deepStrictEqual(ok.toDests.map((i) => i.items.reduce((n, it) => n + it.quantity, 0)), [100]);
    const refused = plan({ ...tiny, EVEJS_LNE_LOGISTICS_MINERAL_CONVOY_MIN_LOAD: "5000" }, ["stA"], 1);
    assert.deepStrictEqual(refused.toDests, []);
    assert.ok(refused.out.notes.includes("LOGISTICS_SMALL_LOAD"), JSON.stringify(refused.out.notes));
  });
};
