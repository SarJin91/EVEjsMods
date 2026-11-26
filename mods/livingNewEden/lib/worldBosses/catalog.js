"use strict";

const UNIT_LIMITS = Object.freeze({ maxUnitsPerPhase: 64, hpMax: 1e9, dpsMax: 1e6, sigMax: 1e9 });
const KEY_RE = /^[a-z](?:[a-z_]*[a-z])?$/;
const MAX_LABEL_LENGTH = 64;

const u = (key, count, hullGroup, typeId, hp, dps, signature, designSig, profileId) => Object.freeze({ key, count,
  hullGroup, typeId, hp, dps, signature, designSig, ...(profileId ? { profileId } : {}) });

const phase = (name, units) => Object.freeze({ name, units: Object.freeze(units) });

const DRIFTER_BS = u("bs", 4, "battleship", 34495, 150000, 1100, 400, 400);

const CATALOG_V1 = Object.freeze([
  Object.freeze({
    kind: "drifter_swarm", factionId: 500024, label: "Drifter Swarm Nexus",
    phasePermille: Object.freeze([600, 800, 1000]),
    phases: Object.freeze([
      phase("Screen", [u("cruiser", 6, "cruiser", 47153, 40000, 350, 150, 150),
        u("strike", 4, "cruiser", 47722, 55000, 450, 160, 150)]),
      phase("Strike", [u("bs", 6, "battleship", 34495, 150000, 1100, 400, 400),
        u("polemarkos", 2, "battleship", 56217, 220000, 1500, 420, 400, "parity_drifter_polemarkos")]),
      phase("Nexus", [DRIFTER_BS,
        u("tyrannos", 1, "battleship", 87612, 600000, 3000, 600, 400, "parity_drifter_tyrannos"),
        u("strategos", 1, "dreadnought", 88154, 2500000, 6000, 3000, 1000, "parity_drifter_strategos")]),
    ]),
  }),
  Object.freeze({
    kind: "rogue_mother_hive", factionId: 500025, label: "Rogue Mother Hive",
    phasePermille: Object.freeze([600, 800, 1000]),
    phases: Object.freeze([
      phase("Swarm", [u("swarm", 10, "cruiser", null, 40000, 350, 150, 150)]),
      phase("Brood", [u("brood", 8, "battleship", null, 150000, 1100, 400, 400)]),
      phase("Hive", [u("hive", 1, "dreadnought", null, 2500000, 6000, 3000, 1000)]),
    ]),
  }),
  Object.freeze({
    kind: "triglavian_armada", factionId: 500026, label: "Triglavian Armada Conduit",
    phasePermille: Object.freeze([600, 800, 1000]),
    phases: Object.freeze([
      phase("Screen", [u("damavik", 6, "frigate", 52182, 15000, 150, 40, 40),
        u("vedmak", 4, "cruiser", 52183, 45000, 400, 140, 150)]),
      phase("Strike", [u("leshak", 6, "battleship", 52184, 160000, 1200, 420, 400),
        u("vedmak", 2, "cruiser", 52183, 45000, 400, 140, 150)]),
      phase("Conduit", [u("leshak", 4, "battleship", 52184, 160000, 1200, 420, 400),
        u("zirnitra", 1, "dreadnought", 52701, 2400000, 5500, 3000, 1000, "parity_trig_liminal_zirnitra")]),
    ]),
  }),
]);

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isNumIn = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isText = (v, max) => typeof v === "string" && v !== "" && v.length <= max;

function unitProblem(unit, limits) {
  if (!unit || typeof unit !== "object") return "UNIT_SHAPE";
  if (typeof unit.key !== "string" || !KEY_RE.test(unit.key)) return "UNIT_KEY";
  if (!isPosInt(unit.count)) return "UNIT_COUNT";
  if (!isText(unit.hullGroup, 32)) return "UNIT_HULL_GROUP";
  if (!isPosInt(unit.typeId)) return "UNIT_TYPE_ID";
  if (!Number.isSafeInteger(unit.hp) || unit.hp < 1 || unit.hp > limits.hpMax) return "UNIT_HP";
  if (!isNumIn(unit.dps, 0, limits.dpsMax)) return "UNIT_DPS";
  if (!isNumIn(unit.signature, 1, limits.sigMax)) return "UNIT_SIGNATURE";
  if (!isNumIn(unit.designSig, 1, limits.sigMax)) return "UNIT_DESIGN_SIG";
  if (unit.profileId !== undefined && !isText(unit.profileId, 64)) return "UNIT_PROFILE";
  return null;
}

function kindProblem(entry, limits) {
  if (!entry || typeof entry !== "object" || !isText(entry.kind, 32)) return "KIND_SHAPE";
  if (!isPosInt(entry.factionId)) return "FACTION";
  if (!isText(entry.label, MAX_LABEL_LENGTH)) return "LABEL";
  if (!Array.isArray(entry.phases) || entry.phases.length === 0) return "PHASES";
  if (!Array.isArray(entry.phasePermille) || entry.phasePermille.length !== entry.phases.length
    || entry.phasePermille.some((p) => !Number.isSafeInteger(p) || p < 1 || p > 1000)) {
    return "PHASE_PERMILLE";
  }
  for (const ph of entry.phases) {
    if (!ph || !Array.isArray(ph.units) || ph.units.length === 0) return "PHASE_UNITS";
    let total = 0;
    const keys = new Set();
    for (const unit of ph.units) {
      const p = unitProblem(unit, limits);
      if (p) return p;
      if (keys.has(unit.key)) return "UNIT_KEY_DUPLICATE";
      keys.add(unit.key);
      total += unit.count;
    }
    if (total > limits.maxUnitsPerPhase) return "PHASE_TOO_LARGE";
  }
  return null;
}

function validateCatalog(catalog, limits) {
  const L = limits || UNIT_LIMITS;
  const kinds = new Map();
  const disabled = [];
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    const name = entry && typeof entry.kind === "string" ? entry.kind : String(entry && entry.kind);
    const problem = kindProblem(entry, L) || (kinds.has(name) ? "KIND_DUPLICATE" : null);
    if (problem) disabled.push(Object.freeze({ kind: name, reason: problem }));
    else kinds.set(name, entry);
  }
  return { ok: true, kinds, disabled: Object.freeze(disabled) };
}

module.exports = { CATALOG_V1, UNIT_LIMITS, validateCatalog };
