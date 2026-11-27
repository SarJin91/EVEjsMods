"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createSiegeRepository } = require("../../lib/stations/siege/siegeRepository");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { createTail } = require("../../lib/notices/tail");
const { startNotices } = require("../../lib/notices");
const { createIdGenerator } = require("../../lib/util/ids");
const { createRng } = require("../../lib/util/rng");
const { createManualClock } = require("../../lib/util/clock");
const { resolveConfig } = require("../../config");
const F = require("./sourceFixture");
const { loadDriver, withStore } = require("./storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30002001;
const NEAR = 30002002;
const FAR = 30002003;
const C1 = 90000101;
const C2 = 90000102;
const C3 = 90000103;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

const EDGES = new Map([[SYS, [NEAR]], [NEAR, [SYS, FAR]], [FAR, [NEAR]]]);
const graph = Object.freeze({
  getNeighbors: (id) => EDGES.get(id) || null,
  getSystem: (id) => (EDGES.has(id) ? { systemId: id, name: `S-${id}`, regionId: 10000001 } : null),
  getRegionName: () => "Testregion",
});
const AT = new Map([[SYS, [C1]], [NEAR, [C2]], [FAR, [C3]]]);
const presence = Object.freeze({
  getStatus: () => ({ available: true, stale: false }),
  getSystemPresence: (id) => ({ characters: (AT.get(id) || []).map((characterId) => ({ characterId, name: "x",
    state: "space" })) }),
});

function baseSettings() {
  return resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1" } }).config.notices;
}

function env(opened) {
  const clock = createManualClock(T0);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const world = createWorldStateRepository({ journal, clock, limits: LIMITS });
  const sieges = createSiegeRepository({ journal, ids: createIdGenerator({ clock, rng: createRng(7) }) });
  const repo = createNoticeRepository();
  const store = opened.store;
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const counts = {};
  const added = { inserted: 0, duplicates: 0 };
  const makeTail = (overrides = {}, deps = {}) => createTail({ store, journal, repo,
    settings: { ...baseSettings(), ...overrides },
    enqueue: (db, items, now) => {
      const r = repo.enqueueItemsInTx(db, items, now);
      if (r.ok) {
        added.inserted += r.inserted;
        added.duplicates += r.duplicates;
      }
      return r;
    },
    getWorldRepository: () => world, getSiegeRepository: () => sieges, getPresence: () => presence,
    getGraph: () => ({ getGraph: () => ({ ok: true, graph }) }), adapter: null, listLimit: 500,
    bump: (name, n = 1) => {
      counts[name] = (counts[name] || 0) + n;
    }, ...deps });
  const rows = () => tx((db) => db.prepare(`SELECT event_key AS k, character_id AS c, kind, line
    FROM world_notice_items ORDER BY item_id`).all());
  let version = 0;
  const change = (state, reason, key) => {
    const r = tx((db) => world.applyChange(db, { systemId: SYS, expectedVersion: version, reason, state }, key));
    assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
    version = r.version;
    return r.journalId;
  };
  const war = () => {
    const p = F.occupationSteps(SYS);
    change({ occupationState: "CONTESTED", occupierFactionId: F.ATTACKER }, "OCCUPATION_SIGNAL", "nt:sig");
    const invasion = change(p.invade, "OCCUPATION_PHASE_CHANGE", "nt:inv");
    const capture = change(p.capture, "OCCUPATION_PHASE_CHANGE", "nt:cap");
    tx((db) => F.insertStation(db, "st-nt", SYS, F.DEFENDER, T0));
    const made = tx((db) => sieges.createSiege(db, F.siegeSpec("st-nt", SYS, T0), "nt:siege"));
    assert.ok(made.ok, JSON.stringify(made));
    const ended = tx((db) => sieges.transitionSiege(db, { siegeId: made.siegeId, expectedVersion: 1,
      from: "SHIELD_ASSAULT", to: "REPELLED", at: T0, patch: { endedAt: T0, endReason: "NO_ATTACKER" } }, "nt:end"));
    assert.ok(ended.ok, JSON.stringify(ended));
    return { invasion, capture };
  };
  const seed = () => change({ securityClass: "nullsec", controllerFactionId: F.DEFENDER }, "SEED_CONTROL", "nt:seed");
  return { clock, journal, world, sieges, repo, store, tx, counts, added, makeTail, rows, war, seed, change };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("NT1/NT2 notices tail", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NT1 tail: one pass queues the war for C1+C2, no second copy (pass, same window), lag jump, flush at stop",
    () => {
      withStore(driver, (opened) => {
        const e = env(opened);
        e.seed();
        const views = [];
        const t1 = e.makeTail({}, { hasWarListeners: () => true, onCommitted: (v) => views.push(...v) });
        const t2 = e.makeTail();
        const t3 = e.makeTail({ tailMaxLagRows: 2 });
        for (const t of [t1, t2, t3]) assert.ok(t.bootstrap().ok);
        assert.ok(t1.getStatus().marks >= 1);
        const ids = e.war();
        const now = e.clock.now();

        const first = t1.runPass(now);
        assert.deepStrictEqual([first.ok, first.events, first.items], [true, 4, 8], JSON.stringify(first));
        const got = e.rows();
        assert.deepStrictEqual(got.map((r) => [r.kind, r.c]), [["ATTACK_STARTED", C1], ["ATTACK_STARTED", C2],
          ["SYSTEM_CAPTURED", C1], ["SYSTEM_CAPTURED", C2], ["SIEGE_STARTED", C1], ["SIEGE_STARTED", C2],
          ["SIEGE_ENDED", C1], ["SIEGE_ENDED", C2]]);
        assert.strictEqual(got[0].k, `j:${ids.invasion}:ATTACK_STARTED`);
        assert.strictEqual(got[2].k, `j:${ids.capture}:SYSTEM_CAPTURED`);
        assert.ok(got[2].line.includes(`S-${SYS} (Testregion)`), got[2].line);
        assert.deepStrictEqual(t1.getStatus().lag, 0);
        assert.deepStrictEqual(views.map((v) => [v.kind, v.recipients, v.outcome]), [
          ["ATTACK_STARTED", [C1, C2], null], ["SYSTEM_CAPTURED", [C1, C2], null], ["SIEGE_STARTED", [C1, C2], null],
          ["SIEGE_ENDED", [C1, C2], "REPELLED"]]);
        assert.ok(views.every((v) => Object.isFrozen(v.recipients)));

        const second = t1.runPass(now);
        assert.deepStrictEqual([second.rows, second.items, e.rows().length], [0, 0, 8]);

        const before = { ...e.added };
        const again = t2.runPass(now);
        assert.deepStrictEqual([again.events, e.added.inserted - before.inserted, e.added.duplicates
          - before.duplicates, e.rows().length], [4, 0, 8, 8]);

        const lagged = t3.runPass(now);
        assert.deepStrictEqual([lagged.ok, lagged.items], [true, 0]);
        assert.ok(e.counts.tailSkippedLag >= 1, JSON.stringify(e.counts));
        assert.strictEqual(t3.getStatus().cursor, e.tx((db) => e.journal.headId(db)).headId);
        assert.strictEqual(e.rows().length, 8);

        const cfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1" } }).config;
        const adapter = { sendPlayerMail: () => ({ ok: true, messageId: 1 }),
          findPlayerMail: () => ({ ok: true, found: false }), defaultMailSender: () => ({ ok: true, senderId: 7 }) };
        const ctx = { persistence: { ok: true, store: e.store, journal: e.journal }, world: { repository: e.world },
          siege: { repository: e.sieges }, presence, graph: { getGraph: () => ({ ok: true, graph }) } };
        const started = startNotices({ config: cfg, ctx, adapter, clock: e.clock,
          setTimer: () => ({ cancel: () => {} }) });
        assert.ok(started.ok, JSON.stringify(started));
        assert.strictEqual(started.notices.getStatus().tail, "running");
        e.change({ occupationState: "STABLE", controllerFactionId: null, previousControllerFactionId: F.ATTACKER,
          occupierFactionId: null, capturedAt: null }, "OCCUPATION_ABANDON", "nt:release");
        started.notices.stop("test");
        assert.deepStrictEqual(e.rows().slice(8).map((r) => [r.kind, r.c]), [["SYSTEM_RELEASED", C1],
          ["SYSTEM_RELEASED", C2]]);
      });
    });

  test("NT2 tail maxItemsPerPass: stop before the overflowing row, the rest in later passes, no duplicate", () => {
    withStore(driver, (opened) => {
      const e = env(opened);
      e.seed();
      const t = e.makeTail({ maxItemsPerPass: 3 });
      assert.ok(t.bootstrap().ok);
      const ids = e.war();
      const head = e.tx((db) => e.journal.headId(db)).headId;
      const now = e.clock.now();
      const passes = [];
      for (let i = 0; i < 5; i += 1) {
        const r = t.runPass(now);
        assert.ok(r.ok, JSON.stringify(r));
        passes.push(r.items);
        if (i === 0) assert.strictEqual(r.cursor, ids.capture - 1, "stopped before the capture row");
      }
      assert.deepStrictEqual(passes, [2, 2, 2, 2, 0]);
      assert.strictEqual(t.getStatus().cursor, head);
      assert.deepStrictEqual([e.added.inserted, e.added.duplicates, e.rows().length], [8, 0, 8]);
    });
  });

  test("NT3 tail poison row: tailMaxFailedPasses failed passes on one cursor -> jump to the head, then new events",
    () => {
      withStore(driver, (opened) => {
        const e = env(opened);
        e.seed();
        let refuse = true;
        const lines = [];
        const t = e.makeTail({ tailMaxFailedPasses: 3 }, {
          enqueue: (db, items, now) => (refuse ? { ok: false, reason: "TEST_REFUSED" }
            : e.repo.enqueueItemsInTx(db, items, now)),
          log: (line) => lines.push(line) });
        assert.ok(t.bootstrap().ok);
        const start = t.getStatus().cursor;
        e.war();
        const head = e.tx((db) => e.journal.headId(db)).headId;
        const now = e.clock.now();
        for (let i = 0; i < 2; i += 1) {
          const r = t.runPass(now);
          assert.deepStrictEqual([r.ok, r.reason, t.getStatus().cursor], [false, "TEST_REFUSED", start]);
        }
        assert.strictEqual(e.counts.tailSkippedFailed, undefined);
        const third = t.runPass(now);
        assert.deepStrictEqual([third.ok, third.skippedFailed, third.cursor], [false, true, head], JSON.stringify(third));
        assert.deepStrictEqual([e.counts.tailSkippedFailed, e.counts.errors], [1, 3]);
        assert.strictEqual(lines.filter((l) => l.includes("failed passes")).length, 1, JSON.stringify(lines));
        assert.strictEqual(e.rows().length, 0);

        refuse = false;
        e.change({ occupationState: "STABLE", controllerFactionId: null, previousControllerFactionId: F.ATTACKER,
          occupierFactionId: null, capturedAt: null }, "OCCUPATION_ABANDON", "nt3:release");
        const after = t.runPass(now);
        assert.deepStrictEqual([after.ok, after.items], [true, 2], JSON.stringify(after));
        assert.deepStrictEqual(e.rows().map((r) => [r.kind, r.c]), [["SYSTEM_RELEASED", C1], ["SYSTEM_RELEASED", C2]]);

        const low = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_TAIL_MAX_FAILED_PASSES: "0" } });
        const high = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_TAIL_MAX_FAILED_PASSES: "500" } });
        assert.deepStrictEqual([baseSettings().tailMaxFailedPasses, low.config.notices.tailMaxFailedPasses,
          high.config.notices.tailMaxFailedPasses], [3, 1, 100]);
      });
    });
};
