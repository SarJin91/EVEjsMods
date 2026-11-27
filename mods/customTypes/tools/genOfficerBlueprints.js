"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { serializePack } = require("./genPiBlueprints.js");

const GENERATOR = "mods/customTypes/tools/genOfficerBlueprints.js";
const MAX_SKILL_LEVEL = 5;
const MAX_DESCRIPTION_LENGTH = 2000;
const SECONDS_PER_DAY = 86400;

const META_TECH2 = 2;
const META_FACTION = 4;
const META_OFFICER = 5;
const META_DEADSPACE = 6;
const EFFECT_TURRET_FITTED = 42;
const EFFECT_LAUNCHER_FITTED = 40;
const ATTRIBUTE_CHARGE_SIZE = 128;
const BLUEPRINT_CATEGORY_ID = 9;

const SIZES = Object.freeze(["S", "M", "L", "XL", "unsized"]);
const GENERIC_FAMILY = "generic";
const ROMAN = Object.freeze(["", "I", "II", "III", "IV", "V"]);

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPositiveNumber = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const normalName = (name) => String(name).trim().toLowerCase();
const byTypeID = (a, b) => a.typeID - b.typeID;
const apostrophes = (name) => String(name).replace(/’/gu, "'");

function eachJsonLine(text, onRow) {
  const lines = String(text).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      return `line ${index + 1}: ${error.message}`;
    }
    if (!isPlainObject(row) || !Number.isSafeInteger(row._key) || row._key < 0) return `line ${index + 1}: bad _key`;
    const problem = onRow(row, index + 1);
    if (problem) return problem;
  }
  return null;
}

function parseTypesJsonl(text) {
  const types = new Map();
  const problem = eachJsonLine(text, (row) => {
    let name = "";
    if (typeof row.name === "string") name = row.name;
    else if (isPlainObject(row.name) && typeof row.name.en === "string") name = row.name.en;
    types.set(row._key, {
      typeID: row._key,
      name: name.trim(),
      groupID: Number.isSafeInteger(row.groupID) ? row.groupID : 0,
      iconID: isPositiveInteger(row.iconID) ? row.iconID : null,
      metaGroupID: Number.isSafeInteger(row.metaGroupID) ? row.metaGroupID : null,
      metaLevel: typeof row.metaLevel === "number" && Number.isFinite(row.metaLevel) ? row.metaLevel : 0,
      published: row.published === true,
      variationParentTypeID: isPositiveInteger(row.variationParentTypeID) ? row.variationParentTypeID : null,
    });
    return null;
  });
  return problem ? { ok: false, reason: problem } : { ok: true, types };
}

function parseGroupsJsonl(text) {
  const groupCategory = new Map();
  const problem = eachJsonLine(text, (row) => {
    if (Number.isSafeInteger(row.categoryID)) groupCategory.set(row._key, row.categoryID);
    return null;
  });
  return problem ? { ok: false, reason: problem } : { ok: true, groupCategory };
}

function parseBlueprintsJsonl(text) {
  const blueprintByProduct = new Map();
  const problem = eachJsonLine(text, (row) => {
    const manufacturing = isPlainObject(row.activities) ? row.activities.manufacturing : null;
    const product = manufacturing && Array.isArray(manufacturing.products) ? manufacturing.products[0] : null;
    if (!product || !isPositiveInteger(product.typeID)) return null;
    const current = blueprintByProduct.get(product.typeID);
    if (current === undefined || row._key < current) blueprintByProduct.set(product.typeID, row._key);
    return null;
  });
  return problem ? { ok: false, reason: problem } : { ok: true, blueprintByProduct };
}

const DOGMA_KEY = /^\{"_key":\s*(\d+)\s*,/u;

function parseTypeDogmaJsonl(text, wanted) {
  const dogma = new Map();
  const lines = String(text).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = DOGMA_KEY.exec(line);
    if (!match || !wanted.has(Number(match[1]))) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      return { ok: false, reason: `line ${index + 1}: ${error.message}` };
    }
    const effects = new Set((Array.isArray(row.dogmaEffects) ? row.dogmaEffects : [])
      .map((entry) => entry && entry.effectID).filter(Number.isSafeInteger));
    const charge = (Array.isArray(row.dogmaAttributes) ? row.dogmaAttributes : [])
      .find((entry) => entry && entry.attributeID === ATTRIBUTE_CHARGE_SIZE);
    dogma.set(row._key, { effects, chargeSize: charge && typeof charge.value === "number" ? charge.value : null });
  }
  return { ok: true, dogma };
}

function officerParentIDs(types) {
  const parents = new Set();
  for (const type of types.values()) {
    if (type.metaGroupID === META_OFFICER && type.variationParentTypeID) parents.add(type.variationParentTypeID);
  }
  return parents;
}

function checkPairs(list, label, types, { published = false } = {}) {
  if (!Array.isArray(list)) return `${label} is not a list`;
  const seen = new Set();
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isPositiveInteger(pair[0]) || !isPositiveInteger(pair[1])) {
      return `${label}: entry ${JSON.stringify(pair)} is not [typeID, positive integer]`;
    }
    const type = types.get(pair[0]);
    if (!type) return `${label}: type ${pair[0]} not found in the SDE`;
    if (published && !type.published) return `${label}: type ${pair[0]} is not published`;
    if (seen.has(pair[0])) return `${label}: type ${pair[0]} listed twice`;
    seen.add(pair[0]);
  }
  return null;
}

const isSize = (value) => SIZES.includes(value);

function checkSpec(spec, types) {
  if (!isPlainObject(spec)) return "spec is not an object";
  if (spec.specVersion !== 1) return "spec.specVersion must be 1";
  if (typeof spec.packID !== "string" || spec.packID.trim() === "") return "spec.packID missing";
  for (const key of ["packVersion", "typeIDMin", "typeIDMax", "sourceTypeID", "maxProductionLimit", "baseTimeSeconds"]) {
    if (!isPositiveInteger(spec[key])) return `spec.${key} must be a positive integer`;
  }
  if (spec.typeIDMin > spec.typeIDMax) return "spec.typeIDMin above spec.typeIDMax";
  if (!types.has(spec.sourceTypeID)) return `spec.sourceTypeID ${spec.sourceTypeID} not found`;
  if (typeof spec.basePrice !== "number" || !Number.isFinite(spec.basePrice) || spec.basePrice < 0) {
    return "spec.basePrice must be a number >= 0";
  }
  if (spec.marketGroupID !== null && !isPositiveInteger(spec.marketGroupID)) {
    return "spec.marketGroupID must be null or a positive integer";
  }
  if (typeof spec.nameSuffix !== "string" || spec.nameSuffix.trim() === "") return "spec.nameSuffix missing";
  const skillProblem = checkPairs(spec.skills, "spec.skills", types);
  if (skillProblem) return skillProblem;
  if (spec.skills.some(([, level]) => level > MAX_SKILL_LEVEL)) return `spec.skills: level above ${MAX_SKILL_LEVEL}`;
  for (const key of ["sizeFactor", "timeFactor"]) {
    if (!isPlainObject(spec[key])) return `spec.${key} missing`;
    for (const size of SIZES) if (!isPositiveNumber(spec[key][size])) return `spec.${key}.${size} must be a number > 0`;
  }
  if (!isPositiveNumber(spec.weaponFactor)) return "spec.weaponFactor must be a number > 0";
  if (!isPositiveNumber(spec.genericMoonFactor)) return "spec.genericMoonFactor must be a number > 0";
  for (const key of ["turretSizeByChargeSize", "launcherSizeByGroup"]) {
    if (!isPlainObject(spec[key])) return `spec.${key} missing`;
    for (const [id, size] of Object.entries(spec[key])) if (!isSize(size)) return `spec.${key}.${id}: bad size ${size}`;
  }
  if (!isSize(spec.launcherDefaultSize)) return "spec.launcherDefaultSize: bad size";
  if (!Array.isArray(spec.sizeTokens)) return "spec.sizeTokens is not a list";
  for (const token of spec.sizeTokens) {
    if (!Array.isArray(token) || token.length !== 2 || !isSize(token[0]) || typeof token[1] !== "string") {
      return `spec.sizeTokens: entry ${JSON.stringify(token)} is not [size, regex]`;
    }
    try {
      new RegExp(token[1], "u"); // eslint-disable-line no-new
    } catch (error) {
      return `spec.sizeTokens ${token[0]}: ${error.message}`;
    }
  }
  if (!isPlainObject(spec.moduleCounts)) return "spec.moduleCounts missing";
  for (const key of ["faction", "deadspace", "onlyOne", "t2", "t1IfNoT2"]) {
    if (!isPositiveInteger(spec.moduleCounts[key])) return `spec.moduleCounts.${key} must be a positive integer`;
  }
  const materialProblem = checkPairs(spec.minerals, "spec.minerals", types, { published: true })
    || checkPairs(spec.moonMaterials, "spec.moonMaterials", types, { published: true });
  if (materialProblem) return materialProblem;
  if (!isPlainObject(spec.families)) return "spec.families missing";
  const officers = new Set();
  for (const [family, entry] of Object.entries(spec.families)) {
    if (family === GENERIC_FAMILY) return `spec.families: ${GENERIC_FAMILY} is reserved`;
    if (!isPlainObject(entry)) return `spec.families.${family} is not an object`;
    for (const key of ["officers", "factionPrefixes", "deadspacePrefixes"]) {
      if (!Array.isArray(entry[key]) || entry[key].length === 0
        || !entry[key].every((value) => typeof value === "string" && value.trim() !== "")) {
        return `spec.families.${family}.${key} must be a list of names`;
      }
    }
    for (const officer of entry.officers) {
      if (officers.has(officer)) return `spec.families: officer ${officer} in two families`;
      officers.add(officer);
    }
    const tagProblem = checkPairs(entry.tags, `spec.families.${family}.tags`, types, { published: true });
    if (tagProblem) return tagProblem;
  }
  if (!isPlainObject(spec.allocations)) return "spec.allocations missing";
  const seen = new Map();
  for (const [key, typeID] of Object.entries(spec.allocations)) {
    if (!/^[1-9]\d*$/u.test(key)) return `spec.allocations: bad officer typeID ${key}`;
    if (!Number.isSafeInteger(typeID) || typeID < spec.typeIDMin || typeID > spec.typeIDMax) {
      return `spec.allocations: officer ${key} -> ${JSON.stringify(typeID)} outside ${spec.typeIDMin}-${spec.typeIDMax}`;
    }
    if (seen.has(typeID)) return `spec.allocations: ${typeID} allocated to officers ${seen.get(typeID)} and ${key}`;
    if (types.has(typeID)) return `spec.allocations: ${typeID} (officer ${key}) already exists in the SDE`;
    seen.set(typeID, key);
  }
  return null;
}

function familyOf(name, spec) {
  const text = apostrophes(name);
  for (const [family, entry] of Object.entries(spec.families)) {
    if (entry.officers.some((officer) => text.startsWith(`${officer}'s `) || text.startsWith(`${officer}' `))) return family;
  }
  return GENERIC_FAMILY;
}

function pickVariant(candidates, prefixes) {
  const best = (list) => [...list].sort((a, b) => b.metaLevel - a.metaLevel || a.typeID - b.typeID)[0] || null;
  if (prefixes.length > 0) {
    const prefixed = candidates.filter((type) => prefixes.some((prefix) => type.name.startsWith(prefix)));
    if (prefixed.length > 0) return best(prefixed);
  }
  return best(candidates);
}

function sizeOf(parent, dogma, spec) {
  const record = dogma.get(parent.typeID);
  const effects = record ? record.effects : new Set();
  if (effects.has(EFFECT_TURRET_FITTED)) {
    const charge = record.chargeSize;
    const size = charge === null ? undefined : spec.turretSizeByChargeSize[String(charge)];
    return { size: size || "unsized", weapon: true, launcherDefault: false };
  }
  if (effects.has(EFFECT_LAUNCHER_FITTED)) {
    const size = spec.launcherSizeByGroup[String(parent.groupID)];
    return { size: size || spec.launcherDefaultSize, weapon: true, launcherDefault: !size };
  }
  for (const [size, source] of spec.sizeTokens) {
    if (new RegExp(source, "u").test(parent.name)) return { size, weapon: false, launcherDefault: false };
  }
  return { size: "unsized", weapon: false, launcherDefault: false };
}

function daysText(seconds) {
  const days = Number((seconds / SECONDS_PER_DAY).toFixed(2));
  return `${days} day${days === 1 ? "" : "s"}`;
}

function buildOfficerBlueprintPack(sde, spec, options = {}) {
  if (!isPlainObject(sde) || !(sde.types instanceof Map) || !(sde.groupCategory instanceof Map)
    || !(sde.blueprintByProduct instanceof Map) || !(sde.dogma instanceof Map)) {
    return { ok: false, reason: "sde must hold the Maps types, groupCategory, blueprintByProduct, dogma" };
  }
  const { types, groupCategory, blueprintByProduct, dogma } = sde;
  const specProblem = checkSpec(spec, types);
  if (specProblem) return { ok: false, reason: specProblem };
  const allocate = Boolean(options && options.allocate);

  const takenNames = new Set();
  const childrenOf = new Map();
  for (const type of types.values()) {
    if (type.name) takenNames.add(normalName(type.name));
    if (type.variationParentTypeID && type.published) {
      if (!childrenOf.has(type.variationParentTypeID)) childrenOf.set(type.variationParentTypeID, []);
      childrenOf.get(type.variationParentTypeID).push(type);
    }
  }
  const officers = [...types.values()].filter((type) => type.metaGroupID === META_OFFICER).sort(byTypeID);
  const typeName = (typeID) => (types.get(typeID) || { name: String(typeID) }).name;
  const skillText = spec.skills.map(([typeID, level]) => `${typeName(typeID)} ${ROMAN[level]}`).join(", ");

  const excluded = [];
  const exclude = (officer, reason) => excluded.push({ typeID: officer.typeID, name: officer.name, reason });
  const bySize = Object.fromEntries(SIZES.map((size) => [size, 0]));
  const byFamily = Object.fromEntries([...Object.keys(spec.families), GENERIC_FAMILY].map((family) => [family, 0]));
  let launcherDefault = 0;
  const recipes = [];
  for (const officer of officers) {
    if (!officer.published) { exclude(officer, "NOT_PUBLISHED"); continue; }
    const parent = officer.variationParentTypeID ? types.get(officer.variationParentTypeID) : null;
    if (!parent) { exclude(officer, "NO_PARENT"); continue; }
    if (blueprintByProduct.has(officer.typeID)) { exclude(officer, "VANILLA_BLUEPRINT"); continue; }
    const siblings = childrenOf.get(parent.typeID) || [];
    const family = familyOf(officer.name, spec);
    const prefixes = (key) => (family === GENERIC_FAMILY ? [] : spec.families[family][key]);
    const faction = pickVariant(siblings.filter((type) => type.metaGroupID === META_FACTION), prefixes("factionPrefixes"));
    const deadspace = pickVariant(siblings.filter((type) => type.metaGroupID === META_DEADSPACE), prefixes("deadspacePrefixes"));
    if (!faction && !deadspace) { exclude(officer, "NO_FACTION_OR_DEADSPACE"); continue; }
    const parentBlueprintID = blueprintByProduct.get(parent.typeID);
    const parentBlueprint = parentBlueprintID === undefined ? null : types.get(parentBlueprintID);
    if (!parentBlueprint || groupCategory.get(parentBlueprint.groupID) !== BLUEPRINT_CATEGORY_ID) {
      exclude(officer, "NO_PARENT_BLUEPRINT");
      continue;
    }
    if (!officer.iconID) { exclude(officer, "NO_ICON"); continue; }
    const t2 = siblings.filter((type) => type.metaGroupID === META_TECH2).sort(byTypeID)[0] || null;
    recipes.push({ officer, parent, family, faction, deadspace, t2, groupID: parentBlueprint.groupID });
  }

  const allocations = new Map(Object.entries(spec.allocations).map(([key, typeID]) => [Number(key), typeID]));
  const used = new Set(allocations.values());
  let cursor = spec.typeIDMin;
  let newAllocations = 0;
  for (const { officer } of recipes) {
    if (allocations.has(officer.typeID)) continue;
    if (!allocate) return { ok: false, reason: `officer ${officer.typeID} has no allocation (run --allocate)` };
    while (cursor <= spec.typeIDMax && (used.has(cursor) || types.has(cursor))) cursor += 1;
    if (cursor > spec.typeIDMax) {
      return { ok: false, reason: `officer ${officer.typeID}: typeID range ${spec.typeIDMin}-${spec.typeIDMax} exhausted` };
    }
    allocations.set(officer.typeID, cursor);
    used.add(cursor);
    newAllocations += 1;
  }

  const counts = spec.moduleCounts;
  const packNames = new Set();
  const entries = [];
  for (const recipe of recipes) {
    const { officer, parent, family, faction, deadspace, t2 } = recipe;
    const blueprintTypeID = allocations.get(officer.typeID);
    const label = `officer ${officer.typeID}`;
    const name = officer.name + spec.nameSuffix;
    const key = normalName(name);
    if (takenNames.has(key)) return { ok: false, reason: `${label}: name "${name}" already used by an SDE type` };
    if (packNames.has(key)) return { ok: false, reason: `${label}: name "${name}" used twice in the pack` };
    packNames.add(key);

    const { size, weapon, launcherDefault: onDefault } = sizeOf(parent, dogma, spec);
    if (onDefault) launcherDefault += 1;
    const factor = spec.sizeFactor[size] * (weapon ? spec.weaponFactor : 1);
    const scale = (quantity) => Math.max(1, Math.round(quantity * factor));
    const modules = [];
    if (faction && deadspace) modules.push([faction, counts.faction], [deadspace, counts.deadspace]);
    else modules.push([faction || deadspace, counts.onlyOne]);
    modules.push(t2 ? [t2, counts.t2] : [parent, counts.t1IfNoT2]);
    for (const [type] of modules) {
      if (!type.published) return { ok: false, reason: `${label}: material ${type.typeID} is not published` };
    }
    const generic = family === GENERIC_FAMILY;
    const materials = new Map();
    const add = (typeID, quantity) => materials.set(typeID, (materials.get(typeID) || 0) + quantity);
    for (const [type, quantity] of modules) add(type.typeID, quantity);
    for (const [typeID, quantity] of spec.minerals) add(typeID, scale(quantity));
    for (const [typeID, quantity] of spec.moonMaterials) add(typeID, scale(quantity * (generic ? spec.genericMoonFactor : 1)));
    if (!generic) for (const [typeID, quantity] of spec.families[family].tags) add(typeID, scale(quantity));
    const time = Math.round(spec.baseTimeSeconds * spec.timeFactor[size]);
    if (!isPositiveInteger(time)) return { ok: false, reason: `${label}: time ${time} below 1` };

    const parts = modules.map(([type, quantity]) => `${quantity}x ${type.name}`).join(", ");
    const description = `Blueprint of ${officer.name}. Officer-grade manufacturing: ${parts}`
      + `${generic ? "" : ", faction diamond tags"}, advanced moon composites and a mountain of minerals. `
      + `One run takes ${daysText(time)}. ${skillText}.`;
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return { ok: false, reason: `${label}: description longer than ${MAX_DESCRIPTION_LENGTH} characters` };
    }
    bySize[size] += 1;
    byFamily[family] += 1;
    entries.push({
      type: {
        typeID: blueprintTypeID,
        sourceTypeID: spec.sourceTypeID,
        overrides: {
          name,
          groupID: recipe.groupID,
          iconID: officer.iconID,
          basePrice: spec.basePrice,
          published: true,
          marketGroupID: spec.marketGroupID,
          description,
        },
      },
      blueprint: {
        blueprintTypeID,
        productTypeID: officer.typeID,
        maxProductionLimit: spec.maxProductionLimit,
        activities: {
          manufacturing: {
            materials: [...materials].map(([typeID, quantity]) => ({ quantity, typeID })).sort(byTypeID),
            products: [{ quantity: 1, typeID: officer.typeID }],
            skills: spec.skills.map(([typeID, level]) => ({ level, typeID })).sort(byTypeID),
            time,
          },
        },
      },
    });
  }
  entries.sort((a, b) => a.type.typeID - b.type.typeID);

  const inputs = isPlainObject(options && options.inputs) ? options.inputs : {};
  const sha = (value) => (typeof value === "string" && value !== "" ? value : "unknown");
  const source = `generated by ${GENERATOR} - do not edit by hand (README). spec ${sha(inputs.specSha1)}, `
    + `types.jsonl ${sha(inputs.typesSha1)}, groups.jsonl ${sha(inputs.groupsSha1)}, `
    + `blueprints.jsonl ${sha(inputs.blueprintsSha1)}, typeDogma.jsonl ${sha(inputs.typeDogmaSha1)}; `
    + `${entries.length} officer blueprints, ${excluded.length} officers excluded`;
  const pack = { packID: spec.packID, version: spec.packVersion, source,
    types: entries.map((entry) => entry.type), blueprints: entries.map((entry) => entry.blueprint) };
  const allocationObject = {};
  for (const [officerID, typeID] of [...allocations].sort((a, b) => a[0] - b[0])) allocationObject[String(officerID)] = typeID;
  return {
    ok: true,
    pack,
    allocations: allocationObject,
    newAllocations,
    report: { built: entries.length, excluded, bySize, byFamily, launcherDefault },
  };
}

function renderSpecWithAllocations(specText, allocations) {
  const text = String(specText).replace(/\r\n/gu, "\n");
  const pattern = /"allocations"\s*:\s*\{[^{}]*\}/gu;
  const matches = text.match(pattern) || [];
  if (matches.length !== 1) return { ok: false, reason: `spec has ${matches.length} "allocations" objects, expected 1` };
  const keys = Object.keys(allocations).sort((a, b) => Number(a) - Number(b));
  const body = keys.length === 0 ? "{}"
    : `{\n${keys.map((key) => `    "${key}": ${allocations[key]}`).join(",\n")}\n  }`;
  const rendered = text.replace(pattern, () => `"allocations": ${body}`);
  let before;
  let after;
  try {
    before = JSON.parse(text);
    after = JSON.parse(rendered);
  } catch (error) {
    return { ok: false, reason: `spec ${error.message}` };
  }
  const rest = (spec) => JSON.stringify({ ...spec, allocations: null });
  if (rest(before) !== rest(after) || JSON.stringify(after.allocations) !== JSON.stringify(allocations)) {
    return { ok: false, reason: "spec rewrite changed more than allocations" };
  }
  return { ok: true, text: rendered };
}

const USAGE = "usage: node mods/customTypes/tools/genOfficerBlueprints.js --sde <SDE jsonl dir> "
  + "[--spec <file>] [--out <file>] [--check] [--allocate] [--report]";

function parseArgs(argv) {
  const args = { sde: null, spec: path.join(__dirname, "officer-blueprints.spec.json"),
    out: path.join(__dirname, "..", "data", "officer-blueprints.json"), check: false, allocate: false, report: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[index];
    };
    if (flag === "--sde") args.sde = value();
    else if (flag === "--spec") args.spec = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--check") args.check = true;
    else if (flag === "--allocate") args.allocate = true;
    else if (flag === "--report") args.report = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.sde) throw new Error("--sde is required");
  if (args.check && args.allocate) throw new Error("--check writes nothing: it cannot be combined with --allocate");
  return args;
}

const sha1 = (text) => crypto.createHash("sha1").update(String(text).replace(/\r\n/gu, "\n")).digest("hex");

function printReport(report) {
  const reasons = new Map();
  for (const entry of report.excluded) reasons.set(entry.reason, (reasons.get(entry.reason) || 0) + 1);
  const pairs = (object) => Object.entries(object).map(([key, count]) => `${key} ${count}`).join(", ");
  console.log(`report: ${report.built} blueprints, ${report.excluded.length} officers excluded`);
  console.log(`  excluded by reason: ${[...reasons].sort().map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"}`);
  console.log(`  by size: ${pairs(report.bySize)}`);
  console.log(`  by family: ${pairs(report.byFamily)}`);
  console.log(`  launchers on launcherDefaultSize: ${report.launcherDefault}`);
  for (const entry of report.excluded) console.log(`  excluded ${entry.typeID} ${entry.reason} ${entry.name}`);
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const files = Object.fromEntries(["types", "groups", "blueprints", "typeDogma"]
    .map((name) => [name, path.join(args.sde, `${name}.jsonl`)]));
  for (const file of [...Object.values(files), args.spec]) {
    if (!fs.existsSync(file)) {
      console.error(`missing file ${file}\n${USAGE}`);
      return 2;
    }
  }
  const text = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, "utf8")]));
  const specText = fs.readFileSync(args.spec, "utf8");
  let spec;
  try {
    spec = JSON.parse(specText);
  } catch (error) {
    console.log(`refused: spec ${error.message}`);
    return 1;
  }
  const parsedTypes = parseTypesJsonl(text.types);
  const parsedGroups = parseGroupsJsonl(text.groups);
  const parsedBlueprints = parseBlueprintsJsonl(text.blueprints);
  for (const [name, parsed] of [["types", parsedTypes], ["groups", parsedGroups], ["blueprints", parsedBlueprints]]) {
    if (!parsed.ok) {
      console.log(`refused: ${name}.jsonl ${parsed.reason}`);
      return 1;
    }
  }
  const parsedDogma = parseTypeDogmaJsonl(text.typeDogma, officerParentIDs(parsedTypes.types));
  if (!parsedDogma.ok) {
    console.log(`refused: typeDogma.jsonl ${parsedDogma.reason}`);
    return 1;
  }
  const sde = { types: parsedTypes.types, groupCategory: parsedGroups.groupCategory,
    blueprintByProduct: parsedBlueprints.blueprintByProduct, dogma: parsedDogma.dogma };
  const fileShas = { typesSha1: sha1(text.types), groupsSha1: sha1(text.groups),
    blueprintsSha1: sha1(text.blueprints), typeDogmaSha1: sha1(text.typeDogma) };

  let built = buildOfficerBlueprintPack(sde, spec, { allocate: args.allocate });
  if (!built.ok) {
    console.log(`refused: ${built.reason}`);
    return 1;
  }
  let newSpecText = null;
  const { newAllocations } = built;
  if (newAllocations > 0) {
    const rendered = renderSpecWithAllocations(specText, built.allocations);
    if (!rendered.ok) {
      console.log(`refused: ${rendered.reason}`);
      return 1;
    }
    newSpecText = rendered.text;
    spec = JSON.parse(newSpecText);
  }
  built = buildOfficerBlueprintPack(sde, spec, { allocate: false,
    inputs: { specSha1: sha1(newSpecText === null ? specText : newSpecText), ...fileShas } });
  if (!built.ok) {
    console.log(`refused: ${built.reason}`);
    return 1;
  }
  if (args.report) printReport(built.report);
  const packText = serializePack(built.pack);
  const ids = built.pack.types.map((entry) => entry.typeID);
  const range = ids.length > 0 ? `typeID ${ids[0]}-${ids[ids.length - 1]}` : "no types";
  const head = `${spec.packID}: ${built.report.built} blueprints (${built.report.excluded.length} officers excluded), `
    + `${range}, ${Buffer.byteLength(packText)} bytes`;
  if (args.check) {
    const current = fs.existsSync(args.out) ? fs.readFileSync(args.out, "utf8").replace(/\r\n/gu, "\n") : null;
    if (current === packText) {
      console.log(`${head}, up to date ${args.out}`);
      return 0;
    }
    console.log(`${head}, ${args.out} differs`);
    return 1;
  }
  if (newSpecText !== null) {
    const tmpSpec = `${args.spec}.tmp`;
    fs.writeFileSync(tmpSpec, newSpecText, "utf8");
    fs.renameSync(tmpSpec, args.spec);
    console.log(`${newAllocations} new allocations, wrote ${args.spec}`);
  }
  const tmp = `${args.out}.tmp`;
  fs.writeFileSync(tmp, packText, "utf8");
  fs.renameSync(tmp, args.out);
  console.log(`${head}, wrote ${args.out}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  buildOfficerBlueprintPack, parseTypesJsonl, parseGroupsJsonl, parseBlueprintsJsonl, parseTypeDogmaJsonl,
  officerParentIDs, renderSpecWithAllocations, familyOf, sizeOf, GENERIC_FAMILY,
};
