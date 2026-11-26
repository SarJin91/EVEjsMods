"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { loadConfig, resolveDataDir, DEFAULT_DB_FILE } = require("../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../lib/adapter/locator");
const { resolveSqliteDriver } = require("../lib/adapter/sqliteDriver");

const MOD_DIR = path.resolve(__dirname, "..");
const EXIT = Object.freeze({ OK: 0, USAGE: 1, REFUSED: 2, FAILED: 3 });

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

function loadModConfig(env) {
  const loaded = loadConfig({ modDir: MOD_DIR, env });
  const config = loaded.config || {};
  const dataDir = typeof config.dataDir === "string" && config.dataDir !== "" ? config.dataDir
    : resolveDataDir(env, MOD_DIR);
  return { config, dataDir, warnings: [...(loaded.errors || [])] };
}

function resolveDbFile(dbArg, env) {
  if (dbArg) return { file: path.resolve(dbArg), warnings: [], dataDir: null };
  const { config, dataDir, warnings } = loadModConfig(env);
  const dbFile = config.persistence && typeof config.persistence.dbFile === "string" && config.persistence.dbFile
    ? config.persistence.dbFile : DEFAULT_DB_FILE;
  return { file: path.join(dataDir, dbFile), warnings, dataDir };
}

function openLocked(driver, file, opts = {}) {
  const readonly = opts.readonly === true;
  let db;
  try {
    db = new driver.Database(file, { fileMustExist: true, readonly });
  } catch (err) {
    return { ok: false, reason: isBusy(err) ? "LOCKED" : "OPEN_FAILED", detail: messageOf(err) };
  }
  try {
    db.pragma("busy_timeout = 0");
    if (readonly) {
      db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    } else {
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
    }
    return { ok: true, db };
  } catch (err) {
    closeQuietly(db);
    return { ok: false, reason: isBusy(err) ? "LOCKED" : "OPEN_FAILED", detail: messageOf(err) };
  }
}

function closeQuietly(db) {
  try {
    if (db) db.close();
  } catch (_err) {
  }
}

function sideFilesOf(file) {
  return { wal: fs.existsSync(`${file}-wal`), shm: fs.existsSync(`${file}-shm`) };
}

function removeCreatedSideFiles(file, before, opts = {}) {
  const removed = [];
  const kept = [];
  const failed = [];
  const only = Array.isArray(opts.only) ? new Set(opts.only) : null;
  const candidates = [];
  if (before && before.wal === false) candidates.push({ path: `${file}-wal`, mustBeEmpty: true });
  if (before && before.shm === false) candidates.push({ path: `${file}-shm`, mustBeEmpty: false });
  for (const c of candidates) {
    if (only && !only.has(c.path)) continue;
    let size;
    try {
      size = fs.statSync(c.path).size;
    } catch (_err) {
      continue;
    }
    if (c.mustBeEmpty && size !== 0) {
      kept.push({ file: c.path, detail: `has ${size} B (WAL frames) - not removed` });
      continue;
    }
    try {
      fs.unlinkSync(c.path);
      removed.push(c.path);
    } catch (err) {
      kept.push({ file: c.path, detail: messageOf(err) });
      failed.push(c.path);
    }
  }
  return { removed, kept, failed };
}

function sizeOnDisk(file) {
  let total = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      total += fs.statSync(f).size;
    } catch (_err) {
    }
  }
  return total;
}

function takeSnapshot(file, tmpRoot, prefix) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, prefix));
  const copy = path.join(dir, path.basename(file));
  fs.copyFileSync(file, copy);
  if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
  return { dir, file: copy };
}

const LOCKED_MESSAGE = "REFUSED: the database is locked - the server is running or another process holds the lock. "
  + "Stop the server (docker compose stop server) or use a copy of the database and retry.";

module.exports = { EXIT, MOD_DIR, LOCKED_MESSAGE, isBusy, messageOf, loadDriver, loadModConfig, resolveDbFile, openLocked,
  closeQuietly, sizeOnDisk, sideFilesOf, removeCreatedSideFiles, takeSnapshot };
