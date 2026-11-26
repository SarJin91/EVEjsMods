"use strict";

const DETAIL_MAX = 200;

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfTickStruct", { value: true });
  Object.defineProperty(wrapper, "__hotPathPerfOriginal", { value: original });
  return wrapper;
}

function emptyWindow() {
  return { ranFromTick: 0, skipped: 0, ranAdhoc: 0, maxGapMs: 0 };
}

function createTickStructuresThrottle(options) {
  const config = options.config;
  const log = options.log;
  const minIntervalMs = Math.max(0, Math.floor(Number(config.tickStructuresMinIntervalMs) || 0));

  const priv = {
    armed: false, lastRunAtMs: null, lastTickRunAtMs: null, disabledReason: null,
    hooks: { tick: false, tickStructures: false },
    window: emptyWindow(),
  };

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    priv.armed = false;
    log(`WARN tickStructuresThrottle disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function wrapRuntimeTick(original) {
    priv.hooks.tick = true;
    const wrapped = function tick() {
      priv.armed = true;
      try {
        return original.apply(this, arguments);
      } finally {
        priv.armed = false;
      }
    };
    return markWrapped(wrapped, original);
  }

  function wrapTickStructures(original) {
    priv.hooks.tickStructures = true;
    const wrapped = function tickStructures(nowMs) {
      let fromTick = false;
      let t = NaN;
      try {
        fromTick = priv.armed;
        priv.armed = false;
        if (!priv.disabledReason) {
          t = Number(nowMs);
          if (fromTick && minIntervalMs > 0 && Number.isFinite(t) && priv.lastRunAtMs !== null &&
            t >= priv.lastRunAtMs && t - priv.lastRunAtMs < minIntervalMs) {
            priv.window.skipped += 1;
            return undefined;
          }
        }
      } catch (error) {
        disable("error", String(error && error.message || error));
        return original.apply(this, arguments);
      }
      const r = original.apply(this, arguments);
      if (!priv.disabledReason) {
        try {
          const at = Number.isFinite(t) ? t : Date.now();
          const w = priv.window;
          if (fromTick) {
            w.ranFromTick += 1;
            if (priv.lastTickRunAtMs !== null && at >= priv.lastTickRunAtMs) {
              const gap = at - priv.lastTickRunAtMs;
              if (gap > w.maxGapMs) w.maxGapMs = gap;
            }
            priv.lastTickRunAtMs = at;
          } else {
            w.ranAdhoc += 1;
          }
          priv.lastRunAtMs = at;
        } catch (error) {
          disable("error", String(error && error.message || error));
        }
      }
      return r;
    };
    return markWrapped(wrapped, original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return priv.hooks.tick && priv.hooks.tickStructures ? "ready" : "waiting";
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      disabledReason: priv.disabledReason,
      state: stateText(),
      hooks: { ...priv.hooks },
      minIntervalMs,
      lastRunAtMs: priv.lastRunAtMs,
    };
  }

  function statsSnapshot() {
    return { ...status(), ...priv.window };
  }

  function drainStatsLines() {
    const w = priv.window;
    const line = `stats tickStructuresThrottle state=${stateText()} ranFromTick=${w.ranFromTick} skipped=${w.skipped} ` +
      `ranAdhoc=${w.ranAdhoc} maxGapMs=${w.maxGapMs}`;
    priv.window = emptyWindow();
    return [line];
  }

  return { wrapRuntimeTick, wrapTickStructures, disable, status, statsSnapshot, drainStatsLines };
}

module.exports = { createTickStructuresThrottle };
