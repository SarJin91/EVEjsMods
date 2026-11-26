"use strict";

const { MS_PER_HOUR, threadIdOf, stepKeyOf } = require("./schema");

function cycleMsOf(s) {
  return s.cycleHours * MS_PER_HOUR;
}

function cycleAtOrBefore(now, s) {
  const cycleMs = cycleMsOf(s);
  const offset = s.cycleStartHourUtc * MS_PER_HOUR;
  return Math.floor((now - offset) / cycleMs) * cycleMs + offset;
}

function nextCycleAt(cycleAt, s) {
  return cycleAt + cycleMsOf(s);
}

module.exports = { cycleMsOf, cycleAtOrBefore, nextCycleAt, threadIdOf, stepKeyOf };
