"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createFleetRepository } = require("../../lib/fleets/fleetRepository");
const { createTripRepository: createMiningTrips } = require("../../lib/economy/mining/tripRepository");
const { createConvoyRepository } = require("../../lib/economy/logistics/convoyRepository");
const { createTripRepository: createCapsuleerTrips } = require("../../lib/strategy/capsuleers/tripRepository");
const { createContractRepository } = require("../../lib/strategy/capsuleers/contractRepository");
const { createSiegeRepository } = require("../../lib/stations/siege/siegeRepository");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createEventStore } = require("../../lib/scheduler/eventStore");
const { createBuildRepository } = require("../../lib/stations/construction/buildRepository");
const { stateListSql } = require("../../lib/persistence/repository");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const FACTION = 500019;
const HOME = 30000142;
const LIMITS = Object.freeze({ maxVirtualFleets: 50, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxFleetsPerOperation: 16, maxJsonBytes: 4096, maxListLimit: 500 });
const COMPOSITION = Object.freeze([{ hullGroup: "frigate", typeId: 587, count: 5 }]);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withHarness(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-qp-"));
  const file = path.join(tmp, "world.sqlite");
  seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
  const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
  assert.ok(opened.ok, JSON.stringify(opened));
  const clock = createManualClock(START_MS);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const ids = createIdGenerator({ clock, rng: createRng(7) });
  const tx = (f) => {
    const r = opened.store.transaction("test", f);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const fleets = createFleetRepository({ journal, clock, ids, worldSeed: opened.worldSeed, limits: LIMITS });
  try {
    return fn({ tx, clock, journal, ids, fleets });
  } finally {
    opened.store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function traced(db, call) {
  const ran = [];
  const spy = {
    inTransaction: true,
    prepare(sql) {
      const st = db.prepare(sql);
      return new Proxy(st, {
        get(target, key) {
          const v = target[key];
          if (key === "get" || key === "all" || key === "iterate") {
            return (...args) => {
              ran.push({ sql, args });
              return v.apply(target, args);
            };
          }
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
  const value = call(spy);
  const plans = ran.map((r) => db.prepare(`EXPLAIN QUERY PLAN ${r.sql}`).all(...r.args).map((p) => p.detail)
    .join(" | "));
  return { value, plans };
}

function createFleet(h, key) {
  const r = h.tx((db) => h.fleets.createFleet(db, { factionId: FACTION, currentSystemId: HOME, homeSystemId: HOME,
    fleetRole: "invasion", composition: COMPOSITION }, key));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.fleetId;
}

function insertMiningTrip(db, tripId, fleetId, state) {
  db.prepare(`INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id, origin_system_id,
    belt_system_id, state, sec_class, richness_permille, dispatched_at, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'highsec', 500, ?, ?, ?, 1)`)
    .run(tripId, `k:${tripId}`, FACTION, fleetId, HOME, HOME, state, START_MS, START_MS, START_MS);
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("QP1 openByFleet x4 (mining, convoys, capsuleer trips, contracts): plan USING INDEX *_open_fleet "
    + "no SCAN of the table; findOpenByFleet returns the open trip and never the closed one", () => {
    withHarness(driver, (h) => {
      const deps = { journal: h.journal, clock: h.clock };
      const cases = [
        ["world_mining_trips", createMiningTrips(deps)],
        ["world_convoys", createConvoyRepository(deps)],
        ["world_capsuleer_trips", createCapsuleerTrips(deps)],
        ["world_capsuleer_contracts", createContractRepository(deps)],
      ];
      const got = h.tx((db) => cases.map(([table, repo]) => {
        const t = traced(db, (spy) => repo.findOpenByFleet(spy, "fl-none"));
        assert.strictEqual(t.value.ok, true, JSON.stringify(t.value));
        return { table, plans: t.plans };
      }));
      const bad = got.filter((g) => g.plans.length !== 1 || !g.plans[0].includes(`USING INDEX ${g.table}_open_fleet `)
        || new RegExp(`SCAN ${g.table}\\b`).test(g.plans[0]));
      assert.deepStrictEqual(bad, [], JSON.stringify(got));

      const open = createFleet(h, "qp1:open");
      const closed = createFleet(h, "qp1:closed");
      h.tx((db) => {
        insertMiningTrip(db, "mt-done", open, "DELIVERED");
        insertMiningTrip(db, "mt-open", open, "MINING");
        insertMiningTrip(db, "mt-lost", closed, "LOST");
      });
      const mining = cases[0][1];
      const res = h.tx((db) => [mining.findOpenByFleet(db, open), mining.findOpenByFleet(db, closed)]);
      assert.deepStrictEqual(res.map((r) => [r.ok, r.trip && r.trip.tripId]), [[true, "mt-open"], [true, null]]);
    });
  });

  needsDriver("QP2 migration 48 virtual_fleets_faction_live: index exists, listFleetsByFaction without DESTROYED "
    + "reads it (same rows, fleet_id order); a filter with DESTROYED keeps virtual_fleets_faction", () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 48, String(LATEST_SCHEMA_VERSION));
    assert.strictEqual(MIGRATIONS.find((m) => m.version === 48).name, "fleets_faction_live");
    withHarness(driver, (h) => {
      const idx = h.tx((db) => db.prepare(`SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index'
        AND name = 'virtual_fleets_faction_live'`).get());
      assert.ok(idx && idx.tbl_name === "virtual_fleets" && /WHERE state <> 'DESTROYED'/.test(idx.sql), String(idx));
      const a = createFleet(h, "qp2:a");
      const b = createFleet(h, "qp2:b");
      const c = createFleet(h, "qp2:c");
      h.tx((db) => {
        db.prepare("UPDATE virtual_fleets SET state = 'DESTROYED' WHERE fleet_id = ?").run(b);
        db.prepare("UPDATE virtual_fleets SET state = 'TRAVELLING' WHERE fleet_id = ?").run(c);
      });
      const sorted = [a, b, c].slice().sort();
      const list = (states) => h.tx((db) => traced(db, (spy) => h.fleets.listFleetsByFaction(spy, FACTION,
        { limit: 10, states })));
      const live = list(["IDLE", "TRAVELLING", "STAGED"]);
      const all = list(["IDLE", "TRAVELLING", "DESTROYED"]);
      assert.strictEqual(live.value.ok, true, JSON.stringify(live.value));
      assert.deepStrictEqual(live.value.fleets.map((f) => f.fleetId), sorted.filter((id) => id !== b));
      assert.deepStrictEqual(all.value.fleets.map((f) => f.fleetId), sorted);
      assert.ok(live.plans.length === 1 && live.plans[0].includes("USING INDEX virtual_fleets_faction_live "),
        live.plans.join("\n"));
      assert.ok(all.plans.length === 1 && all.plans[0].includes("USING INDEX virtual_fleets_faction ")
        && !all.plans[0].includes("_live"), all.plans.join("\n"));
    });
  });

  needsDriver("QP3 siege listOpen: plan USING INDEX world_station_sieges_open; a closed siege never comes back "
    + "order siege_id, keyset + truncated unchanged", () => {
    withHarness(driver, (h) => {
      const repo = createSiegeRepository({ journal: h.journal, ids: h.ids });
      h.tx((db) => {
        for (const st of ["st-1", "st-2", "st-3"]) {
          db.prepare(`INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family,
            system_id, owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
            evejs_item_id, destroyed_at, created_at, updated_at, version) VALUES (?, 'npc', NULL, 35834, 'Sansha', ?,
            ?, 1000125, 'ONLINE', NULL, 'Test Station', '{"x":0,"y":0,"z":0}', 'seed', NULL, NULL, ?, ?, 1)`)
            .run(st, HOME, FACTION, START_MS, START_MS);
        }
        const siege = db.prepare(`INSERT INTO world_station_sieges (siege_id, idempotency_key, station_id, siege_no,
          system_id, owner_faction_id, attacker_faction_id, state, open, phase_seq, wait_round, phase_started_at,
          phase_ends_at, plan_json, attacker_ships, attacker_strength, started_at, ended_at, created_at, updated_at,
          version) VALUES (?, ?, ?, 1, ?, ?, 500010, ?, ?, 0, 0, ?, ?, '{}', 1, 1, ?, ?, ?, ?, 1)`);
        const row = (id, st, state, open) => siege.run(id, `k:${id}`, st, HOME, FACTION, state, open, START_MS,
          START_MS + 1, START_MS, open ? null : START_MS + 1, START_MS, START_MS);
        row("sg-b", "st-2", "REINFORCED", 1);
        row("sg-a", "st-1", "REINFORCED", 1);
        row("sg-0", "st-3", "REPELLED", 0);
      });
      const page = (opts) => h.tx((db) => traced(db, (spy) => repo.listOpen(spy, opts)));
      const full = page({ limit: 10 });
      const first = page({ limit: 1 });
      const next = page({ limit: 1, afterSiegeId: "sg-a" });
      assert.deepStrictEqual([full, first, next].map((p) => [p.value.sieges.map((s) => s.siegeId), p.value.truncated]),
        [[["sg-a", "sg-b"], false], [["sg-a"], true], [["sg-b"], false]]);
      assert.ok(full.plans.length === 1 && full.plans[0].includes("USING INDEX world_station_sieges_open"),
        full.plans.join("\n"));
    });
  });

  needsDriver("QP4 listThreatened: plan USING INDEX world_system_state_active (not the controller index) "
    + "only CONTESTED / INVASION with an occupier of the faction, system_id order, keyset unchanged", () => {
    withHarness(driver, (h) => {
      const world = createWorldStateRepository({ journal: h.journal, clock: h.clock,
        limits: { maxFactionsPerSystem: 8, maxBatchReadIds: 8, maxListLimit: 64 } });
      h.tx((db) => {
        const sys = db.prepare(`INSERT INTO world_system_state (system_id, security_class, controller_faction_id,
          occupation_state, threat_level, last_state_change_at, updated_at, version, occupier_faction_id)
          VALUES (?, 'nullsec', ?, ?, 0, 0, 0, 1, ?)`);
        sys.run(10, FACTION, "STABLE", null);
        sys.run(5, FACTION, "CONTESTED", 500003);
        sys.run(3, FACTION, "INVASION", 500003);
        sys.run(7, FACTION, "CONTESTED", null);
        sys.run(8, FACTION, "OCCUPIED", 500003);
        sys.run(9, 500003, "INVASION", FACTION);
        sys.run(1, FACTION, "STABLE", null);
      });
      const page = (opts) => h.tx((db) => traced(db, (spy) => world.listThreatened(spy, FACTION, opts)));
      const full = page({ limit: 10 });
      const first = page({ limit: 1 });
      const next = page({ limit: 1, afterSystemId: 3 });
      assert.deepStrictEqual([full, first, next].map((p) => p.value.systems.map((s) => s.systemId)), [[3, 5], [3], [5]]);
      assert.ok(full.plans.length === 1 && full.plans[0].includes("USING INDEX world_system_state_active ")
        && !full.plans[0].includes("world_system_state_controller"), full.plans.join("\n"));
    });
  });

  needsDriver("QP5 listThreatenedControllers: exactly the controllers with a non-empty "
    + "listThreatened, ascending; plan USING INDEX world_system_state_active; a method of the real repository", () => {
    withHarness(driver, (h) => {
      const world = createWorldStateRepository({ journal: h.journal, clock: h.clock,
        limits: { maxFactionsPerSystem: 8, maxBatchReadIds: 8, maxListLimit: 64 } });
      assert.strictEqual(typeof world.listThreatenedControllers, "function");
      const OTHER = 500003;
      const THIRD = 500020;
      h.tx((db) => {
        const sys = db.prepare(`INSERT INTO world_system_state (system_id, security_class, controller_faction_id,
          occupation_state, threat_level, last_state_change_at, updated_at, version, occupier_faction_id)
          VALUES (?, 'nullsec', ?, ?, 0, 0, 0, 1, ?)`);
        sys.run(1, FACTION, "STABLE", null);
        sys.run(2, THIRD, "CONTESTED", FACTION);
        sys.run(3, FACTION, "INVASION", OTHER);
        sys.run(4, OTHER, "CONTESTED", null);
        sys.run(5, null, "INVASION", FACTION);
        sys.run(6, OTHER, "OCCUPIED", FACTION);
        sys.run(7, OTHER, "CONSOLIDATING", THIRD);
        sys.run(8, FACTION, "CONTESTED", THIRD);
      });
      const got = h.tx((db) => traced(db, (spy) => world.listThreatenedControllers(spy)));
      const want = h.tx((db) => [FACTION, OTHER, THIRD].filter((f) => world.listThreatened(db, f, { limit: 64 })
        .systems.length > 0));
      assert.deepStrictEqual(got.value, { ok: true, factionIds: want, truncated: false });
      assert.deepStrictEqual(want, [FACTION, THIRD]);
      assert.ok(got.plans.length === 1 && got.plans[0].includes("USING INDEX world_system_state_active"),
        got.plans.join(" / "));
    });
  });

  needsDriver("QP6 base scheduler: claim by the PK (no live index); loadOpen, recoverClaimed "
    + "countQuarantined, listQuarantined read world_scheduled_events_live; no SCAN of the table", () => {
    withHarness(driver, (h) => {
      const events = createEventStore({ clock: h.clock, ids: h.ids,
        limits: { maxPayloadBytes: 4096, maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 60000 } });
      const plansOf = (call) => h.tx((db) => traced(db, call)).plans;
      const claim = plansOf((spy) => events.claim(spy, ["ev-none"], START_MS));
      const open = plansOf((spy) => events.loadOpen(spy, () => {}));
      const recover = plansOf((spy) => events.recoverClaimed(spy, 10, START_MS));
      const count = plansOf((spy) => events.countQuarantined(spy));
      const list = plansOf((spy) => events.listQuarantined(spy, 10));
      const all = { claim, open, recover, count, list };
      const dump = JSON.stringify(all, null, 1);
      assert.ok(claim[0].includes("sqlite_autoindex_world_scheduled_events_1 (event_id=?)")
        && !claim[0].includes("world_scheduled_events_live"), dump);
      for (const p of [open, recover, count, list]) {
        assert.ok(p.length === 1 && p[0].includes("world_scheduled_events_live")
          && !/SCAN world_scheduled_events(?! USING)/.test(p[0]) && !p[0].includes("TEMP B-TREE"), dump);
      }
    });
  });

  needsDriver("QP7 base state literals: fleets in system / by faction / live, listFleetsInSystems, open "
    + "trips / convoys / builds of a faction and the counters keep their index, no json_each over the states; one "
    + "statement per sorted list", () => {
    withHarness(driver, (h) => {
      const deps = { journal: h.journal, clock: h.clock };
      const mining = createMiningTrips(deps);
      const convoys = createConvoyRepository(deps);
      const builds = createBuildRepository(deps);
      const one = (call) => h.tx((db) => traced(db, call));
      const cases = {
        inSystem: [one((spy) => h.fleets.listFleetsInSystem(spy, HOME, { limit: 5, states: ["STAGED", "IDLE"] })),
          "USING INDEX virtual_fleets_system (current_system_id=? AND fleet_id>?)"],
        byFaction: [one((spy) => h.fleets.listFleetsByFaction(spy, FACTION, { limit: 5,
          states: ["IDLE", "DESTROYED"] })), "USING INDEX virtual_fleets_faction (faction_id=? AND fleet_id>?)"],
        live: [one((spy) => h.fleets.listFleetsByFaction(spy, FACTION, { limit: 5, states: ["IDLE"] })),
          "USING INDEX virtual_fleets_faction_live (faction_id=? AND fleet_id>?)"],
        liveRole: [one((spy) => h.fleets.listFleetsByFaction(spy, FACTION, { limit: 5, states: ["IDLE"],
          role: "patrol" })), "USING INDEX virtual_fleets_faction_live (faction_id=? AND fleet_id>?)"],
        inSystems: [one((spy) => h.fleets.listFleetsInSystems(spy, [HOME, 30000144], { limitPerSystem: 5,
          states: ["IDLE"] })), "USING INDEX virtual_fleets_system (current_system_id=?)"],
        trips: [one((spy) => mining.listOpenOfFaction(spy, FACTION, 5)),
          "USING INDEX world_mining_trips_faction (faction_id=? AND state=?)"],
        tripCount: [one((spy) => mining.countOpenOfFaction(spy, FACTION)),
          "USING COVERING INDEX world_mining_trips_faction (faction_id=? AND state=?)"],
        convoys: [one((spy) => convoys.listOpenOfFaction(spy, FACTION, 5)),
          "USING INDEX world_convoys_faction (faction_id=? AND state=?)"],
        convoyCount: [one((spy) => convoys.countOpenOfFaction(spy, FACTION)),
          "USING COVERING INDEX world_convoys_faction (faction_id=? AND state=?)"],
        builds: [one((spy) => builds.listOpenOfFaction(spy, FACTION, 5)),
          "USING INDEX world_station_builds_faction (faction_id=? AND state=?)"],
        buildCount: [one((spy) => builds.countOpen(spy, { factionId: FACTION })),
          "USING COVERING INDEX world_station_builds_faction (faction_id=? AND state=?)"],
      };
      const dump = JSON.stringify(Object.fromEntries(Object.entries(cases).map(([k, [t]]) => [k, t.plans])), null, 1);
      for (const [name, [t, index]] of Object.entries(cases)) {
        assert.strictEqual(t.value.ok, true, `${name}: ${JSON.stringify(t.value)}`);
        const plan = t.plans.join(" | ");
        assert.ok(t.plans.length === 1 && plan.includes(index) && !plan.includes("virtual_fleets_state"), dump);
        assert.strictEqual((plan.match(/json_each/g) || []).length, name === "inSystems" ? 1 : 0, `${name}\n${dump}`);
      }
      const prepared = [];
      h.tx((db) => {
        const counting = { inTransaction: true, prepare: (sql) => {
          prepared.push(sql);
          return db.prepare(sql);
        } };
        for (const states of [["IDLE", "STAGED"], ["STAGED", "IDLE"], ["IDLE", "STAGED", "IDLE"], ["IDLE", "STAGED"]]) {
          assert.strictEqual(h.fleets.listFleetsInSystem(counting, HOME, { limit: 5, states }).ok, true);
        }
      });
      assert.strictEqual(prepared.filter((sql) => sql.includes("state IN ('IDLE','STAGED')")).length, 1,
        prepared.join("\n"));
    });
  });

  needsDriver("QP8 base literal vs json_each: same rows in the same order for two state lists (fleets in "
    + "system, by faction live and with DESTROYED, open trips); a state outside the enum refused before any SQL",
  () => {
    withHarness(driver, (h) => {
      const fl = ["IDLE", "STAGED", "DESTROYED", "TRAVELLING", "IDLE", "STAGED", "ENGAGED"]
        .map((state, i) => [createFleet(h, `qp8:${i}`), state]);
      h.tx((db) => fl.forEach(([id, state]) => db.prepare("UPDATE virtual_fleets SET state = ? WHERE fleet_id = ?")
        .run(state, id)));
      const mining = createMiningTrips({ journal: h.journal, clock: h.clock });
      h.tx((db) => ["MINING", "DELIVERED", "OUTBOUND", "LOST", "RETURNING"].forEach((state, i) => insertMiningTrip(db,
        `mt-${String.fromCharCode(105 - i)}`, fl[i][0], state)));
      const ref = (sql, ...args) => h.tx((db) => db.prepare(sql).all(...args).map((r) => r.id));
      const ids = (r) => (r.fleets ? r.fleets.map((x) => x.fleetId) : r.trips.map((x) => x.tripId));
      for (const states of [["STAGED", "IDLE"], ["ENGAGED", "DESTROYED", "IDLE", "TRAVELLING"]]) {
        const json = JSON.stringify(states);
        for (const limit of [2, 10]) {
          assert.deepStrictEqual(ids(h.tx((db) => h.fleets.listFleetsInSystem(db, HOME, { limit, states }))),
            ref(`SELECT fleet_id AS id FROM virtual_fleets WHERE current_system_id = ? AND state IN
              (SELECT value FROM json_each(?)) ORDER BY fleet_id LIMIT ?`, HOME, json, limit), `system ${json}`);
          assert.deepStrictEqual(ids(h.tx((db) => h.fleets.listFleetsByFaction(db, FACTION, { limit, states }))),
            ref(`SELECT fleet_id AS id FROM virtual_fleets WHERE faction_id = ? AND state IN
              (SELECT value FROM json_each(?)) ORDER BY fleet_id LIMIT ?`, FACTION, json, limit), `faction ${json}`);
        }
      }
      const open = h.tx((db) => mining.listOpenOfFaction(db, FACTION, 10));
      assert.deepStrictEqual(ids(open), ref(`SELECT trip_id AS id FROM world_mining_trips WHERE faction_id = ?
        AND state IN (SELECT value FROM json_each(?)) ORDER BY trip_id LIMIT ?`, FACTION,
      JSON.stringify(["OUTBOUND", "MINING", "RETURNING"]), 10));
      assert.deepStrictEqual(ids(open), ["mt-e", "mt-g", "mt-i"]);
      assert.strictEqual(h.tx((db) => mining.countOpenOfFaction(db, FACTION)).count, 3);
      const refused = h.tx((db) => traced(db, (spy) => h.fleets.listFleetsByFaction(spy, FACTION, { limit: 5,
        states: ["IDLE", "IDLE') OR ('1'='1"] })));
      assert.deepStrictEqual([refused.value.reason, refused.plans.length], ["UNKNOWN_STATE", 0]);
      assert.throws(() => stateListSql(["IDLE", "X"], ["IDLE"]), TypeError);
      assert.strictEqual(stateListSql(["STAGED", "IDLE", "STAGED"], ["IDLE", "STAGED"]), "('IDLE','STAGED')");
    });
  });

  needsDriver("QP9 build listOpen / openAt on the literal (same index as the json_each "
    + "reference, no json_each); statement caches keyed by the literal only (fleets byStates, build counts)", () => {
    withHarness(driver, (h) => {
      const builds = createBuildRepository({ journal: h.journal, clock: h.clock });
      const T = "world_station_builds";
      const JSON_OPEN = JSON.stringify(["SUPPLYING", "ANCHORING"]);
      const refPlan = (sql, ...args) => h.tx((db) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)
        .map((p) => p.detail).join(" | "));
      const indexOf = (plan) => (plan.match(/USING (?:COVERING )?INDEX (\S+)/) || [])[1];
      const builtOf = (t) => t.plans.filter((p) => p.includes(T));
      const list = h.tx((db) => traced(db, (spy) => builds.listOpen(spy, { limit: 5 })));
      assert.strictEqual(list.value.ok, true, JSON.stringify(list.value));
      const listRef = refPlan(`SELECT * FROM ${T} WHERE state IN (SELECT value FROM json_each(?)) AND station_id > ?
        ORDER BY station_id LIMIT ?`, JSON_OPEN, "", 5);
      const created = h.tx((db) => traced(db, (spy) => builds.createBuild(new Proxy(db, { get: (target, key) => {
        if (key === "prepare") return spy.prepare;
        const v = target[key];
        return typeof v === "function" ? v.bind(target) : v;
      } }), { stationId: "sb-qp9",
        idempotencyKey: "k:sb-qp9", factionId: FACTION, systemId: HOME, kitId: "kit", required: { "ore/raw:a": 1 }, supplyDeadlineAt: START_MS + 1, at: START_MS }, "qp9:create")));
      assert.strictEqual(created.value.ok, true, JSON.stringify(created.value));
      const openAt = builtOf(created).filter((p) => !p.includes("PRIMARY KEY") && !/autoindex.*station_id=\?\)/.test(p));
      const openAtRef = refPlan(`SELECT station_id FROM ${T} WHERE faction_id = ? AND system_id = ? AND state IN
        (SELECT value FROM json_each(?))`, FACTION, HOME, JSON_OPEN);
      const dump = JSON.stringify({ list: list.plans, listRef, created: created.plans, openAtRef }, null, 1);
      assert.ok(list.plans.length === 1 && indexOf(list.plans[0]) === indexOf(listRef)
        && !list.plans[0].includes("json_each") && listRef.includes("json_each"), dump);
      assert.ok(openAt.length === 1 && indexOf(openAt[0]) === indexOf(openAtRef) && !openAt[0].includes("json_each")
        && openAtRef.includes("json_each"), dump);
      const again = h.tx((db) => builds.createBuild(db, { stationId: "sb-qp9b", idempotencyKey: "k:sb-qp9b",
        factionId: FACTION, systemId: HOME, kitId: "kit", required: { "ore/raw:a": 1 }, supplyDeadlineAt: START_MS + 1,
        at: START_MS }, "qp9:create-b"));
      assert.strictEqual(again.reason, "BUILD_OPEN_IN_SYSTEM", JSON.stringify(again));
      assert.deepStrictEqual(h.tx((db) => builds.listOpen(db, { limit: 5 })).builds.map((b) => b.stationId),
        ["sb-qp9"]);

      const keys = [];
      const realSet = Map.prototype.set;
      const prepared = [];
      try {
        Map.prototype.set = function set(k, v) {
          if (typeof k === "string" && /^(inSystemStates|faction)\|/.test(k)) keys.push(k);
          return realSet.call(this, k, v);
        };
        h.tx((db) => {
          const counting = { inTransaction: true, prepare: (sql) => {
            prepared.push(sql);
            return db.prepare(sql);
          } };
          for (const states of [["IDLE", "STAGED"], ["STAGED", "IDLE"], ["IDLE", "STAGED", "IDLE"]]) {
            assert.strictEqual(h.fleets.listFleetsInSystem(counting, HOME, { limit: 5, states }).ok, true);
          }
          for (const states of [["SUPPLYING", "ANCHORING"], ["ANCHORING", "SUPPLYING"], ["SUPPLYING", "ANCHORING",
            "SUPPLYING"]]) {
            assert.strictEqual(builds.countOpen(counting, { factionId: FACTION, states }).count, 1);
          }
        });
      } finally {
        Map.prototype.set = realSet;
      }
      assert.deepStrictEqual(keys, ["inSystemStates|('IDLE','STAGED')", "faction|('ANCHORING','SUPPLYING')"]);
      assert.strictEqual(prepared.filter((sql) => sql.includes(`count(*) AS n FROM ${T} `)).length, 1,
        prepared.join("\n"));
    });
  });
};
