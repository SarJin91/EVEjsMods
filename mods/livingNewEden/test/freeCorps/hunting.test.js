"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { createManualClock } = require("../../lib/util/clock");
const { startFreeCorps } = require("../../lib/freeCorps");
const plan = require("../../lib/freeCorps/plan");
const { createFreeCorpVentureRepository } = require("../../lib/freeCorps/ventureRepository");
const { createFreeCorpWarRepository } = require("../../lib/freeCorps/warRepository");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 2000000000000;
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const L1 = 30000011;
const L2 = 30000012;
const HOLD = 600000;

function resolved() {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: ON_ENV });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function cfgOf({ fc = {}, hunting = {}, wars = {}, ventures = {}, killmails = {} } = {}) {
  const c = resolved();
  const f = c.freeCorps;
  return { ...c, freeCorps: { ...f, targetCorps: 0, ...fc,
    ventures: { ...f.ventures, enabled: true, loss: { highsecPermille: 0, lowsecPermille: 0, nullsecPermille: 0 },
      ...ventures },
    hunting: { ...f.hunting, enabled: true, targetHunters: 0, engageChancePermille: 1000, ...hunting },
    wars: { ...f.wars, ...wars }, killmails: { ...f.killmails, ...killmails } } };
}

const LOW = Object.freeze({ [L1]: { band: "lowsec", links: [L2] }, [L2]: { band: "lowsec", links: [L1] } });

function graphOf(spec) {
  const byId = new Map(Object.entries(spec).map(([id, s]) => [Number(id), { id: Number(id), name: `S${id}`,
    regionId: 10000002, constellationId: 20000020, secClass: s.band }]));
  return { getSystem: (id) => byId.get(id) || null,
    getSystemsBySecClass: (band) => [...byId.values()].filter((v) => v.secClass === band).map((v) => v.id),
    getNeighbors: (id) => (spec[id] ? spec[id].links.slice() : null) };
}

const linked = (n, corporationId) => ({ ok: true, state: "LINKED", corporationId, ceoCharacterId: corporationId + 1,
  characterIds: Array.from({ length: n }, (_v, i) => corporationId * 10 + i), refusedMemberCount: 0 });

function boot(opened, { cfg, observed = null, spec = LOW, stationSystems = [L1], extra = {} } = {}) {
  const clock = createManualClock(T0);
  const vc = { identities: new Map(), ensures: [],
    ensureOwnerIdentity(spec) {
      vc.ensures.push(spec);
      return { ok: true, queued: true };
    },
    getOwnerIdentity: (kind, id) => vc.identities.get(id) || { ok: true, state: "PENDING" },
    countOwnerCharacters: () => ({ ok: true, ready: true, total: 0, byKind: { capsuleer: 0, civilian: 0, free: 0 } }) };
  const presence = observed === null ? null : { isObserved: (id) => observed.has(id) };
  const graph = graphOf(spec);
  const r = startFreeCorps({ config: cfg, clock, logger: { log() {} }, telemetry: null,
    persistence: { store: opened.store, journal: createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 }),
      worldSeed: opened.worldSeed },
    views: null, getGraph: () => ({ ok: true, graph }), getVirtualCorps: () => vc, getGovernor: () => null,
    listStations: (systemId) => ({ ok: true, stations: stationSystems.includes(systemId)
      ? [{ stationId: 60000000 + (systemId % 100), corporationId: 1000100 }] : [] }),
    bloodlinesOf: () => [1, 2], raceSourceFactionIds: [500001], excludedRegionIds: [10000070],
    reservedNames: () => ({ names: new Set(), tickers: new Set() }),
    setTimer: () => ({ cancel() {}, hasRef: () => false }), nowMs: () => 0,
    bfs: require("../../lib/strategy/ai/bfs").bfs,
    readSystemBelts: (ids) => ({ ok: true, counts: new Map(ids.map((id) => [id, id === L2 ? 2 : 0])) }),
    getPresence: () => presence, ...extra });
  assert.ok(r.ok, JSON.stringify(r));
  return { fc: r.freeCorps, vc, clock };
}

const exec = (opened, sql, ...args) => {
  const r = opened.store.transaction("t.exec", (db) => db.prepare(sql).run(...args));
  assert.ok(r.ok, JSON.stringify(r));
};
const all = (opened, sql, ...args) => {
  const r = opened.store.transaction("t.all", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
    typeof v === "bigint" ? Number(v) : v])));
};

function seedCorp(opened, { corpId, archetype, isk = 500000000, nextAt = T0, seed = 12345, ventureSeq = 1 }) {
  exec(opened, "INSERT INTO world_free_corps (corp_id, archetype, state, open, name, ticker, sec_band, home_system_id, "
    + "home_station_id, home_station_corp_id, race_faction_id, members_target, corporation_id, isk, struggle_count, "
    + "seed, name_attempt, venture_seq, next_at, founded_at, updated_at, version) VALUES (?, ?, 'ACTIVE', 1, ?, ?, "
    + "'lowsec', ?, 60000011, 1000100, 500001, 5, ?, ?, 0, ?, 0, ?, ?, ?, ?, 1)", corpId, archetype, `Corp ${corpId}`,
  `TC${corpId}`, L1, 98000000 + corpId, isk, seed, ventureSeq, nextAt, T0 - 1000, T0 - 1000);
}

function insertVenture(opened, { corpId, kind, seq = 1 }) {
  const repo = createFreeCorpVentureRepository();
  const row = { venture_id: `fcv:${corpId}:${seq}`, corp_id: corpId, seq, kind, state: "WORKING", open: 1,
    home_system_id: L1, system_id: L2, target_system_id: L2, target_station_id: null, sec_band: "lowsec", jumps: 1,
    crew: 5, crew_lost: 0, step: 1, travel_steps: 1, work_steps: 3, steps_total: 5, holds: 0, yield_isk: 0,
    cost_isk: 0, started_at: T0 - 1000, step_due_at: T0, updated_at: T0 - 1000, ended_at: null, end_reason: null,
    version: 1, wh_route: null, wh_entry_system_id: null, stranded_steps: 0 };
  const r = opened.store.transaction("t.v", (db) => repo.insertInTx(db, row, row.updated_at));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

const corpOf = (opened, id) => all(opened, "SELECT * FROM world_free_corps WHERE corp_id = ?", id)[0];
const ventureOf = (opened, id) => all(opened, "SELECT * FROM world_free_corp_ventures WHERE venture_id = ?", id)[0];
const skirmishes = (opened) => all(opened, "SELECT * FROM world_free_corp_skirmishes ORDER BY skirmish_id");

function pass(env) {
  const r = env.fc.runPassNow();
  assert.deepStrictEqual(r, { ok: true, ran: true }, JSON.stringify(env.fc.getStatus().lastError));
  return env.fc.getStatus();
}

function scene(opened, cfg, observed, extra = {}) {
  seedCorp(opened, { corpId: 1, archetype: "hunter" });
  seedCorp(opened, { corpId: 2, archetype: "miner", seed: 777 });
  insertVenture(opened, { corpId: 1, kind: "HUNT" });
  insertVenture(opened, { corpId: 2, kind: "MINE" });
  const env = boot(opened, { cfg, observed, extra });
  env.vc.identities.set(1, linked(5, 98000001));
  env.vc.identities.set(2, linked(5, 98000002));
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("FC7-1 plan.resolveSkirmish is pure and deterministic, both outcomes, loss / ISK / loot invariants", () => {
    const input = (seed) => ({ attacker: { crew: 5, kind: "HUNT" }, defender: { crew: 6, kind: "RAT" },
      band: "lowsec", seed, iskPerPilot: 20000000, lootPermille: 300 });
    assert.deepStrictEqual(plan.resolveSkirmish(input(42)), plan.resolveSkirmish(input(42)));
    const outcomes = new Set();
    for (let seed = 1; seed <= 200; seed += 1) {
      const r = plan.resolveSkirmish(input(seed));
      outcomes.add(r.outcome);
      const aWins = r.outcome === "ATTACKER_WIN";
      const [loserLost, loserCrew, winnerLost, winnerCrew] = aWins ? [r.crewLostD, 6, r.crewLostA, 5]
        : [r.crewLostA, 5, r.crewLostD, 6];
      assert.ok(loserLost >= 1 && loserLost <= loserCrew, `seed ${seed} loser ${loserLost}`);
      assert.ok(winnerLost >= 0 && winnerLost <= Math.floor(winnerCrew * 340 / 1000), `seed ${seed} winner ${winnerLost}`);
      assert.strictEqual(r.iskLostA, r.crewLostA * 20000000);
      assert.strictEqual(r.iskLostD, r.crewLostD * 20000000);
      assert.strictEqual(r.lootIsk, aWins ? Math.floor(r.iskLostD * 300 / 1000) : 0);
      assert.ok(!aWins || r.lootIsk > 0, `seed ${seed} loot`);
    }
    assert.deepStrictEqual([...outcomes].sort(), ["ATTACKER_WIN", "DEFENDER_WIN"]);
  });

  needsDriver("FC7-2 one skirmish settled once: fcs row, outcome writes, a replay at the same clock changes nothing, "
    + "DUPLICATE, the prey corporation due in the same pass is skipped", () => {
    withStore(driver, (opened) => {
      const cfg = cfgOf();
      const env = scene(opened, cfg, null);
      const st = pass(env);
      const rows = skirmishes(opened);
      assert.strictEqual(rows.length, 1);
      const s = rows[0];
      assert.deepStrictEqual([s.skirmish_id, s.attacker_venture_id, s.defender_venture_id, s.system_id, s.war_id,
        s.attacker_crew, s.defender_crew], ["fcs:fcv:1:1:1", "fcv:1:1", "fcv:2:1", L2, null, 5, 5]);
      assert.strictEqual(st.counters.touchedSkips, 1, "prey corporation due in the same pass");
      assert.strictEqual(st.counters.skirmishes, 1);
      const hunter = ventureOf(opened, "fcv:1:1");
      const prey = ventureOf(opened, "fcv:2:1");
      const c1 = corpOf(opened, 1);
      const c2 = corpOf(opened, 2);
      const P = 20000000;
      if (s.outcome === "ATTACKER_WIN") {
        assert.deepStrictEqual([hunter.state, hunter.step, hunter.yield_isk], ["WORKING", 2, s.loot_isk]);
        assert.deepStrictEqual([prey.state, prey.end_reason, prey.crew_lost], ["LOST", "HUNTED", s.crew_lost_d]);
        assert.strictEqual(c2.isk, 500000000 - s.crew_lost_d * P);
        assert.strictEqual(c2.ventures_lost, 1);
        assert.strictEqual(c1.isk, 500000000 - s.crew_lost_a * P);
        assert.strictEqual(st.counters.skirmishAttackerWins, 1);
      } else {
        assert.deepStrictEqual([hunter.state, hunter.end_reason, hunter.crew_lost], ["LOST", "SKIRMISH", s.crew_lost_a]);
        assert.deepStrictEqual([prey.state, prey.version], ["WORKING", 1], "the defender venture is not written");
        assert.strictEqual(c1.isk, 500000000 - s.crew_lost_a * P);
        assert.strictEqual(c2.isk, 500000000 - s.crew_lost_d * P);
        assert.strictEqual(st.counters.skirmishDefenderWins, 1);
      }
      pass(env);
      assert.strictEqual(skirmishes(opened).length, 1, "still one skirmish");
      assert.strictEqual(ventureOf(opened, "fcv:1:1").version, hunter.version);
      assert.strictEqual(corpOf(opened, 1).version, c1.version);
      const repo = createFreeCorpWarRepository();
      const dup = opened.store.transaction("t.dup", (db) => repo.insertSkirmishInTx(db, s));
      assert.deepStrictEqual(dup.value, { ok: false, reason: "DUPLICATE" });
      env.fc.stop();
    });
  });

  needsDriver("FC7-3 an observed system: both ventures HELD, no skirmish row, both treasuries kept", () => {
    withStore(driver, (opened) => {
      const env = scene(opened, cfgOf(), new Set([L2]));
      const st = pass(env);
      const hunter = ventureOf(opened, "fcv:1:1");
      const prey = ventureOf(opened, "fcv:2:1");
      assert.deepStrictEqual([hunter.state, hunter.holds, hunter.step, hunter.step_due_at], ["HELD", 1, 1, T0 + HOLD]);
      assert.deepStrictEqual([prey.state, prey.holds, prey.step_due_at], ["HELD", 1, T0 + HOLD]);
      assert.strictEqual(skirmishes(opened).length, 0);
      assert.strictEqual(corpOf(opened, 1).isk, 500000000);
      assert.strictEqual(corpOf(opened, 2).isk, 500000000);
      assert.strictEqual(st.counters.huntHeld, 1);
      assert.strictEqual(st.ventures.byKind["HUNT.held"], 1);
      assert.strictEqual(st.ventures.byKind["MINE.held"], 1);
      env.fc.stop();
    });
  });

  needsDriver("FC7-5 flags off: no hunter quota, no war read, HUNT without a fight; prey index plan; reset policy, "
    + "migration 76", () => {
    for (const on of [false, true]) {
      withStore(driver, (opened) => {
        const cfg = cfgOf({ hunting: { enabled: on, targetHunters: 1 } });
        const env = boot(opened, { cfg });
        pass(env);
        const rows = all(opened, "SELECT archetype FROM world_free_corps");
        assert.deepStrictEqual(rows.map((r) => r.archetype), on ? ["hunter"] : [], `hunting ${on}`);
        env.fc.stop();
      });
    }
    withStore(driver, (opened) => {
      const cfg = cfgOf({ hunting: { enabled: false }, wars: { enabled: false, declareChancePermille: 1000 } });
      seedCorp(opened, { corpId: 1, archetype: "hunter" });
      seedCorp(opened, { corpId: 2, archetype: "miner", isk: 5000000000, ventureSeq: 0 });
      seedCorp(opened, { corpId: 3, archetype: "miner", nextAt: T0 + 86400000, ventureSeq: 0 });
      insertVenture(opened, { corpId: 1, kind: "HUNT" });
      const env = boot(opened, { cfg });
      for (const id of [1, 2, 3]) env.vc.identities.set(id, linked(5, 98000000 + id));
      const st = pass(env);
      assert.strictEqual(all(opened, "SELECT COUNT(*) AS n FROM world_free_corp_wars")[0].n, 0);
      assert.strictEqual("wars" in st, false);
      assert.strictEqual("hunting" in st, false);
      const v = ventureOf(opened, "fcv:1:1");
      assert.deepStrictEqual([v.state, v.step, v.yield_isk], ["WORKING", 2, 5 * cfg.freeCorps.hunting.yieldIskPerStepPerPilot]);
      assert.strictEqual(st.counters.huntNoPrey, 1);
      assert.strictEqual(skirmishes(opened).length, 0);
      const q = opened.store.transaction("t.plan", (db) => db.prepare("EXPLAIN QUERY PLAN SELECT venture_id, corp_id, "
        + "kind, state, system_id, sec_band, crew, crew_lost, holds, step_due_at, version FROM world_free_corp_ventures "
        + "WHERE open = 1 AND state = 'WORKING' ORDER BY system_id LIMIT ?").all(10).map((r) => r.detail).join(" | "));
      assert.ok(q.ok && q.value.includes("world_free_corp_ventures_system"), JSON.stringify(q));
      const repo = createFreeCorpVentureRepository();
      const prey = opened.store.transaction("t.prey", (db) => repo.listPreyInTx(db, { limit: 16 }));
      assert.deepStrictEqual(prey.value.rows.map((r) => r.venture_id), ["fcv:1:1"]);
      env.fc.stop();
    });
    assert.strictEqual(TABLE_POLICY.world_free_corp_wars, ACTION.WIPE);
    assert.strictEqual(TABLE_POLICY.world_free_corp_skirmishes, ACTION.WIPE);
    assert.ok(LATEST_SCHEMA_VERSION >= 76, "migration 77 (outbox) after 76");
  });

  needsDriver("FC7-6 a refused hunter quota (bandWeights highsec:100) falls back to the plain founding in "
    + "the same step; W28", () => {
    const H1 = 30000001;
    withStore(driver, (opened) => {
      const cfg = cfgOf({ fc: { targetCorps: 1, bandWeights: "highsec:100" }, hunting: { targetHunters: 1 } });
      const env = boot(opened, { cfg, spec: { [H1]: { band: "highsec", links: [] } }, stationSystems: [H1] });
      const st = pass(env);
      const rows = all(opened, "SELECT archetype, sec_band, home_system_id FROM world_free_corps");
      assert.strictEqual(rows.length, 1, "one plain corporation");
      assert.notStrictEqual(rows[0].archetype, "hunter");
      assert.deepStrictEqual([rows[0].sec_band, rows[0].home_system_id], ["highsec", H1]);
      assert.strictEqual(st.counters.foundingQuotaRefused, 1);
      assert.strictEqual(st.counters.founded, 1);
      assert.strictEqual(st.counters.foundingNoArchetype, 0, "the refusal of the quota is its own counter");
      env.fc.stop();
    });
    const warn = "freeCorps.hunting.enabled without a lowsec / nullsec weight in freeCorps.bandWeights";
    const w = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { ...ON_ENV, EVEJS_LNE_FREE_CORPS_VENTURES_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_HUNTING_ENABLED: "1", ...env } }).warnings.filter((x) => x.startsWith(warn));
    assert.strictEqual(w({ EVEJS_LNE_FREE_CORPS_BAND_WEIGHTS: "highsec:100" }).length, 1);
    assert.strictEqual(w({ EVEJS_LNE_FREE_CORPS_BAND_WEIGHTS: "highsec:100,nullsec:1" }).length, 0);
    assert.strictEqual(w({}).length, 0, "defaults have lowsec / nullsec");
  });
};

module.exports.harness = { cfgOf, boot, scene, all, exec, seedCorp, insertVenture, pass, linked, T0, L1, L2 };
