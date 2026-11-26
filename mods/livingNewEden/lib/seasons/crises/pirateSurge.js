"use strict";

const { createRng } = require("../../util/rng");
const C = require("./common");

const KIND = "PIRATE_SURGE";
const VERSION = 1;
const WEIGHT = 100;
const PIRATE = "pirate";

function createPirateSurge(deps) {
  const P = deps.points;
  const kindOf = typeof deps.factionKindOf === "function" ? deps.factionKindOf : () => null;
  const regionOf = typeof deps.regionOf === "function" ? deps.regionOf : () => null;

  function propose(tx, q) {
    const rows = tx.prepare(`SELECT controller_faction_id AS f, system_id FROM world_system_state
      WHERE controller_faction_id IS NOT NULL`).all();
    const systems = new Map();
    for (const r of rows) {
      const f = Number(r.f);
      if (!systems.has(f)) systems.set(f, []);
      systems.get(f).push(Number(r.system_id));
    }
    const pirates = [...systems.keys()].filter((f) => kindOf(f) === PIRATE).sort((a, b) => a - b);
    const ids = C.withoutLast(C.activeFactionsInTx(tx, pirates), q && q.last);
    if (ids.length === 0) return { ok: false, reason: "NO_FACTION" };
    const picked = C.weightedPick(ids.map((id) => ({ id, weight: systems.get(id).length })), createRng(q.seed));
    if (!picked) return { ok: false, reason: "NO_FACTION" };
    const perRegion = new Map();
    for (const systemId of systems.get(picked.id)) {
      const r = regionOf(systemId);
      if (C.isId(r)) perRegion.set(r, (perRegion.get(r) || 0) + 1);
    }
    const regionIds = [...perRegion.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, deps.maxCrisisRegions).map(([r]) => r);
    return { ok: true, crisis: { factionId: picked.id, regionIds, params: {} } };
  }

  function scoreEntries(entries, s) {
    const F = s && s.crisis ? s.crisis.factionId : null;
    const regions = new Set(s && s.crisis && Array.isArray(s.crisis.regionIds) ? s.crisis.regionIds : []);
    const regionOfEntry = s && typeof s.regionOf === "function" ? s.regionOf : regionOf;
    let defense = 0;
    let crisis = 0;
    if (!C.isId(F)) return { defense, crisis };
    for (const e of entries) {
      if (!e || e.eventType !== C.BATTLE_SETTLED || e.aggregateType !== C.BATTLE_AGGREGATE) continue;
      const p = e.payload && typeof e.payload === "object" ? e.payload : null;
      if (!p || (regions.size > 0 && !regions.has(regionOfEntry(p.systemId)))) continue;
      const d = C.battleDeltaOf(p, F, P.battlePoints);
      defense += d.defense;
      crisis += d.crisis;
    }
    return { defense, crisis };
  }

  return Object.freeze({ kind: KIND, owner: C.OWNER, version: VERSION, weight: WEIGHT,
    journalAggregates: [C.BATTLE_AGGREGATE], propose, scoreEntries });
}

module.exports = { createPirateSurge, KIND };
