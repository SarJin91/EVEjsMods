"use strict";

const TABLE = "world_post_sightings";
const EVENT_TYPE = "LISTENING_POST_SIGHTING";
const KEY_PREFIX = "lpost:";
const KIND = "listening_post";
const SIZE_CLASSES = Object.freeze(["small", "medium", "large"]);
const MAX_FLEET_ID = 64;
const MAX_FLEET_ROLE = 32;
const MAX_CHECK = 15;

const COUNTER_NAMES = Object.freeze(["legsSeen", "sightingsQueued", "listenerBudgetPass", "enqueueRefused",
  "listenerErrors", "sightings", "duplicates", "noPost", "stale", "staleLegChanged", "chainQueued", "noticesQueued",
  "recipientsUnavailable", "pruned", "markersServed", "off", "watchRefreshes", "noticesOff", "noticesRefused",
  "watchErrors", "watchNoGraph", "markersRefused"]);
const NOTICE_KIND = "LP_SIGHTING";
const NOTICE_KIND_LARGE = "LP_SIGHTING_LARGE";
const MAX_QUERY_SYSTEMS = 1024;
const STALE_REASONS = Object.freeze(["FLEET_GONE", "LEG_CHANGED", "ROUTE_CHANGED"]);

const sightingKey = (systemId, fleetId, legSeq) => `${KEY_PREFIX}${systemId}:x:${fleetId}:${legSeq}`;
const noticeKey = (systemId, fleetId, legSeq) => `lp:${systemId}:${fleetId}:${legSeq}`;

function upPostSightings(db) {
  db.exec(`CREATE TABLE world_post_sightings (
    sighting_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id       INTEGER NOT NULL CHECK (system_id > 0),
    fleet_id        TEXT    NOT NULL CHECK (length(fleet_id) BETWEEN 1 AND 64),
    leg_seq         INTEGER NOT NULL CHECK (leg_seq >= 0),
    system_index    INTEGER NOT NULL CHECK (system_index >= 0),
    faction_id      INTEGER NOT NULL CHECK (faction_id > 0),
    fleet_role      TEXT    NOT NULL CHECK (length(fleet_role) BETWEEN 1 AND 32),
    size_class      TEXT    NOT NULL CHECK (size_class IN ('small','medium','large')),
    from_system_id  INTEGER CHECK (from_system_id IS NULL OR from_system_id > 0),
    to_system_id    INTEGER CHECK (to_system_id IS NULL OR to_system_id > 0),
    seen_at         INTEGER NOT NULL CHECK (seen_at >= 0),
    created_at      INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (system_id, fleet_id, leg_seq)
  ) STRICT`);
  db.exec("CREATE INDEX world_post_sightings_system ON world_post_sightings (system_id, seen_at)");
  db.exec("CREATE INDEX world_post_sightings_seen ON world_post_sightings (seen_at)");
}

module.exports = { TABLE, EVENT_TYPE, KEY_PREFIX, KIND, SIZE_CLASSES, MAX_FLEET_ID, MAX_FLEET_ROLE, MAX_CHECK,
  COUNTER_NAMES, STALE_REASONS, NOTICE_KIND, NOTICE_KIND_LARGE, MAX_QUERY_SYSTEMS, sightingKey, noticeKey,
  upPostSightings };
