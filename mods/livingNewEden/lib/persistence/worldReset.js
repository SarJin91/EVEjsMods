"use strict";

const { META_TABLE, JOURNAL_TABLE, LATEST_SCHEMA_VERSION, readSchemaVersion } = require("./migrations");
const SITES = require("../events/sites/schema");
const STANDINGS = require("../world/standings/schema");
const SOV = require("../world/sovProjection/schema");
const SOV_RECONCILE = require("../world/sovReconcile/schema");
const TRADE = require("../economy/trade/schema");
const SALVAGE_ANOMALY = require("../events/salvage/schema");
const { TABLE_NAME: IDENTITIES_TABLE } = require("../virtualCorps/schema");
const { TABLE_NAME: SCHEDULER_TABLE } = require("../scheduler/schema");

const ACTION = Object.freeze({
  KEEP: "KEEP",
  WIPE: "WIPE",
  PARTIAL_JOURNAL: "PARTIAL_JOURNAL",
  PARTIAL_SCHEDULER: "PARTIAL_SCHEDULER",
  TRANSITION_SITES: "TRANSITION_SITES",
});

const SEQUENCE_TABLE = "sqlite_sequence";

const TABLE_POLICY = Object.freeze({
  [META_TABLE]: ACTION.KEEP,
  [IDENTITIES_TABLE]: ACTION.KEEP,
  [SEQUENCE_TABLE]: ACTION.KEEP,
  [JOURNAL_TABLE]: ACTION.PARTIAL_JOURNAL,
  [SCHEDULER_TABLE]: ACTION.PARTIAL_SCHEDULER,
  [SITES.TABLE_NAME]: ACTION.TRANSITION_SITES,
  world_system_state: ACTION.WIPE,
  world_system_influence: ACTION.WIPE,
  world_operations: ACTION.WIPE,
  virtual_fleets: ACTION.WIPE,
  battle_records: ACTION.WIPE,
  battle_participants: ACTION.WIPE,
  battle_losses: ACTION.WIPE,
  world_wreck_fields: ACTION.WIPE,
  battle_contact_cooldowns: ACTION.WIPE,
  world_factions: ACTION.WIPE,
  world_stations: ACTION.WIPE,
  world_station_stock: ACTION.WIPE,
  world_faction_intel: ACTION.WIPE,
  world_mining_trips: ACTION.WIPE,
  world_mining_totals: ACTION.WIPE,
  world_production_jobs: ACTION.WIPE,
  world_production_totals: ACTION.WIPE,
  world_convoys: ACTION.WIPE,
  world_convoy_totals: ACTION.WIPE,
  salvage_jobs: ACTION.WIPE,
  world_station_builds: ACTION.WIPE,
  world_trade_budgets: ACTION.WIPE,
  world_trade_offers: ACTION.WIPE,
  world_station_sieges: ACTION.WIPE,
  world_siege_totals: ACTION.WIPE,
  world_invasions: ACTION.WIPE,
  world_invasion_totals: ACTION.WIPE,
  [SOV.TABLE_NAME]: ACTION.WIPE,
  [SOV_RECONCILE.TABLE_NAME]: ACTION.WIPE,
  world_hunt_pins: ACTION.WIPE,
  world_events: ACTION.WIPE,
  [SALVAGE_ANOMALY.TABLE_NAME]: ACTION.WIPE,
  world_wormhole_transits: ACTION.WIPE,
  battle_live_members: ACTION.WIPE,
  world_faction_treasury: ACTION.WIPE,
  world_faction_treasury_days: ACTION.WIPE,
  world_lowsec_camps: ACTION.WIPE,
  world_capsuleer_corps: ACTION.WIPE,
  world_capsuleer_trips: ACTION.WIPE,
  world_capsuleer_contracts: ACTION.WIPE,
  world_capsuleer_claims: ACTION.WIPE,
  world_wh_expeditions: ACTION.WIPE,
  world_player_hunts: ACTION.WIPE,
  world_faction_recon_losses: ACTION.WIPE,
  world_notice_items: ACTION.WIPE,
  world_notice_batches: ACTION.WIPE,
  world_liberation_contributions: ACTION.WIPE,
  world_liberation_payouts: ACTION.KEEP,
  world_fleet_exposures: ACTION.WIPE,
  world_faction_player_activity: ACTION.WIPE,
  world_fleet_crews: ACTION.WIPE,
  world_fleet_crew_seats: ACTION.WIPE,
  world_crew_pilots: ACTION.WIPE,
  world_player_structure_sieges: ACTION.WIPE,
  world_sentries: ACTION.WIPE,
  world_sov_structures: ACTION.WIPE,
  lne_local_contacts: ACTION.KEEP,
  world_front_jobs: ACTION.WIPE,
  world_front_job_progress: ACTION.WIPE,
  world_front_job_payouts: ACTION.KEEP,
  world_player_sov: ACTION.WIPE,
  world_player_sov_clock: ACTION.WIPE,
  world_heavy_events: ACTION.WIPE,
  world_heavy_event_payouts: ACTION.KEEP,
  world_supplier_standing: ACTION.KEEP,
  world_fleet_grid_visits: ACTION.WIPE,
  world_fortress_halt_memory: ACTION.WIPE,
  world_faction_attack_losses: ACTION.WIPE,
  world_free_corps: ACTION.KEEP,
  world_free_corp_ventures: ACTION.WIPE,
  world_free_corp_wh_homes: ACTION.KEEP,
  world_free_corp_wars: ACTION.WIPE,
  world_free_corp_skirmishes: ACTION.WIPE,
  world_free_corp_outbox: ACTION.KEEP,
  world_free_corp_contracts: ACTION.KEEP,
  world_free_corp_members: ACTION.KEEP,
  world_free_corp_structures: ACTION.KEEP,
  ship_ai_prefs: ACTION.KEEP,
  ship_ai_turns: ACTION.KEEP,
  ship_ai_summaries: ACTION.KEEP,
  ship_ai_facts: ACTION.KEEP,
  ship_ai_events: ACTION.KEEP,
  world_war_contracts: ACTION.KEEP,
  lne_abyssal_runs: ACTION.KEEP,
  lne_news_state: ACTION.WIPE,
  lne_news_facts: ACTION.WIPE,
  lne_news_editions: ACTION.WIPE,
  lne_news_deliveries: ACTION.WIPE,
  lne_news_readers: ACTION.KEEP,
  kb_battles: ACTION.WIPE,
  kb_battle_sides: ACTION.WIPE,
  kb_faction_totals: ACTION.WIPE,
  kb_type_prices: ACTION.WIPE,
  kb_cursor: ACTION.WIPE,
  kb_kills: ACTION.WIPE,
  kb_kill_chars: ACTION.WIPE,
  kb_char_totals: ACTION.WIPE,
  kb_names: ACTION.WIPE,
  world_system_dev: ACTION.WIPE,
  world_dev_cursors: ACTION.WIPE,
  world_dev_investments: ACTION.KEEP,
  world_job_board_pins: ACTION.WIPE,
  job_board_prefs: ACTION.KEEP,
  battle_announcements: ACTION.WIPE,
  battle_announcement_recipients: ACTION.WIPE,
  world_escalations: ACTION.WIPE,
  world_escalation_recipients: ACTION.WIPE,
  world_war_pairs: ACTION.WIPE,
  world_bounty_targets: ACTION.WIPE,
  world_bounty_payouts: ACTION.KEEP,
  world_bounty_revenge: ACTION.WIPE,
  world_harvest_raids: ACTION.WIPE,
  world_post_sightings: ACTION.WIPE,
  world_arch_chains: ACTION.WIPE,
  world_arch_fragments: ACTION.WIPE,
  world_npc_pilots: ACTION.WIPE,
  world_npc_population: ACTION.WIPE,
  world_npc_corps: ACTION.WIPE,
  world_native_incursions: ACTION.WIPE,
  world_faction_incursions: ACTION.WIPE,
  world_faction_incursion_sites: ACTION.WIPE,
  world_situations: ACTION.WIPE,
  world_situation_payouts: ACTION.KEEP,
  world_gm_cycles: ACTION.WIPE,
  world_gm_threads: ACTION.WIPE,
  world_gm_activity: ACTION.WIPE,
  world_seasons: ACTION.KEEP,
  world_season_scores: ACTION.KEEP,
  world_season_rewards: ACTION.KEEP,
  world_nemesis: ACTION.WIPE,
  world_bosses: ACTION.WIPE,
  world_boss_participants: ACTION.WIPE,
  world_boss_payouts: ACTION.KEEP,
});

const FUTURE_TABLES = Object.freeze([]);

const SITE_TRANSITION_STATES = Object.freeze([...SITES.VISIBLE_STATES]);
const SITE_DELETE_STATES = Object.freeze([SITES.STATE.PURGED, SITES.STATE.FAILED]);
const SITE_KEPT_STATES = Object.freeze([SITES.STATE.CLEANING, SITES.STATE.CLEANED]);
const STANDING_KEY_PREFIXES = Object.freeze([STANDINGS.KEY_PREFIX, STANDINGS.PRUNE_KEY_PREFIX, TRADE.STANDING_KEY_PREFIX]);
const STANDING_EVENT_TYPES = Object.freeze([STANDINGS.EVENT_TYPE, STANDINGS.PRUNE_EVENT_TYPE, TRADE.EVENT_STANDING_GRANT]);
const TRADE_CONTRACT_STATES = Object.freeze([TRADE.ISSUING, TRADE.OPEN]);
const TRADE_LEFTOVER_STATES = Object.freeze([TRADE.ACCEPTED, TRADE.INTAKE]);

const quote = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;
const marks = (list) => list.map(() => "?").join(", ");

const JOURNAL_KEEP_SQL = STANDING_KEY_PREFIXES.map(() => "substr(idempotency_key, 1, ?) = ?").join(" OR ");
const JOURNAL_KEEP_PARAMS = STANDING_KEY_PREFIXES.flatMap((p) => [p.length, p]);
const SCHEDULER_KEEP_SQL = `event_type IN (${marks(STANDING_EVENT_TYPES)})`;

function countOf(db, sql, params = []) {
  return Number(db.prepare(sql).pluck().get(...params));
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
    + "OR name = ?) ORDER BY name").pluck().all(SEQUENCE_TABLE);
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function plannedOf(db, name, action) {
  const t = quote(name);
  switch (action) {
    case ACTION.WIPE:
      return { toDelete: countOf(db, `SELECT COUNT(*) FROM ${t}`), toTransition: 0 };
    case ACTION.PARTIAL_JOURNAL:
      return { toDelete: countOf(db, `SELECT COUNT(*) FROM ${t} WHERE NOT (${JOURNAL_KEEP_SQL})`, JOURNAL_KEEP_PARAMS),
        toTransition: 0 };
    case ACTION.PARTIAL_SCHEDULER:
      return { toDelete: countOf(db, `SELECT COUNT(*) FROM ${t} WHERE NOT (${SCHEDULER_KEEP_SQL})`,
        STANDING_EVENT_TYPES), toTransition: 0 };
    case ACTION.TRANSITION_SITES:
      return {
        toDelete: countOf(db, `SELECT COUNT(*) FROM ${t} WHERE state IN (${marks(SITE_DELETE_STATES)})`,
          SITE_DELETE_STATES),
        toTransition: countOf(db, `SELECT COUNT(*) FROM ${t} WHERE state IN (${marks(SITE_TRANSITION_STATES)})`,
          SITE_TRANSITION_STATES),
      };
    default:
      return { toDelete: 0, toTransition: 0 };
  }
}

function gameOf(db, present) {
  const game = { sitesToClean: 0, sitesAlreadyCleaning: 0, tradeOffersWithContract: 0, tradeOfferIssuerCorps: 0,
    tradeOffersAcceptedOrIntake: 0, tradeMarketOrdersOpen: 0, sovClaimsLogged: 0, standingsJournalKept: 0, standingsEventsKept: 0 };
  if (present.has(SITES.TABLE_NAME)) {
    const t = quote(SITES.TABLE_NAME);
    game.sitesToClean = countOf(db, `SELECT COUNT(*) FROM ${t} WHERE state IN (${marks(SITE_TRANSITION_STATES)})`,
      SITE_TRANSITION_STATES);
    game.sitesAlreadyCleaning = countOf(db, `SELECT COUNT(*) FROM ${t} WHERE state IN (${marks(SITE_KEPT_STATES)})`,
      SITE_KEPT_STATES);
  }
  if (present.has("world_trade_offers")) {
    const where = `state IN (${marks(TRADE_CONTRACT_STATES)}) AND contract_id IS NOT NULL`;
    game.tradeOffersWithContract = countOf(db, `SELECT COUNT(*) FROM world_trade_offers WHERE ${where}`,
      TRADE_CONTRACT_STATES);
    game.tradeOfferIssuerCorps = countOf(db, "SELECT COUNT(DISTINCT issuer_corporation_id) FROM world_trade_offers "
      + `WHERE ${where}`, TRADE_CONTRACT_STATES);
    game.tradeOffersAcceptedOrIntake = countOf(db, "SELECT COUNT(*) FROM world_trade_offers "
      + `WHERE state IN (${marks(TRADE_LEFTOVER_STATES)})`, TRADE_LEFTOVER_STATES);
    const colRes = db.prepare("PRAGMA table_info(world_trade_offers)").all();
    const hasChannel = colRes.some((c) => c.name === "channel");
    const hasMarketOrderId = colRes.some((c) => c.name === "market_order_id");
    if (hasChannel && hasMarketOrderId) {
      game.tradeMarketOrdersOpen = countOf(db,
        "SELECT COUNT(*) FROM world_trade_offers WHERE channel = 'market' AND market_order_id IS NOT NULL AND state IN ('ISSUING','OPEN')");
    }
  }
  if (present.has(SOV.TABLE_NAME)) {
    game.sovClaimsLogged = countOf(db, `SELECT COUNT(*) FROM ${quote(SOV.TABLE_NAME)} `
      + `WHERE last_action IN (${marks(SOV.CLAIM_ACTIONS)})`, SOV.CLAIM_ACTIONS);
  }
  if (present.has(JOURNAL_TABLE)) {
    game.standingsJournalKept = countOf(db, `SELECT COUNT(*) FROM ${quote(JOURNAL_TABLE)} WHERE ${JOURNAL_KEEP_SQL}`,
      JOURNAL_KEEP_PARAMS);
  }
  if (present.has(SCHEDULER_TABLE)) {
    game.standingsEventsKept = countOf(db, `SELECT COUNT(*) FROM ${quote(SCHEDULER_TABLE)} WHERE ${SCHEDULER_KEEP_SQL}`,
      STANDING_EVENT_TYPES);
  }
  return game;
}

function planReset(db) {
  try {
    const names = tableNames(db);
    if (!names.includes(META_TABLE)) {
      return { ok: false, reason: "NOT_LNE_DB", detail: `no ${META_TABLE} (tables: ${names.slice(0, 5).join(", ")})` };
    }
    const version = readSchemaVersion(db);
    if (!version.ok) return { ok: false, reason: "SCHEMA_MISMATCH", detail: `${version.reason}: ${version.detail}` };
    if (version.version > LATEST_SCHEMA_VERSION) {
      return { ok: false, reason: "SCHEMA_MISMATCH",
        detail: `schema_version ${version.version} > newest known ${LATEST_SCHEMA_VERSION}` };
    }
    const unclassified = names.filter((n) => !Object.prototype.hasOwnProperty.call(TABLE_POLICY, n));
    if (unclassified.length > 0) {
      return { ok: false, reason: "UNCLASSIFIED_TABLE", detail: unclassified.join(", ") };
    }
    const tables = names.map((name) => {
      const action = TABLE_POLICY[name];
      return { name, action, rows: countOf(db, `SELECT COUNT(*) FROM ${quote(name)}`), ...plannedOf(db, name, action) };
    });
    const present = new Set(names);
    const identities = { total: 0, byKindState: {} };
    if (present.has(IDENTITIES_TABLE)) {
      const rows = db.prepare(`SELECT kind, state, COUNT(*) AS n FROM ${quote(IDENTITIES_TABLE)} `
        + "GROUP BY kind, state ORDER BY kind, state").all();
      for (const r of rows) {
        identities.byKindState[`${r.kind}:${r.state}`] = Number(r.n);
        identities.total += Number(r.n);
      }
    }
    return { ok: true, schemaVersion: version.version, tables, identities, game: gameOf(db, present) };
  } catch (err) {
    return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
  }
}

class PlanDrift extends Error {}

function expectChanges(info, expected, what) {
  if (info.changes !== expected) throw new PlanDrift(`${what}: changed ${info.changes}, plan ${expected}`);
}

function applyReset(db, plan, opts) {
  const now = opts && opts.now;
  if (!plan || plan.ok !== true || !Array.isArray(plan.tables)) {
    return { ok: false, reason: "RESET_FAILED", detail: "plan is not an ok planReset result" };
  }
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: "RESET_FAILED", detail: `now=${now}` };
  const deleted = {};
  let transitioned = 0;
  try {
    db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      for (const t of plan.tables) {
        const q = quote(t.name);
        if (TABLE_POLICY[t.name] !== t.action) throw new PlanDrift(`${t.name}: action ${t.action} not in TABLE_POLICY`);
        let info = { changes: 0 };
        switch (t.action) {
          case ACTION.KEEP:
            break;
          case ACTION.WIPE:
            info = db.prepare(`DELETE FROM ${q}`).run();
            break;
          case ACTION.PARTIAL_JOURNAL:
            info = db.prepare(`DELETE FROM ${q} WHERE NOT (${JOURNAL_KEEP_SQL})`).run(...JOURNAL_KEEP_PARAMS);
            break;
          case ACTION.PARTIAL_SCHEDULER:
            info = db.prepare(`DELETE FROM ${q} WHERE NOT (${SCHEDULER_KEEP_SQL})`).run(...STANDING_EVENT_TYPES);
            break;
          case ACTION.TRANSITION_SITES: {
            const moved = db.prepare(`UPDATE ${q} SET state = ?, fail_reason = COALESCE(fail_reason, ?), `
              + "next_attempt_at = 0, attempts = 0, updated_at = ?, version = version + 1 "
              + `WHERE state IN (${marks(SITE_TRANSITION_STATES)})`)
              .run(SITES.STATE.CLEANING, SITES.FAIL_REASON.EVENT_CANCELLED, now, ...SITE_TRANSITION_STATES);
            expectChanges(moved, t.toTransition, `${t.name} transition`);
            transitioned += moved.changes;
            info = db.prepare(`DELETE FROM ${q} WHERE state IN (${marks(SITE_DELETE_STATES)})`).run(...SITE_DELETE_STATES);
            break;
          }
          default:
            throw new PlanDrift(`${t.name}: unknown action ${t.action}`);
        }
        expectChanges(info, t.toDelete, t.name);
        deleted[t.name] = info.changes;
      }
    }).immediate();
  } catch (err) {
    if (err instanceof PlanDrift) return { ok: false, reason: "PLAN_DRIFT", detail: err.message };
    return { ok: false, reason: "RESET_FAILED", detail: messageOf(err) };
  }
  return { ok: true, deleted, transitioned };
}

module.exports = { ACTION, TABLE_POLICY, FUTURE_TABLES, planReset, applyReset };
