"use strict";

const { buildWreckField, checkSettings } = require("./wreckPool");
const { WRECK_ACTIVE, WRECK_EXPIRED } = require("./wreckSchema");

const CONSEQUENCE_NAME = "wrecks";
const EXPIRE_EVENT = "WRECK_FIELD_EXPIRE";
const LIMIT_NAMES = Object.freeze(["maxFieldsPerSystem", "maxFieldsGlobal"]);

const expireKey = (fieldId, expiresAt) => `wreck:${fieldId}:expire:${expiresAt}`;
const endKey = (fieldId) => `wreck:${fieldId}:end`;

function messageOf(err) {
  return String((err && err.message) || err);
}

function createWreckConsequence(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createWreckConsequence: deps missing");
  const { repository, scheduler, settings, onCount } = deps;
  for (const fn of ["insertInTx", "transitionInTx", "countActive", "oldestActive"]) {
    if (!repository || typeof repository[fn] !== "function") {
      throw new TypeError(`createWreckConsequence: repository.${fn} required`);
    }
  }
  if (!scheduler || typeof scheduler.enqueue !== "function") {
    throw new TypeError("createWreckConsequence: scheduler.enqueue required");
  }
  const bad = checkSettings(settings);
  if (bad) throw new TypeError(`createWreckConsequence: settings.${bad}`);
  for (const name of LIMIT_NAMES) {
    if (!Number.isSafeInteger(settings[name]) || settings[name] < 1) {
      throw new TypeError(`createWreckConsequence: settings.${name} must be a positive integer`);
    }
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createWreckConsequence: onCount must be a function");
  }
  const S = Object.freeze({ ...settings });

  function bump(name) {
    if (!onCount) return;
    try {
      onCount(`world.wrecks.${name}`, 1);
    } catch (_err) {
    }
  }

  const fail = (stage, r) => ({ ok: false, ...(r && typeof r === "object" ? r : {}),
    reason: (r && r.reason) || "WRECKS_FAILED", stage });

  function evict(tx, scope, settled, ck) {
    const opts = scope === "system" ? { systemId: settled.systemId } : {};
    const limit = scope === "system" ? S.maxFieldsPerSystem : S.maxFieldsGlobal;
    const counted = repository.countActive(tx, opts);
    if (!counted.ok) return fail(`evict:${scope}`, counted);
    if (counted.count < limit) return { ok: true, evicted: false };
    const oldest = repository.oldestActive(tx, opts);
    if (!oldest.ok) return fail(`evict:${scope}`, oldest);
    if (!oldest.field) return { ok: true, evicted: false };
    if (oldest.field.expiresAt <= settled.at) {
      const t = repository.transitionInTx(tx, { fieldId: oldest.field.fieldId, expectedVersion: oldest.field.version,
        from: WRECK_ACTIVE, to: WRECK_EXPIRED, endReason: "TTL", at: oldest.field.expiresAt }, `${ck}:evict:${scope}`);
      if (!t.ok) return fail(`evict:${scope}`, t);
      if (t.duplicate) return fail(`evict:${scope}`, { reason: "NESTED_KEY_REUSED" });
      return { ok: true, evicted: false, expired: true };
    }
    const r = repository.transitionInTx(tx, { fieldId: oldest.field.fieldId, expectedVersion: oldest.field.version,
      from: WRECK_ACTIVE, to: WRECK_EXPIRED, endReason: scope === "system" ? "EVICTED_SYSTEM" : "EVICTED_GLOBAL",
      at: settled.at }, `${ck}:evict:${scope}`);
    if (!r.ok) return fail(`evict:${scope}`, r);
    if (r.duplicate) return fail(`evict:${scope}`, { reason: "NESTED_KEY_REUSED" });
    return { ok: true, evicted: true };
  }

  function applyInner(tx, settled, ck) {
    const built = buildWreckField(settled, S);
    if (!built.ok) return fail("build", built);
    if (built.skip) {
      bump("skipped");
      return { ok: true, skipped: built.skip };
    }
    const field = built.field;
    const placed = placeFieldInTx(tx, field, `${ck}`, { repository, scheduler, settings: S, onCount, settled, ck });
    if (!placed.ok) return placed;
    if (placed.duplicate) return fail("insert", { reason: "NESTED_KEY_REUSED" });
    if (built.collapsed) bump("compositionCollapsed");
    bump("created");
    return { ok: true, fieldId: field.fieldId, expiresAt: field.expiresAt, evictedSystem: false, evictedGlobal: false, collapsed: built.collapsed };
  }

  function apply(tx, settled, ck) {
    if (typeof ck !== "string" || ck === "") return { ok: false, reason: "WRECKS_KEY_MISSING" };
    try {
      return applyInner(tx, settled, ck);
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "WRECKS_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({ name: CONSEQUENCE_NAME, apply });
}

function placeFieldInTx(tx, field, idempotencyKeyPrefix, deps) {
  const { repository, scheduler, settings, onCount, settled, ck } = deps;
  const { WRECK_ACTIVE, WRECK_EXPIRED } = require("./wreckSchema");
  const { EXPIRE_EVENT, expireKey } = require("./wreckConsequence");

  const LIMIT_NAMES = Object.freeze(["maxFieldsPerSystem", "maxFieldsGlobal"]);
  const S = Object.freeze({ ...settings });

  function bump(name) {
    if (!onCount) return;
    try {
      onCount(`world.wrecks.${name}`, 1);
    } catch (_err) {
    }
  }

  const fail = (stage, r) => ({ ok: false, ...(r && typeof r === "object" ? r : {}),
    reason: (r && r.reason) || "WRECKS_FAILED", stage });

  function evict(tx, scope) {
    const opts = scope === "system" ? { systemId: settled.systemId } : {};
    const limit = scope === "system" ? S.maxFieldsPerSystem : S.maxFieldsGlobal;
    const counted = repository.countActive(tx, opts);
    if (!counted.ok) return fail(`evict:${scope}`, counted);
    if (counted.count < limit) return { ok: true, evicted: false };
    const oldest = repository.oldestActive(tx, opts);
    if (!oldest.ok) return fail(`evict:${scope}`, oldest);
    if (!oldest.field) return { ok: true, evicted: false };
    if (oldest.field.expiresAt <= settled.at) {
      const t = repository.transitionInTx(tx, { fieldId: oldest.field.fieldId, expectedVersion: oldest.field.version,
        from: WRECK_ACTIVE, to: WRECK_EXPIRED, endReason: "TTL", at: oldest.field.expiresAt }, `${ck}:evict:${scope}`);
      if (!t.ok) return fail(`evict:${scope}`, t);
      if (t.duplicate) return fail(`evict:${scope}`, { reason: "NESTED_KEY_REUSED" });
      return { ok: true, evicted: false, expired: true };
    }
    const r = repository.transitionInTx(tx, { fieldId: oldest.field.fieldId, expectedVersion: oldest.field.version,
      from: WRECK_ACTIVE, to: WRECK_EXPIRED, endReason: scope === "system" ? "EVICTED_SYSTEM" : "EVICTED_GLOBAL",
      at: settled.at }, `${ck}:evict:${scope}`);
    if (!r.ok) return fail(`evict:${scope}`, r);
    if (r.duplicate) return fail(`evict:${scope}`, { reason: "NESTED_KEY_REUSED" });
    return { ok: true, evicted: true };
  }

  const bySystem = evict(tx, "system");
  if (!bySystem.ok) return bySystem;
  const byWorld = evict(tx, "global");
  if (!byWorld.ok) return byWorld;

  const inserted = repository.insertInTx(tx, field, `${idempotencyKeyPrefix}:field`);
  if (!inserted.ok) return fail("insert", inserted);
  if (inserted.duplicate) return fail("insert", { reason: "NESTED_KEY_REUSED" });

  const ev = scheduler.enqueue(EXPIRE_EVENT, field.fieldId, field.expiresAt,
    { fieldId: field.fieldId, expiresAt: field.expiresAt }, expireKey(field.fieldId, field.expiresAt),
    { tx, chained: true });
  if (!ev || ev.ok !== true) return fail("enqueue", ev || { reason: "ENQUEUE_FAILED" });

  if (bySystem.expired) bump("expired");
  if (byWorld.expired) bump("expired");
  if (bySystem.evicted) bump("evictedSystem");
  if (byWorld.evicted) bump("evictedGlobal");

  return { ok: true, fieldId: field.fieldId, duplicate: inserted.duplicate };
}

module.exports = { createWreckConsequence, CONSEQUENCE_NAME, EXPIRE_EVENT, expireKey, endKey, placeFieldInTx };
