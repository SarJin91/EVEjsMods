"use strict";

const { performance } = require("node:perf_hooks");
const { newsSettingsOf, COUNTER_NAMES, OBSERVE_NAMES, NEWS_METHODS } = require("./schema");
const { weightOf } = require("./data/kinds");
const { factsOfWarViews } = require("./collect/warFacts");
const { createNewsRepository } = require("./repository");
const { createNewsTail } = require("./tail");
const { createEditions } = require("./editions");
const { boundaryAtOrBefore } = require("./cycle");
const { buildNewsView, VIEW_ID } = require("./view");
const { runTx } = require("./tx");
const { createPoller } = require("../presence/poller");
const { readFactionNames } = require("../world/sovProjection");
const { createReaders } = require("./mail/readers");
const { createMailDispatcher, MAIL_METHODS } = require("./mail/dispatcher");
const { createNewsChat, installNewsCommand, headlineOf } = require("./command");
const { sentenceOf } = require("./fallback");

const STATE = Object.freeze({ RUNNING: "running", STOPPED: "stopped" });
const READER_PRUNE_FACTOR = 4;
const RECENT_FACTS_MAX = 256;
const MS_DECIMALS = 10;

function messageOf(err) {
  return String((err && err.message) || err);
}

function createUnavailableNews(reason, detail) {
  const refusal = reason === "NEWS_DISABLED" ? "NEWS_DISABLED" : "NEWS_UNAVAILABLE";
  return Object.freeze({
    getStatus: () => ({ state: "unavailable", reason: String(reason || refusal), ...(detail ? { detail } : {}) }),
    stop: () => {},
    runPassNow: () => ({ ok: false, reason: refusal }),
    listEditions: () => ({ ok: false, reason: refusal }),
    latestHeadline: () => ({ ok: false, reason: refusal }),
    listRecentFacts: () => ({ ok: false, reason: refusal }),
  });
}

function startNews(deps) {
  const config = deps && deps.config;
  if (!config || !config.news || config.news.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const parsed = newsSettingsOf(config);
  if (!parsed.ok) return parsed;
  const s = parsed.settings;
  const ctx = deps.ctx || {};
  const adapter = deps.adapter || null;
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const persistence = ctx.persistence;
  const store = persistence && persistence.ok === true && persistence.store ? persistence.store : null;
  const journal = persistence && persistence.journal ? persistence.journal : null;
  if (!store || !journal) return { ok: false, reason: "NEWS_STORE_UNAVAILABLE" };

  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let state = STATE.RUNNING;
  let warFeed = "pending";
  let unsubscribe = null;
  let viewHandle = null;
  let writes = 0;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`news: ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](`news.${name}`, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!COUNTER_NAMES.includes(name) || !(n > 0)) return;
    counters[name] += n;
    metric("count", name, n);
  }

  function observe(name, value) {
    if (OBSERVE_NAMES.includes(name)) metric("observe", name, value);
  }

  let names = new Map();
  let namesAt = null;
  function refreshNames() {
    names = readFactionNames(adapter, logger);
    namesAt = clock.now();
  }
  function graphOf() {
    try {
      const g = ctx.graph;
      const r = g && typeof g.getGraph === "function" ? g.getGraph() : null;
      return r && r.ok && r.graph ? r.graph : null;
    } catch (_err) {
      return null;
    }
  }
  function place(systemId) {
    const graph = graphOf();
    const sys = graph && typeof graph.getSystem === "function" ? graph.getSystem(systemId) : null;
    const regionName = sys && sys.regionId != null && typeof graph.getRegionName === "function"
      ? graph.getRegionName(sys.regionId) : null;
    return { systemName: sys && sys.name ? sys.name : null, regionName: regionName || null };
  }
  const factionName = (id) => names.get(id) || null;
  function regionName(regionId) {
    const graph = graphOf();
    return graph && typeof graph.getRegionName === "function" ? graph.getRegionName(regionId) || null : null;
  }

  const repo = createNewsRepository({ weightOf });
  const tail = createNewsTail({ store, journal, repo, settings: s, place, factionName, regionName, bump, observe, log,
    nowMs });
  function knownNames() {
    const out = new Set(names.values());
    const graph = graphOf();
    if (graph && typeof graph.getSystemIds === "function" && typeof graph.getSystem === "function") {
      for (const id of graph.getSystemIds()) {
        const sys = graph.getSystem(id);
        if (sys && typeof sys.name === "string") out.add(sys.name);
      }
    }
    if (graph && typeof graph.getRegionIds === "function" && typeof graph.getRegionName === "function") {
      for (const id of graph.getRegionIds()) {
        const name = graph.getRegionName(id);
        if (typeof name === "string") out.add(name);
      }
    }
    return [...out];
  }

  const maxRows = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
    ? store.limits.maxRowsPerTransaction : Number.MAX_SAFE_INTEGER;
  const mailSeamOk = Boolean(adapter) && MAIL_METHODS.every((name) => typeof adapter[name] === "function");
  const mailState = s.mail.enabled !== true ? "off" : (mailSeamOk ? "on" : "unavailable:NO_MAIL_SEAM");
  const mailOn = mailState === "on";
  const mailPlan = mailOn ? { readerActiveMs: s.mail.readerActiveMs,
    maxRecipients: Math.max(1, Math.min(s.mail.maxRecipientsPerEdition, maxRows - 2)) } : null;
  const mailCounts = { pending: 0, sending: 0, sentLastEdition: 0 };

  const editions = createEditions({ store, repo, settings: s, bump, log, onOpening: refreshNames,
    onWrite: () => {
      writes += 1;
    },
    getChatterAi: () => ctx.chatterAi || null, knownNames, isRunning: () => state === STATE.RUNNING,
    now: () => clock.now(), mailPlan });
  const readers = mailOn || s.commandEnabled ? createReaders({ store, repo, settings: s,
    getPresence: () => ctx.presence || null, rowsCap, bump, log }) : null;
  const dispatcher = mailOn ? createMailDispatcher({ store, repo, adapter, settings: s, bump, log }) : null;
  let commandState = s.commandEnabled ? "pending" : "off";
  let uninstallCommand = null;

  function refreshMailCounts() {
    const r = runTx(store, "news.mailCounts", (db) => {
      const latest = repo.latestPublishedInTx(db);
      return repo.deliveryCountsInTx(db, latest.edition ? latest.edition.editionId : null);
    });
    if (!r.ok) return;
    mailCounts.pending = r.value.pending;
    mailCounts.sending = r.value.sending;
    mailCounts.sentLastEdition = r.value.sent;
  }

  function mailStep(now) {
    const touched = readers.touch(now);
    if (!touched.ok) return touched;
    const r = dispatcher.runPass(now);
    refreshMailCounts();
    return r;
  }

  function governorAdmits() {
    try {
      const g = ctx.governor;
      return !g || typeof g.admits !== "function" || g.admits("MAINTENANCE") !== false;
    } catch (_err) {
      return true;
    }
  }

  function rowsCap(knob) {
    const max = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
      ? store.limits.maxRowsPerTransaction : knob + 1;
    return Math.max(1, Math.min(knob, max - 1));
  }

  function onWarViews(views) {
    if (state !== STATE.RUNNING) return;
    const got = factsOfWarViews(views, { kinds: s.kinds });
    let facts = got.facts;
    const cap = rowsCap(s.maxWarFactsPerCall);
    if (facts.length > cap) {
      bump("warFactsTruncated", facts.length - cap);
      facts = facts.slice(0, cap);
    }
    if (facts.length === 0) return;
    const r = runTx(store, "news.war", (db) => repo.upsertFactsInTx(db, facts, clock.now()));
    if (!r.ok) {
      bump("errors");
      log(`war facts ${r.reason}`);
      return;
    }
    bump("warFacts", facts.length);
    if (r.value.inserted > 0) bump("factsInserted", r.value.inserted);
    if (r.value.late > 0) bump("factsLate", r.value.late);
  }

  function prune(now) {
    const boundaryAt = boundaryAtOrBefore(now, s);
    const r = runTx(store, "news.prune", (db) => repo.pruneInTx(db, { factsBefore: now - s.factRetentionMs,
      openBefore: boundaryAt - s.maxFactAgeMs, keepEditions: s.keepEditions, batch: rowsCap(s.pruneBatch) }));
    if (!r.ok) return r;
    if (r.value.editions > 0) writes += 1;
    let readersPruned = 0;
    if (readers) {
      const p = runTx(store, "news.readersPrune", (db) => repo.pruneReadersInTx(db,
        { before: now - READER_PRUNE_FACTOR * s.mail.readerActiveMs, limit: rowsCap(s.pruneBatch) }));
      if (!p.ok) return p;
      readersPruned = p.value.readers;
    }
    return { ok: true, facts: r.value.facts, editions: r.value.editions, readers: readersPruned };
  }

  function runPass(now) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NEWS_UNAVAILABLE" };
    if (!governorAdmits()) {
      bump("deferrals");
      return { ok: true, deferred: true };
    }
    const t0 = nowMs();
    const out = { ok: true, deferred: false, tail: null, editions: null, mail: null, prune: null };
    try {
      if (namesAt === null || now - namesAt >= s.cycleMs) refreshNames();
      const parts = [["tail", () => tail.runPass(now)], ["editions", () => editions.runStep(now)]];
      if (dispatcher) parts.push(["mail", () => mailStep(now)]);
      parts.push(["prune", () => prune(now)]);
      for (const [part, fn] of parts) {
        let r;
        try {
          r = fn();
        } catch (err) {
          r = { ok: false, reason: "THREW", detail: messageOf(err) };
        }
        out[part] = r;
        if (!r.ok) {
          bump("errors");
          log(`${part} ${r.reason}${r.detail ? ` - ${r.detail}` : ""}`);
        }
      }
    } finally {
      observe("passMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    }
    return out;
  }

  const poller = createPoller({ runPass: () => runPass(clock.now()), intervalMs: s.passIntervalMs,
    now: () => clock.now(), setTimer: deps.setTimer, onError: (err) => {
      bump("errors");
      log(`pass failed - ${messageOf(err)}`);
    } });

  try {
    refreshNames();
    const b = tail.bootstrap(clock.now());
    if (b.ok) log(`tail at journal ${b.cursor} (head ${b.head}${b.created ? ", new cursor" : ""})`);
    else log(`tail bootstrap ${b.reason}`);
    const l = editions.load();
    if (!l.ok) log(`status read ${l.reason}`);
    if (dispatcher) {
      const rc = dispatcher.reconcile(clock.now());
      if (rc.ok) log(`mail reconcile sent=${rc.reconciled} lost=${rc.lost} held=${rc.held}`);
      refreshMailCounts();
    }
  } catch (err) {
    bump("errors");
    log(`bootstrap failed - ${messageOf(err)}`);
  }

  try {
    const n = ctx.notices;
    const sub = n && typeof n.onWarEvents === "function" ? n.onWarEvents(onWarViews)
      : { ok: false, reason: "NOTICES_UNAVAILABLE" };
    if (sub && sub.ok === true && typeof sub.unsubscribe === "function") {
      unsubscribe = sub.unsubscribe;
      warFeed = "on";
    } else {
      warFeed = `unavailable:${String((sub && sub.reason) || "NO_RESULT")}`;
      log(`war feed ${warFeed}`);
    }
  } catch (err) {
    warFeed = "unavailable:SUBSCRIBE_THREW";
    log(`war feed failed - ${messageOf(err)}`);
  }

  function getStatus() {
    const mail = { state: mailState, pending: mailCounts.pending, sending: mailCounts.sending,
      sentLastEdition: mailCounts.sentLastEdition, lastError: dispatcher ? dispatcher.getLastError() : null };
    return { state, warFeed, ...tail.getStatus(), ...editions.getStatus(clock.now()), mail, command: commandState,
      passes: poller.getPasses(), ...counters };
  }

  const views = ctx.views;
  if (views && typeof views.registerView === "function") {
    const r = views.registerView(VIEW_ID, buildNewsView({ store, repo, settings: s, getStatus,
      getWrites: () => writes }));
    if (r && r.ok) viewHandle = r;
    else log(`view registration ${(r && r.reason) || "failed"}`);
  }

  if (s.commandEnabled && readers) {
    const chat = createNewsChat({ store, repo, settings: s, readers, clock, chat: config.frontChat || null,
      isRunning: () => state === STATE.RUNNING, bump, log });
    const installed = installNewsCommand(adapter, chat);
    if (installed.ok) {
      uninstallCommand = installed.uninstall;
      commandState = "on";
    } else {
      commandState = `unavailable:${installed.reason}`;
      log(`command ${commandState}`);
    }
  }

  const armed = poller.start();
  if (!armed.ok) {
    if (unsubscribe) unsubscribe();
    if (uninstallCommand) uninstallCommand();
    if (viewHandle) viewHandle.unregister();
    return { ok: false, reason: "NEWS_TIMER_FAILED", detail: armed.reason };
  }

  function listEditions(opts) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NEWS_UNAVAILABLE" };
    const want = opts && Number.isSafeInteger(opts.limit) ? opts.limit : s.observerEditions;
    const limit = Math.max(1, Math.min(s.keepEditions, want));
    const r = runTx(store, "news.list", (db) => repo.listEditionsInTx(db, { limit }));
    return r.ok ? { ok: true, editions: r.value.editions } : r;
  }

  function latestHeadline() {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NEWS_UNAVAILABLE" };
    try {
      if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
        return { ok: false, reason: "TX_ACTIVE" };
      }
      const r = runTx(store, "news.read", (db) => repo.latestPublishedInTx(db));
      if (!r.ok) return r;
      const e = r.value.edition;
      return { ok: true, edition: e ? headlineOf(e) : null };
    } catch (err) {
      return { ok: false, reason: "NEWS_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  function listRecentFacts(opts) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NEWS_UNAVAILABLE" };
    try {
      const since = opts && opts.since;
      const limit = opts && opts.limit;
      if (!Number.isSafeInteger(since) || since < 0) return { ok: false, reason: "SINCE_INVALID" };
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECENT_FACTS_MAX) {
        return { ok: false, reason: "LIMIT_INVALID" };
      }
      if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
        return { ok: false, reason: "TX_ACTIVE" };
      }
      const r = runTx(store, "news.read", (db) => repo.listRecentFactsInTx(db, { since, limit }));
      if (!r.ok) return r;
      return { ok: true, facts: r.value.facts.map((f) => ({ kind: f.kind, at: f.at, systemId: f.systemId,
        text: sentenceOf(f, "en") })) };
    } catch (err) {
      return { ok: false, reason: "NEWS_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    for (const [what, fn] of [["unsubscribe", unsubscribe], ["timer stop", () => poller.stop()],
      ["view unregister", viewHandle ? () => viewHandle.unregister() : null], ["command uninstall", uninstallCommand]]) {
      if (typeof fn !== "function") continue;
      try {
        fn();
      } catch (err) {
        log(`${what} failed (${reason || "stop"}) - ${messageOf(err)}`);
      }
    }
    unsubscribe = null;
    viewHandle = null;
    uninstallCommand = null;
    if (commandState === "on") commandState = "off";
  }

  const facade = { getStatus, stop, runPassNow: (now) => runPass(Number.isSafeInteger(now) ? now : clock.now()),
    listEditions, latestHeadline, listRecentFacts };
  return { ok: true, news: Object.freeze(Object.fromEntries(NEWS_METHODS.map((m) => [m, facade[m]]))) };
}

module.exports = { startNews, createUnavailableNews };
