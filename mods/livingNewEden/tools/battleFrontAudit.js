"use strict";

const fs = require("node:fs");
const os = require("node:os");

const { loadConfig } = require("../config");
const { readSchemaVersion } = require("../lib/persistence/migrations");
const { createStrengthCatalog, expandStrengthGroups } = require("../lib/battle/strength");
const { GROUPS: STRENGTH_GROUPS } = require("../lib/battle/data/strengthCatalog");
const { capitalPowerOverlayOf } = require("../lib/battle/data/capitalStrengthRows");
const { buildResolverParams } = require("../lib/battle/resolverParams");
const { buildPowerTable } = require("../lib/strategy/ai/strength");
const resolver = require("../lib/battle/resolverInternalV1");
const { auditBattles, stationPointsOf, GATE, OUTCOMES } = require("./battleAudit/frontImpact");
const { EXIT, MOD_DIR, LOCKED_MESSAGE, messageOf, loadDriver, resolveDbFile, openLocked, closeQuietly, sideFilesOf,
  removeCreatedSideFiles, takeSnapshot } = require("./offlineDb");

const DEFAULT_TOP = 20;
const SNAPSHOT_PREFIX = "lne-battle-front-";
const USAGE = "usage: node mods/livingNewEden/tools/battleFrontAudit.js [--db <file>] [--snapshot] [--since <ms>] "
  + "[--system <id>]... [--top <n>] [--json]";
const VALUE_ARGS = Object.freeze(["--db", "--since", "--system", "--top"]);

function parseArgs(argv) {
  const out = { db: null, snapshot: false, since: null, systems: [], top: DEFAULT_TOP, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--snapshot" || arg === "--json") {
      out[arg.slice(2)] = true;
      continue;
    }
    if (!VALUE_ARGS.includes(arg)) return { ok: false, detail: `unknown argument ${arg}` };
    const value = argv[i + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      return { ok: false, detail: `${arg} needs a value` };
    }
    i += 1;
    if (arg === "--db") {
      out.db = value;
      continue;
    }
    const n = Number(value);
    const min = arg === "--since" ? 0 : 1;
    if (!Number.isSafeInteger(n) || n < min) return { ok: false, detail: `${arg} needs an integer >= ${min}` };
    if (arg === "--since") out.since = n;
    else if (arg === "--system") out.systems.push(n);
    else out.top = n;
  }
  return { ok: true, ...out };
}

function tablesOf(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

function battleFilter(args) {
  const where = ["r.mode = 'VIRTUAL'", "r.state = 'COMPLETED'", "r.result_json IS NOT NULL"];
  const params = [];
  if (args.since !== null) {
    where.push("r.settled_at >= ?");
    params.push(args.since);
  }
  if (args.systems.length > 0) {
    where.push(`r.system_id IN (${args.systems.map(() => "?").join(", ")})`);
    params.push(...args.systems);
  }
  return { sql: where.join(" AND "), params };
}

function readRows(db, args, tables) {
  const f = battleFilter(args);
  const battles = db.prepare("SELECT r.battle_id, r.system_id, r.objective, r.seed, r.input_json, r.result_json, "
    + `r.settled_at FROM battle_records r WHERE ${f.sql} ORDER BY r.settled_at, r.battle_id`).all(...f.params);
  const losses = new Map();
  for (const l of db.prepare("SELECT l.battle_id, p.side, SUM(l.count) AS n FROM battle_losses l "
    + "JOIN battle_participants p ON p.battle_id = l.battle_id AND p.fleet_id = l.fleet_id "
    + `JOIN battle_records r ON r.battle_id = l.battle_id WHERE ${f.sql} GROUP BY l.battle_id, p.side`)
    .all(...f.params)) {
    const e = losses.get(l.battle_id) || { A: 0, B: 0 };
    e[l.side] = Number(l.n) || 0;
    losses.set(l.battle_id, e);
  }
  const stations = tables.has("world_stations")
    ? db.prepare("SELECT system_id, owner_faction_id, kind, structure_family, state FROM world_stations "
      + "WHERE state = 'ONLINE'").all().map((s) => ({ systemId: s.system_id, ownerFactionId: s.owner_faction_id,
      kind: s.kind, structureFamily: s.structure_family, state: s.state }))
    : null;
  const systems = new Map();
  if (tables.has("world_system_state")) {
    const q = db.prepare("SELECT controller_faction_id, occupation_state FROM world_system_state WHERE system_id = ?");
    for (const b of battles) {
      if (systems.has(b.system_id)) continue;
      systems.set(b.system_id, q.get(b.system_id) || null);
    }
  }
  const rows = battles.map((b) => {
    const l = losses.get(b.battle_id) || { A: 0, B: 0 };
    const s = systems.get(b.system_id) || null;
    return { battleId: b.battle_id, systemId: b.system_id, objective: b.objective, inputJson: b.input_json,
      resultJson: b.result_json, settledAt: b.settled_at, lossesA: l.A, lossesB: l.B,
      controllerNow: s ? s.controller_faction_id : null, occupationNow: s ? s.occupation_state : null };
  });
  return { rows, stations };
}

const pct = (v) => `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
const counts = (c) => `${OUTCOMES.map((o) => `${o}=${c[o]}`).join(" ")} REFUSED=${c.REFUSED}`;
const yes = (v) => (v ? "YES" : "NO");

function printGate(print, title, g) {
  print(`${title}: verdict ${g.verdict}`);
  print(`  battles=${g.battles} G(garrison B)=${g.g} resolved V1=${g.gResolved} refused V1=${g.gRefusedV1}`);
  print(`  P0 parity=${pct(g.parityShare)} paramsHash=${pct(g.paramsMatchShare)} (threshold ${pct(g.thresholds.parityMin)}`
    + ` / ${pct(g.thresholds.paramsMatchMin)}) -> ${yes(g.p0)}`);
  if (g.parityShare < g.thresholds.parityMin && g.paramsMatchShare >= g.thresholds.paramsMatchMin) {
    print("  warning: parity below the threshold with a matching paramsHash - catalog or resolver change, not env");
  }
  print(`  P1 B_WIN(V1, G)=${pct(g.bWinShareV1)} (threshold <= ${pct(g.thresholds.bWinMaxV1)}) -> ${yes(g.p1)}`);
  print(`  P2 A_WIN(V1, G)=${pct(g.aWinShareV1)} (threshold <= ${pct(g.thresholds.aWinMaxV1)}) -> ${yes(g.p2)}`);
}

function printReport(print, out, args, ctx) {
  print(`Config of this process: siege.enabled=${ctx.siege.enabled === true} `
    + `siege.stationGarrisonEnabled=${ctx.siege.stationGarrisonEnabled === true} paramsHash=${ctx.paramsHash}`);
  if (ctx.stationsMissing) print("  warning: missing table world_stations - station points = 0");
  print(`VIRTUAL COMPLETED battles: ${out.battles.length} (unreadable: ${out.unreadable.length})`);
  for (const u of out.unreadable.slice(0, args.top)) print(`  unreadable ${u.battleId}: ${u.detail}`);
  print("");
  print(`Recorded: ${counts(out.totals.recorded)}`);
  print(`V0      : ${counts(out.totals.v0)}`);
  print(`V1 (off): ${counts(out.totals.v1)}`);
  print(`V2 (none): ${counts(out.totals.v2)}`);
  print("");
  printGate(print, "Gate (all G battles, V1 approximate - stations now)", out.gate);
  printGate(print, "Gate (only G battles with influencePart > 0)", out.gateInfluence);
  print("");
  print(`System / faction pair (most battles, --top ${args.top}): ${out.pairs.length}`);
  print("  system  factionLo factionHi battles | recorded A/B/D/R | V1 A/B/D/R | V2 A/B/D/R | losses Lo/Hi | controller state");
  const abdr = (c) => `${c.A_WIN}/${c.B_WIN}/${c.DRAW}/${c.BOTH_RETREAT}${c.REFUSED ? ` (ref ${c.REFUSED})` : ""}`;
  for (const p of out.pairs.slice(0, args.top)) {
    print(`  ${p.systemId} ${p.factionLo} ${p.factionHi} ${p.battles} | ${abdr(p.recorded)} | ${abdr(p.v1)} | `
      + `${abdr(p.v2)} | ${p.lossesLo}/${p.lossesHi} | ${p.controllerNow === null ? "-" : p.controllerNow} `
      + `${p.occupationNow || "-"}`);
  }
  if (out.pairs.length > args.top) print(`  ... ${out.pairs.length - args.top} more (--top)`);
  const changed = out.battles.filter((b) => b.garrisonSide !== null && b.v1 !== b.recorded);
  print("");
  print(`Battles with a garrison where V1 changes the outcome: ${changed.length}`);
  print("  battleId system objective A/B power A/B | garrison side/strength/stations/influence | V1 side/strength | recorded V0 V1 V2 "
    + "| parity hash");
  for (const b of changed.slice(0, args.top)) {
    print(`  ${b.battleId} ${b.systemId} ${b.objective} ${b.factionA}/${b.factionB} ${b.powerA}/${b.powerB} | `
      + `${b.garrisonSide}/${b.garrisonStrength}/${b.stationPtsNow}/${b.influencePart} | `
      + `${b.v1GarrisonSide || "-"}/${b.v1GarrisonStrength === null ? "-" : b.v1GarrisonStrength} | ${b.recorded} ${b.v0} `
      + `${b.v1} ${b.v2} | ${yes(b.parity)} ${yes(b.paramsMatch)}`);
  }
  if (changed.length > args.top) print(`  ... ${changed.length - args.top} more (--top)`);
}

function report(db, print, args, ctx) {
  try {
    const version = readSchemaVersion(db);
    if (!version.ok || version.version === 0) {
      print(`REFUSED: this is not a Living New Eden database (${version.reason || "EMPTY"}: ${version.detail || "-"})`);
      return EXIT.REFUSED;
    }
    const tables = tablesOf(db);
    if (!tables.has("battle_records")) {
      print("REFUSED: missing table battle_records");
      return EXIT.REFUSED;
    }
    const { rows, stations } = readRows(db, args, tables);
    const out = auditBattles(rows, { catalog: ctx.catalog, params: ctx.params, powerTable: ctx.powerTable,
      resolve: resolver.resolve,
      stationPoints: (systemId, factionId) => stationPointsOf(stations || [], systemId, factionId, ctx.config) });
    if (args.json) {
      print(JSON.stringify({ schemaVersion: version.version, paramsHash: ctx.params.paramsHash, gateThresholds: GATE,
        stationsMissing: stations === null, ...out }));
    } else {
      print(`Schema: ${version.version}`);
      printReport(print, out, args, { siege: ctx.config.siege || {}, paramsHash: ctx.params.paramsHash,
        stationsMissing: stations === null });
    }
    return EXIT.OK;
  } catch (err) {
    print(`FAILED: ${messageOf(err)}`);
    return EXIT.FAILED;
  }
}

function resolverContext(config) {
  const battle = config.battle || {};
  const made = createStrengthCatalog(undefined, { groupConfidence: battle.strengthGroupConfidence,
    unknownTypeConfidence: battle.strengthUnknownTypeConfidence });
  if (!made.ok) return { ok: false, detail: `strength catalog: ${made.detail}` };
  const built = buildResolverParams(config);
  if (!built.ok) return { ok: false, detail: `resolver parameters: ${built.detail}` };
  return { ok: true, catalog: made.catalog, params: built.params,
    powerTable: buildPowerTable(expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy))) };
}

function main(opts = {}) {
  const print = typeof opts.print === "function" ? opts.print : (line) => process.stdout.write(`${line}\n`);
  const env = opts.env || process.env;
  const args = parseArgs(opts.argv || []);
  if (!args.ok) {
    print(`battleFrontAudit: ${args.detail}`);
    print(USAGE);
    return EXIT.USAGE;
  }
  if (args.help) {
    print(USAGE);
    print("Read-only. Re-resolves VIRTUAL battles (V0 recorded input, V1 mode off: garrison B from B's stations, "
      + "otherwise A from A's stations, points now; V2 no garrison) and computes the flip gate. --snapshot: a copy of the database (works while the server runs).");
    return EXIT.OK;
  }
  const { file, warnings } = resolveDbFile(args.db, env);
  const log = args.json ? () => {} : print;
  log(`battleFrontAudit (read-only${args.snapshot ? ", copy" : ""}): database ${file}`);
  for (const w of warnings) log(`  warning (config): ${w}`);
  if (!fs.existsSync(file)) {
    log("No database file.");
    if (args.json) print(JSON.stringify({ ok: false, reason: "NO_FILE", file }));
    return EXIT.OK;
  }
  const config = opts.config || (loadConfig({ modDir: MOD_DIR, env }).config || {});
  const rc = resolverContext(config);
  if (!rc.ok) {
    print(`battleFrontAudit: ${rc.detail}`);
    return EXIT.FAILED;
  }
  const driver = opts.driver || loadDriver();
  if (!driver || driver.ok === false || typeof driver.Database !== "function") {
    print(`battleFrontAudit: no better-sqlite3 driver (${(driver && (driver.detail || driver.reason)) || "?"})`);
    return EXIT.FAILED;
  }
  let snap = null;
  let target = file;
  if (args.snapshot) {
    try {
      snap = takeSnapshot(file, opts.tmpDir || os.tmpdir(), SNAPSHOT_PREFIX);
      target = snap.file;
    } catch (err) {
      print(`battleFrontAudit: copy failed: ${messageOf(err)}`);
      return EXIT.FAILED;
    }
  }
  const sideBefore = snap ? null : sideFilesOf(file);
  const opened = openLocked(driver, target, { readonly: true });
  if (!opened.ok) {
    if (snap) fs.rmSync(snap.dir, { recursive: true, force: true });
    if (opened.reason === "LOCKED") {
      print(`${LOCKED_MESSAGE} Or run with --snapshot (a copy of the database, works while the server runs).`);
      return EXIT.REFUSED;
    }
    print(`battleFrontAudit: cannot open the database: ${opened.detail}`
      + `${snap ? " (the copy may be torn - retry)" : ""}`);
    return EXIT.FAILED;
  }
  const { db } = opened;
  let code;
  try {
    code = report(db, print, args, { config, ...rc });
  } finally {
    if (snap) {
      closeQuietly(db);
      try {
        fs.rmSync(snap.dir, { recursive: true, force: true });
      } catch (err) {
        log(`  warning: copy left behind ${snap.dir} (${messageOf(err)})`);
      }
    } else {
      const first = removeCreatedSideFiles(file, sideBefore);
      closeQuietly(db);
      const after = first.failed.length > 0 ? removeCreatedSideFiles(file, sideBefore, { only: first.failed })
        : { kept: [] };
      const kept = [...first.kept.filter((k) => !first.failed.includes(k.file)), ...after.kept];
      for (const k of kept) log(`  warning: file left behind ${k.file} (${k.detail})`);
    }
  }
  return code;
}

module.exports = { main, parseArgs, readRows, EXIT };

if (require.main === module) process.exitCode = main({ argv: process.argv.slice(2) });
