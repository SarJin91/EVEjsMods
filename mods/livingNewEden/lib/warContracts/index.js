"use strict";

const { performance } = require("node:perf_hooks");
const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const { LP_CORP_BY_FACTION } = require("../world/liberation/rewardSchema");
const { createWarContractRepository } = require("./repository");
const { adoptInTx, settleInTx } = require("./pass");
const { itemKindsOf } = require("./rules");
const S = require("./schema");
const { createPayoutPump } = require("../frontJobs/payoutPump");
const { STANDING_REASON, STANDING_DATA, ISK_SOURCE } = require("./data");
const { createWarChat, matchWarCommand, COMMAND_NAME: CHAT_COMMAND_NAME, FAIL_REPLY: CHAT_FAIL_REPLY } = require("./chat");
const { createWarMail } = require("./mail");
const { registerWarContractsView } = require("./view");

const COUNTER_NAMES = Object.freeze(["passes", "deferrals", "adopted", "adoptSkippedFrontJob", "scanTruncated",
  "waits", "awarded", "capped", "lapsed", "readFailed", "errors",
  "payoutsPaid", "payoutsFailed", "legRetries", "legDuplicates", "keyReused", "seamsMissing", "pruned",
  "chatReplies", "chatRateLimited", "chatErrors", "awardMails", "announceMails", "noticeRefused", "stockLineMissing",
  "adoptedLate"]);
const OBSERVE_NAMES = Object.freeze(["passMs", "payoutMs", "chatReplyMs"]);
const FACADE_METHODS = Object.freeze(["getStatus", "stop", "runPass", "listOpen", "payoutPass", "listForChat",
  "listForBoard", "listAwardsForBoard"]);
const STATE = Object.freeze({ RUNNING: "running", STOPPED: "stopped" });
const WORK_CLASS = "MAINTENANCE";
const MAX_DETAIL = 160;
const UNAVAILABLE = "WAR_CONTRACTS_UNAVAILABLE";

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function txError(r) {
  return `${r.reason}${r.error ? ` ${messageOf(r.error)}` : ""}`;
}

function createUnavailableWarContracts(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: UNAVAILABLE });
  return Object.freeze({
    getStatus: () => ({ state: "unavailable", reason: String(reason || UNAVAILABLE),
      ...(detail ? { detail: String(detail) } : {}) }),
    stop: () => {},
    runPass: () => refusal,
    listOpen: () => refusal,
    payoutPass: () => Promise.resolve(refusal),
    listForChat: () => refusal,
    listForBoard: () => refusal,
    listAwardsForBoard: () => refusal,
  });
}

function createOffersReader(clock) {
  const { createOfferRepository } = require("../economy/trade/offerRepository");
  const readOnly = () => {
    throw new Error("warContracts: the offer reader is read only");
  };
  const offers = createOfferRepository({ journal: { applyOnce: readOnly }, budgets: { adjustInDb: readOnly },
    ids: { next: readOnly }, clock });
  return Object.freeze({ getOffer: offers.getOffer, listOpenOfFaction: offers.listOpenOfFaction,
    listRecent: offers.listRecent });
}

function createBudgetsReader(clock) {
  const { createBudgetRepository } = require("../economy/trade/budgetRepository");
  const readOnly = () => {
    throw new Error("warContracts: the budget reader is read only");
  };
  const budgets = createBudgetRepository({ journal: { applyOnce: readOnly }, clock });
  return Object.freeze({ listBudgets: budgets.listBudgets });
}

function startWarContracts(deps) {
  const config = deps && deps.config;
  const settings = config && config.warContracts;
  if (!settings || settings.enabled !== true || !isModuleEnabled(config, "world")) {
    return { ok: false, reason: "disabled_by_config" };
  }
  const ctx = deps.ctx || {};
  const persistence = ctx.persistence;
  const store = persistence && persistence.ok === true && persistence.store ? persistence.store : null;
  if (!store) return { ok: false, reason: "WAR_CONTRACTS_STORE_UNAVAILABLE" };
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();

  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let state = STATE.RUNNING;
  let lastPassAt = null;
  let lastRefusal = null;
  let open = 0;
  let afterFactionId = 0;
  let afterOfferId = "";

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`warContracts: ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](`warContracts.${name}`, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!COUNTER_NAMES.includes(name) || !(n > 0)) return;
    counters[name] += n;
    metric("count", name, n);
  }

  function refuse(reason) {
    lastRefusal = reason;
    log(`refusal ${reason}`);
  }

  let startError = null;
  let offers;
  let budgets;
  let frontJobRepo = null;
  let frontJobRefs = null;
  try {
    offers = createOffersReader(clock);
    budgets = createBudgetsReader(clock);
    frontJobRepo = require("../frontJobs/repository").createFrontJobRepository();
    frontJobRefs = frontJobRepo;
  } catch (err) {
    startError = messageOf(err);
  }
  if (startError !== null) return { ok: false, reason: "WAR_CONTRACTS_START_FAILED", detail: startError };

  let factionNames = new Map();
  try {
    const r = deps.adapter && typeof deps.adapter.readFactionNames === "function" ? deps.adapter.readFactionNames()
      : null;
    if (r && r.ok && r.names instanceof Map) factionNames = r.names;
  } catch (_err) {
  }
  const typeNames = new Map();
  const typeName = (typeId) => {
    if (typeNames.has(typeId)) return typeNames.get(typeId);
    let name = null;
    try {
      const r = deps.adapter && typeof deps.adapter.readItemTypeFacts === "function"
        ? deps.adapter.readItemTypeFacts([typeId]) : null;
      const fact = r && r.ok === true && r.facts instanceof Map ? r.facts.get(typeId) : null;
      name = fact && typeof fact.name === "string" && fact.name !== "" ? fact.name : null;
    } catch (_err) {
      name = null;
    }
    typeNames.set(typeId, name);
    return name;
  };
  const graphOf = () => {
    try {
      const g = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
      return g && g.ok === true && g.graph ? g.graph : null;
    } catch (_err) {
      return null;
    }
  };
  const vertexOf = (systemId) => {
    try {
      const g = graphOf();
      return g ? g.getSystem(systemId) : null;
    } catch (_err) {
      return null;
    }
  };
  const regionOf = (systemId) => {
    const v = vertexOf(systemId);
    return v && Number.isSafeInteger(v.regionId) && v.regionId > 0 ? v.regionId : null;
  };
  const names = Object.freeze({ faction: (id) => factionNames.get(id) || null, type: typeName,
    system: (id) => {
      const v = vertexOf(id);
      return v && v.name ? v.name : null;
    },
    region: (regionId) => {
      try {
        const g = graphOf();
        return g && typeof g.getRegionName === "function" ? g.getRegionName(regionId) : null;
      } catch (_err) {
        return null;
      }
    } });
  const lpCorpOf = (factionId) => LP_CORP_BY_FACTION[factionId] || null;
  const maxRows = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
    ? store.limits.maxRowsPerTransaction : Infinity;
  const adoptParams = Object.freeze({ factionsPerPass: settings.factionsPerPass, offerScanLimit: settings.offerScanLimit,
    maxAdoptPerPass: Math.min(settings.maxAdoptPerPass, maxRows), includePrivate: settings.includePrivate === true,
    itemKinds: itemKindsOf(settings.hullsOnly), lpPerMillionIsk: settings.lpPerMillionIsk, lpMin: settings.lpMin,
    lpMax: settings.lpMax, iskBonusPermille: settings.iskBonusPermille, standingRaw: settings.standingRaw,
    adoptLateMs: settings.adoptLateMs });
  const settleParams = Object.freeze({ settlePerPass: Math.min(settings.settlePerPass, maxRows),
    maxAwards: settings.maxAwardsPerCharacterDay, awardWindowMs: settings.awardWindowMs,
    tradeStandingGrant: Boolean(config.trade && config.trade.standingGrantEnabled === true) });
  const repo = createWarContractRepository();
  const mail = createWarMail({ settings: Object.freeze({ awardMailEnabled: settings.awardMailEnabled === true,
    announceMailEnabled: settings.announceMailEnabled === true, announceMaxRecipients: settings.announceMaxRecipients,
    maxStockItems: config.stations ? config.stations.maxStockItemsPerStation : undefined }),
  getNotices: () => ctx.notices || null, getPresence: () => ctx.presence || null,
  getStationsRepository: () => (ctx.stations && ctx.stations.repository) || null, regionOf, names,
  bump: (name, n) => bump(name, n), log });

  const pump = createPayoutPump({ store, repo, adapter: deps.adapter || null,
    params: Object.freeze({ payoutEnabled: settings.payoutEnabled === true, payoutMaxPerPass: settings.payoutMaxPerPass,
      payoutMaxAttempts: settings.payoutMaxAttempts, payoutRetryBaseMs: settings.payoutRetryBaseMs,
      payoutRetryMaxMs: settings.payoutRetryMaxMs, retentionMs: settings.retentionMs,
      payoutRetentionMs: settings.retentionMs, prunePerPass: settings.prunePerPass }),
    labels: Object.freeze({ txPrefix: "warContracts", standingReason: STANDING_REASON, standingData: STANDING_DATA,
      iskSource: ISK_SOURCE }),
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
      metric("observe", "payoutMs", nowMs() - t0);
      return summary;
    });
    return payoutInFlight;
  }

  function payoutPass(now) {
    if (state !== STATE.RUNNING) return Promise.resolve({ ok: false, reason: UNAVAILABLE });
    try {
      return kickPayout(Number.isSafeInteger(now) ? now : clock.now());
    } catch (err) {
      bump("errors");
      return Promise.resolve({ ok: false, reason: "WAR_CONTRACTS_THREW", detail: messageOf(err) });
    }
  }

  function adopt(at) {
    const r = store.transaction("warContracts.adopt", (db) => {
      const v = adoptInTx(db, { repo, offers, budgets, frontJobRepo, frontJobRefs, params: adoptParams, lpCorpOf,
        names, afterFactionId }, at);
      if (v.ok) mail.announceInTx(db, v.adoptedRows, at);
      return v;
    });
    if (!r.ok) {
      bump("errors");
      refuse(`ADOPT_${txError(r)}`);
      return 0;
    }
    const v = r.value;
    if (!v.ok) {
      bump("errors");
      refuse(`ADOPT_${v.reason}${v.detail ? ` ${v.detail}` : ""}`);
      return 0;
    }
    afterFactionId = v.nextAfterFactionId;
    bump("adopted", v.adopted);
    bump("adoptedLate", v.adoptedLate);
    bump("adoptSkippedFrontJob", v.skippedFrontJob);
    bump("scanTruncated", v.scanTruncated);
    bump("readFailed", v.readFailed);
    if (v.adopted > 0) log(`adopted ${v.adopted}`);
    return v.adopted;
  }

  function settle(at) {
    const r = store.transaction("warContracts.settle", (db) => settleInTx(db, { repo, offers, params: settleParams,
      afterOfferId, mail }, at));
    if (!r.ok) {
      bump("errors");
      refuse(`SETTLE_${txError(r)}`);
      return null;
    }
    const v = r.value;
    afterOfferId = v.nextAfterOfferId;
    open = v.open;
    bump("awarded", v.awarded);
    bump("capped", v.capped);
    bump("lapsed", v.lapsed);
    bump("waits", v.waits);
    bump("readFailed", v.readFailed);
    return v;
  }

  function runPass(now) {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    const at = Number.isSafeInteger(now) ? now : clock.now();
    const result = { ok: true, outcome: "DONE", adopted: 0, awarded: 0, capped: 0, lapsed: 0, waits: 0 };
    try {
      const governor = ctx.governor;
      if (governor && typeof governor.admits === "function" && governor.admits(WORK_CLASS) === false) {
        bump("deferrals");
        return { ...result, outcome: "DEFERRED" };
      }
    } catch (_err) {
    }
    const t0 = nowMs();
    bump("passes");
    try {
      result.adopted = adopt(at);
      const s = settle(at);
      if (s) Object.assign(result, { awarded: s.awarded, capped: s.capped, lapsed: s.lapsed, waits: s.waits });
      kickPayout(at);
    } catch (err) {
      bump("errors");
      refuse(`PASS_THREW ${messageOf(err)}`);
    }
    lastPassAt = at;
    metric("observe", "passMs", nowMs() - t0);
    return result;
  }

  function listOpen(opts) {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    const want = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : S.LIST_OPEN_MAX;
    const limit = Math.min(want, S.LIST_OPEN_MAX);
    try {
      const r = store.transaction("warContracts.read", (db) => repo.listOpenInTx(db, { afterOfferId: "", limit }));
      if (!r.ok) return { ok: false, reason: "WAR_CONTRACTS_TX_FAILED", detail: txError(r) };
      return { ok: true, rows: r.value.rows };
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "WAR_CONTRACTS_THREW", detail: messageOf(err) };
    }
  }

  function listForChat() {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    try {
      const at = clock.now();
      const r = store.transaction("warContracts.chatRead", (db) => {
        const open = repo.listOpenInTx(db, { afterOfferId: "", limit: S.LIST_OPEN_MAX });
        if (!open.ok) return open;
        const corp = repo.listEndedSinceInTx(db, { sinceMs: at - settings.awardWindowMs,
          reason: S.END_REASON_NO_CHARACTER, limit: settings.chatMaxLines });
        const fronts = new Map();
        try {
          const wr = ctx.world && ctx.world.repository;
          const page = wr && typeof wr.listActiveOccupations === "function"
            ? wr.listActiveOccupations(db, { afterSystemId: 0, limit: settings.chatFrontScan }) : null;
          for (const s of (page && page.ok === true && Array.isArray(page.systems) ? page.systems : [])) {
            const f = s && s.occupierFactionId;
            if (Number.isSafeInteger(f) && f > 0 && !fronts.has(f)) fronts.set(f, s.systemId);
          }
        } catch (_err) {
        }
        return { ok: true, rows: [...open.rows, ...(corp.ok ? corp.rows : [])], fronts };
      });
      if (!r.ok) return { ok: false, reason: "WAR_CONTRACTS_TX_FAILED", detail: txError(r) };
      return r.value;
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "WAR_CONTRACTS_THREW", detail: messageOf(err) };
    }
  }

  function listForBoard(opts) {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    const want = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : S.LIST_OPEN_MAX;
    const limit = Math.min(want, S.LIST_OPEN_MAX);
    try {
      const r = store.transaction("warContracts.boardRead", (db) => {
        const open = repo.listOpenInTx(db, { afterOfferId: "", limit });
        if (!open.ok) return open;
        const rows = open.rows.map((row) => {
          const got = offers.getOffer(db, row.offerId);
          const offer = got && got.ok === true ? got.offer : null;
          const contractId = offer ? Number(offer.contractId) : 0;
          const expiresAt = offer ? Number(offer.expiresAt) : NaN;
          return { ...row, contractId: Number.isSafeInteger(contractId) && contractId > 0 ? contractId : 0,
            offerExpiresAt: Number.isSafeInteger(expiresAt) ? expiresAt : null };
        });
        return { ok: true, rows };
      });
      if (!r.ok) return { ok: false, reason: "WAR_CONTRACTS_TX_FAILED", detail: txError(r) };
      return r.value && r.value.ok === true ? r.value
        : { ok: false, reason: String((r.value && r.value.reason) || "WAR_CONTRACTS_TX_FAILED") };
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "WAR_CONTRACTS_THREW", detail: messageOf(err) };
    }
  }

  function listAwardsForBoard(tx, q) {
    if (state !== STATE.RUNNING) return { ok: false, reason: UNAVAILABLE };
    try {
      if (tx) return repo.listAwardsOfCharacterInTx(tx, q);
      const r = store.transaction("warContracts.boardRead", (db) => repo.listAwardsOfCharacterInTx(db, q));
      return r.ok ? r.value : { ok: false, reason: "WAR_CONTRACTS_TX_FAILED", detail: txError(r) };
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "WAR_CONTRACTS_THREW", detail: messageOf(err) };
    }
  }

  let chat = "off";
  const warChat = createWarChat({ settings, frontChatSettings: config.frontChat || {}, listForChat, regionOf, names,
    getGovernor: () => ctx.governor || null, clock, nowMs, isRunning: () => state === STATE.RUNNING,
    bump: (name) => bump(name), observe: (name, value) => metric("observe", name, value), log });

  function installChat() {
    if (settings.chatEnabled !== true) return;
    const adapter = deps.adapter || null;
    if (!adapter || typeof adapter.installChatCommand !== "function") {
      chat = "unavailable";
      return;
    }
    let r;
    try {
      r = adapter.installChatCommand({ name: CHAT_COMMAND_NAME, match: matchWarCommand, handle: warChat.handle,
        failReply: CHAT_FAIL_REPLY });
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

  const poller = createPoller({ runPass: () => runPass(clock.now()), intervalMs: settings.passIntervalMs,
    now: () => clock.now(), setTimer: deps.setTimer, onError: (err) => {
      bump("errors");
      log(`pass failed - ${messageOf(err)}`);
    } });

  let view = null;

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    try {
      if (view) view.unregister();
      view = null;
    } catch (err) {
      log(`view unregister failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
    if (chat === "installed") {
      chat = "off";
      try {
        deps.adapter.uninstallChatCommand(CHAT_COMMAND_NAME);
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
    getStatus: () => ({ state, lastPassAt, lastRefusal, open, chat, counters: { ...counters },
      payout: pump.getStatus() }),
    stop,
    runPass,
    listOpen,
    payoutPass,
    listForChat,
    listForBoard,
    listAwardsForBoard,
  });

  try {
    runPass(clock.now());
    const armed = poller.start();
    if (!armed.ok) {
      stop("timer");
      return { ok: false, reason: "WAR_CONTRACTS_START_FAILED", detail: `timer ${armed.reason}` };
    }
    installChat();
    if (settings.viewEnabled === true) {
      view = registerWarContractsView({ views: ctx.views || null, store, repo, viewRows: settings.viewRows,
        viewSumWindowMs: settings.viewSumWindowMs, now: () => clock.now(), names,
        getPresence: () => ctx.presence || null, getGovernor: () => ctx.governor || null, log });
    }
  } catch (err) {
    stop("start");
    return { ok: false, reason: "WAR_CONTRACTS_START_FAILED", detail: messageOf(err) };
  }
  log(`running factionsPerPass=${settings.factionsPerPass} open=${open} deliverRefs=${frontJobRepo ? "on" : "off"}`
    + ` chat=${chat}`);
  return { ok: true, warContracts: facade };
}

module.exports = { startWarContracts, createUnavailableWarContracts, COUNTER_NAMES, OBSERVE_NAMES, FACADE_METHODS };
