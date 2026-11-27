"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const P = require("../../lib/adapter/trigBridgePresentation");
const { startTrigBridge } = require("../../lib/trigBridge");
const { isGmSession } = require("../../lib/adapter/chatCommand");
const { symbolPresent } = require("../../lib/adapter/probe");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const LOOK = 47685;
const MARK = Object.freeze({ v: 1, installedAt: 1, installedBy: 90000001, coreTypeId: 341640 });
const CFG = Object.freeze({ enabled: true, maxRangeLy: 50, fuelLyPermille: 20, jumpCooldownMs: 600000,
  maxPairsPerAlliance: 1, coreTypeId: 341640, requireRole: true, statusMail: false, debugCommand: false,
  presentationTypeId: LOOK, listMax: 2000 });

const textOf = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");

function rig() {
  const rows = new Map([
    [101, { structureID: 101, solarSystemID: 1, typeID: 35841, devFlags: { lneTrigBridge: { ...MARK } } }],
    [102, { structureID: 102, solarSystemID: 1, typeID: 35841, devFlags: {} }],
    [103, { structureID: 103, solarSystemID: 2, typeID: 35841, devFlags: { lneTrigBridge: { ...MARK } } }],
  ]);
  const calls = { added: [], slim: [], sceneGets: [] };
  class SolarSystemScene {
    constructor() {
      this.staticEntitiesByID = new Map();
    }

    addStaticEntity(entity) {
      calls.added.push({ self: this, slimAtCall: entity.slimTypeID });
      if (this.staticEntitiesByID.has(entity.itemID)) return false;
      this.staticEntitiesByID.set(entity.itemID, entity);
      return true;
    }

    broadcastSlimItemChanges(entities) {
      calls.slim.push(entities.map((e) => [e.itemID, e.slimTypeID]));
    }
  }
  const scene = new SolarSystemScene();
  const scenes = new Map([[1, scene]]);
  const realGet = scenes.get.bind(scenes);
  scenes.get = (id) => {
    calls.sceneGets.push(id);
    return realGet(id);
  };
  const v = { sceneModule: { SolarSystemScene }, structureState: { getStructureByID: (id) => rows.get(id) || null },
    runtime: { isSolarSystemSceneLoaded: (id) => id === 1, scenes } };
  const entity = (id, extra = {}) => ({ kind: "structure", itemID: id, typeID: 35841, ...extra });
  return { rows, calls, SolarSystemScene, scene, v, entity };
}

function fakeAdapter(f, registry) {
  let look = null;
  const installs = [];
  return { installs,
    installTrigBridgeJumpScope: () => ({ ok: true }), uninstallTrigBridgeJumpScope: () => ({ ok: true }),
    installTrigBridgePresentation: (opts) => {
      installs.push(opts.typeId);
      look = P.createPresentation({ ...f.v, ...opts });
      return look.install();
    },
    applyTrigBridgePresentation: (id) => (look ? look.apply(id) : { ok: false, reason: "NOT_INSTALLED" }),
    uninstallTrigBridgePresentation: () => { if (look) look.uninstall(); return { ok: true }; },
    listTrigBridges: () => ({ ok: true, truncated: false, rows: [...f.rows.values()]
      .filter((r) => r.devFlags.lneTrigBridge).map((r) => ({ structureId: r.structureID })) }),
    trigBridgeCoreType: (t) => ({ ok: true, found: registry.includes(t), fuel: false, name: "Transfer Conduit" }) };
}

function boot(f, cfg, registry = [LOOK, 341640]) {
  const adapter = fakeAdapter(f, registry);
  const lines = [];
  const r = startTrigBridge({ config: { trigBridge: { ...CFG, ...cfg } }, adapter, clock: { now: () => 1700000000000 },
    logger: { log: (l) => lines.push(l) }, persistence: null });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { r, adapter, lines };
}

module.exports = ({ test }) => {
  test("TP1 addStaticEntity wrap: marked 35841 gets slimTypeID before the original, others not; apply on a loaded"
    + " scene + slim change; flag 0 = no wrap; W127 = no wrap", () => {
    const f = rig();
    const old = f.entity(101);
    f.scene.addStaticEntity(old);
    const base = f.SolarSystemScene.prototype.addStaticEntity;
    const b = boot(f, {});
    assert.ok(b.lines.some((l) => l.startsWith(`trigBridge: presentation on typeId=${LOOK}`) && l.endsWith("applied=1")),
      b.lines.join("\n"));
    assert.strictEqual(old.slimTypeID, LOOK, "the start pass sets the entity of the loaded scene");
    assert.deepStrictEqual(f.calls.slim, [[[101, LOOK]]], "one slim change for that entity");
    assert.ok(!f.calls.sceneGets.includes(2), "a scene not loaded is never read");
    const st = () => b.r.trigBridge.getStatus();
    assert.deepStrictEqual([st().presentation, st().counters.presentationApplied], ["on", 1]);

    const other = new f.SolarSystemScene();
    const fresh = f.entity(103);
    assert.strictEqual(other.addStaticEntity(fresh), true);
    assert.deepStrictEqual([f.calls.added.at(-1).slimAtCall, f.calls.added.at(-1).self === other], [LOOK, true]);
    const vanilla = f.entity(102);
    const citadel = f.entity(101, { typeID: 35832 });
    const ship = { kind: "ship", itemID: 101, typeID: 35841 };
    for (const e of [vanilla, citadel, ship]) other.addStaticEntity(e);
    assert.ok([vanilla, citadel, ship].every((e) => !Object.prototype.hasOwnProperty.call(e, "slimTypeID")));
    assert.strictEqual(other.addStaticEntity(fresh), false, "the vendor refusal (duplicate) comes back unchanged");
    assert.strictEqual(st().counters.presentationApplied, 2);
    assert.deepStrictEqual([b.adapter.applyTrigBridgePresentation(101), b.adapter.applyTrigBridgePresentation(102),
      b.adapter.applyTrigBridgePresentation(999)], [{ ok: true, applied: false }, { ok: true, applied: false },
      { ok: true, applied: false }]);
    b.r.trigBridge.stop("test");
    assert.strictEqual(f.SolarSystemScene.prototype.addStaticEntity, base);

    const z = rig();
    const zb = boot(z, { presentationTypeId: 0 });
    assert.deepStrictEqual([zb.adapter.installs, zb.r.trigBridge.getStatus().presentation], [[], "off"]);
    const e0 = z.entity(101);
    new z.SolarSystemScene().addStaticEntity(e0);
    assert.ok(!("slimTypeID" in e0));
    const w = rig();
    const wb = boot(w, {}, [341640]);
    assert.ok(wb.lines.some((l) => l.startsWith(`trigBridge: W127 trigBridge.presentationTypeId ${LOOK}`)),
      wb.lines.join("\n"));
    assert.deepStrictEqual([wb.adapter.installs, wb.r.trigBridge.getStatus().presentation], [[], "off:W127"]);
  });

  test("TP2 vendor facts: slimTypeID in buildSlimItemDict, Object.assign in the structure refresh, writable scene"
    + " methods, slim change method, GM role test of the vendor chat commands", () => {
    const destiny = textOf("space/destiny/index.js");
    const slim = destiny.slice(destiny.indexOf("function buildSlimItemDict(entity) {"));
    assert.ok(slim.length > 0 && destiny.includes("function buildSlimItemDict(entity) {"));
    const head = slim.slice(0, slim.indexOf("const entries = ["));
    assert.ok(head.includes("entity && entity.slimTypeID,\n    toInt32(entity && entity.typeID, 0),"), "slimTypeID first");
    assert.ok(head.includes("entity && entity.slimGroupID,\n    toInt32(entity && entity.groupID, 0),"),
      "the group stays the entity's");
    assert.ok(slim.includes("[\"typeID\", slimTypeID],"));
    const statics = textOf("space/runtime/scene/staticEntities.js");
    const sync = statics.slice(statics.indexOf("syncStructureEntitiesFromState(options = {}) {"));
    assert.ok(statics.includes("addStaticEntity(entity) {") && sync.length > 0);
    const merge = sync.indexOf("const nextEntity = buildStaticStructureEntity(structure);");
    assert.ok(merge > 0 && sync.indexOf("Object.assign(entity, nextEntity);") > merge, "refresh merges into the entity");
    assert.ok(sync.includes("const entity = buildStaticStructureEntity(structure);")
      && sync.includes("if (this.addStaticEntity(entity)) {"), "a new structure goes through addStaticEntity");
    const built = textOf("space/runtime/staticSceneEntity.js");
    const builder = built.slice(built.indexOf("function buildStaticStructureEntity(structure) {"),
      built.indexOf("function buildStaticCelestialEntity("));
    assert.ok(builder.length > 0 && !builder.includes("slimTypeID"), "the refresh entity has no slimTypeID");
    const runtime = textOf("space/runtime.js");
    const define = runtime.slice(runtime.indexOf("Object.defineProperty(SolarSystemScene.prototype, methodName, {"));
    assert.ok(define.length > 0 && /^\s+\.\.\.descriptor,\n\s+enumerable: false,\n\s+writable: true,/m
      .test(define.slice(0, 200)), "scene methods writable");
    assert.ok(/Object\.assign\(module\.exports, \{\n {2}SolarSystemScene,/.test(textOf("space/runtime/solarSystemScene.js")));
    assert.ok(textOf("space/runtime/scene/presentation.js").includes("broadcastSlimItemChanges(entities) {"));
    const look = GAME_MODULES.find((e) => e.path === P.SCENE_PATH).symbols.find((s) => s.name === P.ADD_METHOD);
    assert.deepStrictEqual([look.kind, look.wrap, look.classExport], ["classPrototypeMethod", true, P.SCENE_CLASS]);
    class Scene { addStaticEntity() { return true; } }
    assert.deepStrictEqual([symbolPresent({ SolarSystemScene: Scene }, look), symbolPresent({}, look),
      symbolPresent(Scene, look)], [true, false, false]);
    const chat = textOf("services/chat/chatCommands.js");
    assert.ok(chat.includes("const role = normalizeRoleValue(session?.accountRole ?? session?.role, 0n);")
      && chat.includes("if ((role & (ROLE_GML | ROLE_WORLDMOD)) === 0n) {"));
    const roles = textOf("services/account/accountRoleProfiles.js");
    assert.ok(roles.includes("const ROLE_GML = 18014398509481984n;") && roles.includes("const ROLE_WORLDMOD = 4096n;"));
    assert.deepStrictEqual([isGmSession({ accountRole: 18014398509481984n }), isGmSession({ role: "4096" }),
      isGmSession({ accountRole: { type: "long", value: "18014398509481984" } }), isGmSession({ role: 2048 }),
      isGmSession({}), isGmSession(null), isGmSession({ accountRole: "x" })], [true, true, true, false, false, false,
      false]);
  });
};
