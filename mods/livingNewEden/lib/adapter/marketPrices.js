"use strict";

const MAX_UNIT_PRICE_MILLI = 1000000000000;
const REJECTED_CODE = "MARKET_DAEMON_RPC_REJECTED";

function toMilli(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

function clampMilli(v) {
  if (v === null) return null;
  return v > MAX_UNIT_PRICE_MILLI ? null : v;
}

async function readTradePricesFrom(marketDaemon, industryPricing, spec) {
  if (!marketDaemon || typeof marketDaemon.call !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  if (!industryPricing || typeof industryPricing.resolveAdjustedAverageTypePrice !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  if (!spec || !Array.isArray(spec.typeIds) || spec.typeIds.length === 0) {
    return { ok: false, reason: "PRICE_SPEC_INVALID" };
  }
  if (!isId(spec.refRegionId)) {
    return { ok: false, reason: "PRICE_SPEC_INVALID" };
  }
  if (spec.excludeOrderIds !== undefined && spec.excludeOrderIds !== null && !Array.isArray(spec.excludeOrderIds)) {
    return { ok: false, reason: "PRICE_SPEC_INVALID" };
  }
  const excluded = new Set((spec.excludeOrderIds || []).map(orderIdText));
  if (spec.excludeSellTypeIds !== undefined && spec.excludeSellTypeIds !== null
    && !Array.isArray(spec.excludeSellTypeIds)) {
    return { ok: false, reason: "PRICE_SPEC_INVALID" };
  }
  const sellExcludedTypes = new Set((spec.excludeSellTypeIds || []).filter(isId));
  const regionIds = Array.isArray(spec.regionIds) ? spec.regionIds.filter(isId) : [];
  const maxRegions = Math.max(1, Math.min(100, Math.trunc(Number(spec.maxRegions) || 10)));
  const regionsToQuery = regionIds.slice(0, maxRegions).sort((a, b) => a - b);

  const typeIds = spec.typeIds.filter(isId);
  if (typeIds.length === 0) {
    return { ok: true, prices: new Map(), errors: 0, aborted: null, failedTypeIds: [], regionErrors: 0 };
  }

  const prices = new Map();
  let errors = 0;
  const failedTypeIds = [];
  let regionErrors = 0;

  const basePrices = new Map();
  for (const typeId of typeIds) {
    try {
      const base = industryPricing.resolveAdjustedAverageTypePrice(typeId);
      basePrices.set(typeId, toMilli(base));
    } catch (_err) {
      basePrices.set(typeId, null);
    }
  }

  let aborted = null;
  const stopOn = (err) => {
    errors++;
    const code = err && typeof err.code === "string" ? err.code : null;
    if (code === REJECTED_CODE) return false;
    aborted = code || "TRANSPORT";
    return true;
  };

  const regionBestAsk = new Map();
  for (const regionId of regionsToQuery) {
    if (aborted !== null) break;
    try {
      const result = await marketDaemon.call("GetRegionBest", { region_id: regionId });
      const rows = Array.isArray(result) ? result : [];
      const map = new Map();
      for (const row of rows) {
        const typeId = toPositiveInteger(row.type_id, 0);
        const ask = toMilli(row.best_ask_price);
        if (typeId > 0 && ask !== null) {
          map.set(typeId, ask);
        }
      }
      regionBestAsk.set(regionId, map);
    } catch (err) {
      regionErrors++;
      stopOn(err);
    }
  }

  for (const typeId of typeIds) {
    let bidMilli = null;
    let askMilli = null;
    const sellExcluded = sellExcludedTypes.has(typeId);
    let sellsKnown = false;
    let ownSell = false;

    if (aborted === null) {
      try {
        const result = await marketDaemon.call("GetOrders", { region_id: spec.refRegionId, type_id: typeId });
        const buys = Array.isArray(result?.buys) ? result.buys : [];
        const sells = Array.isArray(result?.sells) ? result.sells : [];

        for (const buy of buys) {
          if (excluded.size > 0 && buy && excluded.has(orderIdText(buy.order_id))) continue;
          const p = toMilli(buy.price);
          if (p !== null && (bidMilli === null || p > bidMilli)) bidMilli = p;
        }
        for (const sell of sells) {
          if (sellExcluded && excluded.size > 0 && sell && excluded.has(orderIdText(sell.order_id))) {
            ownSell = true;
            continue;
          }
          const p = toMilli(sell.price);
          if (p !== null && (askMilli === null || p < askMilli)) askMilli = p;
        }
        sellsKnown = true;
      } catch (err) {
        failedTypeIds.push(typeId);
        stopOn(err);
      }
    }

    for (const regionId of regionsToQuery) {
      if (sellExcluded && regionId === spec.refRegionId && (ownSell || !sellsKnown)) continue;
      const map = regionBestAsk.get(regionId);
      if (map) {
        const ask = map.get(typeId);
        if (ask !== null && ask !== undefined && (askMilli === null || ask < askMilli)) {
          askMilli = ask;
        }
      }
    }

    const baseMilli = basePrices.get(typeId) ?? null;

    prices.set(typeId, {
      bidMilli: clampMilli(bidMilli),
      askMilli: clampMilli(askMilli),
      baseMilli: clampMilli(baseMilli),
    });
  }

  failedTypeIds.sort((a, b) => a - b);
  return { ok: true, prices, errors, aborted, failedTypeIds, regionErrors };
}

function isId(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function orderIdText(value) {
  try { return BigInt(String(value).trim()).toString(); } catch (_err) { return String(value); }
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

module.exports = { readTradePricesFrom, toMilli, clampMilli, REJECTED_CODE, MAX_UNIT_PRICE_MILLI };