"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { readGridNpcsFrom } = require("../../lib/adapter/shipTelemetry");
const { isHostileFaction } = require("../../lib/shipAi/callout");
const { createAdapter } = require("../../lib/adapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const JITA = 30000142;
const SANSHA = 500019;
const SERPENTIS = 500020;
const NPC_TYPE = 23000;
const PASSIVE = { autoAggro: false, autoAggroTargetClasses: [], autoActivateWeapons: false };

function modsOf(entities, controllers, extra) {
  const scene = { getEntityByID: (id) => entities.get(id) || null };
  return { runtime: { isSolarSystemSceneLoaded: (id) => id === JITA, scenes: new Map([[JITA, scene]]) },
    registry: { listControllersBySystem: () => controllers },
    factionKill: { resolveVictimFactionID: (e) => e.warFactionID },
    ...(extra || {}) };
}

const at = (x, more) => ({ typeID: NPC_TYPE, warFactionID: 0, position: { x, y: 0, z: 0 }, ...(more || {}) });

module.exports = ({ test }) => {
  test("GS1: passive Orca on a Sansha site -> factionId null (not hostile); the same NPC without "
    + "the overrides, with proximity aggro or with an attack order -> Sansha; an own faction stays; vendor facts", () => {
    const orca = { ownerID: 1, dungeonSiteInstanceID: 77 };
    const entities = new Map([[31, at(1, orca)], [32, at(2, orca)], [33, at(3, { ...orca, warFactionID: SERPENTIS })],
      [34, at(4, orca)], [35, at(5, orca)]]);
    const controllers = [{ entityID: 31, behaviorOverrides: { ...PASSIVE } }, { entityID: 32 },
      { entityID: 33, behaviorOverrides: { ...PASSIVE } },
      { entityID: 34, behaviorOverrides: { ...PASSIVE, proximityAggroRangeMeters: 30000 } },
      { entityID: 35, behaviorOverrides: { ...PASSIVE }, manualOrder: { type: "attack", targetID: 99 } }];
    const mods = modsOf(entities, controllers, { standing: { getOwnerFactionID: () => null },
      dungeon: { getInstanceRef: (id) => (id === 77 ? { factionID: SANSHA } : null) } });
    const read = readGridNpcsFrom(mods, JITA, { maxScan: 10 });
    assert.strictEqual(read.ok, true, JSON.stringify(read));
    assert.deepStrictEqual(read.npcs.map((n) => [n.entityId, n.factionId]),
      [[31, null], [32, SANSHA], [33, SERPENTIS], [34, SANSHA], [35, SANSHA]]);
    const M = S.shipAiModelSettingsOf({ shipAi: resolveConfig({ modDir: MOD_DIR, env: {} }).config.shipAi }).settings;
    const ctx = { pirates: new Set([SANSHA, SERPENTIS]), invaders: null, standing: () => null };
    assert.strictEqual(isHostileFaction(read.npcs[0].factionId, ctx, M), false, "the Orca is not hostile");

    const src = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    assert.ok(src("services/incursion/incursionFriendlyActors.js").includes("const PASSIVE = Object.freeze({ "
      + "autoAggro: false,"), "the incursion friendly actor is spawned with autoAggro false");
    assert.ok(src("services/dungeon/dungeonUniverseSiteService.js").includes("entry.passive === true ? "
      + "cloneValue(PASSIVE_SITE_NPC_BEHAVIOR)"), "a passive site entry");
    const npc = src("space/npc/nativeNpcService.js");
    assert.ok(npc.includes("    behaviorOverrides: normalizeBehaviorOverrides(\n"), "the controller field");
    const loop = src("space/npc/npcBehaviorLoop.js");
    const norm = loop.slice(loop.indexOf("function normalizeBehaviorOverrides(overrides) {"));
    const body = norm.slice(0, norm.indexOf("\n}\n"));
    assert.ok(body.includes("\"autoAggro\",") && body.includes("normalized[field] = overrides[field] === true;")
      && body.includes("\"proximityAggroRangeMeters\","), "autoAggro / proximityAggroRangeMeters kept");
  });

  test("GS2: 300 dormant low ids + 100 live -> the newest wave is read, not truncated; maxScan counts "
    + "live only, newest first; the lookup cap; calloutScanLookupMax through the adapter facade", () => {
    const live = new Map();
    for (let id = 301; id <= 400; id += 1) live.set(id, at(id, { warFactionID: SANSHA }));
    const all = Array.from({ length: 400 }, (_, i) => ({ entityID: i + 1 }));
    const read = readGridNpcsFrom(modsOf(live, all), JITA, { maxScan: 300 });
    assert.deepStrictEqual([read.ok, read.truncated, read.npcs.length], [true, false, 100]);
    assert.deepStrictEqual(read.npcs.slice(-3).map((n) => n.entityId), [398, 399, 400], "the wave, registry order");

    const budget = readGridNpcsFrom(modsOf(live, all), JITA, { maxScan: 5 });
    assert.deepStrictEqual([budget.truncated, budget.npcs.map((n) => n.entityId)], [true, [396, 397, 398, 399, 400]]);

    const low = new Map([[1, at(1)], [2, at(2)], [3, at(3)]]);
    const capped = readGridNpcsFrom(modsOf(low, all), JITA, { maxScan: 2 });
    assert.deepStrictEqual([capped.truncated, capped.npcs], [true, []]);
    const wide = readGridNpcsFrom(modsOf(low, all), JITA, { maxScan: 2, maxLookups: 1000 });
    assert.deepStrictEqual([wide.truncated, wide.npcs.map((n) => n.entityId)], [true, [2, 3]]);
    const floor = readGridNpcsFrom(modsOf(live, all), JITA, { maxScan: 3, maxLookups: 1 });
    assert.deepStrictEqual(floor.npcs.map((n) => n.entityId), [398, 399, 400], "the cap is at least maxScan");

    const cfg = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    assert.strictEqual(cfg.shipAi.calloutScanLookupMax, 600, "Default");
    const SRC = path.join(path.sep, "x", "server", "src");
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const m = modsOf(low, all);
    const cache = { [key("_secondary/chat/chatRuntime")]: { exports: {} },
      [key("services/chat/xmppStubServer")]: { exports: {} }, [key("space/runtime")]: { exports: m.runtime },
      [key("space/npc/npcRegistry")]: { exports: m.registry },
      [key("services/character/factionKillStandingRuntime")]: { exports: m.factionKill } };
    const facade = (config) => {
      const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} }, config });
      adapter.setServerSrc(SRC);
      return adapter.shipAiSeams().seam.sensors;
    };
    const viaConfig = facade({ ...cfg, shipAi: { ...cfg.shipAi, calloutScanLookupMax: 1000 } }).gridNpcs(JITA,
      { maxScan: 2 });
    assert.deepStrictEqual(viaConfig.npcs.map((n) => n.entityId), [2, 3], JSON.stringify(viaConfig));
    assert.deepStrictEqual(facade(undefined).gridNpcs(JITA, { maxScan: 2 }).npcs, [], "no config: 2 x maxScan");
  });
};
