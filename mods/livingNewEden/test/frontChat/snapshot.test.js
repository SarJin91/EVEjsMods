"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { startOccupation } = require("../../lib/world/occupation");
const { buildSystemCardView } = require("../../lib/observer/views/systemCard");
const { createViewRegistry } = require("../../lib/observer/views");
const { readFrontSnapshot } = require("../../lib/frontChat/snapshot");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const CARD = Object.freeze({ refreshMs: 15000, maxRows: 5, maxFleets: 100, recentBattles: 3 });
const SETTINGS = Object.freeze({ regionMaxSystems: 500, regionContestedRows: 3, regionProgressSystems: 1,
  maxFleets: 100 });
const COMP = Object.freeze([Object.freeze({ hullGroup: "cruiser", count: 3 })]);

function fakeStations(list) {
  return { getMode: () => "ready", repository: {
    countLiveBySystem(tx, ids) {
      const m = new Map();
      for (const s of list) {
        if (!ids.includes(s.systemId)) continue;
        const k = `${s.systemId}:${s.factionId}`;
        m.set(k, { systemId: s.systemId, factionId: s.factionId, count: ((m.get(k) || {}).count || 0) + 1 });
      }
      return { ok: true, rows: [...m.values()] };
    },
    listStationsOfFaction: (tx, f, opts) => ({ ok: true, records: list.filter((s) => s.factionId === f
      && (!opts || !opts.states || opts.states.includes(s.state))) }),
    listStationsInSystem: (tx, id) => ({ ok: true, records: list.filter((s) => s.systemId === id)
      .map((s) => ({ stationId: s.stationId, name: s.stationId, ownerFactionId: s.factionId, state: s.state,
        stateUntilAt: null })) }),
  } };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("FC5 front snapshot", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("FC5 front snapshot: card + region, progress reads bounded, zero writes, governor hold opens no tx", () =>
    H.withStore(driver, async (reopen) => {
      const { S, FACTION_A, FACTION_B } = H;
      const shared = H.sharedOf();
      const env = H.boot(reopen(), shared);
      const config = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
      const stations = fakeStations([{ stationId: "st:a0", systemId: S.N0, factionId: FACTION_A, state: "ONLINE" },
        { stationId: "st:a7", systemId: S.N7, factionId: FACTION_A, state: "ONLINE" }]);
      const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
      const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
        clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations,
        views: createViewRegistry(), nowMs: () => 0 });
      assert.ok(r.ok, JSON.stringify(r));
      for (const id of [S.N5, S.N6, S.N7]) {
        const seed = env.tx((db) => repo.applyChange(db, { systemId: id, expectedVersion: 0, reason: "SEED_CONTROL",
          state: { securityClass: "nullsec", controllerFactionId: FACTION_B },
          influence: [{ factionId: FACTION_B, influenceScore: 60 }] }, `world:seed:v1:${id}`));
        assert.ok(seed.ok, JSON.stringify(seed));
      }
      for (const id of [S.N5, S.N6]) {
        const fleet = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: id, homeSystemId: S.N0,
          fleetRole: "invasion", composition: [...COMP] }, `fc5:fleet:${id}`);
        assert.ok(fleet.ok, JSON.stringify(fleet));
        const sig = env.tx((db) => r.occupation.signalInTx(db, { systemId: id, factionId: FACTION_A,
          signal: "INVASION", at: shared.clock.now() }, `fc5:sig:${id}`));
        assert.strictEqual(sig.state, "CONTESTED", JSON.stringify(sig));
      }

      let reads = 0;
      const occupation = { ...r.occupation, readProgressInTx: (...args) => {
        reads += 1;
        return r.occupation.readProgressInTx(...args);
      } };
      const ctx = { occupation, world: { repository: repo }, fleets: env.fleets, battle: { repository: env.battles } };
      const names = new Map([[FACTION_A, "Attackers"], [FACTION_B, "Holders"]]);
      const card = buildSystemCardView({ ctx, store: env.store, clock: shared.clock, getGovernor: () => null,
        factionNames: names, settings: CARD, nowMs: () => 0 });
      const deps = { card, store: env.store, ctx, graph: shared.graph, settings: SETTINGS, now: shared.clock.now(),
        names };
      const before = repo.getChangeCount();
      const out = readFrontSnapshot(deps, S.N7);
      assert.ok(out.ok, JSON.stringify(out));
      assert.strictEqual(repo.getChangeCount(), before, "zero writes");
      const snap = out.snapshot;
      assert.deepStrictEqual([snap.systemId, snap.card.inWorld, snap.card.system.state, snap.regionId],
        [S.N7, true, "STABLE", shared.graph.getSystem(S.N7).regionId]);
      assert.deepStrictEqual([snap.region.systems, snap.region.tracked, snap.region.tooLarge],
        [shared.graph.getSystemsInRegion(snap.regionId).length, 3, false]);
      assert.deepStrictEqual(snap.region.controllers, [{ factionId: FACTION_B, systems: 3 }]);
      assert.deepStrictEqual(snap.region.contested.map((c) => [c.systemId, c.state]),
        [[S.N5, "CONTESTED"], [S.N6, "CONTESTED"]], "the current system is skipped, order by phaseDueAt, id");
      assert.ok(snap.region.contested[0].progress !== null && snap.region.contested[1].progress === null);
      assert.ok(reads <= 1 + SETTINGS.regionProgressSystems, `readProgressInTx calls ${reads}`);
      assert.strictEqual(snap.names.get(FACTION_A), "Attackers");

      assert.deepStrictEqual(snap.fleets, { factions: [], fleetsTotal: 0, shipsTotal: 0, truncated: false });

      const big = readFrontSnapshot({ ...deps, settings: { ...SETTINGS, regionMaxSystems: 1 } }, S.N7);
      assert.deepStrictEqual([big.ok, big.snapshot.region.tooLarge, big.snapshot.region.contested], [true, true, []]);

      const small = env.fleets.createFleet({ factionId: FACTION_B, currentSystemId: S.N5, homeSystemId: S.N5,
        fleetRole: "garrison", composition: [{ hullGroup: "cruiser", count: 1 }] }, "fc5:fleet:defender");
      assert.ok(small.ok, JSON.stringify(small));
      const card1 = buildSystemCardView({ ctx, store: env.store, clock: shared.clock, getGovernor: () => null,
        factionNames: names, settings: { ...CARD, maxRows: 1 }, nowMs: () => 0 });
      let txs = 0;
      const counted = { isOpen: () => env.store.isOpen(), transaction: (...args) => {
        txs += 1;
        return env.store.transaction(...args);
      } };
      for (const regionMaxSystems of [SETTINGS.regionMaxSystems, 1]) {
        txs = 0;
        const n5 = readFrontSnapshot({ ...deps, card: card1, store: counted,
          settings: { ...SETTINGS, regionMaxSystems } }, S.N5);
        assert.ok(n5.ok, JSON.stringify(n5));
        assert.deepStrictEqual(n5.snapshot.card.fleets.groups.map((g) => g.factionId), [FACTION_A]);
        assert.deepStrictEqual(n5.snapshot.fleets, { factions: [{ factionId: FACTION_A, fleets: 1, ships: 3 },
          { factionId: FACTION_B, fleets: 1, ships: 1 }], fleetsTotal: 2, shipsTotal: 4, truncated: false });
        assert.strictEqual(txs, 1, "the card has its own store; one region/fleets tx here");
      }
      const capped = readFrontSnapshot({ ...deps, settings: { ...SETTINGS, maxFleets: 1 } }, S.N5);
      assert.deepStrictEqual([capped.snapshot.fleets.fleetsTotal, capped.snapshot.fleets.truncated], [1, true]);

      let opened = 0;
      const store = { isOpen: () => true, transaction: () => {
        opened += 1;
        return { ok: false, reason: "X" };
      } };
      const held = readFrontSnapshot({ ...deps, store, ctx: { ...ctx, governor: { admits: () => false } } }, S.N7);
      assert.deepStrictEqual([held, opened], [{ ok: false, reason: "GOVERNOR_HOLD" }, 0]);
      r.occupation.stop();
    }));
};
