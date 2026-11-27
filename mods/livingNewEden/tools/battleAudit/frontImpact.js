"use strict";

const { STRUCTURE_DEFENSE } = require("../../lib/stations/data/structureDefense");
const { strengthOf } = require("../../lib/strategy/ai/strength");

const GATE = Object.freeze({ parityMin: 0.95, paramsMatchMin: 0.95, bWinMaxV1: 0.75, aWinMaxV1: 0.65 });
const OUTCOMES = Object.freeze(["A_WIN", "B_WIN", "DRAW", "BOTH_RETREAT"]);
const VERDICT = Object.freeze({ FLIP_OFF: "FLIP_OFF", KEEP_PARAMS_DRIFT: "KEEP_PARAMS_DRIFT",
  KEEP_NOT_GARRISON: "KEEP_NOT_GARRISON", KEEP_TOO_WEAK: "KEEP_TOO_WEAK", NO_DATA: "NO_DATA" });
const REFUSED_PREFIX = "REFUSED:";
const STATION_ONLINE = "ONLINE";
const STATION_KIND_NPC = "npc";
const FAMILY_NPC = "npc";

const isRefused = (outcome) => typeof outcome !== "string" || outcome.startsWith(REFUSED_PREFIX);

function stationPointsOf(stations, systemId, factionId, config) {
  const siege = config && config.siege;
  if (!siege || siege.stationGarrisonEnabled !== true) return 0;
  let sum = 0;
  for (const s of stations || []) {
    if (!s || s.state !== STATION_ONLINE || s.systemId !== systemId || s.ownerFactionId !== factionId) continue;
    const family = s.kind === STATION_KIND_NPC ? FAMILY_NPC : s.structureFamily;
    const d = typeof family === "string" && Object.prototype.hasOwnProperty.call(STRUCTURE_DEFENSE, family)
      ? STRUCTURE_DEFENSE[family] : null;
    if (d && Number.isSafeInteger(d.garrisonPoints) && d.garrisonPoints > 0) sum += d.garrisonPoints;
  }
  return sum;
}

function outcomeOf(resolve, input, catalog, params) {
  let r;
  try {
    r = resolve(input, catalog, params);
  } catch (err) {
    return { outcome: `${REFUSED_PREFIX}THROWN`, result: null, detail: String((err && err.message) || err) };
  }
  if (!r || r.ok !== true || !r.result) {
    return { outcome: `${REFUSED_PREFIX}${(r && r.reason) || "NO_RESULT"}`, result: null };
  }
  return { outcome: r.result.outcome, result: r.result };
}

function sidePower(side, powerTable) {
  let sum = 0;
  for (const f of (side && Array.isArray(side.fleets) ? side.fleets : [])) sum += strengthOf(f.composition, powerTable);
  return sum;
}

const emptyCounts = () => ({ A_WIN: 0, B_WIN: 0, DRAW: 0, BOTH_RETREAT: 0, REFUSED: 0 });

function countOutcome(counts, outcome) {
  if (OUTCOMES.includes(outcome)) counts[outcome] += 1;
  else counts.REFUSED += 1;
}

const share = (n, d) => (d > 0 ? n / d : 0);

function gateOf(battles, thresholds = GATE, gFilter = null) {
  const t = { ...GATE, ...(thresholds || {}) };
  const all = Array.isArray(battles) ? battles : [];
  const n = all.length;
  const parityShare = share(all.filter((b) => b.parity === true).length, n);
  const paramsMatchShare = share(all.filter((b) => b.paramsMatch === true).length, n);
  const g = all.filter((b) => b.garrisonSide === "B" && (typeof gFilter !== "function" || gFilter(b)));
  const resolved = g.filter((b) => !isRefused(b.v1));
  const bWinShareV1 = share(resolved.filter((b) => b.v1 === "B_WIN").length, resolved.length);
  const aWinShareV1 = share(resolved.filter((b) => b.v1 === "A_WIN").length, resolved.length);
  const p0 = n > 0 && parityShare >= t.parityMin && paramsMatchShare >= t.paramsMatchMin;
  const p1 = resolved.length > 0 && bWinShareV1 <= t.bWinMaxV1;
  const p2 = resolved.length > 0 && aWinShareV1 <= t.aWinMaxV1;
  let verdict;
  if (resolved.length === 0) verdict = VERDICT.NO_DATA;
  else if (!p0) verdict = VERDICT.KEEP_PARAMS_DRIFT;
  else if (!p1) verdict = VERDICT.KEEP_NOT_GARRISON;
  else if (!p2) verdict = VERDICT.KEEP_TOO_WEAK;
  else verdict = VERDICT.FLIP_OFF;
  return { verdict, battles: n, g: g.length, gResolved: resolved.length, gRefusedV1: g.length - resolved.length,
    parityShare, paramsMatchShare, bWinShareV1, aWinShareV1, p0, p1, p2, thresholds: t };
}

function offGarrisonOf(input, garrison, systemId, stationPoints) {
  const factionA = input.sideA ? input.sideA.factionId : null;
  const factionB = input.sideB ? input.sideB.factionId : null;
  const ptsA = Number(stationPoints(systemId, factionA)) || 0;
  const ptsB = Number(stationPoints(systemId, factionB)) || 0;
  const sA = garrison.side === "A" ? Math.min(ptsA, garrison.strength) : ptsA;
  const sB = garrison.side === "B" ? Math.min(ptsB, garrison.strength) : ptsB;
  let g = null;
  if (sB > 0) g = { side: "B", factionId: factionB, strength: sB };
  else if (sA > 0) g = { side: "A", factionId: factionA, strength: sA };
  return { garrison: g, storedSidePoints: garrison.side === "A" ? ptsA : ptsB };
}

function auditOne(row, deps) {
  const input = JSON.parse(row.inputJson);
  const recordedResult = JSON.parse(row.resultJson);
  const recorded = recordedResult && typeof recordedResult.outcome === "string" ? recordedResult.outcome : "?";
  const recordedHash = recordedResult && recordedResult.diagnostics ? recordedResult.diagnostics.paramsHash : null;
  const v0 = outcomeOf(deps.resolve, input, deps.catalog, deps.params);
  const garrison = input && input.garrison ? input.garrison : null;
  let v1 = v0;
  let v1Strength = garrison ? garrison.strength : null;
  let stationPtsNow = 0;
  let v1Side = garrison ? garrison.side : null;
  if (garrison) {
    const g1 = offGarrisonOf(input, garrison, row.systemId, deps.stationPoints);
    stationPtsNow = g1.storedSidePoints;
    v1Strength = g1.garrison ? g1.garrison.strength : null;
    v1Side = g1.garrison ? g1.garrison.side : null;
    v1 = outcomeOf(deps.resolve, { ...input, garrison: g1.garrison }, deps.catalog, deps.params);
  }
  const v2 = garrison ? outcomeOf(deps.resolve, { ...input, garrison: null }, deps.catalog, deps.params) : v0;
  const garrisonStrength = garrison ? garrison.strength : 0;
  return {
    battleId: row.battleId, systemId: row.systemId, objective: row.objective, settledAt: row.settledAt,
    factionA: input.sideA ? input.sideA.factionId : null, factionB: input.sideB ? input.sideB.factionId : null,
    powerA: sidePower(input.sideA, deps.powerTable), powerB: sidePower(input.sideB, deps.powerTable),
    garrisonSide: garrison ? garrison.side : null, garrisonStrength, stationPtsNow,
    influencePart: garrison ? Math.max(0, garrisonStrength - stationPtsNow) : 0, v1GarrisonStrength: v1Strength,
    v1GarrisonSide: v1Side,
    recorded, v0: v0.outcome, v1: v1.outcome, v2: v2.outcome,
    parity: v0.outcome === recorded,
    paramsMatch: typeof recordedHash === "string" && recordedHash === deps.params.paramsHash,
    approx: garrison !== null,
    lossesA: Number(row.lossesA) || 0, lossesB: Number(row.lossesB) || 0,
    controllerNow: row.controllerNow === undefined ? null : row.controllerNow,
    occupationNow: row.occupationNow === undefined ? null : row.occupationNow,
  };
}

function pairsOf(battles) {
  const map = new Map();
  for (const b of battles) {
    const lo = Math.min(b.factionA, b.factionB);
    const hi = Math.max(b.factionA, b.factionB);
    const key = `${b.systemId}:${lo}:${hi}`;
    let p = map.get(key);
    if (!p) {
      p = { systemId: b.systemId, factionLo: lo, factionHi: hi, battles: 0, recorded: emptyCounts(),
        v1: emptyCounts(), v2: emptyCounts(), lossesLo: 0, lossesHi: 0, controllerNow: b.controllerNow,
        occupationNow: b.occupationNow };
      map.set(key, p);
    }
    p.battles += 1;
    countOutcome(p.recorded, b.recorded);
    countOutcome(p.v1, b.v1);
    countOutcome(p.v2, b.v2);
    const aIsLo = b.factionA === lo;
    p.lossesLo += aIsLo ? b.lossesA : b.lossesB;
    p.lossesHi += aIsLo ? b.lossesB : b.lossesA;
  }
  return [...map.values()].sort((x, y) => y.battles - x.battles || x.systemId - y.systemId
    || x.factionLo - y.factionLo || x.factionHi - y.factionHi);
}

function auditBattles(rows, deps) {
  const battles = [];
  const unreadable = [];
  for (const row of rows || []) {
    try {
      battles.push(auditOne(row, deps));
    } catch (err) {
      unreadable.push({ battleId: row && row.battleId, detail: String((err && err.message) || err) });
    }
  }
  const totals = { recorded: emptyCounts(), v0: emptyCounts(), v1: emptyCounts(), v2: emptyCounts() };
  for (const b of battles) {
    for (const k of ["recorded", "v0", "v1", "v2"]) countOutcome(totals[k], b[k]);
  }
  const thresholds = deps.thresholds || GATE;
  return { battles, unreadable, totals, pairs: pairsOf(battles), gate: gateOf(battles, thresholds),
    gateInfluence: gateOf(battles, thresholds, (b) => b.influencePart > 0) };
}

module.exports = { GATE, OUTCOMES, VERDICT, REFUSED_PREFIX, isRefused, stationPointsOf, offGarrisonOf, gateOf,
  auditBattles };
