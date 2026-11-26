"use strict";

const SC = require("./schema");
const { titleOf } = require("./data/titles");
const { filetimeOf } = require("../notices/schema");

const { LEG, REWARD_STATE } = SC;
const MAX_DETAIL = 120;
const PERMANENT_REASONS = new Set(["CHARACTER_NOT_FOUND", "BALANCE_LIMIT", "WALLET_KEY_INVALID",
  "IDEMPOTENCY_KEY_REUSED", "GRANT_KEY_INVALID"]);
const SEAM_WAIT_REASONS = new Set(["SEAM_UNAVAILABLE", "MAIL_SEAM_UNAVAILABLE"]);
const LINE_BREAK = "<br>";
const MAX_TITLE = 150;
const REWARD_METHODS = Object.freeze(["rewardCreditIsk", "tradeGrantStock", "tradeGrantReceipt",
  "seasonRewardStation", "sendPlayerMail", "findPlayerMail", "defaultMailSender"]);

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function retryDelayOf(attempts, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 62));
}

const untouched = (state) => ({ state, transient: false, waiting: false, error: null, duplicate: false });
const final = (state, error) => ({ state, transient: false, waiting: false, error: error || null, duplicate: false });

function legOutcome(r) {
  if (r && r.ok === true) {
    return { state: LEG.DONE, transient: false, waiting: false, error: null,
      duplicate: r.duplicate === true || r.outcome === "DUPLICATE" };
  }
  const reason = String((r && r.reason) || "NO_RESULT");
  const error = `${reason}${r && r.detail ? `:${r.detail}` : ""}`.slice(0, MAX_DETAIL);
  if (SEAM_WAIT_REASONS.has(reason)) return { state: LEG.PENDING, transient: false, waiting: true, error, duplicate: false };
  if ((r && r.permanent === true && r.ambiguous !== true) || PERMANENT_REASONS.has(reason)) {
    return final(LEG.FAILED, error);
  }
  return { state: LEG.PENDING, transient: true, waiting: false, error, duplicate: false };
}

function planMark(row, outcomes, P, now) {
  const states = outcomes.map((o) => o.state);
  const transient = outcomes.some((o) => o.transient);
  const lastError = outcomes.map((o) => o.error).filter(Boolean).join("; ").slice(0, MAX_DETAIL) || row.lastError;
  let attempts = row.attempts;
  let nextAttemptAt = row.nextAttemptAt;
  let retried = false;
  if (transient) {
    attempts += 1;
    if (attempts >= P.payoutMaxAttempts) {
      for (let i = 0; i < states.length; i += 1) if (outcomes[i].transient) states[i] = LEG.FAILED;
    } else {
      retried = true;
      nextAttemptAt = now + retryDelayOf(row.attempts, P.payoutRetryBaseMs, P.payoutRetryMaxMs);
    }
  }
  const open = states.some((s) => s === LEG.PENDING || s === LEG.SENDING);
  if (open && !retried) nextAttemptAt = now + P.payoutRetryBaseMs;
  const state = open ? REWARD_STATE.PENDING
    : (states.includes(LEG.FAILED) ? REWARD_STATE.FAILED : REWARD_STATE.DONE);
  return { iskState: states[0], itemState: states[1], mailState: states[2], state, attempts, nextAttemptAt,
    lastError };
}

function rewardMailOf(row) {
  const title = `LNE ${titleOf(row.tier, row.seasonNo, "en") || `Season ${row.seasonNo} reward`}`.slice(0, MAX_TITLE);
  const isk = row.iskState === LEG.DONE ? `ISK: ${row.iskAmount} ISK credited to your wallet.`
    : (row.iskState === LEG.FAILED ? "ISK: the payment failed." : "ISK: none.");
  let item = "Item: none.";
  if (row.itemState === LEG.DONE) {
    item = `Item: ${row.itemQty} x type ${row.itemTypeId} delivered to your hangar in station ${row.stationId}.`;
  } else if (row.itemState === LEG.FAILED) item = "Item: the delivery failed.";
  else if (row.itemTypeId > 0) item = "Item: no station to deliver it to.";
  const body = [`Season ${row.seasonNo} is over. Outcome: ${row.outcome}.`,
    `Your place: ${row.rank} with ${row.points} points.`, `Title: ${titleOf(row.tier, row.seasonNo, "en")}.`, isk, item]
    .join(LINE_BREAK);
  return { title, body };
}

function createSeasonRewardPump(deps) {
  const { store, repo, adapter, bump, log, isStopped } = deps;
  const P = deps.settings;
  let pending = 0;
  let nextDueAt = 0;
  let planned = false;
  let nextPruneAt = 0;
  let passes = 0;
  let lastRefusal = null;
  let senderId = null;

  function tx(name, fn) {
    let res = null;
    try {
      res = store.transaction(name, fn);
    } catch (err) {
      return { ok: false, reason: "TX_THREW", detail: messageOf(err) };
    }
    if (!res || res.ok !== true) return { ok: false, reason: String((res && res.reason) || "no_result") };
    const v = res.value;
    return v && v.ok === true ? v : { ok: false, reason: String((v && v.reason) || "no_result") };
  }

  function call(fn, fallback) {
    try {
      return fn();
    } catch (err) {
      return { ...fallback, detail: messageOf(err) };
    }
  }

  function boot() {
    const r = tx("seasons.rewardBoot", (t) => repo.countPendingRewardsInTx(t));
    pending = r.ok ? r.pending : 1;
    return r;
  }

  function prune(now) {
    if (now < nextPruneAt) return;
    nextPruneAt = now + P.pruneEveryMs;
    if (P.scoreRetentionMs === 0 || now - P.scoreRetentionMs <= 0) return;
    const r = tx("seasons.scorePrune", (t) => repo.pruneScoresInTx(t, now - P.scoreRetentionMs, P.prunePerRun));
    if (r.ok) bump("scoresPruned", r.deleted);
    else lastRefusal = `scorePrune:${r.reason}`;
  }

  async function payIsk(row) {
    if (row.iskState !== LEG.PENDING) return untouched(row.iskState);
    let r;
    try {
      r = await adapter.rewardCreditIsk({ characterId: row.characterId, amountIsk: row.iskAmount,
        commandId: SC.keyOfRewardLeg(row.seasonNo, row.characterId, "isk"), issuerCorporationId: null,
        systemId: row.seasonNo, description: SC.rewardDescriptionOf(row.seasonNo), source: SC.REWARD_ISK_SOURCE });
    } catch (err) {
      r = { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
    }
    return legOutcome(r);
  }

  function payItem(row) {
    if (row.itemState !== LEG.PENDING) return { outcome: untouched(row.itemState), stationId: row.stationId };
    let stationId = isId(row.stationId) ? row.stationId : null;
    if (stationId === null) {
      const s = call(() => adapter.seasonRewardStation(row.characterId, P.rewardFallbackStationId),
        { ok: false, reason: "STATION_THREW" });
      if (s && s.ok === true && isId(s.stationId)) stationId = s.stationId;
      else if (s && s.reason === "NO_STATION") return { outcome: final(LEG.SKIPPED, "NO_STATION"), stationId: null };
      else return { outcome: legOutcome(s), stationId: null };
    }
    const key = SC.keyOfRewardLeg(row.seasonNo, row.characterId, "item");
    if (row.attempts > 0) {
      const rc = call(() => adapter.tradeGrantReceipt(key), { ok: false, reason: "GRANT_RECEIPT_AMBIGUOUS" });
      if (!rc || rc.ok !== true) return { outcome: legOutcome(rc), stationId };
      if (rc.found === true) return { outcome: legOutcome({ ok: true, duplicate: true }), stationId };
    }
    const g = call(() => adapter.tradeGrantStock({ ownerKind: "character", ownerId: row.characterId,
      npcStationId: stationId, typeId: row.itemTypeId, quantity: row.itemQty, key }),
    { ok: false, reason: "GRANT_FAILED", permanent: false, ambiguous: true });
    return { outcome: legOutcome(g), stationId };
  }

  function resolveSender() {
    if (senderId !== null) return { ok: true, senderId };
    const r = call(() => adapter.defaultMailSender(), { ok: false, reason: "MAIL_THREW" });
    if (r && r.ok === true && isId(r.senderId)) {
      senderId = r.senderId;
      return { ok: true, senderId };
    }
    return { ok: false, reason: String((r && r.reason) || "MAIL_NO_SENDER") };
  }

  function lookupMail(row, title) {
    const f = call(() => adapter.findPlayerMail({ characterId: row.characterId, senderId: row.mailSenderId,
      sentDate: row.mailSentDate, title }), { ok: false, reason: "MAIL_THREW" });
    if (!f || f.ok !== true) {
      return { outcome: { state: LEG.SENDING, transient: false, waiting: true, duplicate: false,
        error: `LOOKUP ${(f && f.reason) || "NO_RESULT"}`.slice(0, MAX_DETAIL) }, messageId: null };
    }
    if (f.found === true) return { outcome: final(LEG.DONE), messageId: Number(f.messageId) || null };
    return { outcome: final(LEG.FAILED, "MAIL_NOT_IN_MAILBOX"), messageId: null };
  }

  function sendMail(row, now) {
    const sender = resolveSender();
    if (!sender.ok) return { outcome: legOutcome({ ok: false, reason: sender.reason }), row, opened: false };
    const sentDate = filetimeOf(now);
    const opened = tx("seasons.rewardMailOpen", (t) => repo.updateRewardInTx(t, row.rewardKey, row.version,
      { iskState: row.iskState, itemState: row.itemState, stationId: row.stationId, mailState: LEG.SENDING,
        mailSenderId: sender.senderId, mailSentDate: sentDate, now }));
    if (!opened.ok) return { outcome: null, row, opened: false, error: `mailOpen ${opened.reason}` };
    const cur = opened.reward;
    const mail = rewardMailOf(cur);
    const sent = call(() => adapter.sendPlayerMail({ senderId: sender.senderId, toCharacterId: cur.characterId,
      title: mail.title, body: mail.body, sentDate }), { ok: false, reason: "MAIL_THREW", definite: false });
    if (sent && sent.ok === true) {
      return { outcome: final(LEG.DONE), row: cur, opened: true, messageId: Number(sent.messageId) || null };
    }
    if (sent && SEAM_WAIT_REASONS.has(sent.reason)) {
      return { outcome: { state: LEG.PENDING, transient: false, waiting: true, duplicate: false,
        error: String(sent.reason) }, row: cur, opened: true };
    }
    if (sent && sent.definite === false) {
      const found = lookupMail(cur, mail.title);
      return { outcome: found.outcome, row: cur, opened: true, messageId: found.messageId };
    }
    return { outcome: final(LEG.FAILED, `${(sent && sent.reason) || "NO_RESULT"}`.slice(0, MAX_DETAIL)), row: cur,
      opened: true };
  }

  function noteLegs(before, m) {
    for (const [leg, b, a] of [["isk", before.iskState, m.iskState], ["item", before.itemState, m.itemState],
      ["mail", before.mailState, m.mailState]]) {
      if (b !== a && (a === LEG.DONE || a === LEG.FAILED || a === LEG.SKIPPED)) bump(`rewardLeg.${leg}.${a}`);
    }
  }

  async function payOne(row, now, out, gate) {
    let cur = row;
    let isk;
    let item;
    let mail;
    let messageId = null;
    let stationId = row.stationId;
    if (row.mailState === LEG.SENDING) {
      isk = untouched(row.iskState);
      item = untouched(row.itemState);
      const found = lookupMail(row, rewardMailOf(row).title);
      mail = found.outcome;
      messageId = found.messageId;
    } else {
      isk = await payIsk(row);
      if (isStopped()) return false;
      const it = payItem(row);
      item = it.outcome;
      stationId = it.stationId;
      mail = untouched(row.mailState);
      const ready = isk.state !== LEG.PENDING && item.state !== LEG.PENDING;
      if (row.mailState === LEG.PENDING && ready) {
        const sent = sendMail({ ...row, iskState: isk.state, itemState: item.state, stationId }, now);
        if (!sent.opened && sent.outcome === null) {
          bump("rewardMarkFailed");
          lastRefusal = `reward:${row.rewardKey} ${sent.error}`;
          gate.due = Math.min(gate.due, now);
          return true;
        }
        if (sent.opened) cur = sent.row;
        mail = sent.outcome;
        messageId = sent.messageId || null;
      }
    }
    const m = planMark(cur, [isk, item, mail], P, now);
    const patch = { iskState: m.iskState, itemState: m.itemState, mailState: m.mailState, state: m.state,
      attempts: m.attempts, nextAttemptAt: m.nextAttemptAt, lastError: m.lastError, stationId, now };
    if (messageId !== null) patch.mailMessageId = messageId;
    const w = tx("seasons.rewardMark", (t) => repo.updateRewardInTx(t, cur.rewardKey, cur.version, patch));
    if (!w.ok) {
      bump("rewardMarkFailed");
      lastRefusal = `reward:${row.rewardKey} ${w.reason}`;
      gate.due = Math.min(gate.due, now);
      return true;
    }
    noteLegs(row, m);
    if (isk.duplicate || item.duplicate) bump("rewardDuplicates");
    if (m.state === REWARD_STATE.PENDING) {
      gate.due = Math.min(gate.due, m.nextAttemptAt);
      out.retried += 1;
      bump("rewardRetries");
      lastRefusal = m.lastError ? `reward:${row.rewardKey} ${m.lastError}` : lastRefusal;
      return true;
    }
    pending = Math.max(0, pending - 1);
    if (m.state === REWARD_STATE.DONE) {
      out.done += 1;
      bump("rewardsDone");
    } else {
      out.failed += 1;
      bump("rewardsFailed");
      lastRefusal = `reward:${row.rewardKey} ${m.lastError}`;
      log(`reward ${row.rewardKey} FAILED (isk=${m.iskState} item=${m.itemState} mail=${m.mailState}) - ${m.lastError}`);
    }
    return true;
  }

  async function runPass(now) {
    const out = { ok: true, done: 0, failed: 0, retried: 0 };
    try {
      if (isStopped()) return { ok: false, reason: "STOPPED" };
      passes += 1;
      if (pending > 0 && now >= nextDueAt) {
        planned = false;
        const read = tx("seasons.rewardRead", (t) => repo.listDueRewardsInTx(t, P.payoutMaxPerPass, now));
        if (!read.ok) {
          lastRefusal = `rewardRead:${read.reason}`;
          return { ok: false, reason: read.reason };
        }
        const short = read.rewards.length < P.payoutMaxPerPass;
        if (short) pending = read.rewards.length + (read.waiting || 0);
        const gate = { due: short && read.nextDueAt !== null ? read.nextDueAt : (short ? Infinity : now) };
        for (const row of read.rewards) {
          if (isStopped() || !(await payOne(row, now, out, gate))) return { ok: false, reason: "STOPPED" };
        }
        nextDueAt = planned || gate.due === Infinity ? 0 : gate.due;
      }
      if (!isStopped()) prune(now);
      return out;
    } catch (err) {
      lastRefusal = `rewardPass:${messageOf(err)}`;
      return { ok: false, reason: "PASS_FAILED" };
    }
  }

  return Object.freeze({
    boot,
    notePlanned: (n = 1) => {
      if (!(n > 0)) return;
      pending += n;
      nextDueAt = 0;
      planned = true;
    },
    runPass,
    status: () => Object.freeze({ pending, nextDueAt, passes, lastRefusal }),
  });
}

module.exports = { createSeasonRewardPump, planMark, legOutcome, retryDelayOf, rewardMailOf, REWARD_METHODS,
  PERMANENT_REASONS };
