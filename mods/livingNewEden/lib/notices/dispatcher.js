"use strict";

const { performance } = require("node:perf_hooks");
const { BATCH_STATE, parsePriorityKinds } = require("./schema");
const { formatMail } = require("./format");

const MAIL_FORMAT = Object.freeze({ lineBreak: "<br>", maxBodyChars: 8000, maxTitleChars: 150 });
const RECONCILE_BATCH_FACTOR = 4;
const MS_DECIMALS = 10;
const SEAM_UNAVAILABLE = "MAIL_SEAM_UNAVAILABLE";
const LOOKUP_TIMEOUT = "LOOKUP_TIMEOUT";
const DELIVERY = Object.freeze({ SENT: "SENT", FAILED: "FAILED", HELD: "HELD", CANCELLED: "CANCELLED",
  ERROR: "ERROR" });
const URGENT_REFUSAL = Object.freeze({ FAILED: "MAIL_FAILED", HELD: "MAIL_UNCONFIRMED", CANCELLED: SEAM_UNAVAILABLE,
  ERROR: "FINISH_FAILED" });

class Abort {
  constructor(result) {
    this.result = result;
  }
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function createDispatcher(deps) {
  const store = deps.store;
  const repo = deps.repo;
  const adapter = deps.adapter;
  const s = deps.settings;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const observe = typeof deps.observe === "function" ? deps.observe : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const render = (lines) => formatMail(lines, MAIL_FORMAT);
  const priorityKinds = parsePriorityKinds(s.priorityKinds) || [];
  let senderId = null;
  let senderRefusal = null;
  let sendingHeld = 0;

  function tx(name, fn) {
    const r = store.transaction(name, (db) => {
      const out = fn(db);
      if (!out || out.ok !== true) throw new Abort(out || { ok: false, reason: "NO_RESULT" });
      return out;
    });
    if (r && r.ok) return { ok: true, value: r.value };
    if (r && r.error instanceof Abort) {
      const inner = r.error.result;
      return { ok: false, reason: String(inner.reason || "REFUSED"), ...(inner.detail ? { detail: inner.detail } : {}) };
    }
    return { ok: false, reason: r ? String(r.reason || "TX_FAILED") : "TX_FAILED",
      ...(r && r.error ? { detail: messageOf(r.error) } : {}) };
  }

  function fail(where, r) {
    bump("errors");
    log(`${where} ${r.reason}${r.detail ? ` - ${r.detail}` : ""}`);
  }

  function governorAdmits() {
    try {
      const g = getGovernor();
      return !g || typeof g.admits !== "function" || g.admits("MAINTENANCE") !== false;
    } catch (_err) {
      return true;
    }
  }

  function resolveSender() {
    if (senderId !== null) return { ok: true, senderId };
    if (s.senderCharacterId > 0) {
      senderId = s.senderCharacterId;
      return { ok: true, senderId };
    }
    const r = adapter.defaultMailSender();
    if (r && r.ok) {
      senderId = r.senderId;
      senderRefusal = null;
      return r;
    }
    const reason = (r && r.reason) || "NO_RESULT";
    if (senderRefusal !== reason) log(`no mail sender - ${reason}`);
    senderRefusal = reason;
    return { ok: false, reason };
  }

  function finish(batchKey, outcome, extra, now) {
    const r = tx("notices.finish", (db) => repo.finishBatchInTx(db, batchKey, { outcome, now,
      maxAttempts: s.maxAttempts, ...extra }));
    if (!r.ok) fail(`finish ${batchKey}`, r);
    return r;
  }

  function reconcileBatches(batches, now) {
    const out = { reconciled: 0, lost: 0, pending: 0, timedOut: 0 };
    const deadline = now - s.maxNoticeAgeMs;
    for (let i = 0; i < batches.length; i += 1) {
      const b = batches[i];
      const found = adapter.findPlayerMail({ characterId: b.characterId, senderId: b.senderId, sentDate: b.sentDate,
        title: b.title });
      if (!found || !found.ok) {
        const reason = (found && found.reason) || "NO_RESULT";
        fail(`reconcile ${b.batchKey}`, found || { reason });
        if (b.createdAt < deadline) {
          if (finish(b.batchKey, BATCH_STATE.FAILED, { error: LOOKUP_TIMEOUT, failItems: true }, now).ok) {
            out.timedOut += 1;
            bump("mailsFailed");
            log(`mail ${b.batchKey} to ${b.characterId} failed - ${LOOKUP_TIMEOUT} (${reason})`);
          } else {
            out.pending += 1;
          }
          continue;
        }
        if (reason === SEAM_UNAVAILABLE) {
          out.pending += batches.length - i;
          break;
        }
        out.pending += 1;
        continue;
      }
      if (found.found) {
        if (finish(b.batchKey, BATCH_STATE.SENT, { messageId: found.messageId }, now).ok) {
          out.reconciled += 1;
          bump("mailsReconciled");
        }
      } else if (finish(b.batchKey, BATCH_STATE.LOST, { error: "not in the mailbox" }, now).ok) {
        out.lost += 1;
        bump("mailsLost");
      }
    }
    return out;
  }

  function reconcileSending(now, limit, before) {
    const listed = tx("notices.sending", (db) => repo.listSendingInTx(db, limit, before));
    if (!listed.ok) {
      fail("sending list", listed);
      return { reconciled: 0, lost: 0, pending: 0, error: listed.reason };
    }
    return reconcileBatches(listed.value.batches, now);
  }

  function reconcile(now) {
    const r = reconcileSending(now, s.maxMailsPerPass * RECONCILE_BATCH_FACTOR, undefined);
    sendingHeld = r.pending;
    return r;
  }

  function sendOne(characterId, sender, now, out) {
    const opened = tx("notices.open", (db) => repo.openBatchInTx(db, { characterId, senderId: sender, now,
      maxItems: s.maxItemsPerMail, render, priorityKinds }));
    if (!opened.ok) {
      fail(`open ${characterId}`, opened);
      return false;
    }
    const batch = opened.value.batch;
    if (!batch) return false;
    return deliver(batch, now, out) === DELIVERY.CANCELLED;
  }

  function deliver(batch, now, out) {
    const t0 = nowMs();
    const sent = adapter.sendPlayerMail({ senderId: batch.senderId, toCharacterId: batch.characterId,
      title: batch.title, body: batch.body, sentDate: batch.sentDate });
    observe("sendMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    if (sent && !sent.ok && sent.reason === SEAM_UNAVAILABLE) {
      fail(`send ${batch.batchKey}`, sent);
      const undone = tx("notices.cancel", (db) => repo.cancelBatchInTx(db, batch.batchKey, { now }));
      if (undone.ok) out.cancelled += 1;
      else fail(`cancel ${batch.batchKey}`, undone);
      return DELIVERY.CANCELLED;
    }
    let outcome = BATCH_STATE.FAILED;
    let extra = { error: sent && sent.reason ? `${sent.reason}${sent.detail ? `:${sent.detail}` : ""}` : "NO_RESULT" };
    if (sent && sent.ok) {
      outcome = BATCH_STATE.SENT;
      extra = { messageId: sent.messageId };
    } else if (sent && sent.definite === false) {
      const found = adapter.findPlayerMail({ characterId: batch.characterId, senderId: batch.senderId,
        sentDate: batch.sentDate, title: batch.title });
      if (!found || !found.ok) {
        fail(`lookup ${batch.batchKey}`, found || { reason: "NO_RESULT" });
        out.held += 1;
        return DELIVERY.HELD;
      }
      if (found.found) {
        outcome = BATCH_STATE.SENT;
        extra = { messageId: found.messageId };
        bump("mailsReconciled");
      }
    }
    if (!finish(batch.batchKey, outcome, extra, now).ok) return DELIVERY.ERROR;
    if (outcome === BATCH_STATE.SENT) {
      out.sent += 1;
      bump("mailsSent");
      return DELIVERY.SENT;
    }
    out.failed += 1;
    bump("mailsFailed");
    log(`mail to ${batch.characterId} failed - ${extra.error}`);
    return DELIVERY.FAILED;
  }

  function sendUrgent(item, now) {
    const sender = resolveSender();
    if (!sender.ok) {
      bump("errors");
      bump("urgentFailed");
      return { ok: false, reason: "NO_SENDER", detail: sender.reason };
    }
    const opened = tx("notices.urgent", (db) => {
      const q = repo.enqueueItemsInTx(db, [item], now);
      if (!q.ok) return q;
      const o = repo.openBatchInTx(db, { characterId: item.characterId, senderId: sender.senderId, now, maxItems: 1,
        render, eventKey: item.eventKey });
      if (!o.ok) return o;
      return { ok: true, batch: o.batch, inserted: q.inserted, duplicates: q.duplicates };
    });
    if (!opened.ok) {
      fail(`urgent ${item.characterId}`, opened);
      bump("urgentFailed");
      return { ok: false, reason: opened.reason, ...(opened.detail ? { detail: opened.detail } : {}) };
    }
    const v = opened.value;
    if (v.inserted > 0) bump("itemsQueued", v.inserted);
    if (v.duplicates > 0) bump("itemsDuplicate", v.duplicates);
    if (!v.batch) return { ok: true, sent: false, duplicate: true };
    const out = { sent: 0, failed: 0, held: 0, cancelled: 0 };
    const d = deliver(v.batch, now, out);
    if (d === DELIVERY.SENT) {
      bump("urgentSent");
      return { ok: true, sent: true, duplicate: false };
    }
    bump("urgentFailed");
    return { ok: false, reason: URGENT_REFUSAL[d] };
  }

  function runPass(now) {
    const out = { ok: true, deferred: false, sent: 0, failed: 0, held: 0, reconciled: 0, lost: 0, timedOut: 0,
      pending: 0, cancelled: 0 };
    if (!governorAdmits()) {
      bump("deferrals");
      out.deferred = true;
      return out;
    }
    const t0 = nowMs();
    const rowBudget = Math.max(s.pruneBatch, s.maxItemsPerMail);
    try {
      const stale = reconcileSending(now, s.maxMailsPerPass, Math.max(0, now - s.passIntervalMs));
      out.reconciled = stale.reconciled;
      out.lost = stale.lost;
      out.timedOut = stale.timedOut || 0;
      out.pending = stale.pending;
      const kept = Math.max(0, now - Math.max(s.retentionMs, s.minMailIntervalMs));
      const house = tx("notices.housekeep", (db) => {
        const exp = repo.expireInTx(db, { before: Math.max(0, now - s.maxNoticeAgeMs), limit: rowBudget, now });
        if (!exp.ok) return exp;
        const urg = repo.expireUrgentInTx(db, { limit: rowBudget - exp.expired, now });
        if (!urg.ok) return urg;
        const pr = repo.pruneInTx(db, { before: kept, limit: s.pruneBatch });
        if (!pr.ok) return pr;
        return { ok: true, expired: exp.expired + urg.expired };
      });
      if (house.ok) {
        if (house.value.expired > 0) bump("itemsExpired", house.value.expired);
      } else {
        fail("housekeep", house);
      }
      const due = tx("notices.due", (db) => {
        const listed = repo.listDueCharactersInTx(db, { now, minMailIntervalMs: s.minMailIntervalMs,
          limit: s.maxMailsPerPass, priorityKinds, priorityMinIntervalMs: s.priorityMinIntervalMs });
        if (!listed.ok) return listed;
        let dropped = 0;
        for (const characterId of listed.characterIds) {
          const cap = repo.capPendingInTx(db, { characterId, max: s.maxPendingPerCharacter, now,
            limit: Math.max(0, rowBudget - dropped) });
          if (!cap.ok) return cap;
          dropped += cap.dropped;
        }
        return { ok: true, characterIds: listed.characterIds, dropped };
      });
      if (!due.ok) {
        fail("due", due);
        return out;
      }
      if (due.value.dropped > 0) bump("itemsDropped", due.value.dropped);
      if (due.value.characterIds.length === 0) return out;
      const sender = resolveSender();
      if (!sender.ok) {
        bump("errors");
        return out;
      }
      for (const characterId of due.value.characterIds) {
        if (sendOne(characterId, sender.senderId, now, out)) break;
      }
      return out;
    } catch (err) {
      bump("errors");
      log(`pass failed - ${messageOf(err)}`);
      return out;
    } finally {
      sendingHeld = out.pending + out.held;
      observe("passMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    }
  }

  function getSendingHeld() {
    return sendingHeld;
  }

  return Object.freeze({ runPass, reconcile, getSendingHeld, sendUrgent });
}

module.exports = { createDispatcher, MAIL_FORMAT, RECONCILE_BATCH_FACTOR };
