"use strict";

const { deriveSeed } = require("../util/rng");

const PERMILLE = 1000;

function orderCivilians(characterIds, bucket, seed) {
  const ids = Array.isArray(characterIds) ? characterIds.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  const keyed = [...new Set(ids)].map((id) => ({ id, key: deriveSeed(seed >>> 0, "hs-order", id, bucket) }));
  keyed.sort((a, b) => (a.key - b.key) || (a.id - b.id));
  return keyed.map((k) => k.id);
}

function releasedByChurn(previous, bucket, seed, churnPermille) {
  const out = new Set();
  if (!(previous instanceof Map) || !(churnPermille > 0)) return out;
  for (const charId of previous.keys()) {
    if (deriveSeed(seed >>> 0, "hs-churn", charId, bucket) % PERMILLE < churnPermille) out.add(charId);
  }
  return out;
}

module.exports = { orderCivilians, releasedByChurn };
