"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig, SCHEMA } = require("../../config");
const seams = require("../../lib/adapter/highsecTrafficScene");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { REL } = require("../../lib/population/data/standingRules");
const { REL_HOSTILE, aggroSettingsOf, planAggro } = require("../../lib/highsecLife/traffic/aggro");
const { AGGRO_SCENE_METHODS } = require("../../lib/highsecLife/traffic/service");
const rig = require("./trafficPilots.test").rig;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const SYS = 30000144;
const HOSTILE_F = 500010;
const FRIENDLY_F = 500001;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name}`);
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end < 0 ? src.length : end);
}

function fakeGame() {
  const writes = [];
  const orders = [];
  const ent = (itemID, x, extra) => ({ itemID, kind: "ship", nativeNpc: true, position: { x, y: 0, z: 0 }, ...extra });
  const entities = [
    ent(9001, 0, { operatorKind: "lneTraffic" }),
    ent(9002, 0, { operatorKind: "lneSituation" }),
    ent(7001, 5000, { operatorKind: "lne", factionId: HOSTILE_F }),
    ent(7002, 3000, { operatorKind: "asteroidBeltRat", factionId: HOSTILE_F }),
    ent(7003, 4000, { operatorKind: "", factionId: HOSTILE_F }),
    ent(7004, 2000, { operatorKind: "lne", factionId: HOSTILE_F }),
    ent(7005, 1000, { operatorKind: "lne", factionId: HOSTILE_F, capitalNpc: true }),
    ent(7006, 500000, { operatorKind: "lne", factionId: HOSTILE_F }),
  ];
  const byId = new Map(entities.map((e) => [e.itemID, e]));
  const ctl = (kind, extra) => ({ operatorKind: kind, behaviorOverrides: { autoAggro: false }, manualOrder: null,
    ...extra });
  const controllers = new Map([[9001, ctl("lneTraffic")], [9002, ctl("lneSituation")], [7001, ctl("lne")],
    [7002, ctl("asteroidBeltRat")], [7003, ctl("")], [7004, ctl("lne", { manualOrder: { type: "attack",
      targetID: 1 } })], [7005, ctl("lne")], [7006, ctl("lne")]]);
  const records = new Map([[9001, { entityID: 9001, operatorKind: "lneTraffic" }]]);
  const scene = { dynamicEntities: byId, staticEntities: [], getEntityByID: (id) => byId.get(id) || null };
  const mods = {
    "space/runtime": { scenes: new Map([[SYS, scene]]), isSolarSystemSceneLoaded: (id) => id === SYS },
    "space/npc/nativeNpcService": { spawnNativeNpcEntityInSystem: () => ({ success: false }) },
    "space/npc/npcService": {
      getControllerByEntityID: (id) => controllers.get(id) || null,
      setBehaviorOverrides(id, o) {
        writes.push([id, { ...o }]);
        const c = controllers.get(id);
        if (!c) return { success: false, errorMsg: "NPC_NOT_FOUND" };
        c.behaviorOverrides = { ...o };
        return { success: true };
      },
      issueManualOrder(id, order) {
        orders.push([id, order.type, order.targetID]);
        const c = controllers.get(id);
        if (!c) return { success: false, errorMsg: "NPC_NOT_FOUND" };
        const type = String(order.type || "").toLowerCase();
        c.manualOrder = type === "resume" || type === "resumebehavior" ? null : { ...order };
        if (type === "attack" && order.targetID > 0) {
          c.currentTargetID = order.targetID;
          c.preferredTargetID = order.targetID;
        } else if (type === "stop") {
          c.currentTargetID = 0;
        }
        return { success: true };
      },
      wakeNpcController: () => ({ success: true }),
      destroyNpcControllerByEntityID: () => ({ success: true }),
    },
    "space/npc/nativeNpcStore": { listNativeControllersForSystem: () => [], getNativeEntity: (id) => records.get(id),
      upsertNativeEntity: () => ({ success: true }) },
    "space/npc/npcRuntime": { warpToPoint: () => ({ success: true }) },
    "space/worldData": { getStargatesForSystem: () => [], getStationsForSystem: () => [],
      getAsteroidBeltsForSystem: () => [], getCelestialsForSystem: () => [] },
    "services/character/factionKillStandingRuntime": { resolveVictimFactionID: (e) => e.factionId || 0 },
  };
  return { mods, byId, controllers, records, writes, orders };
}

function adapterSeam(g) {
  const { createAdapter } = require("../../lib/adapter");
  const fakeSrc = path.join(path.sep, "fake-evejs", "src");
  const cache = {};
  for (const rel of Object.keys(g.mods)) cache[path.join(fakeSrc, `${rel}.js`)] = { exports: g.mods[rel] };
  const adapter = createAdapter({ moduleApi: { _cache: cache } });
  assert.strictEqual(adapter.setServerSrc(fakeSrc).ok, true);
  const tools = adapter.getHighsecTrafficScene();
  assert.strictEqual(tools.ok, true, JSON.stringify(tools));
  return tools.seam;
}

const att = (entityId, kind, factionId, distanceMeters) => ({ entityId, kind, factionId, distanceMeters });

function standings() {
  return { profileOf: (id) => id,
    relationOf: (_p, f) => (f === HOSTILE_F ? REL.HOSTILE : f === FRIENDLY_F ? REL.FRIENDLY : REL.NEUTRAL) };
}

function aggroScene(threatsOf) {
  const f = rig.fakeScene();
  const calls = [];
  f.scene.readThreats = (sys, ids, opts) => {
    calls.push(["read", sys, [...ids], { ...opts }]);
    const ex = typeof opts.excludeOf === "function" ? opts.excludeOf : null;
    let excluded = 0;
    const threats = ids.map((id) => ({ pilotShipId: id, armedKind: null, attackers: threatsOf(id).filter((a) => {
      const out = ex !== null && ex(a.entityId) === true;
      if (out) excluded += 1;
      return !out;
    }) }));
    return { ok: true, threats, ...(ex !== null ? { excluded } : {}) };
  };
  f.scene.armPilotTarget = (sys, id, attackerIds, kind) => {
    calls.push(["arm", id, [...attackerIds], kind]);
    return { ok: true, kind, ordered: attackerIds.length, failed: [],
      borrowed: attackerIds.map((entityId) => ({ entityId, overrides: { a: 1 }, order: null })) };
  };
  f.scene.disarmPilotTarget = (sys, id, borrowed) => {
    calls.push(["disarm", id, borrowed]);
    return { ok: true, restored: true, released: Array.isArray(borrowed) ? borrowed.length : 0, kept: 0,
      releaseFailed: 0 };
  };
  return { f, calls };
}

const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
const AGGRO_ON = Object.freeze({ ...rig.LIVE_ON, standingAggroEnabled: true, standingAggroHoldMs: 10000,
  standingAggroCooldownMs: 10000 });

module.exports = ({ test }) => {
  test("SA1 vendor fact: NPC vs NPC needs the flag and the same controller operatorKind on both sides", () => {
    const src = readSource("space/npc/npcBehaviorLoop.js");
    const friendly = functionBody(src, "isFriendlyCombatTarget");
    assert.ok(friendly.includes("sourceController.behaviorOverrides.allowFriendlyNpcTargets === true"));
    assert.ok(friendly.includes("targetController.behaviorOverrides.allowFriendlyNpcTargets === true"));
    assert.ok(friendly.includes("sourceOperatorKind === targetOperatorKind"));
    assert.match(friendly, /const sourceController = getControllerByEntityID\(/);
    assert.match(friendly, /String\(sourceController && sourceController\.operatorKind \|\| ""\)\.trim\(\)/);
    assert.ok(functionBody(src, "isValidCombatTarget").includes("!isFriendlyCombatTarget(entity, target)"));
    assert.ok(functionBody(src, "setBehaviorOverrides").includes("controller.behaviorOverrides = "));
    assert.ok(functionBody(src, "normalizeBehaviorOverrides").includes("\"allowFriendlyNpcTargets\""));
  });

  test("SA2 adapter: arm writes only the live controller of the pilot ship, foreign attacker / target refused, disarm",
    () => {
      const g = fakeGame();
      const seam = adapterSeam(g);
      assert.deepStrictEqual(seams.AGGRO_METHODS.filter((m) => typeof seam[m] !== "function"), []);
      assert.deepStrictEqual(seam.readThreats(SYS, [9001, 9002], { rangeMeters: 100000, maxCandidates: 32 }),
        { ok: true, threats: [{ pilotShipId: 9001, armedKind: null,
          attackers: [{ entityId: 7001, kind: "lne", factionId: HOSTILE_F, distanceMeters: 5000 }] }] });

      for (const id of [7002, 7003]) {
        assert.strictEqual(seam.armPilotTarget(SYS, 9001, [id], "lne").reason, "FOREIGN_ATTACKER", String(id));
      }
      assert.strictEqual(seam.armPilotTarget(SYS, 9002, [7001], "lne").reason, "NOT_PILOT");
      assert.strictEqual(seam.armPilotTarget(SYS, 9001, [7001], "asteroidBeltRat").reason, "INVALID_INPUT");
      assert.deepStrictEqual([g.writes, g.orders], [[], []], "no write before the checks pass");
      assert.deepStrictEqual([g.controllers.get(7002).operatorKind, g.controllers.get(7003).operatorKind,
        g.controllers.get(9002).operatorKind], ["asteroidBeltRat", "", "lneSituation"]);

      const armed = seam.armPilotTarget(SYS, 9001, [7001], "lne");
      assert.deepStrictEqual(armed, { ok: true, kind: "lne", ordered: 1, failed: [],
        borrowed: [{ entityId: 7001, overrides: { autoAggro: false }, order: null }] });
      const pilot = g.controllers.get(9001);
      assert.deepStrictEqual([pilot.operatorKind, pilot.behaviorOverrides.allowFriendlyNpcTargets,
        pilot.behaviorOverrides.autoAggro], ["lne", true, false]);
      assert.deepStrictEqual([g.byId.get(9001).operatorKind, g.records.get(9001).operatorKind],
        ["lneTraffic", "lneTraffic"], "entity and store record keep lneTraffic");
      assert.deepStrictEqual(g.orders, [[7001, "attack", 9001]]);
      assert.strictEqual(g.controllers.get(7001).operatorKind, "lne", "the attacker kind is never written");
      assert.deepStrictEqual(seam.readThreats(SYS, [9001], { rangeMeters: 100000, maxCandidates: 32 }),
        { ok: true, threats: [{ pilotShipId: 9001, armedKind: "lne", attackers: [] }] });

      assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9001), { ok: true, restored: true });
      assert.deepStrictEqual([pilot.operatorKind, "allowFriendlyNpcTargets" in pilot.behaviorOverrides,
        pilot.behaviorOverrides.autoAggro], ["lneTraffic", false, false]);
      assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9001), { ok: true, restored: true }, "idempotent");
      assert.strictEqual(seam.disarmPilotTarget(SYS, 9002).reason, "NOT_PILOT");
      assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9999), { ok: true, restored: false });
      assert.strictEqual(seam.disarmPilotTarget(SYS + 1, 9001).reason, "SCENE_NOT_LOADED");
      assert.deepStrictEqual(liveProfiles.PILOT_AGGRO_KINDS, ["lne", "lne-duel"]);

      const att7001 = g.controllers.get(7001);
      assert.deepStrictEqual(att7001.manualOrder.type, "attack", "a disarm without borrowed leaves the attacker");
      g.orders.length = 0;
      assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9001, armed.borrowed),
        { ok: true, restored: true, released: 1, kept: 0, releaseFailed: 0 });
      assert.deepStrictEqual([g.orders, att7001.behaviorOverrides], [[[7001, "stop", undefined],
        [7001, "resume", undefined]], { autoAggro: false }]);
      assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9001, armed.borrowed),
        { ok: true, restored: true, released: 0, kept: 1, releaseFailed: 0 }, "idempotent");
      const again = seam.armPilotTarget(SYS, 9001, [7001], "lne");
      att7001.manualOrder = { type: "attack", targetID: 5555 };
      const ownerOverrides = { ...att7001.behaviorOverrides };
      assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9001, again.borrowed),
        { ok: true, restored: true, released: 0, kept: 1, releaseFailed: 0 });
      assert.deepStrictEqual(att7001.behaviorOverrides, ownerOverrides);
      att7001.manualOrder = null;
      assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9999, [{ entityId: 7001, overrides: { autoAggro: false },
        order: null }]), { ok: true, restored: false, released: 1, kept: 0, releaseFailed: 0 });
      assert.deepStrictEqual(att7001.behaviorOverrides, { autoAggro: false });
      assert.strictEqual(seam.disarmPilotTarget(SYS, 9001, [{ entityId: 7001 }]).reason, "INVALID_INPUT");

      att7001.manualOrder = null;
      const opts = { rangeMeters: 100000, maxCandidates: 32 };
      assert.deepStrictEqual(seam.readThreats(SYS, [9001], { ...opts, excludeOf: (id) => id === 7001 }),
        { ok: true, threats: [{ pilotShipId: 9001, armedKind: null, attackers: [] }], excluded: 1 });
      assert.strictEqual(seam.readThreats(SYS, [9001], { ...opts, excludeOf: () => { throw new Error("x"); } })
        .excluded, 1);
      assert.strictEqual(seam.readThreats(SYS, [9001], { ...opts, excludeOf: 1 }).reason, "INVALID_INPUT");
      assert.deepStrictEqual(seam.readThreats(SYS, [9001], opts).threats[0].attackers.map((a) => a.entityId), [7001]);

      const g2 = fakeGame();
      const seam2 = adapterSeam(g2);
      const npc2 = g2.mods["space/npc/npcService"];
      const setOverrides = npc2.setBehaviorOverrides;
      npc2.issueManualOrder = () => ({ success: false, errorMsg: "ORDER_REFUSED" });
      npc2.setBehaviorOverrides = (id, o) => (id === 9001 && !o.allowFriendlyNpcTargets
        ? { success: false, errorMsg: "NOPE" } : setOverrides(id, o));
      const refused = seam2.armPilotTarget(SYS, 9001, [7001], "lne");
      assert.deepStrictEqual([refused.reason, /disarm RESTORE_FAILED/.test(refused.detail)], ["ATTACK_FAILED", true],
        JSON.stringify(refused));
      assert.deepStrictEqual(g2.controllers.get(7001).behaviorOverrides, { autoAggro: false });

      const symOf = (p, n) => GAME_MODULES.find((e) => e.path === p).symbols.find((s) => s.name === n);
      for (const [p, n] of [["space/npc/npcService", "getControllerByEntityID"],
        ["space/npc/npcService", "setBehaviorOverrides"], ["space/npc/npcService", "issueManualOrder"],
        ["space/npc/npcService", "wakeNpcController"],
        ["services/character/factionKillStandingRuntime", "resolveVictimFactionID"]]) {
        const s = symOf(p, n);
        assert.ok(s.consumers.includes("populationStandingAggro") && !s.wrap, `${p}.${n}`);
      }
    });

  test("SA3 planner: hostile nearest of one kind, friendly / neutral skipped, attacker once, cooling, deterministic",
    () => {
      assert.strictEqual(REL_HOSTILE, REL.HOSTILE, "mirror of standingRules REL.HOSTILE");
      const st = standings();
      const input = (over) => ({ threats: [
        { pilotShipId: 1, attackers: [att(11, "lne", HOSTILE_F, 900), att(12, "lne-duel", HOSTILE_F, 100),
          att(13, "lne-duel", HOSTILE_F, 300), att(14, "lne-duel", HOSTILE_F, 200), att(15, "lne", FRIENDLY_F, 50)] },
        { pilotShipId: 2, attackers: [att(12, "lne-duel", HOSTILE_F, 100), att(13, "lne-duel", HOSTILE_F, 150)] },
        { pilotShipId: 3, attackers: [att(15, "lne", FRIENDLY_F, 50), att(16, "lne", 500002, 70)] },
        { pilotShipId: 4, attackers: [att(17, "lne", HOSTILE_F, 10)] },
        { pilotShipId: 5, attackers: [] }],
      pilotOf: (id) => id + 100, relationOf: (p, f) => st.relationOf(st.profileOf(p), f), armed: new Map(),
      cooldownUntil: new Map([[4, 2000]]), now: 1000, maxAttackers: 2, ...over });
      const plan = planAggro(input());
      assert.deepStrictEqual(plan, { orders: [{ pilotShipId: 1, kind: "lne-duel", attackerIds: [12, 14] },
        { pilotShipId: 2, kind: "lne-duel", attackerIds: [13] }], friendlySkipped: 1, hostileSeen: 6 });
      assert.deepStrictEqual(planAggro(input()), plan, "deterministic");
      const later = planAggro(input({ now: 2000, armed: new Map([[1, {}]]) }));
      assert.deepStrictEqual(later.orders, [{ pilotShipId: 2, kind: "lne-duel", attackerIds: [12, 13] },
        { pilotShipId: 4, kind: "lne", attackerIds: [17] }]);
      assert.deepStrictEqual(planAggro(input({ maxAttackers: 1 })).orders[0].attackerIds, [12]);

      assert.strictEqual(aggroSettingsOf(DEFAULTS.population.live), null, "flag off -> null");
      assert.deepStrictEqual(aggroSettingsOf({ ...DEFAULTS.population.live, standingAggroEnabled: true }),
        { rangeMeters: 100000, maxSystemsPerPass: 4, maxAttackers: 2, maxCandidates: 32, holdMs: 120000,
          cooldownMs: 60000 });
    });

  test("SA4 traffic: arm, disarm after holdMs + cooldown, GONE clears armed; flag off = zero calls, status of before",
    () => {
      const threatsOf = () => [att(7001, "lne", HOSTILE_F, 5000), att(7002, "lne", FRIENDLY_F, 1000)];
      const on = aggroScene(threatsOf);
      const pop = rig.fakePopulation([rig.cand(1, "HAULER", "GATE", rig.FROM, rig.NEXT)]);
      pop.standings = standings;
      const h = rig.harness({ pop, live: AGGRO_ON, scene: on.f });
      h.tick();
      const shipId = [...on.f.alive.keys()][0];
      assert.deepStrictEqual(on.calls.filter((c) => c[0] === "arm"), [["arm", shipId, [7001], "lne"]]);
      let ag = h.traffic.status().aggro;
      assert.deepStrictEqual([ag.armed, ag.counters.armed, ag.counters.attackersOrdered, ag.counters.hostileSeen,
        ag.counters.systemsRead], [1, 1, 1, 1, 1]);
      h.tick();
      assert.strictEqual(on.calls.filter((c) => c[0] === "read").length, 1);
      h.tick();
      ag = h.traffic.status().aggro;
      assert.deepStrictEqual([ag.armed, ag.counters.disarmed], [0, 1]);
      const B = [{ entityId: 7001, overrides: { a: 1 }, order: null }];
      assert.deepStrictEqual(on.calls.filter((c) => c[0] === "disarm"), [["disarm", shipId, B]]);
      assert.strictEqual(ag.counters.attackersReleased, 1);
      h.tick();
      assert.strictEqual(on.calls.filter((c) => c[0] === "arm").length, 1);
      h.tick();
      assert.strictEqual(on.calls.filter((c) => c[0] === "arm").length, 2);
      assert.strictEqual(h.traffic.status().aggro.armed, 1);
      on.f.alive.delete(shipId);
      h.tick();
      const st = h.traffic.status();
      assert.deepStrictEqual([st.aggro.armed, st.counters.pilotKilled, st.counters.gone], [0, 1, 1]);
      assert.deepStrictEqual(on.calls.filter((c) => c[0] === "disarm").slice(1), [["disarm", shipId, B]],
        "a gone armed ship releases its attackers");
      assert.strictEqual(st.aggro.counters.attackersReleased, 2);
      assert.deepStrictEqual(on.calls[0][3], { rangeMeters: 100000, maxCandidates: 32 }, "no isLiveBattleShip = before");

      const live = aggroScene(threatsOf);
      const popL = rig.fakePopulation([rig.cand(1, "HAULER", "GATE", rig.FROM, rig.NEXT)]);
      popL.standings = standings;
      const hL = rig.harness({ pop: popL, live: AGGRO_ON, scene: live.f,
        plExtra: { isLiveBattleShip: (id) => id === 7001 } });
      hL.tick();
      const agL = hL.traffic.status().aggro;
      assert.deepStrictEqual([live.calls.filter((c) => c[0] === "arm").length, agL.counters.liveBattleSkipped,
        typeof live.calls[0][3].excludeOf], [0, 1, "function"]);
      const stopS = aggroScene(threatsOf);
      const popS = rig.fakePopulation([rig.cand(1, "HAULER", "GATE", rig.FROM, rig.NEXT)]);
      popS.standings = standings;
      const hS = rig.harness({ pop: popS, live: AGGRO_ON, scene: stopS.f });
      hS.tick();
      hS.traffic.stop();
      assert.deepStrictEqual(stopS.calls.filter((c) => c[0] === "disarm").map((c) => c[2]), [B]);

      const noSt = aggroScene(threatsOf);
      const h2 = rig.harness({ pop: rig.fakePopulation([rig.cand(1, "HAULER", "GATE", rig.FROM, rig.NEXT)]),
        live: AGGRO_ON, scene: noSt.f });
      h2.tick(2);
      assert.deepStrictEqual([h2.traffic.status().aggro.counters.noStandings, noSt.calls.length], [2, 0]);
      const bare = rig.harness({ pop: rig.fakePopulation([]), live: AGGRO_ON });
      bare.tick(3);
      assert.deepStrictEqual([bare.traffic.status().aggro.counters.failed, bare.traffic.status().aggro.counters.passes],
        [1, 0]);

      const run = (withAggro) => {
        const s = withAggro ? aggroScene(threatsOf) : { f: rig.fakeScene(), calls: [] };
        const p = rig.fakePopulation([rig.cand(1, "HAULER", "GATE", rig.FROM, rig.NEXT),
          rig.cand(2, "UNDOCK", "GATE", 0, rig.NEXT)]);
        p.standings = standings;
        const hh = rig.harness({ pop: p, live: { ...DEFAULTS.population.live, trafficEnabled: true }, scene: s.f });
        hh.tick(12);
        const status = hh.traffic.status();
        return { calls: s.calls, status: JSON.stringify({ ...status, lastPass: null }), log: JSON.stringify(s.f.log),
          hasAggro: "aggro" in status };
      };
      const off = run(true);
      const before = run(false);
      assert.deepStrictEqual(off.calls, []);
      assert.deepStrictEqual([off.status, off.log, off.hasAggro], [before.status, before.log, false]);
      assert.deepStrictEqual([...AGGRO_SCENE_METHODS], [...seams.AGGRO_METHODS]);
    });

  test("SA5 config: 7 standingAggro keys (defaults, env), W265 both cases, compose lines", () => {
    const rows = SCHEMA.filter((r) => r.key.startsWith("population.live.standingAggro"));
    assert.deepStrictEqual(rows.map((r) => [r.key.slice("population.live.".length), r.default, r.env]), [
      ["standingAggroEnabled", false, "EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_ENABLED"],
      ["standingAggroRangeMeters", 100000, "EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_RANGE_METERS"],
      ["standingAggroMaxSystemsPerPass", 4, "EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_MAX_SYSTEMS_PER_PASS"],
      ["standingAggroMaxAttackers", 2, "EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_MAX_ATTACKERS"],
      ["standingAggroMaxCandidates", 32, "EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_MAX_CANDIDATES"],
      ["standingAggroHoldMs", 120000, "EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_HOLD_MS"],
      ["standingAggroCooldownMs", 60000, "EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_COOLDOWN_MS"]]);
    const env = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_ENABLED: "1",
      EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_MAX_ATTACKERS: "3", EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_HOLD_MS: "5" };
    const r = resolveConfig({ modDir: MOD_DIR, env });
    assert.deepStrictEqual([r.config.population.live.standingAggroEnabled, r.config.population.live.standingAggroMaxAttackers,
      r.config.population.live.standingAggroHoldMs], [true, 3, 10000]);
    const w265 = (w) => /standingAggroEnabled without .* \(W265\)/.test(w);
    assert.ok(r.warnings.some(w265), "no standings, no traffic");
    const noStandings = resolveConfig({ modDir: MOD_DIR, env: { ...env, EVEJS_LNE_POPULATION_LIVE_TRAFFIC_ENABLED: "1" } });
    assert.ok(noStandings.warnings.some(w265), "traffic without standings");
    const noTraffic = resolveConfig({ modDir: MOD_DIR, env: { ...env, EVEJS_LNE_POPULATION_STANDINGS_ENABLED: "1" } });
    assert.ok(noTraffic.warnings.some(w265), "standings without traffic");
    const both = resolveConfig({ modDir: MOD_DIR, env: { ...env, EVEJS_LNE_POPULATION_STANDINGS_ENABLED: "1",
      EVEJS_LNE_POPULATION_LIVE_TRAFFIC_ENABLED: "1" } });
    assert.ok(!both.warnings.some(w265), both.warnings.join(" | "));
    assert.ok(!resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).warnings.some(w265));

    const compose = fs.readFileSync(path.resolve(MOD_DIR, "..", "..", "compose.yaml"), "utf8");
    for (const row of rows) {
      const want = row.type === "boolean" ? `${row.env}: \${${row.env}:-0}` : `${row.env}: \${${row.env}:-}`;
      assert.ok(compose.includes(want), want);
    }
  });

  test("SA6 adapter: the armed ship of another pilot (entity lneTraffic, controller lne) is never an attacker", () => {
    const g = fakeGame();
    g.byId.set(9003, { itemID: 9003, kind: "ship", nativeNpc: true, position: { x: 1500, y: 0, z: 0 },
      operatorKind: "lneTraffic", factionId: HOSTILE_F });
    g.controllers.set(9003, { operatorKind: "lne", behaviorOverrides: { autoAggro: false, allowFriendlyNpcTargets: true },
      manualOrder: null });
    const seam = adapterSeam(g);
    const opts = { rangeMeters: 100000, maxCandidates: 32 };
    const read = seam.readThreats(SYS, [9001], opts);
    assert.deepStrictEqual(read.threats[0].attackers.map((a) => a.entityId), [7001], JSON.stringify(read));
    assert.deepStrictEqual(seam.readThreats(SYS, [9001], { ...opts, vendorRats: true }).threats[0].attackers
      .map((a) => a.entityId), [7001]);
    assert.deepStrictEqual(seam.readThreats(SYS, [9001, 9003], opts).threats.map((t) => [t.pilotShipId, t.armedKind,
      t.attackers.map((a) => a.entityId)]), [[9001, null, [7001]], [9003, "lne", [7001]]]);
  });
};

module.exports.rig = { fakeGame, adapterSeam, aggroScene, standings, att, readSource, functionBody, DEFAULTS, AGGRO_ON,
  SYS, HOSTILE_F, FRIENDLY_F, SERVER_SRC, MOD_DIR };
