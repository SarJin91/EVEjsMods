"use strict";

const assert = require("node:assert");

const S = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const { createHostility } = require("../../lib/battle/data/hostility");

const AMARR = 500003;
const SANSHA = 500019;
const SERPENTIS = 500020;
const SYS_CORE = 30001868;
const SYS_NON_CORE = 30002000;
const H = 3600000;
const isHostile = createHostility();

const PARAMS = Object.freeze({ evalIntervalMs: 900000, idleEvalIntervalMs: 7200000, maxActiveSystems: 64,
  reconTimeoutMs: 2 * H, contestTimeoutMs: 6 * H, invasionHoldMs: 6 * H, occupiedSettleMs: 6 * H,
  consolidateMs: 24 * H, invasionMinScore: 30, occupyMinScore: 60, occupyMaxDefenderScore: 30, stableMinScore: 80,
  stableMaxResidualScore: 20, battleWinPoints: 20, battleLossPoints: 15, holdPointsPerHour: 10,
  stationPointsPerHour: 5, stationBonusCap: 3, decayPointsPerHour: 5, requireNoDefenderStations: true,
  garrisonFleetsTarget: 2, detachedUpkeepStep: 0.5, detachedUpkeepPeriodMs: 24 * H, detachedUpkeepMaxFactor: 4,
  maxFactionsPerSystem: 8, stableBaselineScore: 60, stableRecoverPointsPerHour: 1, stableForeignDecayPointsPerHour: 1,
  stableForeignFloorScore: 0, garrisonFromRoles: Object.freeze(["invasion", "patrol", "scout", "reserve"]) });

const fleet = (fleetId, extra = {}) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "invasion",
  refitPending: false, ...extra });

function view(o = {}) {
  const rangeArr = Array.isArray(o.range) ? o.range : [];
  const range = new Set(rangeArr);
  return {
    systemId: o.systemId || SYS_NON_CORE,
    state: o.state || S.STABLE,
    controller: o.controller === undefined ? SANSHA : o.controller,
    occupier: o.occupier === undefined ? null : o.occupier,
    previousController: o.previousController || null,
    sinceAt: o.sinceAt || 0,
    seq: o.seq || 0,
    evaluatedAt: o.evaluatedAt === undefined ? null : o.evaluatedAt,
    capturedAt: o.capturedAt === undefined ? null : o.capturedAt,
    detachedSinceAt: o.detachedSinceAt === undefined ? null : o.detachedSinceAt,
    home: o.home === undefined ? null : o.home,
    coreOwner: o.coreOwner === undefined ? null : o.coreOwner,
    influence: new Map(Object.entries(o.influence || {}).map(([f, score]) => [Number(f), { score, garrison: 0 }])),
    presence: new Map(Object.entries(o.presence || {}).map(([f, strength]) => [Number(f),
      { strength, fleets: (o.fleets && o.fleets[f]) || [] }])),
    stations: new Map(Object.entries(o.stations || {}).map(([f, n]) => [Number(f), n])),
    inRange: (f) => range.has(f),
    isHostile,
    presenceTruncated: false,
    at: o.at === undefined ? 0 : o.at,
    consolidates: o.consolidates,
    rangeKnown: o.rangeKnown !== false,
  };
}

function stateOf(v, ev) {
  return {
    state: ev.statePatch.occupationState || v.state,
    controller: ev.statePatch.controllerFactionId === undefined ? v.controller : ev.statePatch.controllerFactionId,
    occupier: ev.statePatch.occupierFactionId === undefined ? v.occupier : ev.statePatch.occupierFactionId,
    capturedAt: ev.statePatch.capturedAt === undefined ? v.capturedAt : ev.statePatch.capturedAt,
    detachedSinceAt: ev.statePatch.detachedSinceAt === undefined ? v.detachedSinceAt : ev.statePatch.detachedSinceAt,
  };
}

function expectEdge(v, ev, to, extra = {}) {
  assert.strictEqual(ev.to, to, JSON.stringify(ev));
  assert.ok(M.canTransition(v.state, to), `${v.state}->${to}`);
  const s = stateOf(v, ev);
  assert.strictEqual(M.checkInvariants(s), null, JSON.stringify(s));
  assert.strictEqual(ev.statePatch.phaseSeq, v.seq + 1);
  for (const [k, value] of Object.entries(extra)) assert.deepStrictEqual(s[k], value, k);
  return s;
}

const tick = { kind: "tick" };
const battle = (winnerFactionId, loserFactionId) => ({ kind: "battle", battleId: "b1", winnerFactionId, loserFactionId });

module.exports = ({ test }) => {
  test("K2a G1: signal from foreign faction on core -> CORE_PROTECTED; owner K on core with controller X -> STARTED", () => {
    const coreView = view({
      systemId: SYS_CORE,
      state: S.STABLE,
      controller: AMARR,
      coreOwner: SANSHA,
      range: [AMARR, SERPENTIS, SANSHA],
      at: 1000,
    });

    const s1 = M.applySignal(coreView, { factionId: SERPENTIS, signal: "INVASION" }, 0, PARAMS);
    assert.deepStrictEqual(s1, { ok: false, reason: "CORE_PROTECTED" });

    const s2 = M.applySignal(coreView, { factionId: SANSHA, signal: "INVASION" }, 0, PARAMS);
    assert.strictEqual(s2.ok, true, `Sansha signal should be allowed: ${JSON.stringify(s2)}`);
    assert.strictEqual(s2.outcome, "STARTED");
    assert.strictEqual(s2.evaluation.statePatch.occupierFactionId, SANSHA);
    assert.strictEqual(s2.evaluation.statePatch.controllerFactionId, AMARR);
  });

  test("K2b G2: RECON|CONTESTED by P!= K -> STABLE (occupier null), note CORE_PROTECTED", () => {
    const contested = view({
      systemId: SYS_CORE,
      state: S.CONTESTED,
      controller: SANSHA,
      occupier: SERPENTIS,
      coreOwner: SANSHA,
      range: [SERPENTIS],
      sinceAt: 0,
      evaluatedAt: 0,
      at: H,
      influence: { [SANSHA]: 60, [SERPENTIS]: 20 },
      presence: { [SERPENTIS]: 500 },
    });

    const ev = M.evaluate(contested, tick, PARAMS);
    assert.strictEqual(ev.to, S.STABLE, `should unwind to STABLE, got ${ev.to}`);
    assert.strictEqual(ev.statePatch.occupierFactionId, null);
    assert.ok(ev.notes.includes("CORE_PROTECTED"), `notes: ${ev.notes.join(", ")}`);
  });

  test("K2c G2: INVASION by P!= K -> CONTESTED (occupier stays), note CORE_PROTECTED", () => {
    const invasion = view({
      systemId: SYS_CORE,
      state: S.INVASION,
      controller: SANSHA,
      occupier: SERPENTIS,
      coreOwner: SANSHA,
      range: [SERPENTIS],
      sinceAt: 0,
      evaluatedAt: 6 * H,
      at: 6 * H,
      influence: { [SANSHA]: 30, [SERPENTIS]: 60 },
      presence: { [SERPENTIS]: 500 },
    });

    const ev = M.evaluate(invasion, tick, PARAMS);
    assert.strictEqual(ev.to, S.CONTESTED, `should unwind to CONTESTED, got ${ev.to}`);
    assert.strictEqual(ev.statePatch.occupierFactionId, SERPENTIS);
    assert.ok(ev.notes.includes("CORE_PROTECTED"), `notes: ${ev.notes.join(", ")}`);
  });

  test("K2d G3: held (OCCUPIED/CONSOLIDATING), new hostile pretender H!= K -> no transition, note CORE_PROTECTED", () => {
    const occupied = view({
      systemId: SYS_CORE,
      state: S.OCCUPIED,
      controller: SERPENTIS,
      occupier: SERPENTIS,
      coreOwner: SANSHA,
      range: [SERPENTIS, AMARR],
      capturedAt: 0,
      influence: { [SERPENTIS]: 70, [SANSHA]: 20 },
      presence: { [SERPENTIS]: 500, [AMARR]: 300 },
      sinceAt: 0,
      evaluatedAt: 6 * H,
      at: 6 * H,
    });

    const ev = M.evaluate(occupied, battle(AMARR, SERPENTIS), PARAMS);
    assert.strictEqual(ev.to, null, `should not transition, got ${ev.to}`);
    assert.ok(ev.notes.includes("CORE_PROTECTED"), `notes: ${ev.notes.join(", ")}`);
  });

  test("K2d2 G3: hostile holder interrupts held system without core; on a core only K interrupts", () => {
    const heldView = (state, coreOwner, holder) => view({
      systemId: coreOwner === null ? SYS_NON_CORE : SYS_CORE,
      state,
      controller: SERPENTIS,
      occupier: SERPENTIS,
      coreOwner,
      range: [SERPENTIS, AMARR, SANSHA],
      capturedAt: 0,
      influence: { [SERPENTIS]: 70, [holder]: 20 },
      presence: { [holder]: 500 },
      consolidates: true,
      sinceAt: 0,
      evaluatedAt: H,
      at: H,
    });
    for (const state of [S.OCCUPIED, S.CONSOLIDATING]) {
      const v = heldView(state, null, AMARR);
      const ev = M.evaluate(v, tick, PARAMS);
      expectEdge(v, ev, S.CONTESTED, { occupier: AMARR, controller: SERPENTIS });
      assert.ok(ev.notes.includes("INTERRUPTED"), `notes: ${ev.notes.join(", ")}`);
      assert.ok(!ev.notes.includes("CORE_PROTECTED"));
    }
    const blockedView = heldView(S.OCCUPIED, SANSHA, AMARR);
    const blocked = M.evaluate(blockedView, tick, PARAMS);
    assert.strictEqual(blocked.to, null, JSON.stringify(blocked));
    assert.ok(blocked.notes.includes("CORE_PROTECTED"), `notes: ${blocked.notes.join(", ")}`);
    const ownerView = heldView(S.OCCUPIED, SANSHA, SANSHA);
    const reclaim = M.evaluate(ownerView, tick, PARAMS);
    expectEdge(ownerView, reclaim, S.CONTESTED, { occupier: SANSHA });
    assert.ok(!reclaim.notes.includes("CORE_PROTECTED"));
  });

  test("K2e G5: planAbandon by K on K's core -> CORE_PROTECTED; controller X on core -> ABANDONED", () => {
    const coreOwned = view({
      systemId: SYS_CORE,
      state: S.STABLE,
      controller: SANSHA,
      coreOwner: SANSHA,
      at: 1000,
    });
    const p1 = M.planAbandon(coreOwned, PARAMS);
    assert.deepStrictEqual(p1, { ok: false, reason: "CORE_PROTECTED" });

    const coreLost = view({
      systemId: SYS_CORE,
      state: S.STABLE,
      controller: AMARR,
      coreOwner: SANSHA,
      at: 1000,
    });
    const p2 = M.planAbandon(coreLost, PARAMS);
    assert.strictEqual(p2.ok, true);
    assert.strictEqual(p2.outcome, "ABANDONED");
    assert.strictEqual(p2.evaluation.statePatch.controllerFactionId, null);
  });

  test("K2f: view without coreOwner -> deepStrictEqual with pre-change result", () => {
    const legacyView = view({
      systemId: SYS_NON_CORE,
      state: S.STABLE,
      controller: SANSHA,
      range: [AMARR],
      at: 1000,
    });
    const v1 = { ...legacyView };
    const v2 = { ...legacyView, coreOwner: null };

    const sig1 = M.applySignal(v1, { factionId: AMARR, signal: "INVASION" }, 0, PARAMS);
    const sig2 = M.applySignal(v2, { factionId: AMARR, signal: "INVASION" }, 0, PARAMS);
    assert.deepStrictEqual(sig1, sig2, "signal result should be identical with/without coreOwner=null");

    const eval1 = M.evaluate(v1, tick, PARAMS);
    const eval2 = M.evaluate(v2, tick, PARAMS);
    assert.deepStrictEqual(eval1, eval2, "evaluate result should be identical with/without coreOwner=null");
  });

  test("R1 planRelease: claim states release the controller, the rest refuses", () => {
    const SANSHA = 500019;
    const AMARR = 500003;

    function view(o = {}) {
      return {
        systemId: o.systemId || SYS_NON_CORE,
        state: o.state,
        controller: o.controller === undefined ? SANSHA : o.controller,
        occupier: o.occupier === undefined ? null : o.occupier,
        previousController: null,
        sinceAt: o.sinceAt || 0,
        seq: o.seq || 0,
        evaluatedAt: null,
        capturedAt: o.capturedAt === undefined ? null : o.capturedAt,
        detachedSinceAt: o.detachedSinceAt === undefined ? null : o.detachedSinceAt,
        home: null,
        coreOwner: o.coreOwner === undefined ? null : o.coreOwner,
        influence: new Map(),
        presence: new Map(),
        stations: new Map(),
        inRange: () => false,
        isHostile: createHostility(),
        presenceTruncated: false,
        at: o.at === undefined ? 0 : o.at,
        consolidates: o.consolidates,
        rangeKnown: o.rangeKnown !== false,
      };
    }

    const releaseExpected = {
      ok: true, outcome: "RELEASED", evaluation: {
        to: null,
        statePatch: { controllerFactionId: null, previousControllerFactionId: SANSHA, capturedAt: null, detachedSinceAt: null },
        influence: [], reassign: [], next: null, notes: ["RELEASED"], controllerChanged: true,
      },
    };

    for (const state of [S.RECON, S.CONTESTED, S.INVASION]) {
      const v = view({ state, controller: SANSHA, occupier: AMARR, capturedAt: 500, detachedSinceAt: 600, seq: 4, at: 1000 });
      assert.deepStrictEqual(M.planRelease(v), releaseExpected, `${state} should RELEASED`);
    }

    const noopView = view({ state: S.CONTESTED, controller: null, occupier: AMARR });
    assert.deepStrictEqual(M.planRelease(noopView), { ok: true, outcome: "NOOP", evaluation: null });

    const stableView = view({ state: S.STABLE, controller: SANSHA });
    assert.deepStrictEqual(M.planRelease(stableView), { ok: false, reason: "OCCUPATION_NOT_CLAIM" });

    const occupiedView = view({ state: S.OCCUPIED, controller: SANSHA, occupier: SANSHA });
    assert.deepStrictEqual(M.planRelease(occupiedView), { ok: false, reason: "OCCUPATION_NOT_CLAIM" });

    const coreProtectedView = view({ state: S.CONTESTED, controller: SANSHA, coreOwner: SANSHA, occupier: AMARR });
    assert.deepStrictEqual(M.planRelease(coreProtectedView), { ok: false, reason: "CORE_PROTECTED" });

    const brokenView = view({ state: S.CONTESTED, controller: SANSHA, occupier: null });
    const brokenResult = M.planRelease(brokenView);
    assert.strictEqual(brokenResult.ok, false);
    assert.strictEqual(brokenResult.reason, "OCCUPATION_TRANSITION_DENIED");
    assert.ok(brokenResult.notes[0].startsWith("INVARIANT_"));

    const repelView = view({ state: S.CONTESTED, controller: null, occupier: AMARR, sinceAt: 0, at: PARAMS.contestTimeoutMs });
    const ev = M.evaluate(repelView, { kind: "tick" }, PARAMS);
    assert.strictEqual(ev.to, S.STABLE);
    assert.strictEqual(ev.statePatch.controllerFactionId, null);
    assert.strictEqual(ev.statePatch.occupierFactionId, null);
    assert.ok(ev.notes.includes("REPELLED"));
  });

  const heldWith = (fleets) => view({ state: S.OCCUPIED, controller: SANSHA, occupier: SANSHA, range: [SANSHA],
    capturedAt: 0, influence: { [SANSHA]: 70 }, presence: { [SANSHA]: 500 }, fleets: { [SANSHA]: fleets },
    sinceAt: 0, evaluatedAt: H, at: H });

  test("GR1 BUG idle-fleets: only garrisonFromRoles fleets become a garrison", () => {
    const fleets = [fleet("f1", { fleetRole: "logistics" }), fleet("f2", { fleetRole: "mining" }),
      fleet("f3", { fleetRole: "hunter" }), fleet("f4", { fleetRole: "scout" }), fleet("f5", { fleetRole: "invasion" })];
    const ev = M.evaluate(heldWith(fleets), tick, PARAMS);
    assert.deepStrictEqual(ev.reassign.map((r) => [r.fleetId, r.from]), [["f4", "scout"], ["f5", "invasion"]],
      JSON.stringify(ev.reassign));
    const onlyCivil = M.evaluate(heldWith(fleets.slice(0, 3)), tick, PARAMS);
    assert.deepStrictEqual(onlyCivil.reassign, []);
  });

  test("GR2 BUG idle-fleets: empty / missing garrisonFromRoles -> no reassign", () => {
    const fleets = [fleet("f4", { fleetRole: "scout" }), fleet("f5", { fleetRole: "invasion" })];
    assert.deepStrictEqual(M.evaluate(heldWith(fleets), tick, { ...PARAMS, garrisonFromRoles: [] }).reassign, []);
    const { garrisonFromRoles: _drop, ...noKey } = PARAMS;
    assert.deepStrictEqual(M.evaluate(heldWith(fleets), tick, noKey).reassign, []);
  });
};