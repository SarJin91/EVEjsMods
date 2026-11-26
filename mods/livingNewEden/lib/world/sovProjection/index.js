"use strict";

const { performance } = require("node:perf_hooks");
const { createSovBudgetFromConfig, createProjectionPacerFromConfig } = require("./budget");
const { createDeferQueue } = require("./deferQueue");
const { onControllerChanged } = require("./listener");
const { syncAll, verifyAll } = require("./sync");
const { buildSovProjectionStatusView, STATUS_VIEW_ID } = require("./statusView");
const { upsertLog, getLog } = require("./repository");
const { ACTION: SOV_ACTION, AGGREGATE: SOV_AGGREGATE, EVENT_TYPE: SOV_EVENT_TYPE, idempotencyKey, CLAIM_ACTIONS } = require("./schema");
const { STATE: SEED_STATE } = require("../controlSeed");
const { defaultSetTimer } = require("../../presence/poller");

const SEED_TERMINAL_STATES = Object.freeze([SEED_STATE.DONE, SEED_STATE.ALREADY_APPLIED, SEED_STATE.DISABLED,
  SEED_STATE.SKIPPED, SEED_STATE.FAILED, SEED_STATE.STOPPED]);

function waitForWorldSeed(deps) {
  const { world, waitMs, pollMs, setTimer, telemetry, logger, onDone } = deps;
  let timer = null;
  let finished = false;
  const seed = world && world.seed;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    onDone(result);
  };
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0
    || !seed || typeof seed.getStatus !== "function") {
    finish({ waitedMs: 0, timedOut: false, state: null });
    return { cancel() { finished = true; } };
  }
  let waitedMs = 0;
  const check = () => {
    timer = null;
    if (finished) return;
    let state = null;
    try {
      const status = seed.getStatus();
      state = status && typeof status.state === "string" ? status.state : null;
    } catch (_err) {
      state = null;
    }
    if (state === null || SEED_TERMINAL_STATES.includes(state) || waitedMs >= waitMs) {
      const timedOut = state !== null && !SEED_TERMINAL_STATES.includes(state);
      try {
        if (telemetry) {
          telemetry.observe("sovProjection.seedWaitMs", waitedMs);
          if (timedOut) telemetry.count("sovProjection.seedWaitTimeout", 1);
        }
      } catch (_err) {
      }
      if (timedOut) logger?.log?.(`[sovProjection] world seed still ${state} after ${waitedMs}ms - syncAll starts anyway`);
      finish({ waitedMs, timedOut, state });
      return;
    }
    waitedMs += pollMs;
    timer = setTimer(check, pollMs);
  };
  check();
  return {
    cancel() {
      finished = true;
      if (timer && typeof timer.cancel === "function") timer.cancel();
      timer = null;
    },
  };
}

function readFactionNames(adapter, logger) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    return r && r.ok && r.names instanceof Map ? r.names : new Map();
  } catch (err) {
    logger?.log?.(`[sovProjection] readFactionNames failed: ${err.message}`);
  }
  return new Map();
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

const STATE_READY = "ready";
const STATE_STOPPED = "stopped";
const STATE_UNAVAILABLE = "unavailable";
const SYNC_STATE = Object.freeze({ WAITING: "waiting", RUNNING: "running", DONE: "done", FAILED: "failed" });
const DEFER_MIN_RETRY_MS = 1000;
const SCAN = Object.freeze({ SYNC: "sync", VERIFY: "verify" });
const SYNC_KIND = Object.freeze({ BOOT: "boot", RESYNC: "resync" });
const DEFAULT_VERIFY_MIN_INTERVAL_MS = 600000;

function createUnavailableSovProjection(reason) {
  const refusal = Object.freeze({ ok: false, reason: String(reason) });
  return Object.freeze({
    start: () => refusal,
    stop: () => {},
    isProjecting: () => false,
    requestProject: () => Promise.resolve(refusal),
    getStatus: () => Object.freeze({ state: STATE_UNAVAILABLE, reason: refusal.reason }),
    whenReady: Promise.resolve(),
  });
}

function createSovProjectionFacade({ adapter, budget, journal, persistence, telemetry, config, clock, logger, world, virtualCorps,
  pacer = null, deferQueueDeps = null, nowMs: perfNowArg = null, getGovernor = null }) {
  const isVirtualAlliance = (allianceId) => {
    try {
      return Boolean(virtualCorps) && typeof virtualCorps.isVirtualAlliance === "function"
        && virtualCorps.isVirtualAlliance(allianceId) === true;
    } catch (_err) {
      return false;
    }
  };

  const adapterSov = adapter.getSovProjection({
    requireGame: adapter.requireGame,
    isVirtualAlliance,
    telemetry,
    config,
    clock,
    logger,
  });

  if (!adapterSov || typeof adapterSov.projectSovCall !== "function") {
    return null;
  }

  const { projectSovCall, readSovState } = adapterSov;
  const adapterRequireGame = typeof adapterSov.requireGame === "function" ? adapterSov.requireGame : adapter.requireGame;
  const store = persistence && persistence.store;
  const nowMs = () => clock.now();
  const perfNow = typeof perfNowArg === "function" ? perfNowArg : () => performance.now();
  const inFlight = new Set();
  let claimReadFailedLogged = false;
  const countMetric = (name) => {
    try {
      if (telemetry) telemetry.count(name, 1);
    } catch (_err) {
    }
  };
  const observeMetric = (name, value) => {
    try {
      if (telemetry && typeof telemetry.observe === "function") telemetry.observe(name, value);
    } catch (_err) {
    }
  };
  const gaugeMetric = (name, value) => {
    try {
      if (telemetry && typeof telemetry.gauge === "function") telemetry.gauge(name, value);
    } catch (_err) {
    }
  };

  const deferCfg = deferQueueDeps && typeof deferQueueDeps.setTimer === "function" ? deferQueueDeps : null;
  const minSpacingMs = Math.max(DEFER_MIN_RETRY_MS, Number.isFinite(deferCfg && deferCfg.minSpacingMs)
    ? deferCfg.minSpacingMs : 0);
  const failureRetryMs = deferCfg && Number.isFinite(deferCfg.failureRetryMs) ? deferCfg.failureRetryMs : DEFER_MIN_RETRY_MS;
  const maxAttempts = deferCfg && Number.isSafeInteger(deferCfg.maxAttempts) ? deferCfg.maxAttempts : 1;
  const drainMaxPerPass = deferCfg && Number.isSafeInteger(deferCfg.drainMaxPerPass) ? deferCfg.drainMaxPerPass : 1;
  const drainSliceMs = deferCfg && Number.isFinite(deferCfg.sliceMs) ? deferCfg.sliceMs : 0;
  let stopped = false;
  let draining = false;
  let vendorCalls = 0;
  const deferredInFlight = new Set();
  const queue = deferCfg ? createDeferQueue({ maxSystems: deferCfg.maxSystems, now: nowMs, setTimer: deferCfg.setTimer,
    onDue: () => { drainDeferred(); },
    onEmpty: typeof deferCfg.onQueueEmpty === "function" ? deferCfg.onQueueEmpty : undefined,
    onDrop: typeof deferCfg.onDrop === "function" ? deferCfg.onDrop : undefined }) : null;

  function deferSystem(systemId, spec) {
    if (!queue || stopped) return false;
    const r = queue.defer(systemId, spec);
    if (!r.ok) {
      if (r.reason === "DEFER_FULL") countMetric("sovProjection.deferDropped");
      return false;
    }
    if (r.added) countMetric("sovProjection.deferred");
    if (spec.failure && r.attempts > maxAttempts) {
      queue.remove(systemId);
      countMetric("sovProjection.deferGaveUp");
      logger?.log?.(`[sovProjection] gave up system ${systemId} after ${r.attempts} failed attempts: ${spec.reason}`);
      gaugeMetric("sovProjection.deferDepth", queue.size());
      queue.arm();
      return false;
    }
    gaugeMetric("sovProjection.deferDepth", queue.size());
    queue.arm();
    return true;
  }

  function settleSystem(systemId) {
    if (queue && queue.remove(systemId)) gaugeMetric("sovProjection.deferDepth", queue.size());
  }

  function readLog(systemId) {
    if (!store || typeof store.transaction !== "function") return { ok: false, reason: "NO_STORE" };
    const r = store.transaction("sovProjection.getLog", (tx) => getLog(tx, systemId));
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
    const v = r.value;
    if (v && v.ok === true) return { ok: true, log: v.value, version: v.value.version };
    if (v && v.reason === "ROW_NOT_FOUND") return { ok: true, log: null, version: 0 };
    return { ok: false, reason: (v && v.reason) || "LOG_READ_FAILED" };
  }

  let sovModulesPromise = null;
  function getSovModules() {
    if (!sovModulesPromise) {
      sovModulesPromise = (async () => {
        const rules = await adapterRequireGame("services/sovereignty/sovSystemRules");
        if (!rules.ok) throw new Error(rules.reason);
        const state = await adapterRequireGame("services/sovereignty/sovState");
        if (!state.ok) throw new Error(state.reason);
        const gmState = await adapterRequireGame("services/sovereignty/sovGmState");
        if (!gmState.ok) throw new Error(gmState.reason);
        return { sovSystemRules: rules.exports, sovState: state.exports, sovGmState: gmState.exports };
      })().catch((err) => {
        sovModulesPromise = null;
        throw err;
      });
    }
    return sovModulesPromise;
  }

  const invaderFactionIds = new Set(
    (config?.world?.sovProjection?.invaderFactionIds ?? "500021,500026,500029")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
  );
  const { DEFAULT_INVADER_FACTION_IDS } = require("../../adapter/sovProjection");
  for (const id of DEFAULT_INVADER_FACTION_IDS) invaderFactionIds.add(id);

  async function makeDecision(systemId, modState, logRead) {
    const { sovSystemRules, sovState } = await getSovModules();

    const isClaimable = await sovSystemRules.isSovereigntyClaimableSolarSystem(systemId);
    if (!isClaimable) {
      return { action: "NONE", allianceId: null, executorCorpId: null, reason: "NOT_CLAIMABLE", skip: true, controllerFactionId: modState.controllerFactionId, phaseSeq: modState.phaseSeq };
    }

    const controllerFactionId = modState.controllerFactionId ?? null;

    if (controllerFactionId !== null && invaderFactionIds.has(controllerFactionId)) {
      return { action: "NONE", allianceId: null, executorCorpId: null, reason: "INVADER_FACTION", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
    }

    let virtualIdentity = null;
    if (controllerFactionId !== null) {
      try {
        const idResult = await virtualCorps.getFactionIdentity(controllerFactionId);
        if (idResult?.ok && idResult.allianceId && idResult.corporationIds?.[0]) {
          virtualIdentity = { allianceId: idResult.allianceId, executorCorpId: idResult.corporationIds[0] };
        }
      } catch (_err) {
      }
    }

    let evejsClaim = null;
    try {
      const claim = sovState.getSystemSovClaim ? await sovState.getSystemSovClaim(systemId) : null;
      if (claim) {
        const allianceId = claim.allianceID ?? claim.allianceId ?? null;
        const corpId = claim.corporationID ?? claim.corporationId ?? null;
        const isVirtual = allianceId !== null && allianceId > 0 && isVirtualAlliance(allianceId);
        evejsClaim = { allianceID: allianceId, corporationID: corpId, isVirtualAlliance: isVirtual };
      }
    } catch (err) {
      countMetric("sovProjection.claimReadFailed");
      if (!claimReadFailedLogged) {
        claimReadFailedLogged = true;
        logger?.log?.(`[sovProjection] getSystemSovClaim failed: ${err && err.message}`);
      }
      return { action: "NONE", allianceId: null, executorCorpId: null, reason: "CLAIM_READ_FAILED", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
    }

    const logState = logRead || readLog(systemId);
    const log = logState && logState.ok ? logState.log : null;
    const alreadySynced = Boolean(log) && log.last_controller === controllerFactionId
      && log.last_seq === modState.phaseSeq;

    if (alreadySynced) {
      return { action: "NONE", allianceId: null, executorCorpId: null, reason: "ALREADY_SYNCED", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
    }

    if (evejsClaim && evejsClaim.allianceID !== null && evejsClaim.allianceID > 0 && !evejsClaim.isVirtualAlliance) {
      return { action: "NONE", allianceId: null, executorCorpId: null, reason: "PLAYER_CLAIM_PROTECTED", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
    }

    if (controllerFactionId === null) {
      if (evejsClaim && evejsClaim.isVirtualAlliance) {
        return { action: "LOSS", allianceId: evejsClaim.allianceID, executorCorpId: evejsClaim.corporationID, reason: "CONTROLLER_LOST", skip: false, controllerFactionId, phaseSeq: modState.phaseSeq };
      }
      return { action: "NONE", allianceId: null, executorCorpId: null, reason: "NO_CLAIM", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
    }

    if (!virtualIdentity) {
      return { action: "NONE", allianceId: null, executorCorpId: null, reason: "NO_VIRTUAL_IDENTITY", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
    }

    if (evejsClaim && evejsClaim.allianceID !== null && evejsClaim.allianceID > 0) {
      if (evejsClaim.isVirtualAlliance) {
        if (evejsClaim.allianceID === virtualIdentity.allianceId) {
          return { action: "NONE", allianceId: virtualIdentity.allianceId, executorCorpId: virtualIdentity.executorCorpId, reason: "ALREADY_SYNCED", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
        }
        return { action: "TRANSFER", allianceId: virtualIdentity.allianceId, executorCorpId: virtualIdentity.executorCorpId, reason: "CONTROLLER_TRANSFER", skip: false, controllerFactionId, phaseSeq: modState.phaseSeq };
      }
      return { action: "NONE", allianceId: null, executorCorpId: null, reason: "PLAYER_CLAIM_PROTECTED", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
    }

    if (typeof readSovState === "function") {
      let hub = null;
      try {
        hub = await readSovState(systemId);
      } catch (_err) {
        hub = null;
      }
      if (!hub || hub.ok !== true) {
        countMetric("sovProjection.claimReadFailed");
        return { action: "NONE", allianceId: null, executorCorpId: null, reason: "CLAIM_READ_FAILED", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
      }
      if (hub.playerHub === true) {
        return { action: "NONE", allianceId: null, executorCorpId: null, reason: "PLAYER_CLAIM_PROTECTED", skip: true, controllerFactionId, phaseSeq: modState.phaseSeq };
      }
    }

    return { action: "GAIN", allianceId: virtualIdentity.allianceId, executorCorpId: virtualIdentity.executorCorpId, reason: "CONTROLLER_GAINED", skip: false, controllerFactionId, phaseSeq: modState.phaseSeq };
  }

  async function projectSystem(systemId, decision, modState) {
    if (inFlight.has(systemId)) {
      countMetric("sovProjection.inFlight");
      const queued = deferSystem(systemId, { dueAt: nowMs() + minSpacingMs, reason: "IN_FLIGHT" });
      if (queued) deferredInFlight.add(systemId);
      return queued ? { ok: true, action: "NONE", skipped: true, reason: "IN_FLIGHT", deferred: true }
        : { ok: true, action: "NONE", skipped: true, reason: "IN_FLIGHT" };
    }
    inFlight.add(systemId);
    let result;
    try {
      result = await projectOnce(systemId, decision, modState);
    } catch (err) {
      logger?.error?.(`[sovProjection] projectSystem(${systemId}) threw: ${err && err.message}`);
      result = { ok: false, reason: `PROJECT_SYSTEM_THREW: ${err && err.message}`, permanent: false };
    } finally {
      inFlight.delete(systemId);
    }
    const requestedDuringFlight = deferredInFlight.delete(systemId);
    if (result && result.deferred !== true && !(result.ok === false && (result.reason === "BUDGET_EXCEEDED"
      || result.reason === "PROJECTION_PACED"))) {
      if (result.ok === true || result.permanent === true) {
        if (!requestedDuringFlight) settleSystem(systemId);
      } else {
        deferSystem(systemId, { dueAt: nowMs() + failureRetryMs, reason: String(result.reason || "FAILED"), failure: true });
      }
    }
    return result;
  }

  function repairLog(systemId, decision, logState, action = SOV_ACTION.SYNC) {
    const log = logState.log;
    const phaseSeq = decision.phaseSeq ?? 0;
    if (log && log.last_controller === decision.controllerFactionId && log.last_alliance === decision.allianceId
      && log.last_seq === phaseSeq) {
      return null;
    }
    const repairType = action === SOV_ACTION.LOSS ? "lossRepair" : "syncRepair";
    const tx = store.transaction(`sovProjection.${repairType}`, (db) => upsertLog(db, {
      systemId, controller: decision.controllerFactionId ?? null, alliance: decision.allianceId ?? null,
      corp: decision.executorCorpId ?? null, action, seq: phaseSeq,
      expectedVersion: logState.version, now: nowMs(),
    }));
    if (!tx || tx.ok !== true) return { ok: false, reason: (tx && tx.reason) || "TX_FAILED", permanent: false };
    if (!tx.value || tx.value.ok !== true) {
      return { ok: false, reason: (tx.value && tx.value.reason) || "SYNC_REFUSED", permanent: false };
    }
    countMetric(`sovProjection.${repairType}`);
    return { ok: true, action, reason: action === SOV_ACTION.LOSS ? "NO_CLAIM" : "ALREADY_SYNCED", skipped: true };
  }

  async function projectOnce(systemId, decision, modState) {
    if (!decision) {
      if (!modState) {
        if (!world || typeof world.getSystem !== "function") {
          return { ok: false, reason: "NO_WORLD_FOR_DECISION", permanent: false };
        }
        const sysResult = world.getSystem(systemId, { includeInfluence: false });
        if (!sysResult.ok || !sysResult.system) {
          return { ok: false, reason: "SYSTEM_NOT_FOUND", permanent: false };
        }
        const sys = sysResult.system;
        modState = {
          controllerFactionId: sys.controllerFactionId,
          occupationState: sys.occupationState,
          phaseSeq: sys.phaseSeq,
          capturedAt: sys.capturedAt,
        };
      }
    }

    if (!store || typeof store.transaction !== "function") {
      return { ok: false, reason: "NO_STORE", permanent: false };
    }
    const logState = readLog(systemId);
    if (!logState.ok) return { ok: false, reason: logState.reason, permanent: false };

    if (!decision) decision = await makeDecision(systemId, modState, logState);

    if (decision.skip) {
      if (decision.reason === "ALREADY_SYNCED" && decision.allianceId && decision.controllerFactionId !== null
        && decision.controllerFactionId !== undefined) {
        const repaired = repairLog(systemId, decision, logState);
        if (repaired) return repaired;
      }
      if (decision.reason === "NO_CLAIM" && decision.controllerFactionId === null
        && logState.log && CLAIM_ACTIONS.includes(logState.log.last_action)) {
        const lossDecision = { ...decision, controllerFactionId: null, allianceId: null, executorCorpId: null };
        const repaired = repairLog(systemId, lossDecision, logState, SOV_ACTION.LOSS);
        if (repaired) return repaired;
      }
      return { ok: true, action: decision.action, reason: decision.reason, skipped: true };
    }

    const paced = pacer ? pacer.check() : { ok: true };
    if (!paced.ok) {
      countMetric("sovProjection.paced");
      const queued = deferSystem(systemId, { dueAt: paced.retryAt, reason: "PROJECTION_PACED" });
      return { ok: false, skipped: true, deferred: queued, reason: "PROJECTION_PACED", retryAt: paced.retryAt, permanent: false };
    }

    const budgetResult = budget?.tryConsume?.(systemId) ?? { ok: true };
    if (!budgetResult.ok) {
      countMetric("sovProjection.budgetExceeded");
      const retryAt = nowMs() + (Number.isFinite(budgetResult.retryAfterMs) ? budgetResult.retryAfterMs : minSpacingMs);
      const queued = deferSystem(systemId, { dueAt: retryAt, reason: "BUDGET_EXCEEDED" });
      return { ok: false, skipped: true, deferred: queued, reason: "BUDGET_EXCEEDED", retryAt, permanent: false };
    }

    vendorCalls += 1;
    const t0 = perfNow();
    let vendor;
    try {
      vendor = await projectSovCall(systemId, decision.action, decision.allianceId, decision.executorCorpId);
    } finally {
      const vendorMs = Math.max(0, perfNow() - t0);
      if (pacer) pacer.record(vendorMs);
      observeMetric("sovProjection.vendorMs", vendorMs);
    }
    if (!vendor || vendor.ok !== true) {
      return { ok: false, reason: (vendor && vendor.reason) || "SOV_CALL_FAILED", permanent: Boolean(vendor && vendor.permanent) };
    }
    if (vendor.skipped) return { ok: true, action: vendor.action, reason: vendor.reason, skipped: true };

    const phaseSeq = decision.phaseSeq ?? 0;
    const controller = decision.controllerFactionId ?? null;
    const alliance = decision.allianceId ?? null;
    const corp = decision.executorCorpId ?? null;
    const key = idempotencyKey(systemId, phaseSeq, decision.action, logState.version);
    const tx = store.transaction("sovProjection.commit", (db) => journal.applyOnce(db, {
      key,
      aggregate: { type: SOV_AGGREGATE, id: systemId },
      eventType: SOV_EVENT_TYPE,
      payload: { systemId, action: decision.action, allianceId: alliance, corpId: corp,
        controllerFactionId: controller, phaseSeq },
    }, (inner) => upsertLog(inner, { systemId, controller, alliance, corp, action: decision.action, seq: phaseSeq,
      expectedVersion: logState.version, now: nowMs() })));
    if (!tx || tx.ok !== true) return { ok: false, reason: (tx && tx.reason) || "TX_FAILED", permanent: false };
    const applied = tx.value;
    if (!applied || applied.ok !== true) {
      const refusal = applied && applied.reason === "APPLY_REFUSED" && applied.refusal ? applied.refusal.reason : null;
      return { ok: false, reason: refusal || (applied && applied.reason) || "COMMIT_FAILED", permanent: false };
    }
    if (applied.duplicate) return { ok: true, action: "NONE", reason: "ALREADY_SYNCED", skipped: true };
    return { ok: true, action: decision.action, reason: null, skipped: false };
  }

  async function drainDeferred() {
    if (!queue || stopped || draining) return { ok: true, ran: 0 };
    draining = true;
    let ran = 0;
    let notBefore;
    try {
      let governor = null;
      try {
        governor = typeof getGovernor === "function" ? getGovernor() : null;
      } catch (_err) {
        governor = null;
      }
      if (governor && typeof governor.admits === "function" && governor.admits("OPERATIONAL") === false) {
        countMetric("sovProjection.deferHeld");
        notBefore = nowMs() + minSpacingMs;
        return { ok: true, ran: 0, held: true };
      }
      const t0 = perfNow();
      const ids = queue.takeDue(nowMs(), drainMaxPerPass);
      for (const systemId of ids) {
        if (stopped) break;
        if (!queue.has(systemId)) continue;
        const callsBefore = vendorCalls;
        const result = await projectSystem(systemId);
        ran += 1;
        if (!queue.has(systemId) && result && (result.ok === true || result.permanent === true)) {
          countMetric("sovProjection.deferDrained");
        }
        if (result && result.ok === false && (result.reason === "PROJECTION_PACED" || result.reason === "BUDGET_EXCEEDED")) {
          notBefore = result.retryAt;
          break;
        }
        if (vendorCalls !== callsBefore) {
          if (pacer) notBefore = pacer.getStatus().nextAllowedAt;
          break;
        }
        if (perfNow() - t0 >= drainSliceMs) break;
      }
    } catch (err) {
      logger?.log?.(`[sovProjection] drainDeferred failed: ${err && err.message}`);
    } finally {
      draining = false;
      try {
        if (!stopped) queue.arm(Number.isFinite(notBefore) ? { notBefore } : undefined);
      } catch (_err) {
      }
    }
    return { ok: true, ran };
  }

  function getDeferStatus() {
    const base = queue ? queue.getStatus() : { depth: 0, nextDueAt: null, oldestAt: null, dropped: 0, armedAt: null };
    return Object.freeze({ ...base, enabled: Boolean(queue), draining });
  }

  function dispose() {
    stopped = true;
    deferredInFlight.clear();
    if (queue) queue.clear();
  }

  return Object.freeze({
    projectSystem,
    drainDeferred,
    getDeferStatus,
    getPacerStatus: () => (pacer ? pacer.getStatus() : null),
    dispose,
    isProjecting: (systemId) => inFlight.has(systemId),
    requireGame: adapterRequireGame,
    isVirtualAlliance,
    readSovState,
    budget,
    makeDecision,
  });
}

function startSovProjection(ctx) {
  try {
    const {
      config,
      persistence,
      adapter,
      virtualCorps,
      occupation,
      world,
      telemetry,
      logger,
      clock,
      getGovernor,
      fail,
    } = ctx;

    const { isModuleEnabled } = require("../../../config");
    if (!isModuleEnabled(config, "sovProjection")) {
      return { ok: false, reason: "disabled_by_config" };
    }

    const processRole = adapter && typeof adapter.getProcessRole === "function"
      ? adapter.getProcessRole()
      : "unknown";
    if (processRole !== "world") {
      return { ok: false, reason: "not_world_process" };
    }

    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!adapter || typeof adapter.getSovProjection !== "function") {
      return { ok: false, reason: "dependency_disabled:adapter" };
    }
    if (!virtualCorps || typeof virtualCorps.getFactionIdentity !== "function" || typeof virtualCorps.whenReady !== "function") {
      return { ok: false, reason: "dependency_disabled:virtualCorps" };
    }
    if (!occupation || typeof occupation.registerOnControllerChanged !== "function") {
      return { ok: false, reason: "dependency_disabled:occupation" };
    }
    if (!world || typeof world.listSystems !== "function") {
      return { ok: false, reason: "dependency_disabled:world" };
    }
    if (!telemetry) {
      return { ok: false, reason: "dependency_disabled:telemetry" };
    }

    const budget = createSovBudgetFromConfig(config, clock.now);
    const sovCfg = (config && config.world && config.world.sovProjection) || {};
    const setTimer = typeof ctx.setTimer === "function" ? ctx.setTimer : defaultSetTimer;
    const perfNow = typeof ctx.nowMs === "function" ? ctx.nowMs : () => performance.now();
    const pacer = createProjectionPacerFromConfig(config, clock.now);

    const sovProjectionFacade = createSovProjectionFacade({
      pacer,
      deferQueueDeps: { setTimer, maxSystems: sovCfg.deferMaxSystems ?? 4096,
        failureRetryMs: sovCfg.deferFailureRetryMs ?? 60000, maxAttempts: sovCfg.deferMaxAttempts ?? 5,
        drainMaxPerPass: sovCfg.deferDrainMaxPerPass ?? 16, sliceMs: sovCfg.syncSliceMs ?? 4,
        minSpacingMs: sovCfg.projectionMinSpacingMs ?? 5000,
        onQueueEmpty: () => onQueueEmpty(), onDrop: () => onDeferFull() },
      nowMs: perfNow,
      getGovernor: typeof getGovernor === "function" ? getGovernor : null,
      adapter,
      budget,
      journal: persistence.journal,
      persistence,
      telemetry,
      config,
      clock,
      logger,
      world,
      virtualCorps,
    });

    if (!sovProjectionFacade || typeof sovProjectionFacade.projectSystem !== "function") {
      return { ok: false, reason: "SOV_PROJECTION_UNAVAILABLE" };
    }

    const prevCallback = occupation.registerOnControllerChanged((change) => {
      onControllerChanged(change, {
        sovProjection: sovProjectionFacade,
        adapter,
        logger,
        telemetry,
      });
    });

    let stopped = false;
    let seedWait = null;
    let syncState = SYNC_STATE.WAITING;
    let scanRunning = null;
    let resyncNeeded = false;
    let lastSync = null;
    let lastVerify = null;
    let lastVerifyAt = null;
    let viewRegistration = null;
    const verifyAfterDrain = sovCfg.verifyAfterDrain !== false;
    const verifyMinIntervalMs = Number.isFinite(sovCfg.verifyMinIntervalMs) ? sovCfg.verifyMinIntervalMs
      : DEFAULT_VERIFY_MIN_INTERVAL_MS;

    const service = Object.freeze({
      getStatus: () => Object.freeze({
        state: stopped ? STATE_STOPPED : STATE_READY,
        budget: budget.getStatus(),
        syncState,
        defer: sovProjectionFacade.getDeferStatus(),
        pacer: sovProjectionFacade.getPacerStatus(),
        lastSync,
        verify: lastVerify,
        resyncNeeded,
        scanning: scanRunning,
      }),
      isProjecting: (systemId) => sovProjectionFacade.isProjecting(systemId),
      requestProject: (systemId) => sovProjectionFacade.projectSystem(systemId),
      stop(reason) {
        if (stopped) return;
        stopped = true;
        if (seedWait) seedWait.cancel();
        swallow(() => sovProjectionFacade.dispose());
        if (viewRegistration) swallow(() => viewRegistration.unregister());
        viewRegistration = null;
        occupation.registerOnControllerChanged(prevCallback);
        logger?.log?.(`[sovProjection] stopped: ${reason || "unknown"}`);
      },
      isStopped: () => stopped,
    });

    ctx.sovProjection = service;

    const views = ctx.views;
    if (views && typeof views.registerView === "function") {
      try {
        const r = views.registerView(STATUS_VIEW_ID, buildSovProjectionStatusView({ getStatus: service.getStatus,
          getGovernor: typeof getGovernor === "function" ? getGovernor : null }));
        if (r && r.ok) {
          viewRegistration = r;
          logger?.log?.(`[sovProjection] view ${STATUS_VIEW_ID} registered`);
        } else {
          logger?.log?.(`[sovProjection] view ${STATUS_VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
        }
      } catch (err) {
        logger?.log?.(`[sovProjection] view ${STATUS_VIEW_ID} not registered - ${err && err.message}`);
      }
    }

    logger?.log?.(`[sovProjection] started`);

    const whenReady = virtualCorps.whenReady().then(() => {
      if (stopped) return;
      try {
        seedWait = waitForWorldSeed({ world, waitMs: sovCfg.syncSeedWaitMs, pollMs: sovCfg.syncSeedPollMs,
          setTimer, telemetry, logger,
          onDone: () => {
            try {
              if (!stopped) runSyncAll();
            } catch (err) {
              logger?.log?.(`[sovProjection] syncAll threw: ${err && err.message}`);
            }
          } });
      } catch (err) {
        logger?.log?.(`[sovProjection] seed wait failed: ${err && err.message} - syncAll starts now`);
        runSyncAll();
      }
    });

    function onDeferFull() {
      if (resyncNeeded || stopped) return;
      resyncNeeded = true;
      logger?.log?.(`[sovProjection] defer queue full - resync after the drain`);
    }

    function onQueueEmpty() {
      if (stopped) return;
      Promise.resolve().then(() => afterIdle(true)).catch((err) => {
        logger?.log?.(`[sovProjection] queue-empty handler failed: ${err && err.message}`);
      });
    }

    function afterIdle(allowVerify) {
      if (stopped || scanRunning !== null || syncState !== SYNC_STATE.DONE) return null;
      if (sovProjectionFacade.getDeferStatus().depth !== 0) return null;
      if (resyncNeeded) {
        resyncNeeded = false;
        try {
          if (telemetry) telemetry.count("sovProjection.resyncRuns", 1);
        } catch (_err) {
        }
        logger?.log?.(`[sovProjection] resync syncAll after a full defer queue`);
        return runSyncAll(SYNC_KIND.RESYNC);
      }
      if (!allowVerify || !verifyAfterDrain) return null;
      if (lastVerifyAt !== null && clock.now() - lastVerifyAt < verifyMinIntervalMs) return null;
      return runVerify();
    }

    function runVerify() {
      scanRunning = SCAN.VERIFY;
      lastVerifyAt = clock.now();
      const startedAt = lastVerifyAt;
      return verifyAll({ sovProjection: sovProjectionFacade, world, persistence, virtualCorps, config, telemetry,
        logger, clock, nowMs: perfNow, verifyMaxSamples: sovCfg.verifyMaxSamples })
        .then((r) => {
          lastVerify = r ? Object.freeze({ ...r, sample: Object.freeze([...(r.sample || [])]) })
            : Object.freeze({ ok: false, reason: "NO_RESULT", at: startedAt });
          if (lastVerify.ok) {
            logger?.log?.(`[sovProjection] verify: checked=${lastVerify.checked} matched=${lastVerify.matched} mismatched=${lastVerify.mismatched} playerProtected=${lastVerify.playerProtected} noIdentity=${lastVerify.noIdentity} invader=${lastVerify.invader} errors=${lastVerify.errors} duration=${lastVerify.durationMs}ms`);
          } else {
            logger?.log?.(`[sovProjection] verify failed: ${lastVerify.reason}`);
          }
        }, (err) => {
          lastVerify = Object.freeze({ ok: false, reason: `VERIFY_THREW: ${err && err.message}`, at: startedAt });
          logger?.log?.(`[sovProjection] verify threw: ${err && err.message}`);
        })
        .then(finishVerify, finishVerify);
    }

    function finishVerify() {
      scanRunning = null;
      try {
        afterIdle(false);
      } catch (err) {
        logger?.log?.(`[sovProjection] after-verify handler failed: ${err && err.message}`);
      }
    }

    function runSyncAll(kind) {
      syncState = SYNC_STATE.RUNNING;
      scanRunning = SCAN.SYNC;
      const syncKind = kind === SYNC_KIND.RESYNC ? SYNC_KIND.RESYNC : SYNC_KIND.BOOT;
      let recorded = false;
      return syncAll({
        sovProjection: sovProjectionFacade,
        world: world,
        persistence: persistence,
        virtualCorps,
        config,
        telemetry,
        logger,
        clock,
        fail,
        nowMs: perfNow,
      }).then((syncResult) => {
        lastSync = Object.freeze({ ...syncResult, kind: syncKind, at: clock.now() });
        recorded = true;
        syncState = syncResult && syncResult.ok ? SYNC_STATE.DONE : SYNC_STATE.FAILED;
        if (syncResult.ok) {
          logger?.log?.(
            `[sovProjection] syncAll complete: processed=${syncResult.processed} deferred=${syncResult.deferred} skipped=${syncResult.skipped} failed=${syncResult.failed} yields=${syncResult.yields} maxSliceMs=${Math.round(syncResult.maxSliceMs)} duration=${syncResult.durationMs}ms`
          );
        } else {
          logger?.log?.(`[sovProjection] syncAll failed: ${syncResult.reason}`);
          if (typeof fail === "function") {
            fail("syncAll_failed", syncResult.reason);
          }
        }
      }).catch((err) => {
        syncState = SYNC_STATE.FAILED;
        if (!recorded) {
          lastSync = Object.freeze({ ok: false, reason: `SYNC_THREW: ${err && err.message}`, kind: syncKind,
            at: clock.now() });
        }
        logger?.log?.(`[sovProjection] syncAll threw: ${err.message}`);
        if (typeof fail === "function") {
          fail("syncAll_threw", err.message);
        }
      }).then(finishSync, finishSync);
    }

    function finishSync() {
      scanRunning = null;
      try {
        afterIdle(true);
      } catch (err) {
        logger?.log?.(`[sovProjection] after-sync handler failed: ${err && err.message}`);
      }
    }

    return { ok: true, whenReady, service };
  } catch (err) {
    return { ok: false, reason: "SOV_PROJECTION_START_FAILED", detail: String(err) };
  }
}

function stopSovProjection(ctx) {
  const service = ctx.sovProjection;
  if (service && typeof service.stop === "function") {
    service.stop("service_stop");
  }
  ctx.sovProjection = null;
}

module.exports = {
  startSovProjection,
  stopSovProjection,
  createUnavailableSovProjection,
  readFactionNames,
  createSovProjectionFacade,
  waitForWorldSeed,
  SEED_TERMINAL_STATES,
};