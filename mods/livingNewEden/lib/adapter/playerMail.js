"use strict";

const MAIL_STATE_PATH = "services/mail/mailState";
const MAIL_MAX_SUBJECT_SIZE = 150;
const MAX_DETAIL = 120;
const MAIL_STATUS_MASK_READ = 1;
const MAIL_STATUS_MASK_TRASHED = 8;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPosInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function normalizeTitle(title) {
  const text = String(title ?? "").trim();
  return text.length > MAIL_MAX_SUBJECT_SIZE ? text.slice(0, MAIL_MAX_SUBJECT_SIZE) : text;
}

function createPlayerMailAdapter(deps) {
  const requireGame = deps && typeof deps.requireGame === "function" ? deps.requireGame : null;
  const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`player mail: ${line}`);
    } catch (_err) {
    }
  }

  function mailState(fn) {
    if (!requireGame) return { ok: false, reason: "MAIL_SEAM_UNAVAILABLE", detail: "no_require" };
    let loaded;
    try {
      loaded = requireGame(MAIL_STATE_PATH);
    } catch (err) {
      return { ok: false, reason: "MAIL_SEAM_UNAVAILABLE", detail: messageOf(err) };
    }
    if (!loaded || !loaded.ok || !loaded.exports) {
      return { ok: false, reason: "MAIL_SEAM_UNAVAILABLE", detail: `mailState_${loaded ? loaded.reason : "none"}` };
    }
    if (typeof loaded.exports[fn] !== "function") return { ok: false, reason: "MAIL_SEAM_UNAVAILABLE", detail: fn };
    return { ok: true, exports: loaded.exports };
  }

  function sendPlayerMail(spec) {
    const s = spec || {};
    if (!isPosInt(s.senderId) || !isPosInt(s.toCharacterId) || typeof s.title !== "string"
      || normalizeTitle(s.title).length === 0 || typeof s.body !== "string" || typeof s.sentDate !== "string"
      || !/^\d{1,24}$/.test(s.sentDate)) {
      return { ok: false, reason: "MAIL_INVALID_INPUT", definite: true };
    }
    const seam = mailState("sendMail");
    if (!seam.ok) return { ...seam, definite: true };
    let result;
    try {
      result = seam.exports.sendMail({ senderID: s.senderId, toCharacterIDs: [s.toCharacterId], title: s.title,
        body: s.body, sentDate: s.sentDate, saveSenderCopy: false });
    } catch (err) {
      log(`sendMail threw - ${messageOf(err)}`);
      return { ok: false, reason: "MAIL_THREW", definite: false, detail: messageOf(err) };
    }
    if (result && result.success === true && isPosInt(Number(result.messageID))) {
      return { ok: true, messageId: Number(result.messageID) };
    }
    const detail = result && result.errorMsg ? String(result.errorMsg).slice(0, MAX_DETAIL) : "no_result";
    return { ok: false, reason: "MAIL_REFUSED", definite: false, detail };
  }

  function findPlayerMail(spec) {
    const s = spec || {};
    if (!isPosInt(s.characterId) || !isPosInt(s.senderId) || typeof s.sentDate !== "string"
      || typeof s.title !== "string") {
      return { ok: false, reason: "MAIL_INVALID_INPUT" };
    }
    const seam = mailState("getMailboxEntries");
    if (!seam.ok) return seam;
    const title = normalizeTitle(s.title);
    try {
      const entries = seam.exports.getMailboxEntries(s.characterId, { includeTrashed: true });
      for (const entry of Array.isArray(entries) ? entries : []) {
        const m = entry && entry.message;
        if (m && Number(m.senderID) === s.senderId && String(m.sentDate) === s.sentDate && m.title === title) {
          return { ok: true, found: true, messageId: Number(m.messageID) };
        }
      }
      return { ok: true, found: false };
    } catch (err) {
      return { ok: false, reason: "MAIL_THREW", detail: messageOf(err) };
    }
  }

  function defaultMailSender() {
    const seam = mailState("resolveWelcomeSenderID");
    if (!seam.ok) return seam;
    try {
      const id = Number(seam.exports.resolveWelcomeSenderID());
      return isPosInt(id) ? { ok: true, senderId: id } : { ok: false, reason: "MAIL_NO_SENDER" };
    } catch (err) {
      return { ok: false, reason: "MAIL_THREW", detail: messageOf(err) };
    }
  }

  function factsOf(entry) {
    const m = entry.message;
    const mask = Math.trunc(Number(entry.status && entry.status.statusMask) || 0);
    const optId = (v) => (isPosInt(Number(v)) ? Number(v) : null);
    return { messageId: Number(m.messageID), senderId: optId(m.senderID) || 0, title: String(m.title ?? ""),
      body: String(m.body ?? ""), sentDate: String(m.sentDate ?? ""), toListId: optId(m.toListID),
      toCorpOrAllianceId: optId(m.toCorpOrAllianceID), read: (mask & MAIL_STATUS_MASK_READ) !== 0 };
  }
  const isTrashed = (entry) => (Math.trunc(Number(entry.status && entry.status.statusMask) || 0)
    & MAIL_STATUS_MASK_TRASHED) !== 0;

  function listIncomingMail(spec) {
    const s = spec || {};
    if (!isPosInt(s.characterId) || !Number.isSafeInteger(s.afterId) || s.afterId < 0 || !Number.isSafeInteger(s.max)
      || s.max < 0) {
      return { ok: false, reason: "MAIL_INVALID_INPUT" };
    }
    const seam = mailState("getMailboxEntries");
    if (!seam.ok) return seam;
    try {
      const entries = seam.exports.getMailboxEntries(s.characterId, { includeTrashed: true });
      let maxId = s.afterId;
      const fresh = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const m = entry && entry.message;
        const id = m ? Number(m.messageID) : NaN;
        if (!isPosInt(id)) continue;
        if (id > maxId) maxId = id;
        if (id <= s.afterId || Number(m.senderID) === s.characterId || isTrashed(entry)) continue;
        fresh.push(entry);
      }
      fresh.sort((a, b) => Number(a.message.messageID) - Number(b.message.messageID));
      const kept = s.max === 0 ? [] : fresh.slice(-s.max);
      return { ok: true, mails: kept.map(factsOf), maxId, truncated: fresh.length > kept.length, count: fresh.length };
    } catch (err) {
      return { ok: false, reason: "MAIL_THREW", detail: messageOf(err) };
    }
  }

  function readIncomingMail(spec) {
    const s = spec || {};
    if (!isPosInt(s.characterId) || !isPosInt(s.messageId)) return { ok: false, reason: "MAIL_INVALID_INPUT" };
    const seam = mailState("getMessageByIDForCharacter");
    if (!seam.ok) return seam;
    try {
      const entry = seam.exports.getMessageByIDForCharacter(s.characterId, s.messageId);
      if (!entry || !entry.message || Number(entry.message.senderID) === s.characterId || isTrashed(entry)) {
        return { ok: true, found: false };
      }
      return { ok: true, found: true, mail: factsOf(entry) };
    } catch (err) {
      return { ok: false, reason: "MAIL_THREW", detail: messageOf(err) };
    }
  }

  return Object.freeze({ sendPlayerMail, findPlayerMail, defaultMailSender, listIncomingMail, readIncomingMail });
}

module.exports = { createPlayerMailAdapter, MAIL_STATE_PATH, normalizeTitle };
