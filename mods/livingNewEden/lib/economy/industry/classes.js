"use strict";

const INDUSTRY_CATALOG_VERSION = 1;

const INDUSTRY_HULL_CLASSES = Object.freeze(["mining_frigate", "mining_barge", "exhumer", "porpoise", "orca",
  "rorqual", "industrial", "freighter", "jump_freighter"]);

const INDUSTRY_STRUCTURE_FAMILIES = Object.freeze(["raitaru", "azbel", "sotiyo", "astrahus", "fortizar", "keepstar",
  "athanor", "tatara"]);

const INDUSTRY_ORE_BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);

module.exports = { INDUSTRY_CATALOG_VERSION, INDUSTRY_HULL_CLASSES, INDUSTRY_STRUCTURE_FAMILIES, INDUSTRY_ORE_BANDS };
