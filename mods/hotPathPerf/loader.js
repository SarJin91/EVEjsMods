"use strict";

const Module = require("module");
const { isMainThread } = require("worker_threads");

const MOD_VERSION = "0.24.1";
const LOG_PREFIX = "[hotPathPerf]";
const INSTALL_FLAG = "__hotPathPerfLoaderInstalled";
const NO_INSTALL_ENV = "HOTPATH_NO_INSTALL";
const PROBE_DELAY_MS = 60000;

const TARGETS = Object.freeze({
  dungeonRuntime: "/services/dungeon/dungeonRuntime.js",
  dungeonRuntimeState: "/services/dungeon/dungeonRuntimeState.js",
  dungeonUniverse: "/services/dungeon/dungeonUniverseRuntime.js",
  cacheMgr: "/services/dungeon/dungeonInstanceCacheMgrService.js",
  configService: "/services/config/configService.js",
  spaceRuntime: "/space/runtime.js",
  sessionRegistry: "/services/chat/sessionRegistry.js",
  vendorConfig: "/config/index.js",
  gameStore: "/gameStore/index.js",
  sqliteStore: "/gameStore/sqliteStore.js",
  careerAbyssal: "/services/career/careerAbyssalSources.js",
  dungeonAuthority: "/services/dungeon/dungeonAuthority.js",
  itemStore: "/services/inventory/itemStore.js",
  miningRuntime: "/services/mining/miningRuntime.js",
  miningResourceSites: "/services/mining/miningResourceSiteService.js",
  structureState: "/services/structure/structureState.js",
  droneRuntime: "/services/drone/droneRuntime.js",
  industryRuntimeState: "/services/industry/industryRuntimeState.js",
  nativeNpcStore: "/space/npc/nativeNpcStore.js",
  globalConfig: "/services/machoNet/globalConfig.js",
  sovState: "/services/sovereignty/sovState.js",
  sovCaptureState: "/services/sovereignty/sovCaptureState.js",
  sovSuppressionState: "/services/sovereignty/sovSuppressionState.js",
  incursionPresentation: "/services/incursion/incursionPresentation.js",
  incursionLifecycleStore: "/services/incursion/incursionLifecycleStore.js",
  incursionLifecycle: "/services/incursion/incursionLifecycle.js",
  bountyProxy: "/services/bounty/bountyProxyService.js",
  playerBountyState: "/services/bounty/playerBountyState.js",
  characterState: "/services/character/characterState.js",
  careerStanding: "/services/career/careerStandingSources.js",
  corporationState: "/services/corporation/corporationState.js",
  reprocessingItemCustody: "/services/inventory/reprocessingItemCustody.js",
  reprocessingSettlement: "/services/reprocessing/reprocessingSettlementState.js",
  dungeonTrackingRuntime: "/services/dungeon/dungeonTrackingRuntime.js",
  dungeonSiteAdapter: "/services/dungeon/dungeonSiteAdapter.js",
});

const CACHE_MGR_HANDLERS = Object.freeze([
  "Handle_GetCombatAnomalyInstances",
  "Handle_GetCombatAnomaliesCount",
  "Handle_GetSignatureInstances",
  "Handle_GetIceBeltInstances",
  "Handle_GetIceBeltsCount",
  "Handle_GetOreAnomalyInstances",
  "Handle_GetOreAnomaliesCount",
  "Handle_GetOreAnomaliesCountInRange",
  "Handle_GetBulwarkMiningSiteCounts",
  "Handle_GetFactionWarfareInstances",
  "Handle_GetFactionWarfareBattlefieldInstances",
  "Handle_GetHomefrontSiteInstances",
  "Handle_GetPirateInsurgencyInstances",
  "Handle_GetPirateInsurgencyIceHeistInstances",
  "Handle_GetTriglavianSiteInstances",
]);

const POINTS = Object.freeze([
  { symbol: "dungeonUniverseRuntime.getUniversePersistentLifecycleBoundary", flag: "measureSchedulerBoundary", target: "dungeonUniverse", property: "getUniversePersistentLifecycleBoundary", holder: "exports" },
  ...CACHE_MGR_HANDLERS.map((method) => ({
    symbol: `DungeonInstanceCacheMgrService.${method}`, flag: "measureCacheMgrHandlers", target: "cacheMgr", property: method, holder: "classPrototype",
  })),
  { symbol: "dungeonRuntime.listInstancesByLifecycle", flag: "measureLifecycleLists", target: "dungeonRuntime", property: "listInstancesByLifecycle", holder: "exports" },
  { symbol: "SpaceRuntime.collectEmptySolarSystems", flag: "measureCollectEmptySolarSystems", target: "spaceRuntime", property: "collectEmptySolarSystems", holder: "exportsPrototype" },
  { symbol: "SpaceRuntime.prepareUniverseSitesForPlayerEntry", flag: "measurePrepareUniverseSites", target: "spaceRuntime", property: "prepareUniverseSitesForPlayerEntry", holder: "exportsPrototype" },
  { symbol: "SpaceRuntime.ensureScene", flag: "measureEnsureScene", target: "spaceRuntime", property: "ensureScene", holder: "exportsPrototype" },
  { symbol: "ConfigService.Handle_GetMultiLocationsEx", flag: "measureGetMultiLocations", target: "configService", property: "Handle_GetMultiLocationsEx", holder: "classPrototype" },
]);

const INDEX_POINTS = Object.freeze([
  { symbol: "dungeonRuntimeState#deps", target: "dungeonRuntimeState", kind: "deps" },
  { symbol: "dungeonRuntime.listInstancesByLifecycle#index", target: "dungeonRuntime", property: "listInstancesByLifecycle", holder: "exports", kind: "reader" },
  { symbol: "dungeonRuntime.listUniversePersistentTerminalInstances#index", target: "dungeonRuntime", property: "listUniversePersistentTerminalInstances", holder: "exports", kind: "terminalReader" },
  { symbol: "dungeonUniverseRuntime.getUniversePersistentLifecycleBoundary#scope", target: "dungeonUniverse", property: "getUniversePersistentLifecycleBoundary", holder: "exports", kind: "scope" },
  ...CACHE_MGR_HANDLERS.map((method) => ({
    symbol: `DungeonInstanceCacheMgrService.${method}#scope`, target: "cacheMgr", property: method, holder: "classPrototype", kind: "scope",
  })),
]);
const INDEX_SYMBOLS = new Set(INDEX_POINTS.map((p) => p.symbol));
const INDEX_REQUIRED = Object.freeze(["dungeonRuntimeState#deps", "dungeonRuntime.listInstancesByLifecycle#index"]);
const MOON_OVERLAY_MARKER = Symbol.for("evejs.moonOreAnomalies.presentationOverlay");

const RETENTION_POINTS = Object.freeze([
  { symbol: "SpaceRuntime.collectEmptySolarSystems#retention", target: "spaceRuntime", property: "collectEmptySolarSystems", holder: "exportsPrototype", kind: "retention" },
  { symbol: "sessionRegistry#deps", target: "sessionRegistry", kind: "deps" },
  { symbol: "config#deps", target: "vendorConfig", kind: "deps" },
]);
const RETENTION_SYMBOLS = new Set(RETENTION_POINTS.map((p) => p.symbol));

const PREWARM_POINTS = Object.freeze([
  { symbol: "SpaceRuntime.preloadStartupSolarSystems#prewarm", target: "spaceRuntime", property: "preloadStartupSolarSystems", holder: "exportsPrototype", kind: "preload" },
  { symbol: "ConfigService#prewarmDeps", target: "configService", kind: "deps" },
]);

const CAREER_POINTS = Object.freeze([
  { symbol: "careerAbyssalSources.reconcile#scope", target: "careerAbyssal", property: "reconcile", holder: "exports", kind: "scope", lazy: true },
  { symbol: "careerAbyssalSources.reconcileRun#scope", target: "careerAbyssal", property: "reconcileRun", holder: "exports", kind: "scope", lazy: true },
  { symbol: "gameStore.readPersisted#gate", target: "gameStore", property: "readPersisted", holder: "exports", kind: "gate" },
  { symbol: "sqliteStore#deps", target: "sqliteStore", kind: "deps" },
  { symbol: "sqliteStore.loadExistingTableObject#serve", target: "sqliteStore", property: "loadExistingTableObject", holder: "exports", kind: "serve" },
]);
const CAREER_SYMBOLS = new Set(CAREER_POINTS.map((p) => p.symbol));
const CAREER_LAZY = new Set(CAREER_POINTS.filter((p) => p.lazy).map((p) => p.symbol));
const CAREER_REQUIRED = Object.freeze(CAREER_POINTS.filter((p) => !p.lazy).map((p) => p.symbol));

const COMBAT_POINTS = Object.freeze([
  { symbol: "itemStore.listPendingCareerCombatOutcomes#scope", target: "itemStore", property: "listPendingCareerCombatOutcomes", holder: "exports", kind: "scope" },
  { symbol: "gameStore.readPersisted#combatGate", target: "gameStore", property: "readPersisted", holder: "exports", kind: "gate" },
  { symbol: "sqliteStore#combatDeps", target: "sqliteStore", kind: "deps" },
  { symbol: "sqliteStore.loadExistingTableObject#combatServe", target: "sqliteStore", property: "loadExistingTableObject", holder: "exports", kind: "serve" },
]);
const COMBAT_SYMBOLS = new Set(COMBAT_POINTS.map((p) => p.symbol));
const COMBAT_REQUIRED = Object.freeze(COMBAT_POINTS.map((p) => p.symbol));

const TEMPLATE_POINTS = Object.freeze([
  ...CACHE_MGR_HANDLERS.map((method) => ({
    symbol: `DungeonInstanceCacheMgrService.${method}#templateScope`, target: "cacheMgr", property: method, holder: "classPrototype", kind: "scope",
  })),
  { symbol: "dungeonAuthority#deps", target: "dungeonAuthority", kind: "deps" },
  { symbol: "dungeonAuthority.getTemplateByID#readOnly", target: "dungeonAuthority", property: "getTemplateByID", holder: "exports", kind: "serve" },
]);
const TEMPLATE_ROTATE_POINT = Object.freeze({
  symbol: "dungeonRuntime.rotateUniversePersistentInstances#templateRotateScope", target: "dungeonRuntime",
  property: "rotateUniversePersistentInstances", holder: "exports", kind: "rotateScope",
});
const TEMPLATE_SYMBOLS = new Set([...TEMPLATE_POINTS, TEMPLATE_ROTATE_POINT].map((p) => p.symbol));
const TEMPLATE_CALLERS_POINTS = Object.freeze([
  { symbol: "dungeonTrackingRuntime.processGuideApproachTexts#templateGuideScope", target: "dungeonTrackingRuntime",
    property: "processGuideApproachTexts", holder: "exports", kind: "guideScope" },
  { symbol: "dungeonSiteAdapter.enrichSiteWithDungeonRuntime#templateAdapterScope", target: "dungeonSiteAdapter",
    property: "enrichSiteWithDungeonRuntime", holder: "exports", kind: "adapterScope" },
]);
for (const point of TEMPLATE_CALLERS_POINTS) TEMPLATE_SYMBOLS.add(point.symbol);

function templatePointsFor(config) {
  const base = config.templateReadOnlyRotate === true ? [...TEMPLATE_POINTS, TEMPLATE_ROTATE_POINT] : TEMPLATE_POINTS;
  return config.templateReadOnlyCallers === true ? [...base, ...TEMPLATE_CALLERS_POINTS] : base;
}
const TEMPLATE_REQUIRED = Object.freeze(["dungeonAuthority#deps", "dungeonAuthority.getTemplateByID#readOnly"]);

const ROCK_POINTS = Object.freeze([
  { symbol: "dungeonRuntime#rockDeps", target: "dungeonRuntime", kind: "deps" },
  { symbol: "dungeonRuntime.mergeSpawnState#coalesce", target: "dungeonRuntime", property: "mergeSpawnState", holder: "exports", kind: "coalesce" },
  { symbol: "gameStore#rockDeps", target: "gameStore", kind: "storeDeps" },
  { symbol: "miningRuntime.handleSceneDisposed#rockFlush", target: "miningRuntime", property: "handleSceneDisposed", holder: "exports", kind: "flush", reason: "dispose", lazy: true },
  { symbol: "miningResourceSiteService.resetSceneGeneratedResourceSites#rockFlush", target: "miningResourceSites", property: "resetSceneGeneratedResourceSites", holder: "exportsStatic", kind: "flush", reason: "reset", lazy: true },
]);
const ROCK_SYMBOLS = new Set(ROCK_POINTS.map((p) => p.symbol));
const ROCK_LAZY = new Map(ROCK_POINTS.filter((p) => p.lazy).map((p) => [p.symbol, p.target]));
const ROCK_REQUIRED = Object.freeze(ROCK_POINTS.filter((p) => !p.lazy).map((p) => p.symbol));

const STRUCT_POINTS = Object.freeze([
  { symbol: "structureState#structuresDeps", target: "structureState", kind: "deps" },
  { symbol: "structureState.listStructuresForSystem#systemFilter", target: "structureState", property: "listStructuresForSystem", holder: "exports", kind: "filter" },
]);
const STRUCT_SYMBOLS = new Set(STRUCT_POINTS.map((p) => p.symbol));
const STRUCT_REQUIRED = Object.freeze(STRUCT_POINTS.map((p) => p.symbol));

const DRONE_COALESCE_SYMBOL = "itemStore.updateInventoryItem#droneCoalesce";
const DRONE_COALESCE_SO_SYMBOL = "itemStore.updateInventoryItemSuccessOnly#droneCoalesce";
const DRONE_POINTS = Object.freeze([
  { symbol: "itemStore#droneDeps", target: "itemStore", kind: "itemDeps" },
  { symbol: DRONE_COALESCE_SYMBOL, target: "itemStore", property: "updateInventoryItem", holder: "exports", kind: "coalesce", mode: "full" },
  { symbol: DRONE_COALESCE_SO_SYMBOL, target: "itemStore", property: "updateInventoryItemSuccessOnly", holder: "exports", kind: "coalesce", mode: "successOnly" },
  { symbol: "gameStore#droneDeps", target: "gameStore", kind: "storeDeps" },
  { symbol: "droneRuntime#droneDeps", target: "droneRuntime", kind: "droneDeps" },
  { symbol: "droneRuntime.tickScene#droneScope", target: "droneRuntime", property: "tickScene", holder: "exports", kind: "scope" },
  { symbol: "SpaceRuntime.disposeScene#droneFlush", target: "spaceRuntime", property: "disposeScene", holder: "exportsPrototype", kind: "flush", reason: "dispose" },
]);
const DRONE_SYMBOLS = new Set(DRONE_POINTS.map((p) => p.symbol));
const DRONE_REQUIRED = Object.freeze(DRONE_POINTS.map((p) => p.symbol));

const TICKSTRUCT_POINTS = Object.freeze([
  { symbol: "SpaceRuntime.tick#tickStructScope", target: "spaceRuntime", property: "tick", holder: "exportsPrototype", kind: "scope" },
  { symbol: "structureState.tickStructures#throttle", target: "structureState", property: "tickStructures", holder: "exports", kind: "throttle" },
]);
const TICKSTRUCT_SYMBOLS = new Set(TICKSTRUCT_POINTS.map((p) => p.symbol));
const TICKSTRUCT_REQUIRED = Object.freeze(TICKSTRUCT_POINTS.map((p) => p.symbol));

const BPREAD_LIST_SYMBOL = "industryRuntimeState.listBlueprintInstancesByOwner#bpOwnerRead";
const BPREAD_POINTS = Object.freeze([
  { symbol: "gameStore.read#bpScopeRead", target: "gameStore", property: "read", holder: "exports", kind: "scopeRead" },
  { symbol: "gameStore.write#bpScopeWrite", target: "gameStore", property: "write", holder: "exports", kind: "scopeWrite" },
  { symbol: "itemStore#bpDeps", target: "itemStore", kind: "itemDeps" },
  { symbol: BPREAD_LIST_SYMBOL, target: "industryRuntimeState", property: "listBlueprintInstancesByOwner", holder: "exports", kind: "list" },
]);
const BPREAD_SYMBOLS = new Set(BPREAD_POINTS.map((p) => p.symbol));
const BPREAD_REQUIRED = Object.freeze(BPREAD_POINTS.map((p) => p.symbol));

const WRECK_POINTS = Object.freeze([
  { symbol: "nativeNpcStore#wreckDeps", target: "nativeNpcStore", kind: "deps" },
  { symbol: "nativeNpcStore.listNativeWrecks#wreckList", target: "nativeNpcStore", property: "listNativeWrecks", holder: "exports", kind: "list" },
]);
const WRECK_SYMBOLS = new Set(WRECK_POINTS.map((p) => p.symbol));
const WRECK_REQUIRED = Object.freeze(WRECK_POINTS.map((p) => p.symbol));

const CONFIG_MEMO_DEPS_SYMBOL = "config#configMemoDeps";
const CONFIG_MEMO_POINTS = Object.freeze([
  { symbol: CONFIG_MEMO_DEPS_SYMBOL, target: "vendorConfig", kind: "deps" },
  { symbol: "globalConfig#configMemo", target: "globalConfig", kind: "exports" },
]);
const CONFIG_MEMO_SYMBOLS = new Set(CONFIG_MEMO_POINTS.map((p) => p.symbol));
const CONFIG_MEMO_REQUIRED = Object.freeze(CONFIG_MEMO_POINTS.map((p) => p.symbol));

const SOV_ECHO_LIST_SYMBOL = "sovState.listAllSovereigntySystemStates#ownedEchoMask";
const SOV_ECHO_POINTS = Object.freeze([
  { symbol: SOV_ECHO_LIST_SYMBOL, target: "sovState", property: "listAllSovereigntySystemStates", holder: "exports", kind: "mask" },
  { symbol: "sovCaptureState.reconcilePreparedSovereigntyCaptures#ownedEchoScope", target: "sovCaptureState",
    property: "reconcilePreparedSovereigntyCaptures", holder: "exports", kind: "scope" },
]);
const SOV_ECHO_SYMBOLS = new Set(SOV_ECHO_POINTS.map((p) => p.symbol));
const SOV_ECHO_REQUIRED = Object.freeze(SOV_ECHO_POINTS.map((p) => p.symbol));

const CYNO_POINTS = Object.freeze([
  { symbol: "sovSuppressionState.broadcastCynoJammerChangesForStructureRows#sessionFilter", target: "sovSuppressionState",
    property: "broadcastCynoJammerChangesForStructureRows", holder: "exports", kind: "filter" },
  { symbol: "sessionRegistry#cynoDeps", target: "sessionRegistry", kind: "deps" },
]);
const CYNO_SYMBOLS = new Set(CYNO_POINTS.map((p) => p.symbol));
const CYNO_REQUIRED = Object.freeze(CYNO_POINTS.map((p) => p.symbol));

const INCURSION_POINTS = Object.freeze([
  { symbol: "gameStore#incursionTalesDeps", target: "gameStore", kind: "deps" },
  { symbol: "incursionLifecycle#incursionTalesDeps", target: "incursionLifecycle", kind: "deps" },
  { symbol: "incursionPresentation.getTales#talesMemo", target: "incursionPresentation", property: "getTales", holder: "exports", kind: "memo" },
  { symbol: "incursionPresentation.activeTales#talesMemo", target: "incursionPresentation", property: "activeTales", holder: "exports", kind: "memo" },
  { symbol: "incursionPresentation.forSystem#talesMemo", target: "incursionPresentation", property: "forSystem", holder: "exports", kind: "memo" },
  { symbol: "incursionLifecycleStore.mutate#talesMemoBump", target: "incursionLifecycleStore", property: "mutate", holder: "exports", kind: "bump" },
]);
const INCURSION_SYMBOLS = new Set(INCURSION_POINTS.map((p) => p.symbol));
const INCURSION_REQUIRED = Object.freeze(INCURSION_POINTS.map((p) => p.symbol));
const INCURSION_TARGET_OF = new Map(INCURSION_POINTS.map((p) => [p.symbol, p.target]));

const BOUNTY_DEPS_CHAR_SYMBOL = "characterState#bountyDeps";
const BOUNTY_POINTS = Object.freeze([
  { symbol: BOUNTY_DEPS_CHAR_SYMBOL, target: "characterState", kind: "deps" },
  { symbol: "characterState.getCharacterRecord#bountyChar", target: "characterState", property: "getCharacterRecord", holder: "exports", kind: "char" },
  { symbol: "playerBountyState#bountyDeps", target: "playerBountyState", kind: "deps" },
  { symbol: "playerBountyState.getPool#bountyPool", target: "playerBountyState", property: "getPool", holder: "exports", kind: "pool" },
  { symbol: "bountyProxyService#bountyDeps", target: "bountyProxy", kind: "proxyDeps" },
  { symbol: "BountyProxyService.Handle_GetBounties#bountyScope", target: "bountyProxy", property: "Handle_GetBounties", holder: "classPrototype", kind: "scope" },
  { symbol: "BountyProxyService.Handle_GetBountiesAndKillRights#bountyScope", target: "bountyProxy",
    property: "Handle_GetBountiesAndKillRights", holder: "classPrototype", kind: "scope" },
]);
const BOUNTY_SYMBOLS = new Set(BOUNTY_POINTS.map((p) => p.symbol));
const BOUNTY_REQUIRED = Object.freeze(BOUNTY_POINTS.map((p) => p.symbol));

const CAREER_STANDING_POINTS = Object.freeze([
  { symbol: "careerStandingSources.observe#corpMemoScope", target: "careerStanding", property: "observe", holder: "exports", kind: "scope", lazy: true },
  { symbol: "corporationState.getCorporationRecord#corpMemo", target: "corporationState", property: "getCorporationRecord", holder: "exports", kind: "memo" },
]);
const CAREER_STANDING_SYMBOLS = new Set(CAREER_STANDING_POINTS.map((p) => p.symbol));
const CAREER_STANDING_LAZY = new Map(CAREER_STANDING_POINTS.filter((p) => p.lazy).map((p) => [p.symbol, p.target]));
const CAREER_STANDING_REQUIRED = Object.freeze(CAREER_STANDING_POINTS.map((p) => p.symbol));

const RECEIPT_RETIRE_POINTS = Object.freeze([
  { symbol: "gameStore#receiptRetireDeps", target: "gameStore", kind: "storeDeps" },
  { symbol: "reprocessingItemCustody.retireReceipts#defer", target: "reprocessingItemCustody", property: "retireReceipts", holder: "exports", kind: "defer", lazy: true },
]);
const RECEIPT_RETIRE_SYMBOLS = new Set(RECEIPT_RETIRE_POINTS.map((p) => p.symbol));
const RECEIPT_RETIRE_LAZY = new Map(RECEIPT_RETIRE_POINTS.filter((p) => p.lazy).map((p) => [p.symbol, p.target]));
const RECEIPT_RETIRE_REQUIRED = Object.freeze(RECEIPT_RETIRE_POINTS.map((p) => p.symbol));

const DUNGEON_REF_POINTS = Object.freeze([
  { symbol: "dungeonRuntime#instanceRefDeps", target: "dungeonRuntime", kind: "deps" },
  { symbol: "dungeonRuntime.getInstance#instanceRef", target: "dungeonRuntime", property: "getInstance", holder: "exports", kind: "serve" },
]);
const DUNGEON_REF_SYMBOLS = new Set(DUNGEON_REF_POINTS.map((p) => p.symbol));
const DUNGEON_REF_REQUIRED = Object.freeze(DUNGEON_REF_POINTS.map((p) => p.symbol));

const REQUEST_PATTERN =/dungeonRuntime|dungeonUniverseRuntime|dungeonInstanceCacheMgrService|configService|(^|[\\/])runtime(\.js)?$/;
const REQUEST_PATTERN_RETENTION =/dungeonRuntime|dungeonUniverseRuntime|dungeonInstanceCacheMgrService|configService|(^|[\\/])runtime(\.js)?$|sessionRegistry|(^|[\\/])config([\\/]index)?(\.js)?$/;
const REQUEST_PART_CAREER = "|gameStore|sqliteStore|careerAbyssalSources";
const REQUEST_PART_TEMPLATE = "|dungeonAuthority";
const REQUEST_PART_COMBAT = "|gameStore|sqliteStore|itemStore";
const REQUEST_PART_ROCK = "|gameStore|miningRuntime|miningResourceSiteService";
const REQUEST_PART_STRUCT = "|structureState";
const REQUEST_PART_DRONE = "|itemStore|gameStore|droneRuntime";
const REQUEST_PART_BPREAD = "|industryRuntimeState|gameStore|itemStore";
const REQUEST_PART_WRECK = "|nativeNpcStore";
const REQUEST_PART_CONFIG_MEMO = "|globalConfig|(^|[\\\\/])config([\\\\/]index)?(\\.js)?$";
const REQUEST_PART_SOV_ECHO = "|sovState|sovCaptureState";
const REQUEST_PART_CYNO = "|sovSuppressionState|sessionRegistry";
const REQUEST_PART_INCURSION = "|incursionPresentation|incursionLifecycleStore|incursionLifecycle|gameStore";
const REQUEST_PART_BOUNTY = "|bountyProxyService|playerBountyState|characterState";
const REQUEST_PART_CAREER_STANDING = "|careerStandingSources|corporationState";
const REQUEST_PART_RECEIPT_RETIRE = "|reprocessingItemCustody|gameStore";

function requestPatternFor(flags) {
  const base = flags.retention ? REQUEST_PATTERN_RETENTION : REQUEST_PATTERN;
  if (!flags.career && !flags.template && !flags.combat && !flags.rock && !flags.structures && !flags.drone && !flags.tickStruct &&
    !flags.bpRead && !flags.wreck && !flags.configMemo && !flags.sovEcho && !flags.cyno && !flags.incursion &&
    !flags.bounty && !flags.careerStanding && !flags.receiptRetire) return base;
  return new RegExp(base.source + (flags.career ? REQUEST_PART_CAREER : "") + (flags.combat ? REQUEST_PART_COMBAT : "") +
    (flags.template ? REQUEST_PART_TEMPLATE : "") + (flags.rock ? REQUEST_PART_ROCK : "") +
    (flags.structures || flags.tickStruct ? REQUEST_PART_STRUCT : "") + (flags.drone ? REQUEST_PART_DRONE : "") +
    (flags.bpRead ? REQUEST_PART_BPREAD : "") + (flags.wreck ? REQUEST_PART_WRECK : "") +
    (flags.configMemo ? REQUEST_PART_CONFIG_MEMO : "") + (flags.sovEcho ? REQUEST_PART_SOV_ECHO : "") +
    (flags.cyno ? REQUEST_PART_CYNO : "") + (flags.incursion ? REQUEST_PART_INCURSION : "") +
    (flags.bounty ? REQUEST_PART_BOUNTY : "") +
    (flags.careerStanding ? REQUEST_PART_CAREER_STANDING : "") + (flags.receiptRetire ? REQUEST_PART_RECEIPT_RETIRE : ""));
}

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function targetOf(filename) {
  const normalized = String(filename || "").replace(/\\/g, "/");
  const at = normalized.lastIndexOf("/server/src/");
  if (at < 0) return null;
  const rel = normalized.slice(at + "/server/src".length);
  for (const [key, suffix] of Object.entries(TARGETS)) {
    if (rel === suffix) return key;
  }
  return null;
}

const GAME_TARGETS = Object.freeze(new Set(["dungeonRuntime", "dungeonRuntimeState", "dungeonUniverse", "cacheMgr", "spaceRuntime", "droneRuntime"]));

function marksGame(key) {
  return GAME_TARGETS.has(key);
}

function isGameModuleFile(filename) {
  return String(filename || "").replace(/\\/g, "/").includes("/server/src/space/");
}

function enabledPoints(config) {
  return POINTS.filter((point) => config[point.flag] === true);
}

function createState(config, recorder, options = {}) {
  const points = enabledPoints(config);
  let index = null;
  if (config.dungeonIndex === true) {
    const { createDungeonActiveIndex } = require("./lib/dungeonActiveIndex");
    index = createDungeonActiveIndex({ config, log: options.log || log, now: options.now });
  }
  const indexPoints = index ? INDEX_POINTS : [];
  let retention = null;
  if (config.sceneRetention === true) {
    const { createSceneRetention } = require("./lib/sceneRetention");
    retention = createSceneRetention({ config, log: options.log || log, rss: options.rss });
  }
  const retentionPoints = retention ? RETENTION_POINTS : [];
  let prewarm = null;
  if (config.prewarmLocations === true) {
    const { createLocationsPrewarm } = require("./lib/locationsPrewarm");
    prewarm = createLocationsPrewarm({ config, log: options.log || log, warn: options.warn, now: options.prewarmNow });
  }
  const prewarmPoints = prewarm ? PREWARM_POINTS : [];
  let career = null;
  if (config.careerAbyssalRead === true) {
    const { createCareerAbyssalRead } = require("./lib/careerAbyssalRead");
    career = createCareerAbyssalRead({ config, log: options.log || log, now: options.now, openRowSource: options.openRowSource });
  }
  const careerPoints = career ? CAREER_POINTS : [];
  let combat = null;
  if (config.careerCombatItemsRead === true) {
    const { createCareerCombatItemsRead } = require("./lib/careerCombatItemsRead");
    combat = createCareerCombatItemsRead({ config, log: options.log || log, now: options.now, openRowSource: options.openRowSource });
  }
  const combatPoints = combat ? COMBAT_POINTS : [];
  let careerRead = null;
  if (career || combat) {
    const { createCareerReadDispatch } = require("./lib/careerReadDispatch");
    careerRead = createCareerReadDispatch([career, combat]);
  }
  let template = null;
  if (config.templateReadOnlyView === true) {
    const { createTemplateReadOnly } = require("./lib/templateReadOnly");
    template = createTemplateReadOnly({ config, log: options.log || log, now: options.now });
  }
  const templatePoints = template ? templatePointsFor(config) : [];
  let rock = null;
  if (config.rockRemainderCoalesce === true) {
    const { createRockRemainderCoalesce } = require("./lib/rockRemainderCoalesce");
    rock = createRockRemainderCoalesce({ config, log: options.log || log, setTimer: options.rockSetTimer, clearTimer: options.rockClearTimer });
  }
  const rockPoints = rock ? ROCK_POINTS : [];
  let structures = null;
  if (config.structuresSystemFilter === true) {
    const { createStructuresSystemFilter } = require("./lib/structuresSystemFilter");
    structures = createStructuresSystemFilter({ config, log: options.log || log, now: options.structuresNow });
  }
  const structPoints = structures ? STRUCT_POINTS : [];
  let drone = null;
  if (config.dronePersistCoalesce === true) {
    const { createDronePersistCoalesce } = require("./lib/dronePersistCoalesce");
    drone = createDronePersistCoalesce({ config, log: options.log || log, now: options.droneNow,
      setTimer: options.droneSetTimer, clearTimer: options.droneClearTimer });
  }
  const dronePoints = drone ? DRONE_POINTS : [];
  let tickStruct = null;
  if (config.tickStructuresThrottle === true) {
    const { createTickStructuresThrottle } = require("./lib/tickStructuresThrottle");
    tickStruct = createTickStructuresThrottle({ config, log: options.log || log });
  }
  const tickStructPoints = tickStruct ? TICKSTRUCT_POINTS : [];
  if (structures && tickStruct) {
    structures.setFreshnessSource(() => {
      const s = tickStruct.status();
      return s.enabled ? s.lastRunAtMs : null;
    });
  }
  let bpRead = null;
  if (config.blueprintOwnerRead === true) {
    const { createBlueprintOwnerRead } = require("./lib/blueprintOwnerRead");
    bpRead = createBlueprintOwnerRead({ config, log: options.log || log, now: options.bpReadNow });
  }
  const bpReadPoints = bpRead ? BPREAD_POINTS : [];
  let wreck = null;
  if (config.nativeWreckList === true) {
    const { createNativeWreckList } = require("./lib/nativeWreckList");
    wreck = createNativeWreckList({ config, log: options.log || log });
  }
  const wreckPoints = wreck ? WRECK_POINTS : [];
  let configMemo = null;
  if (config.configSnapshotMemo === true) {
    const { createConfigSnapshotMemo } = require("./lib/configSnapshotMemo");
    configMemo = createConfigSnapshotMemo({ revalidateMs: config.configSnapshotMemoRevalidateMs,
      parityCheck: config.configSnapshotMemoParityCheck === true, log: options.log || log, now: options.configMemoNow, fs: options.configMemoFs });
  }
  const configMemoPoints = configMemo ? CONFIG_MEMO_POINTS : [];
  let sovEcho = null;
  if (config.sovCaptureOwnedEchoSkip === true) {
    const { createSovCaptureEchoSkip } = require("./lib/sovCaptureEchoSkip");
    sovEcho = createSovCaptureEchoSkip({ config, log: options.log || log, now: options.sovEchoNow });
  }
  const sovEchoPoints = sovEcho ? SOV_ECHO_POINTS : [];
  let cyno = null;
  if (config.cynoBroadcastSessionFilter === true) {
    const { createCynoBroadcastFilter } = require("./lib/cynoBroadcastFilter");
    cyno = createCynoBroadcastFilter({ config, log: options.log || log });
  }
  const cynoPoints = cyno ? CYNO_POINTS : [];
  let incursion = null;
  if (config.incursionTalesMemo === true) {
    const { createIncursionTalesMemo } = require("./lib/incursionTalesMemo");
    incursion = createIncursionTalesMemo({ config, log: options.log || log, now: options.incursionNow });
  }
  const incursionPoints = incursion ? INCURSION_POINTS : [];
  let bounty = null;
  if (config.bountyPoolRead === true) {
    const { createBountyPoolRead } = require("./lib/bountyPoolRead");
    bounty = createBountyPoolRead({ config, log: options.log || log });
  }
  const bountyPoints = bounty ? BOUNTY_POINTS : [];
  let careerStandingMemo = null;
  if (config.careerStandingCorpMemo === true) {
    const { createCareerStandingCorpMemo } = require("./lib/careerStandingCorpMemo");
    careerStandingMemo = createCareerStandingCorpMemo({ config, log: options.log || log });
  }
  const careerStandingPoints = careerStandingMemo ? CAREER_STANDING_POINTS : [];
  let receiptRetire = null;
  if (config.reprocessingReceiptRetireDefer === true) {
    const { createReprocessingReceiptRetire } = require("./lib/reprocessingReceiptRetire");
    receiptRetire = createReprocessingReceiptRetire({ config, log: options.log || log, now: options.receiptRetireNow,
      setTimer: options.receiptRetireSetTimer, clearTimer: options.receiptRetireClearTimer });
  }
  const receiptRetirePoints = receiptRetire ? RECEIPT_RETIRE_POINTS : [];
  let instanceRef = null;
  if (config.dungeonInstanceRef === true) {
    const { createDungeonInstanceRef } = require("./lib/dungeonInstanceRef");
    instanceRef = createDungeonInstanceRef({ config, log: options.log || log, now: options.now, fingerprints: options.instanceRefFingerprints });
  }
  const instanceRefPoints = instanceRef ? DUNGEON_REF_POINTS : [];
  const all = [...bountyPoints,...prewarmPoints, ...indexPoints, ...retentionPoints, ...careerPoints, ...combatPoints, ...templatePoints,
    ...rockPoints, ...structPoints, ...dronePoints, ...tickStructPoints, ...bpReadPoints, ...wreckPoints, ...configMemoPoints,
    ...sovEchoPoints, ...cynoPoints, ...incursionPoints,
    ...careerStandingPoints, ...receiptRetirePoints, ...points];
  all.unshift(...instanceRefPoints);
  return {
    config,
    recorder,
    index,
    retention,
    prewarm,
    career,
    combat,
    careerRead,
    template,
    templatePoints,
    rock,
    structures,
    drone,
    tickStruct,
    bpRead,
    wreck,
    configMemo,
    sovEcho,
    cyno,
    incursion,
    bounty,
    careerStandingMemo,
    receiptRetire,
    careerReprocessingTargetsSeen: new Set(),
    bountySourceChecked: false,
    instanceRef,
    instanceRefSourceChecked: false,
    templateCallersSourceChecked: false,
    incursionTargetsSeen: new Set(),
    incursionSourceChecked: false,
    sovEchoStatsLast: null,
    configMemoSourceChecked: false,
    bpItemStore: null,
    bpGetBlueprint: null,
    careerModuleSeen: false,
    rockTargetsSeen: new Set(),
    requestPattern: requestPatternFor({ retention: Boolean(retention), career: Boolean(career), combat: Boolean(combat), template: Boolean(template), rock: Boolean(rock), structures: Boolean(structures), drone: Boolean(drone), tickStruct: Boolean(tickStruct), bpRead: Boolean(bpRead), wreck: Boolean(wreck), configMemo: Boolean(configMemo), sovEcho: Boolean(sovEcho), cyno: Boolean(cyno), incursion: Boolean(incursion),
      bounty: Boolean(bounty),
      careerStanding: Boolean(careerStandingMemo), receiptRetire: Boolean(receiptRetire) }),
    gameSeen: false,
    expected: new Set(all.map((p) => p.symbol)),
    patched: new Set(),
    cacheTargets: null,
    pendingCacheTargets: new Set(all.map((p) => p.target)),
  };
}

function serverSrcRootOf(filename) {
  const match = /^(.*[\\/]server[\\/]src)([\\/])/.exec(String(filename || ""));
  return match ? { root: match[1], sep: match[2] } : null;
}

function cacheFilenames(rootInfo) {
  const out = new Map();
  for (const [key, suffix] of Object.entries(TARGETS)) {
    out.set(key, rootInfo.root + (rootInfo.sep === "/" ? suffix : suffix.replace(/\//g, rootInfo.sep)));
  }
  return out;
}

function patchFromCache(state, parent, cache = Module._cache) {
  if (state.pendingCacheTargets.size === 0) return 0;
  if (!state.cacheTargets) {
    const rootInfo = parent ? serverSrcRootOf(parent.filename) : null;
    if (!rootInfo) return 0;
    state.cacheTargets = cacheFilenames(rootInfo);
  }
  let count = 0;
  for (const key of state.pendingCacheTargets) {
    const entry = cache && cache[state.cacheTargets.get(key)];
    if (!entry || !entry.loaded) continue;
    if (marksGame(key)) state.gameSeen = true;
    state.pendingCacheTargets.delete(key);
    count += patchTarget(key, entry.exports, state, state.cacheTargets.get(key));
  }
  return count;
}

function indexDisabled(state) {
  return Boolean(state.index && state.index.status().disabledReason);
}

function retentionDisabledReason(state) {
  return state.retention ? state.retention.status().disabledReason : null;
}

function careerDisabledReason(state) {
  return state.career ? state.career.status().disabledReason : null;
}

function templateDisabledReason(state) {
  return state.template ? state.template.status().disabledReason : null;
}

function combatDisabledReason(state) {
  return state.combat ? state.combat.status().disabledReason : null;
}

function rockDisabledReason(state) {
  return state.rock ? state.rock.status().disabledReason : null;
}

function structuresDisabledReason(state) {
  return state.structures ? state.structures.status().disabledReason : null;
}

function droneDisabledReason(state) {
  return state.drone ? state.drone.status().disabledReason : null;
}

function tickStructDisabledReason(state) {
  return state.tickStruct ? state.tickStruct.status().disabledReason : null;
}

function bpReadDisabledReason(state) {
  return state.bpRead ? state.bpRead.status().disabledReason : null;
}

function wreckDisabledReason(state) {
  return state.wreck ? state.wreck.status().disabledReason : null;
}

function configMemoDisabledReason(state) {
  return state.configMemo ? state.configMemo.status().disabledReason : null;
}

function sovEchoDisabledReason(state) {
  return state.sovEcho ? state.sovEcho.status().disabledReason : null;
}

function cynoDisabledReason(state) {
  return state.cyno ? state.cyno.status().disabledReason : null;
}

function incursionDisabledReason(state) {
  return state.incursion ? state.incursion.status().disabledReason : null;
}

function bountyDisabledReason(state) {
  return state.bounty ? state.bounty.status().disabledReason : null;
}

function careerStandingDisabledReason(state) {
  return state.careerStandingMemo ? state.careerStandingMemo.status().disabledReason : null;
}

function receiptRetireDisabledReason(state) {
  return state.receiptRetire ? state.receiptRetire.status().disabledReason : null;
}

function careerReprocessingLazyWaiting(state, symbol) {
  const target = CAREER_STANDING_LAZY.get(symbol) || RECEIPT_RETIRE_LAZY.get(symbol);
  return Boolean(target) && !state.careerReprocessingTargetsSeen.has(target);
}

function careerReprocessingSkipped(state, symbol, options) {
  let reason = null;
  if (CAREER_STANDING_SYMBOLS.has(symbol)) reason = careerStandingDisabledReason(state);
  else if (RECEIPT_RETIRE_SYMBOLS.has(symbol)) reason = receiptRetireDisabledReason(state);
  else return false;
  if (reason && !(options.keepCareerReprocessingDrift === true && reason === "drift")) return true;
  return options.lazyCareerReprocessing === true && careerReprocessingLazyWaiting(state, symbol);
}

function instanceRefDisabledReason(state) {
  return state.instanceRef ? state.instanceRef.status().disabledReason : null;
}

function instanceRefSkipped(state, symbol, options) {
  if (!DUNGEON_REF_SYMBOLS.has(symbol)) return false;
  const reason = instanceRefDisabledReason(state);
  return Boolean(reason) && !(options.keepInstanceRefDrift === true && reason === "drift");
}

function incursionLazyWaiting(state, symbol) {
  return INCURSION_TARGET_OF.has(symbol) && !state.incursionTargetsSeen.has(INCURSION_TARGET_OF.get(symbol));
}

function rockLazyWaiting(state, symbol) {
  return ROCK_LAZY.has(symbol) && !state.rockTargetsSeen.has(ROCK_LAZY.get(symbol));
}

function missingSymbols(state, options = {}) {
  const skipIndex = indexDisabled(state);
  const retentionReason = retentionDisabledReason(state);
  const skipRetention = Boolean(retentionReason) && !(options.keepRetentionDrift === true && retentionReason === "drift");
  const careerReason = careerDisabledReason(state);
  const skipCareer = Boolean(careerReason) && !(options.keepCareerDrift === true && careerReason === "drift");
  const skipLazyCareer = options.lazyCareer === true && !state.careerModuleSeen;
  const templateReason = templateDisabledReason(state);
  const skipTemplate = Boolean(templateReason) && !(options.keepTemplateDrift === true && templateReason === "drift");
  const combatReason = combatDisabledReason(state);
  const skipCombat = Boolean(combatReason) && !(options.keepCombatDrift === true && combatReason === "drift");
  const rockReason = rockDisabledReason(state);
  const skipRock = Boolean(rockReason) && !(options.keepRockDrift === true && rockReason === "drift");
  const lazyRock = options.lazyRock === true;
  const structReason = structuresDisabledReason(state);
  const skipStruct = Boolean(structReason) && !(options.keepStructuresDrift === true && structReason === "drift");
  const droneReason = droneDisabledReason(state);
  const skipDrone = Boolean(droneReason) && !(options.keepDroneDrift === true && droneReason === "drift");
  const tickStructReason = tickStructDisabledReason(state);
  const skipTickStruct = Boolean(tickStructReason) && !(options.keepTickStructDrift === true && tickStructReason === "drift");
  const bpReadReason = bpReadDisabledReason(state);
  const skipBpRead = Boolean(bpReadReason) && !(options.keepBpReadDrift === true && bpReadReason === "drift");
  const wreckReason = wreckDisabledReason(state);
  const skipWreck = Boolean(wreckReason) && !(options.keepWreckDrift === true && wreckReason === "drift");
  const configMemoReason = configMemoDisabledReason(state);
  const skipConfigMemo = Boolean(configMemoReason) && !(options.keepConfigMemoDrift === true && configMemoReason.startsWith("drift"));
  const sovEchoReason = sovEchoDisabledReason(state);
  const skipSovEcho = Boolean(sovEchoReason) && !(options.keepSovEchoDrift === true && sovEchoReason === "drift");
  const cynoReason = cynoDisabledReason(state);
  const skipCyno = Boolean(cynoReason) && !(options.keepCynoDrift === true && cynoReason === "drift");
  const incursionReason = incursionDisabledReason(state);
  const skipIncursion = Boolean(incursionReason) && !(options.keepIncursionDrift === true && incursionReason === "drift");
  const lazyIncursion = options.lazyIncursion === true;
  const bountyReason = bountyDisabledReason(state);
  const skipBounty = Boolean(bountyReason) && !(options.keepBountyDrift === true && bountyReason === "drift");
  return [...state.expected].filter((symbol) => !state.patched.has(symbol) && !(skipCyno && CYNO_SYMBOLS.has(symbol)) &&
    !(skipBounty && BOUNTY_SYMBOLS.has(symbol)) &&
    !careerReprocessingSkipped(state, symbol, options) &&
    !instanceRefSkipped(state, symbol, options) &&
    !(skipIncursion && INCURSION_SYMBOLS.has(symbol)) && !(lazyIncursion && incursionLazyWaiting(state, symbol)) &&
    !(skipBpRead && BPREAD_SYMBOLS.has(symbol)) && !(skipWreck && WRECK_SYMBOLS.has(symbol)) &&
    !(skipConfigMemo && CONFIG_MEMO_SYMBOLS.has(symbol)) && !(skipSovEcho && SOV_ECHO_SYMBOLS.has(symbol)) &&
    !(skipStruct && STRUCT_SYMBOLS.has(symbol)) && !(skipDrone && DRONE_SYMBOLS.has(symbol)) &&
    !(skipTickStruct && TICKSTRUCT_SYMBOLS.has(symbol)) &&
    !(skipIndex && INDEX_SYMBOLS.has(symbol)) && !(skipRetention && RETENTION_SYMBOLS.has(symbol)) &&
    !(skipCareer && CAREER_SYMBOLS.has(symbol)) && !(skipLazyCareer && CAREER_LAZY.has(symbol)) &&
    !(skipCombat && COMBAT_SYMBOLS.has(symbol)) &&
    !(skipRock && ROCK_SYMBOLS.has(symbol)) && !(lazyRock && rockLazyWaiting(state, symbol)) &&
    !(skipTemplate && TEMPLATE_SYMBOLS.has(symbol)));
}

function allPatched(state) {
  if (state.patched.size >= state.expected.size) return true;
  return state.index || state.retention || state.career || state.combat || state.template || state.rock || state.structures ||
    state.drone || state.tickStruct || state.bpRead || state.wreck || state.configMemo || state.sovEcho || state.cyno ||
    state.incursion || state.bounty ||
    state.instanceRef ||
    state.careerStandingMemo || state.receiptRetire
    ? missingSymbols(state).length === 0 : false;
}

function holderOf(point, exportsValue) {
  if (point.holder === "exports") {
    return exportsValue !== null && typeof exportsValue === "object" ? exportsValue : null;
  }
  if (point.holder === "classPrototype") {
    return typeof exportsValue === "function" && exportsValue.prototype ? exportsValue.prototype : null;
  }
  if (point.holder === "exportsPrototype") {
    if (exportsValue === null || typeof exportsValue !== "object") return null;
    const proto = Object.getPrototypeOf(exportsValue);
    return proto && proto !== Object.prototype ? proto : null;
  }
  if (point.holder === "exportsStatic") {
    return exportsValue !== null && (typeof exportsValue === "object" || typeof exportsValue === "function") ? exportsValue : null;
  }
  return null;
}

function formatSystem(value) {
  if (value !== null && typeof value === "object") {
    return String(value.sceneKey || value.locationID || value.solarSystemID || "?");
  }
  return String(value);
}

function lengthOf(value) {
  return Array.isArray(value) ? value.length : 0;
}

function countIds(raw) {
  if (Array.isArray(raw)) return raw.length;
  if (raw && typeof raw === "object" && Array.isArray(raw.items)) return raw.items.length;
  return 0;
}

function lifecycleKey(args) {
  const options = args && args[1];
  const full = options !== null && typeof options === "object" && options.full === true;
  return full ? `${String(args[0])}/full` : String(args && args[0]);
}

function optionsFor(point, recorder) {
  const name = point.symbol;
  switch (point.property) {
    case "listInstancesByLifecycle":
      return {
        name,
        onDone(ms, result, args) {
          recorder.recordLifecycle(lifecycleKey(args), ms, lengthOf(result));
        },
      };
    case "getUniversePersistentLifecycleBoundary":
      return {
        name,
        before: () => recorder.nextCount(name),
        context: (call, result, _thisArg, _args, threw) =>
          `call=${call}${threw ? " threw" : ""}${result && typeof result === "object" ? ` boundaryAtMs=${result.boundaryAtMs}` : ""}`,
      };
    case "Handle_GetMultiLocationsEx":
      return {
        name,
        before: (_thisArg, callArgs) => {
          const rpcArgs = callArgs && callArgs[0];
          return { call: recorder.nextCount(name), ids: countIds(rpcArgs && rpcArgs.length > 0 ? rpcArgs[0] : []) };
        },
        context: (token, _result, _thisArg, _args, threw) => `call=${token.call} ids=${token.ids}${threw ? " threw" : ""}`,
      };
    case "ensureScene":
      return {
        name,
        before: (thisArg) => (thisArg && thisArg.scenes ? thisArg.scenes.size : -1),
        context: (sizeBefore, result, thisArg, args, threw) => {
          const sizeAfter = thisArg && thisArg.scenes ? thisArg.scenes.size : -1;
          return `system=${formatSystem(args[1] && args[1].sceneDescriptor || args[0])} new=${sizeAfter > sizeBefore}` +
            ` scenes=${sizeAfter}${threw ? " threw" : ""}${result === null ? " result=null" : ""}`;
        },
      };
    case "prepareUniverseSitesForPlayerEntry":
      return {
        name,
        context: (_token, result, _thisArg, args, threw) =>
          `system=${formatSystem(args[0])}${threw ? " threw" : ""}` +
            (result && typeof result === "object" ? ` prepared=${result.prepared}${result.reason ? ` reason=${result.reason}` : ""}` : ""),
      };
    case "collectEmptySolarSystems":
      return {
        name,
        before: (thisArg) => (thisArg && thisArg.scenes ? thisArg.scenes.size : -1),
        context: (sizeBefore, result, _thisArg, _args, threw) =>
          `scenesBefore=${sizeBefore}${threw ? " threw" : ""}` +
            (result && typeof result === "object"
              ? ` collected=${lengthOf(result.collectedSystemIDs)} retained=${lengthOf(result.retainedSystemIDs)} attempted=${lengthOf(result.attemptedSystemIDs)}`
              : ""),
      };
    default:
      return { name };
  }
}

function patchIndexPoint(point, exportsValue, index) {
  if (point.kind === "deps") return index.setDeps(exportsValue);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfIndex) return true;
  if (point.kind === "scope") {
    holder[point.property] = index.wrapScope(current);
    return true;
  }
  if (current.name !== point.property || holder[MOON_OVERLAY_MARKER]) {
    index.disable("order", point.property);
    return false;
  }
  holder[point.property] = point.kind === "reader" ? index.wrapLifecycleReader(current) : index.wrapTerminalReader(current);
  return true;
}

function patchIndexTarget(key, exportsValue, state) {
  let count = 0;
  for (const point of INDEX_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (indexDisabled(state)) break;
    try {
      if (patchIndexPoint(point, exportsValue, state.index)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.index.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchRetentionPoint(point, exportsValue, retention) {
  if (point.kind === "deps") {
    return point.target === "sessionRegistry" ? retention.setSessionRegistry(exportsValue) : retention.setVendorConfig(exportsValue);
  }
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfRetention) return true;
  holder[point.property] = retention.wrapCollect(current);
  return true;
}

function patchRetentionTarget(key, exportsValue, state) {
  let count = 0;
  for (const point of RETENTION_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (retentionDisabledReason(state)) break;
    try {
      if (patchRetentionPoint(point, exportsValue, state.retention)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.retention.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchPrewarmPoint(point, exportsValue, prewarm) {
  if (point.kind === "deps") return prewarm.setConfigService(exportsValue);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfPrewarm) return true;
  holder[point.property] = prewarm.wrapPreload(current);
  return true;
}

function patchPrewarmTarget(key, exportsValue, state) {
  let count = 0;
  for (const point of PREWARM_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    try {
      if (patchPrewarmPoint(point, exportsValue, state.prewarm)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} prewarm patch error (${point.symbol}): ${error && error.message || error}`);
    }
  }
  return count;
}

function patchCareerPoint(point, exportsValue, feature, dispatch, filename) {
  if (point.kind === "deps") return feature.setDeps(exportsValue, filename);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfCareer) return true;
  if (point.kind === "scope") {
    holder[point.property] = feature.wrapScope(current);
    return true;
  }
  if (current.name !== point.property) {
    feature.disable("order", point.property);
    return false;
  }
  holder[point.property] = point.kind === "gate" ? dispatch.wrapGate(current) : dispatch.wrapServe(current);
  return true;
}

function patchCareerFeature(points, feature, reasonOf, key, exportsValue, state, filename) {
  let count = 0;
  for (const point of points) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (reasonOf(state)) break;
    try {
      if (patchCareerPoint(point, exportsValue, feature, state.careerRead, filename)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      feature.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

const CAREER_OBSOLETE_MARKERS = Object.freeze({ sqliteStore: "loadExistingAbyssalInstances", gameStore: "readPersistedAbyssalInstances" });
const COMBAT_OBSOLETE_MARKERS = Object.freeze({ sqliteStore: "loadExistingCareerRows", gameStore: "readPersistedPendingCareerCombatOutcomes" });

function markObsolete(feature, reasonOf, markers, key, exportsValue, state) {
  if (!feature || reasonOf(state) || !Object.prototype.hasOwnProperty.call(markers, key)) return;
  if (exportsValue && typeof exportsValue[markers[key]] === "function") {
    feature.disable("obsolete", `EveJS reads it itself: ${key}.${markers[key]}`);
  }
}

function patchCareerTarget(key, exportsValue, state, filename) {
  if (key === "careerAbyssal") state.careerModuleSeen = true;
  markObsolete(state.career, careerDisabledReason, CAREER_OBSOLETE_MARKERS, key, exportsValue, state);
  return patchCareerFeature(CAREER_POINTS, state.career, careerDisabledReason, key, exportsValue, state, filename);
}

function patchCombatTarget(key, exportsValue, state, filename) {
  markObsolete(state.combat, combatDisabledReason, COMBAT_OBSOLETE_MARKERS, key, exportsValue, state);
  return patchCareerFeature(COMBAT_POINTS, state.combat, combatDisabledReason, key, exportsValue, state, filename);
}

function readTemplateCallersSources(filename) {
  if (!filename) return { tracking: "", adapter: "" };
  const path = require("path");
  const dir = path.dirname(filename);
  return {
    tracking: readSourceText(path.join(dir, "dungeonTrackingRuntime.js")),
    adapter: readSourceText(path.join(dir, "dungeonSiteAdapter.js")),
  };
}

function patchTemplatePoint(point, exportsValue, template, state, filename) {
  if (point.kind === "deps") return template.setDeps(exportsValue);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfTemplate) return true;
  if (point.kind === "guideScope" || point.kind === "adapterScope") {
    if (state && !state.templateCallersSourceChecked) {
      state.templateCallersSourceChecked = true;
      template.checkCallersSources(readTemplateCallersSources(filename));
    }
    holder[point.property] = point.kind === "guideScope" ? template.wrapGuideScope(current) : template.wrapAdapterScope(current);
    return true;
  }
  if (point.kind === "scope") {
    const { hydrateFixedUpstream, HYDRATE_UPSTREAM_READONLY } = require("./lib/templateReadOnly");
    if (state && filename) {
      if (state.templateHydrateFixed === undefined) state.templateHydrateFixed = hydrateFixedUpstream(readSourceText(filename));
      if (state.templateHydrateFixed) {
        template.markHydrateObsolete(`EveJS reads it itself: hydrateSummary ${HYDRATE_UPSTREAM_READONLY}`);
        return true;
      }
    }
    holder[point.property] = template.wrapScope(current);
    return true;
  }
  if (point.kind === "rotateScope") {
    const { rotateFixedUpstream, ROTATE_UPSTREAM_READONLY } = require("./lib/templateReadOnly");
    if (filename && rotateFixedUpstream(readSourceText(filename))) {
      template.markRotateObsolete(`EveJS reads it itself: ${ROTATE_UPSTREAM_READONLY}`);
      return true;
    }
    holder[point.property] = template.wrapRotateScope(current);
    return true;
  }
  if (current.name !== point.property) {
    template.disable("order", point.property);
    return false;
  }
  holder[point.property] = template.wrapGetTemplate(current);
  return true;
}

function patchTemplateTarget(key, exportsValue, state, filename) {
  let count = 0;
  for (const point of state.templatePoints) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (templateDisabledReason(state)) break;
    try {
      if (patchTemplatePoint(point, exportsValue, state.template, state, filename)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.template.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchRockPoint(point, exportsValue, rock) {
  if (point.kind === "deps") return rock.setDungeonDeps(exportsValue);
  if (point.kind === "storeDeps") return rock.setStoreDeps(exportsValue);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (point.kind === "flush") {
    if (current.__hotPathPerfRock) return true;
    holder[point.property] = rock.wrapFlushPoint(current, point.reason);
    return true;
  }
  if (current.name !== point.property || current.__hotPathPerfRock) {
    rock.disable("order", point.property);
    return false;
  }
  holder[point.property] = rock.wrapMerge(current);
  return true;
}

function patchRockTarget(key, exportsValue, state) {
  let count = 0;
  for (const point of ROCK_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (rockDisabledReason(state)) break;
    if (point.lazy) state.rockTargetsSeen.add(key);
    try {
      if (patchRockPoint(point, exportsValue, state.rock)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.rock.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchStructuresPoint(point, exportsValue, structures) {
  if (point.kind === "deps") return structures.setDeps(exportsValue);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfStructures) return true;
  if (current.name !== point.property) {
    structures.disable("order", point.property);
    return false;
  }
  holder[point.property] = structures.wrapListForSystem(current);
  return true;
}

function patchStructuresTarget(key, exportsValue, state) {
  let count = 0;
  for (const point of STRUCT_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (structuresDisabledReason(state)) break;
    try {
      if (patchStructuresPoint(point, exportsValue, state.structures)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.structures.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchDronePoint(point, exportsValue, drone) {
  if (point.kind === "itemDeps") return drone.setItemStoreDeps(exportsValue);
  if (point.kind === "droneDeps") return drone.setDroneDeps(exportsValue);
  if (point.kind === "storeDeps") return drone.setStoreDeps(exportsValue);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfDrone) return true;
  if (point.kind === "scope") {
    holder[point.property] = drone.wrapTickScope(current);
    return true;
  }
  if (point.kind === "flush") {
    holder[point.property] = drone.wrapFlushPoint(current, point.reason);
    return true;
  }
  if (current.name !== point.property) {
    drone.disable("order", point.property);
    return false;
  }
  holder[point.property] = drone.wrapUpdate(current, point.mode);
  return true;
}

function patchDroneTarget(key, exportsValue, state) {
  if (droneDisabledReason(state)) return 0;
  if (key === "droneRuntime" && !(state.patched.has(DRONE_COALESCE_SYMBOL) && state.patched.has(DRONE_COALESCE_SO_SYMBOL))) {
    state.drone.disable("order", "droneRuntime loaded before itemStore.updateInventoryItem/updateInventoryItemSuccessOnly was wrapped");
    return 0;
  }
  let count = 0;
  for (const point of DRONE_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (droneDisabledReason(state)) break;
    try {
      if (patchDronePoint(point, exportsValue, state.drone)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.drone.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchTickStructPoint(point, exportsValue, tickStruct) {
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfTickStruct) return true;
  if (point.kind === "scope") {
    holder[point.property] = tickStruct.wrapRuntimeTick(current);
    return true;
  }
  if (current.name !== point.property) {
    tickStruct.disable("order", point.property);
    return false;
  }
  holder[point.property] = tickStruct.wrapTickStructures(current);
  return true;
}

function patchTickStructTarget(key, exportsValue, state) {
  let count = 0;
  for (const point of TICKSTRUCT_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (tickStructDisabledReason(state)) break;
    try {
      if (patchTickStructPoint(point, exportsValue, state.tickStruct)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.tickStruct.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function readBpReadSources(filename) {
  const fs = require("fs");
  const path = require("path");
  const readText = (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (_error) {
      return "";
    }
  };
  if (!filename) return { industrySource: "", starbaseSource: "" };
  return {
    industrySource: readText(filename),
    starbaseSource: readText(path.join(path.dirname(filename), "starbaseIndustryRuntime.js")),
  };
}

function trySetBpReadDeps(state) {
  if (!state.bpItemStore || !state.bpGetBlueprint) return false;
  const items = state.bpItemStore;
  return state.bpRead.setDeps({
    listOwnedItems: (ownerID, opts) => items.listOwnedItems(ownerID, opts),
    getBlueprintByItemID: state.bpGetBlueprint,
  });
}

function patchBpReadPoint(point, exportsValue, state, filename) {
  const bp = state.bpRead;
  if (point.kind === "itemDeps") {
    if (!exportsValue || typeof exportsValue !== "object" || typeof exportsValue.listOwnedItems !== "function") return false;
    state.bpItemStore = exportsValue;
    trySetBpReadDeps(state);
    return true;
  }
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfBlueprint) return true;
  if (current.name !== point.property) {
    bp.disable("order", point.property);
    return false;
  }
  if (point.kind === "scopeRead") {
    holder[point.property] = bp.wrapRead(current);
    return true;
  }
  if (point.kind === "scopeWrite") {
    holder[point.property] = bp.wrapWrite(current);
    return true;
  }
  if (typeof holder.getBlueprintByItemID !== "function") {
    bp.disable("drift", "getBlueprintByItemID");
    return false;
  }
  const bpSources = readBpReadSources(filename);
  if (require("./lib/blueprintOwnerRead").fixedUpstream(bpSources.industrySource)) {
    bp.disable("obsolete", "EveJS reads it itself: industryRuntimeState.readTableView");
    return false;
  }
  const fingerprint = bp.checkFingerprint(bpSources);
  if (!fingerprint.ok) {
    bp.disable("drift", fingerprint.detail);
    return false;
  }
  state.bpGetBlueprint = holder.getBlueprintByItemID;
  holder[point.property] = bp.wrapList(current);
  trySetBpReadDeps(state);
  return true;
}

function patchBpReadTarget(key, exportsValue, state, filename) {
  let count = 0;
  for (const point of BPREAD_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (bpReadDisabledReason(state)) break;
    try {
      if (patchBpReadPoint(point, exportsValue, state, filename)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.bpRead.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function cachedExports(filename, requireLoaded) {
  const entry = Module._cache[filename];
  if (!entry || (requireLoaded && !entry.loaded)) return null;
  return entry.exports || null;
}

function lazyCachedExports(filename) {
  let found = null;
  return () => {
    if (!found) found = cachedExports(filename, true);
    return found;
  };
}

function readWreckSources(filename) {
  const fs = require("fs");
  const path = require("path");
  const readText = (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (_error) {
      return "";
    }
  };
  if (!filename) return { storeSource: "", siteSource: "" };
  return {
    storeSource: readText(filename),
    siteSource: readText(path.join(path.dirname(filename), "../../services/dungeon/dungeonUniverseSiteService.js")),
  };
}

function patchWreckPoint(point, exportsValue, wreck, filename) {
  if (point.kind === "deps") {
    if (!filename || !exportsValue || typeof exportsValue !== "object") return false;
    const path = require("path");
    const dir = path.dirname(filename);
    const gameStore = cachedExports(path.join(dir, "../../gameStore/index.js"), false);
    if (!wreck.setDeps(exportsValue, gameStore,
      lazyCachedExports(path.join(dir, "nativeNpcDeathWrecks.js")), lazyCachedExports(path.join(dir, "incursionDeathWrecks.js")))) {
      return false;
    }
    const fingerprint = wreck.checkFingerprint(readWreckSources(filename));
    if (!fingerprint.ok) {
      wreck.disable("drift", fingerprint.detail);
      return false;
    }
    return true;
  }
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfWreckList) return true;
  if (!wreck.status().ready) return false;
  if (current.name !== point.property) {
    wreck.disable("order", point.property);
    return false;
  }
  holder[point.property] = wreck.wrapList(current);
  return true;
}

function patchWreckTarget(key, exportsValue, state, filename) {
  let count = 0;
  for (const point of WRECK_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (wreckDisabledReason(state)) break;
    try {
      if (patchWreckPoint(point, exportsValue, state.wreck, filename)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.wreck.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function readSourceText(filename) {
  if (!filename) return "";
  try {
    return require("fs").readFileSync(filename, "utf8");
  } catch (_error) {
    return "";
  }
}

function patchConfigMemoPoint(point, exportsValue, state, filename) {
  const memo = state.configMemo;
  if (point.kind === "deps") {
    if (exportsValue === null || typeof exportsValue !== "object") return false;
    memo.setVendorConfig(exportsValue);
    return true;
  }
  if (!exportsValue || typeof exportsValue !== "object" || typeof exportsValue.getRuntimeConfig !== "function") return false;
  if (!state.configMemoSourceChecked) {
    state.configMemoSourceChecked = true;
    if (!memo.checkSource(readSourceText(filename)).ok) return false;
    const managerFile = filename ? require("path").join(require("path").dirname(filename), "../../config/manager.js") : "";
    if (!memo.checkManagerSource(readSourceText(managerFile)).ok) return false;
  }
  if (memo.status().disabledReason) return false;
  if (!state.patched.has(CONFIG_MEMO_DEPS_SYMBOL) && filename) {
    const cfg = cachedExports(require("path").join(require("path").dirname(filename), "../../config/index.js"), false);
    if (cfg && typeof cfg === "object") {
      memo.setVendorConfig(cfg);
      state.patched.add(CONFIG_MEMO_DEPS_SYMBOL);
    }
  }
  const result = memo.patchExports(exportsValue);
  if (!result.ok && String(result.reason).startsWith("order")) memo.disable(result.reason);
  return result.ok;
}

function patchConfigMemoTarget(key, exportsValue, state, filename) {
  let count = 0;
  for (const point of CONFIG_MEMO_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (configMemoDisabledReason(state)) break;
    try {
      if (patchConfigMemoPoint(point, exportsValue, state, filename)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.configMemo.disable(`error:${error && error.message || error}`);
    }
  }
  return count;
}

function sovCaptureStateLoaded(sovStateFilename) {
  if (!sovStateFilename) return false;
  const path = require("path");
  const entry = Module._cache[path.join(path.dirname(sovStateFilename), "sovCaptureState.js")];
  return Boolean(entry && entry.loaded);
}

function patchSovEchoPoint(point, exportsValue, sovEcho, filename, via) {
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfSovEcho) return true;
  if (point.kind === "scope") {
    holder[point.property] = sovEcho.wrapReconcile(current);
    return true;
  }
  if (current.name !== point.property) {
    sovEcho.disable("order", point.property);
    return false;
  }
  holder[point.property] = sovEcho.wrapList(current);
  if (via === "sweep") sovEcho.disable("late_wrap", "sweep");
  else if (sovCaptureStateLoaded(filename)) sovEcho.disable("late_wrap", "sovCaptureState loaded before sovState wrap");
  else sovEcho.markListFirstLoad();
  return true;
}

function patchSovEchoTarget(key, exportsValue, state, filename, via) {
  let count = 0;
  for (const point of SOV_ECHO_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (sovEchoDisabledReason(state)) break;
    try {
      if (patchSovEchoPoint(point, exportsValue, state.sovEcho, filename, via)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.sovEcho.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchCynoPoint(point, exportsValue, cyno) {
  if (point.kind === "deps") return cyno.setSessionRegistry(exportsValue);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfCyno) return true;
  holder[point.property] = cyno.wrapBroadcast(current);
  return true;
}

function patchCynoTarget(key, exportsValue, state) {
  let count = 0;
  for (const point of CYNO_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (cynoDisabledReason(state)) break;
    try {
      if (patchCynoPoint(point, exportsValue, state.cyno)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.cyno.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function readIncursionSources(filename) {
  if (!filename) return { presentation: "", store: "", lifecycle: "" };
  const path = require("path");
  const dir = path.dirname(filename);
  return {
    presentation: readSourceText(filename),
    store: readSourceText(path.join(dir, "incursionLifecycleStore.js")),
    lifecycle: readSourceText(path.join(dir, "incursionLifecycle.js")),
  };
}

function patchIncursionPoint(point, exportsValue, memo, filename, state) {
  if (point.kind === "deps") {
    return point.target === "gameStore" ? memo.setStoreDeps(exportsValue) : memo.setLifecycleDeps(exportsValue);
  }
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfIncursion) return true;
  if (point.kind === "memo" && !state.incursionSourceChecked) {
    if (!memo.setPresentationDeps(exportsValue)) return false;
    state.incursionSourceChecked = true;
    const fingerprint = memo.checkFingerprint(readIncursionSources(filename));
    if (!fingerprint.ok) {
      memo.disable("drift", fingerprint.detail);
      return false;
    }
  }
  if (current.name !== point.property) {
    memo.disable("order", point.property);
    return false;
  }
  if (point.kind === "bump") holder[point.property] = memo.wrapMutate(current);
  else if (point.property === "getTales") holder[point.property] = memo.wrapGetTales(current);
  else if (point.property === "activeTales") holder[point.property] = memo.wrapActiveTales(current);
  else holder[point.property] = memo.wrapForSystem(current);
  return true;
}

function checkIncursionObsolete(key, state, filename) {
  if (state.incursionObsoleteChecked || key === "gameStore" || !filename || incursionDisabledReason(state)) return;
  state.incursionObsoleteChecked = true;
  const path = require("path");
  const dir = path.dirname(filename);
  const sources = {
    store: readSourceText(path.join(dir, "incursionLifecycleStore.js")),
    lifecycle: readSourceText(path.join(dir, "incursionLifecycle.js")),
  };
  if (require("./lib/incursionTalesMemo").fixedUpstream(sources)) {
    state.incursion.disable("obsolete", "EveJS reads it itself: incursionLifecycleStore.readShared");
  }
}

function patchIncursionTarget(key, exportsValue, state, filename) {
  let count = 0;
  if (INCURSION_POINTS.some((point) => point.target === key)) checkIncursionObsolete(key, state, filename);
  for (const point of INCURSION_POINTS) {
    if (point.target !== key) continue;
    state.incursionTargetsSeen.add(key);
    if (state.patched.has(point.symbol)) continue;
    if (incursionDisabledReason(state)) break;
    try {
      if (patchIncursionPoint(point, exportsValue, state.incursion, filename, state)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.incursion.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function readBountySources(filename) {
  const rootInfo = serverSrcRootOf(filename);
  if (!rootInfo) return { stateSource: "", charSource: "", proxySource: "" };
  const path = require("path");
  const services = path.join(rootInfo.root, "services");
  return {
    stateSource: readSourceText(path.join(services, "bounty", "playerBountyState.js")),
    charSource: readSourceText(path.join(services, "character", "characterState.js")),
    proxySource: readSourceText(path.join(services, "bounty", "bountyProxyService.js")),
  };
}

function playerBountyStateLoaded(characterStateFilename) {
  if (!characterStateFilename) return false;
  const path = require("path");
  const entry = Module._cache[path.join(path.dirname(characterStateFilename), "..", "bounty", "playerBountyState.js")];
  return Boolean(entry && entry.loaded);
}

function patchBountyPoint(point, exportsValue, state, filename, via) {
  const bounty = state.bounty;
  if (!state.bountySourceChecked) {
    state.bountySourceChecked = true;
    const bountySources = readBountySources(filename);
    if (require("./lib/bountyPoolRead").fixedUpstream(bountySources)) {
      bounty.disable("obsolete", "EveJS reads it itself: playerBountyState.getPools");
      return false;
    }
    const fingerprint = bounty.checkFingerprint(bountySources);
    if (!fingerprint.ok) {
      bounty.disable("drift", fingerprint.detail);
      return false;
    }
  }
  if (bounty.status().disabledReason) return false;
  if (point.kind === "deps") {
    return point.target === "characterState" ? bounty.setCharDeps(exportsValue) : bounty.setPoolDeps(exportsValue);
  }
  if (point.kind === "proxyDeps") return typeof exportsValue === "function" && Boolean(exportsValue.prototype);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfBounty) return true;
  if (point.kind === "char" && !state.patched.has(BOUNTY_DEPS_CHAR_SYMBOL)) return false;
  if (current.name !== point.property) {
    bounty.disable("order", point.property);
    return false;
  }
  if (point.kind === "scope") {
    holder[point.property] = bounty.wrapScope(current);
    return true;
  }
  if (point.kind === "pool") {
    holder[point.property] = bounty.wrapGetPool(current);
    return true;
  }
  holder[point.property] = bounty.wrapGetCharacterRecord(current);
  if (via === "sweep") bounty.disable("late_wrap", "sweep");
  else if (playerBountyStateLoaded(filename)) bounty.disable("late_wrap", "playerBountyState loaded before characterState wrap");
  return true;
}

function patchBountyTarget(key, exportsValue, state, filename, via) {
  let count = 0;
  for (const point of BOUNTY_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (bountyDisabledReason(state)) break;
    try {
      if (patchBountyPoint(point, exportsValue, state, filename, via)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.bounty.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchCareerStandingPoint(point, exportsValue, memo, filename) {
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfCareerStanding || current.__hotPathPerfCorpMemo) return true;
  if (!memo.checkSource(point.target, readSourceText(filename))) return false;
  holder[point.property] = point.kind === "scope" ? memo.wrapObserve(current) : memo.wrapGetCorporationRecord(current);
  return true;
}

function checkCareerStandingObsolete(key, state, filename) {
  if (state.careerStandingObsoleteChecked || !filename || careerStandingDisabledReason(state)) return;
  state.careerStandingObsoleteChecked = true;
  const path = require("path");
  const file = key === "careerStanding" ? filename : path.join(path.dirname(filename), "..", "career", "careerStandingSources.js");
  if (require("./lib/careerStandingCorpMemo").fixedUpstream(readSourceText(file))) {
    state.careerStandingMemo.disable("obsolete", "EveJS reads it itself: careerStandingSources.standingEvidence");
  }
}

function patchCareerStandingTarget(key, exportsValue, state, filename) {
  let count = 0;
  if (CAREER_STANDING_POINTS.some((point) => point.target === key)) checkCareerStandingObsolete(key, state, filename);
  for (const point of CAREER_STANDING_POINTS) {
    if (point.target !== key) continue;
    if (point.lazy) state.careerReprocessingTargetsSeen.add(key);
    if (state.patched.has(point.symbol)) continue;
    if (careerStandingDisabledReason(state)) break;
    try {
      if (patchCareerStandingPoint(point, exportsValue, state.careerStandingMemo, filename)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.careerStandingMemo.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function readReprocessingSettlementSource(custodyFilename) {
  if (!custodyFilename) return "";
  const path = require("path");
  return readSourceText(path.join(path.dirname(custodyFilename), "../reprocessing/reprocessingSettlementState.js"));
}

function patchReceiptRetirePoint(point, exportsValue, retire, filename) {
  if (point.kind === "storeDeps") return retire.setStoreDeps(exportsValue);
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfReceiptRetire) return true;
  if (!retire.checkSource("custody", readSourceText(filename))) return false;
  if (!retire.checkSource("settlement", readReprocessingSettlementSource(filename))) return false;
  if (current.name !== point.property) {
    retire.disable("order", point.property);
    return false;
  }
  holder[point.property] = retire.wrapRetire(current);
  return true;
}

function patchReceiptRetireTarget(key, exportsValue, state, filename) {
  let count = 0;
  for (const point of RECEIPT_RETIRE_POINTS) {
    if (point.target !== key) continue;
    if (point.lazy) state.careerReprocessingTargetsSeen.add(key);
    if (state.patched.has(point.symbol)) continue;
    if (receiptRetireDisabledReason(state)) break;
    try {
      if (patchReceiptRetirePoint(point, exportsValue, state.receiptRetire, filename)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.receiptRetire.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function readInstanceRefSources(filename) {
  if (!filename) return { site: "", tracking: "", runtime: "", runtimeState: "" };
  const path = require("path");
  const dir = path.dirname(filename);
  return {
    site: readSourceText(path.join(dir, "dungeonUniverseSiteService.js")),
    tracking: readSourceText(path.join(dir, "dungeonTrackingRuntime.js")),
    runtime: readSourceText(filename),
    runtimeState: readSourceText(path.join(dir, "dungeonRuntimeState.js")),
  };
}

function patchInstanceRefPoint(point, exportsValue, state, filename) {
  const ref = state.instanceRef;
  if (point.kind === "deps") {
    if (!ref.setDeps(exportsValue)) return false;
    if (!state.instanceRefSourceChecked) {
      state.instanceRefSourceChecked = true;
      if (!ref.checkSources(readInstanceRefSources(filename)).ok) return false;
    }
    return !ref.status().disabledReason;
  }
  const holder = holderOf(point, exportsValue);
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, point.property)) return false;
  const current = holder[point.property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerfInstanceRef) return true;
  if (current.name !== point.property || holder[MOON_OVERLAY_MARKER]) {
    ref.disable("order", point.property);
    return false;
  }
  holder[point.property] = ref.wrapGetInstance(current);
  return true;
}

function patchInstanceRefTarget(key, exportsValue, state, filename) {
  let count = 0;
  for (const point of DUNGEON_REF_POINTS) {
    if (point.target !== key || state.patched.has(point.symbol)) continue;
    if (instanceRefDisabledReason(state)) break;
    try {
      if (patchInstanceRefPoint(point, exportsValue, state, filename)) {
        state.patched.add(point.symbol);
        count += 1;
      }
    } catch (error) {
      state.instanceRef.disable("error", String(error && error.message || error));
    }
  }
  return count;
}

function patchTarget(key, exportsValue, state, filename, via) {
  const { wrapProperty } = require("./lib/slowCalls");
  let count = state.prewarm ? patchPrewarmTarget(key, exportsValue, state) : 0;
  if (state.index) count += patchIndexTarget(key, exportsValue, state);
  if (state.retention) count += patchRetentionTarget(key, exportsValue, state);
  if (state.career) count += patchCareerTarget(key, exportsValue, state, filename);
  if (state.combat) count += patchCombatTarget(key, exportsValue, state, filename);
  if (state.template) count += patchTemplateTarget(key, exportsValue, state, filename);
  if (state.rock) count += patchRockTarget(key, exportsValue, state);
  if (state.structures) count += patchStructuresTarget(key, exportsValue, state);
  if (state.drone) count += patchDroneTarget(key, exportsValue, state);
  if (state.tickStruct) count += patchTickStructTarget(key, exportsValue, state);
  if (state.bpRead) count += patchBpReadTarget(key, exportsValue, state, filename);
  if (state.wreck) count += patchWreckTarget(key, exportsValue, state, filename);
  if (state.configMemo) count += patchConfigMemoTarget(key, exportsValue, state, filename);
  if (state.sovEcho) count += patchSovEchoTarget(key, exportsValue, state, filename, via);
  if (state.cyno) count += patchCynoTarget(key, exportsValue, state);
  if (state.incursion) count += patchIncursionTarget(key, exportsValue, state, filename);
  if (state.bounty) count += patchBountyTarget(key, exportsValue, state, filename, via);
  if (state.careerStandingMemo) count += patchCareerStandingTarget(key, exportsValue, state, filename);
  if (state.receiptRetire) count += patchReceiptRetireTarget(key, exportsValue, state, filename);
  if (state.instanceRef) count += patchInstanceRefTarget(key, exportsValue, state, filename);
  for (const point of POINTS) {
    if (point.target !== key || !state.expected.has(point.symbol) || state.patched.has(point.symbol)) continue;
    const holder = holderOf(point, exportsValue);
    if (!holder) continue;
    if (wrapProperty(holder, point.property, state.recorder, optionsFor(point, state.recorder))) {
      state.patched.add(point.symbol);
      count += 1;
    }
  }
  return count;
}

function installHook(state) {
  const previousLoad = Module._load;
  const resolved = new Map();
  Module._load = function hotPathPerfLoad(request, parent, isMain) {
    const result = previousLoad.apply(this, arguments);
    try {
      if (state.stallWatchPending) maybeStartStallWatch(state);
      if (!state.gameSeen && parent && isGameModuleFile(parent.filename)) state.gameSeen = true;
      if (allPatched(state)) return result;
      patchFromCache(state, parent);
      if (typeof request !== "string" || Module.isBuiltin(request)) return result;
      if (!state.requestPattern.test(request)) return result;
      const cacheKey = request + "\u0000" + (parent && parent.filename);
      let filename = resolved.get(cacheKey);
      if (filename === undefined) {
        try {
          filename = Module._resolveFilename(request, parent, isMain);
        } catch (_error) {
          filename = null;
        }
        resolved.set(cacheKey, filename);
      }
      const key = targetOf(filename);
      if (key) {
        if (marksGame(key)) state.gameSeen = true;
        patchTarget(key, result, state, filename);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} hook error: ${error && error.stack || error}`);
    }
    return result;
  };
}

function sweepModuleCache(state, cache = Module._cache) {
  if (allPatched(state)) return 0;
  let count = 0;
  for (const filename of Object.keys(cache || {})) {
    const key = targetOf(filename);
    if (!key) continue;
    const entry = cache[filename];
    if (entry && entry.loaded) count += patchTarget(key, entry.exports, state, filename, "sweep");
  }
  return count;
}

function probeMessage(state) {
  if (!state.gameSeen) return null;
  const missing = missingSymbols(state, {
    keepRetentionDrift: true, keepCareerDrift: true, keepCombatDrift: true, keepTemplateDrift: true, keepRockDrift: true,
    keepStructuresDrift: true, keepDroneDrift: true, keepTickStructDrift: true, keepBpReadDrift: true, keepWreckDrift: true,
    keepConfigMemoDrift: true, keepSovEchoDrift: true, keepCynoDrift: true, lazyCareer: true, lazyRock: true,
    keepIncursionDrift: true, lazyIncursion: true,
    keepBountyDrift: true,
    keepCareerReprocessingDrift: true, lazyCareerReprocessing: true,
    keepInstanceRefDrift: true,
  });
  const careerReprocessingNote = careerReprocessingProbeNote(state);
  const instanceRefReason = instanceRefDisabledReason(state);
  const bountyReason = bountyDisabledReason(state);
  const incursionReason = incursionDisabledReason(state);
  const incursionWaiting = Boolean(state.incursion) && !incursionReason &&
    INCURSION_REQUIRED.some((symbol) => incursionLazyWaiting(state, symbol));
  const sovEchoReason = sovEchoDisabledReason(state);
  const cynoReason = cynoDisabledReason(state);
  const configMemoReason = configMemoDisabledReason(state);
  const bpReadReason = bpReadDisabledReason(state);
  const wreckReason = wreckDisabledReason(state);
  const structReason = structuresDisabledReason(state);
  const droneReason = droneDisabledReason(state);
  const tickStructReason = tickStructDisabledReason(state);
  const rockReason = rockDisabledReason(state);
  const rockWaiting = Boolean(state.rock) && !rockReason && [...ROCK_LAZY.keys()].some((symbol) => rockLazyWaiting(state, symbol));
  const reason = indexDisabled(state) ? state.index.status().disabledReason : null;
  const retentionReason = retentionDisabledReason(state);
  const careerReason = careerDisabledReason(state);
  const templateReason = templateDisabledReason(state);
  const careerWaiting = Boolean(state.career) && !careerReason && !state.careerModuleSeen;
  const note = (reason ? `; dungeonIndex disabled: ${reason}` : "") +
    (retentionReason ? `; sceneRetention disabled: ${retentionReason}` : "") +
    (careerReason ? `; careerAbyssalRead disabled: ${careerReason}` : "") +
    (careerWaiting ? "; careerAbyssalRead waiting" : "") +
    (combatDisabledReason(state) ? `; careerCombatItemsRead disabled: ${combatDisabledReason(state)}` : "") +
    (templateReason ? `; templateReadOnly disabled: ${templateReason}` : "") +
    (rockReason ? `; rockRemainderCoalesce disabled: ${rockReason}` : "") +
    (rockWaiting ? "; rockRemainderCoalesce waiting" : "") +
    (structReason ? `; structuresSystemFilter disabled: ${structReason}` : "") +
    (droneReason ? `; dronePersistCoalesce disabled: ${droneReason}` : "") +
    (tickStructReason ? `; tickStructuresThrottle disabled: ${tickStructReason}` : "") +
    (bpReadReason ? `; blueprintOwnerRead disabled: ${bpReadReason}` : "") +
    (wreckReason ? `; nativeWreckList disabled: ${wreckReason}` : "") +
    (configMemoReason ? `; configSnapshotMemo disabled: ${configMemoReason}` : "") +
    (sovEchoReason ? `; sovCaptureOwnedEchoSkip disabled: ${sovEchoReason}` : "") +
    (cynoReason ? `; cynoBroadcastSessionFilter disabled: ${cynoReason}` : "") +
    (incursionReason ? `; incursionTalesMemo disabled: ${incursionReason}` : "") +
    (incursionWaiting ? "; incursionTalesMemo waiting" : "") +
    (bountyReason ? `; bountyPoolRead disabled: ${bountyReason}` : "") +
    (instanceRefReason ? `; dungeonInstanceRef disabled: ${instanceRefReason}` : "") +
    careerReprocessingNote;
  if (missing.length > 0) {
    return `DRIFT: ${missing.join(", ")} — these measurement points do not work (others: ${state.patched.size})${note}`;
  }
  return `probe: passed (${state.patched.size} measurement points)${note}`;
}

function checkIndexDrift(state) {
  if (!state.index || !state.gameSeen || indexDisabled(state)) return false;
  const missing = INDEX_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.index.disable("drift", missing.join(", "));
  return true;
}

function checkRetentionDrift(state) {
  if (!state.retention || !state.gameSeen || retentionDisabledReason(state)) return false;
  const missing = RETENTION_POINTS.map((p) => p.symbol).filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.retention.disable("drift", missing.join(", "));
  return true;
}

function checkCareerDrift(state) {
  if (!state.career || !state.gameSeen || careerDisabledReason(state)) return false;
  const missing = CAREER_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.career.disable("drift", missing.join(", "));
  return true;
}

function checkCombatDrift(state) {
  if (!state.combat || !state.gameSeen || combatDisabledReason(state)) return false;
  const missing = COMBAT_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.combat.disable("drift", missing.join(", "));
  return true;
}

function checkTemplateDrift(state) {
  if (!state.template || !state.gameSeen || templateDisabledReason(state)) return false;
  const missing = TEMPLATE_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.template.disable("drift", missing.join(", "));
  return true;
}

function checkRockDrift(state) {
  if (!state.rock || !state.gameSeen || rockDisabledReason(state)) return false;
  const missing = ROCK_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.rock.disable("drift", missing.join(", "));
  return true;
}

function checkStructuresDrift(state) {
  if (!state.structures || !state.gameSeen || structuresDisabledReason(state)) return false;
  const missing = STRUCT_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.structures.disable("drift", missing.join(", "));
  return true;
}

function checkDroneDrift(state) {
  if (!state.drone || !state.gameSeen || droneDisabledReason(state)) return false;
  const missing = DRONE_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.drone.disable("drift", missing.join(", "));
  return true;
}

function checkTickStructDrift(state) {
  if (!state.tickStruct || !state.gameSeen || tickStructDisabledReason(state)) return false;
  const missing = TICKSTRUCT_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.tickStruct.disable("drift", missing.join(", "));
  return true;
}

function checkBpReadDrift(state) {
  if (!state.bpRead || !state.gameSeen || bpReadDisabledReason(state)) return false;
  const missing = BPREAD_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.bpRead.disable("drift", missing.join(", "));
  return true;
}

function checkWreckDrift(state) {
  if (!state.wreck || !state.gameSeen || wreckDisabledReason(state)) return false;
  const missing = WRECK_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.wreck.disable("drift", missing.join(", "));
  return true;
}

function checkConfigMemoDrift(state) {
  if (!state.configMemo || !state.gameSeen || configMemoDisabledReason(state)) return false;
  const missing = CONFIG_MEMO_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.configMemo.disable(`drift:${missing.join(",")}`);
  return true;
}

function checkSovEchoDrift(state) {
  if (!state.sovEcho || !state.gameSeen || sovEchoDisabledReason(state)) return false;
  const missing = SOV_ECHO_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.sovEcho.disable("drift", missing.join(", "));
  return true;
}

function sovEchoStateText(state) {
  if (!state || !state.sovEcho) return "off";
  const s = state.sovEcho.snapshot();
  return s.state === "disabled" ? `disabled:${s.reason}` : s.state;
}

function sovEchoStatsLine(state) {
  if (!state || !state.sovEcho) return null;
  const s = state.sovEcho.snapshot();
  const line = `sovCaptureEcho stats state=${sovEchoStateText(state)} masked=${s.masked} calls=${s.calls}`;
  if (line === state.sovEchoStatsLast) return null;
  state.sovEchoStatsLast = line;
  return line;
}

function checkCynoDrift(state) {
  if (!state.cyno || !state.gameSeen || cynoDisabledReason(state)) return false;
  const missing = CYNO_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.cyno.disable("drift", missing.join(", "));
  return true;
}

function cynoStateText(state) {
  if (!state || !state.cyno) return "off";
  const s = state.cyno.snapshot();
  return s.state === "disabled" ? `disabled:${s.reason}` : s.state;
}

function checkIncursionDrift(state) {
  if (!state.incursion || !state.gameSeen || incursionDisabledReason(state)) return false;
  const missing = INCURSION_REQUIRED.filter((symbol) => !state.patched.has(symbol) && !incursionLazyWaiting(state, symbol));
  if (missing.length === 0) return false;
  state.incursion.disable("drift", missing.join(", "));
  return true;
}

function incursionStateText(state) {
  if (!state || !state.incursion) return "off";
  return state.incursion.stateText();
}

function checkBountyDrift(state) {
  if (!state.bounty || !state.gameSeen || bountyDisabledReason(state)) return false;
  const missing = BOUNTY_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.bounty.disable("drift", missing.join(", "));
  return true;
}

function bountyStateText(state) {
  const reason = bountyDisabledReason(state);
  return reason ? `disabled:${reason}` : "on";
}

function checkInstanceRefDrift(state) {
  if (!state.instanceRef || !state.gameSeen || instanceRefDisabledReason(state)) return false;
  const missing = DUNGEON_REF_REQUIRED.filter((symbol) => !state.patched.has(symbol));
  if (missing.length === 0) return false;
  state.instanceRef.disable("drift", missing.join(", "));
  return true;
}

function checkCareerReprocessingDrift(state) {
  let changed = false;
  for (const [feature, points] of [[state.careerStandingMemo, CAREER_STANDING_REQUIRED], [state.receiptRetire, RECEIPT_RETIRE_REQUIRED]]) {
    if (!feature || !state.gameSeen || feature.status().disabledReason) continue;
    const missing = points.filter((symbol) => !state.patched.has(symbol) && !careerReprocessingLazyWaiting(state, symbol));
    if (missing.length === 0) continue;
    feature.disable("drift", missing.join(", "));
    changed = true;
  }
  return changed;
}

function careerStandingStateText(state) {
  if (!state || !state.careerStandingMemo) return "off";
  const reason = careerStandingDisabledReason(state);
  if (reason) return `disabled:${reason}`;
  return CAREER_STANDING_REQUIRED.some((symbol) => careerReprocessingLazyWaiting(state, symbol)) ? "waiting" : "on";
}

function receiptRetireStateText(state) {
  if (!state || !state.receiptRetire) return "off";
  const reason = receiptRetireDisabledReason(state);
  if (reason) return `disabled:${reason}`;
  return RECEIPT_RETIRE_REQUIRED.some((symbol) => careerReprocessingLazyWaiting(state, symbol)) ? "waiting" : "on";
}

function careerReprocessingProbeNote(state) {
  const career = careerStandingStateText(state);
  const retire = receiptRetireStateText(state);
  return (career !== "off" && career !== "on" ? `; careerStandingCorpMemo ${career.replace(":", ": ")}` : "") +
    (retire !== "off" && retire !== "on" ? `; reprocessingReceiptRetireDefer ${retire.replace(":", ": ")}` : "");
}

function startStatsLog(state) {
  const minutes = state.config.statsLogMinutes;
  if (!minutes) return null;
  const timer = setInterval(() => {
    if (!state.gameSeen) return;
    try {
      for (const line of state.recorder.drainStatsLines()) log(line);
      if (state.index) for (const line of state.index.drainStatsLines()) log(line);
      if (state.retention) for (const line of state.retention.drainStatsLines()) log(line);
      if (state.career) for (const line of state.career.drainStatsLines()) log(line);
      if (state.combat) for (const line of state.combat.drainStatsLines()) log(line);
      if (state.template) for (const line of state.template.drainStatsLines()) log(line);
      if (state.rock) for (const line of state.rock.drainStatsLines()) log(line);
      if (state.structures) for (const line of state.structures.drainStatsLines()) log(line);
      if (state.drone) for (const line of state.drone.drainStatsLines()) log(line);
      if (state.tickStruct) for (const line of state.tickStruct.drainStatsLines()) log(line);
      if (state.bpRead) for (const line of state.bpRead.drainStatsLines()) log(line);
      if (state.wreck) for (const line of state.wreck.drainStatsLines()) log(line);
      if (state.configMemo) for (const line of state.configMemo.drainStatsLines()) log(line);
      if (state.dueGate) for (const line of state.dueGate.drainStatsLines()) log(line);
      const sovEchoLine = sovEchoStatsLine(state);
      if (sovEchoLine) log(sovEchoLine);
      if (state.cyno) for (const line of state.cyno.drainStatsLines()) log(line);
      if (state.incursion) for (const line of state.incursion.drainStatsLines()) log(line);
      if (state.bounty) for (const line of state.bounty.drainStatsLines()) log(line);
      if (state.careerStandingMemo) for (const line of state.careerStandingMemo.drainStatsLines()) log(line);
      if (state.receiptRetire) for (const line of state.receiptRetire.drainStatsLines()) log(line);
      if (state.instanceRef) for (const line of state.instanceRef.drainStatsLines()) log(line);
      if (state.stallWatch) {
        const s = state.stallWatch.stats();
        log(`stallWatch stalls=${s.stalls} maxGapMs=${s.maxGapMs} samples=${s.samples}`);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} stats error: ${error && error.message || error}`);
    }
  }, minutes * 60000);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function startDriftProbe(state) {
  const timer = setTimeout(() => {
    try {
      if (state.gameSeen) sweepModuleCache(state);
      checkIndexDrift(state);
      checkRetentionDrift(state);
      checkCareerDrift(state);
      checkCombatDrift(state);
      checkTemplateDrift(state);
      checkRockDrift(state);
      checkStructuresDrift(state);
      checkDroneDrift(state);
      checkTickStructDrift(state);
      checkBpReadDrift(state);
      checkWreckDrift(state);
      checkConfigMemoDrift(state);
      checkSovEchoDrift(state);
      checkCynoDrift(state);
      checkIncursionDrift(state);
      checkBountyDrift(state);
      checkCareerReprocessingDrift(state);
      checkInstanceRefDrift(state);
      const message = probeMessage(state);
      if (message) log(message);
    } catch (error) {
      console.error(`${LOG_PREFIX} probe error: ${error && error.message || error}`);
    }
  }, PROBE_DELAY_MS);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

const SCHEDULER_QUEUE_TARGETS = Object.freeze({
  orderedProcessClient: "/services/_shared/orderedProcessClient.js",
  durableScheduler: "/services/scheduler/durableScheduler.js",
  productionScheduler: "/services/scheduler/productionSchedulerRuntime.js",
});
const SCHEDULER_QUEUE_REQUEST = /orderedProcessClient|durableScheduler|productionSchedulerRuntime/;

function schedulerQueueTargetOf(filename) {
  const normalized = String(filename || "").replace(/\\/g, "/");
  const at = normalized.lastIndexOf("/server/src/");
  if (at < 0) return null;
  const rel = normalized.slice(at + "/server/src".length);
  for (const [key, suffix] of Object.entries(SCHEDULER_QUEUE_TARGETS)) {
    if (rel === suffix) return key;
  }
  return null;
}

function installSchedulerQueueHook(schedulerQueue) {
  const previousLoad = Module._load;
  const resolved = new Map();
  Module._load = function hotPathPerfSchedulerQueueLoad(request, parent, isMain) {
    const result = previousLoad.apply(this, arguments);
    try {
      if (typeof request !== "string" || !SCHEDULER_QUEUE_REQUEST.test(request)) return result;
      const cacheKey = request + "\u0000" + (parent && parent.filename);
      let filename = resolved.get(cacheKey);
      if (filename === undefined) {
        try {
          filename = Module._resolveFilename(request, parent, isMain);
        } catch (_error) {
          filename = null;
        }
        resolved.set(cacheKey, filename);
      }
      const key = schedulerQueueTargetOf(filename);
      if (key === "orderedProcessClient") schedulerQueue.patchExports(result);
      else if (key === "durableScheduler") schedulerQueue.checkDrift();
      else if (key === "productionScheduler") schedulerQueue.patchProductionRuntime(result);
    } catch (error) {
      console.error(`${LOG_PREFIX} scheduler queue hook error: ${error && error.stack || error}`);
    }
    return result;
  };
}

function maybeStartStallWatch(state) {
  const deps = state.stallWatchDeps || {};
  const lib = state.stallWatchLib;
  const env = deps.env || process.env;
  const argv1 = deps.argv1 !== undefined ? deps.argv1 : process.argv[1];
  const decision = lib.shouldStart({
    env, argv1, isMainThread: deps.isMainThread !== undefined ? deps.isMainThread : isMainThread,
    enabled: state.config.stallWatch === true,
  });
  if (!decision.start) {
    if (decision.reason !== "no_role") state.stallWatchPending = false;
    return decision;
  }
  state.stallWatchPending = false;
  const c = state.config;
  const argvPath = String(argv1 || "").replace(/\\/g, "/");
  const serverRoot = /\/server\/index\.js$/.test(argvPath) ? argvPath.slice(0, -"/index.js".length) : null;
  const started = lib.startStallWatch({
    thresholdMs: c.stallWatchThresholdMs, sampleEveryMs: c.stallWatchSampleEveryMs, maxSamples: c.stallWatchMaxSamples,
    frames: c.stallWatchFrames, windowMs: c.stallWatchWindowMs, heartbeatMs: c.stallWatchHeartbeatMs,
    workerFile: lib.WORKER_FILE, serverRoot, log: deps.log || log,
    createWorker: deps.createWorker, setInterval: deps.setInterval, setTimeout: deps.setTimeout,
  });
  if (!started.ok) {
    (deps.log || log)(`stallWatch: off (${started.reason})`);
    return { start: false, reason: started.reason };
  }
  state.stallWatch = started.watch;
  (deps.log || log)(`stallWatch: armed pid=${process.pid} role=world thresholdMs=${c.stallWatchThresholdMs}` +
    ` windowMs=${c.stallWatchWindowMs} sampleEveryMs=${c.stallWatchSampleEveryMs} maxSamples=${c.stallWatchMaxSamples}`);
  return decision;
}

function createDueGateOf(config, logFn = log, state = null) {
  const { createSchedulerDueGate, parseGateTypes } = require("./lib/schedulerDueGate");
  const { types } = parseGateTypes(config.schedulerDueGateTypes);
  if (types.length === 0) {
    logFn("scheduler due gate: off (schedulerDueGateTypes empty)");
    return null;
  }
  return createSchedulerDueGate({
    types,
    releaseDelayMs: config.schedulerDueGateReleaseDelayMs,
    maxHoldMs: config.schedulerDueGateMaxHoldMs,
    pumpIntervalMs: config.schedulerDueGatePumpIntervalMs,
    batch: config.schedulerDueGateBatch,
    maxInFlight: config.schedulerDueGateMaxInFlight,
    minLeaseLeftMs: config.schedulerDueGateMinLeaseLeftMs,
    staleDropMs: config.schedulerDueGateStaleDropMs,
    maxHeld: config.schedulerDueGateMaxHeld,
    unseenReleaseMs: config.schedulerDueGateUnseenReleaseMs,
    log: logFn,
    slowCallMs: config.schedulerOwnersSlowCallMs,
    onPhase: state ? (p) => { if (state.stallWatch) state.stallWatch.setPhase(p); } : undefined,
    onBreadcrumb: state ? (label) => { if (state.stallWatch) state.stallWatch.breadcrumb(label); } : undefined,
  });
}

function install(options = {}) {
  const env = options.env || process.env;
  if (env[NO_INSTALL_ENV] === "1" || !isMainThread) return null;
  try {
    const { loadConfig } = require("./config");
    const config = options.config || loadConfig({ env });
    if (!config.enabled) {
      log(`v${MOD_VERSION} disabled (enabled=false), wraps nothing`);
      return null;
    }
    if (globalThis[INSTALL_FLAG]) return null;
    globalThis[INSTALL_FLAG] = true;
    const { createRecorder } = require("./lib/slowCalls");
    const state = createState(config, createRecorder(config, log));
    state.stallWatch = null;
    state.stallWatchPending = config.stallWatch === true;
    state.stallWatchDeps = options.stallWatchDeps || null;
    state.stallWatchLib = state.stallWatchPending ? require("./lib/stallWatch") : null;
    installHook(state);
    const dueGate = config.schedulerDueGate === true ? createDueGateOf(config, log, state) : null;
    if (config.schedulerMaxPending > 0 || config.schedulerRequestTimeoutMs > 0 || dueGate) {
      const { createSchedulerQueue } = require("./lib/schedulerQueue");
      state.schedulerQueue = createSchedulerQueue({
        limit: config.schedulerMaxPending, requestTimeoutMs: config.schedulerRequestTimeoutMs, log, dueGate,
      });
      state.dueGate = dueGate;
      installSchedulerQueueHook(state.schedulerQueue);
    }
    startStatsLog(state);
    startDriftProbe(state);
    if (config.structuresRefreshCoalesce === true && !state.structures) {
      log("WARN structuresRefreshCoalesce=true without structuresSystemFilter: no effect");
    }
    log(`v${MOD_VERSION} loaded (slowCallMs=${config.slowCallMs}, points=${state.expected.size}` +
      `${state.index ? `, dungeonIndex=on parity=${config.dungeonIndexParityCheck} maxEntries=${config.dungeonIndexMaxEntries}` : ""}` +
      `${state.retention ? `, sceneRetention=on maxTotal=${Math.floor(config.sceneRetentionMaxPinnedTotal)}` +
        ` pinDocked=${config.sceneRetentionPinDocked} pinRecent=${config.sceneRetentionPinRecent}` : ""}` +
      `${state.prewarm ? ", prewarmLocations=on" : ""}` +
      `${state.career ? `, careerAbyssalRead=on parity=${config.careerAbyssalReadParityCheck}` +
        ` reclassify=${config.careerAbyssalReadReclassifyPerCall} maxKeys=${config.careerAbyssalReadMaxKeys}` : ""}` +
      `${state.combat ? `, careerCombatItemsRead=on parity=${config.careerCombatItemsReadParityCheck}` : ""}` +
      `${state.template ? `, templateReadOnlyView=on parity=${config.templateReadOnlyViewParityCheck}` +
        ` rotate=${config.templateReadOnlyRotate}` : ""}` +
      `${state.rock ? `, rockRemainderCoalesce=on ms=${config.rockRemainderCoalesceMs}` +
        ` maxInstances=${config.rockRemainderCoalesceMaxInstances}` : ""}` +
      `${state.structures ? `, structuresSystemFilter=on parity=${config.structuresSystemFilterParityCheck}` +
        (config.structuresRefreshCoalesce === true ? ` structuresRefreshCoalesce=on freshMs=${config.structuresRefreshFreshMs}` : "") : ""}` +
      `${state.drone ? `, dronePersistCoalesce=on ms=${config.dronePersistCoalesceMs}` +
        ` maxItems=${config.dronePersistCoalesceMaxItems}` : ""}` +
      `${state.tickStruct ? `, tickStructuresThrottle=on minIntervalMs=${config.tickStructuresMinIntervalMs}` : ""}` +
      `${state.bpRead ? `, blueprintOwnerRead=on parity=${config.blueprintOwnerReadParityCheck}` : ""}` +
      `${state.wreck ? `, nativeWreckList=on parity=${config.nativeWreckListParityCheck}` : ""}` +
      `${state.bounty ? `, bountyPoolRead=${bountyStateText(state)} parity=${config.bountyPoolReadParityCheck}` : ""}` +
      `${state.template && config.templateReadOnlyCallers === true ? ", templateReadOnlyCallers=on" : ""}` +
      `${state.instanceRef ? `, dungeonInstanceRef=on parity=${config.dungeonInstanceRefParityCheck}` : ""}` +
      `${state.careerStandingMemo ? `, careerStandingCorpMemo=${careerStandingStateText(state)}` +
        ` parity=${config.careerStandingCorpMemoParityCheck}` : ""}` +
      `${state.receiptRetire ? `, reprocessingReceiptRetireDefer=${receiptRetireStateText(state)}` +
        ` delayMs=${config.reprocessingReceiptRetireDelayMs} maxPendingKeys=${config.reprocessingReceiptRetireMaxPendingKeys}` : ""}` +
      `${state.configMemo ? `, configSnapshotMemo=on revalidateMs=${config.configSnapshotMemoRevalidateMs}` +
        ` parity=${config.configSnapshotMemoParityCheck}` : ""}` +
      `${state.schedulerQueue ? `, schedulerMaxPending=${config.schedulerMaxPending}` +
        ` schedulerRequestTimeoutMs=${config.schedulerRequestTimeoutMs}` : ""}` +
      `${state.dueGate ? `, schedulerDueGate=on types=${config.schedulerDueGateTypes}` +
        ` maxInFlight=${config.schedulerDueGateMaxInFlight} releaseDelayMs=${config.schedulerDueGateReleaseDelayMs}` : ""}` +
      `, sovCaptureOwnedEchoSkip=${sovEchoStateText(state)}, cynoBroadcastSessionFilter=${cynoStateText(state)}` +
      `, incursionTalesMemo=${incursionStateText(state)})`);
    return state;
  } catch (error) {
    console.error(`${LOG_PREFIX} install failed, mod disabled: ${error && error.stack || error}`);
    return null;
  }
}

const installedState = install();

module.exports = {
  MOD_VERSION, TARGETS, POINTS, CACHE_MGR_HANDLERS, NO_INSTALL_ENV, INSTALL_FLAG,
  targetOf, isGameModuleFile, GAME_TARGETS, createState, holderOf, patchTarget, installHook, sweepModuleCache,
  serverSrcRootOf, patchFromCache,
  INDEX_POINTS, MOON_OVERLAY_MARKER, missingSymbols, checkIndexDrift,
  RETENTION_POINTS, checkRetentionDrift,
  PREWARM_POINTS,
  CAREER_POINTS, CAREER_REQUIRED, checkCareerDrift,
  COMBAT_POINTS, COMBAT_REQUIRED, checkCombatDrift,
  TEMPLATE_POINTS, TEMPLATE_ROTATE_POINT, TEMPLATE_REQUIRED, checkTemplateDrift, requestPatternFor,
  ROCK_POINTS, ROCK_REQUIRED, checkRockDrift,
  STRUCT_POINTS, STRUCT_REQUIRED, checkStructuresDrift,
  DRONE_POINTS, DRONE_REQUIRED, checkDroneDrift,
  TICKSTRUCT_POINTS, TICKSTRUCT_REQUIRED, checkTickStructDrift,
  BPREAD_POINTS, BPREAD_REQUIRED, checkBpReadDrift,
  WRECK_POINTS, WRECK_REQUIRED, checkWreckDrift,
  CONFIG_MEMO_POINTS, CONFIG_MEMO_REQUIRED, checkConfigMemoDrift,
  SOV_ECHO_POINTS, SOV_ECHO_REQUIRED, checkSovEchoDrift, sovEchoStateText, sovEchoStatsLine,
  CYNO_POINTS, CYNO_REQUIRED, checkCynoDrift, cynoStateText,
  INCURSION_POINTS, INCURSION_REQUIRED, checkIncursionDrift, incursionStateText, readIncursionSources,
  BOUNTY_POINTS, BOUNTY_REQUIRED, checkBountyDrift, bountyStateText, readBountySources,
  CAREER_STANDING_POINTS, CAREER_STANDING_REQUIRED, RECEIPT_RETIRE_POINTS, RECEIPT_RETIRE_REQUIRED,
  checkCareerReprocessingDrift, careerStandingStateText, receiptRetireStateText, readReprocessingSettlementSource,
  TEMPLATE_CALLERS_POINTS, DUNGEON_REF_POINTS, DUNGEON_REF_REQUIRED, checkInstanceRefDrift, readInstanceRefSources,
  probeMessage, install, installedState,
  SCHEDULER_QUEUE_TARGETS, schedulerQueueTargetOf, installSchedulerQueueHook, createDueGateOf, maybeStartStallWatch,
};
