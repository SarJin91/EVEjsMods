"use strict";

const { loadSnapshotSync, createSnapshotWriter } = require("./externalPriceStore");

const STATE = Object.freeze({ READY: "ready", FETCHING: "fetching", STOPPED: "stopped" });
const DETAIL_MAX = 200;

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}

function log(logger, line) {
  if (logger && typeof logger.log === "function") {
    try { logger.log(line); } catch (_err) {}
  }
}

function intOr(v, def) {
  return Number.isSafeInteger(v) && v > 0 ? v : def;
}

function detailOf(x) {
  return x === undefined || x === null ? null : String(x).slice(0, DETAIL_MAX);
}

function createExternalPrices(deps) {
  const { adapter, config, clock, filePath = null, typeIds = [], telemetry = null, logger = null, fs,
    requiredTypeIds = [] } = deps || {};
  const tradeCfg = (config && config.trade) || {};
  const enabled = tradeCfg.externalPriceEnabled === true;
  const stationId = intOr(tradeCfg.externalPriceStationId, 60003760);
  const refreshMs = intOr(tradeCfg.externalPriceRefreshMs, 21600000);
  const retryMs = intOr(tradeCfg.externalPriceRetryMs, 3600000);
  const maxAgeMs = intOr(tradeCfg.externalPriceMaxAgeMs, 172800000);
  const timeoutMs = intOr(tradeCfg.externalPriceTimeoutMs, 10000);
  const maxResponseBytes = intOr(tradeCfg.externalPriceMaxResponseBytes, 65536);
  const maxUnitPriceMilli = intOr(tradeCfg.maxUnitPriceMilli, 1000000000000);
  const ids = Object.freeze([...typeIds]);
  const required = Object.freeze(Array.isArray(requiredTypeIds) ? requiredTypeIds.filter((t) => intOr(t, 0) > 0) : []);
  let coverageMissing = 0;

  let state = STATE.READY;
  let snapshot = null;
  let nextFetchAt = 0;
  let inFlight = null;
  let changed = false;
  let seq = 0;
  let fetched = 0;
  let failed = 0;
  const failuresByReason = {};
  let lastError = null;
  let lastErrorAt = null;
  let typesAccepted = 0;
  let rejectedByReason = {};
  let loadRefusal = null;
  let persist = filePath ? "ok" : "unavailable";

  const writer = filePath ? createSnapshotWriter(filePath, {
    ...(fs ? { fs } : {}),
    onError: (detail) => {
      if (persist !== "failing") log(logger, `[trade] external prices: snapshot write failed - ${detail}`);
      persist = "failing";
      metric(telemetry, "trade.externalPricePersistFailed", 1);
    },
    onSaved: () => { persist = "ok"; },
  }) : null;

  function load(now) {
    try {
      if (!filePath) { nextFetchAt = now; return; }
      const r = loadSnapshotSync(filePath, { stationId, now, maxBytes: maxResponseBytes, maxUnitPriceMilli,
        ...(fs ? { fs } : {}) });
      if (r.ok && r.snapshot) {
        snapshot = r.snapshot;
        nextFetchAt = r.snapshot.fetchedAt + refreshMs;
        typesAccepted = r.snapshot.prices.size;
        log(logger, `[trade] external prices: snapshot loaded (${r.snapshot.prices.size} types, `
          + `fetchedAt ${r.snapshot.fetchedAt})`);
        coverageMissing = required.filter((t) => !r.snapshot.prices.has(t)).length;
        if (coverageMissing > 0) {
          nextFetchAt = now;
          log(logger, `[trade] external prices: snapshot lacks ${coverageMissing} commodity types - fetch now`);
        }
        return;
      }
      if (!r.ok) {
        loadRefusal = r.detail ? `${r.reason} ${r.detail}` : r.reason;
        log(logger, `[trade] external prices: snapshot file refused - ${loadRefusal}`);
      }
      nextFetchAt = now;
    } catch (err) {
      loadRefusal = `EXT_FILE_READ ${detailOf((err && err.message) || err)}`;
      nextFetchAt = now;
    }
  }

  function failure(reason, detail) {
    failed += 1;
    failuresByReason[reason] = (failuresByReason[reason] || 0) + 1;
    const text = detail ? `${reason} ${detailOf(detail)}` : reason;
    const changedReason = lastError === null || !lastError.startsWith(reason);
    lastError = text;
    lastErrorAt = clock.now();
    metric(telemetry, "trade.externalPriceFetchFailed", 1);
    if (changedReason) log(logger, `[trade] external prices: fetch failed - ${text} (local prices stay in use)`);
  }

  function success(prices, rejected) {
    const accepted = new Map();
    for (const typeId of ids) {
      const e = prices.get(typeId);
      if (e && Number.isSafeInteger(e.bidMilli) && e.bidMilli > 0 && Number.isSafeInteger(e.askMilli)
        && e.askMilli > 0) {
        accepted.set(typeId, Object.freeze({ bidMilli: e.bidMilli, askMilli: e.askMilli }));
      }
    }
    const byReason = {};
    if (rejected instanceof Map) {
      for (const reason of rejected.values()) byReason[reason] = (byReason[reason] || 0) + 1;
      if (rejected.size > 0) metric(telemetry, "trade.externalPriceTypeRejected", rejected.size);
    }
    rejectedByReason = byReason;
    if (accepted.size === 0) { failure("EXT_NO_VALID_TYPES"); return; }
    const fetchedAt = clock.now();
    snapshot = { stationId, fetchedAt, prices: accepted };
    seq += 1;
    changed = true;
    nextFetchAt = fetchedAt + refreshMs;
    fetched += 1;
    typesAccepted = accepted.size;
    coverageMissing = required.filter((t) => !accepted.has(t)).length;
    metric(telemetry, "trade.externalPriceFetched", 1);
    if (lastError !== null) log(logger, `[trade] external prices: fetch ok again (${accepted.size} types)`);
    lastError = null;
    if (writer) writer.save(snapshot);
  }

  function maybeRefresh(now) {
    if (!enabled) return { started: false, reason: "OFF" };
    if (state === STATE.STOPPED) return { started: false, reason: "STOPPED" };
    if (inFlight !== null) return { started: false, reason: "IN_FLIGHT" };
    if (now < nextFetchAt) return { started: false, reason: "NOT_DUE" };
    nextFetchAt = now + retryMs;
    const controller = new AbortController();
    inFlight = controller;
    state = STATE.FETCHING;
    const done = () => {
      if (inFlight === controller) inFlight = null;
      if (state === STATE.FETCHING) state = STATE.READY;
    };
    let pending;
    try {
      pending = adapter.fetchExternalPrices({
        typeIds: [...ids], stationId, timeoutMs, maxResponseBytes, maxUnitPriceMilli, signal: controller.signal,
      });
    } catch (err) {
      done();
      failure("EXT_THREW", (err && err.message) || err);
      return { started: true };
    }
    Promise.resolve(pending).then((res) => {
      if (inFlight !== controller || state === STATE.STOPPED) return;
      done();
      if (!res || res.ok !== true || !(res.prices instanceof Map)) {
        failure(String((res && res.reason) || "EXT_BAD_RESULT"), res && res.detail);
        return;
      }
      success(res.prices, res.rejected);
    }, (err) => {
      if (inFlight !== controller || state === STATE.STOPPED) return;
      done();
      failure("EXT_THREW", (err && err.message) || err);
    }).catch(() => { done(); });
    return { started: true };
  }

  function peekSnapshot(now) {
    if (snapshot === null) return null;
    if (now - snapshot.fetchedAt > maxAgeMs) return null;
    return snapshot;
  }

  function consumeChanged() {
    const was = changed;
    changed = false;
    return was;
  }

  function getStatus() {
    let now = null;
    try { now = clock.now(); } catch (_err) {}
    const fetchedAt = snapshot ? snapshot.fetchedAt : null;
    const ageMs = fetchedAt !== null && now !== null ? now - fetchedAt : null;
    return Object.freeze({
      state,
      source: "fuzzwork",
      stationId,
      fetchedAt,
      ageMs,
      stale: ageMs !== null && ageMs > maxAgeMs,
      nextFetchAt,
      seq,
      fetched,
      failed,
      failuresByReason: Object.freeze({ ...failuresByReason }),
      lastError,
      lastErrorAt,
      typesAccepted,
      rejectedByReason: Object.freeze({ ...rejectedByReason }),
      persist,
      loadRefusal,
      refreshMs,
      maxAgeMs,
      ...(required.length > 0 ? { coverageMissing } : {}),
    });
  }

  function stop() {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    const c = inFlight;
    inFlight = null;
    if (c) {
      try { c.abort(); } catch (_err) {}
    }
  }

  return Object.freeze({ load, maybeRefresh, peekSnapshot, consumeChanged, getStatus, stop });
}

module.exports = { createExternalPrices };
