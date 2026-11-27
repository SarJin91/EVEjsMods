"use strict";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const INDUSTRY_METHOD = deepFreeze({
  catalogVersion: 1,
  maxDepth: 6,
  minerals: [34, 35, 36, 37, 38, 39, 40],
  attributes: { oreHold: 1556, warpSpeedMultiplier: 600, agility: 70, maxVelocity: 37 },
  hullClasses: {
    mining_frigate: { typeIds: [32880], representative: 32880 },
    mining_barge: { sourceGroups: [463], representative: 17476 },
    exhumer: { sourceGroups: [543], representative: 22544 },
    porpoise: { typeIds: [42244], representative: 42244 },
    orca: { typeIds: [28606], representative: 28606 },
    rorqual: { sourceGroups: [883], representative: 28352 },
    industrial: { sourceGroups: [28], representative: "lowerMedian" },
    freighter: { sourceGroups: [513], representative: "lowerMedian" },
    jump_freighter: { sourceGroups: [902], representative: "lowerMedian" },
  },
  structures: { raitaru: 35825, azbel: 35826, sotiyo: 35827, astrahus: 35832, fortizar: 35833,
    keepstar: 35834, athanor: 35835, tatara: 35836 },
  oreBands: {
    highsec: { Veldspar: 330, Scordite: 250, Pyroxeres: 150, Plagioclase: 120, Omber: 50, Kernite: 40,
      Jaspet: 10, Hemorphite: 10, Hedbergite: 10, Crokite: 10, Bistot: 10, Arkonor: 10 },
    lowsec: { Veldspar: 150, Scordite: 150, Pyroxeres: 100, Plagioclase: 100, Omber: 120, Kernite: 120,
      Jaspet: 80, Hemorphite: 60, Hedbergite: 60, Crokite: 20, Bistot: 20, Arkonor: 20 },
    nullsec: { Veldspar: 100, Scordite: 100, Pyroxeres: 50, Plagioclase: 50, Hemorphite: 50, Hedbergite: 50,
      Gneiss: 100, "Dark Ochre": 100, Spodumain: 100, Crokite: 100, Bistot: 100, Arkonor: 100 },
  },
});

module.exports = { INDUSTRY_METHOD };
