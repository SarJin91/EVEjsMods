"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { readSystemInteriorFrom } = require("../../lib/adapter/systemInterior");
const { buildSystemInteriorView, assignAnchors } = require("../../lib/observer/views/systemInterior");
const { createViewRegistry } = require("../../lib/observer/views");
const { buildGalaxyView } = require("../../lib/observer/galaxyView");
const { startObserver } = require("../../lib/observer");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AU = 149597870700;
const SYS = 30000142;
const FROM = 30000144;
const fakeHttp = { createServer: () => ({ on() {}, listen() {}, unref() {}, close() {}, address: () => null }) };

function fakeWorldData(over = {}) {
  const sun = { itemID: 1, itemName: "Jita - Star", kind: "sun", groupID: 6, typeID: 3800,
    position: { x: 100, y: 0, z: 200 } };
  const p1 = { itemID: 10, itemName: "Jita I", kind: "planet", groupID: 7, typeID: 11, celestialIndex: 1,
    position: { x: 100 - 4e10, y: 0, z: 200 + 3e10 } };
  const p2 = { itemID: 20, itemName: "Jita II", groupID: 7, typeID: 11, celestialIndex: 2,
    position: { x: 100 + 1e11, y: 0, z: 200 } };
  const moonOrbit = { itemID: 11, itemName: "Jita I - Moon 1", kind: "moon", groupID: 8, orbitID: 10,
    position: { x: 100 + 1e11 + 1e8, y: 0, z: 200 } };
  const moonNear = { itemID: 21, itemName: "Jita II - Moon 1", groupID: 8, position: { x: 100 + 1e11 - 5e7, y: 0, z: 200 } };
  const other = { itemID: 99, itemName: "something", groupID: 9, position: { x: 0, y: 0, z: 0 } };
  const belt = { itemID: 30, itemName: "Jita II - Belt 1", position: { x: 100 + 1e11 + 2e8, y: 0, z: 200 } };
  const station = { stationID: 60000001, stationName: "Jita IV - Station", orbitID: 20,
    position: { x: 100 + 1e11, y: 0, z: 200 + 1e7 } };
  const gate = { itemID: 50001, itemName: "Stargate (Perimeter)", destinationSolarSystemID: FROM,
    position: { x: 100, y: 0, z: 200 - 5e11 } };
  return {
    getSolarSystemByID: (id) => (id === SYS ? { solarSystemID: SYS, solarSystemName: "Jita" } : null),
    getCelestialsForSystem: () => [p2, sun, moonOrbit, p1, moonNear, other],
    getAsteroidBeltsForSystem: () => [belt],
    getStationsForSystem: () => [station],
    getStargatesForSystem: () => [gate],
    ...over,
  };
}

function staticsOf() {
  const r = readSystemInteriorFrom(fakeWorldData(), SYS, { maxObjects: 400 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { system: r.system, objects: r.objects, truncated: r.truncated };
}

function fakeCtx(over = {}) {
  const fleets = [
    { fleetId: 7, factionId: 500001, fleetRole: "patrol", state: "IDLE", shipCount: 12 },
    { fleetId: 8, factionId: 500001, fleetRole: "mining", state: "IDLE", shipCount: 3 },
  ];
  const fleetsRepo = {
    listFleetsInSystem: () => ({ ok: true, fleets }),
    listOperationsByTarget: () => ({ ok: true, operations: [{ operationId: "op-1" }] }),
    listFleetsOfOperation: () => ({ ok: true, fleets: [{ fleetId: 9, factionId: 500010, fleetRole: "invasion",
      state: "TRAVELLING", shipCount: 30, targetSystemId: SYS,
      route: { v: 1, mode: "travel", systems: [FROM, SYS], departAt: 0, arriveAt: 60000, jumpMs: 60000,
        graphVersion: 1, observed: false } }] }),
  };
  return {
    adapter: { readSystemInterior: () => ({ ok: true, ...staticsOf() }) },
    fleets: { repository: fleetsRepo },
    battle: { repository: { summarizeInSystem: () => ({ ok: true, battles: [
      { battleId: "b-1", state: "PENDING", mode: "VIRTUAL", sides: { A: { factionId: 500010 }, B: { factionId: 500001 } } },
      { battleId: "b-0", state: "SETTLED", mode: "VIRTUAL", sides: {} }] }) } },
    stations: { repository: { listStationsInSystem: () => ({ ok: true, records: [
      { stationId: "st-1", name: "Outpost", ownerFactionId: 500001, state: "ONLINE", position: { x: 100, y: 0, z: 1200 } },
      { stationId: "st-2", name: "Depot", ownerFactionId: 500001, state: "ONLINE", position: null }] }) } },
    sites: { getStatus: () => ({ state: "unavailable" }) },
    wrecks: { repository: { countWithPoolInSystem: () => ({ ok: true, count: 2 }) } },
    salvageAnomaly: { getStatus: () => ({ state: "unavailable" }) },
    ...over,
  };
}

const SETTINGS = Object.freeze({ refreshMs: 15000, staticCacheSystems: 64, maxObjects: 400, maxFleets: 60,
  maxOperations: 8, maxBattles: 5, maxSites: 24 });

function fakeStore() {
  const store = { calls: 0, isOpen: () => true,
    transaction(name, fn) {
      store.calls += 1;
      assert.strictEqual(name, "observer.systemInterior");
      return { ok: true, value: fn({}) };
    } };
  return store;
}

function viewOf(ctx, over = {}) {
  return buildSystemInteriorView({ ctx, store: over.store || fakeStore(), clock: { now: () => 30000 },
    getGovernor: over.getGovernor || (() => null), telemetry: over.telemetry || null, nowMs: () => 0,
    factionNames: new Map([[500001, "Caldari State"]]), settings: { ...SETTINGS, ...(over.settings || {}) } });
}

function loadWeb(file, sandbox) {
  vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", file), "utf8"), sandbox, { filename: file });
  return sandbox;
}

module.exports = ({ test }) => {
  test("SI1 adapter core: kinds, top-down projection with signs, moon parents (orbitID, nearest), order, refusals", () => {
    const r = readSystemInteriorFrom(fakeWorldData(), SYS, { maxObjects: 400 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.system, { id: SYS, name: "Jita", origin: { x: 100, y: 0, z: 200 } });
    assert.deepStrictEqual(r.objects.map((o) => [o.itemId, o.kind]),
      [[1, "sun"], [10, "planet"], [20, "planet"], [50001, "gate"], [60000001, "station"], [30, "belt"], [11, "moon"],
        [21, "moon"]], "groupID 9 left out, order sun/planets/gate/station/belt/moon");
    const byId = new Map(r.objects.map((o) => [o.itemId, o]));
    assert.deepStrictEqual([byId.get(1).x, byId.get(1).y], [0, -0]);
    assert.deepStrictEqual([byId.get(10).x, byId.get(10).y], [-4e10, -3e10], "negative x kept, y = -(z - sun.z)");
    assert.strictEqual(byId.get(50001).y, 5e11);
    assert.strictEqual(byId.get(50001).toSystemId, FROM);
    assert.strictEqual(byId.get(11).parentId, 10, "orbitID wins");
    assert.strictEqual(byId.get(21).parentId, 20, "nearest planet fallback");
    assert.strictEqual(byId.get(30).parentId, 20);
    assert.strictEqual(byId.get(60000001).parentId, 20);
    assert.strictEqual(byId.get(60000001).name, "Jita IV - Station");
    const cut = readSystemInteriorFrom(fakeWorldData(), SYS, { maxObjects: 6 });
    assert.deepStrictEqual([cut.truncated, cut.objects.filter((o) => o.kind === "moon").length, cut.objects.length],
      [true, 0, 6], "moons go first");
    const drift = fakeWorldData();
    delete drift.getStargatesForSystem;
    assert.deepStrictEqual(readSystemInteriorFrom(drift, SYS, { maxObjects: 10 }),
      { ok: false, reason: "WORLD_DATA_DRIFT", detail: "getStargatesForSystem" });
    assert.deepStrictEqual(readSystemInteriorFrom(fakeWorldData(), 1, { maxObjects: 10 }),
      { ok: false, reason: "SYSTEM_UNKNOWN" });
    assert.strictEqual(readSystemInteriorFrom(fakeWorldData(), SYS, { maxObjects: 0 }).reason, "INVALID_INPUT");
    const thrown = readSystemInteriorFrom(fakeWorldData({ getCelestialsForSystem: () => { throw new Error("boom"); } }),
      SYS, { maxObjects: 10 });
    assert.deepStrictEqual(thrown, { ok: false, reason: "WORLD_DATA_DRIFT", detail: "boom" });
  });

  test("SI2 view: every section, one transaction, DoD 13 null sections, NO_SYSTEM / STORE_CLOSED / GOVERNOR_HOLD", () => {
    const store = fakeStore();
    const view = viewOf(fakeCtx(), { store });
    const d = view.getData({ param: SYS });
    assert.strictEqual(store.calls, 1);
    assert.deepStrictEqual([d.available, d.systemId, d.name, d.staticsReason, d.key], [true, SYS, "Jita", null, "k2"]);
    assert.deepStrictEqual(d.fleets.rows.map((f) => [f.fleetId, f.role, f.ships]), [[7, "patrol", 12], [8, "mining", 3]]);
    assert.deepStrictEqual(d.incoming.rows.map((f) => [f.fleetId, f.fromSystemId, f.nextSystemId, f.etaMs]),
      [[9, FROM, SYS, 30000]]);
    assert.deepStrictEqual(d.battles.map((b) => b.battleId), ["b-1"], "open battles only");
    assert.deepStrictEqual(d.stations.map((s) => s.position), [{ x: 0, y: -1000 }, null]);
    assert.deepStrictEqual([d.sites, d.salvage, d.wrecks.fields], [null, null, 2], "sites stub -> null");
    assert.deepStrictEqual(d.names, [[500001, "Caldari State"], [500010, null]]);
    assert.strictEqual(view.cacheKey(), "k2");

    const partial = viewOf(fakeCtx({ battle: undefined }), {}).getData({ param: SYS });
    assert.deepStrictEqual([partial.available, partial.battles, partial.sites, partial.fleets.rows.length],
      [true, null, null, 2], "no ctx.battle -> battles null, the rest stays");
    const emptied = viewOf(fakeCtx({ wrecks: { repository: { countWithPoolInSystem: () => ({ ok: true, count: 0 }),
      countActive: () => ({ ok: true, count: 1 }) } } }), {}).getData({ param: SYS });
    assert.strictEqual(emptied.wrecks, null, "emptied fields only -> wrecks null");

    const counts = [];
    const held = viewOf(fakeCtx(), { getGovernor: () => ({ admits: () => false }),
      telemetry: { count: (n) => counts.push(n) } });
    assert.deepStrictEqual(held.getData({ param: SYS }), { available: false, reason: "GOVERNOR_HOLD" });
    assert.strictEqual(held.cacheKey(), null);
    assert.deepStrictEqual(counts, ["observer.systemInterior.deferrals"]);
    assert.deepStrictEqual(viewOf(fakeCtx(), { store: { isOpen: () => false } }).getData({ param: SYS }),
      { available: false, reason: "STORE_CLOSED" });
    assert.deepStrictEqual(view.getData({}), { available: false, reason: "NO_SYSTEM" });
  });

  test("SI3 static cache: one adapter call per system, LRU eviction, a refusal is not cached", () => {
    const calls = [];
    const statics = staticsOf();
    const ctx = fakeCtx({ adapter: { readSystemInterior: (id) => {
      calls.push(id);
      return id === 4 ? { ok: false, reason: "WORLD_DATA_DRIFT" } : { ok: true, ...statics };
    } } });
    const counts = [];
    const view = viewOf(ctx, { settings: { staticCacheSystems: 2 }, telemetry: { count: (n) => counts.push(n) } });
    view.getData({ param: 1 });
    view.getData({ param: 1 });
    assert.deepStrictEqual(calls, [1]);
    assert.deepStrictEqual(counts, ["observer.systemInterior.staticMiss", "observer.systemInterior.staticHit"]);
    view.getData({ param: 2 });
    view.getData({ param: 3 });
    view.getData({ param: 1 });
    assert.deepStrictEqual(calls, [1, 2, 3, 1], "system 1 was evicted");
    const refused = view.getData({ param: 4 });
    assert.deepStrictEqual([refused.available, refused.statics, refused.staticsReason], [true, null, "WORLD_DATA_DRIFT"]);
    view.getData({ param: 4 });
    assert.deepStrictEqual(calls, [1, 2, 3, 1, 4, 4], "refusal not cached");
    assert.deepStrictEqual(refused.fleets.rows.map((f) => f.anchor), [{ kind: "sun", itemId: null },
      { kind: "sun", itemId: null }]);
  });

  test("SI4 anchors: mining belt, patrol gate, garrison without station, incoming gate / enroute, ENGAGED battle", () => {
    const statics = staticsOf();
    const noStation = { ...statics, objects: statics.objects.filter((o) => o.kind !== "station") };
    const objects = {
      fleets: { rows: [{ fleetId: 1, role: "mining", state: "IDLE" }, { fleetId: 2, role: "patrol", state: "IDLE" },
        { fleetId: 3, role: "garrison", state: "IDLE" }, { fleetId: 4, role: "mining", state: "ENGAGED" }],
      truncated: false },
      incoming: { rows: [{ fleetId: 5, fromSystemId: FROM, nextSystemId: SYS },
        { fleetId: 6, fromSystemId: 1, nextSystemId: 2 }], truncated: false },
      battles: [{ battleId: "b-2" }, { battleId: "b-1" }],
      stations: [{ stationId: "st", position: { x: 1, y: 1 } }, { stationId: "st-2", position: null }],
      sites: null, wrecks: { fields: 2 }, salvage: null,
    };
    const a = assignAnchors(objects, noStation, SYS);
    const [mining, patrol, garrison, engaged] = a.fleets.rows.map((f) => f.anchor);
    assert.deepStrictEqual([mining.kind, patrol, garrison], ["belt", { kind: "gate", itemId: 50001 },
      { kind: "gate", itemId: 50001 }]);
    const b1 = a.battles.find((b) => b.battleId === "b-1").anchor;
    assert.deepStrictEqual(engaged, b1, "ENGAGED -> anchor of the first open battle by battleId");
    assert.deepStrictEqual(a.wrecks.anchor, b1);
    assert.deepStrictEqual(a.incoming.rows[0].anchor, { kind: "gate", itemId: 50001 });
    const far = a.incoming.rows[1].anchor;
    assert.deepStrictEqual([far.kind, far.itemId, far.angle >= 0 && far.angle < 2 * Math.PI], ["enroute", null, true]);
    assert.deepStrictEqual([a.stations[0].anchor, a.stations[1].anchor.kind], [null, "planet"]);
    assert.deepStrictEqual(assignAnchors(objects, noStation, SYS), a, "deterministic");
    const blind = assignAnchors(objects, null, SYS);
    assert.ok([...blind.fleets.rows, ...blind.incoming.rows, ...blind.battles]
      .every((r) => r.anchor.kind === "sun" && r.anchor.itemId === null), "statics null -> sun");
  });

  test("SI5 page pure: logRadius, interiorTarget hysteresis, zoomAt zoomMax, layout, flag off", () => {
    const si = loadWeb("systemInterior.js", { window: {} }).window.LneSystemInterior._pure;
    const R = 400;
    const dMax = 10 * AU;
    const r04 = si.logRadius(0.4 * AU, dMax, R, 100);
    const r07 = si.logRadius(0.7 * AU, dMax, R, 100);
    assert.ok(r07 > r04 && r07 - r04 >= 0.1 * R, `0.4 / 0.7 AU apart: ${r04} ${r07}`);
    assert.ok(Math.abs(si.logRadius(dMax, dMax, R, 100) - R) < 1e-9, "dMax -> R");
    assert.ok(si.logRadius(5 * AU, dMax, R, 100) > si.logRadius(4 * AU, dMax, R, 100), "monotonic");
    const cfg = { zoom: 90, zoomOutPermille: 800 };
    const t = (prevId, zoomRel) => si.interiorTarget({ prevId, zoomRel, cfg, selectedOnScreenId: null,
      nearestCenterId: 7 });
    assert.deepStrictEqual([t(null, 80), t(null, 89), t(null, 90), t(7, 80), t(7, 71), t(null, 75)],
      [null, null, 7, 7, null, null]);
    assert.strictEqual(si.leaveZoom(cfg), 72);
    assert.strictEqual(si.interiorTarget({ prevId: null, zoomRel: 100, cfg, selectedOnScreenId: 3, nearestCenterId: 7 }), 3);
    const layout = si.layoutInterior({ statics: staticsOf(), fleets: { rows: [{ fleetId: 1, factionId: 500001,
      anchor: { kind: "gate", itemId: 50001 } }] }, incoming: null, battles: null, stations: null, sites: null,
    wrecks: null, salvage: null }, R, 100);
    assert.ok(layout.some((i) => i.kind === "fleet") && layout.find((i) => i.kind === "sun").sx === 0);
    assert.ok(si.tooltipLines(layout.find((i) => i.kind === "fleet"), new Map()).length >= 1);

    const g = loadWeb("galaxy.js", { window: {} }).window.LneGalaxy._pure;
    const view = { k: 1, ox: 0, oy: 0 };
    assert.deepStrictEqual(g.zoomAt(view, 1000, 0, 0, 1), g.zoomAt(view, 1000, 0, 0, 1, 80));
    assert.strictEqual(g.zoomAt(view, 1000, 0, 0, 1).k, 80);
    assert.strictEqual(g.zoomAt(view, 1e6, 0, 0, 1, 20000).k, 20000);

    const resolved = resolveConfig({ modDir: MOD_DIR, env: {} });
    const o = resolved.config.observer;
    assert.deepStrictEqual([o.systemInteriorEnabled, o.systemInteriorZoom, o.systemInteriorMaxObjects,
      o.systemInteriorStartPx, o.systemInteriorZoomMax, o.systemInteriorMoonRingPermille], [true, 90, 400, 24, 20000, 30]);
    assert.ok(!resolved.warnings.some((w) => w.includes("systemInteriorZoomMax")), "defaults: no warning");
    const low = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_OBSERVER_SYSTEM_INTERIOR_ZOOM: "500",
      EVEJS_LNE_OBSERVER_SYSTEM_INTERIOR_ZOOM_MAX: "300" } });
    assert.strictEqual(low.config.observer.systemInteriorZoomMax, 501, "Ceiling raised to entry + 1");
    assert.ok(low.warnings.some((w) => w.includes("systemInteriorZoomMax=300")), JSON.stringify(low.warnings));
    for (const enabled of [false, true]) {
      const views = createViewRegistry();
      views.registerView("galaxy-static", { title: "S", listed: false, getData: () => ({}), cacheKey: () => "k" });
      const obs = startObserver({ config: { observer: { ...o, port: 0, systemInteriorEnabled: enabled } }, ctx: {},
        views, httpApi: fakeHttp });
      assert.strictEqual(obs.ok, true, JSON.stringify(obs));
      const ui = views.getView("galaxy").getData().ui;
      assert.strictEqual(views.getView("system-interior") === null, !enabled);
      assert.deepStrictEqual(enabled ? [ui.systemInterior.zoom, ui.systemInterior.startPx, ui.systemInterior.zoomMax]
        : ui.systemInterior, enabled ? [90, 24, 20000] : null);
      obs.observer.stop();
    }
    const bare = buildGalaxyView({ views: createViewRegistry(), config: { galaxyMaxLabels: 1 } });
    assert.strictEqual(bare.getData().ui.systemInterior, null);
  });

  test("SI6 disc radius and viewport culling of orbits and objects at R ~ 1e5 px", () => {
    const win = loadWeb("systemInterior.js", { window: {} }).window.LneSystemInterior;
    const si = win._pure;
    const cfg = { zoom: 90, startPx: 24 };
    assert.deepStrictEqual([si.discRadius(90, cfg), si.discRadius(180, cfg), si.discRadius(20000, cfg)],
      [24, 48, (24 * 20000) / 90]);
    assert.strictEqual(si.circleOnScreen(400, 300, 100, 800, 600, 0), true, "small ring inside");
    assert.strictEqual(si.circleOnScreen(400, 300, 1e5, 800, 600, 0), false, "screen wholly inside the ring");
    assert.strictEqual(si.circleOnScreen(-5e4, 300, 1e3, 800, 600, 0), false, "ring wholly left of the screen");
    assert.strictEqual(si.circleOnScreen(-5e4, 300, 5e4 + 10, 800, 600, 0), true, "huge ring crossing the edge");

    const zcfg = { zoom: 90, zoomOutPermille: 800, startPx: 24 };
    const Rz = si.discRadius(5000, zcfg);
    const sunX = -1000;
    assert.strictEqual(si.pointOnScreen(sunX, 300, 800, 600, 0), false, "the sun is off screen");
    assert.strictEqual(si.discOnScreen(sunX, 300, Rz, 800, 600, 0), true, "its disc overlaps the screen");
    assert.strictEqual(si.discOnScreen(400, 300, 1e5, 800, 600, 0), true, "screen wholly inside the disc");
    assert.strictEqual(si.discOnScreen(-5e3, 300, Rz, 800, 600, 0), false, "disc wholly left of the screen");
    const pick = (prevDiscOnScreen, selectedOnScreenId, zoomRel) => si.interiorTarget({ prevId: 5, zoomRel: zoomRel || 5000,
      cfg: zcfg, selectedOnScreenId, nearestCenterId: null, prevDiscOnScreen });
    assert.strictEqual(pick(true, null), 5, "sun off screen, disc on screen -> the interior stays");
    assert.strictEqual(pick(true, 5), 5, "the selected system counts by its disc");
    assert.strictEqual(pick(false, null), null, "disc off screen, nothing near the centre -> closes");
    assert.strictEqual(si.interiorTarget({ prevId: 5, zoomRel: 5000, cfg: zcfg, selectedOnScreenId: null,
      nearestCenterId: 8, prevDiscOnScreen: false }), 8, "disc off screen -> the system near the centre");
    assert.strictEqual(pick(true, 9), 9, "a clicked system with its disc on screen wins");
    assert.strictEqual(pick(false, null, 80), null, "hysteresis band: disc off screen closes");

    const statics = staticsOf();
    const R = 1e5;
    const layout = si.layoutInterior({ statics, fleets: null, incoming: null, battles: null, stations: null,
      sites: null, wrecks: null, salvage: null }, R, 100);
    const arcs = [];
    const ctx = { beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, fillText() {},
      fillRect(...a) { arcs.push(["rect", ...a]); }, arc(x, y, r) { arcs.push(["arc", x, y, r]); } };
    win.draw(ctx, layout, { cx: 400, cy: 300, R, title: "Jita", message: null, hoverKey: null,
      colourOf: () => "#fff", viewW: 800, viewH: 600 });
    assert.ok(arcs.every((a) => a[0] !== "arc" || a[3] < 1000), `no giant arc: ${JSON.stringify(arcs)}`);
    assert.deepStrictEqual(arcs.filter((a) => a[0] === "rect"), [["rect", 0, 0, 800, 600]], "disc = one fillRect");
    assert.ok(arcs.some((a) => a[0] === "arc" && a[1] === 400 && a[2] === 300), "the sun is drawn");
    arcs.length = 0;
    win.draw(ctx, layout, { cx: 400, cy: 300, R, title: null, message: null, hoverKey: null, colourOf: () => "#fff" });
    const planets = layout.filter((i) => i.kind === "planet").length;
    assert.strictEqual(arcs.filter((a) => a[0] === "arc" && a[3] >= 1000).length, 2 + planets);
  });

  test("SI7 moon ring grows with the disc: childOffset, entry unchanged, moons / belts follow at R 1e5", () => {
    const si = loadWeb("systemInterior.js", { window: {} }).window.LneSystemInterior._pure;
    assert.strictEqual(si.childOffset(0, 1e7, 1e9, 3000), 0);
    assert.ok(Math.abs(si.childOffset(1e9, 1e7, 1e9, 3000) - 3000) < 1e-9, "dMax -> ringPx");
    assert.ok(si.childOffset(2e8, 1e7, 1e9, 3000) > si.childOffset(1e8, 1e7, 1e9, 3000), "monotonic");
    assert.ok(si.childOffset(1e7, 1e7, 1e11, 3000) > 100, "an outlier does not squash the nearest child");
    assert.strictEqual(si.childOffset(1e8, 1e7, 1e9, 0), 0, "no ring -> 0");
    const data = { statics: staticsOf(), fleets: null, incoming: null, battles: null, stations: null, sites: null,
      wrecks: null, salvage: null };
    const dist = (l, kind) => l.filter((i) => i.kind === kind).map((i) => {
      const p = l.find((x) => x.ref && x.ref.itemId === i.ref.parentId);
      return p ? Math.hypot(i.sx - p.sx, i.sy - p.sy) : null;
    });
    const at = (R, permille) => si.layoutInterior(data, R, 100, permille);
    assert.deepStrictEqual(dist(at(24, 30), "moon"), dist(at(24), "moon"), "entry: the small ring stays");
    const big = dist(at(1e5, 30), "moon");
    assert.ok(big.every((d) => d > 20 && d <= 3000 + 1e-6), `moons spread: ${big}`);
    assert.ok(Math.max(...big) > 1000, `largest child near 3 % R: ${big}`);
    const belts = dist(at(1e5, 30), "belt");
    assert.ok(belts.length > 0 && belts.every((d) => d !== null && d <= 3000 + 1e-6), `belt follows: ${belts}`);
  });

  test("SI8 MATERIALIZED fleets: object of the LIVE patrol/hunt, point, unknown -> space; tooltip", () => {
    const fleets = [{ fleetId: 7, factionId: 500001, fleetRole: "garrison", state: "MATERIALIZED", shipCount: 12 },
      { fleetId: 8, factionId: 500001, fleetRole: "patrol", state: "MATERIALIZED", shipCount: 3 },
      { fleetId: 10, factionId: 500001, fleetRole: "patrol", state: "MATERIALIZED", shipCount: 2 },
      { fleetId: 11, factionId: 500001, fleetRole: "patrol", state: "IDLE", shipCount: 2 }];
    const status = { state: "running",
      hunts: { hunts: [{ fleetId: 8, systemId: SYS, state: "LIVE", despawned: false, mode: "HUNT", phase: "SWEEP_WARP",
        object: { kind: "anomaly", itemId: 777, point: { x: 100 + 2e9, y: 0, z: 200 } } },
      { fleetId: 10, systemId: SYS, state: "LIVE", despawned: true, phase: "SWEEP_DWELL", object: null }] },
      patrols: { list: [{ fleetId: 7, systemId: SYS, state: "LIVE", despawned: false, mode: "PATROL",
        phase: "PATROL_DWELL", object: { kind: "belt", itemId: 30, point: null } },
      { fleetId: 11, systemId: FROM, state: "LIVE", despawned: false, phase: "PATROL_DWELL",
        object: { kind: "belt", itemId: 30, point: null } }] } };
    const base = fakeCtx();
    const ctx = fakeCtx({ materialization: { getStatus: () => status },
      fleets: { repository: { ...base.fleets.repository, listFleetsInSystem: () => ({ ok: true, fleets }) } } });
    const d = viewOf(ctx).getData({ param: SYS });
    const [garrison, hunt, gone, idle] = d.fleets.rows;
    assert.deepStrictEqual([garrison.anchor, garrison.live.source, garrison.live.phase, garrison.live.objectName],
      [{ kind: "belt", itemId: 30 }, "patrol", "PATROL_DWELL", "Jita II - Belt 1"], "patrol on its route object");
    assert.deepStrictEqual([hunt.anchor, hunt.position, hunt.live.phase], [null, { x: 2e9, y: -0 }, "SWEEP_WARP"],
      "object not in statics -> its projected point");
    assert.deepStrictEqual([gone.anchor, gone.live.source], [{ kind: "space", itemId: null }, null],
      "despawned entry -> no LIVE entry, not a hashed gate");
    assert.strictEqual(idle.live, undefined, "Kept for a fleet that is not MATERIALIZED");
    assert.deepStrictEqual(idle.anchor, assignAnchors({ fleets: { rows: [{ fleetId: 11, role: "patrol",
      state: "IDLE" }] } }, d.statics, SYS).fleets.rows[0].anchor);
    const off = viewOf(fakeCtx({ materialization: { getStatus: () => { throw new Error("boom"); } },
      fleets: ctx.fleets })).getData({ param: SYS });
    assert.deepStrictEqual(off.fleets.rows[0].anchor, { kind: "space", itemId: null }, "status throw -> space");
    const si = loadWeb("systemInterior.js", { window: {} }).window.LneSystemInterior._pure;
    const names = new Map();
    assert.deepStrictEqual([...si.tooltipLines({ kind: "fleet", ref: garrison }, names).slice(2)],
      ["in space · patrol: PATROL_DWELL (PATROL)", "current route target: Jita II - Belt 1"]);
    assert.deepStrictEqual([...si.tooltipLines({ kind: "fleet", ref: gone }, names).slice(2)],
      ["in space · position unknown"]);
  });
};
