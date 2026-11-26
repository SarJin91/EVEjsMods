"use strict";

const { performance } = require("node:perf_hooks");
const { isModuleEnabled } = require("../../config");
const killObservation = require("../adapter/killObservation");
const scanObservation = require("../adapter/scanObservation");
const { createPoller } = require("../presence/poller");
const { LP_CORP_BY_FACTION } = require("../world/liberation/rewardSchema");
const { createFrontJobRepository } = require("./repository");
const { createPayoutPump } = require("./payoutPump");
const { ensureBoardInTx } = require("./generator");
const { applyContributionInTx } = require("./progress");
const { settleClearInTx } = require("./kinds/clear");
const { settleDeliverInTx } = require("./kinds/deliver");
const { applyScanInTx } = require("./kinds/scan");
const { boardDayOf } = require("./rules");
const { KIND } = require("./schema");
const { createJobMail } = require("./mail");
const { COMMAND_NAME, FAIL_REPLY, matchJobsCommand, createJobsChat } = require("./chat");

const COUNTER_NAMES = Object.freeze(["passes", "deferrals", "boardsCreated", "boardEmpty", "jobsCreated",
  "jobsExpired", "contributions", "completions", "dailyCapped", "killsIgnored", "errors", "payoutsPaid",
  "payoutsFailed", "legRetries", "legDuplicates", "keyReused", "seamsMissing", "pruned",
  "chatReplies", "chatRateLimited", "chatErrors", "boardMails", "boardMailSkipped", "doneMails", "noticeRefused",
  "clearSettled", "clearLost", "deliverSettled", "deliverLost", "refChecks", "nudges",
  "scansObserved", "scansMatched", "scanErrors",
  "scanSeamMissing",
  "escortCredited", "escortMiss", "escortErrors"]);
const OBSERVE_NAMES = Object.freeze(["passMs", "payoutMs", "chatReplyMs"]);
const FACADE_METHODS = Object.freeze(["getStatus", "stop", "onNpcKill", "runPass", "listBoard", "onEscortCrossing",
  "listDoneForBoard"]);
const STATE = Object.freeze({ RUNNING: "running", STOPPED: "stopped" });
const WORK_CLASS = "MAINTENANCE";
const CLOSING = Object.freeze(["JOB_CLOSED", "EXPIRED", "JOB_NOT_FOUND"]);
const MAX_DETAIL = 160;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createUnavailableFrontJobs(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: "FRONT_JOBS_UNAVAILABLE" });
  return Object.freeze({
    getStatus: () => ({ state: "unavailable", reason: String(reason || "FRONT_JOBS_UNAVAILABLE"),
      ...(detail ? { detail: String(detail) } : {}) }),
    stop: () => {},
    onNpcKill: () => refusal,
    runPass: () => refusal,
    listBoard: () => refusal,
    onEscortCrossing: () => refusal,
    listDoneForBoard: () => refusal,
  });
}

function txError(r) {
  return `${r.reason}${r.error ? ` ${messageOf(r.error)}` : ""}`;
}

function createSitesReader() {
  const sites = require("../events/sites/siteRepository");
  return Object.freeze({ getByKeyInTx: sites.getByKeyInTx, listVisibleBySystemInTx: sites.listVisibleBySystemInTx });
}

function createOffersReader(clock) {
  const { createOfferRepository } = require("../economy/trade/offerRepository");
  const readOnly = () => {
    throw new Error("frontJobs: the offer reader is read only");
  };
  const offers = createOfferRepository({ journal: { applyOnce: readOnly }, budgets: { adjustInDb: readOnly },
    ids: { next: readOnly }, clock });
  return Object.freeze({ getOffer: offers.getOffer, listOpenOfFaction: offers.listOpenOfFaction });
}

function startFrontJobs(deps) {
  const config = deps && deps.config;
  const settings = config && config.frontJobs;
  if (!settings || settings.enabled !== true || !isModuleEnabled(config, "world")) {
    return { ok: false, reason: "disabled_by_config" };
  }
  if (!config.occupation || config.occupation.enabled !== true) {
    return { ok: false, reason: "dependency_disabled:occupation" };
  }
  const ctx = deps.ctx || {};
  const persistence = ctx.persistence;
  const store = persistence && persistence.ok === true && persistence.store ? persistence.store : null;
  if (!store) return { ok: false, reason: "FRONT_JOBS_STORE_UNAVAILABLE" };
  let worldSeed = persistence.worldSeed;
  if (!Number.isSafeInteger(worldSeed) && typeof store.getWorldSeed === "function") {
    try {
      worldSeed = store.getWorldSeed();
    } catch (_err) {
      worldSeed = null;
    }
  }
  if (!Number.isSafeInteger(worldSeed)) return { ok: false, reason: "FRONT_JOBS_START_FAILED", detail: "worldSeed" };
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();

  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let state = STATE.RUNNING;
  let day = null;
  let lastPassAt = null;
  let lastRefusal = null;
  let openJobs = 0;
  let cache = new Map();
  let clearRefs = new Set();
  let scanCache = new Map();
  let escortCache = new Map();

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`frontJobs: ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](`frontJobs.${name}`, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!COUNTER_NAMES.includes(name) || n <= 0) return;
    counters[name] += n;
    metric("count", name, n);
  }

  function observe(name, value) {
    if (OBSERVE_NAMES.includes(name)) metric("observe", name, value);
  }

  function refuse(reason) {
    lastRefusal = reason;
    log(`refusal ${reason}`);
  }

  let factionNames = new Map();
  try {
    const r = deps.adapter && typeof deps.adapter.readFactionNames === "function" ? deps.adapter.readFactionNames()
      : null;
    if (r && r.ok && r.names instanceof Map) factionNames = r.names;
  } catch (_err) {
  }
  const vertexOf = (systemId) => {
    try {
      const g = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
      return g && g.ok === true && g.graph ? g.graph.getSystem(systemId) : null;
    } catch (_err) {
      return null;
    }
  };
  const lpCorpOf = (factionId) => LP_CORP_BY_FACTION[factionId] || null;
  const params = Object.freeze({ resetHourUtc: settings.resetHourUtc, jobsPerDay: settings.jobsPerDay,
    frontScanLimit: settings.frontScanLimit, empireIssuerWeight: settings.empireIssuerWeight,
    killTarget: settings.killTarget, maxCompletionsPerJob: settings.maxCompletionsPerJob,
    maxCompletionsPerCharacterDay: settings.maxCompletionsPerCharacterDay, killIsk: settings.killIsk,
    killLp: settings.killLp, standingRaw: settings.standingRaw,
    clearEnabled: settings.clearEnabled === true, maxClearPerDay: settings.maxClearPerDay,
    clearMinKills: settings.clearMinKills, clearMaxCompletions: settings.clearMaxCompletions,
    clearIsk: settings.clearIsk, clearLp: settings.clearLp, clearSiteScanLimit: settings.clearSiteScanLimit,
    deliverEnabled: settings.deliverEnabled === true, maxDeliverPerDay: settings.maxDeliverPerDay,
    deliverScanLimit: settings.deliverScanLimit, deliverIsk: settings.deliverIsk, deliverLp: settings.deliverLp,
    scanEnabled: settings.scanEnabled === true, maxScanPerDay: settings.maxScanPerDay,
    scanMaxCompletions: settings.scanMaxCompletions, scanIsk: settings.scanIsk, scanLp: settings.scanLp,
    escortEnabled: settings.escortEnabled === true, maxEscortPerDay: settings.maxEscortPerDay,
    escortTarget: settings.escortTarget, escortMaxCompletions: settings.escortMaxCompletions,
    escortIsk: settings.escortIsk, escortLp: settings.escortLp });
  const escortMaxCharacters = config.fleetExposure && Number.isSafeInteger(config.fleetExposure
    .escortMaxCharactersPerCrossing) ? config.fleetExposure.escortMaxCharactersPerCrossing : 0;
  const cacheLimit = settings.jobsPerDay + settings.maxExpirePerPass;
  const repo = createFrontJobRepository();
  const sitesReader = params.clearEnabled ? createSitesReader() : null;
  const offersReader = params.deliverEnabled ? createOffersReader(clock) : null;
  const warRepo = params.deliverEnabled
    ? require("../warContracts/repository").createWarContractRepository() : null;
  const isWarOffer = warRepo ? (tx, offerId) => {
    const r = warRepo.getInTx(tx, offerId);
    return !r || r.ok !== true || r.row !== null;
  } : undefined;
  const logisticsReader = params.escortEnabled ? Object.freeze({ readOpen: (tx, factionId, opts) => {
    const lg = ctx.logistics;
    return lg && typeof lg.readOpen === "function" ? lg.readOpen(tx, factionId, opts)
      : { ok: false, reason: "LOGISTICS_UNAVAILABLE", detail: "no ctx.logistics" };
  } }) : null;
  const typeName = (typeId) => {
    try {
      const r = deps.adapter && typeof deps.adapter.readItemTypeFacts === "function"
        ? deps.adapter.readItemTypeFacts([typeId]) : null;
      const fact = r && r.ok === true && r.facts instanceof Map ? r.facts.get(typeId) : null;
      return fact && typeof fact.name === "string" && fact.name !== "" ? fact.name : null;
    } catch (_err) {
      return null;
    }
  };
  const mail = createJobMail({ settings: Object.freeze({ boardMailEnabled: settings.boardMailEnabled === true,
    doneMailEnabled: settings.doneMailEnabled === true, maxBoardMailRecipients: settings.maxBoardMailRecipients,
    resetHourUtc: settings.resetHourUtc }), getNotices: () => ctx.notices || null,
  getPresence: () => ctx.presence || null, bump: (name, n) => bump(name, n), log });
  const boardDeps = Object.freeze({ repo, params, worldSeed: worldSeed >>> 0, lpCorpOf, notices: mail,
    sites: sitesReader, offers: offersReader, typeName, logistics: logisticsReader, isWarOffer,
    scanWrapMounted: () => scanObservation.isScanWrapMounted(),
    getWorldRepository: () => (ctx.world && ctx.world.repository) || null,
    regionOf: (id) => {
      const v = vertexOf(id);
      return v && Number.isSafeInteger(v.regionId) && v.regionId > 0 ? v.regionId : null;
    },
    names: Object.freeze({ faction: (id) => factionNames.get(id) || null,
      system: (id) => {
        const v = vertexOf(id);
        return v && v.name ? v.name : null;
      } }) });
  const progressDeps = Object.freeze({ repo, params, notices: mail });
  const refDeps = Object.freeze({ repo, params, notices: mail, sites: sitesReader, offers: offersReader });

  const pump = createPayoutPump({ store, repo, adapter: deps.adapter || null,
    params: Object.freeze({ payoutEnabled: settings.payoutEnabled === true, payoutMaxPerPass: settings.payoutMaxPerPass,
      payoutMaxAttempts: settings.payoutMaxAttempts, payoutRetryBaseMs: settings.payoutRetryBaseMs,
      payoutRetryMaxMs: settings.payoutRetryMaxMs, retentionMs: settings.retentionMs,
      payoutRetentionMs: settings.payoutRetentionMs, prunePerPass: settings.prunePerPass }),
    getGovernor: () => ctx.governor || null, count: (name, n) => bump(name, n), log,
    isStopped: () => state !== STATE.RUNNING });
  let payoutInFlight = null;

  function kickPayout(at) {
    if (payoutInFlight !== null) return payoutInFlight;
    const t0 = nowMs();
    payoutInFlight = pump.runPass(at).catch((err) => {
      bump("errors");
      refuse(`PAYOUT_THREW ${messageOf(err)}`);
      return null;
    }).then((summary) => {
      payoutInFlight = null;
      observe("payoutMs", nowMs() - t0);
      return summary;
    });
    return payoutInFlight;
  }

  function rebuildCache(jobs) {
    const next = new Map();
    const refs = new Set();
    const scans = new Map();
    const escorts = new Map();
    for (const j of jobs) {
      if (j.kind === KIND.ESCORT) {
        const list = escorts.get(j.issuerFactionId) || [];
        list.push(Object.freeze({ jobId: j.jobId, expiresAt: j.expiresAt }));
        escorts.set(j.issuerFactionId, list);
        continue;
      }
      if (j.kind === KIND.SCAN) {
        const list = scans.get(j.systemId) || [];
        list.push(Object.freeze({ jobId: j.jobId, expiresAt: j.expiresAt }));
        scans.set(j.systemId, list);
        continue;
      }
      const anyFaction = j.kind === KIND.CLEAR;
      if (!anyFaction && j.targetFactionId === null) continue;
      if (anyFaction && typeof j.ref === "string") refs.add(j.ref);
      const list = next.get(j.systemId) || [];
      list.push(Object.freeze({ jobId: j.jobId, targetFactionId: j.targetFactionId, anyFaction,
        expiresAt: j.expiresAt }));
      next.set(j.systemId, list);
    }
    cache = next;
    clearRefs = refs;
    scanCache = scans;
    escortCache = escorts;
    openJobs = jobs.length;
  }

  function dropFromEscortCache(factionId, jobId) {
    const list = escortCache.get(factionId);
    if (!list) return;
    const rest = list.filter((e) => e.jobId !== jobId);
    if (rest.length === list.length) return;
    openJobs = Math.max(0, openJobs - 1);
    if (rest.length === 0) escortCache.delete(factionId);
    else escortCache.set(factionId, rest);
  }

  function dropFromScanCache(systemId, jobId) {
    const list = scanCache.get(systemId);
    if (!list) return;
    const rest = list.filter((e) => e.jobId !== jobId);
    if (rest.length === list.length) return;
    openJobs = Math.max(0, openJobs - 1);
    if (rest.length === 0) scanCache.delete(systemId);
    else scanCache.set(systemId, rest);
  }

  function dropFromCache(systemId, jobId) {
    const list = cache.get(systemId);
    if (!list) return;
    const rest = list.filter((e) => e.jobId !== jobId);
    if (rest.length === list.length) return;
    openJobs = Math.max(0, openJobs - 1);
    if (rest.length === 0) cache.delete(systemId);
    else cache.set(systemId, rest);
  }

  function settleRefs(at) {
    if (!params.clearEnabled && !params.deliverEnabled) return 0;
    let checked = 0;
    try {
      const listed = store.transaction("frontJobs.refs", (db) => {
        const clear = params.clearEnabled ? repo.listOpenOfKindInTx(db, KIND.CLEAR, settings.refChecksPerPass) : null;
        const taken = clear && clear.ok ? clear.jobs : [];
        const left = settings.refChecksPerPass - taken.length;
        const deliver = params.deliverEnabled && left > 0 ? repo.listOpenOfKindInTx(db, KIND.DELIVER, left) : null;
        return [...taken, ...(deliver && deliver.ok ? deliver.jobs : [])];
      });
      if (!listed.ok) {
        bump("errors");
        refuse(`REFS_${txError(listed)}`);
        return 0;
      }
      for (const job of listed.value) {
        const isClear = job.kind === KIND.CLEAR;
        const r = store.transaction("frontJobs.ref", (db) => (isClear ? settleClearInTx(db, job, refDeps, at)
          : settleDeliverInTx(db, job, refDeps, at)));
        checked += 1;
        bump("refChecks");
        if (!r.ok || !r.value || r.value.ok !== true) {
          bump("errors");
          refuse(`REF_${job.kind} ${r.ok ? (r.value && r.value.reason) || "NO_RESULT" : txError(r)}`);
          continue;
        }
        const outcome = r.value.outcome;
        if (outcome === "SETTLED") {
          bump(isClear ? "clearSettled" : "deliverSettled");
          bump("completions", isClear ? r.value.completions : 1);
          log(`${job.kind} settled job=${job.jobId}`);
        } else if (outcome === "LOST" || outcome === "DAILY_CAP") {
          bump(isClear ? "clearLost" : "deliverLost");
          bump("jobsExpired");
        }
        if (outcome !== "WAIT") dropFromCache(job.systemId, job.jobId);
      }
    } catch (err) {
      bump("errors");
      refuse(`REFS_THREW ${messageOf(err)}`);
    }
    return checked;
  }

  function onSiteState(event) {
    try {
      if (state !== STATE.RUNNING || !event || !clearRefs.has(event.siteKey)) return;
      bump("nudges");
      poller.arm(0);
    } catch (err) {
      log(`nudge failed - ${messageOf(err)}`);
    }
  }
  let unsubscribeSites = null;

  function runPass(now) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" };
    const at = Number.isSafeInteger(now) ? now : clock.now();
    const governor = ctx.governor;
    try {
      if (governor && typeof governor.admits === "function" && governor.admits(WORK_CLASS) === false) {
        bump("deferrals");
        return { ok: true, deferred: true, generated: 0, expired: 0 };
      }
    } catch (_err) {
    }
    const t0 = nowMs();
    bump("passes");
    let expired = 0;
    let generated = 0;
    settleRefs(at);
    try {
      const ex = store.transaction("frontJobs.expire", (db) => repo.expireDueInTx(db, at, settings.maxExpirePerPass));
      if (!ex.ok) {
        bump("errors");
        refuse(`EXPIRE_${txError(ex)}`);
      } else if (ex.value && ex.value.ok) {
        expired = ex.value.expired;
        bump("jobsExpired", expired);
      }
      const bd = store.transaction("frontJobs.board", (db) => {
        const board = ensureBoardInTx(db, boardDeps, at);
        const open = repo.listOpenOfKindInTx(db, KIND.KILL, cacheLimit);
        const clear = params.clearEnabled ? repo.listOpenOfKindInTx(db, KIND.CLEAR, cacheLimit) : null;
        const scan = params.scanEnabled ? repo.listOpenOfKindInTx(db, KIND.SCAN, cacheLimit) : null;
        const escort = params.escortEnabled ? repo.listOpenOfKindInTx(db, KIND.ESCORT, cacheLimit) : null;
        if (!open.ok) return { board, open };
        const jobs = [...open.jobs, ...(clear && clear.ok ? clear.jobs : []), ...(scan && scan.ok ? scan.jobs : []),
          ...(escort && escort.ok ? escort.jobs : [])];
        return { board, open: { ok: true, jobs } };
      });
      if (!bd.ok) {
        bump("errors");
        refuse(`BOARD_${txError(bd)}`);
      } else {
        const { board, open } = bd.value;
        if (open && open.ok) rebuildCache(open.jobs);
        if (!board.ok) {
          refuse(board.reason);
        } else {
          day = board.day;
          if (Array.isArray(board.refusals)) {
            refuse(`BOARD_KINDS ${board.refusals.join(",")}`);
            if (board.refusals.includes(`${KIND.SCAN}:NO_WRAP`)) bump("scanSeamMissing");
          }
          generated = board.created;
          if (board.created > 0) {
            bump("boardsCreated");
            bump("jobsCreated", board.created);
            log(`board day=${board.day} jobs=${board.created}`);
          } else if (board.existing !== true) {
            bump("boardEmpty");
          }
        }
      }
    } catch (err) {
      bump("errors");
      refuse(`PASS_THREW ${messageOf(err)}`);
    }
    lastPassAt = at;
    observe("passMs", nowMs() - t0);
    kickPayout(at);
    return { ok: true, generated, expired };
  }

  function onNpcKill(kill) {
    try {
      if (state !== STATE.RUNNING) return { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" };
      if (!kill || kill.rewardable !== true) {
        bump("killsIgnored");
        return { ok: true, outcome: "IGNORED" };
      }
      const hits = (cache.get(kill.systemId) || []).filter((e) => e.anyFaction === true
        || e.targetFactionId === kill.victimFactionId);
      if (hits.length === 0) {
        bump("killsIgnored");
        return { ok: true, outcome: "NO_JOB" };
      }
      const live = hits.filter((e) => kill.atMs < e.expiresAt);
      if (live.length === 0) {
        bump("killsIgnored");
        return { ok: true, outcome: "EXPIRED" };
      }
      const tx = store.transaction("frontJobs.kill", (db) => live.map((e) => applyContributionInTx(db, progressDeps,
        { jobId: e.jobId, characterId: kill.characterId, amount: 1, atMs: kill.atMs })));
      if (!tx.ok) {
        bump("errors");
        refuse(`KILL_${txError(tx)}`);
        return { ok: false, reason: "FRONT_JOBS_TX_FAILED", detail: txError(tx) };
      }
      const results = tx.value;
      results.forEach((r, i) => {
        const outcome = r.ok ? r.outcome : r.reason;
        if (outcome === "PROGRESS" || outcome === "COMPLETED") bump("contributions");
        if (outcome === "COMPLETED") bump("completions");
        if (outcome === "DAILY_CAP") bump("dailyCapped");
        if (CLOSING.includes(outcome) || (outcome === "COMPLETED" && r.filled === true)) {
          dropFromCache(kill.systemId, live[i].jobId);
        }
      });
      const first = results[0];
      return { ok: true, outcome: first.ok ? first.outcome : first.reason, results };
    } catch (err) {
      bump("errors");
      refuse(`KILL_THREW ${messageOf(err)}`);
      return { ok: false, reason: "FRONT_JOBS_THREW", detail: messageOf(err) };
    }
  }

  function onPerfectScan(scan) {
    try {
      if (state !== STATE.RUNNING) return { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" };
      bump("scansObserved");
      const hits = scan ? scanCache.get(scan.systemId) : undefined;
      if (!hits) return { ok: true, outcome: "NO_JOB" };
      const live = hits.filter((e) => scan.atMs < e.expiresAt);
      if (live.length === 0) return { ok: true, outcome: "EXPIRED" };
      bump("scansMatched");
      const tx = store.transaction("frontJobs.scan", (db) => applyScanInTx(db, progressDeps, live, scan));
      if (!tx.ok) {
        bump("scanErrors");
        refuse(`SCAN_${txError(tx)}`);
        return { ok: false, reason: "FRONT_JOBS_TX_FAILED", detail: txError(tx) };
      }
      const results = tx.value;
      results.forEach((r, i) => {
        const outcome = r.ok ? r.outcome : r.reason;
        if (outcome === "COMPLETED") {
          bump("contributions");
          bump("completions");
        }
        if (outcome === "DAILY_CAP") bump("dailyCapped");
        if (CLOSING.includes(outcome) || (outcome === "COMPLETED" && r.filled === true)) {
          dropFromScanCache(scan.systemId, live[i].jobId);
        }
      });
      const first = results[0];
      return { ok: true, outcome: first.ok ? first.outcome : first.reason, results };
    } catch (err) {
      bump("scanErrors");
      refuse(`SCAN_THREW ${messageOf(err)}`);
      return { ok: false, reason: "FRONT_JOBS_THREW", detail: messageOf(err) };
    }
  }
  const scanListener = Object.freeze({ onPerfectScan });

  function onEscortCrossing(c) {
    try {
      if (state !== STATE.RUNNING || !params.escortEnabled) return { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" };
      const ids = c && Array.isArray(c.characterIds) ? c.characterIds : null;
      if (!c || !Number.isSafeInteger(c.ownerFactionId) || c.ownerFactionId <= 0 || !Number.isSafeInteger(c.atMs)
        || c.atMs < 0 || !ids || ids.length > escortMaxCharacters
        || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
      const hits = escortCache.get(c.ownerFactionId);
      if (!hits || ids.length === 0) {
        bump("escortMiss");
        return { ok: true, credited: 0, outcome: "NO_JOB" };
      }
      const live = hits.filter((e) => c.atMs < e.expiresAt);
      if (live.length === 0) {
        bump("escortMiss");
        return { ok: true, credited: 0, outcome: "EXPIRED" };
      }
      const pairs = [];
      for (const e of live) for (const characterId of ids) pairs.push({ e, characterId });
      const tx = store.transaction("frontJobs.escort", (db) => pairs.map((p) => applyContributionInTx(db,
        progressDeps, { jobId: p.e.jobId, characterId: p.characterId, amount: 1, atMs: c.atMs })));
      if (!tx.ok) {
        bump("escortErrors");
        refuse(`ESCORT_${txError(tx)}`);
        return { ok: false, reason: "FRONT_JOBS_TX_FAILED", detail: txError(tx) };
      }
      let credited = 0;
      tx.value.forEach((r, i) => {
        const outcome = r.ok ? r.outcome : r.reason;
        if (outcome === "PROGRESS" || outcome === "COMPLETED") {
          credited += 1;
          bump("contributions");
        }
        if (outcome === "COMPLETED") bump("completions");
        if (outcome === "DAILY_CAP") bump("dailyCapped");
        if (CLOSING.includes(outcome) || (outcome === "COMPLETED" && r.filled === true)) {
          dropFromEscortCache(c.ownerFactionId, pairs[i].e.jobId);
        }
      });
      bump("escortCredited", credited);
      return { ok: true, credited, outcome: "APPLIED" };
    } catch (err) {
      bump("escortErrors");
      refuse(`ESCORT_THREW ${messageOf(err)}`);
      return { ok: false, reason: "FRONT_JOBS_THREW", detail: messageOf(err) };
    }
  }

  function readBoard(db, characterId) {
    const d = boardDayOf(clock.now(), settings.resetHourUtc);
    const list = repo.listDayInTx(db, Math.max(0, d));
    if (!list.ok) return list;
    const mine = Number.isSafeInteger(characterId) && characterId > 0
      ? repo.listProgressOfCharacterInTx(db, characterId, list.jobs.map((j) => j.jobId)) : { ok: true, rows: [] };
    if (!mine.ok) return mine;
    const byJob = new Map(mine.rows.map((p) => [p.jobId, p]));
    return { ok: true, day: d, jobs: list.jobs.map((j) => {
      const p = byJob.get(j.jobId);
      return { ...j, myProgress: p ? p.progress : 0, myState: p ? p.state : null };
    }) };
  }

  function listBoard(tx, characterId) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" };
    try {
      if (tx) return readBoard(tx, characterId);
      const r = store.transaction("frontJobs.read", (db) => readBoard(db, characterId));
      return r.ok ? r.value : { ok: false, reason: "FRONT_JOBS_TX_FAILED", detail: txError(r) };
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "FRONT_JOBS_THREW", detail: messageOf(err) };
    }
  }

  function listDoneForBoard(tx, q) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "FRONT_JOBS_UNAVAILABLE" };
    try {
      if (tx) return repo.listDoneOfCharacterInTx(tx, q);
      const r = store.transaction("frontJobs.read", (db) => repo.listDoneOfCharacterInTx(db, q));
      return r.ok ? r.value : { ok: false, reason: "FRONT_JOBS_TX_FAILED", detail: txError(r) };
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "FRONT_JOBS_THREW", detail: messageOf(err) };
    }
  }

  const poller = createPoller({ runPass: () => runPass(clock.now()), intervalMs: settings.passIntervalMs,
    now: () => clock.now(), setTimer: deps.setTimer, onError: (err) => {
      bump("errors");
      log(`pass failed - ${messageOf(err)}`);
    } });

  let chat = "off";
  const jobsChat = createJobsChat({ settings, frontChatSettings: config.frontChat || {}, listBoard: (tx, id) =>
    listBoard(tx, id), getGovernor: () => ctx.governor || null, clock, nowMs, isRunning: () => state === STATE.RUNNING,
  bump: (name) => bump(name), observe, log });

  function installChat() {
    if (settings.chatEnabled !== true) return;
    const adapter = deps.adapter || null;
    if (!adapter || typeof adapter.installChatCommand !== "function") {
      chat = "unavailable";
      return;
    }
    let r;
    try {
      r = adapter.installChatCommand({ name: COMMAND_NAME, match: matchJobsCommand, handle: jobsChat.handle,
        failReply: FAIL_REPLY });
    } catch (err) {
      r = { ok: false, reason: "THREW", detail: messageOf(err) };
    }
    if (r && r.ok === true) {
      chat = "installed";
      return;
    }
    chat = "unavailable";
    refuse(`CHAT_${(r && r.reason) || "NO_RESULT"}${r && r.detail ? `:${r.detail}` : ""}`);
  }

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    try {
      if (killObservation.getFrontJobs() === facade) killObservation.setFrontJobs(null);
      if (scanObservation.getFrontJobsScan() === scanListener) scanObservation.setFrontJobsScan(null);
    } catch (_err) {
    }
    try {
      if (unsubscribeSites) unsubscribeSites();
      unsubscribeSites = null;
    } catch (err) {
      log(`site listener cleanup failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
    if (chat === "installed") {
      chat = "off";
      try {
        deps.adapter.uninstallChatCommand(COMMAND_NAME);
      } catch (err) {
        log(`chat uninstall failed (${reason || "stop"}) - ${messageOf(err)}`);
      }
    }
    try {
      poller.stop();
    } catch (err) {
      log(`timer stop failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
  }

  const facade = Object.freeze({
    getStatus: () => {
      const p = pump.getStatus();
      return { state, day, openJobs, lastPassAt, lastRefusal, chat, passes: poller.getPasses(), counters: { ...counters },
        payout: { enabled: settings.payoutEnabled === true, passes: p.passes, seamsMissing: p.seamsMissing,
          standingMissing: p.standingMissing, inFlight: payoutInFlight !== null, lastRefusal: p.lastRefusal },
        kinds: { clear: params.clearEnabled, deliver: params.deliverEnabled, siteListener: unsubscribeSites !== null,
          scan: params.scanEnabled, scanWrapMounted: scanObservation.isScanWrapMounted(), escort: params.escortEnabled,
          scanListener: scanObservation.getFrontJobsScan() === scanListener && scanObservation.isScanWrapMounted() } };
    },
    stop,
    onNpcKill,
    runPass,
    listBoard,
    onEscortCrossing,
    listDoneForBoard,
  });

  try {
    killObservation.setFrontJobs(facade);
    if (params.scanEnabled) scanObservation.setFrontJobsScan(scanListener);
    if (params.clearEnabled && ctx.sites && typeof ctx.sites.addSiteStateListener === "function") {
      const off = ctx.sites.addSiteStateListener(onSiteState);
      unsubscribeSites = typeof off === "function" ? off : null;
    }
    runPass(clock.now());
    const armed = poller.start();
    if (!armed.ok) {
      stop("timer");
      return { ok: false, reason: "FRONT_JOBS_START_FAILED", detail: `timer ${armed.reason}` };
    }
    installChat();
  } catch (err) {
    stop("start");
    return { ok: false, reason: "FRONT_JOBS_START_FAILED", detail: messageOf(err) };
  }
  log(`running jobsPerDay=${settings.jobsPerDay} killTarget=${settings.killTarget} day=${day === null ? "-" : day}`
    + ` open=${openJobs} chat=${chat}`);
  return { ok: true, frontJobs: facade };
}

module.exports = { startFrontJobs, createUnavailableFrontJobs, COUNTER_NAMES, OBSERVE_NAMES, FACADE_METHODS };
