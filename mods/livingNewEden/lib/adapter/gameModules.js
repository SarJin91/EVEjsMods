"use strict";

function sym(name, kind, consumers, phase, extra = {}) {
  return Object.freeze({ name, kind, consumers: Object.freeze([...consumers]), phase, ...extra });
}

function mod(path, symbols, extra = {}) {
  return Object.freeze({ path, ...extra, symbols: Object.freeze(symbols) });
}

const PRESENCE_NUDGE = ["attachSession", "detachSession"];
const ESS_REPOSITORY_FAST = "essRepositoryFast";
const STALL_DIAG = "telemetry.stallDiag";
const DBS_KILLMAIL_CACHE = "dbsKillmailCache";
const ESS_COLLAPSE = "essCollapse";
const FREE_CORPS_KILLMAILS = "freeCorpsKillmails";
const FREE_CORPS_CONTRACTS = "freeCorpsContracts";
const FREE_CORPS_COURIERS = "freeCorpsCouriers";
const FREE_CORPS_RECYCLE = "freeCorpsRecycle";
const FREE_SAGA_LEAN = "freeSagaLean";
const SHIP_AI = "shipAi";
const SHIP_AI_TOOLS = "shipAiTools";
const SHIP_AI_CALLOUT = "shipAiCallout";
const BUILD_INPUTS = "buildInputs";
const SHIP_AI_DSCAN = "shipAiDscan";
const SHIP_AI_WING = "shipAiWing";
const SHIP_AI_TRIGGERS = "shipAiTriggers";
const SHIP_AI_MINING = "shipAiMining";
const SHIP_AI_SITE = "shipAiSite";
const SHIP_AI_KILLS = "shipAiKills";
const SHIP_AI_PORTRAIT = "shipAiPortrait";
const SHIP_AI_MAIL = "shipAiMail";
const SHIP_AI_DB = "shipAiDb";
const CONTRACT_LIST_LIVE = "tradeContractListLive";
const VENDOR_PAUSE = ["prepareUniverseSitesForPlayerEntry", "prewarmSolarSystemForArrival"];
const VENDOR_PAUSES = "vendorPauses";
const RUNTIME_SCENE = ["noteSolarSystemSceneOccupied", "noteSolarSystemSceneEmpty", "getSceneForSession"];
const SALVAGE = "salvageAnomaly";
const MATERIALIZATION = "materialization";
const LOCAL_RESOURCES = "localResources";
const TRADE_CATALOG = "tradeCatalog";
const PLAYER_HUNT = "playerHunt";
const BELT_NAVY_AGGRO = "beltNavyAggro";
const SITE_NAVY = "siteNavy";
const ESCALATIONS = "escalations";
const ARCHAEOLOGY = "archaeology";
const TRADE_MARKET = "tradeMarket";
const TRADE_MARKET_SELL = "tradeMarketSell";
const DORMANCY_GUARD = "dormancyGuard";
const DORMANCY_PURGE = "dormancyPurge";
const SITE_SCANNER = "siteScanner";
const FRONT_CHAT = "frontChat";
const NPC_VOICES_SITE = "npcVoicesSite";
const NPC_VOICES_TALK = "npcVoicesTalk";
const ABYSSAL = "abyssal";
const ABYSSAL_HOST = "abyssalHost";
const ABYSSAL_TIER = "abyssalTier";
const TRIG_DRIFTER_LISTS = "trigDrifterLists";
const NOTICES = "notices";
const LIBERATION_REWARDS = "liberationRewards";
const LOCAL_PILOTS = "localPilots";
const LOCAL_CONTACTS = "localContacts";
const HUNT_ANOMALIES = "huntAnomalies";
const INCURSION_UI = "incursionUi";
const NATIVE_INCURSIONS = "nativeIncursions";
const FACTION_INCURSION_HUD = "factionIncursions.hud";
const FACTION_INCURSION_EFFECTS = "factionIncursions.effects";
const INGAME_MAP_STARMAP = "inGameMap.starmap";
const DEV_INDEX_CLIENT = "devIndices.client";
const LOYALTY_DOCK = "loyaltyDock";
const FAME_MARKET = "fameMarket";
const FAME_DOCK = "fameDock";
const FAME_CONCORD = "fameConcord";
const CAPITAL_LIVE = "capitalLive";
const FACTION_PROFILES = "factionProfiles";
const CAPITAL_FIGHTERS = "capitalFighters";
const CAPITAL_FAX = "capitalFax";
const PLAYER_SIEGE = "playerSiege";
const SENTRIES = "sentries";
const SENTRY_TEXTS = "sentryTexts";
const SENTRY_FACTION = "sentryFaction";
const SENTRY_BATTLE = "sentryBattle";
const SENTRY_LOOK = "sentryLook";
const POPULATION_HULLS = "population.hulls";
const SENTRY_DEFEND = "sentryDefend";
const SOV_PHYSICAL = "sovStructuresPhysical";
const FC_STRUCTURES = "freeCorpsStructures";
const MINING_ENCOUNTERS = "miningEncounters";
const OFFICER_SPAWNS = "officerSpawns";
const BOUNTY = "bounty";
const BOUNTY_REVENGE = "bountyRevenge";
const NEMESIS_EWAR = "nemesisEwar";
const PLAYER_SOV = "playerSov";
const PLAYER_SOV_GATE = "playerSovGate";
const PLAYER_SOV_NAMES = "playerSovNames";
const AMBIENT_RATS = "ambientRats";
const AMBIENT_RATS_HIGHSEC = "ambientRatsHighsec";
const HEAVY_EVENTS = "heavyEvents";
const HIGHSEC_TRAFFIC = "highsecTraffic";
const HIGHSEC_TRAFFIC_EXPLORER = "highsecTraffic.explorer";
const SITUATIONS = "situations";
const SEASON_REWARDS = "seasonRewards";
const GRID_ANCHORS = "gridAnchors";
const CAPSULE_SWEEP = "capsuleSweep";
const CONVOY_CARGO = "convoyCargo";
const KILLBOARD_PRICES = "killboard.prices";
const KILLBOARD_KILLS = "killboard.vendorKills";
const KILLBOARD_NAMES = "killboard.names";
const JOB_BOARD = "jobBoard";
const IN_GAME_MAP_WINDOW = "inGameMap.window";
const TRIG_BRIDGE = "trigBridge";
const HARVEST_RAID = "harvestRaid";
const HARVEST_RAID_SKYHOOK = "harvestRaidSkyhook";
const EXTRACTION = "extraction";
const POP_STANDING_AGGRO = "populationStandingAggro";
const BOOKMARK_SITE_WARP = "bookmarkSiteWarp";
const CAPSULE_FX = "capsuleFx";

const GAME_MODULES = Object.freeze([
  mod("services/ship/beyonceService", [
    sym("Handle_CmdDock", "classPrototypeMethod", [LOYALTY_DOCK], "dock gate", { wrap: true }),
    sym("Handle_CmdWarpToStuff", "classPrototypeMethod", [BOOKMARK_SITE_WARP],
      "gas site bookmark warp post-hook", { wrap: true }),
  ]),
  mod("services/bookmark/bookmarkRuntimeState", [
    sym("getBookmarkForCharacter", "export", [BOOKMARK_SITE_WARP], "gas site bookmark read"),
  ]),
  mod("common/machoErrors", [
    sym("throwWrappedUserError", "export", [LOYALTY_DOCK, PLAYER_SOV_GATE, TRIG_BRIDGE],
      "dock refusal; hub deploy refusal (CustomNotify); trig bridge"),
  ]),
  mod("services/structure/structureJumpBridgeMgrService", [
    sym("Handle_CmdJumpThroughStructureStargate", "classPrototypeMethod", [TRIG_BRIDGE], "trig bridge jump scope",
      { wrap: true }),
    sym("findPendingJumpBridgeSettlementForCharacter", "method", [TRIG_BRIDGE],
      "trig bridge: a pending settlement = pass-through"),
  ]),
  mod("services/structure/structureJumpBridgeLinks", [
    sym("findReciprocalJumpBridge", "export", [TRIG_BRIDGE], "trig bridge destination end"),
  ]),
  mod("services/structure/structureCargoDeliveryService", [
    sym("Handle_DropOffItems", "classPrototypeMethod", [TRIG_BRIDGE], "trig bridge core install (Cargo Deposit)",
      { wrap: true }),
  ]),
  mod("services/_shared/serviceHelpers", [
    sym("unwrapMarshalValue", "export", [TRIG_BRIDGE], "trig bridge Cargo Deposit item list"),
    sym("buildKeyVal", "export", [FACTION_INCURSION_HUD], "faction incursion HUD dicts"),
    sym("buildDict", "export", [FACTION_INCURSION_HUD], "faction incursion HUD dicts"),
    sym("buildFiletimeLong", "export", [FACTION_INCURSION_HUD], "faction incursion HUD dicts"),
  ]),
  mod("services/incursion/incursionRuntime", [
    sym("listActiveIncursions", "export", [INCURSION_UI], "incursion-ui vendor list wrap", { wrap: true }),
  ]),
  mod("services/incursion/incursionFocusPlacement", [
    sym("selectPlacement", "export", [NATIVE_INCURSIONS], "native-incursions steering wrap", { wrap: true }),
  ]),
  mod("services/incursion/incursionLifecycleContract", [
    sym("fingerprint", "export", [NATIVE_INCURSIONS], "native-incursions narrowed catalog fingerprint"),
    sym("organicSchedulingEnabled", "export", [NATIVE_INCURSIONS], "native-incursions vendor bands"),
  ]),
  mod("services/incursion/incursionLifecycle", [
    sym("listTales", "export", [NATIVE_INCURSIONS, FACTION_INCURSION_HUD],
      "native-incursions tale read (bind / settle); faction incursion HUD vendor systems"),
    sym("getTale", "export", [NATIVE_INCURSIONS], "reward participants"),
  ]),
  mod("services/incursion/incursionRewardStore", [
    sym("read", "export", [NATIVE_INCURSIONS],
      "native-incursions boss receipt participants; reward participants"),
  ]),
  mod("services/incursion/incursionSystemEffects", [
    sym("shipModifiers", "export", [FACTION_INCURSION_EFFECTS], "faction incursion resistance penalty wrap",
      { wrap: true }),
    sym("damageMultiplier", "export", [FACTION_INCURSION_EFFECTS], "faction incursion damage penalty swap"),
    sym("bountyMultiplier", "export", [FACTION_INCURSION_EFFECTS], "faction incursion bounty wrap", { wrap: true }),
    sym("blocksCyno", "export", [FACTION_INCURSION_EFFECTS], "faction incursion cyno block wrap; vendor tale test",
      { wrap: true }),
  ]),
  mod("services/incursion/incursionSystemEffectContract", [
    sym("policy", "export", [FACTION_INCURSION_EFFECTS], "faction incursion effect values"),
    sym("VERSION", "export", [FACTION_INCURSION_EFFECTS], "faction incursion modifier source key",
      { valueType: "string" }),
    sym("RESONANCES", "export", [FACTION_INCURSION_EFFECTS], "faction incursion resonance attributes",
      { valueType: "object" }),
  ]),
  mod("services/map/mapTelemetryState", [
    sym("listJumpHistoryRows", "export", [INGAME_MAP_STARMAP], "in-game map jumps", { wrap: true }),
    sym("filetimeFromMs", "export", [INGAME_MAP_STARMAP], "in-game map kill time"),
  ]),
  mod("services/map/mapService", [
    sym("Handle_GetHistory", "classPrototypeMethod", [INGAME_MAP_STARMAP], "in-game map kills scope", { wrap: true }),
  ]),
  mod("services/map/devIndexManagerService", [
    sym("Handle_GetDevelopmentIndicesForSystem", "classPrototypeMethod", [DEV_INDEX_CLIENT],
      "client projection (one system)", { wrap: true }),
    sym("Handle_GetAllDevelopmentIndices", "classPrototypeMethod", [DEV_INDEX_CLIENT],
      "client projection (map filter)", { wrap: true }),
  ]),
  mod("services/sovereignty/sovPayloads", [
    sym("buildDevelopmentIndicesForSystemPayload", "export", [DEV_INDEX_CLIENT], "vendor payload"),
    sym("buildAllDevelopmentIndicesPayload", "export", [DEV_INDEX_CLIENT], "vendor payload"),
  ]),
  mod("services/sovereignty/sovConstants", [
    sym("DEV_INDEX_LEVEL_WIDTH", "property", [DEV_INDEX_CLIENT], "client scale"),
    sym("ATTRIBUTE_DEV_INDEX_MILITARY", "property", [DEV_INDEX_CLIENT], "attribute key"),
    sym("ATTRIBUTE_DEV_INDEX_INDUSTRIAL", "property", [DEV_INDEX_CLIENT], "attribute key"),
  ]),
  mod("services/exploration/wormholes/wormholeRuntimeState", [
    sym("mutateState", "export", ["core"], "Readiness"),
    sym("getStateView", "export", ["wormholes"], "wormhole overlay"),
    ...["listPairsForSystem", "getPairByEndpointID"].map((name) => sym(name, "export", [], "Vendor fact")),
  ]),
  mod("config/index", [
    sym("wormholesEnabled", "property", ["wormholes"], "vendor wormhole runtime on/off"),
    ...["asteroidBeltNpcRatsEnabled", "asteroidBeltNpcRatSpecialsEnabled"]
      .map((name) => sym(name, "property", [MINING_ENCOUNTERS], "vendor belt rat flags")),
    sym("npcDefaultConcordGateAutoAggroNpcsEnabled", "property", [AMBIENT_RATS_HIGHSEC],
      "vendor gate CONCORD NPC aggro flag"),
  ]),
  mod("services/mining/miningLedgerState", [
    sym("recordMiningLedgerEvent", "export", [MINING_ENCOUNTERS], "ledger wrap", { wrap: true }),
  ]),
  mod("services/mining/miningRuntime", [
    sym("executeMiningCycle", "export", [SHIP_AI_MINING], "ship-ai mining stop hook", { wrap: true }),
  ]),
  mod("space/worldData", [
    sym("ensureLoaded", "export", ["graph"], "graph load"),
    ...["getSolarSystems", "getSolarSystemByID", "getStargateByID"]
      .map((name) => sym(name, "export",
        name === "getSolarSystemByID" ? ["sites", TRIG_BRIDGE, FAME_CONCORD] : ["sites"],
        "sites; graph reads ensureLoaded; trig bridge jump scope")),
    sym("getMovementAttributesForType", "export", [TRIG_BRIDGE], "trig bridge ship mass of the type"),
    sym("getStargatesForSystem", "export", ["sites", MATERIALIZATION, SENTRIES, GRID_ANCHORS, BOUNTY_REVENGE],
      "sites; spawn anchor; sentry anchor; grid anchors; bounty revenge"),
    sym("getStationsForSystem", "export", ["sites", MATERIALIZATION, "capsuleers", SENTRIES, GRID_ANCHORS,
      BOUNTY_REVENGE],
    "sites; spawn anchor; capsuleer base; sentry anchor; grid anchors; bounty revenge"),
    sym("getStationByID", "export", ["stations", TRADE_MARKET, LOYALTY_DOCK, HIGHSEC_TRAFFIC, SEASON_REWARDS],
      "buy order station_metadata; dock gate; highsec traffic undock point; "
      + "season reward station"),
    sym("getCelestialsForSystem", "export", ["sites", "structures", PLAYER_HUNT, GRID_ANCHORS, FC_STRUCTURES,
      BOUNTY_REVENGE, EXTRACTION], "hunt sweep; grid sun; anchors; "
      + "bounty revenge; moon/PI yield"),
    sym("getAsteroidBeltsForSystem", "export", ["sites", MATERIALIZATION, GRID_ANCHORS, BOUNTY_REVENGE, SITUATIONS],
      "spawn anchor; grid belts; bounty revenge; situation belt names"),
  ]),
  mod("space/asteroids/asteroidData", [sym("getBeltsForSystem", "export", ["mining", LOCAL_RESOURCES, "beltOreDebit"],
    "belt ore pool")]),
  mod("services/planet/planetStaticData", [sym("getPlanetResourceTypeIDs", "export", [EXTRACTION],
    "P0 of a planet type")]),
  mod("space/asteroids/asteroidService", [
    sym("_testing", "export", [LOCAL_RESOURCES, "beltOreDebit"], "enriched ore pool and targeted belt generation", { valueType: "object" }),
  ]),
  mod("services/mining/miningRuntimeState", [
    sym("getMineableState", "export", ["beltOreDebit"], "read current belt ore stock"),
    sym("ensureSceneMiningState", "export", ["beltOreDebit"], "initialize detached belt stock"),
    sym("readPersistedSystemEntities", "export", ["beltOreDebit"], "read depletion without a loaded scene"),
    sym("readPersistedBeltGeneration", "export", ["beltOreDebit"], "identify exhausted generated belts"),
    sym("applyMiningDelta", "export", ["beltOreDebit"], "debit committed mining yield"),
  ]),
  mod("services/mining/miningVisuals", [
    sym("getSolarSystemOreTypeRecords", "export", [LOCAL_RESOURCES], "raw ore pool (fallback)"),
  ]),
  mod("services/mining/iceSystemAuthority", [
    sym("getIceSystemAuthorityRow", "export", [LOCAL_RESOURCES], "ice row (panel)"),
  ]),
  mod("services/mining/oreAnomalySecurityAuthority", ["resolveSecurityTierForSystemID", "listCatalogEntries"]
    .map((name) => sym(name, "export", [LOCAL_RESOURCES], "ore anomaly entitlement"))),
  mod("utils/tidiAutoscaler", [
    sym("observeRuntimeTickSample", "export", ["telemetry"], "Only tick sample source", { wrap: true }),
  ]),
  mod("space/runtime", [
    sym("scenes", "property", [MATERIALIZATION, SALVAGE, AMBIENT_RATS, HEAVY_EVENTS, HIGHSEC_TRAFFIC, SHIP_AI_WING,
      OFFICER_SPAWNS, BOUNTY, TRIG_BRIDGE, SITUATIONS, FACTION_INCURSION_EFFECTS, CAPSULE_FX], "scene read without"
      + " loading readGrid; ambient rats; heavy events; highsec traffic; ship-ai wing; officer spawns; bounty scene;"
      + " trig bridge look; situation anchors; faction incursion effects refresh; capsule effect scene fallback"),
    ...["spawnDynamicShip", "getSceneByDescriptor"].map((name) => sym(name, "prototypeMethod", [CAPSULE_FX],
      "capsule effect spawn; scene by descriptor without loading")),
    sym("droneInterop", "export", [CAPITAL_FIGHTERS, CAPITAL_FAX], "fighter strike; FAX repair",
      { valueType: "object" }),
    ...PRESENCE_NUDGE.map((name) => sym(name, "prototypeMethod", [], "nudge (optional, poll-only on DRIFT)")),
    ...VENDOR_PAUSE.map((name) => sym(name, "prototypeMethod", [VENDOR_PAUSES],
      "faction gate defense vendor pause excuse of the governor", { wrap: true })),
    ...RUNTIME_SCENE.map((name) => sym(name, "prototypeMethod",
      name === "getSceneForSession" ? [SENTRIES, CAPSULE_SWEEP, BOOKMARK_SITE_WARP] : [],
      "vendor fact; not used; sentry ammo access; capsule sweep board scene; bookmark warp scene")),
    sym("getEntity", "prototypeMethod", [SENTRIES, SHIP_AI_TOOLS, TRIG_BRIDGE],
      "sentry ammo access (entityQueries.js); ship sensors; trig bridge ship mass"),
    sym("spawnDynamicInventoryEntity", "prototypeMethod", [SENTRY_FACTION],
      "sentry faction sentry entity (dynamicEntities.js), only after isSolarSystemSceneLoaded"),
    sym("isSolarSystemSceneLoaded", "prototypeMethod", [SALVAGE, MATERIALIZATION, SENTRIES, SENTRY_FACTION,
      AMBIENT_RATS, HEAVY_EVENTS, HIGHSEC_TRAFFIC, SHIP_AI_WING, OFFICER_SPAWNS, BOUNTY, TRIG_BRIDGE, SITUATIONS,
      FAME_CONCORD],
    "vendor fact; scene"
      + " guard; spawn guard; sentry heal guard; sentry faction guard; faction ambient rats scene guard"
      + " heavy events scene guard; highsec traffic scene guard; ship-ai wing scene guard; officer spawns scene guard;"
      + " bounty scene guard"),
    sym("getStationUndockSpawnState", "prototypeMethod", [HIGHSEC_TRAFFIC],
      "highsec traffic undock spawn state and dock point"),
    sym("syncStructureSceneState", "prototypeMethod", [TRIG_BRIDGE], "trig bridge Jump in the menu after a link"),
    ...["ensureScene", "warpDynamicEntityToPoint"]
      .map((name) => sym(name, "prototypeMethod", [], "vendor fact; never called")),
  ], { factDir: "space/runtime/spaceRuntime" }),
  mod("space/runtime/systemSecurityBand", ["getSystemSecurityClass", "getSolarSystemPseudoSecurity"]
    .map((name) => sym(name, "export", ["graph"], "graph security band"))),
  mod("space/runtime/solarSystemScene", [
    sym("SolarSystemScene", "export", [TRIG_BRIDGE], "trig bridge look: the scene class"),
    sym("addStaticEntity", "classPrototypeMethod", [TRIG_BRIDGE], "trig bridge look (slimTypeID of a marked Ansiblex)",
      { wrap: true, classExport: "SolarSystemScene" }),
    sym("queueBubbleHistory", "classPrototypeMethod", [HIGHSEC_TRAFFIC],
      "highsec traffic warping effect to the bubble of the ball", { classExport: "SolarSystemScene" }),
  ], { factDir: "space/runtime/scene" }),
  mod("gameStore/index", [
    sym("registerShutdownHook", "export", ["persistence"], "persistence shutdown hook"),
    sym("onPersistenceOwnerLost", "export", ["persistence"], "persistence owner lost hook"),
    sym("_processRole", "property", ["core"], "process role"),
    sym("flushTableSync", "export", ["structures", SALVAGE, LIBERATION_REWARDS, PLAYER_SIEGE, SOV_PHYSICAL,
      FC_STRUCTURES],
      "wreck tables (DRIFT = no flush); ISK durability; player siege; "
        + "TCU flush; flush"),
    sym("flushTableDurable", "export", [], "persistence worker flush (optional, flushTableSync without it)"),
    sym("read", "export", ["virtualCorps", CONTRACT_LIST_LIVE, SHIP_AI_DB, NATIVE_INCURSIONS, FACTION_INCURSION_HUD],
      "read game store for scan/adopt; contract list live read; missions; "
        + "incursion tale list version"),
    sym("flushTablesSync", "export", ["virtualCorps"], "flush game store tables"),
    sym("write", "export", [ESS_REPOSITORY_FAST], "ess fast read: root write with knownChangedPaths"),
    sym("readPersisted", "export", [ESS_REPOSITORY_FAST], "ess fast read: parity"),
  ]),
  mod("space/npc/npcService", [
    sym("setBehaviorOverrides", "export", [MATERIALIZATION, AMBIENT_RATS, BOUNTY_REVENGE, POP_STANDING_AGGRO],
      "ambient rats setAggro; bounty revenge search / attack; population standing aggro"),
    ...["issueManualOrder", "wakeNpcController"]
      .map((name) => sym(name, "export", [MATERIALIZATION, BELT_NAVY_AGGRO, MINING_ENCOUNTERS, BOUNTY,
        POP_STANDING_AGGRO],
      "belt navy; mining encounters hauler warp-off; bounty runner warp-off; population standing aggro")),
    sym("destroyNpcControllerByEntityID", "export", [MATERIALIZATION, BELT_NAVY_AGGRO, HEAVY_EVENTS, HIGHSEC_TRAFFIC,
      BOUNTY], "belt navy; heavy events despawn; highsec traffic despawn; bounty despawn"),
    sym("noteNpcIncomingAggression", "export", [], "vendor fact; not used"),
    sym("getControllerByEntityID", "export", [PLAYER_HUNT, BELT_NAVY_AGGRO, AMBIENT_RATS, MINING_ENCOUNTERS, BOUNTY,
      POP_STANDING_AGGRO], "hunt retaliation; belt navy; ambient rats setAggro state; mining encounters"
      + " hauler warp-off; bounty aggression; population standing aggro"),
    sym("spawnNpcGroupInSystem", "export", [], "vendor fact; spawns single ships"),
  ]),
  mod("space/npc/npcRuntime", [
    sym("warpToPoint", "export", [PLAYER_HUNT, HIGHSEC_TRAFFIC, BOUNTY_REVENGE],
      "hunt warp; highsec traffic warp; bounty revenge warp"),
    sym("spawnGroupInSystem", "export", [FAME_CONCORD], "fame CONCORD spawn on the highsec hunters"),
  ]),
  mod("space/npc/npcCombatDormancy", [
    sym("canDematerializeDormantCombatController", "export", [DORMANCY_GUARD],
      "First-load wrap", { firstLoad: true }),
    sym("isCombatDormantControllerRecord", "export", [], "vendor fact; operatorKind qualifies for dormancy"),
  ]),
  mod("space/npc/nativeNpcStore", [
    sym("allocateEntityID", "export", [CAPSULE_FX], "capsule effect transient entity id"),
    sym("listNativeControllers", "export", [], "vendor fact; not used"),
    sym("getNativeEntity", "export", [HIGHSEC_TRAFFIC, CONVOY_CARGO, BOUNTY],
      "highsec traffic hauler bounty 0 in the store record; cargo owner; bounty loot"),
    sym("upsertNativeEntity", "export", [HIGHSEC_TRAFFIC], "highsec traffic hauler bounty 0 in the store record"),
    ...["allocateCargoID", "upsertNativeCargo"]
      .map((name) => sym(name, "export", [CONVOY_CARGO, BOUNTY],
        "convoy carrier cargo hold; boss loot")),
    sym("getNativeController", "export", [DORMANCY_PURGE, AMBIENT_RATS],
      "Despawn purge; dormant ids"),
    sym("removeNativeEntityCascade", "export", [DORMANCY_PURGE],
      "Despawn purge"),
    sym("listNativeControllersForSystem", "export", [AMBIENT_RATS, HIGHSEC_TRAFFIC, SITUATIONS],
      "dormant lneAmbient ids; highsec traffic orphans; situation orphans"),
    ...["allocateWreckID", "allocateWreckItemID", "upsertNativeWreck", "upsertNativeWreckItem", "listNativeWrecks",
      "listNativeWreckItemsForWreck", "removeNativeWreckCascade"]
      .map((name) => sym(name, "export", [SALVAGE], "native wreck store")),
    sym("getNativeWreck", "export", [SALVAGE], "scale"),
    sym("TABLE", "property", [SALVAGE], "table names of the flush"),
  ]),
  mod("space/npc/nativeNpcWreckService", ["spawnNativeWreck", "destroyNativeWreck"]
    .map((name) => sym(name, "export", [SALVAGE], "native wreck spawn / destroy"))),
  mod("space/wreckUtils", ["resolveEntityWreckType", "resolveShipWreckType"]
    .map((name) => sym(name, "export", [SALVAGE], "wreck type"))),
  mod("space/npc/npcLoot", [sym("rollNpcLootEntries", "export", [SALVAGE, BOUNTY],
    "loot roll; bounty officer loot")]),
  mod("services/inventory/itemTypeRegistry", [
    sym("resolveItemByTypeID", "export", [SALVAGE, TRADE_CATALOG, SENTRY_FACTION, FREE_CORPS_CONTRACTS,
      FREE_CORPS_COURIERS, CONVOY_CARGO, KILLBOARD_PRICES, BOUNTY, TRIG_BRIDGE, HARVEST_RAID, HARVEST_RAID_SKYHOOK,
      SENTRY_LOOK, POPULATION_HULLS],
    "item / fallback wreck types; trade catalog; sentry charge volume; portion; "
      + "courier volume; cargo hold type; basePrice; bounty hunters "
      + "boss loot type; trig bridge core type; harvest raid moon material; harvest raid skyhook reagent volume; "
      + "graphicID of the look type; population graphicID of the civilian hull pairs"),
    sym("resolveItemByName", "export", [SALVAGE, SHIP_AI_TOOLS],
      "item / fallback wreck types; item by name"),
    sym("listItemTypes", "export", [SHIP_AI_TOOLS], "ship-ai fuzzy item search by name fragments"),
  ]),
  mod("space/combat/killmailTracker", ["enqueueKillmailFromDestruction", "recordKillmailFromDestruction"]
    .map((name) => sym(name, "export", ["materialization", CAPSULE_FX], "killmail of a live kill; capsule effect",
      { firstLoad: true }))),
  mod("services/dungeon/dungeonRuntime", [
    sym("createInstance", "export", ["sites"], "site instance create"),
    sym("findInstanceBySiteKey", "export", ["sites", SALVAGE, ARCHAEOLOGY],
      "wreck scope of the site; hack receipts of an archive site"),
    sym("setLifecycleState", "export", ["sites"], "site lifecycle"),
    sym("purgeInstance", "export", ["sites"], "site purge"),
    sym("peekNextInstanceID", "export", ["sites"], "site instance id"),
    sym("getInstanceSummary", "export", [SITE_NAVY, CAPSULE_FX], "site family, origin, flags; capsule mission source"),
    sym("getInstanceRef", "export", [SITE_NAVY, SHIP_AI_CALLOUT, ARCHAEOLOGY],
      "decision after a restart; ship-ai callout site faction of a dungeon NPC; "
        + "hack receipts of an archive site"),
    sym("registerInstanceChangeListener", "export", [ESCALATIONS, ARCHAEOLOGY],
      "completion listener; hack wins"),
    sym("unregisterInstanceChangeListener", "export", [ESCALATIONS, ARCHAEOLOGY],
      "completion listener; hack wins"),
  ]),
  mod("services/dungeon/dungeonAuthority", [
    sym("getTemplateByID", "export", ["sites"], "site template"),
    sym("getTemplateByIDReadOnly", "export", [SITE_NAVY], "template check"),
  ]),
  mod("services/dungeon/dungeonUniverseSiteService", [
    sym("isUniverseSiteTeardownParked", "export", ["sites"], "site teardown parked"),
    sym("ensureSiteContentsMaterialized", "export", [BOOKMARK_SITE_WARP],
      "gas site materialization after a bookmark warp"),
  ]),
  mod("services/exploration/signatures/signaturePlacement", [
    sym("buildAnchorRelativeSignaturePlacement", "export", ["sites"], "site signature placement"),
  ]),
  mod("services/exploration/signatures/providers/sceneAnomalySiteProvider", [
    sym("listAnomalySites", "export", [SITE_SCANNER], "Scanner filter of hidden LNE sites", { wrap: true }),
  ]),
  mod("services/exploration/signatures/signatureRuntime", [
    sym("listSystemAnomalySites", "export", [HUNT_ANOMALIES], "hunt sweep anomalies"),
    sym("listSystemSignatureSites", "export", [HIGHSEC_TRAFFIC_EXPLORER], "civilian explorer site read"),
  ]),
  mod("services/exploration/scanMgrService", [
    sym("notifyAnomalyDeltaForSystem", "method", [SITE_SCANNER], "Scanner delta after a hide"),
    sym("Handle_ConeScan", "classPrototypeMethod", [SHIP_AI_DSCAN], "ship-ai d-scan 360 (vendor filters)"),
    sym("_getSystemID", "classPrototypeMethod", [SHIP_AI_DSCAN], "ship-ai d-scan: the only `this` of ConeScan"),
  ]),
  mod("services/exploration/probes/probeScanRuntime", [
    sym("buildSignatureScanResults", "export", ["frontJobs"], "SCAN observation",
      { firstLoad: false, wrap: true }),
  ]),
  mod("_secondary/chat/chatRuntime", [
    sym("broadcastLocalMessage", "export", [FRONT_CHAT], "Local chat trigger",
      { wrap: true }),
    sym("on", "export", [LOCAL_PILOTS, NPC_VOICES_TALK], "Local list listener; "
      + "Local tap listener", { firstLoad: true }),
    sym("off", "export", [NPC_VOICES_TALK], "Local tap listener removal"),
    ...["publishLocalMembershipListForSession", "getLocalSessionsForRoom", "buildLocalGatewayMember"]
      .map((name) => sym(name, "export", [LOCAL_PILOTS], "Local pilots")),
    sym("sendChannelMessage", "export", [SHIP_AI], "private AI room lines", { wrap: true }),
    sym("ensurePrivateChannelForCharacters", "export", [SHIP_AI], "private AI room"),
  ]),
  mod("services/dungeon/dungeonTrackingRuntime", [
    sym("enterDungeonRoomForSession", "export", [NPC_VOICES_SITE], "site entry hook",
      { wrap: true }),
    sym("notifyDungeonCompletedForScene", "export", [SHIP_AI_SITE], "ship-ai site cleared hook",
      { wrap: true }),
    sym("recordAbyssalRunCompletion", "export", [ABYSSAL], "run completion hook",
      { wrap: true }),
  ]),
  mod("abyssal/domain/abyssalHostLocation", [
    sym("isAbyssalHostLocationID", "export", [ABYSSAL_HOST], "pocket host check"),
  ]),
  mod("abyssal/policy/abyssalSpaceRuntimeIntegration", [
    sym("getActiveAbyssalRunForCharacterID", "export", [ABYSSAL], "live run read"),
  ]),
  mod("abyssal/transport/abyssalContentManagerService", [
    sym("resolvePersistedFilamentDefinition", "export", [ABYSSAL_TIER], "tier of a run"),
  ]),
  mod("space/npc/trigDrifter/trigDrifterSpawnAuthority", [
    sym("getSystemList", "export", [TRIG_DRIFTER_LISTS], "drifter observatory list", { valueType: "function" }),
  ]),
  mod("services/chat/chatHub", [
    sym("sendSystemMessage", "export", [NPC_VOICES_SITE], "site line to one player"),
  ]),
  mod("services/chat/channelRules", ["getLocalChatRoomNameForSolarSystemID", "isDelayedLocalChatRoomName"]
    .map((name) => sym(name, "export", [LOCAL_PILOTS], "Local room rules"))),
  mod("services/chat/xmppStubServer", [
    sym("handleSocketForEdge", "export", [LOCAL_PILOTS, SHIP_AI],
      "MUC occupant tap; AI room tap", { firstLoad: true }),
    sym("inviteCharacterToRoom", "export", [SHIP_AI], "invitation from the AI"),
  ]),
  mod("services/mail/mailState", [
    sym("sendMail", "export", [NOTICES], "Player mail"),
    sym("getMailboxEntries", "export", [NOTICES, SHIP_AI_MAIL],
      "Player mail; mailbox scan"),
    sym("resolveWelcomeSenderID", "export", [NOTICES], "Player mail"),
    sym("getMessageByIDForCharacter", "export", [SHIP_AI_MAIL], "one mail by id"),
  ]),
  mod("services/mail/mailNotifications", [
    sym("sendMailSentNotification", "export", [SHIP_AI_MAIL], "new mail signal",
      { firstLoad: true, wrap: true }),
  ]),
  mod("services/structure/structureState", [
    ...["createStructure", "updateStructureRecord", "destroyStructure", "removeStructure", "listStructures",
      "getStructureTypeByID"]
      .map((name) => sym(name, "export", name === "listStructures" || name === "updateStructureRecord"
        ? ["structures", SOV_PHYSICAL, FC_STRUCTURES, TRIG_BRIDGE] : ["structures", SOV_PHYSICAL, FC_STRUCTURES],
      "TCU; trig bridge pair (listStructures, refresh:false)")),
    sym("registerStructureChangeListener", "export", ["structures"], "structure change listener"),
    sym("getStructureByID", "export", ["structures", PLAYER_SIEGE, SOV_PHYSICAL, FC_STRUCTURES, TRIG_BRIDGE,
      HARVEST_RAID], "player siege one structure (refresh:false); TCU; "
      + "trig bridge; harvest raid Metenox"),
    sym("STRUCTURES_TABLE", "property", ["structures", PLAYER_SIEGE, SOV_PHYSICAL, FC_STRUCTURES],
      "table name of the flush; player siege"),
    ...["peekStructures", "applyAdminStructureDamage", "resolveStructureEffectiveHitpoints",
      "resolveStructureLayerDamageLimits"]
      .map((name) => sym(name, "export", name === "peekStructures" ? [PLAYER_SIEGE, SENTRIES] : [PLAYER_SIEGE],
        "player siege index, hit, EHP, damage cap; sentry anchors")),
    sym("peekStructuresForSystem", "export", [GRID_ANCHORS], "grid structure, LNE station and TCU anchors"),
  ]),
  mod("services/structure/structureConstants", [
    ...["STRUCTURE_STATE", "STRUCTURE_UPKEEP_STATE"]
      .map((name) => sym(name, "export", ["structures", PLAYER_SIEGE, SOV_PHYSICAL, FC_STRUCTURES],
        "state numbers from the vendor", { valueType: "object" })),
    sym("STRUCTURE_FAMILY", "export", [PLAYER_SIEGE], "player siege family names", { valueType: "object" }),
  ]),
  mod("services/structure/structureAssetSafetyState", [
    sym("isAssetSafetyDisabledForStructure", "export", [PLAYER_SIEGE], "player siege asset safety gate"),
  ]),
  mod("services/online/characterControlRuntime", [
    sym("getCharacterControlSnapshot", "export", [PLAYER_SIEGE], "player siege owner activity"),
  ]),
  mod("services/structure/structureDeploymentPlacement", [
    sym("validateDeploymentPlacement", "export", ["structures", FC_STRUCTURES],
      "position without conflict"),
  ]),
  mod("services/chat/sessionRegistry", [sym("getSessions", "export", ["presence", NPC_VOICES_SITE, SHIP_AI_TOOLS,
    SHIP_AI_DB, JOB_BOARD, IN_GAME_MAP_WINDOW, FACTION_INCURSION_HUD], "presence source; "
    + "site line; ship sensors; game data tools; "
    + "OnLneBoardOpen; OnLneMapProbe; faction incursion HUD")]),
  mod("services/market/marketTopology", [sym("getJumpCount", "export", [], "jump count (vendor fact)")]),
  mod("../bootstrap", [
    sym("bootWorld", "export", ["core"], "world boot", { firstLoad: true }),
    sym("PRODUCTION_STAGES", "export", ["core"], "boot stages", { valueType: "object" }),
  ]),
  mod("space/runtime/runtimeModuleBoundary", [sym("OWNS_WORLD_SIMULATION", "property", [], "diag")]),
  mod("space/npc/pirateFactionPolicy", [
    sym("resolvePirateFactionForSystem", "export", [], "Seed checks itself"),
    sym("PIRATE_FACTION_BY_FACTION_ID", "export", ["standings"], "Seed checks itself; standings",
      { valueType: "object" }),
    sym("resolvePirateFactionKeyForSystem", "export", ["projection"], "first-load wrap",
      { firstLoad: true, wrap: true }),
  ]),
  mod("space/npc/capitals/capitalNpcCatalog", [
    sym("getCapitalNpcGeneratedRows", "export", [CAPITAL_LIVE, FACTION_PROFILES],
      "LNE capital profiles; LNE faction profiles",
      { firstLoad: true, wrap: true }),
  ]),
  mod("space/npc/capitals/capitalNpcAuthority", [
    sym("CAPITAL_NPC_AUTHORITY", "export", [CAPITAL_LIVE], "capital templates",
      { valueType: "object" }),
  ]),
  mod("services/fighter/npc/npcSupercarrierDirector", [
    sym("syncNpcSupercarrierSystems", "export", [CAPITAL_FIGHTERS], "fighter strike trigger",
      { firstLoad: true, wrap: true }),
  ]),
  mod("space/npc/capitals/capitalNpcMovement", [
    sym("syncCapitalNpcMovement", "export", [CAPITAL_FAX], "FAX repair trigger", { firstLoad: true, wrap: true }),
  ]),
  mod("space/modules/assistanceModuleRuntime", [
    sym("executeAssistanceModuleCycle", "export", [CAPITAL_FAX], "FAX repair cycle"),
  ]),
  mod("space/npc/npcEquipment", [
    sym("getNpcAssistanceModules", "export", [CAPITAL_FAX], "FAX repair guard"),
  ]),
  mod("services/fighter/fighterDogma", [
    sym("resolveFighterAbilitySnapshot", "export", [CAPITAL_FIGHTERS], "ability snapshot"),
  ]),
  mod("services/fighter/fighterRuntime", [
    sym("getFighterOrbitDistance", "export", [CAPITAL_FIGHTERS], "fighter orbit"),
    sym("_testing", "export", [CAPITAL_FIGHTERS], "drift guard canPlayerCompanionActOnTarget",
      { valueType: "object" }),
  ]),
  mod("space/combat/missiles/missileSolver", [
    sym("resolveMissileAppliedDamage", "export", [CAPITAL_FIGHTERS], "fighter missiles"),
  ]),
  mod("space/combat/damage", [
    sym("hasDamageableHealth", "export", [CAPITAL_FIGHTERS], "target gate"),
    ...["getEntityMaxHealthLayers", "getEntityCurrentHealthLayers"]
      .map((name) => sym(name, "export", [SHIP_AI_TOOLS], "ship sensors")),
  ]),
  mod("space/runtime/entityCapacitor", [
    sym("getEntityCapacitorRatio", "export", [SHIP_AI_TOOLS], "ship sensors"),
  ]),
  mod("services/skills/skillState", ["isCharacterSkillMapCached", "getCachedCharacterSkillMap"]
    .map((name) => sym(name, "export", [SHIP_AI_TOOLS], "skills summary"))),
  mod("space/destiny/authority/sceneRangeDecision", [
    sym("getSceneSurfaceDistance", "export", [CAPITAL_FIGHTERS, CAPITAL_FAX], "range; FAX repair"),
  ]),
  mod("space/destiny/simulation/evolve", [
    sym("isWarping", "export", [CAPITAL_FIGHTERS], "movement"),
  ]),
  mod("space/destiny/identity/interactionScope", [
    sym("canEntitiesInteractLocally", "export", [CAPITAL_FIGHTERS, CAPITAL_FAX, CAPSULE_FX],
      "scope (dungeon, abyss, AIR); FAX repair; capsule effect player sees the victim scope"),
    sym("buildChildEntityScopeMetadata", "export", [CAPSULE_FX], "capsule effect inherits the victim scope"),
  ]),
  mod("space/FireShow/showIdentity", [
    sym("isFireShowShip", "export", [CAPSULE_FX], "capsule effect identity self check (no wreck, no killmail)"),
  ]),
  mod("space/npc/capitals/capitalNpcState", [
    sym("listControlledNpcFighters", "export", [CAPITAL_FIGHTERS], "fighters of a controller"),
  ]),
  mod("services/dungeon/dungeonSiteSpawnPolicy", [
    sym("buildRuntimeSystemPolicyContext", "export", ["siteProjection", "sitePolicyHubs"],
      "wrap; freeze scope",
      { firstLoad: true, wrap: true }),
  ]),
  mod("space/npc/beltRatRuntime", [
    sym("maybeSpawnForSessionArrival", "export", ["empireBelts", MINING_ENCOUNTERS],
      "First-load wrap; wave", { firstLoad: true, wrap: true }),
    sym("resolveSecurityProfile", "export", ["empireBelts", SITE_NAVY, MINING_ENCOUNTERS, AMBIENT_RATS],
      "Band", { firstLoad: true }),
    sym("findNearestBeltForEntity", "export", [MINING_ENCOUNTERS], "belt of the miner"),
    sym("OPERATOR_KIND", "property", [MINING_ENCOUNTERS], "belt rat group marker"),
    sym("buildBeltRatSpawnPlan", "export", [AMBIENT_RATS, MINING_ENCOUNTERS, OFFICER_SPAWNS, BOUNTY],
      "group plan; anomaly wave plan; officer spawns plan"
      + " bounty commander plan"),
  ]),
  mod("space/npc/npcData", [
    sym("buildNpcDefinition", "export", ["empireBelts", AMBIENT_RATS],
      "Navy definition; navy group"),
    sym("getNpcLootTable", "export", [SALVAGE, BOUNTY], "loot table; bounty officer loot table"),
    sym("getNpcProfile", "export", [NEMESIS_EWAR], "nemesis EWAR profile hull type"),
  ]),
  mod("space/npc/npcPresentation", [
    sym("buildNpcEntityIdentity", "export", ["empireBelts"], "pirate bounty reader"),
  ]),
  mod("space/npc/nativeNpcService", [
    sym("spawnNativeDefinitionsInContext", "export", ["empireBelts", SITE_NAVY, AMBIENT_RATS, MINING_ENCOUNTERS,
      OFFICER_SPAWNS, BOUNTY], "Default spawner; site wave wrap;"
      + " anomaly wave; officer spawns; bounty commander"),
    sym("spawnNativeNpcEntityInSystem", "export", [MATERIALIZATION, HEAVY_EVENTS, HIGHSEC_TRAFFIC, BOUNTY],
      "live ship spawn; heavy events phase spawn; highsec traffic hauler spawn; bounty boss / escort spawn"),
  ]),
  mod("space/npc/pirateHullProfiles", [
    sym("resolveFactionHullProfileID", "export", [MATERIALIZATION, HEAVY_EVENTS, BOUNTY],
      "pirate hull profile; heavy events resolveProfiles; bounty boss / escort hull"),
    sym("listPoolCandidates", "export", [NEMESIS_EWAR], "nemesis EWAR pool candidates"),
    sym("STANDARD_POOL_QUERY_BY_FACTION", "export", [NEMESIS_EWAR], "nemesis EWAR pool of a faction",
      { valueType: "object" }),
  ]),
  mod("space/npc/npcEntityEwarCatalog", [
    sym("resolveEntityEwarSpecs", "export", [NEMESIS_EWAR], "nemesis EWAR families of a hull"),
  ]),
  mod("gameStore/storeRoot", [sym("resolveStoreRoot", "export", [], "sdeBuild of the seed")]),
  mod("services/character/factionKillStandingRuntime", [
    sym("recordNpcFactionStandingLoss", "export", ["liberation", "standings", "playerActivity", "frontJobs",
      SHIP_AI_KILLS, BOUNTY], "NPC kill standing loss hook", { firstLoad: true, wrap: true }),
    sym("resolveVictimFactionID", "export", ["liberation", "standings", PLAYER_HUNT, POP_STANDING_AGGRO],
      "hunt NPC aggressor faction; ship-ai hostile-callout grid NPC faction (optional read);"
      + " population standing aggro attacker faction", { firstLoad: true }),
  ]),
  mod("space/npc/npcRegistry", [
    sym("listControllersBySystem", "export", [SHIP_AI_CALLOUT], "ship-ai hostile-callout grid NPCs"),
    sym("getControllerByEntityID", "export", [SHIP_AI_DSCAN, SENTRY_DEFEND],
      "ship-ai d-scan NPC / player; sentry defend-owner NPC aggressors"),
  ]),
  mod("services/character/portraitImageStore", [
    sym("storeCharacterPortrait", "export", [SHIP_AI_PORTRAIT], "portrait of the ship AI"),
    sym("clearCharacterPortraits", "export", [SHIP_AI_PORTRAIT], "Clear before store"),
  ]),
  mod("services/character/standingRuntime", [
    sym("applyStandingChanges", "export", ["standings", "trade"], "write seam (idempotencyKey receipts); trade delivery standing"),
    sym("getCharacterRawStandingFromRecord", "export", ["trade"], "standing read (no clone)"),
    sym("getOwnerFactionID", "export", [SHIP_AI_CALLOUT], "ship-ai callout owner faction of a dungeon NPC"),
  ]),
  mod("services/character/characterState", [
    sym("peekCharacterRecord", "export", ["standings", "trade", PLAYER_SIEGE, LOCAL_CONTACTS],
      "receipt keys (no clone); standing read; player siege last logon/logoff; "
      + "Local standing colors personal contacts read"),
    sym("updateCharacterRecord", "export", ["standings", LOCAL_CONTACTS],
      "prune own lne: receipts; Local standing colors CAS write of the LNE personal contacts"),
    sym("peekCharacterRecord", "export", ["virtualCorps", LOCAL_PILOTS, FREE_CORPS_RECYCLE, FREE_SAGA_LEAN, SHIP_AI,
      SHIP_AI_DB, SHIP_AI_TRIGGERS, NPC_VOICES_TALK, KILLBOARD_NAMES, SEASON_REWARDS],
    "peek character record (join); pilot corporation/alliance; "
      + "the corporation before a move; free saga lean the CEO before its join; "
      + "the AI record of the room presence; pilot_info; "
      + "standings / wallet journal fallback; ship-ai security status; "
      + "the name of a Local speaker"),
    sym("writeCharacterRecord", "export", ["virtualCorps"],
      "write character record (definer); rename of the suffixed LNE characters"),
    sym("getActiveShipRecord", "export", [CAPSULE_SWEEP, TRIG_BRIDGE],
      "capsule sweep active ship around a board; trig bridge ship"),
    sym("syncInventoryItemForSession", "export", [TRIG_BRIDGE], "trig bridge core void inventory sync"),
  ]),
  mod("services/security/crimewatchRuntimeState", [
    sym("getCharacterState", "export", [SHIP_AI_TRIGGERS], "ship-ai crimewatch flags"),
  ]),
  mod("services/security/crimewatchState", [
    sym("getConcordResponseDelayMsForSystem", "export", [FAME_CONCORD], "fame CONCORD response time"),
    sym("hasActiveLimitedEngagement", "export", [SENTRY_DEFEND], "sentry LE of owner and pilot"),
  ]),
  mod("space/entityConstants", [
    sym("ENTITY_TYPE", "export", [FAME_CONCORD], "fame ENTITY_TYPE.CONCORD of the CONCORD spawn",
      { valueType: "object" }),
  ]),
  mod("services/sovereignty/sovState", [
    sym("getSystemSovClaim", "export", ["invasions", "sovReconcile", "sovCampaignSpread"],
      "player sov claim; reconcile; freeze hub alliance"),
    sym("getSystemState", "export", ["sovReconcile", PLAYER_SOV, PLAYER_SOV_GATE, DEV_INDEX_CLIENT],
      "live cache reference - adapter copies primitive fields only; CAS of a "
      + "release / capture and the neutral player hub guard of the projection; deployer of a new hub; "
      + "alliance claim of one system (allianceID read only)"),
    sym("getDevelopmentIndicesForSystem", "export", [DEV_INDEX_CLIENT], "vendor indices"),
    sym("listAllDevelopmentIndices", "export", [DEV_INDEX_CLIENT], "vendor list"),
    sym("listAllAllianceSystems", "export", [DEV_INDEX_CLIENT], "alliance claims"),
    sym("listAllSovereigntySystemStates", "export", [PLAYER_SOV], "mirror read"),
  ]),
  mod("services/sovereignty/sovPlayerDeployment", [
    sym("deployStructureFromInventoryItem", "export", [PLAYER_SOV_GATE], "",
      { firstLoad: true, wrap: true }),
  ]),
  mod("services/sovereignty/sovCampaignState", [
    sym("bindDurableScheduler", "export", ["sovCampaignSpread"], "freeze wrap", { firstLoad: true, wrap: true }),
    sym("unbindDurableScheduler", "export", ["sovCampaignSpread"], "freeze wrap", { firstLoad: true, wrap: true }),
  ]),
  mod("services/sovereignty/sovModernState", [
    sym("getHubUpgrades", "export", ["sitePolicyHubs"], "freeze wrap", { wrap: true }),
    sym("getHubUpgradesPendingPersistence", "export", ["sitePolicyHubs"], "freeze read"),
    sym("listRaidSkyhooks", "export", ["playerValue", HARVEST_RAID_SKYHOOK], "K2 skyhook count; raid skyhook index"),
    sym("getRaidSkyhook", "export", [HARVEST_RAID_SKYHOOK], "raid skyhook read (a clone)"),
    sym("mutateSkyhookRaid", "export", [HARVEST_RAID_SKYHOOK], "raid skyhook theft + idempotency mark, one mutation"),
  ]),
  mod("services/sovereignty/skyhookHarvest", [
    sym("settleSkyhookHarvest", "export", [HARVEST_RAID_SKYHOOK], "raid skyhook harvest projection"),
  ]),
  mod("services/sovereignty/skyhookRaidRules", [
    sym("isWindowOpen", "export", [HARVEST_RAID_SKYHOOK], "raid skyhook theft window"),
  ]),
  mod("services/dynamic/essRepository", [
    ...["read", "write", "mutate"].map((name) => sym(name, "export", [ESS_REPOSITORY_FAST], "ess fast read wrap",
      { firstLoad: true, wrap: true })),
    sym("check", "export", [ESS_REPOSITORY_FAST], "ess fast read: the vendor result check"),
    sym("TABLE_NAME", "export", [ESS_REPOSITORY_FAST], "ess fast read: table name", { valueType: "string" }),
  ]),
  mod("services/dynamic/essSettlementRuntime", [
    sym("handleJob", "export", [ESS_REPOSITORY_FAST, ESS_COLLAPSE], "ess job counters wrap; ess collapse",
      { firstLoad: true, wrap: true }),
    sym("reconcile", "export", [ESS_COLLAPSE], "ess collapse: start reconcile without N schedules", { wrap: true }),
    sym("synchronize", "export", [ESS_COLLAPSE], "ess collapse: one maintain per system"),
    sym("schedule", "export", [ESS_COLLAPSE], "ess collapse: durable retry"),
  ]),
  mod("services/dynamic/dynamicResourceState", [
    sym("listSystemStates", "export", [ESS_COLLAPSE], "ess collapse: banks after boot"),
  ]),
  mod("services/scheduler/durableScheduler", [
    sym("createDurableScheduler", "export", [STALL_DIAG], "stall diag: job handler timing", { firstLoad: true }),
  ]),
  mod("services/killmail/killmailState", [
    sym("getAllKillmailRecords", "export", [STALL_DIAG], "stall diag: full killmail clone timing", { firstLoad: true }),
    sym("forEachKillmailRecordDescending", "export", [INGAME_MAP_STARMAP], "in-game map kills",
      { firstLoad: true }),
    sym("getKillmailProjectionStats", "export", [DBS_KILLMAIL_CACHE, SHIP_AI_DB],
      "dbs killmail cache: index version; killmails index gate"),
    sym("listKillmailsForCharacter", "export", [SHIP_AI_DB], "killmails"),
    sym("createKillmailRecordIdempotent", "export", [FREE_CORPS_KILLMAILS], "free corps virtual killmails"),
    sym("getKillmailRecord", "export", [KILLBOARD_KILLS], "one killmail by killID"),
    sym("listPendingKillmailEvents", "export", [KILLBOARD_KILLS], "reserved, uncommitted killIDs"),
  ]),
  mod("services/dynamic/dynamicBountyRuntime", [
    sym("maintain", "export", [DBS_KILLMAIL_CACHE], "dbs killmail cache scope", { wrap: true }),
    sym("recoverLosses", "export", [DBS_KILLMAIL_CACHE, ESS_COLLAPSE], "dbs killmail cache scope; ess collapse",
      { wrap: true }),
  ]),
  mod("gameStore/tableRepository", [
    sym("createTableRepository", "export", [ESS_REPOSITORY_FAST], "ess fast read repository"),
  ]),
  mod("gameStore/sqliteStore", [
    sym("rowGroupsFor", "export", [ESS_REPOSITORY_FAST], "ess fast read: dynamicResourceRuntime row groups"),
  ]),
  mod("services/sovereignty/sovGmState", [
    sym("anchorSovereigntyHub", "export", ["sovProjection", PLAYER_SOV],
      "write seam; auto-capture U5"),
    sym("loseSystemSovereignty", "export", ["sovProjection", PLAYER_SOV],
      "write seam; release (retake)"),
    sym("reinforceSystemHub", "export", ["sovProjection"], "write seam"),
  ]),
  mod("services/sovereignty/sovSystemRules", [
    sym("isSovereigntyClaimableSolarSystem", "export", ["sovProjection"], "claimable filter"),
  ]),
  mod("services/sovereignty/sovStore", [
    sym("readSovereigntyTableUpdatedAt", "export", ["sovReconcile", PLAYER_SOV],
      "cheap change marker; mirror skip"),
  ]),
  mod("services/sovereignty/sovHubPlacement", [
    sym("getDefaultHubPosition", "export", [SOV_PHYSICAL], "TCU position"),
  ]),
  mod("services/contracts/contractRuntimeState", [
    sym("createContract", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS],
      "create want-to-buy; WTS; courier"),
    sym("getContractRecord", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS],
      "read contract; poll"),
    sym("deleteContract", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS],
      "delete contract; expiry"),
    sym("listContractRecords", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS],
      "find contract; replay"),
    sym("completeContract", "export", [FREE_CORPS_COURIERS], "courier fail after the deadline"),
    sym("CONTRACT_STATUS", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS], "statuses",
      { valueType: "object" }),
    sym("TABLE", "export", [CONTRACT_LIST_LIVE], "contract list live read: table name", { valueType: "string" }),
  ]),
  mod("services/contracts/contractNotifications", [
    sym("notifyContractAccepted", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS],
      "wrap; accept fan-out", { wrap: true }),
  ]),
  mod("services/contracts/contractSettlementState", [
    sym("getPendingContractSettlement", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS],
      "pending settlement"),
    sym("listPendingContractSettlements", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS],
      "list pending"),
    sym("findPendingContractSettlement", "export", ["trade"], "find pending"),
  ]),
  mod("services/corporation/corporationAuthority", [
    sym("getPersistedCorporationAuthority", "export", ["trade", TRIG_BRIDGE],
      "EveJS 261028.1 NPC corp contract issuer; trig bridge install role"),
    sym("corporationAuthorityHasRole", "export", [TRIG_BRIDGE], "trig bridge install role (Station Manager)"),
  ]),
  mod("services/corporation/corpWalletState", [
    sym("adjustCorporationWalletDivisionBalanceAsync", "export", ["trade"], "wallet"),
    sym("getCorporationWallet", "export", ["trade"], "read wallet"),
    sym("getCorporationWalletBalance", "export", ["trade"], "Division balance"),
    sym("getCorporationWalletDivision", "export", ["trade"], "Division record"),
  ]),
  mod("services/account/walletState", [
    sym("adjustCharacterBalanceAsync", "export", ["tradeIssuers", LIBERATION_REWARDS, FREE_CORPS_COURIERS],
      "character wallet fund/defund; ISK reward; courier reward"),
    sym("getCharacterWallet", "export", ["tradeIssuers", LIBERATION_REWARDS, FREE_CORPS_COURIERS],
      "character balance; precheck"),
    sym("JOURNAL_ENTRY_TYPE", "export", [SHIP_AI_DB], "wallet_history type labels",
      { valueType: "object" }),
    sym("ACCOUNT_KEY", "export", [SHIP_AI_DB], "wallet_history cash account",
      { valueType: "object" }),
  ]),
  mod("services/account/walletAuthorityProjection", [
    sym("getCharacterProjection", "export", [SHIP_AI_DB], "wallet_history journal"),
  ]),
  mod("services/skills/training/skillQueueState", [
    sym("getCharacterQueueState", "export", [SHIP_AI_DB], "skill_queue"),
  ]),
  mod("services/corporation/lpWalletState", [
    sym("adjustCharacterWalletLPBalanceDurable", "export", [LIBERATION_REWARDS], "LP reward"),
  ]),
  mod("services/corporation/corporationRuntimeState", [
    sym("getCorporationRuntime", "export", ["trade"], "runtime"),
    sym("createCorporationWithRuntime", "export", ["virtualCorps"], "create corporation"),
    sym("updateCorporationRecord", "export", ["virtualCorps", FREE_CORPS_RECYCLE],
      "update corporation record; description of a closed corporation"),
    sym("createAllianceWithRuntime", "export", ["virtualCorps"], "create alliance"),
    sym("updateAllianceRecord", "export", ["virtualCorps"], "update alliance record"),
    sym("ensureCharacterMemberState", "export", ["virtualCorps", FREE_CORPS_RECYCLE],
      "ensure character member state; roster of the target"),
    sym("getCorporationMember", "export", [FREE_CORPS_RECYCLE, FREE_SAGA_LEAN],
      "source roster entry; free saga lean member state of the CEO"),
    sym("updateCorporationRuntime", "export", [FREE_CORPS_RECYCLE], "delete of the source entry"),
    sym("listCorporationMembers", "export", [PLAYER_SIEGE, NOTICES],
      "player siege owner activity (48 h gate); owner siege notices"),
  ]),
  mod("services/corporation/corporationState", [
    sym("getCorporationRecord", "export", ["trade", "virtualCorps", PLAYER_SIEGE, SENTRIES, PLAYER_SOV_NAMES,
      FREE_CORPS_RECYCLE, KILLBOARD_NAMES],
      "issuer; get corporation record; player siege CEO; sentry panel owner name (optional); "
      + "corporation names (mail, panel player-sov); target / description"),
    sym("isNpcCorporationID", "export", [PLAYER_SIEGE, SENTRIES],
      "player siege NPC owner filter; sentry player corporation"),
    sym("getOwnerLookupRecord", "export", [SHIP_AI_DB],
      "own corporation name; NPC owner names"),
    sym("findCorporationByFoundingOperationID", "export", ["virtualCorps"], "idempotent corporation"),
    sym("findAllianceByFoundingOperationID", "export", ["virtualCorps"], "idempotent alliance"),
    sym("getAllianceRecord", "export", ["virtualCorps", PLAYER_SOV_NAMES, KILLBOARD_NAMES],
      "get alliance record; alliance names (mail, panel player-sov); "
      + "alliance names of the killmails"),
    sym("setCharacterAffiliation", "export", ["virtualCorps", FREE_CORPS_RECYCLE],
      "set character affiliation; move of a character"),
    sym("setCorporationAlliance", "export", ["virtualCorps"], "set corporation alliance"),
  ]),
  mod("services/inventory/itemStore", [
    sym("listContainerItems", "export", ["trade", SENTRY_FACTION, FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS,
      SHIP_AI_DB, HARVEST_RAID, TRADE_MARKET_SELL], "hangar; sentry charges of flag 27; "
      + "CEO hangar; cargo / fitting; harvest raid Moon Material Bay; moon/PI sell escrow"),
    sym("consumeInventoryItemQuantityIdempotent", "export", [HARVEST_RAID], "harvest raid take of a Metenox stack"),
    sym("updateInventoryItem", "export", [SENTRY_FACTION, SENTRIES],
      "sentry faction sentry anchored + online; sentry off-scene attrition damage"),
    sym("ITEM_FLAGS", "export", ["trade", SALVAGE, FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS, SHIP_AI_DB, TRIG_BRIDGE,
      TRADE_MARKET_SELL], "flags; HANGAR of wreck items; cargo / drone bay / fleet "
      + "hangar; moon/PI sell escrow HANGAR",
      { valueType: "object" }),
    sym("getItemMetadata", "export", [SALVAGE], "wreck item group/category/volume"),
    sym("listOwnedItems", "export", [SHIP_AI_DB], "assets / find_item"),
    sym("grantItemToOwnerLocationIdempotent", "export", ["tradeSell", SENTRY_FACTION, FREE_CORPS_CONTRACTS,
      FREE_CORPS_COURIERS, SEASON_REWARDS], "contract volume WTS grant; sentry faction sentry + ammo; "
      + "season reward item"),
    sym("getIdempotentGrantReceipt", "export", ["tradeSell", SENTRY_FACTION, FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS,
      HARVEST_RAID, SEASON_REWARDS], "contract volume WTS grant receipt; sentry ammo top-up receipt; harvest "
      + "raid take receipt; season reward item receipt"),
    sym("pruneIdempotentGrantReceipts", "export", [SENTRY_FACTION], "sentry receipt prune"),
    sym("findItemById", "export", [LOYALTY_DOCK, SENTRIES, SENTRY_FACTION, PLAYER_SOV_GATE, CAPSULE_SWEEP,
      SHIP_AI_TOOLS, SHIP_AI_DB, TRIG_BRIDGE, HARVEST_RAID, TRADE_MARKET_SELL],
    "dock gate ship item; sentry sentry item; sentry faction sentry item; "
      + "type of a deployed item; capsule sweep capsule item; "
      + "moon/PI sell escrow stack"),
    sym("listStarbaseItems", "export", [SENTRIES, GRID_ANCHORS], "sentry sentry items; grid POS towers"),
    sym("isCapsuleTypeID", "export", [LOYALTY_DOCK, CAPSULE_SWEEP],
      "dock gate capsule exemption; capsule sweep board out of a capsule"),
    sym("removeInventoryItem", "export", [CAPSULE_SWEEP], "capsule sweep capsule item removal"),
  ]),
  mod("services/inventory/itemCustody", [
    sym("transfer", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS, TRIG_BRIDGE],
      "void stack; return; trig bridge core void"),
    sym("CUSTODY_REASON", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS, TRIG_BRIDGE], "reason",
      { valueType: "object" }),
    sym("getCommittedReceipt", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS, TRIG_BRIDGE],
      "receipt"),
    sym("custodyRef", "export", ["trade", FREE_CORPS_CONTRACTS, FREE_CORPS_COURIERS, TRIG_BRIDGE], "custody ref",
      { valueType: "object" }),
  ]),
  mod("services/inventory/marketItemCustody", [
    sym("transferItem", "export", [TRADE_MARKET_SELL], "moon/PI sell escrow move"),
    sym("getEscrowLocationID", "export", [TRADE_MARKET_SELL], "moon/PI escrow location of an order"),
    sym("MARKET_ESCROW_LOCATION_BASE", "export", [TRADE_MARKET_SELL], "moon/PI escrow band (sweep limit check)",
      { valueType: "number" }),
  ]),
  mod("services/market/marketDaemonClient", [
    sym("marketDaemonClient", "export", ["trade", SHIP_AI_DB], "market daemon; orders",
      { valueType: "object" }),
  ]),
  mod("services/market/marketEscrowState", [
    sym("getEscrowRecord", "export", [TRADE_MARKET], "escrow record"),
    sym("putEscrowRecordDurable", "export", [TRADE_MARKET], "attach escrow"),
    sym("removeEscrowRecordDurable", "export", [TRADE_MARKET], "detach escrow"),
    sym("listEscrowRecords", "export", [TRADE_MARKET], "tagged escrow scan"),
  ]),
  mod("services/market/marketRules", [
    sym("isAllowedDuration", "export", [TRADE_MARKET], "buy order duration"),
    sym("getMarketContext", "export", [FAME_MARKET], "sales tax modifier",
      { firstLoad: true, wrap: true }),
  ]),
  mod("services/_shared/stationStaticData", [
    sym("getStationRecord", "export", [FAME_DOCK], "station faction"),
  ]),
  mod("services/industry/industryPricing", [
    sym("resolveAdjustedAverageTypePrice", "export", ["trade"], "base price"),
  ]),
  mod("services/industry/industryRuntimeState", [
    sym("listJobsByOwner", "export", [SHIP_AI_DB], "industry_jobs"),
  ]),
  mod("services/_shared/identityAllocator", [
    sym("reserveCharacterID", "export", ["virtualCorps"], "reserve character id"),
  ]),
  mod("services/character/characterNameRuntime", [
    sym("getValidRandomName", "export", ["virtualCorps"], "pick random character name"),
    sym("getExistingCharacterNameKeys", "export", ["virtualCorps"], "taken name keys"),
    sym("validateCharacterName", "export", ["virtualCorps"], "vendor name check"),
    sym("VALIDATION_CODE", "export", ["virtualCorps"], "VALID code",
      { valueType: "object" }),
  ]),
  mod("services/character/characterCreationData", [
    sym("resolveCharacterCreationBloodlineProfile", "export", ["virtualCorps"], "bloodline profile"),
  ]),
  mod("services/starbase/starbaseModuleRuntime", [
    ...["startAnchorTransition", "reconcileStarbaseModule", "setOnlineState"]
      .map((name) => sym(name, "export", [SENTRIES], "sentry gate without a tower",
        { wrap: true, firstLoad: true })),
  ]),
  mod("services/starbase/starbaseDefenseRuntime", [
    sym("validateBatteryOperation", "export", [SENTRIES], "sentry shot / revalidation without a tower",
      { wrap: true, firstLoad: true }),
    sym("getBatteryProfile", "export", [SENTRIES, SENTRY_BATTLE],
      "sentry profile in the wrapper; combat profile of a type"),
    sym("hasUnavailableHealth", "export", [SENTRIES], "sentry health in the wrapper"),
    sym("hydrateBatteryActor", "export", [SENTRIES, SENTRY_LOOK],
      "sentry LIVE targeting without a tower; slim look", { wrap: true, firstLoad: true }),
    ...["getBatterySession", "getBatteryModuleView", "stopBattery", "isBatteryManuallyControlled"]
      .map((name) => sym(name, "export", [SENTRIES], "sentry LIVE targeting without a tower")),
  ]),
  mod("services/starbase/starbaseInventoryRuntime", [
    sym("validateBatteryAmmoInventoryAccess", "export", [SENTRIES], "sentry ammo without a tower",
      { wrap: true, firstLoad: true }),
    sym("getBatteryAmmoCapacity", "export", [SENTRY_FACTION], "sentry ammo capacity of a faction sentry"),
  ]),
  mod("services/fitting/liveFittingState", [
    sym("isChargeCompatibleWithModule", "export", [SENTRY_FACTION], "sentry default ammo check"),
    ...["isShipFittingFlag", "isChargeItem", "isFittedModuleItem"]
      .map((name) => sym(name, "export", [SHIP_AI_DB], "fitting")),
    sym("getTypeAttributeMap", "export", [NEMESIS_EWAR], "nemesis EWAR hull attributes"),
  ]),
  mod("services/starbase/starbaseAnchoringPolicy", [
    sym("validateCorporationAuthority", "export", [SENTRIES], "sentry corporation authority (no tower)"),
  ]),
  mod("services/starbase/posGmState", [
    sym("forcePosOnlineState", "export", [SENTRIES], "sentry anchored + online + entity respawn"),
    sym("applyPosDamage", "export", [SENTRIES], "sentry proxy damage of LNE ships (shield/armor/hull/kill)"),
  ]),
  mod("services/dogma/dogmaService", [
    sym("_formatStarbaseModuleUserError", "classPrototypeMethod", [SENTRY_TEXTS], "sentry refusal texts",
      { wrap: true, firstLoad: true }),
  ], { factDir: "services/dogma/dogmaService" }),
  mod("space/transitions", [
    sym("boardSpaceShip", "export", [CAPSULE_SWEEP], "capsule sweep board wrap", { firstLoad: true, wrap: true }),
    sym("ejectSession", "export", [CAPSULE_SWEEP], "capsule sweep hook match (vendor fact)"),
  ]),
  mod("space/destiny/stream/actions", [
    sym("buildRemoveBallsPayload", "export", [CAPSULE_SWEEP], "capsule sweep RemoveBalls resend"),
    sym("buildOnSpecialFXPayload", "export", [HIGHSEC_TRAFFIC], "highsec traffic warping effect on an instant warp"),
    sym("buildSetBallRotationPayload", "export", [HIGHSEC_TRAFFIC], "highsec traffic arrival rotation at a gate"),
  ]),
  mod("contentPacks/autoInstallContentPacks", [
    sym("DROP_DIRECTORY", "export", [BUILD_INPUTS], "build inputs: content pack folder", { valueType: "string" }),
  ]),
  mod("contentPacks/contentPackManager", [
    sym("readRegistry", "export", [BUILD_INPUTS], "build inputs: active packs (informational)"),
  ]),
  mod("services/baseService", [
    sym("callMethod", "classPrototypeMethod", [JOB_BOARD, IN_GAME_MAP_WINDOW],
      "lneBoardSvc base class; lneMapSvc base class"),
  ]),
  ]);

const NOT_PROBED = Object.freeze([
  Object.freeze({ path: "services/mining/miningNpcOperations", name: "getNpcOreCargoItems", status: "INTERNAL",
    reason: "not exported (miningNpcOperations.js:1288); outside MVP" }),
  Object.freeze({ path: "space/modules/salvagerRuntime", name: "buildSalvageRewardEntries", status: "_testing-only",
    reason: "defined :734, exported only in _testing :1710; outside MVP" }),
  Object.freeze({ path: "space/runtime", name: "getLastRuntimeTickSummary", status: "_testing-only",
    reason: "runtime.js:1426,1516; use utils/tidiAutoscaler.observeRuntimeTickSample" }),
  ...["isEntityDirectionalScanCandidate", "canSessionDirectionalScanEntity", "resolveAbyssalScannerRestriction"]
    .map((name) => Object.freeze({ path: "services/exploration/scanMgrService", name, status: "_testing-only",
      reason: "only in ScanMgrService._testing (:3122-3157); the d-scan calls Handle_ConeScan which applies them" })),
  Object.freeze({ path: "lib/world/invasions/invasionsLayer.js", name: "buildInvasionsLayerView", status: "MOD_VIEW",
    reason: "mod view, not a server seam; registered via ctx.views.registerView in index.js" }),
  Object.freeze({ path: "lib/world/invasions/invasionsView.js", name: "buildInvasionsView", status: "MOD_VIEW",
    reason: "mod view, not a server seam; registered via ctx.views.registerView in index.js" }),
]);

module.exports = { GAME_MODULES, NOT_PROBED };
