"use strict";

const { HUB_TYPE_ID, neutralPlayerHubOf } = require("./playerSov");

const PATHS = Object.freeze({
  itemStore: "services/inventory/itemStore",
  machoErrors: "common/machoErrors",
  sovState: "services/sovereignty/sovState",
});
const EXPORT_NAME = "deployStructureFromInventoryItem";
const GATE_MARK = Symbol.for("livingNewEden.playerSovDeployGate");
const UNAVAILABLE = "PLAYER_SOV_GATE_UNAVAILABLE";
const CORE_RESULT_TYPE = "sovereignty_core";
const NOTIFY_ERROR = "CustomNotify";

const posInt = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function readSessionSystemIdFrom(session) {
  if (!session) return null;
  return posInt((session._space && session._space.systemID) || session.solarsystemid2 || session.solarsystemid);
}

function wrapDeployForGate(original, deps) {
  if (typeof original !== "function") return { ok: false, reason: "ORIGINAL_NOT_FUNCTION" };
  if (original[GATE_MARK] === true) return { ok: true, wrapped: original, noop: true };
  const d = deps || {};
  for (const name of ["getSink", "readItemTypeId", "readSessionSystemId", "throwNotify", "readNeutralHub"]) {
    if (typeof d[name] !== "function") return { ok: false, reason: `DEPS_${name}` };
  }
  if (posInt(d.hubTypeId) === null) return { ok: false, reason: "DEPS_hubTypeId" };
  const note = (fn, name) => {
    try {
      if (typeof fn === "function") fn(name);
    } catch (_err) {
    }
  };
  const outcome = (name) => note(d.onOutcome, name);
  const error = (where) => note(d.onError, where);
  const nowOf = () => {
    const at = typeof d.nowMs === "function" ? d.nowMs() : null;
    return Number.isSafeInteger(at) && at > 0 ? at : undefined;
  };

  function plan(session, itemID) {
    try {
      if (d.readItemTypeId(itemID) !== d.hubTypeId) return { kind: "pass" };
      const systemId = d.readSessionSystemId(session);
      const sink = d.getSink();
      if (!sink || typeof sink.checkDeploy !== "function" || typeof sink.registerDeploy !== "function"
        || systemId === null) {
        error(systemId === null ? "system" : "sink");
        return { kind: "pass" };
      }
      outcome("gateChecked");
      const r = sink.checkDeploy({ systemId, at: nowOf() });
      if (r && r.ok === true) return { kind: "check", sink, systemId };
      if (r && typeof r.notify === "string" && r.notify !== "") return { kind: "refuse", notify: r.notify };
      error("check");
      return { kind: "pass" };
    } catch (_err) {
      error("plan");
      return { kind: "pass" };
    }
  }

  function register(p, result) {
    try {
      const data = result && result.data;
      if (!data || data.type !== CORE_RESULT_TYPE) return;
      const hubItemId = posInt(data.structureID);
      const systemId = posInt(data.solarSystemID) || p.systemId;
      const hub = hubItemId === null ? null : d.readNeutralHub(systemId, hubItemId);
      if (!hub) {
        error("hub");
        return;
      }
      const r = p.sink.registerDeploy({ systemId, hubItemId, allianceId: hub.allianceId, corpId: hub.corpId,
        at: nowOf() });
      if (r && r.ok === true) outcome("gateRegistered");
      else if (r && r.reason === "DUPLICATE") outcome("gateDuplicate");
      else error("register");
    } catch (_err) {
      error("register");
    }
  }

  const wrapped = function livingNewEdenPlayerSovDeployGate(session, itemID) {
    const p = plan(session, itemID);
    if (p.kind === "refuse") {
      outcome("gateRefused");
      d.throwNotify(p.notify);
      error("notify");
    }
    const result = original.apply(this, arguments);
    if (p.kind === "check") register(p, result);
    return result;
  };
  Object.defineProperty(wrapped, GATE_MARK, { value: true });
  return { ok: true, wrapped };
}

function createDeployGateTools(deps) {
  const load = (key) => {
    const off = typeof deps.disabledReason === "function" ? deps.disabledReason() : null;
    if (off !== null && off !== undefined) return null;
    const r = deps.requireGame(PATHS[key]);
    return r && r.ok === true && r.exports ? r.exports : null;
  };

  function check() {
    const missing = [];
    const items = load("itemStore");
    if (!items || typeof items.findItemById !== "function") missing.push("findItemById");
    const errors = load("machoErrors");
    if (!errors || typeof errors.throwWrappedUserError !== "function") missing.push("throwWrappedUserError");
    const sov = load("sovState");
    if (!sov || typeof sov.getSystemState !== "function") missing.push("getSystemState");
    return missing.length === 0 ? { ok: true } : { ok: false, reason: UNAVAILABLE, detail: missing.join(",") };
  }

  function readItemTypeId(itemId) {
    const items = load("itemStore");
    if (!items || typeof items.findItemById !== "function") throw new Error(UNAVAILABLE);
    const item = items.findItemById(itemId);
    return item ? posInt(item.typeID) : null;
  }

  function throwNotify(notify) {
    const errors = load("machoErrors");
    if (!errors || typeof errors.throwWrappedUserError !== "function") return;
    errors.throwWrappedUserError(NOTIFY_ERROR, { notify: String(notify) });
  }

  function readNeutralHub(systemId, hubItemId) {
    const sov = load("sovState");
    if (!sov || typeof sov.getSystemState !== "function") throw new Error(UNAVAILABLE);
    const hub = neutralPlayerHubOf(sov.getSystemState(systemId) || null, null);
    return hub && hub.itemId === hubItemId ? { allianceId: hub.allianceId, corpId: hub.corpId } : null;
  }

  return Object.freeze({ check, readItemTypeId, readSessionSystemId: readSessionSystemIdFrom, throwNotify,
    readNeutralHub });
}

function lazyToolDeps(getTools) {
  const tools = () => {
    const t = getTools();
    if (!t || typeof t.readItemTypeId !== "function") throw new Error(UNAVAILABLE);
    return t;
  };
  return {
    readItemTypeId: (itemId) => tools().readItemTypeId(itemId),
    readSessionSystemId: readSessionSystemIdFrom,
    throwNotify: (notify) => {
      let t = null;
      try {
        t = tools();
      } catch (_err) {
        return;
      }
      t.throwNotify(notify);
    },
    readNeutralHub: (systemId, hubItemId) => tools().readNeutralHub(systemId, hubItemId),
  };
}

function installDeployGate(exportsObject, makeWrap) {
  try {
    if (!exportsObject || typeof exportsObject[EXPORT_NAME] !== "function") return { ok: false, reason: "EXPORT_MISSING" };
    const desc = Object.getOwnPropertyDescriptor(exportsObject, EXPORT_NAME);
    if (Object.isFrozen(exportsObject) || !desc || (!desc.writable && typeof desc.set !== "function")) {
      return { ok: false, reason: "SEAM_NOT_WRITABLE" };
    }
    const wrap = makeWrap(exportsObject[EXPORT_NAME]);
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
  HUB_TYPE_ID,
  PATHS,
  EXPORT_NAME,
  readSessionSystemIdFrom,
  wrapDeployForGate,
  createDeployGateTools,
  lazyToolDeps,
  installDeployGate,
};
