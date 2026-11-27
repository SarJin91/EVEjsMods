"use strict";

const { fingerprint } = require("../../lib/util/fingerprint");

const ATTR_BASE_TYPE = 2711;
const ATTR_GRADE = 2699;
const MINERAL_MIN = 34;
const MINERAL_MAX = 40;
const VELDSPAR = 1230;
const CATALOG_VERSION = 1;
const CRITERIA = "compressible+2711+2699>=1+materials34-40";

const fail = (reason, detail) => ({ ok: false, reason, detail: String(detail) });
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function candidateOf(typeId, inputs) {
  if (!inputs.compressible.has(typeId)) return null;
  const attrs = inputs.dogma.get(typeId);
  if (!attrs) return null;
  const base = Number(attrs[ATTR_BASE_TYPE]);
  const grade = Number(attrs[ATTR_GRADE]);
  if (!isId(base) || !Number.isSafeInteger(grade) || grade < 1) return null;
  const materials = inputs.typeMaterials.get(typeId);
  if (!Array.isArray(materials) || materials.length === 0) return null;
  const minerals = {};
  for (const m of materials) {
    if (!Number.isSafeInteger(m.typeId) || m.typeId < MINERAL_MIN || m.typeId > MINERAL_MAX) return null;
    if (!Number.isSafeInteger(m.quantity) || m.quantity <= 0) return null;
    minerals[`type:${m.typeId}`] = (minerals[`type:${m.typeId}`] || 0) + m.quantity;
  }
  return { typeId, baseTypeId: base, grade, minerals };
}

function sortedObject(entries) {
  const out = {};
  for (const [k, v] of [...entries].sort((a, b) => Number(a[0]) - Number(b[0]))) out[k] = v;
  return out;
}

function sortedMinerals(minerals) {
  const out = {};
  for (const k of Object.keys(minerals).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) out[k] = minerals[k];
  return out;
}

function serialize(header, oreTypes, baseTypeIds, familyByBase) {
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
  out.push("");
  out.push("const ORE_TYPES = {");
  for (const [id, row] of Object.entries(oreTypes)) out.push(`  ${JSON.stringify(id)}: ${JSON.stringify(row)},`);
  out.push("};");
  out.push("");
  out.push(`const BASE_TYPE_IDS = ${JSON.stringify(baseTypeIds)};`);
  out.push("");
  out.push("const FAMILY_BY_BASE = {");
  for (const [id, name] of Object.entries(familyByBase)) out.push(`  ${JSON.stringify(id)}: ${JSON.stringify(name)},`);
  out.push("};");
  out.push("");
  out.push("module.exports = deepFreeze({ HEADER, ORE_TYPES, BASE_TYPE_IDS, FAMILY_BY_BASE });");
  out.push("");
  return out.join("\n");
}

function buildOreTypes(inputs) {
  if (!inputs || !inputs.sde || !(inputs.dogma instanceof Map) || !(inputs.typeMaterials instanceof Map)
    || !(inputs.compressible instanceof Set) || !(inputs.names instanceof Map)) {
    return fail("INPUT_INVALID", "inputs need sde, dogma, typeMaterials (Maps), compressible (Set), names (Map)");
  }
  const candidates = new Map();
  const selfBasedExcluded = [];
  for (const typeId of [...inputs.compressible].sort((a, b) => a - b)) {
    const row = candidateOf(typeId, inputs);
    if (row && row.baseTypeId === row.typeId && row.grade !== 1) selfBasedExcluded.push(typeId);
    else if (row) candidates.set(typeId, row);
  }
  const byBaseGrade = new Map();
  const baseMissing = [...candidates.values()].filter((row) => {
    const base = candidates.get(row.baseTypeId);
    return !base || base.grade !== 1 || base.baseTypeId !== base.typeId;
  });
  if (baseMissing.length > 0) {
    return fail("ORE_BASE_MISSING", baseMissing.map((r) => `${r.typeId}->${r.baseTypeId}/g${r.grade}`).join(","));
  }
  for (const row of candidates.values()) {
    const key = `${row.baseTypeId}:${row.grade}`;
    if (byBaseGrade.has(key)) {
      return fail("ORE_DUPLICATE_GRADE", `${byBaseGrade.get(key)} and ${row.typeId} share base ${row.baseTypeId} grade ${row.grade}`);
    }
    byBaseGrade.set(key, row.typeId);
  }
  if (!candidates.has(VELDSPAR)) return fail("ORE_SET_EMPTY", `no ${VELDSPAR}`);

  const baseTypeIds = [...new Set([...candidates.values()].map((r) => r.baseTypeId))].sort((a, b) => a - b);
  const familyByBase = sortedObject([...inputs.names].filter(([id]) => baseTypeIds.includes(id))
    .map(([id, name]) => [String(id), String(name)]));
  const oreTypes = sortedObject([...candidates.values()].map((r) => [String(r.typeId), {
    typeId: r.typeId, baseTypeId: r.baseTypeId, grade: r.grade,
    family: Object.prototype.hasOwnProperty.call(familyByBase, String(r.baseTypeId)) ? familyByBase[String(r.baseTypeId)] : null,
    minerals: sortedMinerals(r.minerals),
  }]));

  const rows = Object.values(oreTypes).map((r) => [r.typeId, r.baseTypeId, r.grade,
    Object.entries(r.minerals).map(([k, q]) => [Number(k.slice(5)), q])]);
  const names = Object.entries(familyByBase).map(([id, name]) => [Number(id), name]);
  const sourceHash = fingerprint({ sde: { buildNumber: inputs.sde.buildNumber, releaseDate: inputs.sde.releaseDate },
    criteria: CRITERIA, rows, names, selfBasedExcluded });
  const header = {
    catalogVersion: CATALOG_VERSION,
    sdeBuild: inputs.sde.buildNumber,
    sdeReleaseDate: inputs.sde.releaseDate,
    sourceHash,
    oreCount: rows.length,
    baseCount: baseTypeIds.length,
    namedFamilies: names.length,
    criteria: CRITERIA,
    selfBasedExcluded,
  };
  return { ok: true, header, oreTypes, baseTypeIds, familyByBase,
    source: serialize(header, oreTypes, baseTypeIds, familyByBase) };
}

module.exports = { buildOreTypes, CRITERIA, ATTR_BASE_TYPE, ATTR_GRADE };
