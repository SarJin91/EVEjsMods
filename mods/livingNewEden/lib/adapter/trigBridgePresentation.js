"use strict";

const { MARKER_KEY } = require("./trigBridge");

const SCENE_PATH = "space/runtime/solarSystemScene";
const SCENE_CLASS = "SolarSystemScene";
const ADD_METHOD = "addStaticEntity";
const TYPE_ANSIBLEX = 35841;
const STRUCTURE_KIND = "structure";
const HOOK_MARKER = Symbol.for("livingNewEden.trigBridge.presentation");
const DETAIL_MAX = 120;
const FAIL_LOG_INTERVAL_MS = 60000;

const isFn = (o, k) => Boolean(o) && typeof o[k] === "function";
const fit = (text) => String(text).slice(0, DETAIL_MAX);
const messageOf = (err) => fit((err && err.message) || err);

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function hasMarker(row) {
  const flags = row && typeof row === "object" ? row.devFlags : null;
  const m = flags && typeof flags === "object" ? flags[MARKER_KEY] : null;
  return Boolean(m && typeof m === "object");
}

function seamProblem(v) {
  const s = v || {};
  const cls = s.sceneModule && s.sceneModule[SCENE_CLASS];
  if (typeof cls !== "function" || !cls.prototype || typeof cls.prototype[ADD_METHOD] !== "function") {
    return `${SCENE_CLASS}_${ADD_METHOD}`;
  }
  if (!isFn(s.structureState, "getStructureByID")) return "structureState_getStructureByID";
  if (!isFn(s.runtime, "isSolarSystemSceneLoaded") || !(s.runtime.scenes instanceof Map)) {
    return "runtime_isSolarSystemSceneLoaded_scenes";
  }
  return null;
}

function checkPresentationSeams(v) {
  const problem = seamProblem(v);
  return problem === null ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", detail: problem };
}

function createPresentation(deps) {
  const d = deps || {};
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : null;
  const nowMs = typeof d.nowMs === "function" ? d.nowMs : () => Date.now();
  const typeId = toPositiveInt(d.typeId);
  const stats = { added: 0, applied: 0, errors: 0 };
  let installed = false;
  let active = false;
  let proto = null;
  let original = null;
  let wrapper = null;
  let lastFailLogAt = -Infinity;

  const noted = (how) => {
    if (typeof d.onApplied !== "function") return;
    try {
      d.onApplied(how);
    } catch (_err) {
    }
  };
  const noteError = (where, err) => {
    stats.errors += 1;
    const now = nowMs();
    if (!logger || now - lastFailLogAt < FAIL_LOG_INTERVAL_MS) return;
    lastFailLogAt = now;
    try {
      logger.log(`trigBridge: presentation ${where} failed (errors=${stats.errors}) - ${messageOf(err)}`);
    } catch (_err) {
    }
  };

  const isTarget = (entity) => {
    if (!entity || typeof entity !== "object" || entity.kind !== STRUCTURE_KIND) return false;
    if (toPositiveInt(entity.typeID) !== TYPE_ANSIBLEX) return false;
    const id = toPositiveInt(entity.itemID);
    return id > 0 && hasMarker(d.structureState.getStructureByID(id, { refresh: false }));
  };

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const problem = seamProblem(d);
    if (problem) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: problem };
    if (!typeId) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "typeId" };
    const target = d.sceneModule[SCENE_CLASS].prototype;
    if (target[ADD_METHOD][HOOK_MARKER]) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const base = target[ADD_METHOD];
    const wrapped = function addStaticEntity(entity) {
      if (active) {
        try {
          if (isTarget(entity) && entity.slimTypeID !== typeId) {
            entity.slimTypeID = typeId;
            stats.added += 1;
            noted("add");
          }
        } catch (err) {
          noteError("add", err);
        }
      }
      return base.apply(this, arguments);
    };
    Object.defineProperty(wrapped, HOOK_MARKER, { value: true });
    target[ADD_METHOD] = wrapped;
    if (target[ADD_METHOD] !== wrapped) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${ADD_METHOD} not writable` };
    }
    proto = target;
    original = base;
    wrapper = wrapped;
    installed = true;
    active = true;
    return { ok: true };
  }

  function apply(structureId) {
    if (!active) return { ok: false, reason: "NOT_INSTALLED" };
    try {
      const id = toPositiveInt(structureId);
      const row = id ? d.structureState.getStructureByID(id, { refresh: false }) : null;
      if (!row || toPositiveInt(row.typeID) !== TYPE_ANSIBLEX || row.destroyedAt || !hasMarker(row)) {
        return { ok: true, applied: false };
      }
      const systemId = toPositiveInt(row.solarSystemID);
      if (!systemId || d.runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: true, applied: false };
      const scene = d.runtime.scenes.get(systemId);
      const byId = scene && scene.staticEntitiesByID instanceof Map ? scene.staticEntitiesByID : null;
      const entity = byId ? byId.get(id) : null;
      if (!entity || entity.kind !== STRUCTURE_KIND || toPositiveInt(entity.typeID) !== TYPE_ANSIBLEX
        || entity.slimTypeID === typeId) return { ok: true, applied: false };
      entity.slimTypeID = typeId;
      if (typeof scene.broadcastSlimItemChanges === "function") scene.broadcastSlimItemChanges([entity]);
      stats.applied += 1;
      noted("apply");
      return { ok: true, applied: true };
    } catch (err) {
      noteError("apply", err);
      return { ok: false, reason: "SEAM_ERROR", detail: messageOf(err) };
    }
  }

  function uninstall() {
    active = false;
    try {
      if (installed && proto && proto[ADD_METHOD] === wrapper) proto[ADD_METHOD] = original;
    } catch (_err) {
    }
    installed = false;
  }

  return Object.freeze({ install, uninstall, apply, isActive: () => active, getStats: () => ({ ...stats }) });
}

module.exports = { SCENE_PATH, SCENE_CLASS, ADD_METHOD, TYPE_ANSIBLEX, HOOK_MARKER, checkPresentationSeams,
  createPresentation };
