"use strict";

const assert = require("node:assert");
const path = require("node:path");

const S = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const { estimateProgress, thresholdMarks, progressToJson } = require("../../lib/world/occupation/progress");
const { createHostility } = require("../../lib/battle/data/hostility");
const { resolveConfig } = require("../../config");
const { parseFleetRoleList } = require("../../lib/fleets/schema");

const ATT = 500003;
const DEF = 500019;
const THIRD = 500020;
const H = 3600000;
const isHostile = createHostility();

const PARAMS = Object.freeze({ evalIntervalMs: 900000, idleEvalIntervalMs: 7200000, maxActiveSystems: 64,
  reconTimeoutMs: 2 * H, contestTimeoutMs: 6 * H, invasionHoldMs: 6 * H, occupiedSettleMs: 6 * H,
  consolidateMs: 24 * H, invasionMinScore: 30, occupyMinScore: 60, occupyMaxDefenderScore: 30, stableMinScore: 80,
  stableMaxResidualScore: 20, battleWinPoints: 20, battleLossPoints: 15, holdPointsPerHour: 10,
  stationPointsPerHour: 5, stationBonusCap: 3, decayPointsPerHour: 5, requireNoDefenderStations: true,
  garrisonFleetsTarget: 2, detachedUpkeepStep: 0.5, detachedUpkeepPeriodMs: 24 * H, detachedUpkeepMaxFactor: 4,
  maxFactionsPerSystem: 8, garrisonFromRoles: Object.freeze([]) });

function view(o) {
  const range = new Set(o.range || []);
  const scores = Object.entries(o.influence || {}).map(([f, score]) => [Number(f), { score, garrison: 0 }]);
  return { systemId: 30000001, state: o.state, controller: o.controller === undefined ? DEF : o.controller,
    occupier: o.occupier === undefined ? ATT : o.occupier, previousController: o.previousController ?? null,
    sinceAt: o.sinceAt || 0, seq: 1, evaluatedAt: o.evaluatedAt === undefined ? null : o.evaluatedAt,
    capturedAt: o.capturedAt === undefined ? null : o.capturedAt, detachedSinceAt: null, home: null,
    coreOwner: o.coreOwner ?? null, influence: new Map(scores),
    presence: new Map(Object.entries(o.presence || {}).map(([f, strength]) => [Number(f), { strength, fleets: [] }])),
    stations: new Map(Object.entries(o.stations || {}).map(([f, n]) => [Number(f), n])),
    inRange: (f) => range.has(f), isHostile, presenceTruncated: o.presenceTruncated === true,
    deferred: o.deferred === true, at: o.at === undefined ? H : o.at, consolidates: o.consolidates,
    rangeKnown: o.rangeKnown !== false, phaseDueAt: o.phaseDueAt };
}

const held = (o) => ({ controller: ATT, occupier: ATT, previousController: DEF, capturedAt: 1, ...o });

const CASES = [
  ["RECON countdown", { state: S.RECON, at: H }, { status: "COUNTDOWN", ratio: 0.5, etaMs: null,
    fallback: { to: S.STABLE, etaMs: H }, next: null, limiting: null }],
  ["RECON over", { state: S.RECON, at: 2 * H }, { status: "REVERTING", ratio: 0, fallback: { to: S.STABLE, etaMs: 0 } }],
  ["CONTESTED advancing", { state: S.CONTESTED, presence: { [ATT]: 10 }, range: [ATT], influence: { [ATT]: 10, [DEF]: 50 },
    evaluatedAt: H }, { status: "ADVANCING", next: S.INVASION, limiting: "SCORE", etaMs: 2 * H, fallback: null }],
  ["CONTESTED ready", { state: S.CONTESTED, presence: { [ATT]: 10 }, range: [ATT], influence: { [ATT]: 30 }, evaluatedAt: H },
    { status: "READY", ratio: 1, blockers: [], next: S.INVASION }],
  ["CONTESTED no fleet", { state: S.CONTESTED, range: [ATT], influence: { [ATT]: 10 } },
    { status: "BLOCKED", blockers: ["NO_ATTACKER_FLEET"], fallback: { to: S.STABLE, etaMs: 5 * H }, etaMs: null }],
  ["CONTESTED repelled", { state: S.CONTESTED, range: [ATT], at: 6 * H },
    { status: "REVERTING", blockers: ["NO_ATTACKER_FLEET"], fallback: { to: S.STABLE, etaMs: 0 } }],
  ["CONTESTED field disputed", { state: S.CONTESTED, presence: { [ATT]: 10, [DEF]: 10 }, range: [ATT] },
    { status: "BLOCKED", blockers: ["FIELD_DISPUTED"] }],
  ["CONTESTED out of range", { state: S.CONTESTED, presence: { [ATT]: 10 } },
    { status: "BLOCKED", blockers: ["OUT_OF_RANGE"] }],
  ["CONTESTED range unknown", { state: S.CONTESTED, presence: { [ATT]: 10 }, rangeKnown: false },
    { status: "BLOCKED", blockers: ["RANGE_UNKNOWN"] }],
  ["CONTESTED no rate", { state: S.CONTESTED, presence: { [ATT]: 10 }, range: [ATT] },
    { status: "BLOCKED", blockers: ["SCORE_STALLED"], etaMs: null }, { holdPointsPerHour: 0 }],
  ["INVASION advancing on time", { state: S.INVASION, presence: { [ATT]: 10 }, range: [ATT], at: 3 * H, evaluatedAt: 3 * H,
    influence: { [ATT]: 70, [DEF]: 10 } }, { status: "ADVANCING", next: S.OCCUPIED, limiting: "TIME", ratio: 0.5, etaMs: 3 * H }],
  ["INVASION advancing on the defender", { state: S.INVASION, presence: { [ATT]: 10 }, range: [ATT], at: 7 * H,
    evaluatedAt: 7 * H, influence: { [ATT]: 70, [DEF]: 60 } }, { status: "ADVANCING", limiting: "DEFENDER", ratio: 0.5,
    etaMs: 6 * H }],
  ["INVASION ready", { state: S.INVASION, presence: { [ATT]: 10 }, range: [ATT], at: 6 * H, evaluatedAt: 6 * H,
    influence: { [ATT]: 70, [DEF]: 10 } }, { status: "READY", ratio: 1, next: S.OCCUPIED }],
  ["INVASION field lost", { state: S.INVASION, presence: { [ATT]: 10, [DEF]: 10 }, range: [ATT] },
    { status: "REVERTING", blockers: ["FIELD_LOST"], fallback: { to: S.CONTESTED, etaMs: 900000 } }],
  ["INVASION fleet gone", { state: S.INVASION, range: [ATT] },
    { status: "REVERTING", blockers: ["NO_ATTACKER_FLEET"], fallback: { to: S.CONTESTED, etaMs: 900000 } }],
  ["INVASION defender station", { state: S.INVASION, presence: { [ATT]: 10 }, range: [ATT], at: 6 * H, evaluatedAt: 6 * H,
    stations: { [DEF]: 1 }, influence: { [ATT]: 70, [DEF]: 10 } }, { status: "BLOCKED", blockers: ["DEFENDER_STATION"] }],
  ["INVASION out of range", { state: S.INVASION, presence: { [ATT]: 10 }, at: 6 * H, evaluatedAt: 6 * H,
    influence: { [ATT]: 70 } }, { status: "BLOCKED", blockers: ["OUT_OF_RANGE"] }],
  ["OCCUPIED advancing", held({ state: S.OCCUPIED, presence: { [ATT]: 10 }, range: [ATT], at: 3 * H, evaluatedAt: 3 * H,
    phaseDueAt: 3 * H }), { status: "ADVANCING", next: S.CONSOLIDATING, attacker: ATT, defender: DEF, etaMs: 3 * H }],
  ["OCCUPIED ready", held({ state: S.OCCUPIED, presence: { [ATT]: 10 }, range: [ATT], at: 6 * H, evaluatedAt: 6 * H }),
    { status: "READY", next: S.CONSOLIDATING }],
  ["OCCUPIED field lost, idle grid", held({ state: S.OCCUPIED, presence: { [DEF]: 10 }, range: [ATT] }),
    { status: "REVERTING", blockers: ["FIELD_LOST"], fallback: { to: S.CONTESTED, etaMs: H } }],
  ["OCCUPIED no garrison", held({ state: S.OCCUPIED, range: [ATT], at: 6 * H, evaluatedAt: 6 * H }),
    { status: "BLOCKED", blockers: ["NO_GARRISON"] }],
  ["OCCUPIED core blocks the enemy", held({ state: S.OCCUPIED, presence: { [DEF]: 10 }, range: [ATT], coreOwner: THIRD }),
    { status: "BLOCKED", blockers: ["NO_GARRISON"] }],
  ["OCCUPIED field disputed", held({ state: S.OCCUPIED, presence: { [ATT]: 10, [DEF]: 10 }, range: [ATT] }),
    { status: "BLOCKED", blockers: ["FIELD_DISPUTED"] }],
  ["OCCUPIED out of range", held({ state: S.OCCUPIED, presence: { [ATT]: 10 } }),
    { status: "BLOCKED", blockers: ["OUT_OF_RANGE"] }],
  ["OCCUPIED range unknown", held({ state: S.OCCUPIED, presence: { [ATT]: 10 }, rangeKnown: false }),
    { status: "BLOCKED", blockers: ["RANGE_UNKNOWN"] }],
  ["OCCUPIED heartland needs no range", held({ state: S.OCCUPIED, presence: { [ATT]: 10 }, capturedAt: null, at: 6 * H,
    evaluatedAt: 6 * H }), { status: "READY" }],
  ["OCCUPIED no consolidation", held({ state: S.OCCUPIED, presence: { [ATT]: 10 }, range: [ATT], consolidates: () => false,
    at: 6 * H, evaluatedAt: 6 * H }), { status: "BLOCKED", blockers: ["NO_CONSOLIDATION"] }],
  ["CONSOLIDATING advancing on influence", held({ state: S.CONSOLIDATING, presence: { [ATT]: 10 }, range: [ATT], at: 30 * H,
    evaluatedAt: 30 * H, influence: { [ATT]: 60, [DEF]: 5 } }), { status: "ADVANCING", next: S.STABLE, limiting: "SCORE",
    ratio: 0.75, etaMs: 2 * H, hostile: [DEF] }],
  ["CONSOLIDATING advancing on the residual", held({ state: S.CONSOLIDATING, presence: { [ATT]: 10 }, range: [ATT],
    at: 30 * H, evaluatedAt: 30 * H, influence: { [ATT]: 90, [DEF]: 40 } }), { status: "ADVANCING", limiting: "RESIDUAL",
    ratio: 0.5, etaMs: 4 * H }],
  ["CONSOLIDATING ready", held({ state: S.CONSOLIDATING, presence: { [ATT]: 10 }, range: [ATT], at: 24 * H, evaluatedAt: 24 * H,
    influence: { [ATT]: 90, [DEF]: 5 } }), { status: "READY", next: S.STABLE }],
  ["CONSOLIDATING field lost", held({ state: S.CONSOLIDATING, presence: { [DEF]: 10 }, range: [ATT] }),
    { status: "REVERTING", blockers: ["FIELD_LOST"], fallback: { to: S.CONTESTED, etaMs: 900000 } }],
  ["CONSOLIDATING no consolidation", held({ state: S.CONSOLIDATING, presence: { [ATT]: 10 }, range: [ATT],
    consolidates: () => false }), { status: "REVERTING", blockers: ["NO_CONSOLIDATION"], fallback: { to: S.OCCUPIED, etaMs: 900000 } }],
  ["CONSOLIDATING out of range", held({ state: S.CONSOLIDATING, presence: { [ATT]: 10 } }),
    { status: "REVERTING", blockers: ["OUT_OF_RANGE"] }],
  ["CONSOLIDATING no garrison", held({ state: S.CONSOLIDATING, range: [ATT] }),
    { status: "REVERTING", blockers: ["NO_GARRISON"] }],
  ["CONSOLIDATING range unknown", held({ state: S.CONSOLIDATING, presence: { [ATT]: 10 }, rangeKnown: false, at: 24 * H,
    evaluatedAt: 24 * H, influence: { [ATT]: 90 } }), { status: "BLOCKED", blockers: ["RANGE_UNKNOWN"] }],
  ["RECON core unwind", { state: S.RECON, coreOwner: DEF }, { status: "REVERTING", blockers: ["CORE_PROTECTED"],
    fallback: { to: S.STABLE, etaMs: 900000 } }],
  ["CONTESTED core unwind", { state: S.CONTESTED, coreOwner: DEF, presence: { [ATT]: 10 }, range: [ATT] },
    { status: "REVERTING", blockers: ["CORE_PROTECTED"], fallback: { to: S.STABLE, etaMs: 900000 } }],
  ["INVASION core unwind", { state: S.INVASION, coreOwner: DEF, presence: { [ATT]: 10 }, range: [ATT] },
    { status: "REVERTING", blockers: ["CORE_PROTECTED"], fallback: { to: S.CONTESTED, etaMs: 900000 } }],
  ["deferred wins over the rest", { state: S.INVASION, deferred: true, coreOwner: DEF },
    { status: "BLOCKED", blockers: ["DATA_PENDING"], etaMs: null }],
  ["truncated", { state: S.CONTESTED, presenceTruncated: true }, { status: "BLOCKED", blockers: ["FLEETS_TRUNCATED"] }],
];

function expectedTo(p) {
  if (p.status === "READY") return p.next;
  if (p.status === "REVERTING") return p.fallback.to;
  return null;
}

module.exports = ({ test }) => {
  test("T1 estimateProgress: every row of the state table, parity with the real evaluate", () => {
    for (const [name, spec, want, over] of CASES) {
      const params = over ? { ...PARAMS, ...over } : PARAMS;
      const v = view(spec);
      const p = estimateProgress(v, params);
      assert.ok(p, name);
      for (const [k, value] of Object.entries(want)) {
        if (k === "ratio") assert.ok(Math.abs(p.ratio - value) < 0.001, `${name}: ratio ${p.ratio}`);
        else assert.deepStrictEqual(p[k], value, `${name}: ${k}`);
      }
      assert.ok(p.ratio >= 0 && p.ratio <= 1, name);
      assert.strictEqual(M.evaluate(v, { kind: "tick" }, params).to, expectedTo(p), `parity: ${name}`);
    }
  });

  test("T1b low-sweep-2 (galaxy-system-panel-ui INFO-2): parity with evaluate on the default occupation params", () => {
    const { config } = resolveConfig({ env: {}, modDir: path.resolve(__dirname, "..", "..") });
    const occ = config.occupation;
    const defaults = Object.freeze({ ...occ, maxFactionsPerSystem: config.world.maxFactionsPerSystem,
      garrisonFromRoles: parseFleetRoleList(occ.garrisonFromRoles) || Object.freeze([]) });
    let checked = 0;
    for (const [name, spec, , over] of CASES) {
      const params = over ? { ...defaults, ...over } : defaults;
      const v = view(spec);
      const p = estimateProgress(v, params);
      if (p === null) continue;
      assert.ok(p.ratio >= 0 && p.ratio <= 1, `defaults: ${name}`);
      assert.strictEqual(M.evaluate(v, { kind: "tick" }, params).to, expectedTo(p), `parity on defaults: ${name}`);
      checked += 1;
    }
    assert.ok(checked >= CASES.length - 2, `defaults: ${checked}/${CASES.length} rows estimated`);
  });

  test("T1 STABLE and invalid input -> null; marks of the table; progressToJson per mille, no maps", () => {
    assert.strictEqual(estimateProgress(view({ state: S.STABLE, occupier: null }), PARAMS), null);
    assert.strictEqual(estimateProgress(null, PARAMS), null);
    assert.strictEqual(estimateProgress({ state: S.RECON }, PARAMS), null, "a broken view never throws");
    const codes = (state, role) => thresholdMarks(state, role, PARAMS).map((m) => `${m.code}:${m.score}`);
    assert.deepStrictEqual(codes(S.CONTESTED, "attacker"), ["INVASION_MIN:30", "OCCUPY_MIN:60"]);
    assert.deepStrictEqual(codes(S.RECON, "defender"), ["DEFENDER_MAX:30"]);
    assert.deepStrictEqual(codes(S.INVASION, "attacker"), ["OCCUPY_MIN:60"]);
    assert.deepStrictEqual(codes(S.CONSOLIDATING, "attacker"), ["STABLE_MIN:80"]);
    assert.deepStrictEqual(codes(S.OCCUPIED, "hostile"), ["RESIDUAL_MAX:20"]);
    assert.deepStrictEqual(codes(S.OCCUPIED, "defender"), []);
    assert.deepStrictEqual(codes(S.STABLE, "attacker"), []);
    assert.deepStrictEqual(codes(S.INVASION, null), []);
    const p = estimateProgress(view({ state: S.RECON, at: H }), PARAMS);
    const json = progressToJson(p);
    assert.strictEqual(json.ratio, 500);
    assert.ok(!("scores" in json) && !("hostile" in json));
    assert.strictEqual(progressToJson(null), null);
  });

  test("T2 the numbers follow the params; phaseDueAt after readyAt is the floor of etaMs", () => {
    const spec = { state: S.INVASION, presence: { [ATT]: 10 }, range: [ATT], at: 3 * H, evaluatedAt: 3 * H,
      influence: { [ATT]: 70, [DEF]: 10 } };
    const base = estimateProgress(view(spec), PARAMS);
    const fast = estimateProgress(view(spec), { ...PARAMS, invasionHoldMs: 3 * H + H / 2 });
    assert.deepStrictEqual([base.etaMs, fast.etaMs], [3 * H, H / 2]);
    assert.ok(Math.abs(fast.ratio - 6 / 7) < 0.001 && Math.abs(base.ratio - 0.5) < 0.001);

    const score = { state: S.CONTESTED, presence: { [ATT]: 10 }, range: [ATT], influence: { [ATT]: 10 }, evaluatedAt: H };
    const slow = estimateProgress(view(score), PARAMS);
    const quick = estimateProgress(view(score), { ...PARAMS, holdPointsPerHour: 20, invasionMinScore: 20 });
    assert.deepStrictEqual([slow.etaMs, quick.etaMs], [2 * H, H / 2]);
    assert.ok(Math.abs(slow.ratio - 1 / 3) < 0.001 && Math.abs(quick.ratio - 0.5) < 0.001);

    const due = 10 * H + 900000 * 3;
    assert.strictEqual(estimateProgress(view({ ...spec, phaseDueAt: due }), PARAMS).etaMs, due - 3 * H);
    const aligned = estimateProgress(view({ ...spec, at: 3 * H + 1, evaluatedAt: 3 * H + 1 }), PARAMS);
    assert.strictEqual(aligned.etaMs, 6 * H - (3 * H + 1));
    const late = estimateProgress(view({ ...score, at: 2 * H }), PARAMS);
    assert.strictEqual(late.scores.get(ATT), 20);
  });
};
