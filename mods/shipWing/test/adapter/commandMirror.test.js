"use strict";

const assert = require("node:assert");
const {
  MIRRORED, HANDLERS, COUNTER_NAMES, mirrorTargetOf, createCommandMirror, installCommandMirrorFromGame,
} = require("../../lib/adapter/commandMirror");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { REFUSAL } = require("../../lib/core/reasons");

const CHAR = 90000001;
const RAT = 9000001;
const PLAYER_SHIP = 9100001;
const SESSION = { characterID: CHAR };

function vendorClasses(log) {
  const result = { entries: [] };
  class EntityService {
    Handle_CmdEngage(args, session) {
      log.push(["vendor.CmdEngage", this, args, session]);
      return result;
    }

    Handle_CmdMineRepeatedly(args, session, kwargs) {
      log.push(["vendor.CmdMine", this, args, session, kwargs]);
      return result;
    }

    Handle_CmdReturnBay(args, session) {
      log.push(["vendor.CmdReturnBay", this, args, session]);
      return result;
    }

    Handle_CmdReturnHome(args, session) {
      log.push(["vendor.CmdReturnHome", this, args, session]);
      return result;
    }
  }
  class FighterMgrService {
    Handle_CmdActivateAbilitySlots(args, session, kwargs) {
      log.push(["vendor.AbilitySlots", this, args, session, kwargs]);
      return result;
    }
    Handle_RecallFightersToTubes(args, session, kwargs) {
      log.push(["vendor.Recall", this, args, session, kwargs]);
      return result;
    }
  }
  return { EntityService, FighterMgrService, result };
}

function fakeWing(log, opts = {}) {
  const w = {
    rows: opts.rows || [
      { shipItemId: 501, state: "ACTIVE", task: "ATTACK", mirrorEngage: true },
      { shipItemId: 502, state: "ACTIVE", task: "MINE", mirrorEngage: true },
      { shipItemId: 503, state: "RETURNING", task: null, mirrorEngage: null },
    ],
    owns: true, listCalls: 0, answer: () => ({ ok: true, state: "ACTIVE", task: "ATTACK" }),
  };
  w.wing = {
    ownsBlocked: (charId) => w.owns && charId === CHAR,
    listWing(charId) {
      w.listCalls += 1;
      return { characterId: charId, ships: w.rows.map((r) => ({ ...r })) };
    },
    orderCopy(charId, shipItemId, verb, options) {
      log.push(["orderCopy", charId, shipItemId, verb, options]);
      return w.answer(shipItemId, verb, options);
    },
  };
  return w;
}

function orders(log) {
  return log.filter((e) => e[0] === "orderCopy").map((e) => e.slice(1));
}

function install(classes, wing, extra = {}) {
  const mirror = createCommandMirror({ protos: { EntityService: classes.EntityService.prototype,
    FighterMgrService: classes.FighterMgrService.prototype }, wing, engageEnabled: true, ...extra });
  return { mirror, out: mirror.install() };
}

module.exports = ({ test }) => {
  test("CM1 fighters: the original once with the same this/args/session/kwargs, result ===; then "
    + "attack with args[2] (source mirror) for every ACTIVE twin; args[2] null/point/fraction -> no orderCopy; "
    + "RecallFightersToTubes -> hold only for ATTACK; a player target -> mirror.abilitySlots.refused.TARGET_NOT_NPC, "
    + "no throw", () => {
    const log = [];
    const classes = vendorClasses(log);
    const w = fakeWing(log);
    const { mirror, out } = install(classes, w.wing);
    assert.deepStrictEqual(out, { ok: true, wrapped: HANDLERS.map((h) => `${h.service}.${h.method}`), already: [],
      failed: [] });
    const svc = new classes.FighterMgrService();
    const args = [[7001, 7002], 0, RAT];
    const kwargs = { k: 1 };
    assert.strictEqual(svc.Handle_CmdActivateAbilitySlots(args, SESSION, kwargs), classes.result);
    const vendorCalls = log.filter((e) => e[0] === "vendor.AbilitySlots");
    assert.strictEqual(vendorCalls.length, 1);
    assert.ok(vendorCalls[0][1] === svc && vendorCalls[0][2] === args && vendorCalls[0][3] === SESSION
      && vendorCalls[0][4] === kwargs, "same this, args, session, kwargs");
    assert.deepStrictEqual(orders(log), [
      [CHAR, 501, "attack", { targetId: RAT, source: "mirror" }],
      [CHAR, 502, "attack", { targetId: RAT, source: "mirror" }],
    ], "every ACTIVE twin (the core refuses the ones without weapons), not the RETURNING one");
    assert.ok(log.findIndex((e) => e[0] === "vendor.AbilitySlots") < log.findIndex((e) => e[0] === "orderCopy"),
      "the original first");
    assert.strictEqual(mirror.stats().counters["mirror.abilitySlots.mirrored"], 2);

    log.length = 0;
    for (const bad of [null, undefined, [1, 2, 3], { x: 1 }, 0, -5, 1.5, "9000001", 2 ** 60]) {
      svc.Handle_CmdActivateAbilitySlots([[7001], 1, bad], SESSION, null);
    }
    svc.Handle_CmdActivateAbilitySlots([[7001], 1], SESSION, null);
    assert.strictEqual(orders(log).length, 0);
    assert.strictEqual(log.filter((e) => e[0] === "vendor.AbilitySlots").length, 10, "the original always runs");
    assert.deepStrictEqual([mirrorTargetOf(RAT), mirrorTargetOf(null), mirrorTargetOf([1, 2, 3])], [RAT, null, null]);
    assert.deepStrictEqual([mirrorTargetOf(BigInt(RAT)), mirrorTargetOf(2n ** 60n), mirrorTargetOf(-1n)],
      [RAT, null, null]);

    log.length = 0;
    assert.strictEqual(svc.Handle_RecallFightersToTubes([[7001, 7002]], SESSION, null), classes.result);
    assert.deepStrictEqual(orders(log), [[CHAR, 501, "hold", { source: "mirror" }]]);
    assert.strictEqual(mirror.stats().counters["mirror.recallFighters.mirrored"], 1);

    log.length = 0;
    w.answer = () => ({ ok: false, reason: "TARGET_NOT_NPC" });
    assert.strictEqual(svc.Handle_CmdActivateAbilitySlots([[7001], 0, PLAYER_SHIP], SESSION, null), classes.result);
    assert.strictEqual(orders(log).length, 2);
    assert.strictEqual(mirror.stats().counters["mirror.abilitySlots.refused.TARGET_NOT_NPC"], 2);
    w.answer = () => ({ ok: false, reason: "SOMETHING_NEW" });
    svc.Handle_CmdActivateAbilitySlots([[7001], 0, RAT], SESSION, null);
    assert.strictEqual(mirror.stats().counters["mirror.abilitySlots.refused.TASK_UNAVAILABLE"], 2);
    assert.ok(Object.keys(mirror.stats().counters).every((n) => COUNTER_NAMES.includes(n)));
  });

  test("CM2 CmdEngage (S3C-F2): attack with args[1]; the original throws -> the error passes, no orderCopy; "
    + "orderCopy throws -> the result returned, mirror.engage.error; no record of the pilot -> no listWing (O(1)); "
    + "no character -> nothing; stop -> pass-through", () => {
    const log = [];
    const classes = vendorClasses(log);
    const w = fakeWing(log, { rows: [{ shipItemId: 501, state: "ACTIVE", task: "FOLLOW", mirrorEngage: true }] });
    const { mirror } = install(classes, w.wing);
    const svc = new classes.EntityService();
    assert.strictEqual(svc.Handle_CmdEngage([[8001], RAT], SESSION), classes.result);
    assert.deepStrictEqual(orders(log), [[CHAR, 501, "attack", { targetId: RAT, source: "mirror" }]]);
    assert.strictEqual(mirror.stats().counters["mirror.engage.mirrored"], 1);

    log.length = 0;
    const boom = new Error("vendor failed");
    const throwing = vendorClasses(log);
    throwing.EntityService.prototype.Handle_CmdEngage = function vendorThrows() {
      throw boom;
    };
    const w2 = fakeWing(log);
    install(throwing, w2.wing);
    assert.throws(() => new throwing.EntityService().Handle_CmdEngage([[8001], RAT], SESSION), (e) => e === boom);
    assert.strictEqual(orders(log).length, 0, "no mirror after a throw of the original");

    w.wing.orderCopy = () => {
      throw new Error("core bug");
    };
    assert.strictEqual(svc.Handle_CmdEngage([[8001], RAT], SESSION), classes.result);
    assert.strictEqual(mirror.stats().counters["mirror.engage.error"], 1);

    const calls = w.listCalls;
    w.owns = false;
    svc.Handle_CmdEngage([[8001], RAT], SESSION);
    assert.strictEqual(w.listCalls, calls);
    w.owns = true;
    svc.Handle_CmdEngage([[8001], RAT], {});
    svc.Handle_CmdEngage([[8001], RAT], null);
    assert.strictEqual(w.listCalls, calls, "no character in the session");

    mirror.stop();
    log.length = 0;
    w.wing.orderCopy = (...a) => log.push(["orderCopy", ...a]);
    assert.strictEqual(svc.Handle_CmdEngage([[8001], RAT], SESSION), classes.result);
    assert.deepStrictEqual(orders(log), [], "stopped core: pass-through");
  });

  test("CM3 double wrap: a foreign prototype wrapper before ours + a second shipWing install = no-op -> the "
    + "original, the foreign wrapper and the mirror each run once; CmdEngage with an AUD-style chain on "
    + "droneRuntime.commandEngage keeps its order; foreign symbols kept on our wrapper", () => {
    const log = [];
    const droneRuntime = {
      commandEngage(session, droneIds, targetId) {
        log.push(["vendor.commandEngage", droneIds, targetId]);
        return { ok: true };
      },
      commandMineRepeatedly(session, droneIds, targetId) {
        log.push(["vendor.commandMineRepeatedly", droneIds, targetId]);
        return { ok: true };
      },
    };
    const AUD_MARK = Symbol.for("advancedUtilityDrones.playerCommand");
    for (const name of ["commandEngage", "commandMineRepeatedly"]) {
      const audOriginal = droneRuntime[name];
      droneRuntime[name] = function advancedUtilityDronesPlayerCommand(session, first) {
        log.push(["aud", first]);
        return audOriginal.apply(this, arguments);
      };
      droneRuntime[name][AUD_MARK] = true;
    }
    const { commandEngage, commandMineRepeatedly } = droneRuntime;
    const result = { dict: true };
    class EntityService {
      Handle_CmdEngage(args, session) {
        log.push(["handler"]);
        commandEngage(session, args && args[0], args && args[1]);
        return result;
      }

      Handle_CmdMineRepeatedly(args, session) {
        log.push(["handler.mine"]);
        commandMineRepeatedly(session, args && args[0], args && args[1]);
        return result;
      }

      Handle_CmdReturnBay() {
        return result;
      }

      Handle_CmdReturnHome() {
        return result;
      }
    }
    class FighterMgrService {
      Handle_CmdActivateAbilitySlots() {
        log.push(["handler.slots"]);
        return result;
      }
      Handle_RecallFightersToTubes() {
        log.push(["handler.recall"]);
        return result;
      }
    }
    const FOREIGN = Symbol.for("otherMod.wrapped");
    for (const [cls, name] of [[EntityService, "Handle_CmdEngage"], [EntityService, "Handle_CmdMineRepeatedly"],
      [FighterMgrService, "Handle_CmdActivateAbilitySlots"]]) {
      const base = cls.prototype[name];
      cls.prototype[name] = function foreignWrapper() {
        log.push(["foreign", name]);
        return base.apply(this, arguments);
      };
      cls.prototype[name][FOREIGN] = true;
    }
    const w = fakeWing(log, { rows: [{ shipItemId: 501, state: "ACTIVE", task: "FOLLOW", mirrorEngage: true }] });
    const first = install({ EntityService, FighterMgrService }, w.wing);
    assert.strictEqual(first.out.ok, true);
    const wrappedEngage = EntityService.prototype.Handle_CmdEngage;
    assert.strictEqual(wrappedEngage[MIRRORED], true);
    assert.strictEqual(wrappedEngage[FOREIGN], true, "foreign symbols kept");
    const second = install({ EntityService, FighterMgrService }, fakeWing(log).wing);
    assert.deepStrictEqual(second.out, { ok: false, reason: "MIRROR_ALREADY_INSTALLED",
      wrapped: [], already: HANDLERS.map((h) => `${h.service}.${h.method}`), failed: [] });
    assert.strictEqual(EntityService.prototype.Handle_CmdEngage, wrappedEngage, "second install: no-op");

    const svc = new EntityService();
    assert.strictEqual(svc.Handle_CmdEngage([[8001, 8002], RAT], SESSION), result);
    assert.deepStrictEqual(log.map((e) => e[0]), ["foreign", "handler", "aud", "vendor.commandEngage", "orderCopy"]);
    assert.deepStrictEqual(log[3].slice(1), [[8001, 8002], RAT]);
    log.length = 0;
    new FighterMgrService().Handle_CmdActivateAbilitySlots([[1], 0, RAT], SESSION, null);
    assert.deepStrictEqual(log.map((e) => e[0]), ["foreign", "handler.slots", "orderCopy"]);
    log.length = 0;
    assert.strictEqual(svc.Handle_CmdMineRepeatedly([[8001], 7700001], SESSION), result);
    assert.deepStrictEqual(log.map((e) => e[0]),
      ["foreign", "handler.mine", "aud", "vendor.commandMineRepeatedly", "orderCopy"]);
    assert.deepStrictEqual(log[3].slice(1), [[8001], 7700001]);
    assert.deepStrictEqual(log[4].slice(1), [CHAR, 501, "mine", { targetId: 7700001, source: "mirror" }]);
  });

  test("CM4 registry and loader entry: every handler is a `mirror` GAME_MODULES row (classPrototypeMethod, wrap); "
    + "probe `mirror` DRIFT -> probe_mirror_unavailable, nothing wrapped; a class without the method -> "
    + "MIRROR_SEAM_UNAVAILABLE; counter names closed (mirror.<handler>.<mirrored|error|refused.REFUSAL>)", () => {
    const rows = GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.consumer === "mirror" && s.optional !== true)
      .map((s) => [m.path, s.name, s.kind, s.wrap === true]));
    assert.deepStrictEqual(rows.sort(), HANDLERS.map((h) => [h.module, h.method, "classPrototypeMethod", true]).sort());
    for (const h of HANDLERS) {
      for (const n of ["mirrored", "error", ...REFUSAL.map((r) => `refused.${r}`)]) {
        assert.ok(COUNTER_NAMES.includes(`mirror.${h.counter}.${n}`), `${h.counter}.${n}`);
      }
    }

    const log = [];
    const classes = vendorClasses(log);
    const w = fakeWing(log);
    const exportsByPath = { "services/drone/entityService": classes.EntityService,
      "services/fighter/fighterMgrService": classes.FighterMgrService };
    const adapter = (available) => ({
      isConsumerAvailable: (name) => available && name === "mirror",
      requireGame: (rel) => (exportsByPath[rel] ? { ok: true, exports: exportsByPath[rel] }
        : { ok: false, reason: "NOT_WHITELISTED" }),
    });
    const before = classes.EntityService.prototype.Handle_CmdEngage;
    assert.deepStrictEqual(installCommandMirrorFromGame(adapter(false), { wing: w.wing }),
      { ok: false, reason: "probe_mirror_unavailable" });
    assert.strictEqual(classes.EntityService.prototype.Handle_CmdEngage, before);
    const done = installCommandMirrorFromGame(adapter(true), { wing: w.wing });
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.mirror.isActive(), true);
    assert.strictEqual(classes.EntityService.prototype.Handle_CmdEngage[MIRRORED], true);

    const broken = createCommandMirror({ protos: { EntityService: {}, FighterMgrService: {} }, wing: w.wing });
    assert.deepStrictEqual(broken.install(), { ok: false, reason: "MIRROR_SEAM_UNAVAILABLE", wrapped: [], already: [],
      failed: HANDLERS.map((h) => `${h.service}.${h.method}`) });
  });

  test("CM5 CmdMineRepeatedly (S2-F15): the original once with the same this/args/session/kwargs "
    + "result ===; then mine with args[1] (source mirror) for every ACTIVE twin; args[1] null/point/text -> no "
    + "orderCopy; a safe BigInt -> a number; no mining module -> mirror.mine.refused.NO_MINING_MODULE, no throw", () => {
    const ROCK = 7700001;
    const log = [];
    const classes = vendorClasses(log);
    const w = fakeWing(log);
    const { mirror } = install(classes, w.wing);
    const svc = new classes.EntityService();
    const args = [[8001, 8002], ROCK];
    const kwargs = { k: 2 };
    assert.strictEqual(svc.Handle_CmdMineRepeatedly(args, SESSION, kwargs), classes.result);
    const vendorCalls = log.filter((e) => e[0] === "vendor.CmdMine");
    assert.strictEqual(vendorCalls.length, 1);
    assert.ok(vendorCalls[0][1] === svc && vendorCalls[0][2] === args && vendorCalls[0][3] === SESSION
      && vendorCalls[0][4] === kwargs, "same this, args, session, kwargs");
    assert.ok(log.findIndex((e) => e[0] === "vendor.CmdMine") < log.findIndex((e) => e[0] === "orderCopy"));
    assert.deepStrictEqual(orders(log), [
      [CHAR, 501, "mine", { targetId: ROCK, source: "mirror" }],
      [CHAR, 502, "mine", { targetId: ROCK, source: "mirror" }],
    ], "every ACTIVE twin (ATTACK and MINE), not the RETURNING one");
    assert.strictEqual(mirror.stats().counters["mirror.mine.mirrored"], 2);

    log.length = 0;
    for (const bad of [null, undefined, [1, 2, 3], { x: 1 }, 0, "7700001", 2n ** 60n]) {
      svc.Handle_CmdMineRepeatedly([[8001], bad], SESSION);
    }
    svc.Handle_CmdMineRepeatedly([[8001]], SESSION);
    assert.strictEqual(orders(log).length, 0);
    assert.strictEqual(log.filter((e) => e[0] === "vendor.CmdMine").length, 8, "the original always runs");

    svc.Handle_CmdMineRepeatedly([[8001], BigInt(ROCK)], SESSION);
    assert.deepStrictEqual(orders(log).map((o) => o[3]), [{ targetId: ROCK, source: "mirror" },
      { targetId: ROCK, source: "mirror" }], "a PyLongLong in the safe range -> a number");

    log.length = 0;
    w.answer = (id) => (id === 501 ? { ok: false, reason: "NO_MINING_MODULE" } : { ok: true, task: "MINE" });
    assert.strictEqual(svc.Handle_CmdMineRepeatedly([[8001], ROCK], SESSION), classes.result);
    assert.strictEqual(mirror.stats().counters["mirror.mine.refused.NO_MINING_MODULE"], 1);
    w.answer = () => ({ ok: false, reason: "UNSUPPORTED_VERB" });
    svc.Handle_CmdMineRepeatedly([[8001], ROCK], SESSION);
    assert.strictEqual(mirror.stats().counters["mirror.mine.refused.UNSUPPORTED_VERB"], 2, "mine off in config");
  });

  test("CM6 CmdReturnBay / CmdReturnHome: return flag off -> no orderCopy (one drone or "
    + "all); flag on + a subset of the drones in space -> no orderCopy (skipped.partial); unknown drone list -> "
    + "skipped.unknown; flag on + every drone -> return / hold with {source:mirror} for every ACTIVE twin, "
    + "RETURNING / LAUNCHING skipped; the original always runs once; orderCopy throws -> mirror.returnBay.error", () => {
    const log = [];
    const rows = [
      { shipItemId: 501, state: "ACTIVE", task: "ATTACK" },
      { shipItemId: 502, state: "ACTIVE", task: "MINE" },
      { shipItemId: 503, state: "RETURNING", task: null },
      { shipItemId: 504, state: "LAUNCHING", task: null },
      { shipItemId: 505, state: "ACTIVE", task: "FOLLOW" },
    ];
    let inSpace = [8001, 8002];
    const droneIdsInSpace = (session) => (session === SESSION ? inSpace : null);

    const off = vendorClasses(log);
    install(off, fakeWing(log, { rows }).wing, { droneIdsInSpace });
    const offSvc = new off.EntityService();
    assert.strictEqual(offSvc.Handle_CmdReturnBay([[8001]], SESSION), off.result);
    offSvc.Handle_CmdReturnBay([[8001, 8002]], SESSION);
    offSvc.Handle_CmdReturnHome([[8001, 8002]], SESSION);
    assert.strictEqual(orders(log).length, 0, "flag off: 0 orderCopy");
    assert.strictEqual(log.filter((e) => e[0].startsWith("vendor.CmdReturn")).length, 3, "the original always runs");

    log.length = 0;
    const classes = vendorClasses(log);
    const w = fakeWing(log, { rows });
    const { mirror } = install(classes, w.wing, { returnEnabled: true, droneIdsInSpace });
    const svc = new classes.EntityService();
    assert.strictEqual(svc.Handle_CmdReturnBay([[8001]], SESSION), classes.result);
    assert.strictEqual(orders(log).length, 0, "a subset: 0 orderCopy");
    assert.strictEqual(mirror.stats().counters["mirror.returnBay.skipped.partial"], 1);
    inSpace = null;
    svc.Handle_CmdReturnBay([[8001, 8002]], SESSION);
    assert.strictEqual(orders(log).length, 0, "unknown drones in space: 0 orderCopy");
    assert.strictEqual(mirror.stats().counters["mirror.returnBay.skipped.unknown"], 1);
    inSpace = [8001, 8002];

    const args = [{ type: "list", items: [8002n, 8001] }];
    assert.strictEqual(svc.Handle_CmdReturnBay(args, SESSION), classes.result);
    assert.deepStrictEqual(orders(log), [501, 502, 505].map((id) => [CHAR, id, "return", { source: "mirror" }]));
    log.length = 0;
    assert.strictEqual(svc.Handle_CmdReturnHome([[8001, 8002]], SESSION), classes.result);
    assert.deepStrictEqual(orders(log), [501, 502, 505].map((id) => [CHAR, id, "hold", { source: "mirror" }]));
    assert.deepStrictEqual([mirror.stats().counters["mirror.returnBay.mirrored"],
      mirror.stats().counters["mirror.returnHome.mirrored"]], [3, 3]);

    w.wing.orderCopy = () => {
      throw new Error("core bug");
    };
    assert.strictEqual(svc.Handle_CmdReturnBay([[8001, 8002]], SESSION), classes.result);
    assert.strictEqual(mirror.stats().counters["mirror.returnBay.error"], 1);
  });

  test("CM7 partial install: some methods already ours, some not -> "
    + "MIRROR_PARTIAL_INSTALL, nothing wrapped; one method missing -> MIRROR_SEAM_UNAVAILABLE, nothing wrapped; "
    + "a write that throws -> the ones written before are put back", () => {
    const log = [];
    const w = fakeWing(log);
    const label = (h) => `${h.service}.${h.method}`;
    const snapshot = (classes) => HANDLERS.map((h) => classes[h.service].prototype[h.method]);

    const partial = vendorClasses(log);
    partial.EntityService.prototype.Handle_CmdEngage[MIRRORED] = true;
    const before = snapshot(partial);
    const p = install(partial, w.wing);
    assert.deepStrictEqual(p.out, { ok: false, reason: "MIRROR_PARTIAL_INSTALL", wrapped: [],
      already: ["EntityService.Handle_CmdEngage"], failed: [] });
    assert.deepStrictEqual(snapshot(partial), before, "no prototype changed");
    assert.strictEqual(p.mirror.isActive(), false);

    const drift = vendorClasses(log);
    delete drift.EntityService.prototype.Handle_CmdReturnHome;
    const beforeDrift = snapshot(drift);
    const d = install(drift, w.wing);
    assert.deepStrictEqual(d.out, { ok: false, reason: "MIRROR_SEAM_UNAVAILABLE", wrapped: [], already: [],
      failed: ["EntityService.Handle_CmdReturnHome"] });
    assert.deepStrictEqual(snapshot(drift), beforeDrift);
    assert.strictEqual(d.mirror.isActive(), false);

    const rollback = vendorClasses(log);
    const last = HANDLERS[HANDLERS.length - 1];
    const beforeRollback = snapshot(rollback);
    const protos = { EntityService: rollback.EntityService.prototype,
      FighterMgrService: rollback.FighterMgrService.prototype };
    protos[last.service] = new Proxy(protos[last.service], {
      defineProperty(target, key, desc) {
        if (key === last.method) throw new Error("refused");
        return Reflect.defineProperty(target, key, desc);
      },
    });
    const rm = createCommandMirror({ protos, wing: w.wing });
    const r = rm.install();
    assert.deepStrictEqual(r, { ok: false, reason: "MIRROR_SEAM_UNAVAILABLE", wrapped: [], already: [],
      failed: [label(last)] });
    assert.deepStrictEqual(snapshot(rollback), beforeRollback, "every prototype as before");
    assert.strictEqual(rm.isActive(), false);
  });

  test("CM8 engage group: engageEnabled false -> CmdEngage / ability slots / recall without orderCopy "
    + "skipped.disabled per call, mine still mirrored; engageEnabled true -> only twins with mirrorEngage true, "
    + "skipped.copyOff per twin; recall skips an off twin; mirroredVerbs without attack when off", () => {
    const { mirroredVerbs } = require("../../lib/adapter/commandMirror");
    const log = [];
    const off = vendorClasses(log);
    const w = fakeWing(log);
    const a = install(off, w.wing, { engageEnabled: false });
    assert.strictEqual(a.out.ok, true, "the engage handlers stay wrapped (all or nothing)");
    new off.EntityService().Handle_CmdEngage([[8001], RAT], SESSION);
    new off.FighterMgrService().Handle_CmdActivateAbilitySlots([[7001], 0, RAT], SESSION, null);
    new off.FighterMgrService().Handle_RecallFightersToTubes([[7001]], SESSION, null);
    assert.deepStrictEqual(orders(log), []);
    assert.strictEqual(w.listCalls, 0, "skipped before listWing");
    const ca = a.mirror.stats().counters;
    assert.deepStrictEqual([ca["mirror.engage.skipped.disabled"], ca["mirror.abilitySlots.skipped.disabled"],
      ca["mirror.recallFighters.skipped.disabled"]], [1, 1, 1]);
    new off.EntityService().Handle_CmdMineRepeatedly([[8001], 7700001], SESSION, null);
    assert.deepStrictEqual(orders(log).map((o) => [o[1], o[2]]), [[501, "mine"], [502, "mine"]], "mine unchanged");

    const log2 = [];
    const on = vendorClasses(log2);
    const w2 = fakeWing(log2, { rows: [
      { shipItemId: 601, state: "ACTIVE", task: "ATTACK", mirrorEngage: true },
      { shipItemId: 602, state: "ACTIVE", task: "ATTACK", mirrorEngage: false },
      { shipItemId: 603, state: "ACTIVE", task: "ATTACK" },
    ] });
    const b = install(on, w2.wing, { engageEnabled: true });
    new on.EntityService().Handle_CmdEngage([[8001], RAT], SESSION);
    assert.deepStrictEqual(orders(log2), [[CHAR, 601, "attack", { targetId: RAT, source: "mirror" }]]);
    assert.strictEqual(b.mirror.stats().counters["mirror.engage.skipped.copyOff"], 2);
    log2.length = 0;
    new on.FighterMgrService().Handle_RecallFightersToTubes([[7001]], SESSION, null);
    assert.deepStrictEqual(orders(log2), [[CHAR, 601, "hold", { source: "mirror" }]]);
    assert.strictEqual(b.mirror.stats().counters["mirror.recallFighters.skipped.copyOff"], 2);

    assert.ok(!mirroredVerbs(false, false).has("attack"));
    assert.ok(mirroredVerbs(false, true).has("attack"));
    for (const h of HANDLERS.filter((x) => x.engage)) {
      assert.ok(COUNTER_NAMES.includes(`mirror.${h.counter}.skipped.disabled`)
        && COUNTER_NAMES.includes(`mirror.${h.counter}.skipped.copyOff`), h.counter);
    }
    assert.deepStrictEqual(HANDLERS.filter((x) => x.engage).map((x) => x.counter),
      ["engage", "abilitySlots", "recallFighters"]);
  });
};
