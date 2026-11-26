"use strict";

function defaultNow() {
  return process.hrtime.bigint();
}

function emptyEntry() {
  return { n: 0, sumMs: 0, maxMs: 0 };
}

function createRecorder(config, log, options = {}) {
  const now = options.now || defaultNow;
  const calls = new Map();
  const lifecycle = new Map();
  const recorder = {
    now,
    errors: 0,
    lastError: null,
    counters: new Map(),
    nextCount(name) {
      const value = (recorder.counters.get(name) || 0) + 1;
      recorder.counters.set(name, value);
      return value;
    },
    noteError(error) {
      recorder.errors += 1;
      recorder.lastError = String(error && error.message || error);
    },
    record(name, ms, context) {
      let entry = calls.get(name);
      if (!entry) {
        entry = emptyEntry();
        calls.set(name, entry);
      }
      entry.n += 1;
      entry.sumMs += ms;
      if (ms > entry.maxMs) entry.maxMs = ms;
      if (ms < config.slowCallMs) return false;
      let text = "";
      try {
        text = typeof context === "function" ? String(context() || "") : String(context || "");
      } catch (error) {
        recorder.noteError(error);
      }
      log(`slow ${name} ${ms.toFixed(1)}ms${text ? ` ${text}` : ""}`);
      return true;
    },
    recordLifecycle(state, ms, length) {
      const key = String(state);
      let entry = lifecycle.get(key);
      if (!entry) {
        entry = { ...emptyEntry(), maxLength: 0 };
        lifecycle.set(key, entry);
      }
      entry.n += 1;
      entry.sumMs += ms;
      if (ms > entry.maxMs) entry.maxMs = ms;
      if (length > entry.maxLength) entry.maxLength = length;
    },
    snapshot() {
      return {
        calls: new Map([...calls].map(([k, v]) => [k, { ...v }])),
        lifecycle: new Map([...lifecycle].map(([k, v]) => [k, { ...v }])),
      };
    },
    drainStatsLines() {
      const lines = [];
      for (const [name, e] of calls) {
        lines.push(`stats ${name} n=${e.n} sumMs=${e.sumMs.toFixed(1)} maxMs=${e.maxMs.toFixed(1)}`);
      }
      for (const [state, e] of lifecycle) {
        lines.push(
          `stats dungeonRuntime.listInstancesByLifecycle[${state}] n=${e.n} sumMs=${e.sumMs.toFixed(1)} ` +
            `maxMs=${e.maxMs.toFixed(1)} maxLength=${e.maxLength}`,
        );
      }
      if (recorder.errors > 0) lines.push(`stats errors=${recorder.errors} last=${recorder.lastError}`);
      calls.clear();
      lifecycle.clear();
      return lines;
    },
  };
  return recorder;
}

function elapsedMs(recorder, started) {
  return Number(recorder.now() - started) / 1e6;
}

function wrapTimed(original, recorder, options) {
  const { name, before, context, onDone } = options;
  const wrapped = function hotPathPerfTimed() {
    let token;
    let started;
    try {
      token = before ? before(this, arguments) : undefined;
      started = recorder.now();
    } catch (error) {
      recorder.noteError(error);
    }
    let result;
    let threw = false;
    try {
      result = original.apply(this, arguments);
      return result;
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      if (started !== undefined) {
        try {
          const ms = elapsedMs(recorder, started);
          if (onDone) {
            onDone(ms, result, arguments, threw);
          } else {
            const thisArg = this;
            const args = arguments;
            recorder.record(name, ms, context ? () => context(token, result, thisArg, args, threw) : (threw ? "threw" : ""));
          }
        } catch (error) {
          recorder.noteError(error);
        }
      }
    }
  };
  Object.defineProperty(wrapped, "__hotPathPerf", { value: original });
  return wrapped;
}

function wrapProperty(holder, property, recorder, options) {
  if (!holder || (typeof holder !== "object" && typeof holder !== "function")) return false;
  if (!Object.prototype.hasOwnProperty.call(holder, property)) return false;
  const current = holder[property];
  if (typeof current !== "function") return false;
  if (current.__hotPathPerf) return true;
  holder[property] = wrapTimed(current, recorder, options);
  return true;
}

module.exports = { createRecorder, wrapTimed, wrapProperty, defaultNow };
