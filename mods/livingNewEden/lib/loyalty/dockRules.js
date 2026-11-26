"use strict";

function planDock(input, params) {
  const controller = input ? input.controllerFactionId : null;
  if (!Number.isSafeInteger(controller) || controller <= 0) return { deny: false, reason: "NO_CONTROLLER" };
  if (input.isCapsule === true && params && params.dockDenyExemptCapsule === true) {
    return { deny: false, reason: "CAPSULE" };
  }
  const standing = input.standing;
  if (typeof standing !== "number" || !Number.isFinite(standing)) return { deny: false, reason: "STANDING_UNKNOWN" };
  const max = params ? params.dockDenyStandingMax : undefined;
  if (typeof max === "number" && Number.isFinite(max) && standing <= max) {
    return { deny: true, reason: "HOSTILE_CONTROLLER", factionId: controller, standing };
  }
  return { deny: false, reason: "STANDING_OK" };
}

module.exports = { planDock };
