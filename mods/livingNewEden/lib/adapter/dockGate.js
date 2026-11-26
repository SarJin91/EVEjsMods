"use strict";

const MARKER = Symbol.for("livingNewEden.dockGate");
const METHOD = "Handle_CmdDock";
const FAIL_LOG_INTERVAL_MS = 60000;
const MAX_DETAIL = 120;

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createDockGateHook(deps) {
  const serviceClass = deps && deps.serviceClass;
  const worldData = deps && deps.worldData;
  const itemStore = deps && deps.itemStore;
  const throwUserError = deps && deps.throwUserError;
  const decide = deps && deps.decide;
  const stationFactionOf = deps && typeof deps.stationFactionOf === "function" ? deps.stationFactionOf : null;
  const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = deps && typeof deps.nowMs === "function" ? deps.nowMs : () => Date.now();
  let installed = false;
  let active = false;
  let original = null;
  let wrapper = null;
  let proto = null;
  let failOpen = 0;
  let lastFailLogAt = -Infinity;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function noteFailOpen(err) {
    failOpen += 1;
    const now = nowMs();
    if (now - lastFailLogAt < FAIL_LOG_INTERVAL_MS) return;
    lastFailLogAt = now;
    log(`dock gate: read failed, dock allowed (failOpen=${failOpen}) - ${messageOf(err)}`);
  }

  function seamProblem() {
    if (typeof serviceClass !== "function" || !serviceClass.prototype
      || typeof serviceClass.prototype[METHOD] !== "function") return "beyonceService_Handle_CmdDock";
    if (!worldData || typeof worldData.getStationByID !== "function") return "worldData_getStationByID";
    if (!itemStore || typeof itemStore.findItemById !== "function"
      || typeof itemStore.isCapsuleTypeID !== "function") return "itemStore_capsule";
    if (typeof throwUserError !== "function") return "machoErrors_throwWrappedUserError";
    if (typeof decide !== "function") return "decide";
    return null;
  }

  function verdictFor(args, session) {
    const stationId = toPositiveInt(args && args[0]);
    const characterId = toPositiveInt(session && session.characterID);
    if (!stationId || !characterId) return null;
    const station = worldData.getStationByID(stationId);
    if (!station) return null;
    const space = session && session._space;
    const shipId = toPositiveInt(space && space.shipID);
    const item = shipId ? itemStore.findItemById(shipId) : null;
    const typeId = toPositiveInt(item && item.typeID) || toPositiveInt(session && session.shipTypeID);
    return decide({ characterId, stationId, systemId: toPositiveInt(station.solarSystemID),
      isCapsule: itemStore.isCapsuleTypeID(typeId) === true, stationFactionId: stationFactionIdOf(stationId) });
  }

  function stationFactionIdOf(stationId) {
    if (typeof stationFactionOf !== "function") return null;
    try {
      return toPositiveInt(stationFactionOf(stationId)) || null;
    } catch (_err) {
      return null;
    }
  }

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const problem = seamProblem();
    if (problem) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: problem };
    proto = serviceClass.prototype;
    if (proto[METHOD][MARKER] === true) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    original = proto[METHOD];
    const base = original;
    wrapper = function Handle_CmdDock(args, session, ...rest) {
      let verdict = null;
      if (active) {
        try {
          verdict = verdictFor(args, session);
        } catch (err) {
          verdict = null;
          noteFailOpen(err);
        }
      }
      if (verdict && verdict.deny === true) {
        throwUserError("DockingRequestDenied", { reason: String(verdict.message || "Docking denied.") });
      }
      return base.apply(this, [args, session, ...rest]);
    };
    Object.defineProperty(wrapper, MARKER, { value: true });
    proto[METHOD] = wrapper;
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    if (installed && proto && proto[METHOD] === wrapper) proto[METHOD] = original;
    installed = false;
  }

  return Object.freeze({ install, uninstall, isActive: () => active, getStats: () => ({ failOpen }) });
}

module.exports = { createDockGateHook, DOCK_GATE_MARKER: MARKER };
