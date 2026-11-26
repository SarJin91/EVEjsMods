"use strict";

const PATHS = Object.freeze({ runtime: "space/runtime" });
const FUNCTIONS = Object.freeze({ runtime: Object.freeze(["isSolarSystemSceneLoaded"]) });
const SHIP_WING_DIR = "shipWing";
const PERMILLE = 1000;
const MARK_MIN = 1;
const MARK_MAX = 99;

const isObj = (v) => Boolean(v) && typeof v === "object";
const fail = (reason) => ({ ok: false, reason });
const positiveInt = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

function isWingCopyShape(entity) {
  return isObj(entity) && entity.kind === "ship" && entity.transient === true && Number(entity.characterID) === 0
    && positiveInt(entity.pilotCharacterID) > 0 && entity.nativeNpc !== true;
}

function isWingCopyEntity(entity) {
  if (!isWingCopyShape(entity)) return false;
  if (entity.destroying === true || entity.destructionState === "destroying"
    || entity.destructionState === "destroyed") {
    return false;
  }
  return !entity.session;
}

function hpPermilleOf(condition) {
  if (!isObj(condition)) return null;
  const shield = Number(condition.shieldCharge);
  const armorDamage = Number(condition.armorDamage);
  const damage = Number(condition.damage);
  if (![shield, armorDamage, damage].every(Number.isFinite)) return null;
  const clamp = (n) => Math.min(PERMILLE, Math.max(0, Math.round(n * PERMILLE)));
  return [clamp(shield), clamp(1 - armorDamage), clamp(1 - damage)];
}

function readWingCopiesFrom(mods, systemId, opts) {
  try {
    const scanMax = isObj(opts) && Number.isSafeInteger(opts.scanMax) && opts.scanMax > 0 ? opts.scanMax : 0;
    if (!Number.isSafeInteger(systemId) || systemId <= 0 || scanMax === 0) return fail("INVALID_INPUT");
    const runtime = isObj(mods) ? mods.runtime : null;
    if (!isObj(runtime) || typeof runtime.isSolarSystemSceneLoaded !== "function"
      || !(runtime.scenes instanceof Map)) {
      return fail("SEAM_UNAVAILABLE");
    }
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return fail("SCENE_NOT_LOADED");
    const scene = runtime.scenes.get(systemId);
    if (!isObj(scene) || !(scene.dynamicEntities instanceof Map)) return fail("SCENE_NOT_LOADED");
    const copies = [];
    let unreadable = 0;
    let seen = 0;
    let truncated = false;
    for (const entity of scene.dynamicEntities.values()) {
      if (seen >= scanMax) {
        truncated = true;
        break;
      }
      seen += 1;
      if (!isWingCopyEntity(entity)) continue;
      const entityId = positiveInt(entity.itemID);
      const hp = hpPermilleOf(entity.conditionState);
      if (entityId === 0 || hp === null) {
        unreadable += 1;
        continue;
      }
      const name = typeof entity.itemName === "string" && entity.itemName.trim() !== "" ? entity.itemName : null;
      copies.push({ entityId, ownerId: positiveInt(entity.pilotCharacterID), typeId: positiveInt(entity.typeID) || null,
        name, hp });
    }
    return { ok: true, truncated, unreadable, copies };
  } catch (_err) {
    return fail("SEAM_UNAVAILABLE");
  }
}

function readShipWingHpMarks(deps) {
  try {
    const load = isObj(deps) && typeof deps.loadModConfig === "function" ? deps.loadModConfig : null;
    if (!load) return fail("CONFIG_MISSING");
    const loaded = load(SHIP_WING_DIR);
    if (!isObj(loaded) || loaded.ok !== true) {
      const reason = isObj(loaded) && ["CONFIG_MISSING", "CONFIG_SHAPE", "CONFIG_LOAD_FAILED"].includes(loaded.reason)
        ? loaded.reason : "CONFIG_MISSING";
      return fail(reason);
    }
    const cfg = loaded.exports;
    if (!isObj(cfg) || typeof cfg.loadConfig !== "function") return fail("CONFIG_SHAPE");
    let r;
    try {
      r = cfg.loadConfig({ env: (deps.env && isObj(deps.env)) ? deps.env : process.env, modDir: loaded.modDir });
    } catch (_err) {
      return fail("CONFIG_LOAD_FAILED");
    }
    const c = isObj(r) && isObj(r.config) ? r.config : null;
    if (!c) return fail("CONFIG_LOAD_FAILED");
    const warnPct = c.hpWarnPct;
    const criticalPct = c.hpCriticalPct;
    if (!Number.isSafeInteger(warnPct) || !Number.isSafeInteger(criticalPct) || criticalPct < MARK_MIN
      || warnPct > MARK_MAX || criticalPct >= warnPct) {
      return fail("BAD_MARKS");
    }
    return { ok: true, warnPct, criticalPct };
  } catch (_err) {
    return fail("CONFIG_LOAD_FAILED");
  }
}

function checkShipAiWingFrom(requireGame) {
  const missing = [];
  for (const key of Object.keys(PATHS)) {
    let r = null;
    try {
      r = typeof requireGame === "function" ? requireGame(PATHS[key]) : null;
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !r.exports) {
      missing.push(PATHS[key]);
      continue;
    }
    for (const name of FUNCTIONS[key]) {
      if (typeof r.exports[name] !== "function") missing.push(`${PATHS[key]}.${name}`);
    }
    if (key === "runtime" && !(r.exports.scenes instanceof Map)) missing.push(`${PATHS.runtime}.scenes`);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

module.exports = { isWingCopyEntity, isWingCopyShape, hpPermilleOf, readWingCopiesFrom, readShipWingHpMarks,
  checkShipAiWingFrom, PATHS, FUNCTIONS, SHIP_WING_DIR };
