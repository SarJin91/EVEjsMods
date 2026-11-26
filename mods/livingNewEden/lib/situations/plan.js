"use strict";

const { createRng } = require("../util/rng");
const { KINDS, PHASES, STATES, END_REASONS } = require("./schema");

const PERMILLE = 1000;

const TRANSITIONS = Object.freeze([
  Object.freeze({ from: PHASES.CALLING, to: PHASES.CALLING, on: "DISTRESS" }),
  Object.freeze({ from: PHASES.CALLING, to: PHASES.FIGHT, on: "SPAWN_PIRATES" }),
  Object.freeze({ from: PHASES.CALLING, to: STATES.UNANSWERED, on: "RESOLVE" }),
  Object.freeze({ from: PHASES.CALLING, to: STATES.ABANDONED, on: "RESOLVE" }),
  Object.freeze({ from: PHASES.CALLING, to: STATES.CANCELLED, on: "RESOLVE" }),
  Object.freeze({ from: PHASES.CALLING, to: STATES.RESCUED, on: "RESOLVE" }),
  Object.freeze({ from: PHASES.FIGHT, to: PHASES.FIGHT, on: "ENGAGE" }),
  Object.freeze({ from: PHASES.FIGHT, to: PHASES.FIGHT, on: "RETARGET" }),
  Object.freeze({ from: PHASES.FIGHT, to: STATES.RESCUED, on: "RESOLVE" }),
  Object.freeze({ from: PHASES.FIGHT, to: STATES.LOST, on: "RESOLVE" }),
  Object.freeze({ from: PHASES.FIGHT, to: STATES.ABANDONED, on: "RESOLVE" }),
  Object.freeze({ from: PHASES.FIGHT, to: STATES.CANCELLED, on: "RESOLVE" }),
]);

function isTransition(from, to) {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

function eligibleKinds(f) {
  const S = f && f.settings ? f.settings : {};
  const belts = f && f.beltCount > 0;
  const out = [];
  if (S.beltRaidWeight > 0 && belts) out.push({ kind: KINDS.BELT_RAID, weight: S.beltRaidWeight });
  if (S.gateAmbushEnabled === true && S.gateAmbushWeight > 0 && f.hotGateCount > 0) {
    out.push({ kind: KINDS.GATE_AMBUSH, weight: S.gateAmbushWeight });
  }
  if (S.strandedPodEnabled === true && S.strandedPodWeight > 0 && f.podProfile === true && f.podKindOff !== true
    && belts) {
    out.push({ kind: KINDS.STRANDED_POD, weight: S.strandedPodWeight });
  }
  return out;
}

function pickKind(eligible, kindSeed) {
  const list = Array.isArray(eligible) ? eligible : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].kind;
  const total = list.reduce((sum, e) => sum + e.weight, 0);
  let r = createRng(kindSeed).nextInt(0, total - 1);
  for (const e of list) {
    if (r < e.weight) return e.kind;
    r -= e.weight;
  }
  return list[list.length - 1].kind;
}

function rollSituation(input, S) {
  const rng = createRng(input.seed);
  if (rng.nextInt(0, PERMILLE - 1) >= S.chancePermille) return { roll: false };
  const band = S.bands.includes(input.secClass) && Object.prototype.hasOwnProperty.call(S.piratesBySec, input.secClass)
    ? S.piratesBySec[input.secClass] : null;
  if (!band) return { roll: false, reason: "NO_BAND" };
  const wantedKind = input.kind === undefined ? KINDS.BELT_RAID : input.kind;
  const belts = input.anchors && Array.isArray(input.anchors.belts) ? input.anchors.belts : [];
  if (wantedKind === null) return { roll: false, reason: belts.length === 0 ? "NO_ANCHOR" : "NO_KIND" };
  const kind = input.catalog && input.catalog[wantedKind] ? wantedKind : null;
  if (!kind) return { roll: false, reason: "NO_KIND" };
  const list = kind === KINDS.GATE_AMBUSH
    ? (input.anchors && Array.isArray(input.anchors.hotGates) ? input.anchors.hotGates : []) : belts;
  if (list.length === 0) return { roll: false, reason: "NO_ANCHOR" };
  const victims = rng.nextInt(S.victimsMin, S.victimsMax);
  const wanted = rng.nextInt(band.min, band.max);
  const count = Math.max(1, Math.min(wanted, S.maxShipsPerSituation - victims));
  const pirates = [];
  for (let i = 0; i < count; i += 1) pirates.push(Object.freeze({ hullGroup: rng.pick(band.hulls) }));
  const anchorIndex = rng.nextInt(0, list.length - 1);
  const victimPicks = [];
  for (let i = 0; i < victims; i += 1) victimPicks.push(rng.nextUint32());
  const speakerPick = rng.nextUint32();
  if (kind === KINDS.STRANDED_POD) {
    return { roll: true, kind, victims: 1, pirates: [], anchorIndex, victimPicks: victimPicks.slice(0, 1),
      speakerPick };
  }
  return { roll: true, kind, victims, pirates, anchorIndex, victimPicks, speakerPick };
}

const resolve = (outcome, reason) => ({ action: "RESOLVE", outcome, reason });

function decideStep(sit, facts, S) {
  const now = facts.now;
  if (sit.kind === KINDS.STRANDED_POD && sit.phase === PHASES.CALLING) {
    if (facts.sceneLoaded !== true) return resolve(STATES.ABANDONED, END_REASONS.SCENE_GONE);
    if (facts.victimsAlive <= 0) return resolve(STATES.ABANDONED, END_REASONS.VICTIMS_GONE);
    if (facts.rescuersInRange > 0 && sit.rescueSince !== null && sit.rescueSince !== undefined
      && now - sit.rescueSince >= S.rescueHoldMs) {
      return resolve(STATES.RESCUED, END_REASONS.PICKED_UP);
    }
    if (now >= sit.callingSince + S.callingTimeoutMs) return resolve(STATES.UNANSWERED, END_REASONS.TIMEOUT);
    if (sit.distressSent < S.distressLines && now >= sit.lastDistressAt + S.distressRepeatMs) {
      return { action: "DISTRESS" };
    }
    return { action: "NOOP" };
  }
  if (sit.phase === PHASES.CALLING) {
    if (facts.sceneLoaded !== true) return resolve(STATES.ABANDONED, END_REASONS.SCENE_GONE);
    if (facts.victimsAlive <= 0) return resolve(STATES.ABANDONED, END_REASONS.VICTIMS_GONE);
    if (facts.playersOnGrid > 0) return { action: "SPAWN_PIRATES" };
    if (now >= sit.callingSince + S.callingTimeoutMs) return resolve(STATES.UNANSWERED, END_REASONS.TIMEOUT);
    if (sit.distressSent < S.distressLines && now >= sit.lastDistressAt + S.distressRepeatMs) {
      return { action: "DISTRESS" };
    }
    return { action: "NOOP" };
  }
  if (sit.phase === PHASES.FIGHT) {
    if (facts.sceneLoaded !== true) return resolve(STATES.ABANDONED, END_REASONS.SCENE_GONE);
    if (facts.victimsAlive <= 0) return resolve(STATES.LOST, END_REASONS.VICTIMS_GONE);
    if (facts.piratesAlive <= 0) {
      return facts.pirateKillsByPlayers > 0 ? resolve(STATES.RESCUED, END_REASONS.PIRATES_DOWN)
        : resolve(STATES.ABANDONED, END_REASONS.NO_PLAYER_KILL);
    }
    if (now >= sit.fightSince + S.maxFightMs) return resolve(STATES.ABANDONED, END_REASONS.FIGHT_TIMEOUT);
    if (sit.absentSince !== null && sit.absentSince !== undefined && now - sit.absentSince >= S.abandonGraceMs) {
      return resolve(STATES.ABANDONED, END_REASONS.NO_PLAYER);
    }
    if (sit.engaged !== true) return { action: "ENGAGE" };
    if (facts.victimDied === true || (facts.aggressors > 0 && S.pirateRetaliate === true)) {
      return { action: "RETARGET" };
    }
    return { action: "NOOP" };
  }
  return { action: "NOOP" };
}

function helpersOf(sit, S) {
  const excluded = new Set(sit && sit.excluded ? [...sit.excluded] : []);
  const all = new Set([...(sit && sit.aggressors ? sit.aggressors : []), ...(sit && sit.killers ? sit.killers : []),
    ...(sit && sit.rescuers ? sit.rescuers : [])]);
  const ids = [...all].filter((id) => Number.isSafeInteger(id) && id > 0 && !excluded.has(id)).sort((a, b) => a - b);
  return { characterIds: ids.slice(0, S.maxHelpers) };
}

module.exports = { TRANSITIONS, isTransition, eligibleKinds, pickKind, rollSituation, decideStep, helpersOf };
