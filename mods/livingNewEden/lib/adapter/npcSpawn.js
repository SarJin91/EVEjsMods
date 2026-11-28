// Ported from X-Eve livingUniverseRuntime.js (adaptation, CREDITS.md): getConflictAnchor :2864-2893 (gate -> station -> belt from worldData), materializeConflictEncounter :3406-3508 (spawn with broadcast:false, one scene.broadcastAddBalls of the complete battle), configureConflictCombat :3212-3358 (overrides + target per

"use strict";

const dormancyGuard = require("./dormancyGuard");
const { attackLockFields } = require("./attackLock");
const { KIND_ORDER: GRID_KIND_ORDER } = require("./gridAnchors");
const convoyVictims = require("./convoyVictims");
const { admitOrPass } = require("./sceneNpcBudget");

const MAX_DETAIL = 120;

const MODULE_PATHS = Object.freeze({
  native: "space/npc/nativeNpcService",
  hulls: "space/npc/pirateHullProfiles",
  npc: "space/npc/npcService",
  runtime: "space/runtime",
  worldData: "space/worldData",
});

const REQUIRED_FUNCTIONS = Object.freeze({
  native: Object.freeze(["spawnNativeNpcEntityInSystem"]),
  hulls: Object.freeze(["resolveFactionHullProfileID"]),
  npc: Object.freeze(["setBehaviorOverrides", "issueManualOrder", "wakeNpcController",
    "destroyNpcControllerByEntityID"]),
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
  worldData: Object.freeze(["getStargatesForSystem", "getStationsForSystem", "getAsteroidBeltsForSystem"]),
});

const SEAM_METHODS = Object.freeze(["resolveProfiles", "isSceneLoaded", "pickAnchor", "spawnShip", "engage",
  "publish", "despawn", "countAlive", "orderAttack", "listAlive", "setRelation", "pickGridAnchor", "seedCargo",
  "markConvoyShips", "forgetConvoyShips", "admitScene"]);

const OPTIONAL_PATHS = Object.freeze({ store: "space/npc/nativeNpcStore" });
const STORE_FUNCTIONS = Object.freeze(["getNativeController", "removeNativeEntityCascade"]);
const BOUNTY_STORE_FUNCTIONS = Object.freeze(["getNativeEntity", "upsertNativeEntity"]);
const CARGO_STORE_FUNCTIONS = Object.freeze(["allocateCargoID", "upsertNativeCargo", "getNativeEntity"]);
const ITEM_TYPES_PATH = "services/inventory/itemTypeRegistry";
const MAX_CARGO_ITEMS = 8;

const NPC_NOT_FOUND = "NPC_NOT_FOUND";
const BOUNTY_NAME_MIN = 3;
const BOUNTY_NAME_MAX = 37;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function detailOf(value, fallback) {
  const text = value === undefined || value === null || value === "" ? fallback : value;
  return String(text).slice(0, MAX_DETAIL);
}

function hasOwn(value, key) {
  return value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function finitePointOf(value) {
  if (!value || typeof value !== "object") return null;
  const { x, y, z } = value;
  return [x, y, z].every((n) => typeof n === "number" && Number.isFinite(n)) ? { x, y, z } : null;
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

const PURPOSE_SOURCES = Object.freeze({ heavyEvent: "heavyEvents", traffic: "highsecTraffic", bounty: "bounty",
  situation: "situations" });
function sourceOf(spec, purpose) {
  if (spec && typeof spec.source === "string" && spec.source !== "") return spec.source;
  return purpose !== null && hasOwn(PURPOSE_SOURCES, purpose) ? PURPOSE_SOURCES[purpose] : "npcSpawn";
}

function loadOne(requireGame, key) {
  const relPath = MODULE_PATHS[key];
  const loaded = requireGame(relPath);
  if (!loaded || loaded.ok !== true || !loaded.exports) return { ok: false, missing: [relPath] };
  const exportsObject = loaded.exports;
  const missing = REQUIRED_FUNCTIONS[key]
    .filter((name) => typeof exportsObject[name] !== "function")
    .map((name) => `${relPath}.${name}`);
  if (key === "runtime" && !(exportsObject.scenes instanceof Map)) missing.push(`${relPath}.scenes`);
  return missing.length === 0 ? { ok: true, exports: exportsObject } : { ok: false, missing };
}

function loadMods(requireGame, keys) {
  const mods = {};
  const missing = [];
  for (const key of keys) {
    let one;
    try {
      one = loadOne(requireGame, key);
    } catch (_err) {
      one = { ok: false, missing: [MODULE_PATHS[key]] };
    }
    if (one.ok) mods[key] = one.exports;
    else missing.push(...one.missing);
  }
  return missing.length === 0 ? { ok: true, mods } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

function checkNpcSpawnFrom(requireGame) {
  const loaded = loadMods(requireGame, Object.keys(MODULE_PATHS));
  return loaded.ok ? { ok: true } : loaded;
}

function sceneLoadedIn(runtime, systemId) {
  return runtime.isSolarSystemSceneLoaded(systemId) === true;
}

function sceneOf(runtime, systemId) {
  const scene = runtime.scenes.get(systemId);
  return scene && typeof scene.getEntityByID === "function" ? scene : null;
}

function smallestId(records, idOf) {
  let best = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const id = toPositiveInt(idOf(record));
    if (id > 0 && (best === 0 || id < best)) best = id;
  }
  return best;
}

const ANCHOR_SOURCES = Object.freeze([
  Object.freeze({ kind: "stargate", fn: "getStargatesForSystem", idOf: (r) => r && r.itemID }),
  Object.freeze({ kind: "station", fn: "getStationsForSystem", idOf: (r) => r && (r.stationID || r.itemID) }),
  Object.freeze({ kind: "asteroidBelt", fn: "getAsteroidBeltsForSystem", idOf: (r) => r && r.itemID }),
]);

const ANCHOR_SOURCES_STATION_FIRST = Object.freeze([ANCHOR_SOURCES[1], ANCHOR_SOURCES[0], ANCHOR_SOURCES[2]]);

function anchorOrder(opts) {
  if (opts === undefined || opts === null) return ANCHOR_SOURCES;
  if (typeof opts !== "object" || Array.isArray(opts)) return null;
  if (opts.prefer === undefined) return ANCHOR_SOURCES;
  return opts.prefer === "station" ? ANCHOR_SOURCES_STATION_FIRST : null;
}

function createNpcSpawn({ requireGame, navyProfiles, invaderProfiles, industryProfiles, data, capitalIndex,
  attackLock, admit: admitFn }) {
  const load = (keys) => loadMods(requireGame, keys);
  const admit = admitOrPass(admitFn);

  const readCapitalIndex = () => {
    if (typeof capitalIndex !== "function") return null;
    try {
      const r = capitalIndex();
      return r && r.ok === true && r.index && typeof r.index === "object" ? r.index : null;
    } catch (_err) {
      return null;
    }
  };

  const industryProfileOf = (factionId, hullGroup) => {
    const t = industryProfiles;
    if (!t || t.NO_INDUSTRY_PROFILE.includes(Number(factionId))) return null;
    if (hasOwn(t.MINERS, hullGroup)) return t.MINERS[hullGroup];
    if (!hasOwn(t.HAULER_KEY_BY_GROUP, hullGroup)) return null;
    const race = hasOwn(t.RACE_BY_FACTION_ID, String(factionId)) ? t.RACE_BY_FACTION_ID[String(factionId)]
      : t.DEFAULT_RACE;
    const haulers = hasOwn(t.HAULERS, race) ? t.HAULERS[race] : null;
    const key = t.HAULER_KEY_BY_GROUP[hullGroup];
    return haulers && hasOwn(haulers, key) ? haulers[key] : null;
  };

  const resolveProfiles = (requests, options = {}) => {
    const seedPrefix = options && options.seedPrefix;
    const invaders = Boolean(options && options.invaders === true);
    const industryOpt = options ? options.industry : undefined;
    if (industryOpt !== undefined && typeof industryOpt !== "boolean") return { ok: false, reason: "INVALID_INPUT" };
    const industry = industryOpt === true && Boolean(industryProfiles);
    if (!Array.isArray(requests) || typeof seedPrefix !== "string" || seedPrefix === "") {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    let hulls = null;
    let capitals;
    const profiles = [];
    for (const request of requests) {
      const factionId = request && request.factionId;
      const hullGroup = request && request.hullGroup;
      const memberKey = request && request.memberKey;
      if (typeof memberKey !== "string" || memberKey === "") return { ok: false, reason: "INVALID_INPUT" };
      const noProfile = (detail) => (detail === undefined
        ? { ok: false, reason: "NO_PROFILE", factionId, hullGroup }
        : { ok: false, reason: "NO_PROFILE", factionId, hullGroup, detail });
      if (industry && industryProfiles.INDUSTRY_GROUPS.includes(hullGroup)) {
        const profileId = industryProfileOf(factionId, hullGroup);
        if (typeof profileId !== "string" || profileId === "") return noProfile();
        profiles.push(profileId);
        continue;
      }
      if (Array.isArray(data.CAPITAL_LIVE_GROUPS) && data.CAPITAL_LIVE_GROUPS.includes(hullGroup)) {
        if (capitals === undefined) capitals = readCapitalIndex();
        const byClass = capitals && hasOwn(capitals, String(factionId)) ? capitals[String(factionId)] : null;
        const entry = byClass && hasOwn(byClass, hullGroup) ? byClass[hullGroup] : null;
        const typeId = request.typeId === undefined || request.typeId === null ? null : request.typeId;
        if (!entry || typeof entry.profileId !== "string" || entry.profileId === ""
          || (typeId !== null && typeId !== entry.typeId)) {
          return noProfile(data.CAPITAL_NO_PROFILE_DETAIL);
        }
        profiles.push(entry.profileId);
        continue;
      }
      const hullClass = hasOwn(data.HULL_CLASS_BY_GROUP, hullGroup) ? data.HULL_CLASS_BY_GROUP[hullGroup] : null;
      if (!hullClass) return noProfile();
      if (hasOwn(navyProfiles, String(factionId))) {
        const navy = navyProfiles[String(factionId)];
        const profileId = hasOwn(navy, hullClass) ? navy[hullClass] : null;
        if (typeof profileId !== "string" || profileId === "") return noProfile();
        profiles.push(profileId);
        continue;
      }
      if (invaders && hasOwn(invaderProfiles, String(factionId))) {
        const invader = invaderProfiles[String(factionId)];
        const profileId = hasOwn(invader, hullClass) ? invader[hullClass] : null;
        if (typeof profileId !== "string" || profileId === "") return noProfile();
        profiles.push(profileId);
        continue;
      }
      if (!hasOwn(data.PIRATE_KEY_BY_FACTION_ID, String(factionId))) return noProfile();
      if (hulls === null) {
        const loaded = load(["hulls"]);
        if (!loaded.ok) return loaded;
        hulls = loaded.mods.hulls;
      }
      let profileId;
      try {
        profileId = hulls.resolveFactionHullProfileID(data.PIRATE_KEY_BY_FACTION_ID[String(factionId)], hullClass,
          { seed: `${seedPrefix}:${memberKey}` });
      } catch (err) {
        return noProfile(messageOf(err));
      }
      if (typeof profileId !== "string" || profileId === "") return noProfile();
      profiles.push(profileId);
    }
    return { ok: true, profiles };
  };

  const isSceneLoaded = (systemId) => {
    try {
      if (!isPositiveInt(systemId)) return false;
      const loaded = load(["runtime"]);
      return loaded.ok && sceneLoadedIn(loaded.mods.runtime, systemId);
    } catch (_err) {
      return false;
    }
  };

  const pickAnchor = (systemId, opts) => {
    try {
      if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
      const order = anchorOrder(opts);
      if (order === null) return { ok: false, reason: "INVALID_INPUT" };
      const loaded = load(["runtime", "worldData"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const worldData = loaded.mods.worldData;
      for (const source of order) {
        const itemID = smallestId(worldData[source.fn](systemId), source.idOf);
        if (itemID > 0) return { ok: true, anchorDescriptor: { kind: source.kind, itemID } };
      }
      return { ok: false, reason: "NO_ANCHOR" };
    } catch (err) {
      return { ok: false, reason: "NO_ANCHOR", detail: messageOf(err) };
    }
  };

  const pickGridAnchor = (systemId, grid) => {
    try {
      if (!isPositiveInt(systemId) || !grid || typeof grid !== "object" || typeof grid.kind !== "string"
        || !isPositiveInt(grid.id)) return { ok: false, reason: "INVALID_INPUT" };
      if (!hasOwn(GRID_KIND_ORDER, grid.kind)) return { ok: false, reason: "GRID_KIND_UNSUPPORTED" };
      const loaded = load(["runtime"]);
      if (!loaded.ok) return loaded;
      const runtime = loaded.mods.runtime;
      if (!sceneLoadedIn(runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const scene = sceneOf(runtime, systemId);
      if (scene === null) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const entity = scene.getEntityByID(grid.id);
      if (!entity) return { ok: false, reason: "GRID_ANCHOR_UNKNOWN" };
      const radius = Number(entity.radius);
      return { ok: true, anchorDescriptor: { kind: "entity", itemID: grid.id },
        radiusMeters: Number.isFinite(radius) && radius >= 0 ? radius : 0 };
    } catch (err) {
      return { ok: false, reason: "GRID_ANCHOR_UNKNOWN", detail: messageOf(err) };
    }
  };

  const guardOverrides = (guard) => {
    if (!guard || typeof guard !== "object") return null;
    const aggro = guard.proximityAggroRangeMeters;
    const leash = guard.leashRangeMeters;
    if (typeof aggro !== "number" || !Number.isFinite(aggro) || aggro < 0
      || typeof leash !== "number" || !Number.isFinite(leash) || leash < 0
      || (guard.capital !== undefined && typeof guard.capital !== "boolean")) return null;
    const overrides = { ...data.GUARD_BEHAVIOR, autoAggroTargetClasses: [...data.GUARD_BEHAVIOR.autoAggroTargetClasses],
      proximityAggroRangeMeters: aggro, leashRangeMeters: leash,
      aggressionRangeMeters: aggro };
    if (guard.capital === true) for (const key of data.CAPITAL_COMBAT_STRIP) delete overrides[key];
    return overrides;
  };

  const zeroBounty = (entity, entityId) => {
    try {
      if (!entity || typeof entity !== "object") return "NO_ENTITY";
      entity.bounty = 0;
      const loaded = requireGame(OPTIONAL_PATHS.store);
      const store = loaded && loaded.ok === true ? loaded.exports : null;
      if (!store || !BOUNTY_STORE_FUNCTIONS.every((name) => typeof store[name] === "function")) {
        return "STORE_UNAVAILABLE";
      }
      const record = store.getNativeEntity(entityId);
      if (!record || typeof record !== "object") return "NO_STORE_RECORD";
      if (record.bounty === 0) return null;
      const written = store.upsertNativeEntity({ ...record, bounty: 0 }, { transient: record.transient === true });
      return written && written.success === true ? null : detailOf(written && written.errorMsg, "STORE_WRITE_FAILED");
    } catch (err) {
      return messageOf(err);
    }
  };

  const seedCargo = (entityId, items) => {
    let written = 0;
    if (!isPositiveInt(entityId) || !Array.isArray(items) || items.length === 0 || items.length > MAX_CARGO_ITEMS
      || !items.every((it) => it && isPositiveInt(it.typeId) && isPositiveInt(it.quantity))) {
      return { ok: false, reason: "INVALID_INPUT", written };
    }
    try {
      const loadedStore = requireGame(OPTIONAL_PATHS.store);
      const store = loadedStore && loadedStore.ok === true ? loadedStore.exports : null;
      const loadedTypes = requireGame(ITEM_TYPES_PATH);
      const types = loadedTypes && loadedTypes.ok === true ? loadedTypes.exports : null;
      if (!store || !CARGO_STORE_FUNCTIONS.every((name) => typeof store[name] === "function")
        || !types || typeof types.resolveItemByTypeID !== "function") {
        return { ok: false, reason: "STORE_UNAVAILABLE", written };
      }
      const entity = store.getNativeEntity(entityId);
      if (!entity || typeof entity !== "object") return { ok: false, reason: "NO_STORE_RECORD", written };
      for (const it of items) {
        const type = types.resolveItemByTypeID(it.typeId);
        if (!type || typeof type !== "object") {
          return { ok: false, reason: "UNKNOWN_TYPE", detail: String(it.typeId), written };
        }
        const id = store.allocateCargoID({ transient: true });
        if (!id || id.success !== true || !isPositiveInt(id.data)) {
          return { ok: false, reason: "WRITE_FAILED", detail: detailOf(id && id.errorMsg, "CARGO_ID_FAILED"), written };
        }
        const r = store.upsertNativeCargo({ cargoID: id.data, entityID: entityId, ownerID: entity.ownerID, moduleID: 0,
          typeID: it.typeId, groupID: type.groupID, categoryID: type.categoryID, itemName: type.name,
          quantity: it.quantity, singleton: 0, transient: true }, { transient: true });
        if (!r || r.success !== true) {
          return { ok: false, reason: "WRITE_FAILED", detail: detailOf(r && r.errorMsg, "CARGO_WRITE_FAILED"), written };
        }
        written += 1;
      }
      return { ok: true, written };
    } catch (err) {
      return { ok: false, reason: "WRITE_FAILED", detail: messageOf(err), written };
    }
  };


  // Seed only the difference so that repeated stage updates cannot duplicate cargo.
  const fillCivilianCargo = (entityId, cargo) => {
    try {
      if (!cargo || !isPositiveInt(cargo.typeId) || !Number.isInteger(cargo.percent)
        || cargo.percent < 0 || cargo.percent > 95) return { ok: false, reason: "INVALID_INPUT" };
      const store = requireGame(OPTIONAL_PATHS.store)?.exports;
      const types = requireGame(ITEM_TYPES_PATH)?.exports;
      const entity = store?.getNativeEntity(entityId);
      if (!entity || !types) return { ok: false, reason: "STORE_UNAVAILABLE" };
      const capacity = Number(types.resolveItemByTypeID(entity.typeID)?.capacity);
      const volume = Number(types.resolveItemByTypeID(cargo.typeId)?.volume);
      if (!(capacity > 0) || !(volume > 0)) return { ok: false, reason: "NO_CARGO_CAPACITY" };
      const target = Math.floor(capacity * cargo.percent / (100 * volume));
      const existing = store.listNativeCargoForEntity(entityId);
      let current = 0;
      let used = 0;
      for (const stack of existing) {
        if (stack.typeID === cargo.typeId) current += stack.quantity;
        used += stack.quantity * (Number(types.resolveItemByTypeID(stack.typeID)?.volume) || 0);
      }
      const quantity = Math.min(target - current, Math.floor((capacity - used) / volume));
      return quantity > 0 ? seedCargo(entityId, [{ typeId: cargo.typeId, quantity }]) : { ok: true, written: 0 };
    } catch (err) {
      return { ok: false, reason: "CARGO_WRITE_FAILED", detail: messageOf(err) };
    }
  };

  const bountyOptionsOf = (spec) => {
    const behaviors = data.BOUNTY_BEHAVIOR || {};
    const archetype = spec.archetype;
    if (typeof archetype !== "string" || !hasOwn(behaviors, archetype) || spec.guard !== undefined) return null;
    if (spec.capital !== undefined && typeof spec.capital !== "boolean") return null;
    const raw = spec.slimName === undefined || spec.slimName === null ? null : spec.slimName;
    if (raw !== null && (typeof raw !== "string" || raw.trim().length < BOUNTY_NAME_MIN
      || raw.trim().length > BOUNTY_NAME_MAX || /[<>]/.test(raw))) return null;
    const behaviorOverrides = { ...behaviors[archetype] };
    if (spec.capital === true) for (const key of data.CAPITAL_COMBAT_STRIP) delete behaviorOverrides[key];
    return { behaviorOverrides, slimName: raw === null ? null : raw.trim() };
  };

  const trafficOptionsOf = (spec) => {
    const raw = spec.spawnState === undefined || spec.spawnState === null ? null : spec.spawnState;
    let spawnState = null;
    if (raw !== null) {
      if (typeof raw !== "object") return null;
      const position = finitePointOf(raw.position);
      const direction = finitePointOf(raw.direction);
      const targetPoint = finitePointOf(raw.targetPoint);
      const fraction = raw.speedFraction;
      if (!position || !direction || !targetPoint || (raw.mode !== "GOTO" && raw.mode !== "STOP")
        || typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
      spawnState = { position, direction, targetPoint, mode: raw.mode, speedFraction: fraction };
    }
    const name = spec.slimName === undefined || spec.slimName === null ? null : spec.slimName;
    if (name !== null && (typeof name !== "string" || name.trim().length < BOUNTY_NAME_MIN
      || name.trim().length > BOUNTY_NAME_MAX || /[<>]/.test(name))) return null;
    return { spawnState, slimName: name === null ? null : name.trim() };
  };

  const situationOptionsOf = (spec) => {
    const role = spec.role;
    if ((role !== "victim" && role !== "pirate") || spec.guard !== undefined) return null;
    const raw = spec.slimName === undefined || spec.slimName === null ? null : spec.slimName;
    if (raw !== null && (typeof raw !== "string" || raw.trim().length < BOUNTY_NAME_MIN
      || raw.trim().length > BOUNTY_NAME_MAX || /[<>]/.test(raw))) return null;
    const behaviorOverrides = { ...(role === "victim" ? data.SITUATION_VICTIM_BEHAVIOR
      : data.SITUATION_PIRATE_BEHAVIOR) };
    return { role, behaviorOverrides, slimName: raw === null ? null : raw.trim() };
  };

  const spawnSituationShip = (native, systemId, spec, situation) => {
    const result = native.spawnNativeNpcEntityInSystem(systemId, {
      profileQuery: spec.profileId,
      anchorDescriptor: spec.anchorDescriptor,
      spawnDistanceMeters: spec.spawnDistanceMeters,
      transient: true,
      operatorKind: data.SITUATION_OPERATOR_KIND,
      broadcast: false,
      skipInitialBehaviorTick: true,
      behaviorOverrides: situation.behaviorOverrides,
      ...(situation.slimName !== null ? { slimNameOverride: situation.slimName } : {}),
    });
    if (!result || result.success !== true) {
      return { ok: false, reason: "SPAWN_FAILED", detail: detailOf(result && result.errorMsg, "SPAWN_FAILED") };
    }
    const entityId = toPositiveInt(result.data && result.data.entity && result.data.entity.itemID);
    if (entityId === 0) return { ok: false, reason: "SPAWN_FAILED", detail: "NO_ENTITY" };
    dormancyGuard.protect(entityId);
    if (situation.role === "victim") {
      const failed = zeroBounty(result.data.entity, entityId);
      if (failed !== null) {
        despawn(systemId, [entityId]);
        return { ok: false, reason: "SPAWN_FAILED", detail: `BOUNTY_NOT_ZEROED:${failed}` };
      }
    }
    return { ok: true, entityId };
  };

  const spawnShip = (systemId, spec = {}) => {
    const profileId = spec && spec.profileId;
    const anchorDescriptor = spec && spec.anchorDescriptor;
    const ownerId = spec && spec.ownerId !== undefined && spec.ownerId !== null ? spec.ownerId : null;
    const behavior = spec && spec.behavior !== undefined && spec.behavior !== null ? spec.behavior : null;
    const keepRaw = spec ? spec.keepMaterialized : undefined;
    const keepMaterialized = keepRaw === true;
    const purpose = spec && spec.purpose !== undefined && spec.purpose !== null ? spec.purpose : null;
    const guard = purpose === "heavyEvent" ? guardOverrides(spec.guard) : null;
    const traffic = purpose === "traffic";
    const trafficOpts = traffic ? trafficOptionsOf(spec) : null;
    const bounty = purpose === "bounty" ? bountyOptionsOf(spec) : null;
    const situation = purpose === "situation" ? situationOptionsOf(spec) : null;
    if (!isPositiveInt(systemId) || typeof profileId !== "string" || profileId === ""
      || !anchorDescriptor || typeof anchorDescriptor !== "object"
      || (ownerId !== null && !isPositiveInt(ownerId))
      || (behavior !== null && behavior !== "search")
      || (keepRaw !== undefined && keepRaw !== null && typeof keepRaw !== "boolean")
      || (purpose !== null && (behavior !== null || (keepRaw !== undefined && keepRaw !== null)))
      || (purpose === "heavyEvent" && guard === null)
      || (traffic && (spec.guard !== undefined || trafficOpts === null))
      || (purpose === "bounty" && bounty === null)
      || (purpose === "situation" && situation === null)
      || (purpose !== null && purpose !== "heavyEvent" && !traffic && purpose !== "bounty"
        && purpose !== "situation")) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const loaded = load(["runtime", "native"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const gate = admit(systemId, 1, sourceOf(spec, purpose));
      if (!gate || gate.ok !== true) return gate;
      if (situation !== null) return spawnSituationShip(loaded.mods.native, systemId, spec, situation);
      const result = loaded.mods.native.spawnNativeNpcEntityInSystem(systemId, bounty !== null ? {
        profileQuery: profileId,
        anchorDescriptor,
        spawnDistanceMeters: spec.spawnDistanceMeters,
        transient: true,
        operatorKind: data.BOUNTY_OPERATOR_KIND,
        broadcast: false,
        skipInitialBehaviorTick: true,
        behaviorOverrides: bounty.behaviorOverrides,
        ...(bounty.slimName !== null ? { slimNameOverride: bounty.slimName } : {}),
      } : {
        profileQuery: profileId,
        anchorDescriptor,
        spawnDistanceMeters: spec.spawnDistanceMeters,
        transient: true,
        ...(keepMaterialized ? {}
          : { operatorKind: traffic ? data.TRAFFIC_OPERATOR_KIND
            : guard !== null ? data.HEAVY_OPERATOR_KIND : data.LIVE_OPERATOR_KIND }),
        broadcast: false,
        skipInitialBehaviorTick: true,
        behaviorOverrides: traffic ? { ...data.TRAFFIC_BEHAVIOR } : guard !== null ? guard
          : { ...(behavior === "search" ? data.HUNT_SEARCH_BEHAVIOR : data.SPAWN_BEHAVIOR) },
        ...(ownerId ? { ownerIDOverride: ownerId } : {}),
        ...(trafficOpts && trafficOpts.spawnState !== null ? { spawnStateOverride: trafficOpts.spawnState } : {}),
        ...(trafficOpts && trafficOpts.slimName !== null ? { slimNameOverride: trafficOpts.slimName } : {}),
      });
      if (!result || result.success !== true) {
        return { ok: false, reason: "SPAWN_FAILED", detail: detailOf(result && result.errorMsg, "SPAWN_FAILED") };
      }
      const entityId = toPositiveInt(result.data && result.data.entity && result.data.entity.itemID);
      if (entityId === 0) return { ok: false, reason: "SPAWN_FAILED", detail: "NO_ENTITY" };
      if (spec.civilianOperation) result.data.entity.lneCivilianOperation = spec.civilianOperation;
      if (!keepMaterialized) dormancyGuard.protect(entityId);
      if (traffic) {
        const failed = zeroBounty(result.data.entity, entityId);
        if (failed !== null) {
          despawn(systemId, [entityId]);
          return { ok: false, reason: "SPAWN_FAILED", detail: `BOUNTY_NOT_ZEROED:${failed}` };
        }
      }
      return { ok: true, entityId };
    } catch (err) {
      return { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
    }
  };

  const combatOverrides = (targetMode, aggroPlayers) => {
    if (targetMode === "manual") {
      return { ...data.COMBAT_BEHAVIOR_MANUAL,
        autoAggroTargetClasses: [...(aggroPlayers ? data.AGGRO_CLASSES_PLAYER : data.AGGRO_CLASSES_NONE)] };
    }
    if (targetMode === "vendor") {
      return { ...data.COMBAT_BEHAVIOR,
        autoAggroTargetClasses: [...(aggroPlayers ? data.AGGRO_CLASSES_NPC_AND_PLAYER : data.AGGRO_CLASSES_NPC)] };
    }
    return null;
  };

  const engage = (systemId, sideA, sideB, options = {}) => {
    const targetMode = options && options.targetMode !== undefined ? options.targetMode : "manual";
    if (!data.TARGET_MODES.includes(targetMode)) return { ok: false, reason: "INVALID_INPUT", detail: "targetMode" };
    const attackersOnly = options ? options.attackersOnly : undefined;
    if (attackersOnly !== undefined && typeof attackersOnly !== "boolean") {
      return { ok: false, reason: "INVALID_INPUT", detail: "attackersOnly" };
    }
    const capitalIds = options && options.capitalIds !== undefined && options.capitalIds !== null
      ? options.capitalIds : null;
    if (capitalIds !== null && !(capitalIds instanceof Set)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "capitalIds" };
    }
    if (!Array.isArray(sideA) || !Array.isArray(sideB) || sideA.length === 0 || sideB.length === 0) {
      return { ok: false, reason: "ENGAGE_FAILED", detail: "EMPTY_SIDE" };
    }
    let currentId = 0;
    try {
      const loaded = load(["runtime", "npc"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const npc = loaded.mods.npc;
      const overrides = combatOverrides(targetMode, Boolean(options && options.aggroPlayers === true));
      const capitalOverrides = { ...overrides };
      for (const key of data.CAPITAL_COMBAT_STRIP) delete capitalOverrides[key];
      const fail = (entityId, result, fallback) => ({ ok: false, reason: "ENGAGE_FAILED", entityId,
        detail: detailOf(result && result.errorMsg, fallback) });
      const lock = attackLockFields(attackLock);
      const pairs = attackersOnly === true ? [[sideA, sideB]] : [[sideA, sideB], [sideB, sideA]];
      for (const [own, opposite] of pairs) {
        for (let i = 0; i < own.length; i += 1) {
          const entityId = own[i];
          const targetID = opposite[i % opposite.length];
          currentId = entityId;
          const shipOverrides = capitalIds !== null && capitalIds.has(entityId) ? capitalOverrides : overrides;
          const set = npc.setBehaviorOverrides(entityId, { ...shipOverrides,
            autoAggroTargetClasses: [...shipOverrides.autoAggroTargetClasses] });
          if (!set || set.success !== true) return fail(entityId, set, "OVERRIDES_FAILED");
          const order = npc.issueManualOrder(entityId, { type: "attack", targetID, ...lock });
          if (!order || order.success !== true) return fail(entityId, order, "ORDER_FAILED");
          const wake = npc.wakeNpcController(entityId, 0);
          if (!wake || wake.success !== true) return fail(entityId, wake, "WAKE_FAILED");
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "ENGAGE_FAILED", entityId: currentId, detail: messageOf(err) };
    }
  };

  const publish = (systemId, entityIds) => {
    if (!Array.isArray(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const loaded = load(["runtime"]);
      if (!loaded.ok) return loaded;
      const scene = isPositiveInt(systemId) ? sceneOf(loaded.mods.runtime, systemId) : null;
      if (!scene || typeof scene.broadcastAddBalls !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
      const entities = [];
      for (const id of entityIds) {
        const entity = scene.getEntityByID(id);
        if (entity) entities.push(entity);
      }
      if (entities.length > 0) scene.broadcastAddBalls(entities, null, { ...data.PUBLISH_OPTIONS });
      return { ok: true, published: entities.length, missing: entityIds.length - entities.length };
    } catch (err) {
      return { ok: false, reason: "PUBLISH_FAILED", detail: messageOf(err) };
    }
  };

  const loadStore = () => {
    try {
      const loaded = requireGame(OPTIONAL_PATHS.store);
      const store = loaded && loaded.ok === true ? loaded.exports : null;
      if (!store) return null;
      return STORE_FUNCTIONS.every((name) => typeof store[name] === "function") ? store : null;
    } catch (_err) {
      return null;
    }
  };

  const purgeDormant = (store, id) => {
    if (!store || !isPositiveInt(id)) return { purged: false, failed: null };
    try {
      if (!store.getNativeController(id)) return { purged: false, failed: null };
      const removedRecord = store.removeNativeEntityCascade(id);
      if (removedRecord && removedRecord.success === true) return { purged: true, failed: null };
      return { purged: false, failed: detailOf(removedRecord && removedRecord.errorMsg, "PURGE_FAILED") };
    } catch (err) {
      return { purged: false, failed: messageOf(err) };
    }
  };

  const despawn = (systemId, entityIds) => {
    if (!Array.isArray(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    const loaded = load(["npc"]);
    if (!loaded.ok) {
      for (const id of entityIds) dormancyGuard.release(id);
      return loaded;
    }
    const npc = loaded.mods.npc;
    let removed = 0;
    let missing = 0;
    let purged = 0;
    let store;
    let purgeFailed = null;
    const failed = [];
    let detail = null;
    for (const id of entityIds) {
      try {
        const result = npc.destroyNpcControllerByEntityID(id, { ...data.DESPAWN_OPTIONS });
        if (result && result.success === true) removed += 1;
        else if (result && result.errorMsg === NPC_NOT_FOUND) {
          missing += 1;
          if (store === undefined) store = loadStore();
          const purge = purgeDormant(store, id);
          if (purge.purged) purged += 1;
          else if (purge.failed !== null && purgeFailed === null) purgeFailed = purge.failed;
        } else {
          failed.push(id);
          if (detail === null) detail = detailOf(result && result.errorMsg, "DESPAWN_FAILED");
        }
      } catch (err) {
        failed.push(id);
        if (detail === null) detail = messageOf(err);
      }
      dormancyGuard.release(id);
    }
    const extra = purgeFailed === null ? {} : { purgeFailed };
    if (failed.length > 0) {
      return { ok: false, reason: "DESPAWN_FAILED", removed, missing, purged, failed, detail, ...extra };
    }
    return { ok: true, removed, missing, purged, ...extra };
  };

  const countAlive = (systemId, entityIds) => {
    try {
      if (!isPositiveInt(systemId) || !Array.isArray(entityIds)) return 0;
      const loaded = load(["runtime"]);
      if (!loaded.ok) return 0;
      const scene = sceneOf(loaded.mods.runtime, systemId);
      if (!scene) return 0;
      let alive = 0;
      for (const id of entityIds) if (scene.getEntityByID(id)) alive += 1;
      return alive;
    } catch (_err) {
      return 0;
    }
  };

  const orderAttack = (systemId, entityId, targetId) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(targetId)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const loaded = load(["runtime", "npc"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const npc = loaded.mods.npc;
      const order = npc.issueManualOrder(entityId, { type: "attack", targetID: targetId,
        ...attackLockFields(attackLock) });
      if (!order || order.success !== true) {
        return { ok: false, reason: "ORDER_FAILED", detail: detailOf(order && order.errorMsg, "ORDER_FAILED") };
      }
      const wake = npc.wakeNpcController(entityId, 0);
      if (!wake || wake.success !== true) {
        return { ok: false, reason: "ORDER_FAILED", detail: detailOf(wake && wake.errorMsg, "WAKE_FAILED") };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "ORDER_FAILED", detail: messageOf(err) };
    }
  };

  const listAlive = (systemId, entityIds) => {
    try {
      if (!isPositiveInt(systemId) || !Array.isArray(entityIds)) return [];
      const loaded = load(["runtime"]);
      if (!loaded.ok) return [];
      const scene = sceneOf(loaded.mods.runtime, systemId);
      if (!scene) return [];
      return entityIds.filter((id) => Boolean(scene.getEntityByID(id)));
    } catch (_err) {
      return [];
    }
  };

  const setRelation = (systemId, entityIds, relation) => {
    const pair = typeof relation === "string" && hasOwn(data.RELATION_THRESHOLDS, relation)
      ? data.RELATION_THRESHOLDS[relation] : null;
    if (!isPositiveInt(systemId) || !Array.isArray(entityIds) || pair === null
      || !entityIds.every((id) => isPositiveInt(id))) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const loaded = load(["runtime"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const scene = sceneOf(loaded.mods.runtime, systemId);
      if (!scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const changedEntities = [];
      const previous = [];
      let unchanged = 0;
      let missing = 0;
      for (const id of entityIds) {
        const entity = scene.getEntityByID(id);
        if (!entity || entity.kind !== "ship" || entity.nativeNpc !== true) {
          missing += 1;
          continue;
        }
        if (entity.hostileResponseThreshold === pair.hostileResponseThreshold
          && entity.friendlyResponseThreshold === pair.friendlyResponseThreshold) {
          unchanged += 1;
          continue;
        }
        previous.push([entity, entity.hostileResponseThreshold, entity.friendlyResponseThreshold]);
        entity.hostileResponseThreshold = pair.hostileResponseThreshold;
        entity.friendlyResponseThreshold = pair.friendlyResponseThreshold;
        changedEntities.push(entity);
      }
      let broadcast = false;
      if (changedEntities.length > 0 && typeof scene.broadcastSlimItemChanges === "function") {
        try {
          scene.broadcastSlimItemChanges(changedEntities);
        } catch (err) {
          for (const [entity, hostile, friendly] of previous) {
            entity.hostileResponseThreshold = hostile;
            entity.friendlyResponseThreshold = friendly;
          }
          return { ok: false, reason: "SET_FAILED", detail: messageOf(err) };
        }
        broadcast = true;
      }
      return { ok: true, changed: changedEntities.length, unchanged, missing, broadcast };
    } catch (err) {
      return { ok: false, reason: "SET_FAILED", detail: messageOf(err) };
    }
  };

  const markConvoyShips = (entityIds, o) => convoyVictims.markConvoyShips(entityIds, o);
  const forgetConvoyShips = (entityIds) => convoyVictims.forgetConvoyShips(entityIds);

  const admitScene = (systemId, n, source) => admit(systemId, n, source);

  return { resolveProfiles, isSceneLoaded, pickAnchor, spawnShip, engage, publish, despawn, countAlive, orderAttack,
    listAlive, setRelation, pickGridAnchor, seedCargo, fillCivilianCargo, markConvoyShips, forgetConvoyShips, admitScene };
}

module.exports = { MODULE_PATHS, REQUIRED_FUNCTIONS, SEAM_METHODS, createNpcSpawn, checkNpcSpawnFrom };
