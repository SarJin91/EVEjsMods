"use strict";

const { quote, NO_PRICE, PRICE_TOO_HIGH, INVALID_PRICE, PERMILLE } = require("./pricing");
const S = require("./schema");

const LIMIT = Math.floor(Number.MAX_SAFE_INTEGER / PERMILLE);

const isPos = (v) => Number.isSafeInteger(v) && v >= 1;

function validEntry(entry) {
  return Boolean(entry && isPos(entry.portionSize) && Array.isArray(entry.minerals)
    && entry.minerals.every((p) => Array.isArray(p) && typeof p[0] === "string" && Number.isSafeInteger(p[1])
      && p[1] >= 0));
}

function quoteOre(oreRefs, mineralQuotes, entry, p) {
  if (!validEntry(entry) || !p || !Number.isSafeInteger(p.efficiencyPermille) || p.efficiencyPermille < 0
    || p.efficiencyPermille > PERMILLE) return INVALID_PRICE;
  if (!oreRefs) return NO_PRICE;
  const q = quote(oreRefs, { premiumPermille: p.premiumPermille, askCapPermille: p.askCapPermille, bonusPermille: 0,
    maxUnitPriceMilli: p.maxUnitPriceMilli });
  if (!q.ok) return q;
  const quotes = mineralQuotes && typeof mineralQuotes === "object" ? mineralQuotes : {};
  let sum = 0;
  for (const [key, amount] of entry.minerals) {
    if (amount === 0) continue;
    const mq = Object.prototype.hasOwnProperty.call(quotes, key) ? quotes[key] : null;
    if (!mq || mq.ok !== true || !isPos(mq.unitMilli)) return NO_PRICE;
    if (amount > LIMIT / mq.unitMilli) return PRICE_TOO_HIGH;
    const term = amount * mq.unitMilli;
    if (term > LIMIT) return PRICE_TOO_HIGH;
    sum += term;
    if (sum > LIMIT) return PRICE_TOO_HIGH;
  }
  const refinedCapMilli = Math.floor((sum * p.efficiencyPermille) / (entry.portionSize * PERMILLE));
  if (refinedCapMilli < 1) return NO_PRICE;
  return Object.freeze({
    ok: true,
    itemKind: S.ITEM_KIND_ORE,
    unitMilli: Math.min(q.unitMilli, refinedCapMilli),
    refMilli: q.refMilli,
    capMilli: Math.min(q.capMilli, refinedCapMilli),
    source: q.source,
    capped: q.capped,
    marketUnitMilli: q.unitMilli,
    refinedCapMilli,
    refineCapped: refinedCapMilli < q.unitMilli,
  });
}

function refineOre(spec) {
  const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
  if (!spec || typeof spec !== "object") return invalid("spec");
  const { voided, portionSize, efficiencyPermille, minerals, headroom } = spec;
  if (!Number.isSafeInteger(voided) || voided < 0) return invalid("voided");
  if (!isPos(portionSize)) return invalid("portionSize");
  if (!Number.isSafeInteger(efficiencyPermille) || efficiencyPermille < 0 || efficiencyPermille > PERMILLE) {
    return invalid("efficiencyPermille");
  }
  if (!validEntry({ portionSize, minerals })) return invalid("minerals");
  if (!(headroom instanceof Map)) return invalid("headroom");

  const whole = Math.floor(voided / portionSize);
  const remainder = voided - whole * portionSize;
  let portions = whole;
  const parts = [];
  for (const [itemKey, amount] of minerals) {
    const a = amount * efficiencyPermille;
    if (!Number.isSafeInteger(a)) return invalid("minerals");
    if (a === 0) continue;
    const hRaw = headroom.has(itemKey) ? headroom.get(itemKey) : 0;
    if (!Number.isSafeInteger(hRaw)) return invalid("headroom");
    const h = Math.max(0, hRaw);
    const pMax = Math.floor((PERMILLE * (h + 1) - 1) / a);
    const limit = Math.floor(Number.MAX_SAFE_INTEGER / a);
    portions = Math.min(portions, pMax, limit);
    parts.push([itemKey, a]);
  }
  portions = Math.max(0, portions);
  const deltas = [];
  for (const [itemKey, a] of parts) {
    const delta = Math.floor((portions * a) / PERMILLE);
    if (delta > 0) deltas.push({ itemKey, delta });
  }
  deltas.sort((x, y) => (x.itemKey < y.itemKey ? -1 : x.itemKey > y.itemKey ? 1 : 0));
  return { ok: true, portions, remainder, cut: portions < whole, deltas };
}

module.exports = { quoteOre, refineOre, NO_PRICE, PRICE_TOO_HIGH };
