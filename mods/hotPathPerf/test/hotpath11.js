"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const { createSchedulerQueue, VENDOR_DEFAULT_MAX_PENDING, VENDOR_DEFAULT_REQUEST_TIMEOUT_MS } = require("../lib/schedulerQueue");
const { loadConfig, SCHEDULER_MAX_PENDING_CAP, SCHEDULER_REQUEST_TIMEOUT_CAP_MS } = require("../config");

const MISSING = path.join(__dirname, "missing.json");

function fakeTree(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath11-"));
  const src = path.join(root, "server", "src");
  const shared = path.join(src, "services", "_shared");
  const scheduler = path.join(src, "services", "scheduler");
  const account = path.join(src, "services", "account");
  for (const dir of [shared, scheduler, account]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(shared, "orderedProcessClient.js"),
    "\"use strict\";\nconst seen = [];\nfunction createOrderedProcessClient(options = {}, extra) {\n" +
    "  seen.push({ options, extra, self: this });\n  return { client: options.authorityName };\n}\n" +
    (options.frozen ? "module.exports = Object.freeze({ createOrderedProcessClient, seen });\n"
      : "module.exports = { createOrderedProcessClient, seen };\n"));
  fs.writeFileSync(path.join(scheduler, "durableScheduler.js"),
    "\"use strict\";\nconst path = require(\"node:path\");\n" +
    "const { createOrderedProcessClient } = require(path.join(__dirname, \"../_shared/orderedProcessClient\"));\n" +
    "const onEvent = () => \"event\";\n" +
    "module.exports = { client: createOrderedProcessClient({ authorityName: \"scheduler\", maxPending: 256, onEvent }, \"x\"), onEvent };\n");
  fs.writeFileSync(path.join(account, "walletAuthorityTransport.js"),
    "\"use strict\";\nconst { createOrderedProcessClient } = require(\"../_shared/orderedProcessClient\");\n" +
    "module.exports = { client: createOrderedProcessClient({ authorityName: \"wallet\", maxPending: 256 }) };\n");
  return { root, src, shared, scheduler, account };
}

function withHook(sq, tree, fn) {
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
  const { test, src, loader } = ctx;
  const { installSchedulerQueueHook, schedulerQueueTargetOf } = loader;

  test("Q1 config schedulerMaxPending: default 4096, env, 0, invalid value = default, > cap clamped with WARN", () => {
    assert.strictEqual(loadConfig({ env: {}, settingsPath: MISSING }).schedulerMaxPending, 4096);
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_MAX_PENDING: "8192" }, settingsPath: MISSING }).schedulerMaxPending, 8192);
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_MAX_PENDING: "0" }, settingsPath: MISSING }).schedulerMaxPending, 0);
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_MAX_PENDING: "-5" }, settingsPath: MISSING }).schedulerMaxPending, 4096);
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_MAX_PENDING: "abc" }, settingsPath: MISSING }).schedulerMaxPending, 4096);
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_MAX_PENDING: "5000.7" }, settingsPath: MISSING }).schedulerMaxPending, 5000);
    const warns = [];
    const capped = loadConfig({ env: { HOTPATH_SCHEDULER_MAX_PENDING: "999999" }, settingsPath: MISSING, warn: (m) => warns.push(m) });
    assert.strictEqual(capped.schedulerMaxPending, SCHEDULER_MAX_PENDING_CAP);
    assert.ok(warns.some((m) => /schedulerMaxPending=999999 capped to 65536/.test(m)), warns.join("|"));
  });

  test("Q2 adjustOptions: only authority=scheduler and only upwards; other options unchanged; 0 = nothing", () => {
    const lines = [];
    const sq = createSchedulerQueue({ limit: 4096, log: (l) => lines.push(l) });
    const onEvent = () => 1;
    const opts = { authorityName: " scheduler ", maxPending: 256, onEvent, requestTimeoutMs: 10000 };
    const out = sq.adjustOptions(opts);
    assert.notStrictEqual(out, opts);
    assert.deepStrictEqual(out, { ...opts, maxPending: 4096 });
    assert.strictEqual(out.onEvent, onEvent);
    assert.strictEqual(opts.maxPending, 256, "original options are not mutated");
    assert.deepStrictEqual(lines, ["scheduler queue: maxPending 256 -> 4096 (authority=scheduler)"]);
    for (const name of ["wallet", "chat-edge", "game-edge", "image-edge", "schedulerX", ""]) {
      const o = { authorityName: name, maxPending: 256 };
      assert.strictEqual(sq.adjustOptions(o), o, name);
    }
    const big = { authorityName: "scheduler", maxPending: 10000 };
    assert.strictEqual(sq.adjustOptions(big), big, "does not lower");
    assert.strictEqual(sq.adjustOptions({ authorityName: "scheduler" }).maxPending, 4096);
    assert.strictEqual(VENDOR_DEFAULT_MAX_PENDING, 128);
    const off = createSchedulerQueue({ limit: 0 });
    const o = { authorityName: "scheduler", maxPending: 256 };
    assert.strictEqual(off.adjustOptions(o), o);
    assert.strictEqual(off.patchExports({ createOrderedProcessClient() {} }), false);
    assert.strictEqual(sq.stats.adjusted, 2);
  });

  test("Q3 hook: durableScheduler destructures the wrapped export (4096), wallet unchanged, original's arguments and result", () => {
    const tree = fakeTree();
    const lines = [];
    const sq = createSchedulerQueue({ limit: 4096, log: (l) => lines.push(l) });
    withHook(sq, tree, () => {
      installSchedulerQueueHook(sq);
      const ds = require(path.join(tree.scheduler, "durableScheduler.js"));
      const wallet = require(path.join(tree.account, "walletAuthorityTransport.js"));
      const opc = require(path.join(tree.shared, "orderedProcessClient.js"));
      assert.deepStrictEqual(ds.client, { client: "scheduler" });
      assert.strictEqual(opc.seen.length, 2);
      assert.strictEqual(opc.seen[0].options.maxPending, 4096);
      assert.strictEqual(opc.seen[0].options.onEvent, ds.onEvent);
      assert.strictEqual(opc.seen[0].extra, "x", "second argument passes through");
      assert.strictEqual(opc.seen[1].options.maxPending, 256, "wallet unchanged");
      assert.strictEqual(sq.stats.wrapped, true);
      const wrapped = opc.createOrderedProcessClient;
      assert.strictEqual(sq.patchExports(opc), true);
      assert.strictEqual(opc.createOrderedProcessClient, wrapped);
      assert.ok(!lines.some((l) => /DRIFT/.test(l)), lines.join("|"));
    });
  });

  test("Q4 order: orderedProcessClient cached before the hook is still wrapped before destructuring; frozen export = DRIFT once", () => {
    const tree = fakeTree();
    const sq = createSchedulerQueue({ limit: 4096 });
    withHook(sq, tree, () => {
      require(path.join(tree.shared, "orderedProcessClient.js"));
      installSchedulerQueueHook(sq);
      require(path.join(tree.scheduler, "durableScheduler.js"));
      const opc = require(path.join(tree.shared, "orderedProcessClient.js"));
      assert.strictEqual(opc.seen[0].options.maxPending, 4096);
    });
    const frozen = fakeTree({ frozen: true });
    const lines = [];
    const sq2 = createSchedulerQueue({ limit: 4096, log: (l) => lines.push(l) });
    withHook(sq2, frozen, () => {
      installSchedulerQueueHook(sq2);
      require(path.join(frozen.scheduler, "durableScheduler.js"));
      const opc = require(path.join(frozen.shared, "orderedProcessClient.js"));
      assert.strictEqual(opc.seen[0].options.maxPending, 256, "vendor unchanged");
      assert.strictEqual(sq2.checkDrift(), null, "DRIFT only once");
    });
    assert.strictEqual(lines.filter((l) => /^DRIFT: orderedProcessClient\.createOrderedProcessClient/.test(l)).length, 1, lines.join("|"));
    assert.strictEqual(schedulerQueueTargetOf("C:\\x\\server\\src\\services\\_shared\\orderedProcessClient.js"), "orderedProcessClient");
    assert.strictEqual(schedulerQueueTargetOf("/app/server/src/services/scheduler/durableScheduler.js"), "durableScheduler");
    assert.strictEqual(schedulerQueueTargetOf("/app/server/src/services/scheduler/durableSchedulerBinding.js"), null);
  });

  test("Q5 vendor facts: scheduler client 256 without env, destructuring at require, limit and error code, wallet/edge other names", () => {
    const ds = src("services/scheduler/durableScheduler.js");
    assert.ok(/const \{ createOrderedProcessClient \} = require\(path\.join\(\s*__dirname,\s*"\.\.\/_shared\/orderedProcessClient",?\s*\)\);/.test(ds));
    assert.ok(ds.includes("options.orderedProcessClientFactory || createOrderedProcessClient;"));
    assert.ok(ds.includes("authorityName: \"scheduler\","));
    assert.ok(ds.includes("maxPending: options.maxPending || 256,"));
    assert.ok(ds.includes("await call(\"validateLease\", {"));
    const opc = src("services/_shared/orderedProcessClient.js");
    assert.ok(opc.includes("const DEFAULT_MAX_PENDING = 128;"));
    assert.ok(opc.includes("const maxPending = positiveInteger(options.maxPending, DEFAULT_MAX_PENDING);"));
    assert.ok(opc.includes("if (pending.size >= maxPending) {"));
    assert.ok(opc.includes("\"AUTHORITY_OVERLOADED\""));
    assert.ok(/module\.exports = \{\s*createOrderedProcessClient,/.test(opc));
    assert.ok(src("services/account/walletAuthorityTransport.js").includes("authorityName: \"wallet\","));
    for (const name of ["chat", "game", "gateway", "image", "redshift"]) {
      assert.ok(src(`edge/${name}/${name}EdgeRuntime.js`).includes(`const AUTHORITY_NAME = "${name}-edge";`), name);
    }
    assert.ok(src("../bootstrap.js").includes("[Startup] Failed while starting production owners"));
  });

  test("Q6 requestTimeoutMs: config (120000, 0, cap 600000), only scheduler and upwards, one line, hook without maxPending", () => {
    assert.strictEqual(loadConfig({ env: {}, settingsPath: MISSING }).schedulerRequestTimeoutMs, 120000);
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_REQUEST_TIMEOUT_MS: "0" }, settingsPath: MISSING }).schedulerRequestTimeoutMs, 0);
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_REQUEST_TIMEOUT_MS: "-1" }, settingsPath: MISSING }).schedulerRequestTimeoutMs, 120000);
    const warns = [];
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_REQUEST_TIMEOUT_MS: "9000000" }, settingsPath: MISSING,
      warn: (m) => warns.push(m) }).schedulerRequestTimeoutMs, SCHEDULER_REQUEST_TIMEOUT_CAP_MS);
    assert.ok(warns.some((m) => /schedulerRequestTimeoutMs=9000000 capped to 600000/.test(m)), warns.join("|"));
    const lines = [];
    const sq = createSchedulerQueue({ limit: 4096, requestTimeoutMs: 120000, log: (l) => lines.push(l) });
    const out = sq.adjustOptions({ authorityName: "scheduler", maxPending: 256, requestTimeoutMs: 10000, startupTimeoutMs: 7 });
    assert.deepStrictEqual(out, { authorityName: "scheduler", maxPending: 4096, requestTimeoutMs: 120000, startupTimeoutMs: 7 });
    assert.deepStrictEqual(lines, ["scheduler queue: maxPending 256 -> 4096, requestTimeoutMs 10000 -> 120000 (authority=scheduler)"]);
    const wallet = { authorityName: "wallet", requestTimeoutMs: 10000 };
    assert.strictEqual(sq.adjustOptions(wallet), wallet);
    const high = { authorityName: "scheduler", maxPending: 9999, requestTimeoutMs: 300000 };
    assert.strictEqual(sq.adjustOptions(high), high, "does not lower");
    assert.strictEqual(sq.adjustOptions({ authorityName: "scheduler" }).requestTimeoutMs, 120000, "missing = vendor 15000 -> 120000");
    assert.strictEqual(VENDOR_DEFAULT_REQUEST_TIMEOUT_MS, 15000);
    const tree = fakeTree();
    const only = createSchedulerQueue({ limit: 0, requestTimeoutMs: 120000 });
    withHook(only, tree, () => {
      installSchedulerQueueHook(only);
      require(path.join(tree.scheduler, "durableScheduler.js"));
      const opc = require(path.join(tree.shared, "orderedProcessClient.js"));
      assert.strictEqual(opc.seen[0].options.maxPending, 256);
      assert.strictEqual(opc.seen[0].options.requestTimeoutMs, 120000);
    });
    const ds = src("services/scheduler/durableScheduler.js");
    assert.ok(ds.includes("requestTimeoutMs: options.requestTimeoutMs || 10_000,"));
    const opcSrc = src("services/_shared/orderedProcessClient.js");
    assert.ok(opcSrc.includes("const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;"));
    assert.ok(opcSrc.includes("const elapsedMs = Date.now() - entry.submittedAtMs;"), "timeout counted from sending");
  });
}

module.exports = { register };
