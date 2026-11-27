"use strict";

const assert = require("node:assert");

const S = require("../../lib/worldBosses/schema");
const { CATALOG_V1, validateCatalog } = require("../../lib/worldBosses/catalog");
const { createWorldBossRepository } = require("../../lib/worldBosses/repository");
const { createWorldBossService } = require("../../lib/worldBosses/service");
const { startWorldBosses, createUnavailableWorldBosses, WORLD_BOSSES_METHODS } = require("../../lib/worldBosses");
const V = require("../../lib/worldBosses/view");
const { createViewRegistry } = require("../../lib/observer/views");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const KINDS = validateCatalog(CATALOG_V1);

function rows(store) {
  const r = store.transaction("test.wb.rows", (db) => db.prepare("SELECT * FROM world_bosses ORDER BY boss_no").all());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function serviceOf(store, journal, settings, fk, extra) {
  const graph = F.makeGraph();
  return createWorldBossService({ store, journal, repo: createWorldBossRepository({ journal }), worldSeed: 1,
    settings, kinds: KINDS.kinds, getGraph: () => graph, getPresence: () => fk.presence,
    getOccupation: () => fk.occupation, getSites: () => fk.sites, getWorldRepository: () => fk.worldRepository,
    ...(extra || {}) });
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("WB3-WB5 world bosses on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("WB3 roll -> DWELL -> MOVING (blight once) -> DWELL in the neighbour; restart continues from the row", () => {
    assert.ok(MIGRATIONS.some((m) => m.version === 117 && m.name === "world_bosses" && m.up === S.upWorldBosses));
    assert.ok(LATEST_SCHEMA_VERSION >= 117);
    assert.deepStrictEqual(["world_bosses", "world_boss_participants", "world_boss_payouts"].map((t) => TABLE_POLICY[t]),
      [ACTION.WIPE, ACTION.WIPE, ACTION.KEEP]);
    const P = F.settingsFor();
    withStore(driver, ({ store }) => {
      const clock = { now: F.T0 };
      const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
      const fk = F.fakes([1]);
      const svc = serviceOf(store, journal, P, fk);
      const first = svc.runPass(F.T0);
      assert.deepStrictEqual(first, { ok: true, rolled: 1, stepped: 0, ended: 0 });
      let [b] = rows(store);
      assert.deepStrictEqual([b.state, b.kind, b.faction_id, b.origin_kind, b.visit_no, b.hops, b.step_seq],
        ["DWELL", "drifter_swarm", 500024, "roll", 1, 0, 0]);
      assert.ok([3, 4, 5].includes(b.system_id), String(b.system_id));
      assert.strictEqual(b.site_event_id, `wb:${b.boss_id}:v1`);
      assert.deepStrictEqual(Object.keys(JSON.parse(b.units_json)), ["cruiser1", "cruiser2", "cruiser3", "cruiser4",
        "cruiser5", "cruiser6", "strike1", "strike2", "strike3", "strike4"]);
      const start = b.system_id;

      assert.deepStrictEqual(svc.runPass(F.T0 + 1000), { ok: true, rolled: 0, stepped: 0, ended: 0 }, "not due");
      clock.now = F.T0 + P.dwellMs;
      assert.strictEqual(svc.runPass(clock.now).stepped, 1);
      [b] = rows(store);
      assert.deepStrictEqual([b.state, b.step_seq, b.site_event_id], ["MOVING", 1, null]);
      assert.ok(Math.abs(b.next_system_id - start) === 1, `${start} -> ${b.next_system_id}`);
      assert.deepStrictEqual(fk.drops.map((d) => [d.key, d.factionId, d.points, d.allowNonController]),
        [[`wb:${b.boss_id}:blight:1`, 500001, 9, true]]);
      assert.deepStrictEqual(fk.cleanups, [[`wb:${b.boss_id}:v1`, "EVENT_END"]]);
      const version = b.version;
      assert.strictEqual(svc.runPass(clock.now).stepped, 0, "the same pass again = no change");
      assert.deepStrictEqual([rows(store)[0].version, fk.drops.length], [version, 1]);

      clock.now += P.hopMs;
      svc.runPass(clock.now);
      [b] = rows(store);
      const next = b.system_id;
      assert.deepStrictEqual([b.state, b.visit_no, b.hops, b.step_seq, b.next_system_id, b.site_event_id],
        ["DWELL", 2, 1, 2, null, `wb:${b.boss_id}:v2`]);
      assert.ok(Math.abs(next - start) === 1);

      const svc2 = serviceOf(store, journal, P, fk);
      clock.now += P.dwellMs;
      assert.deepStrictEqual(svc2.runPass(clock.now), { ok: true, rolled: 0, stepped: 1, ended: 0 });
      const all = rows(store);
      assert.strictEqual(all.length, 1, "no second boss in the same bucket");
      assert.deepStrictEqual([all[0].state, all[0].system_id, all[0].step_seq], ["MOVING", next, 3]);
      assert.deepStrictEqual(fk.drops.map((d) => d.key), [`wb:${b.boss_id}:blight:1`, `wb:${b.boss_id}:blight:2`]);
      const events = store.transaction("test.wb.journal", (db) => db.prepare(`SELECT event_type FROM
        world_event_journal WHERE aggregate_type = 'world_boss' ORDER BY journal_id`).all().map((r) => r.event_type));
      assert.deepStrictEqual(events.value, ["WORLD_BOSS_SPAWNED", "WORLD_BOSS_ROLLED", "WORLD_BOSS_MOVED",
        "WORLD_BOSS_ARRIVED", "WORLD_BOSS_MOVED"]);
    });
  });

  test("WB4 spawnInTx idempotent on originRef, BOSS_LIMIT, end listener EXPIRED after maxHops once, after commit", () => {
    const P = F.settingsFor({ EVEJS_LNE_WORLD_BOSSES_ROLL_ENABLED: "0", EVEJS_LNE_WORLD_BOSSES_MAX_HOPS: "1" });
    withStore(driver, ({ store }) => {
      const clock = { now: F.T0 };
      const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
      const fk = F.fakes([1]);
      const svc = serviceOf(store, journal, P, fk);
      const spawn = (ref, key) => {
        const r = store.transaction("test.wb.spawn", (tx) => svc.spawnInTx(tx, { kind: "drifter_swarm",
          originKind: "season", originRef: ref, at: clock.now }, key));
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const a = spawn("season:7:boss", "season:7:boss");
      assert.strictEqual(a.ok, true, JSON.stringify(a));
      assert.deepStrictEqual(spawn("season:7:boss", "season:7:boss"), { ok: true, bossId: a.bossId, duplicate: true });
      assert.deepStrictEqual(spawn("season:8:boss", "season:8:boss"), { ok: false, reason: "BOSS_LIMIT" });
      assert.deepStrictEqual(store.transaction("test.wb.bad", (tx) => svc.spawnInTx(tx, { kind: "drifter_swarm",
        originKind: "roll", originRef: "x", at: 1 }, "k")).value, { ok: false, reason: "INVALID_INPUT" });

      const seen = [];
      const reg = svc.addEndListener((e) => {
        const r = store.transaction("test.wb.listener", (db) => db.prepare("SELECT state FROM world_bosses")
          .get().state);
        seen.push([e.bossId, e.outcome, e.originRef, r.ok ? r.value : r.reason]);
      });
      assert.strictEqual(reg.ok, true);
      clock.now += P.dwellMs;
      svc.runPass(clock.now);
      clock.now += P.hopMs;
      svc.runPass(clock.now);
      assert.deepStrictEqual(seen, []);
      clock.now += P.dwellMs;
      assert.strictEqual(svc.runPass(clock.now).ended, 1);
      svc.runPass(clock.now + 1);
      assert.deepStrictEqual(seen, [[a.bossId, "EXPIRED", "season:7:boss", "EXPIRED"]]);
      const [b] = rows(store);
      assert.deepStrictEqual([b.state, b.end_reason, b.ended_at], ["EXPIRED", "MAX_HOPS", clock.now]);
      assert.strictEqual(svc.getStatus().counters.expired, 1);
    });
  });

  test("WB5 flag off: open boss -> CANCELLED (EVENT_CANCELLED) and stop; none -> one count, disabled_by_config; "
    + "stub keys; layer order 25 marks, panel order 73", () => {
    const off = F.configOf({});
    assert.strictEqual(off.config.worldBosses.enabled, false);
    assert.deepStrictEqual(off.warnings.filter((w) => w.startsWith("worldBosses")), []);
    const P = F.settingsFor({ EVEJS_LNE_WORLD_BOSSES_ROLL_ENABLED: "0" });
    withStore(driver, ({ store }) => {
      const clock = { now: F.T0 };
      const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
      const fk = F.fakes([1]);
      const svc = serviceOf(store, journal, P, fk);
      const made = store.transaction("test.wb.spawn", (tx) => svc.spawnInTx(tx, { kind: "drifter_swarm",
        originKind: "admin", originRef: "pm:1", at: clock.now }, "admin:pm:1"));
      assert.strictEqual(made.value.ok, true, JSON.stringify(made));
      const persistence = { ok: true, store, journal, worldSeed: 1 };
      const timers = [];
      const setTimer = (fn, ms) => {
        timers.push(ms);
        return { cancel() {}, hasRef: () => false };
      };
      const drain = startWorldBosses({ config: off.config, persistence, clock: { now: () => clock.now },
        getSites: () => fk.sites, getGraph: () => F.makeGraph(), setTimer });
      assert.strictEqual(drain.ok, true, JSON.stringify(drain));
      assert.deepStrictEqual(Object.keys(drain.worldBosses), [...WORLD_BOSSES_METHODS]);
      assert.deepStrictEqual(drain.worldBosses.spawnInTx(null, {}, "k"), { ok: false, reason: "WORLD_BOSSES_DISABLED" });
      const ends = [];
      drain.worldBosses.addEndListener((e) => ends.push(e.outcome));
      assert.strictEqual(drain.worldBosses.runPass(clock.now).left, 0);
      const [b] = rows(store);
      assert.deepStrictEqual([b.state, b.end_reason, ends], ["CANCELLED", "DRAIN", ["CANCELLED"]]);
      assert.deepStrictEqual(fk.cleanups, [[`wb:${b.boss_id}:v1`, "EVENT_CANCELLED"]]);
      assert.strictEqual(drain.worldBosses.getStatus().state, "stopped");

      const names = [];
      const counting = { isOpen: () => store.isOpen(), transaction: (name, fn) => {
        names.push(name);
        return store.transaction(name, fn);
      } };
      assert.deepStrictEqual(startWorldBosses({ config: off.config, persistence: { ...persistence, store: counting },
        clock: { now: () => clock.now }, setTimer }), { ok: false, reason: "disabled_by_config" });
      assert.deepStrictEqual(names, ["worldBosses.count"]);
    });
    const stub = createUnavailableWorldBosses("WORLD_BOSSES_DISABLED", "disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub), [...WORLD_BOSSES_METHODS]);
    assert.deepStrictEqual(stub.listOpenInTx(null), { ok: false, reason: "WORLD_BOSSES_DISABLED" });
    assert.deepStrictEqual(stub.battleConsequence.apply(), { ok: true, skipped: "NOT_READY" });

    const NOW = F.T0;
    const fakeStore = { isOpen: () => true, transaction: (name, fn) => ({ ok: true, value: fn({ name }) }) };
    const open = [{ bossId: "wb1-1", kind: "drifter_swarm", state: "MOVING", phase: 1, hpPermille: 1000, systemId: 5,
      nextSystemId: 6, nextDueAt: NOW + 120000 }];
    const repo = { listOpenInTx: (db, limit) => ({ ok: true, rows: open, limit, tx: db.name }) };
    const views = createViewRegistry();
    const layer = V.buildWorldBossesLayer({ store: fakeStore, repo, clock: { now: () => NOW },
      settings: { passIntervalMs: 60000 } });
    assert.strictEqual(views.registerView(V.LAYER_ID, layer).ok, true);
    assert.deepStrictEqual([V.LAYER_ID, layer.listed, layer.mapLayer], ["layer-bosses", false,
      { kind: "marks", order: 25 }]);
    assert.deepStrictEqual(layer.getData().items, [[5, "moving", "B",
      ["drifter_swarm phase 1 (100%) moving to 6, 2 min"], null]]);
    const panel = V.buildWorldBossesPanel({ store: fakeStore, repo, clock: { now: () => NOW },
      settings: { passIntervalMs: 60000 }, getStatus: () => ({ counters: { moves: 1 } }),
      systemNameOf: (id) => `S${id}` });
    assert.strictEqual(views.registerView(V.VIEW_ID, panel).ok, true);
    assert.deepStrictEqual([V.VIEW_ID, panel.order, panel.listed], ["world-bosses", 73, true]);
    const p = panel.getData();
    assert.deepStrictEqual([p.open[0].system, p.open[0].nextSystem, p.counters], ["S5", "S6", { moves: 1 }]);
    const hold = V.buildWorldBossesPanel({ store: fakeStore, repo, clock: { now: () => NOW },
      settings: { passIntervalMs: 60000 }, getGovernor: () => ({ admits: () => false }) });
    assert.deepStrictEqual(hold.getData(), { available: false, reason: "GOVERNOR_HOLD" });
  });
};
