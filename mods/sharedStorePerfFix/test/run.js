"use strict";

process.env.EVEJS_SSPF_NO_INSTALL = "1";

const assert = require("node:assert");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const gameStoreDir = path.join(runtimeRoot, "server", "src", "gameStore");
const schemaDir = path.join(gameStoreDir, "shared-schema");

const Database = Module.createRequire(path.join(gameStoreDir, "sqliteStore.js"))("better-sqlite3");
const { APPLICATION_ID, TYPED_TABLES } = require(path.join(schemaDir, "version.js"));
const { installRuntimeTable } = require(path.join(schemaDir, "install.js"));
const { structuresSchema } = require(path.join(schemaDir, "structureSchema.js"));

const config = require("../config");
const loader = require("../loader");
const cli = require("../tools/plannerPin");
const { STRUCTURES_TARGET, applyPlannerPin, pinStatOf, readStat, writeStat } = require("../lib/plannerPin");
const { probeTriggerPlan, resolveTarget } = require("../lib/triggerProbe");
const mirrorSkip = require("../lib/mirrorSkip");

const results = [];
let failed = 0;

function test(name, operation) {
  try {
    operation();
    results.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}

const RECORD_COUNT = 200;
const PIN_ROWS = 100000;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sspf-test-"));

function buildImage() {
  const db = new Database(":memory:");
  for (const table of ["killmails", "items", "structures"]) installRuntimeTable(db, table, TYPED_TABLES.get(table));
  db.pragma(`application_id = ${APPLICATION_ID}`);
  const image = db.serialize();
  db.close();
  return image;
}

const image = buildImage();

function cloneDb() {
  const db = new Database(image);
  db.pragma("foreign_keys = ON");
  return db;
}

function fileDb(name) {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, image);
  return file;
}

function structure(index) {
  return {
    structureID: 1000000000000 + index,
    typeID: index % 10 === 0 ? 35832 : 32458,
    solarSystemID: 30000000 + index,
    ownerCorpID: 98000002 + (index % 23),
    name: `Hub ${index}`,
    state: 1,
    stateStartedAt: 1700000000000 + index,
    position: { x: index, y: 2 * index, z: 3 * index },
    rotation: [0, 0, 0],
    serviceStates: { 1: 1, 2: 0 },
    devFlags: {
      sovereigntyMirror: true,
      sovereigntyCaptured: true,
      sovereigntyGmAnchored: true,
      sovereigntyCaptureEpoch: `gm-capture:${30000000 + index}:${index}:1700000000000`,
      entosisCapture: { campaignID: index, startedAt: 1700000000000, progress: 0.5, attackers: [98000002, 98000003] },
    },
  };
}

const DOCUMENT = JSON.stringify(Array.from({ length: RECORD_COUNT }, (_, index) => structure(index)));

function writeStructures(db) {
  const started = process.hrtime.bigint();
  db.prepare("INSERT INTO \"structures\"(key, json) VALUES (?, jsonb(?))").run("structures", DOCUMENT);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ms, view: db.prepare("SELECT json FROM structures WHERE key = 'structures'").get().json };
}

function deps(extra = {}) {
  return { readOnly: false, pinRows: PIN_ROWS, applicationId: APPLICATION_ID, vendorSchemaSql: structuresSchema, cache: {}, ...extra };
}

function liveProbe(db) {
  const target = resolveTarget(db, STRUCTURES_TARGET);
  assert.strictEqual(target.ok, true, target.reason);
  return probeTriggerPlan(db, target);
}

function totalChanges(db) {
  return db.prepare("SELECT total_changes() AS c").get().c;
}

function crossJoined(sql) {
  return sql.replace(/(^|[^A-Z]) JOIN (structure_\w+) AS child ON/gu, (_match, before, table) => `${before} CROSS JOIN ${table} AS child ON`);
}

function statRows(db) {
  return db.prepare("SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx").all();
}

test("pin-happy-path: plan goes from bad to good, writes get faster, round trip is identical", () => {
  const vanilla = cloneDb();
  const pinned = cloneDb();
  assert.strictEqual(liveProbe(vanilla).reason, "BAD");
  const pinDeps = deps();
  const result = applyPlannerPin(pinned, pinDeps);
  assert.strictEqual(result.reason, "PINNED", JSON.stringify(result));
  assert.strictEqual(pinDeps.cache.vendorProbe.probe.reason, "BAD", JSON.stringify(pinDeps.cache.vendorProbe));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.indexName, "sqlite_autoindex_structure_records_2");
  assert.strictEqual(result.probe.bad, 0);
  assert.ok(result.probe.total >= 10, `probe statements ${result.probe.total}`);
  assert.strictEqual(liveProbe(pinned).reason, "GOOD");
  assert.deepStrictEqual(statRows(pinned), [{ tbl: "structure_records", idx: result.indexName, stat: pinStatOf(PIN_ROWS) }]);

  const fast = writeStructures(pinned);
  const slow = writeStructures(vanilla);
  console.log(`     ${RECORD_COUNT} structures: vanilla ${slow.ms.toFixed(0)} ms, pinned ${fast.ms.toFixed(0)} ms`);
  assert.ok(fast.ms * 5 <= slow.ms, `pinned ${fast.ms} ms vs vanilla ${slow.ms} ms`);
  assert.strictEqual(fast.view, slow.view);
  assert.strictEqual(JSON.parse(fast.view).length, RECORD_COUNT);
  assert.deepStrictEqual(pinned.pragma("foreign_key_check"), []);
  vanilla.close();
  pinned.close();
});

test("pin-idempotent: second apply and a fresh connection write nothing", () => {
  const file = fileDb("restart.sqlite");
  const first = new Database(file);
  assert.strictEqual(applyPlannerPin(first, deps()).reason, "PINNED");
  const before = totalChanges(first);
  const again = applyPlannerPin(first, deps());
  assert.strictEqual(again.reason, "ALREADY_PINNED");
  assert.strictEqual(totalChanges(first), before);

  const second = new Database(file);
  assert.strictEqual(liveProbe(second).reason, "GOOD");
  const reopened = applyPlannerPin(second, deps());
  assert.strictEqual(reopened.reason, "ALREADY_PINNED");
  assert.strictEqual(totalChanges(second), 0);
  first.close();
  second.close();
});

test("vendor-fixed: a generator with a good plan removes only the pinned row", () => {
  const fixedSql = crossJoined(structuresSchema());
  const db = cloneDb();
  const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(STRUCTURES_TARGET.trigger).sql;
  db.transaction(() => {
    db.exec(`DROP TRIGGER ${STRUCTURES_TARGET.trigger}`);
    db.exec(crossJoined(stored));
  })();
  const target = resolveTarget(db, STRUCTURES_TARGET);
  writeStat(db, "structure_records", target.indexName, pinStatOf(PIN_ROWS));
  db.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('structure_records', 'structure_records_by_system', '500 5 1')").run();
  const result = applyPlannerPin(db, deps({ vendorSchemaSql: () => fixedSql }));
  assert.strictEqual(result.reason, "VENDOR_FIXED", JSON.stringify(result));
  assert.strictEqual(result.removed, true);
  assert.strictEqual(readStat(db, "structure_records", target.indexName), null);
  assert.strictEqual(readStat(db, "structure_records", "structure_records_by_system"), "500 5 1");
  db.close();

  const oldTrigger = cloneDb();
  const kept = applyPlannerPin(oldTrigger, deps({ vendorSchemaSql: () => fixedSql }));
  assert.strictEqual(kept.reason, "PINNED", "a fixed generator does not help a database that still has the old trigger");
  oldTrigger.close();
});

test("drift-and-passive: missing trigger or index, read-only, foreign database, disabled", () => {
  const noTrigger = cloneDb();
  noTrigger.exec(`DROP TRIGGER ${STRUCTURES_TARGET.trigger}`);
  const before = totalChanges(noTrigger);
  const drift = applyPlannerPin(noTrigger, deps());
  assert.strictEqual(drift.reason, "DRIFT");
  assert.strictEqual(drift.detail, "NO_TRIGGER");
  assert.strictEqual(totalChanges(noTrigger), before);
  noTrigger.close();

  const noIndex = new Database(":memory:");
  noIndex.pragma(`application_id = ${APPLICATION_ID}`);
  noIndex.exec([
    "CREATE TABLE structures (key TEXT PRIMARY KEY, json BLOB)",
    "CREATE TABLE structure_records (row_id INTEGER PRIMARY KEY, parent_id INTEGER, ordinal INTEGER)",
    `CREATE TRIGGER ${STRUCTURES_TARGET.trigger} AFTER INSERT ON structures BEGIN SELECT 1; END`,
  ].join(";\n"));
  const noIndexResult = applyPlannerPin(noIndex, deps());
  assert.strictEqual(noIndexResult.reason, "DRIFT");
  assert.strictEqual(noIndexResult.detail, "NO_INDEX");
  assert.strictEqual(totalChanges(noIndex), 0);
  noIndex.close();

  const passive = cloneDb();
  assert.strictEqual(applyPlannerPin(passive, deps({ readOnly: true })).reason, "READ_ONLY");
  assert.strictEqual(applyPlannerPin(passive, deps({ enabled: false })).reason, "DISABLED");
  assert.strictEqual(applyPlannerPin(passive, deps({ applicationId: APPLICATION_ID + 1 })).reason, "NOT_SHARED");
  assert.strictEqual(totalChanges(passive), 0);
  passive.close();
});

function readVendor(relative) {
  return fs.readFileSync(path.join(runtimeRoot, "server", ...relative.split("/")), "utf8").replace(/\r\n/gu, "\n");
}

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("vendor-facts: init seam, callers, startup check and generator shape", () => {
  const store = readVendor("src/gameStore/sqliteStore.js");
  const initStart = store.indexOf("function init(");
  assert.ok(initStart >= 0, "sqliteStore.js function init(");
  const initBody = store.slice(initStart, store.indexOf("\n}\n", initStart));
  assert.ok(initBody.includes("return db;"), "init returns db");
  const exportsBlock = store.slice(store.lastIndexOf("module.exports"));
  assert.ok(/\n {2}init,\n/u.test(exportsBlock), "init is exported by property");

  assert.ok(readVendor("src/gameStore/index.js").includes("sqliteStore.init("));
  assert.ok(readVendor("src/gameStore/persistenceWorker.worker.js").includes("sqliteStore.init("));
  assert.ok(readVendor("src/gameStore/persistenceWorker.js").includes("journal.init("));
  const destructuring = listJs(gameStoreDir).filter((file) => /\{[ \t]*init\b/u.test(fs.readFileSync(file, "utf8")));
  assert.deepStrictEqual(destructuring, [], "nobody destructures init");

  const startup = readVendor("src/gameStore/startupSharedStore.js");
  const assertStart = startup.indexOf("function assertSharedStore(");
  assert.ok(assertStart >= 0, "assertSharedStore exists");
  const assertBody = startup.slice(assertStart, startup.indexOf("\n}\n", assertStart)).toLowerCase();
  for (const word of ["sqlite_stat", "trigger", "index"]) assert.ok(!assertBody.includes(word), `assertSharedStore mentions ${word}`);

  assert.ok(readVendor("src/gameStore/shared-schema/nestedRecordSql.js").includes("JOIN ${node.table} AS child ON"),
    "nested record generator still emits a plain child JOIN; check whether the pin is still needed");
});

test("loader-wrap: init result and arguments pass through, failures stay inside, no double wrap", () => {
  const calls = [];
  const fakeDb = { prepare() {}, pragma(text) { calls.push(["pragma", text]); } };
  const exportsObject = {
    init(target, options) {
      calls.push(["init", this, target, options]);
      return fakeDb;
    },
  };
  const seen = [];
  const errors = [];
  const runtime = loader._testing.createRuntime({
    config: { enabled: true, pinRows: PIN_ROWS, busyTimeoutMs: 15000 },
    vendorFacts: { ok: true, applicationId: APPLICATION_ID, vendorSchemaSql: structuresSchema, vendorVersion: "test" },
    applyPin: (db, pinDeps) => {
      seen.push(pinDeps.readOnly);
      if (seen.length === 2) throw new Error("boom");
      return { ok: true, reason: "BUSY", ms: 0 };
    },
    logFn: () => {},
    warnFn: () => {},
    logErrorFn: (message) => errors.push(message),
  });
  assert.deepStrictEqual(runtime.wrapInit(exportsObject), { ok: true });
  const wrapped = exportsObject.init;
  assert.strictEqual(wrapped[loader.WRAPPED], true);
  assert.strictEqual(exportsObject.init("a.sqlite", { readOnly: false }), fakeDb);
  assert.strictEqual(exportsObject.init("a.sqlite"), fakeDb);
  assert.strictEqual(calls[0][1], exportsObject);
  assert.strictEqual(calls[0][2], "a.sqlite");
  assert.deepStrictEqual(calls.filter((call) => call[0] === "pragma").map((call) => call[1]), ["busy_timeout = 15000", "busy_timeout = 15000"]);
  assert.deepStrictEqual(seen, [false, false]);
  assert.strictEqual(runtime.stats.errors, 1);
  assert.strictEqual(errors.length, 1);

  const other = loader._testing.createRuntime({ config: { enabled: true, pinRows: PIN_ROWS, busyTimeoutMs: 0 }, logFn: () => {} });
  other.wrapInit(exportsObject);
  assert.strictEqual(exportsObject.init, wrapped);

  const broken = loader._testing.createRuntime({
    config: { enabled: true, pinRows: PIN_ROWS, busyTimeoutMs: 0 },
    logErrorFn: (message) => errors.push(message),
  });
  assert.deepStrictEqual(broken.wrapInit({ open() {} }), { ok: false, reason: "drift" });
  assert.strictEqual(broken.state.inert, true);
});

test("config: defaults, environment wins, invalid values and disabled switch", () => {
  const missing = { settingsPath: path.join(tmpRoot, "none.json"), envFilePath: path.join(tmpRoot, "none.env") };
  const defaults = config.load(modDir, {}, missing);
  assert.deepStrictEqual({ ...defaults, problems: [...defaults.problems] },
    { enabled: true, pinRows: 100000, busyTimeoutMs: 0, mirrorSkip: true, problems: [] });
  assert.strictEqual(config.load(modDir, { EVEJS_SSPF_MIRROR_SKIP: "0" }, missing).mirrorSkip, false);
  const custom = config.load(modDir, { EVEJS_SSPF_PIN_ROWS: "50000", EVEJS_SSPF_BUSY_TIMEOUT_MS: "15000" }, missing);
  assert.strictEqual(custom.pinRows, 50000);
  assert.strictEqual(custom.busyTimeoutMs, 15000);
  const invalid = config.load(modDir, { EVEJS_SSPF_PIN_ROWS: "10", EVEJS_SSPF_ENABLED: "maybe" }, missing);
  assert.strictEqual(invalid.problems.length, 2);

  const off = loader.install({ environment: { EVEJS_SSPF_ENABLED: "0" }, configOptions: missing, logFn: () => {} });
  assert.strictEqual(off.active, false);
  assert.strictEqual(off.reason, "disabled");
});

test("cli: status reports would pin, apply pins, remove deletes the row", () => {
  const file = fileDb("cli.sqlite");
  const lines = [];
  const print = (line) => lines.push(line);
  assert.strictEqual(cli.main(["--status", file], print), 0, lines.join("\n"));
  assert.ok(lines.includes("verdict: would pin"), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("plan now: BAD")), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("plan of vendor generator with the pin: GOOD")), lines.join("\n"));
  lines.length = 0;
  assert.strictEqual(cli.main(["--apply", file], print), 0, lines.join("\n"));
  assert.ok(lines[0].startsWith("apply: PINNED index=sqlite_autoindex_structure_records_2"), lines.join("\n"));
  lines.length = 0;
  assert.strictEqual(cli.main(["--remove", file], print), 0, lines.join("\n"));
  assert.strictEqual(lines[0], "remove: REMOVED index=sqlite_autoindex_structure_records_2");
  assert.strictEqual(cli.main(["--status"], () => {}), 2);
});

function fakeNormalize(entry) {
  const position = entry.position && typeof entry.position === "object" ? entry.position : {};
  return {
    structureID: Math.trunc(Number(entry.structureID)) || 0,
    typeID: Math.trunc(Number(entry.typeID)) || 0,
    ownerCorpID: Math.trunc(Number(entry.ownerCorpID || entry.ownerID)) || 1,
    state: Number.isFinite(Number(entry.state)) ? Math.trunc(Number(entry.state)) : 0,
    stateStartedAt: Number.isFinite(Number(entry.stateStartedAt)) ? Math.trunc(Number(entry.stateStartedAt)) : null,
    position: { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 },
    jumpBridgeCapacitor: entry.jumpBridgeCapacitor || null,
    devFlags: entry.devFlags && typeof entry.devFlags === "object" ? structuredClone(entry.devFlags) : {},
  };
}

const MIRROR_ID = 1000000000777;

function storedMirror(extra = {}) {
  return fakeNormalize({
    structureID: MIRROR_ID,
    typeID: 32458,
    ownerCorpID: 98000002,
    state: 1,
    stateStartedAt: 1700000000000,
    position: { x: 1.5, y: 2, z: 3 },
    devFlags: { sovereigntyKind: "ihub", entosisCapture: null, sovereigntyMirror: true },
    ...extra,
  });
}

function mirrorUpdate(stored, overrides = {}) {
  return {
    ...stored,
    groupID: 1416,
    categoryID: 65,
    stateStartedAt: 1800000000000,
    devFlags: { sovereigntyMirror: true, entosisCapture: null, sovereigntyKind: "ihub" },
    ...overrides,
  };
}

function fakeStructureState(rows, receipts = {}) {
  const byID = new Map(rows.map((row) => [row.structureID, row]));
  const writes = [];
  const exportsObject = {
    upsertStructureRecord(record, options) {
      writes.push({ self: this, record, options });
      const next = fakeNormalize(record);
      byID.set(next.structureID, next);
      return { success: true, data: next };
    },
    getStructureByID(structureID, options) {
      assert.strictEqual(options && options.refresh, false);
      return byID.get(structureID) || null;
    },
    getStructureSelfDestructRecord: (structureID) => receipts[structureID] || null,
    _testing: { normalizeStructureRecord: fakeNormalize },
  };
  return { exportsObject, writes, byID };
}

function fakeVendor(rows, receipts) {
  const { exportsObject } = fakeStructureState(rows, receipts);
  return {
    normalize: exportsObject._testing.normalizeStructureRecord,
    getExisting: (structureID) => exportsObject.getStructureByID(structureID, { refresh: false }),
    selfDestructReceipt: exportsObject.getStructureSelfDestructRecord,
  };
}

test("mirror-plan: unchanged mirror skips, changes write with the old state start, others pass", () => {
  const stored = storedMirror();
  const vendor = fakeVendor([stored]);

  const unchanged = mirrorSkip.planMirrorUpsert(mirrorUpdate(stored), {}, vendor);
  assert.strictEqual(unchanged.action, "skip");
  assert.strictEqual(unchanged.record.stateStartedAt, 1700000000000);
  assert.ok(mirrorSkip.sameValue(unchanged.data, stored));
  assert.notStrictEqual(unchanged.data, stored);

  const moved = mirrorSkip.planMirrorUpsert(mirrorUpdate(stored, { position: { x: 9, y: 2, z: 3 } }), {}, vendor);
  assert.strictEqual(moved.action, "write");
  assert.strictEqual(moved.record.stateStartedAt, 1700000000000);
  for (const overrides of [
    { ownerCorpID: 98000003 },
    { devFlags: { sovereigntyMirror: true, entosisCapture: { campaignID: 5, progress: 0.5 }, sovereigntyKind: "ihub" } },
  ]) {
    assert.strictEqual(mirrorSkip.planMirrorUpsert(mirrorUpdate(stored, overrides), {}, vendor).action, "write");
  }

  const reinforced = mirrorUpdate(stored, { state: 2 });
  const stateChange = mirrorSkip.planMirrorUpsert(reinforced, {}, vendor);
  assert.deepStrictEqual([stateChange.action, stateChange.reason], ["pass", "stateChanged"]);
  assert.strictEqual(stateChange.record, reinforced);

  const plain = { structureID: MIRROR_ID, state: 1, devFlags: { sovereigntyMirror: "yes" } };
  assert.strictEqual(mirrorSkip.planMirrorUpsert(plain, {}, vendor).reason, "notMirror");
  assert.strictEqual(mirrorSkip.planMirrorUpsert(null, {}, vendor).reason, "notMirror");
  assert.strictEqual(mirrorSkip.planMirrorUpsert(mirrorUpdate(stored), { durable: true }, vendor).reason, "durable");
  assert.strictEqual(mirrorSkip.planMirrorUpsert(mirrorUpdate(stored, { structureID: 5 }), {}, vendor).reason, "new");
  assert.strictEqual(mirrorSkip.planMirrorUpsert(mirrorUpdate(stored, { structureID: 0 }), {}, vendor).reason, "noStructureID");

  const countdown = fakeVendor([stored], { [MIRROR_ID]: { state: "countdown" } });
  assert.strictEqual(mirrorSkip.planMirrorUpsert(mirrorUpdate(stored), {}, countdown).reason, "selfDestruct");
  const aborted = fakeVendor([stored], { [MIRROR_ID]: { state: "aborted" } });
  assert.strictEqual(mirrorSkip.planMirrorUpsert(mirrorUpdate(stored), {}, aborted).action, "skip");

  const bridge = storedMirror({ jumpBridgeCapacitor: { chargeGJ: 1, atMs: 2, etag: 0, receipts: [] } });
  const carried = mirrorSkip.planMirrorUpsert(mirrorUpdate(bridge, { jumpBridgeCapacitor: null }), {}, fakeVendor([bridge]));
  assert.strictEqual(carried.action, "skip");
  assert.notStrictEqual(carried.data.jumpBridgeCapacitor, bridge.jumpBridgeCapacitor);

  assert.ok(mirrorSkip.sameValue({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!mirrorSkip.sameValue({ a: null }, {}));
  assert.ok(!mirrorSkip.sameValue([1, 2], { 0: 1, 1: 2 }));
});

test("mirror-wrap: skip returns success without a write, other calls pass through, failures stay inside", () => {
  const stored = storedMirror();
  const { exportsObject, writes } = fakeStructureState([stored, fakeNormalize({ structureID: 42, state: 1 })]);
  const original = exportsObject.upsertStructureRecord;
  const errors = [];
  const mirror = mirrorSkip.createMirrorSkip({ logErrorFn: (message) => errors.push(message), publish: false });
  assert.deepStrictEqual(mirror.wrapExports(exportsObject), { ok: true });
  const wrapped = exportsObject.upsertStructureRecord;
  assert.notStrictEqual(wrapped, original);
  assert.strictEqual(wrapped[mirrorSkip.WRAPPED], true);

  const skipped = exportsObject.upsertStructureRecord(mirrorUpdate(stored), { emitLive: false });
  assert.strictEqual(skipped.success, true);
  assert.ok(mirrorSkip.sameValue(skipped.data, stored));
  assert.strictEqual(writes.length, 0);

  const plain = { structureID: 42, state: 1, stateStartedAt: 5 };
  const options = { emitLive: true };
  const passed = exportsObject.upsertStructureRecord(plain, options);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].self, exportsObject);
  assert.strictEqual(writes[0].record, plain);
  assert.strictEqual(writes[0].options, options);
  assert.deepStrictEqual(passed, { success: true, data: fakeNormalize(plain) });

  exportsObject.upsertStructureRecord(mirrorUpdate(stored, { position: { x: 7, y: 7, z: 7 } }), { emitLive: false });
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[1].record.stateStartedAt, 1700000000000);
  assert.deepStrictEqual(writes[1].options, { emitLive: false });

  exportsObject._testing.normalizeStructureRecord = () => {
    throw new Error("boom");
  };
  const fallback = mirrorUpdate(stored, { stateStartedAt: 3 });
  exportsObject.upsertStructureRecord(fallback, {});
  assert.strictEqual(writes[2].record, fallback);
  assert.deepStrictEqual({ ...mirror.stats }, { skipped: 1, written: 1, keptStartedAt: 1, errors: 1, drift: 0 });
  assert.strictEqual(errors.length, 1);

  const other = mirrorSkip.createMirrorSkip({ publish: false });
  assert.deepStrictEqual(other.wrapExports(exportsObject), { ok: true });
  assert.strictEqual(exportsObject.upsertStructureRecord, wrapped);

  const partial = mirrorSkip.createMirrorSkip({ publish: false });
  assert.deepStrictEqual(partial.wrapExports({}), { ok: false, reason: "pending" });
  assert.strictEqual(partial.state.inert, false);
  const drifted = mirrorSkip.createMirrorSkip({ logErrorFn: (message) => errors.push(message), publish: false });
  const noTesting = { ...fakeStructureState([]).exportsObject, _testing: {} };
  assert.deepStrictEqual(drifted.wrapExports(noTesting), { ok: false, reason: "drift" });
  assert.strictEqual(drifted.state.inert, true);
  assert.ok(errors[1].startsWith("DRIFT structureState._testing.normalizeStructureRecord"), errors[1]);
});

test("mirror-hook: loader wraps the structure state module on load and publishes the counter", () => {
  const root = path.join(tmpRoot, "runtime");
  const storeFile = path.join(root, "server", "src", "gameStore", "sqliteStore.js");
  const stateFile = path.join(root, "server", "src", "services", "structure", "structureState.js");
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(storeFile, "\"use strict\";\nmodule.exports = { init() { return null; } };\n");
  fs.writeFileSync(stateFile, [
    "\"use strict\";",
    "Object.assign(module.exports, {",
    "  upsertStructureRecord: (record) => ({ success: true, data: record }),",
    "  getStructureByID: () => null,",
    "  getStructureSelfDestructRecord: () => null,",
    "  _testing: { normalizeStructureRecord: (record) => ({ ...record }) },",
    "});",
    "",
  ].join("\n"));
  const runtime = loader._testing.createRuntime({
    runtimeRoot: root,
    config: { enabled: true, pinRows: PIN_ROWS, busyTimeoutMs: 0 },
    vendorFacts: { ok: true, applicationId: APPLICATION_ID, vendorSchemaSql: structuresSchema, vendorVersion: "test" },
    logFn: () => {},
  });
  const mirror = mirrorSkip.createMirrorSkip();
  assert.strictEqual(globalThis[Symbol.for(mirrorSkip.STATS_SYMBOL)], mirror.stats);
  const hookState = loader._testing.installModuleHook(runtime, root, () => {}, mirror);
  try {
    const state = require(stateFile);
    assert.strictEqual(mirror.state.wrapped, true);
    assert.strictEqual(state.upsertStructureRecord[mirrorSkip.WRAPPED], true);
    assert.strictEqual(runtime.state.wrapped, false);
    require(storeFile);
    assert.strictEqual(runtime.state.wrapped, true);
  } finally {
    Module._load = hookState.previousLoad;
    delete require.cache[stateFile];
    delete require.cache[storeFile];
    delete globalThis[Symbol.for(mirrorSkip.STATS_SYMBOL)];
  }
});

test("mirror-roundtrip: a mirror record reads back from the shared store unchanged", () => {
  const db = cloneDb();
  const record = {
    structureID: MIRROR_ID, typeID: 32458, name: "Infrastructure Hub", itemName: "Infrastructure Hub", description: "",
    ownerCorpID: 98000002, ownerID: 98000002, allianceID: null, moonID: null, moonMiningBinding: null,
    solarSystemID: 30000001, constellationID: 20000001, regionID: 10000001,
    position: { x: 1.5, y: -2.25, z: 123456789.123 }, rotation: [0, 0, 0], radius: 5000,
    structureFamily: "sovereignty", structureSize: "large", state: 1, stateStartedAt: 1700000000000, stateEndsAt: 0,
    deployStartedAt: null, deployEndsAt: null, timerPausedAt: null, upkeepState: 1, hasQuantumCore: false,
    quantumCoreItemTypeID: null, reinforceWeekday: 6, reinforceHour: 22, nextReinforceWeekday: null,
    nextReinforceHour: null, nextReinforceApply: null, profileID: 1, serviceStates: {}, fuelExpiresAt: 0,
    assetSafetyMode: "enabled", destroyedAt: 0, selfDestructAt: null, selfDestructGeneration: null, wars: [],
    unanchoring: null, abandonAt: null, abandonmentWarningAbandonAt: null, abandonmentWarningRecipients: [],
    lowFuelAlertAt: null, liquidOzoneQty: 0, jumpBridgeCapacitor: null, deliveryFuelReceipts: [],
    devFlags: {
      sovereigntyMirror: true, sovereigntyKind: "ihub", sovereigntyCaptured: true,
      entosisCapture: { campaignID: 5, startedAt: 1700000000000, progress: 0.5, attackers: [98000002] },
      campaignSourceInfo: [[1, 2], [3, 4]],
    },
    accessProfile: { docking: "none", tethering: "none" },
    conditionState: { damage: 0, charge: 1, armorDamage: 0, shieldCharge: 1, incapacitated: false },
    shieldCapacity: 1000, armorHP: 1000, hullHP: 1000, capacitorCapacity: 0, maxTargetRange: 0, maxLockedTargets: 0,
    tetheringRange: 3000, tetherRepairEffectMode: null, damageCap: 0, dockable: false, published: true,
  };
  const empty = { ...record, structureID: MIRROR_ID + 1, devFlags: { ...record.devFlags, entosisCapture: null, campaignSourceInfo: null } };
  try {
    db.prepare("INSERT INTO \"structures\"(key, json) VALUES (?, jsonb(?))").run("structures", JSON.stringify([record, empty]));
    const back = JSON.parse(db.prepare("SELECT json FROM structures WHERE key = 'structures'").get().json);
    assert.ok(mirrorSkip.sameValue(back[0], record));
    assert.ok(mirrorSkip.sameValue(back[1], empty));
  } finally {
    db.close();
  }
});

test("mirror-vendor-facts: wrapped seam, its caller and the stamped state start", () => {
  const state = readVendor("src/services/structure/structureState.js");
  const exportsBlock = state.slice(state.lastIndexOf("Object.assign(module.exports, {"));
  for (const name of ["upsertStructureRecord", "getStructureByID", "getStructureSelfDestructRecord", "normalizeStructureRecord"]) {
    assert.ok(new RegExp(`\\n {2,4}${name},\\n`, "u").test(exportsBlock), `structureState exports ${name}`);
  }
  const upsertStart = state.indexOf("function upsertStructureRecord(record, options = {}) {");
  assert.ok(upsertStart >= 0, "upsertStructureRecord signature");
  const upsertBody = state.slice(upsertStart, state.indexOf("\n}\n", upsertStart));
  assert.ok(upsertBody.includes("rows[index].jumpBridgeCapacitor"), "upsert carries the stored capacitor");

  const interop = readVendor("src/services/sovereignty/sovSpaceInterop.js");
  assert.ok(interop.includes("structureState.upsertStructureRecord(mirror, {"), "mirror sync calls upsert through the module");
  assert.ok(interop.includes("sovereigntyMirror: true,"), "mirror records carry the flag");
  assert.ok(interop.includes("stateStartedAt: nowMs,"),
    "buildMirrorRecord no longer stamps the current time; check whether the mirror skip is still needed");
  const destructuring = listJs(path.join(runtimeRoot, "server", "src"))
    .filter((file) => /\{[^}]*\bupsertStructureRecord\b[^}]*\}\s*=\s*require/u.test(fs.readFileSync(file, "utf8")));
  assert.deepStrictEqual(destructuring, [], "nobody destructures upsertStructureRecord");
});

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
} catch (_error) {
  // A locked temp file on Windows is left for the OS to clean.
}

console.log(`\n${results.length}/${results.length + failed} PASS`);
if (failed > 0) process.exitCode = 1;
