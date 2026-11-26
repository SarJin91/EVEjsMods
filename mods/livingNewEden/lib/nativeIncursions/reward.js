"use strict";

const { REWARD_REASON } = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function rewardDecisionOf({ controllerFactionId, participants, nativeFactionId }) {
  if (!isId(controllerFactionId)) return { kind: "SKIP", reason: REWARD_REASON.NO_CONTROLLER };
  if (controllerFactionId === nativeFactionId) return { kind: "SKIP", reason: REWARD_REASON.SANSHA_CONTROLLER };
  if (!Array.isArray(participants) || !participants.some(isId)) {
    return { kind: "SKIP", reason: REWARD_REASON.NO_PARTICIPANT };
  }
  return { kind: "PLAN", issuerFactionId: controllerFactionId };
}

module.exports = { rewardDecisionOf };
