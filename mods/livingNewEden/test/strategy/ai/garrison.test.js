"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planGarrisonReinforce, GARRISON_CONSOLIDATE_PURPOSE } = require("../../../lib/strategy/ai/garrison");
const { decideReview } = require("../../../lib/strategy/ai");
const { usableKinds } = require("../../../lib/strategy/ai/targeting");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { reviewRowBound } = require("../../../lib/strategy/reviewRows");
const { COUNTER_NAMES, NOTE_COUNTERS, isNoHullsNote } = require("../../../lib/strategy/reviewService");
const { describeNote } = require("../../../lib/strategy/activity/notes");
const { resolveConfig } = require("../../../config");
const { createManualClock } = require("../../../lib/util/clock");
const { createRng } = require("../../../lib/util/rng");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const SANSHA = 500019;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const GARRISON = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);
const ONE = [{ hullGroup: "frigate", typeId: null, count: 1 }];

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  garrison: { maxPerReview: 1 } });

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const posts = o.posts || [22, 25, 18];
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: o.status || "ACTIVE", homeSystemId: 20, doctrineId: "ga", resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "ga", canOccupy: o.canOccupy !== false, reachJumps: 30,
      operationTypes: o.operationTypes || ["recon", "raid", "reinforce"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }],
        ...(o.noTemplate ? {} : { garrison: GARRISON }) } },
    theatre: [14], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: o.stations || [{ systemId: 20, stationId: "st20" }],
    systems: [row(14, HOSTILE), ...posts.map((id) => row(id, F)), row(20, F)],
    fleets: o.fleets || [], fleetsTruncated: o.fleetsTruncated === true, operations: o.operations || [],
    operationsTruncated: o.operationsTruncated === true, intel: o.intel || [], sightings: [],
    ...(o.noTerritory ? {} : { territory: posts.map((systemId) => ({ systemId, detachedSinceAt: null })) }),
    territoryTruncated: o.territoryTruncated === true, threats: o.threats,
    ...(o.production ? { production: o.production } : {}) };
}

const gfleet = (fleetId, systemId, composition, extra = {}) => ({ fleetId, version: 1, state: "IDLE",
  fleetRole: "garrison", systemId, refitPending: false, shipCount: composition.reduce((s, e) => s + e.count, 0),
  strength: strengthOf(composition, POWER), operationId: null, legSeq: 0, homeSystemId: systemId, ...extra });
const SUPPLY = { stationSystems: [20] };
const BIG = { resourceUnits: 1e6, reserveUnits: 1e6 };
const SLOTS = { operations: 2, mobilizations: 3 };
const plan = (s, over = {}) => planGarrisonReinforce({ snapshot: s, supply: over.supply || SUPPLY,
  params: { ...PARAMS, ...(over.params || {}) }, ledger: over.ledger || null, slots: over.slots || SLOTS,
  budget: over.budget || BIG });
const route = (r) => r.intents.map((i) => [i.kind, i.target.systemId, i.mobilize.map((m) => [m.role, m.systemId,
  m.stationId])]);

module.exports = ({ test, skip }) => {
  test("GA1 garrison kind: OPERATION_KINDS_VERSION 8, reinforce/hold of role garrison, enabled false -> never a "
    + "usable kind of chooseNextOperation", () => {
    assert.ok(OPERATION_KINDS_VERSION >= 8, "garrison since v8 (v9 = patrol / picket)");
    const g = kinds.get("garrison");
    assert.deepStrictEqual({ ...g, fleetRoles: [...g.fleetRoles], targetKinds: [...g.targetKinds] },
      { kind: "garrison", operationType: "reinforce", objective: "hold", fleetRoles: ["garrison"],
        mobilizeRole: "garrison", offensive: false, opensFront: false, captures: false, targetKinds: ["system"],
        windowKey: "attackWindowMs", needsIntel: false, needsCanOccupy: true, enabled: false, occupationSignal: null,
        inPlace: false });
    assert.ok(!usableKinds(snap(), PARAMS).some((k) => k.kind === "garrison"));
  });

  test("GA2 planGarrisonReinforce: weak posts by (threat, station jumps, id), in-flight strength counts, slots / "
    + "maxPerReview / budget limits, gates silent, truncated reads GARRISON_SKIPPED, the hull ledger", () => {
    const fleets = [gfleet("g22", 22, ONE), gfleet("g18", 18, GARRISON),
      gfleet("g-fly", 21, GARRISON, { state: "TRAVELLING", operationId: "op25" })];
    const operations = [{ operationId: "op25", version: 1, state: "ACTIVE", operationType: "reinforce",
      targetSystemId: 25, dueAt: AT + HOUR, members: 1, orderedMembers: 1 }];
    const one = plan(snap({ fleets, operations }), { params: { garrison: { maxPerReview: 3 } } });
    assert.deepStrictEqual(route(one), [["garrison", 22, [["garrison", 20, null]]]]);
    const l = one.intents[0];
    assert.deepStrictEqual([l.type, l.fleets, l.originSystemId, l.dueAt], ["LAUNCH", [], 20, AT + 2 * HOUR]);
    assert.deepStrictEqual(l.mobilize[0].composition, GARRISON.map((e) => ({ ...e, typeId: null })));
    assert.deepStrictEqual([one.notes, one.cost], [["GARRISON_REINFORCE:22"], { resourceUnits: 60, reserveUnits: 6 }]);

    const two = (o) => route(plan(snap({ fleets: fleets.slice(0, 2), ...o }), { params: { garrison: { maxPerReview: 2 } } }))
      .map((x) => x[1]);
    assert.deepStrictEqual(two({}), [22, 25]);
    assert.deepStrictEqual(two({ intel: [{ systemId: 25, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 3,
      hostileStrength: 50, hostileStations: 0, controllerFactionId: F }] }), [25, 22]);
    assert.deepStrictEqual(two({ intel: [{ systemId: 25, observedAt: AT - 7 * HOUR, hostileFleets: 1,
      hostileShips: 3, hostileStrength: 50, hostileStations: 0, controllerFactionId: F }] }), [22, 25], "stale intel");
    const battle = (ttl) => route(plan(snap({ fleets: fleets.slice(0, 2), intel: [{ systemId: 25, observedAt: AT - 2 * HOUR,
      hostileFleets: 1, hostileShips: 3, hostileStrength: 50, hostileStations: 0, controllerFactionId: F,
      source: "battle" }] }), { params: { garrison: { maxPerReview: 2 }, battleIntelTtlMs: ttl } })).map((x) => x[1]);
    assert.deepStrictEqual([battle(HOUR), battle(3 * HOUR)], [[22, 25], [25, 22]], "battle intel ttl");
    assert.deepStrictEqual(two({ threats: { mode: "ready", truncated: false, items: [{ systemId: 25 }] } }), [25, 22]);

    const s2 = snap({ fleets: fleets.slice(0, 2) });
    assert.deepStrictEqual(plan(s2, { slots: { operations: 0, mobilizations: 3 } }),
      { intents: [], notes: ["GARRISON_NO_SLOT"], cost: { resourceUnits: 0, reserveUnits: 0 } });
    const lim = plan(s2, { slots: { operations: 2, mobilizations: 1 }, params: { garrison: { maxPerReview: 2 } } });
    assert.deepStrictEqual([lim.intents.length, lim.notes], [1, ["GARRISON_REINFORCE:22", "GARRISON_NO_SLOT"]]);
    assert.deepStrictEqual(plan(s2, { budget: { resourceUnits: 59, reserveUnits: 100 } }).notes,
      ["INSUFFICIENT_RESOURCES"]);

    const empty = { intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 } };
    assert.deepStrictEqual(plan(s2, { params: { garrison: null } }), empty);
    assert.deepStrictEqual(plan(s2, { params: { garrison: { maxPerReview: 0 } } }), empty);
    assert.deepStrictEqual(plan(snap({ canOccupy: false })), empty);
    assert.deepStrictEqual(plan(snap({ operationTypes: ["recon", "raid"] })), empty);
    assert.deepStrictEqual(plan(snap({ noTemplate: true })), empty);
    assert.deepStrictEqual(plan(snap({ posts: [] })), empty);
    assert.deepStrictEqual(plan(snap({ fleets: [gfleet("a", 22, GARRISON), gfleet("b", 25, GARRISON),
      gfleet("c", 18, GARRISON)] })), empty, "no weak post");
    for (const o of [{ territoryTruncated: true }, { fleetsTruncated: true }, { operationsTruncated: true },
      { noTerritory: true }, { status: "DORMANT" }]) {
      assert.deepStrictEqual(plan(snap(o)), { ...empty, notes: ["GARRISON_SKIPPED"] }, JSON.stringify(o));
    }

    const prod = (hulls) => ({ mode: "ready", recipesVersion: 1, recipes: {}, inProduction: {}, activeJobsTotal: 0,
      truncated: false, stations: [{ stationId: "st20", systemId: 20, kind: "npc", lines: 1, activeJobs: [],
        minerals: {}, hulls }] });
    const P = { production: { mobilizeHulls: "required", miningNeedsHulls: false, hullGroups: [...HULL_GROUPS] } };
    const ls = snap({ fleets: fleets.slice(0, 2), production: prod({ cruiser: 4, battlecruiser: 2 }) });
    const ledger = createHullLedger(ls, P);
    const lr = plan(ls, { ledger, params: { garrison: { maxPerReview: 2 } } });
    assert.deepStrictEqual(route(lr), [["garrison", 22, [["garrison", 20, "st20"]]]]);
    assert.deepStrictEqual(lr.intents[0].mobilize[0].hulls, [{ itemKey: "group:battlecruiser", count: 2 },
      { itemKey: "group:cruiser", count: 4 }]);
    assert.deepStrictEqual(lr.notes, ["GARRISON_REINFORCE:22", "NO_HULLS:battlecruiser"]);
    const self = snap({ posts: [20], production: prod({ cruiser: 4, battlecruiser: 2 }) });
    assert.deepStrictEqual(plan(self, { ledger: createHullLedger(self, P) }).intents, [], "never the post itself");
  });

  test("GA3 decideReview: the reinforcement takes the slots the offensive left (LAUNCH <= maxOperationsPerReview, "
    + "MOBILIZE <= maxMobilizationsPerReview); flag off = the decision as before", () => {
    const s = snap({ fleets: [gfleet("g22", 22, ONE)] });
    const counts = (d) => {
      const l = d.intents.filter((i) => i.type === "LAUNCH" && i.kind !== "hunt");
      const m = d.intents.filter((i) => i.type === "MOBILIZE").length + l.reduce((n, i) => n + i.mobilize.length, 0);
      return { launches: l.length, mobs: m, kinds: l.map((i) => i.kind) };
    };
    const on = decideReview(s, PARAMS);
    assert.strictEqual(on.outcome, "REVIEWED", on.reason);
    const c = counts(on);
    assert.ok(c.kinds.includes("recon") && c.kinds.includes("garrison"), JSON.stringify([c, on.notes]));
    assert.ok(c.launches <= PARAMS.maxOperationsPerReview && c.mobs <= PARAMS.maxMobilizationsPerReview,
      JSON.stringify(c));
    const full = decideReview(s, { ...PARAMS, maxOperationsPerReview: 1 });
    assert.deepStrictEqual(counts(full).kinds, ["recon"]);
    assert.ok(full.notes.includes("GARRISON_NO_SLOT"), JSON.stringify(full.notes));
    const { garrison: _g, ...noKey } = PARAMS;
    const off = decideReview(s, { ...PARAMS, garrison: null });
    assert.deepStrictEqual(off, decideReview(s, noKey));
    assert.ok(!off.intents.some((i) => i.kind === "garrison") && !off.notes.some((n) => n.startsWith("GARRISON")));
  });

  test("GA4 garrison config defaults (on since IF2, 1, clamp 0..8), reviewRowBound unchanged (976)", () => {
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    const S = def.config.strategy;
    assert.deepStrictEqual([S.garrisonReinforceEnabled, S.maxGarrisonReinforcePerReview], [true, 1]);
    assert.strictEqual(resolve({ EVEJS_LNE_STRATEGY_MAX_GARRISON_REINFORCE_PER_REVIEW: "99" })
      .config.strategy.maxGarrisonReinforcePerReview, 8);
    const off = resolve({ EVEJS_LNE_STRATEGY_GARRISON_REINFORCE_ENABLED: "0" });
    assert.deepStrictEqual([off.config.strategy.garrisonReinforceEnabled, off.warnings], [false, []]);
    const c = def.config;
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview },
      { maxDefensePerReview: c.strategy.maxDefensePerReview }, null, null, null];
    assert.strictEqual(reviewRowBound(...args), 976);
    const offArgs = [off.config.strategy, ...args.slice(1)];
    assert.strictEqual(reviewRowBound(...offArgs), 976, "the flag adds no rows (shared slots)");
  });

  test("GA5: a garrison on a patrol sortie counts for its origin post; with the patrols "
    + "on an IDLE returnee in the sortie radius counts for its nearest post (off = as before)", () => {
    const full = [gfleet("g22", 22, GARRISON), gfleet("g18", 18, GARRISON)];
    const sortie = (originSystemId) => snap({ fleets: [...full,
      gfleet("g25", 26, GARRISON, { state: "STAGED", operationId: "opS" })],
    operations: [{ operationId: "opS", version: 1, state: "ACTIVE", operationType: "patrol", originSystemId,
      targetSystemId: 26, dueAt: AT + HOUR, members: 1, orderedMembers: 0 }] });
    assert.deepStrictEqual(plan(sortie(25)).intents, [], "the post of the sortie is not weak");
    assert.deepStrictEqual(route(plan(sortie(30))).map((x) => x[1]), [25], "a patrol from no post counts at its target");
    const back = snap({ fleets: [...full, gfleet("g25", 26, GARRISON)] });
    const patrol = { garrisonMaxJumps: 2, garrisonFleetsTarget: 2, maxGarrisonsPerPost: 3 };
    assert.deepStrictEqual(plan(back, { params: { patrol } }).intents, [], "a returnee counts for its post");
    assert.deepStrictEqual(route(plan(back)).map((x) => x[1]), [25], "patrols off: the decision as before");
    const crowd = snap({ fleets: [...full, gfleet("h25", 25, ONE), gfleet("g25", 26, GARRISON)] });
    const at = (target, ceiling) => route(plan(crowd, { params: { patrol: { ...patrol, garrisonFleetsTarget: target,
      maxGarrisonsPerPost: ceiling } } })).map((x) => x[1]);
    assert.deepStrictEqual(at(1, 1), [25], "no post below the ceiling: no phantom strength");
    assert.deepStrictEqual(at(1, 2), [], "a post below the ceiling: the returnee counts for it");
    const far = snap({ fleets: [...full, gfleet("g25", 28, GARRISON)] });
    assert.deepStrictEqual(route(plan(far, { params: { patrol } })).map((x) => x[1]), [25]);
  });

  test("GA8: the only template holder 20 jumps from the post (maxAssemblyJumps 15) -> "
    + "GARRISON_HULLS_OUT_OF_REACH, no NO_HULLS, no intent; no group anywhere -> NO_HULLS:<group>; dictionary + counter",
  () => {
    const prod = (hulls) => ({ mode: "ready", recipesVersion: 1, recipes: {}, inProduction: {}, activeJobsTotal: 0,
      truncated: false, stations: [{ stationId: "st2", systemId: 2, kind: "npc", lines: 1, activeJobs: [],
        minerals: {}, hulls }] });
    const P = { production: { mobilizeHulls: "required", miningNeedsHulls: false, hullGroups: [...HULL_GROUPS] } };
    const run = (hulls) => {
      const s = snap({ posts: [22], stations: [{ systemId: 2, stationId: "st2" }], production: prod(hulls) });
      return plan(s, { ledger: createHullLedger(s, P), params: { maxAssemblyJumps: 15 } });
    };
    const far = run({ cruiser: 54, battlecruiser: 46 });
    assert.deepStrictEqual([far.intents, far.notes], [[], ["GARRISON_HULLS_OUT_OF_REACH"]]);
    assert.ok(!far.notes.some((n) => n.startsWith("NO_HULLS")), JSON.stringify(far.notes));
    const none = run({ cruiser: 54 });
    assert.deepStrictEqual([none.intents, none.notes], [[], ["NO_HULLS:battlecruiser"]]);

    const d = describeNote("GARRISON_HULLS_OUT_OF_REACH");
    assert.deepStrictEqual([d.known, d.category, d.text.includes("strategy.maxAssemblyJumps")], [true, "blokada", true]);
    assert.ok(COUNTER_NAMES.includes("garrisonHullsOutOfReach"));
    assert.strictEqual(NOTE_COUNTERS.GARRISON_HULLS_OUT_OF_REACH, "garrisonHullsOutOfReach");
    assert.ok(Object.values(NOTE_COUNTERS).every((c) => COUNTER_NAMES.includes(c)), "closed counter set");
    assert.deepStrictEqual(["NO_HULLS", "NO_HULLS:cruiser", "NO_HULLS_IN_PRODUCTION:cruiser",
      "GARRISON_HULLS_OUT_OF_REACH"].map(isNoHullsNote), [true, true, false, false]);
  });

  test("GA9 consolidation posts: OCCUPIED without a fleet -> LAUNCH garrison GARRISON_CONSOLIDATE; a standing "
    + "invasion fleet or a garrison flying to it -> no post", () => {
    const fleets = [gfleet("g22", 22, GARRISON), gfleet("i26", 26, GARRISON, { fleetRole: "invasion" }),
      gfleet("g-fly", 27, GARRISON, { state: "TRAVELLING", operationId: "op28" })];
    const operations = [{ operationId: "op28", version: 1, state: "ACTIVE", operationType: "reinforce",
      targetSystemId: 28, dueAt: AT + HOUR, members: 1, orderedMembers: 1 }];
    const s = { ...snap({ posts: [22], fleets, operations }), consolidating: [{ systemId: 24, state: "OCCUPIED" },
      { systemId: 26, state: "OCCUPIED" }, { systemId: 28, state: "CONSOLIDATING" }] };
    const r = plan(s, { params: { garrison: { maxPerReview: 3, consolidate: true } } });
    assert.deepStrictEqual(route(r), [["garrison", 24, [["garrison", 20, null]]]], JSON.stringify(r.notes));
    assert.deepStrictEqual([r.notes, r.intents[0].purpose], [["GARRISON_CONSOLIDATE:24"], GARRISON_CONSOLIDATE_PURPOSE]);
    assert.strictEqual(GARRISON_CONSOLIDATE_PURPOSE, "GARRISON_CONSOLIDATE");
    const d = describeNote("GARRISON_CONSOLIDATE:24");
    assert.ok(d.known, JSON.stringify(d));
    assert.ok(COUNTER_NAMES.includes("garrisonConsolidated"));
  });

  test("GA10 order: threatened post, then the consolidation post, then the other weak post; flag off = the "
    + "result of before (bit for bit)", () => {
    const threats = { mode: "ready", truncated: false, items: [{ systemId: 25 }] };
    const base = snap({ posts: [22, 25], threats });
    const withConsol = { ...base, consolidating: [{ systemId: 24, state: "OCCUPIED" }] };
    const slots = { operations: 3, mobilizations: 3 };
    const on = plan(withConsol, { slots, params: { garrison: { maxPerReview: 3, consolidate: true } } });
    assert.deepStrictEqual(route(on).map((x) => x[1]), [25, 24, 22], JSON.stringify(on.notes));
    assert.deepStrictEqual(on.notes, ["GARRISON_REINFORCE:25", "GARRISON_CONSOLIDATE:24", "GARRISON_REINFORCE:22"]);
    const off = plan(withConsol, { slots, params: { garrison: { maxPerReview: 3 } } });
    assert.deepStrictEqual(off, plan(base, { slots, params: { garrison: { maxPerReview: 3 } } }));
    assert.deepStrictEqual(route(off).map((x) => x[1]), [25, 22]);
    assert.ok(off.intents.every((i) => !("purpose" in i)), JSON.stringify(off.intents));
  });

  test("GA11 consolidation without a MOBILIZE: budget 0 -> LAUNCH garrison of the surplus garrison of post 22 "
    + "to 24 (no MOBILIZE, GARRISON_CONSOLIDATE_MOVE); the post keeps the template, so 26 gets none; consolidates:false "
    + "-> nothing", () => {
    const fleets = [gfleet("g22b", 22, GARRISON), gfleet("g22a", 22, GARRISON)];
    const s = { ...snap({ posts: [22], fleets }), consolidating: [{ systemId: 24, state: "OCCUPIED" },
      { systemId: 26, state: "OCCUPIED" }] };
    const over = { budget: { resourceUnits: 0, reserveUnits: 0 }, slots: { operations: 3, mobilizations: 3 },
      params: { garrison: { maxPerReview: 3, consolidate: true } } };
    const r = plan(s, over);
    assert.deepStrictEqual(r.intents.map((i) => [i.kind, i.target.systemId, i.originSystemId, i.fleets, i.mobilize,
      i.purpose]), [["garrison", 24, 22, [{ fleetId: "g22a", expectedVersion: 1 }], [], GARRISON_CONSOLIDATE_PURPOSE]],
    JSON.stringify(r.notes));
    assert.deepStrictEqual(r.notes, ["INSUFFICIENT_RESOURCES", "GARRISON_CONSOLIDATE_MOVE:24"]);
    assert.deepStrictEqual(r.cost, { resourceUnits: 0, reserveUnits: 0 });
    assert.ok(describeNote("GARRISON_CONSOLIDATE_MOVE:24").known);
    const noConsol = plan({ ...s, doctrine: { ...s.doctrine, consolidates: false } }, over);
    assert.deepStrictEqual(noConsol.intents, [], JSON.stringify(noConsol.notes));
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("GA6: a garrison sent by planDefense in this review counts for its target, not "
    + "for the post it leaves (planner opts.dispatched + decideReview wiring)", () => {
    const fleets = [gfleet("g22", 22, GARRISON), gfleet("g18", 18, GARRISON)];
    const sent = planGarrisonReinforce({ snapshot: snap({ fleets }), supply: SUPPLY, params: PARAMS, ledger: null,
      slots: SLOTS, budget: BIG, dispatched: new Map([["g22", 25]]) });
    assert.deepStrictEqual(route(sent).map((x) => x[1]), [22]);
    assert.deepStrictEqual(route(plan(snap({ fleets }))).map((x) => x[1]), [25]);
    const s = snap({ fleets, operationTypes: ["recon", "raid", "reinforce", "defense"],
      threats: { mode: "ready", truncated: false, items: [{ systemId: 25, state: "INVASION", occupierStrength: 1,
        phaseDueAt: null }] } });
    const d = decideReview(s, { ...PARAMS, defense: { enabled: true, maxPerReview: 1 } });
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    const by = (k) => d.intents.filter((i) => i.type === "LAUNCH" && i.kind === k);
    assert.deepStrictEqual(by("defense").map((i) => [i.target.systemId, i.fleets.map((f) => f.fleetId)]),
      [[25, ["g22"]]], JSON.stringify(d.notes));
    assert.deepStrictEqual(by("garrison").map((i) => i.target.systemId), [22], JSON.stringify(d.notes));
  });

  needsDriver("GA7 EVEJS_LNE_STRATEGY_GARRISON_REINFORCE_ENABLED=1 and PATROL_ENABLED=1 on a real store "
    + "-> GARRISON_REINFORCE and a GARRISON_RETURN patrol in the review decision; flags off -> neither", async () => {
    const run = (on) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map(R.THEATRE.map((id) => [id, SANSHA]));
      const captured = new Map();
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(47) }), graph: R.graphOf(), controllers };
      const seen = { d: null };
      const hooks = { beforeEffect: (d) => {
        if (seen.d === null && d.factionId === SANSHA && d.outcome === "REVIEWED") seen.d = d;
        return d;
      } };
      const flags = on ? { EVEJS_LNE_STRATEGY_GARRISON_REINFORCE_ENABLED: "1", EVEJS_LNE_STRATEGY_PATROL_ENABLED: "1",
        EVEJS_LNE_STRATEGY_GARRISON_RELEASE_ENABLED: "0" }
        : { EVEJS_LNE_STRATEGY_GARRISON_REINFORCE_ENABLED: "0", EVEJS_LNE_STRATEGY_PATROL_ENABLED: "0",
          EVEJS_LNE_STRATEGY_GARRISON_RELEASE_ENABLED: "0" };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0", ...flags },
      { hooks, world: R.upkeepWorld(controllers, captured) });
      const stations = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
        + "ORDER BY station_id", SANSHA).map((x) => x.system_id);
      assert.ok(stations.length > 0, "a Sansha station");
      const homes = new Set(stations);
      const post = shared.graph.getNeighbors(stations[0]).find((id) => !homes.has(id));
      const out = shared.graph.getNeighbors(post).find((id) => !homes.has(id) && id !== post);
      assert.ok(Number.isSafeInteger(post) && Number.isSafeInteger(out), JSON.stringify([post, out]));
      controllers.set(post, SANSHA);
      captured.set(post, null);
      const g = e.fleets.createFleet({ factionId: SANSHA, currentSystemId: out, homeSystemId: stations[0],
        fleetRole: "garrison", composition: [{ hullGroup: "frigate", count: 1 }] }, "ga7:g");
      assert.ok(g.ok, JSON.stringify(g));
      await R.passesAt(e, shared, R.START_MS + R.I);
      e.strategy.stop("test");
      assert.ok(seen.d, "a Sansha review ran");
      const launches = seen.d.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId,
        i.purpose || null]);
      return { post, launches, notes: seen.d.notes };
    });
    const on = await run(true);
    assert.ok(on.notes.includes(`GARRISON_REINFORCE:${on.post}`), JSON.stringify(on.notes));
    assert.ok(on.launches.some((l) => l[0] === "garrison" && l[1] === on.post), JSON.stringify(on.launches));
    assert.ok(on.launches.some((l) => l[0] === "patrol" && l[1] === on.post && l[2] === "GARRISON_RETURN"),
      JSON.stringify(on.launches));
    const off = await run(false);
    assert.ok(!off.notes.some((n) => n.startsWith("GARRISON") || n.startsWith("PATROL")), JSON.stringify(off.notes));
    assert.ok(!off.launches.some((l) => l[0] === "garrison" || l[0] === "patrol"), JSON.stringify(off.launches));
  });

  needsDriver("GA4b LAUNCH garrison on a real store: operation reinforce/hold to the post, a new fleet of role "
    + "garrison in it, counter garrisonReinforced 1 (not recon)", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(41) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, SANSHA])) };
    const state = { base: null, post: null, injected: false };
    const hooks = { beforeEffect: (d) => {
      if (state.injected || d.factionId !== SANSHA || d.outcome !== "REVIEWED" || state.base === null) return d;
      state.injected = true;
      const mob = { type: "MOBILIZE", slot: 0, role: "garrison", systemId: state.base, homeSystemId: state.base,
        composition: GARRISON.map((e) => ({ ...e, typeId: null })), cost: { resourceUnits: 6, reserveUnits: 0 },
        stationId: null, hulls: [] };
      const launch = { type: "LAUNCH", slot: 1, kind: "garrison", target: { kind: "system", systemId: state.post,
        ref: null }, originSystemId: state.base, fleets: [], mobilize: [mob], dueAt: R.START_MS + R.I * 8 };
      const touch = d.intents.findIndex((i) => i.type === "FACTION_TOUCH");
      const intents = [...d.intents];
      intents.splice(touch < 0 ? intents.length : touch, 0, launch);
      return { ...d, intents };
    } };
    const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0" }, { hooks });
    const base = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", SANSHA)[0];
    assert.ok(base, "a Sansha station");
    state.base = base.system_id;
    state.post = shared.graph.getNeighbors(base.system_id)[0];
    assert.ok(Number.isSafeInteger(state.post));
    const before = e.strategy.getStatus().ai.review.counters;
    await R.passesAt(e, shared, R.START_MS + R.I);
    assert.ok(state.injected, "a Sansha review ran");
    const ops = e.q("SELECT operation_id AS id, operation_type AS t, objective AS o, target_system_id AS s "
      + "FROM world_operations WHERE faction_id = ? AND operation_type = 'reinforce'", SANSHA);
    assert.deepStrictEqual(ops.map((x) => [x.t, x.o, x.s]), [["reinforce", "hold", state.post]], JSON.stringify(ops));
    const members = e.q("SELECT fleet_role AS r, ship_count AS n FROM virtual_fleets WHERE operation_id = ?", ops[0].id);
    assert.deepStrictEqual(members.map((x) => [x.r, x.n]), [["garrison", 6]]);
    const c = e.strategy.getStatus().ai.review.counters;
    assert.strictEqual(c.garrisonReinforced, 1, JSON.stringify(c));
    assert.strictEqual(c.recon - (before.recon || 0), c.launches - (before.launches || 0) - 1,
      "the garrison LAUNCH is not counted as a recon");
    assert.ok(e.lines.some((l) => l.includes(`launch garrison -> ${state.post}`)), JSON.stringify(e.lines));
    e.strategy.stop("test");
  }));
};
