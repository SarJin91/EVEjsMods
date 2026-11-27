"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MOD_DIR = path.join(__dirname, "..", "..");

function callArgsOf(text, name) {
  const out = [];
  let at = text.indexOf(`${name}(`);
  while (at >= 0) {
    const start = at + name.length + 1;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      i += 1;
    }
    out.push(text.slice(start, i - 1));
    at = text.indexOf(`${name}(`, i);
  }
  return out;
}

function splitArgs(args) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(args.slice(last, i).trim());
      last = i + 1;
    }
  }
  parts.push(args.slice(last).trim());
  return parts.filter((p) => p.length > 0);
}

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

module.exports = ({ test }) => {
  const { expandStrengthGroups } = require("../../lib/battle/strength");
  const { buildPowerTable } = require("../../lib/strategy/ai/strength");
  const { CAPITAL_STRENGTH_ROWS, capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
  const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
  const { resolveConfig } = require("../../config");

  test("CP1 capital power flag off: overlay = CAPITAL_STRENGTH_ROWS, power table of today", () => {
    const today = buildPowerTable(expandStrengthGroups(GROUPS));
    for (const strategy of [{ capitalPowerCalibrated: false }, null, undefined, "on", { capitalPowerCalibrated: 1 }]) {
      assert.strictEqual(capitalPowerOverlayOf(strategy), CAPITAL_STRENGTH_ROWS, JSON.stringify(strategy));
    }
    assert.deepStrictEqual(
      buildPowerTable(expandStrengthGroups(GROUPS, null, capitalPowerOverlayOf({ capitalPowerCalibrated: false }))),
      today);
    const defaults = resolveConfig({ env: {}, settings: {}, envFile: {}, modDir: MOD_DIR }).config.strategy;
    assert.strictEqual(defaults.capitalPowerCalibrated, false, "flag default off");
    assert.strictEqual(capitalPowerOverlayOf(defaults), CAPITAL_STRENGTH_ROWS);
  });

  test("CP2 capital power flag on: calibrated class powers, other keys unchanged, class ladder", () => {
    const resolved = resolveConfig({ env: { EVEJS_LNE_STRATEGY_CAPITAL_POWER_CALIBRATED: "1" }, settings: {},
      envFile: {}, modDir: MOD_DIR });
    assert.deepStrictEqual(resolved.errors, []);
    const strategy = resolved.config.strategy;
    assert.strictEqual(strategy.capitalPowerCalibrated, true);
    const overlay = capitalPowerOverlayOf(strategy);
    assert.ok(Object.isFrozen(overlay) && overlay !== CAPITAL_STRENGTH_ROWS);
    assert.deepStrictEqual(Object.fromEntries(Object.entries(overlay).map(([c, r]) => [c, r.powerPermille])),
      { carrier: 800, dreadnought: 4100, force_auxiliary: 900, supercarrier: 1250, titan: 4700 });
    const off = buildPowerTable(expandStrengthGroups(GROUPS));
    const on = buildPowerTable(expandStrengthGroups(GROUPS, null, overlay));
    const EXPECTED = { carrier: 8253, dreadnought: 7037, force_auxiliary: 10021, supercarrier: 21411, titan: 25704 };
    assert.deepStrictEqual(Object.keys(on), Object.keys(off));
    for (const key of Object.keys(off)) {
      assert.strictEqual(on[key], Object.hasOwn(EXPECTED, key) ? EXPECTED[key] : off[key], key);
    }
    const ladder = ["titan", "supercarrier", "force_auxiliary", "carrier", "dreadnought", "battleship"];
    for (let i = 1; i < ladder.length; i += 1) {
      assert.ok(on[ladder[i - 1]] > on[ladder[i]], `${ladder[i - 1]} ${on[ladder[i - 1]]} > ${ladder[i]} ${on[ladder[i]]}`);
    }
    const partial = capitalPowerOverlayOf({ capitalPowerCalibrated: true, capitalPowerPermilleTitan: 2.5 });
    assert.strictEqual(buildPowerTable(expandStrengthGroups(GROUPS, null, partial)).titan, off.titan);
  });

  test("CP3 completeness: every expandStrengthGroups call in lib/ and tools/ passes capitalPowerOverlayOf", () => {
    const definition = path.join(MOD_DIR, "lib", "battle", "strength.js");
    const calls = [];
    for (const file of [...jsFiles(path.join(MOD_DIR, "lib")), ...jsFiles(path.join(MOD_DIR, "tools"))]) {
      if (file === definition) continue;
      for (const args of callArgsOf(fs.readFileSync(file, "utf8"), "expandStrengthGroups")) {
        calls.push({ file: path.relative(MOD_DIR, file).split(path.sep).join("/"), args });
      }
    }
    assert.ok(calls.length >= 6, `calls found: ${calls.length}`);
    const bad = calls.filter((c) => splitArgs(c.args).length !== 3 || !c.args.includes("capitalPowerOverlayOf("));
    assert.deepStrictEqual(bad, []);
  });
};
