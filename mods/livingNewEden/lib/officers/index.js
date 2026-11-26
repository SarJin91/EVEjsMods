"use strict";

const { createOfficerSpawns } = require("./service");

const INT_KEYS = Object.freeze(["huntChancePermille", "salvageChancePermille", "maxPerSystemPerDay", "maxPerDay",
  "spawnDistanceMeters"]);

function createUnavailableOfficerSpawns(reason) {
  const why = String(reason || "OFFICER_SPAWNS_UNAVAILABLE");
  return Object.freeze({
    tryHunt: () => ({ ok: false, reason: why }),
    trySalvage: () => ({ ok: false, reason: why }),
    getStatus: () => Object.freeze({ state: "unavailable", reason: why }),
  });
}

function startOfficerSpawns(deps) {
  const S = deps && deps.config && deps.config.officerSpawns;
  if (!S || S.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  if (!INT_KEYS.every((k) => Number.isSafeInteger(S[k]) && S[k] >= 0)) {
    return { ok: false, reason: "OFFICER_SPAWNS_START_FAILED", detail: "settings" };
  }
  const persistence = deps.persistence;
  if (!persistence || !persistence.store || typeof persistence.store.transaction !== "function"
    || !persistence.journal || !Number.isSafeInteger(persistence.worldSeed)) {
    return { ok: false, reason: "OFFICER_SPAWNS_DEPENDENCY_UNAVAILABLE", detail: "persistence" };
  }
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : null;
  if (!clock) return { ok: false, reason: "OFFICER_SPAWNS_START_FAILED", detail: "clock" };
  try {
    const officerSpawns = createOfficerSpawns({ store: persistence.store, journal: persistence.journal, clock,
      worldSeed: persistence.worldSeed, config: S, getSeam: typeof deps.getSeam === "function" ? deps.getSeam
        : () => null, telemetry: deps.telemetry || null, logger: deps.logger || null });
    return { ok: true, officerSpawns };
  } catch (err) {
    return { ok: false, reason: "OFFICER_SPAWNS_START_FAILED", detail: String((err && err.message) || err)
      .slice(0, 120) };
  }
}

module.exports = { startOfficerSpawns, createUnavailableOfficerSpawns };
