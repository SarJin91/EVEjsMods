"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildNpcSovCatalog } = require("./npcSov/buildNpcSovCatalog.lib");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SDE = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3396210-jsonl");
const DEFAULT_OUT = path.join(__dirname, "..", "lib", "world", "core", "npcSovData.js");
const FILES = Object.freeze(["_sde.jsonl", "mapSolarSystems.jsonl", "mapConstellations.jsonl", "mapRegions.jsonl"]);

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

function readRows(sdeDir, name) {
  const file = path.join(sdeDir, name);
  const rows = [];
  let lineNo = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    lineNo += 1;
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    if (!row || row._key === undefined || row._key === null) throw new Error(`${file}:${lineNo}: row without _key`);
    rows.push(row);
  }
  return rows;
}

function readInputs(sdeDir) {
  const missing = FILES.filter((name) => !fs.existsSync(path.join(sdeDir, name)));
  if (missing.length > 0) throw new Error(`${sdeDir}: missing SDE files ${missing.join(", ")}`);
  const header = readRows(sdeDir, "_sde.jsonl").find((r) => r._key === "sde");
  if (!header) throw new Error(`${sdeDir}: _sde.jsonl has no sde row`);
  return {
    sde: { buildNumber: header.buildNumber, releaseDate: header.releaseDate },
    systems: readRows(sdeDir, "mapSolarSystems.jsonl").map((r) => ({ systemId: r._key, regionId: r.regionID,
      constellationId: r.constellationID, securityStatus: r.securityStatus, factionId: r.factionID })),
    constellations: readRows(sdeDir, "mapConstellations.jsonl").map((r) => ({ constellationId: r._key,
      factionId: r.factionID })),
    regions: readRows(sdeDir, "mapRegions.jsonl").map((r) => ({ regionId: r._key, factionId: r.factionID })),
  };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node buildNpcSovCatalog.js [--sde <dir>] [--out <file>] `
      + "[--check] [--summary]\n");
    return 2;
  }
  const inputs = readInputs(args.sde);
  const result = buildNpcSovCatalog(inputs);
  if (!result.ok) {
    process.stderr.write(`npc sov catalog: build failed ${result.reason} ${result.detail}\n`);
    return 1;
  }
  const hash = sha256(result.source);
  if (args.summary) {
    const counts = [...result.byFaction].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const [factionId, n] of counts) process.stdout.write(`${factionId}: ${n}\n`);
    process.stdout.write(`systems ${result.rows.length}, factions ${counts.length}, `
      + `SDE build ${inputs.sde.buildNumber} (${inputs.sde.releaseDate})\n`);
  }
  if (args.check) {
    const current = fs.existsSync(args.out) ? sha256(fs.readFileSync(args.out, "utf8")) : "(missing)";
    if (current !== hash) {
      process.stderr.write(`npc sov catalog: OUT OF DATE (file ${current}, generated ${hash}) - regenerate\n`);
      return 1;
    }
    process.stdout.write(`npc sov catalog: up to date (sha256 ${hash})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, result.source, "utf8");
  process.stdout.write(`npc sov catalog: ${result.rows.length} systems -> ${args.out} (sha256 ${hash})\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`npc sov catalog: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
}
