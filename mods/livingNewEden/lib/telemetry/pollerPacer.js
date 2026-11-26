"use strict";

const MODE_NORMAL = "NORMAL";
const MODE_CONSTRAINED = "CONSTRAINED";
const MODE_OVERLOADED = "OVERLOADED";
const MODE_SHED = "SHED";
const MAX_EXEMPT = 64;

function parseExempt(csv) {
  if (Array.isArray(csv)) return csv.filter((x) => typeof x === "string" && x !== "").slice(0, MAX_EXEMPT);
  if (typeof csv !== "string") return [];
  return csv.split(",").map((x) => x.trim()).filter((x) => x !== "").slice(0, MAX_EXEMPT);
}

function factorOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : 1;
}

function createPollerPacer(s, d) {
  const enabled = s.enabled === true;
  const factors = Object.freeze({
    [MODE_NORMAL]: 1,
    [MODE_CONSTRAINED]: factorOf(s.constrainedFactor),
    [MODE_OVERLOADED]: factorOf(s.overloadedFactor),
    [MODE_SHED]: factorOf(s.shedFactor),
  });
  const maxStretchMs = Number.isFinite(s.maxStretchMs) && s.maxStretchMs > 0 ? s.maxStretchMs : 0;
  const budgetOn = s.budgetStretch === true;
  const budgetStretchFactor = factorOf(s.budgetStretchFactor);
  const windows = s.budgetWindows;
  const maxLabels = Number.isSafeInteger(s.maxLabels) && s.maxLabels > 0 ? s.maxLabels : 0;
  const exempt = parseExempt(s.exempt);
  const stretched = new Set();
  const noop = () => {};
  const count = typeof d.count === "function" ? d.count : noop;
  const gauge = typeof d.gauge === "function" ? d.gauge : noop;

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  }

  function publish() {
    safe(() => gauge("perf.stretchedLabels", stretched.size), undefined);
  }

  function isExempt(label) {
    for (let i = 0; i < exempt.length; i += 1) if (label.startsWith(exempt[i])) return true;
    return false;
  }

  function modeFactor() {
    const mode = typeof d.getMode === "function" ? safe(() => d.getMode(), null) : null;
    return typeof mode === "string" && Object.prototype.hasOwnProperty.call(factors, mode) ? factors[mode] : 1;
  }

  function budgetFactor(label) {
    if (!budgetOn) return 1;
    if (stretched.has(label)) {
      const back = typeof d.inBudget === "function" ? safe(() => d.inBudget(label, windows) === true, false) : false;
      if (!back) return budgetStretchFactor;
      stretched.delete(label);
      publish();
      return 1;
    }
    const over = typeof d.overBudget === "function" ? safe(() => d.overBudget(label, windows) === true, false) : false;
    if (!over || stretched.size >= maxLabels) return 1;
    stretched.add(label);
    publish();
    return budgetStretchFactor;
  }

  function delayFor(label, intervalMs, pacing) {
    if (!enabled || pacing === false || !(intervalMs > 0) || intervalMs === Infinity) return intervalMs;
    if (typeof label !== "string" || isExempt(label)) return intervalMs;
    const mode = modeFactor();
    const budget = budgetFactor(label);
    if (mode === 1 && budget === 1) return intervalMs;
    const cap = Math.max(intervalMs, maxStretchMs);
    const delay = Math.min(cap, Math.max(intervalMs, Math.round(intervalMs * mode * budget)));
    if (delay > intervalMs) {
      safe(() => count("perf.pollerStretched"), undefined);
      if (budget > 1) safe(() => count("perf.pollerBudgetStretched"), undefined);
    }
    return delay;
  }

  function release(label) {
    if (stretched.delete(label)) publish();
  }

  publish();
  return Object.freeze({
    delayFor,
    release,
    getStatus: () => ({ enabled, exempt: exempt.slice(), stretchedLabels: [...stretched].sort() }),
  });
}

module.exports = { createPollerPacer, parseExempt, MAX_EXEMPT_PREFIXES: MAX_EXEMPT };
