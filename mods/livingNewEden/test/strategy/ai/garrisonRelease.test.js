"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planGarrisonRelease, planGarrisonReinforce, interiorPostsOf } = require("../../../lib/strategy/ai/garrison");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { GARRISON_RELEASE_ROWS, reviewRowBound } = require("../../../lib/strategy/reviewRows");
const { resolveConfig } = require("../../../config");
const { createManualClock } = require("../../../lib/util/clock");
const { createRng } = require("../../../lib/util/rng");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const SANSHA = 500019;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const TEMPLATE = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);

const PARAMS = Object.freeze({ maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, intelTtlMs: 6 * HOUR, kinds: kinds.list, powerTable: POWER,
  garrison: { maxPerReview: 3 }, garrisonRelease: { maxPerReview: 2, fleetsTarget: 1 } });

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const posts = o.posts || [21, 22, 23, 25];
  return { factionId: F, round: 3, at: AT, seed: 11, faction: { status: o.status || "ACTIVE", homeSystemId: 20 },
    doctrine: { doctrineId: "gr", canOccupy: true, buildsStations: o.buildsStations !== false,
      operationTypes: o.operationTypes || ["invasion", "reinforce", "recon"], templates: { garrison: TEMPLATE } },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 19 && x <= 26),
    systems: [row(19, F), row(20, F), ...posts.map((id) => row(id, F)), row(24, null), row(26, HOSTILE)],
    stations: [{ systemId: 20, stationId: "st20" }], fleets: o.fleets || [], fleetsTruncated: o.fleetsTruncated === true,
    operations: [], operationsTruncated: o.operationsTruncated === true, intel: o.intel || [], sightings: [],
    capturedIds: posts, territory: posts.map((systemId) => ({ systemId, detachedSinceAt: null })),
    territoryTruncated: o.territoryTruncated === true };
}

const full = (fleetId, systemId, extra = {}) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "garrison", systemId,
  refitPending: false, shipCount: 6, strength: strengthOf(TEMPLATE, POWER), operationId: null, legSeq: 0, ...extra });
const release = (s, o = {}) => planGarrisonRelease({ snapshot: s, params: { ...PARAMS, ...(o.params || {}) },
  used: o.used || new Set(), combatRoom: o.combatRoom === undefined ? 8 : o.combatRoom, dispatched: o.dispatched });
const ids = (r) => r.intents.map((i) => [i.fleetId, i.systemId, i.to]);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("GR1 interiorPostsOf: all neighbours own -> interior; a free / unknown neighbour or a hot system -> border", () => {
    assert.deepStrictEqual([...interiorPostsOf(snap(), PARAMS)].sort(), [21, 22]);
    const hotNeighbour = snap({ intel: [{ systemId: 22, observedAt: AT - HOUR, hostileFleets: 1, hostileStrength: 5 }] });
    assert.deepStrictEqual([...interiorPostsOf(hotNeighbour, PARAMS)], [], "22 is hot: neither 22 nor its neighbour 21");
    const unknown = snap();
    unknown.systems = unknown.systems.filter((s) => s.systemId !== 20);
    assert.deepStrictEqual([...interiorPostsOf(unknown, PARAMS)], [22], "21 borders the unknown row 20");
  });

  test("GR2 planGarrisonRelease: interior -> intent by fleetId, free neighbour -> nothing, surplus on a border post, "
    + "the rest must hold the template, combatRoom 0 -> GARRISON_RELEASE_CAP, flag off / limits / gates", () => {
    const interior = release(snap({ fleets: [full("g22", 22), full("g21", 21)] }));
    assert.deepStrictEqual(ids(interior), [["g21", 21, "invasion"], ["g22", 22, "invasion"]]);
    assert.deepStrictEqual(interior.notes, ["GARRISON_RELEASE:21", "GARRISON_RELEASE:22"]);
    assert.deepStrictEqual([interior.intents[0].type, interior.intents[0].expectedVersion], ["GARRISON_RELEASE", 2]);

    assert.deepStrictEqual(release(snap({ fleets: [full("g23", 23)] })), { intents: [], notes: [] }, "23 borders 24");
    assert.deepStrictEqual(ids(release(snap({ fleets: [full("a", 23), full("b", 23)] }))), [["a", 23, "invasion"]],
      "surplus over fleetsTarget 1");
    const weak = full("b", 23, { strength: 1 });
    assert.deepStrictEqual(ids(release(snap({ fleets: [full("a", 23, { strength: 1 }), weak] }))), [],
      "the rest would be weak: planGarrisonReinforce would mobilize again");

    const used = new Set();
    release(snap({ fleets: [full("g21", 21)] }), { used });
    assert.ok(used.has("g21"), "the fleet joins used (planPatrols comes next)");
    const busy = [full("g21", 21, { state: "TRAVELLING" }), full("g22", 22, { refitPending: true }),
      full("g22b", 22, { operationId: "o1" })];
    assert.deepStrictEqual(release(snap({ fleets: busy })).intents, []);
    assert.deepStrictEqual(ids(release(snap({ fleets: [full("g21", 21), full("g22", 22)] }),
      { used: new Set(["g21"]) })), [["g22", 22, "invasion"]]);

    const three = [full("g21", 21), full("g22", 22), full("h22", 22)];
    assert.strictEqual(release(snap({ fleets: three })).intents.length, 2, "maxPerReview");
    assert.strictEqual(release(snap({ fleets: three }), { combatRoom: 1 }).intents.length, 1, "Room");
    assert.deepStrictEqual(release(snap({ fleets: three }), { combatRoom: 0 }),
      { intents: [], notes: ["GARRISON_RELEASE_CAP"] });
    const fleets = [full("g21", 21)];
    assert.deepStrictEqual(release(snap({ fleets }), { params: { garrisonRelease: null } }), { intents: [], notes: [] });
    assert.deepStrictEqual(release(snap({ fleets, buildsStations: false })), { intents: [], notes: [] });
    assert.deepStrictEqual(release(snap({ fleets, operationTypes: ["recon"] })), { intents: [], notes: [] });
    for (const o of [{ status: "AT_WAR_NOT" }, { fleetsTruncated: true }, { operationsTruncated: true },
      { territoryTruncated: true }]) {
      assert.deepStrictEqual(release(snap({ fleets, ...o })), { intents: [], notes: ["GARRISON_SKIPPED"] },
        JSON.stringify(o));
    }
  });

  test("GR3 planGarrisonReinforce with the release on: an interior post is not weak; after the loss of a neighbour it "
    + "is on the list again; with the release off as before", () => {
    const plan = (s, params) => planGarrisonReinforce({ snapshot: s, supply: { stationSystems: [20] }, params, ledger: null,
      slots: { operations: 3, mobilizations: 3 }, budget: { resourceUnits: 1e6, reserveUnits: 1e6 } })
      .intents.map((i) => i.target.systemId).sort();
    const P = { ...PARAMS, kinds: kinds.list };
    const heldBorder = [full("g23", 23), full("g25", 25)];
    assert.deepStrictEqual(plan(snap({ fleets: heldBorder, operationTypes: ["reinforce"] }), P), []);
    assert.deepStrictEqual(plan(snap({ fleets: heldBorder, operationTypes: ["reinforce"] }),
      { ...P, garrisonRelease: null }), [21, 22]);
    const lost = snap({ fleets: heldBorder, operationTypes: ["reinforce"] });
    lost.systems = lost.systems.map((s) => (s.systemId === 23 ? { ...s, controllerFactionId: null } : s));
    lost.capturedIds = [21, 22, 25];
    assert.deepStrictEqual(plan(lost, P), [22], "22 lost its neighbour 23: border again");
  });

  needsDriver("GR4 GARRISON_RELEASE on a real store: the role changes, the replayed effect writes nothing, the next "
    + "round does not release twice; a version conflict refuses one intent and keeps the other", () => H.withStore(driver,
    async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map(R.THEATRE.map((id) => [id, SANSHA]));
      const captured = new Map();
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(61) }), graph: R.graphOf(), controllers };
      const holder = { mark: false, effect: null, stale: null };
      const hooks = { beforeEffect: (d) => {
        if (!(d.factionId === SANSHA && (d.intents || []).some((i) => i.type === "GARRISON_RELEASE"))) return d;
        if (!holder.effect) holder.mark = true;
        const intents = d.intents.map((i) => (i.type === "GARRISON_RELEASE" && i.fleetId === holder.stale
          ? { ...i, expectedVersion: i.expectedVersion + 5 } : i));
        return { ...d, intents };
      } };
      const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type,
        (ev, hctx) => {
          const r = h(ev, hctx);
          if (r && r.effect && holder.mark) {
            holder.mark = false;
            holder.effect = r.effect;
          }
          return r;
        }, o) });
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
        EVEJS_LNE_STRATEGY_PATROL_ENABLED: "0", EVEJS_LNE_STRATEGY_MERGE_ENABLED: "0",
        EVEJS_LNE_STRATEGY_MAX_OPERATIONS_PER_REVIEW: "0" },
      { hooks, wrapScheduler, world: R.upkeepWorld(controllers, captured) });
      const base = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
        + "ORDER BY station_id", SANSHA)[0];
      assert.ok(base, "a Sansha station");
      const posts = shared.graph.getNeighbors(base.system_id).filter((id) => controllers.get(id) === SANSHA);
      assert.ok(posts.length >= 1, "a post next to the station");
      const post = posts[0];
      for (const nb of shared.graph.getNeighbors(post)) controllers.set(nb, SANSHA);
      captured.set(post, null);
      const mk = (key) => {
        const r = e.fleets.createFleet({ factionId: SANSHA, currentSystemId: post, homeSystemId: base.system_id,
          fleetRole: "garrison", composition: [{ hullGroup: "frigate", count: 1 }] }, key);
        assert.ok(r.ok, JSON.stringify(r));
        return r.fleetId;
      };
      const a = mk("gr4:a");
      const b = mk("gr4:b");
      const role = (id) => e.q("SELECT fleet_role AS r, version AS v FROM virtual_fleets WHERE fleet_id = ?", id)[0];
      holder.stale = a < b ? a : b;
      const [first, second] = a < b ? [a, b] : [b, a];
      await R.passesAt(e, shared, R.START_MS + R.I);
      assert.ok(typeof holder.effect === "function", "the release was planned");
      assert.deepStrictEqual([role(first).r, role(second).r], ["garrison", "invasion"]);
      const c1 = e.strategy.getStatus().ai.review.counters;
      assert.deepStrictEqual([c1.garrisonReleased, c1.garrisonReleaseRefused], [1, 1], JSON.stringify(c1));
      const keys = e.q("SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key LIKE ?",
        `strategy:review:${SANSHA}:%:GARRISON_RELEASE%`).map((x) => x.k);
      assert.ok(keys.some((k) => k.endsWith(":role")), JSON.stringify(keys));
      const rows = () => e.q("SELECT (SELECT count(*) FROM world_event_journal) AS j, (SELECT group_concat(version) "
        + "FROM virtual_fleets WHERE fleet_id IN (?, ?)) AS v", first, second)[0];
      const before = rows();
      const replay = e.tx((db) => holder.effect(db));
      assert.ok(replay.ok && replay.applied.GARRISON_RELEASE === undefined, JSON.stringify(replay));
      assert.deepStrictEqual(rows(), before, "duplicate: no write");
      holder.stale = null;
      await R.passesAt(e, shared, R.START_MS + 2 * R.I);
      assert.deepStrictEqual([role(first).r, role(second).r], ["invasion", "invasion"]);
      const c2 = e.strategy.getStatus().ai.review.counters;
      assert.strictEqual(c2.garrisonReleased, 2, "the refused fleet goes in the next round, the other not twice");
      e.strategy.stop("test");
    }));

  test("GR5 config and rows: defaults (on, 2), clamp 0..16, GARRISON_RELEASE_ROWS 3 = wrapper + reassignRole (journal + "
    + "fleet row), the bound counts them only with the flag", () => {
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env });
    const S = resolve({}).config.strategy;
    assert.deepStrictEqual([S.garrisonReleaseEnabled, S.maxGarrisonReleasesPerReview, GARRISON_RELEASE_ROWS], [true, 2, 3]);
    assert.strictEqual(resolve({ EVEJS_LNE_STRATEGY_MAX_GARRISON_RELEASES_PER_REVIEW: "99" }).config.strategy
      .maxGarrisonReleasesPerReview, 16);
    const base = { maxObservationsPerReview: 0, maxHousekeepingPerReview: 0, maxRefitRequestsPerReview: 0,
      maxOperationsPerReview: 0, maxMobilizationsPerReview: 0, maxFleetsPerOperation: 0 };
    const on = reviewRowBound({ ...base, garrisonReleaseEnabled: true, maxGarrisonReleasesPerReview: 2 });
    const off = reviewRowBound({ ...base, garrisonReleaseEnabled: false, maxGarrisonReleasesPerReview: 2 });
    assert.strictEqual(on - off, 2 * GARRISON_RELEASE_ROWS);
    assert.ok(resolve({ EVEJS_LNE_STRATEGY_GARRISON_RELEASE_ENABLED: "0" }).warnings.length === 0);
  });
};
