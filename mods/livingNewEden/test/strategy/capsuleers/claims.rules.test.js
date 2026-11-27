"use strict";

const assert = require("node:assert");

const { planClaims } = require("../../../lib/strategy/capsuleers/claimRules");
const { planDispatches } = require("../../../lib/strategy/capsuleers/rattingRules");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../../../lib/strategy/data/expansion");

const R = 10000001;
const POCHVEN = EXPANSION_EXCLUDED_REGION_IDS[0];
const PARAMS = Object.freeze({ claimsEnabled: true, maxClaimsPerCorp: 2, maxClaimsPerReview: 4, claimMaxJumps: 3 });
const VERTICES = new Map([...Array.from({ length: 9 }, (_, i) => [201 + i, { secClass: "nullsec", regionId: R }]),
  [210, { secClass: "lowsec", regionId: R }], [211, { secClass: "nullsec", regionId: POCHVEN }]]);
const corp = (slot, over = {}) => ({ corpSlot: slot, state: "ACTIVE", corporationId: 98000000 + slot,
  baseSystemId: 100 + slot, ...over });
const fleet = (slot, systemId = 100 + slot) => ({ fleetId: `f${slot}-${systemId}`, corporationId: 98000000 + slot,
  currentSystemId: systemId });
const claim = (slot, systemId, over = {}) => ({ claimId: `cl:${slot}:${systemId}:1`, corpSlot: slot, systemId,
  state: "HELD", version: 1, ...over });

function snapOf(over = {}) {
  return { corps: [corp(1)], fleets: [fleet(1)], fleetsTruncated: false, held: [], heldTruncated: false,
    controllerOf: new Map(), missing: new Set(), fleetNearClaim: () => true, candidatesBySlot: new Map(),
    vertexOf: (id) => VERTICES.get(id) || null, excludedRegionIds: new Set(EXPANSION_EXCLUDED_REGION_IDS),
    round: 7, ...over };
}

const free = (...ids) => new Map(ids.map((id) => [id, null]));
const picked = (snap, params = PARAMS) => planClaims(snap, params).claims.map((c) => [c.slot, c.systemId]);

module.exports = ({ test }) => {
  test("CL1 planClaims: candidate filters, nearest / lower id, per corp + per review limits, no fleet "
    + "losses CONTROLLER / NO_FLEET / CORP_INACTIVE / NO_ROW, truncated fleets, unknown world; pirate first", () => {
    const got = {};
    const refused = [{ systemId: 201, jumps: 1 }, { systemId: 202, jumps: 1 }, { systemId: 210, jumps: 1 },
      { systemId: 211, jumps: 1 }, { systemId: 203, jumps: 1 }];
    got.refused = picked(snapOf({ corps: [corp(1), corp(2)], fleets: [fleet(1), fleet(2)],
      controllerOf: new Map([[202, 500019], [210, null], [211, null], [203, null]]), missing: new Set([201]),
      held: [claim(2, 203)], candidatesBySlot: new Map([[1, refused]]) }));
    got.nearest = picked(snapOf({ controllerOf: free(204, 205, 206, 207),
      candidatesBySlot: new Map([[1, [{ systemId: 207, jumps: 0 }, { systemId: 206, jumps: 4 },
        { systemId: 204, jumps: 2 }, { systemId: 205, jumps: 1 }]]]) }));
    got.tie = picked(snapOf({ controllerOf: free(204, 205),
      candidatesBySlot: new Map([[1, [{ systemId: 205, jumps: 1 }, { systemId: 204, jumps: 1 }]]]) }));
    const cands = new Map([[1, [{ systemId: 204, jumps: 1 }, { systemId: 205, jumps: 1 }]]]);
    got.corpFull = picked(snapOf({ controllerOf: free(204, 205, 208, 209), held: [claim(1, 208), claim(1, 209)],
      candidatesBySlot: cands }));
    got.corpRoom = picked(snapOf({ controllerOf: free(204, 205, 208), held: [claim(1, 208)], candidatesBySlot: cands }));
    const two = { corps: [corp(2), corp(1)], fleets: [fleet(1), fleet(2)], controllerOf: free(204, 205),
      candidatesBySlot: new Map([[1, [{ systemId: 204, jumps: 1 }]], [2, [{ systemId: 205, jumps: 1 }]]]) };
    got.review1 = picked(snapOf(two), { ...PARAMS, maxClaimsPerReview: 1 });
    got.review4 = picked(snapOf(two));
    got.sameSystem = picked(snapOf({ ...two,
      candidatesBySlot: new Map([[1, [{ systemId: 204, jumps: 1 }]], [2, [{ systemId: 204, jumps: 1 }]]]) }));
    got.noFleet = picked(snapOf({ fleets: [fleet(2)], controllerOf: free(204), candidatesBySlot: cands }));
    got.inactive = picked(snapOf({ corps: [corp(1, { state: "FOUNDING" })], controllerOf: free(204),
      candidatesBySlot: cands }));
    got.disabled = planClaims(snapOf({ controllerOf: free(204), candidatesBySlot: cands,
      held: [claim(1, 202)], missing: new Set([202]) }), { ...PARAMS, claimsEnabled: false });
    const lossSnap = (over) => snapOf({ corps: [corp(1), corp(2, { state: "REFUSED" })],
      held: [claim(1, 201), claim(1, 202), claim(1, 203), claim(2, 204), claim(1, 205)],
      controllerOf: new Map([[201, 500019], [202, null], [204, null], [205, null]]), missing: new Set([203]),
      fleetNearClaim: (c) => c.systemId !== 202, candidatesBySlot: cands, ...over });
    const losses = (snap) => planClaims(snap, PARAMS).losses.map((l) => [l.systemId, l.reason]);
    got.losses = losses(lossSnap({}));
    got.truncated = planClaims(lossSnap({ fleetsTruncated: true }), PARAMS);
    got.unknown = losses(lossSnap({ controllerOf: new Map(), missing: new Set(), fleetNearClaim: () => false }));
    got.heldTruncated = picked(snapOf({ controllerOf: free(204), candidatesBySlot: cands, heldTruncated: true }));
    const dispatch = (targets) => planDispatches({ corps: [{ ...corp(1), seed: 5 }],
      fleets: [{ fleetId: "f1", corporationId: 98000001, state: "IDLE", currentSystemId: 101, fleetRole: "capsuleer",
        version: 1 }], fleetsTruncated: false, openTripFleetIds: new Set(), openByTarget: new Map(),
      targetsBySlot: new Map([[1, targets]]), round: 3 }, { rattingEnabled: true, maxDispatchesPerReview: 1,
      maxHomeDispatchesPerReview: 0, rattingMaxFleetsPerSystem: 2, rattingTargetsTop: 1 })
      .map((d) => d.targetSystemId);
    got.pirateFirst = [dispatch([{ systemId: 201, jumps: 1, claim: true }, { systemId: 209, jumps: 1 }]),
      dispatch([{ systemId: 201, jumps: 1, claim: true }, { systemId: 209, jumps: 2 }]),
      dispatch([{ systemId: 201, jumps: 1, claim: true }])];

    assert.deepStrictEqual(got, {
      refused: [],
      nearest: [[1, 205]],
      tie: [[1, 204]],
      corpFull: [],
      corpRoom: [[1, 204]],
      review1: [[1, 204]],
      review4: [[1, 204], [2, 205]],
      sameSystem: [[1, 204]],
      noFleet: [],
      inactive: [],
      disabled: { losses: [], claims: [] },
      losses: [[201, "CONTROLLER"], [202, "NO_FLEET"], [203, "NO_ROW"], [204, "CORP_INACTIVE"]],
      truncated: { losses: [{ claimId: "cl:1:201:1", slot: 1, systemId: 201, expectedVersion: 1,
        reason: "CONTROLLER" }, { claimId: "cl:1:203:1", slot: 1, systemId: 203, expectedVersion: 1, reason: "NO_ROW" },
      { claimId: "cl:2:204:1", slot: 2, systemId: 204, expectedVersion: 1, reason: "CORP_INACTIVE" }], claims: [] },
      unknown: [[204, "CORP_INACTIVE"]],
      heldTruncated: [],
      pirateFirst: [[209], [209], [201]],
    });
  });
};
