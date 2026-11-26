"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const { planClassBatch, filterGuarded } = require("./retentionRules");

const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err);
}

function createRetention(deps) {
  const { store, scheduler, clock, journal } = deps;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const params = Object.freeze({ ...deps.params });
  const classes = deps.classes;
  const counters = Object.fromEntries(S.COUNTER_NAMES.map((n) => [n, 0]));
  const perClass = Object.fromEntries(classes.map((c) => [c.id,
    { scanned: 0, deleted: 0, candidates: 0, sweeps: 0, afterKey: null, cycleScanned: 0, cycleDeleted: 0,
      guarded: 0, lastSweepAt: null }]));
  let cursor = { classIndex: 0, afterKey: null };
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
    if (!(n > 0)) return;
    counters[name] += n;
    metric("count", `persistence.retention.${name}`, n);
  }

  function refuse(where, reason) {
    lastRefusal = `${where}:${String(reason).slice(0, MAX_DETAIL)}`;
    bump("refused");
  }

  function log(message) {
    try {
      logger.log(message);
    } catch (_err) {
    }
  }

  function read(fn) {
    const r = store.transaction("retention.scan", fn);
    if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
    return r.value;
  }

  function handler(ev, hctx) {
    try {
      if (stopped) return { ok: false, reason: "RETENTION_STOPPED" };
      const now = hctx && Number.isSafeInteger(hctx.now) ? hctx.now : clock.now();
      const anchor = hctx && Number.isSafeInteger(hctx.anchorAt) ? hctx.anchorAt : now;
      const t0 = nowMs();
      const cutoff = now - params.minAgeMs;
      const budget = { scan: params.maxScanRowsPerPass, del: params.maxDeleteRowsPerPass };
      const stats = { scanned: 0, candidates: 0, young: 0, pattern: 0, state: 0, truncated: 0 };
      const plans = [];
      const scannedBy = {};
      const swept = [];
      const n = classes.length;
      let ci = n > 0 ? cursor.classIndex % n : 0;
      let afterKey = n > 0 && cursor.classIndex < n ? cursor.afterKey : null;
      let circle = 0;
      while (n > 0 && budget.scan > 0 && budget.del > 0 && circle < n) {
        const cls = classes[ci];
        const limit = Math.min(budget.scan, params.maxScanRows);
        const toKey = S.rangeEndOf(cls.prefix);
        const scan = cls.table === "journal"
          ? read((tx) => journal.scanKeyRange(tx, afterKey === null ? cls.prefix : afterKey, toKey, limit,
            { after: afterKey !== null }))
          : read((tx) => scheduler.scanKeys({ fromKey: cls.prefix, toKey, afterKey, limit }, { tx }));
        if (!scan || !scan.ok) {
          refuse(`retention.scan.${cls.id}`, (scan && (scan.detail || scan.reason)) || "SCAN_FAILED");
          break;
        }
        const rows = scan.rows;
        budget.scan -= rows.length;
        stats.scanned += rows.length;
        scannedBy[cls.id] = (scannedBy[cls.id] || 0) + rows.length;
        const own = params.classMinAgeMs && params.classMinAgeMs[cls.id];
        const plan = planClassBatch({ rows, cls, cutoff: Number.isSafeInteger(own) ? now - own : cutoff,
          room: budget.del });
        stats.young += plan.skipped.young;
        stats.pattern += plan.skipped.pattern;
        stats.state += plan.skipped.state;
        if (plan.doomed.length > 0) {
          plans.push({ cls, keys: plan.doomed });
          budget.del -= plan.doomed.length;
          stats.candidates += plan.doomed.length;
        }
        if (plan.truncated) {
          stats.truncated += 1;
          afterKey = plan.lastAcceptedKey;
          break;
        }
        if (rows.length < limit) {
          swept.push(cls.id);
          afterKey = null;
          ci = (ci + 1) % n;
          circle += 1;
        } else {
          afterKey = rows[rows.length - 1].key;
        }
      }
      const nextCursor = { classIndex: ci, afterKey };
      const nextKeyOf = Object.fromEntries(classes.map((c, i) => [c.id, i === ci ? afterKey : null]));

      const I = params.intervalMs;
      const bucket = Math.floor(anchor / I) + 1;
      const reschedule = { eventType: S.EVENT_TYPE, aggregateId: S.AGGREGATE_ID, dueAt: bucket * I,
        payload: { intervalMs: I, round: bucket }, idempotencyKey: S.passKey(I, bucket) };
      const dryRun = params.dryRun === true;
      const effect = (tx) => {
        const deletedBy = {};
        const guardedBy = {};
        let deletedEvents = 0;
        let deletedJournal = 0;
        let notDone = 0;
        let guarded = 0;
        for (const p of plans) {
          if (p.cls.table === "journal") {
            const st = scheduler.statesOf([...new Set(p.keys.map((d) => d.guardKey))], { tx });
            if (!st || !st.ok) {
              refuse(`retention.guard.${p.cls.id}`, (st && (st.detail || st.reason)) || "STATES_OF_FAILED");
              return { ok: false, reason: (st && st.reason) || "STATES_OF_FAILED" };
            }
            const kept = filterGuarded(p.keys, st.states);
            guarded += kept.guarded;
            guardedBy[p.cls.id] = (guardedBy[p.cls.id] || 0) + kept.guarded;
            if (dryRun) continue;
            const j = journal.purgeTerminal(tx, { fromKey: p.cls.prefix, toKey: S.rangeEndOf(p.cls.prefix),
              journalIds: kept.journalIds });
            if (!j || !j.ok) {
              refuse(`retention.purge.${p.cls.id}`, (j && (j.detail || j.reason)) || "PURGE_JOURNAL_FAILED");
              return { ok: false, reason: (j && j.reason) || "PURGE_JOURNAL_FAILED" };
            }
            deletedBy[p.cls.id] = (deletedBy[p.cls.id] || 0) + j.deleted;
            deletedJournal += j.deleted;
            continue;
          }
          if (dryRun) continue;
          const r = scheduler.purgeDone({ eventType: p.cls.eventType, keys: p.keys }, { tx });
          if (!r || !r.ok) {
            refuse(`retention.purge.${p.cls.id}`, (r && (r.detail || r.reason)) || "PURGE_DONE_FAILED");
            return { ok: false, reason: (r && r.reason) || "PURGE_DONE_FAILED" };
          }
          deletedBy[p.cls.id] = (deletedBy[p.cls.id] || 0) + r.deleted;
          deletedEvents += r.deleted;
          notDone += r.notDone.length;
        }
        return { ok: true, deletedEvents, deletedJournal, notDone, guarded, deletedBy, guardedBy };
      };
      const candidatesBy = {};
      for (const p of plans) candidatesBy[p.cls.id] = (candidatesBy[p.cls.id] || 0) + p.keys.length;
      return { ok: true, outcome: dryRun ? "DRY_RUN" : "RETAINED", effect, reschedule,
        onCommitted: (value) => {
          const v = value && value.ok ? value
            : { deletedEvents: 0, deletedJournal: 0, notDone: 0, guarded: 0, deletedBy: {}, guardedBy: {} };
          const guardedBy = v.guardedBy || {};
          cursor = nextCursor;
          bump("passes");
          bump("scanned", stats.scanned);
          bump("candidates", stats.candidates);
          bump("deletedEvents", v.deletedEvents);
          bump("deletedJournal", v.deletedJournal);
          bump("skippedGuard", v.guarded);
          bump("skippedYoung", stats.young);
          bump("skippedPattern", stats.pattern);
          bump("skippedState", stats.state);
          bump("truncated", stats.truncated);
          bump("sweeps", swept.length);
          for (const c of classes) {
            const pc = perClass[c.id];
            const sc = scannedBy[c.id] || 0;
            const del = v.deletedBy[c.id] || 0;
            pc.scanned += sc;
            pc.deleted += del;
            pc.candidates += candidatesBy[c.id] || 0;
            pc.guarded += guardedBy[c.id] || 0;
            pc.cycleScanned += sc;
            pc.cycleDeleted += dryRun ? candidatesBy[c.id] || 0 : del;
            pc.afterKey = nextKeyOf[c.id];
          }
          const ms = Math.round((nowMs() - t0) * 100) / 100;
          metric("observe", "persistence.retention.passMs", ms);
          const sweptAt = swept.length > 0 ? clock.now() : null;
          for (const id of swept) {
            const pc = perClass[id];
            pc.sweeps += 1;
            pc.lastSweepAt = sweptAt;
            log(`retention: sweep class=${id} ${dryRun ? "candidates" : "deleted"}=${pc.cycleDeleted} `
              + `scanned=${pc.cycleScanned} ms=${ms}`);
            pc.cycleScanned = 0;
            pc.cycleDeleted = 0;
          }
        } };
    } catch (err) {
      refuse("retention.pass", messageOf(err));
      return { ok: false, reason: `RETENTION_PASS_FAILED:${messageOf(err)}`.slice(0, MAX_DETAIL) };
    }
  }

  function bootstrap() {
    try {
      if (stopped) return { ok: false, reason: "RETENTION_STOPPED" };
      const I = params.intervalMs;
      const bucket = Math.floor(clock.now() / I) + 1;
      const r = scheduler.enqueue(S.EVENT_TYPE, S.AGGREGATE_ID, bucket * I, { intervalMs: I, round: bucket },
        S.passKey(I, bucket));
      if (!r || !r.ok) {
        refuse("retention.bootstrap", (r && r.reason) || "ENQUEUE_FAILED");
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
    const byClass = {};
    for (const c of classes) {
      const pc = perClass[c.id];
      byClass[c.id] = Object.freeze({ scanned: pc.scanned, deleted: pc.deleted, candidates: pc.candidates,
        sweeps: pc.sweeps, afterKey: pc.afterKey, guarded: pc.guarded, lastSweepAt: pc.lastSweepAt });
    }
    return Object.freeze({ state: stopped ? "stopped" : (params.dryRun ? "dry" : "on"), params,
      counters: Object.freeze({ ...counters }), classes: Object.freeze(byClass), lastRefusal,
      cursor: Object.freeze({ ...cursor }), bootstrap: bootstrapped ? Object.freeze({ ...bootstrapped }) : null });
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

module.exports = { createRetention };
