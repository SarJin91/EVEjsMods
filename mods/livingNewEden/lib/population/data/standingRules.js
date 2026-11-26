"use strict";

const RIVALS = Object.freeze({
  500001: Object.freeze([500004]),
  500004: Object.freeze([500001]),
  500002: Object.freeze([500003, 500007]),
  500003: Object.freeze([500002]),
});

const REL = Object.freeze({ NEUTRAL: 0, FRIENDLY: 1, HOSTILE: 2 });

const OUTSIDE = 255;
const MAX_FACTIONS = 254;

module.exports = { RIVALS, REL, OUTSIDE, MAX_FACTIONS };
