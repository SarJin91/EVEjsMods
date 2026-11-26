"use strict";

const MINERAL_YIELD_VERSION = 3;

const MINERALS = Object.freeze({
  34: "Tritanium",
  35: "Pyerite",
  36: "Mexallon",
  37: "Isogen",
  38: "Nocxium",
  39: "Zydrine",
  40: "Megacyte",
});

const MINERAL_YIELD = Object.freeze({ version: MINERAL_YIELD_VERSION, minerals: MINERALS });

module.exports = { MINERAL_YIELD_VERSION, MINERALS, MINERAL_YIELD };
