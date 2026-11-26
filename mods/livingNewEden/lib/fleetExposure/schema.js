"use strict";

const { FLEET_ROLES } = require("../fleets/schema");

const TABLE_NAME = "world_fleet_exposures";

const DDL = `
CREATE TABLE world_fleet_exposures (
  exposure_id   TEXT    PRIMARY KEY NOT NULL CHECK (length(exposure_id) BETWEEN 1 AND 96),
  fleet_id      TEXT    NOT NULL,
  faction_id    INTEGER NOT NULL CHECK (faction_id > 0),
  kind          TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
  system_id     INTEGER NOT NULL CHECK (system_id > 0),
  operation_id  TEXT    NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 96),
  from_state    TEXT    NOT NULL CHECK (length(from_state) BETWEEN 1 AND 16),
  leg_seq       INTEGER NOT NULL CHECK (leg_seq >= 0),
  character_id  INTEGER CHECK (character_id IS NULL OR character_id > 0),
  state         TEXT    NOT NULL CHECK (state IN ('HELD','ENDED')),
  members_json  TEXT    NOT NULL CHECK (json_valid(members_json)),
  started_at    INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at      INTEGER,
  end_reason    TEXT,
  losses_json   TEXT    CHECK (losses_json IS NULL OR json_valid(losses_json)),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
  version       INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((state = 'ENDED') = (ended_at IS NOT NULL AND end_reason IS NOT NULL AND losses_json IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX world_fleet_exposures_open_fleet ON world_fleet_exposures (fleet_id) WHERE state = 'HELD';
CREATE INDEX world_fleet_exposures_state ON world_fleet_exposures (state, exposure_id);
`;

function upFleetExposures(db) {
  db.exec(DDL);
}

const EXPOSURE_STATES = Object.freeze(["HELD", "ENDED"]);
const KINDS = Object.freeze(["CONVOY", "MINER", "SENTRY", "PRESENCE"]);
const MEMBER_STATES = Object.freeze(["SPAWNED", "DESTROYED"]);
const END_REASONS = Object.freeze(["WIPED", "TARGET_GONE", "QUIET", "TIMEOUT", "SCENE_GONE", "RESTART", "DISABLED",
  "FLEET_GONE", "RETREAT", "NO_PLAYER"]);
const OUTCOMES = Object.freeze(["RELEASED", "DESTROYED"]);

const CONVOY_ROLE = "logistics";
const MINER_ROLE = "mining";
const ROLE_OF_KIND = Object.freeze({ CONVOY: CONVOY_ROLE, MINER: MINER_ROLE });
const ROLES_OF_KIND = Object.freeze({ CONVOY: Object.freeze([CONVOY_ROLE]), MINER: Object.freeze([MINER_ROLE]),
  SENTRY: Object.freeze(["invasion", "patrol", "garrison"]), PRESENCE: FLEET_ROLES });
const FROM_STATE_OF_KIND = Object.freeze({ CONVOY: "TRAVELLING", MINER: "STAGED", SENTRY: "STAGED" });
const CLAIM_STATES_OF_KIND = Object.freeze({ CONVOY: Object.freeze(["TRAVELLING"]), MINER: Object.freeze(["STAGED"]),
  SENTRY: Object.freeze(["STAGED"]), PRESENCE: Object.freeze(["IDLE", "STAGED", "TRAVELLING", "REFITTING"]) });
const HOSTILE_CLAIM_STATES_ALLOWED = Object.freeze(["IDLE", "STAGED", "REFITTING"]);
const NO_HOSTILE_CLAIM_STATES = "none";

function parseHostileClaimStates(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t === NO_HOSTILE_CLAIM_STATES) return Object.freeze([]);
  const parts = t.split(",").map((p) => p.trim());
  if (parts.some((p) => !HOSTILE_CLAIM_STATES_ALLOWED.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}
const CROSSING_STATE = "TRAVELLING";
const NO_OPERATION_ID = "-";
for (const role of Object.values(ROLES_OF_KIND).flat()) {
  if (!FLEET_ROLES.includes(role)) throw new Error(`fleetExposure/schema: unknown fleet role ${role}`);
}

const AGGREGATE = "fleet_exposure";
const EXPOSURE_ID_PREFIX = "fx:";
const MAX_EXPOSURE_ID_LENGTH = 96;

const exposureIdOf = (fleetId, fleetVersion) => `${EXPOSURE_ID_PREFIX}${fleetId}:${fleetVersion}`;
const claimKey = (id) => `fexp:${id}:claim`;
const haltKey = (id) => `fexp:${id}:halt`;
const lockKey = (id) => `fexp:${id}:lock`;
const lossKey = (id, memberKey) => `fexp:${id}:loss:${memberKey}`;
const settleKey = (id) => `fexp:${id}:settle:v1`;
const lossesKey = (id) => `fexp:${id}:losses`;
const releaseKey = (id) => `fexp:${id}:release`;

module.exports = {
  TABLE_NAME,
  upFleetExposures,
  EXPOSURE_STATES,
  KINDS,
  MEMBER_STATES,
  END_REASONS,
  OUTCOMES,
  CONVOY_ROLE,
  MINER_ROLE,
  ROLE_OF_KIND,
  ROLES_OF_KIND,
  FROM_STATE_OF_KIND,
  CLAIM_STATES_OF_KIND,
  HOSTILE_CLAIM_STATES_ALLOWED,
  parseHostileClaimStates,
  CROSSING_STATE,
  NO_OPERATION_ID,
  AGGREGATE,
  EXPOSURE_ID_PREFIX,
  MAX_EXPOSURE_ID_LENGTH,
  exposureIdOf,
  claimKey,
  haltKey,
  lockKey,
  lossKey,
  settleKey,
  lossesKey,
  releaseKey,
};
