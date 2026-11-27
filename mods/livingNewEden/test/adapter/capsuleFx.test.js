"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const cfx = require("../../lib/adapter/capsuleFx");
const liveLossHook = require("../../lib/adapter/liveLossHook");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SYS = 30000142;
const WRECK = 9100001;
const CORP = 1000125;
const MISSION_SITE = 7001;
const CAREER_SITE = 7003;

function victim(extra = {}) {
  return { kind: "ship", itemID: 41000001, typeID: 587, groupID: 25, nativeNpc: true, systemID: SYS,
    sceneKey: `solar-system:${SYS}`, position: { x: 1, y: 2, z: 3 }, radius: 40, corporationID: CORP,
    factionID: 500010, ...extra };
}

function wreck(extra = {}) {
  return { success: true, data: { wreck: { wreckID: WRECK }, shipID: 41000001 }, ...extra };
}

const DEPS = Object.freeze({ excludedFactionIds: new Set([500021, 500024, 500025]),
  isMissionInstance: (id) => id === MISSION_SITE });

module.exports = ({ test }) => {
  test("CFX1 victim classification: sources and refusals", () => {
    const sourceOf = (extra) => {
      const f = cfx.victimFactsOf(victim(extra), wreck(), DEPS);
      return f ? f.source : null;
    };
    assert.strictEqual(sourceOf({ operatorKind: "lneTraffic" }), "civilian");
    assert.strictEqual(sourceOf({ operatorKind: "lne" }), "lneFleets");
    assert.strictEqual(sourceOf({ operatorKind: "lneBounty" }), "lneFleets");
    assert.strictEqual(sourceOf({}), "rats");
    assert.strictEqual(sourceOf({ dungeonSiteInstanceID: 7002 }), "rats");
    assert.strictEqual(sourceOf({ dungeonSiteInstanceID: MISSION_SITE }), "ratsMission");

    const f = cfx.victimFactsOf(victim(), wreck(), DEPS);
    const target = victim();
    assert.deepStrictEqual({ ...cfx.victimFactsOf(target, wreck(), DEPS), victim: null }, {
      wreckId: WRECK, source: "rats", systemId: SYS, sceneKey: `solar-system:${SYS}`,
      sceneDescriptor: { sceneKey: `solar-system:${SYS}`, solarSystemID: SYS }, position: { x: 1, y: 2, z: 3 },
      radius: 40, ownerId: CORP, corporationId: CORP, allianceId: null, factionId: 500010, victim: null });
    assert.strictEqual(cfx.victimFactsOf(target, wreck(), DEPS).victim, target);
    assert.ok(f);

    const noCorp = cfx.victimFactsOf(victim({ corporationID: undefined, ownerID: 1000127 }), wreck(), DEPS);
    assert.deepStrictEqual([noCorp.ownerId, noCorp.corporationId], [1000127, null]);

    const refused = {
      session: [victim({ session: { characterID: 90000001 } }), wreck()],
      capsule: [victim({ groupID: 29 }), wreck()],
      sentry: [victim({ groupID: 383 }), wreck()],
      empireSentry: [victim({ empireSentry: true }), wreck()],
      concord: [victim({ npcEntityType: "concord" }), wreck()],
      fireShow: [victim({ npcEntityType: "fireShow", transient: true }), wreck()],
      ownCapsule: [victim({ lneCapsuleFx: true }), wreck()],
      wingCopy: [victim({ nativeNpc: false, transient: true, characterID: 0, pilotCharacterID: 90000001 }), wreck()],
      excludedFaction: [victim({ factionID: 500021 }), wreck()],
      noWreck: [victim(), { success: true, data: { shipID: 41000001 } }],
      duplicate: [victim(), wreck({ duplicate: true })],
      failed: [victim(), { success: false }],
      drone: [victim({ kind: "drone" }), wreck()],
      playerCorpOwner: [victim({ corporationID: undefined, ownerID: 90000001 }), wreck()],
    };
    for (const [name, [entity, result]] of Object.entries(refused)) {
      assert.strictEqual(cfx.victimFactsOf(entity, result, DEPS), null, name);
    }
    assert.strictEqual(cfx.classifyVictim(victim(), { success: true, data: {} }, DEPS).skip, "noWreck");
    assert.strictEqual(cfx.classifyVictim(victim({ corporationID: 0, ownerID: 5 }), wreck(), DEPS).skip, "noOwner");
    assert.strictEqual(cfx.victimFactsOf(victim({ dungeonSiteInstanceID: MISSION_SITE }), wreck(),
      { excludedFactionIds: new Set(), isMissionInstance: () => { throw new Error("x"); } }).source, "rats");
  });

  test("CFX6 career lesson site: its victims get no capsule, other dungeon victims do, unknown fails closed", () => {
    const summaries = new Map([[CAREER_SITE, { sourceDungeonID: 4169, siteKind: "mission" }],
      [MISSION_SITE, { sourceDungeonID: 2023, siteKind: "mission" }]]);
    const runtime = { getInstanceSummary: (id) => summaries.get(id) || null };
    const isCareer = cfx.isCareerLessonInstanceFrom(() => ({ ok: true, exports: runtime }));
    assert.deepStrictEqual([isCareer(CAREER_SITE), isCareer(MISSION_SITE), isCareer(9999)], [true, false, false]);
    assert.strictEqual(cfx.isCareerLessonInstanceFrom(() => ({ ok: false }))(MISSION_SITE), true);
    const deps = { ...DEPS, isCareerLessonInstance: isCareer };
    const skipOf = (extra, d = deps) => cfx.classifyVictim(victim(extra), wreck(), d).skip || null;
    assert.strictEqual(skipOf({ dungeonSiteInstanceID: CAREER_SITE }), "careerLesson");
    assert.strictEqual(skipOf({ dungeonCurrentInstanceID: CAREER_SITE }), "careerLesson");
    assert.strictEqual(skipOf({ dungeonSiteInstanceID: MISSION_SITE }), null);
    assert.strictEqual(skipOf({}), null);
    assert.strictEqual(skipOf({ dungeonSiteInstanceID: MISSION_SITE },
      { ...DEPS, isCareerLessonInstance: () => { throw new Error("x"); } }), "careerLesson");
    assert.strictEqual(skipOf({}, { ...DEPS, isCareerLessonInstance: () => { throw new Error("x"); } }), null);
  });

  test("CFX5 game modules: capsuleFx seams resolve through createAdapter, the wreck listener hands facts", () => {
    const seams = GAME_MODULES.flatMap((e) => e.symbols.filter((s) => (s.consumers || []).includes(cfx.CONSUMER))
      .map((s) => `${e.path}.${s.name}:${s.kind}`)).sort();
    assert.deepStrictEqual(seams, [
      "services/dungeon/dungeonRuntime.getInstanceSummary:export",
      "space/FireShow/showIdentity.isFireShowShip:export",
      "space/combat/killmailTracker.enqueueKillmailFromDestruction:export",
      "space/combat/killmailTracker.recordKillmailFromDestruction:export",
      "space/destiny/identity/interactionScope.buildChildEntityScopeMetadata:export",
      "space/destiny/identity/interactionScope.canEntitiesInteractLocally:export",
      "space/npc/nativeNpcStore.allocateEntityID:export",
      "space/runtime.getSceneByDescriptor:prototypeMethod",
      "space/runtime.scenes:property",
      "space/runtime.spawnDynamicShip:prototypeMethod",
    ]);
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const key = (rel) => path.join(found.srcDir, `${rel}.js`);
    const killmails = { recordKillmailFromDestruction: () => ({ killID: 1 }),
      enqueueKillmailFromDestruction: () => null };
    assert.strictEqual(liveLossHook.install(killmails).ok, true);
    const cache = {
      [key("space/runtime")]: { exports: { scenes: new Map(), spawnDynamicShip: () => null,
        getSceneByDescriptor: () => null } },
      [key("space/npc/nativeNpcStore")]: { exports: { allocateEntityID: () => ({ success: true, data: 1 }) } },
      [key("space/destiny/identity/interactionScope")]: { exports: { buildChildEntityScopeMetadata: () => ({}),
        canEntitiesInteractLocally: () => true } },
      [key("space/FireShow/showIdentity")]: { exports: { isFireShowShip: () => true } },
      [key("services/dungeon/dungeonRuntime")]: { exports: {
        getInstanceSummary: (id) => (id === MISSION_SITE ? { siteKind: "Mission" }
          : { siteKind: "anomaly", sourceDungeonID: id === CAREER_SITE ? 4178 : 1 }) } },
      [key("space/combat/killmailTracker")]: { exports: killmails },
    };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
    adapter.setServerSrc(found.srcDir);
    const got = adapter.getCapsuleFxScene();
    assert.strictEqual(got.ok, true, JSON.stringify(got));
    assert.strictEqual(adapter.getCapsuleFxScene().seam, got.seam, "one seam per adapter");
    const facts = [];
    const skips = [];
    const added = adapter.addNpcWreckListener((f) => facts.push(f),
      { excludedFactionIds: new Set([500021]), onSkip: (r) => skips.push(r) });
    assert.strictEqual(added.ok, true, JSON.stringify(added));
    try {
      killmails.recordKillmailFromDestruction(victim({ dungeonSiteInstanceID: MISSION_SITE }), wreck(), {});
      killmails.enqueueKillmailFromDestruction(victim({ factionID: 500021 }), wreck(), {});
      killmails.recordKillmailFromDestruction(victim(), { success: true, data: {} }, {});
      killmails.recordKillmailFromDestruction(victim({ dungeonSiteInstanceID: CAREER_SITE }), wreck(), {});
    } finally {
      assert.strictEqual(added.remove(), true);
    }
    assert.deepStrictEqual(facts.map((f) => [f.wreckId, f.source]), [[WRECK, "ratsMission"]]);
    assert.deepStrictEqual(skips, ["excludedFaction", "noWreck", "careerLesson"]);
    assert.deepStrictEqual(adapter.addNpcWreckListener(null), { ok: false, reason: "LISTENER_INVALID" });
    const blind = createAdapter({ moduleApi: { _cache: {} }, logger: { log() {} } });
    blind.setServerSrc(found.srcDir);
    assert.strictEqual(blind.getCapsuleFxScene().ok, false);
    assert.strictEqual(blind.addNpcWreckListener(() => {}).ok, false);
  });
};
