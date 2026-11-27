#!/usr/bin/env node
"use strict";

const Module = require("node:module");
const path = require("node:path");
const {
  DEFAULT_PIN_ROWS,
  STRUCTURES_TARGET,
  applyPlannerPin,
  pinStatOf,
  readStat,
  removePlannerPin,
  writeStat,
} = require("../lib/plannerPin");
const { probeTriggerPlan, resolveTarget } = require("../lib/triggerProbe");

const USAGE = [
  "Usage: node tools/plannerPin.js --status|--apply|--remove <gamestore.sqlite> [--pin-rows N] [--runtime-root DIR]",
  "  --status  read only: target index, current statistic, query plans with and without the pin",
  "  --apply   pin the statistic now (refused while a persistence owner holds a live lease)",
  "  --remove  delete the pinned statistic row (refused while a persistence owner holds a live lease)",
].join("\n");

function parseArgs(argv) {
  const args = { mode: null, file: null, pinRows: DEFAULT_PIN_ROWS, runtimeRoot: path.resolve(__dirname, "../../..") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--status" || arg === "--apply" || arg === "--remove") {
      if (args.mode) return { error: "only one of --status, --apply, --remove" };
      args.mode = arg.slice(2);
    } else if (arg === "--pin-rows") {
      args.pinRows = Number(argv[++i]);
    } else if (arg === "--runtime-root") {
      args.runtimeRoot = path.resolve(String(argv[++i] || ""));
    } else if (arg.startsWith("--")) {
      return { error: `unknown option ${arg}` };
    } else if (!args.file) {
      args.file = arg;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }
  if (!args.mode || !args.file) return { error: "a mode and a database file are required" };
  if (!Number.isSafeInteger(args.pinRows)) return { error: "--pin-rows must be an integer" };
  return args;
}

function vendor(runtimeRoot) {
  const serverFile = (relative) => path.resolve(runtimeRoot, "server", "src", "gameStore", ...relative.split("/"));
  const vendorRequire = Module.createRequire(serverFile("sqliteStore.js"));
  return {
    Database: vendorRequire("better-sqlite3"),
    applicationId: require(serverFile("shared-schema/version.js")).APPLICATION_ID,
    structuresSchema: require(serverFile("shared-schema/structureSchema.js")).structuresSchema,
  };
}

function liveLeases(db) {
  const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = '_persistence_owners'").get();
  if (!table) return [];
  return db.prepare("SELECT owner_role, lease_expires_at FROM _persistence_owners WHERE active = 1 AND lease_expires_at > ?")
    .all(Date.now());
}

function probeText(probe) {
  if (!probe) return "n/a";
  const detail = probe.detail ? ` (${probe.detail})` : "";
  return `${probe.reason} ${probe.total - probe.bad}/${probe.total} good${detail}`;
}

function generatorProbes(api, target, pinRows) {
  const memory = new api.Database(":memory:");
  try {
    memory.exec(api.structuresSchema());
    const generated = resolveTarget(memory, target);
    if (!generated.ok) return { generated, plain: null, pinned: null };
    const plain = probeTriggerPlan(memory, generated);
    writeStat(memory, generated.recordsTable, generated.indexName, pinStatOf(pinRows));
    const pinned = probeTriggerPlan(memory, generated);
    return { generated, plain, pinned };
  } finally {
    memory.close();
  }
}

function status(api, file, pinRows, print) {
  const db = new api.Database(file, { readonly: true, fileMustExist: true });
  try {
    const target = STRUCTURES_TARGET;
    print(`file: ${file}`);
    print(`sqlite: ${db.prepare("SELECT sqlite_version() AS v").get().v}`);
    const shared = db.pragma("application_id", { simple: true }) === api.applicationId;
    print(`shared schema: ${shared}`);
    if (!shared) return 1;
    const live = resolveTarget(db, target);
    print(`target: ${target.trigger} -> ${target.recordsTable} ${live.ok ? `index=${live.indexName}` : live.reason}`);
    if (!live.ok) return 1;
    const current = readStat(db, live.recordsTable, live.indexName);
    print(`statistic: ${current === null ? "none" : JSON.stringify(current)} (pin = ${JSON.stringify(pinStatOf(pinRows))})`);
    const leases = liveLeases(db);
    print(`live owner leases: ${leases.length === 0 ? "none" : leases.map((row) => row.owner_role).join(", ")}`);
    const probes = generatorProbes(api, target, pinRows);
    const sameTrigger = probes.generated.ok && probes.generated.triggerSql === live.triggerSql;
    print(`stored trigger equals vendor generator: ${sameTrigger}`);
    print(`plan now: ${probeText(probeTriggerPlan(db, live))}`);
    print(`plan of vendor generator without statistics: ${probeText(probes.plain)}`);
    print(`plan of vendor generator with the pin: ${probeText(probes.pinned)}`);
    let verdict;
    if (probes.plain && probes.plain.reason === "GOOD" && sameTrigger) verdict = current === pinStatOf(pinRows) ? "vendor fixed, would remove pin" : "vendor fixed, nothing to do";
    else if (current === null) verdict = "would pin";
    else if (current === pinStatOf(pinRows)) verdict = "already pinned";
    else verdict = "foreign statistic present, would verify and replace it if the plan is bad";
    print(`verdict: ${verdict}`);
    return 0;
  } finally {
    db.close();
  }
}

function write(api, mode, file, pinRows, print) {
  const db = new api.Database(file, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const leases = liveLeases(db);
    if (leases.length > 0) {
      print(`refused: live persistence owner lease (${leases.map((row) => row.owner_role).join(", ")}); stop the server first`);
      return 2;
    }
    const result = mode === "apply"
      ? applyPlannerPin(db, { pinRows, applicationId: api.applicationId, vendorSchemaSql: api.structuresSchema })
      : removePlannerPin(db, { pinRows });
    const probe = result.probe ? ` probe=${probeText(result.probe)}` : "";
    print(`${mode}: ${result.reason}${result.indexName ? ` index=${result.indexName}` : ""}${probe}${result.detail ? ` (${result.detail})` : ""}`);
    return result.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

function main(argv = process.argv.slice(2), print = (line) => console.log(line)) {
  const args = parseArgs(argv);
  if (args.error) {
    print(`error: ${args.error}`);
    print(USAGE);
    return 2;
  }
  const api = vendor(args.runtimeRoot);
  const file = path.resolve(args.file);
  return args.mode === "status" ? status(api, file, args.pinRows, print) : write(api, args.mode, file, args.pinRows, print);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`error: ${error && error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
