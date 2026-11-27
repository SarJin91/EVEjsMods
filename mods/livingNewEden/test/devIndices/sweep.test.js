"use strict";

const assert = require("node:assert");

const S = require("../../lib/world/devIndices/schema");
const { createDevIndicesRepository } = require("../../lib/world/devIndices/repository");
const { createMemoryIndex } = require("../../lib/world/devIndices/memoryIndex");
const { createSweep } = require("../../lib/world/devIndices/sweep");
const { createKillboardRepository } = require("../../lib/killboard/repository");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const A = 500001;
const B = 500002;
const C = 500003;

function seed(store) {
  const r = store.transaction("test.dev.seed", (db) => {
    F.insertBattle(db, 5, F.T0 - 48 * F.HOUR, 1, [[A, "W"], [B, "L"]]);
    F.insertBattle(db, 10, F.T0 - 2 * F.HOUR, 1, [[A, "W"], [B, "L"]]);
    F.insertBattle(db, 20, F.T0 - F.HOUR, 2, [[B, "W"], [A, "L"]]);
    F.insertBattle(db, 30, F.T0 - 30 * F.MIN, 4, [[A, "W"], [B, "L"]]);
    F.insertBattle(db, 40, F.T0 - 10 * F.MIN, 3, [[C, "W"], [B, "L"]]);
    F.insertKill(db, 100, F.T0 - 3 * F.HOUR, 1, "PVE");
    F.insertKill(db, 101, F.T0 - 50 * F.MIN, 1, "PVE");
    F.insertKill(db, 102, F.T0 - 40 * F.MIN, 1, "PVP");
    F.insertKill(db, 103, F.T0 - 30 * F.MIN, null, "PVE");
  });
  assert.ok(r.ok, JSON.stringify(r));
}

function rig(store, env, over) {
  const P = F.settingsFor(env);
  const clock = { t: F.T0, now() { return this.t; } };
  const memory = createMemoryIndex({ P, clock });
  memory.markWarm();
  const world = F.makeWorld({ 1: { controllerFactionId: A, occupationState: "STABLE" },
    2: { controllerFactionId: B, occupationState: "STABLE" }, 3: { controllerFactionId: C, occupationState: "STABLE" } });
  const graph = F.makeGraph();
  const repo = createDevIndicesRepository();
  const sweep = createSweep({ store, repo: (over && over.repo) || repo, kbRepo: createKillboardRepository(), memory,
    settings: P, getGraph: () => graph, getWorldRepository: () => world, nowMs: () => 0 });
  return { P, clock, memory, world, repo, sweep };
}

function dbRows(store) {
  const r = store.transaction("test.dev.rows", (db) => ({
    rows: db.prepare("SELECT system_id, mil_points, ind_points, trade_points, controller_faction_id FROM "
      + "world_system_dev ORDER BY system_id").all().map((x) => [x.system_id, x.mil_points, x.trade_points,
      x.controller_faction_id]),
    cursors: db.prepare("SELECT source, after_no, facts FROM world_dev_cursors ORDER BY source").all()
      .map((x) => [x.source, x.after_no, x.facts]),
  }));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("DI3 sweep on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("DI3 sweep: bootstrap by PK, facts once, rollback before commit, cut at maxSystemsPerPass, rewind, refresh", () => {
    assert.ok(MIGRATIONS.some((m) => m.version === 118 && m.name === "dev_indices" && m.up === S.upDevIndices));
    assert.deepStrictEqual(["world_system_dev", "world_dev_cursors", "world_dev_investments"].map((t) => TABLE_POLICY[t]),
      [ACTION.WIPE, ACTION.WIPE, ACTION.KEEP]);

    withStore(driver, ({ store }) => {
      seed(store);
      const kb = createKillboardRepository();
      const probe = store.transaction("test.dev.probe", (db) => [kb.firstBattleNoAtOrAfter(db, F.T0 - 90 * F.MIN),
        kb.firstBattleNoAtOrAfter(db, F.T0 + F.HOUR), kb.firstKillIdAtOrAfter(db, F.T0 - 55 * F.MIN)]).value;
      assert.deepStrictEqual(probe.map((p) => p.key), [20, null, 101]);
      assert.ok(probe.every((p) => p.reads <= 40), JSON.stringify(probe));

      const h = rig(store);
      assert.deepStrictEqual(h.sweep.runPass(F.T0), { ok: true, systems: 3, facts: { kb_battles: 4, kb_kills: 3 } });
      const first = dbRows(store);
      assert.deepStrictEqual(first.rows, [[1, 48, 0, A], [2, 40, 0, B], [3, 40, 0, C]]);
      assert.deepStrictEqual(first.cursors, [["kb_battles", 40, 4], ["kb_kills", 103, 3]]);
      const c1 = h.sweep.getStatus().counters;
      assert.deepStrictEqual([c1["cursor.bootstrap"], c1["sweep.skippedSec"], c1["sweep.systems"]], [2, 2, 3]);
      assert.strictEqual(h.memory.levelsOf(1).milPoints, 48);

      assert.deepStrictEqual(h.sweep.runPass(F.T0), { ok: true, systems: 0, facts: { kb_battles: 0, kb_kills: 0 } });
      assert.deepStrictEqual(dbRows(store), first);

      assert.ok(store.transaction("test.dev.b50", (db) => F.insertBattle(db, 50, F.T0 + F.MIN, 1, [[A, "W"]])).ok);
      let boom = true;
      const failing = { ...h.repo, writeCursorInTx: (...a) => {
        if (boom) throw new Error("boom before commit");
        return h.repo.writeCursorInTx(...a);
      } };
      const hf = rig(store, null, { repo: failing });
      hf.memory.put(h.memory.get(1));
      const failed = hf.sweep.runPass(F.T0 + 2 * F.MIN);
      assert.strictEqual(failed.ok, false);
      assert.deepStrictEqual(dbRows(store), first, "rollback: points and cursors together");
      assert.strictEqual(hf.memory.levelsOf(1).milPoints, 48, "RAM untouched");
      boom = false;
      assert.strictEqual(hf.sweep.runPass(F.T0 + 2 * F.MIN).ok, true);
      assert.strictEqual(hf.sweep.runPass(F.T0 + 3 * F.MIN).systems, 0);
      assert.deepStrictEqual(dbRows(store).rows[0], [1, 88, 0, A], "battle 50 counted once");
      assert.strictEqual(hf.memory.levelsOf(1).milPoints, 88);

      assert.ok(store.transaction("test.dev.rewind", (db) => {
        db.prepare("DELETE FROM kb_kills").run();
        F.insertKill(db, 50, F.T0, 2, "PVE");
      }).ok);
      assert.strictEqual(hf.sweep.runPass(F.T0 + 4 * F.MIN).ok, true);
      assert.strictEqual(hf.sweep.getStatus().counters["cursor.rewound"], 1);
      assert.deepStrictEqual(dbRows(store).rows[1], [2, 44, 0, B]);
      assert.deepStrictEqual(dbRows(store).cursors[1], ["kb_kills", 50, 4]);

      assert.deepStrictEqual(hf.sweep.runRefresh(F.T0 + 8 * F.HOUR), { ok: true, rows: 3, deleted: 0 });
      assert.deepStrictEqual(dbRows(store).rows, [[1, 48, 0, A], [2, 4, 0, B], [3, 0, 0, C]]);
      assert.deepStrictEqual(hf.sweep.runRefresh(F.T0 + 8 * F.HOUR), { ok: true, rows: 0, deleted: 0 },
        "the same now again = no change");
      assert.deepStrictEqual(hf.sweep.runRefresh(F.T0 + 33 * F.HOUR), { ok: true, rows: 3, deleted: 3 });
      assert.deepStrictEqual(dbRows(store).rows, []);
      assert.strictEqual(hf.memory.get(3), null);
    });

    withStore(driver, ({ store }) => {
      seed(store);
      const h = rig(store, { EVEJS_LNE_DEV_INDICES_MAX_SYSTEMS_PER_PASS: "1",
        EVEJS_LNE_DEV_INDICES_RAT_KILL_MIL_POINTS: "0" });
      assert.deepStrictEqual(h.sweep.runPass(F.T0), { ok: true, systems: 1, facts: { kb_battles: 1, kb_kills: 0 } });
      assert.deepStrictEqual(dbRows(store).cursors, [["kb_battles", 10, 1]], "no kill page with ratKillMilPoints 0");
      assert.strictEqual(h.sweep.getStatus().counters["sweep.truncated"], 1);
      h.sweep.runPass(F.T0);
      assert.deepStrictEqual(dbRows(store), { rows: [[1, 40, 0, A], [2, 40, 0, B]],
        cursors: [["kb_battles", 30, 3]] }, "20 counted, 30 skipped (wormhole), cut before 40 (a new system)");
    });
  });

  test("DI21 sweep: kb_battles.lag 50 after a 200-row page of 250 battles, 0 after the next pass; gauge", () => {
    withStore(driver, ({ store }) => {
      for (let from = 1; from <= 250; from += 25) {
        const w = store.transaction("test.dev.lag", (db) => {
          for (let no = from; no < from + 25; no += 1) F.insertBattle(db, no, F.T0 - 10 * F.MIN, 1, [[A, "W"], [B, "L"]]);
        });
        assert.ok(w.ok, JSON.stringify(w));
      }
      const h = rig(store, { EVEJS_LNE_DEV_INDICES_SOURCE_PAGE_ROWS: "200",
        EVEJS_LNE_DEV_INDICES_RAT_KILL_MIL_POINTS: "0" });
      const gauges = new Map();
      const telemetry = { count() {}, observe() {}, gauge: (name, value) => gauges.set(name, value) };
      const sweep = createSweep({ store, repo: h.repo, kbRepo: createKillboardRepository(), memory: h.memory,
        settings: h.P, getGraph: () => F.makeGraph(), getWorldRepository: () => h.world, nowMs: () => 0, telemetry });
      const lagOf = () => sweep.getStatus().cursors.find((c) => c.source === "kb_battles").lag;
      assert.strictEqual(sweep.runPass(F.T0).ok, true);
      sweep.gauges(F.T0);
      assert.strictEqual(lagOf(), 50);
      assert.strictEqual(gauges.get("devIndices.lag.kb_battles"), 50);
      assert.strictEqual(sweep.runPass(F.T0 + F.MIN).ok, true);
      sweep.gauges(F.T0 + F.MIN);
      assert.strictEqual(lagOf(), 0);
      assert.strictEqual(gauges.get("devIndices.lag.kb_battles"), 0);
      assert.strictEqual(sweep.runPass(F.T0 + 2 * F.MIN).ok, true);
      assert.strictEqual(lagOf(), 0);
    });
  });
};
