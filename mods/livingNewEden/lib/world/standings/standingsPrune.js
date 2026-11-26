"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const { planCharacterPrune } = require("./pruneRules");

const PRUNE_AGGREGATE_ID = "prune";
const COUNTER_NAMES = Object.freeze(["passes", "charsVisited", "receiptsPruned", "receiptWrites", "receiptWriteFailed",
  "receiptReadFailed", "orphanReceipts", "grantsPruned", "eventsPruned", "notDone", "foreignRows", "truncated",
  "chainPurged"]);
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err);
}

function createStandingsPrune(deps) {
  const { store, journal, scheduler, adapter, clock, config } = deps;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const s = config.standings;
  const params = Object.freeze({ retentionMs: s.retentionMs, receiptGraceMs: s.receiptGraceMs,
    intervalMs: s.pruneIntervalMs, maxCharacters: s.pruneMaxCharactersPerPass, maxGrants: s.pruneMaxGrantsPerPass,
    maxLookups: s.pruneMaxLookupsPerPass });
  const scanCap = deps.maxScanRows;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let cursor = { characterId: null, afterKey: null };
  let stopped = false;
  let lastRefusal = null;
  let bootstrapped = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (n > 0) counters[name] += n;
  }

  function refuse(where, reason) {
    lastRefusal = `${where}:${String(reason).slice(0, MAX_DETAIL)}`;
  }

  function log(message) {
    try {
      logger.log(message);
    } catch (_err) {
    }
  }

  function read(name, fn) {
    const r = store.transaction(name, fn);
    if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
    return r.value;
  }

  function seekCharacter(from, budget) {
    let key = from;
    let after = false;
    let used = 0;
    while (used < budget.left) {
      used += 1;
      const r = read("standings.pruneSeek", (tx) => journal.scanKeyRange(tx, key, S.KEY_RANGE_END, 1, { after }));
      if (!r || !r.ok) {
        budget.left -= used;
        return { ok: false, reason: (r && r.reason) || "SCAN_FAILED" };
      }
      const row = r.rows[0];
      if (!row) {
        budget.left -= used;
        return { ok: true, characterId: null };
      }
      const id = S.characterOfKey(row.key);
      if (id !== null) {
        budget.left -= used;
        return { ok: true, characterId: id };
      }
      key = row.key;
      after = true;
    }
    budget.left -= used;
    return { ok: true, characterId: null, exhausted: true };
  }

  function visit(c, afterKey, now, budget, stats) {
    const range = S.charRange(c);
    const limit = Math.min(budget.left, scanCap);
    if (limit < 1) return { ok: false, reason: "BUDGET" };
    const scan = read("standings.pruneScan", (tx) => journal.scanKeyRange(tx, afterKey === null ? range.from : afterKey,
      range.to, limit, { after: afterKey !== null }));
    if (!scan || !scan.ok) return { ok: false, reason: (scan && (scan.detail || scan.reason)) || "SCAN_FAILED" };
    const rows = scan.rows;
    budget.left -= rows.length;
    const scanComplete = rows.length < limit;
    const lastScannedKey = rows.length > 0 ? rows[rows.length - 1].key : afterKey;
    const next = scanComplete ? { characterId: c, afterKey: null } : { characterId: c, afterKey: lastScannedKey };
    const listed = adapter.listStandingReceiptKeys(c, range.from);
    if (!listed || !listed.ok) {
      bump("receiptReadFailed");
      refuse("standings.prune.receipts", (listed && (listed.detail || listed.reason)) || "no result");
      return { ok: true, rows: [], next };
    }
    budget.left -= listed.keys.length;
    const plan = planCharacterPrune({ now, retentionMs: params.retentionMs, receiptGraceMs: params.receiptGraceMs,
      rows, scanComplete, lastScannedKey, afterKey, receiptKeys: listed.found ? listed.keys : [] });
    bump("foreignRows", plan.kept.foreign);
    let gone = plan.rowsIfReceiptGone;
    if (plan.receiptsToDelete.length > 0) {
      const t0 = nowMs();
      const w = adapter.pruneStandingReceipts(c, plan.receiptsToDelete);
      metric("observe", "world.standings.receiptWriteMs", Math.round((nowMs() - t0) * 100) / 100);
      if (w && w.ok === true) {
        bump("receiptsPruned", w.removed);
        bump("orphanReceipts", plan.orphans);
        stats.receipts += w.removed;
        if (w.written) {
          bump("receiptWrites");
          stats.writes += 1;
        }
      } else if (!(w && w.reason === "CHARACTER_NOT_FOUND")) {
        bump("receiptWriteFailed");
        refuse("standings.prune.write", w && w.detail ? `${w.reason}:${w.detail}` : (w && w.reason) || "no result");
        gone = [];
      }
    }
    return { ok: true, rows: gone, next };
  }

  function handler(ev, hctx) {
    try {
      if (stopped) return { ok: false, reason: "STANDINGS_STOPPED" };
      const now = hctx && Number.isSafeInteger(hctx.now) ? hctx.now : clock.now();
      const anchor = hctx && Number.isSafeInteger(hctx.anchorAt) ? hctx.anchorAt : now;
      const t0 = nowMs();
      const budget = { left: params.maxLookups };
      const stats = { receipts: 0, writes: 0, chars: 0 };
      const doomed = [];
      const seen = new Set();
      let cur = { ...cursor };
      let wrapped = false;
      while (stats.chars < params.maxCharacters && budget.left > 0 && doomed.length < params.maxGrants) {
        let c = cur.characterId;
        let afterKey = cur.afterKey;
        if (c === null || afterKey === null) {
          const found = seekCharacter(c === null ? S.KEY_PREFIX : S.charRange(c).to, budget);
          if (!found.ok) {
            refuse("standings.prune.seek", found.reason);
            break;
          }
          if (found.characterId === null) {
            if (found.exhausted) break;
            cur = { characterId: null, afterKey: null };
            if (wrapped || c === null) break;
            wrapped = true;
            continue;
          }
          c = found.characterId;
          afterKey = null;
        }
        if (seen.has(c) && afterKey === null) break;
        seen.add(c);
        const v = visit(c, afterKey, now, budget, stats);
        if (!v.ok) {
          if (v.reason !== "BUDGET") refuse("standings.prune.scan", v.reason);
          break;
        }
        stats.chars += 1;
        const room = params.maxGrants - doomed.length;
        if (v.rows.length > room) bump("truncated");
        for (const r of v.rows.slice(0, room)) doomed.push(r);
        cur = v.next;
      }
      cursor = cur;
      bump("charsVisited", stats.chars);
      metric("observe", "world.standings.pruneMs", Math.round((nowMs() - t0) * 100) / 100);

      const I = params.intervalMs;
      const bucket = Math.floor(anchor / I) + 1;
      const reschedule = { eventType: S.PRUNE_EVENT_TYPE, aggregateId: PRUNE_AGGREGATE_ID, dueAt: bucket * I,
        payload: { intervalMs: I, round: bucket }, idempotencyKey: S.pruneKey(I, bucket) };
      const finishedBefore = Math.max(0, now - params.retentionMs);
      const effect = (tx) => {
        let eventsPruned = 0;
        let grantsPruned = 0;
        let notDone = 0;
        if (doomed.length > 0) {
          const a = scheduler.purgeDone({ eventType: S.EVENT_TYPE, keys: doomed.map((r) => r.key) }, { tx });
          if (!a || !a.ok) return { ok: false, reason: (a && a.reason) || "PURGE_DONE_FAILED" };
          eventsPruned = a.deleted;
          notDone = a.notDone.length;
          const keep = new Set(a.notDone);
          const ids = doomed.filter((r) => !keep.has(r.key)).map((r) => r.journalId);
          const j = journal.purgeTerminal(tx, { fromKey: S.KEY_PREFIX, toKey: S.KEY_RANGE_END, journalIds: ids });
          if (!j || !j.ok) return { ok: false, reason: (j && j.reason) || "PURGE_JOURNAL_FAILED" };
          grantsPruned = j.deleted;
        }
        const chain = scheduler.purgeDone({ eventType: S.PRUNE_EVENT_TYPE, fromKey: S.PRUNE_KEY_PREFIX,
          toKey: S.PRUNE_KEY_RANGE_END, finishedBefore, limit: S.PRUNE_CHAIN_PURGE }, { tx });
        if (!chain || !chain.ok) return { ok: false, reason: (chain && chain.reason) || "PURGE_CHAIN_FAILED" };
        return { ok: true, eventsPruned, grantsPruned, notDone, chainPurged: chain.deleted };
      };
      const ms = Math.round((nowMs() - t0) * 100) / 100;
      return { ok: true, outcome: "PRUNED", effect, reschedule,
        onCommitted: (value) => {
          bump("passes");
          const v = value && value.ok ? value : { grantsPruned: 0, eventsPruned: 0, notDone: 0, chainPurged: 0 };
          bump("grantsPruned", v.grantsPruned);
          bump("eventsPruned", v.eventsPruned);
          bump("notDone", v.notDone);
          bump("chainPurged", v.chainPurged);
          if (stats.receipts + stats.writes + v.grantsPruned + v.eventsPruned > 0) {
            log(`standings: pruned receipts=${stats.receipts} writes=${stats.writes} grants=${v.grantsPruned} `
              + `chars=${stats.chars} ms=${ms}`);
          }
        } };
    } catch (err) {
      refuse("standings.prune", messageOf(err));
      return { ok: false, reason: `STANDINGS_PRUNE_FAILED:${messageOf(err)}`.slice(0, MAX_DETAIL) };
    }
  }

  function bootstrap() {
    try {
      if (stopped) return { ok: false, reason: "STANDINGS_STOPPED" };
      const I = params.intervalMs;
      const bucket = Math.floor(clock.now() / I) + 1;
      const r = scheduler.enqueue(S.PRUNE_EVENT_TYPE, PRUNE_AGGREGATE_ID, bucket * I, { intervalMs: I, round: bucket },
        S.pruneKey(I, bucket));
      if (!r || !r.ok) {
        refuse("standings.prune.bootstrap", (r && r.reason) || "ENQUEUE_FAILED");
        bootstrapped = { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
        return bootstrapped;
      }
      bootstrapped = { ok: true, duplicate: r.duplicate === true, dueAt: bucket * I };
      return bootstrapped;
    } catch (err) {
      bootstrapped = { ok: false, reason: `BOOTSTRAP_FAILED:${messageOf(err)}`.slice(0, MAX_DETAIL) };
      return bootstrapped;
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "on", params, counters: Object.freeze({ ...counters }),
      lastRefusal, cursor: Object.freeze({ ...cursor }),
      bootstrap: bootstrapped ? Object.freeze({ ...bootstrapped }) : null });
  }

  return Object.freeze({
    handler,
    bootstrap,
    getStatus,
    params,
    stop() {
      stopped = true;
    },
  });
}

module.exports = { createStandingsPrune, PRUNE_COUNTER_NAMES: COUNTER_NAMES };
