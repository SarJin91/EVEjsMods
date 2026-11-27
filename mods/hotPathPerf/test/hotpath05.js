"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const { loadConfig } = require("../config");
const { createCareerAbyssalRead } = require("../lib/careerAbyssalRead");
const { openRowSource } = require("../lib/sqliteRowSource");
const { createTemplateReadOnly } = require("../lib/templateReadOnly");

const SEP = "\u001f";
const T = "dungeonRuntimeState";

const positive = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0);
function runFrom(instance) {
  const run = instance?.environmentState?.abyssalRuntimeState?.pocketState;
  return instance?.siteFamily === "abyssal" && instance?.siteKind === "abyssal-pocket" &&
    positive(instance.instanceID) && positive(run?.instanceID) === positive(instance.instanceID) ? run : null;
}

function assembleFromRows(table, rows = {}) {
  const groups = new Set(table === T ? ["instancesByID"] : []);
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

function abyssal(id, extra = {}) {
  return {
    instanceID: id, siteFamily: "abyssal", siteKind: "abyssal-pocket", lifecycleState: "active",
    environmentState: { abyssalRuntimeState: { pocketState: { instanceID: id, tier: 2, state: "active" } } }, ...extra,
  };
}

function plain(id, extra = {}) {
  return { instanceID: id, siteFamily: "ore", siteKind: "anomaly", lifecycleState: "active", metadata: {}, ...extra };
}

function table(records, { scalars = { nextInstanceSequence: 100 }, skeleton = "{}" } = {}) {
  const rows = new Map();
  for (const [k, v] of Object.entries(scalars)) rows.set(k, JSON.stringify(v));
  if (skeleton !== null) rows.set("instancesByID", skeleton);
  for (const r of records) rows.set(`instancesByID${SEP}${r.instanceID}`, JSON.stringify(r));
  return rows;
}

function putRecord(rows, record) {
  rows.set(`instancesByID${SEP}${record.instanceID}`, JSON.stringify(record));
}

function fakeRowSource(rows) {
  const rs = {
    rows, dbPath: "/data/evejs.sqlite", snapshots: 0, classifiedKeys: [], readKeys: [], throwNext: null, afterSnapshot: null,
    readSnapshot(fn) {
      rs.snapshots += 1;
      if (rs.throwNext) { const e = rs.throwNext; rs.throwNext = null; throw e; }
      const view = new Map(rs.rows);
      const tx = {
        tableExists: () => true,
        listKeys: () => [...view.keys()].sort(),
        readRows: (keys) => keys.filter((k) => view.has(k)).map((k) => { rs.readKeys.push(k); return { key: k, json: view.get(k) }; }),
        classify: (keys) => keys.filter((k) => view.has(k)).map((k) => {
          rs.classifiedKeys.push(k);
          const text = view.get(k);
          if (!text.includes('"abyssal-pocket"')) return { key: k, abyssal: 0 };
          const o = JSON.parse(text);
          return { key: k, abyssal: o.siteFamily === "abyssal" && o.siteKind === "abyssal-pocket" ? 1 : 0 };
        }),
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

function fakeVendor(rows) {
  const v = { rows, loads: 0, lastLoaded: null, throwInReady: false, tamper: null };
  v.sqliteStore = {
    ROW_KEY_SEP: SEP,
    rowGroupsFor: (t) => (t === T ? ["instancesByID"] : null),
    getDatabasePath: () => "/data/evejs.sqlite",
    assembleFromRows,
    loadExistingTableObject: function loadExistingTableObject(t) {
      v.loads += 1;
      const parsed = {};
      for (const [k, json] of (t === T ? v.rows : new Map([["x", "1"]]))) parsed[k] = JSON.parse(json);
      v.lastLoaded = assembleFromRows(t, parsed);
      if (v.tamper) v.tamper(v.lastLoaded);
      return v.lastLoaded;
    },
  };
  v.gameStore = {
    readPersisted: function readPersisted(t, pth) {
      try {
        if (v.throwInReady) throw new Error("ensureSqliteReady boom");
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
  const readRuns = () => {
    const result = v.gameStore.readPersisted(T, "/");
    if (!result?.success) throw new Error(result?.errorMsg || "CAREER_ABYSSAL_READ_FAILED");
    return result.data?.instancesByID || {};
  };
  v.body = null;
  v.career = {
    reconcile(characterID) {
      if (v.body) return v.body(characterID);
      return Object.values(readRuns()).map(runFrom).filter(Boolean).map((run) => run.instanceID);
    },
    reconcileRun(instanceID) {
      const run = runFrom(readRuns()[String(positive(instanceID))]);
      return run ? { run: run.instanceID } : { success: true, skipped: true };
    },
  };
  return v;
}

const SQLITE_FILE = "/app/server/src/gameStore/sqliteStore.js";

function register(ctx) {
  const { test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC } = ctx;
  const { createState, patchTarget, probeMessage } = loader;
  const careerConfig = Object.freeze({ ...config, careerAbyssalRead: true });

  function careerSetup(rows, cfg = {}, rsOverride) {
    const out = capture();
    const v = fakeVendor(rows);
    const rs = rsOverride || fakeRowSource(rows);
    const opened = [];
    const st = createState({ ...careerConfig, ...cfg }, createRecorder({ slowCallMs: 1e9 }, () => {}), {
      log: out.log,
      openRowSource: (o) => { opened.push(o); return rs; },
    });
    patchTarget("sqliteStore", v.sqliteStore, st, SQLITE_FILE);
    patchTarget("gameStore", v.gameStore, st, "/app/server/src/gameStore/index.js");
    patchTarget("careerAbyssal", v.career, st, "/app/server/src/services/career/careerAbyssalSources.js");
    return { out, v, rs, st, career: st.career, opened };
  }

  const fullRuns = (rows) => {
    const parsed = {};
    for (const [k, json] of rows) parsed[k] = JSON.parse(json);
    return Object.values(assembleFromRows(T, parsed).instancesByID || {}).map(runFrom).filter(Boolean).map((r) => r.instanceID);
  };

  test("A1 career: empty table / skeleton = vendor; abyssal + non-abyssal = only candidates, scalars, runFrom as on the full table", () => {
    for (const rows of [new Map(), table([], { scalars: {}, skeleton: "{}" }), table([], { scalars: {}, skeleton: null })]) {
      const s = careerSetup(rows);
      const ours = s.v.gameStore.readPersisted(T, "/");
      assert.deepStrictEqual(s.career.readSubset().value, s.v.sqliteStore.loadExistingTableObject(T));
      assert.deepStrictEqual(ours, { success: true, errorMsg: null, data: s.v.lastLoaded }, "outside the scope: vendor");
      const served = s.v.career.reconcile(1);
      assert.deepStrictEqual(served, []);
    }
    const records = [
      abyssal(3), plain(4), abyssal(9), plain(12, { metadata: { note: "abyssal-pocket" } }),
      plain(15, { siteFamily: "abyssal", siteKind: "abyssal-trace" }), abyssal(21, { environmentState: {} }),
    ];
    const rows = table(records, { scalars: { nextInstanceSequence: 22, schema: { v: 3 } } });
    const s = careerSetup(rows);
    const loads = s.v.loads;
    const runs = s.v.career.reconcile(7);
    assert.strictEqual(s.v.loads, loads, "inside the scope the vendor does not parse the table");
    assert.deepStrictEqual(runs, fullRuns(rows), "runFrom on the subset = on the full table");
    assert.deepStrictEqual(runs, [3, 9]);
    const value = s.career.readSubset().value;
    assert.deepStrictEqual(Object.keys(value.instancesByID).sort(), ["21", "3", "9"]);
    assert.deepStrictEqual([value.nextInstanceSequence, value.schema], [22, { v: 3 }], "table scalars are kept");
    assert.ok(!s.rs.readKeys.includes(`instancesByID${SEP}12`), "a false instr hit is not read");
    assert.deepStrictEqual(s.v.career.reconcileRun(9), { run: 9 });
    assert.deepStrictEqual(s.v.career.reconcileRun(4), { success: true, skipped: true }, "non-candidate = skipped as in the vendor");
    assert.strictEqual(s.career.statsSnapshot().served, 3);
    assert.deepStrictEqual(s.opened[0], { sqliteStoreFilename: SQLITE_FILE, dbPath: "/data/evejs.sqlite", busyTimeoutMs: 5000 });
    assert.deepStrictEqual(s.out.lines, []);
    const line = s.career.drainStatsLines()[0];
    assert.ok(/^stats careerAbyssalRead state=ready keys=9 candidates=3 served=3 fallback=0 classified=6 reclassified=\d+ serveMaxMs=[\d.]+ firstBuildMs=[\d.]+ parityChecks=0 parityRetries=0$/.test(line), line);
  });

  test("A2 career: new / removed key, fresh candidate content, a family jump is caught by reclassification ≤ ⌈N/64⌉", () => {
    const rows = table([abyssal(1), plain(2)]);
    const s = careerSetup(rows);
    assert.deepStrictEqual(s.v.career.reconcile(1), [1]);
    putRecord(rows, abyssal(5));
    assert.deepStrictEqual(s.v.career.reconcile(1), [1, 5], "new abyssal key visible");
    rows.delete(`instancesByID${SEP}1`);
    assert.deepStrictEqual(s.v.career.reconcile(1), [5], "removed one disappears");
    putRecord(rows, abyssal(5, { environmentState: { abyssalRuntimeState: { pocketState: { instanceID: 5, tier: 4 } } } }));
    assert.strictEqual(s.career.readSubset().value.instancesByID["5"].environmentState.abyssalRuntimeState.pocketState.tier, 4, "content fresh");
    const many = [];
    for (let id = 100; id < 230; id += 1) many.push(plain(id));
    const big = table(many);
    const b = careerSetup(big);
    assert.deepStrictEqual(b.v.career.reconcile(1), []);
    putRecord(big, abyssal(229));
    const n = many.length;
    const limit = Math.ceil(n / 64);
    let seenAt = 0;
    for (let call = 1; call <= limit; call += 1) {
      if (b.v.career.reconcile(1).includes(229)) { seenAt = call; break; }
    }
    assert.ok(seenAt >= 1 && seenAt <= limit, `jump visible within ≤ ${limit} calls (seenAt=${seenAt})`);
    assert.ok(b.career.statsSnapshot().reclassified > 0);
  });

  test("A3 career: gate and scope, paths, nesting, exception, serveNext does not leak, flag off", () => {
    const rows = table([abyssal(3), plain(4)]);
    const s = careerSetup(rows);
    for (const symbol of loader.CAREER_POINTS.map((p) => p.symbol)) assert.ok(s.st.patched.has(symbol), symbol);
    assert.ok(s.v.gameStore.readPersisted.__hotPathPerfCareer && s.v.sqliteStore.loadExistingTableObject.__hotPathPerfCareer);
    const outside = s.v.gameStore.readPersisted(T, "/");
    assert.strictEqual(outside.data, s.v.lastLoaded);
    const seen = {};
    s.v.body = () => {
      const loads0 = s.v.loads;
      seen.other = s.v.gameStore.readPersisted("characters", "/").data === s.v.lastLoaded;
      seen.entry = s.v.gameStore.readPersisted(T, "/instancesByID/4");
      seen.entryVendor = s.v.loads === loads0 + 2;
      seen.x = s.v.gameStore.readPersisted(T, "/x");
      const loads1 = s.v.loads;
      seen.subsets = ["/", "", undefined].map((p) => s.v.gameStore.readPersisted(T, p).data);
      seen.subsetNoVendor = s.v.loads === loads1;
      return null;
    };
    s.v.career.reconcile(1);
    assert.strictEqual(seen.other, true);
    assert.deepStrictEqual(seen.entry.data, plain(4), "a read of /instancesByID/<id> gets the full table");
    assert.strictEqual(seen.entryVendor, true);
    assert.deepStrictEqual(seen.x, { success: false, errorMsg: "ENTRY_NOT_FOUND", data: null });
    for (const d of seen.subsets) assert.deepStrictEqual(Object.keys(d.instancesByID), ["3"]);
    assert.strictEqual(seen.subsetNoVendor, true);
    let depthInside = -1;
    s.v.body = () => { depthInside = s.career.status().depth; return s.v.career.reconcileRun(3); };
    assert.deepStrictEqual(s.v.career.reconcile(1), { run: 3 });
    assert.strictEqual(depthInside, 1);
    s.v.body = () => { throw new Error("career boom"); };
    assert.throws(() => s.v.career.reconcile(1), /career boom/);
    assert.strictEqual(s.career.status().depth, 0);
    s.v.body = () => {
      s.v.throwInReady = true;
      const r = s.v.gameStore.readPersisted(T, "/");
      s.v.throwInReady = false;
      const direct = s.v.sqliteStore.loadExistingTableObject(T);
      return { r, directIsVendor: direct === s.v.lastLoaded, serveNext: s.career.status().serveNext };
    };
    const leak = s.v.career.reconcile(1);
    assert.deepStrictEqual(leak, { r: { success: false, errorMsg: "READ_ERROR", data: null }, directIsVendor: true, serveNext: false });
    s.v.body = null;
    assert.strictEqual(s.career.status().disabledReason, null);
    const off = createState(config, createRecorder(config, () => {}));
    assert.strictEqual(off.career, null);
    assert.strictEqual(off.template, null);
    for (const p of loader.CAREER_POINTS) assert.ok(!off.expected.has(p.symbol), p.symbol);
    const vOff = fakeVendor(rows);
    const fns = [vOff.gameStore.readPersisted, vOff.sqliteStore.loadExistingTableObject, vOff.career.reconcile];
    patchTarget("sqliteStore", vOff.sqliteStore, off, SQLITE_FILE);
    patchTarget("gameStore", vOff.gameStore, off);
    patchTarget("careerAbyssal", vOff.career, off);
    assert.deepStrictEqual([vOff.gameStore.readPersisted, vOff.sqliteStore.loadExistingTableObject, vOff.career.reconcile], fns);
    assert.ok(!off.requestPattern.test("../../gameStore") && !off.requestPattern.test("./careerAbyssalSources"));
    assert.ok(s.st.requestPattern.test("../../gameStore") && s.st.requestPattern.test("./sqliteStore") &&
      s.st.requestPattern.test("./careerAbyssalSources") && s.st.requestPattern.test("../config/configService"));
    assert.ok(!s.st.requestPattern.test("./dungeonAuthority"), "templates only with their own flag");
    assert.strictEqual(config.careerAbyssalRead, false);
    assert.deepStrictEqual([config.careerAbyssalReadParityCheck, config.careerAbyssalReadReclassifyPerCall, config.careerAbyssalReadMaxKeys,
      config.careerAbyssalReadBusyTimeoutMs, config.templateReadOnlyView, config.templateReadOnlyViewParityCheck], [false, 64, 200000, 5000, false, false]);
    const c = loadConfig({
      env: { HOTPATH_CAREER_ABYSSAL_READ: "1", HOTPATH_CAREER_ABYSSAL_READ_PARITY: "true", HOTPATH_CAREER_ABYSSAL_READ_RECLASSIFY: "0",
        HOTPATH_CAREER_ABYSSAL_READ_MAX_KEYS: "50", HOTPATH_CAREER_ABYSSAL_READ_BUSY_MS: "x", HOTPATH_TEMPLATE_READONLY: "on", HOTPATH_TEMPLATE_READONLY_PARITY: "1" },
      settingsPath: path.join(__dirname, "missing.json"),
    });
    assert.deepStrictEqual([c.careerAbyssalRead, c.careerAbyssalReadParityCheck, c.careerAbyssalReadReclassifyPerCall, c.careerAbyssalReadMaxKeys,
      c.careerAbyssalReadBusyTimeoutMs, c.templateReadOnlyView, c.templateReadOnlyViewParityCheck], [true, true, 0, 50, 5000, true, true]);
  });

  test("A4 career: read error = vendor + disabled:error, legacy, limit, drift deps; lazy probe", () => {
    const rows = table([abyssal(3), plain(4)]);
    const e = careerSetup(rows);
    e.rs.throwNext = new Error("SQLITE_BUSY: database is locked");
    const r = e.v.gameStore.readPersisted(T, "/");
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.data, e.v.lastLoaded, "vendor result");
    e.v.body = () => e.v.gameStore.readPersisted(T, "/").data;
    e.rs.throwNext = new Error("SQLITE_BUSY: database is locked");
    assert.strictEqual(e.v.career.reconcile(1), e.v.lastLoaded, "inside the scope: vendor result");
    assert.strictEqual(e.career.status().disabledReason, "error");
    assert.deepStrictEqual(e.out.lines, ["WARN careerAbyssalRead disabled: error (SQLITE_BUSY: database is locked)"]);
    assert.strictEqual(e.v.career.reconcile(1), e.v.lastLoaded, "after disabling: vendor");
    assert.strictEqual(e.out.lines.length, 1, "one WARN line");
    const legacy = careerSetup(table([abyssal(3)], { skeleton: JSON.stringify({ 7: plain(7) }) }));
    legacy.v.body = () => legacy.v.gameStore.readPersisted(T, "/").data;
    assert.strictEqual(legacy.v.career.reconcile(1), legacy.v.lastLoaded);
    assert.strictEqual(legacy.career.status().disabledReason, "legacy");
    assert.ok(/^WARN careerAbyssalRead disabled: legacy/.test(legacy.out.lines[0]));
    const lim = careerSetup(table([abyssal(3), plain(4)]), { careerAbyssalReadMaxKeys: 3 });
    lim.v.body = () => lim.v.gameStore.readPersisted(T, "/").data;
    assert.strictEqual(lim.v.career.reconcile(1), lim.v.lastLoaded);
    assert.strictEqual(lim.career.status().disabledReason, "limit");
    for (const bad of [{ ROW_KEY_SEP: "|" }, { rowGroupsFor: () => ["records"] }]) {
      const out = capture();
      const c = createCareerAbyssalRead({ config: careerConfig, log: out.log, openRowSource: () => assert.fail("open") });
      assert.strictEqual(c.setDeps({ ...fakeVendor(rows).sqliteStore, ...bad }, SQLITE_FILE), false);
      assert.strictEqual(c.status().disabledReason, "drift");
      assert.ok(/^WARN careerAbyssalRead disabled: drift/.test(out.lines[0]), out.lines[0]);
    }
    const waiting = createCareerAbyssalRead({ config: careerConfig, log: () => assert.fail("log") });
    assert.strictEqual(waiting.setDeps({}, SQLITE_FILE), false, "empty exports (require cycle) = not yet");
    assert.strictEqual(waiting.status().state, "waiting");
    const out = capture();
    const drift = createState(careerConfig, createRecorder(config, () => {}), { log: out.log });
    drift.gameSeen = true;
    patchTarget("gameStore", fakeVendor(rows).gameStore, drift);
    assert.strictEqual(loader.checkCareerDrift(drift), true);
    const message = probeMessage(drift);
    assert.ok(/^DRIFT: /.test(message) && message.includes("sqliteStore#deps") && message.includes("sqliteStore.loadExistingTableObject#serve"), message);
    assert.ok(!message.includes("careerAbyssalSources"), "career scope is lazy");
    assert.ok(message.endsWith("; careerAbyssalRead disabled: drift"), message);
    const lazy = careerSetup(rows);
    const lazyState = createState(careerConfig, createRecorder(config, () => {}), { log: () => {}, openRowSource: () => lazy.rs });
    lazyState.gameSeen = true;
    const v2 = fakeVendor(rows);
    patchTarget("sqliteStore", v2.sqliteStore, lazyState, SQLITE_FILE);
    patchTarget("gameStore", v2.gameStore, lazyState);
    for (const point of [...loader.POINTS, ...loader.PREWARM_POINTS]) lazyState.patched.add(point.symbol);
    assert.strictEqual(loader.checkCareerDrift(lazyState), false);
    const passed = probeMessage(lazyState);
    assert.ok(/^probe: passed/.test(passed) && passed.endsWith("; careerAbyssalRead waiting"), passed);
    patchTarget("careerAbyssal", {}, lazyState);
    const late = probeMessage(lazyState);
    assert.ok(/^DRIFT: careerAbyssalSources\.reconcile#scope, careerAbyssalSources\.reconcileRun#scope/.test(late), late);
    patchTarget("careerAbyssal", v2.career, lazyState);
    assert.ok(/^probe: passed/.test(probeMessage(lazyState)));
    const ord = createState(careerConfig, createRecorder(config, () => {}), { log: out.log });
    const v3 = fakeVendor(rows);
    const inner = v3.gameStore.readPersisted;
    v3.gameStore.readPersisted = function otherModWrapper() { return inner.apply(this, arguments); };
    patchTarget("gameStore", v3.gameStore, ord);
    assert.strictEqual(ord.career.status().disabledReason, "order");
    assert.strictEqual(v3.gameStore.readPersisted.name, "otherModWrapper");
  });

  test("A5 career parity: a match serves; a one-off mismatch passes after a retry; a persistent one = disabled:parity", () => {
    const rows = table([abyssal(3), plain(4)]);
    const p = careerSetup(rows, { careerAbyssalReadParityCheck: true });
    p.v.body = () => p.v.gameStore.readPersisted(T, "/").data;
    const r1 = p.v.career.reconcile(1);
    assert.notStrictEqual(r1, p.v.lastLoaded);
    assert.deepStrictEqual(Object.keys(r1.instancesByID), ["3"]);
    let snap = p.career.statsSnapshot();
    assert.deepStrictEqual([snap.served, snap.parityChecks, snap.parityRetries], [1, 1, 0]);
    p.rs.afterSnapshot = () => putRecord(rows, abyssal(3, { lifecycleState: "completed" }));
    const r2 = p.v.career.reconcile(1);
    assert.strictEqual(r2.instancesByID["3"].lifecycleState, "completed", "after the retry our read is fresh");
    snap = p.career.statsSnapshot();
    assert.deepStrictEqual([snap.served, snap.parityChecks, snap.parityRetries, snap.disabledReason], [2, 2, 1, null]);
    assert.deepStrictEqual(p.out.lines, []);
    p.v.tamper = (obj) => { obj.instancesByID["3"].lifecycleState = "tampered"; };
    const r3 = p.v.career.reconcile(1);
    assert.strictEqual(r3, p.v.lastLoaded, "vendor result");
    assert.strictEqual(p.career.status().disabledReason, "parity");
    assert.deepStrictEqual(p.out.lines, ["WARN careerAbyssalRead disabled: parity (instance=3)"]);
    assert.strictEqual(p.career.statsSnapshot().parityRetries, 2);
  });

  test("A6 vendor facts 261108.1: upstream itself reads only abyssal (readPersistedAbyssalInstances) → careerAbyssalRead disabled:obsolete", () => {
    const norm = (rel) => src(rel).replace(/\r\n/g, "\n");
    const careerSrc = norm("services/career/careerAbyssalSources.js");
    assert.ok(careerSrc.includes("function readRuns(characterID = 0) {\n  const result = database.readPersistedAbyssalInstances(characterID);"));
    assert.ok(careerSrc.includes('database.readDurable("dungeonRuntimeState", `/instancesByID/${positive(instanceID)}`);'), "reconcileRun: one entry");
    assert.ok(/\nfunction readDurable\(table, pth\) \{[\s\S]*?\n {2}if \(!rows\) return readPersisted\(table, pth\);/.test(norm("gameStore/index.js")), "readDurable falls back to readPersisted");
    assert.ok(careerSrc.includes("for (const instance of Object.values(readRuns(characterID))) {"), "reconcile");
    assert.ok(!careerSrc.includes('readPersisted("dungeonRuntimeState", "/")'), "no read of the whole table");
    const index = norm("gameStore/index.js");
    assert.ok(index.includes("data: sqliteStore.loadExistingAbyssalInstances(characterID) };"));
    assert.ok(/^module\.exports = \{[\s\S]*?\n {2}readPersistedAbyssalInstances,/m.test(index));
    const store = norm("gameStore/sqliteStore.js");
    assert.ok(/^module\.exports = \{[\s\S]*?\n {2}loadExistingAbyssalInstances,/m.test(store));
    assert.ok(store.includes('if (instance?.siteFamily !== "abyssal" || instance?.siteKind !== "abyssal-pocket") continue;'), "same predicate as runFrom");
    const readers = [];
    for (const file of listJs(SERVER_SRC)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes('readPersisted("dungeonRuntimeState", "/")')) readers.push(path.relative(SERVER_SRC, file).replace(/\\/g, "/"));
    }
    assert.deepStrictEqual(readers, [], "nobody reads the whole dungeonRuntimeState table");

    const out = capture();
    const v = fakeVendor(new Map());
    v.sqliteStore.loadExistingAbyssalInstances = function loadExistingAbyssalInstances() { return {}; };
    v.gameStore.readPersistedAbyssalInstances = function readPersistedAbyssalInstances() { return { success: true, data: {} }; };
    const origRead = v.gameStore.readPersisted;
    const origLoad = v.sqliteStore.loadExistingTableObject;
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const st = createState({ ...careerConfig, ...quiet, prewarmLocations: false }, createRecorder({ slowCallMs: 1e9 }, () => {}),
      { log: out.log, openRowSource: () => assert.fail("open") });
    patchTarget("sqliteStore", v.sqliteStore, st, SQLITE_FILE);
    patchTarget("gameStore", v.gameStore, st, "/app/server/src/gameStore/index.js");
    patchTarget("careerAbyssal", v.career, st, "/app/server/src/services/career/careerAbyssalSources.js");
    assert.strictEqual(st.career.status().disabledReason, "obsolete");
    assert.deepStrictEqual(out.lines, ["WARN careerAbyssalRead disabled: obsolete (EveJS reads it itself: sqliteStore.loadExistingAbyssalInstances)"]);
    assert.strictEqual(v.gameStore.readPersisted, origRead);
    assert.strictEqual(v.sqliteStore.loadExistingTableObject, origLoad);
    st.gameSeen = true;
    const msg = probeMessage(st);
    assert.ok(!msg.includes("DRIFT") && msg.endsWith("; careerAbyssalRead disabled: obsolete"), msg);
    const g = createState(careerConfig, createRecorder({ slowCallMs: 1e9 }, () => {}), { log: () => {} });
    patchTarget("gameStore", { ...fakeVendor(new Map()).gameStore, readPersistedAbyssalInstances() {} }, g);
    assert.strictEqual(g.career.status().disabledReason, "obsolete");
  });

  test("A7 real SQLite (conditional): classify instr/json_extract, IN json_each, snapshot sees the commit, COVERING INDEX", () => {
    const storeFile = path.join(SERVER_SRC, "gameStore", "sqliteStore.js");
    let Database;
    try {
      Database = Module.createRequire(storeFile)("better-sqlite3");
      new Database(":memory:").close();
    } catch (error) {
      console.log(`SKIP A7: better-sqlite3 unavailable (${error && error.message || error})`);
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath05-"));
    const dbPath = path.join(dir, "evejs.sqlite");
    const writer = new Database(dbPath);
    let rs = null;
    try {
      writer.pragma("journal_mode = WAL");
      writer.exec(`CREATE TABLE IF NOT EXISTS "${T}" (key TEXT PRIMARY KEY, json TEXT NOT NULL)`);
      const upsert = writer.prepare(`INSERT INTO "${T}" (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json`);
      const rows = table([abyssal(3), plain(4), plain(12, { metadata: { note: "abyssal-pocket" } }),
        plain(15, { siteFamily: "abyssal", siteKind: "abyssal-trace" })]);
      writer.transaction(() => { for (const [k, json] of rows) upsert.run(k, json); })();
      rs = openRowSource({ sqliteStoreFilename: storeFile, dbPath, busyTimeoutMs: 100 });
      const first = rs.readSnapshot((tx) => {
        const keys = tx.listKeys();
        const entity = keys.filter((k) => k.includes(SEP));
        return { exists: tx.tableExists(), keys, classes: tx.classify(entity), read: tx.readRows([`instancesByID${SEP}3`, "nextInstanceSequence", "missing"]) };
      });
      assert.strictEqual(first.exists, true);
      assert.deepStrictEqual([...first.keys].sort(), [...rows.keys()].sort());
      const classes = Object.fromEntries(first.classes.map((r) => [r.key.split(SEP)[1], r.abyssal]));
      assert.deepStrictEqual(classes, { 3: 1, 4: 0, 12: 0, 15: 0 });
      assert.deepStrictEqual(first.read.map((r) => r.key).sort(), [`instancesByID${SEP}3`, "nextInstanceSequence"]);
      assert.deepStrictEqual(JSON.parse(first.read.find((r) => r.key.includes(SEP)).json), abyssal(3));
      assert.throws(() => rs.readSnapshot((tx) => { throw new Error("inner"); }), /inner/);
      upsert.run(`instancesByID${SEP}30`, JSON.stringify(abyssal(30)));
      const second = rs.readSnapshot((tx) => tx.classify([`instancesByID${SEP}30`]));
      assert.deepStrictEqual(second, [{ key: `instancesByID${SEP}30`, abyssal: 1 }]);
      const v = fakeVendor(new Map());
      const c = createCareerAbyssalRead({ config: careerConfig, log: () => assert.fail("log"), openRowSource: () => rs });
      assert.strictEqual(c.setDeps(v.sqliteStore, storeFile), true);
      const value = c.readSubset().value;
      assert.deepStrictEqual(Object.keys(value.instancesByID).sort(), ["3", "30"]);
      assert.strictEqual(value.nextInstanceSequence, 100);
      const plan = rs.explainListKeys().map((r) => r.detail).join(" | ");
      assert.ok(/COVERING INDEX sqlite_autoindex_dungeonRuntimeState_1/.test(plan), plan);
      let leaked = null;
      rs.readSnapshot((tx) => { leaked = tx; });
      assert.throws(() => leaked.listKeys(), /outside readSnapshot/);
    } finally {
      if (rs) rs.close();
      writer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const templateConfig = Object.freeze({ ...config, templateReadOnlyView: true });

  function fakeAuthority() {
    const records = new Map([["t1", { templateID: "t1", sourceDungeonID: 5, archetypeID: 7, factionID: 500001, rooms: { a: { x: 1 } } }]]);
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const views = new WeakMap();
    const freezeDeep = (value) => {
      if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const c of Object.values(value)) freezeDeep(c); }
      return value;
    };
    const a = { tamper: false, clones: 0 };
    a.exports = {
      getTemplateByID: function getTemplateByID(id) {
        const t = records.get(String(id || "").trim());
        a.clones += 1;
        return t ? clone(t) : null;
      },
      getTemplateByIDReadOnly: function getTemplateByIDReadOnly(id) {
        const r = records.get(String(id || "").trim());
        if (!r) return null;
        if (!views.has(r)) views.set(r, freezeDeep(clone(r)));
        return a.tamper ? { ...views.get(r), archetypeID: -1 } : views.get(r);
      },
    };
    return a;
  }

  function callers(authorityExports) {
    const code = "(function (authority) {\n" +
      "  function hydrateSummary(id) { return authority.getTemplateByID(id); }\n" +
      "  function buildOther(id) { return authority.getTemplateByID(id); }\n" +
      "  return { hydrateSummary, buildOther };\n})";
    const mgr = vm.runInThisContext(code, { filename: "/app/server/src/services/dungeon/dungeonInstanceCacheMgrService.js" })(authorityExports);
    const elsewhere = vm.runInThisContext(code, { filename: "/app/server/src/services/dungeon/dungeonUniverseRuntime.js" })(authorityExports);
    return { mgr, elsewhere };
  }

  function templateSetup(cfg = {}) {
    const out = capture();
    const a = fakeAuthority();
    const st = createState({ ...templateConfig, ...cfg }, createRecorder({ slowCallMs: 1e9 }, () => {}), { log: out.log });
    let body = () => null;
    class CacheMgr { Handle_GetOreAnomalyInstances() { return body(); } }
    patchTarget("dungeonAuthority", a.exports, st);
    patchTarget("cacheMgr", CacheMgr, st);
    const inScope = (fn) => { body = fn; try { return new CacheMgr().Handle_GetOreAnomalyInstances(); } finally { body = () => null; } };
    return { out, a, st, template: st.template, inScope, ...callers(a.exports) };
  }

  const deepFrozen = (value) => !value || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

  test("T1 templates: hydrateSummary inside the scope = frozen view; others / outside the scope = clone; Error restored; parity", () => {
    const s = templateSetup();
    assert.ok(s.st.patched.has("dungeonAuthority.getTemplateByID#readOnly") && s.st.patched.has("dungeonAuthority#deps"));
    assert.ok(s.st.patched.has("DungeonInstanceCacheMgrService.Handle_GetOreAnomalyInstances#templateScope"));
    const clone = s.a.exports.getTemplateByID.__hotPathPerfTemplate("t1");
    const savedPrepare = Error.prepareStackTrace;
    const savedLimit = Error.stackTraceLimit;
    const sentinel = (e, cs) => `sentinel:${cs.length}`;
    Error.prepareStackTrace = sentinel;
    let view;
    let view2;
    try {
      view = s.inScope(() => s.mgr.hydrateSummary("t1"));
      view2 = s.inScope(() => s.mgr.hydrateSummary("t1"));
      assert.strictEqual(Error.prepareStackTrace, sentinel, "prepareStackTrace restored");
      assert.strictEqual(Error.stackTraceLimit, savedLimit, "stackTraceLimit restored");
    } finally {
      Error.prepareStackTrace = savedPrepare;
    }
    assert.ok(deepFrozen(view), "view deeply frozen");
    assert.strictEqual(view, view2, "memo per vendor record");
    assert.strictEqual(JSON.stringify(view), JSON.stringify(clone));
    for (const r of [s.inScope(() => s.mgr.buildOther("t1")), s.inScope(() => s.elsewhere.hydrateSummary("t1")), s.mgr.hydrateSummary("t1")]) {
      assert.ok(!Object.isFrozen(r), "clone");
      assert.strictEqual(JSON.stringify(r), JSON.stringify(clone));
    }
    assert.strictEqual(s.inScope(() => s.mgr.hydrateSummary("missing")), null);
    const snap = s.template.statsSnapshot();
    assert.deepStrictEqual([snap.served, snap.passthrough, snap.depth], [3, 2, 0]);
    assert.ok(/^stats templateReadOnly state=ready served=3 passthrough=2 checkMaxUs=[\d.]+ parityChecks=0$/.test(s.template.drainStatsLines()[0]));
    const e = templateSetup();
    const savedCapture = Error.captureStackTrace;
    let r;
    try {
      Error.captureStackTrace = () => { throw new Error("capture boom"); };
      r = e.inScope(() => e.mgr.hydrateSummary("t1"));
    } finally {
      Error.captureStackTrace = savedCapture;
    }
    assert.strictEqual(Error.prepareStackTrace, savedPrepare);
    assert.strictEqual(Error.stackTraceLimit, savedLimit);
    assert.ok(!Object.isFrozen(r));
    assert.strictEqual(e.template.status().disabledReason, "error");
    assert.deepStrictEqual(e.out.lines, ["WARN templateReadOnly disabled: error (capture boom)"]);
    const p = templateSetup({ templateReadOnlyViewParityCheck: true });
    assert.ok(Object.isFrozen(p.inScope(() => p.mgr.hydrateSummary("t1"))));
    p.a.tamper = true;
    const bad = p.inScope(() => p.mgr.hydrateSummary("t1"));
    assert.ok(!Object.isFrozen(bad) && bad.archetypeID === 7);
    assert.strictEqual(p.template.status().disabledReason, "parity");
    assert.deepStrictEqual(p.out.lines, ["WARN templateReadOnly disabled: parity (templateID=t1)"]);
    const off = createState(config, createRecorder(config, () => {}));
    const a2 = fakeAuthority();
    const fn = a2.exports.getTemplateByID;
    patchTarget("dungeonAuthority", a2.exports, off);
    assert.strictEqual(a2.exports.getTemplateByID, fn);
    assert.strictEqual(config.templateReadOnlyView, false);
    const drift = createState(templateConfig, createRecorder(config, () => {}), { log: () => {} });
    drift.gameSeen = true;
    assert.strictEqual(loader.checkTemplateDrift(drift), true);
    assert.ok(probeMessage(drift).endsWith("; templateReadOnly disabled: drift"));
  });

  test("T2 vendor facts 261115.2: readOnlyView = freezeDeep(clone), getTemplateByID clones, hydrateSummary reads the view itself = obsolete", () => {
    const norm = (rel) => src(rel).replace(/\r\n/g, "\n");
    const auth = norm("services/dungeon/dungeonAuthority.js");
    assert.ok(auth.includes('const { cloneValue: walkCloneValue } = require("../../common/clone");'));
    assert.ok(auth.includes("function clone(value) {\n  return value === undefined ? JSON.parse(JSON.stringify(value)) : walkCloneValue(value);\n}"));
    assert.ok(auth.includes("if (!readOnlyViews.has(record)) readOnlyViews.set(record, freezeDeep(clone(record)));"));
    assert.ok(/^function getTemplateByID\(templateID\) \{\n  if \(isBannedDungeonTemplateID\(templateID\)\) \{\n    return null;\n  \}\n  const template = ensureCache\(\)\.templatesByID\.get\(String\(templateID \|\| ""\)\.trim\(\)\);\n  return template \? clone\(template\) : null;\n\}/m.test(auth));
    assert.ok(auth.includes('function getTemplateByIDReadOnly(templateID) {\n  if (isBannedDungeonTemplateID(templateID)) return null;\n  return readOnlyView(ensureCache().templatesByID.get(String(templateID || "").trim()));\n}'));
    for (const name of ["getTemplateByID", "getTemplateByIDReadOnly"]) assert.ok(new RegExp(`^module\\.exports = \\{[\\s\\S]*?\\n  ${name},`, "m").test(auth), name);
    const mgr = norm("services/dungeon/dungeonInstanceCacheMgrService.js");
    assert.ok(mgr.includes('const dungeonAuthority = require(path.join(__dirname, "./dungeonAuthority"));'));
    const start = mgr.indexOf("function hydrateSummary(summary) {");
    assert.ok(start >= 0);
    const end = mgr.indexOf("\n}\n", start);
    const body = mgr.slice(start, end);
    assert.strictEqual((mgr.match(/getTemplateByID\(/g) || []).length, 0, "zero getTemplateByID (clone) in the cache mgr");
    assert.strictEqual((mgr.match(/getTemplateByIDReadOnly\(/g) || []).length, 1);
    assert.ok(body.includes("const template = dungeonAuthority.getTemplateByIDReadOnly("), "view in hydrateSummary");
    const { hydrateFixedUpstream } = require("../lib/templateReadOnly");
    assert.strictEqual(hydrateFixedUpstream(mgr), true);
    assert.strictEqual(hydrateFixedUpstream(mgr.replace("dungeonAuthority.getTemplateByIDReadOnly(", "dungeonAuthority.getTemplateByID(")), false);
    const lines = [];
    const st = createState({ ...templateConfig }, createRecorder({ slowCallMs: 1e9 }, () => {}), { log: (l) => lines.push(l) });
    const { CACHE_MGR_HANDLERS } = loader;
    const handlers = Object.fromEntries(CACHE_MGR_HANDLERS.map((m) => [m, function () { return m; }]));
    class RealMgr {}
    Object.assign(RealMgr.prototype, handlers);
    patchTarget("cacheMgr", RealMgr, st, path.join(SERVER_SRC, "services/dungeon/dungeonInstanceCacheMgrService.js"));
    for (const m of CACHE_MGR_HANDLERS) {
      assert.strictEqual(RealMgr.prototype[m].__hotPathPerfTemplate, undefined, `${m} without a template scope`);
      assert.ok(st.patched.has(`DungeonInstanceCacheMgrService.${m}#templateScope`), m);
    }
    assert.strictEqual(st.template.status().hydrate, "obsolete");
    assert.strictEqual(st.template.status().disabledReason, null);
    assert.strictEqual(lines.filter((l) => l.includes("templateReadOnly hydrate disabled: obsolete")).length, 1, lines.join("|"));
    const uses = [...body.matchAll(/\btemplate\b(\s*\.\s*\w+|\s*\[)?/g)].map((m) => m[0]);
    const fields = new Set();
    for (const use of uses) {
      if (use === "template") continue;
      assert.ok(/^template\.\w+$/.test(use.replace(/\s/g, "")), use);
      fields.add(use.replace(/\s/g, ""));
    }
    assert.deepStrictEqual([...fields].sort(), ["template.archetypeID", "template.difficulty", "template.dungeonNameID",
      "template.entryObjectTypeID", "template.factionID", "template.sourceDungeonID"]);
    assert.strictEqual((body.match(/template\s*&&\s*template\./g) || []).length, 6, "read only as `template && template.<field>`");
    assert.ok(!/\btemplate(\.\w+|\[[^\]]+\])+\s*(=(?!=)|\+=|-=|\+\+|--)|delete template|Object\.assign\(\s*template\b/.test(body), "no writes");
    assert.ok(/^\s+const hydrated = hydrateSummary\(summary\);$/m.test(mgr));
  });
}

module.exports = { register, runFrom, assembleFromRows };
