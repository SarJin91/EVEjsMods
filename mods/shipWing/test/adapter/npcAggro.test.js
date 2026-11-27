"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  WRAPPED, SUSPEND_WRAPPED, SUSPEND_METHODS, createNpcAggro,
} = require("../../lib/adapter/npcAggro");

const SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

function src(rel) {
  return fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

const PLAYER_GUARD = "toPositiveInt(entity.session.characterID, 0) > 0";

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function actorClass(entity) {
  if (!entity || entity.kind !== "ship") return null;
  if (entity.session && toPositiveInt(entity.session.characterID, 0) > 0) return "player";
  return null;
}

const OWNER = 90000001;

function twinEntity(itemID = 4200000000000001) {
  return { kind: "ship", itemID, ownerID: OWNER, pilotCharacterID: OWNER, characterID: 0, corporationID: 98000001,
    allianceID: 0, warFactionID: 0, session: null };
}

function fakeWing(twins) {
  return {
    throwOnTwinOf: false,
    liveTwinCount: () => twins.size,
    twinOf(entity) {
      if (this.throwOnTwinOf) throw new Error("boom");
      return twins.has(entity.itemID) ? { shipItemId: 1, ownerCharacterId: OWNER, twinEntityId: entity.itemID } : null;
    },
  };
}

function fakeProto(seen) {
  const proto = {};
  for (const name of SUSPEND_METHODS) {
    proto[name] = function vendorMethod(twin, inner) {
      if (typeof inner === "function") return inner();
      seen.push(`${name}:${actorClass(twin)}`);
      return `${name}-result`;
    };
  }
  return proto;
}

function activeSetup(opts = {}) {
  const twins = new Set(opts.twinIds || [4200000000000001]);
  const wing = fakeWing(twins);
  const seen = [];
  const behavior = { tickScene(fn) { return fn ? fn() : "scene"; }, tickControllersByEntityID(fn) { return fn(); } };
  const proto = fakeProto(seen);
  const aggro = createNpcAggro();
  assert.deepStrictEqual(aggro.wrapBehaviorExports(behavior), { ok: true });
  assert.deepStrictEqual(aggro.selfCheck({ resolveCombatActorClass: actorClass }), { ok: true });
  assert.deepStrictEqual(aggro.installSuspension(proto), { ok: true });
  assert.deepStrictEqual(aggro.activate({ wing }), { ok: true });
  return { aggro, wing, twins, behavior, proto, seen };
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(path.join(SRC, "space", "npc", "npcBehaviorLoop.js"))) {
    skip("NA1 vendor facts", `no EveJS tree at ${SRC}`);
  } else {
    test("NA1 vendor facts: the class `player` needs a session character; every target path needs a class; "
      + "the tick exports are destructured at load (FIRST_LOAD); destroying is set before destroyCombatEntity; the "
      + "first NPC weapon cycle runs inside activateGenericModule; notifyTargetEvent is guarded; a spawned ship has "
      + "session null", () => {
      const loop = src("space/npc/npcBehaviorLoop.js");
      const cls = loop.slice(loop.indexOf("function resolveCombatActorClass("), loop.indexOf("function getEntityCharacterID("));
      assert.ok(cls.includes("entity.session &&") && cls.includes(PLAYER_GUARD) && cls.includes("return \"player\";"));
      const valid = loop.slice(loop.indexOf("function isValidCombatTarget("));
      assert.ok(valid.slice(0, valid.indexOf("\n}\n")).includes("targetClass &&"));
      const exportsText = loop.slice(loop.lastIndexOf("module.exports = {"));
      for (const needle of ["\n  tickScene,", "\n  tickControllersByEntityID,", "\n  __testing: {",
        "\n    resolveCombatActorClass,"]) {
        assert.ok(exportsText.includes(needle), needle);
      }
      for (const rel of ["space/npc/npcService.js", "space/npc/nativeNpcService.js"]) {
        assert.ok(src(rel).includes("tickScene: tickBehaviorScene,"), rel);
      }
      const damage = src("space/runtime/targetDamageApplication.js");
      const marks = [...damage.matchAll(/targetEntity\.destroying = true;/g)].map((m) => m.index);
      assert.strictEqual(marks.length, 2);
      for (const at of marks) {
        const next = damage.indexOf("destroyCombatEntity(", at);
        assert.ok(next > at && next - at < 1200, "destroyCombatEntity right after the mark");
      }
      const modules = src("space/runtime/scene/modules.js");
      const activate = modules.slice(modules.indexOf("  activateGenericModule(session, moduleItem"),
        modules.indexOf("\ndeactivateGenericModule("));
      assert.ok(activate.includes("executeTurretCycle("));
      assert.ok(src("space/runtime/scene/targeting.js")
        .includes("notifyTargetEvent(session, what, targetID = null, reason = null) {\n    if (!session || typeof "
          + "session.sendNotification !== \"function\") {"));
      assert.ok(src("space/runtime/shipEntity.js").includes("session: options.session || null,"));
    });
  }

  test("NA2 getter: flag off (no attach) -> class null; after attach + activate -> null outside the scope, "
    + "`player` with the owner inside; suspended / destroying / not a twin / twinOf throws -> null; a vendor write "
    + "-> data field and `overwritten`; session not enumerable", () => {
    const off = twinEntity();
    assert.strictEqual(actorClass(off), null, "flag off: nothing attached, class null");

    const { aggro, behavior, wing, twins, proto } = activeSetup();
    const twin = twinEntity();
    assert.deepStrictEqual(aggro.attach(twin), { ok: true });
    assert.deepStrictEqual(aggro.attach(twin), { ok: true }, "second attach: the accessor is already there");
    assert.ok(!Object.keys(twin).includes("session"));
    assert.ok(!Object.keys({ ...twin }).includes("session"));
    assert.strictEqual(actorClass(twin), null, "outside the scope");
    let inside = null;
    behavior.tickScene(() => {
      inside = { cls: actorClass(twin), session: twin.session };
    });
    assert.strictEqual(inside.cls, "player");
    assert.strictEqual(inside.session.characterID, OWNER);
    assert.strictEqual(inside.session.corporationID, 98000001);
    assert.strictEqual(typeof inside.session.sendNotification, "undefined");
    assert.strictEqual(inside.session._space, undefined);

    const classIn = () => behavior.tickScene(() => actorClass(twin));
    assert.strictEqual(behavior.tickScene(() => proto.activateGenericModule.call(proto, twin)),
      "activateGenericModule-result");
    twin.destroying = true;
    assert.strictEqual(classIn(), null, "destroying");
    delete twin.destroying;
    twin.destructionState = "destroyed";
    assert.strictEqual(classIn(), null, "destroyed");
    delete twin.destructionState;
    const other = twinEntity(4200000000000009);
    aggro.attach(other);
    assert.strictEqual(twins.has(other.itemID), false);
    assert.strictEqual(behavior.tickScene(() => actorClass(other)), null, "twinOf null");
    wing.throwOnTwinOf = true;
    assert.strictEqual(classIn(), null, "twinOf throws");
    assert.strictEqual(aggro.stats().counters["npcAggro.error"], 1);
    wing.throwOnTwinOf = false;
    assert.strictEqual(classIn(), "player");

    twin.session = null;
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(twin, "session"),
      { value: null, writable: true, enumerable: true, configurable: true });
    assert.strictEqual(classIn(), null);
    const counters = aggro.stats().counters;
    assert.deepStrictEqual([counters["npcAggro.attached"], counters["npcAggro.overwritten"]], [2, 1]);
    assert.deepStrictEqual(aggro.attach({ kind: "drone", itemID: 5 }), { ok: false, reason: "NOT_A_TWIN" });
    assert.deepStrictEqual(aggro.attach({ kind: "ship", itemID: 5 }), { ok: false, reason: "NO_OWNER" });
    aggro.deactivate();
    const late = twinEntity(4200000000000002);
    assert.deepStrictEqual(aggro.attach(late), { ok: false, reason: "NOT_ACTIVE" });
    assert.strictEqual(behavior.tickScene(() => actorClass(other)), null, "stopped: base value");
  });

  test("NA3 FIRST_LOAD wrap: before activate a pass-through (args, this, result); after: `player` inside, depth "
    + "0 after; a vendor throw restores depth and goes on; a nested scope inside a suspension sees the overlay; "
    + "second install ALREADY_WRAPPED; foreign symbols kept", () => {
    const foreign = Symbol("otherMod");
    const calls = [];
    function tickScene(scene, now) {
      calls.push({ self: this, scene, now });
      return now * 2;
    }
    tickScene[foreign] = "kept";
    const behavior = { tickScene, tickControllersByEntityID: (fn) => fn(), other: 1 };
    const aggro = createNpcAggro();
    assert.deepStrictEqual(aggro.wrapBehaviorExports(behavior), { ok: true });
    assert.notStrictEqual(behavior.tickScene, tickScene);
    assert.strictEqual(behavior.tickScene[WRAPPED], true);
    assert.strictEqual(behavior.tickScene[foreign], "kept");
    const self = { me: 1 };
    assert.strictEqual(behavior.tickScene.call(self, "S", 21), 42);
    assert.deepStrictEqual(calls, [{ self, scene: "S", now: 21 }]);
    assert.deepStrictEqual(aggro.wrapBehaviorExports(behavior), { ok: false, reason: "ALREADY_WRAPPED" });
    assert.deepStrictEqual(createNpcAggro().wrapBehaviorExports(behavior), { ok: false, reason: "ALREADY_WRAPPED" });
    assert.deepStrictEqual(createNpcAggro().wrapBehaviorExports({ tickScene }),
      { ok: false, reason: "SHAPE_MISMATCH" });
    assert.deepStrictEqual(aggro.activate({ wing: fakeWing(new Set()) }), { ok: false, reason: "SELFCHECK_MISSING" });
    assert.strictEqual(aggro.isActive(), false);

    const s = activeSetup();
    const twin = twinEntity();
    s.aggro.attach(twin);
    assert.throws(() => s.behavior.tickControllersByEntityID(() => {
      assert.deepStrictEqual(s.aggro.scope(), { depth: 1, suspended: 0 });
      throw new Error("vendor");
    }), /vendor/);
    assert.deepStrictEqual(s.aggro.scope(), { depth: 0, suspended: 0 });
    let suspendedClass = "unset";
    let nested = null;
    s.behavior.tickScene(() => s.proto.activateGenericModule(twin, () => {
      suspendedClass = actorClass(twin);
      nested = s.behavior.tickScene(() => actorClass(twin));
      assert.deepStrictEqual(s.aggro.scope(), { depth: 1, suspended: 1 }, "suspension restored after the nest");
    }));
    assert.strictEqual(suspendedClass, null, "inside the action: no overlay");
    assert.strictEqual(nested, "player", "nested scope inside a suspension sees the overlay");
    assert.deepStrictEqual(s.aggro.scope(), { depth: 0, suspended: 0 });
    s.twins.clear();
    assert.strictEqual(s.behavior.tickScene(() => s.aggro.scope().depth), 0, "no live twin: pass-through");
    assert.ok(s.aggro.stats().counters["npcAggro.scopes"] >= 3);
  });

  test("NA4 suspension: inside the scope the 3 methods see null, outside a pass-through; prototype without "
    + "launchMissile -> SEAM_UNAVAILABLE, nothing wrapped, status suspend_SEAM_UNAVAILABLE, never the overlay; "
    + "self check refusal", () => {
    const s = activeSetup();
    const twin = twinEntity();
    s.aggro.attach(twin);
    s.behavior.tickScene(() => {
      for (const name of SUSPEND_METHODS) s.proto[name](twin);
      s.seen.push(`after:${actorClass(twin)}`);
    });
    for (const name of SUSPEND_METHODS) s.proto[name](twin);
    assert.deepStrictEqual(s.seen, [...SUSPEND_METHODS.map((n) => `${n}:null`), "after:player",
      ...SUSPEND_METHODS.map((n) => `${n}:null`)]);
    assert.ok(SUSPEND_METHODS.every((n) => s.proto[n][SUSPEND_WRAPPED] === true));
    assert.deepStrictEqual(createNpcAggro().installSuspension(s.proto), { ok: false, reason: "ALREADY_INSTALLED" });

    const partial = fakeProto([]);
    delete partial.launchMissile;
    const before = { ...partial };
    const twins = new Set([4200000000000001]);
    const behavior = { tickScene: (fn) => fn(), tickControllersByEntityID: (fn) => fn() };
    const aggro = createNpcAggro();
    aggro.wrapBehaviorExports(behavior);
    aggro.selfCheck({ resolveCombatActorClass: actorClass });
    assert.deepStrictEqual(aggro.installSuspension(partial), { ok: false, reason: "SEAM_UNAVAILABLE" });
    assert.deepStrictEqual(partial, before, "0 methods wrapped");
    assert.strictEqual(aggro.status(), "suspend_SEAM_UNAVAILABLE");
    assert.deepStrictEqual(aggro.activate({ wing: fakeWing(twins) }), { ok: false, reason: "SUSPEND_MISSING" });
    const lone = twinEntity();
    assert.deepStrictEqual(aggro.attach(lone), { ok: false, reason: "NOT_ACTIVE" });
    assert.strictEqual(behavior.tickScene(() => actorClass(lone)), null, "never the overlay");

    const bad = createNpcAggro();
    assert.deepStrictEqual(bad.selfCheck({ resolveCombatActorClass: () => "player" }),
      { ok: false, reason: "SELFCHECK_FAILED" });
    assert.deepStrictEqual(bad.selfCheck(null), { ok: false, reason: "SELFCHECK_FAILED" });
    assert.strictEqual(bad.status(), "selfcheck_failed");
  });
};
