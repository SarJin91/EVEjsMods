"use strict";

const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");

const { harness: H } = require("../battle/settlement.test");
const { S } = require("../graph/fixtures/routeMap.fixture");
const { resolveConfig } = require("../../config");
const { startOccupation } = require("../../lib/world/occupation");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { createBastionReconcile, bastionReconcileSettingsOf } = require("../../lib/world/bastions/reconcileService");
const B = require("../../lib/world/bastions/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SOE = 500016;
const GURISTAS = 500010;
const CALDARI = 500001;
const SYS = S.N0;
const HOUR = 3600000;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const STATION_LIMITS = Object.freeze({ maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64,
  maxStations: 2000, maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 });
const COMP = Object.freeze([{ hullGroup: "cruiser", typeId: null, count: 3 }]);
const REGISTRY = Object.freeze({ corporationFor: (f) => 1000000 + f });
const SETTINGS = Object.freeze({ enabled: true, intervalMs: 6 * HOUR, delayMs: 60000, pageRows: 32,
  stationReturnEnabled: true, stationReturnMaxPerPass: 1, stationRows: 390 });

const configCache = new Map();
function configOf(env = {}) {
  const k = JSON.stringify(env);
  if (configCache.has(k)) return configCache.get(k);
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: path.dirname(os.tmpdir()), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  configCache.set(k, r.config);
  return r.config;
}

const fixtureIndex = () => Object.freeze({ version: 1, enabled: true, systems: new Map([[SYS, SOE]]),
  stations: new Map(), byFaction: new Map(), issues: [], bastions: new Map([[SYS, SOE]]), bastionIssues: [] });

function boot(opened, shared) {
  const env = H.boot(opened, shared);
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const stationsOf = (limits) => createStationRepository({ journal: env.journal, isKnownFaction: () => true,
    hullGroups: ["cruiser"], limits: { ...STATION_LIMITS, ...limits } });
  const holder = { repo: stationsOf({}), list: 0 };
  const wrapped = () => Object.freeze({ ...holder.repo, listStationsInSystem: (tx, id, o) => {
    holder.list += 1;
    return holder.repo.listStationsInSystem(tx, id, o);
  } });
  const or = startOccupation({ config: configOf(), persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) },
    getStations: () => ({ getMode: () => "ready", repository: wrapped() }), nowMs: () => 0, coreIndex: fixtureIndex() });
  assert.ok(or.ok, JSON.stringify(or));
  return { env, repo, holder, stationsOf, occ: or.occupation, lines: [] };
}

function seedBastion(b) {
  b.env.tx((db) => {
    const r = b.repo.applyChange(db, { systemId: SYS, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: SOE }, influence: [{ factionId: SOE, influenceScore: 100 }] },
    `world:seed:v1:${SYS}`);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(b.repo.setHomeInTx(db, SYS, SOE).ok);
  });
}

function station(b, shared, stationId, owner, opts = {}) {
  const kind = opts.kind || "npc";
  const spec = { stationId, kind, systemId: opts.systemId || SYS, ownerFactionId: owner,
    ownerCorporationId: 1000000 + owner, origin: "seed", at: shared.clock.now() };
  if (kind === "npc") spec.npcStationId = opts.npcStationId;
  else spec.structureFamily = "astrahus";
  const r = b.env.tx((db) => b.holder.repo.createStation(db, spec, `t:create:${stationId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

const stationOf = (b, id) => b.env.tx((db) => b.holder.repo.getStation(db, id)).record;
const n = (b, sql, ...args) => b.env.tx((db) => db.prepare(sql).get(...args)).n;
const journalRows = (b) => n(b, "SELECT count(*) AS n FROM world_event_journal");
const fleetOf = (b, id) => b.env.tx((db) => b.env.fleets.repository.getFleet(db, id)).fleet;

function reconcileOf(b, shared, over = {}, registry = REGISTRY) {
  return createBastionReconcile({ scheduler: b.env.scheduler, getOccupation: () => b.occ, coreIndex: fixtureIndex(),
    settings: { ...SETTINGS, ...over }, clock: shared.clock, logger: { log: (l) => b.lines.push(l) },
    getRegistry: () => registry,
    getGraph: () => ({ getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ id, secClass: "nullsec",
      factionId: SOE }) } }) }) });
}

function pass(b, shared, rec, bucket) {
  const h = rec.handler({ payload: { bucket, after: "0" } }, { now: shared.clock.now() });
  assert.strictEqual(h.ok, true, JSON.stringify(h));
  b.env.tx((db) => assert.deepStrictEqual(h.effect(db), { ok: true }));
  h.onCommitted();
  return rec.getStatus().counters;
}

function garrison(b, tag, factionId) {
  const fleetId = H.newFleet(b.env, tag, factionId, COMP);
  const f = fleetOf(b, fleetId);
  b.env.tx((db) => assert.ok(b.env.fleets.repository.reassignRole(db, { fleetId, expectedVersion: f.version,
    from: "invasion", to: "garrison" }, `${tag}:garrison`).ok));
  return fleetId;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("JCS1+JCS2+JCS4 NOOP bastion: Guristas NPC station -> SoE (corp, stock wiped, 2 journal events), the "
    + "Guristas IDLE garrison -> invasion; replay / next bucket / restart write nothing", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const first = reopen();
      const b = boot(first, shared);
      seedBastion(b);
      station(b, shared, "npc-60012598", GURISTAS, { npcStationId: 60012598 });
      const st0 = stationOf(b, "npc-60012598");
      const stock = b.env.tx((db) => b.holder.repo.applyStockChange(db, { stationId: "npc-60012598",
        expectedVersion: st0.version, key: "t:stock", reason: "TEST", at: shared.clock.now(),
        deltas: [{ itemKind: "mineral", itemKey: "type:34", delta: 100 }, { itemKind: "mineral", itemKey: "type:35",
          delta: 5 }] }));
      assert.ok(stock.ok, JSON.stringify(stock));
      const gGarrison = garrison(b, "g1", GURISTAS);
      const cGarrison = garrison(b, "c1", CALDARI);
      const gInvasion = H.newFleet(b.env, "g2", GURISTAS, COMP);
      const version = stationOf(b, "npc-60012598").version;
      const at = shared.clock.now();
      const rec = reconcileOf(b, shared);
      const c1 = pass(b, shared, rec, 1);
      assert.deepStrictEqual([c1.noop, c1.restored, c1.stationsReturned, c1.stationsSkipped, c1.stationsRefused],
        [1, 0, 1, 0, 0], JSON.stringify(c1));
      const st = stationOf(b, "npc-60012598");
      assert.deepStrictEqual([st.ownerFactionId, st.ownerCorporationId, st.state, st.version],
        [SOE, 1000000 + SOE, "ONLINE", version + 1]);
      assert.strictEqual(n(b, "SELECT count(*) AS n FROM world_station_stock WHERE station_id = ?", "npc-60012598"), 0);
      const ev = (type) => b.env.tx((db) => db.prepare("SELECT aggregate_type AS t, aggregate_id AS id, payload AS p "
        + "FROM world_event_journal WHERE event_type = ?").all(type));
      const reassigned = ev("STATION_REASSIGNED");
      assert.deepStrictEqual(reassigned.map((r) => [r.t, r.id]), [["world_station", "npc-60012598"]]);
      const returned = ev(B.EVENT_STATION_RETURNED);
      assert.deepStrictEqual(returned.map((r) => [r.t, r.id, JSON.parse(r.p)]), [["world_bastion_station",
        "npc-60012598", { stationId: "npc-60012598", systemId: SYS, fromFactionId: GURISTAS, toFactionId: SOE, at }]]);
      assert.deepStrictEqual([fleetOf(b, gGarrison).fleetRole, fleetOf(b, cGarrison).fleetRole,
        fleetOf(b, gInvasion).fleetRole], ["invasion", "garrison", "invasion"]);
      assert.strictEqual(c1.garrisonReleased, 1);
      assert.ok(b.lines.includes(`world: bastion ${SYS} station npc-60012598 returned ${GURISTAS}->${SOE}`),
        b.lines.join("\n"));
      const rows = journalRows(b);
      pass(b, shared, rec, 1);
      const c2 = pass(b, shared, rec, 2);
      assert.deepStrictEqual([journalRows(b), c2.stationsReturned, c2.stationsRefused], [rows, 1, 0]);
      b.occ.stop("restart");
      first.store.close();
      const b2 = boot(reopen(), shared);
      const c3 = pass(b2, shared, reconcileOf(b2, shared), 3);
      assert.deepStrictEqual([journalRows(b2), c3.stationsReturned, c3.stationsRefused], [rows, 0, 0]);
      assert.strictEqual(stationOf(b2, "npc-60012598").version, version + 1);
      b2.occ.stop("test");
    }));

  needsDriver("JCS3 skips without a write: Upwell, ARMOR_REINFORCE, limit of SoE (retried), no corporation; "
    + "maxPerPass 1 -> the second station in the next event", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const b = boot(reopen(), shared);
      seedBastion(b);
      station(b, shared, "a-upw", GURISTAS, { kind: "upwell" });
      station(b, shared, "b-armor", GURISTAS, { npcStationId: 60000002 });
      station(b, shared, "c-npc", GURISTAS, { npcStationId: 60000003 });
      station(b, shared, "d-npc", CALDARI, { npcStationId: 60000004 });
      station(b, shared, "z-soe", SOE, { npcStationId: 60000009, systemId: S.N5 });
      const armor = stationOf(b, "b-armor");
      assert.ok(b.env.tx((db) => b.holder.repo.transitionStation(db, { stationId: "b-armor",
        expectedVersion: armor.version, from: "ONLINE", to: "ARMOR_REINFORCE", key: "t:armor", reason: "TEST",
        at: shared.clock.now() })).ok);
      const owners = () => ["a-upw", "b-armor", "c-npc", "d-npc"].map((id) => stationOf(b, id).ownerFactionId);
      const before = owners();
      b.holder.repo = b.stationsOf({ maxPerFaction: 1 });
      const rec = reconcileOf(b, shared);
      let rows = journalRows(b);
      const c1 = pass(b, shared, rec, 1);
      assert.deepStrictEqual([c1.stationsReturned, c1.stationsSkipped, c1.stationsRefused, journalRows(b), owners()],
        [0, 4, 0, rows, before], JSON.stringify(c1));
      assert.ok(b.lines.includes("world: bastion stations skipped upwell=1 busy=1 limit=2 noCorp=0"), b.lines.join("\n"));
      b.holder.repo = b.stationsOf({});
      const noCorp = reconcileOf(b, shared, {}, { corporationFor: () => null });
      const c2 = pass(b, shared, noCorp, 2);
      assert.deepStrictEqual([c2.stationsReturned, c2.stationsSkipped, journalRows(b), owners()], [0, 1, rows, before]);
      const c3 = pass(b, shared, rec, 3);
      assert.deepStrictEqual([c3.stationsReturned, c3.stationsSkipped, owners()],
        [1, 6, [GURISTAS, GURISTAS, SOE, CALDARI]], JSON.stringify(c3));
      rows = journalRows(b);
      const c4 = pass(b, shared, rec, 4);
      assert.deepStrictEqual([c4.stationsReturned, owners()], [2, [GURISTAS, GURISTAS, SOE, SOE]]);
      assert.ok(journalRows(b) > rows);
      b.occ.stop("test");
    }));

  needsDriver("JCS5 flag off: no station read in the reconcile, owner unchanged; settings: the same pageRows, "
    + "station rows 0 / reserved / too small", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const b = boot(reopen(), shared);
      seedBastion(b);
      station(b, shared, "npc-off", GURISTAS, { npcStationId: 60000011 });
      const off = reconcileOf(b, shared, { stationReturnEnabled: false });
      const c = pass(b, shared, off, 1);
      assert.deepStrictEqual([b.holder.list, c.stationsReturned, stationOf(b, "npc-off").ownerFactionId],
        [0, 0, GURISTAS]);
      b.occ.stop("test");

      const store = (cap) => ({ limits: { maxRowsPerTransaction: cap } });
      const cfgOff = configOf();
      const cfgOn = configOf({ EVEJS_LNE_WORLD_NPC_SOV_BASTION_STATION_RETURN_ENABLED: "1" });
      assert.deepStrictEqual([cfgOff.world.npcSovBastionStationReturnEnabled,
        cfgOff.world.npcSovBastionStationReturnMaxPerPass], [false, 1]);
      const sOff = bastionReconcileSettingsOf(cfgOff, store(1000));
      const sOn = bastionReconcileSettingsOf(cfgOn, store(1000));
      const reserve = B.STATION_RETURN_BASE_ROWS + cfgOn.stations.maxStockItemsPerStation
        + 2 * cfgOn.occupation.maxFleetsReadPerEval;
      assert.deepStrictEqual([sOff.pageRows, sOff.stationRows, sOff.stationReturnEnabled], [32, 0, false]);
      assert.deepStrictEqual([sOn.pageRows, sOn.stationRows, sOn.stationReturnEnabled], [32, reserve, true]);
      const small = bastionReconcileSettingsOf(cfgOn, store(reserve));
      assert.deepStrictEqual([small.stationReturnEnabled, small.stationReturnTooSmall, small.stationRows,
        small.pageRows], [false, true, 0, bastionReconcileSettingsOf(cfgOff, store(reserve)).pageRows]);
    }));
};
