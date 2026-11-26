"use strict";

const WRAPPED = Symbol.for("livingNewEden.dormancyGuard");
const METHOD = "canDematerializeDormantCombatController";

const protectedIds = new Set();
let installed = false;
let blocked = 0;

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function controllerIdOf(controller) {
  if (!controller || typeof controller !== "object") return 0;
  const id = Number(controller.entityID || controller.itemID);
  return isPositiveInt(id) ? id : 0;
}

function makeWrapper(original) {
  const wrapper = function livingNewEdenDormancyGuard(scene, controller) {
    const id = protectedIds.size > 0 ? controllerIdOf(controller) : 0;
    if (id !== 0 && protectedIds.has(id)) {
      blocked += 1;
      return false;
    }
    return original.apply(this, arguments);
  };
  Object.defineProperty(wrapper, "name", { value: `livingNewEden_${METHOD}` });
  for (const s of Object.getOwnPropertySymbols(original)) {
    if (s !== WRAPPED) wrapper[s] = original[s];
  }
  wrapper[WRAPPED] = true;
  return wrapper;
}

function install(dormancyExports) {
  if (!dormancyExports || typeof dormancyExports !== "object"
    || !Object.prototype.hasOwnProperty.call(dormancyExports, METHOD)
    || typeof dormancyExports[METHOD] !== "function") {
    return { ok: false, reason: "NOT_A_FUNCTION" };
  }
  const original = dormancyExports[METHOD];
  if (original[WRAPPED] === true) {
    installed = true;
    return { ok: true, alreadyInstalled: true };
  }
  const wrapper = makeWrapper(original);
  try {
    dormancyExports[METHOD] = wrapper;
  } catch (_err) {
    return { ok: false, reason: "NOT_WRITABLE" };
  }
  if (dormancyExports[METHOD] !== wrapper) return { ok: false, reason: "NOT_WRITABLE" };
  installed = true;
  return { ok: true, alreadyInstalled: false };
}

function protect(entityId) {
  if (isPositiveInt(entityId)) protectedIds.add(entityId);
}

function release(entityId) {
  if (isPositiveInt(entityId)) protectedIds.delete(entityId);
}

function isProtected(entityId) {
  return isPositiveInt(entityId) && protectedIds.has(entityId);
}

function stats() {
  return { installed, protected: protectedIds.size, blocked };
}

function checkHookInstalled(dormancyExports) {
  return Boolean(dormancyExports) && typeof dormancyExports[METHOD] === "function"
    && dormancyExports[METHOD][WRAPPED] === true;
}

module.exports = { install, protect, release, isProtected, stats, checkHookInstalled, WRAPPED, METHOD };
