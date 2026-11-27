"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { resolveConfig } = require("../../config");
const { projectTopDown } = require("../../lib/graph/galaxyProjection");
const { buildGalaxyStatic } = require("../../lib/graph/galaxyStatic");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { startGraph, decideGalaxyStaticBuild, GALAXY_BUILD } = require("../../lib/graph");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { createViewRegistry } = require("../../lib/observer/views");
const { createRouter } = require("../../lib/observer/router");
const { buildGalaxyView } = require("../../lib/observer/galaxyView");
const { startObserver } = require("../../lib/observer");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { startWorld } = require("../../lib/world");
const { rawWorld, loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const GRID = 10000;
const START_MS = 1760000000000;

function fixtureGraph() {
  const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand());
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  return read;
}

function routerFor(views) {
  return createRouter({ views, assets: {}, config: { maxResponseBytes: 1048576, refreshSeconds: 5 },
    modVersion: "t", now: () => 1, telemetry: () => null });
}

function get(router, url) {
  const r = router.route({ method: "GET", url, host: "127.0.0.1:26410" });
  return { status: r.status, json: JSON.parse(String(r.body)) };
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const fakeHttp = { createServer: () => ({ on() {}, listen() {}, unref() {}, close() {}, address: () => null }) };

module.exports = ({ test, skip }) => {
  test("G2 galaxy projection: north up, east right, longer side = grid, integers, deterministic, one point", () => {
    const pts = [{ x: 0, y: 0, z: 1.17e17 }, { x: 3e17, y: 5e15, z: 0.5e17 }, { x: -4.5e17, y: 0, z: -5.8e17 }];
    const p = projectTopDown(pts, GRID);
    assert.strictEqual(Math.min(...p.y), p.y[0], "'Jita' (largest z) is north");
    assert.strictEqual(Math.max(...p.x), p.x[1], "'Rens' (largest x) is east");
    assert.strictEqual(Math.max(p.width, p.height), GRID);
    for (const v of [...p.x, ...p.y]) assert.ok(Number.isInteger(v) && v >= 0 && v <= GRID, String(v));
    assert.deepStrictEqual(projectTopDown(pts, GRID), p, "deterministic");
    const one = projectTopDown([{ x: 5, y: 1, z: 7 }], GRID);
    assert.deepStrictEqual([one.x[0], one.y[0], one.width, one.height], [0, 0, 0, 0]);
  });

  test("G3 galaxy static: columns, k-space only, edges a<b, skipped no-position; memo + governor hold", () => {
    const built = buildUniverseGraph(fixtureGraph().map);
    const s = buildGalaxyStatic(built.graph, { gridSize: GRID });
    assert.strictEqual(s.available, true);
    assert.strictEqual(s.systems.count, 13);
    for (const col of ["id", "x", "y", "sec", "cls", "region", "name"]) {
      assert.strictEqual(s.systems[col].length, s.systems.count, col);
    }
    assert.ok(s.systems.id.every((id) => id < 31000000), "no wormhole/other");
    assert.deepStrictEqual(s.regions, [[10000001, "Alpha"], [10000002, "Beta"]]);
    assert.strictEqual(s.edges.length, 22);
    for (let e = 0; e < s.edges.length; e += 2) {
      assert.ok(s.edges[e] < s.edges[e + 1] && s.edges[e + 1] < s.systems.count, `edge ${e}`);
    }
    assert.deepStrictEqual(s.stats, { systems: 13, edges: 11, skippedNoPosition: 1, skippedEdges: 1 });
    assert.strictEqual(s.systems.sec[s.systems.id.indexOf(30000007)], 1, "round(0.05*10)");

    let admit = false;
    const views = createViewRegistry();
    const queue = [];
    const counts = {};
    const telemetry = { gauge() {}, observe() {}, count: (n) => { counts[n] = (counts[n] || 0) + 1; } };
    const service = startGraph({ config: { graph: { buildWarnMs: 250, routeCacheSize: 16, routeMaxJumps: 40 },
      observer: { galaxyEnabled: true, galaxyGridSize: GRID } }, views, telemetry, adapter: { readStaticMap: () =>
      fixtureGraph() }, defer: (fn) => { queue.push(fn); return { cancel() {} }; },
    getGovernor: () => ({ admits: () => admit }) }).graph;
    const view = views.getView("galaxy-static");
    assert.strictEqual(view.listed, false);
    assert.strictEqual(view.getData().reason, "GRAPH_NOT_READY");
    queue.shift()();
    assert.strictEqual(view.cacheKey(), null, "no memo before the first build");
    assert.strictEqual(view.getData().reason, "GOVERNOR_HOLD");
    assert.strictEqual(view.cacheKey(), null, "a hold is never cached");
    assert.strictEqual(counts["observer.galaxy.deferrals"], 1);
    admit = true;
    const first = view.getData();
    assert.deepStrictEqual([first.available, first.key], [true, `g1|topdown|${GRID}`]);
    assert.strictEqual(view.cacheKey(), first.key);
    admit = false;
    assert.strictEqual(view.getData(), first, "memo: same object, no governor call needed");
    service.stop("test");
    assert.strictEqual(views.getView("galaxy-static"), null, "unregistered on stop");
  });

  test("G9 first galaxy-static build bypasses a governor hold once; rebuild + flag off keep the hold", () => {
    const boot = (bypass) => {
      const views = createViewRegistry();
      const queue = [];
      const counts = {};
      const telemetry = { gauge() {}, observe() {}, count: (n) => { counts[n] = (counts[n] || 0) + 1; } };
      let admitsCalls = 0;
      const observer = { galaxyEnabled: true, galaxyGridSize: GRID, galaxyFirstBuildBypassesGovernor: bypass };
      const service = startGraph({ config: { graph: { buildWarnMs: 250, routeCacheSize: 16, routeMaxJumps: 40 },
        observer }, views, telemetry, adapter: { readStaticMap: () => fixtureGraph() },
      defer: (fn) => { queue.push(fn); return { cancel() {} }; },
      getGovernor: () => ({ admits: () => { admitsCalls += 1; return false; } }) }).graph;
      queue.shift()();
      return { view: views.getView("galaxy-static"), counts, service, calls: () => admitsCalls };
    };
    const on = boot(true);
    const first = on.view.getData();
    assert.deepStrictEqual([first.available, first.key], [true, `g1|topdown|${GRID}`], "built under hold");
    assert.strictEqual(on.counts["observer.galaxy.forcedFirstBuilds"], 1);
    assert.strictEqual(on.counts["observer.galaxy.deferrals"], undefined);
    const calls = on.calls();
    assert.strictEqual(on.view.getData(), first, "second call under hold: memo, no build");
    assert.strictEqual(on.calls(), calls, "memo path asks no governor");
    assert.strictEqual(on.counts["observer.galaxy.forcedFirstBuilds"], 1);
    on.service.stop("test");

    const off = boot(false);
    assert.strictEqual(off.view.getData().reason, "GOVERNOR_HOLD", "flag off: old behaviour");
    assert.strictEqual(off.counts["observer.galaxy.deferrals"], 1);
    assert.strictEqual(off.counts["observer.galaxy.forcedFirstBuilds"], undefined);
    off.service.stop("test");

    assert.deepStrictEqual([
      decideGalaxyStaticBuild({ anyMemo: true, admitted: false, firstBuildBypass: true }),
      decideGalaxyStaticBuild({ anyMemo: false, admitted: false, firstBuildBypass: true }),
      decideGalaxyStaticBuild({ anyMemo: false, admitted: false, firstBuildBypass: false }),
      decideGalaxyStaticBuild({ anyMemo: true, admitted: true, firstBuildBypass: false }),
    ], [GALAXY_BUILD.HOLD, GALAXY_BUILD.FORCED, GALAXY_BUILD.HOLD, GALAXY_BUILD.BUILD]);
    assert.strictEqual(DEFAULTS.observer.galaxyFirstBuildBypassesGovernor, true, "default on (rule 7)");
    const envOff = resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_OBSERVER_GALAXY_FIRST_BUILD_BYPASSES_GOVERNOR: "0" } });
    assert.strictEqual(envOff.config.observer.galaxyFirstBuildBypassesGovernor, false);
    assert.ok(fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8")
      .includes("EVEJS_LNE_OBSERVER_GALAXY_FIRST_BUILD_BYPASSES_GOVERNOR="), ".env.example");

    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const note = sandbox.window.LneGalaxy._pure.stateNoteOf;
    assert.deepStrictEqual([note({ available: false, reason: "GOVERNOR_HOLD" }), note({ available: true }),
      note({ available: false, reason: "STORE_CLOSED" })],
    ["state on hold (server load)", null, "state not available: STORE_CLOSED"], "Panel note");
  });

  test("G4 registry + manifest: listed:false, mapLayer rules, layers with keys, GRAPH_UNAVAILABLE, config", () => {
    const views = createViewRegistry();
    const data = { available: true };
    assert.strictEqual(views.registerView("galaxy-static", { title: "S", listed: false, getData: () => data,
      cacheKey: () => "k1" }).ok, true);
    assert.strictEqual(views.registerView("bad", { title: "B", getData: () => ({}),
      mapLayer: { kind: "marks", order: 1 } }).reason, "VIEW_DEF_INVALID");
    assert.strictEqual(views.registerView("layer-test", { title: "Test layer", listed: false, getData: () => ({}),
      cacheKey: () => "L7", mapLayer: { kind: "marks", order: 5 } }).ok, true);
    const manifest = buildGalaxyView({ views, config: { galaxyMaxLabels: 300 } });
    assert.strictEqual(views.registerView("galaxy", manifest).ok, true);
    const router = routerFor(views);
    assert.deepStrictEqual(get(router, "/api/views").json.views.map((v) => v.id), ["galaxy"]);
    assert.strictEqual(get(router, "/api/views/galaxy-static").status, 200);
    assert.deepStrictEqual(views.listMapLayers(), [{ id: "layer-test", title: "Test layer", kind: "marks", order: 5 }]);
    const m = manifest.getData();
    assert.deepStrictEqual([m.available, m.staticKey, m.stateKey, m.stateAvailable, m.ui.maxLabels],
      [true, "k1", null, false, 300]);
    assert.deepStrictEqual(m.layers, [{ id: "layer-test", title: "Test layer", kind: "marks", order: 5, key: "L7" }]);

    const bare = createViewRegistry();
    const lonely = buildGalaxyView({ views: bare, config: { galaxyMaxLabels: 1 } }).getData();
    assert.deepStrictEqual([lonely.available, lonely.reason], [false, "GRAPH_UNAVAILABLE"]);

    const o = DEFAULTS.observer;
    assert.deepStrictEqual([o.galaxyEnabled, o.galaxyGridSize, o.galaxyInfluenceTop, o.galaxyMaxLabels],
      [true, 10000, 3, 300]);
    const off = { ...o, galaxyEnabled: false, port: 0 };
    const offViews = createViewRegistry();
    const graphOff = startGraph({ config: { graph: DEFAULTS.graph, observer: off }, views: offViews,
      adapter: { readStaticMap: () => fixtureGraph() }, defer: () => ({ cancel() {} }) }).graph;
    const obs = startObserver({ config: { observer: off }, ctx: {}, views: offViews, httpApi: fakeHttp });
    assert.strictEqual(obs.ok, true, JSON.stringify(obs));
    assert.deepStrictEqual(["galaxy", "galaxy-static", "galaxy-state"].map((id) => offViews.getView(id)),
      [null, null, null]);
    obs.observer.stop();
    graphOff.stop("test");
    const onViews = createViewRegistry();
    const obsOn = startObserver({ config: { observer: { ...o, port: 0 } }, ctx: {}, views: onViews,
      httpApi: fakeHttp });
    assert.ok(onViews.getView("galaxy"), "manifest registered by the observer");
    obsOn.observer.stop();
  });

  const driver = loadDriver();
  const g5 = "G5 galaxy state: top influence desc, only world rows, cached route, new stateKey after a change";
  if (!driver.ok) skip(g5, `better-sqlite3 unavailable (${driver.detail})`);
  else {
    test(g5, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-gx-"));
      seedDbFile(driver, path.join(tmp, "world.sqlite"), { seed: 1 });
      const opened = openStore({ filePath: path.join(tmp, "world.sqlite"), openDatabase: (f) => new driver.Database(f),
        exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
        randomSeed: () => 1, migrations: MIGRATIONS });
      assert.ok(opened.ok, JSON.stringify(opened));
      const store = opened.store;
      try {
        const clock = createManualClock(START_MS);
        const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
        const settings = { ...DEFAULTS.world, seedEnabled: false };
        const views = createViewRegistry();
        const config = { enabled: true, modules: { world: { enabled: true } }, world: settings,
          observer: { ...DEFAULTS.observer, galaxyInfluenceTop: 2 } };
        const world = startWorld({ config, persistence: { ok: true, store, journal }, clock, views,
          logger: { log() {} } }).world;
        const put = (systemId, controllerFactionId, influence, key) => {
          const r = world.applyChange({ systemId, expectedVersion: 0, reason: "TEST",
            state: { securityClass: "nullsec", controllerFactionId }, influence }, key);
          assert.strictEqual(r.ok, true, JSON.stringify(r));
        };
        put(30000001, 500019, [{ factionId: 500001, influenceScore: 10 }, { factionId: 500019, influenceScore: 60 },
          { factionId: 500020, influenceScore: 30 }], "gx:1");
        put(30000002, 500020, [{ factionId: 500020, influenceScore: 50 }], "gx:2");
        manifestCheck();

        function manifestCheck() {
          const manifest = buildGalaxyView({ views, config: { galaxyMaxLabels: 1 } });
          const router = routerFor(views);
          const first = get(router, "/api/views/galaxy-state").json;
          assert.strictEqual(first.cached, false);
          const d = first.data;
          assert.strictEqual(d.available, true, JSON.stringify(d));
          assert.deepStrictEqual(d.systems.map((r) => r[0]), [30000001, 30000002], "only world rows");
          assert.deepStrictEqual(d.systems[0][3], [[500019, 60], [500020, 30]], "top 2, score desc");
          assert.deepStrictEqual(d.totals, { rows: 2, controlled: 2 });
          assert.strictEqual(get(router, "/api/views/galaxy-state").json.cached, true);
          const key = manifest.getData().stateKey;
          assert.strictEqual(key, d.key);
          put(30000003, null, [], "gx:3");
          assert.notStrictEqual(manifest.getData().stateKey, key, "change -> new stateKey");
        }

        world.stop("test");
        assert.strictEqual(views.getView("galaxy-state"), null, "unregistered on stop");
        const offViews = createViewRegistry();
        const off = startWorld({ config: { ...config, observer: { ...config.observer, galaxyEnabled: false } },
          persistence: { ok: true, store, journal }, clock, views: offViews, logger: { log() {} } }).world;
        assert.strictEqual(offViews.getView("galaxy-state"), null, "galaxyEnabled=false -> not registered");
        assert.ok(offViews.getView("control"));
        off.stop("test");
      } finally {
        store.close("test_cleanup");
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (_err) {
        }
      }
    });
  }

  test("G10 npc-sov-faction-bastions: galaxy-state bastions sorted by system, owner in names; empty when off", () => {
    const { buildGalaxyStateView } = require("../../lib/world/galaxyStateView");
    const { getCoreIndex } = require("../../lib/world/core");
    const store = { isOpen: () => true, transaction: (_label, fn) => ({ ok: true, value: fn({}) }) };
    const repository = { getChangeCount: () => 1, listSystems: () => ({ ok: true, nextAfterSystemId: null,
      systems: [{ systemId: 30001977, controllerFactionId: 500001, occupationState: "STABLE", influence: [] }] }) };
    const view = (getBastions) => buildGalaxyStateView({ store, repository, maxListLimit: 500, influenceTop: 2,
      factionNames: new Map([[500016, "Servant Sisters of EVE"]]), getBastions }).getData();
    const on = view(() => new Map([[30001978, 500016], [30001977, 500016]]));
    assert.deepStrictEqual(on.bastions, [[30001977, 500016], [30001978, 500016]]);
    assert.deepStrictEqual(on.names, [[500001, null], [500016, "Servant Sisters of EVE"]]);
    assert.deepStrictEqual(on.systems, [[30001977, 500001, "STABLE", []]], "world rows unchanged");
    const offConfig = { ...DEFAULTS, world: { ...DEFAULTS.world, npcSovBastionsEnabled: false } };
    assert.deepStrictEqual(view(() => getCoreIndex(offConfig).bastions).bastions, []);
    assert.deepStrictEqual(view(undefined).bastions, []);
    const real = view(() => getCoreIndex(DEFAULTS).bastions).bastions;
    assert.ok(real.some(([s, f]) => s === 30001977 && f === 500016) && real.length === 238);
  });

  test("G6 web/galaxy.js pure helpers: colours, fit, zoom around cursor, ingest + nearest hit", () => {
    const source = fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8");
    const sandbox = { window: {} };
    vm.runInNewContext(source, sandbox, { filename: "galaxy.js" });
    const g = sandbox.window.LneGalaxy;
    assert.strictEqual(typeof g.createPanel, "function");
    const p = g._pure;
    assert.strictEqual(p.factionColor(500019), "#9a5be0");
    assert.strictEqual(p.factionColor(500016), "#f07fa8");
    const block = /const FACTION_COLORS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source);
    assert.ok(block, "FACTION_COLORS block found");
    const colours = [...block[1].matchAll(/^\s*(\d+): "(#[0-9a-fA-F]{6})"/gm)].map((m) => m[2].toLowerCase());
    assert.ok(colours.length >= 10 && colours.includes("#f07fa8"), `colours ${colours}`);
    assert.strictEqual(new Set(colours).size, colours.length, "FACTION_COLORS has no duplicate colour");
    const noController = /const NO_CONTROLLER = "(#[0-9a-fA-F]{6})";/.exec(source);
    assert.ok(noController && !colours.includes(noController[1].toLowerCase()), "SoE colour != NO_CONTROLLER");
    assert.strictEqual(p.factionColor(500077), p.factionColor(500077), "hashed hue is stable");
    assert.match(p.factionColor(500077), /^hsl\(\d+, 65%, 58%\)$/);
    assert.deepStrictEqual([p.secColor(10), p.secColor(5), p.secColor(0), p.secColor(-4)],
      ["#2fefef", "#efef00", "#f00000", "#8a1010"]);
    assert.deepStrictEqual([p.safeColor("#AbCdEf", "x"), p.safeColor("red", "x")], ["#AbCdEf", "x"]);
    const fit = p.fitTransform(1000, 500, 800, 800);
    assert.ok(Math.abs(fit.k - 0.76) < 1e-9 && Math.abs(fit.ox - 20) < 1e-9);
    const z = p.zoomAt({ k: 1, ox: 0, oy: 0 }, 2, 100, 50, 1);
    assert.deepStrictEqual([z.k, z.ox, z.oy], [2, -100, -50], "point under the cursor stays");
    assert.strictEqual(p.zoomAt({ k: 1, ox: 0, oy: 0 }, 1000, 0, 0, 1).k, 80, "zoom max");

    const built = buildUniverseGraph(fixtureGraph().map);
    const data = { ...buildGalaxyStatic(built.graph, { gridSize: GRID }), key: "g1" };
    const st = p.ingestStatic(JSON.parse(JSON.stringify(data)));
    assert.strictEqual(st.n, 13);
    const i = st.idIndex.get(30000005);
    assert.strictEqual(p.nearest(st, st.x[i] + 3, st.y[i] - 2, 50, () => true), i);
    assert.strictEqual(p.nearest(st, st.x[i], st.y[i], 50, (j) => j !== i) === i, false, "hidden is skipped");
  });
  test("G7 obs-04 faction colour mode: mode + storage, dash, versus, factions / factionId ingest, legend", () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const p = sandbox.window.LneGalaxy._pure;
    assert.deepStrictEqual(["control", "security", "faction", "bogus", null].map((v) => p.parseColourMode(v)),
      ["control", "security", "faction", "control", "control"]);
    const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    const kept = new Map();
    const memory = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, v) };
    assert.strictEqual(p.readColourMode(throwing), "control");
    assert.strictEqual(p.readColourMode(null), "control");
    assert.strictEqual(p.writeColourMode(throwing, "faction"), false);
    assert.strictEqual(p.writeColourMode(memory, "faction"), true);
    assert.strictEqual(p.readColourMode(memory), "faction");
    assert.strictEqual(kept.get("lne.galaxy.colourMode"), "faction");
    assert.deepStrictEqual(["solid", "dashed", "dotted", "dashdot", "zigzag"].map((d) => p.dashPattern(d).join(",")),
      ["", "6,4", "1.5,3", "6,3,1.5,3", ""]);
    assert.strictEqual(p.markShape("versus"), "versus");

    const idIndex = new Map([[1, 0], [2, 1], [3, 2]]);
    const marks = p.ingestMarks({ legend: [["battle", "b", "#ff2850", "versus", null, "dashed"], ["x", "x", "#123456"]],
      items: [[1, "battle", "1v2", null, [[500001, 1], [0, 3], [500002, "2"], [500003, 2]]], [2, "x", null, null],
        [3, "battle", null, null, [[-1, 1]]]] }, idIndex);
    assert.strictEqual(marks.byIndex.get(0).factions.map((f) => f.join(":")).join(","), "500001:1,500003:2",
      "bad entries skipped");
    assert.strictEqual(marks.byIndex.get(0).dash, "dashed");
    assert.strictEqual(marks.byIndex.get(0).shape, "versus");
    assert.strictEqual(marks.byIndex.get(1).factions, null, "missing -> null");
    assert.strictEqual(marks.byIndex.get(1).dash, "solid");
    assert.strictEqual(marks.byIndex.get(2).factions, null, "no valid entry -> null");
    assert.strictEqual(marks.legend.map((l) => l[4]).join(","), "dashed,solid");
    const paths = p.ingestPaths({ legend: [["travelling", "t", "#ffb000", "solid"], ["retreating", "r", "#ff5a5a",
      "dashed"]], items: [[[1, 2], "retreating", 0.5, "3", null, 500004], [[2, 3], "travelling", 0, "1", null, -5]] },
    idIndex);
    assert.deepStrictEqual([paths.items[0].factionId, paths.items[0].dash, paths.items[0].color],
      [500004, "dashed", "#ff5a5a"]);
    assert.strictEqual(paths.items[1].factionId, null, "bad factionId -> null");
    assert.strictEqual(paths.legend[1][4], "dashed");

    const colourOf = p.factionColor;
    const parkedMark = marks.byIndex.get(0);
    assert.strictEqual(p.itemColour(parkedMark.color, parkedMark.factions, "control", colourOf), "#ff2850");
    assert.strictEqual(p.itemColour(parkedMark.color, parkedMark.factions, "security", colourOf), "#ff2850");
    assert.strictEqual(p.itemColour(parkedMark.color, parkedMark.factions, "faction", colourOf), "#4f8fe0");
    assert.strictEqual(p.itemColour("#ff5a5a", 500001, "faction", colourOf), p.factionColor(500001),
      "a fleet in flight and a parked mark of one faction share the system colour");
    assert.strictEqual(p.itemColour("#ffb000", null, "faction", colourOf), "#ffb000", "no faction -> style colour");

    const names = new Map([[500003, "Amarr Empire"]]);
    const legendRows = p.factionLegend([[500001, "Caldari State", 5], [500002, null, 9], [500001, "dup", 1]],
      [500004, 500001, 500003, 500004], names);
    assert.strictEqual(legendRows.map((r) => `${r[0]}=${r[1]}`).join("|"), "500002=faction 500002 (9 systems)"
      + "|500001=Caldari State (5 systems)|500003=Amarr Empire (fleets only)|500004=faction 500004 (fleets only)");
    assert.strictEqual(p.factionLegend(null, [], null).length, 0);
  });
  test("G8 areas ingest + layer checkbox storage (round trip, throwing storage)", () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const p = sandbox.window.LneGalaxy._pure;
    const idIndex = new Map([[1, 0], [2, 1]]);
    const a = p.ingestAreas({ names: [[500001, "Caldari State"]], areas: [
      [500001, 0, [1, 2, 99], [[0, 0, 10, 0, 10, 10, 0, 10]]],
      [500002, 1, [3], [[0, 0, 5, 0, 5, 5]]],
      [500003, 0, [2], [[0, 0, 1]]], "bad"] }, idIndex);
    assert.strictEqual(a.items.length, 2, "bad ring / entry skipped");
    assert.deepStrictEqual([a.items[0].factionId, a.items[0].sde, a.items[0].systems, a.items[0].path],
      [500001, false, 3, null]);
    assert.strictEqual(a.items[1].sde, true);
    assert.strictEqual(a.offMap, 2, "ids 99 and 3 are off the map");
    assert.strictEqual(a.byIndex.get(1).lines.join(), "Caldari State: area of 3 systems");
    assert.strictEqual(a.factions.map((f) => f.join(":")).join(","), "500001:Caldari State:1:3,500002::1:1");

    const kept = new Map();
    const memory = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, v) };
    const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    assert.strictEqual(p.readLayerEnabled(memory, "layer-territory"), true, "missing -> shown");
    assert.strictEqual(p.writeLayerEnabled(memory, "layer-territory", false), true);
    assert.strictEqual(kept.get("lne.galaxy.layer.layer-territory"), "0");
    assert.strictEqual(p.readLayerEnabled(memory, "layer-territory"), false);
    assert.strictEqual(p.writeLayerEnabled(memory, "layer-territory", true), true);
    assert.strictEqual(p.readLayerEnabled(memory, "layer-territory"), true);
    assert.strictEqual(p.readLayerEnabled(throwing, "x"), true);
    assert.strictEqual(p.writeLayerEnabled(throwing, "x", false), false);
    assert.strictEqual(p.writeLayerEnabled(null, "x", false), false);
  });
  test("T5 bars layer: ingestBars order + offMap + clamp, placeBar floors, widths per zoom, list state storage", () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const p = sandbox.window.LneGalaxy._pure;
    const idIndex = new Map([[1, 0], [2, 1], [3, 2], [4, 3], [5, 4]]);
    const bars = p.ingestBars({ maxDrawn: 96, items: [
      { systemId: 1, state: "RECON", ratio: 900, status: "COUNTDOWN" },
      { systemId: 2, state: "OCCUPIED", ratio: 100, status: "ADVANCING" },
      { systemId: 3, state: "INVASION", ratio: 300, status: "ADVANCING" },
      { systemId: 4, state: "INVASION", ratio: 700, status: "READY" },
      { systemId: 5, state: "INVASION", ratio: 5000, status: "READY" },
      { systemId: 99, state: "INVASION", ratio: 1, status: "READY" }, "bad"] }, idIndex);
    assert.deepStrictEqual(Array.from(bars.items, (i) => i.systemId), [5, 4, 3, 2, 1]);
    assert.deepStrictEqual([bars.items[0].ratio, bars.offMap, bars.maxDrawn, bars.legend.length], [1000, 1, 96, 0]);
    assert.strictEqual(bars.byIndex.get(2).systemId, 3);
    assert.strictEqual(p.ingestBars(null, idIndex).items.length, 0);

    const placed = [];
    assert.strictEqual(p.placeBar(placed, 100, 50, 24), 50);
    assert.strictEqual(p.placeBar(placed, 110, 50, 24), 43, "collision: one floor up (5 + 2)");
    assert.strictEqual(p.placeBar(placed, 90, 50, 24), 36);
    assert.strictEqual(p.placeBar(placed, 100, 50, 24), null, "three floors taken");
    assert.strictEqual(p.placeBar(placed, 200, 50, 24), 50, "free space elsewhere");
    assert.deepStrictEqual([1, 2, 5, 6, 80].map(p.barWidth), [18, 24, 24, 32, 32]);

    const kept = new Map();
    const memory = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, v) };
    assert.strictEqual(p.readOpsOpen(memory), true);
    assert.strictEqual(p.writeOpsOpen(memory, false), true);
    assert.strictEqual(kept.get("lne.galaxy.opsOpen"), "0");
    assert.strictEqual(p.readOpsOpen(memory), false);
    assert.strictEqual(p.readOpsOpen({ getItem() { throw new Error("blocked"); } }), true);
    assert.strictEqual(p.writeOpsOpen(null, true), false);
  });
};
