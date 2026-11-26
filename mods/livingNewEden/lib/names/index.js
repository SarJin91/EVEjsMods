"use strict";

const { STYLE_KEYS, FACTION_STYLE, RACE_STYLE, styleFor } = require("./styles");
const { nameKey, isValidCharacterName } = require("./validate");
const { candidateAt, pickName, DATA, NICKNAMES, ATTEMPTS_PER_TIER } = require("./generate");

module.exports = {
  STYLE_KEYS,
  FACTION_STYLE,
  RACE_STYLE,
  styleFor,
  nameKey,
  isValidCharacterName,
  candidateAt,
  pickName,
  DATA,
  NICKNAMES,
  ATTEMPTS_PER_TIER,
};
