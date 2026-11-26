"use strict";

const VOLUME_UNITS_PER_M3 = 100;
const MINERAL_TYPE_IDS = Object.freeze([34, 35, 36, 37, 38, 39, 40]);
const MINERAL_VOLUME = 1;
const HULL_VOLUMES = Object.freeze({
  frigate: 250000,
  destroyer: 500000,
  cruiser: 1000000,
  battlecruiser: 1500000,
  battleship: 5000000,
  logistics: 1000000,
  ewar: 1000000,
  tackle: 250000,
  industrial: 2000000,
  capital: null,
  mining_frigate: 250000,
  mining_barge: 375000,
  exhumer: 375000,
  porpoise: 5000000,
  orca: null,
  rorqual: null,
  freighter: null,
  jump_freighter: null,
  carrier: null,
  dreadnought: null,
  force_auxiliary: null,
  supercarrier: null,
  titan: null,
});
const CARRIER_GROUPS = Object.freeze(["industrial", "freighter", "jump_freighter"]);
const CAPITAL_CARRIER_GROUPS = Object.freeze(["freighter", "jump_freighter"]);

module.exports = { VOLUME_UNITS_PER_M3, MINERAL_TYPE_IDS, MINERAL_VOLUME, HULL_VOLUMES, CARRIER_GROUPS,
  CAPITAL_CARRIER_GROUPS };
