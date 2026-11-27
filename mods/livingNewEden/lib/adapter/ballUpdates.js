"use strict";

const ACTIONS_PATH = "space/destiny/stream/actions";
const WARPING_FX = "effects.Warping";
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function actionsOf(requireGame) {
  try {
    const read = typeof requireGame === "function" ? requireGame(ACTIONS_PATH) : null;
    return read && read.ok === true && read.exports ? read.exports : null;
  } catch (_err) {
    return null;
  }
}

function queueWarpingFx(requireGame, scene, entityId) {
  const actions = actionsOf(requireGame);
  if (!actions || typeof actions.buildOnSpecialFXPayload !== "function" || !scene
    || typeof scene.queueBubbleHistory !== "function" || typeof scene.getEntityByID !== "function") {
    return { ok: false, reason: "FX_UNAVAILABLE" };
  }
  try {
    if (!scene.getEntityByID(entityId)) return { ok: false, reason: "GONE" };
    const payload = actions.buildOnSpecialFXPayload(entityId, WARPING_FX, { active: false });
    const stamp = scene.queueBubbleHistory([{ stamp: scene.nextDestinyStamp, payload }]);
    return { ok: true, sent: stamp !== null && stamp !== undefined };
  } catch (err) {
    return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
  }
}

function yawRotationOf(direction) {
  const d = direction && typeof direction === "object" ? direction : null;
  const x = d ? d.x : NaN;
  const y = d ? d.y : NaN;
  const z = d ? d.z : NaN;
  if (![x, y, z].every((v) => typeof v === "number" && Number.isFinite(v)) || Math.hypot(x, z) <= 0) return null;
  const half = Math.atan2(x, z) / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function queueRotation(requireGame, scene, entityId, direction) {
  const rotation = yawRotationOf(direction);
  if (rotation === null || !Number.isSafeInteger(entityId) || entityId <= 0) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const actions = actionsOf(requireGame);
  if (!actions || typeof actions.buildSetBallRotationPayload !== "function" || !scene
    || typeof scene.queueBubbleHistory !== "function" || typeof scene.getEntityByID !== "function") {
    return { ok: false, reason: "FX_UNAVAILABLE" };
  }
  try {
    if (!scene.getEntityByID(entityId)) return { ok: false, reason: "GONE" };
    const payload = actions.buildSetBallRotationPayload(entityId, rotation);
    const stamp = scene.queueBubbleHistory([{ stamp: scene.nextDestinyStamp, payload }]);
    return { ok: true, sent: stamp !== null && stamp !== undefined };
  } catch (err) {
    return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
  }
}

module.exports = { ACTIONS_PATH, WARPING_FX, queueWarpingFx, yawRotationOf, queueRotation };
