"use strict";

const assert = require("node:assert");

const { createGameMasterService } = require("../../lib/gameMaster/service");
const { createGameMasterRepository } = require("../../lib/gameMaster/repository");
const { cycleAtOrBefore } = require("../../lib/gameMaster/cycle");
const { buildOffer } = require("../../lib/gameMaster/digest");
const { upGameMaster } = require("../../lib/gameMaster/schema");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const HOUR = 3600000;
const T0 = 1763568000000 + HOUR;
const PLAYERS = Object.freeze([90000001, 90000002]);

function run(opened, fn) {
  const r = opened.store.transaction("g4", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("G4 game master service on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("G4 one thread per cycle (two passes, restart in DRAFTING); WAIT/NOTICE/NEWS -> ENDED/NEUTRAL; NOTICE twice "
    + "= one row per character; step_retries survive a new instance", () => {
    assert.ok(MIGRATIONS.some((m) => m.version === 114 && m.up === upGameMaster), "migration 114");
    assert.deepStrictEqual(["world_gm_cycles", "world_gm_threads", "world_gm_activity"].map((t) => TABLE_POLICY[t]),
      [ACTION.WIPE, ACTION.WIPE, ACTION.WIPE]);
    withStore(driver, (opened) => {
      const clock = { now: T0 };
      const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
      const noticeRepo = createNoticeRepository();
      const notices = { getStatus: () => ({ state: "running" }), enqueueItemsInTx: noticeRepo.enqueueItemsInTx };
      const presence = { getStatus: () => ({ available: true, stale: false }), observedSystems: () => [30000001],
        getSystemPresence: (id) => ({ characters: id === 30000001 ? PLAYERS.map((characterId) => ({ characterId }))
          : [] }) };
      const graph = F.graphFixture();
      const S = F.settingsOf({ enabled: true, maxPlaces: 3, arcCooldownCycles: 0, systemCooldownCycles: 0 });
      const senderDeps = { getNotices: () => notices, getPresence: () => presence, getGraph: () => graph };
      const { registry, sender } = F.registryWithBuiltins(S, senderDeps);
      const repo = createGameMasterRepository();
      const make = () => createGameMasterService({ store: opened.store, journal, worldSeed: 1, settings: S, registry,
        sender, getPresence: () => presence, getGraph: () => graph,
        readFactionNames: () => ({ ok: true, names: F.NAMES }) });
      const c = cycleAtOrBefore(T0, S);
      const threads = () => run(opened, (tx) => tx.prepare("SELECT * FROM world_gm_threads ORDER BY cycle_at").all());
      const noticeRows = (key) => run(opened, (tx) => tx.prepare(`SELECT character_id FROM world_notice_items
        WHERE event_key = ? ORDER BY character_id`).all(key)).map((r) => Number(r.character_id));

      const svc = make();
      assert.strictEqual(svc.runActivity(T0).regions, 1);
      assert.ok(svc.runPass(T0).ok);
      clock.now = T0 + 1000;
      assert.ok(svc.runPass(T0 + 1000).ok);
      let rows = threads();
      assert.strictEqual(rows.length, 1, "one thread for one cycle");
      const id = `gmt:${c}`;
      assert.deepStrictEqual([rows[0].thread_id, rows[0].arc, rows[0].source, rows[0].state, rows[0].step_state],
        [id, "WAR_RUMOUR", "template", "ACTIVE", "RUNNING"]);
      assert.strictEqual(svc.getStatus().counters["threads.started.template"], 1);
      assert.strictEqual(svc.getStatus().counters.cycles, 1);
      const steps = JSON.parse(rows[0].plan_json).steps.map((s) => s.kind);
      assert.deepStrictEqual(steps, ["NEWS", "NOTICE", "WAIT"]);
      assert.strictEqual(rows[0].step_no, 2, "NEWS and NOTICE done in the first pass, WAIT running");
      assert.ok([30000001, 30000002, 30000003].includes(rows[0].anchor_system_id), "a place of the active region");
      assert.deepStrictEqual(noticeRows(`gm:${id}:hook`), [...PLAYERS]);
      assert.deepStrictEqual(noticeRows(`gm:${id}:1`), [...PLAYERS]);
      assert.deepStrictEqual(run(opened, (tx) => tx.prepare("SELECT state, source, thread_id FROM world_gm_cycles")
        .all()), [{ state: "STARTED", source: "template", thread_id: id }]);

      const notice = registry.get("NOTICE");
      run(opened, (tx) => {
        for (let i = 0; i < 2; i += 1) {
          notice.startInTx(tx, { stepKey: `gm:${id}:1`, systemId: 30000001, params: { text: "Again." }, now: T0 });
        }
        return true;
      });
      assert.deepStrictEqual(noticeRows(`gm:${id}:1`), [...PLAYERS]);

      clock.now = T0 + 7 * HOUR;
      assert.ok(svc.runPass(clock.now).ok);
      rows = threads();
      assert.deepStrictEqual([rows[0].state, rows[0].outcome], ["ENDED", "NEUTRAL"]);
      assert.deepStrictEqual(JSON.parse(rows[0].step_results).map((r) => [r.kind, r.state, r.outcome]),
        [["NEWS", "DONE", "NEUTRAL"], ["NOTICE", "DONE", "NEUTRAL"], ["WAIT", "DONE", "NEUTRAL"]]);
      assert.deepStrictEqual(noticeRows(`gm:${id}:end`), [...PLAYERS]);
      const keys = run(opened, (tx) => tx.prepare("SELECT idempotency_key AS k FROM world_event_journal WHERE "
        + "idempotency_key LIKE "
        + "'gm:%' ORDER BY k").all()).map((r) => r.k);
      assert.deepStrictEqual(keys, [`gm:end:${id}`, `gm:start:${id}`, `gm:step:${id}:0`, `gm:step:${id}:1`,
        `gm:step:${id}:2`]);
      assert.strictEqual(svc.getStatus().counters["threads.ended.NEUTRAL"], 1);

      const c2 = c + 24 * HOUR;
      run(opened, (tx) => repo.insertCycleInTx(tx, { cycleAt: c2, now: c2 + 10 * 60000 }));
      const after = make();
      clock.now = c2 + 11 * 60000;
      assert.ok(after.runPass(clock.now).ok);
      assert.ok(after.runPass(clock.now + 1000).ok);
      rows = threads();
      assert.deepStrictEqual(rows.map((r) => r.cycle_at), [c, c2]);
      assert.strictEqual(after.getStatus().counters.cycles, 0, "tx A was done before the restart");

      registry.register(F.stubKind("RETRYK", { startInTx: () => ({ ok: false, reason: "BUSY", retry: true }) }));
      const plan = { v: 1, arc: "WAR_RUMOUR", source: "template", factionId: 500010, actorFactionId: null,
        systemId: 30000002, regionId: 10000001, title: "x", hook: "x", end: { won: "x", lost: "x" },
        steps: [{ kind: "RETRYK", version: 1, params: {}, durationMs: 0 }], textFallback: [] };
      const t1 = clock.now;
      run(opened, (tx) => repo.insertThreadInTx(tx, { threadId: "gmt:1000", cycleAt: 1000, arc: "WAR_RUMOUR",
        source: "template", factionId: 500010, actorFactionId: null, anchorSystemId: 30000002,
        planJson: JSON.stringify(plan), stepDueAt: t1, deadlineAt: t1 + 48 * HOUR, seed: 1, now: t1 }));
      assert.ok(make().runPass(t1).ok);
      assert.ok(make().runPass(t1 + S.stepRetryMs).ok);
      const retried = run(opened, (tx) => repo.readThreadInTx(tx, "gmt:1000"));
      assert.deepStrictEqual([retried.stepRetries, retried.stepState, retried.stepDueAt],
        [2, "PENDING", t1 + 2 * S.stepRetryMs]);

      const c3 = c2 + 24 * HOUR;
      const draft = createGameMasterService({ store: opened.store, journal, worldSeed: 1, settings: S,
        registry, sender, getGraph: () => graph });
      const value = run(opened, (tx) => {
        repo.insertCycleInTx(tx, { cycleAt: c3, now: c3 });
        const offer = buildOffer({ cycleAt: c3, seed: 9, graph, factionNames: F.NAMES, activityRows: [],
          recentThreads: [], registry, S }).offer;
        const raw = JSON.stringify({ v: 1, arc: "WAR_RUMOUR", faction: "guristas", place: offer.places[0].ref,
          title: "Rumour 7", hook: "Pilots talk.", steps: [{ t: "NEWS" }], end: { won: "Quiet.", lost: "Quiet." } });
        return draft.draftInTx(tx, repo.readCycleInTx(tx, c3), raw, "ai", { offer, seed: 9, now: c3 });
      });
      assert.deepStrictEqual([value.code, value.textFallback], ["STARTED", ["title"]]);
    });
  });
};
