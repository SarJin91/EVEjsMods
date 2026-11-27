"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const config = require("../../config");
const loader = require("../../loader");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION, validateMigrations } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createBattleRepository, VIRTUAL_LOSSES_SQL } = require("../../lib/battle/battleRepository");
const { createLossesCache } = require("../../lib/inGameMap/losses");
const { startInGameMap } = require("../../lib/inGameMap");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const overlay = require("../../lib/adapter/starmapOverlay");
const { functionBody } = require("../../lib/adapter/essRepositoryFast");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const MAP_FILE = path.join(SERVER_SRC, "services", "map", "mapService.js");
const TELEMETRY_FILE = path.join(SERVER_SRC, "services", "map", "mapTelemetryState.js");
const KM_FILE = path.join(SERVER_SRC, "services", "killmail", "killmailState.js");
const HOUR = 3600000;
const NOW = 1800000000000;
const WALL = 1700000000000;

function readSource(abs) {
  return fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function battleRepositoryOf(clockNow) {
  return createBattleRepository({ journal: { applyOnce() {}, findByKey() {} },
    fleetRepository: { transition() {}, getFleets() {} }, clock: { now: () => clockNow }, ids: { next: () => "x" },
    worldSeed: 1, limits: { maxFleetsPerSide: 8, maxCompositionEntries: 32, maxShipsPerFleet: 500,
      maxResolutionMs: 50, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500, maxSettlementRows: 450 } });
}

function vendorMapService(forEach, rowsOf, stop = { on: false }) {
  const text = readSource(MAP_FILE);
  const body = overlay.methodBody(text, "Handle_GetHistory");
  const toPositiveInteger = (value, fallback = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const t = Math.trunc(n);
    return t > 0 ? t : fallback;
  };
  const buildHistoryRows = (statID, hours) => {
    const records = [];
    forEach((record) => {
      records.push(record);
      return stop.on ? false : undefined;
    });
    return rowsOf(statID, hours, records);
  };
  return vm.runInThisContext(`(function (toPositiveInteger, log, buildCachedMethodCallResult, buildRowset,
    HISTORY_COLUMNS, buildHistoryRows, MAP_ROWSET) {\nreturn class MapService {\n  ${body}\n};\n})`)(
    toPositiveInteger, { debug() {} }, (rowset) => rowset, (_cols, rows) => rows, [], buildHistoryRows, "rowset");
}

const loss = (systemId, ageMs, typeId, factionId, count) => ({ systemId, ageMs, typeId, factionId, count });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const k1 = "K1 migration 83 + listVirtualLossesSince: index plan, VIRTUAL only, window, limit, losses cache";
  if (!driver.ok) skip(k1, `better-sqlite3 unavailable (${driver.detail})`);
  else {
    test(k1, () => {
      assert.ok(validateMigrations(MIGRATIONS).ok);
      assert.ok(LATEST_SCHEMA_VERSION >= 83);
      assert.strictEqual(MIGRATIONS[82].name, "battle_records_settled");
      let handle = null;
      const opened = openStore({ filePath: ":memory:", openDatabase: (f) => {
        handle = new driver.Database(f);
        return handle;
      }, exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
      assert.ok(opened.ok, JSON.stringify(opened));
      const store = opened.store;
      try {
        handle.pragma("foreign_keys = OFF");
        const tx = (fn) => {
          const r = store.transaction("test", fn);
          assert.ok(r.ok, JSON.stringify(r));
          return r.value;
        };
        tx((db) => {
          const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'battle_records_settled'")
            .get();
          assert.ok(idx && /WHERE settled_at IS NOT NULL/.test(idx.sql), JSON.stringify(idx));
          const insB = db.prepare(`INSERT INTO battle_records (battle_id, idempotency_key, system_id, environment,
            objective, mode, state, resolver_version, input_hash, seed, input_json, fleet_ids, claim_seq, created_at,
            updated_at, settled_at, version) VALUES (?, ?, ?, 'lowsec', 'destroy', ?, ?, 'internal-v1', ?, 1, '{}',
            '[]', 0, 1, 1, ?, 1)`);
          const insL = db.prepare(`INSERT INTO battle_losses (battle_id, fleet_id, faction_id, hull_group, type_id,
            count) VALUES (?, ?, ?, ?, ?, ?)`);
          const battle = (id, system, mode, settledAt, rows) => {
            insB.run(id, `k-${id}`, BigInt(system), mode, settledAt === null ? "RESOLVING" : "COMPLETED", "a".repeat(64),
              settledAt === null ? null : BigInt(settledAt));
            for (const [fleet, faction, hull, type, count] of rows) {
              insL.run(id, fleet, BigInt(faction), hull, BigInt(type), BigInt(count));
            }
          };
          battle("b1", 30000001, "VIRTUAL", NOW - 1000, [["f2", 500002, "cruiser", 0, 1], ["f1", 500001, "frigate", 587, 3]]);
          battle("b2", 30000002, "VIRTUAL", NOW - 2 * HOUR, [["f3", 500001, "battleship", 641, 2]]);
          battle("b3", 30000003, "LIVE_EVEJS", NOW - 500, [["f4", 500003, "frigate", 587, 9]]);
          battle("b4", 30000003, "EFS_TEST", NOW - 500, [["f5", 500003, "frigate", 587, 9]]);
          battle("b5", 30000004, "VIRTUAL", NOW - 25 * HOUR, [["f6", 500004, "frigate", 587, 9]]);
          battle("b6", 30000004, "VIRTUAL", null, [["f7", 500004, "frigate", 587, 9]]);
        });
        const plan = tx((db) => db.prepare(`EXPLAIN QUERY PLAN ${VIRTUAL_LOSSES_SQL}`).all(BigInt(NOW - 24 * HOUR), 11n));
        assert.ok(plan.some((r) => /SEARCH r USING INDEX battle_records_settled/.test(String(r.detail))),
          JSON.stringify(plan));
        const repo = battleRepositoryOf(NOW);
        const sinceMs = NOW - 24 * HOUR;
        const all = tx((db) => repo.listVirtualLossesSince(db, { sinceMs, limit: 10 }));
        assert.deepStrictEqual(all, { ok: true, truncated: false, losses: [
          { systemId: 30000001, settledAt: NOW - 1000, factionId: 500001, typeId: 587, count: 3, hullGroup: "frigate" },
          { systemId: 30000001, settledAt: NOW - 1000, factionId: 500002, typeId: 0, count: 1, hullGroup: "cruiser" },
          { systemId: 30000002, settledAt: NOW - 2 * HOUR, factionId: 500001, typeId: 641, count: 2,
            hullGroup: "battleship" }] },
        "newest first; LIVE_EVEJS, EFS_TEST, unsettled and older than the window never");
        const two = tx((db) => repo.listVirtualLossesSince(db, { sinceMs, limit: 2 }));
        assert.deepStrictEqual([two.losses.length, two.truncated], [2, true]);
        assert.strictEqual(tx((db) => repo.listVirtualLossesSince(db, { sinceMs: NOW - 26 * HOUR, limit: 10 })).losses
          .length, 4);
        assert.deepStrictEqual(repo.listVirtualLossesSince(null, { sinceMs, limit: 1 }), { ok: false, reason: "TX_REQUIRED" });
        assert.deepStrictEqual(tx((db) => repo.listVirtualLossesSince(db, { sinceMs, limit: 0 })),
          { ok: false, reason: "INVALID_ARGUMENT", detail: "opts.limit" });

        const gov = { admit: true };
        const metrics = [];
        const clock = { t: NOW };
        const cache = createLossesCache({ battle: { repository: repo }, store, clock: { now: () => clock.t },
          wallNow: () => WALL, getGovernor: () => ({ admits: (c) => (c === "MAINTENANCE" ? gov.admit : true) }),
          settings: { starmapKillsRefreshMs: 60000, starmapMaxLossRows: 2000 },
          telemetry: { count: (n) => metrics.push(n), observe: (n) => metrics.push(n) } });
        assert.strictEqual(cache.snapshot(), null, "nothing before the first read");
        assert.deepStrictEqual(cache.refreshNow(), { ok: true });
        const first = cache.snapshot();
        assert.deepStrictEqual([first.version, first.builtAtWallMs, first.builtAtMs], [1, WALL, NOW]);
        assert.deepStrictEqual(first.losses.map((l) => [l.systemId, l.ageMs, l.typeId, l.count]),
          [[30000001, 1000, 587, 3], [30000001, 1000, 0, 1], [30000002, 2 * HOUR, 641, 2]]);
        assert.ok(Object.isFrozen(first) && Object.isFrozen(first.losses) && Object.isFrozen(first.losses[0]));
        clock.t += 60000;
        cache.refreshNow();
        assert.strictEqual(cache.snapshot(), first, "unchanged content = the same snapshot (version kept)");
        gov.admit = false;
        assert.deepStrictEqual(cache.refreshNow(), { ok: false, reason: "GOVERNOR_HOLD" });
        assert.strictEqual(cache.snapshot(), first);
        gov.admit = true;
        clock.t = NOW + 23 * HOUR;
        cache.refreshNow();
        assert.deepStrictEqual([cache.snapshot().version, cache.snapshot().losses.length], [2, 2], "b2 left the window");
        assert.deepStrictEqual(cache.status(), { version: 2, losses: 2, truncated: false, refreshes: 3, skipped: 1,
          failed: 0, lastRefreshAt: NOW + 23 * HOUR });
        assert.ok(metrics.includes("inGameMap.starmap.lossRefreshes") && metrics.includes("inGameMap.starmap.lossesMs")
          && metrics.includes("inGameMap.starmap.lossRefreshSkipped"), JSON.stringify(metrics));
        const blind = createLossesCache({ battle: null, store, clock: { now: () => NOW },
          settings: { starmapKillsRefreshMs: 60000, starmapMaxLossRows: 10 } });
        assert.deepStrictEqual(blind.refreshNow(), { ok: false, reason: "BATTLE_UNAVAILABLE" }, "W58: battle off");
        cache.stop();
        assert.strictEqual(cache.snapshot(), null);
      } finally {
        store.close("test_cleanup");
      }
    });
  }

  test("K2 synthetic records: count unrolled, maxSynthetic keeps the newest, fallback type, killTime, frozen", () => {
    const calls = [];
    const filetimeFromMs = (ms) => {
      calls.push(ms);
      return `ft:${ms}`;
    };
    const snap = { version: 1, builtAtWallMs: WALL, losses: [loss(30000001, 1000, 587, 500001, 3),
      loss(30000002, 5000, 0, 500002, 2), loss(30000003, 9000, 641, 500003, 1)] };
    const recs = overlay.buildSyntheticKillRecords(snap, { maxSynthetic: 4, fallbackTypeId: 603, filetimeFromMs });
    assert.strictEqual(recs.length, 4);
    assert.deepStrictEqual(recs.map((r) => [r.solarSystemID, r.victimShipTypeID, r.victimFactionID, r.killTime]), [
      [30000001, 587, 500001, `ft:${WALL - 1000}`], [30000001, 587, 500001, `ft:${WALL - 1000}`],
      [30000001, 587, 500001, `ft:${WALL - 1000}`], [30000002, 603, 500002, `ft:${WALL - 5000}`]]);
    assert.ok(recs.every((r) => r.victimCharacterID === 0), "no character: the vendor counts NPC kills");
    assert.deepStrictEqual(Object.keys(recs[0]).sort(),
      ["killTime", "solarSystemID", "victimCharacterID", "victimFactionID", "victimShipTypeID"]);
    assert.ok(Object.isFrozen(recs) && Object.isFrozen(recs[0]));
    assert.deepStrictEqual(calls, [WALL - 1000, WALL - 5000], "one killTime per loss row");
    assert.strictEqual(overlay.buildSyntheticKillRecords(null, { maxSynthetic: 4, fallbackTypeId: 1, filetimeFromMs })
      .length, 0);
    const junk = { version: 1, builtAtWallMs: WALL, losses: [loss(0, 1, 1, 1, 1), loss(1, -1, 1, 1, 1), loss(1, 1, 1, 1, 0)] };
    assert.strictEqual(overlay.buildSyntheticKillRecords(junk, { maxSynthetic: 9, fallbackTypeId: 1, filetimeFromMs })
      .length, 0);
  });

  const haveSrc = fs.existsSync(MAP_FILE) && fs.existsSync(TELEMETRY_FILE) && fs.existsSync(KM_FILE);
  const k3 = "K3 scope: statID 3 gets the synthetic records, 1 / 5 the same reference, throw resets depth, uninstall";
  if (!haveSrc) skip(k3, "server/src not found");
  else {
    test(k3, () => {
      const VENDOR = [{ killID: 1 }];
      const km = { forEachKillmailRecordDescending(visitor) {
        for (const record of VENDOR) if (visitor(record) === false) return;
      } };
      const walk = (fn) => {
        const out = [];
        fn((record) => {
          out.push(record);
        });
        return out;
      };
      const boom = { on: false };
      const before = overlay.killsStatus();
      if (before.state === "off") {
        const blindAdapter = createAdapter({ moduleApi: { _cache: {} } });
        assert.strictEqual(blindAdapter.installStarmapKills({ snapshot: () => null }).reason, "KILLS_HOOK_NOT_ARMED");
      }
      assert.deepStrictEqual(overlay.armKills(km, { maxSynthetic: 3, fallbackTypeId: 587 }), { ok: true });
      assert.strictEqual(overlay.armKills(km, { maxSynthetic: 3, fallbackTypeId: 587 }).reason, "already_armed");
      const forEach = km.forEachKillmailRecordDescending;
      assert.ok(forEach[overlay.FOR_EACH_MARKER]);
      const seen = [];
      const stopWalk = { on: false };
      const MapService = vendorMapService(forEach, (statID, _hours, records) => {
        if (boom.on) throw new Error("boom");
        seen.push(statID);
        return records;
      }, stopWalk);
      const vendorMethod = MapService.prototype.Handle_GetHistory;
      const telemetryExports = { filetimeFromMs: (ms) => `ft:${ms}` };
      const adapter = createAdapter({ moduleApi: { _cache: { [MAP_FILE]: { exports: MapService },
        [TELEMETRY_FILE]: { exports: telemetryExports } } } });
      adapter.setServerSrc(SERVER_SRC);
      const snap = { current: { version: 1, builtAtWallMs: WALL, losses: [loss(30000001, 1000, 587, 500001, 2),
        loss(30000002, 2000, 0, 500002, 5)] } };
      const builds = [];
      const events = [];
      const provider = { snapshot: () => snap.current, onEvent: (name, value) => events.push([name, value]) };
      const svc = new MapService();
      try {
        assert.deepStrictEqual(adapter.installStarmapKills(provider), { ok: true });
        assert.strictEqual(adapter.installStarmapKills(provider).reason, "HOOK_ALREADY_INSTALLED");
        assert.notStrictEqual(MapService.prototype.Handle_GetHistory, vendorMethod);
        const outside = walk(forEach);
        assert.ok(outside.length === 1 && outside[0] === VENDOR[0], "outside the scope: the vendor records only");
        const r3 = svc.Handle_GetHistory([3, 24]);
        assert.strictEqual(r3.length, 1 + 3, "vendor + maxSynthetic newest records");
        assert.deepStrictEqual(r3.slice(1).map((r) => [r.solarSystemID, r.victimShipTypeID, r.killTime]), [
          [30000001, 587, `ft:${WALL - 1000}`], [30000001, 587, `ft:${WALL - 1000}`],
          [30000002, 587, `ft:${WALL - 2000}`]]);
        builds.push(adapter.starmapOverlayStatus().kills.syntheticKills);
        const again = svc.Handle_GetHistory(["3", 1]);
        assert.strictEqual(again[1], r3[1], "the same version: the cached frozen records");
        for (const statID of [1, 5, 0]) {
          const rows = svc.Handle_GetHistory([statID, 1]);
          assert.ok(rows.length === 1 && rows[0] === VENDOR[0], `statID ${statID}`);
        }
        assert.deepStrictEqual(seen, [3, 3, 1, 5, 0]);
        assert.deepStrictEqual(VENDOR, [{ killID: 1 }], "the vendor array never changed");
        stopWalk.on = true;
        assert.strictEqual(svc.Handle_GetHistory([3, 1]).length, 1, "stopped walk: vendor records only");
        stopWalk.on = false;
        boom.on = true;
        assert.throws(() => svc.Handle_GetHistory([3, 1]), /boom/);
        boom.on = false;
        assert.strictEqual(adapter.starmapOverlayStatus().kills.depth, 0);
        assert.strictEqual(walk(forEach).length, VENDOR.length, "outside the scope again");
        snap.current = { version: 2, builtAtWallMs: WALL, losses: [loss(30000009, 0, 641, 500009, 1)] };
        assert.deepStrictEqual(svc.Handle_GetHistory([3, 1]).slice(1).map((r) => r.solarSystemID), [30000009]);
        builds.push(adapter.starmapOverlayStatus().kills.syntheticKills);
        assert.deepStrictEqual(builds, [3, 1]);
        snap.current = null;
        assert.strictEqual(svc.Handle_GetHistory([3, 1]).length, VENDOR.length, "no snapshot = vendor rows");
        const st = adapter.starmapOverlayStatus().kills;
        assert.deepStrictEqual([st.state, st.served, st.errors], ["active", 4, 0]);
        assert.deepStrictEqual(events.filter(([n]) => n === "syntheticKills"), [["syntheticKills", 3],
          ["syntheticKills", 1]]);
      } finally {
        assert.deepStrictEqual(adapter.uninstallStarmapKills(), { ok: true });
      }
      assert.strictEqual(MapService.prototype.Handle_GetHistory, vendorMethod, "uninstall restores the vendor method");
      assert.strictEqual(adapter.starmapOverlayStatus().kills.state, "armed", "the forEach wrap stays (pass-through)");
      snap.current = { version: 3, builtAtWallMs: WALL, losses: [loss(30000001, 0, 587, 500001, 1)] };
      assert.strictEqual(svc.Handle_GetHistory([3, 1]).length, VENDOR.length, "after uninstall: vendor rows");
      const drifted = vendorMapService(forEach, (_s, _h, records) => records);
      drifted.prototype.Handle_GetHistory = function Handle_GetHistory() { return 1; };
      const driftAdapter = createAdapter({ moduleApi: { _cache: { [MAP_FILE]: { exports: drifted },
        [TELEMETRY_FILE]: { exports: telemetryExports } } } });
      driftAdapter.setServerSrc(SERVER_SRC);
      const drift = driftAdapter.installStarmapKills(provider);
      assert.deepStrictEqual(drift, { ok: false, reason: "STARMAP_DRIFT",
        detail: "services/map/mapService.js:Handle_GetHistory not the vendor method" });
      assert.strictEqual(adapter.starmapOverlayStatus().kills.state, "refused:STARMAP_DRIFT");

      const timers = [];
      const make = (over, installResult = { ok: true }) => {
        const log = { installs: [], uninstalls: 0 };
        const fake = { installStarmapKills(p) {
          log.installs.push(p);
          return installResult;
        }, uninstallStarmapKills() {
          log.uninstalls += 1;
          return { ok: true };
        } };
        const r = startInGameMap({ config: { inGameMap: { enabled: true, chatEnabled: false, starmapJumpsEnabled: false,
          starmapKillsEnabled: true, starmapKillsRefreshMs: 60000, starmapMaxLossRows: 2000, ...over } },
        ctx: {}, adapter: fake, clock: { now: () => NOW }, setTimer: (fn, ms) => {
          const t = { fn, ms, cancelled: false, cancel() { t.cancelled = true; }, hasRef: () => false };
          timers.push(t);
          return t;
        } });
        return { r, log };
      };
      const off = make({ starmapKillsEnabled: false });
      assert.deepStrictEqual([off.log.installs.length, off.r.inGameMap.getStatus().starmapKills],
        [0, { state: "off", reason: null, losses: null }]);
      assert.strictEqual(timers.length, 0);
      const on = make({});
      assert.strictEqual(on.r.inGameMap.getStatus().starmapKills.state, "active");
      assert.strictEqual(on.log.installs[0].snapshot(), null, "no battle in ctx: no data (W58)");
      assert.ok(timers.some((t) => t.ms === 0 && !t.cancelled), "first read armed at once");
      on.r.inGameMap.stop("test");
      assert.strictEqual(on.log.uninstalls, 1);
      assert.ok(timers.every((t) => t.cancelled));
      const refused = make({}, { ok: false, reason: "KILLS_HOOK_NOT_ARMED" });
      assert.deepStrictEqual(refused.r.inGameMap.getStatus().starmapKills,
        { state: "refused", reason: "KILLS_HOOK_NOT_ARMED", losses: null });
      refused.r.inGameMap.stop("test");
      assert.strictEqual(refused.log.uninstalls, 0);
    });
  }

  const k4 = "K4 vendor facts: destructured forEach + 2 call sites, fields read, class method, sync scope, SHA-1, GAME_MODULES";
  if (!haveSrc) skip(k4, "server/src not found");
  else {
    test(k4, () => {
      const map = readSource(MAP_FILE);
      const tel = readSource(TELEMETRY_FILE);
      const sha1 = (t) => crypto.createHash("sha1").update(t).digest("hex");
      assert.ok(map.includes("const {\n  forEachKillmailRecordDescending,\n} = require(path.join(__dirname, \"../killmail/killmailState\"));"));
      assert.ok(!map.includes("getAllKillmailRecords"), "no getAll in mapService");
      const calls = "forEachKillmailRecordDescending((record) => {";
      assert.ok(!functionBody(map, "listKillHistoryRows").includes("return false"), "the vendor walk never stops");
      const km = readSource(KM_FILE);
      assert.match(km, /\nfunction forEachKillmailRecordDescending\(visitor\) \{\n {2}for \(const record of ensureKillmailIndexes\(\)\.recordsDesc\) \{\n {4}if \(visitor\(redactReservedAbyssalHostFromKillmail\(record\)\) === false\) \{\n {6}return;/);
      assert.match(km, /\n {2}forEachKillmailRecordDescending,\n/, "export");
      assert.strictEqual(km.split("forEachKillmailRecordDescending(").length - 1, 1, "no local call in killmailState");
      assert.strictEqual(map.split(calls).length - 1, 2);
      assert.ok(functionBody(map, "listKillHistoryRows").includes(calls));
      assert.ok(functionBody(map, "listFactionWarfareKillHistoryRows").includes(calls));
      const fields = new Set(functionBody(map, "listKillHistoryRows").match(/record && record\.(\w+)/g));
      assert.deepStrictEqual([...fields].sort(), ["record && record.killTime", "record && record.solarSystemID",
        "record && record.victimCharacterID", "record && record.victimShipTypeID"]);
      assert.ok(map.includes(`const MAP_HISTORY_STAT_KILLS = ${overlay.KILLS_STAT_ID};`));
      assert.ok(/^class MapService extends BaseService \{$/m.test(map) && /^module\.exports = MapService;$/m.test(map));
      const method = overlay.methodBody(map, "Handle_GetHistory");
      assert.ok(method.startsWith("Handle_GetHistory(args) {\n    const statID = toPositiveInteger(args && args[0], 0);"));
      assert.ok(method.includes("return buildCachedMethodCallResult(\n      buildRowset(HISTORY_COLUMNS, "
        + "buildHistoryRows(statID, hours), MAP_ROWSET),"), "rows built synchronously before the encoding");
      assert.ok(!/\bawait\b|\basync\b/.test(method));
      assert.ok(/\n {2}filetimeFromMs,\n/.test(tel.slice(tel.indexOf("module.exports = {"))), "own export");
      for (const name of Object.keys(overlay.KILLS_FUNCTION_SHA1)) {
        assert.strictEqual(sha1(functionBody(map, name)), overlay.KILLS_FUNCTION_SHA1[name], name);
      }
      assert.strictEqual(sha1(method), overlay.KILLS_METHOD_SHA1);
      const consumers = (p, name) => {
        const e = GAME_MODULES.filter((m) => m.path === p).flatMap((m) => m.symbols).find((s) => s.name === name);
        return e ? [e.kind, e.wrap, e.firstLoad, [...e.consumers]] : null;
      };
      assert.deepStrictEqual(consumers(overlay.MAP_SERVICE_PATH, "Handle_GetHistory"),
        ["classPrototypeMethod", true, undefined, ["inGameMap.starmap"]]);
      assert.deepStrictEqual(consumers(overlay.KILLMAIL_PATH, "getAllKillmailRecords"),
        ["export", undefined, true, ["telemetry.stallDiag"]]);
      assert.deepStrictEqual(consumers(overlay.KILLMAIL_PATH, "forEachKillmailRecordDescending"),
        ["export", undefined, true, ["inGameMap.starmap"]]);
      assert.deepStrictEqual(consumers(overlay.TELEMETRY_PATH, "filetimeFromMs"),
        ["export", undefined, undefined, ["inGameMap.starmap"]]);
    });
  }

  const k5 = "K5 loader hook stallDiagKillmail: off = no Kills layer; on = stall on getAll, ours on forEach, dbs obsolete; "
    + "W55, W58";
  if (!haveSrc) skip(k5, "server/src not found");
  else {
    test(k5, () => {
      const kmText = readSource(KM_FILE);
      const vendorKm = () => vm.runInThisContext(`(function (redactReservedAbyssalHostsFromKillmails, cloneValue,
        ensureKillmailIndexes, killmailProjectionStats, killmailIndexesDirty, killmailIndexes,
        redactReservedAbyssalHostFromKillmail) {
${functionBody(kmText, "getAllKillmailRecords")}
${functionBody(kmText, "forEachKillmailRecordDescending")}
${functionBody(kmText, "getKillmailProjectionStats")}
return { getAllKillmailRecords, forEachKillmailRecordDescending, getKillmailProjectionStats };
})`)((r) => r, (v) => v.slice(), () => ({ recordsDesc: [{ killID: 7 }] }), { fullRebuilds: 1, incrementalUpdates: 0 },
        false, {}, (r) => r);
      const walked = (fn) => {
        const out = [];
        fn((record) => {
          out.push(record);
        });
        return out;
      };
      const boot = (env) => {
        const km = vendorKm();
        const vendorGetAll = km.getAllKillmailRecords;
        const vendorForEach = km.forEachKillmailRecordDescending;
        const lines = [];
        const moduleApi = { _cache: { [KM_FILE]: { exports: km } }, _resolveFilename: (r) => r,
          _load: (request) => (request.includes("killmailState") ? km : {}) };
        const out = loader.install({ moduleApi, globalObj: {}, env: { EVEJS_GAMESTORE_OWNER_ROLE: "world" },
          isMainThread: true, logger: { log: (l) => lines.push(l), debug() {}, logError: (l) => lines.push(l) },
          loadConfig: () => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_DBS_KILLMAIL_CACHE_ENABLED: "1",
            ...env } }) });
        assert.ok(out.ok);
        moduleApi._load("../killmail/killmailState", { filename: path.join(SERVER_SRC, "services", "map", "mapService.js") });
        return { km, vendorGetAll, vendorForEach, lines };
      };
      const STALL = Symbol.for("livingNewEden.stallDiag.killmail");
      const obsoleteLine = (l) => l.startsWith("dbsKillmailCache: disabled:obsolete (");
      const off = boot({});
      assert.strictEqual(off.km.forEachKillmailRecordDescending, off.vendorForEach, "flag off: no Kills layer");
      assert.strictEqual(off.km.getAllKillmailRecords, off.vendorGetAll, "the dbs cache is obsolete: no getAll wrap");
      assert.ok(off.lines.some(obsoleteLine), off.lines.join("\n"));
      assert.deepStrictEqual(walked(off.km.forEachKillmailRecordDescending), [{ killID: 7 }]);

      const on = boot({ EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_TELEMETRY_STALL_DIAG_ENABLED: "1",
        EVEJS_LNE_TELEMETRY_STALL_DIAG_TIMER_TAGS: "0" });
      const ours = on.km.forEachKillmailRecordDescending;
      assert.strictEqual(ours[overlay.FOR_EACH_MARKER], on.vendorForEach, "ours on the vendor forEach");
      assert.strictEqual(on.km.getAllKillmailRecords[STALL], true, "the stall diag wrap on getAll");
      assert.ok(on.lines.some(obsoleteLine), on.lines.join("\n"));
      assert.ok(!on.lines.some((l) => /not wrapped|arm failed/.test(l)), on.lines.join("\n"));
      assert.deepStrictEqual(walked(ours), [{ killID: 7 }], "pass-through outside the scope");
      assert.deepStrictEqual(on.km.getAllKillmailRecords(), [{ killID: 7 }]);
      assert.strictEqual(overlay.killsStatus().state, "armed");

      const W = (env) => config.resolveConfig({ modDir: MOD_DIR, env }).warnings.filter((w) => w.startsWith("inGameMap."));
      assert.deepStrictEqual(W({ EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_BATTLE_ENABLED: "0",
        EVEJS_LNE_INGAME_MAP_STARMAP_JUMPS_ENABLED: "0" }),
      ["inGameMap.starmapKillsEnabled with modules.battle.enabled=false - no LNE kills in the star map"], "W58");
      assert.deepStrictEqual(W({ EVEJS_LNE_INGAME_MAP_STARMAP_KILLS_ENABLED: "1" }),
        ["inGameMap.starmapKillsEnabled without inGameMap.enabled - no effect"], "W55");
      const c = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_INGAME_MAP_STARMAP_KILLS_REFRESH_MS: "1",
        EVEJS_LNE_INGAME_MAP_STARMAP_MAX_SYNTHETIC_KILLS: "999999" } }).config.inGameMap;
      assert.deepStrictEqual([c.starmapKillsEnabled, c.starmapKillsRefreshMs, c.starmapMaxLossRows,
        c.starmapMaxSyntheticKills, c.starmapFallbackShipTypeId], [true, 10000, 2000, 50000, 587]);
    });
  }
};
