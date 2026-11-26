"use strict";

const { warpProgress } = require("../playerHunt/phases");
const { END_UNOBSERVED } = require("./schema");

const PHASES = Object.freeze({ PATROL_DWELL: "PATROL_DWELL", PATROL_WARP: "PATROL_WARP", CAMP_HOLD: "CAMP_HOLD",
  ENGAGED: "ENGAGED", CAMP_WARP: "CAMP_WARP" });
const ACTION_TYPES = Object.freeze(["warp", "search", "attack"]);
const MODE_CAMP = "GATE_CAMP";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPoint = (p) => Boolean(p) && isNum(p.x) && isNum(p.y) && isNum(p.z);
const orNull = (v) => (v === null || v === undefined ? null : v);

function decidePatrolStep(entry, facts, params) {
  const now = facts.now;
  const next = { phase: entry.phase, phaseSince: entry.phaseSince, objectIndex: entry.objectIndex,
    absentSince: orNull(entry.absentSince), noTargetSince: orNull(entry.noTargetSince),
    warpSeen: entry.warpSeen === true, warpEnd: null, actions: [], end: null,
    relocateTo: orNull(entry.relocateTo), relocated: null, relocateCancelled: false };
  const end = (reason) => ({ ...next, actions: [], end: { reason } });

  if (facts.sceneLoaded !== true) return end("SCENE_GONE");
  const own = Array.isArray(facts.ownAlive) ? facts.ownAlive : [];
  if (own.length === 0 && entry.spawnConfirmed !== true) return end("SPAWN_NOT_VISIBLE");
  if (own.length === 0) return end("WIPED");
  if (facts.present === true) next.absentSince = null;
  else {
    const since = next.absentSince === null ? now : next.absentSince;
    next.absentSince = since;
    if (now - since >= params.exitGraceMs) return end(END_UNOBSERVED);
  }
  if (isNum(params.maxLiveMs) && params.maxLiveMs > 0 && now - entry.liveSince >= params.maxLiveMs) {
    return end("TIMEOUT");
  }
  const targets = Array.isArray(facts.hostilesOnGrid) ? facts.hostilesOnGrid : [];

  const toNextObject = (before) => {
    const objects = Array.isArray(entry.objects) ? entry.objects : [];
    const n = objects.length;
    const index = n > 0 ? (entry.objectIndex + 1) % n : 0;
    const point = n > 1 && objects[index] ? objects[index].point : null;
    if (n <= 1 || !isPoint(point)) {
      return { ...next, phase: PHASES.PATROL_DWELL, phaseSince: now, noTargetSince: null, actions: [...before] };
    }
    return { ...next, phase: PHASES.PATROL_WARP, phaseSince: now, objectIndex: index, noTargetSince: null,
      warpSeen: false, actions: [...before, { type: "warp", point: { x: point.x, y: point.y, z: point.z },
        objectIndex: index }] };
  };

  if (entry.phase === PHASES.ENGAGED) {
    if (targets.length > 0) return { ...next, noTargetSince: null };
    const since = next.noTargetSince === null ? now : next.noTargetSince;
    if (now - since >= params.reacquireGraceMs) {
      if (entry.mode === MODE_CAMP) {
        return { ...next, phase: PHASES.CAMP_HOLD, phaseSince: now, noTargetSince: null,
          actions: [{ type: "search" }] };
      }
      return toNextObject([{ type: "search" }]);
    }
    return { ...next, noTargetSince: since };
  }
  if (targets.length > 0) {
    const cancel = next.relocateTo !== null ? { relocateTo: null, relocateCancelled: true } : {};
    return { ...next, phase: PHASES.ENGAGED, phaseSince: now, noTargetSince: null,
      actions: [{ type: "attack", targets: [...targets] }], ...cancel };
  }
  if (entry.phase === PHASES.CAMP_HOLD) {
    if (next.relocateTo === null) return next;
    const to = next.relocateTo;
    if (!to || !isPoint(to.point) || !Number.isSafeInteger(to.itemId)) {
      return { ...next, relocateTo: null, relocateCancelled: true };
    }
    return { ...next, phase: PHASES.CAMP_WARP, phaseSince: now, warpSeen: false, relocateTo: null,
      relocated: to.itemId, actions: [{ type: "warp", point: { x: to.point.x, y: to.point.y, z: to.point.z },
        objectIndex: 0 }] };
  }
  if (entry.phase === PHASES.CAMP_WARP) {
    const w = warpProgress(entry, own, now, params);
    if (w.end !== null) {
      return { ...next, phase: PHASES.CAMP_HOLD, phaseSince: now, warpSeen: w.seen, warpEnd: w.end };
    }
    return { ...next, warpSeen: w.seen };
  }
  if (entry.phase === PHASES.PATROL_WARP) {
    const w = warpProgress(entry, own, now, params);
    if (w.end !== null) {
      return { ...next, phase: PHASES.PATROL_DWELL, phaseSince: now, warpSeen: w.seen, warpEnd: w.end };
    }
    return { ...next, warpSeen: w.seen };
  }
  if (now - entry.phaseSince >= params.objectDwellMs) return toNextObject([]);
  return next;
}

module.exports = { decidePatrolStep, PHASES, ACTION_TYPES };
