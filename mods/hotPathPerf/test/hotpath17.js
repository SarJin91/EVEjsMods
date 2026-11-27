"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const { createSchedulerDueGate, parseGateTypes, VENDOR_LEASE_MS } = require("../lib/schedulerDueGate");
const { createSchedulerQueue, RUNTIME_WRAPPED } = require("../lib/schedulerQueue");
const { loadConfig, DEFAULTS, SCHEDULER_DUE_GATE_RANGES } = require("../config");

const MISSING = path.join(__dirname, "missing.json");
const T0 = 1_700_000_000_000;

function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const handle = { at: t + Math.max(0, ms), fn, id: seq++ };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      const i = timers.indexOf(handle);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

const resolved = (value) => ({ then: (ok) => resolved(ok ? ok(value) : value) });
const rejected = (error) => ({ then: (_ok, err) => (err ? resolved(err(error)) : rejected(error)) });

function dueEvent(jobID, type, leaseUntilMs, leaseToken = `${jobID}#1`) {
  return Object.freeze({ authorityName: "scheduler", generation: 1, topic: "scheduler.due", sequence: 1,
    payload: { jobID, type, dueAtMs: T0 - 30 * 86400000, payload: {}, attempt: 1, leaseToken, leaseUntilMs } });
}

function gateOptions(clock, extra = {}) {
  return { types: ["ess.settlement", "sovereignty.campaign-tick"], releaseDelayMs: 30000, maxHoldMs: 300000,
    pumpIntervalMs: 100, batch: 8, maxInFlight: 2, minLeaseLeftMs: 10000, staleDropMs: 120000, maxHeld: 100000,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...extra };
}

function essJobIDs() {
  const ids = [];
  for (let sys = 0; sys < 1000; sys += 1) for (let k = 0; k < 7; k += 1) ids.push(`ess:${30000000 + sys}:${k}`);
  return ids;
}

function fakeTree(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath17-"));
  const src = path.join(root, "server", "src");
  const shared = path.join(src, "services", "_shared");
  const scheduler = path.join(src, "services", "scheduler");
  const bounty = path.join(src, "services", "bounty");
  for (const dir of [shared, scheduler, bounty]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(shared, "orderedProcessClient.js"),
    "\"use strict\";\nconst seen = [];\nfunction createOrderedProcessClient(options = {}) {\n" +
    "  const calls = [];\n  const client = Object.freeze({ call: (c, p) => { calls.push([c, p]); return { then: (ok) => ok && ok(c) }; },\n" +
    "    drain() {}, getStats: () => ({}), shutdown() {}, start() {} });\n" +
    "  seen.push({ options, client, calls });\n  return client;\n}\nmodule.exports = { createOrderedProcessClient, seen };\n");
  fs.writeFileSync(path.join(scheduler, "durableScheduler.js"),
    "\"use strict\";\nconst path = require(\"node:path\");\n" +
    "const { createOrderedProcessClient } = require(path.join(__dirname, \"../_shared/orderedProcessClient\"));\n" +
    "const made = [];\nfunction createDurableScheduler() {\n  const events = [];\n  const onEvent = (e) => events.push(e);\n" +
    "  const client = createOrderedProcessClient({ authorityName: \"scheduler\", maxPending: 256, onEvent });\n" +
    "  const s = { client, onEvent, events };\n  made.push(s);\n  return s;\n}\nmodule.exports = { createDurableScheduler, made };\n");
  fs.writeFileSync(path.join(scheduler, "productionSchedulerRuntime.js"),
    "\"use strict\";\nconst { createDurableScheduler } = require(\"./durableScheduler\");\n" +
    "function createProductionSchedulerRuntime(options = {}) {\n  const scheduler = createDurableScheduler();\n" +
    "  return Object.freeze({ getState: () => \"idle\", shutdown: () => \"down\", start: () => options.startResult });\n}\n" +
    (options.frozen ? "module.exports = Object.freeze({ createProductionSchedulerRuntime });\n"
      : "module.exports = { createProductionSchedulerRuntime };\n"));
  fs.writeFileSync(path.join(bounty, "npcBountySchedulerRuntime.js"),
    "\"use strict\";\nconst path = require(\"node:path\");\n" +
    "const { createDurableScheduler } = require(path.join(__dirname, \"../scheduler/durableScheduler\"));\n" +
    "module.exports = { createNpcBountySchedulerRuntime: () => createDurableScheduler() };\n");
  return { root, src, shared, scheduler, bounty };
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
  const { test, src, loader } = ctx;
  const { installSchedulerQueueHook, schedulerQueueTargetOf, createDueGateOf } = loader;

  test("hotpath17 G1 hold and dedup (30 days): 7000 ess.settlement + 20 repeated leases held, a type outside the list at once", () => {
    const clock = fakeClock();
    const gate = createSchedulerDueGate(gateOptions(clock));
    const seen = [];
    let onEvent = null;
    gate.capture(() => {
      assert.strictEqual(gate.capturing(), true);
      onEvent = gate.wrapOnEvent((e) => seen.push(e));
    });
    assert.strictEqual(gate.capturing(), false);
    assert.strictEqual(gate.mode(), "holding");
    const ids = essJobIDs();
    for (const id of ids) onEvent(dueEvent(id, "ess.settlement", T0 + VENDOR_LEASE_MS));
    clock.advance(30000);
    for (const id of ids.slice(0, 20)) onEvent(dueEvent(id, "ess.settlement", clock.now() + VENDOR_LEASE_MS, `${id}#2`));
    const market = dueEvent("market:1", "market-order.expire", clock.now() + VENDOR_LEASE_MS);
    onEvent(market);
    onEvent(Object.freeze({ topic: "scheduler.other", payload: { jobID: "x", type: "ess.settlement" } }));
    assert.strictEqual(seen.length, 2, "only market-order.expire and another topic");
    assert.strictEqual(seen[0], market);
    const s = gate.stats();
    assert.strictEqual(s.held, 7000);
    assert.strictEqual(s.replaced, 20);
    assert.strictEqual(s.released, 0);
    assert.deepStrictEqual(parseGateTypes(DEFAULTS.schedulerDueGateTypes).types,
      ["ess.settlement", "sovereignty.campaign-tick"]);
  });

  test("hotpath17 G2 pump: inFlight <= maxInFlight, 7000 exactly once, a short lease waits, stale removed, then passthrough", () => {
    const clock = fakeClock();
    const lines = [];
    const gate = createSchedulerDueGate(gateOptions(clock, { log: (l) => lines.push(l) }));
    const delivered = new Map();
    const pendingAck = [];
    let client = null;
    const vendorOnEvent = (event) => {
      const { jobID, leaseToken } = event.payload;
      delivered.set(jobID, (delivered.get(jobID) || 0) + 1);
      client.call("validateLease", { jobID, leaseToken });
      pendingAck.push({ jobID, leaseToken });
    };
    let onEvent = null;
    gate.capture(() => {
      onEvent = gate.wrapOnEvent(vendorOnEvent);
      client = gate.wrapClient(Object.freeze({ call: () => resolved({ ok: true }), start() {}, shutdown() {} }));
    });
    const far = T0 + 10 * 3600000;
    for (const id of essJobIDs()) onEvent(dueEvent(id, "ess.settlement", far));
    gate.open("owners_ready");
    const openAt = clock.now();
    onEvent(dueEvent("ess:short", "ess.settlement", openAt + 30000 + 5000));
    onEvent(dueEvent("ess:stale", "ess.settlement", openAt - 120001));
    assert.strictEqual(gate.mode(), "open");
    clock.advance(29999);
    assert.strictEqual(delivered.size, 0, "nothing before releaseDelayMs");
    let maxInFlight = 0;
    let steps = 0;
    let shortRenewed = false;
    while (gate.mode() === "open" && steps < 20000) {
      for (const ack of pendingAck.splice(0)) client.call("ack", ack);
      clock.advance(100);
      steps += 1;
      maxInFlight = Math.max(maxInFlight, gate.stats().inFlight);
      if (!shortRenewed && steps === 50) {
        assert.strictEqual(delivered.has("ess:short"), false, "lease < minLeaseLeftMs is not released");
        assert.strictEqual(delivered.has("ess:stale"), false);
        onEvent(dueEvent("ess:short", "ess.settlement", far, "ess:short#2"));
        shortRenewed = true;
      }
    }
    for (const ack of pendingAck.splice(0)) client.call("ack", ack);
    clock.advance(100);
    assert.ok(maxInFlight <= 2 && maxInFlight > 0, `maxInFlight=${maxInFlight}`);
    assert.strictEqual(delivered.size, 7001, "7000 + short after a new lease");
    assert.ok([...delivered.values()].every((n) => n === 1), "each exactly once");
    assert.strictEqual(delivered.has("ess:stale"), false);
    const s = gate.stats();
    assert.strictEqual(s.staleDropped, 1);
    assert.strictEqual(s.released, 7001);
    assert.strictEqual(gate.mode(), "passthrough");
    assert.ok(lines.some((l) => /^scheduler due gate: open \(owners_ready\) held=7000 /.test(l)), lines.join("|"));
    assert.ok(lines.some((l) => /^scheduler due gate: drained released=7001 replaced=1 staleDropped=1 overflow=0 /.test(l)),
      lines.join("|"));
    const after = dueEvent("ess:late", "ess.settlement", clock.now() + VENDOR_LEASE_MS);
    onEvent(after);
    assert.strictEqual(delivered.get("ess:late"), 1, "passthrough at once");
    const c2 = fakeClock();
    const g2 = createSchedulerDueGate(gateOptions(c2, { maxHeld: 1, releaseDelayMs: 0 }));
    const got = [];
    let on2 = null;
    let cl2 = null;
    g2.capture(() => {
      on2 = g2.wrapOnEvent((e) => got.push(e.payload.jobID));
      cl2 = g2.wrapClient(Object.freeze({ call: () => rejected(new Error("SCHEDULED_JOB_LEASE_STALE")) }));
    });
    on2(dueEvent("a", "ess.settlement", T0 + VENDOR_LEASE_MS));
    on2(dueEvent("b", "ess.settlement", T0 + VENDOR_LEASE_MS));
    assert.deepStrictEqual(got, ["b"], "overflow goes at once");
    assert.strictEqual(g2.stats().overflow, 1);
    g2.open("owners_ready");
    c2.advance(0);
    assert.deepStrictEqual(got, ["b", "a"]);
    assert.strictEqual(g2.stats().inFlight, 1);
    const p = cl2.call("validateLease", { jobID: "a", leaseToken: "a#1" });
    assert.strictEqual(typeof p.then, "function", "the same vendor result");
    assert.strictEqual(g2.stats().inFlight, 0, "a refused validateLease frees the slot");
  });

  test("hotpath17 G3 scope and opening: client from capture wrapped, npcBounty unchanged; owners_failed propagates the error; max_hold", () => {
    const tree = fakeTree();
    const clock = fakeClock();
    const lines = [];
    const gate = createSchedulerDueGate(gateOptions(clock, { log: (l) => lines.push(l) }));
    const sq = createSchedulerQueue({ limit: 4096, log: (l) => lines.push(l), dueGate: gate });
    withTree(tree, () => {
      installSchedulerQueueHook(sq);
      const { createProductionSchedulerRuntime } = require(path.join(tree.scheduler, "productionSchedulerRuntime.js"));
      assert.strictEqual(typeof createProductionSchedulerRuntime[RUNTIME_WRAPPED], "function", "wrapped before destructuring");
      const bounty = require(path.join(tree.bounty, "npcBountySchedulerRuntime.js"));
      const ds = require(path.join(tree.scheduler, "durableScheduler.js"));
      const opc = require(path.join(tree.shared, "orderedProcessClient.js"));
      const boom = new Error("boom");
      const rt = createProductionSchedulerRuntime({ startResult: rejected(boom) });
      assert.ok(Object.isFrozen(rt));
      assert.deepStrictEqual(Object.keys(rt).sort(), ["getState", "shutdown", "start"]);
      assert.strictEqual(rt.getState(), "idle");
      const prod = ds.made[0];
      assert.notStrictEqual(opc.seen[0].options.onEvent, prod.onEvent, "onEvent wrapped");
      assert.notStrictEqual(prod.client, opc.seen[0].client, "client wrapped");
      assert.strictEqual(opc.seen[0].options.maxPending, 4096);
      const nb = bounty.createNpcBountySchedulerRuntime();
      assert.strictEqual(opc.seen[1].options.onEvent, nb.onEvent, "npcBounty: the same onEvent options");
      assert.strictEqual(nb.client, opc.seen[1].client, "npcBounty: the same client object");
      nb.onEvent(dueEvent("ess:1", "ess.settlement", T0 + VENDOR_LEASE_MS));
      assert.strictEqual(nb.events.length, 1);
      opc.seen[0].options.onEvent(dueEvent("ess:2", "ess.settlement", T0 + VENDOR_LEASE_MS));
      assert.strictEqual(prod.events.length, 0, "production event held");
      assert.throws(() => rt.start(), /boom/);
      assert.strictEqual(gate.mode(), "open");
      assert.strictEqual(gate.stats().openedReason, "owners_failed");
      createProductionSchedulerRuntime({ startResult: resolved(1) });
      assert.strictEqual(opc.seen[2].options.onEvent, ds.made[2].onEvent);
      assert.strictEqual(rt.shutdown(), "down");
      assert.strictEqual(gate.mode(), "passthrough");
    });
    assert.ok(!lines.some((l) => /DRIFT/.test(l)), lines.join("|"));
    const c2 = fakeClock();
    const g2 = createSchedulerDueGate(gateOptions(c2));
    let on2 = null;
    g2.capture(() => { on2 = g2.wrapOnEvent(() => {}); });
    on2(dueEvent("s:1", "sovereignty.campaign-tick", T0 + VENDOR_LEASE_MS));
    c2.advance(299999);
    assert.strictEqual(g2.mode(), "holding");
    c2.advance(1);
    assert.strictEqual(g2.mode(), "open");
    assert.strictEqual(g2.stats().openedReason, "max_hold");
    const frozen = fakeTree({ frozen: true });
    const l3 = [];
    const sq3 = createSchedulerQueue({ log: (l) => l3.push(l), dueGate: createSchedulerDueGate(gateOptions(fakeClock())) });
    withTree(frozen, () => {
      installSchedulerQueueHook(sq3);
      const mod = require(path.join(frozen.scheduler, "productionSchedulerRuntime.js"));
      require(path.join(frozen.scheduler, "productionSchedulerRuntime.js"));
      assert.strictEqual(mod.createProductionSchedulerRuntime[RUNTIME_WRAPPED], undefined);
    });
    assert.strictEqual(l3.filter((l) => /^DRIFT: productionSchedulerRuntime\.createProductionSchedulerRuntime .*due gate inactive \(vendor dispatch\)/.test(l)).length, 1, l3.join("|"));
    const l4 = [];
    const g4 = createSchedulerDueGate(gateOptions(fakeClock(), { log: (l) => l4.push(l) }));
    assert.strictEqual(g4.capture(() => 7), 7);
    assert.strictEqual(g4.mode(), "passthrough");
    assert.ok(l4.some((l) => /due gate inactive \(vendor dispatch\)/.test(l)), l4.join("|"));
    assert.strictEqual(schedulerQueueTargetOf("/app/server/src/services/scheduler/productionSchedulerRuntime.js"), "productionScheduler");
  });

  test("hotpath17 G4 kill switch: HOTPATH_SCHEDULER_DUE_GATE=0, without the gate nothing is wrapped, the same options; config ranges", () => {
    const def = loadConfig({ env: {}, settingsPath: MISSING });
    assert.strictEqual(def.schedulerDueGate, true);
    assert.strictEqual(def.schedulerDueGateTypes, "ess.settlement,sovereignty.campaign-tick");
    assert.strictEqual(def.schedulerDueGateMaxInFlight, 2);
    assert.strictEqual(loadConfig({ env: { HOTPATH_SCHEDULER_DUE_GATE: "0" }, settingsPath: MISSING }).schedulerDueGate, false);
    const warns = [];
    const c = loadConfig({ env: { HOTPATH_SCHEDULER_DUE_GATE_MAX_IN_FLIGHT: "500", HOTPATH_SCHEDULER_DUE_GATE_MIN_LEASE_LEFT_MS: "30000",
      HOTPATH_SCHEDULER_DUE_GATE_TYPES: " a , * ,a,b " }, settingsPath: MISSING, warn: (m) => warns.push(m) });
    assert.strictEqual(c.schedulerDueGateMaxInFlight, 64);
    assert.strictEqual(c.schedulerDueGateMinLeaseLeftMs, 29000);
    assert.strictEqual(c.schedulerDueGateTypes, "a,b");
    assert.ok(warns.some((m) => /schedulerDueGateMaxInFlight=500 clamped to 64/.test(m)), warns.join("|"));
    assert.ok(warns.some((m) => /schedulerDueGateTypes: skipped 1/.test(m)), warns.join("|"));
    assert.strictEqual(Object.keys(SCHEDULER_DUE_GATE_RANGES).length, 9);
    assert.strictEqual(def.schedulerDueGateUnseenReleaseMs, 10000);
    const offLines = [];
    assert.strictEqual(createDueGateOf({ ...def, schedulerDueGateTypes: "" }, (l) => offLines.push(l)), null);
    assert.deepStrictEqual(offLines, ["scheduler due gate: off (schedulerDueGateTypes empty)"]);
    assert.strictEqual(typeof createDueGateOf(def, () => {}).capture, "function");
    const off = createSchedulerQueue({ limit: 0, requestTimeoutMs: 0, dueGate: null });
    assert.strictEqual(off.active, false);
    const original = () => 1;
    const exportsValue = { createProductionSchedulerRuntime: original };
    assert.strictEqual(off.patchProductionRuntime(exportsValue), false);
    assert.strictEqual(exportsValue.createProductionSchedulerRuntime, original);
    const seen = [];
    const sq = createSchedulerQueue({ limit: 256, requestTimeoutMs: 10000 });
    const factory = sq.wrapFactory(function f(opts) { seen.push(opts); return { opts }; });
    const opts = { authorityName: "scheduler", maxPending: 10000, requestTimeoutMs: 600000, onEvent() {} };
    factory(opts);
    assert.strictEqual(seen[0], opts, "the same options object");
    const gate = createSchedulerDueGate(gateOptions(fakeClock()));
    const sqGate = createSchedulerQueue({ dueGate: gate });
    const clientObj = { call() {} };
    const f2 = sqGate.wrapFactory((o) => { seen.push(o); return clientObj; });
    assert.strictEqual(f2(opts), clientObj);
    assert.strictEqual(seen[1], opts);
  });

  test("hotpath17 G5 vendor facts: lease 30 s, scheduler.due, dispatch validateLease/ack/retry, runtime and bootstrap", () => {
    const worker = src("services/scheduler/durableSchedulerProcess.worker.js");
    assert.ok(worker.includes(`const DEFAULT_LEASE_MS = ${VENDOR_LEASE_MS === 30000 ? "30_000" : "?"};`));
    assert.ok(worker.includes("leaseUntilMs: nowMs + DEFAULT_LEASE_MS,"));
    const dispatchAt = worker.indexOf("function dispatchDueJobs(");
    assert.ok(dispatchAt >= 0);
    assert.ok(worker.indexOf("publishEvent(\"scheduler.due\"", dispatchAt) > dispatchAt);
    const ds = src("services/scheduler/durableScheduler.js");
    assert.ok(ds.includes("if (event.topic !== \"scheduler.due\" || closing) return;"));
    assert.ok(ds.includes("void dispatch(event.payload)"));
    for (const cmd of ["validateLease", "ack", "retry"]) assert.ok(ds.includes(`call("${cmd}", {`), cmd);
    const prs = src("services/scheduler/productionSchedulerRuntime.js");
    const defAt = prs.indexOf("function createProductionSchedulerRuntime(");
    assert.ok(defAt >= 0);
    assert.ok(prs.indexOf("createDurableScheduler(", defAt) > defAt);
    assert.ok(/return Object\.freeze\(\{\s*getState: \(\) => state,\s*shutdown,\s*start,\s*\}\);\s*\}\s*module\.exports = \{ createProductionSchedulerRuntime \};/.test(prs));
    const boot = src("../bootstrap.js");
    assert.ok(/const \{\s*createProductionSchedulerRuntime,\s*\} = require\(/.test(boot));
    assert.ok(boot.includes("await productionSchedulerRuntime.start();"));
    const npc = src("services/bounty/npcBountySchedulerRuntime.js");
    assert.ok(npc.includes("createDurableScheduler("), "second scheduler client outside the gate");
  });

  test("hotpath17 G6 pump rate: 1000 jobs with an ack every 1 ms ≈ 1000/maxInFlight ms, waiting ones at the head skipped, batch, unseen", () => {
    const clock = fakeClock();
    const gate = createSchedulerDueGate(gateOptions(clock, { releaseDelayMs: 0 }));
    const delivered = new Map();
    const pendingAck = [];
    let client = null;
    let maxInFlight = 0;
    const vendorOnEvent = (event) => {
      const { jobID, leaseToken } = event.payload;
      delivered.set(jobID, (delivered.get(jobID) || 0) + 1);
      maxInFlight = Math.max(maxInFlight, gate.stats().inFlight);
      client.call("validateLease", { jobID, leaseToken });
      pendingAck.push({ jobID, leaseToken });
    };
    let onEvent = null;
    gate.capture(() => {
      onEvent = gate.wrapOnEvent(vendorOnEvent);
      client = gate.wrapClient(Object.freeze({ call: () => resolved({ ok: true }) }));
    });
    for (let i = 0; i < 40; i += 1) onEvent(dueEvent(`ess:wait:${i}`, "ess.settlement", T0 + 5000));
    for (let i = 0; i < 1000; i += 1) onEvent(dueEvent(`ess:${i}`, "ess.settlement", T0 + 10 * 3600000));
    gate.open("owners_ready");
    const start = clock.now();
    let ms = 0;
    while (delivered.size < 1000 && ms < 60000) {
      clock.advance(1);
      ms += 1;
      for (const ack of pendingAck.splice(0)) client.call("ack", ack);
    }
    assert.strictEqual(delivered.size, 1000, "1000 long ones released despite waiting ones at the head");
    assert.ok([...delivered.values()].every((n) => n === 1), "each exactly once");
    assert.ok(clock.now() - start <= 1000 / 2 + 200, `drain ${clock.now() - start} ms (old pump: ~50000 ms or never)`);
    assert.ok(maxInFlight <= 2 && maxInFlight > 0, `maxInFlight=${maxInFlight}`);
    assert.strictEqual(gate.stats().held, 40, "waiting ones stay in the gate");
    for (let i = 0; i < 40; i += 1) assert.strictEqual(delivered.has(`ess:wait:${i}`), false);
    const c2 = fakeClock();
    const g2 = createSchedulerDueGate(gateOptions(c2, { releaseDelayMs: 0, batch: 8, maxInFlight: 16 }));
    let on2 = null;
    let cl2 = null;
    const got = [];
    g2.capture(() => {
      on2 = g2.wrapOnEvent((e) => { got.push(e.payload.jobID); cl2.call("validateLease", e.payload); });
      cl2 = g2.wrapClient(Object.freeze({ call: () => resolved({ ok: true }) }));
    });
    for (let i = 0; i < 100; i += 1) on2(dueEvent(`b:${i}`, "ess.settlement", T0 + 10 * 3600000));
    g2.open("owners_ready");
    c2.advance(0);
    assert.strictEqual(got.length, 8, "first step = batch");
    c2.advance(100);
    assert.strictEqual(got.length, 16, "second step up to maxInFlight");
    c2.advance(100);
    assert.strictEqual(got.length, 16, "in flight full = stop");
    c2.advance(10500);
    assert.strictEqual(got.length, 16, "seen ones keep their slot until lease + staleDropMs");
    const c3 = fakeClock();
    const g3 = createSchedulerDueGate(gateOptions(c3, { releaseDelayMs: 0, unseenReleaseMs: 1000 }));
    let on3 = null;
    const got3 = [];
    g3.capture(() => {
      on3 = g3.wrapOnEvent((e) => got3.push(e.payload.jobID));
      g3.wrapClient(Object.freeze({ call: () => resolved({ ok: true }) }));
    });
    for (let i = 0; i < 4; i += 1) on3(dueEvent(`u:${i}`, "ess.settlement", T0 + 10 * 3600000));
    g3.open("owners_ready");
    c3.advance(0);
    assert.deepStrictEqual(got3, ["u:0", "u:1"]);
    c3.advance(1000);
    assert.deepStrictEqual(got3, ["u:0", "u:1"], "slot taken until unseenReleaseMs");
    c3.advance(100);
    assert.deepStrictEqual(got3, ["u:0", "u:1", "u:2", "u:3"], "freed after unseenReleaseMs");
    assert.strictEqual(g3.stats().inFlightExpired, 2);
  });
}

module.exports = { register };
