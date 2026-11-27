"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { startScheduler } = require("../../lib/scheduler");
const { startStations } = require("../../lib/stations");
const { startProduction, createUnavailableProduction } = require("../../lib/economy/production");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A, FACTION_B } = H;
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const PRE_D101 = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_PRODUCTION_LINES_PER_NPC_STATION: "2",
  EVEJS_LNE_PRODUCTION_LINES_PER_UPWELL_STATION: "1", EVEJS_LNE_PRODUCTION_MAX_ACTIVE_JOBS_PER_FACTION: "8",
  EVEJS_LNE_PRODUCTION_MAX_RUNS_PER_JOB: "4", EVEJS_LNE_PRODUCTION_MAX_RUN_MS: "172800000",
  EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "1", EVEJS_LNE_PRODUCTION_MOBILIZATION_STATIONS: "1" } }).config;
const EVENT = "PRODUCTION_JOB_COMPLETE";

function productionConfig() {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } }, stations: DEFAULTS.stations,
    production: PRE_D101.production, persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    observer: { ...DEFAULTS.observer, ...H.CONFIG.observer } };
}

const graphService = (graph) => ({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

async function boot(opened, shared) {
  const cfg = productionConfig();
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const registry = { getFaction: (id) => ([FACTION_A, FACTION_B].includes(Number(id))
    ? { factionId: Number(id), startStations: [], doctrineId: "d" } : null),
  listFactions: () => [{ factionId: FACTION_A }],
  listActiveFactions: () => [{ factionId: FACTION_A }], isActive: (id) => [FACTION_A, FACTION_B].includes(Number(id)),
  getDoctrine: () => ({ templates: { invasion: [{ hullGroup: "cruiser", count: 3 }] } }) };
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph: graphService(shared.graph),
    clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  await st.stations.whenReady();
  const views = createViewRegistry();
  const lines = [];
  const pr = startProduction({ config: cfg, persistence, clock: shared.clock, ids: shared.ids,
    scheduler: sr.scheduler, strategy: { registry }, getStations: () => st.stations, views,
    logger: { log: (l) => lines.push(l) } });
  assert.ok(pr.ok, JSON.stringify(pr));
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, `${JSON.stringify(r)} ${(r.error && r.error.stack) || ""}`);
    return r.value;
  };
  return { store: opened.store, scheduler: sr.scheduler, stations: st.stations, production: pr.production, views,
    lines, tx };
}

function addStation(env, id, kind, factionId, at) {
  const spec = kind === "npc" ? { kind, npcStationId: 60000000 + id.length * 7 + id.charCodeAt(id.length - 1) }
    : { kind, typeId: 35832, structureFamily: "astrahus" };
  const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, ...spec, systemId: S.N0,
    ownerFactionId: factionId, ownerCorporationId: 1000162, origin: kind === "npc" ? "seed" : "built", at },
  `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function seedMinerals(env, stationId, groups, at) {
  const sum = {};
  for (const [g, runs] of groups) {
    for (const [k, v] of Object.entries(RECIPES.GROUPS[g].minerals)) sum[k] = (sum[k] || 0) + v * runs;
  }
  const r = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId, key: `test:seed:${stationId}`,
    reason: "TEST", at, deltas: Object.keys(sum).sort().map((k) => ({ itemKind: "mineral", itemKey: k,
      delta: sum[k] })) }));
  assert.ok(r.ok, JSON.stringify(r));
  return sum;
}

const stockOf = (env, stationId) => env.tx((db) => db.prepare("SELECT item_kind || ':' || item_key AS k, quantity "
  + "FROM world_station_stock WHERE station_id = ? ORDER BY item_kind, item_key").all(stationId))
  .reduce((o, r) => ({ ...o, [r.k]: r.quantity }), {});
const jobOf = (env, id) => env.tx((db) => env.production.jobs.getJob(db, id)).job;
const totalsOf = (env) => env.tx((db) => env.production.jobs.getTotals(db, FACTION_A)).totals;
const count = (env, sql) => env.tx((db) => db.prepare(sql).get().n);

function start(env, shared, stationId, hullGroup, runs, ik) {
  return env.tx((db) => env.production.startJobInTx(db, { factionId: FACTION_A, stationId, hullGroup, runs,
    at: shared.clock.now() }, ik));
}

async function settleAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 12; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (p.jobs === 0) return;
  }
  throw new Error("queue did not settle");
}

function transition(env, stationId, from, to, tag) {
  const rec = env.tx((db) => env.stations.repository.getStation(db, stationId)).record;
  const r = env.tx((db) => env.stations.repository.transitionStation(db, { stationId, expectedVersion: rec.version,
    from, to, key: `test:${tag}`, reason: "TEST", at: rec.updatedAt }));
  assert.ok(r.ok, JSON.stringify(r));
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PR2 job exactly once: minerals out at the start, hulls in at the deadline; duplicate key, second "
    + "trigger, old round and restart change nothing; INSUFFICIENT_STOCK writes nothing; NO_FREE_LINE", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      let opened = reopen();
      let env = await boot(opened, shared);
      assert.strictEqual(env.production.getMode(), "ready");
      const t0 = shared.clock.now();
      addStation(env, "st-n", "npc", FACTION_A, t0);
      addStation(env, "st-u", "upwell", FACTION_A, t0);
      const seeded = seedMinerals(env, "st-n", [["cruiser", 2], ["frigate", 2]], t0);
      const table = env.production.getRecipes();
      const bill = table.billFor("cruiser", 2);

      const a = start(env, shared, "st-n", "cruiser", 2, "pr2:a");
      assert.deepStrictEqual([a.ok, a.duplicate, a.dueAt], [true, false, t0 + 2 * table.lookup("cruiser").runMs],
        JSON.stringify(a));
      const afterStart = stockOf(env, "st-n");
      for (const k of Object.keys(bill)) {
        assert.strictEqual(afterStart[`mineral:${k}`] || 0, seeded[k] - bill[k], k);
      }
      const dup = start(env, shared, "st-n", "cruiser", 2, "pr2:a");
      assert.deepStrictEqual([dup.ok, dup.duplicate, dup.jobId], [true, true, a.jobId]);
      assert.deepStrictEqual(stockOf(env, "st-n"), afterStart, "duplicate: stock unchanged");
      const b = start(env, shared, "st-n", "frigate", 1, "pr2:b");
      assert.ok(b.ok, JSON.stringify(b));
      assert.strictEqual(start(env, shared, "st-n", "frigate", 1, "pr2:c").reason, "NO_FREE_LINE");

      const events = count(env, "SELECT count(*) AS n FROM world_scheduled_events");
      const poor = start(env, shared, "st-u", "frigate", 1, "pr2:poor");
      assert.strictEqual(poor.reason, "INSUFFICIENT_STOCK");
      assert.deepStrictEqual([count(env, "SELECT count(*) AS n FROM world_production_jobs"),
        count(env, "SELECT count(*) AS n FROM world_scheduled_events"), stockOf(env, "st-u")], [2, events, {}]);

      await settleAt(env, shared, b.dueAt);
      assert.deepStrictEqual([jobOf(env, b.jobId).state, jobOf(env, a.jobId).state,
        stockOf(env, "st-n")["hull:group:frigate"]], ["DELIVERED", "ACTIVE", 1]);
      env.production.stop("restart");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared);
      assert.ok(!env.lines.some((l) => l.includes("reconcile open")), env.lines.join("\n"));
      await settleAt(env, shared, a.dueAt);
      assert.deepStrictEqual([jobOf(env, a.jobId).state, stockOf(env, "st-n")["hull:group:cruiser"]],
        ["DELIVERED", 2]);
      const t1 = totalsOf(env);
      assert.deepStrictEqual([t1.jobsStarted, t1.jobsDelivered, t1.hullsStarted, t1.hullsDelivered], [2, 2, 3, 3]);
      const snap = { stock: stockOf(env, "st-n"), totals: totalsOf(env) };
      for (const [k, p] of [["test:again", { jobId: a.jobId, round: 0 }], ["test:old", { jobId: b.jobId, round: 3 }]]) {
        assert.ok(env.scheduler.enqueue(EVENT, p.jobId, shared.clock.now(), p, k).ok);
      }
      await settleAt(env, shared, shared.clock.now() + 1000);
      assert.deepStrictEqual({ stock: stockOf(env, "st-n"), totals: totalsOf(env) }, snap);
      assert.ok(env.production.getStatus().counters.stale >= 2);
      const c = start(env, shared, "st-n", "frigate", 1, "pr2:d");
      assert.ok(c.ok, JSON.stringify(c));
      env.tx((db) => db.prepare("DELETE FROM world_scheduled_events WHERE aggregate_id = ?").run(c.jobId));
      env.production.stop("restart");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared);
      assert.ok(env.lines.some((l) => l.startsWith("production: reconcile open=1 enqueued=1")), env.lines.join("\n"));
      await settleAt(env, shared, c.dueAt);
      assert.strictEqual(stockOf(env, "st-n")["hull:group:frigate"], 2);
      assert.strictEqual(totalsOf(env).hullsDelivered, 4);
    }));

  needsDriver("PR3 station lost -> LOST without hulls; ARMOR_REINFORCE -> WAIT round 1 -> ONLINE -> DELIVERED "
    + "migration 14 -> 15 from zero; config production.*", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    const t0 = shared.clock.now();
    addStation(env, "st-x", "npc", FACTION_A, t0);
    addStation(env, "st-r", "upwell", FACTION_A, t0);
    seedMinerals(env, "st-x", [["frigate", 1]], t0);
    seedMinerals(env, "st-r", [["frigate", 1]], t0);
    const lost = start(env, shared, "st-x", "frigate", 1, "pr3:lost");
    const wait = start(env, shared, "st-r", "frigate", 1, "pr3:wait");
    assert.ok(lost.ok && wait.ok, JSON.stringify([lost, wait]));
    transition(env, "st-x", "ONLINE", "ARMOR_REINFORCE", "x1");
    transition(env, "st-x", "ARMOR_REINFORCE", "HULL_REINFORCE", "x2");
    transition(env, "st-x", "HULL_REINFORCE", "DESTROYED", "x3");
    transition(env, "st-r", "ONLINE", "ARMOR_REINFORCE", "r1");
    const slots = env.tx((db) => env.production.readStationState(db, FACTION_A, []));
    assert.deepStrictEqual([slots.activeJobsTotal, slots.inProduction], [1, { frigate: 1 }], JSON.stringify(slots));
    await settleAt(env, shared, lost.dueAt);
    const l = jobOf(env, lost.jobId);
    assert.deepStrictEqual([l.state, l.endReason, stockOf(env, "st-x")], ["LOST", "STATION_LOST", {}]);
    const w = jobOf(env, wait.jobId);
    assert.deepStrictEqual([w.state, w.waitRound], ["ACTIVE", 1]);
    transition(env, "st-r", "ARMOR_REINFORCE", "ONLINE", "r2");
    await settleAt(env, shared, wait.dueAt + DEFAULTS.production.waitRecheckMs);
    assert.deepStrictEqual([jobOf(env, wait.jobId).state, stockOf(env, "st-r")["hull:group:frigate"]],
      ["DELIVERED", 1]);
    const t = totalsOf(env);
    assert.deepStrictEqual([t.jobsLost, t.hullsLost, t.jobsDelivered], [1, 1, 1]);
    assert.ok(env.lines.some((x) => x.includes("LOST STATION_LOST")), env.lines.join("\n"));
    const view = env.views.getView("production");
    const data = view.getData();
    assert.strictEqual(data.available, true, JSON.stringify(data));
    const a = data.factions.find((x) => x.faction === FACTION_A);
    assert.deepStrictEqual([a.hullPool.groups.frigate, a.deficit.cruiser, a.totals.hullsLost], [1, 3, 1]);
    addStation(env, "st-u", "upwell", FACTION_A, shared.clock.now());
    seedMinerals(env, "st-u", [["frigate", 2]], shared.clock.now());
    assert.ok(start(env, shared, "st-u", "frigate", 1, "pr3:u:a").ok);
    env.tx((db) => db.prepare("UPDATE world_stations SET owner_faction_id = ? WHERE station_id = ?").run(FACTION_B,
      "st-u"));
    const takeover = env.tx((db) => env.production.startJobInTx(db, { factionId: FACTION_B, stationId: "st-u",
      hullGroup: "frigate", runs: 1, at: shared.clock.now() }, "pr3:u:b"));
    assert.ok(takeover.ok, JSON.stringify(takeover));

    const c = DEFAULTS.production;
    assert.deepStrictEqual([c.enabled, c.linesPerNpcStation, c.linesPerUpwellStation, c.maxActiveJobsPerFaction,
      c.maxRunsPerJob, c.maxRunMs, c.mobilizeHulls, c.miningNeedsHulls], [true, 4, 2, 24, 2, 28800000, "required",
      false]);
    const defaultConfig = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    const nonStrategyWarnings = defaultConfig.warnings.filter(w => !w.includes("strategy review may write"));
    assert.strictEqual(nonStrategyWarnings.length, 0, "unexpected warnings: " + defaultConfig.warnings.join("\n"));
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_MINING_ENABLED: "0",
      EVEJS_LNE_PRODUCTION_LINES_PER_NPC_STATION: "0", EVEJS_LNE_PRODUCTION_LINES_PER_UPWELL_STATION: "0",
      EVEJS_LNE_PRODUCTION_MOBILIZE_HULLS: "sometimes" } });
    const text = r.warnings.join("\n");
    assert.ok(text.includes("with the mining service off - no source of hulls"), text);
    assert.ok(text.includes("= 0 - no job can start"), text);
    assert.strictEqual(r.config.production.mobilizeHulls, "required", "bad policy ignored");
    assert.strictEqual(createUnavailableProduction("x").getMode(), "off");
    assert.strictEqual(createUnavailableProduction("x").startJobInTx().reason, "PRODUCTION_UNAVAILABLE");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m15-"));
    const file = path.join(tmp, "world.sqlite");
    const open = (migrations) => {
      const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
      assert.ok(o.ok, JSON.stringify(o));
      return o;
    };
    try {
      const old = open(MIGRATIONS.slice(0, 14));
      assert.strictEqual(old.schemaVersion, 14);
      old.store.close("upgrade");
      const up = open(MIGRATIONS.slice(0, 15));
      assert.deepStrictEqual([up.schemaVersion, up.applied], [15, 1]);
      const tables = up.store.transaction("t", (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = "
        + "'table' AND name LIKE 'world_production_%' ORDER BY name").all().map((x) => x.name));
      assert.deepStrictEqual(tables.value, ["world_production_jobs", "world_production_totals"]);
      up.store.close("done");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }));
};
