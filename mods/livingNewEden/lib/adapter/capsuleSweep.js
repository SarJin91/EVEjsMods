"use strict";

const PATHS = Object.freeze({
  characterState: "services/character/characterState",
  itemStore: "services/inventory/itemStore",
  runtime: "space/runtime",
  actions: "space/destiny/stream/actions",
});
const EXPORT_NAME = "boardSpaceShip";
const SWEEP_MARK = Symbol.for("livingNewEden.capsuleSweep");
const UNAVAILABLE = "CAPSULE_SWEEP_UNAVAILABLE";

const COUNTER_NAMES = Object.freeze(["boardsFromCapsule", "observerForgotten", "resent", "resendRefused", "clean",
  "swept", "sweptAfterVendorFailure", "sweptAfterVendorSuccess", "entityRefused", "itemRefused", "errors", "noTools"]);

const posInt = (v) => {
  const n = typeof v === "bigint" || (typeof v === "string" && v.trim() !== "") ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const errorText = (err) => String((err && err.message) || err).slice(0, 200);

const vendorText = (result) => {
  if (result && result.success === true) return "ok";
  if (result && typeof result.errorMsg === "string" && result.errorMsg !== "") return result.errorMsg.slice(0, 80);
  return result === undefined ? "threw" : "failed";
};

function safeCall(fn, ...args) {
  try {
    if (typeof fn === "function") return fn(...args);
  } catch (_err) {
  }
  return undefined;
}

function takePre(session, shipID, deps) {
  try {
    const tools = deps.getTools();
    if (!tools) {
      safeCall(deps.count, "noTools");
      return null;
    }
    const charId = posInt(session && session.characterID);
    if (charId === null) return null;
    const active = tools.getActiveShipRecord(charId);
    if (!active || tools.isCapsuleTypeID(active.typeID) !== true) return null;
    const capsuleId = posInt(active.itemID);
    if (capsuleId === null || capsuleId === Number(shipID)) return null;
    const scene = tools.getSceneForSession(session);
    const known = scene && typeof scene.getKnownGridBubbleIDForSession === "function"
      ? scene.getKnownGridBubbleIDForSession(session) : null;
    const systemId = posInt(scene && scene.systemID) || posInt(session.solarsystemid2) || posInt(session.solarsystemid);
    safeCall(deps.count, "boardsFromCapsule");
    return { charId, capsuleId, systemId, knownBubbleBefore: known === undefined ? null : known };
  } catch (_err) {
    safeCall(deps.count, "errors");
    return null;
  }
}

function afterBoard(pre, session, vendorResult, deps) {
  try {
    const tools = deps.getTools();
    if (!tools) {
      safeCall(deps.count, "noTools");
      return { ok: false, reason: "NO_TOOLS" };
    }
    const after = tools.getActiveShipRecord(pre.charId);
    const afterId = posInt(after && after.itemID);
    if (!after || afterId === pre.capsuleId || tools.isCapsuleTypeID(after.typeID) === true) {
      return { ok: true, resent: false, swept: "none", reason: "STILL_IN_CAPSULE" };
    }
    const scene = tools.getSceneForSession(session);
    if (!scene) return { ok: true, resent: false, swept: "none", reason: "NO_SCENE" };

    let entitySwept = false;
    const entity = scene.getEntityByID(pre.capsuleId);
    if (entity) {
      const removed = entity.kind === "ship" && !entity.session ? scene.removeDynamicEntity(pre.capsuleId, {}) : null;
      if (removed && removed.success === true) entitySwept = true;
      else safeCall(deps.count, "entityRefused");
    }
    let itemSwept = false;
    const item = tools.findItemById(pre.capsuleId);
    if (item && tools.isCapsuleTypeID(item.typeID) === true) {
      const inSpaceHere = posInt(item.ownerID) === pre.charId && pre.systemId !== null
        && posInt(item.locationID) === pre.systemId && Number(item.flagID) === 0
        && posInt(item.itemID === undefined ? pre.capsuleId : item.itemID) !== afterId;
      const removed = inSpaceHere ? tools.removeInventoryItem(pre.capsuleId, { removeContents: true }) : null;
      if (removed && removed.success === true) itemSwept = true;
      else safeCall(deps.count, "itemRefused");
    }
    let swept = "none";
    if (entitySwept && itemSwept) swept = "entity+item";
    else if (entitySwept) swept = "entity";
    else if (itemSwept) swept = "item";

    const forgotten = pre.knownBubbleBefore !== null && pre.knownBubbleBefore !== undefined
      && scene.getKnownGridBubbleIDForSession(session) === null && !scene.getEntityByID(pre.capsuleId);
    let resent = false;
    if (forgotten) {
      safeCall(deps.count, "observerForgotten");
      if (safeCall(deps.resendEnabled) === true) {
        const stamp = scene.queueCharacterHistory(session, [{ payload: tools.buildRemoveBallsPayload([pre.capsuleId]) }]);
        if (stamp === null || stamp === undefined) safeCall(deps.count, "resendRefused");
        else {
          resent = true;
          safeCall(deps.count, "resent");
        }
      }
    }

    const vendorOk = Boolean(vendorResult) && vendorResult.success === true;
    if (swept !== "none") {
      safeCall(deps.count, "swept");
      safeCall(deps.count, vendorOk ? "sweptAfterVendorSuccess" : "sweptAfterVendorFailure");
    }
    if (vendorOk && !forgotten && swept === "none") safeCall(deps.count, "clean");
    safeCall(deps.logLine, `capsuleSweep: ship=${afterId} capsule=${pre.capsuleId} vendor=${vendorText(vendorResult)} `
      + `observerForgotten=${forgotten} resent=${resent} swept=${swept}`);
    let reason = "CLEAN";
    if (resent) reason = "RESENT";
    else if (swept !== "none") reason = "SWEPT";
    else if (forgotten) reason = "FORGOTTEN_NOT_RESENT";
    return { ok: true, resent, swept, reason };
  } catch (err) {
    safeCall(deps.count, "errors");
    safeCall(deps.logLine, `capsuleSweep: error capsule=${pre && pre.capsuleId} - ${errorText(err)}`);
    return { ok: false, reason: "SWEEP_ERROR", error: errorText(err) };
  }
}

function wrapBoardForCapsuleSweep(original, deps) {
  if (typeof original !== "function") return { ok: false, reason: "ORIGINAL_NOT_FUNCTION" };
  if (original[SWEEP_MARK] === true) return { ok: true, wrapped: original, noop: true };
  const d = deps || {};
  for (const name of ["getTools", "isEnabled", "resendEnabled", "count", "logLine"]) {
    if (typeof d[name] !== "function") return { ok: false, reason: `DEPS_${name}` };
  }

  const wrapped = function livingNewEdenCapsuleSweepBoard(session, shipID) {
    if (safeCall(d.isEnabled) !== true) return original.apply(this, arguments);
    const pre = takePre(session, shipID, d);
    if (pre === null) return original.apply(this, arguments);
    let result;
    try {
      result = original.apply(this, arguments);
      return result;
    } finally {
      afterBoard(pre, session, result, d);
    }
  };
  Object.defineProperty(wrapped, SWEEP_MARK, { value: true });
  return { ok: true, wrapped };
}

function createCapsuleSweepTools(deps) {
  const load = (key) => {
    const r = deps.requireGame(PATHS[key]);
    return r && r.ok === true && r.exports ? r.exports : null;
  };
  const has = (obj, name) => Boolean(obj) && typeof obj[name] === "function";

  function get() {
    const off = typeof deps.disabledReason === "function" ? deps.disabledReason() : null;
    if (off !== null && off !== undefined) return { ok: false, reason: UNAVAILABLE, detail: String(off) };
    const cs = load("characterState");
    const items = load("itemStore");
    const runtime = load("runtime");
    const actions = load("actions");
    const missing = [];
    if (!has(cs, "getActiveShipRecord")) missing.push("getActiveShipRecord");
    for (const name of ["findItemById", "isCapsuleTypeID", "removeInventoryItem"]) {
      if (!has(items, name)) missing.push(name);
    }
    if (!has(runtime, "getSceneForSession")) missing.push("getSceneForSession");
    if (!has(actions, "buildRemoveBallsPayload")) missing.push("buildRemoveBallsPayload");
    if (missing.length > 0) return { ok: false, reason: UNAVAILABLE, detail: missing.join(",") };
    const tools = Object.freeze({
      getActiveShipRecord: (charId) => cs.getActiveShipRecord(charId),
      findItemById: (itemId) => items.findItemById(itemId),
      isCapsuleTypeID: (typeId) => items.isCapsuleTypeID(typeId),
      removeInventoryItem: (itemId, options) => items.removeInventoryItem(itemId, options),
      getSceneForSession: (session) => runtime.getSceneForSession(session),
      buildRemoveBallsPayload: (ids) => actions.buildRemoveBallsPayload(ids),
    });
    return { ok: true, tools };
  }

  return Object.freeze({ get });
}

function createLogLimiter(log, intervalMsOf, nowMs) {
  let last = null;
  return (text) => {
    const now = nowMs();
    if (last !== null && now - last < intervalMsOf()) return false;
    last = now;
    log(text);
    return true;
  };
}

function installCapsuleSweep(exportsObject, makeWrapper) {
  try {
    if (!exportsObject || typeof exportsObject[EXPORT_NAME] !== "function") return { ok: false, reason: "EXPORT_MISSING" };
    const desc = Object.getOwnPropertyDescriptor(exportsObject, EXPORT_NAME);
    if (Object.isFrozen(exportsObject) || !desc || (!desc.writable && typeof desc.set !== "function")) {
      return { ok: false, reason: "SEAM_NOT_WRITABLE" };
    }
    const wrap = makeWrapper(exportsObject[EXPORT_NAME]);
    if (!wrap || wrap.ok !== true || typeof wrap.wrapped !== "function") {
      return { ok: false, reason: (wrap && wrap.reason) || "WRAP_INVALID" };
    }
    if (wrap.noop === true) return { ok: true, alreadyInstalled: true };
    exportsObject[EXPORT_NAME] = wrap.wrapped;
    return { ok: true, alreadyInstalled: false };
  } catch (err) {
    return { ok: false, reason: `INSTALL_FAILED: ${String((err && err.message) || err).slice(0, 120)}` };
  }
}

module.exports = {
  PATHS,
  EXPORT_NAME,
  COUNTER_NAMES,
  wrapBoardForCapsuleSweep,
  afterBoard,
  createCapsuleSweepTools,
  createLogLimiter,
  installCapsuleSweep,
};
