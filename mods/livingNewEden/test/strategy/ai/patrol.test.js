"use strict";

const assert = require("node:assert");
const path = require("node:path");

const fs = require("node:fs");
const { planPatrols, isPicketOperation, GARRISON_RETURN } = require("../../../lib/strategy/ai/patrol");
const { observationFronts, observationOrder } = require("../../../lib/strategy/ai/housekeeping");
const { decideReview } = require("../../../lib/strategy/ai");
const { usableKinds } = require("../../../lib/strategy/ai/targeting");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { reviewRowBound } = require("../../../lib/strategy/reviewRows");
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
const SIX = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const ONE = [{ hullGroup: "frigate", typeId: null, count: 1 }];
const PATROL = Object.freeze({ windowMs: HOUR, idleMs: HOUR / 2, minShips: 6, garrisonMaxJumps: 2, scoutMaxJumps: 5,
  maxGarrisonsPerPost: 3, garrisonFleetsTarget: 2 });

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  patrol: PATROL });

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const posts = o.posts || [22, 25];
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: o.status || "ACTIVE", homeSystemId: 20, doctrineId: "pt", resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "pt", canOccupy: true, reachJumps: 30, returnToBase: true,
      operationTypes: o.operationTypes || ["recon", "raid", "patrol", "return"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: [14], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(14, HOSTILE), row(20, F), row(21, null), row(22, F), row(23, F), row(24, null), row(25, F),
      row(26, HOSTILE)],
    fleets: o.fleets || [], fleetsTruncated: o.fleetsTruncated === true, operations: o.operations || [],
    operationsTruncated: o.operationsTruncated === true, intel: o.intel || [], sightings: [],
    occupations: o.occupations || [],
    territory: posts.map((systemId) => ({ systemId, detachedSinceAt: null })),
    territoryTruncated: o.territoryTruncated === true };
}

const fleet = (fleetId, fleetRole, systemId, composition, extra = {}) => ({ fleetId, version: 2, state: "IDLE",
  fleetRole, systemId, refitPending: false, shipCount: composition.reduce((s, e) => s + e.count, 0),
  strength: strengthOf(composition, POWER), operationId: null, legSeq: 0, homeSystemId: 20,
  updatedAt: AT - 2 * HOUR, ...extra });
const g = (id, sys, extra) => fleet(id, "garrison", sys, SIX, extra);
const sc = (id, sys, extra) => fleet(id, "scout", sys, ONE, extra);
const SUPPLY = { stationSystems: [20], reach: new Map([[18, 2], [19, 1], [21, 1], [23, 3], [17, 3]]),
  frontTargets: [18] };
const plan = (s, o = {}) => planPatrols(s, o.supply || SUPPLY, { ...PARAMS, ...(o.params || {}) },
  o.used || new Set(), o.room === undefined ? 4 : o.room);
const legs = (r) => r.intents.map((i) => [i.kind, i.fleets[0].fleetId, i.originSystemId, i.target.systemId,
  i.purpose || null]);
const EMPTY = { intents: [], notes: [] };

module.exports = ({ test, skip }) => {
  test("PT1 patrol / picket kinds: OPERATION_KINDS_VERSION >= 9, patrol/patrol of role garrison and patrol/scout of "
    + "role scout, enabled false -> never a usable kind of chooseNextOperation", () => {
    assert.ok(OPERATION_KINDS_VERSION >= 9, "patrol / picket since v9 (v10 = gank)");
    const shape = (k) => ({ ...k, fleetRoles: [...k.fleetRoles], targetKinds: [...k.targetKinds] });
    const common = { offensive: false, opensFront: false, captures: false, targetKinds: ["system"],
      windowKey: "patrolWindowMs", needsIntel: false, needsCanOccupy: false, enabled: false, occupationSignal: null,
      inPlace: false };
    assert.deepStrictEqual(shape(kinds.get("patrol")), { kind: "patrol", operationType: "patrol", objective: "patrol",
      fleetRoles: ["garrison", "patrol"], mobilizeRole: "garrison", ...common });
    assert.deepStrictEqual(shape(kinds.get("picket")), { kind: "picket", operationType: "patrol", objective: "scout",
      fleetRoles: ["scout"], mobilizeRole: "scout", ...common });
    assert.ok(!usableKinds(snap(), PARAMS).some((k) => k.kind === "patrol" || k.kind === "picket"));
  });

  test("PT2 planPatrols: garrison return (short post first, else nearest under the ceiling; claims kept; out of the "
    + "sortie radius = no returnee), sortie (STABLE post, minShips, idle, own / unclaimed, oldest intel), picket (stale "
    + "intel by ttlOf, no front / own fleet), order returns -> sorties -> pickets by fleetId, room, used, gates", () => {
    const held = [g("h1", 25, { shipCount: 1 }), g("h2", 25, { shipCount: 1 })];
    const ret = plan(snap({ fleets: [g("g27", 27), ...held] }), { room: 1 });
    assert.deepStrictEqual(legs(ret), [["patrol", "g27", 27, 22, GARRISON_RETURN]]);
    const r0 = ret.intents[0];
    assert.deepStrictEqual([r0.type, r0.fleets, r0.mobilize, r0.dueAt], ["LAUNCH",
      [{ fleetId: "g27", expectedVersion: 2 }], [], AT + HOUR]);
    assert.deepStrictEqual(ret.notes, ["PATROL:22"]);
    const fly = g("fly", 21, { state: "TRAVELLING", operationId: "op22" });
    const ops = [{ operationId: "op22", version: 1, state: "ACTIVE", operationType: "patrol", originSystemId: 21,
      targetSystemId: 22, dueAt: AT + HOUR, members: 1, orderedMembers: 1 }];
    const near = plan(snap({ fleets: [g("g27", 27), ...held, fly, g("s22", 22, { shipCount: 1 })], operations: ops }),
      { room: 1 });
    assert.deepStrictEqual(legs(near), [["patrol", "g27", 27, 25, GARRISON_RETURN]]);
    assert.deepStrictEqual(plan(snap({ fleets: [g("g27", 27)], occupations: [{ systemId: 27, state: "OCCUPIED",
      occupier: F, phaseDueAt: null, homeOwn: false }] })), EMPTY);
    assert.deepStrictEqual(plan(snap({ fleets: [g("g28", 28)] })), { intents: [], notes: ["PATROL_OUT_OF_RANGE"] },
      "out of the radius = a note, not silence");
    assert.strictEqual(plan(snap({ fleets: [g("g27", 27, { updatedAt: AT })] })).intents.length, 1);

    const sortie = (o, f = g("g25", 25)) => legs(plan(snap({ fleets: [f], ...o })));
    assert.deepStrictEqual(sortie({}), [["patrol", "g25", 25, 23, null]]);
    const intel = (systemId, ago, extra = {}) => ({ systemId, observedAt: AT - ago, hostileFleets: 0, hostileShips: 0,
      hostileStrength: 0, hostileStations: 0, controllerFactionId: F, ...extra });
    assert.deepStrictEqual(sortie({ intel: [intel(23, HOUR), intel(24, 3 * HOUR)] }), [["patrol", "g25", 25, 24, null]]);
    assert.deepStrictEqual(sortie({ operations: [{ operationId: "o23", version: 1, state: "PLANNED",
      operationType: "recon", targetSystemId: 23, dueAt: AT + HOUR, members: 0, orderedMembers: 0 }] }),
    [["patrol", "g25", 25, 24, null]], "the target of an open own operation is skipped");
    assert.deepStrictEqual(sortie({}, g("g25", 25, { shipCount: 5 })), [], "below patrolMinShips");
    assert.deepStrictEqual(sortie({}, g("g25", 25, { updatedAt: AT - HOUR / 4 })), [], "idle below patrolIdleMs");
    const unknown = plan(snap({ fleets: [g("g25", 25, { updatedAt: null })] }));
    assert.deepStrictEqual(unknown, { intents: [], notes: ["PATROL_NO_IDLE_SINCE"] });
    assert.deepStrictEqual(plan(snap({ fleets: [g("g25", 25)] }), { params: { patrol: { ...PATROL,
      garrisonMaxJumps: 1 } }, supply: { ...SUPPLY, reach: new Map() } }).intents.map((i) => i.target.systemId), [24]);

    const scene = (o = {}) => snap({ fleets: [sc("s20", 20), fleet("m21", "mining", 21, ONE)],
      intel: [intel(19, HOUR), intel(23, 2 * HOUR, o.battle ? { source: "battle" } : {})], ...o });
    assert.deepStrictEqual(legs(plan(scene())), [["picket", "s20", 20, 17, null]]);
    const only23 = { ...SUPPLY, reach: new Map([[18, 2], [19, 1], [21, 1], [23, 3]]) };
    assert.deepStrictEqual(plan(scene(), { supply: only23 }), { intents: [], notes: ["PATROL_NO_TARGET"] },
      "23 fresh by intelTtlMs");
    assert.deepStrictEqual(legs(plan(scene({ battle: true }), { supply: only23,
      params: { battleIntelTtlMs: HOUR } })), [["picket", "s20", 20, 23, null]], "battle intel stale by its ttl");
    const two = plan(snap({ fleets: [sc("s1", 20), sc("s2", 20)] }), { supply: { ...SUPPLY,
      reach: new Map([[17, 3]]) } });
    assert.deepStrictEqual([legs(two), two.notes], [[["picket", "s1", 20, 17, null]], ["PATROL:17",
      "PATROL_NO_TARGET"]]);

    const all = snap({ fleets: [sc("a-scout", 20), g("b-sortie", 25), g("c-ret", 27), g("d-ret", 24)] });
    assert.deepStrictEqual(legs(plan(all)).map((x) => x[1]), ["c-ret", "d-ret", "b-sortie", "a-scout"]);
    assert.deepStrictEqual(legs(plan(all, { room: 2 })).map((x) => x[1]), ["c-ret", "d-ret"]);
    const used = new Set(["c-ret"]);
    assert.deepStrictEqual(legs(plan(all, { room: 2, used })).map((x) => x[1]), ["d-ret", "b-sortie"]);
    assert.ok(used.has("d-ret") && used.has("b-sortie") && !used.has("a-scout"), "the patrol fleets join used");

    assert.deepStrictEqual(plan(all, { params: { patrol: null } }), EMPTY);
    assert.deepStrictEqual(plan(all, { room: 0 }), EMPTY);
    for (const o of [{ operationTypes: ["recon", "raid"] }, { fleetsTruncated: true }, { operationsTruncated: true },
      { status: "DORMANT" }]) {
      assert.deepStrictEqual(plan(snap({ ...o, fleets: all.fleets })), EMPTY, JSON.stringify(o));
    }
    for (const o of [{ posts: [] }, { territoryTruncated: true }]) {
      assert.deepStrictEqual(legs(plan(snap({ ...o, fleets: all.fleets }))).map((x) => x[0]), ["picket"],
        JSON.stringify(o));
    }
  });

  test("RC2: idle scout, the only stale system of its reach under a recon "
    + "cooldown -> PATROL_NO_TARGET, no picket LAUNCH", () => {
    const only17 = { supply: { ...SUPPLY, reach: new Map([[17, 3]]) } };
    const s = snap({ fleets: [sc("s20", 20)] });
    assert.deepStrictEqual(legs(plan(s, only17)), [["picket", "s20", 20, 17, null]], "control: no cooldown");
    s.reconCooldowns = [17];
    assert.deepStrictEqual(plan(s, only17), { intents: [], notes: ["PATROL_NO_TARGET"] });
  });

  test("PT3 decideReview: returns + patrols <= maxReturnsPerReview (room after the returns), flag off = the "
    + "decision as before", () => {
    const s = snap({ fleets: [fleet("p27", "patrol", 27, SIX), g("g27", 27), g("g24", 24), g("g25", 25)] });
    const count = (d) => d.intents.filter((i) => i.type === "LAUNCH"
      && ["return", "patrol", "picket"].includes(i.kind)).map((i) => i.kind);
    for (const max of [1, 2, 3]) {
      const d = decideReview(s, { ...PARAMS, maxReturnsPerReview: max });
      assert.strictEqual(d.outcome, "REVIEWED", d.reason);
      const k = count(d);
      assert.ok(k.length <= max && k[0] === "return", JSON.stringify([max, k, d.notes]));
      assert.strictEqual(k.length, max, JSON.stringify([max, k]));
    }
    assert.deepStrictEqual(count(decideReview(s, { ...PARAMS, maxReturnsPerReview: 1 })), ["return"]);
    const { patrol: _p, ...noKey } = PARAMS;
    const off = decideReview(s, { ...PARAMS, patrol: null });
    assert.deepStrictEqual(off, decideReview(s, noKey));
    assert.ok(!count(off).some((k) => k !== "return") && !off.notes.some((n) => n.startsWith("PATROL")));
  });

  test("PT4 patrol config defaults (on, 3600000, 900000, 6, 2, 5), clamps, warning at maxReturnsPerReview 0 "
    + "reviewRowBound unchanged (976)", () => {
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    const S = def.config.strategy;
    assert.deepStrictEqual([S.patrolEnabled, S.patrolWindowMs, S.patrolIdleMs, S.patrolMinShips,
      S.patrolGarrisonMaxJumps, S.patrolScoutMaxJumps, S.patrolMaxGarrisonsPerPost], [true, 3600000, 900000, 6, 2, 5,
      3]);
    assert.strictEqual(resolve({ EVEJS_LNE_STRATEGY_PATROL_MAX_GARRISONS_PER_POST: "0" }).config.strategy
      .patrolMaxGarrisonsPerPost, 1, "Ceiling clamped to 1..16");
    const hi = resolve({ EVEJS_LNE_STRATEGY_PATROL_GARRISON_MAX_JUMPS: "99", EVEJS_LNE_STRATEGY_PATROL_SCOUT_MAX_JUMPS:
      "99", EVEJS_LNE_STRATEGY_PATROL_MIN_SHIPS: "0" }).config.strategy;
    assert.deepStrictEqual([hi.patrolGarrisonMaxJumps, hi.patrolScoutMaxJumps, hi.patrolMinShips], [10, 15, 1]);
    const on = resolve({ EVEJS_LNE_STRATEGY_PATROL_ENABLED: "1" });
    assert.deepStrictEqual([on.config.strategy.patrolEnabled, on.warnings], [true, []]);
    const zero = resolve({ EVEJS_LNE_STRATEGY_PATROL_ENABLED: "1", EVEJS_LNE_STRATEGY_MAX_RETURNS_PER_REVIEW: "0" });
    assert.ok(zero.warnings.some((w) => w.startsWith("strategy.patrolEnabled with strategy.maxReturnsPerReview=0")),
      JSON.stringify(zero.warnings));
    assert.ok(!resolve({ EVEJS_LNE_STRATEGY_PATROL_ENABLED: "0", EVEJS_LNE_STRATEGY_MAX_RETURNS_PER_REVIEW: "0" })
      .warnings.some((w) => w.startsWith("strategy.patrolEnabled")), "no warning with the flag off");
    const c = def.config;
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview },
      { maxDefensePerReview: c.strategy.maxDefensePerReview }, null, null, null];
    assert.strictEqual(reviewRowBound(...args), 976);
    assert.strictEqual(reviewRowBound(on.config.strategy, ...args.slice(1)), 976, "the flag adds no rows");
  });

  test("PT6: no return from an own station / the staging (invasion assembly pool), the ceiling "
    + "maxGarrisonsPerPost (PATROL_POSTS_FULL), a sortie counts for its origin post, opts.targets skipped", () => {
    assert.deepStrictEqual(plan(snap({ fleets: [g("pool1", 20), g("pool2", 20)] })), EMPTY);
    const homeOnly = snap({ fleets: [g("pool1", 20)] });
    assert.deepStrictEqual(plan({ ...homeOnly, stations: [] }, { supply: { ...SUPPLY, stationSystems: [] } }), EMPTY);
    const crowd = ["a", "b", "c"].flatMap((k) => [g(`p22${k}`, 22, { shipCount: 1 }), g(`p25${k}`, 25,
      { shipCount: 1 })]);
    assert.deepStrictEqual(plan(snap({ fleets: [g("g24", 24), ...crowd] })),
      { intents: [], notes: ["PATROL_POSTS_FULL"] });
    assert.deepStrictEqual(legs(plan(snap({ fleets: [g("g24", 24), ...crowd] }), { params: { patrol: { ...PATROL,
      maxGarrisonsPerPost: 4 } } })), [["patrol", "g24", 24, 25, GARRISON_RETURN]]);
    const out25 = g("h2", 26, { state: "STAGED", operationId: "opS" });
    const opS = [{ operationId: "opS", version: 1, state: "ACTIVE", operationType: "patrol", originSystemId: 25,
      targetSystemId: 26, dueAt: AT + HOUR, members: 1, orderedMembers: 0 }];
    const p22 = [g("x22", 22, { shipCount: 1 })];
    assert.deepStrictEqual(legs(plan(snap({ fleets: [g("g27", 27), g("h1", 25, { shipCount: 1 }), out25, ...p22],
      operations: opS }), { room: 1 })), [["patrol", "g27", 27, 22, GARRISON_RETURN]]);
    assert.deepStrictEqual(legs(plan(snap({ fleets: [g("g22", 22)] }))), [["patrol", "g22", 22, 21, null]]);
    assert.deepStrictEqual(legs(plan(snap({ fleets: [g("g22", 22)], occupations: [{ systemId: 21, state: "OCCUPIED",
      occupier: F, phaseDueAt: null, homeOwn: false }] }))), [["patrol", "g22", 22, 23, null]]);
    const targets = new Set([23, 17, 19]);
    assert.deepStrictEqual(legs(planPatrols(snap({ fleets: [g("g25", 25), sc("s20", 20)] }), SUPPLY, PARAMS,
      new Set(), 4, { targets })), [["patrol", "g25", 25, 24, null], ["picket", "s20", 20, 21, null]]);
  });

  test("PT7 PATROL_OUT_OF_RANGE once for garrisons out of the sortie radius (never for the staging / a "
    + "claim); a relief / defense target of this review is never a sortie target", () => {
    assert.deepStrictEqual(plan(snap({ fleets: [g("g28", 28), g("g30", 30)] })),
      { intents: [], notes: ["PATROL_OUT_OF_RANGE"] });
    assert.deepStrictEqual(plan(snap({ fleets: [g("pool", 20), g("g28", 28)], occupations: [{ systemId: 28,
      state: "OCCUPIED", occupier: F, phaseDueAt: null, homeOwn: false }] })), EMPTY);
    const s = { ...snap({ fleets: [g("g25", 25), fleet("p22", "patrol", 22, SIX)],
      operationTypes: ["recon", "raid", "patrol", "return", "defense"] }),
    threats: { mode: "ready", truncated: false, items: [{ systemId: 23, state: "INVASION", occupierStrength: 1,
      phaseDueAt: null }] } };
    const d = decideReview(s, { ...PARAMS, defense: { enabled: true, maxPerReview: 1 } });
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    const by = (k) => d.intents.filter((i) => i.type === "LAUNCH" && i.kind === k)
      .map((i) => [i.fleets[0].fleetId, i.target.systemId]);
    assert.deepStrictEqual([by("defense"), by("patrol")], [[["p22", 23]], [["g25", 24]]], JSON.stringify(d.notes));
  });

  test("PT8: a garrison of a relief / defense LAUNCH of this review (opts.dispatched) counts for its target "
    + "never for the post it leaves (the planGarrisonReinforce rule); decideReview passes the same map", () => {
    const fleets = [g("R", 27), g("ga", 25, { state: "RELIEVING", shipCount: 1 }), g("gb", 25, { shipCount: 1 }),
      g("x22", 22, { shipCount: 1 })];
    const run = (opts) => legs(planPatrols(snap({ fleets }), SUPPLY, PARAMS, new Set(), 1, opts));
    const asToday = [["patrol", "R", 27, 22, GARRISON_RETURN]];
    assert.deepStrictEqual(run(undefined), asToday, "no opts: 25 full (2), R goes to the short 22");
    assert.deepStrictEqual(run({}), asToday, "no opts.dispatched");
    assert.deepStrictEqual(run({ dispatched: { ga: 30 } }), asToday, "not a Map = ignored");
    assert.deepStrictEqual(run({ dispatched: new Map([["ga", 30]]) }), [["patrol", "R", 27, 25, GARRISON_RETURN]],
      "ga counts for 30: 25 short (1), the nearer post");
    const sent = new Map([["ga", 30]]);
    run({ dispatched: sent });
    assert.deepStrictEqual([...sent], [["ga", 30]], "the map is read only");

    const s = { ...snap({ fleets: [g("R", 27), g("ga", 25, { shipCount: 1 }), g("gb", 25, { shipCount: 1 }),
      g("x22", 22, { shipCount: 1 })], operationTypes: ["recon", "raid", "patrol", "return", "defense"] }),
    threats: { mode: "ready", truncated: false, items: [{ systemId: 24, state: "INVASION", occupierStrength: 1,
      phaseDueAt: null }] } };
    const d = decideReview(s, { ...PARAMS, defense: { enabled: true, maxPerReview: 1 } });
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    const launches = d.intents.filter((i) => i.type === "LAUNCH");
    assert.deepStrictEqual(launches.filter((i) => i.kind === "defense").map((i) => [i.fleets.map((x) => x.fleetId),
      i.target.systemId]), [[["ga"], 24]], JSON.stringify(d.notes));
    assert.deepStrictEqual(launches.filter((i) => i.purpose === GARRISON_RETURN).map((i) => [i.fleets[0].fleetId,
      i.target.systemId]), [["R", 25]], JSON.stringify(d.notes));
  });

  const pq = (o) => ({ ...PATROL, maxOpenPickets: 2, scoutReserve: 1, ...o });
  const pk = (id, target, extra = {}) => ({ operationId: id, version: 1, state: "ACTIVE", operationType: "patrol",
    objective: "scout", originSystemId: 20, targetSystemId: target, dueAt: AT + HOUR, members: 1, orderedMembers: 1,
    ...extra });
  const away = (id, sys, op) => sc(id, sys, { state: "STAGED", operationId: op });
  const WIDE = { ...SUPPLY, reach: new Map([[17, 3], [21, 1], [23, 3], [24, 4], [16, 4]]) };

  test("PQ1 picket limit: open patrol/scout operations up to strategy.patrolMaxOpenPickets -> no picket, note "
    + "PATROL_PICKET_CAP once; one open -> one picket; patrol/patrol (garrison patrol / hunt) does not count", () => {
    const scene = (ops) => snap({ fleets: [sc("s1", 20), sc("s2", 20), ...ops.map((op, i) => away(`w${i}`, 30 + i,
      op.operationId))], operations: ops });
    const two = plan(scene([pk("o1", 30), pk("o2", 31)]), { supply: WIDE, params: { patrol: pq() } });
    assert.deepStrictEqual(two, { intents: [], notes: ["PATROL_PICKET_CAP"] });
    const one = plan(scene([pk("o1", 30)]), { supply: WIDE, params: { patrol: pq() } });
    assert.deepStrictEqual([legs(one), one.notes], [[["picket", "s1", 20, 16, null]], ["PATROL:16",
      "PATROL_PICKET_CAP"]], "limit 2 - 1 open = 1 (reserve allows 1 too: both bind -> PATROL_PICKET_CAP)");
    const notPicket = plan(scene([pk("o1", 30, { objective: "patrol" }), pk("o2", 31, { objective: "patrol" })]),
      { supply: WIDE, params: { patrol: pq({ scoutReserve: 0 }) } });
    assert.deepStrictEqual(legs(notPicket).map((x) => x[1]), ["s1", "s2"], "patrol/patrol is no picket");
    assert.deepStrictEqual(plan(scene([]), { supply: WIDE, params: { patrol: pq({ maxOpenPickets: 0,
      scoutReserve: 0 }) } }), { intents: [], notes: [] }, "0 = no pickets, no note");
  });

  test("PQ2 scout reserve: the pool = idle scouts after the recon of the review (used), rested or not; reserve 1 "
    + "keeps one; a lone scout -> PATROL_SCOUT_RESERVE; no rested scout -> no note", () => {
    const fresh = sc("s2", 20, { updatedAt: AT });
    const r = plan(snap({ fleets: [sc("s1", 20), fresh] }), { supply: WIDE, params: { patrol: pq() } });
    assert.deepStrictEqual([legs(r), r.notes], [[["picket", "s1", 20, 16, null]], ["PATROL:16"]]);
    assert.deepStrictEqual(plan(snap({ fleets: [sc("s1", 20)] }), { supply: WIDE, params: { patrol: pq() } }),
      { intents: [], notes: ["PATROL_SCOUT_RESERVE"] });
    assert.deepStrictEqual(plan(snap({ fleets: [sc("s1", 20), fresh] }), { supply: WIDE, params: { patrol: pq() },
      used: new Set(["s2"]) }), { intents: [], notes: ["PATROL_SCOUT_RESERVE"] }, "a scout taken by recon is no pool");
    assert.deepStrictEqual(plan(snap({ fleets: [fresh] }), { supply: WIDE, params: { patrol: pq() } }), EMPTY);
  });

  test("PQ3 observationFronts skips the type patrol and keeps recon / invasion; with 8 slots the "
    + "target of a recon with a high systemId stays in observationOrder despite 8 lower picket systems", () => {
    const op = (operationType, objective, targetSystemId) => ({ operationType, objective, targetSystemId });
    const ops = [op("recon", "scout", 50), op("patrol", "scout", 3), op("invasion", "capture", 40),
      op("patrol", "patrol", 7), op("recon", "scout", 50)];
    assert.deepStrictEqual(observationFronts(ops), [50, 40]);
    assert.deepStrictEqual(observationFronts(undefined), []);
    assert.strictEqual(isPicketOperation({ operationType: "patrol" }), false, "no objective = no picket");
    const pickets = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => op("patrol", "scout", s));
    const all = [...pickets, op("recon", "scout", 99)];
    const fleets = [...pickets.map((p) => ({ systemId: p.targetSystemId, state: "STAGED", fleetRole: "scout" })),
      { systemId: 99, state: "STAGED", fleetRole: "scout" }];
    const old = [...new Set(all.map((x) => x.targetSystemId))];
    assert.ok(!observationOrder(fleets, old, [], 8).includes(99), "before: the recon target fell out");
    assert.deepStrictEqual(observationOrder(fleets, observationFronts(all), [], 8), [99, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("PQ4 config strategy.patrolMaxOpenPickets 0 / patrolScoutReserve 1, clamp 0..16, both in.env.example "
    + "the review passes them in params.patrol; reviewRowBound unchanged (976)", () => {
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env }).config.strategy;
    const S = resolve({});
    assert.deepStrictEqual([S.patrolMaxOpenPickets, S.patrolScoutReserve], [0, 1]);
    const hi = resolve({ EVEJS_LNE_STRATEGY_PATROL_MAX_OPEN_PICKETS: "99", EVEJS_LNE_STRATEGY_PATROL_SCOUT_RESERVE:
      "99" });
    const lo = resolve({ EVEJS_LNE_STRATEGY_PATROL_MAX_OPEN_PICKETS: "-5", EVEJS_LNE_STRATEGY_PATROL_SCOUT_RESERVE:
      "-5" });
    assert.deepStrictEqual([hi.patrolMaxOpenPickets, hi.patrolScoutReserve, lo.patrolMaxOpenPickets,
      lo.patrolScoutReserve], [16, 16, 0, 0]);
    const env = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    for (const k of ["EVEJS_LNE_STRATEGY_PATROL_MAX_OPEN_PICKETS=", "EVEJS_LNE_STRATEGY_PATROL_SCOUT_RESERVE="]) {
      assert.ok(env.includes(`# ${k}`), k);
    }
    const src = fs.readFileSync(path.join(MOD_DIR, "lib", "strategy", "reviewService.js"), "utf8");
    assert.ok(src.includes("maxOpenPickets: S.patrolMaxOpenPickets, scoutReserve: S.patrolScoutReserve"),
      "params.patrol carries both keys");
    const c = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_STRATEGY_PATROL_ENABLED: "1" } }).config;
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview },
      { maxDefensePerReview: c.strategy.maxDefensePerReview }, null, null, null];
    assert.strictEqual(reviewRowBound(...args), 976);
  });

  test("PR-R1 sortie of the role patrol: an IDLE patrol fleet -> LAUNCH patrol also without posts, hostile before "
    + "free before own, a strong enemy refused, CONCORD doctrines without a sortie, roleMaxJumps 0 off, order before the "
    + "garrison sortie", () => {
    const P = { ...PATROL, maxOpenPickets: 0, roleMaxJumps: 6, roleMaxEnemyRatio: 1.5 };
    const pf = (id, sys, extra) => fleet(id, "patrol", sys, SIX, extra);
    const pirate = (o) => {
      const s = snap(o);
      s.doctrine = { ...s.doctrine, returnToBase: false };
      return s;
    };
    const reach = new Map([[21, 1], [23, 3], [24, 4], [26, 6]]);
    const wide = { stationSystems: [20], reach, frontTargets: [] };
    const run = (s, o = {}) => plan(s, { supply: o.supply || wide, params: { patrol: o.patrol || P }, room: o.room });
    const noPosts = pirate({ posts: [], fleets: [pf("p1", 20)] });
    noPosts.territory = [];
    assert.deepStrictEqual(legs(run(noPosts)), [["patrol", "p1", 20, 26, null]], "hostile 26 first, no posts needed");
    const strong = [{ systemId: 26, observedAt: AT - HOUR, hostileFleets: 3, hostileShips: 30,
      hostileStrength: strengthOf(SIX, POWER) * 2, hostileStations: 0, controllerFactionId: HOSTILE }];
    assert.deepStrictEqual(legs(run(pirate({ fleets: [pf("p1", 20)], intel: strong }))),
      [["patrol", "p1", 20, 21, null]], "strong enemy refused, the free system with the oldest intel next");
    const station = pirate({ fleets: [pf("p1", 20)] });
    station.systems = station.systems.map((s) => (s.systemId === 26 ? { ...s, hostileStations: 1 } : s));
    assert.deepStrictEqual(legs(run(station)), [["patrol", "p1", 20, 21, null]], "no system with a hostile station");
    const free = new Map([[23, 3]]);
    assert.deepStrictEqual(legs(run(pirate({ fleets: [pf("p1", 20)] }), { supply: { ...wide, reach: free } })),
      [["patrol", "p1", 20, 23, null]], "own as the last group");
    const passive = pirate({ fleets: [pf("p1", 20)] });
    passive.isPlaying = () => false;
    assert.deepStrictEqual(legs(run(passive)), [["patrol", "p1", 20, 21, null]], "a passive controller is no target");
    assert.deepStrictEqual(legs(run(pirate({ fleets: [pf("p1", 20, { updatedAt: AT })] }))), [], "not rested");
    assert.deepStrictEqual(legs(run(snap({ fleets: [pf("p1", 20)] }))), [], "returnToBase doctrine (CONCORD)");
    const belt = pirate({ fleets: [pf("p1", 20)] });
    belt.doctrine = { ...belt.doctrine, confinedToBelt: true };
    assert.deepStrictEqual(legs(run(belt)), []);
    assert.deepStrictEqual(legs(run(pirate({ fleets: [pf("p1", 20)] }), { patrol: { ...P, roleMaxJumps: 0 } })), []);
    assert.deepStrictEqual(legs(run(pirate({ fleets: [g("g22", 22), pf("p1", 20)] }), { room: 1 })),
      [["patrol", "p1", 20, 26, null]], "before the garrison sortie");
    const k = kinds.get("patrol");
    assert.deepStrictEqual(k.fleetRoles.slice(), ["garrison", "patrol"]);
  });

  {
    const P = { ...PATROL, maxOpenPickets: 0, roleMaxJumps: 6, roleMaxEnemyRatio: 1.5 };
    const ON = { ...P, hostileNeedsFreshIntel: true };
    const pf = (id, sys, extra) => fleet(id, "patrol", sys, SIX, extra);
    const wide = { stationSystems: [20], reach: new Map([[21, 1], [23, 3], [24, 4], [26, 6]]), frontTargets: [] };
    const pirate = (o, doctrine = { returnToBase: false }) => {
      const s = snap({ fleets: [pf("p1", 20)], ...o });
      s.doctrine = { ...s.doctrine, ...doctrine };
      return s;
    };
    const garrisonAt26 = (s, garrison) => {
      s.systems = s.systems.map((r) => (r.systemId === 26 ? { ...r, controllerGarrison: garrison } : r));
      return s;
    };
    const run = (s, patrol) => plan(s, { supply: wide, params: { patrol } });
    const weak = [{ systemId: 26, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 1,
      hostileStrength: strengthOf(ONE, POWER), hostileStations: 0, controllerFactionId: HOSTILE }];
    const stale = [{ ...weak[0], observedAt: AT - 7 * HOUR }];
    const UNKNOWN = "PATROL_HOSTILE_UNKNOWN";

    test("PT-F1 flag on: a hostile system without fresh intel is skipped, the free system next, note "
      + "PATROL_HOSTILE_UNKNOWN (no intel and stale intel)", () => {
      for (const intel of [[], stale]) {
        const r = run(pirate({ intel }), ON);
        assert.deepStrictEqual(legs(r), [["patrol", "p1", 20, 21, null]], JSON.stringify(r.notes));
        assert.ok(r.notes.includes(UNKNOWN), JSON.stringify(r.notes));
        assert.strictEqual(r.notes.filter((n) => n === UNKNOWN).length, 1, "once per review");
      }
    });

    test("PT-F2 flag on: fresh weak intel -> the hostile target before the free one; fresh intel with the "
      + "controller garrison above the ratio -> no hostile target", () => {
      const r = run(pirate({ intel: weak }), ON);
      assert.deepStrictEqual(legs(r), [["patrol", "p1", 20, 26, null]]);
      assert.ok(!r.notes.includes(UNKNOWN));
      const strong = run(garrisonAt26(pirate({ intel: weak }), strengthOf(SIX, POWER) * 2), ON);
      assert.deepStrictEqual(legs(strong), [["patrol", "p1", 20, 21, null]], "garrison counted as in operations.js");
      assert.ok(!strong.notes.includes(UNKNOWN), "refused by strength, not as unknown");
      assert.deepStrictEqual(legs(run(garrisonAt26(pirate({ intel: weak }), strengthOf(SIX, POWER) * 2), P)),
        [["patrol", "p1", 20, 26, null]]);
    });

    test("PT-F3 flag on, hive (returnToBase): a hostile system without intel -> no LAUNCH (PATROL_NO_TARGET "
      + "PATROL_HOSTILE_UNKNOWN), fresh weak intel -> LAUNCH", () => {
      const hive = { returnToBase: true, hive: true };
      const blind = run(pirate({}, hive), ON);
      assert.deepStrictEqual(legs(blind), []);
      assert.ok(blind.notes.includes("PATROL_NO_TARGET") && blind.notes.includes(UNKNOWN), JSON.stringify(blind.notes));
      assert.deepStrictEqual(legs(run(pirate({ intel: weak }, hive), ON)), [["patrol", "p1", 20, 26, null]]);
    });

    test("PT-F4 flag off: the PT-F1 fixture -> today's result (LAUNCH on the hostile system without intel), no "
      + "new note; hostileNeedsFreshIntel absent = off", () => {
      for (const patrol of [P, { ...P, hostileNeedsFreshIntel: false }]) {
        const r = run(pirate({}), patrol);
        assert.deepStrictEqual(legs(r), [["patrol", "p1", 20, 26, null]]);
        assert.ok(!r.notes.includes(UNKNOWN));
      }
      const S = resolveConfig({ modDir: MOD_DIR, env: {} }).config.strategy;
      assert.strictEqual(S.patrolHostileNeedsFreshIntel, false);
      const on = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_STRATEGY_PATROL_HOSTILE_NEEDS_FRESH_INTEL: "1" } });
      assert.strictEqual(on.config.strategy.patrolHostileNeedsFreshIntel, true);
    });
  }

  test("PR-R2 observationOrder: a standing patrol fleet ranks 1 like a scout, an open patrol target is no rank 0",
    () => {
      const ops = [{ operationType: "patrol", objective: "patrol", targetSystemId: 3 },
        { operationType: "invasion", objective: "capture", targetSystemId: 90 }];
      assert.deepStrictEqual(observationFronts(ops), [90]);
      const fleets = [{ systemId: 3, state: "IDLE", fleetRole: "patrol" }, { systemId: 2, state: "IDLE", fleetRole: "garrison" },
        { systemId: 90, state: "STAGED", fleetRole: "invasion" }];
      assert.deepStrictEqual(observationOrder(fleets, observationFronts(ops), [], 3), [90, 3, 2]);
    });

  test("PQ5 flag off: decideReview with patrol null and open operations without pickets -> the same intents with or "
    + "without objective in the snapshot, the same sightIds as the old fronts (protects the IF-OFF digest)", () => {
    const ops = [{ operationId: "o1", version: 1, state: "ACTIVE", operationType: "recon", originSystemId: 20,
      targetSystemId: 26, dueAt: AT + HOUR, members: 1, orderedMembers: 1 }, { operationId: "o2", version: 1,
      state: "PLANNED", operationType: "patrol", originSystemId: 20, targetSystemId: 24, dueAt: AT + HOUR, members: 0,
      orderedMembers: 0 }];
    const withObj = ops.map((op) => ({ ...op, objective: op.operationType === "recon" ? "scout" : "patrol" }));
    const fleets = [fleet("p27", "patrol", 27, SIX), g("g27", 27), g("g25", 25), sc("s20", 20),
      sc("r26", 26, { state: "STAGED", operationId: "o1" })];
    const off = { ...PARAMS, patrol: null };
    const a = decideReview(snap({ fleets, operations: ops }), off);
    const b = decideReview(snap({ fleets, operations: withObj }), off);
    assert.strictEqual(a.outcome, "REVIEWED", a.reason);
    assert.deepStrictEqual(b.intents, a.intents);
    assert.deepStrictEqual(b.notes, a.notes);
    const old = [...new Set(withObj.map((op) => op.targetSystemId))];
    assert.deepStrictEqual(observationOrder(fleets, observationFronts(withObj), [14], 8),
      observationOrder(fleets, old, [14], 8));
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PT5 LAUNCH patrol / picket on a real store: operations patrol/patrol and patrol/scout, counters "
    + "garrisonReturns / patrolsLaunched / picketsLaunched 1 each, not recon", () => H.withStore(driver,
    async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(43) }), graph: R.graphOf(),
        controllers: new Map(R.THEATRE.map((id) => [id, SANSHA])) };
      const state = { base: null, post: null, injected: false };
      const mob = (role, comp) => ({ type: "MOBILIZE", slot: 0, role, systemId: state.base, homeSystemId: state.base,
        composition: comp, cost: { resourceUnits: 1, reserveUnits: 0 }, stationId: null, hulls: [] });
      const leg = (kind, comp, extra) => ({ type: "LAUNCH", slot: 1, kind, target: { kind: "system",
        systemId: state.post, ref: null }, originSystemId: state.base, fleets: [],
      mobilize: [mob(kind === "picket" ? "scout" : "garrison", comp)], dueAt: R.START_MS + R.I * 8, ...extra });
      const hooks = { beforeEffect: (d) => {
        if (state.injected || d.factionId !== SANSHA || d.outcome !== "REVIEWED" || state.base === null) return d;
        state.injected = true;
        const touch = d.intents.findIndex((i) => i.type === "FACTION_TOUCH");
        const intents = [...d.intents];
        intents.splice(touch < 0 ? intents.length : touch, 0, leg("patrol", SIX, { purpose: GARRISON_RETURN }),
          leg("patrol", SIX, {}), leg("picket", ONE, {}));
        return { ...d, intents };
      } };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0" }, { hooks });
      const base = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
        + "ORDER BY station_id", SANSHA)[0];
      assert.ok(base, "a Sansha station");
      state.base = base.system_id;
      state.post = shared.graph.getNeighbors(base.system_id)[0];
      const before = e.strategy.getStatus().ai.review.counters;
      await R.passesAt(e, shared, R.START_MS + R.I);
      assert.ok(state.injected, "a Sansha review ran");
      const ops = e.q("SELECT operation_type AS t, objective AS o, target_system_id AS s FROM world_operations "
        + "WHERE faction_id = ? AND operation_type = 'patrol' ORDER BY objective", SANSHA);
      assert.deepStrictEqual(ops.map((x) => [x.t, x.o, x.s]), [["patrol", "patrol", state.post],
        ["patrol", "patrol", state.post], ["patrol", "scout", state.post]], JSON.stringify(ops));
      const c = e.strategy.getStatus().ai.review.counters;
      assert.deepStrictEqual([c.garrisonReturns, c.patrolsLaunched, c.picketsLaunched], [1, 1, 1], JSON.stringify(c));
      assert.strictEqual(c.recon - (before.recon || 0), c.launches - (before.launches || 0) - 3,
        "a patrol / picket LAUNCH is not counted as a recon");
      assert.ok(e.lines.some((l) => l.includes(`launch picket -> ${state.post}`)), JSON.stringify(e.lines));
      e.strategy.stop("test");
    }));
};
