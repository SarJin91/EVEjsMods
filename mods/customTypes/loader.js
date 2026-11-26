"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const MOD_VERSION = "1.0.0";
const MOD_DIR = __dirname;
const DATA_DIR = path.join(MOD_DIR, "data");
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[customTypes]";
const INSTALL_FLAG = "__customTypesLoaderInstalled";
const API_SYMBOL = "evejs.customTypes";
const NO_INSTALL_ENV = "EVEJS_CUSTOMTYPES_NO_INSTALL";
const WRAPPED = Symbol.for("evejs.customTypes.wrapped");

const ITEM_TYPES_TABLE = "itemTypes";
const TYPE_DOGMA_TABLE = "typeDogma";
const BLUEPRINT_TABLE = "industryBlueprints";
const SHIP_TYPES_TABLE = "shipTypes";
const SHIP_DOGMA_TABLE = "shipDogmaAttributes";
const MOVEMENT_TABLE = "movementAttributes";
const SHIP_TABLES = Object.freeze([SHIP_TYPES_TABLE, SHIP_DOGMA_TABLE, MOVEMENT_TABLE]);
const PRE_READ_TABLES = Object.freeze([ITEM_TYPES_TABLE, SHIP_TYPES_TABLE, MOVEMENT_TABLE]);
const WORLD_ROLE = "world";

const TARGETS = Object.freeze({
  reference: "server/src/services/_shared/referenceData.js",
  industry: "server/src/services/industry/industryStaticData.js",
  store: "server/src/gameStore/index.js",
  jsonReader: "server/src/services/_shared/staticJsonTableReader.js",
  bootstrap: "server/bootstrap.js",
  items: "server/src/services/inventory/itemStore.js",
  payloads: "server/src/services/industry/industryPayloads.js",
  runtimeState: "server/src/services/industry/industryRuntimeState.js",
  monitor: "server/src/services/industry/industryMonitorService.js",
});

const REFERENCE_METHODS = Object.freeze({
  store: Object.freeze(["read", "tableExists"]),
  jsonReader: Object.freeze(["readStaticJsonTable"]),
  items: Object.freeze(["listItemsMatching", "removeInventoryItem"]),
  payloads: Object.freeze(["parseIndustryRequest"]),
  runtimeState: Object.freeze(["getBlueprintByItemID"]),
});
const TRACE_KINDS = Object.freeze(["payloads", "runtimeState", "monitor"]);

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message, error = null) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (error && error.stack) console.error(error.stack);
}

function exportHas(value, property, expectedType) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  if (!Object.prototype.hasOwnProperty.call(value, property)) return false;
  return typeof value[property] === expectedType;
}

function isEmptyExports(exports) {
  return !exports || (typeof exports === "object" && Object.keys(exports).length === 0);
}

function canonicalize(filename) {
  const resolved = path.resolve(String(filename || ""));
  let canonical;
  try {
    canonical = (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch (_error) {
    canonical = resolved;
  }
  if (process.platform === "win32") {
    return path.win32.normalize(canonical.replace(/\//gu, "\\")).toLowerCase();
  }
  return path.posix.normalize(canonical.replace(/\\/gu, "/"));
}

function createRuntime({
  config, entries, logFn = log, logErrorFn = logError, environment = process.env, runtimeRoot = RUNTIME_ROOT,
  shopEnabled = false, makeShopVendor = null, makeShopRunner = null, traceEnabled = false, now = Date.now,
  shipsDrift = false,
}) {
  const packLib = require("./lib/pack");
  const inject = require("./lib/inject");
  const state = {
    inert: false, referenceWrapped: false, bootWrapped: false, deciding: false, plan: null, vanillaTypeIDs: null,
    shopRunner: null, monitorWrapped: false, storeWrapped: false, industryExports: null,
  };
  let shopVendor = null;
  function vendorOf() {
    if (!shopVendor) {
      shopVendor = makeShopVendor
        ? makeShopVendor()
        : require("./lib/shop/vendor").createShopVendor({ runtimeRoot,
          liveContractRead: Boolean(config.shop && config.shop.liveContractRead === true) });
    }
    return shopVendor;
  }
  const stats = {
    itemTypePayloads: 0, typesAdded: 0, dogmaAdded: 0, definitionsAdded: 0, failures: 0, removed: 0,
    skippedWithContents: 0, shipRowsAdded: 0, movementRowsAdded: 0, shipDogmaAdded: 0,
  };
  const deps = {
    store: null, jsonReader: null, items: null, readItemTypes: null, industry: null, payloads: null, runtimeState: null,
    readTableRaw: null,
  };
  const marked = new WeakSet();
  let trace = null;
  let traceBlueprintIDs = null;

  function drift(symbol) {
    state.inert = true;
    logErrorFn(`DRIFT ${symbol} - mod inert, no custom types`);
    return { ok: false, reason: "drift" };
  }

  function failure(where, error) {
    stats.failures += 1;
    if (stats.failures <= 3) logErrorFn(`${where} failed - ignored`, error);
  }

  function readBlueprintDefinitions() {
    const store = deps.store;
    if (store && store.tableExists(BLUEPRINT_TABLE)) {
      const result = store.read(BLUEPRINT_TABLE, "/");
      if (result && result.success && result.data && Array.isArray(result.data.blueprintDefinitions)) {
        return result.data.blueprintDefinitions;
      }
    }
    if (deps.jsonReader) {
      const result = deps.jsonReader.readStaticJsonTable(BLUEPRINT_TABLE);
      if (result && result.success && result.data && Array.isArray(result.data.blueprintDefinitions)) {
        return result.data.blueprintDefinitions;
      }
    }
    return null;
  }

  function typeDogmaFacts() {
    let payload;
    const read = () => {
      if (payload === undefined) {
        let raw = null;
        try {
          raw = deps.readTableRaw ? deps.readTableRaw(TYPE_DOGMA_TABLE) : null;
        } catch (error) {
          failure("typeDogma read for the pack plan", error);
        }
        payload = raw && typeof raw === "object" && raw.typesByTypeID && typeof raw.typesByTypeID === "object" ? raw : null;
      }
      return payload;
    };
    return {
      dogmaOf: (typeID) => {
        const table = read();
        if (!table) return undefined;
        const record = table.typesByTypeID[String(typeID)];
        return record && typeof record === "object" ? record : null;
      },
      attributeNameOf: (attributeID) => {
        const table = read();
        const types = table && table.attributeTypesByID;
        const row = types && typeof types === "object" ? types[String(attributeID)] : null;
        return row && typeof row.name === "string" ? row.name : null;
      },
    };
  }

  function decide(itemTypeRows) {
    if (state.plan) return state.plan;
    state.vanillaTypeIDs = new Set();
    for (const row of itemTypeRows || []) {
      const typeID = Number(row && row.typeID);
      if (Number.isSafeInteger(typeID) && typeID > 0) state.vanillaTypeIDs.add(typeID);
    }
    const dogma = typeDogmaFacts();
    const plan = packLib.buildPlan(entries, {
      itemTypeRows, blueprintDefinitions: readBlueprintDefinitions(), ...dogma, shipTablesDrift: shipsDrift === true,
    });
    state.plan = plan;
    for (const pack of plan.packs) {
      const ships = pack.shipTypeIDs.length > 0 ? ` (${pack.shipTypeIDs.length} ships)` : "";
      const icons = pack.iconIDs.length > 0 ? `, ${pack.iconIDs.length} icons` : "";
      logFn(`pack ${pack.packID}: ${pack.typeRows.length} types${ships}, ${pack.definitions.length} blueprints${icons}`);
    }
    for (const refusal of plan.rejected) {
      logErrorFn(`pack ${refusal.packID} (${refusal.file}) refused: ${refusal.reason} - whole pack skipped`);
    }
    return plan;
  }

  function ensurePlan() {
    if (state.plan) return state.plan;
    if (!deps.readItemTypes) return null;
    if (!state.deciding) {
      state.deciding = true;
      try {
        deps.readItemTypes();
      } finally {
        state.deciding = false;
      }
    }
    return state.plan || decide([]);
  }

  function onItemTypes(payload) {
    if (!payload || typeof payload !== "object" || marked.has(payload)) return;
    marked.add(payload);
    const rows = Array.isArray(payload.types)
      ? payload.types
      : (payload.types && typeof payload.types === "object" ? Object.values(payload.types) : []);
    const plan = decide(rows);
    stats.itemTypePayloads += 1;
    for (const pack of plan.packs) {
      const result = inject.injectItemTypeRows(payload, pack.typeRows);
      if (result.ok) stats.typesAdded += result.added;
    }
  }

  function onTypeDogma(payload) {
    if (!payload || typeof payload !== "object" || marked.has(payload)) return;
    const plan = ensurePlan();
    if (!plan) return;
    marked.add(payload);
    for (const pack of plan.packs) {
      const result = inject.injectTypeDogma(payload, pack.sources);
      if (result.ok) stats.dogmaAdded += result.added;
    }
  }

  function onShipTable(tableName, payload) {
    if (!payload || typeof payload !== "object" || marked.has(payload)) return;
    const plan = ensurePlan();
    if (!plan) return;
    marked.add(payload);
    for (const pack of plan.packs) {
      if (!Array.isArray(pack.ships) || pack.ships.length === 0) continue;
      if (tableName === SHIP_TYPES_TABLE) {
        const shipIDs = new Set(pack.shipTypeIDs);
        const result = inject.injectShipTypeRows(payload, pack.typeRows.filter((row) => shipIDs.has(row.typeID)));
        if (result.ok) stats.shipRowsAdded += result.added;
      } else if (tableName === SHIP_DOGMA_TABLE) {
        const result = inject.injectShipDogma(payload, pack.ships);
        if (result.ok) stats.shipDogmaAdded += result.added;
      } else {
        const result = inject.injectMovementRows(payload, pack.ships);
        if (result.ok) stats.movementRowsAdded += result.added;
      }
    }
  }

  function observeTable(tableName, payload) {
    try {
      if (tableName === ITEM_TYPES_TABLE) onItemTypes(payload);
      else if (tableName === TYPE_DOGMA_TABLE) onTypeDogma(payload);
      else if (SHIP_TABLES.includes(tableName)) onShipTable(tableName, payload);
    } catch (error) {
      failure(`custom rows for ${tableName}`, error);
    }
  }

  function applyReference(exports) {
    if (state.referenceWrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (isEmptyExports(exports)) return { ok: false, reason: "pending" };
    if (!exportHas(exports, "readStaticTable", "function")) return drift("referenceData.readStaticTable");
    if (!exportHas(exports, "readStaticRows", "function")) return drift("referenceData.readStaticRows");
    const previousTable = exports.readStaticTable;
    const previousRows = exports.readStaticRows;
    if (previousTable[WRAPPED] && previousRows[WRAPPED]) {
      state.referenceWrapped = true;
      return { ok: true };
    }
    const wrappedTable = function readStaticTable(tableName) {
      const payload = previousTable.apply(this, arguments);
      if (!state.inert) observeTable(tableName, payload);
      return payload;
    };
    const wrappedRows = function readStaticRows(tableName) {
      if (!state.inert && PRE_READ_TABLES.includes(tableName)) {
        try {
          wrappedTable(tableName);
        } catch (error) {
          failure(`${tableName} pre-read`, error);
        }
      }
      return previousRows.apply(this, arguments);
    };
    Object.defineProperty(wrappedTable, WRAPPED, { value: true });
    Object.defineProperty(wrappedRows, WRAPPED, { value: true });
    exports.readStaticTable = wrappedTable;
    exports.readStaticRows = wrappedRows;
    deps.readItemTypes = () => wrappedTable(ITEM_TYPES_TABLE);
    deps.readTableRaw = (tableName) => previousTable.call(exports, tableName);
    state.referenceWrapped = true;
    logFn(`v${MOD_VERSION} active - wrapped referenceData.readStaticTable/readStaticRows (probe ok)`);
    return { ok: true };
  }

  function injectBlueprints(exports, plan, suffix = "") {
    const definitions = plan.packs.flatMap((pack) => pack.definitions);
    if (definitions.length === 0) return { ok: true };
    const store = deps.store;
    const result = store ? store.read(BLUEPRINT_TABLE, "/") : null;
    if (!result || !result.success || !result.data) {
      logErrorFn(`${BLUEPRINT_TABLE} not readable through gameStore - custom blueprints not added`);
      return { ok: false, reason: "no-table" };
    }
    if (!marked.has(result.data)) {
      const added = inject.injectBlueprintDefinitions(result.data, definitions);
      if (!added.ok) {
        logErrorFn(`${added.reason} - custom blueprints not added`);
        return { ok: false, reason: "bad-table" };
      }
      marked.add(result.data);
      if (!suffix) stats.definitionsAdded += added.added;
      logFn(`${BLUEPRINT_TABLE}: +${added.added} custom blueprint definitions${suffix}`);
    }
    exports.clearIndustryStaticCaches();
    return { ok: true };
  }

  function applyIndustry(exports) {
    if (state.inert) return { ok: false, reason: "inert" };
    if (isEmptyExports(exports)) return { ok: false, reason: "pending" };
    if (!exportHas(exports, "clearIndustryStaticCaches", "function")) {
      return drift("industryStaticData.clearIndustryStaticCaches");
    }
    if (exportHas(exports, "getBlueprintDefinitionByTypeID", "function")) deps.industry = exports;
    try {
      const plan = ensurePlan();
      if (!plan) return { ok: false, reason: "pending" };
      const result = injectBlueprints(exports, plan);
      if (result.ok) state.industryExports = exports;
      return result;
    } catch (error) {
      failure("custom blueprint definitions", error);
      return { ok: false, reason: "exception" };
    }
  }

  function reapplyAfterPreload() {
    if (state.inert || !state.industryExports || !state.plan) return;
    try {
      injectBlueprints(state.industryExports, state.plan, " (again after gameStore.preloadAll)");
    } catch (error) {
      failure("custom blueprint definitions after gameStore.preloadAll", error);
    }
  }

  function applyStore(exports) {
    const captured = applyReferenceDeps("store", exports);
    if (!captured.ok || state.storeWrapped) return captured;
    state.storeWrapped = true;
    if (!exportHas(exports, "preloadAll", "function")) return captured;
    const previous = exports.preloadAll;
    if (previous[WRAPPED]) return captured;
    const wrapped = function preloadAll() {
      const result = previous.apply(this, arguments);
      reapplyAfterPreload();
      return result;
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    exports.preloadAll = wrapped;
    return captured;
  }

  function cleanupTypeIDs(plan) {
    const ids = new Set();
    const vanilla = state.vanillaTypeIDs || new Set();
    for (const pack of plan.packs) {
      for (const row of pack.typeRows) {
        const typeID = row && row.typeID;
        if (!Number.isSafeInteger(typeID) || typeID < packLib.TYPE_ID_MIN || typeID > packLib.TYPE_ID_MAX) continue;
        if (vanilla.has(typeID)) {
          logErrorFn(`CLEANUP: type ${typeID} (pack ${pack.packID}) exists in vanilla itemTypes - not removed`);
          continue;
        }
        ids.add(typeID);
      }
    }
    return ids;
  }

  function processRoles() {
    const envRole = environment.EVEJS_GAMESTORE_OWNER_ROLE;
    const processRole = deps.store && typeof deps.store._processRole === "string" ? deps.store._processRole : undefined;
    return { envRole, processRole, world: envRole === WORLD_ROLE && processRole === WORLD_ROLE };
  }

  function runCleanup() {
    const { envRole, processRole, world } = processRoles();
    if (!world) {
      logFn(`CLEANUP skipped in this process (env role ${envRole || "unset"}, gameStore role ${processRole || "unknown"})`);
      return { ok: false, reason: "not-world" };
    }
    if (!deps.items) {
      logErrorFn("CLEANUP: itemStore not loaded - nothing removed");
      return { ok: false, reason: "no-item-store" };
    }
    const plan = ensurePlan();
    if (!plan) {
      logErrorFn("CLEANUP: no pack plan (referenceData not loaded) - nothing removed");
      return { ok: false, reason: "no-plan" };
    }
    if (!state.vanillaTypeIDs || state.vanillaTypeIDs.size === 0) {
      logErrorFn("CLEANUP refused: vanilla itemTypes rows were not read - nothing removed");
      return { ok: false, reason: "no-vanilla-rows" };
    }
    const typeIDs = cleanupTypeIDs(plan);
    const guard = vendorOf().countOutstandingHolding(typeIDs);
    if (!guard.ok) {
      logErrorFn(`CLEANUP refused: contracts not readable (${guard.reason}) - nothing removed`);
      return { ok: false, reason: "contracts-unreadable" };
    }
    if (guard.count > 0) {
      const outstanding = guard.outstanding ?? (guard.count - (guard.inProgress ?? 0));
      const inProgress = guard.inProgress ?? 0;
      if (outstanding > 0) {
        logErrorFn(`CLEANUP refused: ${outstanding} outstanding contracts hold custom types - `
          + "set EVEJS_CUSTOMTYPES_SHOP_DELIST=1 first");
      }
      if (inProgress > 0) {
        logErrorFn(`CLEANUP refused: ${inProgress} courier contracts in progress carry custom types - `
          + "wait until the courier contracts finish");
      }
      return { ok: false, reason: "contracts-outstanding", count: guard.count, outstanding, inProgress };
    }
    const occupiedLocations = new Set();
    const victims = deps.items.listItemsMatching((item) => {
      if (!item) return false;
      const locationID = Number(item.locationID);
      if (Number.isSafeInteger(locationID) && locationID > 0) occupiedLocations.add(locationID);
      return typeIDs.has(Number(item.typeID ?? item.shipTypeID));
    });
    let failed = 0;
    for (const item of victims) {
      const itemID = Number(item.itemID ?? item.shipID);
      if (occupiedLocations.has(itemID)) {
        stats.skippedWithContents += 1;
        logFn(`CLEANUP: item ${itemID} (type ${item.typeID ?? item.shipTypeID}) has contents - skipped, not removed`);
        continue;
      }
      const result = deps.items.removeInventoryItem(itemID);
      if (result && result.success) stats.removed += 1;
      else failed += 1;
    }
    logFn(`CLEANUP removed ${stats.removed} items of ${typeIDs.size} custom types `
      + `(${failed} failed, ${stats.skippedWithContents} skipped with contents)`);
    return { ok: true, removed: stats.removed, failed, skippedWithContents: stats.skippedWithContents };
  }

  function startShop() {
    if (!shopEnabled || state.shopRunner) return { ok: false, reason: state.shopRunner ? "started" : "off" };
    if (!processRoles().world) return { ok: false, reason: "not-world" };
    const { buildCatalog } = require("./lib/shop/catalog");
    const factory = makeShopRunner || require("./lib/shop/runner").createShopRunner;
    state.shopRunner = factory({
      cfg: config.shop,
      vendor: vendorOf(),
      catalogOf: () => buildCatalog(ensurePlan(), config.shop),
      log: logFn,
      logError: logErrorFn,
    });
    return state.shopRunner.start();
  }

  function applyBootstrap(exports) {
    if (state.bootWrapped) return { ok: true };
    if (isEmptyExports(exports)) return { ok: false, reason: "pending" };
    if (!exportHas(exports, "bootWorld", "function")) {
      logErrorFn("DRIFT bootstrap.bootWorld - CLEANUP and blueprint shop not available");
      state.bootWrapped = true;
      return { ok: false, reason: "drift" };
    }
    const previous = exports.bootWorld;
    if (!previous[WRAPPED]) {
      const wrapped = function bootWorld() {
        const result = previous.apply(this, arguments);
        Promise.resolve(result).then(() => {
          if (config.cleanup) {
            try {
              runCleanup();
            } catch (error) {
              failure("CLEANUP", error);
            }
          }
          try {
            startShop();
          } catch (error) {
            failure("blueprint shop start", error);
          }
        }, () => {});
        return result;
      };
      Object.defineProperty(wrapped, WRAPPED, { value: true });
      exports.bootWorld = wrapped;
    }
    state.bootWrapped = true;
    return { ok: true };
  }

  function packBlueprintTypeIDs() {
    if (!state.plan) return null;
    if (!traceBlueprintIDs) {
      traceBlueprintIDs = new Set(state.plan.packs.flatMap((pack) => pack.definitions)
        .map((definition) => Number(definition && definition.blueprintTypeID))
        .filter((typeID) => Number.isSafeInteger(typeID) && typeID > 0));
    }
    return traceBlueprintIDs;
  }

  function applyMonitor(exports) {
    if (state.monitorWrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (isEmptyExports(exports)) return { ok: false, reason: "pending" };
    const proto = typeof exports === "function" ? exports.prototype : null;
    if (!proto || typeof proto.Handle_ConnectJob !== "function") {
      state.monitorWrapped = true;
      logErrorFn("DRIFT industryMonitorService.Handle_ConnectJob - ConnectJob trace off (custom types unaffected)");
      return { ok: false, reason: "drift" };
    }
    const previous = proto.Handle_ConnectJob;
    if (!previous[WRAPPED]) {
      trace = require("./lib/connectJobTrace").createConnectJobTrace({
        deps: {
          blueprintTypeIDs: packBlueprintTypeIDs,
          parseRequest: (raw) => (deps.payloads ? deps.payloads.parseIndustryRequest(raw) : null),
          getBlueprint: (itemID) => (deps.runtimeState ? deps.runtimeState.getBlueprintByItemID(itemID) : null),
          getDefinition: (typeID) => (deps.industry ? deps.industry.getBlueprintDefinitionByTypeID(typeID) : null),
        },
        windowMinutes: config.trace && config.trace.windowMinutes,
        now,
        logFn,
        onFailure: (error) => failure("ConnectJob trace", error),
      });
      const wrapped = trace.wrap(previous);
      Object.defineProperty(wrapped, WRAPPED, { value: true });
      proto.Handle_ConnectJob = wrapped;
      logFn(`ConnectJob trace on - wrapped industryMonitor.Handle_ConnectJob (pack blueprints only, `
        + `1 line per character/blueprint/activity per ${config.trace.windowMinutes} min)`);
    }
    state.monitorWrapped = true;
    return { ok: true };
  }

  function applyReferenceDeps(kind, exports) {
    if (deps[kind]) return { ok: true };
    if (!REFERENCE_METHODS[kind].every((method) => exportHas(exports, method, "function"))) {
      return { ok: false, reason: "pending" };
    }
    deps[kind] = exports;
    return { ok: true };
  }

  function apply(kind, exports) {
    if (kind === "store") return applyStore(exports);
    if (kind === "reference") return applyReference(exports);
    if (kind === "industry") return applyIndustry(exports);
    if (kind === "bootstrap") return config.cleanup || shopEnabled ? applyBootstrap(exports) : { ok: true };
    if (kind === "items" && !config.cleanup) return { ok: true };
    if (TRACE_KINDS.includes(kind) && !traceEnabled) return { ok: true };
    if (kind === "monitor") return applyMonitor(exports);
    return applyReferenceDeps(kind, exports);
  }

  return {
    state, stats, deps, apply, applyStore, applyReference, applyIndustry, applyBootstrap, applyMonitor, ensurePlan, runCleanup,
    startShop, traceStats: () => (trace ? { ...trace.stats } : null),
  };
}

const APPLY_ORDER = Object.freeze([
  "store", "jsonReader", "items", "payloads", "runtimeState", "reference", "industry", "bootstrap", "monitor",
]);

function installModuleHook(runtime, runtimeRoot, logErrorFn = logError) {
  const targets = new Map(
    Object.entries(TARGETS).map(([kind, relative]) => [
      canonicalize(path.resolve(runtimeRoot, ...relative.split("/"))),
      kind,
    ]),
  );
  const pending = new Set(Object.keys(TARGETS));
  const identities = new Map();

  function apply(kind, exports) {
    const result = runtime.apply(kind, exports);
    if (result.ok || result.reason !== "pending") pending.delete(kind);
  }

  function kindOf(filename) {
    if (!identities.has(filename)) identities.set(filename, targets.get(canonicalize(filename)) || null);
    return identities.get(filename);
  }

  const cached = Object.keys(Module._cache)
    .map((filename) => ({ filename, kind: kindOf(filename) }))
    .filter((entry) => entry.kind && Module._cache[entry.filename])
    .sort((left, right) => APPLY_ORDER.indexOf(left.kind) - APPLY_ORDER.indexOf(right.kind));
  for (const entry of cached) apply(entry.kind, Module._cache[entry.filename].exports);

  const previousLoad = Module._load;
  function hookedLoad(request, parent, isMain) {
    const exports = previousLoad.apply(this, arguments);
    if (pending.size === 0 || runtime.state.inert) return exports;
    try {
      if (typeof request !== "string" || Module.isBuiltin(request)) return exports;
      const filename = Module._resolveFilename(request, parent, isMain);
      const kind = kindOf(filename);
      if (kind && pending.has(kind)) apply(kind, exports);
    } catch (error) {
      logErrorFn(`hook error on ${String(request)} - ignored`, error);
    }
    return exports;
  }
  Module._load = hookedLoad;
  return { hookedLoad, previousLoad, pending };
}

function install(options = {}) {
  if (!isMainThread) return { active: false, reason: "worker-thread" };
  if (globalThis[INSTALL_FLAG]) return { active: false, reason: "already-installed" };

  const runtimeRoot = path.resolve(options.runtimeRoot || RUNTIME_ROOT);
  const environment = options.environment || process.env;
  const logFn = options.logFn || log;
  const logErrorFn = options.logErrorFn || logError;
  const config = require("./config").load(MOD_DIR, environment);
  if (config.problems.length > 0) {
    for (const problem of config.problems) logErrorFn(problem);
    logErrorFn("invalid configuration - no hooks installed, no custom types");
    return { active: false, reason: "invalid-config", config };
  }
  if (!config.enabled) return { active: false, reason: "disabled", config };

  const viable = (options.inspect || require("./lib/viability").inspect)(runtimeRoot);
  if (!viable.ok) {
    for (const report of viable.reports.filter((entry) => !entry.ok)) {
      logErrorFn(`DRIFT ${report.key}: ${report.reason}`);
    }
    logErrorFn("viability probe failed - mod inert, no hooks installed, no custom types");
    return { active: false, reason: "not-viable", config, viable };
  }

  let shopEnabled = false;
  if (config.shopProblems.length > 0) {
    for (const problem of config.shopProblems) logErrorFn(problem);
    logErrorFn("shop off - invalid shop configuration (custom types and blueprints unaffected)");
  } else if (config.shop.enabled) {
    const shopViable = (options.inspectShop || require("./lib/viability").inspectShop)(runtimeRoot);
    if (shopViable.ok) {
      shopEnabled = true;
    } else {
      for (const report of shopViable.reports.filter((entry) => !entry.ok)) {
        logErrorFn(`DRIFT ${report.key}: ${report.reason}`);
      }
      logErrorFn("shop off - shop viability probe failed (custom types and blueprints unaffected)");
    }
  }

  let traceEnabled = false;
  if (config.traceProblems.length > 0) {
    for (const problem of config.traceProblems) logErrorFn(problem);
    logErrorFn("ConnectJob trace off - invalid trace configuration (custom types and blueprints unaffected)");
  } else if (config.trace.enabled) {
    const traceViable = (options.inspectMonitor || require("./lib/viability").inspectMonitor)(runtimeRoot);
    if (traceViable.ok) {
      traceEnabled = true;
    } else {
      for (const report of traceViable.reports.filter((entry) => !entry.ok)) {
        logErrorFn(`DRIFT ${report.key}: ${report.reason}`);
      }
      logErrorFn("ConnectJob trace off - trace viability probe failed (custom types and blueprints unaffected)");
    }
  }

  const shipsViable = (options.inspectShips || require("./lib/viability").inspectShips)(runtimeRoot);
  if (!shipsViable.ok) {
    for (const report of shipsViable.reports.filter((entry) => !entry.ok)) {
      logErrorFn(`DRIFT ${report.key}: ${report.reason}`);
    }
    logErrorFn("ship tables drift - packs with ships refused (other packs unaffected)");
  }

  const loaded = require("./lib/pack").loadPackFiles(options.dataDir || DATA_DIR);
  for (const problem of loaded.problems) logErrorFn(`${problem} - file skipped`);
  if (loaded.entries.length === 0) {
    logErrorFn("no data packs - no hooks installed, no custom types");
    return { active: false, reason: "no-packs", config };
  }

  const runtime = createRuntime({
    config, entries: loaded.entries, logFn, logErrorFn, environment, runtimeRoot, shopEnabled, traceEnabled,
    shipsDrift: !shipsViable.ok,
  });
  const hookState = installModuleHook(runtime, runtimeRoot, logErrorFn);
  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    stats: () => ({
      ...runtime.stats,
      inert: runtime.state.inert,
      planned: Boolean(runtime.state.plan),
      shop: runtime.state.shopRunner ? { ...runtime.state.shopRunner.stats } : null,
      connectJobTrace: runtime.traceStats(),
    }),
  });
  globalThis[Symbol.for(API_SYMBOL)] = api;
  const installState = Object.freeze({ active: true, api, config, runtimeRoot, runtime, hookState });
  globalThis[INSTALL_FLAG] = installState;
  return installState;
}

let installResult = null;
if (!process.env[NO_INSTALL_ENV]) {
  try {
    installResult = install();
  } catch (error) {
    logError("loader failed before activation - no custom types", error);
    installResult = { active: false, reason: "exception", error };
  }
}

module.exports = {
  API_SYMBOL,
  DATA_DIR,
  INSTALL_FLAG,
  MOD_DIR,
  MOD_VERSION,
  NO_INSTALL_ENV,
  RUNTIME_ROOT,
  TARGETS,
  WRAPPED,
  install,
  installResult,
  _testing: Object.freeze({ canonicalize, createRuntime, exportHas, installModuleHook }),
};
