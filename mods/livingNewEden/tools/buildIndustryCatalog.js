"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readSdeHeader, readBlueprints, readTypeRows, readTypeMaterials, readDogmaRows } = require("./strength/sdeReader");
const { buildIndustryCatalog, INDUSTRY_METHOD } = require("./industry/buildCatalog");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SDE = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3724492-jsonl");
const DEFAULT_OUT = path.join(__dirname, "..", "lib", "economy", "data", "industryCatalog.js");

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

function table(header, rows) {
  const width = 14;
  return [header.map((c) => String(c).padStart(width)).join(" "),
    ...rows.map((r) => r.map((v) => String(v).padStart(width)).join(" "))].join("\n");
}

function summaryTable(result) {
  const out = [];
  out.push(table(["class", "n", "repTypeId", "minerals", "timeSec", "factor‰", "unpriced", "cargoM3",
    "cargoMedM3", "oreHoldM3", "warp", "alignS"],
  Object.entries(result.hulls).map(([name, h]) => [name, h.sampleSize, h.representativeTypeId, h.mineralSum,
    h.timeSec, h.componentFactorPermille, h.unpricedLeaves, h.cargoM3, h.cargoMedianM3, h.oreHoldM3,
    h.travel.warpSpeedAu, h.travel.alignSeconds])));
  out.push("");
  out.push(table(["structure", "typeId", "minerals", "timeSec", "mineralISK", "componentISK", "factor‰", "unpriced"],
    Object.entries(result.structures).map(([name, s]) => [name, s.typeId, s.mineralSum, s.timeSec,
      s.mineralValueIsk, s.componentValueIsk, s.componentFactorPermille, s.unpricedLeaves])));
  out.push("");
  const keys = INDUSTRY_METHOD.minerals.map((id) => `type:${id}`);
  out.push(table(["band/1e6 m3", ...keys], Object.entries(result.oreBands)
    .map(([name, b]) => [name, ...keys.map((k) => b.mineralsPerMillionM3[k])])));
  out.push(`ignoredMaterialTypes ${result.header.ignoredMaterialTypes}, unpricedLeafTypes `
    + `${result.header.unpricedLeafTypes}`);
  return out.join("\n");
}

async function readInputs(sdeDir) {
  const method = INDUSTRY_METHOD;
  const sde = readSdeHeader(sdeDir);
  const blueprints = readBlueprints(sdeDir);
  const typeIds = new Set(method.minerals);
  for (const [product, bp] of blueprints) {
    typeIds.add(product);
    for (const m of bp.materials) typeIds.add(m.typeId);
  }
  const groupIds = new Set();
  for (const spec of Object.values(method.hullClasses)) {
    for (const id of spec.typeIds || []) typeIds.add(id);
    for (const g of spec.sourceGroups || []) groupIds.add(g);
  }
  for (const id of Object.values(method.structures)) typeIds.add(id);
  const names = new Set();
  for (const shares of Object.values(method.oreBands)) for (const n of Object.keys(shares)) names.add(n);
  const types = await readTypeRows(sdeDir, { typeIds, groupIds, names });
  const ships = [...types.values()].filter((t) => groupIds.has(t.groupId) || method.hullClasses
    && Object.values(method.hullClasses).some((s) => (s.typeIds || []).includes(t.typeId))).map((t) => t.typeId);
  const dogma = await readDogmaRows(sdeDir, ships);
  const ores = [...types.values()].filter((t) => names.has(t.name)).map((t) => t.typeId);
  const typeMaterials = await readTypeMaterials(sdeDir, ores);
  return { sde, types, dogma, blueprints, typeMaterials };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node buildIndustryCatalog.js [--sde <dir>] [--out <file>] `
      + "[--check] [--summary]\n");
    return 2;
  }
  const result = buildIndustryCatalog(await readInputs(args.sde));
  if (!result.ok) {
    process.stderr.write(`industry catalog: build failed ${result.reason} ${result.detail}\n`);
    return 1;
  }
  const hash = sha256(result.source);
  if (args.summary) process.stdout.write(`${summaryTable(result)}\n`);
  if (args.check) {
    const current = fs.existsSync(args.out) ? sha256(fs.readFileSync(args.out, "utf8")) : "(missing)";
    if (current !== hash) {
      process.stderr.write(`industry catalog: OUT OF DATE (file ${current}, generated ${hash}) - regenerate\n`);
      return 1;
    }
    process.stdout.write(`industry catalog: up to date (sha256 ${hash})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, result.source, "utf8");
  process.stdout.write(`industry catalog: ${Object.keys(result.hulls).length} classes, `
    + `${Object.keys(result.structures).length} kits -> ${args.out} (sha256 ${hash})\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`industry catalog: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
