"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const MAX_LOCATOR_DEPTH = 6;
const JSON_COLUMN = "json";
const WHOLE_COPY_PAGES = 0x7fffffff;
const USAGE = "usage: inspectGameStoreSchema.js <file.sqlite> [--bytes] [--server <serverDir>]\n"
  + "       inspectGameStoreSchema.js --online-copy <live> <dest> [--server <serverDir>]";

function findServerDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < MAX_LOCATOR_DEPTH; i += 1) {
    const candidate = path.join(dir, "server", "package.json");
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;
const toNumber = (v) => (typeof v === "bigint" ? Number(v) : v);

function inspect(db, opts = {}) {
  const bytes = opts.bytes === true;
  const integrity = opts.integrity !== false && !bytes;
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map((t) => {
      const row = { name: t.name,
        rows: toNumber(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(t.name)}`).get().n), sql: t.sql };
      if (bytes) {
        const hasJson = db.prepare("SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ?").get(t.name, JSON_COLUMN);
        if (hasJson) {
          const s = db.prepare(`SELECT COALESCE(SUM(length(CAST(${JSON_COLUMN} AS BLOB))), 0) AS total, `
            + `COALESCE(MAX(length(CAST(${JSON_COLUMN} AS BLOB))), 0) AS max FROM ${quoteIdent(t.name)}`).get();
          row.jsonBytes = toNumber(s.total);
          row.maxRowBytes = toNumber(s.max);
        }
      }
      return row;
    });
  if (bytes) tables.sort((a, b) => (b.jsonBytes || 0) - (a.jsonBytes || 0) || a.name.localeCompare(b.name));
  return {
    journalMode: db.pragma("journal_mode", { simple: true }),
    integrity: integrity ? db.pragma("integrity_check", { simple: true }) : null,
    tables,
  };
}

async function onlineCopy(Database, live, dest) {
  const target = path.resolve(dest);
  if (fs.existsSync(target)) return { ok: false, reason: "DEST_EXISTS", detail: target };
  let db = null;
  try {
    db = new Database(path.resolve(live), { readonly: true, fileMustExist: true });
    if (typeof db.backup !== "function") return { ok: false, reason: "NO_BACKUP_API" };
    await db.backup(target, { progress: () => WHOLE_COPY_PAGES });
    return { ok: true, dest: target, bytes: fs.statSync(target).size };
  } catch (err) {
    try {
      fs.rmSync(target, { force: true });
    } catch (_err) {
    }
    return { ok: false, reason: "COPY_FAILED", detail: String((err && err.message) || err) };
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_err) {
      }
    }
  }
}

function parseArgs(argv, defaultServerDir) {
  const args = argv.slice();
  const opts = { ok: true, file: null, bytes: false, onlineCopy: null, serverDir: defaultServerDir };
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--bytes") opts.bytes = true;
    else if (a === "--server") {
      if (args.length === 0) return { ok: false, reason: "USAGE", detail: "--server needs a value" };
      opts.serverDir = path.resolve(args.shift());
    } else if (a === "--online-copy") {
      if (args.length < 2) return { ok: false, reason: "USAGE", detail: "--online-copy needs <live> <dest>" };
      opts.onlineCopy = { live: args.shift(), dest: args.shift() };
    } else if (a.startsWith("--")) return { ok: false, reason: "USAGE", detail: `unknown argument ${a}` };
    else if (opts.file === null) opts.file = a;
    else return { ok: false, reason: "USAGE", detail: `extra argument ${a}` };
  }
  if ((opts.file === null) === (opts.onlineCopy === null)) {
    return { ok: false, reason: "USAGE", detail: "give a file or --online-copy" };
  }
  if (!opts.serverDir) return { ok: false, reason: "USAGE", detail: "server dir not found, use --server" };
  return opts;
}

async function main(argv, deps = {}) {
  const print = deps.print || ((text) => console.log(text));
  const warn = deps.warn || ((text) => console.error(text));
  const opts = parseArgs(argv, deps.serverDir !== undefined ? deps.serverDir : findServerDir(__dirname));
  if (!opts.ok) {
    warn(`${USAGE}\n${opts.detail}`);
    return 2;
  }
  const Database = deps.Database || createRequire(path.join(opts.serverDir, "package.json"))("better-sqlite3");
  if (opts.onlineCopy !== null) {
    const r = await onlineCopy(Database, opts.onlineCopy.live, opts.onlineCopy.dest);
    print(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  const file = opts.file;
  const sidecars = ["-wal", "-shm"].filter((s) => fs.existsSync(path.resolve(file) + s));
  if (sidecars.length > 0) {
    warn(`warning: ${sidecars.join(", ")} present before open - live or not cleanly closed file; inspect a copy`);
  }
  const db = new Database(path.resolve(file), { readonly: true, fileMustExist: true });
  try {
    const result = { file: path.resolve(file), bytes: fs.statSync(file).size, sidecarsBeforeOpen: sidecars,
      ...inspect(db, { bytes: opts.bytes }) };
    print(JSON.stringify(result, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error((error && error.stack) || String(error));
    process.exitCode = 1;
  });
}

module.exports = { WHOLE_COPY_PAGES, inspect, onlineCopy, parseArgs, main };
