"use strict";

const { DELIVERY_STATE } = require("../schema");
const { filetimeOf } = require("../../notices/schema");
const { formatEditionMail } = require("./format");
const { runTx } = require("../tx");

const MAIL_FORMAT = Object.freeze({ lineBreak: "<br>", maxBodyChars: 8000, maxTitleChars: 150 });
const RECONCILE_FACTOR = 4;
const SEAM_UNAVAILABLE = "MAIL_SEAM_UNAVAILABLE";
const LOOKUP_TIMEOUT = "LOOKUP_TIMEOUT";
const MAIL_METHODS = Object.freeze(["sendPlayerMail", "findPlayerMail", "defaultMailSender"]);

function createMailDispatcher(deps) {
  const { store, repo, adapter } = deps;
  const s = deps.settings;
  const m = s.mail;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  let senderId = null;
  let senderRefusal = null;
  let lastError = null;
  let rendered = new Map();

  function fail(where, r) {
    bump("errors");
    lastError = String((r && r.reason) || "NO_RESULT");
    log(`mail ${where} ${lastError}${r && r.detail ? ` - ${r.detail}` : ""}`);
  }

  function resolveSender() {
    if (senderId !== null) return { ok: true, senderId };
    if (m.senderId > 0) {
      senderId = m.senderId;
      return { ok: true, senderId };
    }
    let r;
    try {
      r = adapter.defaultMailSender();
    } catch (_err) {
      r = { ok: false, reason: "MAIL_THREW" };
    }
    if (r && r.ok && Number.isSafeInteger(r.senderId) && r.senderId > 0) {
      senderId = r.senderId;
      senderRefusal = null;
      return { ok: true, senderId };
    }
    const reason = (r && r.reason) || "NO_RESULT";
    if (senderRefusal !== reason) log(`mail no sender - ${reason}`);
    senderRefusal = reason;
    return { ok: false, reason };
  }

  function mailOf(editionId) {
    if (rendered.has(editionId)) return rendered.get(editionId);
    const r = runTx(store, "news.mailEdition", (db) => repo.getEditionInTx(db, editionId));
    const e = r.ok ? r.value.edition : null;
    const out = e ? formatEditionMail(e, { ...MAIL_FORMAT, language: e.language }) : null;
    rendered.set(editionId, out);
    return out;
  }

  function finish(d, outcome, extra, now) {
    const r = runTx(store, "news.mailFinish", (db) => repo.finishDeliveryInTx(db, { editionId: d.editionId,
      characterId: d.characterId, outcome, now, ...extra }));
    if (!r.ok) fail(`finish ${d.editionId}:${d.characterId}`, r);
    return r;
  }

  function find(d) {
    try {
      return adapter.findPlayerMail({ characterId: d.characterId, senderId: d.senderId, sentDate: d.sentDate,
        title: d.title });
    } catch (_err) {
      return { ok: false, reason: "MAIL_THREW" };
    }
  }

  function reconcileRows(rows, now) {
    const out = { reconciled: 0, lost: 0, held: 0, timedOut: 0 };
    for (let i = 0; i < rows.length; i += 1) {
      const d = rows[i];
      const found = find(d);
      if (!found || !found.ok) {
        const reason = (found && found.reason) || "NO_RESULT";
        fail(`reconcile ${d.editionId}:${d.characterId}`, found || { reason });
        if (d.createdAt < now - m.maxDeliveryAgeMs) {
          if (finish(d, DELIVERY_STATE.FAILED, { error: LOOKUP_TIMEOUT }, now).ok) {
            out.timedOut += 1;
            bump("mailsFailed");
          }
          continue;
        }
        if (reason === SEAM_UNAVAILABLE) {
          out.held += rows.length - i;
          break;
        }
        out.held += 1;
        continue;
      }
      if (found.found) {
        if (finish(d, DELIVERY_STATE.SENT, { messageId: found.messageId }, now).ok) {
          out.reconciled += 1;
          bump("mailsSent");
        }
      } else if (finish(d, DELIVERY_STATE.LOST, { error: "not in the mailbox" }, now).ok) {
        out.lost += 1;
        bump("mailsLost");
      }
    }
    return out;
  }

  function reconcileSending(now, limit, before) {
    const listed = runTx(store, "news.mailSending", (db) => repo.listDeliveriesInTx(db,
      { state: DELIVERY_STATE.SENDING, limit, before }));
    if (!listed.ok) {
      fail("sending list", listed);
      return { reconciled: 0, lost: 0, held: 0, timedOut: 0 };
    }
    return reconcileRows(listed.value.deliveries, now);
  }

  function reconcile(now) {
    try {
      return { ok: true, ...reconcileSending(now, m.maxMailsPerPass * RECONCILE_FACTOR, undefined) };
    } catch (err) {
      fail("reconcile", { reason: "THREW", detail: String((err && err.message) || err) });
      return { ok: false, reason: "THREW" };
    }
  }

  function sendOne(d, sender, now) {
    const mail = mailOf(d.editionId);
    if (!mail) {
      fail(`edition ${d.editionId}`, { reason: "EDITION_MISSING" });
      return "SKIPPED";
    }
    const sentDate = filetimeOf(now);
    const opened = runTx(store, "news.mailOpen", (db) => repo.openDeliveryInTx(db, { editionId: d.editionId,
      characterId: d.characterId, senderId: sender, sentDate, title: mail.title, now }));
    if (!opened.ok) {
      fail(`open ${d.editionId}:${d.characterId}`, opened);
      return "SKIPPED";
    }
    const row = { ...d, senderId: sender, sentDate, title: mail.title };
    let sent;
    try {
      sent = adapter.sendPlayerMail({ senderId: sender, toCharacterId: d.characterId, title: mail.title,
        body: mail.body, sentDate });
    } catch (err) {
      sent = { ok: false, reason: "MAIL_THREW", definite: false, detail: String((err && err.message) || err) };
    }
    if (sent && !sent.ok && sent.reason === SEAM_UNAVAILABLE) {
      fail(`send ${d.editionId}:${d.characterId}`, sent);
      finish(row, DELIVERY_STATE.PENDING, {}, now);
      return "CANCELLED";
    }
    let outcome = DELIVERY_STATE.FAILED;
    let extra = { error: sent && sent.reason ? `${sent.reason}${sent.detail ? `:${sent.detail}` : ""}` : "NO_RESULT" };
    if (sent && sent.ok) {
      outcome = DELIVERY_STATE.SENT;
      extra = { messageId: sent.messageId };
    } else if (sent && sent.definite === false) {
      const found = find(row);
      if (!found || !found.ok) {
        fail(`lookup ${d.editionId}:${d.characterId}`, found || { reason: "NO_RESULT" });
        return "HELD";
      }
      if (found.found) {
        outcome = DELIVERY_STATE.SENT;
        extra = { messageId: found.messageId };
      }
    }
    if (!finish(row, outcome, extra, now).ok) return "ERROR";
    if (outcome === DELIVERY_STATE.SENT) {
      bump("mailsSent");
      return "SENT";
    }
    bump("mailsFailed");
    lastError = String(extra.error).split(":")[0];
    log(`mail ${d.editionId} to ${d.characterId} failed - ${lastError}`);
    return "FAILED";
  }

  function runPass(now) {
    const out = { ok: true, sent: 0, failed: 0, held: 0, expired: 0, reconciled: 0, lost: 0 };
    rendered = new Map();
    const stale = reconcileSending(now, m.maxMailsPerPass, Math.max(0, now - s.passIntervalMs));
    out.reconciled = stale.reconciled;
    out.lost = stale.lost;
    out.held = stale.held;
    const exp = runTx(store, "news.mailExpire", (db) => repo.expireDeliveriesInTx(db,
      { before: now - m.maxDeliveryAgeMs, limit: m.maxMailsPerPass * RECONCILE_FACTOR, now }));
    if (exp.ok && exp.value.expired > 0) {
      out.expired = exp.value.expired;
      bump("mailsExpired", exp.value.expired);
    } else if (!exp.ok) fail("expire", exp);
    const listed = runTx(store, "news.mailPending", (db) => repo.listDeliveriesInTx(db,
      { state: DELIVERY_STATE.PENDING, limit: m.maxMailsPerPass }));
    if (!listed.ok) {
      fail("pending list", listed);
      return out;
    }
    if (listed.value.deliveries.length === 0) return out;
    const sender = resolveSender();
    if (!sender.ok) {
      bump("errors");
      lastError = "NO_SENDER";
      return { ...out, stopped: "NO_SENDER" };
    }
    for (const d of listed.value.deliveries) {
      const r = sendOne(d, sender.senderId, now);
      if (r === "SENT") out.sent += 1;
      else if (r === "FAILED") out.failed += 1;
      else if (r === "HELD") out.held += 1;
      else if (r === "CANCELLED") return { ...out, stopped: SEAM_UNAVAILABLE };
    }
    return out;
  }

  return Object.freeze({ runPass, reconcile, getLastError: () => lastError });
}

module.exports = { createMailDispatcher, MAIL_FORMAT, MAIL_METHODS };
