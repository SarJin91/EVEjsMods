"use strict";

const assert = require("node:assert");

const { createRegistry } = require("../../lib/telemetry/registry");
const { buildSnapshot } = require("../../lib/telemetry/snapshot");
const { COUNTER_NAMES } = require("../../lib/retention/schema");

const NOW_MS = 1700000000000;
const SAMPLES = 8;

function stateOf(registry) {
  return { seq: 1, capturedAtMs: NOW_MS, startedAtMs: NOW_MS, intervalMs: 10000, histogramSamples: SAMPLES,
    status: { tick: "ok" }, process: { pid: 1 }, metrics: registry.read(),
    tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
    gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null } };
}

module.exports = ({ test }) => {
  test("SN1 snapshot persistence.retention: null without the gauge; dryRun, counts per COUNTER_NAMES, passMs", () => {
    const off = createRegistry({ histogramSamples: SAMPLES, maxMetrics: 64 });
    assert.strictEqual(buildSnapshot(stateOf(off)).persistence.retention, null);

    const on = createRegistry({ histogramSamples: SAMPLES, maxMetrics: 64 });
    assert.strictEqual(on.gauge("persistence.retention.dryRun", 1), true);
    assert.strictEqual(on.count(`persistence.retention.${COUNTER_NAMES[0]}`, 3), true);
    assert.strictEqual(on.count(`persistence.retention.${COUNTER_NAMES[COUNTER_NAMES.length - 1]}`, 2), true);
    assert.strictEqual(on.observe("persistence.retention.passMs", 4), true);
    const retention = buildSnapshot(stateOf(on)).persistence.retention;
    assert.strictEqual(retention.dryRun, true);
    assert.deepStrictEqual(Object.keys(retention.counts), [...COUNTER_NAMES]);
    const expected = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
    expected[COUNTER_NAMES[0]] += 3;
    expected[COUNTER_NAMES[COUNTER_NAMES.length - 1]] += 2;
    assert.deepStrictEqual(retention.counts, expected);
    assert.ok(retention.passMs && typeof retention.passMs === "object", JSON.stringify(retention));
    assert.deepStrictEqual([retention.passMs.samples, retention.passMs.max], [1, 4], JSON.stringify(retention.passMs));

    const live = createRegistry({ histogramSamples: SAMPLES, maxMetrics: 64 });
    live.gauge("persistence.retention.dryRun", 0);
    assert.strictEqual(buildSnapshot(stateOf(live)).persistence.retention.dryRun, false);
  });
};
