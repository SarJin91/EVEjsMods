"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { planExpeditions, capitalMassOf, capitalCountOf, fleetMassOf } =
  require("../../../lib/strategy/expeditions/expeditionRules");
const { CAPITAL_TYPE_MASS_KG, CAPITAL_CLASS_MASS_KG, SUBCAP_CLASS_MASS_KG } =
  require("../../../lib/fleets/data/hullMasses");
const { HULL_GROUPS } = require("../../../lib/fleets/schema");
const { CLASS_SOURCE_TYPES } = require("../../../lib/fleets/data/capitalClasses");
const { FACTION_HULL_CLASSES } = require("../../../lib/strategy/data/factionHullClasses");
const { findServerSrcOnDisk } = require("../../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 6;
const SANSHA = 500019;
const SYS = Object.freeze({ K0: 1, K1: 2, J1: 31000001, J2: 31000002 });
const SEC = new Map([[SYS.K0, "nullsec"], [SYS.K1, "nullsec"], [SYS.J1, "wormhole"], [SYS.J2, "wormhole"]]);
const GATES = new Map([[SYS.K0, [SYS.K1]], [SYS.K1, [SYS.K0]], [SYS.J1, []], [SYS.J2, []]]);
const AT = 1760000000000;
const BN = 1000000000;
const PARAMS = Object.freeze({ maxActiveExpeditions: 3, maxActiveExpeditionsPerFaction: 1, maxExpeditionsPerPlan: 2,
  entryMaxJumps: 5, maxBfsSystems: 100, candidateTopN: 1, expeditionMinMs: 3600000, expeditionMaxMs: 14400000,
  returnMarginMs: 1800000 });
const ON = Object.freeze({ ...PARAMS, massRuleEnabled: true, maxCapitalHulls: 1,
  massRuleExcludedGroups: Object.freeze(["supercarrier"]) });
const OFF = Object.freeze({ ...ON, massRuleEnabled: false });
const edge = (pairKey, from, to, maxJumpMass, expiresAt = 0) => ({ pairKey, fromSystemId: from, toSystemId: to,
  expiresAt, createdAt: 0, ...(maxJumpMass === undefined ? {} : { maxJumpMass }) });
const EDGES = Object.freeze([edge("1@1", SYS.K0, SYS.J2, BN), edge("2@1", SYS.K1, SYS.J1, 2 * BN)]);
const CRUISERS = Object.freeze({ hullGroup: "cruiser", typeId: null, count: 4 });

function input(composition, edges = EDGES) {
  return { at: AT, round: 7, worldSeed: 42, openTotal: 0, occupiedSystems: new Set(), edges,
    factions: [{ factionId: SANSHA, openCount: 0, fleets: [{ fleetId: "fleet_a", version: 1, systemId: SYS.K0,
      state: "IDLE", fleetRole: "patrol", refitPending: false, operationId: null, composition, jumpMs: 60000 }] }],
    getSystem: (id) => (SEC.has(id) ? { secClass: SEC.get(id), regionId: 1 } : null),
    neighbors: (id) => GATES.get(id) || [] };
}

const withCap = (hullGroup, count = 1, typeId = null) => [{ hullGroup, typeId, count }, CRUISERS];
const plansOf = (r) => r.plans.map((p) => [p.systemId, p.entryPairKey, p.minJumpMass]);

module.exports = ({ test, skip }) => {
  const X = require("./expeditionService.test").harness;
  const driver = X.H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("MR1 wh-expedition-mass-rule hull masses: every LNE capital typeID measured, class mass = max of its hulls; "
    + "vendor rule numericShipMass > pair.maxJumpMass", () => {
    const classOf = new Map();
    for (const cls of Object.keys(CLASS_SOURCE_TYPES)) {
      for (const typeId of Object.values(CLASS_SOURCE_TYPES[cls])) classOf.set(typeId, cls);
    }
    for (const row of Object.values(FACTION_HULL_CLASSES)) {
      for (const [cls, typeId] of Object.entries(row)) classOf.set(typeId, cls);
    }
    const missing = [...classOf.keys()].filter((id) => !Object.prototype.hasOwnProperty.call(CAPITAL_TYPE_MASS_KG, id));
    const maxOf = {};
    for (const [typeId, cls] of classOf) maxOf[cls] = Math.max(maxOf[cls] || 0, CAPITAL_TYPE_MASS_KG[typeId] || 0);
    maxOf.capital = Math.max(maxOf.carrier, maxOf.dreadnought, maxOf.force_auxiliary);
    const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, "server/src of EveJS on disk");
    const runtime = fs.readFileSync(path.join(found.srcDir, "services", "exploration", "wormholes",
      "wormholeRuntime.js"), "utf8");
    assert.deepStrictEqual([missing, classOf.size, Object.keys(CAPITAL_TYPE_MASS_KG).length,
      { ...CAPITAL_CLASS_MASS_KG }, runtime.includes("numericShipMass > pair.maxJumpMass")],
    [[], 32, 32, maxOf, true]);
    assert.deepStrictEqual(maxOf, { carrier: 1260000000, dreadnought: 1290000000, force_auxiliary: 1310000000,
      supercarrier: 1780000000, titan: 2400000000, capital: 1310000000 });
  });

  test("MR2 wh-expedition-mass-rule planner: carrier NO_FLEET with the flag off; on -> the 2 bn pair, minJumpMass "
    + "1260000000; a fleet without a capital plans the same on and off", () => {
    const carrier = withCap("carrier");
    const off = planExpeditions(input(carrier), OFF);
    const on = planExpeditions(input(carrier), ON);
    const plainOn = planExpeditions(input([CRUISERS]), ON);
    const plainOff = planExpeditions(input([CRUISERS]), OFF);
    const bare = planExpeditions(input([CRUISERS]), PARAMS);
    assert.deepStrictEqual([off.plans, off.skips, plansOf(on), on.skips, plansOf(plainOn)],
      [[], { NO_FLEET: 1 }, [[SYS.J1, "2@1", 1260000000]], {}, [[SYS.J2, "1@1", 0]]]);
    assert.deepStrictEqual(plainOn, plainOff);
    assert.deepStrictEqual(plainOn, bare, "params without the mass keys = the flag off");
    assert.deepStrictEqual([capitalMassOf(withCap("dreadnought", 1, 87381)), capitalMassOf(withCap("dreadnought")),
      capitalMassOf([CRUISERS]), capitalCountOf([...withCap("carrier", 2), { hullGroup: "capital", count: 1 }])],
    [1130000000, 1290000000, 0, 3]);
  });

  test("MR3 wh-expedition-mass-rule refusals: titan TOO_MASSIVE, supercarrier NO_FLEET by default, 2 capitals at max "
    + "1 NO_FLEET, maxJumpMass 0 / absent fail-closed, EXPIRES_TOO_SOON before TOO_MASSIVE", () => {
    const got = {};
    got.titan = planExpeditions(input(withCap("titan")), ON).skips;
    got.superDefault = planExpeditions(input(withCap("supercarrier")), ON).skips;
    got.superAllowed = plansOf(planExpeditions(input(withCap("supercarrier")), { ...ON, massRuleExcludedGroups: [] }));
    got.two = planExpeditions(input(withCap("carrier", 2)), ON).skips;
    got.twoAt2 = plansOf(planExpeditions(input(withCap("carrier", 2)), { ...ON, maxCapitalHulls: 2 }));
    got.zero = planExpeditions(input(withCap("carrier"), [edge("2@1", SYS.K1, SYS.J1, 0)]), ON).skips;
    got.absent = planExpeditions(input(withCap("carrier"), [edge("2@1", SYS.K1, SYS.J1)]), ON).skips;
    const short = AT + 60000;
    got.order = planExpeditions(input(withCap("carrier"), [edge("1@1", SYS.K0, SYS.J2, BN),
      edge("2@1", SYS.K1, SYS.J1, 2 * BN, short)]), ON).skips;
    assert.deepStrictEqual(got, {
      titan: { TOO_MASSIVE: 1 },
      superDefault: { NO_FLEET: 1 },
      superAllowed: [[SYS.J1, "2@1", 1780000000]],
      two: { NO_FLEET: 1 },
      twoAt2: [[SYS.J1, "2@1", 1260000000]],
      zero: { TOO_MASSIVE: 1 },
      absent: { TOO_MASSIVE: 1 },
      order: { EXPIRES_TOO_SOON: 1 },
    });
  });

  needsDriver("MR5 wh-expedition-mass-rule service: the plan and the evacuation of a carrier fleet carry "
    + "wormholeMinJumpMass (leg v2 too), a fleet without a capital plans with {wormholes:true}", () => X.H.withStore(
    driver, async (reopen) => {
      const shared = X.H.sharedOf();
      const seen = [];
      const heavy = (p) => ({ ...p, maxJumpMass: 2 * BN });
      const env = await X.boot(reopen(), shared, X.testConfig({ capitalMassRuleEnabled: true,
        maxActiveExpeditionsPerFaction: 2, candidateTopN: 1 }),
      { list: [heavy(X.pair(X.PAIR_A, X.S.N0, X.J1)), heavy(X.pair(X.PAIR_B, X.S.N0, X.J2))] }, {
        travel: (real) => ({ planInTx: (db, input, key, o) => {
          seen.push([key.endsWith(":evac:plan") ? "evac" : "plan", input.fleetId, input.constraints]);
          return real.planInTx(db, input, key, o);
        } }) });
      try {
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        const cap = env.fleets.createFleet({ factionId: X.SANSHA, currentSystemId: X.S.N0, homeSystemId: X.S.N0,
          fleetRole: "patrol", composition: [{ hullGroup: "carrier", count: 1 }, { hullGroup: "cruiser", count: 4 }] },
        "test:cap");
        assert.ok(cap.ok, JSON.stringify(cap));
        const plain = X.newFleet(env, "plain", X.SANSHA, X.S.N0);
        const { exp } = await X.planOne(env);
        const leg = env.fleet(cap.fleetId).route;
        await env.drive(env.planRound() * env.cfg.expeditions.planPeriodMs);
        await env.drive(exp.evacuate_at);
        const MASS = 1260000000;
        const WH = { wormholes: true, wormholeMinJumpMass: MASS };
        assert.deepStrictEqual([exp.fleet_id, leg.constraints, env.row(exp.expedition_id).state, seen], [cap.fleetId,
          WH, "EVACUATING", [["plan", cap.fleetId, WH], ["plan", plain, { wormholes: true }],
            ["evac", cap.fleetId, WH]]]);
      } finally {
        env.stop();
      }
    }));

  test("SM1 wh-expedition-subcap-mass data: subcap + capital class tables cover HULL_GROUPS, disjoint, safe integers "
    + "> 0, thresholds; capitalMassOf = fleetMassOf(capitals only)", () => {
    const sub = Object.keys(SUBCAP_CLASS_MASS_KG);
    const cap = Object.keys(CAPITAL_CLASS_MASS_KG);
    const values = [...Object.values(SUBCAP_CLASS_MASS_KG), ...Object.values(CAPITAL_CLASS_MASS_KG)];
    const S = SUBCAP_CLASS_MASS_KG;
    const comps = [withCap("dreadnought", 1, 87381), withCap("dreadnought"), withCap("carrier"), withCap("titan"),
      withCap("supercarrier"), withCap("carrier", 2), [CRUISERS], [{ hullGroup: "battleship", count: 2 }]];
    assert.deepStrictEqual({
      uncovered: HULL_GROUPS.filter((g) => !sub.includes(g) && !cap.includes(g)),
      shared: sub.filter((g) => cap.includes(g)),
      subCount: sub.length,
      bad: values.filter((v) => !Number.isSafeInteger(v) || v <= 0),
      thresholds: [S.battleship > 62000000, S.cruiser > 5000000, S.frigate <= 5000000, S.destroyer <= 5000000],
      same: comps.map((c) => capitalMassOf(c) === fleetMassOf(c, { capitals: true, subcaps: false })),
      capital: comps.map((c) => capitalMassOf(c)),
    }, {
      uncovered: [], shared: [], subCount: 17, bad: [], thresholds: [true, true, true, true],
      same: comps.map(() => true),
      capital: [1130000000, 1290000000, 1260000000, 2400000000, 1780000000, 1260000000, 0, 0],
    });
  });

  test("SM2 wh-expedition-subcap-mass planner: subcap flag off = byte for byte as before; on -> battleship "
    + "TOO_MASSIVE through 62 mln, 375 mln pair chosen, frigates fit 62 mln, cruisers miss a 5 mln pair", () => {
    const SUB_ON = Object.freeze({ ...PARAMS, subcapMassRuleEnabled: true });
    const SUB_OFF = Object.freeze({ ...PARAMS, subcapMassRuleEnabled: false });
    const bs = [{ hullGroup: "battleship", typeId: null, count: 2 }, { hullGroup: "frigate", typeId: null, count: 2 }];
    const only62 = [edge("1@1", SYS.K0, SYS.J2, 62000000)];
    const both = [edge("1@1", SYS.K0, SYS.J2, 62000000), edge("2@1", SYS.K1, SYS.J1, 375000000)];
    const off = planExpeditions(input(bs, only62), SUB_OFF);
    assert.deepStrictEqual(off, planExpeditions(input(bs, only62), PARAMS), "flag off = params without the key");
    const on = planExpeditions(input(bs, only62), SUB_ON);
    const frig = [{ hullGroup: "frigate", typeId: null, count: 4 }];
    const cruisers = [{ hullGroup: "cruiser", typeId: null, count: 2 }, { hullGroup: "frigate", typeId: null, count: 3 }];
    assert.deepStrictEqual({
      off: plansOf(off),
      on: [on.plans, on.skips],
      heavy: plansOf(planExpeditions(input(bs, both), SUB_ON)),
      frig: plansOf(planExpeditions(input(frig, only62), SUB_ON)),
      cruiser: planExpeditions(input(cruisers, [edge("1@1", SYS.K0, SYS.J2, 5000000)]), SUB_ON).skips,
    }, {
      off: [[SYS.J2, "1@1", 0]],
      on: [[], { TOO_MASSIVE: 1 }],
      heavy: [[SYS.J1, "2@1", 105300000]],
      frig: [[SYS.J2, "1@1", 1630000]],
      cruiser: { TOO_MASSIVE: 1 },
    });
  });

  test("SM3 wh-expedition-subcap-mass flag matrix: carrier + battleship with both rules -> 1 260 000 000; carrier "
    + "with the capital rule off and the subcap rule on -> NO_FLEET (EXCLUDED_HULL_GROUPS)", () => {
    const mixed = [{ hullGroup: "battleship", typeId: null, count: 1 }, { hullGroup: "carrier", typeId: null, count: 1 }];
    assert.deepStrictEqual([plansOf(planExpeditions(input(mixed), { ...ON, subcapMassRuleEnabled: true })),
      planExpeditions(input(withCap("carrier")), { ...OFF, subcapMassRuleEnabled: true }).skips],
    [[[SYS.J1, "2@1", 1260000000]], { NO_FLEET: 1 }]);
  });

  const subcapRun = (subcap) => X.H.withStore(driver, async (reopen) => {
    const shared = X.H.sharedOf();
    const seen = [];
    const mass = (p, maxJumpMass) => ({ ...p, maxJumpMass });
    const pairs = { list: [mass(X.pair(X.PAIR_A, X.S.N0, X.J1), 62000000)] };
    const env = await X.boot(reopen(), shared, X.testConfig({ subcapMassRuleEnabled: subcap, candidateTopN: 1 }),
      pairs, { travel: (real) => ({ planInTx: (db, inp, key, o) => {
        seen.push([key.endsWith(":evac:plan") ? "evac" : "plan", inp.fleetId, inp.constraints]);
        return real.planInTx(db, inp, key, o);
      } }) });
    try {
      assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
      const C = env.cfg.expeditions;
      const fl = env.fleets.createFleet({ factionId: X.SANSHA, currentSystemId: X.S.N0, homeSystemId: X.S.N0,
        fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 2 }, { hullGroup: "frigate", count: 3 }] },
      "test:sm4");
      assert.ok(fl.ok, JSON.stringify(fl));
      const { exp } = await X.planOne(env);
      const id = exp.expedition_id;
      const leg = env.fleet(fl.fleetId).route.constraints;
      await env.drive(exp.arrive_at);
      const active = env.row(id).state;
      pairs.list = [mass(X.pair(X.PAIR_D, X.S.N9, X.J1), 5000000)];
      env.sync();
      const cutAt = exp.arrive_at + C.stepIntervalMs;
      await env.drive(cutAt);
      const linkLost = env.row(id).state;
      if (subcap) {
        pairs.list = [mass(X.pair(X.PAIR_D, X.S.N9, X.J1), 62000000)];
        env.sync();
        await env.drive(cutAt + C.cutOffRecheckMs);
      } else {
        await env.drive(exp.evacuate_at);
      }
      return { fleetId: fl.fleetId, leg, active, linkLost, evac: env.row(id).state,
        cutOff: env.status().counters.cutOff, seen };
    } finally {
      env.stop();
    }
  });

  needsDriver("SM4 wh-expedition-subcap-mass service: subcap rule on -> plan / leg v2 / evacuation carry "
    + "wormholeMinJumpMass 13190000, a 5 mln exit = CUT_OFF; off -> {wormholes:true} and the 5 mln exit is used",
  async () => {
    const WH = { wormholes: true, wormholeMinJumpMass: 13190000 };
    const on = await subcapRun(true);
    const off = await subcapRun(false);
    assert.deepStrictEqual(on, { fleetId: on.fleetId, leg: WH, active: "ACTIVE", linkLost: "CUT_OFF",
      evac: "EVACUATING", cutOff: 1, seen: [["plan", on.fleetId, WH], ["evac", on.fleetId, WH]] });
    assert.deepStrictEqual(off, { fleetId: off.fleetId, leg: { wormholes: true }, active: "ACTIVE",
      linkLost: "ACTIVE", evac: "EVACUATING", cutOff: 0,
      seen: [["plan", off.fleetId, { wormholes: true }], ["evac", off.fleetId, { wormholes: true }]] });
  });
};
