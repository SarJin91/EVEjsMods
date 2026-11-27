"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const {
  createBlueprintOwnerRead, INDUSTRY_FUNCTIONS, STARBASE_FUNCTIONS, FINGERPRINTS, fingerprintFunctions, fixedUpstream,
} = require("../lib/blueprintOwnerRead");

const MISSING = path.join(__dirname, "missing.json");

const VENDOR_BODIES = Object.freeze([
  "readTable", "readTableView", "readJobsView", "writeTable", "ensureBlueprintStateTable", "persistBlueprintStateTable",
  "ensureJobsTable", "isAncientRelicItem", "isIndustryBlueprintCategory", "getRelicBlueprintState",
  "getStoredBlueprintState", "getVerifiedInstalledBlueprintJob", "shouldHideUnprotectedInstalledBlueprint",
  "canViewBlueprintInstance", "getBlueprintState", "buildBlueprintInstance", "listBlueprintInstancesByOwner",
  "getBlueprintByItemID", "getJobByID", "getJobStatus",
]);

function currentFingerprints(sources) {
  return {
    industry: Object.fromEntries(fingerprintFunctions(sources.industrySource, INDUSTRY_FUNCTIONS)),
    starbase: Object.fromEntries(fingerprintFunctions(sources.starbaseSource, STARBASE_FUNCTIONS)),
  };
}

const STATION = 60003760;
const OTHER_STATION = 60008494;
const CONTAINER = 5001;
const CHAR_A = 90000001;
const CHAR_C = 90000002;
const CORP_B = 98000001;
const JOB_ID = 970000000000001;

function isObj(v) {
  return v !== null && typeof v === "object";
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function extractBodies(text, names) {
  const src = text.replace(/\r\n/g, "\n");
  return names.map((name) => {
    const start = new RegExp(`^function ${name}\\(`, "m").exec(src);
    assert.ok(start, `vendor: function ${name}`);
    const end = /\n\}(\n|$)/g;
    end.lastIndex = start.index;
    const hit = end.exec(src);
    return src.slice(start.index, hit.index + 2);
  }).join("\n\n");
}

function makeStore(tables) {
  const cache = clone(tables);
  const writes = [];
  const segmentsOf = (pth) => String(pth || "/").split("/").filter(Boolean);
  const exports = {
    read: function read(table, pth) {
      if (!(table in cache)) return { success: false, errorMsg: "TABLE_NOT_FOUND", data: null };
      let cur = cache[table];
      for (const s of segmentsOf(pth)) {
        if (!isObj(cur) || !(s in cur)) return { success: false, errorMsg: "ENTRY_NOT_FOUND", data: null };
        cur = cur[s];
      }
      return { success: true, errorMsg: null, data: cur };
    },
    write: function write(table, pth, data) {
      writes.push([table, String(pth)]);
      if (!(table in cache)) return { success: false, errorMsg: "TABLE_NOT_FOUND" };
      const segs = segmentsOf(pth);
      if (segs.length === 0) {
        cache[table] = data;
        return { success: true, errorMsg: null };
      }
      let cur = cache[table];
      for (let i = 0; i < segs.length - 1; i += 1) {
        if (!isObj(cur[segs[i]])) cur[segs[i]] = {};
        cur = cur[segs[i]];
      }
      cur[segs[segs.length - 1]] = data;
      return { success: true, errorMsg: null };
    },
  };
  return { cache, writes, exports };
}

function bpItem(itemID, ownerID, locationID, extra = {}) {
  return { itemID, typeID: 681, ownerID, locationID, flagID: 4, singleton: 1, categoryID: 9, quantity: -1, ...extra };
}

function fixture() {
  const items = [
    bpItem(1001, CHAR_A, STATION),
    bpItem(1002, CHAR_A, CONTAINER),
    bpItem(1003, CHAR_A, 2003),
    bpItem(1004, CHAR_A, STATION, { singleton: 0, quantity: -2 }),
    bpItem(1005, CHAR_A, STATION),
    bpItem(1006, CHAR_A, 2003),
    bpItem(2001, CORP_B, STATION, { flagID: 115 }),
    bpItem(3001, CHAR_C, OTHER_STATION),
    { itemID: 7001, typeID: 34, ownerID: CHAR_A, locationID: STATION, flagID: 4, singleton: 0, categoryID: 4 },
  ];
  const records = {};
  const rec = (itemID, extra = {}) => {
    records[String(itemID)] = { itemID, typeID: 681, materialEfficiency: 10, timeEfficiency: 20, original: true,
      runsRemaining: -1, jobID: null, updatedAt: 1, ...extra };
  };
  rec(1001);
  rec(1002, { materialEfficiency: 4 });
  rec(1003, { jobID: JOB_ID });
  rec(2001);
  rec(3001, { original: false, runsRemaining: 5 });
  for (let i = 0; i < 40; i += 1) rec(9000 + i);
  const jobs = {
    [String(JOB_ID)]: { jobID: JOB_ID, blueprintID: 1003, blueprintTypeID: 681, ownerID: CHAR_A, installedLocationID: 2003,
      status: 1, endDate: "2000", facilityID: STATION, blueprintLocationID: STATION, blueprintInventoryLocationID: STATION,
      blueprintLocationFlagID: 4, blueprintLocationTypeID: 1531 },
  };
  for (let i = 0; i < 20; i += 1) {
    jobs[String(JOB_ID + 100 + i)] = { jobID: JOB_ID + 100 + i, blueprintID: 9000 + i, ownerID: 1, status: 100 };
  }
  return {
    items,
    tables: {
      industryBlueprintState: { _meta: { version: 1, generatedAt: "g", lastUpdatedAt: "u" }, records },
      industryJobs: { _meta: { version: 1, nextJobID: JOB_ID + 1000, generatedAt: "g", lastUpdatedAt: "u" }, jobs },
      other: { x: 1 },
    },
  };
}

function vendorHarness(industryText) {
  const fx = fixture();
  const store = makeStore(fx.tables);
  const itemsByID = new Map(fx.items.map((it) => [it.itemID, it]));
  const counters = { bigClones: 0 };
  const locations = {
    [STATION]: { facilityID: STATION, typeID: 1531, facilityTypeID: 1531, solarSystemID: 30000142 },
    [CONTAINER]: { facilityID: STATION, typeID: 17366, facilityTypeID: 1531, solarSystemID: 30000142 },
    [OTHER_STATION]: { facilityID: OTHER_STATION, typeID: 1531, facilityTypeID: 1531, solarSystemID: 30002187 },
  };
  const host = {
    database: store.exports,
    cloneValue(value) {
      for (const g of ["records", "jobs"]) {
        if (isObj(value) && isObj(value[g]) && Object.keys(value[g]).length > 1) counters.bigClones += 1;
      }
      return JSON.parse(JSON.stringify(value));
    },
    findItemById: (id) => (itemsByID.has(Number(id)) ? clone(itemsByID.get(Number(id))) : null),
    listOwnedItems: (ownerID, options = {}) => fx.items
      .filter((it) => it.ownerID === Number(ownerID) && (options.categoryID == null || it.categoryID === options.categoryID))
      .map(clone),
    log: { warn() {}, info() {} },
    worldData: { getStationByID: () => null },
    structureState: { getStructureByID: () => null },
    starbaseIndustry: { getAssemblyProfile: () => null, getAssemblyArray: () => null, canAccessArray: () => true, getArrayContext: () => null },
    resolveLocationType: (locationID) => ({ ...(locations[Number(locationID)] || { facilityID: 0, typeID: 0, solarSystemID: 0 }) }),
    resolveIndustryLocationFlagID: (_loc, _owner, flagID) => Number(flagID) || 4,
    normalizeIndustryJobRecord: (job) => ({ ...job }),
    normalizeIndustryFileTime: (v, d) => (v ? BigInt(String(v)) : d),
    currentFileTime: () => 1000n,
    isCharacterOwner: (session, ownerID) => Number(session.characterID) === Number(ownerID),
    isCorporationOwner: (session, ownerID) => Number(session.corporationID) === Number(ownerID),
    canSeeCorporationBlueprints: (session) => session.roles === "director",
    canViewOwnerLocation: () => true,
    getIndustryJobBlueprintInventoryFlagID: (job) => Number(job.blueprintLocationFlagID) || 0,
    isCorporationOfficeInventoryLocation: () => false,
    getItemAvailableQuantity: (item) => Math.max(0, Number(item && item.quantity) || 0),
  };
  const ctx = vm.createContext(host);
  const script = [
    "\"use strict\";",
    "const BLUEPRINT_CATEGORY_ID = 9;",
    "const ANCIENT_RELIC_CATEGORY_ID = 34;",
    "const INDUSTRY_INSTALLED_LOCATION_ID = 2003;",
    "const INDUSTRY_BLUEPRINT_STATE_TABLE = \"industryBlueprintState\";",
    "const INDUSTRY_JOBS_TABLE = \"industryJobs\";",
    "const JOB_ID_START = 970000000000000;",
    "const OFFICE_TYPE_ID = 27;",
    "const INDUSTRY_STATUS = { UNSUBMITTED: 0, INSTALLED: 1, PAUSED: 2, READY: 3, COMPLETED: 100 };",
    "const loggedIndustryBlueprintOrphanIDs = new Set();",
    "function toInt(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : fallback; }",
    extractBodies(industryText, VENDOR_BODIES),
    "({ listBlueprintInstancesByOwner, getBlueprintByItemID });",
  ].join("\n");
  const vendor = vm.runInContext(script, ctx);
  return { store, vendor, counters, listOwnedItems: host.listOwnedItems };
}

const CFG = Object.freeze({ blueprintOwnerRead: true, blueprintOwnerReadParityCheck: false, slowCallMs: 1e9 });

function wrapHarness(h, sources, config = CFG, lines = []) {
  const bp = createBlueprintOwnerRead({ config, log: (l) => lines.push(l), now: () => 0, fingerprints: currentFingerprints(sources) });
  h.store.exports.read = bp.wrapRead(h.store.exports.read);
  h.store.exports.write = bp.wrapWrite(h.store.exports.write);
  assert.strictEqual(bp.setDeps({ listOwnedItems: h.listOwnedItems, getBlueprintByItemID: h.vendor.getBlueprintByItemID }), true);
  assert.deepStrictEqual(bp.checkFingerprint(sources), { ok: true });
  return { bp, list: bp.wrapList(h.vendor.listBlueprintInstancesByOwner), lines };
}

const SESSION_A = Object.freeze({ characterID: CHAR_A, corporationID: CORP_B });
const SESSION_C = Object.freeze({ characterID: CHAR_C, corporationID: 98000002 });
const SESSION_CORP_NO_ROLES = Object.freeze({ characterID: CHAR_C, corporationID: CORP_B, roles: "none" });
const SESSION_DIRECTOR = Object.freeze({ characterID: CHAR_C, corporationID: CORP_B, roles: "director" });

function fakeTree(industryText, starbaseText, tamper) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath12-"));
  const src = path.join(root, "server", "src");
  const dirs = { store: path.join(src, "gameStore"), inv: path.join(src, "services", "inventory"), ind: path.join(src, "services", "industry") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dirs.store, "index.js"), "\"use strict\";\n" +
    "function read(table, pth) { return { success: true, errorMsg: null, data: { table, pth } }; }\n" +
    "function write() { return { success: true, errorMsg: null }; }\nmodule.exports = { read, write };\n");
  fs.writeFileSync(path.join(dirs.inv, "itemStore.js"), "\"use strict\";\n" +
    "function listOwnedItems() { return []; }\nfunction findItemById() { return null; }\nmodule.exports = { listOwnedItems, findItemById };\n");
  let bodies = extractBodies(industryText, [...INDUSTRY_FUNCTIONS, "readTableView", "readJobsView"]);
  if (tamper) bodies = bodies.replace("function getJobByID(jobID) {", "function getJobByID(jobID) {\n  ensureJobsTable();");
  fs.writeFileSync(path.join(dirs.ind, "industryRuntimeState.js"), "\"use strict\";\nconst path = require(\"path\");\n" +
    "const database = require(path.join(__dirname, \"../../gameStore\"));\n" +
    "const { listOwnedItems } = require(path.join(__dirname, \"../inventory/itemStore\"));\n" +
    "const starbaseIndustry = require(\"./starbaseIndustryRuntime\");\n\n" + bodies +
    "\n\nmodule.exports = {\n  getBlueprintByItemID,\n  listBlueprintInstancesByOwner,\n};\n");
  fs.writeFileSync(path.join(dirs.ind, "starbaseIndustryRuntime.js"), "\"use strict\";\n" +
    extractBodies(starbaseText, STARBASE_FUNCTIONS) + "\n\nmodule.exports = { getArrayContext, getAssemblyArray, canAccessArray };\n");
  fs.writeFileSync(path.join(dirs.ind, "blueprintManagerService.js"), "\"use strict\";\nconst path = require(\"path\");\n" +
    "const {\n  getBlueprintByItemID,\n  listBlueprintInstancesByOwner,\n} = require(path.join(__dirname, \"./industryRuntimeState\"));\n" +
    "module.exports = { getBlueprintByItemID, listBlueprintInstancesByOwner };\n");
  return { root, src, dirs };
}

function withTree(tree, fn) {
  const previous = Module._load;
  try {
    return fn();
  } finally {
    Module._load = previous;
    for (const key of Object.keys(require.cache)) if (key.startsWith(tree.root)) delete require.cache[key];
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
}

function register(ctx) {
  const { test, config, loader, SERVER_SRC } = ctx;
  const industryFile = path.join(SERVER_SRC, "services", "industry", "industryRuntimeState.js");
  const starbaseFile = path.join(SERVER_SRC, "services", "industry", "starbaseIndustryRuntime.js");
  const haveSrc = fs.existsSync(industryFile) && fs.existsSync(starbaseFile);
  const industryText = haveSrc ? fs.readFileSync(industryFile, "utf8") : "";
  const starbaseText = haveSrc ? fs.readFileSync(starbaseFile, "utf8") : "";
  const sources = { industrySource: industryText, starbaseSource: starbaseText };

  test("T1 blueprintOwnerRead: result = vendor (3 owners, facility null/specific, sessions), zero full table clones", () => {
    if (!haveSrc) return;
    const cases = [
      [CHAR_A, null, null], [CHAR_A, STATION, SESSION_A], [CHAR_A, null, SESSION_A],
      [CORP_B, null, SESSION_CORP_NO_ROLES], [CORP_B, null, SESSION_DIRECTOR],
      [CHAR_C, null, SESSION_C], [CHAR_C, OTHER_STATION, SESSION_C], [CHAR_C, STATION, SESSION_C],
    ];
    for (const [owner, facility, session] of cases) {
      const v = vendorHarness(industryText);
      const expected = v.vendor.listBlueprintInstancesByOwner(owner, facility, session);
      assert.ok(v.counters.bigClones <= 1, `vendor 261115.2: full table clones=${v.counters.bigClones}`);
      const h = vendorHarness(industryText);
      const w = wrapHarness(h, sources);
      assert.strictEqual(w.bp.state(), "on");
      const got = w.list(owner, facility, session);
      const label = `owner=${owner} facility=${facility} session=${JSON.stringify(session)}`;
      assert.deepStrictEqual(clone(got), clone(expected), label);
      assert.strictEqual(JSON.stringify(got), JSON.stringify(expected), `key order: ${label}`);
      assert.strictEqual(h.counters.bigClones, 0, `full table clones in scope: ${label}`);
      assert.deepStrictEqual(Object.keys(h.store.cache.industryBlueprintState.records).sort(),
        Object.keys(v.store.cache.industryBlueprintState.records).sort(), `same records after the call: ${label}`);
    }
    const v = vendorHarness(industryText);
    assert.deepStrictEqual(clone(v.vendor.listBlueprintInstancesByOwner(CHAR_A, null, null).blueprints.map((b) => b.itemID)), [1001, 1002, 1003, 1005]);
    assert.deepStrictEqual(clone(v.vendor.listBlueprintInstancesByOwner(CORP_B, null, SESSION_CORP_NO_ROLES)), { blueprints: [], counts: {} });
  });

  test("T2 blueprintOwnerRead: lazy write of a BPO without a record = per-record writes, no record is lost; second time without a write", () => {
    if (!haveSrc) return;
    const h = vendorHarness(industryText);
    const before = clone(h.store.cache.industryBlueprintState.records);
    const jobsBefore = clone(h.store.cache.industryJobs);
    const w = wrapHarness(h, sources);
    w.list(CHAR_A, null, null);
    const after = h.store.cache.industryBlueprintState.records;
    assert.strictEqual(Object.keys(after).length, Object.keys(before).length + 1);
    for (const [key, value] of Object.entries(before)) assert.deepStrictEqual(after[key], value, `record ${key}`);
    assert.deepStrictEqual({ ...after["1005"], updatedAt: 0 }, { itemID: 1005, typeID: 681, materialEfficiency: 0, timeEfficiency: 0,
      original: true, runsRemaining: -1, jobID: null, updatedAt: 0 });
    assert.deepStrictEqual(h.store.cache.industryJobs, jobsBefore, "industryJobs unchanged");
    assert.strictEqual(w.bp.statsSnapshot().scopedWrites, 1);
    assert.ok(h.store.writes.length > 0 && h.store.writes.every(([, p]) => p !== "/"), JSON.stringify(h.store.writes));
    assert.ok(h.store.writes.some(([t, p]) => t === "industryBlueprintState" && p === "/records/1005"));
    assert.ok(h.store.writes.some(([t, p]) => t === "industryBlueprintState" && p === "/_meta"));
    w.list(CHAR_A, null, null);
    assert.strictEqual(w.bp.statsSnapshot().scopedWrites, 1, "second call without a write");
    assert.ok(w.bp.statsSnapshot().scopedReads > 0);
  });

  test("T3 blueprintOwnerRead: transparent outside the scope; exception = disabled:error, vendor result, scope reset", () => {
    const RESULT = { success: true, errorMsg: null, data: { records: { 1: {}, 2: {} } } };
    const WRESULT = { success: true, errorMsg: null };
    const lines = [];
    const bp = createBlueprintOwnerRead({ config: CFG, log: (l) => lines.push(l), now: () => 0, fingerprints: currentFingerprints(sources) });
    const read = bp.wrapRead(function read() { return RESULT; });
    const write = bp.wrapWrite(function write() { return WRESULT; });
    assert.strictEqual(read("industryBlueprintState", "/"), RESULT, "outside the scope");
    assert.strictEqual(write("industryBlueprintState", "/", {}), WRESULT, "outside the scope");
    bp.runScoped(1, () => {
      assert.strictEqual(read("items", "/"), RESULT, "another table");
      assert.strictEqual(read("industryBlueprintState", "/records/1"), RESULT, "path with segments");
      assert.strictEqual(write("items", "/", {}), WRESULT, "another table");
      assert.strictEqual(write("industryJobs", "/jobs/1", {}), WRESULT, "path with segments");
      assert.notStrictEqual(read("industryBlueprintState", "/"), RESULT, "view inside the scope");
      assert.deepStrictEqual(Object.keys(read("industryBlueprintState", "").data.records), ["1"]);
    });
    assert.strictEqual(bp.state(), "waiting", "without deps and fingerprint");
    const vendorResult = { blueprints: [{ itemID: 7 }], counts: { null: 1 } };
    let vendorCalls = 0;
    const list = bp.wrapList(function listBlueprintInstancesByOwner() { vendorCalls += 1; return vendorResult; });
    assert.strictEqual(list(1), vendorResult, "waiting = vendor");
    if (!haveSrc) return;
    bp.setDeps({
      listOwnedItems: () => [{ itemID: 7 }],
      getBlueprintByItemID: () => {
        assert.strictEqual(bp.status().depth, 1);
        throw new Error("boom");
      },
    });
    assert.deepStrictEqual(bp.checkFingerprint(sources), { ok: true });
    assert.strictEqual(bp.state(), "on");
    assert.strictEqual(list(1, null, null), vendorResult);
    assert.strictEqual(bp.state(), "disabled:error");
    assert.strictEqual(bp.status().depth, 0, "scope reset to zero");
    assert.ok(lines.some((l) => l === "WARN blueprintOwnerRead disabled: error (boom)"), lines.join("|"));
    assert.strictEqual(read("industryBlueprintState", "/"), RESULT);
    assert.strictEqual(list(1), vendorResult);
    assert.strictEqual(vendorCalls, 3);
    assert.ok(/fallback=error:2,waiting:1 /.test(bp.statsLine()), bp.statsLine());
  });

  test("T4 blueprintOwnerRead: parity — vendor reads a key outside the view = disabled:parity, vendor result, then vendor only", () => {
    if (!haveSrc) return;
    const store = makeStore({ industryBlueprintState: { _meta: {}, records: { 1: { jobID: null }, 2: { jobID: null }, 3: {} } }, industryJobs: { jobs: {} } });
    const lines = [];
    const bp = createBlueprintOwnerRead({ config: { ...CFG, blueprintOwnerReadParityCheck: true }, log: (l) => lines.push(l), now: () => 0,
      fingerprints: currentFingerprints(sources) });
    store.exports.read = bp.wrapRead(store.exports.read);
    store.exports.write = bp.wrapWrite(store.exports.write);
    const owned = () => [{ itemID: 1 }, { itemID: 2 }];
    const getBp = (itemID) => ({ itemID, facilityID: null, seen: Object.keys(store.exports.read("industryBlueprintState", "/").data.records).length });
    function listBlueprintInstancesByOwner(ownerID) {
      const blueprints = owned(ownerID).map((it) => getBp(it.itemID));
      return { blueprints, counts: { null: blueprints.length } };
    }
    bp.setDeps({ listOwnedItems: owned, getBlueprintByItemID: getBp });
    bp.checkFingerprint(sources);
    const list = bp.wrapList(listBlueprintInstancesByOwner);
    const first = list(5);
    assert.deepStrictEqual(first.blueprints.map((b) => b.seen), [3, 3], "vendor result returned");
    assert.strictEqual(bp.state(), "disabled:parity");
    assert.ok(lines.includes("WARN blueprintOwnerRead disabled: parity (owner=5 firstItem=1)"), lines.join("|"));
    assert.deepStrictEqual(list(5).blueprints.map((b) => b.seen), [3, 3]);
    const snap = bp.statsSnapshot();
    assert.strictEqual(snap.parityChecks, 1);
    assert.deepStrictEqual(snap.fallback, { parity: 1 });
    const ok = createBlueprintOwnerRead({ config: { ...CFG, blueprintOwnerReadParityCheck: true }, log: () => {}, now: () => 0,
      fingerprints: currentFingerprints(sources) });
    const s2 = makeStore({ industryBlueprintState: { records: {} } });
    ok.wrapRead(s2.exports.read);
    ok.wrapWrite(s2.exports.write);
    ok.setDeps({ listOwnedItems: owned, getBlueprintByItemID: (id) => ({ itemID: id, facilityID: 5 }) });
    ok.checkFingerprint(sources);
    const res = ok.wrapList(function listBlueprintInstancesByOwner() {
      return { counts: { 5: 2 }, blueprints: [{ itemID: 1, facilityID: 5 }, { itemID: 2, facilityID: 5 }] };
    })(9, 5);
    assert.deepStrictEqual(res, { blueprints: [{ itemID: 1, facilityID: 5 }, { itemID: 2, facilityID: 5 }], counts: { 5: 2 } });
    assert.strictEqual(ok.state(), "on");
    assert.ok(/^blueprintOwnerRead state=on calls=1 items=2 itemsMax=2 .* parityChecks=1$/.test(ok.statsLine()), ok.statsLine());
  });

  test("T5 blueprintOwnerRead: 261115.2 = obsolete (readTableView), vendor facts, config, loader at first load (flag true/false/drift)", () => {
    const def = require("../config").loadConfig({ env: {}, settingsPath: MISSING });
    assert.deepStrictEqual([def.blueprintOwnerRead, def.blueprintOwnerReadParityCheck], [false, false]);
    assert.strictEqual(config.blueprintOwnerRead, false, "mod default false");
    const env = require("../config").loadConfig({ env: { HOTPATH_BLUEPRINT_OWNER_READ: "1", HOTPATH_BLUEPRINT_OWNER_READ_PARITY: "on" }, settingsPath: MISSING });
    assert.deepStrictEqual([env.blueprintOwnerRead, env.blueprintOwnerReadParityCheck], [true, true]);
    assert.strictEqual(loader.targetOf("/app/server/src/services/industry/industryRuntimeState.js"), "industryRuntimeState");
    assert.strictEqual(loader.GAME_TARGETS.has("industryRuntimeState"), false);
    const bad = createBlueprintOwnerRead({ config: CFG, log: () => {} });
    assert.deepStrictEqual(bad.checkFingerprint({ industrySource: "", starbaseSource: "" }), { ok: false, reason: "drift", detail: "readTable" });
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const base = { ...config, ...quiet, prewarmLocations: false, schedulerMaxPending: 0, schedulerRequestTimeoutMs: 0 };
    const offState = loader.createState(base, null);
    assert.strictEqual(offState.bpRead, null);
    assert.ok(!offState.requestPattern.test("./industryRuntimeState"));
    if (!haveSrc) return;

    assert.deepStrictEqual(createBlueprintOwnerRead({ config: CFG, log: () => {} }).checkFingerprint(sources),
      { ok: false, reason: "drift", detail: "getStoredBlueprintState" });
    assert.strictEqual(fixedUpstream(industryText), true, "261115.2 reads tables through a view");
    assert.strictEqual(fixedUpstream(""), false);
    const fp = fingerprintFunctions(industryText, INDUSTRY_FUNCTIONS);
    assert.strictEqual([...fp.values()].filter(Boolean).length, 17);
    for (const name of ["getStoredBlueprintState", "getBlueprintState", "buildBlueprintInstance", "listBlueprintInstancesByOwner",
      "getBlueprintByItemID", "getJobByID"]) assert.notStrictEqual(fp.get(name), FINGERPRINTS.industry[name], `changed: ${name}`);
    const text = industryText.replace(/\r\n/g, "\n");
    assert.strictEqual(fixedUpstream(text.replace("const job = readJobsView()[String(toInt(jobID, 0))];",
      "const payload = ensureJobsTable();\n  const job = payload.jobs[String(toInt(jobID, 0))];")), false);
    assert.ok(text.includes("const result = database.read(tableName, \"/\");"));
    assert.ok(text.includes("const result = database.write(tableName, \"/\", payload);"));
    const exportsBlock = text.slice(text.lastIndexOf("\nmodule.exports = {"));
    assert.ok(exportsBlock.includes("\n  listBlueprintInstancesByOwner,\n") && exportsBlock.includes("\n  getBlueprintByItemID,\n"));
    const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    assert.ok(/\n  listBlueprintInstancesByOwner,\n\} = require\(path\.join\(__dirname, "\.\/industryRuntimeState"\)\);/
      .test(read("services/industry/blueprintManagerService.js")), "destructuring in blueprintManagerService");
    assert.ok(/\n  listBlueprintInstancesByOwner,\n[^}]*\} = require\(path\.join\(__dirname, "\.\/industryRuntimeState"\)\);/
      .test(read("services/industry/industryChatCommands.js")), "destructuring in industryChatCommands");
    assert.ok(read("gameStore/sqliteStore.js").includes("industryBlueprintState: [\"records\"],") &&
      read("gameStore/sqliteStore.js").includes("industryJobs: [\"jobs\"],"), "row groups");

    const run = (flagOn, tamper) => {
      const tree = fakeTree(industryText, starbaseText, tamper);
      return withTree(tree, () => {
        const lines = [];
        const state = loader.createState({ ...base, blueprintOwnerRead: flagOn }, null, { log: (l) => lines.push(l) });
        loader.installHook(state);
        const consumer = require(path.join(tree.dirs.ind, "blueprintManagerService.js"));
        const store = require(path.join(tree.dirs.store, "index.js"));
        return { state, consumer, store, lines };
      });
    };
    const on = run(true, false);
    assert.strictEqual(on.consumer.listBlueprintInstancesByOwner.__hotPathPerfBlueprint, undefined, "obsolete: binding = vendor");
    assert.strictEqual(on.state.bpRead.state(), "disabled:obsolete");
    assert.deepStrictEqual(on.lines.filter((l) => l.includes("blueprintOwnerRead")),
      ["WARN blueprintOwnerRead disabled: obsolete (EveJS reads it itself: industryRuntimeState.readTableView)"]);
    on.state.gameSeen = true;
    assert.strictEqual(loader.checkBpReadDrift(on.state), false);
    const onProbe = loader.probeMessage(on.state);
    assert.ok(!onProbe.startsWith("DRIFT") && onProbe.endsWith("; blueprintOwnerRead disabled: obsolete"), onProbe);

    const off = run(false, false);
    assert.strictEqual(off.consumer.listBlueprintInstancesByOwner.__hotPathPerfBlueprint, undefined);
    assert.strictEqual(off.store.read.__hotPathPerfBlueprint, undefined);

    const drift = run(true, true);
    assert.strictEqual(drift.state.bpRead.state(), "disabled:drift");
    assert.strictEqual(drift.consumer.listBlueprintInstancesByOwner.__hotPathPerfBlueprint, undefined);
    assert.ok(drift.lines.includes("WARN blueprintOwnerRead disabled: drift (getStoredBlueprintState)"), drift.lines.join("|"));
    drift.state.gameSeen = true;
    assert.ok(loader.probeMessage(drift.state).endsWith("; blueprintOwnerRead disabled: drift"), loader.probeMessage(drift.state));
  });
}

module.exports = { register };
