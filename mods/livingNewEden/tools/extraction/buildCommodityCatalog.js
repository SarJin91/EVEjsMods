"use strict";

const { fingerprint } = require("../../lib/util/fingerprint");
const { computePiTiers } = require("../../lib/economy/extraction/catalog");
const { buildAdvancedBills } = require("./buildAdvancedBills");

const ATTR_REPROCESS_SKILL = 790;
const ATTR_BASE_TYPE = 2711;
const ATTR_GRADE = 2699;
const ATTR_MOON_CHUNK = 2727;
const MINERAL_MIN = 34;
const MINERAL_MAX = 40;
const MOON_TIERS = Object.freeze(["r4", "r8", "r16", "r32", "r64"]);
const MOON_ORE_PORTION = 100;
const FUEL_BLOCK_TYPE_IDS = Object.freeze([4051, 4246, 4247, 4312]);
const GENERATOR = 2;
const ADVANCED_MAX_DEPTH = 6;
const CRITERIA = "base(2711=self,2699=1)+790+2727+material outside 34-40";

const fail = (reason, detail) => ({ ok: false, reason, detail: String(detail) });
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const byNum = (a, b) => a - b;

function sortedObject(entries) {
  const out = {};
  for (const [k, v] of [...entries].sort((a, b) => Number(a[0]) - Number(b[0]))) out[String(k)] = v;
  return out;
}

function buildMoon(inputs) {
  const candidates = [];
  for (const typeId of [...inputs.dogma.keys()].sort(byNum)) {
    const attrs = inputs.dogma.get(typeId) || {};
    if (Number(attrs[ATTR_BASE_TYPE]) !== typeId || Number(attrs[ATTR_GRADE]) !== 1) continue;
    if (!isId(Number(attrs[ATTR_REPROCESS_SKILL])) || attrs[ATTR_MOON_CHUNK] === undefined) continue;
    const materials = new Map();
    for (const m of inputs.typeMaterials.get(typeId) || []) {
      if (!isId(m.typeId) || !isId(m.quantity)) continue;
      if (m.typeId >= MINERAL_MIN && m.typeId <= MINERAL_MAX) continue;
      materials.set(m.typeId, (materials.get(m.typeId) || 0) + m.quantity);
    }
    if (materials.size === 0) continue;
    candidates.push({ typeId, skill: Number(attrs[ATTR_REPROCESS_SKILL]), materials });
  }
  const skills = [...new Set(candidates.map((c) => c.skill))].sort(byNum);
  if (skills.length !== MOON_TIERS.length) {
    return fail("MOON_TIERS_MISMATCH", `${skills.length} distinct 790 values (${skills.join(",")}), expected 5`);
  }
  const tierOfSkill = new Map(skills.map((s, i) => [s, i]));
  const ores = [];
  const materialTier = new Map();
  for (const c of candidates) {
    const tierIndex = tierOfSkill.get(c.skill);
    for (const m of c.materials.keys()) {
      if (!materialTier.has(m) || materialTier.get(m) > tierIndex) materialTier.set(m, tierIndex);
    }
    ores.push([c.typeId, { tier: MOON_TIERS[tierIndex], portion: MOON_ORE_PORTION,
      materials: sortedObject([...c.materials].map(([m, q]) => [String(m), q])) }]);
  }
  for (const tier of MOON_TIERS) {
    if (!ores.some(([, o]) => o.tier === tier)) return fail("MOON_TIER_EMPTY", tier);
  }
  for (const [, o] of ores) {
    for (const m of Object.keys(o.materials)) {
      if (!materialTier.has(Number(m))) return fail("MOON_MATERIAL_UNTIERED", m);
    }
  }
  return { ok: true, skills, moonOres: sortedObject(ores),
    moonMaterialTier: sortedObject([...materialTier].map(([m, t]) => [String(m), MOON_TIERS[t]])) };
}

function buildPi(inputs) {
  const rows = [];
  for (const s of inputs.schematics) {
    const types = Array.isArray(s && s.types) ? s.types : [];
    const outs = types.filter((t) => t && t.isInput === false);
    const ins = types.filter((t) => t && t.isInput === true);
    if (outs.length !== 1 || ins.length === 0 || !isId(Number(s.cycleTime))
      || ![...outs, ...ins].every((t) => isId(t._key) && isId(t.quantity))) {
      return fail("PI_SCHEMATIC_INVALID", s && s._key);
    }
    rows.push([outs[0]._key, outs[0].quantity, Number(s.cycleTime),
      ins.map((t) => [t._key, t.quantity]).sort((a, b) => a[0] - b[0])]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const computed = computePiTiers(rows);
  if (!computed.ok) return fail("PI_CYCLE", computed.detail);
  const piTier = sortedObject([...computed.tiers].map(([id, t]) => [String(id), t]));
  const p1OfP0 = new Map();
  for (const [out, , , ins] of rows) {
    if (ins.length !== 1 || computed.tiers.get(ins[0][0]) !== 0) continue;
    if (p1OfP0.has(ins[0][0])) return fail("P0_TWO_P1", `${ins[0][0]} -> ${p1OfP0.get(ins[0][0])}, ${out}`);
    p1OfP0.set(ins[0][0], out);
  }
  const p0s = [...computed.tiers].filter(([, t]) => t === 0).map(([id]) => id).sort(byNum);
  const orphan = p0s.filter((p0) => !p1OfP0.has(p0));
  if (orphan.length > 0) return fail("P0_WITHOUT_P1", orphan.join(","));
  return { ok: true, rows, piTier, tiers: computed.tiers,
    p1OfP0: sortedObject([...p1OfP0].map(([a, b]) => [String(a), b])) };
}

function buildFuel(inputs, tiers) {
  const blocks = [];
  const skipped = new Set();
  for (const blockId of [...inputs.fuelBlockTypeIds].sort(byNum)) {
    const bp = inputs.blueprints.get(blockId);
    if (!bp || !Array.isArray(bp.materials) || !isId(bp.productQuantity)) {
      return fail("FUEL_BLOCK_NO_BLUEPRINT", blockId);
    }
    const pi = [];
    for (const m of bp.materials) {
      if (tiers.has(m.typeId) && isId(m.quantity)) pi.push([String(m.typeId), m.quantity]);
      else skipped.add(m.typeId);
    }
    if (pi.length === 0) return fail("FUEL_BLOCK_NO_PI", blockId);
    blocks.push([String(blockId), { batch: bp.productQuantity, blueprint: bp.blueprintTypeId, pi: sortedObject(pi) }]);
  }
  return { ok: true, fuelBlocks: sortedObject(blocks.map(([id, b]) => [id, { batch: b.batch, pi: b.pi }])),
    blueprints: blocks.map(([id, b]) => [Number(id), b.blueprint]), skipped: [...skipped].sort(byNum) };
}

function serialize(data, header) {
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
  out.push(`const SOURCE = ${JSON.stringify(data.SOURCE, null, 2)};`);
  out.push("");
  out.push(`const MOON_TIERS = ${JSON.stringify(data.MOON_TIERS)};`);
  out.push("");
  const objectBlock = (name, obj) => {
    out.push(`const ${name} = {`);
    for (const [k, v] of Object.entries(obj)) out.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    out.push("};");
    out.push("");
  };
  objectBlock("MOON_ORES", data.MOON_ORES);
  objectBlock("MOON_MATERIAL_TIER", data.MOON_MATERIAL_TIER);
  objectBlock("PI_TIER", data.PI_TIER);
  out.push("const SCHEMATICS = [");
  for (const row of data.SCHEMATICS) out.push(`  ${JSON.stringify(row)},`);
  out.push("];");
  out.push("");
  objectBlock("P1_OF_P0", data.P1_OF_P0);
  objectBlock("FUEL_BLOCKS", data.FUEL_BLOCKS);
  objectBlock("ADVANCED_BILLS", data.ADVANCED_BILLS);
  out.push("module.exports = deepFreeze({ SOURCE, MOON_TIERS, MOON_ORES, MOON_MATERIAL_TIER, PI_TIER, SCHEMATICS,");
  out.push("  P1_OF_P0, FUEL_BLOCKS, ADVANCED_BILLS });");
  out.push("");
  return out.join("\n");
}

function buildCommodityCatalog(inputs) {
  if (!inputs || !inputs.sde || !(inputs.dogma instanceof Map) || !(inputs.typeMaterials instanceof Map)
    || !Array.isArray(inputs.schematics) || !(inputs.blueprints instanceof Map)) {
    return fail("INPUT_INVALID", "inputs need sde, dogma, typeMaterials, blueprints (Maps), schematics (array)");
  }
  const fuelIds = inputs.fuelBlockTypeIds || FUEL_BLOCK_TYPE_IDS;
  const moon = buildMoon(inputs);
  if (!moon.ok) return moon;
  const pi = buildPi(inputs);
  if (!pi.ok) return pi;
  const fuel = buildFuel({ ...inputs, fuelBlockTypeIds: fuelIds }, pi.tiers);
  if (!fuel.ok) return fuel;
  let advanced = { bills: {}, skipped: [], usedReactions: [] };
  const withAdvanced = inputs.reactions instanceof Map && Array.isArray(inputs.representatives);
  if (withAdvanced) {
    advanced = buildAdvancedBills({ representatives: inputs.representatives, blueprints: inputs.blueprints,
      reactions: inputs.reactions, moonMaterialTier: moon.moonMaterialTier, piTier: pi.piTier,
      fuelBlocks: fuel.fuelBlocks, maxDepth: ADVANCED_MAX_DEPTH });
    if (!advanced.ok) return fail(advanced.reason, advanced.detail);
  }
  const recipeHashes = inputs.recipeHashes || {};

  const sourceHash = fingerprint({
    sde: { buildNumber: inputs.sde.buildNumber, releaseDate: inputs.sde.releaseDate },
    criteria: CRITERIA, generator: GENERATOR, portion: MOON_ORE_PORTION, skills: moon.skills,
    moonOres: Object.entries(moon.moonOres).map(([id, o]) => [Number(id), o.tier,
      Object.entries(o.materials).map(([m, q]) => [Number(m), q])]),
    schematics: pi.rows, fuelBlueprints: fuel.blueprints,
    fuel: Object.entries(fuel.fuelBlocks).map(([id, b]) => [Number(id), b.batch,
      Object.entries(b.pi).map(([m, q]) => [Number(m), q])]),
    advanced: withAdvanced ? { maxDepth: ADVANCED_MAX_DEPTH,
      representatives: [...inputs.representatives].map(([g, id]) => [g, id])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      recipeHashes: { hull: recipeHashes.hull || null, capital: recipeHashes.capital || null,
        industry: recipeHashes.industry || null },
      reactions: advanced.usedReactions } : null,
  });
  const data = {
    SOURCE: { sdeBuild: inputs.sde.buildNumber, sourceHash, generator: GENERATOR },
    MOON_TIERS: [...MOON_TIERS],
    MOON_ORES: moon.moonOres,
    MOON_MATERIAL_TIER: moon.moonMaterialTier,
    PI_TIER: pi.piTier,
    SCHEMATICS: pi.rows,
    P1_OF_P0: pi.p1OfP0,
    FUEL_BLOCKS: fuel.fuelBlocks,
    ADVANCED_BILLS: advanced.bills,
  };
  const summary = { skillByTier: MOON_TIERS.map((t, i) => [t, moon.skills[i]]),
    skippedFuelInputs: fuel.skipped, advancedSkipped: advanced.skipped };
  return { ok: true, data, summary, source: serialize(data, { sdeBuild: inputs.sde.buildNumber,
    sdeReleaseDate: inputs.sde.releaseDate }) };
}

module.exports = { buildCommodityCatalog, FUEL_BLOCK_TYPE_IDS, MOON_TIERS, CRITERIA, ATTR_REPROCESS_SKILL,
  ATTR_BASE_TYPE, ATTR_GRADE, ATTR_MOON_CHUNK, ADVANCED_MAX_DEPTH };
