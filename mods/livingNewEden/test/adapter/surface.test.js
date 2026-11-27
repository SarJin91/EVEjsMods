"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createAdapter } = require("../../lib/adapter");

const MOD_ROOT = path.join(__dirname, "..", "..");
const LIB = path.join(MOD_ROOT, "lib");
const ADAPTER_DIR = path.join(LIB, "adapter");
const SRC = path.join(path.sep, "x", "server", "src");

const PRIVATE_INNER_FUNCTIONS = new Set();

function innerFunctionNames() {
  const source = fs.readFileSync(path.join(ADAPTER_DIR, "index.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("function createAdapter(");
  assert.ok(start >= 0, "createAdapter not found");
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "end of createAdapter not found");
  const body = source.slice(start, end);
  const names = [];
  for (const m of body.matchAll(/^ {2}(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)) names.push(m[1]);
  return names;
}

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== ADAPTER_DIR) listJsFiles(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const CALL_RE = /\b(?:ctx\.|deps\.)?adapter\)?\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const TYPEOF_RE = /typeof\s+(?:ctx\.|deps\.)?adapter\.([A-Za-z_$][\w$]*)/g;

function consumerNames() {
  const found = new Map();
  for (const file of listJsFiles(LIB)) {
    const source = fs.readFileSync(file, "utf8");
    for (const re of [CALL_RE, TYPEOF_RE]) {
      for (const m of source.matchAll(re)) {
        if (!found.has(m[1])) found.set(m[1], path.relative(MOD_ROOT, file));
      }
    }
  }
  return found;
}

module.exports = ({ test }) => {
  test("S1: every function declared inside createAdapter is returned by the real adapter", () => {
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    const names = innerFunctionNames();
    assert.ok(names.includes("getDungeonSites") && names.includes("checkDungeonSites"), names.join(","));
    const missing = names.filter((n) => !PRIVATE_INNER_FUNCTIONS.has(n) && typeof adapter[n] !== "function");
    assert.deepStrictEqual(missing, [], `declared in createAdapter but not returned: ${missing.join(", ")}`);
  });

  test("S2: every adapter.X used by lib/** consumers is a function on the real adapter", () => {
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    const used = consumerNames();
    for (const known of ["getDungeonSites", "checkDungeonSites", "reserveCharacterId", "getProcessRole"]) {
      assert.ok(used.has(known), `consumer scan lost ${known}`);
    }
    const missing = [...used].filter(([name]) => typeof adapter[name] !== "function")
      .map(([name, file]) => `${name} (${file})`);
    assert.deepStrictEqual(missing, [], `consumers use methods the adapter does not return: ${missing.join(", ")}`);
  });

  test("S3: restored seams refuse structurally on a blind adapter; getProcessRole reads gameStore", () => {
    const blind = createAdapter({ moduleApi: { _cache: {} } });
    const sites = blind.getDungeonSites();
    assert.strictEqual(sites.ok, false);
    assert.strictEqual(sites.reason, "SEAM_UNAVAILABLE");
    const check = blind.checkDungeonSites();
    assert.strictEqual(check.ok, false);
    assert.strictEqual(check.reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(blind.getProcessRole(), "unknown");
    assert.strictEqual(blind.reserveCharacterId().ok, false);

    const gameStorePath = path.join(SRC, "gameStore/index.js");
    const adapter = createAdapter({ moduleApi: { _cache: { [gameStorePath]: { exports: { _processRole: "world" } } } } });
    adapter.setServerSrc(SRC);
    assert.strictEqual(adapter.getProcessRole(), "world");
  });
};
