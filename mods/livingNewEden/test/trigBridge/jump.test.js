"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rules = require("../../lib/trigBridge/rules");
const { createTrigBridgeService } = require("../../lib/trigBridge/service");
const scopeLib = require("../../lib/adapter/trigBridge");
const { functionBody } = require("../../lib/adapter/essRepositoryFast");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const MGR_FILE = path.join(SERVER_SRC, ...`${scopeLib.JUMP_MGR_PATH}.js`.split("/"));
const LY = 9460730472580800;
const CFG = Object.freeze({ enabled: true, maxRangeLy: 50, fuelLyPermille: 20, jumpCooldownMs: 600000,
  maxPairsPerAlliance: 1, coreTypeId: 341640, requireRole: true, statusMail: true, debugCommand: false,
  presentationTypeId: 0, listMax: 2000 });
const MARK = Object.freeze({ v: 1, installedAt: 1, installedBy: 90000001, coreTypeId: 341640 });

const textOf = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function rig(opts = {}) {
  const o = { srcMarked: true, dstMarked: true, pending: false, ship: { mass: 2.3e9 }, item: { itemID: 900,
    typeID: 587 }, typeMass: 0, throwSync: false, ...opts };
  const systems = new Map([[1, { solarSystemID: 1, position: { x: 0, y: 0, z: 0 } }],
    [2, { solarSystemID: 2, position: { x: 50 * LY, y: 0, z: 0 } }]]);
  const row = (id, sys, dest, marked) => ({ structureID: id, solarSystemID: sys, typeID: 35841,
    devFlags: { destinationSolarsystemID: dest, ...(marked ? { lneTrigBridge: { ...MARK } } : {}) } });
  const rows = new Map([[101, row(101, 1, 2, o.srcMarked)], [102, row(102, 2, 1, o.dstMarked)]]);
  const worldData = {
    getSolarSystemByID: (id) => systems.get(Number(id)) || null,
    getMovementAttributesForType: () => ({ mass: o.typeMass }),
  };
  const calls = { getStructure: 0, vendor: 0, seen: [], after: [] };
  const structureState = {
    getStructureByID: (id) => { calls.getStructure += 1; return rows.get(id) || null; },
    listStructures: () => [...rows.values()],
  };
  const links = { findReciprocalJumpBridge: (src, list) => list.find((r) => r.solarSystemID
    === src.devFlags.destinationSolarsystemID && r.devFlags.destinationSolarsystemID === src.solarSystemID) || null };
  const ship = o.ship;
  const readDistance = () => {
    const a = worldData.getSolarSystemByID(1);
    const b = worldData.getSolarSystemByID(2);
    return Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z) / LY;
  };
  const readCapitalZoneLy = () => {
    const from = worldData.getSolarSystemByID(2);
    const to = worldData.getSolarSystemByID(1);
    return Math.hypot(to.position.x - from.position.x, to.position.y - from.position.y,
      to.position.z - from.position.z) / LY;
  };
  const readMass = () => {
    const direct = Number.isFinite(Number(ship && ship.mass)) ? Number(ship.mass) : Number(o.item.mass) || 0;
    return direct > 0 ? direct : worldData.getMovementAttributesForType(o.item.typeID).mass;
  };
  class FakeMgr {
    Handle_CmdJumpThroughStructureStargate(args, session) {
      calls.vendor += 1;
      calls.seen.push({ ly: readDistance(), mass: readMass(), zoneLy: readCapitalZoneLy(), self: this, session, args });
      if (o.throwSync) throw o.throwSync;
      return Promise.resolve().then(() => {
        calls.after.push({ ly: readDistance(), mass: readMass() });
        return { bound: args[0] };
      });
    }
  }
  FakeMgr.findPendingJumpBridgeSettlementForCharacter = () => (o.pending === true ? { operationID: "x" }
    : o.pending || null);
  const thrown = [];
  const throwUserError = (name, values) => {
    const err = Object.assign(new Error(`${name}: ${values && values.notify}`), { userError: name, values });
    thrown.push(err);
    throw err;
  };
  const clock = { t: 1000000, now() { return this.t; } };
  const counts = [];
  const telemetry = { count: (name, n) => { counts.push([name, n]); return true; } };
  const service = createTrigBridgeService({ cfg: CFG, clock, telemetry });
  const deps = { serviceClass: FakeMgr, sourceText: null, worldData, runtime: { getEntity: () => ship },
    structureState, links, characterState: { getActiveShipRecord: () => o.item }, throwUserError,
    decide: service.decide, onJump: service.onJump, onEvent: service.onEvent, driftCheck: () => null };
  return { o, FakeMgr, worldData, ship, calls, thrown, clock, counts, service, deps, systems };
}

const SESSION = Object.freeze({ characterID: 90000002, _space: { systemID: 1 } });

function vendorShapedClass(text) {
  const body = scopeLib.methodBody(text, scopeLib.SCOPE_METHOD);
  const cls = vm.runInThisContext(`(class StructureJumpBridgeMgrService {\n  ${body}\n})`);
  const fn = (name) => vm.runInThisContext(`(${functionBody(text, name)})`);
  cls._testing = { MAX_ANSIBLEX_RANGE_LY: 5, getSolarSystemDistanceLy: fn("getSolarSystemDistanceLy"),
    calculateLiquidOzoneRequired: fn("calculateLiquidOzoneRequired") };
  cls.findPendingJumpBridgeSettlementForCharacter = () => null;
  return cls;
}

module.exports = ({ test, skip }) => {
  test("TB1 effectiveLy / scaledDestinationPosition / effectiveMassKg / ozone / marker / W126", () => {
    assert.strictEqual(rules.effectiveLy(50, 20, 5), 1);
    assert.strictEqual(rules.effectiveLy(300, 20, 5), 5, "cut to the vendor range");
    assert.strictEqual(rules.effectiveLy(0, 20, 5), 0);
    const p = rules.scaledDestinationPosition({ x: 0, y: 0, z: 0 }, { x: 50 * LY, y: 10, z: -20 }, 50, 1);
    assert.deepStrictEqual(p, { x: LY, y: 0.2, z: -0.4 });
    assert.strictEqual(rules.effectiveMassKg(2.3e9), 1.48e9);
    assert.strictEqual(rules.effectiveMassKg(1e8), 1e8);
    assert.strictEqual(rules.effectiveMassKg(-1), 0);
    assert.deepStrictEqual([rules.estimateOzone(1e8, 5), rules.estimateOzone(1e8, 1), rules.estimateOzone(1.48e9, 1),
      rules.estimateOzone(1e4, 0.1), rules.estimateOzone(0, 3)], [1550, 350, 4490, 51, 50]);
    assert.strictEqual(rules.isTrigMarker({ devFlags: { lneTrigBridge: { ...MARK } } }), true);
    for (const bad of [null, {}, { devFlags: {} }, { devFlags: { lneTrigBridge: { ...MARK, v: 2 } } },
      { devFlags: { lneTrigBridge: { ...MARK, installedBy: 0 } } }, { devFlags: { lneTrigBridge: true } }]) {
      assert.strictEqual(rules.isTrigMarker(bad), false, JSON.stringify(bad));
    }
    const ok = rules.validateConfig(CFG);
    assert.deepStrictEqual([ok.ok, ok.warnings, hasOwn(ok.cfg, "maxShipMassKg")], [true, [], false]);
    const w = rules.validateConfig({ ...CFG, maxRangeLy: 120, fuelLyPermille: 100 });
    assert.ok(w.ok && w.warnings.length === 1 && w.warnings[0].startsWith("W126"), w.warnings.join("|"));
    assert.strictEqual(rules.validateConfig(null).ok, false);
  });

  test("TB2 decideJump: RANGE, COOLDOWN, NO_POSITION, ok after the cooldown", () => {
    const at = 5000000;
    assert.deepStrictEqual(rules.decideJump({ realLy: 50, lastJumpAt: null, now: at, cfg: CFG }), { ok: true, effLy: 1 });
    const range = rules.decideJump({ realLy: 50.01, lastJumpAt: null, now: at, cfg: CFG });
    assert.deepStrictEqual([range.ok, range.reason], [false, "RANGE"]);
    const cd = rules.decideJump({ realLy: 10, lastJumpAt: at - 1000, now: at, cfg: CFG });
    assert.deepStrictEqual([cd.ok, cd.reason, cd.detail], [false, "COOLDOWN", "599000"]);
    assert.strictEqual(rules.decideJump({ realLy: 10, lastJumpAt: at - 600000, now: at, cfg: CFG }).ok, true);
    for (const realLy of [NaN, 0, -1, undefined]) {
      assert.strictEqual(rules.decideJump({ realLy, lastJumpAt: null, now: at, cfg: CFG }).reason, "NO_POSITION");
    }
    assert.ok(/600 s/.test(rules.refusalMessage("COOLDOWN", "599001")));
  });

  test("TB3 scope: scaled distance + capped mass inside, exact restore after the promise and after a throw", async () => {
    const r = rig();
    const getter = r.worldData.getSolarSystemByID;
    const scope = scopeLib.createJumpScope(r.deps);
    assert.deepStrictEqual(scope.install(), { ok: true });
    const mgr = new r.FakeMgr();
    const args = [101];
    const p = mgr.Handle_CmdJumpThroughStructureStargate(args, SESSION);
    assert.strictEqual(r.calls.vendor, 1);
    const seen = r.calls.seen[0];
    assert.ok(Math.abs(seen.ly - 1) < 1e-9, `scaled distance ${seen.ly}`);
    assert.ok(Math.abs(seen.zoneLy - 50) < 1e-9, `capacitor zone lookup sees the real destination ${seen.zoneLy}`);
    assert.strictEqual(seen.mass, 1480000000);
    assert.strictEqual(seen.self, mgr, "same this");
    assert.strictEqual(seen.args, args, "same arguments");
    assert.strictEqual(r.worldData.getSolarSystemByID, getter, "exact previous getter reference");
    assert.strictEqual(r.systems.get(2).position.x, 50 * LY, "vendor row untouched");
    assert.strictEqual(r.ship.mass, 2.3e9);
    assert.deepStrictEqual(await p, { bound: 101 }, "vendor result unchanged");
    await flush();
    assert.ok(Math.abs(r.calls.after[0].ly - 50) < 1e-9, "settlement after the scope sees the real distance");
    const counted = Object.fromEntries(r.counts.map(([n, v]) => [n, v]));
    assert.deepStrictEqual([counted["trigBridge.jumps"], counted["trigBridge.jumpsHeavy"]], [1, 1]);
    r.clock.t += 1000;
    assert.throws(() => mgr.Handle_CmdJumpThroughStructureStargate([101], SESSION), (e) => e.userError === "CustomNotify");
    assert.strictEqual(r.calls.vendor, 1, "vendor not called on a refusal");
    assert.strictEqual(r.service.getStatus().counters.refusedCooldown, 1);
    scope.uninstall();

    for (const throwSync of [false, new Error("vendor boom")]) {
      const s = rig({ ship: { itemID: 900 }, item: { itemID: 900, typeID: 587, mass: 1e8 }, throwSync });
      const g = s.worldData.getSolarSystemByID;
      const sc = scopeLib.createJumpScope(s.deps);
      assert.ok(sc.install().ok);
      const m = new s.FakeMgr();
      if (throwSync) {
        assert.throws(() => m.Handle_CmdJumpThroughStructureStargate([101], SESSION), (e) => e === throwSync);
      } else {
        await m.Handle_CmdJumpThroughStructureStargate([101], SESSION);
      }
      assert.strictEqual(s.calls.seen[0].mass, 1e8);
      assert.ok(Math.abs(s.calls.seen[0].ly - 1) < 1e-9);
      assert.strictEqual(hasOwn(s.ship, "mass"), false, "no mass field after the scope");
      assert.strictEqual(s.worldData.getSolarSystemByID, g);
      sc.uninstall();
    }
  });

  test("TB4 pass-through: vanilla end, pending settlement, DRIFT = no wrap, second install refused", async () => {
    for (const opt of [{ srcMarked: false }, { dstMarked: false }, { pending: true }]) {
      const r = rig(opt);
      const sc = scopeLib.createJumpScope(r.deps);
      assert.ok(sc.install().ok);
      await new r.FakeMgr().Handle_CmdJumpThroughStructureStargate([101], SESSION);
      const seen = r.calls.seen[0];
      assert.ok(Math.abs(seen.ly - 50) < 1e-9, `${JSON.stringify(opt)}: real distance`);
      assert.strictEqual(seen.mass, 2.3e9, `${JSON.stringify(opt)}: real mass (vanilla refuses it itself)`);
      if (opt.pending) assert.strictEqual(r.calls.getStructure, 0, "pending: no structure read");
      assert.strictEqual(r.service.getStatus().counters.passthroughVanilla, 1);
      sc.uninstall();
    }
    for (const [opt, jumps] of [[{ pending: { operationID: "x", sourceStructureID: 101 } }, 1],
      [{ pending: { operationID: "x", sourceStructureID: 999 } }, 0],
      [{ pending: { operationID: "x", sourceStructureID: 101 }, dstMarked: false }, 0]]) {
      const r = rig(opt);
      const sc = scopeLib.createJumpScope(r.deps);
      assert.ok(sc.install().ok);
      await new r.FakeMgr().Handle_CmdJumpThroughStructureStargate([101], SESSION);
      await flush();
      assert.ok(Math.abs(r.calls.seen[0].ly - 50) < 1e-9, `${JSON.stringify(opt)}: resume without the scope`);
      const st = r.service.getStatus();
      assert.deepStrictEqual([st.counters.jumps, st.cooldowns], [jumps, jumps], JSON.stringify(opt));
      sc.uninstall();
    }
    const f = rig();
    f.deps.characterState = { getActiveShipRecord: () => { throw new Error("read failed"); } };
    const fs1 = scopeLib.createJumpScope(f.deps);
    assert.ok(fs1.install().ok);
    await new f.FakeMgr().Handle_CmdJumpThroughStructureStargate([101], SESSION);
    assert.ok(Math.abs(f.calls.seen[0].ly - 50) < 1e-9);
    assert.strictEqual(f.service.getStatus().counters.scopeErrors, 1);
    assert.deepStrictEqual(fs1.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    fs1.uninstall();

    const d = rig();
    const original = d.FakeMgr.prototype.Handle_CmdJumpThroughStructureStargate;
    const { driftCheck: _ignored, ...realDeps } = d.deps;
    const drift = scopeLib.createJumpScope({ ...realDeps, sourceText: fs.existsSync(MGR_FILE) ? textOf(MGR_FILE) : "" });
    const refused = drift.install();
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "TRIG_BRIDGE_DRIFT"]);
    assert.strictEqual(d.FakeMgr.prototype.Handle_CmdJumpThroughStructureStargate, original, "nothing wrapped");
    if (!fs.existsSync(MGR_FILE)) return;
    const text = textOf(MGR_FILE);
    const cls = vendorShapedClass(text);
    assert.strictEqual(scopeLib.driftDetail(cls, text), null);
    assert.deepStrictEqual(scopeLib.checkJumpScope({ ...realDeps, serviceClass: cls, sourceText: text }), { ok: true });
    cls._testing.MAX_ANSIBLEX_RANGE_LY = 6;
    assert.ok(/MAX_ANSIBLEX_RANGE_LY$/.test(scopeLib.driftDetail(cls, text)));
    assert.ok(/:missing$/.test(scopeLib.driftDetail(cls, null)));
  });

  const tb5 = "TB5 vendor facts: constants, the only getSolarSystemByID use, mass order, :1282 legacy-only, "
    + "settlement after the sync window, SHA-1 of the three bodies";
  if (!fs.existsSync(MGR_FILE)) {
    skip(tb5, `vendor file missing: ${MGR_FILE}`);
    return;
  }
  test(tb5, () => {
    const text = textOf(MGR_FILE);
    for (const line of ["const MAX_ANSIBLEX_RANGE_LY = 5;", "const MAX_ANSIBLEX_SHIP_MASS_KG = 1480000000;",
      "const LIGHT_YEAR_METERS = 9460730472580800;"]) assert.ok(text.includes(line), line);
    assert.deepStrictEqual([rules.VENDOR_RANGE_LY, rules.VENDOR_MAX_MASS_KG, scopeLib.VENDOR_RANGE_LY,
      scopeLib.VENDOR_MAX_MASS_KG, scopeLib.LIGHT_YEAR_METERS], [5, 1480000000, 5, 1480000000, LY]);
    const distance = functionBody(text, "getSolarSystemDistanceLy");
    assert.strictEqual(text.split("worldData.getSolarSystemByID(").length - 1, 2);
    assert.strictEqual(distance.split("worldData.getSolarSystemByID(").length - 1, 2);
    assert.ok(text.includes("const worldData = require(path.join(__dirname, \"../../space/worldData\"));"));
    const mass = functionBody(text, "resolveShipMassKg");
    const at = ["shipEntity && shipEntity.mass", "shipItem && shipItem.mass", "getMovementAttributesForType("]
      .map((s) => mass.indexOf(s));
    assert.ok(at.every((i) => i >= 0) && at[0] < at[1] && at[1] < at[2], `mass order ${at}`);
    assert.strictEqual(text.split("> MAX_ANSIBLEX_SHIP_MASS_KG").length - 1, 2);
    const transition = functionBody(text, "canApplyJumpBridgeTransition");
    const legacyAt = transition.indexOf("if (sourceStructure.legacyStarbase === true) {");
    const legacy = transition.slice(legacyAt, transition.indexOf("\n  }\n", legacyAt));
    assert.ok(legacyAt >= 0 && legacy.includes("shipMass > MAX_ANSIBLEX_SHIP_MASS_KG"), "the :1282 check is legacy-only");
    assert.ok(functionBody(text, "settlePendingJumpBridge").includes("return runJumpBridgeSerialized("));
    assert.ok(functionBody(text, "runJumpBridgeSerialized").includes(".then(operation)"));
    const method = scopeLib.methodBody(text, scopeLib.SCOPE_METHOD);
    const startAt = method.indexOf("const sourceStructure = getStructureByID(structureID);");
    const tail = method.slice(startAt);
    const order = ["getSolarSystemDistanceLy(", "shipMassKg > MAX_ANSIBLEX_SHIP_MASS_KG", "calculateLiquidOzoneRequired(",
      "jumpBridgeCapacitor.calculateJumpCapacitorCost(", "prepareJumpBridgeSettlement(", "await settlePendingJumpBridge("]
      .map((s) => tail.indexOf(s));
    assert.ok(startAt > 0 && order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `handler order ${order}`);
    const capFile = path.join(SERVER_SRC, "services", "structure", "structureJumpBridgeCapacitor.js");
    const cap = textOf(capFile);
    assert.ok(cap.includes("const worldData = require(path.join(__dirname, \"../../space/worldData\"));"));
    assert.strictEqual(cap.split("worldData.getSolarSystemByID(").length - 1, 2, "capacitor lookups");
    const lookup = functionBody(cap, "getClientLightYearDistance");
    assert.ok(lookup.indexOf("worldData.getSolarSystemByID(fromSolarSystemID)")
      < lookup.indexOf("worldData.getSolarSystemByID(toSolarSystemID)"), "capacitor looks up from first");
    assert.ok(functionBody(cap, "getCapacitorZoneModifierAndIdx")
      .includes("getClientLightYearDistance(destinationSolarSystemID, capitalSolarSystemID)"),
    "the destination is looked up first, never right after the source");
    assert.strictEqual(tail.split("await ").length - 1, 1, "one await after the pending branch");
    assert.ok(text.includes("StructureJumpBridgeMgrService.findPendingJumpBridgeSettlementForCharacter ="));
    const crypto = require("node:crypto");
    const sha1 = (t) => crypto.createHash("sha1").update(t).digest("hex");
    assert.strictEqual(sha1(method), scopeLib.METHOD_SHA1);
    for (const name of Object.keys(scopeLib.FUNCTION_SHA1)) {
      assert.strictEqual(sha1(functionBody(text, name)), scopeLib.FUNCTION_SHA1[name], name);
    }
    const cls = vendorShapedClass(text);
    assert.strictEqual(String(cls.prototype[scopeLib.SCOPE_METHOD]), method);
    assert.ok(text.includes("  async Handle_CmdJumpThroughStructureStargate(args, session) {"));
  });
};
