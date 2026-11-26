"use strict";

const PHASE = Object.freeze({ ESTABLISHED: "ESTABLISHED", MOBILIZING: "MOBILIZING", WITHDRAWING: "WITHDRAWING",
  OVER: "OVER" });

function phaseOf(row, now) {
  if (now >= row.expiresAt) return PHASE.OVER;
  if (now >= row.withdrawingAt) return PHASE.WITHDRAWING;
  if (now >= row.mobilizingAt) return PHASE.MOBILIZING;
  return PHASE.ESTABLISHED;
}

module.exports = { PHASE, phaseOf };
