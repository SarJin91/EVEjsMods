"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const loader = require("../../loader");
const { createSitePolicyHubScope, wrapPolicyScope, wrapHubUpgrades, WRAPPED_POLICY_SCOPE, WRAPPED_HUB_UPGRADES } =
  require("../../lib/adapter/sitePolicyHubs");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const FAKE_ROOT = path.join(path.sep, "x", "server");
const SOV_REQUEST = path.join(FAKE_ROOT, "src", "services", "sovereignty", "sovModernState");
const SITE_REQUEST = path.join(FAKE_ROOT, "src", "services", "dungeon", "dungeonSiteSpawnPolicy");
const EMPTY_HUBS = [1001, 1002, 1003];
const UPGRADED_HUB = 2001;
const IDENTITY = Object.freeze({ allianceID: 99000001 });

function findSrcDir() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function fakeSov() {
  const calls = [];
  const sov = {
    getHubUpgrades(hubID, identity = null) {
      const result = identity && identity.allianceID !== IDENTITY.allianceID
        ? { ok: false, errorCode: "FORBIDDEN_REQUEST" }
        : { hubID, upgrades: hubID === UPGRADED_HUB ? [{ typeID: 81615, powerState: 2 }] : [], settled: true };
      calls.push({ self: this, args: [...arguments], result });
      return result;
    },
    getHubUpgradesPendingPersistence(hubID) {
      if (hubID === UPGRADED_HUB) return { hubID, upgrades: [{ typeID: 81615, powerState: 1 }] };
      if (EMPTY_HUBS.includes(hubID)) return { hubID, upgrades: [] };
      return null;
    },
  };
  return { sov, calls };
}

function fakeSites(sov) {
  return {
    buildRuntimeSystemPolicyContext(systemID) {
      const payload = sov.getHubUpgrades(systemID);
      return { systemID, hubUpgrades: payload && Array.isArray(payload.upgrades) ? payload.upgrades : [] };
    },
  };
}

function loaderHooks(world) {
  const counts = [];
  const lines = [];
  const logger = { log: (m) => lines.push(m), debug: () => {}, logError: (m) => lines.push(m) };
  const ctx = {
    state: {}, logger, telemetry: { hooks: { onCount: (name, n) => counts.push(`${name}:${n}`) } },
    loadConfig: () => ({ ok: true, config: { enabled: true, debug: false, dataDir: "/x",
      modules: { world: { enabled: true } }, world }, sources: {}, warnings: [], errors: [] }),
  };
  const hooks = loader.buildHooks(ctx);
  const by = (name) => hooks.find((h) => h.name === name);
  const names = hooks.map((h) => h.name);
  return { ctx, counts, lines, names, upgradesHook: by("sitePolicyHubUpgrades"), scopeHook: by("sitePolicyHubScope") };
}

module.exports = ({ test }) => {
  test("T1 sitePolicyHubs loader hooks: in scope 3 hubs without upgrades -> original getHubUpgrades 0 calls, "
    + "upgrades []; counters FAST; flag off -> exports untouched", () => {
    const on = loaderHooks({ sitePolicyHubFastPathEnabled: true, siteProjectionEnabled: false });
    assert.ok(on.names.indexOf("sitePolicyHubScope") > on.names.indexOf("siteFactionProjection"),
      "the scope hook runs after the projection hook (outermost frame)");
    const { sov, calls } = fakeSov();
    const sites = fakeSites(sov);
    assert.strictEqual(on.upgradesHook.match(SOV_REQUEST, sov), true);
    assert.strictEqual(on.scopeHook.match(SITE_REQUEST, sites), true);
    on.upgradesHook.run(sov);
    on.scopeHook.run(sites);
    assert.deepStrictEqual([on.ctx.state.sitePolicyHubs, on.ctx.state.sitePolicyHubScope], ["wrapped", "wrapped"]);
    const results = EMPTY_HUBS.map((hubID) => sites.buildRuntimeSystemPolicyContext(hubID));
    assert.strictEqual(calls.length, 0, "no global settle inside the scope");
    assert.deepStrictEqual(results.map((r) => r.hubUpgrades), [[], [], []]);
    assert.deepStrictEqual(on.counts, ["world.sitePolicyHubs.FAST:1", "world.sitePolicyHubs.FAST:1",
      "world.sitePolicyHubs.FAST:1"]);
    sov.getHubUpgrades(1001);
    assert.strictEqual(calls.length, 1, "a player call out of scope goes to the vendor");
    assert.strictEqual(on.counts.length, 3, "OUT_OF_SCOPE is not counted");

    const off = loaderHooks({ sitePolicyHubFastPathEnabled: false });
    const vendor = fakeSov().sov;
    const originalUpgrades = vendor.getHubUpgrades;
    const offSites = fakeSites(vendor);
    const originalPolicy = offSites.buildRuntimeSystemPolicyContext;
    off.upgradesHook.run(vendor);
    off.scopeHook.run(offSites);
    assert.strictEqual(vendor.getHubUpgrades, originalUpgrades);
    assert.strictEqual(offSites.buildRuntimeSystemPolicyContext, originalPolicy);
    assert.deepStrictEqual([off.ctx.state.sitePolicyHubs, off.ctx.state.sitePolicyHubScope], ["disabled", "disabled"]);
  });

  test("T2 sitePolicyHubs: hub with upgrades, identity, out of scope -> the original with the same this, arguments "
    + "and result object", () => {
    const { sov, calls } = fakeSov();
    const scope = createSitePolicyHubScope();
    const outcomes = [];
    const wrap = wrapHubUpgrades(sov.getHubUpgrades, (id) => sov.getHubUpgradesPendingPersistence(id), scope,
      (o) => outcomes.push(o));
    assert.strictEqual(wrap.ok, true);
    const caller = Object.freeze({ getHubUpgrades: wrap.wrapped });
    scope.enter();
    const withUpgrades = caller.getHubUpgrades(UPGRADED_HUB);
    const withIdentity = caller.getHubUpgrades(1001, IDENTITY);
    scope.exit();
    const outOfScope = caller.getHubUpgrades(1002);
    assert.deepStrictEqual(calls.map((c) => [c.self === caller, c.args]),
      [[true, [UPGRADED_HUB]], [true, [1001, IDENTITY]], [true, [1002]]]);
    const results = [withUpgrades, withIdentity, outOfScope];
    results.forEach((r, i) => assert.strictEqual(r, calls[i].result, `result ${i} is the original's object`));
    assert.strictEqual(withUpgrades.upgrades[0].powerState, 2, "settled powerState, not the pending one");
    assert.deepStrictEqual(outcomes, ["HAS_UPGRADES", "OUT_OF_SCOPE", "OUT_OF_SCOPE"]);
  });

  test("T3 sitePolicyHubs: readPending throws / null -> original; a throwing policy closes the scope, the throw "
    + "goes on", () => {
    const { sov, calls } = fakeSov();
    const scope = createSitePolicyHubScope();
    const outcomes = [];
    let mode = "throw";
    const read = (id) => {
      if (mode === "throw") throw new Error("vendor read failed");
      return sov.getHubUpgradesPendingPersistence(id);
    };
    const wrapped = wrapHubUpgrades(sov.getHubUpgrades, read, scope, (o) => outcomes.push(o)).wrapped;
    scope.enter();
    const failed = wrapped(1001);
    mode = "null";
    const noHub = wrapped(4242);
    scope.exit();
    assert.deepStrictEqual(calls.map((c) => c.args), [[1001], [4242]]);
    assert.strictEqual(failed.settled, true);
    assert.strictEqual(noHub.settled, true);
    assert.deepStrictEqual(outcomes, ["FAILED", "NO_HUB"]);

    const policy = wrapPolicyScope(() => { throw new Error("vendor policy threw"); }, scope);
    assert.strictEqual(policy.ok, true);
    assert.throws(() => policy.wrapped(30000142), /vendor policy threw/);
    assert.strictEqual(scope.active(), false, "finally closed the scope");
    assert.deepStrictEqual(wrapHubUpgrades(sov.getHubUpgrades, null, scope), { ok: false, reason: "READ_NOT_A_FUNCTION" });
    assert.deepStrictEqual(wrapPolicyScope(() => {}, {}), { ok: false, reason: "SCOPE_INVALID" });
    assert.deepStrictEqual(wrapPolicyScope(null, scope), { ok: false, reason: "NOT_A_FUNCTION" });
  });

  test("T4 sitePolicyHubs: reentrancy keeps the scope open until the outer policy ends; a second wrap is a noop", () => {
    const scope = createSitePolicyHubScope();
    const trace = [];
    let inner = null;
    const outer = wrapPolicyScope(function outerPolicy() {
      trace.push(`outer-in:${scope.active()}`);
      inner();
      trace.push(`after-inner:${scope.active()}`);
      return "outer";
    }, scope).wrapped;
    inner = wrapPolicyScope(function innerPolicy() { trace.push(`inner:${scope.active()}`); }, scope).wrapped;
    assert.strictEqual(outer(), "outer");
    assert.deepStrictEqual(trace, ["outer-in:true", "inner:true", "after-inner:true"]);
    assert.strictEqual(scope.active(), false);
    assert.strictEqual(outer[WRAPPED_POLICY_SCOPE], true);
    assert.deepStrictEqual(wrapPolicyScope(outer, scope), { ok: true, wrapped: outer, noop: true });
    const hub = wrapHubUpgrades(() => null, () => null, scope).wrapped;
    assert.strictEqual(hub[WRAPPED_HUB_UPGRADES], true);
    assert.deepStrictEqual(wrapHubUpgrades(hub, () => null, scope), { ok: true, wrapped: hub, noop: true });
  });

  test("T5 vendor facts freeze: the policy reads getHubUpgrades through the module object, the pending read "
    + "skips the settle, the detector loop walks every sov source system", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const policy = fs.readFileSync(path.join(src, "services", "dungeon", "dungeonSiteSpawnPolicy.js"), "utf8");
    assert.ok(policy.includes("sovModernState.getHubUpgrades(hubID)"), "module object call without identity");
    assert.ok(policy.includes("extractHubUpgrades(sovModernState.getHubUpgrades(hubID))"), "only .upgrades consumer");
    const modern = fs.readFileSync(path.join(src, "services", "sovereignty", "sovModernState.js"), "utf8");
    assert.ok(/module\.exports = \{[\s\S]*\n {2}getHubUpgrades,\r?\n {2}getHubUpgradesPendingPersistence,/.test(modern),
      "both symbols exported");
    assert.ok(modern.includes("buildHubUpgradePayloadState(hubID, false)"), "pending read without settle");
    assert.ok(modern.includes("if (settleFuel) settleAllHubFuel({ forRead: true });"), "the settle being skipped");
    const runtime = fs.readFileSync(path.join(src, "services", "dungeon", "dungeonUniverseRuntime.js"), "utf8");
    const start = runtime.indexOf("function buildExplorationDetectorDefinitions(");
    assert.ok(start >= 0, "detector builder exists");
    const body = runtime.slice(start, runtime.indexOf("\nfunction ", start + 1));
    assert.ok(body.includes("for (const sourceSystemID of listSovereigntySourceSystemIDs())"), "loop over sov systems");
  });
};
