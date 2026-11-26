"use strict";

const { relationOf } = require("../playerHunt/policy");

const RELATIONS = Object.freeze(["hostile", "neutral", "friendly"]);
const NEUTRAL = "neutral";
const HOSTILE = "hostile";

function combineRelations(perPlayer, primaryCharacterId) {
  const known = (Array.isArray(perPlayer) ? perPlayer : [])
    .filter((p) => p && RELATIONS.includes(p.relation));
  if (known.length === 0) return null;
  const first = known[0].relation;
  if (known.every((p) => p.relation === first)) return first;
  if (Number.isSafeInteger(primaryCharacterId)) {
    const primary = known.find((p) => p.characterId === primaryCharacterId);
    if (primary) return primary.relation;
  }
  return NEUTRAL;
}

const minOf = (ids) => ids.reduce((m, id) => (id < m ? id : m), Infinity);

function createRelationPainter(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const bump = typeof d.bump === "function" ? d.bump : () => {};
  const maxReads = Number.isSafeInteger(d.maxStandingReadsPerPass) && d.maxStandingReadsPerPass >= 0
    ? d.maxStandingReadsPerPass : 0;
  const maxRepaints = Number.isSafeInteger(d.maxRepaintsPerPass) && d.maxRepaintsPerPass >= 0
    ? d.maxRepaintsPerPass : 0;
  const policy = d.neutralPolicy && typeof d.neutralPolicy === "object" ? d.neutralPolicy : {};

  const safeBump = (name, n) => {
    if (!(n > 0)) return;
    try {
      bump(name, n);
    } catch (_err) {
    }
  };

  function kindOf(factionId) {
    try {
      const kind = typeof d.getFactionKind === "function" ? d.getFactionKind(factionId) : null;
      return typeof kind === "string" && kind !== "" ? kind : null;
    } catch (_err) {
      return null;
    }
  }

  function normalize(groups) {
    const list = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || !Number.isSafeInteger(g.systemId) || g.systemId <= 0 || !Number.isSafeInteger(g.factionId)
        || !Array.isArray(g.entityIds)) continue;
      const entityIds = g.entityIds.filter((id) => Number.isSafeInteger(id) && id > 0);
      if (entityIds.length === 0) continue;
      list.push({ systemId: g.systemId, factionId: g.factionId, entityIds,
        aggressors: g.aggressors instanceof Set ? g.aggressors : null,
        primaryCharacterId: Number.isSafeInteger(g.primaryCharacterId) ? g.primaryCharacterId : null,
        forced: g.forced === HOSTILE ? HOSTILE : null, min: minOf(entityIds) });
    }
    list.sort((a, b) => a.systemId - b.systemId || a.factionId - b.factionId || a.min - b.min);
    return list;
  }

  function paint(groups) {
    const res = { groups: 0, repainted: 0, unchanged: 0, unknown: 0, failed: 0, deferred: 0 };
    let list;
    try {
      list = normalize(groups);
    } catch (_err) {
      res.failed += 1;
      safeBump("relationFailed", 1);
      return res;
    }
    res.groups = list.length;
    const ships = new Map();
    const standing = new Map();
    let reads = 0;
    let repaintsLeft = maxRepaints;

    const shipsOf = (systemId) => {
      if (ships.has(systemId)) return ships.get(systemId);
      let r;
      try {
        r = d.readPlayerShips(systemId);
      } catch (_err) {
        r = null;
      }
      const value = r && r.ok === true && Array.isArray(r.ships) ? r.ships : null;
      ships.set(systemId, value);
      return value;
    };

    const standingOf = (characterId, factionId) => {
      const key = `${characterId}:${factionId}`;
      if (standing.has(key)) return standing.get(key);
      if (reads >= maxReads) return null;
      reads += 1;
      const r = d.readStanding(characterId, factionId);
      const value = r && r.ok === true && typeof r.standing === "number" && Number.isFinite(r.standing)
        ? r.standing : null;
      standing.set(key, value);
      return value;
    };

    for (const g of list) {
      try {
        let relation;
        if (g.forced !== null) relation = g.forced;
        else {
          const players = shipsOf(g.systemId);
          if (players === null || players.length === 0) {
            res.unknown += 1;
            continue;
          }
          const kind = kindOf(g.factionId);
          const perPlayer = [];
          for (const p of players) {
            if (!p || !Number.isSafeInteger(p.characterId)) continue;
            if (g.aggressors !== null && g.aggressors.has(p.entityId)) {
              perPlayer.push({ characterId: p.characterId, relation: HOSTILE });
              continue;
            }
            perPlayer.push({ characterId: p.characterId,
              relation: relationOf(standingOf(p.characterId, g.factionId), kind, d.thresholds, policy) });
          }
          relation = combineRelations(perPlayer, g.primaryCharacterId);
        }
        if (relation === null) {
          res.unknown += 1;
          continue;
        }
        let offset = 0;
        while (offset < g.entityIds.length && repaintsLeft > 0) {
          const ids = g.entityIds.slice(offset, offset + repaintsLeft);
          offset += ids.length;
          const r = d.setRelation(g.systemId, ids, relation);
          if (!r || r.ok !== true) {
            res.failed += 1;
            break;
          }
          const changed = Number.isSafeInteger(r.changed) && r.changed > 0 ? r.changed : 0;
          res.repainted += changed;
          res.unchanged += Number.isSafeInteger(r.unchanged) && r.unchanged > 0 ? r.unchanged : 0;
          repaintsLeft -= changed;
        }
        if (offset < g.entityIds.length && repaintsLeft <= 0) res.deferred += g.entityIds.length - offset;
      } catch (_err) {
        res.failed += 1;
      }
    }
    safeBump("relationRepainted", res.repainted);
    safeBump("relationUnchanged", res.unchanged);
    safeBump("relationUnknown", res.unknown);
    safeBump("relationFailed", res.failed);
    safeBump("relationDeferred", res.deferred);
    return res;
  }

  return Object.freeze({ paint });
}

module.exports = { createRelationPainter, combineRelations, RELATIONS };
