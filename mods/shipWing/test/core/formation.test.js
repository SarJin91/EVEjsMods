"use strict";

const assert = require("node:assert");
const { slotPoint, normalizeFormation, FORMATIONS } = require("../../lib/core/formation");

const CFG = Object.freeze({ formationSpacingMeters: 1000, formationMaxDistanceMeters: 12000, formationLeadMs: 1000,
  formationWedgeAngleDeg: 45 });

function host(velocity = { x: 0, y: 0, z: 0 }) {
  return { position: { x: 0, y: 0, z: 0 }, velocity, direction: { x: 1, y: 0, z: 0 } };
}

function point(name, index, count, extra = {}) {
  return slotPoint({ name, index, count, host: extra.host || host(), maxRadius: 0, cfg: { ...CFG, ...extra.cfg } });
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
}

module.exports = ({ test }) => {
  test("FM-G1 slots line/column/wedge/sphere for a host flying +x; scaled to formationMaxDistanceMeters; lead from "
    + "the host velocity; none -> null", () => {
    const line = point("line", 0, 2);
    near(line.x, 0, "line x");
    near(Math.abs(line.z), 1000, "line |z|");
    const line1 = point("line", 1, 2);
    near(line1.z, -line.z, "line i1 on the other side");
    near(point("column", 1, 2).x, -2000, "column i1");
    const wedge = point("wedge", 0, 2);
    near(wedge.x, -1000 * Math.SQRT1_2, "wedge x");
    near(Math.abs(wedge.z), 1000 * Math.SQRT1_2, "wedge |z|");
    const sphere = [0, 1, 2, 3, 4, 5].map((i) => point("sphere", i, 14));
    near(Math.abs(sphere[2].y), 1000, "sphere i2 = up");
    near(sphere[4].x, 1000, "sphere i4 = forward");
    near(sphere[5].x, -1000, "sphere i5 = back");
    const far = point("column", 9, 10, { cfg: { formationMaxDistanceMeters: 5000 } });
    near(far.x, -5000, "scaled column i9");
    near(point("column", 0, 1, { host: host({ x: 100, y: 0, z: 0 }) }).x, -1000 + 100, "lead");
    assert.strictEqual(point("none", 0, 1), null);
    assert.strictEqual(point("line", 2, 2), null, "index outside count");
    assert.strictEqual(point("line", 0, 1, { host: { ...host(), position: { x: NaN, y: 0, z: 0 } } }), null);
    assert.deepStrictEqual([normalizeFormation(" Wedge "), normalizeFormation("foo")], ["wedge", null]);
    assert.deepStrictEqual(FORMATIONS, ["none", "wedge", "line", "column", "sphere"]);
  });
};
