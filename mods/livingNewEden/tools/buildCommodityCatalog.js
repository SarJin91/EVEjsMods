"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { streamLines, readSdeHeader, readTypeMaterials, readBlueprints, readReactions } = require("./strength/sdeReader");
const { buildCommodityCatalog, ATTR_REPROCESS_SKILL } = require("./extraction/buildCommodityCatalog");
const HULL_RECIPES = require("../lib/economy/data/hullRecipes");
const INDUSTRY_CATALOG = require("../lib/economy/data/industryCatalog");
const CAPITAL_RECIPES = require("../lib/economy/data/capitalRecipes");
const { HULL_GROUPS_V1, INDUSTRY_HULL_GROUPS, CAPITAL_HULL_GROUPS } = require("../lib/fleets/schema");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SDE = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3724492-jsonl");
const DEFAULT_OUT = path.join(__dirname, "..", "lib", "economy", "data", "commodities.js");
const KEY_RE = /^\{"_key": (\d+),/;
const SKILL_ATTR_RE = new RegExp(`"attributeID": ${ATTR_REPROCESS_SKILL}\\b`);

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function parseArgs(argv) {
  const args = { sde: DEFAULT_SDE, out: DEFAULT_OUT, check: false, summary: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--summary") args.summary = true;
    else if ((arg === "--sde" || arg === "--out") && argv[i + 1]) {
      args[arg.slice(2)] = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return args;
}

async function readInputs(sdeDir) {
  const sde = readSdeHeader(sdeDir);
  const dogma = new Map();
  await streamLines(path.join(sdeDir, "typeDogma.jsonl"), (line) => {
    if (!SKILL_ATTR_RE.test(line)) return;
    const key = KEY_RE.exec(line);
    if (!key) return;
    const attrs = {};
    for (const a of JSON.parse(line).dogmaAttributes || []) attrs[a.attributeID] = a.value;
    dogma.set(Number(key[1]), attrs);
  });
  const typeMaterials = await readTypeMaterials(sdeDir, dogma.keys());
  const schematics = [];
  for (const line of fs.readFileSync(path.join(sdeDir, "planetSchematics.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() !== "") schematics.push(JSON.parse(line));
  }
  return { sde, dogma, typeMaterials, schematics, blueprints: readBlueprints(sdeDir), reactions: readReactions(sdeDir),
    representatives: representatives(), recipeHashes: { hull: HULL_RECIPES.HEADER.sourceHash,
      capital: CAPITAL_RECIPES.HEADER.sourceHash, industry: INDUSTRY_CATALOG.HEADER.sourceHash } };
}

function representatives() {
  const repOf = (rows, g) => (rows[g] && Number.isSafeInteger(rows[g].representativeTypeId)
    ? rows[g].representativeTypeId : null);
  return [...HULL_GROUPS_V1.map((g) => [g, repOf(HULL_RECIPES.GROUPS, g)]),
    ...INDUSTRY_HULL_GROUPS.map((g) => [g, repOf(INDUSTRY_CATALOG.HULLS, g)]),
    ...CAPITAL_HULL_GROUPS.map((g) => [g, repOf(CAPITAL_RECIPES.GROUPS, g)])];
}

function summaryOf(result) {
  const d = result.data;
  const lines = [];
  for (const [tier, skill] of result.summary.skillByTier) {
    const ores = Object.keys(d.MOON_ORES).filter((id) => d.MOON_ORES[id].tier === tier);
    const mats = Object.keys(d.MOON_MATERIAL_TIER).filter((id) => d.MOON_MATERIAL_TIER[id] === tier);
    lines.push(`moon ${tier.padEnd(3)} 790=${skill} ores ${ores.length} (${ores.join(",")}) materials ${mats.length} `
      + `(${mats.join(",")})`);
  }
  for (let t = 0; t <= 4; t += 1) {
    const ids = Object.keys(d.PI_TIER).filter((id) => d.PI_TIER[id] === t);
    lines.push(`pi P${t} types ${ids.length}`);
  }
  lines.push(`schematics ${d.SCHEMATICS.length}, P1_OF_P0 ${Object.keys(d.P1_OF_P0).length}`);
  for (const [id, b] of Object.entries(d.FUEL_BLOCKS)) {
    lines.push(`fuel ${id} batch ${b.batch} pi ${JSON.stringify(b.pi)}`);
  }
  lines.push(`fuel inputs skipped (not PI) ${result.summary.skippedFuelInputs.join(",")}`);
  for (const [g, bill] of Object.entries(d.ADVANCED_BILLS)) {
    lines.push(`advanced ${g.padEnd(16)} moon ${Object.keys(bill.moon).length} pi ${Object.keys(bill.pi).length}`);
  }
  lines.push(`advanced leaves skipped ${result.summary.advancedSkipped.length} `
    + `(${result.summary.advancedSkipped.join(",")})`);
  return lines.join("\n");
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node buildCommodityCatalog.js [--sde <dir>] [--out <file>] [--check] `
      + "[--summary]\n");
    return 2;
  }
  const result = buildCommodityCatalog(await readInputs(args.sde));
  if (!result.ok) {
    process.stderr.write(`commodities: build failed ${result.reason} ${result.detail}\n`);
    return 1;
  }
  const hash = sha256(result.source);
  if (args.summary) process.stdout.write(`${summaryOf(result)}\n`);
  if (args.check) {
    const current = fs.existsSync(args.out) ? sha256(fs.readFileSync(args.out, "utf8")) : "(missing)";
    if (current !== hash) {
      process.stderr.write(`commodities: OUT OF DATE (file ${current}, generated ${hash}) - regenerate\n`);
      return 1;
    }
    process.stdout.write(`commodities: up to date (sha256 ${hash})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, result.source, "utf8");
  process.stdout.write(`commodities: ${Object.keys(result.data.MOON_ORES).length} moon ores, `
    + `${Object.keys(result.data.PI_TIER).length} PI types -> ${args.out} (sha256 ${hash})\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`commodities: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
