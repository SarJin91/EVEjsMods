"use strict";

const { cycleOk } = require("../../core/cycleSchedule");
const { twinShipItem } = require("../twinDogma");

const AREA_REFUSAL_CODES = Object.freeze(["UNSUPPORTED_MODULE", "MODULE_DISALLOWED_IN_HIGHSEC",
  "CANNOT_ACTIVATE_IN_WARP", "CRIMEWATCH_UNAVAILABLE", "AMMO_UPDATE_FAILED", "OTHER"]);
const AREA_COUNTER_NAMES = Object.freeze(["combat.area.cycle", "combat.area.hit", "combat.area.kill",
  ...AREA_REFUSAL_CODES.map((code) => `combat.area.refused.${code}`)]);
const SMARTBOMB = "smartbomb";
const POINT_DEFENSE = "pointDefense";
const RANGE_SCENE = Object.freeze({ system: null });
const BYSTANDER_KINDS = Object.freeze(["ship", "drone", "fighter", "structure"]);
const CONCORD_TYPE = "concord";
const WARP_MODE = "WARP";

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function createAreaHandler(env) {
  const { deps, config, count, skip, targetAllowed } = env;
  const kinds = new Map();

  function effectOf(module) {
    return deps.resolveDefaultActivationEffect(toInt(module && module.typeID, 0)) || null;
  }

  function subKindOf(module) {
    const typeID = toInt(module && module.typeID, 0);
    if (typeID <= 0) return null;
    if (kinds.has(typeID)) return kinds.get(typeID);
    const rec = effectOf(module);
    let kind = null;
    if (deps.isSmartbombEffect(rec, module) === true) kind = SMARTBOMB;
    else if (rec && deps.isPointDefenseEffect(rec) === true) kind = POINT_DEFENSE;
    kinds.set(typeID, kind);
    return kind;
  }

  function match(module, _charge, family) {
    if (family) return false;
    try {
      return subKindOf(module) !== null;
    } catch (_err) {
      return false;
    }
  }

  function chargeStack(charge, ammoLeft) {
    const left = Number(ammoLeft);
    const n = Number.isFinite(left) ? Math.floor(left)
      : Math.max(0, toInt(charge && (charge.quantity ?? charge.stacksize), 0));
    return { ...charge, stacksize: n, quantity: n };
  }

  function activate(scene, twin, module, rec, kind, shipItem, chargeItem) {
    if (kind === SMARTBOMB) {
      return deps.resolveSmartbombActivation({ entity: twin, moduleItem: module, effectRecord: rec, shipItem,
        skillMap: twin.skillMap, fittedItems: twin.fittedItems, activeModuleContexts: [],
        additionalLocationModifierSources: deps.getLocationModifierSourcesForSystem(twin.systemID) });
    }
    return deps.resolvePointDefenseActivation({ scene, entity: twin, moduleItem: module, effectRecord: rec,
      chargeItem, shipItem, skillMap: twin.skillMap, fittedItems: twin.fittedItems, activeModuleContexts: [] });
  }

  function range(twin, _weapon, resolved) {
    const module = resolved && resolved.module;
    const kind = subKindOf(module);
    const shipItem = twinShipItem(twin, deps);
    if (!kind || !shipItem) return { ok: false, reason: "NO_SNAPSHOT" };
    const chargeItem = kind === POINT_DEFENSE && resolved.charge ? chargeStack(resolved.charge, NaN) : null;
    const out = activate(RANGE_SCENE, twin, module, effectOf(module), kind, shipItem, chargeItem);
    if (!out || out.success !== true || !out.data) return { ok: false, reason: "NO_SNAPSHOT" };
    const patch = out.data.effectStatePatch || {};
    const meters = Number(kind === SMARTBOMB ? patch.smartbombRangeMeters : patch.pointDefenseRangeMeters);
    return { ok: true, optimalM: Number.isFinite(meters) ? Math.max(0, meters) : 0, falloffM: 0 };
  }

  function refused(code, retryMs) {
    const name = AREA_REFUSAL_CODES.includes(code) ? code : "OTHER";
    count(`combat.area.refused.${name}`);
    return skip("VENDOR_REFUSED", retryMs);
  }

  function isOwnersEntity(entity, twin) {
    const owner = toInt(twin && twin.ownerID, 0);
    if (owner <= 0) return false;
    return toInt(entity.ownerID, 0) === owner || toInt(entity.pilotCharacterID, 0) === owner
      || toInt(entity.characterID, 0) === owner;
  }

  function isBystander(entity, twin) {
    if (!entity || entity === twin) return false;
    if (isOwnersEntity(entity, twin)) return false;
    if (entity.session) return true;
    if (toInt(entity.pilotCharacterID, 0) > 0 || toInt(entity.characterID, 0) > 0) return true;
    if (entity.nativeNpc !== true && BYSTANDER_KINDS.includes(entity.kind)) return true;
    return String(entity.npcEntityType || "").trim().toLowerCase() === CONCORD_TYPE;
  }

  function broadcastFx(scene, twin, module, charge, rec, effectState, durationMs) {
    if (config.combatFxEnabled !== true || typeof scene.broadcastSpecialFx !== "function") return;
    try {
      const guid = String((rec && rec.guid) || "");
      if (!guid) return;
      scene.broadcastSpecialFx(twin.itemID, guid, {
        moduleID: toInt(module.itemID, 0),
        moduleTypeID: toInt(module.typeID, 0),
        targetID: 0,
        chargeTypeID: toInt(charge && charge.typeID, 0),
        start: true,
        active: false,
        duration: durationMs,
        graphicInfo: typeof deps.buildGenericModuleSpecialFxGraphicInfo === "function"
          ? deps.buildGenericModuleSpecialFxGraphicInfo(effectState) : null,
      }, twin);
    } catch (_err) {
      count("combat.fx.error");
    }
  }

  function fire(scene, twin, _weapon, _target, simMs, opts) {
    const { module, charge } = opts;
    const retryMs = config.combatReacquireMs;
    const kind = subKindOf(module);
    if (!kind) return skip("UNSUPPORTED_FAMILY", null);
    const rec = effectOf(module);
    if (twin.mode === WARP_MODE) return refused("CANNOT_ACTIVATE_IN_WARP", retryMs);
    if (kind === SMARTBOMB && config.combatAreaAllowHighsec !== true
      && deps.isHighSecuritySystem(scene && scene.system) === true) {
      return skip("HIGHSEC", retryMs);
    }
    let chargeItem = null;
    if (kind === POINT_DEFENSE) {
      if (!charge || !(Number(opts.ammoLeft) >= 1)) return skip("NO_AMMO", null);
      chargeItem = chargeStack(charge, opts.ammoLeft);
    }
    const shipItem = twinShipItem(twin, deps);
    if (!shipItem) return skip("NO_SNAPSHOT", null);
    const activation = activate(scene, twin, module, rec, kind, shipItem, chargeItem);
    if (!activation || activation.success !== true || !activation.data) {
      const code = String((activation && activation.errorMsg) || "OTHER");
      return code === "NO_AMMO" ? skip("NO_AMMO", null) : refused(code, retryMs);
    }
    const patch = activation.data.effectStatePatch || {};
    const runtimeAttrs = activation.data.runtimeAttrs || {};
    const durationMs = Number(runtimeAttrs.durationMs);
    const rangeM = Math.max(0, Number(kind === SMARTBOMB ? patch.smartbombRangeMeters
      : patch.pointDefenseRangeMeters) || 0);
    const vendorCb = kind === SMARTBOMB ? deps.buildSmartbombRuntimeCallbacks(scene)
      : deps.buildPointDefenseRuntimeCallbacks(scene);
    const listed = kind === SMARTBOMB ? vendorCb.listDamageableEntitiesInSmartbombRange(twin, rangeM)
      : vendorCb.listDamageableEntitiesInRange(twin, rangeM);
    const raw = (Array.isArray(listed) ? listed : []).filter((entity) => entity && entity !== twin);
    const host = opts.host || null;
    const allowed = host ? raw.filter((entity) => targetAllowed(scene, twin, host, entity) === true) : [];
    const allowedSet = new Set(allowed);
    if (config.combatAreaHoldWhenBystander === true
      && raw.some((entity) => !allowedSet.has(entity) && isBystander(entity, twin))) {
      return skip("BYSTANDER", retryMs);
    }
    if (allowed.length === 0) return skip("NO_TARGETS", retryMs);
    const effectState = { moduleID: toInt(module.itemID, 0), typeID: toInt(module.typeID, 0), ...patch };
    broadcastFx(scene, twin, module, charge, rec, effectState, durationMs);
    let used = 0;
    let callbacks;
    if (kind === SMARTBOMB) {
      callbacks = { ...vendorCb, listDamageableEntitiesInSmartbombRange: () => allowed,
        evaluateOffensiveAggression: undefined, recordOffensiveAggression: undefined };
    } else {
      const stack = toInt(chargeItem.stacksize, 0);
      callbacks = { ...vendorCb, listDamageableEntitiesInRange: () => allowed, evaluateOffensiveAggression: undefined,
        breakEntityStructureTether: undefined, getEntityRuntimeLoadedCharge: () => chargeItem,
        consumeLoadedCharge: (_e, _m, _c, n) => {
          used = Math.max(0, toInt(n, 0));
          return { success: true, data: { nextQuantity: Math.max(0, stack - used), depleted: stack - used <= 0 } };
        } };
    }
    const input = { scene, entity: twin, moduleItem: module, effectState, nowMs: simMs, callbacks };
    const out = kind === SMARTBOMB ? deps.executeSmartbombCycle(input) : deps.executePointDefenseCycle(input);
    if (!out || out.success !== true) return refused(String((out && out.errorMsg) || "OTHER"), retryMs);
    count("combat.area.cycle");
    let applied = 0;
    let hits = 0;
    const results = out.data && Array.isArray(out.data.damageResults) ? out.data.damageResults : [];
    for (const entry of results) {
      const weaponDamage = (entry && entry.damageResult) || {};
      const amount = Number(deps.getAppliedDamageAmount(weaponDamage.damageResult)) || 0;
      if (amount > 0) {
        hits += 1;
        applied += amount;
        count("combat.area.hit");
      }
      if (weaponDamage.destroyResult && weaponDamage.destroyResult.success) count("combat.area.kill");
    }
    const pd = kind === POINT_DEFENSE;
    return cycleOk(durationMs, { hit: hits > 0, applied, destroyed: false, chargeItemId: toInt(charge && charge.itemID, 0),
      chargeMode: pd ? "stack" : "", chargesUsed: pd ? used : 0 });
  }

  return Object.freeze({
    id: "area",
    consumer: "combatArea",
    configKey: "combatAreaEnabled",
    steers: false,
    needsLock: false,
    match,
    needsAmmo: (module) => {
      try {
        return subKindOf(module) === POINT_DEFENSE;
      } catch (_err) {
        return false;
      }
    },
    range,
    fire,
  });
}

module.exports = { createAreaHandler, AREA_COUNTER_NAMES, AREA_REFUSAL_CODES };
