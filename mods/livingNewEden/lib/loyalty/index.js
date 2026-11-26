"use strict";

const { planDock } = require("./dockRules");

const STATE = Object.freeze({ OFF: "off", RUNNING: "running", DEGRADED: "degraded", STOPPED: "stopped" });
const COUNTER_NAMES = Object.freeze(["dockChecked", "dockDenied", "dockCapsuleExempt", "dockFailOpen",
  "dockNoController", "fameDockDenied", "fameDockFailOpen"]);
const FALLBACK_NAME = "The faction controlling this system";
const STANDING_DECIMALS = 2;
const ALLOW = Object.freeze({ deny: false });

function messageOf(err) {
  return String((err && err.message) || err);
}

function createUnavailableLoyalty(reason) {
  const why = String(reason || "unavailable");
  return Object.freeze({
    getStatus: () => ({ state: STATE.STOPPED, reason: why,
      counters: Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0])) }),
    stop() {},
  });
}

function startLoyalty(deps) {
  const config = (deps && deps.config) || {};
  const settings = config.loyalty || {};
  const ctx = (deps && deps.ctx) || {};
  const adapter = (deps && deps.adapter) || null;
  const telemetry = (deps && deps.telemetry) || null;
  const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const params = Object.freeze({ dockDenyStandingMax: settings.dockDenyStandingMax,
    dockDenyExemptCapsule: settings.dockDenyExemptCapsule === true });
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const loyaltyOn = settings.dockDenyEnabled === true;
  const fameDockOn = Boolean(config.fame && config.fame.enabled === true && config.fame.dockDenyEnabled === true);
  let state = STATE.OFF;
  let reason = null;
  let factionNames = null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`loyalty: ${line}`);
    } catch (_err) {
    }
  }

  function count(name) {
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`loyalty.${name}`, 1);
    } catch (_err) {
    }
  }

  function failOpen() {
    counters.dockFailOpen += 1;
    count("dockFailOpen");
    return ALLOW;
  }

  function failOpenFame() {
    counters.fameDockFailOpen += 1;
    count("fameDockFailOpen");
    return ALLOW;
  }

  function factionName(factionId) {
    if (factionNames === null) {
      factionNames = new Map();
      try {
        const r = adapter && typeof adapter.readFactionNames === "function" ? adapter.readFactionNames() : null;
        if (r && r.ok === true && r.names instanceof Map) factionNames = r.names;
      } catch (_err) {
      }
    }
    const name = factionNames.get(factionId);
    return typeof name === "string" && name ? name : FALLBACK_NAME;
  }

  function decide(q) {
    try {
      counters.dockChecked += 1;
      const v = loyaltyOn ? decideLoyalty(q) : ALLOW;
      if ((v && v.deny === true) || !fameDockOn) return v;
      return decideFame(q);
    } catch (_err) {
      return failOpen();
    }
  }

  function decideFame(q) {
    try {
      const fame = ctx.fame;
      if (!q || !fame || typeof fame.dockVerdict !== "function") return failOpenFame();
      const world = ctx.world;
      const controller = world && typeof world.getControllerMemo === "function" ? world.getControllerMemo(q.systemId)
        : null;
      const controllerId = controller && controller.ok === true && Number.isSafeInteger(controller.controllerFactionId)
        && controller.controllerFactionId > 0 ? controller.controllerFactionId : null;
      const stationFactionId = Number.isSafeInteger(q.stationFactionId) && q.stationFactionId > 0
        ? q.stationFactionId : null;
      const r = fame.dockVerdict({ characterId: q.characterId, factionIds: [controllerId, stationFactionId],
        isCapsule: q.isCapsule === true });
      if (!r || r.deny !== true) return ALLOW;
      counters.fameDockDenied += 1;
      count("fameDockDenied");
      log(`dock denied (fame) char=${q.characterId} station=${q.stationId} faction=${r.factionId}`);
      return { deny: true, message: String(r.message || "Docking denied.") };
    } catch (_err) {
      return failOpenFame();
    }
  }

  function decideLoyalty(q) {
    try {
      const world = ctx.world;
      if (!q || !world || typeof world.getControllerMemo !== "function") return failOpen();
      const controller = world.getControllerMemo(q.systemId);
      if (!controller || controller.ok !== true) return failOpen();
      const controllerFactionId = controller.controllerFactionId;
      const early = planDock({ controllerFactionId, standing: null, isCapsule: q.isCapsule === true }, params);
      if (early.reason === "NO_CONTROLLER") {
        counters.dockNoController += 1;
        return ALLOW;
      }
      if (early.reason === "CAPSULE") {
        counters.dockCapsuleExempt += 1;
        return ALLOW;
      }
      const read = adapter && typeof adapter.readCharacterStanding === "function"
        ? adapter.readCharacterStanding(q.characterId, controllerFactionId) : null;
      const standing = read && read.ok === true ? read.standing : null;
      const plan = planDock({ controllerFactionId, standing, isCapsule: q.isCapsule === true }, params);
      if (plan.reason === "STANDING_UNKNOWN") return failOpen();
      if (plan.deny !== true) return ALLOW;
      counters.dockDenied += 1;
      count("dockDenied");
      log(`dock denied char=${q.characterId} station=${q.stationId} faction=${plan.factionId} standing=${plan.standing}`);
      return { deny: true, message: `${factionName(plan.factionId)} controls this system and refuses docking to pilots `
        + `with standing ${params.dockDenyStandingMax} or lower (yours: ${plan.standing.toFixed(STANDING_DECIMALS)}).` };
    } catch (_err) {
      return failOpen();
    }
  }

  if (loyaltyOn || fameDockOn) {
    let installed;
    try {
      const seams = adapter && typeof adapter.dockGateSeams === "function"
        ? adapter.dockGateSeams() : { ok: false, reason: "SEAM_UNAVAILABLE", detail: "adapter" };
      installed = seams && seams.ok === true ? adapter.installDockGate({ decide, stationFaction: fameDockOn }) : seams;
    } catch (err) {
      installed = { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
    }
    if (installed && installed.ok === true) {
      state = STATE.RUNNING;
      log(`state=running`);
    } else {
      state = STATE.DEGRADED;
      reason = installed ? `${installed.reason}${installed.detail ? `:${installed.detail}` : ""}` : "no_result";
      log(`dock gate unavailable - ${reason} (docking stays the vendor's)`);
    }
  } else {
    log(`state=off`);
  }

  function stop(why) {
    if (state === STATE.STOPPED) return;
    const wasRunning = state === STATE.RUNNING;
    state = STATE.STOPPED;
    if (!wasRunning) return;
    try {
      if (adapter && typeof adapter.uninstallDockGate === "function") adapter.uninstallDockGate();
    } catch (err) {
      log(`uninstall failed (${why || "stop"}) - ${messageOf(err)}`);
    }
  }

  return { ok: true, loyalty: Object.freeze({
    getStatus: () => ({ state, reason, counters: { ...counters } }),
    stop,
    decide,
  }) };
}

module.exports = { startLoyalty, createUnavailableLoyalty, STATE };
