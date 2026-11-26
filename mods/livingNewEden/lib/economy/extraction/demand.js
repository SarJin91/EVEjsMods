"use strict";

const PERMILLE = 1000;
const PERMILLE2 = PERMILLE * PERMILLE;
const PI_KIND = "pi";
const MIN_CONVERTED_TIER = 2;
const TOP_TIER = 4;

const isCount = (v) => Number.isSafeInteger(v) && v > 0;
const getOr0 = (map, k) => map.get(k) || 0;

function scaledCeil(a, f) {
  const product = a * f;
  const v = Number.isSafeInteger(product) ? Math.ceil(product / PERMILLE2) : Math.ceil(a * (f / PERMILLE2));
  return Math.min(Number.MAX_SAFE_INTEGER, v);
}

function scaleAdvanced(catalog, group, runs, permille, groupPermille) {
  const out = { moon: new Map(), pi: new Map() };
  if (!isCount(runs) || !isCount(permille) || !isCount(groupPermille)) return out;
  const bill = catalog.advancedBillOf(group);
  const f = permille * groupPermille;
  for (const kind of ["moon", "pi"]) {
    for (const [typeId, n] of bill[kind]) {
      const v = scaledCeil(n * runs, f);
      if (v > 0) out[kind].set(typeId, v);
    }
  }
  return out;
}

function addInto(map, typeId, v) {
  if (v > 0) map.set(typeId, Math.min(Number.MAX_SAFE_INTEGER, getOr0(map, typeId) + v));
}

function stationTarget(catalog, station, p) {
  const target = new Map();
  if (p.fuelOn && station.kind === "upwell") {
    for (const [typeId, q] of p.fuel) addInto(target, typeId, q * p.fuelReservePeriods);
  }
  if (p.advancedOn && station.lines > 0) {
    const groups = [...new Set([...(station.activeGroups || []), ...(p.reserveGroups || [])])].sort();
    for (const g of groups) {
      const s = scaleAdvanced(catalog, g, p.advancedReserveRuns, p.advancedInputsPermille, p.groupPermilleOf(g));
      for (const kind of ["moon", "pi"]) for (const [typeId, v] of s[kind]) addInto(target, typeId, v);
    }
  }
  return target;
}

function typesOfTier(catalog, map, tier) {
  return [...map.keys()].filter((t) => catalog.piTierOf(t) === tier).sort((a, b) => a - b);
}

function expandGross(catalog, target, stock) {
  const gross = new Map(target);
  for (let tier = TOP_TIER; tier >= MIN_CONVERTED_TIER; tier -= 1) {
    for (const t of typesOfTier(catalog, gross, tier)) {
      const d = Math.max(0, getOr0(gross, t) - getOr0(stock, t));
      const s = d > 0 ? catalog.schematicFor(t) : null;
      if (!s) continue;
      const runs = Math.ceil(d / s.outputQty);
      for (const [input, q] of s.inputs) addInto(gross, input, runs * q);
    }
  }
  return gross;
}

function conversionOrder(catalog, gross) {
  const out = [];
  for (const [t, v] of gross) {
    const tier = catalog.piTierOf(t);
    if (v > 0 && tier !== null && tier >= MIN_CONVERTED_TIER) out.push([tier, t]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((r) => r[1]);
}

function conversionStep(catalog, outputTypeId, gross, avail) {
  const s = catalog.schematicFor(outputTypeId);
  if (!s) return null;
  const need = Math.max(0, getOr0(gross, outputTypeId) - getOr0(avail, outputTypeId));
  let runs = Math.ceil(need / s.outputQty);
  for (const [input, q] of s.inputs) runs = Math.min(runs, Math.floor(getOr0(avail, input) / q));
  if (!(runs >= 1)) return null;
  const deltas = s.inputs.map(([input, q]) => ({ itemKind: PI_KIND, itemKey: `type:${input}`, delta: -runs * q }));
  deltas.push({ itemKind: PI_KIND, itemKey: `type:${outputTypeId}`, delta: runs * s.outputQty });
  deltas.sort((a, b) => (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
  return { outputTypeId, runs, deltas };
}

function planTransfers(p) {
  const out = { pairs: [], rest: [], noDonor: 0, truncated: 0, typesTruncated: 0 };
  const surplus = new Map();
  for (const [id, m] of p.surplus || []) surplus.set(id, new Map(m));
  const sorted = [...(p.recipients || [])].sort((a, b) => (a.stationId < b.stationId ? -1
    : a.stationId > b.stationId ? 1 : 0));
  const n = sorted.length;
  const start = n > 0 && Number.isSafeInteger(p.rotate) ? ((p.rotate % n) + n) % n : 0;
  const order = [...sorted.slice(start), ...sorted.slice(0, start)];
  const isFuel = (t) => (p.fuelTypes && p.fuelTypes.has(t) ? 0 : 1);
  const maxTypes = Math.max(0, Number(p.maxTypes) || 0);
  const maxPairs = p.maxPairs === Infinity ? Infinity : Math.max(0, Number(p.maxPairs) || 0);
  for (const r of order) {
    const types = [...(r.short || [])].filter(([, u]) => u > 0).map(([t]) => t)
      .sort((a, b) => isFuel(a) - isFuel(b) || a - b);
    if (types.length === 0) continue;
    const left = new Map(types.map((t) => [t, r.short.get(t)]));
    const restOf = () => {
      for (const t of [...left.keys()].sort((a, b) => a - b)) {
        const units = left.get(t);
        if (units > 0) out.rest.push({ stationId: r.stationId, donorId: r.donorId, typeId: t, units });
      }
    };
    if (r.donorId === null || r.donorId === undefined) {
      out.noDonor += 1;
      restOf();
      continue;
    }
    const pool = surplus.get(r.donorId) || new Map();
    const gives = [];
    let cut = 0;
    for (const t of types) {
      const give = Math.min(left.get(t), getOr0(pool, t));
      if (!(give > 0)) continue;
      if (gives.length >= maxTypes) {
        cut += 1;
        continue;
      }
      gives.push({ typeId: t, units: give });
    }
    if (gives.length > 0 && out.pairs.length >= maxPairs) {
      out.truncated += 1;
      restOf();
      continue;
    }
    out.typesTruncated += cut;
    for (const g of gives) {
      pool.set(g.typeId, getOr0(pool, g.typeId) - g.units);
      left.set(g.typeId, left.get(g.typeId) - g.units);
    }
    if (gives.length > 0) out.pairs.push({ src: r.donorId, dst: r.stationId, gives });
    restOf();
  }
  out.rest.sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0) || a.typeId - b.typeId);
  return out;
}

function applyStep(avail, step) {
  const next = new Map(avail);
  for (const d of step.deltas) {
    const typeId = Number(d.itemKey.slice(5));
    const v = getOr0(next, typeId) + d.delta;
    if (v > 0) next.set(typeId, v);
    else next.delete(typeId);
  }
  return next;
}

module.exports = { scaleAdvanced, stationTarget, expandGross, conversionOrder, conversionStep, applyStep,
  planTransfers };
