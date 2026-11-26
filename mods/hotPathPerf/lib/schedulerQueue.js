"use strict";

const WRAPPED = Symbol.for("evejs.hotPathPerf.schedulerQueueWrapper");
const RUNTIME_WRAPPED = Symbol.for("evejs.hotPathPerf.dueGateRuntime");
const AUTHORITY = "scheduler";
const VENDOR_DEFAULT_MAX_PENDING = 128;

const VENDOR_DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function vendorPositive(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function vendorMaxPending(value) {
  return vendorPositive(value, VENDOR_DEFAULT_MAX_PENDING);
}

function nonNegativeInt(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function createSchedulerQueue(options = {}) {
  const limit = nonNegativeInt(options.limit);
  const requestTimeoutMs = nonNegativeInt(options.requestTimeoutMs);
  const log = typeof options.log === "function" ? options.log : () => {};
  const dueGate = options.dueGate && typeof options.dueGate.capture === "function" ? options.dueGate : null;
  const stats = { wrapped: false, adjusted: 0, driftLogged: false, runtimeWrapped: false, runtimeDriftLogged: false };
  const active = limit > 0 || requestTimeoutMs > 0 || dueGate !== null;

  function adjustOptions(clientOptions) {
    if (!active || !clientOptions || typeof clientOptions !== "object") return clientOptions;
    if (String(clientOptions.authorityName || "").trim() !== AUTHORITY) return clientOptions;
    const changes = {};
    const parts = [];
    const pendingBefore = vendorMaxPending(clientOptions.maxPending);
    if (limit > pendingBefore) {
      changes.maxPending = limit;
      parts.push(`maxPending ${pendingBefore} -> ${limit}`);
    }
    const timeoutBefore = vendorPositive(clientOptions.requestTimeoutMs, VENDOR_DEFAULT_REQUEST_TIMEOUT_MS);
    if (requestTimeoutMs > timeoutBefore) {
      changes.requestTimeoutMs = requestTimeoutMs;
      parts.push(`requestTimeoutMs ${timeoutBefore} -> ${requestTimeoutMs}`);
    }
    if (parts.length === 0) return clientOptions;
    stats.adjusted += 1;
    log(`scheduler queue: ${parts.join(", ")} (authority=${AUTHORITY})`);
    return { ...clientOptions, ...changes };
  }

  function wrapFactory(original) {
    if (typeof original !== "function" || original[WRAPPED]) return original;
    const wrapper = function createOrderedProcessClient(clientOptions) {
      let next = clientOptions;
      try {
        next = adjustOptions(clientOptions);
      } catch (_error) {
        next = clientOptions;
      }
      let gated = false;
      try {
        if (dueGate && dueGate.capturing() && next && typeof next === "object"
          && String(next.authorityName || "").trim() === AUTHORITY && typeof next.onEvent === "function") {
          const onEvent = dueGate.wrapOnEvent(next.onEvent);
          if (onEvent !== next.onEvent) {
            next = { ...next, onEvent };
            gated = true;
          }
        }
      } catch (_error) {
        gated = false;
      }
      if (next === clientOptions) return original.apply(this, arguments);
      const args = Array.prototype.slice.call(arguments);
      args[0] = next;
      const client = original.apply(this, args);
      return gated ? dueGate.wrapClient(client) : client;
    };
    Object.defineProperty(wrapper, WRAPPED, { value: original });
    return wrapper;
  }

  function patchExports(exportsValue) {
    if (!active || !exportsValue || typeof exportsValue !== "object") return false;
    const current = exportsValue.createOrderedProcessClient;
    if (typeof current !== "function") return false;
    if (current[WRAPPED]) {
      stats.wrapped = true;
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(exportsValue, "createOrderedProcessClient");
    if (!descriptor || descriptor.writable !== true && typeof descriptor.set !== "function") return false;
    exportsValue.createOrderedProcessClient = wrapFactory(current);
    stats.wrapped = exportsValue.createOrderedProcessClient !== current;
    return stats.wrapped;
  }

  function checkDrift() {
    if (!active || stats.wrapped || stats.driftLogged) return null;
    stats.driftLogged = true;
    const line = "DRIFT: orderedProcessClient.createOrderedProcessClient not wrapped before durableScheduler.js — " +
      `scheduler maxPending/requestTimeoutMs keep the vendor values (limit ${limit}, requestTimeoutMs ${requestTimeoutMs} have no effect)`;
    log(line);
    return line;
  }

  function wrapRuntimeFactory(original) {
    if (typeof original !== "function" || original[RUNTIME_WRAPPED]) return original;
    const wrapper = function createProductionSchedulerRuntime() {
      const args = arguments;
      const self = this;
      const runtime = dueGate.capture(() => original.apply(self, args));
      try {
        return dueGate.wrapRuntime(runtime);
      } catch (_error) {
        return runtime;
      }
    };
    Object.defineProperty(wrapper, RUNTIME_WRAPPED, { value: original });
    return wrapper;
  }

  function patchProductionRuntime(exportsValue) {
    if (!dueGate || !exportsValue || typeof exportsValue !== "object") return false;
    const current = exportsValue.createProductionSchedulerRuntime;
    if (typeof current === "function" && current[RUNTIME_WRAPPED]) {
      stats.runtimeWrapped = true;
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(exportsValue, "createProductionSchedulerRuntime");
    const writable = descriptor && (descriptor.writable === true || typeof descriptor.set === "function");
    if (typeof current === "function" && writable) {
      exportsValue.createProductionSchedulerRuntime = wrapRuntimeFactory(current);
      stats.runtimeWrapped = exportsValue.createProductionSchedulerRuntime !== current;
    }
    if (!stats.runtimeWrapped && !stats.runtimeDriftLogged) {
      stats.runtimeDriftLogged = true;
      log("DRIFT: productionSchedulerRuntime.createProductionSchedulerRuntime not wrapped — " +
        "due gate inactive (vendor dispatch)");
    }
    return stats.runtimeWrapped;
  }

  return { limit, requestTimeoutMs, active, dueGate, adjustOptions, wrapFactory, patchExports, checkDrift,
    patchProductionRuntime, stats };
}

module.exports = { createSchedulerQueue, WRAPPED, RUNTIME_WRAPPED, AUTHORITY, VENDOR_DEFAULT_MAX_PENDING,
  VENDOR_DEFAULT_REQUEST_TIMEOUT_MS };
