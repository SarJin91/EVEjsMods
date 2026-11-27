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
const { createHuntRepository, END_ROWS } = require("../../lib/playerHunt/huntRepository");
const { startPlayerHunt, createUnavailablePlayerHunt, PLAYER_HUNT_METHODS } = require("../../lib/playerHunt");
const S = require("../../lib/playerHunt/schema");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const FACTION = 500019;
const HOME = 30000142;
const TARGET = 30000144;
const CHAR = 90000001;
const LIMITS = Object.freeze({ maxVirtualFleets: 50, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxFleetsPerOperation: 16, maxJsonBytes: 4096, maxListLimit: 500 });
const COMPOSITION = Object.freeze([{ hullGroup: "frigate", typeId: 587, count: 2 }, { hullGroup: "cruiser", count: 1 }]);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-ph-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return fn(opened);
  } finally {
    if (store) store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function harness(opened) {
  const clock = createManualClock(START_MS);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const ids = createIdGenerator({ clock, rng: createRng(7) });
  const fleets = createFleetRepository({ journal, clock, ids, worldSeed: opened.worldSeed, limits: LIMITS });
  const hunts = createHuntRepository({ journal, fleetRepository: fleets, worldSeed: opened.worldSeed });
  const store = opened.store;
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const fleet = (fleetId) => tx((db) => fleets.getFleet(db, fleetId)).fleet;
  const create = (key, extra = {}) => {
    const r = tx((db) => fleets.createFleet(db, { factionId: FACTION, currentSystemId: HOME, homeSystemId: HOME,
      fleetRole: "patrol", composition: COMPOSITION, ...extra }, key));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    return r.fleetId;
  };
  const counts = () => tx((db) => ({
    journal: db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n,
    hunts: db.prepare("SELECT count(*) AS n FROM world_player_hunts").get().n,
  }));
  const claimReq = (fleetId, expectedVersion, extra = {}) => ({ fleetId, expectedVersion, characterId: CHAR,
    systemId: HOME, mode: "SWEEP", standing: -6.5, at: clock.now(), ...extra });
  return { clock, journal, fleets, hunts, store, tx, fleet, create, counts, claimReq, worldSeed: opened.worldSeed };
}

function baseConfig() {
  const c = JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR,
    env: { EVEJS_LNE_PLAYER_HUNT_ENABLED: "0" } }).config));
  c.enabled = true;
  c.modules = { ...c.modules, fleets: { ...(c.modules && c.modules.fleets), enabled: true } };
  return c;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PH1 claim -> live -> loss x2 -> end: fleet IDLE, composition - 2, losses_json once; every "
    + "repeat is a duplicate and changes nothing; migration 47 STRICT with the open-fleet partial UNIQUE", () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 47, String(LATEST_SCHEMA_VERSION));
    withStore(driver, (opened) => {
      const h = harness(opened);
      const meta = h.tx((db) => ({
        strict: db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'world_player_hunts'").get().strict,
        indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'world_player_hunts'"
          + " AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name),
      }));
      assert.deepStrictEqual(meta, { strict: 1, indexes: ["world_player_hunts_cooldown",
        "world_player_hunts_open_fleet", "world_player_hunts_state", "world_player_hunts_system"] });

      const fleetId = h.create("test:ph1:create");
      const req = h.claimReq(fleetId, 1);
      const claim = h.tx((db) => h.hunts.claimInTx(db, req));
      const huntId = S.huntIdOf(fleetId, 1);
      assert.deepStrictEqual({ ...claim, members: claim.members.map((m) => `${m.memberKey}/${m.state}`) },
        { ok: true, duplicate: false, huntId, fleetVersion: 2, version: 1, members: [
          `${fleetId}:cruiser:0:1/PLANNED`, `${fleetId}:frigate:587:1/PLANNED`, `${fleetId}:frigate:587:2/PLANNED`] });
      assert.strictEqual(h.fleet(fleetId).state, "MATERIALIZED");
      const row = h.tx((db) => h.hunts.readInTx(db, huntId)).hunt;
      assert.strictEqual(row.state, "CLAIMED");
      assert.strictEqual(row.factionId, FACTION);
      assert.strictEqual(row.standing, -6.5);

      const repeat = (fn) => {
        const before = { ...h.counts(), version: h.fleet(fleetId).version };
        const r = h.tx(fn);
        assert.deepStrictEqual({ ...h.counts(), version: h.fleet(fleetId).version }, before);
        return r;
      };
      assert.deepStrictEqual(repeat((db) => h.hunts.claimInTx(db, req)), { ok: true, duplicate: true, huntId });

      h.clock.advance(1000);
      const liveReq = { huntId, expectedVersion: 1, at: h.clock.now() };
      assert.deepStrictEqual(h.tx((db) => h.hunts.markLiveInTx(db, liveReq)), { ok: true, duplicate: false,
        version: 2 });
      assert.deepStrictEqual(repeat((db) => h.hunts.markLiveInTx(db, liveReq)), { ok: true, duplicate: true });

      const keys = [`${fleetId}:frigate:587:1`, `${fleetId}:frigate:587:2`];
      for (const memberKey of keys) {
        assert.deepStrictEqual(h.tx((db) => h.hunts.markDestroyedInTx(db, { huntId, memberKey })),
          { ok: true, duplicate: false });
        assert.deepStrictEqual(repeat((db) => h.hunts.markDestroyedInTx(db, { huntId, memberKey })),
          { ok: true, duplicate: true });
      }
      assert.strictEqual(h.tx((db) => h.hunts.markDestroyedInTx(db, { huntId, memberKey: "x:y:0:1" })).reason,
        "MEMBER_UNKNOWN");

      h.clock.advance(1000);
      const endReq = { huntId, at: h.clock.now(), reason: "TARGET_GONE" };
      const LOSSES = [{ hullGroup: "frigate", typeId: 587, count: 2 }];
      assert.deepStrictEqual(h.tx((db) => h.hunts.endInTx(db, endReq)), { ok: true, duplicate: false,
        outcome: "RELEASED", losses: LOSSES });
      const after = h.fleet(fleetId);
      assert.deepStrictEqual({ state: after.state, shipCount: after.shipCount, composition: after.composition },
        { state: "IDLE", shipCount: 1, composition: [{ hullGroup: "cruiser", typeId: null, count: 1 }] });
      const ended = h.tx((db) => h.hunts.readInTx(db, huntId)).hunt;
      assert.deepStrictEqual([ended.state, ended.endReason, ended.endedAt, ended.losses],
        ["ENDED", "TARGET_GONE", endReq.at, LOSSES]);
      for (const again of [endReq, { ...endReq, reason: "RESTART", at: endReq.at + 5 }]) {
        assert.deepStrictEqual(repeat((db) => h.hunts.endInTx(db, again)), { ok: true, duplicate: true,
          outcome: "RELEASED", losses: LOSSES });
      }
      assert.deepStrictEqual(repeat((db) => h.hunts.markDestroyedInTx(db, { huntId, memberKey: keys[0] })),
        { ok: true, duplicate: true });
      assert.strictEqual(repeat((db) => h.hunts.markDestroyedInTx(db, { huntId,
        memberKey: `${fleetId}:cruiser:0:1` })).reason, "NOT_LIVE");
      assert.strictEqual(h.tx((db) => h.hunts.lastEndedAtInTx(db, CHAR, FACTION)), endReq.at);
      assert.strictEqual(h.tx((db) => h.hunts.lastEndedAtInTx(db, CHAR, 500010)), null);
    });
  });

  needsDriver("PH2 end after every member is lost: fleet DESTROYED, outcome DESTROYED, no:release entry",
    () => {
      withStore(driver, (opened) => {
        const h = harness(opened);
        const fleetId = h.create("test:ph2:create");
        const claim = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(fleetId, 1)));
        assert.strictEqual(claim.ok, true, JSON.stringify(claim));
        assert.strictEqual(h.tx((db) => h.hunts.markLiveInTx(db, { huntId: claim.huntId, expectedVersion: 1,
          at: h.clock.now() })).ok, true);
        for (const m of claim.members) {
          assert.strictEqual(h.tx((db) => h.hunts.markDestroyedInTx(db, { huntId: claim.huntId,
            memberKey: m.memberKey })).ok, true);
        }
        const end = h.tx((db) => h.hunts.endInTx(db, { huntId: claim.huntId, at: h.clock.now(), reason: "WIPED" }));
        assert.deepStrictEqual(end, { ok: true, duplicate: false, outcome: "DESTROYED", losses: [
          { hullGroup: "cruiser", typeId: null, count: 1 }, { hullGroup: "frigate", typeId: 587, count: 2 }] });
        const f = h.fleet(fleetId);
        assert.deepStrictEqual([f.state, f.shipCount], ["DESTROYED", 0]);
        const keys = h.tx((db) => db.prepare("SELECT idempotency_key AS k FROM world_event_journal WHERE "
          + "idempotency_key LIKE ? ORDER BY idempotency_key").all(`phunt:${claim.huntId}:%`).map((r) => r.k));
        assert.ok(keys.includes(S.lossesKey(claim.huntId)), keys.join(","));
        assert.ok(!keys.includes(S.releaseKey(claim.huntId)), keys.join(","));
        assert.deepStrictEqual(h.tx((db) => h.hunts.endInTx(db, { huntId: claim.huntId, at: h.clock.now(),
          reason: "WIPED" })).outcome, "DESTROYED");
      });
    });

  needsDriver("PH3 claim refusals: STAGED (FLEET_NOT_IDLE), refit_pending (REFIT_PENDING), an open hunt row "
    + "(FLEET_BUSY), a stale version (VERSION_CONFLICT); a refusal changes nothing", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const staged = h.create("test:ph3:staged");
      const op = h.tx((db) => h.fleets.createOperation(db, { operationType: "invasion", factionId: FACTION,
        originSystemId: HOME, targetSystemId: TARGET, objective: "capture", dueAt: START_MS + 60000,
        fleets: [{ fleetId: staged, expectedVersion: 1 }] }, "test:ph3:op"));
      assert.strictEqual(op.ok, true, JSON.stringify(op));
      const planned = h.fleet(staged);
      const st = h.tx((db) => h.fleets.transition(db, { fleetId: staged, expectedVersion: planned.version,
        from: planned.state, to: "STAGED" }, "test:ph3:stage"));
      assert.strictEqual(st.ok, true, JSON.stringify(st));
      const refit = h.create("test:ph3:refit");
      h.tx((db) => db.prepare("UPDATE virtual_fleets SET refit_pending = 1 WHERE fleet_id = ?").run(refit));
      const busy = h.create("test:ph3:busy");
      h.tx((db) => db.prepare("INSERT INTO world_player_hunts (hunt_id, fleet_id, faction_id, system_id, character_id,"
        + " mode, state, standing, members_json, seed, started_at, updated_at, version) VALUES ('ph:other', ?, "
        + `${FACTION}, ${HOME}, ${CHAR}, 'SWEEP', 'CLAIMED', 0.0, '[]', 1, 1, 1, 1)`).run(busy));
      const stale = h.create("test:ph3:stale");

      const cases = [[staged, h.fleet(staged).version], [refit, 1], [busy, 1], [stale, 9]];
      const got = [];
      for (const [fleetId, version] of cases) {
        const before = { ...h.counts(), fleet: h.fleet(fleetId).version };
        const r = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(fleetId, version)));
        got.push(r.reason);
        assert.deepStrictEqual({ ...h.counts(), fleet: h.fleet(fleetId).version }, before, r.reason);
      }
      assert.deepStrictEqual(got, ["FLEET_NOT_IDLE", "REFIT_PENDING", "FLEET_BUSY", "VERSION_CONFLICT"]);
    });
  });

  needsDriver("PH4 recovery at start: CLAIMED and LIVE of the previous boot -> ENDED RESTART with the losses "
    + "of members_json, a hunt of this boot untouched, empty table = no journal row; facade = stub methods", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const persistence = { ok: true, store: h.store, journal: h.journal, worldSeed: h.worldSeed };
      assert.strictEqual(resolveConfig({ modDir: MOD_DIR, env: {} }).config.playerHunt.enabled, true);
      const config = baseConfig();
      const logger = { lines: [], log(l) { this.lines.push(l); } };
      const start = () => startPlayerHunt({ config, persistence, clock: h.clock,
        getFleets: () => ({ repository: h.fleets }), logger });

      const empty = h.counts();
      const first = start();
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      assert.deepStrictEqual(h.counts(), empty);
      assert.strictEqual(first.playerHunt.isEnabled(), false);
      assert.deepStrictEqual(Object.keys(first.playerHunt).sort(), [...PLAYER_HUNT_METHODS].sort());
      assert.ok(["pursueInTx", "pursueNextInTx", "endWithReturnInTx", "returnHomeInTx", "approachInTx"].every((m) =>
        PLAYER_HUNT_METHODS.includes(m)
        && typeof first.playerHunt[m] === "function"));
      assert.deepStrictEqual(Object.keys(createUnavailablePlayerHunt("X")).sort(), [...PLAYER_HUNT_METHODS].sort());
      first.playerHunt.stop();

      const claimed = h.create("test:ph4:claimed");
      const live = h.create("test:ph4:live");
      const a = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(claimed, 1)));
      const b = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(live, 1, { mode: "SCAN" })));
      assert.ok(a.ok && b.ok);
      assert.strictEqual(h.tx((db) => h.hunts.markLiveInTx(db, { huntId: b.huntId, expectedVersion: 1,
        at: h.clock.now() })).ok, true);
      assert.strictEqual(h.tx((db) => h.hunts.markDestroyedInTx(db, { huntId: b.huntId,
        memberKey: `${live}:frigate:587:1` })).ok, true);
      h.clock.advance(60000);
      const bootAt = h.clock.now();
      const current = h.create("test:ph4:current");
      const c = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(current, 1)));
      assert.strictEqual(c.ok, true);

      const second = start();
      assert.strictEqual(second.ok, true, JSON.stringify(second));
      const st = second.playerHunt.getStatus();
      assert.deepStrictEqual([st.state, st.recovered, st.recoverFailed, st.bootAt], ["ready", 2, 0, bootAt]);
      const read = (id) => h.tx((db) => h.hunts.readInTx(db, id)).hunt;
      assert.deepStrictEqual([read(a.huntId).state, read(a.huntId).endReason, read(a.huntId).losses],
        ["ENDED", "RESTART", []]);
      assert.deepStrictEqual([read(b.huntId).state, read(b.huntId).endReason, read(b.huntId).losses],
        ["ENDED", "RESTART", [{ hullGroup: "frigate", typeId: 587, count: 1 }]]);
      assert.deepStrictEqual([h.fleet(claimed).state, h.fleet(claimed).shipCount], ["IDLE", 3]);
      assert.deepStrictEqual([h.fleet(live).state, h.fleet(live).shipCount], ["IDLE", 2]);
      assert.strictEqual(read(c.huntId).state, "CLAIMED");
      assert.strictEqual(h.fleet(current).state, "MATERIALIZED");
      assert.ok(logger.lines.some((l) => l.startsWith("playerHunt: running enabled=false recovered=2 failed=0")),
        logger.lines.join("\n"));
    });
  });

  needsDriver("CH2 claimInTx unstage: STAGED holder with an ACTIVE operation -> "
    + "MATERIALIZED, operationId null, unstaged true, the operation still ACTIVE; without unstage FLEET_NOT_IDLE; "
    + "a repeat of the key is a duplicate without a second unstage", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const holder = h.create("test:ch2:holder", { fleetRole: "invasion" });
      const op = h.tx((db) => h.fleets.createOperation(db, { operationType: "invasion", factionId: FACTION,
        originSystemId: TARGET, targetSystemId: HOME, objective: "capture", dueAt: START_MS + 60000,
        fleets: [{ fleetId: holder, expectedVersion: 1 }] }, "test:ch2:op"));
      assert.strictEqual(op.ok, true, JSON.stringify(op));
      const active = h.tx((db) => h.fleets.transitionOperation(db, { operationId: op.operationId, expectedVersion: 1,
        from: "PLANNED", to: "ACTIVE" }, "test:ch2:active"));
      assert.strictEqual(active.ok, true, JSON.stringify(active));
      const planned = h.fleet(holder);
      const st = h.tx((db) => h.fleets.transition(db, { fleetId: holder, expectedVersion: planned.version,
        from: planned.state, to: "STAGED" }, "test:ch2:stage"));
      assert.strictEqual(st.ok, true, JSON.stringify(st));
      const staged = h.fleet(holder);
      assert.deepStrictEqual([staged.state, staged.operationId], ["STAGED", op.operationId]);
      const opState = () => h.tx((db) => h.fleets.getOperation(db, op.operationId)).operation.state;

      const before = { ...h.counts(), fleet: h.fleet(holder).version };
      const plain = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(holder, staged.version)));
      assert.strictEqual(plain.reason, "FLEET_NOT_IDLE");
      assert.deepStrictEqual({ ...h.counts(), fleet: h.fleet(holder).version }, before);
      const unstageFalse = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(holder, staged.version, { unstage: false })));
      assert.strictEqual(unstageFalse.reason, "FLEET_NOT_IDLE");
      assert.strictEqual(h.tx((db) => h.hunts.claimInTx(db, h.claimReq(holder, staged.version, { unstage: 1 })))
        .reason, "PLAYER_HUNT_INVALID_INPUT");

      const req = h.claimReq(holder, staged.version, { unstage: true });
      const claim = h.tx((db) => h.hunts.claimInTx(db, req));
      const huntId = S.huntIdOf(holder, staged.version);
      assert.deepStrictEqual([claim.ok, claim.duplicate, claim.huntId, claim.unstaged, claim.fleetVersion],
        [true, false, huntId, true, staged.version + 2]);
      const after = h.fleet(holder);
      assert.deepStrictEqual([after.state, after.operationId, after.version], ["MATERIALIZED", null,
        staged.version + 2]);
      assert.strictEqual(opState(), "ACTIVE");
      const keys = h.tx((db) => db.prepare("SELECT idempotency_key AS k FROM world_event_journal WHERE "
        + "idempotency_key LIKE ? ORDER BY idempotency_key").all(`phunt:${huntId}:%`).map((r) => r.k));
      assert.deepStrictEqual(keys, [S.claimKey(huntId), S.lockKey(huntId), S.unstageKey(huntId)].sort());

      const again = { ...h.counts(), fleet: h.fleet(holder).version };
      assert.deepStrictEqual(h.tx((db) => h.hunts.claimInTx(db, req)), { ok: true, duplicate: true, huntId });
      assert.deepStrictEqual({ ...h.counts(), fleet: h.fleet(holder).version }, again);
      assert.strictEqual(opState(), "ACTIVE");

      const idle = h.create("test:ch2:idle");
      const c2 = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(idle, 1, { unstage: true })));
      assert.deepStrictEqual([c2.ok, c2.unstaged, c2.fleetVersion], [true, false, 2]);
    });
  });

  needsDriver("SZ2 claimInTx maxMembers: the row holds 2 of 3 members (round-robin) "
    + "a loss of one -> endInTx 1 loss, the fleet keeps the rest; without maxMembers the payload has no field and a "
    + "repeat is a duplicate", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const fleetId = h.create("test:sz2:create");
      for (const bad of [0, -1, 1.5, "2", null]) {
        assert.deepStrictEqual(h.tx((db) => h.hunts.claimInTx(db, h.claimReq(fleetId, 1, { maxMembers: bad }))),
          { ok: false, reason: "PLAYER_HUNT_INVALID_INPUT", detail: "maxMembers" }, String(bad));
      }
      const req = h.claimReq(fleetId, 1, { maxMembers: 2 });
      const claim = h.tx((db) => h.hunts.claimInTx(db, req));
      const huntId = S.huntIdOf(fleetId, 1);
      const det = [`${fleetId}:cruiser:0:1`, `${fleetId}:frigate:587:1`];
      assert.deepStrictEqual([claim.ok, claim.duplicate, claim.members.map((m) => m.memberKey)], [true, false, det]);
      assert.deepStrictEqual(h.tx((db) => h.hunts.readInTx(db, huntId)).hunt.members.map((m) => m.memberKey), det);
      assert.strictEqual(h.fleet(fleetId).state, "MATERIALIZED", "the whole fleet is locked");
      assert.deepStrictEqual(h.tx((db) => h.hunts.claimInTx(db, req)), { ok: true, duplicate: true, huntId });
      assert.strictEqual(h.tx((db) => h.hunts.markLiveInTx(db, { huntId, expectedVersion: 1, at: h.clock.now() })).ok,
        true);
      assert.strictEqual(h.tx((db) => h.hunts.markDestroyedInTx(db, { huntId, memberKey: `${fleetId}:frigate:587:2` }))
        .reason, "MEMBER_UNKNOWN");
      assert.strictEqual(h.tx((db) => h.hunts.markDestroyedInTx(db, { huntId, memberKey: det[1] })).ok, true);
      h.clock.advance(1000);
      const end = h.tx((db) => h.hunts.endInTx(db, { huntId, at: h.clock.now(), reason: "TARGET_GONE" }));
      assert.deepStrictEqual(end, { ok: true, duplicate: false, outcome: "RELEASED",
        losses: [{ hullGroup: "frigate", typeId: 587, count: 1 }] });
      const after = h.fleet(fleetId);
      assert.deepStrictEqual({ state: after.state, shipCount: after.shipCount, composition: after.composition },
        { state: "IDLE", shipCount: 2, composition: [{ hullGroup: "cruiser", typeId: null, count: 1 },
          { hullGroup: "frigate", typeId: 587, count: 1 }] });

      const plain = h.create("test:sz2:plain");
      const plainReq = h.claimReq(plain, 1);
      const c1 = h.tx((db) => h.hunts.claimInTx(db, plainReq));
      assert.strictEqual(c1.members.length, 3);
      assert.deepStrictEqual(h.tx((db) => h.hunts.claimInTx(db, { ...plainReq })), { ok: true, duplicate: true,
        huntId: S.huntIdOf(plain, 1) });
      const payloads = h.tx((db) => db.prepare("SELECT idempotency_key AS k, payload FROM world_event_journal WHERE "
        + "idempotency_key IN (?, ?)").all(S.claimKey(huntId), S.claimKey(S.huntIdOf(plain, 1))));
      const byKey = new Map(payloads.map((r) => [r.k, JSON.parse(r.payload)]));
      assert.strictEqual(byKey.get(S.claimKey(huntId)).maxMembers, 2);
      assert.deepStrictEqual(Object.keys(byKey.get(S.claimKey(S.huntIdOf(plain, 1)))).sort(),
        ["at", "characterId", "expectedVersion", "fleetId", "mode", "standing", "systemId"]);
    });
  });

  needsDriver("GP4 claimInTx mode PATROL: fleet MATERIALIZED, a second claim refused "
    + "endInTx UNOBSERVED -> IDLE with the role garrison; lastEndedAtInTx counts SWEEP / SCAN only", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      assert.deepStrictEqual([...S.HUNT_MODES], ["SWEEP", "SCAN"]);
      const fleetId = h.create("test:gp4:create", { fleetRole: "garrison" });
      const claim = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(fleetId, 1, { mode: "PATROL", standing: 0 })));
      assert.strictEqual(claim.ok, true, JSON.stringify(claim));
      assert.strictEqual(claim.duplicate, false);
      assert.strictEqual(h.fleet(fleetId).state, "MATERIALIZED");
      const lockedVersion = h.fleet(fleetId).version;
      const second = h.tx((db) => h.hunts.claimInTx(db, h.claimReq(fleetId, lockedVersion,
        { mode: "GATE_CAMP", standing: 0 })));
      assert.deepStrictEqual([second.ok, second.reason], [false, "FLEET_NOT_IDLE"]);
      assert.strictEqual(h.tx((db) => h.hunts.markLiveInTx(db, { huntId: claim.huntId, expectedVersion: 1,
        at: h.clock.now() })).ok, true);
      h.clock.advance(1000);
      const end = h.tx((db) => h.hunts.endInTx(db, { huntId: claim.huntId, at: h.clock.now(), reason: "UNOBSERVED" }));
      assert.deepStrictEqual([end.ok, end.duplicate, end.outcome], [true, false, "RELEASED"]);
      const after = h.fleet(fleetId);
      assert.deepStrictEqual([after.state, after.fleetRole], ["IDLE", "garrison"]);
      assert.strictEqual(h.tx((db) => h.hunts.readInTx(db, claim.huntId)).hunt.endReason, "UNOBSERVED");
      assert.strictEqual(h.tx((db) => h.hunts.lastEndedAtInTx(db, CHAR, FACTION)), null);
    });
  });

  needsDriver("GP5 a SWEEP ended RESTART starts no hunt cooldown; a TIMEOUT does and stays the "
    + "last end after a later RESTART; SPAWN_FAILED still counts", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      assert.deepStrictEqual([...S.COOLDOWN_EXEMPT_END_REASONS], ["RESTART"]);
      const endRow = (tag, reason) => {
        h.clock.advance(1000);
        const hunt = crewHunt(h, tag, null, "SWEEP", reason);
        assert.strictEqual(h.tx((db) => hunt.repo.endInTx(db, hunt.req)).ok, true);
        return hunt.req.at;
      };
      const last = () => h.tx((db) => h.hunts.lastEndedAtInTx(db, CHAR, FACTION));
      endRow("gp5a", "RESTART");
      assert.strictEqual(last(), null);
      const timeoutAt = endRow("gp5b", "TIMEOUT");
      assert.strictEqual(last(), timeoutAt);
      endRow("gp5c", "RESTART");
      assert.strictEqual(last(), timeoutAt);
      const spawnFailedAt = endRow("gp5d", "SPAWN_FAILED");
      assert.strictEqual(last(), spawnFailedAt);
    });
  });

  const crewHunt = (h, tag, getCrews, mode, reason) => {
    const repo = createHuntRepository({ journal: h.journal, fleetRepository: h.fleets, worldSeed: h.worldSeed,
      ...(getCrews ? { getCrews, crewMaxRows: 32 } : {}) });
    const fleetId = h.create(`test:${tag}:create`);
    const claim = h.tx((db) => repo.claimInTx(db, h.claimReq(fleetId, 1, { mode, standing: mode === "SWEEP" ? -6.5
      : 0 })));
    assert.strictEqual(claim.ok, true, JSON.stringify(claim));
    assert.strictEqual(h.tx((db) => repo.markLiveInTx(db, { huntId: claim.huntId, expectedVersion: 1,
      at: h.clock.now() })).ok, true);
    assert.strictEqual(h.tx((db) => repo.markDestroyedInTx(db, { huntId: claim.huntId,
      memberKey: `${fleetId}:frigate:587:1` })).ok, true);
    const req = { huntId: claim.huntId, at: h.clock.now() + 500, reason };
    return { repo, fleetId, huntId: claim.huntId, req };
  };
  const recorder = (calls) => () => ({ reconcileGuardedInTx(db, fleetId, req, key) {
    calls.push([typeof db.prepare, fleetId, req, key]);
    return { ok: true, duplicate: false, lost: 1 };
  } });

  needsDriver("CHR1 SWEEP with a loss -> crews.reconcileGuardedInTx(cause LIVE, at, "
    + "maxRows 32) with key phunt:<id>:losses once; a duplicate endInTx does not call it", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const calls = [];
      const hunt = crewHunt(h, "chr1", recorder(calls), "SWEEP", "TARGET_GONE");
      const end = h.tx((db) => hunt.repo.endInTx(db, hunt.req));
      assert.deepStrictEqual([end.ok, end.duplicate, end.outcome], [true, false, "RELEASED"]);
      assert.deepStrictEqual(calls, [["function", hunt.fleetId, { cause: "LIVE", at: hunt.req.at, maxRows: 32 },
        `phunt:${hunt.huntId}:losses`]]);
      assert.strictEqual(S.lossesKey(hunt.huntId), `phunt:${hunt.huntId}:losses`);
      assert.strictEqual(h.tx((db) => hunt.repo.endInTx(db, hunt.req)).duplicate, true);
      assert.strictEqual(calls.length, 1, "no call on a duplicate");
    });
  });

  needsDriver("CHR2 PATROL + UNOBSERVED does not call crews (garrisonStep owns it), "
    + "PATROL + RESTART does", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const calls = [];
      const live = crewHunt(h, "chr2a", recorder(calls), "PATROL", "UNOBSERVED");
      assert.strictEqual(h.tx((db) => live.repo.endInTx(db, live.req)).ok, true);
      assert.deepStrictEqual(calls, []);
      const restart = crewHunt(h, "chr2b", recorder(calls), "PATROL", "RESTART");
      assert.strictEqual(h.tx((db) => restart.repo.endInTx(db, restart.req)).ok, true);
      assert.deepStrictEqual(calls.map((c) => [c[1], c[2].cause, c[3]]),
        [[restart.fleetId, "LIVE", S.lossesKey(restart.huntId)]]);
    });
  });

  needsDriver("CHR3 a throw, ok:false, a throwing getter and null give the endInTx "
    + "result and fleet of a repository without crews; a throw after SQLite rolled back goes up", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const settle = (tag, getCrews) => {
        const hunt = crewHunt(h, tag, getCrews, "SWEEP", "TARGET_GONE");
        const end = h.tx((db) => hunt.repo.endInTx(db, hunt.req));
        const f = h.fleet(hunt.fleetId);
        return { end, fleet: [f.state, f.shipCount] };
      };
      const base = settle("chr3a", null);
      assert.deepStrictEqual([base.end.ok, base.end.outcome, base.fleet], [true, "RELEASED", ["IDLE", 2]]);
      for (const [tag, getCrews] of [["chr3b", () => ({ reconcileGuardedInTx: () => { throw new Error("boom"); } })],
        ["chr3c", () => ({ reconcileGuardedInTx: () => ({ ok: false, reason: "CREWS_OFF" }) })],
        ["chr3d", () => { throw new Error("getter"); }], ["chr3e", () => null]]) {
        assert.deepStrictEqual(settle(tag, getCrews), base, tag);
      }
      const boom = new Error("chr3-ioerr");
      const hunt = crewHunt(h, "chr3f", () => ({ reconcileGuardedInTx: (db) => {
        db.exec("ROLLBACK");
        throw boom;
      } }), "SWEEP", "TARGET_GONE");
      const before = h.fleet(hunt.fleetId);
      const r = h.store.transaction("test", (db) => hunt.repo.endInTx(db, hunt.req));
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.strictEqual(r.error, boom, `the original error, got ${r.error && r.error.message}`);
      const f = h.fleet(hunt.fleetId);
      assert.deepStrictEqual([f.state, f.shipCount, f.version], [before.state, before.shipCount, before.version]);
      assert.strictEqual(h.tx((db) => hunt.repo.readInTx(db, hunt.huntId)).hunt.state, "LIVE");
    });
  });

  needsDriver("CHR4 with crews.enabled the recovery pageLimit counts END_ROWS + "
    + "crews.maxSettleRows + 1 rows per hunt; off or without getCrews as before", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const persistence = { ok: true, store: h.store, journal: h.journal, worldSeed: h.worldSeed };
      const pageOf = (crewsEnabled, withGetter) => {
        const config = baseConfig();
        config.crews = { ...config.crews, enabled: crewsEnabled };
        const r = startPlayerHunt({ config, persistence, clock: h.clock, getFleets: () => ({ repository: h.fleets }),
          ...(withGetter ? { getCrews: () => null } : {}) });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        const page = r.playerHunt.getStatus().pageLimit;
        r.playerHunt.stop();
        return [page, config.crews.maxSettleRows, config.playerHunt.fleetScanMax];
      };
      const [on, settleRows, scanMax] = pageOf(true, true);
      assert.strictEqual(on, Math.floor(500 / (END_ROWS + settleRows + 1)));
      assert.ok(on < scanMax, `${on} ${scanMax}`);
      const off = Math.min(scanMax, Math.floor(500 / END_ROWS));
      assert.deepStrictEqual([pageOf(false, true)[0], pageOf(true, false)[0]], [off, off]);
    });
  });

  const releaseHunt = (h, tag, hook, opts = {}) => {
    const repo = createHuntRepository({ journal: h.journal, fleetRepository: h.fleets, worldSeed: h.worldSeed,
      releaseContact: hook });
    const fleetId = h.create(`test:${tag}:create`);
    const claim = h.tx((db) => repo.claimInTx(db, h.claimReq(fleetId, 1)));
    assert.strictEqual(claim.ok, true, JSON.stringify(claim));
    if (opts.wipe) {
      assert.strictEqual(h.tx((db) => repo.markLiveInTx(db, { huntId: claim.huntId, expectedVersion: 1,
        at: h.clock.now() })).ok, true);
      for (const m of claim.members) {
        assert.strictEqual(h.tx((db) => repo.markDestroyedInTx(db, { huntId: claim.huntId,
          memberKey: m.memberKey })).ok, true);
      }
    }
    return { repo, fleetId, huntId: claim.huntId, req: { huntId: claim.huntId, at: h.clock.now() + 500,
      reason: opts.reason || "TIMEOUT" } };
  };

  needsDriver("HR1 endInTx TIMEOUT calls releaseContact once with {releaseId, fleetId, systemId of the "
    + "fleet, at}; a duplicate endInTx does not call it again", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const calls = [];
      const hunt = releaseHunt(h, "hr1", (db, info) => {
        calls.push([typeof db.prepare, info]);
        return { ok: true, duplicate: false };
      });
      const end = h.tx((db) => hunt.repo.endInTx(db, hunt.req));
      assert.deepStrictEqual(end, { ok: true, duplicate: false, outcome: "RELEASED", losses: [] });
      assert.deepStrictEqual(calls, [["function", { releaseId: hunt.huntId, fleetId: hunt.fleetId, systemId: HOME,
        at: hunt.req.at }]]);
      assert.strictEqual(h.tx((db) => hunt.repo.endInTx(db, hunt.req)).duplicate, true);
      assert.strictEqual(calls.length, 1, "no call on a duplicate");
    });
  });

  needsDriver("HR2 a throwing hook leaves endInTx ok RELEASED (fleet IDLE); PURSUIT and a DESTROYED "
    + "fleet make no call", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const thrown = releaseHunt(h, "hr2a", () => {
        throw new Error("boom");
      });
      const end = h.tx((db) => thrown.repo.endInTx(db, thrown.req));
      assert.deepStrictEqual([end.ok, end.duplicate, end.outcome], [true, false, "RELEASED"]);
      assert.strictEqual(h.fleet(thrown.fleetId).state, "IDLE");
      assert.strictEqual(h.tx((db) => thrown.repo.readInTx(db, thrown.huntId)).hunt.state, "ENDED");
      const calls = [];
      const hook = (db, info) => calls.push(info);
      const pursuit = releaseHunt(h, "hr2b", hook, { reason: "PURSUIT" });
      assert.strictEqual(h.tx((db) => pursuit.repo.endInTx(db, pursuit.req)).outcome, "RELEASED");
      const wiped = releaseHunt(h, "hr2c", hook, { wipe: true, reason: "WIPED" });
      assert.strictEqual(h.tx((db) => wiped.repo.endInTx(db, wiped.req)).outcome, "DESTROYED");
      assert.deepStrictEqual(calls, []);
    });
  });
};
