"use strict";

const WH_GAS_TYPES = Object.freeze([
  { typeId: 30370, name: "Fullerite-C50", weight: 200, unitPriceMilli: 200000 },
  { typeId: 30371, name: "Fullerite-C60", weight: 200, unitPriceMilli: 150000 },
  { typeId: 30372, name: "Fullerite-C70", weight: 150, unitPriceMilli: 700000 },
  { typeId: 30373, name: "Fullerite-C72", weight: 150, unitPriceMilli: 900000 },
  { typeId: 30374, name: "Fullerite-C84", weight: 100, unitPriceMilli: 1200000 },
  { typeId: 30375, name: "Fullerite-C28", weight: 60, unitPriceMilli: 2000000 },
  { typeId: 30376, name: "Fullerite-C32", weight: 60, unitPriceMilli: 2500000 },
  { typeId: 30377, name: "Fullerite-C320", weight: 40, unitPriceMilli: 3500000 },
  { typeId: 30378, name: "Fullerite-C540", weight: 40, unitPriceMilli: 3000000 },
].map(Object.freeze));

module.exports = { WH_GAS_TYPES };
