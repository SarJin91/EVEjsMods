"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { isModuleEnabled } = require("../../config");
const { createRateLimiter, WINDOW_MS } = require("../frontChat/rateLimit");
const { systemsWithin } = require("../notices/recipients");
const { buildSnapshot } = require("./readModel");
const { toWireV1, asciiText, WIRE_VERSION } = require("./wire");
const { COMMAND_NAME, FAIL_REPLY, matchBoardCommand, createBoardChat } = require("./chat");
const { createPinRepository, isRef } = require("./pinRepository");
const { PIN_REF_PREFIX } = require("./schema");
const { createNearby } = require("./nearby");
const { createWanted } = require("./wanted");
const prefsRepo = require("./prefsRepository");
const { createLoginOpen } = require("./loginOpen");
const { defaultSetTimer } = require("../presence/poller");

const SERVICE_NAME = "lneBoardSvc";
const NOTIFY_OPEN = "OnLneBoardOpen";
const CLIENT_SOURCE = path.join(__dirname, "..", "..", "client", "board.py");
const COUNTER_NAMES = Object.freeze(["reads", "rateLimited", "busy", "refused", "errors", "opens", "openNoSession",
  "reports", "reportSuppressed", "composed", "composeSkipped",
  "pins", "pinsAlready", "unpins", "pinRefused", "pinsPruned",
  "nearSourceRefused", "nearSourceOff", "frontReads", "frontCacheHits", "frontRefused", "newsReads", "newsCacheHits",
  "newsRefused",
  "autoOpenScheduled", "autoOpenSent", "autoOpenRefused", "autoOpenDropped", "prefsWrites", "prefsReadFailed",
  "wantedReads", "wantedRefused"]);
const METRIC_READ_MS = "jobBoard.readMs";
const FACADE_METHODS = Object.freeze(["getStatus", "stop", "readBoard", "open", "prefsOf", "applySwitch"]);
const SWITCH_OPEN_AT_LOGIN = "openAtLogin";
const UNSUPPORTED_BUILD = "UNSUPPORTED_BUILD";
const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });
const WORK_CLASS = "MAINTENANCE";
const UNAVAILABLE = "JOB_BOARD_UNAVAILABLE";
const HOOK_OK = Object.freeze(["HOOKED", "WRAPPED"]);
const JOB_OPEN = "OPEN";
const MY_DONE = "DONE";
const MAX_DETAIL = 120;
const MAX_REPORT_ITEMS = 64;
const MAX_REPORT_ITEM_CHARS = 96;
const MS_DECIMALS = 10;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createUnavailableJobBoard(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: UNAVAILABLE });
  return Object.freeze({
    getStatus: () => ({ state: "unavailable", reason: String(reason || UNAVAILABLE),
      ...(detail ? { detail: String(detail) } : {}) }),
    stop: () => {},
    readBoard: () => refusal,
    open: () => refusal,
    prefsOf: () => refusal,
    applySwitch: () => refusal,
  });
}

function onOffOf(value) {
  if (value === true || value === "on") return true;
  if (value === false || value === "off") return false;
  return null;
}

function perCharacterLimiter(cooldownMs, maxTracked) {
  const perMinute = Math.max(1, maxTracked) * Math.max(1, Math.ceil(WINDOW_MS / Math.max(1, cooldownMs)));
  return createRateLimiter({ cooldownMs, maxPerMinute: perMinute, maxTracked });
}

function startJobBoard(deps) {
  const config = deps && deps.config;
  const settings = config && config.jobBoard;
  if (!settings || settings.enabled !== true || !isModuleEnabled(config, "world")) {
    return { ok: false, reason: "disabled_by_config" };
  }
  const adapter = deps.adapter || null;
  if (!adapter || typeof adapter.registerClientService !== "function") {
    return { ok: false, reason: "adapter_unavailable" };
  }
  const ctx = deps.ctx || {};
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let state = STATE.STARTING;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`jobBoard: ${line}`);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!COUNTER_NAMES.includes(name) || !(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`jobBoard.${name}`, n);
    } catch (_err) {
    }
  }

  function observe(value) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_READ_MS, value);
    } catch (_err) {
    }
  }

  const hook = (() => {
    try {
      return typeof adapter.boardHookState === "function" ? adapter.boardHookState() : { status: "ABSENT" };
    } catch (_err) {
      return { status: "ABSENT" };
    }
  })();
  if (hook.line) log(hook.line);
  const hookOk = HOOK_OK.includes(hook.status);
  let delivery = null;
  let payloadBytes = 0;
  let deliveryReason = null;
  if (hookOk) {
    let source = null;
    try {
      source = typeof deps.readClientSource === "function" ? deps.readClientSource()
        : fs.readFileSync(CLIENT_SOURCE, "utf8");
    } catch (err) {
      deliveryReason = `CLIENT_SOURCE:${messageOf(err)}`;
    }
    if (source !== null) {
      const published = adapter.publishBoardDelivery({ source: String(source),
        maxOwnBytes: settings.maxClientPayloadBytes, log: logger });
      if (published && published.ok === true) {
        delivery = published.delivery;
        payloadBytes = published.bytes;
      } else {
        deliveryReason = `${(published && published.reason) || "CLIENT_SOURCE"}`
          + `${published && published.detail ? `:${published.detail}` : ""}`;
        log(`LNE_BOARD_UI:UNAVAILABLE:${deliveryReason}`);
      }
    }
  }

  let readLimiter = perCharacterLimiter(settings.minCallIntervalMs, settings.maxTrackedCharacters);
  let reportLimiter = perCharacterLimiter(settings.reportMinIntervalMs, settings.maxTrackedCharacters);
  let pinLimiter = perCharacterLimiter(settings.minCallIntervalMs, settings.maxTrackedCharacters);
  const pinsOn = settings.pinsEnabled === true;
  const pinRepo = createPinRepository();
  const txRows = config.persistence && Number.isSafeInteger(config.persistence.maxRowsPerTransaction)
    ? config.persistence.maxRowsPerTransaction : settings.pinPruneBatch + settings.maxPinsPerCharacter + 1;
  const pinPruneBatch = Math.max(1, Math.min(settings.pinPruneBatch, txRows - settings.maxPinsPerCharacter - 1));
  let warCache = null;
  let memoGraph = null;
  const memo = new Map();
  let memoEntries = 0;
  const deliverySeen = { composed: 0, skipped: 0 };

  function syncDelivery() {
    if (!delivery) return;
    try {
      const s = delivery.stats();
      bump("composed", s.composed - deliverySeen.composed);
      bump("composeSkipped", s.skipped - deliverySeen.skipped);
      deliverySeen.composed = s.composed;
      deliverySeen.skipped = s.skipped;
    } catch (_err) {
    }
  }

  function admitted() {
    try {
      const g = ctx.governor;
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function graphOf() {
    try {
      const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
      return r && r.ok === true && r.graph ? r.graph : null;
    } catch (_err) {
      return null;
    }
  }

  function distancesFrom(graph, systemId) {
    if (!graph || !Number.isSafeInteger(systemId) || systemId <= 0) return null;
    if (memoGraph !== graph) {
      memo.clear();
      memoEntries = 0;
      memoGraph = graph;
    }
    const hit = memo.get(systemId);
    if (hit) {
      memo.delete(systemId);
      memo.set(systemId, hit);
      return hit;
    }
    const map = systemsWithin(graph, systemId, settings.nearbyMaxJumps);
    memo.set(systemId, map);
    memoEntries += map.size;
    while (memo.size > 1 && (memo.size > settings.distanceMemoSystems || memoEntries > settings.distanceMemoMaxEntries)) {
      const oldest = memo.keys().next().value;
      memoEntries -= memo.get(oldest).size;
      memo.delete(oldest);
    }
    return map;
  }

  function readWars(now) {
    if (settings.warCacheTtlMs > 0 && warCache && now - warCache.at < settings.warCacheTtlMs && now >= warCache.at) {
      return warCache.result;
    }
    const wc = ctx.warContracts;
    const result = wc && typeof wc.listForBoard === "function" ? wc.listForBoard({})
      : { ok: false, reason: "WAR_CONTRACTS_UNAVAILABLE" };
    warCache = { at: now, result };
    return result;
  }

  function storeOf() {
    const p = ctx.persistence;
    return p && p.ok === true && p.store && typeof p.store.transaction === "function" ? p.store : null;
  }

  function boardInTx(db, characterId) {
    const fj = ctx.frontJobs;
    return fj && typeof fj.listBoard === "function" ? fj.listBoard(db, characterId)
      : { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" };
  }

  function livePinsInTx(db, characterId, jobs, now) {
    const listed = pinRepo.listOfCharacterInTx(db, characterId);
    if (!listed.ok) return listed;
    const closed = jobs && jobs.ok === true && Array.isArray(jobs.jobs)
      ? new Set(jobs.jobs.filter((j) => j.state !== JOB_OPEN || j.myState === MY_DONE).map((j) => String(j.jobId)))
      : new Set();
    let deleted = 0;
    if (listed.rows.some((p) => p.expiresAt <= now)) {
      const d = pinRepo.deleteExpiredOfCharacterInTx(db, characterId, now);
      if (!d.ok) return d;
      deleted += d.deleted;
    }
    const gone = listed.rows.filter((p) => p.expiresAt > now && closed.has(p.jobRef)).map((p) => p.jobRef);
    if (gone.length > 0) {
      const d = pinRepo.deleteInTx(db, characterId, gone);
      if (!d.ok) return d;
      deleted += d.deleted;
    }
    const rows = listed.rows.filter((p) => p.expiresAt > now && !closed.has(p.jobRef));
    return { ok: true, rows, deleted };
  }

  function readCharacterInTx(db, characterId, now) {
    const jobs = boardInTx(db, characterId);
    let pins = null;
    if (pinsOn) pins = livePinsInTx(db, characterId, jobs, now);
    const q = { characterId, sinceMs: now - settings.mineWindowMs, limit: settings.maxMineRows };
    const fj = ctx.frontJobs;
    const wc = ctx.warContracts;
    const done = fj && typeof fj.listDoneForBoard === "function" ? fj.listDoneForBoard(db, q)
      : { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" };
    const awards = wc && typeof wc.listAwardsForBoard === "function" ? wc.listAwardsForBoard(db, q)
      : { ok: false, reason: "WAR_CONTRACTS_UNAVAILABLE" };
    return { jobs, pins, done, awards };
  }

  function readBoard(characterId, systemId) {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    try {
      syncDelivery();
      if (!Number.isSafeInteger(characterId) || characterId <= 0) {
        bump("refused");
        return { ok: false, reason: "NO_CHARACTER" };
      }
      const now = clock.now();
      if (!readLimiter.take(characterId, now).ok) {
        bump("rateLimited");
        return { ok: false, reason: "RATE_LIMIT" };
      }
      if (!admitted()) {
        bump("busy");
        return { ok: false, reason: "BUSY" };
      }
      const t0 = nowMs();
      const store = storeOf();
      let mineInput;
      if (store) {
        const r = store.transaction("jobBoard.read", (db) => readCharacterInTx(db, characterId, now));
        mineInput = r.ok ? r.value : { jobs: { ok: false, reason: "JOB_BOARD_TX_FAILED" },
          pins: pinsOn ? { ok: false, reason: "JOB_BOARD_TX_FAILED" } : null,
          done: { ok: false, reason: "JOB_BOARD_TX_FAILED" }, awards: { ok: false, reason: "JOB_BOARD_TX_FAILED" } };
        if (!r.ok) bump("errors");
      } else {
        mineInput = { jobs: boardInTx(null, characterId), pins: null,
          done: { ok: false, reason: "STORE_UNAVAILABLE" }, awards: { ok: false, reason: "STORE_UNAVAILABLE" } };
      }
      const { jobs, pins, done, awards } = mineInput;
      if (pins && pins.ok === true) bump("pinsPruned", pins.deleted);
      const wars = readWars(now);
      const graph = graphOf();
      const viewerSys = Number.isSafeInteger(systemId) && systemId > 0 ? systemId : null;
      const distances = distancesFrom(graph, viewerSys);
      const names = Object.freeze({
        system: (id) => {
          const v = graph && typeof graph.getSystem === "function" ? graph.getSystem(id) : null;
          return v && v.name ? String(v.name) : null;
        },
        faction: (id) => factionNames.get(id) || null,
      });
      const pinsUi = pinsOn && store !== null;
      const nearbyInput = nearbyOn ? nearby.read({ systemId: viewerSys }, distances, now, graph) : undefined;
      const wantedInput = wanted.read(distances, now);
      const snapshot = buildSnapshot({ now, viewer: { characterId, systemId: viewerSys }, jobs, wars,
        jumpsOf: (id) => (distances && distances.has(id) ? distances.get(id) : null), names,
        limits: { maxJobRows: settings.maxJobRows, maxWarRows: settings.maxWarRows, maxMineRows: settings.maxMineRows,
          maxNearRows: settings.eventsMaxRows, newsMaxChars: settings.newsMaxChars },
        pinsOn: pinsUi, pins, done, awards, nearby: nearbyInput,
        ...(wantedInput ? { wanted: wantedInput } : {}),
        revealSignatures: settings.eventsRevealSignatures === true });
      const wire = toWireV1(snapshot, { pollMs: settings.clientPollMs, travel: true, contracts: snapshot.warsOk,
        pins: pinsUi });
      bump("reads");
      observe(Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
      return { ok: true, wire };
    } catch (err) {
      bump("errors");
      log(`read failed - ${messageOf(err)}`);
      return { ok: false, reason: UNAVAILABLE, detail: messageOf(err) };
    }
  }

  let factionNames = new Map();
  try {
    const r = typeof adapter.readFactionNames === "function" ? adapter.readFactionNames() : null;
    if (r && r.ok && r.names instanceof Map) factionNames = r.names;
  } catch (_err) {
  }

  const nearbyOn = settings.eventsEnabled === true || settings.frontEnabled === true || settings.newsEnabled === true;
  const nearby = createNearby({ settings, frontChatSettings: config.frontChat || {},
    observerSettings: config.observer || {}, ctx, clock, factionNames, telemetry, nowMs, storeOf, bump });
  const wanted = createWanted({ ctx, bump });

  function report(req) {
    try {
      const characterId = req && req.characterId;
      if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: false, reason: "NO_CHARACTER" };
      const args = Array.isArray(req.args) ? req.args : [];
      const proto = Number.isSafeInteger(args[0]) ? args[0] : 0;
      const build = Number.isSafeInteger(args[1]) ? args[1] : 0;
      const items = (Array.isArray(args[2]) ? args[2] : []).slice(0, MAX_REPORT_ITEMS)
        .map((item) => asciiText(item, MAX_REPORT_ITEM_CHARS).replace(/\s/g, "_")).filter((t) => t !== "");
      noteSession(req, !items.some((t) => t.endsWith(UNSUPPORTED_BUILD)));
      const taken = reportLimiter.take(characterId, clock.now());
      if (!taken.ok) {
        bump("reportSuppressed");
        return { ok: false, reason: "RATE_LIMIT", retryMs: Number.isSafeInteger(taken.waitMs) ? taken.waitMs : 0 };
      }
      bump("reports");
      log(`LNE_BOARD_UI:PROBE ${characterId} proto=${proto} build=${build} ${items.join(" ")}`.trimEnd());
      return { ok: true };
    } catch (err) {
      bump("errors");
      log(`report failed - ${messageOf(err)}`);
      return { ok: false, reason: UNAVAILABLE };
    }
  }

  function getBoard(req) {
    noteSession(req, true);
    const r = readBoard(req && req.characterId, req && req.systemId);
    return r.ok ? r.wire : { v: WIRE_VERSION, ok: false, reason: r.reason };
  }

  function refOf(req) {
    if (!req || req.badArgs === true || !Array.isArray(req.args)) return null;
    const ref = req.args[0];
    return isRef(ref) && ref.startsWith(PIN_REF_PREFIX) ? ref : null;
  }

  function pinInTx(db, characterId, ref, now) {
    const pruned = pinRepo.pruneExpiredInTx(db, now, pinPruneBatch);
    let deleted = pruned.ok ? pruned.deleted : 0;
    const jobs = boardInTx(db, characterId);
    if (!jobs || jobs.ok !== true || !Array.isArray(jobs.jobs)) {
      return { deleted, result: { ok: false, reason: "JOB_NOT_OPEN",
        detail: String((jobs && jobs.reason) || "NO_RESULT") } };
    }
    const job = jobs.jobs.find((j) => j.jobId === ref);
    if (!job || job.state !== JOB_OPEN || job.myState === MY_DONE || !(Number(job.expiresAt) > now)) {
      return { deleted, result: { ok: false, reason: "JOB_NOT_OPEN" } };
    }
    const live = livePinsInTx(db, characterId, jobs, now);
    if (!live.ok) return { deleted, result: { ok: false, reason: UNAVAILABLE, detail: String(live.detail || live.reason) } };
    deleted += live.deleted;
    if (live.rows.some((p) => p.jobRef === ref)) return { deleted, result: { ok: true, already: true } };
    if (live.rows.length >= settings.maxPinsPerCharacter) return { deleted, result: { ok: false, reason: "PIN_LIMIT" } };
    const ins = pinRepo.insertInTx(db, { characterId, jobRef: ref, pinnedAt: now, expiresAt: Number(job.expiresAt) });
    if (!ins.ok) return { deleted, result: { ok: false, reason: UNAVAILABLE, detail: String(ins.detail || ins.reason) } };
    return { deleted, result: { ok: true, already: !ins.inserted } };
  }

  function pinRequest(req, on) {
    noteSession(req, true);
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    const refuse = (reason, detail) => {
      bump("pinRefused");
      return { ok: false, reason, ...(detail ? { detail: String(detail).slice(0, MAX_DETAIL) } : {}) };
    };
    try {
      if (!pinsOn) return refuse("PINS_DISABLED");
      const characterId = req && req.characterId;
      if (!Number.isSafeInteger(characterId) || characterId <= 0) return refuse("NO_CHARACTER");
      const ref = refOf(req);
      if (ref === null) return refuse("BAD_REF");
      const now = clock.now();
      if (!pinLimiter.take(characterId, now).ok) return refuse("RATE_LIMIT");
      if (!admitted()) return refuse("BUSY");
      const store = storeOf();
      if (!store) return refuse(UNAVAILABLE, "STORE_UNAVAILABLE");
      const r = on ? store.transaction("jobBoard.pin", (db) => pinInTx(db, characterId, ref, now))
        : store.transaction("jobBoard.unpin", (db) => {
          const d = pinRepo.deleteInTx(db, characterId, [ref]);
          return { deleted: 0, result: d.ok ? { ok: true, already: d.deleted === 0 }
            : { ok: false, reason: UNAVAILABLE, detail: String(d.detail || d.reason) } };
        });
      if (!r.ok) {
        bump("errors");
        return refuse(UNAVAILABLE, `${r.reason}${r.error ? ` ${messageOf(r.error)}` : ""}`);
      }
      bump("pinsPruned", r.value.deleted);
      const result = r.value.result;
      if (result.ok !== true) return refuse(result.reason, result.detail);
      if (!on) bump("unpins");
      else bump(result.already ? "pinsAlready" : "pins");
      return result;
    } catch (err) {
      bump("errors");
      log(`${on ? "pin" : "unpin"} failed - ${messageOf(err)}`);
      return { ok: false, reason: UNAVAILABLE, detail: messageOf(err) };
    }
  }

  let service = null;
  let svcStatus = "off";
  try {
    const registered = adapter.registerClientService(deps.world || null, { name: SERVICE_NAME,
      handlers: { GetBoard: getBoard, Report: report, Pin: (req) => pinRequest(req, true),
        Unpin: (req) => pinRequest(req, false) }, log: (line) => log(line) });
    if (registered && registered.ok === true) {
      service = registered;
      svcStatus = "ok";
    } else {
      svcStatus = String((registered && registered.reason) || "NO_RESULT");
      log(`LNE_BOARD_UI:UNAVAILABLE:${svcStatus}${registered && registered.detail ? ` ${registered.detail}` : ""}`);
    }
  } catch (err) {
    svcStatus = "REGISTER_FAILED";
    log(`LNE_BOARD_UI:UNAVAILABLE:REGISTER_FAILED ${messageOf(err)}`);
  }
  if (delivery && service) delivery.setReady(true);

  function windowReason() {
    if (!hookOk) return `hook:${hook.status}`;
    if (!delivery) return deliveryReason || "CLIENT_SOURCE";
    if (!service) return `svc:${svcStatus}`;
    return null;
  }

  function open(characterId) {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    try {
      syncDelivery();
      const why = windowReason();
      if (why !== null) {
        bump("refused");
        return { ok: false, reason: why };
      }
      const sent = adapter.sendClientNotification(characterId, NOTIFY_OPEN, { v: WIRE_VERSION });
      if (sent && sent.ok === true) {
        bump("opens");
        return { ok: true };
      }
      bump("openNoSession");
      return { ok: false, reason: String((sent && sent.reason) || "SEND_FAILED") };
    } catch (err) {
      bump("errors");
      return { ok: false, reason: UNAVAILABLE, detail: messageOf(err) };
    }
  }

  const loginOn = settings.openAtLoginEnabled === true;

  function prefsOf(characterId) {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    try {
      if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: false, reason: "NO_CHARACTER" };
      const store = storeOf();
      if (!store) return { ok: false, reason: "STORE_UNAVAILABLE" };
      const r = store.transaction("jobBoard.prefsRead", (db) => prefsRepo.getInTx(db, characterId));
      const v = r.ok ? r.value : null;
      if (!v || v.ok !== true) {
        return { ok: false, reason: "STORE_UNAVAILABLE",
          detail: String((v && (v.detail || v.reason)) || r.reason || "NO_RESULT").slice(0, MAX_DETAIL) };
      }
      return { ok: true, openAtLogin: v.openAtLogin, serverOn: loginOn };
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "STORE_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  const loginOpen = createLoginOpen({ delayMs: settings.loginOpenDelayMs, maxPending: settings.maxTrackedCharacters,
    enabled: loginOn, ready: () => state === STATE.RUNNING && windowReason() === null,
    readPref: prefsOf, open,
    setTimer: typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer, bump });

  function noteSession(req, eligible) {
    try {
      if (!req || typeof req !== "object") return;
      loginOpen.note(req.characterId, req.session === undefined ? null : req.session, eligible);
    } catch (_err) {
    }
  }

  function applySwitch(characterId, id, value) {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    try {
      const on = onOffOf(value);
      if (id !== SWITCH_OPEN_AT_LOGIN || on === null) return { ok: false, reason: "BAD_VALUE" };
      if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: false, reason: "NO_CHARACTER" };
      const store = storeOf();
      if (!store) return { ok: false, reason: "SAVE_FAILED" };
      const nowMs = clock.now();
      const r = store.transaction("jobBoard.prefs", (db) => prefsRepo.setInTx(db, { characterId, on, nowMs }));
      if (!r.ok || !r.value || r.value.ok !== true) {
        bump("errors");
        log(`switch save failed - ${String((r.value && (r.value.detail || r.value.reason)) || r.reason || "NO_RESULT")
          .slice(0, MAX_DETAIL)}`);
        return { ok: false, reason: "SAVE_FAILED" };
      }
      bump("prefsWrites");
      if (!on) loginOpen.cancel(characterId);
      return { ok: true, value: on ? "on" : "off" };
    } catch (err) {
      bump("errors");
      log(`switch failed - ${messageOf(err)}`);
      return { ok: false, reason: "SAVE_FAILED" };
    }
  }

  let chat = "off";
  const boardChat = createBoardChat({ settings, frontChatSettings: config.frontChat || {}, open, prefsOf, applySwitch,
    clock, isRunning: () => state === STATE.RUNNING, log });
  if (settings.chatEnabled === true) {
    let r;
    try {
      r = typeof adapter.installChatCommand === "function"
        ? adapter.installChatCommand({ name: COMMAND_NAME, match: matchBoardCommand, handle: boardChat.handle,
          failReply: FAIL_REPLY })
        : { ok: false, reason: "adapter_unavailable" };
    } catch (err) {
      r = { ok: false, reason: "THREW", detail: messageOf(err) };
    }
    chat = r && r.ok === true ? "installed" : "unavailable";
    if (chat !== "installed") {
      log(`chat refused - ${(r && r.reason) || "NO_RESULT"}${r && r.detail ? `:${r.detail}` : ""}`);
    }
  }

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    loginOpen.clear();
    try {
      if (delivery) delivery.setReady(false);
      if (delivery && typeof adapter.withdrawBoardDelivery === "function") adapter.withdrawBoardDelivery(delivery);
    } catch (err) {
      log(`delivery withdraw failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
    try {
      if (service) service.unregister();
    } catch (err) {
      log(`service detach failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
    if (chat === "installed") {
      chat = "off";
      try {
        adapter.uninstallChatCommand(COMMAND_NAME);
      } catch (err) {
        log(`chat uninstall failed (${reason || "stop"}) - ${messageOf(err)}`);
      }
    }
    readLimiter = perCharacterLimiter(settings.minCallIntervalMs, settings.maxTrackedCharacters);
    reportLimiter = perCharacterLimiter(settings.reportMinIntervalMs, settings.maxTrackedCharacters);
    pinLimiter = perCharacterLimiter(settings.minCallIntervalMs, settings.maxTrackedCharacters);
    warCache = null;
    nearby.clear();
    memo.clear();
    memoEntries = 0;
    memoGraph = null;
  }

  state = STATE.RUNNING;
  const status = `hook:${hook.status} svc:${svcStatus} payload=${payloadBytes}`;
  const pinsStatus = pinsOn ? "on" : "off";
  const sections = ["events", "front", "news"].filter((k) => settings[`${k}Enabled`] === true).join(",") || "none";
  log(`ready board=${status} window=${windowReason() === null ? "on" : `off:${windowReason()}`} chat=${chat}`
    + ` pins=${pinsStatus} sections=${sections} login=${loginOn ? "on" : "off"}`);

  return { ok: true, jobBoard: Object.freeze({
    getStatus: () => {
      syncDelivery();
      return { state, board: status, window: windowReason() === null ? "on" : `off:${windowReason()}`, chat,
        pins: pinsStatus, login: loginOn ? "on" : "off", pendingOpens: loginOpen.pendingCount(),
        delivery: delivery ? delivery.stats() : null, memo: memo.size, memoEntries, counters: { ...counters } };
    },
    stop,
    readBoard,
    open,
    prefsOf,
    applySwitch,
  }) };
}

module.exports = { SERVICE_NAME, NOTIFY_OPEN, COUNTER_NAMES, FACADE_METHODS, SWITCH_OPEN_AT_LOGIN, startJobBoard,
  createUnavailableJobBoard };
