"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const { loadConfig } = require("../config");
const { createCareerCombatItemsRead } = require("../lib/careerCombatItemsRead");
const { openRowSource } = require("../lib/sqliteRowSource");

const SEP = "\u001f";
const ITEMS = "items";
const DRT = "dungeonRuntimeState";
const KEY = "__evejsCareerCombatOutcomes";
const SQLITE_FILE = "/app/server/src/gameStore/sqliteStore.js";
const GROUPS = { items: ["__evejsInventoryGrantReceipts"], dungeonRuntimeState: ["instancesByID"] };

function assembleFromRows(table, rows = {}) {
  const groups = new Set(GROUPS[table] || []);
  const object = {};
  for (const rowKey of Object.keys(rows)) {
    const at = rowKey.indexOf(SEP);
    if (at >= 0) {
      const group = rowKey.slice(0, at);
      if (!object[group] || typeof object[group] !== "object") object[group] = {};
      object[group][rowKey.slice(at + 1)] = rows[rowKey];
    } else if (groups.has(rowKey)) {
      const blob = rows[rowKey] && typeof rows[rowKey] === "object" && !Array.isArray(rows[rowKey]) ? rows[rowKey] : {};
      object[rowKey] = { ...blob, ...(object[rowKey] || {}) };
    } else {
      object[rowKey] = rows[rowKey];
    }
  }
  return object;
}

function receipt(characterID, id, acknowledged = false, version = 1) {
  return { version, characterID, event: { kind: "combat-effect", id, effect: "web", atMs: 1000 + characterID, amount: 1 }, acknowledged, atMs: 1000 };
}

function itemsTable(ledger) {
  const rows = new Map();
  for (let id = 1; id <= 20; id += 1) rows.set(String(id), JSON.stringify({ itemID: id, ownerID: 90000001, typeID: 587 }));
  rows.set("__evejsInventoryGrantReceipts", "{}");
  rows.set(`__evejsInventoryGrantReceipts${SEP}g1`, JSON.stringify({ ok: 1 }));
  if (ledger !== undefined) rows.set(KEY, JSON.stringify(ledger));
  return rows;
}

const parseRows = (rows) => {
  const parsed = {};
  for (const [k, json] of rows) parsed[k] = JSON.parse(json);
  return parsed;
};

function fakeRowSource(rows, table) {
  const rs = {
    rows, table, dbPath: "/data/evejs.sqlite", snapshots: 0, readKeys: [], throwNext: null, afterSnapshot: null, exists: true,
    readSnapshot(fn) {
      rs.snapshots += 1;
      if (rs.throwNext) { const e = rs.throwNext; rs.throwNext = null; throw e; }
      const view = new Map(rs.rows);
      const tx = {
        tableExists: () => rs.exists,
        listKeys: () => [...view.keys()].sort(),
        readRows: (keys) => keys.filter((k) => view.has(k)).map((k) => { rs.readKeys.push(k); return { key: k, json: view.get(k) }; }),
        classify: (keys) => keys.filter((k) => view.has(k)).map((k) => {
          const o = JSON.parse(view.get(k));
          return { key: k, abyssal: o.siteFamily === "abyssal" && o.siteKind === "abyssal-pocket" ? 1 : 0 };
        }),
        readEntry: (key) => [...view.keys()].filter((k) => k === key || k.startsWith(key + SEP))
          .map((k) => { rs.readKeys.push(k); return { key: k, json: view.get(k) }; }),
      };
      try {
        return fn(tx);
      } finally {
        if (rs.afterSnapshot) { const f = rs.afterSnapshot; rs.afterSnapshot = null; f(); }
      }
    },
  };
  return rs;
}

function fakeVendor(tables) {
  const v = { tables, loads: { items: 0, dungeonRuntimeState: 0 }, lastLoaded: {}, tamper: null };
  v.sqliteStore = {
    ROW_KEY_SEP: SEP,
    rowGroupsFor: (t) => GROUPS[t] || null,
    getDatabasePath: () => "/data/evejs.sqlite",
    assembleFromRows,
    loadExistingTableObject: function loadExistingTableObject(t) {
      v.loads[t] = (v.loads[t] || 0) + 1;
      v.lastLoaded[t] = assembleFromRows(t, parseRows(v.tables[t] || new Map()));
      if (v.tamper) v.tamper(t, v.lastLoaded[t]);
      return v.lastLoaded[t];
    },
  };
  v.gameStore = {
    readPersisted: function readPersisted(t, pth) {
      try {
        const segments = String(pth || "/").split("/").filter(Boolean);
        let current = v.sqliteStore.loadExistingTableObject(t);
        for (const s of segments) {
          if (current === null || typeof current !== "object" || !(s in current)) return { success: false, errorMsg: "ENTRY_NOT_FOUND", data: null };
          current = current[s];
        }
        return { success: true, errorMsg: null, data: current };
      } catch (_error) {
        return { success: false, errorMsg: "READ_ERROR", data: null };
      }
    },
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  v.body = null;
  v.itemStore = {
    listPendingCareerCombatOutcomes: function listPendingCareerCombatOutcomes(characterID) {
      if (v.body) return v.body(characterID);
      const result = v.gameStore.readPersisted(ITEMS, "/");
      if (!result?.success) return result || { success: false, errorMsg: "COMBAT_OUTCOME_READ_FAILED" };
      const ledger = result.data?.[KEY] || {};
      return { success: true, data: Object.values(ledger).filter((r) => r?.version === 1 &&
        r.characterID === Number(characterID) && r.acknowledged !== true).map(clone) };
    },
  };
  v.career = {
    reconcile() {
      const result = v.gameStore.readPersisted(DRT, "/");
      return Object.keys(result.data?.instancesByID || {});
    },
    reconcileRun() { return null; },
  };
  return v;
}

function register(ctx) {
  const { test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC } = ctx;
  const { createState, patchTarget, probeMessage } = loader;
  const combatConfig = Object.freeze({ ...config, careerCombatItemsRead: true });

  function setup(itemsRows, cfg = {}, drtRows = new Map()) {
    const out = capture();
    const v = fakeVendor({ items: itemsRows, dungeonRuntimeState: drtRows });
    const rsItems = fakeRowSource(itemsRows, ITEMS);
    const rsDrt = fakeRowSource(drtRows, DRT);
    const opened = [];
    const st = createState({ ...combatConfig, ...cfg }, createRecorder({ slowCallMs: 1e9 }, () => {}), {
      log: out.log,
      openRowSource: (o) => { opened.push(o); return o.table === ITEMS ? rsItems : rsDrt; },
    });
    patchTarget("sqliteStore", v.sqliteStore, st, SQLITE_FILE);
    patchTarget("gameStore", v.gameStore, st, "/app/server/src/gameStore/index.js");
    patchTarget("itemStore", v.itemStore, st, "/app/server/src/services/inventory/itemStore.js");
    patchTarget("careerAbyssal", v.career, st, "/app/server/src/services/career/careerAbyssalSources.js");
    return { out, v, rsItems, rsDrt, st, combat: st.combat, opened };
  }

  const vendorPending = (rows, characterID) => fakeVendor({ items: rows }).itemStore.listPendingCareerCombatOutcomes(characterID);

  test("B1 combat: missing key / empty table = {}; ledger with other characters and acknowledged = listPending as the vendor, without parsing items", () => {
    for (const rows of [new Map(), itemsTable(undefined)]) {
      const s = setup(rows);
      assert.deepStrictEqual(s.combat.readSubset().value, {});
      assert.deepStrictEqual(s.v.itemStore.listPendingCareerCombatOutcomes(7), { success: true, data: [] });
      assert.strictEqual(s.v.loads.items, 0, "inside the scope the vendor does not parse the table");
    }
    const ledger = {
      a: receipt(7, "e1"), b: receipt(7, "e2", true), c: receipt(8, "e3"), d: receipt(7, "e4", false, 2), e: receipt(7, "e5"),
    };
    const rows = itemsTable(ledger);
    const s = setup(rows);
    for (const id of [7, "7", 8, 9]) {
      assert.deepStrictEqual(s.v.itemStore.listPendingCareerCombatOutcomes(id), vendorPending(rows, id), `characterID=${id}`);
    }
    assert.deepStrictEqual(s.v.itemStore.listPendingCareerCombatOutcomes(7).data.map((r) => r.event.id), ["e1", "e5"]);
    assert.strictEqual(s.v.loads.items, 0);
    assert.deepStrictEqual([...new Set(s.rsItems.readKeys)], [KEY], "only the ledger row is read");
    assert.deepStrictEqual(s.opened, [{ sqliteStoreFilename: SQLITE_FILE, dbPath: "/data/evejs.sqlite", busyTimeoutMs: 5000, table: ITEMS }]);
    assert.strictEqual(s.combat.statsSnapshot().served, 5);
    assert.deepStrictEqual(s.out.lines, []);
    const line = s.combat.drainStatsLines()[0];
    assert.ok(/^stats careerCombatItemsRead state=ready rows=1 served=5 fallback=0 serveMaxMs=[\d.]+ parityChecks=0 parityRetries=0$/.test(line), line);
    const grouped = itemsTable(undefined);
    grouped.set(KEY, "{}");
    grouped.set(`${KEY}${SEP}a`, JSON.stringify(receipt(7, "g1")));
    const g = setup(grouped);
    assert.deepStrictEqual(g.v.itemStore.listPendingCareerCombatOutcomes(7), vendorPending(grouped, 7));
    assert.strictEqual(g.v.itemStore.listPendingCareerCombatOutcomes(7).data.length, 1);
  });

  test("B2 combat: a ledger change between calls is visible (no content cache)", () => {
    const rows = itemsTable({ a: receipt(7, "e1") });
    const s = setup(rows);
    assert.strictEqual(s.v.itemStore.listPendingCareerCombatOutcomes(7).data.length, 1);
    rows.set(KEY, JSON.stringify({ a: receipt(7, "e1", true), b: receipt(7, "e2"), c: receipt(7, "e3") }));
    assert.deepStrictEqual(s.v.itemStore.listPendingCareerCombatOutcomes(7).data.map((r) => r.event.id), ["e2", "e3"]);
    rows.delete(KEY);
    assert.deepStrictEqual(s.v.itemStore.listPendingCareerCombatOutcomes(7), { success: true, data: [] });
    assert.strictEqual(s.rsItems.snapshots, 3, "one SQL read per call");
    const a = s.combat.readSubset().value;
    const b = s.combat.readSubset().value;
    assert.notStrictEqual(a, b);
  });

  test("B3 combat: SQL error = vendor result + disabled:error (one WARN line); missing table = fallback; parity", () => {
    const rows = itemsTable({ a: receipt(7, "e1") });
    const e = setup(rows);
    e.rsItems.throwNext = new Error("SQLITE_BUSY: database is locked");
    assert.deepStrictEqual(e.v.itemStore.listPendingCareerCombatOutcomes(7), vendorPending(rows, 7));
    assert.strictEqual(e.v.loads.items, 1, "fallback = full vendor read");
    assert.strictEqual(e.combat.status().disabledReason, "error");
    assert.deepStrictEqual(e.out.lines, ["WARN careerCombatItemsRead disabled: error (SQLITE_BUSY: database is locked)"]);
    e.v.itemStore.listPendingCareerCombatOutcomes(7);
    assert.strictEqual(e.v.loads.items, 2, "after disabling: vendor");
    assert.strictEqual(e.out.lines.length, 1);
    const nt = setup(rows);
    nt.rsItems.exists = false;
    nt.v.itemStore.listPendingCareerCombatOutcomes(7);
    assert.strictEqual(nt.v.loads.items, 1);
    assert.strictEqual(nt.combat.statsSnapshot().fallbackByReason.get("NO_TABLE"), 1);
    assert.strictEqual(nt.combat.status().disabledReason, null);
    const p = setup(rows, { careerCombatItemsReadParityCheck: true });
    let served = null;
    p.v.body = () => { served = p.v.gameStore.readPersisted(ITEMS, "/").data; return null; };
    p.v.itemStore.listPendingCareerCombatOutcomes(7);
    assert.notStrictEqual(served, p.v.lastLoaded.items);
    assert.deepStrictEqual(Object.keys(served), [KEY]);
    p.rsItems.afterSnapshot = () => rows.set(KEY, JSON.stringify({ a: receipt(7, "e1", true) }));
    p.v.itemStore.listPendingCareerCombatOutcomes(7);
    assert.strictEqual(served.__evejsCareerCombatOutcomes.a.acknowledged, true);
    let snap = p.combat.statsSnapshot();
    assert.deepStrictEqual([snap.served, snap.parityChecks, snap.parityRetries, snap.disabledReason], [2, 2, 1, null]);
    p.v.tamper = (t, obj) => { if (t === ITEMS) obj[KEY] = {}; };
    p.v.itemStore.listPendingCareerCombatOutcomes(7);
    assert.strictEqual(served, p.v.lastLoaded.items, "vendor result");
    assert.strictEqual(p.combat.status().disabledReason, "parity");
    assert.deepStrictEqual(p.out.lines, ["WARN careerCombatItemsRead disabled: parity (ledger ours=1 vendor=0)"]);
  });

  test("B4 combat: outside the scope and other paths/tables = original; nesting and exception; flag off; config", () => {
    const rows = itemsTable({ a: receipt(7, "e1") });
    const s = setup(rows);
    for (const symbol of loader.COMBAT_POINTS.map((p) => p.symbol)) assert.ok(s.st.patched.has(symbol), symbol);
    const outside = s.v.gameStore.readPersisted(ITEMS, "/");
    assert.strictEqual(outside.data, s.v.lastLoaded.items, "outside the scope: original");
    const seen = {};
    s.v.body = () => {
      seen.x = s.v.gameStore.readPersisted(ITEMS, "/x");
      seen.item = s.v.gameStore.readPersisted(ITEMS, "/3").data;
      seen.other = s.v.gameStore.readPersisted("characters", "/");
      seen.loads = s.v.loads.items;
      seen.subsets = ["/", "", undefined].map((p) => s.v.gameStore.readPersisted(ITEMS, p).data);
      seen.loadsAfter = s.v.loads.items;
      return null;
    };
    s.v.itemStore.listPendingCareerCombatOutcomes(7);
    assert.deepStrictEqual(seen.x, { success: false, errorMsg: "ENTRY_NOT_FOUND", data: null });
    assert.deepStrictEqual(seen.item, { itemID: 3, ownerID: 90000001, typeID: 587 }, "/3 gets the full table");
    assert.strictEqual(seen.other.success, true);
    assert.strictEqual(seen.loads, 3, "outside the scope 1 + /x + /3");
    for (const d of seen.subsets) assert.deepStrictEqual(Object.keys(d), [KEY]);
    assert.strictEqual(seen.loadsAfter, 3, "/, \"\", undefined without the vendor");
    s.v.body = () => { throw new Error("combat boom"); };
    assert.throws(() => s.v.itemStore.listPendingCareerCombatOutcomes(7), /combat boom/);
    assert.deepStrictEqual([s.combat.status().depth, s.combat.status().serveNext], [0, false]);
    s.v.body = null;
    const off = createState(config, createRecorder(config, () => {}));
    assert.strictEqual(off.combat, null);
    assert.strictEqual(off.careerRead, null);
    const vOff = fakeVendor({ items: rows });
    const fns = [vOff.gameStore.readPersisted, vOff.sqliteStore.loadExistingTableObject, vOff.itemStore.listPendingCareerCombatOutcomes];
    patchTarget("sqliteStore", vOff.sqliteStore, off, SQLITE_FILE);
    patchTarget("gameStore", vOff.gameStore, off);
    patchTarget("itemStore", vOff.itemStore, off);
    assert.deepStrictEqual([vOff.gameStore.readPersisted, vOff.sqliteStore.loadExistingTableObject, vOff.itemStore.listPendingCareerCombatOutcomes], fns);
    assert.ok(!off.requestPattern.test("./itemStore"));
    assert.ok(s.st.requestPattern.test("./itemStore") && s.st.requestPattern.test("../../gameStore") && s.st.requestPattern.test("./sqliteStore"));
    assert.strictEqual(loader.targetOf("/app/server/src/services/inventory/itemStore.js"), "itemStore");
    assert.ok(!loader.GAME_TARGETS.has("itemStore"), "the wallet helper loads itemStore too: it does not mark the game process");
    assert.deepStrictEqual([config.careerCombatItemsRead, config.careerCombatItemsReadParityCheck, config.careerCombatItemsReadBusyTimeoutMs], [false, false, 5000]);
    const c = loadConfig({
      env: { HOTPATH_CAREER_COMBAT_ITEMS_READ: "1", HOTPATH_CAREER_COMBAT_ITEMS_READ_PARITY: "1", HOTPATH_CAREER_COMBAT_ITEMS_READ_BUSY_MS: "250" },
      settingsPath: path.join(__dirname, "missing.json"),
    });
    assert.deepStrictEqual([c.careerCombatItemsRead, c.careerCombatItemsReadParityCheck, c.careerCombatItemsReadBusyTimeoutMs], [true, true, 250]);
    const out = capture();
    const drift = createState(combatConfig, createRecorder(config, () => {}), { log: out.log });
    drift.gameSeen = true;
    const v2 = fakeVendor({ items: rows });
    patchTarget("sqliteStore", v2.sqliteStore, drift, SQLITE_FILE);
    patchTarget("gameStore", v2.gameStore, drift);
    assert.strictEqual(loader.checkCombatDrift(drift), true);
    const message = probeMessage(drift);
    assert.ok(message.includes("itemStore.listPendingCareerCombatOutcomes#scope") && message.endsWith("; careerCombatItemsRead disabled: drift"), message);
    const bad = createCareerCombatItemsRead({ config: combatConfig, log: out.log, openRowSource: () => assert.fail("open") });
    assert.strictEqual(bad.setDeps({ ...v2.sqliteStore, ROW_KEY_SEP: "|" }, SQLITE_FILE), false);
    assert.strictEqual(bad.status().disabledReason, "drift");
  });

  test("B5 coexistence with careerAbyssalRead: both on (one wrapper), one on, both off; order", () => {
    const drt = new Map([
      ["instancesByID", "{}"],
      [`instancesByID${SEP}3`, JSON.stringify({ instanceID: 3, siteFamily: "abyssal", siteKind: "abyssal-pocket" })],
      [`instancesByID${SEP}4`, JSON.stringify({ instanceID: 4, siteFamily: "ore", siteKind: "anomaly" })],
    ]);
    const rows = itemsTable({ a: receipt(7, "e1") });
    for (const [abyssal, combat] of [[true, true], [true, false], [false, true], [false, false]]) {
      const label = `abyssal=${abyssal} combat=${combat}`;
      const s = setup(rows, { careerAbyssalRead: abyssal, careerCombatItemsRead: combat }, drt);
      const rp = s.v.gameStore.readPersisted;
      const le = s.v.sqliteStore.loadExistingTableObject;
      if (abyssal || combat) {
        assert.strictEqual(rp.name, "hotPathPerfCareerGate", label);
        assert.strictEqual(rp.__hotPathPerfCareer.name, "readPersisted", `${label}: one wrap of readPersisted`);
        assert.strictEqual(le.__hotPathPerfCareer.name, "loadExistingTableObject", `${label}: one wrap of loadExistingTableObject`);
      } else {
        assert.strictEqual(rp.name, "readPersisted", label);
        assert.strictEqual(le.name, "loadExistingTableObject", label);
      }
      assert.deepStrictEqual(s.v.itemStore.listPendingCareerCombatOutcomes(7), vendorPending(rows, 7), label);
      assert.strictEqual(s.v.loads.items, combat ? 0 : 1, `${label}: items`);
      assert.deepStrictEqual(s.v.career.reconcile(), abyssal ? ["3"] : ["3", "4"], `${label}: abyssal`);
      assert.strictEqual(s.v.loads.dungeonRuntimeState, abyssal ? 0 : 1, `${label}: dungeonRuntimeState`);
      assert.deepStrictEqual(s.out.lines, [], label);
    }
    const s = setup(rows, { careerAbyssalRead: true }, drt);
    s.rsItems.throwNext = new Error("boom");
    s.v.itemStore.listPendingCareerCombatOutcomes(7);
    assert.strictEqual(s.combat.status().disabledReason, "error");
    assert.strictEqual(s.st.career.status().disabledReason, null);
    assert.deepStrictEqual(s.v.career.reconcile(), ["3"]);
    assert.strictEqual(s.v.loads.dungeonRuntimeState, 0);
    const v3 = fakeVendor({ items: rows });
    const inner = v3.gameStore.readPersisted;
    v3.gameStore.readPersisted = function otherModWrapper() { return inner.apply(this, arguments); };
    const ord = createState({ ...combatConfig, careerAbyssalRead: true }, createRecorder(config, () => {}), { log: () => {} });
    patchTarget("gameStore", v3.gameStore, ord);
    assert.deepStrictEqual([ord.career.status().disabledReason, ord.combat.status().disabledReason], ["order", "order"]);
    assert.strictEqual(v3.gameStore.readPersisted.name, "otherModWrapper");
  });

  test("B6 vendor facts 261108.1: upstream itself reads the character rows (readPersistedPendingCareerCombatOutcomes) → careerCombatItemsRead disabled:obsolete", () => {
    const norm = (rel) => src(rel).replace(/\r\n/g, "\n");
    const store = norm("services/inventory/itemStore.js");
    assert.ok(store.includes("function listPendingCareerCombatOutcomes(characterID) {\n  const result = database.readPersistedPendingCareerCombatOutcomes(characterID);"));
    assert.ok(!/readPersisted\(ITEMS_TABLE, "\/"\)/.test(store), "no read of the whole items table");
    const index = norm("gameStore/index.js");
    assert.ok(index.includes('readPersistedPendingCareerCombatOutcomes: characterID => readPersistedCareerRows("items", characterID),'));
    const sqlite = norm("gameStore/sqliteStore.js");
    assert.ok(/^module\.exports = \{[\s\S]*?\n {2}loadExistingCareerRows,/m.test(sqlite));
    const outcomes = norm("services/inventory/careerCombatOutcomes.js");
    assert.ok(/const fence = items\.flushCareerCombatOutcomes\(\);\n\s+if \(!fence\?\.success\) return fence;\n\s+const pending = items\.listPendingCareerCombatOutcomes\(characterID\);/.test(outcomes), "fence before the read");

    const out = capture();
    const v = fakeVendor({ items: new Map() });
    v.sqliteStore.loadExistingCareerRows = function loadExistingCareerRows() { return {}; };
    const origRead = v.gameStore.readPersisted;
    const origList = v.itemStore.listPendingCareerCombatOutcomes;
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const st = createState({ ...combatConfig, ...quiet, prewarmLocations: false }, createRecorder({ slowCallMs: 1e9 }, () => {}),
      { log: out.log, openRowSource: () => assert.fail("open") });
    patchTarget("sqliteStore", v.sqliteStore, st, SQLITE_FILE);
    patchTarget("gameStore", v.gameStore, st, "/app/server/src/gameStore/index.js");
    patchTarget("itemStore", v.itemStore, st, "/app/server/src/services/inventory/itemStore.js");
    assert.strictEqual(st.combat.status().disabledReason, "obsolete");
    assert.deepStrictEqual(out.lines, ["WARN careerCombatItemsRead disabled: obsolete (EveJS reads it itself: sqliteStore.loadExistingCareerRows)"]);
    assert.strictEqual(v.gameStore.readPersisted, origRead);
    assert.strictEqual(v.itemStore.listPendingCareerCombatOutcomes, origList);
    st.gameSeen = true;
    const msg = probeMessage(st);
    assert.ok(!msg.includes("DRIFT") && msg.endsWith("; careerCombatItemsRead disabled: obsolete"), msg);
  });

  test("B7 real SQLite (conditional): readEntry = key row + group, no neighboring keys", () => {
    const storeFile = path.join(SERVER_SRC, "gameStore", "sqliteStore.js");
    let Database;
    try {
      Database = Module.createRequire(storeFile)("better-sqlite3");
      new Database(":memory:").close();
    } catch (error) {
      console.log(`SKIP B7: better-sqlite3 unavailable (${error && error.message || error})`);
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath06-"));
    const dbPath = path.join(dir, "evejs.sqlite");
    const writer = new Database(dbPath);
    let rs = null;
    try {
      writer.exec(`CREATE TABLE IF NOT EXISTS "${ITEMS}" (key TEXT PRIMARY KEY, json TEXT NOT NULL)`);
      const ins = writer.prepare(`INSERT INTO "${ITEMS}" (key, json) VALUES (?, ?)`);
      for (const [k, json] of [[KEY, "{\"a\":1}"], [`${KEY}${SEP}x`, "2"], [`${KEY}x`, "3"], [`${KEY} `, "4"], ["5", "5"], ["__evejsInventoryGrantReceipts", "{}"]]) ins.run(k, json);
      rs = openRowSource({ sqliteStoreFilename: storeFile, dbPath, busyTimeoutMs: 100, table: ITEMS });
      const got = rs.readSnapshot((tx) => ({ exists: tx.tableExists(), rows: tx.readEntry(KEY) }));
      assert.strictEqual(got.exists, true);
      assert.deepStrictEqual(got.rows.map((r) => r.key).sort(), [KEY, `${KEY}${SEP}x`].sort());
      const c = createCareerCombatItemsRead({ config: { ...config, careerCombatItemsRead: true }, log: () => assert.fail("log"), openRowSource: () => rs });
      assert.strictEqual(c.setDeps(fakeVendor({}).sqliteStore, storeFile), true);
      assert.deepStrictEqual(c.readSubset().value, { [KEY]: { a: 1, x: 2 } });
      assert.throws(() => openRowSource({ sqliteStoreFilename: storeFile, dbPath, busyTimeoutMs: 1, table: 'x"; DROP' }), /invalid table/);
    } finally {
      if (rs) rs.close();
      writer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

module.exports = { register };
