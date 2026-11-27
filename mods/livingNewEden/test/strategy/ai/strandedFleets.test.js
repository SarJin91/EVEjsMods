"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planStrandedFleets } = require("../../../lib/strategy/ai/strandedFleets");
const { decideReview } = require("../../../lib/strategy/ai");
const { reviewRowBound, RETIRE_ROWS } = require("../../../lib/strategy/reviewRows");
const { rowBoundsOfConfig } = require("../../../lib/strategy/reviewBound");
const { describeNote } = require("../../../lib/strategy/activity/notes");
const { resolveConfig } = require("../../../config");
const { createManualClock } = require("../../../lib/util/clock");
const { createRng } = require("../../../lib/util/rng");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");
const { harness: S } = require("./replenishReturn.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const STRANDED = Object.freeze({ idleMs: 12 * HOUR, disbandIdleMs: 2 * HOUR, maxPerReview: 2, returnMaxJumps: 30,
  maxBfsSystems: 4000, maxSearches: 4 });
const PARAMS = Object.freeze({ stranded: STRANDED, maxAssemblyJumps: 15, maxBfsSystems: 2000, returnWindowMs: 2 * HOUR,
  returnKindEnabled: true, production: Object.freeze({ mobilizeHulls: "required" }) });

function scene(fleets, o = {}) {
  const snapshot = { factionId: 7, at: AT, faction: { status: "ACTIVE" }, stationsMode: "ready",
    fleetsTruncated: false, operationsTruncated: false, theatre: o.theatre || [1], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 60),
    stations: [{ systemId: 24, stationId: "st24" }], production: { mode: "ready" }, doctrine: { hullsRequired: true },
    fleets };
  const supply = { reach: new Map((o.reach || [1]).map((id) => [id, 0])), captureReach: new Map(),
    stationSystems: [24] };
  return { snapshot, supply };
}

const fleet = (fleetId, systemId, idleMs, extra = {}) => ({ fleetId, version: 3, state: "IDLE", fleetRole: "invasion",
  systemId, refitPending: false, operationId: null, updatedAt: AT - idleMs, ...extra });

const plan = (fleets, o = {}, params = PARAMS) => {
  const { snapshot, supply } = scene(fleets, o);
  const used = new Set();
  return { ...planStrandedFleets(snapshot, supply, params, used), used };
};

module.exports = ({ test, skip }) => {
  test("T1 invasion fleet idle 13 h, 20 jumps from the only target, station 3 jumps further -> LAUNCH return "
    + "COMBAT_STRANDED to the station", () => {
    const r = plan([fleet("f1", 21, 13 * HOUR)]);
    assert.deepStrictEqual(r.intents, [{ type: "LAUNCH", kind: "return",
      target: { kind: "system", systemId: 24, ref: null }, originSystemId: 21,
      fleets: [{ fleetId: "f1", expectedVersion: 3 }], mobilize: [], dueAt: AT + 2 * HOUR,
      purpose: "COMBAT_STRANDED" }]);
    assert.deepStrictEqual(r.notes, ["STRANDED_RETURN"]);
    assert.ok(r.used.has("f1"));
    assert.deepStrictEqual(plan([fleet("f1", 21, 11 * HOUR)]).intents, []);
  });

  test("T2 the fleet in the station system idle 3 h -> DISBAND STRANDED with stationId and fleetRole; 1 h -> nothing",
    () => {
      const r = plan([fleet("f1", 24, 3 * HOUR)]);
      assert.deepStrictEqual(r.intents, [{ type: "DISBAND", fleetId: "f1", expectedVersion: 3, systemId: 24,
        stationId: "st24", reason: "STRANDED", returnHulls: true, fleetRole: "invasion" }]);
      assert.deepStrictEqual(r.notes, ["STRANDED_DISBAND"]);
      assert.deepStrictEqual([plan([fleet("f1", 24, 1 * HOUR)]).intents, plan([fleet("f1", 24, 1 * HOUR)]).notes],
        [[], []]);
    });

  test("T3 fleet 5 jumps from the target -> nothing; no targets -> only STRANDED_NO_TARGETS; zone over "
    + "strandedMaxBfsSystems -> only STRANDED_BFS_LIMIT", () => {
    const near = plan([fleet("f1", 6, 13 * HOUR)]);
    assert.deepStrictEqual([near.intents, near.notes], [[], []]);
    const empty = plan([fleet("f1", 21, 13 * HOUR)], { reach: [] });
    assert.deepStrictEqual([empty.intents, empty.notes], [[], ["STRANDED_NO_TARGETS"]]);
    const small = plan([fleet("f1", 21, 13 * HOUR)], {}, { ...PARAMS, stranded: { ...STRANDED, maxBfsSystems: 10 } });
    assert.deepStrictEqual([small.intents, small.notes], [[], ["STRANDED_BFS_LIMIT"]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  async function disbandRun(reopen, on) {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(47) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const holder = { fleetId: null, row: null, injected: false };
    const hooks = { beforeEffect: (d, snapshot) => {
      if (holder.injected || d.factionId !== R.AMARR || !d.intents.some((i) => i.type === "FACTION_TOUCH")) return d;
      const f = snapshot.fleets.find((x) => x.fleetId === holder.fleetId);
      if (!f) return d;
      holder.injected = true;
      return { ...d, intents: [{ type: "DISBAND", fleetId: f.fleetId, expectedVersion: f.version,
        systemId: holder.row.system_id, stationId: holder.row.station_id, reason: "STRANDED", returnHulls: true,
        fleetRole: "invasion" }, ...d.intents.filter((i) => i.type === "FACTION_TOUCH")] };
    } };
    const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_ENABLED: "0", EVEJS_LNE_STRATEGY_STRANDED_RETURN_ENABLED: on ? "1" : "0" },
    { hooks, production: true });
    holder.row = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", R.AMARR)[0];
    assert.ok(holder.row, "an Amarr station");
    const created = env.fleets.createFleet({ factionId: R.AMARR, currentSystemId: holder.row.system_id,
      homeSystemId: holder.row.system_id, fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 2 }] },
    "t4:stranded");
    assert.ok(created.ok, JSON.stringify(created));
    holder.fleetId = created.fleetId;
    const cruisers = () => (env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND "
      + "item_key = 'group:cruiser'", holder.row.station_id)[0] || { quantity: 0 }).quantity;
    const before = cruisers();
    await R.passesAt(env, shared, R.START_MS + R.I);
    const out = { injected: holder.injected, added: cruisers() - before,
      state: env.q("SELECT state FROM virtual_fleets WHERE fleet_id = ?", created.fleetId)[0].state,
      review: env.strategy.getStatus().ai.review };
    env.strategy.stop("test");
    env.production.stop("test");
    return out;
  }

  needsDriver("T4 real store: DISBAND STRANDED of an invasion fleet with the flag -> DESTROYED, hulls back to the "
    + "stock, stranded* counters (not logistics*); flag off -> DISBAND_ROLE_INVALID, nothing written", async () => {
    const on = await H.withStore(driver, (reopen) => disbandRun(reopen, true));
    const c = on.review.counters;
    assert.deepStrictEqual([on.injected, on.state, on.added], [true, "DESTROYED", 2], JSON.stringify(on.review));
    assert.deepStrictEqual([c.strandedDisbanded, c.strandedDisbandHulls, c.strandedDisbandHullsLost, c.strandedRefused,
      c.logisticsDisbanded, c.logisticsRetireRefused], [1, 2, 0, 0, 0, 0]);
    const off = await H.withStore(driver, (reopen) => disbandRun(reopen, false));
    const k = off.review.counters;
    assert.deepStrictEqual([off.injected, off.state, off.added, off.review.lastRefusal],
      [true, "IDLE", 0, "DISBAND:DISBAND_ROLE_INVALID"]);
    assert.deepStrictEqual([k.strandedDisbanded, k.strandedRefused, k.logisticsRetireRefused], [0, 1, 0]);
  });

  test("T5 flag off: decideReview identical with params.stranded null and without the key; with the flag the planner "
    + "runs (STRANDED_NO_TARGETS); config default false, review bound + maxStrandedPerReview x RETIRE_ROWS; notes known",
  () => {
    const s = S.snap({ fleets: [S.fleet("f1", 3, 10, { updatedAt: S.AT - 13 * HOUR })] });
    const bare = decideReview(s, S.PARAMS);
    assert.strictEqual(bare.outcome, "REVIEWED", JSON.stringify(bare.reason));
    assert.strictEqual(JSON.stringify(decideReview(s, { ...S.PARAMS, stranded: null })), JSON.stringify(bare));
    assert.ok(!bare.notes.some((n) => n.startsWith("STRANDED_")), JSON.stringify(bare.notes));
    const on = decideReview(s, { ...S.PARAMS, stranded: STRANDED });
    assert.ok(on.notes.includes("STRANDED_NO_TARGETS"), JSON.stringify(on.notes));
    assert.deepStrictEqual(on.intents, bare.intents);

    const def = resolveConfig({ modDir: MOD_DIR, env: {} });
    const st = def.config.strategy;
    assert.deepStrictEqual([st.strandedReturnEnabled, st.strandedIdleMs, st.strandedDisbandIdleMs,
      st.maxStrandedPerReview, st.strandedReturnMaxJumps, st.strandedMaxBfsSystems, st.strandedMaxSearchesPerReview],
    [false, 43200000, 7200000, 2, 30, 4000, 4]);
    const flagOn = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_STRATEGY_STRANDED_RETURN_ENABLED: "1" } });
    assert.strictEqual(rowBoundsOfConfig(flagOn.config).review - rowBoundsOfConfig(def.config).review,
      2 * RETIRE_ROWS);
    assert.strictEqual(reviewRowBound({ ...st, strandedReturnEnabled: true }) - reviewRowBound(st), 2 * RETIRE_ROWS);
    for (const n of ["STRANDED_RETURN", "STRANDED_DISBAND", "STRANDED_NO_BASE", "STRANDED_LIMIT",
      "STRANDED_NO_TARGETS", "STRANDED_BFS_LIMIT", "STRANDED_SEARCH_LIMIT", "STRANDED_NO_IDLE_SINCE"]) {
      assert.strictEqual(describeNote(n).known, true, n);
    }
  });

  test("T6: no own station system -> nothing, no note, no BFS", () => {
    const { snapshot, supply } = scene([fleet("f1", 21, 13 * HOUR)]);
    let calls = 0;
    const nb = snapshot.neighbors;
    snapshot.neighbors = (id) => {
      calls += 1;
      return nb(id);
    };
    const r = planStrandedFleets(snapshot, { ...supply, stationSystems: [] }, PARAMS, new Set());
    assert.deepStrictEqual([r, calls], [{ intents: [], notes: [] }, 0]);
  });
};
