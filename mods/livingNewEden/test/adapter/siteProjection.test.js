"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { wrapSitePolicyContext, decideSiteFaction, WRAPPED_SITE_PROJECTION } = require("../../lib/adapter/siteProjection");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const SANSHA = 500019;
const GURISTAS = 500010;
const AMARR = 500003;
const TABLE = Object.freeze({ [SANSHA]: "sanshas", [GURISTAS]: "guristas" });

const SYS_SANSHA = 30001001;
const SYS_WH = 31000005;
const SYS_POCHVEN = 30001002;
const SYS_FREE = 30001003;
const SYS_EMPIRE = 30001004;
const SYS_SAME = 30001005;
const SYS_UNAVAILABLE = 30001006;
const SYS_TX = 30001007;
const SYS_THROW = 30001008;
const CONTROLLERS = new Map([[SYS_SANSHA, SANSHA], [SYS_WH, SANSHA], [SYS_POCHVEN, SANSHA], [SYS_EMPIRE, AMARR],
  [SYS_SAME, GURISTAS]]);

function findSrcDir() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function readController(id) {
  if (id === SYS_UNAVAILABLE) return { ok: false, reason: "WORLD_UNAVAILABLE" };
  if (id === SYS_TX) return { ok: false, reason: "TX_FAILED" };
  if (id === SYS_THROW) throw new Error("boom");
  return { ok: true, controllerFactionId: CONTROLLERS.has(id) ? CONTROLLERS.get(id) : null };
}

function resolveVendorFaction(id) {
  return { factionKey: "guristas", wormholeSpace: id === SYS_WH, specialSpace: id === SYS_POCHVEN };
}

function harness() {
  const calls = [];
  const outcomes = [];
  function original(systemID, options) {
    calls.push({ self: this, args: [...arguments], length: arguments.length });
    return { systemID, localPirateFactionKey: options && options.localPirateFactionKey };
  }
  const wrap = wrapSitePolicyContext(original, {
    pirateKeyByFactionId: TABLE, readController, resolveVendorFaction,
    onOutcome: (outcome, reason) => outcomes.push(`${outcome}:${reason}`),
  });
  assert.strictEqual(wrap.ok, true, JSON.stringify(wrap));
  return { original, wrapped: wrap.wrapped, calls, outcomes };
}

module.exports = ({ test, bench }) => {
  test("T1 site projection: pirate controller != vendor faction -> localPirateFactionKey of the controller, other "
    + "options and this kept, counter projected", () => {
    const h = harness();
    const self = { tag: "runtime" };
    const options = { includeCandidates: true, nowMs: 5 };
    const result = h.wrapped.call(self, SYS_SANSHA, options);
    assert.deepStrictEqual(result, { systemID: SYS_SANSHA, localPirateFactionKey: "sanshas" });
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].self, self, "this kept");
    assert.deepStrictEqual(h.calls[0].args, [SYS_SANSHA, { includeCandidates: true, nowMs: 5,
      localPirateFactionKey: "sanshas" }]);
    assert.notStrictEqual(h.calls[0].args[1], options, "a copy, the caller's options untouched");
    assert.deepStrictEqual(options, { includeCandidates: true, nowMs: 5 });
    assert.deepStrictEqual(h.outcomes, ["projected:CONTROLLER_PIRATE"]);
    h.wrapped(SYS_SANSHA);
    assert.deepStrictEqual(h.calls[1].args, [SYS_SANSHA, { localPirateFactionKey: "sanshas" }]);
    assert.strictEqual(h.wrapped[WRAPPED_SITE_PROJECTION], true);
    const again = wrapSitePolicyContext(h.wrapped, { pirateKeyByFactionId: TABLE, readController, resolveVendorFaction });
    assert.deepStrictEqual(again, { ok: true, wrapped: h.wrapped, noop: true });
  });

  test("T2 site projection: bit in bit for explicit options, WH, special space, no controller, empire, same as "
    + "vendor, read refusals and a throwing read; counters vendor / failed", () => {
    const cases = [
      { id: SYS_SANSHA, options: { localPirateFactionKey: "angels" }, outcome: "vendor:EXPLICIT_OVERRIDE" },
      { id: SYS_SANSHA, options: { localPirateFactionResolution: { factionKey: "angels" } },
        outcome: "vendor:EXPLICIT_OVERRIDE" },
      { id: SYS_WH, options: {}, outcome: "vendor:WORMHOLE" },
      { id: SYS_POCHVEN, options: {}, outcome: "vendor:SPECIAL_SPACE" },
      { id: SYS_FREE, options: {}, outcome: "vendor:NO_CONTROLLER" },
      { id: SYS_EMPIRE, options: {}, outcome: "vendor:NOT_PIRATE" },
      { id: SYS_SAME, options: {}, outcome: "vendor:SAME_AS_VENDOR" },
      { id: SYS_UNAVAILABLE, options: {}, outcome: "vendor:READ_WORLD_UNAVAILABLE" },
      { id: SYS_TX, options: {}, outcome: "failed:READ_TX_FAILED" },
      { id: SYS_THROW, options: {}, outcome: "failed:FAILED" },
      { id: 0, options: {}, outcome: "vendor:BAD_SYSTEM_ID" },
    ];
    const seen = [];
    for (const c of cases) {
      const h = harness();
      const self = { tag: c.outcome };
      h.wrapped.call(self, c.id, c.options);
      const call = h.calls[0];
      seen.push([c.outcome, h.outcomes[0], call.self === self, call.args[1] === c.options, call.length,
        call.args[1].localPirateFactionKey]);
    }
    assert.deepStrictEqual(seen, cases.map((c) => [c.outcome, c.outcome, true, true, 2,
      c.options.localPirateFactionKey]));
    const h = harness();
    h.wrapped(SYS_FREE);
    assert.strictEqual(h.calls[0].length, 1);
    const deps = (resolve) => ({ pirateKeyByFactionId: TABLE, readController, resolveVendorFaction: resolve });
    assert.deepStrictEqual(decideSiteFaction(SYS_SANSHA, {}, deps(() => { throw new Error("x"); })),
      { key: null, reason: "VENDOR_THREW" });
    assert.deepStrictEqual(decideSiteFaction(SYS_SANSHA, {}, deps(() => null)), { key: null, reason: "VENDOR_NO_RESULT" });
    assert.deepStrictEqual(wrapSitePolicyContext(null, {}), { ok: false, reason: "NOT_A_FUNCTION" });
    assert.deepStrictEqual(wrapSitePolicyContext(() => 1, { readController, resolveVendorFaction }),
      { ok: false, reason: "PIRATE_TABLE_INVALID" });
    assert.deepStrictEqual(wrapSitePolicyContext(() => 1, { pirateKeyByFactionId: TABLE, resolveVendorFaction }),
      { ok: false, reason: "READ_CONTROLLER_NOT_A_FUNCTION" });
    assert.deepStrictEqual(wrapSitePolicyContext(() => 1, { pirateKeyByFactionId: TABLE, readController }),
      { ok: false, reason: "VENDOR_RESOLVER_NOT_A_FUNCTION" });
  });

  test("T3 vendor facts: the site policy context passes localPirateFactionKey as an explicit "
    + "override; one require of the module, never destructured", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const policy = fs.readFileSync(path.join(src, "services", "dungeon", "dungeonSiteSpawnPolicy.js"), "utf8");
    assert.ok(/^function buildRuntimeSystemPolicyContext\(systemID, options = \{\}\) \{/m.test(policy), "definer");
    const exportsBlock = policy.slice(policy.lastIndexOf("module.exports = {"));
    assert.ok(/^\s{2}buildRuntimeSystemPolicyContext,$/m.test(exportsBlock), "exported");
    const body = policy.slice(policy.indexOf("function buildRuntimeSystemPolicyContext("));
    const head = body.slice(0, body.indexOf("let claim"));
    assert.ok(head.includes("options.localPirateFactionResolution"), "explicit resolution wins");
    assert.ok(head.includes("pirateFactionPolicy.resolvePirateFactionForSystem(numericSystemID, {")
      && head.includes("factionKey: options.localPirateFactionKey,"), "factionKey: options.localPirateFactionKey");
    assert.ok(policy.indexOf("../../space/npc/pirateFactionPolicy") < policy.indexOf("module.exports"), "hook order");

    const pirate = fs.readFileSync(path.join(src, "space", "npc", "pirateFactionPolicy.js"), "utf8");
    const resolve = pirate.slice(pirate.indexOf("function resolvePirateFactionForSystem("));
    const explicit = resolve.slice(0, resolve.indexOf("isWormholeSpaceSystem(numericSystemID)"));
    assert.ok(explicit.includes("normalizeExplicitFactionKey(options.factionKey)")
      && explicit.includes("\"explicit_override\""), "factionKey -> explicit_override before the WH branch");
    const built = pirate.slice(pirate.indexOf("function buildSystemFactionResolution("));
    const builtEnd = built.search(/\r?\n\}\r?\n/);
    assert.ok(builtEnd > 0, "buildSystemFactionResolution found");
    const builtBody = built.slice(0, builtEnd);
    assert.ok(/^\s+factionKey,$/m.test(builtBody), "resolution field factionKey");
    assert.ok(/^\s+specialSpace: /m.test(builtBody), "resolution field specialSpace");
    assert.ok(/^\s+wormholeSpace: /m.test(builtBody), "resolution field wormholeSpace");
    assert.ok(resolve.includes("return buildSystemFactionResolution("), "resolvePirateFactionForSystem returns it");

    assert.deepStrictEqual(scanConsumers(src, path.join(src, "services", "dungeon")), EXPECTED_CONSUMERS);
  });

  if (typeof bench === "function") {
    bench("T3full vendor facts: one require of dungeonSiteSpawnPolicy in the whole server/src "
      + "buildRuntimeSystemPolicyContext never destructured", () => {
      const src = findSrcDir();
      assert.ok(src, "EveJS server/src not found above the mod");
      assert.deepStrictEqual(scanConsumers(src, src), EXPECTED_CONSUMERS);
    });
  }
};

const EXPECTED_CONSUMERS = Object.freeze({
  requirers: [path.join("services", "dungeon", "dungeonUniverseRuntime.js")], destructured: [],
});

function scanConsumers(src, dir) {
  const requirers = [];
  const destructured = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (!text.includes("dungeonSiteSpawnPolicy") && !text.includes("buildRuntimeSystemPolicyContext")) continue;
      if (/require\([^)]*dungeonSiteSpawnPolicy/.test(text)) requirers.push(path.relative(src, full));
      if (/\{[^}]*\bbuildRuntimeSystemPolicyContext\b[^}]*\}\s*=/.test(text)) destructured.push(path.relative(src, full));
    }
  };
  walk(dir);
  return { requirers, destructured };
}
