"use strict";

const assert = require("node:assert");
const { WRAPPED, LOSS_TWIN_REMOVED, createLossHook, installLossHookFromGame } = require("../../lib/adapter/lossHook");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const TWIN = 4200000000000001;
const HULL = { itemID: 501, ownerID: 90000001, categoryID: 6, singleton: 1 };

function fakeWing(log) {
  return {
    twins: 1,
    liveTwinCount() { return this.twins; },
    claimTwin: (entity) => (entity.itemID === TWIN ? { shipItemId: 501, ownerCharacterId: 90000001,
      twinEntityId: TWIN } : null),
    beginLoss: (id, opts) => {
      log.push(["beginLoss", id, opts.cause]);
      return { ok: true, persisted: true };
    },
    settleLoss: (id, opts) => {
      log.push(["settleLoss", id, opts.wreckId, opts.vendorChanges.length]);
      return { ok: true, outcome: "HULL_DESTROYED" };
    },
    sweepLossTwin: (id) => {
      log.push(["sweep", id]);
      return { pending: false };
    },
    strays: new Set(),
    takeLossTwin(entity) {
      return this.strays.has(entity.itemID);
    },
    noteLossHookError: (err) => log.push(["hookError", err.message]),
  };
}

function setup(vendor, extra = {}) {
  const log = [];
  const deferred = [];
  const target = { destroyShipEntityWithWreck: vendor(log) };
  const wing = fakeWing(log);
  const adapter = { lossHull: () => HULL, lossAvailable: () => true };
  const hook = createLossHook({ shipDestructionExports: target, wing, adapter, defer: (fn) => deferred.push(fn),
    config: { durableWreck: true, lossSkipInsurance: true, ...extra } });
  const flush = () => deferred.splice(0).forEach((fn) => fn());
  return { log, target, wing, adapter, hook, flush };
}

function okVendor(log) {
  return function vendor(systemID, entity, options) {
    log.push(["vendor", systemID, entity.transient, options]);
    return { success: true, data: { wreck: { itemID: 9001 }, movedChanges: [1, 2], destroyChanges: [3] } };
  };
}

module.exports = ({ test }) => {
  test("LH1 not a twin -> vendor with the same arguments and result; twin -> shipRecord, skipInsurance, transient "
    + "false only during the call (also on throw), settleLoss after success only; chain; mod fault -> vendor with "
    + "the caller's options", () => {
    const t = setup(okVendor);
    assert.deepStrictEqual(t.hook.install(), { ok: true });
    assert.deepStrictEqual(t.hook.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" }, "2nd install = no-op");
    assert.strictEqual(t.target.destroyShipEntityWithWreck[WRAPPED], true);

    const npc = { itemID: 77, kind: "ship", transient: true };
    const opts = { ownerCharacterID: 5 };
    const result = t.target.destroyShipEntityWithWreck(30000142, npc, opts);
    assert.strictEqual(t.log[0][3], opts, "options passed by identity");
    assert.strictEqual(t.log[0][2], true, "an NPC keeps its transient");
    assert.strictEqual(result.data.wreck.itemID, 9001);
    t.wing.twins = 0;
    t.target.destroyShipEntityWithWreck(30000142, { itemID: TWIN, kind: "ship" }, opts);
    assert.strictEqual(t.log[1][3], opts, "fast path: no twin in any scene");
    t.wing.twins = 1;

    t.log.length = 0;
    const twin = { itemID: TWIN, kind: "ship", transient: true };
    const out = t.target.destroyShipEntityWithWreck(30000142, twin, opts);
    assert.deepStrictEqual(t.log.map((e) => e[0]), ["beginLoss", "vendor", "sweep", "settleLoss"]);
    const passed = t.log[1][3];
    assert.strictEqual(passed.shipRecord, HULL);
    assert.deepStrictEqual([passed.skipInsurance, passed.insuranceSuppressedReason, passed.ownerCharacterID],
      [true, "shipWing", 5]);
    assert.strictEqual(opts.shipRecord, undefined, "the caller's object is not changed");
    assert.strictEqual(t.log[1][2], false, "durable wreck: transient false during the vendor call");
    assert.strictEqual(twin.transient, true, "restored");
    assert.deepStrictEqual(t.log[3], ["settleLoss", 501, 9001, 3]);
    assert.strictEqual(out.success, true);

    const failing = setup(() => () => ({ success: false, errorMsg: "WRECK_CREATE_FAILED" }));
    failing.hook.install();
    assert.deepStrictEqual(failing.target.destroyShipEntityWithWreck(1, { itemID: TWIN, kind: "ship" }, {}),
      { success: false, errorMsg: "WRECK_CREATE_FAILED" });
    assert.deepStrictEqual(failing.log.map((e) => e[0]), ["beginLoss"], "no sweep before the caller's fallback");
    failing.flush();
    assert.deepStrictEqual(failing.log.map((e) => e[0]), ["beginLoss", "sweep"], "Swept after the stack");
    const throwing = setup(() => (_s, entity) => {
      assert.strictEqual(entity.transient, false);
      throw new Error("vendor boom");
    });
    throwing.hook.install();
    const twin2 = { itemID: TWIN, kind: "ship", transient: true };
    assert.throws(() => throwing.target.destroyShipEntityWithWreck(1, twin2, {}), /vendor boom/);
    assert.strictEqual(twin2.transient, true, "restored after a throw");
    throwing.flush();
    assert.deepStrictEqual(throwing.log.map((e) => e[0]), ["beginLoss", "sweep"], "Also after a throw");

    const chain = setup(okVendor);
    const foreign = Symbol("other.mod");
    const inner = chain.target.destroyShipEntityWithWreck;
    chain.target.destroyShipEntityWithWreck = function before(...args) {
      chain.log.push(["before"]);
      return inner.apply(this, args);
    };
    chain.target.destroyShipEntityWithWreck[foreign] = 1;
    chain.hook.install();
    assert.strictEqual(chain.target.destroyShipEntityWithWreck[foreign], 1);
    const ours = chain.target.destroyShipEntityWithWreck;
    chain.target.destroyShipEntityWithWreck = function after(...args) {
      chain.log.push(["after"]);
      return ours.apply(this, args);
    };
    chain.target.destroyShipEntityWithWreck(1, { itemID: TWIN, kind: "ship" }, {});
    assert.deepStrictEqual(chain.log.map((e) => e[0]),
      ["after", "beginLoss", "before", "vendor", "sweep", "settleLoss"]);

    const again = setup(okVendor);
    again.hook.install();
    again.wing.strays.add(TWIN);
    assert.deepStrictEqual(again.target.destroyShipEntityWithWreck(1, { itemID: TWIN, kind: "ship" }, {}),
      { success: false, errorMsg: LOSS_TWIN_REMOVED });
    assert.deepStrictEqual(again.log, [], "no beginLoss, no vendor");

    const fault = setup(okVendor);
    fault.wing.claimTwin = () => {
      throw new Error("claim boom");
    };
    fault.hook.install();
    const own = { a: 1 };
    const twin3 = { itemID: TWIN, kind: "ship", transient: true };
    fault.target.destroyShipEntityWithWreck(1, twin3, own);
    assert.deepStrictEqual(fault.log.map((e) => e[0]), ["hookError", "vendor"]);
    assert.strictEqual(fault.log[1][3], own);
    assert.strictEqual(fault.log[1][2], true);

    const noHull = setup(okVendor, { lossSkipInsurance: false, durableWreck: false });
    noHull.adapter.lossHull = () => {
      throw new Error("hull boom");
    };
    noHull.hook.install();
    noHull.target.destroyShipEntityWithWreck(1, { itemID: TWIN, kind: "ship", transient: true }, {});
    const sent = noHull.log.find((e) => e[0] === "vendor");
    assert.deepStrictEqual([sent[3].shipRecord, sent[3].skipInsurance, sent[2]], [undefined, undefined, true]);

    t.hook.uninstall();
    assert.strictEqual(t.target.destroyShipEntityWithWreck[WRAPPED], undefined, "uninstall restores the original");
  });

  test("LH2 installLossHookFromGame: no loss probe / no loss accessors / require failed -> refused, nothing wrapped",
    () => {
    const target = { destroyShipEntityWithWreck() {} };
    const game = (available, loaded) => ({ isConsumerAvailable: (c) => c !== "loss" || available,
      requireGame: () => loaded });
    const live = { lossHull() {}, lossAvailable: () => true };
    const exported = { ok: true, exports: target };
    assert.deepStrictEqual(installLossHookFromGame(game(false, exported), { wing: {}, adapter: live }),
      { ok: false, reason: "probe_loss_unavailable" });
    assert.deepStrictEqual(installLossHookFromGame(game(true, exported),
      { wing: {}, adapter: { lossHull() {}, lossAvailable: () => false } }),
    { ok: false, reason: "loss_accessors_unavailable" });
    assert.deepStrictEqual(installLossHookFromGame(game(true, { ok: false, reason: "x" }), { wing: {}, adapter: live }),
      { ok: false, reason: "require_failed:x" });
    assert.strictEqual(target.destroyShipEntityWithWreck[WRAPPED], undefined);
    const ok = installLossHookFromGame(game(true, { ok: true, exports: target }), { wing: {}, adapter: live });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(target.destroyShipEntityWithWreck[WRAPPED], true);
    const loss = GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.consumer === "loss")
      .map((s) => `${m.path}.${s.name}`));
    assert.deepStrictEqual(loss.sort(), [
      "services/character/characterState.emitItemsChangedBatchForSession",
      "services/character/characterState.getActiveShipRecord",
      "services/inventory/deathItemCustody.destroyItem",
      "services/inventory/itemStore.normalizeShipConditionState",
      "services/inventory/itemStore.updateShipItem",
      "services/killmail/deathOutcomeResolver.resolveLocationDeathOutcome",
      "space/shipDestruction.destroyShipEntityWithWreck",
      "space/worldData.getSolarSystemByID",
    ]);
  });
};
