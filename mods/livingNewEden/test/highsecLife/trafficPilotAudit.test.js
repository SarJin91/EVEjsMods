"use strict";

const assert = require("node:assert");

const { pilotAuditOf } = require("../../lib/highsecLife/traffic/service");
const { TRAFFIC_METRICS } = require("../../lib/highsecLife/schema");
const { rig } = require("./trafficPilots.test");

const AUDIT_NAMES = Object.freeze([TRAFFIC_METRICS.pilotShips, TRAFFIC_METRICS.pilotDuplicates,
  TRAFFIC_METRICS.maxPerSystem]);
const BEFORE_NAMES = Object.freeze([TRAFFIC_METRICS.live, TRAFFIC_METRICS.spawned, TRAFFIC_METRICS.despawned,
  TRAFFIC_METRICS.passMs]);

function telemetry() {
  const calls = [];
  const rec = (kind) => (name, value) => calls.push([kind, name, value]);
  return { calls, count: rec("count"), gauge: rec("gauge"), observe: rec("observe") };
}

module.exports = ({ test }) => {
  test("PG5 pilotAuditOf; tick with the LIVE lane = 3 gauges; without it = the metric names of before", () => {
    assert.deepStrictEqual(pilotAuditOf([{ systemId: 1, pilotId: 5 }, { systemId: 1, pilotId: 5 }, { systemId: 2 },
      { systemId: 1 }, { systemId: 2, pilotId: 6 }]), { pilotShips: 3, duplicates: 1, maxPerSystem: 3 });
    assert.deepStrictEqual(pilotAuditOf([]), { pilotShips: 0, duplicates: 0, maxPerSystem: 0 });

    const { harness, fakePopulation, cand, FROM, NEXT } = rig;
    const on = telemetry();
    const pop = fakePopulation([cand(1, "HAULER", "GATE", FROM, NEXT), cand(2, "UNDOCK", "GATE", 0, NEXT)]);
    const h = harness({ pop, extra: { telemetry: on } });
    h.tick();
    const gauges = Object.fromEntries(on.calls.filter((c) => c[0] === "gauge" && AUDIT_NAMES.includes(c[1]))
      .map((c) => [c[1], c[2]]));
    assert.deepStrictEqual(gauges, { [TRAFFIC_METRICS.pilotShips]: 2, [TRAFFIC_METRICS.pilotDuplicates]: 0,
      [TRAFFIC_METRICS.maxPerSystem]: 2 });

    const off = telemetry();
    const h0 = harness({ extra: { telemetry: off } });
    h0.tick(20);
    const names = [...new Set(off.calls.map((c) => c[1]))];
    assert.ok(names.includes(TRAFFIC_METRICS.live) && names.includes(TRAFFIC_METRICS.passMs), names.join(","));
    assert.deepStrictEqual(names.filter((n) => !BEFORE_NAMES.includes(n)), []);
  });
};
