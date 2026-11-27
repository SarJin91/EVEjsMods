"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { startScheduler } = require("../../lib/scheduler");
const { createEventStore } = require("../../lib/scheduler/eventStore");
const { resolveConfig } = require("../../config");
const { startRetention } = require("../../lib/retention");
const R = require("../../lib/retention/schema");
const { CLASSES, validateClasses } = require("../../lib/retention/classes");
const eventsSchema = require("../../lib/events/schema");
const salvageSchema = require("../../lib/world/salvageSchema");
const lowsecSchema = require("../../lib/strategy/lowsec/schema");
const expSchema = require("../../lib/strategy/expeditions/schema");
const capsSchema = require("../../lib/strategy/capsuleers/schema");
const sentrySchema = require("../../lib/sentries/schema");
const situationSchema = require("../../lib/situations/schema");
const { checkpointKey: transitCheckpointKey } = require("../../lib/strategy/transit/service");
const hraidSchema = require("../../lib/stations/harvestRaid/schema");
const lpostSchema = require("../../lib/listeningPosts/schema");
const sovSchema = require("../../lib/world/sovStructures/schema");
const travel = require("../../lib/fleets/travelService");
const contact = require("../../lib/battle/contactService");
const invasionSchema = require("../../lib/world/invasions/schema");
const economySchema = require("../../lib/economy/schema");
const siegeSchema = require("../../lib/stations/siege/schema");
const buildSchema = require("../../lib/stations/construction/schema");
const bannSchema = require("../../lib/battleAnnounce/schema");
const extractionSchema = require("../../lib/economy/extraction/schema");
const { intelKey: reviewIntelKey } = require("../../lib/strategy/reviewService");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const DAY = 86400000;
const OLD = START_MS - 8 * DAY;
const YOUNG = START_MS - DAY;
const FAR = START_MS + 30 * DAY;
const SETTINGS = Object.freeze({ maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 600000, maxOpenEvents: 50000,
  maxPayloadBytes: 4096, intervalMs: 1000, sliceMs: 4, claimBatchSize: 8, catchUpLagMs: 60000, backlogCountCap: 4096,
  chainedHeadroom: 1000 });
const LIMITS = Object.freeze({ maxDueEventsPerPass: 64, maxSchedulerWorkMs: 1000, maxCatchUpEventsPerPass: 32 });

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

async function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-ret-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  try {
    seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return await fn(opened.store);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], [], JSON.stringify(r.errors));
  return r.config;
}

const ON = Object.freeze({ EVEJS_LNE_RETENTION_ENABLED: "1", EVEJS_LNE_RETENTION_DRY_RUN: "0" });

function boot(store) {
  const clock = createManualClock(START_MS);
  const ids = createIdGenerator({ clock, rng: createRng(1) });
  const sr = startScheduler({ config: { enabled: true, modules: { scheduler: { enabled: true } },
    scheduler: { ...SETTINGS }, limits: { ...LIMITS } }, persistence: { ok: true, store }, clock, ids,
  nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const s = sr.scheduler;
  const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
  const eventStore = createEventStore({ clock, ids, limits: { maxPayloadBytes: 4096, maxAttempts: 5,
    retryBaseMs: 1000, retryMaxMs: 600000 } });
  const registered = [];
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const start = (env, over = {}) => {
    const scheduler = { ...s, ...over, registerHandler(type, fn, opts) {
      registered.push(type);
      return s.registerHandler(type, fn, opts);
    } };
    const lines = [];
    const r = startRetention({ config: configOf(env), persistence: { ok: true, store, journal }, scheduler, clock,
      logger: { log: (l) => lines.push(l) }, nowMs: () => 0 });
    return { r, lines };
  };
  const seed = (key, type, state, at) => {
    const e = s.enqueue(type, "agg", FAR, { k: key }, key);
    assert.ok(e.ok && !e.duplicate, JSON.stringify(e));
    if (state !== "QUEUED") {
      const final = state === "DONE" || state === "QUARANTINED";
      tx((db) => db.prepare("UPDATE world_scheduled_events SET state = ?, finished_at = ?, claimed_at = ?, "
        + "outcome = 'OK', last_error = 'x' WHERE idempotency_key = ?").run(state, final ? at : null,
        state === "CLAIMED" ? at : null, key));
    }
    return e.event.eventId;
  };
  const rows = () => tx((db) => db.prepare("SELECT idempotency_key AS k, state, event_type AS t "
    + "FROM world_scheduled_events ORDER BY idempotency_key").all());
  const keys = () => rows().map((r) => r.k);
  const chainRows = () => rows().filter((r) => r.k.startsWith(R.KEY_PREFIX));
  const runChain = async () => {
    const queued = tx((db) => db.prepare("SELECT due_at AS d FROM world_scheduled_events WHERE event_type = ? "
      + "AND state IN ('QUEUED', 'RETRY') ORDER BY due_at LIMIT 1").get(R.EVENT_TYPE));
    assert.ok(queued, "a queued RETENTION_PASS");
    clock.set(Math.max(clock.now(), Number(queued.d)));
    const p = await s.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    return p;
  };
  return { s, clock, journal, eventStore, registered, tx, start, seed, rows, keys, chainRows, runChain };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("R1 retention: off = no handler/row; scanKeys; dryRun counts only; budget 3 -> 3 + 2 deleted, young stay",
    async () => {
      await withStore(driver, async (store) => {
        const env = boot(store);
        const off = env.start({});
        assert.deepStrictEqual([off.r.ok, off.r.reason, env.registered.length, env.chainRows().length],
          [false, "disabled_by_config", 0, 0]);

        for (let r = 1; r <= 5; r += 1) env.seed(lowsecSchema.planKey(r), "LOWSEC_CAMP_PLAN", "DONE", OLD);
        for (const r of [6, 7]) env.seed(lowsecSchema.planKey(r), "LOWSEC_CAMP_PLAN", "DONE", YOUNG);

        const range = { fromKey: "lowsec:plan:", toKey: R.rangeEndOf("lowsec:plan:") };
        assert.strictEqual(range.toKey, "lowsec:plan;");
        const scan = env.tx((db) => env.s.scanKeys({ ...range, afterKey: null, limit: 2 }, { tx: db }));
        assert.deepStrictEqual(scan, { ok: true, rows: [
          { key: "lowsec:plan:1", eventType: "LOWSEC_CAMP_PLAN", state: "DONE", finishedAt: OLD },
          { key: "lowsec:plan:2", eventType: "LOWSEC_CAMP_PLAN", state: "DONE", finishedAt: OLD }] });
        const after = env.tx((db) => env.s.scanKeys({ ...range, afterKey: "lowsec:plan:5", limit: 10 }, { tx: db }));
        assert.deepStrictEqual(after.rows.map((r) => r.key), ["lowsec:plan:6", "lowsec:plan:7"]);
        assert.deepStrictEqual(env.s.scanKeys({ ...range, afterKey: null, limit: 1 }), { ok: false,
          reason: "TX_REQUIRED" });

        const dry = env.start({ ...ON, EVEJS_LNE_RETENTION_DRY_RUN: "1",
          EVEJS_LNE_RETENTION_MAX_DELETE_ROWS_PER_PASS: "3" });
        assert.ok(dry.r.ok, JSON.stringify(dry.r));
        assert.deepStrictEqual(env.registered, [R.EVENT_TYPE]);
        await env.runChain();
        const ds = dry.r.retention.getStatus();
        assert.deepStrictEqual([ds.state, ds.counters.candidates, ds.counters.deletedEvents, ds.counters.truncated],
          ["dry", 3, 0, 1]);
        assert.strictEqual(env.keys().filter((k) => k.startsWith("lowsec:plan:")).length, 7);
        dry.r.retention.stop();

        const on = env.start({ ...ON, EVEJS_LNE_RETENTION_MAX_DELETE_ROWS_PER_PASS: "3" });
        assert.ok(on.r.ok, JSON.stringify(on.r));
        assert.strictEqual(on.r.retention.getStatus().bootstrap.duplicate, true);
        await env.runChain();
        assert.deepStrictEqual(env.keys().filter((k) => k.startsWith("lowsec:plan:")),
          ["lowsec:plan:4", "lowsec:plan:5", "lowsec:plan:6", "lowsec:plan:7"]);
        await env.runChain();
        assert.deepStrictEqual(env.keys().filter((k) => k.startsWith("lowsec:plan:")),
          ["lowsec:plan:6", "lowsec:plan:7"]);
        const st = on.r.retention.getStatus();
        assert.deepStrictEqual([st.state, st.counters.deletedEvents, st.counters.passes,
          st.classes["lowsec-plan"].sweeps], ["on", 5, 2, 1]);
        assert.ok(on.lines.some((l) => l.startsWith("retention: sweep class=lowsec-plan deleted=5 ")),
          on.lines.join("\n"));
        const chain = env.chainRows();
        assert.strictEqual(chain.filter((r) => r.state === "QUEUED").length, 1, JSON.stringify(chain));
        assert.strictEqual(chain.filter((r) => r.state === "DONE").length, 3, JSON.stringify(chain));
      });
    });

  needsDriver("R2 retention: old QUEUED/RETRY(defer)/CLAIMED/QUARANTINED rows and the journal stay", async () => {
    await withStore(driver, async (store) => {
      const env = boot(store);
      env.seed("lowsec:plan:1", "LOWSEC_CAMP_PLAN", "QUEUED", null);
      const retryId = env.seed("lowsec:plan:2", "LOWSEC_CAMP_PLAN", "CLAIMED", OLD);
      const d = env.tx((db) => env.eventStore.defer(db, retryId, FAR, "hold"));
      assert.deepStrictEqual([d.ok, d.state], [true, "RETRY"]);
      env.seed("lowsec:plan:3", "LOWSEC_CAMP_PLAN", "CLAIMED", OLD);
      env.seed("lowsec:plan:4", "LOWSEC_CAMP_PLAN", "QUARANTINED", OLD);
      env.seed("lowsec:plan:5", "LOWSEC_CAMP_PLAN", "DONE", OLD);
      const agg = { type: "lowsec", id: "plan" };
      env.tx((db) => {
        assert.ok(env.journal.enqueueOutbox(db, { key: "lowsec:plan:9", aggregate: agg, eventType: "PLAN_OUT",
          payload: {} }).ok);
        assert.ok(env.journal.applyOnce(db, { key: "lowsec:plan:8", aggregate: agg, eventType: "PLAN_APPLIED",
          payload: {} }, () => ({ ok: true })).ok);
      });
      const journalRows = () => env.tx((db) => db.prepare("SELECT idempotency_key AS k, kind, state "
        + "FROM world_event_journal ORDER BY idempotency_key").all());
      const before = journalRows();
      const on = env.start(ON);
      assert.ok(on.r.ok, JSON.stringify(on.r));
      await env.runChain();
      const left = env.rows().filter((r) => r.k.startsWith("lowsec:plan:")).map((r) => [r.k, r.state]);
      assert.deepStrictEqual(left, [["lowsec:plan:1", "QUEUED"], ["lowsec:plan:2", "RETRY"],
        ["lowsec:plan:3", "CLAIMED"], ["lowsec:plan:4", "QUARANTINED"]]);
      assert.deepStrictEqual(journalRows(), before);
      assert.ok(before.some((r) => r.k === "lowsec:plan:9" && r.kind === "OUTBOX" && r.state === "PENDING"));
      assert.ok(before.some((r) => r.k === "lowsec:plan:8" && r.kind === "APPLY" && r.state === "APPLIED"));
      assert.deepStrictEqual([on.r.retention.getStatus().counters.skippedState,
        on.r.retention.getStatus().counters.deletedEvents], [4 + 1, 1]);
    });
  });

  needsDriver("R3 retention: a key outside the list (same prefix or other type) is still a duplicate after a pass",
    async () => {
      await withStore(driver, async (store) => {
        const env = boot(store);
        const neighbour = lowsecSchema.campKey(7, 500001);
        assert.strictEqual(neighbour, "lowsec:plan:7:f:500001");
        env.seed(neighbour, "LOWSEC_CAMP_STEP", "DONE", OLD);
        const sameType = lowsecSchema.campKey(7, 500002);
        env.seed(sameType, "LOWSEC_CAMP_PLAN", "DONE", OLD);
        env.seed("wreckexp:1", "WRECK_FIELD_EXPIRE", "DONE", OLD);
        env.seed(lowsecSchema.planKey(7), "LOWSEC_CAMP_PLAN", "DONE", OLD);
        const on = env.start(ON);
        assert.ok(on.r.ok, JSON.stringify(on.r));
        await env.runChain();
        assert.ok(!env.keys().includes("lowsec:plan:7"), "the class row went");
        const again = [[neighbour, "LOWSEC_CAMP_STEP"], [sameType, "LOWSEC_CAMP_PLAN"],
          ["wreckexp:1", "WRECK_FIELD_EXPIRE"]].map(([key, type]) => {
          const r = env.s.enqueue(type, "agg", FAR, { k: key }, key);
          return [key, r.ok, r.duplicate];
        });
        assert.deepStrictEqual(again, [[neighbour, true, true], [sameType, true, true], ["wreckexp:1", true, true]]);
        assert.ok(on.r.retention.getStatus().counters.skippedPattern >= 1);
      });
    });

  needsDriver("R4 retention: a purgeDone refusal deletes nothing; a new instance reaches the end state of a clean run",
    async () => {
      const fixture = (env) => {
        for (let r = 1; r <= 4; r += 1) env.seed(lowsecSchema.planKey(r), "LOWSEC_CAMP_PLAN", "DONE", OLD);
        env.seed(lowsecSchema.planKey(5), "LOWSEC_CAMP_PLAN", "DONE", YOUNG);
      };
      const clean = await withStore(driver, async (store) => {
        const env = boot(store);
        fixture(env);
        assert.ok(env.start(ON).r.ok);
        await env.runChain();
        return env.rows().map((r) => [r.k, r.state]);
      });
      const refused = await withStore(driver, async (store) => {
        const env = boot(store);
        fixture(env);
        const bad = env.start(ON, { purgeDone: () => ({ ok: false, reason: "BOOM" }) });
        assert.ok(bad.r.ok, JSON.stringify(bad.r));
        const before = env.rows();
        await env.runChain();
        assert.deepStrictEqual(env.rows().filter((r) => !r.k.startsWith(R.KEY_PREFIX)),
          before.filter((r) => !r.k.startsWith(R.KEY_PREFIX)));
        const pass = env.chainRows();
        assert.deepStrictEqual(pass.map((r) => r.state), ["RETRY"], JSON.stringify(pass));
        const bs = bad.r.retention.getStatus();
        assert.deepStrictEqual([bs.counters.refused, bs.counters.passes, bs.cursor], [1, 0,
          { classIndex: 0, afterKey: null }]);
        bad.r.retention.stop();
        const good = env.start(ON);
        assert.ok(good.r.ok, JSON.stringify(good.r));
        await env.runChain();
        return env.rows().map((r) => [r.k, r.state]);
      });
      assert.deepStrictEqual(refused, clean);
      assert.deepStrictEqual(clean.filter(([k]) => k.startsWith("lowsec:")), [["lowsec:plan:5", "DONE"]]);
    });

  test("R5 retention: class patterns match the keys of real builders, not their neighbours; validateClasses", () => {
    const I = 60000;
    const expected = [
      [R.passKey(I, 29333334), "retention-chain"],
      ["strategy:review:500001:42", "strategy-review"],
      [eventsSchema.pulseKey(I, 29333334), "events-pulse"],
      [eventsSchema.bootKey(I, 29333333), "events-pulse"],
      [eventsSchema.nudgeKey(I, 30000, 58666667), "events-pulse"],
      [salvageSchema.pulseKey(I, 29333334), "salvage-pulse"],
      [lowsecSchema.planKey(12), "lowsec-plan"],
      [expSchema.planKey(12), "whexp-plan"],
      [capsSchema.reviewKey(12), "capsuleer-review"],
      [sentrySchema.reconcileKey(12), "sentry-reconcile"],
      [sentrySchema.deployKey(sentrySchema.factionSentryId("a".repeat(64))), "sentry-deploy"],
      [sentrySchema.attritionKey(30002000, 1999), "sentry-attrition"],
      [sovSchema.reconcileKey(12, "CONTROL", "sovs:30002000:500019:4:1"), "sov-reconcile"],
      [sovSchema.reconcileKey(12, "ADOPT", ""), "sov-reconcile"],
      [bannSchema.checkKeyOf("op_1_1_a", 0), "battle-announce-check"],
      [bannSchema.checkKeyOf("op_1_1_a", 17), "battle-announce-check"],
      [bannSchema.announceKeyOf("op_1_1_a"), null],
      [`${bannSchema.checkKeyOf("op_1_1_a", 2)}:x`, null],
      [transitCheckpointKey(30000142, "fleet_1_a", 7), "transit-checkpoint"],
      [`${transitCheckpointKey(30000142, "fleet_1_a", 7)}:hit`, null],
      [hraidSchema.arrivalCheckKey(30000142, "fleet_1_a", 7), "hraid-check"],
      [hraidSchema.stepKey(hraidSchema.raidIdOf("metenox", 9001, 1760000000000), 2, 5), "hraid-step"],
      [hraidSchema.settleKey(hraidSchema.raidIdOf("metenox", 9001, 1760000000000)), "hraid-settle"],
      [hraidSchema.startKey(hraidSchema.raidIdOf("metenox", 9001, 1760000000000)), null],
      [hraidSchema.transitionKey(hraidSchema.raidIdOf("metenox", 9001, 1760000000000), 2), null],
      [lpostSchema.sightingKey(30000142, "fleet_1_a", 7), "lpost-sighting"],
      [`${lpostSchema.sightingKey(30000142, "fleet_1_a", 7)}:x`, null],
      [extractionSchema.pulseKey(300000, 5866667), "extraction-pulse"],
      [sentrySchema.stateKey("sp-7001", 12, 1), null],
      [lowsecSchema.campKey(12, 500010), null],
      [expSchema.expKey(12, 500010), null],
      [capsSchema.stipendKey(12, 3), null],
      ["strategy:review:1:2:3:LAUNCH", null],
      [eventsSchema.clearedKey("ev1"), null],
      [salvageSchema.jobKey("field1"), null],
    ];
    const got = expected.map(([key]) => {
      const hits = CLASSES.filter((c) => c.table === "events" && key >= c.prefix && key < R.rangeEndOf(c.prefix)
        && c.pattern.test(key));
      return [key, hits.length === 0 ? null : hits.map((c) => c.id).join("+")];
    });
    assert.deepStrictEqual(got, expected);
    assert.strictEqual(CLASSES.length, 50);
    const base = CLASSES.find((c) => c.id === "lowsec-plan");
    assert.throws(() => validateClasses([{ ...base, id: "std", prefix: "lne:std:" }]), TypeError);
    const two = (p1, p2) => () => validateClasses([{ ...base, id: "a", prefix: p1 }, { ...base, id: "b", prefix: p2 }]);
    assert.throws(two("foo:", "foo:bar:"), TypeError);
    assert.doesNotThrow(two("foo:", "fop:"));
  });

  const journalKeys = (env) => env.tx((db) => db.prepare("SELECT idempotency_key AS k FROM world_event_journal "
    + "ORDER BY idempotency_key").all()).map((r) => r.k);
  const applyRows = (env, keys) => env.tx((db) => {
    for (const key of keys) {
      const r = env.journal.applyOnce(db, { key, aggregate: { type: "fleet", id: "f" }, eventType: "J_TEST",
        payload: { key } }, () => ({ ok: true }));
      assert.deepStrictEqual([r.ok, r.duplicate], [true, false], JSON.stringify(r));
    }
  });
  const ageJournal = (env, except = []) => env.tx((db) => {
    for (const r of db.prepare("SELECT idempotency_key AS k FROM world_event_journal").all()) {
      if (!except.includes(r.k)) {
        db.prepare("UPDATE world_event_journal SET created_at = ? WHERE idempotency_key = ?").run(BigInt(OLD), r.k);
      }
    }
  });

  needsDriver("PDR1 purgeDone spec B: plan = key range on UNIQUE idempotency_key (no state index, no temp B-tree); "
    + "limit, finishedBefore, DONE of the type in range only", async () => {
    await withStore(driver, async (store) => {
      const env = boot(store);
      for (const r of [1, 2, 3]) env.seed(lowsecSchema.planKey(r), "LOWSEC_CAMP_PLAN", "DONE", OLD);
      env.seed(lowsecSchema.planKey(4), "LOWSEC_CAMP_PLAN", "DONE", YOUNG);
      env.seed(lowsecSchema.planKey(5), "LOWSEC_CAMP_PLAN", "QUEUED");
      env.seed(lowsecSchema.campKey(7, 500001), "LOWSEC_CAMP_STEP", "DONE", OLD);
      env.seed("lowsec:zz:1", "LOWSEC_CAMP_PLAN", "DONE", OLD);
      const spec = { eventType: "LOWSEC_CAMP_PLAN", fromKey: "lowsec:plan:", toKey: R.rangeEndOf("lowsec:plan:"),
        finishedBefore: START_MS - 2 * DAY, limit: 2 };
      const sqls = [];
      const first = env.tx((db) => env.eventStore.purgeDone({ inTransaction: true,
        prepare: (sql) => { sqls.push(sql); return db.prepare(sql); } }, spec));
      assert.deepStrictEqual(first, { ok: true, deleted: 2, notDone: [] });
      const rangeSql = sqls.filter((q) => q.startsWith("DELETE") && q.includes("idempotency_key >= ?"));
      assert.strictEqual(rangeSql.length, 1, "one spec B statement");
      const plan = env.tx((db) => db.prepare(`EXPLAIN QUERY PLAN ${rangeSql[0]}`)
        .all(spec.fromKey, spec.toKey, spec.eventType, spec.finishedBefore, spec.limit)).map((p) => p.detail);
      const text = plan.join(" | ");
      assert.ok(/INDEX sqlite_autoindex_world_scheduled_events_\d+ \(idempotency_key>\? AND idempotency_key<\?\)/
        .test(text), text);
      assert.ok(!text.includes("world_scheduled_events_state"), text);
      assert.ok(!text.includes("TEMP B-TREE"), text);
      assert.deepStrictEqual(env.keys().filter((k) => k.startsWith("lowsec:")), ["lowsec:plan:3", "lowsec:plan:4",
        "lowsec:plan:5", "lowsec:plan:7:f:500001", "lowsec:zz:1"]);
      const second = env.tx((db) => env.eventStore.purgeDone(db, { ...spec, limit: 10 }));
      assert.deepStrictEqual(second, { ok: true, deleted: 1, notDone: [] });
      assert.deepStrictEqual(env.keys().filter((k) => k.startsWith("lowsec:")), ["lowsec:plan:4", "lowsec:plan:5",
        "lowsec:plan:7:f:500001", "lowsec:zz:1"]);
    });
  });

  needsDriver("J2 retention journal: an open guard (RETRY after defer, QUARANTINED, QUEUED, CLAIMED) keeps the row, "
    + "a DONE or missing guard lets it go; dryRun deletes nothing; the guard event stays a duplicate", async () => {
    await withStore(driver, async (store) => {
      const env = boot(store);
      const retryId = env.seed("arrival:fA:1", "FLEET_ARRIVAL", "CLAIMED", OLD);
      const d = env.tx((db) => env.eventStore.defer(db, retryId, FAR, "WORMHOLE_SYNC_PENDING"));
      assert.deepStrictEqual([d.ok, d.state], [true, "RETRY"]);
      env.seed("arrival:fB:1", "FLEET_ARRIVAL", "QUARANTINED", OLD);
      env.seed("arrival:fC:1", "FLEET_ARRIVAL", "QUEUED", null);
      env.seed("arrival:fD:1", "FLEET_ARRIVAL", "CLAIMED", OLD);
      env.seed("arrival:fE:2", "FLEET_ARRIVAL", "DONE", YOUNG);
      env.seed("strategy:review:500001:7", "FACTION_STRATEGY_REVIEW", "DONE", YOUNG);
      const kept = ["arrival:fA:1", "arrival:fB:1:replan", "arrival:fC:1:reseek", "arrival:fD:1"];
      const gone = ["arrival:fE:2", "strategy:review:500001:7:touch", "strategy:review:500001:8:0:LAUNCH"];
      const young = "strategy:review:500001:9:touch";
      applyRows(env, [...kept, ...gone, young]);
      ageJournal(env, [young]);
      const all = journalKeys(env);

      const dry = env.start({ ...ON, EVEJS_LNE_RETENTION_DRY_RUN: "1" });
      assert.ok(dry.r.ok, JSON.stringify(dry.r));
      await env.runChain();
      const dc = dry.r.retention.getStatus().counters;
      assert.deepStrictEqual([dc.candidates, dc.skippedGuard, dc.deletedJournal], [7, 4, 0]);
      assert.deepStrictEqual(journalKeys(env), all);
      dry.r.retention.stop();

      const on = env.start(ON);
      assert.ok(on.r.ok, JSON.stringify(on.r));
      await env.runChain();
      assert.deepStrictEqual(journalKeys(env), [...kept, young].sort());
      const c = on.r.retention.getStatus().counters;
      assert.deepStrictEqual([c.deletedJournal, c.skippedGuard, c.deletedEvents], [3, 4, 0]);
      assert.strictEqual(on.r.retention.getStatus().classes["journal-arrival"].deleted, 1);
      assert.deepStrictEqual(env.rows().filter((r) => !r.k.startsWith(R.KEY_PREFIX)).map((r) => [r.k, r.state]), [
        ["arrival:fA:1", "RETRY"], ["arrival:fB:1", "QUARANTINED"], ["arrival:fC:1", "QUEUED"],
        ["arrival:fD:1", "CLAIMED"], ["arrival:fE:2", "DONE"], ["strategy:review:500001:7", "DONE"]]);
      const again = env.s.enqueue("FACTION_STRATEGY_REVIEW", "agg", FAR, { k: "strategy:review:500001:7" },
        "strategy:review:500001:7");
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
    });
  });

  needsDriver("J3 retention journal: OUTBOX (PENDING, APPLIED, FAILED) and APPLY keys outside the patterns stay; "
    + "applyOnce of a kept key is still a duplicate", async () => {
    await withStore(driver, async (store) => {
      const env = boot(store);
      const agg = { type: "fleet", id: "f" };
      const outbox = ["arrival:fO:1", "arrival:fO:2", "arrival:fO:3"];
      env.tx((db) => {
        const ids = outbox.map((key) => {
          const o = env.journal.enqueueOutbox(db, { key, aggregate: agg, eventType: "J_OUT", payload: { key } });
          assert.ok(o.ok, JSON.stringify(o));
          return o.journalId;
        });
        assert.ok(env.journal.markApplied(db, ids[1]).ok);
        assert.ok(env.journal.markFailed(db, ids[2], "boom").ok);
      });
      const outside = ["strategy:review:1:2:3:LAUNCH:fleet:x", "contact:1:arr:f:1:battle",
        "strategy:faction:seed:v1:1", "arrival:fK:1:replan:op-active"];
      const control = "arrival:fK:1";
      applyRows(env, [...outside, control]);
      ageJournal(env);
      const on = env.start(ON);
      assert.ok(on.r.ok, JSON.stringify(on.r));
      await env.runChain();
      const left = env.tx((db) => db.prepare("SELECT idempotency_key AS k, kind, state FROM world_event_journal "
        + "ORDER BY idempotency_key").all()).map((r) => [r.k, r.kind, r.state]);
      assert.deepStrictEqual(left, [
        ["arrival:fK:1:replan:op-active", "APPLY", "APPLIED"],
        ["arrival:fO:1", "OUTBOX", "PENDING"], ["arrival:fO:2", "OUTBOX", "APPLIED"], ["arrival:fO:3", "OUTBOX", "FAILED"],
        ["contact:1:arr:f:1:battle", "APPLY", "APPLIED"], ["strategy:faction:seed:v1:1", "APPLY", "APPLIED"],
        ["strategy:review:1:2:3:LAUNCH:fleet:x", "APPLY", "APPLIED"]]);
      const c = on.r.retention.getStatus().counters;
      assert.strictEqual(c.deletedJournal, 1);
      const again = env.tx((db) => outside.map((key) => {
        const r = env.journal.applyOnce(db, { key, aggregate: agg, eventType: "J_TEST", payload: { key } },
          () => ({ ok: true }));
        return [key, r.ok, r.duplicate];
      }));
      assert.deepStrictEqual(again, outside.map((key) => [key, true, true]));
    });
  });

  const INTEL_ID = "journal-review-intel";
  const intelKey = (f, s, b) => `strategy:intel:${f}:${s}:${b}`;

  needsDriver("RI1 retention intel: an old strategy:intel row goes when strategy:review:<f>:<b> is DONE or missing, "
    + "stays with an open guard (guarded); applyOnce of the next bucket works", async () => {
    await withStore(driver, async (store) => {
      const env = boot(store);
      env.seed("strategy:review:500001:7", "FACTION_STRATEGY_REVIEW", "DONE", YOUNG);
      env.seed("strategy:review:500001:9", "FACTION_STRATEGY_REVIEW", "QUEUED", null);
      const done = intelKey(500001, 30000142, 7);
      const open = intelKey(500001, 30000142, 9);
      const missing = intelKey(500002, 30000142, 5);
      applyRows(env, [done, open, missing]);
      ageJournal(env);
      const guardOf = CLASSES.find((c) => c.id === INTEL_ID).guard;
      assert.deepStrictEqual([guardOf(done), guardOf(open)], ["strategy:review:500001:7", "strategy:review:500001:9"]);

      const on = env.start(ON);
      assert.ok(on.r.ok, JSON.stringify(on.r));
      await env.runChain();
      assert.deepStrictEqual(journalKeys(env), [open]);
      const st = on.r.retention.getStatus();
      assert.deepStrictEqual([st.classes[INTEL_ID].deleted, st.classes[INTEL_ID].guarded,
        st.classes[INTEL_ID].candidates, st.counters.skippedGuard], [2, 1, 3, 1]);
      const next = env.tx((db) => env.journal.applyOnce(db, { key: intelKey(500001, 30000142, 8),
        aggregate: { type: "world_faction_intel", id: "500001:30000142" }, eventType: "INTEL_OBSERVED",
        payload: { b: 8 } }, () => ({ ok: true })));
      assert.deepStrictEqual([next.ok, next.duplicate], [true, false], JSON.stringify(next));
    });
  });

  needsDriver("RI2 retention intel: battle INTEL_OBSERVED rows, other strategy:intel shapes and young rows stay; "
    + "dryRun counts candidates and deletes nothing", async () => {
    await withStore(driver, async (store) => {
      const env = boot(store);
      const battle = "battle:b1:settle:v1:c:intel:f:500001";
      const shape = `${intelKey(500001, 30000142, 7)}:x`;
      const young = intelKey(500001, 30000142, 6);
      const old = intelKey(500001, 30000142, 5);
      applyRows(env, [battle, shape, young, old]);
      ageJournal(env, [young]);
      const all = journalKeys(env);

      const dry = env.start({ ...ON, EVEJS_LNE_RETENTION_DRY_RUN: "1" });
      assert.ok(dry.r.ok, JSON.stringify(dry.r));
      await env.runChain();
      const ds = dry.r.retention.getStatus();
      assert.deepStrictEqual([ds.classes[INTEL_ID].candidates, ds.classes[INTEL_ID].deleted, ds.counters.deletedJournal],
        [1, 0, 0]);
      assert.deepStrictEqual(journalKeys(env), all);
      dry.r.retention.stop();

      const on = env.start(ON);
      assert.ok(on.r.ok, JSON.stringify(on.r));
      await env.runChain();
      assert.deepStrictEqual(journalKeys(env), [battle, shape, young].sort());
      assert.strictEqual(on.r.retention.getStatus().classes[INTEL_ID].deleted, 1);
    });
  });

  needsDriver("RI3 retention status: guarded and lastSweepAt (clock.now() of the last full sweep, null before) are "
    + "added, the other fields stay; disabledClasses=journal-review-intel without a warning", async () => {
    await withStore(driver, async (store) => {
      const env = boot(store);
      const on = env.start(ON);
      assert.ok(on.r.ok, JSON.stringify(on.r));
      const before = on.r.retention.getStatus().classes[INTEL_ID];
      assert.deepStrictEqual(Object.keys(before),
        ["scanned", "deleted", "candidates", "sweeps", "afterKey", "guarded", "lastSweepAt"]);
      assert.deepStrictEqual([before.guarded, before.lastSweepAt], [0, null]);
      await env.runChain();
      const after = on.r.retention.getStatus().classes[INTEL_ID];
      assert.deepStrictEqual([after.sweeps, after.lastSweepAt], [1, env.clock.now()]);
      on.r.retention.stop();

      const env2 = { EVEJS_LNE_RETENTION_DISABLED_CLASSES: INTEL_ID };
      const rc = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...ON, ...env2 } });
      assert.deepStrictEqual((rc.warnings || []).filter((w) => w.includes("disabledClasses")), []);
      const off = env.start({ ...ON, ...env2 });
      assert.ok(off.r.ok, JSON.stringify(off.r));
      const ids = Object.keys(off.r.retention.getStatus().classes);
      assert.deepStrictEqual([ids.includes(INTEL_ID), ids.length], [false, CLASSES.length - 1]);
    });
  });

  test("J4 retention: F and journal patterns match the real builders (travel, contact), not their neighbours", () => {
    const ids = createIdGenerator({ clock: createManualClock(START_MS), rng: createRng(3) });
    const f = ids.next("fleet");
    assert.ok(!f.includes(":"), f);
    const s = 30000142;
    const expected = [
      [travel.arrivalKey(f, 4), "events:fleet-arrival+journal:journal-arrival"],
      [`${travel.arrivalKey(f, 4)}:replan`, "journal:journal-arrival"],
      [`${travel.arrivalKey(f, 4)}:reseek`, "journal:journal-arrival"],
      [travel.refitKey(f, 4), "events:fleet-refit"],
      [travel.refitSeekKey(f, 4, 2), "events:fleet-refitseek"],
      [contact.arrivalKey(s, f, 4), "events:contact-arrival"],
      ["strategy:review:500001:42:touch", "journal:journal-review-intent"],
      ["strategy:review:500001:42:3:LAUNCH", "journal:journal-review-intent"],
      ["strategy:review:500001:42", "events:strategy-review"],
      [reviewIntelKey(500001, 30000142, 42), "journal:journal-review-intel"],
      [sentrySchema.attritionJournalKey(30002000, 1999), "journal:journal-sentry-attrition"],
      [sentrySchema.attritionKey(30002000, 1999), "events:sentry-attrition"],
      [`${sentrySchema.attritionJournalKey(30002000, 1999)}:x`, null],
      [situationSchema.startKeyOf(30000142, 489861), "journal:journal-situations"],
      [situationSchema.settleKeyOf(situationSchema.situationIdOf(1763500000000, 3)), "journal:journal-situations"],
      [`${situationSchema.settleKeyOf(situationSchema.situationIdOf(1763500000000, 3))}:x`, null],
      [situationSchema.payoutKeyOf(situationSchema.situationIdOf(1763500000000, 3), 140000001), null],
      [extractionSchema.markerKey(500001, 81530), "journal:journal-extraction"],
      [extractionSchema.deliveryKey(500001, 81530, "st-a", 0), "journal:journal-extraction"],
      [extractionSchema.deliveryKey(500001, 81530, "upw-500001-30000142-1", 1), "journal:journal-extraction"],
      [`${extractionSchema.deliveryKey(500001, 81530, "st-a", 1)}:x`, null],
      [extractionSchema.fuelKey("upw-500001-30000142-1", 81530), "journal:journal-extraction-fuel"],
      [extractionSchema.conversionKey("st-a", 81530, 2317), "journal:journal-extraction-pic"],
      [`${extractionSchema.fuelKey("st-a", 81530)}:x`, null],
      ["strategy:intel:500001:30000142:42:x", null],
      ["battle:b1:settle:v1:c:intel:f:500001", null],
      [contact.demoKey(s), null],
      [contact.afterKey(s, "battle_1"), null],
      [contact.coolKey(s, "battle_1"), null],
      [invasionSchema.contactKey(s, "inv_1"), null],
      [travel.opDoneKey("op_1"), null],
      [`refit-done:${f}:4`, null],
      [`${travel.arrivalKey(f, 4)}:replan:op-active`, null],
      [`${travel.refitSeekKey(f, 4, 2)}:refit`, null],
      ["strategy:review:500001:42:3:LAUNCH:fleet:x", null],
      [economySchema.nudgeKey(f, 4, "MINING"), "events:mining-nudge"],
      [economySchema.reconcileKey("trip_1", 2, 0), null],
    ];
    const got = expected.map(([key]) => {
      const hits = CLASSES.filter((c) => key >= c.prefix && key < R.rangeEndOf(c.prefix) && c.pattern.test(key));
      return [key, hits.length === 0 ? null : hits.map((c) => `${c.table}:${c.id}`).join("+")];
    });
    assert.deepStrictEqual(got, expected);
    const guardOf = (id, key) => CLASSES.find((c) => c.id === id).guard(key);
    assert.deepStrictEqual([guardOf("journal-arrival", `${travel.arrivalKey(f, 4)}:reseek`),
      guardOf("journal-arrival", travel.arrivalKey(f, 4)), guardOf("journal-review-intent",
        "strategy:review:500001:42:3:LAUNCH"), guardOf("journal-sentry-attrition",
        sentrySchema.attritionJournalKey(30002000, 1999))], [travel.arrivalKey(f, 4), travel.arrivalKey(f, 4),
      "strategy:review:500001:42", sentrySchema.attritionKey(30002000, 1999)]);
    const jbase = CLASSES.find((c) => c.id === "journal-arrival");
    const ebase = CLASSES.find((c) => c.id === "fleet-arrival");
    assert.throws(() => validateClasses([{ ...jbase, guard: undefined }]), TypeError);
    assert.throws(() => validateClasses([{ ...ebase, guard: () => "x" }]), TypeError);
    assert.throws(() => validateClasses([{ ...jbase, id: "b", prefix: "battle:" }]), TypeError);
    assert.doesNotThrow(() => validateClasses([ebase, jbase]));
    assert.throws(() => validateClasses([jbase, { ...jbase, id: "j2" }]), TypeError);
  });

  const salvageBattleJob = salvageSchema.jobIdOf("wf:battle_1");
  const salvageSiegeJob = salvageSchema.jobIdOf("wf:st:60000001:2");
  const SUB3_CLASS_ROWS = Object.freeze([
    [economySchema.dueKey("mt_1_1_a", 3, 1), "MINING_TRIP_STEP", "mining-due"],
    [economySchema.nudgeKey("fl_1_1_a", 4, "STAGED"), "MINING_TRIP_STEP", "mining-nudge"],
    [economySchema.convoyDueKey("cv_1_1_a", 2, 0), "CONVOY_DELIVERY", "convoy-due"],
    [economySchema.convoyNudgeKey("fl_1_1_b", 5, "STAGED"), "CONVOY_DELIVERY", "convoy-nudge"],
    [economySchema.jobDueKey("pj_1_1_a", 2), "PRODUCTION_JOB_COMPLETE", "prod-due"],
    [capsSchema.stepKey("ct_1_1_a", 1, 3), "CAPSULEER_TRIP_STEP", "capsuleer-trip"],
    [capsSchema.nudgeKey("fl_1_1_c", 2, "IDLE"), "CAPSULEER_TRIP_STEP", "capsuleer-trip"],
    [siegeSchema.stepKey("sg_1_1_a", 2, 1), "STATION_SIEGE_STEP", "siege-step"],
    [buildSchema.buildDueKey("st_1_1_a", 1, 0), "STATION_BUILD_STEP", "build-due"],
    [lowsecSchema.stepKey("lc_1_1_a", 2), "LOWSEC_CAMP_STEP", "lowsec-step"],
    [lowsecSchema.waitKey("lc_1_1_a", 2, 1), "LOWSEC_CAMP_STEP", "lowsec-step"],
    [expSchema.stepKey("wx_1_1_a", 3), "WH_EXPEDITION_STEP", "whexp-step"],
    [expSchema.waitKey("wx_1_1_a", 3, 2), "WH_EXPEDITION_STEP", "whexp-step"],
    [salvageSchema.dueKey(salvageBattleJob, 2), "SALVAGE_JOB_ADVANCE", "salvage-phase"],
    [salvageSchema.dueKey(salvageSiegeJob, 3), "SALVAGE_JOB_ADVANCE", "salvage-phase"],
  ]);
  const SUB3_NEIGHBOURS = Object.freeze([
    [`${economySchema.reconcileKey("mt_1_1_a", 3, 1)}:0`, "MINING_TRIP_STEP", false],
    [`${economySchema.convoyReconcileKey("cv_1_1_a", 2, 0)}:0`, "CONVOY_DELIVERY", false],
    [economySchema.convoyLoadKey("cv_1_1_a"), "CONVOY_DELIVERY", false],
    [economySchema.convoyDeliverKey("cv_1_1_a"), "CONVOY_DELIVERY", false],
    [economySchema.convoyOrphanKey("fl_1_1_b", 5), "CONVOY_DELIVERY", false],
    [economySchema.consumeKey("pj_1_1_a"), "PRODUCTION_JOB_COMPLETE", false],
    [economySchema.deliverKey("pj_1_1_a"), "PRODUCTION_JOB_COMPLETE", false],
    [`${economySchema.jobReconcileKey("pj_1_1_a", 2)}:0`, "PRODUCTION_JOB_COMPLETE", false],
    [capsSchema.reconcileKey("ct_1_1_a", 1, 3), "CAPSULEER_TRIP_STEP", true],
    [`${capsSchema.reconcileKey("ct_1_1_a", 1, 3)}:0`, "CAPSULEER_TRIP_STEP", true],
    [siegeSchema.arrivalCheckKey(30000142, "fl_1_1_d", 2), "STATION_SIEGE_CHECK", true],
    [siegeSchema.startKey("s1", 2), "STATION_SIEGE_STEP", true],
    [siegeSchema.nativeKey("sg_1_1_a"), "STATION_SIEGE_STEP", true],
    [`${buildSchema.buildReconcileKey("st_1_1_a", 1, 0)}:0`, "STATION_BUILD_STEP", false],
    [buildSchema.buildAnchorKey("st_1_1_a"), "STATION_BUILD_STEP", false],
    [`${lowsecSchema.recBaseKey("lc_1_1_a", 2)}:0`, "LOWSEC_CAMP_STEP", false],
    [`${expSchema.recBaseKey("wx_1_1_a", 3)}:0`, "WH_EXPEDITION_STEP", false],
    [`${salvageSchema.reconcileKey(salvageBattleJob, 2)}:0`, "SALVAGE_JOB_ADVANCE", false],
    [salvageSchema.phaseKey(salvageBattleJob, 2), "SALVAGE_JOB_ADVANCE", true],
    [salvageSchema.dueKey(salvageBattleJob, 4), "SALVAGE_DELIVERY", true],
    [travel.opDoneKey("op_1_1_a"), "FLEET_OPERATION_COMPLETE", false],
    [invasionSchema.stepKey("inv_1_1_a", 2, 60000, 5), "INVASION_STEP", false],
  ]);
  const eventHits = (key, type) => CLASSES.filter((c) => c.table === "events" && key >= c.prefix
    && key < R.rangeEndOf(c.prefix) && c.pattern.test(key) && c.eventType === type).map((c) => c.id);

  needsDriver("S1 retention: an old DONE step / nudge key of every S and F class goes; reconcile slots, one-shot "
    + "keys, siege:chk / start / native, opdone, invasion and SALVAGE_DELIVERY stay", async () => {
    assert.deepStrictEqual(SUB3_CLASS_ROWS.map(([k, t]) => [k, eventHits(k, t)]),
      SUB3_CLASS_ROWS.map(([k, , id]) => [k, [id]]));
    assert.deepStrictEqual(SUB3_NEIGHBOURS.map(([k, t]) => [k, eventHits(k, t)]),
      SUB3_NEIGHBOURS.map(([k]) => [k, []]));
    await withStore(driver, async (store) => {
      const env = boot(store);
      for (const [key, type] of [...SUB3_CLASS_ROWS, ...SUB3_NEIGHBOURS]) env.seed(key, type, "DONE", OLD);
      const on = env.start(ON);
      assert.ok(on.r.ok, JSON.stringify(on.r));
      await env.runChain();
      const left = env.keys().filter((k) => !k.startsWith(R.KEY_PREFIX));
      assert.deepStrictEqual(left, SUB3_NEIGHBOURS.map(([k]) => k).sort());
      const st = on.r.retention.getStatus();
      const perClass = {};
      for (const [, , id] of SUB3_CLASS_ROWS) perClass[id] = (perClass[id] || 0) + 1;
      assert.deepStrictEqual(Object.keys(perClass).map((id) => [id, st.classes[id].deleted]),
        Object.entries(perClass));
      assert.strictEqual(st.counters.deletedEvents, SUB3_CLASS_ROWS.length);
      assert.strictEqual(st.counters.skippedPattern, SUB3_NEIGHBOURS.filter(([, , inRange]) => inRange).length);
      const [nk, nt] = SUB3_NEIGHBOURS[4];
      const again = env.s.enqueue(nt, "agg", FAR, { k: nk }, nk);
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
    });
  });

  needsDriver("S2 retention: old QUEUED / RETRY (defer) / CLAIMED / QUARANTINED rows of matching keys stay",
    async () => {
      await withStore(driver, async (store) => {
        const env = boot(store);
        const [queued, retry, claimed, quarantined, control] = [0, 7, 6, 14, 4].map((i) => SUB3_CLASS_ROWS[i]);
        env.seed(queued[0], queued[1], "QUEUED", null);
        const retryId = env.seed(retry[0], retry[1], "CLAIMED", OLD);
        const d = env.tx((db) => env.eventStore.defer(db, retryId, FAR, "hold"));
        assert.deepStrictEqual([d.ok, d.state], [true, "RETRY"]);
        env.seed(claimed[0], claimed[1], "CLAIMED", OLD);
        env.seed(quarantined[0], quarantined[1], "QUARANTINED", OLD);
        env.seed(control[0], control[1], "DONE", OLD);
        const on = env.start(ON);
        assert.ok(on.r.ok, JSON.stringify(on.r));
        await env.runChain();
        const left = env.rows().filter((r) => !r.k.startsWith(R.KEY_PREFIX)).map((r) => [r.k, r.state]);
        assert.deepStrictEqual(left, [[queued[0], "QUEUED"], [retry[0], "RETRY"], [claimed[0], "CLAIMED"],
          [quarantined[0], "QUARANTINED"]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
        assert.strictEqual(on.r.retention.getStatus().counters.deletedEvents, 1);
      });
    });

  test("S3 retention: validateClasses(CLASSES); no prefix of a queue class is a prefix of another; the deny "
    + "list and a second siege class are refused", () => {
    assert.strictEqual(validateClasses(CLASSES), CLASSES);
    const events = CLASSES.filter((c) => c.table === "events");
    const overlapping = [];
    for (const a of events) {
      for (const b of events) {
        if (a !== b && a.prefix.startsWith(b.prefix)) overlapping.push(`${a.id}<${b.id}`);
      }
    }
    assert.deepStrictEqual(overlapping, []);
    const base = CLASSES.find((c) => c.id === "capsuleer-trip");
    const two = (p1, p2) => () => validateClasses([{ ...base, id: "a", prefix: p1 }, { ...base, id: "b", prefix: p2 }]);
    assert.doesNotThrow(two("capsuleers:trip:", "capsuleers:review:"));
    assert.doesNotThrow(two("mining:due:", "mining:arr:"));
    assert.doesNotThrow(two("convoy:due:", "convoy:arr:"));
    assert.throws(two("siege:", "siege:chk:"), TypeError);
    assert.throws(() => validateClasses([{ ...base, id: "inv", prefix: "invasion:" }]), TypeError);
  });
};
