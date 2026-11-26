"use strict";

const { createRng } = require("../../util/rng");
const { WRECK_YIELD } = require("../../world/data/wreckYield");
const data = require("./data");
const { PLAN_ROWS_CAP } = require("./schema");

const MIN_SPACING_M = 500;
const Y_FLATTEN = 0.25;
const PLACEMENT_TRIES = 24;

const PARAM_NAMES = Object.freeze(["maxWrecksPerAnomaly", "lootUnitsPerRoll", "maxLootRollsPerWreck",
  "wreckSpreadM"]);

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "PLAN_INVALID", detail });

function roundDiv(a, b) {
  return Math.floor((2 * a + b) / (2 * b));
}

function lootRollsOf(units, params) {
  if (units <= 0) return 0;
  return Math.min(params.maxLootRollsPerWreck, Math.max(1, Math.floor(units / params.lootUnitsPerRoll)));
}

function yieldOf(hullGroup) {
  return WRECK_YIELD[hullGroup] || { salvage: 0, loot: 0 };
}

function checkComposition(composition) {
  if (!Array.isArray(composition) || composition.length === 0) return "composition";
  for (const e of composition) {
    if (!Array.isArray(e) || e.length < 4) return "composition.entry";
    if (!Number.isSafeInteger(e[0]) || e[0] <= 0) return "composition.factionId";
    if (typeof e[1] !== "string" || !WRECK_YIELD[e[1]]) return "composition.hullGroup";
    if (!Number.isSafeInteger(e[2]) || e[2] < 0) return "composition.typeId";
    if (!Number.isSafeInteger(e[3]) || e[3] <= 0) return "composition.count";
  }
  return null;
}

function byYield(a, b) {
  return yieldOf(b[1]).salvage - yieldOf(a[1]).salvage || a[0] - b[0] || a[2] - b[2]
    || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
}

function topFactionOf(composition) {
  const counts = new Map();
  for (const e of composition) counts.set(e[0], (counts.get(e[0]) || 0) + e[3]);
  let best = null;
  for (const [factionId, n] of counts) {
    if (best === null || n > best[1] || (n === best[1] && factionId < best[0])) best = [factionId, n];
  }
  return best ? best[0] : null;
}

function placeOffsets(count, spreadM, seed) {
  const rng = createRng(seed);
  const out = [];
  const minSq = MIN_SPACING_M * MIN_SPACING_M;
  for (let i = 0; i < count; i += 1) {
    let pick = null;
    for (let t = 0; t < PLACEMENT_TRIES; t += 1) {
      const x = (rng.nextFloat() * 2 - 1) * spreadM;
      const y = (rng.nextFloat() * 2 - 1) * spreadM;
      const z = (rng.nextFloat() * 2 - 1) * spreadM;
      if (x * x + y * y + z * z > spreadM * spreadM) continue;
      const candidate = { x: Math.round(x), y: Math.round(y * Y_FLATTEN), z: Math.round(z) };
      pick = candidate;
      const clear = out.every((p) => {
        const dx = p.x - candidate.x;
        const dy = p.y - candidate.y;
        const dz = p.z - candidate.z;
        return dx * dx + dy * dy + dz * dz >= minSq;
      });
      if (clear) break;
    }
    out.push(pick || { x: 0, y: 0, z: 0 });
  }
  return out;
}

function validateField(field) {
  if (!field || typeof field !== "object") return "field";
  const badComposition = checkComposition(field.composition);
  if (badComposition) return badComposition;
  if (!Number.isSafeInteger(field.shipsLost) || field.shipsLost < 1) return "shipsLost";
  if (!isCount(field.salvageUnits) || !isCount(field.lootUnits)) return "units";
  return null;
}

function planAnomaly(field, haul, params, seed) {
  if (!params || typeof params !== "object") return invalid("params");
  for (const name of PARAM_NAMES) if (!Number.isSafeInteger(params[name]) || params[name] < 0) return invalid(name);
  if (params.maxWrecksPerAnomaly < 1 || params.lootUnitsPerRoll < 1) return invalid("params.bounds");
  const badField = validateField(field);
  if (badField) return invalid(badField);
  if (!haul || !isCount(haul.salvage) || !isCount(haul.loot)) return invalid("haul");
  if (!Number.isSafeInteger(seed) || seed < 0) return invalid("seed");

  const sorted = [...field.composition].sort(byYield);
  const hulls = sorted.reduce((n, e) => n + e[3], 0);
  const share = field.salvageUnits > 0 ? [haul.salvage, field.salvageUnits] : [haul.loot, Math.max(field.lootUnits, 1)];
  const wanted = Number.isSafeInteger(2 * field.shipsLost * share[0] + Math.max(share[1], 1))
    ? roundDiv(field.shipsLost * share[0], Math.max(share[1], 1)) : field.shipsLost;
  const count = Math.max(1, Math.min(wanted, params.maxWrecksPerAnomaly, hulls, PLAN_ROWS_CAP));

  const chosen = [];
  for (const e of sorted) {
    for (let k = 0; k < e[3] && chosen.length < count; k += 1) chosen.push(e);
    if (chosen.length >= count) break;
  }
  const weights = chosen.map((e) => yieldOf(e[1]).loot);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const lootUnits = weights.map((w) => (weightSum > 0 ? Math.floor((haul.loot * w) / weightSum) : 0));
  let rest = haul.loot - lootUnits.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0 && weightSum > 0; i = (i + 1) % lootUnits.length, rest -= 1) lootUnits[i] += 1;

  const offsets = placeOffsets(chosen.length, params.wreckSpreadM, seed);
  const wrecks = chosen.map((e, slot) => Object.freeze({
    slot,
    shipTypeId: e[2],
    hullGroup: e[1],
    factionId: e[0],
    lootUnits: lootUnits[slot],
    lootRolls: lootRollsOf(lootUnits[slot], params),
    offset: Object.freeze(offsets[slot]),
  }));
  const rows = wrecks.map((w) => [w.slot, w.shipTypeId, w.hullGroup, w.factionId, w.lootRolls, w.offset.x,
    w.offset.y, w.offset.z]);
  const topFactionId = topFactionOf(field.composition);
  return { ok: true, wrecks, rows, label: data.siteLabelOf(topFactionId), topFactionId };
}

function wrecksOfRows(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(r) || r.length < 8 || !Number.isSafeInteger(r[0]) || r[0] < 0) continue;
    if (!Number.isSafeInteger(r[1]) || typeof r[2] !== "string" || !Number.isSafeInteger(r[3])) continue;
    if (!Number.isSafeInteger(r[4]) || ![r[5], r[6], r[7]].every(Number.isFinite)) continue;
    out.push({ slot: r[0], shipTypeId: r[1], hullGroup: r[2], factionId: r[3], lootRolls: r[4],
      offset: { x: r[5], y: r[6], z: r[7] } });
  }
  return out;
}

function dominantFactionOfWrecks(wrecks) {
  const counts = new Map();
  for (const w of Array.isArray(wrecks) ? wrecks : []) {
    if (!w || !Number.isSafeInteger(w.factionId) || w.factionId <= 0) continue;
    counts.set(w.factionId, (counts.get(w.factionId) || 0) + 1);
  }
  let best = null;
  for (const [factionId, n] of counts) {
    if (best === null || n > best[1] || (n === best[1] && factionId < best[0])) best = [factionId, n];
  }
  return best ? best[0] : null;
}

function placeSpecOf(row, wreck, ctx) {
  const lootTableId = ctx.lootTableFor(wreck.factionId, wreck.hullGroup);
  return {
    anomalyId: row.anomalyId,
    slot: wreck.slot,
    siteKey: ctx.siteKey,
    systemId: row.systemId,
    offset: { x: wreck.offset.x, y: wreck.offset.y, z: wreck.offset.z },
    shipTypeId: wreck.shipTypeId,
    hullGroup: wreck.hullGroup,
    factionName: data.wreckFactionNameOf(wreck.factionId),
    ownerId: data.ownerCorporationOf(wreck.factionId),
    lootTableId,
    lootRolls: lootTableId ? wreck.lootRolls : 0,
    lootSourceNpcTypeId: data.lootSourceNpcTypeOf(wreck.factionId, wreck.hullGroup),
    expiresAtMs: row.expiresAt,
    nowMs: ctx.nowMs,
    fallbackWreckNames: wreck.shipTypeId > 0 ? [] : data.fallbackWreckNamesOf(wreck.hullGroup, wreck.factionId),
  };
}

module.exports = { MIN_SPACING_M, Y_FLATTEN, PLACEMENT_TRIES, PARAM_NAMES, validateField, planAnomaly, wrecksOfRows,
  placeSpecOf, dominantFactionOfWrecks };
