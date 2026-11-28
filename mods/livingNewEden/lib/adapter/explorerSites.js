"use strict";

const { TRAFFIC_OPERATOR_KIND } = require("./data/liveProfiles");

const EXPLORER_READ_OPTIONS = Object.freeze({ allowTemplateDiscovery: false });
const SIGNATURE_RUNTIME_PATH = "services/exploration/signatures/signatureRuntime";
const SITE_POOL_FACTOR = 4;
const MAX_DETAIL = 120;

function pointOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function sitePointOf(site) {
  let p = pointOf(site.actualPosition);
  if (p === null && Array.isArray(site.position) && site.position.length >= 3) {
    p = pointOf({ x: site.position[0], y: site.position[1], z: site.position[2] });
  }
  return p === null || (p.x === 0 && p.y === 0 && p.z === 0) ? null : p;
}

function validOpts(opts) {
  return Boolean(opts) && typeof opts === "object" && Array.isArray(opts.families) && opts.families.length > 0
    && opts.families.every((f) => typeof f === "string" && f !== "")
    && Number.isFinite(opts.npcClearMeters) && opts.npcClearMeters > 0
    && Number.isSafeInteger(opts.maxSites) && opts.maxSites > 0;
}

function npcPositionsOf(scene) {
  const out = [];
  const dynamics = scene && scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [];
  for (const entity of dynamics) {
    if (!entity || entity.kind !== "ship" || entity.session) continue;
    if (String(entity.operatorKind || "").trim() === TRAFFIC_OPERATOR_KIND) continue;
    const p = pointOf(entity.position);
    if (p !== null) out.push(p);
  }
  return out;
}

function readExplorerSites(signatureRuntime, scene, systemId, opts) {
  if (!Number.isSafeInteger(systemId) || systemId <= 0 || !validOpts(opts)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  if (!signatureRuntime || typeof signatureRuntime.listSystemSignatureSites !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  let list = null;
  try {
    list = signatureRuntime.listSystemSignatureSites(systemId, { ...EXPLORER_READ_OPTIONS });
  } catch (err) {
    return { ok: false, reason: "READ_FAILED", detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
  }
  if (!Array.isArray(list)) return { ok: false, reason: "READ_FAILED", detail: "NOT_A_LIST" };
  const families = new Set(opts.families);
  const npcs = npcPositionsOf(scene);
  const reach = opts.npcClearMeters;
  const sites = [];
  let npcBlocked = 0;
  for (const site of list) {
    if (!site || typeof site !== "object") continue;
    const siteId = Number(site.siteID);
    const family = String(site.family || "").trim().toLowerCase();
    if (!Number.isSafeInteger(siteId) || siteId <= 0 || !families.has(family)) continue;
    const position = sitePointOf(site);
    if (position === null) continue;
    if (npcs.some((p) => Math.hypot(p.x - position.x, p.y - position.y, p.z - position.z) <= reach)) {
      npcBlocked += 1;
      continue;
    }
    sites.push({ siteId, family, position });
  }
  sites.sort((a, b) => a.siteId - b.siteId);
  return { ok: true, sites: sites.slice(0, opts.maxSites * SITE_POOL_FACTOR), read: list.length, npcBlocked };
}

function closePublicSite(signatureRuntime, dungeonRuntime, occupied, scene, systemId, siteId, now) {
  if (!scene || !Number.isSafeInteger(systemId) || systemId <= 0 || !Number.isSafeInteger(siteId) || siteId <= 0
    || !Number.isFinite(now) || typeof occupied !== "function"
    || typeof signatureRuntime?.listSystemSignatureSites !== "function"
    || typeof dungeonRuntime?.getInstanceRef !== "function" || typeof dungeonRuntime?.setLifecycleState !== "function") return false;
  const rows = signatureRuntime.listSystemSignatureSites(systemId, { ...EXPLORER_READ_OPTIONS });
  if (!Array.isArray(rows)) return false;
  const site = rows.find((row) => row && Number(row.siteID) === siteId);
  if (!Number.isSafeInteger(site?.instanceID) || site.instanceID <= 0) return false;
  const instance = dungeonRuntime.getInstanceRef(site.instanceID);
  const flags = instance?.runtimeFlags;
  if (instance?.solarSystemID !== systemId || Number(instance.metadata?.siteID) !== siteId
    || flags?.universeSeeded !== true || flags.manualSpawn || flags.missionRuntime || flags.generatedMining
    || String(instance.templateID || "").startsWith("evejs-fw:")
    || instance.ownership?.visibilityScope !== "public" || instance.ownership.characterID || instance.ownership.corporationID
    || (instance.siteFamily !== "data" && instance.siteFamily !== "relic")
    || (instance.lifecycleState !== "active" && instance.lifecycleState !== "seeded")) return false;
  if (occupied(scene, instance, siteId)) return false;
  return dungeonRuntime.setLifecycleState(site.instanceID, "despawned",
    { nowMs: now, lifecycleReason: "lne_npc_explorer" })?.lifecycleState === "despawned";
}

module.exports = { EXPLORER_READ_OPTIONS, SIGNATURE_RUNTIME_PATH, readExplorerSites, closePublicSite };
