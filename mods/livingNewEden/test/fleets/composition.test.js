"use strict";

const assert = require("node:assert");

const { addHulls } = require("../../lib/fleets/composition");

const L = Object.freeze({ maxCompositionEntries: 8, maxShipsPerFleet: 100 });
const CARRIER = 23757;

module.exports = ({ test }) => {
  test("CR1 addHulls: {carrier, typeId 23757, 1} -> a new entry with the typeId (and +1 on the same entry); "
    + "{cruiser, typeId 1} -> FLEET_INVALID_INPUT; group entries as before", () => {
    const base = [{ hullGroup: "cruiser", typeId: null, count: 4 }];
    const r = addHulls(base, [{ hullGroup: "carrier", typeId: CARRIER, count: 1 }], L);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual([r.composition, r.shipCount, r.added, r.add], [[{ hullGroup: "carrier", typeId: CARRIER,
      count: 1 }, { hullGroup: "cruiser", typeId: null, count: 4 }], 5, 1,
    [{ hullGroup: "carrier", typeId: CARRIER, count: 1 }]]);
    const again = addHulls(r.composition, [{ hullGroup: "carrier", typeId: CARRIER, count: 1 }], L);
    assert.deepStrictEqual(again.composition[0], { hullGroup: "carrier", typeId: CARRIER, count: 2 });
    const group = addHulls(r.composition, [{ hullGroup: "carrier", count: 1 }], L);
    assert.deepStrictEqual(group.composition.map((e) => [e.hullGroup, e.typeId, e.count]),
      [["carrier", null, 1], ["carrier", CARRIER, 1], ["cruiser", null, 4]]);
    const bad = addHulls(base, [{ hullGroup: "cruiser", typeId: 1, count: 1 }], L);
    assert.deepStrictEqual(bad, { ok: false, reason: "FLEET_INVALID_INPUT", detail: "add: typeId must be null" });
    assert.deepStrictEqual(addHulls(base, [{ hullGroup: "cruiser", count: 2 }], L).composition,
      [{ hullGroup: "cruiser", typeId: null, count: 6 }]);
  });
};
