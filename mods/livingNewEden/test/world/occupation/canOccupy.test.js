"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const S = require("../../../lib/world/occupation/schema");
const M = require("../../../lib/world/occupation/machine");
const { createOccupationService } = require("../../../lib/world/occupation/occupationService");
const { createHostility } = require("../../../lib/battle/data/hostility");
const { resolveConfig } = require("../../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const HOUR = 3600000;
const CONCORD = 500006;
const BLOOD = 500012;
const SERP = 500020;
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
  adjacencyGate: false, canOccupyGate: true });
const OFF = Object.freeze({ ...PARAMS, canOccupyGate: false });
const notConcord = (f) => f !== CONCORD;

function view(o = {}) {
  const range = new Set(o.range || [CONCORD, BLOOD, SERP]);
  const v = { systemId: SYS, state: o.state || S.OCCUPIED, controller: o.controller === undefined ? SERP : o.controller,
    occupier: o.occupier === undefined ? SERP : o.occupier, previousController: null, sinceAt: 0, seq: 4,
    evaluatedAt: null, capturedAt: 0, detachedSinceAt: null, home: null, coreOwner: null,
    influence: new Map(Object.entries(o.influence || { [SERP]: 60, [CONCORD]: 10 }).map(([f, score]) => [Number(f),
      { score, garrison: 0 }])),
    presence: new Map(Object.entries(o.presence || { [CONCORD]: 286 }).map(([f, strength]) => [Number(f), { strength,
      fleets: [{ fleetId: `fl:${f}`, version: 1, state: "IDLE", fleetRole: "patrol", refitPending: false }] }])),
    stations: new Map(), inRange: (f) => range.has(f), isHostile, presenceTruncated: false,
    at: o.at === undefined ? HOUR : o.at, rangeKnown: true };
  if (o.canOccupy !== undefined) v.canOccupy = o.canOccupy;
  return v;
}
const tick = { kind: "tick" };
const battle = (winnerFactionId, loserFactionId) => ({ kind: "battle", battleId: "b1", winnerFactionId, loserFactionId });
const brief = (e) => [e.to, e.statePatch.occupierFactionId, e.statePatch.controllerFactionId];

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

module.exports = ({ test }) => {
  test("CO1 reproduction: gate off / no view.canOccupy -> CONCORD (canOccupy false) interrupts a held system as "
    + "holder and as battle winner and its claim captures the system (today's behaviour)", () => {
    assert.ok(isHostile(CONCORD, SERP), "fixture: CONCORD hostile to the controller");
    for (const [p, v] of [[OFF, view({ canOccupy: notConcord })], [PARAMS, view()]]) {
      assert.deepStrictEqual(brief(M.evaluate(v, tick, p)), [S.CONTESTED, CONCORD, SERP], "B3 holder");
      assert.deepStrictEqual(brief(M.evaluate(v, battle(CONCORD, SERP), p)), [S.CONTESTED, CONCORD, SERP], "B2");
    }
    const contested = view({ state: S.CONTESTED, occupier: CONCORD, influence: { [CONCORD]: 40, [SERP]: 0 },
      canOccupy: notConcord });
    assert.deepStrictEqual(brief(M.evaluate(contested, tick, OFF)), [S.INVASION, CONCORD, SERP]);
    const invasion = view({ state: S.INVASION, occupier: CONCORD, influence: { [CONCORD]: 80, [SERP]: 0 },
      at: 7 * HOUR, canOccupy: notConcord });
    assert.deepStrictEqual(brief(M.evaluate(invasion, tick, OFF)), [S.OCCUPIED, CONCORD, CONCORD], "captured");
    const sig = M.applySignal(view({ state: S.STABLE, occupier: null, presence: {}, canOccupy: notConcord }),
      { factionId: CONCORD, signal: "INVASION" }, 0, OFF);
    assert.deepStrictEqual([sig.ok, sig.outcome], [true, "STARTED"]);
  });

  test("CO2 gate on: CONCORD never becomes the pretender (B2, B3, RECON battle), a legacy claim unwinds, a signal "
    + "is refused; a faction that can occupy keeps today's result", () => {
    const held = view({ canOccupy: notConcord });
    const h = M.evaluate(held, tick, PARAMS);
    assert.deepStrictEqual([...brief(h), h.notes.includes("CANNOT_OCCUPY"), h.notes.includes("INTERRUPTED")],
      [null, SERP, SERP, true, false]);
    const cons = M.evaluate(view({ state: S.CONSOLIDATING, canOccupy: notConcord }), tick, PARAMS);
    assert.deepStrictEqual([cons.to === S.CONTESTED, cons.statePatch.occupierFactionId], [false, SERP]);
    const b = M.evaluate(held, battle(CONCORD, SERP), PARAMS);
    assert.deepStrictEqual([...brief(b), b.notes.filter((n) => n === "CANNOT_OCCUPY").length], [null, SERP, SERP, 1]);
    const recon = M.evaluate(view({ state: S.RECON, occupier: CONCORD, canOccupy: notConcord }), battle(CONCORD, SERP),
      PARAMS);
    assert.deepStrictEqual([recon.to, recon.notes.includes("CANNOT_OCCUPY")], [null, true]);
    const c = M.evaluate(view({ state: S.CONTESTED, occupier: CONCORD, influence: { [CONCORD]: 40, [SERP]: 0 },
      canOccupy: notConcord }), tick, PARAMS);
    assert.deepStrictEqual([...brief(c), c.notes.includes("CANNOT_OCCUPY")], [S.STABLE, null, SERP, true]);
    const inv = M.evaluate(view({ state: S.INVASION, occupier: CONCORD, influence: { [CONCORD]: 80, [SERP]: 0 },
      at: 7 * HOUR, canOccupy: notConcord }), tick, PARAMS);
    assert.deepStrictEqual([...brief(inv), inv.notes.includes("CANNOT_OCCUPY")], [S.CONTESTED, CONCORD, SERP, true]);
    const sig = M.applySignal(view({ state: S.STABLE, occupier: null, presence: {}, canOccupy: notConcord }),
      { factionId: CONCORD, signal: "INVASION" }, 0, PARAMS);
    assert.deepStrictEqual([sig.ok, sig.reason], [false, "CANNOT_OCCUPY"]);
    const blood = view({ presence: { [BLOOD]: 286 }, influence: { [SERP]: 60, [BLOOD]: 10 }, canOccupy: notConcord });
    assert.deepStrictEqual(M.evaluate(blood, tick, PARAMS), M.evaluate(blood, tick, OFF));
    assert.deepStrictEqual(M.evaluate(blood, battle(BLOOD, SERP), PARAMS), M.evaluate(blood, battle(BLOOD, SERP), OFF));
    assert.deepStrictEqual(brief(M.evaluate(blood, tick, PARAMS)), [S.CONTESTED, BLOOD, SERP]);
    const thr = view({ canOccupy: () => { throw new Error("x"); } });
    assert.deepStrictEqual(brief(M.evaluate(thr, tick, PARAMS)), [S.CONTESTED, CONCORD, SERP]);
  });

  test("CO3 service: occupation.canOccupyGateEnabled default true, env 0 -> false; readView gets view.canOccupy "
    + "from deps.canOccupyOf (absent = pass, throw = pass)", () => {
    const svcOf = (config, extra = {}) => createOccupationService({ store: {}, repository: {}, fleets: {},
      scheduler: {}, clock: { now: () => 0 }, config, hostility: isHostile, powerTable: {}, ...extra });
    const def = configOf();
    assert.strictEqual(def.occupation.canOccupyGateEnabled, true);
    const off = configOf({ EVEJS_LNE_OCCUPATION_CAN_OCCUPY_GATE_ENABLED: "0" });
    assert.strictEqual(off.occupation.canOccupyGateEnabled, false);
    assert.deepStrictEqual([svcOf(def).params.canOccupyGate, svcOf(off).params.canOccupyGate], [true, false]);
    const sys = { systemId: SYS, occupationState: S.OCCUPIED, controllerFactionId: SERP, occupierFactionId: SERP,
      previousControllerFactionId: null, lastStateChangeAt: 0, phaseSeq: 1, influenceEvaluatedAt: null, capturedAt: 0,
      detachedSinceAt: null, homeFactionId: null, influence: [] };
    const deps = { repository: { getSystem: () => ({ ok: true, system: sys }) },
      fleets: { repository: { listFleetsInSystem: () => ({ ok: true, fleets: [] }) } },
      getStations: () => null };
    const viewOf = (extra) => {
      const r = svcOf(def, { ...deps, ...extra }).readView({}, SYS, HOUR);
      assert.strictEqual(r.ok, true);
      return r.view;
    };
    const v1 = viewOf({ canOccupyOf: notConcord });
    assert.deepStrictEqual([v1.canOccupy(CONCORD), v1.canOccupy(SERP)], [false, true]);
    assert.strictEqual(viewOf({}).canOccupy(CONCORD), true);
    assert.strictEqual(viewOf({ canOccupyOf: () => { throw new Error("x"); } }).canOccupy(CONCORD), true);
  });

  test("CO4 wiring: the occupation service definition hands canOccupyOf (doctrine.canOccupy of the registry, "
    + "strategy off = pass); compose passes the flag with :-1", () => {
    const { canOccupyOf } = require("../../../lib/runtime/services");
    const registry = { getFaction: (f) => (f === CONCORD ? { doctrineId: "police" } : (f === SERP ? { doctrineId: "pir" }
      : null)), getDoctrine: (id) => (id === "police" ? { canOccupy: false } : { canOccupy: true }) };
    const ctx = { strategy: { registry } };
    assert.deepStrictEqual([canOccupyOf(ctx, CONCORD), canOccupyOf(ctx, SERP), canOccupyOf(ctx, BLOOD),
      canOccupyOf({}, CONCORD)], [false, true, true, true]);
    const compose = fs.readFileSync(path.join(REPO_DIR, "compose.yaml"), "utf8");
    assert.ok(compose.includes("EVEJS_LNE_OCCUPATION_CAN_OCCUPY_GATE_ENABLED: "
      + "${EVEJS_LNE_OCCUPATION_CAN_OCCUPY_GATE_ENABLED:-1}"), "compose line");
  });
};
