"use strict";

const S = require("./schema");
const { applyDebits } = require("./treasuryRepository");
const { feeOf, thresholdsOf, nextMode } = require("./austerity");
const { createTreasuryLossConsequence } = require("./lossConsequence");

const COUNTER_NAMES = Object.freeze(["seeded", "settled", "periodsCharged", "tradeFunded", "tradeLimited",
  "tradeRefused", "unpaid", "refused", "austerityEntered", "austerityExited", "productionFeeIsk",
  "mercFeeIsk", "mercRefundIsk",
  "lossSettled", "lossSkipped", "lossFitIsk", "lossUnvalued",
  "adminIsk", "warSpendIsk", "warSpendUnsettled"]);
const MERC_DIRECTIONS = Object.freeze(["fee", "refund"]);
const MAX_FEE_RUNS = 128;
const MAX_RUNS = 100;
const MAX_GROUP_LENGTH = 64;
const RUN = "run";
const OFF = "off";
const TRADE_RUN_MODES = Object.freeze(["run", "run-no-contracts"]);
const KEY_ERRORS = Object.freeze(["NESTED_KEY_REUSED", "IDEMPOTENCY_CONFLICT"]);
const PANEL_ROWS = 64;
const PANEL_DAYS = 8;
const AVG_DAYS = 7;
const MAX_REASON_LENGTH = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isIsk = (v) => Number.isSafeInteger(v) && v >= 0 && v <= S.MAX_ISK;
const capitalized = (kind) => `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function feeRunsOf(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_FEE_RUNS) return null;
  for (const e of v) {
    if (!e || typeof e.hullGroup !== "string" || e.hullGroup === "" || e.hullGroup.length > MAX_GROUP_LENGTH
      || !Number.isSafeInteger(e.runs) || e.runs < 1 || e.runs > MAX_RUNS) return null;
  }
  return v;
}

function netOf(d) {
  return d.income + d.tradeIn - d.fleetUpkeep - d.productionFees - d.losses - d.tradeOut - (d.mercFees || 0)
    + (d.mercRefunds || 0) - (d.admin || 0) - (d.warSpend || 0);
}

function createTreasuryService(deps) {
  const { store, repository, config, clock, hullValues } = deps;
  const telemetry = deps.telemetry || null;
  const T = config.treasury;
  const budgetFactor = config.strategy && Number.isFinite(config.strategy.budgetFactor)
    ? config.strategy.budgetFactor : 1;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = RUN;
  let seq = 0;
  let lastRefusal = null;

  function metric(name, value) {
    if (!telemetry || typeof telemetry.count !== "function") return;
    try { telemetry.count(name, value); } catch (_err) {}
  }

  function count(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + n);
    seq += 1;
    metric(`treasury.${name}`, n);
  }

  function tradeOf() {
    const tr = typeof deps.getTrade === "function" ? call(deps.getTrade, null) : null;
    return tr && typeof tr.getMode === "function" ? tr : null;
  }

  function initialIskOf(kind) {
    const v = S.KINDS.includes(kind) ? T[`initialIsk${capitalized(kind)}`] : 0;
    return Math.min(S.MAX_ISK, Math.max(0, Math.floor((Number.isSafeInteger(v) ? v : 0) * budgetFactor)));
  }

  function factionDayTradeOut(db, f, day) {
    const r = repository.daysInDb(db, f, { limit: 1 });
    if (!r.ok) return r;
    return { ok: true, isk: r.days.length > 0 && r.days[0].day === day ? r.days[0].tradeOut : 0 };
  }

  function todayRowOf(db, f, day) {
    const r = repository.daysInDb(db, f, { limit: 1 });
    if (!r.ok) return r;
    const d = r.days.length > 0 && r.days[0].day === day ? r.days[0] : null;
    return { ok: true, today: { tradeOut: d ? d.tradeOut : 0, warSpend: d ? d.warSpend || 0 : 0,
      productionFees: d ? d.productionFees : 0, losses: d ? d.losses : 0 } };
  }

  const spendOf = (d) => ({ tradeOut: d ? d.tradeOut : 0, warSpend: d ? d.warSpend || 0 : 0,
    productionFees: d ? d.productionFees : 0, losses: d ? d.losses : 0 });

  function windowRowsOf(db, f, day) {
    const r = repository.daysInDb(db, f, { limit: 2 });
    if (!r.ok) return r;
    const t = r.days.find((d) => d.day === day) || null;
    const y = r.days.find((d) => d.day === day - 1) || null;
    return { ok: true, today: spendOf(t), yesterday: y ? spendOf(y) : null };
  }

  function readForReview(db, factionId, opts) {
    if (state !== RUN) return { ok: true, treasury: { mode: "off" } };
    if (!isId(factionId) || !opts || !isTime(opts.at)) {
      return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "opts" };
    }
    const g = repository.getInDb(db, factionId);
    if (!g.ok) return g;
    const row = g.treasury;
    const kind = row ? row.kind : String(opts.kind || "");
    const tr = tradeOf();
    const trMode = tr ? call(() => tr.getMode(), OFF) : OFF;
    const npc = Number.isSafeInteger(opts.npcStations) ? opts.npcStations : 0;
    const tradeEligible = TRADE_RUN_MODES.includes(trMode) && npc >= 1 && typeof tr.fundFromTreasuryInTx === "function";
    let tradeHeldIsk = null;
    if (tr && typeof tr.readBudget === "function") {
      const b = call(() => tr.readBudget(db, factionId), null);
      if (b && b.ok && b.budget) tradeHeldIsk = b.budget.availableIsk + b.budget.reservedIsk;
    }
    const day = S.dayOf(opts.at);
    const rolling = T.pressureEnabled === true && T.warRoomRollingEnabled === true;
    const mine = rolling ? windowRowsOf(db, factionId, day) : todayRowOf(db, factionId, day);
    if (!mine.ok) return mine;
    const galaxy = repository.galaxyDaySumInDb(db, day, "trade_out");
    if (!galaxy.ok) return galaxy;
    const lw = lossWindowOf(db, factionId, day, opts.lossWindowDays);
    if (!lw.ok) return lw;
    return { ok: true, treasury: { mode: "ready", seeded: row !== null, kind,
      initialIsk: row ? row.initialIsk : initialIskOf(kind), balanceIsk: row ? row.balanceIsk : 0,
      accountMode: row ? row.mode : S.MODE_NORMAL, paidUntil: row ? row.paidUntil : null,
      valueByGroup: hullValues.all(), tradeHeldIsk, tradeEligible, factionTradeOutToday: mine.today.tradeOut,
      galaxyTradeOutToday: galaxy.isk, ...(T.pressureEnabled === true ? { today: mine.today } : {}),
      ...(rolling ? { yesterday: mine.yesterday } : {}),
      ...(lw.lossWindow ? { lossWindow: lw.lossWindow } : {}) } };
  }

  function lossWindowOf(db, f, day, wanted) {
    if (!Number.isSafeInteger(wanted) || wanted < 1) return { ok: true, lossWindow: null };
    const retention = Number.isSafeInteger(T.dayRetentionDays) && T.dayRetentionDays > 0 ? T.dayRetentionDays
      : S.MAX_DAYS_READ;
    const days = Math.min(wanted, S.MAX_DAYS_READ, retention);
    const r = repository.daysInDb(db, f, { limit: days });
    if (!r.ok) return r;
    let lossValueIsk = 0;
    let shipsLost = 0;
    for (const d of r.days) {
      if (!(d.day > day - days)) continue;
      lossValueIsk = Math.min(Number.MAX_SAFE_INTEGER, lossValueIsk + (d.lossValue || 0));
      shipsLost = Math.min(Number.MAX_SAFE_INTEGER, shipsLost + (d.shipsLost || 0));
    }
    return { ok: true, lossWindow: { days, lossValueIsk, shipsLost } };
  }

  function readUnpaidDaysInDb(db, factionId, opts) {
    if (state !== RUN) return { ok: true, mode: "off" };
    if (!isId(factionId)) return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "factionId" };
    if (!opts || !isTime(opts.at) || !Number.isSafeInteger(opts.days) || opts.days < 1
      || opts.days > S.MAX_DAYS_READ) {
      return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "opts" };
    }
    const retention = Number.isSafeInteger(T.dayRetentionDays) && T.dayRetentionDays > 0 ? T.dayRetentionDays
      : S.MAX_DAYS_READ;
    const days = Math.min(opts.days, S.MAX_DAYS_READ, retention);
    const r = repository.daysInDb(db, factionId, { limit: days });
    if (!r.ok) return r;
    const day = S.dayOf(opts.at);
    let unpaidDays = 0;
    let unpaidIsk = 0;
    for (const d of r.days) {
      if (!(d.day > day - days) || !(d.unpaid > 0)) continue;
      unpaidDays += 1;
      unpaidIsk = Math.min(Number.MAX_SAFE_INTEGER, unpaidIsk + d.unpaid);
    }
    return { ok: true, mode: "ready", days, unpaidDays, unpaidIsk };
  }

  function seedIfMissingInTx(db, factionId, kind, at) {
    const g = repository.getInDb(db, factionId);
    if (!g.ok) return g;
    if (g.treasury) return { ok: true, seeded: false, treasury: g.treasury };
    const k = typeof kind === "string" && kind !== "" ? kind : "neutral";
    const sd = repository.seedInTx(db, { factionId, kind: k, initialIsk: initialIskOf(k), at }, S.seedKey(factionId));
    if (!sd.ok) return sd;
    const again = repository.getInDb(db, factionId);
    if (!again.ok) return again;
    if (!again.treasury) return { ok: false, reason: "NO_TREASURY", detail: String(factionId) };
    return { ok: true, seeded: sd.duplicate !== true, treasury: again.treasury };
  }

  function settleIntentInTx(db, intent, ik) {
    if (state !== RUN) return { ok: false, reason: "TREASURY_UNAVAILABLE", detail: "stopped" };
    if (!intent || !isId(intent.factionId) || !isTime(intent.at) || !isTime(intent.paidUntilTo)
      || !isIsk(intent.income) || !isIsk(intent.fleetUpkeep) || !isIsk(intent.tradeWantIsk)
      || (intent.admin !== undefined && !isIsk(intent.admin))
      || (intent.warSpend !== undefined && !isIsk(intent.warSpend))
      || typeof ik !== "string" || ik === "") {
      return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "intent" };
    }
    const feeRuns = feeRunsOf(intent.feeRuns);
    if (!feeRuns) return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "feeRuns" };
    const f = intent.factionId;
    const at = intent.at;
    const day = S.dayOf(at);
    const notes = [];
    const sd = seedIfMissingInTx(db, f, intent.kind, at);
    if (!sd.ok) return sd;
    const seeded = sd.seeded;
    const row = sd.treasury;
    const from = intent.paidUntilFrom === undefined ? null : intent.paidUntilFrom;
    const rowFrom = row.paidUntil === undefined ? null : row.paidUntil;
    if (from !== rowFrom) return { ok: false, reason: "TREASURY_STALE", detail: `${rowFrom}/${from}` };
    const balance = row.balanceIsk;
    let fees = 0;
    for (const e of feeRuns) {
      const v = hullValues.valueOf(e.hullGroup);
      fees = Math.min(S.MAX_ISK, fees + feeOf(e.runs, Number.isSafeInteger(v) ? v : 0, T.productionFeePermille));
    }
    const credits = { income: intent.income };
    const admin = intent.admin === undefined ? 0 : intent.admin;
    const warSpend = intent.warSpend === undefined ? 0 : intent.warSpend;
    const pressure = admin > 0 || warSpend > 0 ? { admin, warSpend } : {};
    const pre = applyDebits(balance, credits, { fleetUpkeep: intent.fleetUpkeep, productionFees: fees, ...pressure });
    if (!pre.ok) return pre;
    const th = thresholdsOf(row.initialIsk, T.austerityEnterPermille, T.austerityExitPermille);

    let funded = 0;
    let limited = false;
    let tradeRefused = null;
    if (intent.tradeWantIsk > 0) {
      const mine = factionDayTradeOut(db, f, day);
      if (!mine.ok) return mine;
      const galaxy = repository.galaxyDaySumInDb(db, day, "trade_out");
      if (!galaxy.ok) return galaxy;
      const isk = row.mode === S.MODE_AUSTERITY ? 0 : Math.max(0, Math.min(intent.tradeWantIsk,
        Math.max(0, pre.balance - th.enterIsk), T.tradeTransferMaxIskPerDay - mine.isk,
        T.tradeTransferMaxIskPerDayGalaxy - galaxy.isk));
      limited = isk < intent.tradeWantIsk;
      if (isk > 0) {
        const tr = tradeOf();
        const t = tr && typeof tr.fundFromTreasuryInTx === "function"
          ? tr.fundFromTreasuryInTx(db, { factionId: f, isk, at }, `${ik}:trade`)
          : { ok: false, reason: "TRADE_UNAVAILABLE" };
        if (t && !t.ok && KEY_ERRORS.includes(t.reason)) return t;
        if (t && t.ok && Number.isSafeInteger(t.fundedIsk)) funded = Math.min(isk, Math.max(0, t.fundedIsk));
        else {
          tradeRefused = String((t && t.reason) || "NO_RESULT").slice(0, MAX_REASON_LENGTH);
          notes.push(`TREASURY_TRADE_REFUSED:${tradeRefused}`);
        }
      }
    }

    const debits = { fleetUpkeep: intent.fleetUpkeep, productionFees: fees, ...pressure, tradeOut: funded };
    const post = applyDebits(balance, credits, debits);
    if (!post.ok) return post;
    const mode = nextMode(row.mode, post.balance, th);
    const modeChanged = mode === row.mode ? null : mode === S.MODE_AUSTERITY ? "ENTER" : "EXIT";
    const st = repository.settleInTx(db, { factionId: f, day, at, credits, debits,
      patch: { paidUntil: intent.paidUntilTo, ...(modeChanged ? { mode } : {}) } }, `${ik}:treasury`);
    if (!st.ok) return st;
    if (st.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${ik}:treasury` };
    if (st.treasury.balanceIsk !== post.balance) {
      return { ok: false, reason: "TREASURY_BALANCE_DRIFT", detail: `${st.treasury.balanceIsk}/${post.balance}` };
    }
    if (modeChanged === "ENTER") notes.push("TREASURY_AUSTERITY_ENTER");
    if (modeChanged === "EXIT") notes.push("TREASURY_AUSTERITY_EXIT");
    const beforeDay = day - T.dayRetentionDays;
    if (T.pruneBatch > 0 && beforeDay > 0) {
      const p = repository.pruneDaysInDb(db, { beforeDay, limit: T.pruneBatch });
      if (!p.ok) return p;
    }
    return { ok: true, seeded, periods: intent.periods || 0, charged: intent.charged || 0, income: intent.income,
      fleetUpkeep: st.paid.fleetUpkeep, tradeFundedIsk: funded, tradeLimited: limited, tradeRefused,
      unpaid: st.unpaid, productionFees: fees, productionFeesPaid: st.paid.productionFees, mode, modeChanged, notes,
      ...(T.pressureEnabled === true ? { admin, warSpend, adminPaid: st.paid.admin || 0,
        warSpendPaid: st.paid.warSpend || 0 } : {}) };
  }

  function panelRow(t, days, today) {
    const todayRow = days.find((d) => d.day === today) || null;
    const yesterday = days.find((d) => d.day === today - 1) || null;
    const full = days.filter((d) => d.day < today).slice(0, AVG_DAYS);
    const avg = full.length > 0 ? Math.floor(full.reduce((n, d) => n + netOf(d), 0) / full.length) : null;
    const trend = avg === null || avg === 0 ? "FLAT" : avg > 0 ? "GROWING" : "FALLING";
    const th = thresholdsOf(t.initialIsk, T.austerityEnterPermille, T.austerityExitPermille);
    const falling = avg !== null && avg < 0;
    return { factionId: t.factionId, treasury: { mode: t.mode, modeChangedAt: t.modeChangedAt, kind: t.kind,
      balanceIsk: t.balanceIsk, initialIsk: t.initialIsk, totals: { ...t.totals } },
    today: todayRow, yesterday, avg7dNetIsk: avg,
    forecast: { trend, daysToZero: falling ? Math.floor(t.balanceIsk / -avg) : null,
      daysToAusterity: t.mode === S.MODE_NORMAL && falling
        ? Math.floor(Math.max(0, t.balanceIsk - th.enterIsk) / -avg) : null,
      austerityEnterIsk: th.enterIsk, austerityExitIsk: th.exitIsk } };
  }

  function listForPanel() {
    if (state !== RUN) return { ok: false, reason: "TREASURY_OFF" };
    const today = S.dayOf(clock.now());
    const tx = store.transaction("observer.treasury", (db) => {
      const l = repository.listInDb(db, { limit: PANEL_ROWS });
      if (!l.ok) return l;
      const rows = [];
      for (const t of l.rows) {
        const d = repository.daysInDb(db, t.factionId, { limit: PANEL_DAYS });
        if (!d.ok) return d;
        rows.push(panelRow(t, d.days, today));
      }
      return { ok: true, rows };
    });
    const value = tx && tx.ok ? tx.value : tx;
    return value && value.ok ? value : { ok: false, reason: String((value && value.reason) || "TX_FAILED") };
  }

  function creditTradeProceedsInTx(db, spec, key) {
    if (!(state === RUN && T.enabled === true)) return { ok: false, reason: "TREASURY_OFF" };
    if (!spec || !isId(spec.factionId) || !isIsk(spec.isk) || spec.isk < 1 || !isTime(spec.at)) {
      return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "spec" };
    }
    const r = repository.settleInTx(db, { factionId: spec.factionId, day: S.dayOf(spec.at), at: spec.at,
      credits: { tradeIn: spec.isk }, debits: {}, stats: {} }, key);
    if (!r || r.ok !== true) return r || { ok: false, reason: "TREASURY_SETTLE_FAILED" };
    return { ok: true, duplicate: r.duplicate === true };
  }

  const mercOn = () => state === RUN && T.enabled === true;

  function readMercAccountInDb(db, factionId) {
    if (!mercOn()) return { ok: true, mode: "off" };
    if (!isId(factionId)) return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "factionId" };
    const g = repository.getInDb(db, factionId);
    if (!g.ok) return g;
    const row = g.treasury;
    return { ok: true, mode: "ready", seeded: row !== null, balanceIsk: row ? row.balanceIsk : 0,
      accountMode: row ? row.mode : S.MODE_NORMAL };
  }

  function chargeMercInTx(db, spec, key) {
    if (!mercOn()) return { ok: false, reason: "TREASURY_OFF" };
    if (!spec || !isId(spec.factionId) || !isIsk(spec.isk) || spec.isk < 1 || !MERC_DIRECTIONS.includes(spec.direction)
      || !isTime(spec.at) || typeof key !== "string" || key === "") {
      return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "spec" };
    }
    const g = repository.getInDb(db, spec.factionId);
    if (!g.ok) return g;
    const row = g.treasury;
    if (!row) return { ok: false, reason: "NO_TREASURY", detail: String(spec.factionId) };
    const fee = spec.direction === "fee";
    if (fee && row.mode === S.MODE_AUSTERITY) return { ok: false, reason: "TREASURY_AUSTERITY" };
    if (fee && row.balanceIsk < spec.isk) {
      return { ok: false, reason: "TREASURY_INSUFFICIENT", detail: `${row.balanceIsk}/${spec.isk}` };
    }
    const r = repository.settleInTx(db, { factionId: spec.factionId, day: S.dayOf(spec.at), at: spec.at,
      credits: fee ? {} : { mercRefunds: spec.isk }, debits: fee ? { mercFees: spec.isk } : {}, stats: {} }, key);
    if (!r || r.ok !== true) return r || { ok: false, reason: "TREASURY_SETTLE_FAILED" };
    return { ok: true, duplicate: r.duplicate === true, balanceIsk: r.treasury.balanceIsk };
  }

  function chargeWarSpendInTx(db, spec, key) {
    if (!mercOn()) return { ok: false, reason: "TREASURY_OFF" };
    if (!spec || !isId(spec.factionId) || !isIsk(spec.isk) || spec.isk < 1 || !isTime(spec.at)
      || typeof key !== "string" || key === "") {
      return { ok: false, reason: "TREASURY_INVALID_INPUT", detail: "spec" };
    }
    const g = repository.getInDb(db, spec.factionId);
    if (!g.ok) return g;
    const row = g.treasury;
    if (!row) return { ok: false, reason: "NO_TREASURY", detail: String(spec.factionId) };
    if (row.mode === S.MODE_AUSTERITY) return { ok: false, reason: "TREASURY_AUSTERITY" };
    if (row.balanceIsk < spec.isk) {
      return { ok: false, reason: "TREASURY_INSUFFICIENT", detail: `${row.balanceIsk}/${spec.isk}` };
    }
    const r = repository.settleInTx(db, { factionId: spec.factionId, day: S.dayOf(spec.at), at: spec.at,
      credits: {}, debits: { warSpend: spec.isk }, stats: {} }, key);
    if (!r || r.ok !== true) return r || { ok: false, reason: "TREASURY_SETTLE_FAILED" };
    return { ok: true, duplicate: r.duplicate === true, balanceIsk: r.treasury.balanceIsk };
  }

  const lossConsequence = createTreasuryLossConsequence({ repository, hullValues, fitValuePermille: T.fitValuePermille,
    seedIfMissingInTx, isRunning: () => state === RUN && T.enabled === true, count,
    getRegistry: () => {
      const strategy = typeof deps.getStrategy === "function" ? call(deps.getStrategy, null) : null;
      return strategy && strategy.registry ? strategy.registry : null;
    } });

  return Object.freeze({
    getMode: () => (state === RUN ? RUN : OFF),
    lossConsequence,
    fundsTrade: () => state === RUN && T.enabled === true,
    creditTradeProceedsInTx,
    readMercAccountInDb,
    readUnpaidDaysInDb,
    chargeMercInTx,
    chargeWarSpendInTx,
    readForReview,
    settleIntentInTx,
    listForPanel,
    count,
    noteRefusal(reason) {
      lastRefusal = String(reason).slice(0, MAX_REASON_LENGTH);
      seq += 1;
    },
    getChangeCount: () => repository.getChangeCount(),
    getSeq: () => seq,
    getDay: () => S.dayOf(clock.now()),
    getStatus: () => Object.freeze({ state, seq, counters: Object.freeze({ ...counters }), lastRefusal,
      hullValuesVersion: hullValues.version }),
    stop() {
      state = "stopped";
      seq += 1;
    },
  });
}

module.exports = { createTreasuryService, COUNTER_NAMES, netOf };
