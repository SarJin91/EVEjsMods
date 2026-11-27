"use strict";

const { strengthOf, garrisonPowerOf } = require("../../lib/strategy/ai/strength");

const OUTCOMES = Object.freeze(["A_WIN", "B_WIN", "DRAW", "BOTH_RETREAT"]);
const OTHER = "OTHER";
const BUCKETS = Object.freeze([
  Object.freeze({ label: "<500", min: -Infinity }),
  Object.freeze({ label: "500-799", min: 500 }),
  Object.freeze({ label: "800-999", min: 800 }),
  Object.freeze({ label: "1000-1199", min: 1000 }),
  Object.freeze({ label: "1200-1499", min: 1200 }),
  Object.freeze({ label: "1500-1999", min: 1500 }),
  Object.freeze({ label: ">=2000", min: 2000 }),
]);
const PIECEMEAL_OBJECTIVES = Object.freeze(["capture", "destroy"]);
const PERMILLE = 1000;

function bucketOf(ratioPermille) {
  let label = BUCKETS[0].label;
  for (const b of BUCKETS) if (ratioPermille >= b.min) label = b.label;
  return label;
}

const ratioOf = (a, b) => Math.floor((a * PERMILLE) / Math.max(1, b));

function sidePower(side, powerTable) {
  let sum = 0;
  for (const f of (side && Array.isArray(side.fleets) ? side.fleets : [])) {
    sum += strengthOf(f && f.composition, powerTable);
  }
  return sum;
}

const emptyCounts = () => ({ A_WIN: 0, B_WIN: 0, DRAW: 0, BOTH_RETREAT: 0, OTHER: 0 });

function countOutcome(counts, outcome) {
  counts[OUTCOMES.includes(outcome) ? outcome : OTHER] += 1;
}

const share = (n, d) => (d > 0 ? n / d : 0);

function sharesOf(counts, battles) {
  const out = {};
  for (const k of [...OUTCOMES, OTHER]) out[k] = share(counts[k], battles);
  return out;
}

function oddsOfBattle(row, deps) {
  const input = row && row.input && typeof row.input === "object" ? row.input : null;
  if (!input) throw new Error("input missing");
  const result = row.result && typeof row.result === "object" ? row.result : {};
  const outcome = typeof result.outcome === "string" ? result.outcome : OTHER;
  const powerA = sidePower(input.sideA, deps.powerTable);
  const powerB = sidePower(input.sideB, deps.powerTable);
  const ratio = ratioOf(powerA, powerB);
  const g = input.garrison && typeof input.garrison === "object" ? input.garrison : null;
  const garrisonSide = g && (g.side === "A" || g.side === "B") ? g.side : null;
  const garrisonStrength = g && Number.isFinite(g.strength) && g.strength > 0 ? g.strength : 0;
  let garrison = null;
  if (garrisonSide === "B") {
    const legacyB = powerB + garrisonStrength;
    const resolverB = powerB + garrisonPowerOf(garrisonStrength, deps.powerPerPoint);
    garrison = { strength: garrisonStrength, legacyRatio: ratioOf(powerA, legacyB),
      resolverRatio: ratioOf(powerA, resolverB) };
    garrison.legacyBucket = bucketOf(garrison.legacyRatio);
    garrison.resolverBucket = bucketOf(garrison.resolverRatio);
  }
  const factionA = Number.isSafeInteger(row.factionA) ? row.factionA
    : (input.sideA && Number.isSafeInteger(input.sideA.factionId) ? input.sideA.factionId : null);
  return { battleId: row.battleId, systemId: row.systemId, objective: String(row.objective || input.objective || "?"),
    mode: row.mode || null, factionA, factionB: input.sideB ? input.sideB.factionId : null,
    createdAt: Number(row.createdAt) || 0, settledAt: Number(row.settledAt) || 0,
    outcome, powerA, powerB, ratio, bucket: bucketOf(ratio), garrisonSide, garrison };
}

function bucketTable(battles, bucketKey) {
  const map = new Map(BUCKETS.map((b) => [b.label, { bucket: b.label, battles: 0, counts: emptyCounts(),
    byObjective: {} }]));
  for (const b of battles) {
    const e = map.get(bucketKey(b));
    e.battles += 1;
    countOutcome(e.counts, b.outcome);
    let o = e.byObjective[b.objective];
    if (!o) {
      o = { battles: 0, counts: emptyCounts() };
      e.byObjective[b.objective] = o;
    }
    o.battles += 1;
    countOutcome(o.counts, b.outcome);
  }
  const out = [];
  for (const e of map.values()) {
    for (const o of Object.values(e.byObjective)) o.shares = sharesOf(o.counts, o.battles);
    out.push({ ...e, shares: sharesOf(e.counts, e.battles) });
  }
  return out;
}

const byTime = (x, y) => x.settledAt - y.settledAt || String(x.battleId).localeCompare(String(y.battleId));

function grindersOf(battles, opts) {
  const groups = new Map();
  for (const b of battles) {
    if (b.outcome !== "B_WIN" || b.factionA === null) continue;
    const key = `${b.factionA}:${b.systemId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort(byTime);
    let best = 0;
    let bestStart = 0;
    let lo = 0;
    for (let hi = 0; hi < list.length; hi += 1) {
      while (list[hi].settledAt - list[lo].settledAt > opts.windowMs) lo += 1;
      if (hi - lo + 1 > best) {
        best = hi - lo + 1;
        bestStart = list[lo].settledAt;
      }
    }
    if (best >= opts.min) {
      out.push({ factionId: list[0].factionA, systemId: list[0].systemId, bWins: list.length, maxInWindow: best,
        windowStart: bestStart });
    }
  }
  return out.sort((x, y) => y.maxInWindow - x.maxInWindow || y.bWins - x.bWins || x.factionId - y.factionId
    || x.systemId - y.systemId);
}

function piecemealOf(battles, opts) {
  const groups = new Map();
  for (const b of battles) {
    if (b.factionA === null) continue;
    const key = `${b.factionA}:${b.systemId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  let base = 0;
  const list = [];
  const casesByOutcome = emptyCounts();
  for (const group of groups.values()) {
    for (const first of group) {
      if (!PIECEMEAL_OBJECTIVES.includes(first.objective)) continue;
      base += 1;
      const next = group.find((n) => n !== first && n.createdAt >= first.settledAt
        && n.createdAt - first.settledAt <= opts.windowMs);
      if (!next) continue;
      countOutcome(casesByOutcome, first.outcome);
      list.push({ battleId: first.battleId, nextBattleId: next.battleId, factionId: first.factionA,
        systemId: first.systemId, outcome: first.outcome, gapMs: next.createdAt - first.settledAt });
    }
  }
  list.sort((x, y) => x.gapMs - y.gapMs || String(x.battleId).localeCompare(String(y.battleId)));
  return { base, cases: list.length, share: share(list.length, base), casesByOutcome, list };
}

const PIECEMEAL_V2_WITHIN_MS = Object.freeze([60000, 600000, 1800000, 3600000]);
const PIECEMEAL_V2_LIST_MAX = 12;

const quantileOf = (sorted, p) => (sorted.length > 0 ? sorted[Math.min(sorted.length - 1,
  Math.floor(p * sorted.length))] : null);

function piecemealByOperationOf(battles, operations, arrivals, opts = {}) {
  if (!(arrivals instanceof Map)) throw new TypeError("arrivals must be a Map");
  const since = Number.isFinite(opts.since) ? opts.since : -Infinity;
  const listMax = Number.isSafeInteger(opts.listMax) && opts.listMax >= 0 ? opts.listMax : PIECEMEAL_V2_LIST_MAX;
  const ops = new Map();
  const fleetOps = new Map();
  for (const o of operations || []) {
    if (!o || ops.has(o.operationId) || !Array.isArray(o.fleetIds)) continue;
    const end = Number.isFinite(o.completedAt) ? o.completedAt : Infinity;
    ops.set(o.operationId, { ...o, end, x1: null });
    for (const f of o.fleetIds) {
      if (!fleetOps.has(f)) fleetOps.set(f, []);
      fleetOps.get(f).push(o.operationId);
    }
  }
  for (const b of battles || []) {
    if (!b || !Array.isArray(b.sideAFleetIds)) continue;
    const seen = new Set();
    for (const f of b.sideAFleetIds) {
      for (const id of fleetOps.get(f) || []) {
        const o = ops.get(id);
        if (seen.has(id) || o.targetSystemId !== b.systemId || !(o.plannedAt <= b.createdAt && b.createdAt <= o.end)) {
          continue;
        }
        seen.add(id);
        if (o.x1 === null || b.createdAt < o.x1.createdAt
          || (b.createdAt === o.x1.createdAt && String(b.battleId) < String(o.x1.battleId))) o.x1 = b;
      }
    }
  }
  const out = { base: 0, single: 0, cases: 0, share: 0, byType: {},
    firstOutcome: { piecemeal: emptyCounts(), whole: emptyCounts() }, lateFleets: 0,
    gapsMs: { p10: null, p50: null, p90: null, max: null }, within: {}, list: [] };
  const gaps = [];
  const cases = [];
  for (const o of ops.values()) {
    const x1 = o.x1;
    if (x1 === null || x1.createdAt < since) continue;
    if (o.fleetIds.length < 2) {
      out.single += 1;
      continue;
    }
    out.base += 1;
    if (!out.byType[o.operationType]) out.byType[o.operationType] = { base: 0, cases: 0 };
    out.byType[o.operationType].base += 1;
    const inX1 = new Set(x1.sideAFleetIds);
    const late = [];
    for (const f of o.fleetIds) {
      if (inX1.has(f)) continue;
      const hit = (arrivals.get(f) || []).find((a) => a.systemId === o.targetSystemId
        && x1.createdAt < a.at && a.at <= o.end);
      if (hit) late.push({ fleetId: f, gapMs: hit.at - x1.createdAt });
    }
    if (late.length === 0) {
      countOutcome(out.firstOutcome.whole, x1.outcome);
      continue;
    }
    out.cases += 1;
    out.byType[o.operationType].cases += 1;
    out.lateFleets += late.length;
    countOutcome(out.firstOutcome.piecemeal, x1.outcome);
    for (const l of late) gaps.push(l.gapMs);
    cases.push({ operationId: o.operationId, operationType: o.operationType, targetSystemId: o.targetSystemId,
      fleets: o.fleetIds.length, fleetsInX1: x1.sideAFleetIds.length, battleId: x1.battleId, createdAt: x1.createdAt,
      outcome: x1.outcome, gapsMs: late.map((l) => l.gapMs).sort((x, y) => x - y) });
  }
  gaps.sort((x, y) => x - y);
  out.share = share(out.cases, out.base);
  out.gapsMs = { p10: quantileOf(gaps, 0.1), p50: quantileOf(gaps, 0.5), p90: quantileOf(gaps, 0.9),
    max: gaps.length > 0 ? gaps[gaps.length - 1] : null };
  for (const ms of PIECEMEAL_V2_WITHIN_MS) out.within[ms] = gaps.filter((g) => g <= ms).length;
  cases.sort((x, y) => x.createdAt - y.createdAt || String(x.operationId).localeCompare(String(y.operationId)));
  out.list = cases.slice(0, listMax);
  return out;
}

function gankEndOf(g) {
  if (Number.isFinite(g.dueAt)) return g.dueAt;
  return Number.isFinite(g.completedAt) ? g.completedAt : Infinity;
}

function inGank(b, ganks) {
  return ganks.some((g) => g && g.factionId === b.factionA && g.targetSystemId === b.systemId
    && Number.isFinite(g.plannedAt) && g.plannedAt <= b.createdAt && b.createdAt <= gankEndOf(g));
}

function inWindow(op, createdAt) {
  return Number.isFinite(op.plannedAt) && op.plannedAt <= createdAt && createdAt <= gankEndOf(op);
}

function interceptionsOf(battles, blockades) {
  if (!Array.isArray(blockades) || blockades.length === 0) return null;
  const inside = battles.filter((b) => Number.isSafeInteger(b.factionB) && blockades.some((op) => op
    && op.factionId === b.factionB && op.targetSystemId === b.systemId && inWindow(op, b.createdAt)));
  const counts = emptyCounts();
  for (const b of inside) countOutcome(counts, b.outcome);
  return { operations: blockades.length, battles: inside.length, counts, shares: sharesOf(counts, inside.length),
    buckets: bucketTable(inside, (b) => b.bucket) };
}

function attackEffectOf(battles, attacks) {
  if (!Array.isArray(attacks)) return null;
  const byFaction = new Map();
  for (const b of battles) {
    if (b.factionA === null) continue;
    if (!byFaction.has(b.factionA)) byFaction.set(b.factionA, []);
    byFaction.get(b.factionA).push(b);
  }
  const groups = new Map();
  const totals = { operations: 0, inTarget: 0, outside: 0 };
  for (const op of attacks) {
    if (!op || !Number.isSafeInteger(op.factionId) || !Number.isSafeInteger(op.targetSystemId)) continue;
    const own = (byFaction.get(op.factionId) || []).filter((b) => inWindow(op, b.createdAt));
    const inTarget = own.some((b) => b.systemId === op.targetSystemId) ? 1 : 0;
    const outside = own.some((b) => b.systemId !== op.targetSystemId) ? 1 : 0;
    const key = `${op.factionId}:${op.targetSystemId}`;
    if (!groups.has(key)) {
      groups.set(key, { factionId: op.factionId, targetSystemId: op.targetSystemId, operations: 0, inTarget: 0,
        outside: 0 });
    }
    const g = groups.get(key);
    g.operations += 1;
    g.inTarget += inTarget;
    g.outside += outside;
    totals.operations += 1;
    totals.inTarget += inTarget;
    totals.outside += outside;
  }
  const list = [...groups.values()].sort((x, y) => y.operations - x.operations || x.factionId - y.factionId
    || x.targetSystemId - y.targetSystemId);
  return { ...totals, list };
}

function escortEffectOf(battles, ganks, escorts) {
  if (!Array.isArray(escorts) || escorts.length === 0) return null;
  const inside = Array.isArray(ganks) ? battles.filter((b) => b.factionA !== null && inGank(b, ganks)) : [];
  const withEscort = { battles: 0, counts: emptyCounts() };
  const withoutEscort = { battles: 0, counts: emptyCounts() };
  for (const b of inside) {
    const escorted = Number.isSafeInteger(b.factionB) && escorts.some((op) => op && op.factionId === b.factionB
      && op.targetSystemId === b.systemId && inWindow(op, b.createdAt));
    const t = escorted ? withEscort : withoutEscort;
    t.battles += 1;
    countOutcome(t.counts, b.outcome);
  }
  return { operations: escorts.length, withEscort, withoutEscort };
}

function auditOdds(rows, deps) {
  const battles = [];
  const unreadable = [];
  for (const row of rows || []) {
    try {
      battles.push(oddsOfBattle(row, deps));
    } catch (err) {
      unreadable.push({ battleId: row && row.battleId, detail: String((err && err.message) || err) });
    }
  }
  const counts = emptyCounts();
  for (const b of battles) countOutcome(counts, b.outcome);
  const withGarrison = battles.filter((b) => b.garrison !== null);
  const garrison = { battles: withGarrison.length,
    legacy: bucketTable(withGarrison, (b) => b.garrison.legacyBucket),
    resolver: bucketTable(withGarrison, (b) => b.garrison.resolverBucket) };
  let ganks = null;
  if (Array.isArray(deps.ganks)) {
    const inside = battles.filter((b) => b.factionA !== null && inGank(b, deps.ganks));
    const gCounts = emptyCounts();
    for (const b of inside) countOutcome(gCounts, b.outcome);
    ganks = { operations: deps.ganks.length, battles: inside.length, counts: gCounts,
      shares: sharesOf(gCounts, inside.length), buckets: bucketTable(inside, (b) => b.bucket) };
  }
  return {
    totals: { battles: battles.length, unreadable: unreadable.length, counts, shares: sharesOf(counts, battles.length) },
    buckets: bucketTable(battles, (b) => b.bucket),
    grinders: grindersOf(battles, { windowMs: deps.grindWindowMs, min: deps.grindMin }),
    garrison,
    piecemeal: piecemealOf(battles, { windowMs: deps.piecemealMs }),
    ganks,
    interceptions: interceptionsOf(battles, deps.blockades === undefined ? null : deps.blockades),
    attacks: attackEffectOf(battles, deps.attacks === undefined ? null : deps.attacks),
    escorts: escortEffectOf(battles, Array.isArray(deps.ganks) ? deps.ganks : null,
      deps.escorts === undefined ? null : deps.escorts),
    piecemealV2: Array.isArray(deps.operations) && deps.arrivals instanceof Map
      ? piecemealByOperationOf(Array.isArray(deps.operationBattles) ? deps.operationBattles : [], deps.operations,
        deps.arrivals, { since: deps.since, listMax: deps.piecemealListMax })
      : null,
    unreadable,
  };
}

module.exports = { OUTCOMES, OTHER, BUCKETS, PIECEMEAL_OBJECTIVES, PIECEMEAL_V2_WITHIN_MS, bucketOf, oddsOfBattle,
  grindersOf, piecemealOf, piecemealByOperationOf, interceptionsOf, attackEffectOf, escortEffectOf, auditOdds };
