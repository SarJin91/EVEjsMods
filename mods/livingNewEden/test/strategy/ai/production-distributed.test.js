"use strict";

const assert = require("node:assert");
const { planProduction, hullTargets } = require("../../../lib/strategy/ai/production");
const RECIPES = require("../../../lib/economy/data/hullRecipes");
const { HULL_GROUPS } = require("../../../lib/fleets/schema");

const AMARR = 500003;
const SAMINER = 30001721;
const HOME = 30001868;
const AT = 1760000000000;

const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));

const PROD = Object.freeze({ maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });

const times = (g, n) => Object.fromEntries(Object.entries(RECIPES.GROUPS[g].minerals).map(([k, v]) => [k, v * n]));
const st = (stationId, systemId, minerals, hulls = {}, activeJobs = [], lines = 2) => ({
  stationId, systemId, kind: "npc", lines, activeJobs, minerals, hulls });
const prodOf = (stations, extra = {}) => ({ mode: "ready", recipesVersion: 1, recipes, inProduction: {},
  activeJobsTotal: 0, truncated: false, stations, ...extra });
const snap = (factionId, o = {}) => ({
  v: 1, factionId, round: 7, at: AT, seed: 12345,
  faction: { status: "ACTIVE", homeSystemId: HOME, doctrineId: "d", resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
  doctrine: { doctrineId: "d", canOccupy: false, operationTypes: [], reachJumps: 10,
    templates: { invasion: [{ hullGroup: "cruiser", count: 5 }] } },
  stationsMode: "ready",
  stations: (o.stations || [SAMINER]).map((systemId, i) => ({ systemId, stationId: "st" + i })),
  systems: [],
  neighbors: () => [],
  regionOf: () => null,
  isHostile: () => false,
  production: o.production || prodOf([]),
});

module.exports = ({ test }) => {
  test("production-distributed: job in non-mobilization station", () => {
    const P = { ...PROD, mobilizationStations: 1 };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, times("cruiser", 4), {}, [], 2),
    ]);
    const plan = planProduction(s, null, { production: P });
    const cruiserJobs = plan.intents.filter((i) => i.hullGroup === "cruiser");
    assert.ok(cruiserJobs.length > 0, "at least one cruiser job: " + JSON.stringify(plan.intents));
    const stAJobs = cruiserJobs.filter((i) => i.stationId === "stA");
    assert.ok(stAJobs.length > 0, "non-M station stA gets a job: " + JSON.stringify(plan.intents));
    const totalRuns = stAJobs.reduce((n, i) => n + i.runs, 0);
    assert.strictEqual(totalRuns, 4, "stA produces 4 runs to cover M's deficit of 4: " + totalRuns);
  });

  test("production-distributed: central deficit not double counted", () => {
    const P = { ...PROD, mobilizationStations: 1, maxJobsPerReview: 8 };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [], 2),
      st("stA", HOME, times("cruiser", 3), {}, [], 2),
      st("stB", HOME + 1, times("cruiser", 2), {}, [], 2),
    ]);
    const plan = planProduction(s, null, { production: P });
    const cruiserJobs = plan.intents.filter((i) => i.hullGroup === "cruiser");
    const totalRuns = cruiserJobs.reduce((n, i) => n + i.runs, 0);
    assert.strictEqual(totalRuns, 5, "total runs = M's deficit (5), not double counted: " + JSON.stringify(plan.intents));
    const byStation = {};
    for (const i of cruiserJobs) byStation[i.stationId] = (byStation[i.stationId] || 0) + i.runs;
    assert.strictEqual(byStation["stA"], 3, "A produces 3");
    assert.strictEqual(byStation["stB"], 2, "B produces 2");
    assert.strictEqual(byStation["stM"], undefined, "M has no minerals, produces nothing");
  });

  test("production-distributed: maxJobsPerReview respected", () => {
    const P = { ...PROD, mobilizationStations: 1, maxJobsPerReview: 2 };
    const s = snap(AMARR);
    const stations = [st("stM", SAMINER, {}, {}, [], 2)];
    for (let i = 0; i < 10; i += 1) {
      stations.push(st("st" + i, HOME + i, times("cruiser", 10), {}, [], 2));
    }
    s.production = prodOf(stations);
    const plan = planProduction(s, null, { production: P });
    assert.ok(plan.intents.length <= 2, "maxJobsPerReview=2 limits intents: " + plan.intents.length);
    for (const i of plan.intents) {
      assert.strictEqual(i.type, "PRODUCE", "all intents are PRODUCE: " + JSON.stringify(i));
    }
  });
};