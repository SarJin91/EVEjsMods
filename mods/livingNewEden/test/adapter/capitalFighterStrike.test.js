"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const strike = require("../../lib/adapter/npcFighterStrike");
const plan = require("../../lib/adapter/fighterStrikePlan");
const data = require("../../lib/adapter/data/capitalLiveProfiles");
const { TYPES } = require("../../lib/battle/data/strengthCatalog");
const { CAPITAL_STRENGTH_ROWS } = require("../../lib/battle/data/capitalStrengthRows");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const config = require("../../config");
const loader = require("../../loader");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_SRC = path.join(REPO_ROOT, "server", "src");
const MOD_DIR = path.resolve(__dirname, "..", "..");
const CATALOG = Object.freeze({ TYPES, CAPITAL_STRENGTH_ROWS });
const SUPER = "lne_capital_500003_supercarrier";
const SUPER_TYPE = 23919;
const INDEX = { 500003: { supercarrier: { profileId: SUPER, typeId: SUPER_TYPE } } };

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

const sum = (v) => (v ? v.em + v.thermal + v.kinetic + v.explosive : 0);

function world(opts = {}) {
  const calls = { apply: [], note: [], record: [], notify: [], follow: [], orbit: [], fx: [], turret: [], missile: [],
    tools: 0, gate: 0 };
  const entity = { itemID: 100, kind: "ship" };
  const target = { itemID: 900, kind: "ship" };
  const fighters = (opts.fighters || [501]).map((itemID) => ({ itemID, typeID: 40362, groupID: 1652, kind: "fighter",
    controllerID: 100, controllerOwnerID: 0 }));
  const snapshot = Object.freeze({ offensiveKind: "turret", rawShotDamage: Object.freeze({ em: 0, thermal: 100,
    kinetic: 100, explosive: 0 }), totalRawDamage: 200, durationMs: 4000, rangeMeters: 10000, falloffMeters: 5000,
  trackingSpeed: 1, optimalSigRadius: 125, effectGuid: "effects.ProjectileFired", ...(opts.snapshot || {}) });
  const scene = {
    followShipEntity: (f, id, d) => {
      Object.assign(f, { mode: "FOLLOW", targetEntityID: id });
      calls.follow.push([f.itemID, id, d]);
    },
    orbitShipEntity: (f, id, d) => {
      Object.assign(f, { mode: "ORBIT", targetEntityID: id });
      calls.orbit.push([f.itemID, id, d]);
    },
    broadcastSpecialFx: (id, guid, o) => calls.fx.push([id, guid, o.targetID, o.duration]),
  };
  const state = { distance: opts.distance === undefined ? 3000 : opts.distance, interact: opts.interact !== false,
    kill: opts.kill === true };
  const tools = {
    resolveFighterAbilitySnapshot: () => (opts.noSnapshot ? null : snapshot),
    getFighterOrbitDistance: () => 2000,
    resolveMissileAppliedDamage: (s) => {
      calls.missile.push(s.rawShotDamage);
      return { appliedDamage: { ...s.rawShotDamage } };
    },
    hasDamageableHealth: () => true,
    getSceneSurfaceDistance: () => state.distance,
    isWarping: () => false,
    canEntitiesInteractLocally: () => state.interact,
    listControlledNpcFighters: () => fighters,
    gateProbe: () => {
      calls.gate += 1;
      return opts.gate === undefined ? false : opts.gate;
    },
    droneInterop: {
      resolveTurretShot: (a) => {
        calls.turret.push(a.weaponSnapshot.rawShotDamage);
        return { hit: true, shotDamage: a.weaponSnapshot.rawShotDamage };
      },
      getCombatMessageHitQuality: () => 3,
      getAppliedDamageAmount: (d) => (d ? d.amount : 0),
      applyWeaponDamageToTarget: (sc, src, tgt, dmg) => {
        calls.apply.push({ src, dmg });
        return { damageResult: { amount: sum(dmg) }, destroyResult: state.kill ? { success: true } : null,
          victimSession: null };
      },
      noteKillmailDamage: (...a) => calls.note.push(a),
      recordKillmailFromDestruction: (...a) => calls.record.push(a),
      notifyWeaponDamageMessages: (...a) => calls.notify.push(a),
    },
  };
  const deps = {
    tools: () => {
      calls.tools += 1;
      return { ok: true, tools };
    },
    classIndex: () => ({ ok: true, index: plan.reverseIndex(INDEX) }),
    rowDps: (typeId, cls) => plan.rowDpsOf(typeId, cls, CATALOG),
    tubes: (cls) => data.FIGHTER_TUBES[cls] || 0,
    params: { dpsPermille: 1000, scaleMaxPermille: 20000 },
  };
  const controller = { profileID: SUPER };
  const behaviorProfile = { capitalFighterAbilitySlotID: 0, capitalFighterWingTypeIDs: [{}] };
  return { calls, entity, target, fighters, scene, state, tools, deps, controller, behaviorProfile };
}

function hit(w, nowMs, target = w.target) {
  return strike.strikeForController(w.scene, w.entity, w.controller, w.behaviorProfile, target, nowMs, w.deps);
}

function runLoader(materialization, extra = {}) {
  const DIRECTOR = path.join(path.sep, "x", "server", "src", "services", "fighter", "npc", "npcSupercarrierDirector");
  const PARENT = { filename: path.join(path.sep, "x", "server", "src", "space", "npc", "capitals",
    "capitalNpcBehavior.js") };
  const silent = { log: () => {}, logError: () => {}, debug: () => {} };
  const original = function syncNpcSupercarrierSystems() { return "vendor"; };
  const directorExports = { syncNpcSupercarrierSystems: original, launchNpcFighterWing: () => null };
  const moduleApi = { _cache: {}, _load: (request) => (request === DIRECTOR ? directorExports : {}) };
  const ctx = { state: {}, logger: silent, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
    config: { enabled: extra.enabled !== false, debug: false, dataDir: "/x",
      modules: { materialization: { enabled: extra.module !== false } },
      materialization: { capitalLiveEnabled: true, capitalFightersEnabled: true, capitalFighterDamageEnabled: true,
        capitalFighterDpsPermille: 1000, capitalFighterScaleMaxPermille: 20000, ...materialization } } }) };
  loader.installModuleHook(moduleApi, loader.buildHooks(ctx), silent);
  moduleApi._load(DIRECTOR, PARENT);
  return { ctx, directorExports, original };
}

module.exports = ({ test }) => {
  test("CF1 vendor facts: NPC gate branch, gate call in executeFighterOffensiveCycle, export only in _testing; "
    + "capitalNpcBehavior destructures the director; controllerOwnerID 0; droneInterop functions; seam exports; "
    + "registerNativeRuntimeController clones controllerRecord (profileID)", () => {
    const runtime = readSource("services/fighter/fighterRuntime.js");
    const gateBody = functionBody(runtime, "canPlayerCompanionActOnTarget");
    assert.ok(gateBody.includes("controllerEntity.kind === \"ship\""), "isPlayerShipController");
    assert.ok(/if \(!effectiveSession\) \{\n\s+return \(\n\s+!isPlayerShipController &&/.test(gateBody), "NPC branch");
    assert.ok(functionBody(runtime, "executeFighterOffensiveCycle").includes("canPlayerCompanionActOnTarget("));
    const exportsBlock = runtime.slice(runtime.indexOf("\nmodule.exports = {"));
    assert.ok(exportsBlock.includes("\n    canPlayerCompanionActOnTarget,\n"), "in _testing");
    assert.ok(!exportsBlock.includes("\n  canPlayerCompanionActOnTarget,\n"), "not a top-level export");
    assert.ok(exportsBlock.includes("\n  getFighterOrbitDistance,\n") && exportsBlock.includes("\n  _testing: {\n"));
    const behaviour = readSource("space/npc/capitals/capitalNpcBehavior.js");
    assert.ok(/const \{\n {2}launchNpcFighterWing,\n {2}syncNpcSupercarrierSystems,\n\} = require\(path\.join\(\n\s+__dirname,\n\s+"\.\.\/\.\.\/\.\.\/services\/fighter\/npc\/npcSupercarrierDirector",/
      .test(behaviour), "destructuring at require");
    const director = readSource("services/fighter/npc/npcSupercarrierDirector.js");
    assert.ok(director.includes("controllerOwnerID: 0,") && director.includes("fighterEntity.controllerOwnerID = 0;"));
    assert.ok(director.includes("\n  syncNpcSupercarrierSystems,\n"), "director export");
    assert.ok(/scene\.orbitShipEntity\(\n\s+fighterEntity,\n\s+controllerEntity\.itemID,\n\s+1_500,/.test(director),
      "controller orbit 1500 m");
    const space = readSource("space/runtime.js");
    const interop = space.slice(space.indexOf("runtimeExports.droneInterop = {"));
    assert.ok(space.includes("const runtimeExports = module.exports;"));
    for (const name of strike.INTEROP_FUNCTIONS) {
      assert.ok(new RegExp(`\\n {2}${name}(:|,)`).test(interop.slice(0, interop.indexOf("};"))), `droneInterop.${name}`);
    }
    const dogma = readSource("services/fighter/fighterDogma.js");
    assert.ok(dogma.includes("\n  resolveFighterAbilitySnapshot,\n"));
    for (const field of ["rawShotDamage,", "totalRawDamage:", "durationMs,", "rangeMeters,", "falloffMeters,",
      "effectGuid:", "offensiveKind,"]) assert.ok(functionBody(dogma, "resolveFighterAbilitySnapshot").includes(field), field);
    const seams = [["space/combat/missiles/missileSolver.js", "resolveMissileAppliedDamage"],
      ["space/combat/damage.js", "hasDamageableHealth"],
      ["space/destiny/authority/sceneRangeDecision.js", "getSceneSurfaceDistance"],
      ["space/destiny/simulation/evolve.js", "isWarping"],
      ["space/destiny/identity/interactionScope.js", "canEntitiesInteractLocally"],
      ["space/npc/capitals/capitalNpcState.js", "listControlledNpcFighters"]];
    for (const [file, name] of seams) assert.ok(readSource(file).includes(`\n  ${name},\n`), `${file} ${name}`);
    const native = functionBody(readSource("space/npc/nativeNpcService.js"), "registerNativeRuntimeController");
    assert.ok(native.includes("...cloneValue(controllerRecord),"), "controller = clone of controllerRecord");
    const director2 = GAME_MODULES.find((e) => e.path === "services/fighter/npc/npcSupercarrierDirector");
    assert.deepStrictEqual(director2.symbols.map((s) => [s.name, s.firstLoad, s.wrap, [...s.consumers]]),
      [["syncNpcSupercarrierSystems", true, true, ["capitalFighters"]]]);
  });

  test("CF2 wrap: same arguments to the original, its result unchanged; profile outside lne_capital_ -> zero deps "
    + "calls; second install = alreadyInstalled; a throw in the strike -> vendor result + fighterErrors 1; a foreign "
    + "wrap under and over ours", () => {
    strike._resetForTest();
    try {
      const w = world();
      const seen = [];
      const original = function syncNpcSupercarrierSystems(...args) { seen.push(args); return "changed"; };
      const exportsObj = { syncNpcSupercarrierSystems: original };
      const opts = { enabled: true, params: w.deps.params, deps: w.deps };
      assert.deepStrictEqual(strike.install(exportsObj, opts), { ok: true, alreadyInstalled: false });
      assert.deepStrictEqual(strike.install(exportsObj, opts), { ok: true, alreadyInstalled: true });
      const wrapped = exportsObj.syncNpcSupercarrierSystems;
      const options = { nowMs: 1000 };
      const vendorController = { profileID: "capital_true_sanshas_supercarrier" };
      assert.strictEqual(wrapped(w.scene, w.entity, vendorController, w.behaviorProfile, w.target, options), "changed");
      assert.strictEqual(seen[0][2], vendorController);
      assert.strictEqual(seen[0][5], options);
      assert.strictEqual(seen[0].length, 6);
      assert.strictEqual(w.calls.tools, 0, "vendor profile: no work of the mod");
      assert.strictEqual(wrapped(w.scene, w.entity, {}, w.behaviorProfile, w.target, options), "changed");
      assert.strictEqual(w.calls.tools, 0);
      assert.strictEqual(wrapped(w.scene, w.entity, w.controller, w.behaviorProfile, w.target, options), "changed");
      assert.strictEqual(w.calls.apply.length, 1);
      const throwing = { ...w.deps, tools: () => { throw new Error("boom"); } };
      strike._resetForTest();
      const exportsThrow = { syncNpcSupercarrierSystems: original };
      strike.install(exportsThrow, { enabled: true, params: w.deps.params, deps: throwing });
      assert.strictEqual(exportsThrow.syncNpcSupercarrierSystems(w.scene, w.entity, { profileID: SUPER },
        w.behaviorProfile, w.target, options), "changed");
      assert.strictEqual(strike.stats().errors, 1);
      const bad = { syncNpcSupercarrierSystems: () => { throw new Error("vendor"); } };
      strike.install(bad, { enabled: true, params: w.deps.params, deps: w.deps });
      assert.throws(() => bad.syncNpcSupercarrierSystems(w.scene, w.entity, w.controller), /vendor/);

      strike._resetForTest();
      const w2 = world();
      const order = [];
      const base = { syncNpcSupercarrierSystems: (...a) => { order.push(["vendor", a.length]); return 7; } };
      const under = base.syncNpcSupercarrierSystems;
      base.syncNpcSupercarrierSystems = function foreignUnder(...a) { order.push(["under"]); return under(...a) + 1; };
      strike.install(base, { enabled: true, params: w2.deps.params, deps: w2.deps });
      const ours = base.syncNpcSupercarrierSystems;
      base.syncNpcSupercarrierSystems = function foreignOver(...a) { order.push(["over"]); return ours(...a) * 10; };
      assert.strictEqual(base.syncNpcSupercarrierSystems(w2.scene, w2.entity, w2.controller, w2.behaviorProfile,
        w2.target, { nowMs: 5 }), 80);
      assert.deepStrictEqual(order, [["over"], ["under"], ["vendor", 6]]);
      assert.strictEqual(w2.calls.apply.length, 1, "our strike ran in the chain");
      assert.deepStrictEqual(strike.install({}, opts), { ok: false, reason: "BAD_EXPORTS" });
      assert.deepStrictEqual(strike.install({ syncNpcSupercarrierSystems: original }, { ...opts, enabled: false }),
        { ok: false, reason: "DISABLED" });
    } finally {
      strike._resetForTest();
    }
  });

  test("CF3 plan: scale of a supercarrier (1719.3, 5 tubes) and a carrier (369.9, 3 tubes), clamp, class row "
    + "without a type row, NO_RAW_DPS; cycle: before nextCycleAtMs no shot, after it a shot and a new due time", () => {
    const base = { dpsPermille: 1000, totalRawDamage: 200, durationMs: 4000, scaleMaxPermille: 20000 };
    const superDps = plan.rowDpsOf(SUPER_TYPE, "supercarrier", CATALOG);
    const carrierDps = plan.rowDpsOf(23915, "carrier", CATALOG);
    assert.deepStrictEqual([superDps, carrierDps], [1719.3, 369.9]);
    assert.deepStrictEqual(plan.squadronScalePermille({ ...base, rowDps: superDps, tubes: 5 }), { ok: true, permille: 6877 });
    assert.deepStrictEqual(plan.squadronScalePermille({ ...base, rowDps: carrierDps, tubes: 3 }),
      { ok: true, permille: 2466 });
    assert.deepStrictEqual(plan.squadronScalePermille({ ...base, rowDps: superDps, tubes: 5, scaleMaxPermille: 2000 }),
      { ok: true, permille: 2000 });
    assert.deepStrictEqual(plan.squadronScalePermille({ ...base, rowDps: 0.001, tubes: 5 }), { ok: true, permille: 1 });
    assert.deepStrictEqual(plan.squadronScalePermille({ ...base, rowDps: superDps, tubes: 5, dpsPermille: 500 }),
      { ok: true, permille: 3439 });
    assert.strictEqual(plan.rowDpsOf(999999, "carrier", CATALOG), CAPITAL_STRENGTH_ROWS.carrier.dps);
    assert.strictEqual(plan.rowDpsOf(999999, "nope", CATALOG), 0);
    assert.deepStrictEqual(plan.squadronScalePermille({ ...base, rowDps: superDps, tubes: 5, durationMs: 0 }),
      { ok: false, reason: "NO_RAW_DPS" });
    assert.deepStrictEqual(plan.squadronScalePermille({ ...base, rowDps: 0, tubes: 5 }), { ok: false, reason: "NO_ROW" });
    assert.deepStrictEqual(plan.squadronScalePermille({ ...base, rowDps: superDps, tubes: 0 }),
      { ok: false, reason: "BAD_TUBES" });
    assert.deepStrictEqual(plan.classOfProfile(SUPER, INDEX), { ok: true, factionId: 500003, cls: "supercarrier",
      typeId: SUPER_TYPE });
    assert.deepStrictEqual(plan.classOfProfile("lne_capital_1_x", INDEX), { ok: false, reason: "NO_CLASS" });
    const vector = Object.freeze({ em: 1, thermal: 2, kinetic: 0, explosive: 4 });
    assert.deepStrictEqual(plan.scaleDamageVector(vector, 2500), { em: 2.5, thermal: 5, kinetic: 0, explosive: 10 });
    assert.strictEqual(plan.nextCycleDue({ nextCycleAtMs: 5000 }, 4999), false);
    assert.strictEqual(plan.nextCycleDue({ nextCycleAtMs: 5000 }, 5000), true);
    assert.strictEqual(plan.nextCycleDue(null, 0), true);
    assert.strictEqual(plan.isStrikeKind({ offensiveKind: "missile" }), true);
    assert.strictEqual(plan.isStrikeKind({ offensiveKind: "kamikaze" }), false);

    strike._resetForTest();
    try {
      const w = world();
      assert.strictEqual(hit(w, 10000).strikes, 1);
      assert.deepStrictEqual(hit(w, 13999), { ok: false, reason: "NOT_DUE" });
      assert.strictEqual(w.calls.apply.length, 1);
      const again = hit(w, 14000);
      assert.strictEqual(again.strikes, 1);
      assert.strictEqual(w.calls.apply.length, 2);
    } finally {
      strike._resetForTest();
    }
  });

  test("CF4 strike on a fake scene: turret hit with the scaled vector, noteKillmailDamage 1x, source without session "
    + "and character, FX; kill -> recordKillmailFromDestruction exactly 1x; out of range -> follow, no damage; no local "
    + "interaction -> skipped; kamikaze -> fighterSkipped once; missile; no target after an attack -> orbit 1500 m",
  () => {
    strike._resetForTest();
    try {
      const w = world();
      const r = hit(w, 1000);
      assert.deepStrictEqual(r, { ok: true, strikes: 1, hits: 1, kills: 0, skipped: 0 });
      assert.deepStrictEqual(w.calls.turret[0], { em: 0, thermal: 687.7, kinetic: 687.7, explosive: 0 });
      assert.deepStrictEqual(w.calls.apply[0].dmg, w.calls.turret[0]);
      const src = w.calls.apply[0].src;
      assert.deepStrictEqual([src.itemID, src.session, src.characterID, src.pilotCharacterID], [501, null, null, null]);
      assert.strictEqual(w.calls.note.length, 1);
      assert.strictEqual(w.calls.note[0][2], 1375.4);
      assert.strictEqual(w.calls.record.length, 0);
      assert.strictEqual(w.calls.notify.length, 1);
      assert.deepStrictEqual(w.calls.fx, [[501, "effects.ProjectileFired", 900, 4000]]);
      assert.deepStrictEqual(w.calls.orbit, [[501, 900, 2000]], "in range -> orbit at the fighter orbit");
      assert.strictEqual(w.calls.gate, 1, "drift guard asked once");
      hit(w, 5000);
      assert.deepStrictEqual(w.calls.orbit.length, 1, "no repeated movement order");
      assert.strictEqual(w.calls.gate, 1);

      strike._resetForTest();
      const k = world({ kill: true, fighters: [501, 502] });
      assert.deepStrictEqual(hit(k, 1000), { ok: true, strikes: 1, hits: 1, kills: 1, skipped: 0 });
      assert.strictEqual(k.calls.record.length, 1);
      assert.strictEqual(k.calls.record[0][0], k.target);
      assert.strictEqual(k.calls.record[0][2].attackerEntity.session, null);

      strike._resetForTest();
      const far = world({ distance: 50000 });
      assert.deepStrictEqual(hit(far, 1000), { ok: true, strikes: 0, hits: 0, kills: 0, skipped: 0 });
      assert.deepStrictEqual(far.calls.follow, [[501, 900, 10000]]);
      assert.strictEqual(far.calls.apply.length, 0);
      far.state.distance = 9000;
      assert.strictEqual(hit(far, 1500).strikes, 1, "re-checked at the next think, in range -> shot");
      assert.deepStrictEqual(far.calls.orbit, [[501, 900, 2000]]);

      strike._resetForTest();
      const warp = world({ distance: 50000 });
      hit(warp, 1000);
      assert.strictEqual(warp.calls.follow.length, 1);
      hit(warp, 1500);
      assert.strictEqual(warp.calls.follow.length, 1, "ball still follows -> no repeated order");
      Object.assign(warp.fighters[0], { mode: "STOP", targetEntityID: null });
      hit(warp, 2000);
      assert.deepStrictEqual(warp.calls.follow, [[501, 900, 10000], [501, 900, 10000]], "stopped -> follow again");

      strike._resetForTest();
      const scoped = world({ interact: false });
      assert.deepStrictEqual(hit(scoped, 1000), { ok: true, strikes: 0, hits: 0, kills: 0, skipped: 1 });
      assert.strictEqual(scoped.calls.apply.length, 0);

      strike._resetForTest();
      const kamikaze = world({ snapshot: { offensiveKind: "kamikaze" } });
      assert.deepStrictEqual(hit(kamikaze, 1000), { ok: true, strikes: 0, hits: 0, kills: 0, skipped: 1 });
      assert.deepStrictEqual(hit(kamikaze, 2000), { ok: true, strikes: 0, hits: 0, kills: 0, skipped: 0 });
      assert.strictEqual(strike.stats().skipped, 1);
      assert.strictEqual(kamikaze.calls.apply.length, 0);

      strike._resetForTest();
      const missile = world({ snapshot: { offensiveKind: "missile", explosionRadius: 50, explosionVelocity: 100 } });
      assert.strictEqual(hit(missile, 1000).hits, 1);
      assert.deepStrictEqual(missile.calls.missile[0], { em: 0, thermal: 687.7, kinetic: 687.7, explosive: 0 });
      assert.strictEqual(missile.calls.turret.length, 0);

      assert.deepStrictEqual(hit(missile, 2000, null), { ok: false, reason: "NO_TARGET" });
      assert.deepStrictEqual(missile.calls.orbit.slice(-1), [[501, 100, strike.CONTROLLER_ORBIT_METERS]]);
      const orbits = missile.calls.orbit.length;
      hit(missile, 2500, null);
      assert.strictEqual(missile.calls.orbit.length, orbits, "once");
      assert.deepStrictEqual(strike.stats().strikes, 1);
    } finally {
      strike._resetForTest();
    }
  });

  test("CF5 config + drift guard: each of the 5 switches off -> no wrap; on -> wrapped; damage on without "
    + "capitalFightersEnabled / capitalLiveEnabled -> warning; gateProbe true -> GATE_FIXED, null -> GATE_UNKNOWN (no "
    + "wrap); vendor gate fixed at the first strike -> strike off, gauge 1; the real adapter has capitalFighterTools",
  () => {
    strike._resetForTest();
    try {
      for (const [mat, extra] of [[{ capitalFighterDamageEnabled: false }, {}], [{ capitalFightersEnabled: false }, {}],
        [{ capitalLiveEnabled: false }, {}], [{}, { module: false }], [{}, { enabled: false }]]) {
        const off = runLoader(mat, extra);
        assert.deepStrictEqual([off.ctx.state.capitalFighterStrike,
          off.directorExports.syncNpcSupercarrierSystems === off.original], ["disabled", true], JSON.stringify(mat));
      }
      const on = runLoader({});
      assert.strictEqual(on.ctx.state.capitalFighterStrike, "wrapped");
      assert.notStrictEqual(on.directorExports.syncNpcSupercarrierSystems, on.original);
      assert.strictEqual(on.directorExports.syncNpcSupercarrierSystems({}, {}, { profileID: "x" }, {}, null, {}),
        "vendor");

      const env = (more) => ({ EVEJS_LNE_MATERIALIZATION_CAPITAL_FIGHTER_DAMAGE_ENABLED: "true", ...more });
      const warned = (r) => r.warnings.some((x) => x.startsWith("materialization.capitalFighterDamageEnabled with"));
      const noFighters = config.resolveConfig({ modDir: MOD_DIR, env: env({
        EVEJS_LNE_MATERIALIZATION_CAPITAL_LIVE_ENABLED: "true" }) });
      assert.ok(warned(noFighters), JSON.stringify(noFighters.warnings));
      const noLive = config.resolveConfig({ modDir: MOD_DIR, env: env({
        EVEJS_LNE_MATERIALIZATION_CAPITAL_FIGHTERS_ENABLED: "true" }) });
      assert.ok(warned(noLive));
      const full = config.resolveConfig({ modDir: MOD_DIR, env: env({
        EVEJS_LNE_MATERIALIZATION_CAPITAL_LIVE_ENABLED: "true", EVEJS_LNE_MATERIALIZATION_CAPITAL_FIGHTERS_ENABLED: "true",
        EVEJS_LNE_MATERIALIZATION_CAPITAL_FIGHTER_DPS_PERMILLE: "99" }) });
      assert.ok(!warned(full));
      assert.strictEqual(full.config.materialization.capitalFighterDpsPermille, 100, "clamped to min");
      const defaults = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config.materialization;
      assert.deepStrictEqual([defaults.capitalFighterDamageEnabled, defaults.capitalFighterDpsPermille,
        defaults.capitalFighterScaleMaxPermille], [false, 1000, 20000]);

      const w = world();
      const fresh = () => ({ syncNpcSupercarrierSystems: () => "v" });
      strike._resetForTest();
      const fixedExports = fresh();
      const fixedFn = fixedExports.syncNpcSupercarrierSystems;
      assert.deepStrictEqual(strike.install(fixedExports, { enabled: true, params: w.deps.params, deps: w.deps,
        gateProbe: () => true }), { ok: false, reason: "GATE_FIXED" });
      assert.strictEqual(fixedExports.syncNpcSupercarrierSystems, fixedFn, "no wrap");
      strike._resetForTest();
      const unknownExports = fresh();
      assert.deepStrictEqual(strike.install(unknownExports, { enabled: true, params: w.deps.params, deps: w.deps,
        gateProbe: () => null }), { ok: false, reason: "GATE_UNKNOWN" });

      strike._resetForTest();
      const g = world({ gate: true });
      const gates = [];
      const gauges = [];
      const fixedLater = fresh();
      strike.install(fixedLater, { enabled: true, params: g.deps.params, deps: g.deps, onGate: (s) => gates.push(s) });
      fixedLater.syncNpcSupercarrierSystems(g.scene, g.entity, g.controller, g.behaviorProfile, g.target, { nowMs: 1 });
      fixedLater.syncNpcSupercarrierSystems(g.scene, g.entity, g.controller, g.behaviorProfile, g.target, { nowMs: 9999 });
      assert.deepStrictEqual([gates, g.calls.gate, g.calls.apply.length, strike.stats().gate], [["fixed"], 1, 0, "fixed"]);
      const logs = [];
      strike._resetForTest();
      const g2 = world({ gate: true });
      const viaLoader = runLoader({});
      viaLoader.ctx.telemetry = { gauge: (n, v) => gauges.push([n, v]), count: () => {} };
      viaLoader.ctx.logger = { log: (l) => logs.push(l), logError: () => {}, debug: () => {} };
      viaLoader.ctx.adapter = { capitalFighterTools: () => g2.deps.tools() };
      viaLoader.directorExports.syncNpcSupercarrierSystems({}, g2.entity, g2.controller, g2.behaviorProfile, g2.target,
        { nowMs: 1 });
      assert.deepStrictEqual(gauges, [["capitalLive.fighterGateFixed", 1], ["capitalLive.fighterGateUnknown", 0]]);
      assert.strictEqual(viaLoader.ctx.state.capitalFighterGate, "fixed");
      assert.ok(logs.some((l) => l.includes("capitalFighterStrike: off")), JSON.stringify(logs));

      strike._resetForTest();
      const failing = runLoader({});
      const counts = [];
      const errorLogs = [];
      failing.ctx.telemetry = { gauge: () => {}, count: (n, v) => counts.push([n, v]) };
      failing.ctx.logger = { log: () => {}, logError: (l) => errorLogs.push(l), debug: () => {} };
      failing.ctx.adapter = { capitalFighterTools: () => { throw new Error("boom"); } };
      for (const nowMs of [1, 2]) {
        assert.strictEqual(failing.directorExports.syncNpcSupercarrierSystems({}, g2.entity, g2.controller,
          g2.behaviorProfile, g2.target, { nowMs }), "vendor");
      }
      assert.deepStrictEqual(counts, [["capitalLive.fighterErrors", 1], ["capitalLive.fighterErrors", 1]]);
      assert.strictEqual(errorLogs.length, 1);

      const adapter = createAdapter({ moduleApi: { _cache: {} } });
      assert.strictEqual(typeof adapter.capitalFighterTools, "function");
      assert.strictEqual(adapter.capitalFighterTools().ok, false, "no server/src -> SEAM_UNAVAILABLE");
    } finally {
      strike._resetForTest();
    }
  });
};
