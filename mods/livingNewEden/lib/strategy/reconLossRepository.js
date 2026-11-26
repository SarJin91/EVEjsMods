"use strict";

const { toBind } = require("../persistence/repository");
const {
  RECON_LOSS_TABLE_NAME, RECON_LOSS_AGGREGATE, EVENT_RECON_LOSS, MAX_RECON_LOSSES, MAX_KEY_LENGTH,
} = require("./schema");

const COLUMNS = "faction_id, system_id, losses, last_loss_at, cooldown_until, updated_at, version";
const LOSS_FIELDS = Object.freeze(["factionId", "systemId", "at", "lostFleets"]);
const LIMIT_KEYS = Object.freeze(["reconLossThreshold", "reconLossCooldownMs", "reconLossWindowMs",
  "reconLossMaxMultiplier", "maxReconLossRowsPerFaction"]);
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

function createReconLossRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createReconLossRepository: deps missing");
  const { journal, limits, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function") {
    throw new TypeError("createReconLossRepository: journal with applyOnce required");
  }
  for (const name of LIMIT_KEYS) {
    if (!limits || !Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`createReconLossRepository: limits.${name} must be a positive integer`);
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
    const T = RECON_LOSS_TABLE_NAME;
    s = {
      byKey: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE faction_id = ? AND system_id = ?`),
      countOf: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ?`),
      oldestDead: db.prepare(`SELECT system_id FROM ${T} WHERE faction_id = ? AND cooldown_until < ?
        AND last_loss_at < ? ORDER BY last_loss_at, system_id LIMIT 1`),
      remove: db.prepare(`DELETE FROM ${T} WHERE faction_id = ? AND system_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 1)`),
      update: db.prepare(`UPDATE ${T} SET losses = ?, last_loss_at = ?, cooldown_until = ?, updated_at = ?,
        version = version + 1 WHERE faction_id = ? AND system_id = ? AND version = ?`),
      cooldowns: db.prepare(`SELECT system_id FROM ${T} WHERE faction_id = ? AND cooldown_until > ?
        ORDER BY system_id LIMIT ?`),
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
    if (!isId(loss.lostFleets)) return "loss.lostFleets";
    return null;
  }

  function nextState(row, loss) {
    const inWindow = row !== null
      && Math.max(Number(row.last_loss_at), Number(row.cooldown_until)) >= loss.at - L.reconLossWindowMs;
    const losses = Math.min((inWindow ? Number(row.losses) : 0) + loss.lostFleets, MAX_RECON_LOSSES);
    const lastLossAt = row === null ? loss.at : Math.max(Number(row.last_loss_at), loss.at);
    const oldCooldown = row === null ? 0 : Number(row.cooldown_until);
    let cooldownUntil = oldCooldown;
    if (losses >= L.reconLossThreshold) {
      const factor = Math.min(losses - L.reconLossThreshold + 1, L.reconLossMaxMultiplier);
      cooldownUntil = Math.max(oldCooldown, lastLossAt + L.reconLossCooldownMs * factor);
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
    const result = journal.applyOnce(tx, { key, aggregate: { type: RECON_LOSS_AGGREGATE,
      id: `${loss.factionId}:${loss.systemId}` }, eventType: EVENT_RECON_LOSS, payload }, (db) => {
      const s = stmts(db);
      const row = s.byKey.get(f, sys) || null;
      const next = nextState(row, loss);
      let evicted = 0;
      if (row !== null) {
        const r = s.update.run(toBind(next.losses), toBind(next.lastLossAt), toBind(next.cooldownUntil),
          toBind(loss.at), f, sys, toBind(row.version));
        if (r.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
      } else {
        if (Number(s.countOf.get(f).n) >= L.maxReconLossRowsPerFaction) {
          const edge = toBind(loss.at - L.reconLossWindowMs);
          const dead = s.oldestDead.get(f, edge, edge);
          if (!dead) return { ok: false, reason: "RECON_LOSS_LIMIT", limit: L.maxReconLossRowsPerFaction };
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
      if (refusal.reason === "RECON_LOSS_LIMIT") count("strategy.reconLoss.limit");
      return refusal;
    }
    if (result.duplicate) {
      const row = stmts(tx).byKey.get(f, sys);
      return { ok: true, duplicate: true, evicted: 0, record: row ? toRecord(row) : null };
    }
    const v = result.value;
    count("strategy.reconLoss.recorded");
    if (v.extended) count("strategy.reconLoss.cooldowns");
    if (v.evicted === 1) count("strategy.reconLoss.evicted");
    return { ok: true, record: v.record, evicted: v.evicted };
  }

  function listCooldowns(tx, factionId, at, limit) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!isTime(at)) return invalid("at");
    if (!isId(limit)) return invalid("limit");
    const n = Math.min(limit, L.maxReconLossRowsPerFaction);
    return { ok: true, systemIds: stmts(tx).cooldowns.all(toBind(factionId), toBind(at), toBind(n))
      .map((row) => Number(row.system_id)) };
  }

  return Object.freeze({ recordLossInTx, listCooldowns, limits: L });
}

module.exports = { createReconLossRepository };
