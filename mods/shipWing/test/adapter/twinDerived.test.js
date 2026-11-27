"use strict";

const assert = require("node:assert");
const { applyDerived } = require("../../lib/adapter/twinDerived");

function fakeScene(wait = false) {
  const s = { log: [] };
  s.movementChangesWait = () => wait;
  s.captureShipMotion = () => ({});
  s.adoptDerivedShipState = (entity, derived) => {
    s.log.push("adopt");
    for (const [k, val] of Object.entries(derived)) entity[k] = val;
  };
  s.queueShipMotionChange = () => {
    s.log.push("queue");
    return true;
  };
  s.dropPendingShipMotion = () => s.log.push("drop");
  s.broadcastShipPrimeUpdates = () => s.log.push("prime");
  return s;
}

function fakeDeps(order) {
  return {
    applyPassiveResourceStateToEntity: (e, st, opts) => {
      order.push(`passive:${opts.recalculateSpeedFraction}`);
      const cs = { ...(e.conditionState || {}) };
      if (st.armorHP && e.armorHP) cs.armorDamage = (cs.armorDamage * e.armorHP) / st.armorHP;
      e.conditionState = cs;
      e.armorHP = st.armorHP;
      e.passiveDerivedState = st;
      return e;
    },
    applyPropulsionEffectStateToEntity: (_e, ps) => order.push(`prop:${ps.effectName}`),
    broadcastDamageStateChange: (scene, e) => order.push(`hp:${e.itemID}`),
  };
}

const twinOf = () => ({ itemID: 4200000000000001, kind: "ship", armorHP: 1000,
  conditionState: { shieldCharge: 1, armorDamage: 0.5 } });

module.exports = ({ test }) => {
  test("TD1 applyDerived: armorDamage changed by the passive state -> broadcastDamageStateChange; the same ratio -> "
    + "none; the optional symbol missing -> no error, hpChanged still reported; propState -> "
    + "applyPropulsionEffectStateToEntity after the passive state; a vendor throw -> ERROR, never out", () => {
    let order = [];
    const twin = twinOf();
    const scene = fakeScene(false);
    const out = applyDerived(scene, twin, { armorHP: 1250 }, null, fakeDeps(order));
    assert.deepStrictEqual(out, { ok: true, hpChanged: true });
    assert.deepStrictEqual(order, ["passive:false", `hp:${twin.itemID}`]);
    assert.strictEqual(twin.conditionState.armorDamage, 0.4);
    assert.deepStrictEqual(scene.log, ["drop", "prime"], "no wait: drop + prime (the motion port)");

    order = [];
    assert.deepStrictEqual(applyDerived(scene, twin, { armorHP: 1250 }, null, fakeDeps(order)),
      { ok: true, hpChanged: false });
    assert.deepStrictEqual(order, ["passive:false"], "the same ratio: no broadcast");

    order = [];
    const noHp = fakeDeps(order);
    delete noHp.broadcastDamageStateChange;
    assert.deepStrictEqual(applyDerived(scene, twinOf(), { armorHP: 2000 }, null, noHp), { ok: true, hpChanged: true });
    assert.deepStrictEqual(order, ["passive:false"]);

    order = [];
    const waiting = fakeScene(true);
    const t2 = twinOf();
    assert.strictEqual(applyDerived(waiting, t2, { armorHP: 1000 }, { effectName: "mwd" }, fakeDeps(order)).ok, true);
    assert.deepStrictEqual(order, ["passive:false", "prop:mwd"], "vendor order passive -> prop");
    assert.deepStrictEqual(waiting.log, ["adopt", "queue"], "the stand-in is adopted, the motion queued");

    const broken = fakeDeps([]);
    broken.applyPassiveResourceStateToEntity = () => {
      throw new Error("boom");
    };
    assert.deepStrictEqual(applyDerived(scene, twinOf(), { armorHP: 1 }, null, broken), { ok: false, reason: "ERROR" });
    assert.deepStrictEqual(applyDerived(scene, twinOf(), null, null, fakeDeps([])), { ok: false, reason: "ERROR" });
  });
};
