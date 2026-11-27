"use strict";

const assert = require("node:assert");

const { SCHEMA } = require("../../config");
const { seasonsSettingsOf } = require("../../lib/seasons/schema");
const { createJournal } = require("../../lib/persistence/journal");
const { createAbortSentinel } = require("../../lib/persistence/store");

const HOUR = 3600000;
const T0 = 1763600000000;
const ROLLBACK = createAbortSentinel("test.seasons.ROLLBACK");

function settingsOf(over) {
  const raw = Object.fromEntries(SCHEMA.filter((r) => r.key.startsWith("seasons."))
    .map((r) => [r.key.slice("seasons.".length), r.default]));
  const parsed = seasonsSettingsOf({ seasons: { ...raw, enabled: true, ...(over || {}) } });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
}

function fakeScheduler() {
  const events = new Map();
  const handlers = new Map();
  let registerCalls = 0;
  return {
    events,
    handlers,
    registerCalls: () => registerCalls,
    getStatus: () => ({ state: "ready" }),
    registerHandler(type, fn) {
      registerCalls += 1;
      handlers.set(type, fn);
      return { ok: true, unregister() { handlers.delete(type); } };
    },
    enqueue(eventType, aggregateId, dueAt, payload, idempotencyKey) {
      const seen = events.get(idempotencyKey);
      if (seen) {
        return JSON.stringify(seen.payload) === JSON.stringify(payload)
          ? { ok: true, duplicate: true, state: seen.state || "QUEUED" }
          : { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
      }
      events.set(idempotencyKey, { eventType, aggregateId, dueAt, payload, key: idempotencyKey });
      return { ok: true, duplicate: false };
    },
  };
}

function runEvent(store, scheduler, fn, ev, now) {
  const res = fn(ev, { now, lateMs: Math.max(0, now - ev.dueAt), catchUp: false, anchorAt: ev.dueAt });
  assert.ok(res && typeof res === "object", "handler result");
  if (res.ok !== true) return { res, value: undefined, committed: false };
  let value;
  if (typeof res.effect === "function" || res.reschedule) {
    const t = store.transaction("test.seasons.event", (tx) => {
      if (typeof res.effect === "function") {
        value = res.effect(tx, ev);
        if (value && value.ok === false) throw ROLLBACK;
      }
      if (res.reschedule) {
        const n = res.reschedule;
        const r = scheduler.enqueue(n.eventType, n.aggregateId, n.dueAt, n.payload, n.idempotencyKey, { tx });
        if (!r.ok) throw ROLLBACK;
      }
      return true;
    });
    if (!t.ok) return { res, value, committed: false };
  }
  if (typeof res.onCommitted === "function") res.onCommitted(value);
  return { res, value, committed: true };
}

function journalOf(clock) {
  return createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
}

function tx(store, fn) {
  const r = store.transaction("test.seasons", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function insertFaction(db, factionId, status) {
  db.prepare(`INSERT INTO world_factions (faction_id, status, home_system_id, doctrine_id, resource_units,
    reserve_units, front_limit, registry_version, last_review_at, created_at, updated_at, version)
    VALUES (?, ?, NULL, 'test', 0, 0, 0, 1, NULL, 0, 0, 1)
    ON CONFLICT (faction_id) DO UPDATE SET status = excluded.status`).run(factionId, status);
}

function insertSystem(db, systemId, controllerId) {
  db.prepare(`INSERT INTO world_system_state (system_id, security_class, controller_faction_id, occupation_state,
    threat_level, last_state_change_at, next_strategy_review_at, updated_at, version)
    VALUES (?, 'nullsec', ?, 'STABLE', 0, 0, NULL, 0, 1)`).run(systemId, controllerId);
}

function insertInvasion(db, invasionId, factionId, endReason, round) {
  db.prepare(`INSERT INTO world_invasions (invasion_id, idempotency_key, roll_round, faction_id, profile_id,
    beachhead_system_id, capture_range_jumps, state, open, step_seq, withdraw_round, fleet_ids_json, plan_json,
    started_at, withdraw_at, ended_at, end_reason, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, 'test', 30000001, 0, 'ENDED', 0, 0, 0, '[]', '{}', 0, NULL, 1, ?, 0, 0, 1)`)
    .run(invasionId, `inv:test:${invasionId}`, round, factionId, endReason);
}

function journalRow(db, journal, key, type, id, eventType, payload) {
  const r = journal.applyOnce(db, { key, aggregate: { type, id }, eventType, payload }, () => ({ ok: true }));
  assert.ok(r.ok, JSON.stringify(r));
}

function eventOf(scheduler, key) {
  const ev = scheduler.events.get(key);
  assert.ok(ev, `event ${key} (have ${[...scheduler.events.keys()].join(", ")})`);
  return ev;
}

function stubKind(kind, over) {
  return { kind, owner: "test", version: 1, weight: 10, journalAggregates: ["battle"],
    propose: () => ({ ok: true, crisis: { factionId: null, regionIds: [], params: {} } }),
    scoreEntries: () => ({ defense: 0, crisis: 0 }), ...(over || {}) };
}

module.exports = { HOUR, T0, settingsOf, fakeScheduler, runEvent, journalOf, tx, insertFaction, insertSystem,
  insertInvasion, journalRow, eventOf, stubKind };
