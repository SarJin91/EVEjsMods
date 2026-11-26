"use strict";

const { DECIDE_THREW } = require("./ai");

const PREFIX = `${DECIDE_THREW}: `;

function createDecideThrewLog(deps) {
  const lastAt = new Map();
  const label = deps.label || "decide";
  function note(factionId, decision) {
    try {
      const reason = decision && decision.outcome === "SKIPPED" ? decision.reason : null;
      if (typeof reason !== "string" || !reason.startsWith(DECIDE_THREW)) return false;
      const now = deps.clock.now();
      const prev = lastAt.get(factionId);
      if (prev !== undefined && now - prev < deps.intervalMs) return false;
      lastAt.set(factionId, now);
      const message = reason.startsWith(PREFIX) ? reason.slice(PREFIX.length) : reason;
      const at = typeof decision.threwAt === "string" && decision.threwAt ? decision.threwAt : "unknown frame";
      deps.log(`strategy: ${factionId} ${label} threw: ${message} at ${at}`);
      return true;
    } catch (_err) {
      return false;
    }
  }
  return Object.freeze({ note });
}

module.exports = { createDecideThrewLog };
