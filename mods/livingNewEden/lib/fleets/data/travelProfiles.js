// Constants of the jump time: the warp model and its drop-out ceiling are ported from X-Eve livingUniverseRuntime.js (estimateWarpDurationMs, WARP_DROPOUT_SPEED_MAX_MS; see CREDITS.md), the gate transit is X-Eve getTransitMs() default (18 s).

"use strict";

const ONE_AU_M = 149597870700;
const CROSSING_AU = 15;
const GATE_TRANSIT_MS = 18000;
const WARP_DROPOUT_SPEED_MAX_MS = 100;
const MIN_WARP_MS = 1000;

const row = (warpSpeedAu, alignSeconds, maxVelocityMs) => Object.freeze({ warpSpeedAu, alignSeconds, maxVelocityMs });

const HULL_TRAVEL = Object.freeze({
  frigate: row(5, 3, 350),
  destroyer: row(4.5, 4, 280),
  cruiser: row(3, 7, 200),
  battlecruiser: row(2.7, 10, 150),
  battleship: row(2, 14, 110),
  logistics: row(3, 7, 200),
  ewar: row(4, 5, 250),
  tackle: row(5, 3, 400),
  industrial: row(4.5, 12, 150),
  capital: row(1.5, 40, 80),
  mining_frigate: row(5, 6, 335),
  mining_barge: row(3.5, 13, 150),
  exhumer: row(3.5, 13, 160),
  porpoise: row(3.5, 9, 100),
  orca: row(2.5, 42, 60),
  rorqual: row(1.5, 78, 60),
  freighter: row(1.5, 60, 65),
  jump_freighter: row(5, 6, 335),
  carrier: row(1.5, 40, 80),
  dreadnought: row(1.5, 40, 80),
  force_auxiliary: row(1.5, 40, 80),
  supercarrier: row(1.5, 40, 80),
  titan: row(1.5, 40, 80),
});

module.exports = { ONE_AU_M, CROSSING_AU, GATE_TRANSIT_MS, WARP_DROPOUT_SPEED_MAX_MS, MIN_WARP_MS, HULL_TRAVEL };
