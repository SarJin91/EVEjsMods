"use strict";

const { TIER } = require("./schema");

const PERMILLE = 1000;
const ZERO = Object.freeze({ taxPermille: 0, brokerPermille: 0 });

function marketModifierOf(tier, p) {
  if (!p || (tier !== TIER.LEGEND && tier !== TIER.PUBLIC_ENEMY)) return ZERO;
  const legend = tier === TIER.LEGEND;
  const tax = p.marketTaxEnabled === true ? (legend ? p.legendTaxPermille : p.enemyTaxPermille) : 0;
  const broker = p.marketBrokerEnabled === true ? (legend ? p.legendBrokerPermille : p.enemyBrokerPermille) : 0;
  return Object.freeze({ taxPermille: Number.isFinite(tax) ? tax : 0,
    brokerPermille: Number.isFinite(broker) ? broker : 0 });
}

function scaledRate(rate, permille, maxSurchargePermille) {
  if (permille === 0 || typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return null;
  const cap = rate * (1 + Math.max(0, maxSurchargePermille) / PERMILLE);
  const next = rate * (1 + permille / PERMILLE);
  return Math.min(Math.max(next, 0), cap);
}

function applyMarketModifier(context, mod, p) {
  if (!context || typeof context !== "object" || context.isStation !== true || !mod) return context;
  const max = p && Number.isFinite(p.maxSurchargePermille) ? p.maxSurchargePermille : 0;
  const limits = context.limits && typeof context.limits === "object" ? context.limits : null;
  const acc = limits ? scaledRate(limits.acc, Number(mod.taxPermille) || 0, max) : null;
  const broker = scaledRate(context.brokerCommissionRate, Number(mod.brokerPermille) || 0, max);
  if (acc === null && broker === null) return context;
  const next = { ...context };
  if (acc !== null) next.limits = { ...limits, acc };
  if (broker !== null) next.brokerCommissionRate = broker;
  return next;
}

module.exports = { marketModifierOf, applyMarketModifier };
