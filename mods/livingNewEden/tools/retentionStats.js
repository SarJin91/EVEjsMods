"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { CLASSES } = require("../lib/retention/classes");
const { ID_PATTERN } = require("../lib/util/ids");
const { readSchemaVersion } = require("../lib/persistence/migrations");
const { EXIT, LOCKED_MESSAGE, messageOf, loadDriver, loadModConfig, resolveDbFile, openLocked, closeQuietly,
  sideFilesOf, removeCreatedSideFiles } = require("./offlineDb");

const DEFAULT_TOP = 200;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 3650;
const DAY_MS = 86400000;
const NO_CLASS = "-";
const NUMERIC_SEGMENT = /^\d+$/;
const SHAPE_NUMBER = "<n>";
const SHAPE_ID = "<id>";
const USAGE = "usage: node mods/livingNewEden/tools/retentionStats.js [--db <file>] [--top <n>] [--shape] "
  + "[--days <n>] [--min-age-ms <n>] [--now <ms>] [--json]";

const SOURCES = Object.freeze([
  Object.freeze({ table: "events", sqlTable: "world_scheduled_events",
    sql: "SELECT idempotency_key AS k, state AS s, event_type AS t, length(payload) AS b, finished_at AS f "
      + "FROM world_scheduled_events" }),
  Object.freeze({ table: "journal", sqlTable: "world_event_journal",
    sql: "SELECT idempotency_key AS k, kind AS kind, state AS s, event_type AS t, length(payload) AS b, created_at AS f "
      + "FROM world_event_journal" }),
]);

const VALUE_ARGS = Object.freeze(["--db", "--top", "--days", "--min-age-ms", "--now"]);

function parseArgs(argv) {
  const out = { db: null, top: DEFAULT_TOP, shape: false, days: DEFAULT_DAYS, minAgeMs: null, now: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--shape") out.shape = true;
    else if (arg === "--json") out.json = true;
    else if (VALUE_ARGS.includes(arg)) {
      const value = argv[i + 1];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) {
        return { ok: false, detail: `${arg} needs a value` };
      }
      if (arg === "--db") out.db = value;
      else {
        const n = Number(value);
        if (arg === "--top") {
          if (!Number.isInteger(n) || n < 1) return { ok: false, detail: "--top needs an integer >= 1" };
          out.top = n;
        } else if (arg === "--days") {
          if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) return { ok: false, detail: `--days needs an integer 1-${MAX_DAYS}` };
          out.days = n;
        } else if (arg === "--min-age-ms") {
          if (!Number.isSafeInteger(n) || n < 0) return { ok: false, detail: "--min-age-ms needs an integer >= 0" };
          out.minAgeMs = n;
        } else {
          if (!Number.isSafeInteger(n) || n < 0) return { ok: false, detail: "--now needs an integer >= 0 (ms)" };
          out.now = n;
        }
      }
      i += 1;
    } else return { ok: false, detail: `unknown argument ${arg}` };
  }
  return { ok: true, ...out };
}

function prefixOf(key) {
  const segments = String(key).split(":");
  const out = [];
  for (const seg of segments) {
    if (NUMERIC_SEGMENT.test(seg) || ID_PATTERN.test(seg)) break;
    out.push(seg);
  }
  return out.length === 0 ? "" : `${out.join(":")}:`;
}

function shapeOf(key) {
  return String(key).split(":")
    .map((seg) => (NUMERIC_SEGMENT.test(seg) ? SHAPE_NUMBER : ID_PATTERN.test(seg) ? SHAPE_ID : seg))
    .join(":");
}

function classOf(classes, table, row) {
  for (const cls of classes) {
    if (cls.table !== table) continue;
    if (!row.k.startsWith(cls.prefix) || !cls.pattern.test(row.k)) continue;
    if (table === "events" && row.t !== cls.eventType) continue;
    if (table === "journal" && !(row.kind === "APPLY" && row.s === "APPLIED")) continue;
    return cls.id;
  }
  return NO_CLASS;
}

function tablesOf(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

function refNowOf(db) {
  const existing = tablesOf(db);
  let max = 0;
  const take = (v) => {
    const n = numOrNull(v);
    if (n !== null && Number.isFinite(n) && n > max) max = n;
  };
  if (existing.has("world_event_journal")) {
    take(db.prepare("SELECT max(created_at) AS m FROM world_event_journal").get().m);
  }
  if (existing.has("world_scheduled_events")) {
    const r = db.prepare("SELECT max(created_at) AS c, max(finished_at) AS f FROM world_scheduled_events").get();
    take(r.c);
    take(r.f);
  }
  return max;
}

function collectStats(db, opts = {}) {
  const classes = opts.classes || CLASSES;
  const keyOf = opts.shape === true ? shapeOf : prefixOf;
  const countOld = Number.isFinite(opts.refNow) && Number.isFinite(opts.minAgeMs);
  const cutoff = countOld ? opts.refNow - opts.minAgeMs : 0;
  const existing = tablesOf(db);
  const groups = new Map();
  const totals = {};
  for (const source of SOURCES) {
    const total = { rows: 0, bytes: 0, classRows: 0, classBytes: 0, old: 0, classOld: 0 };
    totals[source.table] = total;
    if (!existing.has(source.sqlTable)) continue;
    for (const row of db.prepare(source.sql).iterate()) {
      const bytes = Number(row.b) || 0;
      const state = source.table === "journal" ? `${row.kind}/${row.s}` : row.s;
      const eventType = row.t || "";
      const prefix = keyOf(row.k);
      const classId = classOf(classes, source.table, row);
      const at = numOrNull(row.f);
      const old = countOld && at !== null && at < cutoff ? 1 : 0;
      const id = `${source.table}\u0000${prefix}\u0000${state}\u0000${eventType}\u0000${classId}`;
      let g = groups.get(id);
      if (!g) {
        g = { table: source.table, prefix, state, eventType, classId, rows: 0, bytes: 0, old: 0 };
        groups.set(id, g);
      }
      g.rows += 1;
      g.bytes += bytes;
      g.old += old;
      total.rows += 1;
      total.bytes += bytes;
      total.old += old;
      if (classId !== NO_CLASS) {
        total.classRows += 1;
        total.classBytes += bytes;
        total.classOld += old;
      }
    }
  }
  const sorted = [...groups.values()].sort((a, b) => (b.bytes - a.bytes) || (b.rows - a.rows)
    || (a.table < b.table ? -1 : a.table > b.table ? 1 : 0)
    || (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0)
    || (a.state < b.state ? -1 : a.state > b.state ? 1 : 0)
    || (a.eventType < b.eventType ? -1 : a.eventType > b.eventType ? 1 : 0)
    || (a.classId < b.classId ? -1 : a.classId > b.classId ? 1 : 0));
  return { groups: sorted, totals };
}

function collectGrowth(db, { refNow, days }) {
  const existing = tablesOf(db);
  const to = Number(refNow) || 0;
  const from = to - (Number(days) || DEFAULT_DAYS) * DAY_MS;
  const out = [];
  for (const source of SOURCES) {
    if (!existing.has(source.sqlTable)) continue;
    const byDay = new Map();
    const rows = db.prepare(`SELECT created_at AS c, length(payload) AS b FROM ${source.sqlTable} `
      + "WHERE created_at > ? AND created_at <= ?").iterate(from, to);
    for (const row of rows) {
      const at = new Date(Number(row.c));
      if (Number.isNaN(at.getTime())) continue;
      const day = at.toISOString().slice(0, 10);
      const d = byDay.get(day) || { table: source.table, day, rows: 0, bytes: 0 };
      d.rows += 1;
      d.bytes += Number(row.b) || 0;
      byDay.set(day, d);
    }
    out.push(...[...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)));
  }
  return out;
}

const quoteName = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;

function collectTableSizes(db) {
  let names = [];
  try {
    names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  } catch (_err) {
    return { source: "count", tables: [] };
  }
  const countOf = (name) => {
    try {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteName(name)}`).get().n);
    } catch (_err) {
      return null;
    }
  };
  try {
    const sized = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all();
    const isTable = new Set(names);
    const tables = sized.map((r) => ({ name: r.name, rows: isTable.has(r.name) ? countOf(r.name) : null,
      bytes: Number(r.bytes) || 0 }));
    tables.sort((a, b) => (b.bytes - a.bytes) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { source: "dbstat", tables };
  } catch (_err) {
    const tables = names.map((name) => ({ name, rows: countOf(name), bytes: null }));
    tables.sort((a, b) => ((b.rows || 0) - (a.rows || 0)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { source: "count", tables };
  }
}

const pad = (text, width) => String(text).padEnd(width, " ");
const padLeft = (text, width) => String(text).padStart(width, " ");

function printStats(print, report, top, pages) {
  const { stats, growth, tables } = report;
  print("");
  print(`File: page_size ${pages.pageSize}, page_count ${pages.pageCount}, freelist_count ${pages.freelist} `
    + `(free ${pages.freelist * pages.pageSize} B - compactWorld reclaims them)`);
  print(`refNow ${report.refNow} (${new Date(report.refNow).toISOString()}), minAgeMs ${report.minAgeMs}; `
    + `old = older than refNow - minAgeMs; grouping: ${report.shape ? "key shape" : "prefix"}`);
  for (const [table, t] of Object.entries(stats.totals)) {
    print(`${pad(table, 8)}: rows ${t.rows}, payload bytes ${t.bytes}, old ${t.old}; in retention classes: `
      + `rows ${t.classRows}, bytes ${t.classBytes}, old ${t.classOld}`);
  }
  print("");
  const keyWidth = report.shape ? 48 : 32;
  print(`${pad("table", 8)} | ${pad(report.shape ? "shape" : "prefix", keyWidth)} | ${pad("state", 18)} | `
    + `${pad("event_type", 26)} | ${pad("class", 24)} | ${padLeft("rows", 9)} | ${padLeft("bytes", 12)} | `
    + `${padLeft("old", 9)}`);
  print("-".repeat(8 + keyWidth + 18 + 26 + 24 + 9 + 12 + 9 + 21));
  const shown = stats.groups.slice(0, top);
  for (const g of shown) {
    print(`${pad(g.table, 8)} | ${pad(g.prefix === "" ? "(starts with a number/ID)" : g.prefix, keyWidth)} | ${pad(g.state, 18)} | `
      + `${pad(g.eventType || "-", 26)} | ${pad(g.classId, 24)} | ${padLeft(g.rows, 9)} | ${padLeft(g.bytes, 12)} | `
      + `${padLeft(g.old, 9)}`);
  }
  const rest = stats.groups.slice(top);
  if (rest.length > 0) {
    const rows = rest.reduce((a, g) => a + g.rows, 0);
    const bytes = rest.reduce((a, g) => a + g.bytes, 0);
    print(`... ${rest.length} more groups (rows ${rows}, bytes ${bytes}); full list: --top ${stats.groups.length}`);
  }
  print("");
  print(`Daily growth (UTC, last ${report.days} days before refNow, by created_at):`);
  if (growth.length === 0) print("  no rows in the window");
  for (const d of growth) print(`  ${pad(d.table, 8)} ${d.day} rows ${padLeft(d.rows, 9)} bytes ${padLeft(d.bytes, 12)}`);
  print("");
  print(`Table sizes (source: ${tables.source}${tables.source === "count" ? " - no dbstat, bytes unknown" : ""}):`);
  for (const t of tables.tables) {
    print(`  ${pad(t.name, 48)} rows ${padLeft(t.rows === null ? "-" : t.rows, 10)} `
      + `bytes ${padLeft(t.bytes === null ? "null" : t.bytes, 12)}`);
  }
}

function main(opts = {}) {
  const print = typeof opts.print === "function" ? opts.print : (line) => process.stdout.write(`${line}\n`);
  const printErr = typeof opts.printErr === "function" ? opts.printErr : (line) => process.stderr.write(`${line}\n`);
  const env = opts.env || process.env;
  const args = parseArgs(opts.argv || []);
  if (!args.ok) {
    print(`retentionStats: ${args.detail}`);
    print(USAGE);
    return EXIT.USAGE;
  }
  const note = args.json ? printErr : print;
  const { file, warnings } = resolveDbFile(args.db, env);
  note(`retentionStats (read-only): database ${file}`);
  for (const w of warnings) note(`  warning (config): ${w}`);
  let minAgeMs = args.minAgeMs;
  if (minAgeMs === null) {
    const loaded = loadModConfig(env);
    const fromConfig = loaded.config && loaded.config.retention && loaded.config.retention.minAgeMs;
    minAgeMs = Number.isFinite(fromConfig) ? fromConfig : null;
    if (minAgeMs === null) {
      print("retentionStats: no retention.minAgeMs in the configuration - pass --min-age-ms");
      return EXIT.USAGE;
    }
  }
  if (!fs.existsSync(file)) {
    note("No database file.");
    return EXIT.OK;
  }
  const driver = opts.driver || loadDriver();
  if (!driver || driver.ok === false || typeof driver.Database !== "function") {
    note(`retentionStats: no better-sqlite3 driver (${(driver && (driver.detail || driver.reason)) || "?"})`);
    return EXIT.FAILED;
  }
  const sideBefore = sideFilesOf(file);
  const opened = openLocked(driver, file, { readonly: true });
  if (!opened.ok) {
    if (opened.reason === "LOCKED") {
      note(LOCKED_MESSAGE);
      return EXIT.REFUSED;
    }
    note(`retentionStats: cannot open the database: ${opened.detail} (read-only mode; `
      + "use a copy of the database, e.g. the backup from compactWorld --apply or resetWorld)");
    return EXIT.FAILED;
  }
  const { db } = opened;
  let code;
  try {
    code = report(db, { print, note, args, minAgeMs, basename: path.basename(file) });
  } finally {
    const first = removeCreatedSideFiles(file, sideBefore);
    closeQuietly(db);
    const after = first.failed.length > 0 ? removeCreatedSideFiles(file, sideBefore, { only: first.failed })
      : { kept: [] };
    const kept = [...first.kept.filter((k) => !first.failed.includes(k.file)), ...after.kept];
    for (const k of kept) note(`  warning: file left behind ${k.file} (${k.detail})`);
  }
  return code;
}

function report(db, ctx) {
  const { print, note, args, minAgeMs, basename } = ctx;
  try {
    const version = readSchemaVersion(db);
    if (!version.ok || version.version === 0) {
      note(`REFUSED: this is not a Living New Eden database (${version.reason || "EMPTY"}: ${version.detail || "-"})`);
      return EXIT.REFUSED;
    }
    const refNow = args.now !== null ? args.now : refNowOf(db);
    const stats = collectStats(db, { shape: args.shape, refNow, minAgeMs });
    const growth = collectGrowth(db, { refNow, days: args.days });
    const tables = collectTableSizes(db);
    if (args.json) {
      print(JSON.stringify({ db: basename, refNow, minAgeMs, shape: args.shape, totals: stats.totals,
        groups: stats.groups.slice(0, args.top), growth, tables }));
      return EXIT.OK;
    }
    const pages = {
      pageSize: Number(db.pragma("page_size", { simple: true })),
      pageCount: Number(db.pragma("page_count", { simple: true })),
      freelist: Number(db.pragma("freelist_count", { simple: true })),
    };
    print(`Schema: ${version.version}`);
    printStats(print, { stats, growth, tables, refNow, minAgeMs, shape: args.shape, days: args.days }, args.top, pages);
    return EXIT.OK;
  } catch (err) {
    note(`FAILED: ${messageOf(err)}`);
    return EXIT.FAILED;
  }
}

module.exports = { main, parseArgs, prefixOf, shapeOf, classOf, refNowOf, collectStats, collectGrowth,
  collectTableSizes, NO_CLASS, DEFAULT_DAYS, EXIT };

if (require.main === module) process.exitCode = main({ argv: process.argv.slice(2) });
