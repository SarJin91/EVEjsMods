"use strict";

const path = require("node:path");

const SCHEMA_VERSION = 1;
const SOURCE = "fuzzwork";
const DETAIL_MAX = 200;

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function detailOf(err) {
  return String((err && (err.code || err.message)) || err).slice(0, DETAIL_MAX);
}

function loadSnapshotSync(filePath, opts) {
  const { stationId, now, maxBytes } = opts || {};
  const maxUnitPriceMilli = opts && isPositiveInt(opts.maxUnitPriceMilli) ? opts.maxUnitPriceMilli : 0;
  const fs = (opts && opts.fs) || require("node:fs");
  let text;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) return { ok: false, reason: "EXT_FILE_TOO_LARGE", detail: String(stat.size) };
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, snapshot: null };
    return { ok: false, reason: "EXT_FILE_READ", detail: detailOf(err) };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (_err) {
    return { ok: false, reason: "EXT_FILE_BAD_JSON" };
  }
  if (!isPlainObject(doc) || doc.schemaVersion !== SCHEMA_VERSION || !isPlainObject(doc.prices)
    || !Number.isSafeInteger(doc.fetchedAt) || doc.fetchedAt < 0) {
    return { ok: false, reason: "EXT_FILE_BAD_SHAPE" };
  }
  if (doc.stationId !== stationId) return { ok: false, reason: "EXT_FILE_STATION", detail: String(doc.stationId) };
  if (doc.fetchedAt > now) return { ok: false, reason: "EXT_FILE_FUTURE", detail: String(doc.fetchedAt) };
  const prices = new Map();
  for (const [key, entry] of Object.entries(doc.prices)) {
    const typeId = Number(key);
    if (!isPositiveInt(typeId) || String(typeId) !== key || !isPlainObject(entry)
      || !isPositiveInt(entry.bidMilli) || !isPositiveInt(entry.askMilli)) {
      return { ok: false, reason: "EXT_FILE_BAD_SHAPE", detail: `type ${String(key).slice(0, 20)}` };
    }
    if (entry.bidMilli > entry.askMilli) {
      return { ok: false, reason: "EXT_FILE_BAD_SHAPE", detail: `type ${typeId} CROSSED` };
    }
    if (entry.askMilli > maxUnitPriceMilli) {
      return { ok: false, reason: "EXT_FILE_BAD_SHAPE", detail: `type ${typeId} TOO_HIGH` };
    }
    prices.set(typeId, Object.freeze({ bidMilli: entry.bidMilli, askMilli: entry.askMilli }));
  }
  return { ok: true, snapshot: { stationId: doc.stationId, fetchedAt: doc.fetchedAt, prices } };
}

function serializeSnapshot(snapshot) {
  const prices = {};
  for (const typeId of [...snapshot.prices.keys()].sort((a, b) => a - b)) {
    const e = snapshot.prices.get(typeId);
    prices[String(typeId)] = { bidMilli: e.bidMilli, askMilli: e.askMilli };
  }
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, source: SOURCE, stationId: snapshot.stationId,
    fetchedAt: snapshot.fetchedAt, prices }, null, 2)}\n`;
}

function createSnapshotWriter(filePath, opts) {
  const fs = (opts && opts.fs) || require("node:fs");
  const onError = opts && typeof opts.onError === "function" ? opts.onError : () => {};
  const onSaved = opts && typeof opts.onSaved === "function" ? opts.onSaved : () => {};
  const tmpPath = `${filePath}.tmp`;
  const status = { writes: 0, failed: 0, lastError: null };
  let busy = null;
  let pending = null;

  function writeOnce(snapshot) {
    return Promise.resolve()
      .then(() => serializeSnapshot(snapshot))
      .then((text) => fs.promises.mkdir(path.dirname(filePath), { recursive: true })
        .then(() => fs.promises.writeFile(tmpPath, text, "utf8"))
        .then(() => fs.promises.rename(tmpPath, filePath)))
      .then(() => {
        status.writes += 1;
        status.lastError = null;
        try { onSaved(); } catch (_err) {}
        return true;
      }, (err) => {
        status.failed += 1;
        status.lastError = detailOf(err);
        try { onError(status.lastError); } catch (_err) {}
        return false;
      });
  }

  function drain(snapshot) {
    busy = writeOnce(snapshot).then((ok) => {
      if (pending !== null) {
        const next = pending;
        pending = null;
        return drain(next);
      }
      busy = null;
      return ok;
    });
    return busy;
  }

  function save(snapshot) {
    try {
      if (!snapshot || !(snapshot.prices instanceof Map)) return Promise.resolve(false);
      if (busy !== null) {
        pending = snapshot;
        return busy;
      }
      return drain(snapshot).catch(() => false);
    } catch (_err) {
      return Promise.resolve(false);
    }
  }

  return Object.freeze({
    save,
    isBusy: () => busy !== null,
    getStatus: () => Object.freeze({ ...status }),
  });
}

module.exports = { loadSnapshotSync, createSnapshotWriter, serializeSnapshot, SCHEMA_VERSION };
