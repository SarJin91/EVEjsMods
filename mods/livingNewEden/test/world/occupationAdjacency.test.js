"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const S = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const SOV = require("../../lib/world/sovStructures/schema");
const { anchoredOf } = require("../../lib/world/occupation/adjacency");
const { adjacentOwn } = require("../../lib/strategy/ai/targeting");
const { createOccupationService } = require("../../lib/world/occupation/occupationService");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { resolveConfig } = require("../../config");
const { harness: R } = require("./occupationRepel.test");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const HOUR = 3600000;
const BLOOD = 500012;
const SERP = 500020;
const AMARR = 500003;
const SANSHA = 500019;
const SYS = 30004596;
const isHostile = createHostility();

const PARAMS = Object.freeze({ evalIntervalMs: 900000, idleEvalIntervalMs: 7200000, maxActiveSystems: 64,
  reconTimeoutMs: 2 * HOUR, contestTimeoutMs: 6 * HOUR, invasionHoldMs: 6 * HOUR, occupiedSettleMs: 6 * HOUR,
  consolidateMs: 24 * HOUR, invasionMinScore: 30, occupyMinScore: 60, occupyMaxDefenderScore: 30, stableMinScore: 80,
  stableMaxResidualScore: 20, battleWinPoints: 20, battleLossPoints: 15, holdPointsPerHour: 10,
  stationPointsPerHour: 5, stationBonusCap: 3, decayPointsPerHour: 5, requireNoDefenderStations: true,
  garrisonFleetsTarget: 1, detachedUpkeepStep: 0.5, detachedUpkeepPeriodMs: 24 * HOUR, detachedUpkeepMaxFactor: 4,
  maxFactionsPerSystem: 8, stableBaselineScore: 60, stableRecoverPointsPerHour: 1, stableForeignDecayPointsPerHour: 1,
  stableForeignFloorScore: 0, garrisonFromRoles: Object.freeze(["invasion", "patrol", "scout", "reserve"]),
  adjacencyGate: true });
const OFF = Object.freeze({ ...PARAMS, adjacencyGate: false });

function view(o = {}) {
  const range = new Set(o.range || [BLOOD, SERP]);
  const v = { systemId: SYS, state: o.state || S.OCCUPIED, controller: o.controller === undefined ? SERP : o.controller,
    occupier: o.occupier === undefined ? SERP : o.occupier, previousController: null, sinceAt: 0, seq: 4,
    evaluatedAt: o.evaluatedAt === undefined ? null : o.evaluatedAt, capturedAt: o.capturedAt === undefined ? 0
      : o.capturedAt, detachedSinceAt: null, home: o.home === undefined ? null : o.home,
    coreOwner: o.coreOwner === undefined ? null : o.coreOwner,
    influence: new Map(Object.entries(o.influence || { [SERP]: 60, [BLOOD]: 10 }).map(([f, score]) => [Number(f),
      { score, garrison: 0 }])),
    presence: new Map(Object.entries(o.presence || { [BLOOD]: 286 }).map(([f, strength]) => [Number(f), { strength,
      fleets: [{ fleetId: `fl:${f}`, version: 1, state: "IDLE", fleetRole: "scout", refitPending: false }] }])),
    stations: new Map(), inRange: (f) => range.has(f), isHostile, presenceTruncated: false,
    at: o.at === undefined ? HOUR : o.at, rangeKnown: true };
  if (o.adjacent !== undefined) v.adjacent = o.adjacent;
  if (o.sov !== undefined) v.sov = o.sov;
  if (o.playerClaim !== undefined) v.playerClaim = o.playerClaim;
  return v;
}
const tick = { kind: "tick" };
const battle = (winnerFactionId, loserFactionId) => ({ kind: "battle", battleId: "b1", winnerFactionId, loserFactionId });
const no = () => false;
const sovE = (structures, extra = {}) => ({ needs: () => true, structures, siegeHoldMs: HOUR, pauseWhenObserved: true,
  observed: false, anchorMs: HOUR, adoptPending: false, earlyTimers: true, ...extra });
const struct = (factionId, state, extra = {}) => ({ structureId: `sovs:${SYS}:${factionId}:4:1`, factionId, state,
  version: 1, attackerFactionId: null, attackStartedAt: null, ...extra });

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("T1 bench bug: OCCUPIED / CONSOLIDATING without a controller fleet, a lone hostile fleet without an anchor "
    + "(tick, battle, RECON battle) -> no CONTESTED, occupier kept, CAPTURE_NOT_ADJACENT; gate off = bit for bit", () => {
    assert.ok(isHostile(BLOOD, SERP), "fixture: hostile factions");
    const occ = M.evaluate(view({ adjacent: no }), tick, PARAMS);
    assert.deepStrictEqual([occ.to, occ.statePatch.occupierFactionId, occ.notes.includes("CAPTURE_NOT_ADJACENT"),
      occ.notes.includes("INTERRUPTED")], [null, SERP, true, false]);
    const cons = M.evaluate(view({ state: S.CONSOLIDATING, adjacent: no }), tick, PARAMS);
    assert.deepStrictEqual([cons.to, cons.statePatch.occupierFactionId, cons.notes.includes("CAPTURE_NOT_ADJACENT")],
      [S.OCCUPIED, SERP, true]);
    const won = M.evaluate(view({ adjacent: no }), battle(BLOOD, SERP), PARAMS);
    assert.deepStrictEqual([won.to, won.statePatch.occupierFactionId,
      won.notes.filter((n) => n === "CAPTURE_NOT_ADJACENT").length], [null, SERP, 1]);
    const recon = M.evaluate(view({ state: S.RECON, occupier: BLOOD, adjacent: no }), battle(BLOOD, SERP), PARAMS);
    assert.deepStrictEqual([recon.to, recon.notes.includes("CAPTURE_NOT_ADJACENT")], [null, true]);
    const today = M.evaluate(view(), tick, PARAMS);
    assert.deepStrictEqual(M.evaluate(view({ adjacent: no }), tick, OFF), today);
    assert.deepStrictEqual([today.to, today.statePatch.occupierFactionId, today.notes.includes("INTERRUPTED")],
      [S.CONTESTED, BLOOD, true]);
    assert.deepStrictEqual(M.evaluate(view({ adjacent: no }), battle(BLOOD, SERP), OFF),
      M.evaluate(view(), battle(BLOOD, SERP), PARAMS));
  });

  test("T2 unwind: CONTESTED without an anchor -> STABLE; INVASION with the hold over -> CONTESTED, only END "
    + "CLAIM_LOST (P) + LIFT (C) and P_LIFT, no ANCHOR / ATTACK / BIND / DESTROY", () => {
    const c = M.evaluate(view({ state: S.CONTESTED, occupier: BLOOD, influence: { [BLOOD]: 80 }, adjacent: no }), tick,
      PARAMS);
    assert.deepStrictEqual([c.to, c.statePatch.occupierFactionId, c.notes.includes("CAPTURE_NOT_ADJACENT")],
      [S.STABLE, null, true]);
    const pS = struct(BLOOD, SOV.ANCHORING);
    const cS = struct(SERP, SOV.ONLINE, { structureId: `sovs:${SYS}:${SERP}:1:1`, attackerFactionId: BLOOD,
      attackStartedAt: 0, version: 2 });
    const claim = { claimId: "pc:1", state: "SIEGED", version: 3, attackerFactionId: BLOOD, attackStartedAt: 0,
      ownerOnline: true };
    const inv = M.evaluate(view({ state: S.INVASION, occupier: BLOOD, influence: { [BLOOD]: 80, [SERP]: 0 },
      presence: { [BLOOD]: 100 }, at: 7 * HOUR, capturedAt: 0, sov: sovE([pS, cS]), playerClaim: claim, adjacent: no }),
    tick, PARAMS);
    assert.deepStrictEqual({ to: inv.to, occupier: inv.statePatch.occupierFactionId, sovOps: inv.sovOps,
      playerOps: inv.playerOps, note: inv.notes.includes("CAPTURE_NOT_ADJACENT") }, {
      to: S.CONTESTED, occupier: BLOOD, note: true,
      sovOps: [{ op: "END", structureId: pS.structureId, reason: "CLAIM_LOST", byFactionId: null },
        { op: "LIFT", structureId: cS.structureId, version: 2 }],
      playerOps: [{ op: "P_LIFT", claimId: "pc:1", version: 3 }] });
  });

  test("T3 unknown anchor = wait (no transition, no ops, ADJACENCY_UNKNOWN); home reclaim and core owner pass; "
    + "anchored -> sovEarly ANCHOR as SOVE1", () => {
    const base = { state: S.INVASION, occupier: BLOOD, influence: { [BLOOD]: 80, [SERP]: 0 }, presence: { [BLOOD]: 100 },
      at: 7 * HOUR };
    const unk = M.evaluate(view({ ...base, sov: sovE([]), playerClaim: null, adjacent: () => null }), tick, PARAMS);
    assert.deepStrictEqual([unk.to, unk.sovOps, unk.playerOps, unk.notes.includes("ADJACENCY_UNKNOWN")],
      [null, [], [], true]);
    const home = M.evaluate(view({ ...base, home: BLOOD, adjacent: no }), tick, PARAMS);
    assert.deepStrictEqual([home.to, home.statePatch.controllerFactionId, home.notes.includes("HOME_RECLAIMED")],
      [S.OCCUPIED, BLOOD, true]);
    const core = M.evaluate(view({ coreOwner: BLOOD, adjacent: no }), tick, PARAMS);
    assert.deepStrictEqual([core.to, core.statePatch.occupierFactionId], [S.CONTESTED, BLOOD]);
    const early = M.evaluate(view({ ...base, controller: null, at: 3 * HOUR, capturedAt: null, sov: sovE([]),
      adjacent: () => true }), tick, PARAMS);
    assert.deepStrictEqual([early.to, early.sovOps], [null, [{ op: "ANCHOR", factionId: BLOOD, claimSeq: 4 }]]);
  });

  test("T4a anchoredOf K1-K4, false, null; parity with targeting.adjacentOwn (K1, K3 neighbour, K4, none)", () => {
    const F = BLOOD;
    const nb = [2, 3];
    const empty = { systemId: 1, neighbours: nb, controllers: new Map(), stationFactions: new Map(),
      footholds: { ok: true, reach: new Set() }, belt: { ok: true, mode: "off" }, factionId: F };
    const snap = (o) => ({ factionId: F, systems: o.systems || [], capturedIds: [], footholds: o.footholds || [],
      neighbors: (id) => (id === 1 ? nb : []) });
    const cases = {
      k1: [{ ...empty, controllers: new Map([[2, F]]) }, snap({ systems: [{ systemId: 2, controllerFactionId: F }] }), {}],
      k2: [{ ...empty, stationFactions: new Map([[1, new Set([F])]]) }, null, null],
      k3: [{ ...empty, footholds: { ok: true, reach: new Set([1]) } }, snap({ footholds: [{ systemId: 3 }] }), {}],
      k4: [{ ...empty, belt: { ok: true, mode: "ready", reach: new Map([[1, 1]]) } }, snap({}),
        { border: new Map([[1, 1]]) }],
      none: [empty, snap({}), {}],
    };
    const got = {};
    const parity = {};
    for (const [k, [input, s, supply]] of Object.entries(cases)) {
      got[k] = anchoredOf(input);
      if (s) parity[k] = adjacentOwn(s, supply, 1);
    }
    assert.deepStrictEqual(got, { k1: true, k2: true, k3: true, k4: true, none: false });
    assert.deepStrictEqual(parity, { k1: true, k3: true, k4: true, none: false });
    assert.strictEqual(anchoredOf({ ...empty, belt: { ok: false } }), null);
    assert.strictEqual(anchoredOf({ ...empty, footholds: { ok: false } }), null);
    assert.strictEqual(anchoredOf({ ...empty, controllers: null }), null);
    assert.strictEqual(anchoredOf({ ...empty, controllers: null, stationFactions: new Map([[3, new Set([F])]]) }), true);
  });

  needsDriver("T4b service: readView({adjacency}) K1 / K3 (foothold 2 jumps, jumps 3) / none / refused foothold or "
    + "belt -> true / false / null; the bench case through the handler stays OCCUPIED (adjacencyBlocked 1); gate off "
    + "-> CONTESTED", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = R.bootRepel(reopen(), shared);
    const sys = H.S.N5;
    const seed = env.tx((db) => env.repo.applyChange(db, { systemId: sys, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: AMARR },
      influence: [{ factionId: AMARR, influenceScore: 60 }, { factionId: SANSHA, influenceScore: 10 }] },
    `world:seed:v1:${sys}`));
    assert.ok(seed.ok, JSON.stringify(seed));
    const occ = env.tx((db) => env.repo.applyChange(db, { systemId: sys, expectedVersion: 1, reason: "OCCUPATION_PHASE",
      state: { occupationState: S.OCCUPIED, occupierFactionId: AMARR, phaseSeq: 2, capturedAt: shared.clock.now() } },
    "t4b:occupied"));
    assert.ok(occ.ok, JSON.stringify(occ));
    assert.ok(env.fleets.createFleet({ factionId: SANSHA, currentSystemId: sys, homeSystemId: H.S.N0,
      fleetRole: "scout", composition: [{ hullGroup: "cruiser", count: 4 }] }, "t4b:fleet").ok);
    const fh = { r: { ok: true, footholds: [] } };
    const belt = { r: null };
    const stationsOf = { s: null };
    const svcOf = (config) => createOccupationService({ store: env.store, journal: env.journal, repository: env.repo,
      fleets: env.fleets, scheduler: env.scheduler, clock: shared.clock, config, hostility: isHostile,
      powerTable: buildPowerTable(expandStrengthGroups(GROUPS)), getStations: () => stationsOf.s,
      graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, footholdsOf: () => fh.r,
      getCaptureBelt: () => belt.r || { ok: true, mode: "off" } });
    const svc = svcOf(env.config);
    const adjOf = () => env.tx((db) => {
      const r = svc.readView(db, sys, shared.clock.now(), [], undefined, { adjacency: true });
      assert.ok(r.ok, JSON.stringify(r));
      return r.view.adjacent(SANSHA);
    });
    const seen = { none: adjOf() };
    fh.r = { ok: true, footholds: [{ systemId: H.S.N7, jumps: 3 }] };
    seen.k3 = adjOf();
    fh.r = { ok: true, footholds: [{ systemId: H.S.N7, jumps: 1 }] };
    seen.k3short = adjOf();
    fh.r = { ok: false, reason: "X" };
    seen.fhRefused = adjOf();
    fh.r = { ok: true, footholds: [] };
    belt.r = { ok: false, reason: "STRATEGY_UNAVAILABLE" };
    seen.beltRefused = adjOf();
    belt.r = null;
    assert.deepStrictEqual(seen, { none: false, k3: true, k3short: false, fhRefused: null, beltRefused: null });
    const noField = env.tx((db) => svc.readView(db, sys, shared.clock.now(), [], undefined, { sov: true }));
    assert.strictEqual(noField.view.adjacent, undefined, "without opts.adjacency there is no field");

    const run = (service, key) => {
      const res = service.handler({ payload: { systemId: sys, seq: 2, trigger: "tick" }, idempotencyKey: key },
        { now: shared.clock.now() });
      assert.ok(res.ok, JSON.stringify(res));
      const e = env.tx((db) => res.effect(db));
      assert.ok(e && e.ok, JSON.stringify(e));
      res.onCommitted();
      return R.systemOf(env, sys);
    };
    const kept = run(svc, "t4b:eval:1");
    assert.deepStrictEqual([kept.occupationState, kept.occupierFactionId, kept.phaseSeq], [S.OCCUPIED, AMARR, 2]);
    assert.strictEqual(svc.getStatus().counters.adjacencyBlocked, 1);
    const stationRepo = createStationRepository({ journal: env.journal, isKnownFaction: () => true,
      hullGroups: HULL_GROUPS, limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64,
        maxStations: 2000, maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
    const station = (stationId, systemId) => env.tx((db) => stationRepo.createStation(db, { stationId,
      kind: "upwell", structureFamily: "astrahus", systemId, ownerFactionId: SANSHA, ownerCorporationId: 1000019,
      origin: "seed", at: shared.clock.now() }, `t4b:${stationId}`));
    stationsOf.s = { getMode: () => "ready", repository: stationRepo };
    assert.ok(station("upw-t4b-n7", H.S.N7).ok);
    const k2 = { far: adjOf() };
    assert.ok(station("upw-t4b-n0", H.S.N0).ok);
    k2.near = adjOf();
    stationsOf.s = null;
    assert.deepStrictEqual(k2, { far: false, near: true });
    belt.r = { ok: true, mode: "ready", reach: new Map([[H.S.N7, 1]]) };
    const k4 = { far: adjOf() };
    belt.r = { ok: true, mode: "ready", reach: new Map([[H.S.N6, 1]]) };
    k4.near = adjOf();
    belt.r = null;
    assert.deepStrictEqual(k4, { far: false, near: true });
    assert.strictEqual(adjOf(), false, "stations off and no belt -> no anchor again");
    assert.ok(env.tx((db) => env.repo.applyChange(db, { systemId: H.S.N6, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: SANSHA }, influence: [] }, "t4b:n6")).ok);
    assert.strictEqual(adjOf(), true);
    const off = svcOf(configOf({ EVEJS_LNE_OCCUPATION_ADJACENCY_GATE_ENABLED: "0" }));
    const moved = run(off, "t4b:eval:2");
    assert.deepStrictEqual([moved.occupationState, moved.occupierFactionId], [S.CONTESTED, SANSHA]);
  }));

  test("T5 config: occupation.adjacencyGateEnabled default true, env 0 -> false; the effective gate needs "
    + "strategy.captureRequiresAdjacency; compose passes the flag with :-1", () => {
    const paramsOf = (config) => createOccupationService({ store: {}, repository: {}, fleets: {}, scheduler: {},
      clock: { now: () => 0 }, config, hostility: isHostile, powerTable: {} }).params.adjacencyGate;
    const def = configOf();
    assert.strictEqual(def.occupation.adjacencyGateEnabled, true);
    assert.strictEqual(configOf({ EVEJS_LNE_OCCUPATION_ADJACENCY_GATE_ENABLED: "0" }).occupation.adjacencyGateEnabled,
      false);
    assert.deepStrictEqual([paramsOf(def), paramsOf(configOf({ EVEJS_LNE_OCCUPATION_ADJACENCY_GATE_ENABLED: "0" })),
      paramsOf(configOf({ EVEJS_LNE_STRATEGY_CAPTURE_REQUIRES_ADJACENCY: "0" }))], [true, false, false]);
    const compose = fs.readFileSync(path.join(REPO_DIR, "compose.yaml"), "utf8");
    assert.ok(compose.includes("EVEJS_LNE_OCCUPATION_ADJACENCY_GATE_ENABLED: "
      + "${EVEJS_LNE_OCCUPATION_ADJACENCY_GATE_ENABLED:-1}"), "compose line");
  });
};
