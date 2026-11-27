"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { CALIBRATION_METHOD } = require("./method");
const { buildBattles } = require("./dataset");
const { METHOD: STRENGTH_METHOD } = require("../strength/method");
const { resolveConfig } = require("../../config");
const { createStrengthCatalog } = require("../../lib/battle/strength");
const { stableJson } = require("../../lib/util/fingerprint");

const MOD_DIR = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(MOD_DIR, "..", "..");
const DEFAULTS = {
  raw: path.join(REPO_ROOT, "_local", "research", "killmails"),
  sde: path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3396210-jsonl"),
  out: path.join(REPO_ROOT, "Kanban", "research", "m5-calibration", "battles-v1.json"),
};
const KEY_RE = /^\{"_key": (\d+),/;
const GROUP_RE = /"groupID": (\d+)/;
const SEC_RE = /"securityStatus": (-?[\d.e-]+)/;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function parseArgs(argv) {
  const args = { ...DEFAULTS, train: [], validation: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if ((a === "--train" || a === "--validation") && v) { args[a.slice(2)] = v.split(",").filter(Boolean); i += 1; }
    else if ((a === "--raw" || a === "--sde" || a === "--out") && v) { args[a.slice(2)] = path.resolve(v); i += 1; }
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.train.length === 0 || args.validation.length === 0) throw new Error("--train and --validation required");
  const overlap = args.train.filter((d) => args.validation.includes(d));
  if (overlap.length > 0) throw new Error(`days in both splits: ${overlap.join(",")}`);
  return args;
}

async function streamLines(file, onLine) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) onLine(line);
}

async function readSde(sdeDir, wantedTypes) {
  const groupCategory = new Map();
  for (const line of fs.readFileSync(path.join(sdeDir, "groups.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    groupCategory.set(Number(row._key), row.categoryID);
  }
  const typeGroup = new Map();
  await streamLines(path.join(sdeDir, "types.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    if (!key || !wantedTypes.has(Number(key[1]))) return;
    const group = GROUP_RE.exec(line);
    if (group) typeGroup.set(Number(key[1]), Number(group[1]));
  });
  const systemSec = new Map();
  await streamLines(path.join(sdeDir, "mapSolarSystems.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    const sec = SEC_RE.exec(line);
    if (key && sec) systemSec.set(Number(key[1]), Number(sec[1]));
  });
  let sdeBuild = null;
  for (const line of fs.readFileSync(path.join(sdeDir, "_sde.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() !== "" && JSON.parse(line)._key === "sde") sdeBuild = JSON.parse(line).buildNumber;
  }
  return { groupCategory, typeGroup, systemSec, sdeBuild };
}

function referencedTypes(dayRecords) {
  const ids = new Set();
  for (const records of dayRecords) {
    for (const key of Object.keys(records)) {
      const r = records[key];
      const esi = (r && (r.esi || r.killmail)) || r;
      if (!esi || !esi.victim) continue;
      ids.add(esi.victim.ship_type_id);
      for (const a of esi.attackers || []) if (a && a.ship_type_id) ids.add(a.ship_type_id);
    }
  }
  return ids;
}

function normalise(battle) {
  return { ...battle, spanSec: Number(battle.spanSec.toFixed(CALIBRATION_METHOD.dataset.digits)) };
}

async function main(argv) {
  const args = parseArgs(argv);
  const manifestFile = path.join(args.raw, "manifest.json");
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const days = [...args.train.map((d) => ({ day: d, split: "train" })),
    ...args.validation.map((d) => ({ day: d, split: "validation" }))];
  const dayRecords = days.map(({ day }) => JSON.parse(fs.readFileSync(path.join(args.raw, "raw", `${day}.json`), "utf8")));
  const sde = await readSde(args.sde, referencedTypes(dayRecords));
  const resolved = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
  const made = createStrengthCatalog(undefined, { groupConfidence: resolved.battle.strengthGroupConfidence,
    unknownTypeConfidence: resolved.battle.strengthUnknownTypeConfidence });
  if (!made.ok) throw new Error(`strength catalog ${made.reason}`);
  const limits = { maxFleetsPerSide: resolved.battle.maxFleetsPerSide, maxShipsPerFleet: resolved.fleets.maxShipsPerFleet,
    maxCompositionEntries: resolved.fleets.maxCompositionEntries };
  const battles = [];
  const counts = { train: 0, validation: 0, records: 0, rejected: {}, skippedEntries: 0, perDay: {} };
  days.forEach(({ day, split }, i) => {
    const records = dayRecords[i];
    const r = buildBattles(records, { method: CALIBRATION_METHOD, typeGroup: sde.typeGroup,
      groupCategory: sde.groupCategory, groupMap: STRENGTH_METHOD.groupMap, systemSec: sde.systemSec,
      catalog: made.catalog, limits, split });
    const n = Object.keys(records).length;
    counts.records += n;
    counts[split] += r.battles.length;
    counts.skippedEntries += r.skippedEntries;
    for (const [k, v] of Object.entries(r.rejected)) counts.rejected[k] = (counts.rejected[k] || 0) + v;
    counts.perDay[day] = { split, records: n, battles: r.battles.length, rejected: r.rejected,
      skippedEntries: r.skippedEntries };
    for (const b of r.battles) battles.push(normalise({ ...b, day }));
  });
  const entry = (day) => manifest.entries.find((e) => e.day === day) || {};
  const dataset = {
    v: 1,
    datasetVersion: CALIBRATION_METHOD.datasetVersion,
    source: {
      kind: "zKillboard history/raw daily dumps (ESI killmails, no zkb block)",
      urls: days.map(({ day }) => entry(day).url || CALIBRATION_METHOD.fetch.rawUrl.replace("{day}", day)),
      days: days.map(({ day, split }) => ({ day, split, sha256: entry(day).sha256 || null, bytes: entry(day).bytes || null,
        fetchedAt: entry(day).fetchedAt || null })),
      manifestSha256: sha256(manifestBytes),
      userAgent: manifest.userAgent || null,
    },
    sdeBuild: sde.sdeBuild,
    calibrationMethod: CALIBRATION_METHOD.version,
    strengthMethodVersion: made.catalog.header.methodVersion,
    strengthSourceHash: made.catalog.header.sourceHash,
    counts,
    battles,
  };
  const head = { ...dataset, battles: [] };
  const text = `${stableJson(head).replace(/"battles":\[\]/, `"battles":[\n${battles.map(stableJson).join(",\n")}\n]`)}\n`;
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, text);
  process.stdout.write(`dataset: ${counts.train} train + ${counts.validation} validation battles from ${counts.records} `
    + `killmails -> ${args.out} (sha256 ${sha256(text)})\nrejected ${JSON.stringify(counts.rejected)}, skipped entries `
    + `${counts.skippedEntries}\n`);
  const classes = {};
  for (const b of battles) for (const c of b.classes) classes[`${b.split}:${c}`] = (classes[`${b.split}:${c}`] || 0) + 1;
  process.stdout.write(`classes ${JSON.stringify(classes)}\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.stdout.write("calibration: OK\n");
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`${(err && err.stack) || err}\n`);
  process.stdout.write(`calibration: FAIL ${(err && err.message) || err}\n`);
  process.exitCode = 1;
});
