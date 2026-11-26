"use strict";

const { createShipAiFactsRepository } = require("./factsRepository");
const { createShipAiSummaryRepository, MEMORY_ABORT } = require("./summaryRepository");
const { buildExtractionMessages, parseExtraction, validateFact, cleanSummary } = require("./extract");
const { checkInjection } = require("./guard");
const { METRIC, FACT_REJECT_REASONS, FACT_CATEGORIES } = require("../schema");

const LIST_MAX = 10;
const PLAYER_IMPORTANCE = 4;
const PLAYER_DEFAULT_CATEGORY = "other";
const MIN_CHAR_BATCH_ROWS = 4;
const COUNTER_NAMES = Object.freeze(["summaryJobs", "summariesWritten", "summaryStale", "summaryFailed",
  "summaryEmpty", "summaryDiscarded", "summaryRejected", "factsInserted", "factsBumped", "factsEvicted",
  "factsExpired", "factsSkipped", "remembered", "forgotten", "forgetAll", "promptBlocks", "sqlFailed",
  ...FACT_REJECT_REASONS.map((r) => `rejected_${r}`)]);

function noop() {}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const codeOf = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, 60);
const valueOf = (res) => (res && res.ok && res.value && res.value.ok ? res.value : null);
const reasonOf = (res) => codeOf(res && (res.ok ? res.value && res.value.reason : res.reason));

function createShipAiMemory(deps) {
  const d = deps;
  const S = d.S;
  const store = d.store;
  const facts = createShipAiFactsRepository();
  const summaries = createShipAiSummaryRepository();
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : { log: noop };
  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const epochs = new Map();

  const log = (line) => {
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const metric = (n) => {
    if (!telemetry || n <= 0) return;
    try {
      telemetry.count(METRIC.memoryWrites, n);
    } catch (_err) {
    }
  };
  const sqlFailed = (where, res) => {
    counters.sqlFailed += 1;
    log(`shipAi memory: ${where} failed - ${reasonOf(res)}`);
  };
  const otherNamesOf = (playerId) => {
    try {
      const names = typeof d.otherNames === "function" ? d.otherNames(playerId) : [];
      return Array.isArray(names) ? names : [];
    } catch (_err) {
      return [];
    }
  };

  const epochOf = (playerId) => epochs.get(playerId) || 0;

  function promptBlock(playerId, userText) {
    const none = { content: null, factIds: [] };
    if (!S.memoryEnabled || !isId(playerId)) return none;
    try {
      const now = d.nowMs();
      const res = store.transaction("shipAi.memory.prompt", (db) => {
        const sum = summaries.readSummary(db, playerId);
        if (!sum.ok) return sum;
        const top = facts.selectTopK(db, playerId, userText, S.factsInPrompt, now, S.factsMaxChars);
        if (!top.ok) return top;
        return { ok: true, summary: sum.row, top };
      });
      const v = valueOf(res);
      if (!v) {
        sqlFailed("prompt", res);
        return none;
      }
      counters.factsExpired += v.top.expired;
      counters.factsSkipped += v.top.skipped;
      const summary = v.summary && v.summary.text !== "" && checkInjection(v.summary.text).ok ? v.summary.text : "";
      if (summary === "" && v.top.facts.length === 0) return none;
      counters.promptBlocks += 1;
      const memory = { summary, facts: v.top.facts.map((f) => `${f.category}: ${f.content}`) };
      return { content: `DATA ${JSON.stringify({ memory })}`, factIds: v.top.facts.map((f) => f.id) };
    } catch (err) {
      log(`shipAi memory: prompt failed - ${codeOf(err && (err.code || err.name))}`);
      return none;
    }
  }

  function touchInTx(tx, factIds, nowMs) {
    if (!S.memoryEnabled || !Array.isArray(factIds) || factIds.length === 0) return { ok: true, touched: 0 };
    return facts.touchInTx(tx, factIds, nowMs);
  }

  function readJobState(playerId) {
    const res = store.transaction("shipAi.memory.due", (db) => {
      const sum = summaries.readSummary(db, playerId);
      if (!sum.ok) return sum;
      const top = d.turnsRepo.maxSeq(db, playerId);
      if (!top.ok) return top;
      const rows = d.turnsRepo.listRecent(db, playerId, S.turnsKeep);
      if (!rows.ok) return rows;
      const keys = facts.keysForPlayer(db, playerId);
      if (!keys.ok) return keys;
      return { ok: true, summary: sum.row, maxSeq: top.seq, rows: rows.rows, keys: keys.keys };
    });
    const v = valueOf(res);
    if (!v) sqlFailed("due", res);
    return v;
  }

  function acceptedFacts(playerId, parsed) {
    const names = otherNamesOf(playerId);
    const out = [];
    for (const f of parsed.facts) {
      const r = validateFact(f, S, { otherNames: names });
      if (!r.ok) {
        counters[`rejected_${r.reason}`] += 1;
        continue;
      }
      out.push({ ...r.fact, source: "model", ttlDays: S.factTtlDays });
    }
    return out;
  }

  function applyExtraction(playerId, job, text, list) {
    const now = d.nowMs();
    const res = store.transaction("shipAi.memory.extract", (db) => {
      const written = summaries.writeSummaryInTx(db, { playerId, text, coversThroughSeq: job.coversThroughSeq,
        nowMs: now });
      if (!written.ok) return written;
      const up = facts.upsertFactsInTx(db, playerId, list, now, S);
      if (!up.ok) throw MEMORY_ABORT;
      const pr = d.turnsRepo.pruneCoveredInTx(db, playerId, job.coversThroughSeq);
      if (!pr.ok) throw MEMORY_ABORT;
      return { ok: true, version: written.version, up };
    });
    const v = valueOf(res);
    if (!v) {
      if (res.ok && res.value && res.value.reason === "STALE") counters.summaryStale += 1;
      else sqlFailed("extract", res);
      return { ok: false, reason: res.ok && res.value ? res.value.reason : res.reason };
    }
    counters.summariesWritten += 1;
    counters.factsInserted += v.up.inserted;
    counters.factsBumped += v.up.bumped;
    counters.factsEvicted += v.up.evicted;
    counters.factsExpired += v.up.expired;
    metric(1 + v.up.inserted + v.up.bumped);
    return { ok: true, version: v.version, inserted: v.up.inserted, bumped: v.up.bumped };
  }

  function summaryJob(playerId) {
    if (!S.memoryEnabled || !isId(playerId)) return null;
    try {
      const st = readJobState(playerId);
      if (!st) return null;
      const covers = st.summary ? st.summary.coversThroughSeq : 0;
      const uncovered = st.rows.filter((r) => r.seq > covers);
      const E = S.summaryEveryTurns;
      let end = st.maxSeq - E;
      if (end % 2 !== 0) end -= 1;
      if (end <= covers) return null;
      const turns = uncovered.filter((r) => r.seq <= end);
      if (turns.length === 0) return null;
      const chars = turns.reduce((n, r) => n + r.text.length, 0);
      const byCount = st.maxSeq - covers >= 2 * E;
      const byChars = chars > S.historyMaxChars && end - covers >= MIN_CHAR_BATCH_ROWS;
      if (!byCount && !byChars) return null;
      counters.summaryJobs += 1;
      const epoch = epochOf(playerId);
      const previous = st.summary ? st.summary.text : "";
      const job = { coversThroughSeq: end, maxTokens: S.summaryMaxTokens,
        messages: buildExtractionMessages({ summary: previous, turns, knownKeys: st.keys, language: S.language,
          maxSummaryChars: S.summaryMaxChars, maxFactChars: S.factMaxChars }) };
      job.apply = (res) => {
        try {
          if (epochOf(playerId) !== epoch) {
            counters.summaryDiscarded += 1;
            return { ok: false, reason: "DISCARDED" };
          }
          if (!res || res.ok !== true || typeof res.text !== "string") {
            counters.summaryFailed += 1;
            return { ok: false, reason: codeOf(res && res.reason) };
          }
          const parsed = parseExtraction(res.text);
          if (parsed.summary === null && parsed.facts.length === 0) {
            counters.summaryEmpty += 1;
            return { ok: false, reason: "EMPTY" };
          }
          let text = parsed.summary === null ? null : cleanSummary(parsed.summary, S);
          if (parsed.summary !== null && text === null) counters.summaryRejected += 1;
          if (text === null) text = previous;
          return applyExtraction(playerId, job, text, acceptedFacts(playerId, parsed));
        } catch (err) {
          log(`shipAi memory: summary apply failed - ${codeOf(err && (err.code || err.name))}`);
          return { ok: false, reason: "APPLY_FAILED" };
        }
      };
      return Object.freeze(job);
    } catch (err) {
      log(`shipAi memory: summary job failed - ${codeOf(err && (err.code || err.name))}`);
      return null;
    }
  }

  function list(playerId) {
    const res = store.transaction("shipAi.memory.list", (db) => facts.listForPlayer(db, playerId, LIST_MAX));
    const v = valueOf(res);
    if (!v) {
      sqlFailed("list", res);
      return { ok: false, reason: "MEMORY_FAILED" };
    }
    return { ok: true, facts: v.facts.map((f) => ({ id: f.id, category: f.category, content: f.content })) };
  }

  function remember(playerId, text) {
    const raw = String(text ?? "").trim();
    const m = /^([a-z]+)\s*:\s*([\s\S]+)$/i.exec(raw);
    const named = m && FACT_CATEGORIES.includes(m[1].toLowerCase());
    const fact = { category: named ? m[1].toLowerCase() : PLAYER_DEFAULT_CATEGORY, importance: PLAYER_IMPORTANCE,
      content: named ? m[2] : raw };
    const r = validateFact(fact, S);
    if (!r.ok) {
      counters[`rejected_${r.reason}`] += 1;
      return { ok: false, reason: r.reason };
    }
    const now = d.nowMs();
    const res = store.transaction("shipAi.memory.remember", (db) => facts.upsertFactsInTx(db, playerId,
      [{ ...r.fact, source: "player", ttlDays: S.playerFactTtlDays }], now, S));
    const v = valueOf(res);
    if (!v) {
      sqlFailed("remember", res);
      return { ok: false, reason: "MEMORY_FAILED" };
    }
    counters.remembered += 1;
    counters.factsEvicted += v.evicted;
    counters.factsExpired += v.expired;
    metric(v.inserted + v.bumped);
    return v.ids.length > 0 ? { ok: true, id: v.ids[0] } : { ok: false, reason: "EVICTED" };
  }

  function forget(playerId, needle) {
    const res = store.transaction("shipAi.memory.forget", (db) => facts.forgetMatchingInTx(db, playerId, needle));
    const v = valueOf(res);
    if (!v) {
      if (res.ok && res.value && res.value.reason === "INVALID_INPUT") return { ok: false, reason: "INVALID_INPUT" };
      sqlFailed("forget", res);
      return { ok: false, reason: "MEMORY_FAILED" };
    }
    counters.forgotten += v.deleted;
    return { ok: true, deleted: v.deleted };
  }

  function forgetAll(playerId) {
    epochs.set(playerId, epochOf(playerId) + 1);
    const res = store.transaction("shipAi.memory.forgetAll", (db) => {
      const f = facts.forgetAllInTx(db, playerId);
      if (!f.ok) return f;
      const s = summaries.deleteInTx(db, playerId);
      if (!s.ok) throw MEMORY_ABORT;
      const t = d.turnsRepo.deleteAllInTx(db, playerId);
      if (!t.ok) throw MEMORY_ABORT;
      const e = d.eventsRepo ? d.eventsRepo.deleteAllInTx(db, playerId) : { ok: true, deleted: 0 };
      if (!e.ok) throw MEMORY_ABORT;
      return { ok: true, turns: t.deleted, summaries: s.deleted, facts: f.deleted, events: e.deleted };
    });
    const v = valueOf(res);
    if (!v) {
      sqlFailed("forgetAll", res);
      return { ok: false, reason: "MEMORY_FAILED" };
    }
    counters.forgetAll += 1;
    return { ok: true, turns: v.turns, summaries: v.summaries, facts: v.facts, events: v.events };
  }

  function noteMailFacts(playerId, list, epoch) {
    if (!S.memoryEnabled || !isId(playerId) || epochOf(playerId) !== epoch || S.mailFactsPerDigest <= 0) {
      return { ok: true, written: 0 };
    }
    try {
      const accepted = [];
      for (const f of Array.isArray(list) ? list : []) {
        if (accepted.length >= S.mailFactsPerDigest) break;
        const r = validateFact(f, S);
        if (!r.ok) {
          counters[`rejected_${r.reason}`] += 1;
          continue;
        }
        accepted.push({ ...r.fact, importance: Math.min(r.fact.importance, S.mailFactMaxImportance), source: "mail",
          ttlDays: S.mailFactTtlDays });
      }
      if (accepted.length === 0) return { ok: true, written: 0 };
      const res = store.transaction("shipAi.memory.mail", (db) => facts.upsertFactsInTx(db, playerId, accepted,
        d.nowMs(), S));
      const v = valueOf(res);
      if (!v) {
        sqlFailed("mail", res);
        return { ok: false, reason: "MEMORY_FAILED" };
      }
      counters.factsInserted += v.inserted;
      counters.factsBumped += v.bumped;
      counters.factsEvicted += v.evicted;
      counters.factsExpired += v.expired;
      metric(v.inserted + v.bumped);
      return { ok: true, written: v.inserted + v.bumped };
    } catch (err) {
      log(`shipAi memory: mail facts failed - ${codeOf(err && (err.code || err.name))}`);
      return { ok: false, reason: "MEMORY_FAILED" };
    }
  }

  function getStatus() {
    let total = null;
    try {
      const res = store.transaction("shipAi.memory.count", (db) => facts.countAll(db));
      const v = valueOf(res);
      total = v ? v.count : null;
    } catch (_err) {
      total = null;
    }
    return { enabled: S.memoryEnabled, facts: total, counters: { ...counters } };
  }

  return Object.freeze({ enabled: S.memoryEnabled === true, promptBlock, touchInTx, summaryJob, epochOf, list,
    remember, forget, forgetAll, noteMailFacts, getStatus });
}

module.exports = { createShipAiMemory, COUNTER_NAMES, LIST_MAX, PLAYER_IMPORTANCE };
