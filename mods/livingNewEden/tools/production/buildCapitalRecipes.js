"use strict";

const { fingerprint } = require("../../lib/util/fingerprint");
const { billOf } = require("./buildRecipes");
const { CLASS_SDE_GROUPS, CLASS_SOURCE_TYPES } = require("../../lib/fleets/data/capitalClasses");

const CAPITAL_METHOD = Object.freeze({
  recipesVersion: 1,
  maxDepth: 4,
  minerals: Object.freeze([34, 35, 36, 37, 38, 39, 40]),
  classSdeGroups: CLASS_SDE_GROUPS,
  classSourceTypes: CLASS_SOURCE_TYPES,
});

const fail = (reason, detail) => ({ ok: false, reason, detail });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function serialize(header, groups) {
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
  out.push("const GROUPS = {");
  for (const [name, row] of Object.entries(groups)) out.push(`  ${JSON.stringify(name)}: ${JSON.stringify(row)},`);
  out.push("};");
  out.push("");
  out.push("module.exports = deepFreeze({ HEADER, GROUPS });");
  out.push("");
  return out.join("\n");
}

function buildCapitalRecipes(inputs, method = CAPITAL_METHOD) {
  if (!inputs || !isObject(inputs.sde) || !(inputs.blueprints instanceof Map) || !isObject(inputs.types)
    || typeof inputs.strengthSourceHash !== "string" || inputs.strengthSourceHash === "") {
    return fail("INPUT_INVALID", "inputs need sde, blueprints, types, strengthSourceHash");
  }
  if (!isObject(method) || !isObject(method.classSourceTypes) || !isObject(method.classSdeGroups)
    || !Array.isArray(method.minerals) || !Number.isSafeInteger(method.maxDepth)) {
    return fail("INPUT_INVALID", "method");
  }
  const read = new Set();
  const recorder = { get(id) { read.add(id); return inputs.blueprints.get(id); } };
  const ctx = { minerals: new Set(method.minerals), blueprints: recorder, maxDepth: method.maxDepth };
  const ignored = new Set();
  const groups = {};
  const sourceTypes = [];
  let missingBlueprints = 0;
  for (const cls of Object.keys(method.classSourceTypes)) {
    const allowed = method.classSdeGroups[cls];
    if (!Array.isArray(allowed) || allowed.length === 0) return fail("INPUT_INVALID", `classSdeGroups.${cls}`);
    const sources = method.classSourceTypes[cls];
    if (!isObject(sources)) return fail("INPUT_INVALID", `classSourceTypes.${cls}`);
    const members = [];
    for (const race of Object.keys(sources).sort()) {
      const typeId = sources[race];
      const row = Object.prototype.hasOwnProperty.call(inputs.types, String(typeId)) ? inputs.types[String(typeId)]
        : null;
      if (!Number.isSafeInteger(typeId) || !isObject(row) || !allowed.includes(row.groupId)) {
        return fail("CLASS_TYPE_MISMATCH", `${cls}.${race} ${typeId}`);
      }
      sourceTypes.push(typeId);
      if (!inputs.blueprints.has(typeId)) {
        missingBlueprints += 1;
        continue;
      }
      const bill = billOf(typeId, ctx, ignored);
      let sum = 0;
      for (const v of bill.values()) sum += v;
      if (sum > 0) members.push({ typeId, bill, sum });
    }
    if (members.length === 0) return fail("EMPTY_CLASS", cls);
    members.sort((a, b) => a.sum - b.sum || a.typeId - b.typeId);
    const rep = members[Math.floor((members.length - 1) / 2)];
    const minerals = {};
    for (const id of [...rep.bill.keys()].sort((a, b) => a - b)) minerals[`type:${id}`] = rep.bill.get(id);
    const timeSec = inputs.blueprints.get(rep.typeId).timeSec;
    if (!(Number.isSafeInteger(timeSec) && timeSec > 0)) return fail("INPUT_INVALID", `${cls} ${rep.typeId} timeSec`);
    groups[cls] = { minerals, timeSec, representativeTypeId: rep.typeId, sampleSize: members.length,
      mineralSum: rep.sum };
  }
  const usedBlueprints = [...read].filter((id) => inputs.blueprints.has(id)).sort((a, b) => a - b)
    .map((product) => {
      const bp = inputs.blueprints.get(product);
      return { product, bp: bp.blueprintTypeId, t: bp.timeSec, q: bp.productQuantity,
        m: bp.materials.map((x) => [x.typeId, x.quantity]) };
    });
  const sourceHash = fingerprint({
    sde: { buildNumber: inputs.sde.buildNumber, releaseDate: inputs.sde.releaseDate },
    method,
    types: [...new Set(sourceTypes)].sort((a, b) => a - b),
    blueprints: usedBlueprints,
  });
  const header = {
    recipesVersion: method.recipesVersion,
    sdeBuild: inputs.sde.buildNumber,
    sdeReleaseDate: inputs.sde.releaseDate,
    strengthSourceHash: inputs.strengthSourceHash,
    sourceHash,
    maxDepth: method.maxDepth,
    missingBlueprints,
    ignoredMaterialTypes: ignored.size,
  };
  return { ok: true, header, groups, source: serialize(header, groups) };
}

module.exports = { buildCapitalRecipes, CAPITAL_METHOD };
