"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const { createNativeWreckList, scopedFixedUpstream, STORE_FUNCTIONS, SITE_FUNCTIONS, FINGERPRINTS } = require("../lib/nativeWreckList");
const { fingerprintFunctions } = require("../lib/blueprintOwnerRead");

const MISSING = path.join(__dirname, "missing.json");
const SYSTEM = 30000142;
const OTHER_SYSTEM = 30002187;

const VENDOR_BODIES = Object.freeze(["cloneValue", "readRoot", ...STORE_FUNCTIONS, "readCollectionRows", "listNativeWrecksMatching"]);

const NEW_SITE_LOOP = "  // Only a wreck in this system can match (wreckSystemMatches below), so copy\n" +
  "  // only this system's wrecks instead of every stored wreck in the universe.\n" +
  "  for (const wreckRecord of getNativeNpcStore().listNativeWrecksMatching((row) => (\n" +
  "    entityIDsEqual(row.systemID, systemID)\n  ))) {\n";
const OLD_SITE_LOOP = "  for (const wreckRecord of getNativeNpcStore().listNativeWrecks()) {\n";
function legacySite(siteText) {
  const lf = siteText.replace(/\r\n/g, "\n");
  assert.ok(lf.includes(NEW_SITE_LOOP), "loop header 261115.2");
  return lf.replace(NEW_SITE_LOOP, OLD_SITE_LOOP);
}

const FIXTURE = Object.freeze({
  npcWrecks: {
    nextWreckID: 980300000010,
    wrecks: {
      3: { wreckID: 3, systemID: SYSTEM, dungeonSiteID: 11, dungeonSiteInstanceID: 21, typeID: 26468 },
      1: { wreckID: 1, systemID: SYSTEM, sourceEntityID: 501, nested: { a: [1, 2] } },
      2: { wreckID: 2, systemID: SYSTEM, nativeDeathEntityID: 77, dungeonSiteID: 11, dungeonSiteInstanceID: 21 },
      4: { wreckID: 4, systemID: SYSTEM, incursionDeathEventID: "evt", dungeonSiteID: 11, dungeonSiteInstanceID: 21 },
      5: { wreckID: 5, systemID: SYSTEM, miningCargoTransferKey: "persistent:9", dungeonSiteID: 11, dungeonSiteInstanceID: 21 },
      6: { wreckID: 6, systemID: SYSTEM, miningCargoTransferKey: "persistent:10", dungeonSiteID: 11, dungeonSiteInstanceID: 21 },
      7: { wreckID: 7, systemID: SYSTEM, miningCargoTransferKey: "persistent:11", dungeonSiteID: 11, dungeonSiteInstanceID: 21 },
      8: { wreckID: 8, systemID: OTHER_SYSTEM, dungeonSiteID: 11, dungeonSiteInstanceID: 21 },
    },
  },
  npcCargo: {
    nextCargoID: 980200000000,
    cargo: {},
    miningTransfers: { "persistent:9": { status: "completed" }, "persistent:10": { status: "pending" } },
  },
});
const VISIBLE = [1, 3, 5, 8];

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

const STORE_HEADER = "const TABLE = Object.freeze({ CARGO: \"npcCargo\", WRECKS: \"npcWrecks\" });\n" +
  "const ROOT = Object.freeze({ npcCargo: { nextCargoID: 980200000000, cargo: {} }, npcWrecks: { nextWreckID: 980300000000, wrecks: {} } });\n" +
  "const shapedRootsByTable = new WeakMap();\n" +
  "const walkCloneValue = (value) => JSON.parse(JSON.stringify(value));\n";

const STORE_IMPL = "function segs(p) { return String(p || \"\").split(\"/\").filter(Boolean); }\n" +
  "function read(table, pth) {\n  if (!(table in cache)) return { success: false, errorMsg: \"TABLE_NOT_FOUND\", data: null };\n" +
  "  let cur = cache[table];\n  for (const k of segs(pth)) {\n" +
  "    if (cur === null || typeof cur !== \"object\" || !(k in cur)) return { success: false, errorMsg: \"ENTRY_NOT_FOUND\", data: null };\n" +
  "    cur = cur[k];\n  }\n  return { success: true, errorMsg: null, data: cur };\n}\n" +
  "function write(table, pth, value) {\n  const s = segs(pth);\n  if (s.length === 0) { cache[table] = value; return { success: true }; }\n" +
  "  let cur = cache[table];\n  for (const k of s.slice(0, -1)) cur = cur[k];\n  cur[s[s.length - 1]] = value;\n  return { success: true };\n}\n";

function makeStore() {
  const cache = clone(FIXTURE);
  // eslint-disable-next-line no-new-func
  const api = new Function("cache", `${STORE_IMPL}return { read, write };`)(cache);
  return { cache, read: api.read, write: api.write };
}

const DEATH = Object.freeze({ isPendingWreck: (r) => Boolean(r && r.nativeDeathEntityID === 77) });
const INCURSION = Object.freeze({ isPending: (r) => Boolean(r && r.incursionDeathEventID === "evt") });

function vendorHarness(storeText) {
  const store = makeStore();
  const counters = { require: 0 };
  const fakeRequire = (request) => {
    counters.require += 1;
    if (request === "./nativeNpcDeathWrecks") return DEATH;
    if (request === "./incursionDeathWrecks") return INCURSION;
    throw new Error(`unexpected require ${request}`);
  };
  const code = `(function (database, require) {\n"use strict";\n${STORE_HEADER}${extractBodies(storeText, VENDOR_BODIES)}\n` +
    "return { TABLE, listNativeWrecks };\n})";
  const vendor = vm.runInThisContext(code, { filename: "/app/server/src/space/npc/nativeNpcStore.js" })(store, fakeRequire);
  return { store, counters, vendor };
}

function callers(list) {
  const code = "(function (list) {\n" +
    "  function listStoredDungeonNativeWreckIDs() { return list(); }\n" +
    "  function removeStoredDungeonSiteContent() { return list(); }\n" +
    "  return { listStoredDungeonNativeWreckIDs, removeStoredDungeonSiteContent };\n})";
  const site = vm.runInThisContext(code, { filename: "/app/server/src/services/dungeon/dungeonUniverseSiteService.js" })(list);
  const elsewhere = vm.runInThisContext(code, { filename: "/app/server/src/space/npc/nativeNpcWreckService.js" })(list);
  return { site, elsewhere };
}

function fakeTree(storeText, siteText, tamper) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath13-"));
  const src = path.join(root, "server", "src");
  const dirs = { store: path.join(src, "gameStore"), npc: path.join(src, "space", "npc"), dungeon: path.join(src, "services", "dungeon") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const bump = (text, name) => (tamper === name ? text.replace(new RegExp(`^function ${name}\\(`, "m"), `function ${name}( `) : text);
  fs.writeFileSync(path.join(dirs.store, "index.js"), `"use strict";\nconst cache = ${JSON.stringify(FIXTURE)};\n${STORE_IMPL}` +
    "module.exports = { read, write, cache };\n");
  let bodies = extractBodies(storeText, VENDOR_BODIES);
  for (const name of STORE_FUNCTIONS) bodies = bump(bodies, name);
  fs.writeFileSync(path.join(dirs.npc, "nativeNpcStore.js"), "\"use strict\";\nconst path = require(\"path\");\n" +
    "const database = require(path.join(__dirname, \"../../gameStore\"));\n" + STORE_HEADER + bodies +
    "\n\nmodule.exports = {\n  TABLE,\n  listNativeWrecks,\n  listNativeWrecksMatching,\n};\n");
  fs.writeFileSync(path.join(dirs.npc, "nativeNpcDeathWrecks.js"), "\"use strict\";\n" +
    "function isPendingWreck(r) { return Boolean(r && r.nativeDeathEntityID === 77); }\nmodule.exports = { isPendingWreck };\n");
  fs.writeFileSync(path.join(dirs.npc, "incursionDeathWrecks.js"), "\"use strict\";\n" +
    "function isPending(r) { return Boolean(r && r.incursionDeathEventID === \"evt\"); }\nmodule.exports = { isPending };\n");
  fs.writeFileSync(path.join(dirs.dungeon, "dungeonUniverseSiteService.js"), "\"use strict\";\nconst path = require(\"path\");\n" +
    "function getNativeNpcStore() {\n  return require(path.join(__dirname, \"../../space/npc/nativeNpcStore\"));\n}\n" +
    "function entityIDsEqual(a, b) { return a !== null && a !== undefined && String(a) === String(b); }\n" +
    "function normalizeCleanupIdentity(v) { return v === null || v === undefined ? null : String(v); }\n" +
    "function exactIdentitySetHas(set, v) { return set.has(String(v)); }\n" +
    "function addExactIdentity(set, v) { set.add(String(v)); }\n" +
    bump(extractBodies(siteText, SITE_FUNCTIONS), SITE_FUNCTIONS[0]) +
    "\n\nmodule.exports = { listStoredDungeonNativeWreckIDs, getNativeNpcStore };\n");
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
  const storeFile = path.join(SERVER_SRC, "space", "npc", "nativeNpcStore.js");
  const siteFile = path.join(SERVER_SRC, "services", "dungeon", "dungeonUniverseSiteService.js");
  const haveSrc = fs.existsSync(storeFile) && fs.existsSync(siteFile);
  const storeText = haveSrc ? fs.readFileSync(storeFile, "utf8") : "";
  const siteText = haveSrc ? fs.readFileSync(siteFile, "utf8") : "";
  const sources = { storeSource: storeText, siteSource: siteText };
  const legacySiteText = haveSrc ? legacySite(siteText) : "";
  const legacySources = { storeSource: storeText, siteSource: legacySiteText };
  const CFG = Object.freeze({ ...config, nativeWreckList: true });

  function wrapHarness(h, cfg = CFG, src = sources) {
    const lines = [];
    const nwl = createNativeWreckList({ config: cfg, log: (l) => lines.push(l) });
    assert.strictEqual(nwl.setDeps(h.vendor, h.store, DEATH, () => INCURSION), true);
    assert.deepStrictEqual(nwl.checkFingerprint(src), src === sources ? { ok: true, obsolete: ["scoped"] } : { ok: true });
    return { nwl, list: nwl.wrapList(h.vendor.listNativeWrecks), lines };
  }

  test("N1 nativeWreckList: global mode = vendor result (JSON), pending without require, clone; new root = original", () => {
    if (!haveSrc) return;
    const v = vendorHarness(storeText);
    const expected = v.vendor.listNativeWrecks();
    assert.deepStrictEqual(expected.map((r) => r.wreckID), VISIBLE, "fixture check");
    assert.strictEqual(v.counters.require, 2 * 8 - 1, "vendor: require per wreck (fixture check)");
    const h = vendorHarness(storeText);
    const w = wrapHarness(h);
    const first = w.list();
    assert.strictEqual(JSON.stringify(first), JSON.stringify(expected), "first call = original");
    const requiresBefore = h.counters.require;
    const got = w.list();
    assert.strictEqual(h.counters.require, requiresBefore, "zero require on the fast path");
    assert.strictEqual(JSON.stringify(got), JSON.stringify(expected));
    assert.notStrictEqual(got[0], h.store.cache.npcWrecks.wrecks[1], "global = clone");
    got[0].nested.a.push(3);
    assert.deepStrictEqual(h.store.cache.npcWrecks.wrecks[1].nested.a, [1, 2], "mutating the result does not touch the cache");
    h.store.write("npcWrecks", "/", clone(h.store.cache.npcWrecks));
    assert.strictEqual(JSON.stringify(w.list()), JSON.stringify(expected));
    assert.strictEqual(JSON.stringify(w.list()), JSON.stringify(expected));
    const snap = w.nwl.statsSnapshot();
    assert.deepStrictEqual([snap.calls, snap.global, snap.scoped, snap.pendingHits, snap.rowsMax], [4, 2, 0, 8, 4]);
    assert.deepStrictEqual(snap.fallback, { first: 1, root: 1 });
    assert.ok(/^stats nativeWreckList state=ready calls=4 scoped=0 global=2 rows=8 rowsMax=4 pendingHits=8 fallback=first:1,root:1 parityChecks=0$/
      .test(w.nwl.drainStatsLines()[0]));
    const p = vendorHarness(storeText);
    const pw = wrapHarness(p, { ...CFG, nativeWreckListParityCheck: true });
    pw.list();
    assert.strictEqual(JSON.stringify(pw.list()), JSON.stringify(expected));
    assert.deepStrictEqual([pw.nwl.statsSnapshot().parityChecks, pw.nwl.status().state], [1, "ready"]);
    const s = vendorHarness(storeText);
    const sw = wrapHarness(s);
    sw.list();
    s.store.cache.npcWrecks.wrecks = 5;
    assert.deepStrictEqual(sw.list(), []);
    assert.deepStrictEqual(sw.nwl.statsSnapshot().fallback, { first: 1, shape: 1 });
  });

  test("N2 nativeWreckList: CallSite scope — listStoredDungeonNativeWreckIDs = live rows; other caller/file = clone", () => {
    if (!haveSrc) return;
    const h = vendorHarness(storeText);
    const w = wrapHarness(h, CFG, legacySources);
    const c = callers(w.list);
    w.list();
    const live = h.store.cache.npcWrecks.wrecks;
    const scoped = c.site.listStoredDungeonNativeWreckIDs();
    assert.deepStrictEqual(scoped.map((r) => r.wreckID), VISIBLE);
    for (const row of scoped) assert.strictEqual(row, live[row.wreckID], `row ${row.wreckID} live`);
    for (const other of [c.site.removeStoredDungeonSiteContent(), c.elsewhere.listStoredDungeonNativeWreckIDs(), w.list()]) {
      assert.deepStrictEqual(other.map((r) => r.wreckID), VISIBLE);
      assert.ok(other.every((row) => row !== live[row.wreckID]), "clone");
    }
    const snap = w.nwl.statsSnapshot();
    assert.deepStrictEqual([snap.scoped, snap.global, snap.state, w.nwl.status().scoped], [1, 3, "ready", "on"]);
    assert.deepStrictEqual(w.lines, []);
    const n = vendorHarness(storeText);
    const nw = wrapHarness(n);
    nw.list();
    const nc = callers(nw.list);
    const rows = nc.site.listStoredDungeonNativeWreckIDs();
    assert.deepStrictEqual(rows.map((r) => r.wreckID), VISIBLE);
    assert.ok(rows.every((row) => row !== n.store.cache.npcWrecks.wrecks[row.wreckID]), "obsolete scope = clone");
    assert.deepStrictEqual([nw.nwl.statsSnapshot().scoped, nw.nwl.status().scoped, nw.nwl.status().state], [0, "obsolete", "ready"]);
    assert.deepStrictEqual(nw.lines, ["WARN nativeWreckList scoped disabled: obsolete (EveJS reads it itself: " +
      "listStoredDungeonNativeWreckIDs → listNativeWrecksMatching)"]);
  });

  test("N3 nativeWreckList: fingerprint — changed text of any of the 6 functions = disabled:drift, export not wrapped, vendor result", () => {
    if (!haveSrc) return;
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const base = { ...config, ...quiet, prewarmLocations: false, schedulerMaxPending: 0, schedulerRequestTimeoutMs: 0 };
    for (const name of [...STORE_FUNCTIONS, ...SITE_FUNCTIONS]) {
      const tree = fakeTree(storeText, SITE_FUNCTIONS.includes(name) ? legacySiteText : siteText, name);
      withTree(tree, () => {
        const lines = [];
        const state = loader.createState({ ...base, nativeWreckList: true }, null, { log: (l) => lines.push(l) });
        loader.installHook(state);
        const site = require(path.join(tree.dirs.dungeon, "dungeonUniverseSiteService.js"));
        const store = site.getNativeNpcStore();
        assert.strictEqual(state.wreck.status().state, "disabled:drift", name);
        assert.ok(lines.includes(`WARN nativeWreckList disabled: drift (${name})`), lines.join("|"));
        assert.strictEqual(store.listNativeWrecks.__hotPathPerfWreckList, undefined, name);
        assert.deepStrictEqual(store.listNativeWrecks().map((r) => r.wreckID), VISIBLE, name);
        state.gameSeen = true;
        assert.ok(loader.probeMessage(state).endsWith("; nativeWreckList disabled: drift"), loader.probeMessage(state));
      });
    }
    const tree = fakeTree(storeText, siteText, SITE_FUNCTIONS[0]);
    withTree(tree, () => {
      const lines = [];
      const state = loader.createState({ ...base, nativeWreckList: true }, null, { log: (l) => lines.push(l) });
      loader.installHook(state);
      const site = require(path.join(tree.dirs.dungeon, "dungeonUniverseSiteService.js"));
      const store = site.getNativeNpcStore();
      assert.strictEqual(state.wreck.status().state, "ready");
      assert.strictEqual(state.wreck.status().scoped, "obsolete");
      assert.ok(store.listNativeWrecks.__hotPathPerfWreckList);
      assert.ok(!lines.some((l) => l.includes("drift")), lines.join("|"));
    });
    const bad = createNativeWreckList({ config: CFG, log: () => {} });
    assert.deepStrictEqual(bad.checkFingerprint({ storeSource: "", siteSource: "" }), { ok: false, reason: "drift", detail: "listNativeWrecks" });
  });

  test("N4 vendor facts 261115.2: listNativeWrecks consumers through a property, scope = listNativeWrecksMatching (obsolete), live cache, exports", () => {
    if (!haveSrc) return;
    const hits = [];
    for (const file of ctx.listJs(SERVER_SRC)) {
      const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      if (!text.includes("listNativeWrecks")) continue;
      text.split("\n").forEach((line, i) => {
        if (/listNativeWrecks\b/.test(line) && !line.includes(".listNativeWrecks(")) hits.push(`${path.relative(SERVER_SRC, file)}:${line.trim()}`);
      });
    }
    const npc = path.join("space", "npc", "nativeNpcStore.js");
    assert.deepStrictEqual(hits.sort(), [`${npc}:function listNativeWrecks() {`, `${npc}:listNativeWrecks,`,
      `${npc}:// the same pending-wreck filter as listNativeWrecks, instead of copying and`].sort());
    assert.strictEqual(scopedFixedUpstream(siteText), true);
    assert.strictEqual(scopedFixedUpstream(legacySiteText), false);
    assert.strictEqual(fingerprintFunctions(legacySiteText, SITE_FUNCTIONS).get(SITE_FUNCTIONS[0]), FINGERPRINTS.site[SITE_FUNCTIONS[0]],
      "reversed hunk = 261108.1 text");
    const globalCallers = [];
    for (const file of ctx.listJs(SERVER_SRC)) {
      if (fs.readFileSync(file, "utf8").includes(".listNativeWrecks(")) globalCallers.push(path.relative(SERVER_SRC, file).replace(/\\/g, "/"));
    }
    assert.deepStrictEqual(globalCallers.sort(), ["services/activity/voidSystems.js", "space/npc/nativeNpcWreckService.js",
      "space/runtime/spaceRuntime/sceneDisposal.js"]);
    assert.ok(storeText.replace(/\r\n/g, "\n").includes("\n  listNativeWrecksMatching,\n"));
    const gs = fs.readFileSync(path.join(SERVER_SRC, "gameStore", "index.js"), "utf8").replace(/\r\n/g, "\n");
    assert.ok(/function read\(table, pth\) \{[\s\S]*?const db = cache\[table\];\n\n    if \(segments\.length === 0\) \{\n      return \{ success: true, errorMsg: null, data: db \};/
      .test(gs), "gameStore.read of a root returns the live cache object");
    const st = storeText.replace(/\r\n/g, "\n");
    assert.ok(st.includes("The store hands\n// back its live root and mutates it in place for nested writes"), "vendor comment: live root");
    assert.ok(/\nmodule\.exports = \{\n[\s\S]*?\n  TABLE,\n/.test(st) && st.includes("  WRECKS: \"npcWrecks\",") && st.includes("  CARGO: \"npcCargo\","));
    const death = fs.readFileSync(path.join(SERVER_SRC, "space", "npc", "nativeNpcDeathWrecks.js"), "utf8");
    const inc = fs.readFileSync(path.join(SERVER_SRC, "space", "npc", "incursionDeathWrecks.js"), "utf8");
    assert.ok(/module\.exports = \{[^}]*\bisPendingWreck\b/.test(death) && /module\.exports = \{[^}]*\bisPending\b/.test(inc));
    assert.deepStrictEqual(createNativeWreckList({ config: CFG, log: () => {} }).checkFingerprint(sources), { ok: true, obsolete: ["scoped"] });
    assert.deepStrictEqual(createNativeWreckList({ config: CFG, log: () => {} }).checkFingerprint(legacySources), { ok: true });
  });

  test("N5 nativeWreckList: config, flag off = no wrapper; loader wraps, location cleanup = live rows, the same Set", () => {
    const cfg = require("../config");
    const def = cfg.loadConfig({ env: {}, settingsPath: MISSING });
    assert.deepStrictEqual([def.nativeWreckList, def.nativeWreckListParityCheck, config.nativeWreckList], [false, false, false]);
    const env = cfg.loadConfig({ env: { HOTPATH_NATIVE_WRECK_LIST: "1", HOTPATH_NATIVE_WRECK_LIST_PARITY: "on" }, settingsPath: MISSING });
    assert.deepStrictEqual([env.nativeWreckList, env.nativeWreckListParityCheck], [true, true]);
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "settings.json"), "utf8"));
    assert.strictEqual(settings.nativeWreckList, false);
    assert.strictEqual(loader.targetOf("/app/server/src/space/npc/nativeNpcStore.js"), "nativeNpcStore");
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const base = { ...config, ...quiet, prewarmLocations: false, schedulerMaxPending: 0, schedulerRequestTimeoutMs: 0 };
    const offState = loader.createState(base, null);
    assert.strictEqual(offState.wreck, null);
    assert.ok(!offState.requestPattern.test("../../space/npc/nativeNpcStore"));
    assert.ok(![...offState.expected].some((s) => s.startsWith("nativeNpcStore")));
    if (!haveSrc) return;
    const run = (flagOn, site = legacySiteText) => {
      const tree = fakeTree(storeText, site, null);
      return withTree(tree, () => {
        const state = loader.createState({ ...base, nativeWreckList: flagOn }, null, { log: () => {} });
        loader.installHook(state);
        const site = require(path.join(tree.dirs.dungeon, "dungeonUniverseSiteService.js"));
        const ids = [site.listStoredDungeonNativeWreckIDs(SYSTEM, 11, 21, new Set(["501"])),
          site.listStoredDungeonNativeWreckIDs(SYSTEM, 11, 21, new Set(["501"]))];
        return { state, ids, list: site.getNativeNpcStore().listNativeWrecks };
      });
    };
    const off = run(false);
    assert.strictEqual(off.list.__hotPathPerfWreckList, undefined, "flag off: export not wrapped");
    const on = run(true);
    assert.ok(on.list.__hotPathPerfWreckList, "flag on: wrapper");
    for (const symbol of loader.WRECK_REQUIRED) assert.ok(on.state.patched.has(symbol), symbol);
    assert.deepStrictEqual([...on.ids[1]].sort(), [...off.ids[1]].sort());
    assert.deepStrictEqual([...off.ids[0]].sort(), ["1", "3", "5"]);
    const snap = on.state.wreck.statsSnapshot();
    assert.deepStrictEqual([snap.calls, snap.scoped, snap.global, snap.fallback], [2, 1, 0, { first: 1 }]);
    on.state.gameSeen = true;
    assert.strictEqual(loader.checkWreckDrift(on.state), false);
    assert.ok(/^probe: passed \(2 /.test(loader.probeMessage(on.state)), loader.probeMessage(on.state));
    const now = run(true, siteText);
    const nowOff = run(false, siteText);
    assert.deepStrictEqual([...now.ids[0]].sort(), ["1", "3", "5"]);
    assert.deepStrictEqual([...now.ids[1]].sort(), [...nowOff.ids[1]].sort());
    assert.ok(now.list.__hotPathPerfWreckList);
    assert.deepStrictEqual([now.state.wreck.statsSnapshot().calls, now.state.wreck.status().scoped], [0, "obsolete"]);
    now.state.gameSeen = true;
    assert.strictEqual(loader.checkWreckDrift(now.state), false);
    assert.ok(/^probe: passed \(2 /.test(loader.probeMessage(now.state)), loader.probeMessage(now.state));
  });
}

module.exports = { register };
