"use strict";

const { performance } = require("node:perf_hooks");
const { createNoticeRepository } = require("./repository");
const { createDispatcher } = require("./dispatcher");
const { createPoller } = require("../presence/poller");
const { createTail } = require("./tail");

const COUNTER_NAMES = Object.freeze(["itemsQueued", "itemsDuplicate", "mailsSent", "mailsFailed", "mailsReconciled",
  "mailsLost", "itemsExpired", "itemsDropped", "deferrals", "errors", "tailRows", "events", "eventsStale",
  "tailSkippedLag", "tailSkippedFailed", "sourceMissing", "recipientsUnavailable", "recipientsTruncated",
  "urgentSent", "urgentFailed",
  "warListenerErrors"]);
const OBSERVE_NAMES = Object.freeze(["sendMs", "passMs", "tailMs"]);
const NOTICES_METHODS = Object.freeze(["getStatus", "stop", "enqueueItemsInTx", "sendUrgent", "onWarEvents",
  "mailEventKeys"]);
const MAX_WAR_LISTENERS = 4;
const URGENT_KINDS = Object.freeze(["HUNT_WARNING"]);
const STATE = Object.freeze({ RUNNING: "running", STOPPED: "stopped" });
const ADAPTER_METHODS = Object.freeze(["sendPlayerMail", "findPlayerMail", "defaultMailSender"]);

function messageOf(err) {
  return String((err && err.message) || err);
}

function createUnavailableNotices(reason, detail) {
  const refusal = reason === "NOTICES_DISABLED" ? "NOTICES_DISABLED" : "NOTICES_UNAVAILABLE";
  return Object.freeze({
    getStatus: () => ({ state: "unavailable", reason: String(reason || refusal), ...(detail ? { detail } : {}) }),
    stop: () => {},
    enqueueItemsInTx: () => ({ ok: false, reason: refusal }),
    sendUrgent: () => ({ ok: false, reason: refusal }),
    onWarEvents: () => ({ ok: false, reason: refusal }),
    mailEventKeys: () => ({ ok: false, reason: refusal }),
  });
}

function nativeOf(config) {
  const P = config && config.nativeIncursions;
  if (!P || P.enabled !== true || P.noticesEnabled !== true) return {};
  const repo = require("../nativeIncursions/repository").createNativeIncursionRepository();
  return { nativeSettings: { radiusJumps: P.noticeRadiusJumps, maxRecipients: P.noticeMaxRecipients },
    getNativeIncursionRow: (tx, taleId) => repo.getInTx(tx, taleId) };
}

function isNonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function startNotices(deps) {
  const config = deps && deps.config;
  const settings = config && config.notices;
  if (!settings || settings.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const ctx = deps.ctx || {};
  const adapter = deps.adapter || null;
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : undefined;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const persistence = ctx.persistence;
  const store = persistence && persistence.ok === true && persistence.store ? persistence.store : null;
  if (!store) return { ok: false, reason: "NOTICES_STORE_UNAVAILABLE" };
  if (!adapter || ADAPTER_METHODS.some((m) => typeof adapter[m] !== "function")) {
    return { ok: false, reason: "NOTICES_SEAM_UNAVAILABLE" };
  }

  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let state = STATE.RUNNING;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`notices: ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](`notices.${name}`, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!COUNTER_NAMES.includes(name)) return;
    counters[name] += n;
    metric("count", name, n);
  }

  function observe(name, value) {
    if (OBSERVE_NAMES.includes(name)) metric("observe", name, value);
  }

  const repo = createNoticeRepository();
  const dispatcher = createDispatcher({ store, repo, adapter, settings, getGovernor: () => ctx.governor || null,
    bump, observe, log, nowMs });

  const warListeners = [];

  function deliverWarEvents(views) {
    for (const fn of warListeners.slice()) {
      try {
        fn(views);
      } catch (err) {
        bump("warListenerErrors");
        log(`war events listener failed - ${messageOf(err)}`);
      }
    }
  }

  const tail = createTail({ store, journal: persistence.journal || {}, repo, enqueue: enqueueItemsInTx, settings,
    hasWarListeners: () => warListeners.length > 0, onCommitted: deliverWarEvents,
    getWorldRepository: () => (ctx.world && ctx.world.repository) || null,
    getSiegeRepository: () => (ctx.siege && ctx.siege.repository) || null,
    getPresence: () => ctx.presence || null, getGraph: () => ctx.graph || null, adapter,
    getGovernor: () => ctx.governor || null, listLimit: config.world && config.world.maxListLimit,
    heavySettings: config.heavyEvents || null,
    harvestSettings: config.harvestRaid ? { warningMs: config.harvestRaid.warningMs,
      raidMs: config.harvestRaid.raidMs } : null,
    ...nativeOf(config),
    bump, observe, log, logger, nowMs });

  function runPass() {
    const now = clock.now();
    try {
      tail.runPass(now);
    } catch (err) {
      bump("errors");
      log(`tail pass failed - ${messageOf(err)}`);
    }
    return dispatcher.runPass(now);
  }

  const poller = createPoller({ runPass, intervalMs: settings.passIntervalMs,
    now: () => clock.now(), setTimer, onError: (err) => {
      bump("errors");
      log(`pass failed - ${messageOf(err)}`);
    } });

  try {
    const r = dispatcher.reconcile(clock.now());
    if (r.reconciled > 0 || r.lost > 0 || r.pending > 0 || r.timedOut > 0) {
      log(`reconcile reconciled=${r.reconciled} lost=${r.lost} timedOut=${r.timedOut || 0} pending=${r.pending}`);
    }
  } catch (err) {
    bump("errors");
    log(`reconcile failed - ${messageOf(err)}`);
  }
  try {
    const b = tail.bootstrap();
    if (b.ok) log(`tail at journal ${b.headId}, ${b.systems} systems`);
  } catch (err) {
    bump("errors");
    log(`tail bootstrap failed - ${messageOf(err)}`);
  }
  const armed = poller.start();
  if (!armed.ok) return { ok: false, reason: "NOTICES_TIMER_FAILED", detail: armed.reason };

  function enqueueItemsInTx(tx, items, now) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NOTICES_UNAVAILABLE" };
    const r = repo.enqueueItemsInTx(tx, items, now);
    if (r.ok) {
      if (r.inserted > 0) bump("itemsQueued", r.inserted);
      if (r.duplicates > 0) bump("itemsDuplicate", r.duplicates);
    }
    return r;
  }

  function sendUrgent(event, now) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NOTICES_UNAVAILABLE" };
    const e = event && typeof event === "object" ? event : {};
    if (!isNonNegInt(now)) return { ok: false, reason: "INVALID_INPUT", detail: "now" };
    if (typeof e.eventKey !== "string" || e.eventKey === "") {
      return { ok: false, reason: "INVALID_INPUT", detail: "eventKey" };
    }
    if (!Number.isSafeInteger(e.characterId) || e.characterId <= 0) {
      return { ok: false, reason: "INVALID_INPUT", detail: "characterId" };
    }
    if (!URGENT_KINDS.includes(e.kind)) return { ok: false, reason: "INVALID_INPUT", detail: "kind" };
    if (!isNonNegInt(e.systemId)) return { ok: false, reason: "INVALID_INPUT", detail: "systemId" };
    if (e.factionId !== null && e.factionId !== undefined && !Number.isSafeInteger(e.factionId)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "factionId" };
    }
    if (!isNonNegInt(e.at)) return { ok: false, reason: "INVALID_INPUT", detail: "at" };
    try {
      const line = tail.lineOf({ kind: e.kind, systemId: e.systemId, at: e.at,
        attacker: e.factionId === undefined ? null : e.factionId, defender: null });
      return dispatcher.sendUrgent({ eventKey: e.eventKey, characterId: e.characterId, kind: e.kind,
        systemId: e.systemId, line, eventAt: e.at }, now);
    } catch (err) {
      bump("errors");
      bump("urgentFailed");
      log(`urgent ${e.characterId} failed - ${messageOf(err)}`);
      return { ok: false, reason: "URGENT_THREW", detail: messageOf(err) };
    }
  }

  function onWarEvents(fn) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NOTICES_UNAVAILABLE" };
    if (typeof fn !== "function") return { ok: false, reason: "BAD_LISTENER" };
    if (warListeners.length >= MAX_WAR_LISTENERS) return { ok: false, reason: "TOO_MANY_LISTENERS" };
    warListeners.push(fn);
    let subscribed = true;
    return { ok: true, unsubscribe: () => {
      if (!subscribed) return;
      subscribed = false;
      const at = warListeners.indexOf(fn);
      if (at !== -1) warListeners.splice(at, 1);
    } };
  }

  function mailEventKeys(characterId, messageId) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NOTICES_UNAVAILABLE" };
    try {
      const r = store.transaction("notices.mailKeys", (db) => repo.listMailEventKeysInTx(db, { characterId,
        messageId, limit: settings.maxItemsPerMail }));
      if (!r || r.ok !== true) return { ok: false, reason: String((r && r.reason) || "TX_FAILED") };
      const v = r.value;
      if (!v || v.ok !== true) return { ok: false, reason: String((v && v.reason) || "TX_FAILED") };
      return { ok: true, eventKeys: v.eventKeys };
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "MAIL_KEYS_THREW", detail: messageOf(err) };
    }
  }

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    try {
      const f = tail.flush(clock.now());
      if (!f.ok) log(`tail flush (${reason || "stop"}) ${f.reason}`);
    } catch (err) {
      log(`tail flush failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
    warListeners.length = 0;
    state = STATE.STOPPED;
    try {
      poller.stop();
    } catch (err) {
      log(`timer stop failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
  }

  return { ok: true, notices: Object.freeze({
    getStatus: () => ({ state, passes: poller.getPasses(), sendingHeld: dispatcher.getSendingHeld(),
      ...tail.getStatus(), ...counters }),
    stop,
    enqueueItemsInTx,
    sendUrgent,
    onWarEvents,
    mailEventKeys,
  }) };
}

module.exports = { startNotices, createUnavailableNotices, COUNTER_NAMES, OBSERVE_NAMES, NOTICES_METHODS,
  MAX_WAR_LISTENERS };
