"use strict";

const { normalizeLine } = require("./filter");

const EMPTY = Object.freeze([]);

function validLine(x) {
  return x && typeof x.id === "string" && x.id !== "" && typeof x.text === "string" && x.text !== "";
}

function createTemplatePool(S) {
  const cap = Number.isSafeInteger(S && S.poolPerBucket) && S.poolPerBucket > 0 ? S.poolPerBucket : 0;
  const maxAge = Number.isSafeInteger(S && S.lineMaxAgeMs) && S.lineMaxAgeMs >= 0 ? S.lineMaxAgeMs : 0;
  const buckets = new Map();

  function listOf(key) {
    return typeof key === "string" ? buckets.get(key) || null : null;
  }

  return Object.freeze({
    add(bucketKey, lines, now) {
      if (typeof bucketKey !== "string" || bucketKey === "" || !Array.isArray(lines) || cap === 0) return 0;
      let list = buckets.get(bucketKey);
      if (!list) {
        list = [];
        buckets.set(bucketKey, list);
      }
      let added = 0;
      for (const x of lines) {
        if (!validLine(x) || list.some((e) => e.id === x.id)) continue;
        list.push({ id: x.id, text: x.text, norm: normalizeLine(x.text), at: now });
        added += 1;
      }
      while (list.length > cap) list.shift();
      return added;
    },
    linesOf(bucketKey) {
      const list = listOf(bucketKey);
      if (!list || list.length === 0) return EMPTY;
      return Object.freeze(list.map((e) => Object.freeze({ id: e.id, text: e.text })));
    },
    prune(now) {
      let removed = 0;
      for (const list of buckets.values()) {
        while (list.length > 0 && now - list[0].at > maxAge) {
          list.shift();
          removed += 1;
        }
      }
      return removed;
    },
    sizeOf(bucketKey) {
      const list = listOf(bucketKey);
      return list ? list.length : 0;
    },
    knownNormalized(bucketKey) {
      const list = listOf(bucketKey);
      return new Set(list ? list.map((e) => e.norm) : []);
    },
    totals() {
      let filled = 0;
      let lines = 0;
      for (const list of buckets.values()) {
        if (list.length > 0) filled += 1;
        lines += list.length;
      }
      return { buckets: buckets.size, filled, lines };
    },
    clear() {
      buckets.clear();
    },
  });
}

module.exports = { createTemplatePool };
