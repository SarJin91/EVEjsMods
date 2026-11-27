"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { GAME_MODULES, SHIP_SERVICE_GUARDED, INV_BROKER_GUARDED } = require("../../lib/adapter/gameModules");
const { READ_ONLY, guardPrototype } = require("../../lib/adapter/guards");
const { SEAM_FUNCTION, SEAM_CALL, sha256 } = require("../../lib/adapter/handshakeHook");
const { resolveConfig } = require("../../config");
const { WRAPPED_EXPORTS, SNAPSHOT_KEYS } = require("../../lib/adapter/miningHook");

function handlerNames(texts) {
  const names = new Set();
  for (const t of texts) for (const m of t.matchAll(/\n {2}(?:async )?(Handle_\w+)\(/g)) names.add(m[1]);
  return [...names].sort();
}

const SERVER_DIR = path.resolve(__dirname, "..", "..", "..", "..", "server");
const SRC = path.join(SERVER_DIR, "src");

function read(rel) {
  return fs.readFileSync(path.join(SERVER_DIR, rel), "utf8").replace(/\r\n/g, "\n");
}

function src(rel) {
  return read(path.join("src", rel));
}

function has(text, needle, label) {
  assert.ok(text.includes(needle), `${label}: missing ${JSON.stringify(needle)}`);
}

function wrapsRefreshMethod(text) {
  const N = "refreshShipEntityDerivedState";
  return new RegExp(`\\.${N}\\s*=(?!=)`).test(text)
    || new RegExp(`\\[\\s*["'\`]${N}["'\`]\\s*\\]\\s*=(?!=)`).test(text)
    || new RegExp(`defineProperty\\s*\\([^)]*["'\`]${N}["'\`]`).test(text)
    || new RegExp(`["'\`]${N}["'\`]`).test(text);
}

function block(text, header, label) {
  const at = text.indexOf(header);
  assert.ok(at >= 0, `${label}: missing ${JSON.stringify(header)}`);
  const rest = text.slice(at + header.length);
  const end = /\n\S/.exec(rest);
  return header + (end ? rest.slice(0, end.index) : rest);
}

function dirTexts(rel) {
  const dir = path.join(SRC, rel);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => src(path.join(rel, f)));
}

function definerTexts(relPath) {
  const texts = [read(path.join("src", `${relPath}.js`))];
  if (relPath === "space/runtime") texts.push(...dirTexts("space/runtime/spaceRuntime"));
  if (relPath === "services/inventory/invBrokerService") texts.push(...dirTexts("services/inventory/invBroker"));
  if (relPath === "space/runtime/solarSystemScene") texts.push(...dirTexts("space/runtime/scene"));
  return texts;
}

function oneLineExports(text) {
  const m = /\nmodule\.exports = \{ ([^}]+) \};?\n/.exec(text);
  return m ? m[1].split(",").map((s) => s.trim()) : [];
}

function symbolPatterns(name, kind) {
  if (kind === "export") return [`\n  ${name},`, `\n  ${name}:`, `\n${name}(`, `\nmodule.exports = { ${name},`];
  if (kind === "prototypeMethod") return [`\n${name}(`];
  if (kind === "exportClassPrototypeMethod") return [`\n${name}(`, `\n  ${name}(`];
  if (kind === "classPrototypeMethod") return [`\n  ${name}(`];
  if (kind === "property") return [`this.${name} =`, `\nruntimeExports.${name} =`, `\nShipService.${name} =`];
  return [`this.${name} =`];
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(path.join(SRC, "gameStore", "index.js"))) {
    skip("F* vendor facts", `no EveJS tree at ${SERVER_DIR}`);
    return;
  }

  test("F0 vendor version 261126.2 (server/package.json:3) = manifest", () => {
    const pkg = JSON.parse(read("package.json"));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "evejs-launcher.mod.json"), "utf8"));
    assert.strictEqual(pkg.version, "261126.2");
    assert.deepStrictEqual(manifest.compatibility.evejsVersions, [pkg.version]);
  });

  test("F1 spawnDynamicShip: ensureScene -> buildRuntimeShipEntity(persistSpaceState) -> spawnDynamicEntity", () => {
    const body = block(src("space/runtime/spaceRuntime/dynamicEntities.js"),
      "\nspawnDynamicShip(systemID, shipSpec, options = {}) {", "F1");
    const order = ["this.ensureScene(", "buildRuntimeShipEntity(shipSpec || {}, numericSystemID, {",
      "persistSpaceState: options.persistSpaceState === true,", "return scene.spawnDynamicEntity(entity, options);"]
      .map((needle) => body.indexOf(needle));
    assert.ok(order.every((i) => i >= 0), `F1: ${order}`);
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, "F1 order");
  });

  test("F2 buildRuntimeShipEntity passes fittedItems/skillMap to the passive state; entity copies spec fields", () => {
    const text = src("space/runtime/shipEntity.js");
    const body = block(text, "\nfunction buildRuntimeShipEntity(shipSpec, systemID, options = {}) {", "F2");
    has(body, "buildPassiveShipResourceState(\n      source.pilotCharacterID ?? source.characterID,", "F2");
    has(body, "itemID: source.itemID,", "F2");
    has(body, "fittedItems: Array.isArray(source.fittedItems) ? source.fittedItems : [],", "F2");
    has(body, "skillMap: source.skillMap instanceof Map ? source.skillMap : undefined,", "F2");
    for (const needle of ["nativeNpc: source && source.nativeNpc === true,",
      "transient: source && source.transient === true,",
      "  const conditionState = getShipConditionState(source, structureHP);\n",
      "    conditionState,\n    structureDamageBasisKnown:\n",
      "fittedItems: Array.isArray(source && source.fittedItems)",
      "nativeCargoItems: Array.isArray(source && source.nativeCargoItems)",
      "skillMap: source && source.skillMap instanceof Map"]) has(text, needle, "F2");
    const store = src("services/inventory/itemStore.js");
    has(block(store, "\nfunction getShipConditionState(shipItem, structureHP = 0) {", "F2 basis"),
      "  const basisHP = toFiniteNumber(shipItem?.structureDamageBasisHP, 0);\n"
      + "  if (basisHP > 0 && structureHP > 0 && basisHP !== structureHP) {\n"
      + "    condition.damage = condition.damage * basisHP / structureHP;", "F2 basis");
    has(store, "      // A replacement condition and its capacity must come from one record.\n"
      + "      : hasConditionState ? null : defaults.structureDamageBasisHP,", "F2 basis travels with the condition");
    has(src("space/runtime/entitySpacePersistence.js"), "      structureDamageBasisHP:\n"
      + "        entity.structureDamageBasisKnown === true && entity.conditionState?.damage > 0\n"
      + "          ? entity.structureHP\n          : null,", "F2 vendor write-back of the basis");
  });

  test("F3 TRAP: characterID > 0 with itemID 0 -> buildPassiveShipResourceState returns null", () => {
    const body = block(src("space/runtime/passiveDerivedState.js"),
      "\nfunction buildPassiveShipResourceState(characterID, shipItem, options = {}) {", "F3");
    const sessionless = body.indexOf("if (numericCharacterID <= 0) {");
    const noItem = body.indexOf("if (!shipItem.itemID) {\n    return null;\n  }");
    assert.ok(sessionless >= 0 && noItem > sessionless, `F3: ${sessionless} ${noItem}`);
    has(src("RemoteRepShow/remoteRepairFleetCommands.js"), "pilotCharacterID: 0,", "F3 RR");
  });

  test("F4 buildShipResourceState uses options.fittedItems; owner implants when charID > 0", () => {
    const text = src("services/fitting/liveFittingState.js");
    has(block(text, "\nfunction buildShipResourceState(charID, shipItem, options = {}) {", "F4"),
      "return evaluateFitResourceState(\n    resolveFitEvaluationContext(charID, shipItem, options),\n    options,\n  );", "F4");
    const body = block(text, "\nfunction resolveFitEvaluationContext(charID, shipItem, options = {}) {", "F4");
    has(body, "const fittedItems = Array.isArray(options.fittedItems)\n    ? options.fittedItems", "F4");
    has(body, "options.includeActiveImplantModifiers !== false && numericCharID > 0", "F4");
  });

  test("F5 allocateRuntimeEntityID: counter from 4.2e15, preferred bumps it", () => {
    const body = block(src("space/runtime/runtimeEntityIdentity.js"),
      "\nfunction allocateRuntimeEntityID(preferredItemID = null) {", "F5");
    has(body, "state.nextRuntimeEntityID = Math.max(state.nextRuntimeEntityID, numericPreferred + 1);", "F5");
    has(body, "const allocated = state.nextRuntimeEntityID;\n  state.nextRuntimeEntityID += 1;", "F5");
    const stateText = src("space/runtime/state.js");
    has(stateText, "const SYNTHETIC_RUNTIME_ENTITY_ID_START = 4_200_000_000_000_000;", "F5");
    has(stateText, "let nextRuntimeEntityID = SYNTHETIC_RUNTIME_ENTITY_ID_START;", "F5");
  });

  test("F6 boarding in space needs a ship item (SHIP_NOT_FOUND); findShipItemById reads the item index", () => {
    has(src("space/transitions.js"), "let targetShip = findShipItemById(targetShipID);\n  if (!targetShip) {\n"
      + "    return {\n      success: false,\n      errorMsg: \"SHIP_NOT_FOUND\",", "F6");
    const body = block(src("services/inventory/itemStore.js"), "\nfunction findShipItemById(shipId) {", "F6");
    has(body, "ensureItemIndexes().byID.get(numericShipId)", "F6");
  });

  test("F7 TRAP: loss with persistSpaceState===true reads the owner's ACTIVE ship (the Orca)", () => {
    has(src("space/runtime/combatDestruction.js"), "shipRecord: findShipItemById(entity.itemID) || null,", "F7");
    has(src("space/shipDestruction.js"), "(shipEntity.persistSpaceState === true\n"
      + "      ? getActiveShipRecord(ownerCharacterID)\n      : findShipItemById(shipEntity.itemID))", "F7");
  });

  test("F8 BaseService reads Handle_<method> from the instance at every call", () => {
    const text = src("services/baseService.js");
    has(text, "const handlerName = `Handle_${normalizedMethod}`;", "F8");
    has(text, "this[handlerName](args, session, kwargs, callContext)", "F8");
  });

  test("F9 ShipService is a class export with Handle_* on the prototype", () => {
    const text = src("services/ship/shipService.js");
    has(text, "\nclass ShipService extends BaseService {", "F9");
    has(text, "\nmodule.exports = ShipService;", "F9");
    has(text, "\n  Handle_LaunchFromContainer(args, session, kwargs) {", "F9");
  });

  test("F10 InvBrokerService: class export, invBroker/*.js attached writable, MultiAdd calls Handle_Add", () => {
    const text = src("services/inventory/invBrokerService.js");
    has(text, "\nmodule.exports = InvBrokerService;", "F10");
    const body = block(text, "\nfunction attachInvBrokerMethods(methods) {", "F10");
    has(body, "Object.defineProperty(InvBrokerService.prototype, name, {", "F10");
    has(body, "writable: true,", "F10");
    has(body, "configurable: true,", "F10");
    has(text, "this.Handle_Add([itemID, sourceLocationID], session, kwargs);", "F10");
  });

  test("F11 chatRuntime.broadcastLocalMessage read through the module object by every caller", () => {
    const text = src("_secondary/chat/chatRuntime.js");
    has(text, "\nfunction broadcastLocalMessage(session, message) {", "F11");
    has(text, "\n  broadcastLocalMessage,", "F11");
    has(src("services/chat/xmppStubServer.js"),
      "sendResult = chatRuntime.broadcastLocalMessage(session, body);", "F11");
    has(src("services/chat/chatHub.js"), "chatRuntime.broadcastLocalMessage(session, message);", "F11");
    has(src("_secondary/express/gatewayServices/localChatGatewayService.js"),
      "chatRuntime.broadcastLocalMessage(session, payload && payload.message);", "F11");
  });

  test("F12 server/index.js destructures bootWorld from ./bootstrap (FIRST_LOAD)", () => {
    has(read("index.js"), "const { bootWorld } = require(path.join(__dirname, \"./bootstrap\"));", "F12");
    has(read("bootstrap.js"), "module.exports = {\n  bootWorld,\n  PRODUCTION_STAGES,", "F12");
  });

  test("F13 findSessionByCharacterID export; session._space carries sceneKey and shipID", () => {
    const text = src("services/chat/sessionRegistry.js");
    has(text, "\nfunction findSessionByCharacterID(characterID, options = {}) {", "F13");
    has(text, "\n  findSessionByCharacterID,", "F13");
    const space = block(src("space/runtime/scene/sessions.js"), "session._space = {", "F13");
    has(space, "sceneKey: this.sceneKey,", "F13");
    has(space, "shipID: shipEntity.itemID,", "F13");
  });

  test("F14 scene.followShipEntity; removeDynamicEntity refuses session-owned entities", () => {
    has(src("space/runtime/scene/pilotCommands.js"),
      "\nfollowShipEntity(entityOrID, targetEntityID, range = 0, options = {}) {", "F14");
    const body = block(src("space/runtime/scene/dynamicEntities.js"),
      "\nremoveDynamicEntity(entityID, options = {}) {", "F14");
    has(body, "if (entity.session && options.allowSessionOwned !== true) {", "F14");
    has(body, "errorMsg: \"DYNAMIC_ENTITY_SESSION_OWNED\",", "F14");
  });

  test("F15 itemStore: SHIP_HANGAR 90, listContainerItems, findItemById", () => {
    const text = src("services/inventory/itemStore.js");
    has(text, "\n  SHIP_HANGAR: 90,", "F15");
    has(text, "\nfunction listContainerItems(ownerId, locationId, flagId = null, typeIds = null) {", "F15");
    has(text, "\nfunction findItemById(itemId) {", "F15");
    for (const name of ["ITEM_FLAGS", "listContainerItems", "findItemById"]) has(text, `\n  ${name},`, "F15");
  });

  test("F15b docked bay list: detach and disembark clear session._space; the active ship comes from "
    + "getActiveShipRecord", () => {
    const sessions = src("space/runtime/scene/sessions.js");
    for (const head of ["\ndetachSession(session, options = {}) {", "\ndisembarkSession(session, options = {}) {"]) {
      const at = sessions.indexOf(head);
      assert.ok(at >= 0, `F15b: missing ${JSON.stringify(head)}`);
      const next = sessions.slice(at + head.length).search(/\n[a-zA-Z]\w*\(/);
      const body = next >= 0 ? sessions.slice(at, at + head.length + next) : sessions.slice(at);
      has(body, "\n    session._space = null;", `F15b ${head.trim()}`);
    }
    const character = src("services/character/characterState.js");
    has(character, "\nfunction getActiveShipRecord(charId) {", "F15b");
    has(character, "\n  getActiveShipRecord,", "F15b export");
  });

  test("F16 fit and skill readers", () => {
    const text = src("services/fitting/liveFittingState.js");
    has(text, "\nfunction listFittedItemsForLocation(shipID) {", "F16");
    has(text, "\nfunction isFittedModuleItem(item) {", "F16");
    has(text, "\nfunction isFittedChargeItem(item) {", "F16");
    has(text, "\nfunction getMissingRequiredSkills(characterID, typeID) {", "F16");
    has(text, "\nconst CHARGE_CATEGORY_ID = 8;", "F16 (twinSpec fallback)");
    has(src("services/skills/skillState.js"), "\nfunction getCachedCharacterSkillMap(charId) {", "F16");
  });

  test("F17 RPC refusal through throwWrappedUserError(\"CustomNotify\", ...)", () => {
    const text = src("common/machoErrors.js");
    has(text, "\nfunction throwWrappedUserError(message = \"\", values = {}) {", "F17");
    has(text, "\n  throwWrappedUserError,", "F17");
    has(src("services/ship/shipService.js"), "throwWrappedUserError(\"CustomNotify\", {", "F17");
  });

  test("F19 world gate inputs: env role, world.database, gameStore._processRole", () => {
    has(read("index.js"), "process.env.EVEJS_GAMESTORE_OWNER_ROLE = \"world\";", "F19");
    const boot = read("bootstrap.js");
    has(boot, "const database = require(path.join(__dirname, \"./src/gameStore\"));", "F19");
    has(boot, "\n    gatewayRuntime,\n    database,\n", "F19 world object");
    has(src("gameStore/index.js"), "\n  _processRole: PROCESS_ROLE,", "F19");
  });

  test("F20 Handle_* completeness: READ_ONLY names exist, the minimum list is guarded, "
    + "every other vendor handler gets wrapped (fail-closed)", () => {
    const shipNames = handlerNames([src("services/ship/shipService.js")]);
    const invText = src("services/inventory/invBrokerService.js");
    const attachLine = /\nattachInvBrokerMethods\(require\(path\.join\(__dirname, "\.\/invBroker\/(\w+)"\)\)\);/g;
    const attached = [...invText.matchAll(attachLine)].map((m) => m[1]);
    assert.ok(attached.length >= 9, `F20 attached: ${attached}`);
    const invNames = handlerNames([invText, ...attached.map((f) => src(`services/inventory/invBroker/${f}.js`))]);
    for (const [label, names, readOnly, minimum] of [
      ["ShipService", shipNames, READ_ONLY.ShipService, SHIP_SERVICE_GUARDED],
      ["InvBrokerService", invNames, READ_ONLY.InvBrokerService, INV_BROKER_GUARDED],
    ]) {
      assert.deepStrictEqual(readOnly.filter((n) => !names.includes(n)), [], `${label}: dead READ_ONLY entries`);
      assert.deepStrictEqual(minimum.filter((n) => !names.includes(n) || readOnly.includes(n)), [],
        `${label}: minimum guarded list`);
      const proto = {};
      for (const n of names) proto[n] = function vendorHandler() {};
      const result = guardPrototype(proto, readOnly, (_name, fn) => fn.bind(null));
      assert.deepStrictEqual(result.guarded, names.filter((n) => !readOnly.includes(n)), label);
      assert.strictEqual(result.readOnly.length, readOnly.length, label);
    }
  });

  test("F21 InvBroker bound context: inventoryID/locationID fields, read by currentBoundObjectID, "
    + "MachoBindObject nested call sets it and dispatches through callMethod", () => {
    const text = src("services/inventory/invBrokerService.js");
    has(text, "  _rememberBoundContext(oidString, context) {\n    if (!oidString) {\n      return;\n    }\n\n"
      + "    this._boundContexts.set(oidString, {\n      inventoryID: context.inventoryID ?? null,\n"
      + "      locationID: context.locationID ?? null,", "F21");
    has(text, "  _getBoundContext(session) {\n    if (!session || !session.currentBoundObjectID) {\n"
      + "      return null;\n    }\n\n"
      + "    return this._boundContexts.get(session.currentBoundObjectID) || null;", "F21");
    has(text, "          session.currentBoundObjectID = idString;\n        }\n"
      + "        callResult = this.callMethod(", "F21");
    has(src("services/ship/shipService.js"), "      callResult = this.callMethod(\n        methodName,", "F21 ship");
  });

  test("F23: spawnDynamicEntity sets dynamicEntities BEFORE calls without try, getEntityByID reads "
    + "dynamicEntities -> a throw after the set leaves the twin findable by the core (adapter.entity)", () => {
    const dyn = src("space/runtime/scene/dynamicEntities.js");
    const body = block(dyn, "\nspawnDynamicEntity(entity, options = {}) {", "F23");
    const order = ["this.dynamicEntities.set(entity.itemID, entity);", "this.trackInterdictionVolume(entity,",
      "this.markBallJoiningMovement(entity);", "this.reboxBall(entity);", "spatialTrace.recordEntitySpawn(",
      "this.broadcastAddBalls([entity]", "success: true,"].map((needle) => body.indexOf(needle));
    assert.ok(order.every((i) => i >= 0), `F23: ${order}`);
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, "F23 order");
    assert.ok(!/\btry\s*\{/.test(body.slice(order[0], order[order.length - 1])), "F23: no try after the set");
    has(block(dyn, "\ngetEntityByID(entityID) {", "F23"), "this.dynamicEntities.get(entityKey) ||", "F23");
  });

  test("F22 live adapter reads: scene getEntityByID / getCurrentSimTimeMs / getEntitySurfaceDistance "
    + "runtime.scenes registry, spawn result data.entity, session identity fields, gameStore shutdown hook", () => {
    const dyn = src("space/runtime/scene/dynamicEntities.js");
    has(dyn, "\ngetEntityByID(entityID) {", "F22 dynamicEntities");
    has(block(dyn, "\nremoveDynamicEntity(entityID, options = {}) {", "F22"), "unregisterDynamicEntity", "F22 remove");
    const clock = src("space/runtime/scene/clock.js");
    has(clock, "\ngetCurrentSimTimeMs() {", "F22 clock");
    has(block(clock, "\ngetEntitySurfaceDistance(sourceEntity, targetEntity) {", "F22"), "return Infinity;", "F22");
    const runtime = src("space/runtime.js");
    has(runtime, "class SceneRegistry extends Map {", "F22 runtime");
    has(runtime, "this.scenes = new SceneRegistry();", "F22 runtime");
    has(runtime, "Object.assign(runtimeExports, runtimeSingleton);", "F22 runtime (scenes Map shared by reference)");
    has(block(src("space/runtime/spaceRuntime/sessions.js"), "\ngetSceneForSession(session) {", "F22"),
      "this.scenes.get(sceneKey)", "F22 getSceneForSession reads, never loads");
    const rr = src("RemoteRepShow/remoteRepairFleetCommands.js");
    has(rr, "!spawnResult.success || !spawnResult.data || !spawnResult.data.entity", "F22 spawn result");
    has(rr, "corporationID: Number(ownerSession && ownerSession.corporationID || 0) || 0,", "F22 session fields");
    const gameStore = src("gameStore/index.js");
    has(gameStore, "\nfunction registerShutdownHook(name, handler) {", "F22 gameStore");
    has(gameStore, "\n  registerShutdownHook,\n", "F22 gameStore export");
  });

  test("W1a-F1 bootstrap: one ServiceManager instance, carried by the world object", () => {
    const boot = read("bootstrap.js");
    has(boot, "  const serviceManager = new ServiceManager();", "W1a-F1");
    has(block(boot, "  const world = {", "W1a-F1"), "\n    serviceManager,\n", "W1a-F1 world object");
  });

  test("W1a-F2 ServiceManager.prototype.register (name from service.name, a taken name only warns) and lookup", () => {
    const text = src("services/serviceManager.js");
    has(text, "\nmodule.exports = ServiceManager;", "W1a-F2");
    has(text, "  register(service) {\n    const name = service.name;", "W1a-F2");
    has(text, "    if (this._services.has(name)) {\n      log.warn(`service already registered: ${name}`);\n    }\n"
      + "    service.serviceManager = this;\n    this._services.set(name, service);", "W1a-F2 overwrite");
    has(text, "  lookup(name, session = undefined) {\n    const service = this._services.get(name);\n"
      + "    if (service) return service;", "W1a-F2");
  });

  test("W1a-F3 BaseService: constructor(name), Handle_${normalizedMethod} dispatch, class export", () => {
    const text = src("services/baseService.js");
    has(text, "  constructor(name) {\n    this._name = name;\n  }", "W1a-F3");
    has(text, "  callMethod(method, args, session, kwargs, callContext = null) {", "W1a-F3");
    has(text, "const handlerName = `Handle_${normalizedMethod}`;", "W1a-F3");
    has(text, "\nmodule.exports = BaseService;", "W1a-F3");
  });

  test("W1a-F4 ClientSession.prototype.sendNotification(notifyType, idType, payloadTuple; closed socket skips", () => {
    const text = src("network/clientSession.js");
    const body = block(text, "  sendNotification(notifyType, idType, payloadTuple = []) {", "W1a-F4");
    has(body, "if (!this.socket || this.socket.destroyed) {", "W1a-F4");
    has(src("utils/synchronizedTimeDilation.js"), "\"OnSetTimeDilation\",", "W1a-F4 pattern");
  });

  test("W1a-F5 marshal.js requires only gameFrame, path and marshalStringTable (no require in the last two) - safe "
    + "for tests (gameFrame since 261108.1)", () => {
    const requires = (t) => [...t.matchAll(/require\(\s*([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
    assert.deepStrictEqual(requires(src("network/tcp/utils/marshal.js")),
      ["\"../../gameFrame\"", "\"path\"", "path.join(__dirname, \"../../../common/marshalStringTable\""]);
    assert.deepStrictEqual(requires(src("common/marshalStringTable.js")), []);
    assert.deepStrictEqual(requires(src("network/gameFrame.js")), []);
  });

  test("S4-F23/F24 combatDestruction takes destroyShipEntityWithWreck through lazyRequire at every call (module "
    + "object kept); options carry shipRecord, skipInsurance, insuranceSuppressedReason", () => {
    const text = src("space/runtime/combatDestruction.js");
    has(text, "      destroyShipEntityWithWreck,\n      destroyShipEntityWithoutWreck,\n"
      + "    } = lazyRequire(\"./shipDestruction\");", "S4-F23");
    has(text, "      : destroyShipEntityWithWreck;", "S4-F23");
    const boundary = src("space/runtime/runtimeModuleBoundary.js");
    has(boundary, "resolved = require(path.join(runtimeEntryDirname, relativeId));", "S4-F23");
    has(boundary, "_lazyModuleCache.set(relativeId, resolved);", "S4-F23");
    has(boundary, "const runtimeEntryDirname = require(\"path\").resolve(__dirname, \"..\");", "S4-F23 base dir");
    for (const needle of ["shipRecord: findShipItemById(entity.itemID) || null,",
      "skipInsurance: options.skipInsurance === true,",
      "insuranceSuppressedReason: options.insuranceSuppressedReason,"]) has(text, needle, "S4-F24");
    has(src("space/shipDestruction.js"), "\n  destroyShipEntityWithWreck,\n  destroyShipEntityWithoutWreck,", "S4-F23");
  });

  test("S4-F25/F27 destroyShipEntityWithWreck: options.shipRecord first, wreck transient from the entity, contents "
    + "resolved into the wreck before the wreck spawns, lootOutcome.items in the result", () => {
    const body = block(src("space/shipDestruction.js"),
      "\nfunction destroyShipEntityWithWreck(systemID, shipEntity, options = {}) {", "S4-F25");
    const order = ["    options.shipRecord ||\n    (shipEntity.persistSpaceState === true",
      "transient: shipEntity.transient === true,",
      "resolveLocationDeathOutcome(shipRecord.itemID, {\n        rootLootLocationID: wreckItem.itemID,",
      "removeDestroyedShipEntityFromSpace(", "spaceRuntime.spawnDynamicInventoryEntity(",
      "handleInsuranceShipDestroyedSafe(", "lootOutcome: {\n        items: killmailItems,"]
      .map((needle) => body.indexOf(needle));
    assert.ok(order.every((i) => i >= 0), `S4-F25: ${order}`);
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, "S4-F25 order");
    has(body, "seed: `ship:${shipEntity.itemID}:${now}`,", "S4-F25 seed");
    has(body, "      wreck: wreckItem,", "S4-F25 data.wreck");
  });

  test("S4-F26/F30 retail drop rules, forceAllDestroyed; destroyItem -> custody void with DEATH_ITEM_DESTROY, "
    + "a durable local move (receipt by key)", () => {
    const resolver = src("services/killmail/deathOutcomeResolver.js");
    has(resolver, "(numericFlagID >= RIG_FLAG_MIN && numericFlagID <= RIG_FLAG_MAX) ||", "S4-F26");
    has(block(resolver, "\nfunction resolveLocationDeathOutcome(locationID, options = {}) {", "S4-F26"),
      "    options.forceAllDestroyed === true\n      ? null", "S4-F26");
    has(resolver, "\n  resolveLocationDeathOutcome,", "S4-F26");
    const custody = block(src("services/inventory/deathItemCustody.js"), "\nfunction destroyItem(command = {}) {",
      "S4-F30");
    for (const needle of ["to: itemCustody.custodyRef.void(),",
      "options: { removeContents: command.removeContents === true },",
      "reason: itemCustody.CUSTODY_REASON.DEATH_ITEM_DESTROY,", "String(command.idempotencyKey || \"\").trim() ||"]) {
      has(custody, needle, "S4-F30");
    }
    has(block(src("services/inventory/itemCustody.js"), "\nconst DURABLE_LOCAL_MOVE_REASONS = new Set([", "S4-F30"),
      "CUSTODY_REASON.DEATH_ITEM_DESTROY,", "S4-F30 durable");
  });

  test("S4-F28/F29/F33 a non-persisted entity: persistShipEntity skips it, no owner session (twin != session ship), "
    + "no air death receipt; conditionState of the entity is what a ship keeps; updateShipItem", () => {
    const persistence = src("space/runtime/entitySpacePersistence.js");
    has(persistence, "if (!entity || entity.kind !== \"ship\" || entity.persistSpaceState !== true) {", "S4-F28");
    has(persistence, "normalizeShipConditionState(entity.conditionState),", "S4-F33");
    has(src("space/runtime/entityOwnerSession.js"),
      "toInt(session._space && session._space.shipID, 0) === shipID &&", "S4-F29");
    has(src("space/combat/airCombatPolicy.js"), "if (record?.shipID !== entity?.itemID) return null;", "S4-F29");
    const items = src("services/inventory/itemStore.js");
    has(items, "\nfunction updateShipItem(shipId, updater) {\n"
      + "  const updateResult = updateInventoryItem(shipId, updater);", "S4-F33");
    has(items, "\nfunction normalizeShipConditionState(rawValue) {", "S4-F33");
    has(items, "\nconst SHIP_CATEGORY_ID = 6;", "S4 vendor.js SHIP_CATEGORY_ID");
  });

  test("S4-F31/F32/F34/F35/F36 killmail victim = pilot of the entity; killmark needs a capsuleer attacker; item "
    + "change batch to a session; gameStore flush 2 s; two repackage entries", () => {
    const killmail = src("space/combat/killmailTracker.js");
    has(killmail, "targetEntity.pilotCharacterID ?? targetEntity.characterID", "S4-F31");
    has(src("space/runtime/weaponCycle.js"), "recordKillmailFromDestruction", "S4-F31");
    has(block(killmail, "\nfunction canAwardKillmark(targetEntity, attackerEntity, finalAttacker, victimIdentity) {",
      "S4-F32"), "    attackerCharacterID <= 0 ||", "S4-F32");
    const character = src("services/character/characterState.js");
    has(character, "\nfunction getActiveShipRecord(charId) {", "S4-F34");
    has(character, "\nfunction emitItemsChangedBatchForSession(session, changes = [], options = {}) {", "S4-F34");
    has(src("space/shipDestruction.js"), "return emitItemsChangedBatchForSession(session, [change], {\n"
      + "    idType: \"charid\",", "S4-F34 pattern");
    has(src("gameStore/index.js"), "const FLUSH_DELAY_MS = 2000;", "S4-F35");
    has(src("services/station/repackagingService.js"), "    repackageItemsForSession(", "S4-F36");
    has(src("services/station/repairService.js"), "    repackageItemsForSession(", "S4-F36");
    has(src("space/worldData.js"), "\nfunction getSolarSystemByID(solarSystemID) {", "S4 hull in space");
  });

  test("S4 no other mod wraps destroyShipEntityWithWreck (collisions)", () => {
    const modsDir = path.resolve(__dirname, "..", "..", "..");
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && fs.readFileSync(full, "utf8").includes("destroyShipEntityWithWreck")) {
          hits.push(path.relative(modsDir, full).split(path.sep)[0]);
        }
      }
    };
    walk(modsDir);
    assert.deepStrictEqual([...new Set(hits)].sort(), ["shipWing"]);
  });

  test("W1b-F1/F2/F3 handshake.js: buildTidiSignedFunc and its closure call, hash in the default "
    + "clientWindowHandshakeHashes, buildMarshaledString writes 0x74 + ascii", () => {
    const text = src("network/tcp/handshake.js");
    has(text, SEAM_FUNCTION, "W1b-F1");
    has(text, SEAM_CALL, "W1b-F1 call");
    const defaults = resolveConfig({ modDir: path.join(SERVER_DIR, "..", "mods", "shipWing"), env: {} }).config;
    assert.ok(defaults.clientWindowHandshakeHashes.includes(sha256(text)), `W1b-F2 hash ${sha256(text)}`);
    const body = block(text, "function buildMarshaledString(str) {", "W1b-F3");
    has(body, "buf[0] = 0x74;", "W1b-F3");
    has(body, "buf.write(str, 5, \"ascii\");", "W1b-F3");
  });

  const otherMods = path.join(SERVER_DIR, "..", "mods");
  const moonFile = path.join(otherMods, "moonOreAnomalies", "lib", "transientNames.js");
  const dcbFile = path.join(otherMods, "droneClassBalance", "simulation", "delivery.js");
  if (fs.existsSync(moonFile)) {
    test("W1b-F4a mod fact: moon wraps the login call site and owns its symbol", () => {
      const text = fs.readFileSync(moonFile, "utf8");
      has(text, "const compose = `((packet) => ${OWNER}?.compose(this.socket, packet) ?? packet)`;",
        "W1b-F4 moon call-site wrapper");
      has(text, "const KEY = Symbol.for(\"evejs.moonOreAnomalies.transientNames\");", "W1b-F4 moon symbol");
    });
  } else {
    skip("W1b-F4a mod fact: moon", `no ${moonFile}`);
  }
  if (fs.existsSync(dcbFile)) {
    test("W1b-F4b mod fact: DCB owns the family symbol", () => {
      has(fs.readFileSync(dcbFile, "utf8"), "const KEY = \"evejs.ourMods.privateFittingRuntime\";", "W1b-F4 DCB");
    });
  } else {
    skip("W1b-F4b mod fact: DCB", `no ${dcbFile}`);
  }

  test("S2-F7/F8 refreshShipEntityDerivedState reads getEntityRuntimeShipItem(entity), which for a piloted entity "
    + "(twin: pilotCharacterID = owner) returns resolveActiveShipRecord(characterID) = the owner's active ship", () => {
    const view = src("space/runtime/entityDogmaView.js");
    const shipItem = block(view, "\nfunction getEntityRuntimeShipItem(entity) {", "S2-F7");
    has(shipItem, "const characterID = getShipEntityInventoryCharacterID(entity, 0);", "S2-F7");
    has(shipItem, "if (characterID > 0) {", "S2-F7");
    has(shipItem, ": resolveActiveShipRecord(characterID) ||", "S2-F7");
    has(block(view, "\nfunction getShipEntityInventoryCharacterID(entity, fallback = 0) {", "S2-F7"),
      "entity.pilotCharacterID ??", "S2-F7 pilot first");
    const refresh = block(src("space/runtime/scene/shipDerivedState.js"),
      "\nrefreshShipEntityDerivedState(entityOrID, options = {}) {", "S2-F8");
    has(refresh, "const shipRecord = getEntityRuntimeShipItem(entity);", "S2-F8");
    has(refresh, "const fittedItems = getEntityRuntimeFittedItems(entity);", "S2-F8");
  });

  test("S2-F9 scene mixins on SolarSystemScene.prototype are writable+configurable, the class is exported as "
    + "{ SolarSystemScene }; no other mod wraps refreshShipEntityDerivedState", () => {
    const runtime = src("space/runtime.js");
    has(runtime, "  require(\"./runtime/scene/shipDerivedState\"),", "S2-F9 mixin table");
    has(runtime, "    Object.defineProperty(SolarSystemScene.prototype, methodName, {\n      ...descriptor,\n"
      + "      enumerable: false,\n      writable: true,\n      configurable: true,\n    });", "S2-F9 writable");
    has(src("space/runtime/solarSystemScene.js"), "Object.assign(module.exports, {\n  SolarSystemScene,\n});",
      "S2-F9 export");
    has(src("space/runtime/scene/shipDerivedState.js"), "return this.refreshShipEntityDerivedState(entity, {",
      "S2-F9 call through this");
    const modsDir = path.resolve(__dirname, "..", "..", "..");
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && wrapsRefreshMethod(fs.readFileSync(full, "utf8"))) {
          hits.push(path.relative(modsDir, full).split(path.sep)[0]);
        }
      }
    };
    walk(modsDir);
    assert.deepStrictEqual([...new Set(hits)].sort(), ["shipWing"]);
  });

  test("S2-F9 control: the wrap detector flags assignment/defineProperty/string name, not a call", () => {
    assert.strictEqual(wrapsRefreshMethod("r = scene.refreshShipEntityDerivedState(entity, { a: 1 });"), false);
    assert.strictEqual(wrapsRefreshMethod("if (typeof scene.refreshShipEntityDerivedState !== \"function\") {}"),
      false);
    assert.strictEqual(wrapsRefreshMethod("const x = a.refreshShipEntityDerivedState === b;"), false);
    assert.strictEqual(wrapsRefreshMethod("proto.refreshShipEntityDerivedState = function w(...a) {};"), true);
    assert.strictEqual(wrapsRefreshMethod("proto[\"refreshShipEntityDerivedState\"] = wrap;"), true);
    assert.strictEqual(wrapsRefreshMethod(
      "Object.defineProperty(Scene.prototype, 'refreshShipEntityDerivedState', { value: w });"), true);
    assert.strictEqual(wrapsRefreshMethod("const METHOD = \"refreshShipEntityDerivedState\";"), true);
  });

  const mining = () => src("services/mining/miningRuntime.js");
  const cycleBody = (text) => {
    const at = text.indexOf("\nfunction executeMiningCycle(");
    const end = text.indexOf("\nfunction ", at + 1);
    assert.ok(at >= 0 && end > at, "S2: executeMiningCycle not found");
    return text.slice(at, end);
  };
  test("S2-F1 resolveEntityCharacterID = session char or `entity.characterID ?? entity.pilotCharacterID` (?? keeps "
    + "the twin's characterID 0); twinSpec sets characterID 0", () => {
    const body = block(mining(), "\nfunction resolveEntityCharacterID(entity) {", "S2-F1");
    has(body, "entity.session && entity.session.characterID", "S2-F1 session");
    has(body, ": entity.characterID ?? entity.pilotCharacterID,", "S2-F1");
    has(fs.readFileSync(path.join(__dirname, "..", "..", "lib", "core", "twinSpec.js"), "utf8"),
      "    characterID: 0,", "S2-F1 twinSpec");
  });

  test("S2-F3 executeMiningCycle: a non-NPC entity takes its hold from resolveDestinationFlagForPlayer; the storage "
    + "snapshot is null for character 0 -> availableVolume 0 -> cargo stop", () => {
    const text = mining();
    const cycle = cycleBody(text);
    has(cycle, "  if (!isNativeNpcEntity(entity)) {\n    const destination = resolveDestinationFlagForPlayer(",
      "S2-F3 branch");
    has(cycle, "    if (availableVolume <= 0) {\n      return { success: false, stopReason: \"cargo\" };",
      "S2-F3 stop");
    has(block(text, "\nfunction getPlayerShipStorageSnapshot(entity) {", "S2-F3"),
      "  if (characterID <= 0 || shipID <= 0) {\n    return null;", "S2-F3 null");
    has(block(text, "\nfunction getAvailableVolumeForFlag(storageSnapshot, flagID) {", "S2-F3"),
      "  if (!storageSnapshot || !storageSnapshot.resourceState) {\n    return 0;", "S2-F3 zero");
    has(cycle, ": prepareMiningCycleBoundary(entity, effectState, cycleBoundaryMs);", "S2-F3 local prepare");
  });

  test("S2-F4 result shape of executeMiningCycle (data keys, nextCycleRuntimeAttrs) and what the tick reads", () => {
    const cycle = cycleBody(mining());
    for (const key of ["targetID,", "yieldTypeID: mineableState.yieldTypeID,", "transferredQuantity,",
      "normalQuantity: miningResult.normalQuantity,", "criticalHitQuantity: miningResult.criticalHitQuantity,",
      "wastedQuantity: miningResult.wastedQuantity,", "efficiency,", "partialCycle: options.partialCycle === true,",
      "crystalResult,", "depleted: Boolean(deltaResult.data && deltaResult.data.depleted),",
      "nextCycleRuntimeAttrs: {\n        capNeed: snapshot.capNeed,\n        durationMs: snapshot.durationMs,\n"
        + "        durationAttributeID: snapshot.durationAttributeID,"]) {
      has(cycle, key, "S2-F4");
    }
    has(cycle, "  const deltaResult = applyMiningDelta(\n    scene,\n    targetEntity,", "S2-F4 delta");
    const tick = src("space/runtime/scene/tick.js");
    has(tick, "cycleResult.data.nextCycleRuntimeAttrs || null;", "S2-F4 tick reads");
    has(tick, "} else if (cycleResult.data.depleted === true) {", "S2-F4 tick depleted");
  });

  test("S2-F5 tick/modules read miningRuntime through lazyRequire (module object cached) and call the exports at "
    + "every use; module.exports is a plain object with the three names", () => {
    const tick = src("space/runtime/scene/tick.js");
    has(tick, "miningRuntimeForCycle = lazyRequire(\"../services/mining/miningRuntime\");", "S2-F5 lazy");
    has(tick, "miningRuntimeForCycle.prepareMiningCycleBoundary(", "S2-F5 prepare");
    has(tick, "miningRuntimeForCycle.executeMiningCycle(", "S2-F5 execute");
    has(tick, "{ preparedCycle: preparedMiningCycle },", "S2-F5 prepared passed back");
    const modules = src("space/runtime/scene/modules.js");
    has(modules, "miningActivation = miningRuntime.resolveMiningActivation(", "S2-F5 activation");
    has(modules, "partialMiningCycleResult = miningRuntime.executeMiningCycle(", "S2-F5 short cycle");
    const boundary = block(src("space/runtime/runtimeModuleBoundary.js"), "\nfunction lazyRequire(relativeId) {",
      "S2-F5");
    has(boundary, "resolved = require(path.join(runtimeEntryDirname, relativeId));", "S2-F5 module object");
    has(boundary, "_lazyModuleCache.set(relativeId, resolved);", "S2-F5 cache");
    const exportsBlock = block(mining(), "\nmodule.exports = {", "S2-F5");
    for (const name of Object.keys(WRAPPED_EXPORTS)) has(exportsBlock, `\n  ${name},`, "S2-F5 export");
  });

  test("S2-F6 buildMiningModuleSnapshot({...}) keys = SNAPSHOT_KEYS of the mining hook (vendor order)", () => {
    const signature = block(src("services/mining/miningDogma.js"), "\nfunction buildMiningModuleSnapshot({",
      "S2-F6");
    const keys = [...signature.matchAll(/\n {2}(\w+)(?: = [^,]+)?,/g)].map((m) => m[1]);
    assert.deepStrictEqual(keys, [...SNAPSHOT_KEYS]);
    const call = block(mining(),
      "\nfunction buildEntityMiningSnapshot(entity, moduleItem, effectRecord, options = {}) {", "S2-F6");
    for (const key of SNAPSHOT_KEYS) {
      assert.ok(new RegExp(`\\n {4}${key}[:,]`).test(call), `S2-F6 vendor call passes ${key}`);
    }
  });

  test("S2 no other mod wraps the three miningRuntime exports (collisions)", () => {
    const WRAPPED_RE = /resolveMiningActivation|prepareMiningCycleBoundary|executeMiningCycle/;
    const modsDir = path.resolve(__dirname, "..", "..", "..");
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")
          && WRAPPED_RE.test(fs.readFileSync(full, "utf8"))) {
          hits.push(path.relative(modsDir, full).split(path.sep).join("/"));
        }
      }
    };
    walk(modsDir);
    const OBSERVER = "livingNewEden/lib/adapter/shipAiActivity.js";
    const LNE_ALLOWED = [OBSERVER, "livingNewEden/lib/adapter/gameModules.js"];
    const foreign = hits.filter((rel) => !rel.startsWith("shipWing/") && !LNE_ALLOWED.includes(rel)
      && !rel.startsWith("livingNewEden/test/"));
    assert.deepStrictEqual(foreign, [], "S2: no other wrap of the three exports");
    assert.ok(hits.some((rel) => rel.startsWith("shipWing/lib/")), "S2: the ShipWing wrap is found");
    const lne = fs.existsSync(path.join(modsDir, OBSERVER)) ? fs.readFileSync(path.join(modsDir, OBSERVER), "utf8") : "";
    if (lne) {
      assert.ok(lne.includes("const out = base.apply(this, arguments);") && /return out;\r?\n/.test(lne),
        "S2: the LNE wrap calls its predecessor with the same args and returns its result");
    }
  });

  const sceneFile = (name) => src(`space/runtime/scene/${name}.js`);
  test("S2C-F1 activateGenericModule(session, moduleItem, effectName, options): entity of the session (_space.shipID), "
    + "module located on the entity, MODULE_ALREADY_ACTIVE; mining effect = getTypeEffectRecords + "
    + "isMiningEffectRecord; twin modules sit on the twin", () => {
    const modules = sceneFile("modules");
    const activate = block(modules, "\n  activateGenericModule(session, moduleItem, effectName, options = {}) {",
      "S2C-F1");
    has(activate, "const entity = this.getShipEntityForSession(session);", "S2C-F1 entity");
    has(activate, "toInt(moduleItem.locationID, 0) !== toInt(entity.itemID, 0)", "S2C-F1 location");
    has(activate, "return { success: false, errorMsg: \"MODULE_ALREADY_ACTIVE\" };", "S2C-F1 active");
    has(sceneFile("dynamicEntities"), "session._space.shipID ?? session.shipID", "S2C-F1 session ship");
    has(modules, "\ndeactivateGenericModule(session, moduleID, options = {}) {", "S2C-F1 deactivate");
    has(block(mining(), "\nfunction findMiningEffectRecordForModule(moduleItem) {", "S2C-F1"),
      ".find((effectRecord) => isMiningEffectRecord(effectRecord, moduleItem))", "S2C-F1 effect");
    has(src("services/fitting/liveFittingState.js"), "\nfunction getTypeEffectRecords(typeID) {", "S2C-F1");
    has(fs.readFileSync(path.join(__dirname, "..", "..", "lib", "core", "twinSpec.js"), "utf8"),
      "locationID: twinEntityId,", "S2C-F1 twinSpec");
  });

  test("S2C-F2 activeModuleEffects = Map moduleID -> effectState (set at activation, deleted at stop); the tick ends "
    + "a mining effect on a cycle stopReason (also miningDepleted)", () => {
    const modules = sceneFile("modules");
    has(modules, "entity.activeModuleEffects.set(normalizedModuleID, effectState);", "S2C-F2 set");
    has(modules, "entity.activeModuleEffects.delete(normalizedModuleID);", "S2C-F2 delete");
    const tick = sceneFile("tick");
    has(tick, "cycleStopReason = cycleResult.stopReason || \"mining\";", "S2C-F2 stop");
    has(tick, "cycleStopReason = \"miningDepleted\";", "S2C-F2 depleted");
    has(tick, "if (cycleStopReason) {", "S2C-F2 stop branch");
  });

  test("S2C-F4 NPC rock candidates: bubble statics (scope bubble) of a position, whole scene as the last fallback; "
    + "score = distance + claims x penalty (vendor 7500 m); isMineableStaticEntity / getMineableState", () => {
    const npc = src("services/mining/miningNpcOperations.js");
    has(npc, "(entity) => entity && entity.staticVisibilityScope === \"bubble\",", "S2C-F4 scope");
    has(npc, "const bubbleID = scene.getGridBubbleIDForPosition(position);", "S2C-F4 bubble of position");
    has(npc, "return [...(scene.staticEntities || [])];", "S2C-F4 fallback");
    has(npc, "const MINING_TARGET_CLAIM_PENALTY_METERS = 7_500;", "S2C-F4 penalty");
    has(block(npc, "\nfunction scoreMineableTargetEntry(entry, referencePosition, claimCounts) {", "S2C-F4"),
      "(claimCount * getMineableClaimPenaltyMeters())", "S2C-F4 score");
    const topology = sceneFile("spatialTopology");
    has(topology, "\ngetGridBubbleIDForPosition(position) {", "S2C-F4");
    has(topology, "\ngetStaticEntitiesInBubble(bubbleID) {", "S2C-F4");
    const state = src("services/mining/miningRuntimeState.js");
    has(state, "\nfunction isMineableStaticEntity(entity) {", "S2C-F4");
    has(state, "\nfunction getMineableState(scene, entityID) {", "S2C-F4");
  });

  test("S2C-F5 lock: finalizeTargetLock(source, target, {nowMs}) refuses TARGET_LOCK_LIMIT_REACHED; the NPC lock frees "
    + "other rock locks and retries once; lock range = entity.maxTargetRange", () => {
    const targeting = sceneFile("targeting");
    const finalize = block(targeting, "\nfinalizeTargetLock(sourceEntity, targetEntity, options = {}) {", "S2C-F5");
    has(finalize, "errorMsg: \"TARGET_LOCK_LIMIT_REACHED\",", "S2C-F5 limit");
    has(targeting, "\nremoveLockedTarget(sourceEntity, targetEntityID, options = {}) {", "S2C-F5");
    has(targeting, "\ncancelPendingTargetLock(sourceEntity, targetEntityID, options = {}) {", "S2C-F5");
    has(targeting, "\ngetSortedPendingTargetLocks(entity) {", "S2C-F5");
    has(block(targeting, "\ngetEntityTargetingStats(entity) {", "S2C-F5"),
      "maxTargetRange: Math.max(0, toFiniteNumber(entity.maxTargetRange, 0)),", "S2C-F5 range");
    const sync = block(src("services/mining/miningNpcOperations.js"),
      "\nfunction syncMiningTargetLock(scene, entity, targetEntity, now, hooks = {}) {", "S2C-F5");
    has(sync, "lockResult.errorMsg === \"TARGET_LOCK_LIMIT_REACHED\"", "S2C-F5 retry");
    has(sync, "clearStaleMineableTargetLocks(scene, entity, 0, hooks);", "S2C-F5 free all");
  });

  test("S2C-F7/F8 Fleet Hangar 155 is not a mining hold (getShipHoldCapacityByFlag gives 0); its capacity is "
    + "getFleetHangarCapacity(resourceState); grantItemsToCharacterLocation(charId, locationId, flagId, entries)",
  () => {
    const constants = block(src("services/mining/miningConstants.js"),
      "\nconst MINING_HOLD_DEFINITIONS = Object.freeze([", "S2C-F7");
    assert.ok(!constants.includes("FLEET_HANGAR") && !constants.includes("155"), "S2C-F7: 155 is not a mining hold");
    has(block(src("services/mining/miningInventory.js"),
      "\nfunction getShipHoldCapacityByFlag(resourceState, flagID) {", "S2C-F7"),
    "const definition = getMiningHoldDefinitionByFlag(flagID);", "S2C-F7 mining holds only");
    const hangar = src("services/inventory/fleetHangarInventory.js");
    has(hangar, "\nfunction getFleetHangarCapacity(resourceState) {", "S2C-F7");
    has(hangar, "const FLEET_HANGAR_RESOURCE_KEY = \"fleetHangarCapacity\";", "S2C-F7 key");
    const items = src("services/inventory/itemStore.js");
    has(items, "\n  FLEET_HANGAR: 155,", "S2C-F7 flag");
    has(items,
      "\nfunction grantItemsToCharacterLocation(\n  charId,\n  locationId,\n  flagId,\n  grantEntries = [],\n) {",
      "S2C-F8");
    has(src("services/mining/miningInventory.js"), "\nfunction isItemTypeAllowedInHoldFlag(itemOrTypeID, flagID) {",
      "S2C-F7");
  });

  test("S2C-F9 the vendor cycle stops on a burned-out crystal with stopReason ammo", () => {
    has(cycleBody(mining()), "if (isCrystalBurnedOut(chargeItem, buildCrystalDurabilitySnapshot(snapshot.chargeTypeID, "
      + "snapshot.chargeAttributes))) {", "S2C-F9 check");
    has(cycleBody(mining()), "return { success: false, stopReason: \"ammo\" };", "S2C-F9 ammo");
    const crystal = src("services/dogma/crystalDurability.js");
    has(crystal, "\nfunction isCrystalBurnedOut(item, snapshot) {", "S2C-F9");
    has(crystal, "\nfunction buildCrystalDurabilitySnapshot(typeID, attributes = {}, chanceMultiplier = 1) {",
      "S2C-F9");
  });

  test("S2C: no character outside ASCII in the mod code (lib/, loader.js, config.js)", () => {
    const modDir = path.resolve(__dirname, "..", "..");
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && /[^\x00-\x7F]/.test(fs.readFileSync(full, "utf8"))) {
          hits.push(path.relative(modDir, full));
        }
      }
    };
    walk(path.join(modDir, "lib"));
    for (const file of ["loader.js", "config.js"]) {
      if (/[^\x00-\x7F]/.test(fs.readFileSync(path.join(modDir, file), "utf8"))) hits.push(file);
    }
    assert.deepStrictEqual(hits, []);
  });

  const turretCycle = () => block(src("space/runtime/weaponCycle.js"),
    "function executeTurretCycle(scene, attackerEntity, effectState, cycleBoundaryMs) {", "S3-F1");

  test("S3-F1 executeTurretCycle starts with getEntityRuntimeModuleItem (a twin's module is not found there)", () => {
    has(turretCycle(), "cycleBoundaryMs) {\n  const moduleItem = getEntityRuntimeModuleItem(\n", "S3-F1");
  });

  test("S3-F4 executeTurretCycle order: burned-out crystal -> NO_AMMO, shot, hit && hasDamageableHealth -> "
    + "applyWeaponDamageToTarget -> noteKillmailDamage (applied > 0) -> killmail (destroyResult.success) -> "
    + "messages", () => {
    const body = turretCycle();
    const order = [
      "if (resolvedWeaponSnapshot.chargeMode === \"crystal\") {",
      "if (isCrystalBurnedOut(crystal, buildCrystalDurabilitySnapshot(crystal?.typeID, "
        + "getTypeDogmaAttributes(crystal?.typeID)))) {",
      "return { success: false, errorMsg: \"NO_AMMO\", stopReason: \"ammo\" };",
      ": resolveTurretShot({\n      attackerEntity,\n      targetEntity,\n"
        + "      weaponSnapshot: presentedWeaponSnapshot,\n    });",
      "if (shotResult.hit && hasDamageableHealth(targetEntity)) {",
      "const weaponDamageResult = applyWeaponDamageToTarget(\n      scene,\n      attackerEntity,\n      targetEntity,\n"
        + "      shotResult.shotDamage,\n      cycleBoundaryMs,\n",
      "const appliedDamageAmount = getAppliedDamageAmount(damageResult);\n    if (appliedDamageAmount > 0) {\n"
        + "      noteKillmailDamage(attackerEntity, targetEntity, appliedDamageAmount, {\n"
        + "        whenMs: cycleBoundaryMs,\n",
      "if (destroyResult && destroyResult.success) {\n      recordKillmailFromDestruction(targetEntity, destroyResult, {\n"
        + "        attackerEntity,\n        victimSession: weaponDamageResult.victimSession,\n"
        + "        whenMs: cycleBoundaryMs,\n",
      "notifyWeaponDamageMessages(",
    ];
    let at = -1;
    for (const needle of order) {
      const next = body.indexOf(needle, at + 1);
      assert.ok(next > at, `S3-F4 order: ${JSON.stringify(needle)} after position ${at}`);
      at = next;
    }
    has(body, "{fabricatorDamageKind:resolvedWeaponSnapshot.family === \"vortonProjector\" ? \"vorton\" : null,\n"
      + "        incursionWeaponKind: resolvedWeaponSnapshot.family === \"vortonProjector\" ? null : \"turret\"},",
      "S3-F4");
    has(src("space/runtime/weaponCycle.js"),
      "const { resolveTurretShot, resolveTurretVolley } = require(\"../combat/laserTurrets\");", "S3-F4");
    const msgs = src("space/runtime/combatDamageMessages.js");
    has(msgs, "\nfunction getAppliedDamageAmount(damageResult) {", "S3-F4");
    has(msgs, "toFiniteNumber(layerEntry && layerEntry.appliedEffective, 0)", "S3-F4");
    const tda = src("space/runtime/targetDamageApplication.js");
    has(tda, "  return {\n    damageResult,\n    destroyResult,\n    breacherDeathRecord,\n  };\n}", "S3-F4");
    has(src("space/combat/damage.js"), "\nfunction hasDamageableHealth(entity) {", "S3-F16");
    has(src("services/fitting/liveFittingState.js"), "\nfunction getTypeDogmaAttributes(typeID) {", "S3-F16");
  });

  test("S3-F4a weaponCycle binds enqueueKillmailFromDestruction as its local recordKillmailFromDestruction; enqueue = "
    + "the LOCAL record with deferPostCommit:true; both exported", () => {
    const wc = src("space/runtime/weaponCycle.js");
    has(wc, "  noteDamage: noteKillmailDamage,\n", "S3-F4a");
    has(wc, "  enqueueKillmailFromDestruction: recordKillmailFromDestruction,\n", "S3-F4a");
    const km = src("space/combat/killmailTracker.js");
    has(km, "function enqueueKillmailFromDestruction(targetEntity, destroyResult, options = {}) {\n"
      + "  return recordKillmailFromDestruction(targetEntity, destroyResult, {\n    ...options,\n"
      + "    deferPostCommit: true,\n  });\n}", "S3-F4a");
    const exportsBlock = block(km, "module.exports = {", "S3-F4a");
    for (const name of ["enqueueKillmailFromDestruction", "noteDamage", "recordKillmailFromDestruction"]) {
      has(exportsBlock, `\n  ${name},`, "S3-F4a");
    }
  });

  test("S3-F6/F7 destruction owner and NPC wreck owner = getShipEntityInventoryCharacterID(attacker) = "
    + "pilotCharacterID ?? characterID (the twin's owner)", () => {
    const cd = src("space/runtime/combatDestruction.js");
    has(cd, "function buildCombatDestructionOwnerContext(attackerEntity = null) {\n"
      + "  const ownerCharacterID = getShipEntityInventoryCharacterID(attackerEntity, 0);", "S3-F6");
    const wreck = block(cd, "function resolveNpcWreckOwnerContext(entity, options = {}) {", "S3-F7");
    has(wreck, "highestDamageAttacker && highestDamageAttacker.characterID ||", "S3-F7");
    has(wreck, "getShipEntityInventoryCharacterID(lethalAttacker, 0),", "S3-F7");
    has(src("space/runtime/entityDogmaView.js"), "entity.pilotCharacterID ??\n      entity.characterID", "S3-F6");
  });

  test("S3-F8 NPC bounty: combatDestruction -> bountyRuntime.recordNpcBountyKill(target, attacker); the attacker's "
    + "character candidates hold pilotCharacterID; dedupe per victim (_bountyEventID, alreadyRecorded)", () => {
    const cd = src("space/runtime/combatDestruction.js");
    const fn = block(cd, "function recordNpcBountyForCombatDestruction(\n  scene,\n  targetEntity,\n  attackerEntity,\n"
      + "  destroyResult,\n  { gridBubbleID = null } = {},\n) {", "S3-F8");
    has(fn, "return bountyRuntime.recordNpcBountyKill(targetEntity, attackerEntity || {}, {", "S3-F8");
    has(fn, "entity: attackerEntity || null,", "S3-F8");
    has(cd, "\n      recordNpcBountyForCombatDestruction(\n        scene,\n        entity,\n"
      + "        options.attackerEntity || null,", "S3-F8 call");
    const br = src("services/bounty/bountyRuntime.js");
    const cand = block(br, "function resolveAttackerCharacterID(finalAttacker = {}, context = {}) {", "S3-F8");
    has(cand, "attacker.characterID,", "S3-F8");
    has(cand, "attacker.pilotCharacterID,", "S3-F8");
    has(br, "const eventID = context.bountyEventID || victimEntity._bountyEventID || ", "S3-F8");
    has(br, "if (eventID && recordedEvents[eventID]) return { ...resolution, characterID, alreadyRecorded: true };",
      "S3-F8");
    has(br, "if (eventID) victimEntity._bountyEventID = eventID;", "S3-F8");
  });

  test("S3-F9 killmail attacker = pilotCharacterID ?? characterID; bounty and NPC faction standing from the final "
    + "attacker", () => {
    const km = src("space/combat/killmailTracker.js");
    has(km, "attackerEntity.pilotCharacterID ?? attackerEntity.characterID,", "S3-F9");
    has(km, "const bountyClaimed = resolveBountyPayout(targetEntity, finalAttacker, {", "S3-F9");
    has(km, "factionKillStanding.recordNpcFactionStandingLoss(", "S3-F9");
  });

  test("S3-F11 npcKillsGiveSp credits a ship to session/characterID/pilotCharacterID (nativeNpc = nobody) and wraps "
    + "both killmail exports; LNE wraps both too (one call of enqueue = one pass of each wrapper)", () => {
    const modsDir = path.resolve(SERVER_DIR, "..", "mods");
    const readMod = (rel) => fs.readFileSync(path.join(modsDir, rel), "utf8").replace(/\r\n/g, "\n");
    const identity = readMod("npcKillsGiveSp/lib/contribution/identity.js");
    has(identity, "return entity.nativeNpc === true || entity.nativeNpcOccupied === true", "S3-F11");
    has(identity, "return first(session.characterID, entity.characterID, entity.pilotCharacterID);", "S3-F11");
    has(readMod("npcKillsGiveSp/lib/observers/killmailKillObserver.js"),
      "const METHODS = Object.freeze([\"enqueueKillmailFromDestruction\", \"recordKillmailFromDestruction\"]);",
      "S3-F11");
    has(readMod("livingNewEden/lib/adapter/liveLossHook.js"),
      "const METHODS = Object.freeze([\"recordKillmailFromDestruction\", \"enqueueKillmailFromDestruction\"]);",
      "S3-F11");
  });

  test("S3-F12/F14 weapon family helpers, Precursor family and the scene FX/targeter methods the combat access "
    + "calls; a turret FX GUID comes from the snapshot (effectGUID)", () => {
    const wd = src("space/combat/weaponDogma.js");
    has(wd, "\nfunction isVortonWeaponFamily(family) {\n  return family === \"vortonProjector\";\n}", "S3-F12");
    has(wd, "\nfunction isTurretCycleWeaponFamily(family) {\n"
      + "  return isTurretWeaponFamily(family) || isVortonWeaponFamily(family);\n}", "S3-F12");
    has(wd, "\nfunction isChargeOptionalTurretWeapon(moduleItem, chargeItem = null) {", "S3-F12");
    has(wd, "    effectGUID: resolveWeaponSpecialFxGUID({\n", "S3-F14");
    has(src("space/combat/precursorTurrets.js"), "\nfunction isPrecursorTurretFamily(family) {", "S3-F12");
    has(src("space/runtime/scene/presentation.js"),
      "\nbroadcastSpecialFx(shipID, guid, options = {}, visibilityEntity = null) {", "S3-F14");
    const targeters = block(src("space/runtime/scene/targeting.js"), "\ngetTargetersForEntity(entity, options = {}) {",
      "S3-F14");
    has(targeters, ".filter((sourceID) => sourceID > 0 && (options.forClient !== true ||", "S3-F14");
    has(src("space/runtime/weaponSnapshot.js"),
      "\nfunction buildWeaponSnapshotForEntity(entity, moduleItem, chargeItem = null, options = {}) {\n"
      + "  const shipItem = options.shipItem || getEntityRuntimeShipItem(entity);", "S3-F3");
  });

  test("S3D-F2/F3/F4/AW-F13/AW-F16: launchMissile(attackerEntity, targetID, weaponSnapshot, options) with "
    + "skipRangeCheck and its refusal codes; missile.sourceShipID = attacker.itemID, the impact reads the attacker "
    + "back by that ID and notes damage/killmail with it; festival = no damage; the killmail weapon type takes "
    + "snapshot.chargeTypeID before moduleItem; the missile families and the defender predicate", () => {
    const de = src("space/runtime/scene/dynamicEntities.js");
    const launch = block(de, "\nlaunchMissile(attackerEntity, targetID, weaponSnapshot, options = {}) {", "S3D-F2");
    has(launch, "options.skipRangeCheck !== true &&", "AW-F16");
    for (const code of ["TARGET_NOT_FOUND", "TARGET_OUT_OF_RANGE", "MISSILE_SPAWN_FAILED"]) {
      has(launch, `errorMsg: "${code}"`, "launchFailed codes");
    }
    has(launch, "isValidWeaponSnapshotTarget(attackerEntity, targetEntity, weaponSnapshot)", "AW-F16");
    const wc = src("space/runtime/weaponCycle.js");
    has(wc, "  const launchResult = breacherLaunch || scene.launchMissile(\n    attackerEntity,\n"
      + "    targetEntity.itemID,\n    resolvedWeaponSnapshot,\n", "S3D-F2");
    has(wc, "      skipRangeCheck: true,\n", "S3D-F2");
    has(wc, "  if (!launchResult.success || !launchResult.data) {", "S3D-F2");
    const me = src("space/runtime/missileEntity.js");
    has(me, "    sourceShipID: toInt(attackerEntity.itemID, 0),\n", "S3D-F3");
    const hit = me.slice(me.indexOf("  const attackerEntity = scene.getEntityByID(missileEntity.sourceShipID);"));
    assert.ok(hit.length < me.length, "S3D-F4: the impact reads the attacker by sourceShipID");
    const note = hit.indexOf("    noteKillmailDamage(attackerEntity, targetEntity, appliedDamageAmount, {");
    const km = hit.indexOf("    recordKillmailFromDestruction(targetEntity, weaponDamageResult.destroyResult, {\n"
      + "      attackerEntity,\n");
    const festival = hit.indexOf("missileEntity.missileSnapshot.family === \"festivalLauncher\"");
    assert.ok(festival > 0 && note > festival && km > note, `S3D-F4 order: ${festival} ${note} ${km}`);
    has(me, "  enqueueKillmailFromDestruction: recordKillmailFromDestruction,", "S3D-F4 alias");
    const kt = block(src("space/combat/killmailTracker.js"), "\nfunction resolveWeaponTypeID(options = {}) {", "AW-F13");
    const fromSnapshot = kt.indexOf("weaponSnapshot && weaponSnapshot.chargeTypeID");
    assert.ok(fromSnapshot > 0 && fromSnapshot < kt.indexOf("moduleItem && moduleItem.typeID"), "AW-F13 order");
    const wd = src("space/combat/weaponDogma.js");
    has(wd, "\nfunction isMissileWeaponFamily(family) {\n  return family === \"missileLauncher\" || "
      + "family === \"festivalLauncher\" || isBreacherPodWeaponFamily(family);\n}", "AW-F4 (breacher excluded by the mod)");
    const defender = block(wd, "\nfunction isDefenderMissileWeaponSnapshot(snapshot) {", "AW-F5");
    has(defender, "snapshot.chargeGroupID", "AW-F5");
    has(defender, "snapshot.moduleGroupID", "AW-F5");
    has(wd, "    chargeTypeID: toInt(chargeItem.typeID, 0),\n", "AW-F13");
    has(wd, "    approxRange: round6(maxVelocity * (flightTimeMs / 1000)),\n", "AW-F4");
    has(wd, "  const usesMissileSnapshot = isMissileWeaponFamily(family) || family === \"bombLauncher\";\n",
      "AW-F4: no charge = no missile snapshot");
    has(wd, "  if ((!usesMissileSnapshot && !usesTurretSnapshot) || (usesMissileSnapshot && !chargeItem)) {\n"
      + "    return null;\n", "AW-F4: no charge = no missile snapshot");
  });

  test("AW-F2 precursorTurrets exports the 5 spool functions; executeTurretCycle syncs before the optimal "
    + "check (out of optimal = no shot), presents the spooled snapshot to the shot and advances after the shot "
    + "block; isTurretWeaponFamily includes precursorTurret", () => {
    const pt = src("space/combat/precursorTurrets.js");
    const exportsBlock = pt.slice(pt.lastIndexOf("module.exports = {"));
    for (const name of ["synchronizePrecursorTurretEffectState", "advancePrecursorTurretSpool",
      "resetPrecursorTurretSpool", "applyPrecursorTurretSpoolToSnapshot", "buildPrecursorTurretGraphicInfo"]) {
      has(pt, `\nfunction ${name}(`, "AW-F2");
      has(exportsBlock, `  ${name},\n`, "AW-F2 export");
    }
    has(pt, "  if (previousTargetID > 0 && nextTargetID > 0 && previousTargetID !== nextTargetID) {\n"
      + "    effectState.precursorSpoolCurrent = 0;\n", "AW-F2: another target = spool 0");
    const wc = src("space/runtime/weaponCycle.js");
    const sync = wc.indexOf("    synchronizePrecursorTurretEffectState(\n      effectState,\n"
      + "      resolvedWeaponSnapshot,\n      cycleBoundaryMs,\n    );");
    const range = wc.indexOf("    if (surfaceDistance > toFiniteNumber(resolvedWeaponSnapshot.optimalRange, 0) + 1e-6) {");
    const presented = wc.indexOf("    ? applyPrecursorTurretSpoolToSnapshot(resolvedWeaponSnapshot, effectState)");
    const shot = wc.indexOf("    : resolveTurretShot({", presented);
    const advance = wc.indexOf("    advancePrecursorTurretSpool(effectState, resolvedWeaponSnapshot, cycleBoundaryMs);");
    assert.ok(sync > 0 && range > sync && presented > range && shot > presented && advance > shot,
      `AW-F2 order: ${sync} ${range} ${presented} ${shot} ${advance}`);
    has(src("space/combat/weaponDogma.js"), "\nfunction isTurretWeaponFamily(family) {\n  return (\n"
      + "    family === \"laserTurret\" ||\n    family === \"hybridTurret\" ||\n    family === \"projectileTurret\" ||\n"
      + "    family === \"precursorTurret\"\n  );\n}", "AW-F2");
  });

  test("AW-F3 selectVortonArcTargets takes candidateEntities from the caller; the arc branch of "
    + "executeTurretCycle: FX before the primary damage, then per arc applyWeaponDamageToTarget -> noteKillmailDamage "
    + "-> recordKillmailFromDestruction; broadcastVortonCycleSpecialFx exported, arc IDs from vortonArcTargetIDs; "
    + "applyWeaponDamageToTarget notes the NPC aggression outside the orbital branch (H-AW-2)", () => {
    const vp = src("space/combat/vortonProjectors.js");
    has(vp, "function selectVortonArcTargets({\n  attackerEntity,\n  primaryTargetEntity,\n  candidateEntities = [],\n"
      + "  weaponSnapshot,\n  random = Math.random,\n} = {}) {", "AW-F3");
    has(vp, "  return Math.max(0, arcTargets - 1);", "AW-F3: arc budget");
    has(block(vp, "\nfunction getVortonRangeState(attackerEntity, targetEntity, weaponSnapshot) {", "AW-F3"),
      "    outOfRange: surfaceDistance > optimalRange + 1e-6,", "AW-F3: out of optimal = miss");
    const exportsBlock = vp.slice(vp.lastIndexOf("module.exports = {"));
    for (const name of ["resolveVortonShot", "resolveVortonArcShot", "selectVortonArcTargets"]) {
      has(exportsBlock, `  ${name},\n`, "AW-F3 export");
    }
    const wc = src("space/runtime/weaponCycle.js");
    const fx = wc.indexOf("      broadcastVortonCycleSpecialFx(scene, attackerEntity, effectState);");
    const primary = wc.indexOf("      {fabricatorDamageKind:resolvedWeaponSnapshot.family === \"vortonProjector\" ? "
      + "\"vorton\" : null,\n        incursionWeaponKind: resolvedWeaponSnapshot.family === \"vortonProjector\" ? null : "
      + "\"turret\"},");
    has(wc, "        {fabricatorDamageKind:\"vorton\"},", "AW-F3: arc options unchanged (no incursionWeaponKind)");
    const arcLoop = wc.indexOf("    for (const link of vortonArcChain) {");
    const arcApply = wc.indexOf("      const arcDamage = applyWeaponDamageToTarget(", arcLoop);
    const arcNote = wc.indexOf("        noteKillmailDamage(attackerEntity, link.entity, arcAppliedAmount, {", arcApply);
    const arcKm = wc.indexOf("        recordKillmailFromDestruction(link.entity, arcDamage.destroyResult, {", arcNote);
    assert.ok(fx > 0 && primary > fx && arcLoop > primary && arcApply > arcLoop && arcNote > arcApply
      && arcKm > arcNote, `AW-F3 order: ${fx} ${primary} ${arcLoop} ${arcApply} ${arcNote} ${arcKm}`);
    const msf = src("space/runtime/moduleSpecialFx.js");
    has(msf.slice(0, msf.indexOf("};")), "  broadcastVortonCycleSpecialFx,\n", "AW-F3 export");
    has(msf, "\nfunction broadcastVortonCycleSpecialFx(scene, entity, effectState, specialFxOptions = {}) {", "AW-F3");
    has(msf, "      targets: Array.isArray(effectState.vortonArcTargetIDs)", "AW-F3: arc IDs");
    const tda = src("space/runtime/targetDamageApplication.js");
    const orbitalEnd = tda.indexOf("          `[SpaceRuntime] Orbital damage persistence failed for");
    const aggression = tda.indexOf("        npcService.noteNpcIncomingAggression(\n          targetEntity,", orbitalEnd);
    assert.ok(orbitalEnd > 0 && aggression > orbitalEnd, "H-AW-2: the aggression note follows the orbital branch");
    has(tda.slice(orbitalEnd, aggression), "      }\n    }\n    try {\n", "H-AW-2: outside the orbital branch");
  });

  test("S3B-F1 consumeInventoryItemQuantityIdempotent -> executeIdempotentInventoryMutation: key = options.receiptKey, "
    + "fingerprint object required (else INVALID_IDEMPOTENCY_KEY), a repeat = duplicate with no changes, another "
    + "fingerprint = IDEMPOTENCY_RECEIPT_MISMATCH; exported", () => {
    const is = src("services/inventory/itemStore.js");
    has(is, "\nfunction consumeInventoryItemQuantityIdempotent(\n  itemId,\n  quantity = 1,\n  options = {},\n) {\n"
      + "  return executeIdempotentInventoryMutation(\n    options,\n"
      + "    \"consume-inventory-item-quantity\",", "S3B-F1");
    const exec = block(is, "function executeIdempotentInventoryMutation(options, operation, executor) {", "S3B-F1");
    has(exec, "normalizeIdempotentGrantReceiptKey(\n    options && options.receiptKey,\n  );", "S3B-F1");
    has(exec, "const fingerprint = options && options.fingerprint &&\n    typeof options.fingerprint === \"object\"",
      "S3B-F1");
    has(exec, "errorMsg: \"INVALID_IDEMPOTENCY_KEY\",", "S3B-F1");
    has(exec, "errorMsg: \"IDEMPOTENCY_RECEIPT_MISMATCH\",", "S3B-F1");
    has(exec, "duplicate: true,", "S3B-F1");
    has(exec, "changes: [],", "S3B-F1");
    has(block(is, "module.exports = {", "S3B-F1"), "\n  consumeInventoryItemQuantityIdempotent,", "S3B-F1");
    has(is, "receiptKey && receiptKey.length <= 512 && !receiptKey.includes(\"/\")", "S3B-F1");
  });

  test("S3B-F4 pruneIdempotentGrantReceipts(predicate): no function -> INVALID_RECEIPT_PRUNE_PREDICATE; the predicate "
    + "gets a copy of every receipt (a throw = keep); result {success, removed, removedReceiptKeys}; a failed commit "
    + "-> IDEMPOTENT_GRANT_RECEIPT_PRUNE_FAILED; a receipt carries receiptKey, operation, completedAtMs; exported", () => {
    const is = src("services/inventory/itemStore.js");
    const prune = block(is, "function pruneIdempotentGrantReceipts(predicate) {", "S3B-F4");
    has(prune, "if (typeof predicate !== \"function\") {", "S3B-F4");
    has(prune, "errorMsg: \"INVALID_RECEIPT_PRUNE_PREDICATE\",", "S3B-F4");
    has(prune, "for (const [storageKey, receipt] of Object.entries(ledger)) {", "S3B-F4");
    has(prune, "dead = predicate(cloneValue(receipt)) === true;", "S3B-F4");
    has(prune, "} catch (error) {", "S3B-F4");
    has(prune, "return { success: true, removed: 0, removedReceiptKeys: [] };", "S3B-F4");
    has(prune, "return deleteIdempotentGrantReceipts(doomedStorageKeys, removedReceiptKeys);", "S3B-F4");
    const del = block(is, "function deleteIdempotentGrantReceipts(doomedStorageKeys, removedReceiptKeys) {", "S3B-F4");
    has(del, "return { success: true, removed: 0, removedReceiptKeys: [] };", "S3B-F4");
    has(del, "errorMsg: \"IDEMPOTENT_GRANT_RECEIPT_PRUNE_FAILED\",", "S3B-F4");
    has(del, "removed: doomedStorageKeys.length,\n    removedReceiptKeys,", "S3B-F4");
    const exec = block(is, "function executeIdempotentInventoryMutation(options, operation, executor) {", "S3B-F4");
    has(exec, "  const receipt = {\n    schemaVersion: 3,\n    receiptKey,\n    state: \"completed\",\n    operation,\n"
      + "    fingerprint,\n    completedAtMs: normalizeTimestampMs(", "S3B-F4");
    has(exec, ") || Date.now(),", "S3B-F4");
    has(block(is, "module.exports = {", "S3B-F4"), "\n  pruneIdempotentGrantReceipts,", "S3B-F4");
  });

  test("S3B-F3 the vendor uses up a turret charge once per cycle: chargeMode \"crystal\" -> volatility damage, else "
    + "consumeTurretAmmoCharge; resolveWeaponChargeMode = crystal only for laserTurret; the turret snapshot carries "
    + "chargeMode, optimalRange and falloff", () => {
    const wc = src("space/runtime/weaponCycle.js");
    has(wc, "const chargeResult = resolvedWeaponSnapshot.chargeMode === \"crystal\"\n"
      + "      ? applyCrystalVolatilityDamage(", "S3B-F3");
    has(wc, "      : consumeTurretAmmoCharge(\n", "S3B-F3");
    const wd = src("space/combat/weaponDogma.js");
    has(wd, "\nfunction resolveWeaponChargeMode(family) {\n"
      + "  return family === \"laserTurret\" ? \"crystal\" : \"stack\";\n}", "S3B-F3");
    const from = wd.indexOf("\nfunction buildWeaponModuleSnapshot({");
    const to = wd.indexOf("\nfunction ", from + 1);
    assert.ok(from >= 0 && to > from, "S3B-F3: buildWeaponModuleSnapshot");
    const snap = wd.slice(from, to);
    for (const needle of ["    chargeMode,\n", "    optimalRange: Math.max(", "    falloff: Math.max("]) {
      has(snap, needle, "S3B-F3");
    }
  });

  test("S3-F13/S3C-F1/S3C-F2 (mirror): FighterMgrService.Handle_CmdActivateAbilitySlots -> "
    + "activateAbilitySlots(session, args[0], args[1], args[2]); Handle_RecallFightersToTubes -> "
    + "recallFightersToTubes(session, args[0]); EntityService.Handle_CmdEngage -> commandEngage(session, args[0], "
    + "args[1]) (target = args[1]); both class exports", () => {
    const fighter = src("services/fighter/fighterMgrService.js");
    has(fighter, "\nclass FighterMgrService extends BaseService {", "S3-F13");
    has(fighter, "\nmodule.exports = FighterMgrService;", "S3-F13");
    const slots = block(fighter, "\n  Handle_CmdActivateAbilitySlots(args, session, kwargs) {", "S3-F13");
    has(slots, "    const result = activateAbilitySlots(\n      session,\n"
      + "      Array.isArray(args) && args.length > 0 ? args[0] || [] : [],\n"
      + "      Array.isArray(args) && args.length > 1 ? args[1] : null,\n"
      + "      Array.isArray(args) && args.length > 2 ? args[2] : null,\n    );", "S3-F13");
    const recall = block(fighter, "\n  Handle_RecallFightersToTubes(args, session, kwargs) {", "S3C-F1");
    has(recall, "      Array.isArray(args) && args.length > 0 ? args[0] || [] : [];", "S3C-F1");
    has(recall, "recallFightersToTubes(session, requestedFighterIDs);", "S3C-F1");
    const entity = src("services/drone/entityService.js");
    has(entity, "\nclass EntityService extends BaseService {", "S3C-F2");
    has(entity, "\nmodule.exports = EntityService;", "S3C-F2");
    has(entity, "\n  Handle_CmdEngage(args, session) {\n"
      + "    return commandEngage(session, args && args[0], args && args[1]);\n  }", "S3C-F2");
  });

  test("S2-F15 (mirror): EntityService.Handle_CmdMineRepeatedly -> commandMineRepeatedly(session, args[0] "
    + "args[1]) (target = args[1]); Handle_CmdReturnBay -> commandReturnBay(session, args[0]); Handle_CmdReturnHome "
    + "-> commandReturnHome(session, args[0])", () => {
    const entity = src("services/drone/entityService.js");
    has(entity, "\n  Handle_CmdMineRepeatedly(args, session) {\n"
      + "    return commandMineRepeatedly(session, args && args[0], args && args[1]);\n  }", "S2-F15");
    has(entity, "\n  Handle_CmdReturnBay(args, session) {\n"
      + "    return commandReturnBay(session, args && args[0]);\n  }", "S2-F15");
    has(entity, "\n  Handle_CmdReturnHome(args, session) {\n"
      + "    return commandReturnHome(session, args && args[0]);\n  }", "S2-F15");
  });

  test("(vendor.js controlledDroneIds): a drone is kind \"drone\" in scene.dynamicEntities, the "
    + "ship's drones are those with controllerID = the ship ID", () => {
    const dr = src("services/drone/droneRuntime.js");
    has(dr, "return Boolean(entity && entity.kind === \"drone\");", "controlledDroneIds");
    has(dr, "for (const entity of scene.dynamicEntities.values()) {", "controlledDroneIds");
    has(dr, ".filter((entity) => toInt(entity.controllerID, 0) === numericShipID);", "controlledDroneIds");
  });

  test("DR-F1 (copy drones): the two `_testing` functions of the access; the drone dogma reads the "
    + "controller's ship item (proxy itemID = the ship in the SMB); the vendor tick has no branch for the marker and "
    + "the idle orbit and the combat index skip a drone with a droneCommand; the recall gives droneIDs; DRONE_LAUNCH = "
    + "shipBay(DRONE_BAY) -> inSpace; a spawned drone takes controllerID from launcherID; droneInterop carries the "
    + "functions of the cycle port", () => {
    const { TESTING_FUNCTIONS, WING_DRONE_COMMAND } = require("../../lib/adapter/droneAccess");
    const dr = src("services/drone/droneRuntime.js");
    const testing = dr.slice(dr.indexOf("\n  _testing: {"), dr.indexOf("\n  },", dr.indexOf("\n  _testing: {")));
    for (const name of TESTING_FUNCTIONS) has(testing, `\n    ${name},`, "DR-F1 _testing");
    has(src("services/drone/droneDogma.js"), "findShipItemById(controllerShipID)", "DR-F1 dogma");
    const tick = block(dr, "\nfunction tickScene(scene, now) {", "DR-F1 tick");
    has(tick, "if (droneEntity.droneCommand === DRONE_COMMAND_ENGAGE", "DR-F1 tick");
    assert.ok(!tick.includes(JSON.stringify(WING_DRONE_COMMAND)), "DR-F1: no vendor branch for the marker");
    has(block(dr, "\nfunction returnIdleDroneToControllerOrbit(scene, droneEntity, controllerEntity) {", "DR-F1"),
      "droneEntity.droneCommand ||", "DR-F1 idle orbit");
    has(block(dr, "\nfunction getSceneControlledCombatDroneIndex(scene) {", "DR-F1"), "if (!droneEntity.droneCommand)",
      "DR-F1 combat index");
    const recallAt = dr.indexOf("\nfunction recallDronesToShipBay(");
    has(dr.slice(recallAt, dr.indexOf("\nfunction ", recallAt + 1)), "droneIDs: recalled.map(", "DR-F1 recall");
    has(dr, "entity.controllerID = toInt(entity.controllerID, entity.launcherID || 0) || null;", "DR-F1 hydrate");
    const custody = src("services/inventory/itemCustody.js");
    const route = custody.slice(custody.indexOf("if (reason === CUSTODY_REASON.DRONE_LAUNCH) {"));
    has(route.slice(0, 400), "source.flagID === droneBayFlag &&", "DR-F1 custody");
    has(route.slice(0, 400), "destination && destination.kind === CUSTODY_REF_KIND.IN_SPACE", "DR-F1 custody");
    const interop = src("space/runtime.js");
    const at = interop.indexOf("\nruntimeExports.droneInterop = {");
    assert.ok(at > 0, "DR-F1 droneInterop");
    const body = interop.slice(at, interop.indexOf("\n};", at));
    for (const name of ["\n  resolveTurretShot,\n", "applyWeaponDamageToTarget,", "getAppliedDamageAmount,",
      "noteKillmailDamage,", "recordKillmailFromDestruction,"]) has(body, name, "DR-F1 droneInterop");
  });

  test("DR-F2 (copy drones): resolveDroneRepairSnapshot is exported and gives repairFamily "
    + "tickDroneRepair runs executeAssistanceModuleCycle with the droneInterop callbacks; the cycle uses its session "
    + "only for the ancillary charge (the HP notice goes to target.session), so a twin's drone passes null", () => {
    const dogma = src("services/drone/droneDogma.js");
    const exportsAt = dogma.indexOf("\nmodule.exports = {");
    has(dogma.slice(exportsAt), "\n  resolveDroneRepairSnapshot,", "DR-F2 export");
    has(block(dogma, "\nfunction resolveDroneRepairSnapshot(droneEntity, controllerEntity) {", "DR-F2"),
      "repairFamily: definition.family,", "DR-F2 snapshot");
    const tick = block(src("services/drone/droneRuntime.js"),
      "\nfunction tickDroneRepair(scene, droneEntity, controllerEntity, now) {", "DR-F2");
    has(tick, "assistanceModuleRuntime.executeAssistanceModuleCycle({", "DR-F2 tick");
    for (const name of ["isEntityLockedTarget: () => true,", "normalizeShipConditionState: droneInterop.",
      "buildShipHealthTransitionResult: droneInterop.", "notifyShipHealthAttributesToSession: droneInterop.",
      "broadcastDamageStateChange: droneInterop.", "persistDynamicEntity: droneInterop."]) has(tick, name, "DR-F2 tick");
    const amr = src("space/modules/assistanceModuleRuntime.js");
    const execAt = amr.indexOf("\nfunction executeAssistanceModuleCycle({");
    assert.ok(execAt > 0, "DR-F2 executeAssistanceModuleCycle");
    const exec = amr.slice(execAt, amr.indexOf("\nfunction ", execAt + 1));
    assert.deepStrictEqual(exec.match(/[^.\w]session\b/g).length, 3, "DR-F2: session = the parameter + NPC shield + the charge");
    has(exec, "consumeAncillaryChargeForCycle({ entity, session, effectState, nowMs, callbacks });", "DR-F2 charge");
    has(exec, "if (effectState.nativeNpcShieldVersion === nativeNpcAbilities.SHIELD_VERSION &&\n"
      + "      !effectState.nativeNpcShieldChildCycle) return executeNativeNpcShieldCycle({\n"
      + "    scene, session, entity, effectState, nowMs, isActivationPass, callbacks });", "DR-F2 NPC shield branch");
    has(amr, "...(nativeShield ? { nativeNpcShieldVersion: nativeNpcAbilities.SHIELD_VERSION,", "DR-F2 NPC shield stamp");
    has(amr, "const nativeShield = definition.nativeNpcShield ? nativeNpcAbilities.shieldInputs(entity, moduleAttributes) : null;",
      "DR-F2 NPC shield only from its definition");
    const runtime = src("space/runtime.js");
    const at = runtime.indexOf("\nruntimeExports.droneInterop = {");
    const body = runtime.slice(at, runtime.indexOf("\n};", at));
    for (const name of ["normalizeShipConditionState,", "buildShipHealthTransitionResult,",
      "notifyShipHealthAttributesToSession,", "broadcastDamageStateChange,", "persistDynamicEntity,"]) {
      has(body, name, "DR-F2 droneInterop");
    }
  });

  test("DR-F4 (copy drones): resolveDroneMiningSnapshot is exported; classifyDroneMiningYieldKind "
    + "is the name rule the mod ports (ice harvesting / excavator / mining); idleMiningDronesTargeting skips a drone "
    + "without droneMining and without the mine command (a twin's drone has neither); tickDroneMining mines with "
    + "crit 0", () => {
    const dogma = src("services/drone/droneDogma.js");
    has(dogma.slice(dogma.indexOf("\nmodule.exports = {")), "\n  resolveDroneMiningSnapshot,", "DR-F4 export");
    const dr = src("services/drone/droneRuntime.js");
    const classify = block(dr, "\nfunction classifyDroneMiningYieldKind(droneEntity) {", "DR-F4");
    for (const name of ["\"ice harvesting\"", "\"excavator\"", "\"mining\""]) has(classify, name, "DR-F4 classify");
    has(block(dr, "\nfunction idleMiningDronesTargeting(scene, rawTargetID, options = {}) {", "DR-F4"),
      "droneEntity.droneCommand !== DRONE_COMMAND_MINE && !miningState", "DR-F4 idle");
    has(block(dr, "\nfunction tickDroneMining(scene, droneEntity, controllerEntity, now) {", "DR-F4"),
      "critProbability: 0", "DR-F4 tick");
  });

  test("S3E-F2/F3/F9/F10/F11/F12/F13/F14/F15a/F16/F17: activateGenericModule reads the owner's hull, the "
    + "tick uses capacitor; local cycle callbacks and their skills, NO_AMMO, start timing; the hardener loop (WH "
    + "before modules); spec.passiveResourceState wins; damage reads passiveDerivedState; cap curve; propulsion "
    + "constants at the end; effect and assistance lookups; a twin is never persisted", () => {
    has(src("space/runtime/scene/modules.js"), "    const shipRecord = getEntityRuntimeShipItem(entity);", "S3E-F2");
    has(src("space/runtime/scene/tick.js"), "consumeEntityCapacitor(entity, cycleCapNeed)", "S3E-F3");
    const cb = block(src("space/runtime/moduleRuntimeCallbacks.js"),
      "\nfunction buildLocalCycleRuntimeCallbacks(fallbackCharacterID = 0) {", "S3E-F9");
    for (const needle of ["return getShipEntityInventoryCharacterID(entity, fallbackCharacterID);",
      "    getEntityRuntimeShipItem,", "    getEntityRuntimeFittedItems,", "    getEntityRuntimeActiveModuleContexts,",
      "    getEntityRuntimeLoadedCharge,", "    getEntityRuntimeDirectModifierEntriesForItem(",
      "    setEntityCapacitorRatio,",
      "    broadcastDamageStateChange,", "    persistDynamicEntity,"]) has(cb, needle, "S3E-F9");
    const lc = src("space/modules/localCycleRuntime.js");
    const state = block(lc, "\nfunction resolveLocalCycleState(options = {}) {", "S3E-F10");
    has(state, "const characterID = resolveCharacterID(entity);", "S3E-F10");
    has(state, "const skillMap = characterID > 0 ? getCachedCharacterSkillMap(characterID) : new Map();", "S3E-F10");
    has(lc, "const LOCAL_CYCLE_EFFECTS = new Set([\n  \"armorRepair\",\n  \"shieldBoosting\",\n  \"powerBooster\",\n"
      + "  \"structureRepair\",\n  \"fueledShieldBoosting\",\n  \"fueledArmorRepair\",\n]);", "S3E-F10");
    has(lc, "const START_OF_CYCLE_EFFECTS = new Set([\n  \"shieldBoosting\",", "S3E-F10");
    const prep = block(lc, "\nfunction prepareLocalCycleActivation(options = {}) {", "S3E-F10");
    has(prep, "if (cycleState.chargeRequired && !cycleState.chargeItem) {", "S3E-F10");
    has(prep, "errorMsg: \"NO_AMMO\",", "S3E-F10");
    has(prep, "localCycleResolvedState: cycleState,", "S3E-F10");
    const exec = block(lc, "\nfunction executeLocalCycle(options = {}) {", "S3E-F10");
    has(exec, "if (activation && cycleState.applicationTiming !== \"start\") {", "S3E-F10");
    has(exec, "if (capacitorCapacity > 0 && cycleState.capacitorBonus > 0) {", "S3E-F10 (cap only for a booster)");
    has(lc, "\nmodule.exports = {\n  prepareLocalCycleActivation,\n  prepareLocalCycleBoundary,\n  executeLocalCycle,",
      "S3E-F10");
    const asm = src("space/runtime/activeShipModifiers.js");
    const sourceAt = asm.indexOf("\nfunction resolveActiveShipModifierSourceAttributes(");
    assert.ok(sourceAt >= 0, "S3E-F11: resolveActiveShipModifierSourceAttributes");
    const source = asm.slice(sourceAt, asm.indexOf("\nfunction ", sourceAt + 1));
    assert.ok(!asm.includes("LIVE_SOURCE_ACTIVE_HARDENER_EFFECT_IDS"), "S3E-F11: the whitelist is back");
    for (const needle of ["const shipItem = options.shipItem || getEntityRuntimeShipItem(entity);",
      "return resolveGenericModuleAttributeOverrides(\n    getShipEntityInventoryCharacterID(entity, 0),\n    shipItem,",
      "fittedItems: options.fittedItems || getEntityRuntimeFittedItems(entity),",
      "skillMap: options.skillMap || getEntityRuntimeSkillMap(entity),", "activeModuleContexts: sourceContexts,",
      "options.additionalLocationModifierSources ||", ") || baseAttributes;"]) has(source, needle, "S3E-F11");
    assert.ok(!source.includes("overloadEffectRecordsByModuleID"), "S3E-F11: the overload map is read again");
    has(block(src("space/runtime/entityDogmaView.js"), "\nfunction getShipEntityInventoryCharacterID(entity, fallback = 0) {",
      "S3E-F11"), "entity.pilotCharacterID ??\n      entity.characterID", "S3E-F11");
    has(source, "getReactiveArmorHardenerResonanceOverrides(", "S3E-F11b");
    has(source, "      : baseAttributes;", "S3E-F11b (no cycle state = base 15 %)");
    const loop = block(asm, "\nfunction collectEntityActiveShipAttributeModifierEntries(", "S3E-F11");
    const whAt = loop.indexOf("wormholeEnvironmentRuntime.collectShipAttributeModifierEntriesForSystem(");
    const modAt = loop.indexOf("for (const activeModuleContext of activeModuleContexts) {");
    assert.ok(whAt > 0 && modAt > whAt, `S3E-F11 order WH ${whAt} < modules ${modAt}`);
    has(loop.slice(modAt), "appendDirectModifierEntries(", "S3E-F11");
    has(src("space/runtime/scene/shipDerivedState.js"), "activeSelfModifierEffectsByItemID:\n"
      + "          collectEntityActiveSelfModifierEffectsByItemID(entity),", "S3E-F11");
    has(src("space/runtime/shipEntity.js"), "  const passiveResourceState =\n    source.passiveResourceState ||\n"
      + "    buildPassiveShipResourceState(", "S3E-F12");
    const pds = src("space/runtime/passiveDerivedState.js");
    has(block(pds, "\nfunction buildPassiveShipResourceState(characterID, shipItem, options = {}) {", "S3E-F12a"),
      "  if (!shipItem.itemID) {\n    return null;\n  }", "S3E-F12a");
    has(pds, "Math.exp((-5 * elapsedSeconds) / totalRechargeSeconds)", "S3E-F14");
    has(src("space/combat/damage.js"), "entity.passiveDerivedState.attributes", "S3E-F13");
    const prop = src("space/runtime/propulsionModule.js");
    const tail = prop.slice(prop.indexOf("\nObject.assign(module.exports, {"));
    for (const name of ["EFFECT_ID_AFTERBURNER", "EFFECT_ID_MICROWARPDRIVE", "PROPULSION_GUID_BY_EFFECT"]) {
      has(tail, `\n  ${name},`, "S3E-F15a");
    }
    has(prop, "const PROPULSION_EFFECT_MICROWARPDRIVE = \"moduleBonusMicrowarpdrive\";", "S3E-F15a");
    has(src("space/runtime/moduleActivationEffectRecord.js"), "\nfunction resolveDefaultActivationEffect(typeID) {",
      "S3E-F16");
    has(src("space/modules/assistanceModuleRuntime.js"), "\nfunction resolveAssistanceDefinition(effectRecord) {\n"
      + "  return ASSISTANCE_EFFECTS[normalizeEffectName(effectRecord)] || null;", "S3E-F16");
    has(src("space/modules/liveModuleAttributes.js"), "\nfunction buildLiveModuleAttributeMap(\n  shipItem,\n"
      + "  moduleItem,\n  chargeItem,\n  skillMap,\n  fittedItems,\n  activeModuleContexts,\n  options = {},\n) {",
    "S3E-F14");
    has(src("space/runtime/entitySpacePersistence.js"), "entity.persistSpaceState !== true", "S3E-F17");
  });

  test("S3E-F6/F6a/F7/F8/F9: resolve/execute of the assistance runtime (inputs, order of refusals, the lock "
    + "callback also at the end of a cycle), source character = characterID ?? pilotCharacterID (0 on a twin), "
    + "career needs a ship item and two characters, no crimewatch in the assistance runtime, the callback fields", () => {
    const asr = src("space/modules/assistanceModuleRuntime.js");
    const fn = (header) => {
      const at = asr.indexOf(header);
      assert.ok(at >= 0, `S3E-F6: ${header}`);
      return asr.slice(at, asr.indexOf("\nfunction ", at + 1));
    };
    const resolve = fn("\nfunction resolveAssistanceModuleActivation({");
    for (const p of ["  moduleItem,", "  effectRecord,", "  chargeItem = null,", "  shipItem,", "  skillMap = null,",
      "  fittedItems = null,", "  activeModuleContexts = null,", "  options = {},", "  callbacks = {},"]) {
      has(resolve, `\n${p}\n`, "S3E-F6");
    }
    const order = ["errorMsg: \"UNSUPPORTED_MODULE\"", "errorMsg: \"TARGET_REQUIRED\"",
      "isEntityAssistanceDisallowed(targetEntity", "!isAssistanceTargetEntity(definition, targetEntity)",
      "!canEntitiesInteractLocally(entity, targetEntity)",
      "callbacks.isEntityLockedTarget(entity, normalizedTargetID) !== true", "errorMsg: \"TARGET_NOT_LOCKED\"",
      "const characterID = resolveSourceCharacterID(entity);", "runtimeAttrs: {",
      "        },\n      },\n      effectStatePatch,\n    },\n  };"]
      .map((needle) => [needle, resolve.indexOf(needle)]);
    for (let i = 0; i < order.length; i += 1) {
      assert.ok(order[i][1] > 0 && (i === 0 || order[i][1] > order[i - 1][1]), `S3E-F6 order: ${order[i][0]}`);
    }
    const exec = fn("\nfunction executeAssistanceModuleCycle({");
    has(exec, "  isActivationPass = false,", "S3E-F6");
    has(exec, "callbacks.isEntityLockedTarget(entity, effectState.targetID) !== true", "S3E-F6 (:1650)");
    has(exec, "if (!isActivationPass) {\n    consumeAncillaryChargeForCycle(", "S3E-F6");
    const exported = asr.slice(asr.lastIndexOf("\nmodule.exports = {"));
    for (const name of ["resolveAssistanceModuleActivation", "executeAssistanceModuleCycle"]) {
      has(exported, `\n  ${name},`, "S3E-F6");
    }
    has(block(asr, "\nfunction resolveSourceCharacterID(entity) {", "S3E-F6a"),
      "      entity.characterID ??\n      entity.pilotCharacterID ??", "S3E-F6a");
    const career = src("services/inventory/careerCombatOutcomes.js");
    has(career, "other === characterID", "S3E-F7");
    has(career, "items.findShipItemById(source.itemID)", "S3E-F7");
    has(resolve, "evaluateRemoteAssistance(scene, entity, targetEntity);\n"
      + "  if (!safety.success) return { ...safety, matched: true, stopReason: \"target\" };", "S3E-F8");
    has(exec, "crimewatch.evaluateRemoteAssistance(scene, entity, targetEntity);\n"
      + "  if (safety && !safety.success) return { ...safety, stopReason: \"target\" };", "S3E-F8");
    has(block(src("services/security/crimewatchState.js"),
      "\nfunction evaluateRemoteAssistance(scene, source, target, now = getWallclockNowMs()) {", "S3E-F8"),
    "  if (!sourceID || !targetID || sourceID === targetID) return { success: true };", "S3E-F8: same owner = no check");
    const modules = src("space/runtime/scene/modules.js");
    has(modules, "const offensiveActivation =", "S3E-F8");
    has(modules, "evaluateCrimewatchOffensiveAggression(", "S3E-F8");
    const cb = block(src("space/runtime/moduleRuntimeCallbacks.js"),
      "\nfunction buildAssistanceModuleRuntimeCallbacks(scene = null) {", "S3E-F9");
    for (const field of ["isEntityLockedTarget", "getEntityRuntimeModuleItem", "getEntityRuntimeLoadedCharge",
      "getEntityCapacitorAmount", "setEntityCapacitorRatio", "notifyCapacitorChangeToSession",
      "normalizeShipConditionState", "buildShipHealthTransitionResult", "notifyShipHealthAttributesToSession",
      "broadcastDamageStateChange", "persistDynamicEntity"]) has(cb, `\n    ${field},`, "S3E-F9");
    has(cb, "\n    getEntitySurfaceDistance(sourceEntity, targetEntity) {", "S3E-F9");
  });

  test("S3E-F15/S3G-F1/F2/F3/F4/F5: propulsionModule exports; refresh sequence stand-in -> passive "
    + "(recalculateSpeedFraction false) -> propulsion -> captureShipMotion(derived) -> adopt -> queueShipMotionChange; "
    + "the movement queue methods; broadcastShipPrimeUpdates needs all three previousState fields; propulsion names; "
    + "the attribute signature", () => {
    const prop = src("space/runtime/propulsionModule.js");
    const head = prop.slice(0, prop.indexOf("\n};"));
    for (const name of ["applyPropulsionEffectStateToEntity", "getPropulsionModuleRuntimeAttributes"]) {
      has(head, `\n  ${name},`, "S3E-F15");
    }
    const tail = prop.slice(prop.indexOf("\nObject.assign(module.exports, {"));
    for (const name of ["PROPULSION_EFFECT_AFTERBURNER", "PROPULSION_EFFECT_MICROWARPDRIVE", "PROPULSION_GUID_BY_EFFECT"]) {
      has(tail, `\n  ${name},`, "S3E-F15a");
    }
    has(prop, "const PROPULSION_EFFECT_AFTERBURNER = \"moduleBonusAfterburner\";", "S3G-F4");
    const apply = block(prop, "\nfunction applyPropulsionEffectStateToEntity(entity, effectState) {", "S3G-F4");
    for (const needle of ["!isPropulsionModuleEffectState(effectState)", "const passiveState = entity.passiveDerivedState",
      "clampMaxVelocityToShipSpeedLimit(", "if (effectState.effectName === PROPULSION_EFFECT_MICROWARPDRIVE) {",
      "toFiniteNumber(effectState.speedBoostFactor, 0)", "toFiniteNumber(effectState.massAddition, 0)"]) {
      has(apply, needle, "S3G-F4");
    }
    has(prop, "\nfunction getPropulsionModuleRuntimeAttributes(characterID, moduleItem, options = {}) {", "S3G-F5");
    const sds = src("space/runtime/scene/shipDerivedState.js");
    const seq = ["const derived = this.movementChangesWait(entity)\n      ? Object.create(entity)\n      : entity;",
      "applyPassiveResourceStateToEntity(derived, passiveResourceState, {\n      recalculateSpeedFraction: false,",
      "applyActivePropulsionEffectStatesToEntity(\n      derived,",
      "const derivedMotion = this.captureShipMotion(derived);",
      "if (derived !== entity) {\n      this.adoptDerivedShipState(entity, derived);",
      "const motionQueued = derived !== entity && this.queueShipMotionChange(\n      entity,\n      derivedMotion,",
      "if (!motionQueued) {\n      if (derived === entity) {\n        this.dropPendingShipMotion(entity);"]
      .map((needle) => [needle, sds.indexOf(needle)]);
    for (let i = 0; i < seq.length; i += 1) {
      assert.ok(seq[i][1] > 0 && (i === 0 || seq[i][1] > seq[i - 1][1]), `S3E-F15 order: ${seq[i][0]}`);
    }
    const mq = src("space/runtime/scene/movementQueue.js");
    has(mq, "const SHIP_MOTION_FIELDS = Object.freeze([\n  \"mass\",\n  \"inertia\",\n  \"maxVelocity\",\n"
      + "  \"alignTime\",\n  \"agilitySeconds\",\n  \"maxAccelerationTime\",\n  \"radius\",\n]);", "S3G-F2");
    for (const header of ["\nmovementChangesWait(entity) {", "\ncaptureShipMotion(entity) {",
      "\nadoptDerivedShipState(entity, derived) {", "\nqueueShipMotionChange(entity, after, onApplied) {",
      "\ndropPendingShipMotion(entity) {"]) has(mq, header, "S3G-F2");
    has(mq, "if (!SHIP_MOTION_FIELDS.includes(key) && key !== \"speedFraction\") {", "S3G-F2");
    has(block(mq, "\nqueueShipMotionChange(entity, after, onApplied) {", "S3G-F2"),
      "    if (!this.movementChangesWait(entity)) {\n      return false;\n    }", "S3G-F2");
    const pres = block(src("space/runtime/scene/presentation.js"),
      "\nbroadcastShipPrimeUpdates(entity, options = {}) {", "S3G-F1");
    has(pres, "if (!entity || entity.kind !== \"ship\") {", "S3G-F1");
    has(pres, "[\"inertia\", \"mass\", \"maxVelocity\"].every((field) => (", "S3G-F1");
    has(pres, "buildShipPrimeDeltaUpdates(entity, options.previousState, stamp)", "S3G-F1");
    has(pres, "this.queueBallHistory(entity, primeUpdates);", "S3G-F1");
    const pds = src("space/runtime/passiveDerivedState.js");
    has(block(pds, "\nfunction applyPassiveResourceStateToEntity(entity, resourceState, options = {}) {", "S3G-F3"),
      "  if (options.recalculateSpeedFraction === true) {\n    entity.speedFraction = getActualSpeedFraction(entity);",
      "S3G-F3");
    const consumers = new Set(GAME_MODULES.flatMap((e) => e.symbols)
      .filter((s) => ["movementChangesWait", "captureShipMotion", "adoptDerivedShipState", "queueShipMotionChange",
        "dropPendingShipMotion", "broadcastShipPrimeUpdates", "applyPassiveResourceStateToEntity",
        "applyPropulsionEffectStateToEntity", "PROPULSION_GUID_BY_EFFECT"].includes(s.name)).map((s) => s.consumer));
    assert.deepStrictEqual([...consumers], ["prop", "burst"]);
  });

  test("AW-F9/F10/F15 smartbomb: the crimewatch callbacks are a pair; point defense: the highsec "
    + "refusal in resolve and execute, consumeLoadedCharge before the damage loop; the smartbomb callbacks record the "
    + "killmail; graphicInfo null for the smartbomb; crimewatch reads a twin's ownerID as a player", () => {
    const between = (text, from, to, label) => {
      const a = text.indexOf(from);
      const b = text.indexOf(to, a + 1);
      assert.ok(a >= 0 && b > a, `${label}: ${from} .. ${to}`);
      return text.slice(a, b);
    };
    const sb = src("space/modules/smartbombRuntime.js");
    has(between(sb, "function executeSmartbombCycle({", "function listSmartbombCycleTargets(", "AW-F9"),
      "if (hasEvaluationCallback !== hasCommitCallback) {", "AW-F9");
    const pd = src("space/modules/pointDefenseRuntime.js");
    has(between(pd, "function resolvePointDefenseActivation({", "function executePointDefenseCycle({", "AW-F10"),
      "if (isPointDefenseDisallowedInScene(scene)) {", "AW-F10 resolve");
    const exec = between(pd, "function executePointDefenseCycle({", "module.exports", "AW-F10");
    has(exec, "if (isPointDefenseDisallowedInScene(scene)) {", "AW-F10 execute");
    const consumeAt = exec.indexOf("callbacks.consumeLoadedCharge(entity, moduleItem, chargeItem, chargesPerCycle, nowMs)");
    const damageAt = exec.indexOf("callbacks.applyPointDefenseDamage(");
    assert.ok(consumeAt > 0 && damageAt > consumeAt, "AW-F10: consume before the damage loop");
    const cb = src("space/runtime/moduleRuntimeCallbacks.js");
    has(block(cb, "function buildSmartbombRuntimeCallbacks(scene = null) {", "AW-F15"),
      "recordAreaDamageKillmailOutcome(", "AW-F15");
    const fx = block(src("space/runtime/moduleSpecialFx.js"), "function buildGenericModuleSpecialFxGraphicInfo(",
      "AW-F9 fx");
    has(fx, "if (effectState && effectState.smartbombEffect === true) {\n    return null;\n  }", "AW-F9 fx");
    has(block(src("services/security/crimewatchState.js"), "function resolveEntityPlayerCharacterID(entity) {",
      "AW-F15 crimewatch"), "const ownerID = toPositiveInt(entity.ownerID, 0);", "AW-F15 crimewatch");
  });

  test("AW-F7/F8/H-AW-4 bomb: the blast skips a target without aggression success, empire space "
    + "refuses, the flight keeps the launch callbacks, the player bomb has no target; breacher: the attribution "
    + "carries combatIdentity, the DoT passes it as attackerIdentity, the killmail takes it before the bounty", () => {
    const bomb = src("space/modules/bombRuntime.js");
    has(block(bomb, "function detonateBombEntity(", "AW-F8"), "if (aggression?.success !== true) continue;", "AW-F8");
    has(block(bomb, "function resolveBombLauncherActivation(", "AW-F8"),
      "if (getSolarSystemPseudoSecurity(scene.system) > 0) return refuse(\"BOMB_IN_EMPIRE_SPACE\");", "AW-F8");
    const launch = block(bomb, "function executeBombLaunchCycle(", "AW-F8");
    has(launch, "snapshot, callbacks, terminal: false };", "AW-F8 flight callbacks");
    has(launch, "flights.set(bomb, flight);", "AW-F8");
    const mods = src("space/runtime/scene/modules.js");
    const bombAt = mods.indexOf("if (bombRuntime.isBombLauncher(effectiveModuleItem)) {");
    const bombEnd = mods.indexOf("\n    }\n", bombAt);
    assert.ok(bombAt > 0 && bombEnd > bombAt, "AW-F8 player: the bomb branch");
    has(mods.slice(bombAt, bombEnd), "resolvedTargetID = 0;", "AW-F8 player");
    has(block(src("space/combat/breacherPods.js"), "function attribution(source, snapshot) {", "AW-F7"),
      "combatIdentity: require(\"./killmailTracker\").resolveAttackerIdentity(source, { weaponSnapshot: snapshot })",
      "AW-F7");
    const dot = src("space/runtime/breacherPodDamage.js");
    assert.strictEqual(dot.split("attackerIdentity: source.combatIdentity").length - 1, 2, "H-AW-4: note + killmail");
    const km = src("space/combat/killmailTracker.js");
    const identityAt = km.indexOf("const finalIdentity = options.attackerIdentity || resolveAttackerIdentity(");
    const payoutAt = km.indexOf("const bountyClaimed = resolveBountyPayout(targetEntity, finalAttacker, {");
    assert.ok(identityAt > 0 && payoutAt > identityAt, "H-AW-4: attackerIdentity before the bounty");
  });

  test("FS1 (shipwing-session1): leaving a ship clears its pilot, board sets the active ship before the attach "
    + "Every slim payload rebuilds ship modules from the itemStore of pilotCharacterID?? characterID, the "
    + "slim item and the activation FX name the module", () => {
    const ship = src("space/runtime/shipEntity.js");
    has(block(ship, "\nfunction clearSessionStateFromShipEntity(entity) {", "FS1"), "entity.pilotCharacterID = 0;", "FS1");
    has(ship, "  entity.session = session || null;\n  entity.persistSpaceState = true;", "FS1");
    has(ship, "  entity.characterID = characterID;\n  entity.pilotCharacterID = characterID;", "FS1");
    has(block(src("space/runtime/scene/sessions.js"), "\ndisembarkSession(session, options = {}) {", "FS1"),
      "clearSessionStateFromShipEntity(entity);", "FS1");
    const board = block(src("space/transitions.js"),
      "\nfunction boardSpaceShip(session, shipID, { abandonCurrentHull = false } = {}) {", "FS1");
    const order = ["const activeShipResult = setActiveShipForCharacter(",
      "const boardedEntity = spaceRuntime.attachSessionToExistingEntity("].map((n) => board.indexOf(n));
    assert.ok(order[0] >= 0 && order[1] > order[0], `FS1 board order ${order}`);
    has(block(ship, "\nfunction refreshShipPresentationFields(entity) {", "FS1"),
      "entity.modules = resolveShipSlimModules(entity);", "FS1");
    const slim = block(ship, "\nfunction resolveShipSlimModules(entity) {", "FS1");
    has(slim, "const characterID = getShipEntityInventoryCharacterID(entity, 0);", "FS1");
    has(slim, "buildSlimModuleTuples(characterID, entity.itemID),", "FS1");
    has(block(src("space/runtime/entityDogmaView.js"), "\nfunction getShipEntityInventoryCharacterID(", "FS1"),
      "entity.pilotCharacterID ??", "FS1");
    has(block(ship, "\nfunction refreshEntitiesForSlimPayload(entities) {", "FS1"),
      "refreshShipPresentationFields(entity);", "FS1");
    has(block(src("space/runtime/scene/presentation.js"), "\nbroadcastSlimItemChanges(entities) {", "FS1"),
      "refreshEntitiesForSlimPayload(entities.filter(", "FS1");
    has(src("space/destiny/index.js"), "buildList(Array.isArray(entity.modules) ? entity.modules : []),", "FS1");
    const fx = src("space/runtime/scene/modules.js");
    has(fx, "moduleID: presentationEffectState.moduleID,", "FS1");
    has(fx, "this.broadcastSpecialFx(\n            entity.itemID,\n            controlSpecialFxGuid,", "FS1");
    has(src("services/chat/commands/fitModule.js"), "scene.broadcastSlimItemChanges([entity]);", "FS1");
  });

  test("F18 every GAME_MODULES symbol is defined in the text of its module", () => {
    const missing = [];
    for (const entry of GAME_MODULES) {
      const file = path.join(SRC, `${entry.path}.js`);
      if (!fs.existsSync(file)) {
        missing.push(`${entry.path} (file)`);
        continue;
      }
      const texts = definerTexts(entry.path);
      for (const s of entry.symbols) {
        const patterns = symbolPatterns(s.name, s.kind);
        const found = texts.some((t) => patterns.some((p) => t.includes(p))
          || (s.kind === "export" && oneLineExports(t).includes(s.name)));
        if (!found) missing.push(`${entry.path}.${s.name}`);
      }
    }
    assert.deepStrictEqual(missing, []);
  });

  test("CB-F1 (command burst) resolveBurstAffinityGroupID: the /rr field first, then "
    + "commandBurstAffinityExplicit === true -> commandBurstAffinityGroupID; isBurstRecipient: sharesFleet only "
    + "without sharesExplicitAffinity; BURST_AFFINITY_BASE above the /rr start and safe; serializeSpaceState keeps "
    + "no affinity", () => {
    const { BURST_AFFINITY_BASE } = require("../../lib/adapter/burstAccess");
    const text = src("space/modules/commandBurstRuntime.js");
    const resolve = block(text, "\nfunction resolveBurstAffinityGroupID(entity) {", "CB-F1");
    const rrAt = resolve.indexOf("entity.remoteRepairBurstAffinityGroupID");
    const explicitAt = resolve.indexOf("entity.commandBurstAffinityExplicit === true");
    assert.ok(rrAt > 0 && explicitAt > rrAt, "CB-F1: the /rr field wins over the explicit one");
    has(resolve, "toInt(entity.commandBurstAffinityGroupID, 0)", "CB-F1");
    const recipient = block(text, "\nfunction isBurstRecipient(sourceEntity, targetEntity, rangeMeters, options = {}) {",
      "CB-F1");
    const fleet = recipient.slice(recipient.indexOf("const sharesFleet ="));
    has(fleet.slice(0, fleet.indexOf(";")), "!sharesExplicitAffinity", "CB-F1 sharesFleet");
    has(recipient, "sourceAffinityGroupID === targetAffinityGroupID", "CB-F1");
    const rrStart = /\nconst REMOTE_REPAIR_BURST_AFFINITY_ID_START = (\d+);/
      .exec(src("RemoteRepShow/remoteRepairFleetCommands.js"));
    assert.ok(rrStart, "CB-F1: REMOTE_REPAIR_BURST_AFFINITY_ID_START");
    assert.strictEqual(Number(rrStart[1]), 3980000000000000);
    assert.ok(Number(rrStart[1]) < BURST_AFFINITY_BASE);
    assert.ok(BURST_AFFINITY_BASE + 2 ** 31 < Number.MAX_SAFE_INTEGER);
    const serialize = block(src("space/runtime/entitySpacePersistence.js"), "\nfunction serializeSpaceState(entity) {",
      "CB-F1");
    assert.ok(!serialize.includes("commandBurstAffinity") && !serialize.includes("BurstAffinity"),
      "CB-F1: the affinity is not persisted");
  });

  test("CB-F2 (command burst) dispatchCommandBurstPulse refreshes the recipient after "
    + "applyTimedCommandBurstToEntity (the refresh a twin skips); the spawn builds the passive state with "
    + "pilotCharacterID ?? characterID; collectEntityActiveShipAttributeModifierEntries adds the hull bursts after the "
    + "loop of the active modules; buildClientDbuffStateEntries prunes and takes buildExpiry", () => {
    const burst = src("space/runtime/commandBurst.js");
    const pulse = burst.slice(burst.indexOf("\nfunction dispatchCommandBurstPulse("));
    const applyAt = pulse.indexOf("commandBurstRuntime.applyTimedCommandBurstToEntity(");
    const refreshAt = pulse.indexOf("scene.refreshShipEntityDerivedState(recipient");
    assert.ok(applyAt > 0 && refreshAt > applyAt, "CB-F2: apply, then the refresh of the recipient");
    const spawn = block(src("space/runtime/shipEntity.js"), "\nfunction buildRuntimeShipEntity(shipSpec, systemID, "
      + "options = {}) {", "CB-F2");
    has(spawn, "    source.passiveResourceState ||\n    buildPassiveShipResourceState(\n"
      + "      source.pilotCharacterID ?? source.characterID,", "CB-F2");
    has(spawn, "wormholeEnvironmentRuntime.collectShipAttributeModifierEntriesForSystem(", "CB-F2");
    const asm = block(src("space/runtime/activeShipModifiers.js"),
      "\nfunction collectEntityActiveShipAttributeModifierEntries(entity, nowMs = Date.now()) {", "CB-F2");
    const whAt = asm.indexOf("collectShipAttributeModifierEntriesForSystem(");
    const loopAt = asm.indexOf("for (const activeModuleContext of activeModuleContexts) {");
    const hullAt = asm.indexOf("commandBurstRuntime.collectModifierEntriesForItem(");
    assert.ok(whAt > 0 && loopAt > whAt && hullAt > loopAt, "CB-F2: wormhole, active modules, hull bursts");
    const dbuff = block(src("space/modules/commandBurstRuntime.js"),
      "\nfunction buildClientDbuffStateEntries(entity, options = {}) {", "CB-F2");
    has(dbuff, "pruneExpiredCommandBursts(entity, nowMs);", "CB-F2");
    has(dbuff, "typeof options.buildExpiry === \"function\"", "CB-F2");
    has(src("space/modules/commandBurstRuntime.js"), "entity.commandBurstDynamicBuffs instanceof Map", "CB-F2");
  });

  test("SL4 safe logoff: SL-F1 ACTIONS without shipWingSvc, callMethod -> handleServiceAction; SL-F4 "
    + "drones = fighter/drone with controllerID; SL-F6 exports, LABELS, LABEL_ORDER, abort/prepareStart; SL-F7 "
    + "Handle_SafeLogoff reads the module at the call, no destructuring, no other mod; SL-F9 non-empty list = no start",
  () => {
    const rt = src("services/ship/safeLogoffRuntime.js");
    const actions = block(rt, "const ACTIONS = Object.freeze({", "SL-F1");
    assert.ok(!actions.includes("shipWing"), "SL-F1: ACTIONS knows no shipWing service");
    has(block(rt, "function handleServiceAction(session, service, method) {", "SL-F1"),
      "abort(session, { reason: service === \"dogmaIM\" ? LABELS.ACTIVE_MODULES : LABELS.MOVEMENT_ACTIVE });", "SL-F1");
    has(src("services/baseService.js"), "    if (session?._safeLogoff) {\n"
      + "      require(\"./ship/safeLogoffRuntime\").handleServiceAction(session, this._name, normalizedMethod);",
    "SL-F1");
    has(rt, "if ((other.kind === \"fighter\" || (other.kind === \"drone\" && other.droneStateVisible !== false)) &&\n"
      + "        Number(other.controllerID) === Number(ship.itemID)) add(LABELS.DRONES_CONNECTED);", "SL-F4");
    has(rt, "  DRONES_CONNECTED: condition(\"DronesConnected\"),", "SL-F6");
    has(rt, "  MOVEMENT_ACTIVE: condition(\"ShipOrbitingOrKeepingAtRange\"),", "SL-F6");
    has(rt, "labels ? [labels] : [ABORT_LABELS[reason] || reason]);", "SL-F6");
    has(rt, "const LABEL_ORDER = Object.values(LABELS);", "SL-F6");
    has(rt, "  labels.sort((a, b) => LABEL_ORDER.indexOf(a) - LABEL_ORDER.indexOf(b));\n"
      + "  return { success: true, labels, context };", "SL-F6");
    has(rt, "function abort(session, { notify = true, labels = null, reason = LABELS.MOVEMENT_ACTIVE } = {}) {\n"
      + "  const record = session?._safeLogoff;\n  if (!clear(session, record)) return false;", "SL-F6");
    const prep = block(rt, "function prepareStart(session) {", "SL-F6");
    has(prep, "  const result = collectFailedConditions(session);\n  if (!result.success) return result;\n"
      + "  if (result.labels.length) return { success: true, data: result.labels };", "SL-F6");
    const exportsAt = rt.indexOf("\nmodule.exports = {");
    assert.ok(exportsAt > 0, "SL-F6: module.exports");
    const exported = rt.slice(exportsAt, rt.indexOf("};", exportsAt));
    for (const name of ["LABELS", "collectFailedConditions", "prepareStart", "abort", "processScene"]) {
      assert.ok(new RegExp(`[{,\\s]${name}[,\\s]`).test(exported), `SL-F6: export ${name}`);
    }
    const ship = src("services/ship/shipService.js");
    const handler = block(ship, "  Handle_SafeLogoff(args, session, kwargs) {", "SL-F7");
    has(handler, "const result = require(\"./safeLogoffRuntime\").prepareStart(session);", "SL-F7");
    has(handler, "    return result.data;\n", "SL-F9");
    has(ship, "    if (!Array.isArray(failedConditions) || failedConditions.length > 0) {\n      return;\n    }\n\n"
      + "    require(\"./safeLogoffRuntime\").startAfterResponse(session, failedConditions);", "SL-F9");
    has(rt, "function startAfterResponse(session, response) {\n  const record = response?.[START_INTENT];\n"
      + "  if (!record || record.responseHandled) return false;", "SL-F9");
    const destructured = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")
          && /\{[^}]*\b(prepareStart|collectFailedConditions)\b[^}]*\}\s*=\s*require\([^)]*safeLogoffRuntime/
            .test(fs.readFileSync(full, "utf8"))) {
          destructured.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    assert.deepStrictEqual(destructured, [], "SL-F7: nobody destructures prepareStart/collectFailedConditions");
    const modsDir = path.resolve(__dirname, "..", "..", "..");
    const hits = [];
    const walkMods = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkMods(full);
        else if (entry.name.endsWith(".js") && fs.readFileSync(full, "utf8").includes("safeLogoffRuntime")) {
          hits.push(path.relative(modsDir, full).split(path.sep)[0]);
        }
      }
    };
    walkMods(modsDir);
    assert.deepStrictEqual([...new Set(hits)].sort(), ["shipWing"], "SL-F7: no other mod touches safeLogoffRuntime");
  });

  test("FM-V1 (formations) dispatchGotoPointEntity is an own export of destinyMovementEngine "
    + "(= subwarpCommands.gotoPointEntity(runtime, entity, point, options = {})); no vendor file outside its definer "
    + "names it; the GAME_MODULES row is consumer `formation`, no wrap, no FIRST_LOAD", () => {
    const engine = src("space/runtime/destinyMovementEngine.js");
    has(engine, "\nconst dispatchGotoPointEntity = movementSubwarpCommands.gotoPointEntity;\n", "FM-V1 definer");
    const assignAt = engine.indexOf("\nObject.assign(module.exports, {");
    assert.ok(assignAt > 0, "FM-V1: the export block");
    has(engine.slice(assignAt), "\n  dispatchGotoPointEntity,\n", "FM-V1 export");
    const sub = src("space/destiny/commands/subwarpCommands.js");
    const header = "\n  function gotoPointEntity(runtime, entity, point, options = {}) {";
    const at = sub.indexOf(header);
    assert.ok(at >= 0, "FM-V1 signature");
    const next = sub.indexOf("\n  function ", at + header.length);
    const body = sub.slice(at, next > at ? next : undefined);
    has(body, "entity.mode = \"GOTO\";", "FM-V1 mode");
    has(body, "entity.targetPoint = commandPoint;", "FM-V1 targetPoint");
    assert.ok(!/\bsession\b/.test(body), "FM-V1: no session");
    const users = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && fs.readFileSync(full, "utf8").includes("dispatchGotoPointEntity")) {
          users.push(path.relative(SRC, full).split(path.sep).join("/"));
        }
      }
    };
    walk(SRC);
    assert.deepStrictEqual(users, ["services/npe/airScene1.js", "space/runtime/destinyMovementEngine.js"],
      "FM-V1: consumers outside the definer");
    const air = src("services/npe/airScene1.js");
    has(air, "const engine = () => require(\"../../space/runtime/destinyMovementEngine\");", "FM-V1 air");
    assert.deepStrictEqual(air.match(/dispatchGotoPointEntity/g).length, 1, "FM-V1 air: one use");
    has(air, "engine().dispatchGotoPointEntity(scene, entity, context.point(args[0]));", "FM-V1 air");
    const rows = GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.consumer === "formation")
      .map((s) => [m.path, s.name, s.kind, s.wrap === true, s.firstLoad === true]));
    assert.deepStrictEqual(rows, [["space/runtime/destinyMovementEngine", "dispatchGotoPointEntity", "export", false,
      false]]);
  });

  test("FM-V2 (formations) the vendor reads the cloak of an entity as toInt(isCloaked?? cloakMode?? "
    + "cloaked, 0) > 0 (subwarpCommands isCloakedFollowOrbitTarget, toInt = common/numbers); the adapter hostStatus "
    + "reads the same order", () => {
    const sub = src("space/destiny/commands/subwarpCommands.js");
    const header = "\n  function isCloakedFollowOrbitTarget(target) {";
    const at = sub.indexOf(header);
    assert.ok(at >= 0, "FM-V2 signature");
    const next = sub.indexOf("\n  function ", at + header.length);
    const body = sub.slice(at, next > at ? next : undefined).replace(/\s+/g, " ");
    has(body, "return toInt( target && ( target.isCloaked ?? target.cloakMode ?? target.cloaked ), 0, ) > 0;",
      "FM-V2 cloak order");
    has(src("common/numbers.js"), "function toInt(value, fallback = 0) {\n  return Math.trunc(toFiniteNumber(value, "
      + "fallback));\n}", "FM-V2 toInt");
  });

  test("VF-S NPC site structures: the vendor static site entities (siteKillableStructure "
    + "siteEnvironmentProp with dungeonMaterializedEnvironment and categoryID from the type), SITE_CONTENT_OWNER_ID 1; "
    + "groups 319/494 are lockable (not in NON_TARGETABLE_GROUP_IDS); a hit runs handleEncounterEntityAttacked", () => {
    const site = src("services/dungeon/dungeonUniverseSiteService.js");
    for (const needle of ["kind: \"siteKillableStructure\"", "kind: \"siteEnvironmentProp\"",
      "dungeonMaterializedEnvironment: true", "const SITE_CONTENT_OWNER_ID = 1;",
      "categoryID: toInt(candidate.typeRecord && candidate.typeRecord.categoryID"]) has(site, needle, "VF-S site");
    const groups = block(src("space/runtime/targeting.js"), "const NON_TARGETABLE_GROUP_IDS = new Set([", "VF-S");
    const ids = [...groups.matchAll(/^\s+(\d+),/gm)].map((m) => Number(m[1]));
    assert.deepStrictEqual(ids.filter((id) => id === 319 || id === 494), [], "VF-S lockable groups");
    assert.ok(ids.length > 0, "VF-S group list parsed");
    has(src("space/runtime/targetDamageApplication.js"), "handleEncounterEntityAttacked", "VF-S attacked waves");
  });

  test("BF1 (board) Handle_Board -> boardSpaceShip(session, shipID); ejectRuntime exports "
    + "launchShipFromMaintenanceContainer and reads options.launchAnchorEntity, launch offset 275 m with the formula "
    + "of boardAnchor; SPACE_BOARDING_RANGE_METERS 6550; ShipService._testing.getActiveAbyssalShipSwapRestriction; "
    + "isShipDeathPending exported", () => {
    const ship = src("services/ship/shipService.js");
    const board = ship.slice(ship.indexOf("\n  Handle_Board(args, session, kwargs) {"));
    assert.ok(board.length < ship.length, "BF1: Handle_Board");
    const body = board.slice(0, board.indexOf("\n  }\n"));
    has(body, "const shipID = args && args.length > 0 ? args[0] : null;", "BF1 args[0]");
    has(body, "const transitionResult = boardSpaceShip(session, shipID, { abandonCurrentHull: true });", "BF1 board");
    has(fs.readFileSync(path.join(__dirname, "..", "..", "lib", "adapter", "vendor.js"), "utf8"),
      "transitions.boardSpaceShip(session, shipItemId, { abandonCurrentHull: true });", "BF1 server board = Handle_Board");
    has(block(src("space/transitions.js"),
      "\nfunction boardSpaceShip(session, shipID, { abandonCurrentHull = false } = {}) {", "BF1"),
    "    } else if (abandonCurrentHull) {\n      settleAbandonedShipStructure(session, scene, abandonedCurrentEntity, "
      + "currentShip);", "BF1 abandoned hull");
    has(body, "assertAbyssalShipSwapAllowed(session, \"board_space_ship\");", "BF1 abyssal action");
    has(ship, "\nShipService._testing = {\n  assertAbyssalShipSwapAllowed,\n  getActiveAbyssalShipSwapRestriction,\n};",
      "BF1 _testing");
    const eject = src("services/ship/ejectRuntime.js");
    has(eject, "\nconst DEFAULT_LAUNCH_OFFSET_METERS = 275;", "BF1 offset");
    has(block(eject, "\nfunction launchShipFromMaintenanceContainer(session, sourceLocationID, itemID, options = {}) {",
      "BF1"), "const launchAnchorEntity = options.launchAnchorEntity || context.sourceEntity;", "BF1 anchor");
    const near = block(eject, "\nfunction buildLaunchStateNearSource(sourceEntity, offsetMeters = "
      + "DEFAULT_LAUNCH_OFFSET_METERS) {", "BF1");
    for (const needle of ["sourceRadius + Math.max(50, toFiniteNumber(offsetMeters, DEFAULT_LAUNCH_OFFSET_METERS)),",
      "...buildChildEntityScopeMetadata(sourceEntity),", "scaleVector(direction, offset),"]) has(near, needle, "BF1");
    has(block(eject, "\nmodule.exports = {", "BF1"), "\n  launchShipFromMaintenanceContainer,", "BF1 export");
    has(src("space/transitions.js"), "\nconst SPACE_BOARDING_RANGE_METERS = 6550;", "BF1 range");
    const death = src("services/ship/breacherPodDeathRuntime.js");
    assert.ok(/\nmodule\.exports = \{[^}]*\bisShipDeathPending \};/.test(death), "BF1 isShipDeathPending export");
  });

  test("BF1b (board) boardSpaceShip refuses a pursued pilot through getShipChangePursuitError(scene, currentEntity, "
    + "\"board\") with CONCORD_PURSUIT_ACTIVE / FACTION_POLICE_PURSUIT_ACTIVE; Handle_Board shows the texts the "
    + "mod copies", () => {
    has(block(src("space/transitions.js"),
      "\nfunction boardSpaceShip(session, shipID, { abandonCurrentHull = false } = {}) {", "BF1b"),
    "const pursuitError = getShipChangePursuitError(scene, currentEntity, \"board\");", "BF1b board check");
    const pursuit = src("services/security/shipPursuit.js");
    has(pursuit, "\nfunction getShipChangePursuitError(scene, ship, operation) {", "BF1b signature");
    has(pursuit, "\nmodule.exports = { getShipChangePursuitError };", "BF1b export");
    for (const code of ["CONCORD_PURSUIT_ACTIVE", "FACTION_POLICE_PURSUIT_ACTIVE"]) has(pursuit, `"${code}"`, "BF1b");
    const ship = src("services/ship/shipService.js");
    for (const text of ["You cannot board another ship while CONCORD is pursuing you.",
      "You cannot board another ship while faction police are pursuing you."]) has(ship, text, "BF1b text");
  });

  test("BF2 (board) the client greys Board Ship on a twin: a ship ball with pilotCharacterID > 0 is "
    + "interactive (ShipAlreadyPiloted); the server-started board: boardSpaceShip is exported, the vendor `/ship` "
    + "path calls it outside any Board RPC, it disembarks the old ship and pushes the session change itself", () => {
    const ball = block(src("space/destiny/stream/ballEncoding.js"), "\nfunction isFreeBallInteractive(entity) {", "BF2");
    has(ball, "hasPositiveIdentity(entity.pilotCharacterID ?? entity.characterID)", "BF2 interactive pilot");
    has(src("space/runtime/shipEntity.js"), "celestialCheckers.OfferBoardShip then hides", "BF2 client check");
    const transitions = src("space/transitions.js");
    has(block(transitions, "\nmodule.exports = {", "BF2"), "\n  boardSpaceShip,", "BF2 export");
    const board = block(transitions, "\nfunction boardSpaceShip(session, shipID, { abandonCurrentHull = false } = {}) {",
      "BF2");
    for (const needle of ["const abandonedCurrentEntity = spaceRuntime.disembarkSession(session, {",
      "flushSameSceneShipSwapNotificationPlan(session, applyResult.notificationPlan);",
      "scene.presentSameSceneShipSwap(session);"]) has(board, needle, "BF2 board");
    has(src("services/ship/spaceShipSwapRuntime.js"), "const boardResult = boardSpaceShip(session, shipItem.itemID);",
      "BF2 server-started board");
  });

  test("BF3 (board-twin-left-in-space) observers get the RemoveBalls of an unregistered "
    + "ball at the next bubble update; the scene mixins getKnownGridBubbleIDForSession / queueCharacterHistory; "
    + "buildRemoveBallsPayload exported; scoopShipIntoActiveShipMaintenanceBay exported with TARGET_TOO_FAR; "
    + "Handle_ScoopToSMA calls it; runtime IDs are monotonic from 4.2e15 (the ghost proof)", () => {
    has(src("space/runtime/scene/dynamicEntities.js"), "RemoveBalls at the next bubble update.", "BF3 deferred removal");
    const runtime = src("space/runtime.js");
    for (const mixin of ["visibility", "destinyHistory"]) has(runtime, `  require("./runtime/scene/${mixin}"),`, "BF3");
    has(src("space/runtime/scene/visibility.js"), "\ngetKnownGridBubbleIDForSession(session) {", "BF3 known bubble");
    const history = block(src("space/runtime/scene/destinyHistory.js"),
      "\nqueueCharacterHistory(session, updates, options = {}) {", "BF3");
    has(history, "    return null;", "BF3 null = no observer");
    has(history, "  return stamp;", "BF3 stamp");
    const actions = src("space/destiny/stream/actions.js");
    has(actions, "\nfunction buildRemoveBallsPayload(entityIDs) {", "BF3 payload");
    has(block(actions, "\nmodule.exports = {", "BF3"), "\n  buildRemoveBallsPayload,", "BF3 payload export");
    const eject = src("services/ship/ejectRuntime.js");
    const scoop = block(eject, "\nfunction scoopShipIntoActiveShipMaintenanceBay(session, targetShipID) {", "BF3");
    has(scoop, "return { success: false, errorMsg: \"TARGET_TOO_FAR\" };", "BF3 too far");
    has(scoop, "return { success: false, errorMsg: \"SHIP_NOT_FOUND\" };", "BF3 not an item (a twin, a ghost)");
    has(scoop, "{ removeEntity: true },", "BF3 the scoop removes the ball");
    has(block(eject, "\nmodule.exports = {", "BF3"), "\n  scoopShipIntoActiveShipMaintenanceBay,", "BF3 export");
    const ship = src("services/ship/shipService.js");
    has(ship, "\n  Handle_ScoopToSMA(args, session, kwargs) {", "BF3 handler");
    has(ship, "const result = scoopShipIntoActiveShipMaintenanceBay(session, objectID);", "BF3 handler call");
    has(src("space/runtime/state.js"), "const SYNTHETIC_RUNTIME_ENTITY_ID_START = 4_200_000_000_000_000;", "BF3 start");
    has(src("space/runtime/runtimeEntityIdentity.js"), "state.nextRuntimeEntityID += 1;", "BF3 monotonic");
  });

  test("OF-F1 (mining cargo overflow) the player's jetcan: content flag 0 and a 2 h life (= the config "
    + "default); cargoLootAuthority exports type 23 and flag 0; spawnDynamicInventoryEntity(systemID, itemID, options); "
    + "createSpaceItemForCharacter gives the item in data; the sessionless drone jetcan removes a can it could not "
    + "spawn", () => {
    const jet = src("services/ship/jettisonRuntime.js");
    has(jet, "\nconst JETCAN_CONTENT_FLAG_ID = 0;", "OF-F1 content flag");
    has(jet, "\nconst JETCAN_LIFETIME_MS = 2 * 60 * 60 * 1000;", "OF-F1 lifetime");
    has(jet, "\nconst JETCAN_CONTAINER_NAME = \"Cargo Container\";", "OF-F1 can name");
    const defaults = resolveConfig({ modDir: path.join(__dirname, "..", ".."), env: {} }).config;
    assert.strictEqual(defaults.miningOverflowCanLifetimeMs, 2 * 60 * 60 * 1000, "OF-F1 config default = vendor");
    const loot = src("services/inventory/cargoLootAuthority.js");
    for (const needle of ["\nconst DISPOSABLE_JETCAN_TYPE_ID = 23;", "\nconst SPACE_CONTAINER_FLAG_ID = 0;",
      "\n  DISPOSABLE_JETCAN_TYPE_ID,", "\n  SPACE_CONTAINER_FLAG_ID,"]) has(loot, needle, "OF-F1 cargoLootAuthority");
    has(src("space/runtime/spaceRuntime/dynamicEntities.js"), "\nspawnDynamicInventoryEntity(systemID, itemID, options",
      "OF-F1 spawn");
    const create = block(src("services/inventory/itemStore.js"),
      "\nfunction createSpaceItemForCharacter(charId, solarSystemId, itemType, options = {}) {", "OF-F1");
    has(create, "data: createResult.data.items[0] || null,", "OF-F1 create result");
    const drone = block(src("services/drone/droneRuntime.js"),
      "\nfunction jettisonDroneSalvage(scene, droneEntity, now, launcherID = 0) {", "OF-F1");
    for (const needle of ["...buildChildEntityScopeMetadata(droneEntity),", "broadcastOptions: { freshAcquire: true },",
      "removeInventoryItem(containerID, { removeContents: true });"]) has(drone, needle, "OF-F1 drone jetcan");
  });

  test("RC-F1 itemStore exports grantItemsToCharacterLocation, ITEM_FLAGS has "
    + "CARGO_HOLD 5 and SHIP_HANGAR 90; buildShipResourceState sets cargoCapacity; ejectRuntime checks the contents "
    + "of a ship only when it stores or boards it from the bay, never when it launches it", () => {
    const store = src("services/inventory/itemStore.js");
    const flags = block(store, "\nconst ITEM_FLAGS = {", "RC-F1");
    has(flags, "\n  CARGO_HOLD: 5,", "RC-F1 cargo");
    has(flags, "\n  SHIP_HANGAR: 90,", "RC-F1 ship hangar");
    has(store, "\nfunction grantItemsToCharacterLocation(", "RC-F1");
    for (const name of ["grantItemsToCharacterLocation", "ITEM_FLAGS"]) has(store, `\n  ${name},`, "RC-F1 export");
    has(src("services/fitting/liveFittingState.js"), "resourceState.cargoCapacity = ", "RC-F1 cargoCapacity");
    const eject = src("services/ship/ejectRuntime.js");
    const callers = [];
    for (const m of eject.matchAll(/\nfunction (\w+)\(/g)) {
      const body = block(eject, `\nfunction ${m[1]}(`, "RC-F1");
      if (body.includes("validateShipAndContentsForMaintenanceSource(")
        && m[1] !== "validateShipAndContentsForMaintenanceSource") callers.push(m[1]);
    }
    assert.deepStrictEqual(callers.sort(), ["boardStoredShipFromMaintenanceContainer",
      "storeActiveShipInMaintenanceContainer", "storeShipRecordInMaintenanceSource"], "RC-F1 callers");
    const launch = block(eject, "\nfunction launchShipFromMaintenanceContainer(", "RC-F1");
    assert.ok(!launch.includes("validateShipAndContentsForMaintenanceSource"), "RC-F1 launch checks no contents");
  });

  test("CG-F1 moveItemToLocation(itemId, location, flag, quantity = null): one "
    + "mutation plan, one commit (a failed write = WRITE_ERROR, nothing moved); a part = a new stack with a new ID, "
    + "the whole stack keeps its ID; MINING_SHIP_BAY_FLAGS exported; ITEM_FLAGS FLEET_HANGAR 155", () => {
    const store = src("services/inventory/itemStore.js");
    const head = "\nfunction moveItemToLocation(\n  itemId,\n  destinationLocationId,\n  destinationFlagId,\n"
      + "  quantity = null,\n";
    const at = store.indexOf(head);
    assert.ok(at >= 0, "CG-F1 signature");
    const moveFn = store.slice(at, store.indexOf("\nfunction ", at + head.length));
    assert.strictEqual(moveFn.split("mutationPlan.commit(").length - 1, 1, "CG-F1 one commit");
    has(moveFn, "errorMsg: \"WRITE_ERROR\"", "CG-F1 failed commit");
    const stageAt = store.indexOf("\nfunction stageItemMoveToLocation(");
    assert.ok(stageAt >= 0, "CG-F1 stage");
    const stage = store.slice(stageAt, store.indexOf("\nfunction ", stageAt + 1));
    has(stage, "const movingWholeItem = currentItem.singleton === 1 || moveQuantity === availableQuantity;", "CG-F1");
    has(stage, "itemID: nextItemID(currentItem.ownerID, items, characters[String(currentItem.ownerID)]),", "CG-F1");
    has(stage, "errorMsg: \"INSUFFICIENT_ITEMS\"", "CG-F1");
    has(store, "\n  moveItemToLocation,", "CG-F1 export");
    has(block(store, "\nconst ITEM_FLAGS = {", "CG-F1"), "\n  FLEET_HANGAR: 155,", "CG-F1 fleet hangar");
    const mining = src("services/mining/miningInventory.js");
    has(mining, "\nconst MINING_SHIP_BAY_FLAGS = Object.freeze(", "CG-F1");
    has(mining, "\n  MINING_SHIP_BAY_FLAGS,", "CG-F1 export");
  });

  test("CG-STF shipMaintenanceBayInventory exports the contents rule (type "
    + "list 11, rejectedItemIDs); the scoop gives it the whole ship (listContainerItems(null, ship), no flag); the "
    + "non-throwing CustomNotify shape of fitRefusalNotice", () => {
    const bay = src("services/inventory/shipMaintenanceBayInventory.js");
    has(bay, "\nconst ALLOWED_IN_SMA_CARGO_HOLDS_TYPE_LIST_ID = 11;", "CG-STF list 11");
    const rule = block(bay, "\nfunction validateShipMaintenanceBayContents(contents = []) {", "CG-STF");
    has(rule, "ALLOWED_IN_SMA_CARGO_HOLDS_TYPE_LIST_ID", "CG-STF rule");
    has(rule, "rejectedItemIDs: rejectedItems", "CG-STF rejected IDs");
    has(rule, "errorMsg: \"SHIP_MAINTENANCE_BAY_CARGO_RESTRICTED\"", "CG-STF");
    has(block(bay, "\nmodule.exports = {", "CG-STF"), "\n  validateShipMaintenanceBayContents,\n", "CG-STF export");
    const eject = src("services/ship/ejectRuntime.js");
    const validate = block(eject, "\nfunction validateShipAndContentsForMaintenanceSource(context, shipItem) {",
      "CG-STF");
    assert.match(validate, /contents: listContainerItems\(\s*null,\s*toInt\(shipItem && shipItem\.itemID, 0\),\s*\)/,
      "CG-STF the whole ship, no flag");
    const notice = src("services/inventory/invBroker/fitRefusalNotice.js");
    has(notice, "session.sendNotification(\"OnRemoteMessage\", \"clientID\", [\"CustomNotify\", {", "CG-STF notify");
    has(notice, "entries: [[\"notify\", { type: \"wstring\", value: text }]],", "CG-STF wstring");
  });

  test("F-E1..F-E9 hostile runtime: the 5 ship module effects and their families; the 4 exports "
    + "buildHostileModuleRuntimeCallbacks; the records never expire (expiresAtMs twice); a range failure returns "
    + "before the upsert; the record key reads only the source itemID; no crimewatch; career needs a ship item; "
    + "tackle: gateAligningWarps -> stopWarpScrambledAlign every destiny tick, beginNpcWarpToPoint refuses a "
    + "scrambled NPC, syncNpcWarpOff orders again after an interrupted align", () => {
    const hmr = src("space/modules/hostileModuleRuntime.js");
    const fn = (text, header, label) => {
      const at = text.indexOf(header);
      assert.ok(at >= 0, `${label}: ${header}`);
      return text.slice(at, text.indexOf("\nfunction ", at + 1));
    };
    for (const [name, base, family] of [["remotewebifierfalloff", "web", "HOSTILE_FAMILY_WEB"],
      ["warpscrambleblockmwdwithnpceffect", "scram", "HOSTILE_FAMILY_SCRAM"],
      ["warpdisrupt", "disrupt", "HOSTILE_FAMILY_DISRUPT"],
      ["energyneutralizerfalloff", "neut", "HOSTILE_FAMILY_NEUT"],
      ["energynosferatufalloff", "nos", "HOSTILE_FAMILY_NOS"]]) {
      has(block(hmr, "\nconst HOSTILE_EFFECT_DEFINITIONS_BY_NAME = Object.freeze({", "F-E1"),
        `\n  ${name}: BASE_HOSTILE_DEFINITIONS.${base},`, "F-E1");
      has(hmr, `\n  ${base}: Object.freeze({\n    family: ${family},`, "F-E1");
    }
    for (const [constant, value] of [["WEB", "stasisWebifier"], ["SCRAM", "warpScrambler"],
      ["DISRUPT", "warpDisruptor"], ["NEUT", "energyNeutralizer"], ["NOS", "energyNosferatu"]]) {
      has(hmr, `\nconst HOSTILE_FAMILY_${constant} = "${value}";`, "F-E1");
    }
    has(hmr, "return String(effectRecord && effectRecord.name || \"\").trim().toLowerCase();", "F-E1 lower case");
    const exported = hmr.slice(hmr.lastIndexOf("\nmodule.exports = {"));
    for (const name of ["resolveHostileDefinition", "resolveHostileModuleActivation", "executeHostileModuleCycle",
      "removeHostileModuleState"]) has(exported, `\n  ${name},`, "F-E2");
    const mrc = src("space/runtime/moduleRuntimeCallbacks.js");
    has(mrc, "\n  buildHostileModuleRuntimeCallbacks,", "F-E2 export");
    const cb = block(mrc, "\nfunction buildHostileModuleRuntimeCallbacks(scene = null) {", "F-E2");
    for (const field of ["\n    random() {", "\n    getEntityByID(entityID) {", "\n    isEntityLockedTarget,",
      "\n    getEntitySurfaceDistance(sourceEntity, targetEntity) {"]) has(cb, field, "F-E2 callbacks");
    assert.deepStrictEqual(hmr.split("\n").filter((l) => l.includes("expiresAtMs")).map((l) => l.trim()),
      ["expiresAtMs: Math.max(", "previousRecord.expiresAtMs !== record.expiresAtMs,"], "F-E3: two lines only");
    const refresh = fn(hmr, "\nfunction refreshHostileModuleState({", "F-E4");
    const failAt = refresh.indexOf("if (!rangeResult.success) {\n    return rangeResult;");
    const upsertAt = refresh.indexOf("upsertTargetHostileRecord(targetEntity, record)");
    assert.ok(failAt > 0 && upsertAt > failAt, "F-E4: range failure before the upsert");
    const remove = fn(hmr, "\nfunction removeTargetHostileRecord(targetEntity, sourceEntity, effectState) {", "F-E4");
    has(remove, "sourceEntity && sourceEntity.itemID,", "F-E4 key from the source itemID");
    has(fn(hmr, "\nfunction removeHostileModuleState({", "F-E4"),
      "removeTargetHostileRecord(targetEntity, sourceEntity, effectState);", "F-E4");
    assert.ok(!/crimewatch/i.test(hmr), "F-E5: no crimewatch in hostileModuleRuntime.js");
    has(block(src("services/inventory/careerCombatOutcomes.js"),
      "\nfunction eligible(source, target, state, playerTarget = false) {", "F-E6"),
    "items.findShipItemById(source.itemID)", "F-E6");
    const pilot = src("space/runtime/scene/pilotCommands.js");
    const scrambled = pilot.slice(pilot.indexOf("\nisShipWarpScrambled(entity) {"), pilot.indexOf("\n  },",
      pilot.indexOf("\nisShipWarpScrambled(entity) {")));
    has(scrambled, "hostileModuleRuntime.isEntityWarpScrambled(entity)", "F-E7");
    const gateAt = pilot.indexOf("\ngateAligningWarps() {");
    assert.ok(gateAt > 0, "F-E7: gateAligningWarps");
    has(pilot.slice(gateAt, pilot.indexOf("\n  },", gateAt)), "!this.stopWarpScrambledAlign(entity)", "F-E7");
    has(src("space/runtime/destinyTick.js"), "scene.gateAligningWarps();", "F-E7 destiny tick");
    const npc = src("space/npc/npcBehaviorLoop.js");
    has(fn(npc, "\nfunction beginNpcWarpToPoint(scene, entity, controller, destination, options = {}) {", "F-E8"),
      "hostileModuleRuntime.isEntityWarpScrambled(entity) === true", "F-E8");
    has(fn(npc, "\nfunction syncNpcWarpOff(scene, entity, controller, order) {", "F-E9"),
      "if (hasPendingNpcMovement(scene, entity)) return \"waiting\";\n    controller.warpOffOrdered = false;", "F-E9");
  });

  test("F-NOS1 (BUG nos-rr) hostileModuleRuntime: energynosferatufalloff is the nos definition; the "
    + "transfer amount is the attribute powerTransferAmount", () => {
    const hmr = src("space/modules/hostileModuleRuntime.js");
    has(hmr, "energynosferatufalloff: BASE_HOSTILE_DEFINITIONS.nos", "F-NOS1 effect");
    has(hmr, "getAttributeIDByNames(\"powerTransferAmount\")", "F-NOS1 attribute");
  });
};
