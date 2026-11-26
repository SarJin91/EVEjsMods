"use strict";

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isTargetable(player) {
  return player.capsule !== true && player.cloaked !== true;
}

function planGroup(group, scene, standingOf, p, at) {
  const { ships, players } = scene;
  const byEntity = new Map(players.map((player) => [player.entityId, player]));
  const attacks = [];
  const seen = [];
  for (const ship of ships) {
    if (!(ship.aggressedAtMs > 0) || ship.aggressedAtMs === group.seenAggressedAt.get(ship.entityId)) continue;
    const aggressor = byEntity.get(ship.aggressorEntityId);
    if (!aggressor) continue;
    if (!attacks.includes(aggressor.characterId)) attacks.push(aggressor.characterId);
    seen.push([ship.entityId, ship.aggressedAtMs]);
  }

  const center = ships.length > 0 ? ships[0].position : null;
  const inRange = center === null ? [] : players
    .map((player) => ({ player, distance: distanceBetween(center, player.position) }))
    .filter((row) => row.distance <= p.aggroRangeMeters);
  const isHostile = ({ player }) => isTargetable(player) && (group.provoked.has(player.characterId)
    || attacks.includes(player.characterId) || standingOf(player.characterId) < p.hostileBelowStanding);
  const hostile = inRange.filter(isHostile)
    .sort((a, b) => a.distance - b.distance || a.player.characterId - b.player.characterId)
    .map((row) => row.player.entityId);

  const orders = [];
  ships.forEach((ship, i) => {
    if (hostile.length > 0) {
      if (!hostile.includes(ship.manualTargetId)) {
        orders.push({ entityId: ship.entityId, targetId: hostile[i % hostile.length] });
      }
    } else if (ship.manualTargetId > 0) {
      orders.push({ entityId: ship.entityId, targetId: 0 });
    }
  });

  return { attacks, orders, expire: at - group.spawnedAt >= p.groupTtlMs && inRange.length === 0, seen };
}

function relationOfPlan(ships, orders) {
  const ordered = new Set(orders.map((o) => o.entityId));
  const engaged = orders.some((o) => o.targetId > 0)
    || ships.some((ship) => ship.manualTargetId > 0 && !ordered.has(ship.entityId));
  return engaged ? "hostile" : "neutral";
}

module.exports = { planGroup, relationOfPlan };
