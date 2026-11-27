"use strict";

const MINING_FX = "effects.Mining";
// Vendor fakeMining cycle count.
const MINING_REPEAT = 99;
const ASTEROID_KIND = "asteroid";
const WARP_MODE = "WARP";
const FOLLOW_MODE = "FOLLOW";
const MAX_DETAIL = 120;
const MOTION_FUNCTIONS = Object.freeze(["getControllerByEntityID", "issueManualOrder", "wakeNpcController"]);
// The vendor NPC brain skips a scripted order, so the follow is not stopped by its next think.
const APPROACH_MARKER = "lneApproach";
const APPROACH_ORDER = Object.freeze({ type: "scripted", [APPROACH_MARKER]: true });
const RESUME_ORDER = Object.freeze({ type: "resume" });
const FOLLOW_OPTIONS = Object.freeze({ speedFraction: 1, queueHistorySafeContract: true,
  suppressFreshAcquireReplay: true });
const SCRIPT_REFUSAL = Object.freeze({
  BUSY: Object.freeze({ ok: false, reason: "BUSY" }),
  AGGRESSED: Object.freeze({ ok: false, reason: "AGGRESSED" }),
  FAILED: Object.freeze({ ok: false, reason: "FAILED" }),
});
const SCRIPT_OK = Object.freeze({ ok: true });

const cache = new WeakMap();

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function pointOf(p) {
  if (!p || typeof p !== "object") return null;
  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function rockOf(entity) {
  if (!entity || entity.kind !== ASTEROID_KIND || entity.generatedMiningSiteAnchor === true) return null;
  const itemId = Number(entity.itemID);
  const position = pointOf(entity.position);
  if (!isPositiveInt(itemId) || position === null) return null;
  const beltId = Number(entity.beltID);
  return { itemId, position, beltId: isPositiveInt(beltId) ? beltId : null, radius: radiusOf(entity) };
}

function radiusOf(entity) {
  const r = Number(entity && entity.radius);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

function buildRocks(scene) {
  const list = Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  const byBelt = new Map();
  const byId = new Map();
  const all = [];
  for (const entity of list) {
    const rock = rockOf(entity);
    if (rock === null) continue;
    all.push(rock);
    byId.set(rock.itemId, rock);
    if (rock.beltId === null) continue;
    if (!byBelt.has(rock.beltId)) byBelt.set(rock.beltId, []);
    byBelt.get(rock.beltId).push(rock);
  }
  const built = { list, count: list.length, byBelt, byId, all };
  cache.set(scene, built);
  return built;
}

function rocksOf(scene, rebuild) {
  const list = Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  const cached = cache.get(scene);
  if (rebuild === true || !cached || cached.list !== list || cached.count !== list.length) return buildRocks(scene);
  return cached;
}

function nearestOf(rocks, from, rangeSq) {
  let best = null;
  let bestSq = Infinity;
  for (const rock of rocks) {
    const d = distanceSq(rock.position, from);
    if (d <= rangeSq && d < bestSq) {
      best = rock;
      bestSq = d;
    }
  }
  return best;
}

function stillThere(scene, rock) {
  const byId = scene.staticEntitiesByID;
  return !(byId instanceof Map) || byId.has(rock.itemId);
}

function nearestIn(rocks, from, beltId, rangeSq) {
  const group = beltId !== null && rocks.byBelt.has(beltId) ? rocks.byBelt.get(beltId) : rocks.all;
  return nearestOf(group, from, rangeSq);
}

function pickRock(scene, from, beltId, rangeSq, call) {
  const rock = nearestIn(rocksOf(scene, false), from, beltId, rangeSq);
  if (rock === null || stillThere(scene, rock)) return rock;
  if (call.rebuilt) return null;
  call.rebuilt = true;
  const again = nearestIn(rocksOf(scene, true), from, beltId, rangeSq);
  return again !== null && stillThere(scene, again) ? again : null;
}

function startPayload(entityId, rock, distance) {
  return { moduleID: entityId, targetID: rock.itemId, exactArgs: true, isOffensive: false, start: true, active: 0,
    duration: distance, repeat: MINING_REPEAT, startTime: null, timeFromStart: 0, graphicInfo: null };
}

function stopPayload(entityId, rockId) {
  return { moduleID: entityId, targetID: rockId, exactArgs: true, isOffensive: false, start: false, active: 0,
    duration: null, repeat: null, startTime: null, timeFromStart: 0, graphicInfo: null,
    stopAfterTargetRemoved: true };
}

function validStart(s) {
  return Boolean(s) && isPositiveInt(s.entityId) && (s.beltId === null || s.beltId === undefined
    || isPositiveInt(s.beltId));
}

function validStop(s) {
  return Boolean(s) && isPositiveInt(s.entityId) && isPositiveInt(s.rockId);
}

function validApproach(a) {
  return a === undefined || a === null || (typeof a === "object"
    && Number.isFinite(a.startMeters) && a.startMeters > 0 && Number.isFinite(a.followMeters) && a.followMeters > 0
    && a.followMeters < a.startMeters);
}

function validRequest(req) {
  return Boolean(req) && typeof req === "object" && Array.isArray(req.start) && Array.isArray(req.stop)
    && req.start.every(validStart) && req.stop.every(validStop)
    && (req.release === undefined || (Array.isArray(req.release) && req.release.every(isPositiveInt)))
    && validApproach(req.approach)
    && Number.isFinite(req.rockRangeMeters) && req.rockRangeMeters > 0
    && Number.isSafeInteger(req.maxFx) && req.maxFx >= 0;
}

function motionOf(npc, marker = APPROACH_MARKER) {
  if (!npc || MOTION_FUNCTIONS.some((name) => typeof npc[name] !== "function")) return null;
  if (typeof marker !== "string" || marker === "") return null;
  const scriptOrder = marker === APPROACH_MARKER ? APPROACH_ORDER
    : Object.freeze({ type: APPROACH_ORDER.type, [marker]: true });
  const controllerOf = (id) => {
    try {
      return npc.getControllerByEntityID(id) || null;
    } catch (_err) {
      return null;
    }
  };
  const isOurs = (controller) => {
    const order = controller && controller.manualOrder;
    return Boolean(order) && typeof order === "object" && order.type === scriptOrder.type
      && order[marker] === true;
  };
  const ours = (id) => isOurs(controllerOf(id));
  const script = (id) => {
    const controller = controllerOf(id);
    if (!controller) return SCRIPT_REFUSAL.FAILED;
    if (isOurs(controller)) return SCRIPT_OK;
    if (controller.manualOrder) return SCRIPT_REFUSAL.BUSY;
    if (Number(controller.lastAggressedAtMs) > 0) return SCRIPT_REFUSAL.AGGRESSED;
    try {
      const r = npc.issueManualOrder(id, { ...scriptOrder });
      return r && r.success === true ? SCRIPT_OK : SCRIPT_REFUSAL.FAILED;
    } catch (_err) {
      return SCRIPT_REFUSAL.FAILED;
    }
  };
  const release = (id) => {
    if (!ours(id)) return false;
    try {
      const r = npc.issueManualOrder(id, { ...RESUME_ORDER });
      if (!r || r.success !== true) return false;
      npc.wakeNpcController(id, 0);
      return true;
    } catch (_err) {
      return false;
    }
  };
  return Object.freeze({ script, release, ours });
}

function isMode(ship, mode) {
  return String((ship && ship.mode) || "").trim().toUpperCase() === mode;
}

function followedRock(scene, ship) {
  if (!isMode(ship, FOLLOW_MODE)) return null;
  const rock = rocksOf(scene, false).byId.get(Number(ship.targetEntityID));
  return rock && stillThere(scene, rock) ? rock : null;
}

function followTo(scene, ship, rock, followMeters) {
  try {
    return scene.followShipEntity(ship, rock.itemId, followMeters, { ...FOLLOW_OPTIONS }) === true;
  } catch (_err) {
    return false;
  }
}

function presentBeams(scene, req, motion) {
  if (!validRequest(req)) return { ok: false, reason: "INVALID_INPUT" };
  if (!scene || typeof scene.getEntityByID !== "function" || typeof scene.broadcastSpecialFx !== "function") {
    return { ok: false, reason: "FX_UNAVAILABLE" };
  }
  const mover = motion && typeof motion.script === "function" && typeof motion.release === "function"
    && typeof motion.ours === "function" ? motion : null;
  const approach = req.approach && mover && typeof scene.followShipEntity === "function" ? req.approach : null;
  const rangeSq = req.rockRangeMeters * req.rockRangeMeters;
  const started = [];
  const approaching = [];
  const released = [];
  const busy = [];
  const noRock = [];
  const skipped = [];
  let stopped = 0;
  let fxSent = 0;
  let ordersSent = 0;
  let budgetCut = 0;
  let refused = 0;
  const call = { rebuilt: false };
  const releaseOurs = (id) => {
    if (mover && mover.ours(id) && mover.release(id)) released.push(id);
  };
  const beam = (ship, entityId, rock, from) => {
    fxSent += 1;
    scene.broadcastSpecialFx(entityId, MINING_FX,
      startPayload(entityId, rock, Math.sqrt(distanceSq(from, rock.position))), ship);
    started.push({ entityId, rockId: rock.itemId });
  };
  try {
    if (mover) for (const id of req.release || []) if (mover.release(id)) released.push(id);
    for (const s of req.stop) {
      const ship = scene.getEntityByID(s.entityId);
      if (!ship) continue;
      if (fxSent >= req.maxFx) {
        budgetCut += 1;
        continue;
      }
      fxSent += 1;
      scene.broadcastSpecialFx(s.entityId, MINING_FX, stopPayload(s.entityId, s.rockId), ship);
      stopped += 1;
    }
    for (const s of req.start) {
      const ship = scene.getEntityByID(s.entityId);
      const from = pointOf(ship && ship.position);
      if (!ship || from === null || isMode(ship, WARP_MODE)) {
        skipped.push(s.entityId);
        releaseOurs(s.entityId);
        continue;
      }
      if (fxSent + ordersSent >= req.maxFx) {
        budgetCut += 1;
        continue;
      }
      const rock = followedRock(scene, ship)
        || pickRock(scene, from, isPositiveInt(s.beltId) ? s.beltId : null, rangeSq, call);
      if (rock === null) {
        noRock.push(s.entityId);
        releaseOurs(s.entityId);
        continue;
      }
      const surface = Math.max(0, Math.sqrt(distanceSq(from, rock.position)) - radiusOf(ship) - rock.radius);
      if (!approach || surface <= approach.startMeters) {
        releaseOurs(s.entityId);
        beam(ship, s.entityId, rock, from);
        continue;
      }
      if (isMode(ship, FOLLOW_MODE) && Number(ship.targetEntityID) === rock.itemId && mover.ours(s.entityId)) {
        approaching.push({ entityId: s.entityId, rockId: rock.itemId });
        continue;
      }
      if (mover.script(s.entityId).ok !== true) {
        busy.push(s.entityId);
        continue;
      }
      if (followTo(scene, ship, rock, approach.followMeters)) {
        ordersSent += 1;
        approaching.push({ entityId: s.entityId, rockId: rock.itemId });
        continue;
      }
      if (mover.release(s.entityId)) released.push(s.entityId);
      refused += 1;
      beam(ship, s.entityId, rock, from);
    }
  } catch (err) {
    return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
  }
  return { ok: true, started, approaching, released, stopped, noRock, skipped, busy, fxSent, ordersSent, budgetCut,
    refused };
}

module.exports = { MINING_FX, MINING_REPEAT, MOTION_FUNCTIONS, APPROACH_ORDER, presentBeams, motionOf, rocksOf };
