"use strict";

const WRECK_YIELD = Object.freeze({
  frigate: Object.freeze({ salvage: 1, loot: 1 }),
  destroyer: Object.freeze({ salvage: 2, loot: 2 }),
  cruiser: Object.freeze({ salvage: 4, loot: 3 }),
  battlecruiser: Object.freeze({ salvage: 7, loot: 5 }),
  battleship: Object.freeze({ salvage: 12, loot: 8 }),
  logistics: Object.freeze({ salvage: 4, loot: 3 }),
  ewar: Object.freeze({ salvage: 3, loot: 2 }),
  tackle: Object.freeze({ salvage: 1, loot: 1 }),
  industrial: Object.freeze({ salvage: 3, loot: 10 }),
  capital: Object.freeze({ salvage: 80, loot: 40 }),
  mining_frigate: Object.freeze({ salvage: 1, loot: 1 }),
  mining_barge: Object.freeze({ salvage: 4, loot: 3 }),
  exhumer: Object.freeze({ salvage: 6, loot: 4 }),
  porpoise: Object.freeze({ salvage: 6, loot: 4 }),
  orca: Object.freeze({ salvage: 20, loot: 20 }),
  rorqual: Object.freeze({ salvage: 80, loot: 40 }),
  freighter: Object.freeze({ salvage: 40, loot: 80 }),
  jump_freighter: Object.freeze({ salvage: 50, loot: 80 }),
  carrier: Object.freeze({ salvage: 80, loot: 40 }),
  dreadnought: Object.freeze({ salvage: 80, loot: 40 }),
  force_auxiliary: Object.freeze({ salvage: 80, loot: 40 }),
  supercarrier: Object.freeze({ salvage: 80, loot: 40 }),
  titan: Object.freeze({ salvage: 80, loot: 40 }),
});

module.exports = { WRECK_YIELD };
