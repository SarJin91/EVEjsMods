"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createAggroService } = require("../../../lib/world/beltNavy/aggroService");
const { startBeltNavy } = require("../../../lib/world/beltNavy");
const { resolveConfig } = require("../../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SYSTEM = 30001984;
const CALDARI = 500001;
const SETTINGS = Object.freeze({ standingAggroEnabled: true, hostileBelowStanding: 0, aggroRangeMeters: 150000, pollMs: 5000,
  maxGroups: 3, maxGroupsPerPass: 2, groupTtlMs: 1800000 });

function harness(over = {}) {
  const world = { now: 1000000, players: [], ships: new Map(), standing: new Map(), timers: [], orders: [], despawned: [],
    penalties: [], reads: [], standingReads: 0, despawnResult: { ok: true, removed: 1, missing: 0, purged: 0 },
    playersRead: { ok: true }, counts: {} };
  const service = createAggroService({
    hunt: { readPlayerShips: (systemId) => (world.playersRead.ok ? { ok: true, ships: world.players } : world.playersRead) },
    scene: {
      readGroup: (systemId, ids) => {
        world.reads.push(ids[0]);
        if (world.failGroup === ids[0]) return { ok: false, reason: "READ_FAILED" };
        return { ok: true, ships: ids.map((id) => world.ships.get(id)).filter(Boolean) };
      },
      orderGroup: (systemId, orders) => {
        world.orders.push(...orders);
        return { ok: true, failed: [] };
      },
    },
    spawn: { despawn: (systemId, ids) => {
      world.despawned.push(ids);
      return world.despawnResult;
    } },
    readStanding: (c) => {
      world.standingReads += 1;
      return { ok: true, found: true, standing: world.standing.get(c) || 0 };
    },
    getStandings: () => ({ onNavyPenalty: (p) => {
      world.penalties.push(p);
      return { ok: true, outcome: "CHARGED" };
    } }),
    clock: { now: () => world.now },
    settings: SETTINGS,
    telemetry: { count: (name, n) => { world.counts[name] = (world.counts[name] || 0) + n; }, gauge() {}, observe() {} },
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cancelled: false, cancel() { handle.cancelled = true; }, hasRef: () => false };
      world.timers.push(handle);
      return handle;
    },
    nowMs: () => 0,
    ...over,
  });
  const fire = () => {
    const live = world.timers.filter((t) => !t.cancelled && !t.fired);
    assert.strictEqual(live.length, 1, "exactly one armed timer");
    live[0].fired = true;
    live[0].fn();
  };
  const armed = () => world.timers.filter((t) => !t.cancelled && !t.fired).length;
  const addShip = (id, over2 = {}) => {
    const ship = { entityId: id, position: { x: 0, y: 0, z: 0 }, manualTargetId: 0, aggressorEntityId: 0, aggressedAtMs: 0,
      ...over2 };
    world.ships.set(id, ship);
    return ship;
  };
  const register = (id, over2 = {}) => service.registerGroup({ spawnSiteId: `site:${id}`, systemId: SYSTEM,
    factionId: CALDARI, entityIds: [id], atMs: world.now, ...over2 });
  return { world, service, fire, armed, addShip, register };
}

const pilot = (characterId, x = 1000) => ({ characterId, entityId: characterId * 100, position: { x, y: 0, z: 0 } });

module.exports = ({ test }) => {
  test("BNG1 registerGroup: hostile answered at once, one timer, a passive group gets no order, rotation under the budget", () => {
    const h = harness();
    h.addShip(1);
    h.world.players = [pilot(7)];
    h.world.standing.set(7, -2);
    assert.deepStrictEqual(h.register(1), { ok: true });
    assert.deepStrictEqual(h.world.orders, [{ entityId: 1, targetId: 700 }], "the first pass, not after pollMs");
    assert.strictEqual(h.world.timers[0].ms, SETTINGS.pollMs);

    const passive = harness();
    passive.addShip(2);
    passive.world.players = [pilot(8)];
    passive.register(2);
    assert.deepStrictEqual(passive.world.orders, [], "neutral pilot: the group stays passive");

    const many = harness();
    for (const id of [1, 2, 3]) {
      many.addShip(id);
      many.register(id);
    }
    assert.strictEqual(many.armed(), 1, "one timer for all groups");
    many.world.reads.length = 0;
    many.fire();
    assert.deepStrictEqual(many.world.reads, [1, 2], "maxGroupsPerPass");
    many.world.reads.length = 0;
    many.fire();
    assert.deepStrictEqual(many.world.reads, [3, 1], "rotation");
  });

  test("BNG2 attack by a friendly pilot: one call per new shot, the group answers, standing read once per pass", () => {
    const h = harness();
    const ship = h.addShip(1);
    const other = h.addShip(2);
    h.world.players = [pilot(7)];
    h.world.standing.set(7, 5);
    h.service.registerGroup({ spawnSiteId: "s", systemId: SYSTEM, factionId: CALDARI, entityIds: [1, 2], atMs: h.world.now });
    assert.strictEqual(h.world.standingReads, 1);
    assert.deepStrictEqual(h.world.orders, []);
    ship.aggressorEntityId = 700;
    ship.aggressedAtMs = 900;
    h.world.now += 5000;
    h.fire();
    assert.deepStrictEqual(h.world.penalties, [{ kind: "ATTACK", characterId: 7, factionId: CALDARI, systemId: SYSTEM,
      atMs: h.world.now }]);
    assert.deepStrictEqual(h.world.orders, [{ entityId: 1, targetId: 700 }, { entityId: 2, targetId: 700 }]);
    assert.strictEqual(h.world.counts["world.beltNavy.attacks"], 1);
    ship.manualTargetId = 700;
    other.manualTargetId = 700;
    h.fire();
    assert.strictEqual(h.world.penalties.length, 1, "the same stamp again");
    assert.strictEqual(h.world.orders.length, 2, "targets kept");
    ship.aggressedAtMs = 901;
    h.fire();
    assert.strictEqual(h.world.penalties.length, 2, "a new shot: the service decides by the window key");
  });

  test("BNG3 TTL: despawn removes the group and the timer ends, a failed despawn retries, a sleeping group is not dropped", () => {
    const h = harness();
    h.addShip(1);
    h.register(1);
    h.fire();
    assert.strictEqual(h.service.getStatus().groups, 1, "before the TTL");
    h.world.ships.clear();
    h.fire();
    assert.strictEqual(h.service.getStatus().groups, 1, "no ships read: asleep, not gone");
    h.world.now += SETTINGS.groupTtlMs;
    h.world.despawnResult = { ok: false, reason: "DESPAWN_FAILED" };
    h.fire();
    assert.strictEqual(h.service.getStatus().groups, 1, "a failed despawn keeps the group");
    h.world.despawnResult = { ok: true, removed: 0, missing: 1, purged: 1 };
    h.fire();
    assert.deepStrictEqual(h.world.despawned, [[1], [1]]);
    assert.strictEqual(h.service.getStatus().groups, 0);
    assert.strictEqual(h.world.counts["world.beltNavy.expired"], 1);
    assert.strictEqual(h.armed(), 0, "an empty registry has no timer");
    h.addShip(2);
    h.register(2);
    assert.strictEqual(h.armed(), 1, "the next group starts the timer again");

    const unloaded = harness();
    unloaded.world.playersRead = { ok: false, reason: "SCENE_NOT_LOADED" };
    unloaded.register(3);
    unloaded.world.now += SETTINGS.groupTtlMs;
    unloaded.fire();
    assert.strictEqual(unloaded.service.getStatus().groups, 0, "SCENE_NOT_LOADED = no players, the TTL still works");
  });

  test("BNG4 full registry, one failing group, refused input, stop", () => {
    const h = harness();
    for (const id of [1, 2, 3]) h.addShip(id);
    h.register(1);
    h.register(2);
    assert.strictEqual(h.service.canAccept(), true);
    h.register(3);
    assert.strictEqual(h.service.canAccept(), false);
    assert.deepStrictEqual(h.register(4), { ok: false, reason: "REGISTRY_FULL" });

    const fresh = harness();
    assert.deepStrictEqual(fresh.register(1, { entityIds: [] }), { ok: false, reason: "INVALID_INPUT" });
    fresh.addShip(1);
    fresh.register(1);
    assert.deepStrictEqual(fresh.register(1), { ok: false, reason: "DUPLICATE" });

    const failing = harness();
    failing.addShip(1);
    failing.addShip(2);
    failing.register(1);
    failing.register(2);
    failing.world.failGroup = 1;
    failing.world.players = [pilot(7)];
    failing.world.standing.set(7, -1);
    failing.fire();
    assert.deepStrictEqual(failing.world.orders, [{ entityId: 2, targetId: 700 }], "the other group goes on");
    assert.strictEqual(failing.world.counts["world.beltNavy.failed"], 1);
    assert.strictEqual(failing.service.getStatus().groups, 2, "the failing group stays");

    failing.service.stop();
    assert.strictEqual(failing.armed(), 0);
    assert.strictEqual(failing.service.canAccept(), false);
    assert.deepStrictEqual(failing.register(9), { ok: false, reason: "STOPPED" });
  });

  test("BNG6 a failed standing read is counted, the pilot is no target; startBeltNavy refuses a broken standing read", () => {
    const h = harness({ readStanding: () => ({ ok: false, reason: "SEAM_UNAVAILABLE" }) });
    h.addShip(1);
    h.world.players = [pilot(7)];
    h.register(1);
    assert.deepStrictEqual(h.world.orders, [], "unreadable standing = not hostile");
    assert.strictEqual(h.world.counts["world.beltNavy.failed"], 1, "the failed read is counted");

    const ok = () => ({ ok: true });
    const fn = () => ({});
    const adapter = { checkBeltNavyScene: ok, getBeltNavyScene: fn, checkHuntScene: ok, getHuntScene: fn,
      checkNpcSpawn: ok, getNpcSpawn: fn, readCharacterStanding: ok,
      checkStandingRead: () => ({ ok: false, reason: "peekCharacterRecord_missing" }) };
    const config = { world: { beltNavy: SETTINGS } };
    const deps = { config, adapter, clock: { now: () => 0 }, getStandings: () => null };
    assert.deepStrictEqual(startBeltNavy(deps), { ok: false, reason: "BELT_NAVY_SEAM_UNAVAILABLE",
      detail: "peekCharacterRecord_missing" }, "Refusal = no ctx.beltNavy, the vendor pirates stay");
    const { checkStandingRead: _drop, ...noCheck } = adapter;
    assert.deepStrictEqual(startBeltNavy({ ...deps, adapter: noCheck }), { ok: false,
      reason: "BELT_NAVY_SEAM_UNAVAILABLE", detail: "checkStandingRead" });
  });

  test("BNG7: a passive group is painted neutral at birth, hostile only while engaged", () => {
    const SOE = 500016;
    const paints = [];
    let answer = { ok: true, changed: 1, unchanged: 0, missing: 0, broadcast: true };
    const h = harness({ spawn: { despawn: () => ({ ok: true }), setRelation: (systemId, ids, relation) => {
      paints.push([systemId, ids, relation]);
      return answer;
    } } });
    h.addShip(1);
    h.addShip(2);
    h.world.players = [pilot(7)];
    h.world.standing.set(7, 0.05);
    assert.deepStrictEqual(h.service.registerGroup({ spawnSiteId: "soe", systemId: SYSTEM, factionId: SOE,
      entityIds: [1, 2], atMs: h.world.now }), { ok: true });
    assert.deepStrictEqual(paints, [[SYSTEM, [1, 2], "neutral"]], "the first pass paints at once: no red patrol");
    assert.deepStrictEqual(h.world.orders, [], "neutral standing: the patrol does not attack the miner");

    h.world.standing.set(7, -2);
    h.world.now += 5000;
    h.fire();
    assert.deepStrictEqual(paints[1], [SYSTEM, [1, 2], "hostile"], "a hostile pilot in range: red while it fights");
    for (const id of [1, 2]) h.world.ships.get(id).manualTargetId = 700;
    h.fire();
    assert.deepStrictEqual(paints[2], [SYSTEM, [1, 2], "hostile"], "targets kept, no order: still engaged");
    h.world.standing.set(7, 1);
    h.fire();
    assert.deepStrictEqual(paints[3], [SYSTEM, [1, 2], "neutral"], "targets released: neutral again");

    answer = { ok: false, reason: "SCENE_NOT_LOADED" };
    h.fire();
    assert.strictEqual(h.world.counts["world.beltNavy.failed"], undefined, "an unloaded scene is no failure");
    answer = { ok: false, reason: "SET_FAILED" };
    h.fire();
    assert.strictEqual(h.world.counts["world.beltNavy.failed"], 1, "a refused paint is counted");
    assert.strictEqual(h.armed(), 1, "the timer goes on");

    const old = harness();
    old.addShip(3);
    assert.deepStrictEqual(old.register(3), { ok: true }, "a facade without setRelation: the pass as before");
  });

  test("BNG5 config: defaults and clamps of the aggression and the charge", () => {
    const config = (env) => resolveConfig({ modDir: MOD_DIR, env }).config;
    const c = config({});
    const b = c.world.beltNavy;
    assert.deepStrictEqual([b.standingAggroEnabled, b.hostileBelowStanding, b.aggroRangeMeters, b.pollMs, b.maxGroups,
      b.maxGroupsPerPass, b.groupTtlMs], [true, 0, 150000, 5000, 64, 16, 1800000]);
    assert.deepStrictEqual([c.standings.navyPenaltyEnabled, c.standings.navyAttackRaw, c.standings.navyKillRaw,
      c.standings.navyAttackWindowMs], [true, 0.002, 0.005, 600000]);
    const clamped = config({ EVEJS_LNE_WORLD_BELT_NAVY_HOSTILE_BELOW_STANDING: "-20", EVEJS_LNE_WORLD_BELT_NAVY_POLL_MS: "1",
      EVEJS_LNE_STANDINGS_NAVY_KILL_RAW: "5" });
    assert.deepStrictEqual([clamped.world.beltNavy.hostileBelowStanding, clamped.world.beltNavy.pollMs,
      clamped.standings.navyKillRaw], [-10, 1000, 0.1]);
  });
};
