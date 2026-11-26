"use strict";

const WRAPPED_POLICY_SCOPE = Symbol.for("livingNewEden.sitePolicyHubScope");
const WRAPPED_HUB_UPGRADES = Symbol.for("livingNewEden.sitePolicyHubUpgrades");
const COUNTER_NAMES = Object.freeze(["FAST", "HAS_UPGRADES", "NO_HUB", "FAILED"]);

function createSitePolicyHubScope() {
  let depth = 0;
  return Object.freeze({
    enter() { depth += 1; },
    exit() { if (depth > 0) depth -= 1; },
    active() { return depth > 0; },
  });
}

function isScope(scope) {
  return Boolean(scope) && typeof scope.enter === "function" && typeof scope.exit === "function"
    && typeof scope.active === "function";
}

function mark(fn, symbol) {
  Object.defineProperty(fn, symbol, { value: true });
  return fn;
}

function wrapPolicyScope(originalFn, scope) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[WRAPPED_POLICY_SCOPE] === true) return { ok: true, wrapped: originalFn, noop: true };
  if (!isScope(scope)) return { ok: false, reason: "SCOPE_INVALID" };
  function livingNewEdenSitePolicyHubScope() {
    scope.enter();
    try {
      return originalFn.apply(this, arguments);
    } finally {
      scope.exit();
    }
  }
  return { ok: true, wrapped: mark(livingNewEdenSitePolicyHubScope, WRAPPED_POLICY_SCOPE) };
}

function wrapHubUpgrades(originalFn, readPending, scope, onOutcome) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[WRAPPED_HUB_UPGRADES] === true) return { ok: true, wrapped: originalFn, noop: true };
  if (typeof readPending !== "function") return { ok: false, reason: "READ_NOT_A_FUNCTION" };
  if (!isScope(scope)) return { ok: false, reason: "SCOPE_INVALID" };
  const report = typeof onOutcome === "function"
    ? (outcome) => {
      try {
        onOutcome(outcome);
      } catch (_err) {
      }
    }
    : () => {};

  function livingNewEdenSitePolicyHubUpgrades(hubID, identity) {
    if (!scope.active() || (arguments.length > 1 && identity != null)) {
      report("OUT_OF_SCOPE");
      return originalFn.apply(this, arguments);
    }
    let pending;
    try {
      pending = readPending(hubID);
    } catch (_err) {
      report("FAILED");
      return originalFn.apply(this, arguments);
    }
    if (pending === null || typeof pending !== "object" || !Array.isArray(pending.upgrades)) {
      report("NO_HUB");
      return originalFn.apply(this, arguments);
    }
    if (pending.upgrades.length > 0) {
      report("HAS_UPGRADES");
      return originalFn.apply(this, arguments);
    }
    report("FAST");
    return pending;
  }
  return { ok: true, wrapped: mark(livingNewEdenSitePolicyHubUpgrades, WRAPPED_HUB_UPGRADES) };
}

module.exports = {
  createSitePolicyHubScope, wrapPolicyScope, wrapHubUpgrades, COUNTER_NAMES,
  WRAPPED_POLICY_SCOPE, WRAPPED_HUB_UPGRADES,
};
