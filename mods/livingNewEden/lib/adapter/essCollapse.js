"use strict";

const crypto = require("node:crypto");

const COUNTER_NAMES = Object.freeze(["collapsed", "maintained", "failed", "retried", "gaveUp", "overflow",
  "recoverAll", "listFailed"]);
const WRAPPED = Symbol.for("livingNewEden.essCollapse");
const SETTLEMENT_SUFFIX = "/services/dynamic/essSettlementRuntime.js";
const FUNCTION_FINGERPRINTS = Object.freeze({
  handleJob: "f96fecec4659cb2fa57afcbdefe8d8ad8a470ad6",
  reconcile: "35a950192e79ae861d8dcb97a01a331f1b783ed4",
  maintain: "f4c457a0ec8f601317864d6a9dbf541a5e361863",
});
const MS_PER_SECOND = 1000;

function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function functionText(sourceText, name) {
  const text = lf(sourceText || "");
  const start = new RegExp(`^(async )?function ${escapeRegExp(name)}\\(`, "m").exec(text);
  if (!start) return null;
  const lineEnd = text.indexOf("\n", start.index);
  const line = text.slice(start.index, lineEnd === -1 ? text.length : lineEnd);
  const opens = (line.match(/\{/g) || []).length;
  if (opens > 0 && opens === (line.match(/\}/g) || []).length && line.trimEnd().endsWith("}")) return line;
  const end = /\n\}(\n|$)/g;
  end.lastIndex = start.index;
  const hit = end.exec(text);
  return hit ? text.slice(start.index, hit.index + 2) : null;
}

function checkFingerprints(sourceText) {
  if (typeof sourceText !== "string") return "source";
  for (const name of Object.keys(FUNCTION_FINGERPRINTS)) {
    const body = functionText(sourceText, name);
    if (body === null || sha1(body) !== FUNCTION_FINGERPRINTS[name]) return name;
  }
  return null;
}

function locateSrcDir(exportsObj, requireCache) {
  if (!requireCache || typeof requireCache !== "object") return null;
  for (const file of Object.keys(requireCache)) {
    const entry = requireCache[file];
    if (!entry || entry.exports !== exportsObj) continue;
    if (!file.replace(/\\/g, "/").endsWith(SETTLEMENT_SUFFIX)) continue;
    return file.slice(0, file.length - SETTLEMENT_SUFFIX.length);
  }
  return null;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function install(o) {
  const ex = o && o.settlementExports;
  const deps = (o && o.deps) || {};
  const cfg = (o && o.config) || {};
  if (!ex || typeof ex !== "object" || ["handleJob", "reconcile", "synchronize", "schedule"]
    .some((name) => typeof ex[name] !== "function")) {
    return { ok: false, reason: "missing" };
  }
  if (ex.handleJob[WRAPPED] || ex.reconcile[WRAPPED]) return { ok: false, reason: "already_wrapped" };
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const onCount = typeof deps.onCount === "function" ? deps.onCount : () => {};
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const perfNow = typeof deps.perfNow === "function" ? deps.perfNow : now;
  const setTimer = deps.setTimer;

  const totals = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let maintainMs = 0;
  const count = (name, n = 1) => {
    totals[name] += n;
    try {
      onCount(name, n);
    } catch (_err) {
    }
  };

  const drift = Object.prototype.hasOwnProperty.call(o, "sourceText") ? checkFingerprints(o.sourceText) : null;
  let state = drift === null ? "armed" : "disabled:drift";
  const pending = new Set();
  const retries = new Map();
  let recoverAllPending = false;
  let readyAt = null;
  let readyReason = null;
  let gateOpen = false;
  let running = false;
  let stopped = false;
  let firstDrainLogged = false;
  let episode = null;
  let collapsedAtDrain = 0;
  const installedAt = now();

  const disabled = () => state.startsWith("disabled:");

  const core = {
    markReady(reason) {
      if (readyAt !== null) return;
      readyAt = now();
      readyReason = String(reason || "ready");
    },
    disable(kind, detail) {
      if (disabled()) return;
      state = `disabled:${kind}`;
      log(`essCollapse: ${state} (${detail}) - vendor ESS jobs`);
    },
    state: () => state,
    stats: () => ({ pending: pending.size, collapsed: totals.collapsed, maintained: totals.maintained,
      failed: totals.failed, retried: totals.retried, gaveUp: totals.gaveUp, overflow: totals.overflow,
      recoverAll: totals.recoverAll, maintainMs }),
  };

  if (drift !== null) {
    log(`essCollapse: disabled:drift (${drift}) - vendor ESS jobs`);
    return { ok: true, core };
  }

  const originalHandleJob = ex.handleJob;
  const originalReconcile = ex.reconcile;
  const handleJob = function essHandleJobCollapsed(job) {
    if (disabled()) return originalHandleJob.apply(this, arguments);
    const id = positiveInt(job && job.payload && job.payload.systemID);
    if (id === 0) return originalHandleJob.apply(this, arguments);
    if (!pending.has(id) && pending.size >= cfg.maxPending) {
      count("overflow");
      return originalHandleJob.apply(this, arguments);
    }
    pending.add(id);
    count("collapsed");
    return Promise.resolve();
  };
  const reconcile = function essReconcileCollapsed() {
    if (disabled()) return originalReconcile.apply(this, arguments);
    recoverAllPending = true;
    count("recoverAll");
    return Promise.resolve();
  };
  Object.defineProperty(handleJob, WRAPPED, { value: originalHandleJob });
  Object.defineProperty(reconcile, WRAPPED, { value: originalReconcile });
  ex.handleJob = handleJob;
  ex.reconcile = reconcile;

  const openGate = (at) => {
    if (gateOpen) return true;
    if (readyAt !== null && at - readyAt >= cfg.startDelayMs) {
      gateOpen = true;
      if (!disabled()) state = "ready";
      log(`essCollapse: ready (${readyReason})`);
      return true;
    }
    if (at - installedAt >= cfg.maxHoldMs) {
      gateOpen = true;
      if (readyAt === null) readyAt = at;
      if (!disabled()) state = "ready";
      log("essCollapse: ready by max_hold");
      return true;
    }
    return false;
  };

  const recoverAll = () => {
    recoverAllPending = false;
    try {
      deps.recoverLosses();
    } catch (err) {
      count("failed");
      log(`essCollapse: recoverLosses failed - ${messageOf(err)}`);
    }
    let list;
    try {
      list = deps.listBankSystemIds();
    } catch (err) {
      list = { ok: false, reason: messageOf(err) };
    }
    if (!list || list.ok !== true || !Array.isArray(list.ids)) {
      count("listFailed");
      log(`essCollapse: bank list failed - ${(list && list.reason) || "no_list"} - only the job systems`);
      return;
    }
    for (const raw of list.ids) {
      const id = positiveInt(raw);
      if (id !== 0) pending.add(id);
    }
  };

  const failed = async (id, err) => {
    count("failed");
    const r = (retries.get(id) || 0) + 1;
    if (r <= cfg.maxRetries) {
      retries.set(id, r);
      count("retried");
      try {
        await ex.schedule(id, "recover", now() + cfg.retryDelayMs);
      } catch (scheduleErr) {
        log(`essCollapse: retry schedule failed system=${id} - ${messageOf(scheduleErr)}`);
      }
      return;
    }
    retries.delete(id);
    count("gaveUp");
    log(`essCollapse: gave up system=${id} after ${r} - next boot reconcile (${messageOf(err)})`);
  };

  const pumpOnce = async () => {
    if (!openGate(now())) return;
    if (recoverAllPending) recoverAll();
    const t0 = perfNow();
    let n = 0;
    while (pending.size > 0 && n < cfg.maxSystemsPerTick && perfNow() - t0 < cfg.tickBudgetMs) {
      const id = pending.values().next().value;
      pending.delete(id);
      n += 1;
      if (episode === null) episode = { startedAt: now(), maintained: 0, collapsedBase: collapsedAtDrain };
      const t1 = perfNow();
      try {
        await ex.synchronize(id);
        count("maintained");
        episode.maintained += 1;
        retries.delete(id);
      } catch (err) {
        await failed(id, err);
      }
      maintainMs += perfNow() - t1;
    }
    if (episode !== null && pending.size === 0 && !recoverAllPending) {
      if (!firstDrainLogged) {
        firstDrainLogged = true;
        const seconds = ((now() - episode.startedAt) / MS_PER_SECOND).toFixed(1);
        log(`essCollapse: drained systems=${episode.maintained} jobs=${totals.collapsed - episode.collapsedBase} `
          + `in ${seconds}s`);
      }
      collapsedAtDrain = totals.collapsed;
      episode = null;
    }
  };

  const arm = () => {
    if (stopped) return;
    if (disabled() && pending.size === 0 && !recoverAllPending) {
      stopped = true;
      return;
    }
    setTimer(step, cfg.pumpIntervalMs);
  };

  async function step() {
    if (running) return;
    running = true;
    try {
      await pumpOnce();
    } catch (err) {
      log(`essCollapse: pump step failed - ${messageOf(err)}`);
    } finally {
      running = false;
      arm();
    }
  }

  log(`essCollapse: armed pumpIntervalMs=${cfg.pumpIntervalMs} maxSystemsPerTick=${cfg.maxSystemsPerTick} `
    + `startDelayMs=${cfg.startDelayMs} maxHoldMs=${cfg.maxHoldMs}`);
  if (typeof setTimer === "function") arm();
  return { ok: true, core };
}

module.exports = { COUNTER_NAMES, FUNCTION_FINGERPRINTS, WRAPPED, checkFingerprints, functionText, locateSrcDir,
  install };
