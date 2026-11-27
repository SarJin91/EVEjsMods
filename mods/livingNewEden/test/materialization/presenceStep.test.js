"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { startFleetExposure } = require("../../lib/fleetExposure");
const PR = require("../../lib/fleetExposure/presenceRules");
const { OPERATION_TYPES } = require("../../lib/fleets/schema");
const { pickDetachment, membersOf } = require("../../lib/playerHunt/huntRepository");
const { createPresenceStep } = require("../../lib/materialization/presenceStep");
const { createYieldingBudget } = require("../../lib/materialization/yieldingBudget");
const { createPhysicalBudget } = require("../../lib/materialization/physicalBudget");
const { createLossTracker } = require("../../lib/materialization/lossTracker");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A } = H;
const CHAR = 90000001;
const PLAYER_SHIP = 1090000001;
const pos = (x) => ({ x, y: 0, z: 0 });
const STATION_N0 = 60000001;
const GATE_N0 = 50000005;
const STATION_RADIUS = 30000;
const TWO = Object.freeze([{ hullGroup: "frigate", count: 2 }]);
const MIXED = Object.freeze([{ hullGroup: "frigate", count: 2 }, { hullGroup: "cruiser", count: 2 }]);

function defaults() {
  return JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR, env: {} }).config.fleetExposure));
}

function fakeWorld() {
  const w = { loaded: new Set([S.N0, S.N5]), npc: new Map(), players: [], aggressors: new Map(), calls: [],
    nextId: 9001, tracker: null };
  w.objects = new Map([
    [S.N0, [{ kind: "station", itemId: STATION_N0, position: pos(4e9), radius: STATION_RADIUS },
      { kind: "stargate", itemId: GATE_N0, position: pos(9e10), toSystemId: S.N5 },
      { kind: "asteroidBelt", itemId: 40000001, position: pos(1e9) }]],
    [S.N5, [{ kind: "station", itemId: 60000005, position: pos(5e9) },
      { kind: "stargate", itemId: 50000050, position: pos(8e10), toSystemId: S.N0 }]],
  ]);
  const objectsOf = (sys) => w.objects.get(sys) || [];
  w.scene = {
    listSystemObjects(sys, kinds) {
      w.calls.push(["listSystemObjects", sys]);
      return { ok: true, objects: objectsOf(sys).filter((o) => kinds.includes(o.kind)).map((o) => ({ ...o })) };
    },
    readPlayerShips(sys) {
      if (!w.loaded.has(sys)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, ships: w.players.filter((p) => p.systemId === sys).map((p) => ({ characterId: p.characterId,
        entityId: p.entityId, position: pos(0), inWarp: false, cloaked: false, capsule: false })) };
    },
    readShips(sys, ids) {
      return { ok: true, ships: ids.filter((id) => w.npc.has(id))
        .map((id) => ({ entityId: id, position: { ...w.npc.get(id).position }, inWarp: false })) };
    },
    warpShips(sys, ids, point) {
      w.calls.push(["warpShips", [...ids]]);
      for (const id of ids) if (w.npc.has(id)) w.npc.get(id).position = { ...point };
      return { ok: true, warped: ids.length, failed: [] };
    },
    readAggressors(sys, ids) {
      return { ok: true, aggressors: ids.filter((id) => w.aggressors.has(id)).map((id) => ({ entityId: id,
        aggressorId: PLAYER_SHIP, aggressorKind: "player", aggressorFactionId: null })) };
    },
  };
  w.group = { readGroup: (sys, ids) => ({ ok: true, ships: ids.filter((id) => w.npc.has(id)).map((id) => ({
    entityId: id, aggressorEntityId: 0, aggressedAtMs: 0 })) }) };
  w.npcSpawn = {
    resolveProfiles: (reqs) => ({ ok: true, profiles: reqs.map((r) => `p_${r.hullGroup}`) }),
    isSceneLoaded: (sys) => w.loaded.has(sys),
    spawnShip(sys, spec) {
      w.calls.push(["spawnShip", sys, { ...spec.anchorDescriptor }, spec.behavior, spec.spawnDistanceMeters]);
      const o = objectsOf(sys).find((x) => x.itemId === spec.anchorDescriptor.itemID);
      const id = w.nextId;
      w.nextId += 1;
      w.npc.set(id, { systemId: sys, position: o ? { ...o.position } : pos(0) });
      return { ok: true, entityId: id };
    },
    publish: (sys, ids) => ({ ok: true, published: ids.length, missing: 0 }),
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
  return w;
}

function bootBase(reopen) {
  const shared = H.sharedOf();
  const opened = reopen();
  const env = H.boot(opened, shared);
  const fx = startFleetExposure({ config: { ...H.CONFIG, fleetExposure: { enabled: false, presence: { enabled: true } } },
    persistence: { ok: true, store: env.store, journal: env.journal }, clock: shared.clock,
    getFleets: () => env.fleets, telemetry: null, logger: { log() {} } });
  assert.ok(fx.ok, JSON.stringify(fx));
  return { shared, opened, env, facade: fx.fleetExposure };
}

function setup(reopenOrBase, opts = {}) {
  const base = typeof reopenOrBase === "function" ? bootBase(reopenOrBase) : reopenOrBase;
  const { shared, opened, env, facade } = base;
  const clock = shared.clock;
  const held = defaults();
  const settings = { ...held.presence, enabled: true, ...(opts.settings || {}) };
  const w = fakeWorld();
  const tracker = createLossTracker({ maxPending: 40 });
  w.tracker = tracker;
  const budget = createPhysicalBudget({ limits: opts.limits || { perSystem: 48, global: 120 }, clock });
  const gauges = {};
  const telemetry = { count() {}, observe() {}, gauge: (name, v) => { gauges[name] = v; } };
  const t = { owned: new Set(), gov: { admits: true } };
  const step = createPresenceStep({ store: env.store, clock, npcSpawn: w.npcSpawn, budget, settings,
    heldSettings: held, lossTracker: tracker, lossImportOn: true,
    despawnAll: (sys, ids) => (ids.length > 0 ? w.npcSpawn.despawn(sys, ids) : null), admits: () => t.gov.admits,
    getFleetExposure: () => facade, getFleets: () => env.fleets, getHuntScene: () => w.scene,
    getBeltNavyScene: () => w.group, worldSeed: opened.worldSeed, getOwnedFleetIds: () => t.owned, telemetry,
    ...(typeof opts.deps === "function" ? opts.deps({ w, facade }) : {}) });
  const presence = {
    observedSystems: () => [...new Set(w.players.map((p) => p.systemId))],
    getSystemPresence: (id) => ({ systemId: id, space: w.players.filter((p) => p.systemId === id).length }),
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
  const entryOf = (fleetId) => step.getStatus().entries.find((e) => e.fleetId === fleetId) || null;
  return Object.assign(t, { base, env, clock, settings, held, w, budget, gauges, step, pass, fleetOf, rows, entryOf,
    counters: () => step.getStatus().counters });
}

function idleFleet(t, tag, systemId, composition = TWO) {
  const r = t.env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: systemId, homeSystemId: systemId,
    fleetRole: "garrison", composition }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function stagedFleet(t, tag, systemId, opType, objective, role = "invasion") {
  const r = t.env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: systemId, homeSystemId: systemId,
    fleetRole: role, composition: TWO }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  const op = t.env.fleets.createOperation({ operationType: opType, factionId: FACTION_A, originSystemId: systemId,
    targetSystemId: systemId, objective, dueAt: null, fleets: [{ fleetId: r.fleetId, expectedVersion: 1 }] },
  `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const f = t.fleetOf(r.fleetId);
  const st = t.env.tx((db) => t.env.fleets.repository.transition(db, { fleetId: r.fleetId, expectedVersion: f.version,
    from: f.state, to: "STAGED", patch: {} }, `${tag}:stage`));
  assert.ok(st.ok, JSON.stringify(st));
  return { fleetId: r.fleetId, operationId: op.operationId };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PR1: IDLE garrison + STAGED invasion in the player system -> 2 VISIBLE presences "
    + "no row, no journal; anchors station (radius + surfaceMarginMeters) / gate (DEFAULT); passive ships; the anchor "
    + "rule covers every OPERATION_TYPES", () => H.withStore(driver, async (reopen) => {
    assert.deepStrictEqual(OPERATION_TYPES.filter((op) => !PR.ANCHOR_RULE_OF_OPERATION[op]), []);
    assert.deepStrictEqual(Object.keys(PR.ANCHOR_RULE_OF_OPERATION).sort(), [...OPERATION_TYPES].sort());
    const t = setup(reopen);
    assert.strictEqual(t.held.presence.enabled, false, "off in the code");
    const g = idleFleet(t, "pr1g", S.N0);
    const inv = stagedFleet(t, "pr1i", S.N0, "invasion", "capture");
    t.w.player(S.N0);
    const before = t.rows();
    t.pass();
    assert.deepStrictEqual(t.rows(), before, "VISIBLE writes nothing");
    assert.deepStrictEqual([t.entryOf(g).phase, t.entryOf(g).ships, t.entryOf(inv.fleetId).ships], ["VISIBLE", 2, 2]);
    assert.deepStrictEqual([t.fleetOf(g).state, t.fleetOf(inv.fleetId).state], ["IDLE", "STAGED"]);
    const spawns = t.w.calls.filter((c) => c[0] === "spawnShip");
    const at = (itemId) => spawns.filter((c) => c[2].itemID === itemId);
    assert.strictEqual(at(STATION_N0).length, 2);
    assert.strictEqual(at(GATE_N0).length, 2);
    assert.ok(at(STATION_N0).every((c) => c[4] === STATION_RADIUS + t.held.surfaceMarginMeters));
    assert.ok(at(GATE_N0).every((c) => c[4] === t.settings.spawnDistanceMeters));
    assert.ok(spawns.every((c) => c[3] === "search"), "passive behaviour");
    assert.deepStrictEqual([t.counters().presenceStarted, t.counters().presenceShips, t.budget.getStatus().reservedShips],
      [2, 4, 4]);
  }));

  needsDriver("PR2 fair share: 12 fleets under maxShipsPerSystem 8 -> 8 fleets x 1 ship, gauge presenceHiddenFleets 4; "
    + "4 fleets at 24 with maxShipsPerFleet 3 -> 3/3/3/3, ships = the prefix of pickDetachment", () =>
    H.withStore(driver, async (reopen) => {
      const t = setup(reopen, { settings: { maxShipsPerSystem: 8 } });
      const ids = [];
      for (let i = 0; i < 12; i += 1) ids.push(idleFleet(t, `pr2-${i}`, S.N0));
      t.w.player(S.N0);
      t.pass();
      const shown = t.step.getStatus().entries;
      assert.deepStrictEqual([shown.length, shown.every((e) => e.ships === 1)], [8, true]);
      assert.strictEqual(t.gauges["fleetExposure.presenceHiddenFleets"], 4);
      assert.strictEqual(t.step.getStatus().hidden[S.N0].length, 4);
      const first = shown.map((e) => e.fleetId).sort();
      t.pass(t.settings.scanIntervalMs);
      assert.deepStrictEqual(t.step.getStatus().entries.map((e) => e.fleetId).sort(), first);

      const u = setup(t.base);
      const mixed = [];
      for (let i = 0; i < 4; i += 1) mixed.push(idleFleet(u, `pr2m-${i}`, S.N5, MIXED));
      u.w.player(S.N5);
      u.pass();
      assert.deepStrictEqual(mixed.map((id) => u.entryOf(id) && u.entryOf(id).ships), [3, 3, 3, 3]);
      for (const id of mixed) {
        const f = u.fleetOf(id);
        const prefix = pickDetachment(membersOf(f.fleetId, f.composition), 3).map((m) => m.memberKey);
        assert.deepStrictEqual(u.entryOf(id).memberKeys, prefix);
      }
      assert.strictEqual(u.gauges["fleetExposure.presenceHiddenFleets"], 0);
    }));

  needsDriver("PR3 preemption: presence 24 + other 24 at the limit 48 -> a battle through the ranked budget takes 5 "
    + "presence ships (the largest fleets, fleetId descending), the other yielder untouched; the system does not "
    + "grow within yieldHoldMs", () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    assert.ok(t.budget.reserve({ reservationId: "x0", ownerKind: "battle", ownerId: "x0", systemId: S.N0,
      shipCount: 24 }).ok);
    const ids = [];
    for (let i = 0; i < 8; i += 1) ids.push(idleFleet(t, `pr3-${i}`, S.N0, MIXED));
    t.w.player(S.N0);
    t.pass();
    t.pass(t.settings.scanIntervalMs);
    assert.strictEqual(t.budget.getStatus().reservedShips, 48);
    assert.strictEqual(t.step.getStatus().ships, 24);
    const spy = { calls: 0, freeable: () => ({ system: 10, global: 10 }), yieldShips: () => {
      spy.calls += 1;
      return { ok: true, freed: 0, entries: 0 };
    } };
    const fight = createYieldingBudget(t.budget, () => [t.step, spy], t.clock);
    const r = fight.reserve({ reservationId: "b1", ownerKind: "battle", ownerId: "b1", systemId: S.N0, shipCount: 5 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(spy.calls, 0, "presence was enough");
    const sizes = new Map(t.step.getStatus().entries.map((e) => [e.fleetId, e.ships]));
    const sorted = [...ids].sort();
    assert.deepStrictEqual(sorted.map((id) => sizes.get(id)), [3, 3, 3, 2, 2, 2, 2, 2], "highest fleetIds first");
    assert.deepStrictEqual([t.counters().presenceYielded, t.budget.getStatus().reservedShips], [5, 48]);
    t.budget.release("b1");
    t.pass(t.settings.scanIntervalMs);
    assert.strictEqual(t.step.getStatus().ships, 19, "yieldHoldMs: no growth");
    t.pass(t.settings.yieldHoldMs);
    assert.strictEqual(t.step.getStatus().ships, 24, "after the hold the room is used again");
  }));

  needsDriver("PR4 hand-over: a hunt reserve of a shown fleet -> the presence despawn comes before the hunt spawn "
    + "(onFleetReserve), presenceHandedOver 1; releaseFleets of a battle; an owned fleet is not shown again", () =>
    H.withStore(driver, async (reopen) => {
      const t = setup(reopen);
      const a = idleFleet(t, "pr4a", S.N0);
      const b = idleFleet(t, "pr4b", S.N0);
      t.w.player(S.N0);
      t.pass();
      assert.deepStrictEqual([t.entryOf(a).ships, t.entryOf(b).ships], [2, 2]);
      const fight = createYieldingBudget(t.budget, () => [t.step], t.clock,
        { onFleetReserve: (id) => t.step.releaseFleet(id) });
      const mark = t.w.calls.length;
      assert.ok(fight.reserve({ reservationId: `hunt:${a}`, ownerKind: "fleet", ownerId: a, systemId: S.N0,
        shipCount: 2 }).ok);
      t.w.npcSpawn.spawnShip(S.N0, { profileId: "p_frigate", anchorDescriptor: { kind: "stargate", itemID: GATE_N0 },
        spawnDistanceMeters: 5000, behavior: "search" });
      const after = t.w.calls.slice(mark).map((c) => c[0]);
      assert.ok(after.indexOf("despawn") >= 0 && after.indexOf("despawn") < after.indexOf("spawnShip"),
        JSON.stringify(after));
      assert.deepStrictEqual([t.entryOf(a), t.counters().presenceHandedOver], [null, 1]);
      assert.deepStrictEqual(t.step.releaseFleets([b, "no-such-fleet"]), { ok: true, released: 2 });
      t.owned = new Set([a, b]);
      t.pass(t.settings.scanIntervalMs);
      assert.deepStrictEqual([t.entryOf(a), t.entryOf(b)], [null, null]);
    }));

  needsDriver("PR6 round 2: a kill noted by stepPending, a hunt reserve of the fleet before step -> veto "
    + "PRESENCE_PENDING_LOSS (no budget touched, ships stay), step claims with the loss (HELD, MATERIALIZED), the next "
    + "reserve is no veto; releaseFleet of an entry with a pending kill counts presenceLossDropped", () =>
    H.withStore(driver, async (reopen) => {
      const t = setup(reopen);
      const a = idleFleet(t, "pr6a", S.N0);
      const b = idleFleet(t, "pr6b", S.N0);
      t.w.player(S.N0);
      t.pass();
      const fight = createYieldingBudget(t.budget, () => [t.step], t.clock,
        { onFleetReserve: (id) => t.step.handOver(id) });
      t.w.kill(t.entryOf(a).entityIds[0]);
      t.step.stepPending(t.clock.now(), { refused: {} });
      const used = t.budget.getStatus().reservedShips;
      const hunt = { reservationId: `hunt:${a}`, ownerKind: "fleet", ownerId: a, systemId: S.N0, shipCount: 2 };
      assert.deepStrictEqual(fight.reserve(hunt), { ok: false, reason: "PRESENCE_PENDING_LOSS" });
      assert.deepStrictEqual([t.entryOf(a).phase, t.budget.getStatus().reservedShips, t.counters().presenceHandedOver],
        ["VISIBLE", used, 0]);
      t.step.step(t.clock.now(), { observedSystems: () => [S.N0], getSystemPresence: () => ({ space: 1 }) },
        { refused: {} });
      assert.deepStrictEqual([t.entryOf(a).phase, t.fleetOf(a).state, t.counters().presenceLossImported],
        ["HELD", "MATERIALIZED", 1]);
      assert.strictEqual(fight.reserve(hunt).ok, true, "HELD: no veto (the hunt claim then sees MATERIALIZED)");
      t.w.kill(t.entryOf(b).entityIds[0]);
      t.step.stepPending(t.clock.now(), { refused: {} });
      assert.strictEqual(t.step.hasPendingLoss(b), true);
      assert.deepStrictEqual(t.step.releaseFleet(b), { ok: true, released: 2 });
      assert.strictEqual(t.counters().presenceLossDropped, 1);
    }));

  needsDriver("PR5 aggression on an IDLE fleet -> claim PRESENCE (MATERIALIZED, HELD) -> killmail markDestroyedInTx -> "
    + "quiet -> EXIT -> END -> IDLE with one ship less (once); aggression on a REFITTING fleet -> despawn UNCLAIMABLE, "
    + "zero writes, not shown in the cooldown", () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    const g = idleFleet(t, "pr5g", S.N0);
    const rf = idleFleet(t, "pr5r", S.N0);
    const f0 = t.fleetOf(rf);
    assert.ok(t.env.tx((db) => t.env.fleets.repository.transition(db, { fleetId: rf, expectedVersion: f0.version,
      from: "IDLE", to: "REFITTING", patch: { nextActionAt: t.clock.now() + 86400000 } }, "pr5r:refit")).ok);
    t.w.player(S.N0);
    t.pass();
    assert.deepStrictEqual([t.entryOf(g).claimable, t.entryOf(rf).claimable, t.entryOf(rf).fleetState],
      [true, false, "REFITTING"]);
    const rows0 = t.rows();
    const own = t.entryOf(g).entityIds;
    for (const id of t.entryOf(rf).entityIds) t.w.aggressors.set(id, {});
    t.pass(1000);
    assert.deepStrictEqual([t.entryOf(rf), t.counters().presenceUnclaimable, t.rows()], [null, 1, rows0]);
    t.pass(t.settings.scanIntervalMs);
    assert.strictEqual(t.entryOf(rf), null, "cooldown");
    t.w.aggressors.clear();
    assert.deepStrictEqual(t.entryOf(g).entityIds, own);
    t.w.aggressors.set(own[0], {});
    t.pass(1000);
    assert.deepStrictEqual([t.entryOf(g).phase, t.fleetOf(g).state, t.counters().presenceClaimed],
      ["HELD", "MATERIALIZED", 1]);
    t.w.kill(own[1]);
    t.pass(1000);
    assert.strictEqual(t.counters().presenceLossImported, 1);
    t.w.aggressors.clear();
    t.pass(t.held.holdQuietMs);
    assert.strictEqual(t.entryOf(g).phase, "EXITING");
    t.pass(1000);
    const f1 = t.fleetOf(g);
    assert.deepStrictEqual([f1.state, f1.shipCount, t.counters().presenceEnded], ["IDLE", 1, 1]);
    const row = t.env.tx((db) => db.prepare("SELECT kind, state, from_state, operation_id FROM world_fleet_exposures")
      .all());
    assert.deepStrictEqual(row, [{ kind: "PRESENCE", state: "ENDED", from_state: "IDLE", operation_id: "-" }]);
  }));

  needsDriver("PR7: STAGED expedition / blockade are shown but not claimable - an aggression -> "
    + "despawn UNCLAIMABLE, zero writes, the fleets stay STAGED; a STAGED mining fleet (claimStagedOperationTypes) is "
    + "claimed (HELD, MATERIALIZED)", () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    assert.strictEqual(t.settings.claimStagedOperationTypes, "mining,logistics,ratting,salvage");
    const ex = stagedFleet(t, "pr7e", S.N0, "expedition", "expedition");
    const bl = stagedFleet(t, "pr7b", S.N0, "blockade", "hold");
    const mi = stagedFleet(t, "pr7m", S.N0, "mining", "mine", "mining");
    t.w.player(S.N0);
    t.pass();
    const ids = [ex.fleetId, bl.fleetId, mi.fleetId];
    assert.deepStrictEqual(ids.map((id) => t.entryOf(id) && t.entryOf(id).claimable), [false, false, true]);
    const rows0 = t.rows();
    for (const id of [...t.entryOf(ex.fleetId).entityIds, ...t.entryOf(bl.fleetId).entityIds]) {
      t.w.aggressors.set(id, {});
    }
    t.pass(1000);
    assert.deepStrictEqual([t.entryOf(ex.fleetId), t.entryOf(bl.fleetId), t.counters().presenceUnclaimable,
      t.counters().presenceClaimed, t.rows()], [null, null, 2, 0, rows0]);
    assert.deepStrictEqual([t.fleetOf(ex.fleetId).state, t.fleetOf(bl.fleetId).state], ["STAGED", "STAGED"]);
    t.w.aggressors.clear();
    t.w.aggressors.set(t.entryOf(mi.fleetId).entityIds[0], {});
    t.pass(1000);
    assert.deepStrictEqual([t.entryOf(mi.fleetId).phase, t.fleetOf(mi.fleetId).state, t.counters().presenceClaimed],
      ["HELD", "MATERIALIZED", 1]);
  }));

  needsDriver("PR8: a pending kill with systemFacts null for good is dropped after "
    + "pendingLossMaxAgeMs (presencePendingExpired, the hand-over veto ends); SCENE_GONE with a pending kill counts "
    + "presenceLossDropped", () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    const a = idleFleet(t, "pr8a", S.N0);
    const b = idleFleet(t, "pr8b", S.N0);
    t.w.player(S.N0);
    t.pass();
    const readShips = t.w.scene.readShips;
    t.w.scene.readShips = () => ({ ok: false, reason: "READ_FAILED" });
    t.w.kill(t.entryOf(a).entityIds[0]);
    t.pass(1000);
    assert.deepStrictEqual([t.step.hasPendingLoss(a), t.entryOf(a).phase], [true, "VISIBLE"], "no facts, no claim");
    t.clock.advance(t.settings.pendingLossMaxAgeMs - 1);
    t.step.stepPending(t.clock.now(), { refused: {} });
    assert.deepStrictEqual([t.step.hasPendingLoss(a), t.counters().presencePendingExpired], [true, 0], "not yet");
    t.clock.advance(1);
    t.step.stepPending(t.clock.now(), { refused: {} });
    assert.deepStrictEqual([t.step.hasPendingLoss(a), t.counters().presencePendingExpired, t.entryOf(a).ships,
      t.fleetOf(a).state], [false, 1, 1, "IDLE"]);
    assert.strictEqual(t.step.handOver(a).ok, true, "no veto after the expiry");
    t.w.scene.readShips = readShips;
    t.w.kill(t.entryOf(b).entityIds[0]);
    t.step.stepPending(t.clock.now(), { refused: {} });
    const dropped = t.counters().presenceLossDropped;
    const scene = t.w.scene;
    t.w.scene = null;
    t.step.step(t.clock.now(), null, { refused: {} });
    t.w.scene = scene;
    assert.deepStrictEqual([t.entryOf(b), t.counters().presenceLossDropped - dropped], [null, 1]);
  }));

  needsDriver("PR10 BUG presence-respawn-after-wipe: a claimed fleet wiped by the player -> not shown "
    + "again before wipedCooldownMs, no new presence fleet in its system before systemWipeHoldMs (WIPE_HOLD), "
    + "another system unchanged; after the hold / the cooldown they come back", () => H.withStore(driver, async (reopen) => {
    const t = setup(reopen);
    assert.deepStrictEqual([t.settings.wipedCooldownMs, t.settings.systemWipeHoldMs], [600000, 120000]);
    const a = idleFleet(t, "pr10a", S.N0, MIXED);
    t.w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N0 },
      { characterId: CHAR + 1, entityId: PLAYER_SHIP + 1, systemId: S.N5 }];
    t.pass();
    const ids = t.entryOf(a).entityIds;
    assert.strictEqual(ids.length, 3);
    t.w.kill(ids[0]);
    t.pass(1000);
    assert.strictEqual(t.entryOf(a).phase, "HELD");
    t.w.kill(ids[1]);
    t.w.kill(ids[2]);
    t.pass(1000);
    assert.deepStrictEqual([t.entryOf(a), t.counters().presenceWiped, t.fleetOf(a).state, t.fleetOf(a).shipCount],
      [null, 1, "IDLE", 1]);
    const c = idleFleet(t, "pr10c", S.N0);
    const d = idleFleet(t, "pr10d", S.N5);
    t.pass(t.settings.scanIntervalMs);
    assert.deepStrictEqual([t.entryOf(a), t.entryOf(c), t.entryOf(d) && t.entryOf(d).ships], [null, null, 2],
      "the wiped fleet and its system hold, the other system grows");
    const reasons = new Map(t.step.getStatus().hidden[S.N0].map((x) => [x.fleetId, x.reason]));
    assert.deepStrictEqual([reasons.get(a), reasons.get(c)], ["COOLDOWN", "WIPE_HOLD"]);
    t.pass(t.settings.systemWipeHoldMs);
    assert.deepStrictEqual([t.entryOf(a), t.entryOf(c) && t.entryOf(c).ships], [null, 2], "hold over, cooldown not");
    t.pass(t.settings.wipedCooldownMs);
    assert.deepStrictEqual(t.entryOf(a) && [t.entryOf(a).phase, t.entryOf(a).ships], ["VISIBLE", 1],
      "after the cooldown the fleet is shown again");
  }));

  const backoffSettings = (env = {}) => resolveConfig({ modDir: MOD_DIR, env }).config.materialization.spawnBackoff;
  const scripted = (opts) => {
    const lines = [];
    const plan = [];
    const t = setup(opts.base, { deps: ({ w }) => {
      const real = w.npcSpawn.spawnShip;
      w.npcSpawn.spawnShip = (sys, spec) => {
        const answer = plan.length > 0 ? plan.shift() : null;
        return answer === null ? real.call(w.npcSpawn, sys, spec) : answer;
      };
      return { spawnBackoff: opts.backoff, logger: { log: (l) => lines.push(l) } };
    } });
    return Object.assign(t, { lines, plan });
  };

  needsDriver("PR11 BUG presence-spawn-backoff: a deterministic vendor refusal of the 2nd ship -> rollback, one log line "
    + "with the reason, next scan no spawn (presenceRefusedBackoff 1, hidden SPAWN_BACKOFF); a transient one waits "
    + "baseMs, the success clears the backoff; SCENE_NPC_BUDGET keeps the ships (BUDGET, no rollback, no backoff)", () =>
    H.withStore(driver, async (reopen) => {
      const { createSpawnBackoff } = require("../../lib/materialization/spawnBackoff");
      const SB = backoffSettings();
      const base = bootBase(reopen);
      const b1 = createSpawnBackoff(SB);
      const t = scripted({ base, backoff: b1 });
      const a = idleFleet(t, "pr11a", S.N0);
      t.w.player(S.N0);
      t.plan.push(null, { ok: false, reason: "SPAWN_FAILED", detail: "NPC_NATIVE_NO_FREE_SLOT" });
      t.pass();
      assert.deepStrictEqual([t.entryOf(a), t.counters().presenceSpawnFailed, t.w.count("despawn"), t.w.npc.size],
        [null, 1, 1, 0], "the ship of the pass rolled back");
      const rolled = t.lines.filter((l) => l.includes("rolled back"));
      assert.strictEqual(rolled.length, 1);
      assert.ok(rolled[0].includes("NPC_NATIVE_NO_FREE_SLOT") && rolled[0].includes(`backoff=${SB.permanentMs}ms`),
        rolled[0]);
      const spawns = t.w.count("spawnShip");
      const out = t.pass(t.settings.scanIntervalMs);
      assert.deepStrictEqual([t.w.count("spawnShip"), t.entryOf(a), t.counters().presenceRefusedBackoff,
        out.refused["presence:SPAWN_BACKOFF"], t.counters().presenceSpawnFailed], [spawns, null, 1, 1, 1]);
      assert.strictEqual(t.step.getStatus().hidden[S.N0].find((x) => x.fleetId === a).reason, "SPAWN_BACKOFF");

      const b2 = createSpawnBackoff(SB);
      const u = scripted({ base, backoff: b2 });
      const b = idleFleet(u, "pr11b", S.N5);
      u.w.player(S.N5);
      u.plan.push({ ok: false, reason: "SPAWN_FAILED", detail: "boom" });
      u.pass();
      assert.deepStrictEqual([u.entryOf(b), b2.size(), u.lines.filter((l) => l.includes("rolled back")).length],
        [null, 1, 1]);
      u.pass(u.settings.scanIntervalMs);
      assert.deepStrictEqual([u.entryOf(b), u.counters().presenceRefusedBackoff], [null, 1]);
      u.pass(SB.baseMs);
      assert.deepStrictEqual([u.entryOf(b) && u.entryOf(b).ships, b2.size()], [2, 0], "shown, backoff cleared");

      const c = idleFleet(u, "pr11c", S.N5);
      const despawns = u.w.count("despawn");
      u.plan.push(null, { ok: false, reason: "SCENE_NPC_BUDGET" });
      u.pass(u.settings.scanIntervalMs);
      assert.deepStrictEqual([u.entryOf(c) && u.entryOf(c).ships, u.w.count("despawn") - despawns, b2.size(),
        u.counters().presenceRefusedBudget, u.counters().presenceSpawnFailed], [1, 0, 0, 1, 1]);
    }));

  needsDriver("PR12 BUG presence-spawn-backoff: materialization.spawnBackoff.enabled=false -> the next scan spawns "
    + "again (as before), no presenceRefusedBackoff, no rollback log line", () => H.withStore(driver, async (reopen) => {
    const { createSpawnBackoff } = require("../../lib/materialization/spawnBackoff");
    const off = createSpawnBackoff(backoffSettings({ EVEJS_LNE_MATERIALIZATION_SPAWN_BACKOFF_ENABLED: "0" }));
    const t = scripted({ base: bootBase(reopen), backoff: off });
    const a = idleFleet(t, "pr12a", S.N0);
    t.w.player(S.N0);
    t.plan.push(null, { ok: false, reason: "SPAWN_FAILED", detail: "NPC_NATIVE_NO_FREE_SLOT" });
    t.pass();
    const spawns = t.w.count("spawnShip");
    t.pass(t.settings.scanIntervalMs);
    assert.deepStrictEqual([t.w.count("spawnShip") - spawns, t.entryOf(a) && t.entryOf(a).ships,
      t.counters().presenceRefusedBackoff, t.lines.filter((l) => l.includes("rolled back")).length], [2, 2, 0, 0]);
  }));

  test("PR9: cursorAfterCut - a cut inside the window starts the next one at the first not "
    + "served system, a cut at window[0] goes to the window end, or to window[0] when the window holds every system",
  () => {
    const { cursorAfterCut } = require("../../lib/materialization/presenceStep");
    assert.strictEqual(cursorAfterCut([5, 7, 1], [5, 7, 1], 1, false), 5, "7 not served -> after 5");
    assert.strictEqual(cursorAfterCut([5, 7, 1], [7, 1, 5], 1, false), 1, "5 not served at window[0] -> window end");
    assert.strictEqual(cursorAfterCut([5, 7, 1], [7, 1, 5], 1, true), 5, "whole window -> window[0]");
    assert.strictEqual(cursorAfterCut([5, 7, 1], [5, 7, 1], 2, true), 7, "only 1 cut -> after 7");
  });
};

module.exports.harness = { bootBase, setup, CHAR, PLAYER_SHIP, pos };
