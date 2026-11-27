"use strict";

const assert = require("node:assert");
const { WRAPPED, createSceneGuard, installSceneGuardFromGame } = require("../../lib/adapter/sceneGuard");
const { symbolPresent } = require("../../lib/adapter/index");

const TWIN = 4200000000000001;
const FOREIGN = 1000000400;

function fakeSceneClass(calls) {
  class SolarSystemScene {}
  Object.defineProperty(SolarSystemScene.prototype, "refreshShipEntityDerivedState", {
    value: function refreshShipEntityDerivedState(entityOrID, options = {}) {
      calls.push([this, entityOrID, options]);
      return { success: true, data: { maxVelocity: 100 } };
    },
    enumerable: false, writable: true, configurable: true,
  });
  return SolarSystemScene;
}

function fakeWing(opts = {}) {
  const notes = [];
  return {
    notes,
    twinCalls: 0,
    liveTwinCount: () => (opts.empty ? 0 : 1),
    twinOf(entityOrID) {
      this.twinCalls += 1;
      if (opts.throws) throw new Error("boom");
      const id = entityOrID && typeof entityOrID === "object" ? entityOrID.itemID : entityOrID;
      return id === TWIN ? { shipItemId: 501, ownerCharacterId: 90000001, twinEntityId: TWIN } : null;
    },
    noteDerivedGuard: (kind) => notes.push(kind),
  };
}

module.exports = ({ test }) => {
  test("SG1 twin -> original not called, {success:true, data:{shipWingSkipped:true}}; foreign ship -> original with "
    + "the same this/args and its result; no twins -> twinOf not read; twinOf throws -> original + derivedError", () => {
    const calls = [];
    const Scene = fakeSceneClass(calls);
    const wing = fakeWing();
    assert.deepStrictEqual(createSceneGuard({ proto: Scene.prototype, wing }).install(), { ok: true });
    const scene = new Scene();
    assert.deepStrictEqual(scene.refreshShipEntityDerivedState({ itemID: TWIN, kind: "ship" }),
      { success: true, data: { shipWingSkipped: true } });
    assert.deepStrictEqual(scene.refreshShipEntityDerivedState(TWIN), { success: true, data: { shipWingSkipped: true } });
    assert.strictEqual(calls.length, 0, "the vendor never rebuilt the twin");
    const opts = { session: null };
    const out = scene.refreshShipEntityDerivedState(FOREIGN, opts);
    assert.deepStrictEqual(out, { success: true, data: { maxVelocity: 100 } });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], scene, "same this");
    assert.strictEqual(calls[0][1], FOREIGN);
    assert.strictEqual(calls[0][2], opts, "same options object");
    assert.deepStrictEqual(wing.notes, ["skipped", "skipped"]);

    const emptyCalls = [];
    const Empty = fakeSceneClass(emptyCalls);
    const empty = fakeWing({ empty: true });
    createSceneGuard({ proto: Empty.prototype, wing: empty }).install();
    new Empty().refreshShipEntityDerivedState(TWIN);
    assert.deepStrictEqual([emptyCalls.length, empty.twinCalls], [1, 0], "fast path: no twin lookup");

    const errCalls = [];
    const Broken = fakeSceneClass(errCalls);
    const broken = fakeWing({ throws: true });
    createSceneGuard({ proto: Broken.prototype, wing: broken }).install();
    assert.deepStrictEqual(new Broken().refreshShipEntityDerivedState(TWIN), { success: true, data: { maxVelocity: 100 } });
    assert.deepStrictEqual([errCalls.length, broken.notes], [1, ["error"]], "fail-open to the vendor");
  });

  test("SG2: second install refused (GUARD_ALREADY_INSTALLED, as lossHook), also from the same guard "
    + "chain: a wrapper found below us is called once (foreign) or never (twin), a "
    + "wrapper put over us still reaches us; descriptor stays writable+configurable", () => {
    const calls = [];
    const Scene = fakeSceneClass(calls);
    const proto = Scene.prototype;
    const vendor = proto.refreshShipEntityDerivedState;
    let below = 0;
    const mark = Symbol.for("otherMod.mark");
    proto.refreshShipEntityDerivedState = function otherMod(...args) {
      below += 1;
      return vendor.apply(this, args);
    };
    proto.refreshShipEntityDerivedState[mark] = true;
    const wing = fakeWing();
    const guard = createSceneGuard({ proto, wing });
    assert.deepStrictEqual(guard.install(), { ok: true });
    const ours = proto.refreshShipEntityDerivedState;
    assert.strictEqual(ours[WRAPPED], true);
    assert.strictEqual(ours[mark], true, "symbols of the predecessor kept");
    const second = createSceneGuard({ proto, wing: fakeWing() });
    assert.deepStrictEqual(second.install(), { ok: false, reason: "GUARD_ALREADY_INSTALLED" });
    assert.strictEqual(second.isActive(), false);
    assert.deepStrictEqual(guard.install(), { ok: false, reason: "GUARD_ALREADY_INSTALLED" }, "same guard twice");
    assert.strictEqual(proto.refreshShipEntityDerivedState, ours, "no second layer");
    const d = Object.getOwnPropertyDescriptor(proto, "refreshShipEntityDerivedState");
    assert.deepStrictEqual([d.writable, d.configurable, d.enumerable], [true, true, false]);

    let above = 0;
    proto.refreshShipEntityDerivedState = function laterMod(...args) {
      above += 1;
      return ours.apply(this, args);
    };
    const scene = new Scene();
    scene.refreshShipEntityDerivedState(FOREIGN);
    assert.deepStrictEqual([above, below, calls.length], [1, 1, 1]);
    assert.strictEqual(scene.refreshShipEntityDerivedState(TWIN).data.shipWingSkipped, true);
    assert.deepStrictEqual([above, below, calls.length], [2, 1, 1]);
    guard.uninstall();
    scene.refreshShipEntityDerivedState(TWIN);
    assert.deepStrictEqual([above, below, calls.length], [3, 2, 2], "uninstalled under another wrap = pass-through");
  });

  test("SG3 loader entry: probe `tasks` off -> probe_tasks_unavailable; on -> SolarSystemScene through requireGame; "
    + "probe kind exportClassPrototypeMethod reads exports[exportName].prototype", () => {
    const Scene = fakeSceneClass([]);
    const wing = fakeWing();
    const game = (available, loaded) => ({
      isConsumerAvailable: (name) => available && name === "tasks",
      requireGame: (rel) => (rel === "space/runtime/solarSystemScene" ? loaded : { ok: false, reason: "x" }),
    });
    assert.deepStrictEqual(installSceneGuardFromGame(game(false, null), { wing }),
      { ok: false, reason: "probe_tasks_unavailable" });
    assert.deepStrictEqual(installSceneGuardFromGame(game(true, { ok: false, reason: "not_booted" }), { wing }),
      { ok: false, reason: "require_failed:not_booted" });
    assert.deepStrictEqual(installSceneGuardFromGame(game(true, { ok: true, exports: {} }), { wing }),
      { ok: false, reason: "GUARD_SEAM_UNAVAILABLE" });
    const ok = installSceneGuardFromGame(game(true, { ok: true, exports: { SolarSystemScene: Scene } }), { wing });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(Scene.prototype.refreshShipEntityDerivedState[WRAPPED], true);
    assert.deepStrictEqual(installSceneGuardFromGame(game(true, { ok: true, exports: { SolarSystemScene: Scene } }),
      { wing }), { ok: false, reason: "GUARD_ALREADY_INSTALLED" });

    const sym = { name: "refreshShipEntityDerivedState", kind: "exportClassPrototypeMethod",
      exportName: "SolarSystemScene" };
    assert.strictEqual(symbolPresent({ SolarSystemScene: Scene }, sym), true);
    assert.strictEqual(symbolPresent({ SolarSystemScene: Scene }, { ...sym, name: "nope" }), false);
    assert.strictEqual(symbolPresent({}, sym), false);
    assert.strictEqual(symbolPresent({ SolarSystemScene: {} }, sym), false);
  });
};
