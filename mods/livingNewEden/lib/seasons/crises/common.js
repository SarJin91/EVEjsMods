"use strict";

const BATTLE_AGGREGATE = "battle";
const INVASION_AGGREGATE = "invasion";
const BATTLE_SETTLED = "BATTLE_SETTLED";
const INVASION_SPAWNED = "INVASION_SPAWNED";
const INVASION_ENDED = "INVASION_ENDED";
const BEACHHEAD_LOST = "BEACHHEAD_LOST";
const OWNER = "seasons";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function battleDeltaOf(p, factionId, points) {
  const none = { defense: 0, crisis: 0 };
  if (!p || typeof p !== "object" || !p.sideA || !p.sideB) return none;
  const a = p.sideA.factionId;
  const b = p.sideB.factionId;
  if (!isId(factionId) || (a !== factionId && b !== factionId)) return none;
  let winner = null;
  if (p.outcome === "A_WIN") winner = a;
  else if (p.outcome === "B_WIN") winner = b;
  if (winner === null) return none;
  return winner === factionId ? { defense: 0, crisis: points } : { defense: points, crisis: 0 };
}

function weightedPick(items, rng) {
  const total = items.reduce((s, it) => s + it.weight, 0);
  if (items.length === 0 || total <= 0) return null;
  let r = rng.nextInt(0, total - 1);
  for (const it of items) {
    if (r < it.weight) return it;
    r -= it.weight;
  }
  return items[items.length - 1];
}

function withoutLast(ids, last) {
  const lastId = last && isId(last.factionId) ? last.factionId : null;
  if (lastId === null || !ids.includes(lastId) || ids.length < 2) return ids;
  return ids.filter((id) => id !== lastId);
}

function activeFactionsInTx(tx, ids) {
  if (ids.length === 0) return [];
  return tx.prepare(`SELECT faction_id FROM world_factions WHERE faction_id IN (SELECT value FROM json_each(?))
    AND status = 'ACTIVE' ORDER BY faction_id`).all(JSON.stringify(ids)).map((r) => Number(r.faction_id));
}

module.exports = { BATTLE_AGGREGATE, INVASION_AGGREGATE, BATTLE_SETTLED, INVASION_SPAWNED, INVASION_ENDED,
  BEACHHEAD_LOST, OWNER, isId, battleDeltaOf, weightedPick, withoutLast, activeFactionsInTx };
