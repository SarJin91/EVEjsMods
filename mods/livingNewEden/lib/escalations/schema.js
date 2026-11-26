"use strict";

const TABLE = "world_escalations";
const RECIPIENTS_TABLE = "world_escalation_recipients";
const KIND_LEAD = "ESCALATION_LEAD";
const MAX_ESCALATION_ID = 64;
const MAX_TEMPLATE_ID = 128;

const escalationIdOf = (instanceId, completedAtMs) => `esc:${instanceId}:${completedAtMs}`;

const DDL = `
CREATE TABLE world_escalations (
  escalation_id      TEXT PRIMARY KEY,
  source_instance_id INTEGER NOT NULL,
  source_system_id   INTEGER NOT NULL,
  source_template_id TEXT NOT NULL,
  source_faction_id  INTEGER,
  target_system_id   INTEGER NOT NULL,
  jumps              INTEGER NOT NULL,
  template_id        TEXT NOT NULL,
  ded_rating         INTEGER NOT NULL,
  site_key           TEXT NOT NULL,
  seed               INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL
);
CREATE INDEX idx_world_escalations_created ON world_escalations(created_at);
CREATE INDEX idx_world_escalations_expires ON world_escalations(expires_at);
CREATE TABLE world_escalation_recipients (
  escalation_id TEXT NOT NULL,
  character_id  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (escalation_id, character_id)
);
CREATE INDEX idx_world_escalation_recipients_char ON world_escalation_recipients(character_id, created_at);
`;

function upEscalations(db) {
  db.exec(DDL);
}

module.exports = { TABLE, RECIPIENTS_TABLE, KIND_LEAD, MAX_ESCALATION_ID, MAX_TEMPLATE_ID, escalationIdOf,
  upEscalations };
