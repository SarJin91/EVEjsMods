"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const { createCareerStandingCorpMemo, fixedUpstream, FINGERPRINTS: CORP_FP, sha1Lf } = require("../lib/careerStandingCorpMemo");
const { LEGACY_CAREER_STANDING } = require("./fixtures/careerStanding261108");
const { createReprocessingReceiptRetire, FINGERPRINTS: RETIRE_FP, HOOK_NAME } = require("../lib/reprocessingReceiptRetire");
const { fingerprintFunctions } = require("../lib/blueprintOwnerRead");

const COMPOSE = path.resolve(__dirname, "../../../compose.yaml");
const CHARACTER_ID = 90000001;
const CORP_IDS = [1000125, 1000127, 500001];

function functionBody(text, name) {
  const lf = String(text).replace(/\r\n/g, "\n");
  const at = lf.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(at >= 0, name);
  const end = lf.indexOf("\n}\n", at);
  assert.ok(end > at, `${name} end`);
  return lf.slice(at, end + 2);
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function careerTree(src, { standingText } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpathCR-"));
  const services = path.join(root, "server", "src", "services");
  writeFile(path.join(services, "career", "careerStandingSources.js"),
    standingText !== undefined ? standingText : src("services/career/careerStandingSources.js"));
  writeFile(path.join(services, "career", "careerOwnerReads.js"), "\"use strict\";\n" +
    `const IDS = ${JSON.stringify(CORP_IDS)};\nconst receipts = {};\n` +
    "for (let i = 0; i < 12; i += 1) {\n" +
    "  receipts[`mission-reward:${i}:standing`] = { createdAt: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(),\n" +
    `    result: { appliedChanges: [{ toID: ${CHARACTER_ID}, fromID: IDS[i % 3], rawChange: 0.2, standing: 1.5 }] } };\n` +
    "}\nreceipts[\"gm-set:1\"] = { result: { appliedChanges: [] } };\n" +
    "function readDurablePath() { return { standingOperationReceipts: receipts }; }\nmodule.exports = { readDurablePath };\n");
  writeFile(path.join(services, "corporation", "corporationState.js"), "\"use strict\";\n" +
    "const counter = { ensure: 0 };\nconst NPC = new Set([1000125, 1000127]);\nconst CORPORATIONS_TABLE = \"corporations\";\n" +
    "function normalizePositiveInteger(value, fallback) {\n  const n = Math.trunc(Number(value));\n" +
    "  return Number.isFinite(n) && n > 0 ? n : fallback;\n}\n" +
    "function ensureCorporationsInitialized() { counter.ensure += 1; }\nfunction recoverAllianceAffiliations() {}\n" +
    "const database = { read(table, p) {\n  const id = Number(String(p).split(\"/\").pop());\n" +
    "  return NPC.has(id) ? { success: true, data: { corporationName: `c${id}`, isNPC: true, allianceID: 0 } } : { success: false };\n} };\n" +
    "function cloneValue(v) { return JSON.parse(JSON.stringify(v)); }\nfunction normalizeCorporationRecord(r) { return r; }\n" +
    "function getCorporationMemberCount(id) { return id % 7; }\n" +
    functionBody(src("services/corporation/corporationState.js"), "getCorporationRecord") + "\n" +
    "module.exports = { getCorporationRecord, counter };\n");
  return { root, services };
}

function retireTree(src) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpathRR-"));
  const srcRoot = path.join(root, "server", "src");
  writeFile(path.join(srcRoot, "gameStore", "index.js"), "\"use strict\";\nconst hooks = new Map();\n" +
    "function registerShutdownHook(name, fn) { hooks.set(name, fn); return () => hooks.delete(name); }\n" +
    "function isShutdownInProgress() { return false; }\nmodule.exports = { registerShutdownHook, isShutdownInProgress, hooks };\n");
  writeFile(path.join(srcRoot, "services", "inventory", "reprocessingItemCustody.js"), "\"use strict\";\nconst calls = [];\n" +
    "const itemCustody = { retireCommittedReceipts(keys) {\n  calls.push([...keys]);\n" +
    "  return { success: true, removed: keys.length, removedReceiptKeys: keys };\n} };\n" +
    functionBody(src("services/inventory/reprocessingItemCustody.js"), "retireReceipts") + "\n" +
    "module.exports = { retireReceipts, calls };\n");
  writeFile(path.join(srcRoot, "services", "reprocessing", "reprocessingSettlementState.js"),
    src("services/reprocessing/reprocessingSettlementState.js"));
  return { root, srcRoot };
}

function withTree(tree, fn) {
  const previous = Module._load;
  try {
    return fn(tree);
  } finally {
    Module._load = previous;
    for (const key of Object.keys(require.cache)) if (key.startsWith(tree.root)) delete require.cache[key];
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
}

function register(ctx) {
  const { test, src, listJs, loader, config, SERVER_SRC } = ctx;
  const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
  const base = { ...config, ...quiet, prewarmLocations: false };
  const definition = { source: { kind: "corporation-standing", minimum: 0.5 } };

  test("hotpathCareerReprocessing CR1 corporation memo: off 12 vendor calls, on 3, the same observe result, memo cleared after observe", () => {
    const run = (flag) => withTree(careerTree(src, { standingText: LEGACY_CAREER_STANDING }), (tree) => {
      const lines = [];
      const state = loader.createState({ ...base, careerStandingCorpMemo: flag }, null, { log: (l) => lines.push(l) });
      loader.installHook(state);
      const standing = require(path.join(tree.services, "career", "careerStandingSources.js"));
      const result = standing.observe(CHARACTER_ID, {}, definition, {});
      const corps = require(path.join(tree.services, "corporation", "corporationState.js"));
      const inScope = corps.counter.ensure;
      const after = corps.getCorporationRecord(CORP_IDS[0]);
      return { state, lines, standing, corps, result, inScope, after, afterCount: corps.counter.ensure };
    });
    const off = run(false);
    assert.strictEqual(off.state.careerStandingMemo, null);
    assert.strictEqual(off.standing.observe.__hotPathPerfCareerStanding, undefined);
    assert.strictEqual(off.inScope, 12, "flag off: a vendor call on every change");
    assert.strictEqual(loader.careerStandingStateText(off.state), "off");

    const on = run(true);
    assert.ok(on.standing.observe.__hotPathPerfCareerStanding, "observe wrapped");
    assert.ok(on.corps.getCorporationRecord.__hotPathPerfCorpMemo, "getCorporationRecord wrapped");
    assert.strictEqual(on.inScope, 3, "flag on: one vendor call per unique corporation");
    assert.deepStrictEqual(on.result, off.result, "observe result unchanged");
    assert.strictEqual(on.result.progress, 1);
    assert.strictEqual(on.afterCount, 4, "outside observe: vendor (memo cleared)");
    assert.deepStrictEqual(on.after, off.after);
    assert.deepStrictEqual(on.state.careerStandingMemo.takeStats(), { observes: 1, calls: 12, vendorCalls: 3, hits: 9, parityChecks: 0 });
    for (const symbol of loader.CAREER_STANDING_REQUIRED) assert.ok(on.state.patched.has(symbol), symbol);
    on.state.gameSeen = true;
    assert.strictEqual(loader.checkCareerReprocessingDrift(on.state), false);
    assert.strictEqual(loader.careerStandingStateText(on.state), "on");
    assert.ok(/^probe: passed \(2 /.test(loader.probeMessage(on.state)), loader.probeMessage(on.state));
    assert.deepStrictEqual(on.lines.filter((l) => l.includes("WARN")), []);
  });

  test("hotpathCareerReprocessing CR2 parity: another memberCount = disabled:parity and a fresh result; changed text = drift, no wrapper", () => {
    const lines = [];
    const memo = createCareerStandingCorpMemo({ config: { careerStandingCorpMemoParityCheck: true }, log: (l) => lines.push(l) });
    let n = 0;
    const vendor = memo.wrapGetCorporationRecord(function getCorporationRecord(id) {
      n += 1;
      return { corporationID: id, isNPC: true, memberCount: n };
    });
    const observe = memo.wrapObserve(function observe() {
      return [vendor(7), vendor(7)];
    });
    const [first, second] = observe();
    assert.strictEqual(first.memberCount, 1);
    assert.strictEqual(second.memberCount, 2, "returns the fresh vendor result");
    assert.strictEqual(memo.status().disabledReason, "parity");
    assert.ok(lines.some((l) => l.startsWith("WARN careerStandingCorpMemo disabled: parity")), lines.join("|"));
    assert.strictEqual(observe()[1].memberCount, 4);

    const real = LEGACY_CAREER_STANDING;
    const drift = withTree(careerTree(src, { standingText: `${real}\n// changed\n` }), (tree) => {
      const state = loader.createState({ ...base, careerStandingCorpMemo: true }, null, { log: () => {} });
      loader.installHook(state);
      const standing = require(path.join(tree.services, "career", "careerStandingSources.js"));
      standing.observe(CHARACTER_ID, {}, definition, {});
      const corps = require(path.join(tree.services, "corporation", "corporationState.js"));
      return { state, standing, corps };
    });
    assert.strictEqual(drift.state.careerStandingMemo.status().disabledReason, "drift");
    assert.strictEqual(drift.standing.observe.__hotPathPerfCareerStanding, undefined, "observe not wrapped");
    assert.strictEqual(drift.corps.getCorporationRecord.__hotPathPerfCorpMemo, undefined, "getCorporationRecord not wrapped");
    assert.strictEqual(drift.corps.counter.ensure, 12, "vendor");
    assert.strictEqual(loader.careerStandingStateText(drift.state), "disabled:drift");
    const fresh = createCareerStandingCorpMemo({ config: {}, log: () => {} });
    assert.strictEqual(fresh.checkSource("careerStanding", real), true);
    assert.strictEqual(fresh.checkSource("careerStanding", real.replace("corps.getCorporationRecord(", "corps.x(")), false);
    assert.strictEqual(fresh.status().disabledReason, "drift");
  });

  test("hotpathCareerReprocessing CR3 261115.2 = obsolete: vendor standingEvidence (3 calls), flag on = no wrappers and no DRIFT, WARN once", () => {
    const real = src("services/career/careerStandingSources.js");
    assert.strictEqual(fixedUpstream(real), true);
    assert.strictEqual(fixedUpstream(LEGACY_CAREER_STANDING), false);
    assert.strictEqual(sha1Lf(LEGACY_CAREER_STANDING), CORP_FP.careerStanding, "fikstura = tekst 261108.1");
    const run = (flag) => withTree(careerTree(src), (tree) => {
      const lines = [];
      const state = loader.createState({ ...base, careerStandingCorpMemo: flag }, null, { log: (l) => lines.push(l) });
      loader.installHook(state);
      const corps = require(path.join(tree.services, "corporation", "corporationState.js"));
      const standing = require(path.join(tree.services, "career", "careerStandingSources.js"));
      const result = standing.observe(CHARACTER_ID, {}, definition, {});
      return { state, lines, standing, corps, result, inScope: corps.counter.ensure };
    });
    const off = run(false);
    assert.strictEqual(off.inScope, 3, "vendor 261115.2 alone: one call per unique corporation");
    const on = run(true);
    assert.deepStrictEqual(on.result, off.result);
    assert.strictEqual(on.inScope, 3);
    assert.strictEqual(on.standing.observe.__hotPathPerfCareerStanding, undefined, "observe not wrapped");
    assert.strictEqual(on.corps.getCorporationRecord.__hotPathPerfCorpMemo, undefined, "getCorporationRecord not wrapped");
    assert.strictEqual(loader.careerStandingStateText(on.state), "disabled:obsolete");
    assert.deepStrictEqual(on.lines.filter((l) => l.includes("careerStandingCorpMemo")),
      ["WARN careerStandingCorpMemo disabled: obsolete (EveJS reads it itself: careerStandingSources.standingEvidence)"]);
    on.state.gameSeen = true;
    assert.strictEqual(loader.checkCareerReprocessingDrift(on.state), false);
    assert.ok(!/DRIFT/.test(loader.probeMessage(on.state)), loader.probeMessage(on.state));
  });

  test("hotpathCareerReprocessing RR1 deferral: 3 retires = 0 vendor calls and success, timer = 1 call with the union without duplicates", () => {
    const run = (flag) => withTree(retireTree(src), (tree) => {
      const lines = [];
      const timers = [];
      const state = loader.createState({ ...base, reprocessingReceiptRetireDefer: flag }, null, {
        log: (l) => lines.push(l), receiptRetireSetTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        receiptRetireClearTimer: () => {},
      });
      loader.installHook(state);
      const store = require(path.join(tree.srcRoot, "gameStore", "index.js"));
      const custody = require(path.join(tree.srcRoot, "services", "inventory", "reprocessingItemCustody.js"));
      const results = [["a", "b"], ["b", "c"], ["c", "d"]].map((keys) => custody.retireReceipts(keys));
      const before = custody.calls.length;
      if (timers.length > 0) timers[0].fn();
      return { state, lines, timers, store, custody, results, before };
    });
    const off = run(false);
    assert.strictEqual(off.state.receiptRetire, null);
    assert.strictEqual(off.before, 3, "flag off: vendor on every call");
    assert.strictEqual(off.results[0].removed, 2);
    assert.strictEqual(loader.receiptRetireStateText(off.state), "off");

    const on = run(true);
    assert.ok(on.custody.retireReceipts.__hotPathPerfReceiptRetire, "retireReceipts wrapped");
    assert.strictEqual(on.before, 0, "original 0× before the timer");
    for (const r of on.results) assert.strictEqual(r.success, true);
    assert.deepStrictEqual(on.results[1], { success: true, removed: 0, removedReceiptKeys: [], deferred: 2 });
    assert.strictEqual(on.timers.length, 1, "one timer per window");
    assert.strictEqual(on.timers[0].ms, 30000);
    assert.deepStrictEqual(on.custody.calls, [["a", "b", "c", "d"]], "1× with the union without duplicates");
    assert.deepStrictEqual(on.state.receiptRetire.flush("timer"), { success: true, keys: 0 }, "empty flush = no-op");
    assert.strictEqual(on.custody.calls.length, 1);
    assert.ok(on.store.hooks.has(HOOK_NAME), "shutdown hook registered");
    const stats = on.state.receiptRetire.takeStats();
    assert.strictEqual(stats.deferredCalls, 3);
    assert.strictEqual(stats.keys, 6);
    assert.strictEqual(stats.flushes, 1);
    assert.strictEqual(stats.flushFailures, 0);
    assert.strictEqual(stats.pending, 0);
    for (const symbol of loader.RECEIPT_RETIRE_REQUIRED) assert.ok(on.state.patched.has(symbol), symbol);
    on.state.gameSeen = true;
    assert.strictEqual(loader.checkCareerReprocessingDrift(on.state), false);
    assert.strictEqual(loader.receiptRetireStateText(on.state), "on");
    assert.ok(/^probe: passed \(2 /.test(loader.probeMessage(on.state)), loader.probeMessage(on.state));
  });

  test("hotpathCareerReprocessing RR2 limit, shutdown and failure: limit flush at once, the hook flushes the rest, exception = dropped without retry", () => {
    const lines = [];
    const timers = [];
    const hooks = new Map();
    const retire = createReprocessingReceiptRetire({
      config: { reprocessingReceiptRetireDelayMs: 1000, reprocessingReceiptRetireMaxPendingKeys: 100 },
      log: (l) => lines.push(l), setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
    });
    assert.strictEqual(retire.setStoreDeps({ registerShutdownHook: (name, fn) => hooks.set(name, fn), isShutdownInProgress: () => false }), true);
    const calls = [];
    let fail = false;
    const wrapped = retire.wrapRetire(function retireReceipts(keys) {
      calls.push(keys.length);
      if (fail) throw new Error("boom");
      return { success: true, removed: keys.length };
    });
    const many = Array.from({ length: 101 }, (_, i) => `k${i}`);
    assert.strictEqual(wrapped(many).success, true);
    assert.deepStrictEqual(calls, [101], "limit: flush at once");
    assert.strictEqual(retire.status().pending, 0);
    wrapped(["x", "y"]);
    assert.deepStrictEqual(calls, [101], "below the limit: deferred");
    hooks.get(HOOK_NAME)();
    assert.deepStrictEqual(calls, [101, 2], "shutdown flushes the rest");
    fail = true;
    wrapped(["z"]);
    timers[timers.length - 1]();
    assert.deepStrictEqual(calls, [101, 2, 1]);
    const stats = retire.takeStats();
    assert.strictEqual(stats.flushFailures, 1);
    assert.strictEqual(stats.pending, 0);
    assert.strictEqual(lines.filter((l) => l.startsWith("WARN reprocessingReceiptRetireDefer flush failed")).length, 1, lines.join("|"));
    assert.deepStrictEqual(retire.flush("timer"), { success: true, keys: 0 }, "no retry");
    assert.deepStrictEqual(calls, [101, 2, 1]);
    fail = false;
    wrapped("not-an-array");
    assert.deepStrictEqual(calls, [101, 2, 1, "not-an-array".length]);
  });

  test("hotpathCareerReprocessing VF vendor facts: consumers through the module object, one retire call, boot prune, fingerprints, compose", () => {
    const owner = src("services/career/careerOwnerSources.js");
    assert.ok(owner.includes("require(\"./careerStandingSources\").observe("), "careerOwnerSources through the module object");
    const standing = src("services/career/careerStandingSources.js");
    assert.ok(standing.includes("corps.getCorporationRecord("), "getCorporationRecord through the module object");
    const settlement = src("services/reprocessing/reprocessingSettlementState.js").replace(/\r\n/g, "\n");
    assert.strictEqual(settlement.split("reprocessingItemCustody.retireReceipts(").length - 1, 1, "one retire call");
    const reconcile = functionBody(settlement.replace(/^async function reconcileDurable/m, "function reconcileDurable"),
      "reconcileDurableReprocessingSettlements");
    assert.ok(reconcile.includes("pruneFinishedOperationReceipts()"), "boot prune in reconcile");
    const files = listJs(SERVER_SRC);
    const users = files.filter((f) => fs.readFileSync(f, "utf8").includes("retireReceipts"))
      .map((f) => path.relative(SERVER_SRC, f).replace(/\\/g, "/")).sort();
    assert.deepStrictEqual(users, ["services/inventory/reprocessingItemCustody.js", "services/reprocessing/reprocessingSettlementState.js"]);
    for (const f of files) assert.ok(!fs.readFileSync(f, "utf8").includes("{ retireReceipts"), f);
    assert.notStrictEqual(sha1Lf(standing), CORP_FP.careerStanding);
    assert.strictEqual(fixedUpstream(standing), true);
    assert.strictEqual(fingerprintFunctions(src("services/corporation/corporationState.js"), ["getCorporationRecord"])
      .get("getCorporationRecord"), CORP_FP.corporationState.getCorporationRecord);
    assert.strictEqual(fingerprintFunctions(src("services/inventory/reprocessingItemCustody.js"), ["retireReceipts"])
      .get("retireReceipts"), RETIRE_FP.custody.retireReceipts);
    const st = fingerprintFunctions(settlement, Object.keys(RETIRE_FP.settlement));
    for (const [name, sha] of Object.entries(RETIRE_FP.settlement)) assert.strictEqual(st.get(name), sha, name);
    const compose = fs.readFileSync(COMPOSE, "utf8");
    for (const line of [
      "      HOTPATH_CAREER_STANDING_CORP_MEMO: ${HOTPATH_CAREER_STANDING_CORP_MEMO:-0}",
      "      HOTPATH_CAREER_STANDING_CORP_MEMO_PARITY: ${HOTPATH_CAREER_STANDING_CORP_MEMO_PARITY:-0}",
      "      HOTPATH_REPROCESSING_RECEIPT_RETIRE_DEFER: ${HOTPATH_REPROCESSING_RECEIPT_RETIRE_DEFER:-0}",
      "      HOTPATH_REPROCESSING_RECEIPT_RETIRE_DELAY_MS: ${HOTPATH_REPROCESSING_RECEIPT_RETIRE_DELAY_MS:-}",
      "      HOTPATH_REPROCESSING_RECEIPT_RETIRE_MAX_PENDING_KEYS: ${HOTPATH_REPROCESSING_RECEIPT_RETIRE_MAX_PENDING_KEYS:-}",
    ]) assert.ok(compose.includes(line), line);
  });
}

module.exports = { register };
