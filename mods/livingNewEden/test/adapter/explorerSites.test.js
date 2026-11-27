"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/highsecTrafficScene");
const { EXPLORER_READ_OPTIONS, SIGNATURE_RUNTIME_PATH, readExplorerSites } = require("../../lib/adapter/explorerSites");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const SYS = 30000144;
const OPTS = Object.freeze({ families: Object.freeze(["data", "relic"]), npcClearMeters: 150000, maxSites: 2 });

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function block(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name}`);
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end < 0 ? src.length : end);
}

const at = (x) => ({ x, y: 0, z: 0 });
const site = (siteID, family, x, extra) => ({ siteID, family, actualPosition: at(x), ...(extra || {}) });

function rig({ loaded = true } = {}) {
  const calls = [];
  const sites = [site(1, "data", 1e7), site(2, "relic", 2e7), site(3, "combat", 3e7), site(4, "wormhole", 4e7),
    site(5, "combat_hacking", 5e7), site(6, "data", 6e7), site(7, "data", 7e7), site(8, "relic", 8e7),
    { siteID: 9, family: "data", actualPosition: null, position: [0, 0, 0] },
    { siteID: 10, family: "relic", position: [9e7, 0, 0] }];
  const dynamics = new Map([
    [701, { itemID: 701, kind: "ship", session: null, operatorKind: "nativeNpc", position: at(6e7 + 1000) }],
    [702, { itemID: 702, kind: "ship", session: { characterID: 1 }, position: at(7e7 + 1000) }],
    [703, { itemID: 703, kind: "ship", session: null, operatorKind: "lneTraffic", position: at(8e7 + 1000) }],
    [704, { itemID: 704, kind: "drone", session: null, position: at(1e7 + 1000) }],
  ]);
  const scene = { dynamicEntities: dynamics, getEntityByID: (id) => dynamics.get(id) || null };
  const mods = {
    "space/runtime": { scenes: new Map([[SYS, scene]]), isSolarSystemSceneLoaded: (id) => loaded && id === SYS },
    "space/npc/nativeNpcService": { spawnNativeNpcEntityInSystem: () => ({ success: false }) },
    "space/npc/npcService": { destroyNpcControllerByEntityID: () => ({ success: true }) },
    "space/npc/nativeNpcStore": { listNativeControllersForSystem: () => [], getNativeEntity: () => null,
      upsertNativeEntity: () => ({ success: true }) },
    "space/npc/npcRuntime": { warpToPoint: () => ({ success: true }) },
    [SIGNATURE_RUNTIME_PATH]: { listSystemSignatureSites: (...args) => {
      calls.push(args);
      return sites;
    } },
  };
  const { createAdapter } = require("../../lib/adapter");
  const fakeSrc = path.join(path.sep, "fake-evejs", "src");
  const cache = {};
  for (const [rel, exports] of Object.entries(mods)) cache[path.join(fakeSrc, `${rel}.js`)] = { exports };
  const adapter = createAdapter({ moduleApi: { _cache: cache } });
  assert.strictEqual(adapter.setServerSrc(fakeSrc).ok, true);
  const tools = adapter.getHighsecTrafficScene();
  assert.strictEqual(tools.ok, true, JSON.stringify(tools));
  return { seam: tools.seam, calls };
}

module.exports = ({ test }) => {
  test("EV1 explorer site read through createAdapter: exactly allowTemplateDiscovery false, data / relic only, an NPC "
    + "ship near the site blocks, a player ship and own traffic do not, unloaded scene = no vendor call", () => {
    const r = rig();
    const read = r.seam.readExplorerSites(SYS, OPTS);
    assert.strictEqual(r.calls.length, 1);
    assert.strictEqual(r.calls[0][0], SYS);
    assert.deepStrictEqual(r.calls[0][1], { allowTemplateDiscovery: false });
    assert.deepStrictEqual(Object.keys(r.calls[0][1]), ["allowTemplateDiscovery"]);
    assert.notStrictEqual(r.calls[0][1], EXPLORER_READ_OPTIONS, "a fresh object per call");
    assert.deepStrictEqual(read, { ok: true, read: 10, npcBlocked: 1, sites: [
      { siteId: 1, family: "data", position: at(1e7) }, { siteId: 2, family: "relic", position: at(2e7) },
      { siteId: 7, family: "data", position: at(7e7) }, { siteId: 8, family: "relic", position: at(8e7) },
      { siteId: 10, family: "relic", position: at(9e7) }] });
    const relic = r.seam.readExplorerSites(SYS, { ...OPTS, families: ["relic"], maxSites: 1 });
    assert.deepStrictEqual(relic.sites.map((s) => s.siteId), [2, 8, 10]);

    const off = rig({ loaded: false });
    assert.deepStrictEqual(off.seam.readExplorerSites(SYS, OPTS), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.strictEqual(off.calls.length, 0, "no vendor call for an unloaded scene");
    for (const bad of [{ ...OPTS, families: [] }, { ...OPTS, npcClearMeters: 0 }, { ...OPTS, maxSites: 1.5 }, null]) {
      assert.deepStrictEqual(r.seam.readExplorerSites(SYS, bad), { ok: false, reason: "INVALID_INPUT" });
    }
    assert.strictEqual(r.calls.length, 2, "refused input reads nothing");
    assert.deepStrictEqual(readExplorerSites(null, {}, SYS, OPTS), { ok: false, reason: "SEAM_UNAVAILABLE" });
    assert.deepStrictEqual(readExplorerSites({ listSystemSignatureSites: () => null }, {}, SYS, OPTS),
      { ok: false, reason: "READ_FAILED", detail: "NOT_A_LIST" });
    assert.strictEqual(readExplorerSites({ listSystemSignatureSites: () => { throw new Error("x"); } }, {}, SYS, OPTS)
      .reason, "READ_FAILED");

    const sig = GAME_MODULES.find((m) => m.path === SIGNATURE_RUNTIME_PATH);
    const entry = sig.symbols.find((s) => s.name === "listSystemSignatureSites");
    assert.deepStrictEqual([entry.kind, entry.consumers], ["export", ["highsecTraffic.explorer"]]);
    assert.ok(seams.EXPLORER_METHODS.every((m) => typeof r.seam[m] === "function"));
  });

  test("EV4 vendor facts: private signatures only with characterID, template discovery creates a dungeon instance "
    + "unless false, the scene loads only on request; the explorer adapter has no state change call", () => {
    const runtime = block(readSource("services/exploration/signatures/signatureRuntime.js"), "listSystemSignatureSites");
    assert.ok(runtime.includes("...(options.characterID\n"), "private signatures behind characterID");
    assert.ok(runtime.includes("listPrivateSignatureSites(systemID, options.characterID)"));
    const provider = readSource("services/exploration/signatures/providers/sceneSignatureSiteProvider.js");
    assert.ok(provider.includes("allowTemplateDiscovery: options.allowTemplateDiscovery !== false,"));
    const enrich = block(readSource("services/dungeon/dungeonSiteAdapter.js"), "enrichSiteWithDungeonRuntime");
    const guard = enrich.indexOf("options.allowTemplateDiscovery !== false) {");
    const create = enrich.indexOf("dungeonRuntime.createInstance(");
    assert.ok(guard > 0 && create > guard, "createInstance sits behind the discovery guard");
    const sceneRt = readSource("services/exploration/signatures/providers/sceneProviderRuntime.js");
    assert.ok(block(sceneRt, "shouldLoadScene").includes("options.loadScene === true ||\n    options.materializeScene === true"));
    const resolve = block(sceneRt, "resolveScene");
    assert.ok(resolve.indexOf("if (shouldLoadScene(options)) {") < resolve.indexOf("runtime.ensureScene("));
    assert.strictEqual(resolve.split("ensureScene(").length, 2, "one ensureScene call");
    const wormhole = readSource("services/exploration/signatures/providers/wormholeSignatureProvider.js");
    assert.ok(wormhole.includes("listPairsForSystem(numericSystemID, { clone: false })"));
    const own = fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "explorerSites.js"), "utf8");
    for (const word of ["setLifecycleState", "createInstance", "ensureScene", "loadScene", "materializeScene",
      "characterID"]) {
      assert.ok(!own.includes(word), word);
    }
  });
};
