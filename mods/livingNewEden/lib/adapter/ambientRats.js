"use strict";

const { NAVY_PROFILES_BY_FACTION_ID } = require("./empireNavyCatalog");
const { buildNavyDefinitions, classifyHull } = require("./empireBelts");
const { NAVY_PASSIVE_BEHAVIOR, AMBIENT_ARMED_TARGET_CLASSES } = require("./data/liveProfiles");
const { admitOrPass } = require("./sceneNpcBudget");

const OPERATOR_KIND = "lneAmbient";
const SELECTION_PREFIX = "lne_ambient";
const NAVY_TEMPLATE_FACTION_KEY = "guristas";
const GROUP_RADIUS_METERS = 3000;
const GROUP_SPREAD_METERS = 2000;
const FORMATION_SPACING_METERS = 2000;
const MAX_DETAIL = 120;

const PATHS = Object.freeze({
  belt: "space/npc/beltRatRuntime",
  runtime: "space/runtime",
  store: "space/npc/nativeNpcStore",
  npcData: "space/npc/npcData",
  native: "space/npc/nativeNpcService",
  npc: "space/npc/npcService",
});
const FUNCTIONS = Object.freeze({
  belt: ["resolveSecurityProfile", "buildBeltRatSpawnPlan"],
  store: ["getNativeController", "listNativeControllersForSystem"],
  npcData: ["buildNpcDefinition"],
  native: ["spawnNativeDefinitionsInContext"],
  npc: ["setBehaviorOverrides", "getControllerByEntityID"],
});

function toPositiveInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function positionOf(entity) {
  const p = entity && entity.position;
  if (!p) return null;
  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function isAmbientVictim(entity) {
  if (!entity || typeof entity !== "object") return false;
  if (String(entity.operatorKind).trim() === OPERATOR_KIND) return true;
  return typeof entity.selectionID === "string" && entity.selectionID.startsWith(`${SELECTION_PREFIX}:`);
}

function unitVector(random) {
  const u = 2 * random() - 1;
  const phi = 2 * Math.PI * random();
  const s = Math.sqrt(Math.max(0, 1 - u * u));
  return { x: s * Math.cos(phi), y: s * Math.sin(phi), z: u };
}

function kindSet(kinds) {
  const list = Array.isArray(kinds) ? kinds : String(kinds || "").split(",");
  return new Set(list.map((k) => String(k).trim().toLowerCase()).filter(Boolean));
}

function createAmbientRatSeam(deps) {
  const requireGame = deps && deps.requireGame;
  const getSpawnTools = deps && deps.getSpawnTools;
  const admit = admitOrPass(deps && deps.admit);

  function load(key) {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(PATHS[key]);
    const mod = read && read.ok === true && read.exports ? read.exports : null;
    if (!mod) return null;
    return (FUNCTIONS[key] || []).every((name) => typeof mod[name] === "function") ? mod : null;
  }

  function runtimeModule() {
    const runtime = load("runtime");
    return runtime && typeof runtime.isSolarSystemSceneLoaded === "function" && runtime.scenes instanceof Map
      ? runtime : null;
  }

  function sceneOf(systemId) {
    const runtime = runtimeModule();
    if (!runtime) return { ok: false, reason: "SEAM_UNAVAILABLE" };
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const scene = runtime.scenes.get(systemId);
    if (!scene || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
    return { ok: true, scene };
  }

  function bandOf(systemId) {
    try {
      const belt = load("belt");
      if (!belt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const profile = belt.resolveSecurityProfile(toPositiveInt(systemId));
      if (!profile || typeof profile.band !== "string") return { ok: false, reason: "READ_FAILED" };
      return { ok: true, band: profile.band, eligible: profile.eligible === true };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function snapshot(systemId, opts) {
    try {
      const id = toPositiveInt(systemId);
      const store = load("store");
      if (!store) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(id);
      if (!sc.ok) return sc;
      const kinds = kindSet(opts && opts.anchorKinds);
      const anchors = [];
      const statics = Array.isArray(sc.scene.staticEntities) ? sc.scene.staticEntities : [];
      for (const entity of statics) {
        if (!entity || !kinds.has(String(entity.kind || "").trim().toLowerCase())) continue;
        const itemId = toPositiveInt(entity.itemID);
        const position = positionOf(entity);
        if (itemId && position) anchors.push({ itemId, kind: String(entity.kind), position });
      }
      const blockers = [];
      const ambient = new Set();
      const dynamics = sc.scene.dynamicEntities instanceof Map ? sc.scene.dynamicEntities.values() : [];
      for (const entity of dynamics) {
        if (!entity || entity.nativeNpc !== true) continue;
        if (String(entity.operatorKind || "").trim() === OPERATOR_KIND) {
          const itemId = toPositiveInt(entity.itemID);
          if (itemId) ambient.add(itemId);
          continue;
        }
        const position = positionOf(entity);
        if (position) blockers.push(position);
      }
      const controllers = store.listNativeControllersForSystem(id);
      for (const controller of Array.isArray(controllers) ? controllers : []) {
        if (String((controller && controller.operatorKind) || "").trim() !== OPERATOR_KIND) continue;
        const entityId = toPositiveInt(controller.entityID);
        if (entityId) ambient.add(entityId);
      }
      return { ok: true, anchors, blockers, ambientIds: [...ambient].sort((a, b) => a - b) };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function planDefinitions(belt, tools, input) {
    const navy = input.source && input.source.type === "navy";
    const navyProfile = navy ? NAVY_PROFILES_BY_FACTION_ID[String(input.factionId)] : null;
    if (navy && !navyProfile) return { ok: false, reason: "NAVY_FAILED", detail: "NO_NAVY_PROFILE" };
    const factionKey = navy ? NAVY_TEMPLATE_FACTION_KEY : String((input.source && input.source.factionKey) || "").trim();
    if (!factionKey) return { ok: false, reason: "PLAN_FAILED", detail: "NO_FACTION_KEY" };
    const options = { factionKey, skipSpecialSpawns: true, minCount: input.minCount, maxCount: input.maxCount,
      ...(typeof input.random === "function" ? { random: input.random } : {}) };
    const plan = belt.buildBeltRatSpawnPlan(input.systemId, options);
    const planned = plan && plan.success === true && plan.data && Array.isArray(plan.data.definitions)
      ? plan.data.definitions : null;
    if (!planned || planned.length === 0) {
      return { ok: false, reason: "PLAN_FAILED", detail: String((plan && plan.errorMsg) || "NO_RESULT").slice(0,
        MAX_DETAIL) };
    }
    if (!navy) return { ok: true, planned, definitions: planned };
    const built = buildNavyDefinitions(planned, navyProfile, tools.buildNpcDefinition, null);
    if (!built || built.ok !== true) return { ok: false, reason: "NAVY_FAILED", detail: (built && built.reason) || "" };
    return { ok: true, planned, definitions: built.definitions };
  }

  function spawnGroup(input) {
    try {
      const systemId = toPositiveInt(input && input.systemId);
      const anchorId = toPositiveInt(input && input.anchorId);
      const factionId = toPositiveInt(input && input.factionId);
      const groupKey = String((input && input.groupKey) || "").trim();
      const distance = Number(input && input.distanceFromSurfaceMeters);
      if (!systemId || !anchorId || !factionId || !groupKey || !(distance > 0)) {
        return { ok: false, reason: "SPAWN_FAILED", detail: "INVALID_INPUT" };
      }
      const belt = load("belt");
      const tools = typeof getSpawnTools === "function" ? getSpawnTools() : null;
      if (!belt || !tools || tools.ok !== true) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: (tools && tools.reason) || "" };
      }
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const anchor = sc.scene.getEntityByID(anchorId);
      if (!anchor) return { ok: false, reason: "ANCHOR_GONE" };
      const defs = planDefinitions(belt, tools, { ...input, systemId, factionId });
      if (!defs.ok) return defs;
      const selectionID = `${SELECTION_PREFIX}:${factionId}:${groupKey}`;
      const anchorKind = String(anchor.kind || "anchor");
      const anchorName = String(anchor.itemName || anchor.slimName || anchorKind);
      const origin = positionOf(anchor);
      if (!origin) return { ok: false, reason: "ANCHOR_GONE" };
      const dir = typeof input.random === "function" ? unitVector(input.random) : { x: 1, y: 0, z: 0 };
      const reach = Math.max(0, Number(anchor.radius) || 0) + distance;
      const center = { x: origin.x + dir.x * reach, y: origin.y + dir.y * reach, z: origin.z + dir.z * reach };
      const anchorEntity = { itemID: anchorId, kind: anchor.kind, itemName: anchorName, position: center, radius: 0,
        direction: anchor.direction };
      const context = { systemID: systemId, scene: sc.scene, anchorEntity, preferredTargetID: 0, anchorKind,
        anchorLabel: anchorName };
      const selection = { success: true, data: { selectionKind: OPERATOR_KIND, selectionID, selectionName: selectionID,
        definitions: defs.definitions } };
      const gate = admit(systemId, defs.definitions.length, "ambientRats");
      if (!gate || gate.ok !== true) return gate;
      const res = tools.spawnNativeDefinitionsInContext(context, selection, {
        entityType: "npc", transient: true, operatorKind: OPERATOR_KIND, selectionID, preferredTargetID: 0,
        behaviorOverrides: { ...NAVY_PASSIVE_BEHAVIOR }, spawnDistanceMeters: GROUP_RADIUS_METERS,
        spreadMeters: GROUP_SPREAD_METERS, formationSpacingMeters: FORMATION_SPACING_METERS, anchorKind,
        anchorID: anchorId, anchorName, spawnSiteID: groupKey, deferGroupBehaviorTick: true,
      });
      const spawned = res && res.success === true && res.data && Array.isArray(res.data.spawned) ? res.data.spawned : [];
      const entityIds = [];
      const hulls = [];
      spawned.forEach((entry, i) => {
        const itemId = toPositiveInt(entry && entry.entity && entry.entity.itemID);
        if (!itemId) return;
        entityIds.push(itemId);
        const hull = classifyHull(defs.planned[i]);
        if (hull) hulls.push(hull);
      });
      if (entityIds.length === 0) {
        return { ok: false, reason: "SPAWN_FAILED", detail: String((res && res.errorMsg) || "NO_RESULT").slice(0,
          MAX_DETAIL) };
      }
      return { ok: true, entityIds, hulls };
    } catch (err) {
      return { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
    }
  }

  function classifyIds(systemId, ids) {
    try {
      const store = load("store");
      const runtime = runtimeModule();
      if (!store || !runtime) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const id = toPositiveInt(systemId);
      let scene = null;
      if (runtime.isSolarSystemSceneLoaded(id) === true) {
        const s = runtime.scenes.get(id);
        if (s && typeof s.getEntityByID === "function") scene = s;
      }
      const live = [];
      const dormant = [];
      const gone = [];
      for (const raw of Array.isArray(ids) ? ids : []) {
        const entityId = toPositiveInt(raw);
        if (!entityId) continue;
        if (scene && scene.getEntityByID(entityId)) live.push(entityId);
        else if (store.getNativeController(entityId)) dormant.push(entityId);
        else gone.push(entityId);
      }
      return { ok: true, live, dormant, gone };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function setAggro(systemId, entityIds, armed, rangeMeters) {
    try {
      const id = toPositiveInt(systemId);
      const range = Number(rangeMeters);
      if (!id || !Array.isArray(entityIds) || typeof armed !== "boolean" || (armed && !(range > 0))) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
      const npc = load("npc");
      if (!npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(id);
      if (!sc.ok) return sc;
      let changed = 0;
      let missing = 0;
      for (const raw of entityIds) {
        const entityId = toPositiveInt(raw);
        const controller = entityId ? npc.getControllerByEntityID(entityId) : null;
        if (!controller || typeof controller !== "object") {
          missing += 1;
          continue;
        }
        const current = controller.behaviorOverrides && typeof controller.behaviorOverrides === "object"
          ? controller.behaviorOverrides : {};
        const isArmed = current.autoAggro === false && current.proximityAggroRangeMeters === range;
        const isPassive = !(current.proximityAggroRangeMeters > 0);
        if (armed ? isArmed : isPassive) continue;
        const overrides = armed
          ? { ...NAVY_PASSIVE_BEHAVIOR, proximityAggroRangeMeters: range,
            proximityAggroTargetClasses: [...AMBIENT_ARMED_TARGET_CLASSES] }
          : { ...NAVY_PASSIVE_BEHAVIOR };
        const set = npc.setBehaviorOverrides(entityId, overrides);
        if (set && set.success === true) changed += 1;
        else missing += 1;
      }
      return { ok: true, changed, missing };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({ bandOf, snapshot, spawnGroup, classifyIds, setAggro });
}

function checkAmbientRatSeamsFrom(requireGame) {
  const missing = [];
  for (const key of Object.keys(PATHS)) {
    const r = typeof requireGame === "function" ? requireGame(PATHS[key]) : null;
    if (!r || r.ok !== true || !r.exports) {
      missing.push(PATHS[key]);
      continue;
    }
    for (const name of FUNCTIONS[key] || []) {
      if (typeof r.exports[name] !== "function") missing.push(`${PATHS[key]}.${name}`);
    }
    if (key === "runtime" && (typeof r.exports.isSolarSystemSceneLoaded !== "function"
      || !(r.exports.scenes instanceof Map))) missing.push(`${PATHS.runtime}.isSolarSystemSceneLoaded/scenes`);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

const CONFIG_PATH = "config/index";
const CONCORD_GATE_AGGRO_KEY = "npcDefaultConcordGateAutoAggroNpcsEnabled";

function readConcordGateNpcAggroFrom(requireGame) {
  try {
    const read = typeof requireGame === "function" ? requireGame(CONFIG_PATH) : null;
    if (!read || read.ok !== true || !read.exports || typeof read.exports !== "object") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((read && read.reason) || "NO_MODULE") };
    }
    const value = read.exports[CONCORD_GATE_AGGRO_KEY];
    if (typeof value !== "boolean") {
      return { ok: false, reason: "READ_FAILED", detail: `${CONCORD_GATE_AGGRO_KEY} ${typeof value}` };
    }
    return { ok: true, enabled: value };
  } catch (err) {
    return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
  }
}

module.exports = { PATHS, OPERATOR_KIND, SELECTION_PREFIX, NAVY_TEMPLATE_FACTION_KEY, CONCORD_GATE_AGGRO_KEY,
  isAmbientVictim, createAmbientRatSeam, checkAmbientRatSeamsFrom, readConcordGateNpcAggroFrom };
