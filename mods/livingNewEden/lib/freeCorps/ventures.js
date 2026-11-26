"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { CORP_STATES, VENTURE_STATES: VS, MAX_MEMBERS, EVENT_GREW, EVENT_DISSOLVED, keyGrow,
  keyDissolve, EVENT_MERGED, keyMerge, WH_CORP_KINDS } = require("./schema");
const { KIND_DATA, ARCHETYPE_KINDS, WH_ARCHETYPE_KINDS } = require("./data/ventureKinds");
const { ARCHETYPE_DATA } = require("./data/archetypes");
const { drawWeighted } = require("./plan");
const { whCandidates, advanceWhVenture, routeText, MODE: WH_MODE } = require("./wormholeVentures");
const { huntTargets, advanceHuntVenture } = require("./hunting");
const { planWhCorpVenture, advanceWhCorpVenture } = require("./whCorps");

const LOSS_ROLL_MAX = 1000000;
const PERMILLE = 1000;
const CORP_MUTABLE = Object.freeze(["state", "open", "isk", "struggle_count", "members_target", "venture_seq",
  "recover_until", "recover_crew", "ventures_done", "ventures_lost", "isk_earned", "isk_lost", "last_review_at",
  "ended_at", "end_reason",
  "recruited", "merged_into"]);
const REST_COUNTERS = Object.freeze({ NO_CREW: "ventureNoCrew", NO_KIND: "ventureNoKind", NO_GRAPH: "ventureNoGraph",
  NO_TARGET: "ventureNoTarget", NO_FUNDS: "ventureNoFunds", WH_STOCK_FULL: "whStockFull",
  WH_CARGO_RESTORED: "whCargoRestored", WH_HAUL_DEFERRED: "whHaulExitDeferred" });

const whHomeOf = (corp, env) => (typeof env.whCorp === "function" ? env.whCorp(corp.corp_id) || null : null);

function corpValues(corp) {
  const out = {};
  for (const c of CORP_MUTABLE) out[c] = corp[c] === undefined ? null : corp[c];
  return out;
}

const lossBandOf = (band) => (band === "highsec" ? "highsecPermille" : band === "lowsec" ? "lowsecPermille"
  : "nullsecPermille");

function reviewCorp(corp, env, S) {
  const L = S.lifecycle;
  const c = corpValues(corp);
  const tallies = [];
  const journal = [];
  let transition = null;
  let grew = false;
  const upkeep = L.upkeepIskPerMember * c.members_target;
  if (c.isk >= upkeep) {
    c.isk -= upkeep;
    c.struggle_count = 0;
    tallies.push("upkeepPaid");
    if (c.state === CORP_STATES.STRUGGLING) {
      c.state = CORP_STATES.ACTIVE;
      transition = "RECOVERED";
      tallies.push("recovered");
    }
  } else {
    c.isk_lost += c.isk;
    c.isk = 0;
    c.struggle_count += 1;
    tallies.push("upkeepShort");
    if (c.state === CORP_STATES.ACTIVE && c.struggle_count >= L.struggleReviews) {
      c.state = CORP_STATES.STRUGGLING;
      transition = "STRUGGLING";
      tallies.push("struggling");
    }
  }
  c.last_review_at = env.now;
  const RC = env.recycle && S.recycle ? S.recycle : null;
  if (RC && c.state === CORP_STATES.STRUGGLING && c.struggle_count >= RC.mergeAfterStruggles) {
    const m = env.recycle.mergePartnerOf({ ...corp, ...c });
    const partner = m && m.partner ? m.partner : null;
    if (partner) {
      const isk = c.isk;
      c.state = CORP_STATES.MERGED;
      c.open = 0;
      c.ended_at = env.now;
      c.end_reason = "MERGED";
      c.merged_into = partner.corp_id;
      c.isk = 0;
      tallies.push("rcMerged");
      journal.push({ key: keyMerge(corp.corp_id), eventType: EVENT_MERGED,
        payload: { corpId: corp.corp_id, into: partner.corp_id, isk } });
      return { corp: c, grew, transition: "MERGED", tallies, journal, merge: { partner, isk }, recruit: 0 };
    }
    tallies.push(m && m.budget === true ? "rcMergeBudget" : "rcMergeNoPartner");
  }
  if (c.state === CORP_STATES.STRUGGLING && L.dissolveEnabled === true && c.struggle_count >= 2 * L.struggleReviews) {
    c.state = CORP_STATES.DISSOLVED;
    c.open = 0;
    c.ended_at = env.now;
    c.end_reason = "BANKRUPT";
    tallies.push("dissolved");
    journal.push({ key: keyDissolve(corp.corp_id), eventType: EVENT_DISSOLVED,
      payload: { corpId: corp.corp_id, reason: "BANKRUPT", struggleCount: c.struggle_count } });
    return { corp: c, grew, transition: "DISSOLVED", tallies, journal };
  }
  const cap = Math.min(S.membersMax, MAX_MEMBERS);
  let recruit = 0;
  const SH = env.structureHold;
  const held = Boolean(SH && corp.archetype === "structure" && c.isk - L.growthCostIsk < SH.minIsk
    && !SH.hasOpen(corp.corp_id));
  if (c.state === CORP_STATES.ACTIVE && c.isk >= L.growthIskThreshold && c.members_target < cap && held) {
    tallies.push("growthHeldStructure");
  } else if (c.state === CORP_STATES.ACTIVE && c.isk >= L.growthIskThreshold && c.members_target < cap) {
    if (RC && env.recycle.poolLeft() >= 1) {
      c.members_target += 1;
      c.recruited = (c.recruited || 0) + 1;
      c.isk = Math.max(0, c.isk - L.growthCostIsk);
      recruit = 1;
      tallies.push("rcRecruitGrowth");
    } else if (env.memberRoom >= 1) {
      c.members_target += 1;
      c.isk = Math.max(0, c.isk - L.growthCostIsk);
      grew = true;
      tallies.push("grew");
      journal.push({ key: keyGrow(corp.corp_id, c.members_target), eventType: EVENT_GREW,
        payload: { corpId: corp.corp_id, members: c.members_target } });
    } else {
      tallies.push("growthBlockedBudget");
    }
  }
  return { corp: c, grew, transition, tallies, journal, recruit };
}

function pickTarget(cands, maxJumps, rng) {
  let sum = 0;
  const weights = cands.map((e) => {
    const wt = Math.max(1, maxJumps + 1 - e.jumps);
    sum += wt;
    return wt;
  });
  let r = rng.nextInt(1, sum);
  for (let i = 0; i < cands.length; i += 1) {
    if (r <= weights[i]) return cands[i];
    r -= weights[i];
  }
  return cands[cands.length - 1];
}

function planVenture(corp, env, S) {
  const V = S.ventures;
  const now = env.now;
  const seq = corp.venture_seq + 1;
  const rng = createRng(deriveSeed(corp.seed, "vplan", seq));
  const recovering = now < corp.recover_until ? corp.recover_crew : 0;
  const crew = Math.min(env.linkedCount, corp.members_target, MAX_MEMBERS) - recovering;
  if (!(crew >= 1)) return { ok: false, reason: "NO_CREW" };
  let pairs = ARCHETYPE_KINDS[corp.archetype] || [];
  const W = S.wormholes;
  const whKinds = WH_ARCHETYPE_KINDS[corp.archetype] || [];
  if (env.wh && env.wh.mode === WH_MODE.LIVE && W && W.weight > 0 && whKinds.length > 0) {
    pairs = pairs.concat(whKinds.map((k) => [k, W.weight]));
  }
  const pvp = env.pvp;
  if (!(pvp && pvp.hunting)) pairs = pairs.filter(([k]) => k !== "HUNT");
  if (pvp && pvp.wars && S.wars && S.wars.raidWeight > 0 && !pairs.some(([k]) => k === "HUNT")) {
    const war = typeof pvp.warOf === "function" ? pvp.warOf(corp.corp_id) : null;
    if (war && war.state === "ACTIVE") pairs = pairs.concat([["HUNT", S.wars.raidWeight]]);
  }
  if (pairs.length === 0) return { ok: false, reason: "NO_KIND" };
  const order = pairs.map((p) => p[0]);
  const kindsLeft = new Map(pairs.filter((p) => p[1] > 0));
  const archetype = ARCHETYPE_DATA[corp.archetype];
  const bands = archetype ? archetype.bands : [];
  const home = corp.home_system_id;
  const reach = env.reachOf(home);
  const wsLo = Math.min(V.workStepsMin, V.workStepsMax);
  const wsHi = Math.max(V.workStepsMin, V.workStepsMax);
  let noFunds = false;
  for (;;) {
    const kind = drawWeighted(order, kindsLeft, rng);
    if (kind === null) break;
    const data = KIND_DATA[kind];
    let cands = [];
    if (!data) {
      cands = [];
    } else if (data.needs === "home") {
      const cMax = crew * V.buildInputIskPerStepPerPilot * wsHi;
      if (corp.isk < cMax) noFunds = true;
      else cands = [{ systemId: home, jumps: 0, secClass: corp.sec_band }];
    } else if (data.needs === "wormhole") {
      cands = reach === null ? [] : whCandidates(reach, bands, env, S);
    } else if (data.needs === "hunt") {
      cands = reach === null ? [] : huntTargets(corp, reach, env, S);
    } else if (data.needs === "whCorp") {
      cands = [];
    } else if (reach !== null) {
      cands = reach.filter((e) => {
        if (!bands.includes(e.secClass)) return false;
        if (e.systemId === home && !data.homeAllowed) return false;
        if (data.needs === "belts") {
          const b = env.beltsOf(e.systemId);
          return b !== null && b > 0;
        }
        if (data.needs === "station") return (env.stationsOf(e.systemId) || []).length > 0;
        return true;
      });
    }
    if (cands.length === 0) {
      kindsLeft.delete(kind);
      continue;
    }
    const wormhole = data.needs === "wormhole";
    const target = pickTarget(cands, wormhole ? V.maxJumps + 1 : V.maxJumps, rng);
    let stationId = null;
    if (data.needs === "station") {
      const stations = (env.stationsOf(target.systemId) || []).slice().sort((a, b) => a.stationId - b.stationId);
      stationId = rng.pick(stations).stationId;
    }
    const workSteps = rng.nextInt(wsLo, wsHi);
    const travelSteps = Math.ceil(target.jumps / V.jumpsPerStep);
    const costIsk = data.needs === "home" ? crew * V.buildInputIskPerStepPerPilot * workSteps : 0;
    return { ok: true, row: Object.freeze({ venture_id: `fcv:${corp.corp_id}:${seq}`, corp_id: corp.corp_id, seq,
      kind, state: travelSteps > 0 ? VS.TRAVEL : VS.WORKING, open: 1, home_system_id: home,
      system_id: travelSteps > 0 ? home : target.systemId, target_system_id: target.systemId,
      target_station_id: stationId, sec_band: target.secClass, jumps: target.jumps, crew, crew_lost: 0, step: 0,
      travel_steps: travelSteps, work_steps: workSteps, steps_total: 2 * travelSteps + workSteps, holds: 0,
      yield_isk: 0, cost_isk: costIsk, started_at: now, step_due_at: now + V.stepMs, updated_at: now,
      ended_at: null, end_reason: null, version: 1,
      wh_route: wormhole ? routeText([target.systemId, target.entrySystemId]) : null,
      wh_entry_system_id: wormhole ? target.entrySystemId : null, stranded_steps: 0 }) };
  }
  if (noFunds) return { ok: false, reason: "NO_FUNDS" };
  return { ok: false, reason: reach === null ? "NO_GRAPH" : "NO_TARGET" };
}

function payoutOf(v, V) {
  if (v.kind === "BUILD") return Math.floor(v.cost_isk * (PERMILLE + V.buildMarginPermille) / PERMILLE);
  return v.yield_isk;
}

function advanceVenture(corp, venture, env, S) {
  if (WH_CORP_KINDS.includes(venture.kind)) {
    return advanceWhCorpVenture(corp, venture, whHomeOf(corp, env), env, S);
  }
  if (venture.kind === "EXPLORE_WH") {
    const wh = advanceWhVenture(corp, venture, env, S);
    if (wh !== null) return wh;
  }
  if (venture.kind === "HUNT") {
    const h = advanceHuntVenture(corp, venture, env, S);
    if (h !== null) return h;
  }
  const V = S.ventures;
  const now = env.now;
  const v = { ...venture };
  const delta = { isk: 0, iskEarned: 0, iskLost: 0, done: 0, lost: 0, recoverCrew: corp.recover_crew,
    recoverUntil: corp.recover_until };
  const tallies = ["ventureSteps"];
  const kindEvents = [];
  let closed = null;
  let held = false;
  let holdLimit = false;
  const rng = createRng(deriveSeed(corp.seed, "vstep", v.seq, v.step));
  const workEnd = v.travel_steps + v.work_steps;
  v.step_due_at = now + V.stepMs;
  const done = () => {
    const payout = payoutOf(v, V);
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
  if (v.state === VS.TRAVEL) {
    v.step += 1;
    if (v.step >= v.travel_steps) {
      v.state = VS.WORKING;
      v.system_id = v.target_system_id;
    }
  } else if (v.state === VS.WORKING || v.state === VS.HELD) {
    const data = KIND_DATA[v.kind];
    const risk = data ? data.riskPermille : 0;
    const bandPermille = V.loss[lossBandOf(v.sec_band)] || 0;
    const loss = rng.nextInt(1, LOSS_ROLL_MAX) <= bandPermille * risk;
    if (loss && env.isObserved(v.system_id) === true) {
      if (v.holds < V.maxHolds) {
        v.state = VS.HELD;
        v.holds += 1;
        v.step_due_at = now + V.holdMs;
        held = true;
        tallies.push("ventureHeld");
        kindEvents.push({ kind: v.kind, event: "held" });
      } else {
        v.state = VS.RETURNING;
        v.step = workEnd;
        v.end_reason = "HOLD_LIMIT";
        holdLimit = true;
        tallies.push("ventureHoldLimit");
        if (v.step >= v.steps_total) done();
      }
    } else if (loss) {
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
    } else {
      const variance = V.yieldVariancePermille;
      const factor = rng.nextInt(PERMILLE - variance, PERMILLE + variance);
      const perPilot = data && data.yieldFrom === "wormholes"
        ? ((S.wormholes && S.wormholes.yieldIskPerStepPerPilot) || 0)
        : data && data.yieldKey ? (V.yield[data.yieldKey] || 0) : 0;
      v.yield_isk += Math.floor(v.crew * perPilot * factor / PERMILLE);
      v.step += 1;
      v.state = VS.WORKING;
      if (v.step >= workEnd) {
        if (v.travel_steps === 0) done();
        else v.state = VS.RETURNING;
      }
    }
  } else if (v.state === VS.RETURNING) {
    v.step += 1;
    if (v.step >= v.steps_total) done();
  }
  return { venture: v, corpDelta: delta, closed, held, holdLimit, tallies, kindEvents };
}

function stepCorpVenture(corp, venture, env, S) {
  const V = S.ventures;
  const now = env.now;
  if (venture && venture.step_due_at > now) {
    return { ok: true, corp: corpValues(corp), venture: null, nextAt: venture.step_due_at, ensure: false, journal: [],
      tallies: [], kindEvents: [], rest: null, skirmish: null };
  }
  if (venture) {
    const a = advanceVenture(corp, venture, env, S);
    if (a.defer === true) {
      return { ok: true, corp: corpValues(corp), venture: null, nextAt: now + ((S.wormholes && S.wormholes.syncWaitMs) || V.restMs), ensure: false,
        journal: [], tallies: a.tallies, kindEvents: [], rest: null, skirmish: null };
    }
    const c = corpValues(corp);
    const d = a.corpDelta;
    c.isk = Math.max(0, c.isk + d.isk);
    c.isk_earned += d.iskEarned;
    c.isk_lost += d.iskLost;
    c.ventures_done += d.done;
    c.ventures_lost += d.lost;
    c.recover_crew = d.recoverCrew;
    c.recover_until = d.recoverUntil;
    return { ok: true, corp: c, venture: { op: "update", expectedState: venture.state, row: a.venture },
      nextAt: a.closed ? now + V.restMs : a.venture.step_due_at, ensure: false, journal: [], tallies: a.tallies,
      kindEvents: a.kindEvents, rest: null, skirmish: a.skirmish || null,
      ...(a.whPatch !== undefined ? { whPatch: a.whPatch } : {}),
      ...(a.sale ? { sale: a.sale } : {}) };
  }
  const r = reviewCorp(corp, env, S);
  const rc = env.recycle ? { transition: r.transition, merge: r.merge || null, recruit: r.recruit || 0 } : {};
  if (r.transition === "DISSOLVED" || r.transition === "MERGED") {
    return { ok: true, corp: r.corp, venture: null, nextAt: now, ensure: false, journal: r.journal,
      tallies: r.tallies, kindEvents: [], rest: null, skirmish: null, reviewed: true, ...rc };
  }
  const reviewed = { ...corp, ...r.corp };
  const wh = env.whCorpsOn === true ? whHomeOf(corp, env) : null;
  const p = wh ? planWhCorpVenture(reviewed, wh, env, S) : planVenture(reviewed, env, S);
  if (!p.ok) {
    return { ok: true, corp: r.corp, venture: null, nextAt: now + V.restMs, ensure: r.grew, journal: r.journal,
      tallies: r.tallies.concat(["ventureRest", REST_COUNTERS[p.reason]], p.planTallies || []), kindEvents: [],
      rest: { reason: p.reason },
      skirmish: null, reviewed: true, ...rc,
      ...(p.whPatch ? { whPatch: p.whPatch } : {}) };
  }
  const c = r.corp;
  c.venture_seq = p.row.seq;
  if (p.row.kind === "BUILD") c.isk = Math.max(0, c.isk - p.row.cost_isk);
  return { ok: true, corp: c, venture: { op: "insert", row: p.row }, nextAt: p.row.step_due_at, ensure: r.grew,
    journal: r.journal, tallies: r.tallies.concat(["ventureStarted"], p.planTallies || []),
    kindEvents: [{ kind: p.row.kind, event: "started" }], rest: null, skirmish: null, reviewed: true, ...rc,
    ...(p.whPatch ? { whPatch: p.whPatch } : {}) };
}

module.exports = { reviewCorp, planVenture, advanceVenture, stepCorpVenture, corpValues, payoutOf };
