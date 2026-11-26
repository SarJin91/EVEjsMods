"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { defaultSetTimer } = require("./checkpointer");
const { isInside } = require("../util/paths");
const { COUNT_NAMES, HEADER_BYTES, TMP_SUFFIX, formatBackupName, isBackupTmpName, planRotation, decideBackup,
  checkHeader, requiredFreeBytes } = require("./backupRules");

const STATE = Object.freeze({ IDLE: "idle", RUNNING: "running", STOPPED: "stopped", UNAVAILABLE: "unavailable" });
const DEFAULT_DIR_NAME = "backups";
const DEFERRING_MODES = Object.freeze(["SHED", "OVERLOADED"]);
const MAINTENANCE = "MAINTENANCE";
const MS_PER_SECOND = 1000;
const MIN_TIMER_MS = 1;
const SETTING_KEYS = Object.freeze(["intervalMs", "startDelayMs", "pollMs", "retryMs", "pagesPerStep", "maxRunMs",
  "keep", "freeSpaceFactor", "minFreeMb", "pruneToolCopiesDays",
  "stepGapMs", "stepTargetMs", "minPagesPerStep", "maxPagesPerStep", "governorPauseMs", "maxPauseMs"]);
const METRIC_PACED_FALLBACK = "persistence.backup.pacedFallback";

const METRIC_OK = "persistence.backup.ok";
const METRIC_FAILED = "persistence.backup.failed";
const METRIC_DEFERRED = "persistence.backup.deferred";
const METRIC_ABORTED = "persistence.backup.aborted";
const METRIC_NO_SPACE = "persistence.backup.noSpace";
const METRIC_BY_COUNT = Object.freeze({ ok: METRIC_OK, failed: METRIC_FAILED, deferred: METRIC_DEFERRED,
  aborted: METRIC_ABORTED, noSpace: METRIC_NO_SPACE });

function noop() {}

function codeOf(err) {
  return err && typeof err.code === "string" ? err.code : "ERROR";
}

function createUnavailableBackup(reason, detail) {
  const status = Object.freeze({ state: STATE.UNAVAILABLE, reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({
    getStatus: () => status,
    runNow: () => Promise.resolve({ ok: false, reason: String(reason) }),
    stop() {},
  });
}

function startBackup(deps) {
  try {
    const config = deps && deps.config;
    const settings = config && config.backup;
    if (!settings || settings.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    const store = deps.persistence && deps.persistence.store;
    if (!store || typeof store.backup !== "function" || typeof store.filePath !== "string") {
      return { ok: false, reason: "PERSISTENCE_UNAVAILABLE" };
    }
    if (typeof config.dataDir !== "string" || config.dataDir === "") {
      return { ok: false, reason: "DATA_DIR_UNAVAILABLE", detail: "no dataDir" };
    }
    const dir = settings.dir ? settings.dir : path.join(config.dataDir, DEFAULT_DIR_NAME);
    if (!path.isAbsolute(dir)) return { ok: false, reason: "BACKUP_DIR_INVALID", detail: "not absolute" };
    if (typeof deps.modDir === "string" && deps.modDir !== "" && isInside(deps.modDir, dir)) {
      return { ok: false, reason: "BACKUP_DIR_IN_MOD_DIR" };
    }
    for (const key of SETTING_KEYS) {
      if (typeof settings[key] !== "number" || !Number.isFinite(settings[key])) {
        return { ok: false, reason: "BACKUP_START_FAILED", detail: `backup.${key}` };
      }
    }
    return { ok: true, backup: createBackupService(deps, store, settings, path.resolve(dir)) };
  } catch (err) {
    return { ok: false, reason: "BACKUP_START_FAILED", detail: String((err && err.message) || err) };
  }
}

function createBackupService(deps, store, s, dir) {
  const fsApi = deps.fsApi || fs.promises;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer;
  const wallNow = typeof deps.wallNow === "function" ? deps.wallNow : () => Date.now();
  const perfNow = typeof deps.perfNow === "function" ? deps.perfNow : () => performance.now();
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const telemetry = deps.telemetry || null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const dbPath = path.resolve(store.filePath);
  const dbDir = path.dirname(dbPath);
  const dbFile = path.basename(dbPath);
  const sameDir = dbDir === dir;
  const counts = Object.fromEntries(COUNT_NAMES.map((k) => [k, 0]));
  const logged = new Set();
  const startedAtMs = wallNow();
  let state = STATE.IDLE;
  let timer = null;
  let lastResult = null;
  let lastOkAtMs = null;
  let lastFailAtMs = null;
  let consecutiveFailures = 0;
  let files = { files: 0, totalBytes: 0, toolCopies: 0, toolCopiesBytes: 0 };
  let inPoll = false;
  let watchdog = null;

  function swallow(fn) {
    try {
      fn();
    } catch (_err) {
    }
  }
  const count = (name) => {
    counts[name] += 1;
    if (telemetry) swallow(() => telemetry.count(METRIC_BY_COUNT[name], 1));
  };
  const gauge = (fn) => {
    if (telemetry) swallow(() => fn(telemetry));
  };
  function logOnce(key, line) {
    if (logged.has(key)) return;
    logged.add(key);
    logger.log(line);
  }
  function scrub(text) {
    let out = String(text === undefined || text === null ? "" : text);
    for (const p of [dir, dbDir]) out = out.split(p).join(path.basename(p));
    return out;
  }

  gauge((t) => {
    t.gauge("persistence.backup.enabled", 1);
    t.count(METRIC_OK, 0);
    t.count(METRIC_FAILED, 0);
    t.count(METRIC_DEFERRED, 0);
    t.count(METRIC_ABORTED, 0);
    t.count(METRIC_NO_SPACE, 0);
  });

  function cancelTimer() {
    if (timer === null) return;
    const handle = timer;
    timer = null;
    swallow(() => handle.cancel());
  }

  function schedule(ms) {
    cancelTimer();
    if (state === STATE.STOPPED) return;
    try {
      timer = setTimer(() => {
        timer = null;
        poll();
      }, Math.max(MIN_TIMER_MS, ms));
    } catch (err) {
      timer = null;
      stop(`TIMER_FAILED (${codeOf(err)})`);
    }
  }

  async function unlinkQuiet(full, key) {
    try {
      await fsApi.unlink(full);
      return true;
    } catch (err) {
      if (codeOf(err) !== "ENOENT") logOnce(`UNLINK_${key}`, `backup: unlink failed - ${codeOf(err)} file=${path.basename(full)}`);
      return false;
    }
  }

  async function listing(full, where) {
    const out = [];
    let names;
    try {
      names = await fsApi.readdir(full);
    } catch (err) {
      if (codeOf(err) === "ENOENT") return out;
      throw err;
    }
    for (const name of names) {
      let bytes = 0;
      try {
        const st = await fsApi.stat(path.join(full, name));
        if (!st.isFile()) continue;
        bytes = Number(st.size) || 0;
      } catch (_err) {
        continue;
      }
      out.push(where ? { name, bytes, where } : { name, bytes });
    }
    return out;
  }

  async function plan(nowMs, protect) {
    const entries = sameDir ? await listing(dir, null)
      : (await listing(dir, "backups")).concat(await listing(dbDir, "db"));
    const p = planRotation(entries, { keep: s.keep, pruneToolCopiesDays: s.pruneToolCopiesDays, nowMs, dbFile,
      protect: protect || [] });
    files = { files: p.backups.length, totalBytes: p.backups.reduce((a, b) => a + b.bytes, 0),
      toolCopies: p.toolCopies.length, toolCopiesBytes: p.toolCopies.reduce((a, b) => a + b.bytes, 0) };
    gauge((t) => {
      t.gauge("persistence.backup.files", files.files);
      t.gauge("persistence.backup.totalBytes", files.totalBytes);
      t.gauge("persistence.backup.toolCopies", files.toolCopies);
      t.gauge("persistence.backup.toolCopiesBytes", files.toolCopiesBytes);
      if (p.newestAtMs !== null) {
        t.gauge("persistence.backup.lastOkAgeSeconds", Math.max(0, Math.round((nowMs - p.newestAtMs) / MS_PER_SECOND)));
      }
    });
    return p;
  }

  async function rotate(p) {
    let deleted = 0;
    for (const name of p.deleteBackups) if (await unlinkQuiet(path.join(dir, name), "ROTATE")) deleted += 1;
    for (const name of p.deleteToolCopies) if (await unlinkQuiet(path.join(dbDir, name), "TOOL_COPY")) deleted += 1;
    return deleted;
  }

  function governorPolicy() {
    try {
      const gov = getGovernor();
      if (!gov || typeof gov.getPolicy !== "function") return null;
      const policy = gov.getPolicy();
      return policy && typeof policy.mode === "string" ? policy : null;
    } catch (_err) {
      return null;
    }
  }

  function admission() {
    const policy = governorPolicy();
    if (!policy) return null;
    const entry = policy.classes && policy.classes[MAINTENANCE];
    return { admitted: Boolean(entry && entry.admitted === true) && !DEFERRING_MODES.includes(policy.mode) };
  }

  async function statSize(full) {
    try {
      return Number((await fsApi.stat(full)).size) || 0;
    } catch (_err) {
      return 0;
    }
  }

  async function freeBytes() {
    if (typeof fsApi.statfs !== "function") return null;
    const sf = await fsApi.statfs(dir);
    return Number(sf.bavail) * Number(sf.bsize);
  }

  async function verify(tmpPath, totalPages) {
    const head = Buffer.alloc(HEADER_BYTES);
    const fh = await fsApi.open(tmpPath, "r");
    try {
      await fh.read(head, 0, HEADER_BYTES, 0);
    } finally {
      await fh.close();
    }
    const size = Number((await fsApi.stat(tmpPath)).size) || 0;
    return checkHeader(head, size, totalPages);
  }

  function settleFailure(input, inputKind) {
    let result = input;
    let kind = inputKind;
    if (state === STATE.STOPPED && kind !== "deferred") {
      result = { ok: false, reason: "BACKUP_ABORTED", code: "STOPPING",
        cause: input.code ? `${input.reason}:${input.code}` : String(input.reason) };
      kind = "deferred";
    }
    lastResult = Object.freeze({ ...result, atMs: wallNow() });
    lastFailAtMs = wallNow();
    if (kind === "deferred") {
      count("deferred");
      logOnce(`DEFERRED_${result.code || result.reason}`, `backup: deferred - ${result.code || result.reason}`);
      return lastResult;
    }
    if (kind === "store") {
      count("aborted");
      stop(result.code || result.reason);
      return lastResult;
    }
    if (kind === "timeout") count("aborted");
    if (kind === "noSpace") count("noSpace");
    count("failed");
    consecutiveFailures += 1;
    const key = result.code ? `${result.reason}:${result.code}` : result.reason;
    logOnce(key, `backup: failed - ${key}${result.detail ? ` (${scrub(result.detail)})` : ""}`);
    return lastResult;
  }

  function kindOf(r) {
    if (r.reason === "BACKUP_ABORTED") {
      if (r.code === "GOVERNOR" || r.code === "STOPPING") return "deferred";
      if (r.code === "STORE") return "store";
      if (r.code === "TIMEOUT") return "timeout";
      return "failed";
    }
    if (r.reason === "STORE_CLOSED" || r.reason === "STORE_SUSPENDED") return "store";
    return "failed";
  }

  function endWatchdog(result) {
    if (watchdog === null) return;
    const w = watchdog;
    watchdog = null;
    if (w.handle !== null) swallow(() => w.handle.cancel());
    w.resolve(result);
  }

  async function guardedBackup(tmpPath, shouldAbort, shouldPause) {
    const options = s.paced === true
      ? { pagesPerStep: s.pagesPerStep, shouldAbort, paced: true, shouldPause, minPagesPerStep: s.minPagesPerStep,
        maxPagesPerStep: s.maxPagesPerStep, stepTargetMs: s.stepTargetMs, stepGapMs: s.stepGapMs,
        governorPauseMs: s.governorPauseMs, maxPauseMs: s.maxPauseMs }
      : { pagesPerStep: s.pagesPerStep, shouldAbort };
    let pending;
    try {
      pending = Promise.resolve(store.backup(tmpPath, options))
        .catch((err) => ({ ok: false, reason: "BACKUP_FAILED", code: codeOf(err) }));
    } catch (err) {
      return { ok: false, reason: "BACKUP_FAILED", code: codeOf(err) };
    }
    const guard = new Promise((resolve) => {
      const w = { resolve, handle: null };
      watchdog = w;
      try {
        w.handle = setTimer(() => {
          w.handle = null;
          if (watchdog === w) endWatchdog({ ok: false, reason: "BACKUP_ABORTED", code: "TIMEOUT", detail: "no settle" });
        }, Math.max(MIN_TIMER_MS, s.maxRunMs));
      } catch (_err) {
      }
    });
    if (state === STATE.STOPPED) endWatchdog({ ok: false, reason: "BACKUP_ABORTED", code: "STOPPING" });
    const r = await Promise.race([pending.then((v) => ({ v, own: true })), guard.then((v) => ({ v, own: false }))]);
    if (r.own) {
      endWatchdog(null);
      return r.v;
    }
    pending.then(() => unlinkQuiet(tmpPath, "TMP_LATE"));
    return r.v;
  }

  async function copy(nowMs) {
    const dbBytes = await statSize(dbPath);
    const walBytes = await statSize(`${dbPath}-wal`);
    let free;
    try {
      free = await freeBytes();
    } catch (err) {
      return settleFailure({ ok: false, reason: "BACKUP_NO_SPACE_CHECK", code: codeOf(err) }, "failed");
    }
    if (free === null) return settleFailure({ ok: false, reason: "BACKUP_NO_SPACE_CHECK" }, "failed");
    const need = requiredFreeBytes(dbBytes, walBytes, s.freeSpaceFactor, s.minFreeMb);
    if (!(free >= need)) {
      return settleFailure({ ok: false, reason: "BACKUP_NO_SPACE", detail: `free=${free} need=${need}` }, "noSpace");
    }
    const finalName = formatBackupName(nowMs);
    const finalPath = path.join(dir, finalName);
    try {
      await fsApi.stat(finalPath);
      return { ok: false, reason: "NOT_DUE" };
    } catch (_err) {
    }
    const tmpPath = `${finalPath}${TMP_SUFFIX}`;
    const t0 = perfNow();
    const paced = s.paced === true;
    const shouldAbort = () => {
      if (state === STATE.STOPPED) return "STOPPING";
      if (typeof store.getState === "function" && store.getState() !== "open") return "STORE";
      if (perfNow() - t0 > s.maxRunMs) return "TIMEOUT";
      if (paced) return null;
      const policy = governorPolicy();
      if (policy && DEFERRING_MODES.includes(policy.mode)) return "GOVERNOR";
      return null;
    };
    const shouldPause = () => {
      const policy = governorPolicy();
      return Boolean(policy && DEFERRING_MODES.includes(policy.mode));
    };
    const r = await guardedBackup(tmpPath, shouldAbort, shouldPause);
    if (r && typeof r.pacedFallback === "string") {
      if (telemetry) swallow(() => telemetry.count(METRIC_PACED_FALLBACK, 1));
      logOnce("PACED_FALLBACK", `backup: paced unavailable - ${scrub(r.pacedFallback)}, using vendor loop`);
    }
    if (!r || !r.ok) {
      await unlinkQuiet(tmpPath, "TMP");
      return settleFailure(r || { ok: false, reason: "BACKUP_FAILED" }, kindOf(r || {}));
    }
    let deleted = 0;
    let bytes = 0;
    try {
      const header = await verify(tmpPath, r.totalPages);
      if (!header.ok) {
        await unlinkQuiet(tmpPath, "TMP");
        return settleFailure({ ok: false, reason: "BACKUP_VERIFY_FAILED", code: header.reason }, "failed");
      }
      bytes = header.pageSize * header.pageCount;
      await fsApi.rename(tmpPath, finalPath);
    } catch (err) {
      await unlinkQuiet(tmpPath, "TMP");
      return settleFailure({ ok: false, reason: "BACKUP_IO_FAILED", code: codeOf(err) }, "failed");
    }
    try {
      deleted = await rotate(await plan(wallNow(), [finalName]));
      await plan(wallNow());
    } catch (err) {
      logOnce(`ROTATE_${codeOf(err)}`, `backup: rotation failed - ${codeOf(err)}`);
    }
    lastOkAtMs = wallNow();
    consecutiveFailures = 0;
    count("ok");
    const ms = Math.round(perfNow() - t0);
    gauge((t) => {
      t.gauge("persistence.backup.lastBytes", bytes);
      t.gauge("persistence.backup.lastOkAgeSeconds", 0);
      t.observe("persistence.backup.durationMs", ms);
      t.observe("persistence.backup.maxGapMs", r.maxGapMs);
      t.observe("persistence.backup.finalStepMs", r.finalStepMs);
      if (r.paced === true) {
        t.observe("persistence.backup.maxStepMs", r.maxStepMs);
        t.observe("persistence.backup.pausedMs", r.pausedMs);
        t.observe("persistence.backup.pauses", r.pauses);
      }
    });
    const pacedFields = r.paced === true ? { paced: true, maxStepMs: r.maxStepMs, pauses: r.pauses,
      pausedMs: r.pausedMs, minPagesUsed: r.minPagesUsed } : {};
    lastResult = Object.freeze({ ok: true, file: finalName, pages: r.totalPages, bytes, ms, steps: r.steps,
      maxGapMs: r.maxGapMs, finalStepMs: r.finalStepMs, deleted, ...pacedFields, atMs: lastOkAtMs });
    const pacedSuffix = r.paced === true
      ? ` paced=1 maxStep=${Math.round(r.maxStepMs)} pauses=${r.pauses} minPages=${r.minPagesUsed}` : "";
    logger.log(`backup: ok file=${finalName} pages=${r.totalPages} bytes=${bytes} ms=${ms} `
      + `maxGap=${Math.round(r.maxGapMs)} finalStep=${Math.round(r.finalStepMs)} deleted=${deleted}${pacedSuffix}`);
    return lastResult;
  }

  async function poll() {
    if (state === STATE.STOPPED) return { ok: false, reason: "STOPPED" };
    if (inPoll) return { ok: false, reason: "IN_FLIGHT" };
    inPoll = true;
    let next = s.pollMs;
    try {
      await ready;
      if (state === STATE.STOPPED) return { ok: false, reason: "STOPPED" };
      const nowMs = wallNow();
      const p = await plan(nowMs);
      const d = decideBackup({ newestAtMs: p.newestAtMs, startedAtMs, nowMs, lastFailAtMs, lastOkAtMs,
        governor: admission(), inFlight: state === STATE.RUNNING }, s);
      if (!d.run) {
        next = Math.min(d.nextInMs, s.pollMs);
        return { ok: false, reason: d.reason, nextInMs: d.nextInMs };
      }
      state = STATE.RUNNING;
      try {
        return await copy(nowMs);
      } finally {
        if (state === STATE.RUNNING) state = STATE.IDLE;
      }
    } catch (err) {
      logOnce(`POLL_${codeOf(err)}`, `backup: poll failed - ${codeOf(err)}`);
      return { ok: false, reason: "POLL_FAILED", code: codeOf(err) };
    } finally {
      inPoll = false;
      schedule(next);
    }
  }

  async function init() {
    try {
      await fsApi.mkdir(dir, { recursive: true });
      for (const name of await fsApi.readdir(dir)) {
        if (isBackupTmpName(name)) await unlinkQuiet(path.join(dir, name), "ORPHAN");
      }
    } catch (err) {
      logOnce(`INIT_${codeOf(err)}`, `backup: start check failed - ${codeOf(err)}`);
    }
  }

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    cancelTimer();
    endWatchdog({ ok: false, reason: "BACKUP_ABORTED", code: "STOPPING" });
    logOnce("STOP", `backup: stopped (${scrub(reason)})`);
  }

  const ready = init();
  schedule(Math.min(s.startDelayMs, s.pollMs));

  return Object.freeze({
    getStatus: () => Object.freeze({ state, dir: path.basename(dir), lastResult, lastOkAtMs, consecutiveFailures,
      files: files.files, totalBytes: files.totalBytes, toolCopies: files.toolCopies,
      toolCopiesBytes: files.toolCopiesBytes, counts: Object.freeze({ ...counts }) }),
    runNow() {
      cancelTimer();
      return poll();
    },
    stop,
  });
}

module.exports = { startBackup, createUnavailableBackup, BACKUP_STATE: STATE };
