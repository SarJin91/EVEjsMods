"use strict";

const TABLE_NAME = "world_sov_structures";
const STEP_EVENT_TYPE = "SOV_STRUCTURE_STEP";
const STEP_AGGREGATE = "sov_structure";

const ANCHORING = "ANCHORING";
const ONLINE = "ONLINE";
const DESTROYED = "DESTROYED";
const ENDED = "ENDED";
const STATES = Object.freeze([ANCHORING, ONLINE, DESTROYED, ENDED]);
const LIVE_STATES = Object.freeze([ANCHORING, ONLINE]);
const TERMINAL_STATES = Object.freeze([DESTROYED, ENDED]);
const LIVE_SQL = "('ANCHORING','ONLINE')";

const ANCHORED = "ANCHORED";
const GRANDFATHERED = "GRANDFATHERED";
const ORIGINS = Object.freeze([ANCHORED, GRANDFATHERED]);

const REASON = Object.freeze({
  SIEGE: "SIEGE",
  LIVE_KILL: "LIVE_KILL",
  FIELD_LOST: "FIELD_LOST",
  CLAIM_LOST: "CLAIM_LOST",
  ABANDONED: "ABANDONED",
  CONTROL_LOST: "CONTROL_LOST",
});
const END_REASONS = Object.freeze(Object.values(REASON));

const OP = Object.freeze({ ANCHOR: "ANCHOR", END: "END", DESTROY: "DESTROY", BIND: "BIND", ATTACK: "ATTACK",
  LIFT: "LIFT" });

const OUTCOME = Object.freeze({ APPLIED: "APPLIED", DUPLICATE: "DUPLICATE", REFUSED: "REFUSED", STALE: "STALE" });

const CODES = Object.freeze({
  FOREIGN: "SOV_FOREIGN_STRUCTURE",
  ATTEMPTS: "SOV_ATTEMPTS",
  LIMIT_FACTION: "SOV_LIMIT_FACTION",
  LIMIT_TOTAL: "SOV_LIMIT_TOTAL",
  TRANSITION_DENIED: "SOV_TRANSITION_DENIED",
});

const NOTES = Object.freeze({
  FOREIGN: "SOV_FOREIGN_STRUCTURE",
  ANCHOR_REQUESTED: "SOV_ANCHOR_REQUESTED",
  ANCHORING: "SOV_ANCHORING",
  ANCHOR_UNFUNDED: "SOV_ANCHOR_UNFUNDED",
  SIEGE_STARTED: "SOV_SIEGE_STARTED",
  SIEGE: "SOV_SIEGE",
  SIEGE_OBSERVED: "SOV_SIEGE_OBSERVED",
  CONTROL_RELEASED: "SOV_CONTROL_RELEASED",
  ADOPT_PENDING: "SOV_ADOPT_PENDING",
});

const RECONCILE_EVENT_TYPE = "SOV_STRUCTURE_RECONCILE";
const RECONCILE_AGGREGATE_ID = "sovStructures";
const PHASE = Object.freeze({ CONTROL: "CONTROL", HEAL: "HEAL", ADOPT: "ADOPT", PRUNE: "PRUNE" });
const PHASES = Object.freeze([PHASE.CONTROL, PHASE.HEAL, PHASE.ADOPT, PHASE.PRUNE]);

const FREE_TREASURY_REASONS = Object.freeze(["TREASURY_OFF", "NO_TREASURY"]);
const UNFUNDED_TREASURY_REASONS = Object.freeze(["TREASURY_AUSTERITY", "TREASURY_INSUFFICIENT"]);

const LIVE_GAUGE = "world.sovStructures.live";

const MAX_ID_LENGTH = 64;

const structureIdOf = (systemId, factionId, claimSeq, attempt) =>
  `sovs:${systemId}:${factionId}:${claimSeq}:${attempt}`;
const grandfatheredIdOf = (systemId, factionId, capturedAt) => `sovg:${systemId}:${factionId}:${capturedAt}`;
const exemptKindsOf = (text) => (typeof text === "string"
  ? Object.freeze(text.split(",").map((k) => k.trim()).filter((k) => k.length > 0)) : Object.freeze([]));
const stepKey = (structureId) => `${structureId}:step`;
const feeKey = (structureId) => `${structureId}:fee`;
const abandonKey = (structureId) => `${structureId}:abandon`;
const reconcileKey = (bucket, phase, after) => `sovr:${bucket}:${phase}:${after}`;

function upSovStructures(db) {
  db.exec(`CREATE TABLE world_sov_structures (
    structure_id        TEXT    PRIMARY KEY CHECK (length(structure_id) BETWEEN 1 AND 64),
    system_id           INTEGER NOT NULL CHECK (system_id > 0),
    faction_id          INTEGER NOT NULL CHECK (faction_id > 0),
    origin              TEXT    NOT NULL CHECK (origin IN ('ANCHORED','GRANDFATHERED')),
    state               TEXT    NOT NULL CHECK (state IN ('ANCHORING','ONLINE','DESTROYED','ENDED')),
    end_reason          TEXT    CHECK (end_reason IS NULL OR end_reason IN
                          ('SIEGE','LIVE_KILL','FIELD_LOST','CLAIM_LOST','ABANDONED','CONTROL_LOST')),
    claim_seq           INTEGER,
    attempt             INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    claim_captured_at   INTEGER,
    cost_isk            INTEGER NOT NULL DEFAULT 0 CHECK (cost_isk >= 0),
    due_at              INTEGER,
    online_at           INTEGER,
    attacker_faction_id INTEGER,
    attack_started_at   INTEGER,
    ended_at            INTEGER,
    ended_by_faction_id INTEGER,
    evejs_item_id       INTEGER,
    physical_at         INTEGER,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    CHECK ((state IN ('ANCHORING','ONLINE')) = (end_reason IS NULL)),
    CHECK (state <> 'ANCHORING' OR due_at IS NOT NULL)
  ) STRICT;
  CREATE UNIQUE INDEX ux_sov_structures_live_system ON world_sov_structures (system_id)
    WHERE state IN ('ANCHORING','ONLINE');
  CREATE INDEX ix_sov_structures_live_faction ON world_sov_structures (faction_id, state)
    WHERE state IN ('ANCHORING','ONLINE');
  CREATE UNIQUE INDEX ux_sov_structures_epoch ON world_sov_structures (system_id, faction_id, claim_captured_at)
    WHERE claim_captured_at IS NOT NULL;
  CREATE INDEX ix_sov_structures_terminal ON world_sov_structures (updated_at)
    WHERE state IN ('DESTROYED','ENDED');`);
}

module.exports = {
  TABLE_NAME,
  STEP_EVENT_TYPE,
  STEP_AGGREGATE,
  ANCHORING,
  ONLINE,
  DESTROYED,
  ENDED,
  STATES,
  LIVE_STATES,
  TERMINAL_STATES,
  LIVE_SQL,
  ANCHORED,
  GRANDFATHERED,
  ORIGINS,
  REASON,
  END_REASONS,
  OP,
  OUTCOME,
  CODES,
  NOTES,
  FREE_TREASURY_REASONS,
  UNFUNDED_TREASURY_REASONS,
  LIVE_GAUGE,
  MAX_ID_LENGTH,
  structureIdOf,
  grandfatheredIdOf,
  exemptKindsOf,
  stepKey,
  feeKey,
  abandonKey,
  reconcileKey,
  RECONCILE_EVENT_TYPE,
  RECONCILE_AGGREGATE_ID,
  PHASE,
  PHASES,
  upSovStructures,
};
