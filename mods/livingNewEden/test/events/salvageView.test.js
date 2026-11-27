"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { seedDbFile } = require("../_support/dbTemplate");
const { resolveConfig } = require("../../config");
const repo = require("../../lib/events/salvage/anomalyRepository");
const { buildSalvageView, VIEW_ID } = require("../../lib/events/salvage/salvageView");
const { startSalvageAnomaly } = require("../../lib/events/salvage");
const { STATE } = require("../../lib/events/salvage/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const WEB_DIR = path.join(MOD_DIR, "web");
const T0 = 1700000000000;
const HOUR = 3600000;
const SYS = 30000011;
const SYS2 = 30000012;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-salv-view-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return fn(store, opened);
  } finally {
    if (store && store.isOpen()) store.close("test");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function tx(store, fn) {
  const r = store.transaction("test", fn);
  assert.ok(r.ok, String(r.error || r.reason));
  return r.value;
}

function seedRows(store) {
  const ids = ["f-a", "f-b", "f-c"].map((fieldId, i) => {
    const anomalyId = repo.anomalyIdOf(fieldId);
    const r = tx(store, (db) => repo.insertInTx(db, { anomalyId, fieldId, systemId: i === 2 ? SYS2 : SYS,
      haulSalvage: 4 + i, haulLoot: 2, seed: 7, planRows: [[1, 2]], expiresAt: T0 + HOUR, now: T0 + i }));
    assert.ok(r.ok, JSON.stringify(r));
    return anomalyId;
  });
  const t = tx(store, (db) => repo.transitionInTx(db, repo.getInTx(db, ids[0]),
    { state: STATE.ENDED, end_reason: "FIELD_GONE", ended_at: T0 + 10, updated_at: T0 + 10 }));
  assert.ok(t.ok, JSON.stringify(t));
  return ids;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("SVW1 repository: countByStateInTx, listLiveInTx (newest first, limit), listRecentEndedInTx", () => {
    withStore(driver, (store) => {
      const ids = seedRows(store);
      const out = tx(store, (db) => ({ counts: repo.countByStateInTx(db),
        one: repo.listLiveInTx(db, 1).map((r) => r.anomalyId),
        all: repo.listLiveInTx(db, 10).map((r) => r.anomalyId),
        ended: repo.listRecentEndedInTx(db, 20).map((r) => [r.anomalyId, r.endReason, r.endedAt]) }));
      assert.deepStrictEqual(out, { counts: { SITE_PENDING: 2, ENDED: 1 }, one: [ids[2]], all: [ids[2], ids[1]],
        ended: [[ids[0], "FIELD_GONE", T0 + 10]] });
    });
  });

  needsDriver("SVW4 countCollectableBySystemInTx: PLACED + ENDING + ENDED in one system -> 1 collectable "
    + "2 live", () => {
    withStore(driver, (store) => {
      const states = [STATE.PLACED, STATE.ENDING, STATE.ENDED];
      ["g-a", "g-b", "g-c"].forEach((fieldId, i) => {
        const anomalyId = repo.anomalyIdOf(fieldId);
        assert.ok(tx(store, (db) => repo.insertInTx(db, { anomalyId, fieldId, systemId: SYS, haulSalvage: 4,
          haulLoot: 2, seed: 7, planRows: [[1, 2]], expiresAt: T0 + HOUR, now: T0 + i })).ok);
        const t = tx(store, (db) => repo.transitionInTx(db, repo.getInTx(db, anomalyId),
          { state: states[i], updated_at: T0 + 10 }));
        assert.ok(t.ok, JSON.stringify(t));
      });
      const out = tx(store, (db) => [repo.countCollectableBySystemInTx(db, SYS), repo.countLiveBySystemInTx(db, SYS),
        repo.countCollectableBySystemInTx(db, SYS2)]);
      assert.deepStrictEqual(out, [1, 2, 0]);
    });
  });

  needsDriver("SVW2 view: truncation, observed, system names, counts, STORE_CLOSED / GOVERNOR_HOLD, cacheKey",
    () => {
      withStore(driver, (store) => {
        const ids = seedRows(store);
        let status = { state: "running", passes: 3, listening: true, lootTablesMissing: 0, last: { claimed: 1 } };
        let observed = [SYS2];
        let held = false;
        const graph = { getGraph: () => ({ ok: true,
          graph: { getSystem: (id) => (id === SYS2 ? { name: "Jita" } : null) } }) };
        const view = buildSalvageView({ store, repository: repo, getStatus: () => status,
          getPresence: () => (observed === null ? null : { observedSystems: () => observed }),
          getGovernor: () => ({ admits: (cls) => (cls === "MAINTENANCE" ? !held : true) }), graph, maxRows: 1,
          clock: { now: () => T0 } });
        assert.strictEqual(view.title, "Salvage anomalies");
        assert.strictEqual(view.order, 57);
        const d = view.getData();
        assert.deepStrictEqual([d.available, d.state, d.passes, d.listening, d.lootTablesMissing, d.last],
          [true, "running", 3, true, 0, { claimed: 1 }]);
        assert.deepStrictEqual(d.counts, { SITE_PENDING: 2, PLACING: 0, PLACED: 0, ENDING: 0, ENDED: 1 });
        assert.strictEqual(d.truncated, true);
        assert.deepStrictEqual(d.live, [{ anomaly: ids[2], system: "Jita", systemId: SYS2, observed: true,
          state: "SITE_PENDING", wrecksPlanned: 1, wrecksPlaced: 0, wrecksRemaining: 0, haulSalvage: 6, haulLoot: 2,
          createdAt: T0 + 2, expiresAt: T0 + HOUR }]);
        assert.deepStrictEqual(d.ended, [{ anomaly: ids[0], system: SYS, systemId: SYS, endReason: "FIELD_GONE",
          wrecksPlanned: 1, wrecksPlaced: 0, endedAt: T0 + 10 }]);
        assert.strictEqual(ids[2].length, 37);

        observed = [SYS];
        const wide = buildSalvageView({ store, repository: repo, getStatus: () => status,
          getPresence: () => (observed === null ? null : { observedSystems: () => observed }), maxRows: 5 });
        const w = wide.getData();
        assert.deepStrictEqual([w.truncated, w.live.map((r) => [r.systemId, r.observed, r.system])],
          [false, [[SYS2, false, SYS2], [SYS, true, SYS]]]);
        observed = null;
        assert.deepStrictEqual(wide.getData().live.map((r) => r.observed), [null, null]);

        assert.strictEqual(view.cacheKey(), "p3");
        status = { ...status, passes: 4 };
        assert.strictEqual(view.cacheKey(), "p4");
        held = true;
        assert.deepStrictEqual([view.getData(), view.cacheKey()],
          [{ available: false, reason: "GOVERNOR_HOLD" }, null]);
        held = false;
        store.close("test");
        assert.deepStrictEqual([view.getData(), view.cacheKey()],
          [{ available: false, reason: "STORE_CLOSED" }, null]);
      });
    });

  needsDriver("SVW3 wiring: salvagePanelMaxRows 0 -> no view, 50 -> view salvage, stop() unregisters "
    + "web/tabs.js puts salvage in war after materialization", () => {
    withStore(driver, (store, opened) => {
      const clock = { now: () => T0 };
      const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
      const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed };
      const registered = new Map();
      const views = { registerView(id, def) {
        if (registered.has(id)) return { ok: false, reason: "VIEW_EXISTS" };
        registered.set(id, def);
        return { ok: true, unregister() { registered.delete(id); } };
      } };
      const adapter = { checkNativeWrecks: () => ({ ok: true }),
        getNativeWrecks: () => ({ ok: true, checkLootTables: () => ({ ok: true, missing: [] }),
          checkWreckNames: () => ({ ok: true, missing: [] }) }) };
      const sites = { createSiteInTx() {}, getStatus: () => ({ state: "running" }) };
      const start = (rows) => {
        const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SITES_ENABLED: "1",
          EVEJS_LNE_OBSERVER_SALVAGE_PANEL_MAX_ROWS: String(rows) } });
        assert.deepStrictEqual(r.errors, []);
        assert.strictEqual(r.config.observer.salvagePanelMaxRows, rows);
        const started = startSalvageAnomaly({ config: r.config, persistence, clock, adapter, views,
          getSites: () => sites, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
        assert.strictEqual(started.ok, true, JSON.stringify(started));
        return started.salvageAnomaly;
      };
      const off = start(0);
      assert.strictEqual(registered.size, 0);
      off.stop();
      const on = start(50);
      assert.deepStrictEqual([...registered.keys()], [VIEW_ID]);
      assert.strictEqual(VIEW_ID, "salvage");
      const def = registered.get(VIEW_ID);
      assert.deepStrictEqual([def.title, def.getData().available, def.cacheKey()], ["Salvage anomalies", true, "p0"]);
      on.stop();
      assert.strictEqual(registered.size, 0);
      assert.strictEqual(resolveConfig({ modDir: MOD_DIR, env: {} }).config.observer.salvagePanelMaxRows, 50);
    });

    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(WEB_DIR, "tabs.js"), "utf8"), sandbox, { filename: "tabs.js" });
    const tabs = sandbox.window.LneTabs;
    assert.strictEqual(tabs._pure.tabOf("salvage"), "war");
    const war = JSON.parse(JSON.stringify(tabs.TABS.find((t) => t.id === "war").views));
    assert.strictEqual(war.indexOf("salvage"), war.indexOf("materialization") + 1);
  });
};
