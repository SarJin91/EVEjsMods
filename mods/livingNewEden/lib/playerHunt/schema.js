"use strict";

const { FLEET_ROLES, HULL_GROUPS_V1 } = require("../fleets/schema");

const TABLE_NAME = "world_player_hunts";

const DDL = `
CREATE TABLE world_player_hunts (
  hunt_id        TEXT    PRIMARY KEY NOT NULL CHECK (length(hunt_id) BETWEEN 1 AND 96),
  fleet_id       TEXT    NOT NULL,
  faction_id     INTEGER NOT NULL CHECK (faction_id > 0),
  system_id      INTEGER NOT NULL CHECK (system_id > 0),
  character_id   INTEGER NOT NULL CHECK (character_id > 0),
  mode           TEXT    NOT NULL CHECK (length(mode) BETWEEN 1 AND 16),
  state          TEXT    NOT NULL CHECK (state IN ('CLAIMED','LIVE','ENDED')),
  standing       REAL    NOT NULL,
  members_json   TEXT    NOT NULL CHECK (json_valid(members_json)),
  seed           INTEGER NOT NULL CHECK (seed >= 0),
  started_at     INTEGER NOT NULL CHECK (started_at >= 0),
  live_at        INTEGER,
  ended_at       INTEGER,
  end_reason     TEXT,
  losses_json    TEXT    CHECK (losses_json IS NULL OR json_valid(losses_json)),
  updated_at     INTEGER NOT NULL CHECK (updated_at >= 0),
  version        INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((state = 'ENDED') = (ended_at IS NOT NULL AND end_reason IS NOT NULL AND losses_json IS NOT NULL)),
  CHECK (state = 'CLAIMED' OR state = 'ENDED' OR live_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX world_player_hunts_open_fleet ON world_player_hunts (fleet_id)
  WHERE state IN ('CLAIMED','LIVE');
CREATE INDEX world_player_hunts_state ON world_player_hunts (state, hunt_id);
CREATE INDEX world_player_hunts_cooldown ON world_player_hunts (character_id, faction_id, ended_at);
CREATE INDEX world_player_hunts_system ON world_player_hunts (system_id, state);
`;

function upPlayerHunts(db) {
  db.exec(DDL);
}

const HUNT_STATES = Object.freeze(["CLAIMED", "LIVE", "ENDED"]);
const OPEN_STATES = Object.freeze(["CLAIMED", "LIVE"]);
const MODES = Object.freeze(["SWEEP", "SCAN", "PATROL", "GATE_CAMP"]);
const HUNT_MODES = Object.freeze(["SWEEP", "SCAN"]);
const COOLDOWN_EXEMPT_END_REASONS = Object.freeze(["RESTART"]);
const MEMBER_STATES = Object.freeze(["PLANNED", "SPAWNED", "DESTROYED"]);
const END_REASONS = Object.freeze(["SPAWN_FAILED", "TARGET_GONE", "TARGET_DOWN", "WIPED", "TIMEOUT", "NOT_FOUND",
  "SCENE_GONE", "RESTART", "DISABLED", "SPAWN_NOT_VISIBLE", "PURSUIT", "RETREATED", "TARGET_DOCKED", "UNOBSERVED"]);
const OUTCOMES = Object.freeze(["RELEASED", "DESTROYED"]);
const RELEASE_CONTACT_SKIP_REASONS = Object.freeze(["PURSUIT", "RETREATED"]);
const RELEASE_CONTACT_ROWS = 1;
const STANDING_CLASSES = Object.freeze(["hostile", "neutral", "friendly"]);
const FACTION_KINDS = Object.freeze(["pirate", "empire", "police", "neutral", "invader", "hive"]);
const NEUTRAL_POLICIES = Object.freeze(["hostile", "ignore"]);
const OBJECT_KINDS = Object.freeze(["stargate", "station", "asteroidBelt", "planet", "anomaly"]);

const AGGREGATE = "player_hunt";
const HUNT_ID_PREFIX = "ph:";
const MAX_HUNT_ID_LENGTH = 96;

const huntIdOf = (fleetId, fleetVersion) => `${HUNT_ID_PREFIX}${fleetId}:${fleetVersion}`;
const claimKey = (huntId) => `phunt:${huntId}:claim`;
const lockKey = (huntId) => `phunt:${huntId}:lock`;
const liveKey = (huntId) => `phunt:${huntId}:live`;
const lossKey = (huntId, memberKey) => `phunt:${huntId}:loss:${memberKey}`;
const settleKey = (huntId) => `phunt:${huntId}:settle:v1`;
const lossesKey = (huntId) => `phunt:${huntId}:losses`;
const releaseKey = (huntId) => `phunt:${huntId}:release`;
const repelKey = (huntId) => `phunt:${huntId}:repel`;
const unstageKey = (huntId) => `phunt:${huntId}:unstage`;

const PURSUIT_END_REASON = "PURSUIT";
const PURSUIT_OPERATION_TYPE = "pursuit";
const PURSUIT_OBJECTIVE = "destroy";
const SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole", "other"]);
const NO_SEC_CLASSES = "none";
const pursueKey = (huntId) => `phunt:${huntId}:pursue`;
const hopKey = (chainId, hop) => `phunt:${chainId}:hop:${hop}`;

const RETREATED_END_REASON = "RETREATED";
const EXIT_REASONS = Object.freeze(["TARGET_GONE", "TARGET_DOWN", "NOT_FOUND", "TIMEOUT", "RETREATED", "PURSUIT",
  "TARGET_DOCKED"]);
const EXIT_OBJECT_KINDS = Object.freeze(["stargate", "station"]);
const RETURN_OPERATION_TYPE = "return";
const RETURN_OBJECTIVE = "return";
const returnKey = (huntId) => `phunt:${huntId}:return`;

const TARGET_DOCKED_END_REASON = "TARGET_DOCKED";
const RETURN_REASONS = Object.freeze(["TARGET_GONE", "TARGET_DOCKED", "NOT_FOUND", "TIMEOUT", "TARGET_DOWN"]);
const homeKey = (chainId) => `phunt:${chainId}:home`;

const approachChainIdOf = (fleetId, fleetVersion) => `apr:${fleetId}:${fleetVersion}`;
const approachKey = (chainId) => `phunt:${chainId}:approach`;
const reinforceChainIdOf = (fleetId, fleetVersion) => `rnf:${fleetId}:${fleetVersion}`;

function splitList(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((p) => p.trim());
  return parts.some((p) => p === "") ? null : parts;
}

function parseNeutralPolicy(text) {
  const parts = splitList(text);
  if (parts === null) return null;
  const out = {};
  for (const part of parts) {
    const [kind, policy, extra] = part.split(":").map((p) => p.trim());
    if (extra !== undefined || !FACTION_KINDS.includes(kind) || !NEUTRAL_POLICIES.includes(policy)) return null;
    if (Object.prototype.hasOwnProperty.call(out, kind)) return null;
    out[kind] = policy;
  }
  return Object.freeze(out);
}

function parseRoleList(text) {
  const parts = splitList(text);
  if (parts === null) return null;
  if (!parts.every((p) => FLEET_ROLES.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

function parseObjectKinds(text) {
  const parts = splitList(text);
  if (parts === null) return null;
  if (!parts.every((p) => OBJECT_KINDS.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

function parseSecClassList(text) {
  if (typeof text === "string" && text.trim() === NO_SEC_CLASSES) return Object.freeze([]);
  const parts = splitList(text);
  if (parts === null) return null;
  if (!parts.every((p) => SEC_CLASSES.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

const HULL_SCALE_CLASSES = Object.freeze([...HULL_GROUPS_V1, "capsule"]);
const SCALE_MIN_SHIPS = 1;
const SCALE_MAX_SHIPS = 64;

function parseScaleTable(text) {
  const parts = splitList(text);
  if (parts === null) return null;
  const out = {};
  for (const part of parts) {
    const [cls, count, extra] = part.split(":").map((p) => p.trim());
    if (extra !== undefined || !HULL_SCALE_CLASSES.includes(cls) || !/^[0-9]+$/.test(count || "")) return null;
    const n = Number(count);
    if (!Number.isSafeInteger(n) || n < SCALE_MIN_SHIPS || n > SCALE_MAX_SHIPS) return null;
    if (Object.prototype.hasOwnProperty.call(out, cls)) return null;
    out[cls] = n;
  }
  return Object.freeze(out);
}

module.exports = {
  TABLE_NAME,
  upPlayerHunts,
  HUNT_STATES,
  OPEN_STATES,
  MODES,
  HUNT_MODES,
  COOLDOWN_EXEMPT_END_REASONS,
  MEMBER_STATES,
  END_REASONS,
  OUTCOMES,
  RELEASE_CONTACT_SKIP_REASONS,
  RELEASE_CONTACT_ROWS,
  STANDING_CLASSES,
  FACTION_KINDS,
  NEUTRAL_POLICIES,
  OBJECT_KINDS,
  AGGREGATE,
  HUNT_ID_PREFIX,
  MAX_HUNT_ID_LENGTH,
  huntIdOf,
  claimKey,
  lockKey,
  liveKey,
  lossKey,
  settleKey,
  lossesKey,
  releaseKey,
  repelKey,
  unstageKey,
  PURSUIT_END_REASON,
  PURSUIT_OPERATION_TYPE,
  PURSUIT_OBJECTIVE,
  SEC_CLASSES,
  NO_SEC_CLASSES,
  pursueKey,
  hopKey,
  RETREATED_END_REASON,
  EXIT_REASONS,
  EXIT_OBJECT_KINDS,
  RETURN_OPERATION_TYPE,
  RETURN_OBJECTIVE,
  returnKey,
  TARGET_DOCKED_END_REASON,
  RETURN_REASONS,
  homeKey,
  approachChainIdOf,
  reinforceChainIdOf,
  approachKey,
  parseNeutralPolicy,
  parseRoleList,
  parseObjectKinds,
  parseSecClassList,
  HULL_SCALE_CLASSES,
  SCALE_MIN_SHIPS,
  SCALE_MAX_SHIPS,
  parseScaleTable,
};
