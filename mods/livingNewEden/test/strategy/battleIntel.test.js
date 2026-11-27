"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { lazyIntelConsequence } = require("../../lib/battle");
const { startStrategy, createUnavailableStrategy } = require("../../lib/strategy");
const { createBattleIntelConsequence } = require("../../lib/strategy/battleIntel");
const { createIntelRepository } = require("../../lib/strategy/intelRepository");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { ttlOf, isFresh } = require("../../lib/strategy/ai/targeting");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const SCOUT = Object.freeze([{ hullGroup: "frigate", count: 1 }]);
const GUARD = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);
const POWER = buildPowerTable(expandStrengthGroups(GROUPS));

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r;
}

const intelRows = (env) => env.tx((db) => db.prepare("SELECT faction_id AS f, system_id AS s, observed_at AS at, "
  + "controller_faction_id AS c, hostile_fleets AS hf, hostile_ships AS hs, hostile_strength AS st, "
  + "hostile_stations AS hst, source FROM world_faction_intel ORDER BY faction_id, system_id").all()
  .map((r) => ({ ...r })));

function bootWith(opened, shared, makeConsequence) {
  const env = H.boot(opened, shared);
  env.now = () => shared.clock.now();
  env.worldRepository = { getSystem: (tx, id) => ({ ok: true,
    system: id === H.S.N5 ? { systemId: id, controllerFactionId: H.FACTION_B } : null }) };
  env.settlement = env.makeSettlement({ consequences: [makeConsequence(env)] });
  return env;
}

function scoutDies(env, tag) {
  const scout = H.newFleet(env, `${tag}:scout`, H.FACTION_A, SCOUT);
  const guard = H.newFleet(env, `${tag}:guard`, H.FACTION_B, GUARD);
  const battle = H.battleOfFleets(env, tag, [scout], [guard]);
  const result = H.resultFor(battle.input, "B_WIN", { [scout]: (e) => ({ d: e.count, e: 0 }),
    [guard]: () => ({ d: 1, e: 0 }) });
  return { scout, guard, battle, result };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  const strategyOf = (env, opened, config) => {
    const st = startStrategy({ config, persistence: { ok: true, store: opened.store, journal: env.journal,
      worldSeed: opened.worldSeed }, clock: { now: () => env.now() }, fleets: env.fleets,
      world: { repository: env.worldRepository }, logger: { log() {} } });
    assert.ok(st.ok, JSON.stringify(st));
    return st.strategy;
  };

  needsDriver("BI1 scout destroyed, guard survives -> intel of both sides, source battle, strength after "
    + "losses; strategy off (stub) -> STRATEGY_OFF, settlement COMPLETED; bad input -> INTEL_INPUT_INVALID", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const { config } = configOf();
      let strategy = null;
      const env = bootWith(opened, shared, () => lazyIntelConsequence(() => strategy));
      strategy = strategyOf(env, opened, config);
      assert.strictEqual(strategy.getStatus().state, "degraded");

      shared.clock.set(H.START_MS + HOUR);
      const at = env.now();
      const s = scoutDies(env, "bi1");
      const r = H.settleIn(env, env.settlement, s.battle, s.result);
      assert.strictEqual(r.outcome, "COMPLETED", JSON.stringify(r));
      assert.deepStrictEqual(r.consequences, { applied: ["intel"], refused: [] });
      const strength = strengthOf([{ hullGroup: "cruiser", count: 2 }], POWER);
      assert.ok(strength > 0);
      assert.deepStrictEqual(intelRows(env), [
        { f: H.FACTION_B, s: H.S.N5, at, c: H.FACTION_B, hf: 0, hs: 0, st: 0, hst: 0, source: "battle" },
        { f: H.FACTION_A, s: H.S.N5, at, c: H.FACTION_B, hf: 1, hs: 2, st: strength, hst: 0, source: "battle" },
      ].sort((x, y) => x.f - y.f));

      strategy = createUnavailableStrategy("STRATEGY_UNAVAILABLE");
      const s2 = scoutDies(env, "bi1b");
      const before = intelRows(env);
      const r2 = H.settleIn(env, env.settlement, s2.battle, s2.result);
      assert.strictEqual(r2.outcome, "COMPLETED");
      assert.deepStrictEqual(r2.consequences, { applied: ["intel"], refused: [] });
      assert.deepStrictEqual(intelRows(env), before);

      const bad = env.tx((db) => lazyIntelConsequence(() => strategyOf(env, opened, config))
        .apply(db, { systemId: 0, at, fleets: [], sides: {} }, "battle:x:settle:v1:c:intel"));
      assert.deepStrictEqual([bad.ok, bad.reason], [false, "INTEL_INPUT_INVALID"]);
    }));

  needsDriver("BI2 settlement replay -> duplicate, zero new journal / intel rows", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const { config } = configOf();
      let strategy = null;
      const env = bootWith(opened, shared, () => lazyIntelConsequence(() => strategy));
      strategy = strategyOf(env, opened, config);
      const s = scoutDies(env, "bi2");
      const req = { at: env.now() };
      const first = H.settleIn(env, env.settlement, s.battle, s.result, req);
      assert.strictEqual(first.duplicate, false);
      const journal = H.n(env, "SELECT count(*) AS n FROM world_event_journal");
      const rows = intelRows(env);
      assert.strictEqual(rows.length, 2);
      shared.clock.set(H.START_MS + 2 * HOUR);
      const again = H.settleIn(env, env.settlement, s.battle, s.result, req);
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
      assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal"), journal);
      assert.deepStrictEqual(intelRows(env), rows);
    }));

  needsDriver("BI3 INTEL_LIMIT and a newer stored row -> skipped, the settlement is not refused", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const counts = [];
      let intelRepo = null;
      const env = bootWith(opened, shared, (e) => {
        intelRepo = createIntelRepository({ journal: e.journal, limits: { maxIntelRowsPerFaction: 1,
          maxListLimit: 64 } });
        return createBattleIntelConsequence({ intelRepository: intelRepo, fleetRepository: e.fleets.repository,
          worldRepository: e.worldRepository, registry: { getFaction: () => ({ allies: [] }) }, powerTable: POWER,
          isHostile: (a, b) => a !== b, onCount: (name, n) => counts.push([name, n]) });
      });
      shared.clock.set(H.START_MS + HOUR);
      const at = env.now();
      const obs = (factionId, systemId, observedAt) => ({ factionId, systemId, observedAt, controllerFactionId: null,
        hostileFleets: 0, hostileShips: 0, hostileStrength: 0, hostileStations: 0, source: "fleet" });
      env.tx((db) => assert.ok(intelRepo.upsertObservation(db, obs(H.FACTION_A, H.S.N0, at), "t:a").ok));
      env.tx((db) => assert.ok(intelRepo.upsertObservation(db, obs(H.FACTION_B, H.S.N5, at + 1), "t:b").ok));
      const before = intelRows(env);
      const s = scoutDies(env, "bi3");
      const r = H.settleIn(env, env.settlement, s.battle, s.result, { at });
      assert.strictEqual(r.outcome, "COMPLETED", JSON.stringify(r));
      assert.deepStrictEqual(r.consequences, { applied: ["intel"], refused: [] });
      assert.deepStrictEqual(intelRows(env), before);
      assert.deepStrictEqual(counts, [["strategy.intel.battleSkipped", 2]]);
    }));

  test("BI4 ttlOf: battle intel fresh after 7 h (24 h), fleet intel stale after 7 h (6 h); 0 = intelTtlMs",
    () => {
      const params = { intelTtlMs: 6 * HOUR, battleIntelTtlMs: 24 * HOUR };
      const at = 100 * HOUR;
      const battle = { observedAt: at - 7 * HOUR, source: "battle" };
      const fleet = { observedAt: at - 7 * HOUR, source: "fleet" };
      assert.strictEqual(ttlOf(battle, params), 24 * HOUR);
      assert.strictEqual(isFresh(battle, at, ttlOf(battle, params)), true);
      assert.strictEqual(ttlOf(fleet, params), 6 * HOUR);
      assert.strictEqual(isFresh(fleet, at, ttlOf(fleet, params)), false);
      assert.strictEqual(ttlOf(battle, { ...params, battleIntelTtlMs: 0 }), 6 * HOUR);
    });

  test("BI5 strategy.battleIntelTtlMs: default 24 h, no warning; env reaches the review params literal", () => {
    const def = configOf();
    assert.deepStrictEqual(def.warnings || [], []);
    assert.strictEqual(def.config.strategy.battleIntelTtlMs, 86400000);
    const { config } = configOf({ EVEJS_LNE_STRATEGY_BATTLE_INTEL_TTL_MS: "3600000" });
    const service = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
      intelRepository: {},
      registry: {}, kinds: { list: [], get: () => null }, powerTable: POWER, scoring: {}, scheduler: {},
      fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config, hostility: () => true, isCampaignOk: () => true,
      industryCatalog: {} });
    assert.strictEqual(service.params.battleIntelTtlMs, 3600000);
    assert.strictEqual(service.params.intelTtlMs, config.strategy.intelTtlMs);
  });
};
