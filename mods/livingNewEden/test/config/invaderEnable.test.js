"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../../config");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE = "compose.yaml";
const COMPOSE_SEARCH_MAX_DEPTH = 5;
const NAME_RE = /EVEJS_LNE_[A-Z0-9_]+/g;
const ENTRY_RE = /^\s*(EVEJS_LNE_[A-Z0-9_]+)\s*:\s*(.*?)\s*$/;
const DEFAULT_RE = /^\$\{(EVEJS_LNE_[A-Z0-9_]+):?-(.*)\}$/;
const NO_DEFAULT_RE = /^\$\{EVEJS_LNE_[A-Z0-9_]+\}$/;

const D10129_FLAGS = Object.freeze([
  "EVEJS_LNE_INVASIONS_REVIEW_FOOTHOLDS_ENABLED",
  "EVEJS_LNE_INVASIONS_REFIT_AT_FOOTHOLD_ENABLED",
  "EVEJS_LNE_INVASIONS_HOME_BASE_ENABLED",
  "EVEJS_LNE_INVASIONS_REFIT_AT_HOME_ENABLED",
]);
const INVADER_FLAGS = Object.freeze([
  "EVEJS_LNE_INVADER_ECONOMY_ENABLED",
  "EVEJS_LNE_INVADER_ECONOMY_HOME_POOL_ENABLED",
  "EVEJS_LNE_INVADER_ECONOMY_CONDUIT_ENABLED",
  "EVEJS_LNE_INVADER_ECONOMY_RAIDS_ENABLED",
]);
const CAPTURE_RANGE = "EVEJS_LNE_INVASIONS_HOME_CAPTURE_RANGE_JUMPS";

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

function unquote(v) {
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

function readCompose(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const names = [...new Set(text.match(NAME_RE) || [])].sort();
  const env = {};
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const value = unquote(m[2].replace(/\s+#.*$/, ""));
    if (NO_DEFAULT_RE.test(value)) continue;
    const d = DEFAULT_RE.exec(value);
    env[m[1]] = d ? unquote(d[2]) : value;
  }
  return { names, env };
}

const withFlags = (env, names, value) => ({ ...env, ...Object.fromEntries(names.map((k) => [k, value])) });

module.exports = ({ test, skip }) => {
  const file = findCompose();
  if (!file) {
    skip("IEN1-2 invader enable", "compose.yaml not found above the mod (Docker image)");
    return;
  }

  test("IEN1 invader enable: compose + + 4 invader flags = no error, no invaderEconomy warning", () => {
    const compose = readCompose(file);
    const env = withFlags(withFlags(compose.env, D10129_FLAGS, "1"), INVADER_FLAGS, "1");
    const r = config.resolveConfig({ env, modDir: MOD_DIR });
    assert.deepStrictEqual(r.errors, [], `errors: ${r.errors.join("; ")}`);
    assert.deepStrictEqual(r.warnings.filter((w) => w.includes("invaderEconomy")), []);
    assert.strictEqual(r.config.invaderEconomy.enabled, true);
    assert.strictEqual(r.config.invaderEconomy.raidsEnabled, true);
    assert.ok(compose.names.includes(CAPTURE_RANGE), `${CAPTURE_RANGE} not in compose`);
    assert.strictEqual(compose.env[CAPTURE_RANGE], "", `${CAPTURE_RANGE} compose default not empty`);
    const row = config.SCHEMA.find((x) => x.env === CAPTURE_RANGE);
    assert.ok(row, `${CAPTURE_RANGE} not a SCHEMA env`);
    assert.strictEqual(r.config.invasions.homeCaptureRangeJumps, row.default);
  });

  test("IEN2 invader enable: the 4 invader flags 1 vs 0 give the same rowBoundsOfConfig", () => {
    const base = withFlags(readCompose(file).env, D10129_FLAGS, "1");
    const on = config.resolveConfig({ env: withFlags(base, INVADER_FLAGS, "1"), modDir: MOD_DIR });
    const off = config.resolveConfig({ env: withFlags(base, INVADER_FLAGS, "0"), modDir: MOD_DIR });
    assert.deepStrictEqual([on.errors, off.errors], [[], []]);
    assert.deepStrictEqual(rowBoundsOfConfig(on.config), rowBoundsOfConfig(off.config));
  });
};
