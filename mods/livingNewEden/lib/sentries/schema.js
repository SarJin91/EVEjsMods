"use strict";

const TABLE_NAME = "world_sentries";
const AGGREGATE = "world_sentry";
const EVENT_ANCHORED = "SENTRY_ANCHORED";
const EVENT_STATE = "SENTRY_STATE";
const EVENT_ADOPTED = "SENTRY_ADOPTED";
const RECONCILE_EVENT_TYPE = "SENTRY_RECONCILE";
const RECONCILE_AGGREGATE_ID = "sentries";
const EVENT_BUILD_REQUESTED = "SENTRY_BUILD_REQUESTED";
const DEPLOY_EVENT_TYPE = "SENTRY_DEPLOY";
const ATTRITION_EVENT_TYPE = "SENTRY_ATTRITION";
const FACTION_ID_HEX = 40;

const PENDING_DEPLOY = "PENDING_DEPLOY";
const ACTIVE = "ACTIVE";
const DESTROYED = "DESTROYED";
const RETIRED = "RETIRED";
const CANCELLED = "CANCELLED";
const STATES = Object.freeze([PENDING_DEPLOY, ACTIVE, DESTROYED, RETIRED, CANCELLED]);
const LIVE_STATES = Object.freeze([PENDING_DEPLOY, ACTIVE]);
const END_STATES = Object.freeze([DESTROYED, RETIRED, CANCELLED]);
const SPACE_ANCHOR = "space";
const ANCHOR_KINDS = Object.freeze(["gate", "station", "structure", SPACE_ANCHOR]);
const OWNER_KINDS = Object.freeze(["player", "faction"]);

const TRANSITIONS = Object.freeze({
  PENDING_DEPLOY: Object.freeze([ACTIVE, CANCELLED]),
  ACTIVE: Object.freeze([RETIRED, DESTROYED]),
  RETIRED: Object.freeze([ACTIVE]),
  DESTROYED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

const END_REASONS = Object.freeze(["VANISHED", "UNANCHORED", "VENDOR_REFUSED", "LIVE_KILL", "PROXY_KILL", "ATTRITION",
  "DEPLOY_FAILED", "BATTLE"]);
const REANCHORED = "REANCHORED";

const LIVE_END_REASONS = Object.freeze(["LIVE_KILL", "PROXY_KILL", "ATTRITION", "BATTLE"]);

const CODES = Object.freeze({
  NO_ANCHOR: "SENTRY_NO_ANCHOR",
  TOO_CLOSE: "SENTRY_TOO_CLOSE",
  LIMIT: "SENTRY_LIMIT",
  HIGHSEC: "SENTRY_HIGHSEC",
  NOT_ARMED: "SENTRY_NOT_ARMED",
  POLICY_FAILED: "SENTRY_POLICY_FAILED",
  DISABLED: "SENTRY_DISABLED",
  KIND_DISABLED: "SENTRY_KIND_DISABLED",
  KIND_SEC: "SENTRY_KIND_SEC",
});

const MAX_ID_LENGTH = 64;

function messagesOf(settings) {
  const km = (m) => String(Math.round(Number(m) / 1000));
  const player = settings && settings.player && typeof settings.player === "object" ? settings.player : {};
  const free = player.freeEnabled === true
    ? ` Or anchor it at least ${km(Math.max(Number(player.freeClearanceM) || 0,
      Number(settings.anchorMinDistanceM) || 0))} km from every stargate, station and structure.`
    : "";
  return Object.freeze({
    SENTRY_NO_ANCHOR: `Anchor the sentry ${km(settings.anchorMinDistanceM)}-${km(settings.anchorMaxDistanceM)} km `
      + `from a stargate, an NPC station or your corporation's Upwell structure.${free}`,
    SENTRY_TOO_CLOSE: "Another sentry is anchored too close.",
    SENTRY_LIMIT: "Sentry limit reached (per anchor, per system, per corporation or server-wide).",
    SENTRY_HIGHSEC: "Sentries cannot be anchored in high-security space.",
    SENTRY_NOT_ARMED: "The sentry is still arming.",
    SENTRY_POLICY_FAILED: "The sentry could not be anchored right now. Try again.",
    SENTRY_DISABLED: "Sentries are not available right now.",
    SENTRY_KIND_DISABLED: "Listening posts are not available right now.",
    SENTRY_KIND_SEC: "A listening post cannot be anchored in this security class (by default low-security and "
      + "null-security space only).",
  });
}

const playerSentryId = (itemId) => `sp-${itemId}`;
const adoptedSentryId = (itemId) => `sa-${itemId}`;
const insertKey = (sentryId, createdAt) => `sentry:${sentryId}:${createdAt}:new`;
const stateKey = (sentryId, createdAt, version) => `sentry:${sentryId}:${createdAt}:v${version}`;
const reconcileKey = (bucket) => `sentry:reconcile:${bucket}`;
const factionSentryId = (hex) => `sf-${String(hex).slice(0, FACTION_ID_HEX)}`;
const deployKey = (sentryId) => `sentry:deploy:${sentryId}`;
const attritionKey = (systemId, round) => `sattr:${systemId}:${round}`;
const attritionJournalKey = (systemId, round) => `sentry:attrition:${systemId}:${round}`;
const battleKey = (systemId, round) => `${attritionKey(systemId, round)}:battle`;
const battleJournalKey = (battleId) => `sentry:battle:${battleId}`;
const FORTRESS_SENTRY_PREFIX = "zf:";
const TRANSIT_PICKET_PREFIX = "tp:";
const WORLD_BOSS_PREFIX = "wb:";
const VIRTUAL_DEFENSE_PREFIXES = Object.freeze([FORTRESS_SENTRY_PREFIX, TRANSIT_PICKET_PREFIX, WORLD_BOSS_PREFIX]);
const BATTLE_FLEET_STATES = Object.freeze(["STAGED", "IDLE"]);
const SENTRY_BATTLE_ROWS_BOUND = 2;

function upSentries(db) {
  db.exec(`CREATE TABLE world_sentries (
    sentry_id                TEXT    PRIMARY KEY NOT NULL CHECK (length(sentry_id) BETWEEN 1 AND 64),
    owner_kind               TEXT    NOT NULL CHECK (owner_kind IN ('player', 'faction')),
    faction_id               INTEGER CHECK (faction_id IS NULL OR faction_id > 0),
    owner_corp_id            INTEGER NOT NULL CHECK (owner_corp_id > 0),
    anchored_by_character_id INTEGER CHECK (anchored_by_character_id IS NULL OR anchored_by_character_id > 0),
    item_id                  INTEGER CHECK (item_id IS NULL OR item_id > 0),
    type_id                  INTEGER NOT NULL CHECK (type_id > 0),
    system_id                INTEGER NOT NULL CHECK (system_id > 0),
    anchor_kind              TEXT    NOT NULL CHECK (anchor_kind IN ('gate', 'station', 'structure')),
    anchor_id                INTEGER NOT NULL CHECK (anchor_id > 0),
    slot                     INTEGER NOT NULL DEFAULT 0 CHECK (slot >= 0),
    state                    TEXT    NOT NULL CHECK (state IN ('PENDING_DEPLOY', 'ACTIVE', 'DESTROYED', 'RETIRED',
                                                               'CANCELLED')),
    armed_at                 INTEGER CHECK (armed_at IS NULL OR armed_at >= 0),
    cost_isk                 INTEGER NOT NULL DEFAULT 0 CHECK (cost_isk >= 0),
    ammo_grants              INTEGER NOT NULL DEFAULT 0 CHECK (ammo_grants >= 0),
    end_reason               TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at               INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at               INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at                 INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (item_id IS NOT NULL OR state IN ('PENDING_DEPLOY', 'CANCELLED'))
  ) STRICT;
  CREATE UNIQUE INDEX world_sentries_item ON world_sentries (item_id) WHERE item_id IS NOT NULL;
  CREATE INDEX world_sentries_system ON world_sentries (system_id, state);
  CREATE INDEX world_sentries_owner ON world_sentries (owner_corp_id, state);
  CREATE INDEX world_sentries_faction ON world_sentries (faction_id, state);
  CREATE INDEX world_sentries_anchor ON world_sentries (anchor_kind, anchor_id, state);
  CREATE INDEX world_sentries_ended ON world_sentries (state, ended_at);`);
}

function upSentriesSpaceAnchor(db) {
  const cols = "sentry_id, owner_kind, faction_id, owner_corp_id, anchored_by_character_id, item_id, type_id, "
    + "system_id, anchor_kind, anchor_id, slot, state, armed_at, cost_isk, ammo_grants, end_reason, created_at, "
    + "updated_at, ended_at, version";
  db.exec(`CREATE TABLE world_sentries_v113 (
    sentry_id                TEXT    PRIMARY KEY NOT NULL CHECK (length(sentry_id) BETWEEN 1 AND 64),
    owner_kind               TEXT    NOT NULL CHECK (owner_kind IN ('player', 'faction')),
    faction_id               INTEGER CHECK (faction_id IS NULL OR faction_id > 0),
    owner_corp_id            INTEGER NOT NULL CHECK (owner_corp_id > 0),
    anchored_by_character_id INTEGER CHECK (anchored_by_character_id IS NULL OR anchored_by_character_id > 0),
    item_id                  INTEGER CHECK (item_id IS NULL OR item_id > 0),
    type_id                  INTEGER NOT NULL CHECK (type_id > 0),
    system_id                INTEGER NOT NULL CHECK (system_id > 0),
    anchor_kind              TEXT    NOT NULL CHECK (anchor_kind IN ('gate', 'station', 'structure', 'space')),
    anchor_id                INTEGER NOT NULL CHECK (anchor_id > 0),
    slot                     INTEGER NOT NULL DEFAULT 0 CHECK (slot >= 0),
    state                    TEXT    NOT NULL CHECK (state IN ('PENDING_DEPLOY', 'ACTIVE', 'DESTROYED', 'RETIRED',
                                                               'CANCELLED')),
    armed_at                 INTEGER CHECK (armed_at IS NULL OR armed_at >= 0),
    cost_isk                 INTEGER NOT NULL DEFAULT 0 CHECK (cost_isk >= 0),
    ammo_grants              INTEGER NOT NULL DEFAULT 0 CHECK (ammo_grants >= 0),
    end_reason               TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at               INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at               INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at                 INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (item_id IS NOT NULL OR state IN ('PENDING_DEPLOY', 'CANCELLED'))
  ) STRICT;
  INSERT INTO world_sentries_v113 (${cols}) SELECT ${cols} FROM world_sentries;
  DROP TABLE world_sentries;
  ALTER TABLE world_sentries_v113 RENAME TO world_sentries;
  CREATE UNIQUE INDEX world_sentries_item ON world_sentries (item_id) WHERE item_id IS NOT NULL;
  CREATE INDEX world_sentries_system ON world_sentries (system_id, state);
  CREATE INDEX world_sentries_owner ON world_sentries (owner_corp_id, state);
  CREATE INDEX world_sentries_faction ON world_sentries (faction_id, state);
  CREATE INDEX world_sentries_anchor ON world_sentries (anchor_kind, anchor_id, state);
  CREATE INDEX world_sentries_ended ON world_sentries (state, ended_at);`);
}

module.exports = {
  TABLE_NAME,
  AGGREGATE,
  EVENT_ANCHORED,
  EVENT_STATE,
  EVENT_ADOPTED,
  RECONCILE_EVENT_TYPE,
  RECONCILE_AGGREGATE_ID,
  EVENT_BUILD_REQUESTED,
  DEPLOY_EVENT_TYPE,
  ATTRITION_EVENT_TYPE,
  PENDING_DEPLOY,
  ACTIVE,
  DESTROYED,
  RETIRED,
  CANCELLED,
  STATES,
  LIVE_STATES,
  END_STATES,
  ANCHOR_KINDS,
  SPACE_ANCHOR,
  OWNER_KINDS,
  TRANSITIONS,
  END_REASONS,
  REANCHORED,
  CODES,
  MAX_ID_LENGTH,
  messagesOf,
  playerSentryId,
  adoptedSentryId,
  insertKey,
  stateKey,
  reconcileKey,
  factionSentryId,
  deployKey,
  attritionKey,
  attritionJournalKey,
  battleKey,
  battleJournalKey,
  FORTRESS_SENTRY_PREFIX,
  TRANSIT_PICKET_PREFIX,
  WORLD_BOSS_PREFIX,
  VIRTUAL_DEFENSE_PREFIXES,
  BATTLE_FLEET_STATES,
  SENTRY_BATTLE_ROWS_BOUND,
  LIVE_END_REASONS,
  upSentries,
  upSentriesSpaceAnchor,
};
