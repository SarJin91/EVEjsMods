"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_OUT = path.join(__dirname, "..", "data", "mapNames.json");

function readNames(file) {
  const names = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    const id = Number(row._key);
    const name = row.name && row.name.en;
    if (!Number.isSafeInteger(id) || id <= 0 || typeof name !== "string" || name.trim() === "") {
      throw new Error(`${path.basename(file)}: bad row ${line.slice(0, 80)}`);
    }
    names.set(id, name);
  }
  return Object.fromEntries([...names].sort((a, b) => a[0] - b[0]).map(([id, name]) => [String(id), name]));
}

function main(argv) {
  const sdeDir = argv[0];
  if (!sdeDir) {
    process.stderr.write("usage: node genMapNames.js <sdeJsonlDir> [outFile]\n");
    return 2;
  }
  const outFile = argv[1] || DEFAULT_OUT;
  const build = (/static-data-(\d+)/.exec(path.basename(path.resolve(sdeDir))) || [])[1] || "unknown";
  const regions = readNames(path.join(sdeDir, "mapRegions.jsonl"));
  const constellations = readNames(path.join(sdeDir, "mapConstellations.jsonl"));
  const factions = readNames(path.join(sdeDir, "factions.jsonl"));
  const payload = { source: `SDE ${build}`, regions, constellations, factions };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
  process.stdout.write(`mapNames: ${Object.keys(regions).length} regions, ${Object.keys(constellations).length} `
    + `constellations, ${Object.keys(factions).length} factions -> ${outFile} (${fs.statSync(outFile).size} bytes)\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
