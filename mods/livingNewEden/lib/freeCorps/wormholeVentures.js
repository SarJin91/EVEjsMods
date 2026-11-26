"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { VENTURE_STATES: VS } = require("./schema");

const PERMILLE = 1000;
const KIND = "EXPLORE_WH";
const JSPACE_CLASS = "wormhole";
const MODE = Object.freeze({ LIVE: "LIVE", WAIT: "WAIT", OFFLINE: "OFFLINE" });

function routeOf(text) {
  if (typeof text !== "string") return null;
  let list;
  try {
    list = JSON.parse(text);
  } catch (_err) {
    return null;
  }
  if (!Array.isArray(list) || list.length < 2 || !list.every((id) => Number.isSafeInteger(id) && id > 0)) return null;
  return list;
}

const routeText = (route) => JSON.stringify(route.map(Number));

function whCandidates(reach, bands, env, S) {
  const wh = env.wh;
  if (!wh || !Array.isArray(reach)) return Object.freeze([]);
  const V = S.ventures;
  const wsHi = Math.max(V.workStepsMin, V.workStepsMax);
  const minLife = Number.isFinite(wh.minLifeMs) ? wh.minLifeMs : 0;
  const life = (e) => (e.expiresAt === 0 ? Infinity : e.expiresAt);
  const best = new Map();
  for (const e of reach) {
    if (!bands.includes(e.secClass)) continue;
    const entries = wh.entriesOf(e.systemId) || [];
    if (entries.length === 0) continue;
    const jumps = e.jumps + 1;
    const need = minLife + (2 * Math.ceil(jumps / V.jumpsPerStep) + wsHi) * V.stepMs;
    for (const x of entries) {
      if (!(x.expiresAt === 0 || x.expiresAt - env.now >= need)) continue;
      const cur = best.get(x.jSystemId);
      const cand = { systemId: x.jSystemId, jumps, secClass: JSPACE_CLASS, entrySystemId: e.systemId,
        expiresAt: x.expiresAt };
      const better = !cur || jumps < cur.jumps || (jumps === cur.jumps && (life(cand) > life(cur)
        || (life(cand) === life(cur) && e.systemId < cur.entrySystemId)));
      if (!better) continue;
      if (wh.isLinked([x.jSystemId, e.systemId]) !== true) continue;
      best.set(x.jSystemId, cand);
    }
  }
  const out = [...best.values()].sort((a, b) => a.jumps - b.jumps || a.systemId - b.systemId)
    .map((c) => Object.freeze({ systemId: c.systemId, jumps: c.jumps, secClass: c.secClass,
      entrySystemId: c.entrySystemId }));
  return Object.freeze(out);
}

function advanceWhVenture(corp, venture, env, S) {
  const V = S.ventures;
  const W = S.wormholes || {};
  const now = env.now;
  const wh = env.wh || null;
  let mode = wh ? wh.mode : MODE.OFFLINE;
  if (mode === MODE.WAIT) {
    const since = Number.isFinite(wh.waitSince) ? Math.max(venture.step_due_at, wh.waitSince) : venture.step_due_at;
    if (now - since <= W.syncWaitMaxMs) {
      return { defer: true, reason: "WH_SYNC_WAIT", tallies: ["whSyncWait"] };
    }
    mode = MODE.OFFLINE;
  }
  if (mode !== MODE.LIVE) mode = MODE.OFFLINE;
  const offline = mode === MODE.OFFLINE;
  const v = { ...venture };
  const J = v.target_system_id;
  const R = routeOf(v.wh_route);
  const entry = Number.isSafeInteger(v.wh_entry_system_id) && v.wh_entry_system_id > 0 ? v.wh_entry_system_id
    : R ? R[R.length - 1] : v.home_system_id;
  const delta = { isk: 0, iskEarned: 0, iskLost: 0, done: 0, lost: 0, recoverCrew: corp.recover_crew,
    recoverUntil: corp.recover_until };
  const tallies = ["ventureSteps"];
  const kindEvents = [];
  let closed = null;
  const result = () => ({ venture: v, corpDelta: delta, closed, held: false, holdLimit: false, tallies, kindEvents });
  const deferExit = () => ({ defer: true, reason: "WH_EXIT_DEFERRED", tallies: ["whExitDeferred"] });
  const linked = (route) => {
    if (!wh || !route) return false;
    try {
      return wh.isLinked(route) === true;
    } catch (_err) {
      return false;
    }
  };
  const findExit = () => {
    try {
      const r = wh ? wh.findExit(J, v.home_system_id) : null;
      return r && typeof r === "object" ? r : { ok: false, reason: "GRAPH_NOT_READY" };
    } catch (_err) {
      return { ok: false, reason: "GRAPH_NOT_READY" };
    }
  };
  const closeDone = () => {
    const payout = v.yield_isk;
    v.state = VS.DONE;
    v.open = 0;
    v.system_id = v.home_system_id;
    v.ended_at = now;
    delta.isk += payout;
    delta.iskEarned += payout;
    delta.done = 1;
    closed = "DONE";
    tallies.push("ventureDone");
    kindEvents.push({ kind: v.kind, event: "done" });
  };
  const closeLost = (crewLost, reason) => {
    v.crew_lost = crewLost;
    v.cost_isk += crewLost * V.shipLossIskPerPilot;
    v.state = VS.LOST;
    v.open = 0;
    v.ended_at = now;
    v.end_reason = reason;
    const paid = Math.min(corp.isk, v.cost_isk);
    delta.isk -= paid;
    delta.iskLost += paid;
    delta.lost = 1;
    delta.recoverCrew = crewLost;
    delta.recoverUntil = now + V.recoverMs;
    closed = "LOST";
    tallies.push("ventureLost", "whStrandedLost");
    kindEvents.push({ kind: v.kind, event: "lost" });
  };
  const offlineReturn = () => {
    v.state = VS.RETURNING;
    v.end_reason = "WH_OFFLINE";
    v.system_id = entry;
    v.steps_total = v.step + Math.max(1, v.travel_steps);
    v.step_due_at = now + V.stepMs;
    tallies.push("whOffline");
  };
  const reroute = (exit, reason) => {
    v.state = VS.RETURNING;
    v.wh_route = routeText(exit.route);
    v.steps_total = v.step + Math.max(1, Math.ceil((exit.hops + exit.gateJumps) / V.jumpsPerStep));
    v.end_reason = reason;
    v.step_due_at = now + V.stepMs;
  };
  const onCut = () => {
    const exit = findExit();
    if (exit.ok === true) {
      reroute(exit, "WH_REROUTE");
      tallies.push("whCut", "whRerouted");
      return result();
    }
    if (exit.reason === "NO_EXIT") {
      v.state = VS.STRANDED;
      v.step_due_at = now + W.strandedStepMs;
      tallies.push("whCut", "whNoExit", "whStranded");
      return result();
    }
    return deferExit();
  };

  if (v.state === VS.TRAVEL) {
    if (v.step + 1 < v.travel_steps) return null;
    v.step_due_at = now + V.stepMs;
    if (offline || !linked([entry, J])) {
      v.state = VS.RETURNING;
      v.step = v.travel_steps + v.work_steps;
      v.end_reason = offline ? "WH_OFFLINE" : "WH_GONE";
      v.system_id = v.home_system_id;
      tallies.push(offline ? "whOffline" : "whEntryGone");
      return result();
    }
    v.step += 1;
    v.state = VS.WORKING;
    v.system_id = J;
    return result();
  }
  if (v.state === VS.WORKING || v.state === VS.HELD) {
    if (offline) {
      offlineReturn();
      return result();
    }
    if (!linked(R)) return onCut();
    return null;
  }
  if (v.state === VS.RETURNING) {
    if (v.system_id !== J) return null;
    if (offline || linked(R)) {
      v.system_id = R ? R[R.length - 1] : entry;
      v.step += 1;
      v.step_due_at = now + V.stepMs;
      if (v.step >= v.steps_total) closeDone();
      return result();
    }
    return onCut();
  }
  if (v.state === VS.STRANDED) {
    v.step_due_at = now + W.strandedStepMs;
    if (offline) {
      offlineReturn();
      return result();
    }
    const exit = findExit();
    if (exit.ok === true) {
      reroute(exit, "WH_RESCUED");
      tallies.push("whRescued");
      return result();
    }
    if (exit.reason !== "NO_EXIT") return deferExit();
    if (env.isObserved(J) === true) {
      tallies.push("whStrandedWait");
      return result();
    }
    const rng = createRng(deriveSeed(corp.seed, "vstrand", v.seq, v.stranded_steps));
    if (rng.nextInt(1, PERMILLE) <= W.strandedLossPermille) {
      closeLost(rng.nextInt(1, v.crew), "STRANDED_LOSS");
      return result();
    }
    if (W.strandedMaxSteps > 0 && v.stranded_steps + 1 >= W.strandedMaxSteps) {
      closeLost(v.crew, "STRANDED");
      return result();
    }
    v.stranded_steps += 1;
    return result();
  }
  return null;
}

module.exports = { whCandidates, advanceWhVenture, routeOf, routeText, MODE, KIND };
