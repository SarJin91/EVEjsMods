"use strict";

const { performance } = require("node:perf_hooks");
const { normalizeOptions, createLoadGovernor, MODE, MODE_LEVEL, SIGNAL, WORK_CLASS } = require("./loadGovernor");
const { createPauseLedger } = require("./pauseLedger");

const MS_PER_SECOND = 1000;
const MAX_DETAIL_LENGTH = 200;
const METRIC_ESCALATION_WARNING = "governor.escalations.p95Warning";
const METRIC_ESCALATION_OVERLOAD = "governor.escalations.p95Overload";
const METRIC_ESCALATION_UNPLAYABLE = "governor.escalations.p95Unplayable";
const METRIC_ESCALATION_LATENESS_WARNING = "governor.escalations.latenessWarning";
const METRIC_ESCALATION_LATENESS_OVERLOAD = "governor.escalations.latenessOverload";
const METRIC_STEP_DOWNS = "governor.stepDowns";
const METRIC_LATENESS_PERCENT = "governor.latenessPercent";
const METRIC_EXCUSED_SAMPLES = "governor.excusedSamples";
const METRIC_EXCUSED_MS = "governor.excusedMs";
const METRIC_EXCUSE_CAPPED = "governor.excuseCapped";
const METRIC_PAUSES_RECORDED = "vendorPauses.recorded";
const METRIC_PAUSE_SUBSCRIBER_ERRORS = "vendorPauses.subscriberErrors";
const METRIC_RESIDENCY = Object.freeze({ NORMAL: "governor.residencySeconds.normal",
  CONSTRAINED: "governor.residencySeconds.constrained", OVERLOADED: "governor.residencySeconds.overloaded",
  SHED: "governor.residencySeconds.shed" });
const ESCALATION_METRIC_BY_SIGNAL = Object.freeze({
  [SIGNAL.P95]: Object.freeze({ CONSTRAINED: METRIC_ESCALATION_WARNING,
    OVERLOADED: METRIC_ESCALATION_OVERLOAD, SHED: METRIC_ESCALATION_UNPLAYABLE }),
  [SIGNAL.LATENESS]: Object.freeze({ CONSTRAINED: METRIC_ESCALATION_LATENESS_WARNING,
    OVERLOADED: METRIC_ESCALATION_LATENESS_OVERLOAD, SHED: METRIC_ESCALATION_UNPLAYABLE }),
});
const PERCENT_LOG_DECIMALS = 2;

function noop() {}

function governorOptionsFromConfig(config) {
  const g = config.governor;
  const limits = config.limits;
  const workMs = limits.maxSchedulerWorkMs;
  const jobs = limits.maxDueEventsPerPass;
  return {
    sampleCount: g.sampleCount,
    warningP95Ms: g.warningP95Ms,
    overloadP95Ms: g.overloadP95Ms,
    emergencyMs: g.emergencyMs,
    unplayableMs: g.unplayableMs,
    recoveryThresholdMs: g.recoveryThresholdMs,
    recoveryMs: g.recoverySeconds * MS_PER_SECOND,
    shedHoldMs: g.shedHoldMs,
    staleSampleMs: g.staleSampleMs,
    overloadExitP95Ms: g.overloadExitP95Ms,
    minModeHoldMs: g.minModeHoldSeconds * MS_PER_SECOND,
    shedMinHoldMs: g.shedMinHoldSeconds * MS_PER_SECOND,
    shedFastExitCooldownMs: g.shedFastExitCooldownSeconds * MS_PER_SECOND,
    signal: g.signal,
    latenessSampleCount: g.latenessSampleCount,
    latenessWarningPercent: g.latenessWarningPercent,
    latenessOverloadPercent: g.latenessOverloadPercent,
    latenessRecoveryPercent: g.latenessRecoveryPercent,
    latenessOverloadExitPercent: g.latenessOverloadExitPercent,
    budgets: {
      NORMAL: { budgetMs: workMs, maxJobs: jobs },
      CONSTRAINED: { budgetMs: Math.min(g.constrainedBudgetMs, workMs), maxJobs: Math.min(g.constrainedMaxJobs, jobs) },
      OVERLOADED: { budgetMs: Math.min(g.overloadedBudgetMs, workMs), maxJobs: Math.min(g.overloadedMaxJobs, jobs) },
    },
  };
}

function startGovernor(deps) {
  const telemetry = deps && deps.telemetry;
  if (!telemetry) return { ok: false, reason: "telemetry_unavailable" };
  const logger = deps.logger || { log: noop };
  const now = typeof deps.now === "function" ? deps.now : () => performance.now();
  let listener = null;
  let attached = false;
  let excuseSubscription = null;
  try {
    const { options, adjusted } = normalizeOptions(governorOptionsFromConfig(deps.config));
    let gov = null;
    const g = deps.config.governor;
    const excuse = { ledger: null, samples: 0, ms: 0, capped: 0, subscription: null, off: "disabled" };
    if (g.vendorPauseExcuseEnabled !== true) excuse.off = "disabled";
    else if (typeof deps.subscribeVendorPauses !== "function") excuse.off = "no_seam";
    else {
      const ledger = createPauseLedger({ maxExcuseMs: g.vendorPauseMaxExcuseMs,
        perMinute: g.vendorPauseExcusePerMinute });
      const sub = deps.subscribeVendorPauses((pause) => ledger.add(pause), { minMs: g.vendorPauseMinMs });
      if (sub && sub.ok === true) {
        excuseSubscription = sub;
        excuse.ledger = ledger;
        excuse.subscription = sub;
        excuse.off = null;
      } else {
        excuse.off = String((sub && sub.reason) || "subscribe_failed");
      }
    }
    const recordSample = (s) => {
      const atMs = Number.isFinite(s.atMs) ? s.atMs : now();
      const ledger = excuse.ledger;
      const excused = ledger !== null && typeof s.intervalMs === "number" && s.intervalMs > 0
        ? ledger.overlapMs(atMs - s.intervalMs, atMs) : 0;
      if (excused > 0) {
        if (ledger.admitExcuse(atMs)) {
          excuse.samples += 1;
          excuse.ms += excused;
          const lateness = typeof s.latenessMs === "number" ? Math.max(0, s.latenessMs - excused) : s.latenessMs;
          gov.record(Math.max(0, s.intervalMs - excused), atMs, lateness);
          return;
        }
        excuse.capped += 1;
      }
      gov.record(s.intervalMs, atMs, s.latenessMs);
    };
    let tickAvailable = telemetry.getStatus().tick !== "unavailable";
    if (tickAvailable) {
      const added = telemetry.addTickListener(recordSample);
      if (added && added.ok) listener = added;
      else tickAvailable = false;
    }
    const logMinIntervalMs = deps.config.governor.logMinIntervalSeconds * MS_PER_SECOND;
    let lastLogAtMs = -Infinity;
    let suppressed = 0;
    const logDue = (atMs) => logMinIntervalMs === 0 || atMs - lastLogAtMs >= logMinIntervalMs;
    const escalationMetric = ESCALATION_METRIC_BY_SIGNAL[options.signal];
    const graceEnd = typeof telemetry.bootGraceEndsAtMs === "function" ? telemetry.bootGraceEndsAtMs() : -Infinity;
    const startedAtMs = now();
    gov = createLoadGovernor({
      options, tickAvailable, nowMs: startedAtMs, bootGraceEndsAtMs: graceEnd,
      onModeChange(from, to, policy) {
        telemetry.count("governor.modeChanges");
        if (MODE_LEVEL[to] > MODE_LEVEL[from]) {
          if (escalationMetric[to]) telemetry.count(escalationMetric[to]);
        } else {
          telemetry.count(METRIC_STEP_DOWNS);
        }
        if (!logDue(policy.evaluatedAtMs)) {
          suppressed += 1;
          telemetry.count("governor.logSuppressed");
          return;
        }
        const st = gov ? gov.getStatus() : null;
        const reason = st && st.baseReason ? st.baseReason : policy.reason;
        const overlayText = st && st.overlay ? ` overlay=${st.overlay}` : "";
        logger.log(`governor: ${from} -> ${to} (${reason})${overlayText} p95=${policy.p95Ms}ms`
          + ` lateness=${policy.latenessPercent.toFixed(PERCENT_LOG_DECIMALS)}% latest=${policy.latestMs}ms`
          + `${suppressed > 0 ? ` suppressed=${suppressed}` : ""}`);
        lastLogAtMs = policy.evaluatedAtMs;
        suppressed = 0;
      },
    });
    telemetry.count("governor.modeChanges", 0);
    telemetry.count("governor.logSuppressed", 0);
    telemetry.count("governor.spikeSheds", 0);
    telemetry.count("governor.bootGraceSamples", 0);
    for (const name of [METRIC_ESCALATION_WARNING, METRIC_ESCALATION_OVERLOAD, METRIC_ESCALATION_UNPLAYABLE,
      METRIC_ESCALATION_LATENESS_WARNING, METRIC_ESCALATION_LATENESS_OVERLOAD, METRIC_STEP_DOWNS]) {
      telemetry.count(name, 0);
    }
    for (const name of [METRIC_EXCUSED_SAMPLES, METRIC_EXCUSED_MS, METRIC_EXCUSE_CAPPED, METRIC_PAUSES_RECORDED,
      METRIC_PAUSE_SUBSCRIBER_ERRORS]) {
      telemetry.count(name, 0);
    }
    const excuseCurrent = () => {
      const pauseStats = excuse.subscription && typeof excuse.subscription.stats === "function"
        ? excuse.subscription.stats() : null;
      return { samples: excuse.samples, ms: Math.round(excuse.ms), capped: excuse.capped,
        recorded: pauseStats ? pauseStats.recorded : 0, subscriberErrors: pauseStats ? pauseStats.subscriberErrors : 0 };
    };
    const excuseSeen = excuseCurrent();
    const publishExcuse = () => {
      const current = excuseCurrent();
      const metricOf = { samples: METRIC_EXCUSED_SAMPLES, ms: METRIC_EXCUSED_MS, capped: METRIC_EXCUSE_CAPPED,
        recorded: METRIC_PAUSES_RECORDED, subscriberErrors: METRIC_PAUSE_SUBSCRIBER_ERRORS };
      for (const key of Object.keys(current)) {
        const delta = current[key] - excuseSeen[key];
        if (delta > 0) telemetry.count(metricOf[key], delta);
        excuseSeen[key] = current[key];
      }
    };
    let spikeShedsSeen = gov.getStatus().counts.spikeSheds;
    let bootGraceSeen = gov.getStatus().counts.bootGraceSamples;

    function publish(policy) {
      telemetry.gauge("governor.mode", policy.level);
      telemetry.gauge("governor.p95Ms", policy.p95Ms);
      telemetry.gauge(METRIC_LATENESS_PERCENT, policy.latenessPercent);
      const residency = gov.getStatus().residencyMs;
      for (const mode of Object.keys(METRIC_RESIDENCY)) {
        telemetry.gauge(METRIC_RESIDENCY[mode], Math.round(residency[mode] / MS_PER_SECOND));
      }
      return policy;
    }
    publish(gov.getPolicy());

    function evaluate(nowMs) {
      const policy = gov.evaluate(nowMs === undefined ? now() : nowMs);
      const status = gov.getStatus();
      const spikes = status.counts.spikeSheds - spikeShedsSeen;
      if (spikes > 0) telemetry.count("governor.spikeSheds", spikes);
      spikeShedsSeen = status.counts.spikeSheds;
      const boot = status.counts.bootGraceSamples - bootGraceSeen;
      if (boot > 0) telemetry.count("governor.bootGraceSamples", boot);
      bootGraceSeen = status.counts.bootGraceSamples;
      publishExcuse();
      if (suppressed > 0 && logDue(policy.evaluatedAtMs)) {
        const seconds = Math.round((policy.evaluatedAtMs - lastLogAtMs) / MS_PER_SECOND);
        logger.log(`governor: now ${status.baseMode} (${status.baseReason})`
          + `${status.overlay !== null ? ` overlay=${status.overlay}` : ""} suppressed=${suppressed} in ${seconds}s`);
        lastLogAtMs = policy.evaluatedAtMs;
        suppressed = 0;
      }
      return publish(policy);
    }

    let forcedDepth = 0;
    const isShed = () => gov.getPolicy().mode === MODE.SHED;
    function admits(workClass) {
      if (forcedDepth > 0 && Object.prototype.hasOwnProperty.call(WORK_CLASS, workClass) && !isShed()) return true;
      return gov.admits(workClass);
    }
    function runAdmitted(fn) {
      if (typeof fn !== "function") return { ok: false, reason: "BAD_ARGUMENT" };
      if (isShed()) return { ok: false, reason: "SHED" };
      forcedDepth += 1;
      try {
        return { ok: true, value: fn() };
      } finally {
        forcedDepth -= 1;
      }
    }

    let stopped = false;
    const api = Object.freeze({
      evaluate,
      getPolicy: gov.getPolicy,
      admits,
      runAdmitted,
      getStatus() {
        const st = gov.getStatus();
        return { ...st, counts: { ...st.counts, excusedSamples: excuse.samples } };
      },
      stop() {
        if (stopped) return;
        stopped = true;
        if (listener !== null) listener.remove();
        if (excuse.subscription !== null) excuse.subscription.unsubscribe();
        excuse.ledger = null;
        telemetry.attachGovernor(null);
      },
    });
    telemetry.attachGovernor(api);
    attached = true;
    logger.log(`governor: running sampleCount=${options.sampleCount} warning=${options.warningP95Ms} `
      + `overload=${options.overloadP95Ms} emergency=${options.emergencyMs} `
      + `tick=${tickAvailable ? "ok" : "unavailable"} signal=${options.signal} `
      + `latenessWindow=${options.latenessSampleCount} latenessWarning=${options.latenessWarningPercent}% `
      + `latenessOverload=${options.latenessOverloadPercent}% `
      + `pauseExcuse=${excuse.off === null ? "on" : `off(${excuse.off})`} `
      + `bootGrace=${Number.isFinite(graceEnd) ? `${Math.max(0, Math.round((graceEnd - startedAtMs) / MS_PER_SECOND))}s` : "off"}`
      + `${adjusted.length > 0 ? ` adjusted=${adjusted.join(",")}` : ""}`);
    return { ok: true, governor: api };
  } catch (err) {
    try {
      if (listener !== null) listener.remove();
      if (attached) telemetry.attachGovernor(null);
      if (excuseSubscription !== null) excuseSubscription.unsubscribe();
    } catch (_err) {
    }
    return { ok: false, reason: "GOVERNOR_START_FAILED",
      detail: String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH) };
  }
}

module.exports = { governorOptionsFromConfig, startGovernor };
