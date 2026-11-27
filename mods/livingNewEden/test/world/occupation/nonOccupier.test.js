"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { battleInfluence } = require("../../../lib/world/occupation/influenceRules");
const { createOccupationService } = require("../../../lib/world/occupation/occupationService");
const { createBattleIntelConsequence } = require("../../../lib/strategy/battleIntel");
const { buildPowerTable } = require("../../../lib/strategy/ai/strength");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { createHostility } = require("../../../lib/battle/data/hostility");
const { FLEET_ROLES } = require("../../../lib/fleets/schema");
const { EVASIVE_ROLES } = require("../../../lib/battle/data/contactRules");
const { resolveConfig } = require("../../../config");
const { buildDefaultServiceDefs } = require("../../../lib/runtime/services");
const { startOccupation } = require("../../../lib/world/occupation");
const { createWorldStateRepository } = require("../../../lib/world/worldStateRepository");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const CAPS = 500018;
const SANSHA = 500019;
const SYSTEM = 30000001;
const POWER = buildPowerTable(GROUPS);

module.exports = ({ test, skip }) => {
  test("H4 non-occupier 500018: battleInfluence, readView presence, battleIntel of a passive faction "
    + "role mercenary", () => {
    const got = {};
    const settled = { winnerSide: "A", winnerFactionId: CAPS, sides: { A: { factionId: CAPS },
      B: { factionId: SANSHA } } };
    const rows = new Map([[SANSHA, 60]]);
    const params = { battleWinPoints: 10, battleLossPoints: 5, maxFactionsPerSystem: 8 };
    got.influence = battleInfluence(settled, rows, { ...params, nonOccupierFactionIds: new Set([CAPS]) });
    got.plain = battleInfluence(settled, rows, params).winnerFactionId;

    const config = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
    const system = { systemId: SYSTEM, occupationState: "STABLE", controllerFactionId: SANSHA, occupierFactionId: null,
      previousControllerFactionId: null, lastStateChangeAt: 0, phaseSeq: 0, influenceEvaluatedAt: null,
      capturedAt: null, detachedSinceAt: null, homeFactionId: null, version: 1,
      influence: [{ factionId: SANSHA, influenceScore: 60, garrisonStrength: 0 }] };
    const fleet = (fleetId, factionId, fleetRole) => ({ fleetId, factionId, fleetRole, version: 1, state: "STAGED",
      refitPending: false, composition: [{ hullGroup: "cruiser", count: 2 }] });
    const deps = { store: {}, journal: {}, scheduler: {}, clock: { now: () => 0 }, config, hostility: createHostility(),
      powerTable: POWER, repository: { getSystem: () => ({ ok: true, system }) },
      fleets: { repository: { listFleetsInSystem: () => ({ ok: true, fleets: [fleet("f-pirate", SANSHA, "patrol"),
        fleet("f-merc", CAPS, "mercenary")] }) } } };
    const presenceOf = (svc) => {
      const r = svc.readView({ inTransaction: true }, SYSTEM, 1000, []);
      assert.ok(r.ok, JSON.stringify(r));
      return [...r.view.presence.keys()].sort((a, b) => a - b);
    };
    got.presence = presenceOf(createOccupationService({ ...deps, nonOccupierFactionIds: new Set([CAPS]) }));
    got.presencePlain = presenceOf(createOccupationService(deps));

    const upserts = [];
    const intel = createBattleIntelConsequence({
      intelRepository: { listIntel: () => ({ ok: true, records: [] }),
        upsertObservation: (tx, o) => {
          upserts.push(o.factionId);
          return { ok: true, duplicate: false };
        } },
      fleetRepository: { getFleets: () => ({ ok: true, fleets: [] }) },
      registry: { getFaction: (id) => ({ factionId: id }), isActive: (id) => id !== CAPS },
      powerTable: POWER, isHostile: () => true });
    got.intel = intel.apply({ inTransaction: true }, { systemId: SYSTEM, at: 1000, fleets: [],
      sides: { A: { factionId: CAPS }, B: { factionId: SANSHA } } }, "battle:b1:settle:v1:c:intel");
    got.upserts = upserts;
    got.roles = [FLEET_ROLES[FLEET_ROLES.length - 1], EVASIVE_ROLES.includes("mercenary")];

    assert.deepStrictEqual(got, {
      influence: { influence: [{ factionId: SANSHA, influenceScore: 55 }], changed: true, winnerFactionId: null,
        loserFactionId: SANSHA },
      plain: CAPS,
      presence: [SANSHA],
      presencePlain: [CAPS, SANSHA],
      intel: { ok: true, written: 1, skipped: 1 },
      upserts: [SANSHA],
      roles: ["mercenary", false],
    });
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("C6 wiring of the non-occupier: the service definition passes "
    + "nonOccupierFactionIds [500018] to startOccupation; on the real startOccupation a battle won by 500018 writes no "
    + "influence row of 500018 and counts battleNonOccupierWinner", () => H.withStore(driver, async (reopen) => {
    const seen = [];
    const def = buildDefaultServiceDefs({ startOccupation: (deps) => {
      seen.push(deps.nonOccupierFactionIds);
      return { ok: false, reason: "TEST_STOP" };
    } }).find((d) => d.name === "occupation");
    def.start({ config: {}, clock: { now: () => 0 } }, { logger: { log() {} } });
    assert.deepStrictEqual(seen, [[CAPS]]);

    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const config = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
    const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock,
      limits: { maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 } });
    const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
      clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
      graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => ({ getMode: () => "off" }),
      logger: { log() {} }, nowMs: () => 0, nonOccupierFactionIds: [CAPS] });
    assert.ok(r.ok, JSON.stringify(r));
    try {
      const sys = H.S.N5;
      const seeded = env.tx((db) => repo.applyChange(db, { systemId: sys, expectedVersion: 0, reason: "SEED_CONTROL",
        state: { securityClass: "nullsec", controllerFactionId: SANSHA },
        influence: [{ factionId: SANSHA, influenceScore: 60 }] }, `world:seed:v1:${sys}`));
      assert.ok(seeded.ok, JSON.stringify(seeded));
      const settled = { battleId: "c6:b1", systemId: sys, at: shared.clock.now(), outcome: "A_WIN", winnerSide: "A",
        winnerFactionId: CAPS, sides: { A: { factionId: CAPS }, B: { factionId: SANSHA } } };
      const applied = env.tx((db) => r.occupation.consequence.apply(db, settled, "c6:ck"));
      const rows = env.tx((db) => db.prepare("SELECT faction_id AS f, influence_score AS s FROM "
        + "world_system_influence WHERE system_id = ? ORDER BY faction_id").all(sys));
      assert.deepStrictEqual([applied.ok, rows, r.occupation.getStatus().counters.battleNonOccupierWinner],
        [true, [{ f: SANSHA, s: 60 - config.occupation.battleLossPoints }], 1]);
    } finally {
      r.occupation.stop("test");
    }
  }));
};
