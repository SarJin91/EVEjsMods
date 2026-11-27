"use strict";

const assert = require("node:assert");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { replayOccupation, tributeProbe, idleProbe } = require("../../tools/campaign/metrics");
const { createNotesTap, noteCode } = require("../../tools/campaign/notesTap");
const { fullDigest } = require("../../tools/campaign/digest");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { seedDbFile } = require("../_support/dbTemplate");

function loadDriver() {
  const found = findServerSrcOnDisk(path.resolve(__dirname, "..", ".."), GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const entry = (id, state) => ({ aggregateId: String(id), payload: JSON.stringify({ systemId: id, state }) });

function fakeViews(rowsRef) {
  let reads = 0;
  const view = {
    cacheKey: () => rowsRef.key,
    getData: () => {
      reads += 1;
      return { available: true, factions: rowsRef.rows };
    },
  };
  return { views: { getView: (id) => (id === "factions" ? view : null) }, reads: () => reads };
}

module.exports = ({ test, skip }) => {
  test("CM1 claimsRepelled: a claim that returns to STABLE under the same controller counts", () => {
    const rows = [
      entry(30000001, { securityClass: "nullsec", controllerFactionId: 500001, occupationState: "STABLE" }),
      entry(30000001, { occupierFactionId: 500002, occupationState: "RECON" }),
      entry(30000001, { occupationState: "CONTESTED" }),
      entry(30000001, { occupierFactionId: null, occupationState: "STABLE" }),
    ];
    const r = replayOccupation(rows, null);
    assert.strictEqual(r.claimsRepelled, 1);
    assert.deepStrictEqual(r.repelledBy, { 500001: 1 });
    assert.deepStrictEqual(r.edges, { "STABLE>RECON": 1, "RECON>CONTESTED": 1, "CONTESTED>STABLE": 1 });
    const next = replayOccupation([
      entry(30000001, { occupierFactionId: 500003, occupationState: "CONTESTED" }),
      entry(30000001, { occupierFactionId: null, occupationState: "STABLE" }),
    ], r);
    assert.strictEqual(next.claimsRepelled, 1);
    assert.strictEqual(r.reconExpired, 0);
    const recon = replayOccupation([
      entry(30000005, { securityClass: "nullsec", controllerFactionId: 500001, occupationState: "STABLE" }),
      entry(30000005, { occupierFactionId: 500002, occupationState: "RECON" }),
      entry(30000005, { occupierFactionId: null, occupationState: "STABLE" }),
      entry(30000006, { securityClass: "nullsec", controllerFactionId: 500001, occupationState: "STABLE" }),
      entry(30000006, { occupierFactionId: 500001, occupationState: "RECON" }),
      entry(30000006, { occupierFactionId: null, occupationState: "STABLE" }),
    ], null);
    assert.strictEqual(recon.claimsRepelled, 0);
    assert.strictEqual(recon.reconExpired, 1);
    assert.deepStrictEqual(recon.reconExpiredBy, { 500001: 1 });
  });

  test("CM2 claimsRepelled: a capture and an unknown previous state do not count", () => {
    const r = replayOccupation([
      entry(30000002, { securityClass: "nullsec", controllerFactionId: 500001, occupationState: "STABLE" }),
      entry(30000002, { occupierFactionId: 500002, occupationState: "CONTESTED" }),
      entry(30000002, { controllerFactionId: 500002, occupierFactionId: null, occupationState: "STABLE" }),
      entry(30000003, { occupierFactionId: null, occupationState: "STABLE" }),
      entry(30000004, { securityClass: "nullsec", controllerFactionId: null, occupationState: "STABLE" }),
      entry(30000004, { occupierFactionId: 500002, occupationState: "CONTESTED" }),
      entry(30000004, { occupierFactionId: null, occupationState: "STABLE" }),
    ], null);
    assert.strictEqual(r.claimsRepelled, 0);
    assert.deepStrictEqual(r.repelledBy, {});
    assert.strictEqual(r.edges["CONTESTED>STABLE"], 2);
  });

  test("CM3 notes tap: histogram per faction from the review memory, gaps and restart", () => {
    const ref = { key: "k1", rows: [
      { factionId: 500019, status: "ACTIVE", lastReview: { round: 10, notes: ["NO_TARGET:NO_CANDIDATE", "RECLAIM:30000001",
        "FRONT_LIMIT"] } },
      { factionId: 500020, status: "DORMANT", lastReview: { round: 3, notes: ["FRONT_LIMIT"] } },
      { factionId: 500021, status: "ACTIVE", lastReview: null },
    ] };
    const v = fakeViews(ref);
    const tap = createNotesTap(null);
    tap.observeViews(v.views);
    tap.observeViews(v.views);
    assert.strictEqual(v.reads(), 1);
    ref.key = "k2";
    tap.observeViews(v.views);
    ref.key = "k3";
    ref.rows[0].lastReview = { round: 13, notes: ["NO_TARGET:NO_CANDIDATE"] };
    tap.observeViews(v.views);
    const d1 = tap.drain();
    assert.deepStrictEqual(d1.perFaction, { 500019: { reviews: 2, notes: { "NO_TARGET:NO_CANDIDATE": 2, RECLAIM: 1,
      FRONT_LIMIT: 1 } } });
    assert.strictEqual(d1.missedRounds, 2);
    assert.strictEqual(d1.errors, 0);
    tap.resetRounds();
    for (const [key, round] of [["k4", 14], ["k5", 40], ["k6", 41], ["k7", 43]]) {
      ref.key = key;
      ref.rows[0].lastReview = { round, notes: ["INSUFFICIENT_FORCE"] };
      tap.observeViews(v.views);
    }
    const d2 = tap.drain();
    assert.deepStrictEqual(d2.perFaction, { 500019: { reviews: 4, notes: { INSUFFICIENT_FORCE: 4 } } });
    assert.strictEqual(d2.missedRounds, 3);
    assert.strictEqual(createNotesTap(tap.state()).drain().missedRounds, 3);
    assert.strictEqual(noteCode("NO_HULLS:battleship"), "NO_HULLS:battleship");
    assert.strictEqual(noteCode("NO_HULLS_IN_PRODUCTION:cruiser"), "NO_HULLS_IN_PRODUCTION:cruiser");
    assert.strictEqual(noteCode("DEFENSE_INSUFFICIENT:30000001"), "DEFENSE_INSUFFICIENT");
  });

  test("LP1 lostPosts: a captured system whose controller changes counts (hostile "
    + "abandoned, per losing faction); a home system and an unknown state do not; the cursor carries capturedAt; "
    + "formatMd has the run total", () => {
    const A = 500003;
    const M = 500002;
    const d1 = replayOccupation([
      entry(31000001, { securityClass: "nullsec", controllerFactionId: A, capturedAt: 5, occupationState: "STABLE" }),
      entry(31000001, { controllerFactionId: M, capturedAt: 9 }),
      entry(31000002, { securityClass: "nullsec", controllerFactionId: M, capturedAt: null, occupationState: "STABLE" }),
      entry(31000002, { controllerFactionId: A, capturedAt: 7 }),
      entry(31000003, { controllerFactionId: null }),
      entry(31000004, { securityClass: "nullsec", controllerFactionId: A, capturedAt: 3, occupationState: "STABLE" }),
      entry(31000004, { occupationState: "CONTESTED" }),
    ], null);
    assert.deepStrictEqual(d1.lostPosts, { total: 1, hostile: 1, abandoned: 0, byFaction: { [A]: 1 } });
    const d2 = replayOccupation([
      entry(31000004, { controllerFactionId: null, capturedAt: null, occupationState: "STABLE" }),
      entry(31000001, { controllerFactionId: A, capturedAt: 11 }),
    ], d1);
    assert.deepStrictEqual(d2.lostPosts, { total: 2, hostile: 1, abandoned: 1, byFaction: { [A]: 1, [M]: 1 } });
    const old = replayOccupation([entry(31000001, { controllerFactionId: M })],
      { occupation: [], claims: [["31000001", [A, null]]] });
    assert.strictEqual(old.lostPosts.total, 0);
    const { formatMd } = require("../../tools/campaign/metrics");
    const day = (n, lostPosts) => ({ day: n, perFaction: {}, global: { occupationEdges: {}, review: {}, dbBytes: null,
      lostPosts } });
    const md = formatMd({ seed: 1, days: 2, restart: { mode: "none" }, header: {},
      samples: [day(1, d1.lostPosts), day(2, d2.lostPosts)], checksLine: "-", ok: true, failures: [] });
    assert.ok(md.includes("## Lost posts"), md);
    assert.ok(md.includes(`| 2 | 2 | 1 | 1 | 3 | ${M}=1, ${A}=1 |`), md);
  });

  const TN3 = "TN3 tribute-c tributeProbe: one DELIVERED TRIBUTE convoy, CONCORD stock / PRODUCE "
    + "fleet, operations of the day -> exact numbers; the full digest before and after the probe is the same";
  const driver = loadDriver();
  if (!driver.ok) {
    skip(TN3, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test(TN3, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-tn3-"));
    const file = path.join(dir, "world.sqlite");
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const db = new driver.Database(file);
    try {
      const AMARR = 500003;
      const CONCORD = 500006;
      const DAY = 86400000;
      const from = 10 * DAY;
      const at = 11 * DAY;
      const station = (id, f, state) => db.prepare("INSERT INTO world_stations (station_id, kind, system_id, "
        + "owner_faction_id, owner_corporation_id, state, origin, created_at, updated_at, version) "
        + "VALUES (?, 'upwell', 30000001, ?, 1000125, ?, 'seed', 0, 0, 1)").run(id, f, state);
      station("st-c", CONCORD, "ONLINE");
      station("st-c2", CONCORD, "DESTROYED");
      station("st-a", AMARR, "ONLINE");
      const stock = (s, kind, key, q) => db.prepare("INSERT INTO world_station_stock (station_id, item_kind, item_key, "
        + "quantity, updated_at) VALUES (?, ?, ?, ?, 0)").run(s, kind, key, q);
      stock("st-c", "mineral", "tritanium", 700);
      stock("st-c", "mineral", "pyerite", 300);
      stock("st-c", "hull", "group:frigate", 4);
      stock("st-c2", "mineral", "tritanium", 999);
      const fleet = (id, f, ships, state) => db.prepare("INSERT INTO virtual_fleets (fleet_id, faction_id, "
        + "current_system_id, leg_seq, fleet_role, composition_json, ship_count, supply_state, state, created_at, "
        + "updated_at, version) VALUES (?, ?, 30000001, 1, 'patrol', ?, ?, 100, ?, 0, 0, 1)")
        .run(id, f, JSON.stringify([{ hullGroup: "frigate", typeId: null, count: ships }]), ships, state);
      fleet("fc1", CONCORD, 5, "IDLE");
      fleet("fa1", AMARR, 2, "IDLE");
      const op = (id, f, planned) => db.prepare("INSERT INTO world_operations (operation_id, idempotency_key, "
        + "operation_type, faction_id, origin_system_id, target_system_id, fleet_ids, objective, state, planned_at, "
        + "seed, updated_at, version) VALUES (?, ?, 'patrol', ?, 30000001, 30000002, '[]', 'patrol', 'ACTIVE', ?, 1, "
        + "?, 1)").run(id, `op:${id}`, f, planned, planned);
      op("o1", AMARR, from + 1);
      op("o2", AMARR, at);
      op("o3", CONCORD, from);
      db.prepare("INSERT INTO world_production_jobs (job_id, idempotency_key, faction_id, station_id, system_id, "
        + "hull_group, item_key, runs, recipes_version, consumed_json, run_ms, started_at, due_at, state, created_at, "
        + "updated_at, version) VALUES ('j1', 'job:1', ?, 'st-c', 30000001, 'frigate', 'group:frigate', 3, 1, '{}', 1, "
        + "?, ?, 'ACTIVE', ?, ?, 1)").run(CONCORD, from + 5, from + 9, from + 5, from + 5);
      db.prepare("INSERT INTO world_convoys (convoy_id, idempotency_key, faction_id, fleet_id, purpose, "
        + "source_station_id, source_system_id, dest_station_id, dest_system_id, delivered_station_id, state, plan_json, "
        + "delivered_json, dispatched_at, ended_at, end_reason, created_at, updated_at, version) VALUES ('cv1', 'cv:1', ?, "
        + "'fa1', 'TRIBUTE', 'st-a', 30000001, 'st-c', 30000002, 'st-c', 'DELIVERED', '{}', ?, ?, ?, 'DELIVERED', ?, ?, "
        + "1)").run(AMARR, JSON.stringify({ "mineral/tritanium": 400, "mineral/pyerite": 100 }), from + 2, from + 7,
        from + 2, from + 7);
      const before = fullDigest(db);
      const t = tributeProbe(db, from, at);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(t)), {
        recipient: { [CONCORD]: { mineralUnits: 1000, hullUnits: 4, produceJobs: 1, produceRuns: 3, liveFleets: 1,
          liveShips: 5 } },
        opsPerFaction: { [AMARR]: 2 },
        convoys: { [AMARR]: { DELIVERED: 1, LOST: 0, ABORTED: 0, open: 0 } },
        deliveredUnits: { [AMARR]: 500 },
        payerFleetsAtRecipient: { 500001: 0, 500002: 0, 500003: 0, 500004: 0 },
      });
      const after = fullDigest(db);
      assert.ok(before.ok && after.ok, JSON.stringify([before.reason, after.reason]));
      assert.strictEqual(after.digest, before.digest);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SLR5 tribute-c tributeProbe.payerFleetsAtRecipient: IDLE logistics of a payer in a system of a "
    + "station of its receiver counts; TRAVELLING, another system, a DESTROYED station, another role do not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-slr5-"));
    const file = path.join(dir, "world.sqlite");
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const db = new driver.Database(file);
    try {
      const AMARR = 500003;
      const MINMATAR = 500002;
      const CONCORD = 500006;
      const PAYE = 30001718;
      const station = (id, f, sys, state) => db.prepare("INSERT INTO world_stations (station_id, kind, system_id, "
        + "owner_faction_id, owner_corporation_id, state, origin, created_at, updated_at, version) "
        + "VALUES (?, 'upwell', ?, ?, 1000125, ?, 'seed', 0, 0, 1)").run(id, sys, f, state);
      station("st-c", CONCORD, PAYE, "ONLINE");
      station("st-c2", CONCORD, 30000002, "DESTROYED");
      station("st-a", AMARR, 30000003, "ONLINE");
      const fleet = (id, f, sys, role, state) => db.prepare("INSERT INTO virtual_fleets (fleet_id, faction_id, "
        + "current_system_id, leg_seq, fleet_role, composition_json, ship_count, supply_state, state, created_at, "
        + "updated_at, version) VALUES (?, ?, ?, 1, ?, ?, 2, 100, ?, 0, 0, 1)")
        .run(id, f, sys, role, JSON.stringify([{ hullGroup: "industrial", typeId: null, count: 2 }]), state);
      fleet("a1", AMARR, PAYE, "logistics", "IDLE");
      fleet("a2", AMARR, PAYE, "logistics", "IDLE");
      fleet("a3", AMARR, PAYE, "logistics", "TRAVELLING");
      fleet("a4", AMARR, 30000003, "logistics", "IDLE");
      fleet("a5", AMARR, 30000002, "logistics", "IDLE");
      fleet("a6", AMARR, PAYE, "patrol", "IDLE");
      fleet("m1", MINMATAR, PAYE, "logistics", "IDLE");
      fleet("c1", CONCORD, PAYE, "logistics", "IDLE");
      assert.deepStrictEqual(JSON.parse(JSON.stringify(tributeProbe(db, 0, 1).payerFleetsAtRecipient)),
        { 500001: 0, 500002: 1, 500003: 2, 500004: 0 });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("IFP1 idleProbe: live / IDLE per role, garrison ships per STABLE post (own garrison "
    + "fleets only), captured systems per faction; the full digest is unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-ifp1-"));
    const file = path.join(dir, "world.sqlite");
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const db = new driver.Database(file);
    try {
      const A = 500003;
      const M = 500002;
      const sys = (id, ctrl, state, captured) => db.prepare("INSERT INTO world_system_state (system_id, "
        + "security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, updated_at, "
        + "version, captured_at) VALUES (?, 'nullsec', ?, ?, 0, 0, 0, 1, ?)").run(id, ctrl, state, captured);
      sys(31000001, A, "STABLE", 5);
      sys(31000002, A, "STABLE", 5);
      sys(31000003, A, "CONTESTED", 5);
      sys(31000004, M, "STABLE", null);
      sys(31000005, M, "STABLE", 7);
      const fleet = (id, f, s, role, ships, state) => db.prepare("INSERT INTO virtual_fleets (fleet_id, faction_id, "
        + "current_system_id, leg_seq, fleet_role, composition_json, ship_count, supply_state, state, created_at, "
        + "updated_at, version) VALUES (?, ?, ?, 1, ?, ?, ?, 100, ?, 0, 0, 1)")
        .run(id, f, s, role, JSON.stringify([{ hullGroup: "frigate", typeId: null, count: ships }]), ships, state);
      fleet("g1", A, 31000001, "garrison", 3, "IDLE");
      fleet("g2", A, 31000001, "garrison", 4, "STAGED");
      fleet("g3", A, 31000001, "garrison", 9, "DESTROYED");
      fleet("g4", M, 31000002, "garrison", 5, "IDLE");
      fleet("g5", M, 31000005, "garrison", 2, "IDLE");
      fleet("s1", A, 31000001, "scout", 1, "IDLE");
      fleet("s2", A, 31000004, "scout", 1, "TRAVELLING");
      const before = fullDigest(db);
      const p = idleProbe(db);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), {
        roles: { garrison: { live: 4, idle: 3 }, scout: { live: 2, idle: 1 } },
        garrisonShips: { posts: 3, median: 2, zero: 1 },
        posts: { [M]: [31000005], [A]: [31000001, 31000002, 31000003] },
      });
      const after = fullDigest(db);
      assert.ok(before.ok && after.ok, JSON.stringify([before.reason, after.reason]));
      assert.strictEqual(after.digest, before.digest);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
