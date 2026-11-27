"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const fax = require("../../lib/adapter/npcFaxRepair");
const plan = require("../../lib/adapter/faxRepairPlan");
const fighterPlan = require("../../lib/adapter/fighterStrikePlan");
const { TYPES } = require("../../lib/battle/data/strengthCatalog");
const { CAPITAL_STRENGTH_ROWS } = require("../../lib/battle/data/capitalStrengthRows");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { createRegistry } = require("../../lib/materialization/registry");
const { createUnavailableMaterialization } = require("../../lib/materialization");
const config = require("../../config");
const loader = require("../../loader");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_SRC = path.join(REPO_ROOT, "server", "src");
const MOD_DIR = path.resolve(__dirname, "..", "..");
const CATALOG = Object.freeze({ TYPES, CAPITAL_STRENGTH_ROWS });
const FAX_PROFILE = "lne_capital_500003_force_auxiliary";
const DREAD_PROFILE = "lne_capital_500003_dreadnought";
const INDEX = { 500003: { force_auxiliary: { profileId: FAX_PROFILE, typeId: 37604 },
  dreadnought: { profileId: DREAD_PROFILE, typeId: 19720 } } };
const PARAMS = Object.freeze({ permille: 1000, cycleMs: 5000, rangeMeters: 75000 });

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function world(opts = {}) {
  const calls = { cycle: [], fx: [], tools: 0, modules: 0 };
  const ship = (itemID, armorDamage, extra) => ({ itemID, typeID: 587, kind: "ship",
    conditionState: { armorDamage, shieldCharge: 1 }, ...extra });
  const entity = { itemID: 100, typeID: opts.faxType || 37604, kind: "ship", conditionState: { armorDamage: 0.95 } };
  const entities = new Map([[100, entity], [200, ship(200, 0.2)], [201, ship(201, 0.5)], [300, ship(300, 0.9)]]);
  const distances = { 200: 10000, 201: 20000, 300: 5000, ...(opts.distances || {}) };
  const scene = {
    getEntityByID: (id) => entities.get(id) || null,
    broadcastSpecialFx: (id, guid, o, src) => calls.fx.push({ id, guid, o, src }),
  };
  const registry = createRegistry({ maxFailedBattlesRemembered: 4, maxStrayShipsRemembered: 4 });
  const battle = registry.addSpawning({ battleId: "b-1", systemId: 30000142, claimSeq: 1, version: 1,
    reservationId: "r" });
  battle.sideA.push(...(opts.sideA || [100, 200, 201]));
  battle.sideB.push(300);
  battle.state = "LIVE";
  const state = { modules: opts.modules || [], success: opts.success !== false,
    interact: opts.interact || (() => true) };
  const tools = {
    executeAssistanceModuleCycle: (input) => {
      calls.cycle.push(input);
      return state.success ? { success: true, data: { appliedAmount: input.effectState.assistanceArmorRepairAmount
        + input.effectState.assistanceShieldBonusAmount } } : { success: false, errorMsg: "TARGET_OUT_OF_RANGE" };
    },
    getNpcAssistanceModules: () => {
      calls.modules += 1;
      return state.modules;
    },
    getSceneSurfaceDistance: (sc, a, b) => distances[b.itemID],
    canEntitiesInteractLocally: (a, b) => state.interact(b),
    droneInterop: { normalizeShipConditionState: () => null, buildShipHealthTransitionResult: () => null,
      notifyShipHealthAttributesToSession: () => null, broadcastDamageStateChange: () => null,
      persistDynamicEntity: () => null },
  };
  const deps = {
    tools: () => {
      calls.tools += 1;
      return { ok: true, tools };
    },
    classIndex: () => ({ ok: true, index: fighterPlan.reverseIndex(INDEX) }),
    remoteRep: (typeId) => plan.rowRemoteRepOf(typeId, CATALOG),
    liveSideOf: (id) => registry.liveSideOf(id),
    params: { ...PARAMS, ...(opts.params || {}) },
  };
  return { calls, entity, entities, scene, registry, battle, state, tools, deps, distances,
    controller: { profileID: FAX_PROFILE } };
}

function step(w, nowMs) {
  return fax.repairForController(w.scene, w.entity, w.controller, nowMs, w.deps);
}

function runLoader(materialization, extra = {}) {
  const MOVEMENT = path.join(path.sep, "x", "server", "src", "space", "npc", "capitals", "capitalNpcMovement");
  const PARENT = { filename: path.join(path.sep, "x", "server", "src", "space", "npc", "npcBehaviorLoop.js") };
  const silent = { log: () => {}, logError: () => {}, debug: () => {} };
  const original = function syncCapitalNpcMovement() { return "vendor"; };
  const movementExports = { syncCapitalNpcMovement: original, syncCapitalNpcReturnHome: () => false };
  const moduleApi = { _cache: {}, _load: (request) => (request === MOVEMENT ? movementExports : {}) };
  const ctx = { state: {}, logger: silent, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
    config: { enabled: extra.enabled !== false, debug: false, dataDir: "/x",
      modules: { materialization: { enabled: extra.module !== false } },
      materialization: { capitalLiveEnabled: true, capitalFaxRepairEnabled: true, capitalFaxRepairPermille: 1000,
        capitalFaxRepairCycleMs: 5000, capitalFaxRepairRangeMeters: 75000, ...materialization } } }) };
  loader.installModuleHook(moduleApi, loader.buildHooks(ctx), silent);
  moduleApi._load(MOVEMENT, PARENT);
  return { ctx, movementExports, original };
}

module.exports = ({ test }) => {
  test("FR1 vendor facts: npcBehaviorLoop destructures syncCapitalNpcMovement and calls it for capitalNpc; not called "
    + "inside its definer; assistance friendship = equal operatorKind; executeAssistanceModuleCycle checks "
    + "isEntityLockedTarget, exported; droneInterop HP callbacks; getNpcAssistanceModules exported; FX GUIDs; "
    + "GAME_MODULES wrap entry", () => {
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    assert.ok(/const \{\n {2}syncCapitalNpcMovement,\n {2}syncCapitalNpcReturnHome,\n\} = require\(path\.join\(__dirname, "\.\/capitals\/capitalNpcMovement"\)\);/
      .test(loop), "destructuring at require");
    assert.ok(/entity\.capitalNpc === true\n\s+\? syncCapitalNpcMovement\(\n\s+scene,\n\s+entity,\n\s+controller,\n\s+desiredTarget,\n\s+movementDirective,\n\s+\{ nowMs: now \},/
      .test(loop), "call for capitalNpc with { nowMs: now }");
    const movement = readSource("space/npc/capitals/capitalNpcMovement.js");
    assert.strictEqual((movement.match(/\bsyncCapitalNpcMovement\b/g) || []).length, 2, "definition + export only");
    assert.ok(movement.includes("\nfunction syncCapitalNpcMovement(") && movement.includes("\n  syncCapitalNpcMovement,\n"));
    assert.ok(functionBody(loop, "isFriendlyNpcAssistanceTarget").includes("return sourceOperatorKind === targetOperatorKind;"));
    const assistance = readSource("space/modules/assistanceModuleRuntime.js");
    const cycle = functionBody(assistance, "executeAssistanceModuleCycle");
    assert.ok(cycle.includes("callbacks.isEntityLockedTarget(entity, effectState.targetID) !== true"));
    assert.ok(cycle.includes("toFiniteNumber(effectState.assistanceArmorRepairAmount, 0)")
      && cycle.includes("appliedAmount: roundNumber(armorRepairAmount, 6)"));
    assert.ok(assistance.slice(assistance.indexOf("\nmodule.exports = {")).includes("\n  executeAssistanceModuleCycle,\n"));
    const space = readSource("space/runtime.js");
    const interop = space.slice(space.indexOf("runtimeExports.droneInterop = {"));
    for (const name of fax.INTEROP_FUNCTIONS) {
      assert.ok(new RegExp(`\\n {2}${name}(:|,)`).test(interop.slice(0, interop.indexOf("};"))), `droneInterop.${name}`);
    }
    assert.ok(readSource("space/npc/npcEquipment.js").includes("\n  getNpcAssistanceModules,\n"));
    const fx = readSource("services/chat/specialFxRegistry.js");
    assert.ok(fx.includes("guid: \"effects.RemoteArmourRepair\"") && fx.includes("guid: \"effects.ShieldTransfer\""));
    const entry = GAME_MODULES.find((e) => e.path === "space/npc/capitals/capitalNpcMovement");
    assert.deepStrictEqual(entry.symbols.map((s) => [s.name, s.firstLoad, s.wrap, [...s.consumers]]),
      [["syncCapitalNpcMovement", true, true, ["capitalFax"]]]);
  });

  test("FR2 wrap: arguments and result of the original unchanged; profile outside lne_capital_ -> zero deps calls; "
    + "LNE capital other than FAX -> zero tools calls; second install = alreadyInstalled; a throw in the repair -> "
    + "vendor result + errors 1; a vendor throw reaches the vendor; a foreign wrap under and over ours", () => {
    fax._resetForTest();
    try {
      const w = world();
      const seen = [];
      let depsCalls = 0;
      const counted = Object.fromEntries(Object.entries(w.deps).map(([k, v]) => [k, typeof v === "function"
        ? (...a) => { depsCalls += 1; return v(...a); } : v]));
      const original = function syncCapitalNpcMovement(...args) { seen.push(args); return true; };
      const exportsObj = { syncCapitalNpcMovement: original };
      const opts = { enabled: true, params: PARAMS, deps: counted };
      assert.deepStrictEqual(fax.install(exportsObj, opts), { ok: true, alreadyInstalled: false });
      assert.deepStrictEqual(fax.install(exportsObj, opts), { ok: true, alreadyInstalled: true });
      const wrapped = exportsObj.syncCapitalNpcMovement;
      const options = { nowMs: 1000 };
      const vendorController = { profileID: "capital_true_sanshas_supercarrier" };
      assert.strictEqual(wrapped(w.scene, w.entity, vendorController, null, "dir", options), true);
      assert.strictEqual(seen[0].length, 6);
      assert.strictEqual(seen[0][2], vendorController);
      assert.strictEqual(seen[0][5], options);
      assert.strictEqual(wrapped(w.scene, w.entity, {}, null, "dir", options), true);
      assert.strictEqual(depsCalls, 0, "vendor profile: no work of the mod");
      assert.strictEqual(wrapped(w.scene, w.entity, { profileID: DREAD_PROFILE }, null, "dir", options), true);
      assert.strictEqual(w.calls.tools, 0, "LNE dreadnought: no tools");
      assert.strictEqual(wrapped(w.scene, w.entity, w.controller, null, "dir", options), true);
      assert.strictEqual(w.calls.cycle.length, 1, "LNE FAX: one repair after the original");

      fax._resetForTest();
      const throwing = { ...w.deps, tools: () => { throw new Error("boom"); } };
      const exportsThrow = { syncCapitalNpcMovement: original };
      const errors = [];
      const deltas = [];
      fax.install(exportsThrow, { enabled: true, params: PARAMS, deps: throwing, onError: (e) => errors.push(e),
        onCounts: (d) => deltas.push(d) });
      assert.strictEqual(exportsThrow.syncCapitalNpcMovement(w.scene, w.entity, w.controller, null, "d", options), true);
      assert.deepStrictEqual([fax.stats().errors, errors.length, deltas.length, deltas[0].errors], [1, 1, 1, 1]);
      const bad = { syncCapitalNpcMovement: () => { throw new Error("vendor"); } };
      fax.install(bad, { enabled: true, params: PARAMS, deps: w.deps });
      assert.throws(() => bad.syncCapitalNpcMovement(w.scene, w.entity, w.controller), /vendor/);

      fax._resetForTest();
      const w2 = world();
      const order = [];
      const base = { syncCapitalNpcMovement: (...a) => { order.push(["vendor", a.length]); return 7; } };
      const under = base.syncCapitalNpcMovement;
      base.syncCapitalNpcMovement = function foreignUnder(...a) { order.push(["under"]); return under(...a) + 1; };
      fax.install(base, { enabled: true, params: PARAMS, deps: w2.deps });
      const ours = base.syncCapitalNpcMovement;
      base.syncCapitalNpcMovement = function foreignOver(...a) { order.push(["over"]); return ours(...a) * 10; };
      assert.strictEqual(base.syncCapitalNpcMovement(w2.scene, w2.entity, w2.controller, null, "d", { nowMs: 5 }), 80);
      assert.deepStrictEqual(order, [["over"], ["under"], ["vendor", 6]]);
      assert.strictEqual(w2.calls.cycle.length, 1, "our repair ran in the chain");
      assert.deepStrictEqual(fax.install({}, opts), { ok: false, reason: "BAD_EXPORTS" });
      assert.deepStrictEqual(fax.install({ syncCapitalNpcMovement: original }, { ...opts, enabled: false }),
        { ok: false, reason: "DISABLED" });
    } finally {
      fax._resetForTest();
    }
  });

  test("FR3 plan: Apostle 290 x 1000 permille x 5000 ms = 1450; no type row -> class row; cycleMs 0 -> BAD_CYCLE; "
    + "family 37605 shield, unknown armour; needRatio; pickRepairTarget ties (need, distance, id)", () => {
    assert.strictEqual(plan.rowRemoteRepOf(37604, CATALOG), 290);
    assert.deepStrictEqual(plan.repairAmountPerCycle({ remoteRepPerSec: 290, permille: 1000, cycleMs: 5000 }),
      { ok: true, amount: 1450 });
    assert.deepStrictEqual(plan.repairAmountPerCycle({ remoteRepPerSec: 290, permille: 500, cycleMs: 2000 }),
      { ok: true, amount: 290 });
    assert.strictEqual(plan.rowRemoteRepOf(999999, CATALOG), CAPITAL_STRENGTH_ROWS.force_auxiliary.remoteRepPerSec);
    assert.ok(plan.rowRemoteRepOf(999999, CATALOG) > 0);
    assert.strictEqual(plan.rowRemoteRepOf(999999, { TYPES: {}, CAPITAL_STRENGTH_ROWS: {} }), 0);
    assert.deepStrictEqual(plan.repairAmountPerCycle({ remoteRepPerSec: 290, permille: 1000, cycleMs: 0 }),
      { ok: false, reason: "BAD_CYCLE" });
    assert.deepStrictEqual(plan.repairAmountPerCycle({ remoteRepPerSec: 0, permille: 1000, cycleMs: 5000 }),
      { ok: false, reason: "NO_ROW" });
    assert.deepStrictEqual([37604, 37605, 37606, 37607, 42242, 45645, 1].map(plan.familyOfType),
      ["remoteArmor", "remoteShield", "remoteShield", "remoteArmor", "remoteArmor", "remoteShield", "remoteArmor"]);
    assert.strictEqual(plan.needRatio({ kind: "ship", conditionState: {} }, "remoteShield"), 0, "no shieldCharge = full");
    assert.strictEqual(plan.needRatio({ kind: "ship", conditionState: { shieldCharge: 0.25 } }, "remoteShield"), 0.75);
    assert.strictEqual(plan.needRatio({ kind: "ship", conditionState: { armorDamage: 0.4 } }, "remoteArmor"), 0.4);
    assert.strictEqual(plan.needRatio({ kind: "ship", conditionState: { armorDamage: 3 } }, "remoteArmor"), 1);
    assert.strictEqual(plan.needRatio({ kind: "drone", conditionState: { armorDamage: 0.4 } }, "remoteArmor"), 0);
    const pick = (list) => plan.pickRepairTarget(list).entityId;
    assert.strictEqual(pick([{ entityId: 1, need: 0.2, distance: 1 }, { entityId: 2, need: 0.5, distance: 9 }]), 2);
    assert.strictEqual(pick([{ entityId: 1, need: 0.5, distance: 9 }, { entityId: 2, need: 0.5, distance: 1 }]), 2);
    assert.strictEqual(pick([{ entityId: 3, need: 0.5, distance: 1 }, { entityId: 2, need: 0.5, distance: 1 }]), 2);
    assert.strictEqual(plan.pickRepairTarget([]), null);
    assert.deepStrictEqual(plan.buildEffectState({ faxId: 100, targetId: 201, family: "remoteShield", amount: 1450,
      rangeMeters: 75000 }), { moduleID: 100, targetID: 201, assistanceModuleEffect: true,
      assistanceFamily: "remoteShield", assistanceJammingType: "remoteShield", assistanceMaxRangeMeters: 75000,
      assistanceFalloffMeters: 0, assistanceShieldBonusAmount: 1450, assistanceArmorRepairAmount: 0,
      assistanceHullRepairAmount: 0 });
  });

  test("FR4 repair on a fake scene: the most damaged ally gets it, never the more damaged enemy nor the FAX; effect "
    + "state, session null, lock callback true, FX non-offensive; cycle timing; NOT_LIVE; VENDOR_ACTIVE; refused; "
    + "out of range / no local interaction -> idle", () => {
    fax._resetForTest();
    try {
      const w = world();
      assert.deepStrictEqual(step(w, 1000), { ok: true, targetId: 201, applied: 1450 });
      assert.strictEqual(w.calls.cycle.length, 1);
      const input = w.calls.cycle[0];
      assert.deepStrictEqual([input.entity, input.session, input.isActivationPass, input.nowMs],
        [w.entity, null, false, 1000]);
      assert.deepStrictEqual([input.effectState.assistanceFamily, input.effectState.assistanceArmorRepairAmount,
        input.effectState.assistanceMaxRangeMeters, input.effectState.assistanceFalloffMeters,
        input.effectState.targetID], ["remoteArmor", 1450, 75000, 0, 201]);
      assert.strictEqual(input.callbacks.isEntityLockedTarget(), true);
      assert.strictEqual(input.callbacks.persistDynamicEntity, w.tools.droneInterop.persistDynamicEntity);
      assert.strictEqual(input.callbacks.getEntitySurfaceDistance(w.entity, w.entities.get(200)), 10000);
      assert.deepStrictEqual(w.calls.fx.map((f) => [f.id, f.guid, f.o.targetID, f.o.isOffensive, f.o.duration]),
        [[100, "effects.RemoteArmourRepair", 201, false, 5000]]);
      assert.deepStrictEqual(step(w, 5999), { ok: false, reason: "NOT_DUE" });
      assert.strictEqual(w.calls.cycle.length, 1);
      assert.strictEqual(step(w, 6000).ok, true);
      assert.deepStrictEqual(w.calls.cycle.map((c) => c.effectState.targetID), [201, 201], "never 300 nor 100");
      assert.deepStrictEqual([fax.stats().cycles, fax.stats().hp], [2, 2900]);

      fax._resetForTest();
      const shield = world({ faxType: 37605 });
      shield.entities.get(200).conditionState.shieldCharge = 0.1;
      assert.deepStrictEqual(step(shield, 1000), { ok: true, targetId: 200, applied: 1450 });
      assert.strictEqual(shield.calls.fx[0].guid, "effects.ShieldTransfer");

      fax._resetForTest();
      const out = world({ sideA: [200, 201] });
      assert.deepStrictEqual(step(out, 1000), { ok: false, reason: "NOT_LIVE" });
      assert.strictEqual(out.calls.cycle.length, 0);

      fax._resetForTest();
      const vendor = world({ modules: [{ itemID: 1 }] });
      assert.deepStrictEqual(step(vendor, 1000), { ok: false, reason: "VENDOR_ACTIVE" });
      assert.deepStrictEqual([vendor.calls.cycle.length, fax.stats().vendorActive], [0, 1]);

      fax._resetForTest();
      const refused = world({ success: false });
      assert.deepStrictEqual(step(refused, 1000), { ok: false, reason: "REFUSED" });
      assert.deepStrictEqual([fax.stats().refused, fax.stats().cycles], [1, 0]);

      fax._resetForTest();
      const far = world({ distances: { 200: 80000, 201: 90000 } });
      assert.deepStrictEqual(step(far, 1000), { ok: false, reason: "NO_TARGET" });
      const scoped = world({ interact: () => false });
      assert.deepStrictEqual(step(scoped, 1000), { ok: false, reason: "NO_TARGET" });
      assert.deepStrictEqual([far.calls.cycle.length, scoped.calls.cycle.length, fax.stats().idle], [0, 0, 2]);
      assert.deepStrictEqual(step(far, 2000), { ok: false, reason: "NOT_DUE" }, "idle waits a full cycle too");
      const near = world({ interact: (b) => b.itemID === 200 });
      assert.deepStrictEqual(step(near, 1000), { ok: true, targetId: 200, applied: 1450 });
    } finally {
      fax._resetForTest();
    }
  });

  test("FR5 config + gate + facade: each of the 4 switches off -> no wrap, on -> wrapped; warning without "
    + "capitalLiveEnabled / force_auxiliary; defaults and clamp; errors reach telemetry; liveSideOf on a registry "
    + "with two battles; stub -> NOT_LIVE; the real adapter has capitalFaxTools", () => {
    fax._resetForTest();
    try {
      for (const [mat, extra] of [[{ capitalFaxRepairEnabled: false }, {}], [{ capitalLiveEnabled: false }, {}],
        [{}, { module: false }], [{}, { enabled: false }]]) {
        const off = runLoader(mat, extra);
        assert.deepStrictEqual([off.ctx.state.capitalFaxRepair,
          off.movementExports.syncCapitalNpcMovement === off.original], ["disabled", true], JSON.stringify([mat, extra]));
      }
      const on = runLoader({});
      assert.strictEqual(on.ctx.state.capitalFaxRepair, "wrapped");
      assert.notStrictEqual(on.movementExports.syncCapitalNpcMovement, on.original);
      assert.strictEqual(on.movementExports.syncCapitalNpcMovement({}, {}, { profileID: "x" }, null, "d", {}), "vendor");

      fax._resetForTest();
      const failing = runLoader({});
      const counts = [];
      const errorLogs = [];
      failing.ctx.telemetry = { gauge: () => {}, count: (n, v) => counts.push([n, v]) };
      failing.ctx.logger = { log: () => {}, logError: (l) => errorLogs.push(l), debug: () => {} };
      failing.ctx.state.capitalLive = "wrapped";
      failing.ctx.adapter = { capitalFaxTools: () => { throw new Error("boom"); } };
      const w = world();
      const capitalProfiles = require("../../lib/adapter/capitalProfiles");
      const readIndex = capitalProfiles.readIndex;
      capitalProfiles.readIndex = () => ({ ok: true, index: INDEX });
      try {
        for (const nowMs of [1, 6000]) {
          assert.strictEqual(failing.movementExports.syncCapitalNpcMovement(w.scene, w.entity, w.controller, null,
            "d", { nowMs }), "vendor");
        }
      } finally {
        capitalProfiles.readIndex = readIndex;
      }
      assert.deepStrictEqual(counts, [["capitalLive.faxRepairErrors", 1], ["capitalLive.faxRepairErrors", 1]]);
      assert.strictEqual(errorLogs.length, 1);

      const env = (more) => ({ EVEJS_LNE_MATERIALIZATION_CAPITAL_FAX_REPAIR_ENABLED: "true", ...more });
      const warned = (r) => r.warnings.some((x) => x.startsWith("materialization.capitalFaxRepairEnabled with"));
      assert.ok(warned(config.resolveConfig({ modDir: MOD_DIR, env: env({}) })), "no capitalLiveEnabled");
      const noFax = config.resolveConfig({ modDir: MOD_DIR, env: env({
        EVEJS_LNE_MATERIALIZATION_CAPITAL_LIVE_ENABLED: "true",
        EVEJS_LNE_MATERIALIZATION_CAPITAL_CLASSES_LIVE: "carrier,dreadnought" }) });
      assert.ok(warned(noFax), JSON.stringify(noFax.warnings));
      const full = config.resolveConfig({ modDir: MOD_DIR, env: env({
        EVEJS_LNE_MATERIALIZATION_CAPITAL_LIVE_ENABLED: "true",
        EVEJS_LNE_MATERIALIZATION_CAPITAL_FAX_REPAIR_PERMILLE: "99",
        EVEJS_LNE_MATERIALIZATION_CAPITAL_FAX_REPAIR_CYCLE_MS: "999999",
        EVEJS_LNE_MATERIALIZATION_CAPITAL_FAX_REPAIR_RANGE_METERS: "1" }) });
      assert.ok(!warned(full), JSON.stringify(full.warnings));
      const m = full.config.materialization;
      assert.deepStrictEqual([m.capitalFaxRepairPermille, m.capitalFaxRepairCycleMs, m.capitalFaxRepairRangeMeters],
        [100, 60000, 5000], "clamped");
      const d = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config.materialization;
      assert.deepStrictEqual([d.capitalFaxRepairEnabled, d.capitalFaxRepairPermille, d.capitalFaxRepairCycleMs,
        d.capitalFaxRepairRangeMeters], [false, 1000, 5000, 75000]);

      const registry = createRegistry({ maxFailedBattlesRemembered: 4, maxStrayShipsRemembered: 4 });
      const add = (battleId, a, b, live) => {
        const e = registry.addSpawning({ battleId, systemId: 1, claimSeq: 1, version: 1, reservationId: battleId });
        e.sideA.push(...a);
        e.sideB.push(...b);
        if (live) e.state = "LIVE";
        return e;
      };
      add("b-1", [1, 2, 3], [4, 5], true);
      const second = add("b-2", [6, 7], [8], true);
      add("b-3", [9, 10], [11], false);
      assert.deepStrictEqual(registry.liveSideOf(2), { ok: true, battleId: "b-1", side: "A", allyIds: [1, 3] });
      assert.deepStrictEqual(registry.liveSideOf(5), { ok: true, battleId: "b-1", side: "B", allyIds: [4] });
      assert.deepStrictEqual(registry.liveSideOf(8), { ok: true, battleId: "b-2", side: "B", allyIds: [] });
      assert.deepStrictEqual(registry.liveSideOf(9), { ok: false, reason: "NOT_LIVE" }, "SPAWNING");
      second.despawned = true;
      assert.deepStrictEqual(registry.liveSideOf(6), { ok: false, reason: "NOT_LIVE" }, "despawned");
      assert.deepStrictEqual(registry.liveSideOf(99), { ok: false, reason: "NOT_LIVE" });
      assert.deepStrictEqual(createUnavailableMaterialization("X").liveSideOf(2), { ok: false, reason: "NOT_LIVE" });

      const adapter = createAdapter({ moduleApi: { _cache: {} } });
      assert.strictEqual(typeof adapter.capitalFaxTools, "function");
      assert.strictEqual(adapter.capitalFaxTools().ok, false, "no server/src -> SEAM_UNAVAILABLE");
    } finally {
      fax._resetForTest();
    }
  });
};
