"use strict";

const { MS_PER_HOUR } = require("./schema");

function boundaryAtOrBefore(now, s) {
  const cycleMs = s.cycleHours * MS_PER_HOUR;
  const offset = s.publishHourUtc * MS_PER_HOUR;
  return Math.floor((now - offset) / cycleMs) * cycleMs + offset;
}

function nextBoundary(boundaryAt, s) {
  return boundaryAt + s.cycleHours * MS_PER_HOUR;
}

function editionIdOf(boundaryAt) {
  return `ed:${boundaryAt}`;
}

module.exports = { boundaryAtOrBefore, nextBoundary, editionIdOf };
