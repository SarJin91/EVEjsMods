"use strict";

const { performance } = require("node:perf_hooks");
const { refKeysOf, factsOfEntries, TAIL_AGGREGATE_TYPES } = require("./collect/journalFacts");
const { runTx } = require("./tx");

const MS_DECIMALS = 10;

function messageOf(err) {
  return String((err && err.message) || err);
}

function createNewsTail(deps) {
  const { store, journal, repo } = deps;
  const s = deps.settings;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const observe = typeof deps.observe === "function" ? deps.observe : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  let cursor = null;
  let head = null;

  function rowCap() {
    const max = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
      ? store.limits.maxRowsPerTransaction : s.tailMaxRowsPerPass + 1;
    return Math.max(1, Math.min(s.tailMaxRowsPerPass, max - 1));
  }

  function bootstrap(now) {
    if (!journal || typeof journal.headId !== "function" || typeof journal.listAfter !== "function") {
      return { ok: false, reason: "JOURNAL_TAIL_UNAVAILABLE" };
    }
    const r = runTx(store, "news.bootstrap", (db) => {
      const h = journal.headId(db);
      if (!h || !h.ok) return h;
      const st = repo.readStateInTx(db);
      if (!st.ok) return st;
      if (st.state) return { ok: true, cursor: st.state.cursor, head: h.headId, created: false };
      const w = repo.writeCursorInTx(db, h.headId, now);
      if (!w.ok) return w;
      return { ok: true, cursor: h.headId, head: h.headId, created: true };
    });
    if (!r.ok) return r;
    cursor = r.value.cursor;
    head = r.value.head;
    return { ok: true, cursor, head, created: r.value.created };
  }

  function passInTx(db, now) {
    const h = journal.headId(db);
    if (!h || !h.ok) return h || { ok: false, reason: "HEAD_FAILED" };
    const st = repo.readStateInTx(db);
    if (!st.ok) return st;
    const from = st.state ? st.state.cursor : h.headId;
    const headId = h.headId;
    if (headId < from || headId - from > s.tailMaxLagRows) {
      const w = repo.writeCursorInTx(db, headId, now);
      if (!w.ok) return w;
      return { ok: true, lag: true, headId, cursor: headId, skipped: Math.max(1, Math.abs(headId - from)) };
    }
    const listed = journal.listAfter(db, { afterId: from, uptoId: Math.min(headId, from + s.tailScanWindow),
      aggregateTypes: [...TAIL_AGGREGATE_TYPES], limit: rowCap() });
    if (!listed.ok) return listed;
    const entries = listed.entries;
    const refs = repo.readFactsByKeysInTx(db, refKeysOf(entries));
    if (!refs.ok) return refs;
    const got = factsOfEntries(entries, { kinds: s.kinds, capitalClasses: s.capitalClasses, refs: refs.facts,
      cycleHours: s.cycleHours, publishHourUtc: s.publishHourUtc, place: deps.place, factionName: deps.factionName,
      regionName: deps.regionName });
    const up = repo.upsertFactsInTx(db, got.facts, now);
    if (!up.ok) return up;
    const next = listed.scannedUpTo;
    if (next !== from) {
      const w = repo.writeCursorInTx(db, next, now);
      if (!w.ok) return w;
    }
    return { ok: true, lag: false, headId, cursor: next, rows: entries.length, up, skipped: got.skipped };
  }

  function runPass(now) {
    if (cursor === null) {
      const b = bootstrap(now);
      if (!b.ok) return b;
    }
    const t0 = nowMs();
    let r;
    try {
      r = runTx(store, "news.tail", (db) => passInTx(db, now));
    } catch (err) {
      r = { ok: false, reason: "TAIL_THREW", detail: messageOf(err) };
    } finally {
      observe("tailMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    }
    if (!r.ok) return r;
    const v = r.value;
    head = v.headId;
    cursor = v.cursor;
    if (v.lag) {
      bump("tailSkippedLag", v.skipped);
      log(`tail lag ${v.skipped} rows above tailMaxLagRows - jump to the head ${v.headId}`);
      return { ok: true, rows: 0, cursor, lag: true };
    }
    if (v.rows > 0) bump("tailRows", v.rows);
    if (v.up.inserted > 0) bump("factsInserted", v.up.inserted);
    if (v.up.merged > 0) bump("factsMerged", v.up.merged);
    if (v.up.late > 0) bump("factsLate", v.up.late);
    if (v.skipped.REF_MISSING) bump("refMissing", v.skipped.REF_MISSING);
    return { ok: true, rows: v.rows, cursor };
  }

  function getStatus() {
    return { cursor, head, lag: cursor !== null && head !== null ? Math.max(0, head - cursor) : null };
  }

  return Object.freeze({ bootstrap, runPass, getStatus });
}

module.exports = { createNewsTail };
