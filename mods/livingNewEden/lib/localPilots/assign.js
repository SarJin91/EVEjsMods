"use strict";

function ascending(a, b) {
  return a - b;
}

function assignPilots(input) {
  const demand = Array.isArray(input && input.demand) ? input.demand : [];
  const byCorp = input && input.pool && input.pool.byCorp instanceof Map ? input.pool.byCorp : new Map();
  const byFaction = input && input.pool && input.pool.byFaction instanceof Map ? input.pool.byFaction : new Map();
  const previous = input && input.previous instanceof Map ? input.previous : new Map();
  const maxPerSystem = Math.max(0, Math.floor(Number(input && input.maxPilotsPerSystem) || 0));

  const prevByKey = new Map();
  for (const [characterId, at] of previous) {
    if (!at) continue;
    const key = `${at.systemId}|${at.poolKey}`;
    const list = prevByKey.get(key);
    if (list) list.push(characterId);
    else prevByKey.set(key, [characterId]);
  }
  for (const list of prevByKey.values()) list.sort(ascending);

  const slots = [];
  for (const sys of demand) {
    let room = maxPerSystem;
    for (const p of sys.pools || []) {
      const want = Math.max(0, Math.min(p.wanted, room));
      room -= want;
      const corpList = p.corporationId ? byCorp.get(p.corporationId) || [] : [];
      const factionList = byFaction.get(p.factionId) || [];
      slots.push({ systemId: sys.systemId, poolKey: p.poolKey, want, corpList, factionList, got: [] });
    }
  }

  const assignment = new Map();
  const take = (slot, characterId) => {
    assignment.set(characterId, { systemId: slot.systemId, poolKey: slot.poolKey });
    slot.got.push(characterId);
  };
  for (const slot of slots) {
    if (slot.want === 0) continue;
    const prev = prevByKey.get(`${slot.systemId}|${slot.poolKey}`);
    if (!prev) continue;
    const inPool = new Set([...slot.corpList, ...slot.factionList]);
    for (const characterId of prev) {
      if (slot.got.length >= slot.want) break;
      if (inPool.has(characterId) && !assignment.has(characterId)) take(slot, characterId);
    }
  }
  let shortfall = 0;
  for (const slot of slots) {
    for (const list of [slot.corpList, slot.factionList]) {
      for (const characterId of list) {
        if (slot.got.length >= slot.want) break;
        if (!assignment.has(characterId)) take(slot, characterId);
      }
    }
    shortfall += slot.want - slot.got.length;
  }

  const bySystem = new Map();
  for (const slot of slots) {
    if (slot.got.length === 0) continue;
    const list = bySystem.get(slot.systemId);
    if (list) list.push(...slot.got);
    else bySystem.set(slot.systemId, [...slot.got]);
  }
  for (const list of bySystem.values()) list.sort(ascending);
  return { bySystem, assignment, shortfall };
}

module.exports = { assignPilots };
