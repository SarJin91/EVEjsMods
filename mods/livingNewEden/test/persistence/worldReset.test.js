"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { ACTION, TABLE_POLICY, FUTURE_TABLES, planReset, applyReset } = require("../../lib/persistence/worldReset");
const { runStationSeed } = require("../../lib/stations/stationSeed");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { createRepository: createIdentityRepository } = require("../../lib/virtualCorps/identityRepository");
const { seedDbFile } = require("../_support/dbTemplate");
const { STANDING_KEY_PREFIX, EVENT_STANDING_GRANT } = require("../../lib/economy/trade/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = 1760000000000;
const HASH = "a".repeat(64);
const EXPLICIT = Object.freeze(["lne_meta", "sqlite_sequence", "world_event_journal", "world_scheduled_events",
  "world_event_sites", "world_virtual_identities"]);
const GENERIC_ROWS = 3;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withFile(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-wr-"));
  const file = path.join(tmp, "world.sqlite");
  const handles = [];
  const open = () => {
    const db = new driver.Database(file);
    db.pragma("foreign_keys = ON");
    handles.push(db);
    return db;
  };
  seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
  try {
    return fn(file, open);
  } finally {
    for (const db of handles) {
      try {
        if (db.open) db.close();
      } catch (_err) {
      }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

const literal = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function fillGeneric(db, overrides = {}) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' "
    + "ESCAPE '\\'").pluck().all().filter((n) => !EXPLICIT.includes(n));
  const fks = new Map(tables.map((t) => [t, db.pragma(`foreign_key_list(${t})`)]));
  const done = new Map();
  db.pragma("ignore_check_constraints = ON");
  try {
    while (done.size < tables.length) {
      const ready = tables.filter((t) => !done.has(t) && fks.get(t).every((fk) => fk.table === t || done.has(fk.table)));
      assert.ok(ready.length > 0, "FK cycle in the fixture");
      for (const t of ready) {
        const cols = db.pragma(`table_info(${t})`);
        const rows = [];
        for (let i = 0; i < GENERIC_ROWS; i += 1) {
          const row = {};
          for (const c of cols) {
            const fk = fks.get(t).find((f) => f.from === c.name);
            const type = String(c.type).toUpperCase();
            if (fk) row[c.name] = done.get(fk.table)[i][fk.to];
            else if (type === "INTEGER") row[c.name] = 1000 + i;
            else if (type === "REAL") row[c.name] = i + 0.5;
            else row[c.name] = `${t}-${c.name}-${i}`;
          }
          Object.assign(row, (overrides[t] || [])[i] || {});
          db.exec(`INSERT INTO ${t} (${cols.map((c) => c.name).join(", ")}) VALUES (`
            + `${cols.map((c) => literal(row[c.name])).join(", ")})`);
          rows.push(row);
        }
        done.set(t, rows);
      }
    }
  } finally {
    db.pragma("ignore_check_constraints = OFF");
  }
}

function addJournal(db, key) {
  db.prepare("INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type, "
    + "payload, payload_hash, state, created_at, applied_at) VALUES (?, 'APPLY', 'test', 'x', 'TEST', '{}', ?, "
    + "'APPLIED', 1, 1)").run(key, HASH);
}

function addEvent(db, id, type) {
  db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, "
    + "aggregate_id, priority, due_at, payload, payload_hash, state, attempts, created_at, version) "
    + "VALUES (?, ?, ?, 'test', 'x', 3, 1, '{}', ?, 'PENDING', 0, 1, 1)").run(id, `k:${id}`, type, HASH);
}

function addIdentity(db, key, kind, state, evejsId) {
  db.prepare("INSERT INTO world_virtual_identities (identity_key, kind, owner_kind, owner_id, state, evejs_id, "
    + "founding_op, name, created_at, updated_at, version) VALUES (?, ?, 'faction', 500001, ?, ?, ?, ?, 1, 2, 3)")
    .run(key, kind, state, evejsId, `lne:v1:${key}`, `N ${key}`);
}

function addSite(db, slot, state, failReason = null) {
  db.prepare("INSERT INTO world_event_sites (site_key, event_id, slot, system_id, template_id, label, request_hash, "
    + "state, fail_reason, expires_at, attempts, next_attempt_at, created_at, updated_at, version) "
    + "VALUES (?, 'ev1', ?, 30000001, 'tpl', 'lbl', ?, ?, ?, 10, 2, 50, 1, 1, 3)")
    .run(`lne:ev1:${slot}`, slot, HASH, state, failReason);
}

const all = (db, sql) => db.prepare(sql).all();
const count = (db, table) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

const JOURNAL_KEYS = Object.freeze(["world:seed:v1:30000001", "world:seed:v1:done:nullsec", "stations:seed:v1:upw-1",
  "strategy:trim:v1:done:500001", "lne:trade:orphan:1:defund", "lne:std:9000001:20000:k1", "lne:stdprune:3600000:7",
  `${STANDING_KEY_PREFIX}1:100:500001:to_1`]);

function fullFixture(db) {
  fillGeneric(db, {
    world_trade_offers: [{ state: "OPEN", contract_id: 77, issuer_corporation_id: 5 },
      { state: "ACCEPTED", contract_id: null }, { state: "ISSUING", contract_id: 78, issuer_corporation_id: 5 }],
    world_sov_projection_log: [{ last_action: "GAIN" }, { last_action: "LOSS" }, { last_action: "TRANSFER" }],
  });
  for (const key of JOURNAL_KEYS) addJournal(db, key);
  addEvent(db, "e1", "STANDING_GRANT");
  addEvent(db, "e2", "STANDINGS_PRUNE");
  addEvent(db, "e3", "FLEET_ARRIVE");
  addEvent(db, "e4", EVENT_STANDING_GRANT);
  addIdentity(db, "alliance:500001", "alliance", "linked", 99000001);
  addIdentity(db, "corporation:500001:1", "corporation", "created", 98000001);
  addIdentity(db, "character:500001:1:1", "character", "planned", null);
  addSite(db, 0, "ACTIVE");
  addSite(db, 1, "CLEANED");
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("WR1 reset: identities/meta/sequence identical, WIPE empty, journal lne:std*, queue standings, FK ok", () => {
    withFile(driver, (file, open) => {
      const db = open();
      fullFixture(db);
      const identities = all(db, "SELECT * FROM world_virtual_identities ORDER BY identity_key");
      const meta = all(db, "SELECT * FROM lne_meta ORDER BY key");
      const sequence = all(db, "SELECT * FROM sqlite_sequence ORDER BY name");
      assert.deepStrictEqual(sequence.map((r) => r.name), ["kb_battles", "ship_ai_facts", "world_event_journal",
        "world_notice_items", "world_post_sightings", "world_sov_reconcile"], "AUTOINCREMENT rows");

      const plan = planReset(db);
      assert.ok(plan.ok, JSON.stringify(plan));
      for (const t of plan.tables.filter((x) => x.action === ACTION.WIPE)) {
        assert.ok(t.toDelete > 0 && t.toDelete === t.rows, `fixture covers ${t.name}: ${JSON.stringify(t)}`);
      }
      assert.deepStrictEqual(plan.identities, { total: 3,
        byKindState: { "alliance:linked": 1, "character:planned": 1, "corporation:created": 1 } });
      assert.deepStrictEqual(plan.game, { sitesToClean: 1, sitesAlreadyCleaning: 1, tradeOffersWithContract: 2,
        tradeOfferIssuerCorps: 1, tradeOffersAcceptedOrIntake: 1, tradeMarketOrdersOpen: 0, sovClaimsLogged: 2, standingsJournalKept: 3,
        standingsEventsKept: 3 });

      const reset = applyReset(db, plan, { now: NOW });
      assert.ok(reset.ok, JSON.stringify(reset));
      assert.strictEqual(reset.transitioned, 1);
      assert.strictEqual(reset.deleted.world_event_journal, JOURNAL_KEYS.length - 3);
      assert.strictEqual(reset.deleted.world_scheduled_events, 1);
      assert.deepStrictEqual(all(db, "SELECT * FROM world_virtual_identities ORDER BY identity_key"), identities);
      assert.deepStrictEqual(all(db, "SELECT * FROM lne_meta ORDER BY key"), meta);
      assert.deepStrictEqual(all(db, "SELECT * FROM sqlite_sequence ORDER BY name"), sequence);
      for (const [name, action] of Object.entries(TABLE_POLICY)) {
        if (action === ACTION.WIPE && plan.tables.some((t) => t.name === name)) assert.strictEqual(count(db, name), 0, name);
      }
      assert.deepStrictEqual(db.prepare("SELECT idempotency_key FROM world_event_journal ORDER BY 1").pluck().all(),
        ["lne:std:9000001:20000:k1", "lne:stdprune:3600000:7", `${STANDING_KEY_PREFIX}1:100:500001:to_1`]);
      assert.deepStrictEqual(db.prepare("SELECT event_type FROM world_scheduled_events ORDER BY 1").pluck().all(),
        ["STANDINGS_PRUNE", "STANDING_GRANT", EVENT_STANDING_GRANT]);
      assert.deepStrictEqual(db.pragma("foreign_key_check"), []);
    });
  });

  needsDriver("WR2 reset sites: live -> CLEANING (attempt 0, version+1), CLEANING/CLEANED kept, PURGED/FAILED gone", () => {
    withFile(driver, (file, open) => {
      const db = open();
      const states = ["CREATING", "ACTIVE", "COMPLETED", "LOST", "CLEANING", "CLEANED", "PURGED", "FAILED"];
      states.forEach((s, i) => addSite(db, i, s, s === "LOST" ? "RECREATE_LIMIT" : null));
      const kept = all(db, "SELECT * FROM world_event_sites WHERE state IN ('CLEANING', 'CLEANED') ORDER BY slot");
      const plan = planReset(db);
      assert.ok(plan.ok, JSON.stringify(plan));
      const sites = plan.tables.find((t) => t.name === "world_event_sites");
      assert.deepStrictEqual([sites.action, sites.toTransition, sites.toDelete], [ACTION.TRANSITION_SITES, 4, 2]);
      const reset = applyReset(db, plan, { now: NOW });
      assert.ok(reset.ok, JSON.stringify(reset));
      const moved = all(db, "SELECT slot, state, fail_reason, next_attempt_at, attempts, updated_at, version "
        + "FROM world_event_sites WHERE slot < 4 ORDER BY slot");
      assert.deepStrictEqual(moved.map((r) => ({ ...r })), [0, 1, 2, 3].map((slot) => ({ slot, state: "CLEANING",
        fail_reason: slot === 3 ? "RECREATE_LIMIT" : "EVENT_CANCELLED", next_attempt_at: 0, attempts: 0,
        updated_at: NOW, version: 4 })));
      assert.deepStrictEqual(all(db, "SELECT * FROM world_event_sites WHERE slot IN (4, 5) ORDER BY slot"), kept);
      assert.strictEqual(count(db, "world_event_sites"), 6, "PURGED and FAILED deleted");
    });
  });

  needsDriver("WR3 restart after reset: station seed recreates all (existing 0), identity insert refused, 2nd reset 0", () => {
    withFile(driver, (file, open) => {
      const clock = { now: () => NOW };
      const factions = [500001, 500002].map((factionId) => ({ factionId, ownerCorporationId: 1000100 + factionId % 10,
        startStations: [{ kind: "upwell", systemId: 30000001, structureFamily: "astrahus" },
          { kind: "upwell", systemId: 30000002, structureFamily: "astrahus" }] }));
      const registry = { listActiveFactions: () => factions, isActive: (id) => factions.some((f) => f.factionId === id) };
      const seedOnce = () => {
        const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
          busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
        assert.ok(opened.ok, JSON.stringify(opened));
        try {
          const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
          const repository = createStationRepository({ journal, isKnownFaction: registry.isActive, hullGroups: HULL_GROUPS,
            limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
              maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
          return runStationSeed({ store: opened.store, journal, repository, registry, graph: { hasSystem: () => true },
            adapter: null, clock, settings: { startStationsPerFaction: 5, maxRowsPerTransaction: 500 } });
        } finally {
          opened.store.close("test");
        }
      };
      const first = seedOnce();
      assert.deepStrictEqual([first.ok, first.created, first.existing], [true, 4, 0], JSON.stringify(first));

      const db = open();
      addIdentity(db, "alliance:500001", "alliance", "linked", 99000001);
      const reset = applyReset(db, planReset(db), { now: NOW });
      assert.ok(reset.ok, JSON.stringify(reset));
      assert.ok(reset.deleted.world_stations === 4 && reset.deleted.world_event_journal >= 4, JSON.stringify(reset));
      const again = applyReset(db, planReset(db), { now: NOW });
      assert.ok(again.ok, JSON.stringify(again));
      assert.strictEqual(Object.values(again.deleted).reduce((a, b) => a + b, 0) + again.transitioned, 0);

      const repo = createIdentityRepository(db);
      const before = count(db, "world_virtual_identities");
      const dup = repo.insert({ key: "alliance:500001", foundingOp: "lne:v1:alliance:500001", kind: "alliance",
        ownerKind: "faction", ownerId: 500001, state: "planned", name: "N alliance:500001", at: NOW });
      assert.strictEqual(dup.ok, false, "existing identity key refused");
      assert.strictEqual(count(db, "world_virtual_identities"), before);
      db.close();

      const second = seedOnce();
      assert.deepStrictEqual([second.ok, second.created, second.existing], [true, 4, 0], JSON.stringify(second));
    });
  });

  needsDriver("WR5 TABLE_POLICY closed set: every fresh table classified, extras only FUTURE_TABLES, x_unknown refused", () => {
    withFile(driver, (file, open) => {
      const db = open();
      const plan = planReset(db);
      assert.ok(plan.ok, JSON.stringify(plan));
      const fresh = plan.tables.map((t) => t.name);
      assert.ok(fresh.includes("sqlite_sequence") && fresh.includes("lne_meta"), fresh.join(","));
      const extra = Object.keys(TABLE_POLICY).filter((n) => !fresh.includes(n));
      assert.ok(extra.every((n) => FUTURE_TABLES.includes(n)), `policy without a table: ${extra.join(", ")}`);
      db.exec("CREATE TABLE x_unknown (id INTEGER PRIMARY KEY)");
      const refused = planReset(db);
      assert.deepStrictEqual([refused.ok, refused.reason, refused.detail], [false, "UNCLASSIFIED_TABLE", "x_unknown"]);
    });
  });

  test("WR6 planReset: read exception (I/O, BUSY) -> READ_FAILED with the message", () => {
    const db = { prepare() { throw new Error("SQLITE_IOERR: disk I/O error"); } };
    const r = planReset(db);
    assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, "READ_FAILED", "SQLITE_IOERR: disk I/O error"]);
  });

  needsDriver("WR7 reset report: tradeMarketOrdersOpen counts market orders in ISSUING/OPEN with market_order_id", () => {
    withFile(driver, (file, open) => {
      const db = open();
      fullFixture(db);
      db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, cap_price_milli, price_source, state, state_seq, end_reason, contract_id, acceptor_character_id, delivered_quantity, created_at, expires_at, updated_at, ended_at, version, channel, market_order_id, filled_quantity) VALUES (?, 500019, 'mi-st-mkt-1', 30000001, 999999, 'mineral', 'type:34', 34, 1000, 1100, 1100000, 1000, 1960, 'bid', 'ISSUING', 0, NULL, NULL, NULL, 0, 1000000, 1259200000, 1000000, NULL, 1, 'market', NULL, 0)").run("mo-1");
      db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, cap_price_milli, price_source, state, state_seq, end_reason, contract_id, acceptor_character_id, delivered_quantity, created_at, expires_at, updated_at, ended_at, version, channel, market_order_id, filled_quantity) VALUES (?, 500019, 'mi-st-mkt-1', 30000001, 999999, 'mineral', 'type:35', 35, 1000, 1100, 1100000, 1000, 1960, 'bid', 'OPEN', 0, NULL, 900001, NULL, 0, 1000000, 1259200000, 1000000, NULL, 1, 'market', 'ord-100', 500)").run("mo-2");
      db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, cap_price_milli, price_source, state, state_seq, end_reason, contract_id, acceptor_character_id, delivered_quantity, created_at, expires_at, updated_at, ended_at, version, channel, market_order_id, filled_quantity) VALUES (?, 500019, 'mi-st-mkt-2', 30000001, 999999, 'mineral', 'type:36', 36, 1000, 1100, 1100000, 1000, 1960, 'bid', 'OPEN', 0, NULL, 900002, NULL, 0, 1000000, 1259200000, 1000000, NULL, 1, 'contract', NULL, 0)").run("mo-3");
      db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, cap_price_milli, price_source, state, state_seq, end_reason, contract_id, acceptor_character_id, delivered_quantity, created_at, expires_at, updated_at, ended_at, version, channel, market_order_id, filled_quantity) VALUES (?, 500019, 'mi-st-mkt-2', 30000001, 999999, 'mineral', 'type:34', 34, 1000, 1100, 1100000, 1000, 1960, 'bid', 'OPEN', 0, NULL, NULL, NULL, 0, 1000000, 1259200000, 1000000, NULL, 1, 'market', NULL, 0)").run("mo-4");
      db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, cap_price_milli, price_source, state, state_seq, end_reason, contract_id, acceptor_character_id, delivered_quantity, created_at, expires_at, updated_at, ended_at, version, channel, market_order_id, filled_quantity) VALUES (?, 500019, 'mi-st-mkt-3', 30000001, 999999, 'mineral', 'type:34', 34, 1000, 1100, 1100000, 1000, 1960, 'bid', 'DELIVERED', 0, 'DELIVERED', 900003, NULL, 1000, 1000000, 1259200000, 1000000, 1000000, 1, 'market', 'ord-200', 1000)").run("mo-5");

      const plan = planReset(db);
      assert.ok(plan.ok, JSON.stringify(plan));
      assert.strictEqual(plan.game.tradeMarketOrdersOpen, 1, "counts OPEN market offers with market_order_id (mo-2)");
    });
  });
};
