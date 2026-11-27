"use strict";

const assert = require("node:assert");

const { createTemplatePool } = require("../../lib/chatterAi/pool");

const line = (n) => ({ id: `ai-x-${n}`, text: `template number ${n} here` });

module.exports = ({ test }) => {
  test("P1 pool: FIFO to poolPerBucket, no duplicate id, prune by age, unknown bucket = [] frozen", () => {
    const pool = createTemplatePool({ poolPerBucket: 3, lineMaxAgeMs: 1000 });
    assert.strictEqual(pool.add("fc.A", [line(1), line(2)], 100), 2);
    assert.strictEqual(pool.add("fc.A", [line(2), line(3), line(4)], 600), 2, "id 2 already in the bucket");
    assert.deepStrictEqual(pool.linesOf("fc.A").map((x) => x.id), ["ai-x-2", "ai-x-3", "ai-x-4"], "oldest left");
    assert.ok(Object.isFrozen(pool.linesOf("fc.A")) && Object.isFrozen(pool.linesOf("fc.A")[0]));
    assert.ok(pool.knownNormalized("fc.A").has("template number 3 here"));
    assert.deepStrictEqual(pool.totals(), { buckets: 1, filled: 1, lines: 3 });

    assert.strictEqual(pool.prune(1100), 0, "age 1000 = not older than lineMaxAgeMs");
    assert.strictEqual(pool.prune(1101), 1, "line 2 (added at 100) leaves");
    assert.deepStrictEqual(pool.linesOf("fc.A").map((x) => x.id), ["ai-x-3", "ai-x-4"]);
    assert.strictEqual(pool.prune(1601), 2);
    assert.strictEqual(pool.sizeOf("fc.A"), 0);

    const unknown = pool.linesOf("fc.NOPE");
    assert.deepStrictEqual(unknown, []);
    assert.ok(Object.isFrozen(unknown));
    assert.deepStrictEqual(pool.linesOf(undefined), []);
    assert.strictEqual(pool.sizeOf("fc.NOPE"), 0);
  });
};
