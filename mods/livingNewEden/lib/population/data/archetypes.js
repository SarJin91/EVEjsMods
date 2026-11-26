"use strict";

const { ARCHETYPE } = require("../schema");

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const ARCHETYPES = deepFreeze({
  [ARCHETYPE.TRADER]: { weights: [200, 700, 0, 0, 0, 100],
    hulls: [1944, 648, 652, 12731, 12753, 12747, 12745], bands: ["highsec", "lowsec", "nullsec"] },
  [ARCHETYPE.MINER]: { weights: [250, 150, 550, 0, 0, 50],
    hulls: [32880, 17478, 22546], bands: ["highsec", "lowsec", "nullsec"] },
  [ARCHETYPE.RATTER]: { weights: [250, 200, 0, 500, 0, 50],
    hulls: [16240, 16229], bands: ["highsec", "lowsec", "nullsec"] },
  [ARCHETYPE.EXPLORER]: { weights: [150, 450, 0, 0, 350, 50],
    hulls: [33468, 33470], bands: ["highsec", "lowsec", "nullsec"] },
  [ARCHETYPE.COMMUTER]: { weights: [400, 550, 0, 0, 0, 50],
    hulls: [32880, 16240, 33468, 1944], bands: ["highsec", "lowsec"] },
});

module.exports = { ARCHETYPES };
