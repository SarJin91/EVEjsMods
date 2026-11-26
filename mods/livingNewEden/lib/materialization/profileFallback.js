"use strict";

const FALLBACK_CHAIN = Object.freeze({
  frigate: Object.freeze(["destroyer"]),
  tackle: Object.freeze(["frigate", "destroyer"]),
  ewar: Object.freeze(["frigate", "destroyer"]),
  destroyer: Object.freeze(["frigate", "cruiser"]),
  cruiser: Object.freeze(["battlecruiser", "destroyer"]),
  logistics: Object.freeze(["cruiser"]),
  battlecruiser: Object.freeze(["cruiser", "battleship"]),
  battleship: Object.freeze(["battlecruiser", "cruiser"]),
  industrial: Object.freeze([]),
  mining_frigate: Object.freeze(["mining_barge"]),
  mining_barge: Object.freeze(["exhumer", "mining_frigate"]),
  exhumer: Object.freeze(["mining_barge"]),
  porpoise: Object.freeze(["mining_barge"]),
  orca: Object.freeze(["mining_barge"]),
  rorqual: Object.freeze(["exhumer", "mining_barge"]),
  freighter: Object.freeze(["industrial"]),
  jump_freighter: Object.freeze(["freighter", "industrial"]),
});

function fallbackChainOf(hullGroup) {
  return typeof hullGroup === "string" && Object.prototype.hasOwnProperty.call(FALLBACK_CHAIN, hullGroup)
    ? [...FALLBACK_CHAIN[hullGroup]] : [];
}

module.exports = { FALLBACK_CHAIN, fallbackChainOf };
