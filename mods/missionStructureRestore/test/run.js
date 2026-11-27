"use strict";

process.env.EVEJS_MISSION_STRUCTURE_RESTORE_NO_INSTALL = "1";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const loader = require(path.join(modDir, "loader.js"));
const configModule = require(path.join(modDir, "config.js"));
const viability = require(path.join(modDir, "lib", "viability.js"));
const wraps = require(path.join(modDir, "lib", "wraps.js"));
const { restoreAfterMaterialize } = require(path.join(modDir, "lib", "restore.js"));
const { planRestores } = require(path.join(modDir, "lib", "restorePlan.js"));

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? null : String(process.argv[onlyAt + 1] || "").split(",").filter(Boolean);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const INSTANCE_ID = 80521;
const SITE_ID = 121;
const SLOT_BASE = 3_000_000_000 + SITE_ID * 100;
const OLD_HABITAT_ID = 7777;
const OLD_NPC_ID = 7001;
const SITE_POSITION = Object.freeze({ x: 1000, y: 0, z: 0 });
const ROOM_ANCHOR = Object.freeze({ x: 50_000, y: 10, z: 20 });
const HABITAT_OFFSET = Object.freeze({ x: -35813, y: 0, z: -530 });

function makeTemplate() {
  return {
    templateID: "client-dungeon:283",
    siteFamily: "combat",
    populationHints: {
      encounters: [
        {
          key: "wave_01",
          trigger: "on_room_active",
          roomKey: "room:13850",
          spawnEntries: [
            { key: "npc_014", entityKind: "npc", typeID: 16997, label: "Pithi Invader" },
            {
              key: "structure_015", entityKind: "killableStructure", typeID: 19715, label: "Habitation Module",
              dunObjectID: 583235, dunObjectNameID: 149208, nameID: 149208, positionOffset: { ...HABITAT_OFFSET },
            },
            { key: "structure_016", entityKind: "killableStructure", typeID: 12345, label: "Bunker" },
          ],
        },
      ],
      completion: {
        mode: "objective_targets_destroyed",
        objectiveTargets: [{ key: "structure_015", label: "Habitation Module", typeID: 19715, dunObjectID: 583235 }],
      },
    },
  };
}

function makeInstance(overrides = {}) {
  return {
    instanceID: INSTANCE_ID,
    templateID: "client-dungeon:283",
    siteFamily: "mission",
    metadata: { siteID: SITE_ID },
    spawnState: {
      encounterStatesByKey: {
        wave_01: {
          key: "wave_01",
          spawnedAtMs: 1000,
          completedAtMs: 2000,
          spawnCount: 2,
          spawnedEntityIDs: [OLD_NPC_ID, OLD_HABITAT_ID],
          remainingEntityIDs: [],
          nonBlockingEntityIDs: [OLD_HABITAT_ID],
          objectiveBlockingEntityIDs: [OLD_HABITAT_ID],
          nonObjectiveEntityIDs: [OLD_NPC_ID],
          spawnedIdentitiesByEntityID: { [OLD_NPC_ID]: { typeID: 16997, contentKey: "npc_014" } },
          roomKey: "room:13850",
        },
      },
    },
    ...overrides,
  };
}

function makeScene() {
  const removed = [];
  const scene = {
    systemID: 30000142,
    staticEntitiesByID: new Map(),
    removed,
    addStaticEntity(entity) {
      if (this.staticEntitiesByID.has(entity.itemID)) return false;
      this.staticEntitiesByID.set(entity.itemID, entity);
      return true;
    },
    removeStaticEntity(entityID, options) {
      removed.push({ entityID, options });
      this.staticEntitiesByID.delete(Number(entityID));
      return { success: true };
    },
  };
  scene.staticEntitiesByID.set(SITE_ID, { itemID: SITE_ID, position: { ...SITE_POSITION } });
  return scene;
}

function makeWorld({ instance = makeInstance(), template = makeTemplate(), anchors = { "room:13850": ROOM_ANCHOR } } = {}) {
  const store = new Map([[INSTANCE_ID, JSON.parse(JSON.stringify(instance))]]);
  const calls = { spawn: [], merge: [] };
  const behaviour = { mergeThrows: false, mergeReturnsNull: false };
  const dungeonRuntime = {
    getInstance: (id) => (store.has(id) ? JSON.parse(JSON.stringify(store.get(id))) : null),
    mergeSpawnState(id, patch, options) {
      calls.merge.push({ id, patch: JSON.parse(JSON.stringify(patch)), options });
      if (behaviour.mergeThrows) throw new Error("DUNGEON_RUNTIME_WRITE_FAILED");
      if (behaviour.mergeReturnsNull) return null;
      const target = store.get(id);
      target.spawnState = { ...target.spawnState, ...JSON.parse(JSON.stringify(patch)) };
      return JSON.parse(JSON.stringify(target));
    },
  };
  const dungeonAuthority = { getTemplateByID: (id) => (id === template.templateID ? JSON.parse(JSON.stringify(template)) : null) };
  const service = function DungeonUniverseSiteService() {};
  service.ensureSiteContentsMaterialized = () => ({ success: true, data: { instanceID: INSTANCE_ID, siteID: SITE_ID } });
  service.buildSiteEntity = () => ({ itemID: SITE_ID, position: { ...SITE_POSITION } });
  service.homefrontPorts = {
    structure(scene, inst, siteEntity, plan, entries, options) {
      calls.spawn.push({ planKey: plan.key, keys: entries.map((entry) => entry.key), options });
      const out = [];
      for (const spawnEntry of entries) {
        let itemID = SLOT_BASE + 1;
        while (scene.staticEntitiesByID.has(itemID)) itemID += 1;
        const offset = spawnEntry.positionOffset || { x: 0, y: 0, z: 0 };
        const entity = {
          itemID, typeID: spawnEntry.typeID, dungeonSiteContentKey: spawnEntry.key,
          dungeonSiteInstanceID: inst.instanceID, dungeonSiteID: siteEntity.itemID, itemName: spawnEntry.label,
          position: { x: options.anchorPosition.x + offset.x, y: options.anchorPosition.y + offset.y, z: options.anchorPosition.z + offset.z },
        };
        if (scene.addStaticEntity(entity)) out.push({ entity, spawnEntry });
      }
      return out;
    },
    roomAnchor: (sitePosition, _template, roomKey) => (anchors[roomKey] ? { ...anchors[roomKey] } : null),
  };
  service._testing = {
    resolvePopulationHints: (_inst, tpl) => JSON.parse(JSON.stringify(tpl.populationHints)),
    resolveEncounterPlans: (hints) => hints.encounters.map((plan) => ({ ...plan, supported: true })),
    buildSpawnedIdentityMap: (spawned) => Object.fromEntries(spawned.map(({ entity }) => [
      String(entity.itemID), { typeID: entity.typeID, contentKey: entity.dungeonSiteContentKey },
    ])),
    applyNpcSentryEncounterProgressPolicy: (spawned) => spawned,
  };
  const lines = [];
  const deps = { service, dungeonRuntime, dungeonAuthority, nowMs: () => 5000, log: (line) => lines.push(line) };
  const wave = () => store.get(INSTANCE_ID).spawnState.encounterStatesByKey.wave_01;
  return { store, calls, behaviour, deps, service, dungeonRuntime, lines, wave };
}

const OK_RESULT = Object.freeze({ success: true, data: { instanceID: INSTANCE_ID, siteID: SITE_ID } });

test("T1 vendor facts: real server files have every seam token once, no consumer destructures the export", () => {
  const report = viability.inspect(runtimeRoot);
  assert.strictEqual(report.ok, true, JSON.stringify(report.reports.filter((entry) => !entry.ok)));
  const broken = viability.inspect(runtimeRoot, [
    { key: "dungeonUniverseSiteService", file: viability.SERVICE_FILE, required: ["no such seam token"] },
  ]);
  assert.strictEqual(broken.ok, false);
  assert.match(broken.reports[0].reason, /count 0, expected 1/u);
  const consumers = [
    "server/src/services/agent/agentMgrService.js",
    "server/src/services/dungeon/keeperService.js",
    "server/src/space/runtime/universeSiteAttach.js",
    "server/src/services/ship/beyonceService.js",
    "server/src/services/mining/miningResourceSiteService.js",
    "server/src/abyssal/runtime/abyssalEntryMovement.js",
    "server/src/abyssal/runtime/abyssalSessionRecovery.js",
    "server/src/services/activity/voidReplayRoom.js",
  ];
  const destructuring = /\{[^}]*\bensureSiteContentsMaterialized\b[^}]*\}\s*=/u;
  for (const relative of consumers) {
    const source = fs.readFileSync(path.join(runtimeRoot, ...relative.split("/")), "utf8");
    assert.ok(source.includes("ensureSiteContentsMaterialized("), `${relative} still calls the export`);
    assert.ok(!destructuring.test(source), `${relative} destructures ensureSiteContentsMaterialized`);
  }
});

test("T2 happy path: Avenge habitat restored at the room anchor, flags and wave state patched", () => {
  const world = makeWorld();
  const scene = makeScene();
  const outcome = restoreAfterMaterialize(world.deps, scene, OK_RESULT, { spawnEncounters: true });
  assert.deepStrictEqual(outcome, { ok: true, restored: 1, skipped: {} });
  assert.strictEqual(world.calls.spawn.length, 1);
  const spawnCall = world.calls.spawn[0];
  assert.deepStrictEqual(spawnCall.keys, ["structure_015"], "only the objective structure, not structure_016 or the NPC");
  assert.deepStrictEqual(spawnCall.options.anchorPosition, ROOM_ANCHOR);
  assert.strictEqual(spawnCall.options.broadcast, false);
  const newID = SLOT_BASE + 1;
  const entity = scene.staticEntitiesByID.get(newID);
  assert.strictEqual(entity.dungeonEncounterBlocksProgress, false, "wave has NPC entries");
  assert.strictEqual(entity.dungeonObjectiveProgressTarget, true);
  assert.strictEqual(entity.dungeonObjectiveTargetKey, "structure_015");
  assert.deepStrictEqual(entity.position, { x: ROOM_ANCHOR.x + HABITAT_OFFSET.x, y: 10, z: 20 + HABITAT_OFFSET.z });
  const wave = world.wave();
  assert.deepStrictEqual(wave.spawnedEntityIDs, [OLD_NPC_ID, OLD_HABITAT_ID, newID]);
  assert.strictEqual(wave.spawnCount, 3);
  assert.deepStrictEqual(wave.objectiveBlockingEntityIDs, [OLD_HABITAT_ID, newID]);
  assert.deepStrictEqual(wave.nonBlockingEntityIDs, [OLD_HABITAT_ID, newID]);
  assert.deepStrictEqual(wave.remainingEntityIDs, [], "completed wave: remaining untouched");
  assert.deepStrictEqual(wave.nonObjectiveEntityIDs, [OLD_NPC_ID]);
  assert.strictEqual(wave.spawnedIdentitiesByEntityID[String(newID)].contentKey, "structure_015");
  assert.strictEqual(wave.spawnedIdentitiesByEntityID[String(OLD_NPC_ID)].contentKey, "npc_014");
  assert.strictEqual(wave.spawnedAtMs, 1000);
  assert.strictEqual(wave.completedAtMs, 2000);
  assert.strictEqual(wave.roomKey, "room:13850");
  assert.strictEqual(world.calls.merge[0].options.durable, undefined, "plain commit, like upsertEncounterState");
  assert.deepStrictEqual(world.lines, [
    `restored instance=${INSTANCE_ID} template=client-dungeon:283 plan=wave_01 entry=structure_015 entity=${newID} room=room:13850`,
  ]);
});

test("T3 idempotency + restart: same scene 0 spawns 0 writes; new scene respawns, IDs unioned", () => {
  const world = makeWorld();
  const scene = makeScene();
  restoreAfterMaterialize(world.deps, scene, OK_RESULT, {});
  const again = restoreAfterMaterialize(world.deps, scene, OK_RESULT, {});
  assert.deepStrictEqual(again, { ok: true, restored: 0, skipped: { PRESENT: 1 } });
  assert.strictEqual(world.calls.spawn.length, 1);
  assert.strictEqual(world.calls.merge.length, 1);
  const restarted = makeScene();
  restarted.staticEntitiesByID.set(SLOT_BASE + 1, {
    itemID: SLOT_BASE + 1, dungeonSiteContentKey: "structure_099", dungeonSiteInstanceID: INSTANCE_ID,
  });
  const after = restoreAfterMaterialize(world.deps, restarted, OK_RESULT, {});
  assert.strictEqual(after.restored, 1);
  assert.strictEqual(world.calls.spawn.length, 2);
  assert.deepStrictEqual(world.wave().spawnedEntityIDs, [OLD_NPC_ID, OLD_HABITAT_ID, SLOT_BASE + 1, SLOT_BASE + 2]);
  assert.strictEqual(restarted.staticEntitiesByID.get(SLOT_BASE + 2).dungeonObjectiveTargetKey, "structure_015");
});

test("T4 skip rules", () => {
  const run = (instanceOverrides, { result = OK_RESULT, options = {}, anchors, template } = {}) => {
    const world = makeWorld({ instance: makeInstance(instanceOverrides), anchors, template });
    const outcome = restoreAfterMaterialize(world.deps, makeScene(), result, options);
    return { outcome, world };
  };
  const satisfied = run({ objectiveSatisfiedAtMs: 9 });
  assert.deepStrictEqual(satisfied.outcome, { ok: false, reason: "OBJECTIVE_SATISFIED" });
  assert.strictEqual(run({ metadata: { siteID: SITE_ID, objectiveSatisfiedAtMs: 9 } }).outcome.reason, "OBJECTIVE_SATISFIED");
  assert.strictEqual(run({ siteFamily: "anomaly" }).outcome.reason, "NOT_MISSION");
  assert.strictEqual(run({ siteFamily: "combat", siteKind: "mission" }).outcome.restored, 1);
  assert.deepStrictEqual(run({}, { options: { spawnEncounters: false } }).outcome, { ok: false, reason: "NOT_APPLICABLE" });
  assert.deepStrictEqual(run({}, { result: { success: false, errorMsg: "SITE_NOT_FOUND" } }).outcome,
    { ok: false, reason: "NOT_APPLICABLE" });
  const notSpawned = makeInstance();
  notSpawned.spawnState.encounterStatesByKey.wave_01.spawnedAtMs = 0;
  const ns = run({ spawnState: notSpawned.spawnState });
  assert.deepStrictEqual(ns.outcome.skipped, { NOT_SPAWNED: 1 });
  assert.strictEqual(ns.world.calls.spawn.length, 0);
  const noAnchor = run({}, { anchors: {} });
  assert.deepStrictEqual(noAnchor.outcome.skipped, { NO_ROOM_ANCHOR: 1 });
  assert.strictEqual(noAnchor.world.calls.spawn.length, 0);
  const entryRoom = makeTemplate();
  entryRoom.populationHints.encounters[0].roomKey = "room:entry";
  const entry = run({}, { anchors: {}, template: entryRoom });
  assert.strictEqual(entry.outcome.restored, 1);
  assert.deepStrictEqual(entry.world.calls.spawn[0].options.anchorPosition, SITE_POSITION);
  const multi = makeTemplate();
  multi.populationHints.completion.objectiveTargets.push({ key: "npc_boss", typeID: 1 });
  const destroyed = run({ metadata: { siteID: SITE_ID, objectiveTargetsDestroyed: ["structure_015"] } }, { template: multi });
  assert.deepStrictEqual(destroyed.outcome.skipped, { TARGET_DESTROYED: 1 });
  assert.strictEqual(destroyed.world.calls.spawn.length, 0);
  const base = { instance: makeInstance(), isPresent: () => false, roomAnchor: () => ROOM_ANCHOR, sitePosition: SITE_POSITION };
  assert.deepStrictEqual(planRestores({ ...base, plans: [], completion: {} }), { ok: false, reason: "NO_OBJECTIVE_TARGETS" });
  const keyless = planRestores({
    ...base,
    plans: [{ key: "wave_01", supported: true, spawnEntries: [{ entityKind: "killableStructure", typeID: 19715, objective: true }] }],
    completion: { objectiveTargets: [{ typeID: 19715 }] },
  });
  assert.deepStrictEqual(keyless.skipped, [{ reason: "NO_KEY", planKey: "wave_01", entryKey: null }]);
});

test("T5 wrapper: vanilla object returned as is, restore error counted, double wrap refused, patch failure rolls back", () => {
  const vanilla = { success: true, data: { instanceID: 1 } };
  const exportsObj = { ensureSiteContentsMaterialized: function (scene) { return this === exportsObj && scene === "s" ? vanilla : null; } };
  const stats = { calls: 0, errors: 0 };
  const errors = [];
  assert.deepStrictEqual(wraps.wrapEnsure(exportsObj, {
    restore: () => { throw new Error("boom"); }, stats, onError: (message) => errors.push(message),
  }), { ok: true });
  assert.strictEqual(exportsObj.ensureSiteContentsMaterialized("s", {}, {}), vanilla);
  assert.strictEqual(stats.errors, 1);
  assert.match(errors[0], /restore step failed/u);
  assert.deepStrictEqual(wraps.wrapEnsure(exportsObj, { restore() {}, stats, onError() {} }), { ok: false, reason: "already-wrapped" });

  const world = makeWorld();
  world.behaviour.mergeThrows = true;
  const errorLines = [];
  const runtime = loader._testing.createRuntime({
    config: Object.freeze({ ...configModule.DEFAULTS, problems: [] }),
    logFn: () => {},
    logErrorFn: (line) => errorLines.push(line),
    depsFor: () => ({ ...world.deps, log: undefined }),
  });
  assert.deepStrictEqual(runtime.applyService(world.service, "x.js"), { ok: true });
  const scene = makeScene();
  const result = world.service.ensureSiteContentsMaterialized(scene, {}, {});
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(scene.removed, [{ entityID: SLOT_BASE + 1, options: { broadcast: true } }]);
  assert.strictEqual(scene.staticEntitiesByID.has(SLOT_BASE + 1), false);
  assert.strictEqual(runtime.stats.patchFailed, 1);
  assert.strictEqual(runtime.stats.restored, 0);
  assert.strictEqual(runtime.stats.calls, 1);
  assert.strictEqual(runtime.stats.errors, 0);
  assert.match(errorLines.join("\n"), /state patch failed instance=80521 plan=wave_01/u);
  const drifted = loader._testing.createRuntime({ config: configModule.DEFAULTS, logFn() {}, logErrorFn() {} });
  const partial = function Partial() {};
  partial.ensureSiteContentsMaterialized = () => null;
  assert.deepStrictEqual(drifted.applyService(partial, "x.js"), { ok: false, reason: "drift" });
  assert.strictEqual(drifted.state.inert, true);
  assert.deepStrictEqual(drifted.applyService({}, "x.js"), { ok: false, reason: "inert" });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "msr-cfg-"));
  assert.deepStrictEqual(configModule.load(empty, {}), { enabled: true, log: true, problems: [] });
  assert.strictEqual(configModule.load(empty, { EVEJS_MISSION_STRUCTURE_RESTORE: "maybe" }).problems.length, 1);
  fs.rmSync(empty, { recursive: true, force: true });
});

let passed = 0;
let failed = 0;
const selected = tests.filter((entry) => !only || only.some((fragment) => entry.name.includes(fragment)));
for (const entry of selected) {
  try {
    entry.fn();
    passed += 1;
    console.log(`PASS ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${entry.name}`);
    console.log(error && error.stack ? error.stack : error);
  }
}
console.log(`${passed}/${selected.length} PASS`);
process.exitCode = failed > 0 ? 1 : 0;
