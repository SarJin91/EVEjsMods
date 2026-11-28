"use strict";

// Same gate-model event as EveJS's session-based stargate transition.
// A simulated traveller has no player session to exclude.
function emitGateAnimation(scene, gate, shipId, eventName) {
  if (gate?.kind !== "stargate" || !(scene.sessions instanceof Map) ||
      typeof scene.queueCharacterHistory !== "function") return;
  const event = ["OnClientControllerEvent", [gate.itemID, shipId, eventName]];
  for (const session of scene.sessions.values()) {
    scene.queueCharacterHistory(session, [event]);
  }
}

module.exports = { emitGateAnimation };
