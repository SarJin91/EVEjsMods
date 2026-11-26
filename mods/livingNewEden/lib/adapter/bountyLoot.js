"use strict";

const MAX_DETAIL = 120;
const MAX_ITEMS = 8;
const OFFICER_LOOT_TABLES = Object.freeze({
  500010: "parity_guristas_officer", 500011: "parity_angel_officer", 500019: "parity_sansha_officer",
  500020: "parity_serpentis_officer",
});

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function rollOfficerLootFrom(npcData, npcLoot, factionId, seed) {
  if (!isId(factionId) || !Number.isSafeInteger(seed)) return { ok: false, reason: "INVALID_INPUT" };
  const tableId = OFFICER_LOOT_TABLES[factionId];
  if (!tableId) return { ok: true, items: [], skipped: 0 };
  if (!npcData || typeof npcData.getNpcLootTable !== "function" || !npcLoot
    || typeof npcLoot.rollNpcLootEntries !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  try {
    const table = npcData.getNpcLootTable(tableId);
    if (!table || typeof table !== "object") return { ok: false, reason: "NO_TABLE", detail: tableId };
    const entries = npcLoot.rollNpcLootEntries(table, { source: { seed } });
    const byType = new Map();
    let skipped = 0;
    for (const e of Array.isArray(entries) ? entries : []) {
      const typeId = Math.trunc(Number(e && e.typeID));
      const quantity = Math.trunc(Number(e && e.quantity));
      if (!isId(typeId) || !isId(quantity) || Number(e.singleton) === 2) {
        skipped += 1;
        continue;
      }
      byType.set(typeId, (byType.get(typeId) || 0) + quantity);
    }
    const items = [...byType].sort((a, b) => a[0] - b[0]).slice(0, MAX_ITEMS)
      .map(([typeId, quantity]) => ({ typeId, quantity }));
    return { ok: true, items, skipped: skipped + Math.max(0, byType.size - MAX_ITEMS) };
  } catch (err) {
    return { ok: false, reason: "ROLL_FAILED", detail: messageOf(err) };
  }
}

module.exports = { rollOfficerLootFrom, OFFICER_LOOT_TABLES };
