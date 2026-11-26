"use strict";

const { createRng } = require("../../util/rng");
const C = require("./common");

const KIND = "INVASION_SURGE";
const VERSION = 1;
const WEIGHT = 100;
const REF_PREFIX = "inv:";

function createInvasionSurge(deps) {
  const P = deps.points;
  const invaders = [...new Set((deps.invaderFactionIds || []).filter(C.isId))].sort((a, b) => a - b);

  function propose(tx, q) {
    const active = C.activeFactionsInTx(tx, invaders);
    const ids = C.withoutLast(active, q && q.last);
    if (ids.length === 0) return { ok: false, reason: "NO_FACTION" };
    const factionId = ids[createRng(q.seed).nextInt(0, ids.length - 1)];
    return { ok: true, crisis: { factionId, regionIds: [], params: {} } };
  }

  function refKeysOf(entries) {
    const keys = new Set();
    for (const e of entries) {
      if (e && e.eventType === C.INVASION_ENDED && e.aggregateType === C.INVASION_AGGREGATE
        && typeof e.aggregateId === "string" && e.aggregateId !== "") keys.add(`${REF_PREFIX}${e.aggregateId}`);
    }
    return [...keys];
  }

  function readRefsInTx(tx, keys) {
    const out = new Map();
    const ids = keys.filter((k) => k.startsWith(REF_PREFIX)).map((k) => k.slice(REF_PREFIX.length));
    if (ids.length === 0) return out;
    const rows = tx.prepare(`SELECT invasion_id, faction_id, end_reason FROM world_invasions
      WHERE invasion_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
    for (const r of rows) {
      out.set(`${REF_PREFIX}${r.invasion_id}`, { factionId: Number(r.faction_id), endReason: r.end_reason });
    }
    return out;
  }

  function scoreEntries(entries, s) {
    const F = s && s.crisis ? s.crisis.factionId : null;
    const refs = s && s.refs instanceof Map ? s.refs : new Map();
    let defense = 0;
    let crisis = 0;
    if (!C.isId(F)) return { defense, crisis };
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      const p = e.payload && typeof e.payload === "object" ? e.payload : null;
      if (e.eventType === C.INVASION_SPAWNED && e.aggregateType === C.INVASION_AGGREGATE) {
        if (p && p.factionId === F) crisis += P.invasionSpawnPoints;
      } else if (e.eventType === C.INVASION_ENDED && e.aggregateType === C.INVASION_AGGREGATE) {
        const ref = refs.get(`${REF_PREFIX}${e.aggregateId}`);
        if (ref && ref.factionId === F && ref.endReason === C.BEACHHEAD_LOST) defense += P.invasionRepelPoints;
      } else if (e.eventType === C.BATTLE_SETTLED && e.aggregateType === C.BATTLE_AGGREGATE) {
        const d = C.battleDeltaOf(p, F, P.battlePoints);
        defense += d.defense;
        crisis += d.crisis;
      }
    }
    return { defense, crisis };
  }

  return Object.freeze({ kind: KIND, owner: C.OWNER, version: VERSION, weight: WEIGHT,
    journalAggregates: [C.INVASION_AGGREGATE, C.BATTLE_AGGREGATE], propose, scoreEntries, refKeysOf, readRefsInTx });
}

module.exports = { createInvasionSurge, KIND };
