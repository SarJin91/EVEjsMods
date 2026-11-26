"use strict";

const { isModuleEnabled } = require("../../config");
const { createWreckRepository } = require("./wreckRepository");
const { createWreckConsequence, EXPIRE_EVENT, endKey, placeFieldInTx } = require("./wreckConsequence");
const { effectivePool, buildGankWreckField } = require("./wreckPool");
const { WRECK_ACTIVE, WRECK_EXPIRED, MAX_FIELD_ID_LENGTH, WRECK_AGGREGATE } = require("./wreckSchema");
const { LAYER_ID, buildWrecksLayerView } = require("./wrecksLayer");

const STATE_READY = "ready";
const STATE_UNAVAILABLE = "unavailable";
const STATE_STOPPED = "stopped";
const COUNTER_NAMES = Object.freeze(["created", "skipped", "evictedSystem", "evictedGlobal", "compositionCollapsed",
  "expired", "expireNoop", "expireMissing"]);
const SETTING_KEYS = Object.freeze(["fieldTtlMs", "decayFloor", "maxFieldsPerSystem", "maxFieldsGlobal",
  "minShipsLost", "maxCompositionEntries", "salvageYieldFactor", "lootYieldFactor"]);
const NO_EFFECT_REASONS = Object.freeze(["WRONG_STATE", "NOT_FOUND"]);
const GANK_EVENT = "HIGHSEC_GANK_FIELD";
const gankKey = (systemId, bucket) => `hsgank:${systemId}:${bucket}`;

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableWrecks(reason, detail) {
  const status = Object.freeze({ state: STATE_UNAVAILABLE, reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ consequence: null, repository: null, effectivePool, getStatus: () => status,
    placeGankField: () => ({ ok: false, reason: "WRECKS_UNAVAILABLE" }), stop() {} });
}

function startWrecks(deps) {
  try {
    const { config, persistence, clock, scheduler, telemetry } = deps || {};
    if (!isModuleEnabled(config, "world") || !config.wrecks || config.wrecks.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "WRECKS_START_FAILED", detail: "clock" };
    let schedulerState = null;
    try {
      schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
    } catch (_err) {
      schedulerState = null;
    }
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function"
      || schedulerState !== STATE_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const settings = Object.fromEntries(SETTING_KEYS.map((k) => [k, config.wrecks[k]]));
    const hooks = (telemetry && telemetry.hooks) || {};
    const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
    const onCount = (name, n) => {
      const short = name.startsWith("world.wrecks.") ? name.slice("world.wrecks.".length) : null;
      if (short !== null && Object.prototype.hasOwnProperty.call(counters, short)) counters[short] += n;
      if (typeof hooks.onCount === "function") {
        try {
          hooks.onCount(name, n);
        } catch (_err) {
        }
      }
    };
    const bump = (name) => onCount(`world.wrecks.${name}`, 1);
    const store = persistence.store;
    const repository = createWreckRepository({ journal: persistence.journal,
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined });
    let inner;
    try {
      inner = createWreckConsequence({ repository, scheduler, settings, onCount });
    } catch (err) {
      return { ok: false, reason: "WRECKS_START_FAILED", detail: messageOf(err) };
    }
    let state = STATE_READY;
    let stopReason = null;
    const consequence = Object.freeze({ name: inner.name, apply(tx, settled, ck) {
      if (state !== STATE_READY) return { ok: false, reason: "WRECKS_STOPPED" };
      return inner.apply(tx, settled, ck);
    } });

    function onExpire(ev) {
      try {
        const p = ev && ev.payload;
        if (!p || typeof p.fieldId !== "string" || p.fieldId === "" || p.fieldId.length > MAX_FIELD_ID_LENGTH
          || !Number.isSafeInteger(p.expiresAt) || p.expiresAt < 0) {
          return { ok: false, reason: "WRECK_PAYLOAD_INVALID", permanent: true };
        }
        const read = store.transaction("wrecks.expireRead", (tx) => repository.get(tx, p.fieldId));
        if (!read.ok) return { ok: false, reason: read.reason || "TX_FAILED" };
        if (!read.value.ok) return { ok: false, reason: read.value.reason };
        const field = read.value.field;
        if (!field) {
          bump("expireMissing");
          return { ok: true, outcome: "missing" };
        }
        if (field.state !== WRECK_ACTIVE || field.expiresAt !== p.expiresAt) {
          bump("expireNoop");
          return { ok: true, outcome: "noop" };
        }
        return { ok: true, outcome: "expired", effect: (tx) => {
          const r = repository.transitionInTx(tx, { fieldId: field.fieldId, expectedVersion: field.version,
            from: WRECK_ACTIVE, to: WRECK_EXPIRED, endReason: "TTL", at: field.expiresAt }, endKey(field.fieldId));
          if (r.ok) {
            if (!r.duplicate) bump("expired");
            return { ok: true };
          }
          if (NO_EFFECT_REASONS.includes(r.reason)) {
            bump("expireNoop");
            return { ok: true };
          }
          return r;
        } };
      } catch (err) {
        return { ok: false, reason: `HANDLER_FAILED: ${messageOf(err)}` };
      }
    }

    let registration;
    try {
      registration = scheduler.registerHandler(EXPIRE_EVENT, onExpire);
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "WRECKS_START_FAILED",
        detail: `handler ${EXPIRE_EVENT}: ${(registration && registration.reason) || "no result"}` };
    }

    let viewHandle = null;
    const observer = config.observer || {};
    const views = deps.views;
    if (observer.galaxyEnabled === true && observer.galaxyWrecksEnabled === true && views
      && typeof views.registerView === "function") {
      const r = views.registerView(LAYER_ID, buildWrecksLayerView({ store, repository, clock,
        getGovernor: deps.getGovernor, telemetry: telemetry || null, nowMs: deps.nowMs,
        maxFields: settings.maxFieldsGlobal, maxSystems: observer.galaxyWrecksMaxSystems,
        maxLines: observer.galaxyWrecksMaxLines, refreshMs: observer.galaxyWrecksRefreshMs,
        tierMediumUnits: observer.galaxyWrecksTierMediumUnits, tierLargeUnits: observer.galaxyWrecksTierLargeUnits,
        fieldTtlMs: settings.fieldTtlMs }));
      if (r && r.ok) viewHandle = r;
      else if (deps.logger && typeof deps.logger.log === "function") {
        deps.logger.log(`wrecks: view ${LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
      }
    }

    function placeGankField(p) {
      if (state !== STATE_READY) return { ok: false, reason: "WRECKS_STOPPED" };
      try {
        const built = buildGankWreckField(p, settings);
        if (!built.ok) return built;
        const field = built.field;
        const key = gankKey(p.systemId, p.bucket);
        const r = store.transaction("wrecks.placeGankField", (tx) => persistence.journal.applyOnce(tx, { key,
          aggregate: { type: WRECK_AGGREGATE, id: field.fieldId }, eventType: GANK_EVENT,
          payload: { systemId: p.systemId, bucket: p.bucket, at: p.at } }, (tx2) => placeFieldInTx(tx2, field, key, {
          repository, scheduler, settings, onCount, settled: { systemId: p.systemId, at: p.at }, ck: key })));
        if (!r.ok) return { ok: false, reason: r.reason || "TX_FAILED", stage: "tx" };
        const v = r.value;
        if (!v || v.ok !== true) {
          const refusal = v && v.reason === "APPLY_REFUSED" && v.refusal ? v.refusal : v;
          return { ok: false, reason: (refusal && refusal.reason) || "WRECKS_FAILED",
            ...(refusal && refusal.stage ? { stage: String(refusal.stage) } : {}) };
        }
        if (v.duplicate) return { ok: true, duplicate: true, fieldId: field.fieldId };
        bump("created");
        return { ok: true, duplicate: false, fieldId: field.fieldId, shipsLost: field.shipsLost,
          expiresAt: field.expiresAt };
      } catch (err) {
        return { ok: false, reason: "WRECKS_FAILED", detail: messageOf(err) };
      }
    }

    const facade = {
      consequence,
      repository,
      effectivePool,
      placeGankField,
      countActive: () => {
        const r = store.transaction("wrecks.countActive", (tx) => repository.countActive(tx));
        return r.ok ? r.value : { ok: false, reason: r.reason || "TX_FAILED" };
      },
      getStatus: () => Object.freeze({ state, reason: stopReason, layer: viewHandle !== null,
        counters: Object.freeze({ ...counters }) }),
      stop(reason) {
        if (state === STATE_STOPPED) return;
        state = STATE_STOPPED;
        stopReason = reason === undefined ? null : String(reason);
        swallow(() => registration.unregister());
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          swallow(() => handle.unregister());
        }
      },
    };
    return { ok: true, wrecks: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "WRECKS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startWrecks, createUnavailableWrecks };
