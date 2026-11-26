"use strict";

const isTypeId = (v) => Number.isSafeInteger(v) && v > 0;

function typesToPrice(losses, knownTypeIds) {
  const out = new Set();
  for (const loss of Array.isArray(losses) ? losses : []) {
    const typeId = loss ? loss.typeId : null;
    if (!isTypeId(typeId)) continue;
    if (knownTypeIds && typeof knownTypeIds.has === "function" && knownTypeIds.has(typeId)) continue;
    out.add(typeId);
  }
  return [...out].sort((a, b) => a - b);
}

function priceFromBasePrice(basePrice) {
  if (typeof basePrice !== "number" || !Number.isFinite(basePrice) || basePrice <= 0) return null;
  const isk = Math.round(basePrice);
  return Number.isSafeInteger(isk) && isk > 0 ? isk : null;
}

function iskOf(count, priceIsk) {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  if (!Number.isSafeInteger(priceIsk) || priceIsk < 0) return null;
  const isk = count * priceIsk;
  return Number.isSafeInteger(isk) ? isk : null;
}

module.exports = { typesToPrice, priceFromBasePrice, iskOf };
