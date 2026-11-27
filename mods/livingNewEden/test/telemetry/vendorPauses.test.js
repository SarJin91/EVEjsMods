"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { MODE } = require("../../lib/telemetry/loadGovernor");
const { startGovernor } = require("../../lib/telemetry/governorService");
const { createPauseLedger, RING_CAPACITY, EXCUSE_WINDOW_MS } = require("../../lib/telemetry/pauseLedger");
const vendorPauses = require("../../lib/adapter/vendorPauses");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const CONFIG = resolveConfig({ modDir: MOD_DIR }).config;
const TICK_MS = 100;
const PAUSE_MS = 3900;
const SAMPLE_MS = 4000;

function fakeGovTelemetry() {
  const counters = {};
  let listener = null;
  return { counters, push: (s) => listener(s),
    getStatus: () => ({ tick: "ok" }),
    addTickListener(fn) { listener = fn; return { ok: true, remove() {} }; },
    count(name, n = 1) { counters[name] = (counters[name] || 0) + n; },
    gauge() {}, attachGovernor() {} };
}

function harness(governorOverride = {}, withSeam = true) {
  const telemetry = fakeGovTelemetry();
  let onPause = null;
  let now = 0;
  const config = { ...CONFIG, governor: { ...CONFIG.governor, ...governorOverride } };
  const subscribeVendorPauses = withSeam ? (fn, opts) => {
    onPause = fn;
    assert.strictEqual(opts.minMs, config.governor.vendorPauseMinMs);
    return { ok: true, unsubscribe() { onPause = null; }, stats: () => ({ recorded: 0, subscriberErrors: 0 }) };
  } : undefined;
  const started = startGovernor({ config, telemetry, logger: { log() {} }, now: () => now, subscribeVendorPauses });
  assert.strictEqual(started.ok, true);
  const gov = started.governor;
  const tick = (intervalMs) => {
    now += intervalMs;
    telemetry.push({ intervalMs, workMs: 1, latenessMs: intervalMs - TICK_MS, atMs: now });
  };
  for (let i = 0; i < 10; i += 1) tick(TICK_MS);
  gov.evaluate(now);
  return {
    telemetry, gov,
    entry(withPause = true) {
      if (withPause && onPause) onPause({ startMs: now + 50, endMs: now + 50 + PAUSE_MS, systemId: 30000142, kind: "x" });
      tick(SAMPLE_MS);
      const policy = gov.evaluate(now + 1);
      for (let i = 0; i < 20; i += 1) tick(TICK_MS);
      gov.evaluate(now);
      return policy;
    },
    get onPause() { return onPause; },
  };
}

module.exports = ({ test }) => {
  test("VP1 pauseLedger: partial and full overlap, cap per pause, cap per minute, sliding window", () => {
    const ledger = createPauseLedger({ maxExcuseMs: 1000, perMinute: 2 });
    assert.strictEqual(ledger.add({ startMs: 100, endMs: 50 }), false, "empty pause refused");
    assert.strictEqual(ledger.add({ startMs: 1000, endMs: 1500 }), true);
    assert.strictEqual(ledger.overlapMs(900, 2000), 500, "full");
    assert.strictEqual(ledger.overlapMs(1200, 2000), 300, "partial");
    assert.strictEqual(ledger.overlapMs(2000, 3000), 0, "disjoint");
    ledger.add({ startMs: 5000, endMs: 9000 });
    assert.strictEqual(ledger.overlapMs(4000, 10000), 1000, "a pause excuses at most maxExcuseMs");
    assert.strictEqual(ledger.overlapMs(5000, 5400), 400, "never above the sample");
    for (let i = 0; i < RING_CAPACITY; i += 1) ledger.add({ startMs: 20000 + i * 10, endMs: 20005 + i * 10 });
    assert.strictEqual(ledger.size(), RING_CAPACITY);
    assert.strictEqual(ledger.overlapMs(900, 2000), 0, "the oldest pause left the ring");
    assert.deepStrictEqual([ledger.admitExcuse(0), ledger.admitExcuse(10), ledger.admitExcuse(20)], [true, true, false]);
    assert.strictEqual(ledger.admitExcuse(EXCUSE_WINDOW_MS + 5), true, "the window slid past the first excuse");
    assert.strictEqual(createPauseLedger({ maxExcuseMs: 1000, perMinute: 0 }).admitExcuse(0), false, "0 = none");
  });

  test("VP2 governor: a 4000 ms sample with a 3900 ms entry pause -> no SHED overlay; without the pause or above "
    + "the per-minute limit (7th of 6) -> overlay; flag off = unchanged", () => {
    const excused = harness();
    const emergencyBefore = excused.gov.getStatus().counts.emergencySamples;
    const quiet = excused.entry(true);
    const st = excused.gov.getStatus();
    assert.notStrictEqual(quiet.mode, MODE.SHED, "no SHED overlay");
    assert.deepStrictEqual([st.overlay, st.counts.emergencySamples, st.counts.excusedSamples],
      [null, emergencyBefore, 1]);
    excused.gov.evaluate();
    assert.strictEqual(excused.telemetry.counters["governor.excusedSamples"], 1);
    assert.strictEqual(excused.telemetry.counters["governor.excusedMs"], PAUSE_MS);

    const plain = harness();
    assert.strictEqual(plain.entry(false).mode, MODE.SHED, "the same sample without a pause -> overlay");
    assert.strictEqual(plain.gov.getStatus().counts.emergencySamples, 1);

    const limited = harness({ vendorPauseExcusePerMinute: 6 });
    for (let i = 0; i < 6; i += 1) assert.notStrictEqual(limited.entry(true).mode, MODE.SHED, `entry ${i + 1}`);
    assert.strictEqual(limited.entry(true).mode, MODE.SHED, "7th entry in the minute -> overlay");
    limited.gov.evaluate();
    assert.strictEqual(limited.telemetry.counters["governor.excuseCapped"], 1);

    const off = harness({ vendorPauseExcuseEnabled: false });
    assert.strictEqual(off.onPause, null, "flag off: no subscription");
    assert.strictEqual(off.entry(true).mode, MODE.SHED);
    assert.strictEqual(harness({}, false).entry(true).mode, MODE.SHED, "no seam: unchanged");
  });

  test("VP3 adapter wrap: only the outermost call, short call not reported, vendor throw passes, subscriber throw "
    + "stays out of the vendor", () => {
    let clock = 0;
    const boom = new Error("vendor boom");
    class FakeRuntime {}
    FakeRuntime.prototype.prepareUniverseSitesForPlayerEntry = function prepare(systemID, options) {
      clock += this.cost;
      if (options && options.fail) throw boom;
      return { success: true, systemID, self: this };
    };
    FakeRuntime.prototype.prewarmSolarSystemForArrival = function prewarm(systemID) {
      clock += 100;
      const r = this.prepareUniverseSitesForPlayerEntry(systemID, {});
      clock += 100;
      return r;
    };
    const runtime = Object.create(FakeRuntime.prototype);
    runtime.cost = 3000;
    const requireGame = (rel) => (rel === vendorPauses.RUNTIME_PATH ? { ok: true, exports: runtime }
      : { ok: false, reason: "not_in_game_modules" });
    const api = vendorPauses.install(requireGame, { minMs: 250, now: () => clock });
    assert.strictEqual(api.ok, true);
    assert.strictEqual(vendorPauses.install(requireGame, { minMs: 250 }), api, "second install = the same wrap");
    const seen = [];
    const off = api.subscribe((p) => seen.push(p));
    const offBad = api.subscribe(() => { throw new Error("subscriber boom"); });
    const before = api.stats();

    const r = runtime.prewarmSolarSystemForArrival(30000142);
    assert.deepStrictEqual([r.success, r.systemID, r.self], [true, 30000142, runtime], "result and this unchanged");
    assert.deepStrictEqual(seen.map((p) => [p.kind, p.systemId, p.endMs - p.startMs]),
      [["arrivalPrewarm", 30000142, 3200]], "one pause: the outermost call");
    assert.strictEqual(api.stats().subscriberErrors - before.subscriberErrors, 1);

    runtime.cost = 100;
    runtime.prepareUniverseSitesForPlayerEntry(30000143);
    assert.strictEqual(seen.length, 1, "100 ms < minMs: not reported");

    runtime.cost = 400;
    assert.throws(() => runtime.prepareUniverseSitesForPlayerEntry(30000144, { fail: true }), (e) => e === boom);
    assert.deepStrictEqual(seen.slice(1).map((p) => [p.kind, p.systemId]), [["entryPrepare", 30000144]]);
    runtime.prewarmSolarSystemForArrival(30000145);
    assert.strictEqual(seen.length, 3, "depth back to 0 after the throw");
    off();
    offBad();
    const missing = vendorPauses.install(() => ({ ok: true, exports: Object.create({}) }));
    assert.deepStrictEqual([missing.ok, missing.reason], [false, "SYMBOL_MISSING"]);
  });

  test("VP-F vendor facts: SpaceRuntime mixins copied onto the prototype, this./export calls, no destructuring; "
    + "GAME_MODULES wrap rows", () => {
    const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, "EveJS server/src not found above the mod");
    const src = found.srcDir;
    const read = (...p) => fs.readFileSync(path.join(src, ...p), "utf8").replace(/\r\n/g, "\n");
    const runtime = read("space", "runtime.js");
    const tables = /const spaceRuntimeMethodTables = \[([\s\S]*?)\];/.exec(runtime);
    assert.ok(tables, "spaceRuntimeMethodTables");
    assert.ok(tables[1].includes("require(\"./runtime/spaceRuntime/universeSites\")"));
    assert.ok(tables[1].includes("require(\"./runtime/spaceRuntime/sessions\")"));
    assert.match(runtime, /Object\.defineProperty\(SpaceRuntime\.prototype, methodName, \{[\s\S]*?writable: true,/);
    assert.match(read("space", "runtime", "spaceRuntime", "universeSites.js"), /\nprepareUniverseSitesForPlayerEntry\(/);
    const sessions = read("space", "runtime", "spaceRuntime", "sessions.js");
    assert.match(sessions, /\nprewarmSolarSystemForArrival\(/);
    assert.ok(sessions.includes("this.prepareUniverseSitesForPlayerEntry("), "prewarm calls prepare through this");
    assert.ok(read("space", "transitions.js").includes("spaceRuntime.prewarmSolarSystemForArrival("));
    const destructured = /\{[^}]*\b(prepareUniverseSitesForPlayerEntry|prewarmSolarSystemForArrival)\b[^}]*\}\s*=/;
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) {
          const text = fs.readFileSync(full, "utf8");
          if ((text.includes("prepareUniverseSitesForPlayerEntry") || text.includes("prewarmSolarSystemForArrival"))
            && destructured.test(text)) offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    assert.deepStrictEqual(offenders, [], "nobody destructures the wrapped methods");
    const rows = GAME_MODULES.find((e) => e.path === "space/runtime").symbols
      .filter((s) => vendorPauses.NAMES.includes(s.name));
    assert.deepStrictEqual(rows.map((s) => [s.name, s.kind, s.wrap, s.consumers.join(",")]),
      vendorPauses.NAMES.map((n) => [n, "prototypeMethod", true, "vendorPauses"]));
  });
};
