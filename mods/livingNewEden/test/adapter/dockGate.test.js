"use strict";

const assert = require("node:assert");

const { createDockGateHook } = require("../../lib/adapter/dockGate");

const STATION = 60003760;
const STRUCTURE = 1030000000000;
const SYSTEM = 30000142;
const CAPSULE = 670;

function fakeVendor() {
  const calls = [];
  class FakeBeyonce {}
  FakeBeyonce.prototype.Handle_CmdDock = function Handle_CmdDock(args, session, ...rest) {
    calls.push({ self: this, args, session, rest });
    return "vendor-result";
  };
  const worldData = { getStationByID: (id) => (id === STATION ? { stationID: STATION, solarSystemID: SYSTEM } : null) };
  const itemStore = { findItemById: (id) => (id === 9001 ? { itemID: 9001, typeID: CAPSULE } : null),
    isCapsuleTypeID: (t) => t === CAPSULE };
  const throwUserError = (name, values) => {
    const err = new Error(`${name}: ${values.reason}`);
    err.userError = { name, values };
    throw err;
  };
  return { FakeBeyonce, calls, worldData, itemStore, throwUserError };
}

module.exports = ({ test }) => {
  test("DG1 dock gate: deny, allow with this/args, fail-open, structure skips decide, uninstall, double install", () => {
    const v = fakeVendor();
    const original = v.FakeBeyonce.prototype.Handle_CmdDock;
    const asked = [];
    let mode = "deny";
    const decide = (q) => {
      asked.push(q);
      if (mode === "throw") throw new Error("boom");
      return mode === "deny" ? { deny: true, message: "Amarr Empire refuses" } : { deny: false };
    };
    const hook = createDockGateHook({ serviceClass: v.FakeBeyonce, worldData: v.worldData, itemStore: v.itemStore,
      throwUserError: v.throwUserError, decide, logger: { log() {} } });
    assert.deepStrictEqual(hook.install(), { ok: true });
    assert.notStrictEqual(v.FakeBeyonce.prototype.Handle_CmdDock, original);
    const service = new v.FakeBeyonce();
    const session = { characterID: 90000001, _space: { shipID: 9001 }, shipTypeID: 587 };

    assert.throws(() => service.Handle_CmdDock([STATION], session),
      (err) => err.userError && err.userError.name === "DockingRequestDenied"
        && err.userError.values.reason === "Amarr Empire refuses");
    assert.strictEqual(v.calls.length, 0, "deny: original not called");
    assert.deepStrictEqual(asked[0], { characterId: 90000001, stationId: STATION, systemId: SYSTEM, isCapsule: true,
      stationFactionId: null });

    mode = "allow";
    const kwargs = { k: 1 };
    assert.strictEqual(service.Handle_CmdDock([STATION], session, kwargs, "ctx"), "vendor-result");
    assert.strictEqual(v.calls.length, 1);
    assert.strictEqual(v.calls[0].self, service);
    assert.deepStrictEqual(v.calls[0].args, [STATION]);
    assert.strictEqual(v.calls[0].session, session);
    assert.deepStrictEqual(v.calls[0].rest, [kwargs, "ctx"]);

    mode = "throw";
    assert.strictEqual(service.Handle_CmdDock([STATION], session), "vendor-result", "fail-open");
    assert.strictEqual(v.calls.length, 2);
    assert.strictEqual(hook.getStats().failOpen, 1);

    const before = asked.length;
    assert.strictEqual(service.Handle_CmdDock([STRUCTURE], session), "vendor-result");
    assert.strictEqual(asked.length, before, "structure: decide not asked");

    assert.deepStrictEqual(hook.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    hook.uninstall();
    assert.strictEqual(v.FakeBeyonce.prototype.Handle_CmdDock, original, "uninstall restores the original");

    const again = createDockGateHook({ serviceClass: v.FakeBeyonce, worldData: v.worldData, itemStore: v.itemStore,
      throwUserError: v.throwUserError, decide: () => ({ deny: true, message: "x" }) });
    assert.deepStrictEqual(again.install(), { ok: true });
    const ours = v.FakeBeyonce.prototype.Handle_CmdDock;
    v.FakeBeyonce.prototype.Handle_CmdDock = function other(...a) { return ours.apply(this, a); };
    again.uninstall();
    assert.strictEqual(service.Handle_CmdDock([STATION], session), "vendor-result", "pass-through after uninstall");
  });
};
