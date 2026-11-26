"use strict";

const SCENE_NPC_BUDGET = "SCENE_NPC_BUDGET";

function sceneRefusalOf(npcSpawn, systemId, n, source) {
  if (!npcSpawn || typeof npcSpawn.admitScene !== "function") return null;
  try {
    const r = npcSpawn.admitScene(systemId, n, source);
    return r && r.ok === false ? String(r.reason || SCENE_NPC_BUDGET) : null;
  } catch (_err) {
    return null;
  }
}

function isSceneRefusal(reason) {
  return reason === SCENE_NPC_BUDGET;
}

module.exports = { sceneRefusalOf, isSceneRefusal, SCENE_NPC_BUDGET };
