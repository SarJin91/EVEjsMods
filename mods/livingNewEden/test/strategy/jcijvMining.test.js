"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { planMining } = require("../../lib/strategy/ai/mining");
const { describeNote } = require("../../lib/strategy/activity/notes");
const { createTripRepository } = require("../../lib/economy/mining/tripRepository");
const { createMiningService } = require("../../lib/economy/mining/miningService");
const { createUnavailableMining } = require("../../lib/economy/mining");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { system, STAIN } = require("./fixtures/k3Cluster.fixture");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 500016;
const HOME = 100;
const X = 101;
const Y = 102;
const MINER = Object.freeze([{ hullGroup: "industrial", count: 3 }]);
const INTEL_ENV = "EVEJS_LNE_MINING_CANDIDATE_INTEL_ENABLED";
const COOLDOWN_ENV = "EVEJS_LNE_MINING_BELT_COOLDOWN_ENABLED";

function serviceParams(env) {
  const resolved = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.deepStrictEqual(resolved.errors || [], []);
  return createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
    intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
    scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: resolved.config, hostility: () => true,
    isCampaignOk: () => true, industryCatalog: {} }).params;
}

const plannerParams = (mining) => ({ mining, maxBfsSystems: 256, intelTtlMs: HOUR, mobilizeResourcePerShip: 1,
  mobilizeReservePerShip: 1 });
const SUPPLY = Object.freeze({ stationSystems: [HOME], affordable: { resourceUnits: 1e9, reserveUnits: 1e9 } });
const EDGES = new Map([[HOME, [X, Y]], [X, [HOME]], [Y, [HOME]]]);

function snap(o = {}) {
  const row = (systemId) => ({ systemId, controllerFactionId: F, occupierFactionId: null, occupationState: "STABLE" });
  return { factionId: F, faction: { status: "ACTIVE", homeSystemId: HOME }, stationsMode: "ready",
    stations: [{ stationId: "s1", systemId: HOME, kind: "npc" }], systems: [row(HOME), row(X), row(Y)],
    neighbors: (id) => EDGES.get(id) || [], fleetsTruncated: false, operations: [], operationsTruncated: false,
    intel: [], ...(o.extraIntel ? { extraIntel: o.extraIntel } : {}), at: AT,
    doctrine: { templates: { mining: MINER } },
    fleets: [{ fleetId: "m-1", version: 1, state: "IDLE", fleetRole: "mining", systemId: HOME, refitPending: false,
      operationId: null }],
    mining: { mode: "ready", sites: [{ systemId: X, richnessPermille: 500, projected: false },
      { systemId: Y, richnessPermille: 400, projected: false }], openByBelt: [], busyFleetIds: [],
    ...(o.cooldown ? { cooldownSystemIds: o.cooldown } : {}) } };
}
const dispatchedTo = (plan) => plan.intents.filter((i) => i.type === "MINE_DISPATCH").map((i) => i.beltSystemId);
const hostileAt = (systemId, o = {}) => ({ systemId, observedAt: AT - 1000, hostileFleets: 3, hostileShips: 9,
  hostileStrength: 50, hostileStations: 0, controllerFactionId: F, source: "observe", ...o });

function countingStore(store, calls) {
  const proxies = new WeakMap();
  const isListSql = (sql) => /FROM world_faction_intel\s+WHERE faction_id = \?\s+AND system_id IN \(SELECT value FROM json_each/
    .test(sql);
  const wrapStatement = (st) => new Proxy(st, { get(t, k) {
    if (k === "all") {
      return (...args) => {
        calls.push({ factionId: Number(args[0]), ids: JSON.parse(args[1]) });
        return t.all(...args);
      };
    }
    const v = Reflect.get(t, k, t);
    return typeof v === "function" ? v.bind(t) : v;
  } });
  const wrapDb = (db) => {
    if (!db || typeof db !== "object") return db;
    let p = proxies.get(db);
    if (!p) {
      p = new Proxy(db, { get(t, k) {
        if (k === "prepare") return (sql) => (isListSql(sql) ? wrapStatement(t.prepare(sql)) : t.prepare(sql));
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      } });
      proxies.set(db, p);
    }
    return p;
  };
  return { ...store, transaction: (name, fn, ...rest) => store.transaction(name, (db, ...a) => fn(wrapDb(db), ...a),
    ...rest) };
}

module.exports = ({ test, skip }) => {
  test("JCM1 candidateIntelEnabled: hostile fleets in extraIntel of the richer belt X -> dispatch to Y, note "
    + "MINING_HOSTILE_INTEL; the same snapshot with the flag off -> dispatch to X; hostile stations count only on",
  () => {
    const off = serviceParams({});
    const on = serviceParams({ [INTEL_ENV]: "1" });
    assert.deepStrictEqual([off.mining.candidateIntelEnabled, on.mining.candidateIntelEnabled,
      on.mining.candidateIntelMaxSystems], [false, true, 32]);
    const s = snap({ extraIntel: [hostileAt(X)] });
    const a = planMining(s, SUPPLY, plannerParams(on.mining));
    assert.deepStrictEqual(dispatchedTo(a), [Y], JSON.stringify(a));
    assert.ok(!a.intents.some((i) => i.beltSystemId === X || (i.type === "MOBILIZE" && i.systemId === X)));
    assert.strictEqual(a.notes.filter((n) => n === "MINING_HOSTILE_INTEL").length, 1, a.notes.join());
    const b = planMining(s, SUPPLY, plannerParams(off.mining));
    assert.deepStrictEqual([dispatchedTo(b), b.notes.includes("MINING_HOSTILE_INTEL")], [[X], false]);
    const st = snap({ extraIntel: [hostileAt(X, { hostileFleets: 0, hostileStations: 1 })] });
    assert.deepStrictEqual(dispatchedTo(planMining(st, SUPPLY, plannerParams(on.mining))), [Y]);
    assert.deepStrictEqual(dispatchedTo(planMining(st, SUPPLY, plannerParams(off.mining))), [X]);
    const stale = snap({ extraIntel: [hostileAt(X, { observedAt: AT - 2 * HOUR })] });
    assert.deepStrictEqual(dispatchedTo(planMining(stale, SUPPLY, plannerParams(on.mining))), [X]);
    const both = planMining(snap({ extraIntel: [hostileAt(X), hostileAt(Y)] }), SUPPLY, plannerParams(on.mining));
    assert.deepStrictEqual(both.notes, ["MINING_NO_CANDIDATE", "MINING_HOSTILE_INTEL"]);
    assert.notStrictEqual(describeNote("MINING_HOSTILE_INTEL"), null);
  });

  test("JCM4 beltCooldownEnabled: cooldownSystemIds [X] -> dispatch to Y, note MINING_BELT_COOLDOWN; flag off "
    + "-> X; flag off without the key = the plan of today", () => {
    const off = serviceParams({});
    const on = serviceParams({ [COOLDOWN_ENV]: "1" });
    assert.deepStrictEqual([off.mining.beltCooldownEnabled, on.mining.beltCooldownEnabled], [false, true]);
    const a = planMining(snap({ cooldown: [X] }), SUPPLY, plannerParams(on.mining));
    assert.deepStrictEqual(dispatchedTo(a), [Y], JSON.stringify(a));
    assert.strictEqual(a.notes.filter((n) => n === "MINING_BELT_COOLDOWN").length, 1, a.notes.join());
    const b = planMining(snap({ cooldown: [X] }), SUPPLY, plannerParams(off.mining));
    assert.deepStrictEqual([dispatchedTo(b), b.notes.includes("MINING_BELT_COOLDOWN")], [[X], false]);
    assert.deepStrictEqual(planMining(snap(), SUPPLY, plannerParams(off.mining)), b, "no key, flag off: the same plan");
    const both = serviceParams({ [COOLDOWN_ENV]: "1", [INTEL_ENV]: "1" });
    const c = planMining(snap({ cooldown: [X], extraIntel: [hostileAt(X)] }), SUPPLY, plannerParams(both.mining));
    assert.deepStrictEqual([dispatchedTo(c), c.notes], [[Y], ["MINING_HOSTILE_INTEL"]]);
    assert.notStrictEqual(describeNote("MINING_BELT_COOLDOWN"), null);
  });

  test("JCM5 source facts: world_mining_trips_ended is partial WHERE ended_at IS NOT NULL and the bad-ends "
    + "query repeats the literal", () => {
    const schema = fs.readFileSync(path.join(MOD_DIR, "lib", "economy", "schema.js"), "utf8");
    assert.match(schema, /CREATE INDEX world_mining_trips_ended ON world_mining_trips \(faction_id, ended_at\) WHERE ended_at IS NOT NULL;/);
    const repo = fs.readFileSync(path.join(MOD_DIR, "lib", "economy", "mining", "tripRepository.js"), "utf8");
    const m = repo.match(/badEndsByBelt: db\.prepare\(`([^`]*)`\)/);
    assert.ok(m, "badEndsByBelt statement");
    assert.ok(m[1].includes("faction_id = ? AND ended_at IS NOT NULL AND ended_at >= ?"), m[1]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("JCM3 listBadEndsByBelt on SQLite: ABORTED FLEET_DESTROYED + DIVERTED in the window -> the belt "
    + "TIMEOUT / EMPTY / DELIVERED / before the window / another faction -> no; minCount, limit + truncated; "
    + "readBeltCooldowns (window, flag off without SQL, stub)", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const env = H.boot(opened, shared);
    const { S, FACTION_A, FACTION_B } = H;
    const at = shared.clock.now();
    const comp = [{ hullGroup: "frigate", count: 4 }];
    const rows = [
      ["a1", FACTION_A, S.N5, "ABORTED", "FLEET_DESTROYED", at - HOUR],
      ["a2", FACTION_A, S.N5, "ABORTED", "DIVERTED", at - 2 * HOUR],
      ["a3", FACTION_A, S.N6, "LOST", "FLEET_DESTROYED", at - HOUR],
      ["a4", FACTION_A, S.N6, "ABORTED", "TIMEOUT", at - HOUR],
      ["a5", FACTION_A, S.N6, "DELIVERED", "EMPTY", at - HOUR],
      ["a6", FACTION_A, S.N6, "DELIVERED", "DELIVERED", at - HOUR],
      ["a7", FACTION_A, S.N6, "ABORTED", "NOT_IN_BELT", at - 10 * HOUR],
      ["b1", FACTION_B, S.N6, "ABORTED", "FLEET_DESTROYED", at - HOUR],
      ["b2", FACTION_B, S.N6, "ABORTED", "DIVERTED", at - HOUR],
      ["a8", FACTION_A, S.N7, "ABORTED", "NOT_IN_BELT", at - 3 * HOUR],
      ["a9", FACTION_A, S.N7, "LOST", "DIVERTED", at - 3 * HOUR],
    ];
    for (const [tag, faction, belt, state, reason, endedAt] of rows) {
      const fleetId = H.newFleet(env, `jcm3:${tag}`, faction, comp);
      env.tx((db) => db.prepare(`INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id,
        origin_system_id, belt_system_id, state, sec_class, richness_permille, dispatched_at, ended_at, end_reason,
        created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 'nullsec', 500, ?, ?, ?, ?, ?, 1)`)
        .run(`trip-${tag}`, `jcm3:${tag}`, faction, fleetId, S.N0, belt, state, endedAt - HOUR, endedAt, reason,
          endedAt, endedAt));
    }
    const repo = createTripRepository({ journal: env.journal, clock: shared.clock });
    const read = (spec) => env.tx((db) => repo.listBadEndsByBelt(db, { factionId: FACTION_A, since: at - 6 * HOUR,
      minCount: 2, limit: 10, ...spec }));
    const all = read({});
    assert.deepStrictEqual([all.ok, all.truncated, all.rows.map((r) => ({ ...r }))], [true, false, [
      { systemId: S.N5, n: 2, lastEndedAt: at - HOUR }, { systemId: S.N7, n: 2, lastEndedAt: at - 3 * HOUR }]]);
    assert.deepStrictEqual(read({ minCount: 1 }).rows.map((r) => [r.systemId, r.n]).sort((a, b) => a[0] - b[0]),
      [[S.N7, 2], [S.N5, 2], [S.N6, 1]].sort((a, b) => a[0] - b[0]));
    assert.deepStrictEqual(read({ minCount: 3 }).rows, []);
    assert.deepStrictEqual(read({ since: at - 12 * HOUR, minCount: 2 }).rows.map((r) => r.systemId).sort(),
      [S.N7, S.N5, S.N6].sort(), "a7 inside a longer window");
    assert.deepStrictEqual(read({ factionId: FACTION_B }).rows.map((r) => r.systemId), [S.N6]);
    const page = read({ limit: 1 });
    assert.deepStrictEqual([page.truncated, page.rows.map((r) => r.systemId)], [true, [S.N5]]);
    assert.strictEqual(repo.listBadEndsByBelt({ inTransaction: false }, { factionId: 1, since: 0, minCount: 1,
      limit: 1 }).reason, "TX_REQUIRED");
    assert.strictEqual(env.tx((db) => repo.listBadEndsByBelt(db, { factionId: 0, since: 0, minCount: 1, limit: 1 }))
      .ok, false);

    const base = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config.mining;
    const svcOf = (mining) => createMiningService({ store: opened.store, journal: env.journal, trips: repo,
      fleets: env.fleets, scheduler: env.scheduler, world: { repository: {} }, getStations: () => null,
      clock: shared.clock, ids: shared.ids, config: { mining: { ...base, ...mining } },
      industryCatalog: { oreBand: () => null }, nowMs: () => 0 });
    const on = svcOf({ beltCooldownEnabled: true });
    assert.deepStrictEqual(env.tx((db) => on.readBeltCooldowns(db, FACTION_A, at)),
      { ok: true, systemIds: [S.N7, S.N5].sort((a, b) => a - b), truncated: false });
    const short = svcOf({ beltCooldownEnabled: true, beltCooldownMs: 2 * HOUR });
    assert.deepStrictEqual(env.tx((db) => short.readBeltCooldowns(db, FACTION_A, at)).systemIds, [S.N5]);
    const cut = svcOf({ beltCooldownEnabled: true, beltCooldownMs: 6 * HOUR, tripRetentionMs: 2 * HOUR });
    assert.deepStrictEqual(env.tx((db) => cut.readBeltCooldowns(db, FACTION_A, at)).systemIds, [S.N5], "retention cut");
    const off = svcOf({});
    assert.deepStrictEqual(off.readBeltCooldowns({ inTransaction: false }, FACTION_A, at),
      { ok: true, systemIds: [], truncated: false }, "flag off: no read (a closed tx would refuse)");
    assert.strictEqual(createUnavailableMining("x").readBeltCooldowns().reason, "MINING_UNAVAILABLE");
  }));

  needsDriver("JCM2 review: with candidateIntelEnabled the candidate belt system E (only a site, outside every "
    + "list) is in a listIntel read; flag off -> E is read nowhere", async () => {
    const E = 30000100;
    const graph = R.graphOf({ extra: [system(E, STAIN, 20000999, "nullsec")] });
    const run = (flag) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph,
        controllers: new Map([...R.THEATRE.map((id) => [id, R.SANSHA]), [E, R.SANSHA]]) };
      const calls = [];
      const snaps = [];
      const hooks = { beforeEffect: (d, s) => {
        if (d.factionId === R.SANSHA) snaps.push(s);
        return d;
      } };
      const opened = reopen();
      const env = await R.bootAll({ ...opened, store: countingStore(opened.store, calls) }, shared,
        { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.SANSHA), [INTEL_ENV]: flag }, { mining: true, hooks });
      assert.strictEqual(env.mining.getMode(), "ready");
      const created = env.tx((db) => env.stations.repository.createStation(db, { stationId: "jcm2-st", kind: "upwell",
        typeId: 35832, structureFamily: "astrahus", systemId: E, ownerFactionId: R.SANSHA,
        ownerCorporationId: env.strategy.registry.getFaction(R.SANSHA).ownerCorporationId, origin: "built",
        at: shared.clock.now() }, "jcm2:station"));
      assert.ok(created.ok, JSON.stringify(created));
      calls.length = 0;
      await R.passesAt(env, shared, R.START_MS + R.I);
      env.strategy.stop("test");
      assert.ok(snaps.length >= 1, "a Sansha round ran");
      const site = snaps[0].mining.sites.find((x) => x.systemId === E) || null;
      return { site, read: calls.filter((c) => c.factionId === R.SANSHA).some((c) => c.ids.includes(E)),
        calls: calls.length, extra: snaps[0].extraIntel };
    });
    const off = await run("0");
    assert.ok(off.site && off.site.richnessPermille > 0, `E is a mining site: ${JSON.stringify(off)}`);
    assert.deepStrictEqual([off.read, off.extra == null], [false, true], "flag off: E in no intel read, no extraIntel");
    const on = await run("1");
    assert.ok(on.site, JSON.stringify(on));
    assert.strictEqual(on.read, true, `flag on: E in the extra intel read ${JSON.stringify(on)}`);
    assert.ok(on.calls > off.calls, "one more listIntel query with the flag");
    assert.ok(Array.isArray(on.extra), "extraIntel present");
  });
};
