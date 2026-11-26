"use strict";

const { createPoller, defaultSetTimer } = require("../presence/poller");
const { buildSystemPrompt, staticLine } = require("./persona");
const { filterReply } = require("./filter");
const { METRIC, REPLY_REJECT_REASONS } = require("./schema");

const TIRED_REASONS = Object.freeze(["BREAKER", "RATE", "BUDGET", "CHAR_BUDGET", "LANE_BUDGET"]);
const FAILURE_REASONS = Object.freeze(["DISABLED", "BREAKER", "RATE", "BUDGET", "CHAR_BUDGET", "LANE_BUDGET",
  "TIMEOUT", "NET_ERROR", "HTTP", "BAD_SHAPE", "EMPTY", "BAD_INPUT", "CONTEXT"]);
const COUNTER_NAMES = Object.freeze(["messages", "requests", "replies", "rejected", "staticLines", "busy",
  "saveFailed", "deliveryFailed", "summaryRequests", "saveDiscarded",
  ...REPLY_REJECT_REASONS.map((r) => `rejected_${r}`), ...FAILURE_REASONS.map((r) => `failed_${r}`)]);
const LANE = "chat";
const SUMMARY_LANE = "summary";

function noop() {}

const codeOf = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, 60);

function cleanUserText(text, max) {
  return String(text ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function createDeliver(deps) {
  const d = deps || {};
  return function deliver(playerId, lines) {
    const out = { room: 0, system: 0, failed: 0 };
    let rec;
    const recOf = () => {
      if (rec !== undefined) return rec;
      rec = null;
      try {
        const res = typeof d.readPresence === "function" ? d.readPresence() : null;
        if (res && res.ok && Array.isArray(res.characters)) {
          rec = res.characters.find((r) => r && r.characterId === playerId) || null;
        }
      } catch (_err) {
        rec = null;
      }
      return rec;
    };
    for (const line of Array.isArray(lines) ? lines : []) {
      try {
        const pair = typeof d.pairOf === "function" ? d.pairOf(playerId) : null;
        if (pair && typeof d.sendAiMessage === "function") {
          const sent = d.sendAiMessage({ playerId, aiId: pair.aiId, text: line });
          if (sent && sent.ok) {
            out.room += 1;
            continue;
          }
        }
        const r = recOf();
        const text = `${d.nameOf(playerId)}: ${line}`;
        const sys = r && typeof d.sendCharacterSystemLine === "function"
          ? d.sendCharacterSystemLine({ characterId: playerId, systemId: r.systemId, text }) : null;
        if (sys && sys.ok) out.system += 1;
        else out.failed += 1;
      } catch (_err) {
        out.failed += 1;
      }
    }
    return out;
  };
}

function createConversation(deps) {
  const d = deps;
  const S = d.S;
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : { log: noop };
  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const players = new Map();
  const waiters = new Set();
  const memory = d.memory && d.memory.enabled === true ? d.memory : null;
  const summaryClient = d.summaryClient && typeof d.summaryClient.request === "function" ? d.summaryClient : null;
  const summaryWanted = new Set();
  let active = 0;
  let stopped = false;
  let generation = 0;
  let lineSeq = 0;

  const log = (line) => {
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const metric = (name) => {
    if (!telemetry) return;
    try {
      telemetry.count(name, 1);
    } catch (_err) {
    }
  };

  function deliver(playerId, lines) {
    const res = d.deliver(playerId, lines);
    if (res && res.failed > 0) counters.deliveryFailed += res.failed;
  }

  const personaOf = (playerId) => (typeof d.personaOf === "function" ? d.personaOf(playerId) : null);

  function sendStatic(playerId, kind) {
    lineSeq += 1;
    counters.staticLines += 1;
    const p = personaOf(playerId);
    deliver(playerId, [staticLine(kind, S.language, playerId + lineSeq, p ? p.preset : undefined)]);
  }

  function historyOf(playerId) {
    const res = d.store.transaction("shipAi.turns.read", (db) => d.turnsRepo.listRecent(db, playerId,
      S.historyTurns * 2));
    if (!res.ok || !res.value || !res.value.ok) return [];
    const rows = [...res.value.rows];
    let chars = rows.reduce((n, r) => n + r.text.length, 0);
    while (rows.length > 0 && (chars > S.historyMaxChars || rows[0].role !== "user")) {
      chars -= rows.shift().text.length;
    }
    return rows.map((r) => ({ role: r.role, content: r.text }));
  }

  function messagesOf(playerId, userText) {
    const snap = d.snapshot(playerId);
    const playerName = snap && snap.presence ? snap.presence.name : null;
    const block = memory ? memory.promptBlock(playerId, userText) : null;
    const memoryRows = block && typeof block.content === "string" ? [{ role: "system", content: block.content }] : [];
    const p = personaOf(playerId);
    return { factIds: block && Array.isArray(block.factIds) ? block.factIds : [], messages: [
      { role: "system", content: buildSystemPrompt({ aiName: d.nameOf(playerId), playerName, language: S.language,
        maxLines: S.maxLinesPerReply, preset: p ? p.preset : undefined, custom: p ? p.custom : null,
        profanity: S.profanity, customMaxChars: S.personaCustomMaxChars }) },
      { role: "system", content: `DATA {"snapshot":${snap && typeof snap.json === "string" ? snap.json : "{}"}}` },
      ...memoryRows,
      ...historyOf(playerId),
      { role: "user", content: userText },
    ] };
  }

  function save(playerId, req, aiText) {
    if (memory && memory.epochOf(playerId) !== req.epoch) {
      counters.saveDiscarded += 1;
      return false;
    }
    const now = d.nowMs();
    const res = d.store.transaction("shipAi.turns.append", (db) => {
      const appended = d.turnsRepo.appendExchangeInTx(db, { playerId, userText: req.userText, aiText, nowMs: now });
      if (appended.ok && memory) memory.touchInTx(db, req.factIds, now);
      return appended;
    });
    if (!res.ok || !res.value || !res.value.ok) {
      counters.saveFailed += 1;
      log(`shipAi: exchange not saved - ${codeOf(res.ok ? res.value && res.value.reason : res.reason)}`);
      return false;
    }
    return true;
  }

  function onReply(playerId, req, res) {
    if (res && res.ok === true) {
      const filtered = filterReply(res.text, S, S.language);
      if (filtered.ok) {
        deliver(playerId, filtered.lines);
        counters.replies += 1;
        metric(METRIC.replies);
        if (typeof d.onReplied === "function") d.onReplied(playerId);
        if (save(playerId, req, filtered.lines.join("\n")) && memory && memory.enabled) summaryWanted.add(playerId);
        return;
      }
      counters.rejected += 1;
      counters[`rejected_${filtered.reason}`] += 1;
      metric(METRIC.rejected);
      sendStatic(playerId, "DEFLECT");
      return;
    }
    const reason = res && typeof res.reason === "string" ? res.reason : "NET_ERROR";
    if (reason === "ABORTED") return;
    const key = reason.startsWith("HTTP_") ? "HTTP" : reason;
    counters[`failed_${FAILURE_REASONS.includes(key) ? key : "NET_ERROR"}`] += 1;
    sendStatic(playerId, TIRED_REASONS.includes(reason) ? "TIRED" : "SIGNAL_LOST");
  }

  function cancelNotice(req) {
    const t = req.noticeTimer;
    req.noticeTimer = null;
    if (!t) return;
    try {
      t.cancel();
    } catch (_err) {
    }
  }

  function armNotice(playerId, st, req, gen) {
    if (S.thinkingChat !== true || !(S.thinkingNoticeMs > 0)) return;
    const setTimer = typeof d.setTimer === "function" ? d.setTimer : defaultSetTimer;
    try {
      req.noticeTimer = setTimer(() => {
        req.noticeTimer = null;
        if (stopped || gen !== generation || !st.inflight || st.req !== req || req.noticed) return;
        req.noticed = true;
        sendStatic(playerId, "THINKING");
      }, S.thinkingNoticeMs);
    } catch (err) {
      req.noticeTimer = null;
      log(`shipAi: notice failed - ${codeOf(err && (err.code || err.name))}`);
    }
  }

  function finish(playerId, st, req, res, gen) {
    cancelNotice(req);
    if (stopped || gen !== generation) return;
    st.inflight = false;
    st.req = null;
    active = Math.max(0, active - 1);
    try {
      onReply(playerId, req, res);
    } catch (err) {
      log(`shipAi: reply failed - ${codeOf(err && (err.code || err.name))}`);
    }
    if (st.pending !== null) waiters.add(playerId);
    pump();
  }

  function start(playerId, st, now) {
    const req = { userText: st.pending, factIds: [], epoch: memory ? memory.epochOf(playerId) : 0, noticed: false,
      noticeTimer: null };
    st.pending = null;
    st.inflight = true;
    st.req = req;
    st.lastStartAt = now;
    active += 1;
    counters.requests += 1;
    const gen = generation;
    armNotice(playerId, st, req, gen);
    let promise;
    try {
      const built = messagesOf(playerId, req.userText);
      req.factIds = built.factIds;
      promise = Promise.resolve(d.client.request({ playerId, messages: built.messages, lane: LANE,
        maxTokens: S.maxTokens }));
    } catch (_err) {
      promise = Promise.resolve({ ok: false, reason: "CONTEXT" });
    }
    promise.then((res) => finish(playerId, st, req, res, gen),
      () => finish(playerId, st, req, { ok: false, reason: "NET_ERROR" }, gen));
  }

  function finishSummary(playerId, st, job, res, gen) {
    if (stopped || gen !== generation) return;
    st.inflight = false;
    active = Math.max(0, active - 1);
    try {
      job.apply(res);
    } catch (err) {
      log(`shipAi: summary failed - ${codeOf(err && (err.code || err.name))}`);
    }
    if (st.pending !== null) waiters.add(playerId);
    pump();
  }

  function startSummaries() {
    for (const playerId of [...summaryWanted]) {
      if (waiters.size > 0 || active >= S.maxInFlight) return;
      let st = players.get(playerId);
      if (st && (st.inflight || st.pending !== null)) continue;
      summaryWanted.delete(playerId);
      const job = memory.summaryJob(playerId);
      if (!job) continue;
      if (!st) {
        st = { inflight: false, pending: null, lastStartAt: -Infinity };
        players.set(playerId, st);
      }
      st.inflight = true;
      active += 1;
      counters.summaryRequests += 1;
      const gen = generation;
      let promise;
      try {
        promise = Promise.resolve(summaryClient.request({ playerId, messages: job.messages, lane: SUMMARY_LANE,
          maxTokens: job.maxTokens }));
      } catch (_err) {
        promise = Promise.resolve({ ok: false, reason: "CONTEXT" });
      }
      promise.then((res) => finishSummary(playerId, st, job, res, gen),
        () => finishSummary(playerId, st, job, { ok: false, reason: "NET_ERROR" }, gen));
    }
  }

  function pump() {
    if (stopped) return;
    const now = d.nowMs();
    for (const playerId of [...waiters]) {
      const st = players.get(playerId);
      if (!st || st.pending === null) {
        waiters.delete(playerId);
        continue;
      }
      if (st.inflight) continue;
      if (active >= S.maxInFlight) break;
      const wait = st.lastStartAt + S.minIntervalMs - now;
      if (wait > 0) {
        poller.arm(wait);
        continue;
      }
      waiters.delete(playerId);
      start(playerId, st, now);
    }
    if (memory && summaryClient && summaryWanted.size > 0) startSummaries();
    for (const [playerId, st] of players) {
      if (!st.inflight && st.pending === null && now - st.lastStartAt >= S.minIntervalMs) players.delete(playerId);
    }
  }

  const poller = createPoller({ runPass: pump, intervalMs: S.pumpIntervalMs, now: () => d.nowMs(),
    setTimer: d.setTimer, onError: (err) => log(`shipAi: pump failed - ${codeOf(err && (err.code || err.name))}`) });
  poller.start();

  function onMessage(playerId, text) {
    try {
      if (stopped || !Number.isSafeInteger(playerId) || playerId <= 0) return;
      const clean = cleanUserText(text, S.maxUserChars);
      if (clean === "") return;
      counters.messages += 1;
      let st = players.get(playerId);
      if (!st) {
        st = { inflight: false, pending: null, lastStartAt: -Infinity };
        players.set(playerId, st);
      }
      if (st.pending !== null) {
        const joined = `${st.pending}\n${clean}`;
        if (joined.length > S.maxPendingChars) {
          counters.busy += 1;
          sendStatic(playerId, "BUSY");
          return;
        }
        st.pending = joined;
        return;
      }
      st.pending = clean;
      waiters.add(playerId);
      if (!st.inflight) pump();
    } catch (err) {
      log(`shipAi: message failed - ${codeOf(err && (err.code || err.name))}`);
    }
  }

  function getStatus() {
    let pending = 0;
    for (const st of players.values()) if (st.pending !== null) pending += 1;
    return { inFlight: active, waiting: waiters.size, pending, characters: players.size, counters: { ...counters } };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    poller.stop();
    players.clear();
    waiters.clear();
    summaryWanted.clear();
    active = 0;
  }

  return Object.freeze({ onMessage, sendStatic: (playerId, kind) => {
    try {
      if (!stopped) sendStatic(playerId, kind);
    } catch (_err) {
    }
  }, getStatus, stop });
}

module.exports = { createConversation, createDeliver, cleanUserText, COUNTER_NAMES, TIRED_REASONS };
