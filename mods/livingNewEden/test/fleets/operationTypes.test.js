"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { mask, matchClose, topLevelKeys, lineOf } = require("../_support/sourceScan");
const { OPERATION_TYPES } = require("../../lib/fleets/schema");
const { OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SYSTEM_CARD = "web/systemCard.js";
const LABEL_MAP_START = "const OPERATION_TYPES = Object.freeze({";
const LITERAL_EXCEPTIONS = Object.freeze({});
const OPENS_FRONT_EXCEPTIONS = Object.freeze({});

const LITERAL_PATTERNS = Object.freeze([
  /\boperationType\s*:\s*"([^"]*)"/g,
  /\boperationType(?<!typeof\s+[\w$.?]*operationType)\s*===\s*"([^"]*)"/g,
  /"([^"]*)"\s*===\s*[\w$.?]*\boperationType\b/g,
  /\bconst\s+[A-Z0-9_]*_OPERATION_TYPE\s*=\s*"([^"]*)"/g,
]);

function read(rel) {
  return fs.readFileSync(path.join(MOD_DIR, rel), "utf8").replace(/\r\n/g, "\n");
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".js")) out.push(path.relative(MOD_DIR, full).split(path.sep).join("/"));
  }
  return out;
}

function diff(actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  return { missing: [...e].filter((x) => !a.has(x)).sort(), extra: [...a].filter((x) => !e.has(x)).sort() };
}

module.exports = ({ test }) => {
  test("OTY1 operation types: the label map of web/systemCard.js has every OPERATION_TYPES key and no other", () => {
    const raw = read(SYSTEM_CARD);
    const text = mask(raw, { strings: false });
    const ms = mask(raw, { strings: true });
    const at = text.indexOf(LABEL_MAP_START);
    assert.ok(at >= 0, `${SYSTEM_CARD}: "${LABEL_MAP_START}" not found`);
    const open = at + LABEL_MAP_START.length - 1;
    assert.ok(matchClose(ms, open) > open, `${SYSTEM_CARD}: label map not closed`);
    const keys = topLevelKeys(text, ms, open);
    assert.strictEqual(keys.spread || keys.computed, false, `${SYSTEM_CARD}: label map has a spread / computed key`);
    const d = diff(keys.keys, OPERATION_TYPES);
    assert.deepStrictEqual(d, { missing: [], extra: [] },
      `${SYSTEM_CARD} OPERATION_TYPES labels: missing ${d.missing.join(", ") || "-"}, extra ${d.extra.join(", ") || "-"}`);
  });

  test("OTY2 operation types: every operation type literal in lib/ is in OPERATION_TYPES", () => {
    const known = new Set(OPERATION_TYPES);
    const bad = [];
    let found = 0;
    for (const rel of walk(path.join(MOD_DIR, "lib"), []).sort()) {
      const raw = read(rel);
      if (!raw.includes("OPERATION_TYPE") && !raw.includes("operationType")) continue;
      const text = mask(raw, { strings: false });
      for (const re of LITERAL_PATTERNS) {
        for (const m of text.matchAll(re)) {
          found += 1;
          const where = `${rel}:${lineOf(text, m.index)}`;
          if (!known.has(m[1]) && !LITERAL_EXCEPTIONS[where]) bad.push(`${where} ${m[1]}`);
        }
      }
    }
    assert.ok(found > 0, "no operation type literal found - the patterns no longer match the code");
    assert.deepStrictEqual(bad, [], `operation type literals outside OPERATION_TYPES: ${bad.join("; ")}`);
  });

  test("OTY3 operation types: kinds use known types, the kinds of one type agree on opensFront", () => {
    const known = new Set(OPERATION_TYPES);
    const unknown = OPERATION_KINDS_V1.filter((k) => !known.has(k.operationType))
      .map((k) => `${k.kind}:${k.operationType}`);
    assert.deepStrictEqual(unknown, [], `kinds with an operationType outside OPERATION_TYPES: ${unknown.join(", ")}`);
    const fronts = new Map();
    for (const k of OPERATION_KINDS_V1) {
      if (!fronts.has(k.operationType)) fronts.set(k.operationType, []);
      fronts.get(k.operationType).push(`${k.kind}=${k.opensFront}`);
    }
    const split = [...fronts].filter(([type, list]) => !OPENS_FRONT_EXCEPTIONS[type]
      && new Set(list.map((s) => s.split("=")[1])).size > 1).map(([type, list]) => `${type} (${list.join(", ")})`);
    assert.deepStrictEqual(split, [], `operation types whose kinds disagree on opensFront: ${split.join("; ")}`);
  });
};
