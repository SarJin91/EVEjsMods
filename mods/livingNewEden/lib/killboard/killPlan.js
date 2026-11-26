"use strict";

const { PLAYER_OWNER_MIN_ID, MAX_ISK_TOTAL } = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const idOrNull = (v) => (isId(v) ? v : null);

function classifyKill(fact, opts) {
  if (!isObject(fact) || !isId(fact.killId) || !isTime(fact.killAtMs) || !isObject(fact.victim)) {
    return { decision: "INVALID" };
  }
  const o = opts || {};
  const v = fact.victim;
  const charId = idOrNull(v.characterId);
  const corpId = idOrNull(v.corporationId);
  let lne = false;
  if (charId === null && corpId !== null && typeof o.isLneNpcCorporation === "function") {
    try {
      lne = o.isLneNpcCorporation(corpId) === true;
    } catch (_err) {
      lne = false;
    }
  }
  if (lne) return { decision: "SKIP_LNE_NPC" };
  const owner = charId !== null || (corpId !== null && corpId >= PLAYER_OWNER_MIN_ID);
  const players = Array.isArray(fact.attackerCharacterIds) ? fact.attackerCharacterIds.filter(isId) : [];
  let cls = "PVP";
  if (!owner) {
    if (o.includeNpcVictims !== true || players.length === 0) return { decision: "SKIP_NPC" };
    cls = "PVE";
  }
  if (Number.isSafeInteger(o.killBackfillMs) && o.killBackfillMs > 0 && isTime(o.nowMs)
    && fact.killAtMs < o.nowMs - o.killBackfillMs) {
    return { decision: "SKIP_OLD" };
  }
  return { decision: "ACCEPT", cls };
}

function attackerRow(a) {
  const x = isObject(a) ? a : {};
  return [idOrNull(x.characterId), idOrNull(x.corporationId), idOrNull(x.allianceId), idOrNull(x.factionId),
    idOrNull(x.shipTypeId), Number.isSafeInteger(x.damageDone) && x.damageDone >= 0 ? x.damageDone : 0];
}

function planKill(fact, opts) {
  if (!isObject(fact) || !isId(fact.killId)) return { ok: false, reason: "PLAN_INVALID", detail: "killId" };
  if (!isTime(fact.killAtMs)) return { ok: false, reason: "PLAN_INVALID", detail: "killAtMs" };
  if (!isObject(fact.victim)) return { ok: false, reason: "PLAN_INVALID", detail: "victim" };
  const o = opts || {};
  if (o.cls !== "PVP" && o.cls !== "PVE") return { ok: false, reason: "PLAN_INVALID", detail: "cls" };
  const max = Number.isSafeInteger(o.maxAttackers) && o.maxAttackers > 0 ? o.maxAttackers : 1;
  const v = fact.victim;
  const raw = typeof fact.iskLost === "number" && Number.isFinite(fact.iskLost) && fact.iskLost >= 0
    ? Math.round(fact.iskLost) : 0;
  const isk = Number.isSafeInteger(raw) ? Math.min(raw, MAX_ISK_TOTAL) : MAX_ISK_TOTAL;
  const attackers = (Array.isArray(fact.attackers) ? fact.attackers : []).slice(0, max).map(attackerRow);
  const victimChar = idOrNull(v.characterId);
  const finalChar = idOrNull(fact.finalCharacterId);
  const row = Object.freeze({ killId: fact.killId, killAt: fact.killAtMs, systemId: idOrNull(fact.systemId),
    victimCharacterId: victimChar, victimCorporationId: idOrNull(v.corporationId),
    victimAllianceId: idOrNull(v.allianceId), victimFactionId: idOrNull(v.factionId),
    shipTypeId: idOrNull(v.shipTypeId), iskLost: isk, finalCharacterId: finalChar,
    finalCorporationId: idOrNull(fact.finalCorporationId),
    attackerCount: Number.isSafeInteger(fact.attackerCount) && fact.attackerCount >= 0 ? fact.attackerCount
      : attackers.length,
    attackersJson: JSON.stringify(attackers), cls: o.cls });
  const chars = [];
  const deltas = [];
  if (victimChar !== null) {
    chars.push(Object.freeze({ characterId: victimChar, role: "V" }));
    deltas.push(Object.freeze({ characterId: victimChar, kills: 0, losses: 1, iskKilled: 0, iskLost: isk }));
  }
  const seen = new Set(victimChar === null ? [] : [victimChar]);
  for (const id of Array.isArray(fact.attackerCharacterIds) ? fact.attackerCharacterIds : []) {
    if (!isId(id) || seen.has(id)) continue;
    seen.add(id);
    chars.push(Object.freeze({ characterId: id, role: id === finalChar ? "F" : "A" }));
    deltas.push(Object.freeze({ characterId: id, kills: 1, losses: 0, iskKilled: isk, iskLost: 0 }));
  }
  const uniq = (list) => [...new Set(list.filter(isId))].sort((a, b) => a - b);
  const names = Object.freeze({
    char: uniq([...seen, ...attackers.map((a) => a[0])]),
    corp: uniq([row.victimCorporationId, row.finalCorporationId, ...attackers.map((a) => a[1])]),
    alliance: uniq([row.victimAllianceId, ...attackers.map((a) => a[2])]),
  });
  const typeIds = uniq([row.shipTypeId, ...attackers.map((a) => a[4])]);
  return { ok: true, row, chars: Object.freeze(chars), deltas: Object.freeze(deltas), names, typeIds };
}

module.exports = { classifyKill, planKill };
