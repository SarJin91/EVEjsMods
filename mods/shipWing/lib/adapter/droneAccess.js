// ranges(snapshot) -> {orbitDistance, engagementRange, movementRange} port of resolveDroneEngagementRanges orbit(scene, drone, targetId, rangeM, {fast}) -> boolean scene.orbitShipEntity with the drone speed fraction (the vendor moves a drone only by Orbit, droneRuntime.js:3629-3686) port of droneRuntime.js:7909-7975: FX (isOffensive false, droneFxEnabled), the assistance effect state and executeAssistanceModuleCycle with session null (the vendor uses the session only for an ancillary charge; the HP notice goes to target.session, assistanceModuleRuntime.js:1569) and the droneInterop callbacks; durationMs} | {ok:false, reason: SALVAGE_REFUSAL} port of tickDroneSalvage (droneRuntime.js:7786-7881): salvagerRuntime.executeSalvagerCycle through the module object (the hook passes it through: the entity is the drone, not a twin) with buildSalvagerRuntimeCallbacks(scene) pointed at the HOST (cargo, session

"use strict";

const { CYCLE_REASON, FAMILY_LAYER } = require("../core/logiPolicy");
const { surfaceDistance: vecSurfaceDistance } = require("../util/vec");

const DRONE_MODULES = Object.freeze({
  droneRuntime: "services/drone/droneRuntime",
  droneDogma: "services/drone/droneDogma",
  fighterInventory: "services/fighter/fighterInventory",
  itemCustody: "services/inventory/itemCustody",
  itemStore: "services/inventory/itemStore",
  runtime: "space/runtime",
  fittingRuntime: "_secondary/fitting/fittingRuntime",
  assistanceModuleRuntime: "space/modules/assistanceModuleRuntime",
  interactionScope: "space/destiny/identity/interactionScope",
  itemTypeRegistry: "services/inventory/itemTypeRegistry",
});
const TESTING_FUNCTIONS = Object.freeze(["recallDronesToShipBay", "serializePlayerCompanionScopeMetadata"]);
const WING_DRONE_COMMAND = "shipWing";
const ATTRIBUTE_DRONE_BANDWIDTH = 1271;
const ATTRIBUTE_MAX_ACTIVE_DRONES = 352;
const ATTRIBUTE_DRONE_CAPACITY = 283;
const VOLUME_EPSILON = 1e-7;
const MIN_ORBIT_DISTANCE_M = 500;
const LAUNCH_OFFSET_M = 75;
const LAUNCH_LATERAL_STEP_M = 30;
const LAUNCH_LATERAL_SLOTS = 5;
const ONE_METER = 1;
const DEFAULT_DURATION_MS = 1000;

const LAUNCH_REFUSAL = Object.freeze(["NOT_IN_BAY", "CUSTODY_FAILED", "SPAWN_FAILED", "ROLLED_BACK"]);
const DRONE_SALVAGE_MODULES = Object.freeze({
  salvagerRuntime: "space/modules/salvagerRuntime",
  moduleRuntimeCallbacks: "space/runtime/moduleRuntimeCallbacks",
});
const SALVAGE_REFUSAL = Object.freeze(["NO_SNAPSHOT", "NO_TARGET", "RANGE", "NO_HOST", "CARGO", "ERROR"]);
const SALVAGE_STOP_REASON = Object.freeze({ target: "NO_TARGET", range: "RANGE", cargo: "CARGO" });
const RECLAIM_REFUSAL = Object.freeze(["NOT_IN_SPACE", "OWNER_CHANGED", "SHIP_GONE", "CUSTODY_FAILED",
  "BAY_FULL"]);
const DRONE_ACCESS_COUNTER_NAMES = Object.freeze([
  "drone.launch.ok", ...LAUNCH_REFUSAL.map((r) => `drone.launch.refused.${r}`), "drone.launch.rollback",
  "drone.recall.ok", "drone.recall.failed",
  "drone.cycle.fired", "drone.cycle.hit", "drone.cycle.miss", "drone.cycle.kill",
  "drone.reclaim.ok", ...RECLAIM_REFUSAL.map((r) => `drone.reclaim.skipped.${r}`),
]);

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function vec(v) {
  return { x: toNum(v && v.x, 0), y: toNum(v && v.y, 0), z: toNum(v && v.z, 0) };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(a, k) {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

function unit(v, fallback) {
  const a = vec(v);
  const len = Math.hypot(a.x, a.y, a.z);
  return len > 0 ? scale(a, 1 / len) : { ...fallback };
}

function perpendicular(dir) {
  const ref = Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const c = { x: dir.y * ref.z - dir.z * ref.y, y: dir.z * ref.x - dir.x * ref.z, z: dir.x * ref.y - dir.y * ref.x };
  return unit(c, { x: 0, y: 0, z: 1 });
}

// Port of buildDroneLaunchSpaceState (droneRuntime.js:3776-3815) with the twin as the ship.
function launchSpaceState(twin, launchIndex, scope, systemId) {
  const dir = unit(twin && twin.direction, { x: 1, y: 0, z: 0 });
  const lateral = perpendicular(dir);
  const distance = Math.max(toNum(twin && twin.radius, 0), ONE_METER) + LAUNCH_OFFSET_M;
  const index = Math.max(0, toInt(launchIndex, 0));
  const side = index % 2 === 0 ? 1 : -1;
  const position = add(add(vec(twin && twin.position), scale(dir, distance)),
    scale(lateral, (index % LAUNCH_LATERAL_SLOTS) * LAUNCH_LATERAL_STEP_M * side));
  return {
    systemID: toInt(systemId, toInt(twin && twin.systemID, 0)), position, velocity: { x: 0, y: 0, z: 0 },
    direction: dir, targetPoint: { ...position }, speedFraction: 0, mode: "STOP", targetEntityID: null, followRange: 0,
    orbitDistance: 0, orbitNormal: lateral, orbitSign: 1, effectStamp: 0, warpDestination: null,
    ...(isObj(scope) ? scope : {}),
  };
}

// Port of buildDronePseudoModuleItem (droneRuntime.js:3064-3080).
function pseudoModuleItem(drone) {
  return {
    itemID: toInt(drone && drone.itemID, 0), typeID: toInt(drone && drone.typeID, 0),
    groupID: toInt(drone && drone.groupID, 0), flagID: 0, locationID: toInt(drone && drone.itemID, 0), singleton: 1,
    quantity: 1, stacksize: 1, itemName: String((drone && drone.itemName) || "Drone"),
    moduleState: { isOnline: true, isActive: true },
  };
}

// copy drones: port of classifyDroneMiningYieldKind (droneRuntime.js:2557-2574) over the name (the type name, else the itemName).
function droneYieldKind(name) {
  const text = String(name || "").trim().toLowerCase();
  if (!text) return null;
  if (text.includes("ice harvesting")) return "ice";
  if (text.includes("excavator") || text.includes("mining")) return "ore";
  return null;
}

// Port of resolveDroneEngagementRanges (droneRuntime.js:3688-3713) without the chase range.
function ranges(snapshot) {
  const orbitDistance = Math.max(MIN_ORBIT_DISTANCE_M,
    toNum(snapshot && snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_M));
  const attackRange = Math.max(0, toNum(snapshot && snapshot.attackRangeMeters, 0));
  const engagementRange = attackRange > 0 ? attackRange : orbitDistance;
  return { orbitDistance, engagementRange, movementRange: Math.min(orbitDistance, engagementRange) };
}

function stackOf(item) {
  if (toInt(item && item.singleton, 0) === 1) return 1;
  return Math.max(1, toInt(item && (item.stacksize ?? item.quantity), 1));
}

function createDroneAccess(input) {
  const deps = input.deps;
  const config = input.config || {};
  const counters = Object.fromEntries(DRONE_ACCESS_COUNTER_NAMES.map((name) => [name, 0]));

  function count(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function droneBayFlag() {
    return toInt(deps.itemStore.ITEM_FLAGS.DRONE_BAY, 0);
  }

  function makeProxy({ shipItemId, ownerCharId, systemId } = {}) {
    const owner = toInt(ownerCharId, 0);
    return { itemID: toInt(shipItemId, 0), pilotCharacterID: owner, characterID: owner, ownerID: owner,
      systemID: toInt(systemId, 0), activeModuleEffects: new Map(), session: null };
  }

  function combatSnapshot(drone, proxy) {
    try {
      const snapshot = deps.resolveDroneCombatSnapshot(drone, proxy);
      const jammer = isObj(snapshot) && String(snapshot.effectKind || "") === "jammer";
      if (!isObj(snapshot) || jammer) return { ok: false, reason: "NO_SNAPSHOT" };
      return { ok: true, snapshot };
    } catch (_err) {
      return { ok: false, reason: "NO_SNAPSHOT" };
    }
  }

  function repairSnapshot(drone, proxy) {
    try {
      const snapshot = deps.resolveDroneRepairSnapshot(drone, proxy);
      if (!isObj(snapshot) || !FAMILY_LAYER[snapshot.repairFamily]) return { ok: false, reason: "NO_SNAPSHOT" };
      return { ok: true, snapshot };
    } catch (_err) {
      return { ok: false, reason: "NO_SNAPSHOT" };
    }
  }

  function miningSnapshot(drone, proxy) {
    try {
      if (typeof deps.resolveDroneMiningSnapshot !== "function") return { ok: false, reason: "NO_SNAPSHOT" };
      const snapshot = deps.resolveDroneMiningSnapshot(drone, proxy);
      if (!isObj(snapshot)) return { ok: false, reason: "NO_SNAPSHOT" };
      return { ok: true, snapshot };
    } catch (_err) {
      return { ok: false, reason: "NO_SNAPSHOT" };
    }
  }

  function yieldKindOf(item) {
    let name = "";
    if (typeof deps.resolveItemByTypeID === "function") {
      const type = deps.resolveItemByTypeID(toInt(item && item.typeID, 0));
      name = isObj(type) && type.name ? String(type.name) : "";
    }
    return droneYieldKind(name || (item && item.itemName) || "");
  }

  function kindOf(item, proxy) {
    if (combatSnapshot(item, proxy).ok) return { kind: "combat" };
    if (config.droneRepairEnabled === true) {
      const repair = repairSnapshot(item, proxy);
      if (repair.ok) return { kind: "repair", family: repair.snapshot.repairFamily };
    }
    if (config.droneMiningEnabled === true && typeof deps.resolveDroneMiningSnapshot === "function") {
      try {
        const yieldKind = yieldKindOf(item);
        if (yieldKind && miningSnapshot(item, proxy).ok) return { kind: "mining", yieldKind };
      } catch (_err) {
      }
    }
    if (config.droneSalvageEnabled === true && salvageSnapshot(item, proxy).ok) return { kind: "salvage" };
    return { kind: "other" };
  }

  function salvageSnapshot(drone, proxy) {
    try {
      if (typeof deps.resolveDroneSalvageSnapshot !== "function") return { ok: false, reason: "NO_SNAPSHOT" };
      const snapshot = deps.resolveDroneSalvageSnapshot(drone, proxy);
      if (!isObj(snapshot)) return { ok: false, reason: "NO_SNAPSHOT" };
      return { ok: true, snapshot };
    } catch (_err) {
      return { ok: false, reason: "NO_SNAPSHOT" };
    }
  }

  function salvageCycle(scene, _twin, drone, wreckId, ownerCharId, hostShipId, simMs, snapshot) {
    try {
      if (!isObj(snapshot) || typeof deps.executeSalvagerCycle !== "function"
        || typeof deps.buildSalvagerRuntimeCallbacks !== "function") return { ok: false, reason: "NO_SNAPSHOT" };
      if (!isObj(scene) || !isObj(drone) || typeof scene.getEntityByID !== "function") {
        return { ok: false, reason: "ERROR" };
      }
      const targetID = toInt(wreckId, 0);
      const wreck = targetID > 0 ? scene.getEntityByID(targetID) : null;
      if (!isObj(wreck) || deps.isSalvageableTarget(wreck) !== true) return { ok: false, reason: "NO_TARGET" };
      const host = toInt(hostShipId, 0) > 0 ? scene.getEntityByID(toInt(hostShipId, 0)) : null;
      if (!isObj(host)) return { ok: false, reason: "NO_HOST" };
      const owner = toInt(ownerCharId, 0);
      const cb = deps.buildSalvagerRuntimeCallbacks(scene) || {};
      const call = (name) => (typeof cb[name] === "function" ? cb[name](host) : null);
      const chance = deps.buildSalvageChanceSnapshot(wreck, snapshot.accessBonusPercent) || {};
      const out = deps.executeSalvagerCycle({
        scene,
        entity: drone,
        effectState: {
          moduleID: toInt(drone.itemID, 0),
          moduleFlagID: 0,
          typeID: toInt(drone.typeID, 0),
          targetID,
          salvagerRangeMeters: snapshot.maxRangeMeters,
          salvageChancePercent: chance.chancePercent,
        },
        nowMs: simMs,
        callbacks: {
          ...cb,
          isEntityLockedTarget: () => true,
          resolveCharacterID: () => owner,
          getEntityRuntimeShipItem: () => call("getEntityRuntimeShipItem"),
          getEntityRuntimeFittedItems: () => call("getEntityRuntimeFittedItems") || [],
          getEntityRuntimeSkillMap: () => call("getEntityRuntimeSkillMap"),
          resolveSession: () => call("resolveSession"),
          suppressSalvageMessages: true,
        },
      });
      salvageFx(scene, drone, targetID, snapshot);
      const durationMs = Math.max(1, toNum(snapshot.durationMs, DEFAULT_DURATION_MS));
      if (isObj(out) && isObj(out.data) && out.data.salvaged === true) return { ok: true, salvaged: true, durationMs };
      if (isObj(out) && out.success === true) return { ok: true, salvaged: false, durationMs };
      const reason = isObj(out) ? SALVAGE_STOP_REASON[out.stopReason] : null;
      return { ok: false, reason: reason || "ERROR" };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function salvageFx(scene, drone, targetID, snapshot) {
    try {
      if (config.droneFxEnabled !== true || typeof scene.broadcastSpecialFx !== "function"
        || !snapshot.effectGUID) return;
      scene.broadcastSpecialFx(drone.itemID, snapshot.effectGUID, { moduleID: drone.itemID, moduleTypeID: drone.typeID,
        targetID, isOffensive: false, start: true, active: false,
        duration: Math.max(1, toNum(snapshot.durationMs, DEFAULT_DURATION_MS)), repeat: 1 }, drone);
    } catch (_err) {
    }
  }

  // port of emitDroneMiningCycleFx (droneRuntime.js:2663-2712) without the fxCycleKey - the sidecar calls it once per cycle start.
  function miningFx(scene, drone, rockId, snapshot) {
    try {
      const targetID = toInt(rockId, 0);
      if (config.droneFxEnabled !== true || !isObj(scene) || typeof scene.broadcastSpecialFx !== "function"
        || !isObj(drone) || !isObj(snapshot) || !snapshot.effectGUID || targetID <= 0) return false;
      scene.broadcastSpecialFx(drone.itemID, snapshot.effectGUID, { moduleID: drone.itemID,
        moduleTypeID: drone.typeID, targetID, isOffensive: false, start: true, active: true,
        duration: Math.max(1, toNum(snapshot.durationMs, DEFAULT_DURATION_MS)), repeat: 1 }, drone);
      return true;
    } catch (_err) {
      return false;
    }
  }

  function bayDrones(ownerCharId, shipItemId) {
    try {
      const owner = toInt(ownerCharId, 0);
      const ship = toInt(shipItemId, 0);
      if (owner <= 0 || ship <= 0) return { ok: false, reason: "BAD_ARGS" };
      const proxy = makeProxy({ shipItemId: ship, ownerCharId: owner });
      const items = deps.itemStore.listContainerItems(owner, ship, droneBayFlag()) || [];
      const drones = items.filter((item) => isObj(item) && deps.isDroneItemRecord(item) === true)
        .map((item) => ({
          itemId: toInt(item.itemID, 0), typeId: toInt(item.typeID, 0), quantity: stackOf(item),
          bandwidth: Math.max(0, toNum(deps.getDroneBandwidthLoad(item), 0)),
          ...kindOf(item, proxy),
        }))
        .filter((d) => d.itemId > 0)
        .sort((a, b) => a.typeId - b.typeId || a.itemId - b.itemId);
      return { ok: true, drones };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function limits(ownerCharId, shipItemId) {
    try {
      const ship = toInt(shipItemId, 0);
      const shipItem = deps.itemStore.findItemById(ship);
      if (!shipItem) return { ok: false, reason: "SHIP_NOT_FOUND" };
      const snapshot = deps.getShipFittingSnapshot(toInt(ownerCharId, 0), ship, { shipItem,
        reason: "shipWing.drones" });
      const attrs = isObj(snapshot) && isObj(snapshot.shipAttributes) ? snapshot.shipAttributes : {};
      return { ok: true, maxActive: Math.max(0, toInt(attrs[ATTRIBUTE_MAX_ACTIVE_DRONES], 0)),
        bandwidth: Math.max(0, toNum(attrs[ATTRIBUTE_DRONE_BANDWIDTH], 0)) };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function recall(scene, shipItemId, droneEntities) {
    try {
      const list = (Array.isArray(droneEntities) ? droneEntities : []).filter(isObj);
      if (list.length === 0) return { ok: true, ids: [] };
      const shipRecord = deps.itemStore.findItemById(toInt(shipItemId, 0));
      if (!shipRecord) {
        count("drone.recall.failed");
        return { ok: false, reason: "SHIP_NOT_FOUND" };
      }
      const out = deps.testing().recallDronesToShipBay(scene, shipRecord, list, droneBayFlag());
      if (out && out.success === true) {
        const ids = out.data && Array.isArray(out.data.droneIDs) ? out.data.droneIDs.map((id) => toInt(id, 0)) : [];
        for (let i = 0; i < ids.length; i += 1) count("drone.recall.ok");
        return { ok: true, ids };
      }
      count("drone.recall.failed");
      return { ok: false, reason: String((out && out.errorMsg) || "RECALL_FAILED") };
    } catch (_err) {
      count("drone.recall.failed");
      return { ok: false, reason: "ERROR" };
    }
  }

  function rollback(scene, droneId, ownerCharId, shipItemId) {
    try {
      const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(droneId) : null;
      if (entity) return recall(scene, shipItemId, [entity]).ok === true;
      const custody = deps.itemCustody;
      const out = custody.transfer({
        items: { itemID: droneId },
        from: custody.custodyRef.inSpace(ownerCharId, toInt(scene.systemID, 0)),
        to: custody.custodyRef.shipBay(ownerCharId, shipItemId, droneBayFlag()),
        reason: custody.CUSTODY_REASON.DRONE_RECOVER,
        actor: ownerCharId,
        idempotencyKey: `wing-drone-rollback:${droneId}:${shipItemId}`,
        options: { destinationItemPatch: { singleton: 1, quantity: 1, stacksize: 1, launcherID: null,
          spaceState: null } },
      });
      return Boolean(out && out.success === true);
    } catch (_err) {
      return false;
    }
  }

  function refuse(reason) {
    count(`drone.launch.refused.${reason}`);
    return { ok: false, reason };
  }

  function failAfterCustody(scene, droneId, owner, ship, reason) {
    if (rollback(scene, droneId, owner, ship)) {
      count("drone.launch.rollback");
      return refuse("ROLLED_BACK");
    }
    return { ...refuse(reason), droneId };
  }

  // Port of buildDroneRecoveryItemPatch (droneRuntime.js:4426-4450): full shield and capacitor, the armor and hull damage stays; no launcher, no space state.
  function recoveryPatch(item) {
    const patch = { singleton: 1, quantity: 1, stacksize: 1, launcherID: null, spaceState: null };
    if (isObj(item.conditionState) && typeof deps.itemStore.normalizeShipConditionState === "function") {
      patch.conditionState = deps.itemStore.normalizeShipConditionState({ ...item.conditionState, charge: 1,
        shieldCharge: 1 });
    }
    return patch;
  }

  // Port of getDroneInventoryVolume (droneRuntime.js:2547-2555).
  function droneVolume(item) {
    return Math.max(0, toNum(item && item.volume, 0)) * stackOf(item);
  }

  // port of getDroneRecallCapacityRefusal (droneRuntime.js:4545-4600) for a ship in the SMB (the vendor reads the ship entity in the scene and checks nothing for a docked ship): the drone bay capacity (resourceState.droneCapacity of the fitting snapshot) minus the volume in the bay and the volume of the other
  function bayFull(item, shipRecord, owner, ship, systemId) {
    const required = droneVolume(item);
    if (required <= 0 || typeof deps.getShipFittingSnapshot !== "function"
      || typeof deps.itemStore.listContainerItems !== "function") return false;
    const snapshot = deps.getShipFittingSnapshot(owner, ship, { shipItem: shipRecord, reason: "shipWing.drones" });
    if (!isObj(snapshot)) return false;
    const rs = isObj(snapshot.resourceState) ? snapshot.resourceState : {};
    const attrs = isObj(snapshot.shipAttributes) ? snapshot.shipAttributes : {};
    const capacity = toNum(rs.droneCapacity, toNum(attrs[ATTRIBUTE_DRONE_CAPACITY], 0));
    let used = 0;
    for (const row of deps.itemStore.listContainerItems(owner, ship, droneBayFlag()) || []) {
      if (isObj(row) && toInt(row.flagID, droneBayFlag()) === droneBayFlag()) used += droneVolume(row);
    }
    const droneId = toInt(item.itemID, 0);
    for (const row of deps.itemStore.listContainerItems(owner, systemId, 0) || []) {
      if (!isObj(row) || toInt(row.launcherID, 0) !== ship || toInt(row.itemID, 0) === droneId) continue;
      if (typeof deps.isDroneItemRecord === "function" && deps.isDroneItemRecord(row) !== true) continue;
      used += droneVolume(row);
    }
    return required > capacity - used + VOLUME_EPSILON;
  }

  function refuseReclaim(reason) {
    count(`drone.reclaim.skipped.${reason}`);
    return { ok: false, reason };
  }

  function reclaim(entry) {
    try {
      const droneId = toInt(entry && entry.droneId, 0);
      const ship = toInt(entry && entry.shipItemId, 0);
      const owner = toInt(entry && entry.ownerCharacterId, 0);
      const systemId = toInt(entry && entry.systemId, 0);
      const item = droneId > 0 ? deps.itemStore.findItemById(droneId) : null;
      if (!isObj(item) || systemId <= 0 || toInt(item.flagID, -1) !== 0 || toInt(item.locationID, 0) !== systemId) {
        return refuseReclaim("NOT_IN_SPACE");
      }
      const launcher = toInt(item.launcherID, 0);
      if (owner <= 0 || toInt(item.ownerID, 0) !== owner || (launcher !== 0 && launcher !== ship)) {
        return refuseReclaim("OWNER_CHANGED");
      }
      const shipRecord = ship > 0 ? deps.itemStore.findItemById(ship) : null;
      if (!isObj(shipRecord) || toInt(shipRecord.ownerID, 0) !== owner) return refuseReclaim("SHIP_GONE");
      if (bayFull(item, shipRecord, owner, ship, systemId)) return refuseReclaim("BAY_FULL");
      const runtime = deps.runtime;
      const loaded = typeof runtime.isSolarSystemSceneLoaded === "function"
        && runtime.isSolarSystemSceneLoaded(systemId) === true;
      const scene = loaded && runtime.scenes && typeof runtime.scenes.get === "function"
        ? runtime.scenes.get(systemId) : null;
      const entity = isObj(scene) && typeof scene.getEntityByID === "function" ? scene.getEntityByID(droneId) : null;
      if (isObj(entity)) {
        const out = deps.testing().recallDronesToShipBay(scene, shipRecord, [entity], droneBayFlag());
        if (!out || out.success !== true) return refuseReclaim("CUSTODY_FAILED");
        count("drone.reclaim.ok");
        return { ok: true, how: "scene" };
      }
      const custody = deps.itemCustody;
      const moved = custody.transfer({
        items: { itemID: droneId },
        from: custody.custodyRef.inSpace(owner, systemId),
        to: custody.custodyRef.shipBay(owner, ship, droneBayFlag()),
        reason: custody.CUSTODY_REASON.DRONE_RECOVER,
        actor: owner,
        idempotencyKey: `wing-drone-boot:${droneId}:${ship}`,
        options: { destinationItemPatch: recoveryPatch(item) },
      });
      if (!moved || moved.success !== true) return refuseReclaim("CUSTODY_FAILED");
      count("drone.reclaim.ok");
      return { ok: true, how: "custody" };
    } catch (_err) {
      return refuseReclaim("CUSTODY_FAILED");
    }
  }

  function launch(scene, twin, opts = {}) {
    const owner = toInt(opts.ownerCharId, 0);
    const ship = toInt(opts.shipItemId, 0);
    const itemId = toInt(opts.itemId, 0);
    let droneId = 0;
    try {
      const source = deps.itemStore.findItemById(itemId);
      if (!isObj(source) || deps.isDroneItemRecord(source) !== true || toInt(source.locationID, 0) !== ship
        || toInt(source.flagID, 0) !== droneBayFlag() || !isObj(twin) || owner <= 0) {
        return refuse("NOT_IN_BAY");
      }
      const systemId = toInt(scene.systemID, 0);
      const custody = deps.itemCustody;
      const moved = custody.transfer({
        items: { itemID: itemId, quantity: 1 },
        from: custody.custodyRef.shipBay(owner, ship, droneBayFlag()),
        to: custody.custodyRef.inSpace(owner, systemId),
        reason: custody.CUSTODY_REASON.DRONE_LAUNCH,
        actor: owner,
        idempotencyKey: `wing-drone-launch:${ship}:${itemId}:${toInt(twin.itemID, 0)}:${toInt(opts.seq, 0)}`,
      });
      if (!moved || moved.success !== true) return refuse("CUSTODY_FAILED");
      const changes = moved.data && Array.isArray(moved.data.changes) ? moved.data.changes : [];
      const launched = changes.map((c) => c && c.item).find((item) => isObj(item)
        && toInt(item.locationID, 0) === systemId && toInt(item.flagID, 0) === 0) || null;
      if (!launched) return refuse("CUSTODY_FAILED");
      droneId = toInt(launched.itemID, 0);
      const scope = deps.testing().serializePlayerCompanionScopeMetadata(twin) || {};
      const spaceState = launchSpaceState(twin, opts.launchIndex, scope, systemId);
      const updated = deps.itemStore.updateInventoryItem(droneId, (cur) => ({ ...cur, singleton: 1, quantity: null,
        stacksize: 1, launcherID: ship, spaceState }));
      if (!updated || updated.success !== true) return failAfterCustody(scene, droneId, owner, ship, "SPAWN_FAILED");
      const spawned = deps.runtime.spawnDynamicInventoryEntity(scene.sceneDescriptor || systemId, droneId, {
        sceneDescriptor: scene.sceneDescriptor || undefined, broadcast: false, excludedSession: null });
      const drone = spawned && spawned.success === true && spawned.data ? spawned.data.entity : null;
      if (!isObj(drone)) return failAfterCustody(scene, droneId, owner, ship, "SPAWN_FAILED");
      Object.assign(drone, scope);
      drone.launcherID = ship;
      drone.controllerID = toInt(twin.itemID, 0);
      drone.controllerOwnerID = owner;
      drone.characterID = owner;
      drone.pilotCharacterID = owner;
      drone.corporationID = toInt(twin.corporationID, toInt(drone.corporationID, 0));
      drone.allianceID = toInt(twin.allianceID, toInt(drone.allianceID, 0));
      drone.warFactionID = toInt(twin.warFactionID, toInt(drone.warFactionID, 0));
      drone.activityState = 0;
      drone.targetID = null;
      drone.droneCommand = WING_DRONE_COMMAND;
      drone.droneHomeOrbitDistance = toNum(deps.resolveDroneOrbitDistance(drone), MIN_ORBIT_DISTANCE_M);
      scene.broadcastAddBalls([drone]);
      count("drone.launch.ok");
      return { ok: true, droneId };
    } catch (_err) {
      if (droneId > 0) return failAfterCustody(scene, droneId, owner, ship, "SPAWN_FAILED");
      return refuse("CUSTODY_FAILED");
    }
  }

  function orbit(scene, drone, targetId, rangeM, opts = {}) {
    try {
      const profile = deps.resolveDroneMovementProfile(drone) || {};
      const fraction = opts.fast === true ? toNum(profile.fastSpeedFraction, 1) : toNum(profile.cruiseFraction, 1);
      return scene.orbitShipEntity(drone, toInt(targetId, 0), Math.max(0, toNum(rangeM, 0)),
        { broadcast: true, speedFraction: Math.max(0, Math.min(1, fraction)) }) === true;
    } catch (_err) {
      return false;
    }
  }

  // Port of droneRuntime.js:7064-7164 (no hit messages); the drone is the attacker, the pilot its source.
  function fireCombat(scene, drone, target, snapshot, simMs, ownerCharId) {
    try {
      const interop = deps.runtime.droneInterop;
      if (!isObj(interop) || typeof interop.resolveTurretShot !== "function") {
        return { ok: false, reason: "NO_INTEROP" };
      }
      const owner = toInt(ownerCharId, 0);
      const pseudo = pseudoModuleItem(drone);
      const source = { ...drone, session: null, characterID: owner || null, pilotCharacterID: owner || null };
      const shot = interop.resolveTurretShot({ attackerEntity: drone, targetEntity: target, weaponSnapshot: snapshot });
      count("drone.cycle.fired");
      if (config.droneFxEnabled === true && snapshot.effectGUID && typeof scene.broadcastSpecialFx === "function") {
        try {
          scene.broadcastSpecialFx(drone.itemID, snapshot.effectGUID, { moduleID: pseudo.itemID,
            moduleTypeID: pseudo.typeID, targetID: toInt(target.itemID, 0), isOffensive: true, start: true,
            active: false, duration: toNum(snapshot.durationMs, DEFAULT_DURATION_MS), repeat: 1 }, drone);
        } catch (_err) {
        }
      }
      const hit = Boolean(shot && shot.hit === true);
      count(hit ? "drone.cycle.hit" : "drone.cycle.miss");
      let applied = 0;
      let destroyed = false;
      if (hit && typeof interop.applyWeaponDamageToTarget === "function") {
        const result = interop.applyWeaponDamageToTarget(scene, drone, target, shot.shotDamage, simMs) || {};
        const damageResult = result.damageResult || null;
        const destroyResult = result.destroyResult || null;
        applied = typeof interop.getAppliedDamageAmount === "function"
          ? toNum(interop.getAppliedDamageAmount(damageResult), 0) : 0;
        const weaponSnapshot = { ...snapshot, moduleTypeID: pseudo.typeID };
        if (applied > 0 && typeof interop.noteKillmailDamage === "function") {
          interop.noteKillmailDamage(source, target, applied, { whenMs: simMs, weaponSnapshot, moduleItem: pseudo,
            chargeItem: null });
        }
        if (destroyResult && destroyResult.success === true) {
          destroyed = true;
          count("drone.cycle.kill");
          if (typeof interop.recordKillmailFromDestruction === "function") {
            interop.recordKillmailFromDestruction(target, destroyResult, { attackerEntity: source,
              victimSession: result.victimSession, whenMs: simMs, weaponSnapshot, moduleItem: pseudo,
              chargeItem: null });
          }
        }
      }
      return { ok: true, hit, applied, destroyed };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function surface(scene, a, b) {
    if (scene && typeof scene.getEntitySurfaceDistance === "function") {
      const d = Number(scene.getEntitySurfaceDistance(a, b));
      if (Number.isFinite(d)) return Math.max(0, d);
    }
    return vecSurfaceDistance(a && a.position, toNum(a && a.radius, 0), b && b.position, toNum(b && b.radius, 0));
  }

  // port of droneRuntime.js:7909-7975 (tickDroneRepair after the move).
  function fireRepair(scene, drone, target, snapshot, simMs, _ownerCharId) {
    try {
      if (!isObj(drone) || !isObj(target) || !isObj(snapshot)) return { ok: false, reason: "ERROR" };
      const durationMs = Math.max(1, toNum(snapshot.durationMs, DEFAULT_DURATION_MS));
      if (config.droneFxEnabled === true && snapshot.effectGUID && typeof scene.broadcastSpecialFx === "function") {
        try {
          scene.broadcastSpecialFx(drone.itemID, snapshot.effectGUID, { moduleID: toInt(drone.itemID, 0),
            moduleTypeID: toInt(drone.typeID, 0), targetID: toInt(target.itemID, 0), isOffensive: false, start: true,
            active: false, duration: durationMs, repeat: 1 }, drone);
        } catch (_err) {
        }
      }
      const interop = isObj(deps.runtime.droneInterop) ? deps.runtime.droneInterop : {};
      const effectState = {
        moduleID: toInt(drone.itemID, 0),
        targetID: toInt(target.itemID, 0),
        assistanceModuleEffect: true,
        assistanceFamily: snapshot.repairFamily,
        assistanceJammingType: snapshot.repairFamily,
        assistanceMaxRangeMeters: Math.max(0, toNum(snapshot.maxRangeMeters, 0)),
        assistanceFalloffMeters: 0,
        assistanceShieldBonusAmount: Math.max(0, toNum(snapshot.shieldBonusAmount, 0)),
        assistanceArmorRepairAmount: Math.max(0, toNum(snapshot.armorRepairAmount, 0)),
        assistanceHullRepairAmount: Math.max(0, toNum(snapshot.hullRepairAmount, 0)),
      };
      const out = deps.executeAssistanceModuleCycle({
        scene, session: null, entity: drone, effectState, nowMs: simMs,
        callbacks: {
          isEntityLockedTarget: () => true,
          getEntitySurfaceDistance: (source, other) => surface(scene, source, other),
          normalizeShipConditionState: interop.normalizeShipConditionState,
          buildShipHealthTransitionResult: interop.buildShipHealthTransitionResult,
          notifyShipHealthAttributesToSession: interop.notifyShipHealthAttributesToSession,
          broadcastDamageStateChange: interop.broadcastDamageStateChange,
          persistDynamicEntity: interop.persistDynamicEntity,
        },
      });
      if (!out || out.success !== true) {
        const msg = isObj(out) && typeof out.errorMsg === "string" ? out.errorMsg : "";
        return { ok: false, reason: CYCLE_REASON.includes(msg) ? msg : "OTHER" };
      }
      const data = isObj(out.data) ? out.data : {};
      return { ok: true, appliedAmount: Math.max(0, toNum(data.appliedAmount, 0)) };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function canInteract(source, entity) {
    try {
      return deps.canEntitiesInteractLocally(source, entity) === true;
    } catch (_err) {
      return false;
    }
  }

  return Object.freeze({
    makeProxy, bayDrones, limits, launch, recall, combatSnapshot, ranges, orbit, fireCombat, repairSnapshot,
    fireRepair, canInteract, reclaim,
    miningSnapshot, miningFx,
    salvageSnapshot, salvageCycle,
    stats: () => ({ counters: { ...counters } }),
  });
}

function depsFromGame(g, opts = {}) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  const mining = opts.mining === true ? {
    resolveDroneMiningSnapshot: late("droneDogma", "resolveDroneMiningSnapshot"),
    resolveItemByTypeID: late("itemTypeRegistry", "resolveItemByTypeID"),
  } : {};
  const s = opts.salvage;
  const salvage = isObj(s) ? {
    resolveDroneSalvageSnapshot: late("droneDogma", "resolveDroneSalvageSnapshot"),
    executeSalvagerCycle: (...args) => s.salvagerRuntime.executeSalvagerCycle(...args),
    buildSalvageChanceSnapshot: (...args) => s.salvagerRuntime.buildSalvageChanceSnapshot(...args),
    isSalvageableTarget: (...args) => s.salvagerRuntime.isSalvageableTarget(...args),
    buildSalvagerRuntimeCallbacks: (...args) => s.moduleRuntimeCallbacks.buildSalvagerRuntimeCallbacks(...args),
  } : {};
  return {
    ...mining,
    ...salvage,
    isDroneItemRecord: late("fighterInventory", "isDroneItemRecord"),
    getDroneBandwidthLoad: late("droneRuntime", "getDroneBandwidthLoad"),
    resolveDroneOrbitDistance: late("droneRuntime", "resolveDroneOrbitDistance"),
    resolveDroneMovementProfile: late("droneRuntime", "resolveDroneMovementProfile"),
    testing: () => g.droneRuntime._testing,
    resolveDroneCombatSnapshot: late("droneDogma", "resolveDroneCombatSnapshot"),
    getShipFittingSnapshot: late("fittingRuntime", "getShipFittingSnapshot"),
    resolveDroneRepairSnapshot: late("droneDogma", "resolveDroneRepairSnapshot"),
    executeAssistanceModuleCycle: late("assistanceModuleRuntime", "executeAssistanceModuleCycle"),
    canEntitiesInteractLocally: late("interactionScope", "canEntitiesInteractLocally"),
    itemCustody: g.itemCustody,
    itemStore: g.itemStore,
    runtime: g.runtime,
  };
}

function createDroneAccessFromGame(gameAdapter, input = {}) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("drones")) {
    return { ok: false, reason: "probe_drones_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(DRONE_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  const testing = game.droneRuntime._testing;
  const lacking = TESTING_FUNCTIONS.filter((name) => !isObj(testing) || typeof testing[name] !== "function");
  if (lacking.length > 0) return { ok: false, reason: `drift:_testing.${lacking.join(",")}` };
  const mining = Boolean(input.config && input.config.droneMiningEnabled === true)
    && gameAdapter.isConsumerAvailable("droneMining") === true;
  const salvage = salvageModulesOf(gameAdapter, input.config);
  return { ok: true, access: createDroneAccess({ deps: depsFromGame(game, { mining, salvage }),
    config: input.config }) };
}

function salvageModulesOf(gameAdapter, config) {
  if (!config || config.droneSalvageEnabled !== true || config.salvageEnabled !== true
    || gameAdapter.isConsumerAvailable("droneSalvage") !== true) return null;
  const out = {};
  for (const [key, rel] of Object.entries(DRONE_SALVAGE_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) return null;
    out[key] = loaded.exports;
  }
  return out;
}

module.exports = {
  DRONE_MODULES, TESTING_FUNCTIONS, WING_DRONE_COMMAND, LAUNCH_REFUSAL, RECLAIM_REFUSAL, DRONE_ACCESS_COUNTER_NAMES,
  DRONE_SALVAGE_MODULES, SALVAGE_REFUSAL,
  ranges, pseudoModuleItem, droneYieldKind,
  createDroneAccess, createDroneAccessFromGame,
};
