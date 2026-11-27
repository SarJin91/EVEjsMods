"use strict";

const { fingerprint } = require("../../lib/util/fingerprint");

const RECIPE_METHOD = Object.freeze({
  recipesVersion: 1,
  maxDepth: 4,
  minerals: Object.freeze([34, 35, 36, 37, 38, 39, 40]),
  hullGroups: Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "logistics", "ewar",
    "tackle", "industrial", "capital"]),
  sourceGroups: Object.freeze({
    frigate: Object.freeze([25, 324, 830, 834]),
    destroyer: Object.freeze([420, 1305, 1534]),
    cruiser: Object.freeze([26, 358]),
    battlecruiser: Object.freeze([419, 1201]),
    battleship: Object.freeze([27]),
    logistics: Object.freeze([832, 1527]),
    ewar: Object.freeze([833, 893, 906]),
    tackle: Object.freeze([541, 831, 894]),
    industrial: Object.freeze([28, 463]),
    capital: Object.freeze([485, 547, 1538, 4594]),
  }),
});

const fail = (reason, detail) => ({ ok: false, reason, detail });

function expand(typeId, quantity, depth, path, ctx, out, ignored) {
  if (ctx.minerals.has(typeId)) {
    out.set(typeId, (out.get(typeId) || 0) + quantity);
    return;
  }
  const bp = ctx.blueprints.get(typeId);
  if (!bp || depth > ctx.maxDepth || path.has(typeId) || !(bp.productQuantity > 0)) {
    ignored.add(typeId);
    return;
  }
  const runs = Math.ceil(quantity / bp.productQuantity);
  path.add(typeId);
  for (const m of bp.materials) expand(m.typeId, m.quantity * runs, depth + 1, path, ctx, out, ignored);
  path.delete(typeId);
}

function billOf(typeId, ctx, ignored) {
  const bp = ctx.blueprints.get(typeId);
  const out = new Map();
  const path = new Set([typeId]);
  for (const m of bp.materials) expand(m.typeId, m.quantity, 1, path, ctx, out, ignored);
  return out;
}

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

function buildRecipes(inputs, method = RECIPE_METHOD) {
  if (!inputs || !inputs.sde || !Array.isArray(inputs.types) || !(inputs.blueprints instanceof Map)) {
    return fail("INPUT_INVALID", "inputs need sde, types, blueprints");
  }
  const ctx = { minerals: new Set(method.minerals), blueprints: inputs.blueprints, maxDepth: method.maxDepth };
  const ignored = new Set();
  const groups = {};
  const used = [];
  for (const name of method.hullGroups) {
    const source = new Set(method.sourceGroups[name] || []);
    const members = inputs.types.filter((t) => t.published === true && source.has(t.groupId)
      && inputs.blueprints.has(t.typeId))
      .map((t) => {
        const bill = billOf(t.typeId, ctx, ignored);
        let sum = 0;
        for (const v of bill.values()) sum += v;
        return { typeId: t.typeId, bill, sum };
      })
      .filter((t) => t.sum > 0)
      .sort((a, b) => a.sum - b.sum || a.typeId - b.typeId);
    if (members.length === 0) return fail("EMPTY_GROUP", name);
    const rep = members[Math.floor((members.length - 1) / 2)];
    const minerals = {};
    for (const id of [...rep.bill.keys()].sort((a, b) => a - b)) minerals[`type:${id}`] = rep.bill.get(id);
    const timeSec = inputs.blueprints.get(rep.typeId).timeSec;
    if (!(timeSec > 0)) return fail("NO_TIME", `${name} ${rep.typeId}`);
    groups[name] = { minerals, timeSec, representativeTypeId: rep.typeId, sampleSize: members.length,
      mineralSum: rep.sum };
    used.push(...members.map((m) => m.typeId));
  }
  const usedBlueprints = [...inputs.blueprints.entries()].sort((a, b) => a[0] - b[0])
    .map(([product, bp]) => ({ product, bp: bp.blueprintTypeId, t: bp.timeSec, q: bp.productQuantity,
      m: bp.materials.map((x) => [x.typeId, x.quantity]) }));
  const sourceHash = fingerprint({
    sde: { buildNumber: inputs.sde.buildNumber, releaseDate: inputs.sde.releaseDate },
    method,
    types: [...new Set(used)].sort((a, b) => a - b),
    blueprints: usedBlueprints,
  });
  const header = {
    recipesVersion: method.recipesVersion,
    sdeBuild: inputs.sde.buildNumber,
    sdeReleaseDate: inputs.sde.releaseDate,
    sourceHash,
    maxDepth: method.maxDepth,
    sourceGroups: method.sourceGroups,
    typeCount: used.length,
    ignoredMaterialTypes: ignored.size,
  };
  return { ok: true, header, groups, source: serialize(header, groups) };
}

module.exports = { buildRecipes, RECIPE_METHOD, expand, billOf };
