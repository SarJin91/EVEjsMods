"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../../config");
const { openStore } = require("../../../lib/persistence/store");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../../../lib/persistence/migrations");
const { toTrip } = require("../../../lib/strategy/capsuleers/tripRepository");
const { createCorpRepository } = require("../../../lib/strategy/capsuleers/corpRepository");
const { createJournal } = require("../../../lib/persistence/journal");
const { createViewRegistry } = require("../../../lib/observer/views");
const { startScheduler } = require("../../../lib/scheduler");
const { startFleets } = require("../../../lib/fleets");
const { buildDefaultServiceDefs } = require("../../../lib/runtime/services");
const { startCapsuleers } = require("../../../lib/strategy/capsuleers");
const CS = require("../../../lib/strategy/capsuleers/schema");
const { FLEET_TEMPLATES } = require("../../../lib/strategy/data/capsuleers");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SANSHA = 500019;
const AMARR = 500003;
const CAPS = 500018;
const S = H.S;
const STATION = 60000100;
const STATION_CORP = 1000100;
const LINKED = Object.freeze({ ok: true, state: "LINKED", corporationId: 98000001, ceoCharacterId: 90000001,
  characterIds: [90000001, 90000002, 90000003], name: "Iron Wardens Corp", ticker: "IWC" });

function testConfig(capsuleers) {
  const cfg = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  if (capsuleers) Object.assign(cfg.capsuleers, { enabled: true }, capsuleers);
  cfg.limits.maxVirtualFleets = 3;
  return cfg;
}

function boot(opened, shared, cfg) {
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const store = opened.store;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: cfg.persistence.journalMaxPayloadBytes,
    maxRows: 500 });
  const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed, filePath: "test.sqlite" };
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    logger, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const graph = { getGraph: () => ({ ok: true, graph: shared.graph }) };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph, presence: null, views: createViewRegistry(), logger });
  assert.ok(fr.ok, JSON.stringify(fr));
  const calls = { registerHandler: 0, enqueue: 0 };
  const handlers = {};
  const scheduler = { ...sr.scheduler,
    registerHandler: (type, fn, o) => {
      calls.registerHandler += 1;
      handlers[type] = fn;
      return sr.scheduler.registerHandler(type, fn, o);
    },
    enqueue: (...args) => {
      calls.enqueue += 1;
      return sr.scheduler.enqueue(...args);
    } };
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const env = { store, tx, lines, calls, handlers, shared, cfg, fleets: fr.fleets, identities: new Map(),
    ensured: [] };
  env.q = (sql, ...args) => tx((db) => db.prepare(sql).all(...args));
  env.n = (sql, ...args) => env.q(sql, ...args)[0].n;
  const virtualCorps = {
    getOwnerIdentity: (kind, slot) => env.identities.get(slot) || { ok: true, state: "PENDING" },
    ensureOwnerIdentity: (spec) => {
      env.ensured.push({ spec, rowsSeen: env.n("SELECT count(*) AS n FROM world_capsuleer_corps") });
      return { ok: true, queued: true };
    },
    getMapVersion: () => 1,
  };
  const strategy = { registry: { listActiveFactions: () => [{ factionId: AMARR, kind: "empire" },
    { factionId: SANSHA, kind: "pirate" }], isActive: (id) => id === AMARR || id === SANSHA },
  getStatus: () => ({ state: "running" }) };
  const world = { repository: { listControlledByFaction: (db, factionId, opts) => {
    assert.strictEqual(db.inTransaction, true);
    assert.strictEqual(opts.limit, cfg.capsuleers.pirateSystemsReadMax);
    return { ok: true, systems: factionId === SANSHA ? [{ systemId: S.N0 }] : [], nextAfterSystemId: null };
  } } };
  const adapter = { listNpcStationsInSystem: (systemId) => ({ ok: true, stations: systemId === S.L1
    ? [{ stationId: STATION, corporationId: STATION_CORP, name: "Base" }] : [] }) };
  const ctx = { config: cfg, persistence, scheduler, fleets: fr.fleets, strategy, virtualCorps, graph, world,
    adapter, views: createViewRegistry(), clock: shared.clock, ids: shared.ids, telemetry: null };
  const def = buildDefaultServiceDefs({}).find((d) => d.name === "capsuleers");
  env.started = def.start(ctx, { logger });
  if (!env.started.ok) def.onUnavailable(ctx, env.started.reason);
  env.ctx = ctx;
  env.stop = () => {
    if (ctx.capsuleers) ctx.capsuleers.stop("test");
    fr.fleets.stop("test");
    sr.scheduler.stop("test");
  };
  env.drive = async (untilMs) => {
    for (let i = 0; i < 20000; i += 1) {
      const r = await sr.scheduler.runPass();
      assert.ok(r.ok, JSON.stringify(r));
      const now = shared.clock.now();
      if (!r.skipped && r.jobs > 0) continue;
      if (now >= untilMs) return;
      const next = sr.scheduler.getStatus().nextDueAt;
      shared.clock.set(Math.min(untilMs, next === null || next <= now ? now + cfg.scheduler.intervalMs : next));
    }
    throw new Error("drive: no end");
  };
  env.corp = () => env.q("SELECT * FROM world_capsuleer_corps WHERE corp_slot = 1")[0];
  env.capsFleets = () => env.q("SELECT fleet_id, faction_id, corporation_id, fleet_role, state, current_system_id, "
    + "home_system_id, composition_json FROM virtual_fleets WHERE faction_id = ? AND state != 'DESTROYED' "
    + "ORDER BY created_at, fleet_id", CAPS);
  env.replay = (round) => {
    const row = env.q("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?", CS.reviewKey(round))[0];
    const ev = { eventId: row.event_id, eventType: row.event_type, aggregateId: row.aggregate_id, dueAt: row.due_at,
      payload: JSON.parse(row.payload), idempotencyKey: row.idempotency_key };
    const res = env.handlers[CS.REVIEW_EVENT](ev, { anchorAt: ev.dueAt });
    assert.ok(res.ok, JSON.stringify(res));
    const v = tx((db) => res.effect(db, ev));
    res.onCommitted(v);
    return v;
  };
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("C3 review: found -> ensure after commit, LINKED -> ACTIVE, buy fleet + debit, replay no "
    + "duplicate, FLEET_LIMIT wallet unchanged, maxFleetsPerCorp stops buys; flag off = stub, no event", async () => {
    await H.withStore(driver, async (reopen) => {
      const env = boot(reopen(), H.sharedOf(), testConfig());
      try {
        assert.deepStrictEqual([env.started.ok, env.started.reason], [false, "disabled_by_config"]);
        assert.deepStrictEqual([env.ctx.capsuleers.getMode(), env.ctx.capsuleers.getStatus().reason],
          ["off", "CAPSULEERS_DISABLED"]);
        assert.deepStrictEqual(env.calls, { registerHandler: 0, enqueue: 0 });
        assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key LIKE "
          + "'capsuleers:%'"), 0);
        assert.strictEqual(startCapsuleers({ config: testConfig() }).reason, "disabled_by_config");
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({ maxCorps: 1, maxFleetsPerCorp: 3 }));
      const C = env.cfg.capsuleers;
      const P = C.reviewPeriodMs;
      try {
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        const r1 = Math.floor(shared.clock.now() / P) + 1;
        await env.drive(r1 * P);
        const founded = env.corp();
        assert.deepStrictEqual([founded.state, founded.faction_id, founded.base_system_id, founded.base_station_id,
          founded.base_station_corp_id, founded.isk_balance, founded.corporation_id],
        ["FOUNDING", CAPS, S.L1, STATION, STATION_CORP, C.initialIsk, null]);
        assert.strictEqual(env.ensured.length, 1, JSON.stringify(env.ctx.capsuleers.getStatus()));
        const spec = env.ensured[0].spec;
        assert.strictEqual(env.ensured[0].rowsSeen, 1);
        assert.deepStrictEqual([spec.ownerKind, spec.ownerId, spec.corporation.name, spec.corporation.ticker,
          spec.members, spec.stationId, spec.stationCorporationId, spec.systemId, spec.constellationId, spec.regionId],
        ["capsuleer", 1, founded.name, founded.ticker, C.membersPerCorp, STATION, STATION_CORP, S.L1, 20000201,
          10000001]);
        env.identities.set(1, LINKED);
        await env.drive((r1 + 1) * P);
        const active = env.corp();
        assert.deepStrictEqual([active.state, active.corporation_id, active.ceo_character_id,
          JSON.parse(active.member_ids_json), active.name, active.ticker, active.isk_balance],
        ["ACTIVE", LINKED.corporationId, LINKED.ceoCharacterId, LINKED.characterIds, LINKED.name, LINKED.ticker,
          C.initialIsk]);
        await env.drive((r1 + 2) * P);
        const fleets3 = env.capsFleets();
        assert.strictEqual(fleets3.length, 1);
        const f = fleets3[0];
        const buy = JSON.parse(env.q("SELECT payload FROM world_event_journal WHERE idempotency_key = ?",
          CS.buyKey(r1 + 2, 1))[0].payload);
        const template = FLEET_TEMPLATES.find((t) => t.templateId === buy.templateId);
        assert.deepStrictEqual([f.faction_id, f.corporation_id, f.fleet_role, f.state, f.current_system_id,
          f.home_system_id, JSON.parse(f.composition_json), buy.costIsk],
        [CAPS, LINKED.corporationId, "capsuleer", "IDLE", S.L1, S.L1, template.composition.map((e) => ({ ...e })),
          template.costIsk]);
        const wallet3 = C.initialIsk + C.stipendIskPerReview - template.costIsk;
        assert.deepStrictEqual([env.corp().isk_balance, env.corp().fleets_bought], [wallet3, 1]);
        const before = { fleets: env.capsFleets().length, corp: env.corp(),
          journal: env.n("SELECT count(*) AS n FROM world_event_journal") };
        const v = env.replay(r1 + 2);
        assert.deepStrictEqual([v.bought.length, v.stipends], [0, 0]);
        assert.deepStrictEqual({ fleets: env.capsFleets().length, corp: env.corp(),
          journal: env.n("SELECT count(*) AS n FROM world_event_journal") }, before);
        const fillers = ["a", "b"].map((tag) => {
          const r = env.fleets.createFleet({ factionId: AMARR, currentSystemId: S.H1, homeSystemId: S.H1,
            fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 1 }] }, `test:filler:${tag}`);
          assert.ok(r.ok, JSON.stringify(r));
          return r.fleetId;
        });
        await env.drive((r1 + 3) * P);
        assert.deepStrictEqual([env.capsFleets().length, env.corp().isk_balance, env.corp().fleets_bought,
          env.ctx.capsuleers.getStatus().counters.fleetLimit], [1, wallet3 + C.stipendIskPerReview, 1, 1]);
        env.tx((db) => {
          const d = env.fleets.repository.disband(db, { fleetId: fillers[0], expectedVersion: 1, systemId: S.H1,
            fleetRole: "patrol" }, "test:disband");
          assert.ok(d.ok, JSON.stringify(d));
        });
        await env.drive((r1 + 4) * P);
        assert.deepStrictEqual([env.capsFleets().length, env.corp().fleets_bought], [2, 2]);
        const wallet5 = env.corp().isk_balance;
        await env.drive((r1 + 5) * P);
        const st = env.ctx.capsuleers.getStatus();
        assert.deepStrictEqual([env.capsFleets().length, env.corp().fleets_bought, env.corp().isk_balance,
          st.counters.fleetsBought, st.counters.fleetLimit, st.counters.founded, st.counters.activated],
        [2, 2, wallet5 + C.stipendIskPerReview, 2, 1, 1, 1]);
        const view = env.ctx.views.getView("capsuleers");
        const data = view.getData();
        assert.deepStrictEqual([view.title, data.rows.length, data.rows[0].fleets, data.rows[0].corporationId],
          ["Capsuleer Corporations", 1, "2/2", LINKED.corporationId]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("CFB1: fleet budget on through the real countByState - buy with room, budget "
    + "refusal when the world is full", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({ maxCorps: 1, maxFleetsPerCorp: 3, fleetBudgetEnabled: true,
        maxFleetsTotal: 10, minFleetHeadroom: 0 }));
      const P = env.cfg.capsuleers.reviewPeriodMs;
      try {
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        const r1 = Math.floor(shared.clock.now() / P) + 1;
        await env.drive(r1 * P);
        env.identities.set(1, LINKED);
        await env.drive((r1 + 1) * P);
        assert.strictEqual(env.corp().state, "ACTIVE");
        await env.drive((r1 + 2) * P);
        assert.strictEqual(env.capsFleets().length, 1, "bought with room");
        assert.strictEqual(env.ctx.capsuleers.getStatus().counters.fleetBudget, 0);
        for (const tag of ["a", "b"]) {
          const r = env.fleets.createFleet({ factionId: AMARR, currentSystemId: S.H1, homeSystemId: S.H1,
            fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 1 }] }, `test:filler:${tag}`);
          assert.ok(r.ok, JSON.stringify(r));
        }
        await env.drive((r1 + 3) * P);
        const st = env.ctx.capsuleers.getStatus();
        assert.deepStrictEqual([env.capsFleets().length, st.counters.fleetBudget, st.counters.fleetLimit], [1, 1, 0]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("H5 ACTIVE with 1 member, identity incomplete -> ensure after the commit; identity "
    + "with 3 LINKED characters -> member_ids_json 3 ids, replay writes nothing; migration 41 on a schema 40 file "
    + "-> wait_round 0", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({ maxCorps: 1, maxFleetBuysPerReview: 0 }));
      const P = env.cfg.capsuleers.reviewPeriodMs;
      try {
        const r1 = Math.floor(shared.clock.now() / P) + 1;
        await env.drive(r1 * P);
        const version = env.corp().version;
        const early = env.tx((db) => createCorpRepository().setMembers(db, { slot: 1, expectedVersion: version,
          memberIds: [LINKED.ceoCharacterId], at: shared.clock.now() }));
        assert.deepStrictEqual([early, env.corp().member_ids_json], [{ ok: false, reason: "STATE_CHANGED" }, null]);
        env.identities.set(1, { ...LINKED, characterIds: [LINKED.ceoCharacterId] });
        await env.drive((r1 + 1) * P);
        assert.deepStrictEqual([env.corp().state, JSON.parse(env.corp().member_ids_json), env.ensured.length],
          ["ACTIVE", [LINKED.ceoCharacterId], 1]);
        await env.drive((r1 + 2) * P);
        let st = env.ctx.capsuleers.getStatus().counters;
        assert.deepStrictEqual([env.ensured.length, env.ensured[1].spec.ownerId, env.ensured[1].rowsSeen,
          st.ensureRefused, st.membersRefreshed], [2, 1, 1, 0, 0]);
        env.identities.set(1, { ...LINKED, characterIds: [90000001, 90000003, 90000002] });
        await env.drive((r1 + 3) * P);
        st = env.ctx.capsuleers.getStatus().counters;
        assert.deepStrictEqual([JSON.parse(env.corp().member_ids_json), st.membersRefreshed, env.ensured.length],
          [[90000001, 90000002, 90000003], 1, 2]);
        const before = { corp: env.corp(), journal: env.n("SELECT count(*) AS n FROM world_event_journal") };
        const v = env.replay(r1 + 3);
        assert.deepStrictEqual([v.membersRefreshed, { corp: env.corp(),
          journal: env.n("SELECT count(*) AS n FROM world_event_journal") }], [0, before]);
      } finally {
        env.stop();
      }
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m41-"));
    const file = path.join(tmp, "world.sqlite");
    const stores = [];
    const open = (migrations) => {
      const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
      assert.ok(o.ok, JSON.stringify(o));
      stores.push(o.store);
      return o;
    };
    const run = (store, fn) => {
      const r = store.transaction("t", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    try {
      const old = open(MIGRATIONS.slice(0, 40));
      assert.strictEqual(old.schemaVersion, 40);
      run(old.store, (db) => db.prepare(`INSERT INTO world_capsuleer_trips (trip_id, idempotency_key, kind, corp_slot,
        fleet_id, origin_system_id, base_system_id, target_system_id, outbound_operation_id, return_operation_id, state,
        phase_seq, watch_round, abort_reason, ratting_started_at, ratting_ends_at, kills, isk_earned, dispatched_at,
        ended_at, end_reason, created_at, updated_at, version)
        VALUES ('ct_m41', 'k', 'rat', 1, 'fl_1', 1, 1, 2, 'op_1', NULL, 'OUTBOUND', 0, 7, NULL, NULL, NULL, 0, 0, 5,
        NULL, NULL, 5, 5, 1)`).run());
      old.store.close("upgrade");
      const up = open(MIGRATIONS);
      assert.deepStrictEqual([up.schemaVersion, MIGRATIONS[40].version, MIGRATIONS[40].name],
        [LATEST_SCHEMA_VERSION, 41, "world_capsuleer_trip_wait"]);
      const trip = toTrip(run(up.store, (db) => db.prepare("SELECT * FROM world_capsuleer_trips").get()));
      assert.deepStrictEqual([trip.tripId, trip.watchRound, trip.waitRound], ["ct_m41", 7, 0]);
      up.store.close("test");
    } finally {
      for (const s of stores) {
        try {
          s.close("test");
        } catch (_err) {
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  needsDriver("L5 free-pilots-on-map: running -> layer-capsuleers registered (marks, empty data) "
    + "galaxyCapsuleersEnabled=false -> no layer, capsuleers off -> disabled_by_config and no layer, stop() -> "
    + "unregistered", async () => {
    const layerOf = (env) => env.ctx.views.listMapLayers().find((l) => l.id === "layer-capsuleers") || null;
    await H.withStore(driver, async (reopen) => {
      const env = boot(reopen(), H.sharedOf(), testConfig({ maxCorps: 1 }));
      try {
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        const layer = layerOf(env);
        assert.deepStrictEqual(layer && [layer.id, layer.kind, layer.title], ["layer-capsuleers", "marks",
          "Wolni piloci"]);
        const data = env.ctx.views.getView("layer-capsuleers").getData();
        assert.deepStrictEqual([data.available, data.items, data.note],
          [true, [], "0 pilots in 0 systems (0 fleets)"]);
        env.ctx.capsuleers.stop("test");
        assert.strictEqual(env.ctx.views.getView("layer-capsuleers"), null);
      } finally {
        env.stop();
      }
    });
    await H.withStore(driver, async (reopen) => {
      const cfg = testConfig({ maxCorps: 1 });
      cfg.observer.galaxyCapsuleersEnabled = false;
      const env = boot(reopen(), H.sharedOf(), cfg);
      try {
        assert.deepStrictEqual([env.started.ok, layerOf(env)], [true, null]);
        assert.notStrictEqual(env.ctx.views.getView("capsuleers"), null);
      } finally {
        env.stop();
      }
    });
    await H.withStore(driver, async (reopen) => {
      const env = boot(reopen(), H.sharedOf(), testConfig());
      try {
        assert.deepStrictEqual([env.started.reason, layerOf(env)], ["disabled_by_config", null]);
      } finally {
        env.stop();
      }
    });
  });
};
