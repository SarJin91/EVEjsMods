"use strict";

const { PRICE_SOURCE_BID, PRICE_SOURCE_BASE, PRICE_SOURCE_ASK } = require("./schema");
const NO_PRICE = Object.freeze({ ok: false, reason: "NO_PRICE" });
const PRICE_TOO_HIGH = Object.freeze({ ok: false, reason: "PRICE_TOO_HIGH" });
const INVALID_PRICE = Object.freeze({ ok: false, reason: "INVALID_PRICE" });

const PERMILLE = 1000;
const MAX_ASK_CAP_CEIL_PERMILLE = 2000;

function validRefs(refs) {
  if (!refs || typeof refs !== "object") return false;
  const { bidMilli, askMilli, baseMilli } = refs;
  if (bidMilli !== null && (!Number.isSafeInteger(bidMilli) || bidMilli < 0)) return false;
  if (askMilli !== null && (!Number.isSafeInteger(askMilli) || askMilli < 0)) return false;
  if (baseMilli !== null && (!Number.isSafeInteger(baseMilli) || baseMilli < 0)) return false;
  return true;
}

function validParams(p) {
  if (!p || typeof p !== "object") return false;
  if (!Number.isSafeInteger(p.premiumPermille) || p.premiumPermille < 0) return false;
  const ceil = p.askCapCeilPermille === undefined ? PERMILLE : p.askCapCeilPermille;
  if (!Number.isSafeInteger(ceil) || ceil < PERMILLE || ceil > MAX_ASK_CAP_CEIL_PERMILLE) return false;
  if (!Number.isSafeInteger(p.askCapPermille) || p.askCapPermille < 0 || p.askCapPermille > ceil) return false;
  const bonus = p.bonusPermille === undefined ? 0 : p.bonusPermille;
  if (!Number.isSafeInteger(bonus) || bonus < 0) return false;
  if (!Number.isSafeInteger(p.maxUnitPriceMilli) || p.maxUnitPriceMilli < 1) return false;
  return true;
}

function quote(refs, p) {
  if (!validRefs(refs) || !validParams(p)) return INVALID_PRICE;

  const { bidMilli, askMilli, baseMilli } = refs;
  const premiumPermille = p.premiumPermille;
  const askCapPermille = p.askCapPermille;
  const bonusPermille = p.bonusPermille === undefined ? 0 : p.bonusPermille;
  const maxUnitPriceMilli = p.maxUnitPriceMilli;

  if (askMilli === null || askMilli <= 0) return NO_PRICE;

  let refMilli = 0;
  let source = PRICE_SOURCE_BID;
  if (bidMilli !== null && bidMilli > 0) {
    refMilli = bidMilli;
    source = PRICE_SOURCE_BID;
  } else if (baseMilli !== null && baseMilli > 0) {
    refMilli = baseMilli;
    source = PRICE_SOURCE_BASE;
  } else {
    return NO_PRICE;
  }

  const totalPermille = premiumPermille + bonusPermille;
  let unitMilli = Math.floor((refMilli * totalPermille) / PERMILLE);

  if (unitMilli < 1) return NO_PRICE;

  const capMilli = Math.floor((askMilli * askCapPermille) / PERMILLE);
  let capped = false;
  if (unitMilli > capMilli) {
    unitMilli = capMilli;
    capped = true;
  }
  if (unitMilli < 1) return NO_PRICE;

  if (unitMilli > maxUnitPriceMilli) return PRICE_TOO_HIGH;

  return Object.freeze({
    ok: true,
    unitMilli,
    refMilli,
    capMilli,
    source,
    capped,
  });
}

function mulDivCeil(a, b, d) {
  const r = Math.floor(a / d) * b + Math.ceil(((a % d) * b) / d);
  return Number.isSafeInteger(r) ? r : null;
}

function quoteSell(refs, p) {
  if (!validRefs(refs) || !p || typeof p !== "object") return INVALID_PRICE;
  if (!Number.isSafeInteger(p.askPermille) || p.askPermille < PERMILLE
    || !Number.isSafeInteger(p.bidPermille) || p.bidPermille < PERMILLE
    || !Number.isSafeInteger(p.maxUnitPriceMilli) || p.maxUnitPriceMilli < 1) return INVALID_PRICE;
  const { bidMilli, askMilli } = refs;
  if (askMilli === null || askMilli <= 0) return NO_PRICE;
  const byAsk = mulDivCeil(askMilli, p.askPermille, PERMILLE);
  const byBid = bidMilli !== null && bidMilli > 0 ? mulDivCeil(bidMilli, p.bidPermille, PERMILLE) : 0;
  if (byAsk === null || byBid === null) return PRICE_TOO_HIGH;
  const unitMilli = Math.max(byAsk, byBid);
  if (unitMilli > p.maxUnitPriceMilli) return PRICE_TOO_HIGH;
  return Object.freeze({ ok: true, unitMilli, refMilli: askMilli, capMilli: null, source: PRICE_SOURCE_ASK });
}

const SPREAD_TOO_TIGHT = Object.freeze({ ok: false, reason: "SPREAD_TOO_TIGHT" });
const MIN_COMMODITY_ASK_PERMILLE = 500;
const MAX_COMMODITY_BID_FLOOR_PERMILLE = 2000;

function quoteCommoditySell(refs, p) {
  if (!validRefs(refs) || !p || typeof p !== "object") return INVALID_PRICE;
  if (!Number.isSafeInteger(p.sellAskPermille) || p.sellAskPermille < MIN_COMMODITY_ASK_PERMILLE
    || p.sellAskPermille > PERMILLE
    || !Number.isSafeInteger(p.sellBidFloorPermille) || p.sellBidFloorPermille < PERMILLE
    || p.sellBidFloorPermille > MAX_COMMODITY_BID_FLOOR_PERMILLE
    || !Number.isSafeInteger(p.maxUnitPriceMilli) || p.maxUnitPriceMilli < 1) return INVALID_PRICE;
  const { bidMilli, askMilli } = refs;
  if (askMilli === null || askMilli <= 0) return NO_PRICE;
  const byAsk = mulDivCeil(askMilli, p.sellAskPermille, PERMILLE);
  const byBid = bidMilli !== null && bidMilli > 0 ? mulDivCeil(bidMilli, p.sellBidFloorPermille, PERMILLE) : 0;
  if (byAsk === null || byBid === null) return PRICE_TOO_HIGH;
  const unitMilli = Math.max(byAsk, byBid);
  if (unitMilli > askMilli) return SPREAD_TOO_TIGHT;
  if (unitMilli > p.maxUnitPriceMilli) return PRICE_TOO_HIGH;
  return Object.freeze({ ok: true, unitMilli, refMilli: askMilli, capMilli: null, source: PRICE_SOURCE_ASK });
}

module.exports = { quote, quoteSell, quoteCommoditySell, NO_PRICE, PRICE_TOO_HIGH, INVALID_PRICE, PERMILLE };