"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { VENTURE_STATES: VS, MAX_MEMBERS } = require("./schema");
const { whCandidates, routeOf, routeText, MODE } = require("./wormholeVentures");

const LOSS_ROLL_MAX = 1000000;
const PERMILLE = 1000;
const HOME_KIND = "WH_HOME";
const HAUL_KIND = "WH_HAUL";
const RAID_KIND = "WH_RAID";
const JSPACE_BAND = "wormhole";
const MAX_VENTURE_JUMPS = 64;
const LOSS_BANDS = Object.freeze(["lowsec", "nullsec"]);
const HOME_BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);
const NO_WH_HOME = Object.freeze({ ok: false, reason: "NO_WH_HOME" });

function pickWhHome({ seed, reach, env, S, isTaken }) {
  if (!Array.isArray(reach) || !env || !env.wh) return NO_WH_HOME;
  const cands = whCandidates(reach, HOME_BANDS, env, S);
  const n = Math.min(cands.length, S.whCorps.homePickTries);
  if (!(n >= 1)) return NO_WH_HOME;
  const rng = createRng(deriveSeed(seed, "fcwh-home"));
  const start = rng.nextInt(0, n - 1);
  for (let i = 0; i < n; i += 1) {
    const c = cands[(start + i) % n];
    if (isTaken(c.systemId) === false) return { ok: true, jSystemId: c.systemId, entrySystemId: c.entrySystemId };
  }
  return NO_WH_HOME;
}

const hasCargo = (wh) => Boolean(wh) && Number.isSafeInteger(wh.cargo_venture_seq) && wh.cargo_venture_seq > 0;
const HAUL_DEFERRED = Object.freeze({ ok: false, reason: "WH_HAUL_DEFERRED" });

function exitOf(env, jSystemId, fromSystemId) {
  try {
    const r = env.wh ? env.wh.findExit(jSystemId, fromSystemId) : null;
    return r && typeof r === "object" ? r : { ok: false, reason: "GRAPH_NOT_READY" };
  } catch (_err) {
    return { ok: false, reason: "GRAPH_NOT_READY" };
  }
}

function bandOfK(env, systemId, src = env.haul) {
  let b = null;
  try {
    b = src.bandOf(systemId);
  } catch (_err) {
    b = null;
  }
  return HOME_BANDS.includes(b) ? b : "nullsec";
}

const AREA_DEFERRED = Object.freeze({ ok: false, reason: "DEFERRED" });
function areaOf(env, exitSystemId) {
  try {
    const r = env.raid.areaOf(exitSystemId);
    return r && r.ok === true && Array.isArray(r.systems) ? r : AREA_DEFERRED;
  } catch (_err) {
    return AREA_DEFERRED;
  }
}

function planHaul(corp, wh, env, S, seq, crew, exitOnce) {
  const V = S.ventures;
  const now = env.now;
  const J = wh.j_system_id;
  const exit = exitOnce();
  if (exit.ok !== true) return exit.reason === "NO_EXIT" ? null : HAUL_DEFERRED;
  const route = Array.isArray(exit.route) ? exit.route.map(Number) : [];
  if (route.length < 2 || route[0] !== J) return HAUL_DEFERRED;
  const k = route[route.length - 1];
  let hub;
  try {
    hub = env.haul.hubOf(k);
  } catch (_err) {
    hub = null;
  }
  let target;
  let hubJumps;
  if (hub && hub.ok === true) {
    target = hub.hubSystemId;
    hubJumps = hub.jumps;
  } else if (hub && hub.reason === "NO_HUB") {
    target = wh.staging_system_id;
    hubJumps = exit.gateJumps;
  } else {
    return HAUL_DEFERRED;
  }
  const T = 1 + Math.ceil(hubJumps / V.jumpsPerStep);
  return { ok: true, whPatch: { op: "load", seq }, row: Object.freeze({ venture_id: `fcv:${corp.corp_id}:${seq}`,
    corp_id: corp.corp_id, seq, kind: HAUL_KIND, state: VS.TRAVEL, open: 1, home_system_id: J, system_id: J,
    target_system_id: target, target_station_id: null, sec_band: bandOfK(env, k),
    jumps: Math.min(MAX_VENTURE_JUMPS, exit.hops + hubJumps), crew, crew_lost: 0, step: 0, travel_steps: T,
    work_steps: 1, steps_total: 2 * T + 1, holds: 0, yield_isk: 0, cost_isk: 0, started_at: now,
    step_due_at: now + V.stepMs, updated_at: now, ended_at: null, end_reason: null, version: 1,
    wh_route: routeText(route), wh_entry_system_id: k, stranded_steps: 0 }) };
}

function planRaid(corp, wh, env, S, seq, crew, workSteps, prior, tallies) {
  const V = S.ventures;
  const now = env.now;
  const J = wh.j_system_id;
  let exit = prior;
  if (exit === null) {
    let granted = false;
    try {
      granted = env.raid.takePlan() === true;
    } catch (_err) {
      granted = false;
    }
    if (!granted) {
      tallies.push("whRaidBudget");
      return null;
    }
    exit = exitOf(env, J, wh.staging_system_id);
  }
  if (exit.ok !== true) {
    tallies.push(exit.reason === "NO_EXIT" ? "whRaidNoExit" : "whRaidExitDeferred");
    return null;
  }
  const route = Array.isArray(exit.route) ? exit.route.map(Number) : [];
  if (route.length < 2 || route[0] !== J) {
    tallies.push("whRaidExitDeferred");
    return null;
  }
  const k = route[route.length - 1];
  const area = areaOf(env, k);
  if (area.ok !== true) {
    tallies.push("whRaidAreaDeferred");
    return null;
  }
  if (area.systems.length < 1) {
    tallies.push("whRaidNoArea");
    return null;
  }
  const A = area.systems[area.systems.length - 1].jumps;
  const hops = Number.isSafeInteger(exit.hops) && exit.hops > 0 ? exit.hops : 1;
  return Object.freeze({ venture_id: `fcv:${corp.corp_id}:${seq}`, corp_id: corp.corp_id, seq, kind: RAID_KIND,
    state: VS.TRAVEL, open: 1, home_system_id: J, system_id: J, target_system_id: k, target_station_id: null,
    sec_band: bandOfK(env, k, env.raid), jumps: Math.min(MAX_VENTURE_JUMPS, hops + A), crew, crew_lost: 0, step: 0,
    travel_steps: 1, work_steps: workSteps, steps_total: 1 + workSteps + 1 + Math.ceil(A / V.jumpsPerStep), holds: 0,
    yield_isk: 0, cost_isk: 0, started_at: now, step_due_at: now + V.stepMs, updated_at: now, ended_at: null,
    end_reason: null, version: 1, wh_route: routeText(route), wh_entry_system_id: k, stranded_steps: 0 });
}

function planWhCorpVenture(corp, wh, env, S) {
  const V = S.ventures;
  const H = S.whCorps.home;
  const now = env.now;
  const seq = corp.venture_seq + 1;
  if (hasCargo(wh)) {
    return { ok: false, reason: "WH_CARGO_RESTORED", whPatch: { op: "restore", seq: wh.cargo_venture_seq } };
  }
  const rng = createRng(deriveSeed(corp.seed, "fcwh-plan", seq));
  const recovering = now < corp.recover_until ? corp.recover_crew : 0;
  const crew = Math.min(env.linkedCount, corp.members_target, MAX_MEMBERS) - recovering;
  if (!(crew >= 1)) return { ok: false, reason: "NO_CREW" };
  let exitMemo = null;
  const exitOnce = () => {
    if (exitMemo === null) exitMemo = exitOf(env, wh.j_system_id, wh.staging_system_id);
    return exitMemo;
  };
  const HL = S.whCorps.haul;
  if (env.haul && HL && env.wh && env.wh.mode === MODE.LIVE && wh.loot_isk + wh.gas_isk >= HL.minIsk) {
    const h = planHaul(corp, wh, env, S, seq, crew, exitOnce);
    if (h !== null) return h;
  }
  const RD = S.whCorps.raid;
  const raidOn = Boolean(env.raid) && Boolean(RD) && Boolean(env.wh) && env.wh.mode === MODE.LIVE;
  const full = wh.loot_isk + wh.gas_isk >= H.stockMaxIsk;
  if (!raidOn && full) return { ok: false, reason: "WH_STOCK_FULL" };
  const wsLo = Math.min(V.workStepsMin, V.workStepsMax);
  const wsHi = Math.max(V.workStepsMin, V.workStepsMax);
  const workSteps = rng.nextInt(wsLo, wsHi);
  const planTallies = [];
  if (raidOn) {
    const roll = rng.nextInt(1, PERMILLE);
    if (full || roll <= RD.planPermille) {
      const row = planRaid(corp, wh, env, S, seq, crew, workSteps, exitMemo, planTallies);
      if (row !== null) return { ok: true, row };
    }
  }
  const tail = planTallies.length > 0 ? { planTallies } : {};
  if (full) return { ok: false, reason: "WH_STOCK_FULL", ...tail };
  const J = wh.j_system_id;
  return { ok: true, row: Object.freeze({ venture_id: `fcv:${corp.corp_id}:${seq}`, corp_id: corp.corp_id, seq,
    kind: HOME_KIND, state: VS.WORKING, open: 1, home_system_id: J, system_id: J, target_system_id: J,
    target_station_id: null, sec_band: JSPACE_BAND, jumps: 0, crew, crew_lost: 0, step: 0, travel_steps: 0,
    work_steps: workSteps, steps_total: workSteps, holds: 0, yield_isk: 0, cost_isk: 0, started_at: now,
    step_due_at: now + V.stepMs, updated_at: now, ended_at: null, end_reason: null, version: 1, wh_route: null,
    wh_entry_system_id: null, stranded_steps: 0 }), ...tail };
}

function splitHomeYield(totalIsk, H) {
  const L = BigInt(H.lootIskPerStepPerPilot);
  const G = BigInt(H.gasIskPerStepPerPilot);
  const sum = L + G + BigInt(H.piIskPerStepPerPilot);
  if (sum === 0n || !(totalIsk > 0)) return { loot: 0, gas: 0, pi: 0 };
  const T = BigInt(totalIsk);
  const loot = Number((T * L) / sum);
  const gas = Number((T * G) / sum);
  return { loot, gas, pi: totalIsk - loot - gas };
}

function advanceWhCorpVenture(corp, venture, wh, env, S) {
  if (venture.kind === HAUL_KIND) return advanceHaul(corp, venture, wh, env, S);
  if (venture.kind === RAID_KIND) return advanceRaid(corp, venture, env, S);
  const V = S.ventures;
  const H = S.whCorps.home;
  const now = env.now;
  const v = { ...venture };
  const delta = { isk: 0, iskEarned: 0, iskLost: 0, done: 0, lost: 0, recoverCrew: corp.recover_crew,
    recoverUntil: corp.recover_until };
  const tallies = ["ventureSteps"];
  const kindEvents = [];
  let closed = null;
  let whPatch = null;
  const result = () => ({ venture: v, corpDelta: delta, whPatch, closed, held: false, holdLimit: false, tallies,
    kindEvents });
  v.step_due_at = now + V.stepMs;
  if (v.kind !== HOME_KIND) {
    v.state = VS.ABORTED;
    v.open = 0;
    v.ended_at = now;
    v.end_reason = "WH_KIND_UNKNOWN";
    tallies.push("whKindUnknown");
    return result();
  }
  const rng = createRng(deriveSeed(corp.seed, "fcwh-step", v.seq, v.step));
  const roll = rng.nextInt(1, LOSS_ROLL_MAX);
  const observed = env.isObserved(v.system_id) === true;
  const lossPermille = (V.loss && V.loss.nullsecPermille) || 0;
  if (!observed && roll <= lossPermille * H.riskPermille) {
    v.crew_lost = rng.nextInt(1, v.crew);
    v.cost_isk += v.crew_lost * V.shipLossIskPerPilot;
    v.state = VS.LOST;
    v.open = 0;
    v.ended_at = now;
    v.end_reason = "LOST";
    const paid = Math.min(corp.isk, v.cost_isk);
    delta.isk -= paid;
    delta.iskLost += paid;
    delta.lost = 1;
    delta.recoverCrew = v.crew_lost;
    delta.recoverUntil = now + V.recoverMs;
    closed = "LOST";
    tallies.push("ventureLost");
    kindEvents.push({ kind: v.kind, event: "lost" });
    return result();
  }
  const variance = V.yieldVariancePermille;
  const factor = rng.nextInt(PERMILLE - variance, PERMILLE + variance);
  const perPilot = H.lootIskPerStepPerPilot + H.gasIskPerStepPerPilot + H.piIskPerStepPerPilot;
  v.yield_isk += Math.round(v.crew * perPilot * factor / PERMILLE);
  v.step += 1;
  v.state = VS.WORKING;
  if (v.step >= v.steps_total) {
    const part = splitHomeYield(v.yield_isk, H);
    v.state = VS.DONE;
    v.open = 0;
    v.ended_at = now;
    whPatch = { loot: part.loot, gas: part.gas, pi: part.pi, home_done: 1 };
    delta.isk += part.pi;
    delta.iskEarned += part.pi;
    delta.done = 1;
    closed = "DONE";
    tallies.push("ventureDone");
    kindEvents.push({ kind: v.kind, event: "done" });
  }
  return result();
}

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const bigOf = (v) => (typeof v === "bigint" ? (v > 0n ? v : 0n)
  : Number.isSafeInteger(v) && v > 0 ? BigInt(v) : 0n);

function haulSaleOf(home, haulS, isHub, contractGasIsk = 0) {
  const L = bigOf(home && home.cargo_loot_isk);
  const G = bigOf(home && home.cargo_gas_isk);
  const K = BigInt(PERMILLE);
  const gcRaw = bigOf(contractGasIsk);
  const Gc = gcRaw > G ? G : gcRaw;
  const sale = isHub
    ? (L * bigOf(haulS.lootSalePermille)) / K + ((G - Gc) * bigOf(haulS.gasSalePermille)) / K
    : ((L + G) * bigOf(haulS.stagingSalePermille)) / K;
  return Number(sale > MAX_SAFE_BIG ? MAX_SAFE_BIG : sale);
}

function advanceHaul(corp, venture, wh, env, S) {
  const V = S.ventures;
  const W = S.wormholes || {};
  const HL = S.whCorps.haul || {};
  const now = env.now;
  const { whEnv, waiting, offline, graphWait } = stepModeOf(venture, env, W, env.haul, "haul");
  const waitDefer = () => ({ defer: true, reason: "WH_SYNC_WAIT", tallies: ["whSyncWait"] });
  if (graphWait && waiting) return waitDefer();
  const v = { ...venture };
  const J = v.home_system_id;
  const R = routeOf(v.wh_route);
  const entry = R ? R[R.length - 1]
    : Number.isSafeInteger(v.wh_entry_system_id) && v.wh_entry_system_id > 0 ? v.wh_entry_system_id : J;
  const delta = { isk: 0, iskEarned: 0, iskLost: 0, done: 0, lost: 0, recoverCrew: corp.recover_crew,
    recoverUntil: corp.recover_until };
  const tallies = ["ventureSteps"];
  const kindEvents = [];
  let closed = null;
  let whPatch = null;
  let sale = null;
  const result = () => ({ venture: v, corpDelta: delta, whPatch, closed, held: false, holdLimit: false, tallies,
    kindEvents, ...(sale ? { sale } : {}) });
  const deferExit = () => ({ defer: true, reason: "WH_EXIT_DEFERRED", tallies: ["whExitDeferred"] });
  const owned = hasCargo(wh) && wh.cargo_venture_seq === v.seq;
  const cargoOp = (op, extra) => {
    if (owned) whPatch = { op, seq: v.seq, ...(extra || {}) };
    else tallies.push(wh ? "whHaulNoCargo" : "whHomeOrphan");
  };
  const linked = (route) => {
    if (!whEnv || !route) return false;
    try {
      return whEnv.isLinked(route) === true;
    } catch (_err) {
      return false;
    }
  };
  const closeDone = (reason) => {
    v.state = VS.DONE;
    v.open = 0;
    v.system_id = J;
    v.ended_at = now;
    v.end_reason = reason;
    whPatch = { op: "haulDone" };
    delta.done = 1;
    closed = "DONE";
    tallies.push("ventureDone");
    kindEvents.push({ kind: v.kind, event: "done" });
  };
  const abort = (reason, counter) => {
    v.state = VS.ABORTED;
    v.open = 0;
    v.system_id = J;
    v.ended_at = now;
    v.end_reason = reason;
    cargoOp("restore");
    tallies.push(counter);
  };
  const reroute = (exit, counter) => {
    const route = exit.route.map(Number);
    v.state = VS.RETURNING;
    v.wh_route = routeText(route);
    v.wh_entry_system_id = route[route.length - 1];
    v.steps_total = v.step + Math.max(1, Math.ceil((exit.hops + exit.gateJumps) / V.jumpsPerStep));
    tallies.push(counter);
  };
  v.step_due_at = now + V.stepMs;

  if (v.state === VS.TRAVEL || v.state === VS.WORKING) {
    if (offline) {
      abort("WH_OFFLINE", "whHaulOffline");
      return result();
    }
    if (v.state === VS.TRAVEL) {
      if (v.step === 0) {
        if (waiting) return waitDefer();
        if (!linked(R)) {
          abort("WH_GONE", "whHaulGone");
          return result();
        }
        v.step = 1;
        v.system_id = entry;
      } else {
        const rng = createRng(deriveSeed(corp.seed, "fcwh-step", v.seq, v.step));
        const roll = rng.nextInt(1, LOSS_ROLL_MAX);
        const bandPermille = LOSS_BANDS.includes(v.sec_band) && V.loss ? V.loss[`${v.sec_band}Permille`] || 0 : 0;
        if (bandPermille > 0 && env.isObserved(v.system_id) !== true
          && roll <= bandPermille * (HL.riskPermille || 0)) {
          v.crew_lost = rng.nextInt(1, v.crew);
          v.cost_isk += v.crew_lost * V.shipLossIskPerPilot;
          v.state = VS.LOST;
          v.open = 0;
          v.ended_at = now;
          v.end_reason = "LOST";
          const paid = Math.min(corp.isk, v.cost_isk);
          delta.isk -= paid;
          delta.iskLost += paid;
          delta.lost = 1;
          delta.recoverCrew = v.crew_lost;
          delta.recoverUntil = now + V.recoverMs;
          closed = "LOST";
          cargoOp("drop");
          tallies.push("ventureLost");
          kindEvents.push({ kind: v.kind, event: "lost" });
          return result();
        }
        v.step += 1;
      }
      if (v.step >= v.travel_steps) {
        v.state = VS.WORKING;
        v.system_id = v.target_system_id;
      }
      return result();
    }
    v.step += 1;
    v.state = VS.RETURNING;
    if (owned) {
      const isHub = env.haul.hubIds.includes(v.target_system_id);
      let gc = 0;
      let contractKey = null;
      if (isHub && typeof env.whContract === "function" && wh.cargo_gas_isk > 0) {
        const o = env.whContract(venture, wh);
        if (o && o.ok === true && Number.isSafeInteger(o.gasIsk) && o.gasIsk > 0 && o.gasIsk <= wh.cargo_gas_isk
          && typeof o.contractKey === "string") {
          gc = o.gasIsk;
          contractKey = o.contractKey;
        }
      }
      const isk = haulSaleOf(wh, HL, isHub, gc);
      v.yield_isk = isk;
      delta.isk += isk;
      delta.iskEarned += isk;
      whPatch = { op: "sell", seq: v.seq, sale: isk };
      sale = { seq: v.seq, isk, hubSystemId: v.target_system_id, lootIsk: wh.cargo_loot_isk,
        gasIsk: wh.cargo_gas_isk, staging: !isHub, ...(gc > 0 ? { contractGasIsk: gc, contractKey } : {}) };
      tallies.push("whHaulSold");
      if (!isHub) tallies.push("whHaulStagingSale");
    } else {
      tallies.push(wh ? "whHaulNoCargo" : "whHomeOrphan");
    }
    return result();
  }
  if (v.state === VS.RETURNING || v.state === VS.STRANDED) {
    return returnLeg({ v, env, W, J, R, entry, now, offline, waiting, linked, closeDone, reroute, waitDefer, deferExit,
      tallies, result }, HAUL_RETURN(HL));
  }
  return result();
}

const HAUL_RETURN = (HL) => ({ offlineCounter: "whHaulOffline", reroutedCounter: "whHaulRerouted",
  rescuedCounter: "whHaulRescued", strandedCounter: "whHaulStranded", longWayCounter: "whLongWay",
  outsideMaxSteps: HL.outsideMaxSteps });
const RAID_RETURN = (RD) => ({ offlineCounter: "whRaidOffline", reroutedCounter: "whRaidRerouted",
  rescuedCounter: "whRaidRescued", strandedCounter: "whRaidStranded", longWayCounter: "whRaidLongWay",
  outsideMaxSteps: RD.outsideMaxSteps });

function stepModeOf(venture, env, W, kindEnv, key) {
  const whEnv = env.wh || null;
  const mode = whEnv ? whEnv.mode : MODE.OFFLINE;
  const graphWait = !kindEnv && Boolean(env.whGraphWait) && env.whGraphWait[key] === true;
  let waiting = false;
  if (mode === MODE.WAIT || graphWait) {
    const since = whEnv && Number.isFinite(whEnv.waitSince) ? Math.max(venture.step_due_at, whEnv.waitSince)
      : venture.step_due_at;
    waiting = env.now - since <= W.syncWaitMaxMs;
  }
  const offline = !kindEnv || (mode !== MODE.LIVE && !waiting);
  return { whEnv, waiting, offline, graphWait };
}

function returnLeg(ctx, p) {
  const { v, env, W, J, R, entry, now, offline, waiting, linked, closeDone, reroute, waitDefer, deferExit, tallies,
    result } = ctx;
  if (offline) {
    closeDone("WH_OFFLINE");
    tallies.push(p.offlineCounter);
    return result();
  }
  if (v.state === VS.RETURNING && v.step + 1 < v.steps_total) {
    v.step += 1;
    v.system_id = entry;
    return result();
  }
  if (waiting) return waitDefer();
  if (v.state === VS.RETURNING && linked(R)) {
    v.step = v.steps_total;
    closeDone(null);
    return result();
  }
  const exit = exitOf(env, J, v.system_id);
  if (exit.ok === true && Array.isArray(exit.route) && exit.route.length >= 2) {
    reroute(exit, v.state === VS.STRANDED ? p.rescuedCounter : p.reroutedCounter);
    return result();
  }
  if (exit.reason !== "NO_EXIT") return deferExit();
  v.step_due_at = now + W.strandedStepMs;
  if (v.state === VS.RETURNING) {
    v.state = VS.STRANDED;
    tallies.push(p.strandedCounter);
    return result();
  }
  if (v.stranded_steps + 1 >= p.outsideMaxSteps) {
    closeDone("WH_LONG_WAY");
    tallies.push(p.longWayCounter);
    return result();
  }
  v.stranded_steps += 1;
  return result();
}

function pickRaidSystem(area, isObserved, observedWeight, rng) {
  if (!Array.isArray(area) || area.length < 1) return null;
  const w = Number.isSafeInteger(observedWeight) && observedWeight >= 1 ? observedWeight : 1;
  const seen = area.map((s) => {
    try {
      return isObserved(s.systemId) === true;
    } catch (_err) {
      return false;
    }
  });
  const sum = seen.reduce((acc, o) => acc + (o ? w : 1), 0);
  const pick = rng.nextInt(1, sum);
  let acc = 0;
  for (let i = 0; i < area.length; i += 1) {
    acc += seen[i] ? w : 1;
    if (acc >= pick) {
      const s = area[i];
      return { systemId: s.systemId, jumps: s.jumps, secClass: s.secClass, observed: seen[i] };
    }
  }
  return null;
}

function advanceRaid(corp, venture, env, S) {
  const V = S.ventures;
  const W = S.wormholes || {};
  const RD = S.whCorps.raid || {};
  const now = env.now;
  const { whEnv, waiting, offline, graphWait } = stepModeOf(venture, env, W, env.raid, "raid");
  const waitDefer = () => ({ defer: true, reason: "WH_SYNC_WAIT", tallies: ["whSyncWait"] });
  if (graphWait && waiting) return waitDefer();
  const v = { ...venture };
  const J = v.home_system_id;
  const R = routeOf(v.wh_route);
  const entry = R ? R[R.length - 1]
    : Number.isSafeInteger(v.wh_entry_system_id) && v.wh_entry_system_id > 0 ? v.wh_entry_system_id : J;
  const delta = { isk: 0, iskEarned: 0, iskLost: 0, done: 0, lost: 0, recoverCrew: corp.recover_crew,
    recoverUntil: corp.recover_until };
  const tallies = ["ventureSteps"];
  const kindEvents = [];
  let closed = null;
  let whPatch = null;
  const result = () => ({ venture: v, corpDelta: delta, whPatch, closed, held: false, holdLimit: false, tallies,
    kindEvents });
  const deferExit = () => ({ defer: true, reason: "WH_EXIT_DEFERRED", tallies: ["whExitDeferred"] });
  const linked = (route) => {
    if (!whEnv || !route) return false;
    try {
      return whEnv.isLinked(route) === true;
    } catch (_err) {
      return false;
    }
  };
  const closeDone = (reason) => {
    v.state = VS.DONE;
    v.open = 0;
    v.system_id = J;
    v.ended_at = now;
    v.end_reason = reason;
    const isk = Number.isSafeInteger(v.yield_isk) && v.yield_isk > 0 ? v.yield_isk : 0;
    whPatch = { op: "raidDone" };
    delta.isk += isk;
    delta.iskEarned += isk;
    delta.done = 1;
    closed = "DONE";
    tallies.push("ventureDone");
    kindEvents.push({ kind: v.kind, event: "done" });
  };
  const abort = (reason, counter) => {
    v.state = VS.ABORTED;
    v.open = 0;
    v.system_id = J;
    v.ended_at = now;
    v.end_reason = reason;
    tallies.push(counter);
  };
  const reroute = (exit, counter) => {
    const route = exit.route.map(Number);
    v.state = VS.RETURNING;
    v.wh_route = routeText(route);
    v.wh_entry_system_id = route[route.length - 1];
    v.steps_total = v.step + Math.max(1, Math.ceil((exit.hops + exit.gateJumps) / V.jumpsPerStep));
    tallies.push(counter);
  };
  const observedAt = (systemId) => {
    try {
      return env.isObserved(systemId) === true;
    } catch (_err) {
      return false;
    }
  };
  v.step_due_at = now + V.stepMs;

  if (v.state === VS.TRAVEL) {
    if (offline) {
      abort("WH_OFFLINE", "whRaidOffline");
      return result();
    }
    if (waiting) return waitDefer();
    if (!linked(R)) {
      abort("WH_GONE", "whRaidGone");
      return result();
    }
    v.step += 1;
    v.system_id = entry;
    if (v.step >= v.travel_steps) v.state = VS.WORKING;
    return result();
  }
  if (v.state === VS.WORKING) {
    if (offline) {
      closeDone("WH_OFFLINE");
      tallies.push("whRaidOffline");
      return result();
    }
    const area = areaOf(env, v.target_system_id);
    let band;
    let observed;
    if (area.ok !== true) {
      tallies.push("whRaidAreaDeferred");
      band = bandOfK(env, v.system_id, env.raid);
      observed = observedAt(v.system_id);
    } else if (area.systems.length < 1) {
      v.step += 1;
      v.state = VS.RETURNING;
      v.steps_total = v.step + 1;
      tallies.push("whRaidNoArea");
      return result();
    } else {
      const roam = createRng(deriveSeed(corp.seed, "fcwh-roam", v.seq, v.step));
      const pick = pickRaidSystem(area.systems, observedAt, RD.observedWeight, roam);
      v.system_id = pick.systemId;
      band = HOME_BANDS.includes(pick.secClass) ? pick.secClass : "nullsec";
      observed = pick.observed;
      if (observed) tallies.push("whRaidObservedStep");
    }
    const rng = createRng(deriveSeed(corp.seed, "fcwh-step", v.seq, v.step));
    const roll = rng.nextInt(1, LOSS_ROLL_MAX);
    const bandPermille = V.loss ? V.loss[`${band}Permille`] || 0 : 0;
    if (!observed && roll <= bandPermille * (RD.riskPermille || 0)) {
      v.crew_lost = rng.nextInt(1, v.crew);
      v.cost_isk += v.crew_lost * V.shipLossIskPerPilot;
      v.state = VS.LOST;
      v.open = 0;
      v.ended_at = now;
      v.end_reason = "LOST";
      const paid = Math.min(corp.isk, v.cost_isk);
      delta.isk -= paid;
      delta.iskLost += paid;
      delta.lost = 1;
      delta.recoverCrew = v.crew_lost;
      delta.recoverUntil = now + V.recoverMs;
      closed = "LOST";
      tallies.push("ventureLost");
      kindEvents.push({ kind: v.kind, event: "lost" });
      return result();
    }
    const variance = V.yieldVariancePermille;
    const factor = rng.nextInt(PERMILLE - variance, PERMILLE + variance);
    v.yield_isk = Math.min(Number.MAX_SAFE_INTEGER,
      v.yield_isk + Math.round(v.crew * (RD.yieldIskPerStepPerPilot || 0) * factor / PERMILLE));
    v.step += 1;
    if (v.step >= v.travel_steps + v.work_steps) {
      let j = 0;
      if (area.ok === true) {
        const here = area.systems.find((s) => s.systemId === v.system_id);
        j = here ? here.jumps : 0;
      }
      v.state = VS.RETURNING;
      v.steps_total = v.step + 1 + Math.ceil(j / V.jumpsPerStep);
    }
    return result();
  }
  if (v.state === VS.RETURNING || v.state === VS.STRANDED) {
    return returnLeg({ v, env, W, J, R, entry, now, offline, waiting, linked, closeDone, reroute, waitDefer, deferExit,
      tallies, result }, RAID_RETURN(RD));
  }
  return result();
}

module.exports = { pickWhHome, planWhCorpVenture, advanceWhCorpVenture, splitHomeYield, haulSaleOf, pickRaidSystem,
  HOME_BANDS };
