"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const GENERATOR = "mods/customTypes/tools/genPiBlueprints.js";
const MAX_SKILL_LEVEL = 5;

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const normalName = (name) => String(name).trim().toLowerCase();
const byTypeID = (a, b) => a.typeID - b.typeID;

function splitLines(text) {
  return String(text).split(/\r?\n/u);
}

function parseSchematicsJsonl(text) {
  const schematics = [];
  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      return { ok: false, reason: `line ${index + 1}: ${error.message}` };
    }
    if (!isPlainObject(row) || !Array.isArray(row.types)) {
      return { ok: false, reason: `line ${index + 1}: not a schematic (no types array)` };
    }
    const inputs = [];
    const outputs = [];
    for (const entry of row.types) {
      if (!isPlainObject(entry) || typeof entry.isInput !== "boolean") {
        return { ok: false, reason: `line ${index + 1}: bad types entry` };
      }
      (entry.isInput ? inputs : outputs).push({ typeID: entry._key, quantity: entry.quantity });
    }
    schematics.push({ schematicID: row._key, cycleTime: row.cycleTime, inputs, outputs });
  }
  return { ok: true, schematics };
}

function parseTypesJsonl(text) {
  const typesByID = new Map();
  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      return { ok: false, reason: `line ${index + 1}: ${error.message}` };
    }
    if (!isPlainObject(row) || !Number.isSafeInteger(row._key) || row._key < 0) {
      return { ok: false, reason: `line ${index + 1}: not a type (bad _key)` };
    }
    let name = null;
    if (typeof row.name === "string") name = row.name;
    else if (isPlainObject(row.name) && typeof row.name.en === "string") name = row.name.en;
    typesByID.set(row._key, {
      name,
      iconID: Number.isSafeInteger(row.iconID) ? row.iconID : null,
      groupID: Number.isSafeInteger(row.groupID) ? row.groupID : null,
    });
  }
  return { ok: true, typesByID };
}

function checkSpec(spec, typesByID) {
  if (!isPlainObject(spec)) return "spec is not an object";
  if (typeof spec.packID !== "string" || spec.packID.trim() === "") return "spec.packID missing";
  for (const key of ["packVersion", "typeIDBase", "typeIDMax", "sourceTypeID", "groupID", "maxProductionLimit"]) {
    if (!isPositiveInteger(spec[key])) return `spec.${key} must be a positive integer`;
  }
  if (typeof spec.timeFactor !== "number" || !Number.isFinite(spec.timeFactor) || spec.timeFactor <= 0) {
    return "spec.timeFactor must be a finite number > 0";
  }
  if (typeof spec.basePrice !== "number" || !Number.isFinite(spec.basePrice) || spec.basePrice < 0) {
    return "spec.basePrice must be a number >= 0";
  }
  if (spec.marketGroupID !== null && !isPositiveInteger(spec.marketGroupID)) {
    return "spec.marketGroupID must be null or a positive integer";
  }
  if (typeof spec.nameSuffix !== "string" || spec.nameSuffix.trim() === "") return "spec.nameSuffix missing";
  if (!isPlainObject(spec.tierByOutputQuantity) || Object.keys(spec.tierByOutputQuantity).length === 0) {
    return "spec.tierByOutputQuantity missing";
  }
  if (!isPlainObject(spec.skillsByTier)) return "spec.skillsByTier missing";
  for (const tier of Object.values(spec.tierByOutputQuantity)) {
    const skills = spec.skillsByTier[tier];
    if (!Array.isArray(skills)) return `spec: tier ${JSON.stringify(tier)} has no skillsByTier entry`;
    const seen = new Set();
    for (const skill of skills) {
      if (!Array.isArray(skill) || skill.length !== 2) return `spec: tier ${tier} skill is not [typeID, level]`;
      const [typeID, level] = skill;
      if (!isPositiveInteger(typeID) || !typesByID.has(typeID)) return `spec: tier ${tier} skill type ${typeID} not found`;
      if (!Number.isSafeInteger(level) || level < 1 || level > MAX_SKILL_LEVEL) {
        return `spec: tier ${tier} skill ${typeID} bad level ${level}`;
      }
      if (seen.has(typeID)) return `spec: tier ${tier} skill ${typeID} listed twice`;
      seen.add(typeID);
    }
  }
  if (!typesByID.has(spec.sourceTypeID)) return `spec.sourceTypeID ${spec.sourceTypeID} not found`;
  return null;
}

function checkQuantities(list, label) {
  for (const item of list) {
    if (!isPlainObject(item) || !isPositiveInteger(item.typeID)) return `${label} with a bad typeID`;
    if (!isPositiveInteger(item.quantity)) return `${label} ${item.typeID} bad quantity ${JSON.stringify(item.quantity)}`;
  }
  return null;
}

function buildPiBlueprintPack(schematics, typesByID, spec, inputs = {}) {
  if (!Array.isArray(schematics) || schematics.length === 0) return { ok: false, reason: "no schematics" };
  if (!(typesByID instanceof Map)) return { ok: false, reason: "typesByID is not a Map" };
  const specProblem = checkSpec(spec, typesByID);
  if (specProblem) return { ok: false, reason: specProblem };

  const tiers = [...new Set(Object.values(spec.tierByOutputQuantity))].sort();
  const byTier = Object.fromEntries(tiers.map((tier) => [tier, 0]));
  const takenNames = new Set();
  for (const info of typesByID.values()) {
    if (info && typeof info.name === "string") takenNames.add(normalName(info.name));
  }

  const sorted = [...schematics].sort((a, b) => Number(a && a.schematicID) - Number(b && b.schematicID));
  const seenSchematics = new Set();
  const seenProducts = new Set();
  const packNames = new Set();
  const types = [];
  const blueprints = [];
  for (const schematic of sorted) {
    if (!isPlainObject(schematic) || !isPositiveInteger(schematic.schematicID)) {
      return { ok: false, reason: `schematic ${JSON.stringify(schematic && schematic.schematicID)}: bad schematicID` };
    }
    const id = schematic.schematicID;
    const label = `schematic ${id}`;
    if (seenSchematics.has(id)) return { ok: false, reason: `${label}: listed twice` };
    seenSchematics.add(id);
    const inputsList = Array.isArray(schematic.inputs) ? schematic.inputs : [];
    const outputs = Array.isArray(schematic.outputs) ? schematic.outputs : [];
    if (outputs.length !== 1) return { ok: false, reason: `${label}: ${outputs.length} outputs, expected 1` };
    if (inputsList.length < 1) return { ok: false, reason: `${label}: no inputs` };
    const quantityProblem = checkQuantities(inputsList, "input") || checkQuantities(outputs, "output");
    if (quantityProblem) return { ok: false, reason: `${label}: ${quantityProblem}` };
    const inputIDs = new Set();
    for (const input of inputsList) {
      if (inputIDs.has(input.typeID)) return { ok: false, reason: `${label}: input ${input.typeID} listed twice` };
      if (!typesByID.has(input.typeID)) return { ok: false, reason: `${label}: input type ${input.typeID} not found` };
      inputIDs.add(input.typeID);
    }
    const [output] = outputs;
    const tier = spec.tierByOutputQuantity[String(output.quantity)];
    if (tier === undefined) return { ok: false, reason: `${label}: output quantity ${output.quantity} matches no tier` };

    const typeID = spec.typeIDBase + id;
    if (typeID > spec.typeIDMax) return { ok: false, reason: `${label}: typeID ${typeID} above ${spec.typeIDMax}` };
    if (typesByID.has(typeID)) return { ok: false, reason: `${label}: typeID ${typeID} already exists in the SDE` };

    const product = typesByID.get(output.typeID);
    if (!product) return { ok: false, reason: `${label}: product type ${output.typeID} not found` };
    if (typeof product.name !== "string" || product.name.trim() === "") {
      return { ok: false, reason: `${label}: product ${output.typeID} has no name` };
    }
    if (!isPositiveInteger(product.iconID)) return { ok: false, reason: `${label}: product ${output.typeID} has no iconID` };
    if (seenProducts.has(output.typeID)) return { ok: false, reason: `${label}: product ${output.typeID} in two schematics` };
    seenProducts.add(output.typeID);

    const name = product.name.trim() + spec.nameSuffix;
    const key = normalName(name);
    if (takenNames.has(key)) return { ok: false, reason: `${label}: name "${name}" already used by an SDE type` };
    if (packNames.has(key)) return { ok: false, reason: `${label}: name "${name}" used twice in the pack` };
    packNames.add(key);

    const time = Math.round(schematic.cycleTime * spec.timeFactor);
    if (!Number.isSafeInteger(time) || time < 1) return { ok: false, reason: `${label}: time ${time} below 1` };

    byTier[tier] += 1;
    types.push({
      typeID,
      sourceTypeID: spec.sourceTypeID,
      overrides: {
        name,
        groupID: spec.groupID,
        iconID: product.iconID,
        basePrice: spec.basePrice,
        marketGroupID: spec.marketGroupID,
      },
    });
    blueprints.push({
      blueprintTypeID: typeID,
      productTypeID: output.typeID,
      maxProductionLimit: spec.maxProductionLimit,
      activities: {
        manufacturing: {
          materials: inputsList.map((input) => ({ quantity: input.quantity, typeID: input.typeID })).sort(byTypeID),
          products: [{ quantity: output.quantity, typeID: output.typeID }],
          skills: spec.skillsByTier[tier].map(([skillTypeID, level]) => ({ level, typeID: skillTypeID })).sort(byTypeID),
          time,
        },
      },
    });
  }

  const tierText = tiers.map((tier) => `${tier} ${byTier[tier]}`).join(", ");
  const sha = (value) => (typeof value === "string" && value !== "" ? value : "unknown");
  let source = `generated by ${GENERATOR} - do not edit by hand (README). `
    + `spec ${sha(inputs.specSha1)}, planetSchematics.jsonl ${sha(inputs.schematicsSha1)}, `
    + `types.jsonl ${sha(inputs.typesSha1)}; ${blueprints.length} schematics (${tierText})`;
  if (Array.isArray(inputs.subset) && inputs.subset.length > 0) source += `; subset: ${inputs.subset.join(",")}`;

  const pack = { packID: spec.packID, version: spec.packVersion, source, types, blueprints };
  return {
    ok: true,
    pack,
    summary: {
      count: blueprints.length,
      byTier,
      typeIDMin: types[0].typeID,
      typeIDMax: types[types.length - 1].typeID,
    },
  };
}

function serializePack(pack) {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

const README_BEGIN = "<!-- pi-blueprints-table:begin (generated by tools/genPiBlueprints.js --readme-table, do not edit) -->";
const README_END = "<!-- pi-blueprints-table:end -->";
const NAMED_ID = /([A-Za-z][A-Za-z0-9 '-]*?) \((\d+)\)/gu;

function renderReadmeTable(pack, spec, namesByTypeID) {
  if (!isPlainObject(pack) || !Array.isArray(pack.types) || !Array.isArray(pack.blueprints)) {
    return { ok: false, reason: "pack has no types/blueprints" };
  }
  if (!isPlainObject(spec) || !isPlainObject(spec.tierByOutputQuantity) || !isPlainObject(spec.skillsByTier)
    || typeof spec.nameSuffix !== "string") {
    return { ok: false, reason: "spec has no tierByOutputQuantity/skillsByTier/nameSuffix" };
  }
  const blueprintNames = new Map(pack.types.map((entry) => [entry.typeID, entry.overrides && entry.overrides.name]));
  const names = new Map(namesByTypeID instanceof Map ? namesByTypeID : []);
  for (const blueprint of pack.blueprints) {
    const name = blueprintNames.get(blueprint.blueprintTypeID);
    if (typeof name === "string" && name.endsWith(spec.nameSuffix)) {
      names.set(blueprint.productTypeID, name.slice(0, name.length - spec.nameSuffix.length));
    }
  }
  const missing = [];
  const named = (typeID) => {
    const name = names.get(typeID);
    if (typeof name !== "string" || name === "") {
      missing.push(typeID);
      return `? (${typeID})`;
    }
    return `${name.replace(/\|/gu, "\\|")} (${typeID})`;
  };

  const tierOrder = [...new Set(Object.values(spec.tierByOutputQuantity))].sort();
  const rows = [];
  for (const blueprint of pack.blueprints) {
    const manufacturing = blueprint.activities && blueprint.activities.manufacturing;
    const product = manufacturing && Array.isArray(manufacturing.products) ? manufacturing.products[0] : null;
    if (!product) return { ok: false, reason: `blueprint ${blueprint.blueprintTypeID}: no manufacturing product` };
    const tier = spec.tierByOutputQuantity[String(product.quantity)];
    if (tier === undefined) {
      return { ok: false, reason: `blueprint ${blueprint.blueprintTypeID}: output quantity ${product.quantity} matches no tier` };
    }
    const inputs = (manufacturing.materials || []).map((material) => `${material.quantity} ${named(material.typeID)}`).join(", ");
    rows.push({ tier, typeID: blueprint.blueprintTypeID, cells: [String(blueprint.blueprintTypeID),
      String(blueprintNames.get(blueprint.blueprintTypeID)), tier, named(product.typeID), String(product.quantity),
      `${manufacturing.time} s`, inputs] });
  }
  rows.sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier) || a.typeID - b.typeID);
  const skillText = tierOrder.map((tier) => `${tier}: ${(spec.skillsByTier[tier] || [])
    .map(([skillTypeID, level]) => `${named(skillTypeID)} ${level}`).join(", ")}`).join("; ");
  if (missing.length > 0) return { ok: false, reason: `no name for type ${[...new Set(missing)].join(",")}` };

  const counts = tierOrder.map((tier) => `${tier} ${rows.filter((row) => row.tier === tier).length}`).join(", ");
  const lines = [
    README_BEGIN,
    "",
    `${rows.length} blueprints (${counts}), pack \`${pack.packID}\` version ${pack.version}. `
      + `Manufacturing only, one run = one schematic cycle, max ${pack.blueprints[0] ? pack.blueprints[0].maxProductionLimit : 0} runs. `
      + `Skills by tier: ${skillText}.`,
    "",
    "| Blueprint typeID | Name | Tier | Product | Output qty | Time | Inputs |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.cells.join(" | ")} |`),
    "",
    README_END,
  ];
  return { ok: true, text: lines.join("\n"), rows: rows.length };
}

function extractReadmeTable(readmeText) {
  const text = String(readmeText).replace(/\r\n/gu, "\n");
  const begin = text.indexOf(README_BEGIN);
  const end = text.indexOf(README_END);
  if (begin < 0 || end < begin) return null;
  return text.slice(begin, end + README_END.length);
}

function namesFromReadmeTable(block) {
  const names = new Map();
  for (const match of String(block).matchAll(NAMED_ID)) names.set(Number(match[2]), match[1]);
  return names;
}

function replaceReadmeTable(readmeText, block) {
  const text = String(readmeText).replace(/\r\n/gu, "\n");
  const current = extractReadmeTable(text);
  if (current === null) return { ok: false, reason: `README has no ${README_BEGIN} ... ${README_END} markers` };
  return { ok: true, text: text.replace(current, () => block) };
}

const USAGE = "usage: node mods/customTypes/tools/genPiBlueprints.js --sde <SDE jsonl dir> "
  + "[--spec <file>] [--out <file>] [--check] [--schematics 131,65]\n"
  + "       node mods/customTypes/tools/genPiBlueprints.js --readme-table --sde <SDE jsonl dir> "
  + "[--spec <file>] [--out <pack file>] [--readme <file>] [--check]";

function parseArgs(argv) {
  const args = { sde: null, spec: path.join(__dirname, "pi-blueprints.spec.json"),
    out: path.join(__dirname, "..", "data", "pi-blueprints.json"), check: false, schematics: null,
    readmeTable: false, readme: path.join(__dirname, "..", "README.md") };
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
    else if (flag === "--readme-table") args.readmeTable = true;
    else if (flag === "--readme") args.readme = value();
    else if (flag === "--schematics") {
      const list = value().split(",").map((part) => part.trim()).filter(Boolean).map(Number);
      if (list.length === 0 || !list.every(isPositiveInteger)) throw new Error("--schematics: comma-separated schematic IDs");
      args.schematics = [...new Set(list)].sort((a, b) => a - b);
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.sde) throw new Error("--sde is required");
  return args;
}

const sha1 = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");

function mainReadmeTable(args) {
  const typesFile = path.join(args.sde, "types.jsonl");
  for (const file of [typesFile, args.spec, args.out, args.readme]) {
    if (!fs.existsSync(file)) {
      console.error(`missing file ${file}\n${USAGE}`);
      return 2;
    }
  }
  let spec;
  let pack;
  try {
    spec = JSON.parse(fs.readFileSync(args.spec, "utf8"));
    pack = JSON.parse(fs.readFileSync(args.out, "utf8"));
  } catch (error) {
    console.log(`refused: ${error.message}`);
    return 1;
  }
  const parsedTypes = parseTypesJsonl(fs.readFileSync(typesFile, "utf8"));
  if (!parsedTypes.ok) {
    console.log(`refused: types.jsonl ${parsedTypes.reason}`);
    return 1;
  }
  const names = new Map();
  for (const [typeID, info] of parsedTypes.typesByID) if (info && typeof info.name === "string") names.set(typeID, info.name.trim());
  const rendered = renderReadmeTable(pack, spec, names);
  if (!rendered.ok) {
    console.log(`refused: ${rendered.reason}`);
    return 1;
  }
  const readme = fs.readFileSync(args.readme, "utf8");
  const replaced = replaceReadmeTable(readme, rendered.text);
  if (!replaced.ok) {
    console.log(`refused: ${replaced.reason}`);
    return 1;
  }
  const head = `README table: ${rendered.rows} blueprints from ${args.out}`;
  if (args.check) {
    if (replaced.text === readme.replace(/\r\n/gu, "\n")) {
      console.log(`${head}, up to date ${args.readme}`);
      return 0;
    }
    console.log(`${head}, ${args.readme} differs`);
    return 1;
  }
  const tmp = `${args.readme}.tmp`;
  fs.writeFileSync(tmp, replaced.text, "utf8");
  fs.renameSync(tmp, args.readme);
  console.log(`${head}, wrote ${args.readme}`);
  return 0;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (args.readmeTable) return mainReadmeTable(args);
  const schematicsFile = path.join(args.sde, "planetSchematics.jsonl");
  const typesFile = path.join(args.sde, "types.jsonl");
  for (const file of [schematicsFile, typesFile, args.spec]) {
    if (!fs.existsSync(file)) {
      console.error(`missing file ${file}\n${USAGE}`);
      return 2;
    }
  }
  const specBuffer = fs.readFileSync(args.spec);
  const schematicsBuffer = fs.readFileSync(schematicsFile);
  const typesBuffer = fs.readFileSync(typesFile);
  let spec;
  try {
    spec = JSON.parse(specBuffer.toString("utf8"));
  } catch (error) {
    console.log(`refused: spec ${error.message}`);
    return 1;
  }
  const parsedSchematics = parseSchematicsJsonl(schematicsBuffer.toString("utf8"));
  if (!parsedSchematics.ok) {
    console.log(`refused: planetSchematics.jsonl ${parsedSchematics.reason}`);
    return 1;
  }
  const parsedTypes = parseTypesJsonl(typesBuffer.toString("utf8"));
  if (!parsedTypes.ok) {
    console.log(`refused: types.jsonl ${parsedTypes.reason}`);
    return 1;
  }
  let schematics = parsedSchematics.schematics;
  if (args.schematics) {
    const known = new Set(schematics.map((schematic) => schematic.schematicID));
    const missing = args.schematics.filter((id) => !known.has(id));
    if (missing.length > 0) {
      console.log(`refused: --schematics ${missing.join(",")} not in planetSchematics.jsonl`);
      return 1;
    }
    const wanted = new Set(args.schematics);
    schematics = schematics.filter((schematic) => wanted.has(schematic.schematicID));
  }
  const built = buildPiBlueprintPack(schematics, parsedTypes.typesByID, spec, {
    specSha1: sha1(specBuffer.toString("utf8").replace(/\r\n/gu, "\n")),
    schematicsSha1: sha1(schematicsBuffer.toString("utf8").replace(/\r\n/gu, "\n")),
    typesSha1: sha1(typesBuffer.toString("utf8").replace(/\r\n/gu, "\n")),
    subset: args.schematics || undefined,
  });
  if (!built.ok) {
    console.log(`refused: ${built.reason}`);
    return 1;
  }
  const text = serializePack(built.pack);
  const { summary } = built;
  const tierText = Object.entries(summary.byTier).map(([tier, count]) => `${tier} ${count}`).join(", ");
  const head = `${spec.packID}: ${summary.count} blueprints (${tierText}), typeID ${summary.typeIDMin}-${summary.typeIDMax}`;
  if (args.check) {
    const current = fs.existsSync(args.out) ? fs.readFileSync(args.out, "utf8").replace(/\r\n/gu, "\n") : null;
    if (current === text) {
      console.log(`${head}, up to date ${args.out}`);
      return 0;
    }
    console.log(`${head}, ${args.out} differs`);
    return 1;
  }
  const tmp = `${args.out}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, args.out);
  console.log(`${head}, wrote ${args.out}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  buildPiBlueprintPack, parseSchematicsJsonl, parseTypesJsonl, serializePack,
  renderReadmeTable, extractReadmeTable, namesFromReadmeTable, replaceReadmeTable, README_BEGIN, README_END,
};
