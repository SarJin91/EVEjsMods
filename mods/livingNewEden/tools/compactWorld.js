"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { readSchemaVersion } = require("../lib/persistence/migrations");
const { EXIT, LOCKED_MESSAGE, messageOf, isBusy, loadDriver, resolveDbFile, openLocked, closeQuietly, sizeOnDisk }
  = require("./offlineDb");
const { KIND, PRUNABLE_KINDS, parseBackupName, canonicalDir, dirKey, listBackups, planPrune, planSpace }
  = require("./offlineBackups");

const BACKUP_INFIX = ".pre-compact-";
const DEFAULT_KEEP = 1;
const MAX_KEEP = 100;
const SPACE_MARGIN = 1.1;
const ONLINE_BACKUP_SUBDIR = "backups";
const USAGE = "usage: node mods/livingNewEden/tools/compactWorld.js [--dry-run | --apply] [--db <file>] "
  + "[--backup-dir <dir>] [--skip-space-check] | --list-backups | --prune-backups [--keep <n>] [--apply]";

function parseArgs(argv) {
  const out = { dryRun: false, apply: false, db: null, backupDir: null, skipSpaceCheck: false, listBackups: false,
    pruneBackups: false, keep: DEFAULT_KEEP, keepGiven: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--skip-space-check") out.skipSpaceCheck = true;
    else if (arg === "--list-backups") out.listBackups = true;
    else if (arg === "--prune-backups") out.pruneBackups = true;
    else if (arg === "--db" || arg === "--backup-dir" || arg === "--keep") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) {
        return { ok: false, detail: `${arg} needs a value` };
      }
      if (arg === "--db") out.db = value;
      else if (arg === "--backup-dir") out.backupDir = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > MAX_KEEP) return { ok: false, detail: `--keep needs an integer 0-${MAX_KEEP}` };
        out.keep = n;
        out.keepGiven = true;
      }
      i += 1;
    } else return { ok: false, detail: `unknown argument ${arg}` };
  }
  if (out.dryRun && out.apply) return { ok: false, detail: "--dry-run and --apply exclude each other" };
  if (out.listBackups && out.pruneBackups) return { ok: false, detail: "--list-backups and --prune-backups exclude each other" };
  if (out.listBackups && (out.apply || out.dryRun)) return { ok: false, detail: "--list-backups only lists (no --apply / --dry-run)" };
  if ((out.listBackups || out.pruneBackups) && out.skipSpaceCheck) {
    return { ok: false, detail: "--skip-space-check belongs to the compaction, not to the backup options" };
  }
  if (out.keepGiven && !out.pruneBackups) return { ok: false, detail: "--keep needs --prune-backups" };
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

function pagesOf(db) {
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const pageCount = Number(db.pragma("page_count", { simple: true }));
  const freelist = Number(db.pragma("freelist_count", { simple: true }));
  return { pageSize, pageCount, freelist, freeBytes: pageSize * freelist };
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
    closeQuietly(copy);
  }
}

function existingDirOf(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      if (fs.statSync(cur).isDirectory()) return cur;
    } catch (_err) {
    }
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

function walBytesOf(file) {
  try {
    return fs.statSync(`${file}-wal`).size;
  } catch (_err) {
    return 0;
  }
}

function checkSpace(file, backupDir, pages, statfs) {
  try {
    const dbDir = path.dirname(file);
    const bDir = existingDirOf(backupDir);
    const dbStat = statfs(dbDir);
    const bStat = statfs(bDir);
    const sameDevice = fs.statSync(dbDir).dev === fs.statSync(bDir).dev;
    const live = Math.max(0, pages.pageCount - pages.freelist) * pages.pageSize;
    const plan = planSpace({ live, walBytes: walBytesOf(file), dbFree: Number(dbStat.bavail) * Number(dbStat.bsize),
      backupFree: Number(bStat.bavail) * Number(bStat.bsize), sameDevice, margin: SPACE_MARGIN });
    return { ok: true, plan: { ...plan, dbDir, backupDir: bDir, sameDevice, live } };
  } catch (err) {
    return { ok: false, detail: messageOf(err) };
  }
}

function printSpace(print, space) {
  const p = space.plan;
  if (p.sameDevice) {
    print(`Space: need ${p.needDb} B in ${p.dbDir} (backup + VACUUM, same disk), free ${p.freeDb} B`);
  } else {
    print(`Space: need ${p.needDb} B in ${p.dbDir} (VACUUM), free ${p.freeDb} B; `
      + `need ${p.needBackup} B in ${p.backupDir} (backup), free ${p.freeBackup} B`);
  }
}

function backupDirsOf(args, file, dataDir) {
  const dbDir = path.dirname(file);
  const online = path.join(dataDir || dbDir, ONLINE_BACKUP_SUBDIR);
  const dirs = [{ dir: dbDir, prunable: true }];
  if (args.backupDir) dirs.push({ dir: args.backupDir, prunable: true });
  dirs.push({ dir: online, prunable: false });
  const seen = new Map();
  for (const d of dirs) {
    const dir = canonicalDir(d.dir);
    const key = dirKey(dir);
    const prev = seen.get(key);
    if (prev) prev.prunable = prev.prunable || d.prunable;
    else seen.set(key, { dir, prunable: d.prunable });
  }
  return [...seen.values()];
}

function recheckBeforeUnlink(e, basename, lstat) {
  const parsed = parseBackupName(path.basename(e.file), basename);
  if (!parsed || parsed.kind !== e.kind || !PRUNABLE_KINDS.includes(parsed.kind)) return "the name is not a backup";
  let st;
  try {
    st = lstat(e.file);
  } catch (err) {
    return messageOf(err);
  }
  return st && st.isFile() ? null : "not a regular file";
}

function printList(print, list) {
  if (list.length === 0) {
    print("No backups.");
    return;
  }
  for (const e of list) {
    print(`  ${e.kind.padEnd(11, " ")} ${new Date(e.stampMs).toISOString()} ${String(e.bytes).padStart(14, " ")} B  ${e.file}`);
  }
}

function sumBytes(list) {
  return list.reduce((a, e) => a + e.bytes, 0);
}

function runBackups(args, file, dataDir, print, unlink, lstat) {
  const basename = path.basename(file);
  const dirs = backupDirsOf(args, file, dataDir);
  const list = listBackups(dirs.map((d) => d.dir), basename);
  print(`Backup directories: ${dirs.map((d) => `${d.dir}${d.prunable ? "" : " (list only)"}`).join(", ")}`);
  if (args.listBackups) {
    printList(print, list);
    const offline = list.filter((e) => PRUNABLE_KINDS.includes(e.kind));
    const online = list.filter((e) => e.kind === KIND.ONLINE);
    print(`Total: ${list.length} backups, ${sumBytes(list)} B (pre-compact/pre-reset ${offline.length}: `
      + `${sumBytes(offline)} B; online ${online.length}: ${sumBytes(online)} B - these are rotated by ops-alerts-backups)`);
    return EXIT.OK;
  }
  const prunableDirs = new Set(dirs.filter((d) => d.prunable).map((d) => dirKey(d.dir)));
  const inPrunableDir = (e) => prunableDirs.has(dirKey(path.dirname(e.file)));
  const candidates = list.filter(inPrunableDir);
  const plan = planPrune(candidates, args.keep);
  print(`Plan (--keep ${args.keep} per kind, pre-compact/pre-reset only):`);
  print(`Kept (${plan.keep.length}):`);
  printList(print, plan.keep);
  print(`To remove (${plan.remove.length}, ${sumBytes(plan.remove)} B):`);
  printList(print, plan.remove);
  if (!args.apply) {
    print("");
    print("DRY-RUN: nothing removed. Next step: the same command with --apply.");
    return EXIT.OK;
  }
  let failed = 0;
  let removed = 0;
  let freed = 0;
  for (const e of plan.remove) {
    if (!PRUNABLE_KINDS.includes(e.kind) || !inPrunableDir(e)) continue;
    const changed = recheckBeforeUnlink(e, basename, lstat);
    if (changed !== null) {
      failed += 1;
      print(`  warning: not removed ${e.file} (changed before removal: ${changed})`);
      continue;
    }
    try {
      unlink(e.file);
      removed += 1;
      freed += e.bytes;
    } catch (err) {
      failed += 1;
      print(`  warning: not removed ${e.file} (${messageOf(err)})`);
    }
  }
  print(`PRUNE: removed ${removed} backups (${freed} B)${failed > 0 ? `, failed ${failed}` : ""}.`);
  return failed > 0 ? EXIT.FAILED : EXIT.OK;
}

function main(opts = {}) {
  const print = typeof opts.print === "function" ? opts.print : (line) => process.stdout.write(`${line}\n`);
  const env = opts.env || process.env;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const statfs = typeof opts.statfs === "function" ? opts.statfs : fs.statfsSync;
  const unlink = typeof opts.unlink === "function" ? opts.unlink : fs.unlinkSync;
  const lstat = typeof opts.lstat === "function" ? opts.lstat : fs.lstatSync;
  const args = parseArgs(opts.argv || []);
  if (!args.ok) {
    print(`compactWorld: ${args.detail}`);
    print(USAGE);
    return EXIT.USAGE;
  }
  const backupMode = args.listBackups || args.pruneBackups;
  const mode = args.listBackups ? "LIST-BACKUPS" : `${args.pruneBackups ? "PRUNE-BACKUPS " : ""}`
    + `${args.apply ? "APPLY" : "DRY-RUN"}`;
  const { file, warnings, dataDir } = resolveDbFile(args.db, env);
  print(`compactWorld (${mode}): database ${file}`);
  for (const w of warnings) print(`  warning (config): ${w}`);
  if (backupMode) return runBackups(args, file, dataDir, print, unlink, lstat);
  if (!fs.existsSync(file)) {
    print("No database file - nothing to compact.");
    return EXIT.OK;
  }
  const driver = opts.driver || loadDriver();
  if (!driver || driver.ok === false || typeof driver.Database !== "function") {
    print(`compactWorld: no better-sqlite3 driver (${(driver && (driver.detail || driver.reason)) || "?"})`);
    return EXIT.FAILED;
  }
  const opened = openLocked(driver, file);
  if (!opened.ok) {
    if (opened.reason === "LOCKED") {
      print(LOCKED_MESSAGE);
      return EXIT.REFUSED;
    }
    print(`compactWorld: cannot open the database: ${opened.detail}`);
    return EXIT.FAILED;
  }
  const { db } = opened;
  try {
    const version = readSchemaVersion(db);
    if (!version.ok || version.version === 0) {
      print(`REFUSED: this is not a Living New Eden database (${version.reason || "EMPTY"}: ${version.detail || "-"})`);
      return EXIT.REFUSED;
    }
    const sizeBefore = sizeOnDisk(file);
    const before = pagesOf(db);
    print(`Schema: ${version.version}`);
    print(`Size (file + -wal): ${sizeBefore} B; page_size ${before.pageSize}, page_count ${before.pageCount}, `
      + `free pages ${before.freelist} (${before.freeBytes} B)`);
    const backupDir = args.backupDir ? path.resolve(args.backupDir) : path.dirname(file);

    if (args.skipSpaceCheck) {
      print("Space: check skipped (--skip-space-check).");
    } else {
      const space = checkSpace(file, backupDir, before, statfs);
      if (!space.ok) {
        print(`${args.apply ? "REFUSED" : "Warning"}: cannot check free space (${space.detail}); `
          + "skip the check with --skip-space-check.");
        if (args.apply) return EXIT.REFUSED;
      } else {
        printSpace(print, space);
        if (!space.plan.ok && args.apply) {
          const p = space.plan;
          const short = p.needDb > p.freeDb ? { need: p.needDb, dir: p.dbDir, free: p.freeDb }
            : { need: p.needBackup, dir: p.backupDir, free: p.freeBackup };
          print(`REFUSED: not enough space (need ${short.need} B in ${short.dir}, free ${short.free} B). `
            + "Database unchanged.");
          return EXIT.REFUSED;
        }
        if (!space.plan.ok) print("Warning: not enough space - --apply will refuse (code 2).");
      }
    }
    if (!args.apply) {
      print("");
      print("DRY-RUN: nothing changed. Next step: the same command with --apply (server stopped).");
      return EXIT.OK;
    }

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
      print(`FAILED: backup ${backup} failed quick_check (${checked}) - VACUUM aborted, database unchanged. `
        + "Remove this file or pass --backup-dir.");
      return EXIT.FAILED;
    }
    print(`Backup: ${backup} (quick_check ok)`);

    try {
      db.exec("VACUUM");
    } catch (err) {
      print(`FAILED: VACUUM failed (${messageOf(err)}) - database unchanged, the backup stays.`);
      return isBusy(err) ? EXIT.REFUSED : EXIT.FAILED;
    }
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      print(`FAILED: VACUUM committed, checkpoint failed (${messageOf(err)}) - the compacted database is in the `
        + "-wal file (data unchanged, the database file not smaller yet); the next checkpoint (server) moves it into the database file. "
        + "The backup stays.");
      return isBusy(err) ? EXIT.REFUSED : EXIT.FAILED;
    }
    const after = pagesOf(db);
    const sizeAfter = sizeOnDisk(file);
    print(`COMPACT OK: size ${sizeBefore} B -> ${sizeAfter} B (reclaimed ${sizeBefore - sizeAfter} B); `
      + `page_count ${before.pageCount} -> ${after.pageCount}, free pages ${after.freelist}.`);
    print("Next step: docker compose up -d server (locally: StartServer.bat). Old backups: --prune-backups.");
    return EXIT.OK;
  } catch (err) {
    print(`FAILED: ${messageOf(err)}`);
    return isBusy(err) ? EXIT.REFUSED : EXIT.FAILED;
  } finally {
    closeQuietly(db);
  }
}

module.exports = { main, parseArgs, backupNameOf, stampOf, DEFAULT_KEEP, SPACE_MARGIN, EXIT };

if (require.main === module) process.exitCode = main({ argv: process.argv.slice(2) });
