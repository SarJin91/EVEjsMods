"use strict";

const { CLAIM_STATES } = require("../world/occupation/schema");

const TABLE = "world_native_incursions";
const NATIVE_FACTION_ID = 500019;
const ROW_STATE = Object.freeze({ BOUND: "BOUND", SETTLED: "SETTLED" });
const OUTCOME = Object.freeze({ DEFEATED: "defeated", EXPIRED: "expired", VANISHED: "vanished" });
const EFFECT = Object.freeze({ REPEL_APPLIED: "REPEL_APPLIED", NO_INFLUENCE: "NO_INFLUENCE", NOT_CLAIMANT: "NOT_CLAIMANT",
  REPEL_DISABLED: "REPEL_DISABLED", NO_PARTICIPANT: "NO_PARTICIPANT", RECORDED: "RECORDED", FAILED: "FAILED" });
const STEER_MODES = Object.freeze(["steer", "exclusive"]);
const BANDS = Object.freeze(["high", "low", "null"]);
const FINAL_REPEL_REFUSALS = Object.freeze(["NOT_CLAIMANT", "REPEL_DISABLED", "NO_ROW"]);
const AGGREGATE = "native_incursion";
const EVENT_BIND = "NATIVE_INCURSION_BIND";
const EVENT_SETTLE = "NATIVE_INCURSION_SETTLE";

const MAX_TALE_SYSTEMS = 4;
const DROP_REASON = "NATIVE_INCURSION_DEFEAT";
const HOLD_REASON = "NATIVE_INCURSION_HOLD";
const TARGET_DROP_EFFECTS = Object.freeze([EFFECT.REPEL_DISABLED, EFFECT.NO_PARTICIPANT]);
const RETRY_DROP_REFUSALS = Object.freeze(["OCCUPATION_STOPPED", "OCCUPATION_UNAVAILABLE"]);
const NEWS = Object.freeze({ PREFIX: "nis" });

const bindKey = (taleId, generation) => `nincursion:bind:${taleId}:g${generation}`;
const settleKey = (taleId, generation) => `nincursion:settle:${taleId}:g${generation}`;
const repelKey = (taleId, generation) => `nincursion:repel:${taleId}:g${generation}`;
const dropKey = (taleId, generation, systemId) => `nincursion:drop:${taleId}:g${generation}:${systemId}`;
const holdKey = (taleId, generation, systemId) => `nincursion:hold:${taleId}:g${generation}:${systemId}`;
const newsKeyOf = (taleId, generation) => `${NEWS.PREFIX}:${taleId}:g${generation}`;
const huntIdOf = (taleId) => `incursion:${taleId}`;

const VIEW_ID = "native-incursions";
const LAYER_ID = "layer-native-incursions";
const NOTICE_STATE = Object.freeze({ BOUND: "bound", DEFEATED: "defeated", EXPIRED: "expired" });
const noticeKeyOf = (taleId, state) => `nincursion:notice:${taleId}:${state}`;

function parseClaimStates(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const out = [];
  for (const raw of text.split(",")) {
    const name = raw.trim();
    if (!CLAIM_STATES.includes(name) || out.includes(name)) return null;
    out.push(name);
  }
  return Object.freeze(out);
}

const DDL = `
CREATE TABLE world_native_incursions (
  tale_id INTEGER PRIMARY KEY CHECK (tale_id > 0),
  generation INTEGER NOT NULL CHECK (generation > 0),
  faction_id INTEGER NOT NULL CHECK (faction_id > 0),
  constellation_id INTEGER NOT NULL CHECK (constellation_id > 0),
  security_band TEXT NOT NULL CHECK (security_band IN ('high','low','null')),
  target_system_id INTEGER NOT NULL CHECK (target_system_id > 0),
  steered INTEGER NOT NULL CHECK (steered IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('BOUND','SETTLED')),
  bound_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('defeated','expired','vanished')),
  terminal_event_id TEXT CHECK (terminal_event_id IS NULL OR length(terminal_event_id) <= 128),
  effect TEXT CHECK (effect IS NULL OR length(effect) <= 32),
  settled_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE INDEX world_native_incursions_bound ON world_native_incursions (tale_id) WHERE state = 'BOUND';
`;

function upNativeIncursions(db) {
  db.exec(DDL);
}

const REWARD_STATE = Object.freeze({ PENDING: "PENDING", PLANNED: "PLANNED", SKIPPED: "SKIPPED" });
const REWARD_REASON = Object.freeze({ TALE_NOT_FOUND: "TALE_NOT_FOUND", NOT_DEFEATED: "NOT_DEFEATED",
  NO_CONTROLLER: "NO_CONTROLLER", SANSHA_CONTROLLER: "SANSHA_CONTROLLER", NO_PARTICIPANT: "NO_PARTICIPANT",
  NO_LP_CORPORATION: "NO_LP_CORPORATION", PAYOUTS_DISABLED: "PAYOUTS_DISABLED",
  DUPLICATE: "DUPLICATE" });
const FINAL_PARTICIPANT_REFUSALS = Object.freeze([REWARD_REASON.TALE_NOT_FOUND, REWARD_REASON.NOT_DEFEATED]);
const FINAL_PAYOUT_REFUSALS = Object.freeze([REWARD_REASON.NO_LP_CORPORATION, REWARD_REASON.PAYOUTS_DISABLED]);
const EVENT_REWARD = "NATIVE_INCURSION_REWARD";
const rewardEventIdOf = (taleId, generation) => `nincursion:reward:${taleId}:g${generation}`;
const rewardRowsBound = (maxRewardedParticipants) => maxRewardedParticipants + 2;

const REWARD_DDL = `
ALTER TABLE world_native_incursions ADD COLUMN reward_state TEXT
  CHECK (reward_state IS NULL OR reward_state IN ('PENDING','PLANNED','SKIPPED'));
ALTER TABLE world_native_incursions ADD COLUMN reward_reason TEXT
  CHECK (reward_reason IS NULL OR length(reward_reason) <= 32);
CREATE INDEX world_native_incursions_reward ON world_native_incursions (tale_id) WHERE reward_state = 'PENDING';
`;

function upNativeIncursionRewards(db) {
  db.exec(REWARD_DDL);
}

module.exports = { TABLE, NATIVE_FACTION_ID, ROW_STATE, OUTCOME, EFFECT, STEER_MODES, BANDS, FINAL_REPEL_REFUSALS,
  AGGREGATE, EVENT_BIND, EVENT_SETTLE, bindKey, settleKey, repelKey, huntIdOf, parseClaimStates, upNativeIncursions,
  MAX_TALE_SYSTEMS, DROP_REASON, HOLD_REASON, TARGET_DROP_EFFECTS, RETRY_DROP_REFUSALS, NEWS, dropKey, holdKey,
  newsKeyOf, VIEW_ID, LAYER_ID, NOTICE_STATE, noticeKeyOf, REWARD_STATE, REWARD_REASON, FINAL_PARTICIPANT_REFUSALS,
  FINAL_PAYOUT_REFUSALS, EVENT_REWARD, rewardEventIdOf, rewardRowsBound, upNativeIncursionRewards };
