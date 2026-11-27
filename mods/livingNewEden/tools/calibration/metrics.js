"use strict";

const { deriveSeed } = require("../../lib/util/rng");
const { buildResolverParams } = require("../../lib/battle/resolverParams");
const { toBattleInput, sideStrength } = require("./dataset");

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length);

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function w1(a, b) {
  if (a.length !== b.length) throw new Error(`w1: sizes ${a.length} != ${b.length}`);
  if (a.length === 0) return 0;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

function winnerLabel(lossStrong, lossWeak, winMargin) {
  if (lossWeak - lossStrong >= winMargin) return "strong";
  if (lossStrong - lossWeak >= winMargin) return "weak";
  return "even";
}

function durationMiss(internalSec, efsSec) {
  if (!(internalSec > 0) || !(efsSec > 0)) return 0;
  const r = internalSec / efsSec;
  return (r >= 1 ? r : 1 / r) - 1;
}

function classWeight(name, battles, method) {
  const m = method.metrics;
  if (battles < m.minClassBattles) return 0;
  return name === "all" ? m.weights.all : m.weights.other;
}

const keyOf = (hullGroup, typeId) => `${hullGroup}|${typeId || 0}`;

function sideMetrics(entries, lostOf, ehpOf) {
  let total = 0;
  let lost = 0;
  let ships = 0;
  let shipsLost = 0;
  for (const e of entries) {
    const ehp = ehpOf(e);
    const l = lostOf(e);
    total += e.count * ehp;
    lost += l * ehp;
    ships += e.count;
    shipsLost += l;
  }
  return { loss: total > 0 ? lost / total : 0, notDestroyed: ships > 0 ? (ships - shipsLost) / ships : 0 };
}

const prepared = new WeakMap();

function prepare(dataset, ctx) {
  const hit = prepared.get(dataset);
  if (hit && hit.catalog === ctx.catalog && hit.method === ctx.method && hit.config === ctx.config) return hit;
  const { method, catalog, config } = ctx;
  const ehpCache = new Map();
  const ehpOf = (e) => {
    const k = keyOf(e.hullGroup, e.typeId);
    if (!ehpCache.has(k)) ehpCache.set(k, catalog.lookup(e.hullGroup, e.typeId).strength.ehp);
    return ehpCache.get(k);
  };
  const limits = { maxFleetsPerSide: config.battle.maxFleetsPerSide, maxShipsPerFleet: config.fleets.maxShipsPerFleet,
    maxCompositionEntries: config.fleets.maxCompositionEntries };
  const battles = [];
  let tooLarge = 0;
  for (const b of dataset.battles) {
    const strongIsA = sideStrength(b.sides.A, catalog).power >= sideStrength(b.sides.B, catalog).power;
    const S = strongIsA ? b.sides.A : b.sides.B;
    const W = strongIsA ? b.sides.B : b.sides.A;
    const os = sideMetrics(S, (e) => e.lost, ehpOf);
    const ow = sideMetrics(W, (e) => e.lost, ehpOf);
    const inputs = [];
    for (let i = 0; i < method.metrics.seedsPerBattle; i += 1) {
      const seed = deriveSeed(method.calibSeed, method.version, b.battleId, i);
      const r = toBattleInput(b, { seed, limits, maxResolutionMs: config.battle.maxResolutionMs });
      if (!r.ok) break;
      inputs.push(r.input);
    }
    if (inputs.length < method.metrics.seedsPerBattle) { tooLarge += 1; continue; }
    battles.push({ battleId: b.battleId, classes: b.classes, strongIsA, S, W, inputs,
      obs: { lossStrong: os.loss, lossWeak: ow.loss, notDestroyedWeak: ow.notDestroyed,
        label: winnerLabel(os.loss, ow.loss, method.metrics.winMargin) } });
  }
  const out = { catalog, method, config, battles, ehpOf, tooLarge };
  prepared.set(dataset, out);
  return out;
}

function paramsFor(config, knobs) {
  const battle = { ...config.battle, ...knobs };
  const built = buildResolverParams({ ...config, battle });
  if (!built.ok) throw new Error(`params ${built.reason} ${built.detail}`);
  return built.params;
}

function simulated(pb, result, ehpOf, winMargin) {
  const lost = { A: new Map(), B: new Map() };
  for (const g of result.destroyedShips) {
    const side = g.fleetId.startsWith("fleet_a") ? "A" : "B";
    const k = keyOf(g.hullGroup, g.typeId);
    lost[side].set(k, (lost[side].get(k) || 0) + g.count);
  }
  const sKey = pb.strongIsA ? "A" : "B";
  const wKey = pb.strongIsA ? "B" : "A";
  const s = sideMetrics(pb.S, (e) => lost[sKey].get(keyOf(e.hullGroup, e.typeId)) || 0, ehpOf);
  const w = sideMetrics(pb.W, (e) => lost[wKey].get(keyOf(e.hullGroup, e.typeId)) || 0, ehpOf);
  return { lossStrong: s.loss, lossWeak: w.loss, notDestroyedWeak: w.notDestroyed,
    label: winnerLabel(s.loss, w.loss, winMargin), durationSec: result.estimatedDurationSec };
}

function classMetrics(rows, n, method) {
  const obsS = [];
  const obsW = [];
  const simS = [];
  const simW = [];
  let obsStrong = 0;
  let simStrong = 0;
  let obsNd = 0;
  let simNd = 0;
  let simCount = 0;
  const spanObs = [];
  for (const row of rows) {
    for (const sim of row.sims) {
      obsS.push(row.obs.lossStrong);
      obsW.push(row.obs.lossWeak);
      simS.push(sim.lossStrong);
      simW.push(sim.lossWeak);
      if (sim.label === "strong") simStrong += 1;
      simNd += sim.notDestroyedWeak;
      simCount += 1;
    }
    if (row.obs.label === "strong") obsStrong += 1;
    obsNd += row.obs.notDestroyedWeak;
    spanObs.push(row.durationSec);
  }
  const battles = rows.length;
  const shareObs = battles > 0 ? obsStrong / battles : 0;
  const shareSim = simCount > 0 ? simStrong / simCount : 0;
  const ndObs = battles > 0 ? obsNd / battles : 0;
  const ndSim = simCount > 0 ? simNd / simCount : 0;
  const m = {
    battles,
    weight: classWeight(n, battles, method),
    w1Strong: w1(obsS, simS),
    w1Weak: w1(obsW, simW),
    dWin: Math.abs(shareObs - shareSim),
    dNotDestroyed: Math.abs(ndObs - ndSim),
    obs: { lossStrong: mean(rows.map((r) => r.obs.lossStrong)), lossWeak: mean(rows.map((r) => r.obs.lossWeak)),
      winStrong: shareObs, notDestroyedWeak: ndObs },
    sim: { lossStrong: mean(simS), lossWeak: mean(simW), winStrong: shareSim, notDestroyedWeak: ndSim,
      medianDurationSec: median(spanObs) },
    lowData: battles < method.metrics.minClassBattles,
  };
  m.score = m.w1Strong + m.w1Weak + m.dWin + m.dNotDestroyed;
  return m;
}

const OUTCOMES = ["A_WIN", "B_WIN", "DRAW", "BOTH_RETREAT"];

function countLosses(input, result) {
  const total = (side) => side.fleets.reduce((s, f) => s + f.composition.reduce((t, c) => t + c.count, 0), 0);
  let a = 0;
  let b = 0;
  for (const g of result.destroyedShips) {
    if (g.fleetId.startsWith("fleet_a")) a += g.count; else b += g.count;
  }
  return { A: a / Math.max(1, total(input.sideA)), B: b / Math.max(1, total(input.sideB)) };
}

function efsMajority(runs) {
  const counts = {};
  for (const r of runs) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const best = OUTCOMES.find((o) => (counts[o] || 0) * 2 > runs.length);
  return best || null;
}

function efsTerm(efsResults, params, ctx) {
  const { method, resolver, catalog, efsBuilders } = ctx;
  const m = method.metrics;
  const rows = [];
  for (const id of m.efsScenarios) {
    const sc = (efsResults.scenarios || []).find((s) => s.id === id);
    if (!sc || sc.skipped || !Array.isArray(sc.runs) || sc.runs.length === 0 || !efsBuilders[id]) continue;
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    const durations = [];
    const lossA = [];
    const lossB = [];
    let refused = 0;
    for (let i = 0; i < m.efsSeeds; i += 1) {
      const input = efsBuilders[id](deriveSeed(method.calibSeed, method.version, "efs", id, i));
      const r = resolver.resolve(input, catalog, params);
      if (!r.ok) { refused += 1; continue; }
      counts[r.result.outcome] += 1;
      durations.push(r.result.estimatedDurationSec);
      const lf = countLosses(input, r.result);
      lossA.push(lf.A);
      lossB.push(lf.B);
    }
    const ok = m.efsSeeds - refused;
    const modal = OUTCOMES.reduce((best, o) => (counts[o] > counts[best] ? o : best), OUTCOMES[0]);
    const majority = efsMajority(sc.runs);
    const drawShare = ok > 0 ? counts.DRAW / ok : 1;
    const miss = id === m.l1Id ? (drawShare > m.l1MaxDraw ? 1 : 0) : (modal !== majority ? 1 : 0);
    const dur = durationMiss(median(durations), median(sc.runs.map((r) => r.simTimeSec)));
    let dLossWinner = null;
    if (id !== m.l1Id && (majority === "A_WIN" || majority === "B_WIN")) {
      const side = majority === "A_WIN" ? "A" : "B";
      const efsLoss = mean(sc.runs.map((r) => (side === "A" ? r.lossFractionA : r.lossFractionB)));
      dLossWinner = Math.abs(mean(side === "A" ? lossA : lossB) - efsLoss);
    }
    rows.push({ id, efsMajority: majority, modal, drawShare, miss, durationMiss: dur, dLossWinner, refused,
      medianDurationSec: median(durations) });
  }
  const winnerMiss = rows.reduce((s, r) => s + r.miss, 0);
  const losses = rows.filter((r) => r.dLossWinner !== null).map((r) => r.dLossWinner);
  const score = (rows.length > 0 ? winnerMiss / rows.length : 0) + mean(rows.map((r) => r.durationMiss)) + mean(losses);
  return { rows, winnerMiss, meanDurationMiss: mean(rows.map((r) => r.durationMiss)), meanDLossWinner: mean(losses),
    score };
}

function evaluate(dataset, efsResults, knobs, ctx) {
  const { method, resolver } = ctx;
  const prep = prepare(dataset, ctx);
  const params = paramsFor(ctx.config, knobs);
  const rows = [];
  let refusals = 0;
  for (const pb of prep.battles) {
    const sims = [];
    for (const input of pb.inputs) {
      const r = resolver.resolve(input, prep.catalog, params);
      if (!r.ok) { refusals += 1; continue; }
      sims.push(simulated(pb, r.result, prep.ehpOf, method.metrics.winMargin));
    }
    if (sims.length === 0) continue;
    rows.push({ classes: pb.classes, obs: pb.obs, sims, durationSec: median(sims.map((s) => s.durationSec)) });
  }
  const perClass = {};
  let J = 0;
  for (const name of method.metrics.classes) {
    const cm = classMetrics(rows.filter((r) => r.classes.includes(name)), name, method);
    perClass[name] = cm;
    J += cm.weight * cm.score;
  }
  let efs = null;
  if (efsResults && ctx.withEfs !== false && ctx.efsBuilders) {
    efs = efsTerm(efsResults, params, ctx);
    J += method.metrics.lambdaEfs * efs.score;
  }
  return { perClass, efs, J, refusals, battles: rows.length, tooLarge: prep.tooLarge };
}

module.exports = { evaluate, w1, winnerLabel, durationMiss, classWeight, median, paramsFor, efsMajority };
