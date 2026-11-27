"use strict";

const assert = require("node:assert");
const { WRAPPED, createSalvageHook } = require("../../lib/adapter/salvageHook");

const OWNER = 90000001;
const TWIN = 4200000000000001;
const HOST = 1000000400;
const OTHER = 1000000500;
const WRECK = 4100000000000009;

function twinEntity() {
  return { itemID: TWIN, kind: "ship", typeID: 2998, pilotCharacterID: OWNER, characterID: 0,
    fittedItems: [{ itemID: 77, typeID: 25861, flagID: 27 }], skillMap: new Map([[25863, { skillLevel: 5 }]]) };
}

function setup(opts = {}) {
  const calls = [];
  const salvagerRuntime = {
    resolveSalvagerActivation(args) {
      calls.push({ fn: "activation", self: this, args });
      if (args.effectRecord && args.effectRecord.notSalvager) return { matched: false };
      return { matched: true, success: true, data: { tag: "activation" } };
    },
    executeSalvagerCycle(args) {
      calls.push({ fn: "cycle", self: this, args });
      const cb = args.callbacks;
      if (typeof cb.resolveCharacterID !== "function") return { success: true, data: { vanilla: true } };
      if (args.effectState && args.effectState.miss) return { success: true, data: { targetID: WRECK, salvaged: false } };
      if (args.effectState && args.effectState.stop) return { success: false, stopReason: args.effectState.stop };
      return { success: false, stopReason: "target", data: { salvaged: true, char: cb.resolveCharacterID(args.entity),
        ship: cb.getEntityRuntimeShipItem(args.entity),
        fit: cb.getEntityRuntimeFittedItems(args.entity), skills: cb.getEntityRuntimeSkillMap(args.entity),
        session: cb.resolveSession(args.entity), locked: cb.isEntityLockedTarget(args.entity, WRECK) } };
    },
  };
  const twin = twinEntity();
  const wing = {
    liveTwinCount: () => 1,
    twinOf: (e) => {
      if (opts.twinOfThrows) throw new Error("boom");
      return e && e.itemID === TWIN ? { shipItemId: 501, ownerCharacterId: OWNER, twinEntityId: TWIN } : null;
    },
    twinTaskContext: (e) => (e && e.itemID === TWIN ? { task: opts.task || "SALVAGE",
      salvage: { hostShipId: opts.noHost ? 0 : HOST } } : null),
  };
  const hook = createSalvageHook({ salvagerRuntime, wing,
    deps: { buildRuntimeShipItemFromEntity: (e) => ({ itemID: e.itemID, typeID: e.typeID, tag: "twinHull" }) } });
  return { calls, salvagerRuntime, twin, hook };
}

function sceneWith(entities) {
  const byId = new Map(entities.map((e) => [e.itemID, e]));
  return { getEntityByID: (id) => byId.get(id) || null };
}

function vendorCallbacks(seen) {
  const tagOf = (e) => (e && e.itemID === HOST ? "host" : `entity:${e && e.itemID}`);
  return {
    getEntityRuntimeShipItem: (e) => { seen.push(["ship", tagOf(e)]); return { itemID: e.itemID, of: tagOf(e) }; },
    getEntityRuntimeFittedItems: (e) => { seen.push(["fit", tagOf(e)]); return [tagOf(e)]; },
    getEntityRuntimeSkillMap: (e) => { seen.push(["skills", tagOf(e)]); return new Map([[tagOf(e), 1]]); },
    resolveSession: (e) => { seen.push(["session", tagOf(e)]); return { tag: tagOf(e) }; },
    isEntityLockedTarget: (e, id) => { seen.push(["locked", tagOf(e), id]); return true; },
    random: () => 0.5,
  };
}

module.exports = ({ test }) => {
  test("SH1 not a twin: both wrappers pass this, the same args object and the result through 1:1; the mark is set; "
    + "a second install is refused", () => {
    const { calls, salvagerRuntime, hook } = setup();
    const before = { a: salvagerRuntime.resolveSalvagerActivation, c: salvagerRuntime.executeSalvagerCycle };
    assert.deepStrictEqual(hook.install(), { ok: true, installed: ["resolveSalvagerActivation", "executeSalvagerCycle"] });
    assert.strictEqual(salvagerRuntime.resolveSalvagerActivation[WRAPPED], true);
    assert.deepStrictEqual(hook.install(), { ok: false, reason: "ALREADY" });
    const other = { itemID: OTHER, kind: "ship", characterID: OWNER };
    const args = { scene: sceneWith([]), entity: other, shipItem: { itemID: OTHER }, options: { targetID: WRECK } };
    const out = salvagerRuntime.resolveSalvagerActivation(args);
    assert.deepStrictEqual(out, { matched: true, success: true, data: { tag: "activation" } });
    assert.strictEqual(calls[0].args, args, "the same args object");
    assert.strictEqual(calls[0].self, salvagerRuntime, "the same this");
    const cycleArgs = { scene: sceneWith([]), entity: other, effectState: {}, callbacks: vendorCallbacks([]) };
    salvagerRuntime.executeSalvagerCycle(cycleArgs);
    assert.strictEqual(calls[1].args, cycleArgs);
    hook.uninstall();
    assert.strictEqual(salvagerRuntime.resolveSalvagerActivation, before.a);
    assert.strictEqual(salvagerRuntime.executeSalvagerCycle, before.c);
  });

  test("SH2 a twin: the activation gets the twin's hull, fit, skillMap, no active contexts and the owner as "
    + "options.characterID; the cycle callbacks of cargo/session are called with the HOST entity, the lock check "
    + "with the twin", () => {
    const { calls, salvagerRuntime, twin, hook } = setup();
    hook.install();
    const host = { itemID: HOST, kind: "ship", characterID: OWNER };
    const scene = sceneWith([twin, host]);
    salvagerRuntime.resolveSalvagerActivation({ scene, entity: twin, shipItem: { itemID: 999, tag: "ownerActive" },
      fittedItems: ["ownerFit"], skillMap: new Map(), activeModuleContexts: ["x"], options: { targetID: WRECK } });
    const a = calls[0].args;
    assert.deepStrictEqual(a.shipItem, { itemID: TWIN, typeID: 2998, tag: "twinHull" });
    assert.strictEqual(a.fittedItems, twin.fittedItems);
    assert.strictEqual(a.skillMap, twin.skillMap);
    assert.deepStrictEqual(a.activeModuleContexts, []);
    assert.deepStrictEqual(a.options, { targetID: WRECK, characterID: OWNER });

    const seen = [];
    const out = salvagerRuntime.executeSalvagerCycle({ scene, entity: twin, effectState: { targetID: WRECK },
      nowMs: 5, callbacks: vendorCallbacks(seen) });
    assert.deepStrictEqual([out.success, out.stopReason, out.data.salvaged], [false, "target", true]);
    assert.strictEqual(out.data.char, OWNER);
    assert.deepStrictEqual(out.data.ship, { itemID: HOST, of: "host" });
    assert.deepStrictEqual(out.data.fit, ["host"]);
    assert.deepStrictEqual(out.data.session, { tag: "host" });
    assert.deepStrictEqual(seen, [["ship", "host"], ["fit", "host"], ["skills", "host"], ["session", "host"],
      ["locked", `entity:${TWIN}`, WRECK]]);
    assert.strictEqual(calls[1].args.callbacks.random(), 0.5, "the other vendor callbacks stay");
    assert.strictEqual(hook.stats().counters["salvage.cycle.ok"], 1, "the salvaged wreck counts");
    const miss = salvagerRuntime.executeSalvagerCycle({ scene, entity: twin, effectState: { targetID: WRECK, miss: true },
      nowMs: 6, callbacks: vendorCallbacks([]) });
    assert.deepStrictEqual(miss, { success: true, data: { targetID: WRECK, salvaged: false } });
    assert.strictEqual(hook.stats().counters["salvage.cycle.ok"], 1, "a miss is no salvage.cycle.ok");
    assert.strictEqual(hook.stats().counters["salvage.cycle.miss"], 1, "A miss has its own counter");
  });

  test("SH3 a twin without its host entity -> {success:false, stopReason:'cargo'} (vendor not called); a throw of "
    + "twinOf -> fail-open (the vendor 1:1) and salvage.hook.error", () => {
    const noHost = setup({ noHost: true });
    noHost.hook.install();
    const scene = sceneWith([noHost.twin]);
    assert.deepStrictEqual(noHost.salvagerRuntime.executeSalvagerCycle({ scene, entity: noHost.twin,
      effectState: {}, callbacks: vendorCallbacks([]) }), { success: false, stopReason: "cargo" });
    assert.strictEqual(noHost.calls.length, 0);
    assert.strictEqual(noHost.hook.stats().counters["salvage.cycle.noHost"], 1, "Counted, not silent");

    const broken = setup({ twinOfThrows: true });
    broken.hook.install();
    const args = { scene, entity: broken.twin, shipItem: { itemID: 1 }, options: {} };
    assert.deepStrictEqual(broken.salvagerRuntime.resolveSalvagerActivation(args),
      { matched: true, success: true, data: { tag: "activation" } });
    assert.strictEqual(broken.calls[0].args, args, "fail-open: the vendor with the same args");
    assert.strictEqual(broken.hook.stats().counters["salvage.hook.error"], 1);
  });

  test("SH4 every twin cycle result counts: vendor stops cargo/range/target/module and an "
    + "unknown one -> salvage.cycle.refused.<reason>|other, the result 1:1", () => {
    const { salvagerRuntime, twin, hook } = setup();
    hook.install();
    const scene = sceneWith([twin, { itemID: HOST, kind: "ship", characterID: OWNER }]);
    for (const stop of ["cargo", "range", "target", "module", "weird"]) {
      const out = salvagerRuntime.executeSalvagerCycle({ scene, entity: twin, effectState: { targetID: WRECK, stop },
        nowMs: 7, callbacks: vendorCallbacks([]) });
      assert.deepStrictEqual(out, { success: false, stopReason: stop });
    }
    const c = hook.stats().counters;
    assert.deepStrictEqual(["cargo", "range", "target", "module", "other"].map((r) => c[`salvage.cycle.refused.${r}`]),
      [1, 1, 1, 1, 1]);
    assert.strictEqual(c["salvage.cycle.ok"], 0);
  });

  test("SH5 a twin's Salvager outside the task SALVAGE (a path other than the engine) is "
    + "refused at activation and at the cycle boundary (salvage.activate.blocked); its other modules pass", () => {
    const { calls, salvagerRuntime, twin, hook } = setup({ task: "HOLD" });
    hook.install();
    const scene = sceneWith([twin]);
    const args = { scene, entity: twin, shipItem: { itemID: 999 }, effectRecord: { name: "salvaging" },
      options: { targetID: WRECK } };
    assert.deepStrictEqual(salvagerRuntime.resolveSalvagerActivation(args),
      { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" });
    assert.strictEqual(hook.stats().counters["salvage.activate.blocked"], 1);
    const other = salvagerRuntime.resolveSalvagerActivation({ ...args, effectRecord: { notSalvager: true } });
    assert.deepStrictEqual(other, { matched: false }, "not a Salvager: the vendor answer as it came");
    assert.strictEqual(hook.stats().counters["salvage.activate.blocked"], 1);
    assert.strictEqual(calls.length, 2);
  });

  test("SH6 (round 2) the cycle boundary of a twin: moduleItem null (owner's inventory) -> the vendor "
    + "snapshot gets the twin's module (itemID before flagID), the rest of the args and the result 1:1; not a twin / "
    + "hook not yet installed / a module given -> 1:1; no module -> salvage.boundary.noModule", () => {
    const { BOUNDARY_EXPORT, BOUNDARY_WRAPPED, wrapBoundaryExports } = require("../../lib/adapter/salvageHook");
    const { twin, hook } = setup();
    const seen = [];
    const snapshot = {
      [BOUNDARY_EXPORT](scene, entity, moduleItem, effectState, nowMs) {
        seen.push({ self: this, args: [scene, entity, moduleItem, effectState, nowMs] });
        return moduleItem ? { matched: true, success: true, data: { moduleItem } }
          : { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
      },
    };
    let live = null;
    assert.deepStrictEqual(wrapBoundaryExports(snapshot, () => live), { ok: true });
    assert.strictEqual(snapshot[BOUNDARY_EXPORT][BOUNDARY_WRAPPED], true);
    assert.deepStrictEqual(wrapBoundaryExports(snapshot, () => live), { ok: false, reason: "ALREADY" });
    const scene = sceneWith([twin]);
    const effect = { moduleID: 77, moduleFlagID: 27, targetID: WRECK };
    assert.strictEqual(snapshot[BOUNDARY_EXPORT](scene, twin, null, effect, 9).errorMsg, "UNSUPPORTED_MODULE",
      "before the hook installs: the vendor as without the mod");
    live = hook;
    hook.install();
    twin.fittedItems.push({ itemID: 78, typeID: 1, flagID: 28 });
    const out = snapshot[BOUNDARY_EXPORT].call(snapshot, scene, twin, null, { ...effect, moduleFlagID: 28 }, 10);
    assert.deepStrictEqual(out, { matched: true, success: true, data: { moduleItem: twin.fittedItems[0] } },
      "itemID first (vendor order)");
    const last = seen[seen.length - 1];
    assert.strictEqual(last.self, snapshot);
    assert.deepStrictEqual([last.args[0], last.args[1], last.args[4]], [scene, twin, 10]);
    assert.strictEqual(snapshot[BOUNDARY_EXPORT](scene, twin, null, { moduleID: 0, moduleFlagID: 28 }, 11).data
      .moduleItem.itemID, 78, "by flagID without an itemID");
    const given = { itemID: 5 };
    assert.strictEqual(snapshot[BOUNDARY_EXPORT](scene, twin, given, effect, 12).data.moduleItem, given);
    const other = { itemID: OTHER, kind: "ship", characterID: OWNER };
    assert.strictEqual(snapshot[BOUNDARY_EXPORT](scene, other, null, effect, 13).success, false, "not a twin: 1:1");
    assert.strictEqual(snapshot[BOUNDARY_EXPORT](scene, twin, null, { moduleID: 999 }, 14).success, false);
    const c = hook.stats().counters;
    assert.deepStrictEqual([c["salvage.boundary.module"], c["salvage.boundary.noModule"]], [2, 1]);
    hook.uninstall();
    assert.strictEqual(snapshot[BOUNDARY_EXPORT](scene, twin, null, effect, 15).success, false, "uninstalled: 1:1");
  });

  test("SH7 (round 2) the boundary wrap refuses a vendor function of another arity (BOUNDARY_SIGNATURE) and a "
    + "missing export; a throw of the mod part -> the vendor once, 1:1", () => {
    const { BOUNDARY_EXPORT, wrapBoundaryExports } = require("../../lib/adapter/salvageHook");
    assert.deepStrictEqual(wrapBoundaryExports({ [BOUNDARY_EXPORT]: (a, b, c, d) => [a, b, c, d] }, () => null),
      { ok: false, reason: "BOUNDARY_SIGNATURE" });
    assert.deepStrictEqual(wrapBoundaryExports({}, () => null), { ok: false, reason: "BOUNDARY_SEAM_UNAVAILABLE" });
    let calls = 0;
    // eslint-disable-next-line no-unused-vars
    const snapshot = { [BOUNDARY_EXPORT]: (s, e, m, st, n) => { calls += 1; return "vendor"; } };
    wrapBoundaryExports(snapshot, () => { throw new Error("boom"); });
    assert.strictEqual(snapshot[BOUNDARY_EXPORT]({}, {}, null, {}, 1), "vendor");
    assert.strictEqual(calls, 1);
  });
};
