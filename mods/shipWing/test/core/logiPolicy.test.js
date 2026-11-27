"use strict";

const assert = require("node:assert");
const { candidates, pick, allowedIds, layerPct } = require("../../lib/core/logiPolicy");

const OWNER = 90000001;
const OTHER = 90000002;
const HOST = 1000000400;

function ship(itemID, extra = {}) {
  return { itemID, kind: "ship", pilotCharacterID: OWNER, characterID: 0, conditionState: {}, ...extra };
}

module.exports = ({ test }) => {
  test("LP1 rule: host and own twin allowed; another player, another character's twin, a fleet member, an "
    + "NPC, a drone, a structure, an entity of another scene and the twin itself refused; the lowest percent below "
    + "the threshold wins, a tie -> the host, then the smaller itemID; nothing below the threshold -> no target; "
    + "remoteCapacitor -> the host only", () => {
    const twin = ship(4200000000000001);
    const host = { itemID: HOST, kind: "ship", characterID: OWNER, session: { characterID: OWNER },
      conditionState: { armorDamage: 0.2 } };
    const own = ship(4200000000000002, { conditionState: { armorDamage: 0.2 } });
    const own2 = ship(4200000000000003, { conditionState: { armorDamage: 0.5 } });
    const otherScene = ship(4200000000000004, { conditionState: { armorDamage: 0.9 } });
    const otherTwin = ship(4200000000000005, { pilotCharacterID: OTHER, conditionState: { armorDamage: 0.9 } });
    const player = { itemID: 1000000500, kind: "ship", characterID: OTHER, session: { characterID: OTHER },
      conditionState: { armorDamage: 0.9 } };
    const fleetMate = { itemID: 1000000600, kind: "ship", characterID: 90000003, fleetID: 77,
      conditionState: { armorDamage: 0.9 } };
    const npc = { itemID: 9000001, kind: "ship", nativeNpc: true, conditionState: { armorDamage: 0.9 } };
    const drone = { itemID: 9000002, kind: "drone", pilotCharacterID: OWNER, conditionState: { armorDamage: 0.9 } };
    const structure = { itemID: 9000003, kind: "structure", conditionState: { armorDamage: 0.9 } };
    const scene = new Set([twin, host, own, own2, otherTwin, player, fleetMate, npc, drone, structure]);
    const list = candidates({ twin, host, ownerCharId: OWNER, sameScene: (e) => scene.has(e),
      wingTwins: [own, own2, otherScene, otherTwin, drone, twin, own] });
    assert.deepStrictEqual(list.map((c) => [c.kind, c.entity.itemID]),
      [["host", HOST], ["twin", own.itemID], ["twin", own2.itemID]]);
    const ids = allowedIds(list);
    for (const e of [player, fleetMate, npc, drone, structure, otherScene, otherTwin, twin]) {
      assert.strictEqual(ids.has(e.itemID), false, `refused ${e.itemID}`);
    }
    assert.strictEqual(candidates({ twin, host: twin, wingTwins: [], sameScene: () => true }).length, 0,
      "the twin is never its own target");
    assert.strictEqual(candidates({ twin, host: { ...host, kind: "structure" }, wingTwins: [], sameScene: () => true })
      .length, 0, "a host that is not a ship");

    assert.deepStrictEqual(pick(list, "remoteArmor", 90).entity.itemID, own2.itemID);
    own2.conditionState.armorDamage = 0.2;
    assert.deepStrictEqual([pick(list, "remoteArmor", 90).kind, pick(list, "remoteArmor", 90).pct], ["host", 80]);
    const twinsOnly = list.filter((c) => c.kind === "twin").reverse();
    assert.strictEqual(pick(twinsOnly, "remoteArmor", 90).entity.itemID, own.itemID);
    assert.strictEqual(pick(list, "remoteArmor", 80), null);
    assert.strictEqual(pick(list, "remoteShield", 90), null, "shield full everywhere");
    own.conditionState.damage = 0.5;
    assert.strictEqual(pick(list, "remoteHull", 90).entity.itemID, own.itemID);
    own.capacitorChargeRatio = 0.1;
    host.capacitorChargeRatio = 0.5;
    assert.deepStrictEqual([pick(list, "remoteCapacitor", 90).kind, layerPct(host, "capacitor")], ["host", 50]);
    assert.strictEqual(pick(list, "remoteSensorBooster", 90), null, "unknown family");
  });
};
