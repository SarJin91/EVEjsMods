"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readSdeInputs, readBlueprints } = require("./strength/sdeReader");
const { buildRecipes } = require("./production/buildRecipes");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SDE = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3724492-jsonl");
const DEFAULT_OUT = path.join(__dirname, "..", "lib", "economy", "data", "hullRecipes.js");

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

function summaryTable(result) {
  const lines = [["hullGroup", "n", "repTypeId", "minerals", "timeSec"].map((c) => c.padStart(13)).join(" ")];
  for (const [name, g] of Object.entries(result.groups)) {
    lines.push([name, g.sampleSize, g.representativeTypeId, g.mineralSum, g.timeSec]
      .map((v) => String(v).padStart(13)).join(" "));
  }
  lines.push(`types ${result.header.typeCount}, ignoredMaterialTypes ${result.header.ignoredMaterialTypes}`);
  return lines.join("\n");
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node buildHullRecipes.js [--sde <dir>] [--out <file>] `
      + "[--check] [--summary]\n");
    return 2;
  }
  const inputs = await readSdeInputs(args.sde, { dogma: false });
  const result = buildRecipes({ sde: inputs.sde, types: inputs.types, blueprints: readBlueprints(args.sde) });
  if (!result.ok) {
    process.stderr.write(`hull recipes: build failed ${result.reason} ${result.detail}\n`);
    return 1;
  }
  const hash = sha256(result.source);
  if (args.summary) process.stdout.write(`${summaryTable(result)}\n`);
  if (args.check) {
    const current = fs.existsSync(args.out) ? sha256(fs.readFileSync(args.out, "utf8")) : "(missing)";
    if (current !== hash) {
      process.stderr.write(`hull recipes: OUT OF DATE (file ${current}, generated ${hash}) - regenerate\n`);
      return 1;
    }
    process.stdout.write(`hull recipes: up to date (sha256 ${hash})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, result.source, "utf8");
  process.stdout.write(`hull recipes: ${Object.keys(result.groups).length} groups -> ${args.out} (sha256 ${hash})\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`hull recipes: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
