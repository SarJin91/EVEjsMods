"use strict";

function cacheKey(query, options) {
  let opts = "";
  if (options && typeof options === "object" && Object.keys(options).length > 0) {
    try {
      opts = JSON.stringify(options);
    } catch (_error) {
      return null;
    }
  }
  return `${String(query)}\u0000${opts}`;
}

function copyResult(result) {
  if (!result || typeof result !== "object") return result;
  const copy = { ...result };
  if (Array.isArray(result.suggestions)) copy.suggestions = result.suggestions.slice();
  return copy;
}

function createCachedResolver(original, config, stats) {
  const cache = new Map();
  return function resolveItemByNameScenePerf(query, options) {
    const key = cacheKey(query, options);
    if (key === null) return original.apply(this, arguments);
    if (cache.has(key)) {
      stats.hits += 1;
      return copyResult(cache.get(key));
    }
    const result = original.apply(this, arguments);
    stats.misses += 1;
    if (cache.size >= config.itemNameCacheMax) {
      cache.clear();
      stats.clears += 1;
    }
    cache.set(key, copyResult(result));
    return result;
  };
}

module.exports = { createCachedResolver, cacheKey };
