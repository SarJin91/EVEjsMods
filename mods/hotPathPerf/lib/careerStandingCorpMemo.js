"use strict";

const crypto = require("crypto");
const { fingerprintFunctions, canonical } = require("./blueprintOwnerRead");

const MARKER_OBSERVE = "__hotPathPerfCareerStanding";
const MARKER_CORP = "__hotPathPerfCorpMemo";
const DETAIL_MAX = 200;

const FINGERPRINTS = Object.freeze({
  careerStanding: "8f6ca12400440b28df2c4ba688887cb749fc8b0b",
  corporationState: Object.freeze({ getCorporationRecord: "8ea61b58352596645c0d938cb513cab502517c02" }),
});

const UPSTREAM_MARKERS = Object.freeze([
  "const histories = context.careerStandingHistories ||= new Map();",
  "if (!evidence.npcCorporations.has(ownerID)) {",
  "evidence.npcCorporations.set(ownerID, corp?.isNPC === true);",
]);

function fixedUpstream(careerStandingSource) {
  const text = String(careerStandingSource || "").replace(/\r\n/g, "\n");
  return UPSTREAM_MARKERS.every((marker) => text.includes(marker)) && text.split("getCorporationRecord(").length - 1 === 1;
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function sha1Lf(text) {
  return crypto.createHash("sha1").update(String(text || "").replace(/\r\n/g, "\n")).digest("hex");
}

function emptyWindow() {
  return { observes: 0, calls: 0, vendorCalls: 0, hits: 0, parityChecks: 0 };
}

function createCareerStandingCorpMemo(options) {
  const config = (options && options.config) || {};
  const log = (options && options.log) || (() => {});
  const parityCheck = config.careerStandingCorpMemoParityCheck === true;
  let disabledReason = null;
  let depth = 0;
  let memo = null;
  let win = emptyWindow();

  function disable(reason, detail) {
    if (disabledReason) return;
    disabledReason = String(reason);
    log(`WARN careerStandingCorpMemo disabled: ${disabledReason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function checkSource(key, text) {
    if (disabledReason) return false;
    let ok = false;
    if (key === "careerStanding") {
      ok = Boolean(text) && sha1Lf(text) === FINGERPRINTS.careerStanding;
    } else if (key === "corporationState") {
      const got = fingerprintFunctions(text, ["getCorporationRecord"]).get("getCorporationRecord");
      ok = got === FINGERPRINTS.corporationState.getCorporationRecord;
    }
    if (!ok) disable("drift", key);
    return ok;
  }

  function wrapObserve(original) {
    if (typeof original !== "function" || original[MARKER_OBSERVE]) return original;
    const wrapped = function hotPathPerfCareerStandingObserve() {
      if (disabledReason) return original.apply(this, arguments);
      depth += 1;
      if (depth === 1) {
        memo = new Map();
        win.observes += 1;
      }
      try {
        return original.apply(this, arguments);
      } finally {
        depth -= 1;
        if (depth === 0) memo = null;
      }
    };
    Object.defineProperty(wrapped, MARKER_OBSERVE, { value: original });
    return wrapped;
  }

  function wrapGetCorporationRecord(original) {
    if (typeof original !== "function" || original[MARKER_CORP]) return original;
    const wrapped = function hotPathPerfCorpMemoGetCorporationRecord(corporationID) {
      if (disabledReason || memo === null || arguments.length > 1) return original.apply(this, arguments);
      const scope = memo;
      let key;
      let hit = false;
      let cached;
      try {
        key = Number(corporationID);
        win.calls += 1;
        hit = scope.has(key);
        if (hit) cached = scope.get(key);
      } catch (error) {
        disable("error", error && error.message || error);
        return original.apply(this, arguments);
      }
      if (!hit) {
        const value = original.call(this, corporationID);
        win.vendorCalls += 1;
        scope.set(key, value);
        return value;
      }
      win.hits += 1;
      if (!parityCheck) return cached;
      win.parityChecks += 1;
      const fresh = original.call(this, corporationID);
      let same = false;
      try {
        same = canonical(fresh) === canonical(cached);
      } catch (_error) {
        same = false;
      }
      if (!same) {
        disable("parity", `corporationID=${key}`);
        return fresh;
      }
      return cached;
    };
    Object.defineProperty(wrapped, MARKER_CORP, { value: original });
    return wrapped;
  }

  function status() {
    return { disabledReason };
  }

  function stateText() {
    return disabledReason ? `disabled:${disabledReason}` : "on";
  }

  function takeStats() {
    const w = win;
    if (w.observes === 0 && w.calls === 0) return null;
    win = emptyWindow();
    return { ...w };
  }

  function drainStatsLines() {
    const s = takeStats();
    if (!s) return [];
    return [`stats careerStandingCorpMemo state=${stateText()} observes=${s.observes} calls=${s.calls} ` +
      `vendorCalls=${s.vendorCalls} hits=${s.hits} parityChecks=${s.parityChecks}`];
  }

  return { checkSource, wrapObserve, wrapGetCorporationRecord, disable, status, stateText, takeStats, drainStatsLines };
}

module.exports = { createCareerStandingCorpMemo, fixedUpstream, FINGERPRINTS, MARKER_OBSERVE, MARKER_CORP, sha1Lf };
