"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { startWrecks } = require("../../lib/world/wrecks");
const { startStations } = require("../../lib/stations");
const { startSalvage } = require("../../lib/world/salvage");
const { createSalvageRepository } = require("../../lib/world/salvageRepository");
const { createSalvageService } = require("../../lib/economy/salvageScheduler");
const { effectivePool } = require("../../lib/world/wreckPool");
const S = require("../../lib/world/salvageSchema");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { FACTION_A, FACTION_B } = H;
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const TTL = 604800000;
const TRAVEL_1 = 180000;
const RECOVERY_3 = 135000;

function salvageConfig(over = {}, enabled = true) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, world: { enabled: true }, strategy: { enabled: true } },
    stations: { ...DEFAULTS.stations }, wrecks: { ...DEFAULTS.wrecks },
    salvage: { ...DEFAULTS.salvage, ...over, enabled } };
}

const graphService = (graph) => ({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

async function boot(opened, shared, opts = {}) {
  const env = H.boot(opened, shared);
  const cfg = salvageConfig(opts.salvage, opts.enabled !== false);
  const persistence = { ok: true, store: opened.store, journal: env.journal, worldSeed: opened.worldSeed };
  const wr = startWrecks({ config: cfg, persistence, clock: shared.clock, scheduler: env.scheduler, nowMs: () => 0 });
  assert.ok(wr.ok, JSON.stringify(wr));
  const registry = { getFaction: (id) => ([FACTION_A, FACTION_B].includes(Number(id))
    ? { factionId: Number(id), startStations: [] } : null),
  listFactions: () => [{ factionId: FACTION_A }, { factionId: FACTION_B }],
  listActiveFactions: () => [{ factionId: FACTION_A }, { factionId: FACTION_B }],
  isActive: (id) => [FACTION_A, FACTION_B].includes(Number(id)) };
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph: graphService(shared.graph),
    clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  await st.stations.whenReady();
  const holder = { stations: opts.noStations ? null : st.stations };
  const lines = [];
  const sv = startSalvage({ config: cfg, persistence, clock: shared.clock, scheduler: env.scheduler,
    wrecks: wr.wrecks, graph: graphService(shared.graph), getStations: () => holder.stations,
    logger: { log: (l) => lines.push(l) } });
  return { ...env, now: () => shared.clock.now(), cfg, persistence, wrecks: wr.wrecks, stations: st.stations, holder,
    salvage: sv.ok ? sv.salvage : null, started: sv, lines };
}

function addStation(env, id, systemId, factionId, at) {
  const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
    structureFamily: "astrahus", systemId, ownerFactionId: factionId, ownerCorporationId: 1000162, origin: "built",
    at }, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function addField(env, tag, systemId, winner, at, ttl = TTL) {
  const field = { fieldId: `wf:${tag}`, battleId: null, source: "battle", systemId, environment: "nullsec",
    outcome: winner ? "A_WIN" : "DRAW", winnerFactionId: winner, shipsLost: 3, composition: [[FACTION_B, "frigate", 0, 3]],
    salvageUnits: 6, lootUnits: 5, decayFloorPpm: 250000, createdAt: at, expiresAt: at + ttl };
  const r = env.tx((db) => env.wrecks.repository.insertInTx(db, field, `test:field:${tag}`));
  assert.ok(r.ok, JSON.stringify(r));
  return field.fieldId;
}

const jobOf = (env, fieldId) => env.tx((db) => db.prepare("SELECT * FROM salvage_jobs WHERE field_id = ?")
  .get(fieldId));
const fieldOf = (env, fieldId) => env.tx((db) => env.wrecks.repository.get(db, fieldId)).field;
const stockOf = (env, stationId) => env.tx((db) => db.prepare("SELECT item_kind, item_key, quantity FROM "
  + "world_station_stock WHERE station_id = ? ORDER BY item_key").all(stationId))
  .reduce((o, r) => ({ ...o, [`${r.item_kind}/${r.item_key}`]: r.quantity }), {});

async function settleAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 16; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (p.jobs === 0) return;
  }
  throw new Error("queue did not settle");
}

const firstPulseAt = (shared, intervalMs) => (Math.floor(shared.clock.now() / intervalMs) + 1) * intervalMs;

const harness = Object.freeze({ boot, addStation, addField, jobOf, fieldOf, stockOf, settleAt, firstPulseAt,
  salvageConfig, TRAVEL_1, RECOVERY_3, TTL });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("SV2 registerSalvageOpportunity idempotent (one job per field); processSalvageJobs budget: "
    + "maxNewJobsPerPulse, maxActiveJobs; no station -> NO_HOME once, no winner -> never; stations not ready -> "
    + "nothing written", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, { salvage: { maxNewJobsPerPulse: 2, maxActiveJobs: 3 } });
    assert.strictEqual(env.started.ok, true, JSON.stringify(env.started));
    const t0 = shared.clock.now();
    addStation(env, "st-a", H.S.N0, FACTION_A, t0);
    const f1 = addField(env, "f1", H.S.N5, FACTION_A, t0);
    const fb = addField(env, "fb", H.S.N5, FACTION_B, t0 + 1);
    const f2 = addField(env, "f2", H.S.N6, FACTION_A, t0 + 2);
    const f3 = addField(env, "f3", H.S.N5, FACTION_A, t0 + 3);
    const fn = addField(env, "fn", H.S.N5, null, t0 + 4);
    const service = createSalvageService({ store: env.store, salvage: createSalvageRepository({ journal: env.journal }),
      wrecks: env.wrecks.repository, scheduler: env.scheduler, clock: shared.clock, config: env.cfg,
      getStations: () => env.holder.stations, getGraph: () => shared.graph });
    const at = t0 + 10;
    const spec = { fieldId: f1, factionId: FACTION_A, systemId: H.S.N5, shipsLost: 3, at };
    const one = env.tx((db) => service.registerSalvageOpportunity(db, spec));
    assert.deepStrictEqual([one.ok, one.created, one.jobId], [true, true, S.jobIdOf(f1)], JSON.stringify(one));
    const again = env.tx((db) => service.registerSalvageOpportunity(db, spec));
    assert.deepStrictEqual([again.ok, again.created, again.duplicate], [true, false, true], JSON.stringify(again));
    const j1 = jobOf(env, f1);
    assert.deepStrictEqual([j1.state, j1.phase_seq, j1.home_station_id, j1.jumps, j1.next_at, j1.recovery_ms],
      ["OUTBOUND", 1, "st-a", 1, at + TRAVEL_1, RECOVERY_3]);
    assert.strictEqual(H.eventOf(env, S.dueKey(j1.job_id, 1)).due_at, at + TRAVEL_1);

    const p1 = env.tx((db) => service.processSalvageJobs(db, { at }));
    assert.deepStrictEqual([p1.created, p1.noHome, p1.active, p1.skipped], [1, 1, 2, null], JSON.stringify(p1));
    assert.deepStrictEqual([jobOf(env, fb).state, jobOf(env, fb).end_reason, jobOf(env, fb).home_station_id],
      ["FAILED", "NO_HOME", null]);
    assert.deepStrictEqual([jobOf(env, f2).jumps, jobOf(env, f2).next_at], [2, at + 240000]);
    const p2 = env.tx((db) => service.processSalvageJobs(db, { at }));
    assert.deepStrictEqual([p2.created, p2.active], [1, 3]);
    assert.strictEqual(jobOf(env, f3).state, "OUTBOUND");
    const p3 = env.tx((db) => service.processSalvageJobs(db, { at }));
    assert.deepStrictEqual([p3.created, p3.skipped], [0, "MAX_ACTIVE_JOBS"]);
    assert.strictEqual(jobOf(env, fn), undefined, "a field without a winner never gets a job");
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM salvage_jobs"), 4);

    const f4 = addField(env, "f4", H.S.N5, FACTION_A, t0 + 5);
    env.holder.stations = null;
    const roomy = createSalvageService({ store: env.store, salvage: createSalvageRepository({ journal: env.journal }),
      wrecks: env.wrecks.repository, scheduler: env.scheduler, clock: shared.clock,
      config: { ...env.cfg, salvage: { ...env.cfg.salvage, maxActiveJobs: 10 } },
      getStations: () => env.holder.stations, getGraph: () => shared.graph });
    const before = H.n(env, "SELECT count(*) AS n FROM world_event_journal");
    const p4 = env.tx((db) => roomy.processSalvageJobs(db, { at }));
    assert.deepStrictEqual([p4.created, p4.skipped], [0, "STATIONS_NOT_READY"]);
    assert.strictEqual(jobOf(env, f4), undefined);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal"), before);
    env.salvage.stop("test");
  }));

  needsDriver("SV3 phases through passes: OUTBOUND -> RECOVERING -> RETURNING (pool taken from the field) -> "
    + "DELIVERED, stock credited exactly once (key by hand, replayed delivery); field expired before the arrival -> "
    + "EXHAUSTED, no credit", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, { salvage: { claimPermille: 1000 } });
    const t0 = shared.clock.now();
    addStation(env, "st-a", H.S.N0, FACTION_A, t0);
    const f1 = addField(env, "p1", H.S.N5, FACTION_A, t0);
    const f2 = addField(env, "p2", H.S.N5, FACTION_A, t0);
    const f3 = addField(env, "p3", H.S.N5, FACTION_A, t0, 100000);
    const t1 = firstPulseAt(shared, env.cfg.salvage.pulseIntervalMs);
    await settleAt(env, shared, t1);
    const id = S.jobIdOf(f1);
    assert.deepStrictEqual([jobOf(env, f1).state, jobOf(env, f1).outbound_at, jobOf(env, f1).next_at],
      ["OUTBOUND", t1, t1 + TRAVEL_1]);
    assert.strictEqual(jobOf(env, f2).state, "OUTBOUND");
    assert.deepStrictEqual([jobOf(env, f3).state, jobOf(env, f3).end_reason], ["FAILED", "TOO_LATE"],
      "the field expires before the recovery could end: no slot taken");
    const fv = fieldOf(env, f2);
    const ev = env.tx((db) => env.wrecks.repository.transitionInTx(db, { fieldId: f2, expectedVersion: fv.version,
      from: "ACTIVE", to: "EXPIRED", endReason: "EVICTED_SYSTEM", at: t1 + 1 }, "test:evict:p2"));
    assert.ok(ev.ok, JSON.stringify(ev));

    await settleAt(env, shared, t1 + TRAVEL_1);
    assert.deepStrictEqual([jobOf(env, f1).state, jobOf(env, f1).next_at], ["RECOVERING", t1 + TRAVEL_1 + RECOVERY_3]);
    assert.deepStrictEqual([jobOf(env, f2).state, jobOf(env, f2).end_reason], ["EXHAUSTED", "FIELD_GONE"]);

    const tr = t1 + TRAVEL_1 + RECOVERY_3;
    const pool = effectivePool(fieldOf(env, f1), tr);
    await settleAt(env, shared, tr);
    const back = jobOf(env, f1);
    assert.deepStrictEqual([back.state, back.salvage_units, back.loot_units, back.next_at],
      ["RETURNING", pool.salvage, pool.loot, tr + TRAVEL_1]);
    const field = fieldOf(env, f1);
    assert.deepStrictEqual([field.salvagedSalvageUnits, field.salvagedLootUnits], [6, 5]);
    assert.strictEqual(effectivePool(field, tr + 1).total, 0, "a late player finds nothing");

    await settleAt(env, shared, tr + TRAVEL_1);
    const done = jobOf(env, f1);
    assert.deepStrictEqual([done.state, done.end_reason, done.completed_at, done.next_at],
      ["DELIVERED", "DELIVERED", tr + TRAVEL_1, null]);
    const credited = { "supply/unit:loot": pool.loot, "supply/unit:salvage": pool.salvage };
    assert.deepStrictEqual(stockOf(env, "st-a"), credited);

    const dup = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: "st-a",
      key: S.deliverKey(id), reason: "SALVAGE_DELIVERY", at: tr + TRAVEL_1,
      deltas: [{ itemKind: "supply", itemKey: "unit:loot", delta: pool.loot },
        { itemKind: "supply", itemKey: "unit:salvage", delta: pool.salvage }] }));
    assert.deepStrictEqual([dup.ok, dup.duplicate], [true, true], JSON.stringify(dup));
    const replay = env.scheduler.enqueue("SALVAGE_DELIVERY", id, shared.clock.now(), { jobId: id,
      phaseSeq: done.phase_seq - 1 }, "test:replay");
    assert.ok(replay.ok, JSON.stringify(replay));
    await settleAt(env, shared, shared.clock.now() + 1);
    assert.strictEqual(H.eventOf(env, "test:replay").state, "DONE");
    assert.deepStrictEqual(stockOf(env, "st-a"), credited);
    const c = env.salvage.getStatus().counters;
    assert.deepStrictEqual([c.jobsCreated, c.tooLate, c.recovering, c.collected, c.jobsCompleted, c.jobsExhausted,
      c.stale, c.unitsDropped], [2, 1, 1, 1, 1, 1, 1, 0]);
    env.salvage.stop("test");
  }));

  needsDriver("WE3 default claimPermille 500 - the job reaches RETURNING with half the base "
    + "remainder, the field keeps a pool and stays a salvage anomaly candidate; the collect replay is a duplicate",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    assert.strictEqual(env.cfg.salvage.claimPermille, 500);
    const t0 = shared.clock.now();
    addStation(env, "st-a", H.S.N0, FACTION_A, t0);
    const f1 = addField(env, "h1", H.S.N5, FACTION_A, t0);
    const t1 = firstPulseAt(shared, env.cfg.salvage.pulseIntervalMs);
    await settleAt(env, shared, t1);
    await settleAt(env, shared, t1 + TRAVEL_1);
    const tr = t1 + TRAVEL_1 + RECOVERY_3;
    const pool = effectivePool(fieldOf(env, f1), tr);
    await settleAt(env, shared, tr);
    const back = jobOf(env, f1);
    const field = fieldOf(env, f1);
    const rest = effectivePool(field, tr);
    assert.deepStrictEqual([back.state, field.salvagedSalvageUnits, field.salvagedLootUnits],
      ["RETURNING", 3, 2], JSON.stringify(back));
    assert.deepStrictEqual([back.salvage_units + rest.salvage, back.loot_units + rest.loot], [pool.salvage, pool.loot]);
    assert.ok(rest.total >= 1, JSON.stringify(rest));
    const minPool = DEFAULTS.salvageAnomaly.minPoolUnits;
    const listed = env.tx((db) => env.wrecks.repository.listUnmaterializedInSystem(db, { systemId: H.S.N5, at: tr,
      limit: 8 }));
    assert.deepStrictEqual(listed.fields.filter((f) => effectivePool(f, tr).total >= minPool).map((f) => f.fieldId),
      [f1], "the anomaly candidate predicate (anomalyService.candidatesOf)");
    const again = env.tx((db) => env.wrecks.repository.recordSalvageInTx(db, { fieldId: f1, expectedVersion: 1,
      salvageUnits: 3, lootUnits: 2, at: tr }, S.collectKey(S.jobIdOf(f1))));
    assert.deepStrictEqual([again.ok, again.duplicate], [true, true], JSON.stringify(again));
    const same = fieldOf(env, f1);
    assert.deepStrictEqual([same.salvagedSalvageUnits, same.salvagedLootUnits, same.version],
      [3, 2, field.version]);
    env.salvage.stop("test");
  }));
};

Object.assign(module.exports, { harness });
