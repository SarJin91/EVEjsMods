"use strict";

const assert = require("node:assert");

const { startGameMaster } = require("../../lib/gameMaster");
const { createGameMasterRepository } = require("../../lib/gameMaster/repository");
const { createStepRegistry } = require("../../lib/gameMaster/registry");
const { createJournal } = require("../../lib/persistence/journal");
const { createViewRegistry } = require("../../lib/observer/views");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const T0 = 1763568000000;
const HOUR = 3600000;

function spyTimers() {
  const calls = [];
  return { calls, setTimer: (fn, ms) => {
    calls.push(ms);
    return { cancel() {}, hasRef: () => false };
  } };
}

function stubStore() {
  const sql = [];
  const db = { prepare: (text) => {
    sql.push(text.trim().replace(/\s+/g, " "));
    return { get: () => undefined, all: () => [], run: () => { throw new Error("write"); } };
  } };
  return { sql, store: { transaction: (_name, fn) => ({ ok: true, value: fn(db), rows: 0 }) } };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("G5 game master drain", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("G5 enabled=false: no timer, one SELECT without ACTIVE rows; ACTIVE+RUNNING -> cancelInTx(DISABLED), "
    + "CANCELLED, then disabled_by_config", () => {
    const clock = { now: () => T0 };
    const stub = stubStore();
    const t0 = spyTimers();
    const off = startGameMaster({ config: { enabled: true, gameMaster: F.sectionOf({ enabled: false }) },
      persistence: { ok: true, store: stub.store, journal: { applyOnce() { throw new Error("journal"); } } },
      clock, setTimer: t0.setTimer, registry: createStepRegistry() });
    assert.deepStrictEqual(off, { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(t0.calls, []);
    assert.strictEqual(stub.sql.length, 1, stub.sql.join("\n"));
    assert.ok(/^SELECT 1 AS one FROM world_gm_threads WHERE state = 'ACTIVE' LIMIT 1$/.test(stub.sql[0]), stub.sql[0]);

    withStore(driver, (opened) => {
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const repo = createGameMasterRepository();
      const registry = createStepRegistry();
      const cancels = [];
      registry.register(F.stubKind("STUBK", { cancelInTx: (_tx, s, reason) => {
        cancels.push([s.threadId, s.stepNo, reason]);
        return { ok: true };
      } }));
      const plan = { v: 1, arc: "WAR_RUMOUR", source: "template", factionId: 500010, actorFactionId: null,
        systemId: 30000001, regionId: 10000001, title: "x", hook: "x", end: { won: "x", lost: "x" },
        steps: [{ kind: "STUBK", version: 1, params: {}, durationMs: 0 }], textFallback: [] };
      const w = opened.store.transaction("g5.seed", (tx) => {
        const ins = repo.insertThreadInTx(tx, { threadId: "gmt:5", cycleAt: 5, arc: "WAR_RUMOUR", source: "template",
          factionId: 500010, actorFactionId: null, anchorSystemId: 30000001, planJson: JSON.stringify(plan),
          stepDueAt: T0, deadlineAt: T0 + 48 * HOUR, seed: 1, now: T0 - HOUR });
        assert.ok(ins.ok, JSON.stringify(ins));
        return repo.updateThreadInTx(tx, { threadId: "gmt:5", version: 1, patch: { stepState: "RUNNING" }, now: T0 });
      });
      assert.ok(w.ok && w.value.changed, JSON.stringify(w));
      const t1 = spyTimers();
      const lines = [];
      const r = startGameMaster({ config: { enabled: true, gameMaster: F.sectionOf({ enabled: false }) },
        persistence: { ok: true, store: opened.store, journal, worldSeed: 1 }, clock, setTimer: t1.setTimer,
        registry, logger: { log: (l) => lines.push(l) } });
      assert.deepStrictEqual(r, { ok: false, reason: "disabled_by_config" });
      assert.deepStrictEqual(t1.calls, []);
      assert.deepStrictEqual(cancels, [["gmt:5", 0, "DISABLED"]]);
      const row = opened.store.transaction("g5.read", (tx) => repo.readThreadInTx(tx, "gmt:5")).value;
      assert.deepStrictEqual([row.state, row.outcome, row.endedAt], ["CANCELLED", null, T0]);
      const key = opened.store.transaction("g5.key", (tx) => tx.prepare("SELECT event_type FROM world_event_journal "
        + "WHERE idempotency_key = 'gm:end:gmt:5'").get()).value;
      assert.deepStrictEqual({ ...key }, { event_type: "GM_THREAD_ENDED" });
      assert.ok(lines.some((l) => l.startsWith("gameMaster: drained 1 thread")), lines.join("\n"));

      const t2 = spyTimers();
      const shared = createStepRegistry();
      const views = createViewRegistry();
      const on = startGameMaster({ config: { enabled: true, modules: { world: { enabled: true } },
        gameMaster: F.sectionOf({ enabled: true }) }, persistence: { ok: true, store: opened.store, journal,
        worldSeed: 1 }, clock, setTimer: t2.setTimer, registry: shared, views });
      assert.ok(on.ok, JSON.stringify(on));
      assert.strictEqual(t2.calls.length, 2);
      assert.deepStrictEqual(shared.list().map((k) => k.type), ["NEWS", "NOTICE", "WAIT"]);
      assert.deepStrictEqual(views.listViews().map((v) => v.id), ["game-master"]);
      const data = views.getView("game-master").getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(data.threads.map((t) => [t.threadId, t.state, t.label, t.kind]),
        [["gmt:5", "CANCELLED", "War Rumour", "STUBK"]]);
      assert.ok(!/"(title|hook|text|won|lost)"/.test(JSON.stringify(data)), "no plan text in the panel");
      on.gameMaster.stop();
      assert.deepStrictEqual(shared.list(), []);
      assert.strictEqual(views.getView("game-master"), null);
    });
  });
};
