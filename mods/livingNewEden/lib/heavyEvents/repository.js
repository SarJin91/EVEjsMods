"use strict";

const { toBind } = require("../persistence/repository");
const S = require("./schema");
const P = require("./power/schema");
const W = require("./world/schema");
const { isWorldVariant } = require("./world/catalog");
const { LAYER, layerOfEventId, layerIdRange } = require("./layer");
const { canTransition } = require("./machine");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const MAX_ID_LENGTH = 64;
const MAX_STATION_ID_LENGTH = 128;
const PERMILLE_MAX = 1000;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const nullOr = (check) => (v) => v === null || check(v);
const isJsonList = (v) => Array.isArray(v);
const isJsonObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const PATCH = Object.freeze({
  phase: ["phase", isCount],
  scaleSteps: ["scale_steps", isCount],
  members: ["members_json", isJsonList, (v) => JSON.stringify(v)],
  funded: ["funded", (v) => typeof v === "boolean", (v) => (v ? 1 : 0)],
  integrity: ["integrity", nullOr((v) => Number.isSafeInteger(v) && v >= 0 && v <= PERMILLE_MAX)],
  expiresAt: ["expires_at", isTime],
  dueAt: ["due_at", nullOr(isTime)],
  engagedAt: ["engaged_at", nullOr(isTime)],
  endedAt: ["ended_at", nullOr(isTime)],
  endReason: ["end_reason", nullOr((v) => S.END_REASONS.includes(v))],
  abandons: ["abandons", isCount],
  rewardState: ["reward_state", (v) => S.REWARD_STATES.includes(v)],
  rewardAttempts: ["reward_attempts", isCount],
  cleanupAt: ["cleanup_at", nullOr(isTime)],
  siteReleased: ["site_released", (v) => typeof v === "boolean", (v) => (v ? 1 : 0)],
  result: ["result_json", isJsonObject, (v) => JSON.stringify(v)],
  pocket: ["pocket", isCount],
});

const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

function typesOf(list) {
  if (!Array.isArray(list) || list.length === 0 || !list.every((t) => S.EVENT_TYPES.includes(t))) return null;
  const out = [...new Set(list)].sort();
  return out.length === list.length ? out : null;
}
const marks = (list) => list.map(() => "?").join(", ");
function cached(db, s, sql) {
  if (!s.filtered.has(sql)) s.filtered.set(sql, db.prepare(sql));
  return s.filtered.get(sql);
}
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const num = (v) => (v === null || v === undefined ? null : Number(v));

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value === null || typeof value !== "object" ? fallback : value;
  } catch (_err) {
    return fallback;
  }
}

function toEvent(r) {
  if (!r) return null;
  const members = parseJson(r.members_json, []);
  const result = parseJson(r.result_json, {});
  return Object.freeze({
    eventId: r.event_id, planKey: r.plan_key, eventType: r.event_type, tier: Number(r.tier),
    systemId: Number(r.system_id), factionId: Number(r.faction_id), beneficiaryFactionId: num(r.beneficiary_faction_id),
    stationId: r.station_id === null ? null : r.station_id, state: r.state, open: Number(r.open) === 1,
    phase: Number(r.phase), scaleSteps: Number(r.scale_steps), members: Array.isArray(members) ? members : [],
    funded: Number(r.funded) === 1, integrity: num(r.integrity), seed: Number(r.seed), createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at), dueAt: num(r.due_at), engagedAt: num(r.engaged_at), endedAt: num(r.ended_at),
    endReason: r.end_reason === null ? null : r.end_reason, abandons: Number(r.abandons), rewardState: r.reward_state,
    rewardAttempts: Number(r.reward_attempts), cleanupAt: num(r.cleanup_at), siteReleased: Number(r.site_released) === 1,
    result: Array.isArray(result) ? {} : result, updatedAt: Number(r.updated_at), version: Number(r.version),
    variant: r.variant === undefined || r.variant === null ? null : r.variant,
    affix: r.affix === undefined || r.affix === null ? null : r.affix,
    pocket: r.pocket === undefined || r.pocket === null ? 0 : Number(r.pocket),
  });
}

function openAfter(to, siteReleased) {
  if (!S.TERMINAL_STATES.includes(to)) return 1;
  return to === S.STATE.COMPLETED && !siteReleased ? 1 : 0;
}

function validMember(m) {
  return Boolean(m && typeof m === "object" && typeof m.key === "string" && m.key !== ""
    && typeof m.hullGroup === "string" && S.MEMBER_STATES.includes(m.state));
}

function validPlan(spec) {
  if (!spec || typeof spec !== "object") return "spec";
  if (!isText(spec.eventId, MAX_ID_LENGTH) || /\s/.test(spec.eventId)) return "eventId";
  if (!isText(spec.planKey, 96)) return "planKey";
  if (!S.EVENT_TYPES.includes(spec.eventType)) return "eventType";
  const power = P.isPowerType(spec.eventType);
  const variant = spec.variant === undefined ? null : spec.variant;
  const affix = spec.affix === undefined ? null : spec.affix;
  const layer = layerOfEventId(spec.eventId);
  const world = power && (layer === LAYER.WORLD || layer === LAYER.INCURSION) && isWorldVariant(spec.eventType, variant);
  if (power ? !(P.VARIANTS[spec.eventType].includes(variant) || world) : variant !== null) return "variant";
  if (power ? !(world ? affix === W.AFFIX_NONE : P.AFFIXES.includes(affix)) : affix !== null) return "affix";
  if (!Number.isSafeInteger(spec.tier) || spec.tier < 1 || spec.tier > S.TIER_COUNT) return "tier";
  if (!isId(spec.systemId)) return "systemId";
  if (!isId(spec.factionId)) return "factionId";
  if (spec.beneficiaryFactionId !== null && !isId(spec.beneficiaryFactionId)) return "beneficiaryFactionId";
  if (spec.stationId !== null && !isText(spec.stationId, MAX_STATION_ID_LENGTH)) return "stationId";
  if (!Array.isArray(spec.members) || spec.members.length === 0 || !spec.members.every(validMember)) return "members";
  if (typeof spec.funded !== "boolean") return "funded";
  if (spec.integrity !== null && !(Number.isSafeInteger(spec.integrity) && spec.integrity >= 0
    && spec.integrity <= PERMILLE_MAX)) return "integrity";
  if (!isCount(spec.seed)) return "seed";
  if (!isTime(spec.at)) return "at";
  if (!isTime(spec.expiresAt) || spec.expiresAt <= spec.at) return "expiresAt";
  if (spec.dueAt !== null && !isTime(spec.dueAt)) return "dueAt";
  return null;
}

function createHeavyEventRepository(deps) {
  const journal = deps && deps.journal;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("heavyEventRepository: journal");
  }
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = S.TABLE;
    s = {
      updates: new Map(),
      filtered: new Map(),
      byId: db.prepare(`SELECT * FROM ${T} WHERE event_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (event_id, plan_key, event_type, tier, system_id, faction_id,
        beneficiary_faction_id, station_id, state, open, phase, scale_steps, members_json, funded, integrity, seed,
        created_at, expires_at, due_at, engaged_at, ended_at, end_reason, abandons, reward_state, reward_attempts,
        cleanup_at, site_released, result_json, updated_at, version, variant, affix, pocket)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, 0, NULL, 0, '{}', ?, 1,
        ?, ?, 0)`),
      byPlanKey: db.prepare(`SELECT event_id FROM ${T} WHERE plan_key = ?`),
      listOpen: db.prepare(`SELECT * FROM ${T} WHERE open = 1 ORDER BY event_id LIMIT ?`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE open = 1 AND state IN (?, ?, ?)`),
      countOpenAny: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE open = 1`),
      countFaction: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE open = 1 AND faction_id = ?
        AND state IN (?, ?, ?)`),
      countSystem: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE open = 1 AND system_id = ?`),
      countType: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE open = 1 AND event_type = ? AND state IN (?, ?, ?)`),
      lastEnded: db.prepare(`SELECT max(ended_at) AS t FROM ${T} WHERE system_id = ? AND ended_at IS NOT NULL`),
      pruneIds: db.prepare(`SELECT event_id FROM ${T} WHERE state IN (?, ?, ?, ?) AND ended_at < ? AND open = 0
        ORDER BY ended_at, event_id LIMIT ?`),
      remove: db.prepare(`DELETE FROM ${T} WHERE event_id = ? AND open = 0`),
      listEnded: db.prepare(`SELECT * FROM ${T} WHERE state IN (?, ?, ?, ?) AND ended_at IS NOT NULL AND open = 0
        ORDER BY ended_at DESC, event_id LIMIT ?`),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" && result.refusal ? result.refusal : result);
  const LIMIT = S.LIMIT_STATES;

  function planInTx(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = validPlan(spec);
    if (bad) return invalid(bad);
    const payload = { eventId: spec.eventId, planKey: spec.planKey, eventType: spec.eventType, tier: spec.tier,
      systemId: spec.systemId, factionId: spec.factionId, beneficiaryFactionId: spec.beneficiaryFactionId,
      stationId: spec.stationId, funded: spec.funded, seed: spec.seed, members: spec.members.length };
    const variant = spec.variant === undefined ? null : spec.variant;
    const affix = spec.affix === undefined ? null : spec.affix;
    if (P.isPowerType(spec.eventType)) Object.assign(payload, { variant, affix });
    const r = journal.applyOnce(tx, { key: S.planJournalKeyOf(spec.eventId),
      aggregate: { type: S.AGGREGATE, id: spec.eventId }, eventType: S.EVENT_PLANNED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(spec.eventId)) return { ok: false, reason: "EVENT_EXISTS" };
      if (s.byPlanKey.get(spec.planKey)) return { ok: false, reason: "PLAN_KEY_TAKEN" };
      s.insert.run(spec.eventId, spec.planKey, spec.eventType, toBind(spec.tier), toBind(spec.systemId),
        toBind(spec.factionId), spec.beneficiaryFactionId === null ? null : toBind(spec.beneficiaryFactionId),
        spec.stationId, S.STATE.PLANNED, toBind(S.FIRST_PHASE - 1), JSON.stringify(spec.members),
        toBind(spec.funded ? 1 : 0), spec.integrity === null ? null : toBind(spec.integrity), toBind(spec.seed),
        toBind(spec.at), toBind(spec.expiresAt), spec.dueAt === null ? null : toBind(spec.dueAt),
        S.REWARD_STATE.NONE, toBind(spec.at), variant, affix);
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    return r.duplicate ? { ok: true, eventId: spec.eventId, duplicate: true } : { ok: true, eventId: spec.eventId };
  }

  function casUpdate(db, change, sets, values, extra) {
    const s = stmts(db);
    const row = s.byId.get(change.eventId);
    if (!row) return { ok: false, reason: "NOT_FOUND" };
    if (change.from !== undefined && row.state !== change.from) {
      return { ok: false, reason: "VERSION_CONFLICT", detail: `state ${row.state}` };
    }
    if (Number(row.version) !== change.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
        actualVersion: Number(row.version) };
    }
    const all = [...sets, "updated_at = ?", "version = version + 1"];
    const sql = `UPDATE ${S.TABLE} SET ${all.join(", ")} WHERE event_id = ? AND version = ?`;
    if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
    s.updates.get(sql).run(...values, toBind(change.at), change.eventId, toBind(change.expectedVersion));
    return { ok: true, row: toEvent(s.byId.get(change.eventId)), ...(extra || {}) };
  }

  const validChange = (c) => Boolean(c && isText(c.eventId, MAX_ID_LENGTH) && isId(c.expectedVersion)
    && isTime(c.at));

  function transitionInTx(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!validChange(change)) return invalid("change");
    const edge = canTransition(change.from, change.to);
    if (!edge.ok) return { ok: false, reason: edge.reason === "UNKNOWN_STATE" ? "INVALID_INPUT" : edge.reason,
      detail: `${change.from}->${change.to}` };
    const patch = change.patch && typeof change.patch === "object" ? change.patch : {};
    const reason = change.reason === undefined ? null : change.reason;
    if (reason !== null && !S.END_REASONS.includes(reason)) return invalid("reason");
    const sets = [];
    const values = [];
    for (const k of Object.keys(patch).sort()) {
      const spec = PATCH[k];
      if (!spec || !spec[1](patch[k])) return invalid(`patch.${k}`);
      sets.push(`${spec[0]} = ?`);
      const v = spec[2] ? spec[2](patch[k]) : patch[k];
      values.push(typeof v === "number" ? toBind(v) : v);
    }
    const s = stmts(tx);
    const current = s.byId.get(change.eventId);
    if (!current) return { ok: false, reason: "NOT_FOUND" };
    const phase = patch.phase !== undefined ? patch.phase : Number(current.phase);
    const released = patch.siteReleased !== undefined ? patch.siteReleased : Number(current.site_released) === 1;
    sets.push("state = ?", "open = ?");
    values.push(change.to, toBind(openAfter(change.to, released)));
    const key = `${S.transitionKeyOf(change.eventId, change.from, change.to, Number(current.phase))}`
      + `:${change.expectedVersion}`;
    const payload = { eventId: change.eventId, from: change.from, to: change.to, phase, reason,
      fields: Object.keys(patch).sort() };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: change.eventId },
      eventType: S.EVENT_TRANSITION, payload }, (db) => casUpdate(db, change, sets, values));
    if (!r.ok) return unwrap(r);
    if (r.duplicate) return { ok: true, duplicate: true, row: toEvent(s.byId.get(change.eventId)) };
    return { ok: true, row: r.value.row };
  }

  function recordLossesInTx(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!validChange(change) || !Array.isArray(change.memberKeys) || change.memberKeys.length === 0
      || !change.memberKeys.every((k) => typeof k === "string" && k !== "")) {
      return invalid("change");
    }
    const s = stmts(tx);
    const current = s.byId.get(change.eventId);
    if (!current) return { ok: false, reason: "NOT_FOUND" };
    const keys = [...new Set(change.memberKeys)].sort();
    const phase = Number(current.phase);
    const r = journal.applyOnce(tx, { key: `${S.lossKeyOf(change.eventId, phase, change.expectedVersion)}`,
      aggregate: { type: S.AGGREGATE, id: change.eventId }, eventType: S.EVENT_LOSSES,
      payload: { eventId: change.eventId, phase, memberKeys: keys } }, (db) => {
      const row = stmts(db).byId.get(change.eventId);
      const members = parseJson(row.members_json, []);
      if (!Array.isArray(members)) return { ok: false, reason: "INVALID_INPUT", detail: "members_json" };
      let lost = 0;
      const next = members.map((m) => {
        if (!m || m.state !== S.MEMBER_STATE.RESERVED || !keys.includes(m.key)) return m;
        lost += 1;
        return { ...m, state: S.MEMBER_STATE.DESTROYED };
      });
      return casUpdate(db, change, ["members_json = ?"], [JSON.stringify(next)], { lost });
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) return { ok: true, duplicate: true, lost: 0, row: toEvent(s.byId.get(change.eventId)) };
    return { ok: true, row: r.value.row, lost: r.value.lost };
  }

  function releaseSiteInTx(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!validChange(change)) return invalid("change");
    const s = stmts(tx);
    const r = journal.applyOnce(tx, { key: S.releaseKeyOf(change.eventId),
      aggregate: { type: S.AGGREGATE, id: change.eventId }, eventType: S.EVENT_RELEASED,
      payload: { eventId: change.eventId } }, (db) => {
      const row = stmts(db).byId.get(change.eventId);
      if (!row) return { ok: false, reason: "NOT_FOUND" };
      if (row.state !== S.STATE.COMPLETED) return { ok: false, reason: "TRANSITION_NOT_ALLOWED", detail: row.state };
      return casUpdate(db, { ...change, from: S.STATE.COMPLETED }, ["site_released = ?", "open = ?"],
        [toBind(1), toBind(0)]);
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) return { ok: true, duplicate: true, row: toEvent(s.byId.get(change.eventId)) };
    return { ok: true, row: r.value.row };
  }

  function rewardAttemptInTx(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!validChange(change)) return invalid("change");
    const s = stmts(tx);
    const r = journal.applyOnce(tx, { key: S.rewardAttemptKeyOf(change.eventId, change.expectedVersion),
      aggregate: { type: S.AGGREGATE, id: change.eventId }, eventType: S.EVENT_REWARD_ATTEMPT,
      payload: { eventId: change.eventId } }, (db) => casUpdate(db, { ...change, from: S.STATE.CLEARED },
      ["reward_attempts = reward_attempts + 1"], []));
    if (!r.ok) return unwrap(r);
    if (r.duplicate) return { ok: true, duplicate: true, row: toEvent(s.byId.get(change.eventId)) };
    return { ok: true, row: r.value.row };
  }

  function listOpenInTx(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const limit = opts && isId(opts.limit) ? Math.min(opts.limit, S.OPEN_SCAN_LIMIT) : null;
    if (limit === null) return invalid("limit");
    const rows = stmts(tx).listOpen.all(toBind(limit + 1));
    return { ok: true, rows: rows.slice(0, limit).map(toEvent), truncated: rows.length > limit };
  }

  function getInTx(tx, eventId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(eventId, MAX_ID_LENGTH)) return invalid("eventId");
    return { ok: true, row: toEvent(stmts(tx).byId.get(eventId)) };
  }

  function countOpenInTx(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    const s = stmts(tx);
    let row;
    if (o.types !== undefined) {
      const types = typesOf(o.types);
      if (!types) return invalid("types");
      const scope = o.any === true ? "" : ` AND state IN (${LIMIT.map(() => "?").join(", ")})`;
      const sql = `SELECT count(*) AS n FROM ${S.TABLE} WHERE open = 1 AND event_type IN (${marks(types)})${scope}`;
      row = cached(tx, s, sql).get(...types, ...(o.any === true ? [] : LIMIT));
    } else if (o.factionId !== undefined) {
      if (!isId(o.factionId)) return invalid("factionId");
      row = s.countFaction.get(toBind(o.factionId), ...LIMIT);
    } else if (o.type !== undefined) {
      if (!S.EVENT_TYPES.includes(o.type)) return invalid("type");
      row = s.countType.get(o.type, ...LIMIT);
    } else if (o.systemId !== undefined) {
      if (!isId(o.systemId)) return invalid("systemId");
      row = s.countSystem.get(toBind(o.systemId));
    } else if (o.any === true) {
      row = s.countOpenAny.get();
    } else {
      row = s.countAll.get(...LIMIT);
    }
    return { ok: true, count: Number(row.n) };
  }

  function lastEndedInSystemInTx(tx, systemId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    if (opts && opts.types !== undefined) {
      const types = typesOf(opts.types);
      if (!types) return invalid("types");
      const range = opts.layer === undefined ? null : layerIdRange(opts.layer);
      if (opts.layer !== undefined && !range) return invalid("layer");
      const sql = `SELECT max(ended_at) AS t FROM ${S.TABLE} WHERE system_id = ? AND ended_at IS NOT NULL
        AND event_type IN (${marks(types)})${range ? " AND event_id >= ? AND event_id < ?" : ""}`;
      const binds = range ? [...types, range.from, range.to] : types;
      return { ok: true, endedAt: num(cached(tx, stmts(tx), sql).get(toBind(systemId), ...binds).t) };
    }
    return { ok: true, endedAt: num(stmts(tx).lastEnded.get(toBind(systemId)).t) };
  }

  function pruneInTx(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || !isTime(opts.before) || !isCount(opts.limit)) return invalid("prune");
    if (opts.limit === 0) return { ok: true, deleted: 0 };
    const s = stmts(tx);
    const ids = s.pruneIds.all(...S.TERMINAL_STATES, toBind(opts.before), toBind(opts.limit)).map((r) => r.event_id);
    let deleted = 0;
    for (const id of ids) deleted += s.remove.run(id).changes;
    return { ok: true, deleted };
  }

  function listEndedInTx(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const limit = opts && isId(opts.limit) ? Math.min(opts.limit, S.OPEN_SCAN_LIMIT) : null;
    if (limit === null) return invalid("limit");
    return { ok: true, rows: stmts(tx).listEnded.all(...S.TERMINAL_STATES, toBind(limit)).map(toEvent) };
  }

  return Object.freeze({ planInTx, transitionInTx, recordLossesInTx, releaseSiteInTx, rewardAttemptInTx, listOpenInTx,
    getInTx,
    countOpenInTx, lastEndedInSystemInTx, pruneInTx, listEndedInTx });
}

module.exports = { createHeavyEventRepository, toEvent };
