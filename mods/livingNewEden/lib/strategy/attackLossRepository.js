"use strict";

const { toBind } = require("../persistence/repository");
const {
  ATTACK_LOSS_TABLE_NAME, ATTACK_LOSS_AGGREGATE, EVENT_ATTACK_LOSS, MAX_ATTACK_LOSSES, MAX_KEY_LENGTH,
} = require("./schema");

const COLUMNS = "faction_id, system_id, losses, last_loss_at, cooldown_until, updated_at, version";
const LOSS_FIELDS = Object.freeze(["factionId", "systemId", "at", "lostAttacks"]);
const LIMIT_KEYS = Object.freeze(["attackLossThreshold", "attackLossCooldownMs", "attackLossWindowMs",
  "attackLossMaxMultiplier", "maxAttackLossRowsPerFaction"]);
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

function toRecord(row) {
  return Object.freeze({
    losses: Number(row.losses),
    lastLossAt: Number(row.last_loss_at),
    cooldownUntil: Number(row.cooldown_until),
  });
}

function createAttackLossRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createAttackLossRepository: deps missing");
  const { journal, limits, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function") {
    throw new TypeError("createAttackLossRepository: journal with applyOnce required");
  }
  for (const name of LIMIT_KEYS) {
    if (!limits || !Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`createAttackLossRepository: limits.${name} must be a positive integer`);
    }
  }
  const L = Object.freeze(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k]])));
  const count = (name) => {
    if (typeof onCount !== "function") return;
    try {
      onCount(name, 1);
    } catch (_err) {
    }
  };

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const T = ATTACK_LOSS_TABLE_NAME;
    s = {
      byKey: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE faction_id = ? AND system_id = ?`),
      countOf: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ?`),
      oldestDead: db.prepare(`SELECT system_id FROM ${T} WHERE faction_id = ? AND cooldown_until < ?
        AND last_loss_at < ? ORDER BY last_loss_at, system_id LIMIT 1`),
      remove: db.prepare(`DELETE FROM ${T} WHERE faction_id = ? AND system_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 1)`),
      update: db.prepare(`UPDATE ${T} SET losses = ?, last_loss_at = ?, cooldown_until = ?, updated_at = ?,
        version = version + 1 WHERE faction_id = ? AND system_id = ? AND version = ?`),
      active: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE faction_id = ? AND (cooldown_until > ?
        OR last_loss_at >= ?) ORDER BY system_id LIMIT ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function validate(loss) {
    if (!isPlainObject(loss)) return "loss";
    for (const key of Object.keys(loss)) if (!LOSS_FIELDS.includes(key)) return `loss.${key}`;
    if (!isId(loss.factionId)) return "loss.factionId";
    if (!isId(loss.systemId)) return "loss.systemId";
    if (!isTime(loss.at)) return "loss.at";
    if (!isId(loss.lostAttacks)) return "loss.lostAttacks";
    return null;
  }

  function nextState(row, loss) {
    const inWindow = row !== null
      && Math.max(Number(row.last_loss_at), Number(row.cooldown_until)) >= loss.at - L.attackLossWindowMs;
    const losses = Math.min((inWindow ? Number(row.losses) : 0) + loss.lostAttacks, MAX_ATTACK_LOSSES);
    const lastLossAt = row === null ? loss.at : Math.max(Number(row.last_loss_at), loss.at);
    const oldCooldown = row === null ? 0 : Number(row.cooldown_until);
    let cooldownUntil = oldCooldown;
    if (losses >= L.attackLossThreshold) {
      const factor = Math.min(losses - L.attackLossThreshold + 1, L.attackLossMaxMultiplier);
      cooldownUntil = Math.max(oldCooldown, lastLossAt + L.attackLossCooldownMs * factor);
    }
    return { losses, lastLossAt, cooldownUntil, extended: cooldownUntil > oldCooldown };
  }

  function recordLossInTx(tx, loss, key) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    const bad = validate(loss);
    if (bad !== null) return invalid(bad);
    if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY_LENGTH) return invalid("key");
    const payload = Object.fromEntries(LOSS_FIELDS.map((k) => [k, loss[k]]));
    const f = toBind(loss.factionId);
    const sys = toBind(loss.systemId);
    const result = journal.applyOnce(tx, { key, aggregate: { type: ATTACK_LOSS_AGGREGATE,
      id: `${loss.factionId}:${loss.systemId}` }, eventType: EVENT_ATTACK_LOSS, payload }, (db) => {
      const s = stmts(db);
      const row = s.byKey.get(f, sys) || null;
      const next = nextState(row, loss);
      let evicted = 0;
      if (row !== null) {
        const r = s.update.run(toBind(next.losses), toBind(next.lastLossAt), toBind(next.cooldownUntil),
          toBind(loss.at), f, sys, toBind(row.version));
        if (r.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
      } else {
        if (Number(s.countOf.get(f).n) >= L.maxAttackLossRowsPerFaction) {
          const edge = toBind(loss.at - L.attackLossWindowMs);
          const dead = s.oldestDead.get(f, edge, edge);
          if (!dead) return { ok: false, reason: "ATTACK_LOSS_LIMIT", limit: L.maxAttackLossRowsPerFaction };
          s.remove.run(f, dead.system_id);
          evicted = 1;
        }
        s.insert.run(f, sys, toBind(next.losses), toBind(next.lastLossAt), toBind(next.cooldownUntil),
          toBind(loss.at));
      }
      return { ok: true, record: toRecord(s.byKey.get(f, sys)), evicted, extended: next.extended };
    });
    if (!result.ok) {
      const refusal = result.reason === "APPLY_REFUSED" ? result.refusal : result;
      if (refusal.reason === "ATTACK_LOSS_LIMIT") count("strategy.attackLoss.limit");
      return refusal;
    }
    if (result.duplicate) {
      const row = stmts(tx).byKey.get(f, sys);
      return { ok: true, duplicate: true, evicted: 0, record: row ? toRecord(row) : null };
    }
    const v = result.value;
    count("strategy.attackLoss.recorded");
    if (v.extended) count("strategy.attackLoss.cooldowns");
    if (v.evicted === 1) count("strategy.attackLoss.evicted");
    return { ok: true, record: v.record, evicted: v.evicted };
  }

  function listActive(tx, factionId, at, limit) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!isTime(at)) return invalid("at");
    if (!isId(limit)) return invalid("limit");
    const n = Math.min(limit, L.maxAttackLossRowsPerFaction);
    const rows = stmts(tx).active.all(toBind(factionId), toBind(at), toBind(at - L.attackLossWindowMs), toBind(n));
    return { ok: true, records: rows.map((row) => Object.freeze({ systemId: Number(row.system_id),
      ...toRecord(row) })) };
  }

  return Object.freeze({ recordLossInTx, listActive, limits: L });
}

module.exports = { createAttackLossRepository };
