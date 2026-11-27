"use strict";

const assert = require("node:assert");
const { planProduction } = require("../../lib/strategy/ai/production");
const { judgeFaction, VERDICT } = require("../../lib/strategy/activity/verdict");
const { NOTE_DICTIONARY, LOCAL_BLOCK_CODES } = require("../../lib/strategy/activity/notes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { HULL_GROUPS } = require("../../lib/fleets/schema");

const AT = 1760000000000;
const SYS = 30001721;
const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
const times = (g, n) => Object.fromEntries(Object.entries(RECIPES.GROUPS[g].minerals).map(([k, v]) => [k, v * n]));

const verdictOf = (notes, activityCount) => judgeFaction({ now: AT, intervalMs: 900000, staleFactor: 3,
  startedAt: AT - 900000, strategy: { state: "running", reason: null, aiState: "on", aiReason: null, seedState: "done" },
  failedServices: [], row: { status: "ACTIVE", lastReviewAt: AT - 60000 },
  memory: { round: 7, outcome: "DONE", notes, applied: { FACTION_TOUCH: 1, ...(activityCount > 0 ? { LAUNCH: 5 } : {}) },
    refused: 0 },
  reviewEvent: { found: true, state: "QUEUED", attempts: 0, lastError: null, dueAt: AT + 900000 },
  activityCount, nowText: activityCount > 0 ? "operacje: 5+" : undefined, lastRefusal: null });

module.exports = ({ test }) => {
  test("VC1 free lines + full pool, battleship job cut by maxRunsPerJob -> PRODUCTION_PARTIAL, not LINES_BUSY", () => {
    const P = { maxJobsPerReview: 8, maxRunsPerJob: 2, maxActiveJobsPerFaction: 24, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] };
    const snapshot = { v: 1, factionId: 500001, round: 7, at: AT, seed: 1,
      faction: { status: "ACTIVE", homeSystemId: SYS, doctrineId: "d", resourceUnits: 0, reserveUnits: 0, version: 1 },
      doctrine: { doctrineId: "d", templates: { invasion: [{ hullGroup: "frigate", count: 4 },
        { hullGroup: "battleship", count: 6 }] } },
      stationsMode: "ready", stations: [{ systemId: SYS, stationId: "st0" }], systems: [], neighbors: () => [],
      production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0, truncated: false,
        stations: [{ stationId: "st0", systemId: SYS, kind: "npc", lines: 4, activeJobs: [],
          minerals: times("battleship", 3), hulls: { frigate: 400 } }] } };
    const plan = planProduction(snapshot, null, { production: P });
    assert.deepStrictEqual(plan.intents.map((i) => [i.hullGroup, i.runs]), [["battleship", 2]],
      JSON.stringify(plan.intents));
    const prod = plan.notes.filter((n) => n.startsWith("PRODUCTION_"));
    assert.deepStrictEqual(prod, ["PRODUCTION_PARTIAL:battleship"], JSON.stringify(plan.notes));
    assert.strictEqual(NOTE_DICTIONARY.PRODUCTION_PARTIAL.category, "oczekiwane");
  });

  test("VC2 local blocks with 5+ operations -> WORKING; without activity -> BLOCKED; a hard block -> BLOCKED first", () => {
    const local = ["REPLENISH_NO_STOCK", "INDUSTRY_NO_MINERALS:rorqual", "PRODUCTION_PARTIAL:battleship"];
    const v = verdictOf(local, 15);
    assert.strictEqual(v.code, VERDICT.WORKING, v.sentence);
    assert.ok(v.sentence.includes("local shortages") && v.sentence.includes("station in the fleet's system"), v.sentence);
    assert.ok(!NOTE_DICTIONARY.REPLENISH_NO_STOCK.text.includes("storage"), NOTE_DICTIONARY.REPLENISH_NO_STOCK.text);
    assert.strictEqual(verdictOf(local, 0).code, VERDICT.BLOCKED);
    const hard = verdictOf([...local, "UPKEEP_UNPAID"], 15);
    assert.strictEqual(hard.code, VERDICT.BLOCKED, hard.sentence);
    assert.ok(hard.sentence.startsWith(`Blocked: ${NOTE_DICTIONARY.UPKEEP_UNPAID.text}; +2`), hard.sentence);
    assert.ok(NOTE_DICTIONARY.REPLENISH_NO_STOCK_LOCAL.text.includes("fleet's station"));
    assert.ok(LOCAL_BLOCK_CODES.includes("REPLENISH_NO_STOCK_LOCAL") && LOCAL_BLOCK_CODES.includes("REPLENISH_NO_STOCK"));
    assert.strictEqual(verdictOf(["REPLENISH_NO_STOCK_LOCAL", "INDUSTRY_NO_MINERALS:rorqual"], 15).code,
      VERDICT.WORKING);
  });

  test("VC3 activity + MINERAL_SWAP_NO_SOURCE with a local *_NO_MINERALS -> WORKING with \"local shortages\"", () => {
    assert.ok(LOCAL_BLOCK_CODES.includes("MINERAL_SWAP_NO_SOURCE"));
    for (const minerals of ["PRODUCTION_NO_MINERALS:battleship", "INDUSTRY_NO_MINERALS:battleship"]) {
      const v = verdictOf(["MINERAL_SWAP_NO_SOURCE:battleship", minerals], 15);
      assert.strictEqual(v.code, VERDICT.WORKING, v.sentence);
      assert.ok(v.sentence.includes("local shortages"), v.sentence);
    }
    assert.strictEqual(verdictOf(["MINERAL_SWAP_NO_SOURCE:battleship"], 0).code, VERDICT.BLOCKED);
  });

  test("VC4 activity + only TRADE_COMMODITY_UPWELL:3 -> WORKING \"local shortages\" (3); idle -> BLOCKED", () => {
    assert.ok(LOCAL_BLOCK_CODES.includes("TRADE_COMMODITY_UPWELL"));
    const v = verdictOf(["TRADE_COMMODITY_UPWELL:3"], 15);
    assert.strictEqual(v.code, VERDICT.WORKING, v.sentence);
    assert.ok(v.sentence.includes("local shortages") && v.sentence.includes("(3)"), v.sentence);
    assert.ok(NOTE_DICTIONARY.TRADE_COMMODITY_UPWELL.text.includes("donor NPC station"), NOTE_DICTIONARY.TRADE_COMMODITY_UPWELL.text);
    const idle = verdictOf(["TRADE_COMMODITY_UPWELL:3"], 0);
    assert.strictEqual(idle.code, VERDICT.BLOCKED, idle.sentence);
  });
};
