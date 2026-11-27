"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readSdeInputs } = require("./strength/sdeReader");
const { buildCatalog } = require("./strength/buildCatalog");
const { METHOD, referenceTypeIds } = require("./strength/method");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SDE = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3724492-jsonl");
const DEFAULT_OUT = path.join(__dirname, "..", "lib", "battle", "data", "strengthCatalog.js");
const SERVER_PACKAGE = path.join(REPO_ROOT, "server", "package.json");

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

function summaryTable(catalog) {
  const cols = ["hullGroup", "n", "dps", "alpha", "ehp", "repPerSec", "remoteRep", "appl", "ewar", "tackle",
    "speedCl", "sig", "maxVel", "designSig"];
  const lines = [cols.map((c) => c.padStart(c === "hullGroup" ? 13 : 9)).join(" ")];
  for (const [name, g] of Object.entries(catalog.GROUPS)) {
    const values = [g.sampleSize, g.dps, g.alpha, g.ehp, g.repPerSec, g.remoteRepPerSec, g.applicationFactor,
      g.ewarFactor, g.tackleFactor, g.speedClass, g.signatureRadius, g.maxVelocity, g.designSig];
    lines.push([name.padStart(13), ...values.map((v) => String(v).padStart(9))].join(" "));
  }
  const h = catalog.HEADER;
  lines.push(`types ${h.typeCount}, sigBySize ${JSON.stringify(h.sigBySize)}, refTargetSig ${h.refTargetSig}, `
    + `speedClassBounds ${JSON.stringify(h.speedClassBounds)}`);
  return lines.join("\n");
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node buildStrengthCatalog.js [--sde <dir>] [--out <file>] `
      + "[--check] [--summary]\n");
    return 2;
  }
  const evejsVersion = JSON.parse(fs.readFileSync(SERVER_PACKAGE, "utf8")).version;
  const sdeInputs = await readSdeInputs(args.sde, { referenceTypeIds: referenceTypeIds(METHOD) });
  const result = buildCatalog({ ...sdeInputs, evejsVersion }, METHOD);
  if (!result.ok) {
    process.stderr.write(`strength catalog: build failed ${result.reason} ${result.detail}\n`);
    return 1;
  }
  const hash = sha256(result.source);
  if (args.summary) process.stdout.write(`${summaryTable(result.catalog)}\n`);
  if (args.check) {
    const current = fs.existsSync(args.out) ? sha256(fs.readFileSync(args.out, "utf8")) : "(missing)";
    if (current !== hash) {
      process.stderr.write(`strength catalog: OUT OF DATE (file ${current}, generated ${hash}) - regenerate\n`);
      return 1;
    }
    process.stdout.write(`strength catalog: up to date (sha256 ${hash})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, result.source, "utf8");
  process.stdout.write(`strength catalog: ${result.catalog.HEADER.typeCount} types, `
    + `${Object.keys(result.catalog.GROUPS).length} groups -> ${args.out} (sha256 ${hash})\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`strength catalog: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
