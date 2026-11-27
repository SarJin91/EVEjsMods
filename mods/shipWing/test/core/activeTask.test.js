"use strict";

const assert = require("node:assert");
const { decide } = require("../../lib/core/capBalance");
const { createWingTasks, COUNTER_NAMES: TASK_COUNTER_NAMES } = require("../../lib/core/wingTasks");
const { createActiveSidecar, SIDECAR_COUNTER_NAMES, LOGI_COUNTER_NAMES, PROP_COUNTER_NAMES } =
  require("../../lib/core/activeTask");
const { LOGI_ACCESS_COUNTER_NAMES } = require("../../lib/adapter/logiAccess");
const { PROP_ACCESS_COUNTER_NAMES } = require("../../lib/adapter/propAccess");
const { createActiveAccess, ACCESS_COUNTER_NAMES } = require("../../lib/adapter/activeAccess");
const { ENGINE_COUNTER_NAMES } = require("../../lib/core/combatTask");
const { COMBAT_COUNTER_NAMES } = require("../../lib/adapter/combatAccess");
const { COUNTER_NAMES: CORE_COUNTER_NAMES } = require("../../lib/core/wingService");
const { fakes } = require("../adapter/activeAccess.test");
const { formatStatus } = require("../../lib/channels/chat");

const TWIN = 4200000000000001;
const TWIN2 = 4200000000000002;

function m(id, kind, drainGJs) {
  return { id, kind, capNeed: drainGJs * 10, durationMs: 10000 };
}

module.exports = ({ test }) => {
  test("AT1 capBalance: C=5000 GJ, T=500000 ms -> peak 25 GJ/s; stable -> all kept; shed: prop -> localRep -> remote "
    + "-> alwaysOn (largest first) until stable, weapons never; disable -> none; refuse -> refused; "
    + "includeWeapons=false changes the result of a laser fit", () => {
    const base = { capacityGJ: 5000, rechargeMs: 500000, stableFactorPct: 100, includeWeapons: true };
    const stable = decide({ ...base, policy: "shed", modules: [m(1, "alwaysOn", 5), m(9, "weapon", 10)] });
    assert.deepStrictEqual([stable.peakGJs, stable.cap, [...stable.kept], stable.shed, stable.refused],
      [25, "stable", [1], [], false]);
    const fit = [m(1, "prop", 10), m(2, "localRep", 8), m(3, "remote", 6), m(4, "alwaysOn", 4), m(5, "alwaysOn", 3),
      m(9, "weapon", 20)];
    const shed = decide({ ...base, policy: "shed", modules: fit });
    assert.deepStrictEqual([shed.drainGJs, shed.cap, shed.shed, [...shed.kept]], [51, "shed", [1, 2, 3, 4], [5]]);
    const disable = decide({ ...base, policy: "disable", modules: fit });
    assert.deepStrictEqual([disable.cap, disable.kept.size, disable.shed], ["disabled", 0, [1, 2, 3, 4, 5]]);
    const refuse = decide({ ...base, policy: "refuse", modules: fit });
    assert.deepStrictEqual([refuse.cap, refuse.refused, refuse.kept.size], ["refused", true, 0]);
    const lasers = [m(1, "alwaysOn", 2), m(9, "weapon", 30)];
    assert.strictEqual(decide({ ...base, policy: "shed", modules: lasers }).cap, "disabled");
    assert.deepStrictEqual([...decide({ ...base, policy: "shed", modules: lasers, includeWeapons: false }).kept], [1]);
    const noWeapons = decide({ ...base, policy: "shed", modules: fit, includeWeapons: false });
    assert.deepStrictEqual([noWeapons.drainGJs, noWeapons.shed], [31, [1]]);
  });

  test("AT5 (BUG nos-rr) capBalance: default = AT1; incomeGJs raises the limit; remoteLast "
    + "sheds a hardener before RR; a module with no drain is never shed; status text `nos +12.0 GJ/s`", () => {
    const base = { capacityGJ: 5000, rechargeMs: 500000, stableFactorPct: 100, includeWeapons: true, policy: "shed" };
    const fit = [m(1, "prop", 10), m(2, "localRep", 8), m(3, "remote", 6), m(4, "alwaysOn", 4), m(5, "alwaysOn", 3),
      m(9, "weapon", 20)];
    const def = decide({ ...base, modules: fit });
    assert.deepStrictEqual([def.drainGJs, def.cap, def.shed, [...def.kept], def.incomeGJs], [51, "shed", [1, 2, 3, 4],
      [5], 0]);
    for (const bad of [-5, Number.NaN, "x"]) {
      assert.deepStrictEqual(decide({ ...base, modules: fit, incomeGJs: bad }).shed, [1, 2, 3, 4], String(bad));
    }
    const fed = decide({ ...base, modules: fit, incomeGJs: 26 });
    assert.deepStrictEqual([fed.cap, fed.shed, [...fed.kept], fed.incomeGJs], ["stable", [], [1, 2, 3, 4, 5], 26]);
    const logi = [m(1, "remote", 10), m(2, "alwaysOn", 10), m(3, "alwaysOn", 10)];
    const last = decide({ ...base, modules: logi, remoteLast: true });
    assert.deepStrictEqual([last.cap, last.shed, [...last.kept]], ["shed", [2], [1, 3]]);
    assert.deepStrictEqual(decide({ ...base, modules: logi }).shed, [1]);
    const nos = decide({ ...base, modules: [m(1, "ewar", 0), m(2, "remote", 30), m(3, "alwaysOn", 5)] });
    assert.deepStrictEqual([nos.cap, nos.shed, [...nos.kept].sort()], ["shed", [2], [1, 3]]);
    const line = (active) => formatStatus({ deployedCount: 1, limit: 2, refusal: null, ships: [{ shipItemId: 501,
      typeId: 626, name: "Vexor", state: "ACTIVE", eligible: true, refusal: null, entityId: null, distanceM: null,
      targetId: null, active }] });
    assert.strictEqual(line({ cap: "stable", nosCreditGJs: 12 }), "Ship Wing 1/2 out: Vexor [out, cap stable, "
      + "nos +12.0 GJ/s]");
    assert.strictEqual(line({ cap: "stable" }), "Ship Wing 1/2 out: Vexor [out, cap stable]");
  });

  test("AT2 sidecar in wingTasks: step after the engine for FOLLOW, HOLD, MINE and ATTACK; none after suspend; dispose "
    + "at drop(LOST), drop(RECALL_DONE), dropAll(RESTART); a sidecar throw = task.error, the engine goes on; "
    + "rt.launch.active after start; counter names disjoint", () => {
    const log = [];
    const engine = (name) => ({ name, canRun: () => ({ ok: true }), start() {}, stop() {},
      step: (rt) => { log.push(`${name}:${rt.task}`); return { controlsMovement: false }; } });
    let fail = false;
    const sidecar = { name: "active",
      step: (rt, ctx) => {
        log.push(`side:${rt.task}:${ctx.record.shipItemId}`);
        if (fail) throw new Error("boom");
      },
      dispose: (rt, reason, c) => log.push(`dispose:${reason}:${c && c.shipItemId}`),
      stats: () => ({ counters: { "active.localRep.cycle": 7 } }) };
    const tasks = createWingTasks({ engines: { mine: engine("mine"), attack: engine("attack") }, sidecars: [sidecar] });
    const rec = (id) => ({ shipItemId: id, ownerCharacterId: 1 });
    const plan = { localRep: [], summary: { cap: "stable" } };
    const map = new Map([[1, 2]]);
    tasks.start(rec(501), { syntheticToReal: map, active: plan });
    assert.strictEqual(tasks.context(501).launch.active, plan, "emptyLaunch carries `active`");
    assert.strictEqual(tasks.context(501).launch.syntheticToReal, map);
    assert.deepStrictEqual(tasks.activeOf(501), { cap: "stable" });
    const ctx = { nowMs: 1, twin: {}, scene: {} };
    tasks.step(rec(501), null, ctx);
    for (const verb of ["hold", "mine", "attack"]) {
      assert.strictEqual(tasks.order(rec(501), null, verb, { targetId: 9 }).ok, true, verb);
      tasks.step(rec(501), null, ctx);
    }
    assert.deepStrictEqual(log, ["side:FOLLOW:501", "side:HOLD:501", "mine:MINE", "side:MINE:501", "attack:ATTACK",
      "side:ATTACK:501"]);
    log.length = 0;
    fail = true;
    tasks.step(rec(501), null, ctx);
    tasks.step(rec(501), null, ctx);
    assert.deepStrictEqual(log, ["attack:ATTACK", "side:ATTACK:501", "attack:ATTACK", "side:ATTACK:501"]);
    assert.strictEqual(tasks.stats().counters["task.error"], 2);
    assert.strictEqual(tasks.stats().counters["active.localRep.cycle"], 7, "sidecar counters in stats");
    fail = false;
    log.length = 0;
    tasks.suspend(501, "RETURN", {});
    tasks.step(rec(501), null, ctx);
    assert.deepStrictEqual(log, [], "no step after suspend");
    tasks.drop(501, "RECALL_DONE");
    tasks.start(rec(502));
    assert.strictEqual(tasks.context(502).launch.active, null);
    tasks.drop(502, "LOST");
    tasks.start(rec(503));
    tasks.start(rec(504));
    tasks.dropAll("RESTART");
    assert.deepStrictEqual(log, ["dispose:RECALL_DONE:501", "dispose:LOST:502", "dispose:RESTART:503",
      "dispose:RESTART:504"]);

    const families = [SIDECAR_COUNTER_NAMES, ACCESS_COUNTER_NAMES, ENGINE_COUNTER_NAMES, COMBAT_COUNTER_NAMES,
      TASK_COUNTER_NAMES, CORE_COUNTER_NAMES, LOGI_COUNTER_NAMES, LOGI_ACCESS_COUNTER_NAMES,
      PROP_COUNTER_NAMES, PROP_ACCESS_COUNTER_NAMES];
    const all = families.flat();
    assert.strictEqual(new Set(all).size, all.length, "counter names repeat across families");
    assert.ok([...SIDECAR_COUNTER_NAMES, ...ACCESS_COUNTER_NAMES].every((n) => n.startsWith("active.")));
    assert.ok([...LOGI_COUNTER_NAMES, ...LOGI_ACCESS_COUNTER_NAMES].every((n) => n.startsWith("logi.")));
    assert.ok([...PROP_COUNTER_NAMES, ...PROP_ACCESS_COUNTER_NAMES].every((n) => n.startsWith("prop.")));
  });

  test("AT3 local repair (fake scene time): armor < start -> cycles every durationMs, timing end applies at the end, "
    + "start (shield) at the start; stop at activeLocalRepStopPct; no capacitor call; activeMaxCyclesPerTick + "
    + "active.cycles.deferred; a drop (beginLoss) between cycles -> no more cycles", () => {
    const { fakeVendor, config, EFFECT, OWNER } = fakes;
    const v = fakeVendor();
    const cfg = config({ activeMaxCyclesPerTick: 1 });
    const access = createActiveAccess({ deps: v.deps, config: cfg });
    let sim = 10000;
    const tasks = createWingTasks({ sidecars: [createActiveSidecar({ access, scene: { simNow: () => sim },
      config: cfg })] });
    const twin = { itemID: TWIN, kind: "ship", typeID: 24690, conditionState: { armorDamage: 0.5, shieldCharge: 1 },
      fittedItems: [{ itemID: 13, typeID: 3540, flagID: 13 }] };
    const shieldTwin = { itemID: TWIN2, kind: "ship", typeID: 24690, conditionState: { shieldCharge: 0.5 },
      fittedItems: [{ itemID: 14, typeID: 10836, flagID: 14 }] };
    const entities = new Map([[TWIN, twin], [TWIN2, shieldTwin]]);
    const scene = { getEntityByID: (id) => entities.get(id) || null, broadcastSpecialFx: () => { v.fx += 1; } };
    const rec = (id) => ({ shipItemId: id, ownerCharacterId: OWNER });
    const rep = (moduleId, typeId, effect, layer) => ({ localRep: [{ moduleId, flagId: moduleId, typeId,
      effectRecord: EFFECT[effect], layer }], summary: {} });
    tasks.start(rec(501), { active: rep(13, 3540, "armorRep", "armor") });
    tasks.start(rec(502), { active: rep(14, 10836, "shieldBoost", "shield") });
    let nowMs = 0;
    const tick = () => {
      nowMs += 1;
      tasks.step(rec(501), null, { twin, scene, nowMs, host: null });
      tasks.step(rec(502), null, { twin: shieldTwin, scene, nowMs, host: null });
    };
    tick();
    assert.deepStrictEqual([v.prepare.length, v.execute.length, twin.conditionState.armorDamage], [1, 0, 0.5]);
    assert.deepStrictEqual(tasks.activeOf(501), { propOn: false, localRepOn: true });
    assert.deepStrictEqual([v.prepare[0].characterID, v.prepare[0].chargeItem, v.prepare[0].fitted],
      [OWNER, null, twin.fittedItems]);
    let c = tasks.stats().counters;
    assert.deepStrictEqual([c["active.localRep.cycle"], c["active.cycles.deferred"]], [1, 1]);
    tick();
    assert.deepStrictEqual(v.execute.map((e) => [e.activation, e.effectName, e.session]),
      [[true, "shieldBoosting", null]]);
    assert.strictEqual(shieldTwin.conditionState.shieldCharge, 0.65);
    sim += 2000;
    tick();
    assert.strictEqual(twin.conditionState.armorDamage, 0.5);
    sim += 2000;
    tick();
    assert.deepStrictEqual(v.execute[1], { activation: false, nowMs: 14000, session: null,
      effectName: "armorRepair" });
    assert.strictEqual(twin.conditionState.armorDamage, 0.35);
    for (let i = 0; i < 6; i += 1) {
      sim += 4000;
      tick();
    }
    assert.strictEqual(twin.conditionState.armorDamage, 0.05);
    c = tasks.stats().counters;
    assert.ok(c["active.localRep.stop.FULL"] >= 2, JSON.stringify(c));
    const prepared = v.prepare.length;
    sim += 4000;
    tick();
    assert.strictEqual(v.prepare.length, prepared, "no cycle above the start level");
    twin.conditionState.armorDamage = 0.5;
    sim += 4000;
    tick();
    assert.strictEqual(v.prepare.length, prepared + 1);
    tasks.drop(501, "LOST");
    sim += 8000;
    tick();
    assert.strictEqual(v.prepare.length, prepared + 1, "no cycle after the drop");
    assert.deepStrictEqual([v.capRatio, v.capConsume], [0, 0], "variant A: no capacitor change, no consume");
    assert.ok(v.broadcastDamage >= 4 && v.fx >= 4, `${v.broadcastDamage} ${v.fx}`);
    assert.strictEqual(tasks.stats().counters["active.localRep.stop.DISPOSED"], 1);
  });

  test("AT4 view: no rt.active -> null; propOn / localRepOn from the state; `repairing` only with remote "
    + "modules", () => {
    const side = createActiveSidecar({ access: {}, scene: { simNow: () => 0 }, config: {} });
    const local = (cycling) => ({ cycling, entry: { targetId: null } });
    assert.deepStrictEqual([side.view({ active: null }), side.view(null)], [null, null]);
    assert.deepStrictEqual(side.view({ active: { localRep: [local(false), local(true)], remote: [],
      prop: { on: true } } }), { propOn: true, localRepOn: true });
    assert.deepStrictEqual(side.view({ active: { localRep: [local(false)], remote: [], prop: null } }),
      { propOn: false, localRepOn: false });
    const rr = { entry: { targetId: 77 }, targetKind: "host" };
    assert.deepStrictEqual(side.view({ active: { localRep: [], remote: [rr], prop: { on: false } } }),
      { propOn: false, localRepOn: false, repairing: "host" });
  });
};
