"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { startOccupation, createUnavailableOccupation } = require("../../lib/world/occupation");
const { progressToJson } = require("../../lib/world/occupation/progress");
const { buildSystemCardView } = require("../../lib/observer/views/systemCard");
const invasionRepository = require("../../lib/world/invasions/invasionRepository");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const SETTINGS = Object.freeze({ refreshMs: 15000, maxRows: 12, maxFleets: 200, recentBattles: 5 });
const COMP = Object.freeze([Object.freeze({ hullGroup: "cruiser", count: 3 })]);
const OUTSIDE = 30999999;

function configOf() {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function fakeStations(list) {
  const live = (s) => s.state !== "DESTROYED";
  return { getMode: () => "ready", repository: {
    countLiveBySystem(tx, ids) {
      const m = new Map();
      for (const s of list.filter(live)) {
        if (!ids.includes(s.systemId)) continue;
        const k = `${s.systemId}:${s.factionId}`;
        m.set(k, { systemId: s.systemId, factionId: s.factionId, count: ((m.get(k) || {}).count || 0) + 1 });
      }
      return { ok: true, rows: [...m.values()] };
    },
    listStationsOfFaction: (tx, f, opts) => ({ ok: true, records: list.filter((s) => s.factionId === f
      && (!opts || !opts.states || opts.states.includes(s.state))) }),
    listStationsInSystem: (tx, id) => ({ ok: true, records: list.filter((s) => s.systemId === id && live(s))
      .map((s) => ({ stationId: s.stationId, name: s.stationId, ownerFactionId: s.factionId, state: s.state,
        stateUntilAt: null })) }),
  } };
}

function bootCard(opened, shared, stations) {
  const env = H.boot(opened, shared);
  const config = configOf();
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const views = createViewRegistry();
  const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations, views,
    nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  const ctx = { occupation: r.occupation, world: { repository: repo }, fleets: env.fleets, stations,
    battle: { repository: env.battles } };
  const card = (over = {}) => buildSystemCardView({ ctx: { ...ctx, ...over }, store: env.store, clock: shared.clock,
    getGovernor: () => null, factionNames: new Map([[H.FACTION_A, "Attackers"]]), settings: SETTINGS, nowMs: () => 0 });
  return { ...env, repo, occupation: r.occupation, views, config, ctx, card };
}

function seedSystem(env, systemId, controller, influence) {
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: controller },
    influence: Object.entries(influence).map(([f, s]) => ({ factionId: Number(f), influenceScore: s })) },
  `world:seed:v1:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

async function passesAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 20; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (!p.jobs) return;
  }
}

const countRows = (env) => env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n);
const writes = (env) => [env.repo.getChangeCount(), countRows(env)];

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("T4 system card: INVASION and STABLE, shape, memo = no memo, zero writes, module off = null section", () =>
    H.withStore(driver, async (reopen) => {
      const { S, FACTION_A, FACTION_B } = H;
      const shared = H.sharedOf();
      const stations = fakeStations([{ stationId: "st:a", systemId: S.N0, factionId: FACTION_A, state: "ONLINE" }]);
      const env = bootCard(reopen(), shared, stations);
      seedSystem(env, S.N5, FACTION_B, { [FACTION_A]: 50, [FACTION_B]: 60 });
      seedSystem(env, S.N6, FACTION_B, { [FACTION_B]: 60 });
      const fleet = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.N5, homeSystemId: S.N0,
        fleetRole: "invasion", composition: [...COMP] }, "t4:fleet");
      assert.ok(fleet.ok, JSON.stringify(fleet));
      const sig = env.tx((db) => env.occupation.signalInTx(db, { systemId: S.N5, factionId: FACTION_A,
        signal: "INVASION", at: shared.clock.now() }, "t4:sig"));
      assert.strictEqual(sig.state, "CONTESTED", JSON.stringify(sig));
      await passesAt(env, shared, shared.clock.now() + 3600000);

      const flyer = H.newFleet(env, "t4:flyer", FACTION_A, [...COMP]);
      const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION_A, originSystemId: S.N0,
        targetSystemId: S.N5, objective: "capture", dueAt: shared.clock.now() + 3600000,
        fleets: [{ fleetId: flyer, expectedVersion: 1 }] }, "t4:op");
      assert.ok(op.ok, JSON.stringify(op));
      const plan = env.fleets.planTravel({ fleetId: flyer, targetSystemId: S.N5 }, "t4:plan");
      assert.ok(plan.ok, JSON.stringify(plan));

      const view = env.card();
      assert.strictEqual(view.param, "system");
      assert.strictEqual(typeof view.cacheKey(), "string");
      const before = writes(env);
      const inv = view.getData({ param: S.N5 });
      assert.deepStrictEqual(writes(env), before, "zero writes");
      assert.deepStrictEqual([inv.available, inv.inWorld, inv.systemId, inv.system.state, inv.scoreMax],
        [true, true, S.N5, "INVASION", 100], JSON.stringify(inv.system));
      assert.deepStrictEqual([inv.progress.state, inv.progress.attacker, inv.progress.defender, inv.progress.next],
        ["INVASION", FACTION_A, FACTION_B, "OCCUPIED"]);
      assert.ok(inv.progress.ratio >= 0 && inv.progress.ratio <= 1000 && !("scores" in inv.progress));
      assert.deepStrictEqual(inv.influence.map((r) => [r.factionId, r.role]).sort(),
        [[FACTION_A, "attacker"], [FACTION_B, "defender"]].sort());
      const attackerRow = inv.influence.find((r) => r.role === "attacker");
      assert.deepStrictEqual(attackerRow.marks.map((m) => m.code), ["OCCUPY_MIN"]);
      assert.strictEqual(attackerRow.marks[0].score, env.occupation.params.occupyMinScore);
      assert.deepStrictEqual(inv.fleets.groups.map((g) => [g.factionId, g.role, g.state, g.fleets, g.ships]),
        [[FACTION_A, "invasion", "IDLE", 1, 3]]);
      assert.deepStrictEqual([inv.fleets.fleetsTotal, inv.fleets.shipsTotal, inv.fleets.truncated], [1, 3, false]);
      assert.strictEqual(inv.operations.rows.length, 1);
      const row = inv.operations.rows[0];
      assert.deepStrictEqual([row.type, row.objective, row.state, row.factionId, row.originSystemId, row.fleets, row.ships,
        row.inFlight], ["invasion", "capture", row.state, FACTION_A, S.N0, 1, 3, 1]);
      assert.ok(row.etaMs > 0, "arrival is ahead");
      assert.deepStrictEqual([inv.stations, inv.sieges, inv.invasions, inv.battles], [[], null, [], []]);
      assert.deepStrictEqual(inv.names.find((n) => n[0] === FACTION_A), [FACTION_A, "Attackers"]);
      assert.deepStrictEqual(inv.names.find((n) => n[0] === FACTION_B), [FACTION_B, null]);
      assert.strictEqual(inv.attackerInvasion, null, "no open invasion of the attacker");

      const nowAt = shared.clock.now();
      const withdrawAt = nowAt + 2 * 3600000;
      const ins = env.tx((db) => invasionRepository.insertInvasionInTx(db, { invasionId: "inv-or-b", idempotencyKey: "or-b",
        rollRound: 1, factionId: FACTION_A, profileId: "none", beachheadSystemId: S.N5, captureRangeJumps: 1,
        fleetIds: [], plan: { v: 1 }, startedAt: nowAt - 3600000, withdrawAt }));
      assert.ok(ins.ok, JSON.stringify(ins));
      const EFFECTIVE_SHIFT = 60000;
      const invasions = { effectiveWithdrawAtOf: (row) => row.withdraw_at + EFFECTIVE_SHIFT };
      const timed = env.card({ invasions }).getData({ param: S.N5 });
      assert.deepStrictEqual(timed.attackerInvasion, { state: "ACTIVE", withdrawMs: withdrawAt + EFFECTIVE_SHIFT - nowAt });
      assert.deepStrictEqual(timed.invasions.map((x) => [x.factionId, x.withdrawMs]),
        [[FACTION_A, withdrawAt + EFFECTIVE_SHIFT - nowAt]]);
      assert.strictEqual(env.card().getData({ param: S.N5 }).attackerInvasion.withdrawMs, withdrawAt - nowAt,
        "invasions off -> the stored withdraw_at");

      const stable = view.getData({ param: S.N6 });
      assert.deepStrictEqual([stable.system.state, stable.progress, stable.fleets.groups, stable.operations.rows],
        ["STABLE", null, [], []]);
      assert.deepStrictEqual(stable.influence.map((r) => [r.factionId, r.score, r.role, r.marks]),
        [[FACTION_B, 60, null, []]]);

      const out = view.getData({ param: OUTSIDE });
      assert.deepStrictEqual([out.available, out.inWorld, out.system, out.fleets, out.battles, out.influence],
        [true, false, null, null, null, []]);
      assert.deepStrictEqual(view.getData({}), { available: false, reason: "NO_SYSTEM" });

      const a = H.newFleet(env, "t4:a", FACTION_A, [...COMP]);
      const b = H.newFleet(env, "t4:b", FACTION_B, [...COMP]);
      const battle = H.battleOfFleets(env, "t4", [a], [b], { systemId: S.N5 });
      const fought = view.getData({ param: S.N5 });
      assert.strictEqual(fought.battles.length, 1);
      assert.deepStrictEqual([fought.battles[0].battleId, fought.battles[0].open, fought.battles[0].outcome,
        fought.battles[0].sides.A.factionId, fought.battles[0].sides.B.factionId],
      [battle.battleId, true, null, FACTION_A, FACTION_B]);

      assert.strictEqual(env.card({ battle: { repository: null } }).getData({ param: S.N5 }).battles, null);
      assert.strictEqual(env.card({ fleets: null }).getData({ param: S.N5 }).fleets, null);
      assert.strictEqual(env.card({ stations: null }).getData({ param: S.N5 }).stations, null);
      const bare = env.card({ occupation: createUnavailableOccupation("OFF") }).getData({ param: S.N5 });
      assert.deepStrictEqual([bare.system.state, bare.progress], ["INVASION", null]);
      assert.ok(bare.influence.every((r) => r.role === null && r.marks.length === 0));

      const now = shared.clock.now();
      const memo = new Map();
      const plain = env.tx((db) => env.occupation.readProgressInTx(db, S.N5, now));
      const memoed = env.tx((db) => env.occupation.readProgressInTx(db, S.N5, now, memo));
      const memoedAgain = env.tx((db) => env.occupation.readProgressInTx(db, S.N5, now, memo));
      assert.deepStrictEqual(progressToJson(memoed.progress), progressToJson(plain.progress));
      assert.deepStrictEqual(progressToJson(memoedAgain.progress), progressToJson(plain.progress));
      assert.ok(memo.size >= 1 && [...memo.values()].every((r) => r === null || r instanceof Map));
      assert.deepStrictEqual(env.tx((db) => env.occupation.readProgressInTx(db, OUTSIDE, now)),
        { ok: true, system: null, progress: null });

      const layer = env.views.getView("layer-progress");
      assert.deepStrictEqual(layer.mapLayer, { kind: "bars", order: 21 });
      const seen = writes(env);
      const data = layer.getData();
      assert.deepStrictEqual(writes(env), seen);
      assert.deepStrictEqual(data.items.map((i) => [i.systemId, i.state, i.attacker, i.defender]),
        [[S.N5, "INVASION", FACTION_A, FACTION_B]]);
      assert.strictEqual(data.maxDrawn, env.config.observer.galaxyProgressMaxDrawn);
      assert.strictEqual(typeof layer.cacheKey(), "string");
      env.occupation.stop();
      assert.strictEqual(env.views.getView("layer-progress"), null, "stop unregisters the layer");
    }));

  test("T4 facade: readProgressInTx on the stub refuses; system card under the governor and a closed store", () => {
    const stub = createUnavailableOccupation("OCCUPATION_DISABLED");
    assert.strictEqual(typeof stub.readProgressInTx, "function");
    assert.deepStrictEqual(stub.readProgressInTx(null, 1, 0).ok, false);
    const counts = [];
    const deps = { ctx: {}, clock: { now: () => 30000 }, telemetry: { count: (n) => counts.push(n) },
      getGovernor: () => ({ admits: () => false }), factionNames: new Map(), settings: SETTINGS };
    const held = buildSystemCardView({ ...deps, store: { isOpen: () => true } });
    assert.strictEqual(held.cacheKey(), null);
    assert.deepStrictEqual(held.getData({ param: 1 }), { available: false, reason: "GOVERNOR_HOLD" });
    assert.deepStrictEqual(counts, ["observer.systemCard.deferrals"]);
    const closed = buildSystemCardView({ ...deps, store: null });
    assert.strictEqual(closed.cacheKey(), null);
    assert.deepStrictEqual(closed.getData({ param: 1 }), { available: false, reason: "STORE_CLOSED" });
  });
};
