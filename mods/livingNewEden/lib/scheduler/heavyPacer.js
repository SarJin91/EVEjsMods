"use strict";

const PACED_CLASSES = Object.freeze(["OPERATIONAL", "STRATEGIC", "MAINTENANCE"]);
const CLASS = Object.freeze({ EXEMPT: "exempt", UNMEASURED: "unmeasured", LIGHT: "light", HEAVY: "heavy" });

function createHeavyPacer(opts) {
  const heavyEventMs = opts.heavyEventMs;
  const perWindow = opts.perWindow;
  const windowMs = opts.windowMs;
  const alpha = opts.alpha;
  const workClassOf = opts.workClassOf;
  const sampleCapMs = opts.sampleCapFactor * heavyEventMs;
  const minSamples = opts.minSamples;
  const ewma = new Map();
  const ring = new Float64Array(perWindow);
  let filled = 0;
  let head = 0;
  let dispatchedHeavy = 0;
  let unmeasuredRuns = 0;

  function paced(type) {
    let wc = null;
    try {
      wc = workClassOf(type);
    } catch (_err) {
      wc = null;
    }
    return PACED_CLASSES.includes(wc);
  }

  function classify(type) {
    if (!paced(type)) return CLASS.EXEMPT;
    const est = ewma.get(type);
    if (est === undefined || est.n < minSamples) return CLASS.UNMEASURED;
    return est.cost >= heavyEventMs ? CLASS.HEAVY : CLASS.LIGHT;
  }

  function tokenFree(nowMs) {
    return filled < perWindow || ring[head] <= nowMs - windowMs;
  }

  function tokens(nowMs) {
    let used = 0;
    for (let i = 0; i < filled; i += 1) if (ring[i] > nowMs - windowMs) used += 1;
    return perWindow - used;
  }

  function beginPass() {
    return { heavyType: null, unmeasured: new Set() };
  }

  function allowance(type, nowMs, grant) {
    if (grant.unmeasured.has(type)) return 1;
    const cls = classify(type);
    if (cls === CLASS.EXEMPT || cls === CLASS.LIGHT) return Infinity;
    if (cls === CLASS.UNMEASURED) {
      grant.unmeasured.add(type);
      return 1;
    }
    if (grant.heavyType === type) return 1;
    if (grant.heavyType === null && tokenFree(nowMs)) {
      grant.heavyType = type;
      return 1;
    }
    return 0;
  }

  function noteDispatch(type, nowMs, grant) {
    if (grant.heavyType === type) {
      ring[head] = nowMs;
      head = (head + 1) % perWindow;
      if (filled < perWindow) filled += 1;
      dispatchedHeavy += 1;
    } else if (grant.unmeasured.has(type)) {
      unmeasuredRuns += 1;
    }
  }

  function observe(type, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const x = ms < sampleCapMs ? ms : sampleCapMs;
    const est = ewma.get(type);
    if (est === undefined) ewma.set(type, { cost: x, n: 1 });
    else if (est.n < minSamples) {
      if (x < est.cost) est.cost = x;
      est.n += 1;
    } else est.cost = alpha * x + (1 - alpha) * est.cost;
  }

  function isHeavy(type, est) {
    return est.n >= minSamples && est.cost >= heavyEventMs && paced(type);
  }

  function heavyCount() {
    let n = 0;
    for (const [type, est] of ewma) if (isHeavy(type, est)) n += 1;
    return n;
  }

  function getStatus(nowMs) {
    const heavy = [];
    for (const [type, est] of ewma) {
      if (isHeavy(type, est)) heavy.push({ type, ewmaMs: Math.round(est.cost * 100) / 100 });
    }
    return Object.freeze({ heavyEventMs, perWindow, windowMs, sampleCapMs, minSamples,
      tokens: Number.isFinite(nowMs) ? tokens(nowMs) : null, heavy, dispatchedHeavy, unmeasuredRuns });
  }

  return Object.freeze({ classify, beginPass, allowance, noteDispatch, observe, tokens, heavyCount, getStatus });
}

module.exports = { createHeavyPacer, PACED_CLASSES, CLASS };
