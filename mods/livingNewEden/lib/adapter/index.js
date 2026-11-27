"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { GAME_MODULES } = require("./gameModules");
const { probeModules } = require("./probe");
const { resolveSqliteDriver } = require("./sqliteDriver");
const { registerShutdown, subscribeOwnerLost } = require("./gameStoreHooks");
const { flushTable } = require("./gameStoreFlush");
const { wrapTickSample } = require("./tickSample");
const { readStaticMapFrom } = require("./staticMap");
const { readPresenceFrom } = require("./sessionPresence");
const { wrapPresenceNudge } = require("./presenceHooks");
const { loadMapNames } = require("./mapNames");
const { resolveSystemFactionsFrom, readSdeBuildFrom } = require("./factionPolicy");
const { readNpcStationsFrom, listNpcStationsInSystemFrom } = require("./npcStations");
const { readSystemInteriorFrom } = require("./systemInterior");
const { readSystemBeltsFrom } = require("./asteroidBelts");
const { readSystemCelestialsFrom, readPlanetResourcesFrom } = require("./celestials");
const { readLocalResourcesFrom } = require("./localResources");
const { readItemTypeFactsFrom, readTypeLooksFrom } = require("./itemTypeFacts");
const { writeVirtualKillmailWith } = require("./virtualKillmail");
const { moveFreeCharacterWith, setCorporationDescriptionWith } = require("./freeCorpRecycle");
const { readWormholePairsFrom } = require("./wormholePairs");
const { applyStandingGrantFrom, readPirateFactionIdsFrom } = require("./standingWrite");
const { listReceiptKeysFrom, pruneReceiptsFrom } = require("./receiptPrune");
const { readPersonalContactsFrom, applyPersonalContactsFrom } = require("./personalContacts");
const { readCharacterStandingFrom } = require("./standingRead");
const { readBuildInputsFrom } = require("./buildInputs");
const {
  ensureSiteFrom,
  readSiteFrom,
  extendSiteFrom,
  despawnSiteFrom,
  purgeSiteFrom,
  checkTemplatesFrom,
  planPositionFrom,
  buildInstanceOptions,
} = require("./dungeonSites");
const {
  buildWantToBuyCall,
  findTradeContractFrom,
  readTradeContractFrom,
  readIssuerFrom,
  createWantToBuyFrom,
  deleteTradeContractFrom,
  adjustCorpDivisionFrom,
  divisionBalanceOf,
  adjustCharacterWalletFrom,
  characterBalanceOf,
  readCharacterFrom,
  listDeliveredStacksFrom,
  voidDeliveredStackFrom,
  listTaggedContractsFrom,
  grantSellStockFrom,
  readGrantReceiptFrom,
  createWantToSellFrom,
  createCourierFrom,
  failCourierFrom,
  parsePrivateContractFee,
} = require("./tradeContracts");
const { readTradePricesFrom } = require("./marketPrices");
const { readStationAsksFrom } = require("./stationAsks");
const { fetchExternalPricesWith, createDefaultHttpsGetter } = require("./externalPrices");
const {
  placeAndAttachBuyOrderFrom,
  readBuyOrderFrom,
  findBuyOrderFrom,
  attachBuyEscrowFrom,
  detachEscrowFrom,
  cancelBuyOrderFrom,
  listCorpOrdersFrom,
  listTaggedEscrowsFrom,
  isBuyOrderDurationAllowedFrom,
  stationMetadataFrom,
  parseMarketFillRule,
  findSellOrderFrom,
  placeAndAttachSellOrderFrom,
  returnSellEscrowFrom,
} = require("./tradeMarket");
const { loadModsFrom: loadNativeWreckModsFrom, createNativeWrecksFacade } = require("./nativeWrecks");
const { isTagStore, createTaggedEscrowState, createTaggedWreckStore } = require("./vendorTagViews");
const { createNpcSpawn, checkNpcSpawnFrom } = require("./npcSpawn");
const { createSceneNpcBudget } = require("./sceneNpcBudget");
const { createHuntScene, checkHuntSceneFrom } = require("./huntScene");
const { createBeltNavyScene, checkBeltNavySceneFrom } = require("./beltNavyScene");
const { attackLockOf } = require("./attackLock");
const miningEncounterSeams = require("./miningEncounters");
const ambientRatSeams = require("./ambientRats");
const officerSpawnSeams = require("./officerSpawn");
const bountySceneSeams = require("./bountyScene");
const nemesisEwarSeams = require("./nemesisEwar");
const concordResponseSeams = require("./concordResponse");
const heavyEventSeams = require("./heavyEventScene");
const highsecTrafficSeams = require("./highsecTrafficScene");
const situationSeams = require("./situationScene");
const { createPlayerSovSeam, neutralPlayerHubOf } = require("./playerSov");
const { createDeployGateTools } = require("./sovDeployGate");
const { createCapsuleSweepTools } = require("./capsuleSweep");
const { createBookmarkSiteWarpTools } = require("./bookmarkSiteWarp");
const liveProfiles = require("./data/liveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID } = require("./empireNavyCatalog");
const { CAPSULEER_LIVE_PROFILES } = require("./data/capsuleerLiveProfiles");
const { INVADER_LIVE_PROFILES } = require("./data/invaderLiveProfiles");
const { INDUSTRY_LIVE_PROFILES } = require("./data/industryLiveProfiles");
const { wrapContractAccepted } = require("./contractHooks");
const { createSiteScannerHide } = require("./siteScannerHide");
const { createChatCommandHook } = require("./chatCommand");
const { createSiteEntryHook, sendCharacterSystemLineWith } = require("./siteTalk");
const { createDockGateHook } = require("./dockGate");
const trigBridgeScope = require("./trigBridge");
const trigBridgeInstall = require("./trigBridgeInstall");
const trigBridgeLook = require("./trigBridgePresentation");
const { createPlayerMailAdapter } = require("./playerMail");
const { creditRewardIskFrom, creditRewardLpFrom } = require("./playerRewards");
const { rollOfficerLootFrom } = require("./bountyLoot");
const { createCorpIssuerAuthorityInstaller } = require("./corpContractIssuer");
const { createStructureSeam } = require("./structures");
const { createPlayerStructureSeam } = require("./playerStructures");
const { createPlayerSkyhookSeam } = require("./playerSkyhooks");
const { createHarvestBaySeam } = require("./harvestBays");
const { createPlayerOrgNames, readCharacterNamesFrom } = require("./playerOrgNames");
const { readVendorKillsFrom } = require("./vendorKills");
const sentrySeamsModule = require("./sentrySeams");
const { CONSUMER: GRID_ANCHORS_CONSUMER, UNAVAILABLE: GRID_ANCHORS_UNAVAILABLE,
  createGridAnchorSeam } = require("./gridAnchors");
const { createVirtualIdentitiesAdapter } = require("./virtualIdentities");
const liveLossHook = require("./liveLossHook");
const capsuleFx = require("./capsuleFx");
const dormancyGuard = require("./dormancyGuard");
const vendorPauses = require("./vendorPauses");
const capitalProfiles = require("./capitalProfiles");
const factionProfiles = require("./factionProfiles");
const { createLocalPilotsSeam, setOccupantLineObserver, clearOccupantLineObserver } = require("./localPilots");
const { createLocalTalkTap } = require("./localTalkTap");
const abyssalRuns = require("./abyssalRuns");
const trigDrifterLists = require("./trigDrifterLists");
const siteCompletion = require("./siteCompletion");
const siteHacks = require("./siteHacks");
const { createShipAiChannel } = require("./shipAiChannel");
const shipAiXmpp = require("./shipAiXmpp");
const shipAiMailHook = require("./shipAiMailHook");
const fameMarketHook = require("./fameMarketHook");
const { storeAiPortraitWith } = require("./shipAiPortrait");
const { buildUserDataXml: localPilotsXmppBuildUserData } = require("./localPilotsXmpp");
const { readShipTelemetryFrom, findItemTypeByNameFrom, readSkillSummaryFrom,
  readGridNpcsFrom } = require("./shipTelemetry");
const { readDirectionalScanFrom } = require("./shipAiDscan");
const { readWingCopiesFrom, readShipWingHpMarks, SHIP_WING_DIR } = require("./shipAiWing");
const { createShipWingUi } = require("./shipWingUi");
const { registerClientServiceWith, sendClientNotificationWith } = require("./clientService");
const { buildPayload: buildBoardPayload, createClientDelivery: createBoardDelivery,
  DELIVERY_KEY: BOARD_DELIVERY_KEY, createCompositeDelivery, PART_NAMES: CLIENT_PART_NAMES,
  PART_PRIORITY: CLIENT_PART_PRIORITY } = require("./clientDelivery");
const { HOOK_STATE_KEY: BOARD_HOOK_STATE_KEY } = require("./clientHandshakeHook");
const { readCrimeFlagsFrom, readSecurityStatusFrom } = require("./shipAiTriggers");
const { createMiningStopHook, createSiteClearedHook } = require("./shipAiActivity");
const { setShipAiKills, killWrapMounted } = require("./killObservation");
const { searchItemTypesFrom } = require("./itemSearch");
const { readCargoFrom, readFittingFrom, readPilotFrom, readAssetsFrom, readFindItemFrom, readWalletHistoryFrom,
  readWalletIncomeFrom, readSkillQueueFrom, readStandingsFrom, readKillmailsFrom, readMissionsFrom, readIndustryJobsFrom,
  readMarketOrdersFrom, readOrderStateFrom, readSkillHistoryFrom } = require("./shipAiDbRead");

const {
  ACTION,
  REASON,
  isFailure,
  isPermanentFailure,
  isTemporaryFailure,
  createBudget,
  DEFAULT_INVADER_FACTION_IDS,
  decideProjection,
  buildSovCall,
  decideWithBudget,
} = require("./sovProjection");

const STANDING_RUNTIME = "services/character/standingRuntime";
const CHARACTER_STATE = "services/character/characterState";
const WALLET_STATE = "services/account/walletState";
const LP_WALLET_STATE = "services/corporation/lpWalletState";

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function hasOwn(value, property) {
  return value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, property);
}

const SCANNER_PROVIDER_PATH = "services/exploration/signatures/providers/sceneAnomalySiteProvider";
const SCAN_MGR_PATH = "services/exploration/scanMgrService";
const CHAT_RUNTIME_PATH = "_secondary/chat/chatRuntime";
const DEFAULT_CHAT_COMMAND = "front";
const CHAT_LOG_DETAIL = 120;
const LOADED_MOD_LOADER_RE = /\/mods\/([^/]+)\/loader\.js$/;
const MOD_CONFIG_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MOD_CONFIG_FILE = "config.js";
const MOD_MANIFEST_FILE = "evejs-launcher.mod.json";
const MOD_CONFIG_DEFAULT_NEED = Object.freeze({ SCHEMA: "array", loadConfig: "function" });
const MOD_CONFIG_KIND_TESTS = Object.freeze({
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  function: (v) => typeof v === "function",
});
const DOCK_GATE_PATHS = Object.freeze({ beyonce: "services/ship/beyonceService", macho: "common/machoErrors",
  worldData: "space/worldData", itemStore: "services/inventory/itemStore" });
const DOCK_GATE_STATION_PATH = "services/_shared/stationStaticData";
const TRIG_BRIDGE_PATHS = Object.freeze({ jumpMgr: trigBridgeScope.JUMP_MGR_PATH, links: trigBridgeScope.LINKS_PATH,
  worldData: "space/worldData", runtime: "space/runtime", structureState: "services/structure/structureState",
  characterState: "services/character/characterState", macho: "common/machoErrors" });
const TRIG_INSTALL_PATHS = Object.freeze({ deliveryClass: trigBridgeInstall.DELIVERY_PATH,
  serviceHelpers: "services/_shared/serviceHelpers", itemStore: "services/inventory/itemStore",
  itemCustody: "services/inventory/itemCustody", characterState: "services/character/characterState",
  structureState: "services/structure/structureState", runtime: "space/runtime", worldData: "space/worldData",
  corpAuth: "services/corporation/corporationAuthority", itemTypes: "services/inventory/itemTypeRegistry",
  macho: "common/machoErrors" });
const TRIG_LOOK_PATHS = Object.freeze({ sceneModule: trigBridgeLook.SCENE_PATH,
  structureState: "services/structure/structureState", runtime: "space/runtime" });

function withScannerHide(hide, res) {
  if (!hide || !res || res.ok !== true || res.parked !== true
    || !Number.isSafeInteger(res.siteId) || res.siteId <= 0) return res;
  let h;
  try {
    h = hide.hide(res.systemId, res.siteId);
  } catch (_err) {
    h = null;
  }
  return { ...res, scanner: h && h.ok === true && h.notified === true ? "hidden" : "failed" };
}

function withScannerForget(hide, res) {
  if (hide && res && res.ok === true && res.purged === true && Number.isSafeInteger(res.siteId)) {
    try {
      hide.forget(res.siteId);
    } catch (_err) {
    }
  }
  return res;
}

function createAdapter(deps = {}) {
  const moduleApi = deps.moduleApi || {};
  const requireFn = typeof deps.requireFn === "function" ? deps.requireFn : (absolutePath) => require(absolutePath);
  const existsSync = typeof deps.existsSync === "function" ? deps.existsSync : fs.existsSync;
  const gameModules = Array.isArray(deps.gameModules) ? deps.gameModules : GAME_MODULES;
  const allowed = new Set(gameModules.map((entry) => entry.path));
  const logAdapter = (line) => {
    try {
      if (deps.logger && typeof deps.logger.log === "function") deps.logger.log(line);
    } catch (_err) {
    }
  };

  let vendorTags = null;
  let legacyTagLogged = false;
  const vendorTagHooks = {
    onLegacy: () => {
      if (legacyTagLogged) return;
      legacyTagLogged = true;
      logAdapter("vendor record carries a legacy LNE tag; run tools/moveVendorTags.js before upgrading the save");
    },
    onPrune: (escrow, wreck) => logAdapter(`vendor tags pruned escrow=${escrow} wreck=${wreck}`),
  };

  function setVendorTagStore(tags) {
    if (tags === null) {
      vendorTags = null;
      return { ok: true };
    }
    if (!isTagStore(tags)) return { ok: false, reason: "INVALID_TAG_STORE" };
    vendorTags = tags;
    return { ok: true };
  }

  const state = {
    serverSrc: null,
    booted: false,
    report: null,
    loadedOutsideCache: [],
    sqliteDriver: null,
  };

  function setServerSrc(srcDir) {
    if (typeof srcDir !== "string" || srcDir === "") return { ok: false, reason: "server_src_invalid" };
    if (state.serverSrc !== null) {
      return state.serverSrc === srcDir ? { ok: true, reason: null } : { ok: false, reason: "server_src_already_set" };
    }
    state.serverSrc = srcDir;
    return { ok: true, reason: null };
  }

  function requireGame(relPath) {
    if (state.serverSrc === null) return { ok: false, reason: "server_src_unknown" };
    if (!allowed.has(relPath)) return { ok: false, reason: "not_in_game_modules" };
    const absolutePath = path.join(state.serverSrc, `${relPath}.js`);
    try {
      const cache = moduleApi._cache;
      if (hasOwn(cache, absolutePath) && cache[absolutePath]) {
        return { ok: true, exports: cache[absolutePath].exports };
      }
      if (!state.booted) return { ok: false, reason: "not_booted" };
      if (!existsSync(absolutePath)) return { ok: false, reason: "file_not_found" };
      const exportsObject = requireFn(absolutePath);
      if (!state.loadedOutsideCache.includes(relPath)) state.loadedOutsideCache.push(relPath);
      return { ok: true, exports: exportsObject };
    } catch (err) {
      return { ok: false, reason: `require_failed: ${(err && err.message) || err}` };
    }
  }

  function runProbe() {
    let report;
    if (state.serverSrc === null) {
      const reason = "server_src_not_found";
      const disabledModules = {};
      for (const entry of gameModules) {
        for (const s of entry.symbols || []) {
          for (const c of s.consumers || []) if (!hasOwn(disabledModules, c)) disabledModules[c] = reason;
        }
      }
      report = { modules: [], passed: false, counts: { ok: 0, drift: 0, missing: 0 }, disabledModules, error: reason };
    } else {
      report = probeModules(gameModules, { load: requireGame });
    }
    state.report = deepFreeze(report);
    return state.report;
  }

  function loadSqliteDriver() {
    if (state.serverSrc === null) return { ok: false, reason: "server_src_unknown" };
    if (state.sqliteDriver === null) state.sqliteDriver = resolveSqliteDriver(state.serverSrc);
    return state.sqliteDriver;
  }

  function registerShutdownHook(name, handler) {
    const loaded = requireGame("gameStore/index");
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    return registerShutdown(loaded.exports, name, handler);
  }

  function onPersistenceOwnerLost(listener) {
    const loaded = requireGame("gameStore/index");
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    return subscribeOwnerLost(loaded.exports, listener);
  }

  function subscribeTickSamples(onSample) {
    const loaded = requireGame("utils/tidiAutoscaler");
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    return wrapTickSample(loaded.exports, onSample);
  }

  function readPresence(opts = {}) {
    const registry = requireGame("services/chat/sessionRegistry");
    if (!registry.ok) return { ok: false, reason: registry.reason };
    return readPresenceFrom(registry.exports, opts);
  }

  function subscribeSessionNudges(onNudge) {
    const runtime = requireGame("space/runtime");
    if (!runtime.ok) return { ok: false, reason: runtime.reason };
    return wrapPresenceNudge(runtime.exports, onNudge);
  }

  function subscribeVendorPauses(onPause, opts = {}) {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "vendorPauses")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.vendorPauses) };
    }
    if (typeof onPause !== "function") return { ok: false, reason: "BAD_ARGUMENT" };
    const installed = vendorPauses.install(requireGame, { minMs: opts.minMs });
    if (!installed.ok) return installed;
    return { ok: true, unsubscribe: installed.subscribe(onPause), stats: installed.stats };
  }

  function readBuildInputs(opts = {}) {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "buildInputs")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.buildInputs) };
    }
    const install = requireGame("contentPacks/autoInstallContentPacks");
    if (!install.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: install.reason };
    const manager = requireGame("contentPacks/contentPackManager");
    if (!manager.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: manager.reason };
    return readBuildInputsFrom({ dropDirectory: install.exports.DROP_DIRECTORY, contentPackManager: manager.exports,
      fs, maxFiles: opts.maxFiles });
  }

  function readStaticMap() {
    const worldData = requireGame("space/worldData");
    if (!worldData.ok) return { ok: false, reason: worldData.reason };
    const band = requireGame("space/runtime/systemSecurityBand");
    if (!band.ok) return { ok: false, reason: band.reason };
    const mapNames = loadMapNames(deps.mapNamesFile ? { filePath: deps.mapNamesFile } : {});
    return readStaticMapFrom(worldData.exports, band.exports, { mapNames });
  }

  function resolveSystemFactions(systemIds) {
    const policy = requireGame("space/npc/pirateFactionPolicy");
    if (!policy.ok) return { ok: false, reason: "FACTION_POLICY_UNAVAILABLE", detail: policy.reason };
    return resolveSystemFactionsFrom(policy.exports, systemIds);
  }

  function readSdeBuild() {
    const storeRoot = requireGame("gameStore/storeRoot");
    if (!storeRoot.ok) return { ok: false, reason: "SDE_BUILD_UNAVAILABLE", detail: storeRoot.reason };
    let root;
    try {
      root = storeRoot.exports.resolveStoreRoot();
    } catch (err) {
      return { ok: false, reason: "SDE_BUILD_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
    const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
    return readSdeBuildFrom(root, readFileSync, path.join);
  }

  function readNpcStations(stationIds) {
    const worldData = requireGame("space/worldData");
    if (!worldData.ok) return { ok: false, reason: "WORLD_DATA_UNAVAILABLE", detail: worldData.reason };
    return readNpcStationsFrom(worldData.exports, stationIds);
  }

  function listNpcStationsInSystem(systemId) {
    const worldData = requireGame("space/worldData");
    if (!worldData.ok) return { ok: false, reason: "WORLD_DATA_DRIFT", detail: String(worldData.reason) };
    return listNpcStationsInSystemFrom(worldData.exports, systemId);
  }

  function readSystemInterior(systemId, opts) {
    const worldData = requireGame("space/worldData");
    if (!worldData.ok) return { ok: false, reason: "WORLD_DATA_DRIFT", detail: String(worldData.reason) };
    return readSystemInteriorFrom(worldData.exports, systemId, opts);
  }

  let gridAnchorSeam = null;
  function readGridAnchors(systemId, opts) {
    try {
      const disabled = state.report ? state.report.disabledModules : null;
      if (disabled && hasOwn(disabled, GRID_ANCHORS_CONSUMER)) {
        return { ok: false, reason: GRID_ANCHORS_UNAVAILABLE, detail: String(disabled[GRID_ANCHORS_CONSUMER]) };
      }
      if (gridAnchorSeam === null) gridAnchorSeam = createGridAnchorSeam({ requireGame });
      return gridAnchorSeam.readGridAnchors(systemId, opts);
    } catch (err) {
      return { ok: false, reason: GRID_ANCHORS_UNAVAILABLE, detail: String((err && err.message) || err) };
    }
  }

  function readSystemBelts(systemIds) {
    const asteroidData = requireGame("space/asteroids/asteroidData");
    if (!asteroidData.ok) return { ok: false, reason: "ASTEROID_DATA_UNAVAILABLE", detail: asteroidData.reason };
    return readSystemBeltsFrom(asteroidData.exports, systemIds);
  }

  function readSystemCelestials(systemIds, opts) {
    const worldData = requireGame("space/worldData");
    if (!worldData.ok) return { ok: false, reason: "CELESTIALS_UNAVAILABLE", detail: String(worldData.reason) };
    const maxSystems = opts && opts.maxSystems !== undefined ? opts.maxSystems
      : (Array.isArray(systemIds) ? systemIds.length : 0);
    return readSystemCelestialsFrom(worldData.exports, systemIds, { maxSystems });
  }

  function readPlanetResources(planetTypeIds) {
    const planetStaticData = requireGame("services/planet/planetStaticData");
    if (!planetStaticData.ok) {
      return { ok: false, reason: "PLANET_DATA_UNAVAILABLE", detail: String(planetStaticData.reason) };
    }
    return readPlanetResourcesFrom(planetStaticData.exports, planetTypeIds);
  }

  function readLocalResources(systemIds, families) {
    const exportsOf = (rel) => {
      const loaded = requireGame(rel);
      return loaded.ok ? loaded.exports : null;
    };
    return readLocalResourcesFrom({
      asteroidData: exportsOf("space/asteroids/asteroidData"),
      asteroidService: exportsOf("space/asteroids/asteroidService"),
      miningVisuals: exportsOf("services/mining/miningVisuals"),
      iceAuthority: exportsOf("services/mining/iceSystemAuthority"),
      anomalyAuthority: exportsOf("services/mining/oreAnomalySecurityAuthority"),
    }, systemIds, families);
  }

  function readItemTypeFacts(typeIds) {
    const loaded = requireGame("services/inventory/itemTypeRegistry");
    return readItemTypeFactsFrom(loaded.ok ? loaded.exports : null, typeIds);
  }

  function readTypeLooks(typeIds) {
    const loaded = requireGame("services/inventory/itemTypeRegistry");
    return readTypeLooksFrom(loaded.ok ? loaded.exports : null, typeIds);
  }

  function readWormholePairs(opts) {
    const state = requireGame("services/exploration/wormholes/wormholeRuntimeState");
    if (!state.ok) return { ok: false, reason: "WORMHOLE_STATE_UNAVAILABLE", detail: state.reason };
    const cfg = requireGame("config/index");
    return readWormholePairsFrom(state.exports, opts || {}, cfg.ok ? cfg.exports : null);
  }

  function applyStandingGrant(grant, data) {
    const runtime = requireGame(STANDING_RUNTIME);
    if (!runtime.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: runtime.reason };
    return applyStandingGrantFrom(runtime.exports, grant, data);
  }

  function checkStandingWrite() {
    const runtime = requireGame(STANDING_RUNTIME);
    if (!runtime.ok) return { ok: false, reason: runtime.reason };
    try {
      return runtime.exports && typeof runtime.exports.applyStandingChanges === "function"
        ? { ok: true } : { ok: false, reason: "applyStandingChanges_not_a_function" };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  }

  function listStandingReceiptKeys(characterId, prefix) {
    const state = requireGame(CHARACTER_STATE);
    if (!state.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: state.reason };
    return listReceiptKeysFrom(state.exports, characterId, prefix);
  }

  function pruneStandingReceipts(characterId, keys) {
    const state = requireGame(CHARACTER_STATE);
    if (!state.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: state.reason };
    return pruneReceiptsFrom(state.exports, characterId, keys);
  }

  function checkReceiptPrune() {
    const state = requireGame(CHARACTER_STATE);
    if (!state.ok) return { ok: false, reason: state.reason };
    try {
      const e = state.exports;
      if (!e || typeof e.peekCharacterRecord !== "function") {
        return { ok: false, reason: "peekCharacterRecord_missing" };
      }
      if (typeof e.updateCharacterRecord !== "function") return { ok: false, reason: "updateCharacterRecord_missing" };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  }

  function personalContactsSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "localContacts")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.localContacts) };
    }
    const loaded = requireGame(CHARACTER_STATE);
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(loaded.reason) };
    const e = loaded.exports;
    if (!e || typeof e.peekCharacterRecord !== "function" || typeof e.updateCharacterRecord !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "characterState symbols missing" };
    }
    return { ok: true, seam: Object.freeze({
      read: (characterId, contactIds) => {
        const s = requireGame(CHARACTER_STATE);
        return s.ok ? readPersonalContactsFrom(s.exports, characterId, contactIds)
          : { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(s.reason) };
      },
      apply: (characterId, ops) => {
        const s = requireGame(CHARACTER_STATE);
        return s.ok ? applyPersonalContactsFrom(s.exports, characterId, ops)
          : { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: String(s.reason) };
      },
    }) };
  }

  function readCharacterStanding(characterId, ownerId) {
    const stateLoaded = requireGame(CHARACTER_STATE);
    if (!stateLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: stateLoaded.reason };
    const runtimeLoaded = requireGame(STANDING_RUNTIME);
    if (!runtimeLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: runtimeLoaded.reason };
    return readCharacterStandingFrom(stateLoaded.exports, runtimeLoaded.exports, characterId, ownerId);
  }

  function checkStandingRead() {
    const stateLoaded = requireGame(CHARACTER_STATE);
    if (!stateLoaded.ok) return { ok: false, reason: stateLoaded.reason };
    const runtimeLoaded = requireGame(STANDING_RUNTIME);
    if (!runtimeLoaded.ok) return { ok: false, reason: runtimeLoaded.reason };
    try {
      const cs = stateLoaded.exports;
      const sr = runtimeLoaded.exports;
      if (!cs || typeof cs.peekCharacterRecord !== "function") return { ok: false, reason: "peekCharacterRecord_missing" };
      if (!sr || typeof sr.getCharacterRawStandingFromRecord !== "function") return { ok: false, reason: "getCharacterRawStandingFromRecord_missing" };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  }

  function readPirateFactionIds() {
    const policy = requireGame("space/npc/pirateFactionPolicy");
    if (!policy.ok) return { ok: false, reason: "PIRATE_SET_UNAVAILABLE", detail: policy.reason };
    return readPirateFactionIdsFrom(policy.exports);
  }

  function getSovClaims() {
    const { createSovClaimReader } = require("./sovClaims");
    return createSovClaimReader({ requireGame });
  }

  let incursionUi = null;
  const incursionUiCore = () => {
    if (incursionUi === null) {
      const { createIncursionUiPublisher } = require("./incursionUi");
      const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
      incursionUi = createIncursionUiPublisher({
        requireGame,
        serverSrc: () => state.serverSrc,
        readFile: (absPath) => {
          try {
            const text = readFileSync(absPath, "utf8");
            return typeof text === "string" ? text : null;
          } catch (_err) {
            return null;
          }
        },
      });
    }
    return incursionUi;
  };
  function publishIncursions(list) {
    try {
      return incursionUiCore().publish(list);
    } catch (err) {
      return { ok: false, reason: "INCURSION_PUBLISH_FAILED", detail: String((err && err.message) || err) };
    }
  }

  function incursionUiStats() {
    try {
      return incursionUiCore().stats();
    } catch (_err) {
      return { installed: false, calls: 0, merged: 0, lastSuppressed: 0, errors: 0 };
    }
  }

  let incursionNative = null;
  const incursionNativeCore = () => {
    if (incursionNative === null) {
      const { createIncursionNative } = require("./incursionNative");
      const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
      incursionNative = createIncursionNative({
        requireGame,
        serverSrc: () => state.serverSrc,
        readFile: (absPath) => {
          try {
            const text = readFileSync(absPath, "utf8");
            return typeof text === "string" ? text : null;
          } catch (_err) {
            return null;
          }
        },
      });
    }
    return incursionNative;
  };
  const nativeFailure = (err) => ({ ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE",
    detail: String((err && err.message) || err) });
  const nativeProbeRefusal = () => {
    const disabled = state.report ? state.report.disabledModules : null;
    return disabled && hasOwn(disabled, "nativeIncursions")
      ? { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: `drift_${String(disabled.nativeIncursions)}` }
      : null;
  };
  function nativeIncursionsSetTargets(byBand, mode, logSize) {
    try {
      const refused = byBand === null ? null : nativeProbeRefusal();
      if (refused) return refused;
      return incursionNativeCore().setSteerTargets(byBand, mode, logSize);
    } catch (err) {
      return nativeFailure(err);
    }
  }
  function nativeIncursionsListTales(req) {
    try {
      return nativeProbeRefusal() || incursionNativeCore().listTales(req);
    } catch (err) {
      return nativeFailure(err);
    }
  }
  function nativeIncursionsBossParticipants(receiptId, limit) {
    try {
      return nativeProbeRefusal() || incursionNativeCore().bossParticipants(receiptId, limit);
    } catch (err) {
      return nativeFailure(err);
    }
  }
  function nativeIncursionsParticipants(taleId, limit, maxReceipts) {
    try {
      return nativeProbeRefusal() || incursionNativeCore().participants(taleId, limit, maxReceipts);
    } catch (err) {
      return nativeFailure(err);
    }
  }
  function nativeIncursionsVendorBands() {
    try {
      return nativeProbeRefusal() || incursionNativeCore().vendorBands();
    } catch (err) {
      return nativeFailure(err);
    }
  }
  function nativeIncursionsStats() {
    try {
      return incursionNativeCore().stats();
    } catch (_err) {
      return { installed: false, drift: false, hits: 0, passthrough: 0, exclusiveNull: 0, errors: 0, steerLog: [] };
    }
  }

  let incursionHud = null;
  const incursionHudCore = () => {
    if (incursionHud === null) {
      const { createIncursionHud, CONSUMER } = require("./incursionHud");
      const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
      incursionHud = createIncursionHud({
        requireGame,
        serverSrc: () => state.serverSrc,
        readFile: (absPath) => {
          try {
            const text = readFileSync(absPath, "utf8");
            return typeof text === "string" ? text : null;
          } catch (_err) {
            return null;
          }
        },
        consumerDrift: () => {
          const disabled = state.report ? state.report.disabledModules : null;
          return disabled && hasOwn(disabled, CONSUMER) ? String(disabled[CONSUMER]) : null;
        },
      });
    }
    return incursionHud;
  };
  const hudFailure = (err) => ({ ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE",
    detail: String((err && err.message) || err) });
  function factionIncursionHudSync(spec) {
    try {
      return incursionHudCore().sync(spec);
    } catch (err) {
      return hudFailure(err);
    }
  }
  function factionIncursionHudClear(removeTemplateID) {
    try {
      return incursionHudCore().clear(removeTemplateID);
    } catch (err) {
      return hudFailure(err);
    }
  }
  function factionIncursionHudStats() {
    try {
      return incursionHudCore().stats();
    } catch (_err) {
      return { installed: false, drift: null, tracked: 0 };
    }
  }

  let incursionEffects = null;
  const incursionEffectsCore = () => {
    if (incursionEffects === null) {
      const { createIncursionEffects, CONSUMER } = require("./incursionEffects");
      const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
      incursionEffects = createIncursionEffects({
        requireGame,
        serverSrc: () => state.serverSrc,
        readFile: (absPath) => {
          try {
            const text = readFileSync(absPath, "utf8");
            return typeof text === "string" ? text : null;
          } catch (_err) {
            return null;
          }
        },
        consumerDrift: () => {
          const disabled = state.report ? state.report.disabledModules : null;
          return disabled && hasOwn(disabled, CONSUMER) ? String(disabled[CONSUMER]) : null;
        },
      });
    }
    return incursionEffects;
  };
  const effectsFailure = (err) => ({ ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE",
    detail: String((err && err.message) || err) });
  function factionIncursionEffectsSet(entries, refreshDelta) {
    try {
      return incursionEffectsCore().setSystems(entries, refreshDelta);
    } catch (err) {
      return effectsFailure(err);
    }
  }
  function factionIncursionEffectsRefresh(budget) {
    try {
      return incursionEffectsCore().refresh(budget);
    } catch (err) {
      return effectsFailure(err);
    }
  }
  function factionIncursionEffectsStats() {
    try {
      return incursionEffectsCore().stats();
    } catch (_err) {
      return { installed: false, drift: false, systems: 0, hits: 0, vendorWins: 0, errors: 0 };
    }
  }

  const starmapSeamInputs = () => {
    const overlay = require("./starmapOverlay");
    const loaded = requireGame(overlay.TELEMETRY_PATH);
    if (!loaded.ok || !loaded.exports) {
      return { ok: false, reason: "STARMAP_SEAM_UNAVAILABLE", detail: String(loaded.reason || "no exports") };
    }
    const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
    const read = (rel) => {
      try {
        const text = readFileSync(path.join(state.serverSrc, ...`${rel}.js`.split("/")), "utf8");
        return typeof text === "string" ? text : null;
      } catch (_err) {
        return null;
      }
    };
    return { ok: true, overlay, exports: loaded.exports,
      texts: { telemetryText: read(overlay.TELEMETRY_PATH), mapServiceText: read(overlay.MAP_SERVICE_PATH) } };
  };

  function starmapOverlaySeams() {
    try {
      const inputs = starmapSeamInputs();
      if (!inputs.ok) return inputs;
      return inputs.overlay.checkJumps(inputs.exports, inputs.texts);
    } catch (err) {
      return { ok: false, reason: "STARMAP_SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function installStarmapJumps(provider) {
    try {
      const inputs = starmapSeamInputs();
      if (!inputs.ok) return inputs;
      const onEvent = provider && typeof provider.onEvent === "function" ? provider.onEvent : undefined;
      return inputs.overlay.installJumps(inputs.exports, provider, { ...inputs.texts, onEvent });
    } catch (err) {
      return { ok: false, reason: "STARMAP_SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function uninstallStarmapJumps() {
    try {
      return require("./starmapOverlay").uninstallJumps();
    } catch (_err) {
      return { ok: true };
    }
  }

  function installStarmapKills(provider) {
    try {
      const overlay = require("./starmapOverlay");
      if (overlay.killsStatus().state === "off") return { ok: false, reason: "KILLS_HOOK_NOT_ARMED" };
      const map = requireGame(overlay.MAP_SERVICE_PATH);
      if (!map.ok || !map.exports) {
        return { ok: false, reason: "STARMAP_SEAM_UNAVAILABLE", detail: `mapService ${map.reason || "no exports"}` };
      }
      const telemetry = requireGame(overlay.TELEMETRY_PATH);
      const filetimeFromMs = telemetry.ok && telemetry.exports ? telemetry.exports[overlay.FILETIME_EXPORT] : undefined;
      const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
      let mapServiceText = null;
      try {
        const text = readFileSync(path.join(state.serverSrc, ...`${overlay.MAP_SERVICE_PATH}.js`.split("/")), "utf8");
        mapServiceText = typeof text === "string" ? text : null;
      } catch (_err) {
        mapServiceText = null;
      }
      const onEvent = provider && typeof provider.onEvent === "function" ? provider.onEvent : undefined;
      return overlay.installKillsScope(map.exports, provider,
        { mapServiceText, filetimeFromMs: typeof filetimeFromMs === "function" ? filetimeFromMs : null, onEvent });
    } catch (err) {
      return { ok: false, reason: "STARMAP_SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function uninstallStarmapKills() {
    try {
      return require("./starmapOverlay").uninstallKills();
    } catch (_err) {
      return { ok: true };
    }
  }

  function starmapOverlayStatus() {
    try {
      const overlay = require("./starmapOverlay");
      return { jumps: overlay.jumpsStatus(), kills: overlay.killsStatus() };
    } catch (_err) {
      return { jumps: { state: "idle", served: 0, errors: 0 },
        kills: { state: "off", served: 0, errors: 0, depth: 0, syntheticKills: 0 } };
    }
  }

  const devIndexClientInputs = () => {
    const client = require("./devIndexClient");
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, client.CONSUMER)) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled[client.CONSUMER]) };
    }
    const loaded = {};
    for (const [key, rel] of [["service", client.SERVICE_PATH], ["state", client.STATE_PATH],
      ["payloads", client.PAYLOADS_PATH], ["constants", client.CONSTANTS_PATH]]) {
      const r = requireGame(rel);
      if (!r.ok || !r.exports) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${key} ${r.reason || "no exports"}` };
      loaded[key] = r.exports;
    }
    const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
    const read = (rel) => {
      try {
        const text = readFileSync(path.join(state.serverSrc, ...`${rel}.js`.split("/")), "utf8");
        return typeof text === "string" ? text : null;
      } catch (_err) {
        return null;
      }
    };
    const { state: sov, payloads, constants } = loaded;
    return { ok: true, client, serviceClass: loaded.service,
      texts: { service: read(client.SERVICE_PATH), state: read(client.STATE_PATH), payloads: read(client.PAYLOADS_PATH),
        constants: read(client.CONSTANTS_PATH) },
      vendor: { getSystemState: sov.getSystemState, getDevelopmentIndicesForSystem: sov.getDevelopmentIndicesForSystem,
        listAllDevelopmentIndices: sov.listAllDevelopmentIndices, listAllAllianceSystems: sov.listAllAllianceSystems,
        buildSystemPayload: payloads.buildDevelopmentIndicesForSystemPayload,
        buildAllPayload: payloads.buildAllDevelopmentIndicesPayload },
      K: { levelWidth: constants.DEV_INDEX_LEVEL_WIDTH, militaryAttr: constants.ATTRIBUTE_DEV_INDEX_MILITARY,
        industrialAttr: constants.ATTRIBUTE_DEV_INDEX_INDUSTRIAL } };
  };

  function devIndexClientSeams() {
    try {
      const inputs = devIndexClientInputs();
      if (!inputs.ok) return inputs;
      const drift = inputs.client.driftDetail(inputs.texts);
      return drift === null ? { ok: true } : { ok: false, reason: "DEV_CLIENT_DRIFT", detail: drift };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function installDevIndexClient(provider) {
    try {
      const inputs = devIndexClientInputs();
      if (!inputs.ok) return inputs;
      return inputs.client.installDevIndexClient(inputs.serviceClass, provider,
        { texts: inputs.texts, vendor: inputs.vendor, K: inputs.K });
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function uninstallDevIndexClient() {
    try {
      return require("./devIndexClient").uninstallDevIndexClient();
    } catch (_err) {
      return { ok: true };
    }
  }

  function devIndexClientStatus() {
    try {
      return require("./devIndexClient").devIndexClientStatus();
    } catch (_err) {
      return { state: "off", served: 0, claimed: 0, failed: 0 };
    }
  }

  function getSovNative() {
    const { createSovNativeReader } = require("./sovNative");
    return createSovNativeReader({ requireGame });
  }

  function getNpcSpawnTools() {
    const npcData = requireGame("space/npc/npcData");
    if (!npcData.ok) return { ok: false, reason: `npcData_${npcData.reason}` };
    const native = requireGame("space/npc/nativeNpcService");
    if (!native.ok) return { ok: false, reason: `nativeNpcService_${native.reason}` };
    try {
      const buildNpcDefinition = npcData.exports && npcData.exports.buildNpcDefinition;
      const spawn = siteNavyOriginal || (native.exports && native.exports.spawnNativeDefinitionsInContext);
      if (typeof buildNpcDefinition !== "function") return { ok: false, reason: "buildNpcDefinition_not_a_function" };
      if (typeof spawn !== "function") return { ok: false, reason: "spawnNativeDefinitionsInContext_not_a_function" };
      const tools = { ok: true, buildNpcDefinition, spawnNativeDefinitionsInContext: spawn };
      const presentation = requireGame("space/npc/npcPresentation");
      const buildIdentity = presentation.ok && presentation.exports && presentation.exports.buildNpcEntityIdentity;
      if (typeof buildIdentity === "function") tools.resolveNpcBounty = (definition) => buildIdentity(definition, {}).bounty;
      return tools;
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  }

  let siteNavyOriginal = null;

  function getSiteNavyTools() {
    const paths = { native: "space/npc/nativeNpcService", runtime: "services/dungeon/dungeonRuntime",
      authority: "services/dungeon/dungeonAuthority", belt: "space/npc/beltRatRuntime" };
    const loaded = {};
    for (const [key, rel] of Object.entries(paths)) {
      const read = requireGame(rel);
      if (!read.ok || !read.exports) return { ok: false, reason: `${key}_${read.reason || "NO_EXPORTS"}` };
      loaded[key] = read.exports;
    }
    const need = [["native", "spawnNativeDefinitionsInContext"], ["runtime", "getInstanceSummary"],
      ["runtime", "getInstanceRef"], ["authority", "getTemplateByIDReadOnly"], ["belt", "resolveSecurityProfile"]];
    for (const [key, name] of need) {
      if (typeof loaded[key][name] !== "function") return { ok: false, reason: `${name}_not_a_function` };
    }
    return {
      ok: true,
      readSummary: (instanceId) => loaded.runtime.getInstanceSummary(instanceId),
      readInstanceRef: (instanceId) => loaded.runtime.getInstanceRef(instanceId),
      readTemplate: (templateId) => loaded.authority.getTemplateByIDReadOnly(templateId),
      resolveSecurityProfile: (systemId) => loaded.belt.resolveSecurityProfile(systemId),
      install: (makeWrap) => {
        if (siteNavyOriginal) return { ok: true, noop: true };
        const original = loaded.native.spawnNativeDefinitionsInContext;
        const wrap = makeWrap(original);
        if (!wrap || wrap.ok !== true || typeof wrap.wrapped !== "function") {
          return { ok: false, reason: (wrap && wrap.reason) || "WRAP_INVALID" };
        }
        if (wrap.noop === true) return { ok: true, noop: true };
        loaded.native.spawnNativeDefinitionsInContext = wrap.wrapped;
        siteNavyOriginal = original;
        return { ok: true };
      },
    };
  }

  function getProcessRole() {
    const loaded = requireGame("gameStore/index");
    if (!loaded.ok || !loaded.exports) return "unknown";
    const gs = loaded.exports;
    if (typeof gs._processRole === "string") return gs._processRole;
    if (typeof gs.getProcessRole === "function") {
      try { return gs.getProcessRole(); } catch { return "unknown"; }
    }
    return "unknown";
  }

  const identities = createVirtualIdentitiesAdapter({ requireGame, config: deps.config });

  function readFactionNames() {
    const names = loadMapNames(deps.mapNamesFile ? { filePath: deps.mapNamesFile } : {});
    if (!names.ok) return names;
    return { ok: true, names: names.factions };
  }

  let scannerHide = null;
  let chatCommand = null;
  let siteEntryHook = null;
  const shipAiActivityHooks = { mining: null, site: null };
  const chatCommands = new Map();
  let dockGate = null;
  let trigBridgeJump = null;
  let trigBridgeDeposit = null;
  let trigBridgePresentation = null;
  let playerMail = null;
  const mail = () => {
    if (!playerMail) playerMail = createPlayerMailAdapter({ requireGame, logger: { log: logAdapter } });
    return playerMail;
  };

  function getDungeonSites() {
    const dungeonRuntime = requireGame("services/dungeon/dungeonRuntime");
    if (!dungeonRuntime.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `dungeonRuntime_${dungeonRuntime.reason}` };
    const dungeonAuthority = requireGame("services/dungeon/dungeonAuthority");
    if (!dungeonAuthority.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `dungeonAuthority_${dungeonAuthority.reason}` };
    const siteService = requireGame("services/dungeon/dungeonUniverseSiteService");
    if (!siteService.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `siteService_${siteService.reason}` };
    const placement = requireGame("services/exploration/signatures/signaturePlacement");
    if (!placement.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `placement_${placement.reason}` };
    const worldData = requireGame("space/worldData");
    if (!worldData.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `worldData_${worldData.reason}` };
    const gameStore = requireGame("gameStore/index");
    let gameStoreExports = null;
    if (gameStore.ok && gameStore.exports && typeof gameStore.exports.flushTableSync === "function") {
      gameStoreExports = gameStore.exports;
    }
    const mods = {
      dungeonRuntime: dungeonRuntime.exports,
      dungeonAuthority: dungeonAuthority.exports,
      siteService: siteService.exports,
      placement: placement.exports,
      worldData: worldData.exports,
      gameStore: gameStoreExports,
    };
    return {
      ok: true,
      ensureSite: (spec) => ensureSiteFrom(mods, spec),
      readSite: (siteKey) => readSiteFrom(mods, siteKey),
      extendSite: (siteKey, vendorExpiresAtMs, nowMs) => extendSiteFrom(mods, siteKey, vendorExpiresAtMs, nowMs),
      despawnSite: (siteKey, reason, nowMs) => withScannerHide(scannerHide,
        despawnSiteFrom(mods, siteKey, reason, nowMs)),
      purgeSite: (siteKey, systemId) => withScannerForget(scannerHide, purgeSiteFrom(mods, siteKey, systemId)),
      checkTemplates: (templateIds) => checkTemplatesFrom(mods, templateIds),
      planPosition: (systemId, siteFamily, seed, baseDistanceAu) => planPositionFrom(mods, systemId, siteFamily, seed, baseDistanceAu),
      _buildInstanceOptions: (spec, template, siteId, position) => buildInstanceOptions(spec, template, siteId, position),
    };
  }

  function onCombatSiteCompleted(fn) {
    try {
      const disabled = state.report ? state.report.disabledModules : null;
      if (disabled && hasOwn(disabled, "escalations")) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `drift_${String(disabled.escalations)}` };
      }
      const dungeonRuntime = requireGame("services/dungeon/dungeonRuntime");
      if (!dungeonRuntime.ok) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `dungeonRuntime_${dungeonRuntime.reason}` };
      }
      return siteCompletion.subscribeFrom(dungeonRuntime.exports, fn, { log: logAdapter });
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `threw: ${String((err && err.message) || err)}` };
    }
  }

  function onSiteContainerHacked(fn) {
    try {
      const disabled = state.report ? state.report.disabledModules : null;
      if (disabled && hasOwn(disabled, "archaeology")) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `drift_${String(disabled.archaeology)}` };
      }
      const dungeonRuntime = requireGame("services/dungeon/dungeonRuntime");
      if (!dungeonRuntime.ok) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `dungeonRuntime_${dungeonRuntime.reason}` };
      }
      return siteHacks.subscribeFrom(dungeonRuntime.exports, fn, { log: logAdapter });
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `threw: ${String((err && err.message) || err)}` };
    }
  }

  function readSiteHackWins(siteKey) {
    try {
      const disabled = state.report ? state.report.disabledModules : null;
      if (disabled && hasOwn(disabled, "archaeology")) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `drift_${String(disabled.archaeology)}` };
      }
      const dungeonRuntime = requireGame("services/dungeon/dungeonRuntime");
      if (!dungeonRuntime.ok) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `dungeonRuntime_${dungeonRuntime.reason}` };
      }
      return siteHacks.readSiteHackWinsFrom(dungeonRuntime.exports, siteKey);
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: String((err && err.message) || err) };
    }
  }

  function checkDungeonSites() {
    const required = [
      "services/dungeon/dungeonRuntime",
      "services/dungeon/dungeonAuthority",
      "services/dungeon/dungeonUniverseSiteService",
      "services/exploration/signatures/signaturePlacement",
      "space/worldData",
      "gameStore/index",
    ];
    for (const path of required) {
      const loaded = requireGame(path);
      if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${path}_${loaded.reason}` };
      const exports = loaded.exports;
      if (path === "services/dungeon/dungeonRuntime") {
        if (typeof exports.createInstance !== "function" ||
            typeof exports.findInstanceBySiteKey !== "function" ||
            typeof exports.setLifecycleState !== "function" ||
            typeof exports.purgeInstance !== "function" ||
            typeof exports.peekNextInstanceID !== "function") {
          return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${path}_missing_function` };
        }
      }
      if (path === "services/dungeon/dungeonAuthority") {
        if (typeof exports.getTemplateByID !== "function") {
          return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${path}_missing_getTemplateByID` };
        }
      }
      if (path === "services/dungeon/dungeonUniverseSiteService") {
        if (typeof exports.isUniverseSiteTeardownParked !== "function") {
          return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${path}_missing_isUniverseSiteTeardownParked` };
        }
      }
      if (path === "services/exploration/signatures/signaturePlacement") {
        if (typeof exports.buildAnchorRelativeSignaturePlacement !== "function") {
          return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${path}_missing_buildAnchorRelativeSignaturePlacement` };
        }
      }
      if (path === "space/worldData") {
        if (typeof exports.getCelestialsForSystem !== "function" ||
            typeof exports.getAsteroidBeltsForSystem !== "function" ||
            typeof exports.getStationsForSystem !== "function" ||
            typeof exports.getStargatesForSystem !== "function" ||
            typeof exports.getSolarSystemByID !== "function") {
          return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${path}_missing_function` };
        }
      }
      if (path === "gameStore/index") {
        if (typeof exports.flushTableSync !== "function") {
        }
      }
    }
    return { ok: true };
  }

  const taggedWreckMods = () => {
    const loaded = loadNativeWreckModsFrom(requireGame);
    if (!loaded.ok) return loaded;
    const tagged = createTaggedWreckStore(loaded.mods.store, vendorTags, vendorTagHooks);
    return tagged.ok ? { ok: true, mods: { ...loaded.mods, store: tagged.view } } : tagged;
  };

  function getNativeWrecks() {
    const loaded = taggedWreckMods();
    return loaded.ok ? createNativeWrecksFacade(loaded.mods) : loaded;
  }

  function checkNativeWrecks() {
    const loaded = taggedWreckMods();
    return loaded.ok ? { ok: true } : loaded;
  }

  const sceneNpcBudget = createSceneNpcBudget({
    getSettings: () => (deps.config && deps.config.perf ? deps.config.perf.sceneNpc : null),
    getRuntime: () => requireGame("space/runtime"),
  });
  function admitSceneNpc(systemId, n, source) {
    return sceneNpcBudget.admit(systemId, n, source);
  }
  function setSceneNpcSources(sources) {
    sceneNpcBudget.setSources(sources);
  }

  let npcSpawn = null;
  function getNpcSpawn() {
    if (npcSpawn === null) {
      npcSpawn = createNpcSpawn({ requireGame,
        navyProfiles: Object.freeze({ ...NAVY_PROFILES_BY_FACTION_ID, ...CAPSULEER_LIVE_PROFILES,
          ...factionProfiles.installedNavyTable() }),
        invaderProfiles: INVADER_LIVE_PROFILES,
        industryProfiles: INDUSTRY_LIVE_PROFILES,
        capitalIndex: () => capitalProfiles.readIndex(),
        attackLock: () => attackLockOf(deps.config, "live"),
        admit: admitSceneNpc,
        data: liveProfiles });
    }
    return npcSpawn;
  }

  function checkNpcSpawn() {
    return checkNpcSpawnFrom(requireGame);
  }

  let huntScene = null;
  function getHuntScene() {
    if (huntScene === null) {
      huntScene = createHuntScene({ requireGame, data: liveProfiles,
        attackLock: () => attackLockOf(deps.config, "scene") });
    }
    return huntScene;
  }

  function checkHuntScene() {
    return checkHuntSceneFrom(requireGame);
  }

  let beltNavyScene = null;
  function getBeltNavyScene() {
    if (beltNavyScene === null) {
      beltNavyScene = createBeltNavyScene({ requireGame, attackLock: () => attackLockOf(deps.config, "scene") });
    }
    return beltNavyScene;
  }

  function checkBeltNavyScene() {
    return checkBeltNavySceneFrom(requireGame);
  }

  let miningEncounterSeam = null;
  function getMiningEncounterTools() {
    const check = miningEncounterSeams.checkMiningEncounterSeamsFrom(requireGame);
    if (!check.ok) return check;
    if (miningEncounterSeam === null) {
      miningEncounterSeam = miningEncounterSeams.createMiningEncounterSeam({ requireGame,
        getSpawnTools: getNpcSpawnTools, admit: admitSceneNpc });
    }
    return {
      ok: true,
      seam: miningEncounterSeam,
      install: (makeWrap) => {
        try {
          const ledger = requireGame(miningEncounterSeams.PATHS.ledger);
          if (!ledger.ok || !ledger.exports) return { ok: false, reason: `ledger_${ledger.reason || "NO_EXPORTS"}` };
          const wrap = makeWrap(ledger.exports.recordMiningLedgerEvent);
          if (!wrap || wrap.ok !== true || typeof wrap.wrapped !== "function") {
            return { ok: false, reason: (wrap && wrap.reason) || "WRAP_INVALID" };
          }
          if (wrap.noop === true) return { ok: true, noop: true };
          ledger.exports.recordMiningLedgerEvent = wrap.wrapped;
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: "INSTALL_FAILED", detail: String((err && err.message) || err).slice(0, 120) };
        }
      },
    };
  }

  function checkMiningEncounterSeams() {
    return miningEncounterSeams.checkMiningEncounterSeamsFrom(requireGame);
  }

  let ambientRatSeam = null;
  function getAmbientRatTools() {
    const check = ambientRatSeams.checkAmbientRatSeamsFrom(requireGame);
    if (!check.ok) return check;
    if (ambientRatSeam === null) {
      ambientRatSeam = ambientRatSeams.createAmbientRatSeam({ requireGame, getSpawnTools: getNpcSpawnTools,
        admit: admitSceneNpc });
    }
    return { ok: true, seam: ambientRatSeam };
  }

  function checkAmbientRatSeams() {
    return ambientRatSeams.checkAmbientRatSeamsFrom(requireGame);
  }

  let officerSpawnSeam = null;
  const getOfficerSpawn = () => {
    const check = officerSpawnSeams.checkOfficerSpawnSeamsFrom(requireGame);
    if (!check.ok) return check;
    if (officerSpawnSeam === null) {
      officerSpawnSeam = officerSpawnSeams.createOfficerSpawnSeam({ requireGame, getSpawnTools: getNpcSpawnTools,
        admit: admitSceneNpc });
    }
    return { ok: true, seam: officerSpawnSeam };
  };

  let bountyScene = null;
  const nemesisEwar = nemesisEwarSeams.createNemesisEwar({ requireGame });
  const getBountyScene = () => {
    const check = bountySceneSeams.checkBountySceneFrom(requireGame);
    if (!check.ok) return check;
    if (bountyScene === null) {
      bountyScene = bountySceneSeams.createBountyScene({ requireGame, getSpawn: getNpcSpawn,
        getSpawnTools: getNpcSpawnTools, isEwarProfile: nemesisEwar.isEwarProfile, admit: admitSceneNpc });
    }
    return { ok: true, seam: bountyScene };
  };
  const ewarProfilesOf = (factionId, hullClass, family) => nemesisEwar.ewarProfilesOf(factionId, hullClass, family);

  function readConcordGateNpcAggro() {
    return ambientRatSeams.readConcordGateNpcAggroFrom(requireGame);
  }

  const concordResponseDelayMs = (systemId) => concordResponseSeams.concordResponseDelayMsFrom(requireGame, systemId);
  const spawnConcordAgainst = (systemId, targetIds, anchor) => concordResponseSeams.spawnConcordAgainstFrom(
    requireGame, systemId, targetIds, anchor);

  let heavyEventScene = null;
  function getHeavyEventScene() {
    const check = heavyEventSeams.checkHeavyEventSceneFrom(requireGame);
    if (!check.ok) return check;
    if (heavyEventScene === null) {
      heavyEventScene = heavyEventSeams.createHeavyEventScene({ requireGame, getNpcSpawn, getHuntScene });
    }
    return { ok: true, seam: heavyEventScene };
  }

  function checkHeavyEventSeams() {
    return heavyEventSeams.checkHeavyEventSceneFrom(requireGame);
  }

  let highsecTrafficScene = null;
  function getHighsecTrafficScene() {
    const check = highsecTrafficSeams.checkHighsecTrafficSceneFrom(requireGame);
    if (!check.ok) return check;
    if (highsecTrafficScene === null) {
      highsecTrafficScene = highsecTrafficSeams.createHighsecTrafficScene({ requireGame, getNpcSpawn, getHuntScene });
    }
    return { ok: true, seam: highsecTrafficScene };
  }

  function checkHighsecTrafficScene() {
    return highsecTrafficSeams.checkHighsecTrafficSceneFrom(requireGame);
  }

  let situationScene = null;
  function getSituationScene() {
    const check = situationSeams.checkSituationSceneFrom(requireGame);
    if (!check.ok) return check;
    if (situationScene === null) {
      situationScene = situationSeams.createSituationScene({ requireGame, getNpcSpawn, getHuntScene });
    }
    return { ok: true, seam: situationScene };
  }

  function checkLiveLossHook() {
    const loaded = requireGame("space/combat/killmailTracker");
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    return liveLossHook.checkHookInstalled(loaded.exports) ? { ok: true } : { ok: false, reason: "HOOK_NOT_INSTALLED" };
  }

  function bindLiveLossSink(fn) {
    const checked = checkLiveLossHook();
    if (!checked.ok) return checked;
    return liveLossHook.bindSink(fn);
  }

  function addLiveLossListener(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "LISTENER_INVALID" };
    const checked = checkLiveLossHook();
    if (!checked.ok) return checked;
    const isCharacter = (id) => {
      const read = tradeReadCharacter(id);
      return read.ok === true && read.exists === true;
    };
    return liveLossHook.addListener((targetEntity, destroyResult, result) => {
      const facts = liveLossHook.lossFactsOf(targetEntity, destroyResult, result, { isCharacter });
      if (facts) fn(facts);
    });
  }

  let capsuleFxScene = null;
  function getCapsuleFxScene() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, capsuleFx.CONSUMER)) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled[capsuleFx.CONSUMER]) };
    }
    const check = capsuleFx.checkCapsuleFxSceneFrom(requireGame);
    if (!check.ok) return check;
    if (capsuleFxScene === null) capsuleFxScene = capsuleFx.createCapsuleFxScene({ requireGame });
    return { ok: true, seam: capsuleFxScene };
  }

  function addNpcWreckListener(fn, opts) {
    if (typeof fn !== "function") return { ok: false, reason: "LISTENER_INVALID" };
    const checked = checkLiveLossHook();
    if (!checked.ok) return checked;
    const excludedFactionIds = opts && opts.excludedFactionIds instanceof Set ? opts.excludedFactionIds : new Set();
    const onSkip = opts && typeof opts.onSkip === "function" ? opts.onSkip : null;
    const deps = { excludedFactionIds, isMissionInstance: capsuleFx.isMissionInstanceFrom(requireGame),
      isCareerLessonInstance: capsuleFx.isCareerLessonInstanceFrom(requireGame) };
    return liveLossHook.addListener((targetEntity, destroyResult) => {
      const r = capsuleFx.classifyVictim(targetEntity, destroyResult, deps);
      if (r.facts) fn(r.facts);
      else if (onSkip !== null) onSkip(r.skip);
    });
  }

  function readDormancyGuardStats() {
    return dormancyGuard.stats();
  }

  function capitalLiveIndex() {
    return capitalProfiles.readIndex();
  }

  let capitalFighterToolsMemo = null;
  function capitalFighterTools() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "capitalFighters")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.capitalFighters) };
    }
    if (capitalFighterToolsMemo) return capitalFighterToolsMemo;
    const paths = { dogma: "services/fighter/fighterDogma", runtime: "services/fighter/fighterRuntime",
      space: "space/runtime", missiles: "space/combat/missiles/missileSolver", damage: "space/combat/damage",
      range: "space/destiny/authority/sceneRangeDecision", evolve: "space/destiny/simulation/evolve",
      scope: "space/destiny/identity/interactionScope", capital: "space/npc/capitals/capitalNpcState" };
    const m = {};
    for (const [key, rel] of Object.entries(paths)) {
      const read = requireGame(rel);
      if (!read.ok || !read.exports) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${rel}: ${read.reason || "NO_EXPORTS"}` };
      }
      m[key] = read.exports;
    }
    const interop = m.space.droneInterop;
    if (!interop || typeof interop !== "object") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "space/runtime: droneInterop" };
    }
    const tools = {
      resolveFighterAbilitySnapshot: (fighter, controllerEntity, slotID) =>
        m.dogma.resolveFighterAbilitySnapshot(fighter, controllerEntity, slotID),
      getFighterOrbitDistance: (fighter) => m.runtime.getFighterOrbitDistance(fighter),
      resolveMissileAppliedDamage: (snapshot, target) => m.missiles.resolveMissileAppliedDamage(snapshot, target),
      hasDamageableHealth: (entity) => m.damage.hasDamageableHealth(entity),
      getSceneSurfaceDistance: (scene, left, right, options) =>
        m.range.getSceneSurfaceDistance(scene, left, right, options),
      isWarping: (entity) => m.evolve.isWarping(entity),
      canEntitiesInteractLocally: (source, target) => m.scope.canEntitiesInteractLocally(source, target),
      listControlledNpcFighters: (scene, controllerId) => m.capital.listControlledNpcFighters(scene, controllerId),
      droneInterop: interop,
      gateProbe: () => {
        const testing = m.runtime._testing;
        const fn = testing && typeof testing === "object" ? testing.canPlayerCompanionActOnTarget : null;
        if (typeof fn !== "function") return null;
        try {
          const answer = fn({ canSessionSeeDungeonScopedEntity: () => true }, null, { controllerOwnerID: 0 },
            { kind: "ship", characterID: 0, pilotCharacterID: 0 }, { kind: "ship" });
          return typeof answer === "boolean" ? answer : null;
        } catch (_err) {
          return null;
        }
      },
    };
    capitalFighterToolsMemo = { ok: true, tools };
    return capitalFighterToolsMemo;
  }

  let capitalFaxToolsMemo = null;
  function capitalFaxTools() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "capitalFax")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.capitalFax) };
    }
    if (capitalFaxToolsMemo) return capitalFaxToolsMemo;
    const paths = { assistance: "space/modules/assistanceModuleRuntime", equipment: "space/npc/npcEquipment",
      space: "space/runtime", range: "space/destiny/authority/sceneRangeDecision",
      scope: "space/destiny/identity/interactionScope" };
    const m = {};
    for (const [key, rel] of Object.entries(paths)) {
      const read = requireGame(rel);
      if (!read.ok || !read.exports) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${rel}: ${read.reason || "NO_EXPORTS"}` };
      }
      m[key] = read.exports;
    }
    const interop = m.space.droneInterop;
    if (!interop || typeof interop !== "object") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "space/runtime: droneInterop" };
    }
    for (const name of ["normalizeShipConditionState", "buildShipHealthTransitionResult",
      "notifyShipHealthAttributesToSession", "broadcastDamageStateChange", "persistDynamicEntity"]) {
      if (typeof interop[name] !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `space/runtime: droneInterop.${name}` };
      }
    }
    capitalFaxToolsMemo = { ok: true, tools: {
      executeAssistanceModuleCycle: (input) => m.assistance.executeAssistanceModuleCycle(input),
      getNpcAssistanceModules: (entity) => m.equipment.getNpcAssistanceModules(entity),
      getSceneSurfaceDistance: (scene, left, right, options) =>
        m.range.getSceneSurfaceDistance(scene, left, right, options),
      canEntitiesInteractLocally: (source, target) => m.scope.canEntitiesInteractLocally(source, target),
      droneInterop: interop,
    } };
    return capitalFaxToolsMemo;
  }

  let localPilotsSeam = null;
  function localPilotsSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "localPilots")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.localPilots) };
    }
    if (localPilotsSeam === null) localPilotsSeam = createLocalPilotsSeam({ requireGame });
    return { ok: true, seam: localPilotsSeam };
  }

  function shipAiSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "shipAi")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.shipAi) };
    }
    const chat = requireGame(CHAT_RUNTIME_PATH);
    if (!chat.ok || !chat.exports) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `chatRuntime_${chat.reason}` };
    const stub = requireGame("services/chat/xmppStubServer");
    if (!stub.ok || !stub.exports) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `xmppStub_${stub.reason}` };
    const channel = (opts) => createShipAiChannel({ ...(opts || {}), chatRuntimeExports: chat.exports,
      xmppExports: stub.exports, logger: { log: logAdapter } });
    const xmpp = Object.freeze({
      isInstalled: () => shipAiXmpp.isInstalled(),
      registerPair: (spec) => shipAiXmpp.registerPair(spec),
      clearPairs: () => shipAiXmpp.clearPairs(),
      sendAiMessage: (spec) => shipAiXmpp.sendAiMessage(spec),
      hasOpenRoom: (playerId) => shipAiXmpp.hasOpenRoom(playerId),
      getState: () => shipAiXmpp.getState(),
      userDataOf: (characterId) => {
        const peek = identities.peekCharacterRecord(characterId);
        return peek.ok ? localPilotsXmppBuildUserData(characterId, peek.record) : null;
      },
    });
    const identitySeam = Object.freeze({
      reserveCharacterId: () => identities.reserveCharacterId(),
      writeCharacter: (record) => identities.writeCharacter(record),
      flush: (tables) => identities.flush(tables),
      findByMarker: (key) => {
        const scan = identities.scanVirtualCharacters();
        if (!scan.ok) return { ok: false, reason: scan.reason };
        const hit = scan.characters.find((c) => c.lneIdentityKey === key);
        return hit ? { ok: true, found: true, characterId: Number(hit.characterId), name: hit.name }
          : { ok: true, found: false };
      },
      corporationExists: (corporationId) => {
        const r = identities.checkCorporationAlliance(corporationId);
        if (r.ok) return { ok: true, exists: true };
        return r.reason === "CORPORATION_NOT_FOUND" ? { ok: true, exists: false } : { ok: false, reason: r.reason };
      },
    });
    const exportsOf = (rel) => {
      const loaded = requireGame(rel);
      return loaded.ok ? loaded.exports : null;
    };
    const toolsOff = () => {
      const d = state.report ? state.report.disabledModules : null;
      return d && hasOwn(d, "shipAiTools") ? { ok: false, reason: "SEAM_UNAVAILABLE" } : null;
    };
    const calloutOff = () => {
      const d = state.report ? state.report.disabledModules : null;
      return d && hasOwn(d, "shipAiCallout") ? { ok: false, reason: "SEAM_UNAVAILABLE" } : null;
    };
    const calloutLookupsOf = (opts) => {
      const s = deps.config && typeof deps.config.shipAi === "object" ? deps.config.shipAi : null;
      const cap = s && Number.isSafeInteger(s.calloutScanLookupMax) ? s.calloutScanLookupMax : 0;
      return cap > 0 && opts && typeof opts === "object" && opts.maxLookups === undefined
        ? { ...opts, maxLookups: cap } : opts;
    };
    const dscanOff = () => {
      const d = state.report ? state.report.disabledModules : null;
      return d && hasOwn(d, "shipAiDscan") ? { ok: false, reason: "SEAM_UNAVAILABLE" } : null;
    };
    const wingOff = () => {
      const d = state.report ? state.report.disabledModules : null;
      return d && hasOwn(d, "shipAiWing") ? { ok: false, reason: "SEAM_UNAVAILABLE" } : null;
    };
    const triggersOff = () => {
      const d = state.report ? state.report.disabledModules : null;
      return d && hasOwn(d, "shipAiTriggers") ? { ok: false, reason: "SEAM_UNAVAILABLE" } : null;
    };
    const sensors = Object.freeze({
      telemetry: (playerId) => toolsOff() || readShipTelemetryFrom({
        sessionRegistry: exportsOf("services/chat/sessionRegistry"), runtime: exportsOf("space/runtime"),
        damage: exportsOf("space/combat/damage"), capacitor: exportsOf("space/runtime/entityCapacitor"),
        itemStore: exportsOf("services/inventory/itemStore") }, playerId),
      itemByName: (name) => toolsOff()
        || findItemTypeByNameFrom(exportsOf("services/inventory/itemTypeRegistry"), name),
      itemSearch: (query, maxRows) => toolsOff()
        || searchItemTypesFrom(exportsOf("services/inventory/itemTypeRegistry"), query, maxRows),
      skills: (playerId, maxGroups) => toolsOff()
        || readSkillSummaryFrom(exportsOf("services/skills/skillState"), playerId, maxGroups),
      gridNpcs: (systemId, opts) => calloutOff() || readGridNpcsFrom({ runtime: exportsOf("space/runtime"),
        registry: exportsOf("space/npc/npcRegistry"),
        factionKill: exportsOf("services/character/factionKillStandingRuntime"),
        standing: exportsOf("services/character/standingRuntime"),
        dungeon: exportsOf("services/dungeon/dungeonRuntime") }, systemId, calloutLookupsOf(opts)),
      dscan: (playerId, opts) => toolsOff() || dscanOff() || readDirectionalScanFrom({
        sessionRegistry: exportsOf("services/chat/sessionRegistry"), runtime: exportsOf("space/runtime"),
        scanMgr: exportsOf("services/exploration/scanMgrService"), registry: exportsOf("space/npc/npcRegistry"),
        factionKill: exportsOf("services/character/factionKillStandingRuntime") }, playerId, opts),
      wingCopies: (systemId, opts) => wingOff()
        || readWingCopiesFrom({ runtime: exportsOf("space/runtime") }, systemId, opts),
      crimeFlags: (playerId) => triggersOff()
        || readCrimeFlagsFrom({ crimewatchRuntime: exportsOf("services/security/crimewatchRuntimeState") }, playerId),
      securityStatus: (playerId) => triggersOff()
        || readSecurityStatusFrom({ characterState: exportsOf("services/character/characterState") }, playerId),
    });
    const portrait = Object.freeze({
      storeAiPortrait: (aiId, bytes, extension) => {
        const d = state.report ? state.report.disabledModules : null;
        if (d && hasOwn(d, "shipAiPortrait")) {
          return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(d.shipAiPortrait).slice(0, 120) };
        }
        return storeAiPortraitWith(exportsOf("services/character/portraitImageStore"), aiId, bytes, extension);
      },
    });
    const dbOff = () => {
      const d = state.report ? state.report.disabledModules : null;
      return d && hasOwn(d, "shipAiDb") ? { ok: false, reason: "SEAM_UNAVAILABLE" } : null;
    };
    const itemMods = () => ({ sessionRegistry: exportsOf("services/chat/sessionRegistry"),
      itemStore: exportsOf("services/inventory/itemStore") });
    const db = Object.freeze({
      cargo: (playerId, opts) => dbOff() || readCargoFrom(itemMods(), playerId, opts),
      fitting: (playerId, opts) => dbOff() || readFittingFrom({ ...itemMods(),
        liveFitting: exportsOf("services/fitting/liveFittingState") }, playerId, opts),
      pilot: (playerId) => dbOff() || readPilotFrom({ characterState: exportsOf("services/character/characterState"),
        corporationState: exportsOf("services/corporation/corporationState") }, playerId),
      assets: (playerId, opts) => dbOff()
        || readAssetsFrom({ itemStore: exportsOf("services/inventory/itemStore") }, playerId, opts),
      findItem: (playerId, typeId, opts) => dbOff()
        || readFindItemFrom({ itemStore: exportsOf("services/inventory/itemStore") }, playerId, typeId, opts),
      walletHistory: (playerId, opts) => dbOff() || readWalletHistoryFrom({
        walletProjection: exportsOf("services/account/walletAuthorityProjection"),
        characterState: exportsOf("services/character/characterState"),
        walletState: exportsOf("services/account/walletState") }, playerId, opts),
      walletIncome: (playerId) => dbOff() || readWalletIncomeFrom({
        walletProjection: exportsOf("services/account/walletAuthorityProjection"),
        characterState: exportsOf("services/character/characterState"),
        walletState: exportsOf("services/account/walletState") }, playerId),
      skillQueue: (playerId, opts) => dbOff() || readSkillQueueFrom({
        skillQueueState: exportsOf("services/skills/training/skillQueueState") }, playerId, opts),
      standings: (playerId, opts) => dbOff() || readStandingsFrom({
        characterState: exportsOf("services/character/characterState"),
        corporationState: exportsOf("services/corporation/corporationState") }, playerId, opts),
      killmails: (playerId, opts) => dbOff()
        || readKillmailsFrom({ killmailState: exportsOf("services/killmail/killmailState") }, playerId, opts),
      missions: (playerId, opts) => dbOff()
        || readMissionsFrom({ gameStore: exportsOf("gameStore/index") }, playerId, opts),
      skillHistory: (playerId, opts) => dbOff() || readSkillHistoryFrom({
        characterState: exportsOf("services/character/characterState") }, playerId, opts),
      industryJobs: (playerId, opts) => dbOff() || readIndustryJobsFrom({
        industry: exportsOf("services/industry/industryRuntimeState") }, playerId, opts),
      marketOrders: (playerId, opts) => {
        const off = dbOff();
        if (off) return Promise.resolve(off);
        const md = exportsOf("services/market/marketDaemonClient");
        return readMarketOrdersFrom({ marketDaemon: md ? md.marketDaemonClient || null : null }, playerId, opts);
      },
      orderState: (playerId, orderId, opts) => {
        const off = dbOff();
        if (off) return Promise.resolve(off);
        const md = exportsOf("services/market/marketDaemonClient");
        return readOrderStateFrom({ marketDaemon: md ? md.marketDaemonClient || null : null }, playerId, orderId,
          opts);
      },
    });
    const activityOff = (consumer) => {
      const d = state.report ? state.report.disabledModules : null;
      return d && hasOwn(d, consumer) ? { ok: false, reason: "SEAM_UNAVAILABLE", detail: consumer } : null;
    };
    const installHook = (slot, consumer, rel, make) => {
      const off = activityOff(consumer);
      if (off) return off;
      if (shipAiActivityHooks[slot]) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
      const loaded = requireGame(rel);
      if (!loaded.ok || !loaded.exports) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${slot}_${loaded.reason}` };
      }
      const hook = make(loaded.exports);
      const r = hook.install();
      if (!r.ok) {
        return r.reason === "HOOK_ALREADY_INSTALLED" ? { ok: false, reason: "HOOK_ALREADY_INSTALLED" }
          : { ok: false, reason: "SEAM_UNAVAILABLE", detail: r.reason };
      }
      shipAiActivityHooks[slot] = hook;
      return { ok: true };
    };
    const activity = Object.freeze({
      installMiningHook: (onStop, isWatched) => installHook("mining", "shipAiMining", "services/mining/miningRuntime",
        (exportsObj) => createMiningStopHook({ miningExports: exportsObj, onStop, isWatched, now: () => Date.now(),
          logger: { log: logAdapter } })),
      installSiteHook: (onCleared, isWatched, scanMax) => installHook("site", "shipAiSite",
        "services/dungeon/dungeonTrackingRuntime", (exportsObj) => createSiteClearedHook({ trackingExports: exportsObj,
          onCleared, isWatched, scanMax, now: () => Date.now(), logger: { log: logAdapter } })),
      setKillListener: (listener) => {
        const off = listener ? activityOff("shipAiKills") : null;
        if (off) return off;
        setShipAiKills(listener || null);
        return { ok: true, wrapMounted: killWrapMounted() };
      },
      uninstallAll: () => {
        for (const slot of ["mining", "site"]) {
          if (shipAiActivityHooks[slot]) shipAiActivityHooks[slot].uninstall();
          shipAiActivityHooks[slot] = null;
        }
        setShipAiKills(null);
        return { ok: true };
      },
      stats: () => ({ mining: shipAiActivityHooks.mining ? shipAiActivityHooks.mining.stats() : null,
        site: shipAiActivityHooks.site ? shipAiActivityHooks.site.stats() : null }),
    });
    return { ok: true, seam: { channel, xmpp, identities: identitySeam, telemetry: sensors.telemetry, sensors,
      portrait, db, activity } };
  }

  let systemSenderMemo = null;
  function shipAiMailSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "shipAiMail")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.shipAiMail).slice(0, 120) };
    }
    const systemSender = () => {
      if (systemSenderMemo === null) {
        const r = mail().defaultMailSender();
        if (r.ok) systemSenderMemo = r.senderId;
      }
      return systemSenderMemo;
    };
    return { ok: true, seam: Object.freeze({
      hookState: () => (shipAiMailHook.isInstalled() ? "installed" : "not_installed"),
      addListener: (fn) => shipAiMailHook.addListener(fn),
      removeListener: (fn) => shipAiMailHook.removeListener(fn),
      listIncoming: (spec) => mail().listIncomingMail(spec),
      readIncoming: (spec) => mail().readIncomingMail(spec),
      senderInfo: (id) => {
        const system = Number.isSafeInteger(id) && id > 0 && id === systemSender();
        const peek = Number.isSafeInteger(id) && id > 0 ? identities.peekCharacterRecord(id) : null;
        const name = peek && peek.ok && peek.record && typeof peek.record.characterName === "string"
          && peek.record.characterName !== "" ? peek.record.characterName : null;
        return { name, system };
      },
    }) };
  }

  function virtualKillmailSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "freeCorpsKillmails")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.freeCorpsKillmails) };
    }
    return { ok: true };
  }

  function freeSagaLeanSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "freeSagaLean")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.freeSagaLean) };
    }
    return { ok: true };
  }

  function writeVirtualKillmail(spec, eventId) {
    const seam = virtualKillmailSeams();
    if (!seam.ok) return seam;
    const loaded = requireGame("services/killmail/killmailState");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(loaded.reason).slice(0, 200) };
    return writeVirtualKillmailWith(loaded.exports, spec, eventId);
  }

  function freeCorpRecycleSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "freeCorpsRecycle")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.freeCorpsRecycle) };
    }
    return { ok: true };
  }

  const recycleModules = () => {
    const out = {};
    for (const [key, rel] of [["characterState", "services/character/characterState"],
      ["corporationState", "services/corporation/corporationState"],
      ["corporationRuntimeState", "services/corporation/corporationRuntimeState"]]) {
      const loaded = requireGame(rel);
      if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(loaded.reason).slice(0, 200) };
      out[key] = loaded.exports;
    }
    return { ok: true, mods: out };
  };

  function moveFreeCharacter(spec) {
    const seam = freeCorpRecycleSeams();
    if (!seam.ok) return seam;
    const m = recycleModules();
    return m.ok ? moveFreeCharacterWith(m.mods, spec) : m;
  }

  function setCorporationDescription(corporationId, description) {
    const seam = freeCorpRecycleSeams();
    if (!seam.ok) return seam;
    const m = recycleModules();
    return m.ok ? setCorporationDescriptionWith(m.mods, corporationId, description) : m;
  }

  let structureSeam = null;
  function getStructureSeam() {
    if (structureSeam === null) structureSeam = createStructureSeam({ requireGame });
    return structureSeam;
  }

  function checkStructureSeams() {
    return getStructureSeam().checkStructureSeams();
  }

  function sovStructureSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "sovStructuresPhysical")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.sovStructuresPhysical) };
    }
    return { ok: true, seam: getStructureSeam() };
  }

  function freeCorpStructureSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "freeCorpsStructures")) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.freeCorpsStructures) };
    }
    return { ok: true, seam: getStructureSeam() };
  }

  let playerStructureSeam = null;
  const getPlayerStructureSeam = () => {
    if (playerStructureSeam === null) {
      playerStructureSeam = createPlayerStructureSeam({ requireGame, disabledReason: (consumer) => {
        const disabled = state.report ? state.report.disabledModules : null;
        return disabled && hasOwn(disabled, consumer) ? String(disabled[consumer]) : null;
      } });
    }
    return playerStructureSeam;
  };
  function playerStructureSeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "playerSiege")) {
      return { ok: false, reason: "PLAYER_STRUCTURES_SEAM_UNAVAILABLE", detail: String(disabled.playerSiege) };
    }
    return getPlayerStructureSeam().checkSeams();
  }

  let playerSkyhookSeam = null;
  const getPlayerSkyhookSeam = () => {
    if (playerSkyhookSeam === null) {
      playerSkyhookSeam = createPlayerSkyhookSeam({ requireGame, disabledReason: (consumer) => {
        const disabled = state.report ? state.report.disabledModules : null;
        return disabled && hasOwn(disabled, consumer) ? String(disabled[consumer]) : null;
      } });
    }
    return playerSkyhookSeam;
  };

  let harvestBaySeam = null;
  const getHarvestBaySeam = () => {
    if (harvestBaySeam === null) {
      harvestBaySeam = createHarvestBaySeam({ requireGame, disabledReason: (consumer) => {
        const disabled = state.report ? state.report.disabledModules : null;
        return disabled && hasOwn(disabled, consumer) ? String(disabled[consumer]) : null;
      } });
    }
    return harvestBaySeam;
  };

  let sentrySeam = null;
  function sentrySeams() {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "sentries")) {
      return { ok: false, reason: "SENTRY_SEAM_UNAVAILABLE", detail: String(disabled.sentries) };
    }
    const wraps = sentrySeamsModule.checkWraps();
    if (!wraps.ok) return wraps;
    if (sentrySeam === null) sentrySeam = sentrySeamsModule.createSentrySeam({ requireGame });
    const check = sentrySeam.checkSeams();
    if (!check.ok) return check;
    const installs = sentrySeamsModule.installState();
    const optional = {};
    for (const group of ["dogmaErrors", "posMgrErrors", "defensePresentation"]) {
      if (installs[group] !== "wrapped" && installs[group] !== "already_installed") optional[group] = installs[group];
    }
    if (disabled && hasOwn(disabled, "sentryLook")) optional.sentryLook = String(disabled.sentryLook);
    return { ok: true, seam: sentrySeam, optional };
  }

  const runSovCall = async (requireGameFn, logger, sovGmState, functionName, args) => {
    try {
      const fn = sovGmState[functionName];
      if (typeof fn !== "function") return { ok: false, reason: `${functionName}_not_a_function`, permanent: false };
      const result = await fn(...args);
      if (!result || result.success !== true) {
        const msg = result?.errorMsg ?? "unknown vendor error";
        const permanent = functionName === "anchorSovereigntyHub" && msg?.includes?.("allianceID");
        return { ok: false, reason: msg, permanent };
      }
      const gameStore = requireGameFn("gameStore/index");
      if (gameStore.ok && gameStore.exports && typeof gameStore.exports.flushTableSync === "function") {
        try {
          const flushResult = await flushTable(gameStore.exports, "sovereignty");
          if (!flushResult || flushResult.success !== true) {
            logger?.warn?.(`[sovProjection] sovereignty flush returned failure: ${flushResult?.errorMsg ?? "unknown"}`);
          }
        } catch (flushErr) {
          logger?.warn?.(`[sovProjection] sovereignty flush threw: ${flushErr.message}`);
        }
      }
      return { ok: true };
    } catch (err) {
      const msg = (err && err.message) || err;
      if (msg && msg.includes("allianceID")) {
        return { ok: false, reason: "PLAYER_CLAIM_PROTECTED", permanent: false };
      }
      return { ok: false, reason: `sov_call_failed: ${msg}`, permanent: false };
    }
  };

  let playerSovSeam = null;
  const getPlayerSovSeam = () => {
    if (playerSovSeam === null) {
      playerSovSeam = createPlayerSovSeam({ requireGame,
        executeSovCall: (sovGmState, name, args) => runSovCall(requireGame, { warn: logAdapter }, sovGmState, name, args),
        disabledReason: () => {
          const disabled = state.report ? state.report.disabledModules : null;
          return disabled && hasOwn(disabled, "playerSov") ? String(disabled.playerSov) : null;
        } });
    }
    return playerSovSeam;
  };
  const readPlayerSov = (opts) => getPlayerSovSeam().readPlayerSov(opts);
  const releasePlayerSov = (systemId, expect) => getPlayerSovSeam().releasePlayerSov(systemId, expect);
  const capturePlayerSov = (systemId, expect) => getPlayerSovSeam().capturePlayerSov(systemId, expect);
  const readSovereigntyTableUpdatedAt = () => getPlayerSovSeam().readSovereigntyTableUpdatedAt();
  const playerSovSeams = () => getPlayerSovSeam().checkSeams();
  const ORG_NAME_CONSUMERS = Object.freeze(["playerSovNames", "killboard.names"]);
  const orgNamesByConsumer = new Map();
  const consumerDrift = (consumer) => {
    const disabled = state.report ? state.report.disabledModules : null;
    return disabled && hasOwn(disabled, consumer) ? String(disabled[consumer]) : null;
  };
  const readPlayerOrgNames = (spec, consumer) => {
    const name = consumer === undefined ? "playerSovNames" : consumer;
    if (!ORG_NAME_CONSUMERS.includes(name)) return { ok: false, reason: "INVALID_INPUT", detail: "consumer" };
    let inst = orgNamesByConsumer.get(name);
    if (!inst) {
      inst = createPlayerOrgNames({ requireGame, disabledReason: () => consumerDrift(name) });
      orgNamesByConsumer.set(name, inst);
    }
    return inst.read(spec);
  };

  const killboardSeams = () => {
    const drift = consumerDrift("killboard.vendorKills");
    if (drift !== null) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", missing: ["killboard.vendorKills"], detail: drift };
    }
    return { ok: true, missing: [] };
  };
  const readVendorKillsAfter = (spec) => {
    const seam = killboardSeams();
    if (!seam.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: seam.detail };
    const loaded = requireGame("services/killmail/killmailState");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(loaded.reason).slice(0, 200) };
    return readVendorKillsFrom(loaded.exports, spec);
  };
  const readCharacterNames = (ids) => {
    let vendor = null;
    if (consumerDrift("killboard.names") === null) {
      const loaded = requireGame("services/character/characterState");
      vendor = loaded.ok ? loaded.exports : null;
    }
    return readCharacterNamesFrom(vendor, ids);
  };
  let deployGateTools = null;
  function getPlayerSovDeployGateTools() {
    try {
      if (deployGateTools === null) {
        deployGateTools = createDeployGateTools({ requireGame, disabledReason: () => {
          const disabled = state.report ? state.report.disabledModules : null;
          return disabled && hasOwn(disabled, "playerSovGate") ? String(disabled.playerSovGate) : null;
        } });
      }
      const check = deployGateTools.check();
      return check.ok ? { ok: true, tools: deployGateTools } : check;
    } catch (err) {
      return { ok: false, reason: "PLAYER_SOV_GATE_UNAVAILABLE", detail: String((err && err.message) || err).slice(0, 120) };
    }
  }

  let capsuleSweepTools = null;
  function getCapsuleSweepTools() {
    try {
      if (capsuleSweepTools === null) {
        capsuleSweepTools = createCapsuleSweepTools({ requireGame, disabledReason: () => {
          const disabled = state.report ? state.report.disabledModules : null;
          return disabled && hasOwn(disabled, "capsuleSweep") ? String(disabled.capsuleSweep) : null;
        } });
      }
      return capsuleSweepTools.get();
    } catch (err) {
      return { ok: false, reason: "CAPSULE_SWEEP_UNAVAILABLE", detail: String((err && err.message) || err).slice(0, 120) };
    }
  }

  let bookmarkSiteWarpTools = null;
  function getBookmarkSiteWarpTools() {
    try {
      if (bookmarkSiteWarpTools === null) {
        bookmarkSiteWarpTools = createBookmarkSiteWarpTools({ requireGame, disabledReason: () => {
          const disabled = state.report ? state.report.disabledModules : null;
          return disabled && hasOwn(disabled, "bookmarkSiteWarp") ? String(disabled.bookmarkSiteWarp) : null;
        } });
      }
      return bookmarkSiteWarpTools.get();
    } catch (err) {
      return { ok: false, reason: "BOOKMARK_SITE_WARP_UNAVAILABLE",
        detail: String((err && err.message) || err).slice(0, 120) };
    }
  }

  function getSovProjection(deps = {}) {
    const {
      requireGame: requireGameFn = requireGame,
      isVirtualAlliance: isVirtualAllianceFn,
      telemetry,
      config,
      clock,
      logger,
    } = deps;

    if (typeof requireGameFn !== "function") {
      throw new Error("getSovProjection: requireGame function is required");
    }
    if (typeof isVirtualAllianceFn !== "function") {
      throw new Error("getSovProjection: isVirtualAlliance function is required");
    }
    const isVirtualAlliance = (allianceId) => {
      try {
        return isVirtualAllianceFn(allianceId) === true;
      } catch (_err) {
        return false;
      }
    };

    const invaderFactionIds = new Set(
      (config?.world?.sovProjection?.invaderFactionIds ?? "500021,500026,500029")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Number(s))
        .filter((n) => Number.isSafeInteger(n) && n > 0)
    );
    const reinforceOnLoss = config?.world?.sovProjection?.reinforceOnLoss ?? false;

    function loadSovModules() {
      const gmState = requireGameFn("services/sovereignty/sovGmState");
      if (!gmState.ok) return { ok: false, reason: `sovGmState_${gmState.reason}` };
      const state = requireGameFn("services/sovereignty/sovState");
      if (!state.ok) return { ok: false, reason: `sovState_${state.reason}` };
      const rules = requireGameFn("services/sovereignty/sovSystemRules");
      if (!rules.ok) return { ok: false, reason: `sovSystemRules_${rules.reason}` };
      return { ok: true, sovGmState: gmState.exports, sovState: state.exports, sovSystemRules: rules.exports };
    }

    async function readEvejsClaim(sovState, systemId) {
      let playerHub = false;
      try {
        const system = typeof sovState.getSystemState === "function" ? sovState.getSystemState(systemId) : null;
        playerHub = neutralPlayerHubOf(system, isVirtualAlliance) !== null;
      } catch (err) {
        return { ok: false, reason: `getSystemState_failed: ${(err && err.message) || err}` };
      }
      try {
        const claim = sovState.getSystemSovClaim ? await sovState.getSystemSovClaim(systemId) : null;
        if (!claim) return { ok: true, claim: null, playerHub };
        const allianceId = claim.allianceID ?? claim.allianceId ?? null;
        const corpId = claim.corporationID ?? claim.corporationId ?? null;
        const isVirtual = allianceId !== null && allianceId > 0 && isVirtualAlliance(allianceId);
        return { ok: true, claim: { allianceID: allianceId, corporationID: corpId, isVirtualAlliance: isVirtual },
          playerHub };
      } catch (err) {
        return { ok: false, reason: `getSystemSovClaim_failed: ${(err && err.message) || err}` };
      }
    }

    async function checkClaimable(sovSystemRules, systemId) {
      try {
        const isClaimable = sovSystemRules.isSovereigntyClaimableSolarSystem
          ? await sovSystemRules.isSovereigntyClaimableSolarSystem(systemId)
          : false;
        return { ok: true, isClaimable: Boolean(isClaimable) };
      } catch (err) {
        return { ok: false, reason: `isSovereigntyClaimableSolarSystem_failed: ${(err && err.message) || err}` };
      }
    }

    const executeSovCall = (sovGmState, functionName, args) =>
      runSovCall(requireGameFn, logger, sovGmState, functionName, args);

    async function readSovState(systemId) {
      const modules = loadSovModules();
      if (!modules.ok) return { ok: false, reason: modules.reason };

      const { sovState, sovSystemRules } = modules;

      const [claimRes, claimableRes] = await Promise.all([
        readEvejsClaim(sovState, systemId),
        checkClaimable(sovSystemRules, systemId),
      ]);

      if (!claimRes.ok) return { ok: false, reason: claimRes.reason };
      if (!claimableRes.ok) return { ok: false, reason: claimableRes.reason };

      return { ok: true, claim: claimRes.claim, claimable: claimableRes.isClaimable, playerHub: claimRes.playerHub === true };
    }

    async function projectSovCall(systemId, action, allianceId, corpId) {
      const modules = loadSovModules();
      if (!modules.ok) return { ok: false, reason: modules.reason };

      const { sovGmState, sovState, sovSystemRules } = modules;

      const claimable = await checkClaimable(sovSystemRules, systemId);
      if (!claimable.ok) return { ok: false, reason: claimable.reason };
      if (!claimable.isClaimable) {
        return { ok: true, action: ACTION.NONE, reason: REASON.NOT_CLAIMABLE, skipped: true };
      }

      if (action === ACTION.GAIN) {
        const claim = await readEvejsClaim(sovState, systemId);
        if (!claim.ok) return { ok: false, reason: claim.reason };
        if (claim.claim && claim.claim.allianceID !== null && claim.claim.allianceID > 0 && !claim.claim.isVirtualAlliance) {
          return { ok: false, reason: REASON.PLAYER_CLAIM_PROTECTED, permanent: false };
        }
        if (claim.playerHub === true) return { ok: false, reason: REASON.PLAYER_CLAIM_PROTECTED, permanent: false };
      }

      let result;
      switch (action) {
        case ACTION.GAIN:
          result = await executeSovCall(sovGmState, "anchorSovereigntyHub", [systemId, allianceId, corpId]);
          break;
        case ACTION.LOSS:
          result = await executeSovCall(sovGmState, "loseSystemSovereignty", [systemId]);
          break;
        case ACTION.TRANSFER:
          result = await executeSovCall(sovGmState, "loseSystemSovereignty", [systemId, allianceId, corpId]);
          break;
        case ACTION.REINFORCE:
          result = await executeSovCall(sovGmState, "reinforceSystemHub", [systemId]);
          break;
        default:
          return { ok: false, reason: `UNKNOWN_ACTION: ${action}`, permanent: false };
      }

      if (!result.ok) {
        return { ok: false, action, reason: result.reason, permanent: result.permanent };
      }

      if (telemetry) {
        telemetry.count(`sovProjection.${action.toLowerCase()}`, 1);
      }

      return { ok: true, action, reason: null };
    }

    return { projectSovCall, readSovState };
  }

  function checkTradeSeams() {
    const fn = (name) => ({ name, kind: "function" });
    const obj = (name) => ({ name, kind: "object" });
    const required = [
      { path: "services/contracts/contractRuntimeState", symbols: [fn("createContract"), fn("getContractRecord"), fn("deleteContract"), fn("listContractRecords"), obj("CONTRACT_STATUS")] },
      { path: "services/contracts/contractSettlementState", symbols: [fn("listPendingContractSettlements"), fn("findPendingContractSettlement"), fn("getPendingContractSettlement")] },
      { path: "services/corporation/corpWalletState", symbols: [fn("adjustCorporationWalletDivisionBalanceAsync"), fn("getCorporationWallet")] },
      { path: "services/corporation/corporationRuntimeState", symbols: [fn("getCorporationRuntime")] },
      { path: "services/corporation/corporationState", symbols: [fn("getCorporationRecord")] },
      { path: "services/inventory/itemStore", symbols: [fn("listContainerItems"), obj("ITEM_FLAGS")] },
      { path: "services/inventory/itemCustody", symbols: [fn("transfer"), obj("CUSTODY_REASON"), fn("getCommittedReceipt"), obj("custodyRef")] },
      { path: "services/market/marketDaemonClient", symbols: [obj("marketDaemonClient")] },
      { path: "services/industry/industryPricing", symbols: [fn("resolveAdjustedAverageTypePrice")] },
    ];
    const missing = [];
    for (const entry of required) {
      const loaded = requireGame(entry.path);
      if (!loaded.ok) {
        missing.push(`${entry.path}: ${loaded.reason}`);
        continue;
      }
      const exports = loaded.exports;
      for (const sym of entry.symbols) {
        const value = exports == null ? undefined : exports[sym.name];
        const shapeOk = sym.kind === "function"
          ? typeof value === "function"
          : value !== null && typeof value === "object";
        if (!shapeOk) missing.push(`${entry.path}.${sym.name}`);
      }
    }
    return missing.length === 0
      ? { ok: true }
      : { ok: false, reason: "TRADE_SEAM_UNAVAILABLE", missing };
  }

  const ensureCorpIssuerAuthority = createCorpIssuerAuthorityInstaller(requireGame, logAdapter);

  let privateContractFee = null;
  function tradePrivateContractFee() {
    if (privateContractFee !== null) return privateContractFee;
    if (state.serverSrc === null) return { ok: false, reason: "SERVER_SRC_UNKNOWN" };
    const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
    let text;
    try {
      text = readFileSync(path.join(state.serverSrc, "services", "contracts", "contractRuntimeState.js"), "utf8");
    } catch (_err) {
      text = null;
    }
    privateContractFee = typeof text === "string"
      ? parsePrivateContractFee(text.replace(/\r\n/g, "\n"))
      : { ok: false, reason: "SOURCE_UNREADABLE" };
    return privateContractFee;
  }

  let marketFillMode = null;
  const tradeMarketFillMode = () => {
    if (marketFillMode !== null) return marketFillMode;
    if (state.serverSrc === null) return { ok: false, reason: "SERVER_SRC_UNKNOWN" };
    const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
    const readText = (...parts) => {
      try {
        const text = readFileSync(path.join(state.serverSrc, ...parts), "utf8");
        return typeof text === "string" ? text.replace(/\r\n/g, "\n") : null;
      } catch (_err) {
        return null;
      }
    };
    const marketText = readText("services", "market", "marketProxyService.js");
    const corpText = readText("services", "corporation", "corporationState.js");
    marketFillMode = marketText === null || corpText === null
      ? { ok: false, reason: "SOURCE_UNREADABLE" }
      : parseMarketFillRule(marketText, corpText);
    if (marketFillMode.ok !== true) {
      logAdapter(`[LivingNewEden] trade market fill rule unknown (${marketFillMode.reason}`
        + `${marketFillMode.detail ? `:${marketFillMode.detail}` : ""}) - market intake keeps the hangar stack path`);
    }
    return marketFillMode;
  };

  function tradeCreateContract(payload) {
    const loaded = requireGame("services/contracts/contractRuntimeState");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    ensureCorpIssuerAuthority();
    return createWantToBuyFrom(loaded.exports, payload);
  }

  function tradeFindContract({ ownerId, corporationId, offerId }) {
    const crLoaded = requireGame("services/contracts/contractRuntimeState");
    if (!crLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: crLoaded.reason };
    const csLoaded = requireGame("services/contracts/contractSettlementState");
    if (!csLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: csLoaded.reason };
    return findTradeContractFrom(crLoaded.exports, csLoaded.exports, { ownerId, corporationId, offerId });
  }

  function tradeReadContract(contractId) {
    const crLoaded = requireGame("services/contracts/contractRuntimeState");
    if (!crLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: crLoaded.reason };
    const csLoaded = requireGame("services/contracts/contractSettlementState");
    if (!csLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: csLoaded.reason };
    return readTradeContractFrom(crLoaded.exports, csLoaded.exports, contractId);
  }

  function tradeDeleteContract({ contractId, ceoId, corporationId }) {
    const loaded = requireGame("services/contracts/contractRuntimeState");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    ensureCorpIssuerAuthority();
    return deleteTradeContractFrom(loaded.exports, { contractId, ceoId, corporationId });
  }

  function tradeAdjustWallet(spec) {
    if (spec && spec.ownerKind === "character") {
      const loaded = requireGame(WALLET_STATE);
      if (!loaded.ok) return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: loaded.reason });
      return adjustCharacterWalletFrom(loaded.exports, {
        ownerId: spec.ownerId, deltaIsk: spec.deltaIsk, commandId: spec.commandId, description: spec.description,
      }).then((result) => {
        if (result.ok && result.capped === true) logAdapter(`trade: character wallet credit capped by EveJS (${spec.commandId})`);
        return result;
      });
    }
    if (spec && spec.ownerKind !== undefined && spec.ownerKind !== "corporation") {
      return Promise.resolve({ ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_owner_kind" });
    }
    const wsLoaded = requireGame("services/corporation/corpWalletState");
    if (!wsLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: wsLoaded.reason };
    return adjustCorpDivisionFrom(wsLoaded.exports, wsLoaded.exports, spec);
  }

  function tradeReadCharacter(characterId) {
    const loaded = requireGame(CHARACTER_STATE);
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    return readCharacterFrom(loaded.exports, characterId);
  }

  function tradeReadCharacterWallet(characterId) {
    const loaded = requireGame(WALLET_STATE);
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    return { ok: true, balanceIsk: characterBalanceOf(loaded.exports, characterId) };
  }

  function tradeVirtualIssuerSeams() {
    const missing = [];
    const wallet = requireGame(WALLET_STATE);
    if (!wallet.ok) missing.push(`${WALLET_STATE}: ${wallet.reason}`);
    else {
      for (const name of ["adjustCharacterBalanceAsync", "getCharacterWallet"]) {
        if (!wallet.exports || typeof wallet.exports[name] !== "function") missing.push(`${WALLET_STATE}.${name}`);
      }
    }
    const character = requireGame(CHARACTER_STATE);
    if (!character.ok) missing.push(`${CHARACTER_STATE}: ${character.reason}`);
    else if (!character.exports || typeof character.exports.peekCharacterRecord !== "function") {
      missing.push(`${CHARACTER_STATE}.peekCharacterRecord`);
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  function rewardCreditIsk(spec) {
    const wallet = requireGame(WALLET_STATE);
    if (!wallet.ok) return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: wallet.reason });
    const gameStore = requireGame("gameStore/index");
    if (!gameStore.ok) {
      return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: gameStore.reason });
    }
    return creditRewardIskFrom(wallet.exports, gameStore.exports, spec);
  }

  function rollFactionOfficerLoot(factionId, seed) {
    try {
      const npcData = requireGame("space/npc/npcData");
      const npcLoot = requireGame("space/npc/npcLoot");
      if (!npcData.ok || !npcLoot.ok) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(npcData.ok ? npcLoot.reason : npcData.reason) };
      }
      return rollOfficerLootFrom(npcData.exports, npcLoot.exports, factionId, seed);
    } catch (err) {
      return { ok: false, reason: "ROLL_FAILED", detail: String((err && err.message) || err).slice(0, 120) };
    }
  }

  function rewardCreditLp(spec) {
    const lp = requireGame(LP_WALLET_STATE);
    if (!lp.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: lp.reason };
    return creditRewardLpFrom(lp.exports, spec);
  }

  function rewardSeams() {
    const missing = [];
    const need = [[WALLET_STATE, ["adjustCharacterBalanceAsync", "getCharacterWallet"]],
      ["gameStore/index", ["flushTableSync"]], [LP_WALLET_STATE, ["adjustCharacterWalletLPBalanceDurable"]]];
    for (const [rel, names] of need) {
      const loaded = requireGame(rel);
      if (!loaded.ok) {
        missing.push(`${rel}: ${loaded.reason}`);
        continue;
      }
      for (const name of names) {
        if (!loaded.exports || typeof loaded.exports[name] !== "function") missing.push(`${rel}.${name}`);
      }
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  function getVirtualCorps() {
    if (typeof globalThis.getLivingNewEdenVirtualCorps === "function") {
      return globalThis.getLivingNewEdenVirtualCorps();
    }
    return null;
  }

  function tradeReadWallet(corporationId, accountKey) {
    const loaded = requireGame("services/corporation/corpWalletState");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    return { ok: true, balanceIsk: divisionBalanceOf(loaded.exports, corporationId, accountKey) };
  }

  function tradeReadIssuer(corporationId) {
    const csLoaded = requireGame("services/corporation/corporationState");
    if (!csLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: csLoaded.reason };
    const crLoaded = requireGame("services/corporation/corporationRuntimeState");
    if (!crLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: crLoaded.reason };
    return readIssuerFrom(csLoaded.exports, crLoaded.exports, corporationId);
  }

  function tradeListDeliveredStacks(spec) {
    const loaded = requireGame("services/inventory/itemStore");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    return listDeliveredStacksFrom(loaded.exports, spec);
  }

  function tradeVoidStack(spec) {
    const icLoaded = requireGame("services/inventory/itemCustody");
    if (!icLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: icLoaded.reason };
    const isLoaded = requireGame("services/inventory/itemStore");
    if (!isLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: isLoaded.reason };
    return voidDeliveredStackFrom(icLoaded.exports, isLoaded.exports, spec);
  }

  function tradeListTaggedContracts(spec) {
    const loaded = requireGame("services/contracts/contractRuntimeState");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    if (spec && spec.liveRead === true) {
      const store = requireGame("gameStore/index");
      if (store.ok) return listTaggedContractsFrom(loaded.exports, spec, { gameStore: store.exports });
    }
    return listTaggedContractsFrom(loaded.exports, spec);
  }

  function tradeSellSeams() {
    const loaded = requireGame("services/inventory/itemStore");
    if (!loaded.ok) return { ok: false, detail: `services/inventory/itemStore: ${loaded.reason}` };
    const missing = ["grantItemToOwnerLocationIdempotent", "getIdempotentGrantReceipt"]
      .filter((name) => !loaded.exports || typeof loaded.exports[name] !== "function");
    return missing.length === 0 ? { ok: true } : { ok: false, detail: missing.join(",") };
  }

  function tradeGrantStock(spec) {
    const loaded = requireGame("services/inventory/itemStore");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, ambiguous: false, detail: loaded.reason };
    return grantSellStockFrom(loaded.exports, spec);
  }

  function tradeGrantReceipt(key) {
    const loaded = requireGame("services/inventory/itemStore");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    return readGrantReceiptFrom(loaded.exports, key);
  }

  function seasonRewardStation(characterId, fallbackStationId) {
    try {
      const d = state.report ? state.report.disabledModules : null;
      if (d && hasOwn(d, "seasonRewards")) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const cs = requireGame(CHARACTER_STATE);
      const wd = requireGame("space/worldData");
      if (!cs.ok || !wd.ok || !wd.exports || typeof wd.exports.getStationByID !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE" };
      }
      const pilot = readPilotFrom({ characterState: cs.exports, corporationState: null }, characterId);
      if (!pilot.ok) return { ok: false, reason: pilot.reason === "NO_RECORD" ? "CHARACTER_NOT_FOUND" : "SEAM_UNAVAILABLE" };
      const known = (id) => Number.isSafeInteger(id) && id > 0 && wd.exports.getStationByID(id) != null;
      if (known(pilot.homeStationId)) return { ok: true, stationId: pilot.homeStationId, source: "HOME" };
      if (known(fallbackStationId)) return { ok: true, stationId: fallbackStationId, source: "FALLBACK" };
      return { ok: false, reason: "NO_STATION" };
    } catch (_err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE" };
    }
  }

  function tradeCreateSellContract(payload) {
    const crLoaded = requireGame("services/contracts/contractRuntimeState");
    if (!crLoaded.ok) return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: crLoaded.reason });
    const isLoaded = requireGame("services/inventory/itemStore");
    if (!isLoaded.ok) return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: isLoaded.reason });
    ensureCorpIssuerAuthority();
    return createWantToSellFrom(crLoaded.exports, isLoaded.exports, payload);
  }

  function tradeCreateCourierContract(payload) {
    const crLoaded = requireGame("services/contracts/contractRuntimeState");
    if (!crLoaded.ok) return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: crLoaded.reason });
    const isLoaded = requireGame("services/inventory/itemStore");
    if (!isLoaded.ok) return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: isLoaded.reason });
    return createCourierFrom(crLoaded.exports, isLoaded.exports, payload);
  }

  function tradeFailCourierContract({ contractId, ceoId, corporationId } = {}) {
    const loaded = requireGame("services/contracts/contractRuntimeState");
    if (!loaded.ok) {
      return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, pending: false, detail: loaded.reason });
    }
    return failCourierFrom(loaded.exports, { contractId, ceoId, corporationId });
  }

  function readTradePrices(spec) {
    const mdLoaded = requireGame("services/market/marketDaemonClient");
    if (!mdLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: mdLoaded.reason };
    const ipLoaded = requireGame("services/industry/industryPricing");
    if (!ipLoaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: ipLoaded.reason };
    const marketDaemon = mdLoaded.exports.marketDaemonClient || mdLoaded.exports;
    return readTradePricesFrom(marketDaemon, ipLoaded.exports, spec);
  }

  function readStationAsks(spec) {
    const mdLoaded = requireGame("services/market/marketDaemonClient");
    if (!mdLoaded.ok) return Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", detail: mdLoaded.reason });
    const marketDaemon = mdLoaded.exports ? mdLoaded.exports.marketDaemonClient || mdLoaded.exports : null;
    return readStationAsksFrom(marketDaemon, spec);
  }

  let externalPriceGetter = null;
  function fetchExternalPrices(spec) {
    try {
      if (externalPriceGetter === null) externalPriceGetter = createDefaultHttpsGetter();
      return fetchExternalPricesWith(externalPriceGetter, spec);
    } catch (err) {
      return Promise.resolve({ ok: false, reason: "EXT_THREW", detail: String((err && err.message) || err).slice(0, 200) });
    }
  }

  const marketSeam = (relPath) => {
    const loaded = requireGame(relPath);
    if (!loaded.ok) return { ok: false, detail: `${relPath}: ${loaded.reason}` };
    if (loaded.exports == null) return { ok: false, detail: `${relPath}: no_exports` };
    return { ok: true, exports: loaded.exports };
  };
  const taggedEscrowSeam = () => {
    const es = marketSeam("services/market/marketEscrowState");
    if (!es.ok) return es;
    const tagged = createTaggedEscrowState(es.exports, vendorTags, vendorTagHooks);
    return tagged.ok ? { ok: true, exports: tagged.view } : { ok: false, detail: tagged.detail };
  };
  const marketDaemonSeam = () => {
    const md = marketSeam("services/market/marketDaemonClient");
    return md.ok ? { ok: true, exports: md.exports.marketDaemonClient || md.exports } : md;
  };
  const seamDown = (detail, extra) => ({ ok: false, reason: "SEAM_UNAVAILABLE", ...(extra || {}), detail });
  const buyOrderStationMetadata = (stationId) => {
    try {
      const wd = marketSeam("space/worldData");
      if (!wd.ok || typeof wd.exports.getStationByID !== "function") return undefined;
      return stationMetadataFrom(wd.exports.getStationByID(Number(stationId)), stationId);
    } catch (_err) {
      return undefined;
    }
  };

  function tradeMarketPlace(spec) {
    const flags = { permanent: false, ambiguous: false };
    const md = marketDaemonSeam();
    if (!md.ok) return Promise.resolve(seamDown(md.detail, flags));
    const es = taggedEscrowSeam();
    if (!es.ok) return Promise.resolve(seamDown(es.detail, flags));
    const metadata = buyOrderStationMetadata(spec && spec.stationId);
    return placeAndAttachBuyOrderFrom(md.exports, es.exports, spec, Date.now(), metadata);
  }

  function tradeMarketRead(orderId) {
    const md = marketDaemonSeam();
    if (!md.ok) return Promise.resolve(seamDown(md.detail));
    const es = taggedEscrowSeam();
    if (!es.ok) return Promise.resolve(seamDown(es.detail));
    return readBuyOrderFrom(md.exports, es.exports, orderId);
  }

  function tradeMarketFind(spec) {
    const md = marketDaemonSeam();
    if (!md.ok) return Promise.resolve(seamDown(md.detail));
    const es = taggedEscrowSeam();
    if (!es.ok) return Promise.resolve(seamDown(es.detail));
    return findBuyOrderFrom(md.exports, es.exports, spec);
  }

  function tradeMarketAttachEscrow(spec) {
    const es = taggedEscrowSeam();
    if (!es.ok) return seamDown(es.detail);
    return attachBuyEscrowFrom(es.exports, spec);
  }

  function tradeMarketDetachEscrow(spec) {
    const es = taggedEscrowSeam();
    if (!es.ok) return seamDown(es.detail);
    const s = spec || {};
    return detachEscrowFrom(es.exports, { ...s, escrowType: s.escrowType === undefined ? "buy" : s.escrowType });
  }

  function tradeMarketCancel(orderId) {
    const md = marketDaemonSeam();
    if (!md.ok) return Promise.resolve(seamDown(md.detail));
    return cancelBuyOrderFrom(md.exports, orderId);
  }

  function tradeMarketListCorpOrders(corporationId) {
    const md = marketDaemonSeam();
    if (!md.ok) return Promise.resolve(seamDown(md.detail));
    const es = taggedEscrowSeam();
    if (!es.ok) return Promise.resolve(seamDown(es.detail));
    return listCorpOrdersFrom(md.exports, es.exports, corporationId);
  }

  function tradeMarketListTaggedEscrows(spec) {
    const es = taggedEscrowSeam();
    if (!es.ok) return seamDown(es.detail);
    return listTaggedEscrowsFrom(es.exports, spec);
  }

  const sellMarketSeams = () => {
    const md = marketDaemonSeam();
    if (!md.ok) return md;
    const out = { daemon: md.exports };
    const escrow = taggedEscrowSeam();
    if (!escrow.ok) return escrow;
    out.escrowState = escrow.exports;
    for (const [key, rel] of [["itemStore", "services/inventory/itemStore"],
      ["itemCustody", "services/inventory/itemCustody"], ["marketCustody", "services/inventory/marketItemCustody"]]) {
      const loaded = marketSeam(rel);
      if (!loaded.ok) return loaded;
      out[key] = loaded.exports;
    }
    return { ok: true, exports: out };
  };

  function tradeMarketSellSeams() {
    const seams = sellMarketSeams();
    if (!seams.ok) return { ok: false, detail: seams.detail };
    const x = seams.exports;
    const missing = [];
    const need = (cond, name) => { if (!cond) missing.push(name); };
    need(x.daemon && typeof x.daemon.call === "function", "marketDaemonClient.call");
    for (const name of ["getEscrowRecord", "putEscrowRecordDurable", "removeEscrowRecordDurable", "listEscrowRecords"]) {
      need(typeof x.escrowState[name] === "function", `marketEscrowState.${name}`);
    }
    for (const name of ["grantItemToOwnerLocationIdempotent", "getIdempotentGrantReceipt", "listContainerItems",
      "findItemById"]) need(typeof x.itemStore[name] === "function", `itemStore.${name}`);
    need(x.itemStore.ITEM_FLAGS && Number.isSafeInteger(x.itemStore.ITEM_FLAGS.HANGAR), "itemStore.ITEM_FLAGS.HANGAR");
    need(typeof x.itemCustody.transfer === "function", "itemCustody.transfer");
    need(x.itemCustody.custodyRef && typeof x.itemCustody.custodyRef.ownerLocation === "function", "itemCustody.custodyRef");
    need(typeof x.itemCustody.getCommittedReceipt === "function", "itemCustody.getCommittedReceipt");
    need(x.itemCustody.CUSTODY_REASON && typeof x.itemCustody.CUSTODY_REASON.MARKET_ESCROW_PLACE === "string"
      && typeof x.itemCustody.CUSTODY_REASON.MARKET_ESCROW_RETURN === "string", "itemCustody.CUSTODY_REASON");
    need(typeof x.marketCustody.transferItem === "function", "marketItemCustody.transferItem");
    need(typeof x.marketCustody.getEscrowLocationID === "function", "marketItemCustody.getEscrowLocationID");
    need(Number.isSafeInteger(x.marketCustody.MARKET_ESCROW_LOCATION_BASE),
      "marketItemCustody.MARKET_ESCROW_LOCATION_BASE");
    const wd = marketSeam("space/worldData");
    need(wd.ok && typeof wd.exports.getStationByID === "function", "worldData.getStationByID");
    return missing.length === 0 ? { ok: true } : { ok: false, detail: missing.join(",") };
  }

  function tradeMarketFindSell(spec) {
    const md = marketDaemonSeam();
    if (!md.ok) return Promise.resolve(seamDown(md.detail));
    const es = taggedEscrowSeam();
    if (!es.ok) return Promise.resolve(seamDown(es.detail));
    return findSellOrderFrom(md.exports, es.exports, spec);
  }

  function tradeMarketPlaceSell(spec) {
    const seams = sellMarketSeams();
    if (!seams.ok) return Promise.resolve(seamDown(seams.detail, { permanent: false, ambiguous: false }));
    const metadata = buyOrderStationMetadata(spec && spec.stationId);
    return placeAndAttachSellOrderFrom(seams.exports, spec, Date.now(), metadata);
  }

  function tradeMarketReturnSellEscrow(spec) {
    const seams = sellMarketSeams();
    if (!seams.ok) return seamDown(seams.detail);
    return returnSellEscrowFrom(seams.exports, spec);
  }

  function tradeMarketDurationAllowed(days) {
    const rules = marketSeam("services/market/marketRules");
    return rules.ok ? isBuyOrderDurationAllowedFrom(rules.exports, days) : false;
  }

  function checkTradeMarketSeams() {
    const fn = (name) => ({ name, kind: "function" });
    const obj = (name) => ({ name, kind: "object" });
    const required = [
      { path: "services/market/marketDaemonClient", symbols: [obj("marketDaemonClient")] },
      { path: "services/market/marketEscrowState", symbols: [fn("getEscrowRecord"), fn("putEscrowRecordDurable"),
        fn("removeEscrowRecordDurable"), fn("listEscrowRecords")] },
      { path: "services/market/marketRules", symbols: [fn("isAllowedDuration")] },
      { path: "services/inventory/itemStore", symbols: [obj("ITEM_FLAGS")] },
    ];
    const missing = [];
    for (const entry of required) {
      const loaded = marketSeam(entry.path);
      if (!loaded.ok) {
        missing.push(loaded.detail);
        continue;
      }
      for (const sym of entry.symbols) {
        const value = loaded.exports[sym.name];
        const shapeOk = sym.kind === "function" ? typeof value === "function" : value !== null && typeof value === "object";
        if (!shapeOk) missing.push(`${entry.path}.${sym.name}`);
      }
      if (entry.path === "services/market/marketDaemonClient" && loaded.exports.marketDaemonClient
        && typeof loaded.exports.marketDaemonClient.call !== "function") missing.push(`${entry.path}.marketDaemonClient.call`);
      if (entry.path === "services/inventory/itemStore" && loaded.exports.ITEM_FLAGS
        && !Number.isSafeInteger(loaded.exports.ITEM_FLAGS.HANGAR)) missing.push(`${entry.path}.ITEM_FLAGS.HANGAR`);
    }
    return missing.length === 0 ? { ok: true } : { ok: false, reason: "TRADE_MARKET_SEAM_UNAVAILABLE", missing };
  }

  let tradeNudgeFn = null;
  let tradeHookOn = false;
  let contractHookUninstaller = null;
  const acceptListeners = new Map();

  const fanOutAccepted = (rec) => {
    const description = rec && typeof rec === "object" ? rec.description : null;
    const contractId = rec && typeof rec === "object" ? Number(rec.contractID) : 0;
    if (typeof description !== "string" || !Number.isSafeInteger(contractId) || contractId <= 0) return;
    for (const l of acceptListeners.values()) {
      if (!description.includes(l.tagPrefix)) continue;
      try {
        l.fn(contractId);
      } catch (_err) {
      }
    }
  };

  const ensureAcceptHook = () => {
    if (contractHookUninstaller) return { ok: true };
    const loaded = requireGame("services/contracts/contractNotifications");
    if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: loaded.reason };
    const wrapRes = wrapContractAccepted(loaded.exports, (rec) => {
      if (tradeHookOn && tradeNudgeFn) {
        try {
          tradeNudgeFn();
        } catch (_err) {
        }
      }
      fanOutAccepted(rec);
    });
    if (!wrapRes.ok) return wrapRes;
    contractHookUninstaller = wrapRes.uninstall;
    return { ok: true };
  };

  const releaseAcceptHook = () => {
    if (!contractHookUninstaller || tradeHookOn || acceptListeners.size > 0) return;
    contractHookUninstaller();
    contractHookUninstaller = null;
  };

  function setTradeNudge(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_NUDGE_FN" };
    tradeNudgeFn = fn;
    return { ok: true };
  }

  function installTradeHooks() {
    if (tradeHookOn) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!tradeNudgeFn) return { ok: false, reason: "NUDGE_NOT_SET" };
    const hooked = ensureAcceptHook();
    if (!hooked.ok) return hooked;
    tradeHookOn = true;
    return { ok: true };
  }

  function uninstallTradeHooks() {
    tradeHookOn = false;
    tradeNudgeFn = null;
    releaseAcceptHook();
    return { ok: true };
  }

  function addContractAcceptedListener(spec) {
    const s = spec && typeof spec === "object" ? spec : {};
    if (typeof s.name !== "string" || s.name === "" || typeof s.tagPrefix !== "string"
      || !s.tagPrefix.startsWith("[LNE:") || typeof s.fn !== "function") {
      return { ok: false, reason: "INVALID_LISTENER" };
    }
    if (acceptListeners.has(s.name)) return { ok: false, reason: "LISTENER_EXISTS" };
    let hooked;
    try {
      hooked = ensureAcceptHook();
    } catch (err) {
      hooked = { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err).slice(0, 200) };
    }
    if (!hooked.ok) return hooked;
    const entry = Object.freeze({ tagPrefix: s.tagPrefix, fn: s.fn });
    acceptListeners.set(s.name, entry);
    return { ok: true, remove: () => {
      if (acceptListeners.get(s.name) !== entry) return;
      acceptListeners.delete(s.name);
      releaseAcceptHook();
    } };
  }

  function freeCorpsContractSeams() {
    try {
      const disabled = state.report ? state.report.disabledModules : null;
      if (disabled && hasOwn(disabled, "freeCorpsContracts")) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.freeCorpsContracts) };
      }
      const sell = tradeSellSeams();
      if (!sell.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(sell.detail || "tradeSell") };
      const loaded = requireGame("services/contracts/contractRuntimeState");
      if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(loaded.reason).slice(0, 200) };
      const missing = ["createContract", "getContractRecord", "deleteContract"]
        .filter((name) => !loaded.exports || typeof loaded.exports[name] !== "function");
      return missing.length === 0 ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", detail: missing.join(",") };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err).slice(0, 200) };
    }
  }

  function freeCorpsCourierSeams() {
    try {
      const base = freeCorpsContractSeams();
      if (!base.ok) return base;
      const disabled = state.report ? state.report.disabledModules : null;
      if (disabled && hasOwn(disabled, "freeCorpsCouriers")) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(disabled.freeCorpsCouriers) };
      }
      const loaded = requireGame("services/contracts/contractRuntimeState");
      if (!loaded.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(loaded.reason).slice(0, 200) };
      const status = loaded.exports && loaded.exports.CONTRACT_STATUS;
      if (typeof loaded.exports.completeContract !== "function" || !status || !Number.isInteger(status.FAILED)) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "completeContract" };
      }
      const wallet = requireGame(WALLET_STATE);
      if (!wallet.ok || !wallet.exports || typeof wallet.exports.adjustCharacterBalanceAsync !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "adjustCharacterBalanceAsync" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err).slice(0, 200) };
    }
  }

  function installSiteScannerHide(opts) {
    if (scannerHide) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const maxHidden = opts && opts.maxHidden;
    if (!Number.isSafeInteger(maxHidden) || maxHidden <= 0) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "maxHidden" };
    }
    const provider = requireGame(SCANNER_PROVIDER_PATH);
    if (!provider.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `provider_${provider.reason}` };
    const scanMgr = requireGame(SCAN_MGR_PATH);
    if (!scanMgr.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `scanMgr_${scanMgr.reason}` };
    if (!scanMgr.exports || typeof scanMgr.exports.notifyAnomalyDeltaForSystem !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "scanMgr_missing_notifyAnomalyDeltaForSystem" };
    }
    const hide = createSiteScannerHide({ providerExports: provider.exports, scanMgr: scanMgr.exports, maxHidden,
      logger: { log: logAdapter } });
    const installed = hide.install();
    if (!installed.ok) return installed;
    scannerHide = hide;
    return { ok: true };
  }

  function uninstallSiteScannerHide() {
    if (scannerHide) {
      scannerHide.uninstall();
      scannerHide = null;
    }
    return { ok: true };
  }

  function installChatCommand(opts) {
    if (!opts || typeof opts.match !== "function" || typeof opts.handle !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "match_or_handle" };
    }
    const name = typeof opts.name === "string" && opts.name ? opts.name : DEFAULT_CHAT_COMMAND;
    if (chatCommands.has(name)) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!chatCommand) {
      const runtime = requireGame(CHAT_RUNTIME_PATH);
      if (!runtime.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `chatRuntime_${runtime.reason}` };
      const hook = createChatCommandHook({ chatRuntimeExports: runtime.exports, match: chatCommandMatches,
        handle: chatCommandDispatch, logger: { log: logAdapter } });
      const installed = hook.install();
      if (!installed.ok) return installed;
      chatCommand = hook;
    }
    chatCommands.set(name, Object.freeze({ match: opts.match, handle: opts.handle,
      failReply: typeof opts.failReply === "string" && opts.failReply ? opts.failReply : null }));
    return { ok: true };
  }

  const chatCommandOf = (text) => {
    for (const entry of chatCommands.values()) {
      try {
        if (entry.match(text) === true) return entry;
      } catch (err) {
        logAdapter(`chat command: match failed - ${String((err && err.message) || err).slice(0, CHAT_LOG_DETAIL)}`);
      }
    }
    return null;
  };

  const chatCommandMatches = (text) => chatCommandOf(text) !== null;

  const chatCommandDispatch = (rec, text, ctx) => {
    const entry = chatCommandOf(String(text ?? ""));
    if (!entry) return null;
    try {
      const out = entry.handle(rec, String(text ?? ""), ctx);
      if (typeof out === "string" && out.length > 0) return out;
    } catch (err) {
      logAdapter(`chat command: handler failed - ${String((err && err.message) || err).slice(0, CHAT_LOG_DETAIL)}`);
    }
    return entry.failReply;
  };

  function uninstallChatCommand(name) {
    chatCommands.delete(typeof name === "string" && name ? name : DEFAULT_CHAT_COMMAND);
    if (chatCommands.size === 0 && chatCommand) {
      chatCommand.uninstall();
      chatCommand = null;
    }
    return { ok: true };
  }

  const siteTalkDrift = () => {
    const disabled = state.report ? state.report.disabledModules : null;
    return disabled && hasOwn(disabled, "npcVoicesSite") ? String(disabled.npcVoicesSite) : null;
  };

  function installSiteEntryHook(onEnter) {
    if (siteEntryHook) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (typeof onEnter !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "onEnter" };
    const drift = siteTalkDrift();
    if (drift !== null) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: drift };
    const tracking = requireGame("services/dungeon/dungeonTrackingRuntime");
    if (!tracking.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `tracking_${tracking.reason}` };
    const hook = createSiteEntryHook({ trackingExports: tracking.exports, onEnter, now: () => Date.now(),
      logger: { log: logAdapter } });
    const installed = hook.install();
    if (!installed.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: installed.reason };
    siteEntryHook = hook;
    return { ok: true };
  }

  function uninstallSiteEntryHook() {
    if (siteEntryHook) {
      siteEntryHook.uninstall();
      siteEntryHook = null;
    }
    return { ok: true };
  }

  function sendCharacterSystemLine(spec) {
    const drift = siteTalkDrift();
    if (drift !== null) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: drift };
    const registry = requireGame("services/chat/sessionRegistry");
    if (!registry.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `sessionRegistry_${registry.reason}` };
    const chatHub = requireGame("services/chat/chatHub");
    if (!chatHub.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `chatHub_${chatHub.reason}` };
    return sendCharacterSystemLineWith(registry.exports, chatHub.exports, spec);
  }

  const LOCAL_TALK_NAME_CHARS = 64;
  let localTalkTap = null;
  let localTalkSeam = null;
  const localTalkDrift = () => {
    const disabled = state.report ? state.report.disabledModules : null;
    return disabled && hasOwn(disabled, "npcVoicesTalk") ? String(disabled.npcVoicesTalk) : null;
  };

  const installLocalTap = (fn) => {
    if (localTalkTap !== null && localTalkTap.isInstalled()) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const drift = localTalkDrift();
    if (drift !== null) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: drift };
    const chat = requireGame("_secondary/chat/chatRuntime");
    if (!chat.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `chatRuntime_${chat.reason}` };
    const tap = createLocalTalkTap({ chatRuntimeExports: chat.exports, now: () => Date.now(),
      lineObserver: { set: setOccupantLineObserver, clear: clearOccupantLineObserver } });
    const installed = tap.install(fn);
    if (!installed.ok) return installed;
    localTalkTap = tap;
    return { ok: true };
  };

  const uninstallLocalTap = () => {
    if (localTalkTap !== null) {
      localTalkTap.uninstall();
      localTalkTap = null;
    }
    return { ok: true };
  };

  const localSpeakerNameOf = (characterId) => {
    if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: false, reason: "BAD_ID" };
    const drift = localTalkDrift();
    if (drift !== null) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: drift };
    const characters = requireGame("services/character/characterState");
    if (!characters.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `characterState_${characters.reason}` };
    try {
      const record = characters.exports.peekCharacterRecord(characterId);
      const name = record && typeof record.characterName === "string"
        ? record.characterName.trim().slice(0, LOCAL_TALK_NAME_CHARS).trim() : "";
      return name === "" ? { ok: false, reason: "NO_RECORD" } : { ok: true, name };
    } catch (_err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "peekCharacterRecord_threw" };
    }
  };

  function localTalkSeams() {
    const drift = localTalkDrift();
    if (drift !== null) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: drift };
    if (localTalkSeam === null) {
      localTalkSeam = Object.freeze({ installTap: installLocalTap, uninstallTap: uninstallLocalTap,
        characterNameOf: localSpeakerNameOf,
        stats: () => (localTalkTap !== null ? localTalkTap.stats() : { installed: false }) });
    }
    return { ok: true, seam: localTalkSeam };
  }

  let abyssalHook = null;
  let abyssalSeam = null;
  let abyssalHostDegraded = false;
  const abyssalDriftOf = (consumer) => {
    const disabled = state.report ? state.report.disabledModules : null;
    return disabled && hasOwn(disabled, consumer) ? String(disabled[consumer]) : null;
  };

  const abyssalIsHost = (locationId) => {
    if (abyssalDriftOf("abyssalHost") === null) {
      const host = requireGame("abyssal/domain/abyssalHostLocation");
      const answer = host.ok ? abyssalRuns.isAbyssalHostWith(host.exports, locationId) : null;
      if (answer !== null) {
        abyssalHostDegraded = false;
        return answer;
      }
    }
    abyssalHostDegraded = true;
    return abyssalRuns.isHostIdFallback(locationId);
  };

  const abyssalResolvePersisted = (profile) => {
    if (abyssalDriftOf("abyssalTier") !== null) return null;
    const svc = requireGame("abyssal/transport/abyssalContentManagerService");
    if (!svc.ok || !svc.exports || typeof svc.exports.resolvePersistedFilamentDefinition !== "function") return null;
    return svc.exports.resolvePersistedFilamentDefinition(profile);
  };

  const abyssalProject = (pocketState) => abyssalRuns.projectRunWith(pocketState, abyssalResolvePersisted);

  const abyssalReadActiveRun = (characterId) => {
    const drift = abyssalDriftOf("abyssal");
    if (drift !== null) return { ok: false, reason: "ABYSSAL_UNAVAILABLE", detail: drift };
    const facade = requireGame("abyssal/policy/abyssalSpaceRuntimeIntegration");
    if (!facade.ok) return { ok: false, reason: "ABYSSAL_UNAVAILABLE", detail: `facade_${facade.reason}` };
    return abyssalRuns.readActiveRunWith(facade.exports, characterId, abyssalProject);
  };

  const abyssalInstallCompletionHook = (onExited) => {
    if (abyssalHook !== null) return { ok: false, reason: "ALREADY_INSTALLED" };
    if (typeof onExited !== "function") return { ok: false, reason: "SEAM_MISSING", detail: "onExited" };
    const drift = abyssalDriftOf("abyssal");
    if (drift !== null) return { ok: false, reason: "SEAM_MISSING", detail: drift };
    const tracking = requireGame("services/dungeon/dungeonTrackingRuntime");
    if (!tracking.ok) return { ok: false, reason: "SEAM_MISSING", detail: `tracking_${tracking.reason}` };
    const hook = abyssalRuns.createCompletionHook({ trackingExports: tracking.exports, onExited,
      project: abyssalProject, logger: { log: logAdapter } });
    const installed = hook.install();
    if (!installed.ok) return installed;
    abyssalHook = hook;
    return { ok: true, uninstall: () => {
      if (abyssalHook === hook) {
        hook.uninstall();
        abyssalHook = null;
      }
    } };
  };

  function abyssalSeams() {
    const drift = abyssalDriftOf("abyssal");
    if (drift !== null) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: drift };
    if (abyssalSeam === null) {
      abyssalSeam = Object.freeze({ isAbyssalHost: abyssalIsHost, readActiveRun: abyssalReadActiveRun,
        installCompletionHook: abyssalInstallCompletionHook, projectRun: abyssalProject,
        stats: () => ({ hostDegraded: abyssalHostDegraded,
          hook: abyssalHook !== null ? abyssalHook.stats() : { installed: false } }) });
    }
    return { ok: true, seam: abyssalSeam };
  }

  const trigDrifterListMemo = new Map();
  const trigDrifterListSeams = () => {
    const disabled = state.report ? state.report.disabledModules : null;
    if (disabled && hasOwn(disabled, "trigDrifterLists")) return { ok: false, detail: String(disabled.trigDrifterLists) };
    if (getProcessRole() !== "world") return { ok: false, detail: "not_world_process" };
    const loaded = requireGame("space/npc/trigDrifter/trigDrifterSpawnAuthority");
    return loaded.ok ? { ok: true, exports: loaded.exports } : { ok: false, detail: `authority_${loaded.reason}` };
  };

  const readTrigDrifterSystemList = (key) => {
    try {
      if (typeof key !== "string" || key.trim() === "") return { ok: false, reason: "INVALID_INPUT", detail: "key" };
      if (trigDrifterListMemo.has(key)) return trigDrifterListMemo.get(key);
      const seams = trigDrifterListSeams();
      if (!seams.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: seams.detail };
      const read = trigDrifterLists.readSystemList(seams.exports, key);
      if (read.ok) trigDrifterListMemo.set(key, read);
      return read;
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `threw: ${String((err && err.message) || err)}` };
    }
  };

  function listChatCommands() {
    return Object.freeze([...chatCommands.keys()]);
  }

  const readModManifest = (modDir) => {
    const out = { displayName: null, fields: {} };
    const isObj = MOD_CONFIG_KIND_TESTS.object;
    let doc;
    try {
      const read = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
      const text = String(read(path.join(modDir, MOD_MANIFEST_FILE), "utf8"));
      doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (_err) {
      return out;
    }
    if (!isObj(doc)) return out;
    if (typeof doc.displayName === "string" && doc.displayName !== "") out.displayName = doc.displayName;
    const fields = isObj(doc.settings) && Array.isArray(doc.settings.fields) ? doc.settings.fields : [];
    const text = (v) => (typeof v === "string" ? v : null);
    const entries = [];
    for (const field of fields) {
      if (!isObj(field)) continue;
      const key = Array.isArray(field.key) && field.key.length > 0 && field.key.every((k) => typeof k === "string")
        ? field.key.join(".") : (typeof field.id === "string" && field.id !== "" ? field.id : null);
      if (key === null) continue;
      const row = { label: text(field.label), description: text(field.description), group: text(field.group),
        type: text(field.type) };
      if (Number.isFinite(field.minimum)) row.min = field.minimum;
      if (Number.isFinite(field.maximum)) row.max = field.maximum;
      if (Number.isFinite(field.step)) row.step = field.step;
      if (typeof field.default === "boolean" || typeof field.default === "string" || Number.isFinite(field.default)) {
        row.default = field.default;
      }
      entries.push([key, row]);
    }
    out.fields = Object.fromEntries(entries);
    return out;
  };

  function loadModConfig(dir, opts) {
    if (typeof dir !== "string" || !MOD_CONFIG_DIR_RE.test(dir) || dir.includes("..")) {
      return { ok: false, reason: "BAD_MOD_DIR" };
    }
    const options = opts !== null && typeof opts === "object" ? opts : {};
    const need = options.need !== null && typeof options.need === "object" ? options.need : MOD_CONFIG_DEFAULT_NEED;
    const modsRoot = typeof deps.modsRoot === "string" ? deps.modsRoot : path.resolve(__dirname, "..", "..", "..");
    const modDir = path.join(modsRoot, dir);
    const file = path.join(modDir, MOD_CONFIG_FILE);
    try {
      if (!existsSync(file)) return { ok: false, reason: "CONFIG_MISSING" };
      const loaded = requireFn(file);
      const shaped = Boolean(loaded) && Object.entries(need).every(([name, kind]) =>
        Object.prototype.hasOwnProperty.call(MOD_CONFIG_KIND_TESTS, kind) && MOD_CONFIG_KIND_TESTS[kind](loaded[name]));
      if (!shaped) return { ok: false, reason: "CONFIG_SHAPE" };
      if (options.manifest === true) return { ok: true, exports: loaded, modDir, manifest: readModManifest(modDir) };
      return { ok: true, exports: loaded, modDir };
    } catch (err) {
      return { ok: false, reason: "CONFIG_LOAD_FAILED",
        detail: String((err && err.message) || err).slice(0, CHAT_LOG_DETAIL) };
    }
  }

  function listLoadedModDirs(cache = require.cache) {
    if (!cache || typeof cache !== "object") {
      return { ok: false, reason: "CACHE_UNREADABLE", detail: cache === null ? "null" : typeof cache };
    }
    try {
      const dirs = new Set();
      for (const key of Object.keys(cache)) {
        const m = LOADED_MOD_LOADER_RE.exec(String(key).replace(/\\/g, "/"));
        if (m) dirs.add(m[1]);
      }
      return { ok: true, dirs: Object.freeze([...dirs].sort()) };
    } catch (err) {
      return { ok: false, reason: "CACHE_UNREADABLE",
        detail: String((err && err.message) || err).slice(0, CHAT_LOG_DETAIL) };
    }
  }

  const shipWingHpMarks = () => readShipWingHpMarks({ loadModConfig, env: process.env });
  const shipWingLoaded = () => {
    const r = listLoadedModDirs();
    return r.ok ? { ok: true, loaded: r.dirs.includes(SHIP_WING_DIR) } : { ok: false, reason: r.reason };
  };
  const shipWingUiFacade = createShipWingUi();
  const shipWingUi = () => shipWingUiFacade;

  const boardGlobal = () => deps.globalObj || globalThis;
  const registerServiceAs = (consumer, world, spec) => {
    const drift = consumerDrift(consumer);
    if (drift !== null) return { ok: false, reason: "BASE_SERVICE_DRIFT", detail: drift };
    const base = requireGame("services/baseService");
    if (!base.ok) return { ok: false, reason: "BASE_SERVICE_DRIFT", detail: base.reason };
    return registerClientServiceWith(base.exports, world, spec);
  };
  const sendNotificationAs = (consumer, characterId, type, payload) => {
    const drift = consumerDrift(consumer);
    if (drift !== null) return { ok: false, reason: "SEND_FAILED", detail: drift };
    const registry = requireGame("services/chat/sessionRegistry");
    if (!registry.ok) return { ok: false, reason: "SEND_FAILED", detail: `sessionRegistry_${registry.reason}` };
    return sendClientNotificationWith(registry.exports, characterId, type, payload);
  };
  const registerClientService = (world, spec) => registerServiceAs("jobBoard", world, spec);
  const sendClientNotification = (characterId, type, payload) => sendNotificationAs("jobBoard", characterId, type,
    payload);
  const registerMapClientService = (world, spec) => registerServiceAs("inGameMap.window", world, spec);
  const sendMapNotification = (characterId, type, payload) => sendNotificationAs("inGameMap.window", characterId,
    type, payload);
  const publishClientPart = (name, spec) => {
    try {
      if (typeof name !== "string" || !hasOwn(CLIENT_PART_PRIORITY, name)) {
        return { ok: false, reason: "BAD_PART", detail: `name=${String(name).slice(0, 40)}` };
      }
      const names = (spec && spec.names) || CLIENT_PART_NAMES[name];
      const payload = buildBoardPayload(spec && spec.source, spec && spec.maxOwnBytes, names);
      if (!payload.ok) return payload;
      const log = (spec && spec.log) || null;
      const delivery = createBoardDelivery({ encoded: payload.encoded, log, names });
      const g = boardGlobal();
      let composite = g[BOARD_DELIVERY_KEY];
      if (!composite || typeof composite.setPart !== "function") {
        composite = createCompositeDelivery({ log });
        g[BOARD_DELIVERY_KEY] = composite;
      }
      const set = composite.setPart(name, delivery, CLIENT_PART_PRIORITY[name], log);
      if (!set.ok) {
        if (composite.parts().length === 0 && g[BOARD_DELIVERY_KEY] === composite) delete g[BOARD_DELIVERY_KEY];
        return { ok: false, reason: "BAD_PART", detail: name };
      }
      return { ok: true, delivery, bytes: payload.bytes };
    } catch (err) {
      return { ok: false, reason: "CLIENT_SOURCE", detail: String((err && err.message) || err).slice(0, 120) };
    }
  };
  const withdrawClientPart = (name, delivery) => {
    try {
      const g = boardGlobal();
      const composite = g[BOARD_DELIVERY_KEY];
      if (composite && typeof composite.removePart === "function") {
        if (composite.removePart(name, delivery).empty) delete g[BOARD_DELIVERY_KEY];
      }
    } catch (_err) {
    }
    return { ok: true };
  };
  const publishBoardDelivery = (spec) => publishClientPart("board", { ...(spec || {}), names: CLIENT_PART_NAMES.board });
  const withdrawBoardDelivery = (delivery) => withdrawClientPart("board", delivery);
  const boardHookState = () => {
    try {
      const s = boardGlobal()[BOARD_HOOK_STATE_KEY];
      if (!s || typeof s !== "object") return { status: "ABSENT" };
      if (s.ok === false) return { status: `OFF:${String(s.reason)}`, line: String(s.line || "") };
      return { status: String((s.state && s.state.status) || "UNKNOWN") };
    } catch (_err) {
      return { status: "ABSENT" };
    }
  };

  const loadDockGateSeams = () => {
    const loaded = {};
    for (const [key, relPath] of Object.entries(DOCK_GATE_PATHS)) {
      const r = requireGame(relPath);
      if (!r.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${key}_${r.reason}` };
      loaded[key] = r.exports;
    }
    const cls = loaded.beyonce;
    if (typeof cls !== "function" || !cls.prototype || typeof cls.prototype.Handle_CmdDock !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "beyonceService_Handle_CmdDock" };
    }
    if (typeof loaded.macho.throwWrappedUserError !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "machoErrors_throwWrappedUserError" };
    }
    if (typeof loaded.worldData.getStationByID !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "worldData_getStationByID" };
    }
    if (typeof loaded.itemStore.findItemById !== "function" || typeof loaded.itemStore.isCapsuleTypeID !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "itemStore_capsule" };
    }
    return { ok: true, seam: { serviceClass: cls, worldData: loaded.worldData, itemStore: loaded.itemStore,
      throwUserError: loaded.macho.throwWrappedUserError, stationFactionOf: loadStationFactionOf() } };
  };

  const loadStationFactionOf = () => {
    const r = requireGame(DOCK_GATE_STATION_PATH);
    const getStationRecord = r.ok && r.exports ? r.exports.getStationRecord : null;
    if (typeof getStationRecord !== "function") return null;
    return (stationId) => {
      try {
        const n = Number(getStationRecord(null, stationId)?.factionID);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
      } catch (_err) {
        return null;
      }
    };
  };

  function dockGateSeams() {
    try {
      const r = loadDockGateSeams();
      return r.ok ? { ok: true } : r;
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function installDockGate(opts) {
    if (dockGate) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!opts || typeof opts.decide !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "decide" };
    try {
      const seams = loadDockGateSeams();
      if (!seams.ok) return seams;
      const hook = createDockGateHook({ ...seams.seam,
        stationFactionOf: opts.stationFaction === true ? seams.seam.stationFactionOf : null,
        decide: opts.decide, logger: { log: logAdapter } });
      const installed = hook.install();
      if (!installed.ok) return installed;
      dockGate = hook;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function uninstallDockGate() {
    if (dockGate) {
      try {
        dockGate.uninstall();
      } catch (_err) {
      }
      dockGate = null;
    }
    return { ok: true };
  }

  function setFameMarketSlot(fn) {
    return fameMarketHook.setSlot(typeof fn === "function" ? fn : null);
  }

  function getFameMarketStatus() {
    return fameMarketHook.getStatus();
  }

  const loadTrigBridgeSeams = () => {
    const loaded = {};
    for (const [key, relPath] of Object.entries(TRIG_BRIDGE_PATHS)) {
      const r = requireGame(relPath);
      if (!r.ok || !r.exports) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${key}_${r.reason || "none"}` };
      loaded[key] = r.exports;
    }
    const readFileSync = typeof deps.readFileSync === "function" ? deps.readFileSync : fs.readFileSync;
    let sourceText = null;
    try {
      const text = readFileSync(path.join(state.serverSrc, ...`${trigBridgeScope.JUMP_MGR_PATH}.js`.split("/")), "utf8");
      sourceText = typeof text === "string" ? text : null;
    } catch (_err) {
      sourceText = null;
    }
    return { ok: true, seam: { serviceClass: loaded.jumpMgr, sourceText, worldData: loaded.worldData,
      runtime: loaded.runtime, structureState: loaded.structureState, links: loaded.links,
      characterState: loaded.characterState, throwUserError: loaded.macho.throwWrappedUserError } };
  };

  function trigBridgeSeams() {
    try {
      const r = loadTrigBridgeSeams();
      return r.ok ? trigBridgeScope.checkJumpScope(r.seam) : r;
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function installTrigBridgeJumpScope(opts) {
    if (trigBridgeJump) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!opts || typeof opts.decide !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "decide" };
    try {
      const seams = loadTrigBridgeSeams();
      if (!seams.ok) return seams;
      const scope = trigBridgeScope.createJumpScope({ ...seams.seam, decide: opts.decide, onJump: opts.onJump,
        onEvent: opts.onEvent, logger: { log: logAdapter } });
      const installed = scope.install();
      if (!installed.ok) return installed;
      trigBridgeJump = scope;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
    }
  }

  function uninstallTrigBridgeJumpScope() {
    if (trigBridgeJump) {
      try {
        trigBridgeJump.uninstall();
      } catch (_err) {
      }
      trigBridgeJump = null;
    }
    return { ok: true };
  }

  const loadTrigInstallSeams = () => {
    const v = {};
    for (const [key, relPath] of Object.entries(TRIG_INSTALL_PATHS)) {
      const r = requireGame(relPath);
      if (!r.ok || !r.exports) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${key}_${r.reason || "none"}` };
      v[key] = r.exports;
    }
    v.throwUserError = v.macho.throwWrappedUserError;
    const checked = trigBridgeInstall.checkInstallSeams(v);
    return checked.ok ? { ok: true, v } : checked;
  };
  const withTrigInstall = (fn) => {
    try {
      const s = loadTrigInstallSeams();
      return s.ok ? fn(s.v) : s;
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err).slice(0, 120) };
    }
  };

  function installTrigBridgeDepositHook(opts) {
    if (trigBridgeDeposit) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!opts || typeof opts.onCore !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "onCore" };
    return withTrigInstall((v) => {
      const hook = trigBridgeInstall.createDepositHook({ ...v, coreTypeId: opts.coreTypeId, onCore: opts.onCore,
        onEvent: opts.onEvent, logger: { log: logAdapter } });
      const installed = hook.install();
      if (!installed.ok) return installed;
      trigBridgeDeposit = hook;
      return { ok: true };
    });
  }

  function uninstallTrigBridgeDepositHook() {
    if (trigBridgeDeposit) {
      try {
        trigBridgeDeposit.uninstall();
      } catch (_err) {
      }
      trigBridgeDeposit = null;
    }
    return { ok: true };
  }

  function listTrigBridges(opts) {
    return withTrigInstall((v) => trigBridgeInstall.listTrigBridgesFrom(v, opts));
  }

  function readTrigBridge(structureId) {
    return withTrigInstall((v) => trigBridgeInstall.readStructureFrom(v, structureId));
  }

  function writeTrigBridgeMarker(structureId, marker) {
    return withTrigInstall((v) => trigBridgeInstall.writeMarkerFrom(v, structureId, marker || {}));
  }

  function writeTrigBridgeDestination(structureId, destinationSystemId) {
    return withTrigInstall((v) => trigBridgeInstall.writeDestinationFrom(v, structureId, destinationSystemId));
  }

  function syncTrigBridgeScene(systemId) {
    return withTrigInstall((v) => trigBridgeInstall.syncSceneFrom(v, systemId));
  }

  function trigBridgeDistanceLy(a, b) {
    const r = withTrigInstall((v) => ({ ok: true, ly: trigBridgeInstall.distanceLyFrom(v, a, b) }));
    return r.ok ? r.ly : NaN;
  }

  function trigBridgeCoreType(typeId) {
    return withTrigInstall((v) => trigBridgeInstall.coreTypeFrom(v, typeId));
  }

  function installTrigBridgePresentation(opts) {
    if (trigBridgePresentation) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!opts) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "opts" };
    try {
      const v = {};
      for (const [key, relPath] of Object.entries(TRIG_LOOK_PATHS)) {
        const r = requireGame(relPath);
        if (!r.ok || !r.exports) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${key}_${r.reason || "none"}` };
        v[key] = r.exports;
      }
      const look = trigBridgeLook.createPresentation({ ...v, typeId: opts.typeId, onApplied: opts.onApplied,
        logger: { log: logAdapter } });
      const installed = look.install();
      if (!installed.ok) return installed;
      trigBridgePresentation = look;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err).slice(0, 120) };
    }
  }

  function applyTrigBridgePresentation(structureId) {
    return trigBridgePresentation ? trigBridgePresentation.apply(structureId) : { ok: false, reason: "NOT_INSTALLED" };
  }

  function uninstallTrigBridgePresentation() {
    if (trigBridgePresentation) {
      try {
        trigBridgePresentation.uninstall();
      } catch (_err) {
      }
      trigBridgePresentation = null;
    }
    return { ok: true };
  }

  return {
    setServerSrc,
    getServerSrc: () => state.serverSrc,
    getProcessRole,
    markBooted() { state.booted = true; },
    requireGame,
    runProbe,
    loadSqliteDriver,
    registerShutdownHook,
    onPersistenceOwnerLost,
    subscribeTickSamples,
    readPresence,
    subscribeSessionNudges,
    subscribeVendorPauses,
    admitSceneNpc,
    setSceneNpcSources,
    readBuildInputs,
    readStaticMap,
    resolveSystemFactions,
    readSdeBuild,
    readFactionNames,
    readNpcStations,
    listNpcStationsInSystem,
    readSystemInterior,
    readGridAnchors,
    readSystemBelts,
    readSystemCelestials,
    readPlanetResources,
    readLocalResources,
    readItemTypeFacts,
    readTypeLooks,
    readWormholePairs,
    applyStandingGrant,
    checkStandingWrite,
    listStandingReceiptKeys,
    pruneStandingReceipts,
    checkReceiptPrune,
    readCharacterStanding,
    checkStandingRead,
    readPirateFactionIds,
    getSovClaims,
    publishIncursions,
    incursionUiStats,
    nativeIncursionsSetTargets,
    nativeIncursionsListTales,
    nativeIncursionsBossParticipants,
    nativeIncursionsParticipants,
    nativeIncursionsVendorBands,
    nativeIncursionsStats,
    factionIncursionHudSync,
    factionIncursionHudClear,
    factionIncursionHudStats,
    factionIncursionEffectsSet,
    factionIncursionEffectsRefresh,
    factionIncursionEffectsStats,
    starmapOverlaySeams,
    installStarmapJumps,
    installStarmapKills,
    uninstallStarmapKills,
    uninstallStarmapJumps,
    starmapOverlayStatus,
    devIndexClientSeams,
    installDevIndexClient,
    uninstallDevIndexClient,
    devIndexClientStatus,
    getSovNative,
    getNpcSpawnTools,
    getSiteNavyTools,
    getSovProjection,
    readPlayerSov,
    releasePlayerSov,
    capturePlayerSov,
    readSovereigntyTableUpdatedAt,
    playerSovSeams,
    getPlayerSovDeployGateTools,
    getCapsuleSweepTools,
    getBookmarkSiteWarpTools,
    readPlayerOrgNames,
    killboardSeams,
    readVendorKillsAfter,
    readCharacterNames,
    getDungeonSites,
    checkDungeonSites,
    onCombatSiteCompleted,
    onSiteContainerHacked,
    readSiteHackWins,
    getNativeWrecks,
    checkNativeWrecks,
    setVendorTagStore,
    getNpcSpawn,
    checkNpcSpawn,
    getHuntScene,
    checkHuntScene,
    getBeltNavyScene,
    checkBeltNavyScene,
    getMiningEncounterTools,
    checkMiningEncounterSeams,
    getAmbientRatTools,
    checkAmbientRatSeams,
    getOfficerSpawn,
    getBountyScene,
    ewarProfilesOf,
    readConcordGateNpcAggro,
    concordResponseDelayMs,
    spawnConcordAgainst,
    getHeavyEventScene,
    checkHeavyEventSeams,
    getHighsecTrafficScene,
    checkHighsecTrafficScene,
    getSituationScene,
    checkLiveLossHook,
    bindLiveLossSink,
    addLiveLossListener,
    getCapsuleFxScene,
    addNpcWreckListener,
    readDormancyGuardStats,
    reserveCharacterId: identities.reserveCharacterId,
    writeCharacter: identities.writeCharacter,
    peekCharacterRecord: identities.peekCharacterRecord,
    pickCharacterName: identities.pickCharacterName,
    characterNameKeys: identities.characterNameKeys,
    noteCharacterNameTaken: identities.noteCharacterNameTaken,
    validateCharacterName: identities.validateCharacterName,
    ensureCorporation: identities.ensureCorporation,
    ensureAlliance: identities.ensureAlliance,
    markAllianceNpc: identities.markAllianceNpc,
    markCorporationNoWar: identities.markCorporationNoWar,
    joinCorporation: identities.joinCorporation,
    virtualIdentityEnsureMemberStates: identities.ensureMemberStates,
    freeSagaLeanSeams,
    joinAlliance: identities.joinAlliance,
    virtualIdentityExists: identities.exists,
    scanVirtualCharacters: identities.scanVirtualCharacters,
    renameVirtualCharacter: identities.renameCharacter,
    virtualIdentityFlush: identities.flush,
    resolveCharacterCreationBloodlineProfile: identities.resolveCharacterCreationBloodlineProfile,
    checkCorporationAlliance: identities.checkCorporationAlliance,
    checkAllianceIsNpc: identities.checkAllianceIsNpc,
    getStructureSeam,
    checkStructureSeams,
    sovStructureSeams,
    freeCorpStructureSeams,
    get playerStructures() {
      return getPlayerStructureSeam();
    },
    playerStructureSeams,
    get playerSkyhooks() {
      return getPlayerSkyhookSeam();
    },
    get harvestBays() {
      return getHarvestBaySeam();
    },
    sentrySeams,
    bindSentryPolicy: (policy, opts) => sentrySeamsModule.bindPolicy(policy, opts),
    checkTradeSeams,
    tradeCreateContract,
    tradePrivateContractFee,
    tradeFindContract,
    tradeReadContract,
    tradeDeleteContract,
    tradeAdjustWallet,
    tradeReadWallet,
    tradeReadCharacter,
    tradeReadCharacterWallet,
    tradeVirtualIssuerSeams,
    getVirtualCorps,
    tradeReadIssuer,
    tradeListDeliveredStacks,
    tradeVoidStack,
    tradeListTaggedContracts,
    tradeSellSeams,
    tradeGrantStock,
    tradeGrantReceipt,
    seasonRewardStation,
    tradeCreateSellContract,
    readTradePrices,
    readStationAsks,
    fetchExternalPrices,
    checkTradeMarketSeams,
    tradeMarketPlace,
    tradeMarketRead,
    tradeMarketFillMode,
    tradeMarketFind,
    tradeMarketAttachEscrow,
    tradeMarketDetachEscrow,
    tradeMarketCancel,
    tradeMarketListCorpOrders,
    tradeMarketListTaggedEscrows,
    tradeMarketDurationAllowed,
    tradeMarketSellSeams,
    tradeMarketFindSell,
    tradeMarketPlaceSell,
    tradeMarketReturnSellEscrow,
    setTradeNudge,
    installTradeHooks,
    uninstallTradeHooks,
    addContractAcceptedListener,
    freeCorpsContractSeams,
    tradeCreateCourierContract,
    tradeFailCourierContract,
    freeCorpsCourierSeams,
    installSiteScannerHide,
    uninstallSiteScannerHide,
    installChatCommand,
    uninstallChatCommand,
    installSiteEntryHook,
    uninstallSiteEntryHook,
    sendCharacterSystemLine,
    listChatCommands,
    listLoadedModDirs,
    loadModConfig,
    shipWingHpMarks,
    shipWingLoaded,
    shipWingUi,
    registerClientService,
    sendClientNotification,
    publishBoardDelivery,
    withdrawBoardDelivery,
    boardHookState,
    publishClientPart,
    withdrawClientPart,
    registerMapClientService,
    sendMapNotification,
    installDockGate,
    uninstallDockGate,
    dockGateSeams,
    setFameMarketSlot,
    getFameMarketStatus,
    trigBridgeSeams,
    installTrigBridgeJumpScope,
    uninstallTrigBridgeJumpScope,
    installTrigBridgeDepositHook,
    uninstallTrigBridgeDepositHook,
    listTrigBridges,
    readTrigBridge,
    writeTrigBridgeMarker,
    writeTrigBridgeDestination,
    syncTrigBridgeScene,
    trigBridgeDistanceLy,
    trigBridgeCoreType,
    installTrigBridgePresentation,
    applyTrigBridgePresentation,
    uninstallTrigBridgePresentation,
    sendPlayerMail: (spec) => mail().sendPlayerMail(spec),
    findPlayerMail: (spec) => mail().findPlayerMail(spec),
    defaultMailSender: () => mail().defaultMailSender(),
    rewardCreditIsk,
    rewardCreditLp,
    rewardSeams,
    rollFactionOfficerLoot,
    localPilotsSeams,
    localTalkSeams,
    abyssalSeams,
    readTrigDrifterSystemList,
    shipAiSeams,
    shipAiMailSeams,
    virtualKillmailSeams,
    writeVirtualKillmail,
    freeCorpRecycleSeams,
    moveFreeCharacter,
    setCorporationDescription,
    personalContactsSeams,
    capitalLiveIndex,
    capitalFighterTools,
    capitalFaxTools,
    getProbeReport: () => state.report,
    getDisabledModules: () => (state.report ? state.report.disabledModules : {}),
    getLoadedOutsideCache: () => [...state.loadedOutsideCache],
  };
}

module.exports = { createAdapter };
