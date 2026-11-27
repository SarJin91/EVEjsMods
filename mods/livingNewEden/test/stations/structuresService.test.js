"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createViewRegistry } = require("../../lib/observer/views");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { buildDefaultServiceDefs, createServiceRegistry } = require("../../lib/runtime/services");
const { startStructures, createUnavailableStructures } = require("../../lib/stations/structures");
const { projectionKey } = require("../../lib/stations/structures/schema");
const { createStructuresService } = require("../../lib/stations/structures/structuresService");
const { placementCandidates } = require("../../lib/stations/structures/projection");
const { deriveSeed } = require("../../lib/util/rng");
const { createFakeStructureSeam } = require("../_support/fakeStructureSeam");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SYS = 30001721;
const F1 = 500003;
const F2 = 500020;
const CORP = 1000162;
const CORP2 = 1000999;
const HOUR = 3600000;
const ANCHORS = Object.freeze({ [SYS]: [{ itemId: 40000001, position: { x: 1e9, y: 0, z: 0 }, radius: 5e6 }] });
const LIMITS = Object.freeze({ maxPerSystem: 8, maxPerSystemPerFaction: 8, maxPerFaction: 64, maxStations: 2000,
  maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 });
const WORLD = 7;
const STATES = Object.freeze({ states: { ANCHOR_VULNERABLE: 115, SHIELD_VULNERABLE: 110, ARMOR_REINFORCE: 111,
  ARMOR_VULNERABLE: 112, HULL_REINFORCE: 113, HULL_VULNERABLE: 114 }, upkeep: { FULL_POWER: 1 } });
const MUTATIONS = Object.freeze(["createTaggedStructure", "updateTaggedStructure", "destroyTaggedStructure",
  "removeTaggedStructure", "flushStructures"]);

function cfg(structures = {}, enabled = true) {
  return { ...DEFAULTS, modules: { ...DEFAULTS.modules, structures: { enabled } },
    structures: { ...DEFAULTS.structures, ...structures } };
}

const writes = (fake) => MUTATIONS.reduce((n, m) => n + fake.calls[m], 0);
const liveOf = (fake, stationId) => fake.rows().filter((r) => r.tag && r.tag.stationId === stationId
  && r.destroyedAt === null);

function manualTimer() {
  const timer = { fn: null };
  const setTimer = (fn) => {
    timer.fn = fn;
    return { cancel() { if (timer.fn === fn) timer.fn = null; }, hasRef: () => false };
  };
  const pass = () => {
    const fn = timer.fn;
    assert.ok(fn, "pass armed");
    timer.fn = null;
    fn();
  };
  return { setTimer, pass };
}

function boot(opened, clock, fake, structures) {
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const repository = createStationRepository({ journal, limits: LIMITS, isKnownFaction: () => true,
    hullGroups: HULL_GROUPS });
  const t = manualTimer();
  const gov = { admit: true };
  const started = startStructures({ config: cfg(structures), clock, setTimer: t.setTimer,
    persistence: { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed },
    adapter: { getStructureSeam: () => fake.seam }, getStations: () => ({ getMode: () => "ready", repository }),
    views: createViewRegistry(), getGovernor: () => ({ admits: () => gov.admit }), logger: { log() {} } });
  assert.ok(started.ok, JSON.stringify(started));
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { repository, structures: started.structures, tx, pass: t.pass, gov, world: opened.worldSeed };
}

function addStation(env, clock, id) {
  const r = env.tx((db) => env.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
    structureFamily: "astrahus", systemId: SYS, ownerFactionId: F1, ownerCorporationId: CORP, origin: "built",
    at: clock.now() }, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

const stationOf = (env, id) => env.tx((db) => env.repository.getStation(db, id)).record;

function transition(env, clock, id, from, to, patch) {
  const rec = stationOf(env, id);
  const r = env.tx((db) => env.repository.transitionStation(db, { stationId: id, expectedVersion: rec.version,
    from, to, key: `test:tr:${id}:${rec.version}`, reason: "test", at: clock.now(), ...(patch ? { patch } : {}) }));
  assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
}

function memoryService(ids, structures, bad = [], fakeOpts = {}, extra = {}) {
  const settings = { ...DEFAULTS.structures, ...structures };
  const anchors = [ANCHORS[SYS][0], { itemId: 40000002, position: { x: -1e9, y: 0, z: 0 }, radius: 5e6 }];
  const keyOf = (p) => `${p.x}|${p.y}|${p.z}`;
  const invalid = new Set(bad.flatMap((id) => placementCandidates({ seed: deriveSeed(WORLD, "structurePlacement", id),
    anchors, clearanceM: settings.placementClearanceM, attempts: settings.placementAttempts }).map(keyOf)));
  const fake = createFakeStructureSeam({ anchors: { [SYS]: anchors },
    invalidPosition: (i) => invalid.has(keyOf(i.position)), ...fakeOpts });
  const records = ids.map((id) => ({ stationId: id, kind: "upwell", typeId: 35832, systemId: SYS,
    ownerCorporationId: CORP, state: "ONLINE", stateUntilAt: null, name: null, position: null, evejsItemId: null,
    version: 1 }));
  const repository = { listLiveStations: () => ({ ok: true, records }),
    getStation: (_db, id) => ({ ok: true, record: records.find((r) => r.stationId === id) || null }),
    recordProjection: () => ({ ok: true }) };
  const clock = createManualClock(H.START_MS);
  const t = manualTimer();
  const seam = typeof extra.wrapSeam === "function" ? extra.wrapSeam(fake.seam) : fake.seam;
  const svc = createStructuresService({ seam, states: STATES, clock, worldSeed: WORLD, settings,
    mode: "project", store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
    getStations: () => ({ getMode: () => "ready", repository }), setTimer: t.setTimer, getSiege: extra.getSiege,
    telemetry: extra.telemetry });
  assert.deepStrictEqual(svc.start(), { ok: true });
  const pass = () => {
    t.pass();
    clock.advance(settings.passMs);
  };
  return { svc, fake, pass, clock, settings, records, repository };
}

function nativeScene(enabled, reply, withSiege = true) {
  const siege = { calls: [], reply, applyNativeDestruction(spec) {
    this.calls.push(spec);
    return this.reply;
  } };
  const m = memoryService(["s1"], { nativeDestructionEnabled: enabled }, [], {},
    withSiege ? { getSiege: () => siege } : {});
  m.pass();
  const id = liveOf(m.fake, "s1")[0].structureId;
  m.records[0] = { ...m.records[0], evejsItemId: id };
  m.pass();
  return { ...m, siege, id, kill: () => m.fake.foreignChange(id, { destroyedAt: 123 }) };
}

module.exports = ({ test, skip }) => {
  test("ND4/ND5 structures pass: a destroyed named structure -> siege.applyNativeDestruction; DESTROYED "
    + "DUPLICATE (full reconcile) -> no CREATE, NO_SIEGE -> CREATE (P5), a state change only -> no call (SLC-M2), "
    + "ok:false -> no CREATE and dirty; flag off -> no call, the same seam calls as without a siege; vendor fact",
  () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const text = fs.readFileSync(path.join(found.srcDir, "services", "structure", "structureState.js"), "utf8");
    const from = text.indexOf("\nfunction destroyStructure(");
    const body = text.slice(from, text.indexOf("\nfunction ", from + 1));
    assert.ok(from >= 0 && /updateStructureRecord\(structureID, \(currentStructure\) => \(\{\s*\.\.\.currentStructure,\s*destroyedAt: nowMs,/
      .test(body), "destroyStructure keeps the row with destroyedAt");

    assert.strictEqual(DEFAULTS.siege.nativeDestructionEnabled, false, "Off by default");
    const warned = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SIEGE_NATIVE_DESTRUCTION_ENABLED: "1",
      EVEJS_LNE_STRUCTURES_MODE: "cleanup" } }).warnings;
    assert.ok(warned.some((w) => w.startsWith("siege.nativeDestructionEnabled with structures.mode=cleanup")),
      warned.join("\n"));

    const a = nativeScene(true, { ok: true, outcome: "DESTROYED" });
    assert.strictEqual(a.fake.calls.createTaggedStructure, 1);
    a.kill();
    a.pass();
    assert.deepStrictEqual(a.siege.calls, [{ stationId: "s1", structureId: a.id, destroyedAt: 123,
      at: a.siege.calls[0].at }]);
    assert.ok(Number.isSafeInteger(a.siege.calls[0].at));
    a.siege.reply = { ok: true, outcome: "DUPLICATE" };
    a.clock.advance(a.settings.fullReconcileMs);
    a.pass();
    assert.deepStrictEqual([a.siege.calls.length, a.fake.calls.createTaggedStructure, a.fake.calls.listTaggedStructures,
      a.svc.getStatus().counters.nativeDestroyed], [2, 1, 2, 1]);
    a.records[0] = { ...a.records[0], state: "DESTROYED" };
    a.pass();
    assert.deepStrictEqual([a.siege.calls.length, a.fake.calls.createTaggedStructure,
      a.fake.calls.destroyTaggedStructure], [2, 1, 0]);
    a.svc.stop();

    const b = nativeScene(true, { ok: true, outcome: "NO_SIEGE" });
    b.kill();
    b.pass();
    assert.deepStrictEqual([b.siege.calls.length, b.fake.calls.createTaggedStructure, liveOf(b.fake, "s1").length,
      b.svc.getStatus().counters.nativeIgnored], [1, 2, 1, 1]);
    b.svc.stop();

    const c = nativeScene(true, { ok: true, outcome: "DESTROYED" });
    c.fake.foreignChange(c.id, { state: 111 });
    c.pass();
    assert.deepStrictEqual([c.siege.calls.length, c.fake.calls.updateTaggedStructure,
      c.fake.calls.createTaggedStructure], [0, 1, 1]);
    c.svc.stop();

    const d = nativeScene(true, { ok: false, reason: "TX_FAILED" });
    d.kill();
    d.pass();
    d.pass();
    assert.deepStrictEqual([d.siege.calls.length, d.fake.calls.createTaggedStructure,
      d.svc.getStatus().counters.nativeRefused, d.svc.getProjection("s1").lastError], [2, 1, 2, "TX_FAILED"]);
    d.siege.reply = { ok: true, outcome: "NO_SIEGE" };
    d.pass();
    assert.deepStrictEqual([d.siege.calls.length, d.fake.calls.createTaggedStructure], [3, 2]);
    d.svc.stop();

    const off = nativeScene(false, { ok: true, outcome: "DESTROYED" });
    const base = nativeScene(false, null, false);
    for (const s of [off, base]) {
      s.kill();
      s.pass();
      s.pass();
    }
    assert.strictEqual(off.siege.calls.length, 0);
    assert.deepStrictEqual(off.fake.calls, base.fake.calls);
    assert.strictEqual(off.fake.calls.createTaggedStructure, 2);
    off.svc.stop();
    base.svc.stop();
  });

  test("NN5: a structure destroyed by the mod (REMOVE RECREATE -> NOT_EMPTY -> DESTROY) is "
    + "no foreign destruction: flag on -> the next pass CREATEs once, applyNativeDestruction never called", () => {
    const s = nativeScene(true, { ok: true, outcome: "DESTROYED" });
    s.fake.options.notEmpty.add(s.id);
    s.fake.foreignChange(s.id, { typeId: 35833 });
    s.pass();
    assert.deepStrictEqual([s.fake.calls.removeTaggedStructure, s.fake.calls.destroyTaggedStructure,
      s.fake.calls.createTaggedStructure, liveOf(s.fake, "s1").length], [1, 1, 1, 0], "RECREATE -> NOT_EMPTY -> DESTROY");
    s.pass();
    assert.deepStrictEqual([s.fake.calls.createTaggedStructure, liveOf(s.fake, "s1").length, s.siege.calls.length,
      s.svc.getStatus().counters.nativeIgnored], [2, 1, 0, 0]);
    s.svc.stop();
  });

  test("NN6: the mod destroys a structure but its mark fails -> destroyed "
    + "destroyMarkFailed 1, lastError DESTROY:MARK_FAILED, the DESTROY is never repeated", () => {
    const s = nativeScene(true, { ok: true, outcome: "DESTROYED" });
    s.fake.options.notEmpty.add(s.id);
    s.fake.options.markFailed = true;
    s.fake.foreignChange(s.id, { typeId: 35833 });
    s.pass();
    const st = s.svc.getStatus();
    assert.deepStrictEqual([s.fake.calls.destroyTaggedStructure, st.counters.destroyed, st.counters.destroyMarkFailed,
      st.lastError], [1, 1, 1, "DESTROY:MARK_FAILED"]);
    s.pass();
    assert.deepStrictEqual([s.fake.calls.destroyTaggedStructure, s.svc.getStatus().counters.destroyMarkFailed], [1, 1]);
    s.svc.stop();
  });

  test("TB6 budgets: placement cursor -> block, createWait, CREATE refusal "
    + "blocked / WRITE_FAILED waits, maps after a full reconcile", () => {
    const a = memoryService(["s1", "s2"], {}, ["s1"]);
    const maxPasses = Math.ceil((a.settings.placementAttempts + 1) / a.settings.placementChecksPerPass) + 1;
    let passes = 0;
    while (a.fake.calls.createTaggedStructure === 0 && passes < maxPasses) {
      a.pass();
      passes += 1;
      assert.ok(a.svc.getStatus().lastChecks <= a.settings.placementChecksPerPass, "checks in the budget");
    }
    assert.ok(liveOf(a.fake, "s2").length === 1, `s2 created in ${maxPasses} passes`);
    assert.deepStrictEqual([a.svc.getProjection("s1").lastError, a.svc.getStatus().blocked], ["NO_POSITION", 1]);
    assert.strictEqual(a.fake.calls.validatePlacement, a.settings.placementAttempts + 1, "each candidate once");
    for (let i = 0; i < 10; i += 1) a.pass();
    assert.strictEqual(a.fake.calls.validatePlacement, a.settings.placementAttempts + 1, "blocked -> no check");
    assert.strictEqual(a.fake.calls.listTaggedStructures, 1, "no full reconcile inside fullReconcileMs");
    const st = a.svc.getStatus();
    assert.ok(st.counters.skipped >= 1 && st.counters.placementFailed === 1, JSON.stringify(st.counters));
    assert.deepStrictEqual([st.tracked.cursor, st.tracked.retry], [0, 1]);
    a.records.splice(0, 1);
    a.clock.advance(a.settings.fullReconcileMs);
    a.pass();
    const after = a.svc.getStatus();
    assert.deepStrictEqual([after.blocked, after.waiting, after.tracked, a.svc.getProjection("s1").structureId,
      a.svc.getProjection("s1").lastError], [0, 0, { applied: 1, bindings: 1, cursor: 0, retry: 0 }, null, null]);
    a.svc.stop();

    const b = memoryService(["s1", "s2", "s3", "s4"], { maxProjected: 2, maxWritesPerPass: 1 });
    for (let i = 0; i < 10; i += 1) b.pass();
    assert.deepStrictEqual([b.fake.calls.createTaggedStructure, b.fake.calls.listTaggedStructures], [2, 1]);
    assert.deepStrictEqual([b.svc.getStatus().blocked, b.svc.getStatus().waiting, b.svc.getStatus().counters.skipped],
      [2, 0, 2]);
    b.clock.advance(b.settings.fullReconcileMs);
    b.pass();
    assert.deepStrictEqual([b.fake.calls.createTaggedStructure, b.fake.calls.listTaggedStructures,
      b.svc.getStatus().counters.skipped], [2, 2, 4]);
    b.svc.stop();

    const s = memoryService(["s1", "s2", "s3"], { maxWritesPerPass: 1 });
    for (let i = 0; i < 3; i += 1) s.records[i] = { ...s.records[i], evejsItemId: 1020000000000 + i };
    for (let i = 0; i < 4; i += 1) s.pass();
    assert.deepStrictEqual([s.fake.calls.createTaggedStructure, s.fake.calls.listTaggedStructures], [3, 1]);
    s.svc.stop();

    const c = memoryService(["s1"], {});
    c.records[0] = { ...c.records[0], ownerCorporationId: 0 };
    for (let i = 0; i < 10; i += 1) c.pass();
    assert.deepStrictEqual([c.fake.calls.createTaggedStructure, c.fake.calls.listTaggedStructures,
      c.svc.getStatus().counters.createRefused, c.svc.getProjection("s1").lastError], [1, 1, 1, "INVALID_INPUT"]);
    c.svc.stop();
    const w = memoryService(["s1"], {}, [], { createRefusal: "WRITE_FAILED" });
    w.pass();
    assert.deepStrictEqual([w.svc.getStatus().waiting, w.svc.getProjection("s1").lastError], [1, "WRITE_FAILED"]);
    w.fake.options.createRefusal = null;
    w.pass();
    assert.deepStrictEqual([w.fake.calls.createTaggedStructure, w.fake.calls.listTaggedStructures,
      liveOf(w.fake, "s1").length], [2, 1, 1]);
    w.svc.stop();
  });

  test("TB4a config (P1 off), module off -> zero seam calls, no seam -> stub, DRIFT -> probe_drift "
    + "stations not ready -> no write", () => {
    const s = DEFAULTS.structures;
    assert.deepStrictEqual([DEFAULTS.modules.structures.enabled, s.mode, s.passMs, s.fullReconcileMs,
      s.maxWritesPerPass, s.maxProjected, s.placementAttempts, s.placementChecksPerPass, s.placementClearanceM,
      s.dockingAccess, s.quantumCore], [false, "project", 10000, 300000, 4, 64, 8, 4, 2500000, "public", false]);
    const warned = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_STRUCTURES_ENABLED: "1",
      EVEJS_LNE_STRUCTURES_FULL_RECONCILE_MS: "10000", EVEJS_LNE_STRUCTURES_PASS_MS: "20000",
      EVEJS_LNE_STRUCTURES_DOCKING_ACCESS: "corp", EVEJS_LNE_STRUCTURES_MODE: "wipe" } });
    for (const head of ["structures.fullReconcileMs=10000 below", "EVEJS_LNE_STRUCTURES_DOCKING_ACCESS=\"corp\" is not",
      "EVEJS_LNE_STRUCTURES_MODE=\"wipe\" is not"]) {
      assert.ok(warned.warnings.some((w) => w.startsWith(head)), `${head}\n${warned.warnings.join("\n")}`);
    }
    assert.deepStrictEqual([warned.config.structures.dockingAccess, warned.config.structures.mode],
      ["public", "project"]);

    const fake = createFakeStructureSeam();
    const persistence = { ok: true, store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) }, worldSeed: 1 };
    const deps = { clock: createManualClock(1), persistence, adapter: { getStructureSeam: () => fake.seam } };
    assert.deepStrictEqual(startStructures({ ...deps, config: cfg({}, false) }),
      { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(Object.values(fake.calls).reduce((x, y) => x + y, 0), 0, "zero seam calls");
    const none = createFakeStructureSeam({ unavailable: true });
    const r = startStructures({ ...deps, config: cfg(), adapter: { getStructureSeam: () => none.seam } });
    assert.strictEqual(r.reason, "STRUCTURES_SEAM_UNAVAILABLE");
    assert.strictEqual(startStructures({ ...deps, config: cfg(), adapter: {} }).reason, "STRUCTURES_SEAM_UNAVAILABLE");
    const stub = createUnavailableStructures(r.reason, "probe");
    assert.deepStrictEqual([stub.getMode(), stub.getProjection("s1").reason], ["off", "STRUCTURES_SEAM_UNAVAILABLE"]);

    let starts = 0;
    const lines = [];
    const persistenceDef = { name: "persistence", module: "persistence", requires: [],
      start(ctx) { ctx.persistence = { ok: true }; return { ok: true }; } };
    const defs = [persistenceDef, ...buildDefaultServiceDefs({ startStructures: () => {
      starts += 1;
      return { ok: true, structures: { stop() {} } };
    } }).filter((d) => d.name === "structures")];
    const ctx = { config: cfg(), adapter: { getProbeReport: () => ({}),
      getDisabledModules: () => ({ structures: "drift:services/structure/structureState.createStructure" }),
      registerShutdownHook: () => ({ ok: true, unregister() {} }) } };
    const registry = createServiceRegistry({ logger: { log: (l) => lines.push(l) }, defs,
      clock: createManualClock(1), randomSeed: () => 1 });
    assert.strictEqual(registry.startAll(ctx).ok, true);
    assert.ok(lines.includes("services: persistence=running "
      + "structures=disabled:probe_drift:drift:services/structure/structureState.createStructure"), lines.join("\n"));
    assert.deepStrictEqual([starts, ctx.structures.getMode(), ctx.structures.getStatus().reason],
      [0, "off", "STRUCTURES_UNAVAILABLE"]);

    const t = manualTimer();
    const quiet = createFakeStructureSeam({ anchors: ANCHORS });
    const started = startStructures({ ...deps, config: cfg(), setTimer: t.setTimer,
      adapter: { getStructureSeam: () => quiet.seam }, getStations: () => ({ getMode: () => "off", repository: null }) });
    assert.ok(started.ok, JSON.stringify(started));
    t.pass();
    assert.deepStrictEqual([writes(quiet), quiet.calls.listTaggedStructures, started.structures.getStatus().lastError],
      [0, 0, "STATIONS_NOT_READY"]);
    started.structures.stop("test");
  });

  test("TB8 durable flush: a second runPass joins the pass in flight, recorded after the flush settles, passes and "
    + "passMs once; stopped before it settles -> no recordProjection, applied / bindings unchanged", async () => {
    const scene = () => {
      const gate = { release: null };
      const seen = { observed: 0, recorded: 0 };
      const m = memoryService(["s1"], {}, [], {}, {
        wrapSeam: (seam) => ({ ...seam, flushStructures: () => {
          const r = seam.flushStructures();
          return new Promise((resolve) => { gate.release = () => resolve(r); });
        } }),
        telemetry: { count() {}, observe: () => { seen.observed += 1; } } });
      m.repository.recordProjection = () => {
        seen.recorded += 1;
        return { ok: true };
      };
      return { ...m, gate, seen };
    };

    const a = scene();
    const first = a.svc.runPass();
    assert.ok(first && typeof first.then === "function", "the pass waits for the flush");
    assert.strictEqual(a.svc.runPass(), first, "a second pass joins the one in flight");
    assert.deepStrictEqual([a.fake.calls.createTaggedStructure, a.fake.calls.flushStructures, a.seen.recorded,
      a.svc.getStatus().passes, a.seen.observed], [1, 1, 0, 0, 0]);
    a.gate.release();
    await first;
    assert.deepStrictEqual([a.seen.recorded, a.svc.getStatus().passes, a.seen.observed,
      a.svc.getStatus().tracked.applied], [1, 1, 1, 1]);
    assert.strictEqual(a.svc.runPass(), undefined, "nothing in flight after the settle");
    a.svc.stop();

    const b = scene();
    const pending = b.svc.runPass();
    const tracked = b.svc.getStatus().tracked;
    b.svc.stop();
    b.gate.release();
    await pending;
    const st = b.svc.getStatus();
    assert.deepStrictEqual([b.seen.recorded, st.tracked, st.passes, b.seen.observed, st.counters.flushFailed],
      [0, tracked, 1, 1, 0]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TB1 ONLINE -> one CREATE + flush + recordProjection, second pass zero writes", () => H.withStore(
    driver, async (reopen) => {
      const opened = reopen();
      const clock = createManualClock(H.START_MS);
      const fake = createFakeStructureSeam({ anchors: ANCHORS });
      const env = boot(opened, clock, fake);
      addStation(env, clock, "s1");
      env.pass();
      assert.deepStrictEqual([fake.calls.createTaggedStructure, fake.calls.flushStructures], [1, 1]);
      const [row] = liveOf(fake, "s1");
      assert.deepStrictEqual([row.tag, row.ownerCorpId, row.state, row.stateEndsAt, row.docking, row.hasQuantumCore],
        [{ stationId: "s1", world: env.world }, CORP, 110, null, "public", false]);
      const rec = stationOf(env, "s1");
      assert.deepStrictEqual([rec.evejsItemId, rec.position, rec.version, rec.state],
        [row.structureId, row.position, 2, "ONLINE"]);
      assert.strictEqual(env.structures.getProjection("s1").structureId, row.structureId);
      const before = writes(fake);
      env.pass();
      assert.strictEqual(writes(fake), before, "second pass: zero writes");
      assert.strictEqual(env.structures.getStatus().counters.created, 1);
      env.structures.stop("test");
      assert.strictEqual(fake.subscriberCount(), 0, "listener unsubscribed");
    }));

  needsDriver("TB2 restart: crash before flush -> one CREATE, after flush -> adoption, duplicate -> REMOVE",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const clock = createManualClock(H.START_MS);
      const fake = createFakeStructureSeam({ anchors: ANCHORS, flushFails: true });
      const env1 = boot(opened, clock, fake);
      addStation(env1, clock, "s1");
      env1.pass();
      assert.strictEqual(fake.calls.createTaggedStructure, 1);
      assert.strictEqual(stationOf(env1, "s1").evejsItemId, null, "nothing recorded without a flush");
      env1.structures.stop("crash");
      fake.restart();
      fake.options.flushFails = false;
      assert.strictEqual(liveOf(fake, "s1").length, 0, "lost with the unflushed write");

      addStation(env1, clock, "s2");
      addStation(env1, clock, "s3");
      const base = { typeId: 35832, systemId: SYS, ownerCorpId: CORP, state: 110, stateEndsAt: null,
        position: { x: 1, y: 2, z: 3 } };
      const world = opened.worldSeed;
      const s2 = fake.seed({ ...base, tag: { stationId: "s2", world } });
      const s3a = fake.seed({ ...base, tag: { stationId: "s3", world } });
      const s3b = fake.seed({ ...base, tag: { stationId: "s3", world } });
      const env2 = boot(opened, clock, fake);
      env2.pass();
      assert.strictEqual(fake.calls.createTaggedStructure, 2, "one new CREATE (s1) after the crash");
      assert.deepStrictEqual(["s1", "s2", "s3"].map((id) => liveOf(fake, id).length), [1, 1, 1]);
      assert.strictEqual(liveOf(fake, "s3")[0].structureId, s3a, "the smallest id stays");
      assert.ok(!fake.rows().some((r) => r.structureId === s3b), "duplicate removed");
      assert.deepStrictEqual(["s1", "s2", "s3"].map((id) => stationOf(env2, id).evejsItemId),
        [liveOf(fake, "s1")[0].structureId, s2, s3a]);
      assert.deepStrictEqual(stationOf(env2, "s2").position, { x: 1, y: 2, z: 3 });
      assert.strictEqual(env2.structures.getStatus().counters.adopted, 2);
      const before = writes(fake);
      env2.pass();
      assert.strictEqual(writes(fake), before, "no write after the repair");
      env2.structures.stop("test");
    }));

  needsDriver("TB3 siege 111 -> 112, foreign change undone, capture, DESTROYED once, B1 RECREATE, B2", () =>
    H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const clock = createManualClock(H.START_MS);
      const fake = createFakeStructureSeam({ anchors: ANCHORS });
      const env = boot(opened, clock, fake);
      addStation(env, clock, "s1");
      addStation(env, clock, "s4");
      env.pass();
      const id = liveOf(fake, "s1")[0].structureId;

      fake.foreignChange(liveOf(fake, "s4")[0].structureId, { systemId: 30000142 });
      env.pass();
      assert.strictEqual(liveOf(fake, "s4").length, 0, "RECREATE removes first");
      env.pass();
      assert.deepStrictEqual(liveOf(fake, "s4").map((r) => r.systemId), [SYS], "CREATE in the next pass");

      const until = clock.now() + HOUR;
      transition(env, clock, "s1", "ONLINE", "ARMOR_REINFORCE", { stateUntilAt: until });
      env.pass();
      assert.deepStrictEqual([liveOf(fake, "s1")[0].state, liveOf(fake, "s1")[0].stateEndsAt], [111, until]);
      const once = writes(fake);
      env.pass();
      assert.strictEqual(writes(fake), once, "one change per difference");
      clock.advance(HOUR);
      env.pass();
      assert.deepStrictEqual([liveOf(fake, "s1")[0].state, liveOf(fake, "s1")[0].stateEndsAt], [112, null]);

      fake.foreignChange(id, { state: 110 });
      env.pass();
      assert.strictEqual(liveOf(fake, "s1")[0].state, 112, "foreign change undone");
      assert.ok(env.structures.getStatus().counters.foreignChange >= 1);

      const rec = stationOf(env, "s1");
      const cap = env.tx((db) => env.repository.captureStation(db, { stationId: "s1", expectedVersion: rec.version,
        from: "ARMOR_REINFORCE", ownerFactionId: F2, ownerCorporationId: CORP2, key: "test:cap", reason: "test",
        at: clock.now() }));
      assert.ok(cap.ok, JSON.stringify(cap));
      env.pass();
      assert.deepStrictEqual([liveOf(fake, "s1")[0].ownerCorpId, liveOf(fake, "s1")[0].state], [CORP2, 110]);

      transition(env, clock, "s1", "ONLINE", "ARMOR_REINFORCE", { stateUntilAt: clock.now() + HOUR });
      transition(env, clock, "s1", "ARMOR_REINFORCE", "HULL_REINFORCE", { stateUntilAt: clock.now() + HOUR });
      transition(env, clock, "s1", "HULL_REINFORCE", "DESTROYED");
      env.pass();
      assert.strictEqual(fake.calls.destroyTaggedStructure, 1, "B2: the destroyed station left the live list");
      assert.ok(fake.rows().find((r) => r.structureId === id).destroyedAt !== null);
      env.pass();
      clock.advance(DEFAULTS.structures.fullReconcileMs);
      env.pass();
      assert.strictEqual(fake.calls.destroyTaggedStructure, 1, "destroyed exactly once");
      assert.strictEqual(liveOf(fake, "s1").length, 0, "no rebirth");
      env.structures.stop("test");
    }));

  needsDriver("TB4b governor hold -> zero writes; cleanup REMOVE, NOT_EMPTY -> DESTROY, no listener",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const clock = createManualClock(H.START_MS);
      const fake = createFakeStructureSeam({ anchors: ANCHORS });
      const env = boot(opened, clock, fake);
      addStation(env, clock, "s1");
      env.gov.admit = false;
      env.pass();
      assert.strictEqual(writes(fake), 0, "held -> zero writes");
      assert.strictEqual(env.structures.getStatus().counters.passDeferred, 1);
      env.structures.stop("test");

      const base = { typeId: 35832, systemId: SYS, ownerCorpId: CORP, state: 110, stateEndsAt: null };
      const a = fake.seed({ ...base, tag: { stationId: "s1", world: opened.worldSeed } });
      const b = fake.seed({ ...base, tag: { stationId: "x9", world: 12345 } });
      const free = fake.seed({ ...base, tag: null });
      fake.options.notEmpty.add(b);
      const subs = fake.calls.subscribeStructureChanges;
      const clean = boot(opened, clock, fake, { mode: "cleanup" });
      assert.strictEqual(clean.structures.getMode(), "cleanup");
      clean.pass();
      assert.deepStrictEqual([fake.calls.removeTaggedStructure, fake.calls.destroyTaggedStructure,
        fake.calls.createTaggedStructure, fake.calls.subscribeStructureChanges - subs, fake.evacuated()],
      [2, 1, 0, 0, 1]);
      assert.ok(!fake.rows().some((r) => r.structureId === a), "empty one removed");
      assert.ok(fake.rows().find((r) => r.structureId === b).destroyedAt !== null, "not empty -> destroyed");
      assert.ok(fake.rows().some((r) => r.structureId === free), "an untagged structure is never touched");
      const st = clean.structures.getStatus();
      assert.deepStrictEqual([st.remaining, st.cleanup, st.lastWrites, clean.structures.getProjection("x9").lastOp],
        [0, "done", 3, "DESTROY"]);
      clean.structures.stop("test");
    }));

  needsDriver("TB5 recordProjection: key, duplicate, conflict, DESTROYED kept, version + 1", () =>
    H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const clock = createManualClock(H.START_MS);
      const env = boot(opened, clock, createFakeStructureSeam());
      env.structures.stop("test");
      addStation(env, clock, "s1");
      const P = { x: 1, y: 2, z: 3 };
      const rec = (evejsItemId, position) => env.tx((db) => env.repository.recordProjection(db, { stationId: "s1",
        evejsItemId, position, key: projectionKey("s1", evejsItemId), at: clock.now() }));
      assert.strictEqual(projectionKey("s1", 7), "stations:projection:s1:7");
      const first = rec(1030000000000, P);
      assert.deepStrictEqual([first.ok, first.record.evejsItemId, first.record.position, first.record.version,
        first.record.state], [true, 1030000000000, P, 2, "ONLINE"]);
      assert.deepStrictEqual(rec(1030000000000, P), { ok: true, duplicate: true });
      assert.strictEqual(rec(1030000000000, { x: 9, y: 9, z: 9 }).reason, "IDEMPOTENCY_CONFLICT");
      assert.strictEqual(stationOf(env, "s1").version, 2);
      transition(env, clock, "s1", "ONLINE", "ARMOR_REINFORCE", { stateUntilAt: clock.now() + HOUR });
      transition(env, clock, "s1", "ARMOR_REINFORCE", "HULL_REINFORCE", { stateUntilAt: clock.now() + HOUR });
      transition(env, clock, "s1", "HULL_REINFORCE", "DESTROYED");
      const v = stationOf(env, "s1").version;
      const dead = rec(1030000000001, P);
      assert.deepStrictEqual([dead.record.state, dead.record.version, dead.record.evejsItemId],
        ["DESTROYED", v + 1, 1030000000001]);
      const bad = env.tx((db) => env.repository.recordProjection(db, { stationId: "s1", evejsItemId: 0, position: P,
        key: "k", at: 1 }));
      assert.deepStrictEqual([bad.reason, bad.detail], ["INVALID_INPUT", "projection.evejsItemId"]);
      const none = env.tx((db) => env.repository.recordProjection(db, { stationId: "nope", evejsItemId: 5,
        position: P, key: projectionKey("nope", 5), at: 1 }));
      assert.strictEqual(none.reason, "ROW_NOT_FOUND");
    }));

  needsDriver("TB7: removeHold NOT_EMPTY -> WAIT, no double call before fullReconcileMs, call after",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const clock = createManualClock(H.START_MS);
      const fake = createFakeStructureSeam({
        anchors: ANCHORS,
        notEmpty: new Set([999999]),
        throwOn: new Set(["destroyTaggedStructure"]),
      });
      const base = { typeId: 35832, systemId: SYS, ownerCorpId: CORP, state: 110, stateEndsAt: null };
      const world = opened.worldSeed;
      fake.seed({ ...base, tag: { stationId: "s1", world }, structureId: 999999 });
      const env = boot(opened, clock, fake, { mode: "cleanup" });
      assert.strictEqual(env.structures.getMode(), "cleanup");
      addStation(env, clock, "s1");
      env.pass();
      assert.deepStrictEqual([fake.calls.removeTaggedStructure, fake.calls.destroyTaggedStructure], [1, 1]);
      assert.strictEqual(env.structures.getProjection("s1").lastOp, "DESTROY");
      assert.strictEqual(env.structures.getProjection("s1").lastError, "SEAM_ERROR");
      const st1 = env.structures.getStatus();
      assert.ok(st1.remaining > 0, "still waiting");
      env.pass();
      assert.deepStrictEqual([fake.calls.removeTaggedStructure, fake.calls.destroyTaggedStructure], [1, 1],
        "removeTaggedStructure NOT called again before fullReconcileMs");
      clock.advance(DEFAULTS.structures.fullReconcileMs);
      env.pass();
      assert.deepStrictEqual([fake.calls.removeTaggedStructure, fake.calls.destroyTaggedStructure], [2, 2],
        "removeTaggedStructure called again after fullReconcileMs");
      env.structures.stop("test");
    }));
};
