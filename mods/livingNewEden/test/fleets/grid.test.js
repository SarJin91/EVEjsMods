"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { createViewRegistry } = require("../../lib/observer/views");
const { clusterAnchors, controlPointOf } = require("../../lib/fleets/grid/anchors");
const { entryOf } = require("../../lib/fleets/grid/entry");
const { gridPositionAt } = require("../../lib/fleets/grid/position");
const { createGrid } = require("../../lib/fleets/grid");
const { readGridAnchorsFrom } = require("../../lib/adapter/gridAnchors");
const { createAdapter } = require("../../lib/adapter");
const { readSystemInteriorFrom } = require("../../lib/adapter/systemInterior");
const { assignAnchors } = require("../../lib/observer/views/systemInterior");

const { S, FACTION_A } = H;
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const AU = 149597870700;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const GATE_TO_L1 = 50001001;
const GATE_TO_N5 = 50001002;
const GRID_ON = Object.freeze({ enabled: true, contactRangeM: 250000, maxAnchorsPerSystem: 64, anchorCacheSystems: 16,
  dynamicAnchorTtlMs: 300000, visitPurgePerWrite: 4, maxPositionsPerCall: 256, movesEnabled: false,
  maxMovesPerVisit: 4, workTargetScanFleets: 8, moveArrivalMaxPerPass: 64 });
const FACADE_METHODS = ["addGridArrivalListener", "addWorkTargetOverride", "getStatus", "isEnabled", "moveGroupInTx",
  "moveInTx", "movesEnabled", "placeInTx", "positionsOf", "readSystemGrid"];

const anchor = (kind, id, position, extra = {}) => ({ kind, id, position, toSystemId: null, lneStationId: null,
  lneSovStructureId: null, ownerCorpId: null, ...extra });
const at = (x) => ({ x, y: 0, z: 0 });

function fakeAdapter(over = {}) {
  const calls = [];
  return { calls, readGridAnchors(systemId, opts) {
    calls.push([systemId, opts]);
    if (over.refuse) return { ok: false, reason: "GRID_ANCHORS_UNAVAILABLE", detail: "fake" };
    const gates = systemId === S.L2 ? [anchor("gate", GATE_TO_L1, at(0), { toSystemId: S.L1 }),
      anchor("gate", GATE_TO_N5, at(AU), { toSystemId: S.N5 })] : [];
    return { ok: true, anchors: over.dropL1 ? gates.filter((g) => g.id !== GATE_TO_L1) : gates, truncated: false };
  } };
}

function fakeTelemetry() {
  const counts = new Map();
  return { counts, count(name, n) { counts.set(name, (counts.get(name) || 0) + n); }, observe() {}, gauge() {} };
}

function bootGrid(opened, shared, grid, adapter, telemetry) {
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const rows = { max: 0 };
  const store = { ...opened.store, transaction(name, fn) {
    const r = opened.store.transaction(name, fn);
    if (r && Number.isSafeInteger(r.rows)) rows.max = Math.max(rows.max, r.rows);
    return r;
  } };
  const config = { ...H.CONFIG, grid };
  const sr = startScheduler({ config, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const fr = startFleets({ config, persistence: { ok: true, store, journal, worldSeed: opened.worldSeed },
    clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler, telemetry,
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry(),
    adapter });
  assert.ok(fr.ok, JSON.stringify(fr));
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, tx, rows, config };
}

async function flyToL2(env, shared, tag) {
  const fleetId = H.newFleet(env, tag, FACTION_A, COMP, S.N5);
  const op = env.fleets.createOperation({ operationType: "patrol", factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.L2, objective: "patrol", dueAt: null, fleets: [{ fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const p = env.fleets.planTravel({ fleetId, targetSystemId: S.L2 }, `${tag}:plan`);
  assert.ok(p.ok, JSON.stringify(p));
  const leg = env.tx((db) => env.fleets.repository.getFleet(db, fleetId)).fleet.route;
  assert.deepStrictEqual(leg.systems, [S.N0, S.L1, S.L2]);
  shared.clock.set(leg.arriveAt + 1);
  for (let i = 0; i < 8; i += 1) {
    const r = await env.scheduler.runPass();
    assert.ok(r.ok, JSON.stringify(r));
    if (r.jobs === 0) break;
  }
  const f = env.tx((db) => env.fleets.repository.getFleet(db, fleetId)).fleet;
  assert.deepStrictEqual([f.state, f.currentSystemId], ["STAGED", S.L2]);
  return f;
}

const visitRows = (env) => env.tx((db) => db.prepare("SELECT fleet_id, system_id, leg_seq, entered_via, "
  + "entry_from_system_id, version FROM world_fleet_grid_visits ORDER BY fleet_id").all())
  .map((r) => ({ ...r, system_id: Number(r.system_id), leg_seq: Number(r.leg_seq),
    entry_from_system_id: r.entry_from_system_id === null ? null : Number(r.entry_from_system_id),
    version: Number(r.version) }));

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function exportsOf(src, marker = "module.exports = {") {
  const start = src.lastIndexOf(marker);
  assert.ok(start >= 0, "module.exports literal");
  const body = src.slice(start, src.indexOf("};", start));
  return new Set([...body.matchAll(/^\s+([A-Za-z_$][\w$]*),?\s*$/gm)].map((m) => m[1]));
}

const sysOf = (anchors, systemId) => {
  const { gridOf } = clusterAnchors(anchors, 250000);
  return { systemId, anchors, byRef: new Map(anchors.map((a) => [`${a.kind}:${a.id}`, a])), gridOf,
    cp: controlPointOf(anchors, systemId) };
};

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("G1 grid pure: clusterAnchors, controlPointOf, entryOf", () => {
    const a = anchor("gate", 101, at(0));
    const b = anchor("gate", 102, at(AU));
    const near = anchor("structure", 7, at(100000));
    const far = anchor("structure", 8, at(-300000));
    const c = clusterAnchors([far, b, near, a], 250000);
    assert.deepStrictEqual(c.grids.map((g) => [g.gridKey, g.anchors.map((x) => `${x.kind}:${x.id}`)]),
      [["gate:101", ["gate:101", "structure:7"]], ["gate:102", ["gate:102"]], ["structure:8", ["structure:8"]]]);
    assert.strictEqual(c.gridOf.get("structure:7"), "gate:101");
    assert.strictEqual(clusterAnchors([anchor("belt", 3, null), a], 250000).grids.length, 2, "no position = own grid");

    const lne = anchor("structure", 900, at(5), { lneStationId: "st-1" });
    const tcu = anchor("structure", 800, at(6), { lneSovStructureId: "sov-1" });
    const st1 = anchor("station", 60000002, at(1));
    const st2 = anchor("station", 60000001, at(2));
    assert.strictEqual(controlPointOf([b, st1, tcu, lne, st2], 1).id, 900, "LNE station first");
    assert.strictEqual(controlPointOf([b, st1, tcu, st2], 1).id, 60000001, "NPC station, smallest id");
    assert.strictEqual(controlPointOf([b, tcu], 1).id, 800, "TCU before the gates");
    assert.strictEqual(controlPointOf([b, a], 1).id, 101, "smallest gate");
    assert.deepStrictEqual([controlPointOf([], 42).kind, controlPointOf([], 42).id], ["system", 42]);

    const leg = { v: 1, mode: "travel", systems: [S.N0, S.L1, S.L2], departAt: 0, jumpMs: 1000, arriveAt: 2000,
      graphVersion: 1, observed: false };
    assert.deepStrictEqual({ ...entryOf(leg, S.L2) }, { via: "GATE", fromSystemId: S.L1 });
    assert.deepStrictEqual({ ...entryOf(leg, S.L1, 1) }, { via: "GATE", fromSystemId: S.N0 });
    const wh = { ...leg, v: 2, constraints: { wormholes: true }, wormholeEdges: [{ i: 1, pairKey: "wh:x",
      expiresAt: 9999 }] };
    assert.deepStrictEqual({ ...entryOf(wh, S.L2) }, { via: "WORMHOLE", fromSystemId: S.L1 });
    assert.deepStrictEqual({ ...entryOf(leg, S.N0) }, { via: "NONE", fromSystemId: null });
    assert.deepStrictEqual({ ...entryOf(null, S.N0) }, { via: "NONE", fromSystemId: null });
  });

  needsDriver("G2 grid arrival: one visit (C, legSeq, GATE, B), positionsOf on the gate C->B, the replay keeps "
    + "the version, rows within maxRowsPerTransaction, off = zero rows", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const telemetry = fakeTelemetry();
      const adapter = fakeAdapter();
      const env = bootGrid(reopen(), shared, GRID_ON, adapter, telemetry);
      const heard = [];
      env.fleets.travel.addArrivalListener((tx, a) => {
        heard.push(a);
        assert.strictEqual(Number(tx.prepare("SELECT count(*) AS n FROM world_fleet_grid_visits WHERE fleet_id = ?")
          .get(a.fleetId).n), 1);
      });
      const f = await flyToL2(env, shared, "g2a");
      assert.deepStrictEqual(visitRows(env), [{ fleet_id: f.fleetId, system_id: S.L2, leg_seq: f.legSeq,
        entered_via: "GATE", entry_from_system_id: S.L1, version: 1 }]);
      assert.deepStrictEqual({ ...heard[0].entry }, { via: "GATE", fromSystemId: S.L1 });
      assert.ok(env.rows.max <= env.store.limits.maxRowsPerTransaction, `rows ${env.rows.max}`);
      assert.strictEqual(telemetry.counts.get("fleets.grid.visitsWritten"), 1);

      const pos = env.tx((db) => env.fleets.grid.positionsOf(db, S.L2, [f], shared.clock.now()));
      assert.strictEqual(pos.ok, true, JSON.stringify(pos));
      assert.strictEqual(pos.anchorsReason, null);
      const p = pos.positions.get(f.fleetId);
      assert.deepStrictEqual([p.kind, p.anchorKind, p.anchorId, p.gridKey, p.source],
        ["anchor", "gate", GATE_TO_L1, `gate:${GATE_TO_L1}`, "ENTRY"]);

      const again = createGrid({ config: env.config, adapter, clock: shared.clock, telemetry });
      assert.deepStrictEqual(env.tx((db) => again.recorder.recordArrivalInTx(db, heard[0])), { ok: true,
        written: false });
      assert.strictEqual(visitRows(env)[0].version, 1);
      assert.strictEqual(telemetry.counts.get("fleets.grid.visitsDuplicate"), 1);
    }).then(() => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootGrid(reopen(), shared, { ...GRID_ON, enabled: false }, fakeAdapter(), fakeTelemetry());
      await flyToL2(env, shared, "g2off");
      assert.deepStrictEqual(visitRows(env), [], "grid.enabled=false writes no visit");
      assert.deepStrictEqual(env.tx((db) => env.fleets.grid.positionsOf(db, S.L2, [], 0)),
        { ok: false, reason: "GRID_OFF" });
    })));

  needsDriver("G3 grid validity: other leg_seq CP, REFIT, WORMHOLE CP, gone gate GONE, adapter refusal CP "
    + "system:<id>, purge of an invalid visit", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const telemetry = fakeTelemetry();
      const env = bootGrid(reopen(), shared, GRID_ON, fakeAdapter(), telemetry);
      env.tx((db) => db.prepare("INSERT INTO world_fleet_grid_visits (fleet_id, system_id, leg_seq, arrived_at, "
        + "entered_via, entry_from_system_id, updated_at, version) VALUES ('ghost', ?, 0, 0, 'NONE', NULL, 0, 1)")
        .run(S.L2));
      const f = await flyToL2(env, shared, "g3a");
      assert.deepStrictEqual(visitRows(env).map((r) => r.fleet_id), [f.fleetId], "ghost purged");
      assert.strictEqual(telemetry.counts.get("fleets.grid.visitsPurged"), 1);

      const now = shared.clock.now();
      const visit = env.tx((db) => require("../../lib/fleets/grid/visitRepository").getManyInTx(db, [f.fleetId]))
        .visits.get(f.fleetId);
      const sys = sysOf([anchor("gate", GATE_TO_L1, at(0), { toSystemId: S.L1 }),
        anchor("gate", GATE_TO_N5, at(AU), { toSystemId: S.N5 })], S.L2);
      assert.strictEqual(gridPositionAt(f, visit, now, sys).source, "ENTRY");
      const cp = gridPositionAt({ ...f, legSeq: f.legSeq + 1 }, visit, now, sys);
      assert.deepStrictEqual([cp.source, cp.anchorId], ["CP", GATE_TO_L1], "CP = smallest gate here");
      assert.strictEqual(gridPositionAt({ ...f, state: "REFITTING" }, visit, now, sys).source, "REFIT");
      const wh = gridPositionAt(f, { ...visit, enteredVia: "WORMHOLE" }, now, sys);
      assert.deepStrictEqual([wh.kind, wh.source], ["anchor", "ENTRY_CP"]);

      const gone = createGrid({ config: env.config, adapter: fakeAdapter({ dropL1: true }), clock: shared.clock,
        telemetry });
      const g = env.tx((db) => gone.facade.positionsOf(db, S.L2, [f], now)).positions.get(f.fleetId);
      assert.deepStrictEqual([g.source, g.anchorId], ["GONE", GATE_TO_N5]);
      assert.strictEqual(telemetry.counts.get("fleets.grid.anchorGone"), 1);

      const refused = createGrid({ config: env.config, adapter: fakeAdapter({ refuse: true }), clock: shared.clock });
      const r = env.tx((db) => refused.facade.positionsOf(db, S.L2, [f], now));
      const rp = r.positions.get(f.fleetId);
      assert.deepStrictEqual([r.anchorsReason, rp.kind, rp.gridKey], ["GRID_ANCHORS_UNAVAILABLE", "anchor",
        `system:${S.L2}`]);
      assert.strictEqual(refused.facade.readSystemGrid(S.L2).ok, false, "a refusal is not cached");
    }));

  test("G4 grid vendor facts + facade methods + readGridAnchorsFrom filters", () => {
    const wd = exportsOf(readSource("space/worldData.js"));
    for (const name of ["getStargatesForSystem", "getStationsForSystem", "getAsteroidBeltsForSystem",
      "getCelestialsForSystem"]) assert.ok(wd.has(name), `worldData exports ${name}`);
    const ss = readSource("services/structure/structureState.js");
    assert.ok(exportsOf(ss, "Object.assign(module.exports, {").has("peekStructuresForSystem"),
      "structureState exports peekStructuresForSystem");
    assert.ok(/\nfunction peekStructuresForSystem\(solarSystemID, options = \{\}\)/.test(ss));
    const is = readSource("services/inventory/itemStore.js");
    assert.ok(/\nfunction listStarbaseItems\(options = \{\}\)/.test(is), "itemStore listStarbaseItems");
    assert.ok(exportsOf(is).has("listStarbaseItems"));
    assert.ok(is.includes("position: normalizeSpaceVector(rawValue.position)"), "spaceState.position normalized");

    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof adapter.readGridAnchors, "function");
    assert.strictEqual(adapter.readGridAnchors(1, { maxAnchors: 8 }).ok, false, "no server src -> refusal");

    const methods = (grid) => Object.keys(grid).filter((k) => typeof grid[k] === "function").sort();
    const journal = createJournal({ clock: { now: () => 0 }, maxPayloadBytes: 16384, maxRows: 500 });
    const persistence = { ok: true, store: { transaction: () => ({ ok: false }) }, journal, worldSeed: 1 };
    for (const grid of [GRID_ON, { ...GRID_ON, enabled: false }]) {
      const fr = startFleets({ config: { ...H.CONFIG, modules: { fleets: { enabled: true } }, grid }, persistence,
        clock: { now: () => 0 }, ids: { next: () => "x" } });
      assert.ok(fr.ok, JSON.stringify(fr));
      assert.deepStrictEqual(methods(fr.fleets.grid), FACADE_METHODS);
      assert.strictEqual(fr.fleets.grid.isEnabled(), grid.enabled);
    }
    const down = startFleets({ config: { ...H.CONFIG, modules: { fleets: { enabled: false } }, grid: GRID_ON } });
    assert.strictEqual(down.ok, false);
    const unavailable = require("../../lib/fleets").createUnavailableFleets("disabled_by_config");
    assert.deepStrictEqual(methods(unavailable.grid), FACADE_METHODS);
    assert.deepStrictEqual(unavailable.grid.positionsOf(), { ok: false, reason: "GRID_OFF" });

    const pos = (systemID, anchorState, onlineState) => ({ itemID: 0, groupID: 365, ownerID: 98000001,
      spaceState: { systemID, anchorState, onlineState, position: at(10) } });
    const vendor = {
      worldData: {
        getStargatesForSystem: () => [{ itemID: 50000002, position: at(0), destinationSolarSystemID: 30000002 }],
        getStationsForSystem: () => [],
        getCelestialsForSystem: () => [{ itemID: 40000001, groupID: 6, position: at(5) }],
        getAsteroidBeltsForSystem: () => [40000010, 40000011, 40000012].map((id) => ({ itemID: id, position: at(id) })),
      },
      structures: { peekStructuresForSystem: () => [
        { structureID: 1030000001, position: at(1), devFlags: { lneStationId: "st-1" } },
        { structureID: 1030000002, position: at(2), destroyedAt: 123 }] },
      itemStore: { listStarbaseItems: () => [{ ...pos(1, "anchored", "online"), itemID: 1000000001 },
        { ...pos(1, "anchored", "offline"), itemID: 1000000002 }] },
    };
    const full = readGridAnchorsFrom(vendor, 30000001, { maxAnchors: 64 });
    assert.strictEqual(full.ok, true, JSON.stringify(full));
    assert.deepStrictEqual(full.anchors.map((a) => `${a.kind}:${a.id}`), ["gate:50000002", "structure:1030000001",
      "pos:1000000001", "sun:40000001", "belt:40000010", "belt:40000011", "belt:40000012"]);
    assert.strictEqual(full.anchors[1].lneStationId, "st-1");
    const cut = readGridAnchorsFrom(vendor, 30000001, { maxAnchors: 5 });
    assert.deepStrictEqual([cut.truncated, cut.anchors.map((a) => a.kind)],
      [true, ["gate", "structure", "pos", "sun", "belt"]]);
    assert.strictEqual(readGridAnchorsFrom({}, 30000001, { maxAnchors: 5 }).reason, "GRID_ANCHORS_UNAVAILABLE");
  });

  test("G5 grid panel: grid ENTRY on a gate -> that gate; no grid -> the hash anchor of today", () => {
    const worldData = {
      getSolarSystemByID: (id) => ({ solarSystemID: id, solarSystemName: "L2" }),
      getCelestialsForSystem: () => [{ itemID: 1, itemName: "Sun", kind: "sun", groupID: 6, position: at(0) }],
      getAsteroidBeltsForSystem: () => [],
      getStationsForSystem: () => [],
      getStargatesForSystem: () => [
        { itemID: GATE_TO_L1, itemName: "Gate (L1)", destinationSolarSystemID: S.L1, position: at(AU) },
        { itemID: GATE_TO_N5, itemName: "Gate (N5)", destinationSolarSystemID: S.N5, position: at(-AU) }],
    };
    const r = readSystemInteriorFrom(worldData, S.L2, { maxObjects: 400 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const statics = { system: r.system, objects: r.objects, truncated: r.truncated };
    const row = { fleetId: "f-1", factionId: FACTION_A, role: "patrol", state: "STAGED", ships: 3 };
    const objects = (rows) => ({ fleets: { rows, truncated: false }, incoming: null, battles: null, stations: null,
      sites: null, wrecks: null, salvage: null });
    const hashed = assignAnchors(objects([row]), statics, S.L2).fleets.rows[0].anchor;
    const notOn = hashed.itemId === GATE_TO_L1 ? GATE_TO_N5 : GATE_TO_L1;
    const onGate = assignAnchors(objects([{ ...row, grid: { gridKey: `gate:${notOn}`, anchorKind: "gate",
      anchorId: notOn, position: at(0), source: "ENTRY" } }]), statics, S.L2).fleets.rows[0];
    assert.deepStrictEqual(onGate.anchor, { kind: "gate", itemId: notOn });
    const cp = assignAnchors(objects([{ ...row, grid: { gridKey: "x", anchorKind: "gate", anchorId: notOn,
      position: null, source: "CP" } }]), statics, S.L2).fleets.rows[0];
    assert.deepStrictEqual(cp.anchor, hashed, "CP keeps the hash anchor");
    assert.deepStrictEqual(assignAnchors(objects([{ ...row, grid: null }]), statics, S.L2).fleets.rows[0].anchor,
      hashed);
  });
};
