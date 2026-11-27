"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { WRAPPED_EXPORTS, HOST_CALLBACKS, RUNTIME_MODULE, BOUNDARY_MODULE, BOUNDARY_EXPORT } =
  require("../../lib/adapter/salvageHook");

const SERVER_DIR = path.resolve(__dirname, "..", "..", "..", "..", "server");
const SRC = path.join(SERVER_DIR, "src");
const MODS_DIR = path.resolve(__dirname, "..", "..", "..");

function src(rel) {
  return fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function has(text, needle, label) {
  assert.ok(text.includes(needle), `${label}: missing ${JSON.stringify(needle)}`);
}

function fnBlock(text, header, label) {
  const at = text.indexOf(header);
  assert.ok(at >= 0, `${label}: missing ${JSON.stringify(header)}`);
  const end = text.indexOf("\nfunction ", at + header.length);
  return text.slice(at, end < 0 ? text.length : end);
}

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "test") out.push(...jsFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(path.join(SRC, "space", "modules", "salvagerRuntime.js"))) {
    skip("SV-F* salvager vendor facts", `no EveJS tree at ${SERVER_DIR}`);
    return;
  }
  const runtime = () => src(`${RUNTIME_MODULE}.js`);

  test("SV-F1 salvagerRuntime exports resolveSalvagerActivation / executeSalvagerCycle / isSalvageableTarget / "
    + "isModuleSalvagingEffectRecord; the GAME_MODULES rows are consumer `salvage`, the two wraps without FIRST_LOAD",
  () => {
    const text = runtime();
    const at = text.indexOf("\nmodule.exports = {");
    assert.ok(at >= 0, "exports block");
    const exportsBlock = text.slice(at);
    for (const name of [...WRAPPED_EXPORTS, "isSalvageableTarget", "isModuleSalvagingEffectRecord"]) {
      has(exportsBlock, `\n  ${name},`, "SV-F1 export");
    }
    const rows = GAME_MODULES.filter((m) => m.path === RUNTIME_MODULE)
      .flatMap((m) => m.symbols.map((s) => [s.name, s.consumer, s.wrap === true, s.firstLoad === true]));
    assert.deepStrictEqual(rows, [["resolveSalvagerActivation", "salvage", true, false],
      ["executeSalvagerCycle", "salvage", true, false], ["isSalvageableTarget", "salvage", false, false],
      ["isModuleSalvagingEffectRecord", "salvage", false, false],
      ["executeSalvagerCycle", "droneSalvage", false, false], ["buildSalvageChanceSnapshot", "droneSalvage", false, false],
      ["isSalvageableTarget", "droneSalvage", false, false]]);
  });

  test("SV-F5 resolveDroneSalvageSnapshot is exported and reads the controller through "
    + "getControllerDogmaContext (the proxy path of the mining/combat snapshots), null without accessBonusPercent; "
    + "tickDroneSalvage gives the cycle the drone effectState (salvageChancePercent from buildSalvageChanceSnapshot), "
    + "isEntityLockedTarget true, suppressSalvageMessages and salvageRewardLocationID (the key the mod leaves out); "
    + "buildSalvagerRuntimeCallbacks is an export of moduleRuntimeCallbacks", () => {
    const dogma = src("services/drone/droneDogma.js");
    has(dogma.slice(dogma.indexOf("\nmodule.exports = {")), "\n  resolveDroneSalvageSnapshot,", "SV-F5 export");
    const snap = fnBlock(dogma, "\nfunction resolveDroneSalvageSnapshot(droneEntity, controllerEntity) {", "SV-F5");
    has(snap, "const context = getControllerDogmaContext(controllerEntity);", "SV-F5 context");
    has(snap, "if (accessBonusPercent <= 0) {", "SV-F5 access bonus");
    for (const key of ["durationMs,", "accessBonusPercent,", "maxRangeMeters:", "orbitDistanceMeters:"]) {
      has(snap, key, "SV-F5 snapshot key");
    }
    const tick = fnBlock(src("services/drone/droneRuntime.js"),
      "\nfunction tickDroneSalvage(scene, droneEntity, controllerEntity, now) {", "SV-F5 tick");
    for (const needle of ["salvagerRuntime.buildSalvageChanceSnapshot(", "salvageChancePercent: salvageState.chanceSnapshot"
      + ".chancePercent,", "salvagerRangeMeters: snapshot.maxRangeMeters,", "moduleFlagID: 0,",
    "isEntityLockedTarget: () => true,", "suppressSalvageMessages: true,", "salvageRewardLocationID: droneEntity.itemID,",
    "salvagerRuntime.executeSalvagerCycle({"]) has(tick, needle, "SV-F5 tick");
    const callbacks = src("space/runtime/moduleRuntimeCallbacks.js");
    has(callbacks.slice(0, callbacks.indexOf("};")), "\n  buildSalvagerRuntimeCallbacks,", "SV-F5 callbacks export");
    const built = fnBlock(callbacks, "\nfunction buildSalvagerRuntimeCallbacks(scene = null) {", "SV-F5 callbacks");
    assert.ok(!built.includes("salvageRewardLocationID"), "SV-F5 module callbacks carry no reward location");
    for (const name of HOST_CALLBACKS) has(built, name, "SV-F5 host callback");
  });

  test("SV-F2 scene/modules.js and scene/tick.js call the two exports through the module object (no destructuring "
    + "anywhere in server/src): a wrap of the export after boot reaches them", () => {
    const modules = src("space/runtime/scene/modules.js");
    const tick = src("space/runtime/scene/tick.js");
    has(modules, "const salvagerRuntime = require(path.join(", "SV-F2 modules require");
    has(modules, "salvagerActivation = salvagerRuntime.resolveSalvagerActivation({", "SV-F2 activation");
    has(tick, "const salvagerRuntime = require(path.join(", "SV-F2 tick require");
    has(tick, "const cycleResult = salvagerRuntime.executeSalvagerCycle({", "SV-F2 cycle");
    has(src("space/runtime/moduleCycleBoundarySnapshot.js"), "return salvagerRuntime.resolveSalvagerActivation({",
      "SV-F2 boundary activation");
    const boundaryAt = tick.indexOf("const boundaryResult = resolveSalvagerCycleRuntimeSnapshot(");
    assert.ok(boundaryAt > 0 && boundaryAt < tick.indexOf("const cycleResult = salvagerRuntime.executeSalvagerCycle({"),
      "SV-F2 the boundary snapshot runs before the cycle");
    const destructured = jsFiles(SRC).filter((file) => {
      const text = fs.readFileSync(file, "utf8");
      return /\{\s*(?:[\w$]+\s*,\s*)*(?:resolveSalvagerActivation|executeSalvagerCycle)\b[^}]*\}\s*=\s*require/
        .test(text);
    });
    assert.deepStrictEqual(destructured, [], "SV-F2 no destructuring of the two exports");
  });

  test("SV-F3 executeSalvagerCycle reads the cargo and the session only through the callbacks of the hook (with the "
    + "entity), the reward goes to salvageRewardLocationID || the ship item; resolveSalvagerActivation takes "
    + "shipItem / skillMap / fittedItems / activeModuleContexts and options.characterID first", () => {
    const text = runtime();
    const cycle = fnBlock(text, "\nfunction executeSalvagerCycle({", "SV-F3 cycle");
    const direct = HOST_CALLBACKS.filter((name) => name.startsWith("getEntityRuntime"));
    assert.strictEqual(direct.length, 3);
    for (const name of direct) has(cycle, `callbacks.${name}`, "SV-F3 callback");
    has(cycle, "resolveCharacterID(entity, callbacks)", "SV-F3 char helper");
    has(cycle, "resolveInventorySession(entity, callbacks)", "SV-F3 session helper");
    has(cycle, "const rewardLocationID = toPositiveInt(callbacks.salvageRewardLocationID, shipID);", "SV-F3 reward");
    has(cycle, "resolveCargoSnapshot(characterID, shipItem, fittedItems, skillMap)", "SV-F3 cargo");
    const resolveChar = fnBlock(text, "\nfunction resolveCharacterID(entity, callbacks = {}) {", "SV-F3 char");
    has(resolveChar, "callbacks.resolveCharacterID(entity)", "SV-F3 char callback");
    has(fnBlock(text, "\nfunction resolveInventorySession(entity, callbacks = {}) {", "SV-F3 session"),
      "callbacks.resolveSession(entity)", "SV-F3 session callback");
    const activation = fnBlock(text, "\nfunction resolveSalvagerActivation({", "SV-F3 activation");
    for (const key of ["  shipItem,", "  skillMap = null,", "  fittedItems = null,", "  activeModuleContexts = null,",
      "  options = {},", "  callbacks = {},"]) has(activation, key, "SV-F3 activation key");
    has(activation, "buildLiveModuleAttributeMap(\n    shipItem,\n    moduleItem,\n    chargeItem,\n    skillMap,\n"
      + "    fittedItems,\n    activeModuleContexts,", "SV-F3 attributes from the args");
    has(fnBlock(text, "\nfunction resolveActivationCharacterID(", "SV-F3 activation char"),
      "options.characterID ||", "SV-F3 options.characterID");
    has(fnBlock(text, "\nfunction isSalvageableTarget(targetEntity) {", "SV-F3 target"),
      "if (targetEntity.salvaged === true || targetEntity.salvageComplete === true) {", "SV-F3 salvaged");
  });

  test("SV-F6 (round 2) the Salvager cycle boundary: tick.js destructures "
    + "resolveSalvagerCycleRuntimeSnapshot (FIRST_LOAD wrap), passes the moduleItem of getEntityRuntimeModuleItem; a "
    + "ship with a pilot reads its fit from the owner's inventory at entity.itemID; the snapshot refuses without a "
    + "moduleItem BEFORE the activation export; signature of 5 args; the GAME_MODULES row", () => {
    const tick = src("space/runtime/scene/tick.js");
    has(tick, "  resolveSalvagerCycleRuntimeSnapshot,\n} = require(\"../moduleCycleBoundarySnapshot\");", "SV-F6 tick");
    has(tick, "const moduleItem = getEntityRuntimeModuleItem(\n            entity,\n            effectState.moduleID,",
      "SV-F6 moduleItem");
    has(tick, "const boundaryResult = resolveSalvagerCycleRuntimeSnapshot(\n              this,\n              entity,\n"
      + "              moduleItem,\n              effectState,\n              cycleBoundaryMs,", "SV-F6 call");
    const view = src("space/runtime/entityDogmaView.js");
    has(fnBlock(view, "\nfunction getShipEntityInventoryCharacterID(", "SV-F6 char"),
      "entity.pilotCharacterID ??", "SV-F6 pilot first");
    has(fnBlock(view, "\nfunction getEntityRuntimeFittedItems(entity) {", "SV-F6 fit"),
      "return getFittedModuleItems(characterID, entity.itemID);", "SV-F6 owner inventory");
    const snap = fnBlock(src(`${BOUNDARY_MODULE}.js`), `\nfunction ${BOUNDARY_EXPORT}(`, "SV-F6 snapshot");
    has(snap, `function ${BOUNDARY_EXPORT}(\n  scene,\n  entity,\n  moduleItem,\n  effectState,\n  nowMs,\n) {`,
      "SV-F6 signature");
    const refuse = snap.indexOf("if (!scene || !entity || !moduleItem || !shipItem || !effectRecord) {");
    assert.ok(refuse > 0 && refuse < snap.indexOf("return salvagerRuntime.resolveSalvagerActivation({"),
      "SV-F6 refusal before the activation export");
    const rows = GAME_MODULES.filter((m) => m.path === BOUNDARY_MODULE)
      .flatMap((m) => m.symbols.map((s) => [s.name, s.consumer, s.wrap === true, s.firstLoad === true]));
    assert.deepStrictEqual(rows, [[BOUNDARY_EXPORT, "salvage", true, true]]);
  });

  test("SV-F4 no other mod wraps resolveSalvagerActivation / executeSalvagerCycle (collisions)", () => {
    const users = [];
    for (const dir of fs.readdirSync(MODS_DIR)) {
      if (dir === "shipWing") continue;
      const root = path.join(MODS_DIR, dir);
      if (!fs.statSync(root).isDirectory()) continue;
      for (const file of jsFiles(root)) {
        const text = fs.readFileSync(file, "utf8");
        if (/\b(?:resolveSalvagerActivation|executeSalvagerCycle)\s*=/.test(text)) users.push(file);
      }
    }
    assert.deepStrictEqual(users, []);
  });
};
