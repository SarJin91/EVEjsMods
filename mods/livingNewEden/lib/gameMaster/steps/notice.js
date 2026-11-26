"use strict";

const { proximityRecipients } = require("../../notices/recipients");
const { NOTICE_KIND, OWNER, OUTCOME } = require("../schema");

const MAX_LINE = 400;
const PARAM_KEYS = Object.freeze(["text"]);

function safeCall(fn, fallback) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_err) {
    return fallback;
  }
}

function createNoticeSender(deps) {
  const { S } = deps;

  function noticesNow() {
    const n = safeCall(deps.getNotices, null);
    if (!n || typeof n.enqueueItemsInTx !== "function" || typeof n.getStatus !== "function") return null;
    const st = safeCall(() => n.getStatus(), null);
    return st && st.state === "running" ? n : null;
  }

  function sendInTx(tx, spec) {
    const line = String(spec.line || "").slice(0, MAX_LINE);
    if (line === "") return { ok: true, n: 0 };
    const notices = noticesNow();
    if (!notices) return { ok: true, n: 0 };
    const r = proximityRecipients({ graph: safeCall(deps.getGraph, null), presence: safeCall(deps.getPresence, null),
      systemId: spec.systemId, jumps: S.noticeRadiusJumps, max: S.maxNoticeRecipients });
    if (!r || r.ok !== true || r.characterIds.length === 0) return { ok: true, n: 0 };
    const items = r.characterIds.map((characterId) => ({ eventKey: spec.eventKey, characterId, kind: NOTICE_KIND,
      systemId: spec.systemId, line, eventAt: spec.now }));
    const q = notices.enqueueItemsInTx(tx, items, spec.now);
    if (q && q.ok === false && q.reason === "INVALID_INPUT") {
      throw new Error(`gameMaster notices INVALID_INPUT ${q.detail || ""}`.trim());
    }
    return { ok: true, n: q && q.ok === true ? q.inserted : 0 };
  }

  return Object.freeze({ sendInTx });
}

function createNoticeStep(deps) {
  const sender = deps.sender || createNoticeSender(deps);
  return Object.freeze({
    type: "NOTICE",
    owner: OWNER,
    version: 1,
    promptHint: "NOTICE: one short message to the pilots near the place (param text)",
    maxPerThread: 2,
    duration: Object.freeze({ minMs: 0, maxMs: 0 }),
    validate(params) {
      if (Object.keys(params).some((k) => !PARAM_KEYS.includes(k))) return { ok: false, reason: "UNKNOWN_PARAM" };
      return { ok: true, params: typeof params.text === "string" ? { text: params.text } : {} };
    },
    startInTx(tx, s) {
      const sent = sender.sendInTx(tx, { eventKey: s.stepKey, systemId: s.systemId, line: s.params.text, now: s.now });
      return { ok: true, handle: { n: sent.n }, dueAt: s.now };
    },
    pollInTx() {
      return { state: "DONE", outcome: OUTCOME.NEUTRAL };
    },
    cancelInTx() {
      return { ok: true };
    },
  });
}

module.exports = { createNoticeSender, createNoticeStep };
