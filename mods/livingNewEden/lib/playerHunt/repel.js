"use strict";

const REPEL_ROWS = 5;
const RETREATED = "RETREATED";
const OUTCOME_DESTROYED = "DESTROYED";
const PERMILLE = 1000;
const QUIET_REASONS = Object.freeze(["NO_LOSSES", "BELOW_THRESHOLD", "NOT_SPAWNED", "NOT_CLAIMANT",
  "REPEL_DISABLED"]);

function planRepel(input, params) {
  try {
    const members = input && Array.isArray(input.members) ? input.members : null;
    const lossPermille = params ? params.lossPermille : undefined;
    if (members === null || !Number.isSafeInteger(lossPermille) || lossPermille < 1 || lossPermille > PERMILLE) {
      return { repel: false, why: "INVALID_INPUT" };
    }
    let spawned = 0;
    let lost = 0;
    for (const m of members) {
      const state = m && m.state;
      if (state === "SPAWNED") spawned += 1;
      else if (state === "DESTROYED") {
        spawned += 1;
        lost += 1;
      }
    }
    if (spawned === 0) return { repel: false, why: "NOT_SPAWNED" };
    if (input.outcome === OUTCOME_DESTROYED) return { repel: true, why: "DESTROYED" };
    if (input.reason === RETREATED) return { repel: true, why: "RETREATED" };
    if (lost === 0) return { repel: false, why: "NO_LOSSES" };
    if (lost * PERMILLE >= spawned * lossPermille) return { repel: true, why: "LOSSES" };
    return { repel: false, why: "BELOW_THRESHOLD" };
  } catch (_err) {
    return { repel: false, why: "INVALID_INPUT" };
  }
}

module.exports = { planRepel, REPEL_ROWS, QUIET_REASONS };
