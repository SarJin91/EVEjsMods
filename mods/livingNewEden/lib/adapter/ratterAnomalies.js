"use strict";

const READ_OPTIONS = Object.freeze({ allowTemplateDiscovery: false });

function eligible(instance, systemId, siteId) {
  const flags = instance?.runtimeFlags;
  return instance?.solarSystemID === systemId && Number(instance.metadata?.siteID) === siteId
    && instance.siteFamily === "combat"
    && (instance.lifecycleState === "active" || instance.lifecycleState === "seeded")
    && flags?.universeSeeded === true && !flags.manualSpawn && !flags.missionRuntime && !flags.generatedMining
    && !String(instance.templateID || "").startsWith("evejs-fw:")
    && instance.ownership?.visibilityScope === "public" && !instance.ownership.characterID && !instance.ownership.corporationID;
}

function listRatterAnomalies(signatures, dungeon, systemId) {
  if (!Number.isSafeInteger(systemId) || systemId <= 0 || typeof signatures?.listSystemAnomalySites !== "function"
    || typeof dungeon?.getInstanceRef !== "function") return [];
  const candidates = signatures.listSystemAnomalySites(systemId, { ...READ_OPTIONS });
  if (!Array.isArray(candidates)) return [];
  const sites = new Map();
  for (const site of candidates) {
    const siteId = Number(site?.siteID);
    if (!Number.isSafeInteger(siteId) || siteId <= 0 || sites.has(siteId)
      || !Number.isSafeInteger(site.instanceID) || site.instanceID <= 0) continue;
    const instance = dungeon.getInstanceRef(site.instanceID);
    if (!eligible(instance, systemId, siteId)) continue;
    const value = site.actualPosition || site.position;
    const [x, y, z] = Array.isArray(value) ? value : [value?.x, value?.y, value?.z];
    if (![x, y, z].every(Number.isFinite) || (x === 0 && y === 0 && z === 0)) continue;
    sites.set(siteId, { siteId, instanceId: site.instanceID, point: { x, y, z } });
  }
  return [...sites.values()].sort((a, b) => a.siteId - b.siteId);
}

function closeRatterAnomaly(dungeon, occupied, scene, systemId, site, now) {
  if (!scene || !Number.isFinite(now) || typeof occupied !== "function"
    || typeof dungeon?.getInstanceRef !== "function" || typeof dungeon?.setLifecycleState !== "function") return false;
  const instance = dungeon.getInstanceRef(site.instanceId);
  if (!eligible(instance, systemId, site.siteId) || occupied(scene, instance, site.siteId)) return false;
  return dungeon.setLifecycleState(site.instanceId, "despawned", { nowMs: now, lifecycleReason: "lne_npc_ratter" })
    ?.lifecycleState === "despawned";
}

module.exports = { listRatterAnomalies, closeRatterAnomaly };
