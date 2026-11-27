"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { coresFor } = require("../../lib/world/core");
const { canMineIn } = require("../../lib/strategy/ai/miningControl");
const { runCoreGrant, grantKey, coreGrantLogLine } = require("../../lib/strategy/coreGrant");
const { runFactionSeed } = require("../../lib/strategy/factionSeed");
const { runStationSeed } = require("../../lib/stations/stationSeed");
const { indexOverrides, planSystemControl } = require("../../lib/world/controlPlan");
const { CONTROL_OVERRIDES } = require("../../lib/world/data/controlOverrides");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START = 1760000000000;
const SOE = 500016;
const GURISTAS = 500010;
const X7 = 30001978;
const JCIJV = 30001977;
const ROIRY = 30001983;
const GURISTAS_HQ = 30001290;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const CTX = Object.freeze({ hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
  hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
  maxCompositionEntries: 32, maxResourceUnits: 1000000000 });

function envOf(store) {
  const clock = createManualClock(START);
  const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
  const repo = createWorldStateRepository({ journal, clock, limits: LIMITS });
  const built = createFactionRegistry(REGISTRY_DATA_V1, CTX);
  assert.ok(built.ok, JSON.stringify(built));
  const baselineScore = resolveConfig({ modDir: MOD_DIR, env: {} }).config.occupation.stableBaselineScore;
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const create = (systemId, controller, influence = []) => tx((db) => {
    const r = repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: controller }, influence }, `test:seed:${systemId}`);
    assert.ok(r.ok, JSON.stringify(r));
  });
  const sys = (systemId) => tx((db) => repo.getSystem(db, systemId).system);
  const journalRows = () => tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n);
  const hasKey = (k) => tx((db) => journal.findByKey(db, k).found);
  const grant = (cores = coresFor({})) => runCoreGrant({ store, journal, worldRepository: repo,
    registry: built.registry, cores, settings: { baselineScore } });
  return { clock, journal, repo, tx, create, sys, journalRows, hasKey, grant, baselineScore };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("CG1 live world: X-7OMU under Guristas -> GRANTED once (controller + home 500016, previous 500010 "
    + "influence >= baseline, canMineIn); neighbours untouched; again DONE with zero journal rows; a later loss is not "
    + "re-granted", () => H.withStore(driver, async (reopen) => {
    const e = envOf(reopen().store);
    e.create(X7, GURISTAS, [{ factionId: GURISTAS, influenceScore: 60 }]);
    e.create(JCIJV, GURISTAS, [{ factionId: GURISTAS, influenceScore: 60 }]);
    e.create(ROIRY, null);
    const neighbours = [e.sys(JCIJV), e.sys(ROIRY)];
    const first = e.grant();
    assert.deepStrictEqual([first.ok, first.granted, first.owned, first.skipped], [true, 1, 0, 0], JSON.stringify(first));
    assert.deepStrictEqual(first.results, [{ factionId: SOE, systemId: X7, outcome: "GRANTED", previous: GURISTAS }]);
    const x7 = e.sys(X7);
    assert.deepStrictEqual([x7.controllerFactionId, x7.homeFactionId, x7.previousControllerFactionId, x7.capturedAt,
      x7.occupationState, x7.occupierFactionId], [SOE, SOE, GURISTAS, null, "STABLE", null]);
    const own = x7.influence.find((i) => i.factionId === SOE);
    assert.ok(own && own.influenceScore >= e.baselineScore, JSON.stringify(x7.influence));
    assert.deepStrictEqual([e.sys(JCIJV), e.sys(ROIRY)], neighbours);
    assert.strictEqual(canMineIn(SOE, x7, null), true);
    assert.strictEqual(e.hasKey(grantKey(SOE, X7)), true);

    const rows = e.journalRows();
    const again = e.grant();
    assert.deepStrictEqual([again.granted, again.owned, again.skipped, again.results.map((r) => r.outcome)],
      [0, 0, 0, ["DONE"]]);
    assert.strictEqual(e.journalRows(), rows);

    const version = e.sys(X7).version;
    e.tx((db) => {
      const r = e.repo.applyChange(db, { systemId: X7, expectedVersion: version, reason: "TEST_LOSS",
        state: { controllerFactionId: GURISTAS } }, "test:loss:x7");
      assert.ok(r.ok, JSON.stringify(r));
    });
    const third = e.grant();
    assert.deepStrictEqual(third.results.map((r) => r.outcome), ["DONE"]);
    assert.deepStrictEqual([e.sys(X7).controllerFactionId, e.sys(X7).homeFactionId], [GURISTAS, SOE]);
  }));

  needsDriver("CG2 BUSY (RECON, occupier 500010) and NO_ROW: no key, nothing written; a core without "
    + "grantControl (Guristas HQ) untouched", () => H.withStore(driver, async (reopen) => {
    const e = envOf(reopen().store);
    const none = e.grant();
    assert.deepStrictEqual([none.skipped, none.results.map((r) => r.outcome)], [1, ["NO_ROW"]]);
    assert.strictEqual(e.hasKey(grantKey(SOE, X7)), false);
    assert.strictEqual(e.journalRows(), 0);

    e.create(X7, GURISTAS, [{ factionId: GURISTAS, influenceScore: 60 }]);
    e.create(GURISTAS_HQ, null);
    e.tx((db) => {
      const r = e.repo.applyChange(db, { systemId: X7, expectedVersion: 1, reason: "TEST_RECON",
        state: { occupationState: "RECON", occupierFactionId: GURISTAS } }, "test:recon:x7");
      assert.ok(r.ok, JSON.stringify(r));
    });
    const before = [e.sys(X7), e.sys(GURISTAS_HQ)];
    const rows = e.journalRows();
    const busy = e.grant();
    assert.deepStrictEqual([busy.granted, busy.skipped, busy.results.map((r) => r.outcome)], [0, 1, ["BUSY"]]);
    assert.strictEqual(e.hasKey(grantKey(SOE, X7)), false);
    assert.strictEqual(e.journalRows(), rows);
    assert.deepStrictEqual([e.sys(X7), e.sys(GURISTAS_HQ)], before);
    const guristasCore = coresFor({}).find((c) => c.factionId === GURISTAS);
    assert.strictEqual(guristasCore.grantControl, undefined);
    assert.deepStrictEqual(e.grant([guristasCore]).results, []);
    assert.strictEqual(e.hasKey(grantKey(GURISTAS, GURISTAS_HQ)), false);
  }));

  needsDriver("CG3 fresh world: the start grant runs before the control seed (NO_ROW, line names the seed "
    + "state, no key); the seed plan with the real CONTROL_OVERRIDES gives X-7OMU controller = home = 500016 over the "
    + "Guristas pirate faction; the next start -> OWNED + key", () => H.withStore(driver, async (reopen) => {
    const e = envOf(reopen().store);
    const first = e.grant();
    assert.deepStrictEqual(first.results, [{ factionId: SOE, systemId: X7, outcome: "NO_ROW" }]);
    assert.strictEqual(e.hasKey(grantKey(SOE, X7)), false);
    const line = coreGrantLogLine(first.results[0], "waiting_graph");
    assert.ok(/NO_ROW \(control seed waiting_graph: a fresh world gets the core from CONTROL_OVERRIDES/.test(line), line);
    assert.ok(/NO_ROW \(control seed done\); next start retries$/.test(coreGrantLogLine(first.results[0], "done")));
    assert.ok(/NO_ROW \(control seed unknown\); next start retries$/.test(coreGrantLogLine(first.results[0], null)));

    const idx = indexOverrides(CONTROL_OVERRIDES);
    assert.ok(idx.ok, JSON.stringify(idx));
    const vertex = { id: X7, secClass: "nullsec", regionId: 10000023, constellationId: 20000289, factionId: null };
    const plan = planSystemControl(vertex, { factionId: GURISTAS, source: "faction_id" }, idx.index,
      { controllerInfluence: 60, sdeFactionInfluence: 20 });
    assert.strictEqual(plan.rule, "override");
    e.tx((db) => {
      const r = e.repo.applyChange(db, plan.change, `test:seed:${X7}`);
      assert.ok(r.ok, JSON.stringify(r));
    });
    const x7 = e.sys(X7);
    assert.deepStrictEqual([x7.controllerFactionId, x7.homeFactionId, x7.occupationState], [SOE, SOE, "STABLE"]);
    assert.strictEqual(canMineIn(SOE, x7, null), true);

    const next = e.grant();
    assert.deepStrictEqual(next.results, [{ factionId: SOE, systemId: X7, outcome: "OWNED" }]);
    assert.strictEqual(coreGrantLogLine(next.results[0], "already_applied"), null);
    assert.strictEqual(e.hasKey(grantKey(SOE, X7)), true);
  }));

  needsDriver("CG4 live world BUSY: the line gives the state and the occupier and says the next start retries "
    + "no key; after the occupation ends STABLE the next start -> GRANTED", () => H.withStore(driver, async (reopen) => {
    const e = envOf(reopen().store);
    e.create(X7, GURISTAS, [{ factionId: GURISTAS, influenceScore: 60 }]);
    e.tx((db) => {
      const r = e.repo.applyChange(db, { systemId: X7, expectedVersion: 1, reason: "TEST_RECON",
        state: { occupationState: "RECON", occupierFactionId: GURISTAS } }, "test:recon:x7");
      assert.ok(r.ok, JSON.stringify(r));
    });
    const busy = e.grant();
    assert.deepStrictEqual(busy.results, [{ factionId: SOE, systemId: X7, outcome: "BUSY",
      detail: `state=RECON occupier=${GURISTAS}` }]);
    assert.strictEqual(coreGrantLogLine(busy.results[0], "already_applied"),
      `strategy: core grant ${SOE} ${X7} BUSY (state=RECON occupier=${GURISTAS}); next start retries`);
    assert.strictEqual(e.hasKey(grantKey(SOE, X7)), false);

    e.tx((db) => {
      const r = e.repo.applyChange(db, { systemId: X7, expectedVersion: 2, reason: "TEST_STABLE",
        state: { occupationState: "STABLE", occupierFactionId: null } }, "test:stable:x7");
      assert.ok(r.ok, JSON.stringify(r));
    });
    const granted = e.grant();
    assert.deepStrictEqual(granted.results, [{ factionId: SOE, systemId: X7, outcome: "GRANTED", previous: GURISTAS }]);
    assert.strictEqual(coreGrantLogLine(granted.results[0], "already_applied"),
      `strategy: core grant ${SOE} ${X7} GRANTED prev=${GURISTAS}`);
    assert.deepStrictEqual([e.sys(X7).controllerFactionId, e.sys(X7).homeFactionId], [SOE, SOE]);
    assert.strictEqual(e.hasKey(grantKey(SOE, X7)), true);
  }));

  needsDriver("CG5 refusals of coreGrant / faction seed / station seed roll back as TX_ABORTED, not TX_FAILED "
    + "results unchanged", () => H.withStore(driver, async (reopen) => {
    const store = reopen().store;
    const seen = [];
    const spy = { transaction: (name, fn) => {
      const r = store.transaction(name, fn);
      seen.push([name, r.ok ? "ok" : r.reason]);
      return r;
    } };
    const e = envOf(store);
    const grant = runCoreGrant({ store: spy, journal: e.journal, worldRepository: e.repo,
      registry: createFactionRegistry(REGISTRY_DATA_V1, CTX).registry, cores: coresFor({}),
      settings: { baselineScore: e.baselineScore } });
    assert.deepStrictEqual(grant.results, [{ factionId: SOE, systemId: X7, outcome: "NO_ROW" }]);

    const faction = { factionId: SOE, startStations: [{ kind: "upwell", systemId: X7, structureFamily: "astrahus" }] };
    const registry = { listActiveFactions: () => [faction], getFaction: () => faction };
    const clock = { now: () => START };
    const seed = runFactionSeed({ store: spy, repository: { listFactions: () => ({ ok: false, reason: "LIST_BROKEN" }) },
      registry, clock, settings: { maxRowsPerTransaction: 100 } });
    assert.deepStrictEqual(seed, { ok: false, reason: "LIST_BROKEN" });

    const stations = runStationSeed({ store: spy, journal: { findByKey: () => ({ ok: false, reason: "JOURNAL_BROKEN" }) },
      repository: {}, registry, graph: { hasSystem: () => true }, adapter: null, clock,
      settings: { startStationsPerFaction: 1, maxRowsPerTransaction: 100 } });
    assert.deepStrictEqual([stations.ok, stations.failed, stations.failedDetail], [true, 1, [`${SOE}:JOURNAL_BROKEN`]]);

    assert.deepStrictEqual(seen, [["strategy.coreGrant", "TX_ABORTED"], ["strategy.seed", "TX_ABORTED"],
      ["stations.seed", "TX_ABORTED"]]);
  }));
};
