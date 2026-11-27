"use strict";

process.env.EVEJS_MARKET_ALL_REGIONS_NO_INSTALL = "1";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const loader = require(path.join(modDir, "loader.js"));
const configModule = require(path.join(modDir, "config.js"));
const viability = require(path.join(modDir, "lib", "viability.js"));

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? null : String(process.argv[onlyAt + 1] || "").split(",").filter(Boolean);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function makeConfig(overrides = {}) {
  return Object.freeze({ ...configModule.DEFAULTS, ...overrides, problems: Object.freeze([]) });
}

function row(region, station, price, orderID, extra = {}) {
  return { order_id: orderID, region_id: region, station_id: station, solar_system_id: station * 10, price, ...extra };
}

function makeFixture() {
  const books = new Map();
  const failing = new Map();
  const calls = [];
  class FakeDaemon {
    async call(method, params = {}, options = {}) {
      calls.push({ method, params: { ...params }, options });
      if (method !== "GetOrders") return { ok: true };
      const regionID = params.region_id;
      if (failing.has(regionID)) throw failing.get(regionID);
      const book = books.get(regionID) || { sells: [], buys: [] };
      return {
        region_id: regionID,
        type_id: params.type_id,
        sells: book.sells.map((entry) => ({ ...entry })),
        buys: book.buys.map((entry) => ({ ...entry })),
      };
    }
  }
  const daemon = new FakeDaemon();
  class FakeProxy {
    async Handle_GetOrders(args, session) {
      const typeID = Number(args && args.length > 0 ? args[0] : 0) || 0;
      const regionID = Number(session && (session.regionid || session.regionID)) || 0;
      if (!typeID || !regionID) return { sells: [], buys: [] };
      try {
        const result = await daemon.call("GetOrders", { region_id: regionID, type_id: typeID });
        return { sells: result.sells, buys: result.buys };
      } catch (error) {
        const wrapped = new Error("MarketUnavailable");
        wrapped.cause = error;
        throw wrapped;
      }
    }
  }
  const worldData = {
    getSolarSystems: () => [
      { regionID: 1 }, { regionID: 2 }, { regionID: 3 }, { regionID: 2 }, { regionID: 11000001 },
    ],
  };
  return {
    books,
    failing,
    calls,
    daemon,
    proxy: new FakeProxy(),
    FakeDaemon,
    FakeProxy,
    proxyExports: FakeProxy,
    daemonExports: { MarketDaemonClient: FakeDaemon, marketDaemonClient: daemon },
    worldData,
  };
}

function apply(fixture, configOverrides = {}, extra = {}) {
  const logs = [];
  const result = loader._testing.applyToExports({
    proxyExports: fixture.proxyExports,
    daemonExports: fixture.daemonExports,
    worldData: fixture.worldData,
    config: makeConfig(configOverrides),
    logFn: (message) => logs.push(message),
    logErrorFn: (message) => logs.push(message),
    ...extra,
  });
  return { result, logs };
}

const SESSION = Object.freeze({ regionid: 1, solarsystemid2: 30000001 });
const TYPE = 34;

test("T1 vendor facts: seams in server/src v0.12.9 + viability ok", () => {
  const read = (relative) => fs.readFileSync(path.join(runtimeRoot, ...relative.split("/")), "utf8");
  const proxy = read("server/src/services/market/marketProxyService.js");
  const daemon = read("server/src/services/market/marketDaemonClient.js");
  const world = read("server/src/space/worldData.js");
  assert.ok(proxy.includes("  async Handle_GetOrders(args, session) {"), "Handle_GetOrders signature");
  const body = viability.extractHandlerBody(proxy);
  assert.ok(body.includes("marketDaemonClient.call(\"GetOrders\", {"), "daemon GetOrders call inside handler");
  assert.ok(body.includes("region_id: regionID,"), "region_id from session inside handler");
  assert.ok(body.includes("getNumericSessionValue(session, [\"regionid\", \"regionID\"])"), "session region keys");
  assert.ok(proxy.includes("module.exports = MarketProxyService;"), "class export");
  assert.ok(daemon.includes("  async call(method, params = {}, options = {}) {"), "daemon call signature");
  assert.ok(/module\.exports = \{\s*MarketDaemonClient,/u.test(daemon), "MarketDaemonClient export");
  assert.ok(/module\.exports = \{[^}]*\n  getSolarSystems,/u.test(world), "getSolarSystems export");
  const inspected = viability.inspect(runtimeRoot);
  assert.strictEqual(inspected.ok, true, JSON.stringify(inspected.reports.filter((r) => !r.ok)));
});

test("T2 merge and limit: own complete, best foreign per side, ties by region, NaN dropped", async () => {
  const fixture = makeFixture();
  fixture.books.set(1, {
    sells: [row(1, 100, 1, "11"), row(1, 100, 2, "12"), row(1, 101, 3, "13")],
    buys: [row(1, 100, 50, "14")],
  });
  fixture.books.set(2, {
    sells: [row(2, 200, 10, "21"), row(2, 200, 5, "22")],
    buys: [row(2, 200, 20, "23"), row(2, 200, 30, "24")],
  });
  fixture.books.set(3, {
    sells: [row(3, 300, 5, "31"), row(3, 300, 7, "32"), row(3, 300, Number.NaN, "33")],
    buys: [row(3, 300, 30, "34"), row(3, 300, 40, "35")],
  });
  const { result } = apply(fixture, { maxForeignRowsPerSide: 2 });
  assert.strictEqual(result.applied, true);
  const out = await fixture.proxy.Handle_GetOrders([TYPE], SESSION);
  assert.deepStrictEqual(out.sells.map((r) => r.order_id), ["11", "12", "13", "22", "31"]);
  assert.deepStrictEqual(out.buys.map((r) => r.order_id), ["14", "35", "24"]);
  const stats = result.runtime.reader.stats();
  assert.strictEqual(stats.droppedRows, 1);
  assert.strictEqual(stats.fanouts, 1);
  const regions = fixture.calls.map((c) => c.params.region_id).sort();
  assert.deepStrictEqual(regions, [1, 1, 2, 3]);
});

test("T3 flag off / bad config = vanilla, no wraps", async () => {
  const disabled = loader.install({ environment: { EVEJS_MARKET_ALL_REGIONS: "0" }, runtimeRoot });
  assert.strictEqual(disabled.active, false);
  assert.strictEqual(disabled.reason, "disabled");
  const invalid = loader.install({ environment: { EVEJS_MARKET_ALL_REGIONS_CONCURRENCY: "65" }, runtimeRoot });
  assert.strictEqual(invalid.reason, "invalid-config");
  assert.ok(invalid.config.problems.some((p) => p.includes("EVEJS_MARKET_ALL_REGIONS_CONCURRENCY")));
  assert.strictEqual(globalThis[loader.INSTALL_FLAG], undefined);

  const defaults = configModule.load(path.join(modDir, "no-such-dir"), {});
  assert.deepStrictEqual({ ...defaults, problems: [] }, { ...configModule.DEFAULTS, problems: [] });

  const fixture = makeFixture();
  fixture.books.set(1, { sells: [row(1, 100, 1, "11")], buys: [] });
  fixture.books.set(2, { sells: [row(2, 200, 1, "21")], buys: [] });
  const handler = fixture.FakeProxy.prototype.Handle_GetOrders;
  const call = fixture.FakeDaemon.prototype.call;
  const { result } = apply(fixture, { enabled: false });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(fixture.FakeProxy.prototype.Handle_GetOrders, handler);
  assert.strictEqual(fixture.FakeDaemon.prototype.call, call);
  const out = await fixture.proxy.Handle_GetOrders([TYPE], SESSION);
  assert.strictEqual(fixture.calls.length, 1);
  assert.deepStrictEqual(fixture.calls[0].params, { region_id: 1, type_id: TYPE });
  assert.deepStrictEqual(out.sells.map((r) => r.order_id), ["11"]);

  const driftA = makeFixture();
  driftA.books.set(1, { sells: [row(1, 100, 1, "11")], buys: [] });
  driftA.books.set(2, { sells: [row(2, 200, 1, "21")], buys: [] });
  delete driftA.FakeProxy.prototype.Handle_GetOrders;
  const appliedA = apply(driftA);
  assert.strictEqual(appliedA.result.applied, false);
  assert.strictEqual(appliedA.result.reason, "drift");
  assert.strictEqual(appliedA.result.runtime.state.inert, true);
  assert.ok(appliedA.logs.some((m) => m.startsWith("DRIFT services/market/marketProxyService.Handle_GetOrders")));
  const scope = { regionID: 1, typeID: TYPE, consumed: false };
  const inert = await appliedA.result.runtime.als.run(scope, () => driftA.daemon.call("GetOrders", { region_id: 1, type_id: TYPE }));
  assert.strictEqual(driftA.calls.length, 1);
  assert.deepStrictEqual(inert.sells.map((r) => r.order_id), ["11"]);
  assert.strictEqual(appliedA.result.runtime.reader.stats().requests, 0);

  const driftB = makeFixture();
  const proxyHandler = driftB.FakeProxy.prototype.Handle_GetOrders;
  delete driftB.FakeDaemon.prototype.call;
  const appliedB = apply(driftB);
  assert.strictEqual(appliedB.result.reason, "drift");
  assert.strictEqual(appliedB.result.runtime.state.inert, true);
  assert.strictEqual(driftB.FakeProxy.prototype.Handle_GetOrders, proxyHandler);
  assert.ok(appliedB.logs.some((m) => m.startsWith("DRIFT services/market/marketDaemonClient.MarketDaemonClient.prototype.call")));
  assert.ok(!appliedB.logs.some((m) => m.startsWith("wrapped")));
});

test("T4 region errors: foreign skipped and not cached; own error propagates", async () => {
  const fixture = makeFixture();
  fixture.books.set(1, { sells: [row(1, 100, 9, "11")], buys: [] });
  fixture.books.set(2, { sells: [row(2, 200, 8, "21")], buys: [] });
  fixture.failing.set(3, new Error("region 3 down"));
  const { result } = apply(fixture);
  const out = await fixture.proxy.Handle_GetOrders([TYPE], SESSION);
  assert.deepStrictEqual(out.sells.map((r) => r.order_id), ["11", "21"]);
  const stats = result.runtime.reader.stats();
  assert.strictEqual(stats.regionErrors, 1);
  assert.strictEqual(stats.cacheSize, 0);

  const ownFixture = makeFixture();
  const daemonError = new Error("own region down");
  ownFixture.books.set(2, { sells: [row(2, 200, 8, "21")], buys: [] });
  ownFixture.failing.set(1, daemonError);
  apply(ownFixture);
  await assert.rejects(
    () => ownFixture.proxy.Handle_GetOrders([TYPE], SESSION),
    (error) => error.message === "MarketUnavailable" && error.cause === daemonError,
  );
});

test("T5 ALS scope + cache: outside calls untouched, own fresh on hit, inflight dedupe", async () => {
  const fixtureA = makeFixture();
  fixtureA.books.set(1, { sells: [row(1, 100, 9, "11")], buys: [] });
  fixtureA.books.set(2, { sells: [row(2, 200, 8, "21")], buys: [] });
  apply(fixtureA);
  const direct = await fixtureA.daemon.call("GetOrders", { region_id: 1, type_id: TYPE });
  assert.strictEqual(fixtureA.calls.length, 1);
  assert.deepStrictEqual(direct.sells.map((r) => r.order_id), ["11"]);

  const fixtureB = makeFixture();
  let clock = 1000;
  fixtureB.books.set(1, { sells: [row(1, 100, 9, "old-own")], buys: [] });
  fixtureB.books.set(2, { sells: [row(2, 200, 8, "21")], buys: [] });
  const { result } = apply(fixtureB, {}, { now: () => clock });
  await fixtureB.proxy.Handle_GetOrders([TYPE], SESSION);
  const before = fixtureB.calls.length;
  fixtureB.books.set(1, { sells: [row(1, 100, 7, "new-own")], buys: [] });
  clock += 1000;
  const second = await fixtureB.proxy.Handle_GetOrders([TYPE], SESSION);
  assert.strictEqual(fixtureB.calls.length - before, 1);
  assert.strictEqual(result.runtime.reader.stats().cacheHits, 1);
  const ids = second.sells.map((r) => r.order_id);
  assert.deepStrictEqual(ids, ["new-own", "21"]);
  assert.ok(!ids.includes("old-own"));

  const fixtureC = makeFixture();
  fixtureC.books.set(2, { sells: [row(2, 200, 8, "21")], buys: [] });
  const applied = apply(fixtureC);
  await Promise.all([
    fixtureC.proxy.Handle_GetOrders([TYPE], SESSION),
    fixtureC.proxy.Handle_GetOrders([TYPE], { regionid: 2 }),
  ]);
  const statsC = applied.result.runtime.reader.stats();
  assert.strictEqual(statsC.fanouts, 1);
  assert.strictEqual(statsC.inflightJoins, 1);
});

test("T6 guards and limits: wrap log, consumed/region_id, viewer cut to N, TTL, eviction, limit 0", async () => {
  const fixture = makeFixture();
  fixture.books.set(1, { sells: [row(1, 100, 999, "11")], buys: [] });
  fixture.books.set(2, { sells: [row(2, 200, 5, "21"), row(2, 200, 8, "22")], buys: [] });
  fixture.books.set(3, { sells: [row(3, 300, 7, "31")], buys: [] });
  let clock = 1000;
  const { result, logs } = apply(fixture, { maxForeignRowsPerSide: 1, cacheMaxTypes: 1 }, { now: () => clock });
  assert.ok(logs.includes("wrapped daemon (MarketDaemonClient.prototype.call)"));
  assert.ok(logs.includes("wrapped proxy (MarketProxyService.prototype.Handle_GetOrders)"));
  assert.strictEqual(result.runtime.state.proxyWrapped, true);
  assert.strictEqual(result.runtime.state.daemonWrapped, true);
  const reader = result.runtime.reader;

  const out = await fixture.proxy.Handle_GetOrders([TYPE], SESSION);
  assert.deepStrictEqual(out.sells.map((r) => r.order_id), ["11", "21"]);

  const scope = { regionID: 1, typeID: TYPE, consumed: false };
  const before = fixture.calls.length;
  const [other, first, second] = await result.runtime.als.run(scope, async () => [
    await fixture.daemon.call("GetOrders", { region_id: 2, type_id: TYPE }),
    await fixture.daemon.call("GetOrders", { region_id: 1, type_id: TYPE }),
    await fixture.daemon.call("GetOrders", { region_id: 1, type_id: TYPE }),
  ]);
  assert.deepStrictEqual(first.sells.map((r) => r.order_id), ["11", "21"]);
  assert.deepStrictEqual(second.sells.map((r) => r.order_id), ["11"]);
  assert.deepStrictEqual(other.sells.map((r) => r.order_id), ["21", "22"]);
  assert.strictEqual(fixture.calls.length - before, 3);
  assert.strictEqual(reader.stats().requests, 2);

  assert.strictEqual(reader.stats().fanouts, 1);
  clock += configModule.DEFAULTS.cacheTtlMs;
  await fixture.proxy.Handle_GetOrders([TYPE], SESSION);
  assert.strictEqual(reader.stats().fanouts, 2);

  await fixture.proxy.Handle_GetOrders([TYPE + 1], SESSION);
  assert.strictEqual(reader.stats().cacheSize, 1);
  await fixture.proxy.Handle_GetOrders([TYPE], SESSION);
  assert.strictEqual(reader.stats().fanouts, 4);
  assert.ok(reader.stats().cacheSize <= 1);

  const zero = makeFixture();
  zero.books.set(1, { sells: [row(1, 100, 1, "11")], buys: [] });
  zero.books.set(2, { sells: [row(2, 200, 1, "21")], buys: [] });
  const appliedZero = apply(zero, { maxForeignRowsPerSide: 0 });
  const own = await zero.proxy.Handle_GetOrders([TYPE], SESSION);
  assert.strictEqual(zero.calls.length, 1);
  assert.deepStrictEqual(own.sells.map((r) => r.order_id), ["11"]);
  assert.strictEqual(appliedZero.result.runtime.reader.stats().fanouts, 0);
});

test("T7 install: api.stats reports proxyWrapped/daemonWrapped", () => {
  const Module = require("node:module");
  const originalLoad = Module._load;
  const apiKey = Symbol.for(loader.API_SYMBOL);
  try {
    const installed = loader.install({ environment: {}, runtimeRoot });
    assert.strictEqual(installed.active, true);
    const api = globalThis[apiKey];
    assert.strictEqual(api, installed.api);
    assert.strictEqual(api.stats().proxyWrapped, false);
    assert.strictEqual(api.stats().daemonWrapped, false);
    const fixture = makeFixture();
    assert.strictEqual(installed.runtime.applyDaemon(fixture.daemonExports).ok, true);
    assert.strictEqual(installed.runtime.applyProxy(fixture.proxyExports).ok, true);
    assert.strictEqual(api.stats().proxyWrapped, true);
    assert.strictEqual(api.stats().daemonWrapped, true);
  } finally {
    Module._load = originalLoad;
    delete globalThis[apiKey];
    delete globalThis[loader.INSTALL_FLAG];
  }
});

async function main() {
  const started = Date.now();
  const selected = only ? tests.filter((t) => only.some((fragment) => t.name.includes(fragment))) : tests;
  if (only && selected.length === 0) {
    console.error(`--only ${only.join(",")}: no test matches`);
    process.exitCode = 2;
    return;
  }
  let failed = 0;
  for (const entry of selected) {
    try {
      await entry.fn();
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${entry.name}`);
      console.error(`     ${(error && error.stack) || error}`);
    }
  }
  const ms = Date.now() - started;
  console.log(`\n${selected.length - failed}/${selected.length} PASS (${ms} ms)${only ? ` [only ${selected.length} of ${tests.length}]` : ""}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`runner crashed: ${(error && error.stack) || error}`);
  process.exitCode = 1;
});
