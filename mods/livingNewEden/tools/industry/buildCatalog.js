"use strict";

const { fingerprint } = require("../../lib/util/fingerprint");
const { INDUSTRY_METHOD } = require("./method");

const PERMILLE = 1000;
const MILLION = 1000000n;
const VOLUME_SCALE = 1000;
const LN4 = Math.log(4);
const AGILITY_DIVISOR = 1e6;

const fail = (reason, detail) => ({ ok: false, reason, detail: String(detail) });
const round1 = (v) => Math.round(v * 10) / 10;
const priceOf = (row) => (row && typeof row.basePrice === "number" && row.basePrice > 0
  ? Math.round(row.basePrice) : 0);

function expand(typeId, quantity, depth, path, ctx, out) {
  if (ctx.minerals.has(typeId)) {
    out.set(typeId, (out.get(typeId) || 0) + quantity);
    return;
  }
  const bp = ctx.blueprints.get(typeId);
  if (!bp || depth > ctx.maxDepth || path.has(typeId) || !(bp.productQuantity > 0)) {
    ctx.leaves.set(typeId, (ctx.leaves.get(typeId) || 0) + quantity);
    return;
  }
  ctx.usedBlueprints.add(typeId);
  const runs = Math.ceil(quantity / bp.productQuantity);
  path.add(typeId);
  for (const m of bp.materials) expand(m.typeId, m.quantity * runs, depth + 1, path, ctx, out);
  path.delete(typeId);
}

function billOf(typeId, base) {
  const bp = base.blueprints.get(typeId);
  base.usedBlueprints.add(typeId);
  const ctx = { ...base, leaves: new Map() };
  const out = new Map();
  const path = new Set([typeId]);
  for (const m of bp.materials) expand(m.typeId, m.quantity, 1, path, ctx, out);
  return { minerals: out, leaves: ctx.leaves };
}

function valueOf(bill, inputs, base) {
  let mineralValue = 0n;
  let componentValue = 0n;
  let unpriced = 0;
  const minerals = {};
  let mineralSum = 0;
  for (const id of [...bill.minerals.keys()].sort((a, b) => a - b)) {
    const qty = bill.minerals.get(id);
    if (qty <= 0) continue;
    minerals[`type:${id}`] = qty;
    mineralSum += qty;
    base.usedTypes.add(id);
    mineralValue += BigInt(qty) * BigInt(priceOf(inputs.types.get(id)));
  }
  for (const id of [...bill.leaves.keys()].sort((a, b) => a - b)) {
    base.usedTypes.add(id);
    base.allLeaves.add(id);
    const price = priceOf(inputs.types.get(id));
    if (price > 0) componentValue += BigInt(bill.leaves.get(id)) * BigInt(price);
    else {
      unpriced += 1;
      base.unpricedLeaves.add(id);
    }
  }
  const factor = mineralValue > 0n ? (BigInt(PERMILLE) * (mineralValue + componentValue)) / mineralValue
    : BigInt(PERMILLE);
  return { minerals, mineralSum, mineralValueIsk: Number(mineralValue), componentValueIsk: Number(componentValue),
    componentFactorPermille: Number(factor), unpricedLeaves: unpriced };
}

function checkBuildable(typeId, label, inputs) {
  const row = inputs.types.get(typeId);
  if (!row || row.published !== true) return fail("TYPE_UNKNOWN", `${label} ${typeId}`);
  const bp = inputs.blueprints.get(typeId);
  if (!bp) return fail("NO_BLUEPRINT", `${label} ${typeId}`);
  if (!(bp.timeSec > 0)) return fail("NO_TIME", `${label} ${typeId}`);
  return null;
}

function lowerMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function buildHull(name, spec, inputs, base, method) {
  let members;
  if (Array.isArray(spec.typeIds)) {
    for (const id of spec.typeIds) {
      const refusal = checkBuildable(id, name, inputs);
      if (refusal) return refusal;
    }
    members = [...spec.typeIds].sort((a, b) => a - b);
  } else {
    const groups = new Set(spec.sourceGroups || []);
    members = [...inputs.types.values()].filter((t) => t.published === true && groups.has(t.groupId))
      .map((t) => t.typeId).sort((a, b) => a - b);
  }
  if (members.length === 0) return fail("EMPTY_CLASS", name);
  const candidates = members.filter((id) => inputs.blueprints.has(id)).map((id) => {
    const bill = billOf(id, base);
    let sum = 0;
    for (const v of bill.minerals.values()) sum += v;
    return { typeId: id, bill, sum };
  }).filter((c) => c.sum > 0).sort((a, b) => a.sum - b.sum || a.typeId - b.typeId);
  if (candidates.length === 0) return fail("EMPTY_CLASS", name);
  let rep;
  if (spec.representative === "lowerMedian") rep = candidates[Math.floor((candidates.length - 1) / 2)];
  else {
    if (!members.includes(spec.representative)) return fail("TYPE_UNKNOWN", `${name} representative ${spec.representative}`);
    const refusal = checkBuildable(spec.representative, name, inputs);
    if (refusal) return refusal;
    rep = candidates.find((c) => c.typeId === spec.representative);
    if (!rep) return fail("EMPTY_CLASS", `${name} representative ${spec.representative} has no minerals`);
  }
  const timeSec = inputs.blueprints.get(rep.typeId).timeSec;
  if (!(timeSec > 0)) return fail("NO_TIME", `${name} ${rep.typeId}`);
  for (const id of members) base.usedTypes.add(id);
  const repRow = inputs.types.get(rep.typeId);
  const attrs = method.attributes;
  const dogma = inputs.dogma.get(rep.typeId) || {};
  const usedAttrs = {};
  for (const id of Object.values(attrs)) usedAttrs[id] = typeof dogma[id] === "number" ? dogma[id] : null;
  base.usedDogma.set(rep.typeId, usedAttrs);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const value = valueOf(rep.bill, inputs, base);
  return {
    ok: true,
    row: {
      members,
      representativeTypeId: rep.typeId,
      sampleSize: candidates.length,
      minerals: value.minerals,
      mineralSum: value.mineralSum,
      timeSec,
      mineralValueIsk: value.mineralValueIsk,
      componentValueIsk: value.componentValueIsk,
      componentFactorPermille: value.componentFactorPermille,
      unpricedLeaves: value.unpricedLeaves,
      cargoM3: Math.round(num(repRow.capacity)),
      cargoMedianM3: Math.round(lowerMedian(members.map((id) => num((inputs.types.get(id) || {}).capacity)))),
      oreHoldM3: Math.round(num(dogma[attrs.oreHold])),
      travel: {
        warpSpeedAu: num(dogma[attrs.warpSpeedMultiplier]),
        alignSeconds: round1((LN4 * num(dogma[attrs.agility]) * num(repRow.mass)) / AGILITY_DIVISOR),
        maxVelocityMs: num(dogma[attrs.maxVelocity]),
      },
    },
  };
}

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function resolveOre(name, inputs) {
  const hits = [...inputs.types.values()].filter((t) => t.name === name && t.published === true
    && t.portionSize > 0 && t.volume > 0 && inputs.typeMaterials.has(t.typeId));
  return hits.length === 1 ? hits[0] : null;
}

function buildBand(band, shares, inputs, base, method) {
  let total = 0;
  for (const share of Object.values(shares)) {
    if (!Number.isSafeInteger(share) || share < 0) return fail("SHARES_INVALID", `${band}`);
    total += share;
  }
  if (total !== PERMILLE) return fail("SHARES_INVALID", `${band} sum ${total}`);
  const acc = new Map(method.minerals.map((id) => [id, { n: 0n, d: 1n }]));
  const ores = [];
  for (const [name, share] of Object.entries(shares)) {
    const ore = resolveOre(name, inputs);
    if (!ore) return fail("ORE_UNRESOLVED", name);
    const scaled = Math.round(ore.volume * VOLUME_SCALE);
    if (!(scaled > 0) || Math.abs(ore.volume * VOLUME_SCALE - scaled) > 1e-6) {
      return fail("ORE_VOLUME_PRECISION", `${name} ${ore.volume}`);
    }
    base.usedTypes.add(ore.typeId);
    base.usedOres.add(ore.typeId);
    ores.push({ name, typeId: ore.typeId, sharePermille: share });
    const den = BigInt(ore.portionSize) * BigInt(scaled);
    for (const m of inputs.typeMaterials.get(ore.typeId)) {
      const slot = acc.get(m.typeId);
      if (!slot) continue;
      const num = BigInt(share) * BigInt(m.quantity) * MILLION;
      let n = slot.n * den + num * slot.d;
      let d = slot.d * den;
      const g = gcd(n, d);
      if (g > 1n) {
        n /= g;
        d /= g;
      }
      slot.n = n;
      slot.d = d;
    }
  }
  const mineralsPerMillionM3 = {};
  for (const id of method.minerals) {
    const slot = acc.get(id);
    mineralsPerMillionM3[`type:${id}`] = Number(slot.n / slot.d);
  }
  return { ok: true, row: { ores, mineralsPerMillionM3 } };
}

function serialize(header, hulls, structures, oreBands) {
  const out = [];
  out.push("\"use strict\";");
  out.push("");
  out.push("function deepFreeze(value) {");
  out.push("  if (value && typeof value === \"object\" && !Object.isFrozen(value)) {");
  out.push("    for (const key of Object.keys(value)) deepFreeze(value[key]);");
  out.push("    Object.freeze(value);");
  out.push("  }");
  out.push("  return value;");
  out.push("}");
  out.push("");
  out.push(`const HEADER = ${JSON.stringify(header, null, 2)};`);
  for (const [label, rows] of [["HULLS", hulls], ["STRUCTURES", structures], ["ORE_BANDS", oreBands]]) {
    out.push("");
    out.push(`const ${label} = {`);
    for (const [name, row] of Object.entries(rows)) out.push(`  ${JSON.stringify(name)}: ${JSON.stringify(row)},`);
    out.push("};");
  }
  out.push("");
  out.push("module.exports = deepFreeze({ HEADER, HULLS, STRUCTURES, ORE_BANDS });");
  out.push("");
  return out.join("\n");
}

function buildIndustryCatalog(inputs, method = INDUSTRY_METHOD) {
  if (!inputs || !inputs.sde || !(inputs.types instanceof Map) || !(inputs.dogma instanceof Map)
    || !(inputs.blueprints instanceof Map) || !(inputs.typeMaterials instanceof Map)) {
    return fail("INPUT_INVALID", "inputs need sde, types, dogma, blueprints, typeMaterials (Maps)");
  }
  if (!method || !Array.isArray(method.minerals) || !method.hullClasses || !method.structures || !method.oreBands
    || !method.attributes || !Number.isSafeInteger(method.maxDepth)) {
    return fail("INPUT_INVALID", "method");
  }
  const base = { minerals: new Set(method.minerals), blueprints: inputs.blueprints, maxDepth: method.maxDepth,
    usedBlueprints: new Set(), usedTypes: new Set(method.minerals), usedDogma: new Map(), usedOres: new Set(),
    allLeaves: new Set(), unpricedLeaves: new Set() };

  const hulls = {};
  for (const [name, spec] of Object.entries(method.hullClasses)) {
    const r = buildHull(name, spec, inputs, base, method);
    if (!r.ok) return r;
    hulls[name] = r.row;
  }
  const structures = {};
  for (const [name, typeId] of Object.entries(method.structures)) {
    const refusal = checkBuildable(typeId, name, inputs);
    if (refusal) return refusal;
    base.usedTypes.add(typeId);
    const bill = billOf(typeId, base);
    const value = valueOf(bill, inputs, base);
    structures[name] = { typeId, minerals: value.minerals, mineralSum: value.mineralSum,
      timeSec: inputs.blueprints.get(typeId).timeSec, mineralValueIsk: value.mineralValueIsk,
      componentValueIsk: value.componentValueIsk, componentFactorPermille: value.componentFactorPermille,
      unpricedLeaves: value.unpricedLeaves };
  }
  const oreBands = {};
  for (const [band, shares] of Object.entries(method.oreBands)) {
    const r = buildBand(band, shares, inputs, base, method);
    if (!r.ok) return r;
    oreBands[band] = r.row;
  }

  const byId = (a, b) => a - b;
  const typeRows = [...base.usedTypes].sort(byId).map((id) => {
    const t = inputs.types.get(id) || {};
    const v = (x) => (x === undefined ? null : x);
    return [id, v(t.groupId), v(t.basePrice), v(t.capacity), v(t.volume), v(t.portionSize), v(t.mass)];
  });
  const dogmaRows = [...base.usedDogma.entries()].sort((a, b) => a[0] - b[0]);
  const bpRows = [...base.usedBlueprints].sort(byId).map((product) => {
    const bp = inputs.blueprints.get(product);
    return [product, bp.blueprintTypeId, bp.timeSec, bp.productQuantity, bp.materials.map((x) => [x.typeId, x.quantity])];
  });
  const tmRows = [...base.usedOres].sort(byId)
    .map((id) => [id, inputs.typeMaterials.get(id).map((m) => [m.typeId, m.quantity])]);
  const sourceHash = fingerprint({
    sde: { buildNumber: inputs.sde.buildNumber, releaseDate: inputs.sde.releaseDate },
    method,
    types: typeRows,
    dogma: dogmaRows,
    blueprints: bpRows,
    typeMaterials: tmRows,
  });
  const header = {
    catalogVersion: method.catalogVersion,
    sdeBuild: inputs.sde.buildNumber,
    sdeReleaseDate: inputs.sde.releaseDate,
    sourceHash,
    maxDepth: method.maxDepth,
    attributes: method.attributes,
    classCount: Object.keys(hulls).length,
    structureCount: Object.keys(structures).length,
    ignoredMaterialTypes: base.allLeaves.size,
    unpricedLeafTypes: base.unpricedLeaves.size,
  };
  return { ok: true, header, hulls, structures, oreBands, source: serialize(header, hulls, structures, oreBands) };
}

module.exports = { buildIndustryCatalog, INDUSTRY_METHOD };
