"use strict";

const JUMP_IN_FX = "effects.JumpIn";
const JUMP_OUT_FX = "effects.JumpOut";
const STATIC_ENTITY_PATH = "space/runtime/staticSceneEntity";
const OPTIONS_BUILDER = "buildObserverStargateJumpFxOptions";
const CONTROLLER_EVENT = "OnClientControllerEvent";
const GATE_EVENT = Object.freeze({ ARRIVAL: "Arrival", DEPARTURE: "Departure" });
const GATE_EVENT_NAMES = Object.freeze(Object.values(GATE_EVENT));
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function jumpInOptionsOf(requireGame, durationMs) {
  const fallback = { start: true, active: false, duration: durationMs };
  try {
    const read = typeof requireGame === "function" ? requireGame(STATIC_ENTITY_PATH) : null;
    const build = read && read.ok === true && read.exports ? read.exports[OPTIONS_BUILDER] : null;
    if (typeof build !== "function") return fallback;
    const built = build({ duration: durationMs });
    return built && typeof built === "object" && built.duration === durationMs ? { ...built } : fallback;
  } catch (_err) {
    return fallback;
  }
}

function sentOf(result) {
  return Number(result && result.deliveredCount) > 0;
}

function broadcastJumpIn(scene, entityId, options) {
  if (!scene || typeof scene.getEntityByID !== "function" || typeof scene.broadcastSpecialFx !== "function") {
    return { ok: false, reason: "FX_UNAVAILABLE" };
  }
  try {
    const ship = scene.getEntityByID(entityId);
    if (!ship) return { ok: false, reason: "GONE" };
    const r = scene.broadcastSpecialFx(entityId, JUMP_IN_FX, { ...(options || {}) }, ship);
    return { ok: true, sent: sentOf(r) };
  } catch (err) {
    return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
  }
}

function broadcastJumpOut(scene, entityId, gateId) {
  if (!scene || typeof scene.getEntityByID !== "function" || typeof scene.broadcastSpecialFx !== "function") {
    return { ok: false, reason: "FX_UNAVAILABLE" };
  }
  try {
    const ship = scene.getEntityByID(entityId);
    if (!ship) return { ok: false, reason: "GONE" };
    const gate = scene.getEntityByID(gateId);
    const destination = gate ? Number(gate.destinationSolarSystemID) : 0;
    if (!gate || gate.kind !== "stargate" || !isPositiveInt(destination)) return { ok: false, reason: "NO_GATE" };
    const r = scene.broadcastSpecialFx(entityId, JUMP_OUT_FX, {
      targetID: gate.itemID,
      graphicInfo: { type: "tuple", items: [destination, null] },
      start: true,
      active: false,
      includeStopInSameUpdate: true,
    }, ship);
    return { ok: true, sent: sentOf(r) };
  } catch (err) {
    return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
  }
}

function broadcastGateEvent(scene, gateId, entityId, eventName) {
  if (!isPositiveInt(gateId) || !isPositiveInt(entityId) || !GATE_EVENT_NAMES.includes(eventName)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  if (!scene || typeof scene.getEntityByID !== "function" || typeof scene.queueCharacterHistory !== "function"
    || !(scene.sessions instanceof Map)) {
    return { ok: false, reason: "FX_UNAVAILABLE" };
  }
  try {
    if (!scene.getEntityByID(entityId)) return { ok: false, reason: "GONE" };
    const gate = scene.getEntityByID(gateId);
    if (!gate || gate.kind !== "stargate") return { ok: false, reason: "NO_GATE" };
    const payload = [CONTROLLER_EVENT, [Number(gate.itemID), entityId, eventName]];
    let queued = 0;
    for (const session of scene.sessions.values()) {
      if (scene.queueCharacterHistory(session, [payload]) !== null) queued += 1;
    }
    return { ok: true, sent: queued > 0, queued };
  } catch (err) {
    return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
  }
}

module.exports = { JUMP_IN_FX, JUMP_OUT_FX, CONTROLLER_EVENT, GATE_EVENT, jumpInOptionsOf, broadcastJumpIn,
  broadcastJumpOut, broadcastGateEvent };
