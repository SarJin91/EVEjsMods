"use strict";

const N = require("../nativeIncursions/schema");
const { parseFactionIdList } = require("../heavyEvents/world/schema");
const { FACTIONS } = require("./data/catalog");

const TABLE = "world_faction_incursions";
const SITES_TABLE = "world_faction_incursion_sites";
const SITE_EVENT_PREFIX = "hin";
const ROW_STATE = Object.freeze({ ACTIVE: "ACTIVE", DECIDED: "DECIDED", SETTLED: "SETTLED" });
const SLOT_STATE = Object.freeze({ WAITING: "WAITING", OPEN: "OPEN", CLOSED: "CLOSED" });
const OUTCOME = Object.freeze({ DEFEATED: "defeated", EXPIRED: "expired", CANCELLED: "cancelled" });
const EFFECT = Object.freeze({ ...N.EFFECT, DISABLED: "DISABLED" });
const FINAL_REPEL_REFUSALS = N.FINAL_REPEL_REFUSALS;
const GENERATION = 1;
const AGGREGATE = "faction_incursion";
const EVENT_CREATE = "FACTION_INCURSION_CREATE";
const EVENT_SETTLE = "FACTION_INCURSION_SETTLE";
const SITE_CLEARED_STATES = Object.freeze(["CLEARED", "COMPLETED"]);
const SITE_ENDED_STATES = Object.freeze(["EXPIRED", "FAILED", "CANCELLED"]);
const SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);
const MAX_SYSTEMS_JSON = 512;
const MAX_RULES_JSON = 4096;
const MAX_PROGRESS_JSON = 16384;

const idempotencyKeyOf = (factionId, systemId, phaseSeq) => `finc:${factionId}:${systemId}:${phaseSeq}`;
const createKeyOf = (idempotencyKey) => `finc:create:${idempotencyKey}`;
const settleKeyOf = (incursionId) => `finc:settle:${incursionId}:g${GENERATION}`;
const repelKeyOf = (incursionId) => `finc:repel:${incursionId}:g${GENERATION}`;
const huntIdOf = (incursionId) => `finc:${incursionId}`;
const worldTokenOf = (createdAt) => Number(createdAt).toString(36);
const siteEventIdOf = (incursionId, createdAt, slotKey, incarnation) =>
  `${SITE_EVENT_PREFIX}:${incursionId}:${worldTokenOf(createdAt)}:${slotKey}:${incarnation}`;
const rewardEventIdOf = (incursionId, createdAt) => `finc:reward:${incursionId}:${worldTokenOf(createdAt)}`;
const sitePrefixOf = (incursionId, createdAt) => `${SITE_EVENT_PREFIX}:${incursionId}:${worldTokenOf(createdAt)}:`;
const POOL_ROWS_RESERVE = 16;
const POOL_MODE = Object.freeze({ OFF: "off", ON: "on", ROW_BOUND: "ROW_BOUND" });
const DROP_REASON = "FACTION_INCURSION_DEFEAT";
const HOLD_REASON = "FACTION_INCURSION_HOLD";
const dropKeyOf = (incursionId, systemId) => `finc:drop:${incursionId}:g${GENERATION}:${systemId}`;
const holdKeyOf = (incursionId, systemId) => `finc:hold:${incursionId}:g${GENERATION}:${systemId}`;
const NEWS = Object.freeze({ PREFIX: "fis" });
const newsKeyOf = (incursionId) => `${NEWS.PREFIX}:${incursionId}:g${GENERATION}`;
const CONSEQUENCES_MODE = Object.freeze({ OFF: "off", ON: "on", ROW_BOUND: "ROW_BOUND" });
const slotKeyOf = (stageKey, i, slots) => (slots === 1 ? stageKey : `${stageKey}.${i}`);

const FACTION_TALE_ID_BASE = 9500000000000;
const taleIdOf = (incursionId) => FACTION_TALE_ID_BASE + incursionId;
const SCENE_OF_ROLE = Object.freeze({ hq: 1, assault: 2, vanguard: 3, staging: 4 });
const UI_STATE_OF_PHASE = Object.freeze({ ESTABLISHED: 2, MOBILIZING: 1, WITHDRAWING: 0, OVER: 0 });

const parseClaimStates = N.parseClaimStates;

function parseFactionIds(text) {
  const ids = parseFactionIdList(text);
  if (!ids) return null;
  return ids.every((id) => Object.prototype.hasOwnProperty.call(FACTIONS, id)) ? ids : null;
}

const DDL = `
CREATE TABLE world_faction_incursions (
  incursion_id INTEGER PRIMARY KEY CHECK (incursion_id > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 96),
  faction_id INTEGER NOT NULL CHECK (faction_id > 0),
  constellation_id INTEGER NOT NULL CHECK (constellation_id > 0),
  sec_class TEXT NOT NULL CHECK (sec_class IN ('highsec','lowsec','nullsec')),
  target_system_id INTEGER NOT NULL CHECK (target_system_id > 0),
  claim_phase_seq INTEGER NOT NULL CHECK (claim_phase_seq >= 0),
  beneficiary_faction_id INTEGER CHECK (beneficiary_faction_id IS NULL OR beneficiary_faction_id > 0),
  strength_milli INTEGER NOT NULL CHECK (strength_milli BETWEEN 0 AND 1000),
  systems_json TEXT NOT NULL CHECK (json_valid(systems_json) AND length(systems_json) <= 512),
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json) AND length(rules_json) <= 4096),
  rules_fingerprint TEXT NOT NULL CHECK (length(rules_fingerprint) = 64),
  progress_json TEXT NOT NULL CHECK (json_valid(progress_json) AND length(progress_json) <= 16384),
  influence_milli INTEGER NOT NULL CHECK (influence_milli BETWEEN 0 AND 1000),
  influence_updated_at INTEGER NOT NULL CHECK (influence_updated_at >= 0),
  grace_minutes INTEGER NOT NULL CHECK (grace_minutes >= 0),
  decay_milli_per_hour INTEGER NOT NULL CHECK (decay_milli_per_hour >= 0),
  per_completion_milli INTEGER NOT NULL CHECK (per_completion_milli BETWEEN 0 AND 1000),
  hq_unlock_milli INTEGER NOT NULL CHECK (hq_unlock_milli BETWEEN 0 AND 1000),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','DECIDED','SETTLED')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  mobilizing_at INTEGER NOT NULL CHECK (mobilizing_at >= created_at),
  withdrawing_at INTEGER NOT NULL CHECK (withdrawing_at >= mobilizing_at),
  expires_at INTEGER NOT NULL CHECK (expires_at >= withdrawing_at),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('defeated','expired','cancelled')),
  decided_at INTEGER,
  hq_event_id TEXT CHECK (hq_event_id IS NULL OR length(hq_event_id) <= 64),
  effect TEXT CHECK (effect IS NULL OR length(effect) <= 32),
  settled_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;
CREATE UNIQUE INDEX world_faction_incursions_open_constellation
  ON world_faction_incursions (constellation_id) WHERE state <> 'SETTLED';
CREATE INDEX world_faction_incursions_open ON world_faction_incursions (state, incursion_id) WHERE state <> 'SETTLED';

CREATE TABLE world_faction_incursion_sites (
  incursion_id INTEGER NOT NULL CHECK (incursion_id > 0),
  slot_key TEXT NOT NULL CHECK (length(slot_key) BETWEEN 1 AND 32),
  stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 32),
  system_id INTEGER NOT NULL CHECK (system_id > 0),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 3),
  incarnation INTEGER NOT NULL DEFAULT 0 CHECK (incarnation >= 0),
  event_id TEXT CHECK (event_id IS NULL OR length(event_id) <= 64),
  state TEXT NOT NULL CHECK (state IN ('WAITING','OPEN','CLOSED')),
  due_at INTEGER NOT NULL CHECK (due_at >= 0),
  clears INTEGER NOT NULL DEFAULT 0 CHECK (clears >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (incursion_id, slot_key)
) STRICT, WITHOUT ROWID;
`;

function upFactionIncursions(db) {
  db.exec(DDL);
}

module.exports = { TABLE, SITES_TABLE, SITE_EVENT_PREFIX, ROW_STATE, SLOT_STATE, OUTCOME, EFFECT,
  FINAL_REPEL_REFUSALS, GENERATION, AGGREGATE, EVENT_CREATE, EVENT_SETTLE, SITE_CLEARED_STATES, SITE_ENDED_STATES,
  SEC_CLASSES, MAX_SYSTEMS_JSON, MAX_RULES_JSON, MAX_PROGRESS_JSON, idempotencyKeyOf, createKeyOf, settleKeyOf,
  repelKeyOf, huntIdOf, siteEventIdOf, slotKeyOf, parseClaimStates, parseFactionIds, upFactionIncursions,
  FACTION_TALE_ID_BASE, taleIdOf, SCENE_OF_ROLE, UI_STATE_OF_PHASE, rewardEventIdOf, sitePrefixOf, POOL_ROWS_RESERVE,
  POOL_MODE, DROP_REASON, HOLD_REASON, dropKeyOf, holdKeyOf, NEWS, newsKeyOf, CONSEQUENCES_MODE };
