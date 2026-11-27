"use strict";

const crypto = require("node:crypto");

const DEFAULT_DIFF_MAX = 20;

function messageOf(err) {
  return String((err && err.message) || err);
}

function quoteId(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

function encodeValue(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "bigint") return `{"$big":"${v.toString()}"}`;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `{"$blob":"${Buffer.from(v).toString("hex")}"}`;
  return JSON.stringify(v);
}

function canonicalRow(row, skip) {
  const parts = [];
  for (const key of Object.keys(row).sort()) {
    if (skip && skip.has(key)) continue;
    parts.push(`${JSON.stringify(key)}:${encodeValue(row[key])}`);
  }
  return `{${parts.join(",")}}`;
}

function userTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
    + "ORDER BY name").all().map((r) => r.name);
}

function orderByOf(db, table) {
  const pk = db.prepare(`PRAGMA table_info(${quoteId(table)})`).all().filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk).map((c) => quoteId(c.name));
  return pk.length > 0 ? pk.join(", ") : "rowid";
}

function digestTables(db, volatile) {
  const skipTables = new Set();
  const skipColumns = new Map();
  for (const entry of volatile || []) {
    const text = String(entry);
    const dot = text.indexOf(".");
    if (dot < 0) skipTables.add(text);
    else {
      const t = text.slice(0, dot);
      if (!skipColumns.has(t)) skipColumns.set(t, new Set());
      skipColumns.get(t).add(text.slice(dot + 1));
    }
  }
  const tables = {};
  const overall = crypto.createHash("sha256");
  for (const name of userTables(db)) {
    if (skipTables.has(name)) continue;
    const skip = skipColumns.get(name) || null;
    const hash = crypto.createHash("sha256");
    let rows = 0;
    for (const row of db.prepare(`SELECT * FROM ${quoteId(name)} ORDER BY ${orderByOf(db, name)}`).iterate()) {
      hash.update(canonicalRow(row, skip));
      hash.update("\n");
      rows += 1;
    }
    const digest = hash.digest("hex");
    tables[name] = { rows, digest };
    overall.update(`${name}:${rows}:${digest}\n`);
  }
  return { ok: true, digest: overall.digest("hex"), tables };
}

function fullDigest(db) {
  try {
    return digestTables(db, null);
  } catch (err) {
    return { ok: false, reason: "DIGEST_FAILED", detail: messageOf(err) };
  }
}

function semanticDigest(db, opts = {}) {
  try {
    return digestTables(db, opts.volatile || null);
  } catch (err) {
    return { ok: false, reason: "DIGEST_FAILED", detail: messageOf(err) };
  }
}

function queryDigest(db, sql, params = []) {
  try {
    const hash = crypto.createHash("sha256");
    let rows = 0;
    for (const row of db.prepare(sql).iterate(...params)) {
      hash.update(canonicalRow(row, null));
      hash.update("\n");
      rows += 1;
    }
    return { ok: true, digest: hash.digest("hex"), rows };
  } catch (err) {
    return { ok: false, reason: "DIGEST_FAILED", detail: messageOf(err) };
  }
}

function diffDigests(a, b, max = DEFAULT_DIFF_MAX) {
  const out = [];
  const left = (a && a.tables) || {};
  const right = (b && b.tables) || {};
  for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (!left[name]) out.push(`${name}(missing before)`);
    else if (!right[name]) out.push(`${name}(missing after)`);
    else if (left[name].digest !== right[name].digest) out.push(`${name}(rows ${left[name].rows}->${right[name].rows})`);
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { fullDigest, semanticDigest, queryDigest, diffDigests, canonicalRow };
