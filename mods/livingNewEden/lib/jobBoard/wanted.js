"use strict";

const OFF_REASONS = Object.freeze(["BOUNTY_DISABLED", "NOT_READY"]);

function createWanted(deps) {
  const { ctx, bump } = deps;

  function read(distances, now) {
    const facade = ctx.bounty;
    if (!facade || typeof facade.listBoardRows !== "function") return null;
    let r;
    try {
      r = facade.listBoardRows({ now, distances: distances instanceof Map ? distances : null });
    } catch (_err) {
      r = { ok: false, reason: "THREW" };
    }
    if (r && r.ok === true) {
      bump("wantedReads");
      return r;
    }
    const reason = String((r && r.reason) || "NO_RESULT");
    if (OFF_REASONS.includes(reason)) return null;
    bump("wantedRefused");
    return { ok: false, reason };
  }

  return Object.freeze({ read });
}

module.exports = { createWanted, OFF_REASONS };
