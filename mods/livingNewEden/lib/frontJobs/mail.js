"use strict";

const { MAX_LINE } = require("../notices/schema");
const { formatBoardMailLine, formatDoneLine } = require("./format");

const KIND_BOARD = "FRONT_JOBS_BOARD";
const KIND_DONE = "FRONT_JOB_DONE";
const BOARD_KEY_PREFIX = "fjboard";
const NO_SYSTEM = 0;
const MAX_DETAIL = 120;

const boardKeyOf = (day, createdAtMs) => `${BOARD_KEY_PREFIX}:${day}:${createdAtMs}`;

function onlineCharacters(presence, max) {
  if (!presence || typeof presence.getStatus !== "function" || typeof presence.listPresence !== "function") {
    return { ok: false, reason: "PRESENCE_UNAVAILABLE" };
  }
  const status = presence.getStatus();
  if (!status || status.available !== true) return { ok: false, reason: "PRESENCE_UNAVAILABLE" };
  if (status.stale) return { ok: false, reason: "PRESENCE_STALE" };
  const ids = new Set();
  for (const sys of presence.listPresence() || []) {
    for (const c of (sys && Array.isArray(sys.characters) ? sys.characters : [])) {
      const id = Number(c && c.characterId);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  }
  return { ok: true, characterIds: [...ids].sort((a, b) => a - b).slice(0, max) };
}

function createJobMail(deps) {
  const { settings, bump, log } = deps;

  function enqueue(tx, items, now, counter) {
    let notices = null;
    try {
      notices = deps.getNotices();
    } catch (_err) {
      notices = null;
    }
    if (!notices || typeof notices.enqueueItemsInTx !== "function") {
      bump("noticeRefused");
      return;
    }
    try {
      const r = notices.enqueueItemsInTx(tx, items, now);
      if (r && r.ok === true) bump(counter, r.inserted);
      else bump("noticeRefused");
    } catch (err) {
      bump("noticeRefused");
      log(`notice enqueue threw - ${String((err && err.message) || err).slice(0, MAX_DETAIL)}`);
    }
  }

  function boardInTx(tx, board) {
    if (settings.boardMailEnabled !== true) return;
    let online;
    try {
      online = onlineCharacters(deps.getPresence(), settings.maxBoardMailRecipients);
    } catch (_err) {
      online = { ok: false, reason: "PRESENCE_THREW" };
    }
    if (!online.ok) {
      bump("boardMailSkipped");
      return;
    }
    if (online.characterIds.length === 0) return;
    const line = formatBoardMailLine(board, { maxLine: MAX_LINE, resetHourUtc: settings.resetHourUtc });
    const eventKey = boardKeyOf(board.day, board.createdAt);
    enqueue(tx, online.characterIds.map((characterId) => ({ eventKey, characterId, kind: KIND_BOARD,
      systemId: NO_SYSTEM, line, eventAt: board.createdAt })), board.createdAt, "boardMails");
  }

  function doneInTx(tx, job, done) {
    if (settings.doneMailEnabled !== true) return;
    enqueue(tx, [{ eventKey: done.payoutKey, characterId: done.characterId, kind: KIND_DONE, systemId: job.systemId,
      line: formatDoneLine(job, { maxLine: MAX_LINE }), eventAt: done.atMs }], done.atMs, "doneMails");
  }

  return Object.freeze({ boardInTx, doneInTx });
}

module.exports = { createJobMail, onlineCharacters, boardKeyOf, KIND_BOARD, KIND_DONE };
