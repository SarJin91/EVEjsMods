"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../../config");
const { parseComposeEnv } = require("../../tools/liveSim/compose");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE = "compose.yaml";
const COMPOSE_SEARCH_MAX_DEPTH = 5;
const PREFIX = "fortress.";

function findCompose() {
  let dir = path.dirname(MOD_DIR);
  for (let i = 0; i < COMPOSE_SEARCH_MAX_DEPTH; i += 1) {
    const file = path.join(dir, COMPOSE_FILE);
    if (fs.existsSync(file)) return file;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

module.exports = ({ test, skip }) => {
  const file = findCompose();
  if (!file) {
    skip("ZFE1 fortress compose keys", "compose.yaml not found above the mod (Docker image)");
    return;
  }

  test("ZFE1 fortress enable: every fortress.* SCHEMA key passes through compose (flags :-0, values :-) and "
    + "resolves to the SCHEMA default", () => {
    const rows = config.SCHEMA.filter((r) => r.key.startsWith(PREFIX));
    assert.ok(rows.length >= 17, `fortress.* rows: ${rows.length}`);
    const parsed = parseComposeEnv(fs.readFileSync(file, "utf8"));
    assert.strictEqual(parsed.ok, true, JSON.stringify(parsed));
    const byName = new Map(parsed.entries.map((e) => [e.name, e]));
    const missing = rows.filter((r) => !byName.has(r.env)).map((r) => r.env);
    assert.deepStrictEqual(missing, [], `fortress keys missing in compose.yaml: ${missing.join(", ")}`);
    const wrong = [];
    for (const r of rows) {
      const e = byName.get(r.env);
      const want = r.type === "boolean" ? "0" : "";
      if (e.fixed || e.value !== want) wrong.push(`${r.env}: ${e.fixed ? "fixed " : ""}"${e.value}" (want "${want}")`);
    }
    assert.deepStrictEqual(wrong, [], `fortress compose defaults: ${wrong.join("; ")}`);

    const res = config.resolveConfig({ env: parsed.values, modDir: MOD_DIR });
    assert.deepStrictEqual(res.errors, [], `resolveConfig errors: ${res.errors.join("; ")}`);
    const off = [];
    for (const r of rows) {
      const v = r.key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), res.config);
      if (JSON.stringify(v) !== JSON.stringify(r.default)) off.push(`${r.key}=${JSON.stringify(v)}`);
    }
    assert.deepStrictEqual(off, [], `fortress keys off the SCHEMA default with compose defaults: ${off.join(", ")}`);
    const rejected = res.warnings.filter((w) => w.includes("EVEJS_LNE_FORTRESS_"));
    assert.deepStrictEqual(rejected, [], `fortress compose values rejected: ${rejected.join("; ")}`);
  });
};
