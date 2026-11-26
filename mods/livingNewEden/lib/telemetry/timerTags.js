"use strict";

const NAMES = Object.freeze(["setTimeout", "setInterval", "setImmediate"]);
const MARK = Symbol.for("livingNewEden.stallDiag.timer");
const MAX_LABEL_CHARS = 80;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const SKIP_KEYS = Object.freeze(["length", "name", "prototype", "caller", "arguments"]);
const FRAME_RE = /^\s*at (?:.*? \()?(.+?):(\d+):\d+\)?$/;

function noop() {}

function toSlash(p) {
  return String(p).replace(/\\/g, "/");
}

function frameLabel(stack, o) {
  if (typeof stack !== "string") return null;
  const excludes = (o.excludeDirs || []).map((d) => `${toSlash(d).replace(/\/+$/, "")}/`);
  const root = typeof o.rootDir === "string" && o.rootDir !== "" ? `${toSlash(o.rootDir).replace(/\/+$/, "")}/` : "";
  const maxChars = Number.isSafeInteger(o.maxChars) && o.maxChars > 0 ? o.maxChars : MAX_LABEL_CHARS;
  for (const line of stack.split("\n")) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    let file = toSlash(m[1]).replace(/^file:\/\//, "");
    if (file.startsWith("node:") || !file.includes("/")) continue;
    if (excludes.some((d) => file.startsWith(d))) continue;
    if (root !== "" && file.startsWith(root)) file = file.slice(root.length);
    return `${file}:${m[2]}`.slice(-maxChars);
  }
  return null;
}

function copyOwnProperties(from, to) {
  for (const key of Reflect.ownKeys(from)) {
    if (key === MARK || SKIP_KEYS.includes(key)) continue;
    try {
      const d = Object.getOwnPropertyDescriptor(from, key);
      if (d) Object.defineProperty(to, key, d);
    } catch (_err) {
    }
  }
}

function installTimerTags(o) {
  const opts = o || {};
  const g = opts.globalObj;
  if (!g || NAMES.some((name) => typeof g[name] !== "function")) return { ok: false, reason: "missing_timers" };
  if (NAMES.some((name) => g[name][MARK] === true)) return { ok: false, reason: "already_installed" };
  const timersModule = opts.timersModule && typeof opts.timersModule === "object" ? opts.timersModule : null;
  const now = typeof opts.now === "function" ? opts.now : () => 0;
  const sink = opts.sink && typeof opts.sink.noteForeign === "function" ? opts.sink : { noteForeign: noop };
  const slowMs = Number.isFinite(opts.slowCallbackMs) && opts.slowCallbackMs >= 0 ? opts.slowCallbackMs : 50;
  const stackDepth = Number.isSafeInteger(opts.stackDepth) && opts.stackDepth > 0 ? opts.stackDepth : 8;
  const perSec = Number.isSafeInteger(opts.captureMaxPerSec) && opts.captureMaxPerSec >= 0 ? opts.captureMaxPerSec : 0;
  const maxMs = Number.isFinite(opts.maxMinutes) && opts.maxMinutes > 0 ? opts.maxMinutes * MS_PER_MINUTE : 0;
  const labelOpts = { excludeDirs: [...(opts.excludeDirs || [])], rootDir: opts.rootDir || "" };

  const state = { active: true, expired: false, uninstalled: false, chained: false, installedAtMs: now(),
    captures: 0, skipped: 0, captureMs: 0, slow: 0, budgetSecond: -1, budgetUsed: 0 };
  const originals = {};
  const wrappers = {};
  const moduleWrapped = {};

  function stillActive() {
    if (!state.active) return false;
    if (maxMs > 0 && now() - state.installedAtMs >= maxMs) {
      state.active = false;
      state.expired = true;
      return false;
    }
    return true;
  }

  function captureSite(wrapperFn) {
    const t0 = now();
    const second = Math.floor(t0 / MS_PER_SECOND);
    if (second !== state.budgetSecond) {
      state.budgetSecond = second;
      state.budgetUsed = 0;
    }
    if (state.budgetUsed >= perSec) {
      state.skipped += 1;
      return null;
    }
    state.budgetUsed += 1;
    const holder = {};
    const previous = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = stackDepth;
      Error.captureStackTrace(holder, wrapperFn);
    } finally {
      Error.stackTraceLimit = previous;
    }
    state.captures += 1;
    state.captureMs += now() - t0;
    return holder;
  }

  function labelOf(holder, cb) {
    if (holder !== null) {
      try {
        const label = frameLabel(holder.stack, labelOpts);
        if (label !== null) return label;
      } catch (_err) {
      }
    }
    return `fn:${(typeof cb.name === "string" && cb.name !== "" ? cb.name : "anon").slice(0, MAX_LABEL_CHARS - 3)}`;
  }

  function makeWrapper(name, original) {
    const wrapper = {
      [name]: function livingNewEdenTimerTag(cb) {
        if (typeof cb !== "function" || !stillActive()) return original.apply(this, arguments);
        let holder = null;
        try {
          holder = captureSite(wrapper);
        } catch (_err) {
          holder = null;
        }
        const measured = function livingNewEdenTimerCallback() {
          const t0 = now();
          try {
            return cb.apply(this, arguments);
          } finally {
            const ms = now() - t0;
            if (ms >= slowMs) {
              try {
                state.slow += 1;
                sink.noteForeign(labelOf(holder, cb), t0, ms);
              } catch (_err) {
              }
            }
          }
        };
        const args = Array.prototype.slice.call(arguments);
        args[0] = measured;
        return original.apply(this, args);
      },
    }[name];
    copyOwnProperties(original, wrapper);
    Object.defineProperty(wrapper, MARK, { value: true });
    return wrapper;
  }

  for (const name of NAMES) {
    originals[name] = g[name];
    wrappers[name] = makeWrapper(name, originals[name]);
  }
  const replaced = [];
  try {
    for (const name of NAMES) {
      g[name] = wrappers[name];
      replaced.push(name);
      if (timersModule !== null && timersModule[name] === originals[name]) {
        timersModule[name] = wrappers[name];
        moduleWrapped[name] = true;
      }
    }
  } catch (_err) {
    for (const name of replaced) {
      try {
        if (g[name] === wrappers[name]) g[name] = originals[name];
        if (moduleWrapped[name] && timersModule[name] === wrappers[name]) timersModule[name] = originals[name];
      } catch (_err2) {
      }
    }
    return { ok: false, reason: "missing_timers" };
  }

  function uninstall() {
    state.active = false;
    if (state.uninstalled) return state.chained ? { ok: false, reason: "chained" } : { ok: true };
    state.uninstalled = true;
    for (const name of NAMES) {
      try {
        if (g[name] === wrappers[name]) g[name] = originals[name];
        else state.chained = true;
        if (moduleWrapped[name]) {
          if (timersModule[name] === wrappers[name]) timersModule[name] = originals[name];
          else state.chained = true;
        }
      } catch (_err) {
        state.chained = true;
      }
    }
    return state.chained ? { ok: false, reason: "chained" } : { ok: true };
  }

  function getStatus() {
    stillActive();
    let st = "on";
    if (state.uninstalled) st = state.chained ? "chained" : "off";
    else if (state.expired) st = "expired";
    return { state: st, captures: state.captures, skipped: state.skipped, captureMs: state.captureMs,
      slow: state.slow };
  }

  return { ok: true, uninstall, getStatus };
}

module.exports = { NAMES, MARK, frameLabel, installTimerTags };
