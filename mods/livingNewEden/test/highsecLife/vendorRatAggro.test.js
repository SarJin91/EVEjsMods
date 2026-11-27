"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig, SCHEMA } = require("../../config");
const seams = require("../../lib/adapter/highsecTrafficScene");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { vendorRatSettingsOf, planAggro } = require("../../lib/highsecLife/traffic/aggro");
const { RAT_AGGRO_SCENE_METHODS } = require("../../lib/highsecLife/traffic/service");
const TP = require("./trafficPilots.test").rig;
const SA = require("./standingAggro.test").rig;
const { npcSetupTables } = require("../_support/setupTables");

const { SYS, HOSTILE_F, FRIENDLY_F, att } = SA;
const FLAG = "allowFriendlyNpcTargets";
const BELT = "asteroidBeltRat";

function ratGame() {
  const g = SA.fakeGame();
  const wakes = [];
  g.mods["space/npc/npcService"].wakeNpcController = (id, when) => {
    wakes.push([id, when]);
    return { success: true };
  };
  const rat = (itemID, x, kind, ctl, ent) => {
    g.byId.set(itemID, { itemID, kind: "ship", nativeNpc: true, position: { x, y: 0, z: 0 }, operatorKind: kind,
      factionId: HOSTILE_F, ...(ent || {}) });
    g.controllers.set(itemID, { operatorKind: kind, runtimeKind: "nativeCombat", manualOrder: null, currentTargetID: 0,
      behaviorOverrides: { autoAggro: true, autoAggroTargetClasses: ["player"] }, ...(ctl || {}) });
  };
  rat(8001, 3000, BELT, { preferredTargetID: 4242, lastAggressedAtMs: 0, behaviorProfile: { leashRangeMeters: 50000 },
    homePosition: { x: 10000, y: 0, z: 0 } });
  rat(8002, 6000, "gateRats");
  rat(8004, 2500, "gateConcord");
  rat(8005, 2600, BELT, {}, { capitalNpc: true });
  rat(8006, 2700, BELT, { currentTargetID: 77 });
  rat(8007, 2800, BELT, { manualOrder: { type: "orbit", targetID: 5 } });
  rat(8008, 2900, BELT, { behaviorProfile: { leashRangeMeters: 1000 }, homePosition: { x: 200000, y: 0, z: 0 } });
  rat(8009, 2000, BELT, { preferredTargetID: 0 });
  g.byId.set(9003, { itemID: 9003, kind: "ship", nativeNpc: true, position: { x: 1500, y: 0, z: 0 },
    operatorKind: "lneTraffic", factionId: HOSTILE_F });
  g.controllers.set(9003, { operatorKind: BELT, runtimeKind: "nativeCombat", manualOrder: null, currentTargetID: 0,
    behaviorOverrides: { [FLAG]: true } });
  return { ...g, wakes };
}

function ratScene(threatsOf, engaged) {
  const s = SA.aggroScene((id) => threatsOf(id));
  const read = s.f.scene.readThreats;
  s.f.scene.readThreats = (sys, ids, opts) => {
    const r = read(sys, ids, opts);
    if (opts.vendorRats === true) return r;
    return { ...r, threats: r.threats.map((t) => ({ ...t, attackers: t.attackers.filter((a) => a.vendor !== true) })) };
  };
  s.f.scene.armPilotRatTarget = (sys, id, ratIds, kind) => {
    s.calls.push(["ratArm", id, [...ratIds], kind]);
    return { ok: true, kind, ordered: ratIds.length, failed: [], borrowed: ratIds.map((entityId) => ({ entityId,
      overrides: { b: 1 }, order: null, preferredTargetID: 0, lastAggressedAtMs: 0, rat: true })) };
  };
  s.f.scene.releaseEngagedRats = (sys, id, borrowed) => {
    s.calls.push(["engaged", id, borrowed.map((b) => b.entityId)]);
    return engaged && engaged.has(id) ? { ok: true, released: borrowed.length, keep: [] }
      : { ok: true, released: 0, keep: borrowed };
  };
  return s;
}

const vr = (a) => ({ ...a, vendor: true });
const VR_ON = Object.freeze({ ...SA.AGGRO_ON, vendorRatAggroEnabled: true, vendorRatAggroMaxPerSystemWindow: 1,
  vendorRatAggroWindowMs: 60000 });

function boot(live, scene, n) {
  const cands = [];
  for (let i = 1; i <= n; i += 1) cands.push(TP.cand(i, "HAULER", "GATE", TP.FROM, TP.NEXT));
  const pop = TP.fakePopulation(cands);
  pop.standings = SA.standings;
  return TP.harness({ pop, live, scene: scene.f });
}

module.exports = ({ test, skip }) => {
  const setupTables = npcSetupTables();
  if (!setupTables.ok) skip("VR1 data part", setupTables.reason);
  test("VR1 vendor fact: overrides in RAM, resume -> null, preferredTargetID, transient rats, npc class only CONCORD",
    () => {
      const loop = SA.readSource("space/npc/npcBehaviorLoop.js");
      const setOv = SA.functionBody(loop, "setBehaviorOverrides");
      assert.ok(setOv.includes("controller.behaviorOverrides = normalizeBehaviorOverrides("));
      assert.ok(!/nativeNpcStore|database/.test(setOv), "setBehaviorOverrides writes RAM only");
      const norm = SA.functionBody(loop, "normalizeManualOrder");
      assert.match(norm, /normalizedType === "resume" \|\| normalizedType === "resumebehavior"\) \{\s*return null;/);
      const desired = SA.functionBody(loop, "resolveDesiredTarget");
      assert.match(desired, /if \(!manualTarget\) \{\s*controller\.manualOrder = null;/);
      assert.ok(SA.functionBody(loop, "issueManualOrder").includes("controller.preferredTargetID = manualTargetID"));
      const belt = SA.readSource("space/npc/beltRatRuntime.js");
      assert.ok(belt.includes("const OPERATOR_KIND = \"asteroidBeltRat\";") && belt.includes("transient: true,"));
      assert.match(SA.functionBody(SA.readSource("space/npc/npcService.js"), "shouldUseRuntimeOnlyNpcSpawn"),
        /return true;\s*\}\s*$/);
      assert.ok(SA.functionBody(SA.readSource("space/npc/nativeNpcService.js"), "dematerializeNativeController")
        .includes("?.transient !== false"));
      const gate = SA.readSource("space/npc/npcControlState.js");
      assert.match(gate, /operatorKind: GATE_OPERATOR_KIND\.RATS,[\s\S]{0,400}autoAggroTargetClasses: \[ENTITY_TYPE\.PLAYER\]/);
      assert.deepStrictEqual(liveProfiles.VENDOR_RAT_AGGRO_KINDS, [BELT, "gateRats"]);
      if (setupTables.ok) {
        const profiles = setupTables.tables.npcBehaviorProfiles.behaviorProfiles;
        const npcClass = profiles.filter((p) => Array.isArray(p.autoAggroTargetClasses)
          && p.autoAggroTargetClasses.includes("npc")).map((p) => String(p.behaviorProfileID));
        assert.ok(npcClass.length > 0 && npcClass.every((id) => /^(concord_|npc_concord_)/.test(id)), npcClass.join(","));
      }
    });

  test("VR2 adapter: rat arm / release to the snapshot, refusals without writes, readThreats vendorRats, engaged", () => {
    const g = ratGame();
    const seam = SA.adapterSeam(g);
    assert.deepStrictEqual(seams.RAT_AGGRO_METHODS.filter((m) => typeof seam[m] !== "function"), []);
    const opts = { rangeMeters: 100000, maxCandidates: 32 };
    const sub1 = SA.adapterSeam(SA.fakeGame()).readThreats(SYS, [9001], opts);
    assert.deepStrictEqual(seam.readThreats(SYS, [9001], opts), sub1);
    assert.deepStrictEqual(seam.readThreats(SYS, [9001], { ...opts, vendorRats: false }), sub1);
    const withRats = seam.readThreats(SYS, [9001], { ...opts, vendorRats: true });
    assert.deepStrictEqual(withRats.threats[0].attackers.map((a) => [a.entityId, a.kind, a.vendor === true]),
      [[8009, BELT, true], [8001, BELT, true], [7001, "lne", false], [8002, "gateRats", true]]);
    assert.ok(!("vendor" in withRats.threats[0].attackers[2]), "an LNE attacker has no vendor key");
    assert.strictEqual(seam.readThreats(SYS, [9001], { ...opts, vendorRats: 1 }).reason, "INVALID_INPUT");

    for (const id of [7003, 8004, 8005, 8006, 8007, 9003]) {
      assert.deepStrictEqual(seam.armPilotRatTarget(SYS, 9001, [id], BELT), { ok: false, reason: "RAT_NOT_IDLE",
        detail: String(id) }, String(id));
    }
    assert.strictEqual(seam.armPilotRatTarget(SYS, 9001, [8004], "gateConcord").reason, "INVALID_INPUT");
    assert.strictEqual(seam.armPilotRatTarget(SYS, 9002, [8001], BELT).reason, "NOT_PILOT");
    assert.deepStrictEqual([g.writes, g.orders, g.wakes], [[], [], []], "no write before the checks pass");

    const rat = g.controllers.get(8001);
    const ratBefore = JSON.parse(JSON.stringify(rat.behaviorOverrides));
    const armed = seam.armPilotRatTarget(SYS, 9001, [8001], BELT);
    assert.deepStrictEqual(armed, { ok: true, kind: BELT, ordered: 1, failed: [], borrowed: [{ entityId: 8001,
      overrides: ratBefore, order: null, preferredTargetID: 4242, lastAggressedAtMs: 0, rat: true }] });
    const pilot = g.controllers.get(9001);
    assert.deepStrictEqual([pilot.operatorKind, pilot.behaviorOverrides[FLAG], g.byId.get(9001).operatorKind,
      g.records.get(9001).operatorKind], [BELT, true, "lneTraffic", "lneTraffic"]);
    assert.deepStrictEqual([rat.operatorKind, rat.behaviorOverrides, rat.manualOrder.type, rat.manualOrder.targetID,
      rat.preferredTargetID], [BELT, { ...ratBefore, [FLAG]: true }, "attack", 9001, 9001]);
    assert.deepStrictEqual([g.orders, g.wakes], [[[8001, "attack", 9001]], [[8001, 0]]]);

    g.orders.length = 0;
    assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9001, armed.borrowed),
      { ok: true, restored: true, released: 1, kept: 0, releaseFailed: 0 });
    assert.deepStrictEqual([rat.behaviorOverrides, rat.manualOrder, rat.preferredTargetID, rat.currentTargetID],
      [ratBefore, null, 4242, 0]);
    assert.deepStrictEqual(g.orders, [[8001, "stop", undefined], [8001, "resume", undefined]]);
    assert.deepStrictEqual([pilot.operatorKind, FLAG in pilot.behaviorOverrides], ["lneTraffic", false]);

    const two = seam.armPilotRatTarget(SYS, 9001, [8001, 8009], BELT);
    assert.deepStrictEqual([two.ok, two.ordered], [true, 2]);
    rat.lastAggressedAtMs = 123;
    rat.preferredTargetID = 5555;
    const e1 = seam.releaseEngagedRats(SYS, 9001, two.borrowed);
    assert.deepStrictEqual([e1.ok, e1.released, e1.keep.length, e1.keep[0] === two.borrowed[1]], [true, 1, 1, true]);
    assert.deepStrictEqual([rat.behaviorOverrides, rat.manualOrder, rat.preferredTargetID], [ratBefore, null, 5555]);
    g.controllers.delete(8009);
    assert.deepStrictEqual(seam.releaseEngagedRats(SYS, 9001, e1.keep), { ok: true, released: 0, keep: [] });

    const goneGame = ratGame();
    const goneSeam = SA.adapterSeam(goneGame);
    const goneRat = goneGame.controllers.get(8001);
    const goneBefore = JSON.parse(JSON.stringify(goneRat.behaviorOverrides));
    const goneArmed = goneSeam.armPilotRatTarget(SYS, 9001, [8001], BELT);
    assert.strictEqual(goneArmed.ok, true, JSON.stringify(goneArmed));
    goneGame.byId.delete(9001);
    goneGame.controllers.delete(9001);
    goneRat.manualOrder = null;
    goneGame.orders.length = 0;
    assert.deepStrictEqual(goneSeam.disarmPilotTarget(SYS, 9001, goneArmed.borrowed),
      { ok: true, restored: false, released: 1, kept: 0, releaseFailed: 0 });
    assert.deepStrictEqual([goneRat.behaviorOverrides, goneRat.manualOrder, goneRat.preferredTargetID],
      [goneBefore, null, 4242]);
    assert.deepStrictEqual(goneGame.orders, [[8001, "resume", undefined]], "no stop: the order is no longer on the pilot");

    pilot.operatorKind = "lneTraffic";
    pilot.behaviorOverrides = { autoAggro: false, [FLAG]: true };
    assert.deepStrictEqual(seam.disarmPilotTarget(SYS, 9001), { ok: true, restored: true });
    assert.deepStrictEqual(pilot.behaviorOverrides, { autoAggro: false });
  });

  test("VR3 planner: vendorOrdersLeft absent =, 0 drops the rats, 1 = one vendor order, no mixed group", () => {
    const st = SA.standings();
    const input = (over) => ({ threats: [
      { pilotShipId: 1, attackers: [vr(att(21, BELT, HOSTILE_F, 100)), att(11, "lne", HOSTILE_F, 300),
        vr(att(22, BELT, HOSTILE_F, 200))] },
      { pilotShipId: 2, attackers: [vr(att(23, "gateRats", HOSTILE_F, 50)), att(12, "lne", HOSTILE_F, 900)] },
      { pilotShipId: 3, attackers: [vr(att(24, BELT, FRIENDLY_F, 10))] }],
    pilotOf: (id) => id + 100, relationOf: (p, f) => st.relationOf(st.profileOf(p), f), armed: new Map(),
    cooldownUntil: new Map(), now: 1000, maxAttackers: 2, ...over });
    assert.deepStrictEqual(planAggro(input()), { orders: [{ pilotShipId: 1, kind: BELT, attackerIds: [21, 22] },
      { pilotShipId: 2, kind: "gateRats", attackerIds: [23] }], friendlySkipped: 1, hostileSeen: 5 });
    assert.deepStrictEqual(planAggro(input({ vendorOrdersLeft: 0 })), { orders: [
      { pilotShipId: 1, kind: "lne", attackerIds: [11] }, { pilotShipId: 2, kind: "lne", attackerIds: [12] }],
    friendlySkipped: 1, hostileSeen: 5, vendorQuotaSkipped: 2 });
    assert.deepStrictEqual(planAggro(input({ vendorOrdersLeft: 1 })), { orders: [
      { pilotShipId: 1, kind: BELT, attackerIds: [21, 22], vendor: true },
      { pilotShipId: 2, kind: "lne", attackerIds: [12] }], friendlySkipped: 1, hostileSeen: 5, vendorQuotaSkipped: 1 });
    assert.strictEqual(vendorRatSettingsOf(SA.DEFAULTS.population.live), null);
    assert.strictEqual(vendorRatSettingsOf({ ...VR_ON, standingAggroEnabled: false }), null);
    assert.deepStrictEqual(vendorRatSettingsOf(VR_ON), { maxPerSystemWindow: 1, windowMs: 60000 });
  });

  test("VR4 traffic: window per system, borrowed excluded, engaged early release, disarm paths; flag off =", () => {
    const ratOf = (id) => [vr(att(id + 1000, BELT, HOSTILE_F, 3000))];
    const a = ratScene(ratOf);
    const h = boot({ ...VR_ON, vendorRatAggroWindowMs: 20000 }, a, 2);
    const t0 = h.clock.t;
    const ratArms = () => a.calls.filter((c) => c[0] === "ratArm");
    const armAt = [];
    let most = 0;
    for (let i = 0; i < 6; i += 1) {
      const t = h.clock.t;
      const before = ratArms().length;
      h.tick();
      most = Math.max(most, a.f.alive.size);
      if (ratArms().length > before) armAt.push(t - t0);
    }
    assert.strictEqual(most, 2, "two pilot ships in one system");
    assert.deepStrictEqual(armAt, [0, 20000], "one rat attack per system in the window");
    const first = ratArms()[0];
    assert.deepStrictEqual(first, ["ratArm", first[1], [first[1] + 1000], BELT]);
    const read0 = a.calls.find((c) => c[0] === "read")[3];
    assert.deepStrictEqual([read0.vendorRats, typeof read0.excludeOf], [true, "function"]);
    let vrs = h.traffic.status().aggro.vendorRats;
    assert.deepStrictEqual([vrs.windowSystems, vrs.counters.orders, vrs.counters.ratsOrdered, vrs.counters.quotaSkipped > 0],
      [1, 2, 2, true]);
    const disarms = a.calls.filter((c) => c[0] === "disarm");
    assert.deepStrictEqual(disarms[0].slice(1, 2).concat([disarms[0][2].map((x) => x.rat)]), [first[1], [true]]);
    h.traffic.stop();
    assert.deepStrictEqual(a.calls.filter((c) => c[0] === "disarm").slice(-1)[0][2].map((x) => x.rat), [true]);

    const b = ratScene(() => [vr(att(8001, BELT, HOSTILE_F, 3000))]);
    const hb = boot({ ...VR_ON, vendorRatAggroMaxPerSystemWindow: 2, standingAggroHoldMs: 120000 }, b, 2);
    for (let i = 0; i < 10 && b.f.alive.size < 2; i += 1) hb.tick();
    hb.tick();
    vrs = hb.traffic.status().aggro.vendorRats;
    assert.deepStrictEqual([vrs.counters.orders, vrs.counters.borrowedSkipped,
      hb.traffic.status().aggro.counters.liveBattleSkipped], [1, 1, 0]);
    const armedShip = b.calls.find((c) => c[0] === "ratArm")[1];
    b.f.alive.delete(armedShip);
    hb.tick();
    assert.deepStrictEqual(b.calls.filter((c) => c[0] === "disarm").map((c) => [c[1], c[2].length]), [[armedShip, 1]]);

    const c = ratScene(ratOf, new Set());
    const hc = boot(VR_ON, c, 1);
    hc.tick();
    const ship = [...c.f.alive.keys()][0];
    c.f.scene.releaseEngagedRats = (sys, id, borrowed) => ({ ok: true, released: borrowed.length, keep: [] });
    hc.tick();
    const ag = hc.traffic.status().aggro;
    assert.deepStrictEqual([ag.armed, ag.counters.disarmed, ag.vendorRats.counters.engagedReleased], [0, 1, 1]);
    assert.deepStrictEqual(c.calls.filter((x) => x[0] === "disarm"), [["disarm", ship, []]]);

    const mix = (id) => [att(7001, "lne", HOSTILE_F, 5000), vr(att(id + 1000, BELT, HOSTILE_F, 3000))];
    const run = (withRats) => {
      const s = withRats ? ratScene(mix) : SA.aggroScene((id) => mix(id).filter((x) => !x.vendor));
      const hh = boot({ ...SA.AGGRO_ON, vendorRatAggroEnabled: false, vendorRatAggroMaxPerSystemWindow: 1,
        vendorRatAggroWindowMs: 60000 }, s, 2);
      hh.tick(12);
      const status = hh.traffic.status();
      return { calls: JSON.stringify(s.calls), status: JSON.stringify({ ...status, lastPass: null }),
        rat: s.calls.filter((x) => x[0] === "ratArm" || x[0] === "engaged").length,
        arms: s.calls.filter((x) => x[0] === "arm").length };
    };
    const off = run(true);
    const sub1 = run(false);
    assert.ok(sub1.arms > 0, "the LNE attacker is armed in both runs");
    assert.deepStrictEqual([off.rat, off.calls, off.status], [0, sub1.calls, sub1.status]);
    assert.ok(!off.status.includes("vendorRats"));
    const o = ratScene(ratOf);
    boot({ ...SA.AGGRO_ON, vendorRatAggroEnabled: false }, o, 1).tick();
    assert.deepStrictEqual(o.calls[0][3], { rangeMeters: 100000, maxCandidates: 32 }, "read opts of");
    assert.deepStrictEqual([...RAT_AGGRO_SCENE_METHODS], [...seams.RAT_AGGRO_METHODS]);
  });

  test("VR5 config: 3 vendorRatAggro keys (defaults, env, clamp), W266 both cases, compose lines", () => {
    const rows = SCHEMA.filter((r) => r.key.startsWith("population.live.vendorRatAggro"));
    assert.deepStrictEqual(rows.map((r) => [r.key.slice("population.live.".length), r.default, r.env]), [
      ["vendorRatAggroEnabled", false, "EVEJS_LNE_POPULATION_LIVE_VENDOR_RAT_AGGRO_ENABLED"],
      ["vendorRatAggroMaxPerSystemWindow", 1, "EVEJS_LNE_POPULATION_LIVE_VENDOR_RAT_AGGRO_MAX_PER_SYSTEM_WINDOW"],
      ["vendorRatAggroWindowMs", 3600000, "EVEJS_LNE_POPULATION_LIVE_VENDOR_RAT_AGGRO_WINDOW_MS"]]);
    const env = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_POPULATION_LIVE_VENDOR_RAT_AGGRO_ENABLED: "1",
      EVEJS_LNE_POPULATION_LIVE_VENDOR_RAT_AGGRO_MAX_PER_SYSTEM_WINDOW: "99",
      EVEJS_LNE_POPULATION_LIVE_VENDOR_RAT_AGGRO_WINDOW_MS: "5" };
    const r = resolveConfig({ modDir: SA.MOD_DIR, env });
    const live = r.config.population.live;
    assert.deepStrictEqual([live.vendorRatAggroEnabled, live.vendorRatAggroMaxPerSystemWindow,
      live.vendorRatAggroWindowMs], [true, 16, 60000]);
    const w266 = (w) => /vendorRatAggroEnabled without .* \(W266\)/.test(w);
    assert.ok(r.warnings.some(w266), "no standing aggro");
    const both = resolveConfig({ modDir: SA.MOD_DIR,
      env: { ...env, EVEJS_LNE_POPULATION_LIVE_STANDING_AGGRO_ENABLED: "1" } });
    assert.ok(!both.warnings.some(w266), both.warnings.join(" | "));
    assert.ok(!resolveConfig({ modDir: SA.MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).warnings.some(w266));
    const compose = fs.readFileSync(path.resolve(SA.MOD_DIR, "..", "..", "compose.yaml"), "utf8");
    for (const row of rows) {
      const want = row.type === "boolean" ? `${row.env}: \${${row.env}:-0}` : `${row.env}: \${${row.env}:-}`;
      assert.ok(compose.includes(want), want);
    }
    const rootEnv = fs.readFileSync(path.resolve(SA.MOD_DIR, "..", "..", ".env.example"), "utf8");
    for (const row of rows) assert.ok(rootEnv.includes(`# ${row.env}=`), `root .env.example ${row.env}`);
  });
};
