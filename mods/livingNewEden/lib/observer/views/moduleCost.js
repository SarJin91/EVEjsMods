"use strict";

const VIEW_ID = "module-cost";
const VIEW_ORDER = 2;
const BUDGET_ALARM_IDS = Object.freeze(["heapAfterMajorWarn", "heapAfterMajorCritical", "moduleOverBudget"]);

function snapshotOf(ctx) {
  const t = ctx.telemetry;
  return t && typeof t.getSnapshot === "function" ? t.getSnapshot() || null : null;
}

function buildModuleCostView(deps) {
  const ctx = deps.ctx;
  return {
    title: "Module cost",
    order: VIEW_ORDER,
    cacheKey() {
      if (!ctx.telemetry) return "disabled";
      const snap = snapshotOf(ctx);
      return snap ? snap.seq : "none";
    },
    getData() {
      if (!ctx.telemetry) return { available: false, reason: "telemetry_disabled" };
      const snap = snapshotOf(ctx);
      if (!snap) return { available: false, reason: "no_snapshot" };
      if (!snap.moduleCost) return { available: false, reason: "module_cost_disabled" };
      const alarms = Array.isArray(snap.alarms) ? snap.alarms.filter((a) => BUDGET_ALARM_IDS.includes(a.id)) : [];
      const heap = snap.process && snap.process.heap;
      return {
        available: true,
        seq: snap.seq,
        capturedAtMs: snap.capturedAtMs,
        heapAfterMajorBytes: heap && heap.afterMajor ? heap.afterMajor.lastUsedBytes : null,
        alarms,
        moduleCost: snap.moduleCost,
      };
    },
  };
}

module.exports = { buildModuleCostView, VIEW_ID, VIEW_ORDER };
