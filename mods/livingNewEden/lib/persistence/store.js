"use strict";

const { performance } = require("node:perf_hooks");
const { MIGRATIONS, META_TABLE, WORLD_SEED_KEY, isUint32, readSchemaVersion, runMigrations } = require("./migrations");
const { runPacedBackup } = require("./pacedBackup");
const { defaultSetTimer } = require("./checkpointer");
const { createWalMeter } = require("./walMeter");

const STATE_OPEN = "open";
const STATE_SUSPENDED = "suspended";
const STATE_CLOSED = "closed";

const ROW_LIMIT = Symbol("row-limit");
const NESTED = Symbol("nested");
const ABORT_SENTINELS = new Set();

function createAbortSentinel(description) {
  const sentinel = Symbol(String(description));
  ABORT_SENTINELS.add(sentinel);
  return sentinel;
}

function errorCode(err) {
  return err && typeof err.code === "string" ? err.code : undefined;
}

function isBusy(err) {
  const code = errorCode(err);
  return Boolean(code && code.startsWith("SQLITE_BUSY"));
}

function detailOf(err) {
  return String((err && err.message) || err);
}

function failureOf(err) {
  try {
    const reason = err && typeof err === "object" && typeof err.reason === "string" ? err.reason : null;
    return { code: errorCode(err) || null, message: detailOf(err), reason };
  } catch (_err) {
    return { code: null, message: "?", reason: null };
  }
}

function optionsProblem(opts) {
  if (!opts || typeof opts !== "object") return "options missing";
  if (typeof opts.filePath !== "string" || opts.filePath === "") return "filePath";
  if (typeof opts.openDatabase !== "function") return "openDatabase";
  if (!Number.isInteger(opts.busyTimeoutMs) || opts.busyTimeoutMs < 0) return "busyTimeoutMs";
  if (!Number.isInteger(opts.maxRowsPerTransaction) || opts.maxRowsPerTransaction < 1) return "maxRowsPerTransaction";
  if (typeof opts.maxWriteMsPerPass !== "number" || !(opts.maxWriteMsPerPass > 0)) return "maxWriteMsPerPass";
  if (opts.managedCheckpoint === true) {
    if (!Number.isSafeInteger(opts.walSafetyPages) || opts.walSafetyPages < 1) return "walSafetyPages";
    if (typeof opts.checkpointFramesPerRowInitial !== "number" || !(opts.checkpointFramesPerRowInitial > 0)) {
      return "checkpointFramesPerRowInitial";
    }
    const a = opts.checkpointFramesEwma;
    if (typeof a !== "number" || !(a > 0) || a > 1) return "checkpointFramesEwma";
  }
  return null;
}

const CHECKPOINT_TIMING = "wal.checkpoint";

function defaultRandomSeed() {
  return require("../util/rng").randomSeed();
}

function defaultStatWalBytes(walPath) {
  const st = require("node:fs").statSync(walPath, { throwIfNoEntry: false });
  return st ? st.size : 0;
}

const TX_LABEL_RE = /^[A-Za-z0-9_]{1,64}$/;

function openStore(opts) {
  const problem = optionsProblem(opts);
  if (problem) return { ok: false, reason: "OPTIONS_INVALID", detail: problem };
  const nowMs = typeof opts.nowMs === "function" ? opts.nowMs : () => performance.now();
  const exclusive = opts.exclusiveLock !== false;
  const managed = opts.managedCheckpoint === true;
  const randomSeed = typeof opts.randomSeed === "function" ? opts.randomSeed : defaultRandomSeed;
  const migrations = opts.migrations || MIGRATIONS;
  const timing = (name, ms, outcome, rows, why, failure, wal) => {
    if (typeof opts.onTiming !== "function") return;
    try {
      if (wal === undefined) opts.onTiming(name, ms, outcome, rows, why, failure);
      else opts.onTiming(name, ms, outcome, rows, why, failure, wal);
    } catch (_err) {
    }
  };

  const openedAt = nowMs();
  let db;
  try {
    db = opts.openDatabase(opts.filePath);
  } catch (err) {
    return { ok: false, reason: isBusy(err) ? "DB_LOCKED" : "DB_OPEN_FAILED", detail: detailOf(err) };
  }
  const fail = (result) => {
    try {
      db.close();
    } catch (_err) {
    }
    return result;
  };

  let worldSeed;
  let migrated;
  let totalChanges;
  let meter = null;
  let txLabel = null;
  try {
    db.pragma("busy_timeout = 0");
    if (exclusive) db.pragma("locking_mode = EXCLUSIVE");
    const classified = readSchemaVersion(db);
    if (!classified.ok) return fail({ ok: false, reason: classified.reason, detail: classified.detail });
    const journal = String(db.pragma("journal_mode = WAL", { simple: true })).toLowerCase();
    const accepted = db.memory === true ? ["wal", "memory"] : ["wal"];
    if (!accepted.includes(journal)) return fail({ ok: false, reason: "JOURNAL_MODE_UNSUPPORTED", detail: journal });
    db.pragma("synchronous = NORMAL");
    if (opts.walPerTx === true && typeof opts.onTiming === "function" && db.memory !== true) {
      db.pragma("journal_size_limit = 0");
      const statWalBytes = typeof opts.statWalBytes === "function" ? opts.statWalBytes : defaultStatWalBytes;
      const walPath = `${opts.filePath}-wal`;
      const pageSize = Number(db.pragma("page_size", { simple: true }));
      if (Number.isSafeInteger(pageSize) && pageSize > 0) {
        meter = createWalMeter({ statBytes: () => statWalBytes(walPath), pageSize });
      }
    }
    if (managed) db.pragma(`wal_autocheckpoint = ${opts.walSafetyPages}`);
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${opts.busyTimeoutMs}`);
    timing("open", nowMs() - openedAt);

    const migrateAt = nowMs();
    migrated = runMigrations(db, migrations, { randomSeed });
    timing("migrate", nowMs() - migrateAt);
    if (!migrated.ok) {
      const { ok, reason, detail, version } = migrated;
      return fail({ ok, reason, ...(detail === undefined ? {} : { detail }), ...(version === undefined ? {} : { version }) });
    }

    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(WORLD_SEED_KEY);
    worldSeed = row ? row.value : undefined;
    if (!isUint32(worldSeed)) return fail({ ok: false, reason: "META_INVALID", detail: `${WORLD_SEED_KEY}=${worldSeed}` });
    totalChanges = db.prepare("SELECT total_changes()").pluck();
  } catch (err) {
    return fail({ ok: false, reason: isBusy(err) ? "DB_LOCKED" : "DB_OPEN_FAILED", detail: detailOf(err) });
  }

  const limits = Object.freeze({
    maxRowsPerTransaction: opts.maxRowsPerTransaction,
    maxWriteMsPerPass: opts.maxWriteMsPerPass,
  });
  const schemaVersion = migrated.to;
  let state = STATE_OPEN;
  let stateReason = null;
  let inTransaction = false;
  let nestedAttempted = false;
  let txSeq = 0;
  let backupInFlight = false;
  const framesEwma = managed ? opts.checkpointFramesEwma : 1;
  const wal = { rowsSinceCheckpoint: 0, framesPerRow: managed ? opts.checkpointFramesPerRowInitial : 1,
    lastCheckpointAtMs: null, lastLogFrames: null };

  const runInTransaction = db.transaction((fn, counter) => {
    const before = totalChanges.get();
    const value = fn(db);
    counter.rows = totalChanges.get() - before;
    if (nestedAttempted) throw NESTED;
    if (counter.rows > limits.maxRowsPerTransaction) throw ROW_LIMIT;
    return value;
  });

  function transaction(name, fn) {
    if (inTransaction) {
      nestedAttempted = true;
      return { ok: false, reason: "TX_NESTED" };
    }
    if (state === STATE_CLOSED) return { ok: false, reason: "STORE_CLOSED" };
    if (state === STATE_SUSPENDED) return { ok: false, reason: "STORE_SUSPENDED", detail: stateReason };
    if (typeof fn !== "function") return { ok: false, reason: "TX_FAILED", error: new TypeError("fn is not a function") };
    txSeq += 1;
    inTransaction = true;
    nestedAttempted = false;
    txLabel = null;
    const startedAt = nowMs();
    const counter = { rows: 0 };
    let result;
    try {
      const value = runInTransaction.immediate(fn, counter);
      result = { ok: true, value, rows: counter.rows };
      wal.rowsSinceCheckpoint += counter.rows;
    } catch (err) {
      if (err === NESTED || nestedAttempted) {
        result = { ok: false, reason: "TX_NESTED", rows: counter.rows };
      } else if (ABORT_SENTINELS.has(err)) {
        result = { ok: false, reason: "TX_ABORTED", rows: counter.rows, error: err };
      } else if (err === ROW_LIMIT) {
        result = { ok: false, reason: "TX_ROW_LIMIT", rows: counter.rows, limit: limits.maxRowsPerTransaction };
      } else if ((errorCode(err) || "").startsWith("SQLITE_CONSTRAINT")) {
        result = { ok: false, reason: "TX_CONSTRAINT", code: errorCode(err), error: err };
      } else {
        result = { ok: false, reason: "TX_FAILED", code: errorCode(err), error: err };
      }
    } finally {
      inTransaction = false;
      nestedAttempted = false;
    }
    result.ms = nowMs() - startedAt;
    const failure = result.reason === "TX_FAILED" || result.reason === "TX_CONSTRAINT"
      ? failureOf(result.error) : undefined;
    const perTx = meter ? { frames: meter.afterTx(), label: txLabel } : undefined;
    timing(String(name), result.ms, result.ok ? "ok" : result.reason, result.rows, undefined, failure, perTx);
    return result;
  }

  function labelTx(label) {
    if (meter === null || !inTransaction || typeof label !== "string" || !TX_LABEL_RE.test(label)) return false;
    txLabel = label;
    return true;
  }

  function checkpoint(why) {
    const reason = typeof why === "string" ? why : undefined;
    if (inTransaction) return { ok: false, reason: "TX_ACTIVE" };
    if (state === STATE_CLOSED) return { ok: false, reason: "STORE_CLOSED" };
    if (state === STATE_SUSPENDED) return { ok: false, reason: "STORE_SUSPENDED", detail: stateReason };
    const startedAt = nowMs();
    let row;
    try {
      const rows = db.pragma("wal_checkpoint(PASSIVE)");
      row = Array.isArray(rows) && rows[0] ? rows[0] : { busy: 0, log: -1, checkpointed: -1 };
    } catch (err) {
      const ms = nowMs() - startedAt;
      timing(CHECKPOINT_TIMING, ms, "failed", 0, reason);
      return { ok: false, reason: "CHECKPOINT_FAILED", detail: detailOf(err), ms };
    }
    const ms = nowMs() - startedAt;
    const logFrames = Math.max(0, Number(row.log) || 0);
    const checkpointedFrames = Math.max(0, Number(row.checkpointed) || 0);
    const busy = Number(row.busy) ? 1 : 0;
    if (meter) meter.onCheckpoint(busy === 0 && checkpointedFrames === logFrames);
    if (busy === 0 && checkpointedFrames === logFrames) {
      if (wal.rowsSinceCheckpoint > 0 && logFrames > 0) {
        const sample = logFrames / wal.rowsSinceCheckpoint;
        wal.framesPerRow = framesEwma * sample + (1 - framesEwma) * wal.framesPerRow;
      }
      wal.rowsSinceCheckpoint = 0;
      wal.lastCheckpointAtMs = nowMs();
    }
    wal.lastLogFrames = logFrames;
    timing(CHECKPOINT_TIMING, ms, busy ? "busy" : "ok", logFrames, reason);
    return { ok: true, ms, logFrames, checkpointedFrames, busy };
  }

  function getWalStatus() {
    return Object.freeze({ managed, rowsSinceCheckpoint: wal.rowsSinceCheckpoint,
      estimatedFrames: Math.round(wal.rowsSinceCheckpoint * wal.framesPerRow), framesPerRow: wal.framesPerRow,
      lastCheckpointAtMs: wal.lastCheckpointAtMs, lastLogFrames: wal.lastLogFrames,
      perTx: meter ? Object.freeze(meter.status()) : null });
  }

  function pacedOptionsValid(o) {
    const int = (v, min) => Number.isInteger(v) && v >= min;
    return int(o.minPagesPerStep, 1) && int(o.maxPagesPerStep, o.minPagesPerStep) && int(o.stepTargetMs, 1)
      && int(o.stepGapMs, 0) && int(o.governorPauseMs, 1) && int(o.maxPauseMs, 0);
  }

  function pacedBackup(destPath, o) {
    if (!pacedOptionsValid(o)) {
      return Promise.resolve({ ok: false, reason: "BACKUP_FAILED", detail: "invalid arguments" });
    }
    let opened;
    if (typeof opts.openBackupHandle !== "function") {
      opened = { ok: false, detail: "no backup handle opener" };
    } else {
      try {
        opened = opts.openBackupHandle(db, destPath, true);
      } catch (err) {
        opened = { ok: false, detail: detailOf(err) };
      }
    }
    if (!opened || opened.ok !== true || !opened.handle) {
      const detail = String((opened && opened.detail) || (opened && opened.reason) || "no handle");
      const abort = typeof o.shouldAbort === "function" ? o.shouldAbort : () => null;
      const pause = typeof o.shouldPause === "function" ? o.shouldPause : () => false;
      const shouldAbort = () => {
        const code = abort();
        if (code !== null && code !== undefined) return code;
        return pause() === true ? "GOVERNOR" : null;
      };
      return vendorBackup(destPath, { pagesPerStep: o.pagesPerStep, shouldAbort })
        .then((r) => ({ ...r, pacedFallback: detail }));
    }
    backupInFlight = true;
    let pending;
    try {
      pending = runPacedBackup(opened.handle, { pagesPerStep: o.pagesPerStep, minPagesPerStep: o.minPagesPerStep,
        maxPagesPerStep: o.maxPagesPerStep, stepTargetMs: o.stepTargetMs, stepGapMs: o.stepGapMs,
        governorPauseMs: o.governorPauseMs, maxPauseMs: o.maxPauseMs,
        shouldAbort: typeof o.shouldAbort === "function" ? o.shouldAbort : () => null,
        shouldPause: typeof o.shouldPause === "function" ? o.shouldPause : () => false,
        nowMs, setTimer: typeof o.setTimer === "function" ? o.setTimer : defaultSetTimer });
    } catch (err) {
      try {
        opened.handle.close();
      } catch (_err) {
      }
      pending = Promise.resolve({ ok: false, reason: "BACKUP_FAILED", detail: detailOf(err), paced: true });
    }
    return pending.then((result) => result, (err) => ({ ok: false, reason: "BACKUP_FAILED", detail: detailOf(err),
      paced: true })).finally(() => {
      backupInFlight = false;
    });
  }

  function backup(destPath, opts) {
    if (typeof db.backup !== "function") return Promise.resolve({ ok: false, reason: "BACKUP_UNSUPPORTED" });
    if (backupInFlight) return Promise.resolve({ ok: false, reason: "BACKUP_IN_FLIGHT" });
    if (inTransaction) return Promise.resolve({ ok: false, reason: "TX_ACTIVE" });
    if (state === STATE_CLOSED) return Promise.resolve({ ok: false, reason: "STORE_CLOSED" });
    if (state === STATE_SUSPENDED) {
      return Promise.resolve({ ok: false, reason: "STORE_SUSPENDED", detail: stateReason });
    }
    const pagesPerStep = opts && opts.pagesPerStep;
    if (typeof destPath !== "string" || destPath === "" || !Number.isInteger(pagesPerStep) || pagesPerStep < 1) {
      return Promise.resolve({ ok: false, reason: "BACKUP_FAILED", detail: "invalid arguments" });
    }
    if (opts.paced === true) return pacedBackup(destPath, opts);
    return vendorBackup(destPath, opts);
  }

  function vendorBackup(destPath, opts) {
    const pagesPerStep = opts.pagesPerStep;
    const shouldAbort = typeof opts.shouldAbort === "function" ? opts.shouldAbort : () => null;
    const abortSignal = {};
    let abortCode = null;
    const startedAt = nowMs();
    let lastAt = null;
    let steps = 0;
    let maxGapMs = 0;
    backupInFlight = true;
    let pending;
    try {
      pending = Promise.resolve(db.backup(destPath, {
        progress: (info) => {
          const at = nowMs();
          if (lastAt !== null) maxGapMs = Math.max(maxGapMs, at - lastAt);
          lastAt = at;
          steps += 1;
          const code = shouldAbort();
          if (code !== null && code !== undefined) {
            abortCode = String(code);
            throw abortSignal;
          }
          return pagesPerStep;
        },
      }));
    } catch (err) {
      pending = Promise.reject(err);
    }
    return pending.then((done) => {
      const endAt = nowMs();
      return { ok: true, totalPages: Number(done && done.totalPages) || 0, ms: endAt - startedAt, steps, maxGapMs,
        finalStepMs: endAt - (lastAt === null ? startedAt : lastAt) };
    }, (err) => {
      if (err === abortSignal) return { ok: false, reason: "BACKUP_ABORTED", code: abortCode };
      const code = errorCode(err);
      return { ok: false, reason: "BACKUP_FAILED", ...(code ? { code } : {}), detail: detailOf(err) };
    }).then((result) => {
      backupInFlight = false;
      return result;
    });
  }

  function suspend(reason) {
    if (state !== STATE_OPEN) return;
    state = STATE_SUSPENDED;
    stateReason = String(reason);
  }

  function close(why) {
    if (state === STATE_CLOSED) return { ok: true, alreadyClosed: true };
    state = STATE_CLOSED;
    stateReason = String(why);
    let closeError;
    try {
      db.close();
    } catch (err) {
      closeError = err;
    }
    if (!closeError && typeof opts.onClose === "function") {
      try {
        opts.onClose(stateReason);
      } catch (_err) {
      }
    }
    return closeError ? { ok: true, alreadyClosed: false, error: closeError } : { ok: true, alreadyClosed: false };
  }

  const store = Object.freeze({
    transaction,
    suspend,
    close,
    checkpoint,
    backup,
    getWalStatus,
    labelTx,
    isOpen: () => state !== STATE_CLOSED,
    isInTransaction: () => inTransaction,
    getTxSeq: () => txSeq,
    getState: () => state,
    getStateReason: () => stateReason,
    getWorldSeed: () => worldSeed,
    getSchemaVersion: () => schemaVersion,
    limits,
    filePath: opts.filePath,
    lockingMode: exclusive ? "exclusive" : "normal",
  });
  return { ok: true, store, schemaVersion, applied: migrated.applied, worldSeed };
}

module.exports = { openStore, CHECKPOINT_TIMING, createAbortSentinel };
