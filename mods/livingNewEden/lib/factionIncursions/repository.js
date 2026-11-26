"use strict";

const S = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const COLUMNS = "incursion_id, idempotency_key, faction_id, constellation_id, sec_class, target_system_id, "
  + "claim_phase_seq, beneficiary_faction_id, strength_milli, systems_json, rules_json, rules_fingerprint, "
  + "progress_json, influence_milli, influence_updated_at, grace_minutes, decay_milli_per_hour, per_completion_milli, "
  + "hq_unlock_milli, state, created_at, mobilizing_at, withdrawing_at, expires_at, outcome, decided_at, hq_event_id, "
  + "effect, settled_at, attempts, generation, version";
const SITE_COLUMNS = "incursion_id, slot_key, stage_key, system_id, kind, tier, incarnation, event_id, state, due_at, "
  + "clears, version";

const txMissing = (tx) => !tx || tx.inTransaction !== true || typeof tx.prepare !== "function";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isMilli = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1000;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const invalid = (detail) => ({ ok: false, reason: "FACTION_INCURSION_INVALID_INPUT", detail });

function parse(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v === null || typeof v !== "object" ? fallback : v;
  } catch (_err) {
    return fallback;
  }
}

function rowOf(r) {
  return Object.freeze({ incursionId: Number(r.incursion_id), idempotencyKey: r.idempotency_key,
    factionId: Number(r.faction_id), constellationId: Number(r.constellation_id), secClass: r.sec_class,
    targetSystemId: Number(r.target_system_id), claimPhaseSeq: Number(r.claim_phase_seq),
    beneficiaryFactionId: num(r.beneficiary_faction_id), strengthMilli: Number(r.strength_milli),
    systems: parse(r.systems_json, []), rulesJson: r.rules_json, rules: parse(r.rules_json, null),
    rulesFingerprint: r.rules_fingerprint, progress: parse(r.progress_json, { stages: {}, receipts: {} }),
    influenceMilli: Number(r.influence_milli), influenceUpdatedAt: Number(r.influence_updated_at),
    graceMinutes: Number(r.grace_minutes), decayMilliPerHour: Number(r.decay_milli_per_hour),
    perCompletionMilli: Number(r.per_completion_milli), hqUnlockMilli: Number(r.hq_unlock_milli), state: r.state,
    createdAt: Number(r.created_at), mobilizingAt: Number(r.mobilizing_at), withdrawingAt: Number(r.withdrawing_at),
    expiresAt: Number(r.expires_at), outcome: r.outcome, decidedAt: num(r.decided_at), hqEventId: r.hq_event_id,
    effect: r.effect, settledAt: num(r.settled_at), attempts: Number(r.attempts), generation: Number(r.generation),
    version: Number(r.version) });
}

function siteOf(r) {
  return Object.freeze({ incursionId: Number(r.incursion_id), slotKey: r.slot_key, stageKey: r.stage_key,
    systemId: Number(r.system_id), kind: r.kind, tier: Number(r.tier), incarnation: Number(r.incarnation),
    eventId: r.event_id, state: r.state, dueAt: Number(r.due_at), clears: Number(r.clears),
    version: Number(r.version) });
}

function createFactionIncursionRepository() {
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE;
    const ST = S.SITES_TABLE;
    s = {
      get: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE incursion_id = ?`),
      byKey: db.prepare(`SELECT incursion_id FROM ${T} WHERE idempotency_key = ?`),
      listOpen: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state <> 'SETTLED' ORDER BY incursion_id LIMIT ?`),
      listState: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state <> 'SETTLED' AND state = ?
        ORDER BY incursion_id LIMIT ?`),
      listNoPoolWait: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state <> 'SETTLED' AND state = 'DECIDED'
        AND NOT (outcome = 'defeated' AND attempts < ?) ORDER BY incursion_id LIMIT ?`),
      listPoolWait: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state <> 'SETTLED' AND state = 'DECIDED'
        AND outcome = 'defeated' AND attempts < ? ORDER BY incursion_id LIMIT ?`),
      countOpen: db.prepare(`SELECT faction_id, state, constellation_id FROM ${T} WHERE state <> 'SETTLED'`),
      insert: db.prepare(`INSERT INTO ${T} (idempotency_key, faction_id, constellation_id, sec_class, target_system_id,
        claim_phase_seq, beneficiary_faction_id, strength_milli, systems_json, rules_json, rules_fingerprint,
        progress_json, influence_milli, influence_updated_at, grace_minutes, decay_milli_per_hour, per_completion_milli,
        hq_unlock_milli, state, created_at, mobilizing_at, withdrawing_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`),
      insertSite: db.prepare(`INSERT INTO ${ST} (incursion_id, slot_key, stage_key, system_id, kind, tier, state,
        due_at) VALUES (?, ?, ?, ?, ?, ?, 'WAITING', ?)`),
      sites: db.prepare(`SELECT ${SITE_COLUMNS} FROM ${ST} WHERE incursion_id = ? ORDER BY slot_key`),
      progress: db.prepare(`UPDATE ${T} SET influence_milli = ?, influence_updated_at = ?, progress_json = ?,
        version = version + 1 WHERE incursion_id = ? AND state = 'ACTIVE' AND version = ?`),
      decide: db.prepare(`UPDATE ${T} SET state = 'DECIDED', outcome = ?, decided_at = ?, hq_event_id = ?,
        influence_milli = ?, influence_updated_at = ?, progress_json = ?, version = version + 1
        WHERE incursion_id = ? AND state = 'ACTIVE' AND version = ?`),
      settle: db.prepare(`UPDATE ${T} SET state = 'SETTLED', effect = ?, settled_at = ?, version = version + 1
        WHERE incursion_id = ? AND state = 'DECIDED' AND version = ?`),
      bump: db.prepare(`UPDATE ${T} SET attempts = attempts + 1, version = version + 1
        WHERE incursion_id = ? AND state = 'DECIDED' AND version = ?`),
      site: db.prepare(`UPDATE ${ST} SET state = ?, due_at = ?, clears = ?, incarnation = ?, event_id = ?,
        version = version + 1 WHERE incursion_id = ? AND slot_key = ? AND version = ?`),
    };
    cache.set(db, s);
    return s;
  }

  function getInTx(tx, incursionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(incursionId)) return invalid("incursionId");
    const r = stmts(tx).get.get(incursionId);
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function findByKeyInTx(tx, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof idempotencyKey !== "string" || idempotencyKey === "") return invalid("idempotencyKey");
    const r = stmts(tx).byKey.get(idempotencyKey);
    return { ok: true, incursionId: r ? Number(r.incursion_id) : null };
  }

  function listOpenInTx(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!isId(o.limit)) return invalid("limit");
    if (o.state !== undefined && o.state !== S.ROW_STATE.ACTIVE && o.state !== S.ROW_STATE.DECIDED) {
      return invalid("state");
    }
    if (o.poolWait !== undefined) {
      if ((o.poolWait !== "exclude" && o.poolWait !== "only") || o.state !== S.ROW_STATE.DECIDED) {
        return invalid("poolWait");
      }
      if (!Number.isSafeInteger(o.maxAttempts) || o.maxAttempts < 0) return invalid("maxAttempts");
      const st = o.poolWait === "only" ? stmts(tx).listPoolWait : stmts(tx).listNoPoolWait;
      return { ok: true, rows: st.all(o.maxAttempts, o.limit).map(rowOf) };
    }
    const rows = o.state === undefined ? stmts(tx).listOpen.all(o.limit) : stmts(tx).listState.all(o.state, o.limit);
    return { ok: true, rows: rows.map(rowOf) };
  }

  function countOpenInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const byFaction = new Map();
    const constellations = new Set();
    let active = 0;
    let decided = 0;
    const rows = stmts(tx).countOpen.all();
    for (const r of rows) {
      const f = Number(r.faction_id);
      byFaction.set(f, (byFaction.get(f) || 0) + 1);
      constellations.add(Number(r.constellation_id));
      if (r.state === S.ROW_STATE.ACTIVE) active += 1;
      else decided += 1;
    }
    return { ok: true, count: rows.length, active, decided, byFaction, constellations };
  }

  function insertInTx(tx, spec, slots) {
    if (txMissing(tx)) return TX_REQUIRED;
    const s = spec || {};
    if (typeof s.idempotencyKey !== "string" || s.idempotencyKey.length < 1 || s.idempotencyKey.length > 96
      || !isId(s.factionId) || !isId(s.constellationId) || !S.SEC_CLASSES.includes(s.secClass)
      || !isId(s.targetSystemId) || !isTime(s.claimPhaseSeq)
      || !(s.beneficiaryFactionId === null || isId(s.beneficiaryFactionId)) || !isMilli(s.strengthMilli)
      || !isMilli(s.influenceMilli) || !isTime(s.createdAt) || !isTime(s.graceMinutes)
      || !isTime(s.decayMilliPerHour) || !isMilli(s.perCompletionMilli) || !isMilli(s.hqUnlockMilli)
      || !(isTime(s.mobilizingAt) && s.mobilizingAt >= s.createdAt) || !(isTime(s.withdrawingAt)
        && s.withdrawingAt >= s.mobilizingAt) || !(isTime(s.expiresAt) && s.expiresAt >= s.withdrawingAt)
      || typeof s.rulesFingerprint !== "string" || s.rulesFingerprint.length !== 64) {
      return invalid("spec");
    }
    if (!Array.isArray(slots) || slots.length === 0) return invalid("slots");
    const systemsJson = JSON.stringify(s.systems);
    const rulesJson = JSON.stringify(s.rules);
    const progressJson = JSON.stringify(s.progress);
    if (systemsJson.length > S.MAX_SYSTEMS_JSON) return invalid("systems");
    if (rulesJson.length > S.MAX_RULES_JSON) return invalid("rules");
    if (progressJson.length > S.MAX_PROGRESS_JSON) return invalid("progress");
    const st = stmts(tx);
    if (st.byKey.get(s.idempotencyKey)) return { ok: false, reason: "DUPLICATE" };
    const info = st.insert.run(s.idempotencyKey, s.factionId, s.constellationId, s.secClass, s.targetSystemId,
      s.claimPhaseSeq, s.beneficiaryFactionId, s.strengthMilli, systemsJson, rulesJson, s.rulesFingerprint,
      progressJson, s.influenceMilli, s.createdAt, s.graceMinutes, s.decayMilliPerHour, s.perCompletionMilli,
      s.hqUnlockMilli, s.createdAt, s.mobilizingAt, s.withdrawingAt, s.expiresAt);
    const incursionId = Number(info.lastInsertRowid);
    for (const slot of slots) {
      st.insertSite.run(incursionId, slot.slotKey, slot.stageKey, slot.systemId, slot.kind, slot.tier, s.createdAt);
    }
    return { ok: true, incursionId };
  }

  function listSitesInTx(tx, incursionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(incursionId)) return invalid("incursionId");
    return { ok: true, sites: stmts(tx).sites.all(incursionId).map(siteOf) };
  }

  const validProgressPatch = (p) => p && isMilli(p.influenceMilli) && isTime(p.influenceUpdatedAt)
    && p.progress && typeof p.progress === "object";

  function updateProgressInTx(tx, incursionId, version, patch) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(incursionId) || !isId(version) || !validProgressPatch(patch)) return invalid("patch");
    const json = JSON.stringify(patch.progress);
    if (json.length > S.MAX_PROGRESS_JSON) return invalid("progress");
    const info = stmts(tx).progress.run(patch.influenceMilli, patch.influenceUpdatedAt, json, incursionId, version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "STALE" };
  }

  function decideInTx(tx, incursionId, version, d) {
    if (txMissing(tx)) return TX_REQUIRED;
    const x = d || {};
    if (!isId(incursionId) || !isId(version) || !Object.values(S.OUTCOME).includes(x.outcome) || !isTime(x.decidedAt)
      || !(x.hqEventId === null || (typeof x.hqEventId === "string" && x.hqEventId.length <= 64))
      || !validProgressPatch(x)) {
      return invalid("decision");
    }
    const json = JSON.stringify(x.progress);
    if (json.length > S.MAX_PROGRESS_JSON) return invalid("progress");
    const info = stmts(tx).decide.run(x.outcome, x.decidedAt, x.hqEventId, x.influenceMilli, x.influenceUpdatedAt,
      json, incursionId, version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "STALE" };
  }

  function settleInTx(tx, incursionId, version, fields) {
    if (txMissing(tx)) return TX_REQUIRED;
    const f = fields || {};
    if (!isId(incursionId) || !isId(version) || typeof f.effect !== "string" || f.effect.length < 1
      || f.effect.length > 32 || !isTime(f.settledAt)) {
      return invalid("fields");
    }
    const info = stmts(tx).settle.run(f.effect, f.settledAt, incursionId, version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "STALE" };
  }

  function bumpAttemptInTx(tx, incursionId, version) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(incursionId) || !isId(version)) return invalid("incursionId");
    const info = stmts(tx).bump.run(incursionId, version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "STALE" };
  }

  function updateSiteInTx(tx, incursionId, slotKey, version, p) {
    if (txMissing(tx)) return TX_REQUIRED;
    const x = p || {};
    if (!isId(incursionId) || typeof slotKey !== "string" || !isId(version)
      || !Object.values(S.SLOT_STATE).includes(x.state) || !isTime(x.dueAt) || !isTime(x.clears)
      || !isTime(x.incarnation) || !(x.eventId === null || (typeof x.eventId === "string" && x.eventId.length <= 64))) {
      return invalid("site");
    }
    const info = stmts(tx).site.run(x.state, x.dueAt, x.clears, x.incarnation, x.eventId, incursionId, slotKey,
      version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "STALE" };
  }

  return Object.freeze({ getInTx, findByKeyInTx, listOpenInTx, countOpenInTx, insertInTx, listSitesInTx,
    updateProgressInTx, decideInTx, settleInTx, bumpAttemptInTx, updateSiteInTx });
}

module.exports = { createFactionIncursionRepository };
