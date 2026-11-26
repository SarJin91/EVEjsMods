"use strict";

const path = require("node:path");
const { createRequire } = require("node:module");

const DRIVER_PACKAGE = "better-sqlite3";

const BACKUP_HANDLE_UNAVAILABLE = "BACKUP_HANDLE_UNAVAILABLE";

function messageOf(err) {
  return String((err && err.message) || err);
}

function backupHandleOpener(cppdb) {
  return (db, destPath, isNewFile) => {
    try {
      const native = db ? db[cppdb] : undefined;
      if (!native || typeof native.backup !== "function") {
        return { ok: false, reason: BACKUP_HANDLE_UNAVAILABLE, detail: "no native backup on the connection" };
      }
      const raw = native.backup(db, "main", destPath, isNewFile === true);
      if (!raw || typeof raw.transfer !== "function" || typeof raw.close !== "function") {
        return { ok: false, reason: BACKUP_HANDLE_UNAVAILABLE, detail: "native backup has no transfer/close" };
      }
      return { ok: true, handle: { transfer: (pages) => raw.transfer(pages), close: () => raw.close() } };
    } catch (err) {
      return { ok: false, reason: BACKUP_HANDLE_UNAVAILABLE, detail: messageOf(err) };
    }
  };
}

function resolveSqliteDriver(serverSrc, deps = { createRequire }) {
  if (typeof serverSrc !== "string" || serverSrc === "") {
    return { ok: false, reason: "SQLITE_DRIVER_UNAVAILABLE", detail: "server_src_invalid" };
  }
  try {
    const load = deps.createRequire(path.join(path.dirname(serverSrc), "package.json"));
    const Database = load(DRIVER_PACKAGE);
    if (typeof Database !== "function") {
      return { ok: false, reason: "SQLITE_DRIVER_UNAVAILABLE", detail: "export is not a constructor" };
    }
    let version = "unknown";
    try {
      const pkg = load(`${DRIVER_PACKAGE}/package.json`);
      if (pkg && typeof pkg.version === "string") version = pkg.version;
    } catch (_err) {
    }
    let openBackupHandle = null;
    let backupHandleReason;
    try {
      const util = load(`${DRIVER_PACKAGE}/lib/util`);
      if (util && typeof util.cppdb === "symbol") openBackupHandle = backupHandleOpener(util.cppdb);
      else backupHandleReason = "cppdb is not a symbol";
    } catch (err) {
      backupHandleReason = messageOf(err);
    }
    return { ok: true, Database, version, openBackupHandle,
      ...(backupHandleReason === undefined ? {} : { backupHandleReason }) };
  } catch (err) {
    return { ok: false, reason: "SQLITE_DRIVER_UNAVAILABLE", detail: String((err && err.message) || err) };
  }
}

module.exports = { DRIVER_PACKAGE, BACKUP_HANDLE_UNAVAILABLE, resolveSqliteDriver };
