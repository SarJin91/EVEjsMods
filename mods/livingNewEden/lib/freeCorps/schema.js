"use strict";

const TABLE = "world_free_corps";

const CORP_STATES = Object.freeze({
  FOUNDING: "FOUNDING",
  ACTIVE: "ACTIVE",
  STRUGGLING: "STRUGGLING",
  MERGED: "MERGED",
  DISSOLVED: "DISSOLVED",
  REFUSED: "REFUSED",
});
const OPEN_STATES = Object.freeze([CORP_STATES.FOUNDING, CORP_STATES.ACTIVE, CORP_STATES.STRUGGLING]);

const ARCHETYPES = Object.freeze(["miner", "hauler", "ratter", "explorer", "industrialist", "missioner", "hunter",
  "structure"]);
const BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);

const OWNER_KIND = "free";
const AGGREGATE = "free_corp";
const EVENT_FOUNDED = "FREE_CORP_FOUNDED";
const EVENT_ACTIVATED = "FREE_CORP_ACTIVATED";
const EVENT_REFUSED = "FREE_CORP_REFUSED";
const KEY_PREFIX = "lne:fc:";
const keyFound = (corpId) => `${KEY_PREFIX}found:${corpId}`;
const keyActivate = (corpId) => `${KEY_PREFIX}activate:${corpId}`;
const keyRefuse = (corpId) => `${KEY_PREFIX}refuse:${corpId}`;

const VENTURES_TABLE = "world_free_corp_ventures";
const VENTURE_STATES = Object.freeze({
  TRAVEL: "TRAVEL",
  WORKING: "WORKING",
  RETURNING: "RETURNING",
  HELD: "HELD",
  STRANDED: "STRANDED",
  DONE: "DONE",
  ABORTED: "ABORTED",
  LOST: "LOST",
});
const VENTURE_OPEN_STATES = Object.freeze([VENTURE_STATES.TRAVEL, VENTURE_STATES.WORKING, VENTURE_STATES.RETURNING,
  VENTURE_STATES.HELD, VENTURE_STATES.STRANDED]);
const VENTURE_KINDS_ALL = Object.freeze(["MINE", "HAUL", "RAT", "EXPLORE", "BUILD", "RUN", "EXPLORE_WH", "HUNT",
  "ANCHOR", "WH_HOME", "WH_RAID", "WH_HAUL"]);
const WH_CORP_KINDS = Object.freeze(["WH_HOME", "WH_RAID", "WH_HAUL"]);
const VENTURE_ENGINE_KINDS = Object.freeze(["MINE", "HAUL", "RAT", "EXPLORE", "BUILD", "RUN", "EXPLORE_WH", "HUNT",
  "WH_HOME", "WH_RAID", "WH_HAUL"]);
const WH_END_REASONS = Object.freeze(["WH_GONE", "WH_OFFLINE", "WH_REROUTE", "WH_RESCUED", "STRANDED",
  "STRANDED_LOSS"]);
const WH_HOMES_TABLE = "world_free_corp_wh_homes";
const WH_CORP_END_REASONS = Object.freeze(["CORP_CLOSED"]);
const EVENT_WH_SOLD = "FREE_CORP_WH_SOLD";
const keyWhSale = (corpId, seq) => `${KEY_PREFIX}whsale:${corpId}:${seq}`;
const WH_HAUL_END_REASONS = Object.freeze(["WH_GONE", "WH_OFFLINE", "WH_LONG_WAY"]);
const MAX_WH_HUBS = 16;
function parseWhHubSystemIds(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length < 1 || parts.length > MAX_WH_HUBS) return null;
  const ids = [];
  for (const part of parts) {
    if (!/^\d{1,10}$/.test(part)) return null;
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0 || ids.includes(id)) return null;
    ids.push(id);
  }
  return Object.freeze(ids);
}
const WH_RAID_END_REASONS = Object.freeze(["WH_GONE", "WH_OFFLINE", "WH_LONG_WAY"]);
function parseRaidBands(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length < 1 || parts.length > BANDS.length) return null;
  const out = [];
  for (const part of parts) {
    if (!BANDS.includes(part) || out.includes(part)) return null;
    out.push(part);
  }
  return Object.freeze(out);
}
const VENTURE_KIND_EVENTS = Object.freeze(["started", "done", "lost", "held"]);
const VENTURE_KIND_COUNTER_NAMES = Object.freeze(VENTURE_ENGINE_KINDS.flatMap((k) => VENTURE_KIND_EVENTS
  .map((e) => `${k}.${e}`)));
const EVENT_GREW = "FREE_CORP_GREW";
const EVENT_DISSOLVED = "FREE_CORP_DISSOLVED";
const keyGrow = (corpId, members) => `${KEY_PREFIX}grow:${corpId}:${members}`;
const keyDissolve = (corpId) => `${KEY_PREFIX}dissolve:${corpId}`;

const WARS_TABLE = "world_free_corp_wars";
const SKIRMISHES_TABLE = "world_free_corp_skirmishes";
const WAR_STATES = Object.freeze({ DECLARED: "DECLARED", ACTIVE: "ACTIVE", ENDED: "ENDED" });
const WAR_END_REASONS = Object.freeze(["TIMEOUT", "SURRENDER", "SIDE_CLOSED"]);
const SKIRMISH_OUTCOMES = Object.freeze({ ATTACKER_WIN: "ATTACKER_WIN", DEFENDER_WIN: "DEFENDER_WIN" });
const warIdOf = (corpA, corpB, n) => `fcw:${corpA}:${corpB}:${n}`;
const skirmishIdOf = (ventureId, step) => `fcs:${ventureId}:${step}`;

const OUTBOX_TABLE = "world_free_corp_outbox";
const OUTBOX_KINDS = Object.freeze(["KILLMAIL", "CONTRACT_WTS", "JOIN", "CORP_CLOSE", "ANCHOR", "CEO_CLEAN",
  "CONTRACT_COURIER"]);
const OUTBOX_KIND_KILLMAIL = "KILLMAIL";
const OUTBOX_KIND_CONTRACT_WTS = "CONTRACT_WTS";
const OUTBOX_KIND_CONTRACT_COURIER = "CONTRACT_COURIER";
const OUTBOX_KIND_JOIN = "JOIN";
const OUTBOX_KIND_CORP_CLOSE = "CORP_CLOSE";
const OUTBOX_KIND_ANCHOR = "ANCHOR";
const OUTBOX_KIND_CEO_CLEAN = "CEO_CLEAN";
const OUTBOX_STATES = Object.freeze({ PENDING: "PENDING", DONE: "DONE", FAILED: "FAILED" });
const MAX_OUTBOX_PAYLOAD = 4096;
const MAX_OUTBOX_ERROR = 200;
const killmailKeyOf = (skirmishId) => `${KEY_PREFIX}km:${skirmishId}`;

const CONTRACTS_TABLE = "world_free_corp_contracts";
const CONTRACT_KINDS = Object.freeze(["WTS", "COURIER"]);
const CONTRACT_STATES = Object.freeze({ PLANNED: "PLANNED", ISSUING: "ISSUING", OPEN: "OPEN",
  RETURNING: "RETURNING", SOLD: "SOLD", CLOSED: "CLOSED", CANCELLED: "CANCELLED", ACCEPTED: "ACCEPTED" });
const CONTRACT_OPEN_STATES = Object.freeze(["PLANNED", "ISSUING", "OPEN", "RETURNING", "ACCEPTED"]);
const CONTRACT_GOODS = Object.freeze(["ORE", "MINERAL", "HULL", "GAS"]);
const MAX_RETURN_PLAN = 2048;
const MAX_CONTRACT_END_REASON = 40;
const contractKeyOf = (corpId, seq) => `fcc:${corpId}:${seq}`;
const contractOutboxKeyOf = (ventureId) => `${KEY_PREFIX}ct:${ventureId}`;
const CONTRACT_TAG_PREFIX = "[LNE:fcc:";

const MEMBERS_TABLE = "world_free_corp_members";
const MEMBER_STATES = Object.freeze({ FREE: "FREE", JOINING: "JOINING", MEMBER: "MEMBER", LOST: "LOST" });
const EVENT_MERGED = "FREE_CORP_MERGED";
const keyMerge = (corpId) => `${KEY_PREFIX}merge:${corpId}`;
const keyJoin = (characterId, moves) => `${KEY_PREFIX}join:${characterId}:${moves}`;
const keyClose = (corpId) => `${KEY_PREFIX}close:${corpId}`;
const MAX_DESCRIPTION_LENGTH = 1000;

const CEO_RELEASED = Object.freeze({ PENDING: 0, POOLED: 1, NONE: 2 });
const keyCeoClean = (corpId) => `${KEY_PREFIX}ceo:${corpId}`;

const STRUCTURES_TABLE = "world_free_corp_structures";
const STRUCTURE_STATES = Object.freeze({ PLANNED: "PLANNED", ANCHORING: "ANCHORING", ONLINE: "ONLINE", LOST: "LOST",
  REMOVED: "REMOVED", FAILED: "FAILED" });
const STRUCTURE_OPEN_STATES = Object.freeze(["PLANNED", "ANCHORING", "ONLINE"]);
const STRUCTURE_END_REASONS = Object.freeze(["DESTROYED", "VANISHED", "CORP_CLOSED", "CLEANUP", "MOD_DESTROYED",
  "EXPIRED"]);
const MAX_STRUCTURE_END_REASON = 32;
const STRUCTURES_MAX_TOTAL = 8;
const STRUCTURE_NAME_MAX = 64;
const keyStructure = (corpId, n) => `${KEY_PREFIX}st:${corpId}:${n}`;

const MAX_NAME_LENGTH = 50;
const MAX_END_REASON_LENGTH = 64;
const MAX_MEMBERS = 10;

const COUNTER_NAMES = Object.freeze(["passes", "deferrals", "passTruncated", "passFailed", "founded", "activated",
  "refused", "ensureQueued", "ensureFailed", "specMissing", "identityRepairs", "corporationIdChanged", "refusedActive",
  "foundingStale", "foundingWaitOpen", "foundingWaitVc", "foundingWaitGraph", "foundingBlockedBudget",
  "foundingBlockedRefused", "foundingNoArchetype", "foundingNoHome", "foundingNameExhausted", "foundingNoRoom",
  "casConflicts", "vcUnavailable",
  "ventureSteps", "ventureStarted", "ventureDone", "ventureLost", "ventureHeld", "ventureHoldLimit", "ventureRest",
  "ventureNoCrew", "ventureNoKind", "ventureNoGraph", "ventureNoTarget", "ventureNoFunds", "upkeepPaid", "upkeepShort",
  "struggling", "recovered", "dissolved", "grew", "growthBlockedBudget", "pruned", "presenceUnavailable",
  "residentsReads", "residentsCached", "residentsFailed", "residentsCut", "mapReads", "mapCached", "mapFailed",
  "chatterReads", "chatterFailed", "newsReads", "newsFailed",
  "whEntryGone", "whOffline", "whCut", "whRerouted", "whStranded", "whRescued", "whStrandedWait", "whStrandedLost",
  "whSyncWait", "whExitDeferred", "whNoExit", "whIndexBuilds", "whIndexFailed",
  "touchedSkips", "huntSteps", "huntNoPrey", "huntNoEngage", "huntBudget", "huntHeld", "huntHoldLimit",
  "huntPreyBuilds", "huntPreyTruncated", "skirmishes", "skirmishAttackerWins", "skirmishDefenderWins", "skirmishWar",
  "warsDeclared", "warsAllied", "warsActivated", "warsEnded", "warsSurrendered", "warsTimedOut", "warsSideClosed",
  "warCooldown", "warAtWar", "warNoTarget", "warLimit", "warsPruned", "skirmishesPruned",
  "foundingQuotaRefused",
  "kmEnqueued", "kmBacklogDrop", "kmNoIdentity", "kmNoPilots", "kmSeamUnavailable", "kmDeferred", "kmSpacing",
  "kmCalls", "kmDone", "kmRetry", "kmFailed", "kmExpired", "kmPruned", "kmSlowPause", "kmSlowPaused",
  "kmClaimConflict", "kmSettleConflict",
  "ctPlanned", "ctSkipPassBudget", "ctSkipNotEligible", "ctSkipChance", "ctSkipNoIdentity", "ctSkipNoGoods",
  "ctSkipSmallLot", "ctSkipFull", "ctSkipCorpFull", "ctSkipSameLot", "ctSeamUnavailable", "ctGoodsInvalid",
  "ctFactsMissing", "ctDeferred", "ctSpacing", "ctIssueCalls", "ctFound", "ctIssued", "ctIssueRetry", "ctIssueFailed",
  "ctIssueExpired", "ctCancelled", "ctPolls", "ctNudges", "ctSold", "ctRevenueIsk", "ctRevenueClosedCorp",
  "ctDeleteRetry", "ctReturned", "ctVoidedUnits", "ctClosed", "ctPruned", "ctClaimConflict", "ctSettleConflict",
  "ctCleanupDone",
  "rcMerged", "rcMergeNoPartner", "rcMergeBudget", "rcFreed", "rcRecruitFounding", "rcRecruitGrowth",
  "rcReleasedRefused", "rcMemberAnomaly", "rcSeamUnavailable", "rcDeferred", "rcSpacing", "rcSlowPause",
  "rcSlowPaused", "rcJoinCalls", "rcJoinDone", "rcJoinAlready", "rcJoinCleaned", "rcJoinRetry", "rcJoinFailed",
  "rcJoinSuperseded", "rcJoinTargetWait", "rcCloseCalls", "rcCloseDone", "rcCloseFailed", "rcClaimConflict",
  "rcSettleConflict",
  "rcReleasedDissolved", "rcJoinTargetClosed",
  "stPlanned", "stCap", "stSkipIsk", "stSkipCorpCap", "stSkipSystemCap", "stSkipCooldown", "stBlockedSov",
  "stBlockedStation", "stBlockedUnknown", "stSpacing", "stCalls", "stAnchored", "stAdopted", "stNoPosition", "stRetry",
  "stFailed", "stExpired", "stRefund", "stRefundClosed", "stOnline", "stPatched", "stUpkeepRestored",
  "stLostDestroyed", "stLostVanished", "stRemoved", "stOrphanRemoved", "stFlushFailed", "stSeamUnavailable",
  "stDeferred", "stRecordConflict",
  "stRecordFailed",
  "ceoReleased", "ceoReleaseWaitContracts", "ceoReleaseWaitVc", "ceoReleaseNoIdentity", "ceoReleaseAnomaly",
  "ceoAdopted", "ceoAdoptFallback", "ceoReturnedRefused", "rcCeoCleanDone", "rcCeoCleanFailed",
  "ceoReturnedFallback", "ceoReturnFailed",
  "ceoPeekFailed", "ceoPeekFallback",
  "stQuotaRefused",
  "growthHeldStructure",
  "ctCourierPlanned", "ctCourierSkipNotEligible", "ctCourierSkipNoIdentity", "ctCourierSkipChance",
  "ctCourierSkipNoGoods", "ctCourierSkipSmallLot", "ctCourierSkipNoDestination", "ctCourierSkipFull",
  "ctCourierSkipNoFunds", "ctCourierSkipNoVolume", "ctCourierSeamUnavailable", "ctCourierVolumeCapped",
  "ctCourierIssued", "ctCourierAccepted", "ctCourierDelivered", "ctCourierFailed", "ctCourierFailCalls",
  "ctCourierFailEarly", "ctCourierOther", "ctCourierRewardIsk", "ctCourierRefundIsk", "ctCourierCollateralIsk",
  "ctCourierDefundShort",
  "whCorpsFounded", "whQuotaNoHome", "whQuotaRefused", "whQuotaWait", "whStockFull", "whStockCapped", "whHomeOrphan",
  "whHomeSwept", "whKindUnknown",
  "whHaulSold", "whHaulStagingSale", "whHaulNoCargo", "whHaulGone", "whHaulOffline", "whHaulRerouted",
  "whHaulStranded", "whHaulRescued", "whLongWay", "whCargoRestored", "whHaulExitDeferred", "whHaulBadHubs",
  "whRaidGone", "whRaidOffline", "whRaidBudget", "whRaidExitDeferred", "whRaidNoExit", "whRaidAreaDeferred",
  "whRaidNoArea", "whRaidObservedStep", "whRaidRerouted", "whRaidStranded", "whRaidRescued", "whRaidLongWay",
  "whRaidBadBands",
  "whContractPlanned", "whContractSkipLimit", "whContractSkipNoStation", "whContractSkipNoIdentity",
  "whContractSkipNoFacts", "whContractSkipChance", "whContractSkipNoGoods", "whContractSkipSmallLot",
  "ctGasFactsMissing"]);
const GAUGE_OPEN = "freeCorps.open";
const GAUGE_FOUNDING = "freeCorps.founding";
const GAUGE_OPEN_VENTURES = "freeCorps.openVentures";
const GAUGE_OPEN_WARS = "freeCorps.openWars";
const GAUGE_KILLMAILS_PENDING = "freeCorps.killmailsPending";
const GAUGE_CONTRACTS_OPEN = "freeCorps.contractsOpen";
const GAUGE_MEMBERS_FREE = "freeCorps.membersFree";
const GAUGE_JOINS_PENDING = "freeCorps.joinsPending";
const GAUGE_STRUCTURES_OPEN = "freeCorps.structuresOpen";
const GAUGE_NAMES = Object.freeze([GAUGE_OPEN, GAUGE_FOUNDING, GAUGE_OPEN_VENTURES, GAUGE_OPEN_WARS,
  GAUGE_KILLMAILS_PENDING, GAUGE_CONTRACTS_OPEN, GAUGE_MEMBERS_FREE, GAUGE_JOINS_PENDING, GAUGE_STRUCTURES_OPEN]);
const HISTOGRAM_PASS_MS = "freeCorps.passMs";
const HISTOGRAM_CHATTER_READ_MS = "freeCorps.chatterReadMs";
const HISTOGRAM_WH_INDEX_MS = "freeCorps.whIndexMs";
const HISTOGRAM_KILLMAIL_CALL_MS = "freeCorps.killmailCallMs";
const HISTOGRAM_CONTRACT_ISSUE_MS = "freeCorps.contractIssueMs";
const HISTOGRAM_JOIN_CALL_MS = "freeCorps.joinCallMs";
const HISTOGRAM_STRUCTURE_CALL_MS = "freeCorps.structureCallMs";
const HISTOGRAM_NAMES = Object.freeze([HISTOGRAM_PASS_MS, HISTOGRAM_CHATTER_READ_MS, HISTOGRAM_WH_INDEX_MS,
  HISTOGRAM_KILLMAIL_CALL_MS, HISTOGRAM_CONTRACT_ISSUE_MS, HISTOGRAM_JOIN_CALL_MS, HISTOGRAM_STRUCTURE_CALL_MS]);

const FACADE_METHODS = Object.freeze(["runPassNow", "getStatus", "stop", "residentsFor", "listMapMarks",
  "chatterSpeakers", "ventureNews"]);
const SERVICE_STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });
const WORK_CLASS = "MAINTENANCE";

function upFreeCorps(db) {
  db.exec(`CREATE TABLE world_free_corps (
    corp_id              INTEGER PRIMARY KEY CHECK (corp_id > 0),
    archetype            TEXT    NOT NULL CHECK (archetype IN ('miner','hauler','ratter','explorer','industrialist',
                                                               'missioner','hunter','structure')),
    state                TEXT    NOT NULL CHECK (state IN ('FOUNDING','ACTIVE','STRUGGLING','MERGED','DISSOLVED',
                                                           'REFUSED')),
    open                 INTEGER NOT NULL CHECK (open IN (0, 1)),
    name                 TEXT    NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 50),
    ticker               TEXT    NOT NULL UNIQUE CHECK (length(ticker) BETWEEN 2 AND 5),
    sec_band             TEXT    NOT NULL CHECK (sec_band IN ('highsec','lowsec','nullsec')),
    home_system_id       INTEGER NOT NULL CHECK (home_system_id > 0),
    home_station_id      INTEGER NOT NULL CHECK (home_station_id > 0),
    home_station_corp_id INTEGER CHECK (home_station_corp_id IS NULL OR home_station_corp_id > 0),
    race_faction_id      INTEGER NOT NULL CHECK (race_faction_id > 0),
    members_target       INTEGER NOT NULL CHECK (members_target BETWEEN 1 AND 10),
    corporation_id       INTEGER UNIQUE CHECK (corporation_id IS NULL OR corporation_id > 0),
    isk                  INTEGER NOT NULL CHECK (isk >= 0),
    struggle_count       INTEGER NOT NULL DEFAULT 0 CHECK (struggle_count >= 0),
    seed                 INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
    name_attempt         INTEGER NOT NULL CHECK (name_attempt >= 0),
    venture_seq          INTEGER NOT NULL DEFAULT 0 CHECK (venture_seq >= 0),
    next_at              INTEGER NOT NULL CHECK (next_at >= 0),
    founded_at           INTEGER NOT NULL CHECK (founded_at >= 0),
    updated_at           INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at             INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason           TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 64),
    merged_into          INTEGER CHECK (merged_into IS NULL OR merged_into > 0),
    version              INTEGER NOT NULL CHECK (version >= 1),
    CHECK ((open = 1) = (state IN ('FOUNDING','ACTIVE','STRUGGLING'))),
    CHECK ((ended_at IS NULL) = (open = 1))
  ) STRICT;
  CREATE INDEX world_free_corps_due  ON world_free_corps (next_at, corp_id) WHERE open = 1;
  CREATE INDEX world_free_corps_home ON world_free_corps (home_system_id)   WHERE open = 1;`);
}

function upFreeCorpVentures(db) {
  db.exec(`CREATE TABLE world_free_corp_ventures (
    venture_id        TEXT    PRIMARY KEY CHECK (length(venture_id) BETWEEN 7 AND 40),
    corp_id           INTEGER NOT NULL CHECK (corp_id > 0),
    seq               INTEGER NOT NULL CHECK (seq >= 1),
    kind              TEXT    NOT NULL CHECK (kind IN ('MINE','HAUL','RAT','EXPLORE','BUILD','RUN',
                                                       'EXPLORE_WH','HUNT','ANCHOR')),
    state             TEXT    NOT NULL CHECK (state IN ('TRAVEL','WORKING','RETURNING','HELD','DONE','ABORTED','LOST')),
    open              INTEGER NOT NULL CHECK (open IN (0, 1)),
    home_system_id    INTEGER NOT NULL CHECK (home_system_id > 0),
    system_id         INTEGER NOT NULL CHECK (system_id > 0),
    target_system_id  INTEGER NOT NULL CHECK (target_system_id > 0),
    target_station_id INTEGER CHECK (target_station_id IS NULL OR target_station_id > 0),
    sec_band          TEXT    NOT NULL CHECK (sec_band IN ('highsec','lowsec','nullsec','wormhole')),
    jumps             INTEGER NOT NULL CHECK (jumps BETWEEN 0 AND 64),
    crew              INTEGER NOT NULL CHECK (crew BETWEEN 1 AND 10),
    crew_lost         INTEGER NOT NULL DEFAULT 0 CHECK (crew_lost >= 0),
    step              INTEGER NOT NULL CHECK (step >= 0),
    travel_steps      INTEGER NOT NULL CHECK (travel_steps >= 0),
    work_steps        INTEGER NOT NULL CHECK (work_steps >= 1),
    steps_total       INTEGER NOT NULL CHECK (steps_total = 2 * travel_steps + work_steps),
    holds             INTEGER NOT NULL DEFAULT 0 CHECK (holds >= 0),
    yield_isk         INTEGER NOT NULL CHECK (yield_isk >= 0),
    cost_isk          INTEGER NOT NULL CHECK (cost_isk >= 0),
    started_at        INTEGER NOT NULL CHECK (started_at >= 0),
    step_due_at       INTEGER NOT NULL CHECK (step_due_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at          INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason        TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 64),
    version           INTEGER NOT NULL CHECK (version >= 1),
    CHECK ((open = 1) = (state IN ('TRAVEL','WORKING','RETURNING','HELD'))),
    CHECK ((ended_at IS NULL) = (open = 1)),
    CHECK (crew_lost <= crew),
    CHECK (step <= steps_total),
    UNIQUE (corp_id, seq)
  ) STRICT;
  CREATE UNIQUE INDEX world_free_corp_ventures_open   ON world_free_corp_ventures (corp_id)  WHERE open = 1;
  CREATE INDEX        world_free_corp_ventures_system ON world_free_corp_ventures (system_id) WHERE open = 1;
  CREATE INDEX        world_free_corp_ventures_ended  ON world_free_corp_ventures (ended_at)  WHERE open = 0;
  ALTER TABLE world_free_corps ADD COLUMN recover_until INTEGER NOT NULL DEFAULT 0 CHECK (recover_until >= 0);
  ALTER TABLE world_free_corps ADD COLUMN recover_crew  INTEGER NOT NULL DEFAULT 0 CHECK (recover_crew BETWEEN 0 AND 10);
  ALTER TABLE world_free_corps ADD COLUMN ventures_done INTEGER NOT NULL DEFAULT 0 CHECK (ventures_done >= 0);
  ALTER TABLE world_free_corps ADD COLUMN ventures_lost INTEGER NOT NULL DEFAULT 0 CHECK (ventures_lost >= 0);
  ALTER TABLE world_free_corps ADD COLUMN isk_earned    INTEGER NOT NULL DEFAULT 0 CHECK (isk_earned >= 0);
  ALTER TABLE world_free_corps ADD COLUMN isk_lost      INTEGER NOT NULL DEFAULT 0 CHECK (isk_lost >= 0);
  ALTER TABLE world_free_corps ADD COLUMN last_review_at INTEGER NOT NULL DEFAULT 0 CHECK (last_review_at >= 0);`);
}

function upFreeCorpVenturesWh(db) {
  const cols = "venture_id, corp_id, seq, kind, state, open, home_system_id, system_id, target_system_id, "
    + "target_station_id, sec_band, jumps, crew, crew_lost, step, travel_steps, work_steps, steps_total, holds, "
    + "yield_isk, cost_isk, started_at, step_due_at, updated_at, ended_at, end_reason, version";
  const wh = db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_ventures WHERE kind = 'EXPLORE_WH'").get();
  if (Number(wh.n) !== 0) throw new Error(`migration 75: ${Number(wh.n)} EXPLORE_WH rows before the rebuild`);
  db.exec(`CREATE TABLE world_free_corp_ventures_v75 (
    venture_id         TEXT    PRIMARY KEY CHECK (length(venture_id) BETWEEN 7 AND 40),
    corp_id            INTEGER NOT NULL CHECK (corp_id > 0),
    seq                INTEGER NOT NULL CHECK (seq >= 1),
    kind               TEXT    NOT NULL CHECK (kind IN ('MINE','HAUL','RAT','EXPLORE','BUILD','RUN',
                                                        'EXPLORE_WH','HUNT','ANCHOR')),
    state              TEXT    NOT NULL CHECK (state IN ('TRAVEL','WORKING','RETURNING','HELD','STRANDED','DONE',
                                                         'ABORTED','LOST')),
    open               INTEGER NOT NULL CHECK (open IN (0, 1)),
    home_system_id     INTEGER NOT NULL CHECK (home_system_id > 0),
    system_id          INTEGER NOT NULL CHECK (system_id > 0),
    target_system_id   INTEGER NOT NULL CHECK (target_system_id > 0),
    target_station_id  INTEGER CHECK (target_station_id IS NULL OR target_station_id > 0),
    sec_band           TEXT    NOT NULL CHECK (sec_band IN ('highsec','lowsec','nullsec','wormhole')),
    jumps              INTEGER NOT NULL CHECK (jumps BETWEEN 0 AND 64),
    crew               INTEGER NOT NULL CHECK (crew BETWEEN 1 AND 10),
    crew_lost          INTEGER NOT NULL DEFAULT 0 CHECK (crew_lost >= 0),
    step               INTEGER NOT NULL CHECK (step >= 0),
    travel_steps       INTEGER NOT NULL CHECK (travel_steps >= 0),
    work_steps         INTEGER NOT NULL CHECK (work_steps >= 1),
    steps_total        INTEGER NOT NULL CHECK (steps_total >= 1),
    holds              INTEGER NOT NULL DEFAULT 0 CHECK (holds >= 0),
    yield_isk          INTEGER NOT NULL CHECK (yield_isk >= 0),
    cost_isk           INTEGER NOT NULL CHECK (cost_isk >= 0),
    started_at         INTEGER NOT NULL CHECK (started_at >= 0),
    step_due_at        INTEGER NOT NULL CHECK (step_due_at >= 0),
    updated_at         INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at           INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason         TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 64),
    version            INTEGER NOT NULL CHECK (version >= 1),
    wh_route           TEXT    CHECK (wh_route IS NULL OR (length(wh_route) BETWEEN 5 AND 200 AND json_valid(wh_route))),
    wh_entry_system_id INTEGER CHECK (wh_entry_system_id IS NULL OR wh_entry_system_id > 0),
    stranded_steps     INTEGER NOT NULL DEFAULT 0 CHECK (stranded_steps >= 0),
    CHECK ((open = 1) = (state IN ('TRAVEL','WORKING','RETURNING','HELD','STRANDED'))),
    CHECK ((ended_at IS NULL) = (open = 1)),
    CHECK (crew_lost <= crew),
    CHECK (step <= steps_total),
    CHECK (kind = 'EXPLORE_WH' OR steps_total = 2 * travel_steps + work_steps),
    CHECK ((kind = 'EXPLORE_WH') = (wh_route IS NOT NULL)),
    CHECK (state <> 'STRANDED' OR kind = 'EXPLORE_WH'),
    UNIQUE (corp_id, seq)
  ) STRICT;
  INSERT INTO world_free_corp_ventures_v75 (${cols}) SELECT ${cols} FROM world_free_corp_ventures;
  DROP TABLE world_free_corp_ventures;
  ALTER TABLE world_free_corp_ventures_v75 RENAME TO world_free_corp_ventures;
  CREATE UNIQUE INDEX world_free_corp_ventures_open   ON world_free_corp_ventures (corp_id)   WHERE open = 1;
  CREATE INDEX        world_free_corp_ventures_system ON world_free_corp_ventures (system_id) WHERE open = 1;
  CREATE INDEX        world_free_corp_ventures_ended  ON world_free_corp_ventures (ended_at)  WHERE open = 0;`);
}

function upFreeCorpWars(db) {
  db.exec(`CREATE TABLE world_free_corp_wars (
    war_id           TEXT    PRIMARY KEY CHECK (length(war_id) BETWEEN 9 AND 64),
    corp_a           INTEGER NOT NULL CHECK (corp_a > 0),
    corp_b           INTEGER NOT NULL CHECK (corp_b > corp_a),
    n                INTEGER NOT NULL CHECK (n >= 1),
    declarer_corp_id INTEGER NOT NULL CHECK (declarer_corp_id IN (corp_a, corp_b)),
    ally_corp_id     INTEGER CHECK (ally_corp_id IS NULL OR (ally_corp_id > 0 AND ally_corp_id NOT IN (corp_a, corp_b))),
    ally_side        TEXT    CHECK (ally_side IS NULL OR ally_side IN ('A','B')),
    ally_fee_isk     INTEGER NOT NULL DEFAULT 0 CHECK (ally_fee_isk >= 0),
    declare_cost_isk INTEGER NOT NULL DEFAULT 0 CHECK (declare_cost_isk >= 0),
    state            TEXT    NOT NULL CHECK (state IN ('DECLARED','ACTIVE','ENDED')),
    open             INTEGER NOT NULL CHECK (open IN (0, 1)),
    declared_at      INTEGER NOT NULL CHECK (declared_at >= 0),
    active_at        INTEGER NOT NULL CHECK (active_at >= declared_at),
    ends_at          INTEGER NOT NULL CHECK (ends_at > active_at),
    next_at          INTEGER NOT NULL CHECK (next_at >= 0),
    ended_at         INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    kills_a          INTEGER NOT NULL DEFAULT 0 CHECK (kills_a >= 0),
    kills_b          INTEGER NOT NULL DEFAULT 0 CHECK (kills_b >= 0),
    isk_lost_a       INTEGER NOT NULL DEFAULT 0 CHECK (isk_lost_a >= 0),
    isk_lost_b       INTEGER NOT NULL DEFAULT 0 CHECK (isk_lost_b >= 0),
    skirmishes       INTEGER NOT NULL DEFAULT 0 CHECK (skirmishes >= 0),
    surrender_isk    INTEGER NOT NULL DEFAULT 0 CHECK (surrender_isk >= 0),
    winner           INTEGER CHECK (winner IS NULL OR winner IN (corp_a, corp_b)),
    end_reason       TEXT    CHECK (end_reason IS NULL OR end_reason IN ('TIMEOUT','SURRENDER','SIDE_CLOSED')),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    version          INTEGER NOT NULL CHECK (version >= 1),
    CHECK ((ally_corp_id IS NULL) = (ally_side IS NULL)),
    CHECK ((open = 1) = (state IN ('DECLARED','ACTIVE'))),
    CHECK ((ended_at IS NULL) = (open = 1)),
    CHECK ((end_reason IS NULL) = (open = 1)),
    CHECK (winner IS NULL OR open = 0),
    UNIQUE (corp_a, corp_b, n)
  ) STRICT;
  CREATE UNIQUE INDEX world_free_corp_wars_pair  ON world_free_corp_wars (corp_a, corp_b) WHERE open = 1;
  CREATE INDEX        world_free_corp_wars_due   ON world_free_corp_wars (next_at, war_id) WHERE open = 1;
  CREATE INDEX        world_free_corp_wars_ended ON world_free_corp_wars (ended_at)        WHERE open = 0;
  CREATE TABLE world_free_corp_skirmishes (
    skirmish_id         TEXT    PRIMARY KEY CHECK (length(skirmish_id) BETWEEN 9 AND 64),
    at                  INTEGER NOT NULL CHECK (at >= 0),
    system_id           INTEGER NOT NULL CHECK (system_id > 0),
    sec_band            TEXT    NOT NULL CHECK (sec_band IN ('highsec','lowsec','nullsec','wormhole')),
    war_id              TEXT    CHECK (war_id IS NULL OR length(war_id) BETWEEN 9 AND 64),
    attacker_corp_id    INTEGER NOT NULL CHECK (attacker_corp_id > 0),
    attacker_venture_id TEXT    NOT NULL CHECK (length(attacker_venture_id) BETWEEN 7 AND 40),
    attacker_kind       TEXT    NOT NULL CHECK (attacker_kind = 'HUNT'),
    attacker_crew       INTEGER NOT NULL CHECK (attacker_crew BETWEEN 1 AND 10),
    defender_corp_id    INTEGER NOT NULL CHECK (defender_corp_id > 0 AND defender_corp_id <> attacker_corp_id),
    defender_venture_id TEXT    NOT NULL CHECK (length(defender_venture_id) BETWEEN 7 AND 40),
    defender_kind       TEXT    NOT NULL CHECK (defender_kind IN ('MINE','HAUL','RAT','EXPLORE','RUN','HUNT')),
    defender_crew       INTEGER NOT NULL CHECK (defender_crew BETWEEN 1 AND 10),
    crew_lost_a         INTEGER NOT NULL CHECK (crew_lost_a BETWEEN 0 AND attacker_crew),
    crew_lost_d         INTEGER NOT NULL CHECK (crew_lost_d BETWEEN 0 AND defender_crew),
    isk_lost_a          INTEGER NOT NULL CHECK (isk_lost_a >= 0),
    isk_lost_d          INTEGER NOT NULL CHECK (isk_lost_d >= 0),
    loot_isk            INTEGER NOT NULL CHECK (loot_isk >= 0),
    outcome             TEXT    NOT NULL CHECK (outcome IN ('ATTACKER_WIN','DEFENDER_WIN')),
    seed                INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
    CHECK (outcome = 'ATTACKER_WIN' OR loot_isk = 0)
  ) STRICT;
  CREATE INDEX world_free_corp_skirmishes_at ON world_free_corp_skirmishes (at);`);
}

function upFreeCorpOutbox(db) {
  db.exec(`CREATE TABLE world_free_corp_outbox (
    key           TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 12 AND 96),
    kind          TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 24),
    payload       TEXT    NOT NULL CHECK (json_valid(payload) AND length(payload) <= 4096),
    state         TEXT    NOT NULL CHECK (state IN ('PENDING','DONE','FAILED')),
    attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_at       INTEGER NOT NULL CHECK (next_at >= 0),
    created_at    INTEGER NOT NULL CHECK (created_at >= 0),
    attempted_at  INTEGER CHECK (attempted_at IS NULL OR attempted_at >= 0),
    ended_at      INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    result_id     INTEGER CHECK (result_id IS NULL OR result_id > 0),
    last_error    TEXT    CHECK (last_error IS NULL OR length(last_error) <= 200),
    version       INTEGER NOT NULL CHECK (version >= 1),
    CHECK ((ended_at IS NULL) = (state = 'PENDING')),
    CHECK (state <> 'DONE' OR result_id IS NOT NULL),
    CHECK (attempts > 0 OR attempted_at IS NULL)
  ) STRICT;
  CREATE INDEX world_free_corp_outbox_kind_due       ON world_free_corp_outbox (kind, next_at, key) WHERE state = 'PENDING';
  CREATE INDEX world_free_corp_outbox_kind_attempted ON world_free_corp_outbox (kind, attempted_at)
                                                     WHERE attempted_at IS NOT NULL;
  CREATE INDEX world_free_corp_outbox_ended          ON world_free_corp_outbox (ended_at) WHERE state <> 'PENDING';`);
}

function upFreeCorpContracts(db) {
  db.exec(`CREATE TABLE world_free_corp_contracts (
    contract_key          TEXT    PRIMARY KEY CHECK (length(contract_key) BETWEEN 7 AND 48),
    outbox_key            TEXT    NOT NULL UNIQUE CHECK (length(outbox_key) BETWEEN 12 AND 96),
    venture_id            TEXT    NOT NULL CHECK (length(venture_id) BETWEEN 7 AND 40),
    corp_id               INTEGER NOT NULL CHECK (corp_id > 0),
    kind                  TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
    goods                 TEXT    NOT NULL CHECK (length(goods) BETWEEN 1 AND 16),
    state                 TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    open                  INTEGER NOT NULL CHECK (open IN (0, 1)),
    type_id               INTEGER NOT NULL CHECK (type_id > 0),
    station_id            INTEGER NOT NULL CHECK (station_id > 0),
    system_id             INTEGER NOT NULL CHECK (system_id > 0),
    issuer_character_id   INTEGER NOT NULL CHECK (issuer_character_id > 0),
    issuer_corporation_id INTEGER NOT NULL CHECK (issuer_corporation_id > 0),
    lot_isk               INTEGER NOT NULL CHECK (lot_isk > 0),
    quantity              INTEGER CHECK (quantity IS NULL OR quantity > 0),
    price_isk             INTEGER CHECK (price_isk IS NULL OR price_isk > 0),
    vendor_contract_id    INTEGER UNIQUE CHECK (vendor_contract_id IS NULL OR vendor_contract_id > 0),
    return_plan           TEXT    CHECK (return_plan IS NULL OR (json_valid(return_plan) AND length(return_plan) <= 2048)),
    revenue_isk           INTEGER NOT NULL DEFAULT 0 CHECK (revenue_isk >= 0),
    close_attempts        INTEGER NOT NULL DEFAULT 0 CHECK (close_attempts >= 0),
    created_at            INTEGER NOT NULL CHECK (created_at >= 0),
    opened_at             INTEGER CHECK (opened_at IS NULL OR opened_at >= 0),
    expires_at            INTEGER CHECK (expires_at IS NULL OR expires_at >= 0),
    next_check_at         INTEGER CHECK (next_check_at IS NULL OR next_check_at >= 0),
    updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at              INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason            TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 40),
    version               INTEGER NOT NULL CHECK (version >= 1),
    CHECK ((ended_at IS NULL) = (open = 1)),
    CHECK ((quantity IS NULL) = (price_isk IS NULL)),
    CHECK (vendor_contract_id IS NOT NULL OR opened_at IS NULL)
  ) STRICT;
  CREATE INDEX        world_free_corp_contracts_corp  ON world_free_corp_contracts (corp_id) WHERE open = 1;
  CREATE UNIQUE INDEX world_free_corp_contracts_lot   ON world_free_corp_contracts (corp_id, station_id, type_id)
                                                      WHERE open = 1;
  CREATE INDEX        world_free_corp_contracts_check ON world_free_corp_contracts (next_check_at, contract_key)
                                                      WHERE next_check_at IS NOT NULL;
  CREATE INDEX        world_free_corp_contracts_ended ON world_free_corp_contracts (ended_at) WHERE open = 0;
  CREATE INDEX        world_free_corp_outbox_kind_created ON world_free_corp_outbox (kind, created_at, key);`);
}

function upFreeCorpMembers(db) {
  db.exec(`CREATE TABLE world_free_corp_members (
    character_id          INTEGER PRIMARY KEY CHECK (character_id > 0),
    origin_corp_id        INTEGER NOT NULL CHECK (origin_corp_id > 0),
    corp_id               INTEGER CHECK (corp_id IS NULL OR corp_id > 0),
    state                 TEXT    NOT NULL CHECK (state IN ('FREE','JOINING','MEMBER','LOST')),
    vendor_corporation_id INTEGER NOT NULL CHECK (vendor_corporation_id > 0),
    moves                 INTEGER NOT NULL CHECK (moves >= 1),
    joined_at             INTEGER CHECK (joined_at IS NULL OR joined_at >= 0),
    left_at               INTEGER NOT NULL CHECK (left_at >= 0),
    updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
    version               INTEGER NOT NULL CHECK (version >= 1),
    CHECK ((corp_id IS NULL) = (state IN ('FREE','LOST'))),
    CHECK (state <> 'MEMBER' OR joined_at IS NOT NULL)
  ) STRICT;
  CREATE INDEX world_free_corp_members_corp ON world_free_corp_members (corp_id, state);
  CREATE INDEX world_free_corp_members_pool ON world_free_corp_members (left_at, character_id) WHERE state = 'FREE';
  ALTER TABLE world_free_corps ADD COLUMN recruited INTEGER NOT NULL DEFAULT 0 CHECK (recruited BETWEEN 0 AND 9);`);
}

function upFreeCorpStructures(db) {
  db.exec(`CREATE TABLE world_free_corp_structures (
    structure_key  TEXT    PRIMARY KEY CHECK (length(structure_key) BETWEEN 13 AND 40),
    corp_id        INTEGER NOT NULL CHECK (corp_id > 0),
    n              INTEGER NOT NULL CHECK (n >= 1),
    system_id      INTEGER NOT NULL CHECK (system_id > 0),
    type_id        INTEGER NOT NULL CHECK (type_id > 0),
    state          TEXT    NOT NULL CHECK (state IN ('PLANNED','ANCHORING','ONLINE','LOST','REMOVED','FAILED')),
    open           INTEGER NOT NULL CHECK (open IN (0, 1)),
    evejs_item_id  INTEGER UNIQUE CHECK (evejs_item_id IS NULL OR evejs_item_id > 0),
    cost_isk       INTEGER NOT NULL CHECK (cost_isk >= 0),
    penalty_isk    INTEGER NOT NULL DEFAULT 0 CHECK (penalty_isk >= 0),
    planned_at     INTEGER NOT NULL CHECK (planned_at >= 0),
    anchored_at    INTEGER CHECK (anchored_at IS NULL OR anchored_at >= 0),
    online_at      INTEGER CHECK (online_at IS NULL OR online_at >= 0),
    ended_at       INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason     TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    updated_at     INTEGER NOT NULL CHECK (updated_at >= 0),
    version        INTEGER NOT NULL CHECK (version >= 1),
    CHECK ((open = 1) = (state IN ('PLANNED','ANCHORING','ONLINE'))),
    CHECK ((ended_at IS NULL) = (open = 1)),
    CHECK (state <> 'PLANNED' OR evejs_item_id IS NULL),
    CHECK (state NOT IN ('ANCHORING','ONLINE') OR evejs_item_id IS NOT NULL),
    UNIQUE (corp_id, n)
  ) STRICT;
  CREATE INDEX world_free_corp_structures_open_corp   ON world_free_corp_structures (corp_id)   WHERE open = 1;
  CREATE INDEX world_free_corp_structures_open_system ON world_free_corp_structures (system_id) WHERE open = 1;
  CREATE INDEX world_free_corp_structures_lost        ON world_free_corp_structures (corp_id, ended_at)
                                                      WHERE state = 'LOST';
  CREATE INDEX world_free_corp_structures_ended       ON world_free_corp_structures (ended_at) WHERE open = 0;
  ALTER TABLE world_free_corps ADD COLUMN structure_seq INTEGER NOT NULL DEFAULT 0 CHECK (structure_seq >= 0);`);
}

function upFreeCorpCeoReuse(db) {
  db.exec(`ALTER TABLE world_free_corps ADD COLUMN ceo_character_id INTEGER
    CHECK (ceo_character_id IS NULL OR ceo_character_id > 0);
  ALTER TABLE world_free_corps ADD COLUMN ceo_source_corporation_id INTEGER
    CHECK (ceo_source_corporation_id IS NULL OR ceo_source_corporation_id > 0);
  ALTER TABLE world_free_corps ADD COLUMN ceo_released INTEGER NOT NULL DEFAULT 0
    CHECK (ceo_released IN (0, 1, 2));
  CREATE INDEX world_free_corps_ceo_release ON world_free_corps (ended_at, corp_id)
    WHERE open = 0 AND ceo_released = 0 AND state IN ('DISSOLVED','MERGED');`);
}

function upFreeCorpCouriers(db) {
  db.exec(`ALTER TABLE world_free_corp_contracts ADD COLUMN dest_station_id INTEGER
    CHECK (dest_station_id IS NULL OR dest_station_id > 0);
  ALTER TABLE world_free_corp_contracts ADD COLUMN dest_system_id INTEGER
    CHECK (dest_system_id IS NULL OR dest_system_id > 0);
  ALTER TABLE world_free_corp_contracts ADD COLUMN reward_isk INTEGER
    CHECK (reward_isk IS NULL OR reward_isk > 0);
  ALTER TABLE world_free_corp_contracts ADD COLUMN collateral_isk INTEGER
    CHECK (collateral_isk IS NULL OR collateral_isk > 0);
  ALTER TABLE world_free_corp_contracts ADD COLUMN deadline_at INTEGER
    CHECK (deadline_at IS NULL OR deadline_at >= 0);
  ALTER TABLE world_free_corp_contracts ADD COLUMN refund_isk INTEGER
    CHECK (refund_isk IS NULL OR refund_isk >= 0);`);
}

function upFreeCorpWhCorps(db) {
  db.exec(`CREATE TABLE world_free_corp_wh_homes (
    corp_id           INTEGER PRIMARY KEY CHECK (corp_id > 0),
    j_system_id       INTEGER NOT NULL CHECK (j_system_id BETWEEN 31000000 AND 31999999),
    staging_system_id INTEGER NOT NULL CHECK (staging_system_id > 0),
    open              INTEGER NOT NULL CHECK (open IN (0, 1)),
    loot_isk          INTEGER NOT NULL DEFAULT 0 CHECK (loot_isk >= 0),
    gas_isk           INTEGER NOT NULL DEFAULT 0 CHECK (gas_isk >= 0),
    cargo_loot_isk    INTEGER NOT NULL DEFAULT 0 CHECK (cargo_loot_isk >= 0),
    cargo_gas_isk     INTEGER NOT NULL DEFAULT 0 CHECK (cargo_gas_isk >= 0),
    cargo_venture_seq INTEGER CHECK (cargo_venture_seq IS NULL OR cargo_venture_seq >= 1),
    pi_isk_total      INTEGER NOT NULL DEFAULT 0 CHECK (pi_isk_total >= 0),
    sold_isk_total    INTEGER NOT NULL DEFAULT 0 CHECK (sold_isk_total >= 0),
    home_done         INTEGER NOT NULL DEFAULT 0 CHECK (home_done >= 0),
    haul_done         INTEGER NOT NULL DEFAULT 0 CHECK (haul_done >= 0),
    raid_done         INTEGER NOT NULL DEFAULT 0 CHECK (raid_done >= 0),
    founded_at        INTEGER NOT NULL CHECK (founded_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at          INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason        TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 64),
    version           INTEGER NOT NULL CHECK (version >= 1),
    CHECK ((ended_at IS NULL) = (open = 1)),
    CHECK ((cargo_venture_seq IS NULL) = (cargo_loot_isk = 0 AND cargo_gas_isk = 0)),
    CHECK (open = 1 OR cargo_venture_seq IS NULL)
  ) STRICT;
  CREATE UNIQUE INDEX world_free_corp_wh_homes_j    ON world_free_corp_wh_homes (j_system_id) WHERE open = 1;
  CREATE INDEX        world_free_corp_wh_homes_open ON world_free_corp_wh_homes (corp_id)     WHERE open = 1;`);
  const cols = "venture_id, corp_id, seq, kind, state, open, home_system_id, system_id, target_system_id, "
    + "target_station_id, sec_band, jumps, crew, crew_lost, step, travel_steps, work_steps, steps_total, holds, "
    + "yield_isk, cost_isk, started_at, step_due_at, updated_at, ended_at, end_reason, version, wh_route, "
    + "wh_entry_system_id, stranded_steps";
  const wh = db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_ventures WHERE kind IN ('WH_HOME','WH_RAID',"
    + "'WH_HAUL')").get();
  if (Number(wh.n) !== 0) throw new Error(`migration 127: ${Number(wh.n)} WH_* rows before the rebuild`);
  db.exec(`CREATE TABLE world_free_corp_ventures_v127 (
    venture_id         TEXT    PRIMARY KEY CHECK (length(venture_id) BETWEEN 7 AND 40),
    corp_id            INTEGER NOT NULL CHECK (corp_id > 0),
    seq                INTEGER NOT NULL CHECK (seq >= 1),
    kind               TEXT    NOT NULL CHECK (kind IN ('MINE','HAUL','RAT','EXPLORE','BUILD','RUN',
                                                        'EXPLORE_WH','HUNT','ANCHOR','WH_HOME','WH_RAID','WH_HAUL')),
    state              TEXT    NOT NULL CHECK (state IN ('TRAVEL','WORKING','RETURNING','HELD','STRANDED','DONE',
                                                         'ABORTED','LOST')),
    open               INTEGER NOT NULL CHECK (open IN (0, 1)),
    home_system_id     INTEGER NOT NULL CHECK (home_system_id > 0),
    system_id          INTEGER NOT NULL CHECK (system_id > 0),
    target_system_id   INTEGER NOT NULL CHECK (target_system_id > 0),
    target_station_id  INTEGER CHECK (target_station_id IS NULL OR target_station_id > 0),
    sec_band           TEXT    NOT NULL CHECK (sec_band IN ('highsec','lowsec','nullsec','wormhole')),
    jumps              INTEGER NOT NULL CHECK (jumps BETWEEN 0 AND 64),
    crew               INTEGER NOT NULL CHECK (crew BETWEEN 1 AND 10),
    crew_lost          INTEGER NOT NULL DEFAULT 0 CHECK (crew_lost >= 0),
    step               INTEGER NOT NULL CHECK (step >= 0),
    travel_steps       INTEGER NOT NULL CHECK (travel_steps >= 0),
    work_steps         INTEGER NOT NULL CHECK (work_steps >= 1),
    steps_total        INTEGER NOT NULL CHECK (steps_total >= 1),
    holds              INTEGER NOT NULL DEFAULT 0 CHECK (holds >= 0),
    yield_isk          INTEGER NOT NULL CHECK (yield_isk >= 0),
    cost_isk           INTEGER NOT NULL CHECK (cost_isk >= 0),
    started_at         INTEGER NOT NULL CHECK (started_at >= 0),
    step_due_at        INTEGER NOT NULL CHECK (step_due_at >= 0),
    updated_at         INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at           INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason         TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 64),
    version            INTEGER NOT NULL CHECK (version >= 1),
    wh_route           TEXT    CHECK (wh_route IS NULL OR (length(wh_route) BETWEEN 5 AND 200 AND json_valid(wh_route))),
    wh_entry_system_id INTEGER CHECK (wh_entry_system_id IS NULL OR wh_entry_system_id > 0),
    stranded_steps     INTEGER NOT NULL DEFAULT 0 CHECK (stranded_steps >= 0),
    CHECK ((open = 1) = (state IN ('TRAVEL','WORKING','RETURNING','HELD','STRANDED'))),
    CHECK ((ended_at IS NULL) = (open = 1)),
    CHECK (crew_lost <= crew),
    CHECK (step <= steps_total),
    CHECK (kind IN ('EXPLORE_WH','WH_HOME','WH_RAID','WH_HAUL') OR steps_total = 2 * travel_steps + work_steps),
    CHECK ((kind IN ('EXPLORE_WH','WH_RAID','WH_HAUL')) = (wh_route IS NOT NULL)),
    CHECK (state <> 'STRANDED' OR kind IN ('EXPLORE_WH','WH_RAID','WH_HAUL')),
    UNIQUE (corp_id, seq)
  ) STRICT;
  INSERT INTO world_free_corp_ventures_v127 (${cols}) SELECT ${cols} FROM world_free_corp_ventures;
  DROP TABLE world_free_corp_ventures;
  ALTER TABLE world_free_corp_ventures_v127 RENAME TO world_free_corp_ventures;
  CREATE UNIQUE INDEX world_free_corp_ventures_open   ON world_free_corp_ventures (corp_id)   WHERE open = 1;
  CREATE INDEX        world_free_corp_ventures_system ON world_free_corp_ventures (system_id) WHERE open = 1;
  CREATE INDEX        world_free_corp_ventures_ended  ON world_free_corp_ventures (ended_at)  WHERE open = 0;`);
}

function parseWeights(text, allowedKeys) {
  if (typeof text !== "string" || !Array.isArray(allowedKeys)) return null;
  const out = new Map();
  let sum = 0;
  for (const part of text.split(",")) {
    const item = part.trim();
    const at = item.indexOf(":");
    if (item === "" || at <= 0) return null;
    const key = item.slice(0, at).trim();
    const raw = item.slice(at + 1).trim();
    if (!allowedKeys.includes(key) || out.has(key) || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return null;
    out.set(key, value);
    sum += value;
  }
  return sum > 0 ? out : null;
}

const parseBandWeights = (text) => parseWeights(text, BANDS);
const parseArchetypeWeights = (text) => parseWeights(text, ARCHETYPES);

module.exports = {
  TABLE,
  CORP_STATES,
  OPEN_STATES,
  ARCHETYPES,
  BANDS,
  OWNER_KIND,
  AGGREGATE,
  EVENT_FOUNDED,
  EVENT_ACTIVATED,
  EVENT_REFUSED,
  KEY_PREFIX,
  keyFound,
  keyActivate,
  keyRefuse,
  VENTURES_TABLE,
  VENTURE_STATES,
  VENTURE_OPEN_STATES,
  VENTURE_KINDS_ALL,
  VENTURE_ENGINE_KINDS,
  VENTURE_KIND_EVENTS,
  VENTURE_KIND_COUNTER_NAMES,
  WH_END_REASONS,
  WH_CORP_KINDS,
  WH_HOMES_TABLE,
  WH_CORP_END_REASONS,
  EVENT_WH_SOLD,
  keyWhSale,
  WH_HAUL_END_REASONS,
  parseWhHubSystemIds,
  WH_RAID_END_REASONS,
  parseRaidBands,
  upFreeCorpWhCorps,
  EVENT_GREW,
  EVENT_DISSOLVED,
  keyGrow,
  keyDissolve,
  WARS_TABLE,
  SKIRMISHES_TABLE,
  WAR_STATES,
  WAR_END_REASONS,
  SKIRMISH_OUTCOMES,
  warIdOf,
  skirmishIdOf,
  OUTBOX_TABLE,
  OUTBOX_KINDS,
  OUTBOX_KIND_KILLMAIL,
  OUTBOX_KIND_CONTRACT_WTS,
  OUTBOX_KIND_CONTRACT_COURIER,
  upFreeCorpCouriers,
  OUTBOX_KIND_JOIN,
  OUTBOX_KIND_CORP_CLOSE,
  OUTBOX_KIND_ANCHOR,
  OUTBOX_KIND_CEO_CLEAN,
  CEO_RELEASED,
  keyCeoClean,
  upFreeCorpCeoReuse,
  STRUCTURES_TABLE,
  STRUCTURE_STATES,
  STRUCTURE_OPEN_STATES,
  STRUCTURE_END_REASONS,
  MAX_STRUCTURE_END_REASON,
  STRUCTURES_MAX_TOTAL,
  STRUCTURE_NAME_MAX,
  keyStructure,
  GAUGE_STRUCTURES_OPEN,
  HISTOGRAM_STRUCTURE_CALL_MS,
  upFreeCorpStructures,
  MEMBERS_TABLE,
  MEMBER_STATES,
  EVENT_MERGED,
  keyMerge,
  keyJoin,
  keyClose,
  MAX_DESCRIPTION_LENGTH,
  GAUGE_MEMBERS_FREE,
  GAUGE_JOINS_PENDING,
  HISTOGRAM_JOIN_CALL_MS,
  upFreeCorpMembers,
  OUTBOX_STATES,
  MAX_OUTBOX_PAYLOAD,
  MAX_OUTBOX_ERROR,
  killmailKeyOf,
  CONTRACTS_TABLE,
  CONTRACT_KINDS,
  CONTRACT_STATES,
  CONTRACT_OPEN_STATES,
  CONTRACT_GOODS,
  MAX_RETURN_PLAN,
  MAX_CONTRACT_END_REASON,
  contractKeyOf,
  contractOutboxKeyOf,
  CONTRACT_TAG_PREFIX,
  GAUGE_CONTRACTS_OPEN,
  HISTOGRAM_CONTRACT_ISSUE_MS,
  MAX_NAME_LENGTH,
  MAX_END_REASON_LENGTH,
  MAX_MEMBERS,
  COUNTER_NAMES,
  GAUGE_OPEN,
  GAUGE_FOUNDING,
  GAUGE_OPEN_VENTURES,
  GAUGE_OPEN_WARS,
  GAUGE_KILLMAILS_PENDING,
  GAUGE_NAMES,
  HISTOGRAM_PASS_MS,
  HISTOGRAM_CHATTER_READ_MS,
  HISTOGRAM_WH_INDEX_MS,
  HISTOGRAM_KILLMAIL_CALL_MS,
  HISTOGRAM_NAMES,
  FACADE_METHODS,
  SERVICE_STATE,
  WORK_CLASS,
  upFreeCorps,
  upFreeCorpVentures,
  upFreeCorpVenturesWh,
  upFreeCorpWars,
  upFreeCorpOutbox,
  upFreeCorpContracts,
  parseWeights,
  parseBandWeights,
  parseArchetypeWeights,
};
