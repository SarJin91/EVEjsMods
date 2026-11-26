"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { VENTURE_STATES: VS, WAR_STATES, skirmishIdOf } = require("./schema");
const { resolveSkirmish } = require("./skirmish");
const D = require("./data/skirmish");

const PERMILLE = 1000;
const KIND = "HUNT";

const isHunter = (corp, pvp) => Boolean(pvp && pvp.hunting === true && corp.archetype === "hunter");
const activeWarOf = (corp, pvp) => {
  if (!pvp || pvp.wars !== true || typeof pvp.warOf !== "function") return null;
  const w = pvp.warOf(corp.corp_id);
  return w && w.state === WAR_STATES.ACTIVE ? w : null;
};
const huntJumpsOf = (S) => Math.min(S.hunting.huntMaxJumps, S.ventures.maxJumps);

function huntTargets(corp, reach, env, S) {
  if (!Array.isArray(reach)) return [];
  const pvp = env.pvp;
  const war = activeWarOf(corp, pvp);
  if (war) {
    const homes = new Set(war.enemyHomes);
    const enemy = reach.filter((e) => homes.has(e.systemId));
    if (enemy.length > 0) return enemy;
  }
  if (isHunter(corp, pvp)) {
    const max = huntJumpsOf(S);
    return reach.filter((e) => e.jumps <= max && D.RANDOM_PREY_BANDS.includes(e.secClass));
  }
  return war ? reach.slice() : [];
}

function pickPrey(corp, venture, env, S, rng) {
  const pvp = env.pvp;
  const reach = env.reachOf(venture.home_system_id);
  const list = Array.isArray(reach) ? reach : [];
  const war = activeWarOf(corp, pvp);
  const excluded = (id) => typeof pvp.isExcluded === "function" && pvp.isExcluded(id) === true;
  let cands = [];
  let warId = null;
  const rows = pvp && typeof pvp.prey === "function" ? (pvp.prey() || []) : [];
  if (war) {
    const enemies = new Set(war.enemies);
    const inReach = new Set(list.map((e) => e.systemId));
    cands = rows.filter((p) => enemies.has(p.corp_id) && inReach.has(p.system_id)
      && D.PREY_KINDS_WAR.includes(p.kind) && !excluded(p.corp_id));
    if (cands.length > 0) warId = war.warId;
  }
  if (cands.length === 0 && isHunter(corp, pvp)) {
    const max = huntJumpsOf(S);
    const area = new Set(list.filter((e) => e.jumps <= max).map((e) => e.systemId));
    const friends = new Set(war ? war.friends : []);
    cands = rows.filter((p) => p.corp_id !== corp.corp_id && !friends.has(p.corp_id) && area.has(p.system_id)
      && D.RANDOM_PREY_BANDS.includes(p.sec_band) && D.PREY_KINDS_RANDOM.includes(p.kind) && !excluded(p.corp_id));
  }
  cands = cands.slice().sort((a, b) => (a.venture_id < b.venture_id ? -1 : a.venture_id > b.venture_id ? 1 : 0));
  const prey = cands.length > 0 ? rng.pick(cands) : null;
  const engage = prey !== null && rng.nextInt(1, PERMILLE) <= S.hunting.engageChancePermille;
  let roamSystemId = venture.system_id;
  if (!engage) {
    const area = huntTargets(corp, list, env, S).map((e) => e.systemId).sort((a, b) => a - b);
    if (area.length > 0) roamSystemId = rng.pick(area);
  }
  return { prey, warId: prey ? warId : null, engage, roamSystemId };
}

function advanceHuntVenture(corp, venture, env, S) {
  if (venture.state !== VS.WORKING && venture.state !== VS.HELD) return null;
  const V = S.ventures;
  const H = S.hunting || {};
  const pvp = env.pvp;
  const now = env.now;
  const v = { ...venture };
  const delta = { isk: 0, iskEarned: 0, iskLost: 0, done: 0, lost: 0, recoverCrew: corp.recover_crew,
    recoverUntil: corp.recover_until };
  const tallies = ["ventureSteps", "huntSteps"];
  const kindEvents = [];
  let closed = null;
  let held = false;
  let holdLimit = false;
  let skirmish = null;
  const workEnd = v.travel_steps + v.work_steps;
  v.step_due_at = now + V.stepMs;
  const advance = () => {
    v.step += 1;
    v.state = VS.WORKING;
    if (v.step < workEnd) return;
    if (v.travel_steps > 0) {
      v.state = VS.RETURNING;
      return;
    }
    v.state = VS.DONE;
    v.open = 0;
    v.system_id = v.home_system_id;
    v.ended_at = now;
    delta.isk += v.yield_isk;
    delta.iskEarned += v.yield_isk;
    delta.done = 1;
    closed = "DONE";
    tallies.push("ventureDone");
    kindEvents.push({ kind: KIND, event: "done" });
  };
  const quiet = (systemId, counter) => {
    tallies.push(counter);
    v.yield_isk += Math.max(0, v.crew - v.crew_lost) * (H.yieldIskPerStepPerPilot || 0);
    v.system_id = systemId;
    advance();
  };
  const rng = createRng(deriveSeed(corp.seed, "vhunt", v.seq, v.step));
  const pick = pvp ? pickPrey(corp, v, env, S, rng) : { prey: null, warId: null, engage: false,
    roamSystemId: v.system_id };
  if (pick.prey === null) {
    quiet(pick.roamSystemId, "huntNoPrey");
  } else if (!(typeof pvp.budgetLeft === "function" && pvp.budgetLeft() >= 1)) {
    quiet(pick.roamSystemId, "huntBudget");
  } else if (!pick.engage) {
    quiet(pick.roamSystemId, "huntNoEngage");
  } else if (env.isObserved(pick.prey.system_id) === true) {
    if (v.holds < V.maxHolds) {
      v.state = VS.HELD;
      v.holds += 1;
      v.step_due_at = now + V.holdMs;
      v.system_id = pick.prey.system_id;
      held = true;
      tallies.push("huntHeld");
      kindEvents.push({ kind: KIND, event: "held" });
      skirmish = { kind: "HELD", prey: pick.prey, warId: pick.warId };
    } else {
      holdLimit = true;
      quiet(v.system_id, "huntHoldLimit");
    }
  } else {
    const seed = deriveSeed(corp.seed, "fcs", v.seq, v.step);
    const result = resolveSkirmish({ attacker: { crew: v.crew - v.crew_lost, kind: KIND },
      defender: { crew: pick.prey.crew - pick.prey.crew_lost, kind: pick.prey.kind }, band: pick.prey.sec_band, seed,
      iskPerPilot: V.shipLossIskPerPilot, lootPermille: H.lootPermille || 0 });
    skirmish = { kind: "FIGHT", skirmishId: skirmishIdOf(v.venture_id, v.step), seed, prey: pick.prey,
      warId: pick.warId, result };
    tallies.push("skirmishes");
    if (pick.warId) tallies.push("skirmishWar");
    if (result.outcome === "ATTACKER_WIN") {
      tallies.push("skirmishAttackerWins");
      if (result.crewLostA > 0) {
        const paid = Math.min(corp.isk, result.iskLostA);
        delta.isk -= paid;
        delta.iskLost += paid;
        delta.recoverCrew = result.crewLostA;
        delta.recoverUntil = now + V.recoverMs;
      }
      v.system_id = pick.prey.system_id;
      v.yield_isk += result.lootIsk;
      advance();
    } else {
      tallies.push("skirmishDefenderWins");
      v.system_id = pick.prey.system_id;
      v.crew_lost = result.crewLostA;
      v.cost_isk += result.iskLostA;
      v.state = VS.LOST;
      v.open = 0;
      v.ended_at = now;
      v.end_reason = pick.warId ? "WAR" : "SKIRMISH";
      const paid = Math.min(corp.isk, result.iskLostA);
      delta.isk -= paid;
      delta.iskLost += paid;
      delta.lost = 1;
      delta.recoverCrew = result.crewLostA;
      delta.recoverUntil = now + V.recoverMs;
      closed = "LOST";
      tallies.push("ventureLost");
      kindEvents.push({ kind: KIND, event: "lost" });
    }
  }
  return { venture: v, corpDelta: delta, closed, held, holdLimit, tallies, kindEvents, skirmish };
}

function defenderPatch(defCorp, defVenture, skirmish, now, S) {
  const V = S.ventures;
  const out = { venture: null, corp: null, tallies: [], kindEvents: [] };
  const v = defVenture;
  if (skirmish.kind === "HELD") {
    if (v.holds >= V.maxHolds) return out;
    out.venture = { expectedState: VS.WORKING, expectedVersion: v.version, row: { ...v, state: VS.HELD,
      holds: v.holds + 1, step_due_at: Math.max(v.step_due_at, now + V.holdMs) } };
    out.tallies.push("ventureHeld");
    out.kindEvents.push({ kind: v.kind, event: "held" });
    return out;
  }
  const r = skirmish.result;
  const { corpValues } = require("./ventures");
  const c = { ...corpValues(defCorp), next_at: defCorp.next_at };
  if (r.outcome === "ATTACKER_WIN") {
    const cost = v.cost_isk + r.iskLostD;
    out.venture = { expectedState: VS.WORKING, expectedVersion: v.version, row: { ...v, state: VS.LOST, open: 0,
      crew_lost: r.crewLostD, cost_isk: cost, ended_at: now, end_reason: skirmish.warId ? "WAR" : "HUNTED" } };
    const paid = Math.min(c.isk, r.iskLostD);
    c.isk -= paid;
    c.isk_lost += paid;
    c.ventures_lost += 1;
    c.recover_crew = r.crewLostD;
    c.recover_until = now + V.recoverMs;
    c.next_at = now + V.restMs;
    out.corp = c;
    out.tallies.push("ventureLost");
    out.kindEvents.push({ kind: v.kind, event: "lost" });
    return out;
  }
  if (r.crewLostD > 0) {
    const paid = Math.min(c.isk, r.iskLostD);
    c.isk -= paid;
    c.isk_lost += paid;
    c.recover_crew = r.crewLostD;
    c.recover_until = now + V.recoverMs;
    out.corp = c;
  }
  return out;
}

module.exports = { huntTargets, pickPrey, advanceHuntVenture, defenderPatch };
