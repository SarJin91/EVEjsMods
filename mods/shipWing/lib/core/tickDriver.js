"use strict";

function createTickDriver(deps) {
  const wing = deps.wing;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const timers = deps.timers || { setInterval, clearInterval };
  const onTelemetry = typeof deps.onTelemetry === "function" ? deps.onTelemetry : () => {};
  const onTick = typeof deps.onTick === "function" ? deps.onTick : null;
  let tickHandle = null;
  let telemetryHandle = null;
  let stopped = false;
  let ticks = 0;
  let errors = 0;

  function runTick() {
    ticks += 1;
    let nowMs;
    try {
      nowMs = now();
      wing.tick(nowMs);
    } catch (_err) {
      errors += 1;
    }
    if (!onTick || nowMs === undefined) return;
    try {
      onTick(nowMs);
    } catch (_err) {
      errors += 1;
    }
  }

  function runTelemetry(final) {
    try {
      onTelemetry(final);
    } catch (_err) {
      errors += 1;
    }
  }

  function unref(handle) {
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }

  function start() {
    if (stopped) return { ok: false, reason: "stopped" };
    if (tickHandle !== null) return { ok: false, reason: "already_started" };
    tickHandle = unref(timers.setInterval(runTick, deps.tickIntervalMs));
    telemetryHandle = unref(timers.setInterval(() => runTelemetry(false), deps.telemetryIntervalMs));
    return { ok: true, reason: null };
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    if (tickHandle !== null) timers.clearInterval(tickHandle);
    if (telemetryHandle !== null) timers.clearInterval(telemetryHandle);
    tickHandle = null;
    telemetryHandle = null;
    runTelemetry(true);
    return true;
  }

  return {
    start,
    stop,
    isRunning: () => tickHandle !== null,
    stats: () => ({ ticks, errors }),
  };
}

module.exports = { createTickDriver };
