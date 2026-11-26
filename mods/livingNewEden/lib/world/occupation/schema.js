"use strict";

const EVENT_TYPE = "OCCUPATION_PHASE_CHANGE";

const STABLE = "STABLE";
const RECON = "RECON";
const CONTESTED = "CONTESTED";
const INVASION = "INVASION";
const OCCUPIED = "OCCUPIED";
const CONSOLIDATING = "CONSOLIDATING";
const OCCUPATION_STATES = Object.freeze([STABLE, RECON, CONTESTED, INVASION, OCCUPIED, CONSOLIDATING]);
const CLAIM_STATES = Object.freeze([RECON, CONTESTED, INVASION]);
const HELD_STATES = Object.freeze([OCCUPIED, CONSOLIDATING]);
const BUSY_STATES = Object.freeze([CONTESTED, INVASION]);

const SIGNALS = Object.freeze(["RECON", "INVASION"]);
const TRIGGER_TICK = "tick";
const TRIGGER_BATTLE = "battle";

const STANDING_FLEET_STATES = Object.freeze(["IDLE", "PLANNED", "STAGED", "REFITTING", "MATERIALIZED"]);
const GARRISON_ROLE = "garrison";

const OCCUPATION_ROWS_BASE = 4;
const rowsBound = (maxFactionsPerSystem) => OCCUPATION_ROWS_BASE + maxFactionsPerSystem;

const MS_PER_HOUR = 3600000;
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const SCORE_DECIMALS = 100;

function round2(value) {
  const v = Math.round(value * SCORE_DECIMALS) / SCORE_DECIMALS;
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, v));
}

const tickKey = (systemId, seq, intervalMs, bucket) => `occ:${systemId}:${seq}:t:${intervalMs}:${bucket}`;
const battleKey = (systemId, seq, battleId) => `occ:${systemId}:${seq}:b:${battleId}`;

const TRIGGER_REPEL = "repel";
const repelKey = (systemId, seq, huntId) => `occ:${systemId}:${seq}:r:${huntId}`;
const sovNudgeKey = (systemId, seq, structureId) => `occ:${systemId}:${seq}:s:${structureId}`;
const REPEL_STATES_ALLOWED = Object.freeze([RECON, CONTESTED, INVASION]);
const REPEL_STATES_NONE = "none";

function parseRepelStates(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === REPEL_STATES_NONE) return Object.freeze([]);
  const out = [];
  for (const raw of trimmed.split(",")) {
    const name = raw.trim();
    if (!REPEL_STATES_ALLOWED.includes(name) || out.includes(name)) return null;
    out.push(name);
  }
  return Object.freeze(out);
}

function upOccupation(db) {
  db.exec(`ALTER TABLE world_system_state ADD COLUMN occupier_faction_id INTEGER
    CHECK (occupier_faction_id IS NULL OR occupier_faction_id > 0);
  ALTER TABLE world_system_state ADD COLUMN previous_controller_faction_id INTEGER
    CHECK (previous_controller_faction_id IS NULL OR previous_controller_faction_id > 0);
  ALTER TABLE world_system_state ADD COLUMN phase_seq INTEGER NOT NULL DEFAULT 0 CHECK (phase_seq >= 0);
  ALTER TABLE world_system_state ADD COLUMN phase_due_at INTEGER CHECK (phase_due_at IS NULL OR phase_due_at >= 0);
  ALTER TABLE world_system_state ADD COLUMN influence_evaluated_at INTEGER
    CHECK (influence_evaluated_at IS NULL OR influence_evaluated_at >= 0);
  ALTER TABLE world_system_state ADD COLUMN captured_at INTEGER CHECK (captured_at IS NULL OR captured_at >= 0);
  ALTER TABLE world_system_state ADD COLUMN detached_since_at INTEGER
    CHECK (detached_since_at IS NULL OR detached_since_at >= 0);
  CREATE INDEX world_system_state_controller ON world_system_state (controller_faction_id, system_id)
    WHERE controller_faction_id IS NOT NULL;
  CREATE INDEX world_system_state_occupier ON world_system_state (occupier_faction_id, system_id)
    WHERE occupier_faction_id IS NOT NULL;
  CREATE INDEX world_system_state_active ON world_system_state (system_id) WHERE occupation_state <> 'STABLE';`);
}

function upHomeFaction(db) {
  db.exec(`ALTER TABLE world_system_state ADD COLUMN home_faction_id INTEGER
    CHECK (home_faction_id IS NULL OR home_faction_id > 0);
  UPDATE world_system_state SET home_faction_id = controller_faction_id WHERE captured_at IS NULL;
  UPDATE world_system_state SET home_faction_id = previous_controller_faction_id WHERE captured_at IS NOT NULL;
  CREATE INDEX world_system_state_lost_home ON world_system_state (home_faction_id, system_id)
    WHERE home_faction_id IS NOT NULL
      AND (controller_faction_id IS NULL OR controller_faction_id <> home_faction_id);`);
}

module.exports = {
  EVENT_TYPE,
  STABLE,
  RECON,
  CONTESTED,
  INVASION,
  OCCUPIED,
  CONSOLIDATING,
  OCCUPATION_STATES,
  CLAIM_STATES,
  HELD_STATES,
  BUSY_STATES,
  SIGNALS,
  TRIGGER_TICK,
  TRIGGER_BATTLE,
  STANDING_FLEET_STATES,
  GARRISON_ROLE,
  OCCUPATION_ROWS_BASE,
  rowsBound,
  MS_PER_HOUR,
  SCORE_MIN,
  SCORE_MAX,
  SCORE_DECIMALS,
  round2,
  tickKey,
  battleKey,
  TRIGGER_REPEL,
  repelKey,
  sovNudgeKey,
  REPEL_STATES_ALLOWED,
  parseRepelStates,
  upOccupation,
  upHomeFaction,
};