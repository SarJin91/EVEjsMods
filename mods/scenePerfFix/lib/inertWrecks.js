"use strict";

function speedOf(velocity) {
  if (!velocity || typeof velocity !== "object") return 0;
  const x = Number(velocity.x) || 0;
  const y = Number(velocity.y) || 0;
  const z = Number(velocity.z) || 0;
  return Math.sqrt(x * x + y * y + z * z);
}

function isInertEntity(entity, config) {
  if (!entity || typeof entity !== "object") return false;
  if (!config.inertKinds.includes(String(entity.kind || "").toLowerCase())) return false;
  if (String(entity.mode || "").toUpperCase() !== "STOP") return false;
  if (entity.pendingWarp || entity.warpState || entity.pendingDock || entity.sessionlessWarpIngress) return false;
  if (entity.session) return false;
  return speedOf(entity.velocity) <= config.inertSpeedEpsilon;
}

function entitiesOf(scene) {
  const ents = scene && scene.dynamicEntities;
  if (ents instanceof Map) return ents.values();
  if (ents && typeof ents === "object") return Object.values(ents);
  return [];
}

function createAdvanceWrapper(original, markAdvanced, config, stats) {
  const SEQ_KEY = "_scenePerfFixInertSeq";
  return function advanceEntityForActiveSceneTickScenePerf(scene, entity) {
    try {
      const seq = Number(scene && scene._activeTickSequence) || 0;
      if (seq > 0 && scene[SEQ_KEY] !== seq) {
        scene[SEQ_KEY] = seq;
        let skipped = 0;
        for (const candidate of entitiesOf(scene)) {
          if (candidate === entity && !isInertEntity(candidate, config)) continue;
          if (Number(candidate._lastMovementAdvancedTickSequence) === seq) continue;
          if (isInertEntity(candidate, config) && markAdvanced(scene, candidate)) skipped += 1;
        }
        stats.ticks += 1;
        stats.skipped += skipped;
        if (skipped > stats.maxSkippedPerTick) stats.maxSkippedPerTick = skipped;
      }
    } catch (error) {
      stats.errors += 1;
      stats.lastError = String(error && error.message || error);
    }
    return original.apply(this, arguments);
  };
}

module.exports = { createAdvanceWrapper, isInertEntity, speedOf };
