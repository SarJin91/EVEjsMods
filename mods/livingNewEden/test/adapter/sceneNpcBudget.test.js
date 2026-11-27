"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createSceneNpcBudget, COUNTER_NAMES } = require("../../lib/adapter/sceneNpcBudget");
const ns = require("../../lib/adapter/npcSpawn");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const config = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");
const { helpers: G } = require("../materialization/garrisonStep.test");
const { harness: MS } = require("../materialization/service.test");
const { harness: AR } = require("../ambientRats/service.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ADAPTER_DIR = path.join(MOD_DIR, "lib", "adapter");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const SYSTEM = 30000142;
const LIVE_PASS_MS = 36000;
const REFUSED = Object.freeze({ ok: false, reason: "SCENE_NPC_BUDGET", count: 150, cap: 150 });

function settings(env = {}) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.deepStrictEqual(r.errors, []);
  return r.config.perf.sceneNpc;
}

function runtimeOf(npc, other = 0) {
  const entities = new Map();
  let id = 1;
  for (let i = 0; i < npc; i += 1) entities.set(id++, { itemID: id, nativeNpc: true });
  for (let i = 0; i < other; i += 1) entities.set(id++, { itemID: id, kind: "ship" });
  const scenes = new Map([[SYSTEM, { dynamicEntities: entities, getEntityByID: (x) => entities.get(x) || null }]]);
  return Object.assign(Object.create({ isSolarSystemSceneLoaded(s) { return this.scenes.has(s); } }), { scenes });
}

function budgetOf(runtime, over = {}, mode = null) {
  const counts = [];
  const gauges = [];
  let reads = 0;
  const b = createSceneNpcBudget({ getSettings: () => ({ ...settings(), ...over }),
    getRuntime: () => {
      reads += 1;
      return { ok: true, exports: runtime };
    } });
  b.setSources({ getMode: () => mode, count: (n) => counts.push(n), gauge: (n, v) => gauges.push([n, v]) });
  return { b, counts, gauges, reads: () => reads };
}

function spawnSeam(runtime, admit) {
  const calls = [];
  let next = 7001;
  const native = { spawnNativeNpcEntityInSystem(systemId, options) {
    calls.push([systemId, options]);
    const entity = { itemID: next++ };
    return { success: true, data: { entity } };
  } };
  const byPath = { [ns.MODULE_PATHS.native]: native, [ns.MODULE_PATHS.runtime]: runtime, [ns.MODULE_PATHS.hulls]:
    { resolveFactionHullProfileID: () => null }, [ns.MODULE_PATHS.npc]: { setBehaviorOverrides() {},
    issueManualOrder() {}, wakeNpcController() {}, destroyNpcControllerByEntityID() {} },
  [ns.MODULE_PATHS.worldData]: { getStargatesForSystem: () => [], getStationsForSystem: () => [],
    getAsteroidBeltsForSystem: () => [] } };
  const seam = ns.createNpcSpawn({ requireGame: (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] }
    : { ok: false, reason: "file_not_found" }), navyProfiles: NAVY_PROFILES_BY_FACTION_ID, data: liveProfiles,
  ...(admit ? { admit } : {}) });
  return { seam, calls };
}

const SPEC = Object.freeze({ profileId: "p", anchorDescriptor: { kind: "stargate", itemID: 1 } });

module.exports = ({ test, skip }) => {
  test("SN1 gate: NORMAL 150, OVERLOADED 90, SHED 0 (materialization exempt), maxScan cut = full, no scene passes; "
    + "spawnShip refuses before the vendor", () => {
    const at149 = budgetOf(runtimeOf(149, 40));
    assert.deepStrictEqual(at149.b.admit(SYSTEM, 1, "npcSpawn"), { ok: true, count: 149, cap: 150 });
    assert.deepStrictEqual(at149.b.admit(SYSTEM, 2, "ambientRats"), { ok: false, reason: "SCENE_NPC_BUDGET",
      count: 149, cap: 150 });
    assert.deepStrictEqual(at149.counts, ["perf.sceneNpc.refused", "perf.sceneNpc.refused.ambientRats"]);
    assert.deepStrictEqual(at149.gauges, [["perf.sceneNpc.lastCount", 149], ["perf.sceneNpc.lastCount", 149]]);
    const over = budgetOf(runtimeOf(89), {}, "OVERLOADED");
    assert.deepStrictEqual([over.b.admit(SYSTEM, 1, "bounty").ok, over.b.admit(SYSTEM, 2, "bounty").cap], [true, 90]);
    const shed = budgetOf(runtimeOf(0), {}, "SHED");
    assert.deepStrictEqual(shed.b.admit(SYSTEM, 1, "heavyEvents"), { ok: false, reason: "SCENE_NPC_BUDGET", count: 0,
      cap: 0 });
    assert.deepStrictEqual(shed.b.admit(SYSTEM, 4, "materialization"), { ok: true, count: 0, cap: 150 });
    const none = budgetOf(runtimeOf(0), { shedExemptSources: "none" }, "SHED");
    assert.strictEqual(none.b.admit(SYSTEM, 1, "materialization").ok, false, "none = no exempt source");
    const cut = budgetOf(runtimeOf(0, 100), { maxScan: 64 });
    assert.deepStrictEqual(cut.b.admit(SYSTEM, 1, "npcSpawn"), { ok: false, reason: "SCENE_NPC_BUDGET", count: 64,
      cap: 150 });
    assert.deepStrictEqual(budgetOf(runtimeOf(500)).b.admit(SYSTEM + 1, 1, "npcSpawn"),
      { ok: true, count: null, cap: 150 }, "no scene = admitted (the vendor refuses anyway)");
    const odd = budgetOf(runtimeOf(150));
    odd.b.admit(SYSTEM, 1, "somethingNew");
    assert.deepStrictEqual(odd.counts, ["perf.sceneNpc.refused", "perf.sceneNpc.refused.other"]);
    assert.ok(COUNTER_NAMES.includes("other") && COUNTER_NAMES.includes("materialization"));
    const full = budgetOf(runtimeOf(150));
    const v = spawnSeam(runtimeOf(150), full.b.admit);
    assert.deepStrictEqual(v.seam.spawnShip(SYSTEM, SPEC), { ok: false, reason: "SCENE_NPC_BUDGET", count: 150,
      cap: 150 });
    v.seam.spawnShip(SYSTEM, { ...SPEC, source: "materialization" });
    assert.strictEqual(v.calls.length, 0);
    assert.deepStrictEqual(full.counts, ["perf.sceneNpc.refused", "perf.sceneNpc.refused.npcSpawn",
      "perf.sceneNpc.refused", "perf.sceneNpc.refused.materialization"]);
    assert.deepStrictEqual(v.seam.admitScene(SYSTEM, 1, "npcSpawn").reason, "SCENE_NPC_BUDGET");
  });

  test("SN2 every LNE spawn path asks admit( before its vendor call; the vendor call list of lib/adapter is complete",
    () => {
      const src = (f) => fs.readFileSync(path.join(ADAPTER_DIR, f), "utf8");
      const before = (file, gate, vendor, from = 0) => {
        const text = src(file);
        const g = text.indexOf(gate, from);
        const v = text.indexOf(vendor, g < 0 ? from : g);
        assert.ok(g >= 0 && v > g, `${file}: ${gate} before ${vendor}`);
        return v;
      };
      const ship = src("npcSpawn.js").indexOf("const spawnShip = ");
      before("npcSpawn.js", "admit(systemId, 1, sourceOf(spec, purpose))", "spawnSituationShip(loaded", ship);
      before("npcSpawn.js", "admit(systemId, 1, sourceOf(spec, purpose))",
        "loaded.mods.native.spawnNativeNpcEntityInSystem(", ship);
      before("ambientRats.js", "admit(systemId, defs.definitions.length, \"ambientRats\")",
        "tools.spawnNativeDefinitionsInContext(");
      before("bountyScene.js", "admit(s.systemId, 1, \"bounty\")", "tools.spawnNativeDefinitionsInContext(");
      before("bountyScene.js", "admit(s.systemId, (s.boss !== null ? 1 : 0) + s.escorts.length, \"bounty\")",
        "spawnBoss(spawn, s, sc.scene");
      assert.ok(!/admit/.test(src("empireBelts.js")), "empireBelts.js: no scene NPC gate");
      assert.ok(!COUNTER_NAMES.includes("empireBelts"));
      before("miningEncounters.js", "admit(systemId, toPositiveInt(input.maxCount) || 1, \"miningEncounters\")",
        "belt.maybeSpawnForSessionArrival(");
      before("miningEncounters.js", "admit(systemId, data.definitions.length, \"miningEncounters\")",
        "tools.spawnNativeDefinitionsInContext(");
      before("officerSpawn.js", "admit(i.systemId, data.definitions.length, \"officerSpawn\")", "i.reserve()");
      before("officerSpawn.js", "i.reserve()", "tools.spawnNativeDefinitionsInContext(");
      before("heavyEventScene.js", "spawn.admitScene(systemId, spec.members.length, \"heavyEvents\")",
        "spawn.spawnShip(");
      const call = /\.(spawnNativeNpcEntityInSystem|spawnNativeDefinitionsInContext|maybeSpawnForSessionArrival|spawnGroupInSystem)\(/;
      const files = fs.readdirSync(ADAPTER_DIR).filter((f) => f.endsWith(".js") && call.test(src(f))).sort();
      assert.deepStrictEqual(files, ["ambientRats.js", "bountyScene.js", "concordResponse.js", "miningEncounters.js",
        "npcSpawn.js", "officerSpawn.js"]);
      for (const f of ["heavyEventScene.js", "highsecTrafficScene.js", "situationScene.js"]) {
        assert.ok(src(f).includes("spawn.spawnShip(") && !call.test(src(f)), f);
      }
    });

  test("SN3 vendor facts: scene.dynamicEntities = new ForceFieldIndexedEntityMap (extends Map), nativeNpc = true", () => {
    const read = (rel) => path.join(SERVER_SRC, rel);
    if (!fs.existsSync(read("space/runtime/solarSystemScene.js"))) {
      skip("SN3 vendor facts", "server/src not found next to the mod (Docker image)");
      return;
    }
    const text = (rel) => fs.readFileSync(read(rel), "utf8");
    assert.ok(text("space/runtime/solarSystemScene.js").includes(
      "this.dynamicEntities = new ForceFieldIndexedEntityMap()"));
    assert.ok(/class ForceFieldIndexedEntityMap extends Map\b/.test(text("space/runtime/forceFieldContainment.js")));
    assert.ok(text("space/npc/nativeNpcService.js").includes("entity.nativeNpc = true;"));
  });

  const driver = G.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("SN4 consumers: a full scene refuses the battle, the patrol and the ambient group without a claim, row, "
    + "spawn or backoff; the next pass goes on", () => {
    const s = MS.setup(driver);
    try {
      let full = true;
      s.npc.admitScene = (sys, n, source) => {
        s.log.push(["admitScene", sys, n, source]);
        return full ? REFUSED : { ok: true, count: 0, cap: 150 };
      };
      const id = s.mk(MS.SYS);
      const before = s.rec(id);
      const svc = s.start();
      const r = svc.runPass();
      assert.deepStrictEqual([r.materialized, r.refused], [[], { SCENE_NPC_BUDGET: 1 }], JSON.stringify(r));
      const after = s.rec(id);
      assert.deepStrictEqual([after.state, after.mode, after.version], [before.state, before.mode, before.version]);
      assert.deepStrictEqual([s.npc.spawnCalls, s.count("reverted"), s.count("spawnFailed")], [0, 0, 0]);
      assert.deepStrictEqual(s.calls("admitScene")[0], ["admitScene", MS.SYS, 4, "materialization"]);
      full = false;
      assert.deepStrictEqual(svc.runPass().materialized, [id], "next pass: LIVE");
    } finally {
      s.env.close();
    }
    G.withStore(driver, (opened) => {
      const env = G.setup(opened, { gp: { startDelayMs: 0 } });
      let full = true;
      env.w.npcSpawn.admitScene = () => (full ? REFUSED : { ok: true, count: 0, cap: 150 });
      env.newFleet("sn4-g");
      env.w.player(101);
      env.pass(0);
      assert.deepStrictEqual([env.rows().length, env.w.count("spawnShip")], [0, 0]);
      const c = env.counters();
      assert.deepStrictEqual([c.refusedBudget, c.refusedBackoff || 0, c.spawnFailed || 0], [1, 0, 0]);
      full = false;
      env.pass(LIVE_PASS_MS);
      assert.strictEqual(env.rows().length, 1, "next pass: claimed (no backoff held it)");
      assert.ok(env.w.count("spawnShip") >= 1);
    });
    let refuse = true;
    const h = AR.harness({}, { refusal: () => (refuse ? REFUSED : null) });
    h.space.set(AR.SYS_A, 1);
    h.players.set(AR.SYS_A, [{ characterId: 7, entityId: 70, position: AR.P(0) }]);
    h.pass(AR.T0);
    assert.deepStrictEqual([h.calls.spawn.length, h.svc.getStatus().groups], [1, 0]);
    refuse = false;
    h.pass(AR.T0 + AR.BASE.ambientRats.spawnIntervalMs);
    assert.deepStrictEqual([h.calls.spawn.length, h.svc.getStatus().groups], [2, 1]);
    assert.deepStrictEqual(h.bad, []);
  });

  test("SN5 flag off: no scan, the vendor call bit for bit; services hands mode + counters; compose lines", () => {
    assert.deepStrictEqual([settings().enabled, settings({ EVEJS_LNE_PERF_SCENE_NPC_ENABLED: "0" }).enabled],
      [true, false]);
    assert.deepStrictEqual([settings().maxPerScene, settings().overloadedPermille, settings().shedExemptSources,
      settings().maxScan], [150, 600, "materialization", 4096]);
    const capWarn = (env) => config.resolveConfig({ modDir: MOD_DIR, env }).warnings
      .filter((w) => w.includes("below materialization.maxShipsPerBattle"));
    const matOn = { EVEJS_LNE_MATERIALIZATION_ENABLED: "1" };
    assert.deepStrictEqual(capWarn(matOn), []);
    assert.deepStrictEqual(capWarn({ EVEJS_LNE_PERF_SCENE_NPC_MAX_PER_SCENE: "50" }), [], "no materialization");
    assert.strictEqual(capWarn({ ...matOn, EVEJS_LNE_PERF_SCENE_NPC_MAX_PER_SCENE: "50" }).length, 1);
    const off = createSceneNpcBudget({ getSettings: () => settings({ EVEJS_LNE_PERF_SCENE_NPC_ENABLED: "0" }),
      getRuntime: () => assert.fail("no scan with the flag off") });
    assert.deepStrictEqual(off.admit(SYSTEM, 1000, "npcSpawn"), { ok: true, count: null, cap: null });
    const plain = spawnSeam(runtimeOf(500));
    const gated = spawnSeam(runtimeOf(500), off.admit);
    for (const spec of [SPEC, { ...SPEC, purpose: "traffic", spawnState: undefined }, { ...SPEC, ownerId: 98000001 }]) {
      plain.seam.spawnShip(SYSTEM, spec);
      gated.seam.spawnShip(SYSTEM, spec);
    }
    assert.ok(plain.calls.length > 0);
    assert.deepStrictEqual(gated.calls, plain.calls);
    let sources = null;
    const counted = [];
    const def = buildDefaultServiceDefs({ startGovernor: () => ({ ok: true, governor: { getPolicy: () => ({
      mode: "OVERLOADED" }), stop() {} } }) }).find((d) => d.name === "governor");
    const ctx = { config: {}, telemetry: { count: (n) => counted.push(n), gauge() {} },
      adapter: { setSceneNpcSources: (x) => { sources = x; } } };
    assert.deepStrictEqual(def.start(ctx, { logger: { log() {} } }), { ok: true });
    sources.count("perf.sceneNpc.refused");
    assert.deepStrictEqual([sources.getMode(), counted], ["OVERLOADED", ["perf.sceneNpc.refused"]]);
    ctx.governor = null;
    assert.strictEqual(sources.getMode(), null, "no governor = the NORMAL cap");
    const composeFile = findCompose();
    if (!composeFile) {
      skip("SN5 compose lines", "compose.yaml not found above the mod (Docker image)");
      return;
    }
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    const rows = config.SCHEMA.filter((x) => x.key.startsWith("perf.sceneNpc."));
    assert.strictEqual(rows.length, 5);
    const missing = rows.filter((x) => !Object.prototype.hasOwnProperty.call(env, x.env)
      || !text.includes(`\${${x.env}:-}`)).map((x) => x.env);
    assert.deepStrictEqual(missing, []);
  });
};
