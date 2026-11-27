"use strict";

const assert = require("node:assert");
const { TARGET_ROLES, STRIKE_ROLES, HUNTER_STATES, PIN_OUTCOMES, SCAN_REASONS } = require("../../../lib/strategy/hunt/data/huntRules");

module.exports = ({ test }) => {
  test("huntRules TARGET_ROLES: includes expected roles, excludes logistics/mining/garrison/hunter", () => {
    assert.deepStrictEqual([...TARGET_ROLES].sort(), ["invasion", "patrol", "scout", "reserve", "wormhole"].sort());
    assert.ok(!TARGET_ROLES.includes("logistics"), "logistics excluded");
    assert.ok(!TARGET_ROLES.includes("mining"), "mining excluded");
    assert.ok(!TARGET_ROLES.includes("garrison"), "garrison excluded");
    assert.ok(!TARGET_ROLES.includes("hunter"), "hunter excluded (D-3)");
  });

  test("huntRules STRIKE_ROLES: includes invasion and patrol only", () => {
    assert.deepStrictEqual([...STRIKE_ROLES].sort(), ["invasion", "patrol"].sort());
    assert.ok(!STRIKE_ROLES.includes("logistics"));
    assert.ok(!STRIKE_ROLES.includes("mining"));
    assert.ok(!STRIKE_ROLES.includes("garrison"));
    assert.ok(!STRIKE_ROLES.includes("scout"));
    assert.ok(!STRIKE_ROLES.includes("hunter"));
  });

  test("huntRules HUNTER_STATES: all expected states present", () => {
    const expected = ["IDLE", "PATROLLING", "SCANNING", "PINNING", "STRIKING", "DONE"];
    for (const s of expected) {
      assert.ok(Object.values(HUNTER_STATES).includes(s), `missing ${s}`);
    }
  });

  test("huntRules PIN_OUTCOMES: four outcomes", () => {
    assert.deepStrictEqual([...PIN_OUTCOMES].sort(), ["BROKEN", "CANCELLED", "ESCAPED", "STRUCK"].sort());
  });

  test("huntRules SCAN_REASONS: includes expected reasons", () => {
    const expected = ["NO_TARGET", "NO_STRIKE", "STRIKE_TOO_SLOW", "PIN_CREATED", "ON_COOLDOWN", "LIMIT_EXCEEDED"];
    for (const r of expected) {
      assert.ok(SCAN_REASONS.includes(r), `missing ${r}`);
    }
  });
};