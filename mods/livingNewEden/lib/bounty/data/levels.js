"use strict";

const MIN = 60000;
const HOUR = 3600000;

const level = (secClasses, highsecPermille, boss, escorts, rewardIsk, stayMin, stayMax, lifetimeHours, traceBlur,
  traceDelayMin) =>
  Object.freeze({ secClasses: Object.freeze(secClasses), highsecPermille, boss, escorts: Object.freeze(escorts),
    rewardIsk, stayMs: Object.freeze([stayMin * MIN, stayMax * MIN]), lifetimeMs: lifetimeHours * HOUR, traceBlur,
    traceDelayMs: traceDelayMin * MIN });

const HIGH_LOW = ["highsec", "lowsec"];
const NULL = ["nullsec"];
const LEVELS = Object.freeze({
  1: level(HIGH_LOW, 600, "frigate", [0, 0], 50000000, 30, 60, 24, "system", 5),
  2: level(HIGH_LOW, 400, "destroyer", [1, 1], 120000000, 30, 60, 24, "system", 10),
  3: level(NULL, 0, "cruiser", [2, 3], 350000000, 45, 90, 36, "constellation", 20),
  4: level(NULL, 0, "commander", [3, 4], 750000000, 60, 120, 48, "constellation", 30),
  5: level(NULL, 0, "commander", [4, 5], 1500000000, 60, 120, 60, "region", 45),
  6: level(NULL, 0, "capital", [5, 6], 4000000000, 90, 180, 72, "region", 60),
});

const LEVEL_WEIGHTS = Object.freeze([[1, 38], [2, 32], [3, 17], [4, 8], [5, 4], [6, 2]].map((e) => Object.freeze(e)));
const MAX_LEVEL = LEVEL_WEIGHTS.length;

const LOW_ARCHETYPES = Object.freeze([["RUNNER", 50], ["BRAWLER", 30], ["KITER", 20]].map((e) => Object.freeze(e)));
const HIGH_ARCHETYPES = Object.freeze([["RUNNER", 25], ["BRAWLER", 30], ["KITER", 20], ["AMBUSH", 25]]
  .map((e) => Object.freeze(e)));
const ARCHETYPE_WEIGHTS = Object.freeze({ 1: LOW_ARCHETYPES, 2: LOW_ARCHETYPES, 3: HIGH_ARCHETYPES,
  4: HIGH_ARCHETYPES, 5: HIGH_ARCHETYPES, 6: HIGH_ARCHETYPES });

const BOSS_SPAWN = Object.freeze({
  frigate: Object.freeze({ kind: "hull", hullClass: "frigate" }),
  destroyer: Object.freeze({ kind: "hull", hullClass: "destroyer" }),
  cruiser: Object.freeze({ kind: "hull", hullClass: "cruiser" }),
  commander: Object.freeze({ kind: "commander", hullClass: "battlecruiser" }),
  capital: Object.freeze({ kind: "capital", hullClass: "battleship" }),
});
const ESCORT_CLASSES = Object.freeze({ 1: Object.freeze(["frigate"]), 2: Object.freeze(["frigate"]),
  3: Object.freeze(["frigate", "destroyer"]), 4: Object.freeze(["destroyer", "cruiser"]),
  5: Object.freeze(["cruiser", "battlecruiser"]), 6: Object.freeze(["battlecruiser", "battleship"]) });

const SMUGGLER_MIN_LEVEL = 3;
const SMUGGLER_REWARD_PERMILLE = 1500;

const SMUGGLER_EXTRA_ESCORTS = 2;
const SMUGGLER_JUMP_FREIGHTER_LEVEL = 6;

module.exports = { LEVELS, LEVEL_WEIGHTS, MAX_LEVEL, ARCHETYPE_WEIGHTS, SMUGGLER_MIN_LEVEL, SMUGGLER_REWARD_PERMILLE,
  BOSS_SPAWN, ESCORT_CLASSES, SMUGGLER_EXTRA_ESCORTS, SMUGGLER_JUMP_FREIGHTER_LEVEL };
