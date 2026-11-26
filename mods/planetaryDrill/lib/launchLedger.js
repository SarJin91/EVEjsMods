"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LEDGER_VERSION = 1;
const LEDGER_FILE_NAME = "launch-ledger.json";

function emptyLedger() {
  return { v: LEDGER_VERSION, pending: {}, drills: {} };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validLedger(value) {
  if (!isPlainObject(value) || value.v !== LEDGER_VERSION) return null;
  if (!isPlainObject(value.pending) || !isPlainObject(value.drills)) return null;
  return { v: LEDGER_VERSION, pending: { ...value.pending }, drills: { ...value.drills } };
}

function ledgerFileOf(dataRoot) {
  return path.join(String(dataRoot), "mods", "planetaryDrill", LEDGER_FILE_NAME);
}

function readLedger(file, { logErrorFn = () => {} } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") logErrorFn(`launch ledger ${file} unreadable (${error.code || error.message}) - using an empty ledger`);
    return emptyLedger();
  }
  let ledger = null;
  try {
    ledger = validLedger(JSON.parse(text));
  } catch (_error) {
    ledger = null;
  }
  if (!ledger) {
    logErrorFn(`launch ledger ${file} is not a version ${LEDGER_VERSION} ledger - using an empty ledger, the next write keeps the file as .bad-<ms>`);
    return emptyLedger();
  }
  return ledger;
}

function setAsideBadFile(file, nowMs) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return;
  }
  try {
    if (validLedger(JSON.parse(text))) return;
  } catch (_error) {
  }
  fs.renameSync(file, `${file}.bad-${nowMs}`);
}

function writeLedger(file, ledger, { nowMs = Date.now() } = {}) {
  const tmp = `${file}.tmp-${process.pid}`;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    setAsideBadFile(file, nowMs);
    const body = JSON.stringify({
      v: LEDGER_VERSION,
      pending: (ledger && ledger.pending) || {},
      drills: (ledger && ledger.drills) || {},
    }, null, 2);
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, `${body}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_error) {
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_error) {
    }
    return { ok: false, reason: "WRITE_FAILED", error };
  }
}

function withEntry(ledger, field, id, entry) {
  const base = validLedger(ledger) || emptyLedger();
  return { ...base, [field]: { ...base[field], [String(Number(id))]: { ...entry } } };
}

function withoutEntry(ledger, field, id) {
  const base = validLedger(ledger) || emptyLedger();
  const next = { ...base[field] };
  delete next[String(Number(id))];
  return { ...base, [field]: next };
}

const withPending = (ledger, sourceItemID, entry) => withEntry(ledger, "pending", sourceItemID, entry);
const withoutPending = (ledger, sourceItemID) => withoutEntry(ledger, "pending", sourceItemID);
const withDrill = (ledger, launchedItemID, entry) => withEntry(ledger, "drills", launchedItemID, entry);
const withoutDrill = (ledger, launchedItemID) => withoutEntry(ledger, "drills", launchedItemID);

module.exports = {
  LEDGER_FILE_NAME,
  LEDGER_VERSION,
  emptyLedger,
  ledgerFileOf,
  readLedger,
  withDrill,
  withPending,
  withoutDrill,
  withoutPending,
  writeLedger,
};
