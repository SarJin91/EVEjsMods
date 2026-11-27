"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createViewRegistry } = require("../../lib/observer/views");
const { startFleets } = require("../../lib/fleets");
const { VIEW_ID } = require("../../lib/fleets/factionFleetsView");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const CALDARI = 500001;
const GURISTAS = 500010;
const AKKIO = 30000200;
const OBE = 30000205;
const NAMES = new Map([[AKKIO, "Akkio"], [OBE, "Obe"]]);
const MIXED = Object.freeze([{ hullGroup: "frigate", typeId: null, count: 2 },
  { hullGroup: "frigate", typeId: 587, count: 3 }, { hullGroup: "cruiser", count: 1 }]);
const CRUISERS = Object.freeze([{ hullGroup: "cruiser", count: 4 }]);
const OBSERVER = Object.freeze({ factionOverviewEnabled: true, factionOverviewRefreshMs: 15000,
  factionOverviewMaxFactions: 32, factionFleetsMaxPerFaction: 100, factionFleetsMaxOperationsPerFaction: 20 });

function configWith(observer = {}) {
  return { enabled: true, modules: { fleets: { enabled: true } }, limits: { maxVirtualFleets: 2000 },
    persistence: { journalMaxPayloadBytes: 8192 },
    fleets: { maxCompositionEntries: 32, maxShipsPerFleet: 500, maxFleetsPerOperation: 16, maxJsonBytes: 4096,
      maxListLimit: 500 },
    observer: { ...OBSERVER, ...observer } };
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-ff-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 5000, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return fn(opened);
  } finally {
    if (store) store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function boot(opened, observer) {
  const clock = createManualClock(START_MS);
  const views = createViewRegistry();
  const observed = [];
  let hold = false;
  const persistence = { ok: true, store: opened.store,
    journal: createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 }), worldSeed: opened.worldSeed };
  const graph = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (NAMES.has(id) ? { name: NAMES.get(id) }
    : null) } }) };
  const fr = startFleets({ config: configWith(observer), persistence, clock,
    ids: createIdGenerator({ clock, rng: createRng(5) }), views, graph,
    telemetry: { observe: (name, v) => observed.push([name, v]) },
    getGovernor: () => ({ admits: () => !hold }) });
  assert.ok(fr.ok, JSON.stringify(fr));
  return { clock, views, fleets: fr.fleets, observed, store: opened.store, setHold: (v) => { hold = v; } };
}

function seedFleets(env, rows) {
  const ids = rows.map(([factionId, systemId, , composition], i) => {
    const made = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId,
      fleetRole: "patrol", composition }, `ff:${i}`);
    assert.strictEqual(made.ok, true, JSON.stringify(made));
    return made.fleetId;
  });
  const r = env.store.transaction("test", (db) => {
    const up = db.prepare("UPDATE virtual_fleets SET state = ? WHERE fleet_id = ?");
    rows.forEach(([, , state], i) => up.run(state, ids[i]));
    return true;
  });
  assert.ok(r.ok, JSON.stringify(r));
  return ids;
}

function seedOperations(env, rows) {
  const r = env.store.transaction("test", (db) => {
    const ins = db.prepare(`INSERT INTO world_operations (operation_id, idempotency_key, operation_type, faction_id,
      origin_system_id, target_system_id, fleet_ids, objective, state, planned_at, due_at, completed_at, seed,
      result_json, updated_at, version) VALUES (?, ?, 'mining', ?, ?, ?, '[]', 'mine', ?, 7, NULL, NULL, 1, NULL, 7, 1)`);
    for (const [id, factionId, state, target] of rows) ins.run(id, `k:${id}`, factionId, AKKIO, target, state);
    return true;
  });
  assert.ok(r.ok, JSON.stringify(r));
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FO1 summarizeFactions: per faction fleets/ships/byState, hulls summed over typeId, DESTROYED out", () => {
    withStore(driver, (opened) => {
      const env = boot(opened);
      seedFleets(env, [[CALDARI, AKKIO, "IDLE", MIXED], [CALDARI, AKKIO, "STAGED", CRUISERS],
        [CALDARI, OBE, "TRAVELLING", CRUISERS], [CALDARI, OBE, "DESTROYED", CRUISERS],
        [GURISTAS, OBE, "IDLE", CRUISERS]]);
      const repo = env.fleets.repository;
      const states = ["IDLE", "PLANNED", "TRAVELLING", "STAGED", "ENGAGED", "RETREATING", "REFITTING", "MATERIALIZED"];
      const tx = env.store.transaction("test.read", (db) => repo.summarizeFactions(db, { states }));
      assert.strictEqual(tx.ok, true, JSON.stringify(tx));
      const r = tx.value;
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(r.factions, [
        { factionId: CALDARI, fleets: 3, ships: 14, byState: { IDLE: 1, STAGED: 1, TRAVELLING: 1 },
          hulls: [["cruiser", 9], ["frigate", 5]] },
        { factionId: GURISTAS, fleets: 1, ships: 4, byState: { IDLE: 1 }, hulls: [["cruiser", 4]] },
      ]);
      assert.strictEqual(repo.summarizeFactions(null, { states }).reason, "TX_REQUIRED");
      const bad = env.store.transaction("test.read", (db) => repo.summarizeFactions(db, { states: ["NOPE"] }));
      assert.strictEqual(bad.value.reason, "UNKNOWN_STATE");
      const empty = env.store.transaction("test.read", (db) => repo.summarizeFactions(db, { states: [] }));
      assert.strictEqual(empty.value.reason, "FLEET_INVALID_INPUT");
      env.fleets.stop("test");
    });
  });

  needsDriver("FO2 faction-fleets: list cut + truncated, ACTIVE before PLANNED, names, governor hold, listed:false", () => {
    withStore(driver, (opened) => {
      const env = boot(opened, { factionFleetsMaxPerFaction: 2, factionFleetsMaxOperationsPerFaction: 3 });
      const ids = seedFleets(env, [[CALDARI, AKKIO, "IDLE", MIXED], [CALDARI, AKKIO, "STAGED", CRUISERS],
        [CALDARI, OBE, "TRAVELLING", CRUISERS], [GURISTAS, OBE, "IDLE", CRUISERS]]);
      seedOperations(env, [["op_a1", CALDARI, "PLANNED", OBE], ["op_a2", CALDARI, "PLANNED", OBE],
        ["op_b1", CALDARI, "ACTIVE", OBE], ["op_b2", CALDARI, "ACTIVE", AKKIO], ["op_x", CALDARI, "COMPLETED", OBE],
        ["op_g1", GURISTAS, "PLANNED", OBE]]);
      assert.deepStrictEqual(env.views.listViews().map((v) => v.id).includes(VIEW_ID), false, "listed:false");
      const view = env.views.getView(VIEW_ID);
      assert.strictEqual(view.listed, false);
      assert.strictEqual(view.cacheKey(), `ff${Math.floor(START_MS / 15000)}`);
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.strictEqual(data.states.includes("DESTROYED"), false);
      const [cal, gur] = data.factions;
      assert.deepStrictEqual([cal.factionId, cal.fleets, cal.list.length, cal.truncated], [CALDARI, 3, 2, true]);
      const first = cal.list.find((f) => f.fleetId === ids[0]);
      assert.deepStrictEqual([first.systemName, first.hulls, first.ships, first.state],
        ["Akkio", [["cruiser", 1], ["frigate", 5]], 6, "IDLE"]);
      assert.deepStrictEqual(cal.operations.list.map((o) => [o.operationId, o.state, o.targetName]),
        [["op_b1", "ACTIVE", "Obe"], ["op_b2", "ACTIVE", "Akkio"], ["op_a1", "PLANNED", "Obe"]]);
      assert.strictEqual(cal.operations.truncated, true, "op_a2 cut by the limit 3");
      assert.deepStrictEqual([gur.fleets, gur.truncated, gur.operations.list.length, gur.operations.truncated],
        [1, false, 1, false]);
      assert.deepStrictEqual(env.observed.map(([n]) => n), ["observer.factionFleetsMs"]);
      env.setHold(true);
      assert.strictEqual(view.cacheKey(), null);
      assert.deepStrictEqual(view.getData(), { available: false, reason: "GOVERNOR_HOLD" });
      env.fleets.stop("test");
      assert.strictEqual(env.views.getView(VIEW_ID), null, "unregistered on stop");

      const two = boot(opened, { factionFleetsMaxOperationsPerFaction: 2 });
      const fullPlus = two.views.getView(VIEW_ID).getData().factions[0].operations;
      assert.deepStrictEqual([fullPlus.list.map((o) => o.operationId), fullPlus.truncated],
        [["op_b1", "op_b2"], true], "ACTIVE = limit, PLANNED 2 -> truncated");
      two.fleets.stop("test");
      const done = env.store.transaction("test", (db) => {
        db.prepare("UPDATE world_operations SET state = 'COMPLETED' WHERE operation_id IN ('op_a1', 'op_a2')").run();
        return true;
      });
      assert.ok(done.ok, JSON.stringify(done));
      const exact = boot(opened, { factionFleetsMaxOperationsPerFaction: 2 });
      const full = exact.views.getView(VIEW_ID).getData().factions[0].operations;
      assert.deepStrictEqual([full.list.map((o) => o.operationId), full.truncated],
        [["op_b1", "op_b2"], false], "ACTIVE = limit, PLANNED 0 -> not truncated");
      exact.fleets.stop("test");

      const zero = boot(opened, { factionFleetsMaxPerFaction: 0, factionFleetsMaxOperationsPerFaction: 0 });
      const z = zero.views.getView(VIEW_ID).getData().factions[0];
      assert.deepStrictEqual([z.list.length, z.truncated, z.operations], [0, true, { list: [], truncated: false }]);
      zero.fleets.stop("test");
      const off = boot(opened, { factionOverviewEnabled: false });
      assert.strictEqual(off.views.getView(VIEW_ID), null, "factionOverviewEnabled:false -> not registered");
      off.fleets.stop("test");
    });
  });
};
