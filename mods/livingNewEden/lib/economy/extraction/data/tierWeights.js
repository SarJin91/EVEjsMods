"use strict";

const TIER_WEIGHTS = Object.freeze({
  highsec: Object.freeze([
    Object.freeze(["r4", 700]), Object.freeze(["r8", 250]), Object.freeze(["r16", 50]),
  ]),
  lowsec: Object.freeze([
    Object.freeze(["r4", 400]), Object.freeze(["r8", 300]), Object.freeze(["r16", 200]),
    Object.freeze(["r32", 80]), Object.freeze(["r64", 20]),
  ]),
  nullsec: Object.freeze([
    Object.freeze(["r4", 300]), Object.freeze(["r8", 250]), Object.freeze(["r16", 200]),
    Object.freeze(["r32", 150]), Object.freeze(["r64", 100]),
  ]),
});

module.exports = { TIER_WEIGHTS };
