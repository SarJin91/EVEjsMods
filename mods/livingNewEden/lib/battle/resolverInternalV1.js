"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { validateInput, validateResult } = require("./contract");

const RESOLVER_VERSION = "internal-v1";
const SUPPLY_FULL = 100;
const DIAG_PRECISION = 1000;
const SOURCE_HASH_CHARS = 16;
const PERMILLE = 1000;
const RETREAT_PERMILLE_TOLERANCE = 1e-9;

const END_OUTCOME = Object.freeze({
  WIPED_A: "B_WIN", WIPED_B: "A_WIN", WIPED_BOTH: "DRAW", RETREAT_A: "B_WIN", RETREAT_B: "A_WIN",
  BOTH_RETREAT: "BOTH_RETREAT", STALEMATE: "BOTH_RETREAT", ROUND_LIMIT: "DRAW",
  SCOUT_RETREAT_A: "B_WIN", SCOUT_RETREAT_B: "A_WIN",
});
const A_PRESENT = Object.freeze(["WIPED_B", "RETREAT_B", "SCOUT_RETREAT_B", "ROUND_LIMIT"]);

const aPresent = (s) => A_PRESENT.includes(s.endReason);
const OBJECTIVE_RULES = Object.freeze({
  destroy: (s, m) => s.outcome === "A_WIN" && s.lossFractionB >= m.destroyMinEnemyLoss,
  capture: (s) => s.outcome === "A_WIN",
  defend: (s) => aPresent(s),
  delay: (s, m) => s.outcome === "A_WIN" || s.roundsHeldA >= m.delayRounds,
  escort: (s, m) => (s.convoyInitial === 0 ? aPresent(s)
    : s.convoyInitial - s.convoyDestroyed >= m.escortMinSurvival * s.convoyInitial),
});
const ENVIRONMENT_KEYS = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole", "other"]);

const PARAM_RULES = Object.freeze([
  ["maxRounds", 1, 50, true], ["roundSec", 1, 600, false], ["workUnitsPerMs", 1, 10000000, false],
  ["dpsScale", 0.01, 10, false], ["ehpScale", 0.01, 10, false], ["repScale", 0, 10, false],
  ["roundVariance", 0, 0.9, false], ["retreatLossFraction", 0.05, 1, false], ["retreatPowerRatio", 1, 100, false],
  ["garrisonDpsPerPoint", 0, 10000, false], ["garrisonEhpPerPoint", 0, 1000000, false],
  ["modelConfidence", 0.01, 1, false],
]);
const MODEL_RULES = Object.freeze([
  ["defenderMorale", 0, 100, false], ["garrisonMoraleBonus", 0, 100, false], ["garrisonSignature", 1, 1e9, false],
  ["scoutRetreatPowerRatio", 0, 100, false], ["stalemateRounds", 1, 50, true], ["delayRounds", 1, 50, true],
  ["destroyMinEnemyLoss", 0, 1, false], ["escortMinSurvival", 0, 1, false], ["convoyTargetWeight", 0, 100, false],
  ["applicationMin", 0.0001, 1, false], ["alphaScale", 0, 100, false], ["repMaxMitigation", 0, 1, false],
  ["ewarPerShip", 0, 100, false], ["ewarMaxReduction", 0, 1, false], ["supplyMinFactor", 0, 1, false],
  ["escapeBase", -1, 2, false], ["escapeSpeedStep", -1, 1, false], ["tacklePenalty", 0, 2, false],
  ["tackleTargetsPerShip", 0, 100, false], ["escapeMin", 0, 1, false], ["escapeMax", 0, 1, false],
  ["pursuitDamageFactor", 0, 100, false], ["exactDrawMax", 0, 100000, true],
]);
const LIMIT_FIELDS = Object.freeze(["maxFleetsPerSide", "maxCompositionEntries", "maxShipsPerFleet",
  "maxResolutionMs", "maxResultBytes"]);

const refuse = (reason, detail) => ({ ok: false, reason, detail: String(detail) });
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const diag = (v) => Math.round(v * DIAG_PRECISION) / DIAG_PRECISION;

function ruleProblem(obj, rules, where) {
  for (const [field, min, max, integer] of rules) {
    const v = obj[field];
    if (!isNum(v) || v < min || v > max || (integer && !Number.isInteger(v))) return `${where}.${field}=${v}`;
  }
  return null;
}

function paramsProblem(params) {
  if (!params || typeof params !== "object" || !Object.isFrozen(params)) return "params not a frozen object";
  const limits = params.limits;
  if (!limits || typeof limits !== "object") return "params.limits missing";
  for (const name of LIMIT_FIELDS) if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) return `limits.${name}`;
  const own = ruleProblem(params, PARAM_RULES, "params");
  if (own) return own;
  const m = params.model;
  if (!m || typeof m !== "object" || m.modelVersion !== RESOLVER_VERSION) return "params.model.modelVersion";
  const modelErr = ruleProblem(m, MODEL_RULES, "model");
  if (modelErr) return modelErr;
  if (m.escapeMin > m.escapeMax) return "model.escapeMin > escapeMax";
  for (const name of Object.keys(OBJECTIVE_RULES)) {
    if (!m.objectiveMorale || !isNum(m.objectiveMorale[name]) || m.objectiveMorale[name] <= 0) {
      return `model.objectiveMorale.${name}`;
    }
  }
  for (const name of ENVIRONMENT_KEYS) if (!m.escapeEnv || !isNum(m.escapeEnv[name])) return `model.escapeEnv.${name}`;
  if (typeof params.paramsHash !== "string" || params.paramsHash.length === 0) return "params.paramsHash";
  return null;
}

const groupCount = (side) => side.fleets.reduce((n, f) => n + f.composition.length, 0);

function estimateWorkUnits(input, params) {
  const ga = groupCount(input.sideA);
  let gb = groupCount(input.sideB);
  if (input.fixedDefenses) gb += input.fixedDefenses.entries.length;
  return (params.maxRounds + 2) * (2 * (ga + 1) * (gb + 1) + ga + gb);
}

function strengthProblem(s) {
  if (!s || typeof s !== "object") return "strength missing";
  for (const f of ["dps", "alpha", "repPerSec", "ewarFactor", "tackleFactor"]) {
    if (!isNum(s[f]) || s[f] < 0) return `strength.${f}`;
  }
  for (const f of ["ehp", "signatureRadius", "designSig", "speedClass"]) {
    if (!isNum(s[f]) || s[f] <= 0) return `strength.${f}`;
  }
  return null;
}

function buildSide(name, side, catalog, ctx, fixedDefenses) {
  const { params, model, escort } = ctx;
  const groups = [];
  let scout = side.fleets.length > 0;
  for (const fleet of side.fleets) {
    if (fleet.fleetRole !== "scout") scout = false;
    const supply = model.supplyMinFactor + (1 - model.supplyMinFactor) * fleet.supplyState / SUPPLY_FULL;
    for (const e of fleet.composition) {
      const found = catalog.lookup(e.hullGroup, e.typeId);
      if (!found || found.ok !== true) return { error: `lookup ${e.hullGroup}/${e.typeId}: ${found && found.reason}` };
      const problem = strengthProblem(found.strength);
      if (problem) return { error: `${e.hullGroup}/${e.typeId}: ${problem}` };
      const s = found.strength;
      groups.push({
        fleetId: fleet.fleetId, hullGroup: e.hullGroup, typeId: e.typeId, count: e.count,
        alive: e.count, destroyed: 0, escaped: 0, pool: 0,
        dps: s.dps, alpha: s.alpha, ehp: s.ehp * params.ehpScale, rep: s.repPerSec, sig: s.signatureRadius,
        designSig: s.designSig, speed: s.speedClass, ewar: s.ewarFactor, tackle: s.tackleFactor, supply,
        convoy: escort && name === "A" && (e.hullGroup === "industrial" || fleet.fleetRole === "logistics"),
        confidence: isNum(found.confidence) ? clamp(found.confidence, 0, 1) : 0,
        fallback: found.source === "group" && found.note !== null && found.note !== undefined,
      });
    }
  }
  const fixed = fixedDefenses ? fixedDefenses.entries.map((e) => ({ sentryId: e.sentryId, ehp: e.ehp, dps: e.dps,
    sig: e.signature, designSig: e.designSig, alive: true, pool: 0 })) : [];
  let initialEhp = 0;
  for (const g of groups) initialEhp += g.count * g.ehp;
  for (const f of fixed) initialEhp += f.ehp;
  return { side: { name, groups, fixed, scout, garrison: null, initialEhp, destroyedEhp: 0 } };
}

function aliveFixed(side) {
  let n = 0;
  for (const f of side.fixed) if (f.alive) n += 1;
  return n;
}

function fixedWeight(side) {
  let w = 0;
  for (const f of side.fixed) if (f.alive) w += f.sig;
  return w;
}

function aliveShips(side) {
  let n = 0;
  for (const g of side.groups) n += g.alive;
  return n;
}

function aliveEhp(side) {
  let e = 0;
  for (const g of side.groups) e += g.alive * g.ehp - g.pool;
  const gar = side.garrison;
  if (gar && gar.alive) e += gar.ehp - gar.pool;
  for (const f of side.fixed) if (f.alive) e += f.ehp - f.pool;
  return e;
}

function weightOf(g, model) {
  return g.alive * g.sig * (g.convoy ? model.convoyTargetWeight : 1);
}

function totalWeight(side, model, withGarrison) {
  let w = 0;
  for (const g of side.groups) w += weightOf(g, model);
  if (withGarrison && side.garrison && side.garrison.alive) w += model.garrisonSignature;
  for (const f of side.fixed) if (f.alive) w += f.sig;
  return w;
}

function application(target, totalW, designSig, model, withGarrison) {
  let sum = 0;
  for (const g of target.groups) {
    const w = weightOf(g, model);
    if (w > 0) sum += w * clamp(g.sig / designSig, model.applicationMin, 1);
  }
  if (withGarrison && target.garrison && target.garrison.alive) {
    sum += model.garrisonSignature * clamp(model.garrisonSignature / designSig, model.applicationMin, 1);
  }
  for (const f of target.fixed) if (f.alive) sum += f.sig * clamp(f.sig / designSig, model.applicationMin, 1);
  return sum / totalW;
}

function ewarMultiplier(shooter, jammer, model) {
  let shooters = aliveShips(shooter);
  if (shooter.fixed.length > 0) shooters += aliveFixed(shooter);
  if (shooters === 0) return 1;
  let jam = 0;
  for (const g of jammer.groups) jam += g.alive * g.ewar;
  return 1 - Math.min(model.ewarMaxReduction, model.ewarPerShip * jam / shooters);
}

function damageOut(attacker, target, totalW, opt, ctx) {
  const { params, model } = ctx;
  if (totalW <= 0) return 0;
  const cache = new Map();
  let dpsPart = 0;
  let alphaPart = 0;
  for (const g of attacker.groups) {
    if (g.alive === 0) continue;
    let app = cache.get(g.designSig);
    if (app === undefined) {
      app = application(target, totalW, g.designSig, model, opt.garrison);
      cache.set(g.designSig, app);
    }
    dpsPart += g.alive * g.dps * g.supply * app;
    if (opt.alpha) alphaPart += g.alive * g.alpha * app;
  }
  for (const f of attacker.fixed) {
    if (!f.alive) continue;
    let app = cache.get(f.designSig);
    if (app === undefined) {
      app = application(target, totalW, f.designSig, model, opt.garrison);
      cache.set(f.designSig, app);
    }
    dpsPart += f.dps * app;
  }
  const ewar = ewarMultiplier(attacker, target, model);
  let d = (dpsPart * params.dpsScale * params.roundSec + alphaPart * model.alphaScale) * ewar * opt.variance
    * opt.factor;
  const gar = attacker.garrison;
  if (opt.garrison && gar && gar.alive) {
    d += params.garrisonDpsPerPoint * gar.strength * params.dpsScale * params.roundSec;
  }
  return d;
}

function repsOf(side, ctx) {
  let r = 0;
  for (const g of side.groups) r += g.alive * g.rep * g.supply;
  return r * ctx.params.repScale * ctx.params.roundSec;
}

function applyDamage(side, damageIn, totalW, rng, ctx, withGarrison) {
  const { model } = ctx;
  for (const g of side.groups) {
    const u = rng.nextFloat();
    const w = weightOf(g, model);
    if (w === 0 || damageIn <= 0) continue;
    g.pool += damageIn * w / totalW;
    const x = g.pool / g.ehp;
    const whole = Math.floor(x);
    const k = Math.min(g.alive, whole + (u < x - whole ? 1 : 0));
    if (k > 0) {
      g.alive -= k;
      g.destroyed += k;
      side.destroyedEhp += k * g.ehp;
      g.pool = Math.max(0, g.pool - k * g.ehp);
    }
    if (g.alive === 0) g.pool = 0;
  }
  const gar = side.garrison;
  if (withGarrison && gar && gar.alive && damageIn > 0) {
    gar.pool += damageIn * model.garrisonSignature / totalW;
    if (gar.pool >= gar.ehp) {
      gar.pool = gar.ehp;
      gar.alive = false;
    }
  }
  if (side.fixed.length > 0 && damageIn > 0) applyFixedDamage(side, damageIn * fixedWeight(side) / totalW);
}

function applyFixedDamage(side, share) {
  const order = side.fixed.filter((f) => f.alive).sort((x, y) => {
    const rx = x.ehp - x.pool;
    const ry = y.ehp - y.pool;
    if (rx !== ry) return rx - ry;
    return x.sentryId < y.sentryId ? -1 : x.sentryId > y.sentryId ? 1 : 0;
  });
  let left = share;
  for (const f of order) {
    if (left <= 0) break;
    const rest = f.ehp - f.pool;
    if (left >= rest) {
      side.destroyedEhp += rest;
      left -= rest;
      f.pool = f.ehp;
      f.alive = false;
    } else {
      side.destroyedEhp += left;
      f.pool += left;
      left = 0;
    }
  }
}

function phaseRng(ctx, phase, round) {
  return createRng(deriveSeed(ctx.seed, RESOLVER_VERSION, phase, round));
}

const variance = (u, params) => 1 + params.roundVariance * (2 * u - 1);

function exchange(A, B, round, ctx, expected) {
  const wA = totalWeight(A, ctx.model, true);
  const wB = totalWeight(B, ctx.model, true);
  let vA = 1;
  let vB = 1;
  if (!expected) {
    const fire = phaseRng(ctx, "fire", round);
    vA = variance(fire.nextFloat(), ctx.params);
    vB = variance(fire.nextFloat(), ctx.params);
  }
  const alpha = round <= 1;
  const outA = damageOut(A, B, wB, { alpha, variance: vA, factor: 1, garrison: true }, ctx);
  const outB = damageOut(B, A, wA, { alpha, variance: vB, factor: 1, garrison: true }, ctx);
  const mit = ctx.model.repMaxMitigation;
  const inA = outB - Math.min(repsOf(A, ctx), mit * outB);
  const inB = outA - Math.min(repsOf(B, ctx), mit * outA);
  return { inA, inB, wA, wB };
}

function escapeChance(g, cover, avgSpeedY, ctx) {
  const m = ctx.model;
  const p = m.escapeBase + m.escapeSpeedStep * (g.speed - avgSpeedY) - m.tacklePenalty * cover
    + m.escapeEnv[ctx.environment];
  return clamp(p, m.escapeMin, m.escapeMax);
}

function escapeCount(alive, p, rng, model) {
  if (alive <= model.exactDrawMax) {
    let n = 0;
    for (let i = 0; i < alive; i += 1) if (rng.nextFloat() < p) n += 1;
    return n;
  }
  const x = alive * p;
  const whole = Math.floor(x);
  return Math.min(alive, whole + (rng.nextFloat() < x - whole ? 1 : 0));
}

function rollEscape(X, Y, rng, ctx, pick) {
  const fleeing = aliveShips(X);
  if (fleeing === 0) return;
  let tackle = 0;
  let speedSum = 0;
  let yAlive = 0;
  for (const g of Y.groups) {
    tackle += g.alive * g.tackle;
    speedSum += g.alive * g.speed;
    yAlive += g.alive;
  }
  const cover = Math.min(1, ctx.model.tackleTargetsPerShip * tackle / fleeing);
  const avgSpeedY = yAlive > 0 ? speedSum / yAlive : 0;
  for (const g of X.groups) {
    if (g.alive === 0 || !pick(g)) continue;
    const n = escapeCount(g.alive, escapeChance(g, cover, avgSpeedY, ctx), rng, ctx.model);
    g.alive -= n;
    g.escaped += n;
    if (g.alive === 0) g.pool = 0;
  }
}

function allEscape(side) {
  for (const g of side.groups) {
    g.escaped += g.alive;
    g.alive = 0;
    g.pool = 0;
  }
}

function flee(X, Y, round, ctx, state, escapeRng) {
  rollEscape(X, Y, escapeRng, ctx, () => true);
  if (aliveShips(X) > 0) {
    state.pursuit = 1;
    const rng = phaseRng(ctx, "pursuit", round);
    const v = variance(rng.nextFloat(), ctx.params);
    const w = totalWeight(X, ctx.model, false);
    const out = damageOut(Y, X, w, { alpha: false, variance: v, factor: ctx.model.pursuitDamageFactor,
      garrison: false }, ctx);
    applyDamage(X, out, w, rng, ctx, false);
  }
  allEscape(X);
}

function lossFraction(side) {
  return side.destroyedEhp / side.initialEhp;
}

function wantsRetreat(X, Y, inX, inY, round, ctx) {
  const { params, model, objective } = ctx;
  if (X.fixed.length > 0 && aliveShips(X) === 0) return false;
  const morale = X.name === "A" ? model.objectiveMorale[objective] : model.defenderMorale;
  let threshold = params.retreatLossFraction * morale;
  if (X.name === "A" && ctx.attackerRetreatLoss !== null) threshold = Math.min(threshold, ctx.attackerRetreatLoss);
  if (X.garrison && X.garrison.alive) threshold += model.garrisonMoraleBonus;
  if (lossFraction(X) >= threshold) return true;
  if (X.name === "A" && ctx.attackerRetreatLossPermille !== null && X.destroyedEhp * PERMILLE
    >= ctx.attackerRetreatLossPermille * X.initialEhp * (1 - RETREAT_PERMILLE_TOLERANCE)) return true;
  let ratio = params.retreatPowerRatio;
  if (X.name === "A" && objective === "delay") {
    if (round < model.delayRounds) return false;
    ratio = 1;
  }
  return inX * aliveEhp(Y) > ratio * inY * aliveEhp(X);
}

function fight(A, B, ctx) {
  const { params, model } = ctx;
  const state = { endReason: null, rounds: 0, pursuit: 0, roundsHeldA: 0 };
  const other = (X) => (X === A ? B : A);

  if (A.scout || B.scout) {
    const ex = exchange(A, B, 1, ctx, true);
    const r = model.scoutRetreatPowerRatio;
    const runA = A.scout && ex.inA * aliveEhp(B) > r * ex.inB * aliveEhp(A);
    const runB = B.scout && ex.inB * aliveEhp(A) > r * ex.inA * aliveEhp(B);
    if (runA && runB) {
      allEscape(A);
      allEscape(B);
      state.endReason = "BOTH_RETREAT";
      return state;
    }
    if (runA || runB) {
      const X = runA ? A : B;
      flee(X, other(X), 0, ctx, state, phaseRng(ctx, "escape", 0));
      state.endReason = `SCOUT_RETREAT_${X.name}`;
      return state;
    }
  }

  let stalemate = 0;
  for (let round = 1; round <= params.maxRounds; round += 1) {
    state.rounds = round;
    const ex = exchange(A, B, round, ctx, false);
    const kill = phaseRng(ctx, "kill", round);
    applyDamage(A, ex.inA, ex.wA, kill, ctx, true);
    applyDamage(B, ex.inB, ex.wB, kill, ctx, true);
    const nA = aliveShips(A);
    let nB = aliveShips(B);
    if (B.fixed.length > 0) nB += aliveFixed(B);
    if (nA === 0 || nB === 0) {
      if (nA > 0) state.roundsHeldA = round;
      state.endReason = nA === 0 && nB === 0 ? "WIPED_BOTH" : nA === 0 ? "WIPED_A" : "WIPED_B";
      return state;
    }
    state.roundsHeldA = round;
    if (ex.inA === 0 && ex.inB === 0) {
      stalemate += 1;
      if (stalemate >= model.stalemateRounds) {
        allEscape(A);
        allEscape(B);
        state.endReason = "STALEMATE";
        return state;
      }
      continue;
    }
    stalemate = 0;
    const escapeRng = phaseRng(ctx, "escape", round);
    if (ctx.escort && round === 1 && ctx.convoyInitial > 0) {
      rollEscape(A, B, escapeRng, ctx, (g) => g.convoy);
      if (aliveShips(A) === 0) {
        state.endReason = "RETREAT_A";
        return state;
      }
    }
    const runA = wantsRetreat(A, B, ex.inA, ex.inB, round, ctx);
    const runB = wantsRetreat(B, A, ex.inB, ex.inA, round, ctx);
    if (runA && runB) {
      allEscape(A);
      allEscape(B);
      state.endReason = "BOTH_RETREAT";
      return state;
    }
    if (runA || runB) {
      const X = runA ? A : B;
      flee(X, other(X), round, ctx, state, escapeRng);
      state.endReason = `RETREAT_${X.name}`;
      return state;
    }
  }
  state.endReason = "ROUND_LIMIT";
  return state;
}

function shipLists(sides) {
  const destroyedShips = [];
  const escapedShips = [];
  const survivingShips = [];
  for (const side of sides) {
    for (const g of side.groups) {
      const base = { fleetId: g.fleetId, hullGroup: g.hullGroup, typeId: g.typeId };
      if (g.destroyed > 0) destroyedShips.push({ ...base, count: g.destroyed });
      if (g.escaped > 0) escapedShips.push({ ...base, count: g.escaped });
      if (g.alive > 0) survivingShips.push({ ...base, count: g.alive });
    }
  }
  return { destroyedShips, escapedShips, survivingShips };
}

function core(input, catalog, params) {
  const checked = validateInput(input, params.limits);
  if (!checked.ok) return refuse("INPUT_INVALID", checked.detail);
  const inp = checked.input;
  if (inp.resolverVersion !== RESOLVER_VERSION) return refuse("RESOLVER_VERSION_MISMATCH", inp.resolverVersion);
  const header = catalog.header;
  if (!header || typeof header.methodVersion !== "string" || typeof header.sourceHash !== "string") {
    return refuse("CATALOG_INVALID", "catalog.header.methodVersion / sourceHash");
  }
  const workUnits = estimateWorkUnits(inp, params);
  const budget = inp.maxResolutionMs * params.workUnitsPerMs;
  if (workUnits > budget) return refuse("RESOLVER_BUDGET", `workUnits ${workUnits} > ${budget}`);

  const model = params.model;
  const fd = inp.fixedDefenses || null;
  const ctx = { params, model, seed: inp.seed, objective: inp.objective, environment: inp.environment,
    escort: inp.objective === "escort", convoyInitial: 0,
    attackerRetreatLoss: fd ? fd.attackerRetreatLossPermille / PERMILLE : null,
    attackerRetreatLossPermille: fd ? fd.attackerRetreatLossPermille : null };
  const a = buildSide("A", inp.sideA, catalog, ctx, null);
  if (a.error) return refuse("CATALOG_INVALID", a.error);
  const b = buildSide("B", inp.sideB, catalog, ctx, fd);
  if (b.error) return refuse("CATALOG_INVALID", b.error);
  const A = a.side;
  const B = b.side;
  const g = inp.garrison;
  if (g && g.strength > 0 && params.garrisonEhpPerPoint > 0) {
    (g.side === "A" ? A : B).garrison = { strength: g.strength, ehp: params.garrisonEhpPerPoint * g.strength,
      pool: 0, alive: true };
  }
  for (const grp of A.groups) if (grp.convoy) ctx.convoyInitial += grp.count;

  const state = fight(A, B, ctx);

  let convoyDestroyed = 0;
  for (const grp of A.groups) if (grp.convoy) convoyDestroyed += grp.destroyed;
  const outcome = END_OUTCOME[state.endReason];
  const summary = { outcome, endReason: state.endReason, lossFractionB: lossFraction(B),
    roundsHeldA: state.roundsHeldA, convoyInitial: ctx.convoyInitial, convoyDestroyed };
  const objectiveAchieved = Boolean(OBJECTIVE_RULES[inp.objective](summary, model));

  let ships = 0;
  let weighted = 0;
  let minConfidence = 1;
  let fallbacks = 0;
  for (const grp of [...A.groups, ...B.groups]) {
    ships += grp.count;
    weighted += grp.count * grp.confidence;
    minConfidence = Math.min(minConfidence, grp.confidence);
    if (grp.fallback) fallbacks += 1;
  }
  const gar = A.garrison || B.garrison;
  const diagnostics = {
    rounds: state.rounds, endReason: state.endReason, lossFractionA: diag(lossFraction(A)),
    lossFractionB: diag(lossFraction(B)), pursuit: state.pursuit,
    garrisonRemaining: gar ? diag(gar.alive ? (gar.ehp - gar.pool) / gar.ehp : 0) : -1,
    strengthFallbacks: fallbacks, minStrengthConfidence: diag(minConfidence), workUnits,
    paramsHash: params.paramsHash, catalogMethod: header.methodVersion,
    catalogSourceHash: header.sourceHash.slice(0, SOURCE_HASH_CHARS),
  };
  if (ctx.escort) {
    diagnostics.convoyInitial = ctx.convoyInitial;
    diagnostics.convoySaved = ctx.convoyInitial - convoyDestroyed;
    diagnostics.escortNoConvoy = ctx.convoyInitial === 0 ? 1 : 0;
  }
  const result = {
    battleId: inp.battleId, resolver: RESOLVER_VERSION, outcome, ...shipLists([A, B]), objectiveAchieved,
    estimatedDurationSec: (state.rounds + state.pursuit) * params.roundSec,
    confidence: diag(params.modelConfidence * weighted / ships),
    diagnostics,
  };
  if (B.fixed.length > 0) {
    let total = 0;
    let remaining = 0;
    result.fixedDefenseOutcome = B.fixed.map((f) => {
      total += f.ehp;
      remaining += f.ehp - f.pool;
      return { sentryId: f.sentryId, damage: f.alive ? Math.min(f.ehp - 1, Math.floor(f.pool)) : f.ehp,
        destroyed: !f.alive };
    });
    diagnostics.fixedDestroyed = B.fixed.length - aliveFixed(B);
    diagnostics.fixedRemainingPermille = Math.floor(remaining * PERMILLE / total);
  }
  const valid = validateResult(inp, result, { maxResultBytes: params.limits.maxResultBytes });
  if (!valid.ok) return refuse("RESOLVER_INTERNAL", `own result refused: ${JSON.stringify(valid)}`);
  return { ok: true, result: valid.result };
}

function resolve(input, catalog, params) {
  try {
    const problem = paramsProblem(params);
    if (problem) return refuse("PARAMS_INVALID", problem);
    if (!catalog || typeof catalog.lookup !== "function") return refuse("CATALOG_INVALID", "catalog.lookup missing");
    return core(input, catalog, params);
  } catch (err) {
    return refuse("RESOLVER_INTERNAL", (err && err.message) || err);
  }
}

module.exports = { RESOLVER_VERSION, END_OUTCOME, OBJECTIVE_RULES, ENVIRONMENT_KEYS, resolve, estimateWorkUnits };
