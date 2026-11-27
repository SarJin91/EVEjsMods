"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readSdeHeader, readBlueprints, readMetaGroups, streamLines } = require("./strength/sdeReader");
const { buildHullTradeTypes, HULL_TRADE_METHOD } = require("./trade/buildHullTradeTypes");
const STRENGTH = require("../lib/battle/data/strengthCatalog");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_SDE = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3724492-jsonl");
const DEFAULT_OUT = path.join(__dirname, "..", "lib", "economy", "data", "hullTradeTypes.js");

const KEY_RE = /^\{"_key": (\d+),/;
const NEEDLE = "\"attributeID\": 182,";
const KEPT_ATTRIBUTES = Object.freeze([182, 183, 184, 422, 633, 1692]);

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

async function readSkillDogma(sdeDir) {
  const out = new Map();
  await streamLines(path.join(sdeDir, "typeDogma.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    if (!key || !line.includes(NEEDLE)) return;
    const row = JSON.parse(line);
    const attrs = {};
    for (const a of row.dogmaAttributes || []) {
      if (KEPT_ATTRIBUTES.includes(a.attributeID)) attrs[a.attributeID] = a.value;
    }
    out.set(Number(key[1]), attrs);
  });
  return out;
}

function readRaces(sdeDir) {
  const races = [];
  for (const line of fs.readFileSync(path.join(sdeDir, "races.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    // The SDE lists the other races' starting skills too, at level 0; only a trained starting skill marks the race.
    races.push({ raceId: Number(row._key), skills: (row.skills || []).filter((s) => Number(s._value) > 0)
      .map((s) => Number(s._key)) });
  }
  return races;
}

function summaryTable(result) {
  const lines = [["race", "group", "typeId", "level", "minerals", "n"].map((c) => c.padStart(13)).join(" ")];
  for (const r of result.rows) {
    lines.push([r.raceId, r.group, r.typeId, r.level, r.mineralSum, r.sampleSize]
      .map((v) => String(v).padStart(13)).join(" "));
  }
  lines.push(`types ${result.header.typeCount}, factions ${Object.keys(result.factionRace).length}, `
    + `controls ${JSON.stringify(HULL_TRADE_METHOD.raceControls)} ok`);
  return lines.join("\n");
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node buildHullTradeTypes.js [--sde <dir>] [--out <file>] `
      + "[--check] [--summary]\n");
    return 2;
  }
  const hulls = Object.values(STRENGTH.TYPES);
  const metaGroups = await readMetaGroups(args.sde, hulls.map((t) => t.typeId));
  const types = hulls.map((t) => ({ typeId: t.typeId, groupId: t.groupId, hullGroup: t.hullGroup,
    metaGroupId: metaGroups.get(t.typeId) }));
  const result = buildHullTradeTypes({ sde: readSdeHeader(args.sde), types, blueprints: readBlueprints(args.sde),
    dogma: await readSkillDogma(args.sde), races: readRaces(args.sde) });
  if (!result.ok) {
    process.stderr.write(`hull trade types: build failed ${result.reason} ${result.detail}\n`);
    return 1;
  }
  const hash = sha256(result.source);
  if (args.summary) process.stdout.write(`${summaryTable(result)}\n`);
  if (args.check) {
    const current = fs.existsSync(args.out) ? sha256(fs.readFileSync(args.out, "utf8")) : "(missing)";
    if (current !== hash) {
      process.stderr.write(`hull trade types: OUT OF DATE (file ${current}, generated ${hash}) - regenerate\n`);
      return 1;
    }
    process.stdout.write(`hull trade types: up to date (sha256 ${hash})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, result.source, "utf8");
  process.stdout.write(`hull trade types: ${result.header.typeCount} types -> ${args.out} (sha256 ${hash})\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`hull trade types: ${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
