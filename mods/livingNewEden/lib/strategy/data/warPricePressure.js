"use strict";

const PERMILLE = 1000;
const MAX_CEIL_PERMILLE = 2000;

const PRESSURE_KEYS = Object.freeze({
  lossRefPermille: "warPricingLossRefPermille",
  threatRef: "warPricingThreatRef",
  lossWeightPermille: "warPricingLossWeightPermille",
  threatWeightPermille: "warPricingThreatWeightPermille",
  austerityWeightPermille: "warPricingAusterityWeightPermille",
  minPermille: "warPricingMinPermille",
  stepPermille: "warPricingStepPermille",
});

const nonNeg = (v) => Number.isSafeInteger(v) && v >= 0;

function mulDivFloor(a, b, d) {
  return Math.floor(a / d) * b + Math.floor(((a % d) * b) / d);
}

function pressureOf(inputs, P) {
  if (!inputs || typeof inputs !== "object" || !P || typeof P !== "object") return 0;
  const { lossValueIsk, initialIsk, threatCount } = inputs;
  if (!nonNeg(lossValueIsk) || !nonNeg(initialIsk) || !nonNeg(threatCount)) return 0;
  if (!Number.isSafeInteger(P.lossRefPermille) || P.lossRefPermille < 1
    || !Number.isSafeInteger(P.threatRef) || P.threatRef < 1
    || !nonNeg(P.lossWeightPermille) || !nonNeg(P.threatWeightPermille) || !nonNeg(P.austerityWeightPermille)
    || !nonNeg(P.minPermille) || !Number.isSafeInteger(P.stepPermille) || P.stepPermille < 1) return 0;
  const ref = Math.max(1, mulDivFloor(initialIsk, P.lossRefPermille, PERMILLE));
  const L = initialIsk > 0 ? Math.min(PERMILLE, mulDivFloor(lossValueIsk, PERMILLE, ref)) : 0;
  const H = Math.min(PERMILLE, Math.floor((threatCount * PERMILLE) / P.threatRef));
  const A = inputs.austerity === true ? PERMILLE : 0;
  const raw = Math.min(PERMILLE, Math.floor((L * P.lossWeightPermille + H * P.threatWeightPermille
    + A * P.austerityWeightPermille) / PERMILLE));
  if (raw < P.minPermille) return 0;
  return Math.floor(raw / P.stepPermille) * P.stepPermille;
}

function warPriceParams(pressurePermille, T) {
  const p = Number.isSafeInteger(pressurePermille) ? Math.min(PERMILLE, Math.max(0, pressurePermille)) : 0;
  const base = T.askCapPermille;
  const ceil = Math.max(base, Math.min(MAX_CEIL_PERMILLE, T.warAskCapMaxPermille));
  return {
    bonusPermille: Math.floor((p * T.warBonusMaxPermille) / PERMILLE),
    askCapPermille: base + Math.floor((p * (ceil - base)) / PERMILLE),
    askCapCeilPermille: Math.max(PERMILLE, ceil),
  };
}

function pressureParamsOf(tradeCfg) {
  const t = tradeCfg || {};
  return Object.fromEntries(Object.entries(PRESSURE_KEYS).map(([k, name]) => [k, t[name]]));
}

function warQuoteOf(trade, k) {
  return trade.warQuotes && trade.warQuotes[k] && trade.warQuotes[k].ok ? trade.warQuotes[k] : trade.quotes[k];
}

function warQuoteAt(trade, stationId, k) {
  const caps = trade.stationWarCaps;
  if (!caps) return warQuoteOf(trade, k);
  const warQ = trade.warQuotes && trade.warQuotes[k];
  if (!warQ || !warQ.ok) return trade.quotes[k];
  const of = caps[String(stationId)];
  if (!of || !Object.prototype.hasOwnProperty.call(of, k)) return trade.quotes[k];
  const cap = of[k];
  if (cap === null) return warQ;
  if (!Number.isSafeInteger(cap)) return trade.quotes[k];
  const capped = Math.min(warQ.unitMilli, cap);
  if (capped >= warQ.unitMilli) return warQ;
  const base = trade.quotes[k];
  const floor = base && base.ok && Number.isSafeInteger(base.unitMilli) ? base.unitMilli : capped;
  return Object.freeze({ ...warQ, unitMilli: Math.max(floor, capped), stationCapped: true });
}

module.exports = { pressureOf, warPriceParams, pressureParamsOf, warQuoteOf, warQuoteAt, PRESSURE_KEYS };
