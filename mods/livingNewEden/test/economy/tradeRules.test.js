"use strict";

const assert = require("node:assert");
const { pickIssuer } = require("../../lib/economy/trade/executorRules");

module.exports = ({ test }) => {
  test("pickIssuer: sorts by open offers asc, then slot asc, no mutation", () => {
    const candidates = [
      { slot: 2, corporationId: 200, characterId: 20 },
      { slot: 1, corporationId: 100, characterId: 10 },
      { slot: 0, corporationId: 300, characterId: 30 },
    ];
    const counts = new Map([[10, 5], [20, 1], [30, 1]]);
    const sorted = pickIssuer(candidates, counts);
    assert.strictEqual(sorted[0].characterId, 30);
    assert.strictEqual(sorted[0].slot, 0);
    assert.strictEqual(sorted[1].characterId, 20);
    assert.strictEqual(sorted[1].slot, 2);
    assert.strictEqual(sorted[2].characterId, 10);
    assert.strictEqual(sorted[2].slot, 1);
    assert.strictEqual(candidates[0].characterId, 20);
    assert.strictEqual(candidates[1].characterId, 10);
    assert.strictEqual(candidates[2].characterId, 30);
  });

  test("pickIssuer: empty counts defaults to 0, then slot asc", () => {
    const candidates = [
      { slot: 2, corporationId: 200, characterId: 20 },
      { slot: 0, corporationId: 100, characterId: 10 },
      { slot: 1, corporationId: 300, characterId: 30 },
    ];
    const counts = new Map();
    const sorted = pickIssuer(candidates, counts);
    assert.strictEqual(sorted[0].characterId, 10);
    assert.strictEqual(sorted[0].slot, 0);
    assert.strictEqual(sorted[1].characterId, 30);
    assert.strictEqual(sorted[1].slot, 1);
    assert.strictEqual(sorted[2].characterId, 20);
    assert.strictEqual(sorted[2].slot, 2);
  });

  test("pickIssuer: empty candidates returns empty array", () => {
    const sorted = pickIssuer([], new Map());
    assert.deepStrictEqual(sorted, []);
  });

  test("pickIssuer: does not mutate input counts", () => {
    const candidates = [{ slot: 0, corporationId: 100, characterId: 10 }];
    const counts = new Map([[10, 0]]);
    pickIssuer(candidates, counts);
    assert.strictEqual(counts.get(10), 0);
  });
};