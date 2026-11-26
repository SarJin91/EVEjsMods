"use strict";

const { WORMHOLE_REGION_ID_MIN } = require("../config");

const SIDES = Object.freeze(["sells", "buys"]);

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function computeRegionIDs(solarSystems, { includeWormholeRegions } = {}) {
  const ids = new Set();
  for (const system of toArray(solarSystems)) {
    const regionID = Number(system && system.regionID);
    if (!Number.isInteger(regionID) || regionID <= 0) continue;
    if (!includeWormholeRegions && regionID >= WORMHOLE_REGION_ID_MIN) continue;
    ids.add(regionID);
  }
  return [...ids].sort((left, right) => left - right);
}

function compareOrderIDs(left, right) {
  const a = String(left == null ? "" : left);
  const b = String(right == null ? "" : right);
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareNumbers(left, right) {
  const a = Number(left);
  const b = Number(right);
  const safeA = Number.isFinite(a) ? a : 0;
  const safeB = Number.isFinite(b) ? b : 0;
  return safeA - safeB;
}

function rankForeignRowsDetailed(rows, side, limit) {
  const priced = [];
  let dropped = 0;
  for (const row of toArray(rows)) {
    if (row && Number.isFinite(Number(row.price))) priced.push(row);
    else dropped += 1;
  }
  const direction = side === "buys" ? -1 : 1;
  priced.sort((left, right) => (
    direction * (Number(left.price) - Number(right.price)) ||
    compareNumbers(left.region_id, right.region_id) ||
    compareNumbers(left.station_id, right.station_id) ||
    compareOrderIDs(left.order_id, right.order_id)
  ));
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  const kept = keepTopPerExcludedRegion(priced, max);
  return { rows: kept, dropped, trimmed: priced.length - kept.length };
}

function keepTopPerExcludedRegion(sortedRows, limit) {
  if (limit <= 0) return [];
  const counts = new Map();
  let top1 = { region: null, count: 0 };
  let top2 = { region: null, count: 0 };
  const kept = [];
  sortedRows.forEach((row, index) => {
    const region = String(row.region_id);
    const bestOther = top1.region !== region ? top1.count : top2.count;
    if (index - bestOther < limit) kept.push(row);
    const count = (counts.get(region) || 0) + 1;
    counts.set(region, count);
    if (top1.region === region) {
      top1 = { region, count };
    } else if (count > top1.count) {
      top2 = top1;
      top1 = { region, count };
    } else if (top2.region === region || count > top2.count) {
      top2 = { region, count };
    }
  });
  return kept;
}

function rankForeignRows(rows, side, limit) {
  return rankForeignRowsDetailed(rows, side, limit).rows;
}

function mergeBooks(ownResult, foreign, ownRegionID, limit = Number.POSITIVE_INFINITY) {
  const own = ownResult && typeof ownResult === "object" ? ownResult : {};
  const merged = { ...own };
  for (const side of SIDES) {
    const foreignRows = toArray(foreign && foreign[side])
      .filter((row) => Number(row && row.region_id) !== Number(ownRegionID))
      .slice(0, limit);
    merged[side] = [...toArray(own[side]), ...foreignRows];
  }
  return merged;
}

function createRateLimitedLogger(logError, intervalMs, now) {
  let windowStart = null;
  let suppressed = 0;
  return function rateLimited(message) {
    const at = now();
    if (intervalMs > 0 && windowStart != null && at - windowStart < intervalMs) {
      suppressed += 1;
      return;
    }
    const tail = suppressed > 0 ? ` (+${suppressed} suppressed)` : "";
    windowStart = at;
    suppressed = 0;
    logError(`${message}${tail}`);
  };
}

function createAllRegionsReader(deps) {
  const config = deps.config;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const logError = deps.logError || (() => {});
  const logRegionError = createRateLimitedLogger(logError, config.errorLogIntervalMs, now);

  const cache = new Map();
  const inflight = new Map();
  let regionIDs = null;
  let regionListProblemLogged = false;

  const counters = {
    requests: 0,
    fanouts: 0,
    cacheHits: 0,
    inflightJoins: 0,
    regionErrors: 0,
    wrapperErrors: 0,
    droppedRows: 0,
    trimmedRows: 0,
    lastFanoutMs: 0,
    maxFanoutMs: 0,
  };

  function getRegionIDs() {
    if (regionIDs) return regionIDs;
    let listed = null;
    try {
      listed = deps.listRegionIDs();
    } catch (error) {
      if (!regionListProblemLogged) {
        regionListProblemLogged = true;
        logError(`region list unavailable (${(error && error.message) || error}) - own region only`);
      }
      return [];
    }
    const clean = toArray(listed).filter((id) => Number.isInteger(id) && id > 0);
    if (clean.length === 0) {
      if (!regionListProblemLogged) {
        regionListProblemLogged = true;
        logError("region list is empty - own region only");
      }
      return [];
    }
    regionIDs = clean;
    return regionIDs;
  }

  async function fanOut(typeID, callRegion) {
    const startedAt = now();
    const regions = getRegionIDs();
    const collected = { sells: [], buys: [] };
    let failedRegions = 0;
    let next = 0;

    async function worker() {
      while (next < regions.length) {
        const regionID = regions[next];
        next += 1;
        try {
          const result = await callRegion(regionID);
          for (const side of SIDES) {
            for (const row of toArray(result && result[side])) collected[side].push(row);
          }
        } catch (error) {
          failedRegions += 1;
          counters.regionErrors += 1;
          logRegionError(
            `GetOrders region=${regionID} type=${typeID} failed (${(error && error.message) || error}) - region skipped`,
          );
        }
      }
    }

    const workers = [];
    const width = Math.min(config.fanoutConcurrency, regions.length);
    for (let index = 0; index < width; index += 1) workers.push(worker());
    await Promise.all(workers);

    const result = { sells: [], buys: [], failedRegions, complete: regions.length > 0 };
    for (const side of SIDES) {
      const ranked = rankForeignRowsDetailed(collected[side], side, config.maxForeignRowsPerSide);
      counters.droppedRows += ranked.dropped;
      counters.trimmedRows += ranked.trimmed;
      result[side] = ranked.rows;
    }
    counters.fanouts += 1;
    const elapsed = Math.max(0, now() - startedAt);
    counters.lastFanoutMs = elapsed;
    counters.maxFanoutMs = Math.max(counters.maxFanoutMs, elapsed);
    if (config.verbose) {
      log(
        `fan-out type=${typeID} regions=${regions.length} errors=${failedRegions} ` +
          `sells=${result.sells.length} buys=${result.buys.length} ${elapsed} ms`,
      );
    }
    if (failedRegions === 0 && result.complete && config.cacheTtlMs > 0) {
      cache.delete(typeID);
      cache.set(typeID, { at: now(), sells: result.sells, buys: result.buys, regionCount: regions.length });
      while (cache.size > config.cacheMaxTypes) cache.delete(cache.keys().next().value);
    }
    return result;
  }

  function getForeign(typeID, callRegion) {
    const entry = cache.get(typeID);
    if (entry) {
      if (now() - entry.at < config.cacheTtlMs) {
        counters.cacheHits += 1;
        cache.delete(typeID);
        cache.set(typeID, entry);
        return Promise.resolve(entry);
      }
      cache.delete(typeID);
    }
    const pending = inflight.get(typeID);
    if (pending) {
      counters.inflightJoins += 1;
      return pending;
    }
    const promise = fanOut(typeID, callRegion)
      .catch((error) => {
        counters.wrapperErrors += 1;
        logError(`fan-out type=${typeID} failed internally (${(error && error.message) || error}) - own region only`);
        return { sells: [], buys: [], failedRegions: 0, complete: false };
      })
      .finally(() => {
        if (inflight.get(typeID) === promise) inflight.delete(typeID);
      });
    inflight.set(typeID, promise);
    return promise;
  }

  async function read({ ownRegionID, typeID, callRegion }) {
    counters.requests += 1;
    const ownPromise = callRegion(ownRegionID);
    if (config.maxForeignRowsPerSide <= 0) return ownPromise;
    const foreignPromise = getForeign(typeID, callRegion);
    const ownResult = await ownPromise;
    const foreign = await foreignPromise;
    try {
      return mergeBooks(ownResult, foreign, ownRegionID, config.maxForeignRowsPerSide);
    } catch (error) {
      recordWrapperError(error);
      return ownResult;
    }
  }

  function recordWrapperError(error) {
    counters.wrapperErrors += 1;
    logError(`wrapper error (${(error && error.message) || error}) - vanilla result for this request`);
  }

  function stats() {
    return Object.freeze({ ...counters, cacheSize: cache.size });
  }

  function clear() {
    cache.clear();
    inflight.clear();
    regionIDs = null;
  }

  return { read, stats, clear, recordWrapperError };
}

module.exports = {
  computeRegionIDs,
  createAllRegionsReader,
  mergeBooks,
  rankForeignRows,
  rankForeignRowsDetailed,
};
