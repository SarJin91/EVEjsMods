"use strict";

const TABLE_NAME = "world_event_sites";

const STATE = Object.freeze({
  CREATING: "CREATING",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  LOST: "LOST",
  CLEANING: "CLEANING",
  CLEANED: "CLEANED",
  PURGED: "PURGED",
  FAILED: "FAILED",
});

const LIVE_STATES = Object.freeze([STATE.CREATING, STATE.ACTIVE, STATE.COMPLETED, STATE.LOST, STATE.CLEANING,
  STATE.CLEANED]);

const VISIBLE_STATES = Object.freeze([STATE.CREATING, STATE.ACTIVE, STATE.COMPLETED, STATE.LOST]);

const FAIL_REASON = Object.freeze({
  TEMPLATE_MISSING: "TEMPLATE_MISSING",
  SYSTEM_UNKNOWN: "SYSTEM_UNKNOWN",
  SITE_FOREIGN: "SITE_FOREIGN",
  SITE_KEY_INVALID: "SITE_KEY_INVALID",
  SITE_SPEC_INVALID: "SITE_SPEC_INVALID",
  CREATE_FAILED: "CREATE_FAILED",
  SITE_ID_MISMATCH: "SITE_ID_MISMATCH",
  RECREATE_LIMIT: "RECREATE_LIMIT",
  EVENT_CANCELLED: "EVENT_CANCELLED",
});

const SITE_KIND = Object.freeze({ ANOMALY: "anomaly", SIGNATURE: "signature" });
const SITE_KINDS = Object.freeze([SITE_KIND.ANOMALY, SITE_KIND.SIGNATURE]);

const SITE_KEY_PREFIX = "lne:";
const MAX_EVENT_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 64;
const MAX_TEMPLATE_ID_LENGTH = 128;

function siteKeyOf(eventId, slot) {
  return `${SITE_KEY_PREFIX}${eventId}:${slot}`;
}

function upEventSites(db) {
  db.exec(`CREATE TABLE world_event_sites (
    site_key          TEXT    PRIMARY KEY NOT NULL CHECK (length(site_key) BETWEEN 5 AND 128),
    event_id          TEXT    NOT NULL CHECK (length(event_id) BETWEEN 1 AND 64),
    slot              INTEGER NOT NULL CHECK (slot >= 0),
    system_id         INTEGER NOT NULL CHECK (system_id > 0),
    template_id       TEXT    NOT NULL CHECK (length(template_id) BETWEEN 1 AND 128),
    label             TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
    faction_id        INTEGER CHECK (faction_id IS NULL OR faction_id > 0),
    request_hash      TEXT    NOT NULL CHECK (length(request_hash) = 64),
    state             TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 32),
    fail_reason       TEXT    CHECK (fail_reason IS NULL OR length(fail_reason) BETWEEN 1 AND 32),
    instance_id       INTEGER,
    site_id           INTEGER,
    pos_x             REAL,
    pos_y             REAL,
    pos_z             REAL,
    expires_at        INTEGER NOT NULL CHECK (expires_at >= 0),
    vendor_expires_at INTEGER,
    attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    recreate_count    INTEGER NOT NULL DEFAULT 0 CHECK (recreate_count >= 0),
    next_attempt_at   INTEGER NOT NULL CHECK (next_attempt_at >= 0),
    created_at        INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (event_id, slot)
  ) STRICT;
  CREATE INDEX world_event_sites_due ON world_event_sites (next_attempt_at)
    WHERE state NOT IN ('PURGED', 'FAILED');
  CREATE INDEX world_event_sites_system ON world_event_sites (system_id, created_at);`);
}

function upEventSitesKind(db) {
  db.exec(`ALTER TABLE world_event_sites ADD COLUMN site_kind TEXT
    CHECK (site_kind IS NULL OR length(site_kind) BETWEEN 1 AND 16);`);
}

module.exports = {
  TABLE_NAME,
  STATE,
  SITE_KIND,
  SITE_KINDS,
  upEventSitesKind,
  LIVE_STATES,
  VISIBLE_STATES,
  FAIL_REASON,
  SITE_KEY_PREFIX,
  MAX_EVENT_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_TEMPLATE_ID_LENGTH,
  siteKeyOf,
  upEventSites,
};
