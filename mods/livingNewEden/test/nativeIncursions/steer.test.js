"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { narrowCatalog } = require("../../lib/adapter/data/incursionSteer");
const { createIncursionNative, PLACEMENT_PATH } = require("../../lib/adapter/incursionNative");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const INCURSION = path.join(SERVER_SRC, "services", "incursion");
const PLACEMENT_FILE = path.join(INCURSION, "incursionFocusPlacement.js");
const CONTRACT_FILE = path.join(INCURSION, "incursionLifecycleContract.js");
const LIFECYCLE_FILE = path.join(INCURSION, "incursionLifecycle.js");
const RUNTIME_FILE = path.join(INCURSION, "incursionFocusRuntime.js");
const SEED = "a".repeat(64);
const CONST_A = 20000001;
const CONST_B = 20000002;
const CONST_H = 20000003;
const REGION = 10000002;

const textOf = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function constellation(base, constellationID, security, n) {
  const systems = [];
  const stargates = [];
  for (let i = 1; i <= n; i += 1) {
    systems.push({ solarSystemID: base + i, constellationID, regionID: REGION, security, factionID: 500019 });
    if (i > 1) stargates.push([base + i - 1, base + i]);
  }
  stargates.push([base + 1, base + 3]);
  return { systems, stargates };
}

function geography() {
  const parts = [constellation(30000000, CONST_A, -0.5, 6), constellation(30000010, CONST_B, -0.3, 6),
    constellation(30000020, CONST_H, 0.9, 4)];
  const systems = parts.flatMap((p) => p.systems);
  const stargates = parts.flatMap((p) => p.stargates).flatMap(([a, b]) => [
    { solarSystemID: a, destinationSolarSystemID: b }, { solarSystemID: b, destinationSolarSystemID: a }]);
  return { systems, stargates };
}

function vendorValidatePlacement(contract) {
  const text = textOf(LIFECYCLE_FILE);
  const helper = (name) => {
    const m = new RegExp(`^const ${name} = .*;$`, "m").exec(text);
    assert.ok(m, `helper ${name}`);
    return m[0];
  };
  const start = text.indexOf("function validatePlacement(");
  const end = text.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "validatePlacement in incursionLifecycle.js");
  const body = `${helper("positive")}\n${helper("keyValid")}\n${text.slice(start, end + 2)}\nreturn validatePlacement;`;
  // eslint-disable-next-line no-new-func
  return new Function("contract", "fail", "SCENE", body)(contract, contract.fail, contract.SCENE);
}

module.exports = ({ test, skip }) => {
  const missing = [PLACEMENT_FILE, CONTRACT_FILE, LIFECYCLE_FILE, RUNTIME_FILE].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    skip("NI1-NI2 native incursion steering", `vendor file not found: ${missing.map((f) => path.basename(f)).join(", ")}`);
    return;
  }
  const placement = require(PLACEMENT_FILE);
  const contract = require(CONTRACT_FILE);
  const catalog = placement.buildCatalog(geography());
  const opts = (extra = {}) => ({ seed: SEED, selectionKey: "null:1", securityBand: "null", ...extra });
  const deps = { fingerprint: contract.fingerprint, affectedCount: catalog.policy.affectedSystemCount };

  test("NI1 narrowCatalog on the real vendor: target in the plan, 4 systems, 13 slots, validatePlacement; occupied "
    + "-> NO_MATCH; deterministic", () => {
    assert.strictEqual(catalog.components.length, 3, "three components");
    const target = 30000014;
    const n = narrowCatalog(catalog, [{ systemId: target }], opts(), deps);
    assert.strictEqual(n.ok, true, JSON.stringify(n));
    assert.deepStrictEqual(n.target, { systemId: target, constellationId: CONST_B });
    const plan = placement.selectPlacement(n.catalog, opts());
    assert.strictEqual(plan.constellationID, CONST_B);
    assert.strictEqual(plan.systems.length, 4);
    assert.ok(plan.systems.some((s) => s.solarSystemID === target), "target in the plan");
    assert.strictEqual(plan.siteSlots.length, 13);
    const byId = new Map(geography().systems.map((s) => [s.solarSystemID, s]));
    const validate = vendorValidatePlacement(contract);
    validate(plan, (id) => byId.get(id), contract.getProfile(contract.ORGANIC_FOCUS_PROFILES.null));
    assert.deepStrictEqual(narrowCatalog(catalog, [{ systemId: target }], opts({ occupiedConstellationIDs: [CONST_B] }),
      deps), { ok: false, reason: "NO_MATCH" });
    assert.deepStrictEqual(narrowCatalog(catalog, [{ systemId: target }], opts({ occupiedSystemIDs: [30000016] }),
      deps), { ok: false, reason: "NO_MATCH" });
    const second = narrowCatalog(catalog, [{ systemId: 30000024 }, { systemId: 30000003 }], opts(), deps);
    assert.strictEqual(second.target.systemId, 30000003, "high target skipped in the null band");
    const again = narrowCatalog(catalog, [{ systemId: target }], opts(), deps);
    assert.deepStrictEqual(again, n);
    assert.deepStrictEqual(placement.selectPlacement(again.catalog, opts()), plan);
  });

  test("NI2 wrapper on fake modules: passthrough, steer + log, exclusive null, narrow throw, drift, adoption", () => {
    const files = { [path.join(SERVER_SRC, ...`${PLACEMENT_PATH}.js`.split("/"))]: textOf(PLACEMENT_FILE),
      [RUNTIME_FILE]: textOf(RUNTIME_FILE) };
    const fakePlacement = { ...placement };
    const original = fakePlacement.selectPlacement;
    const modules = { [PLACEMENT_PATH]: fakePlacement, "services/incursion/incursionLifecycleContract": contract };
    const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "missing" });
    const core = (overrides = {}) => createIncursionNative({ requireGame, serverSrc: () => SERVER_SRC, nowMs: () => 7,
      readFile: (abs) => (Object.prototype.hasOwnProperty.call(overrides, abs) ? overrides[abs]
        : Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : null) });
    const a = core();
    assert.deepStrictEqual(a.setSteerTargets(null, "steer"), { ok: true, installed: false });
    assert.strictEqual(fakePlacement.selectPlacement, original);
    const drifted = core({ [path.join(SERVER_SRC, ...`${PLACEMENT_PATH}.js`.split("/"))]: `${textOf(PLACEMENT_FILE)}//` });
    const d = drifted.setSteerTargets({ null: [{ systemId: 30000014 }] }, "steer");
    assert.strictEqual(d.reason, "INCURSION_STEER_DRIFT");
    assert.strictEqual(fakePlacement.selectPlacement, original);
    assert.strictEqual(drifted.stats().drift, true);
    assert.deepStrictEqual(a.setSteerTargets({ null: [{ systemId: 30000014 }] }, "steer"), { ok: true, installed: true });
    const wrapped = fakePlacement.selectPlacement;
    assert.notStrictEqual(wrapped, original);
    const vanillaHigh = original(catalog, opts({ securityBand: "high", selectionKey: "high:1" }));
    assert.deepStrictEqual(wrapped(catalog, opts({ securityBand: "high", selectionKey: "high:1" })), vanillaHigh,
      "a band without targets = vanilla");
    const plan = wrapped(catalog, opts());
    assert.ok(plan.systems.some((s) => s.solarSystemID === 30000014));
    assert.deepStrictEqual(a.stats().steerLog, [{ selectionKey: "null:1", systemId: 30000014, constellationId: CONST_B,
      atMs: 7 }]);
    const occupied = opts({ occupiedConstellationIDs: [CONST_B] });
    assert.deepStrictEqual(wrapped(catalog, occupied), original(catalog, occupied));
    a.setSteerTargets({ null: [{ systemId: 30000014 }] }, "exclusive");
    assert.strictEqual(wrapped(catalog, occupied), null);
    let reads = 0;
    const tricky = { ...catalog };
    Object.defineProperty(tricky, "policy", { enumerable: true, get() {
      reads += 1;
      if (reads === 1) throw new Error("boom");
      return catalog.policy;
    } });
    assert.deepStrictEqual(wrapped(tricky, opts()), original(catalog, opts()));
    const s1 = a.stats();
    assert.deepStrictEqual([s1.hits, s1.exclusiveNull, s1.errors], [1, 1, 1]);
    assert.strictEqual(s1.passthrough, 2);
    const b = core();
    assert.deepStrictEqual(b.setSteerTargets({ null: [{ systemId: 30000014 }] }, "steer"), { ok: true, installed: true });
    assert.strictEqual(fakePlacement.selectPlacement, wrapped, "one layer");
    wrapped(catalog, opts({ selectionKey: "null:2" }));
    assert.strictEqual(a.stats().hits, 2);
    assert.strictEqual(b.stats().hits, 2);
    b.setSteerTargets(null, "steer");
    assert.deepStrictEqual(wrapped(catalog, opts({ selectionKey: "null:3" })), original(catalog, opts({ selectionKey: "null:3" })));
    assert.strictEqual(b.stats().hits, 2);

    const abs = (rel) => path.join(SERVER_SRC, ...`${rel}.js`.split("/"));
    const realCache = (lifecycle) => ({
      [abs(PLACEMENT_PATH)]: { exports: { ...placement } },
      [abs("services/incursion/incursionLifecycleContract")]: { exports: { ...contract,
        organicSchedulingEnabled: (band) => band === "high" } },
      [abs("services/incursion/incursionLifecycle")]: { exports: lifecycle },
      [abs("services/incursion/incursionRewardStore")]: { exports: { read: () => ({ participants: [
        { characterID: 7, netLP: 5 }, { characterID: 9, netLP: 50 }] }) } },
      [abs("gameStore/index")]: { exports: { read: () => ({ success: false, errorMsg: "TABLE_NOT_FOUND", data: null }) } },
    });
    const real = (lifecycle) => {
      const moduleApi = { _cache: realCache(lifecycle) };
      const adapter = createAdapter({ moduleApi, existsSync: () => false,
        readFileSync: (p) => fs.readFileSync(p, "utf8") });
      assert.deepStrictEqual(adapter.setServerSrc(SERVER_SRC), { ok: true, reason: null });
      return { adapter, moduleApi };
    };
    for (const rel of [PLACEMENT_PATH, "services/incursion/incursionLifecycleContract",
      "services/incursion/incursionLifecycle", "services/incursion/incursionRewardStore"]) {
      assert.ok(GAME_MODULES.some((e) => e.path === rel), `GAME_MODULES has ${rel}`);
    }
    const ok = real({ listTales: () => [], getTale: () => null });
    const okReport = ok.adapter.runProbe();
    assert.strictEqual(okReport.disabledModules.nativeIncursions, undefined, "probe passes our seams");
    assert.deepStrictEqual(ok.adapter.nativeIncursionsListTales({ limit: 4 }), { ok: true, tales: [], truncated: false });
    assert.deepStrictEqual(ok.adapter.nativeIncursionsBossParticipants("rcpt-1", 1), { ok: true, characterIds: [9] });
    assert.deepStrictEqual(ok.adapter.nativeIncursionsVendorBands(), { ok: true,
      bands: { high: true, low: false, null: false } });
    assert.deepStrictEqual(ok.adapter.nativeIncursionsSetTargets({ null: [{ systemId: 30000014 }] }, "steer"),
      { ok: true, installed: true });
    const installed = ok.moduleApi._cache[abs(PLACEMENT_PATH)].exports.selectPlacement;
    assert.ok(installed(catalog, opts()).systems.some((s) => s.solarSystemID === 30000014), "steered via the adapter");
    const drift = real({});
    const report = drift.adapter.runProbe();
    assert.strictEqual(report.disabledModules.nativeIncursions,
      "drift:services/incursion/incursionLifecycle.listTales");
    const { nativeIncursions: _ours, ...others } = report.disabledModules;
    assert.deepStrictEqual(others, { ...okReport.disabledModules }, "the DRIFT disables only nativeIncursions");
    const refused = drift.adapter.nativeIncursionsListTales({ limit: 4 });
    assert.strictEqual(refused.reason, "INCURSION_RUNTIME_UNAVAILABLE");
    assert.ok(String(refused.detail).startsWith("drift_"), refused.detail);
  });
};
