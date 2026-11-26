"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { loadConfig, resolveDataDir, DEFAULT_DB_FILE } = require("../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../lib/adapter/locator");
const { resolveSqliteDriver } = require("../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION, readSchemaVersion, runMigrations } = require("../lib/persistence/migrations");
const { planReset, applyReset } = require("../lib/persistence/worldReset");

const MOD_DIR = path.resolve(__dirname, "..");
const EXIT = Object.freeze({ OK: 0, USAGE: 1, REFUSED: 2, FAILED: 3 });
const BACKUP_INFIX = ".pre-reset-";
const USAGE = "usage: node mods/livingNewEden/tools/resetWorld.js [--dry-run | --apply] [--db <file>] [--no-vacuum] "
  + "[--backup-dir <dir>]";

function parseArgs(argv) {
  const out = { dryRun: false, apply: false, db: null, vacuum: true, backupDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--no-vacuum") out.vacuum = false;
    else if (arg === "--db" || arg === "--backup-dir") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) {
        return { ok: false, detail: `${arg} needs a value` };
      }
      if (arg === "--db") out.db = value;
      else out.backupDir = value;
      i += 1;
    } else return { ok: false, detail: `unknown argument ${arg}` };
  }
  if (out.dryRun && out.apply) return { ok: false, detail: "--dry-run and --apply exclude each other" };
  return { ok: true, ...out };
}

const pad2 = (n) => String(n).padStart(2, "0");

function stampOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-`
    + `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

function backupNameOf(dbFile, ms) {
  return `${path.basename(dbFile)}${BACKUP_INFIX}${stampOf(ms)}Z`;
}

function isBusy(err) {
  return Boolean(err && typeof err.code === "string" && (err.code.startsWith("SQLITE_BUSY")
    || err.code.startsWith("SQLITE_LOCKED")));
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, reason: "SERVER_SRC_NOT_FOUND", detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function resolveDbFile(args, env) {
  if (args.db) return { file: path.resolve(args.db), warnings: [] };
  const loaded = loadConfig({ modDir: MOD_DIR, env });
  const config = loaded.config || {};
  const dataDir = typeof config.dataDir === "string" && config.dataDir !== "" ? config.dataDir
    : resolveDataDir(env, MOD_DIR);
  const dbFile = config.persistence && typeof config.persistence.dbFile === "string" && config.persistence.dbFile
    ? config.persistence.dbFile : DEFAULT_DB_FILE;
  return { file: path.join(dataDir, dbFile), warnings: [...(loaded.errors || [])] };
}

const pad = (text, width) => String(text).padEnd(width, " ");
const padLeft = (text, width) => String(text).padStart(width, " ");

function printPlan(print, plan) {
  print("");
  print(`${pad("table", 30)} | ${pad("action", 17)} | ${padLeft("rows", 9)} | ${padLeft("to delete", 12)}`
    + ` | ${padLeft("-> CLEANING", 11)}`);
  print("-".repeat(30 + 17 + 9 + 12 + 11 + 12));
  for (const t of plan.tables) {
    print(`${pad(t.name, 30)} | ${pad(t.action, 17)} | ${padLeft(t.rows, 9)} | ${padLeft(t.toDelete, 12)}`
      + ` | ${padLeft(t.toTransition, 11)}`);
  }
  print("");
  print(`Faction identities (kept unchanged): ${plan.identities.total}`);
  for (const [key, n] of Object.entries(plan.identities.byKindState)) print(`  ${pad(key, 24)} ${padLeft(n, 6)}`);
  const g = plan.game;
  print("");
  print("In game after startup (cleaned up by the existing mod paths):");
  print(`  event sites -> CLEANING: ${g.sitesToClean} (already CLEANING/CLEANED: ${g.sitesAlreadyCleaning}) - the`
    + " 'sites' pump removes the dungeon instances; with modules.sites disabled they wait until it is enabled; until then"
    + " they count against the sites limits");
  print(`  trade offers with a contract (ISSUING/OPEN): ${g.tradeOffersWithContract} in ${g.tradeOfferIssuerCorps}`
    + " corporations - the startup orphan scan removes the contracts, but only for corporations of NPC stations ONLINE after the new"
    + " seed (check the [tradeOrphans] log)");
  print(`  ACCEPTED/INTAKE offers (items stay in the NPC delivery hangar, R3): ${g.tradeOffersAcceptedOrIntake}`);
  print(`  projected sov claims (GAIN/TRANSFER/REINFORCE): ${g.sovClaimsLogged} - sov syncAll after the world seed`
    + " removes or moves them (modules.sovProjection); systems cut by the trim only after the next restart");
  print(`  player standings kept: journal ${g.standingsJournalKept}, queue ${g.standingsEventsKept}`);
  print("  telemetry (<dataDir>/telemetry) stays: metric history from before the reset");
}

function main(opts = {}) {
  const print = typeof opts.print === "function" ? opts.print : (line) => process.stdout.write(`${line}\n`);
  const env = opts.env || process.env;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const args = parseArgs(opts.argv || []);
  if (!args.ok) {
    print(`resetWorld: ${args.detail}`);
    print(USAGE);
    return EXIT.USAGE;
  }
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  const { file, warnings } = resolveDbFile(args, env);
  print(`resetWorld (${mode}): database ${file}`);
  for (const w of warnings) print(`  warning (config): ${w}`);
  if (!fs.existsSync(file)) {
    print("No database file - nothing to reset.");
    return EXIT.OK;
  }
  const driver = opts.driver || loadDriver();
  if (!driver || driver.ok === false || typeof driver.Database !== "function") {
    print(`resetWorld: no better-sqlite3 driver (${(driver && (driver.detail || driver.reason)) || "?"})`);
    return EXIT.FAILED;
  }

  let db;
  try {
    db = new driver.Database(file, { fileMustExist: true });
  } catch (err) {
    print(`resetWorld: cannot open the database: ${messageOf(err)}`);
    return isBusy(err) ? EXIT.REFUSED : EXIT.FAILED;
  }
  try {
    try {
      db.pragma("busy_timeout = 0");
      db.pragma("locking_mode = EXCLUSIVE");
      db.pragma("foreign_keys = ON");
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
    } catch (err) {
      if (isBusy(err)) {
        print("REFUSED: the database is locked - the server is running. Stop the server (docker compose stop server) and retry.");
        return EXIT.REFUSED;
      }
      print(`resetWorld: open error: ${messageOf(err)}`);
      return EXIT.FAILED;
    }

    const version = readSchemaVersion(db);
    if (!version.ok) {
      print(`REFUSED: this is not a Living New Eden database (${version.reason}: ${version.detail})`);
      return EXIT.REFUSED;
    }
    if (version.version > LATEST_SCHEMA_VERSION) {
      print(`REFUSED: SCHEMA_TOO_NEW - schema_version ${version.version} > ${LATEST_SCHEMA_VERSION} known to this `
        + "tool (use the tool from the same mod version as the server)");
      return EXIT.REFUSED;
    }
    print(`Schema: ${version.version} (latest ${LATEST_SCHEMA_VERSION})`);
    if (version.version < LATEST_SCHEMA_VERSION) {
      print(`  info: --apply runs migrations ${version.version} -> ${LATEST_SCHEMA_VERSION} first`);
    }

    const prePlan = planReset(db);
    if (!prePlan.ok) {
      print(`REFUSED: ${prePlan.reason} - ${prePlan.detail}`);
      return EXIT.REFUSED;
    }
    if (!args.apply) {
      printPlan(print, prePlan);
      print("");
      print("DRY-RUN: nothing changed. Next step: the same command with --apply (server stopped).");
      return EXIT.OK;
    }

    const backupDir = args.backupDir ? path.resolve(args.backupDir) : path.dirname(file);
    const backup = path.join(backupDir, backupNameOf(file, now()));
    if (fs.existsSync(backup)) {
      print(`REFUSED: backup ${backup} already exists (backups are never overwritten). Remove it or pass --backup-dir.`);
      return EXIT.REFUSED;
    }
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    } catch (err) {
      print(`FAILED: backup not created: ${messageOf(err)} - database unchanged`);
      return EXIT.FAILED;
    }
    const checked = quickCheck(driver, backup);
    if (checked !== "ok") {
      print(`FAILED: backup ${backup} failed quick_check (${checked}) - reset aborted, database unchanged. `
        + "Remove this file or pass --backup-dir.");
      return EXIT.FAILED;
    }
    print(`Backup: ${backup} (quick_check ok)`);

    if (version.version < LATEST_SCHEMA_VERSION) {
      const migrated = runMigrations(db, MIGRATIONS, { randomSeed: () => {
        throw new Error("world_seed must already exist");
      } });
      if (!migrated.ok) {
        print(`FAILED: migrations: ${migrated.reason} ${migrated.detail || ""} - database unchanged`);
        return migrated.reason === "DB_LOCKED" ? EXIT.REFUSED : EXIT.FAILED;
      }
      print(`Migrations: ${migrated.from} -> ${migrated.to}`);
    }

    const plan = planReset(db);
    if (!plan.ok) {
      print(`REFUSED: ${plan.reason} - ${plan.detail}`);
      return EXIT.REFUSED;
    }
    const reset = applyReset(db, plan, { now: now() });
    if (!reset.ok) {
      print(`FAILED: ${reset.reason} - ${reset.detail}. Rollback: database unchanged, the backup stays.`);
      return EXIT.FAILED;
    }

    try {
      if (args.vacuum) db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      print(`  warning: VACUUM/checkpoint failed (${messageOf(err)}) - the reset is saved`);
    }

    printPlan(print, plan);
    const total = Object.values(reset.deleted).reduce((a, b) => a + b, 0);
    print("");
    print(`RESET OK: deleted ${total} rows, event sites -> CLEANING: ${reset.transitioned}.`);
    print("Next step: docker compose up -d server (locally: StartServer.bat). The world seeds again from scratch.");
    return EXIT.OK;
  } catch (err) {
    print(`FAILED: ${messageOf(err)}`);
    return isBusy(err) ? EXIT.REFUSED : EXIT.FAILED;
  } finally {
    try {
      db.close();
    } catch (_err) {
    }
  }
}

function quickCheck(driver, file) {
  let copy;
  try {
    copy = new driver.Database(file, { fileMustExist: true });
    copy.pragma("locking_mode = EXCLUSIVE");
    return String(copy.pragma("quick_check", { simple: true }));
  } catch (err) {
    return messageOf(err);
  } finally {
    try {
      if (copy) copy.close();
    } catch (_err) {
    }
  }
}

module.exports = { main, parseArgs, backupNameOf, stampOf, EXIT };

if (require.main === module) process.exitCode = main({ argv: process.argv.slice(2) });
