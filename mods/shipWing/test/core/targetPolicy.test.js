"use strict";

const assert = require("node:assert");
const { isAllowedTarget, TARGET_REFUSAL } = require("../../lib/core/targetPolicy");

const CONFIG = Object.freeze({ controlRangeMeters: 20000, combatEngageRangeMeters: 15000, combatAllowDrifterTargets: false });

function rat(extra = {}) {
  return { itemID: 9000001, kind: "ship", nativeNpc: true, npcEntityType: "npc", factionID: 500011, ...extra };
}

function ctx(extra = {}) {
  return { twin: { itemID: 4200000000000001 }, host: { itemID: 1000000501 }, config: CONFIG, sameScene: true,
    hostDistanceM: 5000, destroying: false, ...extra };
}

module.exports = ({ test }) => {
  test("CB1 isAllowedTarget: players, twins, drones, fighters, structures, CONCORD, drifters (flag off) -> "
    + "TARGET_NOT_NPC; other scene or beyond combatEngageRangeMeters -> TARGET_OUT_OF_RANGE; destroying or none "
    + "-> NO_TARGET; a native NPC in range -> ok", () => {
    assert.deepStrictEqual(TARGET_REFUSAL, ["NO_TARGET", "TARGET_NOT_NPC", "TARGET_OUT_OF_RANGE"]);
    const notNpc = { ok: false, reason: "TARGET_NOT_NPC" };
    const cases = [
      ["session ship", rat({ session: { characterID: 90000001 } })],
      ["player ship (pilotCharacterID)", rat({ nativeNpc: undefined, pilotCharacterID: 90000001 })],
      ["another twin (pilot > 0, no nativeNpc)", rat({ nativeNpc: undefined, pilotCharacterID: 90000002,
        characterID: 0 })],
      ["nativeNpc with a pilot", rat({ pilotCharacterID: 90000003 })],
      ["nativeNpc with characterID", rat({ characterID: 90000004 })],
      ["drone", rat({ kind: "drone" })],
      ["fighter", rat({ kind: "fighter" })],
      ["structure", rat({ kind: "structure" })],
      ["wreck", rat({ kind: "wreck" })],
      ["CONCORD", rat({ npcEntityType: "concord" })],
      ["CONCORD (case)", rat({ npcEntityType: " Concord " })],
      ["drifter (type)", rat({ npcEntityType: "drifter" })],
      ["drifter (faction 500024)", rat({ factionID: 500024 })],
      ["not nativeNpc", rat({ nativeNpc: false })],
    ];
    for (const [label, target] of cases) assert.deepStrictEqual(isAllowedTarget(target, ctx()), notNpc, label);

    const drifterOk = { ...CONFIG, combatAllowDrifterTargets: true };
    assert.deepStrictEqual(isAllowedTarget(rat({ factionID: 500024 }), ctx({ config: drifterOk })), { ok: true });
    assert.deepStrictEqual(isAllowedTarget(rat({ npcEntityType: "drifter" }), ctx({ config: drifterOk })),
      { ok: true });
    assert.deepStrictEqual(isAllowedTarget(rat({ npcEntityType: "concord" }), ctx({ config: drifterOk })), notNpc);

    const far = { ok: false, reason: "TARGET_OUT_OF_RANGE" };
    assert.deepStrictEqual(isAllowedTarget(rat(), ctx({ hostDistanceM: 20001 })), far);
    assert.deepStrictEqual(isAllowedTarget(rat(), ctx({ hostDistanceM: Infinity })), far);
    assert.deepStrictEqual(isAllowedTarget(rat(), ctx({ hostDistanceM: undefined })), far);
    assert.deepStrictEqual(isAllowedTarget(rat(), ctx({ sameScene: false, hostDistanceM: 10 })), far);
    assert.deepStrictEqual(isAllowedTarget(rat(), ctx({ hostDistanceM: 20000 })), { ok: true }, "edge = in range");
    assert.deepStrictEqual(isAllowedTarget(rat(), ctx({ hostDistanceM: 15001 })), { ok: true }, "within controlRange but beyond engageRange = ok");

    const none = { ok: false, reason: "NO_TARGET" };
    assert.deepStrictEqual(isAllowedTarget(rat(), ctx({ destroying: true })), none);
    assert.deepStrictEqual(isAllowedTarget(null, ctx()), none);
    assert.deepStrictEqual(isAllowedTarget(rat({ kind: "drone" }), ctx({ destroying: true })), none);
    assert.deepStrictEqual(isAllowedTarget(rat({ kind: "drone" }), ctx({ sameScene: false })), notNpc);

    assert.deepStrictEqual(isAllowedTarget(rat(), ctx()), { ok: true });
    assert.deepStrictEqual(isAllowedTarget(rat({ characterID: 0, pilotCharacterID: 0 }), ctx()), { ok: true });
  });

  test("CB2 NPC site structures: siteKillableStructure (owner 1, 500011) and a habitat "
    + "siteEnvironmentProp (cat 11, group 319) -> ok only with the flag, allowStructures and damageable; every "
    + "other kind, owner, category, group, pilot field, drifter -> TARGET_NOT_NPC; out of range -> "
    + "TARGET_OUT_OF_RANGE", () => {
    const config = { ...CONFIG, combatAllowNpcStructureTargets: true };
    const sctx = (extra = {}) => ctx({ config, allowStructures: true, damageable: true, ...extra });
    const killable = (extra = {}) => ({ itemID: 9500001, kind: "siteKillableStructure", typeID: 19714, groupID: 494,
      categoryID: 11, ownerID: 1, dungeonMaterializedSiteContent: true, dungeonMaterializedKillableStructure: true,
      ...extra });
    const habitat = (extra = {}) => ({ itemID: 9500002, kind: "siteEnvironmentProp", typeID: 17401, groupID: 319,
      categoryID: 11, slimCategoryID: 2, ownerID: 1, dungeonMaterializedSiteContent: true,
      dungeonMaterializedEnvironment: true, ...extra });
    const ok = { ok: true };
    const notNpc = { ok: false, reason: "TARGET_NOT_NPC" };
    assert.deepStrictEqual(isAllowedTarget(killable(), sctx()), ok, "killable, owner 1");
    assert.deepStrictEqual(isAllowedTarget(killable({ ownerID: 500011 }), sctx()), ok, "killable, faction owner");
    assert.deepStrictEqual(isAllowedTarget(habitat(), sctx()), ok, "habitat 17401");

    const refused = [
      ["flag off", habitat(), sctx({ config: { ...config, combatAllowNpcStructureTargets: false } })],
      ["no allowStructures (area/bomb)", habitat(), sctx({ allowStructures: undefined })],
      ["damageable false", habitat(), sctx({ damageable: false })],
      ["damageable absent", habitat(), sctx({ damageable: undefined })],
      ["group 306 spawn container", habitat({ groupID: 306 }), sctx()],
      ["category 2 (group 226)", habitat({ groupID: 226, categoryID: 2 }), sctx()],
      ["weather anchor", habitat({ dungeonNativeWeatherAnchor: true }), sctx()],
      ["no dungeonMaterializedSiteContent", killable({ dungeonMaterializedSiteContent: undefined }), sctx()],
      ["environment flag missing", habitat({ dungeonMaterializedEnvironment: undefined }), sctx()],
      ["owner character", killable({ ownerID: 90000001 }), sctx()],
      ["owner player corp", killable({ ownerID: 98000001 }), sctx()],
      ["owner CONCORD faction", killable({ ownerID: 500006 }), sctx()],
      ["owner CONCORD corp", killable({ ownerID: 1000125 }), sctx()],
      ["owner DED", killable({ ownerID: 1000137 }), sctx()],
      ["session", killable({ session: { characterID: 90000001 } }), sctx()],
      ["pilotCharacterID", killable({ pilotCharacterID: 90000001 }), sctx()],
      ["drifter faction (flag off)", killable({ factionID: 500024 }), sctx()],
      ...["structure", "station", "orbital", "sentryGun", "container", "wreck", "siteAccelerationGate"]
        .map((kind) => [`kind ${kind}`, killable({ kind }), sctx()]),
    ];
    for (const [label, target, c] of refused) assert.deepStrictEqual(isAllowedTarget(target, c), notNpc, label);
    assert.deepStrictEqual(isAllowedTarget(habitat(), sctx({ hostDistanceM: 20001 })),
      { ok: false, reason: "TARGET_OUT_OF_RANGE" });
  });
};
