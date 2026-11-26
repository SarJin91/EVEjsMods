"use strict";

const MAX_DETAIL = 120;
const MINING_MARK = Symbol.for("lne.shipAi.mining");
const SITE_MARK = Symbol.for("lne.shipAi.siteCleared");

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function toInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
}

function textOf(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : null;
}

function miningStopOf(out) {
  if (!out || typeof out !== "object") return null;
  const reason = out.success === false ? out.stopReason : (out.data ? out.data.stopReason : null);
  return reason === "cargo" || reason === "ammo" ? reason : null;
}

function sessionsOf(scene) {
  if (!scene || !scene.sessions) return [];
  if (scene.sessions instanceof Map) return Array.from(scene.sessions.values());
  if (Array.isArray(scene.sessions)) return scene.sessions;
  if (typeof scene.sessions === "object") return Object.values(scene.sessions);
  return [];
}

function shipOf(scene, session) {
  if (typeof scene.getShipEntityForSession === "function") return scene.getShipEntityForSession(session);
  const shipId = toInt(session.shipID || session.shipid);
  return shipId > 0 && typeof scene.getEntityByID === "function" ? scene.getEntityByID(shipId) : null;
}

function createChainHook(spec) {
  const { target, name, mark, makeWrapper, ready } = spec;
  const counts = spec.counts;
  const state = { installed: false, active: false, original: null, wrapper: null };

  function install() {
    if (state.installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!target || typeof target !== "object" || typeof target[name] !== "function" || !ready()) {
      return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    }
    if (target[name][mark] === true) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const base = target[name];
    const wrapper = makeWrapper(base, () => state.active);
    for (const symbol of Object.getOwnPropertySymbols(base)) {
      if (symbol !== mark) wrapper[symbol] = base[symbol];
    }
    wrapper[mark] = true;
    try {
      target[name] = wrapper;
    } catch (_err) {
    }
    if (target[name] !== wrapper) return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    state.original = base;
    state.wrapper = wrapper;
    state.installed = true;
    state.active = true;
    return { ok: true };
  }

  function uninstall() {
    state.active = false;
    if (state.installed && target && target[name] === state.wrapper) target[name] = state.original;
    state.installed = false;
  }

  return Object.freeze({ install, uninstall, stats: () => ({ ...counts }) });
}

function createMiningStopHook(deps) {
  const d = deps || {};
  const counts = { events: 0, consumerErrors: 0 };
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : null;
  let loggedError = false;

  function emit(scene, entity, reason, options) {
    try {
      if (options && options.partialCycle === true) return;
      if (!entity || entity.kind !== "ship") return;
      const cid = toInt(entity.session && entity.session.characterID);
      if (cid <= 0 || toInt(entity.characterID) !== cid || d.isWatched(cid) !== true) return;
      counts.events += 1;
      d.onStop({ type: "mining", characterId: cid, shipId: toInt(entity.itemID), reason,
        systemId: toInt(scene && scene.systemID), atMs: d.now() });
    } catch (err) {
      counts.consumerErrors += 1;
      if (!loggedError && logger) {
        loggedError = true;
        try {
          logger.log(`shipAi mining hook: consumer failed - ${messageOf(err)}`);
        } catch (_e) {
        }
      }
    }
  }

  return createChainHook({ target: d.miningExports, name: "executeMiningCycle", mark: MINING_MARK, counts,
    ready: () => typeof d.onStop === "function" && typeof d.isWatched === "function" && typeof d.now === "function",
    makeWrapper: (base, isActive) => function lneShipAiMining(scene, entity, effectState, cycleBoundaryMs, options) {
      const out = base.apply(this, arguments);
      if (!isActive() || !out) return out;
      const reason = out.success === false ? out.stopReason : (out.data ? out.data.stopReason : null);
      if (reason !== "cargo" && reason !== "ammo") return out;
      emit(scene, entity, reason, options);
      return out;
    } });
}

function createSiteClearedHook(deps) {
  const d = deps || {};
  const counts = { events: 0, consumerErrors: 0, truncated: 0 };
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : null;
  const scanMax = Number.isSafeInteger(d.scanMax) && d.scanMax > 0 ? d.scanMax : 1;
  let loggedError = false;

  function emit(scene, instanceOrID) {
    try {
      const instance = instanceOrID && typeof instanceOrID === "object" ? instanceOrID : null;
      const instanceId = instance ? toInt(instance.instanceID) : toInt(instanceOrID);
      if (instanceId <= 0 || !scene) return;
      const meta = instance && instance.metadata && typeof instance.metadata === "object" ? instance.metadata : null;
      const factionId = instance ? toInt(instance.factionID || (meta && meta.factionID)) : 0;
      const systemId = toInt(scene.systemID) || (instance ? toInt(instance.solarSystemID) : 0);
      const sessions = sessionsOf(scene);
      if (sessions.length > scanMax) counts.truncated += 1;
      const n = Math.min(sessions.length, scanMax);
      for (let i = 0; i < n; i += 1) {
        const session = sessions[i];
        const cid = toInt(session && session.characterID);
        if (cid <= 0 || d.isWatched(cid) !== true) continue;
        const ship = shipOf(scene, session);
        if (!ship || toInt(ship.dungeonCompletedNotifiedInstanceID) !== instanceId) continue;
        counts.events += 1;
        d.onCleared({ type: "site", characterId: cid, instanceId, systemId,
          siteKind: instance ? textOf(instance.siteKind) : null, siteFamily: instance ? textOf(instance.siteFamily) : null,
          factionId: factionId > 0 ? factionId : null, atMs: d.now() });
      }
    } catch (err) {
      counts.consumerErrors += 1;
      if (!loggedError && logger) {
        loggedError = true;
        try {
          logger.log(`shipAi site hook: consumer failed - ${messageOf(err)}`);
        } catch (_e) {
        }
      }
    }
  }

  return createChainHook({ target: d.trackingExports, name: "notifyDungeonCompletedForScene", mark: SITE_MARK, counts,
    ready: () => typeof d.onCleared === "function" && typeof d.isWatched === "function"
      && typeof d.now === "function",
    makeWrapper: (base, isActive) => function lneShipAiSiteCleared(scene, instanceOrID) {
      const out = base.apply(this, arguments);
      if (isActive() && out > 0) emit(scene, instanceOrID);
      return out;
    } });
}

module.exports = { createMiningStopHook, createSiteClearedHook, miningStopOf, sessionsOf, MINING_MARK, SITE_MARK };
