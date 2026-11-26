"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const { DED_TEMPLATES } = require("./catalog");
const { createEscalationsService, COUNTER_NAMES } = require("./service");

const ESCALATIONS_METHODS = Object.freeze(["getStatus", "runPass", "stop"]);
const SITE_KIND_OF = Object.freeze({ template: null, signature: "signature", anomaly: "anomaly" });
const MAX_EXCLUDED_ORIGINS_TEXT = 200;
const MAX_LOGGED_NAMES = 8;

const messageOf = (err) => String((err && err.message) || err);

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function running(service) {
  if (!service) return false;
  if (typeof service.getStatus !== "function") return false;
  const st = safeCall(() => service.getStatus());
  return Boolean(st && st.state === "running");
}

function parseExcludedOrigins(text) {
  if (typeof text !== "string" || text.length > MAX_EXCLUDED_ORIGINS_TEXT) return null;
  return new Set(text.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== ""));
}

function createUnavailableEscalations(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ getStatus: () => status, runPass: () => refusal, stop() {} });
}

function startEscalations(deps) {
  try {
    const { config, persistence, clock, adapter } = deps || {};
    const P = config && config.escalations;
    if (!P || P.enabled !== true || !isModuleEnabled(config, "sites")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!running(safeCall(deps.getSites))) return { ok: false, reason: "dependency_disabled:sites" };
    if (!running(safeCall(deps.getNotices))) return { ok: false, reason: "dependency_disabled:notices" };
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "ESCALATIONS_START_FAILED", detail: "clock" };
    }
    if (!Object.prototype.hasOwnProperty.call(SITE_KIND_OF, P.siteKind)) {
      return { ok: false, reason: "ESCALATIONS_START_FAILED", detail: "siteKind" };
    }
    const excludedOrigins = parseExcludedOrigins(P.excludedOrigins);
    if (!excludedOrigins) return { ok: false, reason: "ESCALATIONS_START_FAILED", detail: "excludedOrigins" };
    if (!adapter || typeof adapter.onCombatSiteCompleted !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "no onCombatSiteCompleted" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };

    let catalog = DED_TEMPLATES;
    const dungeon = typeof adapter.getDungeonSites === "function" ? safeCall(() => adapter.getDungeonSites()) : null;
    const checked = dungeon && dungeon.ok === true && typeof dungeon.checkTemplates === "function"
      ? safeCall(() => dungeon.checkTemplates(DED_TEMPLATES.map((t) => t.templateId))) : null;
    if (checked && checked.ok === true && Array.isArray(checked.missing) && checked.missing.length > 0) {
      const missing = new Set(checked.missing);
      catalog = Object.freeze(DED_TEMPLATES.filter((t) => !missing.has(t.templateId)));
      if (catalog.length === 0) return { ok: false, reason: "TEMPLATE_MISSING", detail: "all" };
      const names = [...missing].sort();
      logger.log(`escalations: ${names.length} DED templates missing in EveJS, left out: `
        + `${names.slice(0, MAX_LOGGED_NAMES).join(", ")}${names.length > MAX_LOGGED_NAMES ? ", ..." : ""}`);
    } else if (!checked || checked.ok !== true) {
      logger.log("escalations: DED templates unchecked");
    }

    const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed
      : safeCall(() => persistence.store.getWorldSeed());
    if (!Number.isSafeInteger(worldSeed)) return { ok: false, reason: "ESCALATIONS_START_FAILED", detail: "worldSeed" };
    const maxRows = config.persistence && Number.isSafeInteger(config.persistence.maxRowsPerTransaction)
      ? config.persistence.maxRowsPerTransaction : P.retentionDeletesPerPass;
    const retentionLimit = Math.max(1, Math.min(P.retentionDeletesPerPass, Math.floor(maxRows / (1 + P.maxRecipients))));

    let poller = null;
    const service = createEscalationsService({ store: persistence.store, worldSeed, catalog, settings: P,
      excludedOrigins, siteKind: SITE_KIND_OF[P.siteKind], retentionLimit, clock,
      getGovernor: deps.getGovernor, getSites: deps.getSites, getNotices: deps.getNotices,
      getPresence: deps.getPresence, getGraph: deps.getGraph, telemetry: deps.telemetry || null, logger,
      nowMs: deps.nowMs, onQueued: () => (poller ? poller.arm(0) : undefined) });
    poller = createPoller({
      runPass: () => service.runPass(clock.now()),
      intervalMs: P.passIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`escalations: pass threw - ${messageOf(err)}`),
    });
    const sub = safeCall(() => adapter.onCombatSiteCompleted(service.onCompletion));
    if (!sub || sub.ok !== true || typeof sub.unsubscribe !== "function") {
      service.stop();
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((sub && (sub.detail || sub.reason)) || "no result") };
    }
    const started = poller.start();
    if (!started.ok) {
      safeCall(sub.unsubscribe);
      service.stop();
      return { ok: false, reason: "ESCALATIONS_START_FAILED", detail: `poller ${started.reason}` };
    }
    logger.log(`escalations: running chance=${P.chance} jumps=${P.minJumps}-${P.maxJumps} siteKind=${P.siteKind}`
      + ` catalog=${catalog.length}`);
    let unsubscribe = sub.unsubscribe;
    const facade = {
      getStatus: () => Object.freeze({ ...service.getStatus(), listening: unsubscribe !== null }),
      runPass: (now) => service.runPass(now),
      stop() {
        if (service.isStopped()) return;
        if (unsubscribe) {
          safeCall(unsubscribe);
          unsubscribe = null;
        }
        poller.stop();
        service.stop();
      },
    };
    return { ok: true, escalations: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "ESCALATIONS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startEscalations, createUnavailableEscalations, parseExcludedOrigins, COUNTER_NAMES,
  ESCALATIONS_METHODS };
