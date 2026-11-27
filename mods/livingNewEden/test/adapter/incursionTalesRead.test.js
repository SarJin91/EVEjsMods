"use strict";

const assert = require("node:assert");

const { createIncursionTalesRead, TABLE } = require("../../lib/adapter/incursionTalesRead");
const { createIncursionNative } = require("../../lib/adapter/incursionNative");

function world() {
  const cache = { [TABLE]: { tales: {} } };
  const gameStore = { read: (table, pth) => (table in cache && pth === "/" ? { success: true, data: cache[table] }
    : { success: false, errorMsg: "TABLE_NOT_FOUND", data: null }) };
  const calls = { list: 0 };
  let tales = [{ taleID: 7, terminal: null, placement: { systems: [{ solarSystemID: 30000001 }] } }];
  let fail = null;
  const lifecycle = { listTales() {
    calls.list += 1;
    if (fail) throw new Error(fail);
    return JSON.parse(JSON.stringify(tales));
  } };
  return {
    cache, gameStore, calls, lifecycle,
    setTales: (next) => { tales = next; },
    setFail: (message) => { fail = message; },
    requireGame: (rel) => (rel === "gameStore/index" ? { ok: true, exports: gameStore } : { ok: false, reason: "not_in_game_modules" }),
  };
}

module.exports = ({ test }) => {
  test("ITR1 talesRead: one listTales per table root, a new root reads again, the list is deep frozen", () => {
    const w = world();
    const reader = createIncursionTalesRead({ requireGame: w.requireGame });
    const a = reader.read(w.lifecycle);
    const b = reader.read(w.lifecycle);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.tales, a.tales, "memo");
    assert.strictEqual(w.calls.list, 1);
    assert.ok(Object.isFrozen(a.tales) && Object.isFrozen(a.tales[0]) && Object.isFrozen(a.tales[0].placement.systems[0]));
    assert.throws(() => { a.tales[0].terminal = { outcome: "x" }; }, TypeError);
    w.setTales([]);
    w.cache[TABLE] = { tales: {} };
    const c = reader.read(w.lifecycle);
    assert.strictEqual(w.calls.list, 2, "new root");
    assert.deepStrictEqual(c.tales, []);
    assert.deepStrictEqual(reader.stats(), { hits: 1, fills: 2 });
  });

  test("ITR2 talesRead: a vendor throw = INCURSION_READ_FAILED without cache; no gameStore = vendor every call; HUD/native via the read", () => {
    const w = world();
    const reader = createIncursionTalesRead({ requireGame: w.requireGame });
    w.setFail("INCURSION_LIFECYCLE_STORE_RECOVERY_REQUIRED");
    const r = reader.read(w.lifecycle);
    assert.deepStrictEqual(r, { ok: false, reason: "INCURSION_READ_FAILED", detail: "INCURSION_LIFECYCLE_STORE_RECOVERY_REQUIRED" });
    w.setFail(null);
    assert.strictEqual(reader.read(w.lifecycle).ok, true);
    assert.strictEqual(w.calls.list, 2, "no cache after a throw");
    assert.strictEqual(reader.read({ listTales: () => "x" }).ok, true, "same root: memo, the lifecycle is not called");

    const bare = createIncursionTalesRead({ requireGame: () => ({ ok: false, reason: "not_in_game_modules" }) });
    const one = bare.read(w.lifecycle);
    bare.read(w.lifecycle);
    assert.strictEqual(w.calls.list, 4, "no gameStore: the vendor every call");
    assert.strictEqual(Object.isFrozen(one.tales), false, "unfrozen as today");
    assert.deepStrictEqual(bare.read({ listTales: () => "x" }), { ok: false, reason: "INCURSION_READ_FAILED", detail: "not an array" });
    assert.strictEqual(createIncursionTalesRead({}).read(w.lifecycle).ok, true, "no requireGame");

    const lifecycleExports = { listTales: w.lifecycle.listTales };
    const requireGame = (rel) => (rel === "services/incursion/incursionLifecycle" ? { ok: true, exports: lifecycleExports }
      : w.requireGame(rel));
    const native = createIncursionNative({ requireGame });
    const before = w.calls.list;
    const n1 = native.listTales({ limit: 5 });
    const n2 = native.listTales({ limit: 5 });
    assert.strictEqual(n1.ok, true);
    assert.deepStrictEqual(n1, n2);
    assert.deepStrictEqual(n1.tales.map((t) => [t.taleId, t.systemIds]), [[7, [30000001]]]);
    assert.strictEqual(w.calls.list, before + 1, "native: one listTales per root");
    w.cache[TABLE] = { tales: {} };
    w.setFail("boom");
    assert.deepStrictEqual(native.listTales({ limit: 5 }), { ok: false, reason: "INCURSION_READ_FAILED", detail: "boom" });
  });
};
