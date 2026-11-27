"use strict";

const assert = require("node:assert");
const { buildFrontLayerView } = require("../../lib/world/occupation/frontLayer");
const { createManualClock } = require("../../lib/util/clock");

function makeStore(isOpen) {
  return { isOpen: () => isOpen };
}

function makeGovernor(admits) {
  return { admits: () => admits };
}

function makeStatus(state) {
  return { state };
}

module.exports = function ({ test }) {
  test("buildFrontLayerView: store closed -> cacheKey null, getData STORE_CLOSED", () => {
    const clock = createManualClock(1000000);
    const view = buildFrontLayerView({
      store: makeStore(false),
      repository: { listActiveOccupations: () => ({ ok: true, systems: [], nextAfterSystemId: null }) },
      clock,
      maxSystems: 0, maxLines: 2, refreshMs: 300000,
    });
    assert.strictEqual(view.cacheKey(), null);
    assert.deepStrictEqual(view.getData(), { available: false, reason: "STORE_CLOSED" });
  });

  test("buildFrontLayerView: governor hold -> cacheKey null, getData GOVERNOR_HOLD", () => {
    const clock = createManualClock(1000000);
    const view = buildFrontLayerView({
      store: makeStore(true),
      repository: { listActiveOccupations: () => ({ ok: true, systems: [], nextAfterSystemId: null }) },
      clock,
      getGovernor: () => makeGovernor(false),
      maxSystems: 0, maxLines: 2, refreshMs: 300000,
    });
    assert.strictEqual(view.cacheKey(), null);
    assert.deepStrictEqual(view.getData(), { available: false, reason: "GOVERNOR_HOLD" });
  });

  test("buildFrontLayerView: stopped -> cacheKey null, getData OCCUPATION_STOPPED", () => {
    const clock = createManualClock(1000000);
    const view = buildFrontLayerView({
      store: makeStore(true),
      repository: { listActiveOccupations: () => ({ ok: true, systems: [], nextAfterSystemId: null }) },
      clock,
      getStatus: () => makeStatus("stopped"),
      maxSystems: 0, maxLines: 2, refreshMs: 300000,
    });
    assert.strictEqual(view.cacheKey(), null);
    assert.deepStrictEqual(view.getData(), { available: false, reason: "OCCUPATION_STOPPED" });
  });

  test("buildFrontLayerView: all OK maxSystems 0 -> cacheKey time bucket, available true, items empty", () => {
    const clock = createManualClock(1000000);
    const view = buildFrontLayerView({
      store: makeStore(true),
      repository: { listActiveOccupations: () => ({ ok: true, systems: [], nextAfterSystemId: null }) },
      clock,
      maxSystems: 0, maxLines: 2, refreshMs: 300000,
    });
    const expectedKey = `k${Math.floor(1000000 / 300000)}`;
    assert.strictEqual(view.cacheKey(), expectedKey);
    const data = view.getData();
    assert.strictEqual(data.available, true);
    assert.deepStrictEqual(data.items, []);
    assert.strictEqual(data.key, expectedKey);
  });

  test("buildFrontLayerView: getStatus throws -> not stopped, cacheKey not null", () => {
    const clock = createManualClock(1000000);
    const view = buildFrontLayerView({
      store: makeStore(true),
      repository: { listActiveOccupations: () => ({ ok: true, systems: [], nextAfterSystemId: null }) },
      clock,
      getStatus: () => { throw new Error("boom"); },
      maxSystems: 0, maxLines: 2, refreshMs: 300000,
    });
    assert.ok(view.cacheKey() !== null && view.cacheKey().startsWith("k"));
    const data = view.getData();
    assert.strictEqual(data.available, true);
  });
};