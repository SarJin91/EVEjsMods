"use strict";

const { performance } = require("node:perf_hooks");
const { fingerprint } = require("../../util/fingerprint");
const defaultRepository = require("./siteRepository");
const { STATE, FAIL_REASON, MAX_EVENT_ID_LENGTH, MAX_LABEL_LENGTH, MAX_TEMPLATE_ID_LENGTH, SITE_KINDS,
  siteKeyOf } = require("./schema");

const COUNTER_NAMES = Object.freeze(["created", "adopted", "createFailed", "failed", "lost", "completed",
  "extended", "despawned", "purged", "purgeDeferred", "identityMismatch", "flushFailed", "idMismatch",
  "seamUnavailable", "versionConflict", "stepFailed", "listenerFailed", "retained",
  "refused.SITE_REQUEST_INVALID", "refused.SITES_FULL", "refused.SYSTEM_WINDOW_FULL",
  "refused.IDEMPOTENCY_CONFLICT", "refused.TX_ACTIVE", "scannerHidden", "scannerHideFailed",
  "providerContainers", "providerRetry"]);
const MAX_PROVIDERS = 4;
const PROVIDER_PREFIX_RE = /^[a-z]{2,8}:$/;

const CLEANUP_REASONS = Object.freeze(["EVENT_END", "EVENT_CANCELLED"]);
const LISTENED_STATES = Object.freeze([STATE.COMPLETED, STATE.LOST, STATE.FAILED, STATE.PURGED]);
const ENSURE_FAIL_REASONS = Object.freeze([FAIL_REASON.TEMPLATE_MISSING, FAIL_REASON.SYSTEM_UNKNOWN,
  FAIL_REASON.SITE_FOREIGN, FAIL_REASON.SITE_KEY_INVALID, FAIL_REASON.SITE_SPEC_INVALID]);
const DESPAWN_REASON = Object.freeze({ MISMATCH: "lne_site_id_mismatch", FAILED: "lne_event_failed",
  END: "lne_event_end" });
const SEAM_UNAVAILABLE = "SEAM_UNAVAILABLE";
const EXTEND_GONE_STATES = Object.freeze(["completed", "failed", "despawned", "missing", "foreign"]);
const PLACEMENT_SEED_PREFIX = "lne-site:";
const MAX_DETAIL = 120;
const MS_DECIMALS = 1000;
const NO_WS_RE = /^\S+$/;

const SKIP = "skip";
const STOP = "stop";
const DONE = "done";

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isText(value, max) {
  return typeof value === "string" && value.length >= 1 && value.length <= max && value.trim() === value;
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function intOrNull(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function buildEnsureSpec(row, now, P) {
  return {
    siteKey: row.siteKey,
    systemId: row.systemId,
    templateId: row.templateId,
    label: row.label,
    eventId: row.eventId,
    slot: row.slot,
    position: row.position ? { x: row.position.x, y: row.position.y, z: row.position.z } : null,
    placementSeed: `${PLACEMENT_SEED_PREFIX}${row.eventId}:${row.slot}`,
    placementBaseDistanceAu: P.placementBaseDistanceAu,
    vendorExpiresAtMs: row.expiresAt + P.vendorExpiryGraceMs,
    nowMs: now,
    durable: P.durableCreate === true,
    ...(row.siteKind ? { siteKind: row.siteKind } : {}),
  };
}

function despawnReasonOf(failReason) {
  if (failReason === FAIL_REASON.SITE_ID_MISMATCH) return DESPAWN_REASON.MISMATCH;
  return failReason ? DESPAWN_REASON.FAILED : DESPAWN_REASON.END;
}

function createSiteService(deps) {
  const { store, adapter, clock, config } = deps;
  const P = config.sites;
  const windowLimit = config.limits.maxNewSitesPerSystemPerWindow;
  const repo = deps.repository || defaultRepository;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const listeners = new Set();
  const providers = [];

  function bump(name, n = 1) {
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`sites.${name}`, n);
    } catch (_err) {
    }
  }

  function observeMs(name, ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      if (name === "write") telemetry.observe("sites.writeMs", Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
      else telemetry.observe("sites.passMs", Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    } catch (_err) {
    }
  }

  function admits(workClass) {
    let governor = null;
    try {
      governor = getGovernor();
    } catch (_err) {
      governor = null;
    }
    if (!governor || typeof governor.admits !== "function") return true;
    try {
      return governor.admits(workClass) !== false;
    } catch (_err) {
      return true;
    }
  }

  function refuse(reason, detail) {
    bump(`refused.${reason}`);
    return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
  }

  function invalid(detail) {
    return refuse("SITE_REQUEST_INVALID", detail);
  }

  function inTx(tx) {
    return Boolean(tx && tx.inTransaction === true);
  }

  function createSiteInTx(tx, req) {
    if (!inTx(tx)) return invalid("tx");
    if (!req || typeof req !== "object") return invalid("request");
    const now = clock.now();
    const { eventId, slot, systemId, templateId, label, expiresAt } = req;
    const factionId = req.factionId === undefined ? null : req.factionId;
    if (!isText(eventId, MAX_EVENT_ID_LENGTH) || !NO_WS_RE.test(eventId)) return invalid("eventId");
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= P.maxSlotsPerEvent) return invalid("slot");
    if (!isPositiveInt(systemId)) return invalid("systemId");
    if (!isText(templateId, MAX_TEMPLATE_ID_LENGTH)) return invalid("templateId");
    if (!isText(label, MAX_LABEL_LENGTH)) return invalid("label");
    if (factionId !== null && !isPositiveInt(factionId)) return invalid("factionId");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return invalid("expiresAt");
    const siteKind = req.siteKind === undefined ? null : req.siteKind;
    if (siteKind !== null && !SITE_KINDS.includes(siteKind)) return invalid("siteKind");
    const requestHash = fingerprint(siteKind === null ? { systemId, templateId, label, factionId }
      : { systemId, templateId, label, factionId, siteKind });
    const existing = repo.getByEventSlotInTx(tx, eventId, slot);
    if (existing) {
      if (existing.requestHash !== requestHash) return refuse("IDEMPOTENCY_CONFLICT");
      return { ok: true, siteKey: existing.siteKey, created: false, state: existing.state };
    }
    if (repo.countLiveInTx(tx) >= P.maxActiveSites) return refuse("SITES_FULL");
    if (repo.countSystemWindowInTx(tx, systemId, now - P.newSiteWindowMs) >= windowLimit) {
      return refuse("SYSTEM_WINDOW_FULL");
    }
    const siteKey = siteKeyOf(eventId, slot);
    repo.insertInTx(tx, { siteKey, eventId, slot, systemId, templateId, label, factionId, requestHash, expiresAt,
      now, siteKind });
    return { ok: true, siteKey, created: true, state: STATE.CREATING };
  }

  function extendSitesInTx(tx, eventId, expiresAt) {
    if (!inTx(tx)) return invalid("tx");
    const now = clock.now();
    if (!isText(eventId, MAX_EVENT_ID_LENGTH) || !NO_WS_RE.test(eventId)) return invalid("eventId");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return invalid("expiresAt");
    return { ok: true, updated: repo.extendInTx(tx, eventId, expiresAt, now) };
  }

  function cleanupSitesInTx(tx, eventId, reason) {
    if (!inTx(tx)) return invalid("tx");
    if (!isText(eventId, MAX_EVENT_ID_LENGTH) || !NO_WS_RE.test(eventId)) return invalid("eventId");
    if (!CLEANUP_REASONS.includes(reason)) return invalid("reason");
    const failReason = reason === "EVENT_CANCELLED" ? FAIL_REASON.EVENT_CANCELLED : null;
    return { ok: true, released: repo.cleanupInTx(tx, eventId, failReason, clock.now()) };
  }

  function releaseSlotInTx(tx, eventId, slot, reason) {
    if (!inTx(tx)) return invalid("tx");
    if (!isText(eventId, MAX_EVENT_ID_LENGTH) || !NO_WS_RE.test(eventId)) return invalid("eventId");
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= P.maxSlotsPerEvent) return invalid("slot");
    if (!CLEANUP_REASONS.includes(reason)) return invalid("reason");
    const failReason = reason === "EVENT_CANCELLED" ? FAIL_REASON.EVENT_CANCELLED : null;
    return { ok: true, released: repo.releaseSlotInTx(tx, eventId, slot, failReason, clock.now()) };
  }

  function read(name, tx, fn) {
    if (tx) return inTx(tx) ? fn(tx) : invalid("tx");
    if (typeof store.isInTransaction === "function" && store.isInTransaction()) return refuse("TX_ACTIVE");
    const r = store.transaction(name, fn);
    if (!r.ok) return { ok: false, reason: r.reason || "TX_FAILED" };
    return r.value;
  }

  function listSitesByEvent(eventId, tx) {
    if (typeof eventId !== "string" || eventId === "") return invalid("eventId");
    return read("sites.read", tx, (db) => ({ ok: true, sites: repo.listByEventInTx(db, eventId).map((r) => ({
      siteKey: r.siteKey, slot: r.slot, systemId: r.systemId, templateId: r.templateId, state: r.state,
      failReason: r.failReason, siteId: r.siteId, expiresAt: r.expiresAt,
      position: r.position ? { x: r.position.x, y: r.position.y, z: r.position.z } : null })) }));
  }

  function countLiveSitesBySystem(systemId, tx) {
    if (!isPositiveInt(systemId)) return invalid("systemId");
    return read("sites.read", tx, (db) => ({ ok: true, count: repo.countVisibleBySystemInTx(db, systemId) }));
  }

  function addSiteStateListener(fn) {
    if (typeof fn !== "function") return noop;
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function registerContentProvider(p) {
    if (!p || typeof p !== "object" || typeof p.prefix !== "string" || !PROVIDER_PREFIX_RE.test(p.prefix)
      || typeof p.build !== "function") return { ok: false, reason: "BAD_PROVIDER" };
    if (providers.some((x) => x.prefix === p.prefix)) return { ok: false, reason: "DUPLICATE" };
    if (providers.length >= MAX_PROVIDERS) return { ok: false, reason: "FULL" };
    const entry = Object.freeze({ prefix: p.prefix, build: p.build });
    providers.push(entry);
    return { ok: true, unregister() {
      const i = providers.indexOf(entry);
      if (i >= 0) providers.splice(i, 1);
    } };
  }

  function providedContainers(row) {
    const p = providers.find((x) => row.eventId.startsWith(x.prefix));
    if (!p) return { ok: true, containers: null };
    let r;
    try {
      r = p.build(row.eventId, row.slot);
    } catch (err) {
      logger.log(`sites: provider ${p.prefix} threw on ${row.siteKey} - ${messageOf(err)}`);
      return { ok: false };
    }
    if (!r || r.ok !== true || !Array.isArray(r.containers)) return { ok: false };
    return { ok: true, containers: r.containers.length > 0 ? r.containers : null };
  }

  function emit(events) {
    for (const event of events) {
      for (const fn of [...listeners]) {
        try {
          fn(event);
        } catch (err) {
          bump("listenerFailed");
          logger.log(`sites: listener failed on ${event.state} ${event.siteKey} - ${messageOf(err)}`);
        }
      }
    }
  }

  function countLive() {
    return read("sites.read", null, (db) => ({ ok: true, count: repo.countLiveInTx(db) }));
  }

  function commit(row, now, patch, counters = []) {
    const full = { ...patch, updated_at: now };
    const r = store.transaction("sites.step", (tx) => repo.transitionInTx(tx, row, full));
    if (!r.ok) {
      logger.log(`sites: step ${row.siteKey} not committed - ${r.reason}${r.error ? ` ${messageOf(r.error)}` : ""}`);
      return false;
    }
    if (!r.value || r.value.ok !== true) {
      if (r.value && r.value.reason === "VERSION_CONFLICT") bump("versionConflict");
      return false;
    }
    for (const name of counters) bump(name);
    const state = patch.state;
    if (state && state !== row.state && LISTENED_STATES.includes(state)) {
      emit([Object.freeze({ siteKey: row.siteKey, eventId: row.eventId, slot: row.slot, state,
        failReason: patch.fail_reason !== undefined ? patch.fail_reason : row.failReason })]);
    }
    return true;
  }

  function later(row, now, delayMs) {
    return commit(row, now, { next_attempt_at: Math.min(now + delayMs, Math.max(row.expiresAt, now)) });
  }

  function retryLater(row, now) {
    return commit(row, now, { next_attempt_at: now + P.retryDelayMs });
  }

  function lostPatch(now) {
    return { state: STATE.LOST, next_attempt_at: now };
  }

  function stepCreating(seam, row, now, budget, maintenance) {
    if (now >= row.expiresAt) return commit(row, now, { state: STATE.CLEANING, next_attempt_at: now });
    if (!budget.canWrite()) return SKIP;
    const spec = buildEnsureSpec(row, now, P);
    const provided = providers.length > 0 ? providedContainers(row) : { ok: true, containers: null };
    if (!provided.ok) {
      bump("providerRetry");
      return retryLater(row, now);
    }
    if (provided.containers) {
      spec.extraContainers = provided.containers;
      bump("providerContainers");
    }
    const res = budget.call(() => seam.ensureSite(spec));
    if (res.ok) {
      const pos = res.position && typeof res.position === "object" ? res.position : null;
      const counters = [res.adopted ? "adopted" : "created"];
      if (res.durable === false) counters.push("flushFailed");
      commit(row, now, {
        state: STATE.ACTIVE, instance_id: intOrNull(res.instanceId), site_id: intOrNull(res.siteId),
        pos_x: pos ? finiteOrNull(pos.x) : null, pos_y: pos ? finiteOrNull(pos.y) : null,
        pos_z: pos ? finiteOrNull(pos.z) : null,
        vendor_expires_at: res.adopted ? null : spec.vendorExpiresAtMs, attempts: 0,
        next_attempt_at: res.adopted ? now : Math.min(now + P.pollIntervalMs, row.expiresAt),
      }, counters);
      return DONE;
    }
    if (res.reason === SEAM_UNAVAILABLE) return STOP;
    if (res.reason === "SITE_TERMINAL") {
      if (!maintenance) return retryLater(row, now);
      if (!budget.canWrite()) return SKIP;
      const purge = budget.call(() => seam.purgeSite(row.siteKey, row.systemId));
      if (!purge.ok && purge.reason === SEAM_UNAVAILABLE) return STOP;
      if (purge.ok && purge.purged) return commit(row, now, { next_attempt_at: now }, ["purged"]);
      if (purge.ok && !purge.deferred) return commit(row, now, { next_attempt_at: now });
      return commit(row, now, { next_attempt_at: now + P.retryDelayMs }, purge.ok ? ["purgeDeferred"] : []);
    }
    if (ENSURE_FAIL_REASONS.includes(res.reason)) {
      logger.log(`sites: ${row.siteKey} failed - ${res.reason}${res.detail ? ` (${res.detail})` : ""}`);
      return commit(row, now, { state: STATE.FAILED, fail_reason: res.reason, next_attempt_at: now }, ["failed"]);
    }
    if (res.reason === FAIL_REASON.SITE_ID_MISMATCH) {
      return commit(row, now, { state: STATE.CLEANING, fail_reason: FAIL_REASON.SITE_ID_MISMATCH,
        instance_id: intOrNull(res.instanceId), next_attempt_at: now }, ["idMismatch"]);
    }
    const attempts = row.attempts + 1;
    if (attempts >= P.maxCreateAttempts) {
      logger.log(`sites: ${row.siteKey} failed - ${res.reason || "CREATE_FAILED"} after ${attempts} attempts`);
      return commit(row, now, { state: STATE.FAILED, fail_reason: FAIL_REASON.CREATE_FAILED, attempts,
        next_attempt_at: now }, ["createFailed", "failed"]);
    }
    return commit(row, now, { attempts, next_attempt_at: now + P.retryDelayMs }, ["createFailed"]);
  }

  function settleInactive(row, now, state, foreign) {
    if (state === "completed") {
      return commit(row, now, { state: STATE.COMPLETED, next_attempt_at: row.expiresAt }, ["completed"]);
    }
    return commit(row, now, lostPatch(now), foreign ? ["lost", "identityMismatch"] : ["lost"]);
  }

  function stepActive(seam, row, now, budget) {
    if (now >= row.expiresAt) return commit(row, now, { state: STATE.CLEANING, next_attempt_at: now });
    const target = row.expiresAt + P.vendorExpiryGraceMs;
    if (row.vendorExpiresAt !== target && Number.isSafeInteger(target)) {
      if (!budget.canWrite()) return SKIP;
      const res = budget.call(() => seam.extendSite(row.siteKey, target, now));
      if (!res.ok) {
        if (res.reason === SEAM_UNAVAILABLE) return STOP;
        return later(row, now, P.retryDelayMs);
      }
      if (EXTEND_GONE_STATES.includes(res.state)) return settleInactive(row, now, res.state, res.state === "foreign");
      return commit(row, now, { vendor_expires_at: target }, res.extended ? ["extended"] : []);
    }
    const res = seam.readSite(row.siteKey);
    if (!res || !res.ok) return later(row, now, P.retryDelayMs);
    if (res.state === "active") {
      return commit(row, now, { instance_id: intOrNull(res.instanceId),
        next_attempt_at: Math.min(now + P.pollIntervalMs, row.expiresAt) });
    }
    return settleInactive(row, now, res.state, res.foreign === true);
  }

  function stepLost(row, now) {
    if (now >= row.expiresAt) return commit(row, now, { state: STATE.CLEANED, next_attempt_at: now });
    if (row.recreateCount < P.maxRecreate) {
      return commit(row, now, { state: STATE.CREATING, recreate_count: row.recreateCount + 1, attempts: 0,
        next_attempt_at: now });
    }
    return commit(row, now, { state: STATE.CLEANED, fail_reason: FAIL_REASON.RECREATE_LIMIT, next_attempt_at: now });
  }

  function stepCleaning(seam, row, now, budget) {
    if (!budget.canWrite()) return SKIP;
    const res = budget.call(() => seam.despawnSite(row.siteKey, despawnReasonOf(row.failReason), now));
    if (!res.ok) {
      if (res.reason === SEAM_UNAVAILABLE) return STOP;
      return retryLater(row, now);
    }
    const counters = res.already ? [] : ["despawned"];
    if (res.scanner === "hidden") counters.push("scannerHidden");
    else if (res.scanner === "failed") counters.push("scannerHideFailed");
    return commit(row, now, { state: STATE.CLEANED, next_attempt_at: now + P.purgeDelayMs }, counters);
  }

  function stepCleaned(seam, row, now, budget, maintenance) {
    if (!maintenance) return retryLater(row, now);
    if (!budget.canWrite()) return SKIP;
    const res = budget.call(() => seam.purgeSite(row.siteKey, row.systemId));
    if (!res.ok) {
      if (res.reason === SEAM_UNAVAILABLE) return STOP;
      if (res.reason === "SITE_STILL_ACTIVE") return commit(row, now, { state: STATE.CLEANING, next_attempt_at: now });
      return retryLater(row, now);
    }
    if (res.deferred) return commit(row, now, { next_attempt_at: now + P.retryDelayMs }, ["purgeDeferred"]);
    return commit(row, now, { state: STATE.PURGED, next_attempt_at: now }, res.purged ? ["purged"] : []);
  }

  function stepRow(seam, row, now, budget, maintenance) {
    switch (row.state) {
      case STATE.CREATING: return stepCreating(seam, row, now, budget, maintenance);
      case STATE.ACTIVE: return stepActive(seam, row, now, budget);
      case STATE.COMPLETED:
        if (now >= row.expiresAt) return commit(row, now, { state: STATE.CLEANING, next_attempt_at: now });
        return commit(row, now, { next_attempt_at: row.expiresAt });
      case STATE.LOST: return stepLost(row, now);
      case STATE.CLEANING: return stepCleaning(seam, row, now, budget);
      case STATE.CLEANED: return stepCleaned(seam, row, now, budget, maintenance);
      default: return retryLater(row, now);
    }
  }

  function runPass(now) {
    const startedAt = nowMs();
    const out = { ok: true, rows: 0, vendorWrites: 0, skipped: null };
    try {
      if (!Number.isSafeInteger(now) || now <= 0) return { ok: false, reason: "SITES_NOW_INVALID" };
      if (!admits("OPERATIONAL")) {
        out.skipped = "GOVERNOR";
        return out;
      }
      let seam = null;
      try {
        seam = adapter && typeof adapter.getDungeonSites === "function" ? adapter.getDungeonSites() : null;
      } catch (_err) {
        seam = null;
      }
      if (!seam || seam.ok !== true) {
        bump("seamUnavailable");
        out.skipped = "SEAM_UNAVAILABLE";
        return out;
      }
      const maintenance = admits("MAINTENANCE");
      const due = read("sites.due", null, (db) => ({ ok: true,
        rows: repo.listDueInTx(db, now, P.maxRowsPerPass, P.vendorExpiryGraceMs) }));
      if (!due.ok) return { ok: false, reason: due.reason };
      const budget = {
        writes: 0,
        canWrite: () => budget.writes < P.maxWritesPerPass,
        call(fn) {
          const t0 = nowMs();
          const res = fn() || { ok: false, reason: "NO_RESULT" };
          observeMs("write", nowMs() - t0);
          budget.writes += Number.isSafeInteger(res.vendorWrites) ? res.vendorWrites : 0;
          return res;
        },
      };
      for (const row of due.rows) {
        out.rows += 1;
        let step;
        try {
          step = stepRow(seam, row, now, budget, maintenance);
        } catch (err) {
          bump("stepFailed");
          logger.log(`sites: step ${row.siteKey} threw - ${messageOf(err)}`);
          try {
            retryLater(row, now);
          } catch (_err) {
          }
          continue;
        }
        if (step === STOP) {
          bump("seamUnavailable");
          retryLater(row, now);
          out.skipped = "SEAM_UNAVAILABLE";
          break;
        }
      }
      if (maintenance && out.skipped === null) {
        const cutoff = now - P.rowRetentionMs;
        const r = store.transaction("sites.retain", (tx) => repo.purgeRetainedInTx(tx, cutoff, P.maxRowsPerPass));
        if (r.ok && r.value > 0) bump("retained", r.value);
      }
      out.vendorWrites = budget.writes;
      return out;
    } catch (err) {
      logger.log(`sites: pass failed - ${messageOf(err)}`);
      return { ok: false, reason: "SITES_PASS_FAILED", detail: messageOf(err) };
    } finally {
      observeMs("pass", nowMs() - startedAt);
    }
  }

  return Object.freeze({
    createSiteInTx,
    extendSitesInTx,
    cleanupSitesInTx,
    releaseSlotInTx,
    listSitesByEvent,
    countLiveSitesBySystem,
    addSiteStateListener,
    registerContentProvider,
    runPass,
    countLive,
  });
}

module.exports = { createSiteService, buildEnsureSpec, despawnReasonOf, COUNTER_NAMES, MAX_PROVIDERS };
