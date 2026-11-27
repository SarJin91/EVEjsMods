"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { markClaimHolders, parseClaimHoldStates, claimHoldYields, defensePseudo, HOLDING } =
  require("../../../lib/strategy/ai/claimHold");
const { decideReview, decideReactive } = require("../../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
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
const CLAIM = 17;
const TARGET = 14;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const SMALL = [{ hullGroup: "frigate", typeId: null, count: 1 }];
const BIG = [{ hullGroup: "cruiser", typeId: null, count: 4 }];

const HOLD = Object.freeze({ maxMs: 12 * HOUR, states: Object.freeze(["CONTESTED", "INVASION"]),
  roles: Object.freeze(["invasion", "patrol", "garrison", "scout", "reserve"]) });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3, returnFleetRoles: ["patrol"],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 3, routeMaxJumps: 40,
  claimHold: HOLD });

const claim = (state, extra = {}) => ({ systemId: CLAIM, state, occupier: F, phaseDueAt: null, homeOwn: false,
  sinceAt: AT - HOUR, ...extra });
const fleet = (fleetId, composition = BIG, extra = {}) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "patrol",
  systemId: CLAIM, refitPending: false, shipCount: composition.reduce((s, e) => s + e.count, 0),
  strength: strengthOf(composition, POWER), operationId: null, legSeq: 0, homeSystemId: 20, composition,
  updatedAt: AT - 2 * HOUR, ...extra });

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: true });
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "ch", resourceUnits: o.resources === undefined ? 100000
      : o.resources, reserveUnits: o.resources === undefined ? 10000 : o.resources, frontLimit: 3, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 3, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "ch", canOccupy: true, reachJumps: 30, returnToBase: o.returnToBase === true,
      operationTypes: o.operationTypes || ["recon", "raid"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: o.theatre || [TARGET], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(TARGET, HOSTILE), row(CLAIM, HOSTILE), row(20, F), row(15, null), row(16, null)],
    fleets: o.fleets || [], fleetsTruncated: false, operations: o.operations || [], operationsTruncated: false,
    intel: [{ systemId: TARGET, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 1, hostileStrength: 1,
      hostileStations: 0, controllerFactionId: HOSTILE, source: "fleet" }], sightings: [],
    occupations: o.occupations === undefined ? [claim("INVASION")] : o.occupations, territory: [],
    territoryTruncated: false, threats: o.threats };
}

const launched = (d) => d.intents.filter((i) => i.type === "LAUNCH").flatMap((i) => i.fleets.map((f) => f.fleetId));
const markOf = (s, params = PARAMS, pseudo = new Map()) => {
  const notes = markClaimHolders(s, params, pseudo);
  return [[...pseudo.entries()].filter(([, v]) => v === HOLDING).map(([k]) => k), notes];
};

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("CLH1 markClaimHolders: the strongest IDLE fleet of a claim stays (tie fleetId), one is enough; a fleet already "
    + "staying frees the rest; fleets that cannot hold are never picked; expired / unknown age, other states, flag "
    + "off -> nothing", () => {
    const op = (operationId, targetSystemId) => ({ operationId, targetSystemId, state: "ACTIVE" });
    const hold = [["CLAIM_HOLD"]];
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a", SMALL), fleet("b", BIG)] })), [["b"], ...hold]);
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("b"), fleet("a")] })), [["a"], ...hold]);
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a")], occupations: [claim("CONTESTED")] })), [["a"], ...hold]);

    const free = [[], []];
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a"), fleet("b")] }), PARAMS, new Map([["b", "SIEGING"]])), free);
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a"), fleet("b", BIG, { state: "REFITTING" })] })), free);
    assert.deepStrictEqual(markOf(snap({ operations: [op("o1", CLAIM)],
      fleets: [fleet("a"), fleet("b", BIG, { state: "STAGED", operationId: "o1" })] })), free);
    for (const other of [{ state: "PLANNED", operationId: "o2" }, { state: "STAGED", operationId: "o2" },
      { state: "ENGAGED" }, { state: "TRAVELLING", operationId: "o1" }, { systemId: 16 }]) {
      assert.deepStrictEqual(markOf(snap({ operations: [op("o1", CLAIM), op("o2", 30)],
        fleets: [fleet("a"), fleet("b", BIG, other)] })), [["a"], ...hold], JSON.stringify(other));
    }
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a", BIG, { refitPending: true }),
      fleet("b", BIG, { fleetRole: "mining" }), fleet("c", BIG, { strength: 0 })] })), free);

    const expired = [[], ["CLAIM_HOLD_EXPIRED"]];
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a")],
      occupations: [claim("INVASION", { sinceAt: AT - HOLD.maxMs })] })), expired);
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a")],
      occupations: [claim("INVASION", { sinceAt: AT - HOLD.maxMs + 1 })] })), [["a"], ...hold]);
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a")], occupations: [claim("INVASION", { sinceAt: null })] })),
      expired);
    for (const occupations of [[], [claim("OCCUPIED")], [claim("CONSOLIDATING")], [claim("RECON")], [claim("STABLE")],
      [claim("INVASION", { occupier: HOSTILE })]]) {
      assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a")], occupations })), free, JSON.stringify(occupations));
    }
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a")] }), { ...PARAMS, claimHold: null }), free);
    assert.deepStrictEqual(markOf({ ...snap({ fleets: [fleet("a")] }), occupations: undefined }), free);
    assert.deepStrictEqual(markOf(snap({ fleets: [fleet("a")], occupations: [claim("OCCUPIED")] }),
      { ...PARAMS, claimHold: { ...HOLD, states: ["OCCUPIED"] } }), [["a"], ...hold]);
  });

  test("CLH9 claimHoldStates with OCCUPIED: the sole IDLE invasion fleet of an OCCUPIED claim stays (2 h old) "
    + "default states -> free; config warning with a short claimHoldMaxMs, none at the defaults", () => {
    const pmStates = parseClaimHoldStates("CONTESTED,INVASION,OCCUPIED,CONSOLIDATING");
    assert.deepStrictEqual(pmStates, ["CONTESTED", "INVASION", "OCCUPIED", "CONSOLIDATING"]);
    const s = snap({ fleets: [fleet("a", BIG, { fleetRole: "invasion" })],
      occupations: [claim("OCCUPIED", { sinceAt: AT - 2 * HOUR })] });
    assert.deepStrictEqual(markOf(s, { ...PARAMS, claimHold: { ...HOLD, states: pmStates } }),
      [["a"], ["CLAIM_HOLD"]]);
    assert.deepStrictEqual(markOf(s), [[], []], "default CONTESTED,INVASION: the fleet is free");
    const warned = (env) => resolveConfig({ modDir: MOD_DIR, env }).warnings
      .filter((w) => w.startsWith("strategy.claimHoldMaxMs="));
    const PM = { EVEJS_LNE_STRATEGY_CLAIM_HOLD_STATES: "CONTESTED,INVASION,OCCUPIED,CONSOLIDATING" };
    assert.deepStrictEqual(warned(PM), []);
    assert.deepStrictEqual(warned({}), []);
    const short = warned({ ...PM, EVEJS_LNE_STRATEGY_CLAIM_HOLD_MAX_MS: "60000" });
    assert.strictEqual(short.length, 2, JSON.stringify(short));
    assert.ok(short[0].includes("OCCUPIED system may leave before CONSOLIDATING"), short[0]);
  });

  test("CLH2 decideReview offensive: two fleets -> the weaker leaves, the stronger stays; a sole fleet stays and the "
    + "new front mobilizes; a poor faction only notes; free again in OCCUPIED, in STABLE, after the limit; flag off "
    + "-> the sole fleet leaves (the bug)", () => {
    const two = decideReview(snap({ fleets: [fleet("a", SMALL), fleet("b", BIG)] }), PARAMS);
    assert.strictEqual(two.outcome, "REVIEWED", JSON.stringify(two.reason));
    assert.deepStrictEqual(launched(two), ["a"], JSON.stringify(two.notes));
    assert.ok(two.notes.includes("CLAIM_HOLD"), JSON.stringify(two.notes));

    const sole = decideReview(snap({ fleets: [fleet("a")] }), PARAMS);
    assert.deepStrictEqual(launched(sole), [], JSON.stringify(sole.notes));
    const mobs = sole.intents.filter((i) => i.type === "LAUNCH").flatMap((i) => i.mobilize);
    assert.deepStrictEqual(mobs.map((m) => m.type), ["MOBILIZE"], JSON.stringify(sole.intents));

    const poor = decideReview(snap({ fleets: [fleet("a")], resources: 0 }), PARAMS);
    assert.deepStrictEqual(launched(poor), [], JSON.stringify(poor.notes));
    for (const n of ["CLAIM_HOLD", "INSUFFICIENT_RESOURCES", "INSUFFICIENT_FORCE"]) {
      assert.ok(poor.notes.includes(n), `${n}: ${JSON.stringify(poor.notes)}`);
    }

    for (const occupations of [[claim("OCCUPIED")], [claim("STABLE")], [],
      [claim("INVASION", { sinceAt: AT - HOLD.maxMs })]]) {
      const free = decideReview(snap({ fleets: [fleet("a")], occupations }), PARAMS);
      assert.deepStrictEqual(launched(free), ["a"], `${JSON.stringify(occupations)} ${JSON.stringify(free.notes)}`);
    }

    const off = decideReview(snap({ fleets: [fleet("a")] }), { ...PARAMS, claimHold: null });
    assert.deepStrictEqual(launched(off), ["a"], JSON.stringify(off.notes));
    assert.ok(!off.notes.includes("CLAIM_HOLD"));
  });

  test("CLH3 decideReview: a sortie of the role patrol, a MERGE and a return never take the holder; off the claim "
    + "they do", () => {
    const patrol = { windowMs: HOUR, idleMs: HOUR, minShips: 1, garrisonMaxJumps: 4, scoutMaxJumps: 4,
      maxGarrisonsPerPost: 2, maxOpenPickets: 0, scoutReserve: 0, roleMaxJumps: 3, roleMaxEnemyRatio: 1,
      garrisonFleetsTarget: 1 };
    const quiet = { operationTypes: ["patrol"], theatre: [] };
    const sortie = (occupations) => decideReview(snap({ ...quiet, fleets: [fleet("a")], occupations }),
      { ...PARAMS, patrol });
    assert.deepStrictEqual(launched(sortie([claim("INVASION")])), [], "the holder makes no sortie");
    const stable = sortie([claim("STABLE")]);
    assert.deepStrictEqual(launched(stable), ["a"], JSON.stringify(stable.notes));
    assert.strictEqual(stable.intents.find((i) => i.type === "LAUNCH").kind, "patrol");

    const merge = { roles: ["patrol"], maxPerReview: 2, maxShipsPerFleet: 100 };
    const merged = (occupations) => decideReview(snap({ ...quiet, fleets: [fleet("a"), fleet("b")], occupations }),
      { ...PARAMS, merge }).intents.filter((i) => i.type === "MERGE");
    assert.deepStrictEqual(merged([claim("INVASION")]), [], "the holder is no keeper and absorbs nobody");
    assert.strictEqual(merged([]).length, 1);

    const back = (occupations) => decideReview(snap({ ...quiet, returnToBase: true, operationTypes: ["return"],
      fleets: [fleet("a")], occupations }), PARAMS);
    assert.deepStrictEqual(launched(back([claim("CONTESTED")])), [], "the holder does not go home");
    assert.deepStrictEqual(launched(back([])), ["a"]);
  });

  const threatAt = (systemId, occupierStrength = 1) => ({ mode: "ready", truncated: false, items: [{ systemId,
    state: "INVASION", occupier: HOSTILE, occupierStrength, phaseDueAt: AT + HOUR }] });
  const reactiveOf = (s, threats, siege = null) => ({ v: 1, factionId: F, round: 3, at: AT, doctrine: s.doctrine,
    fleets: s.fleets, operations: [], operationsTruncated: false, occupations: s.occupations, threats, siege,
    neighbors: s.neighbors, reactive: { room: 4 } });

  test("CLH4 planDefense in decideReview and decideReactive: a threatened own system -> the sole holder "
    + "defends (note CLAIM_HOLD_YIELDED); with two fleets the defense picks as without a claim and the holder goes "
    + "only when it is needed; off the claim the sole fleet goes", () => {
    const params = { ...PARAMS, defense: { enabled: true, maxPerReview: 1 } };
    const both = (fleets, occupations, threats = threatAt(20)) => {
      const s = snap({ operationTypes: ["defense"], theatre: [], threats, fleets, occupations });
      const review = decideReview(s, params);
      return [launched(review), launched(decideReactive(reactiveOf(s, threats), params)), review.notes];
    };
    const sole = both([fleet("a")], [claim("INVASION")]);
    assert.deepStrictEqual(sole.slice(0, 2), [["a"], ["a"]]);
    assert.ok(sole[2].includes("CLAIM_HOLD") && sole[2].includes("CLAIM_HOLD_YIELDED"), JSON.stringify(sole[2]));
    const enough = both([fleet("a", SMALL), fleet("b", BIG)], [claim("INVASION")]);
    assert.deepStrictEqual(enough.slice(0, 2), [["a"], ["a"]]);
    assert.ok(!enough[2].includes("CLAIM_HOLD_YIELDED"), JSON.stringify(enough[2]));
    const first = both([fleet("a", BIG), fleet("b", SMALL)], [claim("INVASION")]);
    assert.deepStrictEqual(first.slice(0, 2), [["b"], ["b"]], JSON.stringify(first[2]));
    assert.ok(first[2].includes("CLAIM_HOLD") && !first[2].includes("CLAIM_HOLD_YIELDED"), JSON.stringify(first[2]));
    const near = both([fleet("a", BIG), fleet("z", SMALL, { systemId: 20 })], [claim("INVASION")], threatAt(18));
    assert.deepStrictEqual(near.slice(0, 2), [["z"], ["z"]], JSON.stringify(near[2]));
    assert.ok(!near[2].includes("CLAIM_HOLD_YIELDED"), JSON.stringify(near[2]));
    const need = strengthOf(SMALL, POWER) + 1;
    const strong = both([fleet("a", SMALL), fleet("b", BIG)], [claim("INVASION")], threatAt(20, need));
    assert.deepStrictEqual(strong.slice(0, 2), [["a", "b"], ["a", "b"]], JSON.stringify(strong[2]));
    assert.deepStrictEqual(both([fleet("a")], []).slice(0, 2), [["a"], ["a"]]);
  });

  test("CLH8 cap: maxFleetsPerOperation 2, required 10, the holder h (8, 1 jump) and the free "
    + "a, b (3 each, 2 jumps) -> the second pass sends h and a (CLAIM_HOLD_YIELDED); a and b enough -> h stays", () => {
    const params = { ...PARAMS, maxFleetsPerOperation: 2, defense: { enabled: true, maxPerReview: 1 } };
    const fleets = [fleet("h", BIG, { strength: 8 }), fleet("a", SMALL, { systemId: 20, strength: 3 }),
      fleet("b", SMALL, { systemId: 20, strength: 3 })];
    const both = (occupierStrength) => {
      const threats = threatAt(18, occupierStrength);
      const s = snap({ operationTypes: ["defense"], theatre: [], threats, fleets });
      const review = decideReview(s, params);
      return [launched(review), launched(decideReactive(reactiveOf(s, threats), params)), review.notes];
    };
    const cap = both(8);
    assert.deepStrictEqual(cap.slice(0, 2), [["h", "a"], ["h", "a"]], JSON.stringify(cap[2]));
    assert.ok(cap[2].includes("CLAIM_HOLD") && cap[2].includes("CLAIM_HOLD_YIELDED"), JSON.stringify(cap[2]));
    assert.ok(!cap[2].some((n) => n.startsWith("DEFENSE_INSUFFICIENT")), JSON.stringify(cap[2]));
    const enough = both(5);
    assert.deepStrictEqual(enough.slice(0, 2), [["a", "b"], ["a", "b"]], JSON.stringify(enough[2]));
    assert.ok(enough[2].includes("CLAIM_HOLD") && !enough[2].includes("CLAIM_HOLD_YIELDED"), JSON.stringify(enough[2]));
  });

  test("CLH7: no threat and no siege -> the holder stays shielded (defensePseudo = the same map) "
    + "a threat out of reach frees it for no other planner; a besieged own station -> the holder relieves it in "
    + "decideReview and decideReactive; the hive still pins only its home claim", () => {
    const pseudo = new Map([["a", HOLDING], ["s", "SIEGING"]]);
    assert.strictEqual(defensePseudo(snap({}), pseudo), pseudo);
    assert.strictEqual(defensePseudo({ ...snap({}), threats: { mode: "ready", items: [] } }, pseudo), pseudo);
    assert.strictEqual(defensePseudo({ ...snap({}), threats: { mode: "off", items: threatAt(20).items } }, pseudo),
      pseudo);
    assert.deepStrictEqual([...defensePseudo(snap({ threats: threatAt(20) }), pseudo)], [["s", "SIEGING"]]);
    assert.deepStrictEqual([...pseudo], [["a", HOLDING], ["s", "SIEGING"]], "the caller map is not touched");
    assert.strictEqual(claimHoldYields(snap({})), false);

    const far = decideReview(snap({ operationTypes: ["recon", "raid", "defense"], fleets: [fleet("a")],
      threats: threatAt(40) }), { ...PARAMS, defense: { enabled: true, maxPerReview: 1 } });
    assert.deepStrictEqual(launched(far), [], JSON.stringify(far.notes));
    assert.ok(far.notes.includes("CLAIM_HOLD") && !far.notes.includes("CLAIM_HOLD_YIELDED"), JSON.stringify(far.notes));

    const siege = { mode: "ready", truncated: false, attacking: [], defending: [{ systemId: 20, stationId: "st20",
      state: "SHIELD", phaseEndsAt: AT + HOUR, attackerStrength: 1 }] };
    const sp = { ...PARAMS, siege: { reliefEnabled: true, reliefLeadMs: 6 * HOUR, reliefHoldMs: HOUR,
      maxReliefPerReview: 1, fleetRoles: ["patrol"] } };
    const s = { ...snap({ operationTypes: ["defense"], theatre: [], fleets: [fleet("a")] }), siege };
    const review = decideReview(s, sp);
    assert.deepStrictEqual(launched(review), ["a"], JSON.stringify(review.notes));
    assert.ok(review.notes.includes("CLAIM_HOLD_YIELDED"), JSON.stringify(review.notes));
    assert.deepStrictEqual(launched(decideReactive(reactiveOf(s, { mode: "off", truncated: false, items: [] }, siege),
      sp)), ["a"]);
    assert.deepStrictEqual(launched(decideReview({ ...s, siege: null }, sp)), []);
    const s2 = { ...s, fleets: [fleet("a", BIG), fleet("z", SMALL, { systemId: 23 })] };
    const r2 = decideReview(s2, sp);
    assert.deepStrictEqual(launched(r2), ["z"], JSON.stringify(r2.notes));
    assert.ok(!r2.notes.includes("CLAIM_HOLD_YIELDED"), JSON.stringify(r2.notes));
    assert.deepStrictEqual(launched(decideReactive(reactiveOf(s2, { mode: "off", truncated: false, items: [] }, siege),
      sp)), ["z"]);

    const hive = (homeOwn, threats) => {
      const h = snap({ fleets: [fleet("a")], occupations: [claim("INVASION", { homeOwn })], threats });
      return { ...h, doctrine: { ...h.doctrine, hive: true } };
    };
    assert.deepStrictEqual(markOf(hive(false)), [[], []]);
    assert.deepStrictEqual(markOf(hive(true)), [["a"], ["CLAIM_HOLD"]]);
    const hp = new Map();
    markClaimHolders(hive(true, threatAt(20)), PARAMS, hp);
    assert.deepStrictEqual([...defensePseudo(hive(true, threatAt(20)), hp)], []);
    assert.deepStrictEqual([...defensePseudo(hive(true), hp)], [["a", HOLDING]]);
  });

  test("CLH5 config: defaults, a refused state list -> default + warning, the parser", () => {
    const of = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: "x", ...env } });
    const c = of({}).config.strategy;
    assert.deepStrictEqual([c.claimHoldEnabled, c.claimHoldStates, c.claimHoldRoles, c.claimHoldMaxMs],
      [true, "CONTESTED,INVASION", "invasion,patrol,garrison,scout,reserve", 43200000]);
    const bad = of({ EVEJS_LNE_STRATEGY_CLAIM_HOLD_STATES: "STABLE" });
    assert.strictEqual(bad.config.strategy.claimHoldStates, "CONTESTED,INVASION");
    assert.ok(bad.warnings.some((w) => w.includes("EVEJS_LNE_STRATEGY_CLAIM_HOLD_STATES")), JSON.stringify(bad.warnings));
    assert.deepStrictEqual(parseClaimHoldStates(" INVASION , OCCUPIED "), ["INVASION", "OCCUPIED"]);
    assert.deepStrictEqual(parseClaimHoldStates("none"), []);
    for (const v of ["", "INVASION,INVASION", "RECON", 5]) assert.strictEqual(parseClaimHoldStates(v), null);
  });

  needsDriver("CLH6 real store: the review snapshot carries sinceAt of the claim, params.claimHold follows the flag "
    + "(off -> a sole fleet is not held)", async () => {
    const run = (env) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map(R.THEATRE.map((id) => [id, SANSHA]));
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(59) }), graph: R.graphOf(), controllers };
      const seen = { d: null, s: null };
      const hooks = { beforeEffect: (d, s) => {
        if (seen.d === null && d.factionId === SANSHA && d.outcome === "REVIEWED") Object.assign(seen, { d, s });
        return d;
      } };
      const base = R.upkeepWorld(controllers, new Map());
      const state = { row: null };
      const world = { repository: { ...base.repository,
        listByOccupier: (tx, f) => ({ ok: true, systems: f === SANSHA && state.row ? [state.row] : [] }) } };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", ...env }, { hooks, world });
      const home = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
        + "ORDER BY station_id", SANSHA)[0].system_id;
      const systemId = shared.graph.getNeighbors(home)[0];
      state.row = { systemId, occupationState: "INVASION", occupierFactionId: SANSHA, phaseDueAt: null,
        homeFactionId: null, lastStateChangeAt: R.START_MS - HOUR };
      const g = e.fleets.createFleet({ factionId: SANSHA, currentSystemId: systemId, homeSystemId: systemId,
        fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 4 }] }, "clh6:g");
      assert.ok(g.ok, JSON.stringify(g));
      await R.passesAt(e, shared, R.START_MS + R.I);
      e.strategy.stop("test");
      assert.ok(seen.d, "a Sansha review ran");
      return { occupations: seen.s.occupations, notes: seen.d.notes, systemId };
    });
    const on = await run({});
    assert.deepStrictEqual(on.occupations.map((o) => [o.systemId, o.state, o.sinceAt]),
      [[on.systemId, "INVASION", R.START_MS - HOUR]]);
    assert.ok(on.notes.includes("CLAIM_HOLD"), JSON.stringify(on.notes));
    const off = await run({ EVEJS_LNE_STRATEGY_CLAIM_HOLD_ENABLED: "0" });
    assert.ok(!off.notes.includes("CLAIM_HOLD"), JSON.stringify(off.notes));
  });
};
