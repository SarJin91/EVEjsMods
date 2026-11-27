"use strict";

const assert = require("node:assert");
const { createPropAccess, PROP_ACCESS_COUNTER_NAMES } = require("../../lib/adapter/propAccess");

const TWIN = 4200000000000001;
const OWNER = 90000001;
const K = Object.freeze({
  EFFECT_ID_AFTERBURNER: 6731, EFFECT_ID_MICROWARPDRIVE: 6730,
  PROPULSION_EFFECT_AFTERBURNER: "moduleBonusAfterburner", PROPULSION_EFFECT_MICROWARPDRIVE: "moduleBonusMicrowarpdrive",
  PROPULSION_GUID_BY_EFFECT: Object.freeze({ moduleBonusAfterburner: "effects.Afterburner",
    moduleBonusMicrowarpdrive: "effects.MicroWarpDrive" }),
});
const MOTION = Object.freeze(["mass", "inertia", "maxVelocity", "alignTime", "agilitySeconds", "maxAccelerationTime",
  "radius"]);
const MWD_RECORD = Object.freeze({ effectID: 6730, name: "moduleBonusMicrowarpdrive" });
const AB_RECORD = Object.freeze({ effectID: 6731, name: "moduleBonusAfterburner" });

function fakeVendor() {
  const v = { attrs: [], passiveOpts: [] };
  v.deps = {
    constants: () => K,
    getPropulsionModuleRuntimeAttributes: (owner, module, opts) => {
      v.attrs.push({ owner, module, opts });
      return { capNeed: 150, durationMs: 10000, speedFactor: 500, speedBoostFactor: 1500000, massAddition: 500000,
        signatureRadiusBonus: 500, maxGroupActive: 1 };
    },
    applyPassiveResourceStateToEntity: (e, st, opts) => {
      v.passiveOpts.push(opts);
      for (const f of ["mass", "inertia", "maxVelocity", "signatureRadius"]) e[f] = st[f];
      e.passiveDerivedState = st;
      if (opts && opts.recalculateSpeedFraction === true) e.speedFraction = 0;
      return e;
    },
    applyPropulsionEffectStateToEntity: (e, es) => {
      if (es.effectName !== K.PROPULSION_EFFECT_AFTERBURNER && es.effectName !== K.PROPULSION_EFFECT_MICROWARPDRIVE) {
        return e;
      }
      const p = e.passiveDerivedState;
      const mass = p.mass + es.massAddition;
      e.mass = mass;
      e.maxVelocity = p.maxVelocity * (1 + (0.01 * es.speedFactor * es.speedBoostFactor) / mass);
      if (es.effectName === K.PROPULSION_EFFECT_MICROWARPDRIVE) {
        e.signatureRadius = p.signatureRadius * (1 + es.signatureRadiusBonus / 100);
      }
      return e;
    },
    buildRuntimeShipItemFromEntity: (e) => (e && e.kind === "ship" ? { itemID: e.itemID, typeID: e.typeID } : null),
  };
  return v;
}

function fakeScene(wait) {
  const s = { log: [], queued: [], prime: [], fx: [] };
  s.movementChangesWait = () => wait;
  s.captureShipMotion = (e) => Object.fromEntries(MOTION.map((f) => [f, e[f]]));
  s.adoptDerivedShipState = (entity, derived) => {
    s.log.push("adopt");
    for (const [k, val] of Object.entries(derived)) {
      if (!MOTION.includes(k) && k !== "speedFraction") entity[k] = val;
    }
  };
  s.queueShipMotionChange = (entity, after, onApplied) => {
    s.log.push("queue");
    s.queued.push({ entity, after, onApplied });
    return true;
  };
  s.dropPendingShipMotion = () => s.log.push("drop");
  s.broadcastShipPrimeUpdates = (entity, opts) => {
    s.log.push("prime");
    s.prime.push(opts);
  };
  s.broadcastSpecialFx = (id, guid, o) => s.fx.push([id, guid, o.start, o.active]);
  s.activatePropulsionModule = () => { throw new Error("activatePropulsionModule must never run for a twin"); };
  s.flush = () => {
    for (const q of s.queued.splice(0)) {
      const before = s.captureShipMotion(q.entity);
      for (const f of MOTION) q.entity[f] = q.after[f];
      q.onApplied(before);
    }
  };
  return s;
}

function makeTwin() {
  const p1 = { mass: 1000000, inertia: 0.5, maxVelocity: 200, signatureRadius: 40, attributes: { tags: ["wh", "mod:11"] } };
  const effects = new Map();
  let sets = 0;
  effects.set = () => { sets += 1; return effects; };
  return { itemID: TWIN, kind: "ship", typeID: 24690, mass: 1000000, inertia: 0.5, maxVelocity: 200,
    signatureRadius: 40, radius: 300, speedFraction: 0.75, passiveDerivedState: p1,
    fittedItems: [{ itemID: 16, typeID: 35660, flagID: 16 }, { itemID: 17, typeID: 12076, flagID: 17 }],
    skillMap: new Map([[3449, 5]]), activeModuleEffects: effects, setsOf: () => sets };
}

function config(extra = {}) {
  return { followRetuneMs: 1000, activeFxEnabled: true, ...extra };
}

module.exports = ({ test }) => {
  test("PA1 attrsOf: getPropulsionModuleRuntimeAttributes(owner, the twin's module, {skillMap, shipItem: the twin's "
    + "hull, fittedItems, activeModuleContexts: []}); effectName/effectID = the vendor constants (MWD and AB); no "
    + "module or an unknown effect -> ERROR", () => {
    const v = fakeVendor();
    const access = createPropAccess({ deps: v.deps, config: config() });
    const twin = makeTwin();
    const got = access.attrsOf(twin, { moduleId: 16, flagId: 16, effectRecord: MWD_RECORD }, OWNER);
    assert.strictEqual(got.ok, true, JSON.stringify(got));
    assert.deepStrictEqual([got.state.effectName, got.state.effectID, got.state.guid, got.state.moduleID,
      got.state.durationMs], [K.PROPULSION_EFFECT_MICROWARPDRIVE, 6730, "effects.MicroWarpDrive", 16, 10000]);
    const call = v.attrs[0];
    assert.deepStrictEqual([call.owner, call.module, call.opts.shipItem, call.opts.fittedItems === twin.fittedItems,
      call.opts.skillMap === twin.skillMap, call.opts.activeModuleContexts],
    [OWNER, twin.fittedItems[0], { itemID: TWIN, typeID: 24690 }, true, true, []]);
    const ab = access.attrsOf(twin, { moduleId: 17, flagId: 17, effectRecord: AB_RECORD }, OWNER);
    assert.deepStrictEqual([ab.state.effectName, ab.state.guid], [K.PROPULSION_EFFECT_AFTERBURNER, "effects.Afterburner"]);
    assert.deepStrictEqual(access.attrsOf(twin, { moduleId: 99, effectRecord: MWD_RECORD }, OWNER),
      { ok: false, reason: "ERROR" });
    assert.deepStrictEqual(access.attrsOf(twin, { moduleId: 16, effectRecord: { effectID: 27 } }, OWNER),
      { ok: false, reason: "ERROR" });
    assert.ok(PROP_ACCESS_COUNTER_NAMES.every((n) => n.startsWith("prop.")));
  });

  test("PA2 apply: wait=true -> stand-in, adopt, queueShipMotionChange once with a callback that calls "
    + "broadcastShipPrimeUpdates(previousState: inertia, mass, maxVelocity); wait=false -> dropPendingShipMotion + "
    + "broadcastShipPrimeUpdates(previousState = before); on = passive x vendor multiplier, MWD signature; off = P1; "
    + "speedFraction unchanged; never activatePropulsionModule or activeModuleEffects.set; FX on/off", () => {
    const v = fakeVendor();
    const access = createPropAccess({ deps: v.deps, config: config() });
    const twin = makeTwin();
    const state = access.attrsOf(twin, { moduleId: 16, flagId: 16, effectRecord: MWD_RECORD }, OWNER).state;
    const ON = { mass: 1500000, maxVelocity: 1200, signatureRadius: 240 };
    const P1 = { mass: 1000000, maxVelocity: 200, signatureRadius: 40 };
    const pick = (e) => ({ mass: e.mass, maxVelocity: e.maxVelocity, signatureRadius: e.signatureRadius });

    const waiting = fakeScene(true);
    const on = access.apply(waiting, twin, state, null);
    assert.deepStrictEqual(on, { ok: true, durationMs: 1000, data: { on: true } });
    assert.deepStrictEqual(waiting.log, ["adopt", "queue"]);
    assert.strictEqual(twin.maxVelocity, 200, "the motion values wait for the queue");
    assert.strictEqual(twin.signatureRadius, 240, "the rest is adopted at once (MWD signature)");
    waiting.flush();
    assert.deepStrictEqual(pick(twin), ON);
    assert.deepStrictEqual(waiting.log, ["adopt", "queue", "prime"]);
    assert.deepStrictEqual(waiting.prime[0], { previousState: { inertia: 0.5, mass: 1000000, maxVelocity: 200 } });
    assert.deepStrictEqual(waiting.fx, [[TWIN, "effects.MicroWarpDrive", true, true]]);

    const direct = fakeScene(false);
    const off = access.apply(direct, twin, null, state);
    assert.deepStrictEqual(off, { ok: true, durationMs: 1000, data: { on: false } });
    assert.deepStrictEqual(direct.log, ["drop", "prime"]);
    assert.deepStrictEqual(pick(twin), P1, "off = the values of twin.passiveDerivedState (P1)");
    assert.deepStrictEqual(direct.prime[0], { previousState: { inertia: 0.5, mass: 1500000, maxVelocity: 1200 } });
    assert.deepStrictEqual(direct.fx, [[TWIN, "effects.MicroWarpDrive", false, false]]);
    assert.strictEqual(access.apply(direct, twin, state, null).ok, true);
    assert.deepStrictEqual(pick(twin), ON);

    for (const p of [...waiting.prime, ...direct.prime]) {
      assert.deepStrictEqual(Object.keys(p.previousState).sort(), ["inertia", "mass", "maxVelocity"]);
    }
    assert.ok(v.passiveOpts.every((o) => o.recalculateSpeedFraction === false), JSON.stringify(v.passiveOpts));
    assert.strictEqual(twin.speedFraction, 0.75);
    assert.strictEqual(twin.setsOf(), 0, "the effect is never in twin.activeModuleEffects");
    assert.strictEqual(twin.passiveDerivedState.attributes.tags.join(","), "wh,mod:11", "P1 kept");

    assert.strictEqual(access.apply(direct, twin, null, state).ok, true);
    assert.deepStrictEqual(pick(twin), P1);
    const broken = fakeScene(false);
    broken.broadcastShipPrimeUpdates = () => { throw new Error("boom"); };
    assert.deepStrictEqual(access.apply(broken, twin, state, null), { ok: false, reason: "ERROR", retryMs: 1000 });
    assert.deepStrictEqual(pick(twin), ON, "derived === twin: the MWD values are written before the throw");
    assert.deepStrictEqual(broken.fx, [], "no FX on after a throw");
    assert.strictEqual(access.apply(direct, twin, null, state).ok, true);
    assert.deepStrictEqual(pick(twin), P1, "apply(null) after the throw: P1 (speed and signatureRadius)");
    const brokenWait = fakeScene(true);
    brokenWait.queueShipMotionChange = () => { throw new Error("boom"); };
    assert.strictEqual(access.apply(brokenWait, twin, state, null).ok, false);
    assert.deepStrictEqual(pick(twin), { ...P1, signatureRadius: 240 },
      "stand-in: the MWD signature is adopted before the throw, the motion values are not");
    assert.strictEqual(access.apply(direct, twin, null, state).ok, true);
    assert.deepStrictEqual(pick(twin), P1);
    const early = fakeScene(false);
    early.captureShipMotion = () => { throw new Error("boom"); };
    assert.deepStrictEqual(access.apply(early, twin, state, null), { ok: false, reason: "ERROR", retryMs: 1000 });
    assert.deepStrictEqual(pick(twin), ON, "derived === twin: written before captureShipMotion");
    assert.strictEqual(access.apply(direct, twin, null, state).ok, true);
    assert.deepStrictEqual(pick(twin), P1);
    const badFx = fakeScene(false);
    badFx.broadcastSpecialFx = () => { throw new Error("fx"); };
    assert.strictEqual(access.apply(badFx, twin, null, state).ok, true);
    assert.strictEqual(access.stats().counters["prop.fx.error"], 1);
    assert.strictEqual(access.apply(direct, { itemID: 1 }, state, null).ok, false);
    const quiet = createPropAccess({ deps: v.deps, config: config({ activeFxEnabled: false }) });
    const silent = fakeScene(false);
    quiet.apply(silent, twin, state, null);
    assert.deepStrictEqual(silent.fx, []);
  });
};

module.exports.fakes = { fakeVendor, fakeScene, makeTwin, config, MWD_RECORD };
