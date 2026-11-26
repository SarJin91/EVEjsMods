"use strict";

const GC_KINDS = Object.freeze(["minor", "major", "incremental", "weakCallback", "unknown"]);
const MAX_DETAIL_LENGTH = 200;

function kindNames(constants) {
  const c = constants || {};
  const names = new Map();
  const add = (value, name) => {
    if (typeof value === "number") names.set(value, name);
  };
  add(c.NODE_PERFORMANCE_GC_MINOR, "minor");
  add(c.NODE_PERFORMANCE_GC_MAJOR, "major");
  add(c.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental");
  add(c.NODE_PERFORMANCE_GC_WEAKCB, "weakCallback");
  return names;
}

function detailOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);
}

function startGcObserver(deps) {
  const Observer = deps && deps.PerformanceObserver;
  const onPause = deps && deps.onPause;
  if (typeof Observer !== "function" || typeof onPause !== "function") {
    return { ok: false, reason: "gc_entries_unsupported", detail: "no PerformanceObserver" };
  }
  const supported = Array.isArray(Observer.supportedEntryTypes) ? Observer.supportedEntryTypes : [];
  if (!supported.includes("gc")) return { ok: false, reason: "gc_entries_unsupported" };
  const names = kindNames(deps.constants);
  let observer = null;
  try {
    observer = new Observer((list) => {
      for (const entry of list.getEntries()) {
        try {
          const detailKind = entry && entry.detail && entry.detail.kind;
          const kind = typeof detailKind === "number" ? detailKind : entry && entry.kind;
          onPause(entry && entry.duration, names.get(kind) || "unknown", entry && entry.startTime);
        } catch (_err) {
        }
      }
    });
    observer.observe({ entryTypes: ["gc"] });
  } catch (err) {
    if (observer) {
      try {
        observer.disconnect();
      } catch (_e) {
      }
    }
    return { ok: false, reason: "gc_observer_failed", detail: detailOf(err) };
  }
  let stopped = false;
  return {
    ok: true,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        observer.disconnect();
      } catch (_err) {
      }
    },
  };
}

module.exports = { GC_KINDS, startGcObserver };
