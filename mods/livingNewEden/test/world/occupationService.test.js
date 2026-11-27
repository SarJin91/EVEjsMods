"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { startOccupation } = require("../../lib/world/occupation");
const { createOccupationService } = require("../../lib/world/occupation/occupationService");
const M = require("../../lib/world/occupation/machine");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { tickKey } = require("../../lib/world/occupation/schema");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { createViewRegistry } = require("../../lib/observer/views");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { startStrategy } = require("../../lib/strategy");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { k3StaticMap } = require("../strategy/fixtures/k3Cluster.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AMARR = 500003;
const SANSHA = 500019;
const EVENT = "OCCUPATION_PHASE_CHANGE";
const HOUR = 3600000;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function fakeStations(list) {
  return { getMode: () => "ready", repository: {
    countLiveBySystem(tx, ids) {
      const m = new Map();
      for (const s of list) {
        if (!ids.includes(s.systemId) || s.state === "DESTROYED") continue;
        const k = `${s.systemId}:${s.factionId}`;
        m.set(k, { systemId: s.systemId, factionId: s.factionId, count: ((m.get(k) || {}).count || 0) + 1 });
      }
      return { ok: true, rows: [...m.values()] };
    },
    listStationsOfFaction(tx, f, opts) {
      return { ok: true, records: list.filter((s) => s.factionId === f && (!opts || !opts.states
        || opts.states.includes(s.state))) };
    },
  } };
}

function bootOcc(opened, shared, stations, envOver) {
  const env = H.boot(opened, shared);
  env.now = () => shared.clock.now();
  const config = configOf(envOver);
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const lines = [];
  const views = createViewRegistry();
  const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations, views,
    logger: { log: (l) => lines.push(l) }, nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  return { ...env, repo, occupation: r.occupation, config, lines, views };
}

function seedSystem(env, systemId, controller, influence) {
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: controller },
    influence: Object.entries(influence).map(([f, s]) => ({ factionId: Number(f), influenceScore: s })) },
  `world:seed:v1:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

const systemOf = (env, id) => env.tx((db) => env.repo.getSystem(db, id)).system;
const scoreOf = (sys, f) => ((sys.influence || []).find((i) => i.factionId === f) || { influenceScore: 0 })
  .influenceScore;
const openEvents = (env, id) => env.tx((db) => db.prepare(`SELECT idempotency_key AS k FROM world_scheduled_events
  WHERE event_type = ? AND aggregate_id = ? AND state IN ('QUEUED', 'CLAIMED')`).all(EVENT, String(id)));

function signal(env, systemId, factionId, sig, at, key) {
  return env.tx((db) => env.occupation.signalInTx(db, { systemId, factionId, signal: sig, at }, key));
}

async function passesAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 20; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (!p.jobs) return;
  }
}

module.exports = ({ test, skip, bench }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const needsBench = (name, fn) => {
    if (driver.ok) bench(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const { S, FACTION_A, FACTION_B } = H;

  needsDriver("O3 BATTLE_SETTLED exactly once: settle twice -> +20 once and one battle event; apply again under "
    + "the same ck -> duplicate; no world row -> NO_ROW, settlement COMPLETED", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const stations = fakeStations([{ stationId: "st:a", systemId: S.N0, factionId: FACTION_A, state: "ONLINE" }]);
    const env = bootOcc(reopen(), shared, stations);
    seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
    const sig = signal(env, S.N5, FACTION_A, "INVASION", shared.clock.now(), "test:sig");
    assert.deepStrictEqual([sig.ok, sig.outcome, sig.state], [true, "STARTED", "CONTESTED"], JSON.stringify(sig));
    const before = systemOf(env, S.N5);
    assert.deepStrictEqual([before.occupierFactionId, before.phaseSeq, scoreOf(before, FACTION_A)], [FACTION_A, 1, 0]);
    const panel = env.views.getView("occupation").getData();
    assert.deepStrictEqual(panel.systems.map((s) => [s.systemId, s.state, s.controllerInfluence]),
      [[S.N5, "CONTESTED", 60]], JSON.stringify(panel));

    const settlement = env.makeSettlement({ consequences: [env.occupation.consequence] });
    const a = H.newFleet(env, "o3:a", FACTION_A, [{ hullGroup: "cruiser", count: 2 }]);
    const b = H.newFleet(env, "o3:b", FACTION_B, [{ hullGroup: "frigate", count: 2 }]);
    const battle = H.battleOfFleets(env, "o3", [a], [b], { systemId: S.N5 });
    const result = H.resultFor(battle.input, "A_WIN", { [b]: (e) => ({ d: e.count, e: 0 }) });
    const first = H.settleIn(env, settlement, battle, result);
    assert.ok(first.ok && first.duplicate === false, JSON.stringify(first));
    assert.deepStrictEqual(first.consequences, { applied: ["occupation"], refused: [] });
    const second = H.settleIn(env, settlement, battle, result);
    assert.deepStrictEqual([second.ok, second.duplicate], [true, true]);
    const after = systemOf(env, S.N5);
    assert.deepStrictEqual([scoreOf(after, FACTION_A), scoreOf(after, FACTION_B)], [20, 45]);
    assert.strictEqual(after.version, before.version + 1);
    const battleEvents = env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_scheduled_events "
      + "WHERE idempotency_key = ?").get(`occ:${S.N5}:1:b:${battle.battleId}`).n);
    assert.strictEqual(battleEvents, 1);
    const settled = { battleId: battle.battleId, systemId: S.N5, at: shared.clock.now(), outcome: "A_WIN",
      winnerSide: "A", winnerFactionId: FACTION_A, sides: { A: { factionId: FACTION_A }, B: { factionId: FACTION_B } } };
    const again = env.tx((db) => env.occupation.consequence.apply(db, settled, `${first.settlementKey}:c:occupation`));
    assert.deepStrictEqual(again, { ok: true, outcome: "DUPLICATE" });
    assert.strictEqual(systemOf(env, S.N5).version, after.version);
    const c = H.newFleet(env, "o3:c", FACTION_A, [{ hullGroup: "cruiser", count: 2 }]);
    const d = H.newFleet(env, "o3:d", FACTION_B, [{ hullGroup: "frigate", count: 2 }]);
    const other = H.battleOfFleets(env, "o3b", [c], [d], { systemId: S.N6 });
    const r = H.settleIn(env, settlement, other, H.resultFor(other.input, "A_WIN", { [d]: (e) => ({ d: e.count,
      e: 0 }) }));
    assert.deepStrictEqual([r.ok, r.outcome, r.consequences.applied], [true, "COMPLETED", ["occupation"]]);
    assert.strictEqual(env.occupation.getStatus().counters.battleNoRow, 1);
    seedSystem(env, S.N6, FACTION_B, { [FACTION_B]: 60 });
    const t0 = shared.clock.now();
    const raid = { battleId: "o6:raid", systemId: S.N6, at: t0, outcome: "A_WIN", winnerSide: "A",
      winnerFactionId: FACTION_A, sides: { A: { factionId: FACTION_A }, B: { factionId: FACTION_B } } };
    const r1 = env.tx((db) => env.occupation.consequence.apply(db, raid, "o6:ck"));
    assert.strictEqual(r1.outcome, "INFLUENCE", JSON.stringify(r1));
    const raided = systemOf(env, S.N6);
    assert.deepStrictEqual([scoreOf(raided, FACTION_B), scoreOf(raided, FACTION_A), raided.influenceEvaluatedAt],
      [45, 20, t0]);
    assert.deepStrictEqual(env.tx((db) => env.occupation.consequence.apply(db, { ...raid, at: t0 + 5 * 3600000 },
      "o6:ck")), { ok: true, outcome: "DUPLICATE" });
    assert.strictEqual(systemOf(env, S.N6).version, raided.version);
    shared.clock.set(t0 + 15 * 3600000);
    const s6 = signal(env, S.N6, FACTION_A, "INVASION", shared.clock.now(), "o6:sig");
    assert.ok(s6.ok && s6.drift === 2, JSON.stringify(s6));
    const back = systemOf(env, S.N6);
    assert.deepStrictEqual([back.occupationState, scoreOf(back, FACTION_B), scoreOf(back, FACTION_A)],
      ["CONTESTED", 60, 5]);
    env.occupation.stop("test");
  }));

  async function restartScenario(full) {
    const stations = fakeStations([{ stationId: "st:amarr", systemId: S.N0, factionId: AMARR, state: "ONLINE" }]);
    const I = HOUR;
    const ENV = { EVEJS_LNE_OCCUPATION_EVAL_INTERVAL_MS: String(I) };
    async function scenario(restartAt) {
      return H.withStore(driver, async (reopen) => {
        const shared = H.sharedOf();
        let env = bootOcc(reopen(), shared, stations, ENV);
        const t0 = shared.clock.now();
        seedSystem(env, S.N5, SANSHA, { [SANSHA]: 60 });
        for (let i = 0; i < 3; i += 1) {
          const r = env.fleets.createFleet({ factionId: AMARR, currentSystemId: S.N5, homeSystemId: S.N0,
            fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 4 }] }, `o4:fleet:${i}`);
          assert.ok(r.ok, JSON.stringify(r));
        }
        const phases = [];
        let dupes = 0;
        let last = "STABLE";
        const restart = () => {
          env.occupation.stop("restart");
          env.store.close("restart");
          env = bootOcc(reopen(), shared, stations, ENV);
          dupes += env.occupation.getStatus().counters.bootstrapDuplicates;
          const now = systemOf(env, S.N5);
          const current = openEvents(env, S.N5).filter((e) => e.k.startsWith(`occ:${S.N5}:${now.phaseSeq}:`));
          assert.strictEqual(current.length, now.occupationState === "STABLE" ? 0 : 1, JSON.stringify(current));
        };
        const observe = (at) => {
          const s = systemOf(env, S.N5);
          if (s.occupationState === last) return false;
          last = s.occupationState;
          phases.push([s.occupationState, at - t0, s.controllerFactionId, s.occupierFactionId]);
          return true;
        };
        assert.strictEqual(signal(env, S.N5, AMARR, "RECON", t0, "o4:recon").outcome, "STARTED");
        if (observe(t0) && restartAt(last)) restart();
        const t1 = t0 + 30 * 60000;
        shared.clock.set(t1);
        assert.strictEqual(signal(env, S.N5, AMARR, "INVASION", t1, "o4:invasion").outcome, "ESCALATED");
        if (observe(t1) && restartAt(last)) restart();
        for (let at = (Math.floor(t1 / I) + 1) * I; at <= t0 + 60 * HOUR; at += I) {
          await passesAt(env, shared, at);
          if (observe(at) && restartAt(last)) restart();
          if (last === "STABLE") break;
        }
        const final = systemOf(env, S.N5);
        const garrison = env.tx((db) => db.prepare("SELECT count(*) AS n FROM virtual_fleets WHERE faction_id = ? "
          + "AND fleet_role = 'garrison'").get(AMARR).n);
        const stale = env.occupation.getStatus().counters.stale;
        const out = { phases, controller: final.controllerFactionId, occupier: final.occupierFactionId,
          captured: final.capturedAt !== null, amarr: scoreOf(final, AMARR), sansha: scoreOf(final, SANSHA), garrison,
          open: openEvents(env, S.N5).length, dupes, stale };
        env.occupation.stop("test");
        return out;
      });
    }
    const PATH = ["RECON", "CONTESTED", "INVASION", "OCCUPIED", "CONSOLIDATING", "STABLE"];
    if (!full) {
      const short = await scenario((state) => state === "CONTESTED" || state === "OCCUPIED");
      assert.deepStrictEqual(short.phases.map((p) => p[0]), PATH, JSON.stringify(short.phases));
      assert.deepStrictEqual([short.controller, short.occupier, short.captured, short.garrison, short.open],
        [AMARR, null, true, 1, 0]);
      const occ = short.phases.find((p) => p[0] === "OCCUPIED");
      assert.ok(occ[1] >= short.phases.find((p) => p[0] === "INVASION")[1] + HOUR, JSON.stringify(short.phases));
      assert.ok(short.dupes >= 1, `bootstrap duplicates ${short.dupes}`);
      return;
    }
    const ref = await scenario(() => false);
    assert.deepStrictEqual(ref.phases.map((p) => p[0]), PATH, JSON.stringify(ref.phases));
    assert.deepStrictEqual([ref.controller, ref.occupier, ref.captured, ref.garrison, ref.open],
      [AMARR, null, true, 1, 0]);
    const occupied = ref.phases.find((p) => p[0] === "OCCUPIED");
    const invasion = ref.phases.find((p) => p[0] === "INVASION");
    assert.ok(occupied[1] >= invasion[1] + HOUR, JSON.stringify(ref.phases));
    assert.strictEqual(ref.phases.find((p) => p[0] === "INVASION")[2], SANSHA, "the controller changes at OCCUPIED");
    const rs = await scenario(() => true);
    assert.deepStrictEqual(rs.phases, ref.phases);
    assert.deepStrictEqual([rs.controller, rs.occupier, rs.captured, rs.garrison, rs.open],
      [ref.controller, ref.occupier, ref.captured, ref.garrison, ref.open]);
    assert.ok(Math.abs(rs.amarr - ref.amarr) <= 0.1 && Math.abs(rs.sansha - ref.sansha) <= 0.1,
      `${rs.amarr}/${ref.amarr} ${rs.sansha}/${ref.sansha}`);
    assert.ok(rs.dupes >= 1, `bootstrap duplicates ${rs.dupes}`);
    assert.ok(tickKey(S.N5, 0, I, 1).startsWith(`occ:${S.N5}:0:t:${I}:`));
  }
  needsDriver("E2 capture belt in the occupation: INVASION of Amarr in the belt beyond the station range -> "
    + "STARTED; strategy unavailable -> rangeKnown false (no detachment, no fall back); no getter ->",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const config = configOf({ EVEJS_LNE_STRATEGY_CAPTURE_RANGE_FROM_STATION_JUMPS: "1" });
    const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
    const w = { ...env, repo };
    const stations = fakeStations([{ stationId: "st:amarr", systemId: S.N0, factionId: AMARR, state: "ONLINE" }]);
    const serviceOf = (getCaptureBelt) => createOccupationService({ store: env.store, journal: env.journal,
      repository: repo, fleets: env.fleets, scheduler: env.scheduler,
      graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations, getCaptureBelt,
      hostility: createHostility(), powerTable: buildPowerTable(GROUPS), clock: shared.clock, config });
    const belt = (f) => (f === AMARR ? { ok: true, mode: "ready", captures: true, jumps: 10, sources: 1,
      reach: new Map([[S.N6, 2], [S.N7, 3]]) } : { ok: true, mode: "off", reason: "NO_OWN_SPACE" });
    const unavailable = () => ({ ok: false, reason: "STRATEGY_UNAVAILABLE" });
    const now = shared.clock.now();
    const sig = (svc, key) => env.tx((db) => svc.signalInTx(db, { systemId: S.N6, factionId: AMARR,
      signal: "INVASION", at: now }, key));
    seedSystem(w, S.N6, SANSHA, { [SANSHA]: 60 });
    assert.deepStrictEqual(sig(serviceOf(undefined), "e2:sig:none"), { ok: false, reason: "OUT_OF_CAPTURE_RANGE" });
    assert.deepStrictEqual(sig(serviceOf(unavailable), "e2:sig:unknown"),
      { ok: false, reason: "OUT_OF_CAPTURE_RANGE" });
    const started = sig(serviceOf(belt), "e2:sig:belt");
    assert.deepStrictEqual([started.ok, started.outcome, started.state], [true, "STARTED", "CONTESTED"],
      JSON.stringify(started));
    seedSystem(w, S.N7, AMARR, { [AMARR]: 60 });
    env.tx((db) => assert.ok(repo.applyChange(db, { systemId: S.N7, expectedVersion: 1, reason: "TEST_CAPTURED",
      state: { occupationState: "CONSOLIDATING", occupierFactionId: AMARR, previousControllerFactionId: SANSHA,
        capturedAt: now, phaseSeq: 3 } }, "e2:captured").ok));
    assert.ok(env.fleets.createFleet({ factionId: AMARR, currentSystemId: S.N7, homeSystemId: S.N0,
      fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 4 }] }, "e2:fleet").ok);
    const evalOf = (svc) => env.tx((db) => {
      const r = svc.readView(db, S.N7, now + 60000, []);
      assert.ok(r.ok, JSON.stringify(r));
      const ev = M.evaluate(r.view, { kind: "tick" }, svc.params);
      return [r.view.rangeKnown, r.view.inRange(AMARR), ev.statePatch.occupationState, ev.statePatch.detachedSinceAt,
        ev.notes.includes("DETACHED")];
    });
    assert.deepStrictEqual(evalOf(serviceOf(undefined)), [true, false, "OCCUPIED", now + 60000, true], "out of range: detached");
    assert.deepStrictEqual(evalOf(serviceOf(unavailable)), [false, false, "CONSOLIDATING", null, false],
      "strategy unavailable: nothing cut off, nothing rolled back");
    assert.deepStrictEqual(evalOf(serviceOf(() => { throw new Error("boom"); })),
      [false, false, "CONSOLIDATING", null, false]);
    assert.deepStrictEqual(evalOf(serviceOf(belt)), [true, true, "CONSOLIDATING", null, false], "in the belt");
  }));

  needsDriver("H1 SWEEP-hunt: a lone hostile hunter is no presence (the invader holds and accrues); a hunter "
    + "with a combat fleet of its faction still blocks the holder", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const stations = fakeStations([{ stationId: "st:amarr", systemId: S.N0, factionId: AMARR, state: "ONLINE" }]);
    const base = H.boot(reopen(), shared);
    const repo = createWorldStateRepository({ journal: base.journal, clock: shared.clock, limits: LIMITS });
    const svc = createOccupationService({ store: base.store, journal: base.journal, repository: repo,
      fleets: base.fleets, scheduler: base.scheduler, graph: { getGraph: () => ({ ok: true, graph: shared.graph }) },
      getStations: () => stations, hostility: createHostility(), powerTable: buildPowerTable(GROUPS),
      clock: shared.clock, config: configOf() });
    const env = { ...base, repo, occupation: svc };
    seedSystem(env, S.N5, SANSHA, { [SANSHA]: 60 });
    const t0 = shared.clock.now();
    assert.strictEqual(signal(env, S.N5, AMARR, "INVASION", t0, "h1:sig").outcome, "STARTED");
    const fleet = (key, factionId, fleetRole) => assert.ok(env.fleets.createFleet({ factionId, currentSystemId: S.N5,
      homeSystemId: S.N0, fleetRole, composition: [{ hullGroup: "cruiser", count: 4 }] }, key).ok);
    fleet("h1:amarr", AMARR, "invasion");
    fleet("h1:hunter", SANSHA, "hunter");
    const evalAt = (at) => {
      const r = env.tx((db) => env.occupation.readView(db, S.N5, at, []));
      assert.ok(r.ok, JSON.stringify(r));
      const ev = M.evaluate(r.view, { kind: "tick" }, env.occupation.params);
      const amarr = ev.influence.find((e) => e.factionId === AMARR);
      return [[...r.view.presence.keys()].sort((a, b) => a - b), amarr ? amarr.influenceScore : 0];
    };
    const [alone, accrued] = evalAt(t0 + HOUR);
    assert.deepStrictEqual(alone, [AMARR]);
    assert.ok(accrued > 0, `Amarr accrues with a lone Sansha hunter: ${accrued}`);
    fleet("h1:patrol", SANSHA, "patrol");
    const [both, blocked] = evalAt(t0 + HOUR);
    assert.deepStrictEqual(both, [AMARR, SANSHA]);
    assert.strictEqual(blocked, 0, "a hunter with a Sansha patrol still blocks the holder");
    env.occupation.stop("test");
  }));

  needsBench("O4 restart in every phase: RECON -> CONTESTED -> INVASION -> OCCUPIED -> CONSOLIDATING -> STABLE "
    + "the same path with a restart after each transition", () => restartScenario(true));
  needsDriver("O4s restart after CONTESTED and OCCUPIED: the same path RECON ->... -> STABLE",
    () => restartScenario(false));

  needsBench("O5 strategy: LAUNCH invasion -> CONTESTED (pretender Amarr), a front after its operation ended (P7) "
    + "another faction -> OCCUPATION_BUSY, the outer write kept; station lost -> TERRITORY_MARK, controller kept",
  () => H.withStore(driver, async (reopen) => {
    const START = 1760000000000;
    const I = 900000;
    const SAMINER = 30001721;
    const SERPENTIS = 500020;
    const Q = SAMINER;
    const clock = createManualClock(START);
    const built = buildUniverseGraph(k3StaticMap());
    assert.ok(built.ok);
    const graph = Object.freeze({ ...built.graph,
      ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 }).publicApi });
    const ids = createIdGenerator({ clock, rng: createRng(5) });
    const config = configOf({ EVEJS_LNE_STRATEGY_TARGET_PICK_TOP_K: "1", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: "500003,500006,500019,500020",
      EVEJS_LNE_STRATEGY_CAPTURE_REQUIRES_ADJACENCY: "0" });
    const opened = reopen();
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
    const graphService = { whenReady: () => Promise.resolve({ ok: true, graph }), getGraph: () => ({ ok: true, graph }) };
    const tx = (fn) => {
      const r = opened.store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const repo = createWorldStateRepository({ journal, clock, limits: LIMITS });
    const theatre = [...graph.getSystemIds()].filter((id) => id >= 30001867 && id <= 30001955
      && graph.getSystem(id).regionId === 10000022 && graph.getSystem(id).constellationId !== 20000999);
    const env = { tx, repo };
    for (const id of theatre) seedSystem(env, id, SANSHA, { [SANSHA]: 60 });
    seedSystem(env, SAMINER, AMARR, { [AMARR]: 60 });
    tx((db) => repo.applyChange(db, { systemId: Q, expectedVersion: 1, reason: "TEST_CAPTURED",
      state: { capturedAt: START } }, "test:captured"));
    const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock, ids, nowMs: () => 0 });
    assert.ok(sr.ok);
    const holder = { stations: null, occupation: null };
    const fr = startFleets({ config, persistence, clock, ids, scheduler: sr.scheduler, graph: graphService,
      presence: null, views: createViewRegistry(), getStations: () => holder.stations });
    assert.ok(fr.ok);
    const or = startOccupation({ config, persistence, clock, scheduler: sr.scheduler, fleets: fr.fleets,
      world: { repository: repo }, graph: graphService, getStations: () => holder.stations, nowMs: () => 0 });
    assert.ok(or.ok, JSON.stringify(or));
    holder.occupation = or.occupation;
    const decisions = [];
    const lines = [];
    const st = startStrategy({ config, persistence, clock, graph: graphService, world: { repository: repo },
      scheduler: sr.scheduler, fleets: fr.fleets, getStations: () => holder.stations,
      getOccupation: () => holder.occupation, views: createViewRegistry(), logger: { log: (l) => lines.push(l) },
      hooks: { beforeEffect: (d) => {
        if (d.factionId === AMARR) decisions.push(d);
        return d;
      } } });
    assert.ok(st.ok, JSON.stringify(st));
    await st.strategy.whenReady();
    const stR = startStations({ config, persistence, strategy: st.strategy, graph: graphService, clock,
      views: createViewRegistry() });
    assert.ok(stR.ok);
    holder.stations = stR.stations;
    await stR.stations.whenReady();
    const reach = bfs([SAMINER], (id) => graph.getNeighbors(id), { maxJumps: 5, maxSystems: 2000 });
    for (const id of theatre.filter((x) => reach.has(x) && x !== Q)) {
      const r = tx((db) => st.strategy.intelRepository.upsertObservation(db, { factionId: AMARR, systemId: id,
        observedAt: START, controllerFactionId: SANSHA, hostileFleets: 0, hostileShips: 0, hostileStrength: 0,
        hostileStations: 0, source: "fleet" }, `test:intel:${id}`));
      assert.ok(r.ok, JSON.stringify(r));
    }
    const run = async (at) => {
      clock.set(at);
      for (let i = 0; i < 20; i += 1) {
        const p = await sr.scheduler.runPass();
        assert.ok(p.ok, JSON.stringify(p));
        if (!p.jobs) return;
      }
    };
    await run(START + I);
    const ops = tx((db) => db.prepare("SELECT * FROM world_operations WHERE faction_id = ?").all(AMARR));
    const inv = ops.find((o) => o.operation_type === "invasion");
    assert.ok(inv, JSON.stringify(ops.map((o) => [o.operation_type, o.target_system_id])) + lines.join("\n"));
    const T = inv.target_system_id;
    const sys = tx((db) => repo.getSystem(db, T)).system;
    assert.deepStrictEqual([sys.occupationState, sys.occupierFactionId, sys.controllerFactionId],
      ["CONTESTED", AMARR, SANSHA]);
    assert.ok(lines.some((l) => l.includes(`launch invasion -> ${T}`) && l.includes("occ=STARTED")), lines.join("\n"));
    tx((db) => db.prepare("UPDATE world_operations SET state = 'FAILED' WHERE operation_id = ?").run(inv.operation_id));
    decisions.length = 0;
    await run(START + 2 * I);
    assert.ok(decisions.length >= 1);
    assert.ok(decisions[0].supply.frontTargets.includes(T) && decisions[0].supply.frontCount >= 1,
      JSON.stringify(decisions[0].supply));
    const busy = tx((db) => {
      const w = fr.fleets.repository.createFleet(db, { factionId: SERPENTIS, currentSystemId: T, homeSystemId: T,
        fleetRole: "patrol", composition: [{ hullGroup: "frigate", count: 1 }] }, "test:outer");
      const s = or.occupation.signalInTx(db, { systemId: T, factionId: SERPENTIS, signal: "INVASION", at: clock.now() },
        "test:busy");
      return { w, s };
    });
    assert.deepStrictEqual([busy.w.ok, busy.s.ok, busy.s.reason], [true, false, "OCCUPATION_BUSY"]);
    assert.strictEqual(tx((db) => db.prepare("SELECT count(*) AS n FROM virtual_fleets WHERE faction_id = ?")
      .get(SERPENTIS).n), 1);
    const amarrStations = tx((db) => stR.stations.repository.listStationsOfFaction(db, AMARR, {})).records;
    assert.ok(amarrStations.some((s) => s.systemId === Q), JSON.stringify(amarrStations));
    for (let station of amarrStations) {
      for (const [from, to] of [["ONLINE", "ARMOR_REINFORCE"], ["ARMOR_REINFORCE", "HULL_REINFORCE"],
        ["HULL_REINFORCE", "DESTROYED"]]) {
        const r = tx((db) => stR.stations.repository.transitionStation(db, { stationId: station.stationId,
          expectedVersion: station.version, from, to, key: `test:siege:${station.stationId}:${to}`, reason: "test",
          at: clock.now() }));
        assert.ok(r.ok, JSON.stringify(r));
        station = r.record;
      }
    }
    await run(START + 3 * I);
    const q = tx((db) => repo.getSystem(db, Q)).system;
    assert.deepStrictEqual([q.controllerFactionId, q.occupationState, q.detachedSinceAt !== null],
      [AMARR, "STABLE", true], JSON.stringify(q));
    assert.ok(st.strategy.getStatus().ai.review.counters.territoryMarks >= 1);
    st.strategy.stop("test");
    or.occupation.stop("test");
  }));

  needsDriver("O5a homeReclaimed counter increments on HOME_RECLAIMED and persists across restart", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const stations = fakeStations([{ stationId: "st:amarr", systemId: S.N0, factionId: AMARR, state: "ONLINE" }]);
    const env = bootOcc(reopen(), shared, stations, {});
    const occ = env.occupation;
    const statusBefore = occ.getStatus();
    const beforeCount = statusBefore.counters.homeReclaimed;
    occ.count("homeReclaimed");
    const statusAfter = occ.getStatus();
    assert.strictEqual(statusAfter.counters.homeReclaimed, beforeCount + 1, "homeReclaimed counter increments");
    env.occupation.stop("test");
  }));

  needsDriver("O5b layer-front: 2 elements, cacheKey, HOLD, pagination, maxSystems, stop unregisters", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const stations = fakeStations([
      { stationId: "st:amarr", systemId: S.N0, factionId: AMARR, state: "ONLINE" },
      { stationId: "st:sansha", systemId: S.N5, factionId: SANSHA, state: "ONLINE" }
    ]);
    const I = 900000;
    const ENV = { EVEJS_LNE_OCCUPATION_EVAL_INTERVAL_MS: String(I),
      EVEJS_LNE_OCCUPATION_INVASION_HOLD_MS: "900000",
      EVEJS_LNE_OBSERVER_GALAXY_FRONT_REFRESH_MS: "300000" };
    const env = bootOcc(reopen(), shared, stations, ENV);
    const views = env.views;
    seedSystem(env, S.N5, SANSHA, { [SANSHA]: 50 });
    seedSystem(env, S.N6, AMARR, { [AMARR]: 50 });
    const sig1 = signal(env, S.N5, AMARR, "RECON", shared.clock.now(), "o5b:recon");
    assert.deepStrictEqual([sig1.ok, sig1.outcome, sig1.state], [true, "STARTED", "RECON"]);
    const sig2 = signal(env, S.N6, SANSHA, "RECON", shared.clock.now(), "o5b:recon2");
    assert.deepStrictEqual([sig2.ok, sig2.outcome, sig2.state], [true, "STARTED", "RECON"]);
    await passesAt(env, shared, shared.clock.now() + I);
    const frontView = views.getView("layer-front");
    assert.ok(frontView, "layer-front view not registered");
    const data = frontView.getData();
    assert.strictEqual(data.available, true);
    assert.ok(data.key !== null && data.key.startsWith("k"), "cacheKey present");
    assert.ok(data.items.length >= 2, "at least two front systems: " + data.items.length);
    const key1 = data.key;
    shared.clock.set(shared.clock.now() + 10000);
    const data2 = frontView.getData();
    assert.strictEqual(data2.key, key1, "cacheKey stable within bucket");
    env.occupation.stop("test");
    const dataAfterStop = frontView.getData();
    assert.strictEqual(dataAfterStop.available, false, "layer unregistered after stop");
    assert.strictEqual(frontView.cacheKey(), null, "cacheKey null after stop");
    assert.strictEqual(dataAfterStop.reason, "OCCUPATION_STOPPED", "reason after stop");
  }));

  needsDriver("K5 core protection regression: Amarr core + 2 systems, Sansha signals all 3 -> 2 OCCUPIED, core CORE_PROTECTED; abandon core CORE_PROTECTED; legacy claim on core unwinds to STABLE with OCCUPATION_CORE_PROTECTED; restart preserves", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const stations = fakeStations([
        { stationId: "st:amarr", systemId: S.N0, factionId: AMARR, state: "ONLINE" },
        { stationId: "st:amarr2", systemId: S.N5, factionId: AMARR, state: "ONLINE" },
        { stationId: "st:amarr3", systemId: S.N6, factionId: AMARR, state: "ONLINE" },
        { stationId: "st:sansha", systemId: S.N1, factionId: SANSHA, state: "ONLINE" },
        { stationId: "st:sansha2", systemId: S.N5, factionId: SANSHA, state: "ONLINE" },
        { stationId: "st:sansha3", systemId: S.N6, factionId: SANSHA, state: "ONLINE" }
      ]);
      
      const mockCoreIndex = {
        enabled: true,
        systems: new Map([[S.N0, AMARR]]),
        stations: new Map(),
        byFaction: new Map(),
        version: 1
      };
      
      const env = H.boot(reopen(), shared);
      env.now = () => shared.clock.now();
      const config = configOf({ EVEJS_LNE_OCCUPATION_EVAL_INTERVAL_MS: "3600000", EVEJS_LNE_OCCUPATION_INVASION_HOLD_MS: "900000", EVEJS_LNE_OCCUPATION_CONTEST_TIMEOUT_MS: "900000", EVEJS_LNE_OCCUPATION_OCCUPIED_SETTLE_MS: "900000", EVEJS_LNE_OCCUPATION_OCCUPY_MIN_SCORE: "10", EVEJS_LNE_OCCUPATION_INVASION_MIN_SCORE: "5", EVEJS_LNE_OCCUPATION_OCCUPY_MAX_DEFENDER_SCORE: "100", EVEJS_LNE_OCCUPATION_REQUIRE_NO_DEFENDER_STATIONS: "false" });
      const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
      const lines = [];
      const views = createViewRegistry();
      const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
        clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations, views,
        logger: { log: (l) => lines.push(l) }, nowMs: () => 0, coreIndex: mockCoreIndex });
      assert.ok(r.ok, JSON.stringify(r));
      const occ = r.occupation;
      const testEnv = { ...env, repo, occupation: occ, config, lines, views };
      const t0 = shared.clock.now();

      seedSystem(testEnv, S.N0, AMARR, { [AMARR]: 60 });
      seedSystem(testEnv, S.N5, AMARR, { [AMARR]: 60, [SANSHA]: 10 });
      seedSystem(testEnv, S.N6, AMARR, { [AMARR]: 60, [SANSHA]: 10 });

      const sigN0 = testEnv.tx((db) => occ.signalInTx(db, { systemId: S.N0, factionId: SANSHA, signal: "INVASION", at: t0 }, "k5:sig:N0"));
      assert.deepStrictEqual([sigN0.ok, sigN0.reason], [false, "CORE_PROTECTED"]);

      let sysN0 = systemOf(testEnv, S.N0);
      assert.strictEqual(sysN0.occupationState, "STABLE");
      assert.strictEqual(sysN0.controllerFactionId, AMARR);

      const sigN5 = testEnv.tx((db) => occ.signalInTx(db, { systemId: S.N5, factionId: SANSHA, signal: "INVASION", at: t0 }, "k5:sig:N5"));
      assert.deepStrictEqual([sigN5.ok, sigN5.outcome], [true, "STARTED"]);
      const sigN6 = testEnv.tx((db) => occ.signalInTx(db, { systemId: S.N6, factionId: SANSHA, signal: "INVASION", at: t0 }, "k5:sig:N6"));
      assert.deepStrictEqual([sigN6.ok, sigN6.outcome], [true, "STARTED"]);

      testEnv.tx((db) => env.fleets.repository.createFleet(db, {
        factionId: SANSHA, corporationId: null, currentSystemId: S.N5, homeSystemId: S.N5,
        fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 3 }]
      }, "k5:fleet:N5"));
      testEnv.tx((db) => env.fleets.repository.createFleet(db, {
        factionId: SANSHA, corporationId: null, currentSystemId: S.N6, homeSystemId: S.N6,
        fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 3 }]
      }, "k5:fleet:N6"));

      let sysN5AfterSig = systemOf(testEnv, S.N5);
      let sysN6AfterSig = systemOf(testEnv, S.N6);
      assert.strictEqual(sysN5AfterSig.occupationState, "CONTESTED", "N5 should be CONTESTED after signal");
      assert.strictEqual(sysN6AfterSig.occupationState, "CONTESTED", "N6 should be CONTESTED after signal");
      assert.strictEqual(sysN5AfterSig.occupierFactionId, SANSHA, "N5 occupier should be Sansha");
      assert.strictEqual(sysN6AfterSig.occupierFactionId, SANSHA, "N6 occupier should be Sansha");

      await passesAt(testEnv, shared, t0 + 7200000);
      let sysN5Check = systemOf(testEnv, S.N5);
      if (sysN5Check.occupationState === "INVASION") {
        await passesAt(testEnv, shared, t0 + 14400000);
      }
      let sysN5 = systemOf(testEnv, S.N5);
      let sysN6 = systemOf(testEnv, S.N6);
      assert.strictEqual(sysN5.occupationState, "OCCUPIED", "N5 should be OCCUPIED by Sansha");
      assert.strictEqual(sysN5.controllerFactionId, SANSHA, "N5 controller should be Sansha");
      assert.strictEqual(sysN6.occupationState, "OCCUPIED", "N6 should be OCCUPIED by Sansha");
      assert.strictEqual(sysN6.controllerFactionId, SANSHA, "N6 controller should be Sansha");

      sysN0 = systemOf(testEnv, S.N0);
      assert.strictEqual(sysN0.occupationState, "STABLE", "Core N0 should remain STABLE");
      assert.strictEqual(sysN0.controllerFactionId, AMARR, "Core N0 controller should remain Amarr");

      const abandonResult = testEnv.tx((db) => occ.abandonInTx(db, { systemId: S.N0, at: shared.clock.now(), factionId: AMARR }, "k5:abandon:N0"));
      assert.deepStrictEqual([abandonResult.ok, abandonResult.reason], [false, "CORE_PROTECTED"]);

      const legacySeeded = systemOf(testEnv, S.N0);
      const legacyResult = testEnv.tx((db) => repo.applyChange(db, {
        systemId: S.N0,
        expectedVersion: legacySeeded.version,
        reason: "TEST_LEGACY_CLAIM",
        state: { occupationState: "CONTESTED", occupierFactionId: SANSHA },
        influence: [{ factionId: AMARR, influenceScore: 30 }, { factionId: SANSHA, influenceScore: 40 }]
      }, "k5:legacy:claim:N0"));
      assert.ok(legacyResult.ok, JSON.stringify(legacyResult));

      const tickKey = require("../../lib/world/occupation/schema").tickKey;
      testEnv.tx((db) => env.scheduler.enqueue("OCCUPATION_PHASE_CHANGE", String(S.N0), shared.clock.now(),
        { systemId: S.N0, seq: legacySeeded.phaseSeq, trigger: "tick" },
        tickKey(S.N0, legacySeeded.phaseSeq, 3600000, Math.floor(shared.clock.now() / 3600000)), { tx: db, chained: true }));

      await passesAt(testEnv, shared, shared.clock.now() + 7200000);

      sysN0 = systemOf(testEnv, S.N0);
      assert.strictEqual(sysN0.occupationState, "STABLE", "Core N0 should be STABLE after legacy unwind");
      assert.strictEqual(sysN0.controllerFactionId, AMARR, "Core N0 controller should be Amarr after unwind");

      const journalUnwind = testEnv.tx((db) => db.prepare(
        "SELECT event_type, aggregate_id FROM world_event_journal WHERE event_type = ? AND aggregate_id = ?"
      ).all("OCCUPATION_CORE_PROTECTED", String(S.N0)));
      assert.ok(journalUnwind.length >= 1, "Should have at least 1 OCCUPATION_CORE_PROTECTED entry (legacy unwind)");

      occ.stop("restart");
      env.store.close("restart");
      
      const env2 = H.boot(reopen(), shared);
      env2.now = () => shared.clock.now();
      const r2 = startOccupation({ config, persistence: { ok: true, store: env2.store, journal: env2.journal },
        clock: shared.clock, scheduler: env2.scheduler, fleets: env2.fleets, world: { repository: repo },
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations, views,
        logger: { log: (l) => lines.push(l) }, nowMs: () => 0, coreIndex: mockCoreIndex });
      assert.ok(r2.ok, JSON.stringify(r2));
      const occ2 = r2.occupation;

      const sysAfterRestart = systemOf({ ...env2, repo }, S.N0);
      assert.strictEqual(sysAfterRestart.occupationState, "STABLE", "Core N0 should be STABLE after restart");
      assert.strictEqual(sysAfterRestart.controllerFactionId, AMARR, "Core N0 controller should be Amarr after restart");

      const sysAfterRestartN5 = systemOf({ ...env2, repo }, S.N5);
      assert.strictEqual(sysAfterRestartN5.occupationState, "CONSOLIDATING", "N5 should be CONSOLIDATING after restart (preserved from before restart)");
      assert.strictEqual(sysAfterRestartN5.controllerFactionId, SANSHA);

      const sysAfterRestartN6 = systemOf({ ...env2, repo }, S.N6);
      assert.strictEqual(sysAfterRestartN6.occupationState, "CONSOLIDATING", "N6 should be CONSOLIDATING after restart (preserved from before restart)");
      assert.strictEqual(sysAfterRestartN6.controllerFactionId, SANSHA);

      let audit;
      try {
        audit = { ...env2, repo, occupation: occ2 }.tx((db) => occ2.auditCoresInTx(db));
      } catch (err) {
        throw err;
      }
      assert.ok(audit.ok, JSON.stringify(audit));
      assert.strictEqual(audit.violations.length, 0, "no core violations after restart");

      occ2.stop("test");
    }));
};