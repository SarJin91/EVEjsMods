"use strict";

const { strengthOf } = require("./ai/strength");
const { MAX_INTEL_STRENGTH } = require("./schema");

const NAME = "intel";
const SOURCE = "battle";
const DESTROYED = "DESTROYED";
const SIDE_NAMES = Object.freeze(["A", "B"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function inputProblem(settled) {
  if (!isPlainObject(settled)) return "settled";
  if (!isId(settled.systemId)) return "systemId";
  if (!isTime(settled.at)) return "at";
  if (!Array.isArray(settled.fleets)) return "fleets";
  for (const f of settled.fleets) {
    if (!isPlainObject(f) || typeof f.fleetId !== "string" || !SIDE_NAMES.includes(f.side)
      || typeof f.disposition !== "string") return "fleets[]";
  }
  if (!isPlainObject(settled.sides)) return "sides";
  for (const s of SIDE_NAMES) if (!isPlainObject(settled.sides[s]) || !isId(settled.sides[s].factionId)) return "sides";
  return null;
}

function createBattleIntelConsequence(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createBattleIntelConsequence: deps missing");
  const { intelRepository, fleetRepository, registry, powerTable, isHostile, onCount } = deps;
  const worldRepository = deps.worldRepository || null;
  if (!intelRepository || typeof intelRepository.upsertObservation !== "function") {
    throw new TypeError("createBattleIntelConsequence: intelRepository required");
  }
  if (!fleetRepository || typeof fleetRepository.getFleets !== "function") {
    throw new TypeError("createBattleIntelConsequence: fleetRepository required");
  }
  if (!registry || typeof registry.getFaction !== "function") {
    throw new TypeError("createBattleIntelConsequence: registry required");
  }
  if (!powerTable || typeof isHostile !== "function") {
    throw new TypeError("createBattleIntelConsequence: powerTable and isHostile required");
  }

  function metrics(written, skipped) {
    if (typeof onCount !== "function") return;
    try {
      if (written > 0) onCount("strategy.intel.battle", written);
      if (skipped > 0) onCount("strategy.intel.battleSkipped", skipped);
    } catch (_err) {
    }
  }

  function controllerOf(tx, systemId) {
    if (!worldRepository || typeof worldRepository.getSystem !== "function") return { ok: true, id: null };
    const r = worldRepository.getSystem(tx, systemId, { includeInfluence: false });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "WORLD_READ_FAILED" };
    const c = r.system ? r.system.controllerFactionId : null;
    return { ok: true, id: isId(c) ? c : null };
  }

  function applyIn(tx, settled, ck) {
    const problem = inputProblem(settled);
    if (problem !== null || typeof ck !== "string" || ck.length < 1) {
      return { ok: false, reason: "INTEL_INPUT_INVALID", detail: problem || "ck" };
    }
    const live = settled.fleets.filter((f) => f.disposition !== DESTROYED);
    let rows = new Map();
    if (live.length > 0) {
      const read = fleetRepository.getFleets(tx, live.map((f) => f.fleetId));
      if (!read || read.ok !== true) return { ok: false, reason: (read && read.reason) || "FLEETS_READ_FAILED" };
      rows = new Map(read.fleets.map((x) => [x.fleetId, x]));
    }
    let controller = null;
    let written = 0;
    let skipped = 0;
    for (const side of SIDE_NAMES) {
      const factionId = settled.sides[side].factionId;
      if (registry.getFaction(factionId) === null
        || (typeof registry.isActive === "function" && registry.isActive(factionId) !== true)) {
        skipped += 1;
        continue;
      }
      const others = live.filter((f) => f.side !== side).map((f) => rows.get(f.fleetId)).filter(Boolean);
      const hostile = others.filter((x) => isHostile(factionId, x.factionId) === true);
      if (others.length > 0 && hostile.length === 0) {
        skipped += 1;
        continue;
      }
      const stored = intelRepository.listIntel(tx, factionId, [settled.systemId]);
      if (!stored || stored.ok !== true) return { ok: false, reason: (stored && stored.reason) || "INTEL_READ_FAILED" };
      if (stored.records.some((r) => r.observedAt > settled.at)) {
        skipped += 1;
        continue;
      }
      if (controller === null) {
        const c = controllerOf(tx, settled.systemId);
        if (!c.ok) return c;
        controller = c;
      }
      let ships = 0;
      let strength = 0;
      for (const x of hostile) {
        ships += Number.isSafeInteger(x.shipCount) && x.shipCount > 0 ? x.shipCount : 0;
        strength += strengthOf(x.composition, powerTable);
      }
      const r = intelRepository.upsertObservation(tx, { factionId, systemId: settled.systemId,
        observedAt: settled.at, controllerFactionId: controller.id, hostileFleets: hostile.length, hostileShips: ships,
        hostileStrength: Math.min(strength, MAX_INTEL_STRENGTH), hostileStations: 0, source: SOURCE },
      `${ck}:f:${factionId}`);
      if (r && r.ok === true) {
        if (r.duplicate !== true) written += 1;
        continue;
      }
      if (r && r.reason === "INTEL_LIMIT") {
        skipped += 1;
        continue;
      }
      return { ok: false, reason: (r && r.reason) || "INTEL_WRITE_FAILED" };
    }
    return { ok: true, written, skipped };
  }

  return Object.freeze({ name: NAME, apply(tx, settled, ck) {
    let out;
    try {
      out = applyIn(tx, settled, ck);
    } catch (err) {
      return { ok: false, reason: "INTEL_THREW", detail: String((err && err.message) || err).slice(0, 200) };
    }
    if (out.ok) metrics(out.written, out.skipped);
    return out;
  } });
}

module.exports = { createBattleIntelConsequence, BATTLE_INTEL_SOURCE: SOURCE };
