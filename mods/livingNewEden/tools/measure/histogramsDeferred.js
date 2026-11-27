"use strict";

const DEFERRED_PATH = "capture.steps.histogramsDeferred";

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function deferredOf(item) {
  if (!item || typeof item !== "object") return 0;
  let v = item[DEFERRED_PATH];
  if (v === undefined) {
    const cap = item.capture;
    const steps = cap && typeof cap === "object" ? cap.steps : null;
    v = steps && typeof steps === "object" ? steps.histogramsDeferred : undefined;
  }
  return isNum(v) && v > 0 ? v : 0;
}

function deferredMark(items) {
  let windows = 0;
  let max = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const d = deferredOf(it);
    if (d > 0) {
      windows += 1;
      if (d > max) max = d;
    }
  }
  return { histogramsDeferred: windows > 0, deferredWindows: windows, deferredMax: max };
}

module.exports = { DEFERRED_PATH, deferredOf, deferredMark };
