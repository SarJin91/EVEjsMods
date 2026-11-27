"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const {
  createIncursionTalesMemo, fixedUpstream, deepFreeze, FINGERPRINTS, LIST_TALES_LINE, STORE_LINE, TABLE,
} = require("../lib/incursionTalesMemo");
const { fingerprintFunctions } = require("../lib/blueprintOwnerRead");

const COMPOSE = path.resolve(__dirname, "../../../compose.yaml");
const SCHEMA = "evejs.incursion-lifecycle-state.v1";
const CONTRACT = "evejs.sansha-lifecycle-contract.v1";
const SYSTEMS = [30001, "30001", 30002, 30003, 30004, 30005, 30006];

function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function validateTaleText(lifecycleText) {
  const text = lf(lifecycleText);
  const at = text.indexOf("function validateTale(");
  return text.slice(at, text.indexOf("\n}\n", at) + 2);
}

const UPSTREAM_STORE_REQUIRE = "const { freezeDeep } = require(\"./incursionFrozenValues\");\n";
const UPSTREAM_STORE_EXPORTS = "module.exports = { TABLE, SCHEMA, read, readShared, mutate };";
const UPSTREAM_READ_TALES = "  const readTales = () => (store.readShared ? store.readShared() : store.read()).tales;";
const UPSTREAM_LIST_TALES = "  function listTales() { return Object.values(readTales()).map(validateTale); }";
function legacyStore(storeText) {
  const text = lf(storeText);
  const start = text.indexOf("// One frozen copy of the state for readers that never change it.");
  const end = text.indexOf("// All identity reservations");
  assert.ok(start > 0 && end > start && text.includes(UPSTREAM_STORE_REQUIRE) && text.includes(UPSTREAM_STORE_EXPORTS), "hunki 261115.2");
  return text.slice(0, start).replace(UPSTREAM_STORE_REQUIRE, "") + text.slice(end)
    .replace(UPSTREAM_STORE_EXPORTS, "module.exports = { TABLE, SCHEMA, read, mutate };");
}

function fakeTree(src, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpathIncursion-"));
  const base = path.join(root, "server", "src");
  const inc = path.join(base, "services", "incursion");
  for (const dir of [inc, path.join(base, "services", "_shared"), path.join(base, "gameStore")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(base, "gameStore", "index.js"), "\"use strict\";\nconst cache = {};\nconst control = { failWrite: false };\n" +
    "function read(table, pth) {\n  if (!(table in cache)) return { success: false, errorMsg: \"TABLE_NOT_FOUND\", data: null };\n" +
    "  return pth === \"/\" ? { success: true, errorMsg: null, data: cache[table] } : { success: false, errorMsg: \"ENTRY_NOT_FOUND\", data: null };\n}\n" +
    "function write(table, pth, data) {\n  if (control.failWrite) return { success: false, errorMsg: \"WRITE_FAILED\" };\n" +
    "  cache[table] = data;\n  return { success: true, errorMsg: null };\n}\n" +
    "function ensureTable(table) { if (!(table in cache)) cache[table] = {}; return true; }\n" +
    "function flushTableSync() { return { success: true, errorMsg: null }; }\n" +
    "module.exports = { read, write, ensureTable, flushTableSync, control };\n");
  fs.writeFileSync(path.join(base, "services", "_shared", "serviceHelpers.js"), "\"use strict\";\n" +
    "module.exports = { buildDict: (e) => ({ dict: e }), buildKeyVal: (e) => ({ keyVal: e }), buildFiletimeLong: (v) => ({ long: String(v) }) };\n");
  fs.writeFileSync(path.join(inc, "incursionLifecycleContract.js"), "\"use strict\";\nconst { createHash } = require(\"crypto\");\n" +
    `const VERSION = ${JSON.stringify(CONTRACT)};\n` +
    "function fingerprint(value) { return createHash(\"sha256\").update(JSON.stringify(value)).digest(\"hex\"); }\n" +
    "function fail(code) { const error = new Error(code); error.code = code; throw error; }\n" +
    "function projectInfluence(snapshot) { return snapshot.value; }\n" +
    "module.exports = { VERSION, fingerprint, fail, projectInfluence };\n");
  fs.writeFileSync(path.join(inc, "incursionClock.js"), "\"use strict\";\nmodule.exports = { now: () => 1000 };\n");
  fs.writeFileSync(path.join(inc, "incursionSystemEffectContract.js"), "\"use strict\";\n" +
    "module.exports = { VERSION: \"fx1\", RESONANCES: [267, 268] };\n");
  fs.writeFileSync(path.join(inc, "incursionLifecycle.js"), "\"use strict\";\n" +
    "const contract = require(\"./incursionLifecycleContract\");\nconst { fail, fingerprint } = contract;\n\n" +
    validateTaleText(src("services/incursion/incursionLifecycle.js")) + "\n" +
    "function createIncursionLifecycle(options = {}) {\n" + STORE_LINE + "\n" +
    (options.upstream ? `${UPSTREAM_READ_TALES}\n${UPSTREAM_LIST_TALES}` : LIST_TALES_LINE) + "\n" +
    "  function advanceBoundary(taleID, patch) {\n" +
    "    return store.mutate(state => { Object.assign(state.tales[taleID], patch); return { taleID }; });\n  }\n" +
    "  function mutateWith(reducer) { return store.mutate(reducer); }\n" +
    "  return { listTales, advanceBoundary, mutateWith };\n}\n\n" +
    "module.exports = { ...createIncursionLifecycle(), createIncursionLifecycle };\n");
  const presentation = src("services/incursion/incursionPresentation.js");
  fs.writeFileSync(path.join(inc, "incursionPresentation.js"), options.presentationEdit ? options.presentationEdit(presentation) : presentation);
  const storeText = src("services/incursion/incursionLifecycleStore.js");
  fs.writeFileSync(path.join(inc, "incursionLifecycleStore.js"), options.upstream ? storeText : legacyStore(storeText));
  if (options.upstream) fs.writeFileSync(path.join(inc, "incursionFrozenValues.js"), src("services/incursion/incursionFrozenValues.js"));
  fs.writeFileSync(path.join(inc, "incursionSystemEffects.js"), src("services/incursion/incursionSystemEffects.js"));
  return { root, inc };
}

function withTree(src, options, fn) {
  const tree = fakeTree(src, options);
  const previous = Module._load;
  try {
    return fn(tree);
  } finally {
    Module._load = previous;
    for (const key of Object.keys(require.cache)) if (key.startsWith(tree.root)) delete require.cache[key];
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
}

function makeTale(taleID, systems, extra = {}) {
  const policy = {
    contractVersion: CONTRACT, testOnly: false,
    presentation: { enabled: true, templateNameID: 7, effects: [{ a: 1 }], hasChat: false, chatAnnouncementMessageId: null },
    effects: { application: { version: "fx1", weaponKinds: ["turret", "drone"], bountyMultiplier: 1.5,
      scenes: { 2: { resistancePercent: -40, damagePercent: 20 }, 3: { resistancePercent: -20, damagePercent: 10 } } } },
  };
  return {
    taleID, revision: 3, contractVersion: CONTRACT, policy,
    policyFingerprint: crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    publication: { preparedRevision: 3 }, terminal: null, phase: "established", poolGroupID: 1,
    placement: { stagingSolarSystemID: systems[0], systems: systems.map((id, i) => ({ solarSystemID: id, sceneType: i === 0 ? 2 : 3 })) },
    influence: { value: 0.5, lastUpdatedAtMs: 0, graceMinutes: 1, decayPerHour: 1 }, boss: { available: false },
    ...extra,
  };
}

function seedState() {
  return { schema: SCHEMA, nextSerial: 9, requests: {}, tales: {
    1: makeTale(1, [30001, 30002]),
    2: makeTale(2, [30003], { publication: { preparedRevision: 2 } }),
    3: makeTale(3, [30004], { terminal: { outcome: "expired" } }),
    4: makeTale(4, [30005]),
  } };
}

const SHIP = { kind: "ship", pilotCharacterID: 90000001, systemID: 30001 };

function observe(t) {
  const P = t.presentation;
  const E = t.effects;
  const safe = (fn) => {
    try {
      return fn();
    } catch (error) {
      return { error: error && (error.code || error.message) };
    }
  };
  return {
    forSystem: SYSTEMS.map((id) => safe(() => P.forSystem(id))),
    active: safe(() => P.activeTales()),
    all: safe(() => P.getTales()),
    ctx: SYSTEMS.map((id) => safe(() => {
      const c = E.context(id);
      return c && { resistancePercent: c.resistancePercent, damageMultiplier: c.damageMultiplier, taleID: c.tale.taleID };
    })),
    mods: safe(() => E.shipModifiers(SHIP)),
    dmg: safe(() => E.damageMultiplier(SHIP, "turret")),
    report: safe(() => P.activeTales().map(P.report)),
  };
}

function openTree(tree, loader, stateConfig) {
  const lines = [];
  const state = loader.createState(stateConfig, null, { log: (l) => lines.push(l) });
  loader.installHook(state);
  const effects = require(path.join(tree.inc, "incursionSystemEffects.js"));
  const presentation = require(path.join(tree.inc, "incursionPresentation.js"));
  const gameStore = require(path.join(tree.inc, "..", "..", "gameStore", "index.js"));
  const lifecycle = () => require(path.join(tree.inc, "incursionLifecycle.js"));
  return { state, lines, effects, presentation, gameStore, lifecycle };
}

function scenario(t) {
  const steps = [observe(t)];
  t.gameStore.write(TABLE, "/", seedState());
  steps.push(observe(t));
  steps.push(observe(t));
  t.lifecycle().advanceBoundary(1, { terminal: { outcome: "defeated" }, phase: "withdrawing" });
  steps.push(observe(t));
  t.lifecycle().advanceBoundary(2, { publication: { preparedRevision: 3 } });
  steps.push(observe(t));
  const next = seedState();
  next.tales[4].placement.systems[0].solarSystemID = 30006;
  t.gameStore.write(TABLE, "/", next);
  steps.push(observe(t));
  return steps;
}

function register(ctx) {
  const { test, src, listJs, loader, config, SERVER_SRC } = ctx;
  const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
  const base = { ...config, ...quiet, prewarmLocations: false };
  const on = { ...base, incursionTalesMemo: true };

  test("hotpathIncursion IT1 vendor facts: fingerprints, the only root write, table name, presentation consumers without destructuring, compose", () => {
    const presentation = src("services/incursion/incursionPresentation.js");
    const store = src("services/incursion/incursionLifecycleStore.js");
    const lifecycle = src("services/incursion/incursionLifecycle.js");
    assert.strictEqual(sha1(lf(presentation)), FINGERPRINTS.presentation, "incursionPresentation.js");
    assert.notStrictEqual(sha1(lf(store)), FINGERPRINTS.store, "incursionLifecycleStore.js 261115.2");
    assert.strictEqual(sha1(legacyStore(store)), FINGERPRINTS.store, "reverted hunks = 261108.1 text");
    assert.ok(!lf(lifecycle).split("\n").includes(LIST_TALES_LINE), "the old listTales line is gone");
    assert.ok(lf(lifecycle).split("\n").includes(STORE_LINE), "store line");
    assert.ok(lf(store).includes("if (shared && generation !== null && source.success && shared.source === source.data && shared.generation === generation) return shared.state;"),
      "vendor memo: root identity + write generation");
    assert.ok(src("gameStore/index.js").includes("function getTableWriteGeneration(table) {"));
    assert.strictEqual(fingerprintFunctions(lifecycle, ["validateTale"]).get("validateTale"), FINGERPRINTS.lifecycle.validateTale);
    const memo = createIncursionTalesMemo({ config: {} });
    const file = path.join(SERVER_SRC, "services", "incursion", "incursionPresentation.js");
    assert.deepStrictEqual(memo.checkFingerprint(loader.readIncursionSources(file)), { ok: false, detail: "incursionLifecycleStore.js" });
    assert.strictEqual(fixedUpstream(loader.readIncursionSources(file)), true);
    assert.strictEqual(fixedUpstream({ store: legacyStore(store), lifecycle }), false);
    assert.strictEqual(store.split("write(TABLE").length - 1, 1, "one table write");
    assert.ok(store.includes("database.write(TABLE, \"/\", next)"), "only the root is written");
    assert.strictEqual(store.split("remove(TABLE").length - 1, 0);
    const files = listJs(SERVER_SRC).map((f) => [path.relative(SERVER_SRC, f).replace(/\\/g, "/"), fs.readFileSync(f, "utf8")]);
    const tableNamed = files.filter(([, text]) => text.includes("\"incursionLifecycle\"")).map(([rel]) => rel).sort();
    assert.deepStrictEqual(tableNamed, ["gameStore/index.js", "gameStore/shared-schema/incursionSchema.js", "gameStore/shared-schema/version.js",
      "gameStore/tableOwnership.js", "services/incursion/incursionLifecycleStore.js"]);
    const schemaFiles = files.filter(([rel]) => rel.startsWith("gameStore/shared-schema/") && tableNamed.includes(rel));
    assert.deepStrictEqual(schemaFiles.filter(([, text]) => /\b(write|remove|mutate)\(\s*"incursionLifecycle"/.test(text)).map(([rel]) => rel), [],
      "schema files only map the table");
    const consumerRe = /(presentation|incursionPresentation"\))\.(forSystem|activeTales|getTales)\b/;
    const consumers = files.filter(([, text]) => consumerRe.test(text)).map(([rel]) => rel).sort();
    assert.deepStrictEqual(consumers, ["services/incursion/incursionProjectionRuntime.js", "services/incursion/incursionRuntime.js",
      "services/incursion/incursionSystemEffects.js"], "a new consumer = check whether it only reads");
    const destructure = /\{[^}]*\b(forSystem|activeTales|getTales)\b[^}]*\} = require/;
    const destructuring = files.filter(([, text]) => destructure.test(text));
    assert.deepStrictEqual(destructuring.map(([rel]) => rel), ["services/tale/taleMgrService.js"], "a new destructuring = check when it binds");
    const tale = lf(destructuring[0][1]);
    const lazyLine = "    const { activeTales } = require(\"../incursion/incursionPresentation\");\n    return activeTales()\n      .filter(";
    assert.ok(tale.includes(lazyLine) && tale.split("activeTales").length - 1 === 2, "taleMgrService binds activeTales per call and only filters it");
    assert.ok(!/^const \{[^}]*\b(forSystem|activeTales|getTales)\b/m.test(tale), "no module-level destructuring");
    const compose = fs.readFileSync(COMPOSE, "utf8");
    assert.ok(compose.includes("      HOTPATH_INCURSION_TALES_MEMO: ${HOTPATH_INCURSION_TALES_MEMO:-0}"), "compose flag");
    assert.ok(compose.includes("      HOTPATH_INCURSION_TALES_MEMO_PARITY_CHECK: ${HOTPATH_INCURSION_TALES_MEMO_PARITY_CHECK:-0}"), "compose parity");
  });

  test("hotpathIncursion IT2 parity: forSystem/activeTales/getTales/context/shipModifiers/damageMultiplier/report = vendor we wszystkich krokach", () => {
    const off = withTree(src, {}, (tree) => {
      const t = openTree(tree, loader, base);
      assert.strictEqual(t.state.incursion, null);
      return scenario(t);
    });
    const memo = withTree(src, {}, (tree) => {
      const t = openTree(tree, loader, { ...on, incursionTalesMemoParityCheck: true });
      const steps = scenario(t);
      return { steps, snap: t.state.incursion.snapshot(), text: loader.incursionStateText(t.state) };
    });
    assert.deepStrictEqual(memo.steps, off, "result = vendor");
    assert.strictEqual(memo.text, "ready", "parity without differences");
    assert.ok(memo.snap.hits > 0 && memo.snap.fills >= 4 && memo.snap.parityChecks > 0, JSON.stringify(memo.snap));
    assert.strictEqual(off[1].forSystem[0].taleID, 1);
    assert.strictEqual(off[3].forSystem[0], null, "tale 1 terminal");
    assert.strictEqual(off[4].forSystem[3].taleID, 2, "tale 2 prepared");
    assert.strictEqual(off[5].forSystem[6].taleID, 4, "tale 4 in the new system");
    assert.ok(off[1].mods.length === 2 && off[1].dmg > 1, "effects of the active tale");
  });

  test("hotpathIncursion IT3 invalidation and cost: 1 clone per version, mutate/replace = new result, recovery as the vendor, read inside a reducer = passthrough", () => {
    const realClone = globalThis.structuredClone;
    let clones = 0;
    globalThis.structuredClone = (value) => { clones += 1; return realClone(value); };
    try {
      withTree(src, {}, (tree) => {
        const t = openTree(tree, loader, on);
        t.gameStore.write(TABLE, "/", seedState());
        t.presentation.forSystem(30001);
        assert.strictEqual(t.state.incursion.status().ready, true, loader.incursionStateText(t.state));
        clones = 0;
        t.presentation.forSystem(30001);
        assert.strictEqual(clones, 1, "fill = one clone");
        clones = 0;
        t.presentation.forSystem(30001);
        t.presentation.forSystem(30005);
        t.effects.shipModifiers(SHIP);
        assert.strictEqual(clones, 0, "no changes = zero clones");
        t.lifecycle().advanceBoundary(4, { terminal: { outcome: "defeated" } });
        clones = 0;
        assert.strictEqual(t.presentation.forSystem(30005), null, "new result after mutate");
        t.presentation.forSystem(30005);
        assert.strictEqual(clones, 1, "one clone after mutate");
        const next = seedState();
        t.gameStore.write(TABLE, "/", next);
        assert.strictEqual(t.presentation.forSystem(30005).taleID, 4, "root replaced from outside");
        const before = t.state.incursion.snapshot().passthrough;
        let inside;
        t.lifecycle().mutateWith((state) => { inside = t.presentation.forSystem(30001); state.nextSerial += 1; });
        assert.strictEqual(inside.taleID, 1);
        assert.strictEqual(t.state.incursion.snapshot().passthrough, before + 1, "passthrough inside mutate");
        t.gameStore.control.failWrite = true;
        assert.throws(() => t.lifecycle().advanceBoundary(1, { phase: "x" }), /Incursion lifecycle write failed/);
        assert.throws(() => t.presentation.forSystem(30001), /INCURSION_LIFECYCLE_STORE_RECOVERY_REQUIRED/);
        assert.throws(() => t.effects.shipModifiers(SHIP), /INCURSION_LIFECYCLE_STORE_RECOVERY_REQUIRED/);
        assert.strictEqual(loader.incursionStateText(t.state), "ready", "a vendor error does not disable the memo");
      });
    } finally {
      globalThis.structuredClone = realClone;
    }
  });

  test("hotpathIncursion IT4 freezing: tale deeply frozen, a write throws and does not change the result; getTales = new array", () => {
    withTree(src, {}, (tree) => {
      const t = openTree(tree, loader, on);
      t.gameStore.write(TABLE, "/", seedState());
      t.presentation.getTales();
      const tale = t.presentation.forSystem(30001);
      for (const v of [tale, tale.placement, tale.placement.systems, tale.placement.systems[0], tale.policy.presentation.effects[0]]) {
        assert.ok(Object.isFrozen(v));
      }
      assert.throws(() => { tale.phase = "x"; }, TypeError);
      assert.throws(() => { tale.placement.systems.push({ solarSystemID: 1 }); }, TypeError);
      assert.strictEqual(t.presentation.forSystem(30001).phase, "established");
      const a = t.presentation.getTales();
      const b = t.presentation.getTales();
      assert.notStrictEqual(a, b, "a new array on every call");
      assert.strictEqual(a[0], b[0], "the same frozen tales");
      a.length = 0;
      assert.strictEqual(t.presentation.getTales().length, 3, "changing the array copy does not break the memo (1, 3 terminal, 4)");
      assert.strictEqual(deepFreeze(null), null);
    });
  });

  test("hotpathIncursion IT5 flag and drift: off = vendor functions; changed text = disabled:drift; foreign wrapper = disabled:order; results = vendor", () => {
    const vendor = withTree(src, {}, (tree) => scenario(openTree(tree, loader, base)));
    withTree(src, {}, (tree) => {
      const t = openTree(tree, loader, base);
      for (const name of ["getTales", "activeTales", "forSystem"]) assert.strictEqual(t.presentation[name].__hotPathPerfIncursion, undefined);
      t.presentation.forSystem(30001);
      assert.strictEqual(require(path.join(tree.inc, "incursionLifecycleStore.js")).mutate.name, "mutate");
      assert.strictEqual(loader.incursionStateText(t.state), "off");
    });
    const drift = withTree(src, { presentationEdit: (text) => `${text} ` }, (tree) => {
      const t = openTree(tree, loader, on);
      const steps = scenario(t);
      assert.strictEqual(t.presentation.forSystem.__hotPathPerfIncursion, undefined, "no wrapper");
      t.state.gameSeen = true;
      assert.ok(/incursionTalesMemo disabled: drift/.test(loader.probeMessage(t.state)), loader.probeMessage(t.state));
      return { steps, text: loader.incursionStateText(t.state), lines: t.lines };
    });
    assert.strictEqual(drift.text, "disabled:drift");
    assert.ok(drift.lines.some((l) => l.startsWith("WARN incursionTalesMemo disabled: drift (incursionPresentation.js)")), drift.lines.join("|"));
    assert.deepStrictEqual(drift.steps, vendor);
    const order = withTree(src, {}, (tree) => {
      const previous = Module._load;
      Module._load = function foreignLoad() {
        const result = previous.apply(this, arguments);
        if (result && typeof result.forSystem === "function" && typeof result.buildSystemTalesDict === "function" && !result.forSystem.foreign) {
          const original = result.forSystem;
          const foreign = function foreignForSystem(systemID) { return original(systemID); };
          foreign.foreign = true;
          result.forSystem = foreign;
        }
        return result;
      };
      const t = openTree(tree, loader, on);
      return { steps: scenario(t), text: loader.incursionStateText(t.state) };
    });
    assert.strictEqual(order.text, "disabled:order");
    assert.deepStrictEqual(order.steps, vendor);
    const lazy = loader.createState(on, null, { log: () => {} });
    lazy.gameSeen = true;
    assert.strictEqual(loader.checkIncursionDrift(lazy), false);
    assert.ok(/incursionTalesMemo waiting/.test(loader.probeMessage(lazy)) && !/DRIFT/.test(loader.probeMessage(lazy)), loader.probeMessage(lazy));
    lazy.incursionTargetsSeen.add("incursionPresentation");
    assert.strictEqual(loader.checkIncursionDrift(lazy), true);
    assert.strictEqual(loader.incursionStateText(lazy), "disabled:drift");
  });

  test("hotpathIncursion IT6 261115.2 = obsolete: vendor readShared, flag on = no wrappers and no DRIFT, WARN once, results = vendor", () => {
    const lifecycle = lf(src("services/incursion/incursionLifecycle.js")).split("\n");
    assert.ok(lifecycle.includes(UPSTREAM_READ_TALES) && lifecycle.includes(UPSTREAM_LIST_TALES), "tree lines = vendor");
    const vendor = withTree(src, { upstream: true }, (tree) => scenario(openTree(tree, loader, base)));
    const memo = withTree(src, { upstream: true }, (tree) => {
      const t = openTree(tree, loader, on);
      const steps = scenario(t);
      for (const name of ["getTales", "activeTales", "forSystem"]) assert.strictEqual(t.presentation[name].__hotPathPerfIncursion, undefined, name);
      assert.strictEqual(require(path.join(tree.inc, "incursionLifecycleStore.js")).mutate.__hotPathPerfIncursion, undefined, "mutate");
      t.state.gameSeen = true;
      assert.strictEqual(loader.checkIncursionDrift(t.state), false);
      const probe = loader.probeMessage(t.state);
      assert.ok(!/DRIFT/.test(probe) && /incursionTalesMemo disabled: obsolete/.test(probe), probe);
      return { steps, text: loader.incursionStateText(t.state), lines: t.lines.filter((l) => l.includes("incursionTalesMemo")) };
    });
    assert.strictEqual(memo.text, "disabled:obsolete");
    assert.deepStrictEqual(memo.lines, ["WARN incursionTalesMemo disabled: obsolete (EveJS reads it itself: incursionLifecycleStore.readShared)"]);
    assert.deepStrictEqual(memo.steps, vendor);
    assert.strictEqual(vendor[1].forSystem[0].taleID, 1, "the scenario works on the 261115.2 tree");
  });
}

module.exports = { register };
