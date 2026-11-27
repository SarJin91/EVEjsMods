"use strict";

const assert = require("node:assert");
const {
  MARKER, CONSUMER, MODULE_PATH, COUNTER_NAMES, createSafeLogoffHook, installSafeLogoffHookFromGame,
} = require("../../lib/adapter/safeLogoffHook");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const CHAR = 90000001;
const LABELS = Object.freeze({
  ALREADY_IN_PROGRESS: "L/AlreadyInProgress",
  PVP_TIMER: "L/PvpTimer",
  DRONES_CONNECTED: "L/DronesConnected",
  TARGETED: "L/Targeted",
  MOVEMENT_ACTIVE: "L/MovementActive",
});

function fakeRuntime() {
  const rt = {
    calls: [],
    aborts: [],
    result: { success: true, data: [] },
    failed: { success: true, labels: [LABELS.TARGETED, LABELS.PVP_TIMER], context: { secret: true } },
    LABELS,
    prepareStart(session) {
      rt.calls.push({ self: this, args: Array.prototype.slice.call(arguments) });
      if (session && rt.result.data.length === 0) session._safeLogoff = { state: "staged" };
      return rt.result;
    },
    collectFailedConditions: () => rt.failed,
    abort(session, opts) {
      rt.aborts.push([session, opts]);
      if (!session || !session._safeLogoff) return false;
      delete session._safeLogoff;
      return true;
    },
  };
  return rt;
}

function setup(opts = {}) {
  const runtime = opts.runtime || fakeRuntime();
  const wing = { deployed: opts.deployed === undefined ? 2 : opts.deployed, deployedCount(charId) {
    if (wing.throws) throw new Error("core");
    return charId === CHAR ? wing.deployed : 0;
  } };
  const sessions = new Map();
  const config = { safeLogoffAbortOnOrder: true, safeLogoffBlockWhileDeployed: true, ...(opts.config || {}) };
  const hook = createSafeLogoffHook({
    runtime, wing, config, characterIdOf: (s) => (s && s.characterID) || 0,
    findSession: opts.findSession || ((id) => sessions.get(id) || null),
  });
  return { runtime, wing, sessions, config, hook };
}

module.exports = ({ test }) => {
  test("SL1 prepareStart wrap: twins in space + flag on -> {success:true, data:[vendor labels + DRONES_CONNECTED]} in "
    + "the vendor order, original not called, no _safeLogoff; 0 twins / flag off / vendor refusal -> the original "
    + "(same this, args, result ===); a mod fault -> original + safeLogoff.error; chain, foreign symbols, second "
    + "install SAFE_LOGOFF_ALREADY_INSTALLED (original called once); stop = pass-through", () => {
    const t = setup();
    const original = t.runtime.prepareStart;
    const FOREIGN = Symbol.for("otherMod.wrapped");
    const foreignCalls = [];
    t.runtime.prepareStart = function otherModPrepareStart() {
      foreignCalls.push(1);
      return original.apply(this, arguments);
    };
    t.runtime.prepareStart[FOREIGN] = true;
    assert.deepStrictEqual(t.hook.install(), { ok: true });
    const wrapped = t.runtime.prepareStart;
    assert.strictEqual(wrapped[MARKER], true);
    assert.strictEqual(wrapped[FOREIGN], true, "foreign symbols kept");
    assert.strictEqual(t.hook.isActive(), true);

    const self = { service: "ship" };
    const session = { characterID: CHAR };
    assert.deepStrictEqual(t.runtime.prepareStart.call(self, session),
      { success: true, data: [LABELS.PVP_TIMER, LABELS.DRONES_CONNECTED, LABELS.TARGETED] });
    assert.strictEqual(t.runtime.calls.length, 0, "the original is not called");
    assert.strictEqual(foreignCalls.length, 0);
    assert.strictEqual(session._safeLogoff, undefined, "no lease");
    assert.strictEqual(t.hook.stats().counters["safeLogoff.blocked"], 1);

    t.runtime.failed = { success: true, labels: [LABELS.DRONES_CONNECTED], context: {} };
    assert.deepStrictEqual(t.runtime.prepareStart(session).data, [LABELS.DRONES_CONNECTED], "no duplicate");

    const passes = (why, call) => {
      const before = t.runtime.calls.length;
      const s = { characterID: CHAR };
      const out = call(s);
      assert.strictEqual(out, t.runtime.result, why);
      assert.strictEqual(t.runtime.calls.length, before + 1, why);
      const last = t.runtime.calls[t.runtime.calls.length - 1];
      assert.strictEqual(last.self, self, why);
      assert.deepStrictEqual(last.args, [s, "extra"], why);
      assert.ok(s._safeLogoff, `${why}: the vendor lease`);
    };
    t.wing.deployed = 0;
    passes("0 twins", (s) => t.runtime.prepareStart.call(self, s, "extra"));
    t.wing.deployed = 2;
    t.config.safeLogoffBlockWhileDeployed = false;
    passes("flag off (read at call)", (s) => t.runtime.prepareStart.call(self, s, "extra"));
    t.config.safeLogoffBlockWhileDeployed = true;
    t.runtime.failed = { success: false, errorMsg: "SAFE_LOGOFF_NOT_IN_SPACE", labels: [] };
    passes("vendor refusal -> the original", (s) => t.runtime.prepareStart.call(self, s, "extra"));
    t.runtime.failed = { success: true, labels: [], context: {} };
    t.wing.throws = true;
    passes("mod fault", (s) => t.runtime.prepareStart.call(self, s, "extra"));
    assert.strictEqual(t.hook.stats().counters["safeLogoff.error"], 1);
    t.wing.throws = false;

    const second = createSafeLogoffHook({ runtime: t.runtime, wing: t.wing, config: t.config,
      characterIdOf: () => CHAR, findSession: () => null });
    assert.deepStrictEqual(second.install(), { ok: false, reason: "SAFE_LOGOFF_ALREADY_INSTALLED" });
    assert.deepStrictEqual(t.hook.install(), { ok: false, reason: "SAFE_LOGOFF_ALREADY_INSTALLED" });
    assert.strictEqual(t.runtime.prepareStart, wrapped);
    t.wing.deployed = 0;
    const before = t.runtime.calls.length;
    t.runtime.prepareStart({ characterID: CHAR });
    assert.strictEqual(t.runtime.calls.length, before + 1, "the original runs once");
    t.wing.deployed = 2;
    t.hook.stop();
    assert.strictEqual(t.hook.isActive(), false);
    passes("stopped", (s) => t.runtime.prepareStart.call(self, s, "extra"));
    assert.strictEqual(t.hook.stats().counters["safeLogoff.blocked"], 2, "nothing counted after stop");

    const broken = createSafeLogoffHook({ runtime: { prepareStart() {} }, wing: t.wing, config: t.config,
      characterIdOf: () => CHAR, findSession: () => null });
    assert.deepStrictEqual(broken.install(), { ok: false, reason: "SAFE_LOGOFF_SEAM_UNAVAILABLE" });
    assert.deepStrictEqual(COUNTER_NAMES, ["safeLogoff.aborted", "safeLogoff.blocked", "safeLogoff.error"]);
  });

  test("SL2 abortFor: no _safeLogoff -> abort not called; with it -> abort(session, {reason: MOVEMENT_ACTIVE}) once "
    + "+ safeLogoff.aborted; flag off / stopped -> nothing; findSession throws -> false + safeLogoff.error, no throw",
  () => {
    const t = setup();
    assert.deepStrictEqual(t.hook.install(), { ok: true });
    const session = { characterID: CHAR };
    t.sessions.set(CHAR, session);
    assert.strictEqual(t.hook.abortFor(CHAR, "launch", "chat"), false);
    assert.strictEqual(t.hook.abortFor(90000002, "launch", "chat"), false, "no session");
    assert.strictEqual(t.runtime.aborts.length, 0);

    session._safeLogoff = { state: "running" };
    assert.strictEqual(t.hook.abortFor(CHAR, "return", "window"), true);
    assert.deepStrictEqual(t.runtime.aborts, [[session, { reason: LABELS.MOVEMENT_ACTIVE }]]);
    assert.strictEqual(session._safeLogoff, undefined);
    assert.strictEqual(t.hook.stats().counters["safeLogoff.aborted"], 1);

    session._safeLogoff = { state: "running" };
    t.config.safeLogoffAbortOnOrder = false;
    assert.strictEqual(t.hook.abortFor(CHAR, "launch", "chat"), false);
    t.config.safeLogoffAbortOnOrder = true;
    t.hook.stop();
    assert.strictEqual(t.hook.abortFor(CHAR, "launch", "chat"), false);
    assert.strictEqual(t.runtime.aborts.length, 1);

    const failing = setup({ findSession: () => {
      throw new Error("registry");
    } });
    failing.hook.install();
    assert.strictEqual(failing.hook.abortFor(CHAR, "launch", "chat"), false);
    assert.strictEqual(failing.hook.stats().counters["safeLogoff.error"], 1);
    assert.strictEqual(failing.runtime.aborts.length, 0);
  });

  test("SL1b installSafeLogoffHookFromGame: probe failed -> probe_safeLogoff_unavailable (no wrap); require failed "
    + "-> require_failed:...; ok -> hook; GAME_MODULES row: 4 exports of safeLogoffRuntime, only prepareStart wraps",
  () => {
    const runtime = fakeRuntime();
    const original = runtime.prepareStart;
    const deps = { wing: { deployedCount: () => 0 }, characterIdOf: () => CHAR, findSession: () => null,
      config: { safeLogoffAbortOnOrder: true, safeLogoffBlockWhileDeployed: false } };
    const adapter = (available, exportsOk = true) => ({
      isConsumerAvailable: (name) => available && name === CONSUMER,
      requireGame: (rel) => (exportsOk && rel === MODULE_PATH ? { ok: true, exports: runtime }
        : { ok: false, reason: "NOT_WHITELISTED" }),
    });
    assert.deepStrictEqual(installSafeLogoffHookFromGame(adapter(false), deps),
      { ok: false, reason: "probe_safeLogoff_unavailable" });
    assert.deepStrictEqual(installSafeLogoffHookFromGame(adapter(true, false), deps),
      { ok: false, reason: "require_failed:NOT_WHITELISTED" });
    assert.strictEqual(runtime.prepareStart, original);
    const done = installSafeLogoffHookFromGame(adapter(true), deps);
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.hook.isActive(), true);
    assert.strictEqual(runtime.prepareStart[MARKER], true);

    const rows = GAME_MODULES.filter((m) => m.path === MODULE_PATH).flatMap((m) => m.symbols);
    assert.deepStrictEqual(rows.map((s) => [s.name, s.kind, s.consumer, s.wrap === true, s.valueType || "function"]), [
      ["prepareStart", "export", "safeLogoff", true, "function"],
      ["abort", "export", "safeLogoff", false, "function"],
      ["collectFailedConditions", "export", "safeLogoff", false, "function"],
      ["LABELS", "export", "safeLogoff", false, "object"],
    ]);
  });
};
