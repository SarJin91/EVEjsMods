"use strict";

const { EDITION_STATE, SOURCE } = require("./schema");
const { boundaryAtOrBefore, nextBoundary, editionIdOf } = require("./cycle");
const { selectFacts } = require("./select");
const { renderFallback } = require("./fallback");
const { buildNewsMessages } = require("./prompt");
const { verifyNewsText } = require("./verify");
const { runTx } = require("./tx");

const MAX_UNFINISHED_PER_PASS = 4;
const AI_LANE = "news";
const CHATTER_RUNNING = "running";
const TITLE_LINE_OVERHEAD = 8;
const AI_STATE = Object.freeze({ OFF: "off", IDLE: "idle", DRAFTING: "drafting", UNAVAILABLE: "unavailable" });
const AI_REASON = Object.freeze({ DEADLINE: "DEADLINE", UNAVAILABLE: "AI_UNAVAILABLE", NO_FACTS: "FACTS_UNREADABLE" });
const REASON_RE = /^[A-Z0-9_]{1,40}$/;

function reasonCode(v) {
  return typeof v === "string" && REASON_RE.test(v) ? v : "ERROR";
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function createEditions(deps) {
  const { store, repo } = deps;
  const s = deps.settings;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const onOpening = typeof deps.onOpening === "function" ? deps.onOpening : () => {};
  const onWrite = typeof deps.onWrite === "function" ? deps.onWrite : () => {};
  const getChatterAi = typeof deps.getChatterAi === "function" ? deps.getChatterAi : () => null;
  const knownNamesOf = typeof deps.knownNames === "function" ? deps.knownNames : () => [];
  const isRunning = typeof deps.isRunning === "function" ? deps.isRunning : () => true;
  const clockNow = typeof deps.now === "function" ? deps.now : () => Date.now();
  const mailPlan = deps.mailPlan && Number.isSafeInteger(deps.mailPlan.maxRecipients) ? deps.mailPlan : null;
  let lastEdition = null;
  let lastBoundaryAt = null;
  const inFlight = new Map();
  const drafts = new Map();
  let lastAiReason = null;

  function remember(edition) {
    if (!edition) return;
    if (!lastEdition || edition.boundaryAt >= lastEdition.boundaryAt) {
      lastEdition = { editionId: edition.editionId, state: edition.state, source: edition.source,
        factCount: edition.factCount, boundaryAt: edition.boundaryAt, aiAttempts: edition.aiAttempts };
    }
  }

  function chatterAi() {
    try {
      const c = getChatterAi();
      return c && typeof c.complete === "function" ? c : null;
    } catch (_err) {
      return null;
    }
  }

  function chatterRunning(c) {
    try {
      const st = c && typeof c.getStatus === "function" ? c.getStatus() : null;
      return Boolean(st && st.state === CHATTER_RUNNING);
    } catch (_err) {
      return false;
    }
  }

  function draftOf(edition) {
    const known = drafts.get(edition.editionId);
    if (known) return known;
    const r = runTx(store, "news.aiFacts", (db) => repo.listEditionFactsInTx(db, edition.editionId));
    if (!r.ok) return null;
    const facts = r.value.facts;
    const built = buildNewsMessages(facts, { language: edition.language, boundaryAt: edition.boundaryAt,
      cycleHours: s.cycleHours, maxPromptChars: s.aiMaxPromptChars, minParagraphs: s.minParagraphs,
      maxParagraphs: s.maxParagraphs, minBodyChars: s.minBodyChars, maxBodyChars: s.maxBodyChars,
      maxTitleChars: s.maxTitleChars });
    const kept = facts.slice(0, built.factLines.length);
    const topSystemNames = [];
    for (const f of kept.slice(0, Math.min(s.minCoveredFacts, kept.length))) {
      const d = f.data || {};
      const name = typeof d.systemName === "string" && d.systemName.trim() !== "" ? d.systemName
        : (typeof d.factionA === "string" && d.factionA.trim() !== "" ? d.factionA : null);
      if (name !== null) topSystemNames.push(name.replace(/[{}]/g, "").replace(/\s+/g, " ").trim());
    }
    let knownNames = [];
    try {
      const k = knownNamesOf();
      knownNames = Array.isArray(k) ? k : [];
    } catch (err) {
      log(`known names failed - ${messageOf(err)}`);
    }
    if (drafts.size >= MAX_UNFINISHED_PER_PASS) drafts.clear();
    const draft = { messages: built.messages, numbers: built.numbers, factNames: built.factNames, topSystemNames,
      knownNames };
    drafts.set(edition.editionId, draft);
    return draft;
  }

  function forget(editionId) {
    inFlight.delete(editionId);
    drafts.delete(editionId);
  }

  function readyFallback(edition, now, aiReason, tokens) {
    const spec = { editionId: edition.editionId, expectedVersion: edition.version, source: SOURCE.FALLBACK,
      title: edition.fallbackTitle, paragraphs: edition.fallbackParagraphs, now };
    if (aiReason !== undefined) spec.aiReason = aiReason;
    if (tokens !== undefined) spec.tokens = tokens;
    return runTx(store, "news.ready", (db) => repo.readyEditionInTx(db, spec));
  }

  function onAiResult(edition, entry, res) {
    if (inFlight.get(edition.editionId) === entry) inFlight.delete(edition.editionId);
    if (!entry.accepted) {
      lastAiReason = reasonCode(res && res.reason);
      return;
    }
    if (!isRunning()) return;
    const now = clockNow();
    const draft = drafts.get(edition.editionId);
    const tokens = res && Number.isSafeInteger(res.tokens) && res.tokens >= 0 ? res.tokens : 0;
    if (!draft) {
      log(`edition ${edition.editionId} ai result STALE`);
      return;
    }
    let reason;
    if (res && res.ok === true) {
      const v = verifyNewsText(res.text, { numbers: draft.numbers, factNames: draft.factNames,
        knownNames: draft.knownNames, topSystemNames: draft.topSystemNames, language: edition.language, settings: s });
      if (v.ok) {
        const r = runTx(store, "news.ready", (db) => repo.readyEditionInTx(db, { editionId: edition.editionId,
          expectedVersion: entry.version, source: SOURCE.AI, title: v.title, paragraphs: v.paragraphs, tokens, now }));
        if (!r.ok) {
          log(`edition ${edition.editionId} ai result ${r.reason}`);
          return;
        }
        forget(edition.editionId);
        bump("aiAccepted");
        onWrite();
        remember(r.value.edition);
        lastAiReason = null;
        log(`edition ${edition.editionId} ready source=AI attempts=${entry.attempts} tokens=${tokens}`);
        return;
      }
      reason = v.reason;
    } else reason = reasonCode(res && res.reason);
    bump("aiRejected");
    lastAiReason = reason;
    const last = entry.attempts >= s.aiMaxAttempts;
    const r = last ? readyFallback({ ...edition, version: entry.version }, now, reason, tokens)
      : runTx(store, "news.aiReason", (db) => repo.noteAiReasonInTx(db, { editionId: edition.editionId,
        expectedVersion: entry.version, aiReason: reason, tokens }));
    if (!r.ok) {
      log(`edition ${edition.editionId} ai ${reason} ${r.reason}`);
      return;
    }
    onWrite();
    remember(r.value.edition);
    if (last) {
      forget(edition.editionId);
      bump("fallbacks");
    }
    log(`edition ${edition.editionId} ai ${reason} attempt ${entry.attempts}/${s.aiMaxAttempts}`
      + (last ? " ready source=FALLBACK" : ""));
  }

  function draftStep(edition, now) {
    if (now > edition.createdAt + s.draftDeadlineMs) return { waiting: false, reason: AI_REASON.DEADLINE };
    if (inFlight.has(edition.editionId)) return { waiting: true };
    if (edition.aiAttempts >= s.aiMaxAttempts) return { waiting: false };
    const c = chatterAi();
    if (!c || !chatterRunning(c)) return { waiting: false, reason: AI_REASON.UNAVAILABLE };
    const draft = draftOf(edition);
    if (!draft) return { waiting: false, reason: AI_REASON.NO_FACTS };
    const entry = { accepted: false, version: edition.version, attempts: edition.aiAttempts };
    const spec = { lane: AI_LANE, messages: draft.messages, minChars: s.minBodyChars,
      maxChars: s.maxBodyChars + s.maxTitleChars + TITLE_LINE_OVERHEAD + 2 * s.maxParagraphs,
      onAccepted: () => {
        const r = runTx(store, "news.attempt", (db) => repo.attemptEditionInTx(db, { editionId: edition.editionId,
          expectedVersion: edition.version }));
        if (!r.ok) return false;
        entry.accepted = true;
        entry.version = r.value.edition.version;
        entry.attempts = r.value.edition.aiAttempts;
        bump("aiRequests");
        onWrite();
        remember(r.value.edition);
        return true;
      } };
    inFlight.set(edition.editionId, entry);
    let promise;
    try {
      promise = Promise.resolve(c.complete(spec));
    } catch (_err) {
      promise = Promise.resolve({ ok: false, reason: "COMPLETE_THREW" });
    }
    promise.then((res) => onAiResult(edition, entry, res), () => onAiResult(edition, entry,
      { ok: false, reason: "COMPLETE_REJECTED" })).catch((err) => log(`ai result failed - ${messageOf(err)}`));
    return { waiting: true };
  }

  function load() {
    const r = runTx(store, "news.status", (db) => repo.latestEditionInTx(db));
    if (r.ok) remember(r.value.edition);
    return r.ok ? { ok: true } : r;
  }

  function openInTx(db, boundaryAt, now) {
    const editionId = editionIdOf(boundaryAt);
    const known = repo.getEditionInTx(db, editionId);
    if (!known.ok) return known;
    if (known.edition) return { ok: true, created: false, edition: known.edition };
    const listed = repo.listOpenFactsInTx(db, { before: boundaryAt, since: boundaryAt - s.maxFactAgeMs,
      limit: s.maxCandidatesPerEdition });
    if (!listed.ok) return listed;
    const { selected, dropped } = selectFacts(listed.facts, s);
    const skipped = selected.length < s.minFactsPerEdition;
    const { seq } = repo.nextSeqInTx(db);
    const fallback = renderFallback(selected, { language: s.language, boundaryAt, cycleHours: s.cycleHours, seq,
      maxTitleChars: s.maxTitleChars });
    return repo.openEditionInTx(db, { editionId, boundaryAt, language: s.language, skipped, fallback,
      selectedKeys: selected.map((f) => f.factKey), droppedKeys: dropped.map((f) => f.factKey), now });
  }

  function open(now) {
    const boundaryAt = boundaryAtOrBefore(now, s);
    lastBoundaryAt = boundaryAt;
    if (now < boundaryAt + s.settleDelayMs) return { ok: true, opened: false };
    if (lastEdition && lastEdition.boundaryAt === boundaryAt) return { ok: true, opened: false };
    try {
      onOpening();
    } catch (err) {
      log(`names refresh failed - ${messageOf(err)}`);
    }
    const r = runTx(store, "news.open", (db) => openInTx(db, boundaryAt, now));
    if (!r.ok) return r;
    remember(r.value.edition);
    if (!r.value.created) return { ok: true, opened: false };
    onWrite();
    const e = r.value.edition;
    if (e.state === EDITION_STATE.SKIPPED) {
      bump("editionsSkipped");
      log(`edition ${e.editionId} skipped facts=${e.factCount}`);
    } else {
      bump("editionsOpened");
      log(`edition ${e.editionId} #${e.seq} opened facts=${e.factCount}`);
    }
    return { ok: true, opened: true, edition: e };
  }

  function advance(edition, now) {
    if (edition.state === EDITION_STATE.DRAFTING) {
      let aiReason;
      if (s.aiEnabled === true) {
        const step = draftStep(edition, now);
        if (step.waiting) return { ok: true };
        aiReason = step.reason;
        forget(edition.editionId);
        if (aiReason !== undefined) lastAiReason = aiReason;
      }
      const r = aiReason === undefined ? runTx(store, "news.ready", (db) => repo.readyEditionInTx(db, {
        editionId: edition.editionId, expectedVersion: edition.version, source: SOURCE.FALLBACK,
        title: edition.fallbackTitle, paragraphs: edition.fallbackParagraphs, now }))
        : readyFallback(edition, now, aiReason);
      if (!r.ok) return r;
      bump("fallbacks");
      onWrite();
      remember(r.value.edition);
      return advance(r.value.edition, now);
    }
    if (edition.state === EDITION_STATE.READY) {
      const plan = mailPlan;
      let queue = null;
      const r = runTx(store, "news.publish", (db) => {
        let recipients = 0;
        if (plan) {
          queue = repo.queueDeliveriesInTx(db, { editionId: edition.editionId, activeSince: now - plan.readerActiveMs,
            limit: plan.maxRecipients, now });
          if (!queue.ok) return queue;
          recipients = queue.queued;
        }
        return repo.publishEditionInTx(db, { editionId: edition.editionId, expectedVersion: edition.version,
          recipients, now });
      });
      if (!r.ok) return r;
      bump("editionsPublished");
      if (queue && queue.queued > 0) bump("deliveriesQueued", queue.queued);
      if (queue && queue.eligible > queue.queued) bump("recipientsTruncated", queue.eligible - queue.queued);
      onWrite();
      remember(r.value.edition);
      log(`edition ${edition.editionId} published source=${r.value.edition.source}`
        + (plan ? ` recipients=${r.value.edition.recipients}` : ""));
      return { ok: true };
    }
    return { ok: true };
  }

  function runStep(now) {
    const o = open(now);
    if (!o.ok) return o;
    const listed = runTx(store, "news.unfinished", (db) => repo.listUnfinishedInTx(db,
      { limit: MAX_UNFINISHED_PER_PASS }));
    if (!listed.ok) return listed;
    let advanced = 0;
    for (const e of listed.value.editions) {
      const r = advance(e, now);
      if (!r.ok) return r;
      advanced += 1;
    }
    return { ok: true, opened: o.opened, advanced };
  }

  function getStatus(now) {
    const at = lastBoundaryAt !== null ? lastBoundaryAt : (Number.isSafeInteger(now) ? boundaryAtOrBefore(now, s)
      : null);
    return { lastBoundaryAt: at, nextBoundaryAt: at === null ? null : nextBoundary(at, s),
      lastEdition: lastEdition ? { editionId: lastEdition.editionId, state: lastEdition.state,
        source: lastEdition.source, factCount: lastEdition.factCount } : null, ai: aiStatus() };
  }

  function aiStatus() {
    let state = AI_STATE.OFF;
    if (s.aiEnabled === true) {
      if (inFlight.size > 0) state = AI_STATE.DRAFTING;
      else state = chatterRunning(chatterAi()) ? AI_STATE.IDLE : AI_STATE.UNAVAILABLE;
    }
    return { state, attemptsLastEdition: lastEdition && Number.isSafeInteger(lastEdition.aiAttempts)
      ? lastEdition.aiAttempts : 0, lastReason: lastAiReason };
  }

  return Object.freeze({ load, runStep, getStatus });
}

module.exports = { createEditions, MAX_UNFINISHED_PER_PASS };
