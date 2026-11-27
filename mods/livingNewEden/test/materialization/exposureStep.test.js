"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { startFleetExposure } = require("../../lib/fleetExposure");
const { createExposureRepository } = require("../../lib/fleetExposure/exposureRepository");
const X = require("../../lib/fleetExposure/schema");
const R = require("../../lib/fleetExposure/rules");
const { createExposureStep, createYieldingBudget, COUNTER_NAMES } = require("../../lib/materialization/exposureStep");
const { createPhysicalBudget } = require("../../lib/materialization/physicalBudget");
const { createLossTracker } = require("../../lib/materialization/lossTracker");
const { buildLeg } = require("../../lib/fleets/travel");
const { decideConvoyStep, ACTION: CONVOY_ACTION } = require("../../lib/economy/logistics/convoyMachine");
const { decideStep, ACTION: TRIP_ACTION } = require("../../lib/economy/mining/tripMachine");
const { resolveConfig, SCHEMA } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A } = H;
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const CONVOY = Object.freeze([{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }]);
const MINERS = Object.freeze([{ hullGroup: "mining_barge", count: 2 }]);
const CHAR = 90000001;
const PLAYER_SHIP = 1090000001;
const pos = (x) => ({ x, y: 0, z: 0 });
const GATE_IN = 50000065;
const GATE_OUT = 50000067;
const BELTS = Object.freeze([{ kind: "asteroidBelt", itemId: 40000003, position: pos(3e9) },
  { kind: "asteroidBelt", itemId: 40000001, position: pos(1e9) },
  { kind: "asteroidBelt", itemId: 40000002, position: pos(2e9) }]);

function defaults() {
  return JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR, env: {} }).config.fleetExposure));
}

function fakeWorld() {
  const w = { loaded: new Set([S.N0, S.N6]), npc: new Map(), players: [], aggressors: new Map(), stamps: new Map(),
    calls: [], nextId: 7001, tracker: null };
  w.objects = new Map([
    [S.N6, [{ kind: "stargate", itemId: GATE_IN, position: pos(-1e10), toSystemId: S.N5 },
      { kind: "stargate", itemId: GATE_OUT, position: pos(1e10), toSystemId: S.N7 }]],
    [S.N0, [...BELTS, { kind: "station", itemId: 60000001, position: pos(4e9) },
      { kind: "stargate", itemId: 50000005, position: pos(9e10), toSystemId: S.N5 }]],
  ]);
  const objectsOf = (sys) => w.objects.get(sys) || [];
  w.scene = {
    listSystemObjects(sys, kinds) {
      w.calls.push(["listSystemObjects", sys, [...kinds]]);
      return { ok: true, objects: objectsOf(sys).filter((o) => kinds.includes(o.kind))
        .map((o) => ({ ...o, position: { ...o.position } })) };
    },
    readPlayerShips(sys) {
      w.calls.push(["readPlayerShips", sys]);
      if (!w.loaded.has(sys)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, ships: w.players.filter((p) => p.systemId === sys).map((p) => ({ characterId: p.characterId,
        entityId: p.entityId, position: p.position ? { ...p.position } : pos(0), signatureRadius: 100, inWarp: false,
        cloaked: false,
        capsule: false })) };
    },
    readShips(sys, ids) {
      w.calls.push(["readShips", sys]);
      return { ok: true, ships: ids.filter((id) => w.npc.has(id))
        .map((id) => ({ entityId: id, position: { ...w.npc.get(id).position }, inWarp: false })) };
    },
    warpShips(sys, ids, point, opts) {
      w.calls.push(["warpShips", [...ids], { ...point }, opts && opts.spreadMeters]);
      for (const id of ids) if (w.npc.has(id)) w.npc.get(id).position = { ...point };
      return { ok: true, warped: ids.length, failed: [] };
    },
    readAggressors(sys, ids) {
      w.calls.push(["readAggressors", sys]);
      return { ok: true, aggressors: ids.filter((id) => w.aggressors.has(id)).map((id) => ({ entityId: id,
        ...w.aggressors.get(id), aggressorFactionId: null, aggressorPosition: pos(0), aggressorInWarp: false })) };
    },
  };
  w.group = {
    readGroup(sys, ids) {
      w.calls.push(["readGroup", sys]);
      return { ok: true, ships: ids.filter((id) => w.npc.has(id)).map((id) => ({ entityId: id, position: pos(0),
        manualTargetId: 0, ...(w.stamps.get(id) || { aggressorEntityId: 0, aggressedAtMs: 0 }) })) };
    },
  };
  w.npcSpawn = {
    resolveProfiles(reqs, o) {
      w.calls.push(["resolveProfiles", { ...o }]);
      if (w.profileOk && !reqs.every((r) => w.profileOk(r, o))) return { ok: false, reason: "NO_PROFILE" };
      return { ok: true, profiles: reqs.map((r) => `p_${r.hullGroup}`) };
    },
    isSceneLoaded: (sys) => w.loaded.has(sys),
    spawnShip(sys, spec) {
      w.calls.push(["spawnShip", sys, { ...spec.anchorDescriptor }, spec.behavior, spec.profileId,
        spec.spawnDistanceMeters]);
      const o = objectsOf(sys).find((x) => x.itemId === spec.anchorDescriptor.itemID);
      const id = w.nextId;
      w.nextId += 1;
      w.npc.set(id, { systemId: sys, position: { ...o.position } });
      return { ok: true, entityId: id };
    },
    publish(sys, ids) {
      w.calls.push(["publish", [...ids]]);
      return { ok: true, published: ids.length, missing: 0 };
    },
    despawn(sys, ids) {
      w.calls.push(["despawn", [...ids]]);
      let removed = 0;
      for (const id of ids) if (w.npc.delete(id)) removed += 1;
      return { ok: true, removed, missing: ids.length - removed };
    },
  };
  w.kill = (id) => {
    w.npc.delete(id);
    w.tracker.note({ itemID: id }, { success: true });
  };
  w.player = (systemId) => {
    w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId }];
  };
  w.count = (name) => w.calls.filter((c) => c[0] === name).length;
  w.ids = () => [...w.npc.keys()];
  return w;
}

function bootBase(reopen) {
  const shared = H.sharedOf();
  const opened = reopen();
  const env = H.boot(opened, shared);
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const fx = startFleetExposure({ config: { ...H.CONFIG, fleetExposure: { enabled: true } },
    persistence: { ok: true, store: env.store, journal: env.journal }, clock: shared.clock,
    getFleets: () => env.fleets, telemetry: null, logger });
  assert.ok(fx.ok, JSON.stringify(fx));
  return { shared, opened, env, lines, logger, real: fx.fleetExposure };
}

function setup(reopenOrBase, opts = {}) {
  const base = typeof reopenOrBase === "function" ? bootBase(reopenOrBase) : reopenOrBase;
  const { shared, opened, env, lines, logger, real } = base;
  const clock = shared.clock;
  const settings = { ...defaults(), enabled: true, ...(opts.settings || {}) };
  const spy = { claims: [], ends: [], refuseClaim: null };
  const facade = { ...real,
    claimInTx: (db, spec) => {
      spy.claims.push(spec);
      return spy.refuseClaim ? { ok: false, reason: spy.refuseClaim } : real.claimInTx(db, spec);
    },
    endInTx: (db, req) => {
      spy.ends.push(req);
      return real.endInTx(db, req);
    } };
  const w = fakeWorld();
  const convoys = [];
  const logistics = { listInTransitInTx: () => ({ ok: true, truncated: false, convoys: convoys.map((c) => ({ ...c })) }) };
  const tracker = createLossTracker({ maxPending: 40 });
  w.tracker = tracker;
  const budget = createPhysicalBudget({ limits: opts.limits || { perSystem: 48, global: 120 }, clock });
  const gov = { admits: true };
  const step = createExposureStep({ store: env.store, clock, npcSpawn: w.npcSpawn, budget, settings,
    exitGraceMs: 30000, industryProfiles: true, lossTracker: tracker, lossImportOn: opts.lossImportOn !== false,
    despawnAll: (sys, ids) => (ids.length > 0 ? w.npcSpawn.despawn(sys, ids) : null), admits: () => gov.admits,
    getFleetExposure: () => facade, getLogistics: () => logistics, getFleets: () => env.fleets,
    getHuntScene: () => w.scene, getBeltNavyScene: () => w.group, worldSeed: opened.worldSeed, logger,
    getStandings: opts.getStandings,
    getFrontJobs: opts.getFrontJobs, escortEnabled: opts.escortEnabled === true,
    secClassOf: opts.secClassOf, pirateFactionOf: opts.pirateFactionOf,
    cargoCarrierGroups: opts.cargoCarrierGroups,
    spawnBackoff: opts.spawnBackoff });
  const presence = {
    observedSystems: () => [...new Set(w.players.map((p) => p.systemId))].sort((a, b) => a - b),
    getSystemPresence: (id) => {
      const chars = w.players.filter((p) => p.systemId === id).map((p) => ({ characterId: p.characterId,
        name: "Pilot", state: "space" }));
      return { systemId: id, space: chars.length, characters: chars };
    },
  };
  const pass = (dt = 0) => {
    clock.advance(dt);
    const out = { refused: {} };
    step.stepPending(clock.now(), out);
    step.step(clock.now(), presence, out);
    return out;
  };
  const fleetOf = (id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
  const rows = () => ({ journal: H.n(env, "SELECT count(*) AS n FROM world_event_journal"),
    exposures: H.n(env, "SELECT count(*) AS n FROM world_fleet_exposures") });
  const exposureRows = (fleetId) => env.tx((db) => db.prepare("SELECT exposure_id, state, end_reason, members_json, "
    + "character_id, fleet_id FROM world_fleet_exposures ORDER BY started_at, exposure_id").all())
    .filter((r) => fleetId === undefined || r.fleet_id === fleetId);
  const usedShips = () => budget.getStatus().reservedShips;
  const counters = () => step.getStatus().counters;
  return { base, env, shared, clock, opened, lines, settings, spy, facade, w, convoys, budget, gov, step, pass,
    fleetOf, rows, exposureRows, counters, usedShips };
}

function convoyFleet(t, tag) {
  const env = t.env;
  const r = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.N0, homeSystemId: S.N0,
    fleetRole: "logistics", composition: CONVOY }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  const op = env.fleets.createOperation({ operationType: "logistics", factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.N9, objective: "deliver", dueAt: null, fleets: [{ fleetId: r.fleetId, expectedVersion: 1 }] },
  `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const p = env.fleets.planTravel({ fleetId: r.fleetId, targetSystemId: S.N9, constraints: AVOID }, `${tag}:plan`);
  assert.ok(p.ok, JSON.stringify(p));
  const f = t.fleetOf(r.fleetId);
  assert.deepStrictEqual(f.route.systems, [S.N0, S.N5, S.N6, S.N7, S.N9]);
  t.convoys.push({ convoyId: `cv:${tag}`, factionId: FACTION_A, fleetId: r.fleetId, destSystemId: S.N9,
    purpose: "trade" });
  return { fleetId: r.fleetId, operationId: op.operationId, leg: f.route, legSeq: f.legSeq };
}

function stagedMiner(t, tag, composition = MINERS) {
  const env = t.env;
  const r = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.N0, homeSystemId: S.N0,
    fleetRole: "mining", composition }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  const op = env.fleets.createOperation({ operationType: "mining", factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.N0, objective: "mine", dueAt: null, fleets: [{ fleetId: r.fleetId, expectedVersion: 1 }] },
  `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const f = t.fleetOf(r.fleetId);
  const st = env.tx((db) => env.fleets.repository.transition(db, { fleetId: r.fleetId, expectedVersion: f.version,
    from: f.state, to: "STAGED", patch: {} }, `${tag}:stage`));
  assert.ok(st.ok, JSON.stringify(st));
  return { fleetId: r.fleetId, operationId: op.operationId };
}

function intoWindow(t, c) {
  t.clock.set(c.leg.departAt + 2 * c.leg.jumpMs + 1000);
  const despawnAt = c.leg.departAt + 3 * c.leg.jumpMs - t.settings.transitEndMarginMs;
  assert.ok(despawnAt - t.clock.now() >= t.settings.transitMinRemainingMs, `jumpMs ${c.leg.jumpMs} too short`);
  return despawnAt;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("XS1 convoy crossing the player system: carriers at the entry gate, warp to the exit gate, despawn at "
    + "despawnAt, no write; pickCrossing null for i = 0, a wormhole leg, a short rest", () => H.withStore(driver,
    async (reopen) => {
      const t = setup(reopen);
      const c = convoyFleet(t, "xs1");
      t.w.player(S.N6);
      const despawnAt = intoWindow(t, c);
      const before = t.rows();
      t.pass();
      const spawns = t.w.calls.filter((x) => x[0] === "spawnShip");
      assert.deepStrictEqual(spawns.map((x) => [x[1], x[2].itemID, x[2].kind, x[3], x[4]]), [
        [S.N6, GATE_IN, "stargate", "search", "p_industrial"], [S.N6, GATE_IN, "stargate", "search", "p_industrial"]]);
      const prof = t.w.calls.find((x) => x[0] === "resolveProfiles")[1];
      assert.deepStrictEqual(prof, { seedPrefix: c.fleetId, industry: true });
      const warp = t.w.calls.find((x) => x[0] === "warpShips");
      assert.deepStrictEqual([warp[1].length, warp[2]], [2, pos(1e10)]);
      assert.strictEqual(t.w.count("publish"), 1);
      assert.deepStrictEqual([t.step.getStatus().visible, t.counters().startedConvoy], [1, 1]);
      assert.strictEqual(t.usedShips(), 2);
      t.pass(5000);
      assert.strictEqual(t.w.count("despawn"), 0);
      t.clock.set(despawnAt);
      t.pass();
      assert.strictEqual(t.w.count("despawn"), 1);
      assert.deepStrictEqual([t.step.getStatus().visible, t.counters().transitDone], [0, 1]);
      assert.strictEqual(t.usedShips(), 0);
      assert.deepStrictEqual([t.spy.claims.length, t.spy.ends.length], [0, 0]);
      assert.deepStrictEqual(t.rows(), before, "a VISIBLE exposure writes nothing");
      assert.strictEqual(t.fleetOf(c.fleetId).state, "TRAVELLING");

      const f = t.fleetOf(c.fleetId);
      const observed = new Set([S.N0, S.N5, S.N6]);
      const P = { transitMinRemainingMs: 20000, transitEndMarginMs: 5000 };
      const leg = f.route;
      assert.strictEqual(R.pickCrossing(f, observed, leg.departAt + 10, P), null, "i = 0");
      const wh = buildLeg({ systems: leg.systems, departAt: leg.departAt, jumpMs: leg.jumpMs, graphVersion: 1,
        mode: leg.mode, observed: leg.observed, constraints: {},
        wormholeEdges: [{ i: 1, pairKey: "wh:1", expiresAt: leg.arriveAt + 1 }] });
      assert.ok(wh.ok, JSON.stringify(wh));
      assert.strictEqual(R.pickCrossing({ ...f, route: wh.leg }, observed, leg.departAt + 2 * leg.jumpMs + 1, P),
        null, "wormhole leg");
      const late = leg.departAt + 3 * leg.jumpMs - 5000 - 19999;
      const short = R.pickCrossing(f, observed, late, P);
      assert.deepStrictEqual([short.systemId, short.despawnAt], [S.N6, late + 20000], "short rest");
      const ok = R.pickCrossing(f, observed, late - 1, P);
      assert.deepStrictEqual([ok.systemId, ok.systemIndex, ok.fromSystemId, ok.toSystemId, ok.legSeq, ok.despawnAt],
        [S.N6, 2, S.N5, S.N7, f.legSeq, leg.departAt + 3 * leg.jumpMs - 5000]);
    }));

  needsDriver("XS2 player aggression -> one claimInTx (crossing, at in the window, the character), no second claim; "
    + "NOT_CROSSING -> despawn + claimFailed; an NPC aggressor -> no claim", () => H.withStore(driver,
    async (reopen) => {
      const t = setup(reopen);
      const c = convoyFleet(t, "xs2");
      t.w.player(S.N6);
      intoWindow(t, c);
      t.pass();
      const [a, b] = t.w.ids();
      t.w.aggressors.set(a, { aggressorId: 8000001, aggressorKind: "npc" });
      t.pass(1000);
      assert.strictEqual(t.spy.claims.length, 0);
      t.w.aggressors.set(a, { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      t.pass(1000);
      assert.strictEqual(t.spy.claims.length, 1);
      const spec = t.spy.claims[0];
      const winStart = c.leg.departAt + 2 * c.leg.jumpMs;
      assert.deepStrictEqual([spec.kind, spec.crossing, spec.characterId, spec.systemId, spec.destroyed,
        spec.members.map((m) => m.hullGroup)], ["CONVOY", { legSeq: c.legSeq, systemIndex: 2 }, CHAR, S.N6, [],
        ["industrial", "industrial"]]);
      assert.ok(spec.at >= winStart && spec.at < winStart + c.leg.jumpMs, String(spec.at));
      assert.deepStrictEqual([t.fleetOf(c.fleetId).state, t.exposureRows().map((r) => [r.state, r.character_id])],
        ["MATERIALIZED", [["HELD", CHAR]]]);
      assert.deepStrictEqual([t.step.getStatus().held, t.counters().claimed], [1, 1]);
      t.w.stamps.set(a, { aggressorEntityId: PLAYER_SHIP, aggressedAtMs: 5 });
      t.pass(1000);
      assert.strictEqual(t.spy.claims.length, 1, "no second claim");
      assert.ok(t.w.npc.has(b));

      const t2 = setup(t.base);
      const c2 = convoyFleet(t2, "xs2b");
      t2.w.player(S.N6);
      intoWindow(t2, c2);
      t2.pass();
      t2.spy.refuseClaim = "NOT_CROSSING";
      t2.w.aggressors.set(t2.w.ids()[0], { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      t2.pass(1000);
      assert.deepStrictEqual([t2.spy.claims.length, t2.counters().claimFailed, t2.step.getStatus().visible,
        t2.w.ids().length, t2.exposureRows(c2.fleetId).length], [1, 1, 0, 0, 0]);
      assert.strictEqual(t2.fleetOf(c2.fleetId).state, "TRAVELLING");
    }));

  needsDriver("XS3 killmail in VISIBLE -> claim with destroyed; killmail in HELD -> markDestroyedInTx; the last member "
    + "-> endInTx(WIPED) once; a refused claim with a pending loss -> lossDropped", () => H.withStore(driver,
    async (reopen) => {
      const t = setup(reopen);
      const c = convoyFleet(t, "xs3");
      t.w.player(S.N6);
      intoWindow(t, c);
      t.pass();
      const [a, b] = t.w.ids();
      t.w.kill(a);
      t.pass(1000);
      assert.strictEqual(t.spy.claims.length, 1);
      const killed = t.spy.claims[0].destroyed;
      assert.strictEqual(killed.length, 1);
      assert.strictEqual(t.spy.claims[0].characterId, null, "no player aggressor read");
      const members = () => JSON.parse(t.exposureRows()[0].members_json).map((m) => m.state).sort();
      assert.deepStrictEqual(members(), ["DESTROYED", "SPAWNED"]);
      t.w.kill(b);
      t.pass(1000);
      assert.deepStrictEqual(members(), ["DESTROYED", "DESTROYED"]);
      assert.deepStrictEqual(t.spy.ends.map((e) => e.reason), ["WIPED"]);
      assert.deepStrictEqual([t.exposureRows()[0].state, t.exposureRows()[0].end_reason], ["ENDED", "WIPED"]);
      const f = t.fleetOf(c.fleetId);
      assert.deepStrictEqual([f.state, f.operationId, f.composition.find((g) => g.hullGroup === "industrial")],
        ["STAGED", c.operationId, undefined]);
      assert.deepStrictEqual([t.counters().wiped, t.counters().ended, t.counters().lossImported], [1, 1, 2]);
      t.pass(1000);
      assert.strictEqual(t.spy.ends.length, 1, "one settlement");

      const t2 = setup(t.base);
      const c2 = convoyFleet(t2, "xs3b");
      t2.w.player(S.N6);
      intoWindow(t2, c2);
      t2.pass();
      t2.spy.refuseClaim = "VERSION_CONFLICT";
      t2.w.kill(t2.w.ids()[0]);
      t2.pass(1000);
      assert.deepStrictEqual([t2.counters().claimFailed, t2.counters().lossDropped,
        t2.exposureRows(c2.fleetId).length], [1, 1, 0]);
    }));

  needsDriver("XS4 HELD quiet -> EXITING + warp to the exit gate; landed -> despawn + endInTx(QUIET); a miner whose "
    + "player leaves -> TARGET_GONE; shown again at the next scan (no cooldown after an end)", () => H.withStore(driver,
    async (reopen) => {
      const t = setup(reopen);
      const c = convoyFleet(t, "xs4");
      t.w.player(S.N6);
      intoWindow(t, c);
      t.pass();
      const [a] = t.w.ids();
      t.w.aggressors.set(a, { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      t.pass(1000);
      assert.strictEqual(t.step.getStatus().held, 1);
      t.w.stamps.set(a, { aggressorEntityId: PLAYER_SHIP, aggressedAtMs: 7 });
      t.pass(1000);
      t.pass(t.settings.holdQuietMs - 2000);
      assert.strictEqual(t.step.getStatus().held, 1, "still held before holdQuietMs");
      const warps = t.w.count("warpShips");
      t.pass(1000);
      assert.deepStrictEqual([t.step.getStatus().exiting, t.w.count("warpShips"), t.counters().exited],
        [1, warps + 1, 1]);
      assert.deepStrictEqual(t.w.calls.filter((x) => x[0] === "warpShips").pop()[2], pos(1e10));
      t.pass(1000);
      assert.deepStrictEqual(t.spy.ends.map((e) => e.reason), ["QUIET"]);
      assert.deepStrictEqual([t.w.ids().length, t.fleetOf(c.fleetId).state], [0, "STAGED"]);
      assert.strictEqual(t.usedShips(), 0);

      const m = stagedMiner(t, "xs4m");
      t.w.player(S.N0);
      t.pass(t.settings.scanIntervalMs);
      assert.strictEqual(t.counters().startedMiner, 1);
      t.w.aggressors.set(t.w.ids()[0], { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      t.pass(1000);
      assert.strictEqual(t.fleetOf(m.fleetId).state, "MATERIALIZED");
      t.w.players = [];
      t.pass(15000);
      assert.strictEqual(t.spy.ends.length, 1);
      t.pass(16000);
      assert.deepStrictEqual(t.spy.ends.map((e) => e.reason), ["QUIET", "TARGET_GONE"]);
      assert.deepStrictEqual([t.fleetOf(m.fleetId).state, t.fleetOf(m.fleetId).operationId], ["STAGED",
        m.operationId]);
      t.w.player(S.N0);
      const spawns = t.w.count("spawnShip");
      t.pass(t.settings.scanIntervalMs);
      assert.deepStrictEqual([t.w.count("spawnShip"), t.counters().refusedCooldown], [spawns + 2, 0]);
    }));

  needsDriver("XS5 miner STAGED with a mining operation -> ships at the belt of pickMinerAnchor; flag off / import off / "
    + "governor -> no spawn (refusedGovernor); config keys in SCHEMA, warning for playerHunt.roles with mining", () =>
    H.withStore(driver, async (reopen) => {
      const pick = R.pickMinerAnchor(BELTS, 12345, "fleet-a");
      assert.strictEqual(R.pickMinerAnchor([...BELTS].reverse(), 12345, "fleet-a"), pick);
      assert.strictEqual(pick.itemId, 40000003);
      assert.strictEqual(R.pickMinerAnchor([], 12345, "fleet-a"), null);

      const t = setup(reopen);
      const m = stagedMiner(t, "xs5");
      t.w.player(S.N0);
      t.pass();
      const belt = R.pickMinerAnchor(BELTS, t.opened.worldSeed, m.fleetId);
      const spawns = t.w.calls.filter((x) => x[0] === "spawnShip");
      assert.deepStrictEqual(spawns.map((x) => [x[2].itemID, x[2].kind, x[4]]), [[belt.itemId, "asteroidBelt",
        "p_mining_barge"], [belt.itemId, "asteroidBelt", "p_mining_barge"]]);
      assert.strictEqual(t.w.count("warpShips"), 0, "a miner stays at its belt");
      assert.deepStrictEqual(t.step.getStatus().entries.map((e) => [e.kind, e.phase, e.ships]),
        [["MINER", "VISIBLE", 2]]);

      for (const variant of [{ settings: { enabled: false } }, { lossImportOn: false }]) {
        const v = setup(t.base, variant);
        v.w.player(S.N0);
        v.pass();
        assert.deepStrictEqual([v.w.count("spawnShip"), v.w.count("readPlayerShips")], [0, 0], JSON.stringify(variant));
      }
      const g = setup(t.base);
      g.w.player(S.N0);
      g.gov.admits = false;
      g.pass();
      assert.deepStrictEqual([g.w.count("spawnShip"), g.counters().refusedGovernor], [0, 1]);

      const keys = new Set(SCHEMA.map((r) => r.key));
      for (const k of ["convoysEnabled", "minersEnabled", "scanIntervalMs", "maxVisible", "maxNewPerPass",
        "maxShipsPerExposure", "maxSystemsPerScan", "scanMaxConvoys", "convoyHullGroups", "minerHullGroups",
        "transitMinRemainingMs", "transitEndMarginMs", "spawnDistanceMeters", "holdQuietMs", "maxHeldMs",
        "exitWarpMaxMs", "respawnCooldownMs"]) assert.ok(keys.has(`fleetExposure.${k}`), k);
      const warned = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_PLAYER_HUNT_ROLES: "patrol,mining" } }).warnings;
      assert.ok(warned.some((x) => x.startsWith("playerHunt.roles contains mining")), JSON.stringify(warned));
      const quiet = resolveConfig({ modDir: MOD_DIR, env: {} }).warnings;
      assert.ok(!quiet.some((x) => x.startsWith("playerHunt.roles") || x.startsWith("fleetExposure.")));
      assert.deepStrictEqual(COUNTER_NAMES.length, new Set(COUNTER_NAMES).size);
    }));

  needsDriver("XS7 a fleet above maxShipsPerExposure -> partial exposure in hull-list order "
    + "(exposureTrimmed), the claim lists only the shown members; a budget with room for fewer ships -> trimmed to the room",
  () => H.withStore(driver, async (reopen) => {
    const fleet = { fleetId: "fx", composition: [{ hullGroup: "mining_barge", count: 4 }, { hullGroup: "exhumer", count: 2 },
      { hullGroup: "frigate", count: 3 }] };
    const r = R.exposableMembers(fleet, ["exhumer", "mining_barge"], 3);
    assert.deepStrictEqual([r.ok, r.total, r.trimmed, r.members.map((m) => m.hullGroup)],
      [true, 6, true, ["exhumer", "exhumer", "mining_barge"]]);
    assert.deepStrictEqual(R.exposableMembers(fleet, ["exhumer", "mining_barge"], 3), r, "deterministic");
    assert.strictEqual(R.exposableMembers(fleet, ["exhumer", "mining_barge"], 10).trimmed, false);
    assert.deepStrictEqual(R.exposableMembers(fleet, ["industrial"], 3), { ok: false, reason: "NONE" });

    const t = setup(reopen, { settings: { maxShipsPerExposure: 3, minerHullGroups: "exhumer,mining_barge" } });
    const m = stagedMiner(t, "xs7", [{ hullGroup: "mining_barge", count: 4 }, { hullGroup: "exhumer", count: 2 }]);
    t.w.player(S.N0);
    t.pass();
    assert.deepStrictEqual(t.w.calls.filter((x) => x[0] === "spawnShip").map((x) => x[4]),
      ["p_exhumer", "p_exhumer", "p_mining_barge"]);
    assert.deepStrictEqual([t.counters().startedMiner, t.counters().exposureTrimmed, t.usedShips()], [1, 1, 3]);
    t.w.aggressors.set(t.w.ids()[0], { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
    t.pass(1000);
    assert.deepStrictEqual(t.spy.claims[0].members.map((x) => x.hullGroup), ["exhumer", "exhumer", "mining_barge"]);
    assert.strictEqual(t.fleetOf(m.fleetId).state, "MATERIALIZED");

    assert.ok(t.budget.reserve({ reservationId: "other", ownerKind: "battle", ownerId: "b1", systemId: S.N0,
      shipCount: 48 - 3 - 1 }).ok);
    stagedMiner(t, "xs7b");
    const before = t.w.count("spawnShip");
    t.pass(t.settings.scanIntervalMs);
    assert.deepStrictEqual([t.w.count("spawnShip") - before, t.counters().startedMiner, t.counters().exposureTrimmed,
      t.counters().refusedBudget, t.usedShips()], [1, 2, 2, 0, 48]);
  }));

  needsDriver("XS8 no profile -> industry / ORE fallback (profileFallback); no belt -> planet, no planet "
    + "-> sun; convoy without the entry gate -> exit gate (anchorFallback); maxVisible full -> refusedMaxVisible",
  () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen, { settings: { maxVisible: 2 } });
    t.w.profileOk = (req) => req.factionId === 500014;
    t.w.objects.set(S.N0, [{ kind: "planet", itemId: 40000101, position: pos(5e9) },
      { kind: "planet", itemId: 40000102, position: pos(6e9) }, { kind: "sun", itemId: 40000100, position: pos(0) }]);
    const m = stagedMiner(t, "xs8");
    t.w.player(S.N0);
    t.pass();
    const planet = R.pickMinerAnchor(t.w.objects.get(S.N0).filter((o) => o.kind === "planet"), t.opened.worldSeed,
      m.fleetId);
    assert.deepStrictEqual(t.w.calls.filter((x) => x[0] === "spawnShip").map((x) => [x[2].kind, x[2].itemID, x[4]]),
      [["planet", planet.itemId, "p_mining_barge"], ["planet", planet.itemId, "p_mining_barge"]]);
    assert.deepStrictEqual([t.counters().startedMiner, t.counters().profileFallback, t.counters().anchorFallback,
      t.counters().refusedProfile], [1, 2, 1, 0]);

    t.w.profileOk = null;
    t.w.objects.set(S.N6, [{ kind: "stargate", itemId: GATE_OUT, position: pos(1e10), toSystemId: S.N7 }]);
    const c = convoyFleet(t, "xs8c");
    t.w.loaded.add(S.N6);
    t.w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N0 },
      { characterId: CHAR + 1, entityId: PLAYER_SHIP + 1, systemId: S.N6 }];
    intoWindow(t, c);
    t.pass();
    const conv = t.w.calls.filter((x) => x[0] === "spawnShip" && x[1] === S.N6);
    assert.deepStrictEqual(conv.map((x) => x[2].itemID), [GATE_OUT, GATE_OUT]);
    assert.deepStrictEqual([t.counters().startedConvoy, t.counters().anchorFallback], [1, 2]);

    t.w.objects.set(S.N0, [{ kind: "sun", itemId: 40000100, position: pos(0) }]);
    stagedMiner(t, "xs8d");
    const before = t.w.count("spawnShip");
    t.pass(t.settings.scanIntervalMs);
    assert.deepStrictEqual([t.w.count("spawnShip"), t.counters().refusedMaxVisible], [before, 1]);
    const cv = t.step.getStatus().entries.find((e) => e.kind === "CONVOY");
    assert.ok(cv, "the convoy entry");
    t.clock.set(c.leg.departAt + 3 * c.leg.jumpMs);
    t.pass();
    t.pass(t.settings.scanIntervalMs);
    assert.deepStrictEqual(t.w.calls.filter((x) => x[0] === "spawnShip").slice(before).map((x) => x[2].kind),
      ["sun", "sun"]);
  }));

  needsDriver("XS9: a planet / station anchor -> spawn distance radius + surfaceMarginMeters "
    + "(outside the body); a belt -> spawnDistanceMeters", () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    stagedMiner(t, "xs9");
    t.w.player(S.N0);
    t.pass();
    const dist = (w) => w.calls.filter((x) => x[0] === "spawnShip").map((x) => [x[2].kind, x[5]]);
    assert.deepStrictEqual(dist(t.w), [["asteroidBelt", 5000], ["asteroidBelt", 5000]]);
    const radius = 6371000;
    for (const [kind, objects] of [["planet", [{ kind: "planet", itemId: 40000101, position: pos(5e9), radius }]],
      ["station", [{ kind: "station", itemId: 60000001, position: pos(4e9), radius }]]]) {
      const v = setup(t.base);
      v.w.objects.set(S.N0, objects);
      v.w.player(S.N0);
      v.pass();
      assert.deepStrictEqual(dist(v.w), [[kind, radius + v.settings.surfaceMarginMeters],
        [kind, radius + v.settings.surfaceMarginMeters]], kind);
      assert.ok(dist(v.w)[0][1] > radius);
    }
    const s = setup(t.base);
    s.w.objects.set(S.N0, [{ kind: "station", itemId: 60000001, position: pos(4e9) }]);
    s.w.player(S.N0);
    s.pass();
    assert.deepStrictEqual(dist(s.w)[0], ["station", 50000 + 10000]);
    assert.deepStrictEqual([defaults().surfaceMarginMeters, defaults().stationDefaultRadiusMeters], [10000, 50000]);
  }));

  needsDriver("XS10: exposures fill the system -> a LIVE battle reserve (yielding budget) "
    + "takes their room in the same call, the miner comes back within the free room; not enough VISIBLE ships -> "
    + "nothing yields: global then system room in one reserve, no budget denial counted", () =>
    H.withStore(driver, async (reopen) => {
      const TEN = [{ hullGroup: "mining_barge", count: 10 }];
      const t = setup(reopen);
      assert.ok(t.budget.reserve({ reservationId: "b0", ownerKind: "battle", ownerId: "b0", systemId: S.N0,
        shipCount: 40 }).ok);
      const m = stagedMiner(t, "xs10", TEN);
      t.w.player(S.N0);
      t.pass();
      assert.deepStrictEqual([t.usedShips(), t.w.ids().length, t.counters().exposureTrimmed], [48, 8, 1]);
      const fight = createYieldingBudget(t.budget, () => t.step, t.clock);
      const r = fight.reserve({ reservationId: "b1", ownerKind: "battle", ownerId: "b1", systemId: S.N0, shipCount: 5 });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual([t.w.ids().length, t.step.getStatus().visible, t.counters().preempted,
        t.counters().preemptedShips, t.usedShips()], [0, 0, 1, 8, 45]);
      assert.strictEqual(t.budget.getStatus().counters.deniedSystem, 0, "probed, not refused");
      t.pass(t.settings.scanIntervalMs);
      assert.deepStrictEqual([t.step.getStatus().entries.map((e) => [e.fleetId, e.ships]), t.usedShips()],
        [[[m.fleetId, 3]], 48]);
      const no = fight.reserve({ reservationId: "b2", ownerKind: "battle", ownerId: "b2", systemId: S.N0,
        shipCount: 20 });
      assert.deepStrictEqual([no.ok, no.reason, t.w.ids().length, t.counters().preempted], [false, "SYSTEM_LIMIT", 3, 1]);
      t.w.aggressors.set(t.w.ids()[0], { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      t.pass(1000);
      assert.strictEqual(t.step.getStatus().held, 1);
      assert.strictEqual(t.step.yieldShips(S.N0, { system: 1, global: 0 }, t.clock.now()).reason, "NOT_ENOUGH");

      const g = setup(t.base, { limits: { perSystem: 8, global: 16 } });
      assert.ok(g.budget.reserve({ reservationId: "x0", ownerKind: "battle", ownerId: "x0", systemId: S.N0,
        shipCount: 5 }).ok);
      assert.ok(g.budget.reserve({ reservationId: "x5", ownerKind: "battle", ownerId: "x5", systemId: S.N5,
        shipCount: 5 }).ok);
      stagedMiner(g, "xs10g", TEN);
      g.w.player(S.N0);
      g.pass();
      const c = g.budget.getStatus().counters;
      assert.deepStrictEqual([g.counters().refusedBudget, c.deniedGlobal, c.deniedSystem, g.usedShips()],
        [0, 0, 0, 13]);
      assert.ok(g.step.getStatus().entries.some((e) => e.ships === 3), JSON.stringify(g.step.getStatus().entries));
    }));

  needsDriver("XS10b round 2: a VISIBLE entry with a pending player loss never yields (the claim keeps "
    + "the kill); no ship of another system leaves while the system limit still refuses; one preemption "
    + "per reservationId per backoffMs", () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    stagedMiner(t, "xs10b");
    t.w.player(S.N0);
    t.pass();
    const [a] = t.w.ids();
    t.w.kill(a);
    t.step.stepPending(t.clock.now(), { refused: {} });
    assert.strictEqual(t.step.yieldShips(S.N0, { system: 1, global: 0 }, t.clock.now()).reason, "NOT_ENOUGH");
    assert.strictEqual(t.step.getStatus().visible, 1);
    t.pass(1000);
    assert.deepStrictEqual([t.spy.claims.length, t.spy.claims[0].destroyed.length], [1, 1], "the kill reaches the claim");

    const u = setup(t.base);
    stagedMiner(u, "xs10b-m");
    u.w.player(S.N0);
    u.pass();
    const shown = () => u.step.getStatus().visible;
    const before = shown();
    assert.ok(before >= 1);
    assert.strictEqual(u.step.yieldShips(S.N5, { system: 1, global: 2 }, u.clock.now()).reason, "NOT_ENOUGH");
    assert.strictEqual(shown(), before, "N0 keeps its ships");
    const b = createPhysicalBudget({ limits: { perSystem: 4, global: 6 }, clock: u.clock });
    assert.ok(b.reserve({ reservationId: "o5", ownerKind: "battle", ownerId: "o5", systemId: S.N5, shipCount: 2 }).ok);
    assert.ok(b.reserve({ reservationId: "o0", ownerKind: "battle", ownerId: "o0", systemId: S.N0, shipCount: 4 }).ok);
    const seen = [];
    const spy = { yieldShips: (sys, need) => {
      seen.push([sys, { ...need }]);
      return { ok: true, freed: 0, entries: 0 };
    } };
    const fight = createYieldingBudget(b, () => spy, u.clock, { backoffMs: 60000 });
    const req = { reservationId: "bx", ownerKind: "battle", ownerId: "bx", systemId: S.N0, shipCount: 3 };
    assert.strictEqual(fight.reserve(req).ok, false);
    assert.deepStrictEqual(seen, [[S.N0, { system: 3, global: 3 }]]);
    fight.reserve(req);
    assert.strictEqual(seen.length, 1);
    u.clock.advance(60000);
    fight.reserve(req);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(defaults().preemptBackoffMs, 60000);
  }));

  needsDriver("XS11: a claim refused EXPOSURE_OPEN -> permanentRefusalCooldownMs (no respawn after "
    + "respawnCooldownMs); VERSION_CONFLICT -> respawnCooldownMs", () => H.withStore(driver, async (reopen) => {
    let base = reopen;
    for (const [reason, longPause] of [["EXPOSURE_OPEN", true], ["VERSION_CONFLICT", false],
      ["FLEETS_UNAVAILABLE", false], ["CLAIM_FAILED", false]]) {
      const t = setup(base);
      base = t.base;
      const m = stagedMiner(t, `xs11-${reason}`);
      const shown = () => t.step.getStatus().entries.filter((e) => e.fleetId === m.fleetId).length;
      t.w.player(S.N0);
      t.pass();
      assert.strictEqual(shown(), 1);
      t.spy.refuseClaim = reason;
      for (const id of t.w.ids()) t.w.aggressors.set(id, { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      t.pass(1000);
      assert.deepStrictEqual([t.counters().claimFailed >= 1, shown()], [true, 0], reason);
      t.spy.refuseClaim = null;
      t.w.aggressors.clear();
      t.pass(t.settings.respawnCooldownMs + t.settings.scanIntervalMs);
      assert.strictEqual(shown(), longPause ? 0 : 1, reason);
      if (longPause) {
        assert.ok(t.counters().refusedCooldown >= 1);
        t.pass(t.settings.permanentRefusalCooldownMs);
        assert.strictEqual(shown(), 1, "back after the long pause");
      }
    }
  }));

  needsDriver("XS12: cargoLootEnabled -> seedCargo once per carrier with the plan "
    + "of the convoy cargo; flag off -> no call; only hulls -> no call (cargoLootHullSkipped); WRITE_FAILED -> the "
    + "exposure stays VISIBLE (cargoSeedFailed)", () => H.withStore(driver, async (reopen) => {
    const CARGO = { "mineral/type:34": 1000000, "mineral/type:35": 200000, "hull/group:frigate": 4 };
    const PLAN = [{ typeId: 34, quantity: 250000 }, { typeId: 35, quantity: 50000 }];
    let base = reopen;
    const run = (tag, settings, cargo, seed) => {
      const t = setup(base, { settings });
      base = t.base;
      const seeds = [];
      t.w.npcSpawn.seedCargo = (entityId, items) => {
        seeds.push([entityId, items.map((x) => ({ ...x }))]);
        return seed ? seed(seeds.length) : { ok: true, written: items.length };
      };
      const c = convoyFleet(t, tag);
      t.convoys[t.convoys.length - 1] = { ...t.convoys[t.convoys.length - 1], cargo, carriersAtLoad: 2 };
      t.w.player(S.N6);
      intoWindow(t, c);
      t.pass();
      const entry = t.step.getStatus().entries.find((e) => e.fleetId === c.fleetId);
      return { t, seeds, entry, spawned: t.w.calls.filter((x) => x[0] === "spawnShip").length };
    };

    const on = run("xs12on", { cargoLootEnabled: true }, CARGO);
    assert.strictEqual(on.spawned, 2, "two industrial carriers");
    assert.deepStrictEqual(on.seeds.map((s) => s[1]), [PLAN, PLAN]);
    assert.deepStrictEqual(on.seeds.map((s) => s[0]).sort(), on.t.w.ids().sort(), "one hold per carrier ship");
    const k = on.t.counters();
    assert.deepStrictEqual([k.cargoSeeded, k.cargoSeedUnits, k.cargoLootHullSkipped, k.cargoSeedFailed,
      on.entry.cargoSeeded, on.entry.phase], [2, 600000, 1, 0, 2, "VISIBLE"]);
    for (const name of ["cargoSeeded", "cargoSeedUnits", "cargoSeedFailed", "cargoLootHullSkipped",
      "cargoLootNoMinerals", "cargoLootUnrecorded"]) assert.ok(COUNTER_NAMES.includes(name), name);

    const off = run("xs12off", {}, CARGO);
    assert.strictEqual(off.t.settings.cargoLootEnabled, false, "default off");
    assert.deepStrictEqual([off.seeds.length, off.entry.phase, off.entry.cargoSeeded, off.t.counters().cargoSeeded],
      [0, "VISIBLE", 0, 0]);

    const hulls = run("xs12hull", { cargoLootEnabled: true }, { "hull/group:frigate": 4 });
    assert.deepStrictEqual([hulls.seeds.length, hulls.t.counters().cargoLootHullSkipped,
      hulls.t.counters().cargoLootNoMinerals, hulls.entry.phase], [0, 1, 1, "VISIBLE"]);

    const failed = run("xs12fail", { cargoLootEnabled: true }, CARGO,
      (n) => (n === 1 ? { ok: false, reason: "WRITE_FAILED", detail: "x", written: 0 } : { ok: true, written: 2 }));
    assert.deepStrictEqual([failed.seeds.length, failed.t.counters().cargoSeedFailed, failed.t.counters().cargoSeeded,
      failed.entry.phase, failed.entry.ships, failed.t.counters().spawnFailed], [2, 1, 1, "VISIBLE", 2, 0]);
    assert.ok(failed.t.lines.some((l) => l.includes("cargo hold") && l.includes("WRITE_FAILED")), "logged");
  }));

  needsDriver("XS13 CV4: a convoy start marks its ships (owner, cap), the end forgets the "
    + "same IDs; a claim with a character = one onConvoyPenalty ATTACK, none again in HELD; a MINER = no call", () =>
    H.withStore(driver, async (reopen) => {
      const penalties = [];
      const standings = { onConvoyPenalty: (p) => {
        penalties.push({ ...p });
        return { ok: true, outcome: "CHARGED" };
      } };
      const wire = (t) => {
        const reg = { marks: [], forgets: [] };
        t.w.npcSpawn.markConvoyShips = (ids, o) => {
          reg.marks.push([[...ids], { ...o }]);
          return { ok: true, marked: ids.length, evicted: 0 };
        };
        t.w.npcSpawn.forgetConvoyShips = (ids) => {
          reg.forgets.push([...ids]);
          return { ok: true, forgotten: ids.length };
        };
        return reg;
      };
      const t = setup(reopen, { getStandings: () => standings });
      const reg = wire(t);
      const c = convoyFleet(t, "xs13");
      t.w.player(S.N6);
      intoWindow(t, c);
      t.pass();
      const ids = t.w.ids();
      assert.deepStrictEqual(reg.marks, [[ids, { ownerFactionId: FACTION_A, fleetId: c.fleetId,
        cap: t.settings.maxVisible * t.settings.maxShipsPerExposure }]]);
      assert.strictEqual(t.settings.maxVisible * t.settings.maxShipsPerExposure, 120);
      t.w.aggressors.set(ids[0], { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      t.pass(1000);
      assert.strictEqual(t.step.getStatus().held, 1);
      assert.deepStrictEqual(penalties, [{ kind: "ATTACK", characterId: CHAR, factionId: FACTION_A, systemId: S.N6,
        atMs: t.clock.now() }]);
      t.w.stamps.set(ids[0], { aggressorEntityId: PLAYER_SHIP, aggressedAtMs: 5 });
      t.pass(1000);
      assert.strictEqual(penalties.length, 1, "no second charge in HELD");
      assert.strictEqual(t.counters().convoyAttackCharged, 1);
      assert.deepStrictEqual(reg.forgets, [], "still in space");
      for (const id of ids) t.w.kill(id);
      t.pass(1000);
      assert.deepStrictEqual(t.spy.ends.map((e) => e.reason), ["WIPED"]);
      assert.deepStrictEqual(reg.forgets, [ids], "the end forgets the same IDs");

      const m = setup(t.base, { getStandings: () => standings });
      const mreg = wire(m);
      stagedMiner(m, "xs13m");
      m.w.player(S.N0);
      m.pass();
      m.w.aggressors.set(m.w.ids()[0], { aggressorId: PLAYER_SHIP, aggressorKind: "player" });
      m.pass(1000);
      assert.strictEqual(m.step.getStatus().held, 1);
      assert.deepStrictEqual([mreg.marks.length, mreg.forgets.length, penalties.length], [0, 0, 1]);
      for (const name of ["convoyMarkFailed", "convoyAttackCharged", "convoyAttackRefused"]) {
        assert.ok(COUNTER_NAMES.includes(name), name);
      }
    }));

  needsDriver("XS6: endInTx of a fleet no longer MATERIALIZED -> ENDED FLEET_GONE without a fleet write "
    + "a hunt lock (no operation) is not EXPOSED; a trip exposure never times out (INFO-1)", () =>
    H.withStore(driver, async (reopen) => {
      const t = setup(reopen);
      const repo = createExposureRepository({ journal: t.env.journal, fleetRepository: t.env.fleets.repository,
        getTravel: () => t.env.fleets.travel });
      const m = stagedMiner(t, "xs6");
      const f0 = t.fleetOf(m.fleetId);
      const id = X.exposureIdOf(m.fleetId, f0.version);
      const at = t.clock.now();
      const claim = t.env.tx((db) => repo.claimInTx(db, { exposureId: id, fleetId: m.fleetId,
        expectedVersion: f0.version, kind: "MINER", systemId: S.N0, operationId: m.operationId, at, characterId: CHAR,
        members: [{ memberKey: `${m.fleetId}:mining_barge:0:1`, hullGroup: "mining_barge", typeId: null }],
        destroyed: [`${m.fleetId}:mining_barge:0:1`], crossing: null }));
      assert.ok(claim.ok, JSON.stringify(claim));
      const f1 = t.fleetOf(m.fleetId);
      const rel = t.env.tx((db) => t.env.fleets.repository.transition(db, { fleetId: m.fleetId,
        expectedVersion: f1.version, from: "MATERIALIZED", to: "IDLE" }, "xs6:offline"));
      assert.ok(rel.ok, JSON.stringify(rel));
      const f2 = t.fleetOf(m.fleetId);
      const end = t.env.tx((db) => repo.endInTx(db, { exposureId: id, at: at + 10, reason: "RESTART" }));
      assert.deepStrictEqual(end, { ok: true, duplicate: false, outcome: "RELEASED", losses: [],
        endReason: "FLEET_GONE" });
      const f3 = t.fleetOf(m.fleetId);
      assert.deepStrictEqual([f3.state, f3.version, f3.shipCount], ["IDLE", f2.version, 2], "no fleet write");
      assert.deepStrictEqual(t.exposureRows().map((r) => [r.state, r.end_reason]), [["ENDED", "FLEET_GONE"]]);
      assert.strictEqual(t.env.tx((db) => repo.endInTx(db, { exposureId: id, at: at + 20, reason: "QUIET" }))
        .duplicate, true);

      const hunt = { fleetId: "f1", state: "MATERIALIZED", currentSystemId: 2, operationId: null, refitPending: false,
        nextActionAt: null };
      const convoy = { state: "IN_TRANSIT", sourceSystemId: 1, destSystemId: 3, operationId: "op1", watchRound: 0 };
      const cf = { at: 1, trigger: "due", sourceOk: true, destOk: true, stationHereId: null, stationsMode: "ready",
        carriers: 2 };
      assert.notStrictEqual(decideConvoyStep(convoy, hunt, cf, { maxWatchRounds: 12 }).reason, "EXPOSED");
      const trip = { state: "MINING", beltSystemId: 2, outboundOperationId: "op1", returnOperationId: null,
        miningEndsAt: 1000, watchRound: 12 };
      const tf = { at: 10, trigger: "due", stationHere: false, stationsMode: "ready" };
      assert.deepStrictEqual(decideStep(trip, hunt, tf, { maxWatchRounds: 12 }),
        { action: TRIP_ACTION.ABORT, reason: "NOT_IN_BELT" });
      assert.deepStrictEqual(decideStep(trip, { ...hunt, operationId: "op1" }, tf, { maxWatchRounds: 12 }),
        { action: TRIP_ACTION.WAIT, reason: "EXPOSED" });
      assert.strictEqual(CONVOY_ACTION.WAIT, "WAIT");
    }));
};

module.exports.rig = Object.freeze({ setup, convoyFleet, intoWindow, CHAR, PLAYER_SHIP, pos, GATE_OUT, stagedMiner });
