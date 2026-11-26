"use strict";

const ITEMS_TABLE = "world_notice_items";
const BATCHES_TABLE = "world_notice_batches";

const DDL = `
CREATE TABLE world_notice_items (
  item_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key    TEXT    NOT NULL CHECK (length(event_key) BETWEEN 1 AND 160),
  character_id INTEGER NOT NULL CHECK (character_id > 0),
  kind         TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
  system_id    INTEGER NOT NULL CHECK (system_id >= 0),
  line         TEXT    NOT NULL CHECK (length(line) BETWEEN 1 AND 400),
  state        TEXT    NOT NULL CHECK (state IN ('PENDING','SENDING','SENT','EXPIRED','DROPPED','FAILED')),
  batch_key    TEXT    CHECK (batch_key IS NULL OR length(batch_key) BETWEEN 1 AND 64),
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  event_at     INTEGER NOT NULL CHECK (event_at >= 0),
  created_at   INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at   INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (state <> 'SENDING' OR batch_key IS NOT NULL),
  UNIQUE (event_key, character_id)
) STRICT;
CREATE INDEX world_notice_items_pending ON world_notice_items (character_id, item_id) WHERE state = 'PENDING';
CREATE INDEX world_notice_items_batch ON world_notice_items (batch_key) WHERE batch_key IS NOT NULL;
CREATE INDEX world_notice_items_system ON world_notice_items (system_id, kind, event_at);
CREATE INDEX world_notice_items_done ON world_notice_items (updated_at)
  WHERE state IN ('SENT','EXPIRED','DROPPED','FAILED');

CREATE TABLE world_notice_batches (
  batch_key    TEXT    PRIMARY KEY NOT NULL CHECK (length(batch_key) BETWEEN 1 AND 64),
  character_id INTEGER NOT NULL CHECK (character_id > 0),
  sender_id    INTEGER NOT NULL CHECK (sender_id > 0),
  state        TEXT    NOT NULL CHECK (state IN ('SENDING','SENT','FAILED','LOST')),
  sent_date    TEXT    NOT NULL CHECK (length(sent_date) BETWEEN 1 AND 24),
  title        TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 150),
  items        INTEGER NOT NULL CHECK (items >= 1),
  attempt      INTEGER NOT NULL CHECK (attempt >= 1),
  message_id   INTEGER CHECK (message_id IS NULL OR message_id > 0),
  error        TEXT    CHECK (error IS NULL OR length(error) <= 200),
  created_at   INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at   INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;
CREATE INDEX world_notice_batches_char ON world_notice_batches (character_id, created_at);
CREATE INDEX world_notice_batches_sending ON world_notice_batches (created_at) WHERE state = 'SENDING';
`;

function upNotices(db) {
  db.exec(DDL);
}

const ITEM_STATE = Object.freeze({ PENDING: "PENDING", SENDING: "SENDING", SENT: "SENT", EXPIRED: "EXPIRED",
  DROPPED: "DROPPED", FAILED: "FAILED" });
const BATCH_STATE = Object.freeze({ SENDING: "SENDING", SENT: "SENT", FAILED: "FAILED", LOST: "LOST" });
const FINISH_OUTCOMES = Object.freeze([BATCH_STATE.SENT, BATCH_STATE.FAILED, BATCH_STATE.LOST]);
const ITEM_TERMINAL_SQL = "('SENT','EXPIRED','DROPPED','FAILED')";
const BATCH_TERMINAL_SQL = "('SENT','FAILED','LOST')";

const MAX_EVENT_KEY = 160;
const MAX_KIND = 32;
const MAX_LINE = 400;
const MAX_BATCH_KEY = 64;
const MAX_TITLE = 150;
const MAX_ERROR = 200;
const KIND_PLAYER_IMPACT = "PLAYER_IMPACT";
const KIND_HUNT_WARNING = "HUNT_WARNING";

const FILETIME_SCALE = 10000n;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;

const MAX_PRIORITY_KINDS = 16;
const PRIORITY_KIND_RE = /^[A-Z][A-Z0-9_]*$/;

function parsePriorityKinds(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t === "" || t === "none") return [];
  const parts = t.split(",").map((p) => p.trim());
  if (parts.length > MAX_PRIORITY_KINDS || new Set(parts).size !== parts.length) return null;
  const bad = (p) => p.length > MAX_KIND || !PRIORITY_KIND_RE.test(p) || p === KIND_HUNT_WARNING;
  return parts.some(bad) ? null : parts;
}

const batchKeyOf = (characterId, createdAt) => `b:${characterId}:${createdAt}`;

function filetimeOf(ms) {
  return (BigInt(ms) * FILETIME_SCALE + FILETIME_EPOCH_OFFSET).toString();
}

module.exports = {
  ITEMS_TABLE,
  BATCHES_TABLE,
  upNotices,
  ITEM_STATE,
  BATCH_STATE,
  FINISH_OUTCOMES,
  ITEM_TERMINAL_SQL,
  BATCH_TERMINAL_SQL,
  MAX_EVENT_KEY,
  MAX_KIND,
  MAX_LINE,
  MAX_BATCH_KEY,
  MAX_TITLE,
  MAX_ERROR,
  KIND_PLAYER_IMPACT,
  KIND_HUNT_WARNING,
  MAX_PRIORITY_KINDS,
  parsePriorityKinds,
  batchKeyOf,
  filetimeOf,
};
