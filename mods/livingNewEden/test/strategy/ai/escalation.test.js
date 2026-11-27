"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { escalationLevelOf, templateLadderOf, templateLadderWithDropsOf } =
  require("../../../lib/strategy/ai/escalation");
const { chooseNextOperation } = require("../../../lib/strategy/ai/operations");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createRng } = require("../../../lib/util/rng");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../../lib/strategy/registry");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { createHostility } = require("../../../lib/battle/data/hostility");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../../lib/battle/data/capitalStrengthRows");
const { escalationParamsOf } = require("../../../lib/strategy/reviewService");
const { resolveConfig } = require("../../../config");
const { createManualClock } = require("../../../lib/util/clock");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: SH } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const H = 9;
const CTX = Object.freeze({ hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
  hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
  maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
const POWER = buildPowerTable(GROUPS);
const GARRISON = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);

const calTable = (permille) => buildPowerTable(expandStrengthGroups(GROUPS, null,
  capitalPowerOverlayOf({ battleshipPowerCalibrated: true, battleshipPowerPermille: permille })));
const T520 = calTable(520);
const T800 = calTable(800);

function doctrineOfCal(mode, id, table) {
  const r = createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, battleshipDoctrines: mode,
    battleshipPowerCalibrated: true, powerTable: table });
  assert.ok(r.ok, JSON.stringify(r));
  return r.registry.getDoctrine(id);
}

function doctrineOf(mode, id) {
  const r = createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, battleshipDoctrines: mode });
  assert.ok(r.ok, JSON.stringify(r));
  return r.registry.getDoctrine(id);
}

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();

function escalationOn() {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
    EVEJS_LNE_STRATEGY_ESCALATION_ENABLED: "1" } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const p = escalationParamsOf(r.config);
  assert.deepStrictEqual({ ...p }, { fleetsL1: 2, fleetsL2: 4, fleetsL3: 6, valueBonus: 1, lossStep: 2, maxLevel: 3 });
  return p;
}

const PROD = Object.freeze({ maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 2,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 9000,
  maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  production: PROD });

function hullsOf(template, n = 1) {
  const out = {};
  for (const e of template) out[e.hullGroup] = (out[e.hullGroup] || 0) + e.count * n;
  return out;
}

function scene(doctrine, hulls, enemy, o = {}) {
  const T = 1;
  const capture = o.invasion === true;
  const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: 40, frontLimit: 1 }, entry: { homeRegionIds: [] },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: capture, captureTargets: capture ? ["contested"] : [],
      operationTypes: capture ? ["recon", "invasion"] : ["recon", "raid"], templates: doctrine.templates,
      stockTemplates: doctrine.stockTemplates },
    theatre: [T], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === H,
    stations: [{ systemId: 10, stationId: "st" }],
    systems: [{ systemId: T, controllerFactionId: H, occupationState: "STABLE", controllerGarrison: 0,
      hostileStations: 0, observed: false }],
    fleets: [], operations: [], operationsTruncated: false,
    intel: [{ systemId: T, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 6, hostileStrength: enemy,
      hostileStations: 0, controllerFactionId: H }], sightings: [],
    production: { mode: "ready", recipesVersion: 1, recipes: {}, inProduction: {}, activeJobsTotal: 0, truncated: false,
      stations: [{ stationId: "st", systemId: 10, kind: "npc", lines: 2, activeJobs: [], minerals: {}, hulls }] } };
  const supply = { frontTargets: [], frontLimit: 1, anchors: [40], stationSystems: [10],
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6 }, reach: new Map([[T, 1]]),
    captureReach: capture ? new Map([[T, 1]]) : new Map(), captureRoom: null, border: new Map() };
  const P = { ...PARAMS, ...(o.params || {}) };
  const out = chooseNextOperation(s, supply, P, createRng(1), createHullLedger(s, P));
  const mobs = out.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
  return { out, mobs };
}

const groupsOf = (m) => m.composition.map((e) => e.hullGroup);
const enemyFor = (base, need) => Math.floor((base * (need - 1) + 1) / 1.2) + 1;

module.exports = ({ test, skip }) => {
  test("EL0 vendor data: patrol vs a 4cr+2BC garrison -> level >= 1, invasion vs the same garrison -> level 0 "
    + "(empire-border-defense-v2, pirate-territorial-v2, default thresholds)", () => {
    const p = escalationOn();
    const enemy = strengthOf(GARRISON, POWER);
    const required = Math.max(1, Math.ceil(enemy * 1.2));
    for (const id of ["empire-border-defense-v2", "pirate-territorial-v2"]) {
      const d = doctrineOf("stock", id);
      const input = (role) => ({ required, baseStrength: strengthOf(d.templates[role], POWER), category: null,
        hostileStations: 0, playerSystem: false, losses: 0 });
      const needOf = (role) => Math.ceil(required / strengthOf(d.templates[role], POWER));
      const patrol = escalationLevelOf(input("patrol"), p);
      assert.ok(patrol.level >= 1, `${id} patrol need=${needOf("patrol")} level=${patrol.level}`);
      const invasion = escalationLevelOf(input("invasion"), p);
      assert.strictEqual(invasion.level, 0, `${id} invasion need=${needOf("invasion")} level=${invasion.level}`);
    }
    const base = { required: 1, baseStrength: 10, category: "home", hostileStations: 0, playerSystem: false,
      losses: 5 };
    assert.deepStrictEqual(escalationLevelOf(base, p), { level: 3, pressure: 0, value: 1, losses: 2 });
    assert.strictEqual(escalationLevelOf({ ...base, losses: 0 }, { ...p, maxLevel: 0 }).level, 0);
    assert.strictEqual(escalationLevelOf(null, p).level, 0);
    assert.strictEqual(escalationLevelOf(base, null).level, 0);
    assert.strictEqual(escalationLevelOf({ ...base, required: "x" }, p).level, 0);
  });

  test("EL1 flag off / level 0: a raid target needing 3 patrol fleets -> intents deepStrictEqual with the call "
    + "without params.escalation", () => {
    const d = doctrineOf("stock", "empire-border-defense-v2");
    const enemy = enemyFor(strengthOf(d.templates.patrol, POWER), 3);
    const hulls = { ...hullsOf(d.templates.patrol, 3), ...hullsOf(d.stockTemplates.invasion, 1) };
    const base = scene(d, hulls, enemy);
    assert.strictEqual(base.mobs.length, 3, JSON.stringify(base.out));
    assert.ok(base.mobs.every((m) => m.role === "patrol" && !("escalation" in m) && !("escalationFallback" in m)));
    assert.ok(base.mobs.every((m) => !("escalationLevel" in m)), JSON.stringify(base.mobs));
    const off = scene(d, hulls, enemy, { params: { escalation: null } });
    assert.deepStrictEqual(off.out, base.out);
    const zero = scene(d, hulls, enemy, { params: { escalation: { ...escalationOn(), maxLevel: 0 } } });
    const unlevel = (m) => {
      assert.ok(Number.isSafeInteger(m.escalationLevel), JSON.stringify(m));
      assert.strictEqual(m.escalationLevel, 0, JSON.stringify(m));
      const { escalationLevel, ...rest } = m;
      return rest;
    };
    assert.strictEqual(zero.mobs.length, 3, JSON.stringify(zero.out));
    const zeroToday = { ...zero.out, intents: zero.out.intents.map((i) => (i.type === "MOBILIZE" ? unlevel(i)
      : i.type === "LAUNCH" ? { ...i, mobilize: i.mobilize.map(unlevel) } : i)) };
    assert.deepStrictEqual(zeroToday, base.out);
  });

  test("EL2 on, stock: an invasion at level 1 with battleships at the station -> MOBILIZE with battleship, "
    + "escalation 1, note ESCALATION_L1", () => {
    const d = doctrineOf("stock", "empire-border-defense-v2");
    const enemy = enemyFor(strengthOf(d.templates.invasion, POWER), 2);
    const r = scene(d, hullsOf(d.stockTemplates.invasion, 2), enemy,
      { invasion: true, params: { escalation: escalationOn() } });
    const launch = r.out.intents.find((i) => i.type === "LAUNCH");
    assert.ok(launch && launch.kind === "invasion", JSON.stringify(r.out));
    assert.ok(r.mobs.length >= 1);
    assert.ok(groupsOf(r.mobs[0]).includes("battleship"), JSON.stringify(r.mobs[0]));
    assert.strictEqual(r.mobs[0].role, "invasion");
    assert.strictEqual(r.mobs[0].escalation, 1);
    assert.ok(!("escalationFallback" in r.mobs[0]));
    assert.ok(r.out.notes.includes("ESCALATION_L1"), JSON.stringify(r.out.notes));
    assert.ok(!r.out.notes.includes("ESCALATION_FALLBACK"), JSON.stringify(r.out.notes));
  });

  test("EL3 on: a raid on a target needing 2 patrol fleets -> MOBILIZE role invasion (battlecruisers), LAUNCH raid "
    + "with it", () => {
    const d = doctrineOf("off", "empire-border-defense-v2");
    const enemy = enemyFor(strengthOf(d.templates.patrol, POWER), 2);
    const r = scene(d, { ...hullsOf(d.templates.patrol, 2), ...hullsOf(d.templates.invasion, 1) }, enemy,
      { params: { escalation: escalationOn() } });
    const launch = r.out.intents.find((i) => i.type === "LAUNCH");
    assert.ok(launch && launch.kind === "raid", JSON.stringify(r.out));
    assert.strictEqual(launch.mobilize.length, 1, JSON.stringify(launch));
    assert.strictEqual(launch.mobilize[0].role, "invasion");
    assert.ok(groupsOf(launch.mobilize[0]).includes("battlecruiser"));
    assert.strictEqual(launch.mobilize[0].escalation, 1);
    assert.ok(r.out.notes.includes("ESCALATION_L1"), JSON.stringify(r.out.notes));
  });

  test("EL4 on, stock, no battleships at the station -> MOBILIZE of the base invasion template with "
    + "escalationFallback, note ESCALATION_FALLBACK, no NO_HULLS:battleship", () => {
    const d = doctrineOf("stock", "empire-border-defense-v2");
    const enemy = enemyFor(strengthOf(d.templates.invasion, POWER), 2);
    const r = scene(d, hullsOf(d.templates.invasion, 2), enemy,
      { invasion: true, params: { escalation: escalationOn() } });
    assert.ok(r.mobs.length >= 1, JSON.stringify(r.out));
    for (const m of r.mobs) {
      assert.deepStrictEqual(m.composition.map(({ hullGroup, count }) => ({ hullGroup, count })),
        d.templates.invasion.map(({ hullGroup, count }) => ({ hullGroup, count })));
      assert.strictEqual(m.escalationFallback, true);
      assert.ok(!("escalation" in m));
    }
    assert.ok(r.out.notes.includes("ESCALATION_FALLBACK"), JSON.stringify(r.out.notes));
    assert.ok(!r.out.notes.includes("NO_HULLS:battleship"), JSON.stringify(r.out.notes));
    assert.ok(!r.out.notes.includes("ESCALATION_L1"), JSON.stringify(r.out.notes));
  });

  test("EL5 templateLadderOf: off mode (stockTemplates = templates) drops the battleship step; stock keeps it; "
    + "scout one step", () => {
    const off = doctrineOf("off", "empire-border-defense-v2");
    const stock = doctrineOf("stock", "empire-border-defense-v2");
    const roles = (l) => l.map((x) => x.role);
    assert.deepStrictEqual(roles(templateLadderOf(off, "invasion")), ["invasion"]);
    assert.deepStrictEqual(roles(templateLadderOf(off, "patrol")), ["patrol", "invasion"]);
    assert.deepStrictEqual(roles(templateLadderOf(stock, "patrol")), ["patrol", "invasion", "invasion"]);
    const inv = templateLadderOf(stock, "invasion");
    assert.deepStrictEqual(roles(inv), ["invasion", "invasion"]);
    assert.strictEqual(inv[0].template, stock.templates.invasion);
    assert.ok(inv[1].template.some((e) => e.hullGroup === "battleship"));
    assert.deepStrictEqual(templateLadderOf(stock, "scout"), [{ role: "scout", template: stock.templates.scout }]);
    assert.deepStrictEqual(roles(templateLadderOf(stock, "garrison")), ["garrison", "invasion", "invasion"]);
  });

  test("EL6 stock + calibration 520: the garrison ladder drops the weaker BS_GARRISON step (dropped 1); without a "
    + "table the step stays (the bug)", () => {
    const d = doctrineOfCal("stock", "empire-border-defense-v2", T520);
    const roles = (l) => l.map((x) => x.role);
    const r = templateLadderWithDropsOf(d, "garrison", T520);
    assert.deepStrictEqual(roles(r.ladder), ["garrison", "invasion", "invasion"]);
    assert.strictEqual(r.dropped, 1);
    assert.strictEqual(r.ladder[0].template, d.templates.garrison);
    assert.deepStrictEqual(roles(templateLadderOf(d, "garrison")), ["garrison", "garrison", "invasion", "invasion"]);
    assert.deepStrictEqual(templateLadderWithDropsOf(d, "scout", T520),
      { ladder: [{ role: "scout", template: d.templates.scout }], dropped: 0 });
    assert.strictEqual(templateLadderWithDropsOf(d, "garrison", [1, 2]).dropped, 0);
  });

  test("EL7 every doctrine x off|stock|on x {uncalibrated, 520, 800} x patrol|invasion|garrison: ladder strengths "
    + "strictly rising; uncalibrated = the ladder without a table", () => {
    const variants = [{ table: POWER, ctx: {} },
      { table: T520, ctx: { battleshipPowerCalibrated: true, powerTable: T520 } },
      { table: T800, ctx: { battleshipPowerCalibrated: true, powerTable: T800 } }];
    for (const { doctrineId } of REGISTRY_DATA_V1.doctrines) {
      for (const mode of ["off", "stock", "on"]) {
        for (const [vi, v] of variants.entries()) {
          const r = createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, battleshipDoctrines: mode, ...v.ctx });
          assert.ok(r.ok, JSON.stringify(r));
          const d = r.registry.getDoctrine(doctrineId);
          for (const role of ["patrol", "invasion", "garrison"]) {
            const { ladder } = templateLadderWithDropsOf(d, role, v.table);
            const at = `${doctrineId} ${mode} v${vi} ${role}`;
            const s = ladder.map((x) => strengthOf(x.template, v.table));
            for (let i = 1; i < s.length; i += 1) assert.ok(s[i] > s[i - 1], `${at} ${JSON.stringify(s)}`);
            if (vi === 0) assert.deepStrictEqual(ladder, templateLadderOf(d, role), at);
          }
        }
      }
    }
  });

  test("EL8 on, stock + calibration 520: a garrison-role attack at level 1 -> MOBILIZE invasion v18 (no battleship), "
    + "escalation 1, notes ESCALATION_STEP_DROPPED once + ESCALATION_L1, no ladderDropped on the intent", () => {
    const d = doctrineOfCal("stock", "empire-border-defense-v2", T520);
    const list = kinds.list.map((k) => (k.kind === "raid"
      ? { ...k, mobilizeRole: "garrison", fleetRoles: ["garrison", ...k.fleetRoles] } : k));
    const enemy = enemyFor(strengthOf(d.templates.garrison, T520), 2);
    const r = scene(d, hullsOf(d.templates.invasion, 2), enemy,
      { params: { escalation: escalationOn(), powerTable: T520, kinds: list } });
    const launch = r.out.intents.find((i) => i.type === "LAUNCH");
    assert.ok(launch && launch.kind === "raid", JSON.stringify(r.out));
    assert.ok(r.mobs.length >= 1, JSON.stringify(r.out));
    for (const m of r.mobs) {
      assert.strictEqual(m.role, "invasion", JSON.stringify(m));
      assert.ok(!groupsOf(m).includes("battleship"), JSON.stringify(m));
      assert.strictEqual(m.escalation, 1);
      assert.ok(!("ladderDropped" in m), JSON.stringify(m));
    }
    assert.strictEqual(r.out.notes.filter((n) => n === "ESCALATION_STEP_DROPPED").length, 1,
      JSON.stringify(r.out.notes));
    assert.ok(r.out.notes.includes("ESCALATION_L1"), JSON.stringify(r.out.notes));
  });

  test("EL9 on: escalationLevel = the level of the target on every branch (level 0 without escalation, the "
    + "winning step, the fallback)", () => {
    const p = escalationOn();
    const levelOf = (template, enemy) => escalationLevelOf({ required: Math.max(1, Math.ceil(enemy * 1.2)),
      baseStrength: strengthOf(template, POWER), category: null, hostileStations: 0, playerSystem: false, losses: 0 },
    p).level;
    const off = doctrineOf("off", "empire-border-defense-v2");
    const e0 = enemyFor(strengthOf(off.templates.patrol, POWER), 1);
    assert.strictEqual(levelOf(off.templates.patrol, e0), 0);
    const a = scene(off, hullsOf(off.templates.patrol, 2), e0, { params: { escalation: p } });
    assert.ok(a.mobs.length >= 1, JSON.stringify(a.out));
    for (const m of a.mobs) {
      assert.strictEqual(m.escalationLevel, 0, JSON.stringify(m));
      assert.ok(!("escalation" in m), JSON.stringify(m));
    }
    const e1 = enemyFor(strengthOf(off.templates.patrol, POWER), 2);
    const b = scene(off, { ...hullsOf(off.templates.patrol, 2), ...hullsOf(off.templates.invasion, 1) }, e1,
      { params: { escalation: p } });
    assert.strictEqual(b.mobs.length, 1, JSON.stringify(b.out));
    assert.deepStrictEqual([b.mobs[0].escalation, b.mobs[0].escalationLevel], [1, levelOf(off.templates.patrol, e1)]);
    assert.ok(b.mobs[0].escalationLevel >= 1);
    const st = doctrineOf("stock", "empire-border-defense-v2");
    const e2 = enemyFor(strengthOf(st.templates.invasion, POWER), 2);
    const c = scene(st, hullsOf(st.templates.invasion, 2), e2, { invasion: true, params: { escalation: p } });
    assert.ok(c.mobs.length >= 1, JSON.stringify(c.out));
    for (const m of c.mobs) {
      assert.deepStrictEqual([m.escalationFallback, m.escalationLevel], [true, levelOf(st.templates.invasion, e2)]);
      assert.ok(m.escalationLevel >= 1);
    }
  });

  const driver = SH.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  needsDriver("EL9 counters on a real store: applied MOBILIZE with escalationLevel 0 and 2 count "
    + "escalationLevel0 1 and escalationLevel2 1", () => SH.withStore(driver, async (reopen) => {
    const SANSHA = 500019;
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(43) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, SANSHA])) };
    const state = { base: null, post: null, injected: false };
    const hooks = { beforeEffect: (d) => {
      if (state.injected || d.factionId !== SANSHA || d.outcome !== "REVIEWED" || state.base === null) return d;
      state.injected = true;
      const mob = (slot, escalationLevel) => ({ type: "MOBILIZE", slot, role: "garrison", systemId: state.base,
        homeSystemId: state.base, composition: [{ hullGroup: "cruiser", typeId: null, count: 2 }],
        cost: { resourceUnits: 2, reserveUnits: 0 }, stationId: null, hulls: [], escalationLevel });
      const launch = { type: "LAUNCH", slot: 2, kind: "garrison", target: { kind: "system", systemId: state.post,
        ref: null }, originSystemId: state.base, fleets: [], mobilize: [mob(0, 0), mob(1, 2)],
        dueAt: R.START_MS + R.I * 8 };
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
    await R.passesAt(e, shared, R.START_MS + R.I);
    assert.ok(state.injected, "a Sansha review ran");
    const k = e.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([0, 1, 2, 3].map((n) => k[`escalationLevel${n}`] || 0), [1, 0, 1, 0], JSON.stringify(k));
    e.strategy.stop("test");
  }));
};
