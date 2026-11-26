"use strict";

const TABLE_NAME = "world_virtual_identities";

const AGGREGATE = "virtual_identity";

const IDENTITY_KINDS = Object.freeze({
  ALLIANCE: "alliance",
  CORPORATION: "corporation",
  CHARACTER: "character",
});

const IDENTITY_STATES = Object.freeze({
  PLANNED: "planned",
  RESERVED: "reserved",
  CREATED: "created",
  LINKED: "linked",
  REFUSED: "refused",
  RELEASED: "released",
});

const EVENT_IDENTITY_CREATED = "IDENTITY_CREATED";
const EVENT_IDENTITY_LINKED = "IDENTITY_LINKED";
const EVENT_IDENTITY_REFUSED = "IDENTITY_REFUSED";

function foundingOpOf(identityKey) {
  return `lne:v1:${identityKey}`;
}

const OWNER_KINDS = Object.freeze({
  FACTION: "faction",
  CAPSULEER: "capsuleer",
  CIVILIAN: "civilian",
  FREE: "free",
  OUTLAW: "outlaw",
});

const FLEET_OWNER_KINDS = Object.freeze([OWNER_KINDS.FACTION, OWNER_KINDS.CAPSULEER]);

const OWNER_PREFIXES = Object.freeze({ faction: "f", capsuleer: "c", civilian: "v", free: "i", outlaw: "o" });
const PREFIX_OWNER = Object.freeze({ f: "faction", c: "capsuleer", v: "civilian", i: "free", o: "outlaw" });

function identityKeyForOwnerAlliance(prefix, ownerId) {
  return `${prefix}:${ownerId}:alliance`;
}

function identityKeyForOwnerCorporation(prefix, ownerId, slot) {
  return `${prefix}:${ownerId}:corp:${slot}`;
}

function identityKeyForOwnerCharacter(prefix, ownerId, slot, n) {
  return `${prefix}:${ownerId}:corp:${slot}:char:${n}`;
}

function identityKeyForAlliance(factionId) {
  return identityKeyForOwnerAlliance(OWNER_PREFIXES.faction, factionId);
}

function identityKeyForCorporation(factionId, slot) {
  return identityKeyForOwnerCorporation(OWNER_PREFIXES.faction, factionId, slot);
}

function identityKeyForCharacter(factionId, slot, n) {
  return identityKeyForOwnerCharacter(OWNER_PREFIXES.faction, factionId, slot, n);
}

function parseIdentityKey(key) {
  const parts = key.split(":");
  if (parts.length < 3 || !Object.prototype.hasOwnProperty.call(PREFIX_OWNER, parts[0])) return null;
  const ownerPrefix = parts[0];
  const factionId = parseInt(parts[1], 10);
  if (!Number.isInteger(factionId) || factionId <= 0) return null;

  if (parts[2] === "alliance") {
    return { type: "alliance", factionId, ownerPrefix };
  }
  if (parts[2] === "corp") {
    const slot = parseInt(parts[3], 10);
    if (!Number.isInteger(slot) || slot < 0) return null;
    if (parts[4] === "char") {
      const n = parseInt(parts[5], 10);
      if (!Number.isInteger(n) || n < 0) return null;
      return { type: "character", factionId, slot, n, ownerPrefix };
    }
    return { type: "corporation", factionId, slot, ownerPrefix };
  }
  return null;
}

const MAX_NAME_LENGTH = 64;
const MAX_TICKER_LENGTH = 5;
const MAX_IDENTITY_KEY_LENGTH = 128;
const MAX_FOUNDING_OP_LENGTH = 200;
const MAX_REASON_LENGTH = 64;
const MAX_KIND_LENGTH = 16;
const MAX_OWNER_KIND_LENGTH = 16;
const MAX_STATE_LENGTH = 16;

const REASON_INVALID_AT = "VC_INVALID_AT";
function isValidAt(at) {
  return Number.isSafeInteger(at) && at >= 0;
}
function atOfClock(clock) {
  return clock && typeof clock.now === "function" ? clock.now() : undefined;
}

function upVirtualIdentities(db) {
  db.exec(`CREATE TABLE ${TABLE_NAME} (
    identity_key   TEXT    PRIMARY KEY NOT NULL CHECK (length(identity_key) BETWEEN 1 AND ${MAX_IDENTITY_KEY_LENGTH}),
    kind           TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
    owner_kind     TEXT    NOT NULL CHECK (length(owner_kind) BETWEEN 1 AND 16),
    owner_id       INTEGER NOT NULL CHECK (owner_id > 0),
    state          TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    evejs_id       INTEGER CHECK (evejs_id IS NULL OR evejs_id > 0),
    founding_op    TEXT    NOT NULL UNIQUE CHECK (length(founding_op) BETWEEN 1 AND ${MAX_FOUNDING_OP_LENGTH}),
    name           TEXT    CHECK (name IS NULL OR length(name) BETWEEN 1 AND ${MAX_NAME_LENGTH}),
    ticker         TEXT    CHECK (ticker IS NULL OR length(ticker) BETWEEN 2 AND ${MAX_TICKER_LENGTH}),
    race_id        INTEGER CHECK (race_id IS NULL OR race_id > 0),
    bloodline_id   INTEGER CHECK (bloodline_id IS NULL OR bloodline_id > 0),
    gender         TEXT    CHECK (gender IS NULL OR length(gender) BETWEEN 1 AND 16),
    station_id     INTEGER CHECK (station_id IS NULL OR station_id > 0),
    system_id      INTEGER CHECK (system_id IS NULL OR system_id > 0),
    constellation_id INTEGER CHECK (constellation_id IS NULL OR constellation_id > 0),
    region_id      INTEGER CHECK (region_id IS NULL OR region_id > 0),
    security_rating REAL,
    reason         TEXT    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND ${MAX_REASON_LENGTH}),
    created_at     INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at     INTEGER NOT NULL CHECK (updated_at >= 0),
    version        INTEGER NOT NULL CHECK (version >= 1),
    lne_version    INTEGER NOT NULL DEFAULT 1 CHECK (lne_version >= 1)
  ) STRICT;

  CREATE INDEX ${TABLE_NAME}_owner ON ${TABLE_NAME} (owner_kind, owner_id);
  CREATE INDEX ${TABLE_NAME}_evejs_id ON ${TABLE_NAME} (kind, evejs_id) WHERE evejs_id IS NOT NULL;`);
}

module.exports = {
  TABLE_NAME,
  AGGREGATE,
  IDENTITY_KINDS,
  IDENTITY_STATES,
  EVENT_IDENTITY_CREATED,
  EVENT_IDENTITY_LINKED,
  EVENT_IDENTITY_REFUSED,
  foundingOpOf,
  identityKeyForAlliance,
  identityKeyForCorporation,
  identityKeyForCharacter,
  parseIdentityKey,
  OWNER_KINDS,
  FLEET_OWNER_KINDS,
  OWNER_PREFIXES,
  identityKeyForOwnerAlliance,
  identityKeyForOwnerCorporation,
  identityKeyForOwnerCharacter,
  MAX_NAME_LENGTH,
  MAX_TICKER_LENGTH,
  MAX_IDENTITY_KEY_LENGTH,
  MAX_FOUNDING_OP_LENGTH,
  MAX_REASON_LENGTH,
  MAX_KIND_LENGTH,
  MAX_OWNER_KIND_LENGTH,
  MAX_STATE_LENGTH,
  REASON_INVALID_AT,
  isValidAt,
  atOfClock,
  upVirtualIdentities,
};