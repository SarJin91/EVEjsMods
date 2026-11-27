"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { streamLines, readSdeHeader, readTypeMaterials } = require("./strength/sdeReader");
const { buildOreTypes, ATTR_BASE_TYPE, ATTR_GRADE } = require("./mining/buildOreTypes");
const { ORE_BANDS } = require("../lib/economy/data/industryCatalog");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SDE = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3724492-jsonl");
const DEFAULT_OUT = path.join(__dirname, "..", "lib", "economy", "data", "oreTypes.js");
const KEY_RE = /^\{"_key": (\d+),/;
const BASE_ATTR_RE = new RegExp(`"attributeID": ${ATTR_BASE_TYPE}\\b`);

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

function familyNames() {
  const names = new Map();
  for (const band of Object.values(ORE_BANDS)) {
    for (const ore of band.ores || []) names.set(ore.typeId, ore.name);
  }
  return names;
}

async function readInputs(sdeDir) {
  const sde = readSdeHeader(sdeDir);
  const compressible = new Set();
  for (const line of fs.readFileSync(path.join(sdeDir, "compressibleTypes.jsonl"), "utf8").split(/\r?\n/)) {
    const key = KEY_RE.exec(line);
    if (key) compressible.add(Number(key[1]));
  }
  const dogma = new Map();
  await streamLines(path.join(sdeDir, "typeDogma.jsonl"), (line) => {
    if (!BASE_ATTR_RE.test(line)) return;
    const key = KEY_RE.exec(line);
    if (!key) return;
    const row = JSON.parse(line);
    const attrs = {};
    for (const a of row.dogmaAttributes || []) {
      if (a.attributeID === ATTR_BASE_TYPE || a.attributeID === ATTR_GRADE) attrs[a.attributeID] = a.value;
    }
    dogma.set(Number(key[1]), attrs);
  });
  const typeMaterials = await readTypeMaterials(sdeDir, [...dogma.keys()].filter((id) => compressible.has(id)));
  return { sde, dogma, typeMaterials, compressible, names: familyNames() };
}

function summaryOf(result) {
  const lines = [];
  const byBase = new Map();
  for (const row of Object.values(result.oreTypes)) {
    if (!byBase.has(row.baseTypeId)) byBase.set(row.baseTypeId, []);
    byBase.get(row.baseTypeId).push(row);
  }
  for (const base of result.baseTypeIds) {
    const rows = byBase.get(base);
    const g1 = rows.find((r) => r.grade === 1);
    lines.push(`${String(base).padStart(6)} ${String(g1.family || "(unnamed)").padEnd(14)} types ${rows.map((r) => `${r.typeId}/g${r.grade}`).join(",")}`
      + `  g1 ${JSON.stringify(g1.minerals)}`);
  }
  const h = result.header;
  lines.push(`oreCount ${h.oreCount}, baseCount ${h.baseCount}, namedFamilies ${h.namedFamilies}, criteria ${h.criteria}`);
  return lines.join("\n");
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node buildOreTypes.js [--sde <dir>] [--out <file>] [--check] [--summary]\n`);
    return 2;
  }
  const result = buildOreTypes(await readInputs(args.sde));
  if (!result.ok) {
    process.stderr.write(`ore types: build failed ${result.reason} ${result.detail}\n`);
    return 1;
  }
  const hash = sha256(result.source);
  if (args.summary) process.stdout.write(`${summaryOf(result)}\n`);
  if (args.check) {
    const current = fs.existsSync(args.out) ? sha256(fs.readFileSync(args.out, "utf8")) : "(missing)";
    if (current !== hash) {
      process.stderr.write(`ore types: OUT OF DATE (file ${current}, generated ${hash}) - regenerate\n`);
      return 1;
    }
    process.stdout.write(`ore types: up to date (sha256 ${hash})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, result.source, "utf8");
  process.stdout.write(`ore types: ${result.header.oreCount} types, ${result.header.baseCount} bases -> ${args.out} `
    + `(sha256 ${hash})\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`ore types: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
