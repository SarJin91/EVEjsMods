"use strict";

const assert = require("node:assert");

const { planDock } = require("../../lib/loyalty/dockRules");

const AMARR = 500003;
const PARAMS = Object.freeze({ dockDenyStandingMax: -5, dockDenyExemptCapsule: true });

module.exports = ({ test }) => {
  test("LD1 planDock: no controller, capsule exempt, capsule without exemption, NaN, -5 deny, -4.99 allow", () => {
    const at = (controllerFactionId, standing, isCapsule, params = PARAMS) =>
      planDock({ controllerFactionId, standing, isCapsule }, params);
    assert.deepStrictEqual(at(null, -9, false), { deny: false, reason: "NO_CONTROLLER" });
    assert.deepStrictEqual(at(AMARR, -9, true), { deny: false, reason: "CAPSULE" });
    assert.deepStrictEqual(at(AMARR, -6, true, { ...PARAMS, dockDenyExemptCapsule: false }),
      { deny: true, reason: "HOSTILE_CONTROLLER", factionId: AMARR, standing: -6 });
    assert.deepStrictEqual(at(AMARR, Number.NaN, false), { deny: false, reason: "STANDING_UNKNOWN" });
    assert.deepStrictEqual(at(AMARR, null, false), { deny: false, reason: "STANDING_UNKNOWN" });
    assert.deepStrictEqual(at(AMARR, -5, false),
      { deny: true, reason: "HOSTILE_CONTROLLER", factionId: AMARR, standing: -5 });
    assert.deepStrictEqual(at(AMARR, -4.99, false), { deny: false, reason: "STANDING_OK" });
  });
};
