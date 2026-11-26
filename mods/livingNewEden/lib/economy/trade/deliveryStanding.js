"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const R = require("./supplierStandingRules");
const L = require("./supplierLedger");
const { MAX_LINE: NOTICE_MAX_LINE } = require("../../notices/schema");
const { UNKNOWN } = require("../../names/fallback");

const COUNTER_NAMES = Object.freeze([
  "granted",
  "duplicate",
  "dailyCap",
  "noCharacter",
  "noValue",
  "invalid",
  "writeFailed",
  "applied",
  "appliedDuplicate",
  "failed",
  "keyReused",
  "expired",
  "transient",
  "invalidPayload",
  "carry",
  "windowCap",
  "ceiling",
  "standingUnreadable",
  "oversize",
  "ceilingAtApply",
  "wtsOffset",
  "wtsOffsetFailed",
  "noticeQueued",
  "noticeRefused",
]);
const PARAM_KEYS = Object.freeze([
  "standingGrantEnabled",
  "standingIskPer01",
  "standingGrowthPermille",
  "standingDailyCap",
  "standingWindowCap",
  "standingWindowDays",
  "standingCeiling",
  "standingMinGrant",
  "standingWtsOffsetEnabled",
  "standingNoticeEnabled",
  "standingMaxGrantsPerCharacterDay",
  "standingGrantMaxAgeMs",
]);
const MAX_DETAIL = 120;
const RECENT_GRANTS = 10;
const NOTICE_KIND = "SUPPLIER_STANDING";
const PERMILLE = 1000;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

class StandingRollback extends Error {
  constructor(refusal) {
    super(String((refusal && refusal.reason) || "STANDING_ROLLBACK"));
    this.name = "StandingRollback";
    this.refusal = refusal;
  }
}

function metric(telemetry, kind, name, value) {
  if (!telemetry || typeof telemetry[kind] !== "function") return;
  try {
    telemetry[kind](name, value);
  } catch (_err) {
  }
}

function bump(counters, telemetry, name, n = 1) {
  if (!(n > 0)) return;
  if (!Object.prototype.hasOwnProperty.call(counters, name)) return;
  counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + n);
  metric(telemetry, "count", `trade.${name}`, n);
}

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const writeFailed = (detail) => new StandingRollback({ ok: false, reason: "TRADE_STANDING_WRITE_FAILED",
  detail: String(detail || "LEDGER_FAILED").slice(0, MAX_DETAIL) });

function valueOf(offer) {
  const bonus = Number.isSafeInteger(offer.standingBonusPermille) && offer.standingBonusPermille > 0
    ? Math.min(PERMILLE, offer.standingBonusPermille) : 0;
  return Math.floor((offer.iskTotal * PERMILLE) / (PERMILLE + bonus));
}

function createDeliveryStanding(deps) {
  const { journal, scheduler, adapter, clock, config, maxRows, telemetry = null, logger = { log() {} },
    nowMs = () => performance.now() } = deps;
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const getNotices = typeof deps.getNotices === "function" ? deps.getNotices : () => null;

  const tradeCfg = config.trade || {};
  const params = Object.freeze(Object.fromEntries(PARAM_KEYS.map((k) => [k, tradeCfg[k]])));
  const enabled = params.standingGrantEnabled === true;
  const cap = params.standingMaxGrantsPerCharacterDay || 0;
  const capLimit = cap > 0 ? Math.min(cap, maxRows) : 0;
  const maxAgeMs = params.standingGrantMaxAgeMs || 0;
  const windowDays = Math.max(1, Math.trunc(params.standingWindowDays || 7));
  const ceiling = typeof params.standingCeiling === "number" ? params.standingCeiling : 3;
  const dailyCap = typeof params.standingDailyCap === "number" ? params.standingDailyCap : 0.3;
  const rulesParams = Object.freeze({
    iskPer01: params.standingIskPer01 || 20000000,
    growthPermille: params.standingGrowthPermille || 1600,
    dailyCap,
    windowCap: typeof params.standingWindowCap === "number" ? params.standingWindowCap : 0,
    ceiling,
    minGrant: typeof params.standingMinGrant === "number" ? params.standingMinGrant : 0.001,
    maxGrantsPerDay: capLimit,
  });
  const maxRaw = R.maxRawOf(dailyCap, ceiling);
  const wtsOffsetEnabled = params.standingWtsOffsetEnabled !== false;
  const noticeEnabled = params.standingNoticeEnabled !== false;

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let stopped = false;
  let seq = 0;
  let lastRefusal = null;
  const recentGrants = [];

  function refuse(where, reason) {
    lastRefusal = `${where}:${String(reason).slice(0, MAX_DETAIL)}`;
    seq += 1;
  }

  function log(message) {
    try {
      logger.log(message);
    } catch (_err) {
    }
  }

  function readStanding(characterId, factionId) {
    try {
      if (!adapter || typeof adapter.readCharacterStanding !== "function") return { ok: false };
      const r = adapter.readCharacterStanding(characterId, factionId);
      if (!r || r.ok !== true || typeof r.standing !== "number" || !Number.isFinite(r.standing)) return { ok: false };
      return { ok: true, standing: Math.max(-10, Math.min(10, r.standing)) };
    } catch (_err) {
      return { ok: false };
    }
  }

  function ledger(fn) {
    let r;
    try {
      r = fn();
    } catch (err) {
      throw writeFailed(messageOf(err));
    }
    if (!r || r.ok !== true) throw writeFailed(r && (r.detail || r.reason));
    return r;
  }

  function decideInTx(tx, offer, at) {
    if (stopped) return { ok: false, reason: "TRADE_STANDING_STOPPED" };
    if (!enabled) return { ok: true, outcome: "STANDING_DISABLED" };

    if (!offer || typeof offer !== "object" || !isPosInt(offer.factionId)
      || typeof offer.offerId !== "string" || offer.offerId === "" || !Number.isSafeInteger(at) || at < 0) {
      bump(counters, telemetry, "invalid");
      return { ok: true, outcome: "INVALID", detail: "offer" };
    }
    if (!Number.isSafeInteger(offer.iskTotal) || offer.iskTotal < 1) {
      bump(counters, telemetry, "noValue");
      return { ok: true, outcome: "NO_VALUE", detail: "iskTotal" };
    }
    if (!isPosInt(offer.acceptorCharacterId)) {
      bump(counters, telemetry, "noCharacter");
      return { ok: true, outcome: "NO_CHARACTER" };
    }
    const characterId = offer.acceptorCharacterId;
    const factionId = offer.factionId;
    const offerId = offer.offerId;
    const day = Math.floor(at / S.STANDING_DAY_MS);
    const key = S.standingGrantKey({ characterId, day, factionId, offerId });

    const seen = journal.findByKey(tx, key);
    if (!seen.ok) throw new StandingRollback({ ok: false, reason: "TRADE_STANDING_WRITE_FAILED", detail: seen.reason });
    if (seen.found) {
      bump(counters, telemetry, "duplicate");
      return { ok: true, outcome: "DUPLICATE", key };
    }

    const read = readStanding(characterId, factionId);
    if (!read.ok) {
      bump(counters, telemetry, "standingUnreadable");
      return { ok: true, outcome: "STANDING_UNREADABLE", key, characterId, factionId, offerId };
    }
    const standing = read.standing;
    const valueIsk = valueOf(offer);
    const win = ledger(() => L.readWindowInTx(tx, characterId, factionId, day, windowDays));
    const plan = R.planSupplierGrant({ standing, valueIsk, today: win.today, window: win.window }, rulesParams);
    if (!plan.ok) {
      bump(counters, telemetry, "invalid");
      return { ok: true, outcome: "INVALID", detail: plan.detail };
    }

    if (plan.outcome !== "GRANT") {
      ledger(() => L.addInTx(tx, characterId, factionId, day, { creditIsk: plan.creditIsk }, at));
      ledger(() => L.pruneInTx(tx, characterId, factionId, day - windowDays));
      const outcome = plan.outcome === "DAILY_COUNT" ? "DAILY_CAP" : plan.outcome;
      bump(counters, telemetry, { DAILY_CAP: "dailyCap", CARRY: "carry", WINDOW_CAP: "windowCap",
        CEILING: "ceiling" }[outcome]);
      return { ok: true, outcome, key, characterId, factionId, offerId };
    }

    const outboxRes = journal.enqueueOutbox(tx, {
      key,
      aggregate: { type: "character", id: String(characterId) },
      eventType: S.EVENT_STANDING_GRANT,
      payload: {
        characterId,
        factionId,
        offerId,
        iskTotal: offer.iskTotal,
        day,
        rawChange: plan.rawChange,
        creditIsk: plan.creditIsk,
        gainMicro: plan.gainMicro,
        standingAt: standing,
      },
    });
    if ((outboxRes.ok && outboxRes.duplicate) || (!outboxRes.ok && outboxRes.reason === "IDEMPOTENCY_CONFLICT")) {
      bump(counters, telemetry, "duplicate");
      return { ok: true, outcome: "DUPLICATE", key };
    }
    if (!outboxRes.ok) {
      throw new StandingRollback({ ok: false, reason: "TRADE_STANDING_WRITE_FAILED", detail: outboxRes.reason });
    }

    const schedRes = scheduler.enqueue(
      S.EVENT_STANDING_GRANT,
      String(characterId),
      at,
      { characterId, factionId, journalId: outboxRes.journalId, offerId, rawChange: plan.rawChange },
      key,
      { tx }
    );
    if (!schedRes || !schedRes.ok) {
      throw new StandingRollback({ ok: false, reason: "TRADE_STANDING_WRITE_FAILED",
        detail: (schedRes && schedRes.reason) || "ENQUEUE_FAILED" });
    }

    ledger(() => L.addInTx(tx, characterId, factionId, day,
      { creditIsk: plan.creditIsk, gainMicro: plan.gainMicro, grants: 1 }, at));
    ledger(() => L.pruneInTx(tx, characterId, factionId, day - windowDays));

    bump(counters, telemetry, "granted");
    metric(telemetry, "observe", "trade.supplierGainMicro", plan.gainMicro);
    return { ok: true, outcome: "GRANTED", key, characterId, factionId, offerId, rawChange: plan.rawChange,
      gainMicro: plan.gainMicro, standingAt: standing, at };
  }

  function noteWtsInTx(tx, offer, at) {
    try {
      if (stopped || !enabled || !wtsOffsetEnabled) return { ok: true, outcome: "SKIPPED" };
      if (!offer || offer.side !== S.SIDE_SELL || !isPosInt(offer.acceptorCharacterId) || !isPosInt(offer.factionId)
        || !Number.isSafeInteger(offer.iskTotal) || offer.iskTotal < 1 || !Number.isSafeInteger(at) || at < 0) {
        return { ok: true, outcome: "SKIPPED" };
      }
      const day = Math.floor(at / S.STANDING_DAY_MS);
      const add = L.addInTx(tx, offer.acceptorCharacterId, offer.factionId, day, { wtsIsk: offer.iskTotal }, at);
      if (!add.ok) throw new Error(add.detail || add.reason);
      L.pruneInTx(tx, offer.acceptorCharacterId, offer.factionId, day - windowDays);
      bump(counters, telemetry, "wtsOffset");
      return { ok: true, outcome: "NOTED" };
    } catch (err) {
      bump(counters, telemetry, "wtsOffsetFailed");
      refuse("trade.standing.wts", messageOf(err));
      return { ok: false, reason: "WTS_OFFSET_FAILED" };
    }
  }

  function noteCommitted(decision) {
    if (!decision || decision.ok !== true) return;
    if (decision.outcome === "GRANTED") {
      recentGrants.unshift({
        characterId: decision.characterId,
        factionId: decision.factionId,
        offerId: decision.offerId,
        rawChange: decision.rawChange,
        gainMicro: decision.gainMicro,
        standingAt: decision.standingAt,
        at: decision.at,
      });
      if (recentGrants.length > RECENT_GRANTS) recentGrants.pop();
      log(`trade: standing granted char=${decision.characterId} faction=${decision.factionId} offer=${decision.offerId}`
        + ` raw=${decision.rawChange} gain=${decision.gainMicro / R.MICRO} at=${decision.standingAt}`);
    }
  }

  function noteWriteFailed(refusal) {
    if (!refusal || refusal.ok !== false) return;
    if (refusal.reason === "TRADE_STANDING_WRITE_FAILED") {
      bump(counters, telemetry, "writeFailed");
      lastRefusal = `decideInTx:${refusal.detail || refusal.reason}`;
      seq += 1;
    }
  }

  function noticeLine(p, w) {
    const name = factionNames.get(p.factionId) || UNKNOWN.faction;
    const now = typeof w.standing === "number" ? w.standing : null;
    const before = typeof w.previousStanding === "number" ? w.previousStanding : null;
    const line = now !== null && before !== null
      ? `Dostawy dla ${name}: standing +${(now - before).toFixed(3)} (teraz ${now.toFixed(3)})`
      : `Dostawy dla ${name}: standing wzrósł`;
    return line.slice(0, NOTICE_MAX_LINE);
  }

  function noticeInTx(tx, key, p, w, now) {
    if (!noticeEnabled) return;
    let notices = null;
    try {
      notices = getNotices();
    } catch (_err) {
      notices = null;
    }
    if (!notices || typeof notices.enqueueItemsInTx !== "function") {
      bump(counters, telemetry, "noticeRefused");
      return;
    }
    try {
      const r = notices.enqueueItemsInTx(tx, [{ eventKey: key, characterId: p.characterId, kind: NOTICE_KIND,
        systemId: 0, line: noticeLine(p, w), eventAt: now }], now);
      if (r && r.ok === true) bump(counters, telemetry, "noticeQueued", r.inserted);
      else bump(counters, telemetry, "noticeRefused");
    } catch (err) {
      bump(counters, telemetry, "noticeRefused");
      refuse("trade.standing.notice", messageOf(err));
    }
  }

  function failedResult(p, detail, counter, tag) {
    bump(counters, telemetry, counter);
    return {
      ok: true,
      outcome: "FAILED",
      effect: (tx) => journal.markFailed(tx, p.journalId, detail),
      onCommitted: () => {
        log(`trade: standing failed ${detail} ${tag}`);
      },
    };
  }

  function handler(ev, hctx) {
    try {
      const p = S.parseStandingPayload(ev && ev.payload);
      const key = ev && typeof ev.idempotencyKey === "string" ? ev.idempotencyKey : "";
      if (!p || key === "") {
        bump(counters, telemetry, "invalidPayload");
        return { ok: false, reason: "TRADE_STANDING_PAYLOAD_INVALID", permanent: true };
      }
      if (stopped) return { ok: false, reason: "TRADE_STANDING_STOPPED" };

      const now = hctx && Number.isSafeInteger(hctx.now) ? hctx.now : clock.now();
      const decidedAt = Number.isSafeInteger(ev.createdAt) ? ev.createdAt : ev.dueAt;
      const tag = `char=${p.characterId} faction=${p.factionId} offer=${p.offerId} key=${key}`;

      if (maxAgeMs > 0 && now - decidedAt > maxAgeMs) {
        bump(counters, telemetry, "expired");
        return {
          ok: true,
          outcome: "EXPIRED",
          effect: (tx) => journal.markFailed(tx, p.journalId, "EXPIRED"),
          onCommitted: () => {
            log(`trade: standing expired (age ${now - decidedAt} ms) ${tag}`);
          },
        };
      }

      if (p.rawChange > maxRaw) return failedResult(p, "OVERSIZE", "oversize", tag);
      const read = readStanding(p.characterId, p.factionId);
      if (read.ok && read.standing >= ceiling) return failedResult(p, "CEILING", "ceilingAtApply", tag);

      const t0 = nowMs();
      const w = adapter.applyStandingGrant(
        { key, characterId: p.characterId, factionId: p.factionId, rawChange: p.rawChange, reason: S.STANDING_REASON },
        { eventTypeId: 486, msgByReason: Object.freeze({ FACTION_DELIVERY: "Faction trade delivery (Living New Eden)" }) }
      );
      metric(telemetry, "observe", "trade.standingGrantMs", Math.round((nowMs() - t0) * 100) / 100);

      if (w && w.ok === true) {
        const duplicate = w.outcome === "DUPLICATE";
        bump(counters, telemetry, duplicate ? "appliedDuplicate" : "applied");
        return {
          ok: true,
          outcome: duplicate ? "DUPLICATE" : "APPLIED",
          effect: (tx) => {
            const m = journal.markApplied(tx, p.journalId);
            if (!duplicate) noticeInTx(tx, key, p, w, now);
            return m;
          },
          onCommitted: () => {
            log(duplicate
              ? `trade: standing +${p.rawChange} duplicate ${tag}`
              : `trade: standing +${p.rawChange} ${tag}`);
          },
        };
      }

      const reason = (w && w.reason) || "STANDING_WRITE_FAILED";
      if (w && w.permanent === true) {
        const reused = reason === "IDEMPOTENCY_KEY_REUSED";
        const detail = reused ? "KEY_REUSED_APPLIED" : reason;
        bump(counters, telemetry, reused ? "keyReused" : "failed");
        return {
          ok: true,
          outcome: "FAILED",
          effect: (tx) => journal.markFailed(tx, p.journalId, detail),
          onCommitted: () => {
            log(`trade: standing failed ${detail}${w.detail && !reused ? ` (${w.detail})` : ""} ${tag}`);
          },
        };
      }

      bump(counters, telemetry, "transient");
      refuse("trade.standing.handler", w && w.detail ? `${reason}:${w.detail}` : reason);
      return { ok: false, reason };
    } catch (err) {
      refuse("trade.standing.handler", messageOf(err));
      return { ok: false, reason: `TRADE_STANDING_HANDLER_FAILED:${messageOf(err)}`.slice(0, MAX_DETAIL) };
    }
  }

  function getStatus() {
    return Object.freeze({
      state: stopped ? "stopped" : "ready",
      seq,
      counters: Object.freeze({ ...counters }),
      lastRefusal,
      recentGrants: Object.freeze([...recentGrants]),
      params: Object.freeze({ ...params, capLimit, maxRaw }),
    });
  }

  return Object.freeze({
    decideInTx,
    noteWtsInTx,
    noteCommitted,
    noteWriteFailed,
    handler,
    getStatus,
    params: Object.freeze({ ...params }),
    stop() {
      stopped = true;
    },
    isStopped: () => stopped,
  });
}

module.exports = { createDeliveryStanding, StandingRollback, COUNTER_NAMES, NOTICE_KIND };
