"use strict";

const { INITIAL_FACTION_STATUS } = require("./schema");
const { createAbortSentinel } = require("../persistence/store");

const SEED_KEY_PREFIX = "strategy:faction:seed:v1:";
const ROWS_PER_FACTION = 2;
const SEED_REFUSED = createAbortSentinel("strategy.seed.refused");

const seedKey = (factionId) => `${SEED_KEY_PREFIX}${factionId}`;

function scaled(units, factor, cap) {
  return Math.min(cap, Math.floor(units * factor));
}

function runFactionSeed(deps) {
  try {
    const { store, repository, registry, clock, settings } = deps;
    const factions = registry.listActiveFactions();
    if (factions.length * ROWS_PER_FACTION > settings.maxRowsPerTransaction) {
      return { ok: false, reason: "SEED_ROWS_LIMIT",
        detail: `factions=${factions.length} rows=${factions.length * ROWS_PER_FACTION} `
          + `limit=${settings.maxRowsPerTransaction}` };
    }
    const now = clock.now();
    const out = { created: 0, existing: 0, orphans: 0, failed: 0, failedIds: [] };
    let refusal = null;
    const tx = store.transaction("strategy.seed", (db) => {
      const listed = repository.listFactions(db);
      if (!listed.ok) {
        refusal = listed;
        throw SEED_REFUSED;
      }
      const present = new Set(listed.records.map((r) => r.factionId));
      for (const record of listed.records) if (!registry.getFaction(record.factionId)) out.orphans += 1;
      for (const faction of factions) {
        if (present.has(faction.factionId)) {
          out.existing += 1;
          continue;
        }
        const r = repository.createFaction(db, {
          factionId: faction.factionId,
          status: INITIAL_FACTION_STATUS,
          homeSystemId: faction.hqSystemId,
          doctrineId: faction.doctrineId,
          resourceUnits: scaled(faction.initialResourceUnits, settings.budgetFactor, settings.maxResourceUnits),
          reserveUnits: scaled(faction.initialReserveUnits, settings.budgetFactor, settings.maxResourceUnits),
          frontLimit: Math.min(faction.maxActiveFronts, settings.maxActiveFrontsPerFaction),
          registryVersion: settings.registryVersion,
          createdAt: now,
          updatedAt: now,
        }, seedKey(faction.factionId));
        if (r.ok && r.duplicate && r.record === null) {
          out.failed += 1;
          out.failedIds.push(faction.factionId);
        } else if (r.ok && r.duplicate) out.existing += 1;
        else if (r.ok) out.created += 1;
        else if (r.reason === "FACTION_EXISTS") out.existing += 1;
        else if (r.reason === "IDEMPOTENCY_CONFLICT") {
          out.failed += 1;
          out.failedIds.push(faction.factionId);
        }
        else {
          refusal = { ...r, detail: `faction ${faction.factionId}${r.detail ? ` ${r.detail}` : ""}` };
          throw SEED_REFUSED;
        }
      }
      return true;
    });
    if (!tx.ok) {
      if (tx.reason === "TX_ABORTED" && tx.error === SEED_REFUSED && refusal) {
        return { ok: false, reason: String(refusal.reason || "SEED_REFUSED"),
          ...(refusal.detail ? { detail: String(refusal.detail) } : {}) };
      }
      return { ok: false, reason: String(tx.reason || "TX_FAILED"),
        ...(tx.detail ? { detail: String(tx.detail) } : {}) };
    }
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, reason: "SEED_THREW", detail: String((err && err.message) || err) };
  }
}

module.exports = { runFactionSeed, seedKey, SEED_KEY_PREFIX };
