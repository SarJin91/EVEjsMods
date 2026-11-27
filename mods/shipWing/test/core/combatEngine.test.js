"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createAttackEngine, ENGINE_COUNTER_NAMES, ammoReceiptKey } = require("../../lib/core/combatTask");
const { createWingTasks } = require("../../lib/core/wingTasks");
const { isAllowedTarget } = require("../../lib/core/targetPolicy");
const { COMBAT_COUNTER_NAMES } = require("../../lib/adapter/combatAccess");
const { createChatChannel, MISSING_TEXT } = require("../../lib/channels/chat");
const { resolveConfig } = require("../../config");
const { fixtures } = require("./wingService.test");

const MOD_DIR = path.join(__dirname, "..", "..");
const OWNER = 90000001;
const OTHER = 90000002;
const HOST = 1000000400;
const RAT = 9000001;
const RAT2 = 9000002;
const DURATION = 1500;

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config, combatEnabled: true,
    ...extra };
}

function rat(itemID = RAT, extra = {}) {
  return { itemID, kind: "ship", nativeNpc: true, npcEntityType: "npc", distToHost: 5000, distToTwin: 4000,
    ...extra };
}

function turrets(n, chargeBase = 7000, quantity = 100) {
  return Array.from({ length: n }, (_, i) => ({ moduleId: 100 + i, flagId: 27 + i, family: "hybridTurret",
    needsAmmo: true, chargeItemId: chargeBase + i, chargeQuantity: quantity }));
}

function fakeWorld(opts = {}) {
  const w = { sim: 10000, fired: [], orders: [], consumed: [], emits: [], locks: new Map(), threats: new Map(),
    lockRefuse: null, consumeFail: null, chargeMode: "stack", killOn: null, onFire: null, noWeapons: false,
    receipts: new Map(), weapons: opts.weapons || (() => turrets(1)) };
  w.config = config(opts.config);
  w.host = { itemID: HOST, activeModuleEffects: new Map() };
  w.scene = { entities: new Map([[HOST, w.host]]) };
  const dist = (a, b) => {
    if (!a || !b) return Infinity;
    if (a.itemID === HOST) return Number(b.distToHost);
    return Number(b.distToTwin);
  };
  w.ts = {
    simNow: () => w.sim,
    entity: (scene, id) => (scene && scene.entities.get(Number(id))) || null,
    surfaceDistance: (_s, a, b) => dist(a, b),
    targetsOf: (_s, e) => [...(w.locks.get(e && e.itemID) || [])],
    lock(_s, twin, target) {
      w.orders.push(["lock", twin.itemID, target.itemID]);
      if (w.lockRefuse) return { ok: false, reason: w.lockRefuse };
      w.locks.set(twin.itemID, new Set([target.itemID]));
      return { ok: true };
    },
    approach(_s, twin, id, d) {
      w.orders.push(["approach", twin.itemID, id, d]);
      return true;
    },
    stop(_s, twin) {
      w.orders.push(["stop", twin.itemID]);
      return true;
    },
  };
  w.access = {
    listWeapons: (twin) => (w.noWeapons ? [] : w.weapons(twin)),
    checkTarget: (scene, twin, host, target) => isAllowedTarget(target, { twin, host, config: w.config,
      sameScene: Boolean(target && scene && scene.entities.get(target.itemID) === target),
      hostDistanceM: target ? dist(host, target) : Infinity, destroying: Boolean(target && target.destroying),
      allowStructures: true, damageable: Boolean(target) && target.damageable !== false }),
    hostWeaponTargets: (host) => [...((host && host.activeModuleEffects) || new Map()).values()]
      .filter((s) => s.weaponFamily).map((s) => s.targetID).sort((a, b) => a - b),
    threatsOf: (_s, e) => w.threats.get(e && e.itemID) || [],
    weaponRange: () => ({ ok: true, optimalM: 5000, falloffM: 2000 }),
    isGone: (scene, e) => !e || scene.entities.get(e.itemID) !== e || e.destroying === true,
    fireVolley(scene, twin, weapon, target, simMs) {
      w.fired.push([twin.itemID, weapon.moduleId, target.itemID, simMs]);
      if (w.onFire) w.onFire(twin, weapon);
      const destroyed = w.killOn !== null && w.fired.length >= w.killOn;
      if (destroyed) scene.entities.delete(target.itemID);
      return { ok: true, durationMs: DURATION, data: { hit: true, applied: 10, destroyed,
        chargeItemId: weapon.chargeItemId, chargeMode: w.chargeMode } };
    },
    consumeAmmo(realId, quantity, options) {
      w.consumed.push([realId, quantity, options]);
      if (w.consumeFail) return { ok: false, reason: w.consumeFail };
      const prior = w.receipts.get(options.receiptKey);
      if (prior) {
        return JSON.stringify(prior) === JSON.stringify(options.fingerprint)
          ? { ok: true, duplicate: true, changes: [] } : { ok: false, reason: "IDEMPOTENCY_RECEIPT_MISMATCH" };
      }
      w.receipts.set(options.receiptKey, options.fingerprint);
      return { ok: true, duplicate: false, changes: [{ item: { itemID: realId } }] };
    },
  };
  w.isTwin = () => true;
  w.engine = createAttackEngine({ access: w.access, scene: w.ts, config: w.config, isTwin: (t) => w.isTwin(t),
    emit: (owner, changes) => w.emits.push([owner, changes.length]),
    droneWeapons: opts.droneWeapons });
  w.tasks = createWingTasks({ engines: { attack: w.engine }, config: w.config });
  w.add = (e) => {
    w.scene.entities.set(e.itemID, e);
    return e;
  };
  return w;
}

function twinEntity(itemID) {
  return { itemID, kind: "ship", pilotCharacterID: OWNER, characterID: 0, mode: "STOP", targetEntityID: 0 };
}

function record(shipItemId, twin) {
  return { shipItemId, ownerCharacterId: OWNER, hostShipId: HOST, twinEntityId: twin.itemID, state: "ACTIVE",
    launchedAtMs: 1234 };
}

function deploy(w, shipItemId, twin, opts = {}) {
  w.add(twin);
  const rec = record(shipItemId, twin);
  w.tasks.start(rec, { syntheticToReal: opts.map || new Map() });
  const out = w.tasks.order(rec, null, "attack", { twin, scene: w.scene, record: rec, ...opts.order });
  return { rec, out };
}

function step(w, rec, twin, nowMs) {
  return w.tasks.step(rec, null, { twin, host: w.host, nowMs, scene: w.scene });
}

function counters(w) {
  return w.engine.stats().counters;
}

function withAuto(w, opts = {}) {
  w.autoCalls = [];
  w.access.autoAvailable = () => opts.available !== false;
  w.access.autoCandidates = (scene, twin, host, o) => {
    w.autoCalls.push([host.itemID, o]);
    const candidates = [...scene.entities.values()].filter((e) => e.kind === "ship" && e.nativeNpc === true
      && Number(e.distToHost) <= o.rangeM && w.access.checkTarget(scene, twin, host, e).ok === true)
      .map((e) => ({ id: e.itemID, hostDistanceM: Number(e.distToHost) }));
    return { ok: true, candidates, scanned: scene.entities.size, truncated: false };
  };
  return w;
}

module.exports = ({ test }) => {
  test("CE1 modes: ASSIST picks the host's weapon target (combat.assist.host), status `attacking (assist)`; hold -> "
    + "no volleys, the core follows; attack on an allowed target -> ATTACK; target destroyed -> ASSIST, targetId null "
    + "attack without a target takes the host's weapon target; attack on a player -> TARGET_NOT_NPC, mode "
    + "unchanged", () => {
    const w = fakeWorld();
    const twin = twinEntity(4200000000000010);
    w.add(rat());
    const { rec, out } = deploy(w, 501, twin, { order: { mode: "ASSIST" } });
    assert.deepStrictEqual(out, { ok: true, task: "ATTACK" });
    assert.deepStrictEqual(w.tasks.view(501), { task: "ATTACK", targetId: null, holdM3: 0, sub: "ASSIST",
      wait: null });
    assert.deepStrictEqual(step(w, rec, twin, 1000), { controlsMovement: false }, "no source: the core follows");
    assert.strictEqual(counters(w)["combat.assist.none"], 1);

    w.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: RAT });
    step(w, rec, twin, 1000 + w.config.combatReacquireMs);
    assert.deepStrictEqual(w.fired.map((f) => f[2]), [RAT], "ASSIST shoots the host's target");
    assert.strictEqual(counters(w)["combat.assist.host"], 1);
    assert.deepStrictEqual(w.orders.slice(0, 2), [["stop", twin.itemID], ["lock", twin.itemID, RAT]],
      "in optimal + falloff: stop once, then lock (keepIds [])");

    assert.strictEqual(w.tasks.order(rec, null, "hold", { scene: w.scene, record: rec }).ok, true);
    w.sim += 10 * DURATION;
    assert.deepStrictEqual(step(w, rec, twin, 9000), { controlsMovement: false });
    assert.strictEqual(w.fired.length, 1, "HOLD: no volley");

    const rat2 = w.add(rat(RAT2));
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: RAT2, twin, scene: w.scene, record: rec }),
      { ok: true, task: "ATTACK" });
    assert.deepStrictEqual(w.tasks.view(501), { task: "ATTACK", targetId: RAT2, holdM3: 0, sub: "ATTACK",
      wait: null });
    assert.deepStrictEqual(step(w, rec, twin, 9500), { controlsMovement: true });
    assert.deepStrictEqual(w.fired[w.fired.length - 1].slice(2), [RAT2, w.sim]);

    w.killOn = w.fired.length + 1;
    w.sim += DURATION;
    step(w, rec, twin, 10000);
    assert.strictEqual(w.scene.entities.has(rat2.itemID), false);
    assert.deepStrictEqual(w.tasks.view(501), { task: "ATTACK", targetId: null, holdM3: 0, sub: "ASSIST",
      wait: null });
    w.killOn = null;

    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { twin, scene: w.scene, record: rec }),
      { ok: true, task: "ATTACK" });
    assert.deepStrictEqual([w.tasks.view(501).targetId, w.tasks.view(501).sub], [RAT, "ATTACK"]);

    w.add({ itemID: 9100001, kind: "ship", session: {}, pilotCharacterID: OTHER, distToHost: 100, distToTwin: 100 });
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: 9100001, twin, scene: w.scene, record: rec }),
      { ok: false, reason: "TARGET_NOT_NPC" });
    assert.deepStrictEqual([w.tasks.view(501).targetId, w.tasks.view(501).sub], [RAT, "ATTACK"]);
    w.host.activeModuleEffects.clear();
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { twin, scene: w.scene, record: rec }),
      { ok: false, reason: "NO_TARGET" }, "no host weapon target, no host lock");
    assert.deepStrictEqual([w.tasks.view(501).targetId, w.tasks.view(501).sub], [RAT, "ATTACK"]);
    w.noWeapons = true;
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: RAT2, twin, scene: w.scene, record: rec }),
      { ok: false, reason: "NO_WEAPONS" });
    assert.strictEqual(counters(w)["combat.assist.noWeapons"], 0);
  });

  test("CE2: checkTarget before EVERY volley - the target turns into a player, another twin, CONCORD or "
    + "leaves combatEngageRangeMeters -> 0 fireVolley, ATTACK reverses", () => {
    const variants = {
      player: (r) => Object.assign(r, { session: {}, pilotCharacterID: OTHER }),
      twin: (r) => Object.assign(r, { nativeNpc: false, pilotCharacterID: OWNER }),
      concord: (r) => Object.assign(r, { npcEntityType: "concord" }),
      range: (r) => Object.assign(r, { distToHost: 999999 }),
    };
    for (const [name, change] of Object.entries(variants)) {
      const w = fakeWorld();
      const twin = twinEntity(4200000000000010);
      const target = w.add(rat());
      const { rec, out } = deploy(w, 501, twin, { order: { targetId: RAT } });
      assert.strictEqual(out.ok, true, name);
      change(target);
      step(w, rec, twin, 1000);
      assert.strictEqual(w.fired.length, 0, `${name}: no volley`);
      assert.deepStrictEqual([w.tasks.view(501).sub, w.tasks.view(501).targetId], ["ASSIST", null], name);
    }
    const w = fakeWorld({ weapons: () => turrets(2) });
    const twin = twinEntity(4200000000000010);
    const target = w.add(rat());
    const { rec } = deploy(w, 501, twin, { order: { targetId: RAT } });
    w.onFire = () => Object.assign(target, { session: {}, pilotCharacterID: OTHER });
    step(w, rec, twin, 1000);
    assert.strictEqual(w.fired.length, 1, "checked again before the 2nd volley");
  });

  test("CE3 schedule on scene time: volleys every durationMs without drift at 500 ms ticks; backlog > 1 cycle -> "
    + "reset; more due volleys than combatMaxVolleysPerTick -> the rest next tick (combat.volley.deferred); 10 twins "
    + "x 8 turrets -> at most the limit per tick", () => {
    const w = fakeWorld();
    const twin = twinEntity(4200000000000010);
    w.add(rat());
    const { rec } = deploy(w, 501, twin, { order: { targetId: RAT } });
    const start = w.sim;
    for (let i = 0; i < 12; i += 1) {
      step(w, rec, twin, 1000 + i * 500);
      w.sim += 500;
    }
    assert.deepStrictEqual(w.fired.map((f) => f[3] - start), [0, 1500, 3000, 4500], "no drift");
    w.sim += 20000;
    step(w, rec, twin, 9000);
    const at = w.sim;
    step(w, rec, twin, 9500);
    w.sim += DURATION - 1;
    step(w, rec, twin, 10000);
    assert.strictEqual(w.fired.length, 5, "one volley after the stall, the next one a full cycle later");
    w.sim += 1;
    step(w, rec, twin, 10500);
    assert.deepStrictEqual(w.fired.slice(4).map((f) => f[3] - at), [0, DURATION], "reset to now + durationMs");

    const b = fakeWorld({ config: { combatMaxVolleysPerTick: 3 }, weapons: () => turrets(8) });
    const t8 = twinEntity(4200000000000020);
    b.add(rat());
    const r8 = deploy(b, 502, t8, { order: { targetId: RAT } }).rec;
    step(b, r8, t8, 1000);
    assert.strictEqual(b.fired.length, 3);
    assert.strictEqual(counters(b)["combat.volley.deferred"], 5);
    step(b, r8, t8, 1500);
    step(b, r8, t8, 2000);
    assert.strictEqual(b.fired.length, 8, "the deferred volleys come in the next ticks");
    assert.deepStrictEqual([...new Set(b.fired.map((f) => f[1]))].length, 8, "every turret once");

    const big = fakeWorld({ weapons: () => turrets(8) });
    big.add(rat());
    const pairs = [];
    for (let i = 0; i < 10; i += 1) {
      const t = twinEntity(4200000000000100 + i * 10);
      pairs.push([deploy(big, 600 + i, t, { order: { targetId: RAT } }).rec, t]);
    }
    for (const [r, t] of pairs) step(big, r, t, 5000);
    assert.strictEqual(big.fired.length, big.config.combatMaxVolleysPerTick);
    assert.strictEqual(counters(big)["combat.volley.deferred"], 80 - big.config.combatMaxVolleysPerTick);
  });

  test("CE4 movement: out of optimal + falloff -> approach at min(optimal, combatOrbitMaxMeters) "
    + "again after combatApproachRetuneMs while the twin stands; steering and closing -> no new order; after "
    + "combatApproachTimeoutMs -> reverse + combat.approach.timeout; a valid rt.moveLease -> zero movement orders",
  () => {
    const w = fakeWorld({ config: { combatOrbitMaxMeters: 3000 } });
    const twin = twinEntity(4200000000000010);
    const target = w.add(rat(RAT, { distToTwin: 20000 }));
    const { rec } = deploy(w, 501, twin, { order: { targetId: RAT } });
    const moves = () => w.orders.filter((o) => o[0] === "approach" || o[0] === "stop");
    step(w, rec, twin, 1000);
    assert.deepStrictEqual(moves(), [["approach", twin.itemID, RAT, 3000]]);
    w.sim += 1000;
    step(w, rec, twin, 2000);
    assert.strictEqual(moves().length, 1, "before the retune time: nothing");
    w.sim += w.config.combatApproachRetuneMs;
    step(w, rec, twin, 3000);
    assert.strictEqual(moves().length, 2, "the twin stands (mode STOP): the order again");
    Object.assign(twin, { mode: "FOLLOW", targetEntityID: RAT });
    target.distToTwin = 15000;
    w.sim += w.config.combatApproachRetuneMs;
    step(w, rec, twin, 4000);
    assert.strictEqual(moves().length, 2, "steering to the target and closing: no new order");
    w.sim += w.config.combatApproachTimeoutMs;
    step(w, rec, twin, 5000);
    assert.strictEqual(counters(w)["combat.approach.timeout"], 1);
    assert.deepStrictEqual([w.tasks.view(501).sub, w.tasks.view(501).targetId], ["ASSIST", null]);
    assert.strictEqual(w.fired.length, 0, "out of optimal + falloff: locked, but no volley (no ammo wasted)");
    assert.ok(w.orders.some((o) => o[0] === "lock"), "the lock is taken while flying in");

    const l = fakeWorld();
    const t2 = twinEntity(4200000000000020);
    const far = l.add(rat(RAT, { distToTwin: 20000 }));
    const r2 = deploy(l, 502, t2, { order: { targetId: RAT } }).rec;
    l.tasks.context(502).moveLease = { by: "logi", targetId: 1, untilSimMs: l.sim + 60000 };
    step(l, r2, t2, 1000);
    l.sim += 40000;
    step(l, r2, t2, 2000);
    assert.deepStrictEqual(l.orders.filter((o) => o[0] === "approach" || o[0] === "stop"), [], "lease: no order");
    l.tasks.context(502).moveLease = null;
    far.distToTwin = 6000;
    step(l, r2, t2, 3000);
    step(l, r2, t2, 3500);
    assert.deepStrictEqual(l.orders.filter((o) => o[0] === "approach" || o[0] === "stop"), [["stop", t2.itemID]]);
  });

  test("CE4b () ATTACK out of range, a logistics lease longer than combatApproachTimeoutMs: "
    + "after the lease the approach starts again - still ATTACK on the same target, no combat.approach.timeout", () => {
    const m = fakeWorld();
    const twin = twinEntity(4200000000000030);
    m.add(rat(RAT, { distToTwin: 20000 }));
    const { rec } = deploy(m, 503, twin, { order: { targetId: RAT } });
    step(m, rec, twin, 1000);
    assert.deepStrictEqual([m.tasks.view(503).sub, m.tasks.view(503).targetId], ["ATTACK", RAT]);
    const leaseMs = m.config.combatApproachTimeoutMs + 2000;
    m.tasks.context(503).moveLease = { by: "logi", targetId: 1, untilSimMs: m.sim + leaseMs };
    m.sim += m.config.combatApproachTimeoutMs + 1000;
    step(m, rec, twin, 2000);
    m.sim += 2000;
    step(m, rec, twin, 3000);
    assert.strictEqual(counters(m)["combat.approach.timeout"] || 0, 0, "the lease time is not approach time");
    assert.deepStrictEqual([m.tasks.view(503).sub, m.tasks.view(503).targetId], ["ATTACK", RAT]);
    assert.strictEqual(m.orders.filter((o) => o[0] === "approach").length, 2, "a new approach after the lease");
  });

  test("CE5 core: launch with combatAssistOnLaunch -> ATTACK/ASSIST, no weapons -> FOLLOW + combat.assist.noWeapons; "
    + "chat `attack`/status; beginLoss inside a volley loop -> no more volleys, no consumeAmmo; RETURN stops fire; "
    + "attack -> hold -> RECALL_DONE -> ammo written back once (receiptKey, fingerprint), a retried end sends nothing",
  () => {
    const w = fakeWorld({ weapons: (twin) => ((twin.spec && twin.spec.nativeCargoItems) || []).map((row, i) => ({
      moduleId: row.moduleID, flagId: 27 + i, family: "hybridTurret", needsAmmo: true, chargeItemId: row.itemID,
      chargeQuantity: row.quantity })) });
    const holder = { svc: null };
    w.isTwin = (t) => Boolean(holder.svc && holder.svc.twinOf(t));
    const t = fixtures.setup({ config: { combatEnabled: true, maxWingPerPilot: 3 }, taskReady: () => true,
      taskEngines: { attack: w.engine } });
    holder.svc = t.svc;
    t.adapter.readFit = (id) => [
      { itemID: id * 10, typeID: 3146, flagID: 27, categoryID: 7 },
      { itemID: id * 10 + 1, typeID: 230, flagID: 27, categoryID: 8, quantity: 40 },
      { itemID: id * 10 + 2, typeID: 3146, flagID: 28, categoryID: 7 },
      { itemID: id * 10 + 3, typeID: 230, flagID: 28, categoryID: 8, quantity: 40 },
    ];
    const host = t.w.scene.entities.get(fixtures.HOST);
    host.activeModuleEffects = new Map();
    w.host = host;
    try {
      assert.ok(t.svc.SUPPORTED_VERBS.includes("attack"));
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "launch", { commandId: "c" }).ok, true);
      w.noWeapons = true;
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 502, "launch", { commandId: "c" }).ok, true);
      w.noWeapons = false;
      const ships = t.svc.listWing(fixtures.CHAR).ships;
      const row = (id) => ships.find((s) => s.shipItemId === id);
      assert.deepStrictEqual([row(501).task, row(501).taskSub, row(502).task, row(502).taskSub],
        ["ATTACK", "ASSIST", "FOLLOW", null]);
      assert.strictEqual(counters(w)["combat.assist.noWeapons"], 1);
      const chat = createChatChannel({ core: t.svc, trigger: "!wing", characterIdOf: () => fixtures.CHAR });
      assert.match(chat.handle({}, "!wing status"), /Hulk 501 \[out \d+ m, attacking \(assist\)\]/);
      assert.match(chat.handle({}, "!wing help"), /!wing attack \[name\]/);
      assert.deepStrictEqual(MISSING_TEXT, []);
      assert.strictEqual(chat.handle({}, "!wing attack"),
        "Ship Wing: not attacking: Hulk 501 (no target - shoot or lock an NPC first).");

      const twin501 = fixtures.twinOf(t, 501);
      const target = rat();
      t.w.scene.entities.set(RAT, target);
      host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: RAT });
      assert.strictEqual(chat.handle({}, "!wing attack 501"), "Ship Wing: attacking Hulk 501.");
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(w.fired.map((f) => [f[0], f[2]]), [[twin501, RAT], [twin501, RAT]]);
      w.sim += DURATION;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(w.fired.length, 4);

      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "hold").ok, true);
      w.sim += DURATION;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(w.fired.length, 4, "HOLD: no volley");
      const remove = t.adapter.remove;
      let failOnce = true;
      t.adapter.remove = (scene, id) => {
        if (id === twin501 && failOnce) {
          failOnce = false;
          return false;
        }
        return remove(scene, id);
      };
      const launchedAtMs = t.store.get(501).launchedAtMs;
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "return").ok, true);
      t.w.distance.set(twin501, 100);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.stats().counters["end.removeRetry"], 1);
      assert.strictEqual(t.store.get(501), null, "ended after the retry");
      assert.deepStrictEqual(w.consumed.map(([real, qty, o]) => [real, qty, o.receiptKey, o.fingerprint]), [
        [5011, 2, ammoReceiptKey(501, launchedAtMs, 5011), { shipItemId: 501, realChargeItemId: 5011, quantity: 2 }],
        [5013, 2, ammoReceiptKey(501, launchedAtMs, 5013), { shipItemId: 501, realChargeItemId: 5013, quantity: 2 }],
      ], "one call per real stack, the retried end sends nothing (after hold too)");
      assert.strictEqual(ammoReceiptKey(501, 7, 5011), "wing-ammo:501:7:5011");
      assert.deepStrictEqual(w.emits, [[fixtures.CHAR, 1], [fixtures.CHAR, 1]], "changes to the owner's client");

      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 503, "launch", { commandId: "c" }).ok, true);
      const twin503 = fixtures.twinOf(t, 503);
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 502, "return").ok, true);
      w.onFire = (twin) => {
        if (twin.itemID === twin503) t.svc.beginLoss(503, { cause: "DESTROYED" });
      };
      const before = w.fired.length;
      w.sim += DURATION;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(w.fired.slice(before).map((f) => f[0]), [twin503], "loss after the 1st volley: stop");
      w.sim += DURATION;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(w.fired.length, before + 1, "a lost twin never fires again");
      assert.strictEqual(w.consumed.length, 2, "a loss writes no ammo back (settles the ship)");
    } finally {
      fixtures.cleanup(t.dir);
    }
  });

  test("CE6 ammo: N hybrid volleys -> 1 consumeAmmo(real, N); crystal -> 0 calls; the synthetic charge used up -> "
    + "the weapon stands (no reload); INSUFFICIENT_ITEMS -> combat.ammo.writeBack.failed, beforeEnd never throws; "
    + "no map entry -> noMap; combatAmmoWriteBack=false -> 0 calls; counter names disjoint", () => {
    const run = (opts) => {
      const w = fakeWorld({ config: opts.config, weapons: () => turrets(1, 7000, opts.quantity || 100) });
      w.chargeMode = opts.chargeMode || "stack";
      w.consumeFail = opts.consumeFail || null;
      const twin = twinEntity(4200000000000010);
      w.add(rat());
      const map = opts.noMap ? new Map() : new Map([[7000, 8000]]);
      const { rec } = deploy(w, 501, twin, { map, order: { targetId: RAT } });
      for (let i = 0; i < 3; i += 1) {
        step(w, rec, twin, 1000 + i * 500);
        w.sim += DURATION;
      }
      w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
      w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
      return w;
    };
    const hybrid = run({});
    assert.deepStrictEqual(hybrid.consumed.map((c) => [c[0], c[1], c[2].receiptKey]),
      [[8000, 3, "wing-ammo:501:1234:8000"]], "N volleys -> one call with N; the 2nd beforeEnd sends nothing");
    assert.strictEqual(counters(hybrid)["combat.ammo.writeBack.ok"], 1);
    assert.strictEqual(run({ chargeMode: "crystal" }).consumed.length, 0, "a crystal is not used up");
    const short = run({ quantity: 2 });
    assert.deepStrictEqual([short.fired.length, short.consumed[0][1]], [2, 2], "2 charges: the 3rd volley stands");
    const failed = run({ consumeFail: "INSUFFICIENT_ITEMS" });
    assert.deepStrictEqual([failed.consumed.length, failed.consumed[0][1], failed.consumed[1][1]], [2, 3, 3],
      "a failed stack is tried again only with the same amount");
    assert.strictEqual(counters(failed)["combat.ammo.writeBack.failed"], 2);
    assert.strictEqual(counters(run({ noMap: true }))["combat.ammo.writeBack.noMap"], 1);
    assert.strictEqual(run({ config: { combatAmmoWriteBack: false } }).consumed.length, 0);

    const others = [...COMBAT_COUNTER_NAMES, ...require("../../lib/core/wingTasks").COUNTER_NAMES,
      ...require("../../lib/core/miningTask").ENGINE_COUNTER_NAMES];
    assert.deepStrictEqual(ENGINE_COUNTER_NAMES.filter((n) => others.includes(n)), []);
    const w = fakeWorld();
    w.lockRefuse = "TARGET_JAMMED";
    const twin = twinEntity(4200000000000010);
    w.add(rat());
    const { rec } = deploy(w, 501, twin, { order: { targetId: RAT } });
    step(w, rec, twin, 1000);
    assert.deepStrictEqual([w.fired.length, counters(w)["combat.lock.refused.TARGET_JAMMED"]], [0, 1]);
  });

  test("CE7: after beforeEnd (the end began; end.removeRetry keeps the twin) no volley ever again "
    + "also after a new attack order; an end that began before `attack` ever ran blocks it too", () => {
    const w = fakeWorld();
    const twin = twinEntity(4200000000000010);
    w.add(rat());
    const { rec } = deploy(w, 501, twin, { map: new Map([[7000, 8000]]), order: { targetId: RAT } });
    step(w, rec, twin, 1000);
    assert.strictEqual(w.fired.length, 1);
    w.tasks.beforeEnd(rec, { scene: w.scene }, "OUT_OF_RANGE");
    assert.strictEqual(w.consumed.length, 1, "the plan is fixed with 1 charge");
    for (let i = 0; i < 3; i += 1) {
      w.sim += DURATION;
      assert.deepStrictEqual(step(w, rec, twin, 2000 + i * 500), { controlsMovement: false });
    }
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: RAT2, twin, scene: w.scene, record: rec,
      source: "mirror" }), { ok: false, reason: "ENDING" });
    assert.strictEqual(w.tasks.context(501).combat.lastMirrorTargetId, null, "a refused mirror order keeps no target");
    w.sim += DURATION;
    step(w, rec, twin, 5000);
    assert.strictEqual(w.fired.length, 1, "no free ammo: no volley after the end began");

    const h = fakeWorld();
    const t2 = twinEntity(4200000000000020);
    h.add(rat());
    const r2 = record(502, t2);
    h.add(t2);
    h.tasks.start(r2, { syntheticToReal: new Map() });
    h.tasks.beforeEnd(r2, { scene: h.scene }, "OUT_OF_RANGE");
    assert.deepStrictEqual(h.tasks.order(r2, null, "attack", { targetId: RAT, twin: t2, scene: h.scene, record: r2 }),
      { ok: false, reason: "ENDING" });
    assert.strictEqual(h.tasks.view(502).task, "FOLLOW");
    step(h, r2, t2, 1000);
    assert.strictEqual(h.fired.length, 0);
  });

  test("CE8: every weapon out of ammo -> the twin leaves the target: ASSIST, no target, the core "
    + "follows the host (controlsMovement false), combat.ammo.empty once; one weapon with ammo left -> it fights on",
  () => {
    const w = fakeWorld({ weapons: () => turrets(2, 7000, 1) });
    const twin = twinEntity(4200000000000010);
    w.add(rat());
    w.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: RAT });
    const { rec } = deploy(w, 501, twin, { order: { targetId: RAT } });
    assert.deepStrictEqual(step(w, rec, twin, 1000), { controlsMovement: true });
    assert.strictEqual(w.fired.length, 2, "1 charge per turret");
    w.sim += DURATION;
    assert.deepStrictEqual(step(w, rec, twin, 1500), { controlsMovement: false }, "dry: the core follows the host");
    assert.deepStrictEqual([w.tasks.view(501).sub, w.tasks.context(501).targetId], ["ASSIST", null]);
    for (let i = 0; i < 3; i += 1) {
      w.sim += DURATION;
      assert.deepStrictEqual(step(w, rec, twin, 2000 + i * w.config.combatReacquireMs), { controlsMovement: false },
        "ASSIST does not pick the host's target again");
    }
    assert.strictEqual(counters(w)["combat.ammo.empty"], 1);
    assert.strictEqual(w.fired.length, 2);
    assert.ok(ENGINE_COUNTER_NAMES.includes("combat.ammo.empty"));
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: RAT, twin, scene: w.scene, record: rec }),
      { ok: false, reason: "NO_AMMO" });
    assert.deepStrictEqual([w.tasks.view(501).sub, w.tasks.context(501).targetId], ["ASSIST", null]);

    const m = fakeWorld({ weapons: () => [...turrets(1, 7000, 1), ...turrets(1, 7100, 50).map((x) => ({ ...x,
      moduleId: 200, flagId: 40 }))] });
    const t2 = twinEntity(4200000000000020);
    m.add(rat());
    const r2 = deploy(m, 502, t2, { order: { targetId: RAT } }).rec;
    step(m, r2, t2, 1000);
    m.sim += DURATION;
    assert.deepStrictEqual(step(m, r2, t2, 1500), { controlsMovement: true });
    assert.deepStrictEqual([m.fired.length, counters(m)["combat.ammo.empty"]], [3, 0]);
  });

  test("CE9 an accepted attack with source mirror keeps lastMirrorTargetId - also when "
    + "the same order is a no-op (idempotence); a refused one (TARGET_NOT_NPC) and a chat order leave it; after the "
    + "ATTACK target dies, ASSIST picks the mirror target (combat.assist.mirror) through checkTarget", () => {
    const w = fakeWorld({ config: { commandMirrorEngageCopyDefault: true } });
    const twin = twinEntity(4200000000000010);
    w.add(rat());
    const { rec } = deploy(w, 501, twin, { order: { targetId: RAT } });
    const c = () => w.tasks.context(501).combat;
    assert.strictEqual(c().lastMirrorTargetId, null, "a chat order is not a mirror target");
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: RAT, twin, scene: w.scene, record: rec,
      source: "mirror" }), { ok: true, task: "ATTACK" });
    assert.strictEqual(c().lastMirrorTargetId, RAT);
    w.add({ itemID: 9100001, kind: "ship", session: {}, pilotCharacterID: OTHER, distToHost: 100, distToTwin: 100 });
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: 9100001, twin, scene: w.scene, record: rec,
      source: "mirror" }), { ok: false, reason: "TARGET_NOT_NPC" });
    assert.strictEqual(c().lastMirrorTargetId, RAT);
    w.add(rat(RAT2));
    assert.strictEqual(w.tasks.order(rec, null, "attack", { targetId: RAT2, twin, scene: w.scene, record: rec,
      source: "chat" }).ok, true);
    assert.strictEqual(c().lastMirrorTargetId, RAT, "start() keeps the mirror target (ASSIST source 2)");
    w.killOn = 1;
    step(w, rec, twin, 1000);
    assert.deepStrictEqual(w.fired.map((f) => f[2]), [RAT2]);
    assert.deepStrictEqual(w.tasks.view(501), { task: "ATTACK", targetId: null, holdM3: 0, sub: "ASSIST",
      wait: null });
    w.killOn = null;
    w.sim += DURATION;
    step(w, rec, twin, 1000 + w.config.combatReacquireMs);
    assert.strictEqual(counters(w)["combat.assist.mirror"], 1);
    assert.deepStrictEqual(w.fired.map((f) => f[2]), [RAT2, RAT], "ASSIST shoots the mirror target");
    w.scene.entities.get(RAT).session = {};
    const fired = w.fired.length;
    for (let i = 1; i <= 3; i += 1) {
      w.sim += DURATION;
      step(w, rec, twin, 1000 + (i + 1) * w.config.combatReacquireMs);
    }
    assert.strictEqual(w.fired.length, fired);
  });

  test("CE-mirror: rt.mirrorEngage false + lastMirrorTargetId -> ASSIST takes no mirror target "
    + "(combat.assist.none); the pilot's weapon target is still picked (host); F on -> the mirror target", () => {
    const w = fakeWorld();
    const twin = twinEntity(4200000000000010);
    w.add(rat());
    w.add(rat(RAT2));
    const { rec } = deploy(w, 501, twin, { order: { mode: "ASSIST" } });
    const rt = w.tasks.context(501);
    assert.strictEqual(rt.mirrorEngage, false, "copy default off");
    rt.combat.lastMirrorTargetId = RAT;
    assert.deepStrictEqual(step(w, rec, twin, 1000), { controlsMovement: false });
    assert.deepStrictEqual([counters(w)["combat.assist.none"], counters(w)["combat.assist.mirror"], w.fired.length],
      [1, 0, 0]);
    w.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: RAT2 });
    step(w, rec, twin, 1000 + w.config.combatReacquireMs);
    assert.deepStrictEqual([counters(w)["combat.assist.host"], w.fired.map((f) => f[2])], [1, [RAT2]]);

    const w2 = fakeWorld();
    const twin2 = twinEntity(4200000000000011);
    w2.add(rat());
    const d2 = deploy(w2, 502, twin2, { order: { mode: "ASSIST" } });
    assert.deepStrictEqual(w2.tasks.setMirrorEngage(502, true), { ok: true, on: true });
    w2.tasks.context(502).combat.lastMirrorTargetId = RAT;
    step(w2, d2.rec, twin2, 1000);
    assert.deepStrictEqual([counters(w2)["combat.assist.mirror"], w2.fired.map((f) => f[2])], [1, [RAT]]);
  });

  test("CE10: mirror over the real core - CmdEngage -> attack (source mirror) and volleys "
    + "RecallFightersToTubes -> hold for the ATTACK twin only (FOLLOW twin untouched); return -> RECALL_DONE -> one "
    + "consumeAmmo per real stack (the ammo count kept by hold)", () => {
    const { createCommandMirror } = require("../../lib/adapter/commandMirror");
    const w = fakeWorld({ weapons: (twin) => ((twin.spec && twin.spec.nativeCargoItems) || []).map((row, i) => ({
      moduleId: row.moduleID, flagId: 27 + i, family: "hybridTurret", needsAmmo: true, chargeItemId: row.itemID,
      chargeQuantity: row.quantity })) });
    const holder = { svc: null };
    w.isTwin = (t) => Boolean(holder.svc && holder.svc.twinOf(t));
    const t = fixtures.setup({ config: { combatEnabled: true, combatAssistOnLaunch: false, maxWingPerPilot: 3,
      commandMirrorEngageCopyDefault: true }, taskReady: () => true, taskEngines: { attack: w.engine },
    mirrorEngageOn: () => true });
    holder.svc = t.svc;
    t.adapter.readFit = (id) => (id === 501 ? [
      { itemID: id * 10, typeID: 3146, flagID: 27, categoryID: 7 },
      { itemID: id * 10 + 1, typeID: 230, flagID: 27, categoryID: 8, quantity: 40 },
    ] : []);
    const host = t.w.scene.entities.get(fixtures.HOST);
    host.activeModuleEffects = new Map();
    w.host = host;
    class EntityService {
      Handle_CmdEngage() {
        return "engaged";
      }

      Handle_CmdMineRepeatedly() {
        return "mining";
      }

      Handle_CmdReturnBay() {
        return "bay";
      }

      Handle_CmdReturnHome() {
        return "home";
      }
    }
    class FighterMgrService {
      Handle_CmdActivateAbilitySlots() {
        return "slots";
      }
      Handle_RecallFightersToTubes() {
        return "recalled";
      }
    }
    const mirror = createCommandMirror({ protos: { EntityService: EntityService.prototype,
      FighterMgrService: FighterMgrService.prototype }, wing: t.svc, engageEnabled: true });
    try {
      assert.strictEqual(mirror.install().ok, true);
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 502, "launch", { commandId: "c" }).ok, true);
      const session = { characterID: fixtures.CHAR };
      t.w.scene.entities.set(RAT, rat());
      assert.strictEqual(new EntityService().Handle_CmdEngage([[8001], RAT], session), "engaged");
      const rows = () => Object.fromEntries(t.svc.listWing(fixtures.CHAR).ships.map((s) => [s.shipItemId,
        [s.task, s.targetId]]));
      assert.deepStrictEqual(rows()[501], ["ATTACK", RAT]);
      assert.strictEqual(rows()[502][0], "FOLLOW", "no weapons: refused, FOLLOW kept");
      assert.strictEqual(mirror.stats().counters["mirror.engage.refused.NO_WEAPONS"], 1);
      assert.strictEqual(t.svc.stats().counters["orderCopy.ok.attack"], 1);
      const twin501 = fixtures.twinOf(t, 501);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      w.sim += DURATION;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(w.fired.map((f) => [f[0], f[2]]), [[twin501, RAT], [twin501, RAT]]);

      assert.strictEqual(new FighterMgrService().Handle_RecallFightersToTubes([[7001]], session, null), "recalled");
      assert.deepStrictEqual([rows()[501][0], rows()[502][0]], ["HOLD", "FOLLOW"]);
      w.sim += DURATION;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(w.fired.length, 2, "HOLD: no volley");

      const launchedAtMs = t.store.get(501).launchedAtMs;
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "return").ok, true);
      t.w.distance.set(twin501, 100);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.store.get(501), null, "RECALL_DONE");
      assert.deepStrictEqual(w.consumed.map(([real, qty, o]) => [real, qty, o.receiptKey]),
        [[5011, 2, ammoReceiptKey(501, launchedAtMs, 5011)]], "one call for the stack, 2 charges");
    } finally {
      mirror.stop();
      fixtures.cleanup(t.dir);
    }
  });

  test("CE11 turret 10 km + launcher 40 km: the twin is led by the shortest reach of the "
    + "steering weapons with ammo (approach at the turret's optimal), both fire in it with {ammoLeft}; the turret dry "
    + "-> the range is read again (the launcher's 40 km); used ammo = data.chargesUsed when given, else stack = 1, in "
    + "the write-back plan", () => {
    const weapons = () => [
      { moduleId: 100, flagId: 27, family: "hybridTurret", kind: "turret", steers: true, needsLock: true,
        needsAmmo: true, chargeItemId: 7000, chargeQuantity: 2 },
      { moduleId: 101, flagId: 28, family: "missileLauncher", kind: "missile", steers: true, needsLock: true,
        needsAmmo: true, chargeItemId: 7001, chargeQuantity: 10 },
    ];
    const w = fakeWorld({ weapons, config: { combatOrbitMaxMeters: 50000 } });
    const ranges = [];
    w.access.weaponRange = (_twin, weapon) => {
      ranges.push(weapon.moduleId);
      return weapon.moduleId === 100 ? { ok: true, optimalM: 7000, falloffM: 3000 }
        : { ok: true, optimalM: 40000, falloffM: 0 };
    };
    const calls = [];
    w.access.fireVolley = (_scene, twin, weapon, target, simMs, opts) => {
      calls.push([weapon.moduleId, opts]);
      w.fired.push([twin.itemID, weapon.moduleId, target.itemID, simMs]);
      const missile = weapon.kind === "missile";
      return { ok: true, durationMs: DURATION, data: missile
        ? { hit: false, applied: 0, destroyed: false, chargeItemId: weapon.chargeItemId, chargeMode: "stack",
          chargesUsed: 2 }
        : { hit: true, applied: 10, destroyed: false, chargeItemId: weapon.chargeItemId, chargeMode: "stack" } };
    };
    const twin = twinEntity(4200000000000040);
    const target = w.add(rat(RAT, { distToTwin: 20000 }));
    const { rec } = deploy(w, 504, twin, { map: new Map([[7000, 8000], [7001, 8001]]), order: { targetId: RAT } });
    const moves = () => w.orders.filter((o) => o[0] === "approach" || o[0] === "stop");
    step(w, rec, twin, 1000);
    assert.deepStrictEqual(moves(), [["approach", twin.itemID, RAT, 7000]], "led by the turret (10 km), not 40 km");
    assert.strictEqual(w.fired.length, 0, "20 km: out of the shortest reach, no volley");
    target.distToTwin = 9000;
    step(w, rec, twin, 1500);
    w.sim += DURATION;
    step(w, rec, twin, 2000);
    assert.deepStrictEqual(calls.map(([id, o]) => [id, o]), [[100, { ammoLeft: 2, host: w.host }],
      [101, { ammoLeft: 10, host: w.host }], [100, { ammoLeft: 1, host: w.host }], [101, { ammoLeft: 8, host: w.host }]],
    "ammoLeft per weapon; chargesUsed 2 counted");
    assert.ok(calls.every(([, o]) => o.host === w.host), "the very host entity of the step");
    target.distToTwin = 30000;
    w.sim += DURATION;
    step(w, rec, twin, 2500);
    assert.deepStrictEqual(w.fired.slice(4).map((f) => f[1]), [101], "only the launcher fires at 30 km");
    assert.deepStrictEqual(moves(), [["approach", twin.itemID, RAT, 7000], ["stop", twin.itemID]]);
    assert.deepStrictEqual(ranges, [100, 101, 101], "read again once the set of armed weapons changed");
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    assert.deepStrictEqual(w.consumed.map(([real, qty]) => [real, qty]), [[8000, 2], [8001, 6]],
      "turret 2 x 1 (no field = stack 1), launcher 3 x chargesUsed 2");
  });

  test("CE12 no weapon gives a range (c.range = null): the result is cached for the same "
    + "set of weapons - weaponRange is read once over many steps, the volleys go on", () => {
    const w = fakeWorld({ weapons: () => turrets(2) });
    const ranges = [];
    w.access.weaponRange = (_twin, weapon) => {
      ranges.push(weapon.moduleId);
      return { ok: false, reason: "NO_SNAPSHOT" };
    };
    const twin = twinEntity(4200000000000041);
    w.add(rat(RAT));
    const { rec } = deploy(w, 505, twin, { order: { targetId: RAT } });
    for (let i = 0; i < 6; i += 1) {
      step(w, rec, twin, 1000 + i * 500);
      w.sim += DURATION;
    }
    assert.deepStrictEqual(ranges, [100, 101], "one read of both weapons for six steps (before: one per step)");
    assert.strictEqual(w.fired.length, 12, "no range: the engine does not hold the volleys (the access decides)");
  });

  test("CE13 () a transient ERROR of the range read is not cached for good: the twin with "
    + "only Disintegrators reads the range again after combatReacquireMs and gets its approach", () => {
    const w = fakeWorld({ weapons: () => [{ moduleId: 100, flagId: 27, family: "precursorTurret", kind: "precursor",
      steers: true, needsLock: true, needsAmmo: true, chargeItemId: 7000, chargeQuantity: 100 }] });
    const reads = [];
    w.access.weaponRange = (_twin, weapon) => {
      reads.push(weapon.moduleId);
      return reads.length === 1 ? { ok: false, reason: "ERROR" } : { ok: true, optimalM: 5000, falloffM: 0 };
    };
    const twin = twinEntity(4200000000000042);
    w.add(rat(RAT, { distToTwin: 20000 }));
    const { rec } = deploy(w, 506, twin, { order: { targetId: RAT } });
    const approaches = () => w.orders.filter((o) => o[0] === "approach");
    step(w, rec, twin, 1000);
    assert.deepStrictEqual(approaches(), [], "first read ERROR: no range yet");
    w.sim += w.config.combatReacquireMs - 1;
    step(w, rec, twin, 1500);
    assert.deepStrictEqual(reads, [100], "no read again before combatReacquireMs");
    w.sim += 1;
    step(w, rec, twin, 2000);
    assert.deepStrictEqual(reads, [100, 100], "read again after combatReacquireMs");
    assert.deepStrictEqual(approaches(), [["approach", twin.itemID, RAT, 5000]], "the twin flies to its target");
    w.sim += 3 * w.config.combatReacquireMs;
    step(w, rec, twin, 2500);
    assert.deepStrictEqual(reads, [100, 100], "a good read is cached again");
  });

  test("CE14 (combat-audit) a weapon with needsAmmo and no charge loaded has 0 ammo: alone -> the twin is "
    + "dry (combat.ammo.empty, no approach, no volley) and a new attack order is NO_AMMO; beside a loaded turret it "
    + "never leads the twin (the turret's reach decides) and never fires; a charge-optional weapon still fires", () => {
    const empty = { moduleId: 101, flagId: 28, family: "missileLauncher", kind: "missile", steers: true,
      needsLock: true, needsAmmo: true, chargeItemId: 0, chargeQuantity: 0 };
    const w = fakeWorld({ weapons: () => [empty] });
    const twin = twinEntity(4200000000000043);
    w.add(rat(RAT, { distToTwin: 20000 }));
    const { rec, out } = deploy(w, 507, twin, { order: { targetId: RAT } });
    assert.strictEqual(out.ok, true, "the first order: the weapons are not read yet");
    assert.deepStrictEqual(step(w, rec, twin, 1000), { controlsMovement: false });
    assert.deepStrictEqual([counters(w)["combat.ammo.empty"], w.fired.length,
      w.orders.filter((o) => o[0] === "approach").length], [1, 0, 0], "dry: no approach, no volley");
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: RAT, twin, scene: w.scene, record: rec }),
      { ok: false, reason: "NO_AMMO" });

    const w2 = fakeWorld({ weapons: () => [...turrets(1), { ...empty }] });
    w2.access.weaponRange = (_twin, weapon) => (weapon.moduleId === 100 ? { ok: true, optimalM: 5000, falloffM: 2000 }
      : { ok: true, optimalM: 1000, falloffM: 0 });
    const twin2 = twinEntity(4200000000000044);
    w2.add(rat(RAT, { distToTwin: 4000 }));
    const d2 = deploy(w2, 508, twin2, { order: { targetId: RAT } });
    step(w2, d2.rec, twin2, 1000);
    assert.deepStrictEqual(w2.orders.filter((o) => o[0] === "approach" || o[0] === "stop"), [["stop", twin2.itemID]],
      "4 km is inside the turret's reach: stop, no approach to 1 km");
    assert.deepStrictEqual(w2.fired.map((f) => f[1]), [100], "only the loaded turret fires");

    const w3 = fakeWorld({ weapons: () => [{ ...empty, needsAmmo: false }] });
    const twin3 = twinEntity(4200000000000045);
    w3.add(rat(RAT));
    const d3 = deploy(w3, 509, twin3, { order: { targetId: RAT } });
    step(w3, d3.rec, twin3, 1000);
    assert.deepStrictEqual([w3.fired.length, w3.engine.stats().counters["combat.ammo.empty"]], [1, 0]);
  });

  test("CE15 lock refused: the area weapon (needsLock false) fires, the turret "
    + "(needsLock true) does not; a twin with a smartbomb only is led by the smartbomb range and never takes a lock",
  () => {
    const area = { moduleId: 101, flagId: 28, family: "null", kind: "area", steers: false, needsLock: false,
      needsAmmo: false, chargeItemId: 0, chargeQuantity: 0 };
    const turret = { ...turrets(1)[0], kind: "turret", steers: true, needsLock: true };
    const w = fakeWorld({ weapons: () => [turret, { ...area }] });
    w.lockRefuse = "TARGET_JAMMED";
    const twin = twinEntity(4200000000000046);
    w.add(rat(RAT));
    const d = deploy(w, 510, twin, { order: { targetId: RAT } });
    step(w, d.rec, twin, 1000);
    assert.deepStrictEqual(w.fired.map((f) => f[1]), [101], "only the area weapon fires without the lock");
    assert.strictEqual(counters(w)["combat.lock.refused.TARGET_JAMMED"], 1);
    w.sim += DURATION;
    step(w, d.rec, twin, 1500);
    assert.deepStrictEqual(w.fired.map((f) => f[1]), [101, 101], "the turret stays paused (NOT_LOCKED)");

    const w2 = fakeWorld({ weapons: () => [{ ...area }] });
    w2.access.weaponRange = () => ({ ok: true, optimalM: 4000, falloffM: 0 });
    const twin2 = twinEntity(4200000000000047);
    const target = w2.add(rat(RAT, { distToTwin: 20000 }));
    const d2 = deploy(w2, 511, twin2, { order: { targetId: RAT } });
    step(w2, d2.rec, twin2, 1000);
    assert.deepStrictEqual(w2.orders, [["approach", twin2.itemID, RAT, 4000]], "to the smartbomb range, no lock");
    assert.strictEqual(w2.fired.length, 0);
    target.distToTwin = 3000;
    step(w2, d2.rec, twin2, 1500);
    assert.deepStrictEqual(w2.orders.slice(1), [["stop", twin2.itemID]]);
    assert.deepStrictEqual(w2.fired.map((f) => f[1]), [101]);
    assert.ok(!w2.orders.some((o) => o[0] === "lock"), "no lock slot taken");
  });

  test("CE16 a twin with a bomb only (keepsMoving): in range no stop, approach at 0 m "
    + "once, the bomb fires without a lock; out of range again -> a new approach at the orbit distance; a turret "
    + "beside it leads and stops as before", () => {
    const bomb = { moduleId: 102, flagId: 29, family: "bombLauncher", kind: "bomb", steers: false, needsLock: false,
      keepsMoving: true, needsAmmo: true, chargeItemId: 7102, chargeQuantity: 5 };
    const w = fakeWorld({ weapons: () => [{ ...bomb }] });
    w.access.weaponRange = () => ({ ok: true, optimalM: 30000, falloffM: 0 });
    const twin = twinEntity(4200000000000048);
    const target = w.add(rat(RAT, { distToTwin: 20000 }));
    const d = deploy(w, 512, twin, { order: { targetId: RAT } });
    step(w, d.rec, twin, 1000);
    assert.deepStrictEqual(w.orders, [["approach", twin.itemID, RAT, 0]], "flies on to the target, no stop, no lock");
    assert.deepStrictEqual(w.fired.map((f) => f[1]), [102]);
    w.sim += DURATION;
    step(w, d.rec, twin, 1500);
    assert.deepStrictEqual([w.orders.length, w.fired.length], [1, 2], "no second order while in range");
    target.distToTwin = 40000;
    step(w, d.rec, twin, 2000);
    assert.deepStrictEqual(w.orders.slice(1), [["approach", twin.itemID, RAT, w.config.combatOrbitMaxMeters]]);

    const turret = { ...turrets(1)[0], kind: "turret", steers: true, needsLock: true };
    const w2 = fakeWorld({ weapons: () => [turret, { ...bomb }] });
    const twin2 = twinEntity(4200000000000049);
    w2.add(rat(RAT, { distToTwin: 4000 }));
    const d2 = deploy(w2, 513, twin2, { order: { targetId: RAT } });
    step(w2, d2.rec, twin2, 1000);
    assert.deepStrictEqual(w2.orders.filter((o) => o[0] !== "lock"), [["stop", twin2.itemID]],
      "the turret leads: stop in its range");
  });

  function refuseFor(w, moduleId, reason) {
    const base = w.access.fireVolley;
    w.access.fireVolley = (scene, twin, weapon, target, simMs, opts) => {
      if (weapon.moduleId !== moduleId) return base(scene, twin, weapon, target, simMs, opts);
      w.fired.push([twin.itemID, weapon.moduleId, target.itemID, simMs, reason]);
      return { ok: false, reason, retryMs: DURATION };
    };
  }

  test("CE17 (bug-review pkt 1) a NO_AMMO skip of the access with synthetic ammo left (burned-out "
    + "crystal) = the weapon is empty for the runtime: alone -> dry after the skip (combat.ammo.empty 1, ASSIST "
    + "without a target, a new attack NO_AMMO); beside a turret with ammo -> the turret fights on, the empty weapon "
    + "is never tried again", () => {
    const w = fakeWorld({ weapons: () => turrets(1, 7000, 1) });
    w.chargeMode = "crystal";
    refuseFor(w, 100, "NO_AMMO");
    const twin = twinEntity(4200000000000050);
    w.add(rat());
    w.host.activeModuleEffects.set(1, { weaponFamily: "laserTurret", targetID: RAT });
    const { rec } = deploy(w, 514, twin, { order: { targetId: RAT } });
    assert.deepStrictEqual(step(w, rec, twin, 1000), { controlsMovement: true });
    assert.strictEqual(w.fired.length, 1, "one try, the access skips NO_AMMO");
    for (let i = 0; i < 3; i += 1) {
      w.sim += DURATION;
      assert.deepStrictEqual(step(w, rec, twin, 1500 + i * w.config.combatReacquireMs), { controlsMovement: false },
        "dry: the core follows the host");
    }
    assert.deepStrictEqual([w.tasks.view(514).sub, w.tasks.context(514).targetId], ["ASSIST", null]);
    assert.deepStrictEqual([w.fired.length, counters(w)["combat.ammo.empty"]], [1, 1]);
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { targetId: RAT, twin, scene: w.scene, record: rec }),
      { ok: false, reason: "NO_AMMO" });

    const m = fakeWorld({ weapons: () => [...turrets(1, 7000, 1), ...turrets(1, 7100, 50).map((x) => ({ ...x,
      moduleId: 200, flagId: 40 }))] });
    refuseFor(m, 100, "NO_AMMO");
    const t2 = twinEntity(4200000000000051);
    m.add(rat());
    const r2 = deploy(m, 515, t2, { order: { targetId: RAT } }).rec;
    step(m, r2, t2, 1000);
    m.sim += DURATION;
    assert.deepStrictEqual(step(m, r2, t2, 1500), { controlsMovement: true });
    assert.deepStrictEqual(m.fired.map((f) => f[1]), [100, 200, 200], "the empty weapon is not tried again");
    assert.strictEqual(counters(m)["combat.ammo.empty"], 0);
  });

  test("CE18 (bug-review pkt 7) BREACHER_TARGET_INVALID: the breacher no longer leads the twin to that "
    + "target (the turret range does, no approach) and is not tried again on it; a twin with only that breacher "
    + "leaves the target and ASSIST does not pick it again", () => {
    const breacher = { moduleId: 101, flagId: 28, family: "breacherPodLauncher", kind: "breacher", steers: true,
      needsLock: true, needsAmmo: true, chargeItemId: 7101, chargeQuantity: 8 };
    const rangeOf = (_twin, weapon) => (weapon.moduleId === 101 ? { ok: true, optimalM: 3000, falloffM: 0 }
      : { ok: true, optimalM: 5000, falloffM: 2000 });
    const w = fakeWorld({ weapons: () => [...turrets(1), { ...breacher }] });
    w.access.weaponRange = rangeOf;
    refuseFor(w, 101, "BREACHER_TARGET_INVALID");
    const twin = twinEntity(4200000000000052);
    const target = w.add(rat(RAT, { distToTwin: 2500 }));
    const d = deploy(w, 516, twin, { order: { targetId: RAT } });
    step(w, d.rec, twin, 1000);
    assert.deepStrictEqual(w.fired.map((f) => f[1]), [100, 101]);
    target.distToTwin = 6000;
    w.sim += DURATION;
    const before = w.orders.length;
    assert.deepStrictEqual(step(w, d.rec, twin, 1500), { controlsMovement: true });
    assert.ok(!w.orders.slice(before).some((o) => o[0] === "approach"), "no approach to the breacher range");
    assert.deepStrictEqual(w.fired.map((f) => f[1]), [100, 101, 100]);

    const solo = fakeWorld({ weapons: () => [{ ...breacher }] });
    solo.access.weaponRange = rangeOf;
    refuseFor(solo, 101, "BREACHER_TARGET_INVALID");
    const t2 = twinEntity(4200000000000053);
    solo.add(rat(RAT, { distToTwin: 2500 }));
    solo.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: RAT });
    const s = deploy(solo, 517, t2, { order: { targetId: RAT } });
    step(solo, s.rec, t2, 1000);
    assert.strictEqual(solo.fired.length, 1);
    for (let i = 0; i < 3; i += 1) {
      solo.sim += DURATION;
      assert.deepStrictEqual(step(solo, s.rec, t2, 1500 + i * solo.config.combatReacquireMs),
        { controlsMovement: false }, "the twin leaves the target");
    }
    assert.deepStrictEqual([solo.fired.length, solo.tasks.context(517).targetId], [1, null]);
  });

  test("CE19 (pkt 5) a twin with only a breacher, its target refused (BREACHER_TARGET_INVALID): a new "
    + "attack on that target and an attack without a target (the host shoots it) -> TARGET_INVALID, no volley; "
    + "another target -> ok", () => {
    const breacher = { moduleId: 101, flagId: 28, family: "breacherPodLauncher", kind: "breacher", steers: true,
      needsLock: true, needsAmmo: true, chargeItemId: 7101, chargeQuantity: 8 };
    const w = fakeWorld({ weapons: () => [{ ...breacher }] });
    w.access.weaponRange = () => ({ ok: true, optimalM: 3000, falloffM: 0 });
    refuseFor(w, 101, "BREACHER_TARGET_INVALID");
    const twin = twinEntity(4200000000000054);
    w.add(rat(RAT, { distToTwin: 2500 }));
    w.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: RAT });
    const { rec } = deploy(w, 518, twin, { order: { targetId: RAT } });
    step(w, rec, twin, 1000);
    assert.strictEqual(w.fired.length, 1, "one try, the access refuses the target");
    const ctx = { twin, scene: w.scene, record: rec };
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", { ...ctx, targetId: RAT }),
      { ok: false, reason: "TARGET_INVALID" });
    assert.deepStrictEqual(w.tasks.order(rec, null, "attack", ctx), { ok: false, reason: "TARGET_INVALID" });
    w.sim += DURATION;
    step(w, rec, twin, 1500);
    assert.strictEqual(w.fired.length, 1, "no volley after the refusals");
    w.add(rat(RAT2, { distToTwin: 2500 }));
    assert.strictEqual(w.tasks.order(rec, null, "attack", { ...ctx, targetId: RAT2 }).ok, true);
  });

  test("CE20 (copy drones) a twin without weapons but with combat drones: ASSIST is accepted "
    + "(combat.assist.droneOnly) and takes the host's target for the drones; FREE, no move, no lock, no volley; a "
    + "refused target is lost; without drones -> NO_WEAPONS as before", () => {
    const w = fakeWorld({ droneWeapons: (_twin, ctx) => Boolean(ctx && ctx.record) });
    w.noWeapons = true;
    const twin = twinEntity(4200000000000060);
    w.add(rat());
    w.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: RAT });
    const { rec, out } = deploy(w, 520, twin, { order: { mode: "ASSIST" } });
    const rt = w.tasks.context(520);
    assert.deepStrictEqual(out, { ok: true, task: "ATTACK" });
    assert.deepStrictEqual(step(w, rec, twin, 1000), { controlsMovement: false });
    assert.strictEqual(rt.combat.targetId, RAT, "the drones' target");
    assert.deepStrictEqual([w.fired, w.orders], [[], []], "no volley, no lock, no move");
    assert.strictEqual(w.engine.stats().counters["combat.assist.droneOnly"], 1);
    w.scene.entities.get(RAT).destroying = true;
    step(w, rec, twin, 1500);
    assert.strictEqual(rt.combat.targetId, null);
    const bare = fakeWorld();
    bare.noWeapons = true;
    const other = twinEntity(4200000000000061);
    assert.deepStrictEqual(deploy(bare, 521, other, { order: { mode: "ASSIST" } }).out,
      { ok: false, reason: "NO_WEAPONS" });
  });

  test("CE-S an NPC site structure (habitat 17401) as the primary target: the pilot's only lock -> "
    + "attack canRun ok with targetId = it; ASSIST with it as the pilot's weapon target -> source host, the twin "
    + "fires at it; flag combatAllowNpcStructureTargets off -> TARGET_NOT_NPC", () => {
    const HAB = 9500001;
    const habitat = () => ({ itemID: HAB, typeID: 17401, kind: "siteEnvironmentProp", groupID: 319, categoryID: 11,
      ownerID: 1, dungeonMaterializedSiteContent: true, dungeonMaterializedEnvironment: true, distToHost: 5000,
      distToTwin: 4000 });
    const w = fakeWorld();
    const twin = twinEntity(4200000000000080);
    w.add(habitat());
    w.locks.set(HOST, new Set([HAB]));
    const { out } = deploy(w, 540, twin);
    assert.deepStrictEqual(out, { ok: true, task: "ATTACK" });
    assert.deepStrictEqual([w.tasks.view(540).sub, w.tasks.view(540).targetId], ["ATTACK", HAB]);

    const a = fakeWorld();
    const t2 = twinEntity(4200000000000081);
    a.add(habitat());
    const r2 = deploy(a, 541, t2, { order: { mode: "ASSIST" } }).rec;
    a.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: HAB });
    step(a, r2, t2, 1000 + a.config.combatReacquireMs);
    assert.strictEqual(counters(a)["combat.assist.host"], 1);
    assert.deepStrictEqual(a.fired.map((f) => f[2]), [HAB]);

    const off = fakeWorld({ config: { combatAllowNpcStructureTargets: false } });
    const t3 = twinEntity(4200000000000082);
    off.add(habitat());
    assert.deepStrictEqual(deploy(off, 542, t3, { order: { targetId: HAB } }).out,
      { ok: false, reason: "TARGET_NOT_NPC" });
  });

  test("AT1 an explicit attack without the pilot's target: accepted (no NO_TARGET), ASSIST, the auto "
    + "target = the NPC nearest to the pilot (combat.assist.auto), view targetId = it, the twin fires; a drone-only "
    + "twin keeps the same target for its drones", () => {
    const w = withAuto(fakeWorld());
    const twin = twinEntity(4200000000000070);
    w.add(rat(RAT, { distToHost: 5000 }));
    w.add(rat(RAT2, { distToHost: 3000 }));
    const { rec, out } = deploy(w, 531, twin, { order: { source: "window" } });
    assert.deepStrictEqual([out, w.tasks.view(531).sub], [{ ok: true, task: "ATTACK" }, "ASSIST"]);
    step(w, rec, twin, 1000);
    assert.deepStrictEqual(w.tasks.view(531), { task: "ATTACK", targetId: RAT2, holdM3: 0, sub: "ASSIST",
      wait: null });
    assert.deepStrictEqual([counters(w)["combat.assist.auto"], counters(w)["combat.auto.armed"],
      counters(w)["combat.auto.scan"]], [1, 1, 1]);
    assert.deepStrictEqual(w.fired.map((f) => f[2]), [RAT2]);
    assert.deepStrictEqual(w.autoCalls, [[HOST, { rangeM: Math.min(w.config.combatAutoTargetRangeMeters,
      w.config.combatEngageRangeMeters), maxEntities: w.config.combatAutoScanMaxEntities }]]);

    const d = withAuto(fakeWorld({ droneWeapons: () => true }));
    d.noWeapons = true;
    d.add(rat(RAT, { distToHost: 5000 }));
    d.add(rat(RAT2, { distToHost: 3000 }));
    const dt = twinEntity(4200000000000071);
    const dd = deploy(d, 532, dt, { order: { source: "chat" } });
    assert.deepStrictEqual(dd.out, { ok: true, task: "ATTACK" });
    step(d, dd.rec, dt, 1000);
    assert.deepStrictEqual([d.tasks.context(532).combat.targetId, d.fired.length], [RAT2, 0]);
    assert.deepStrictEqual(d.tasks.view(532), { task: "ATTACK", targetId: RAT2, holdM3: 0, sub: "ASSIST", wait: null,
      weaponless: true });
  });

  test("AT2 the pilot's weapon target wins (no scan); launch ASSIST and mirror never arm "
    + "mirror disarms; flag off or no combatAuto probe -> NO_TARGET as before; an NPC that locks the twin beats a "
    + "nearer one", () => {
    const w = withAuto(fakeWorld());
    const twin = twinEntity(4200000000000072);
    w.add(rat(RAT, { distToHost: 5000 }));
    w.add(rat(RAT2, { distToHost: 3000 }));
    const { rec } = deploy(w, 541, twin, { order: { source: "window" } });
    w.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: RAT });
    step(w, rec, twin, 1000);
    assert.deepStrictEqual([w.tasks.context(541).combat.targetId, counters(w)["combat.assist.host"],
      counters(w)["combat.assist.auto"], w.autoCalls.length], [RAT, 1, 0, 0]);

    const l = withAuto(fakeWorld());
    const lt = twinEntity(4200000000000073);
    l.add(rat(RAT));
    const launched = deploy(l, 542, lt, { order: { mode: "ASSIST", source: "launch" } });
    step(l, launched.rec, lt, 1000);
    const lc = () => l.tasks.context(542).combat;
    const mirror = () => l.tasks.order(launched.rec, null, "attack", { targetId: RAT, twin: lt, scene: l.scene,
      record: launched.rec, source: "mirror" });
    assert.strictEqual(mirror().ok, true);
    assert.deepStrictEqual([lc().auto, counters(l)["combat.auto.armed"], counters(l)["combat.auto.scan"],
      counters(l)["combat.assist.none"]], [false, 0, 0, 1]);
    assert.strictEqual(l.tasks.order(launched.rec, null, "attack", { twin: lt, scene: l.scene, record: launched.rec,
      source: "window" }).ok, true);
    assert.deepStrictEqual([lc().auto, counters(l)["combat.auto.armed"]], [true, 1]);
    assert.strictEqual(mirror().ok, true);
    assert.strictEqual(lc().auto, false, "a mirror order disarms");

    for (const [name, off] of [["flag", withAuto(fakeWorld({ config: { combatAutoTargetEnabled: false } }))],
      ["probe", withAuto(fakeWorld(), { available: false })]]) {
      off.add(rat(RAT));
      assert.deepStrictEqual(deploy(off, 543, twinEntity(4200000000000074), { order: { source: "window" } }).out,
        { ok: false, reason: "NO_TARGET" }, name);
      assert.deepStrictEqual([off.autoCalls.length, counters(off)["combat.auto.armed"]], [0, 0], name);
    }

    const t = withAuto(fakeWorld({ config: { combatDefendWhenAttacked: false } }));
    const tt = twinEntity(4200000000000075);
    t.add(rat(RAT, { distToHost: 9000 }));
    t.add(rat(RAT2, { distToHost: 3000 }));
    t.threats.set(tt.itemID, [RAT]);
    const tr = deploy(t, 544, tt, { order: { source: "window" } });
    step(t, tr.rec, tt, 1000);
    assert.deepStrictEqual([t.tasks.context(544).combat.targetId, counters(t)["combat.assist.auto"]], [RAT, 1]);
  });

  test("AT3 an armed twin whose ATTACK target dies goes back to ASSIST (not IDLE) also with "
    + "combatAssistOnLaunch=false and picks the next NPC; unarmed -> IDLE as before; hold disarms", () => {
    const w = withAuto(fakeWorld({ config: { combatAssistOnLaunch: false } }));
    const twin = twinEntity(4200000000000076);
    w.add(rat(RAT, { distToHost: 3000 }));
    w.add(rat(RAT2, { distToHost: 5000 }));
    const { rec, out } = deploy(w, 551, twin, { order: { targetId: RAT, source: "window" } });
    assert.deepStrictEqual([out, w.tasks.view(551).sub], [{ ok: true, task: "ATTACK" }, "ATTACK"]);
    w.killOn = 1;
    step(w, rec, twin, 1000);
    assert.strictEqual(w.scene.entities.has(RAT), false);
    assert.deepStrictEqual([w.tasks.view(551).sub, w.tasks.view(551).targetId], ["ASSIST", null]);
    w.killOn = null;
    w.sim += DURATION;
    step(w, rec, twin, 1000 + w.config.combatReacquireMs);
    assert.deepStrictEqual([w.tasks.view(551).targetId, counters(w)["combat.assist.auto"]], [RAT2, 1]);
    assert.deepStrictEqual(w.fired.map((f) => f[2]), [RAT, RAT2]);
    assert.strictEqual(w.tasks.order(rec, null, "hold", { scene: w.scene, record: rec }).ok, true);
    assert.deepStrictEqual([w.tasks.context(551).combat.auto, w.tasks.view(551).wait], [false, null]);

    const u = withAuto(fakeWorld({ config: { combatAssistOnLaunch: false, combatAutoTargetEnabled: false } }));
    const ut = twinEntity(4200000000000077);
    u.add(rat(RAT));
    const ud = deploy(u, 552, ut, { order: { targetId: RAT, source: "window" } });
    u.killOn = 1;
    step(u, ud.rec, ut, 1000);
    assert.strictEqual(u.tasks.view(552).sub, "IDLE", "without the auto target as before");
  });

  test("AT4 two twins of one pilot in one tick -> one scan; combatAutoScansPerTick=1 and two pilots "
    + "-> the second deferred, it picks next tick; no candidate -> view wait NO_TARGET and the listWing row refusal "
    + "NO_TARGET", () => {
    const w = withAuto(fakeWorld());
    w.add(rat(RAT, { distToHost: 3000 }));
    const a = twinEntity(4200000000000080);
    const b = twinEntity(4200000000000081);
    const ra = deploy(w, 561, a, { order: { source: "window" } });
    const rb = deploy(w, 562, b, { order: { source: "window" } });
    step(w, ra.rec, a, 1000);
    step(w, rb.rec, b, 1000);
    assert.deepStrictEqual([w.autoCalls.length, w.tasks.view(561).targetId, w.tasks.view(562).targetId],
      [1, RAT, RAT]);

    const v = withAuto(fakeWorld({ config: { combatAutoScansPerTick: 1 } }));
    v.add(rat(RAT, { distToHost: 3000 }));
    const host2 = v.add({ itemID: HOST + 1, activeModuleEffects: new Map() });
    const p1 = twinEntity(4200000000000083);
    const p2 = twinEntity(4200000000000084);
    const r1 = deploy(v, 571, p1, { order: { source: "window" } });
    const r2 = deploy(v, 572, p2, { order: { source: "window" } });
    const step2 = (nowMs) => v.tasks.step(r2.rec, null, { twin: p2, host: host2, nowMs, scene: v.scene });
    step(v, r1.rec, p1, 1000);
    step2(1000);
    assert.deepStrictEqual([counters(v)["combat.auto.scan"], counters(v)["combat.auto.scan.deferred"],
      v.tasks.view(572).targetId, counters(v)["combat.assist.auto"]], [1, 1, null, 1]);
    step2(1001);
    assert.deepStrictEqual([counters(v)["combat.auto.scan"], v.tasks.view(572).targetId], [2, RAT]);

    const e = withAuto(fakeWorld({ weapons: (twin) => ((twin.spec && twin.spec.nativeCargoItems) || [])
      .map((row, i) => ({ moduleId: row.moduleID, flagId: 27 + i, family: "hybridTurret", needsAmmo: true,
        chargeItemId: row.itemID, chargeQuantity: row.quantity })) }));
    const t = fixtures.setup({ config: { combatEnabled: true }, taskReady: () => true,
      taskEngines: { attack: e.engine } });
    t.adapter.readFit = (id) => [
      { itemID: id * 10, typeID: 3146, flagID: 27, categoryID: 7 },
      { itemID: id * 10 + 1, typeID: 230, flagID: 27, categoryID: 8, quantity: 40 },
    ];
    const host = t.w.scene.entities.get(fixtures.HOST);
    host.activeModuleEffects = new Map();
    e.host = host;
    try {
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "launch", { commandId: "c" }).ok, true);
      const row = () => t.svc.listWing(fixtures.CHAR).ships.find((s) => s.shipItemId === 501);
      const before = row().refusal;
      assert.notStrictEqual(before, "NO_TARGET");
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "attack", { source: "window" }).ok, true);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual([row().refusal, row().taskSub, counters(e)["combat.assist.none"] > 0],
        ["NO_TARGET", "ASSIST", true]);
      t.w.scene.entities.set(RAT, rat());
      t.clock.t += e.config.combatReacquireMs;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual([row().refusal, row().targetId], [before, RAT]);
    } finally {
      fixtures.cleanup(t.dir);
    }
  });

  test("FM-W1 (formations) ctx.formation true, the target out of optimal + falloff: controlsMovement "
    + "false, no approach/stop, no volley, no combat.approach.timeout after combatApproachTimeoutMs (the target "
    + "stays); the target in range -> a volley and still controlsMovement false, no movement order", () => {
    const w = fakeWorld();
    const twin = twinEntity(4200000000000010);
    const target = w.add(rat(RAT, { distToTwin: 20000 }));
    const { rec } = deploy(w, 501, twin, { order: { targetId: RAT } });
    const fstep = (nowMs) => w.tasks.step(rec, null, { twin, host: w.host, nowMs, scene: w.scene, formation: true });
    const moves = () => w.orders.filter((o) => o[0] === "approach" || o[0] === "stop");
    assert.deepStrictEqual(fstep(1000), { controlsMovement: false });
    w.sim += w.config.combatApproachTimeoutMs + w.config.combatApproachRetuneMs;
    assert.deepStrictEqual(fstep(2000), { controlsMovement: false });
    w.sim += w.config.combatApproachTimeoutMs;
    assert.deepStrictEqual(fstep(3000), { controlsMovement: false });
    assert.deepStrictEqual(moves(), [], "no approach, no stop");
    assert.strictEqual(w.fired.length, 0, "out of range: no volley");
    assert.strictEqual(counters(w)["combat.approach.timeout"] || 0, 0);
    assert.deepStrictEqual([w.tasks.view(501).sub, w.tasks.view(501).targetId], ["ATTACK", RAT], "the target stays");
    assert.ok(w.orders.some((o) => o[0] === "lock"), "the lock is taken as today");
    target.distToTwin = 6000;
    w.sim += DURATION;
    assert.deepStrictEqual(fstep(4000), { controlsMovement: false });
    assert.strictEqual(w.fired.length, 1, "in range: a volley");
    assert.deepStrictEqual(moves(), [], "in range: no stop either");
  });

  test("FM-W2 (formations) the same scene without ctx.formation and with formation false: the sequence "
    + "of today - approach, controlsMovement true, combat.approach.timeout, ASSIST", () => {
    const run = (extra) => {
      const w = fakeWorld();
      const twin = twinEntity(4200000000000010);
      w.add(rat(RAT, { distToTwin: 20000 }));
      const { rec } = deploy(w, 501, twin, { order: { targetId: RAT } });
      const results = [];
      for (let i = 0; i < 3; i += 1) {
        results.push(w.tasks.step(rec, null, { twin, host: w.host, nowMs: 1000 + i * 1000, scene: w.scene, ...extra }));
        w.sim += w.config.combatApproachTimeoutMs;
      }
      return { results, orders: w.orders, timeouts: counters(w)["combat.approach.timeout"], fired: w.fired.length,
        view: w.tasks.view(501) };
    };
    const today = run({});
    assert.deepStrictEqual(run({ formation: false, formationSlot: null }), today);
    assert.deepStrictEqual(today.results[0], { controlsMovement: true });
    assert.deepStrictEqual(today.orders[0], ["approach", 4200000000000010, RAT,
      Math.min(5000, config().combatOrbitMaxMeters)]);
    assert.deepStrictEqual([today.timeouts, today.fired, today.view.sub, today.view.targetId], [1, 0, "ASSIST", null]);
  });
};

module.exports.fixtures = { fakeWorld, twinEntity, record, rat, turrets, DURATION, HOST, OWNER };
