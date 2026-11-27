"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { parseSeedScope, indexOverrides, planSystemControl } = require("../../lib/world/controlPlan");
const { createControlSeed, defaultSetTimer } = require("../../lib/world/controlSeed");
const { buildControlView } = require("../../lib/world/controlView");
const { seedDoneKey } = require("../../lib/world/data/seedData");
const { startWorld } = require("../../lib/world");
const { createViewRegistry } = require("../../lib/observer/views");
const { fingerprint } = require("../../lib/util/fingerprint");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const SETTINGS = Object.freeze({ seedEnabled: true, seedScope: "nullsec", seedSliceSystems: 5, seedSliceMs: 1000,
  seedDeferMs: 1000, seedControllerInfluence: 60, seedSdeFactionInfluence: 20, ...LIMITS });
const SANSHA = 500019;
const SERPENTIS = 500020;
const CALDARI = 500001;
const SDE_BUILD = 3396210;
const CONTROL_VIEW_GOLDEN = "016d53e8b8b10e6f879c05415f40f1f14d380220635734d6bce28f70cae227ba";

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withTmp(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-cs-"));
  const open = [];
  const openAt = (name, maxRowsPerTransaction = 500) => {
    seedDbFile(driver, path.join(tmp, name), { seed: 1 });
    const opened = openStore({ filePath: path.join(tmp, name), openDatabase: (f) => new driver.Database(f),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
  };
  return Promise.resolve()
    .then(() => fn(openAt))
    .finally(() => {
      for (const s of open) s.close("test_cleanup");
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (_err) {
      }
    });
}

function manualDefer() {
  const queue = [];
  return {
    queue,
    defer(fn) {
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return { cancel() { entry.cancelled = true; } };
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function drain(d) {
  await tick();
  while (d.queue.length > 0) {
    const entry = d.queue.shift();
    if (!entry.cancelled) entry.fn();
  }
}

function vertex(id, regionId, secClass, factionId) {
  return Object.freeze({ id, name: `S${id}`, regionId, constellationId: regionId + 10000000, security: -0.42,
    trueSecurity: -0.42, secClass, factionId });
}

function fakeGraph() {
  const systems = new Map();
  for (let i = 1; i <= 12; i += 1) {
    const id = 30000000 + i;
    systems.set(id, vertex(id, i <= 6 ? 10000001 : 10000002, "nullsec", i <= 6 ? SANSHA : CALDARI));
  }
  for (const id of [30000101, 30000102, 30000103]) systems.set(id, vertex(id, 10000003, "highsec", CALDARI));
  const regionNames = new Map([[10000001, "Stain"], [10000002, "Syndicate"], [10000003, "The Forge"]]);
  const graph = Object.freeze({
    getSystem: (id) => systems.get(id) || null,
    getSystemsBySecClass: (c) => [...systems.values()].filter((v) => v.secClass === c).map((v) => v.id),
    getRegionName: (id) => regionNames.get(id) || null,
  });
  return { whenReady: () => Promise.resolve({ ok: true, graph }), getGraph: () => ({ ok: true, graph }) };
}

function factionOf(id) {
  if (id <= 30000006) return { systemId: id, factionKey: "sanshas", factionId: SANSHA, source: "faction_id" };
  if (id <= 30000011) return { systemId: id, factionKey: "serpentis", factionId: SERPENTIS, source: "region" };
  return { systemId: id, factionKey: "mixed", factionId: null, source: "unmapped" };
}

function readOnlyAdapter(opts = {}) {
  const writes = [];
  let calls = 0;
  const impl = {
    resolveSystemFactions(ids) {
      calls += 1;
      if (opts.throwOnCall === calls) throw new Error("adapter boom");
      return { ok: true, entries: ids.map(factionOf) };
    },
    readSdeBuild: () => ({ ok: true, build: SDE_BUILD }),
    readFactionNames: () => ({ ok: true, names: new Map([[SANSHA, "Sansha's Nation"], [SERPENTIS, "Serpentis"],
      [CALDARI, "Caldari State"]]) }),
  };
  const adapter = new Proxy({}, {
    get(_target, prop) {
      if (Object.prototype.hasOwnProperty.call(impl, prop)) return impl[prop];
      if (typeof prop === "symbol") return undefined;
      return () => {
        writes.push(String(prop));
        throw new Error(`write attempted: ${String(prop)}`);
      };
    },
    set(_target, prop) {
      writes.push(`set ${String(prop)}`);
      throw new Error(`write attempted: set ${String(prop)}`);
    },
  });
  return { adapter, writes };
}

function makeRepo(clock) {
  const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
  return { journal, repository: createWorldStateRepository({ journal, clock, limits: LIMITS }) };
}

function makeSeed(store, extra = {}) {
  const clock = createManualClock(START_MS);
  const { journal, repository } = makeRepo(clock);
  const d = manualDefer();
  const lines = [];
  const seed = createControlSeed({ store, journal, repository, graph: fakeGraph(), settings: SETTINGS, clock,
    logger: { log: (m) => lines.push(m) }, defer: d.defer, nowMs: () => 0, ...extra });
  return { seed, d, lines, journal, repository };
}

const tx = (store, fn) => {
  const r = store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

const count = (store, sql) => tx(store, (db) => db.prepare(sql).get().n);
const listAll = (store, repository) => tx(store, (db) => repository.listSystems(db, { limit: 500 })).systems;

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("C1 control plan: pirate / sde / none rules, overrides system > region, null override, scope", () => {
    const scope = parseSeedScope("nullsec");
    assert.deepStrictEqual(scope, { ok: true, classes: ["nullsec"], tag: "nullsec" });
    assert.deepStrictEqual(parseSeedScope("lowsec, nullsec"), { ok: true, classes: ["lowsec", "nullsec"],
      tag: "lowsec+nullsec" });
    assert.strictEqual(parseSeedScope("nullsec,foo").reason, "SEED_SCOPE_INVALID");
    const dup = [{ scope: "region", id: 1, controllerFactionId: null, origin: "a" },
      { scope: "region", id: 1, controllerFactionId: 5, origin: "b" }];
    assert.strictEqual(indexOverrides(dup).reason, "CONTROL_OVERRIDES_INVALID");
    assert.strictEqual(indexOverrides([{ scope: "region", id: 1, controllerFactionId: 5 }]).reason,
      "CONTROL_OVERRIDES_INVALID", "origin required");
    const index = indexOverrides([
      { scope: "region", id: 10000009, controllerFactionId: 500002, origin: "test region" },
      { scope: "system", id: 30000007, controllerFactionId: 500003, origin: "test system" },
      { scope: "system", id: 30000008, controllerFactionId: null, origin: "test none" },
    ]).index;
    const s = { controllerInfluence: 60, sdeFactionInfluence: 20 };
    const v = (id, regionId, factionId, secClass = "nullsec") => ({ id, regionId, constellationId: 20000001,
      factionId, secClass });
    const pirate = { factionId: SANSHA, source: "faction_id" };
    const cases = [
      [v(30000001, 10000001, SANSHA), pirate, "pirate", SANSHA, [[SANSHA, 60]]],
      [v(30000002, 10000002, CALDARI), { factionId: SERPENTIS, source: "region" }, "pirate", SERPENTIS,
        [[CALDARI, 20], [SERPENTIS, 60]]],
      [v(30000003, 10000002, CALDARI), { factionId: null, source: "unmapped" }, "sde", CALDARI, [[CALDARI, 60]]],
      [v(30000004, 10000004, 0), { factionId: null, source: "special_space" }, "none", null, []],
      [v(30000005, 10000009, 0), pirate, "override", 500002, [[500002, 60]]],
      [v(30000007, 10000009, 0), pirate, "override", 500003, [[500003, 60]]],
      [v(30000008, 10000009, CALDARI), pirate, "override", null, [[CALDARI, 20]]],
      [v(30000006, 10000001, SANSHA), { factionId: SANSHA, source: "mixed" }, "sde", SANSHA, [[SANSHA, 60]]],
    ];
    for (const [vx, faction, rule, controller, influence] of cases) {
      const plan = planSystemControl(vx, faction, index, s);
      assert.deepStrictEqual([plan.rule, plan.change.state.controllerFactionId,
        plan.change.influence.map((i) => [i.factionId, i.influenceScore])], [rule, controller, influence], vx.id);
      assert.deepStrictEqual([plan.change.expectedVersion, plan.change.reason], [0, "SEED_CONTROL"]);
    }
    const g = fakeGraph().getGraph().graph;
    const planned = scope.classes.flatMap((c) => g.getSystemsBySecClass(c));
    assert.strictEqual(planned.length, 12);
    assert.ok(!planned.includes(30000101));
  });

  needsDriver("C2 seed: 3 slices, done marker with sdeBuild; restart -> already_applied, identical, no write", () =>
    withTmp(driver, async (openAt) => {
      let store = openAt("world.sqlite");
      const ro = readOnlyAdapter();
      const run = makeSeed(store, { adapter: ro.adapter });
      run.seed.start();
      assert.strictEqual(run.seed.getStatus().state, "waiting_graph");
      await drain(run.d);
      const st = run.seed.getStatus();
      assert.deepStrictEqual([st.state, st.created, st.duplicates, st.slices, st.planned, st.controlled,
        st.uncontrolled, st.sdeBuild], ["done", 12, 0, 3, 12, 12, 0, SDE_BUILD]);
      assert.deepStrictEqual(ro.writes, []);
      const systems = listAll(store, run.repository);
      assert.strictEqual(systems.length, 12);
      const byId = new Map(systems.map((x) => [x.systemId, x]));
      assert.strictEqual(byId.get(30000001).controllerFactionId, SANSHA);
      assert.strictEqual(byId.get(30000008).controllerFactionId, SERPENTIS);
      assert.deepStrictEqual(byId.get(30000008).influence.map((i) => [i.factionId, i.influenceScore]),
        [[CALDARI, 20], [SERPENTIS, 60]]);
      assert.strictEqual(byId.get(30000012).controllerFactionId, CALDARI);
      assert.ok(!byId.has(30000101), "highsec outside the scope");
      const marker = tx(store, (db) => run.journal.findByKey(db, seedDoneKey("nullsec")));
      assert.strictEqual(marker.found, true);
      assert.deepStrictEqual(marker.entry.payload, { seedVersion: 1, scope: "nullsec", systems: 12,
        sdeBuild: SDE_BUILD, overridesVersion: 2 });
      const startLine = `control seed: start scope=nullsec systems=12 slice=5 sdeBuild=${SDE_BUILD}`;
      assert.ok(run.lines.includes(startLine), run.lines.join("\n"));
      assert.ok(run.lines.some((l) => /^control seed: 12 systems \(created=12 duplicates=0 existing=0 conflicts=0\) /
        .test(l)), run.lines.join("\n"));
      const journalRows = count(store, "SELECT count(*) AS n FROM world_event_journal");
      assert.strictEqual(journalRows, 13);
      const before = tx(store, (db) => run.repository.listSystems(db, { limit: 500, includeInfluence: true }));

      store.close("restart");
      store = openAt("world.sqlite");
      const ro2 = readOnlyAdapter();
      const again = makeSeed(store, { adapter: ro2.adapter });
      again.seed.start();
      await drain(again.d);
      assert.strictEqual(again.seed.getStatus().state, "already_applied");
      assert.strictEqual(again.seed.getStatus().markerSdeBuild, SDE_BUILD);
      assert.deepStrictEqual(again.lines,
        [`control seed: already applied (scope=nullsec systems=12 sdeBuild=${SDE_BUILD})`]);
      assert.strictEqual(count(store, "SELECT count(*) AS n FROM world_event_journal"), journalRows);
      const after = tx(store, (db) => again.repository.listSystems(db, { limit: 500, includeInfluence: true }));
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(ro2.writes, []);
    }));

  needsDriver("C3 seed interrupted after 2 slices -> next start resumes: duplicates, existing, one entry each", () =>
    withTmp(driver, async (openAt) => {
      const store = openAt("world.sqlite");
      const pre = makeRepo(createManualClock(START_MS));
      const preChange = { systemId: 30000003, expectedVersion: 0, reason: "TEST_PRE",
        state: { securityClass: "nullsec", controllerFactionId: CALDARI } };
      assert.strictEqual(tx(store, (db) => pre.repository.applyChange(db, preChange, "world:test:pre")).ok, true);
      const broken = makeSeed(store, { adapter: readOnlyAdapter({ throwOnCall: 3 }).adapter });
      broken.seed.start();
      await drain(broken.d);
      const st = broken.seed.getStatus();
      assert.deepStrictEqual([st.state, st.reason, st.slices, st.created, st.existing], ["failed", "SEED_SLICE_THREW",
        2, 9, 1]);
      assert.ok(broken.lines.some((l) => l.startsWith("control seed: failed SEED_SLICE_THREW (adapter boom) after 2 "
        + "slices; next start resumes")), broken.lines.join("\n"));
      assert.strictEqual(count(store, "SELECT count(*) AS n FROM world_system_state"), 10);
      assert.strictEqual(tx(store, (db) => broken.journal.findByKey(db, seedDoneKey("nullsec"))).found, false);

      const resumed = makeSeed(store, { adapter: readOnlyAdapter().adapter });
      resumed.seed.start();
      await drain(resumed.d);
      const r = resumed.seed.getStatus();
      assert.deepStrictEqual([r.state, r.created, r.duplicates, r.existing, r.conflicts], ["done", 2, 9, 1, 0]);
      assert.strictEqual(count(store, "SELECT count(*) AS n FROM world_system_state"), 12);
      assert.strictEqual(count(store,
        "SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'SEED_CONTROL'"), 11);
      assert.strictEqual(count(store,
        "SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'SEED_CONTROL_DONE'"), 1);
      const kept = tx(store, (db) => resumed.repository.getSystem(db, 30000003)).system;
      assert.deepStrictEqual([kept.controllerFactionId, kept.version, kept.influence.length], [CALDARI, 1, 0]);
    }));

  needsDriver("C4 startWorld on a real store: returns before the first slice, fields, stop, governor hold", () =>
    withTmp(driver, async (openAt) => {
      const config = { enabled: true, modules: { world: { enabled: true } }, world: SETTINGS };
      const store = openAt("world.sqlite");
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      let resolveGraph;
      const loading = new Promise((resolve) => { resolveGraph = resolve; });
      const d = manualDefer();
      const views = createViewRegistry();
      const started = startWorld({ config, persistence: { ok: true, store, journal }, clock,
        graph: { whenReady: () => loading, getGraph: () => ({ ok: false, reason: "GRAPH_LOADING" }) },
        adapter: readOnlyAdapter().adapter, views, logger: { log() {} }, defer: d.defer, nowMs: () => 0 });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      const world = started.world;
      assert.strictEqual(world.seed.getStatus().state, "waiting_graph");
      assert.strictEqual(count(store, "SELECT count(*) AS n FROM world_system_state"), 0);
      assert.ok(views.getView("control"), "control view registered");
      const created = world.applyChange({ systemId: 30000050, expectedVersion: 0, reason: "TEST",
        state: { securityClass: "nullsec" } }, "world:test:50");
      assert.deepStrictEqual([created.ok, created.created], [true, true]);
      assert.strictEqual(world.getSystem(30000050).system.securityClass, "nullsec");
      world.stop("test");
      assert.strictEqual(world.seed.getStatus().state, "stopped");
      assert.strictEqual(views.getView("control"), null, "view unregistered on stop");
      resolveGraph(fakeGraph().getGraph());
      await drain(d);
      assert.strictEqual(count(store, "SELECT count(*) AS n FROM world_system_state"), 1, "nothing after stop");

      const tight = openAt("tight.sqlite", 1);
      const tightJournal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const limited = startWorld({ config: { ...config, world: { ...SETTINGS, seedEnabled: false } },
        persistence: { ok: true, store: tight, journal: tightJournal }, clock, logger: { log() {} } }).world;
      const refused = limited.applyChange({ systemId: 30000051, expectedVersion: 0, reason: "TEST",
        state: { securityClass: "nullsec" } }, "world:test:51");
      assert.deepStrictEqual([refused.ok, refused.reason, typeof refused.rows, refused.limit],
        [false, "TX_ROW_LIMIT", "number", 1]);
      assert.strictEqual(limited.seed.getStatus().state, "disabled");

      const timers = [];
      const held = makeSeed(openAt("held.sqlite"), { adapter: readOnlyAdapter().adapter,
        getGovernor: () => ({ admits: (wc) => wc !== "MAINTENANCE" }),
        setTimer: (fn, ms) => { timers.push(ms); return { cancel() {} }; } });
      held.seed.start();
      await drain(held.d);
      assert.deepStrictEqual([held.seed.getStatus().state, held.seed.getStatus().deferrals, timers],
        ["deferred", 1, [1000]]);
      held.seed.stop("test");
      const timer = defaultSetTimer(() => {}, 60000);
      assert.strictEqual(timer.hasRef(), false, "the default seed timer is unref'd");
      timer.cancel();
    }));

  needsDriver("C6 view control: totals, region names, no times in systems, cacheKey stable until a change", () =>
    withTmp(driver, async (openAt) => {
      const store = openAt("world.sqlite");
      const ro = readOnlyAdapter();
      const run = makeSeed(store, { adapter: ro.adapter });
      run.seed.start();
      await drain(run.d);
      const view = buildControlView({ store, repository: run.repository, graph: fakeGraph(),
        getSeedStatus: run.seed.getStatus, factionNames: ro.adapter.readFactionNames().names, maxListLimit: 5 });
      const data = view.getData();
      assert.strictEqual(data.available, true);
      assert.deepStrictEqual(data.totals, { systems: 12, controlled: 12, uncontrolled: 0 });
      assert.deepStrictEqual(data.regions.map((r) => r.slice(0, 6)), [
        [10000001, "Stain", 6, 6, SANSHA, 6], [10000002, "Syndicate", 6, 6, SERPENTIS, 5]]);
      assert.deepStrictEqual(data.factions[0], [SANSHA, "Sansha's Nation", 6]);
      assert.deepStrictEqual(data.systems.find((s) => s[0] === 30000008),
        [30000008, "S30000008", 10000002, -0.4, SERPENTIS, 60, [[CALDARI, 20], [SERPENTIS, 60]]]);
      assert.ok(data.factionNames.some(([id, name]) => id === CALDARI && name === "Caldari State"));
      assert.ok(!JSON.stringify(data.systems).includes(String(START_MS)), "no times in systems");
      assert.strictEqual(fingerprint(JSON.parse(JSON.stringify(data))), CONTROL_VIEW_GOLDEN, "control data unchanged");
      const key = view.cacheKey();
      assert.strictEqual(view.cacheKey(), key);
      const r = tx(store, (db) => run.repository.applyChange(db, { systemId: 30000001, expectedVersion: 1,
        reason: "TEST", state: { occupationState: "CONTESTED" } }, "world:test:c6"));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.notStrictEqual(view.cacheKey(), key);
    }));
};
