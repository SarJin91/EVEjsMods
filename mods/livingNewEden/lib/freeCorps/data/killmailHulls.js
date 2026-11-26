"use strict";

const KILLMAIL_HULLS = Object.freeze({
  HUNT: Object.freeze([587, 16242, 22456, 11198, 24702, 11999]),
  MINE: Object.freeze([32880, 17480, 17478, 17476]),
  HAUL: Object.freeze([648, 649, 1944, 652, 655, 19744, 2998]),
  RAT: Object.freeze([626, 17715, 24698, 24700, 17918]),
  EXPLORE: Object.freeze([605, 607, 586, 29248, 33468]),
  RUN: Object.freeze([638, 645, 24696, 12005]),
});

function hullsOf(kind) {
  return Object.prototype.hasOwnProperty.call(KILLMAIL_HULLS, kind) ? KILLMAIL_HULLS[kind] : KILLMAIL_HULLS.HUNT;
}

module.exports = { KILLMAIL_HULLS, hullsOf };
