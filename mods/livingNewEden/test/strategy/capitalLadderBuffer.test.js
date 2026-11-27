"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { capitalClassesOf } = require("../../lib/strategy/data/factionHullClasses");
const { ladderPlanOf } = require("../../lib/strategy/ai/capitalLadder");
const { hullTargets, poolCappedGroupsOf } = require("../../lib/strategy/ai/production");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AMARR = 500003;
const CRUISER = "cruiser";

const resolved = config.resolveConfig({ modDir: MOD_DIR, env: {} });
assert.deepStrictEqual(resolved.errors || [], []);
const SVC = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
  intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
  scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: resolved.config, hostility: () => true,
  isCampaignOk: () => true, industryCatalog: {} }).params;
const table = createRecipeTable(RECIPES, recipeParamsOf(resolved.config.production));
const recipes = Object.fromEntries(HULL_GROUPS.map((g) => [g, { minerals: table.lookup(g).minerals }]));

const DOCTRINE = { doctrineId: "lb", operationTypes: ["INVASION"], templates: { invasion: [{ hullGroup: CRUISER,
  count: 4 }] } };
const P = (over = {}) => ({ ...SVC.production, capitalLadderEnabled: true, poolCapEnabled: true, poolCapStations: 3,
  mobilizationStations: 2, ...over });
const station = (stationId, cruisers) => ({ stationId, systemId: 30000000 + stationId.charCodeAt(2), kind: "npc",
  lines: 4, activeJobs: [], minerals: {}, hulls: { [CRUISER]: cruisers }, secClass: "lowsec" });

function snap(stations) {
  return {
    factionId: AMARR, entry: { kind: "empire" }, faction: { status: "ACTIVE" }, doctrine: DOCTRINE,
    stationsMode: "ready", fleets: [], fleetsTruncated: false, capitalClasses: capitalClassesOf(AMARR),
    production: { mode: "ready", recipesVersion: table.version, recipes, inProduction: {}, activeJobsTotal: 0,
      truncated: false, stations },
  };
}
const plan = (stations, over) => ladderPlanOf(snap(stations), { production: P(over) });
const withoutKey = (over = {}) => {
  const { ladderBufferPoolCapEnabled, ...rest } = P(over);
  return { production: rest };
};

module.exports = ({ test }) => {
  test("LB1 poolCappedGroupsOf: have >= 3 x desired over all stations -> in the Set; pool cap off -> empty",
    () => {
      assert.ok(SVC.production.ladderBufferPoolCapEnabled === true, "default on, passed to params.production");
      const desired = hullTargets(DOCTRINE, P());
      assert.deepStrictEqual(desired, { [CRUISER]: 8 });
      const far = [station("stA", 0), station("stB", 0), station("stC", 20),
        { ...station("stD", 0), activeJobs: [{ hullGroup: CRUISER, runs: 4 }] }];
      assert.deepStrictEqual([...poolCappedGroupsOf(desired, far, P())], [CRUISER]);
      assert.deepStrictEqual([...poolCappedGroupsOf(desired, far.slice(0, 3), P())], []);
      assert.deepStrictEqual([...poolCappedGroupsOf(desired, far, P({ poolCapEnabled: false }))], []);
    });

  test("LB2 Amarr: mobilization stations short, cruisers at the pool ceiling -> rung 1 open", () => {
    const amarr = [station("stA", 6), station("stB", 6), station("stC", 6), station("stD", 6)];
    const before = plan(amarr, { ladderBufferPoolCapEnabled: false });
    assert.deepStrictEqual([before.bufferPermille, before.notes], [750, ["LADDER_WAIT_BUFFER"]]);
    const after = plan(amarr);
    assert.strictEqual(after.bufferPermille, 1000);
    assert.ok(after.cls !== null, JSON.stringify(after));
    assert.ok(after.notes.length === 1 && /^LADDER_(SAVING|PRODUCE):/.test(after.notes[0]), after.notes.join());
  });

  test("LB3 a group short and below the ceiling -> LADDER_WAIT_BUFFER as before", () => {
    const below = [station("stA", 6), station("stB", 6), station("stC", 6)];
    const r = plan(below);
    assert.deepStrictEqual([r.bufferPermille, r.cls, r.notes], [750, null, ["LADDER_WAIT_BUFFER"]]);
  });

  test("LB4 flag off / poolCapEnabled false -> the plan without the new key", () => {
    const amarr = [station("stA", 6), station("stB", 6), station("stC", 6), station("stD", 6)];
    assert.deepStrictEqual(plan(amarr, { ladderBufferPoolCapEnabled: false }),
      ladderPlanOf(snap(amarr), withoutKey()));
    assert.deepStrictEqual(plan(amarr, { poolCapEnabled: false }),
      ladderPlanOf(snap(amarr), withoutKey({ poolCapEnabled: false })));
  });
};
