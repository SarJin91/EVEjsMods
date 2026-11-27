"use strict";

process.env.EVEJS_PDRILL_NO_INSTALL = "1";
process.env.EVEJS_SKYHOOKFIX_NO_INSTALL = "1";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const loader = require(path.join(modDir, "loader.js"));
const configModule = require(path.join(modDir, "config.js"));
const viability = require(path.join(modDir, "lib", "viability.js"));
const overlay = require(path.join(modDir, "lib", "overlay.js"));
const launch = require(path.join(modDir, "lib", "launch.js"));
const launchLedger = require(path.join(modDir, "lib", "launchLedger.js"));
const os = require("node:os");

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? null : String(process.argv[onlyAt + 1] || "").split(",").filter(Boolean);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const CFG = Object.freeze({ ...configModule.DEFAULTS, enabled: true });
const P0_A = 2268;
const P0_B = 2267;
const P0_C = 2288;

const HISEC_SYSTEM = 30003830;
const HISEC_PLANET = Object.freeze({ itemID: 40242000, groupID: 7, kind: "planet", solarSystemID: HISEC_SYSTEM, typeID: 2016, security: 0.6 });
const HISEC_PLANET_2 = Object.freeze({ itemID: 40242010, groupID: 7, kind: "planet", solarSystemID: HISEC_SYSTEM, typeID: 2016, security: 0.6 });
const SOV_PLANET = Object.freeze({ itemID: 40000002, groupID: 7, kind: "planet", solarSystemID: 30000001, typeID: 11, security: -0.3 });
const CELESTIALS = new Map([HISEC_PLANET, HISEC_PLANET_2, SOV_PLANET].map((planet) => [planet.itemID, planet]));

function skyhook(itemID, planet, extra = {}) {
  return { itemID, typeID: 81080, planetID: planet.itemID, solarSystemID: planet.solarSystemID, ownerID: 98000001, corporationID: 98000001, state: 1, ...extra };
}

function makeSnapshot() {
  const sovDefinition = { planetID: SOV_PLANET.itemID, solarSystemID: SOV_PLANET.solarSystemID, power: 3, workforce: 4, reagentDefinitions: [{ reagentTypeID: 81143 }] };
  const version = { major: 24, minor: 1, patch: 0, prerelease_tags: [], build_tags: ["evejs"] };
  return {
    sovDefinition,
    version,
    snapshot: {
      planetDefinitions: [sovDefinition],
      planetDefinitionsByPlanetID: new Map([[SOV_PLANET.itemID, sovDefinition]]),
      planetDefinitionsVersion: version,
      planetsBySolarSystemID: new Map([[SOV_PLANET.solarSystemID, [SOV_PLANET.itemID]]]),
    },
  };
}

function fakeVendor(orbitals, { qualities = { [P0_A]: 30, [P0_B]: 10 }, names = {} } = {}) {
  const calls = { readOrbitalState: 0, invalidate: 0, ready: 0 };
  const vendor = {
    revision: 1,
    calls,
    ready() {
      calls.ready += 1;
      return true;
    },
    getRevision: () => vendor.revision,
    readOrbitalState() {
      calls.readOrbitalState += 1;
      return { orbitalsByID: Object.fromEntries(orbitals.map((row) => [String(row.itemID), row])), replacementsByPlanet: {} };
    },
    findItem: (id) => ({ itemID: id, typeID: 81080, itemName: names[id] || "Orbital Skyhook" }),
    getCelestial: (id) => CELESTIALS.get(Number(id)) || null,
    resourceTypeIDs: () => [P0_A, P0_B],
    qualities: () => qualities,
    invalidate() {
      calls.invalidate += 1;
    },
  };
  return vendor;
}

const silent = () => {};

test("T1 pickReagent: highest quality, [PI:] tag, [P1] ignored, no resources; preferredTypeID (variant) wins over the tag", () => {
  const base = { resourceTypeIDs: [P0_B, P0_A], qualities: { [P0_A]: 30, [P0_B]: 10 }, cfg: CFG };
  assert.deepStrictEqual(overlay.pickReagent({ ...base, name: "Orvolle I" }),
    { ok: true, reagentTypeID: P0_A, amountPerCycle: 15000, tag: "none", pick: "auto" });
  assert.deepStrictEqual(overlay.pickReagent({ ...base, name: `Drill [PI:${P0_B}]` }),
    { ok: true, reagentTypeID: P0_B, amountPerCycle: 5000, tag: "used", pick: "tag" });
  assert.deepStrictEqual(overlay.pickReagent({ ...base, name: "Drill [P1]" }),
    { ok: true, reagentTypeID: P0_A, amountPerCycle: 15000, tag: "none", pick: "auto" });
  assert.strictEqual(overlay.pickReagent({ ...base, name: `[PI:${P0_C}]` }).reagentTypeID, P0_A);
  assert.strictEqual(overlay.pickReagent({ ...base, name: `[PI:${P0_C}]` }).tag, "ignored");
  assert.deepStrictEqual(overlay.pickReagent({ ...base, name: `[PI:${P0_A}]`, preferredTypeID: P0_B }),
    { ok: true, reagentTypeID: P0_B, amountPerCycle: 5000, tag: "none", pick: "variant" });
  assert.deepStrictEqual(overlay.pickReagent({ ...base, name: `[PI:${P0_B}]`, preferredTypeID: P0_C }),
    { ok: true, reagentTypeID: P0_B, amountPerCycle: 5000, tag: "used", pick: "variant-ignored" });
  assert.deepStrictEqual(overlay.pickReagent({ ...base, name: "", preferredTypeID: P0_C }),
    { ok: true, reagentTypeID: P0_A, amountPerCycle: 15000, tag: "none", pick: "variant-ignored" });
  assert.deepStrictEqual(overlay.pickReagent({ ...base, qualities: { [P0_A]: 5, [P0_B]: 5 }, name: "", cfg: { ...CFG, cycleSeconds: 60 } }),
    { ok: true, reagentTypeID: P0_B, amountPerCycle: 166, tag: "none", pick: "auto" });
  assert.deepStrictEqual(overlay.pickReagent({ ...base, qualities: { [P0_A]: 0, [P0_B]: 0 }, name: "" }),
    { ok: false, reason: "NO_RESOURCES" });
  assert.deepStrictEqual(overlay.pickReagent({ resourceTypeIDs: [], qualities: {}, name: "", cfg: CFG }),
    { ok: false, reason: "NO_RESOURCES" });
});

test("T2 selectDrills: skips vanilla sov planets, destroyed, pending deployment, other types; corporation limit", () => {
  const orbitals = [
    skyhook(1000005, HISEC_PLANET),
    skyhook(1000001, SOV_PLANET),
    skyhook(1000002, HISEC_PLANET_2, { destroyedAtMs: 123 }),
    skyhook(1000003, HISEC_PLANET_2, { typeID: 2233 }),
    skyhook(1000004, HISEC_PLANET_2),
  ];
  const options = {
    vendorPlanetIDs: new Set([SOV_PLANET.itemID]),
    pendingByPlanet: { [HISEC_PLANET_2.itemID]: { completed: false, launchedItemID: 1000004 } },
    itemOf: (id) => ({ itemID: id, itemName: `Hook ${id}` }),
    planetOf: (id) => CELESTIALS.get(id) || null,
    cfg: CFG,
  };
  assert.deepStrictEqual(overlay.selectDrills(orbitals, options).map((drill) => drill.skyhookID), [1000005]);

  const drill = overlay.selectDrills(orbitals, options)[0];
  assert.deepStrictEqual({ ...drill, planet: undefined }, {
    skyhookID: 1000005, planetID: HISEC_PLANET.itemID, solarSystemID: HISEC_SYSTEM,
    corporationID: 98000001, name: "Hook 1000005", planet: undefined,
  });

  const done = { ...options, pendingByPlanet: { [HISEC_PLANET_2.itemID]: { completed: true, launchedItemID: 1000004 } } };
  assert.deepStrictEqual(overlay.selectDrills(orbitals, done).map((entry) => entry.skyhookID), [1000004, 1000005]);
  assert.deepStrictEqual(overlay.selectDrills(orbitals, { ...done, cfg: { ...CFG, maxPerCorporation: 1 } })
    .map((entry) => entry.skyhookID), [1000004]);
  assert.deepStrictEqual(overlay.selectDrills(orbitals, { ...done, cfg: { ...CFG, maxPerSystem: 0, maxPerCorporation: 0 } })
    .map((entry) => entry.skyhookID), [1000004, 1000005]);
});

test("T3 applyOverlay: array + Map + tagged version; identical overlay unchanged; empty restores the original", () => {
  const { snapshot, sovDefinition, version } = makeSnapshot();
  const state = overlay.createBase(snapshot);
  const drills = [{ skyhookID: 1000005, planetID: HISEC_PLANET.itemID, solarSystemID: HISEC_SYSTEM }];
  const pick = () => ({ ok: true, reagentTypeID: P0_A, amountPerCycle: 15000 });
  const built = overlay.buildOverlay(drills, pick, CFG);
  assert.match(built.hash, /^[0-9a-f]{8}$/u);
  assert.deepStrictEqual(built.rows, [{
    planetID: HISEC_PLANET.itemID, solarSystemID: HISEC_SYSTEM, power: 0, workforce: 0,
    reagentDefinitions: [{ reagentTypeID: P0_A, amountPerCycle: 15000, cyclePeriodSeconds: 3600, securedPercentage: 100,
      securedCapacity: 15000 * 168, unsecuredCapacity: 0, securedStock: 0, unsecuredStock: 0 }],
  }]);

  assert.deepStrictEqual(overlay.applyOverlay(snapshot, built, state), { changed: true });
  assert.strictEqual(snapshot.planetDefinitions.length, 2);
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET.itemID), built.rows[0]);
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID.get(SOV_PLANET.itemID), sovDefinition);
  assert.deepStrictEqual(snapshot.planetDefinitionsVersion.prerelease_tags, ["pdrill", built.hash]);
  assert.deepStrictEqual(snapshot.planetDefinitionsVersion.build_tags, ["evejs"]);
  assert.deepStrictEqual(version.prerelease_tags, [], "original version object untouched");
  assert.deepStrictEqual([...snapshot.planetsBySolarSystemID.keys()], [SOV_PLANET.solarSystemID]);

  const again = overlay.buildOverlay(drills, pick, CFG);
  assert.deepStrictEqual(overlay.applyOverlay(snapshot, again, state), { changed: false });
  assert.strictEqual(snapshot.planetDefinitions.length, 2);

  assert.deepStrictEqual(overlay.applyOverlay(snapshot, overlay.EMPTY_OVERLAY, state), { changed: true });
  assert.deepStrictEqual(snapshot.planetDefinitions, [sovDefinition]);
  assert.deepStrictEqual([...snapshot.planetDefinitionsByPlanetID.entries()], [[SOV_PLANET.itemID, sovDefinition]]);
  assert.strictEqual(snapshot.planetDefinitionsVersion, version, "exactly the original version object");

  const hostile = overlay.buildOverlay([{ skyhookID: 1, planetID: SOV_PLANET.itemID, solarSystemID: 30000001 }], pick, CFG);
  assert.deepStrictEqual(overlay.applyOverlay(snapshot, hostile, state), { changed: false });
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID.get(SOV_PLANET.itemID), sovDefinition);
  assert.deepStrictEqual(snapshot.planetDefinitions, [sovDefinition]);
});

test("T4 sync: same revision = fast path without orbital reads; new revision = rebuild + one deferred invalidate", () => {
  const { snapshot } = makeSnapshot();
  const vendor = fakeVendor([skyhook(1000005, HISEC_PLANET)]);
  const deferred = [];
  const lines = [];
  const sync = overlay.createSync({ vendor, cfg: CFG, logFn: (line) => lines.push(line), logErrorFn: silent, defer: (fn) => deferred.push(fn) });

  assert.strictEqual(sync.sync(snapshot).reason, "rebuilt");
  assert.strictEqual(vendor.calls.readOrbitalState, 1);
  assert.strictEqual(vendor.calls.invalidate, 0, "invalidate is deferred past the current call stack");
  deferred.splice(0).forEach((fn) => fn());
  assert.strictEqual(vendor.calls.invalidate, 1);
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET.itemID).reagentDefinitions[0].reagentTypeID, P0_A);
  assert.ok(lines.some((line) => /^overlay rev=1 drills=1 planets=\[40242000\] hash=[0-9a-f]{8}$/u.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => line === `skyhook=1000005 planet=40242000 reagent=${P0_A} mode=P0 amount=15000 pick=auto tag=none`), lines.join("\n"));

  for (let index = 0; index < 5; index += 1) assert.strictEqual(sync.sync(snapshot).reason, "fast-path");
  assert.strictEqual(vendor.calls.readOrbitalState, 1);
  assert.strictEqual(sync.stats.syncFastPath, 5);

  vendor.revision = 2;
  assert.strictEqual(sync.sync(snapshot).reason, "unchanged");
  assert.strictEqual(vendor.calls.readOrbitalState, 2);
  assert.strictEqual(deferred.length, 0);

  vendor.revision = 3;
  vendor.readOrbitalState = () => {
    throw new Error("boom");
  };
  const errors = [];
  const failing = overlay.createSync({ vendor, cfg: CFG, logFn: silent, logErrorFn: (line) => errors.push(line), defer: (fn) => fn() });
  assert.strictEqual(failing.sync(snapshot).reason, "exception");
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(snapshot.planetDefinitions.length, 2);
});

test("T5 wrapper on the real sovStaticData, chained after skyhookOrphanFix: disabled is transparent, enabled serves the drill", () => {
  const sovFile = path.join(runtimeRoot, "server", "src", "services", "sovereignty", "sovStaticData.js");
  const orphanLoader = require(path.join(runtimeRoot, "mods", "skyhookOrphanFix", "loader.js"));
  const exportsObject = require(sovFile);
  const vanilla = exportsObject.getSovereigntyStaticSnapshot;
  const world = { getCelestialByID: (id) => CELESTIALS.get(Number(id)) || null };
  try {
    const orphan = orphanLoader._testing.createRuntime({ runtimeRoot, inspect: () => ({ ok: true, reports: [] }), logFn: silent, logErrorFn: silent });
    orphan.applyWorld(world);
    assert.deepStrictEqual(orphan.applySov(exportsObject), { ok: true });

    const offVendor = fakeVendor([skyhook(1000005, HISEC_PLANET)]);
    const off = loader._testing.createRuntime({ runtimeRoot, cfg: { ...CFG, enabled: false }, inspect: () => ({ ok: true, reports: [] }), vendor: offVendor, defer: (fn) => fn(), logFn: silent, logErrorFn: silent });
    assert.deepStrictEqual(off.applySov(exportsObject), { ok: true });
    const snapshot = exportsObject.getSovereigntyStaticSnapshot();
    const before = JSON.stringify(snapshot.planetDefinitions);
    const versionBefore = snapshot.planetDefinitionsVersion;
    exportsObject.getSovereigntyStaticSnapshot();
    assert.strictEqual(exportsObject.getSovereigntyStaticSnapshot(), snapshot, "same memoised object");
    assert.strictEqual(JSON.stringify(snapshot.planetDefinitions), before);
    assert.strictEqual(snapshot.planetDefinitionsVersion, versionBefore);
    assert.strictEqual(offVendor.calls.ready + offVendor.calls.readOrbitalState, 0);
    assert.deepStrictEqual(snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET.itemID).reagentDefinitions, []);

    const onVendor = fakeVendor([skyhook(1000005, HISEC_PLANET)]);
    const inner = exportsObject.getSovereigntyStaticSnapshot;
    exportsObject.getSovereigntyStaticSnapshot = function unmarked() {
      return inner.apply(this, arguments);
    };
    const on = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: () => ({ ok: true, reports: [] }), vendor: onVendor, defer: (fn) => fn(), logFn: silent, logErrorFn: silent });
    assert.deepStrictEqual(on.applySov(exportsObject), { ok: true });
    assert.strictEqual(exportsObject.getSovereigntyStaticSnapshot(), snapshot);
    const row = snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET.itemID);
    assert.strictEqual(row.reagentDefinitions[0].reagentTypeID, P0_A, "drill row wins over the orphan empty definition");
    assert.ok(snapshot.planetDefinitions.includes(row), "planet published in the client definition list");
    assert.deepStrictEqual(snapshot.planetDefinitionsVersion.prerelease_tags.slice(0, 1), ["pdrill"]);
    assert.deepStrictEqual(snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET_2.itemID).reagentDefinitions, [], "other non-sov planet: orphan empty");
    assert.strictEqual(onVendor.calls.invalidate, 1);

    const drifted = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: () => ({ ok: false, reports: [{ ok: false, key: "x", reason: "y" }] }), vendor: onVendor, logFn: silent, logErrorFn: silent });
    const fakeExports = { getSovereigntyStaticSnapshot: () => makeSnapshot().snapshot };
    assert.deepStrictEqual(drifted.applySov(fakeExports), { ok: false, reason: "drift" });
    assert.strictEqual(drifted.state.inert, true);
  } finally {
    exportsObject.getSovereigntyStaticSnapshot = vanilla;
  }
});

test("T7: limit counted after pickReagent; over-limit skyhook gets an amount 0 row; NO_RESOURCES planet gets no row", () => {
  const planetA = { itemID: 40242020, groupID: 7, kind: "planet", solarSystemID: HISEC_SYSTEM, typeID: 2016 };
  const planets = new Map([HISEC_PLANET, HISEC_PLANET_2, planetA].map((planet) => [planet.itemID, planet]));
  const orbitals = [skyhook(1000001, planetA), skyhook(1000002, HISEC_PLANET), skyhook(1000003, HISEC_PLANET_2)];
  const pick = (drill) => (drill.planetID === planetA.itemID
    ? { ok: false, reason: "NO_RESOURCES" }
    : { ok: true, reagentTypeID: P0_A, amountPerCycle: 15000, tag: "none" });
  const cfg = { ...CFG, maxPerSystem: 1 };
  const options = { vendorPlanetIDs: new Set(), itemOf: (id) => ({ itemID: id, itemName: "" }), planetOf: (id) => planets.get(id) || null, cfg, pick };

  const plan = overlay.planDrills(orbitals, options);
  assert.deepStrictEqual(plan.drills.map((drill) => drill.skyhookID), [1000002]);
  assert.deepStrictEqual(plan.limited.map((drill) => drill.skyhookID), [1000003]);
  assert.deepStrictEqual(plan.skipped.map(({ drill, reason }) => [drill.skyhookID, reason]), [[1000001, "NO_RESOURCES"]]);

  const built = overlay.buildOverlay(plan.drills, pick, cfg, { limited: plan.limited, skipped: plan.skipped });
  assert.deepStrictEqual(built.rows.map((row) => row.planetID), [HISEC_PLANET.itemID, HISEC_PLANET_2.itemID], "no row for the NO_RESOURCES planet");
  assert.strictEqual(built.rows[0].reagentDefinitions[0].amountPerCycle, 15000, "selected drill unchanged");
  assert.deepStrictEqual(built.rows[1].reagentDefinitions, [{ reagentTypeID: P0_A, amountPerCycle: 0, cyclePeriodSeconds: 3600,
    securedPercentage: 100, securedCapacity: 15000 * 168, unsecuredCapacity: 0, securedStock: 0, unsecuredStock: 0 }]);
  const unlimited = overlay.buildOverlay([...plan.drills, ...plan.limited], pick, cfg);
  assert.notStrictEqual(built.hash, unlimited.hash, "a drill leaving/entering the limit changes the version tag");

  const { snapshot } = makeSnapshot();
  const vendor = fakeVendor(orbitals);
  vendor.getCelestial = (id) => planets.get(Number(id)) || null;
  vendor.qualities = (planet) => (planet.itemID === planetA.itemID ? {} : { [P0_A]: 30, [P0_B]: 10 });
  const lines = [];
  const sync = overlay.createSync({ vendor, cfg, logFn: (line) => lines.push(line), logErrorFn: silent, defer: (fn) => fn() });
  assert.strictEqual(sync.sync(snapshot).reason, "rebuilt");
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID.has(planetA.itemID), false);
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET_2.itemID).reagentDefinitions[0].amountPerCycle, 0);
  assert.ok(lines.some((line) => /^overlay rev=1 drills=1 limited=1 planets=\[40242000,40242010\] hash=[0-9a-f]{8}$/u.test(line)), lines.join("\n"));
  assert.ok(lines.includes(`skyhook=1000003 planet=40242010 reagent=${P0_A} mode=P0 amount=0 reason=limit pick=auto tag=none`), lines.join("\n"));
  assert.ok(lines.includes("skyhook=1000001 planet=40242020 skipped reason=NO_RESOURCES"), lines.join("\n"));
});

test("T8: WARN when a previous drill changes its P0 ([PI:] rename) or leaves the overlay", () => {
  const { snapshot } = makeSnapshot();
  const orbitals = [skyhook(1000005, HISEC_PLANET), skyhook(1000006, HISEC_PLANET_2)];
  const names = {};
  const vendor = fakeVendor(orbitals, { names });
  const lines = [];
  const sync = overlay.createSync({ vendor, cfg: CFG, logFn: (line) => lines.push(line), logErrorFn: silent, defer: (fn) => fn() });
  assert.strictEqual(sync.sync(snapshot).reason, "rebuilt");
  assert.deepStrictEqual(lines.filter((line) => line.startsWith("WARN")), [], "first overlay: nothing to compare");

  names[1000005] = `Drill [PI:${P0_B}]`;
  vendor.revision = 2;
  lines.length = 0;
  assert.strictEqual(sync.sync(snapshot).reason, "rebuilt");
  assert.deepStrictEqual(lines.filter((line) => line.startsWith("WARN")),
    [`WARN skyhook=1000005 planet=40242000 reagent=${P0_A}->${P0_B} - stock of ${P0_A} will be lost`]);

  orbitals.splice(1, 1);
  vendor.revision = 3;
  lines.length = 0;
  assert.strictEqual(sync.sync(snapshot).reason, "rebuilt");
  assert.deepStrictEqual(lines.filter((line) => line.startsWith("WARN")),
    [`WARN skyhook=1000006 planet=40242010 reagent=${P0_A} left the overlay reason=gone - no longer produced, stock of ${P0_A} will be lost`]);

  orbitals.splice(0, 1, skyhook(1000007, HISEC_PLANET));
  names[1000007] = `Drill [PI:${P0_B}]`;
  vendor.revision = 4;
  lines.length = 0;
  assert.strictEqual(sync.sync(snapshot).reason, "unchanged");
  assert.deepStrictEqual(lines.filter((line) => line.startsWith("WARN")),
    [`WARN skyhook=1000005 planet=40242000 reagent=${P0_B} left the overlay reason=gone - no longer produced, stock of ${P0_B} will be lost`]);
  names[1000007] = `Drill [PI:${P0_A}]`;
  vendor.revision = 5;
  lines.length = 0;
  assert.strictEqual(sync.sync(snapshot).reason, "rebuilt");
  assert.deepStrictEqual(lines.filter((line) => line.startsWith("WARN")),
    [`WARN skyhook=1000007 planet=40242000 reagent=${P0_B}->${P0_A} - stock of ${P0_B} will be lost`]);

  vendor.resourceTypeIDs = () => [];
  vendor.revision = 6;
  lines.length = 0;
  assert.strictEqual(sync.sync(snapshot).reason, "rebuilt");
  assert.deepStrictEqual(lines.filter((line) => line.startsWith("WARN")),
    [`WARN skyhook=1000007 planet=40242000 reagent=${P0_A} left the overlay reason=NO_RESOURCES - no longer produced, stock of ${P0_A} will be lost`]);

  const early = makeSnapshot().snapshot;
  const late = fakeVendor([skyhook(1000005, HISEC_PLANET)]);
  let ready = false;
  late.ready = () => ready;
  const earlyLines = [];
  const earlySync = overlay.createSync({ vendor: late, cfg: CFG, logFn: (line) => earlyLines.push(line), logErrorFn: silent, defer: (fn) => fn() });
  assert.strictEqual(earlySync.sync(early).reason, "not-ready");
  assert.strictEqual(earlySync.sync(early).reason, "not-ready");
  ready = true;
  assert.strictEqual(earlySync.sync(early).reason, "rebuilt");
  ready = false;
  assert.strictEqual(earlySync.sync(early).reason, "not-ready");
  assert.deepStrictEqual(earlyLines.filter((line) => line.startsWith("WARN")),
    ["WARN overlay not-ready before the first rebuild - the snapshot is served without drill rows (logged once)"]);

  const goodVendor = fakeVendor([skyhook(1000005, HISEC_PLANET)]);
  let goodReady = true;
  goodVendor.ready = () => goodReady;
  const goodLines = [];
  const goodSync = overlay.createSync({ vendor: goodVendor, cfg: CFG, logFn: (line) => goodLines.push(line), logErrorFn: silent, defer: (fn) => fn() });
  const good = makeSnapshot().snapshot;
  assert.strictEqual(goodSync.sync(good).reason, "rebuilt");
  goodReady = false;
  assert.strictEqual(goodSync.sync(good).reason, "not-ready");
  assert.deepStrictEqual(goodLines.filter((line) => line.startsWith("WARN")), []);
});

test("T6 vendor facts: probe ok on EveJS 261028.1, entrypoint order, config defaults", () => {
  const result = viability.inspect(runtimeRoot);
  assert.ok(result.ok, result.reports.filter((report) => !report.ok).map((report) => `${report.key}: ${report.reason}`).join("\n"));
  const read = (relative) => fs.readFileSync(path.join(runtimeRoot, ...relative.split("/")), "utf8").replace(/\r\n/gu, "\n");
  const sovModern = read("server/src/services/sovereignty/sovModernState.js");
  assert.ok(/function bootstrapSkyhooksFromSystems[\s\S]*?planetDefinitionsByPlanetID\.get\(/u.test(sovModern));
  assert.ok(read("server/src/services/sovereignty/skyhookRuntime.js").includes("reagentDefinitions[0]"));
  assert.ok(read("server/src/services/sovereignty/sovStaticData.js").includes("  getSovereigntyStaticSnapshot,\n"));
  assert.ok(read("server/src/services/planet/planetOrbitalState.js").includes("  getDeployedSkyhookRevision,\n"));

  const entrypoint = read("docker/entrypoint.sh");
  const line = "--require /app/mods/planetaryDrill/loader.js";
  assert.strictEqual(entrypoint.split(line).length - 1, 2);
  const blocks = entrypoint.split("exec node").slice(1);
  assert.strictEqual(blocks.length, 2);
  for (const block of blocks) {
    const at = block.indexOf(line);
    assert.ok(at > block.indexOf("--require /app/mods/skyhookOrphanFix/loader.js"));
    assert.ok(block.indexOf("--require /app/mods/skyhookOrphanFix/loader.js") >= 0);
    assert.ok(at < block.indexOf("--require /app/mods/livingNewEden/loader.js"));
  }

  const defaults = configModule.load(path.join(modDir, "no-such-dir"), {});
  assert.deepStrictEqual({ ...defaults, problems: [...defaults.problems] }, { ...configModule.DEFAULTS, problems: [] });
  const bad = configModule.load(path.join(modDir, "no-such-dir"), { EVEJS_PDRILL_CYCLE_SECONDS: "10", EVEJS_PDRILL_ENABLED: "maybe" });
  assert.strictEqual(bad.problems.length, 2);
  const on = configModule.load(path.join(modDir, "no-such-dir"), { EVEJS_PDRILL_ENABLED: "true", EVEJS_PDRILL_MAX_PER_SYSTEM: "0" });
  assert.strictEqual(on.enabled, true);
  assert.strictEqual(on.maxPerSystem, 0);
});

const DRILL_ITEM = 340100;
const PILOT = 90000001;
const CORP = 98000001;
const SHIP = 1001;
const SESSION = Object.freeze({ characterID: PILOT, corporationID: CORP, _space: Object.freeze({ shipID: SHIP, systemID: HISEC_SYSTEM }) });
const ok = () => ({ ok: true, reports: [] });
const tempDirs = [];

function tempLedgerFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdrill-test-"));
  tempDirs.push(dir);
  return path.join(dir, "mods", "planetaryDrill", "launch-ledger.json");
}

function cargoItem(itemID, extra = {}) {
  return { itemID, typeID: DRILL_ITEM, ownerID: PILOT, locationID: SHIP, flagID: 5, quantity: 1, singleton: 0, itemName: "Planetary Drill", ...extra };
}

function launchVendor(items) {
  const map = new Map(items.map((item) => [item.itemID, { ...item }]));
  const orbital = { replacementsByPlanet: {}, orbitalsByID: {} };
  const calls = { syncItem: [], updateItemType: 0, readOrbitalState: 0 };
  return {
    map,
    orbital,
    calls,
    launchReady: () => true,
    normalizeLaunchRequests: (raw) => (Array.isArray(raw) ? raw : [raw]).map((id) => ({ itemID: Number(id), quantity: 1 })),
    findItem: (id) => (map.has(Number(id)) ? { ...map.get(Number(id)) } : null),
    updateItemType(id, typeID) {
      calls.updateItemType += 1;
      const previous = map.get(Number(id));
      if (!previous) return { ok: false, reason: "ITEM_NOT_FOUND" };
      const item = { ...previous, typeID };
      map.set(Number(id), item);
      return { ok: true, item: { ...item }, previous: { ...previous } };
    },
    readOrbitalState() {
      calls.readOrbitalState += 1;
      return JSON.parse(JSON.stringify(orbital));
    },
    syncItem(session, item, previous) {
      calls.syncItem.push({ session, item, previous });
      return true;
    },
  };
}

function launchRuntime(vendor, ledgerFile, original, cfg = CFG) {
  const runtime = loader._testing.createRuntime({ runtimeRoot, cfg, inspect: ok, inspectLaunch: ok, vendor, ledgerFile, defer: (fn) => fn(), logFn: silent, logErrorFn: silent });
  const exportsObject = { launchOrbitalsFromShip: original, _testing: {} };
  assert.deepStrictEqual(runtime.applyLaunch(exportsObject), { ok: true });
  assert.notStrictEqual(exportsObject.launchOrbitalsFromShip, original);
  return { runtime, launchFn: exportsObject.launchOrbitalsFromShip };
}

test("T9 launch wrapper: no drill item = original untouched; singleton -> drills; stack 3 -> new Skyhook in drills, rest back to 340100", () => {
  {
    const file = tempLedgerFile();
    const vendor = launchVendor([cargoItem(5002, { typeID: 2233 })]);
    const seen = [];
    const answer = { success: true, launchedItemIDs: [5002] };
    const original = function original() {
      seen.push({ self: this, args: [...arguments] });
      return answer;
    };
    const { launchFn } = launchRuntime(vendor, file, original);
    const self = { service: true };
    const raw = [5002];
    const options = { ownerID: CORP };
    assert.strictEqual(launchFn.call(self, SESSION, raw, options), answer);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].self, self);
    assert.strictEqual(seen[0].args.length, 3);
    assert.strictEqual(seen[0].args[0], SESSION);
    assert.strictEqual(seen[0].args[1], raw);
    assert.strictEqual(seen[0].args[2], options);
    assert.strictEqual(fs.existsSync(file), false, "no ledger read or write");
    assert.strictEqual(vendor.calls.updateItemType + vendor.calls.readOrbitalState, 0);
  }

  {
    const file = tempLedgerFile();
    const vendor = launchVendor([cargoItem(5001)]);
    let typeSeen = 0;
    const { runtime, launchFn } = launchRuntime(vendor, file, (session, raw) => {
      typeSeen = vendor.findItem(raw[0]).typeID;
      vendor.orbital.replacementsByPlanet[String(HISEC_PLANET.itemID)] = { sourceItem: { itemID: 5001, typeID: 81080 }, launchedItemID: 5001, completed: false };
      vendor.map.set(5001, { ...vendor.map.get(5001), locationID: HISEC_SYSTEM, flagID: 0 });
      return { success: true };
    });
    launchFn(SESSION, [5001], {});
    assert.strictEqual(typeSeen, 81080);
    const ledger = launchLedger.readLedger(file);
    assert.deepStrictEqual(Object.keys(ledger.drills), ["5001"]);
    assert.deepStrictEqual(ledger.pending, {});
    assert.strictEqual(vendor.map.get(5001).typeID, 81080, "object in space stays 81080");
    assert.strictEqual(vendor.calls.syncItem.length, 0);
    assert.strictEqual(runtime.launchStats.launchRecorded, 1);
  }

  {
    const file = tempLedgerFile();
    const vendor = launchVendor([cargoItem(5003, { quantity: 3 })]);
    const { runtime, launchFn } = launchRuntime(vendor, file, () => {
      assert.strictEqual(vendor.map.get(5003).typeID, 81080);
      vendor.orbital.replacementsByPlanet[String(HISEC_PLANET.itemID)] = { sourceItem: { itemID: 5003 }, launchedItemID: 7001, completed: false };
      vendor.map.set(7001, { ...vendor.map.get(5003), itemID: 7001, quantity: 1, locationID: HISEC_SYSTEM, flagID: 0 });
      vendor.map.set(5003, { ...vendor.map.get(5003), quantity: 2 });
      return { success: true };
    });
    launchFn(SESSION, [5003], {});
    const ledger = launchLedger.readLedger(file);
    assert.deepStrictEqual(Object.keys(ledger.drills), ["7001"]);
    assert.strictEqual(ledger.drills["7001"].sourceItemID, 5003);
    assert.deepStrictEqual(ledger.pending, {});
    assert.strictEqual(vendor.map.get(5003).typeID, DRILL_ITEM);
    assert.strictEqual(vendor.map.get(7001).typeID, 81080);
    assert.strictEqual(vendor.calls.syncItem.length, 1);
    assert.strictEqual(vendor.calls.syncItem[0].session, SESSION);
    assert.strictEqual(vendor.calls.syncItem[0].previous.typeID, 81080);
    assert.strictEqual(vendor.calls.syncItem[0].item.typeID, DRILL_ITEM);
    assert.strictEqual(runtime.launchStats.launchReverted, 1);
  }

  {
    const file = tempLedgerFile();
    const vendor = launchVendor([cargoItem(5003, { quantity: 3 })]);
    vendor.orbital.replacementsByPlanet[String(HISEC_PLANET_2.itemID)] = { sourceItem: { itemID: 5003 }, launchedItemID: 6999, completed: true };
    const { runtime, launchFn } = launchRuntime(vendor, file, () => {
      vendor.orbital.replacementsByPlanet[String(HISEC_PLANET.itemID)] = { sourceItem: { itemID: 5003 }, launchedItemID: 7001, completed: false };
      vendor.map.set(7001, { ...vendor.map.get(5003), itemID: 7001, quantity: 1, locationID: HISEC_SYSTEM, flagID: 0 });
      vendor.map.set(5003, { ...vendor.map.get(5003), quantity: 2 });
      return { success: true };
    });
    launchFn(SESSION, [5003], {});
    assert.deepStrictEqual(Object.keys(launchLedger.readLedger(file).drills), ["7001"]);
    assert.strictEqual(runtime.launchStats.launchRecorded, 1);
    assert.deepStrictEqual(runtime.sweepNow(), { ok: true, reverted: 0, recorded: 0, pruned: 0 });
  }
});

test("T10 launch failure and saga: failed launch reverts; saga holding the source keeps 81080 until a sweep after restart; vendor throw reverts", () => {
  {
    const file = tempLedgerFile();
    const vendor = launchVendor([cargoItem(5001)]);
    const refusal = { success: false, errorMsg: "PLANET_ALREADY_HAS_ORBITAL" };
    const { launchFn } = launchRuntime(vendor, file, () => refusal);
    assert.strictEqual(launchFn(SESSION, [5001], {}), refusal);
    assert.strictEqual(vendor.map.get(5001).typeID, DRILL_ITEM);
    assert.deepStrictEqual(launchLedger.readLedger(file).pending, {});
    assert.strictEqual(vendor.calls.syncItem.length, 1);
  }

  {
    const file = tempLedgerFile();
    const vendor = launchVendor([cargoItem(5001)]);
    const planetKey = String(HISEC_PLANET.itemID);
    const { launchFn } = launchRuntime(vendor, file, () => {
      vendor.orbital.replacementsByPlanet[planetKey] = { sourceItem: { itemID: 5001, typeID: 81080 }, completed: false };
      return { success: false, errorMsg: "ITEM_CUSTODY_PENDING" };
    });
    launchFn(SESSION, [5001], {});
    assert.strictEqual(vendor.map.get(5001).typeID, 81080, "no revert while the saga holds the source");
    assert.deepStrictEqual(Object.keys(launchLedger.readLedger(file).pending), ["5001"]);

    const restarted = launchRuntime(vendor, file, () => ({ success: true }));
    assert.deepStrictEqual(restarted.runtime.sweepNow(), { ok: true, reverted: 0, recorded: 0, pruned: 0 }, "saga still holds");
    assert.strictEqual(vendor.map.get(5001).typeID, 81080);
    delete vendor.orbital.replacementsByPlanet[planetKey];
    assert.deepStrictEqual(restarted.runtime.sweepNow(), { ok: true, reverted: 1, recorded: 0, pruned: 0 });
    assert.strictEqual(vendor.map.get(5001).typeID, DRILL_ITEM);
    assert.deepStrictEqual(launchLedger.readLedger(file).pending, {});
  }

  {
    const file = tempLedgerFile();
    const vendor = launchVendor([cargoItem(5001)]);
    const { launchFn } = launchRuntime(vendor, file, () => {
      throw new Error("vendor boom");
    });
    assert.throws(() => launchFn(SESSION, [5001], {}), /vendor boom/u);
    assert.strictEqual(vendor.map.get(5001).typeID, DRILL_ITEM);
    assert.deepStrictEqual(launchLedger.readLedger(file).pending, {});
  }
});

test("T11 resolveSource: rules 1-6 and idempotence", () => {
  const cargo = { itemID: 5001, typeID: 81080, flagID: 5 };
  const resolve = (overrides) => launch.resolveSource({ sourceItemID: 5001, item: cargo, intents: [], drills: {}, targetTypeID: 81080, ...overrides });
  assert.deepStrictEqual(resolve({ intents: [{ sourceItem: { itemID: 5001 }, launchedItemID: 7001, completed: false }] }),
    { record: [7001], action: "REVERT", reason: "REVERTED" });
  assert.deepStrictEqual(resolve({ intents: [{ sourceItem: { itemID: 5001 }, launchedItemID: 7001, completed: true }], drills: { 7001: {} } }),
    { record: [], action: "REVERT", reason: "REVERTED" });
  assert.deepStrictEqual(resolve({ intents: [{ sourceItem: { itemID: 5001 }, completed: false }] }),
    { record: [], action: "HOLD", reason: "SAGA_HOLDS" });
  assert.strictEqual(resolve({ intents: [{ sourceItem: { itemID: 5009 }, completed: false }] }).action, "REVERT");
  assert.deepStrictEqual(resolve({ item: null }), { record: [], action: "DONE", reason: "SOURCE_GONE" });
  assert.deepStrictEqual(resolve({ item: { ...cargo, typeID: DRILL_ITEM } }), { record: [], action: "DONE", reason: "SOURCE_NOT_CONVERTED" });
  assert.deepStrictEqual(resolve({ item: { ...cargo, flagID: 0 } }), { record: [], action: "DONE", reason: "IN_SPACE" });
  assert.deepStrictEqual(resolve({ intents: [{ sourceItem: { itemID: 5001 }, launchedItemID: 5001, completed: false }] }),
    { record: [5001], action: "DONE", reason: "IN_SPACE" });
  assert.deepStrictEqual(resolve({}), { record: [], action: "REVERT", reason: "REVERTED" });

  const intents = [{ sourceItem: { itemID: 5001 }, launchedItemID: 7001, completed: false }];
  const first = resolve({ intents });
  const drills = Object.fromEntries(first.record.map((id) => [String(id), { sourceItemID: 5001 }]));
  assert.deepStrictEqual(resolve({ intents, drills, item: { ...cargo, typeID: DRILL_ITEM } }),
    { record: [], action: "DONE", reason: "SOURCE_NOT_CONVERTED" });
});

test("T12 overlay DRILL_ITEMS_ONLY: drill mines, other Skyhook amount 0 NOT_DRILL_ITEM without a slot; pending + intent mines; false = as before", () => {
  const orbitals = [skyhook(1000002, HISEC_PLANET), skyhook(1000003, HISEC_PLANET_2)];
  const pick = () => ({ ok: true, reagentTypeID: P0_A, amountPerCycle: 15000, tag: "none" });
  const base = { vendorPlanetIDs: new Set(), itemOf: (id) => ({ itemID: id, itemName: "" }), planetOf: (id) => CELESTIALS.get(id) || null, pick };
  const only = { ...CFG, maxPerSystem: 1, drillItemsOnly: true };
  const ids = (plan) => [plan.drills.map((drill) => drill.skyhookID), plan.limited.map((drill) => [drill.skyhookID, drill.reason || "limit"])];

  const inDrills = overlay.planDrills(orbitals, { ...base, cfg: only, isDrill: (drill) => drill.skyhookID === 1000003 });
  assert.deepStrictEqual(ids(inDrills), [[1000003], [[1000002, "NOT_DRILL_ITEM"]]], "the non-drill takes no slot");

  const vanilla = overlay.planDrills(orbitals, { ...base, cfg: { ...CFG, maxPerSystem: 1 }, isDrill: () => false });
  assert.deepStrictEqual(ids(vanilla), [[1000002], [[1000003, "limit"]]]);

  const { snapshot } = makeSnapshot();
  const vendor = fakeVendor(orbitals);
  const intent = { sourceItem: { itemID: 5001 }, launchedItemID: 1000003, completed: true };
  vendor.readOrbitalState = () => ({
    orbitalsByID: Object.fromEntries(orbitals.map((row) => [String(row.itemID), row])),
    replacementsByPlanet: { [HISEC_PLANET_2.itemID]: intent },
  });
  const ledger = { v: 1, pending: { 5001: { atMs: 1, typeID: DRILL_ITEM } }, drills: {} };
  const lines = [];
  const sync = overlay.createSync({ vendor, cfg: only, logFn: (line) => lines.push(line), logErrorFn: silent, defer: (fn) => fn(), readLaunchLedger: () => ledger });
  assert.strictEqual(sync.sync(snapshot).reason, "rebuilt");
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET_2.itemID).reagentDefinitions[0].amountPerCycle, 15000);
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET.itemID).reagentDefinitions[0].amountPerCycle, 0);
  assert.ok(lines.includes(`skyhook=1000002 planet=40242000 reagent=${P0_A} mode=P0 amount=0 reason=NOT_DRILL_ITEM pick=auto tag=none`), lines.join("\n"));

  let reads = 0;
  const offSync = overlay.createSync({ vendor, cfg: { ...CFG, maxPerSystem: 1 }, logFn: silent, logErrorFn: silent, defer: (fn) => fn(), readLaunchLedger: () => { reads += 1; return ledger; } });
  assert.strictEqual(offSync.sync(makeSnapshot().snapshot).reason, "rebuilt");
  assert.strictEqual(reads, 1);
});

test("T13 launch vendor facts + config + launch DRIFT leaves the overlay working", () => {
  const result = viability.inspectLaunch(runtimeRoot);
  assert.ok(result.ok, result.reports.filter((report) => !report.ok).map((report) => `${report.key}: ${report.reason}`).join("\n"));
  assert.deepStrictEqual(result.reports.map((report) => report.key), ["orbitalLaunchRuntime", "shipService", "itemCustody", "skyhookOfficeReplacement", "planetOrbitalState"]);
  const launchTokens = viability.LAUNCH_REQUIREMENTS.flatMap((definition) => definition.required.map(({ token }) => token));
  for (const token of ["    buildOrbitalSpawnState,", "    if (Array.isArray(entry)) {",
    "const planetID = orbitals.findNearestPlanetID(context.systemID, spawnState.position);",
    "function findNearestPlanetID(solarSystemID, position = null) {"]) {
    assert.ok(launchTokens.includes(token), token);
  }
  const launchRuntimeSource = fs.readFileSync(path.join(runtimeRoot, "server", "src", "services", "ship", "orbitalLaunchRuntime.js"), "utf8").replace(/\r\n/gu, "\n");
  assert.ok(/function buildNotifyErrorTuple\(message\) \{(?:(?!\n\}\n)[\s\S])*?\n\s+return \[\n\s+"CustomNotify",\n\s+buildDict\(\[\["notify",/u.test(launchRuntimeSource),
    "vendor fact: launch errors reach the client as CustomNotify {notify: text}");
  assert.ok(launchRuntimeSource.includes("errorMsg: launchedItemIDs.length > 0 ? null : \"NO_VALID_ORBITALS\","));
  const read = (relative) => fs.readFileSync(path.join(runtimeRoot, ...relative.split("/")), "utf8").replace(/\r\n/gu, "\n");
  assert.ok(read("server/src/services/ship/shipService.js").includes("const {\n  launchOrbitalsFromShip,\n} = require("), "destructured at load");
  assert.ok(/CUSTODY_REASON\.SKYHOOK_DEPLOY && Number\(currentItem\.typeID\) !== 81080/u.test(read("server/src/services/inventory/itemCustody.js")));
  assert.ok(/updateInventoryItem\(record\.itemID, \(currentItem\) => \(\{\n\s+\.\.\.currentItem,\n\s+typeID: TYPE_CUSTOMS_OFFICE,/u
    .test(read("server/src/services/planet/planetOrbitalState.js")), "precedent: typeID changed through updateInventoryItem");
  assert.ok(read("server/src/services/inventory/itemStore.js").includes("  CARGO_HOLD: 5,"));
  assert.strictEqual(launch.CARGO_HOLD_FLAG, 5);
  assert.ok(read("server/src/config/dataRoot.js").includes("function resolveDataRoot(env = process.env) {"));

  const noDir = path.join(modDir, "no-such-dir");
  const defaults = configModule.load(noDir, {});
  assert.strictEqual(defaults.launchTypeID, 340100);
  assert.strictEqual(defaults.drillItemsOnly, false);
  assert.strictEqual(configModule.load(noDir, { EVEJS_PDRILL_LAUNCH_TYPE_ID: "12345" }).problems.length, 1);
  assert.strictEqual(configModule.load(noDir, { EVEJS_PDRILL_LAUNCH_TYPE_ID: "350000" }).problems.length, 1);
  const off = configModule.load(noDir, { EVEJS_PDRILL_LAUNCH_TYPE_ID: "0", EVEJS_PDRILL_DRILL_ITEMS_ONLY: "1" });
  assert.deepStrictEqual([off.problems.length, off.launchTypeID, off.drillItemsOnly], [0, 0, true]);

  const errors = [];
  const runtime = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: ok, inspectLaunch: () => ({ ok: false, reports: [{ ok: false, key: "orbitalLaunchRuntime", reason: "x" }] }), vendor: fakeVendor([]), defer: (fn) => fn(), logFn: silent, logErrorFn: (line) => errors.push(line) });
  const original = () => ({ success: true });
  const launchExports = { launchOrbitalsFromShip: original, _testing: {} };
  assert.deepStrictEqual(runtime.applyLaunch(launchExports), { ok: false, reason: "drift" });
  assert.strictEqual(runtime.state.launchInert, true);
  assert.strictEqual(launchExports.launchOrbitalsFromShip, original);
  assert.deepStrictEqual(runtime.applyLaunch(launchExports), { ok: false, reason: "inert" });
  assert.ok(errors.some((line) => line.startsWith("DRIFT launch orbitalLaunchRuntime")), errors.join("\n"));
  const sovExports = { getSovereigntyStaticSnapshot: () => makeSnapshot().snapshot };
  assert.deepStrictEqual(runtime.applySov(sovExports), { ok: true });
  assert.strictEqual(runtime.state.inert, false);
  const fresh = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: ok, inspectLaunch: ok, vendor: fakeVendor([]), logFn: silent, logErrorFn: silent });
  assert.deepStrictEqual(fresh.applyLaunch({}), { ok: false, reason: "pending" });
});

const variants = require(path.join(modDir, "lib", "variants.js"));
const VARIANT_AQ = 340104;
const readVendor = (relative) => fs.readFileSync(path.join(runtimeRoot, ...relative.split("/")), "utf8").replace(/\r\n/gu, "\n");

function vendorPlanetResources() {
  const source = readVendor("server/src/services/planet/planetStaticData.js");
  const resourceBlock = /const RESOURCE_TYPE = Object\.freeze\(\{\n([\s\S]*?)\n\}\);/u.exec(source)[1];
  const resourceType = Object.fromEntries([...resourceBlock.matchAll(/^\s+([A-Z_]+): (\d+),$/gmu)].map((m) => [m[1], Number(m[2])]));
  const planetBlock = /const PLANET_RESOURCES_BY_TYPE_ID = Object\.freeze\(\{\n([\s\S]*?)\n\}\);/u.exec(source)[1];
  const byPlanet = new Map([...planetBlock.matchAll(/^\s+(\d+): \[([^\]]*)\]/gmu)].map((m) => [Number(m[1]),
    [...m[2].matchAll(/RESOURCE_TYPE\.([A-Z_]+)/gu)].map((r) => resourceType[r[1]]).sort((a, b) => a - b)]));
  return { resourceType, byPlanet };
}

const LAVA_PLANET = Object.freeze({ itemID: 40242030, groupID: 7, kind: "planet", solarSystemID: HISEC_SYSTEM, typeID: 2015, security: 0.6, itemName: "Lava Test IV" });
const PLANET_P0 = new Map([
  [HISEC_PLANET.itemID, { resources: [P0_A, P0_B], qualities: { [P0_A]: 10, [P0_B]: 30 } }],
  [LAVA_PLANET.itemID, { resources: [2267, 2307], qualities: { 2267: 20, 2307: 20 } }],
]);

function variantVendor(items, planetID = HISEC_PLANET.itemID) {
  const vendor = launchVendor(items);
  const planets = new Map([HISEC_PLANET, LAVA_PLANET].map((planet) => [planet.itemID, planet]));
  Object.assign(vendor, {
    planetID,
    revision: 1,
    nearestPlanetID: () => vendor.planetID,
    getCelestial: (id) => planets.get(Number(id)) || null,
    resourceTypeIDs: (planet) => PLANET_P0.get(planet.itemID).resources,
    qualities: (planet) => PLANET_P0.get(planet.itemID).qualities,
    ready: () => true,
    getRevision: () => vendor.revision,
    invalidate: () => {},
  });
  return vendor;
}

function launchToSpace(vendor, sourceItemID, launchedItemID = sourceItemID) {
  const planetKey = String(HISEC_PLANET.itemID);
  vendor.orbital.replacementsByPlanet[planetKey] = { sourceItem: { itemID: sourceItemID, typeID: 81080 }, launchedItemID, completed: false };
  vendor.orbital.orbitalsByID[String(launchedItemID)] = skyhook(launchedItemID, HISEC_PLANET);
  const source = vendor.map.get(sourceItemID);
  if (launchedItemID === sourceItemID) {
    vendor.map.set(sourceItemID, { ...source, locationID: HISEC_SYSTEM, flagID: 0 });
  } else {
    vendor.map.set(launchedItemID, { ...source, itemID: launchedItemID, quantity: 1, locationID: HISEC_SYSTEM, flagID: 0 });
    vendor.map.set(sourceItemID, { ...source, quantity: source.quantity - 1 });
  }
}

function overlayAfterRestart(vendor, file) {
  const lines = [];
  const runtime = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: ok, inspectLaunch: ok, vendor, ledgerFile: file, defer: (fn) => fn(), logFn: (line) => lines.push(line), logErrorFn: silent });
  const { snapshot } = makeSnapshot();
  const sovExports = { getSovereigntyStaticSnapshot: () => snapshot };
  assert.deepStrictEqual(runtime.applySov(sovExports), { ok: true });
  sovExports.getSovereigntyStaticSnapshot();
  const row = snapshot.planetDefinitionsByPlanetID.get(HISEC_PLANET.itemID);
  return { reagent: row && row.reagentDefinitions[0].reagentTypeID, lines };
}

test("T-V1 variants.js: 15 variants 340102-340116, BP +100, P0 = RESOURCE_TYPE of the vendor, isLaunchType", () => {
  const { resourceType } = vendorPlanetResources();
  assert.strictEqual(variants.VARIANTS.length, 15);
  assert.deepStrictEqual(variants.VARIANTS.map((v) => v.typeID), Array.from({ length: 15 }, (_, i) => 340102 + i));
  assert.ok(variants.VARIANTS.every((v) => v.blueprintTypeID === v.typeID + 100));
  assert.deepStrictEqual(variants.VARIANTS.map((v) => v.p0TypeID), Object.values(resourceType).sort((a, b) => a - b));
  assert.strictEqual(new Set(variants.VARIANTS.map((v) => v.p0Name)).size, 15);
  assert.deepStrictEqual(variants.variantOf(VARIANT_AQ), { typeID: VARIANT_AQ, blueprintTypeID: 340204, p0TypeID: 2268, p0Name: "Aqueous Liquids" });
  assert.strictEqual(variants.variantOf(DRILL_ITEM), null);
  assert.deepStrictEqual([DRILL_ITEM, VARIANT_AQ, 340116, 340117, 81080].map((id) => variants.isLaunchType(id, CFG)), [true, true, true, false, false]);
  assert.strictEqual(variants.isLaunchType(VARIANT_AQ, { ...CFG, launchTypeID: 0 }), false);
  assert.strictEqual(variants.isLaunchType(0, { ...CFG, launchTypeID: 0 }), false);
});

test("T-V2 variant LAUNCHED: p0TypeID in pending and drills; after a restart the overlay mines the variant P0 (pick=variant), an old entry mines auto", () => {
  const file = tempLedgerFile();
  const vendor = variantVendor([cargoItem(5101, { typeID: VARIANT_AQ })]);
  let pendingSeen = null;
  const { runtime, launchFn } = launchRuntime(vendor, file, (session, raw) => {
    assert.deepStrictEqual(raw, [5101], "nothing refused: raw request passed through");
    pendingSeen = launchLedger.readLedger(file).pending["5101"];
    launchToSpace(vendor, 5101);
    return { success: true };
  });
  launchFn(SESSION, [5101], { ownerID: CORP });
  assert.deepStrictEqual({ typeID: pendingSeen.typeID, p0TypeID: pendingSeen.p0TypeID }, { typeID: VARIANT_AQ, p0TypeID: 2268 });
  const ledger = launchLedger.readLedger(file);
  assert.deepStrictEqual(ledger.pending, {});
  assert.strictEqual(ledger.drills["5101"].p0TypeID, 2268);
  assert.strictEqual(runtime.launchStats.launchRefused, 0);

  vendor.orbital.replacementsByPlanet[String(HISEC_PLANET.itemID)].completed = true;
  const after = overlayAfterRestart(vendor, file);
  assert.strictEqual(after.reagent, 2268);
  assert.ok(after.lines.includes("skyhook=5101 planet=40242000 reagent=2268 mode=P0 amount=5000 pick=variant"), after.lines.join("\n"));

  launchLedger.writeLedger(file, { v: 1, pending: {}, drills: { 5101: { atMs: 1, sourceItemID: 5101 } } });
  const old = overlayAfterRestart(vendor, file);
  assert.strictEqual(old.reagent, P0_B);
  assert.ok(old.lines.includes(`skyhook=5101 planet=40242000 reagent=${P0_B} mode=P0 amount=15000 pick=auto tag=none`), old.lines.join("\n"));

  launchLedger.writeLedger(file, { v: 1, pending: {}, drills: { 5101: { atMs: 1, sourceItemID: 5101, p0TypeID: 2307 } } });
  const odd = overlayAfterRestart(vendor, file);
  assert.strictEqual(odd.reagent, P0_B);
  assert.ok(odd.lines.includes(`WARN skyhook=5101 planet=40242000 variant=2307 not on planet - mining ${P0_B}`), odd.lines.join("\n"));
  assert.ok(odd.lines.includes(`skyhook=5101 planet=40242000 reagent=${P0_B} mode=P0 amount=15000 pick=variant-ignored tag=none`), odd.lines.join("\n"));
});

test("T-V3 refusal: planet without the variant P0 -> item stays, vendor not called / called without it, CustomNotify appended; no planet check -> PRECHECK_UNAVAILABLE", () => {
  const expected = "Planetary Drill (Aqueous Liquids) cannot be launched at Lava Test IV: this planet has no Aqueous Liquids. " +
    "Aqueous Liquids is found on Temperate, Ice, Gas, Oceanic, Barren and Storm planets. The drill stays in your cargo hold.";
  const notify = (itemID, message) => [itemID, { type: "list", items: [["CustomNotify", { type: "dict", entries: [["notify", message]] }]] }];

  {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5101, { typeID: VARIANT_AQ })], LAVA_PLANET.itemID);
    let called = 0;
    const { runtime, launchFn } = launchRuntime(vendor, file, () => {
      called += 1;
      return { success: true };
    });
    const result = launchFn(SESSION, [5101], {});
    assert.strictEqual(called, 0);
    assert.deepStrictEqual(result, { success: false, errorMsg: "NO_VALID_ORBITALS", launchedItemIDs: [],
      errors: [{ itemID: 5101, errorMsg: expected }], response: { type: "dict", entries: [notify(5101, expected)] } });
    assert.ok(expected.length <= 300);
    assert.strictEqual(vendor.map.get(5101).typeID, VARIANT_AQ);
    assert.strictEqual(vendor.calls.updateItemType, 0);
    assert.deepStrictEqual(launchLedger.readLedger(file).pending, {});
    assert.strictEqual(runtime.launchStats.launchRefused, 1);
  }

  {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5101, { typeID: VARIANT_AQ }), cargoItem(5102)], LAVA_PLANET.itemID);
    let rawSeen = null;
    const { launchFn } = launchRuntime(vendor, file, (session, raw) => {
      rawSeen = raw;
      launchToSpace(vendor, 5102);
      return { success: true, errorMsg: null, launchedItemIDs: [5102], errors: [],
        response: { type: "dict", entries: [[5102, { type: "list", items: [5102] }]] } };
    });
    const result = launchFn(SESSION, [5101, 5102], {});
    assert.deepStrictEqual(rawSeen, [[5102, 1]]);
    assert.deepStrictEqual(result.errors, [{ itemID: 5101, errorMsg: expected }]);
    assert.deepStrictEqual(result.response.entries, [[5102, { type: "list", items: [5102] }], notify(5101, expected)]);
    assert.strictEqual(vendor.map.get(5101).typeID, VARIANT_AQ);
    assert.deepStrictEqual(Object.keys(launchLedger.readLedger(file).drills), ["5102"]);
    assert.strictEqual(launchLedger.readLedger(file).drills["5102"].p0TypeID, null, "340100 = auto");
  }

  const variant = variants.variantOf(VARIANT_AQ);
  const unavailable = launch.checkVariantLaunch({ variant, nearestPlanetID: null, planet: null, resourceTypeIDs: [], qualities: {}, cfg: CFG });
  assert.deepStrictEqual(unavailable, { ok: false, reason: "PRECHECK_UNAVAILABLE", planetID: 0,
    message: "Planetary Drill (Aqueous Liquids) cannot be launched right now: the server cannot check the planet's resources. The drill stays in your cargo hold." });
  assert.deepStrictEqual(launch.checkVariantLaunch({ variant, nearestPlanetID: 0, planet: null, resourceTypeIDs: [], qualities: {}, cfg: CFG }), { ok: true }, "no planet: the vendor answers");
  {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5101, { typeID: VARIANT_AQ })]);
    vendor.nearestPlanetID = () => {
      throw new Error("seam gone");
    };
    const { launchFn } = launchRuntime(vendor, file, () => ({ success: true }));
    const result = launchFn(SESSION, [5101], {});
    assert.deepStrictEqual(result.errors, [{ itemID: 5101, errorMsg: unavailable.message }]);
    assert.strictEqual(vendor.map.get(5101).typeID, VARIANT_AQ);
  }

  {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5101, { typeID: VARIANT_AQ }), cargoItem(5103, { typeID: 340105 })]);
    const lines = [];
    const runtime = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: ok, inspectLaunch: ok, vendor, ledgerFile: file, defer: (fn) => fn(), logFn: (line) => lines.push(line), logErrorFn: silent });
    const exportsObject = { launchOrbitalsFromShip: () => ({ success: true }), _testing: {} };
    assert.deepStrictEqual(runtime.applyLaunch(exportsObject), { ok: true });
    const realVariantOf = variants.variantOf;
    let thrown = 0;
    variants.variantOf = (typeID) => {
      if (thrown === 0) {
        thrown += 1;
        throw new Error("variantOf broken once");
      }
      return realVariantOf(typeID);
    };
    let result;
    try {
      result = exportsObject.launchOrbitalsFromShip(SESSION, [5101, 5103], {});
    } finally {
      variants.variantOf = realVariantOf;
    }
    assert.strictEqual(thrown, 1, "precheck threw");
    assert.strictEqual(runtime.launchStats.launchRefused, 2);
    assert.deepStrictEqual(result.errors.map((entry) => entry.itemID), [5101, 5103]);
    for (const [itemID, typeID] of [[5101, VARIANT_AQ], [5103, 340105]]) {
      const expectedLine = `launch source=${itemID} type=${typeID} result=REFUSED reason=PRECHECK_UNAVAILABLE planet=0`;
      assert.strictEqual(lines.filter((line) => line === expectedLine).length, 1, lines.join("\n"));
      assert.strictEqual(vendor.map.get(itemID).typeID, typeID);
    }
    assert.strictEqual(vendor.calls.updateItemType, 0);
  }

  function runBroken(planetID, brokenAt) {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5101, { typeID: VARIANT_AQ }), cargoItem(5104, { typeID: VARIANT_AQ })], planetID);
    const lines = [];
    const runtime = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: ok, inspectLaunch: ok, vendor, ledgerFile: file, defer: (fn) => fn(), logFn: (line) => lines.push(line), logErrorFn: silent });
    let vendorCalled = 0;
    const exportsObject = { launchOrbitalsFromShip: () => {
      vendorCalled += 1;
      return { success: true };
    }, _testing: {} };
    assert.deepStrictEqual(runtime.applyLaunch(exportsObject), { ok: true });
    const realVariantOf = variants.variantOf;
    let calls = 0;
    variants.variantOf = (typeID) => {
      calls += 1;
      if (brokenAt(calls)) throw new Error(`variantOf broken at call ${calls}`);
      return realVariantOf(typeID);
    };
    let result;
    try {
      result = exportsObject.launchOrbitalsFromShip(SESSION, [5101, 5104], {});
    } finally {
      variants.variantOf = realVariantOf;
    }
    return { result, lines, runtime, vendor, vendorCalled };
  }
  const refusedLines = (lines, itemID) => lines.filter((line) => line.startsWith(`launch source=${itemID} `) && line.includes("result=REFUSED"));

  {
    const { result, lines, runtime, vendor, vendorCalled } = runBroken(HISEC_PLANET.itemID, () => true);
    assert.strictEqual(vendorCalled, 0, "everything refused: the vendor is not called");
    assert.deepStrictEqual(result.errors, [{ itemID: 5101, errorMsg: variants.GENERIC_PRECHECK_TEXT }, { itemID: 5104, errorMsg: variants.GENERIC_PRECHECK_TEXT }]);
    assert.strictEqual(runtime.launchStats.launchRefused, 2);
    for (const itemID of [5101, 5104]) {
      assert.deepStrictEqual(refusedLines(lines, itemID), [`launch source=${itemID} type=${VARIANT_AQ} result=REFUSED reason=PRECHECK_UNAVAILABLE planet=0`], lines.join("\n"));
      assert.strictEqual(vendor.map.get(itemID).typeID, VARIANT_AQ);
    }
    assert.strictEqual(vendor.calls.updateItemType, 0);
  }

  {
    const { result, lines, runtime, vendor } = runBroken(LAVA_PLANET.itemID, (n) => n === 3);
    assert.strictEqual(runtime.launchStats.launchRefused, 2);
    for (const itemID of [5101, 5104]) {
      assert.deepStrictEqual(refusedLines(lines, itemID), [`launch source=${itemID} type=${VARIANT_AQ} result=REFUSED reason=PRECHECK_UNAVAILABLE planet=0`], lines.join("\n"));
      assert.strictEqual(vendor.map.get(itemID).typeID, VARIANT_AQ);
    }
    assert.deepStrictEqual(result.errors.map((entry) => entry.itemID), [5101, 5104]);
  }

  function throwingRuntime(vendor, file, original) {
    let broken = false;
    const throwingLog = () => {
      if (broken) throw new Error("logger broken");
    };
    const runtime = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: ok, inspectLaunch: ok, vendor, ledgerFile: file, defer: (fn) => fn(), logFn: throwingLog, logErrorFn: throwingLog });
    const exportsObject = { launchOrbitalsFromShip: original, _testing: {} };
    assert.deepStrictEqual(runtime.applyLaunch(exportsObject), { ok: true });
    broken = true;
    return { runtime, launchFn: exportsObject.launchOrbitalsFromShip };
  }

  {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5101, { typeID: VARIANT_AQ }), cargoItem(5102)], LAVA_PLANET.itemID);
    let rawSeen = null;
    const { runtime, launchFn } = throwingRuntime(vendor, file, (session, raw) => {
      rawSeen = raw;
      launchToSpace(vendor, 5102);
      return { success: true, errorMsg: null, launchedItemIDs: [5102], errors: [] };
    });
    let result;
    assert.doesNotThrow(() => {
      result = launchFn(SESSION, [5101, 5102], {});
    });
    assert.deepStrictEqual(rawSeen, [[5102, 1]], "vendor called without the variant");
    assert.deepStrictEqual(result.errors, [{ itemID: 5101, errorMsg: expected }]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(runtime.launchStats.launchRefused, 1);
    assert.strictEqual(runtime.launchStats.launchConverted, 1);
    assert.strictEqual(vendor.map.get(5101).typeID, VARIANT_AQ);
  }

  {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5102), cargoItem(5105)], HISEC_PLANET.itemID);
    const realUpdate = vendor.updateItemType;
    vendor.updateItemType = function updateItemType(id, typeID) {
      if (vendor.calls.updateItemType === 1) {
        vendor.calls.updateItemType += 1;
        throw new Error("updateItemType boom");
      }
      return realUpdate.call(this, id, typeID);
    };
    const seen = [];
    const answer = { success: false, errorMsg: "PLANET_ALREADY_HAS_ORBITAL" };
    const { launchFn } = throwingRuntime(vendor, file, (session, raw) => {
      seen.push({ raw, types: raw.map((id) => vendor.findItem(id).typeID) });
      return answer;
    });
    let result;
    assert.doesNotThrow(() => {
      result = launchFn(SESSION, [5102, 5105], {});
    });
    assert.strictEqual(result, answer);
    assert.deepStrictEqual(seen, [{ raw: [5102, 5105], types: [DRILL_ITEM, DRILL_ITEM] }], "vendor got the original items");
    assert.strictEqual(vendor.calls.updateItemType, 3, "convert 5102, throw at 5105, revert 5102");
    assert.strictEqual(vendor.map.get(5102).typeID, DRILL_ITEM);
    assert.strictEqual(vendor.map.get(5105).typeID, DRILL_ITEM);
    assert.deepStrictEqual(Object.keys(launchLedger.readLedger(file).pending), ["5105"]);
  }
});

test("T-V7 guardLog: a throwing logger does not throw, arguments passed; not a function -> no-op", () => {
  const seen = { count: 0, last: null };
  const guarded = launch.guardLog((...args) => {
    seen.count += 1;
    seen.last = args;
    throw new Error("logger broken");
  });
  const error = new Error("x");
  assert.doesNotThrow(() => guarded("line", error));
  assert.doesNotThrow(() => guarded("second"));
  assert.strictEqual(seen.count, 2);
  assert.deepStrictEqual(seen.last, ["second"]);
  for (const notFn of [undefined, null, 42, "log"]) {
    const noop = launch.guardLog(notFn);
    assert.strictEqual(typeof noop, "function");
    assert.strictEqual(noop("line"), undefined);
  }
});

test("T-V8 createRuntime guards its loggers: corrupt ledger + throwing loggers -> sweepNow, startup sweep and overlay ledger read do not throw", () => {
  const file = tempLedgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{");
  let broken = false;
  const throwingLog = () => {
    if (broken) throw new Error("logger broken");
  };
  const vendor = variantVendor([]);
  const runtime = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: ok, inspectLaunch: ok, vendor, ledgerFile: file, defer: (fn) => fn(), logFn: throwingLog, logErrorFn: throwingLog });
  const exportsObject = { launchOrbitalsFromShip: () => ({ success: true, launchedItemIDs: [] }), _testing: {} };
  assert.deepStrictEqual(runtime.applyLaunch(exportsObject), { ok: true });
  broken = true;
  let swept;
  assert.doesNotThrow(() => {
    swept = runtime.sweepNow();
  });
  assert.strictEqual(swept.ok, true);
  const { snapshot } = makeSnapshot();
  const sovExports = { getSovereigntyStaticSnapshot: () => snapshot };
  assert.doesNotThrow(() => assert.deepStrictEqual(runtime.applySov(sovExports), { ok: true }));
  let served;
  assert.doesNotThrow(() => {
    served = sovExports.getSovereigntyStaticSnapshot();
  });
  assert.strictEqual(served, snapshot);
  assert.strictEqual(runtime.state.launchSwept, true, "startup sweep ran");
  assert.strictEqual(runtime.launchStats.sweepRuns, 2);
});

test("T-V9 low-sweep-2: overlay rebuilt before the launch wrap -> the startup sweep runs on the next fast path", () => {
  const vendor = variantVendor([]);
  const runtime = loader._testing.createRuntime({ runtimeRoot, cfg: CFG, inspect: ok, inspectLaunch: ok, vendor,
    ledgerFile: tempLedgerFile(), defer: (fn) => fn(), logFn: () => {}, logErrorFn: () => {} });
  const { snapshot } = makeSnapshot();
  const sovExports = { getSovereigntyStaticSnapshot: () => snapshot };
  assert.deepStrictEqual(runtime.applySov(sovExports), { ok: true });
  sovExports.getSovereigntyStaticSnapshot();
  assert.strictEqual(runtime.state.launchSwept, false, "rebuild before the launch wrap: no sweep yet");
  const exportsObject = { launchOrbitalsFromShip: () => ({ success: true, launchedItemIDs: [] }), _testing: {} };
  assert.deepStrictEqual(runtime.applyLaunch(exportsObject), { ok: true });
  sovExports.getSovereigntyStaticSnapshot();
  assert.strictEqual(runtime.state.launchSwept, true, "fast path after the wrap runs the startup sweep");
  assert.strictEqual(runtime.launchStats.sweepRuns, 1);
});

test("T-V6 checkVariantLaunch: P0 on the planet but too poor -> P0_TOO_POOR; P0 not on the planet -> P0_NOT_ON_PLANET; texts ASCII without <", () => {
  const variant = variants.variantOf(VARIANT_AQ);
  const base = { variant, nearestPlanetID: LAVA_PLANET.itemID, planet: LAVA_PLANET, cfg: CFG };
  const poorText = "Planetary Drill (Aqueous Liquids) cannot be launched at Lava Test IV: the Aqueous Liquids deposits of this planet are too poor to mine. The drill stays in your cargo hold.";
  const zeroQuality = launch.checkVariantLaunch({ ...base, resourceTypeIDs: [2267, 2268], qualities: { 2267: 20, 2268: 0 } });
  assert.deepStrictEqual(zeroQuality, { ok: false, reason: "P0_TOO_POOR", planetID: LAVA_PLANET.itemID, message: poorText });
  assert.ok(zeroQuality.message.includes("too poor"));
  const tiny = { ...CFG, baseUnitsPerHour: 1, cycleSeconds: 60 };
  const zeroAmount = launch.checkVariantLaunch({ ...base, cfg: tiny, resourceTypeIDs: ["2268", 2307], qualities: { 2268: 10, 2307: 30 } });
  assert.strictEqual(zeroAmount.reason, "P0_TOO_POOR");
  const missing = launch.checkVariantLaunch({ ...base, resourceTypeIDs: [2267, 2307], qualities: { 2267: 20, 2307: 20 } });
  assert.strictEqual(missing.reason, "P0_NOT_ON_PLANET");
  assert.ok(missing.message.includes("this planet has no Aqueous Liquids"), missing.message);
  const unavailable = launch.checkVariantLaunch({ ...base, nearestPlanetID: null, planet: null, resourceTypeIDs: [], qualities: {} });
  for (const verdict of [zeroQuality, zeroAmount, missing, unavailable]) {
    assert.ok(/^[\x20-\x7e]+$/u.test(verdict.message) && !verdict.message.includes("<"), verdict.message);
  }
  const generic = "This drill cannot be launched right now: the server cannot check the planet's resources. The drill stays in your cargo hold.";
  assert.strictEqual(variants.GENERIC_PRECHECK_TEXT, generic);
  for (const reason of ["PRECHECK_UNAVAILABLE", "P0_NOT_ON_PLANET", "P0_TOO_POOR"]) {
    const text = variants.refusalMessage({ variant: null, planetName: "X", reason });
    assert.strictEqual(text, generic, reason);
    assert.ok(/^[\x20-\x7e]+$/u.test(text) && !text.includes("<") && !text.includes(">"), text);
  }
});

test("T-V4 stack of 3 variants: one LAUNCHED, the rest back to 340104 (not 340100); saga holds -> sweep after restart restores 340104", () => {
  {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5103, { typeID: VARIANT_AQ, quantity: 3 })]);
    const { launchFn } = launchRuntime(vendor, file, () => {
      launchToSpace(vendor, 5103, 7101);
      return { success: true };
    });
    launchFn(SESSION, [5103], {});
    const ledger = launchLedger.readLedger(file);
    assert.deepStrictEqual(Object.keys(ledger.drills), ["7101"]);
    assert.strictEqual(ledger.drills["7101"].p0TypeID, 2268);
    assert.deepStrictEqual(ledger.pending, {});
    assert.deepStrictEqual([vendor.map.get(5103).typeID, vendor.map.get(5103).quantity], [VARIANT_AQ, 2]);
    assert.strictEqual(vendor.calls.syncItem[0].item.typeID, VARIANT_AQ);
  }
  {
    const file = tempLedgerFile();
    const vendor = variantVendor([cargoItem(5104, { typeID: VARIANT_AQ })]);
    const planetKey = String(HISEC_PLANET.itemID);
    const { launchFn } = launchRuntime(vendor, file, () => {
      vendor.orbital.replacementsByPlanet[planetKey] = { sourceItem: { itemID: 5104, typeID: 81080 }, completed: false };
      return { success: false, errorMsg: "ITEM_CUSTODY_PENDING" };
    });
    launchFn(SESSION, [5104], {});
    assert.strictEqual(vendor.map.get(5104).typeID, 81080);
    assert.strictEqual(launchLedger.readLedger(file).pending["5104"].typeID, VARIANT_AQ);
    delete vendor.orbital.replacementsByPlanet[planetKey];
    const restarted = launchRuntime(vendor, file, () => ({ success: true }));
    assert.deepStrictEqual(restarted.runtime.sweepNow(), { ok: true, reverted: 1, recorded: 0, pruned: 0 });
    assert.strictEqual(vendor.map.get(5104).typeID, VARIANT_AQ);
  }
});

test("T-V5 consistency: PLANET_CLASSES = vendor PLANET_RESOURCES_BY_TYPE_ID; pack descriptions name the P0 and its classes; no [PI:]", () => {
  const { byPlanet } = vendorPlanetResources();
  const sorted = (ids) => [...ids].sort((a, b) => a - b);
  for (const planetClass of variants.PLANET_CLASSES) {
    assert.deepStrictEqual(sorted(planetClass.p0TypeIDs), byPlanet.get(planetClass.planetTypeID), planetClass.name);
  }
  const baseIDs = new Set(variants.PLANET_CLASSES.map((planetClass) => planetClass.planetTypeID));
  assert.strictEqual(byPlanet.size, 16);
  for (const [planetTypeID, ids] of byPlanet) {
    if (baseIDs.has(planetTypeID)) continue;
    assert.ok(variants.PLANET_CLASSES.some((planetClass) => JSON.stringify(sorted(planetClass.p0TypeIDs)) === JSON.stringify(ids)),
      `planet type ${planetTypeID} has the list of a base class`);
  }
  assert.deepStrictEqual(variants.classesWithP0(2268), ["Temperate", "Ice", "Gas", "Oceanic", "Barren", "Storm"]);

  const pack = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "mods", "customTypes", "data", "planetary-drill.json"), "utf8"));
  const types = new Map(pack.types.map((entry) => [entry.typeID, entry]));
  for (const variant of variants.VARIANTS) {
    const entry = types.get(variant.typeID);
    assert.strictEqual(entry.overrides.name, `Planetary Drill (${variant.p0Name})`);
    assert.ok(entry.overrides.description.includes(`mines ${variant.p0Name} (raw planetary resource, P0)`), variant.p0Name);
    assert.ok(entry.overrides.description.includes(`${variant.p0Name} is found on ${variants.listText(variants.classesWithP0(variant.p0TypeID))} planets.`), variant.p0Name);
    assert.ok(entry.overrides.description.includes("the launch is refused"), variant.p0Name);
    assert.strictEqual(types.get(variant.blueprintTypeID).overrides.name, `Planetary Drill (${variant.p0Name}) Blueprint`);
  }
  assert.deepStrictEqual(pack.types.filter((entry) => String(entry.overrides.description).includes("[PI:")).map((entry) => entry.typeID), []);
});

let passed = 0;
let failed = 0;
const started = Date.now();
for (const { name, fn } of tests) {
  if (only && !only.some((fragment) => name.includes(fragment))) continue;
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(error && error.stack ? error.stack : error);
  }
}
for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed}/${passed + failed} PASS (${Date.now() - started} ms)`);
process.exitCode = failed > 0 ? 1 : 0;
setImmediate(() => process.exit(process.exitCode));
