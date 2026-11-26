"use strict";

const { toBind } = require("../persistence/repository");
const { COOLDOWN_EVENT } = require("./cooldownSchema");
const { pairKeyOf } = require("./contacts");

const BATTLE_AGGREGATE = "battle";
const MAX_ID_LENGTH = 64;
const SPEC_KEYS = Object.freeze(["systemId", "factionA", "factionB", "untilAt", "battleId"]);

const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "COOLDOWN_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const unwrap = (r) => (r && r.reason === "APPLY_REFUSED" && r.refusal ? r.refusal : r);

function createCooldownRepository(deps) {
  const { journal, clock } = deps || {};
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("createCooldownRepository: journal");
  if (!clock || typeof clock.now !== "function") throw new TypeError("createCooldownRepository: clock.now");
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      upsert: db.prepare(`INSERT INTO battle_contact_cooldowns
        (system_id, faction_lo, faction_hi, until_at, battle_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (system_id, faction_lo, faction_hi) DO UPDATE SET until_at = max(until_at, excluded.until_at),
        battle_id = excluded.battle_id, updated_at = excluded.updated_at`),
      ofSystem: db.prepare(`SELECT faction_lo, faction_hi, until_at FROM battle_contact_cooldowns
        WHERE system_id = ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function recordInTx(tx, spec, idempotencyKey) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!spec || typeof spec !== "object" || Object.keys(spec).some((k) => !SPEC_KEYS.includes(k))) {
      return invalid("spec");
    }
    if (!isPositiveId(spec.systemId)) return invalid("systemId");
    if (!isPositiveId(spec.factionA) || !isPositiveId(spec.factionB) || spec.factionA === spec.factionB) {
      return invalid("factions");
    }
    if (!isTime(spec.untilAt)) return invalid("untilAt");
    if (typeof spec.battleId !== "string" || spec.battleId === "" || spec.battleId.length > MAX_ID_LENGTH) {
      return invalid("battleId");
    }
    const lo = Math.min(spec.factionA, spec.factionB);
    const hi = Math.max(spec.factionA, spec.factionB);
    const now = clock.now();
    if (!isTime(now)) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key: idempotencyKey, aggregate: { type: BATTLE_AGGREGATE, id: spec.battleId },
      eventType: COOLDOWN_EVENT, payload: { battleId: spec.battleId, systemId: spec.systemId, factionLo: lo,
        factionHi: hi, untilAt: spec.untilAt } }, (db) => {
      stmts(db).upsert.run(toBind(spec.systemId), toBind(lo), toBind(hi), toBind(spec.untilAt), spec.battleId,
        toBind(now));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    return { ok: true, duplicate: r.duplicate === true, untilAt: spec.untilAt };
  }

  function listForSystem(tx, systemId) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPositiveId(systemId)) return invalid("systemId");
    const cooldowns = new Map();
    for (const row of stmts(tx).ofSystem.all(toBind(systemId))) {
      cooldowns.set(pairKeyOf(row.faction_lo, row.faction_hi), row.until_at);
    }
    return { ok: true, cooldowns };
  }

  return Object.freeze({ recordInTx, listForSystem });
}

module.exports = { createCooldownRepository };
