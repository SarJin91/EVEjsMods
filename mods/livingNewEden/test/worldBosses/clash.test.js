"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { settlementRowsLimit } = require("../../lib/battle/settlementPlan");
const { WORLD_BOSS_BATTLE_ROWS_BOUND } = require("../../lib/worldBosses/schema");
const C = require("../../lib/worldBosses/clash");
const { CATALOG_V1, validateCatalog } = require("../../lib/worldBosses/catalog");
const { phaseUnits } = require("../../lib/worldBosses/machine");
const { createWorldBossRepository } = require("../../lib/worldBosses/repository");
const { createWorldBossService } = require("../../lib/worldBosses/service");
const { validateInput, HASH_LIMITS } = require("../../lib/battle/contract");
const { SELF_TEST_INPUT } = require("../../lib/battle/data/contactRules");
const { startBattle, lazySentriesConsequence } = require("../../lib/battle");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const seams = require("../../lib/adapter/sentrySeams");
const { startSentries } = require("../../lib/sentries");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { harness: H } = require("../battle/settlement.test");
const { harness: CT } = require("../battle/contacts.test");
const { fakeVendor } = require("../sentries/factionSentries.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const KINDS = validateCatalog(CATALOG_V1);
const DRIFTER = KINDS.kinds.get("drifter_swarm");
const AMARR = 500003;
const CALDARI = 500001;
const CLASH_ENV = Object.freeze({ EVEJS_LNE_WORLD_BOSSES_ROLL_ENABLED: "0", EVEJS_LNE_WORLD_BOSSES_CLASH_ENABLED: "1",
  EVEJS_LNE_WORLD_BOSSES_CLASH_FIRST_DELAY_MS: "0", EVEJS_LNE_WORLD_BOSSES_CLASH_INTERVAL_MS: "60000",
  EVEJS_LNE_WORLD_BOSSES_DWELL_MS: "600000" });

function rowOfStore(store, repo) {
  const r = store.transaction("test.wbc.row", (db) => repo.listOpenInTx(db, 4).rows[0]
    || db.prepare("SELECT boss_id FROM world_bosses").get());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function raw(store) {
  const r = store.transaction("test.wbc.raw", (db) => db.prepare("SELECT * FROM world_bosses").get());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function rig(store, clock) {
  const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
  const repo = createWorldBossRepository({ journal });
  const fk = F.fakes([1]);
  const created = [];
  const battleStates = new Map();
  const battle = {
    getStatus: () => ({ state: "ready" }),
    createFixedDefenseBattleInTx: (tx, spec, key) => {
      created.push({ spec, key });
      const battleId = `b${created.length}`;
      battleStates.set(battleId, "PENDING");
      return { ok: true, duplicate: false, battleId };
    },
    repository: { getBattle: (tx, id) => ({ ok: true, battle: battleStates.has(id)
      ? { battleId: id, state: battleStates.get(id) } : null }) },
  };
  const fleets = [{ fleetId: "f1", factionId: CALDARI, fleetRole: "garrison", version: 3,
    composition: [{ hullGroup: "battleship", count: 4 }] },
  { fleetId: "f2", factionId: AMARR, fleetRole: "patrol", version: 1, composition: [{ hullGroup: "frigate", count: 1 }] },
  { fleetId: "f3", factionId: CALDARI, fleetRole: "logistics", version: 1, composition: [] }];
  const fleetRepo = { listFleetsInSystem: (tx, systemId, opts) => ({ ok: true, fleets: fleets.slice(0, opts.limit) }) };
  const graph = F.makeGraph();
  const svc = createWorldBossService({ store, journal, repo, worldSeed: 1, settings: F.settingsFor(CLASH_ENV),
    kinds: KINDS.kinds, getGraph: () => graph, getPresence: () => fk.presence, getOccupation: () => fk.occupation,
    getSites: () => fk.sites, getWorldRepository: () => fk.worldRepository, getBattle: () => battle,
    getFleetRepository: () => fleetRepo, isHostile: () => true,
    powerTable: { battleship: 100, frigate: 1 } });
  const made = store.transaction("test.wbc.spawn", (tx) => svc.spawnInTx(tx, { kind: "drifter_swarm",
    originKind: "admin", originRef: "pm:1", systemId: 5, at: clock.now }, "admin:pm:1"));
  assert.strictEqual(made.value.ok, true, JSON.stringify(made));
  return { svc, repo, fk, created, battleStates, journal };
}

function settledOf(battleId, at, factionId, entries, hit) {
  return { battleId, at, mode: "VIRTUAL", sides: { A: { factionId }, B: { factionId: null } },
    fixedDefenses: entries.map((e) => ({ sentryId: e.sentryId, itemId: e.itemId, hp: e.hp, ehp: e.ehp,
      ...hit(e) })) };
}

module.exports = ({ test, skip }) => {
  test("WBC1 buildEntries pass the real contract; a phase without a living unit = no battle", () => {
    const row = { bossNo: 3, phase: 1, factionId: DRIFTER.factionId };
    const entries = C.buildEntries(row, DRIFTER, phaseUnits(DRIFTER.phases[0]));
    assert.strictEqual(entries.length, 10);
    assert.deepStrictEqual([entries[0].sentryId, entries[0].itemId, entries[9].sentryId, entries[9].itemId],
      ["wb:3:p1:cruiser1", 3001, "wb:3:p1:strike4", 3010]);
    assert.ok(entries.every((e) => e.ehp === e.hp && e.ownerKind === "faction" && e.ownerId === 500024));
    const input = { ...SELF_TEST_INPUT, sideB: { factionId: null, fleets: [] },
      fixedDefenses: { attackerRetreatLossPermille: 300, entries } };
    const v = validateInput(input, HASH_LIMITS);
    assert.strictEqual(v.ok, true, JSON.stringify(v));
    const half = { ...phaseUnits(DRIFTER.phases[0]), cruiser2: 0, strike1: 0 };
    const some = C.buildEntries(row, DRIFTER, half);
    assert.deepStrictEqual([some.length, some.map((e) => e.itemId).includes(3002), some[1].itemId], [8, false, 3003]);
    const dead = Object.fromEntries(Object.keys(half).map((k) => [k, 0]));
    assert.deepStrictEqual(C.buildEntries(row, DRIFTER, dead), []);
    assert.ok(/^wbb:[0-9a-f]{40}$/.test(C.battleKeyOf({ bossId: "wb1-1", visitNo: 1, round: 0, factionId: 7 })));
  });

  test("WBC6 (N2) settlementRowsLimit: off = as before, enabled + clash.enabled = minus the bound "
    + "the config.js mirror agrees", () => {
    const base = { persistence: { maxRowsPerTransaction: 1000 }, battle: { settleRowsReserve: 56 } };
    const limit = (worldBosses) => settlementRowsLimit({ ...base, ...(worldBosses ? { worldBosses } : {}) });
    assert.strictEqual(limit(null), 944);
    assert.strictEqual(limit({ enabled: false, clash: { enabled: true } }), 944);
    assert.strictEqual(limit({ enabled: true, clash: { enabled: false } }), 944);
    assert.strictEqual(limit({ enabled: true, clash: { enabled: true } }), 944 - WORLD_BOSS_BATTLE_ROWS_BOUND);
    assert.strictEqual(WORLD_BOSS_BATTLE_ROWS_BOUND, 5);
    const rows = (env) => {
      const r = config.resolveConfig({ env: { EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "100", ...env },
        modDir: MOD_DIR });
      const line = r.warnings.find((w) => w.startsWith("smallest full battle settles"));
      assert.ok(line, r.warnings.join("; "));
      assert.strictEqual(Number(/ rows > (\d+) /.exec(line)[1]), settlementRowsLimit(r.config), line);
      return { n: Number(/ rows > (\d+) /.exec(line)[1]), line };
    };
    const off = rows({});
    const only = rows({ EVEJS_LNE_WORLD_BOSSES_ENABLED: "1" });
    const on = rows({ EVEJS_LNE_WORLD_BOSSES_ENABLED: "1", EVEJS_LNE_WORLD_BOSSES_CLASH_ENABLED: "1" });
    assert.deepStrictEqual([only.n, on.n], [off.n, off.n - WORLD_BOSS_BATTLE_ROWS_BOUND]);
    assert.ok(!off.line.includes("worldBosses") && on.line.includes(" - worldBosses battle rows"), on.line);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("WBC2-WBC3, WBC5 world boss clash on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("WBC2 round -> open_clashes_json; consequence twice with the same ck = damage once; stale entry; sweep", () => {
    withStore(driver, ({ store }) => {
      const clock = { now: F.T0 };
      const R = rig(store, clock);
      clock.now = F.T0 + 1000;
      R.svc.runPass(clock.now);
      assert.strictEqual(R.created.length, 1);
      const { spec, key } = R.created[0];
      assert.ok(/^wbb:[0-9a-f]{40}$/.test(key), key);
      assert.deepStrictEqual([spec.systemId, spec.sideA, spec.fixedDefenses.attackerRetreatLossPermille,
        spec.fixedDefenses.entries.length], [5, { factionId: CALDARI, fleets: [{ fleetId: "f1", expectedVersion: 3 }] },
        300, 10]);
      let b = raw(store);
      assert.deepStrictEqual([b.open_clashes_json, b.clash_round, b.next_clash_at], ['["b1"]', 1, clock.now + 60000]);
      R.svc.runPass(clock.now + 1000);
      assert.strictEqual(R.created.length, 1, "next round only after intervalMs");

      const at = clock.now + 2000;
      const settled = settledOf("b1", at, CALDARI, spec.fixedDefenses.entries,
        (e) => ({ damage: e.sentryId.endsWith(":cruiser1") ? 50000 : 1000, destroyed: false }));
      const stale = { ...settled, fixedDefenses: [...settled.fixedDefenses, { sentryId: "wb:1:p2:bs1",
        itemId: 1099, hp: 1, ehp: 1, damage: 5, destroyed: false }] };
      const apply = () => store.transaction("test.wbc.settle", (tx) => R.svc.consequence.apply(tx, stale,
        "battle:b1:settle:1:c:worldBosses")).value;
      assert.deepStrictEqual(apply(), { ok: true, applied: 10, stale: 1, defeated: false });
      b = raw(store);
      const version = b.version;
      const units = JSON.parse(b.units_json);
      assert.deepStrictEqual([units.cruiser1, units.cruiser2, units.strike1], [0, 39000, 54000]);
      assert.deepStrictEqual([b.open_clashes_json, JSON.parse(b.damage_by_json)], ["[]", { [CALDARI]: 59000 }]);
      assert.deepStrictEqual(apply(), { ok: true, duplicate: true, applied: 0, stale: 0, defeated: false });
      assert.strictEqual(raw(store).version, version, "the same ck again = no write");
      const c = R.svc.getStatus().counters;
      assert.deepStrictEqual([c.clashes, c.damageApplied, c.staleDamage], [1, 10, 1]);
      assert.deepStrictEqual(R.svc.consequence.apply(null, { fixedDefenses: [{ sentryId: "zf:1:1" }] }, "x"),
        { ok: true, skipped: true });

      clock.now += 60000;
      R.svc.runPass(clock.now);
      assert.strictEqual(R.created.length, 2);
      assert.strictEqual(raw(store).open_clashes_json, '["b2"]');
      R.battleStates.set("b2", "QUARANTINED");
      R.svc.runPass(clock.now + 1000);
      assert.deepStrictEqual([raw(store).open_clashes_json, R.svc.getStatus().counters.clashDropped], ["[]", 1]);
    });
  });

  test("WBC3 last unit of the last phase -> DEFEATED, reward PENDING, top faction, end listener once after commit", () => {
    withStore(driver, ({ store }) => {
      const clock = { now: F.T0 };
      const R = rig(store, clock);
      const ends = [];
      R.svc.addEndListener((e) => ends.push([e.outcome, e.topFactionId]));
      const deltas = [];
      const killPhase = (n, factionId, damage) => {
        const row = rowOfStore(store, R.repo);
        const entries = C.buildEntries(row, DRIFTER, JSON.parse(row.unitsJson));
        const settled = settledOf(`k${n}`, clock.now + n, factionId, entries, () => ({ damage, destroyed: true }));
        return store.transaction("test.wbc.kill", (tx) => {
          const changes = () => tx.prepare("SELECT total_changes() AS n").get().n;
          const before = changes();
          const out = R.svc.consequence.apply(tx, settled, `battle:k${n}:settle:1:c:worldBosses`);
          deltas.push(changes() - before);
          return out;
        }).value;
      };
      assert.deepStrictEqual(killPhase(1, CALDARI, 90000), { ok: true, applied: 10, stale: 0, defeated: false });
      assert.strictEqual(raw(store).phase, 2);
      assert.deepStrictEqual(killPhase(2, AMARR, 1000), { ok: true, applied: 8, stale: 0, defeated: false });
      assert.deepStrictEqual(ends, [], "no end before the last phase");
      assert.deepStrictEqual(killPhase(3, AMARR, 1000), { ok: true, applied: 6, stale: 0, defeated: true });
      const b = raw(store);
      assert.deepStrictEqual([b.state, b.reward_state, b.top_faction_id, b.end_reason, b.site_event_id],
        ["DEFEATED", "PENDING", CALDARI, "DEFEATED", null]);
      assert.deepStrictEqual(JSON.parse(b.damage_by_json), { [CALDARI]: 900000, [AMARR]: 14000 });
      assert.deepStrictEqual(R.fk.cleanups, [[`wb:${b.boss_id}:v1`, "EVENT_END"]]);
      assert.strictEqual(deltas.length, 3);
      assert.ok(deltas.every((d) => d > 0 && d + 2 <= WORLD_BOSS_BATTLE_ROWS_BOUND), JSON.stringify(deltas));
      assert.deepStrictEqual(ends, [], "the listener waits for the commit (the next pass)");
      R.svc.runPass(clock.now + 10);
      R.svc.runPass(clock.now + 20);
      assert.deepStrictEqual(ends, [["DEFEATED", CALDARI]]);
      const events = store.transaction("test.wbc.journal", (db) => db.prepare(`SELECT event_type FROM
        world_event_journal WHERE aggregate_type = 'world_boss' AND event_type = 'WORLD_BOSS_ENDED'`).all());
      assert.strictEqual(events.value.length, 1);
      assert.deepStrictEqual([R.svc.getStatus().counters.defeated, R.svc.getStatus().counters.phaseCleared], [1, 3]);
    });
  });

  test("WBC5 sentries skip wb: entries (battleWorldBossSkipped); consequences have worldBosses only with clash on",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
        sentries: { ...CT.testConfig().sentries, enabled: true, battle: { ...CT.testConfig().sentries.battle,
          enabled: true } } };
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock: shared.clock,
        ids: shared.ids, nowMs: () => 0 });
      assert.ok(sr.ok, JSON.stringify(sr));
      const v = fakeVendor();
      const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: v.modules[rel] }) });
      const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock, scheduler: sr.scheduler,
        adapter: { sentrySeams: () => ({ ok: true, seam, optional: {} }), bindSentryPolicy: () => ({ ok: true }) },
        graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }) } });
      assert.ok(started.ok, JSON.stringify(started));
      const cons = lazySentriesConsequence(() => started.sentries);
      const units = C.buildEntries({ bossNo: 1, phase: 1, factionId: 500024 }, DRIFTER, phaseUnits(DRIFTER.phases[0]))
        .map((e) => ({ sentryId: e.sentryId, itemId: e.itemId, hp: e.hp, ehp: e.ehp, damage: 1000, destroyed: false }));
      const r = opened.store.transaction("t", (db) => cons.apply(db, { battleId: "b-wb", systemId: 30000005,
        at: shared.clock.now(), fixedDefenses: units }, "b-wb:c:sentries")).value;
      assert.deepStrictEqual(r, { ok: true, skipped: true });
      const c = started.service.getStatus().counters;
      assert.deepStrictEqual([c.battleWorldBossSkipped, c.battleTransitSkipped, c.battleFortressSkipped], [1, 0, 0]);
      started.sentries.stop("test");
      sr.scheduler.stop("test");

      const env = CT.createEnv(driver);
      try {
        const names = (clash) => {
          const c2 = JSON.parse(JSON.stringify(env.cfg));
          c2.worldBosses = { ...c2.worldBosses, enabled: true, clash: { ...c2.worldBosses.clash, enabled: clash } };
          env.battle.stop("test");
          const br = startBattle({ ...env.battleDeps, config: c2, getWorldBosses: () => null });
          assert.ok(br.ok, JSON.stringify(br));
          env.battle = br.battle;
          return [...br.battle.getStatus().consequences];
        };
        assert.ok(!names(false).includes("worldBosses"));
        const on = names(true);
        assert.strictEqual(on[on.length - 1], "worldBosses", JSON.stringify(on));
      } finally {
        env.close();
      }
    }));
};
