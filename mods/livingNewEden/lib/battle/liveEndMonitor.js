"use strict";

const END_REASON = "END";

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function classifyLiveEnd({ aliveA, aliveB, liveSince, now, timeoutMs }) {
  const downA = aliveA === 0;
  const downB = aliveB === 0;
  if (downA && downB) return { reason: END_REASON, cause: "BOTH_DOWN" };
  if (downA) return { reason: END_REASON, cause: "SIDE_A_DOWN" };
  if (downB) return { reason: END_REASON, cause: "SIDE_B_DOWN" };
  if (isTime(liveSince) && isTime(now) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    && now - liveSince >= timeoutMs) {
    return { reason: END_REASON, cause: "TIMEOUT" };
  }
  return null;
}

module.exports = { classifyLiveEnd, END_REASON };
