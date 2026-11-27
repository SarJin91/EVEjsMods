"use strict";

const assert = require("node:assert");

const { createRateLimiter, WINDOW_MS } = require("../../lib/frontChat/rateLimit");

module.exports = ({ test }) => {
  test("FC2 rate limiter: cooldown per character, global window of 60 s, bounded map", () => {
    const t0 = 1700000000000;
    const one = createRateLimiter({ cooldownMs: 10000, maxPerMinute: 3, maxTracked: 16 });
    assert.deepStrictEqual(one.take(1, t0), { ok: true });
    assert.deepStrictEqual(one.take(1, t0 + 4000), { ok: false, reason: "COOLDOWN", waitMs: 6000 });
    assert.deepStrictEqual(one.take(2, t0 + 4000), { ok: true }, "another character is not held");
    assert.deepStrictEqual(one.take(1, t0 + 10000), { ok: true }, "cooldown over");
    assert.deepStrictEqual(one.take(3, t0 + 20000), { ok: false, reason: "GLOBAL", waitMs: WINDOW_MS - 20000 });
    assert.deepStrictEqual(one.take(3, t0 + WINDOW_MS), { ok: true });

    const small = createRateLimiter({ cooldownMs: 600000, maxPerMinute: 600, maxTracked: 16 });
    for (let id = 1; id <= 100; id += 1) assert.ok(small.take(id, t0 + id).ok);
    assert.strictEqual(small.size(), 16, "FIFO down to maxTracked");
    assert.ok(small.take(1, t0 + 200).ok, "an evicted character is free again (in-memory only)");
  });
};
