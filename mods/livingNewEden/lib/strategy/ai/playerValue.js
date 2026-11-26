"use strict";

function premiumExtra(valueMap, systemId, claimed, P) {
  if (!(valueMap instanceof Map) || !P) return 0;
  const v = valueMap.get(systemId);
  if (!Number.isSafeInteger(v) || v <= 0) return 0;
  const cap = Number.isSafeInteger(P.valueCap) && P.valueCap >= 0 ? P.valueCap : 0;
  const capped = Math.min(cap, v);
  if (claimed === true) return capped;
  const permille = Number.isSafeInteger(P.unclaimedPermille) && P.unclaimedPermille > 0 ? P.unclaimedPermille : 0;
  return Math.floor(capped * permille / 1000);
}

function valueIn(valueMap, systemId) {
  if (!(valueMap instanceof Map)) return 0;
  const v = valueMap.get(systemId);
  return Number.isSafeInteger(v) && v > 0 ? v : 0;
}

module.exports = { premiumExtra, valueIn };
