"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { startOccupation } = require("../../lib/world/occupation");
const { resolveConfig } = require("../../config");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const EVENT = "OCCUPATION_PHASE_CHANGE";
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const PIRATE = 500019;
const CONTROLLER = 500001;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("LC3 lowsec ambush won by the pirate (lowsec.enabled and captureEnabled off): the real "
    + "consequence occupation in a STABLE lowsec system -> controller unchanged, pirate influence +battleWinPoints, "
    + "controller -battleLossPoints, no OCCUPATION_PHASE_CHANGE", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    env.now = () => shared.clock.now();
    const config = configOf({ EVEJS_LNE_LOWSEC_ENABLED: "0" });
    assert.deepStrictEqual([config.lowsec.enabled, config.lowsec.captureEnabled], [false, false]);
    const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
    const stations = { getMode: () => "ready", repository: {
      countLiveBySystem: () => ({ ok: true, rows: [] }), listStationsOfFaction: () => ({ ok: true, records: [] }) } };
    const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
      clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
      graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations,
      views: createViewRegistry(), logger: { log() {} }, nowMs: () => 0 });
    assert.ok(r.ok, JSON.stringify(r));
    const occupation = r.occupation;
    const SYS = H.S.N5;
    const seeded = env.tx((db) => repo.applyChange(db, { systemId: SYS, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "lowsec", controllerFactionId: CONTROLLER },
      influence: [{ factionId: CONTROLLER, influenceScore: 60 }] }, `world:seed:v1:${SYS}`));
    assert.ok(seeded.ok, JSON.stringify(seeded));
    const read = () => env.tx((db) => repo.getSystem(db, SYS, { includeInfluence: true })).system;
    const score = (sys, f) => ((sys.influence || []).find((i) => i.factionId === f) || { influenceScore: 0 })
      .influenceScore;
    const before = read();
    assert.deepStrictEqual([before.securityClass, before.occupationState, before.controllerFactionId],
      ["lowsec", "STABLE", CONTROLLER]);

    const settlement = env.makeSettlement({ consequences: [occupation.consequence] });
    const camp = H.newFleet(env, "lc3:camp", PIRATE, [{ hullGroup: "cruiser", count: 4 }]);
    const escort = H.newFleet(env, "lc3:escort", CONTROLLER, [{ hullGroup: "frigate", count: 2 }]);
    const battle = H.battleOfFleets(env, "lc3", [camp], [escort], { systemId: SYS, factionB: CONTROLLER });
    const result = H.resultFor(battle.input, "A_WIN", { [escort]: (e) => ({ d: e.count, e: 0 }) });
    const settled = H.settleIn(env, settlement, battle, result);
    assert.ok(settled.ok && settled.duplicate === false, JSON.stringify(settled));
    assert.deepStrictEqual(settled.consequences, { applied: ["occupation"], refused: [] });

    const after = read();
    const S = config.occupation;
    assert.deepStrictEqual([after.controllerFactionId, after.occupationState, after.occupierFactionId || null],
      [CONTROLLER, "STABLE", null], "the controller never moves");
    assert.ok(score(after, PIRATE) > score(before, PIRATE), JSON.stringify(after.influence));
    assert.deepStrictEqual([score(after, PIRATE), score(after, CONTROLLER)],
      [S.battleWinPoints, 60 - S.battleLossPoints]);
    const events = env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = ?")
      .get(EVENT).n);
    assert.strictEqual(events, 0, "no OCCUPATION_PHASE_CHANGE");
    occupation.stop("test");
  }));
};
