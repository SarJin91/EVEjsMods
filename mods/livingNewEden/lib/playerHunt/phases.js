"use strict";

const { scanRoll, retargetTowardQuarry } = require("./policy");
const { decideRetreat } = require("./exit");
const { EXIT_REASONS, PURSUIT_END_REASON: PURSUIT_REASON, TARGET_DOCKED_END_REASON: TARGET_DOCKED }
  = require("./schema");

const PHASES = Object.freeze({ SWEEP_DWELL: "SWEEP_DWELL", SWEEP_WARP: "SWEEP_WARP", SCAN: "SCAN",
  WARP_TO_TARGET: "WARP_TO_TARGET", ENGAGED: "ENGAGED", EXITING: "EXITING", CAMP: "CAMP" });
const ACTION_TYPES = Object.freeze(["warp", "search", "attack", "end"]);
const MODE_SCAN = "SCAN";

const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPoint = (p) => Boolean(p) && isNum(p.x) && isNum(p.y) && isNum(p.z);

function warpInPoint(quarryPos, leadPos, distance) {
  const d = isNum(distance) && distance > 0 ? distance : 0;
  const dx = isPoint(leadPos) ? leadPos.x - quarryPos.x : 0;
  const dy = isPoint(leadPos) ? leadPos.y - quarryPos.y : 0;
  const dz = isPoint(leadPos) ? leadPos.z - quarryPos.z : 0;
  const len = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
  if (!(len > 0) || !isNum(len)) return { x: quarryPos.x + d, y: quarryPos.y, z: quarryPos.z };
  return { x: quarryPos.x + ((dx / len) * d), y: quarryPos.y + ((dy / len) * d), z: quarryPos.z + ((dz / len) * d) };
}

function scannable(quarry) {
  return Boolean(quarry) && quarry.state === "space" && Boolean(quarry.ship) && isPoint(quarry.ship.position)
    && quarry.ship.inWarp !== true && quarry.ship.cloaked !== true;
}

function retargetOf(entry, quarry, own, params) {
  if (params.sweepRetargetEnabled !== true || !scannable(quarry) || quarry.ship.capsule === true) return null;
  const grid = params.gridRadiusMeters;
  if (!isNum(grid) || !(grid > 0)) return null;
  const pos = quarry.ship.position;
  const lead = own[0];
  if (lead && lead.inWarp !== true && isPoint(lead.position)) {
    const dx = lead.position.x - pos.x;
    const dy = lead.position.y - pos.y;
    const dz = lead.position.z - pos.z;
    if ((dx * dx) + (dy * dy) + (dz * dz) <= grid * grid) return null;
  }
  return retargetTowardQuarry(entry.objects, entry.objectIndex, pos, grid, entry.retargetExtra);
}

function warpProgress(entry, own, now, params) {
  const seen = entry.warpSeen === true || own.some((s) => s.inWarp === true);
  const grace = Number.isSafeInteger(params.warpStartGraceMs) && params.warpStartGraceMs > 0
    ? params.warpStartGraceMs : 0;
  if (seen && own.every((s) => s.inWarp !== true)) return { seen, end: "landed" };
  if (!seen && (grace === 0 || now - entry.phaseSince >= grace)) return { seen, end: "grace" };
  if (now - entry.phaseSince >= params.warpTimeoutMs) return { seen, end: "timeout" };
  return { seen, end: null };
}

function decideHuntStep(entry, facts, params) {
  const now = facts.now;
  const scanCycle = Number.isSafeInteger(entry.scanCycle) && entry.scanCycle >= 0 ? entry.scanCycle : 0;
  const next = { phase: entry.phase, phaseSince: entry.phaseSince, objectIndex: entry.objectIndex,
    visited: entry.visited, quarryAbsentSince: entry.quarryAbsentSince, noTargetSince: entry.noTargetSince,
    scanCycle, scan: null, actions: [], end: null, warpSeen: entry.warpSeen === true, warpEnd: null,
    exitReason: typeof entry.exitReason === "string" ? entry.exitReason : null,
    exitPursuitTarget: isPositiveId(entry.exitPursuitTarget) ? entry.exitPursuitTarget : null };
  const end = (reason) => ({ ...next, actions: [{ type: "end", reason }], end: { reason } });
  const finish = (reason, extra) => {
    const pursuitTarget = extra && isPositiveId(extra.pursuitTarget) ? extra.pursuitTarget : null;
    if (params.exitEnabled === true && facts.watched === true && isPoint(facts.exitPoint)
      && EXIT_REASONS.includes(reason)) {
      if (facts.exitOnGrid === true) {
        const landed = { ...end(reason), exitWarp: "landed" };
        return reason === PURSUIT_REASON ? { ...landed, pursuitTarget } : landed;
      }
      return { ...next, phase: PHASES.EXITING, phaseSince: now, warpSeen: false, exitReason: reason,
        exitPursuitTarget: pursuitTarget, end: null,
        actions: [{ type: "search" }, { type: "warp", point: { x: facts.exitPoint.x, y: facts.exitPoint.y,
          z: facts.exitPoint.z } }] };
    }
    return reason === PURSUIT_REASON ? { ...end(reason), pursuitTarget } : end(reason);
  };

  if (facts.sceneLoaded !== true) return end("SCENE_GONE");
  const own = Array.isArray(facts.ownAlive) ? facts.ownAlive : [];
  if (own.length === 0 && entry.spawnConfirmed !== true) return end("SPAWN_NOT_VISIBLE");
  if (own.length === 0) return end("WIPED");
  if (entry.phase === PHASES.EXITING) {
    const w = warpProgress(entry, own, now, params);
    if (w.end === null) return { ...next, warpSeen: w.seen };
    const reason = EXIT_REASONS.includes(next.exitReason) ? next.exitReason : "TARGET_GONE";
    const done = { ...end(reason), warpSeen: w.seen, exitWarp: w.end };
    return reason === PURSUIT_REASON ? { ...done, pursuitTarget: next.exitPursuitTarget } : done;
  }
  if (now - entry.liveSince >= params.maxDurationMs) return finish("TIMEOUT");
  const quarry = facts.quarry || { state: "absent", ship: null };
  if (quarry.state === "space" && quarry.ship && quarry.ship.capsule === true) return finish("TARGET_DOWN");
  const targets = Array.isArray(facts.hostilesOnGrid) ? facts.hostilesOnGrid : [];
  if (decideRetreat({ members: facts.members, alive: own.length, hostiles: targets.length, lost: facts.lost },
    params).retreat) {
    return finish("RETREATED");
  }
  if (quarry.state === "space") next.quarryAbsentSince = null;
  else {
    if (Number.isSafeInteger(facts.pursuitTarget) && facts.pursuitTarget > 0) {
      return finish(PURSUIT_REASON, { pursuitTarget: facts.pursuitTarget });
    }
    const since = entry.quarryAbsentSince === null || entry.quarryAbsentSince === undefined
      ? now : entry.quarryAbsentSince;
    const docked = facts.quarryDocked === true;
    const camp = entry.phase === PHASES.CAMP;
    if (camp && docked && now - entry.phaseSince >= params.dockCampMs) return finish(TARGET_DOCKED);
    const campable = params.dockCampEnabled === true && docked && (camp || isPoint(facts.campPoint));
    if (campable && targets.length === 0) {
      if (camp) return { ...next, quarryAbsentSince: since };
      return { ...next, phase: PHASES.CAMP, phaseSince: now, quarryAbsentSince: since, noTargetSince: null,
        warpSeen: false, actions: [{ type: "search" }, { type: "warp", point: { x: facts.campPoint.x,
          y: facts.campPoint.y, z: facts.campPoint.z } }] };
    }
    if (!campable && now - since >= params.exitGraceMs) return finish("TARGET_GONE");
    next.quarryAbsentSince = since;
  }

  const toNextObject = (before) => {
    const n = Array.isArray(entry.objects) ? entry.objects.length : 0;
    if (n === 0 || entry.visited >= params.maxObjectsPerHunt) return finish("NOT_FOUND");
    const re = retargetOf(entry, quarry, own, params);
    if (re) {
      const index = re.objectIndex === null ? entry.objectIndex : re.objectIndex;
      const warp = { type: "warp", point: re.point, retarget: true };
      if (re.objectIndex !== null) warp.objectIndex = index;
      return { ...next, phase: PHASES.SWEEP_WARP, phaseSince: now, objectIndex: index, visited: entry.visited + 1,
        noTargetSince: null, warpSeen: false, actions: [...before, warp] };
    }
    const index = (entry.objectIndex + 1) % n;
    return { ...next, phase: PHASES.SWEEP_WARP, phaseSince: now, objectIndex: index, visited: entry.visited + 1,
      noTargetSince: null, warpSeen: false,
      actions: [...before, { type: "warp", point: { ...entry.objects[index].position }, objectIndex: index }] };
  };

  const toScan = (before) => {
    if (scanCycle >= params.maxScanCycles) return finish("NOT_FOUND");
    return { ...next, phase: PHASES.SCAN, phaseSince: now, noTargetSince: null, actions: [...before] };
  };

  if (entry.phase === PHASES.ENGAGED) {
    if (targets.length > 0) return { ...next, noTargetSince: null };
    const since = entry.noTargetSince === null || entry.noTargetSince === undefined ? now : entry.noTargetSince;
    if (now - since >= params.reacquireGraceMs) {
      return entry.mode === MODE_SCAN ? toScan([{ type: "search" }]) : toNextObject([{ type: "search" }]);
    }
    return { ...next, noTargetSince: since };
  }

  if (targets.length > 0) {
    return { ...next, phase: PHASES.ENGAGED, phaseSince: now, noTargetSince: null,
      actions: [{ type: "attack", targets: [...targets] }] };
  }
  if (entry.phase === PHASES.CAMP) {
    if (quarry.state === "space") {
      return entry.mode === MODE_SCAN ? toScan([{ type: "search" }]) : toNextObject([{ type: "search" }]);
    }
    return next;
  }
  if (entry.phase === PHASES.SCAN) {
    if (now - entry.phaseSince < params.scanCycleMs) return next;
    const visible = scannable(quarry);
    const sig = visible && isNum(quarry.ship.signatureRadius) && quarry.ship.signatureRadius > 0
      ? quarry.ship.signatureRadius : params.scanRefSignatureM;
    const warm = visible && facts.warmScan === true;
    const roll = warm ? { found: true, chancePermille: 1000 } : visible ? scanRoll(entry.seed, scanCycle, sig, { basePermille: params.scanBasePermille,
      minPermille: params.scanMinPermille, maxPermille: params.scanMaxPermille,
      refSignatureM: params.scanRefSignatureM }) : null;
    const scan = { cycle: scanCycle, rolled: visible, found: Boolean(roll && roll.found),
      chancePermille: roll ? roll.chancePermille : null };
    const done = { ...next, scanCycle: scanCycle + 1, scan };
    if (scan.found) {
      const lead = own[0];
      const point = warpInPoint(quarry.ship.position, lead && lead.position, params.warpInDistanceMeters);
      return { ...done, phase: PHASES.WARP_TO_TARGET, phaseSince: now, warpSeen: false,
        actions: [{ type: "warp", point, targetId: quarry.ship.entityId }] };
    }
    if (scanCycle + 1 >= params.maxScanCycles) {
      return { ...finish("NOT_FOUND"), scanCycle: scanCycle + 1, scan };
    }
    return { ...done, phaseSince: now };
  }
  if (entry.phase === PHASES.WARP_TO_TARGET) {
    const w = warpProgress(entry, own, now, params);
    if (w.end !== null) return { ...toScan([]), warpSeen: w.seen, warpEnd: w.end };
    return { ...next, warpSeen: w.seen };
  }
  if (entry.phase === PHASES.SWEEP_WARP) {
    const w = warpProgress(entry, own, now, params);
    if (w.end !== null) {
      return { ...next, phase: PHASES.SWEEP_DWELL, phaseSince: now, warpSeen: w.seen, warpEnd: w.end };
    }
    return { ...next, warpSeen: w.seen };
  }
  if (now - entry.phaseSince >= params.objectDwellMs) return toNextObject([]);
  return next;
}

module.exports = { decideHuntStep, PHASES, ACTION_TYPES, warpProgress };
