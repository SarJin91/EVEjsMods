"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readFactionInputs } = require("./factions/sdeFactions");
const { buildCatalog } = require("./factions/buildCatalog");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SDE = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3396210-jsonl");
const DEFAULT_OUT = path.join(__dirname, "..", "lib", "strategy", "data", "factionCatalog.js");
const SUMMARY_CANDIDATES = 3;

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

function summaryText(result, inputs) {
  const lines = [];
  const stats = new Map(result.stats.map((s) => [s.factionId, s]));
  let corps = 0;
  let stations = 0;
  for (const e of result.catalog) {
    corps += e.corporations.length;
    stations += e.stations.length;
    const s = stats.get(e.factionId);
    const c = e.candidates;
    lines.push(`${e.factionId} ${e.name}: corp ${e.corporationId} corporations=${e.corporations.length} `
      + `stations=${e.stations.length} hq=${e.sdeHqSystemId} own=[${e.ownRegionIds.join(",")}] `
      + `border=[${e.borderRegionIds.join(",")}]`);
    lines.push(`    R-B border=${c.border.length} first=${JSON.stringify(c.border.slice(0, SUMMARY_CANDIDATES))}`
      + ` unreachable=${s.unreachableBorder}`);
    lines.push(`    R-N base=${c.suggestedBaseSystemId} nullsec=${c.nullsec.length} `
      + `first=${JSON.stringify(c.nullsec.slice(0, SUMMARY_CANDIDATES))} unreachable=${s.unreachableNullsec}`);
  }
  lines.push(`factions ${result.catalog.length}, corporations ${corps} (of ${inputs.corporations.length} live, `
    + `${inputs.deletedCorporations} deleted skipped), faction stations ${stations} (of ${inputs.stations.length}), `
    + `SDE build ${result.header.buildNumber} (${result.header.releaseDate})`);
  lines.push("SDE factions.jsonl has no executive friend/enemy relations: hostility stays on its source");
  return lines.join("\n");
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node buildFactionCatalog.js [--sde <dir>] [--out <file>] `
      + "[--check] [--summary]\n");
    return 2;
  }
  const inputs = await readFactionInputs(args.sde);
  const result = buildCatalog(inputs);
  if (!result.ok) {
    process.stderr.write(`faction catalog: build failed ${result.reason} ${result.detail}\n`);
    return 1;
  }
  const hash = sha256(result.source);
  if (args.summary) process.stdout.write(`${summaryText(result, inputs)}\n`);
  if (args.check) {
    const current = fs.existsSync(args.out) ? sha256(fs.readFileSync(args.out, "utf8")) : "(missing)";
    if (current !== hash) {
      process.stderr.write(`faction catalog: OUT OF DATE (file ${current}, generated ${hash}) - regenerate\n`);
      return 1;
    }
    process.stdout.write(`faction catalog: up to date (sha256 ${hash})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, result.source, "utf8");
  process.stdout.write(`faction catalog: ${result.catalog.length} factions -> ${args.out} (sha256 ${hash})\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`faction catalog: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
