"use strict";

const { performance } = require("node:perf_hooks");
const { deriveSeed } = require("../util/rng");
const { decideReview } = require("./ai");
const { createDecideThrewLog } = require("./decideThrewLog");
const { strengthOf } = require("./ai/strength");
const { observationOrder, observationFronts, STRANDED_PURPOSE } = require("./ai/housekeeping");
const { REPLENISH_RETURN_PURPOSE } = require("./ai/replenishReturn");
const { GARRISON_RETURN } = require("./ai/patrol");
const { GARRISON_CONSOLIDATE_PURPOSE } = require("./ai/garrison");
const { STRANDED_ROLES, STRANDED_PURPOSE: COMBAT_STRANDED_PURPOSE, STRANDED_REASON } = require("./ai/strandedFleets");
const { RELIEF_ROLES, RELIEF_REASON } = require("./ai/deficitRelief");
const { CAPSULEER_PURSUIT_PURPOSE } = require("./ai/capsuleerPursuit");
const { CAPSULEER_FACTION_ID } = require("./data/capsuleers");
const { parseClaimHoldStates } = require("./ai/claimHold");
const { kindsByType } = require("./ai/supply");
const { FACTION_AGGREGATE, EVENT_STRATEGY_INTENT, MAX_UNPAID_PERIODS } = require("./schema");
const { HULL_VOLUMES, MINERAL_VOLUME, CARRIER_GROUPS, CAPITAL_CARRIER_GROUPS, VOLUME_UNITS_PER_M3 } =
  require("../economy/data/cargoVolumes");
const { getCoreIndex } = require("../world/core");
const { carrierCapacitiesM3 } = require("../economy/logistics/cargo");
const { createIndustryCatalog } = require("../economy/industry/catalog");
const { expansionCandidates, rangeCandidates, isExpansionTarget, pickExpansion } = require("./ai/expansion");
const { bfs } = require("./ai/bfs");
const { ASSAULT_KIND } = require("./ai/structureAssault");
const { HARVEST_RAID_KIND } = require("./ai/harvestRaid");
const { COUNTER_KIND } = require("./ai/invaderCounter");
const { BOSS_RESPONSE_KIND } = require("./ai/bossResponse");
const { parseFactionKindList } = require("./ai/capitalLadder");
const { FACTION_KINDS } = require("./registry");
const { HOLD_STATES: INVASION_HOLD_STATES } = require("../world/invasions/schema");
const { hoardCapOf } = require("./ai/upkeep");
const { borderCandidates, isBorderTarget, borderLineOf } = require("./ai/border");
const { borderPostScanPageOf, MAX_GROUPS_PER_TAKE } = require("./reviewRows");
const { sentryFactionParamsOf } = require("./sentryParams");
const { CAPITAL_ATTACH_ROLES_ALLOWED, CAPITAL_LEVEL_TIER, parseCapitalClassList } = require("./ai/capitalAttach");
const { hullDeltas } = require("../stations/stockKeys");
const { REF_PRICE_MILLI, REF_PRICES_VERSION } = require("../economy/data/mineralRefPrices");
const { MINERALS } = require("../economy/data/mineralYield");
const { HULL_GROUPS, INDUSTRY_HULL_GROUPS, CAPITAL_HULL_GROUPS, parseHullGroupList, parseFleetRoleList } =
  require("../fleets/schema");
const { CLASS_TIERS } = require("../fleets/data/capitalClasses");
const { capitalClassesOf } = require("./data/factionHullClasses");
const { tallyReview, inventoryOf } = require("./capitalUsage");
const { createMiningRates, fleetRatePermille, BOOSTER_ORDER } = require("../economy/mining/rates");
const { paidOf, createHullLedger } = require("./ai/hulls");
const { huntersNeedHullsOf, tributeOnOf, hullsRequiredOf } = require("./ai/production");
const { canMineIn, stationExemptionOf } = require("./ai/miningControl");
const { SIEGE_ROLES } = require("../stations/siege/schema");
const TS = require("../economy/trade/schema");
const { SIDE_SELL } = require("./data/tradeStates");
const { pressureOf, pressureParamsOf } = require("./data/warPricePressure");
const { INVADER_ECONOMY_FACTIONS, INVADER_UNIT_ONLY_FACTIONS } = require("./data/invaderEconomy");
const { invaderRaidAnchorsOf, invaderDoctrineOverlay, invaderEntryFronts } = require("./ai/invaderEconomy");
const { STATION_STATES, DESTROYED_STATION_STATE } = require("../stations/schema");
const { STRUCTURE_DEFENSE } = require("../stations/data/structureDefense");
const { TRIM_EVENT, batchKey: trimBatchKey, doneKey: trimDoneKey } = require("./territoryTrimService");
const TRIM_DONE_EVENT = "STRATEGY_TRIM_DONE";
const { TRIBUTE_PURPOSE, TRIBUTE_MARKER_EVENT, TRIBUTE_FORFEIT_REASONS, tributeMarkerKey } =
  require("../economy/schema");
const LIVE_STATION_STATES = Object.freeze(STATION_STATES.filter((s) => s !== DESTROYED_STATION_STATE));
const { hiveSwarmKey, swarmBucketOf, HIVE_SWARM_MARKER_EVENT } = require("./ai/hiveSwarm");
const { targetHostilityOf } = require("./truce/view");
const { createTransitRiskReader } = require("./transitRiskReader");

const EVENT_TYPE = "FACTION_STRATEGY_REVIEW";
const SCHEDULER_READY = "ready";
const intelKey = (f, s, b) => `strategy:intel:${f}:${s}:${b}`;
const LIVE_FLEET_STATES = Object.freeze(["IDLE", "PLANNED", "TRAVELLING", "STAGED", "ENGAGED", "RETREATING",
  "REFITTING", "MATERIALIZED"]);
const STANDING_STATES = Object.freeze(["IDLE", "PLANNED", "STAGED", "ENGAGED", "REFITTING", "MATERIALIZED"]);
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const STATION_ONLINE = "ONLINE";
const MAX_REASON_LENGTH = 120;
const MAX_PLAN_NOTE_CODES = 16;
const MS_DECIMALS = 100;
const COUNTER_NAMES = Object.freeze(["runs", "skipped", "deferred", "launches", "recon", "attacks", "mobilized",
  "observed", "opsClosed", "opsStuck", "refitRequests", "intentRefused", "frontLimit", "noTarget", "insufficientForce",
  "insufficientResources", "touchRefused", "signalRefused", "signalSkipped", "territoryMarks", "minersMobilized", "mineDispatched",
  "mineRefused", "minersReleased", "produced", "produceRefused", "noHulls", "hullsTaken", "mobilizeLegacy",
  "upkeepCharged", "upkeepUnits", "upkeepIncome", "upkeepUnpaid", "upkeepForgiven", "upkeepAbandoned",
  "upkeepReserveBlocked", "convoysDispatched", "convoyRefused", "logisticsMobilized", "replenished", "replenishHulls",
  "replenishRefused", "borderTargets", "returns", "returnNoBase", "returnNoIdleSince", "inactive",
  "buildsPlanned", "buildRefused",
  "logisticsRetireReturns", "logisticsDisbanded", "logisticsDisbandNoBase", "logisticsDisbandHulls",
  "logisticsDisbandHullsLost", "logisticsRetireRefused",
  "logisticsStrandedReturns", "logisticsStrandedRefused",
  "reliefs",
  "tradeOffers", "tradeCancels", "tradeRefused",
  "coreSkipped",
  "lowsecSkipped",
  "upgrades", "upgradeHulls", "upgradeRefused", "industryJobs",
  "huntersMobilized", "hunterPatrolsLaunched",
  "defenses", "defenseInsufficient", "reclaims", "territoryLimit", "captureNotAdjacent", "lostHomeTruncated",
  "mobilizeFar",
  "upkeepHoardCapped", "raidTargets",
  "raidTargetLaunches",
  "merged", "mergeRefused",
  "garrisonReinforced",
  "garrisonConsolidated",
  "garrisonHullsOutOfReach",
  "garrisonReleased", "garrisonReleaseRefused",
  "patrolsLaunched", "picketsLaunched", "garrisonReturns",
  "minerRaidsLaunched", "minerRaidTargets", "minerRaidReadFailed",
  "minerRaidTooStrong",
  "hiveBroodMobilized",
  "hiveSwarms", "hiveSwarmFleets", "hiveSwarmRefused",
  "capitalAttached", "capitalAttachSkipped",
  "capitalEscort",
  "capitalReplenished",
  "capitalNotAtStation", "ladderWaitBuffer", "ladderSaving",
  "escalatedMobilized", "escalationFallback",
  "capitalLevelGated",
  "escalationLevel0", "escalationLevel1", "escalationLevel2", "escalationLevel3",
  "industryPriorityReviews",
  "warChestShort",
  "borderPostLaunched", "borderPostCapped", "borderPostTooStrong", "borderPostScanRefused",
  "minerEscortLaunched", "minerEscortCapped", "minerEscortTooStrong", "minerEscortIntelTruncated",
  "minerRaidUnescortedFirst",
  "capsuleerPursuits", "capsuleerPursuitTargets", "capsuleerPursuitReadFailed",
  "replenishReturns", "replenishReturnNoStock", "replenishNoStock",
  "sentryBuilds",
  "scoutLimit", "raidFrontLimit",
  "strandedReturns", "strandedDisbanded", "strandedDisbandHulls", "strandedDisbandHullsLost", "strandedRefused",
  "strandedNoBase",
  "homeSpaceUnavailable",
  "mineralSwaps",
  "hqHold", "hqUnheld", "hqReturnPlanned",
  "upkeepDisbanded", "upkeepDisbandShips", "upkeepDisbandHullsLost", "upkeepDisbandRefused", "upgradeDeficit",
  "abandonNoGain",
  "invaderCounterLaunch", "invaderCounterInsufficient",
  "bossResponseLaunch", "bossResponseInsufficient",
  "intrudersSighted", "intruderScanTruncated",
  "unitPurchases", "unitPurchaseUnits", "unitPurchaseIsk", "unitPurchaseRefused",
  "truceActive"]);
const RELIEF_KIND = "defense";
const SENTRY_OWNER_ROLE = "station";
const BLOCKADE_OPERATION_TYPE = "blockade";
const RETIRE_PURPOSE = "LOGISTICS_RETIRE";
const HULLS_LOST_REASONS = Object.freeze(["STOCK_CAP", "STOCK_ITEMS_LIMIT"]);
const CONSTRUCTION_PARAM_KEYS = Object.freeze(["maxBuildsPerReview", "maxSiteCandidates", "minSiteGain",
  "requireKitInStock", "maxOpenBuildsPerFaction", "kitId",
  "targetsGateMax", "overdueMs", "minGapMs", "maxOpenBuildsTotal", "maxLiveStationsTotal",
  "outpostsEnabled", "outpostKinds", "outpostEveryMs", "outpostMaxOpen", "outpostMaxStations", "outpostMaxCandidates",
  "outpostMinBorderNeighbours"]);
const STATION_READY = "ready";
const LOGISTICS_PARAM_KEYS = Object.freeze(["maxFleetsPerFaction", "maxOpenConvoysPerFaction",
  "maxDispatchesPerReview", "maxMobilizationsPerReview", "carrierCapacityM3", "maxCargoItems", "minLoadVolume",
  "factoryRunsTarget", "maxConvoyJumps", "needsHulls", "frontStationMaxJumps", "retireEnabled", "maxRetiresPerReview",
  "capitalCargoPermille", "freighterTargetPerFaction", "jumpFreighterTargetPerFaction", "jumpFreighterReachJumps",
  "maxHullConvoysPerReview", "mineralSurplusThreshold", "maxMineralConvoysPerReview", "mineralConvoyMinLoad",
  "strandedReturnEnabled", "strandedReturnMaxJumps",
  "strandedFromStationsEnabled", "strandedMaxStationBfs",
  "tributeReserveSlot"]);
const LOGISTICS_ROLE = "logistics";
const TRIBUTE_PARAM_KEYS = Object.freeze(["ratePermille", "periodMs", "reserveRuns", "minLoadVolume",
  "recipientMaxMineralUnits", "recipientBuildsHulls", "maxRecipientStations"]);
const PRODUCTION_PARAM_KEYS = Object.freeze(["maxJobsPerReview", "maxRunsPerJob", "maxActiveJobsPerFaction",
  "targetStockFleets", "mobilizeHulls", "miningNeedsHulls", "mobilizationStations",
  "industryEnabled", "maxIndustryJobsPerReview", "maxActiveIndustryJobsPerFaction",
  "minerPriorityEnabled", "minerFloorPermille", "minerReserveRuns",
  "capitalLadderEnabled", "ladderUnlockPermille", "ladderQuotaCarrier", "ladderQuotaDreadnought",
  "ladderQuotaForceAuxiliary", "ladderQuotaSupercarrier", "ladderQuotaTitan", "ladderFactionKinds",
  "supercarrierRecipePermille", "titanRecipePermille", "capitalHighsecAllowed",
  "ladderOverRoomEnabled",
  "poolCapEnabled", "poolCapStations",
  "poolCapReleaseEnabled",
  "ladderBufferPoolCapEnabled"]);
const MINING_PARAM_KEYS = Object.freeze(["maxFleetsPerFaction", "maxFleetsPerSystem", "targetFleetsPerSystemPermille",
  "maxMobilizationsPerReview", "maxDispatchesPerReview", "maxTripJumps", "maxCandidateSystems",
  "distancePenaltyPermille", "avoidHostileIntel", "maxReleasesPerReview",
  "fleetsPerStationPermille", "minersPerFleetBase",
  "ownSpaceScanSystems",
  "ownStationSystemsEnabled",
  "ownStationMinInfluence",
  "stockCoverEnabled", "stockCoverRebuilds", "coveredMaxOpenTrips",
  "candidateIntelEnabled", "candidateIntelMaxSystems", "beltCooldownEnabled"]);
const MINING_ROLE = "mining";
const HUNTER_ROLE = "hunter";
const GARRISON_ROLE = "garrison";
const UPKEEP_PARAM_KEYS = Object.freeze(["periodMs", "maxCatchUpPeriods", "incomePerSystem", "incomePerStation",
  "reservePerStation", "maxReserveUnits", "costPerSystem", "capturedCostPerSystem", "costPerShipPermille",
  "offensiveReservePeriods", "abandonAfterUnpaidPeriods", "maxAbandonsPerReview", "tradeIncomeSharePermille",
  "hoardCapPeriods",
  "homeSpaceIncomeEnabled", "homeSpaceIncomePermille", "shipCapEnabled", "shipCapMarginPermille", "shipCapKinds",
  "shipCapScoutShips",
  "deficitReliefEnabled", "deficitReliefAfterUnpaidPeriods", "deficitReliefMarginPermille", "maxDisbandsPerReview",
  "iskTopUpEnabled", "iskPerUnit", "iskTopUpMaxUnitsPerPeriod", "iskTopUpKinds", "iskTopUpFloorPermille",
  "iskTopUpHeadroomPeriods", "iskTopUpRoomSharePermille"]);
const TREASURY_PARAM_KEYS = Object.freeze(["periodMs", "maxCatchUpPeriods", "initialIskEmpire", "initialIskPolice",
  "initialIskPirate", "initialIskInvader", "initialIskNeutral", "baseIncomeIskPerDayEmpire", "baseIncomeIskPerDayPolice",
  "baseIncomeIskPerDayPirate", "baseIncomeIskPerDayInvader", "baseIncomeIskPerDayNeutral", "incomeIskPerSystemPerDay",
  "incomeIskPerStationPerDay", "fleetUpkeepPermillePerDay", "tradeBudgetTargetIsk", "tradeTransferMaxIskPerDay",
  "tradeTransferMaxIskPerDayGalaxy", "dayRetentionDays", "pruneBatch",
  "productionFeePermille", "austerityEnterPermille", "austerityExitPermille", "austerityJobsPermille",
  "minJobsWhenBroke",
  "pressureEnabled", "adminIskPerCapturedSystemPerDay", "adminSprawlSystems", "savingsDrawPermillePerDay",
  "captureLaunchIsk", "mobilizeFitPermille", "productionRoomSharePermille", "lossesInRoomPermille",
  "warRoomRollingEnabled"]);
const INVADER_ECONOMY_PARAM_KEYS = Object.freeze(["baseIncomeIskPerDay", "iskPerHomeSystemPerDay",
  "unitsPerHomeSystemPerPeriod"]);
const METRIC_TRIGLAVIAN_YIELD_ISK = "strategy.invaderEconomy.triglavian.yieldIsk";
const METRIC_TRIGLAVIAN_YIELD_UNITS = "strategy.invaderEconomy.triglavian.yieldUnits";
const METRIC_DEATHLESS_YIELD_ISK = "strategy.invaderEconomy.deathless.yieldIsk";
const METRIC_DEATHLESS_YIELD_UNITS = "strategy.invaderEconomy.deathless.yieldUnits";
const INVADER_YIELD_METRICS = Object.freeze({
  triglavian: [METRIC_TRIGLAVIAN_YIELD_ISK, METRIC_TRIGLAVIAN_YIELD_UNITS],
  deathless: [METRIC_DEATHLESS_YIELD_ISK, METRIC_DEATHLESS_YIELD_UNITS] });
const LOWSEC_PARAM_KEYS = Object.freeze({ lowsecCaptureEnabled: "captureEnabled" });
const LOWSEC = "lowsec";
const PLAYER_SOV_PARAM_KEYS = Object.freeze(["targetPremium", "maxSiegesPerFaction"]);

function playerSovParamsOf(config) {
  const C = config.playerSov;
  return C && C.enabled === true ? Object.freeze(Object.fromEntries(PLAYER_SOV_PARAM_KEYS.map((k) => [k, C[k]])))
    : null;
}

const PLAYER_VALUE_PARAM_KEYS = Object.freeze(["unclaimedPermille", "valueCap"]);

function playerValueParamsOf(config) {
  const C = config.playerValue;
  return C && C.enabled === true ? Object.freeze(Object.fromEntries(PLAYER_VALUE_PARAM_KEYS.map((k) => [k, C[k]])))
    : null;
}

function lowsecIdsOf(input) {
  const out = new Set();
  if (input.captureEnabled === true) return out;
  for (const id of [...input.theatre, ...input.expansion, ...input.borderCandidates]) {
    const v = input.getSystem(id);
    if (v && v.secClass === LOWSEC) out.add(id);
  }
  return out;
}

const OUTPOST_SEC_CLASS = "nullsec";
const OUTPOSTS_OFF = Object.freeze({ mode: "off", sites: Object.freeze([]) });
const OUTPOSTS_WAIT = Object.freeze({ mode: "wait", sites: Object.freeze([]) });
const outpostKindsOf = (v) => (Array.isArray(v) ? v
  : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter((x) => x.length > 0) : []);

function readOutpostSites(db, input) {
  const { C, entry, doctrine, graph, repository } = input;
  if (!C || C.outpostsEnabled !== true || !entry || !outpostKindsOf(C.outpostKinds).includes(entry.kind)
    || !doctrine || (doctrine.canOccupy === true && doctrine.expandsBeyondTheatre === true)
    || doctrine.buildsStations === false || !repository || typeof repository.countLiveBySystem !== "function") {
    return { ok: true, outposts: OUTPOSTS_OFF };
  }
  const since = input.sinceLastBuildMs;
  if (since !== null && since !== undefined && since < C.outpostEveryMs) return { ok: true, outposts: OUTPOSTS_WAIT };
  const territory = Array.isArray(input.territory) ? input.territory : [];
  const own = new Set(territory.map((x) => x.systemId));
  const stationSystems = new Set((input.stations || []).map((s) => s.systemId));
  const building = new Set((input.open || []).map((b) => b.systemId));
  const safe = (fn, fallback) => {
    try { return fn(); } catch (_) { return fallback; }
  };
  const isNull = (id) => {
    const v = safe(() => graph.getSystem(id), null);
    return Boolean(v) && v.secClass === OUTPOST_SEC_CLASS;
  };
  const candidates = [];
  for (const { systemId } of territory) {
    if (stationSystems.has(systemId) || building.has(systemId) || !isNull(systemId)) continue;
    let borderNeighbours = 0;
    for (const n of safe(() => graph.getNeighbors(systemId), null) || []) if (!own.has(n) && isNull(n)) borderNeighbours += 1;
    if (borderNeighbours >= C.outpostMinBorderNeighbours) candidates.push({ systemId, borderNeighbours });
  }
  candidates.sort((a, b) => b.borderNeighbours - a.borderNeighbours || a.systemId - b.systemId);
  const picked = candidates.slice(0, C.outpostMaxCandidates);
  if (picked.length === 0) return { ok: true, outposts: { mode: "ready", sites: [] } };
  const c = repository.countLiveBySystem(db, picked.map((x) => x.systemId));
  if (!c || c.ok !== true) return c || { ok: false, reason: "STATIONS_READ_FAILED" };
  const live = new Map();
  const ownLive = new Map();
  for (const x of c.rows) {
    live.set(x.systemId, (live.get(x.systemId) || 0) + x.count);
    if (x.factionId === input.factionId) ownLive.set(x.systemId, (ownLive.get(x.systemId) || 0) + x.count);
  }
  return { ok: true, outposts: { mode: "ready", sites: picked.map((x) => ({ ...x,
    liveStations: live.get(x.systemId) || 0, ownLiveStations: ownLive.get(x.systemId) || 0 })) } };
}
const PERMILLE = 1000;

function garrisonEstimateOf(config) {
  const S = config.strategy || {};
  const B = config.battle;
  const dps = B ? Number(B.resolverGarrisonDpsPerPoint) : 0;
  const ehp = B ? Number(B.resolverGarrisonEhpPerPoint) : 0;
  return Object.freeze({ mode: S.garrisonEstimate === "resolver" ? "resolver" : "legacy",
    powerPerPoint: dps > 0 && ehp > 0 ? Math.sqrt(dps * ehp) : 0,
    stationPoints: config.siege && config.siege.enabled === true && config.siege.stationGarrisonEnabled === true
      ? STRUCTURE_DEFENSE.npc.garrisonPoints : 0,
    influencePoints: !(B && B.influenceGarrison === "off") });
}
function warIskOf(i) {
  return i && Number.isSafeInteger(i.warIsk) && i.warIsk > 0 ? i.warIsk : 0;
}
const WAR_CHEST_NOTES = Object.freeze(["WAR_CHEST_SHORT", "HUNT_WAR_CHEST_SHORT"]);
const NOTE_COUNTERS = Object.freeze({ FRONT_LIMIT: "frontLimit", INSUFFICIENT_FORCE: "insufficientForce",
  INSUFFICIENT_RESOURCES: "insufficientResources", RETURN_NO_BASE: "returnNoBase",
  RETURN_NO_IDLE_SINCE: "returnNoIdleSince", INACTIVE: "inactive", MOBILIZE_FAR: "mobilizeFar",
  INDUSTRY_PRIORITY: "industryPriorityReviews",
  GARRISON_HULLS_OUT_OF_REACH: "garrisonHullsOutOfReach",
  REPLENISH_NO_STOCK: "replenishNoStock", REPLENISH_NO_STOCK_LOCAL: "replenishNoStock",
  REPLENISH_RETURN_NO_STOCK: "replenishReturnNoStock",
  SCOUT_LIMIT: "scoutLimit", RAID_FRONT_LIMIT: "raidFrontLimit",
  STRANDED_NO_BASE: "strandedNoBase",
  HQ_HOLD: "hqHold", HQ_UNHELD: "hqUnheld",
  UPGRADE_DEFICIT: "upgradeDeficit", UPKEEP_ABANDON_NO_GAIN: "abandonNoGain" });
function isNoHullsNote(note) {
  return note === "NO_HULLS" || note.startsWith("NO_HULLS:");
}
const PARAM_KEYS = Object.freeze(["maxReachJumps", "supplyChainJumps", "captureRangeFromStationJumps",
  "maxAssemblyJumps", "maxBfsSystems",
  "mobilizeFallbackJumps", "mobilizeFallbackMaxSystems", "maxTargetCandidates", "targetPickTopK", "maxOperationsPerReview",
  "maxFleetsPerOperation", "maxFleetsPerFaction", "maxMobilizationsPerReview", "mobilizeResourcePerShip",
  "mobilizeReservePerShip", "attackStrengthRatio", "intelTtlMs", "maxObservationsPerReview", "reconWindowMs",
  "attackWindowMs", "operationGraceMs", "maxHousekeepingPerReview", "maxRefitRequestsPerReview",
  "maxTerritoryMarksPerReview", "reclaimMinInfluence",
  "returnAfterIdleMs", "returnWindowMs", "maxReturnsPerReview",
  "hunt.enabled", "hunt.maxHuntersPerFaction", "hunt.strikeMaxJumps", "hunt.dwellMs",
  "maxCapturedSystemsPerFaction", "captureRequiresAdjacency", "defenseEnabled", "maxDefensePerReview",
  "maxThreatsRead", "maxLostHomeRead",
  "coreRaidsAllowed",
  "battleIntelTtlMs",
  "expansionRaidsEnabled", "maxRaidScanSystems", "maxRaidTargets",
  "raidTargetPreference",
  "reconUnblockEnabled", "maxScoutsPerFaction", "raidFrontLimitEnabled", "maxRaidFronts", "hostilePremiumCaptureOnly"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const borderPostSecClassesOf = (S) => Object.freeze(String(S.borderPostSecClasses || "").split(",")
  .map((x) => x.trim()).filter((x) => x !== ""));
const minerEscortSecClassesOf = (S) => Object.freeze(String(S.minerEscortSecClasses || "").split(",")
  .map((x) => x.trim()).filter((x) => x !== ""));
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_REASON_LENGTH);

function industryParamsOf(config) {
  const PR = config.production;
  const M = config.mining;
  if (!PR || !M) return null;
  const rates = createMiningRates(M);
  const free = parseHullGroupList(PR.freeHullGroups) || [];
  const minerOrder = HULL_GROUPS.filter((g) => rates.rateOf(g) > 0 && !BOOSTER_ORDER.includes(g) && !free.includes(g))
    .sort((a, b) => rates.rateOf(b) - rates.rateOf(a) || HULL_GROUPS.indexOf(a) - HULL_GROUPS.indexOf(b));
  const S = config.strategy || {};
  return Object.freeze({
    industryEnabled: PR.industryEnabled === true, maxIndustryJobsPerReview: PR.maxIndustryJobsPerReview,
    maxActiveIndustryJobsPerFaction: PR.maxActiveIndustryJobsPerFaction,
    maxUpgradesPerReview: S.maxUpgradesPerReview, minersPerFleetBase: M.minersPerFleetBase,
    boosterOrder: BOOSTER_ORDER,
    boostedMiners: Object.freeze({ porpoise: M.boostedMinersPorpoise, orca: M.boostedMinersOrca,
      rorqual: M.boostedMinersRorqual }),
    minerOrder: Object.freeze(minerOrder),
    freeMiner: free.find((g) => rates.rateOf(g) > 0) || null,
    miningGroups: Object.freeze([...BOOSTER_ORDER, ...minerOrder].filter((g) => !free.includes(g))),
    industryGroups: Object.freeze(INDUSTRY_HULL_GROUPS.filter((g) => !free.includes(g))),
    hullGroups: HULL_GROUPS,
    maxShipsPerFleet: config.fleets ? config.fleets.maxShipsPerFleet : Number.MAX_SAFE_INTEGER,
    fleetRate: (composition) => fleetRatePermille(composition, rates).sum,
    transport: logisticsOn(config) ? Object.freeze({
      freighterTargetPerFaction: config.logistics.freighterTargetPerFaction,
      jumpFreighterTargetPerFaction: config.logistics.jumpFreighterTargetPerFaction }) : null,
  });
}

function replenishReturnParamsOf(config) {
  const L = config.logistics;
  if (!L || L.enabled !== true || L.replenishEnabled !== true || L.replenishReturnEnabled !== true) return null;
  return Object.freeze({ maxJumps: L.replenishReturnMaxJumps, minMissingPermille: L.replenishReturnMinMissingPermille,
    maxPerReview: L.maxReplenishReturnsPerReview, maxSearches: L.replenishReturnMaxSearchesPerReview });
}

function logisticsOn(config) {
  return Boolean(config.logistics && config.logistics.enabled === true && config.logistics.convoysEnabled === true);
}

function logisticsParamsOf(config, catalog) {
  return Object.freeze({ ...Object.fromEntries(
    LOGISTICS_PARAM_KEYS.map((k) => [k, config.logistics[k]])), volumes: Object.freeze({ mineral: MINERAL_VOLUME,
    hulls: HULL_VOLUMES, carrierGroups: CARRIER_GROUPS, unitsPerM3: VOLUME_UNITS_PER_M3,
    capacityM3: carrierCapacitiesM3(config.logistics, catalog),
    capitalCarrierGroups: CAPITAL_CARRIER_GROUPS }) });
}

function withSecClass(production, graph) {
  if (!production || !Array.isArray(production.stations) || production.stations.length === 0) return production;
  const secClassOf = (id) => call(() => {
    const v = graph.getSystem(id);
    return v && typeof v.secClass === "string" ? v.secClass : null;
  }, null);
  return { ...production, stations: production.stations.map((s) => ({ ...s, secClass: secClassOf(s.systemId) })) };
}

function invaderEconomyParamsOf(config, factionId, hqSystemId = null) {
  const C = config.invaderEconomy;
  if (C && C.enabled === true && C.sleepersEnabled === true && C.sleepers
    && Object.prototype.hasOwnProperty.call(INVADER_UNIT_ONLY_FACTIONS, factionId)) {
    return Object.freeze({ baseIncomeIskPerDay: 0, iskPerHomeSystemPerDay: 0, unitsPerHomeSystemPerPeriod: 0,
      baseUnitsPerPeriod: C[INVADER_UNIT_ONLY_FACTIONS[factionId]].baseUnitsPerPeriod });
  }
  const prefix = Object.prototype.hasOwnProperty.call(INVADER_ECONOMY_FACTIONS, factionId)
    ? INVADER_ECONOMY_FACTIONS[factionId] : null;
  if (!C || C.enabled !== true || prefix === null || !C[prefix]) return null;
  const E = Object.fromEntries(INVADER_ECONOMY_PARAM_KEYS.map((k) => [k, C[prefix][k]]));
  if (C.homePoolEnabled === true) {
    E.homePool = Object.freeze({ maxFleets: C[prefix].homeFleetsMax,
      mobilizationsPerReview: C[prefix].homeMobilizationsPerReview, hqSystemId });
  }
  if (C.raidsEnabled === true && C[prefix].maxRaidFronts > 0) {
    E.raids = Object.freeze({ maxActiveFronts: C[prefix].maxActiveFronts, maxRaidFronts: C[prefix].maxRaidFronts });
  }
  return Object.freeze(E);
}

function invaderFactionParamsOf(params, E) {
  if (!E) return params;
  return Object.freeze({ ...params, invaderEconomy: E,
    ...(E.raids ? { raidFrontLimitEnabled: true, maxRaidFronts: E.raids.maxRaidFronts } : {}) });
}

function treasuryParamsOf(config) {
  return config.treasury && config.treasury.enabled === true && config.modules && config.modules.strategy
    && config.modules.strategy.enabled === true
    ? Object.freeze(Object.fromEntries(TREASURY_PARAM_KEYS.map((k) => [k, config.treasury[k]]))) : null;
}

const MINERAL_SWAP_PARAM_KEYS = Object.freeze(["maxPerReview", "spreadPermille", "sourceKeepPermille",
  "minSourceUnits", "maxIskPerReview"]);
const MINERAL_KEYS = Object.freeze(Object.keys(MINERALS).map((id) => `type:${id}`));
const MINERAL_NAMES = Object.freeze(Object.fromEntries(Object.keys(MINERALS).map((id) => [`type:${id}`,
  MINERALS[id]])));

function mineralSwapParamsOf(config) {
  const ms = config.mineralSwap;
  if (!ms || ms.enabled !== true || !config.production || config.production.enabled !== true) return null;
  return Object.freeze({ ...Object.fromEntries(MINERAL_SWAP_PARAM_KEYS.map((k) => [k, ms[k]])),
    pricesMilli: REF_PRICE_MILLI, priceVersion: REF_PRICES_VERSION, mineralNames: MINERAL_NAMES });
}

function capitalAttachParamsOf(config) {
  const S = config.strategy || {};
  if (S.capitalAttachEnabled !== true) return null;
  const roles = (parseFleetRoleList(S.capitalAttachRoles) || []).filter((r) => CAPITAL_ATTACH_ROLES_ALLOWED.includes(r));
  return Object.freeze({ roles: Object.freeze(roles),
    order: Object.freeze(parseCapitalClassList(S.capitalAttachOrder, CAPITAL_HULL_GROUPS) || []),
    max: Number.isSafeInteger(S.capitalAttachMax) ? S.capitalAttachMax : 0,
    maxGroups: MAX_GROUPS_PER_TAKE,
    maxEntries: config.fleets && Number.isSafeInteger(config.fleets.maxCompositionEntries)
      ? config.fleets.maxCompositionEntries : 0,
    maxShips: config.fleets && Number.isSafeInteger(config.fleets.maxShipsPerFleet)
      ? config.fleets.maxShipsPerFleet : 0,
    freeGroups: Object.freeze(config.production ? parseHullGroupList(config.production.freeHullGroups) || [] : []),
    preferStation: S.capitalPreferStationEnabled === true,
    ...(S.escalationEnabled === true ? { minLevelOf: Object.freeze(Object.fromEntries(
      Object.entries(CAPITAL_LEVEL_TIER).map(([cls, tier]) => [cls,
        tier === 1 ? S.escalationCapitalMinLevel : S.escalationSuperMinLevel]))) } : {}) });
}

function capitalEscortParamsOf(config) {
  const S = config.strategy || {};
  if (S.capitalEscortEnabled !== true || S.capitalAttachEnabled !== true) return null;
  return Object.freeze({ maxJumps: S.capitalEscortMaxJumps, maxBfsSystems: S.maxBfsSystems });
}

function capitalReplenishParamsOf(config) {
  const S = config.strategy || {};
  const L = config.logistics || {};
  if (S.capitalReplenishEnabled !== true || !capitalAttachParamsOf(config) || L.enabled !== true
    || L.replenishEnabled !== true) return null;
  return Object.freeze({ maxPerReview: S.capitalReplenishMaxPerReview });
}

function escalationParamsOf(config) {
  const S = config.strategy || {};
  if (S.escalationEnabled !== true) return null;
  return Object.freeze({ fleetsL1: S.escalationFleetsL1, fleetsL2: S.escalationFleetsL2,
    fleetsL3: S.escalationFleetsL3, valueBonus: S.escalationValueBonus, lossStep: S.escalationLossStep,
    maxLevel: S.escalationMaxLevel });
}

function capitalLevelParamsOf(config) {
  const S = config.strategy || {};
  if (S.capitalPostLevelEnabled !== true || S.escalationEnabled !== true) return null;
  return Object.freeze({ homeBonus: S.capitalHomeLevelBonus,
    huntMaxLevel: Math.max(0, S.escalationSuperMinLevel - 1) });
}

function fleetCompositionOf(mob) {
  return mob.composition.map((e) => (Number.isSafeInteger(e.typeId) && e.typeId > 0
    ? { hullGroup: e.hullGroup, typeId: e.typeId, count: e.count } : { hullGroup: e.hullGroup, count: e.count }));
}

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function readDevLevels(C, getDevIndices, f, ctx) {
  if (!C || !C.dev || typeof getDevIndices !== "function") return null;
  const dev = call(() => getDevIndices(), null);
  if (!dev || typeof dev.levelsOf !== "function") return null;
  const withStation = new Set((ctx.stations || []).map((s) => s.systemId));
  const map = new Map();
  for (const s of ctx.systems || []) {
    if (s.controllerFactionId !== f || withStation.has(s.systemId)) continue;
    const lv = call(() => dev.levelsOf(s.systemId), null);
    if (lv) map.set(s.systemId, { ind: lv.ind, trade: lv.trade });
  }
  return map.size > 0 ? map : null;
}

function ownInfluenceOf(sys, factionId, at, effectiveScoreOf) {
  const mine = Array.isArray(sys.influence) ? sys.influence.find((x) => x.factionId === factionId) : null;
  if (!mine || !Number.isFinite(mine.influenceScore)) return 0;
  if (typeof effectiveScoreOf !== "function") return Math.floor(mine.influenceScore);
  const v = call(() => effectiveScoreOf(sys, factionId, at), null);
  return Number.isFinite(v) ? Math.floor(v) : Math.floor(mine.influenceScore);
}

const INTRUDER_SKIP_STATES = Object.freeze(["CONTESTED", "INVASION"]);
const READY_MODE = "ready";

function readIntrudersOf(db, spec) {
  if (!spec || spec.enabled !== true) return { ok: true, intruders: null };
  const f = spec.factionId;
  const heldHere = (id) => {
    const w = spec.rows.get(id);
    return Boolean(w) && w.controllerFactionId === f && !INTRUDER_SKIP_STATES.includes(w.occupationState);
  };
  const home = isId(spec.homeSystemId) ? spec.homeSystemId : null;
  const stationIds = [...new Set((spec.stationSystemIds || []).filter((id) => isId(id) && id !== home))]
    .sort((a, b) => a - b);
  const first = new Set([...(home === null ? [] : [home]), ...stationIds]);
  const hostileIds = spec.hostileStations instanceof Map ? [...spec.hostileStations.entries()]
    .filter(([id, n]) => isId(id) && n > 0 && !first.has(id)).map(([id]) => id).sort((a, b) => a - b) : [];
  const ids = [...first, ...hostileIds].filter(heldHere)
    .slice(0, Math.max(0, spec.maxSystems));
  if (ids.length === 0) return { ok: true, intruders: { mode: READY_MODE, truncated: false, items: [] } };
  const repo = spec.repository;
  if (!repo || typeof repo.listFleetsInSystems !== "function") {
    return { ok: false, reason: "FLEETS_BATCH_UNAVAILABLE" };
  }
  const batch = repo.listFleetsInSystems(db, ids, { limitPerSystem: spec.limitPerSystem, states: STANDING_STATES });
  if (!batch || !batch.ok) return batch || { ok: false, reason: "FLEETS_READ_FAILED" };
  let truncated = false;
  const items = [];
  for (const id of ids) {
    const list = (batch.bySystem && batch.bySystem.get(id)) || [];
    if (list.length >= spec.limitPerSystem) truncated = true;
    let hostileFleets = 0;
    let hostileStrength = 0;
    const factionIds = new Set();
    for (const x of list) {
      if (!spec.isHostile(x.factionId)) continue;
      hostileFleets += 1;
      hostileStrength += strengthOf(x.composition, spec.powerTable);
      factionIds.add(x.factionId);
    }
    if (hostileFleets > 0) {
      items.push({ systemId: id, hostileStrength, hostileFleets, factionIds: [...factionIds].sort((a, b) => a - b) });
    }
  }
  return { ok: true, intruders: { mode: READY_MODE, truncated, items } };
}

function replaceForfeited(notes, n) {
  const list = Array.isArray(notes) ? notes : [];
  const count = Number.isSafeInteger(n) && n > 0 ? n : 0;
  if (count === 0) return [...list];
  let left = count;
  const out = [];
  for (const note of list) {
    if (left > 0 && note === "TRIBUTE_DISPATCHED") { left -= 1; continue; }
    out.push(note);
  }
  for (let i = 0; i < count; i += 1) out.push("TRIBUTE_FORFEITED");
  return out;
}

function playerSiegeParamsOf(config, groups) {
  const C = config.playerSiege;
  if (!C || C.enabled !== true) return null;
  return Object.freeze({ fleetRoles: SIEGE_ROLES, maxDispatchPerReview: C.maxDispatchPerReview,
    dispatchMaxJumps: C.dispatchMaxJumps, dispatchDpsMargin: C.dispatchDpsMargin,
    liveWindowMs: C.maxWaitRounds * C.recheckMs + C.stepLostBufferMs,
    groups: groups && typeof groups === "object" ? groups : Object.freeze({}) });
}

const INVADER_COUNTER_PARAM_KEYS = Object.freeze(["maxPerReview", "rangeJumps", "maxBeachheadsRead",
  "holderReadLimit"]);
const INVADER_COUNTER_DEFAULT_KINDS = Object.freeze(["empire"]);

function invaderCounterParamsOf(config) {
  const C = config.strategy && config.strategy.invaderCounter;
  if (!C || C.enabled !== true) return null;
  const out = Object.fromEntries(INVADER_COUNTER_PARAM_KEYS.map((k) => [k, C[k]]));
  if (config.graph && Number.isSafeInteger(config.graph.routeMaxJumps)) {
    out.rangeJumps = Math.min(out.rangeJumps, config.graph.routeMaxJumps);
  }
  const kinds = parseFactionKindList(C.kinds, FACTION_KINDS);
  out.kinds = Object.freeze(kinds && kinds.length > 0 ? [...kinds] : [...INVADER_COUNTER_DEFAULT_KINDS]);
  return Object.freeze(out);
}

const WORLD_BOSS_RESPONSE_PARAM_KEYS = Object.freeze(["maxPerReview", "rangeJumps", "strengthPermille", "windowMs",
  "maxTargetsRead", "minLeadMs"]);
const WORLD_BOSS_RESPONSE_DEFAULT_KINDS = Object.freeze(["empire", "pirate"]);

function worldBossResponseParamsOf(config) {
  const W = config.worldBosses;
  const C = W && W.response;
  if (!W || W.enabled !== true || !W.clash || W.clash.enabled !== true || !C || C.enabled !== true) return null;
  const out = Object.fromEntries(WORLD_BOSS_RESPONSE_PARAM_KEYS.map((k) => [k, C[k]]));
  if (config.graph && Number.isSafeInteger(config.graph.routeMaxJumps)) {
    out.rangeJumps = Math.min(out.rangeJumps, config.graph.routeMaxJumps);
  }
  const kinds = parseFactionKindList(C.kinds, FACTION_KINDS);
  out.kinds = Object.freeze(kinds && kinds.length > 0 ? [...kinds] : [...WORLD_BOSS_RESPONSE_DEFAULT_KINDS]);
  return Object.freeze(out);
}

const HARVEST_RAID_DEFAULT_KINDS = Object.freeze(["pirate"]);

function harvestRaidParamsOf(config) {
  const C = config.harvestRaid;
  if (!C || C.enabled !== true) return null;
  const kinds = parseFactionKindList(C.factionKinds, FACTION_KINDS);
  return Object.freeze({
    factionKinds: Object.freeze(kinds && kinds.length > 0 ? [...kinds] : [...HARVEST_RAID_DEFAULT_KINDS]),
    maxDispatchPerReview: C.maxDispatchPerReview, dispatchMaxJumps: C.dispatchMaxJumps,
    maxTargetsReadPerReview: C.maxTargetsReadPerReview });
}

function createReviewService(deps) {
  const { store, journal, strategyRepository, intelRepository, registry, kinds, scheduler, fleets, clock,
    worldSeed, config, getVirtualCorps } = deps;
  const S = config.strategy;
  const reconLossOn = S.reconLossEnabled === true && Boolean(deps.reconLossRepository)
    && typeof deps.reconLossRepository.listCooldowns === "function";
  const playerActivityOn = S.playerActivityEnabled === true && Boolean(deps.playerActivityRepository)
    && typeof deps.playerActivityRepository.listActive === "function";
  const attackLossOn = S.attackLossMemoryEnabled === true && Boolean(deps.attackLossRepository)
    && typeof deps.attackLossRepository.listActive === "function";
  const truceOn = S.truceEnabled === true && Boolean(deps.truceRepository)
    && typeof deps.truceRepository.listTrucedInDb === "function";
  const TZ = config.transit;
  const transitGateOn = Boolean(TZ) && TZ.enabled === true && TZ.mode === "on" && TZ.aiGateEnabled === true
    && typeof deps.getTransit === "function";
  const neighborFns = new WeakMap();
  const neighborsFor = (graph) => {
    let fn = neighborFns.get(graph);
    if (!fn) {
      fn = (id) => graph.getNeighbors(id);
      fn.bfsMemo = new Map();
      fn.bfsMemoMax = Number.isSafeInteger(S.bfsMemoMaxEntries) ? S.bfsMemoMaxEntries : 0;
      fn.bfsMemoMaxSystems = Number.isSafeInteger(S.bfsMemoMaxSystems) ? S.bfsMemoMaxSystems : 0;
      neighborFns.set(graph, fn);
    }
    return fn;
  };
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const hooks = deps.hooks || {};
  const virtualCorpFor = getVirtualCorps && typeof getVirtualCorps === "function"
    ? (f, role) => {
        const vc = getVirtualCorps();
        return vc && typeof vc.corporationForRole === "function" ? vc.corporationForRole(f, role) : null;
      }
    : () => null;
  const I = S.reviewIntervalMs;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const memory = new Map();
  const capitalUsage = new Map();
  const borderMemory = new Map();
  const lostHomeCursor = new Map();
  let lastRefusal = null;
  let bootstrapped = { enqueued: 0, duplicates: 0, reason: null };
  let stopped = false;
  let seq = 0;

  function carrierCatalog() {
    if (deps.industryCatalog) return deps.industryCatalog;
    const made = call(() => createIndustryCatalog(), { ok: false, reason: "THREW", detail: "" });
    if (made && made.ok) return made.catalog;
    try {
      logger.log(`strategy: industry catalog unavailable (${made && made.reason}: ${made && made.detail}) - `
        + "capital carriers carry nothing in the AI");
    } catch (_err) {
    }
    return null;
  }

  function hivePatrolStrength() {
    return call(() => {
      for (const fa of registry.listActiveFactions()) {
        const d = fa.doctrineId ? registry.getDoctrine(fa.doctrineId) : null;
        if (!d || d.hive !== true) continue;
        const template = d.templates && d.templates.patrol;
        if (!Array.isArray(template) || template.length === 0) return 0;
        const s = strengthOf(template.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count })),
          deps.powerTable);
        return Number.isFinite(s) && s > 0 ? s : 0;
      }
      return 0;
    }, 0);
  }

  const params = Object.freeze({
    ...Object.fromEntries(PARAM_KEYS.map((k) => [k, S[k]])),
    ...Object.fromEntries(Object.entries(LOWSEC_PARAM_KEYS).map(([p, k]) => [p,
      config.lowsec ? config.lowsec[k] : undefined])),
    kinds: kinds.list,
    scoring: deps.scoring,
    powerTable: deps.powerTable,
    frontLimitCap: config.limits.maxActiveFrontsPerFaction,
    routeMaxJumps: config.graph.routeMaxJumps,
    mining: config.mining ? Object.freeze(Object.fromEntries(MINING_PARAM_KEYS.map((k) => [k, config.mining[k]])))
      : null,
    production: config.production ? Object.freeze({ ...Object.fromEntries(PRODUCTION_PARAM_KEYS
      .map((k) => [k, config.production[k]])), hullGroups: HULL_GROUPS,
    freeHullGroups: Object.freeze(parseHullGroupList(config.production.freeHullGroups) || []),
    logisticsNeedsHulls: Boolean(config.logistics && config.logistics.needsHulls === true),
    huntersNeedHulls: huntersNeedHullsOf(config),
    capitalTiers: CLASS_TIERS }) : null,
    mineralSwap: mineralSwapParamsOf(config),
    capitalAttach: capitalAttachParamsOf(config),
    capitalEscort: capitalEscortParamsOf(config),
    escalation: escalationParamsOf(config),
    capitalLevel: capitalLevelParamsOf(config),
    logistics: logisticsOn(config) ? logisticsParamsOf(config, carrierCatalog()) : null,
    tribute: tributeOnOf(config)
      ? Object.freeze(Object.fromEntries(TRIBUTE_PARAM_KEYS.map((k) => [k, config.tribute[k]]))) : null,
    replenish: config.logistics && config.logistics.enabled === true && config.logistics.replenishEnabled === true
      ? Object.freeze({ maxReplenishPerReview: config.logistics.maxReplenishPerReview,
        maxShipsPerFleet: config.fleets ? config.fleets.maxShipsPerFleet : Number.MAX_SAFE_INTEGER,
        ...(config.logistics.replenishFreeHullsEnabled === true ? { freeHulls: true } : {}) }) : null,
    capitalReplenish: capitalReplenishParamsOf(config),
    replenishReturn: replenishReturnParamsOf(config),
    upkeep: config.upkeep && config.upkeep.enabled === true ? Object.freeze({ ...Object.fromEntries(UPKEEP_PARAM_KEYS
      .map((k) => [k, config.upkeep[k]])), maxResourceUnits: strategyRepository.limits.maxResourceUnits,
    maxUnpaidPeriods: MAX_UNPAID_PERIODS }) : null,
    treasury: treasuryParamsOf(config),
    claimFrontGraceMs: config.occupation ? config.occupation.claimFrontGraceMs : 0,
    construction: config.construction && config.construction.enabled === true && config.stations
      ? Object.freeze({ ...Object.fromEntries(CONSTRUCTION_PARAM_KEYS.map((k) => [k, config.construction[k]])),
        maxPerSystem: config.stations.maxPerSystem,
        maxPerSystemPerFaction: Math.min(config.stations.maxPerSystemPerFaction, config.stations.maxPerSystem),
        dev: config.devIndices && config.devIndices.enabled === true && config.devIndices.stationsEnabled === true
          ? Object.freeze({ minLevelSum: config.devIndices.stationMinLevelSum,
            maxOpen: config.devIndices.stationMaxOpenPerFaction }) : null })
      : null,
    sentries: sentryFactionParamsOf(config),
    siege: config.siege && config.siege.enabled === true ? Object.freeze({
      reliefEnabled: config.siege.reliefEnabled === true, reliefLeadMs: config.siege.reliefLeadMs,
      reliefHoldMs: config.siege.reliefHoldMs, maxReliefPerReview: config.siege.maxReliefPerReview,
      fleetRoles: SIEGE_ROLES }) : null,
    playerSiege: playerSiegeParamsOf(config, deps.strengthGroups),
    invaderCounter: invaderCounterParamsOf(config),
    bossResponse: worldBossResponseParamsOf(config),
    harvestRaid: harvestRaidParamsOf(config),
    playerSov: playerSovParamsOf(config),
    playerValue: playerValueParamsOf(config),
    trade: config.trade && config.trade.enabled === true && config.modules.strategy.enabled === true
      && config.stations && config.stations.enabled === true
      ? Object.freeze({ ...Object.fromEntries(
          ["premiumPermille", "askCapPermille", "maxOffersPerReview", "maxCancelsPerReview",
           "maxOpenOffersPerFaction", "maxOpenOffersPerStation", "maxQuantityPerOffer",
           "minIskPerOffer", "maxIskPerOffer", "offerTtlMs", "factoryRunsTarget", "maxUnitPriceMilli",
           "priceCacheMs",
           "maxPrivateOffersPerReview", "maxOpenPrivateOffersPerFaction", "maxOpenPrivateOffersPerCharacter",
           "privateOfferTtlMs", "privateRejectCooldownMs",
           "stockpileEnabled", "stockpileRuns", "stockpileMaxIskPerOffer", "stockpileFreeFloorPermille",
           "targetOpenContracts",
           "tiersEnabled", "tier1Isk", "tier2Isk", "tier3Isk", "tier2SharePermille", "tier3SharePermille",
           "tier1TtlMs", "tier2TtlMs", "tier3TtlMs", "tierMinOfferIsk", "tierMaxBudgetSharePermille",
           "maxOfferVolumeM3",
           "stockpileLocalOnly", "oreOffersEnabled",
           "stockpileRecallEnabled", "stockpileRecallMinNeedPermille",
           "hullOffersEnabled",
           "hullOffersPerReview", "hullMaxPerOffer", "warReservedOffersPerFaction",
           "wtsEnabled",
           "wtsTtlMs", "wtsOffersPerReview", "wtsMaxOpenPerFaction", "wtsStationSlotHeadroom", "wtsMineralSurplusRuns",
           "wtsHullSurplusPermille", "wtsAskPermille", "wtsBidPermille", "wtsMaxIskPerOffer",
           "publicLotMaxIsk",
           "warPricingEnabled", "warPricingWindowDays", "warPricingLossRefPermille", "warPricingThreatRef",
           "warPricingLossWeightPermille", "warPricingThreatWeightPermille", "warPricingAusterityWeightPermille",
           "warPricingMinPermille", "warPricingStepPermille", "warBonusMaxPermille",
           "warAskCapMaxPermille",
           "warRepriceEnabled", "warRepriceGapPermille", "warRepricePerReview",
           "warStationAskGuardEnabled", "warStationAskCapPermille"].map((k) => [k, config.trade[k]])),
        ...(config.trade.commodityOffersEnabled === true ? Object.fromEntries(
          ["commodityOffersEnabled", "commodityOffersPerReview", "commodityFloatPermille", "commodityMinSellUnits"]
            .map((k) => [k, config.trade[k]])) : {}) })
      : null,
    hunt: config.hunt && config.hunt.enabled === true ? Object.freeze({
      enabled: true,
      maxHuntersPerFaction: Number.isSafeInteger(config.hunt.maxHuntersPerFaction) ? config.hunt.maxHuntersPerFaction : 2,
      strikeMaxJumps: Number.isSafeInteger(config.hunt.strikeMaxJumps) ? config.hunt.strikeMaxJumps : 5,
      dwellMs: Number.isSafeInteger(config.hunt.dwellMs) ? config.hunt.dwellMs : 300000,
      maxBfsSystems: config.hunt.maxBfsSystems,
    }) : null,
    returnFleetRoles: (() => {
      const rk = kinds.get("return");
      return Object.freeze(rk && rk.enabled !== false && Array.isArray(rk.fleetRoles) ? [...rk.fleetRoles] : []);
    })(),
    returnKindEnabled: (() => {
      const rk = kinds.get("return");
      return Boolean(rk && rk.enabled !== false);
    })(),
    industry: industryParamsOf(config),
    trim: S.territoryTrimEnabled === true ? Object.freeze({ territoryTrimEnabled: true,
      startTerritoryJumps: S.startTerritoryJumps, maxTrimsPerReview: S.maxTrimsPerReview,
      captureRangeFromStationJumps: S.captureRangeFromStationJumps, routeMaxJumps: config.graph.routeMaxJumps,
      maxBfsSystems: S.maxBfsSystems }) : null,
    borderPosts: S.borderPostsEnabled === true ? Object.freeze({ maxPerFaction: S.borderPostsMaxPerFaction,
      maxPerReview: S.borderPostsMaxPerReview, windowMs: S.borderPostWindowMs, idleMs: S.borderPostIdleMs,
      minShips: S.borderPostMinShips, maxJumps: S.borderPostMaxJumps, maxEnemyRatio: S.borderPostMaxEnemyRatio,
      secClasses: borderPostSecClassesOf(S),
      defensiveSharePermille: S.defensiveFleetSharePermille }) : null,
    minerEscort: S.minerEscortEnabled === true ? Object.freeze({ maxPerFaction: S.minerEscortMaxPerFaction,
      maxPerReview: S.minerEscortMaxPerReview, windowMs: S.minerEscortWindowMs,
      minShiftLeftMs: S.minerEscortMinShiftLeftMs, threatJumps: S.minerEscortThreatJumps,
      secClasses: minerEscortSecClassesOf(S), minShips: S.minerEscortMinShips, idleMs: S.minerEscortIdleMs,
      maxJumps: S.minerEscortMaxJumps, maxEnemyRatio: S.minerEscortMaxEnemyRatio,
      defensiveSharePermille: S.defensiveFleetSharePermille }) : null,
    intercept: S.interceptEnabled === true ? Object.freeze({ maxPerSweep: S.interceptMaxPerSweep,
      maxJumps: S.interceptMaxJumps, minLeadMs: S.interceptMinLeadMs, holdMs: S.interceptHoldMs,
      strengthRatio: S.interceptStrengthRatio, defensiveSharePermille: S.defensiveFleetSharePermille,
      maxFleetIds: S.maxFleetsPerOperation }) : null,
    defense: S.defenseEnabled === true ? Object.freeze({ enabled: true, maxPerReview: S.maxDefensePerReview,
      ...(S.intruderDefenseEnabled === true ? { intruders: Object.freeze({ maxPerReview: S.intruderMaxPerReview }) }
        : {}) }) : null,
    merge: S.mergeEnabled === true ? Object.freeze({ roles: parseFleetRoleList(S.mergeRoles) || Object.freeze([]),
      maxPerReview: S.maxMergesPerReview,
      maxShipsPerFleet: config.fleets ? config.fleets.maxShipsPerFleet : Number.MAX_SAFE_INTEGER,
      capital: S.capitalAttachEnabled === true ? Object.freeze({ maxGroups: MAX_GROUPS_PER_TAKE,
        classes: CAPITAL_HULL_GROUPS }) : null }) : null,
    garrison: S.garrisonReinforceEnabled === true
      ? Object.freeze({ maxPerReview: S.maxGarrisonReinforcePerReview,
        ...(S.garrisonConsolidateEnabled === true ? { consolidate: true } : {}),
        ...(S.garrisonEscalationEnabled === true && S.escalationEnabled === true ? { escalation: true } : {}) })
      : null,
    garrisonRelease: S.garrisonReleaseEnabled === true ? Object.freeze({ maxPerReview: S.maxGarrisonReleasesPerReview,
      fleetsTarget: config.occupation ? config.occupation.garrisonFleetsTarget : 0 }) : null,
    claimHold: S.claimHoldEnabled === true ? Object.freeze({ maxMs: S.claimHoldMaxMs,
      states: parseClaimHoldStates(S.claimHoldStates) || Object.freeze([]),
      roles: parseFleetRoleList(S.claimHoldRoles) || Object.freeze([]) }) : null,
    footholdHold: config.invasions && config.invasions.reviewFootholdsEnabled === true
      ? Object.freeze({ minFleets: config.invasions.holdMinFleets }) : null,
    hqGarrison: S.hqGarrisonEnabled === true ? Object.freeze({ minFleets: S.hqGarrisonMinFleets,
      roles: parseFleetRoleList(S.hqGarrisonRoles) || Object.freeze([]), maxJumps: S.hqGarrisonMaxJumps,
      windowMs: S.patrolWindowMs }) : null,
    patrol: S.patrolEnabled === true ? Object.freeze({ windowMs: S.patrolWindowMs, idleMs: S.patrolIdleMs,
      minShips: S.patrolMinShips, garrisonMaxJumps: S.patrolGarrisonMaxJumps, scoutMaxJumps: S.patrolScoutMaxJumps,
      maxGarrisonsPerPost: S.patrolMaxGarrisonsPerPost,
      maxOpenPickets: S.patrolMaxOpenPickets, scoutReserve: S.patrolScoutReserve,
      roleMaxJumps: S.patrolRoleSortieEnabled === true ? S.patrolRoleMaxJumps : 0,
      roleMaxEnemyRatio: S.patrolRoleMaxEnemyRatio,
      hostileNeedsFreshIntel: S.patrolHostileNeedsFreshIntel === true,
      garrisonFleetsTarget: config.occupation ? config.occupation.garrisonFleetsTarget : 0 }) : null,
    minerRaid: S.minerRaidEnabled === true ? Object.freeze({ maxPerReview: S.maxMinerRaidsPerReview,
      windowMs: S.minerRaidWindowMs, maxJumps: S.minerRaidMaxJumps, minShips: S.minerRaidMinShips,
      minShipRatioPermille: S.minerRaidMinShipRatioPermille, minShiftLeftMs: S.minerRaidMinShiftLeftMs,
      highsec: S.minerRaidHighsecEnabled === true, maxFleetsScanned: S.maxFleetsPerFaction,
      readLimit: S.maxMinerTargetsRead,
      strengthCheck: S.minerRaidStrengthCheck === true,
      preferUnescorted: S.minerRaidPreferUnescorted === true,
      skipForeignBastions: S.foreignBastionRaidSkipEnabled === true }) : null,
    capsuleerPursuit: S.capsuleerPursuitEnabled === true ? Object.freeze({
      maxPerReview: S.maxCapsuleerPursuitsPerReview, maxJumps: S.capsuleerPursuitMaxJumps,
      minShipRatioPermille: S.capsuleerPursuitMinShipRatioPermille, windowMs: S.capsuleerPursuitWindowMs,
      readLimit: S.capsuleerPursuitReadLimit, maxFleetsScanned: S.capsuleerPursuitMaxFleetsScanned,
      skipForeignBastions: S.foreignBastionRaidSkipEnabled === true }) : null,
    stranded: S.strandedReturnEnabled === true ? Object.freeze({ idleMs: S.strandedIdleMs,
      disbandIdleMs: S.strandedDisbandIdleMs, maxPerReview: S.maxStrandedPerReview,
      returnMaxJumps: S.strandedReturnMaxJumps, maxBfsSystems: S.strandedMaxBfsSystems,
      maxSearches: S.strandedMaxSearchesPerReview }) : null,
    garrisonEstimate: garrisonEstimateOf(config),
    playerActivity: playerActivityOn ? Object.freeze({ hotMinKills: S.playerActivityHotMinKills }) : null,
    ...(attackLossOn ? { attackLoss: Object.freeze({ stepPermille: S.attackLossStepPermille,
      maxMultiplier: S.attackLossMaxMultiplier,
      iskGate: S.attackLossIskGateEnabled === true ? Object.freeze({ sharePermille: S.attackLossSharePermille,
        maxRoomPermille: S.maxAttackLossRoomPermille }) : null }) } : {}),
    ...(transitGateOn ? { transitRisk: Object.freeze({ skipPermille: TZ.aiSkipRouteRiskPermille,
      raiseStepPermille: TZ.aiRaiseStepPermille,
      ...(TZ.aiOperationTemplateShips === true ? { templateShips: true } : {}) }) } : {}),
    hive: config.hive && config.hive.enabled === true ? Object.freeze({ maxFleets: config.hive.maxFleets,
      fleetsPerNode: config.hive.fleetsPerNode, maxFrontsPerAttacker: config.hive.maxFrontsPerAttacker,
      assumedGarrisonFleets: config.hive.assumedGarrisonFleets, captureSlowFactor: config.hive.captureSlowFactor,
      assumedGarrisonStrength: config.hive.assumedGarrisonFleets * hivePatrolStrength(),
      swarm: config.hive.swarmEnabled === true ? Object.freeze({ thresholdUnits: config.hive.swarmThresholdUnits,
        cooldownMs: config.hive.swarmCooldownMs, fleets: config.hive.swarmFleets, maxJumps: config.hive.swarmMaxJumps })
        : null })
      : null,
  });
  const freeHullGroupsOf = () => (params.production && params.production.freeHullGroups) || [];
  const industryGroups = params.industry ? params.industry.industryGroups : [];

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function noteInvaderYield(decision) {
    const y = decision && decision.invaderYield;
    const prefix = y && Object.prototype.hasOwnProperty.call(INVADER_ECONOMY_FACTIONS, decision.factionId)
      ? INVADER_ECONOMY_FACTIONS[decision.factionId] : null;
    if (prefix === null) return;
    const [isk, units] = INVADER_YIELD_METRICS[prefix];
    metric("gauge", isk, y.iskDaily);
    metric("gauge", units, y.unitsPerPeriod);
  }

  function bump(name, n = 1) {
    if (n <= 0) return;
    counters[name] += n;
    metric("count", `strategy.review.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }
  const threwLog = createDecideThrewLog({ log, clock, intervalMs: S.decideThrewLogIntervalMs });

  const phaseOf = (f) => deriveSeed(worldSeed, "strategy", "phase", f) % I;
  const bucketOf = (f, t) => Math.floor((t - phaseOf(f)) / I);
  const dueOf = (f, b) => b * I + phaseOf(f);
  const reviewKey = (f, b) => `strategy:review:${f}:${b}`;
  const nextOf = (f, at) => {
    const b = bucketOf(f, at) + 1;
    return { dueAt: dueOf(f, b), payload: { factionId: f, round: b }, idempotencyKey: reviewKey(f, b) };
  };

  function currentGraph() {
    const g = deps.graph;
    const r = call(() => (g && typeof g.getGraph === "function" ? g.getGraph() : null), null);
    return r && r.ok === true && r.graph ? r.graph : null;
  }

  function occupationService() {
    const occ = typeof deps.getOccupation === "function" ? call(deps.getOccupation, null) : null;
    if (!occ || typeof occ.signalInTx !== "function" || typeof occ.getStatus !== "function") return null;
    return call(() => occ.getStatus().state, null) === "ready" ? occ : null;
  }

  function countBlockadeScan(scan) {
    const bk = typeof deps.getBlockade === "function" ? call(deps.getBlockade, null) : null;
    if (bk && typeof bk.countScan === "function") call(() => bk.countScan(scan), null);
  }
  const expansionLogged = new Set();

  function miningService() {
    const mn = typeof deps.getMining === "function" ? call(deps.getMining, null) : null;
    return mn && typeof mn.getMode === "function" ? mn : null;
  }

  function readMining(db, f, systems, stationSystemIds, doctrine, at) {
    const mn = miningService();
    if (!mn) return { ok: true, mining: null };
    const mode = call(() => mn.getMode(), "off");
    const escortOn = Boolean(params.minerEscort);
    if (mode !== "ready") {
      return { ok: true, mining: { mode, sites: [], openByBelt: [], busyFleetIds: [],
        ...(escortOn ? { openTrips: [] } : {}) } };
    }
    const site = mn.readSiteState(db, f);
    if (!site || !site.ok) return site || { ok: false, reason: "MINING_READ_FAILED" };
    const sites = [];
    const stationRule = Boolean(params.mining && params.mining.ownStationSystemsEnabled === true);
    const ownStations = stationRule ? new Set((stationSystemIds || []).filter(isId)) : null;
    for (const s of systems) {
      if (s.controllerFactionId !== f && !(ownStations && stationExemptionOf({ factionId: f,
        controllerFactionId: s.controllerFactionId, ownStationHere: ownStations.has(s.systemId),
        ownInfluence: s.ownInfluenceRaw, minInfluence: params.mining.ownStationMinInfluence }))) continue;
      const r = call(() => mn.richnessOf(s.systemId), null);
      if (r && r.ok && r.richnessPermille > 0) {
        sites.push({ systemId: s.systemId, richnessPermille: r.richnessPermille, projected: false });
      }
    }
    if (typeof mn.readOwnSpaceSites === "function") {
      const own = mn.readOwnSpaceSites(db, f, stationSystemIds || []);
      if (!own || !own.ok) return own || { ok: false, reason: "MINING_READ_FAILED" };
      const seen = new Set(systems.map((s) => s.systemId));
      for (const s of own.sites) if (!seen.has(s.systemId)) sites.push(s);
    }
    const maxSystems = params.mining ? params.mining.ownSpaceScanSystems : undefined;
    if (maxSystems > 0 && doctrine && doctrine.ownSpace && Array.isArray(doctrine.ownSpace.secClasses)
      && doctrine.ownSpace.secClasses.length > 0) {
      const g = currentGraph();
      if (g) {
        const secClasses = new Set(doctrine.ownSpace.secClasses);
        const sovereignty = doctrine.ownSpace.sovereignty || "self";
        const maxJumps = doctrine.ownSpaceMaxJumps ?? params.mining.maxTripJumps;
        const sources = [...new Set((stationSystemIds || []).filter(isId))].sort((a, b) => a - b);
        const entryOf = call(() => registry.getFaction(f), null);
        const allies = entryOf && Array.isArray(entryOf.allies) ? entryOf.allies : [];
        const visited = new Map();
        const seen = new Set(sites.map((s) => s.systemId));
        for (const id of sources) {
          if (visited.size >= maxSystems) break;
          visited.set(id, 0);
        }
        let frontier = [...visited.keys()];
        for (let jump = 1; jump <= maxJumps && frontier.length > 0 && visited.size < maxSystems; jump += 1) {
          const next = new Set();
          for (const id of frontier) {
            if (visited.size >= maxSystems) break;
            const v = g.getSystem(id);
            if (sovereignty !== "any") {
              const isSource = sources.includes(id);
              let canPass = false;
              if (sovereignty === "self") {
                canPass = isSource || (v && v.factionId === f);
              } else if (sovereignty === "friendly") {
                if (isSource) {
                  canPass = true;
                } else if (v && v.factionId === f) {
                  canPass = true;
                } else if (v && isId(v.factionId) && deps.hostility && typeof deps.hostility === "function") {
                  canPass = deps.hostility(v.factionId, f) === false;
                }
              }
              if (!canPass) continue;
            }
            const list = g.getNeighbors(id);
            if (!Array.isArray(list)) continue;
            for (const nb of list) {
              if (visited.size >= maxSystems) break;
              if (visited.has(nb)) continue;
              const vnb = g.getSystem(nb);
              if (!vnb) continue;
              if (!secClasses.has(vnb.secClass)) continue;
              if (!canMineIn(f, null, vnb, doctrine.ownSpace, allies)) continue;
              visited.set(nb, jump);
              next.add(nb);
            }
          }
          frontier = [...next].sort((a, b) => a - b);
        }
        const worldRepo = deps.world && deps.world.repository;
        if (worldRepo && typeof worldRepo.getSystems === "function") {
          const candidateIds = [...visited.keys()].filter((id) => !seen.has(id));
          if (candidateIds.length > 0) {
            const batch = worldRepo.limits && isId(worldRepo.limits.maxBatchReadIds) ? worldRepo.limits.maxBatchReadIds : candidateIds.length;
            const missing = [];
            for (let i = 0; i < candidateIds.length; i += batch) {
              const r = worldRepo.getSystems(db, candidateIds.slice(i, i + batch), { includeInfluence: false });
              if (!r || !r.ok) return r || { ok: false, reason: "WORLD_READ_FAILED" };
              missing.push(...r.missing);
            }
            for (const id of missing.sort((a, b) => a - b)) {
              if (!canMineIn(f, null, call(() => g.getSystem(id), null), doctrine.ownSpace, allies)) continue;
              const rich = call(() => mn.richnessOf(id), null);
              if (rich && rich.ok && rich.richnessPermille > 0) {
                sites.push({ systemId: id, richnessPermille: rich.richnessPermille, projected: true });
                seen.add(id);
              }
            }
          }
        }
      }
    }
    let cooldown = null;
    if (params.mining && params.mining.beltCooldownEnabled === true) {
      const cd = typeof mn.readBeltCooldowns === "function" ? mn.readBeltCooldowns(db, f, at) : null;
      if (!cd || !cd.ok) return cd || { ok: false, reason: "MINING_READ_FAILED" };
      cooldown = Object.freeze([...cd.systemIds]);
    }
    return { ok: true, mining: { mode, sites, openByBelt: site.openByBelt, busyFleetIds: site.busyFleetIds,
      ...(escortOn ? { openTrips: Array.isArray(site.openTrips) ? site.openTrips : [] } : {}),
      ...(cooldown !== null ? { cooldownSystemIds: cooldown } : {}) } };
  }

  function readMinerTargets(db, f, at) {
    const P = params.minerRaid;
    if (!P) return null;
    const mn = miningService();
    if (!mn || call(() => mn.getMode(), "off") !== "ready" || typeof mn.readMinerTargets !== "function") return null;
    const r = call(() => mn.readMinerTargets(db, { excludeFactionId: f, at, limit: P.readLimit }), null);
    if (!r || r.ok !== true || !Array.isArray(r.targets)) {
      bump("minerRaidReadFailed");
      return null;
    }
    return { targets: r.targets, truncated: r.truncated === true };
  }

  function readCapsuleerTargets(db, f) {
    const P = params.capsuleerPursuit;
    if (!P || f === CAPSULEER_FACTION_ID) return null;
    const r = call(() => fleets.repository.listFleetsByFaction(db, CAPSULEER_FACTION_ID,
      { states: ["STAGED"], role: "capsuleer", limit: P.readLimit }), null);
    if (!r || r.ok !== true || !Array.isArray(r.fleets)) {
      bump("capsuleerPursuitReadFailed");
      return null;
    }
    return { targets: r.fleets.filter((x) => x.operationId !== null && x.operationId !== undefined)
      .map((x) => ({ systemId: x.currentSystemId, fleetId: x.fleetId, ships: x.shipCount })),
    truncated: r.nextAfterFleetId !== null && r.nextAfterFleetId !== undefined };
  }

  function productionService() {
    const pr = typeof deps.getProduction === "function" ? call(deps.getProduction, null) : null;
    return pr && typeof pr.getMode === "function" ? pr : null;
  }

  function readProduction(db, f, stations, st, mode, at) {
    const pr = productionService();
    if (!pr) return { ok: true, production: null };
    const prMode = call(() => pr.getMode(), "off");
    const empty = { mode: prMode, recipesVersion: null, recipes: {}, stations: [], inProduction: {},
      activeJobsTotal: 0, truncated: false };
    if (prMode !== "ready" || mode !== "ready" || !st || !st.repository) return { ok: true, production: empty };
    const table = call(() => pr.getRecipes(), null);
    if (!table) return { ok: true, production: { ...empty, mode: "off" } };
    const state = pr.readStationState(db, f, stations.map((x) => ({ stationId: x.stationId, kind: x.kind })), { at });
    const adv = typeof pr.getAdvanced === "function" ? call(() => pr.getAdvanced(), null) : null;
    const required = Boolean(adv) && adv.mode === "required";
    if (!state || !state.ok) return state || { ok: false, reason: "PRODUCTION_READ_FAILED" };
    const commodityOn = Boolean(params.trade && params.trade.commodityOffersEnabled === true);
    let truncated = false;
    const out = [];
    let stocks = null;
    if (typeof st.repository.getStocks === "function" && stations.length > 0) {
      const batch = st.repository.getStocks(db, stations.map((x) => x.stationId));
      if (batch.ok) stocks = batch.byStation;
      else if (batch.reason !== "BATCH_TOO_LARGE") return batch;
    }
    for (let i = 0; i < stations.length; i += 1) {
      const x = stations[i];
      const stock = stocks ? { ok: true, ...stocks.get(x.stationId) } : st.repository.getStock(db, x.stationId);
      if (!stock.ok) return stock;
      if (stock.truncated) truncated = true;
      const minerals = {};
      const hulls = {};
      const advanced = {};
      const commodities = {};
      for (const it of stock.items) {
        if (it.itemKind === "mineral") minerals[it.itemKey] = it.quantity;
        else if (it.itemKind === "hull" && it.itemKey.startsWith("group:")) {
          hulls[it.itemKey.slice("group:".length)] = it.quantity;
        } else if (it.itemKind === "moon" || it.itemKind === "pi") {
          if (required) advanced[it.itemKey] = it.quantity;
          if (commodityOn) commodities[it.itemKey] = it.quantity;
        }
      }
      out.push({ stationId: x.stationId, systemId: x.systemId, kind: x.kind, lines: state.stations[i].lines,
        activeJobs: state.stations[i].activeJobs, minerals, hulls, ...(required ? { advanced } : {}),
        ...(commodityOn ? { commodities } : {}) });
    }
    const recipes = {};
    for (const g of table.groups) {
      const r = table.lookup(g);
      if (!r) continue;
      recipes[g] = { minerals: r.minerals };
      if (!required) continue;
      const bill = call(() => adv.billOf(g, 1), null);
      const perRun = {};
      for (const kind of ["moon", "pi"]) {
        for (const [typeId, n] of (bill && bill[kind]) || []) perRun[`type:${typeId}`] = n;
      }
      recipes[g].advanced = perRun;
    }
    return { ok: true, production: { mode: prMode, recipesVersion: table.version, recipes, stations: out,
      inProduction: state.inProduction, activeJobsTotal: state.activeJobsTotal, truncated } };
  }

  function logisticsService() {
    const lg = typeof deps.getLogistics === "function" ? call(deps.getLogistics, null) : null;
    return lg && typeof lg.getMode === "function" ? lg : null;
  }

  function readLogistics(db, f, rawFleets) {
    const lg = logisticsService();
    if (!lg || !params.logistics) return { ok: true, logistics: null };
    const mode = call(() => lg.getMode(), "off");
    const carriers = {};
    for (const x of rawFleets) {
      if (x.fleetRole !== LOGISTICS_ROLE) continue;
      carriers[x.fleetId] = (x.composition || []).filter((e) => CARRIER_GROUPS.includes(e.hullGroup))
        .reduce((n, e) => n + e.count, 0);
    }
    if (mode !== "ready") return { ok: true, logistics: { mode, open: [], busyFleetIds: [], carriers, truncated: false } };
    const r = lg.readOpen(db, f, { limit: params.logistics.maxOpenConvoysPerFaction });
    if (!r || !r.ok) return r || { ok: false, reason: "LOGISTICS_READ_FAILED" };
    return { ok: true, logistics: { mode, open: r.convoys, busyFleetIds: r.convoys.map((c) => c.fleetId).sort(),
      carriers, truncated: r.truncated === true } };
  }

  function constructionService() {
    const c = typeof deps.getConstruction === "function" ? call(deps.getConstruction, null) : null;
    return c && typeof c.getMode === "function" ? c : null;
  }

  function readConstruction(db, f, graph, at, ctx) {
    const c = constructionService();
    if (!c || !params.construction) return { ok: true, construction: null };
    const mode = call(() => c.getMode(), "off");
    const targetable = (id) => call(() => isExpansionTarget(graph.getSystem(id)), false);
    const kit = mode === STATION_READY ? call(() => c.getKit(params.construction.kitId), null) : null;
    if (mode !== STATION_READY || !kit) {
      return { ok: true, construction: { mode, kit: null, open: [], truncated: false, targetable, openTotal: 0,
        liveTotal: 0, sinceLastBuildMs: null, outposts: OUTPOSTS_OFF } };
    }
    const r = c.readOpen(db, f, { limit: params.construction.maxOpenBuildsPerFaction });
    if (!r || !r.ok) return r || { ok: false, reason: "CONSTRUCTION_READ_FAILED" };
    const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    const last = Number.isSafeInteger(r.lastBuildAt) ? r.lastBuildAt : null;
    const sinceLastBuildMs = last === null ? null : Math.max(0, at - last);
    const o = readOutpostSites(db, { C: params.construction, factionId: f, entry: ctx.entry, doctrine: ctx.doctrine,
      territory: ctx.territory, stations: ctx.stations, open: r.builds, sinceLastBuildMs, graph,
      repository: ctx.st ? ctx.st.repository : null });
    if (!o.ok) return o;
    const devLevels = readDevLevels(params.construction, deps.getDevIndices, f, ctx);
    return { ok: true, construction: { mode, kit: { kitId: kit.kitId, items: { ...kit.items } }, open: r.builds,
      truncated: r.truncated === true, targetable, openTotal: count(r.openTotal), liveTotal: count(r.liveTotal),
      sinceLastBuildMs, outposts: o.outposts, ...(devLevels ? { devLevels } : {}) } };
  }

  function sentriesService() {
    const s = typeof deps.getSentries === "function" ? call(deps.getSentries, null) : null;
    return s && typeof s.readForReview === "function" && typeof s.requestBuildInTx === "function" ? s : null;
  }

  function readSentries(db, f, graph, ctx) {
    const P = params.sentries;
    if (!P) return { ok: true, sentries: null };
    const sv = sentriesService();
    if (!sv) return { ok: true, sentries: { mode: "off" } };
    const seen = new Map(ctx.rows);
    const controllerOf = (id) => {
      const w = seen.get(id);
      if (w) return isId(w.controllerFactionId) ? w.controllerFactionId : null;
      const v = call(() => graph.getSystem(id), null);
      return v && isId(v.factionId) ? v.factionId : null;
    };
    const stationsBy = new Map();
    for (const s of ctx.stations) {
      if (!stationsBy.has(s.systemId)) stationsBy.set(s.systemId, []);
      stationsBy.get(s.systemId).push({ stationId: s.stationId, kind: s.kind });
    }
    const own = [...new Set([...ctx.systems.filter((x) => x.controllerFactionId === f).map((x) => x.systemId),
      ...stationsBy.keys()])];
    const neighboursOf = (id) => call(() => graph.getNeighbors(id), null) || [];
    const ranked = own.map((id) => ({ id, rank: stationsBy.has(id) ? 0
      : neighboursOf(id).some((n) => controllerOf(n) !== f) ? 1 : 2 }))
      .sort((a, b2) => a.rank - b2.rank || a.id - b2.id).slice(0, P.maxCandidateSystems);
    const r = sv.readForReview(db, f, { maxCandidateSystems: P.maxCandidateSystems, systemIds: ranked.map((x) => x.id) });
    if (!r || r.ok !== true) return r || { ok: false, reason: "SENTRIES_READ_FAILED" };
    if (r.mode !== "ready") return { ok: true, sentries: { mode: r.mode } };
    const ids = [...new Set(ranked.flatMap((x) => [x.id, ...neighboursOf(x.id)]))];
    const rd = readWorld(db, ids, seen);
    if (!rd.ok) return rd;
    const systems = ranked.map(({ id }) => {
      const v = call(() => graph.getSystem(id), null);
      const w = seen.get(id);
      return { systemId: id, secClass: v ? v.secClass : null, occupationState: w ? w.occupationState || null : null,
        stations: stationsBy.get(id) || [],
        neighbours: neighboursOf(id).map((n) => ({ systemId: n, controllerFactionId: controllerOf(n) })) };
    });
    return { ok: true, sentries: { mode: "ready", typeId: r.typeId, factionLive: r.factionLive, total: r.total,
      rows: r.rows, ...(Array.isArray(r.anchors) ? { anchors: r.anchors } : {}), systems } };
  }

  function readSiege(db, f) {
    const sg = typeof deps.getSiege === "function" ? call(deps.getSiege, null) : null;
    if (!sg) return { ok: true, siege: null };
    const mode = typeof sg.getMode === "function" ? call(() => sg.getMode(), "off") : "off";
    if (mode !== STATION_READY || !params.siege || typeof sg.readForFaction !== "function") {
      return { ok: true, siege: { mode: mode === STATION_READY ? "off" : mode, attacking: [], defending: [],
        truncated: false } };
    }
    const r = sg.readForFaction(db, f, { limit: config.siege.maxOpenSieges });
    if (!r || !r.ok) return r || { ok: false, reason: "SIEGE_READ_FAILED" };
    return { ok: true, siege: { mode, attacking: r.attacking, defending: r.defending, truncated: r.truncated === true } };
  }

  function readPlayerSiege(db, f, at, scope) {
    const ps = typeof deps.getPlayerSiege === "function" ? call(deps.getPlayerSiege, null) : null;
    if (!ps) return { ok: true, playerSiege: null };
    const mode = typeof ps.getMode === "function" ? call(() => ps.getMode(), "off") : "off";
    const P = params.playerSiege;
    if (mode !== STATION_READY || !P || typeof ps.readForFaction !== "function") {
      return { ok: true, playerSiege: { mode: mode === STATION_READY ? "off" : mode, attacking: [], targets: [],
        truncated: false } };
    }
    const r = ps.readForFaction(db, f, { limit: config.playerSiege.maxOpen });
    if (!r || !r.ok) return r || { ok: false, reason: "PLAYER_SIEGE_READ_FAILED" };
    let targets = [];
    let truncated = r.truncated === true;
    let targetsReason = null;
    const d = scope && scope.doctrine;
    const kind = (params.kinds || []).find((k) => k.kind === ASSAULT_KIND);
    const assaults = Boolean(kind && d && Array.isArray(d.operationTypes) && d.operationTypes.includes(kind.operationType)
      && !(kind.needsCanOccupy === true && d.canOccupy !== true));
    const reach = assaults && scope.graph && Array.isArray(scope.controlled) && scope.controlled.length > 0
      ? bfs(scope.controlled, (id) => scope.graph.getNeighbors(id), { maxJumps: P.dispatchMaxJumps,
        maxSystems: S.maxBfsSystems })
      : null;
    if (P.maxDispatchPerReview > 0 && r.attacking.length === 0 && reach !== null
      && typeof ps.readTargetsForFaction === "function") {
      const t = call(() => ps.readTargetsForFaction(db, f, { limit: config.playerSiege.maxOpen, at,
        systems: [...reach.keys()] }), null);
      if (t && t.ok === true) {
        targets = t.targets;
        truncated = truncated || t.truncated === true;
      } else targetsReason = String((t && t.reason) || "PLAYER_SIEGE_TARGETS_READ_FAILED");
    }
    return { ok: true, playerSiege: { mode, attacking: r.attacking, targets, truncated,
      ...(targetsReason === null ? {} : { targetsReason }) } };
  }

  function readHarvestRaid(db, f, at, entryKind, scope) {
    const P = params.harvestRaid;
    if (!P || !P.factionKinds.includes(entryKind)) return null;
    const hr = typeof deps.getHarvestRaid === "function" ? call(deps.getHarvestRaid, null) : null;
    const mode = hr && typeof hr.getMode === "function" ? call(() => hr.getMode(), "off") : "off";
    const empty = { mode: mode === STATION_READY ? "off" : mode, open: 0, targets: [], truncated: false };
    if (mode !== STATION_READY || typeof hr.readTargetsForFaction !== "function") return empty;
    const d = scope && scope.doctrine;
    const kind = (params.kinds || []).find((k) => k.kind === HARVEST_RAID_KIND);
    const raids = Boolean(kind && d && Array.isArray(d.operationTypes) && d.operationTypes.includes(kind.operationType));
    const reach = raids && P.maxDispatchPerReview > 0 && scope.graph && Array.isArray(scope.controlled)
      && scope.controlled.length > 0
      ? call(() => bfs(scope.controlled, (id) => scope.graph.getNeighbors(id), { maxJumps: P.dispatchMaxJumps,
        maxSystems: S.maxBfsSystems }), null)
      : null;
    if (reach === null) return { mode, open: 0, targets: [], truncated: false };
    const t = call(() => hr.readTargetsForFaction(db, f, { systems: [...reach.keys()], at,
      limit: P.maxTargetsReadPerReview }), null);
    if (!t || t.ok !== true || !Array.isArray(t.targets)) {
      return { mode, open: 0, targets: [], truncated: false,
        targetsReason: String((t && t.reason) || "HARVEST_RAID_TARGETS_READ_FAILED") };
    }
    return { mode, open: Number.isSafeInteger(t.open) ? t.open : 0, targets: t.targets, truncated: t.truncated === true };
  }

  function readInvaderBeachheads(db, entryKind, scope) {
    const P = params.invaderCounter;
    if (!P || !P.kinds.includes(entryKind)) return null;
    if (typeof deps.beachheadsOf !== "function") return { mode: "off", truncated: false, items: [] };
    const failed = { mode: "failed", truncated: false, items: [] };
    if (!scope || !scope.graph || typeof scope.graph.getNeighbors !== "function") return failed;
    const controlled = Array.isArray(scope.controlled) ? scope.controlled : [];
    if (controlled.length === 0) return { mode: "ready", truncated: false, items: [] };
    const reach = call(() => bfs(controlled, (id) => scope.graph.getNeighbors(id), { maxJumps: P.rangeJumps,
      maxSystems: S.maxBfsSystems }), null);
    if (reach === null) return failed;
    const r = call(() => deps.beachheadsOf(db, P.maxBeachheadsRead, [...reach.keys()]), null);
    if (!r || r.ok !== true || !Array.isArray(r.beachheads)) return failed;
    const items = [];
    for (const b of r.beachheads) {
      if (!isId(b.factionId) || !isId(b.systemId)) continue;
      const page = call(() => fleets.repository.listFleetsInSystem(db, b.systemId,
        { states: [...INVASION_HOLD_STATES], limit: P.holderReadLimit + 1 }), null);
      if (!page || page.ok !== true || !Array.isArray(page.fleets)) return failed;
      const holders = page.fleets.slice(0, P.holderReadLimit).filter((x) => x.factionId === b.factionId)
        .map((x) => ({ fleetId: x.fleetId, factionId: x.factionId, composition: x.composition }));
      items.push({ invasionId: b.invasionId, factionId: b.factionId, systemId: b.systemId, holders,
        holdersTruncated: page.fleets.length > P.holderReadLimit });
    }
    return { mode: "ready", truncated: r.truncated === true, items };
  }

  function readWorldBossTargets(db, entryKind, scope) {
    const P = params.bossResponse;
    if (!P || !P.kinds.includes(entryKind)) return null;
    if (typeof deps.worldBossTargetsOf !== "function") return { mode: "off", truncated: false, items: [] };
    const failed = { mode: "failed", truncated: false, items: [] };
    if (!scope || !scope.graph || typeof scope.graph.getNeighbors !== "function") return failed;
    const controlled = Array.isArray(scope.controlled) ? scope.controlled : [];
    if (controlled.length === 0) return { mode: "ready", truncated: false, items: [] };
    const reach = call(() => bfs(controlled, (id) => scope.graph.getNeighbors(id), { maxJumps: P.rangeJumps,
      maxSystems: S.maxBfsSystems }), null);
    if (reach === null) return failed;
    const r = call(() => deps.worldBossTargetsOf(db, [...reach.keys()], P.maxTargetsRead), null);
    if (!r || r.ok !== true || !Array.isArray(r.items)) return failed;
    const items = r.items.filter((b) => b && isId(b.factionId) && isId(b.systemId)).map((b) => ({ bossId: b.bossId,
      factionId: b.factionId, state: b.state, systemId: b.systemId, arriveAt: b.arriveAt,
      departAt: Number.isSafeInteger(b.departAt) ? b.departAt : null, phase: b.phase,
      composition: Array.isArray(b.composition) ? b.composition : [] }));
    return { mode: "ready", truncated: r.truncated === true, items };
  }

  function readPlayerSovTargets(db, f, at) {
    if (!params.playerSov) return null;
    const empty = { playerSov: new Map(), playerSovSieges: 0 };
    const ps = typeof deps.getPlayerSovSiege === "function" ? call(deps.getPlayerSovSiege, null) : null;
    if (!ps || typeof ps.listForReviewInTx !== "function") return empty;
    const r = call(() => ps.listForReviewInTx(db, f, at), null);
    if (!r || r.ok !== true || !(r.bySystem instanceof Map) || !Number.isSafeInteger(r.siegesOfFaction)) return empty;
    return { playerSov: r.bySystem, playerSovSieges: r.siegesOfFaction };
  }

  function readPlayerValue(at, playerSovRead, playerSiege) {
    const P = params.playerValue;
    if (!P) return null;
    const pv = typeof deps.getPlayerValue === "function" ? call(deps.getPlayerValue, null) : null;
    if (!pv || typeof pv.snapshotFor !== "function") return new Map();
    const claimed = playerSovRead && playerSovRead.playerSov instanceof Map ? [...playerSovRead.playerSov.keys()] : [];
    const targets = playerSiege && Array.isArray(playerSiege.targets) ? playerSiege.targets.map((t) => t.systemId) : [];
    const ids = P.unclaimedPermille > 0 ? null : [...claimed, ...targets];
    const map = call(() => pv.snapshotFor(ids, at), null);
    if (!(map instanceof Map)) return new Map();
    let applied = 0;
    let capped = 0;
    for (const id of claimed) {
      const v = map.get(id);
      if (!(v > 0)) continue;
      applied += 1;
      if (v >= P.valueCap) capped += 1;
    }
    if (typeof pv.notePremium === "function") call(() => pv.notePremium(applied, capped), null);
    return map;
  }

  function huntReady() {
    const h = typeof deps.getHunt === "function" ? call(deps.getHunt, null) : null;
    return Boolean(h && typeof h.getState === "function" && call(() => h.getState(), null) === "running");
  }

  function tradeService() {
    const tr = typeof deps.getTrade === "function" ? call(deps.getTrade, null) : null;
    return tr && typeof tr.fundFromUpkeepInTx === "function" ? tr : null;
  }

  function treasuryService() {
    if (!params.treasury) return null;
    const t = typeof deps.getTreasury === "function" ? call(deps.getTreasury, null) : null;
    return t && typeof t.settleIntentInTx === "function" && typeof t.readForReview === "function" ? t : null;
  }

  function treasuryFundsTrade() {
    const t = treasuryService();
    return Boolean(t && typeof t.fundsTrade === "function" && call(() => t.fundsTrade(), false) === true);
  }

  function readTreasury(db, f, entry, stations, at, doctrine, lossWindowDays) {
    if (doctrine && doctrine.hive === true) return { ok: true, treasury: null };
    if (!params.treasury) return { ok: true, treasury: null };
    const t = treasuryService();
    if (!t || call(() => t.getMode(), "off") !== "run") return { ok: true, treasury: { mode: "off" } };
    const opts = { at, kind: entry.kind, npcStations: stations.filter((s) => s.kind === "npc").length };
    if (lossWindowDays !== undefined) opts.lossWindowDays = lossWindowDays;
    return t.readForReview(db, f, opts);
  }

  const warPricingOn = () => Boolean(params.trade && params.trade.warPricingEnabled === true);

  function warPressureOf(treasury, threatCount) {
    const t = treasury && treasury.mode === "ready" ? treasury : null;
    return pressureOf({ lossValueIsk: t && t.lossWindow ? t.lossWindow.lossValueIsk : 0,
      initialIsk: t && Number.isSafeInteger(t.initialIsk) ? t.initialIsk : 0, threatCount,
      austerity: Boolean(t && t.accountMode === "AUSTERITY") }, pressureParamsOf(params.trade));
  }

  function readTrade(db, f, stations, at, warPressurePermille) {
    const tr = tradeService();
    if (!params.trade) return { ok: true, trade: null };
    if (!tr) return { ok: true, trade: { mode: "off" } };
    const limit = params.trade.maxOpenOffersPerFaction;
    const opts = { stations, at, limit };
    if (warPressurePermille !== undefined) opts.warPressurePermille = warPressurePermille;
    return withDevDiscounts(tr.readForReview(db, f, opts), stations);
  }

  function withDevDiscounts(r, stations) {
    if (!r || r.ok !== true || !r.trade || r.trade.mode === "off" || typeof deps.getDevIndices !== "function") return r;
    const dev = call(() => deps.getDevIndices(), null);
    if (!dev || typeof dev.effectsOf !== "function") return r;
    const map = new Map();
    for (const s of stations) {
      if (!s || map.has(s.systemId)) continue;
      const e = call(() => dev.effectsOf(s.systemId, "discount"), null);
      if (e && Number.isSafeInteger(e.wtsDiscountPermille) && e.wtsDiscountPermille > 0) {
        map.set(s.systemId, e.wtsDiscountPermille);
      }
    }
    return map.size > 0 ? { ...r, trade: { ...r.trade, devWtsDiscounts: map } } : r;
  }

  function readUpkeep(db, f, row, at, capturedRows, capturedTruncated, fleetList, stations, doctrine, footholdList) {
    const world = deps.world && deps.world.repository;
    if (!params.upkeep || !world || typeof world.countControlledByFaction !== "function") {
      return { ok: true, upkeep: { mode: "off" } };
    }
    const c = world.countControlledByFaction(db, f);
    if (!c.ok) return c;
    const occ = occupationService();
    const factor = (x) => {
      const v = occ ? call(() => occ.territoryUpkeepFactor(x, at), 1) : 1;
      return Number.isFinite(v) && v >= 1 ? Math.round(v * PERMILLE) : PERMILLE;
    };
    const paidUntil = row.upkeepPaidUntil === undefined ? null : row.upkeepPaidUntil;
    const unpaid = row.upkeepUnpaidPeriods || 0;
    const tr = tradeService();
    const trMode = tr && typeof tr.getMode === "function" ? call(() => tr.getMode(), "off") : "off";
    const t = tr && typeof tr.tradeReady === "function"
      ? call(() => tr.tradeReady(db, f, { npcStations: stations.filter((s) => s.kind === "npc").length }), null)
      : null;
    const viaTreasury = treasuryFundsTrade();
    const tradeReady = !viaTreasury && Boolean(t && t.ready === true) && unpaid === 0;
    let tradeReason = null;
    if (!viaTreasury && (trMode === "run" || trMode === "run-no-contracts") && !tradeReady) {
      tradeReason = t && t.ready === true ? "UPKEEP_UNPAID" : String((t && t.reason) || "TRADE_OFF");
    }
    return { ok: true, upkeep: { mode: "ready", paidUntil,
      unpaidPeriods: unpaid, controlledCount: c.count,
      captured: capturedRows.map((x) => ({ systemId: x.systemId, state: x.occupationState,
        detachedSinceAt: x.detachedSinceAt === undefined ? null : x.detachedSinceAt, factorPermille: factor(x),
        core: getCoreIndex(config).systems.get(x.systemId) === f })),
      capturedTruncated, liveShips: fleetList.reduce((n, x) => n + (x.shipCount || 0), 0),
      stationCount: stations.length + (doctrine && doctrine.hive === true && Array.isArray(footholdList)
        ? footholdList.length : 0), tradeReady, tradeReason,
      ...(params.upkeep.homeSpaceIncomeEnabled === true ? { homeSpaceSystems: homeSpaceSystemsOf(f) } : {}) } };
  }

  function homeSpaceSystemsOf(f) {
    const b = deps.border && typeof deps.border.homeSpaceCountOf === "function" ? deps.border : null;
    const r = b ? call(() => b.homeSpaceCountOf(f), null) : null;
    if (r && r.ok === true && Number.isSafeInteger(r.count) && r.count >= 0) return r.count;
    counters.homeSpaceUnavailable += 1;
    return 0;
  }

  function hiveHomeSystems(f) {
    const h = typeof deps.getHive === "function" ? call(deps.getHive, null) : null;
    if (!h || typeof h.homeSystemCount !== "function") return 0;
    const n = call(() => h.homeSystemCount(f), 0);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  function trimService() {
    const t = typeof deps.getTrim === "function" ? call(deps.getTrim, null) : null;
    return t && typeof t.cursorOf === "function" && typeof t.noteReview === "function" ? t : null;
  }

  function readTrim(db, f, doctrine, mode, st) {
    const off = { mode: "off" };
    const t = trimService();
    const world = deps.world && deps.world.repository;
    if (!params.trim || !t || doctrine.capturesStations === false || !world
      || typeof world.listControlledByFaction !== "function") return off;
    const failed = { mode: "failed" };
    const done = call(() => journal.findByKey(db, trimDoneKey(f)), null);
    if (!done || !done.ok) return failed;
    if (done.found) return { mode: "done" };
    if (mode !== STATION_READY || !st || !st.repository) return { mode: "stations_off" };
    const live = call(() => st.repository.listStationsOfFaction(db, f, { states: [...LIVE_STATION_STATES] }), null);
    if (!live || !live.ok) return failed;
    const anchors = [...new Set(live.records.map((s) => s.systemId))].sort((a, b) => a - b);
    if (anchors.length === 0) return { mode: "no_anchors" };
    const cursor = call(() => t.cursorOf(f), null) || { afterSystemId: 0, passClean: true };
    const afterSystemId = isId(cursor.afterSystemId) ? cursor.afterSystemId : 0;
    const page = call(() => world.listControlledByFaction(db, f, { afterSystemId, limit: S.trimReadPerReview,
      includeInfluence: false }), null);
    if (!page || !page.ok || !Array.isArray(page.systems)) return failed;
    return { mode: "ready", anchors,
      rows: page.systems.map((x) => ({ systemId: x.systemId, state: x.occupationState,
        capturedAt: x.capturedAt === undefined ? null : x.capturedAt })),
      afterSystemId,
      nextAfterSystemId: isId(page.nextAfterSystemId) ? page.nextAfterSystemId : null,
      passClean: cursor.passClean === true };
  }

  function readTribute(db, f, at, st, mode) {
    const P = params.tribute;
    if (!P) return { ok: true, tribute: null };
    const recipient = call(() => registry.tributeRecipientOf(f), null);
    if (!isId(recipient)) return { ok: true, tribute: { mode: "none" } };
    const bucket = Math.floor(at / P.periodMs);
    const marker = journal.findByKey(db, tributeMarkerKey(f, bucket));
    if (!marker || !marker.ok) return marker || { ok: false, reason: "TRIBUTE_READ_FAILED" };
    const base = { mode: "ready", bucket, paid: marker.found === true, recipientFactionId: null, recipientStations: [],
      recipientMineralUnits: 0, maxStockQuantity: null };
    if (!registry.isActive(recipient) || mode !== STATION_READY || !st || !st.repository) {
      return { ok: true, tribute: base };
    }
    const list = st.repository.listStationsOfFaction(db, recipient, { states: [STATION_ONLINE] });
    if (!list || !list.ok) return list || { ok: false, reason: "TRIBUTE_READ_FAILED" };
    const limits = st.repository.limits || {};
    const stations = [];
    let units = 0;
    for (const s of [...list.records].sort((a, b) => (a.stationId < b.stationId ? -1 : 1))
      .slice(0, P.maxRecipientStations)) {
      const stock = st.repository.getStock(db, s.stationId);
      if (!stock || !stock.ok) return stock || { ok: false, reason: "TRIBUTE_READ_FAILED" };
      const minerals = {};
      for (const it of stock.items) {
        if (it.itemKind !== "mineral") continue;
        minerals[it.itemKey] = it.quantity;
        units += it.quantity;
      }
      const freeRows = stock.truncated || !Number.isSafeInteger(limits.maxStockItemsPerStation) ? 0
        : Math.max(0, limits.maxStockItemsPerStation - stock.items.length);
      stations.push({ stationId: s.stationId, systemId: s.systemId, minerals, freeRows });
    }
    return { ok: true, tribute: { ...base, recipientFactionId: recipient, recipientStations: stations,
      recipientMineralUnits: units,
      maxStockQuantity: Number.isSafeInteger(limits.maxStockQuantity) ? limits.maxStockQuantity : null } };
  }

  function captureAnchorsOf(stations) {
    return [...new Set(stations.map((s) => s.systemId))].sort((a, b) => a - b);
  }

  function stationsService() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const mode = st && typeof st.getMode === "function" ? call(() => st.getMode(), "off") : "off";
    return { st, mode: mode === "ready" || mode === "pending" ? mode : "off" };
  }

  function chunked(ids, size, fn) {
    for (let i = 0; i < ids.length; i += size) {
      const r = fn(ids.slice(i, i + size));
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  function readWorld(db, ids, into) {
    const world = deps.world && deps.world.repository;
    const todo = ids.filter((id) => !into.has(id));
    if (!world || typeof world.getSystems !== "function" || todo.length === 0) return { ok: true };
    const size = (world.limits && world.limits.maxBatchReadIds) || todo.length;
    return chunked(todo, size, (part) => {
      const r = world.getSystems(db, part, { includeInfluence: true });
      if (!r || !r.ok) return r || { ok: false, reason: "WORLD_READ_FAILED" };
      for (const s of r.systems) into.set(s.systemId, s);
      return { ok: true };
    });
  }

  function readBorderLine(db, f, territory, graph, rows) {
    const own = deps.border && typeof deps.border.lineOf === "function" ? call(() => deps.border.lineOf(f), null)
      : null;
    const picked = borderLineOf({ own, territoryIds: territory.map((x) => x.systemId),
      neighbors: (id) => graph.getNeighbors(id), secClassOf: (id) => {
        const v = graph.getSystem(id);
        return v ? v.secClass : null;
      }, secClasses: borderPostSecClassesOf(S), maxSystems: S.borderLineMaxSystems });
    const ids = [...new Set(picked.flatMap((x) => [x.systemId, ...x.outside]))];
    const seen = new Map();
    for (const id of ids) if (rows.has(id)) seen.set(id, rows.get(id));
    const r = readWorld(db, ids, seen);
    if (!r.ok) return r;
    const controllerOf = (id) => {
      const w = seen.get(id);
      if (w) return isId(w.controllerFactionId) ? w.controllerFactionId : null;
      const v = graph.getSystem(id);
      return v && isId(v.factionId) ? v.factionId : null;
    };
    return { ok: true, borderLine: picked.map((x) => {
      const v = graph.getSystem(x.systemId);
      return { systemId: x.systemId, secClass: v ? v.secClass : null,
        neighbours: x.outside.map((n) => ({ systemId: n, controllerFactionId: controllerOf(n) })) };
    }) };
  }

  function readExtraIntel(db, f, ids, have) {
    const extra = [...new Set(ids)].filter((id) => !have.has(id));
    let records = [];
    const size = (intelRepository.limits && intelRepository.limits.maxListLimit) || extra.length;
    const er = chunked(extra, size, (part) => {
      const e = intelRepository.listIntel(db, f, part);
      if (e.ok) records = records.concat(e.records);
      return e;
    });
    return er.ok ? { ok: true, records } : er;
  }

  function candidateIntelIds(sites, max) {
    const best = new Map();
    for (const s of sites || []) {
      if (!s || !isId(s.systemId) || !(s.richnessPermille > 0)) continue;
      const had = best.get(s.systemId);
      if (had === undefined || s.richnessPermille > had) best.set(s.systemId, s.richnessPermille);
    }
    return [...best.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, Number.isSafeInteger(max) && max > 0 ? max : 0).map(([id]) => id);
  }

  function escortThreatIds(mining, graph) {
    const P = params.minerEscort;
    const trips = mining && Array.isArray(mining.openTrips) ? mining.openTrips : [];
    const classes = new Set(P.secClasses);
    const belts = [...new Set(trips.filter((t) => t && t.state === "MINING" && classes.has(t.secClass)
      && isId(t.systemId)).map((t) => t.systemId))];
    if (belts.length === 0) return { ids: [], truncated: false };
    const dist = bfs(belts, neighborsFor(graph), { maxJumps: Math.max(0, S.minerEscortThreatJumps),
      maxSystems: S.maxBfsSystems });
    const ids = [...dist.keys()].sort((a, b2) => dist.get(a) - dist.get(b2) || a - b2);
    const max = Math.max(0, S.minerEscortIntelMaxSystems);
    if (ids.length <= max) return { ids, truncated: false };
    return { ids: ids.slice(0, max), truncated: true };
  }

  function transitRiskOf(f, graph) {
    if (!transitGateOn || !graph || typeof graph.findRoute !== "function") return {};
    const t = call(() => deps.getTransit(), null);
    if (!t || typeof t.routeRiskOf !== "function" || typeof t.getMode !== "function") return {};
    if (call(() => t.getMode(), null) !== "on") return {};
    return { transitRisk: createTransitRiskReader({ graph, transit: t, factionId: f,
      maxRoutes: S.maxTargetCandidates }) };
  }

  function readSnapshot(f, b, at, graph) {
    const tx = store.transaction("strategy.reviewRead", (db) => {
      const fr = strategyRepository.getFaction(db, f);
      if (!fr.ok) return fr;
      const row = fr.record;
      const entry = registry.getFaction(f);
      if (!row) return { ok: true, skip: "NO_ROW" };
      if (!entry) return { ok: true, skip: "NOT_IN_REGISTRY" };
      if (!registry.isActive(f)) return { ok: true, skip: "INACTIVE" };
      if (row.status === "ELIMINATED") return { ok: true, skip: "ELIMINATED" };
      const registryDoctrine = registry.getDoctrine(row.doctrineId) || registry.getDoctrine(entry.doctrineId);
      if (!registryDoctrine) return { ok: true, skip: "NO_DOCTRINE" };
      const theatre = [...new Set(registry.getCampaignsForFaction(f).filter((c) => deps.isCampaignOk(c.campaignId))
        .flatMap((c) => c.systemIds))].sort((a, b2) => a - b2);
      const isHostile = (o) => isId(o) && o !== f && !entry.allies.includes(o) && deps.hostility(f, o) === true;
      let truce = null;
      if (truceOn) {
        const tr = deps.truceRepository.listTrucedInDb(db, f, at);
        if (!tr || !tr.ok) return tr || { ok: false, reason: "TRUCE_READ_FAILED" };
        truce = tr.partners;
      }
      const isTarget = targetHostilityOf(isHostile, truce || []);
      const isPlaying = (o) => S.targetPassiveControllers === true || registry.isActive(o) === true;
      const isPassive = (w) => Boolean(w) && isId(w.controllerFactionId) && !isPlaying(w.controllerFactionId);
      const hiveFacade = typeof deps.getHive === "function" ? call(deps.getHive, null) : null;
      const hiveOn = Boolean(hiveFacade) && hiveFacade.enabled === true && typeof hiveFacade.isHive === "function";
      const isHive = (c) => hiveOn && call(() => hiveFacade.isHive(c), false) === true;
      const hiveSealed = (w, getRow) => Boolean(w) && isHive(w.controllerFactionId)
        && !(graph.getNeighbors(w.systemId) || []).some((n) => {
          const nr = getRow(n);
          return Boolean(nr) && nr.controllerFactionId === f;
        });

      const { st, mode } = stationsService();
      let stationRecords = [];
      let stations = [];
      if (mode === "ready" && st.repository) {
        const r = st.repository.listStationsOfFaction(db, f, { states: [STATION_ONLINE] });
        if (!r.ok) return r;
        stationRecords = r.records
          .sort((x, y) => x.systemId - y.systemId || (x.stationId < y.stationId ? -1 : 1));
        stations = stationRecords.map((s) => ({ systemId: s.systemId, stationId: s.stationId, kind: s.kind }));
      }

      const fl = fleets.repository.listFleetsByFaction(db, f, { limit: S.maxFleetsReadPerReview + 1,
        states: [...LIVE_FLEET_STATES] });
      if (!fl.ok) return fl;
      const fleetsTruncated = fl.fleets.length > S.maxFleetsReadPerReview;
      const fleetList = fl.fleets.slice(0, S.maxFleetsReadPerReview).map((x) => ({ fleetId: x.fleetId,
        version: x.version, state: x.state, fleetRole: x.fleetRole, systemId: x.currentSystemId,
        refitPending: x.refitPending === true, shipCount: x.shipCount,
        strength: strengthOf(x.composition, deps.powerTable), operationId: x.operationId, legSeq: x.legSeq,
        homeSystemId: x.homeSystemId, composition: x.composition, updatedAt: x.updatedAt }));

      const ops = [];
      for (const state of OPEN_OPERATION_STATES) {
        const r = fleets.repository.listOperations(db, { factionId: f, state, limit: S.maxOpenOperationsRead + 1 });
        if (!r.ok) return r;
        ops.push(...r.operations);
      }
      const operationsTruncated = ops.length > S.maxOpenOperationsRead;
      const operations = ops.sort((x, y) => (x.operationId < y.operationId ? -1 : 1))
        .slice(0, S.maxOpenOperationsRead).map((op) => ({ operationId: op.operationId, version: op.version,
          state: op.state, operationType: op.operationType, objective: op.objective,
          originSystemId: op.originSystemId, targetSystemId: op.targetSystemId, dueAt: op.dueAt,
          members: fleetList.filter((x) => x.operationId === op.operationId).length,
          orderedMembers: fleetList.filter((x) => x.operationId === op.operationId
            && ["PLANNED", "TRAVELLING", "STAGED"].includes(x.state)).length }));

      const rows = new Map();
      let r = readWorld(db, theatre, rows);
      if (!r.ok) return r;
      const footholds = (typeof deps.footholdsOf === "function" ? deps.footholdsOf(db, f) : { ok: true, footholds: [] });
      if (!footholds.ok) return footholds;
      const footholdList = footholds.footholds || [];
      const invaderE = paramsFor(f).invaderEconomy || null;
      const invaderRaidAnchors = invaderRaidAnchorsOf(footholdList, invaderE);
      const doctrine = invaderRaidAnchors.length > 0 ? invaderDoctrineOverlay(registryDoctrine, invaderE)
        : registryDoctrine;
      const bases = [...new Set([...stations.map((s) => s.systemId),
        ...footholdList.map((fh) => fh.systemId),
        ...(row.homeSystemId === null ? [] : [row.homeSystemId])])].sort((a, b2) => a - b2);
      r = readWorld(db, bases, rows);
      if (!r.ok) return r;
      const visited = new Set(bases);
      let frontier = [...bases];
      const chainJumps = doctrine.hive === true ? 0 : S.supplyChainJumps;
      for (let depth = 1; depth <= chainJumps && frontier.length > 0 && visited.size < S.maxBfsSystems;
        depth += 1) {
        const next = new Set();
        for (const id of frontier) {
          if (depth > 1 && !(rows.get(id) && rows.get(id).controllerFactionId === f)) continue;
          for (const nb of graph.getNeighbors(id) || []) if (!visited.has(nb)) next.add(nb);
        }
        const layer = [...next].sort((a, b2) => a - b2).slice(0, Math.max(0, S.maxBfsSystems - visited.size));
        r = readWorld(db, layer, rows);
        if (!r.ok) return r;
        for (const id of layer) visited.add(id);
        frontier = layer.filter((id) => rows.get(id) && rows.get(id).controllerFactionId === f);
      }
      const captureAnchors = captureAnchorsOf(stations);
      const capturesStations = doctrine.capturesStations !== false;
      const captureJumps = Math.max(0, Math.min(S.captureRangeFromStationJumps, config.graph.routeMaxJumps));
      const reachJumps = Math.max(0, Math.min(doctrine.reachJumps, S.maxReachJumps, config.graph.routeMaxJumps));
      const expansionOn = S.expansionEnabled === true && doctrine.expandsBeyondTheatre === true;
      const raidAnchors = doctrine.hive === true ? footholdList.map((x) => x.systemId)
        : (invaderRaidAnchors.length > 0 ? invaderRaidAnchors : captureAnchors);
      const raidsOn = doctrine.raidsBeyondTheatre === true && S.expansionRaidsEnabled === true
        && S.maxRaidTargets > 0 && raidAnchors.length > 0;
      const neighborsOf = neighborsFor(graph);
      const stationRange = capturesStations && captureAnchors.length > 0 && (expansionOn || raidsOn)
        ? bfs(captureAnchors, neighborsOf, { maxJumps: raidsOn ? Math.max(captureJumps, reachJumps) : captureJumps,
          maxSystems: S.maxBfsSystems })
        : null;
      const scanLimit = S.maxExpansionSystems > 0 ? Math.max(S.maxExpansionSystems, S.maxExpansionScanSystems || 0) : 0;
      const expansionScan = expansionCandidates({
        enabled: expansionOn,
        stationSystems: captureAnchors, theatre,
        neighbors: neighborsOf, getSystem: (id) => graph.getSystem(id),
        jumps: captureJumps,
        maxSystems: S.maxBfsSystems, limit: scanLimit, reach: stationRange || undefined,
        groups: capturesStations ? undefined : footholdList.map((fh) => ({
          starts: [fh.systemId],
          jumps: Math.min(fh.jumps, config.graph.routeMaxJumps),
        })) });
      const scanned = new Map();
      for (const id of expansionScan) if (rows.has(id)) scanned.set(id, rows.get(id));
      r = readWorld(db, expansionScan, scanned);
      if (!r.ok) return r;
      const expansionAccept = (id) => isBorderTarget(scanned.get(id), f, isTarget) && !isPassive(scanned.get(id))
        && !hiveSealed(scanned.get(id), (n) => scanned.get(n) || rows.get(n));
      const expansion = pickExpansion(expansionScan, expansionAccept, S.maxExpansionSystems);
      for (const id of expansionScan) {
        const w = scanned.get(id);
        if (w && (w.controllerFactionId === f || expansionAccept(id))) rows.set(id, w);
      }
      const border = { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 };
      const belt = deps.border && typeof deps.border.beltOf === "function" ? call(() => deps.border.beltOf(f), null)
        : null;
      if (belt && belt.ok === true && belt.mode === "ready" && belt.reach instanceof Map) {
        Object.assign(border, { mode: "ready", reach: belt.reach, captures: belt.captures === true });
        if (doctrine.borderTargets === true && S.borderEnabled === true) {
          const base = { reach: belt.reach, theatre, expansion, secClasses: doctrine.targetSecClasses || [],
            getSystem: (id) => graph.getSystem(id) };
          const scan = borderCandidates({ ...base, limit: Math.max(S.maxBorderSystems, S.maxBorderScanSystems) });
          const seen = new Map();
          for (const id of scan) if (rows.has(id)) seen.set(id, rows.get(id));
          r = readWorld(db, scan, seen);
          if (!r.ok) return r;
          const accept = (id) => isBorderTarget(seen.get(id), f, isTarget) && !isPassive(seen.get(id))
            && !hiveSealed(seen.get(id), (n) => seen.get(n) || rows.get(n));
          border.candidates = borderCandidates({ ...base, limit: S.maxBorderSystems, accept });
          border.rejected = scan.filter((id) => !accept(id)).length;
          for (const id of border.candidates) rows.set(id, seen.get(id));
        }
      }
      let raidTargets = [];
      if (raidsOn) {
        const range = stationRange || bfs(raidAnchors, neighborsOf, { maxJumps: Math.max(captureJumps, reachJumps),
          maxSystems: S.maxBfsSystems });
        const scan = rangeCandidates({ reach: range, theatre, getSystem: (id) => graph.getSystem(id),
          jumps: reachJumps, limit: S.maxRaidScanSystems,
          ...(doctrine.hive === true ? { excludeRegionIds: new Set(entry.homeRegionIds) } : {}) });
        const seen = new Map();
        for (const id of scan) if (rows.has(id)) seen.set(id, rows.get(id));
        r = readWorld(db, scan, seen);
        if (!r.ok) return r;
        const accept = (id) => {
          const w = seen.get(id);
          return Boolean(w) && isId(w.controllerFactionId) && w.controllerFactionId !== f
            && isTarget(w.controllerFactionId) && !isPassive(w) && !isHive(w.controllerFactionId);
        };
        const accepted = scan.filter(accept);
        const hostileLive = new Map();
        const preference = S.raidTargetPreference === true;
        if (preference && mode === "ready" && st.repository && typeof st.repository.countLiveBySystem === "function"
          && accepted.length > 0) {
          const c = st.repository.countLiveBySystem(db, accepted);
          if (!c.ok) return c;
          for (const x of c.rows) {
            if (isHostile(x.factionId)) hostileLive.set(x.systemId, (hostileLive.get(x.systemId) || 0) + x.count);
          }
        }
        const rank = (id) => (preference ? [(hostileLive.get(id) || 0) > 0 ? 0 : 1,
          registry.isActive(seen.get(id).controllerFactionId) ? 0 : 1] : []).concat([range.get(id), id]);
        const keyed = accepted.map((id) => ({ id, key: rank(id) }));
        keyed.sort((x, y) => {
          for (let i = 0; i < x.key.length; i += 1) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i];
          return 0;
        });
        raidTargets = keyed.slice(0, S.maxRaidTargets).map((x) => x.id);
        for (const id of raidTargets) rows.set(id, seen.get(id));
      }
      const world = deps.world && deps.world.repository;
      let occupations = [];
      const hiveClaimIds = new Set();
      let territory = [];
      let territoryTruncated = false;
      let capturedRows = [];
      let consolidating = null;
      const threats = { mode: "off", truncated: false, items: [] };
      const lostHome = { mode: "off", truncated: false, afterSystemId: 0, nextAfterSystemId: 0, systemIds: [] };
      if (world && typeof world.listByOccupier === "function") {
        const o = world.listByOccupier(db, f, { limit: S.maxOpenOperationsRead });
        if (!o.ok) return o;
        occupations = o.systems.map((x) => ({ systemId: x.systemId, state: x.occupationState,
          occupier: x.occupierFactionId, phaseDueAt: x.phaseDueAt === undefined ? null : x.phaseDueAt,
          homeOwn: x.homeFactionId === f, sinceAt: x.lastStateChangeAt === undefined ? null : x.lastStateChangeAt }));
        if (hiveOn) for (const x of o.systems) if (isHive(x.controllerFactionId)) hiveClaimIds.add(x.systemId);
        const t = world.listControlledByFaction(db, f, { capturedOnly: true, limit: S.maxTerritoryRead + 1 });
        if (!t.ok) return t;
        territoryTruncated = t.systems.length > S.maxTerritoryRead;
        capturedRows = t.systems.slice(0, S.maxTerritoryRead);
        territory = capturedRows.filter((x) => x.occupationState === "STABLE")
          .map((x) => ({ systemId: x.systemId, detachedSinceAt: x.detachedSinceAt }));
        if (S.garrisonConsolidateEnabled === true && S.garrisonReinforceEnabled === true) {
          consolidating = capturedRows.filter((x) => (x.occupationState === "OCCUPIED"
            || x.occupationState === "CONSOLIDATING") && (x.detachedSinceAt === null || x.detachedSinceAt === undefined))
            .map((x) => ({ systemId: x.systemId, state: x.occupationState }));
        }
        if (typeof world.listThreatened === "function" && S.maxThreatsRead > 0) {
          const th = world.listThreatened(db, f, { limit: S.maxThreatsRead + 1, includeInfluence: true });
          if (!th.ok) return th;
          threats.mode = "ready";
          threats.truncated = th.systems.length > S.maxThreatsRead;
          const threatItems = th.systems.slice(0, S.maxThreatsRead);
          for (const x of threatItems) if (!rows.has(x.systemId)) rows.set(x.systemId, x);
          threats.items = threatItems.map((x) => {
            const inf = Array.isArray(x.influence) ? x.influence.find((i) => i.factionId === x.occupierFactionId) : null;
            return { systemId: x.systemId, state: x.occupationState, occupier: x.occupierFactionId,
              occupierStrength: inf ? inf.garrisonStrength : 0, phaseDueAt: x.phaseDueAt === undefined ? null : x.phaseDueAt };
          });
        }
        if (entry.kind !== "invader" && typeof world.listLostHome === "function" && S.maxLostHomeRead > 0) {
          const cursor = lostHomeCursor.get(f) || 0;
          let lh = world.listLostHome(db, f, { limit: S.maxLostHomeRead + 1, afterSystemId: cursor });
          if (!lh.ok) return lh;
          if (lh.systems.length === 0 && cursor > 0) {
            lh = world.listLostHome(db, f, { limit: S.maxLostHomeRead + 1, afterSystemId: 0 });
            if (!lh.ok) return lh;
          }
          lostHome.mode = "ready";
          lostHome.truncated = lh.systems.length > S.maxLostHomeRead;
          const page = lh.systems.slice(0, S.maxLostHomeRead);
          const lr = readWorld(db, page.map((x) => x.systemId), rows);
          if (!lr.ok) return lr;
          lostHome.systemIds = page.map((x) => x.systemId);
          lostHome.afterSystemId = cursor;
          lostHome.nextAfterSystemId = lostHome.truncated ? page[page.length - 1].systemId : 0;
          if (lostHome.truncated) counters.lostHomeTruncated += 1;
        }
      }
      const upkept = readUpkeep(db, f, row, at, capturedRows, territoryTruncated, fleetList, stations, doctrine,
        footholdList);
      if (!upkept.ok) return upkept;
      const fronts = observationFronts(operations);
      const sightIds = observationOrder(fleetList, fronts, theatre, S.maxObservationsPerReview);
      r = readWorld(db, sightIds, rows);
      if (!r.ok) return r;

      const known = [...rows.keys()].sort((a, b2) => a - b2);
      const hostileStations = new Map();
      const liveStations = new Map();
      const ownLiveStations = new Map();
      if (mode === "ready" && st.repository && typeof st.repository.countLiveBySystem === "function"
        && known.length > 0) {
        const c = st.repository.countLiveBySystem(db, known);
        if (!c.ok) return c;
        for (const x of c.rows) {
          if (isHostile(x.factionId)) hostileStations.set(x.systemId, (hostileStations.get(x.systemId) || 0) + x.count);
          liveStations.set(x.systemId, (liveStations.get(x.systemId) || 0) + x.count);
          if (x.factionId === f) ownLiveStations.set(x.systemId, (ownLiveStations.get(x.systemId) || 0) + x.count);
        }
      }
      const presence = deps.presence;
      const occEff = S.ownInfluenceEffective === true ? occupationService() : null;
      const effOf = occEff && typeof occEff.effectiveScoreOf === "function" ? occEff.effectiveScoreOf : null;
      const rawOn = Boolean(params.mining && params.mining.ownStationSystemsEnabled === true);
      const dev = typeof deps.getDevIndices === "function" ? call(() => deps.getDevIndices(), null) : null;
      const devGarrisonOf = (id, controller) => {
        if (!dev || typeof dev.effectsOf !== "function" || !Number.isSafeInteger(controller) || controller === f) {
          return 0;
        }
        const e = call(() => dev.effectsOf(id), null);
        return e && Number.isSafeInteger(e.garrisonPoints) && e.garrisonPoints > 0 ? e.garrisonPoints : 0;
      };
      const systems = known.map((id) => {
        const s = rows.get(id);
        const controller = s.controllerFactionId;
        const inf = Array.isArray(s.influence) ? s.influence.find((x) => x.factionId === controller) : null;
        const devGarrison = devGarrisonOf(id, controller);
        return { systemId: id, controllerFactionId: controller, occupationState: s.occupationState || null,
          ...(devGarrison > 0 ? { devGarrison } : {}),
          ownInfluence: ownInfluenceOf(s, f, at, effOf),
          ...(rawOn ? { ownInfluenceRaw: ownInfluenceOf(s, f, at, null) } : {}),
          occupierFactionId: Number.isSafeInteger(s.occupierFactionId) ? s.occupierFactionId : null,
          homeFactionId: Number.isSafeInteger(s.homeFactionId) ? s.homeFactionId : null,
          controllerGarrison: inf ? inf.garrisonStrength : 0, hostileStations: hostileStations.get(id) || 0,
          liveStations: liveStations.get(id) || 0, ownLiveStations: ownLiveStations.get(id) || 0,
          observed: call(() => Boolean(presence && typeof presence.isObserved === "function"
            && presence.isObserved(id) === true), false) };
      });

      const mined = readMining(db, f, systems, stations.map((s) => s.systemId), doctrine, at);
      if (!mined.ok) return mined;
      const minerTargets = readMinerTargets(db, f, at);
      const capsuleerTargets = readCapsuleerTargets(db, f);
      const produced = readProduction(db, f, stations, st, mode, at);
      if (!produced.ok) return produced;
      const ladderOn = Boolean(params.production && params.production.capitalLadderEnabled === true);
      const productionRead = ladderOn ? withSecClass(produced.production, graph) : produced.production;
      const shipped = readLogistics(db, f, fl.fleets.slice(0, S.maxFleetsReadPerReview));
      if (!shipped.ok) return shipped;
      const built = readConstruction(db, f, graph, at, { territory, entry, doctrine, stations, systems,
        st: mode === "ready" ? st : null });
      if (!built.ok) return built;
      const besieged = readSiege(db, f);
      if (!besieged.ok) return besieged;
      const controlled = [...new Set([...systems.filter((x) => x.controllerFactionId === f).map((x) => x.systemId),
        ...territory.map((x) => x.systemId), ...stations.map((x) => x.systemId)])];
      const playerBesieged = readPlayerSiege(db, f, at, { doctrine, graph, controlled });
      if (!playerBesieged.ok) return playerBesieged;
      const harvestRaid = readHarvestRaid(db, f, at, entry.kind, { doctrine, graph, controlled });
      const playerSovRead = readPlayerSovTargets(db, f, at);
      const playerValue = readPlayerValue(at, playerSovRead, playerBesieged.playerSiege);
      const invaderBeachheads = readInvaderBeachheads(db, entry.kind, { graph, controlled });
      const worldBosses = readWorldBossTargets(db, entry.kind, { graph, controlled });
      const warOn = warPricingOn();
      const treasured = readTreasury(db, f, entry, stations, at, doctrine,
        warOn ? params.trade.warPricingWindowDays : undefined);
      if (!treasured.ok) return treasured;
      const traded = readTrade(db, f, stationRecords, at,
        warOn ? warPressureOf(treasured.treasury, threats.items.length) : undefined);
      if (!traded.ok) return traded;
      const sentried = readSentries(db, f, graph, { rows, systems, stations });
      if (!sentried.ok) return sentried;
      const trimmed = readTrim(db, f, doctrine, mode, st);
      const tributed = readTribute(db, f, at, st, mode);
      if (!tributed.ok) return tributed;

      const intelIds = [...new Set([...theatre, ...sightIds, ...expansion, ...border.candidates, ...raidTargets,
        ...threats.items.map((x) => x.systemId), ...lostHome.systemIds])];
      const il = intelRepository.listIntel(db, f, intelIds);
      if (!il.ok) return il;
      let borderLine = null;
      let extraRecords = null;
      let escortIntelTruncated = false;
      const extraIds = [];
      if (S.borderPostsEnabled === true || S.minerEscortEnabled === true) {
        const bl = readBorderLine(db, f, territory, graph, rows);
        if (!bl.ok) return bl;
        borderLine = bl.borderLine;
        extraIds.push(...borderLine.flatMap((x) => [x.systemId, ...x.neighbours.map((n) => n.systemId)]));
      }
      if (params.minerEscort) {
        const threat = escortThreatIds(mined.mining, graph);
        escortIntelTruncated = threat.truncated;
        extraIds.push(...threat.ids);
      }
      if (minerTargets !== null && params.minerRaid
        && (params.minerRaid.preferUnescorted === true || params.minerRaid.strengthCheck === true)) {
        extraIds.push(...minerTargets.targets.map((t) => t && t.systemId).filter(isId));
      }
      if (params.mining && params.mining.candidateIntelEnabled === true && mined.mining
        && mined.mining.mode === "ready") {
        extraIds.push(...candidateIntelIds(mined.mining.sites, params.mining.candidateIntelMaxSystems));
      }
      if (extraIds.length > 0) {
        const er = readExtraIntel(db, f, extraIds, new Set(intelIds));
        if (!er.ok) return er;
        extraRecords = er.records;
      }
      const intelOf = (x) => ({ systemId: x.systemId, observedAt: x.observedAt,
        hostileFleets: x.hostileFleets, hostileShips: x.hostileShips, hostileStrength: x.hostileStrength,
        hostileStations: x.hostileStations, controllerFactionId: x.controllerFactionId,
        source: x.source });
      const intel = il.records.map(intelOf);
      const extraIntel = extraRecords === null ? null : extraRecords.map(intelOf);
      let reconCooldowns = null;
      if (reconLossOn) {
        const rc = deps.reconLossRepository.listCooldowns(db, f, at, S.maxReconLossRowsPerFaction);
        if (!rc.ok) return rc;
        reconCooldowns = rc.systemIds;
      }
      let playerActivity = null;
      if (playerActivityOn) {
        const pa = deps.playerActivityRepository.listActive(db, f, at, S.maxPlayerActivityRowsPerFaction);
        if (!pa.ok) return pa;
        playerActivity = pa.items;
      }
      let attackLosses = null;
      if (attackLossOn) {
        const al = deps.attackLossRepository.listActive(db, f, at, S.maxAttackLossRowsPerFaction);
        if (!al.ok) return al;
        attackLosses = new Map(al.records.map((r) => [r.systemId,
          Object.freeze({ losses: r.losses, cooldownUntil: r.cooldownUntil })]));
      }

      const sightings = [];
      let sighted = null;
      if (typeof fleets.repository.listFleetsInSystems === "function" && sightIds.length > 0) {
        const batch = fleets.repository.listFleetsInSystems(db, sightIds, { limitPerSystem: S.maxFleetsReadPerReview,
          states: STANDING_STATES });
        if (batch.ok) sighted = batch.bySystem;
        else if (batch.reason !== "BATCH_TOO_LARGE") return batch;
      }
      for (const sid of sightIds) {
        const inSys = sighted ? { ok: true, fleets: sighted.get(sid) }
          : fleets.repository.listFleetsInSystem(db, sid, { limit: S.maxFleetsReadPerReview,
            states: [...STANDING_STATES] });
        if (!inSys.ok) return inSys;
        const byFaction = new Map();
        for (const x of inSys.fleets) {
          if (!isHostile(x.factionId)) continue;
          const h = byFaction.get(x.factionId) || { factionId: x.factionId, fleets: 0, ships: 0, strength: 0 };
          h.fleets += 1;
          h.ships += x.shipCount;
          h.strength += strengthOf(x.composition, deps.powerTable);
          byFaction.set(x.factionId, h);
        }
        const sys = rows.get(sid);
        sightings.push({ systemId: sid, hostile: [...byFaction.values()].sort((x, y) => x.factionId - y.factionId),
          hostileStations: hostileStations.get(sid) || 0, controllerFactionId: sys ? sys.controllerFactionId : null });
      }
      const intruded = readIntrudersOf(db, { enabled: S.intruderDefenseEnabled === true && S.defenseEnabled === true,
        factionId: f, homeSystemId: row.homeSystemId, stationSystemIds: stations.map((s) => s.systemId), rows,
        hostileStations, isHostile, repository: fleets.repository, powerTable: deps.powerTable,
        maxSystems: S.intruderScanMaxSystems, limitPerSystem: S.maxFleetsReadPerReview });
      if (!intruded.ok) return intruded;

      let hiveFrontIds = null;
      if (hiveOn) {
        const byType = kindsByType(params.kinds || []);
        const targets = [...new Set(operations.filter((op) => (byType.get(op.operationType) || [])
          .some((k) => k.opensFront === true)).map((op) => op.targetSystemId).filter(isId))].sort((a, b2) => a - b2);
        const frontRows = new Map();
        for (const id of targets) if (rows.has(id)) frontRows.set(id, rows.get(id));
        r = readWorld(db, targets, frontRows);
        if (!r.ok) return r;
        const ids = new Set(hiveClaimIds);
        for (const id of targets) {
          const w = frontRows.get(id);
          if (w && isHive(w.controllerFactionId)) ids.add(id);
        }
        hiveFrontIds = [...ids].sort((a, b2) => a - b2);
      }
      let hiveSwarm = null;
      const SW = params.hive && params.hive.swarm;
      if (doctrine.hive === true && SW) {
        const bucket = swarmBucketOf(at, SW.cooldownMs);
        const m = journal.findByKey(db, hiveSwarmKey(f, bucket));
        if (!m || !m.ok) return m || { ok: false, reason: "HIVE_SWARM_READ_FAILED" };
        hiveSwarm = { bucket, done: m.found === true };
      }

      return { ok: true, ...(escortIntelTruncated ? { escortIntelTruncated: true } : {}), snapshot: {
        v: 1, factionId: f, round: b, at, seed: deriveSeed(worldSeed, "strategy", f, b),
        faction: { status: row.status, homeSystemId: row.homeSystemId, doctrineId: row.doctrineId,
          resourceUnits: row.resourceUnits, reserveUnits: row.reserveUnits, frontLimit: row.frontLimit,
          version: row.version },
        entry: { kind: entry.kind, maxActiveFronts: invaderEntryFronts(entry.maxActiveFronts, invaderE),
          allies: [...entry.allies],
          homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId,
          ...(params.hqGarrison ? { hqSystemId: isId(entry.hqSystemId) ? entry.hqSystemId : null } : {}) },
        doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
          expandsBeyondTheatre: doctrine.expandsBeyondTheatre === true,
          operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates,
          stockTemplates: doctrine.stockTemplates,
          ownSpace: doctrine.ownSpace === undefined ? null : doctrine.ownSpace,
          borderReachKey: doctrine.borderReachKey === undefined ? null : doctrine.borderReachKey,
          borderTargets: doctrine.borderTargets === true, borderCaptures: doctrine.borderCaptures === true,
          captureTargets: Array.isArray(doctrine.captureTargets) ? [...doctrine.captureTargets] : undefined,
          targetSecClasses: Array.isArray(doctrine.targetSecClasses) ? [...doctrine.targetSecClasses] : undefined,
          returnToBase: doctrine.returnToBase === true,
          confinedToBelt: doctrine.confinedToBelt === true,
          buildsStations: doctrine.buildsStations === true, capturesStations: doctrine.capturesStations === true,
          consolidates: doctrine.consolidates === true,
          hullsRequired: hullsRequiredOf(doctrine, params.tribute,
            () => call(() => registry.isTributeRecipient(f), false)),
          fieldsHunters: doctrine.fieldsHunters === true,
          hunterTemplate: Array.isArray(doctrine.hunterTemplate) ? [...doctrine.hunterTemplate] : [],
          hunterComposition: Array.isArray(doctrine.hunterComposition) ? [...doctrine.hunterComposition] : [],
          hoardCapped: doctrine.hoardCapped === true, raidsBeyondTheatre: doctrine.raidsBeyondTheatre === true,
          hive: doctrine.hive === true },
        ...(doctrine.hive === true ? { hive: { homeSystems: hiveHomeSystems(f),
          ...(hiveSwarm ? { swarm: hiveSwarm } : {}) } } : {}),
        border,
        ...(borderLine === null ? {} : { borderLine }),
        theatre,
        neighbors: neighborsFor(graph),
        regionOf: (id) => {
          const v = graph.getSystem(id);
          return v && Number.isSafeInteger(v.regionId) ? v.regionId : null;
        },
        isHostile: isTarget,
        isPlaying,
        ...(truce === null ? {} : { truce: [...truce] }),
        isHive,
        ...(hiveFrontIds === null ? {} : { hiveFrontIds }),
        stationsMode: mode, stations, captureAnchors, systems, fleets: fleetList, fleetsTruncated, operations, operationsTruncated,
        intel, sightings, occupations, territory, territoryTruncated, expansion, raidTargets, mining: mined.mining,
        ...(consolidating === null ? {} : { consolidating }),
        ...(extraIntel === null ? {} : { extraIntel }),
        production: productionRead, upkeep: upkept.upkeep, logistics: shipped.logistics,
        ...(ladderOn || params.capitalAttach ? { capitalClasses: capitalClassesOf(f) } : {}),
        construction: built.construction, siege: besieged.siege, trade: traded.trade, trim: trimmed,
        ...(playerBesieged.playerSiege === null ? {} : { playerSiege: playerBesieged.playerSiege }),
        ...(harvestRaid === null ? {} : { harvestRaid }),
        ...(playerSovRead === null ? {} : playerSovRead),
        ...(playerValue === null ? {} : { playerValue }),
        ...(invaderBeachheads === null ? {} : { invaderBeachheads }),
        ...(worldBosses === null ? {} : { worldBosses }),
        ...(tributed.tribute === null ? {} : { tribute: tributed.tribute }),
        ...(treasured.treasury === null ? {} : { treasury: treasured.treasury }),
        ...(sentried.sentries === null ? {} : { sentries: sentried.sentries }),
        ...(reconCooldowns === null ? {} : { reconCooldowns }),
        ...(playerActivity === null ? {} : { playerActivity }),
        ...(attackLosses === null ? {} : { attackLosses }),
        ...transitRiskOf(f, graph),
        ...(minerTargets === null ? {} : { minerTargets }),
        ...(capsuleerTargets === null ? {} : { capsuleerTargets }),
        footholds: footholdList,
        huntReady: huntReady(),
        capturedIds: capturedRows.map((x) => x.systemId),
        threats, lostHome,
        ...(intruded.intruders === null ? {} : { intruders: intruded.intruders }),
        coreOwners: getCoreIndex(config).systems,
        bastionOwners: getCoreIndex(config).bastions,
        lowsecIds: lowsecIdsOf({ captureEnabled: params.lowsecCaptureEnabled, theatre, expansion,
          borderCandidates: border.candidates, getSystem: (id) => graph.getSystem(id) }) } }
      });
    if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
    return tx.value;
  }

  function mobilizeInTx(db, snapshot, mob, key, local, at) {
    const f = snapshot.factionId;
    const corpId = virtualCorpFor(f, mob.role) ?? registry.corporationFor(f, mob.role);
    const created = fleets.repository.createFleet(db, { factionId: f,
      corporationId: corpId, currentSystemId: mob.systemId,
      homeSystemId: mob.homeSystemId, fleetRole: mob.role, doctrineId: snapshot.doctrine.doctrineId,
      composition: fleetCompositionOf(mob) }, key);
    if (!created.ok) return created;
    if (created.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
    const hulls = Array.isArray(mob.hulls) ? mob.hulls : [];
    if (hulls.length > 0) {
      const took = takeHullsInTx(db, f, mob, hulls, `${key}:hulls`, at);
      if (!took.ok) return took;
    }
    const paid = strategyRepository.applyFactionChange(db, { factionId: f, expectedVersion: local.factionVersion,
      key: `${key}:faction`, reason: "MOBILIZE", at, deltas: { resourceUnits: -mob.cost.resourceUnits,
        reserveUnits: -mob.cost.reserveUnits } });
    if (!paid.ok) return paid;
    if (paid.duplicate || !paid.record) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:faction` };
    local.factionVersion = paid.record.version;
    return { ok: true, fleetId: created.fleetId, version: created.version };
  }

  function takeHullsInTx(db, f, mob, hulls, key, at) {
    const paidPart = paidOf(mob.composition, freeHullGroupsOf());
    const want = hullDeltas(paidPart.map((e) => ({ hullGroup: e.hullGroup, count: e.count })), -1);
    if (!want.ok) return want;
    const same = want.deltas.length === hulls.length && want.deltas.every((d, i) => hulls[i]
      && hulls[i].itemKey === d.itemKey && hulls[i].count === -d.delta);
    if (!same) return { ok: false, reason: "HULLS_MISMATCH" };
    const { st, mode } = stationsService();
    if (mode !== "ready" || !st || !st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const g = typeof mob.stationId === "string" ? st.repository.getStation(db, mob.stationId) : null;
    if (!g || !g.ok) return g || { ok: false, reason: "HULL_STATION_INVALID" };
    const station = g.record;
    if (!station || station.state !== STATION_ONLINE || station.ownerFactionId !== f
      || station.systemId !== mob.systemId) {
      return { ok: false, reason: "HULL_STATION_INVALID" };
    }
    const r = st.repository.applyStockChange(db, { stationId: mob.stationId, key, reason: "MOBILIZE", at,
      deltas: want.deltas });
    if (!r.ok) return r;
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
    return { ok: true };
  }

  function replenishInTx(db, snapshot, intent, ik, local, at) {
    const f = snapshot.factionId;
    const add = Array.isArray(intent.add) ? intent.add : [];
    if (add.length === 0 || add.some((a) => !a || !HULL_GROUPS.includes(a.hullGroup) || !Number.isSafeInteger(a.count)
      || a.count < 1)) {
      return { ok: false, reason: "REPLENISH_INVALID", detail: "add" };
    }
    if (add.some((a) => a.typeId !== undefined)) {
      const classes = capitalClassesOf(f);
      if (intent.capital !== true || !params.capitalReplenish || add.some((a) => !CAPITAL_HULL_GROUPS.includes(a.hullGroup)
        || a.count !== 1 || !Number.isSafeInteger(a.typeId) || a.typeId !== classes[a.hullGroup])) {
        return { ok: false, reason: "REPLENISH_INVALID", detail: "typeId" };
      }
    } else if (intent.capital !== undefined) {
      return { ok: false, reason: "REPLENISH_INVALID", detail: "typeId" };
    }
    const ships = add.reduce((n, a) => n + a.count, 0);
    if (!intent.cost || intent.cost.resourceUnits !== ships * S.mobilizeResourcePerShip
      || intent.cost.reserveUnits !== ships * S.mobilizeReservePerShip) {
      return { ok: false, reason: "REPLENISH_INVALID", detail: "cost" };
    }
    const want = hullDeltas(add, -1);
    if (!want.ok) return want;
    const { st, mode } = stationsService();
    if (mode !== "ready" || !st || !st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const g = typeof intent.stationId === "string" ? st.repository.getStation(db, intent.stationId) : null;
    if (!g || !g.ok) return g || { ok: false, reason: "HULL_STATION_INVALID" };
    const station = g.record;
    if (!station || station.state !== STATION_ONLINE || station.ownerFactionId !== f
      || station.systemId !== intent.systemId) {
      return { ok: false, reason: "HULL_STATION_INVALID" };
    }
    if (intent.freeHulls !== undefined) {
      const fleet = intent.freeHulls === true && params.replenish && params.replenish.freeHulls === true
        ? snapshot.fleets.find((x) => x.fleetId === intent.fleetId) : null;
      if (!fleet || createHullLedger(snapshot, params).needs(fleet.fleetRole) !== false) {
        return { ok: false, reason: "REPLENISH_INVALID", detail: "freeHulls" };
      }
    } else {
      const took = st.repository.applyStockChange(db, { stationId: intent.stationId, key: `${ik}:hulls`,
        reason: "REPLENISH", at, deltas: want.deltas });
      if (!took.ok) return took;
      if (took.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:hulls` };
    }
    const r = fleets.repository.replenish(db, { fleetId: intent.fleetId, expectedVersion: intent.expectedVersion,
      systemId: intent.systemId, add: add.map((a) => ({ hullGroup: a.hullGroup, count: a.count,
        ...(a.typeId !== undefined ? { typeId: a.typeId } : {}) })) }, `${ik}:fleet`);
    if (!r.ok) return r;
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:fleet` };
    const paid = strategyRepository.applyFactionChange(db, { factionId: f, expectedVersion: local.factionVersion,
      key: `${ik}:faction`, reason: "REPLENISH", at, deltas: { resourceUnits: -intent.cost.resourceUnits,
        reserveUnits: -intent.cost.reserveUnits } });
    if (!paid.ok) return paid;
    if (paid.duplicate || !paid.record) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:faction` };
    local.factionVersion = paid.record.version;
    return { ok: true, ships, shipCount: r.shipCount };
  }

  function disbandInTx(db, snapshot, intent, ik, at) {
    const f = snapshot.factionId;
    const fleetRole = intent.fleetRole === undefined ? LOGISTICS_ROLE : intent.fleetRole;
    const relief = intent.reason === RELIEF_REASON && Boolean(params.upkeep)
      && params.upkeep.deficitReliefEnabled === true && RELIEF_ROLES.includes(fleetRole);
    if (fleetRole !== LOGISTICS_ROLE && !relief && !(params.stranded && STRANDED_ROLES.includes(fleetRole))) {
      return { ok: false, reason: "DISBAND_ROLE_INVALID" };
    }
    let station = null;
    let stockRepo = null;
    if (intent.stationId !== null) {
      const { st, mode } = stationsService();
      if (mode !== "ready" || !st || !st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
      stockRepo = st.repository;
      const g = typeof intent.stationId === "string" ? st.repository.getStation(db, intent.stationId) : null;
      if (!g || !g.ok) return g || { ok: false, reason: "HULL_STATION_INVALID" };
      station = g.record;
      if (!station || station.state !== STATION_ONLINE || station.ownerFactionId !== f
        || station.systemId !== intent.systemId) {
        return { ok: false, reason: "HULL_STATION_INVALID" };
      }
    }
    const r = fleets.repository.disband(db, { fleetId: intent.fleetId, expectedVersion: intent.expectedVersion,
      systemId: intent.systemId, fleetRole }, `${ik}:fleet`);
    if (!r.ok) return r;
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:fleet` };
    const ships = r.removed.reduce((n, e) => n + e.count, 0);
    let hullsReturned = 0;
    let hullsLost = 0;
    const paidRemoved = paidOf(r.removed, freeHullGroupsOf());
    const paidShips = paidRemoved.reduce((n, e) => n + e.count, 0);
    if (intent.returnHulls === true && station && paidRemoved.length > 0) {
      const want = hullDeltas(paidRemoved, 1);
      if (!want.ok) return want;
      const put = stockRepo.applyStockChange(db, { stationId: intent.stationId, key: `${ik}:hulls`,
        reason: "DISBAND", at, deltas: want.deltas });
      if (put.ok && put.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:hulls` };
      if (put.ok) hullsReturned = paidShips;
      else if (HULLS_LOST_REASONS.includes(put.reason)) hullsLost = paidShips;
      else return put;
    }
    return { ok: true, fleetId: intent.fleetId, reason: intent.reason, ships, hullsReturned, hullsLost };
  }

  function mergeInTx(db, intent, ik) {
    const P = params.merge;
    if (!P) return { ok: false, reason: "MERGE_DISABLED" };
    const k = intent.keeper;
    const a = intent.absorbed;
    if (!isId(intent.systemId) || !P.roles.includes(intent.fleetRole) || !k || !a || typeof k.fleetId !== "string"
      || typeof a.fleetId !== "string" || k.fleetId === a.fleetId) {
      return { ok: false, reason: "MERGE_INVALID" };
    }
    const d = fleets.repository.disband(db, { fleetId: a.fleetId, expectedVersion: a.expectedVersion,
      systemId: intent.systemId, fleetRole: intent.fleetRole }, `${ik}:fleet`);
    if (!d.ok) return d;
    if (d.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:fleet` };
    if (!Array.isArray(d.removed) || d.removed.length === 0) return { ok: false, reason: "MERGE_INVALID", detail: "empty" };
    const r = fleets.repository.replenish(db, { fleetId: k.fleetId, expectedVersion: k.expectedVersion,
      systemId: intent.systemId, add: d.removed.map((e) => ({ hullGroup: e.hullGroup, count: e.count })) },
    `${ik}:merge`);
    if (!r.ok) return r;
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:merge` };
    const ships = d.removed.reduce((n, e) => n + e.count, 0);
    return { ok: true, keeperId: k.fleetId, absorbedId: a.fleetId, ships, shipCount: r.shipCount };
  }

  function garrisonReleaseInTx(db, intent, ik) {
    if (!params.garrisonRelease) return { ok: false, reason: "GARRISON_RELEASE_DISABLED" };
    const r = fleets.repository.reassignRole(db, { fleetId: intent.fleetId, expectedVersion: intent.expectedVersion,
      from: GARRISON_ROLE, to: intent.to }, `${ik}:role`);
    if (!r.ok) return r;
    return r.duplicate ? { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:role` } : r;
  }

  function logisticsUpgradeRefusal(snapshot, intent) {
    const capitals = CAPITAL_CARRIER_GROUPS;
    if (intent.add.length !== 1 || !capitals.includes(intent.add[0].hullGroup) || intent.add[0].count !== 1) {
      return "logistics add";
    }
    if (intent.remove.length !== 1 || intent.remove[0].hullGroup !== "industrial") return "logistics remove";
    const lg = snapshot.logistics;
    if (!lg || lg.mode !== "ready" || lg.truncated === true
      || (lg.busyFleetIds || []).includes(intent.fleetId)) return "logistics fleet busy";
    const fleet = (snapshot.fleets || []).find((x) => x.fleetId === intent.fleetId);
    if (!fleet || fleet.version !== intent.expectedVersion) return "logistics fleet";
    const n = (g) => (fleet.composition || []).filter((e) => e.hullGroup === g).reduce((s, e) => s + e.count, 0);
    if (capitals.some((g) => n(g) > 0)) return "logistics fleet has a capital carrier";
    if (intent.remove[0].count !== n("industrial")) return "logistics remove not all industrials";
    return null;
  }

  function upgradeInTx(db, snapshot, intent, ik, at) {
    const f = snapshot.factionId;
    const free = freeHullGroupsOf();
    const listOk = (list) => Array.isArray(list) && list.every((e) => e && HULL_GROUPS.includes(e.hullGroup)
      && Number.isSafeInteger(e.count) && e.count >= 1)
      && new Set(list.map((e) => e.hullGroup)).size === list.length;
    if (intent.fleetRole !== MINING_ROLE && intent.fleetRole !== LOGISTICS_ROLE) {
      return { ok: false, reason: "UPGRADE_INVALID", detail: "fleetRole" };
    }
    if (!listOk(intent.add) || !listOk(intent.remove)) return { ok: false, reason: "UPGRADE_INVALID", detail: "lists" };
    if (intent.fleetRole === LOGISTICS_ROLE) {
      const bad = logisticsUpgradeRefusal(snapshot, intent);
      if (bad) return { ok: false, reason: "UPGRADE_INVALID", detail: bad };
    }
    const paidAdd = intent.add.filter((e) => !free.includes(e.hullGroup));
    if (paidAdd.length === 0) return { ok: false, reason: "UPGRADE_INVALID", detail: "no paid hulls" };
    if (intent.remove.some((e) => !free.includes(e.hullGroup))) {
      return { ok: false, reason: "UPGRADE_INVALID", detail: "a paid hull never leaves the fleet" };
    }
    if (!fleets || !fleets.repository || typeof fleets.repository.upgradeComposition !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    const { st, mode } = stationsService();
    if (mode !== "ready" || !st || !st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const g = typeof intent.stationId === "string" ? st.repository.getStation(db, intent.stationId) : null;
    if (!g || !g.ok) return g || { ok: false, reason: "HULL_STATION_INVALID" };
    const station = g.record;
    if (!station || station.state !== STATION_ONLINE || station.ownerFactionId !== f
      || station.systemId !== intent.systemId) {
      return { ok: false, reason: "HULL_STATION_INVALID" };
    }
    const want = hullDeltas(paidAdd, -1);
    if (!want.ok) return want;
    const took = st.repository.applyStockChange(db, { stationId: intent.stationId, key: `${ik}:hulls`,
      reason: "FLEET_UPGRADE", at, deltas: want.deltas });
    if (!took.ok) return took;
    if (took.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:hulls` };
    const r = fleets.repository.upgradeComposition(db, { fleetId: intent.fleetId,
      expectedVersion: intent.expectedVersion, systemId: intent.systemId, fleetRole: intent.fleetRole,
      add: intent.add.map((e) => ({ hullGroup: e.hullGroup, count: e.count })),
      remove: intent.remove.map((e) => ({ hullGroup: e.hullGroup, count: e.count })) }, `${ik}:fleet`);
    if (!r.ok) return r;
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:fleet` };
    return { ok: true, added: r.added, removed: r.removed, shipCount: r.shipCount };
  }

  function swapInTx(db, snapshot, intent, ik, at) {
    if (!params.mineralSwap) return { ok: false, reason: "MINERAL_SWAP_DISABLED" };
    const f = snapshot.factionId;
    const itemOk = (x) => x && MINERAL_KEYS.includes(x.itemKey) && Number.isSafeInteger(x.quantity) && x.quantity > 0;
    if (!itemOk(intent.give) || !itemOk(intent.take) || intent.give.itemKey === intent.take.itemKey) {
      return { ok: false, reason: "MINERAL_SWAP_INVALID" };
    }
    const { st, mode } = stationsService();
    if (mode !== "ready" || !st || !st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const g = typeof intent.stationId === "string" ? st.repository.getStation(db, intent.stationId) : null;
    if (!g || !g.ok) return g || { ok: false, reason: "HULL_STATION_INVALID" };
    const station = g.record;
    if (!station || station.state !== STATION_ONLINE || station.ownerFactionId !== f
      || station.systemId !== intent.systemId) {
      return { ok: false, reason: "HULL_STATION_INVALID" };
    }
    const give = { itemKey: intent.give.itemKey, quantity: intent.give.quantity };
    const take = { itemKey: intent.take.itemKey, quantity: intent.take.quantity };
    const r = st.repository.applyStockChange(db, { stationId: intent.stationId, key: `${ik}:swap`,
      reason: "MINERAL_SWAP", at, deltas: [{ itemKind: "mineral", itemKey: give.itemKey, delta: -give.quantity },
        { itemKind: "mineral", itemKey: take.itemKey, delta: take.quantity }] });
    if (!r.ok) return r;
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:swap` };
    return { ok: true, stationId: intent.stationId, give, take };
  }

  function upkeepInTx(db, snapshot, intent, ik, local, at) {
    const f = snapshot.factionId;
    if (intent.purchase !== undefined && !purchaseValid(intent.purchase)) {
      return { ok: false, reason: "UNIT_PURCHASE_INVALID" };
    }
    let unpaidTo = intent.unpaidPeriodsTo;
    const notes = [];
    let abandoned = 0;
    for (const sys of intent.abandon || []) {
      const occ = occupationService();
      if (!occ || typeof occ.abandonInTx !== "function") {
        notes.push(`ABANDON_UNAVAILABLE:${sys}`);
        continue;
      }
      const r = occ.abandonInTx(db, { systemId: sys, at, factionId: f }, `${ik}:abandon:${sys}`);
      if (r && r.ok && r.changed === true) abandoned += 1;
      else if (!r || !r.ok) notes.push(`ABANDON_REFUSED:${sys}:${(r && r.reason) || "NO_RESULT"}`);
    }
    if (abandoned > 0) unpaidTo = 0;
    let delta = Number.isFinite(intent.delta) ? intent.delta : 0;
    let tradeFunded = 0;
    let hoardClipped = false;
    const trade = { fundedUnits: 0, fundedIsk: 0, capped: false, refused: null };
    const tradeTotal = (Number.isFinite(intent.tradeUnits) && Number.isFinite(intent.charged))
      ? intent.tradeUnits * intent.charged : 0;
    if (tradeTotal > 0) {
      const tr = tradeService();
      const t = tr ? tr.fundFromUpkeepInTx(db, { factionId: f, units: tradeTotal, paidUntilTo: intent.paidUntilTo,
        at }, `${ik}:trade`) : null;
      if (t && !t.ok && (t.reason === "NESTED_KEY_REUSED" || t.reason === "IDEMPOTENCY_CONFLICT")) return t;
      const funded = t && t.ok && Number.isSafeInteger(t.fundedUnits) ? Math.min(tradeTotal, t.fundedUnits) : 0;
      if (t && t.ok) {
        Object.assign(trade, { fundedUnits: funded, fundedIsk: t.fundedIsk || 0, capped: t.capped === true });
      }
      else if (t) trade.refused = String(t.reason || "REFUSED");
      tradeFunded = funded;
      const back = tradeTotal - funded;
      if (back > 0) {
        const live = strategyRepository.getFaction(db, f);
        const res = live && live.ok && live.record ? live.record.resourceUnits : snapshot.faction.resourceUnits;
        const ceiling = hoardCapOf(snapshot.doctrine, intent.income, params.upkeep);
        const want = delta + back;
        const d0 = Math.min(want, Math.max(0, params.upkeep.maxResourceUnits - res));
        delta = Math.min(want, Math.max(0, ceiling - res));
        hoardClipped = d0 - delta > 0;
      }
    }
    const paid = strategyRepository.applyFactionChange(db, { factionId: f, expectedVersion: local.factionVersion,
      key: `${ik}:faction`, reason: "UPKEEP", at, deltas: { resourceUnits: delta, reserveUnits: intent.reserveDelta,
        incomeTotal: intent.income * intent.charged, upkeepTotal: intent.cost * intent.charged,
        upkeepUnpaidTotal: intent.shortfall, tradeFundedTotal: tradeFunded },
      patch: { upkeepPaidUntil: intent.paidUntilTo, upkeepUnpaidPeriods: unpaidTo } });
    if (!paid.ok) return paid;
    if (paid.duplicate || !paid.record) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:faction` };
    local.factionVersion = paid.record.version;
    if (!intent.purchase) return { ok: true, abandoned, notes, tradeFunded, trade, hoardClipped };
    const bought = unitPurchaseInTx(db, f, intent.purchase, ik, local, at, paid.record.resourceUnits);
    if (!bought.ok) return bought;
    if (bought.note) notes.push(bought.note);
    return { ok: true, abandoned, notes, tradeFunded, trade, hoardClipped,
      ...(bought.purchase ? { purchase: bought.purchase } : { purchaseRefused: bought.note }) };
  }

  function purchaseValid(p) {
    const price = params.upkeep ? params.upkeep.iskPerUnit : null;
    return Boolean(p) && Number.isSafeInteger(p.units) && p.units > 0 && Number.isSafeInteger(p.isk) && p.isk > 0
      && Number.isSafeInteger(price) && p.isk === p.units * price;
  }

  function unitPurchaseInTx(db, f, purchase, ik, local, at, liveRes) {
    const room = Math.max(0, params.upkeep.maxResourceUnits - (Number.isSafeInteger(liveRes) ? liveRes : 0));
    const units = Math.min(purchase.units, room);
    if (!(units > 0)) return { ok: true, note: "UNIT_PURCHASE_REFUSED:RESOURCE_CAP" };
    const isk = units * params.upkeep.iskPerUnit;
    const tre = treasuryService();
    if (!tre || typeof tre.chargeWarSpendInTx !== "function") {
      return { ok: true, note: "UNIT_PURCHASE_REFUSED:TREASURY_UNAVAILABLE" };
    }
    const c = tre.chargeWarSpendInTx(db, { factionId: f, isk, at }, `${ik}:units:isk`);
    if (c && c.ok && c.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:units:isk` };
    if (c && !c.ok && (c.reason === "NESTED_KEY_REUSED" || c.reason === "IDEMPOTENCY_CONFLICT")) return c;
    if (!c || !c.ok) return { ok: true, note: `UNIT_PURCHASE_REFUSED:${(c && c.reason) || "NO_RESULT"}` };
    const ch = strategyRepository.applyFactionChange(db, { factionId: f, expectedVersion: local.factionVersion,
      key: `${ik}:units`, reason: "UNIT_PURCHASE", at, deltas: { resourceUnits: units } });
    if (!ch.ok) return ch;
    if (ch.duplicate || !ch.record) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:units` };
    local.factionVersion = ch.record.version;
    return { ok: true, purchase: { units, isk } };
  }

  function routeCheck(graph, from, to) {
    if (from === to) return { ok: false, reason: "SAME_SYSTEM" };
    const r = call(() => graph.findRoute(from, to), null);
    if (!r || r.ok !== true || !(r.jumps > 0)) return { ok: false, reason: (r && r.reason) || "UNREACHABLE" };
    return { ok: true };
  }

  function launchInTx(db, snapshot, intent, ik, local, at, graph) {
    if (intent.swarmBucket === undefined) return launchOpInTx(db, snapshot, intent, ik, local, at, graph);
    const f = snapshot.factionId;
    const S = snapshot.hive && snapshot.hive.swarm;
    if (!params.hive || !params.hive.swarm || !S) return { ok: false, reason: "HIVE_SWARM_OFF" };
    const bucket = intent.swarmBucket;
    if (!Number.isSafeInteger(bucket) || bucket !== S.bucket) return { ok: false, reason: "HIVE_SWARM_STALE" };
    const r = journal.applyOnce(db, { key: hiveSwarmKey(f, bucket),
      aggregate: { type: FACTION_AGGREGATE, id: String(f) }, eventType: HIVE_SWARM_MARKER_EVENT,
      payload: { factionId: f, bucket, targetSystemId: intent.target.systemId, fleets: intent.mobilize.length } },
    () => launchOpInTx(db, snapshot, intent, ik, local, at, graph));
    if (r.ok && r.duplicate) return { ok: false, reason: "HIVE_SWARM_ALREADY" };
    if (r.ok) return r.value;
    return r.reason === "APPLY_REFUSED" ? r.refusal : r;
  }

  function launchOpInTx(db, snapshot, intent, ik, local, at, graph) {
    const kind = kinds.get(intent.kind);
    if (!kind) return { ok: false, reason: "UNKNOWN_KIND", detail: intent.kind };
    const T = intent.target.systemId;
    const inPlace = new Set(kind.inPlace === true ? snapshot.fleets.filter((x) => x.systemId === T
      && intent.fleets.some((y) => y.fleetId === x.fleetId)).map((x) => x.fleetId) : []);
    const starts = [...snapshot.fleets.filter((x) => intent.fleets.some((y) => y.fleetId === x.fleetId)
      && !inPlace.has(x.fleetId)).map((x) => x.systemId), ...intent.mobilize.map((m) => m.systemId)];
    for (const from of starts) {
      const ok = routeCheck(graph, from, T);
      if (!ok.ok) return ok;
    }
    const members = intent.fleets.map((x) => ({ fleetId: x.fleetId, expectedVersion: x.expectedVersion }));
    for (let n = 0; n < intent.mobilize.length; n += 1) {
      const m = mobilizeInTx(db, snapshot, intent.mobilize[n], `${ik}:mob:${n}`, local, at);
      if (!m.ok) return m;
      members.push({ fleetId: m.fleetId, expectedVersion: m.version });
    }
    const op = fleets.repository.createOperation(db, { operationType: kind.operationType, factionId: snapshot.factionId,
      originSystemId: intent.originSystemId, targetSystemId: T, objective: kind.objective, dueAt: intent.dueAt,
      fleets: members }, `${ik}:op`);
    if (!op.ok) return op;
    if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:op` };
    let signal = null;
    let drift = 0;
    if (kind.occupationSignal && snapshot.doctrine.canOccupy === true) {
      const coreOwner = snapshot.coreOwners instanceof Map ? snapshot.coreOwners.get(T) : undefined;
      if (coreOwner !== undefined && coreOwner !== snapshot.factionId) {
        signal = "SKIPPED_CORE";
        bump("coreSkipped");
      } else if (snapshot.lowsecIds instanceof Set && snapshot.lowsecIds.has(T)) {
        signal = "SKIPPED_LOWSEC";
        bump("lowsecSkipped");
      } else {
        const occ = occupationService();
        if (!occ) signal = "UNAVAILABLE";
        else {
          const s = occ.signalInTx(db, { systemId: T, factionId: snapshot.factionId, signal: kind.occupationSignal, at },
            `${ik}:occ`);
          signal = s.ok ? s.outcome : `REFUSED:${s.reason}`;
          drift = s.ok && Number.isSafeInteger(s.drift) ? s.drift : 0;
        }
      }
    } else if (kind.occupationSignal) {
      signal = "SKIPPED_NO_OCCUPY";
      bump("signalSkipped");
    }
    let scanRefused = false;
    let blockadeScan = null;
    if (kind.operationType === BLOCKADE_OPERATION_TYPE) {
      const bk = typeof deps.getBlockade === "function" ? call(deps.getBlockade, null) : null;
      const scan = bk && typeof bk.registerBlockadeInTx === "function"
        ? bk.registerBlockadeInTx(db, { operationId: op.operationId, systemId: T, factionId: snapshot.factionId,
          dueAt: intent.dueAt, at }, { chained: true, maxFleets: borderPostScanPageOf(S) })
        : { ok: false, reason: "BLOCKADE_UNAVAILABLE" };
      scanRefused = !scan || scan.ok !== true;
      if (!scanRefused) blockadeScan = scan;
    }
    for (const m of members) {
      const key = `${ik}:go:${m.fleetId}`;
      const p = inPlace.has(m.fleetId)
        ? fleets.travel.stageInPlaceInTx(db, { fleetId: m.fleetId, at }, key, { chained: true })
        : fleets.travel.planInTx(db, { fleetId: m.fleetId, targetSystemId: T, at }, key, { chained: true });
      if (!p.ok) return { ...p, fleetId: m.fleetId };
    }
    return { ok: true, operationId: op.operationId, fleets: members.length, mobilized: intent.mobilize.length, signal,
      drift, ...(scanRefused ? { scanRefused } : {}), ...(blockadeScan ? { blockadeScan } : {}) };
  }

  function tributeDispatchInTx(db, snapshot, intent, spec, lg, ik) {
    const f = snapshot.factionId;
    const T = snapshot.tribute;
    if (!params.tribute || !T || T.mode !== "ready") return { ok: false, reason: "TRIBUTE_OFF" };
    const bucket = intent.tributeBucket;
    if (!Number.isSafeInteger(bucket) || bucket !== T.bucket) return { ok: false, reason: "TRIBUTE_STALE" };
    const r = journal.applyOnce(db, { key: tributeMarkerKey(f, bucket),
      aggregate: { type: FACTION_AGGREGATE, id: String(f) }, eventType: TRIBUTE_MARKER_EVENT,
      payload: { factionId: f, bucket, recipientFactionId: T.recipientFactionId } }, () => {
      const d = lg.dispatchInTx(db, spec, ik);
      if (d.ok && d.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:convoy` };
      if (d.ok) return d;
      if (TRIBUTE_FORFEIT_REASONS.includes(d.reason)) return { ok: true, forfeited: d.reason };
      return d;
    });
    if (r.ok && r.duplicate) return { ok: false, reason: "TRIBUTE_ALREADY_PAID" };
    if (r.ok) return { ...r.value, tribute: true };
    return r.reason === "APPLY_REFUSED" ? r.refusal : r;
  }

  function applyIntent(db, snapshot, intent, ik, local, at, graph) {
    const f = snapshot.factionId;
    const b = snapshot.round;
    switch (intent.type) {
      case "OBSERVE":
        return intelRepository.upsertObservation(db, { factionId: f, systemId: intent.systemId,
          ...intent.observation }, intelKey(f, intent.systemId, b));
      case "CLOSE_OPERATION": {
        const r = fleets.repository.transitionOperation(db, { operationId: intent.operationId,
          expectedVersion: intent.expectedVersion, from: intent.from, to: intent.to, result: intent.result },
        `strategy:close:${intent.operationId}`);
        return r.ok && r.duplicate ? { ok: false, reason: "ALREADY_CLOSED" } : r;
      }
      case "REQUEST_REFIT":
        return fleets.travel.requestRefitInTx(db, { fleetId: intent.fleetId, expectedVersion: intent.expectedVersion,
          at }, `strategy:refit:${intent.fleetId}:${intent.legSeq}`, { chained: true });
      case "MOBILIZE":
        return mobilizeInTx(db, snapshot, intent, `${ik}:mob:0`, local, at);
      case "LAUNCH":
        return launchInTx(db, snapshot, intent, ik, local, at, graph);
      case "MINE_DISPATCH": {
        const mn = miningService();
        if (!mn) return { ok: false, reason: "MINING_UNAVAILABLE" };
        const r = mn.dispatchInTx(db, { factionId: f, fleetId: intent.fleetId, expectedVersion: intent.expectedVersion,
          beltSystemId: intent.beltSystemId, at,
          ownSpace: snapshot.doctrine && snapshot.doctrine.ownSpace ? snapshot.doctrine.ownSpace : null,
          allies: snapshot.entry && Array.isArray(snapshot.entry.allies) ? snapshot.entry.allies : [] }, ik);
        return r.ok && r.duplicate ? { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:trip` } : r;
      }
      case "PRODUCE": {
        const pr = productionService();
        if (!pr || call(() => pr.getMode(), "off") !== "ready") return { ok: false, reason: "PRODUCTION_UNAVAILABLE" };
        const r = pr.startJobInTx(db, { factionId: f, stationId: intent.stationId, hullGroup: intent.hullGroup,
          runs: intent.runs, at, recipesVersion: intent.recipesVersion }, ik);
        return r.ok && r.duplicate ? { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:job` } : r;
      }
      case "MINE_RELEASE": {
        const mn = miningService();
        if (!mn || typeof mn.releaseOrphanInTx !== "function") return { ok: false, reason: "MINING_UNAVAILABLE" };
        return mn.releaseOrphanInTx(db, { factionId: f, fleetId: intent.fleetId,
          expectedVersion: intent.expectedVersion }, ik);
      }
      case "UPKEEP":
        return upkeepInTx(db, snapshot, intent, ik, local, at);
      case "TREASURY": {
        const tre = treasuryService();
        if (!tre) return { ok: false, reason: "TREASURY_UNAVAILABLE" };
        return tre.settleIntentInTx(db, { ...intent, factionId: f, at,
          feeRuns: Array.isArray(local.feeRuns) ? local.feeRuns : [],
          ...(local.warIsk > 0 ? { warSpend: local.warIsk } : {}) }, ik);
      }
      case "REPLENISH":
        return replenishInTx(db, snapshot, intent, ik, local, at);
      case "DISBAND":
        return disbandInTx(db, snapshot, intent, ik, at);
      case "MERGE":
        return mergeInTx(db, intent, ik);
      case "GARRISON_RELEASE":
        return garrisonReleaseInTx(db, intent, ik);
      case "FLEET_UPGRADE":
        return upgradeInTx(db, snapshot, intent, ik, at);
      case "MINERAL_SWAP":
        return swapInTx(db, snapshot, intent, ik, at);
      case "CONVOY_DISPATCH": {
        const lg = logisticsService();
        if (!lg || call(() => lg.getMode(), "off") !== "ready") return { ok: false, reason: "LOGISTICS_UNAVAILABLE" };
        const spec = { factionId: f, fleetId: intent.fleetId, expectedVersion: intent.expectedVersion,
          purpose: intent.purpose, sourceStationId: intent.sourceStationId, destStationId: intent.destStationId,
          items: intent.items, at };
        if (intent.purpose === TRIBUTE_PURPOSE) return tributeDispatchInTx(db, snapshot, intent, spec, lg, ik);
        const r = lg.dispatchInTx(db, spec, ik);
        return r.ok && r.duplicate ? { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:convoy` } : r;
      }
      case "BUILD_PLAN": {
        const c = constructionService();
        if (!c || call(() => c.getMode(), "off") !== STATION_READY) {
          return { ok: false, reason: "CONSTRUCTION_UNAVAILABLE" };
        }
        const r = c.planInTx(db, { factionId: f, systemId: intent.systemId, kitId: intent.kitId, at }, ik);
        return r.ok && r.duplicate ? { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:build` } : r;
      }
      case "SENTRY_BUILD": {
        const sv = sentriesService();
        if (!sv || !params.sentries) return { ok: false, reason: "SENTRY_OFF" };
        const ownerCorpId = call(() => registry.corporationFor(f, SENTRY_OWNER_ROLE), null);
        const r = sv.requestBuildInTx(db, { factionId: f, ownerCorpId, systemId: intent.systemId,
          anchorKind: intent.anchorKind, anchorRef: intent.anchorRef, typeId: intent.typeId, at }, ik);
        return r && r.ok && r.duplicate ? { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:sentry` }
          : r || { ok: false, reason: "SENTRY_BUILD_FAILED" };
      }
      case "TERRITORY_MARK": {
        const occ = occupationService();
        if (!occ) return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
        return occ.markDetachedInTx(db, { systemId: intent.systemId, factionId: f, detached: intent.detached, at },
          `strategy:territory:${f}:${intent.systemId}:${b}`);
      }
      case "TRADE_OFFER": {
        const tr = tradeService();
        if (!tr || typeof tr.planOfferInTx !== "function") return { ok: false, reason: "TRADE_UNAVAILABLE" };
        const spec = {
          factionId: f,
          stationId: intent.stationId,
          systemId: intent.systemId,
          issuerCorporationId: intent.issuerCorporationId,
          itemKind: intent.itemKind,
          itemKey: intent.itemKey,
          typeId: intent.typeId,
          quantity: intent.quantity,
          unitPriceMilli: intent.unitPriceMilli,
          iskTotal: intent.iskTotal,
          refPriceMilli: intent.refPriceMilli,
          capPriceMilli: intent.capPriceMilli,
          priceSource: intent.priceSource,
          expiresAt: intent.expiresAt,
          at,
        };
        if (intent.assigneeCharacterId !== undefined && intent.assigneeCharacterId !== null) {
          spec.assigneeCharacterId = intent.assigneeCharacterId;
        }
        if (intent.standingBonusPermille !== undefined && intent.standingBonusPermille !== null) {
          spec.standingBonusPermille = intent.standingBonusPermille;
        }
        if (intent.purpose !== undefined) spec.purpose = intent.purpose;
        if (intent.side === SIDE_SELL) spec.side = SIDE_SELL;
        const r = tr.planOfferInTx(db, spec, ik);
        return r.ok && r.duplicate ? { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:offer` } : r;
      }
      case "TRADE_CANCEL": {
        const tr = tradeService();
        if (!tr || typeof tr.cancelOfferInTx !== "function") return { ok: false, reason: "TRADE_UNAVAILABLE" };
        const cancel = {
          factionId: f,
          offerId: intent.offerId,
          expectedVersion: intent.expectedVersion,
          reason: intent.reason,
          at,
        };
        if (intent.from !== undefined) cancel.from = intent.from;
        const r = tr.cancelOfferInTx(db, cancel, ik);
        return r.ok && r.duplicate ? { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:cancel` } : r;
      }
      case "TERRITORY_TRIM": {
        const key = trimBatchKey(f, b);
        const r = scheduler.enqueue(TRIM_EVENT, String(f), at, { factionId: f, round: b,
          systemIds: [...intent.systemIds] }, key, { tx: db });
        if (r && r.ok && r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
        return r && r.ok ? { ok: true, planned: intent.systemIds.length }
          : { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      }
      case "TERRITORY_TRIM_DONE": {
        const r = journal.applyOnce(db, { key: trimDoneKey(f), aggregate: { type: FACTION_AGGREGATE, id: String(f) },
          eventType: TRIM_DONE_EVENT, payload: { factionId: f } }, () => ({ ok: true }));
        return r.ok ? { ok: true, done: true } : r;
      }
      default:
        return { ok: false, reason: "UNKNOWN_INTENT", detail: String(intent.type) };
    }
  }

  function applyDecision(tx, decision, snapshot, at, graph) {
    const f = snapshot.factionId;
    const b = snapshot.round;
    let factionVersion = snapshot.faction.version;
    const out = { applied: {}, refused: [], launches: [], mobilized: 0, refitOutcomes: [], marks: 0,
      minersMobilized: 0, dispatches: [], released: 0, produced: [], hullsTaken: 0, legacyMobilized: 0, upkeep: null,
      convoys: [], logisticsMobilized: 0, replenished: 0, replenishHulls: 0, builds: [], disbands: [], merges: [],
      sentryBuilds: [],
      upkeepDisbandRefused: 0,
      garrisonReleased: 0, retireRefused: 0, strandedRefused: 0, combatStrandedRefused: 0, upgrades: 0, upgradeHulls: 0, industryJobs: 0, trimPlanned: 0,
      trimDone: false,
      huntersMobilized: 0, privateOffers: 0, tributeForfeited: [], treasury: null,
      hiveBroodMobilized: 0,
      hiveSwarms: 0, hiveSwarmFleets: 0, hiveSwarmRefused: 0,
      homePoolMobilized: 0,
      capitalAttached: 0, capitalAttachSkipped: 0,
      capitalEscort: 0,
      capitalReplenished: 0,
      escalatedMobilized: 0, escalationFallback: 0,
      capitalLevelGated: 0,
      escalationLevel0: 0, escalationLevel1: 0, escalationLevel2: 0, escalationLevel3: 0,
      usageIntents: [],
      tradeNotReady: Boolean(snapshot.upkeep && snapshot.upkeep.tradeReason),
      at, tradeReason: (snapshot.upkeep && snapshot.upkeep.tradeReason) || null, stockpileOffers: 0,
      tierOffers: [0, 0, 0],
      oreOffers: 0,
      commodityOffers: 0,
      stockpileRecalls: 0,
      hullOffers: 0,
      wtsOffers: 0, wtsStockLost: 0,
      wtsRecalls: 0,
      warOffers: 0,
      warRepriced: 0,
      warStationCapped: 0,
      warIsk: 0 };
    const needsHulls = (role) => params.production && params.production.mobilizeHulls === "required"
      && (role !== MINING_ROLE || params.production.miningNeedsHulls === true)
      && (role !== LOGISTICS_ROLE || params.production.logisticsNeedsHulls === true)
      && snapshot.doctrine && snapshot.doctrine.hullsRequired !== false;
    const countHulls = (mob) => {
      const n = (Array.isArray(mob.hulls) ? mob.hulls : []).reduce((a, h) => a + h.count, 0);
      out.hullsTaken += n;
      if (Number.isSafeInteger(mob.escalation) && mob.escalation > 0) out.escalatedMobilized += 1;
      if (mob.escalationFallback === true) out.escalationFallback += 1;
      const L = mob.escalationLevel;
      if (Number.isSafeInteger(L) && L >= 0 && L <= 3) out[`escalationLevel${L}`] += 1;
      if (n === 0 && needsHulls(mob.role) && Array.isArray(mob.composition)
        && paidOf(mob.composition, freeHullGroupsOf()).length > 0) out.legacyMobilized += 1;
      const CA = params.capitalAttach;
      const comp = Array.isArray(mob.composition) ? mob.composition : [];
      if (comp.some((e) => CAPITAL_HULL_GROUPS.includes(e.hullGroup))) {
        if (CA) out.capitalAttached += 1;
        if (CA && comp.length === 1 && comp[0].count === 1) out.capitalEscort += 1;
      } else if (mob.capitalGated === true) {
        out.capitalLevelGated += 1;
      } else if (CA && CA.roles.includes(mob.role) && mob.stationId !== null && mob.stationId !== undefined
        && Array.isArray(mob.hulls) && mob.hulls.length > 0 && snapshot.capitalClasses
        && CA.order.some((cls) => Number.isSafeInteger(snapshot.capitalClasses[cls]) && snapshot.capitalClasses[cls] > 0)) {
        out.capitalAttachSkipped += 1;
      }
    };
    decision.intents.forEach((intent, i) => {
      if (intent.type === "FACTION_TOUCH") {
        const r = strategyRepository.applyFactionChange(tx, { factionId: f, expectedVersion: factionVersion,
          key: `strategy:review:${f}:${b}:touch`, reason: "STRATEGY_REVIEW", at,
          patch: { lastReviewAt: intent.lastReviewAt,
            ...(typeof intent.doctrineId === "string" ? { doctrineId: intent.doctrineId } : {}),
            ...(Number.isSafeInteger(intent.frontLimit) ? { frontLimit: intent.frontLimit } : {}) } });
        if (r.ok && r.record) factionVersion = r.record.version;
        if (!r.ok) out.refused.push({ type: intent.type, reason: String(r.reason) });
        return;
      }
      const ik = `strategy:review:${f}:${b}:${i}:${intent.type}`;
      const local = { factionVersion };
      if (intent.type === "TREASURY") {
        local.feeRuns = out.produced.filter((p) => p.runs > 0).map(({ hullGroup, runs }) => ({ hullGroup, runs }));
        local.warIsk = out.warIsk;
      }
      let value = null;
      const res = journal.applyOnce(tx, { key: ik, aggregate: { type: FACTION_AGGREGATE, id: String(f) },
        eventType: EVENT_STRATEGY_INTENT, payload: { seed: decision.seed, intent } }, (db) => {
        value = applyIntent(db, snapshot, intent, ik, local, at, graph);
        return value;
      });
      if (res.ok && !res.duplicate) {
        factionVersion = local.factionVersion;
        out.applied[intent.type] = (out.applied[intent.type] || 0) + 1;
        if (intent.type === "LAUNCH" || intent.type === "MOBILIZE" || intent.type === "REPLENISH") {
          out.usageIntents.push(intent);
        }
        if (intent.type === "LAUNCH") {
          out.launches.push({ kind: intent.kind, target: intent.target.systemId, fleets: value.fleets,
            mobilized: value.mobilized, signal: value.signal, drift: value.drift || 0,
            retire: intent.purpose === RETIRE_PURPOSE, stranded: intent.purpose === STRANDED_PURPOSE,
            garrisonReturn: intent.purpose === GARRISON_RETURN,
            ...(intent.purpose === REPLENISH_RETURN_PURPOSE ? { replenishReturn: true } : {}),
            ...(intent.purpose === GARRISON_CONSOLIDATE_PURPOSE ? { consolidate: true } : {}),
            ...(intent.purpose === COMBAT_STRANDED_PURPOSE ? { combatStranded: true } : {}),
            ...(intent.purpose === CAPSULEER_PURSUIT_PURPOSE ? { capsuleerPursuit: true } : {}),
            ...(value.scanRefused === true ? { scanRefused: true } : {}),
            ...(value.blockadeScan ? { blockadeScan: value.blockadeScan } : {}) });
          out.mobilized += value.mobilized;
          if (intent.swarmBucket !== undefined) {
            out.hiveSwarms += 1;
            out.hiveSwarmFleets += value.mobilized;
          }
          for (const m of intent.mobilize) countHulls(m);
          out.warIsk += warIskOf(intent) + intent.mobilize.reduce((s, m) => s + warIskOf(m), 0);
        } else if (intent.type === "MOBILIZE") {
          out.mobilized += 1;
          countHulls(intent);
          out.warIsk += warIskOf(intent);
          if (intent.role === MINING_ROLE) out.minersMobilized += 1;
          if (intent.role === LOGISTICS_ROLE) out.logisticsMobilized += 1;
          if (intent.role === HUNTER_ROLE) out.huntersMobilized += 1;
          if (intent.stationId === null && snapshot.doctrine && snapshot.doctrine.hive === true) {
            out.hiveBroodMobilized += 1;
          }
          if (intent.purpose === "HOME_POOL") out.homePoolMobilized += 1;
        } else if (intent.type === "MINE_DISPATCH") out.dispatches.push({ local: value.local === true,
          pruned: value.pruned || 0 });
        else if (intent.type === "REQUEST_REFIT") out.refitOutcomes.push(value.outcome);
        else if (intent.type === "MINE_RELEASE") out.released += 1;
        else if (intent.type === "PRODUCE") out.produced.push({ hullGroup: intent.hullGroup, runs: value.runs || 0,
          minerals: value.minerals || 0, pruned: value.pruned || 0, ladder: intent.ladder === true,
          ...(value.advanced !== undefined ? { advanced: value.advanced, advancedShort: value.advancedShort || 0 }
            : {}) });
        else if (intent.type === "TERRITORY_MARK" && value.changed === true) out.marks += 1;
        else if (intent.type === "UPKEEP") {
          out.upkeep = { intent, abandoned: value.abandoned, trade: value.trade || null,
            hoardClipped: value.hoardClipped === true,
            ...(value.purchase ? { purchase: value.purchase } : {}),
            ...(value.purchaseRefused ? { purchaseRefused: value.purchaseRefused } : {}) };
        }
        else if (intent.type === "TREASURY") out.treasury = value;
        else if (intent.type === "REPLENISH") {
          out.replenished += 1;
          out.replenishHulls += value.ships;
          if (intent.capital === true) out.capitalReplenished += 1;
        }
        else if (intent.type === "CONVOY_DISPATCH" && typeof value.forfeited === "string") {
          out.tributeForfeited.push(value.forfeited);
        }
        else if (intent.type === "CONVOY_DISPATCH") out.convoys.push({ local: value.local === true,
          pruned: value.pruned || 0, tribute: value.tribute === true });
        else if (intent.type === "BUILD_PLAN") out.builds.push({ ...value, systemId: intent.systemId });
        else if (intent.type === "SENTRY_BUILD") out.sentryBuilds.push({ ...value, anchorKind: intent.anchorKind });
        else if (intent.type === "DISBAND") out.disbands.push({ fleetId: value.fleetId, reason: value.reason,
          hullsReturned: value.hullsReturned, hullsLost: value.hullsLost, ships: value.ships });
        else if (intent.type === "MERGE") out.merges.push({ keeperId: value.keeperId, absorbedId: value.absorbedId,
          ships: value.ships, systemId: intent.systemId, fleetRole: intent.fleetRole });
        else if (intent.type === "GARRISON_RELEASE") out.garrisonReleased += 1;
        else if (intent.type === "FLEET_UPGRADE") {
          out.upgrades += 1;
          out.upgradeHulls += value.added || 0;
        }
        else if (intent.type === "TERRITORY_TRIM") out.trimPlanned += value.planned || 0;
        else if (intent.type === "TERRITORY_TRIM_DONE") out.trimDone = true;
        else if (intent.type === "TRADE_OFFER" && isId(intent.assigneeCharacterId)) out.privateOffers += 1;
        else if (intent.type === "TRADE_OFFER" && intent.purpose === "stockpile") out.stockpileOffers += 1;
        if (intent.type === "TRADE_OFFER" && !isId(intent.assigneeCharacterId)
          && (intent.tier === 1 || intent.tier === 2 || intent.tier === 3)) out.tierOffers[intent.tier - 1] += 1;
        if (intent.type === "TRADE_OFFER" && intent.itemKind === "ore") out.oreOffers += 1;
        if (intent.type === "TRADE_OFFER" && (intent.itemKind === "moon" || intent.itemKind === "pi")) {
          out.commodityOffers += 1;
        }
        if (intent.type === "TRADE_CANCEL" && intent.reason === "RECALLED" && intent.purpose !== "reprice") {
          out.stockpileRecalls += 1;
        } else if (intent.type === "TRADE_CANCEL" && intent.reason === "RECALLED" && intent.purpose === "reprice") {
          out.warRepriced += 1;
        }
        if (intent.type === "TRADE_CANCEL" && intent.reason === "RECALLED" && intent.side === SIDE_SELL) out.wtsRecalls += 1;
        if (intent.type === "TRADE_OFFER" && intent.purpose === "hull") out.hullOffers += 1;
        if (intent.type === "TRADE_OFFER" && intent.side === SIDE_SELL) out.wtsOffers += 1;
        if (intent.type === "TRADE_OFFER" && Number.isSafeInteger(intent.warPermille) && intent.warPermille > 0) {
          out.warOffers += 1;
        }
        if (intent.type === "TRADE_OFFER" && intent.stationCapped === true) out.warStationCapped += 1;
        if (intent.type === "TRADE_CANCEL" && value && value.stockBack && value.stockBack.lost > 0) {
          out.wtsStockLost += value.stockBack.lost;
        }
        if (intent.type === "PRODUCE" && industryGroups.includes(intent.hullGroup)) out.industryJobs += 1;
        return;
      }
      if (res.ok) return;
      const refusal = res.reason === "APPLY_REFUSED" ? res.refusal : res;
      const reason = String((refusal && refusal.reason) || "REFUSED");
      const advancedKind = intent.type === "PRODUCE" && refusal && (refusal.itemKind === "moon"
        || refusal.itemKind === "pi") ? refusal.itemKind : null;
      out.refused.push(advancedKind ? { type: intent.type, reason, itemKind: advancedKind } : { type: intent.type, reason });
      if ((intent.type === "DISBAND" && intent.reason !== STRANDED_REASON && intent.reason !== RELIEF_REASON)
        || (intent.type === "LAUNCH" && intent.purpose === RETIRE_PURPOSE)) {
        out.retireRefused += 1;
      }
      if (intent.type === "DISBAND" && intent.reason === RELIEF_REASON) out.upkeepDisbandRefused += 1;
      if (intent.type === "LAUNCH" && reason.startsWith("HIVE_SWARM_")) out.hiveSwarmRefused += 1;
      if (intent.type === "LAUNCH" && intent.purpose === STRANDED_PURPOSE) out.strandedRefused += 1;
      if ((intent.type === "DISBAND" && intent.reason === STRANDED_REASON)
        || (intent.type === "LAUNCH" && intent.purpose === COMBAT_STRANDED_PURPOSE)) out.combatStrandedRefused += 1;
      if (res.reason === "APPLY_FAILED") {
        log(`strategy: ${f} r${b} intent ${intent.type} failed ${res.code || ""} ${messageOf(res.error)}`);
      }
    });
    return { ok: true, ...out };
  }

  function remember(f, b, decision, summary, belt) {
    seq += 1;
    const prev = memory.get(f);
    const upkeep = decision.upkeep ? Object.freeze({ ...decision.upkeep }) : (prev ? prev.upkeep : null);
    const effectNotes = summary && summary.treasury && Array.isArray(summary.treasury.notes)
      ? [...summary.treasury.notes] : [];
    if (hoardClippedByEffect(decision, summary)) effectNotes.push("UPKEEP_HOARD_CAP");
    if (summary && summary.upkeep && summary.upkeep.purchaseRefused) effectNotes.push(summary.upkeep.purchaseRefused);
    if (belt && Array.isArray(belt.truce)) for (const p of belt.truce) effectNotes.push(`TRUCE:${p}`);
    const forfeits = summary && Array.isArray(summary.tributeForfeited) ? summary.tributeForfeited.length : 0;
    memory.set(f, Object.freeze({ round: b, outcome: decision.outcome,
      reason: typeof decision.reason === "string" ? decision.reason : null, target: decision.target, upkeep,
      notes: Object.freeze([...replaceForfeited(decision.notes, forfeits), ...effectNotes]),
      fronts: decision.supply ? Object.freeze({ count: decision.supply.frontCount, limit: decision.supply.frontLimit })
        : null,
      borderSystems: decision.supply && Number.isSafeInteger(decision.supply.borderSystems)
        ? decision.supply.borderSystems : null,
      applied: summary ? Object.freeze({ ...summary.applied }) : null,
      refused: summary ? summary.refused.length : 0,
      ...(belt && Number.isSafeInteger(belt.hiveNodes) ? { hiveNodesActive: belt.hiveNodes,
        hiveBroodMobilized: summary ? summary.hiveBroodMobilized : 0 } : {}) }));
  }

  function localFilteredOf(notes) {
    let n = 0;
    for (const note of Array.isArray(notes) ? notes : []) {
      if (typeof note !== "string" || !note.startsWith("TRADE_LOCAL_FILTERED:")) continue;
      const v = Number(note.slice("TRADE_LOCAL_FILTERED:".length));
      if (Number.isSafeInteger(v) && v > 0) n = Math.min(Number.MAX_SAFE_INTEGER, n + v);
    }
    return n;
  }

  function notePlanOf(f, decision, summary) {
    const tr = tradeService();
    if (!tr || typeof tr.notePlan !== "function") return;
    const counts = new Map();
    for (const note of decision.notes) {
      if (typeof note !== "string" || !note.startsWith("TRADE_")) continue;
      const code = note.split(":")[0];
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    const notes = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_PLAN_NOTE_CODES));
    const offers = summary.applied.TRADE_OFFER || 0;
    const created = { mobilization: Math.max(0, offers - summary.stockpileOffers - summary.privateOffers),
      stockpile: summary.stockpileOffers, private: summary.privateOffers };
    call(() => tr.notePlan(f, { at: summary.at, tradeReason: summary.tradeReason, created, notes }), null);
  }

  function hoardClippedByEffect(decision, summary) {
    return Boolean(summary && summary.upkeep && summary.upkeep.hoardClipped === true)
      && !decision.notes.includes("UPKEEP_HOARD_CAP");
  }

  function onCommitted(f, b, decision, summary, belt) {
    bump("runs");
    if (belt) {
      borderMemory.set(f, Object.freeze({ mode: belt.mode, systems: belt.systems, candidates: belt.candidates.size,
        rejected: belt.rejected }));
      if (summary) bump("borderTargets", summary.launches.filter((l) => belt.candidates.has(l.target)).length);
      if (belt.raidTargets > 0) bump("raidTargets", belt.raidTargets);
      if (summary && belt.raidSet) bump("raidTargetLaunches", summary.launches.filter((l) => belt.raidSet.has(l.target)).length);
      if (belt.escortIntelTruncated === true) bump("minerEscortIntelTruncated");
      if (belt.intruders) {
        bump("intrudersSighted", belt.intruders.items.length);
        if (belt.intruders.truncated === true) bump("intruderScanTruncated");
      }
      if (Array.isArray(belt.truce) && belt.truce.length > 0) bump("truceActive", belt.truce.length);
    }
    if (hoardClippedByEffect(decision, summary)) bump("upkeepHoardCapped");
    if (decision.outcome === "SKIPPED") bump("skipped");
    if (decision.outcome === "DEFERRED") bump("deferred");
    for (const note of decision.notes) {
      if (NOTE_COUNTERS[note]) bump(NOTE_COUNTERS[note]);
      if (isNoHullsNote(note)) bump("noHulls");
      if (note.startsWith("NO_TARGET")) bump("noTarget");
      if (note.startsWith("HQ_RETURN:")) bump("hqReturnPlanned");
      if (note === "UPKEEP_RESERVE" || note === "UPKEEP_UNPAID") bump("upkeepReserveBlocked");
      if (note === "UPKEEP_HOARD_CAP") bump("upkeepHoardCapped");
    }
    if (decision.notes.some((n) => WAR_CHEST_NOTES.includes(n))) bump("warChestShort");
    if (decision.notes.includes("ATTACK_LOSS_COOLDOWN")) metric("count", "strategy.attackLoss.blocked", 1);
    if (decision.notes.includes("ATTACK_LOSS_REQUIRED_RAISED")) {
      metric("count", "strategy.attackLoss.requiredRaised", 1);
    }
    if (decision.notes.includes("ATTACK_LOSS_ISK_GATE")) metric("count", "strategy.attackLoss.iskGateBlocked", 1);
    if (decision.notes.includes("TRANSIT_RISK_SKIP")) metric("count", "strategy.transitRisk.skipped", 1);
    if (decision.notes.includes("TRANSIT_RISK_RAISED")) metric("count", "strategy.transitRisk.raised", 1);
    const tr = belt && belt.transitRisk;
    if (tr) {
      if (tr.routes > 0) metric("count", "strategy.transitRisk.routes", tr.routes);
      if (tr.capped > 0) metric("count", "strategy.transitRisk.capped", tr.capped);
      if (tr.cold > 0) metric("count", "strategy.transitRisk.cold", tr.cold);
      if (tr.errors > 0) metric("count", "strategy.transitRisk.errors", tr.errors);
    }
    bump("opsStuck", decision.stuck || 0);
    if (Number.isSafeInteger(decision.minerRaidsSeen)) bump("minerRaidTargets", decision.minerRaidsSeen);
    if (Number.isSafeInteger(decision.capsuleerPursuitsSeen)) {
      bump("capsuleerPursuitTargets", decision.capsuleerPursuitsSeen);
    }
    if (Number.isSafeInteger(decision.minerRaidTooStrong)) bump("minerRaidTooStrong", decision.minerRaidTooStrong);
    if (Number.isSafeInteger(decision.minerRaidReordered)) {
      bump("minerRaidUnescortedFirst", decision.minerRaidReordered);
    }
    if (summary) {
      const a = summary.applied;
      bump("observed", a.OBSERVE || 0);
      bump("opsClosed", a.CLOSE_OPERATION || 0);
      bump("refitRequests", summary.refitOutcomes.filter((o) => o !== "NONE").length);
      bump("mobilized", summary.mobilized);
      bump("launches", summary.launches.length);
      for (const l of summary.launches) {
        const k = kinds.get(l.kind);
        if (l.retire) bump("logisticsRetireReturns");
        else if (l.stranded) bump("logisticsStrandedReturns");
        else if (l.combatStranded) bump("strandedReturns");
        else if (l.replenishReturn) bump("replenishReturns");
        else if (l.kind === "return") bump("returns");
        else if (l.kind === RELIEF_KIND) bump("reliefs");
        else if (l.kind === "hunt") bump("hunterPatrolsLaunched");
        else if (l.kind === "garrison") {
          bump("garrisonReinforced");
          if (l.consolidate) bump("garrisonConsolidated");
        }
        else if (l.kind === "patrol") bump(l.garrisonReturn ? "garrisonReturns" : "patrolsLaunched");
        else if (l.kind === "picket") bump("picketsLaunched");
        else if (l.capsuleerPursuit) bump("capsuleerPursuits");
        else if (l.kind === "gank") bump("minerRaidsLaunched");
        else if (l.kind === "blockade") bump("borderPostLaunched");
        else if (l.kind === "escort") bump("minerEscortLaunched");
        else if (l.kind === "structure_assault") bump("attacks");
        else if (l.kind === HARVEST_RAID_KIND) bump("attacks");
        else if (l.kind === COUNTER_KIND) bump("invaderCounterLaunch");
        else if (l.kind === BOSS_RESPONSE_KIND) bump("bossResponseLaunch");
        else if (k && k.needsIntel !== true) bump("recon");
        else bump("attacks");
        if (l.scanRefused) bump("borderPostScanRefused");
        if (l.blockadeScan) countBlockadeScan(l.blockadeScan);
        log(`strategy: ${f} r${b} launch ${l.kind} -> ${l.target} fleets=${l.fleets} mob=${l.mobilized}`
          + `${l.signal ? ` occ=${l.signal}` : ""}`);
        const occ = l.signal ? occupationService() : null;
        if (l.signal && l.signal.startsWith("REFUSED:")) {
          bump("signalRefused");
          if (occ) {
            occ.count("signalRefused");
            occ.noteRefusal("signal", l.signal.slice("REFUSED:".length));
          }
        } else if (occ && l.signal === "NOOP") occ.count("signalNoop");
        else if (occ && (l.signal === "STARTED" || l.signal === "ESCALATED")) {
          occ.count("signals");
          if (l.drift > 0) occ.count("stableDrift");
        }
      }
      bump("territoryMarks", summary.marks);
      if (summary.upkeep) {
        const u = summary.upkeep.intent;
        bump("upkeepCharged", u.charged);
        bump("upkeepUnits", u.cost * u.charged);
        bump("upkeepIncome", u.income * u.charged);
        bump("upkeepUnpaid", u.shortfall);
        bump("upkeepForgiven", u.periods - u.charged);
        bump("upkeepAbandoned", summary.upkeep.abandoned);
        const occ = summary.upkeep.abandoned > 0 ? occupationService() : null;
        if (occ) occ.count("abandoned", summary.upkeep.abandoned);
        const bp = summary.upkeep.purchase;
        if (bp) {
          bump("unitPurchases");
          bump("unitPurchaseUnits", bp.units);
          bump("unitPurchaseIsk", bp.isk);
        }
        if (summary.upkeep.purchaseRefused) bump("unitPurchaseRefused");
      }
      const tu = summary.upkeep && summary.upkeep.trade;
      const trAny = tu || summary.tradeNotReady ? tradeService() : null;
      const tr = trAny && typeof trAny.count === "function" && typeof trAny.noteRefusal === "function" ? trAny : null;
      if (tr && tu) {
        if (tu.fundedUnits > 0) tr.count("funded");
        tr.count("fundedUnits", tu.fundedUnits);
        tr.count("fundedIsk", tu.fundedIsk);
        if (tu.capped) tr.count("fundCapped");
        if (tu.refused) {
          tr.count("fundRefused");
          tr.noteRefusal(`fund:${tu.refused}`);
        }
      }
      if (tr && summary.tradeNotReady) tr.count("notReady");
      const tv = summary.treasury;
      const treasuryRefused = summary.refused.filter((x) => x.type === "TREASURY");
      const unsettled = summary.warIsk > 0 && !tv;
      const tre = tv || treasuryRefused.length > 0 || unsettled ? treasuryService() : null;
      if (tre && typeof tre.count === "function") {
        if (unsettled) tre.count("warSpendUnsettled");
        if (tv) {
          if (tv.seeded) tre.count("seeded");
          tre.count("settled");
          tre.count("periodsCharged", tv.charged);
          if (tv.tradeFundedIsk > 0) tre.count("tradeFunded");
          const limitNotes = decision.notes.filter((n) => typeof n === "string"
            && n.startsWith("TREASURY_TRADE_LIMIT")).length;
          if (tv.tradeLimited || limitNotes > 0) tre.count("tradeLimited");
          if (tv.tradeRefused) {
            tre.count("tradeRefused");
            call(() => tre.noteRefusal(`trade:${tv.tradeRefused}`), null);
          }
          tre.count("unpaid", tv.unpaid);
          tre.count("productionFeeIsk", tv.productionFees || 0);
          tre.count("adminIsk", tv.admin || 0);
          tre.count("warSpendIsk", tv.warSpend || 0);
          if (tv.modeChanged === "ENTER") tre.count("austerityEntered");
          if (tv.modeChanged === "EXIT") tre.count("austerityExited");
        }
        if (treasuryRefused.length > 0) {
          tre.count("refused", treasuryRefused.length);
          call(() => tre.noteRefusal(`settle:${treasuryRefused[treasuryRefused.length - 1].reason}`), null);
        }
      }
      bump("minersMobilized", summary.minersMobilized);
      bump("mineDispatched", summary.dispatches.length);
      bump("minersReleased", summary.released);
      bump("produced", summary.produced.length);
      bump("hullsTaken", summary.hullsTaken);
      bump("mobilizeLegacy", summary.legacyMobilized);
      const produceRefused = summary.refused.filter((x) => x.type === "PRODUCE");
      bump("produceRefused", produceRefused.length);
      const pr = summary.produced.length + produceRefused.length > 0 ? productionService() : null;
      if (pr) {
        pr.count("started", summary.produced.length);
        pr.count("hullsStarted", summary.produced.reduce((n, x) => n + x.runs, 0));
        pr.count("mineralsConsumed", summary.produced.reduce((n, x) => n + x.minerals, 0));
        pr.count("pruned", summary.produced.reduce((n, x) => n + x.pruned, 0));
        pr.count("advancedConsumed", summary.produced.reduce((n, x) => n + (x.advanced || 0), 0));
        pr.count("advancedShort", summary.produced.reduce((n, x) => n + (x.advancedShort || 0), 0));
        pr.count("advancedRefused", produceRefused.filter((x) => x.itemKind === "moon" || x.itemKind === "pi").length);
        pr.count("startRefused", produceRefused.length);
        if (produceRefused.length > 0) pr.noteRefusal(`start:${produceRefused[produceRefused.length - 1].reason}`);
        pr.count("ladderProduce", summary.produced.filter((x) => x.ladder).length);
      }
      if (decision.notes.some((n) => n.startsWith("LADDER_SAVING:") || n.startsWith("LADDER_FEE_SHORT:")
        || n.startsWith("LADDER_WAR_ROOM_SHORT:"))) {
        const lpr = productionService();
        if (lpr) lpr.count("ladderReserveSet");
      }
      const overRoom = decision.notes.some((n) => n.startsWith("LADDER_OVER_ROOM:"));
      const unreachable = decision.notes.some((n) => n.startsWith("LADDER_FEE_UNREACHABLE:"));
      if (overRoom || unreachable) {
        const lpr = productionService();
        if (lpr && overRoom) lpr.count("ladderOverRoom");
        if (lpr && unreachable) lpr.count("ladderFeeUnreachable");
      }
      if (summary.released > 0) {
        const mr = miningService();
        if (mr) mr.count("orphansReleased", summary.released);
      }
      const mineRefused = summary.refused.filter((x) => x.type === "MINE_DISPATCH");
      bump("mineRefused", mineRefused.length);
      const mn = summary.dispatches.length + mineRefused.length > 0 ? miningService() : null;
      if (mn) {
        mn.count("dispatched", summary.dispatches.length);
        mn.count("localStarts", summary.dispatches.filter((x) => x.local).length);
        mn.count("pruned", summary.dispatches.reduce((n, x) => n + x.pruned, 0));
        mn.count("dispatchRefused", mineRefused.length);
        if (mineRefused.length > 0) mn.noteRefusal(`dispatch:${mineRefused[mineRefused.length - 1].reason}`);
      }
      bump("logisticsMobilized", summary.logisticsMobilized);
      bump("convoysDispatched", summary.convoys.length);
      const convoyRefused = summary.refused.filter((x) => x.type === "CONVOY_DISPATCH");
      bump("convoyRefused", convoyRefused.length);
      const lg = summary.convoys.length + convoyRefused.length + summary.tributeForfeited.length > 0
        ? logisticsService() : null;
      if (lg) {
        lg.count("dispatched", summary.convoys.length);
        lg.count("localLoads", summary.convoys.filter((x) => x.local).length);
        lg.count("pruned", summary.convoys.reduce((n, x) => n + x.pruned, 0));
        lg.count("dispatchRefused", convoyRefused.length);
        if (convoyRefused.length > 0) lg.noteRefusal(`dispatch:${convoyRefused[convoyRefused.length - 1].reason}`);
        lg.count("tributeDispatched", summary.convoys.filter((x) => x.tribute).length);
        lg.count("tributeForfeited", summary.tributeForfeited.length);
      }
      for (const reason of summary.tributeForfeited) log(`strategy: ${f} r${b} tribute forfeited ${reason}`);
      bump("replenished", summary.replenished);
      bump("replenishHulls", summary.replenishHulls);
      bump("replenishRefused", summary.refused.filter((x) => x.type === "REPLENISH").length);
      const rl = summary.replenished > 0 ? logisticsService() : null;
      if (rl) {
        rl.count("replenished", summary.replenished);
        rl.count("replenishHulls", summary.replenishHulls);
      }
      const tradeOffers = summary.applied.TRADE_OFFER || 0;
      const tradeCancels = summary.applied.TRADE_CANCEL || 0;
      bump("tradeOffers", tradeOffers);
      bump("tradeCancels", tradeCancels);
      const tradeRefused = summary.refused.filter((x) => x.type === "TRADE_OFFER" || x.type === "TRADE_CANCEL").length;
      bump("tradeRefused", tradeRefused);
      const trTrade = (tradeOffers + tradeCancels + tradeRefused) > 0 ? tradeService() : null;
      if (trTrade) {
        if (tradeOffers > 0) trTrade.count("offerCreated", tradeOffers);
        if (tradeCancels > 0) trTrade.count("offerCancelled", tradeCancels);
        if (tradeRefused > 0) trTrade.count("offerRefused", tradeRefused);
        const privateOffers = summary.privateOffers;
        const privateNoGain = summary.refused.filter((x) => x.type === "TRADE_OFFER" && x.reason && x.reason.startsWith("TRADE_PRIVATE_NO_GAIN")).length;
        const privateCooldown = summary.refused.filter((x) => x.type === "TRADE_OFFER" && x.reason && x.reason.startsWith("TRADE_PRIVATE_COOLDOWN")).length;
        if (privateOffers > 0) trTrade.count("privateOffers", privateOffers);
        if (privateNoGain > 0) trTrade.count("privateNoGain", privateNoGain);
        if (privateCooldown > 0) trTrade.count("privateCooldown", privateCooldown);
        if (summary.stockpileOffers > 0) trTrade.count("stockpileOffers", summary.stockpileOffers);
        if (summary.tierOffers[0] > 0) trTrade.count("tierOffers1", summary.tierOffers[0]);
        if (summary.tierOffers[1] > 0) trTrade.count("tierOffers2", summary.tierOffers[1]);
        if (summary.tierOffers[2] > 0) trTrade.count("tierOffers3", summary.tierOffers[2]);
        if (summary.oreOffers > 0) trTrade.count("oreOffers", summary.oreOffers);
        if (summary.commodityOffers > 0) trTrade.count("commodityOffers", summary.commodityOffers);
        if (summary.stockpileRecalls > 0) trTrade.count("stockpileRecalls", summary.stockpileRecalls);
        if (summary.hullOffers > 0) trTrade.count("hullOffers", summary.hullOffers);
        if (summary.wtsOffers > 0) trTrade.count("wtsOffers", summary.wtsOffers);
        if (summary.wtsStockLost > 0) trTrade.count("wtsStockLost", summary.wtsStockLost);
        if (summary.wtsRecalls > 0) trTrade.count("wtsRecalls", summary.wtsRecalls);
        if (summary.warOffers > 0) trTrade.count("warOffers", summary.warOffers);
        if (summary.warRepriced > 0) trTrade.count("warRepriced", summary.warRepriced);
        if (summary.warStationCapped > 0) trTrade.count("warStationCapped", summary.warStationCapped);
      }
      const localFiltered = localFilteredOf(decision.notes);
      const trLocal = localFiltered > 0 ? tradeService() : null;
      if (trLocal) trLocal.count("localFiltered", localFiltered);
      bump("buildsPlanned", summary.builds.length);
      const buildRefused = summary.refused.filter((x) => x.type === "BUILD_PLAN");
      bump("buildRefused", buildRefused.length);
      const cs = summary.builds.length + buildRefused.length > 0 ? constructionService() : null;
      if (cs) {
        for (const v of summary.builds) {
          call(() => cs.noteCommitted(v), null);
          log(`strategy: ${f} r${b} build plan ${v.stationId} in ${v.systemId}`);
        }
        if (buildRefused.length > 0) {
          call(() => cs.noteRefusal(`plan:${buildRefused[buildRefused.length - 1].reason}`), null);
        }
      }
      bump("sentryBuilds", summary.sentryBuilds.length);
      const sv = summary.sentryBuilds.length > 0 ? sentriesService() : null;
      if (sv) {
        for (const v of summary.sentryBuilds) {
          call(() => sv.noteCommitted(v), null);
          log(`strategy: ${f} r${b} sentry ${v.sentryId} at ${v.anchorKind} in ${v.systemId} slot ${v.slot}`);
        }
      }
      const logisticsDisbands = summary.disbands.filter((x) => x.reason !== STRANDED_REASON
        && x.reason !== RELIEF_REASON);
      const strandedDisbands = summary.disbands.filter((x) => x.reason === STRANDED_REASON);
      const upkeepDisbands = summary.disbands.filter((x) => x.reason === RELIEF_REASON);
      bump("upkeepDisbanded", upkeepDisbands.length);
      bump("upkeepDisbandShips", upkeepDisbands.reduce((n, x) => n + (x.ships || 0), 0));
      bump("upkeepDisbandHullsLost", upkeepDisbands.reduce((n, x) => n + x.hullsLost, 0));
      bump("upkeepDisbandRefused", summary.upkeepDisbandRefused);
      for (const x of upkeepDisbands) log(`strategy: ${f} r${b} upkeep demobilize ${x.fleetId} ships ${x.ships}`);
      bump("logisticsDisbanded", logisticsDisbands.length);
      bump("logisticsDisbandNoBase", logisticsDisbands.filter((x) => x.reason === "NO_BASE").length);
      bump("logisticsDisbandHulls", logisticsDisbands.reduce((n, x) => n + x.hullsReturned, 0));
      bump("logisticsDisbandHullsLost", logisticsDisbands.reduce((n, x) => n + x.hullsLost, 0));
      bump("strandedDisbanded", strandedDisbands.length);
      bump("strandedDisbandHulls", strandedDisbands.reduce((n, x) => n + x.hullsReturned, 0));
      bump("strandedDisbandHullsLost", strandedDisbands.reduce((n, x) => n + x.hullsLost, 0));
      bump("strandedRefused", summary.combatStrandedRefused);
      bump("logisticsRetireRefused", summary.retireRefused);
      bump("logisticsStrandedRefused", summary.strandedRefused);
      bump("merged", summary.merges.length);
      bump("mergeRefused", summary.refused.filter((x) => x.type === "MERGE").length);
      bump("garrisonReleased", summary.garrisonReleased);
      bump("garrisonReleaseRefused", summary.refused.filter((x) => x.type === "GARRISON_RELEASE").length);
      for (const x of summary.merges) {
        log(`strategy: ${f} r${b} merge ${x.absorbedId} -> ${x.keeperId} ${x.fleetRole} in ${x.systemId} ships=${x.ships}`);
      }
      bump("upgrades", summary.upgrades);
      bump("upgradeHulls", summary.upgradeHulls);
      bump("upgradeRefused", summary.refused.filter((x) => x.type === "FLEET_UPGRADE").length);
      bump("industryJobs", summary.industryJobs);
      bump("mineralSwaps", summary.applied.MINERAL_SWAP || 0);
      bump("huntersMobilized", summary.huntersMobilized);
      bump("hiveBroodMobilized", summary.hiveBroodMobilized);
      bump("hiveSwarms", summary.hiveSwarms);
      bump("hiveSwarmFleets", summary.hiveSwarmFleets);
      bump("hiveSwarmRefused", summary.hiveSwarmRefused);
      if (summary.homePoolMobilized > 0) {
        metric("count", "strategy.invaderEconomy.homePoolMobilize", summary.homePoolMobilized);
      }
      noteInvaderYield(decision);
      bump("capitalAttached", summary.capitalAttached);
      bump("capitalAttachSkipped", summary.capitalAttachSkipped);
      bump("capitalEscort", summary.capitalEscort);
      bump("capitalReplenished", summary.capitalReplenished);
      bump("escalatedMobilized", summary.escalatedMobilized);
      bump("escalationFallback", summary.escalationFallback);
      bump("capitalLevelGated", summary.capitalLevelGated);
      bump("escalationLevel0", summary.escalationLevel0);
      bump("escalationLevel1", summary.escalationLevel1);
      bump("escalationLevel2", summary.escalationLevel2);
      bump("escalationLevel3", summary.escalationLevel3);
      for (const x of summary.disbands) {
        log(`strategy: ${f} r${b} disband ${x.fleetId} ${x.reason} hulls=${x.hullsReturned}`);
      }
      const trimmer = trimService();
      if (trimmer) {
        call(() => trimmer.noteReview(f, decision.trimCursor || null, { done: summary.trimDone === true,
          planned: summary.trimPlanned }), null);
      }
      if (summary.marks > 0) {
        const occ = occupationService();
        if (occ) occ.count("detachedMarked", summary.marks);
      }
      const touch = summary.refused.filter((x) => x.type === "FACTION_TOUCH").length;
      bump("touchRefused", touch);
      bump("intentRefused", summary.refused.length - touch);
      if (summary.refused.length > 0) {
        const last = summary.refused[summary.refused.length - 1];
        lastRefusal = `${last.type}:${last.reason}`;
      }
    }
    for (const note of decision.notes) {
      if (note.startsWith("DEFENSE_LAUNCH")) bump("defenses");
      if (note.startsWith("DEFENSE_INSUFFICIENT")) bump("defenseInsufficient");
      if (note.startsWith("INVADER_COUNTER_INSUFFICIENT:")) bump("invaderCounterInsufficient");
      if (note.startsWith("BOSS_RESPONSE_INSUFFICIENT:")) bump("bossResponseInsufficient");
      if (note.startsWith("RECLAIM:")) bump("reclaims");
      if (note === "TERRITORY_LIMIT") bump("territoryLimit");
      if (note === "CAPTURE_NOT_ADJACENT") bump("captureNotAdjacent");
      if (note === "BORDER_POST_CAPPED") bump("borderPostCapped");
      if (note === "BORDER_POST_TOO_STRONG") bump("borderPostTooStrong");
      if (note === "MINER_ESCORT_CAPPED") bump("minerEscortCapped");
      if (note === "MINER_ESCORT_TOO_STRONG") bump("minerEscortTooStrong");
    }
    if (summary) notePlanOf(f, decision, summary);
    if (decision.lostHomeCursorNext !== undefined && decision.lostHomeCursorNext !== null) {
      lostHomeCursor.set(f, decision.lostHomeCursorNext);
    }
    if (summary && belt) {
      capitalUsage.set(f, tallyReview(capitalUsage.get(f) || null, { at: summary.at, notes: decision.notes,
        applied: summary.usageIntents, ladder: decision.ladderDiag || null, inventory: belt.capitalInventory || null }));
      const codes = new Set(decision.notes.map((n) => String(n).split(":")[0]));
      if (codes.has("CAPITAL_NOT_AT_STATION")) bump("capitalNotAtStation");
      if (codes.has("LADDER_WAIT_BUFFER")) bump("ladderWaitBuffer");
      if (codes.has("LADDER_SAVING")) bump("ladderSaving");
    }
    remember(f, b, decision, summary, belt);
  }

  const factionParams = new Map();
  function paramsFor(f) {
    if (!factionParams.has(f)) {
      const entry = registry && typeof registry.getFaction === "function" ? registry.getFaction(f) : null;
      const E = invaderEconomyParamsOf(config, f, entry && Number.isSafeInteger(entry.hqSystemId)
        ? entry.hqSystemId : null);
      factionParams.set(f, invaderFactionParamsOf(params, E));
    }
    return factionParams.get(f);
  }

  function handler(ev, hctx) {
    try {
      const p = ev && ev.payload;
      if (!p || !isId(p.factionId) || !Number.isSafeInteger(p.round) || p.round < 0
        || Object.keys(p).some((k) => k !== "factionId" && k !== "round")) {
        return { ok: false, reason: "REVIEW_PAYLOAD_INVALID", permanent: true };
      }
      if (stopped) return { ok: false, reason: "STRATEGY_STOPPED" };
      const f = p.factionId;
      const b = p.round;
      const at = hctx && Number.isSafeInteger(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      const next = nextOf(f, at);
      const graph = currentGraph();
      if (!graph) {
        const decision = { outcome: "DEFERRED", notes: ["GRAPH_NOT_READY"], target: null, supply: null, stuck: 0 };
        return { ok: true, outcome: "DEFERRED", reschedule: next, onCommitted: () => onCommitted(f, b, decision, null) };
      }
      const t0 = nowMs();
      const read = readSnapshot(f, b, at, graph);
      metric("observe", "strategy.reviewReadMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
      if (!read.ok) return { ok: false, reason: read.reason || "REVIEW_READ_FAILED" };
      if (read.skip) {
        const decision = { outcome: "SKIPPED", notes: [read.skip], target: null, supply: null, stuck: 0 };
        return { ok: true, outcome: "SKIPPED", onCommitted: () => onCommitted(f, b, decision, null) };
      }
      if (!expansionLogged.has(f) && read.snapshot.doctrine.expandsBeyondTheatre === true) {
        expansionLogged.add(f);
        log(`strategy: ${f} expansion candidates=${read.snapshot.expansion.length}`);
      }
      const t1 = nowMs();
      let decision = decideReview(read.snapshot, paramsFor(f));
      metric("observe", "strategy.decideMs", Math.round((nowMs() - t1) * MS_DECIMALS) / MS_DECIMALS);
      threwLog.note(f, decision);
      if (typeof hooks.beforeEffect === "function") decision = hooks.beforeEffect(decision, read.snapshot) || decision;
      const snapshot = read.snapshot;
      const sb = snapshot.border;
      const skip = new Set([...snapshot.theatre, ...snapshot.expansion]);
      const belt = { mode: sb.mode, systems: sb.reach instanceof Map ? sb.reach.size : 0,
        candidates: new Set(sb.candidates.filter((id) => !skip.has(id))),
        rejected: Number.isSafeInteger(sb.rejected) ? sb.rejected : 0,
        raidTargets: Array.isArray(snapshot.raidTargets) ? snapshot.raidTargets.length : 0,
        raidSet: new Set(Array.isArray(snapshot.raidTargets) ? snapshot.raidTargets : []),
        hiveNodes: snapshot.doctrine && snapshot.doctrine.hive === true && Array.isArray(snapshot.footholds)
          ? snapshot.footholds.length : null,
        escortIntelTruncated: read.escortIntelTruncated === true,
        intruders: snapshot.intruders || null,
        truce: Array.isArray(snapshot.truce) ? snapshot.truce : null,
        capitalInventory: inventoryOf(snapshot),
        transitRisk: snapshot.transitRisk ? call(() => snapshot.transitRisk.stats(), null) : null };
      return { ok: true, outcome: decision.outcome, reschedule: next,
        effect: (tx) => applyDecision(tx, decision, snapshot, at, graph),
        onCommitted: (summary) => onCommitted(f, b, decision, summary && summary.ok ? summary : null, belt) };
    } catch (err) {
      return { ok: false, reason: `REVIEW_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (stopped) return { ok: false, reason: "STRATEGY_STOPPED" };
      const ready = call(() => scheduler.getStatus().state === SCHEDULER_READY, false);
      if (!ready || typeof scheduler.enqueueMany !== "function") return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
      const read = store.transaction("strategy.bootstrapRead", (db) => strategyRepository.listFactions(db));
      const listed = read.ok ? read.value : read;
      if (!listed || !listed.ok) return { ok: false, reason: (listed && listed.reason) || "TX_FAILED" };
      const now = clock.now();
      const specs = listed.records.filter((r) => r.status !== "ELIMINATED" && registry.isActive(r.factionId))
        .map((r) => {
          const n = nextOf(r.factionId, now);
          return { eventType: EVENT_TYPE, aggregateId: String(r.factionId), dueAt: n.dueAt, payload: n.payload,
            idempotencyKey: n.idempotencyKey };
        });
      const r = scheduler.enqueueMany(specs);
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      bootstrapped = { enqueued: r.enqueued, duplicates: r.duplicates,
        reason: r.refusal ? String(r.refusal.reason) : null };
      metric("count", "strategy.bootstrap.enqueued", r.enqueued);
      metric("count", "strategy.bootstrap.duplicates", r.duplicates);
      seq += 1;
      return { ok: true, enqueued: r.enqueued, duplicates: r.duplicates, refusal: r.refusal || null };
    } catch (err) {
      return { ok: false, reason: `BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "on", seq, counters: Object.freeze({ ...counters }),
      lastRefusal, bootstrap: Object.freeze({ ...bootstrapped }),
      border: Object.freeze(Object.fromEntries(borderMemory)) });
  }

  return Object.freeze({
    handler,
    bootstrap,
    getStatus,
    getMemory: (f) => memory.get(Number(f)) || null,
    getCapitalUsage: (f) => capitalUsage.get(Number(f)) || null,
    getSeq: () => seq,
    params,
    schedule: Object.freeze({ phaseOf, bucketOf, dueOf, reviewKey, nextOf }),
    stop() {
      stopped = true;
    },
  });
}

module.exports = { createReviewService, EVENT_TYPE, LIVE_FLEET_STATES, logisticsParamsOf, treasuryParamsOf,
  TREASURY_PARAM_KEYS, LOWSEC_PARAM_KEYS, lowsecIdsOf, garrisonEstimateOf, intelKey, capitalAttachParamsOf,
  fleetCompositionOf, COUNTER_NAMES, NOTE_COUNTERS, isNoHullsNote, replenishReturnParamsOf, readOutpostSites,
  ownInfluenceOf, readIntrudersOf, playerSovParamsOf, PLAYER_SOV_PARAM_KEYS, playerValueParamsOf,invaderEconomyParamsOf, INVADER_ECONOMY_PARAM_KEYS,
  invaderFactionParamsOf, mineralSwapParamsOf, escalationParamsOf, capitalLevelParamsOf, capitalEscortParamsOf,
  capitalReplenishParamsOf, readDevLevels };
