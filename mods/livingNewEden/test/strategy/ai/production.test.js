"use strict";

const assert = require("node:assert");
const { planProduction, affordableRuns } = require("../../../lib/strategy/ai/production");
const RECIPES = require("../../../lib/economy/data/hullRecipes");
const { HULL_GROUPS } = require("../../../lib/fleets/schema");

const AMARR = 500003;
const SAMINER = 30001721;
const HOME = 30001868;
const AT = 1760000000000;

const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));

const PROD = Object.freeze({
  maxJobsPerReview: 8,
  maxRunsPerJob: 4,
  maxActiveJobsPerFaction: 8,
  targetStockFleets: 1,
  mobilizeHulls: "required",
  miningNeedsHulls: false,
  mobilizationStations: 1,
  hullGroups: [...HULL_GROUPS]
});

const times = (g, n) => Object.fromEntries(Object.entries(RECIPES.GROUPS[g].minerals).map(([k, v]) => [k, v * n]));
const st = (stationId, systemId, minerals, hulls = {}, activeJobs = [], lines = 2) => ({
  stationId, systemId, kind: "npc", lines, activeJobs, minerals, hulls
});
const prodOf = (stations, extra = {}) => ({ mode: "ready", recipesVersion: 1, recipes, inProduction: {},
  activeJobsTotal: 0, truncated: false, stations, ...extra });
const snap = (factionId, o = {}) => ({
  v: 1, factionId, round: 7, at: AT, seed: 12345,
  faction: { status: "ACTIVE", homeSystemId: HOME, doctrineId: "d", resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
  doctrine: { doctrineId: "d", canOccupy: false, operationTypes: [], reachJumps: 10,
    templates: { invasion: [{ hullGroup: "frigate", count: 4 }] } },
  stationsMode: "ready",
  stations: (o.stations || [SAMINER]).map((systemId, i) => ({ systemId, stationId: "st" + i })),
  systems: [],
  neighbors: () => [],
  regionOf: () => null,
  isHostile: () => false,
  production: o.production || prodOf([]),
});

module.exports = ({ test }) => {
  test("production: lines busy with minerals -> PRODUCTION_LINES_BUSY", () => {
    const P = { ...PROD, mobilizationStations: 1 };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, times("frigate", 4), {}, [{ hullGroup: "frigate", runs: 2 }, { hullGroup: "frigate", runs: 2 }], 2),
    ]);
    s.doctrine = { doctrineId: "d", canOccupy: false, operationTypes: [], reachJumps: 10,
      templates: { invasion: [{ hullGroup: "frigate", count: 8 }] } };
    const plan = planProduction(s, null, { production: P });
    const linesBusy = plan.notes.filter(n => n.startsWith("PRODUCTION_LINES_BUSY:"));
    assert.strictEqual(linesBusy.length, 1, "should emit PRODUCTION_LINES_BUSY:frigate: " + JSON.stringify(plan.notes));
    assert.strictEqual(linesBusy[0], "PRODUCTION_LINES_BUSY:frigate");
    assert.strictEqual(plan.intents.filter(i => i.type === "PRODUCE").length, 0, "no PRODUCE when lines busy: " + JSON.stringify(plan.intents));
  });

  test("production: no minerals for any run -> PRODUCTION_NO_MINERALS", () => {
    const P = { ...PROD, mobilizationStations: 1 };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [], 2),
    ]);
    const plan = planProduction(s, null, { production: P });
    const noMinerals = plan.notes.filter(n => n.startsWith("PRODUCTION_NO_MINERALS:"));
    assert.strictEqual(noMinerals.length, 1, "should emit PRODUCTION_NO_MINERALS:frigate: " + JSON.stringify(plan.notes));
    assert.strictEqual(noMinerals[0], "PRODUCTION_NO_MINERALS:frigate");
    assert.strictEqual(plan.intents.filter(i => i.type === "PRODUCE").length, 0, "no PRODUCE when no minerals");
  });

  test("production: no online stations with free lines -> PRODUCTION_NO_SITE", () => {
    const P = { ...PROD, mobilizationStations: 1 };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, times("frigate", 4), {}, [], 0),
    ]);
    const plan = planProduction(s, null, { production: P });
    const noSite = plan.notes.filter(n => n.startsWith("PRODUCTION_NO_SITE:"));
    assert.strictEqual(noSite.length, 1, "should emit PRODUCTION_NO_SITE:frigate: " + JSON.stringify(plan.notes));
    assert.strictEqual(noSite[0], "PRODUCTION_NO_SITE:frigate");
    assert.strictEqual(plan.intents.filter(i => i.type === "PRODUCE").length, 0);
  });

  test("production: minerals and free lines available -> PRODUCE intent, no production note", () => {
    const P = { ...PROD, mobilizationStations: 1 };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, times("frigate", 4), {}, [], 2),
    ]);
    const plan = planProduction(s, null, { production: P });
    const produce = plan.intents.filter(i => i.type === "PRODUCE");
    assert.strictEqual(produce.length, 1, "should emit one PRODUCE intent: " + JSON.stringify(plan.intents));
    assert.strictEqual(produce[0].hullGroup, "frigate");
    assert.ok(produce[0].runs >= 1, "runs >= 1");
    const prodNotes = plan.notes.filter(n => n.startsWith("PRODUCTION_"));
    assert.strictEqual(prodNotes.length, 0, "no PRODUCTION_* notes when production happens: " + JSON.stringify(plan.notes));
  });

  test("production: distributed - lines busy across multiple stations (compat)", () => {
    const P = { ...PROD, mobilizationStations: 1 };
    const s = snap(AMARR, { stations: [SAMINER, HOME] });
    s.production = prodOf([
      st("stM", SAMINER, times("frigate", 4), {}, [{ hullGroup: "frigate", runs: 2 }, { hullGroup: "frigate", runs: 2 }], 2),
      st("stA", HOME, {}, {}, [], 2),
    ]);
    const P2 = { ...P, targetStockFleets: 2 };
    const plan = planProduction(s, null, { production: P2 });
    assert.deepStrictEqual(plan.notes.filter(n => n.startsWith("PRODUCTION_")), ["PRODUCTION_LINES_BUSY:frigate"],
      JSON.stringify(plan.notes));

    s.production = prodOf([
      st("stM", SAMINER, times("frigate", 4), {}, [{ hullGroup: "frigate", runs: 2 }, { hullGroup: "frigate", runs: 2 }], 2),
      st("stA", HOME, times("frigate", 4), {}, [], 2),
    ]);
    const plan2 = planProduction(s, null, { production: P2 });
    const produce2 = plan2.intents.filter(i => i.type === "PRODUCE");
    assert.strictEqual(produce2.length, 1, "should PRODUCE on stA: " + JSON.stringify(plan2.intents));

    s.production = prodOf([
      st("stM", SAMINER, times("frigate", 4), {}, [{ hullGroup: "frigate", runs: 2 }, { hullGroup: "frigate", runs: 2 }], 2),
      st("stA", HOME, times("frigate", 4), {}, [{ hullGroup: "frigate", runs: 2 }, { hullGroup: "frigate", runs: 2 }], 2),
    ]);
    const plan3 = planProduction(s, null, { production: P2 });
    const linesBusy = plan3.notes.filter(n => n.startsWith("PRODUCTION_LINES_BUSY:"));
    assert.strictEqual(linesBusy.length, 1, "should emit PRODUCTION_LINES_BUSY:frigate when all free=0: " + JSON.stringify(plan3.notes));
    assert.strictEqual(linesBusy[0], "PRODUCTION_LINES_BUSY:frigate");
  });

  test("production: lines busy AND no minerals -> PRODUCTION_NO_MINERALS", () => {
    const P = { ...PROD, mobilizationStations: 1, targetStockFleets: 2 };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "frigate", runs: 2 }, { hullGroup: "frigate", runs: 2 }], 2),
    ]);
    const plan = planProduction(s, null, { production: P });
    const noMinerals = plan.notes.filter(n => n.startsWith("PRODUCTION_NO_MINERALS:"));
    assert.strictEqual(noMinerals.length, 1, "should emit PRODUCTION_NO_MINERALS:frigate when lines busy and no minerals: " + JSON.stringify(plan.notes));
    assert.strictEqual(noMinerals[0], "PRODUCTION_NO_MINERALS:frigate");
    assert.strictEqual(plan.intents.filter(i => i.type === "PRODUCE").length, 0, "no PRODUCE when no minerals: " + JSON.stringify(plan.intents));
  });

  test("production: minerals on busy station, free line without minerals -> LINES_BUSY, not BLOCKED", () => {
    const P = { ...PROD, mobilizationStations: 1, targetStockFleets: 2 };
    const s = snap(AMARR, { stations: [SAMINER, HOME] });
    const busy = [{ hullGroup: "frigate", runs: 2 }, { hullGroup: "frigate", runs: 2 }];
    s.production = prodOf([
      st("stM", SAMINER, times("frigate", 40), {}, busy, 2),
      st("stA", HOME, {}, {}, [], 2),
    ]);
    const plan = planProduction(s, null, { production: P });
    assert.deepStrictEqual(plan.notes.filter(n => n.startsWith("PRODUCTION_")), ["PRODUCTION_LINES_BUSY:frigate"],
      JSON.stringify(plan.notes));
    assert.strictEqual(plan.intents.length, 0, JSON.stringify(plan.intents));
    const { judgeFaction, VERDICT } = require("../../../lib/strategy/activity/verdict");
    const v = judgeFaction({ now: AT, intervalMs: 900000, staleFactor: 3, startedAt: AT - 900000,
      strategy: { state: "running", reason: null, aiState: "on", aiReason: null, seedState: "done" },
      failedServices: [], row: { status: "ACTIVE", lastReviewAt: AT - 60000 },
      memory: { round: 7, outcome: "DONE", notes: plan.notes, applied: { FACTION_TOUCH: 1 }, refused: 0 },
      reviewEvent: { found: true, state: "QUEUED", attempts: 0, lastError: null, dueAt: AT + 900000 },
      activityCount: 2, lastRefusal: null });
    assert.notStrictEqual(v.code, VERDICT.BLOCKED, v.sentence);
    assert.strictEqual(v.code, VERDICT.WORKING, v.sentence);
  });

  test("production: no minerals on busy nor free station -> PRODUCTION_NO_MINERALS", () => {
    const P = { ...PROD, mobilizationStations: 1, targetStockFleets: 2 };
    const s = snap(AMARR, { stations: [SAMINER, HOME] });
    const busy = [{ hullGroup: "frigate", runs: 2 }, { hullGroup: "frigate", runs: 2 }];
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, busy, 2),
      st("stA", HOME, {}, {}, [], 2),
    ]);
    const plan = planProduction(s, null, { production: P });
    assert.deepStrictEqual(plan.notes.filter(n => n.startsWith("PRODUCTION_")), ["PRODUCTION_NO_MINERALS:frigate"],
      JSON.stringify(plan.notes));
  });
};