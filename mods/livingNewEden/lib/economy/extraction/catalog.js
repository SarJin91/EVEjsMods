"use strict";

const MOON_TIER_COUNT = 5;
const MAX_PI_TIER = 4;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v > 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function computePiTiers(schematics) {
  if (!Array.isArray(schematics)) return { ok: false, detail: "schematics" };
  const inputsOf = new Map();
  for (const row of schematics) {
    if (!Array.isArray(row) || !isId(row[0]) || !Array.isArray(row[3]) || row[3].length === 0) {
      return { ok: false, detail: "schematic row" };
    }
    if (inputsOf.has(row[0])) return { ok: false, detail: `two schematics for ${row[0]}` };
    const inputs = [];
    for (const pair of row[3]) {
      if (!Array.isArray(pair) || !isId(pair[0])) return { ok: false, detail: `schematic ${row[0]} input` };
      inputs.push(pair[0]);
    }
    inputsOf.set(row[0], inputs);
  }
  const tiers = new Map();
  const open = new Set();
  const resolve = (start) => {
    const stack = [[start, 0]];
    open.add(start);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const inputs = inputsOf.get(top[0]) || [];
      if (top[1] < inputs.length) {
        const next = inputs[top[1]];
        top[1] += 1;
        if (tiers.has(next)) continue;
        if (open.has(next)) return `cycle at ${next}`;
        open.add(next);
        stack.push([next, 0]);
        continue;
      }
      stack.pop();
      open.delete(top[0]);
      tiers.set(top[0], inputs.length === 0 ? 0 : 1 + Math.max(...inputs.map((i) => tiers.get(i))));
    }
    return null;
  };
  for (const out of [...inputsOf.keys()].sort((a, b) => a - b)) {
    if (tiers.has(out)) continue;
    const cycle = resolve(out);
    if (cycle) return { ok: false, detail: cycle };
  }
  return { ok: true, tiers };
}

function invalid(detail) {
  return { ok: false, reason: "CATALOG_INVALID", detail: String(detail) };
}

function checkSource(data) {
  const s = data.SOURCE;
  if (!isPlainObject(s) || typeof s.sourceHash !== "string" || s.sourceHash.length === 0 || !isId(s.sdeBuild)) {
    return "SOURCE";
  }
  if (!Array.isArray(data.MOON_TIERS) || data.MOON_TIERS.length !== MOON_TIER_COUNT
    || new Set(data.MOON_TIERS).size !== MOON_TIER_COUNT || !data.MOON_TIERS.every((t) => typeof t === "string")) {
    return "MOON_TIERS";
  }
  for (const key of ["MOON_ORES", "MOON_MATERIAL_TIER", "PI_TIER", "P1_OF_P0", "FUEL_BLOCKS"]) {
    if (!isPlainObject(data[key])) return key;
  }
  if (!Array.isArray(data.SCHEMATICS)) return "SCHEMATICS";
  return null;
}

function checkMoon(data) {
  const oresByTier = new Map(data.MOON_TIERS.map((t) => [t, []]));
  const oreMaterials = new Map();
  for (const [key, ore] of Object.entries(data.MOON_ORES)) {
    const oreId = Number(key);
    if (!isId(oreId) || !isPlainObject(ore) || !oresByTier.has(ore.tier) || !isPlainObject(ore.materials)) {
      return { detail: `MOON_ORES.${key}` };
    }
    const materials = [];
    for (const [m, q] of Object.entries(ore.materials)) {
      if (!isId(Number(m)) || !isCount(q)) return { detail: `MOON_ORES.${key}.materials` };
      if (!hasOwn(data.MOON_MATERIAL_TIER, m)) return { detail: `material ${m} without a tier` };
      materials.push([Number(m), q]);
    }
    if (materials.length === 0) return { detail: `MOON_ORES.${key} has no material` };
    oresByTier.get(ore.tier).push(oreId);
    oreMaterials.set(oreId, materials.sort((a, b) => a[0] - b[0]));
  }
  for (const [tier, ores] of oresByTier) {
    if (ores.length === 0) return { detail: `tier ${tier} without an ore` };
    ores.sort((a, b) => a - b);
  }
  for (const [m, tier] of Object.entries(data.MOON_MATERIAL_TIER)) {
    if (!isId(Number(m)) || !oresByTier.has(tier)) return { detail: `MOON_MATERIAL_TIER.${m}` };
  }
  return { oresByTier, oreMaterials };
}

function checkPi(data) {
  const computed = computePiTiers(data.SCHEMATICS);
  if (!computed.ok) return { detail: computed.detail };
  const piTier = new Map();
  for (const [key, tier] of Object.entries(data.PI_TIER)) {
    if (!isId(Number(key)) || !Number.isSafeInteger(tier) || tier < 0 || tier > MAX_PI_TIER) {
      return { detail: `PI_TIER.${key}` };
    }
    piTier.set(Number(key), tier);
  }
  for (const [typeId, tier] of computed.tiers) {
    if (piTier.get(typeId) !== tier) return { detail: `PI_TIER.${typeId} is not ${tier}` };
  }
  const schematics = new Map();
  for (const [out, outQty, cycleSec, inputs] of data.SCHEMATICS) {
    if (!isCount(outQty) || !isCount(cycleSec) || !inputs.every((p) => isCount(p[1]))) {
      return { detail: `schematic ${out}` };
    }
    schematics.set(out, Object.freeze({ outputQty: outQty, cycleSec,
      inputs: Object.freeze(inputs.map((p) => Object.freeze([p[0], p[1]])).sort((a, b) => a[0] - b[0])) }));
  }
  const p1OfP0 = new Map();
  for (const [key, p1] of Object.entries(data.P1_OF_P0)) {
    const p0 = Number(key);
    if (piTier.get(p0) !== 0 || piTier.get(p1) !== 1 || !schematics.has(p1)) return { detail: `P1_OF_P0.${key}` };
    p1OfP0.set(p0, p1);
  }
  return { piTier, schematics, p1OfP0 };
}

function checkFuel(data, piTier) {
  const blocks = Object.keys(data.FUEL_BLOCKS).map(Number).sort((a, b) => a - b);
  if (blocks.length === 0) return { detail: "FUEL_BLOCKS empty" };
  const first = data.FUEL_BLOCKS[String(blocks[0])];
  for (const id of blocks) {
    const block = data.FUEL_BLOCKS[String(id)];
    if (!isId(id) || !isPlainObject(block) || !isCount(block.batch) || !isPlainObject(block.pi)) {
      return { detail: `FUEL_BLOCKS.${id}` };
    }
    for (const [pi, q] of Object.entries(block.pi)) {
      if (!piTier.has(Number(pi)) || !isCount(q)) return { detail: `FUEL_BLOCKS.${id}.pi.${pi}` };
    }
  }
  const perBlock = Object.entries(first.pi).map(([pi, q]) => Object.freeze([Number(pi), q, first.batch]))
    .sort((a, b) => a[0] - b[0]);
  return { perBlock: Object.freeze(perBlock) };
}

const ADVANCED_KEY_RE = /^type:(\d+)$/;

function checkAdvanced(data, piTier) {
  const bills = new Map();
  if (data.ADVANCED_BILLS === undefined) return { bills };
  if (!isPlainObject(data.ADVANCED_BILLS)) return { detail: "ADVANCED_BILLS" };
  for (const [group, bill] of Object.entries(data.ADVANCED_BILLS)) {
    if (!isPlainObject(bill) || !isPlainObject(bill.moon) || !isPlainObject(bill.pi)) {
      return { detail: `ADVANCED_BILLS.${group}` };
    }
    const out = {};
    for (const kind of ["moon", "pi"]) {
      const rows = [];
      for (const [key, n] of Object.entries(bill[kind])) {
        const m = ADVANCED_KEY_RE.exec(key);
        const id = m ? Number(m[1]) : 0;
        const known = kind === "moon" ? hasOwn(data.MOON_MATERIAL_TIER, String(id))
          : piTier.has(id) && piTier.get(id) >= 1;
        if (!isId(id) || !known || !isCount(n)) return { detail: `ADVANCED_BILLS.${group}.${kind}.${key}` };
        rows.push(Object.freeze([id, n]));
      }
      out[kind] = Object.freeze(rows.sort((a, b) => a[0] - b[0]));
    }
    bills.set(group, Object.freeze(out));
  }
  return { bills };
}

const EMPTY_BILL = Object.freeze({ moon: Object.freeze([]), pi: Object.freeze([]) });

function createCommodityCatalog(data) {
  if (!isPlainObject(data)) return invalid("data");
  const shape = checkSource(data);
  if (shape) return invalid(shape);
  const moon = checkMoon(data);
  if (moon.detail) return invalid(moon.detail);
  const pi = checkPi(data);
  if (pi.detail) return invalid(pi.detail);
  const fuel = checkFuel(data, pi.piTier);
  if (fuel.detail) return invalid(fuel.detail);
  const advanced = checkAdvanced(data, pi.piTier);
  if (advanced.detail) return invalid(advanced.detail);
  let maxSchematicDeltas = 0;
  for (const [out, s] of pi.schematics) {
    if (pi.piTier.get(out) >= 2) maxSchematicDeltas = Math.max(maxSchematicDeltas, s.inputs.length + 1);
  }

  const moonTiers = Object.freeze([...data.MOON_TIERS]);
  const catalog = Object.freeze({
    kindOf(typeId) {
      if (hasOwn(data.MOON_MATERIAL_TIER, String(typeId))) return "moon";
      if (pi.piTier.has(Number(typeId))) return "pi";
      return null;
    },
    moonTiers,
    oresOfTier: (tier) => [...(moon.oresByTier.get(tier) || [])],
    oreMaterials: (oreTypeId) => (moon.oreMaterials.get(Number(oreTypeId)) || []).map((p) => [p[0], p[1]]),
    piTierOf: (typeId) => (pi.piTier.has(Number(typeId)) ? pi.piTier.get(Number(typeId)) : null),
    p1OfP0: (p0TypeId) => (pi.p1OfP0.has(Number(p0TypeId)) ? pi.p1OfP0.get(Number(p0TypeId)) : null),
    schematicFor: (outputTypeId) => pi.schematics.get(Number(outputTypeId)) || null,
    fuelPiPerBlock: () => fuel.perBlock.map((r) => [r[0], r[1], r[2]]),
    advancedBillOf: (group) => advanced.bills.get(group) || EMPTY_BILL,
    fuelPerPeriod(blocks) {
      if (!isCount(blocks)) return [];
      return fuel.perBlock.map((r) => [r[0], Math.ceil((r[1] * blocks) / r[2])]).filter((r) => r[1] > 0);
    },
    maxSchematicDeltas,
  });
  return { ok: true, catalog };
}

module.exports = { createCommodityCatalog, computePiTiers, MOON_TIER_COUNT };
