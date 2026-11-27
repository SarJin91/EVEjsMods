"use strict";

const { evaluate: defaultEvaluate, paramsFor } = require("./metrics");
const { stableJson } = require("../../lib/util/fingerprint");
const { createRng } = require("../../lib/util/rng");
const { validateInput } = require("../../lib/battle/contract");

function gridValues(g) {
  const n = Math.round((g.to - g.from) / g.step);
  const out = [];
  for (let k = 0; k <= n; k += 1) out.push(Number((g.from + k * g.step).toFixed(6)));
  return out;
}

function product(lists) {
  let out = [[]];
  for (const list of lists) out = out.flatMap((prefix) => list.map((v) => [...prefix, v]));
  return out;
}

const sumCount = (list, pred = () => true) => list.filter(pred).reduce((n, g) => n + g.count, 0);
const sideOf = (g) => (g.fleetId.startsWith("fleet_a") ? "A" : "B");

function checkGuards(knobs, ctx) {
  const { method, resolver, catalog, config, scenarios, efsBuilders } = ctx;
  const G = method.guards;
  const params = paramsFor(config, knobs);
  const { SCENARIOS } = scenarios;
  const failures = [];
  const table = [];
  const run = (input) => {
    const r = resolver.resolve(input, catalog, params);
    if (!r.ok) throw Object.assign(new Error(r.reason), { refusal: r });
    return r.result;
  };
  const trials = (build) => {
    const out = [];
    for (let seed = 1; seed <= G.trials; seed += 1) out.push(run(build(seed)));
    return out;
  };
  const check = (cond, line) => { table.push(line); if (!cond) failures.push(line); };
  try {
    const big = trials((s) => SCENARIOS.outnumber(s, false));
    const swapped = trials((s) => SCENARIOS.outnumber(s, true));
    const aWins = big.filter((r) => r.outcome === "A_WIN").length;
    const bWins = swapped.filter((r) => r.outcome === "B_WIN").length;
    const escaped = big.filter((r) => sumCount(r.escapedShips, (g) => sideOf(g) === "B") > 0).length;
    check(aWins >= G.outnumberMinWin * G.trials && bWins >= G.outnumberMinWin * G.trials, `a win ${aWins}/${bWins}`);
    check(escaped >= G.outnumberMinEscaped * G.trials, `a escaped ${escaped}`);
    const lossBc = (rs) => rs.reduce((n, r) => n + sumCount(r.destroyedShips,
      (g) => sideOf(g) === "A" && g.hullGroup === "battlecruiser"), 0) / G.trials;
    const withLogi = lossBc(trials((s) => SCENARIOS.logistics(s, true)));
    const noLogi = lossBc(trials((s) => SCENARIOS.logistics(s, false)));
    check(withLogi < noLogi, `b BC losses ${withLogi} < ${noLogi}`);
    const escapedShare = (rs) => rs.reduce((n, r) => n + sumCount(r.escapedShips, (g) => sideOf(g) === "B"), 0)
      / (3 * G.trials);
    const free = escapedShare(trials((s) => SCENARIOS.scout(s, false)));
    const tackled = escapedShare(trials((s) => SCENARIOS.scout(s, true)));
    check(free >= G.scoutMinEscaped && tackled < free, `c scouts ${free} / ${tackled}`);
    const esc = trials(SCENARIOS.escort);
    const escOk = esc.filter((r) => r.objectiveAchieved && sumCount(r.destroyedShips, (g) => sideOf(g) === "A") > 0)
      .length;
    check(escOk >= G.escortMinAchievedWithLoss * G.trials, `d escort ${escOk}`);
    const bWin = (rs) => rs.filter((r) => r.outcome === "B_WIN").length;
    const garr = bWin(trials((s) => SCENARIOS.capture(s, true)));
    const bare = bWin(trials((s) => SCENARIOS.capture(s, false)));
    check(garr > bare + G.garrisonMinGain * G.trials, `e garrison ${garr} vs ${bare}`);
    const del = trials(SCENARIOS.delay);
    const delOk = del.filter((r) => r.objectiveAchieved).length;
    const delLost = del.filter((r) => r.objectiveAchieved && r.outcome === "B_WIN").length;
    check(delOk >= G.delayMinAchieved * G.trials && delLost > 0, `f delay ${delOk} / ${delLost}`);
    let simA = 0;
    let simB = 0;
    for (let seed = 1; seed <= G.similarTrials; seed += 1) {
      const o = run(SCENARIOS.similar(seed)).outcome;
      if (o === "A_WIN") simA += 1; else if (o === "B_WIN") simB += 1;
    }
    check(Math.abs(simB - simA) <= G.similarMaxGap * G.similarTrials, `similar A ${simA} B ${simB}`);
  } catch (err) {
    if (!err.refusal) throw err;
    failures.push(`refusal ${err.refusal.reason} ${err.refusal.detail}`);
  }
  const budget = config.battle.maxResolutionMs * params.workUnitsPerMs;
  const rng = createRng(G.benchSeed);
  const inputs = [];
  for (let n = 0; n < G.benchBattles; n += 1) inputs.push(scenarios.mediumBattle(rng, n));
  if (efsBuilders && efsBuilders.L1) inputs.push(efsBuilders.L1(1));
  let maxUnits = 0;
  for (const input of inputs) {
    const v = validateInput(input, params.limits);
    if (!v.ok) { failures.push(`budget input ${v.detail}`); break; }
    maxUnits = Math.max(maxUnits, resolver.estimateWorkUnits(v.input, params));
  }
  check(maxUnits <= budget, `budget max work ${maxUnits} <= ${budget}`);
  return { ok: failures.length === 0, failures, table };
}

function search(dataset, efsResults, startKnobs, ctx) {
  const method = ctx.method;
  const evaluate = ctx.evaluate || defaultEvaluate;
  const guard = ctx.guard || checkGuards;
  const log = ctx.log || (() => {});
  const evalCache = new Map();
  const guardCache = new Map();
  const guardOf = (knobs) => {
    const k = stableJson(knobs);
    if (!guardCache.has(k)) guardCache.set(k, guard(knobs, ctx));
    return guardCache.get(k);
  };
  const evalOf = (knobs, withEfs) => {
    const k = `${withEfs}|${stableJson(knobs)}`;
    if (!evalCache.has(k)) evalCache.set(k, evaluate(dataset, efsResults, knobs, { ...ctx, withEfs }));
    return evalCache.get(k);
  };
  const guardRejected = [];
  let current = { ...startKnobs };
  const path = [];
  for (let pass = 1; pass <= method.search.passes; pass += 1) {
    let changed = false;
    for (const step of method.search.steps) {
      const withEfs = step.efs !== false;
      const grids = step.grids.map(gridValues);
      let best = null;
      for (const values of product(grids)) {
        const knobs = { ...current };
        step.knobs.forEach((name, i) => { knobs[name] = values[i]; });
        const g = guardOf(knobs);
        if (!g.ok) { guardRejected.push({ knobs, failures: g.failures }); continue; }
        const ev = evalOf(knobs, withEfs);
        if (ev.refusals > 0) { guardRejected.push({ knobs, failures: [`dataset refusals ${ev.refusals}`] }); continue; }
        const dist = step.knobs.reduce((s, name, i) => s + Math.abs(values[i] - current[name]) / step.grids[i].step, 0);
        if (!best || ev.J < best.J || (ev.J === best.J && dist < best.dist)) best = { knobs, J: ev.J, dist, values };
      }
      const from = step.knobs.map((n) => current[n]);
      if (best && step.knobs.some((n, i) => best.values[i] !== current[n])) {
        current = best.knobs;
        changed = true;
      }
      path.push({ pass, knobs: step.knobs, from, to: step.knobs.map((n) => current[n]), J: best ? best.J : null,
        candidates: product(grids).length });
      log(`pass ${pass} ${step.knobs.join("+")}: ${from.join(",")} -> ${step.knobs.map((n) => current[n]).join(",")} `
        + `J ${best ? best.J.toFixed(6) : "-"}`);
    }
    if (!changed) break;
  }
  const before = evalOf(startKnobs, true);
  const after = evalOf(current, true);
  return { best: current, path,
    guards: { checked: guardCache.size, rejected: guardRejected.length, rejectedSample: guardRejected.slice(0, 20),
      start: guardOf(startKnobs), final: guardOf(current) },
    before, after };
}

module.exports = { search, checkGuards, gridValues };
