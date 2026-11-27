"use strict";

const { upWorldState } = require("../world/schema");
const { upScheduledEvents, upScheduledEventsLiveIndex } = require("../scheduler/schema");
const { upFleets } = require("../fleets/schema");
const { upBattles, upLiveMembers, upBattleGrid, upBattleRecordsSettled } = require("../battle/schema");
const { upWreckFields } = require("../world/wreckSchema");
const { upBattleCooldowns } = require("../battle/cooldownSchema");
const { upWorldFactions, upFactionIntel, upFactionUpkeep, upReconLosses,
  upPlayerActivity, upFortressHaltMemory, upAttackLosses } = require("../strategy/schema");
const { upStations } = require("../stations/schema");
const { upFleetsRefitPending, upWormholeTransits, upFleetsFactionLive } = require("../fleets/schema");
const { upOccupation, upHomeFaction } = require("../world/occupation/schema");
const { upMiningTrips, upProductionJobs, upConvoys } = require("../economy/schema");
const { upSalvageJobs } = require("../world/salvageSchema");
const { upStationBuilds } = require("../stations/construction/schema");
const { upTrade } = require("../economy/trade/schema");
const { upTradePrivate, upTradeIssuer, upTradeMarket, upTradeSell } = require("../economy/trade/schema");
const { upSieges } = require("../stations/siege/schema");
const { upInvasions } = require("../world/invasions/schema");
const { upVirtualIdentities } = require("../virtualCorps/schema");
const { upSovProjectionLog } = require("../world/sovProjection/schema");
const { upEventSites, upEventSitesKind } = require("../events/sites/schema");
const { upWorldEvents } = require("../events/schema");
const { upSovReconcile } = require("../world/sovReconcile/schema");
const { upHuntPins } = require("../strategy/hunt/schema");
const { upSalvageAnomalies } = require("../events/salvage/schema");
const { upTreasury, upTreasuryMerc, upTreasuryPressure } = require("../economy/treasury/schema");
const { upLowsecCamps } = require("../strategy/lowsec/schema");
const { upCapsuleerCorps, upCapsuleerTrips, upCapsuleerTripWait, upCapsuleerContracts, upCapsuleerTripSalvage,
  upCapsuleerClaims } = require("../strategy/capsuleers/schema");
const { upWhExpeditions } = require("../strategy/expeditions/schema");
const { upPlayerHunts } = require("../playerHunt/schema");
const { upNotices } = require("../notices/schema");
const { upLiberationRewards } = require("../world/liberation/rewardSchema");
const { upFleetExposures } = require("../fleetExposure/schema");
const { upCrews } = require("../crews/migration");
const { upPlayerSieges } = require("../stations/playerSiege/schema");
const { upSentries, upSentriesSpaceAnchor } = require("../sentries/schema");
const { upSovStructures } = require("../world/sovStructures/schema");
const { upLocalContacts } = require("../localPilots/contacts/schema");
const { upFrontJobs } = require("../frontJobs/schema");
const { upPlayerSov } = require("../world/playerSov/schema");
const { upPlayerSovClock } = require("../world/playerSov/clock");
const { upHeavyEvents, upHeavyEventsPower } = require("../heavyEvents/schema");
const { upHeavyEventPayouts } = require("../heavyEvents/payoutSchema");
const { upSupplierStanding } = require("../economy/trade/supplierLedger");
const { upFleetGridVisits } = require("../fleets/grid/schema");
const { upFreeCorps, upFreeCorpVentures, upFreeCorpVenturesWh, upFreeCorpWars,
  upFreeCorpOutbox, upFreeCorpContracts, upFreeCorpMembers, upFreeCorpStructures,
  upFreeCorpCeoReuse, upFreeCorpCouriers, upFreeCorpWhCorps } = require("../freeCorps/schema");
const { upShipAiPrefs, upShipAiTurns, upShipAiMemory, upShipAiEvents, upShipAiPrefsMail,
  upShipAiEventsWatchKinds, upShipAiPrefsPersona, upShipAiPrefsAlerts, upShipAiTriggers,
  upShipAiPrefsVoice, upShipAiPrefsAutostart } = require("../shipAi/schema");
const { upWarContracts } = require("../warContracts/schema");
const { upAbyssalRuns } = require("../abyssal/schema");
const { upNewsTables, upNewsMail } = require("../news/schema");
const { upKillboardBattles, upKillboardKills } = require("../killboard/schema");
const { upDevIndices } = require("../world/devIndices/schema");
const { upJobBoardPins, upJobBoardPrefs } = require("../jobBoard/schema");
const { upBattleAnnouncements } = require("../battleAnnounce/schema");
const { upEscalations } = require("../escalations/schema");
const { upArchaeology } = require("../archaeology/schema");
const { upPopulation } = require("../population/schema");
const { upPopulationCorps } = require("../population/corps/schema");
const { upPopulationGroups } = require("../population/groups/schema");
const { upPopulationLifecycle } = require("../population/lifecycle/schema");
const { upNativeIncursions, upNativeIncursionRewards } = require("../nativeIncursions/schema");
const { upFactionIncursions } = require("../factionIncursions/schema");
const { upWarPairs } = require("../strategy/truce/schema");
const { upBountyTargets, upBountyPayouts, upBountyPayoutRetry, upBountyRevenge } = require("../bounty/schema");
const { upHarvestRaids } = require("../stations/harvestRaid/schema");
const { upPostSightings } = require("../listeningPosts/schema");
const { upSituations } = require("../situations/schema");
const { upGameMaster } = require("../gameMaster/schema");
const { upSeasons } = require("../seasons/schema");
const { upNemesis } = require("../nemesis/schema");
const { upWorldBosses } = require("../worldBosses/schema");
const { upVendorTags } = require("./vendorTags");

const MAX_UINT32 = 0xFFFFFFFF;
const META_TABLE = "lne_meta";
const SCHEMA_VERSION_KEY = "schema_version";
const WORLD_SEED_KEY = "world_seed";

const JOURNAL_TABLE = "world_event_journal";
const JOURNAL_MAX_KEY_LENGTH = 200;
const JOURNAL_MAX_NAME_LENGTH = 64;
const JOURNAL_MAX_ERROR_LENGTH = 1000;
const JOURNAL_HASH_LENGTH = 64;

function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_UINT32;
}

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "lne_meta",
    up(db, ctx) {
      db.exec(`CREATE TABLE ${META_TABLE} (
        key   TEXT    PRIMARY KEY NOT NULL,
        value INTEGER NOT NULL,
        CHECK (key <> '${WORLD_SEED_KEY}' OR value BETWEEN 0 AND ${MAX_UINT32})
      ) STRICT, WITHOUT ROWID`);
      const seed = ctx.randomSeed();
      if (!isUint32(seed)) throw new RangeError(`randomSeed returned ${seed}, expected an integer 0..${MAX_UINT32}`);
      db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`).run(WORLD_SEED_KEY, BigInt(seed));
    },
  }),
  Object.freeze({
    version: 2,
    name: JOURNAL_TABLE,
    up(db) {
      db.exec(`CREATE TABLE ${JOURNAL_TABLE} (
        journal_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND ${JOURNAL_MAX_KEY_LENGTH}),
        kind            TEXT    NOT NULL CHECK (kind IN ('APPLY', 'OUTBOX')),
        aggregate_type  TEXT    NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND ${JOURNAL_MAX_NAME_LENGTH}),
        aggregate_id    TEXT    NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND ${JOURNAL_MAX_KEY_LENGTH}),
        event_type      TEXT    NOT NULL CHECK (length(event_type) BETWEEN 1 AND ${JOURNAL_MAX_NAME_LENGTH}),
        payload         TEXT    NOT NULL CHECK (json_valid(payload)),
        payload_hash    TEXT    NOT NULL CHECK (length(payload_hash) = ${JOURNAL_HASH_LENGTH}),
        state           TEXT    NOT NULL CHECK (state IN ('PENDING', 'APPLIED', 'FAILED')),
        created_at      INTEGER NOT NULL CHECK (created_at >= 0),
        applied_at      INTEGER CHECK (applied_at IS NULL OR applied_at >= 0),
        error           TEXT,
        CHECK ((state = 'APPLIED') = (applied_at IS NOT NULL)),
        CHECK ((state = 'FAILED') = (error IS NOT NULL)),
        CHECK (kind = 'OUTBOX' OR state = 'APPLIED')
      ) STRICT;
      CREATE INDEX ${JOURNAL_TABLE}_pending ON ${JOURNAL_TABLE} (created_at, journal_id) WHERE state = 'PENDING';`);
    },
  }),
  Object.freeze({
    version: 3,
    name: "world_state",
    up: upWorldState,
  }),
  Object.freeze({
    version: 4,
    name: "world_scheduled_events",
    up: upScheduledEvents,
  }),
  Object.freeze({
    version: 5,
    name: "virtual_fleets",
    up: upFleets,
  }),
  Object.freeze({
    version: 6,
    name: "battle_records",
    up: upBattles,
  }),
  Object.freeze({
    version: 7,
    name: "world_wreck_fields",
    up: upWreckFields,
  }),
  Object.freeze({
    version: 8,
    name: "battle_contact_cooldowns",
    up: upBattleCooldowns,
  }),
  Object.freeze({
    version: 9,
    name: "world_factions",
    up: upWorldFactions,
  }),
  Object.freeze({
    version: 10,
    name: "world_stations",
    up: upStations,
  }),
  Object.freeze({
    version: 11,
    name: "virtual_fleets_refit_pending",
    up: upFleetsRefitPending,
  }),
  Object.freeze({
    version: 12,
    name: "world_faction_intel",
    up: upFactionIntel,
  }),
  Object.freeze({
    version: 13,
    name: "world_occupation",
    up: upOccupation,
  }),
  Object.freeze({
    version: 14,
    name: "world_mining_trips",
    up: upMiningTrips,
  }),
  Object.freeze({
    version: 15,
    name: "world_production_jobs",
    up: upProductionJobs,
  }),
  Object.freeze({
    version: 16,
    name: "world_faction_upkeep",
    up: upFactionUpkeep,
  }),
  Object.freeze({
    version: 17,
    name: "world_convoys",
    up: upConvoys,
  }),
  Object.freeze({
    version: 18,
    name: "salvage_jobs",
    up: upSalvageJobs,
  }),
  Object.freeze({
    version: 19,
    name: "world_station_builds",
    up: upStationBuilds,
  }),
  Object.freeze({
    version: 20,
    name: "world_trade",
    up: upTrade,
  }),
  Object.freeze({
    version: 21,
    name: "world_station_sieges",
    up: upSieges,
  }),
  Object.freeze({
    version: 22,
    name: "world_invasions",
    up: upInvasions,
  }),
  Object.freeze({
    version: 23,
    name: "world_virtual_identities",
    up: upVirtualIdentities,
  }),
  Object.freeze({
    version: 24,
    name: "world_sov_projection_log",
    up: upSovProjectionLog,
  }),
  Object.freeze({
    version: 25,
    name: "world_event_sites",
    up: upEventSites,
  }),
  Object.freeze({
    version: 26,
    name: "world_events",
    up: upWorldEvents,
  }),
  Object.freeze({
    version: 27,
    name: "world_sov_reconcile",
    up: upSovReconcile,
  }),
  Object.freeze({
    version: 28,
    name: "world_trade_private",
    up: upTradePrivate,
  }),
  Object.freeze({
    version: 29,
    name: "world_home_faction",
    up: upHomeFaction,
  }),
  Object.freeze({
    version: 30,
    name: "world_hunt_pins",
    up: upHuntPins,
  }),
  Object.freeze({
    version: 31,
    name: "world_trade_issuer",
    up: upTradeIssuer,
  }),
  Object.freeze({
    version: 32,
    name: "world_salvage_anomalies",
    up: upSalvageAnomalies,
  }),
  Object.freeze({
    version: 33,
    name: "world_wormhole_transits",
    up: upWormholeTransits,
  }),
  Object.freeze({
    version: 34,
    name: "battle_live_members",
    up: upLiveMembers,
  }),
  Object.freeze({
    version: 35,
    name: "world_trade_market",
    up: upTradeMarket,
  }),
  Object.freeze({
    version: 36,
    name: "world_faction_treasury",
    up: upTreasury,
  }),
  Object.freeze({
    version: 37,
    name: "world_trade_sell",
    up: upTradeSell,
  }),
  Object.freeze({
    version: 38,
    name: "world_lowsec_camps",
    up: upLowsecCamps,
  }),
  Object.freeze({
    version: 39,
    name: "world_capsuleer_corps",
    up: upCapsuleerCorps,
  }),
  Object.freeze({
    version: 40,
    name: "world_capsuleer_trips",
    up: upCapsuleerTrips,
  }),
  Object.freeze({
    version: 41,
    name: "world_capsuleer_trip_wait",
    up: upCapsuleerTripWait,
  }),
  Object.freeze({
    version: 42,
    name: "world_capsuleer_contracts",
    up: upCapsuleerContracts,
  }),
  Object.freeze({
    version: 43,
    name: "world_faction_treasury_merc",
    up: upTreasuryMerc,
  }),
  Object.freeze({
    version: 44,
    name: "world_capsuleer_trip_salvage",
    up: upCapsuleerTripSalvage,
  }),
  Object.freeze({
    version: 45,
    name: "world_capsuleer_claims",
    up: upCapsuleerClaims,
  }),
  Object.freeze({
    version: 46,
    name: "world_wh_expeditions",
    up: upWhExpeditions,
  }),
  Object.freeze({
    version: 47,
    name: "player_hunts",
    up: upPlayerHunts,
  }),
  Object.freeze({
    version: 48,
    name: "fleets_faction_live",
    up: upFleetsFactionLive,
  }),
  Object.freeze({
    version: 49,
    name: "scheduled_events_live_index",
    up: upScheduledEventsLiveIndex,
  }),
  Object.freeze({
    version: 50,
    name: "world_faction_recon_losses",
    up: upReconLosses,
  }),
  Object.freeze({
    version: 51,
    name: "world_notices",
    up: upNotices,
  }),
  Object.freeze({
    version: 52,
    name: "world_liberation_rewards",
    up: upLiberationRewards,
  }),
  Object.freeze({
    version: 53,
    name: "world_fleet_exposures",
    up: upFleetExposures,
  }),
  Object.freeze({
    version: 54,
    name: "world_faction_player_activity",
    up: upPlayerActivity,
  }),
  Object.freeze({
    version: 55,
    name: "crews",
    up: upCrews,
  }),
  Object.freeze({
    version: 56,
    name: "world_faction_treasury_pressure",
    up: upTreasuryPressure,
  }),
  Object.freeze({
    version: 57,
    name: "world_player_structure_sieges",
    up: upPlayerSieges,
  }),
  Object.freeze({
    version: 58,
    name: "world_sentries",
    up: upSentries,
  }),
  Object.freeze({
    version: 59,
    name: "world_sov_structures",
    up: upSovStructures,
  }),
  Object.freeze({
    version: 60,
    name: "lne_local_contacts",
    up: upLocalContacts,
  }),
  Object.freeze({
    version: 61,
    name: "world_front_jobs",
    up: upFrontJobs,
  }),
  Object.freeze({
    version: 62,
    name: "world_player_sov",
    up: upPlayerSov,
  }),
  Object.freeze({
    version: 63,
    name: "world_player_sov_clock",
    up: upPlayerSovClock,
  }),
  Object.freeze({
    version: 64,
    name: "world_heavy_events",
    up: upHeavyEvents,
  }),
  Object.freeze({
    version: 65,
    name: "world_event_sites_kind",
    up: upEventSitesKind,
  }),
  Object.freeze({
    version: 66,
    name: "world_heavy_events_power",
    up: upHeavyEventsPower,
  }),
  Object.freeze({
    version: 67,
    name: "world_heavy_event_payouts",
    up: upHeavyEventPayouts,
  }),
  Object.freeze({
    version: 68,
    name: "world_supplier_standing",
    up: upSupplierStanding,
  }),
  Object.freeze({
    version: 69,
    name: "world_fleet_grid_visits",
    up: upFleetGridVisits,
  }),
  Object.freeze({
    version: 70,
    name: "battle_records_grid",
    up: upBattleGrid,
  }),
  Object.freeze({
    version: 71,
    name: "world_fortress_halt_memory",
    up: upFortressHaltMemory,
  }),
  Object.freeze({
    version: 72,
    name: "world_faction_attack_losses",
    up: upAttackLosses,
  }),
  Object.freeze({
    version: 73,
    name: "world_free_corps",
    up: upFreeCorps,
  }),
  Object.freeze({
    version: 74,
    name: "world_free_corp_ventures",
    up: upFreeCorpVentures,
  }),
  Object.freeze({
    version: 75,
    name: "world_free_corp_ventures_wh",
    up: upFreeCorpVenturesWh,
  }),
  Object.freeze({
    version: 76,
    name: "world_free_corp_wars",
    up: upFreeCorpWars,
  }),
  Object.freeze({
    version: 77,
    name: "world_free_corp_outbox",
    up: upFreeCorpOutbox,
  }),
  Object.freeze({
    version: 78,
    name: "world_free_corp_contracts",
    up: upFreeCorpContracts,
  }),
  Object.freeze({
    version: 79,
    name: "world_free_corp_members",
    up: upFreeCorpMembers,
  }),
  Object.freeze({
    version: 80,
    name: "world_free_corp_structures",
    up: upFreeCorpStructures,
  }),
  Object.freeze({
    version: 81,
    name: "world_free_corps_ceo_reuse",
    up: upFreeCorpCeoReuse,
  }),
  Object.freeze({
    version: 82,
    name: "world_free_corp_contracts_courier",
    up: upFreeCorpCouriers,
  }),
  Object.freeze({
    version: 83,
    name: "battle_records_settled",
    up: upBattleRecordsSettled,
  }),
  Object.freeze({
    version: 84,
    name: "ship_ai_prefs",
    up: upShipAiPrefs,
  }),
  Object.freeze({
    version: 85,
    name: "ship_ai_turns",
    up: upShipAiTurns,
  }),
  Object.freeze({
    version: 86,
    name: "ship_ai_memory",
    up: upShipAiMemory,
  }),
  Object.freeze({
    version: 87,
    name: "ship_ai_events",
    up: upShipAiEvents,
  }),
  Object.freeze({
    version: 88,
    name: "ship_ai_prefs_mail",
    up: upShipAiPrefsMail,
  }),
  Object.freeze({
    version: 89,
    name: "ship_ai_events_watch_kinds",
    up: upShipAiEventsWatchKinds,
  }),
  Object.freeze({
    version: 90,
    name: "ship_ai_prefs_persona",
    up: upShipAiPrefsPersona,
  }),
  Object.freeze({
    version: 91,
    name: "ship_ai_prefs_alerts",
    up: upShipAiPrefsAlerts,
  }),
  Object.freeze({
    version: 92,
    name: "ship_ai_triggers",
    up: upShipAiTriggers,
  }),
  Object.freeze({
    version: 93,
    name: "ship_ai_prefs_voice",
    up: upShipAiPrefsVoice,
  }),
  Object.freeze({
    version: 94,
    name: "ship_ai_prefs_autostart",
    up: upShipAiPrefsAutostart,
  }),
  Object.freeze({
    version: 95,
    name: "war_contracts",
    up: upWarContracts,
  }),
  Object.freeze({
    version: 96,
    name: "abyssal_runs",
    up: upAbyssalRuns,
  }),
  Object.freeze({
    version: 97,
    name: "news_tables",
    up: upNewsTables,
  }),
  Object.freeze({
    version: 98,
    name: "killboard_battles",
    up: upKillboardBattles,
  }),
  Object.freeze({
    version: 99,
    name: "news_mail",
    up: upNewsMail,
  }),
  Object.freeze({
    version: 100,
    name: "killboard_kills",
    up: upKillboardKills,
  }),
  Object.freeze({
    version: 101,
    name: "job_board_pins",
    up: upJobBoardPins,
  }),
  Object.freeze({
    version: 102,
    name: "job_board_prefs",
    up: upJobBoardPrefs,
  }),
  Object.freeze({
    version: 103,
    name: "battle_announcements",
    up: upBattleAnnouncements,
  }),
  Object.freeze({
    version: 104,
    name: "escalations",
    up: upEscalations,
  }),
  Object.freeze({
    version: 105,
    name: "war_pairs",
    up: upWarPairs,
  }),
  Object.freeze({
    version: 106,
    name: "bounty_targets",
    up: upBountyTargets,
  }),
  Object.freeze({
    version: 107,
    name: "bounty_payouts",
    up: upBountyPayouts,
  }),
  Object.freeze({
    version: 108,
    name: "bounty_payout_retry",
    up: upBountyPayoutRetry,
  }),
  Object.freeze({
    version: 109,
    name: "bounty_revenge",
    up: upBountyRevenge,
  }),
  Object.freeze({
    version: 110,
    name: "harvest_raids",
    up: upHarvestRaids,
  }),
  Object.freeze({
    version: 111,
    name: "post_sightings",
    up: upPostSightings,
  }),
  Object.freeze({
    version: 112,
    name: "situations",
    up: upSituations,
  }),
  Object.freeze({
    version: 113,
    name: "world_sentries_space_anchor",
    up: upSentriesSpaceAnchor,
  }),
  Object.freeze({
    version: 114,
    name: "game_master",
    up: upGameMaster,
  }),
  Object.freeze({
    version: 115,
    name: "galactic_seasons",
    up: upSeasons,
  }),
  Object.freeze({
    version: 116,
    name: "nemesis",
    up: upNemesis,
  }),
  Object.freeze({
    version: 117,
    name: "world_bosses",
    up: upWorldBosses,
  }),
  Object.freeze({
    version: 118,
    name: "dev_indices",
    up: upDevIndices,
  }),
  Object.freeze({
    version: 119,
    name: "archaeology",
    up: upArchaeology,
  }),
  Object.freeze({
    version: 120,
    name: "population",
    up: upPopulation,
  }),
  Object.freeze({
    version: 121,
    name: "native-incursions",
    up: upNativeIncursions,
  }),
  Object.freeze({
    version: 122,
    name: "faction-incursions",
    up: upFactionIncursions,
  }),
  Object.freeze({
    version: 123,
    name: "native-incursion-rewards",
    up: upNativeIncursionRewards,
  }),
  Object.freeze({
    version: 124,
    name: "population-corps",
    up: upPopulationCorps,
  }),
  Object.freeze({
    version: 125,
    name: "population-groups",
    up: upPopulationGroups,
  }),
  Object.freeze({
    version: 126,
    name: "population-lifecycle",
    up: upPopulationLifecycle,
  }),
  Object.freeze({
    version: 127,
    name: "free-corp-wh-corps",
    up: upFreeCorpWhCorps,
  }),
  Object.freeze({
    version: 128,
    name: "vendor-record-tags",
    up: upVendorTags,
  }),
]);

const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function validateMigrations(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, reason: "MIGRATIONS_INVALID", detail: "empty or not an array" };
  }
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (!m || m.version !== i + 1 || typeof m.name !== "string" || m.name === "" || typeof m.up !== "function") {
      return { ok: false, reason: "MIGRATIONS_INVALID", detail: `entry ${i} must be {version:${i + 1}, name, up}` };
    }
  }
  return { ok: true };
}

function readSchemaVersion(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
    .all().map((row) => row.name);
  if (!tables.includes(META_TABLE)) {
    if (tables.length === 0) return { ok: true, version: 0 };
    return { ok: false, reason: "DB_FOREIGN", detail: `no ${META_TABLE}, tables: ${tables.slice(0, 5).join(", ")}` };
  }
  const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(SCHEMA_VERSION_KEY);
  const version = row ? row.value : undefined;
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, reason: "META_INVALID", detail: `${SCHEMA_VERSION_KEY}=${version}` };
  }
  return { ok: true, version };
}

function writeSchemaVersion(db, from, to) {
  const info = from === 0
    ? db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`).run(SCHEMA_VERSION_KEY, BigInt(to))
    : db.prepare(`UPDATE ${META_TABLE} SET value = ? WHERE key = ?`).run(BigInt(to), SCHEMA_VERSION_KEY);
  if (info.changes !== 1) throw new Error(`${SCHEMA_VERSION_KEY} write changed ${info.changes} rows`);
}

function isBusy(err) {
  return Boolean(err && typeof err.code === "string" && err.code.startsWith("SQLITE_BUSY"));
}

const ABORT = Symbol("migration-abort");

function runMigrations(db, list, ctx) {
  const valid = validateMigrations(list);
  if (!valid.ok) return valid;
  const latest = list[list.length - 1].version;
  let outcome = null;
  const abort = (result) => {
    outcome = result;
    throw ABORT;
  };
  try {
    db.transaction(() => {
      const current = readSchemaVersion(db);
      if (!current.ok) abort(current);
      if (current.version > latest) {
        abort({ ok: false, reason: "SCHEMA_TOO_NEW", version: current.version,
          detail: `schema_version ${current.version} > newest known ${latest}` });
      }
      let applied = 0;
      for (const migration of list) {
        if (migration.version <= current.version) continue;
        try {
          migration.up(db, ctx);
        } catch (err) {
          if (isBusy(err)) throw err;
          abort({ ok: false, reason: "MIGRATION_FAILED", version: migration.version,
            detail: `${migration.name}: ${(err && err.message) || err}` });
        }
        applied += 1;
      }
      if (applied > 0) writeSchemaVersion(db, current.version, latest);
      outcome = { ok: true, from: current.version, to: Math.max(latest, current.version), applied };
    }).immediate();
  } catch (err) {
    if (err === ABORT) return outcome;
    if (isBusy(err)) return { ok: false, reason: "DB_LOCKED", detail: String(err.message || err) };
    return { ok: false, reason: "MIGRATION_FAILED", detail: String((err && err.message) || err) };
  }
  return outcome;
}

module.exports = {
  MAX_UINT32,
  META_TABLE,
  SCHEMA_VERSION_KEY,
  WORLD_SEED_KEY,
  JOURNAL_TABLE,
  JOURNAL_MAX_KEY_LENGTH,
  JOURNAL_MAX_NAME_LENGTH,
  JOURNAL_MAX_ERROR_LENGTH,
  JOURNAL_HASH_LENGTH,
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  isUint32,
  validateMigrations,
  readSchemaVersion,
  runMigrations,
};
