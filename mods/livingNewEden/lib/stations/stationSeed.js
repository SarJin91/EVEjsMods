"use strict";

const { KIND_APPLY } = require("../persistence/journal");
const { STRUCTURE_TYPE_IDS } = require("./data/structureTypes");
const { createAbortSentinel } = require("../persistence/store");

const SEED_KEY_PREFIX = "stations:seed:v1:";
const ROWS_PER_STATION = 2;
const MAX_SKIPPED_DETAIL = 32;
const LIMIT_REASONS = Object.freeze(["SYSTEM_STATION_LIMIT", "SYSTEM_FACTION_STATION_LIMIT", "FACTION_STATION_LIMIT",
  "STATION_LIMIT"]);
const SEED_REFUSED = createAbortSentinel("stations.seed.refused");

const seedKey = (stationId) => `${SEED_KEY_PREFIX}${stationId}`;

function candidatesOf(faction) {
  const upwellSeq = new Map();
  return faction.startStations.map((s) => {
    if (s.kind === "npc") return { ...s, id: `npc-${s.stationId}` };
    const k = (upwellSeq.get(s.systemId) || 0) + 1;
    upwellSeq.set(s.systemId, k);
    return { ...s, id: `upw-${faction.factionId}-${s.systemId}-${k}` };
  });
}

function stationCorporationOf(registry, faction) {
  try {
    if (registry && typeof registry.corporationFor === "function") {
      const corp = registry.corporationFor(faction.factionId, "station");
      if (corp !== null && corp !== undefined) return corp;
    }
  } catch (_err) {
  }
  return faction && faction.ownerCorporationId !== undefined ? faction.ownerCorporationId : null;
}

function knownSystem(graph, systemId) {
  try {
    if (typeof graph.hasSystem === "function") return graph.hasSystem(systemId) === true;
    return typeof graph.getSystem === "function" && graph.getSystem(systemId) !== null;
  } catch (_err) {
    return false;
  }
}

function runStationSeed(deps) {
  try {
    const { store, journal, repository, registry, graph, clock, settings } = deps;
    const perFaction = settings.startStationsPerFaction;
    if (perFaction * ROWS_PER_STATION > settings.maxRowsPerTransaction) {
      return { ok: false, reason: "SEED_ROWS_LIMIT", detail: `rows=${perFaction * ROWS_PER_STATION} `
        + `limit=${settings.maxRowsPerTransaction}` };
    }
    const out = { created: 0, existing: 0, skipped: 0, failed: 0, skippedDetail: [], failedDetail: [] };
    const factions = [...registry.listActiveFactions()].sort((a, b) => a.factionId - b.factionId);
    if (perFaction === 0) return { ok: true, ...out, npcData: "off" };

    const npcIds = [];
    for (const f of factions) for (const s of f.startStations) if (s.kind === "npc") npcIds.push(s.stationId);
    let npc = null;
    let npcData = "adapter";
    const adapter = deps.adapter || null;
    if (!adapter || typeof adapter.readNpcStations !== "function") npcData = "no_adapter";
    else if (npcIds.length > 0) {
      let r;
      try {
        r = adapter.readNpcStations(npcIds);
      } catch (err) {
        r = { ok: false, reason: String((err && err.message) || err) };
      }
      if (r && r.ok && r.stations instanceof Map) npc = r.stations;
      else npcData = String((r && r.reason) || "no_result");
    }

    const skip = (factionId, stationId, reason) => {
      out.skipped += 1;
      if (out.skippedDetail.length < MAX_SKIPPED_DETAIL) out.skippedDetail.push({ factionId, stationId, reason });
    };
    for (const faction of factions) {
      const candidates = candidatesOf(faction);
      if (candidates.length === 0) continue;
      const local = { created: 0, existing: 0, skipped: [] };
      let refusal = null;
      const tx = store.transaction("stations.seed", (db) => {
        const fresh = [];
        for (const c of candidates) {
          const seen = journal.findByKey(db, seedKey(c.id));
          if (!seen.ok) {
            refusal = seen;
            throw SEED_REFUSED;
          }
          if (seen.found && seen.entry.kind === KIND_APPLY) local.existing += 1;
          else fresh.push(c);
        }
        let seeded = local.existing;
        for (const c of fresh) {
          if (seeded >= perFaction) break;
          if (!knownSystem(graph, c.systemId)) {
            local.skipped.push([c.id, "UNKNOWN_SYSTEM"]);
            continue;
          }
          let name = null;
          let position = null;
          let typeId = c.kind === "upwell" ? STRUCTURE_TYPE_IDS[c.structureFamily] || null : null;
          if (c.kind === "npc" && npc) {
            const row = npc.get(c.stationId);
            if (!row) {
              local.skipped.push([c.id, "NPC_STATION_UNKNOWN"]);
              continue;
            }
            if (row.systemId !== c.systemId) {
              local.skipped.push([c.id, "NPC_STATION_MISMATCH"]);
              continue;
            }
            if (row.corporationId !== null && row.corporationId !== c.corporationId) {
              local.skipped.push([c.id, "NPC_STATION_CORP_MISMATCH"]);
              continue;
            }
            name = row.name;
            position = row.position;
            typeId = row.typeId;
          }
          const r = repository.createStation(db, { stationId: c.id, kind: c.kind,
            npcStationId: c.kind === "npc" ? c.stationId : null, typeId,
            structureFamily: c.kind === "upwell" ? c.structureFamily : null, systemId: c.systemId,
            ownerFactionId: faction.factionId,
            ownerCorporationId: c.kind === "npc" ? c.corporationId : stationCorporationOf(registry, faction),
            name, position, origin: "seed", at: clock.now() }, seedKey(c.id));
          if (r.ok) {
            local.created += 1;
            seeded += 1;
          } else if (LIMIT_REASONS.includes(r.reason)) {
            local.skipped.push([c.id, r.reason]);
          } else {
            refusal = { ...r, detail: `${c.id}${r.detail ? ` ${r.detail}` : ""}` };
            throw SEED_REFUSED;
          }
        }
        return true;
      });
      if (tx.ok) {
        out.created += local.created;
        out.existing += local.existing;
        for (const [id, reason] of local.skipped) skip(faction.factionId, id, reason);
      } else {
        const why = tx.reason === "TX_ABORTED" && tx.error === SEED_REFUSED && refusal ? refusal : tx;
        if (["STORE_CLOSED", "STORE_SUSPENDED"].includes(why.reason)) return { ok: false, reason: why.reason };
        out.failed += 1;
        out.failedDetail.push(`${faction.factionId}:${String(why.reason || "TX_FAILED")}`
          + `${why.detail ? ` (${String(why.detail)})` : ""}`);
      }
    }
    return { ok: true, ...out, npcData };
  } catch (err) {
    return { ok: false, reason: "SEED_THREW", detail: String((err && err.message) || err) };
  }
}

module.exports = { runStationSeed, seedKey, candidatesOf, stationCorporationOf, SEED_KEY_PREFIX };
