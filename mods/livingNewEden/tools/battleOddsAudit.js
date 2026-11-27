"use strict";

const fs = require("node:fs");
const os = require("node:os");

const { loadConfig } = require("../config");
const { readSchemaVersion } = require("../lib/persistence/migrations");
const { expandStrengthGroups } = require("../lib/battle/strength");
const { GROUPS: STRENGTH_GROUPS } = require("../lib/battle/data/strengthCatalog");
const { capitalPowerOverlayOf } = require("../lib/battle/data/capitalStrengthRows");
const { buildPowerTable } = require("../lib/strategy/ai/strength");
const { auditOdds, OUTCOMES, OTHER } = require("./battleAudit/odds");
const { EXIT, MOD_DIR, LOCKED_MESSAGE, messageOf, loadDriver, resolveDbFile, openLocked, closeQuietly, sideFilesOf,
  removeCreatedSideFiles, takeSnapshot } = require("./offlineDb");

const DEFAULT_TOP = 20;
const DEFAULT_GRIND_MIN = 6;
const DEFAULT_GRIND_WINDOW_MS = 86400000;
const DEFAULT_PIECEMEAL_MS = 7200000;
const PARTICIPANTS_CHUNK = 500;
const GANK_TYPE = "gank";
const BLOCKADE_TYPE = "blockade";
const ATTACK_TYPES = Object.freeze(["invasion", "raid"]);
const ESCORT_TYPE = "escort";
const GANK_COLUMNS = Object.freeze(["faction_id", "target_system_id", "operation_type", "planned_at", "due_at",
  "completed_at"]);
const V2_OPERATION_COLUMNS = Object.freeze(["operation_id", "operation_type", "target_system_id", "fleet_ids",
  "planned_at", "completed_at"]);
const TRANSITION_EVENT = "FLEET_TRANSITION";
const STAGED_LIKE = "%\"to\":\"STAGED\"%";
const V2_LIST_MAX = 12;
const SNAPSHOT_PREFIX = "lne-battle-odds-";
const USAGE = "usage: node mods/livingNewEden/tools/battleOddsAudit.js [--db <file>] [--snapshot] [--since <ms>] "
  + "[--top <n>] [--grind-min <n>] [--grind-window-ms <ms>] [--piecemeal-ms <ms>] [--json]";
const VALUE_ARGS = Object.freeze({ "--db": ["db", null], "--since": ["since", 0], "--top": ["top", 1],
  "--grind-min": ["grindMin", 1], "--grind-window-ms": ["grindWindowMs", 1], "--piecemeal-ms": ["piecemealMs", 1] });

function parseArgs(argv) {
  const out = { db: null, snapshot: false, since: null, top: DEFAULT_TOP, grindMin: DEFAULT_GRIND_MIN,
    grindWindowMs: DEFAULT_GRIND_WINDOW_MS, piecemealMs: DEFAULT_PIECEMEAL_MS, json: false, help: false };
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
    if (!Object.prototype.hasOwnProperty.call(VALUE_ARGS, arg)) return { ok: false, detail: `unknown argument ${arg}` };
    const value = argv[i + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      return { ok: false, detail: `${arg} needs a value` };
    }
    i += 1;
    const [field, min] = VALUE_ARGS[arg];
    if (min === null) {
      out[field] = value;
      continue;
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min) return { ok: false, detail: `${arg} needs an integer >= ${min}` };
    out[field] = n;
  }
  return { ok: true, ...out };
}

function tablesOf(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

function parseJson(text) {
  return typeof text === "string" ? JSON.parse(text) : null;
}

function readFactionsA(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += PARTICIPANTS_CHUNK) {
    const chunk = ids.slice(i, i + PARTICIPANTS_CHUNK);
    const rows = db.prepare("SELECT battle_id, fleet_id, side, faction_id FROM battle_participants "
      + `WHERE battle_id IN (${chunk.map(() => "?").join(", ")})`).all(...chunk);
    for (const p of rows) {
      if (p.side === "A" && !out.has(p.battle_id)) out.set(p.battle_id, Number(p.faction_id));
    }
  }
  return out;
}

function readOperations(db, tables, types) {
  if (!tables.has("world_operations")) return null;
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('world_operations')").all()
    .map((c) => c.name));
  if (!GANK_COLUMNS.every((c) => columns.has(c))) return null;
  return db.prepare("SELECT faction_id, target_system_id, operation_type, planned_at, due_at, completed_at "
    + `FROM world_operations WHERE operation_type IN (${types.map(() => "?").join(", ")})`).all(...types)
    .map((o) => ({ factionId: Number(o.faction_id), targetSystemId: Number(o.target_system_id),
      operationType: o.operation_type, plannedAt: Number(o.planned_at),
      dueAt: o.due_at === null ? null : Number(o.due_at),
      completedAt: o.completed_at === null ? null : Number(o.completed_at) }));
}

function readGanks(db, tables) {
  const ops = readOperations(db, tables, [GANK_TYPE]);
  return ops === null ? null : ops.map(({ operationType: _t, ...o }) => o);
}

const columnsOf = (db, table) => new Set(db.prepare("SELECT name FROM pragma_table_info(?)").all(table)
  .map((c) => c.name));

function readPiecemealV2(db, tables) {
  const out = { operations: null, arrivals: null, operationBattles: [], journalMinAt: null };
  const opCols = tables.has("world_operations") ? columnsOf(db, "world_operations") : new Set();
  if (V2_OPERATION_COLUMNS.every((c) => opCols.has(c))) {
    out.operations = [];
    const rows = db.prepare("SELECT operation_id, operation_type, target_system_id, fleet_ids, planned_at, "
      + `completed_at FROM world_operations WHERE operation_type IN (${ATTACK_TYPES.map(() => "?").join(", ")})`)
      .all(...ATTACK_TYPES);
    for (const o of rows) {
      let fleetIds;
      try {
        fleetIds = parseJson(o.fleet_ids);
      } catch (_err) {
        fleetIds = null;
      }
      if (!Array.isArray(fleetIds)) continue;
      out.operations.push({ operationId: o.operation_id, operationType: o.operation_type,
        targetSystemId: Number(o.target_system_id), fleetIds, plannedAt: Number(o.planned_at),
        completedAt: o.completed_at === null ? null : Number(o.completed_at) });
    }
  }
  const pCols = tables.has("battle_participants") ? columnsOf(db, "battle_participants") : new Set();
  if (["battle_id", "fleet_id", "side"].every((c) => pCols.has(c))) {
    const sideA = new Map();
    for (const p of db.prepare("SELECT battle_id, fleet_id FROM battle_participants WHERE side = 'A'").all()) {
      if (!sideA.has(p.battle_id)) sideA.set(p.battle_id, []);
      sideA.get(p.battle_id).push(p.fleet_id);
    }
    for (const b of db.prepare("SELECT battle_id, system_id, created_at, result_json FROM battle_records "
      + "WHERE state = 'COMPLETED'").all()) {
      if (!sideA.has(b.battle_id)) continue;
      let outcome = OTHER;
      try {
        const r = parseJson(b.result_json);
        if (r && typeof r.outcome === "string") outcome = r.outcome;
      } catch (_err) {
        outcome = OTHER;
      }
      out.operationBattles.push({ battleId: b.battle_id, systemId: Number(b.system_id),
        createdAt: Number(b.created_at), outcome, sideAFleetIds: sideA.get(b.battle_id) });
    }
  }
  const jCols = tables.has("world_event_journal") ? columnsOf(db, "world_event_journal") : new Set();
  if (["event_type", "payload", "created_at"].every((c) => jCols.has(c))) {
    out.journalMinAt = db.prepare("SELECT min(created_at) AS at FROM world_event_journal").get().at;
    out.journalMinAt = out.journalMinAt === null ? null : Number(out.journalMinAt);
    out.arrivals = new Map();
    const rows = db.prepare("SELECT payload, created_at FROM world_event_journal WHERE event_type = ? "
      + "AND payload LIKE ? ORDER BY created_at").all(TRANSITION_EVENT, STAGED_LIKE);
    for (const j of rows) {
      let p;
      try {
        p = parseJson(j.payload);
      } catch (_err) {
        continue;
      }
      if (!p || p.to !== "STAGED" || typeof p.fleetId !== "string") continue;
      const systemId = p.patch && p.patch.currentSystemId !== undefined && p.patch.currentSystemId !== null
        ? Number(p.patch.currentSystemId) : null;
      if (!out.arrivals.has(p.fleetId)) out.arrivals.set(p.fleetId, []);
      out.arrivals.get(p.fleetId).push({ at: Number(j.created_at), systemId });
    }
  }
  return out;
}

function readRows(db, args, tables) {
  const where = ["state = 'COMPLETED'", "result_json IS NOT NULL"];
  const params = [];
  if (args.since !== null) {
    where.push("settled_at >= ?");
    params.push(args.since);
  }
  const battles = db.prepare("SELECT battle_id, system_id, objective, mode, input_json, result_json, created_at, "
    + `settled_at FROM battle_records WHERE ${where.join(" AND ")} ORDER BY settled_at, battle_id`).all(...params);
  const factionsA = tables.has("battle_participants") ? readFactionsA(db, battles.map((b) => b.battle_id))
    : new Map();
  const rows = [];
  const unreadable = [];
  for (const b of battles) {
    try {
      rows.push({ battleId: b.battle_id, systemId: Number(b.system_id), objective: b.objective, mode: b.mode,
        input: parseJson(b.input_json), result: parseJson(b.result_json), createdAt: Number(b.created_at),
        settledAt: Number(b.settled_at),
        factionA: factionsA.has(b.battle_id) ? factionsA.get(b.battle_id) : null });
    } catch (err) {
      unreadable.push({ battleId: b.battle_id, detail: messageOf(err) });
    }
  }
  return { rows, unreadable, ganks: readGanks(db, tables),
    blockades: readOperations(db, tables, [BLOCKADE_TYPE]), attacks: readOperations(db, tables, ATTACK_TYPES),
    escorts: readOperations(db, tables, [ESCORT_TYPE]),
    piecemealV2: readPiecemealV2(db, tables) };
}

const pct = (v) => `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
const KEYS = [...OUTCOMES, OTHER];
const LABELS = Object.freeze({ A_WIN: "A", B_WIN: "B", DRAW: "draw", BOTH_RETREAT: "retreat", OTHER: "other" });
const sharesText = (e) => KEYS.map((k) => `${LABELS[k]}=${pct(e.shares[k])}`).join(" ");

function printBuckets(print, title, buckets) {
  print(title);
  print("  bucket    battles | shares (A_WIN B_WIN draw retreat other) | objective: battles B_WIN");
  for (const e of buckets) {
    const objectives = Object.keys(e.byObjective).sort()
      .map((o) => `${o}:${e.byObjective[o].battles}/${pct(e.byObjective[o].shares.B_WIN)}`).join(" ");
    print(`  ${e.bucket.padEnd(10)} ${String(e.battles).padStart(6)} | ${e.battles > 0 ? sharesText(e) : "-"} | `
      + `${objectives || "-"}`);
  }
}

function printPiecemealV2(print, v2, args) {
  const title = "T4v2 Piecemeal arrival per operation";
  if (!v2) {
    print(`${title}: no data (no world_operations.fleet_ids or world_event_journal)`);
    return;
  }
  print(`${title} (invasion/raid with >= 2 fleets and a battle in the target; since X1 >= ${args.since === null ? "-" : args.since}`
    + `, journal since ${v2.journalMinAt === null ? "-" : v2.journalMinAt}):`);
  print(`  base ${v2.base} operations (+${v2.single} single-fleet), piecemeal ${v2.cases} = ${pct(v2.share)}`);
  print(`  per type: ${Object.keys(v2.byType).sort().map((t) => `${t} ${v2.byType[t].cases}/${v2.byType[t].base}`)
    .join(", ") || "-"}`);
  print(`  first battle outcome: piecemeal B_WIN ${v2.firstOutcome.piecemeal.B_WIN}/${v2.cases}, not piecemeal B_WIN `
    + `${v2.firstOutcome.whole.B_WIN}/${v2.base - v2.cases}`);
  print(`  piecemeal: ${KEYS.map((k) => `${LABELS[k]}=${v2.firstOutcome.piecemeal[k]}`).join(" ")}; not piecemeal: `
    + `${KEYS.map((k) => `${LABELS[k]}=${v2.firstOutcome.whole[k]}`).join(" ")}`);
  const g = v2.gapsMs;
  const s = (ms) => (ms === null ? "-" : `${Math.round(ms / 1000)} s`);
  print(`  late fleets ${v2.lateFleets}; delay p10 ${s(g.p10)} p50 ${s(g.p50)} p90 ${s(g.p90)} `
    + `max ${s(g.max)}`);
  print(`  late within thresholds: ${Object.keys(v2.within).map((ms) => `<=${ms} ms: ${v2.within[ms]}`).join(", ")}`);
  for (const c of v2.list) {
    print(`  ${c.operationId} ${c.operationType} target ${c.targetSystemId} fleets ${c.fleets} in X1 ${c.fleetsInX1} `
      + `${c.battleId} ${c.outcome} delays ${c.gapsMs.slice(0, 4).map(s).join(" ")}`);
  }
}

function printReport(print, out, args, ctx) {
  print(`Config of this process: strategy.garrisonEstimate=${ctx.garrisonEstimate} `
    + `battle.influenceGarrison=${ctx.influenceGarrison} powerPerPoint=${ctx.powerPerPoint}`);
  print(`COMPLETED battles: ${out.totals.battles} (unreadable: ${out.totals.unreadable})`);
  for (const u of out.unreadable.slice(0, args.top)) print(`  unreadable ${u.battleId}: ${u.detail}`);
  if (out.totals.battles > 0) print(`  ${sharesText(out.totals)}`);
  print("");
  printBuckets(print, "T1 Power ratio A x 1000 / B (no garrison):", out.buckets);
  print("");
  print(`T2 Grinder (>= ${args.grindMin} x B_WIN of faction A in a system within ${args.grindWindowMs} ms): `
    + `${out.grinders.length}`);
  print("  factionA system B_WIN max_in_window window_start");
  for (const g of out.grinders.slice(0, args.top)) {
    print(`  ${g.factionId} ${g.systemId} ${g.bWins} ${g.maxInWindow} ${g.windowStart}`);
  }
  if (out.grinders.length > args.top) print(`  ... ${out.grinders.length - args.top} more (--top)`);
  print("");
  print(`T3 Battles with a side B garrison: ${out.garrison.battles}`);
  printBuckets(print, "  legacy variant (garrison = power 1:1):", out.garrison.legacy);
  printBuckets(print, "  resolver variant (garrison x powerPerPoint):", out.garrison.resolver);
  print("");
  const p = out.piecemeal;
  print(`T4 Piecemeal arrival (proxy, overstated: recheck after settlement; next battle of faction A in the system <= `
    + `${args.piecemealMs} ms): ${p.cases} of ${p.base} capture/destroy battles (${pct(p.share)})`);
  print(`  first battle outcome: ${KEYS.map((k) => `${LABELS[k]}=${p.casesByOutcome[k]}`).join(" ")}`);
  for (const c of p.list.slice(0, args.top)) {
    print(`  ${c.battleId} -> ${c.nextBattleId} faction ${c.factionId} system ${c.systemId} ${c.outcome} `
      + `gap ${c.gapMs} ms`);
  }
  if (p.list.length > args.top) print(`  ... ${p.list.length - args.top} more (--top)`);
  print("");
  printPiecemealV2(print, out.piecemealV2, args);
  print("");
  if (out.ganks === null) {
    print("T5 Ganks: no data (no world_operations table or column)");
  } else {
    print(`T5 Ganks: ${out.ganks.battles} battles in ${out.ganks.operations} gank operations`);
    if (out.ganks.battles > 0) print(`  ${sharesText(out.ganks)}`);
    printBuckets(print, "  power ratio of gank battles:", out.ganks.buckets);
  }
  print("");
  if (out.interceptions === null) {
    print("T6 Interceptions: no data (no blockade operations)");
  } else {
    const t6 = out.interceptions;
    print(`T6 Interceptions: ${t6.battles} battles in the windows of ${t6.operations} side B blockade operations`);
    if (t6.battles > 0) print(`  ${sharesText(t6)}`);
    printBuckets(print, "  power ratio of battles at outposts:", t6.buckets);
  }
  print("");
  if (out.attacks === null) {
    print("T7 Attack effectiveness: no data (no world_operations table or column)");
  } else {
    const t7 = out.attacks;
    print(`T7 Attack effectiveness (invasion/raid): ${t7.operations} operations, battle in the target ${t7.inTarget}, `
      + `battle outside the target ${t7.outside}`);
    print("  faction target operations battle_in_target battle_outside_target");
    for (const g of t7.list.slice(0, args.top)) {
      print(`  ${g.factionId} ${g.targetSystemId} ${g.operations} ${g.inTarget} ${g.outside}`);
    }
    if (t7.list.length > args.top) print(`  ... ${t7.list.length - args.top} more (--top)`);
  }
  print("");
  if (out.escorts === null || out.escorts === undefined) {
    print("T8 Miner escorts: no data (no escort operations)");
  } else {
    const t8 = out.escorts;
    const counts = (c) => KEYS.map((k) => `${LABELS[k]}=${c[k]}`).join(" ");
    print(`T8 Miner escorts: ${t8.operations} escort operations; gank battles with a side B escort `
      + `${t8.withEscort.battles}, without escort ${t8.withoutEscort.battles}`);
    print(`  with escort:    ${counts(t8.withEscort.counts)}`);
    print(`  without escort: ${counts(t8.withoutEscort.counts)}`);
  }
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
    const read = readRows(db, args, tables);
    const audited = auditOdds(read.rows, { powerTable: ctx.powerTable, powerPerPoint: ctx.powerPerPoint,
      grindMin: args.grindMin, grindWindowMs: args.grindWindowMs, piecemealMs: args.piecemealMs, ganks: read.ganks,
      blockades: read.blockades, attacks: read.attacks, escorts: read.escorts,
      operations: read.piecemealV2.operations, arrivals: read.piecemealV2.arrivals,
      operationBattles: read.piecemealV2.operationBattles, since: args.since, piecemealListMax: V2_LIST_MAX });
    if (audited.piecemealV2) audited.piecemealV2.journalMinAt = read.piecemealV2.journalMinAt;
    const unreadable = [...read.unreadable, ...audited.unreadable];
    const out = { ...audited, unreadable, totals: { ...audited.totals, unreadable: unreadable.length } };
    if (args.json) {
      print(JSON.stringify({ schemaVersion: version.version, powerPerPoint: ctx.powerPerPoint,
        garrisonEstimate: ctx.garrisonEstimate, influenceGarrison: ctx.influenceGarrison,
        options: { since: args.since, grindMin: args.grindMin, grindWindowMs: args.grindWindowMs,
          piecemealMs: args.piecemealMs }, ...out }));
    } else {
      print(`Schema: ${version.version}`);
      printReport(print, out, args, ctx);
    }
    return EXIT.OK;
  } catch (err) {
    print(`FAILED: ${messageOf(err)}`);
    return EXIT.FAILED;
  }
}

function powerPerPointOf(config) {
  const B = config.battle;
  const dps = B ? Number(B.resolverGarrisonDpsPerPoint) : 0;
  const ehp = B ? Number(B.resolverGarrisonEhpPerPoint) : 0;
  return dps > 0 && ehp > 0 ? Math.sqrt(dps * ehp) : 0;
}

function main(opts = {}) {
  const print = typeof opts.print === "function" ? opts.print : (line) => process.stdout.write(`${line}\n`);
  const env = opts.env || process.env;
  const args = parseArgs(opts.argv || []);
  if (!args.ok) {
    print(`battleOddsAudit: ${args.detail}`);
    print(USAGE);
    return EXIT.USAGE;
  }
  if (args.help) {
    print(USAGE);
    print("Read-only. AI power ratio in COMPLETED battles (VIRTUAL and LIVE): buckets, grinder, garrison B "
      + "(legacy / resolver), piecemeal arrival, ganks. --snapshot: a copy of the database (works while the server runs).");
    return EXIT.OK;
  }
  const { file, warnings } = resolveDbFile(args.db, env);
  const log = args.json ? () => {} : print;
  log(`battleOddsAudit (read-only${args.snapshot ? ", copy" : ""}): database ${file}`);
  for (const w of warnings) log(`  warning (config): ${w}`);
  if (!fs.existsSync(file)) {
    log("No database file.");
    if (args.json) print(JSON.stringify({ ok: false, reason: "NO_FILE", file }));
    return EXIT.OK;
  }
  const config = opts.config || (loadConfig({ modDir: MOD_DIR, env }).config || {});
  const ctx = { powerTable: buildPowerTable(expandStrengthGroups(STRENGTH_GROUPS, null,
    capitalPowerOverlayOf(config.strategy))),
    powerPerPoint: powerPerPointOf(config),
    garrisonEstimate: (config.strategy && config.strategy.garrisonEstimate) || "?",
    influenceGarrison: (config.battle && config.battle.influenceGarrison) || "?" };
  const driver = opts.driver || loadDriver();
  if (!driver || driver.ok === false || typeof driver.Database !== "function") {
    print(`battleOddsAudit: no better-sqlite3 driver (${(driver && (driver.detail || driver.reason)) || "?"})`);
    return EXIT.FAILED;
  }
  let snap = null;
  let target = file;
  if (args.snapshot) {
    try {
      snap = takeSnapshot(file, opts.tmpDir || os.tmpdir(), SNAPSHOT_PREFIX);
      target = snap.file;
    } catch (err) {
      print(`battleOddsAudit: copy failed: ${messageOf(err)}`);
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
    print(`battleOddsAudit: cannot open the database: ${opened.detail}`
      + `${snap ? " (the copy may be torn - retry)" : ""}`);
    return EXIT.FAILED;
  }
  const { db } = opened;
  let code;
  try {
    code = report(db, print, args, ctx);
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

module.exports = { main, parseArgs, readRows, powerPerPointOf, EXIT };

if (require.main === module) process.exitCode = main({ argv: process.argv.slice(2) });
