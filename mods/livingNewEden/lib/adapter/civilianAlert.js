"use strict";

const ALERT_COOLDOWN_MS = 60000;
const SAFE_WARP_METERS = 149597870700;
const alerts = new WeakMap();
const isCivilian = (ship) => ship?.kind === "ship" && !ship.session &&
  ship.lneCivilianOperation != null;
const alertOf = (ship) => alerts.get(ship) || null;

function evacuationPending(ship, now) {
  const alert = ship.civilianAlert;
  if (!alert?.destination) return false;
  if (ship.inWarp) return true;
  if (now - alert.at >= ALERT_COOLDOWN_MS) return false;
  const { x, y, z } = alert.destination;
  const position = ship.position;
  return !position || Math.hypot(position.x - x, position.y - y, position.z - z) > 100000;
}

function scheduleDeparture(scene, ship, alert, delay, logger) {
  setTimeout(() => {
    if (alerts.get(ship) !== alert || scene.getEntityByID(ship.itemID) !== ship ||
        Date.now() - alert.at >= ALERT_COOLDOWN_MS) return;
    if (ship.pendingWarp || ship.mode === "WARP" || ship.warpState) {
      scheduleDeparture(scene, ship, alert, 4000, logger);
      return;
    }
    if (!evacuationPending({ civilianAlert: alert, position: ship.position }, Date.now())) return;
    try {
      scene.warpDynamicEntityToPoint(ship.itemID, alert.destination, {
        forceImmediateStart: false,
        broadcastWarpStartToVisibleSessions: true,
      });
    } catch (error) {
      logger.logError("civilianAlert: evacuation order failed", error);
    }
    scheduleDeparture(scene, ship, alert, 4000, logger);
  }, delay).unref();
}

function install(damage, loadGame, logger) {
  const apply = damage.applyWeaponDamageToTarget;
  damage.applyWeaponDamageToTarget = function applyWithCivilianAlert(scene, attacker, target) {
    const now = Date.now();
    const previous = alerts.get(target);
    const candidate = scene && attacker && attacker !== target && isCivilian(target) &&
      (!previous || now - previous.at >= ALERT_COOLDOWN_MS);
    let bubble;
    if (candidate) {
      try {
        // Capture the bubble before a lethal hit removes the victim's Ball.
        bubble = scene.getGridBubbleIDForEntity(target);
      } catch (error) {
        logger.logError("civilianAlert: grid lookup failed", error);
      }
    }

    const result = apply.apply(this, arguments);
    if (bubble == null) return result;
    try {
      const { getAppliedDamageAmount } = loadGame("space/runtime/combatDamageMessages");
      if (!(getAppliedDamageAmount(result?.damageResult) > 0)) return result;
      const { canEntitiesInteractLocally } = loadGame("space/destiny/identity/interactionScope");
      const incident = { at: now, targetId: target.itemID, attackerId: attacker.itemID,
        characterId: attacker.session ? Number(attacker.pilotCharacterID || attacker.session.characterID) || null : null };
      const reports = new Map();
      const seen = new Set();
      for (const ship of [target, ...scene.getEntitiesInGridBubble(bubble)]) {
        if (seen.has(ship) || ship === attacker || !isCivilian(ship) ||
            !canEntitiesInteractLocally(target, ship)) continue;
        seen.add(ship);
        const prior = alerts.get(ship);
        if (prior && now - prior.at < ALERT_COOLDOWN_MS) continue;
        const alert = { ...incident };
        alerts.set(ship, alert);
        const corporationId = Number(ship.corporationID || ship.ownerID) || null;
        const report = reports.get(corporationId) || { ships: 0, warpOrders: 0, fleets: new Set() };
        reports.set(corporationId, report);
        report.ships += 1;
        if (ship.lneCivilianOperation) report.fleets.add(ship.lneCivilianOperation.fleetId);
        if (scene.getEntityByID(ship.itemID) !== ship || ship.pendingWarp || ship.mode === "WARP" || ship.warpState) continue;
        const position = ship.position;
        if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) continue;
        const angle = Math.random() * Math.PI * 2;
        alert.destination = { x: position.x + Math.cos(angle) * SAFE_WARP_METERS,
          y: position.y, z: position.z + Math.sin(angle) * SAFE_WARP_METERS };
        scheduleDeparture(scene, ship, alert, 400 + Math.floor(Math.random() * 2200), logger);
        report.warpOrders += 1;
      }
      for (const [corporationId, report] of reports) {
        logger.log("civilianAlert " + JSON.stringify({ ...incident, systemId: scene.systemID,
          bubbleId: bubble, corporationId, ships: report.ships, warpOrders: report.warpOrders,
          fleetIds: [...report.fleets] }));
      }
    } catch (error) {
      logger.logError("civilianAlert: evacuation failed", error);
    }
    return result;
  };
}

module.exports = { install, alertOf, evacuationPending };
