"use strict";

const REF_PRICES_VERSION = 1;

const REF_PRICE_MILLI = Object.freeze({
  "type:34": 3780,
  "type:35": 18960,
  "type:36": 50630,
  "type:37": 197160,
  "type:38": 718340,
  "type:39": 1324120,
  "type:40": 2722990,
});

const HULL_VALUE_FACTOR_PERMILLE = Object.freeze({
  logistics: 15000,
  ewar: 15000,
  tackle: 20000,
  capital: 3200,
  carrier: 3200,
  dreadnought: 3200,
  force_auxiliary: 2000,
  supercarrier: 2000,
  titan: 1200,
});

module.exports = { REF_PRICES_VERSION, REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE };
