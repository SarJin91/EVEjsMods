// Port of X-Eve xEveLoadGovernor (see CREDITS.md), adapted to the mod: tick interval samples go into a fixed ring (record() on the EveJS tick, O(1), no allocation); evaluate(nowMs), off the tick, sorts a copy of the ring, reads the nearest-rank p95 (lib/telemetry/histogram.js)

"use strict";

const { percentile } = require("./histogram");

const P95 = 0.95;

const MODE = Object.freeze({ NORMAL: "NORMAL", CONSTRAINED: "CONSTRAINED", OVERLOADED: "OVERLOADED", SHED: "SHED" });
const MODE_LEVEL = Object.freeze({ NORMAL: 0, CONSTRAINED: 1, OVERLOADED: 2, SHED: 3 });

const PHASE = Object.freeze({ NO_SAMPLES: "no_samples", STALE: "stale", WARMING: "warming", HEALTHY: "healthy",
  CONSTRAINED: "constrained", RECOVERING: "recovering", OVERLOADED: "overloaded", SHED: "shed",
  UNPLAYABLE: "unplayable" });

const PHASE_MODE = Object.freeze({
  no_samples: MODE.NORMAL, stale: MODE.NORMAL, healthy: MODE.NORMAL,
  warming: MODE.CONSTRAINED, constrained: MODE.CONSTRAINED,
  overloaded: MODE.OVERLOADED,
  shed: MODE.SHED, unplayable: MODE.SHED,
});
const LEVEL_MODE = Object.freeze([MODE.NORMAL, MODE.CONSTRAINED, MODE.OVERLOADED, MODE.SHED]);
const OVERLAY = Object.freeze({ SHED: "shed", UNPLAYABLE: "unplayable" });
const OVERLAY_PHASE = Object.freeze({ shed: "shed", unplayable: "unplayable" });

const WORK_CLASS = Object.freeze({ SETTLEMENT: "SETTLEMENT", LIVE: "LIVE", OPERATIONAL: "OPERATIONAL",
  STRATEGIC: "STRATEGIC", MAINTENANCE: "MAINTENANCE" });
const WORK_CLASS_ORDER = Object.freeze([WORK_CLASS.SETTLEMENT, WORK_CLASS.LIVE, WORK_CLASS.OPERATIONAL,
  WORK_CLASS.STRATEGIC, WORK_CLASS.MAINTENANCE]);

const ADMISSION = Object.freeze({
  NORMAL: Object.freeze([...WORK_CLASS_ORDER]),
  CONSTRAINED: Object.freeze([WORK_CLASS.SETTLEMENT, WORK_CLASS.LIVE, WORK_CLASS.OPERATIONAL]),
  OVERLOADED: Object.freeze([WORK_CLASS.SETTLEMENT, WORK_CLASS.LIVE]),
  SHED: Object.freeze([]),
});

const REASON = Object.freeze({
  no_samples: "no_tick_samples",
  stale: "tick_samples_stale",
  unplayable: "unplayable_circuit_breaker",
  shed: "emergency_background_shed",
  warming: "waiting_for_stable_tick_window",
  overloaded: "sustained_overload",
  constrained: "tick_p95_warning",
  healthy: "tick_p95_healthy",
  recovering: "recovering",
  aboveRecovery: "tick_p95_above_recovery",
});
const LATENESS_REASON = Object.freeze({
  constrained: "tick_lateness_warning",
  healthy: "tick_lateness_healthy",
  aboveRecovery: "tick_lateness_above_recovery",
});

const SIGNAL = Object.freeze({ LATENESS: "lateness", P95: "p95" });
const PERCENT = 100;

const THRESHOLD_KEYS = Object.freeze(["warningP95Ms", "overloadP95Ms", "emergencyMs", "unplayableMs",
  "recoveryThresholdMs", "recoveryMs", "shedHoldMs", "staleSampleMs", "overloadExitP95Ms", "minModeHoldMs",
  "shedMinHoldMs", "shedFastExitCooldownMs"]);
const LATENESS_KEYS = Object.freeze(["latenessWarningPercent", "latenessOverloadPercent", "latenessRecoveryPercent",
  "latenessOverloadExitPercent"]);
const HOLD = Object.freeze({ SLOW: "slow", FAST: "fast" });
const BUDGET_MODES =Object.freeze([MODE.NORMAL, MODE.CONSTRAINED, MODE.OVERLOADED]);
const ZERO_BUDGET = Object.freeze({ budgetMs: 0, maxJobs: 0 });

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function finiteOption(raw, name) {
  const value = raw ? raw[name] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`governor option ${name}`);
  }
  return value;
}

function budgetOption(raw, mode) {
  const budget = raw && raw.budgets ? raw.budgets[mode] : undefined;
  return { budgetMs: finiteOption(budget, "budgetMs"), maxJobs: finiteOption(budget, "maxJobs") };
}

function normalizeOptions(raw) {
  const sampleCount = finiteOption(raw, "sampleCount");
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new RangeError("governor option sampleCount");
  const signal = raw ? raw.signal : undefined;
  if (signal !== SIGNAL.LATENESS && signal !== SIGNAL.P95) throw new RangeError("governor option signal");
  const latenessSampleCount = finiteOption(raw, "latenessSampleCount");
  if (!Number.isSafeInteger(latenessSampleCount) || latenessSampleCount < 1) {
    throw new RangeError("governor option latenessSampleCount");
  }
  const o = { sampleCount, signal, latenessSampleCount };
  for (const key of THRESHOLD_KEYS) o[key] = finiteOption(raw, key);
  for (const key of LATENESS_KEYS) o[key] = finiteOption(raw, key);
  const adjusted = [];
  const raise = (key, floor) => {
    if (o[key] < floor) {
      o[key] = floor;
      adjusted.push(key);
    }
  };
  raise("overloadP95Ms", o.warningP95Ms);
  raise("emergencyMs", o.overloadP95Ms);
  raise("unplayableMs", o.emergencyMs);
  const lower = (key, ceiling) => {
    if (o[key] > ceiling) {
      o[key] = ceiling;
      adjusted.push(key);
    }
  };
  lower("recoveryThresholdMs", o.warningP95Ms);
  lower("overloadExitP95Ms", o.overloadP95Ms);
  raise("overloadExitP95Ms", o.recoveryThresholdMs);
  raise("latenessOverloadPercent", o.latenessWarningPercent);
  lower("latenessRecoveryPercent", o.latenessWarningPercent);
  lower("latenessOverloadExitPercent", o.latenessOverloadPercent);
  raise("latenessOverloadExitPercent", o.latenessRecoveryPercent);
  lower("shedMinHoldMs", o.minModeHoldMs);
  lower("shedHoldMs", o.staleSampleMs);
  o.budgets = {};
  for (const mode of BUDGET_MODES) o.budgets[mode] = budgetOption(raw, mode);
  return { options: deepFreeze(o), adjusted };
}

function buildClasses(mode, budget) {
  const classes = {};
  for (const wc of WORK_CLASS_ORDER) {
    const admitted = ADMISSION[mode].includes(wc);
    const b = admitted ? budget : ZERO_BUDGET;
    classes[wc] = { admitted, budgetMs: b.budgetMs, maxJobs: b.maxJobs };
  }
  return deepFreeze(classes);
}

function makePolicy(mode, phase, reason, budget, classes, numbers) {
  return Object.freeze({ mode, level: MODE_LEVEL[mode], phase, reason, budgetMs: budget.budgetMs,
    maxJobs: budget.maxJobs, classes, p95Ms: numbers.p95Ms, latestMs: numbers.latestMs, maxMs: numbers.maxMs,
    samples: numbers.samples, latenessPercent: numbers.latenessPercent, evaluatedAtMs: numbers.evaluatedAtMs });
}

function fallbackPolicy(reason, normal) {
  const budget = { budgetMs: finiteOption(normal, "budgetMs"), maxJobs: finiteOption(normal, "maxJobs") };
  return makePolicy(MODE.NORMAL, PHASE.NO_SAMPLES, String(reason), budget, buildClasses(MODE.NORMAL, budget),
    { p95Ms: 0, latestMs: 0, maxMs: 0, samples: 0, latenessPercent: 0, evaluatedAtMs: 0 });
}

function createLoadGovernor(deps) {
  const options = deps.options;
  const tickAvailable = deps.tickAvailable === true;
  const onModeChange = typeof deps.onModeChange === "function" ? deps.onModeChange : null;
  const bootGraceEndsAtMs = typeof deps.bootGraceEndsAtMs === "number" && !Number.isNaN(deps.bootGraceEndsAtMs)
    ? deps.bootGraceEndsAtMs : -Infinity;
  const capacity = options.sampleCount;
  const values = new Float64Array(capacity);
  const scratch = new Float64Array(capacity);
  const budgets = {
    NORMAL: options.budgets.NORMAL, CONSTRAINED: options.budgets.CONSTRAINED,
    OVERLOADED: options.budgets.OVERLOADED, SHED: ZERO_BUDGET,
  };
  const classesByMode = {};
  for (const mode of Object.keys(MODE)) classesByMode[mode] = buildClasses(mode, budgets[mode]);
  const thresholds = Object.freeze({ ...Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, options[k]])),
    signal: options.signal, latenessSampleCount: options.latenessSampleCount,
    ...Object.fromEntries(LATENESS_KEYS.map((k) => [k, options[k]])) });
  const byP95 = options.signal === SIGNAL.P95;
  const warningAt = byP95 ? options.warningP95Ms : options.latenessWarningPercent;
  const overloadAt = byP95 ? options.overloadP95Ms : options.latenessOverloadPercent;
  const recoveryBelow = byP95 ? options.recoveryThresholdMs : options.latenessRecoveryPercent;
  const overloadExitBelow = byP95 ? options.overloadExitP95Ms : options.latenessOverloadExitPercent;
  const heldReason = byP95 ? REASON : LATENESS_REASON;
  const latenessCapacity = options.latenessSampleCount;
  const lateIntervals = new Float64Array(latenessCapacity);
  const lateValues = new Float64Array(latenessCapacity);
  let lateNext = 0;
  let lateFilled = 0;
  const residencyMs = { NORMAL: 0, CONSTRAINED: 0, OVERLOADED: 0, SHED: 0 };
  let lastEvaluatedAtMs = null;
  const counts = { constrained: 0, overloaded: 0, shed: 0, unplayable: 0, recoveryTransitions: 0,
    emergencySamples: 0, unplayableSamples: 0, spikeSheds: 0, shedFastExits: 0, bootGraceSamples: 0 };

  let next = 0;
  let filled = 0;
  let hasSample = false;
  let lastSampleAtMs = deps.nowMs;
  let lastEmergencyAtMs = -Infinity;
  let lastUnplayableAtMs = -Infinity;
  let baseMode = null;
  let baseReason = null;
  let baseModeSinceMs = deps.nowMs;
  let belowSinceMs = null;
  let lastFastShedExitAtMs = -Infinity;
  let warmedUp = false;
  let overlay = null;
  let policy = null;
  let status = null;
  let changes = 0;
  let evaluations = 0;
  let callbackErrors = 0;

  function record(intervalMs, atMs, latenessMs) {
    if (typeof intervalMs !== "number" || !(intervalMs >= 0) || intervalMs === Infinity) return;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return;
    if (atMs - intervalMs < bootGraceEndsAtMs) {
      lastSampleAtMs = atMs;
      counts.bootGraceSamples += 1;
      return;
    }
    values[next] = intervalMs;
    next = (next + 1) % capacity;
    if (filled < capacity) filled += 1;
    if (typeof latenessMs === "number" && latenessMs >= 0 && latenessMs <= intervalMs) {
      lateIntervals[lateNext] = intervalMs;
      lateValues[lateNext] = latenessMs;
      lateNext = (lateNext + 1) % latenessCapacity;
      if (lateFilled < latenessCapacity) lateFilled += 1;
    }
    hasSample = true;
    lastSampleAtMs = atMs;
    if (intervalMs >= options.unplayableMs) {
      lastUnplayableAtMs = atMs;
      counts.unplayableSamples += 1;
    }
    if (intervalMs >= options.emergencyMs) {
      lastEmergencyAtMs = atMs;
      counts.emergencySamples += 1;
    }
  }

  function levelOf(p95, value) {
    if (p95 >= options.unplayableMs) return MODE_LEVEL.SHED;
    if (value >= overloadAt) return MODE_LEVEL.OVERLOADED;
    if (value >= warningAt) return MODE_LEVEL.CONSTRAINED;
    return MODE_LEVEL.NORMAL;
  }

  function belowExit(mode, p95, value) {
    if (mode === MODE.SHED) return p95 < options.unplayableMs;
    if (mode === MODE.OVERLOADED) return value < overloadExitBelow;
    return value < recoveryBelow;
  }

  function setBase(mode, now) {
    baseMode = mode;
    baseModeSinceMs = now;
    belowSinceMs = null;
  }

  function heldPhase(mode, value) {
    if (mode === MODE.NORMAL) return withReason(PHASE.HEALTHY, heldReason.healthy);
    if (mode === MODE.CONSTRAINED) {
      return withReason(PHASE.CONSTRAINED, value >= warningAt ? heldReason.constrained : heldReason.aboveRecovery);
    }
    if (mode === MODE.OVERLOADED) return withReason(PHASE.OVERLOADED, REASON.overloaded);
    return withReason(PHASE.UNPLAYABLE, REASON.unplayable);
  }

  function withReason(phase, reason) {
    baseReason = reason;
    return phase;
  }

  function holdKind(now) {
    const held = now - baseModeSinceMs;
    if (held >= options.minModeHoldMs) return HOLD.SLOW;
    if (baseMode === MODE.SHED && held >= options.shedMinHoldMs
      && now - lastFastShedExitAtMs >= options.shedFastExitCooldownMs) return HOLD.FAST;
    return null;
  }

  function stepBase(now, n, p95, value) {
    if (!tickAvailable || now - lastSampleAtMs > options.staleSampleMs) {
      if (baseMode !== MODE.NORMAL) setBase(MODE.NORMAL, now);
      belowSinceMs = null;
      return tickAvailable ? withReason(PHASE.STALE, REASON.stale) : withReason(PHASE.NO_SAMPLES, REASON.no_samples);
    }
    if (n < capacity) {
      if (baseMode !== MODE.CONSTRAINED) setBase(MODE.CONSTRAINED, now);
      return withReason(PHASE.WARMING, REASON.warming);
    }
    const raw = levelOf(p95, value);
    if (!warmedUp) {
      warmedUp = true;
      setBase(LEVEL_MODE[raw], now);
      return heldPhase(baseMode, value);
    }
    const level = MODE_LEVEL[baseMode];
    if (raw > level) {
      setBase(LEVEL_MODE[raw], now);
      return heldPhase(baseMode, value);
    }
    if (level > MODE_LEVEL.NORMAL && belowExit(baseMode, p95, value)) {
      if (belowSinceMs === null) belowSinceMs = now;
      const kind = now - belowSinceMs >= options.recoveryMs ? holdKind(now) : null;
      if (kind !== null) {
        if (kind === HOLD.FAST) {
          lastFastShedExitAtMs = now;
          counts.shedFastExits += 1;
        }
        setBase(LEVEL_MODE[level - 1], now);
        counts.recoveryTransitions += 1;
        if (baseMode !== MODE.NORMAL && belowExit(baseMode, p95, value)) {
          return withReason(PHASE.RECOVERING, REASON.recovering);
        }
        return heldPhase(baseMode, value);
      }
      return withReason(PHASE.RECOVERING, REASON.recovering);
    }
    belowSinceMs = null;
    return heldPhase(baseMode, value);
  }

  function latenessShare() {
    if (lateFilled === 0) return 0;
    let sumLate = 0;
    let sumInterval = 0;
    for (let i = 0; i < lateFilled; i += 1) {
      sumLate += lateValues[i];
      sumInterval += lateIntervals[i];
    }
    const newest = (lateNext - 1 + latenessCapacity) % latenessCapacity;
    const nominal = lateIntervals[newest] - lateValues[newest];
    const denominator = sumInterval + (latenessCapacity - lateFilled) * nominal;
    return denominator > 0 ? (PERCENT * sumLate) / denominator : 0;
  }

  function evaluate(nowMs) {
    const now = nowMs;
    const n = filled;
    let p95 = 0;
    let maxMs = 0;
    let latestMs = 0;
    if (n > 0) {
      scratch.set(values.subarray(0, n));
      const sorted = scratch.subarray(0, n).sort();
      p95 = percentile(sorted, P95);
      maxMs = sorted[n - 1];
      latestMs = values[(next - 1 + capacity) % capacity];
    }
    const latenessPercent = latenessShare();
    if (baseMode !== null && lastEvaluatedAtMs !== null) residencyMs[baseMode] += Math.max(0, now - lastEvaluatedAtMs);
    lastEvaluatedAtMs = now;
    const previousBase = baseMode;
    const basePhase = stepBase(now, n, p95, byP95 ? p95 : latenessPercent);
    let nextOverlay = null;
    if (basePhase !== PHASE.NO_SAMPLES && basePhase !== PHASE.STALE && n > 0) {
      if (now - lastUnplayableAtMs <= options.shedHoldMs) nextOverlay = OVERLAY.UNPLAYABLE;
      else if (now - lastEmergencyAtMs <= options.shedHoldMs) nextOverlay = OVERLAY.SHED;
    }
    if (nextOverlay !== null && overlay === null) counts.spikeSheds += 1;
    overlay = nextOverlay;

    const candidate = overlay === null ? basePhase : OVERLAY_PHASE[overlay];
    const reason = overlay === null ? baseReason : REASON[candidate];
    const mode = overlay === null ? baseMode : MODE.SHED;
    if (overlay !== null) counts[candidate] += 1;
    else if (baseMode === MODE.CONSTRAINED && candidate !== PHASE.WARMING) counts.constrained += 1;
    else if (baseMode === MODE.OVERLOADED) counts.overloaded += 1;
    else if (baseMode === MODE.SHED) counts.unplayable += 1;

    evaluations += 1;
    policy = makePolicy(mode, candidate, reason, budgets[mode], classesByMode[mode],
      { p95Ms: p95, latestMs, maxMs, samples: n, latenessPercent, evaluatedAtMs: now });
    const changed = previousBase !== null && previousBase !== baseMode;
    if (changed) changes += 1;
    status = Object.freeze({
      mode, level: policy.level, phase: candidate, reason, p95Ms: p95, latestMs, maxMs, samples: n,
      sampleCount: capacity, tickAvailable, baseMode, baseReason, overlay, baseModeSinceMs, modeSinceMs: baseModeSinceMs,
      changes, evaluations, signal: options.signal, latenessPercent, latenessSamples: lateFilled,
      latenessSampleCount: latenessCapacity, residencyMs: Object.freeze({ ...residencyMs }),
      lastSampleAgeMs: hasSample ? Math.max(0, now - lastSampleAtMs) : null,
      counts: Object.freeze({ ...counts }), callbackErrors, classes: policy.classes, thresholds,
    });
    if (changed && onModeChange !== null) {
      try {
        onModeChange(previousBase, baseMode, policy);
      } catch (_err) {
        callbackErrors += 1;
        status = Object.freeze({ ...status, callbackErrors });
      }
    }
    return policy;
  }

  evaluate(deps.nowMs);

  return Object.freeze({
    record,
    evaluate,
    getPolicy: () => policy,
    admits: (workClass) => {
      const entry = Object.prototype.hasOwnProperty.call(policy.classes, workClass) ? policy.classes[workClass] : null;
      return entry !== null && entry.admitted === true;
    },
    getStatus: () => status,
  });
}

module.exports = { MODE, MODE_LEVEL, PHASE, PHASE_MODE, WORK_CLASS, WORK_CLASS_ORDER, ADMISSION, SIGNAL,
  normalizeOptions, createLoadGovernor, fallbackPolicy };
