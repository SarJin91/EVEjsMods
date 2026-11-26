"use strict";

const { fingerprintFunctions } = require("./blueprintOwnerRead");

const DETAIL_MAX = 200;

const STATE_FUNCTIONS = Object.freeze([
  "readState", "normalizeState", "getPool", "normalizePool", "resolveOwnerAffiliation", "inferOwnerKind",
]);
const CHAR_FUNCTIONS = Object.freeze(["getCharacterRecord", "readSharedCharacterRecord"]);
const PROXY_FUNCTIONS = Object.freeze(["buildBountyEntry", "buildBountyEntries"]);

const FINGERPRINTS = Object.freeze({
  state: Object.freeze({
    readState: "e88f1ee96b50a85780c16394411fe591a3b5f915",
    normalizeState: "6862f50f31f3fa9bfcebc5df7f9a34be58fe3f07",
    getPool: "f69d70c99d67caf324ac8e9560f6afa505471644",
    normalizePool: "02df973a553322d74a59ef8bcc04a4d05ebe396e",
    resolveOwnerAffiliation: "067bfadaf0927c95834b6e95a0fabad83c320579",
    inferOwnerKind: "36f99d7ede22f0b80ac58ad8b82d23228cd5fb99",
  }),
  char: Object.freeze({
    getCharacterRecord: "6552b17eafb3004cc33300acf585ad90d98f10ac",
    readSharedCharacterRecord: "e3997b5ac0dc3d8521b77668eae15e09dfb4129a",
  }),
  proxy: Object.freeze({
    buildBountyEntry: "4c29845a33982c3d157e4d2989a788bb990ac5df",
    buildBountyEntries: "ac0bcffd15ae4f078d6add61bfe2a6903b6882a6",
  }),
});

const PARITY_FIELDS = Object.freeze(["targetID", "targetKind", "corporationID", "allianceID", "bounty"]);

function bodyOf(text, name) {
  const lfText = String(text || "").replace(/\r\n/g, "\n");
  const start = lfText.indexOf(`\nfunction ${name}(`);
  if (start < 0) return "";
  const end = lfText.indexOf("\n}\n", start);
  return lfText.slice(start, end < 0 ? lfText.length : end);
}

function fixedUpstream(src) {
  const entries = bodyOf(src && src.proxySource, "buildBountyEntries");
  const pools = bodyOf(src && src.stateSource, "getPools");
  return entries.includes("playerBountyState.getPools(") && !entries.includes("buildBountyEntry(") &&
    pools.includes("const state = options.state || readState();") && pools.includes("getPool(state, targetID)");
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfBounty", { value: original });
  return wrapper;
}

function emptyWindow() {
  return { handlers: 0, ids: 0, idsMax: 0, stateReads: 0, charServed: 0, charMemoHits: 0, passthrough: 0, fallback: {}, parityChecks: 0 };
}

function samePool(a, b, withUpdatedAt) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  for (const field of PARITY_FIELDS) if (a[field] !== b[field]) return false;
  return !withUpdatedAt || a.updatedAt === b.updatedAt;
}

function createBountyPoolRead(options) {
  const config = options.config || {};
  const log = options.log;
  const priv = {
    readState: null,
    readShared: null,
    fingerprintOk: false,
    disabledReason: null,
    scope: null,
    depth: 0,
    reentrant: false,
    window: emptyWindow(),
  };

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    log(`WARN bountyPoolRead disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function isReady() {
    return priv.disabledReason === null && priv.fingerprintOk && priv.readState !== null && priv.readShared !== null;
  }

  function fallback(reason) {
    priv.window.fallback[reason] = (priv.window.fallback[reason] || 0) + 1;
  }

  function setPoolDeps(stateExports) {
    if (priv.readState) return true;
    const testing = stateExports && stateExports._testing;
    if (!testing || typeof testing.readState !== "function") return false;
    priv.readState = testing.readState;
    return true;
  }

  function setCharDeps(charExports) {
    if (priv.readShared) return true;
    if (!charExports || typeof charExports.readSharedCharacterRecord !== "function") return false;
    priv.readShared = charExports.readSharedCharacterRecord;
    return true;
  }

  function checkFingerprint(src) {
    const groups = [
      [fingerprintFunctions(src && src.stateSource, STATE_FUNCTIONS), FINGERPRINTS.state],
      [fingerprintFunctions(src && src.charSource, CHAR_FUNCTIONS), FINGERPRINTS.char],
      [fingerprintFunctions(src && src.proxySource, PROXY_FUNCTIONS), FINGERPRINTS.proxy],
    ];
    for (const [got, expected] of groups) {
      for (const name of Object.keys(expected)) {
        if (got.get(name) !== expected[name]) return { ok: false, reason: "drift", detail: name };
      }
    }
    priv.fingerprintOk = true;
    return { ok: true };
  }

  function wrapScope(original) {
    const wrapped = function hotPathPerfBountyScope() {
      priv.depth += 1;
      if (priv.depth === 1) {
        if (isReady()) priv.scope = { state: undefined, chars: new Map(), inPool: false, ids: 0 };
        else fallback(priv.disabledReason ? "disabled" : "waiting");
      }
      try {
        return original.apply(this, arguments);
      } finally {
        priv.depth -= 1;
        if (priv.depth === 0) {
          const scope = priv.scope;
          priv.scope = null;
          priv.reentrant = false;
          const w = priv.window;
          w.handlers += 1;
          if (scope) {
            w.ids += scope.ids;
            if (scope.ids > w.idsMax) w.idsMax = scope.ids;
          }
        }
      }
    };
    return markWrapped(wrapped, original);
  }

  function wrapGetPool(original) {
    const wrapped = function hotPathPerfBountyPool(state, targetID) {
      const scope = priv.scope;
      if (scope === null || arguments.length < 2) {
        priv.window.passthrough += 1;
        return original.apply(this, arguments);
      }
      if (!isReady() || (state !== null && state !== undefined)) {
        priv.window.passthrough += 1;
        fallback(!isReady() ? "disabled" : "stateArg");
        return original.apply(this, arguments);
      }
      scope.ids += 1;
      if (scope.state === undefined) {
        try {
          scope.state = priv.readState();
        } catch (error) {
          disable("error", String(error && error.message || error));
          fallback("error");
          return original.apply(this, arguments);
        }
        priv.window.stateReads += 1;
      }
      let result;
      scope.inPool = true;
      try {
        result = original.call(this, scope.state, targetID);
      } finally {
        scope.inPool = false;
      }
      if (config.bountyPoolReadParityCheck === true) {
        const vendor = original.call(this, null, targetID);
        priv.window.parityChecks += 1;
        const pools = scope.state && scope.state.pools;
        const stored = pools && typeof pools === "object" ? pools[String(Math.trunc(Number(targetID)))] : null;
        if (!samePool(result, vendor, Boolean(stored && stored.updatedAt))) {
          disable("parity", `targetID=${targetID}`);
          fallback("parity");
          return vendor;
        }
      }
      return result;
    };
    return markWrapped(wrapped, original);
  }

  function wrapGetCharacterRecord(original) {
    const wrapped = function hotPathPerfBountyChar(charId) {
      const scope = priv.scope;
      if (scope === null || !scope.inPool || priv.reentrant || arguments.length !== 1 || !isReady()) {
        return original.apply(this, arguments);
      }
      const key = String(charId);
      let record;
      if (scope.chars.has(key)) {
        record = scope.chars.get(key);
        priv.window.charMemoHits += 1;
      } else {
        priv.reentrant = true;
        try {
          record = priv.readShared(charId);
        } finally {
          priv.reentrant = false;
        }
        record = record ? record : null;
        scope.chars.set(key, record);
      }
      priv.window.charServed += 1;
      return record;
    };
    return markWrapped(wrapped, original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return isReady() ? "ready" : "waiting";
  }

  function status() {
    return { enabled: priv.disabledReason === null, ready: isReady(), disabledReason: priv.disabledReason, state: stateText() };
  }

  function statsSnapshot() {
    return { ...status(), ...priv.window, fallback: { ...priv.window.fallback } };
  }

  function drainStatsLines() {
    const w = priv.window;
    if (w.handlers === 0) return [];
    const fb = Object.keys(w.fallback).sort().map((k) => `${k}:${w.fallback[k]}`).join(",");
    const line = `stats bountyPoolRead state=${stateText()} handlers=${w.handlers} ids=${w.ids} idsMax=${w.idsMax} ` +
      `stateReads=${w.stateReads} charServed=${w.charServed} charMemoHits=${w.charMemoHits} passthrough=${w.passthrough} ` +
      `fallback=${fb || "-"} parityChecks=${w.parityChecks}`;
    priv.window = emptyWindow();
    return [line];
  }

  return {
    setPoolDeps, setCharDeps, checkFingerprint, wrapScope, wrapGetPool, wrapGetCharacterRecord, disable, status,
    statsSnapshot, drainStatsLines,
  };
}

module.exports = { createBountyPoolRead, fixedUpstream, FINGERPRINTS, STATE_FUNCTIONS, CHAR_FUNCTIONS, PROXY_FUNCTIONS };
