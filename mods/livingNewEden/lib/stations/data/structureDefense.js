"use strict";

const STRUCTURE_DEFENSE_VERSION = 1;

const BASE_DEFENSE = Object.freeze({
  astrahus: Object.freeze({ size: "medium",
    ehp: Object.freeze({ shield: 3600000, armor: 1800000, hull: 1800000 }),
    cap: Object.freeze({ shield: 14400000, armor: 5000, hull: 5000 }),
    garrisonPoints: 40, wreck: Object.freeze({ salvage: 400, loot: 200 }) }),
  fortizar: Object.freeze({ size: "large",
    ehp: Object.freeze({ shield: 6750000, armor: 5400000, hull: 21600000 }),
    cap: Object.freeze({ shield: 27000000, armor: 15000, hull: 15000 }),
    garrisonPoints: 120, wreck: Object.freeze({ salvage: 1200, loot: 600 }) }),
  keepstar: Object.freeze({ size: "xl",
    ehp: Object.freeze({ shield: 33750000, armor: 27000000, hull: 108000000 }),
    cap: Object.freeze({ shield: 135000000, armor: 75000, hull: 75000 }),
    garrisonPoints: 400, wreck: Object.freeze({ salvage: 4000, loot: 2000 }) }),
  npc: Object.freeze({ size: "large",
    ehp: Object.freeze({ shield: 6750000, armor: 5400000, hull: 21600000 }),
    cap: Object.freeze({ shield: 27000000, armor: 15000, hull: 15000 }),
    garrisonPoints: 80, wreck: Object.freeze({ salvage: 800, loot: 400 }) }),
});

const DEFENSE_COPIES = Object.freeze({ raitaru: "astrahus", athanor: "astrahus", azbel: "fortizar",
  tatara: "fortizar", sotiyo: "keepstar" });
const STRUCTURE_DEFENSE = Object.freeze({ ...BASE_DEFENSE,
  ...Object.fromEntries(Object.entries(DEFENSE_COPIES).map(([family, like]) => [family, BASE_DEFENSE[like]])) });

const TIMER_SECONDS = Object.freeze({
  repairDefault: 900,
  repairHull: 1800,
  armorDefault: 86400,
  armorMedium: Object.freeze({ wormhole: 216000, triglavian: 216000, null: 302400, low: 302400, high: 388800 }),
  hull: Object.freeze({ wormhole: 129600, triglavian: 129600, null: 216000, low: 216000, high: 388800 }),
});

const BAND_OF_SEC_CLASS = Object.freeze({ highsec: "high", lowsec: "low", nullsec: "null", wormhole: "wormhole",
  other: "null" });
const MEDIUM_SIZE = "medium";

module.exports = { STRUCTURE_DEFENSE_VERSION, STRUCTURE_DEFENSE, TIMER_SECONDS, BAND_OF_SEC_CLASS, MEDIUM_SIZE };
