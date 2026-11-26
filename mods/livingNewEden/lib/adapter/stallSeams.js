"use strict";

const { performance } = require("node:perf_hooks");

const SCHEDULER_EXPORT = "createDurableScheduler";
const KILLMAIL_EXPORT = "getAllKillmailRecords";
const MARK_SCHEDULER = Symbol.for("livingNewEden.stallDiag.scheduler");
const MARK_KILLMAIL = Symbol.for("livingNewEden.stallDiag.killmail");
const KILLMAIL_LABEL = "vendor:killmail.getAll";
const JOB_PREFIX = "job:";
const MAX_TYPE_CHARS = 60;
const MAX_LABEL_CHARS = 80;
const FRAME_RE = /^\s*at (?:.*? \()?(.+?):(\d+):\d+\)?$/;

function sinkOf(sink) {
  const s = sink && typeof sink === "object" ? sink : {};
  const call = (name) => (...args) => {
    try {
      if (typeof s[name] === "function") s[name](...args);
    } catch (_err) {
    }
  };
  return { noteForeign: call("noteForeign"), noteJob: call("noteJob") };
}

function nowOf(opts) {
  return opts && typeof opts.now === "function" ? opts.now : () => performance.now();
}

function slowOf(opts) {
  return opts && Number.isFinite(opts.slowMs) && opts.slowMs >= 0 ? opts.slowMs : 50;
}

function writableExport(exp, name) {
  if (!exp || (typeof exp !== "object" && typeof exp !== "function")) return { ok: false, reason: "missing" };
  const d = Object.getOwnPropertyDescriptor(exp, name);
  if (!d || typeof d.value !== "function") return { ok: false, reason: "missing" };
  if (d.writable !== true || Object.isFrozen(exp)) return { ok: false, reason: "not_writable" };
  return { ok: true, fn: d.value };
}

function callerOf(stack, rootDir) {
  if (typeof stack !== "string") return null;
  const own = `${__dirname.replace(/\\/g, "/")}/`;
  const root = typeof rootDir === "string" && rootDir !== "" ? `${rootDir.replace(/\\/g, "/").replace(/\/+$/, "")}/` : "";
  for (const line of stack.split("\n")) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    let file = m[1].replace(/\\/g, "/").replace(/^file:\/\//, "");
    if (file.startsWith("node:") || file.startsWith(own) || !file.includes("/")) continue;
    if (root !== "" && file.startsWith(root)) file = file.slice(root.length);
    return `${file}:${m[2]}`;
  }
  return null;
}

function measuredInstance(instance, sink, now, slowMs) {
  if (!instance || typeof instance !== "object" || typeof instance.register !== "function") return instance;
  if (instance[MARK_SCHEDULER] === true) return instance;
  const descriptors = Object.getOwnPropertyDescriptors(instance);
  if (Object.values(descriptors).some((d) => typeof d.get === "function" || typeof d.set === "function")) {
    return instance;
  }
  const vendorRegister = instance.register;
  const register = function register(type, handler) {
    if (typeof handler !== "function") return vendorRegister.apply(this, arguments);
    const label = String(type === undefined || type === null ? "" : type).trim().slice(0, MAX_TYPE_CHARS) || "unknown";
    const measured = function livingNewEdenStallJob() {
      const t0 = now();
      try {
        return handler.apply(this, arguments);
      } finally {
        const ms = now() - t0;
        sink.noteJob(label, t0, ms);
        if (ms >= slowMs) sink.noteForeign(`${JOB_PREFIX}${label}`, t0, ms);
      }
    };
    return vendorRegister.call(this, type, measured);
  };
  const copy = Object.create(Object.getPrototypeOf(instance));
  for (const [key, d] of Object.entries(descriptors)) {
    Object.defineProperty(copy, key, key === "register" ? { ...d, value: register } : d);
  }
  Object.defineProperty(copy, MARK_SCHEDULER, { value: true });
  if (Object.isFrozen(instance)) Object.freeze(copy);
  return copy;
}

function wrapDurableSchedulerExports(exp, sink, opts = {}) {
  const found = writableExport(exp, SCHEDULER_EXPORT);
  if (!found.ok) return found;
  if (found.fn[MARK_SCHEDULER] === true) return { ok: false, reason: "already_wrapped" };
  const original = found.fn;
  const s = sinkOf(sink);
  const now = nowOf(opts);
  const slowMs = slowOf(opts);
  const wrapped = function createDurableScheduler() {
    const instance = original.apply(this, arguments);
    try {
      return measuredInstance(instance, s, now, slowMs);
    } catch (_err) {
      return instance;
    }
  };
  Object.defineProperty(wrapped, MARK_SCHEDULER, { value: true });
  exp[SCHEDULER_EXPORT] = wrapped;
  return { ok: true };
}

function wrapKillmailExports(exp, sink, opts = {}) {
  const found = writableExport(exp, KILLMAIL_EXPORT);
  if (!found.ok) return found;
  if (found.fn[MARK_KILLMAIL] === true) return { ok: false, reason: "already_wrapped" };
  const original = found.fn;
  const s = sinkOf(sink);
  const now = nowOf(opts);
  const slowMs = slowOf(opts);
  const depth = Number.isSafeInteger(opts.stackDepth) && opts.stackDepth > 0 ? opts.stackDepth : 8;
  const wrapped = function getAllKillmailRecords() {
    const t0 = now();
    try {
      return original.apply(this, arguments);
    } finally {
      try {
        const ms = now() - t0;
        let label = KILLMAIL_LABEL;
        if (ms >= slowMs) {
          const holder = {};
          const previous = Error.stackTraceLimit;
          try {
            Error.stackTraceLimit = depth;
            Error.captureStackTrace(holder, wrapped);
          } finally {
            Error.stackTraceLimit = previous;
          }
          const caller = callerOf(holder.stack, opts.rootDir);
          if (caller !== null) label = `${KILLMAIL_LABEL}<-${caller.slice(-(MAX_LABEL_CHARS - KILLMAIL_LABEL.length - 2))}`;
        }
        s.noteForeign(label, t0, ms);
      } catch (_err) {
      }
    }
  };
  Object.defineProperty(wrapped, MARK_KILLMAIL, { value: true });
  exp[KILLMAIL_EXPORT] = wrapped;
  return { ok: true };
}

module.exports = { SCHEDULER_EXPORT, KILLMAIL_EXPORT, MARK_SCHEDULER, MARK_KILLMAIL, KILLMAIL_LABEL, callerOf,
  wrapDurableSchedulerExports, wrapKillmailExports };
