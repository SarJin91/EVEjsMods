"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bsw = require("../../lib/adapter/bookmarkSiteWarp");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { buildHooks } = require("../../loader");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const CHAR = 90000001;
const SYS = 30001978;
const BOOKMARK = 900000290;
const NEAR = 41000001;
const FAR = 41000002;
const SITE_POS = Object.freeze({ x: 1.0e11, y: 2.0e9, z: -3.0e11 });

function makeWorld(opts = {}) {
  const calls = { vendor: [], ensure: [], getBookmark: [] };
  const counts = {};
  const lines = [];
  const session = { characterID: CHAR, clientID: 65450 };
  const bookmark = { bookmarkID: BOOKMARK, itemID: null, typeID: 5, locationID: SYS, ...SITE_POS, metadata: {},
    ...(opts.bookmark || {}) };
  const entities = opts.entities || [
    { itemID: FAR, signalTrackerUniverseSeededSite: true, position: { x: SITE_POS.x + 200000, y: SITE_POS.y,
      z: SITE_POS.z } },
    { itemID: 5, kind: "station", position: { ...SITE_POS } },
    { itemID: NEAR, signalTrackerUniverseSeededSite: true, position: { x: SITE_POS.x + 30000, y: SITE_POS.y,
      z: SITE_POS.z } },
  ];
  const scene = { systemID: SYS, staticEntities: entities };
  const tools = {
    getBookmarkForCharacter: (charId, id, options) => {
      calls.getBookmark.push({ charId, id, options });
      return id === BOOKMARK ? { bookmark, folder: {}, isActive: true } : null;
    },
    getSceneForSession: () => scene,
    isSessionShipWarping: () => opts.warping === true,
    ensureSiteContentsMaterialized: (s, site, options) => {
      calls.ensure.push({ scene: s, site, options });
      if (opts.ensure === "throw") throw new Error("boom");
      return opts.ensure || { success: true, data: { siteID: NEAR, alreadyMaterialized: false,
        contentSummary: { miningRocksSpawned: 6 }, miningRockEntityCount: 6 } };
    },
  };
  const original = function vendorWarp(...args) {
    calls.vendor.push({ self: this, args });
    if (opts.vendorThrows) throw opts.vendorThrows;
    return null;
  };
  const deps = {
    isEnabled: () => opts.enabled !== false,
    rangeMetersOf: () => opts.range || 300000,
    toolsOf: () => opts.tools || { ok: true, tools },
    count: (name) => { counts[name] = (counts[name] || 0) + 1; },
    logLine: (text) => lines.push(text),
  };
  const wrapped = bsw.wrapWarpForBookmarkSites(original, deps);
  return { calls, counts, lines, session, scene, wrapped, original };
}

module.exports = ({ test }) => {
  test("BSW1 happy path: a warp to a coordinate bookmark materializes the nearer universe site once, with the "
    + "options of the vendor branch item; the vendor result unchanged", () => {
    const w = makeWorld();
    const self = { service: true };
    const kwargs = { minRange: 0 };
    const r = w.wrapped.call(self, ["bookmark", BOOKMARK], w.session, kwargs);
    assert.strictEqual(r, null);
    assert.strictEqual(w.calls.vendor.length, 1);
    assert.strictEqual(w.calls.vendor[0].self, self);
    assert.deepStrictEqual(w.calls.vendor[0].args, [["bookmark", BOOKMARK], w.session, kwargs]);
    assert.deepStrictEqual(w.calls.getBookmark, [{ charId: CHAR, id: BOOKMARK, options: { requireActive: true } }]);
    assert.strictEqual(w.calls.ensure.length, 1);
    assert.strictEqual(w.calls.ensure[0].scene, w.scene);
    assert.deepStrictEqual(w.calls.ensure[0].site, { siteID: NEAR });
    assert.deepStrictEqual(w.calls.ensure[0].options, { spawnEncounters: true, broadcast: true, session: w.session });
    assert.strictEqual(w.calls.ensure[0].options.session, w.session);
    assert.deepStrictEqual(w.counts, { bookmarkWarps: 1, materialized: 1 });
    assert.deepStrictEqual(w.lines,
      [`bookmarkSiteWarp: materialized site=${NEAR} system=${SYS} rocks=6 rockEntities=6 already=false`]);
  });

  test("BSW2 a refused warp: the vendor exception passes unchanged, no materialization, no counter", () => {
    const err = new Error("WarpScrambled");
    const w = makeWorld({ vendorThrows: err });
    assert.throws(() => w.wrapped(["bookmark", BOOKMARK], w.session, {}), (e) => e === err);
    assert.deepStrictEqual([w.calls.ensure.length, w.counts, w.lines], [0, {}, []]);
  });

  test("BSW3 skips: item warp, bookmark with itemID, mission bookmark, other system, site out of range, mission "
    + "site entity, switched off -> no materialization", () => {
    const cases = [
      { name: "item", args: ["item", NEAR], counts: { skipped: 1 } },
      { name: "itemID", opts: { bookmark: { itemID: 60003760 } }, counts: { bookmarkWarps: 1, skipped: 1 } },
      { name: "mission", opts: { bookmark: { metadata: { missionInstanceID: 77 } } },
        counts: { bookmarkWarps: 1, skipped: 1 } },
      { name: "system", opts: { bookmark: { locationID: 30000142 } }, counts: { bookmarkWarps: 1, skipped: 1 } },
      { name: "range", opts: { range: 1000 }, counts: { bookmarkWarps: 1, noSite: 1 } },
      { name: "missionSite", opts: { entities: [{ itemID: NEAR, kind: "missionSite", position: { ...SITE_POS } }] },
        counts: { bookmarkWarps: 1, noSite: 1 } },
      { name: "off", opts: { enabled: false }, counts: {} },
    ];
    for (const c of cases) {
      const w = makeWorld(c.opts);
      assert.strictEqual(w.wrapped(c.args || ["bookmark", BOOKMARK], w.session, {}), null, c.name);
      assert.strictEqual(w.calls.vendor.length, 1, c.name);
      assert.strictEqual(w.calls.ensure.length, 0, c.name);
      assert.deepStrictEqual(w.counts, c.counts, c.name);
    }
    const a = { itemID: 1, signalTrackerUniverseSeededSite: true, position: { x: 10, y: 0, z: 0 } };
    const b = { itemID: 2, signalTrackerUniverseSeededSite: true, position: { x: -10, y: 0, z: 0 } };
    assert.strictEqual(bsw.findNearestUniverseSite({ staticEntities: [a, b] }, { x: 0, y: 0, z: 0 }, 100), a);
    assert.strictEqual(bsw.findNearestUniverseSite({}, { x: 0, y: 0, z: 0 }, 100), null);
    assert.strictEqual(bsw.findNearestUniverseSite({ staticEntities: [a] }, { x: "?", y: 0, z: 0 }, 100), null);
  });

  test("BSW4 robustness: ensure throws / refuses, tools unavailable -> the vendor result, no throw, counters", () => {
    const thrown = makeWorld({ ensure: "throw" });
    assert.strictEqual(thrown.wrapped(["bookmark", BOOKMARK], thrown.session, {}), null);
    assert.deepStrictEqual(thrown.counts, { bookmarkWarps: 1, failed: 1 });
    assert.ok(thrown.lines[0].startsWith("bookmarkSiteWarp: error - boom"), thrown.lines.join("\n"));

    const refused = makeWorld({ ensure: { success: false, errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED" } });
    assert.strictEqual(refused.wrapped(["bookmark", BOOKMARK], refused.session, {}), null);
    assert.deepStrictEqual(refused.counts, { bookmarkWarps: 1, refused: 1 });
    assert.deepStrictEqual(refused.lines,
      [`bookmarkSiteWarp: refused site=${NEAR} system=${SYS} - DUNGEON_INSTANCE_NOT_AUTHORIZED`]);

    const none = makeWorld({ tools: { ok: false, reason: "BOOKMARK_SITE_WARP_UNAVAILABLE" } });
    assert.strictEqual(none.wrapped(["bookmark", BOOKMARK], none.session, {}), null);
    assert.deepStrictEqual([none.counts, none.calls.ensure.length], [{ bookmarkWarps: 1, unavailable: 1 }, 0]);
  });

  test("BSW6 a bookmark warp of a ship already in warp (vendor ShipInWarp, return null): the vendor alone with the "
    + "same this/arguments, no materialization, counter inWarp", () => {
    const w = makeWorld({ warping: true });
    const self = { service: true };
    assert.strictEqual(w.wrapped.call(self, ["bookmark", BOOKMARK], w.session, {}), null);
    assert.strictEqual(w.calls.vendor.length, 1);
    assert.strictEqual(w.calls.vendor[0].self, self);
    assert.deepStrictEqual([w.calls.ensure.length, w.calls.getBookmark.length, w.counts, w.lines],
      [0, 0, { inWarp: 1 }, []]);
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const key = (rel) => path.join(found.srcDir, `${rel}.js`);
    let mode = "WARP";
    const scene = { getShipEntityForSession: () => ({ mode }) };
    const adapter = createAdapter({ moduleApi: { _cache: {
      [key(bsw.PATHS.bookmark)]: { exports: { getBookmarkForCharacter: () => null } },
      [key(bsw.PATHS.dungeonSites)]: { exports: { ensureSiteContentsMaterialized: () => null } },
      [key(bsw.PATHS.runtime)]: { exports: { getSceneForSession: () => scene } },
    } }, logger: { log() {} } });
    adapter.setServerSrc(found.srcDir);
    const tools = adapter.getBookmarkSiteWarpTools().tools;
    assert.strictEqual(tools.isSessionShipWarping({}), true);
    mode = "STOP";
    assert.strictEqual(tools.isSessionShipWarping({}), false);
    const beyonce = fs.readFileSync(path.join(found.srcDir, "services", "ship", "beyonceService.js"), "utf8");
    const early = new RegExp("if \\(this\\._isSessionShipWarping\\(session\\)\\) \\{\\s*"
      + "this\\._notifyShipInWarpRemoteMessage\\(session\\);\\s*return null;");
    assert.ok(early.test(beyonce), "vendor ShipInWarp early return");
    assert.ok(beyonce.includes("entity && entity.mode === \"WARP\""), "vendor warp test");
  });

  test("BSW5 install: flag off -> no wrap (bit for bit), a second install -> alreadyInstalled; the adapter resolves "
    + "the four seams", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const request = path.join(found.srcDir, "services", "ship", "beyonceService");
    for (const on of [true, false]) {
      const lines = [];
      const ctx = { logger: { log: (l) => lines.push(l), debug() {} }, state: {},
        loadConfig: () => ({ ok: true, config: { enabled: true,
          bookmarkSiteWarp: { enabled: on, rangeMeters: 300000, logIntervalMs: 60000 } } }) };
      const hook = buildHooks(ctx).find((h) => h.name === "bookmarkSiteWarp");
      class Service {
        Handle_CmdWarpToStuff() { return "vendor"; }
        Handle_CmdDock() { return "dock"; }
      }
      const vendor = Service.prototype.Handle_CmdWarpToStuff;
      assert.strictEqual(hook.match(request, Service), true);
      assert.strictEqual(hook.match(request, { Handle_CmdWarpToStuff() {} }), false, "not a class");
      assert.strictEqual(hook.match(path.join(found.srcDir, "space", "runtime"), Service), false);
      hook.run(Service, request, null);
      assert.strictEqual(Service.prototype.Handle_CmdWarpToStuff !== vendor, on, `wrapped=${on}`);
      assert.strictEqual(ctx.state.bookmarkSiteWarp, on ? "wrapped" : "disabled");
      assert.strictEqual(new Service().Handle_CmdWarpToStuff(["bookmark", BOOKMARK], { characterID: CHAR }), "vendor");
      assert.ok(lines.some((l) => l.startsWith(on ? "bookmarkSiteWarp: wrapped" : "bookmarkSiteWarp: disabled")),
        lines.join("\n"));
      if (on) {
        assert.deepStrictEqual(bsw.installBookmarkSiteWarp(Service, () => () => null),
          { ok: true, alreadyInstalled: true });
      }
    }
    assert.deepStrictEqual(bsw.installBookmarkSiteWarp(class {}, () => () => null),
      { ok: false, reason: "SEAM_UNAVAILABLE" });
    const frozen = class { Handle_CmdWarpToStuff() {} };
    Object.freeze(frozen.prototype);
    assert.deepStrictEqual(bsw.installBookmarkSiteWarp(frozen, () => () => null),
      { ok: false, reason: "NOT_WRITABLE" });

    const seams = GAME_MODULES.flatMap((e) => e.symbols.filter((s) => (s.consumers || []).includes("bookmarkSiteWarp"))
      .map((s) => `${e.path}.${s.name}:${s.kind}`)).sort();
    assert.deepStrictEqual(seams, [
      "services/bookmark/bookmarkRuntimeState.getBookmarkForCharacter:export",
      "services/dungeon/dungeonUniverseSiteService.ensureSiteContentsMaterialized:export",
      "services/ship/beyonceService.Handle_CmdWarpToStuff:classPrototypeMethod",
      "space/runtime.getSceneForSession:prototypeMethod",
    ]);
    const key = (rel) => path.join(found.srcDir, `${rel}.js`);
    const ensured = [];
    const sites = { ensureSiteContentsMaterialized: () => ({ success: false }) };
    const cache = {
      [key(bsw.PATHS.bookmark)]: { exports: { getBookmarkForCharacter: (c, id) => ({ bookmark: { c, id } }) } },
      [key(bsw.PATHS.dungeonSites)]: { exports: sites },
      [key(bsw.PATHS.runtime)]: { exports: { getSceneForSession: () => "scene" } },
    };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
    adapter.setServerSrc(found.srcDir);
    const got = adapter.getBookmarkSiteWarpTools();
    assert.strictEqual(got.ok, true, JSON.stringify(got));
    sites.ensureSiteContentsMaterialized = (scene, site) => { ensured.push([scene, site]); return { success: true }; };
    assert.deepStrictEqual(got.tools.ensureSiteContentsMaterialized("scene", { siteID: 1 }, {}), { success: true });
    assert.deepStrictEqual(ensured, [["scene", { siteID: 1 }]]);
    assert.deepStrictEqual(got.tools.getBookmarkForCharacter(CHAR, BOOKMARK, {}),
      { bookmark: { c: CHAR, id: BOOKMARK } });
    assert.strictEqual(got.tools.getSceneForSession({}), "scene");
    const blind = createAdapter({ moduleApi: { _cache: {} }, logger: { log() {} } });
    const refused = blind.getBookmarkSiteWarpTools();
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "BOOKMARK_SITE_WARP_UNAVAILABLE"]);
  });

  test("BSW-F vendor facts: the bookmark branch materializes only missions; a scan bookmark has no itemID; the "
    + "attach filter of universe sites", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const read = (...p) => fs.readFileSync(path.join(found.srcDir, ...p), "utf8").replace(/\r\n/g, "\n");
    const beyonce = read("services", "ship", "beyonceService.js");
    assert.ok(/^module\.exports = BeyonceService;$/m.test(beyonce), "the class is the export");
    assert.ok(beyonce.includes("\n  Handle_CmdWarpToStuff(args, session, kwargs) {\n"), "handler signature");
    const head = "} else if (warpType === \"bookmark\" && numericTarget > 0) {";
    const at = beyonce.indexOf(head);
    assert.ok(at >= 0, head);
    const end = beyonce.indexOf("\n    } else if (", at + head.length);
    assert.ok(end > at, "end of the bookmark branch");
    const branch = beyonce.slice(at, end);
    assert.ok(branch.includes("maybeMaterializeMissionBookmarkTarget"), "missions only");
    assert.ok(!branch.includes("ensureUniverseSiteContentsMaterialized("), "no universe site materialization");
    assert.ok(beyonce.includes("bookmarkRuntime.getBookmarkForCharacter(charID, bookmarkID, {"), "vendor reader");
    const state = read("services", "bookmark", "bookmarkRuntimeState.js");
    const scanAt = state.indexOf("\nfunction resolveScanBookmarkTarget(");
    assert.ok(scanAt >= 0, "resolveScanBookmarkTarget");
    const scanBody = state.slice(scanAt, state.indexOf("\nfunction ", scanAt + 1));
    assert.ok(scanBody.includes("itemID: null,"), "itemID null");
    const attach = read("space", "runtime", "universeSiteAttach.js");
    assert.ok(attach.includes("entity.signalTrackerUniverseSeededSite !== true"), "attach filter");
    const sites = read("services", "dungeon", "dungeonUniverseSiteService.js");
    assert.ok(/^ {2}ensureSiteContentsMaterialized,$/m.test(sites), "exported");
  });
};
