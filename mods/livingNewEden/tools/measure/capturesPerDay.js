#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseBackupName } = require("../../lib/persistence/backupRules");

const DAY_MS = 86400000;
const DAYS_MIN = 1;
const DAYS_MAX = 14;
const DAYS_DEFAULT = 2;
const ROLLBACK_FACTOR = 1.25;
const ROLLBACK_MIN_EXTRA = 2;
const USAGE = "usage: capturesPerDay.js --db <file> [--at <ms>] [--days <n>=2] [--before <B>] [--json]";

class UsageError extends Error {}

const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function countByDay(rows, opts) {
  const { at, days } = opts;
  const windows = [];
  for (let i = 0; i < days; i += 1) {
    windows.push({ index: i, from: at - (i + 1) * DAY_MS, to: at - i * DAY_MS, captures: 0 });
  }
  for (const row of rows) {
    const t = Number(row && row.capturedAt);
    if (!Number.isFinite(t) || t >= at) continue;
    const i = Math.floor((at - t - 1) / DAY_MS);
    if (i >= 0 && i < days) windows[i].captures += 1;
  }
  return { at, windows };
}

function capturesVerdict(before, after) {
  const limit = Math.max(Math.ceil(ROLLBACK_FACTOR * before), before + ROLLBACK_MIN_EXTRA);
  return { limit, rollback: after > limit };
}

function readCaptures(dbFile, opts = {}) {
  const Database = opts.Database || require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT captured_at FROM world_system_state WHERE captured_at IS NOT NULL").all()
      .map((r) => ({ capturedAt: Number(r.captured_at) }));
  } finally {
    db.close();
  }
}

function intArg(name, v, min, max) {
  if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`${name} needs a non-negative integer`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new UsageError(`${name} ${v} out of range ${min}..${max}`);
  return n;
}

function parseArgs(argv) {
  const out = { db: null, at: null, days: DAYS_DEFAULT, before: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") {
      out.db = argv[i + 1];
      i += 1;
      if (!out.db) throw new UsageError("--db needs a file");
    } else if (a === "--at") {
      out.at = intArg("--at", argv[i + 1], 1, Number.MAX_SAFE_INTEGER);
      i += 1;
    } else if (a === "--days") {
      out.days = intArg("--days", argv[i + 1], DAYS_MIN, DAYS_MAX);
      i += 1;
    } else if (a === "--before") {
      out.before = intArg("--before", argv[i + 1], 0, Number.MAX_SAFE_INTEGER);
      i += 1;
    } else if (a === "--json") {
      out.json = true;
    } else {
      throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (!out.db) throw new UsageError("--db is required");
  return out;
}

function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  let args;
  try {
    args = parseArgs(argv);
    if (!fs.existsSync(args.db)) throw new UsageError(`--db ${args.db} not found`);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`capturesPerDay: ${e.message} (${USAGE})`);
    return 1;
  }
  let at = args.at;
  if (at === null) {
    const parsed = parseBackupName(path.basename(args.db));
    at = parsed.ok ? parsed.atMs : (io.now ? io.now() : Date.now());
  }
  let rows;
  try {
    rows = readCaptures(args.db, { Database: io.Database });
  } catch (e) {
    err(`capturesPerDay: read failed - ${(e && e.message) || e}`);
    return 2;
  }
  const result = countByDay(rows, { at, days: args.days });
  const verdict = args.before === null ? null
    : { before: args.before, after: result.windows[0].captures, ...capturesVerdict(args.before, result.windows[0].captures) };
  if (args.json) {
    out(JSON.stringify({ db: args.db, ...result, verdict }));
    return 0;
  }
  for (const w of result.windows) out(`window ${w.index} [${isoOf(w.from)}, ${isoOf(w.to)}) captures=${w.captures}`);
  if (verdict) {
    out(`verdict: limit=${verdict.limit} after=${verdict.after} rollback=${verdict.rollback ? "yes" : "no"}`);
  }
  return 0;
}

module.exports = { countByDay, capturesVerdict, readCaptures, main, DAY_MS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
