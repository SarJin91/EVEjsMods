"use strict";

const assert = require("node:assert");
const { buildTwinSpec, launchSlot, fitDigest } = require("../../lib/core/twinSpec");

const OWNER = { characterId: 90000001, corporationId: 98000001, allianceId: 99000001, warFactionId: 0 };
const HULK = {
  itemID: 1000000501, typeID: 22544, groupID: 543, categoryID: 6, itemName: "My Hulk",
  ownerID: OWNER.characterId, locationID: 1000000400, flagID: 90, singleton: 1,
  conditionState: { damage: 0.1, charge: 1, armorDamage: 0.2, shieldCharge: 0.9, incapacitated: false },
};
const FIT = [
  { itemID: 1000000601, typeID: 17482, categoryID: 7, flagID: 27, locationID: HULK.itemID, quantity: 1,
    moduleState: { online: true } },
  { itemID: 1000000602, typeID: 17482, categoryID: 7, flagID: 28, locationID: HULK.itemID, quantity: 1,
    moduleState: { online: true } },
  { itemID: 1000000603, typeID: 22542, categoryID: 7, flagID: 11, locationID: HULK.itemID, quantity: 1 },
  { itemID: 1000000604, typeID: 18066, categoryID: 8, flagID: 27, locationID: HULK.itemID, quantity: 1 },
];

function counter(start) {
  let next = start;
  return () => {
    const id = next;
    next += 1;
    return id;
  };
}

function build(fit = FIT) {
  return buildTwinSpec({
    ship: HULK, fit, owner: OWNER, skillMap: new Map([[3386, { level: 5 }]]),
    position: { x: 1, y: 2, z: 3 }, direction: { x: 0, y: 0, z: 1 }, allocId: counter(4.2e15),
  });
}

module.exports = ({ test }) => {
  test("TS1 Hulk + 3 modules + 1 charge: fresh IDs, identity, no nativeNpc/persistSpaceState", () => {
    const skillMap = new Map([[3386, { level: 5 }]]);
    const r = buildTwinSpec({
      ship: HULK, fit: FIT, owner: OWNER, skillMap,
      position: { x: 1, y: 2, z: 3 }, direction: { x: 0, y: 0, z: 1 }, allocId: counter(4.2e15),
    });
    assert.strictEqual(r.ok, true);
    const { spec, twinEntityId, syntheticToReal } = r;
    const realIds = new Set([HULK.itemID, ...FIT.map((i) => i.itemID)]);
    const newIds = [spec.itemID, ...spec.fittedItems.map((i) => i.itemID),
      ...spec.nativeCargoItems.map((i) => i.itemID)];
    for (const id of newIds) assert.ok(!realIds.has(id), `id ${id} equals a real item`);
    assert.strictEqual(new Set(newIds).size, newIds.length, "IDs unique");
    assert.strictEqual(spec.itemID, twinEntityId);
    assert.notStrictEqual(spec.itemID, 0);
    assert.strictEqual(spec.pilotCharacterID, OWNER.characterId);
    assert.strictEqual(spec.ownerID, OWNER.characterId);
    assert.strictEqual(spec.characterID, 0);
    assert.strictEqual(spec.corporationID, OWNER.corporationId);
    assert.ok(!("nativeNpc" in spec), "no nativeNpc");
    assert.ok(!("persistSpaceState" in spec), "no persistSpaceState");
    assert.strictEqual(spec.transient, true);
    assert.strictEqual(spec.typeID, HULK.typeID);
    assert.strictEqual(spec.itemName, "My Hulk");
    assert.strictEqual(spec.mode, "STOP");
    assert.strictEqual(spec.fittedItems.length, 3);
    for (const m of spec.fittedItems) assert.strictEqual(m.locationID, twinEntityId);
    assert.deepStrictEqual(spec.fittedItems.map((m) => m.flagID), [11, 27, 28]);
    const strip27 = spec.fittedItems.find((m) => m.flagID === 27);
    assert.deepStrictEqual(strip27.moduleState, { online: true });
    assert.notStrictEqual(strip27.moduleState, FIT[0].moduleState);
    assert.strictEqual(spec.nativeCargoItems.length, 1);
    assert.strictEqual(spec.nativeCargoItems[0].moduleID, strip27.itemID);
    assert.strictEqual(spec.nativeCargoItems[0].locationID, twinEntityId);
    assert.strictEqual(syntheticToReal.size, 4);
    assert.strictEqual(syntheticToReal.get(strip27.itemID), 1000000601);
    assert.strictEqual(syntheticToReal.get(spec.nativeCargoItems[0].itemID), 1000000604);
    assert.deepStrictEqual([...syntheticToReal.values()].sort(), FIT.map((i) => i.itemID).sort());
    assert.ok(spec.skillMap instanceof Map);
    assert.notStrictEqual(spec.skillMap, skillMap);
    assert.deepStrictEqual([...spec.skillMap], [...skillMap]);
    assert.deepStrictEqual(spec.conditionState, HULK.conditionState);
    assert.notStrictEqual(spec.conditionState, HULK.conditionState);
    assert.ok(!Object.prototype.hasOwnProperty.call(spec, "structureDamageBasisHP"));
    const based = buildTwinSpec({ ship: { ...HULK, structureDamageBasisHP: 4200 }, fit: FIT, owner: OWNER, skillMap,
      position: { x: 1, y: 2, z: 3 }, direction: { x: 0, y: 0, z: 1 }, allocId: counter(4.2e15) });
    assert.strictEqual(based.spec.structureDamageBasisHP, 4200);
  });

  test("TS2 fitDigest stable when the input order changes; changes with the fit", () => {
    const a = build(FIT);
    const b = build([FIT[3], FIT[1], FIT[0], FIT[2]]);
    assert.strictEqual(a.fitDigest, b.fitDigest);
    assert.match(a.fitDigest, /^[0-9a-f]{40}$/);
    assert.deepStrictEqual(b.spec.fittedItems.map((m) => m.itemID), a.spec.fittedItems.map((m) => m.itemID));
    assert.notStrictEqual(fitDigest(FIT.slice(0, 3)), a.fitDigest);
  });

  test("TS3 structural refusals: itemID 0, allocId colliding with a real ID, orphan charge", () => {
    assert.deepStrictEqual(buildTwinSpec({ ...baseInput(), ship: { ...HULK, itemID: 0 } }),
      { ok: false, reason: "BAD_SHIP" });
    assert.deepStrictEqual(buildTwinSpec({ ...baseInput(), allocId: () => HULK.itemID }),
      { ok: false, reason: "BAD_SHIP" });
    assert.deepStrictEqual(buildTwinSpec({ ...baseInput(), fit: [FIT[3]] }), { ok: false, reason: "BAD_FIT" });
    const host = { position: { x: 0, y: 0, z: 0 }, radius: 300, direction: { x: 0, y: 0, z: 2 } };
    assert.deepStrictEqual(launchSlot(host, 1, 500), launchSlot(host, 1, 500));
    const p = launchSlot(host, 0, 500).position;
    assert.strictEqual(Math.round(Math.hypot(p.x, p.y, p.z)), 800);
    assert.deepStrictEqual(launchSlot(host, 0, 500).direction, { x: 0, y: 0, z: 1 });
  });
};

function baseInput() {
  return {
    ship: HULK, fit: FIT, owner: OWNER, skillMap: new Map(),
    position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, allocId: counter(4.2e15),
  };
}
