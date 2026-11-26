"use strict";

const TYPE_INFRASTRUCTURE_HUB = 32458;
const SAMPLE_MAX = 5;
const ERRORS_MAX = 5;
const DETAIL_MAX = 200;
const MARKER = "__hotPathPerfSovEcho";

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  const integerValue = Math.trunc(numericValue);
  return integerValue > 0 ? integerValue : fallback;
}

function clampScore(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numericValue));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object";
}

function isOwnedHubEcho(structure) {
  try {
    if (Number(structure && structure.typeID) !== TYPE_INFRASTRUCTURE_HUB) return false;
    const c = structure.entosisCapture;
    if (!isObject(c)) return false;
    if (isObject(c.completionReceipt)) return false;
    if (!(clampScore(c.scoreAtLastUpdateTime) >= 1 &&
      normalizePositiveInteger(c.completionCandidateAllianceID, c.controllingTeamID))) return false;
    const d = structure.devFlags;
    if (!isObject(d) || !isObject(d.sovereigntyOwnedHubCapture)) return false;
    const devEpoch = String(d.sovereigntyCaptureEpoch || "").trim();
    if (!devEpoch) return false;
    return devEpoch !== String(c.captureEpoch || "").trim();
  } catch (_error) {
    return false;
  }
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, MARKER, { value: original });
  return wrapper;
}

function createSovCaptureEchoSkip(options) {
  const config = (options && options.config) || {};
  const log = (options && options.log) || (() => {});
  const now = (options && typeof options.now === "function") ? options.now : Date.now;
  const enabled = config.sovCaptureOwnedEchoSkip === true;
  let disabledReason = null;
  let listFirstLoad = false;
  let armed = false;
  let scopeWin = null;
  let maskedTotal = 0;
  let calls = 0;

  function disable(reason, detail) {
    if (disabledReason) return;
    disabledReason = String(reason);
    armed = false;
    log(`WARN sovCaptureOwnedEchoSkip disabled: ${disabledReason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function summarize(r, ms) {
    const w = scopeWin;
    const sample = w.sample.length > 0 ? w.sample.join(",") : "-";
    const head = `sovCaptureEcho: masked=${w.masked}`;
    const tail = ` ms=${Math.round(ms)} sample=${sample}${w.note ? ` note=${w.note}` : ""}`;
    if (isThenable(r)) {
      log(`${head} result=async${tail}`);
      return;
    }
    let body;
    try {
      const data = r?.data;
      const results = Array.isArray(data?.results) ? data.results : [];
      const counts = new Map();
      let failed = 0;
      for (const entry of results) {
        if (entry?.success !== false) continue;
        failed += 1;
        const key = String(entry?.errorMsg ?? "unknown");
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const errors = [...counts.entries()].slice(0, ERRORS_MAX).map(([k, n]) => `${k}:${n}`).join(",") || "-";
      body = ` scanned=${data?.scannedCandidates} completed=${data?.completed} blocked=${data?.blocked}` +
        ` failed=${failed} errors=${errors}`;
    } catch (_error) {
      body = " summary=unreadable";
    }
    log(`${head}${body}${tail}`);
  }

  function wrapList(original) {
    if (typeof original !== "function" || original[MARKER]) return original;
    const wrapped = function hotPathPerfSovEchoList(...args) {
      const result = original.apply(this, args);
      if (!armed) return result;
      armed = false;
      if (!Array.isArray(result)) {
        scopeWin.note = "shape";
        return result;
      }
      const hits = [];
      try {
        for (const system of result) {
          const structures = system && Array.isArray(system.structures) ? system.structures : [];
          for (const structure of structures) {
            if (isOwnedHubEcho(structure)) hits.push({ system, structure });
          }
        }
      } catch (error) {
        disable("error", error && error.message || error);
        return result;
      }
      for (const hit of hits) {
        delete hit.structure.entosisCapture;
        if (scopeWin.sample.length < SAMPLE_MAX) {
          scopeWin.sample.push(`${hit.system.solarSystemID}:${hit.structure.itemID}`);
        }
      }
      scopeWin.masked += hits.length;
      maskedTotal += hits.length;
      return result;
    };
    return markWrapped(wrapped, original);
  }

  function wrapReconcile(original) {
    if (typeof original !== "function" || original[MARKER]) return original;
    const wrapped = function hotPathPerfSovEchoScope(...args) {
      if (!enabled || disabledReason || !listFirstLoad) return original.apply(this, args);
      armed = true;
      scopeWin = { masked: 0, sample: [], note: null };
      calls += 1;
      const t0 = now();
      try {
        const r = original.apply(this, args);
        if (armed) disable("list_not_called");
        summarize(r, now() - t0);
        return r;
      } finally {
        armed = false;
      }
    };
    return markWrapped(wrapped, original);
  }

  function markListFirstLoad() {
    listFirstLoad = true;
  }

  function status() {
    return { enabled, disabledReason, listFirstLoad };
  }

  function snapshot() {
    return {
      state: !enabled ? "off" : (disabledReason ? "disabled" : "on"),
      reason: disabledReason,
      masked: maskedTotal,
      calls,
    };
  }

  return { wrapList, wrapReconcile, markListFirstLoad, isOwnedHubEcho, snapshot, status, disable };
}

module.exports = { createSovCaptureEchoSkip, isOwnedHubEcho, TYPE_INFRASTRUCTURE_HUB, MARKER };
