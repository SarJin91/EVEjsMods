"use strict";

const S = require("./schema");
const { stableDrift, driftHours } = require("./influenceRules");
const SOV = require("../sovStructures/schema");
const PSOV = require("../playerSov/schema");

const PLAYER_OP = Object.freeze({ ATTACK: "P_ATTACK", SAMPLE: "P_SAMPLE", REINFORCE: "P_REINFORCE",
  RETAKE: "P_RETAKE", LIFT: "P_LIFT" });
const PLAYER_NOTES = Object.freeze({ FRIENDLY: "PLAYER_SOV_FRIENDLY", RETAKING: "PLAYER_SOV_RETAKING",
  BUSY: "PLAYER_SOV_BUSY", SIEGE_STARTED: "PLAYER_SOV_SIEGE_STARTED", SIEGE: "PLAYER_SOV_SIEGE",
  PAUSED_OFFLINE: "PLAYER_SOV_PAUSED_OFFLINE", SIEGE_OBSERVED: "PLAYER_SOV_SIEGE_OBSERVED",
  REINFORCED: "PLAYER_SOV_REINFORCED", REINFORCED_WAIT: "PLAYER_SOV_REINFORCED_WAIT",
  REINFORCED_OBSERVED: "PLAYER_SOV_REINFORCED_OBSERVED" });

const T = Object.freeze({ SIGNAL: "signal", BATTLE: "battle", TICK: "tick", ABANDON: "abandon", REPEL: "repel" });

const TRANSITION_ROWS = [
  [S.STABLE, S.RECON, [T.SIGNAL]],
  [S.STABLE, S.CONTESTED, [T.SIGNAL]],
  [S.RECON, S.CONTESTED, [T.SIGNAL, T.BATTLE]],
  [S.RECON, S.STABLE, [T.TICK]],
  [S.CONTESTED, S.INVASION, [T.TICK]],
  [S.CONTESTED, S.STABLE, [T.TICK]],
  [S.INVASION, S.OCCUPIED, [T.TICK]],
  [S.INVASION, S.CONTESTED, [T.BATTLE, T.TICK, T.REPEL]],
  [S.OCCUPIED, S.CONSOLIDATING, [T.TICK]],
  [S.OCCUPIED, S.CONTESTED, [T.BATTLE, T.TICK, T.SIGNAL]],
  [S.CONSOLIDATING, S.STABLE, [T.TICK, T.ABANDON]],
  [S.CONSOLIDATING, S.OCCUPIED, [T.TICK]],
  [S.CONSOLIDATING, S.CONTESTED, [T.BATTLE, T.TICK, T.SIGNAL]],
  [S.STABLE, S.STABLE, [T.ABANDON]],
  [S.OCCUPIED, S.STABLE, [T.ABANDON]],
];

const TRANSITIONS = Object.freeze(TRANSITION_ROWS.map(([from, to, triggers]) => Object.freeze({ from, to,
  triggers: Object.freeze([...triggers]) })));
const EDGES = new Map(TRANSITIONS.map((e) => [`${e.from}>${e.to}`, e]));

function canTransition(from, to, trigger) {
  const e = EDGES.get(`${from}>${to}`);
  if (!e) return false;
  return trigger === undefined || e.triggers.includes(trigger);
}

function checkInvariants(s) {
  if ((s.occupier === null) !== (s.state === S.STABLE)) return "I1";
  if (S.CLAIM_STATES.includes(s.state) && s.occupier === s.controller) return "I2";
  if (S.HELD_STATES.includes(s.state) && s.occupier !== s.controller) return "I3";
  if (s.detachedSinceAt !== null && s.capturedAt === null) return "I4";
  return null;
}

function territoryUpkeepFactor(sys, at, params) {
  if (!sys || sys.capturedAt === null || sys.capturedAt === undefined || sys.detachedSinceAt === null
    || sys.detachedSinceAt === undefined) return 1;
  const periods = Math.floor(Math.max(0, at - sys.detachedSinceAt) / params.detachedUpkeepPeriodMs);
  return Math.min(params.detachedUpkeepMaxFactor, 1 + params.detachedUpkeepStep * periods);
}

const strengthOf = (view, f) => (f !== null && view.presence.has(f) ? view.presence.get(f).strength : 0);
const stationsOf = (view, f) => (f !== null && view.stations.has(f) ? view.stations.get(f) : 0);
const inRange = (view, f) => f !== null && view.inRange(f) === true;
const consolidatesOf = (view, f) => f === null ? true : (view.consolidates ? view.consolidates(f) : true);
const homeOf = (view, f) => f !== null && view.home !== null && f === view.home;

const ADJACENCY_NOTES = Object.freeze({ BLOCKED: "CAPTURE_NOT_ADJACENT", UNKNOWN: "ADJACENCY_UNKNOWN" });
const CANNOT_OCCUPY = "CANNOT_OCCUPY";

function adjacencyOf(view, f, params) {
  if (params.adjacencyGate !== true || typeof view.adjacent !== "function" || f === null) return true;
  if (homeOf(view, f) || (view.coreOwner ?? null) === f) return true;
  const a = view.adjacent(f);
  return a === true ? true : (a === false ? false : null);
}

function occupiesOf(view, f, params) {
  if (params.canOccupyGate !== true || typeof view.canOccupy !== "function" || f === null) return true;
  try {
    return view.canOccupy(f) !== false;
  } catch (_err) {
    return true;
  }
}

function noteCannotOccupy(notes) {
  if (!notes.includes(CANNOT_OCCUPY)) notes.push(CANNOT_OCCUPY);
}

function noteAdjacency(notes, adj) {
  const note = adj === false ? ADJACENCY_NOTES.BLOCKED : ADJACENCY_NOTES.UNKNOWN;
  if (!notes.includes(note)) notes.push(note);
}

function holderOf(view) {
  const present = [...view.presence.entries()].filter(([, p]) => p.strength > 0).map(([f]) => f).sort((a, b) => a - b);
  const free = present.filter((f) => !present.some((g) => g !== f && view.isHostile(f, g)));
  if (free.length === 1) return free[0];
  if (free.length === 0) return null;
  if (view.occupier !== null && free.includes(view.occupier)) return view.occupier;
  if (view.controller !== null && free.includes(view.controller)) return view.controller;
  return null;
}

function capturePaced(view, params) {
  const k = view && view.captureSlowFactor;
  if (!(k > 1) || !S.CLAIM_STATES.includes(view.state)) return params;
  return { ...params, holdPointsPerHour: params.holdPointsPerHour / k,
    decayPointsPerHour: params.decayPointsPerHour / k, invasionHoldMs: params.invasionHoldMs * k };
}

function accrue(view, holder, at, params, notes) {
  const base = view.evaluatedAt === null ? view.sinceAt : view.evaluatedAt;
  const h = Math.max(0, at - base) / S.MS_PER_HOUR;
  const supplied = (f) => inRange(view, f) || (f === view.controller && view.capturedAt === null);
  const factions = new Set([...view.influence.keys()]);
  for (const [f, p] of view.presence) if (p.strength > 0) factions.add(f);
  for (const [f, n] of view.stations) if (n > 0) factions.add(f);
  const scores = new Map();
  const updates = [];
  const additions = [];
  for (const f of [...factions].sort((a, b) => a - b)) {
    const row = view.influence.get(f) || null;
    const cur = row ? row.score : 0;
    const bonus = params.stationPointsPerHour * Math.min(stationsOf(view, f), params.stationBonusCap);
    let next = cur;
    if (holder !== null) {
      if (f === holder && supplied(f)) next = cur + h * (params.holdPointsPerHour + bonus);
      else if (f !== holder && row && view.isHostile(f, holder)
        && (stationsOf(view, f) === 0 || params.requireNoDefenderStations !== true)) {
        next = cur - h * params.decayPointsPerHour;
      }
    } else if (stationsOf(view, f) > 0) next = cur + h * bonus;
    const score = S.round2(next);
    const garrison = strengthOf(view, f);
    if (row) {
      scores.set(f, score);
      if (score !== cur || garrison !== row.garrison) {
        updates.push({ factionId: f, influenceScore: score, garrisonStrength: garrison });
      }
    } else if (score > 0 || garrison > 0) {
      additions.push({ factionId: f, influenceScore: score, garrisonStrength: garrison });
    }
  }
  const room = Math.max(0, params.maxFactionsPerSystem - view.influence.size);
  const kept = additions.slice(0, room);
  if (kept.length < additions.length) notes.push("FACTION_ROWS_FULL");
  for (const a of kept) scores.set(a.factionId, a.influenceScore);
  return { scores, entries: [...updates, ...kept].sort((a, b) => a.factionId - b.factionId) };
}

function driftOf(view, at, params) {
  const scores = new Map([...view.influence.entries()].map(([f, row]) => [f, row.score]));
  return stableDrift(scores, view.controller, driftHours(view.evaluatedAt, at), params);
}

function nextOf(state, sinceAt, idle, at, params) {
  if (state === S.STABLE) return null;
  const interval = idle ? params.idleEvalIntervalMs : params.evalIntervalMs;
  const bucket = Math.floor(at / interval) + 1;
  let dueAt = bucket * interval;
  const timeout = sinceAt + params.reconTimeoutMs;
  if (state === S.RECON && timeout > at) dueAt = Math.min(dueAt, timeout);
  return { dueAt, bucket, interval };
}

function clampAt(view, at) {
  return Math.max(at, view.sinceAt, view.evaluatedAt === null ? 0 : view.evaluatedAt);
}

function garrisonPlan(view, controller, params) {
  if (view.drawsGarrison && view.drawsGarrison(controller) === false) return [];
  const pres = controller === null ? null : view.presence.get(controller);
  if (!pres || params.garrisonFleetsTarget < 1) return [];
  const have = pres.fleets.filter((f) => f.fleetRole === S.GARRISON_ROLE).length;
  const need = params.garrisonFleetsTarget - have;
  if (need <= 0) return [];
  const fromRoles = Array.isArray(params.garrisonFromRoles) ? params.garrisonFromRoles : [];
  return pres.fleets.filter((f) => f.state === "IDLE" && f.refitPending !== true && f.fleetRole !== S.GARRISON_ROLE
    && fromRoles.includes(f.fleetRole))
    .sort((a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0))).slice(0, need)
    .map((f) => ({ fleetId: f.fleetId, expectedVersion: f.version, from: f.fleetRole }));
}

function emptyEvaluation(next, notes) {
  return { to: null, statePatch: {}, influence: [], reassign: [], next, notes, controllerChanged: false, sovOps: [],
    playerOps: [] };
}

function sampleNext(at, sampleMs) {
  const bucket = Math.floor(at / sampleMs) + 1;
  return { dueAt: bucket * sampleMs, bucket, interval: sampleMs };
}

function playerGate(view, P, at) {
  const c = view.playerClaim === undefined ? null : view.playerClaim;
  if (c === null || c.state === PSOV.LOST) return { pass: true, ops: [], note: null, wakeAt: null };
  const stop = (note) => ({ pass: false, ops: [], note, wakeAt: null });
  if (c.hostileTo(P) !== true) return stop(PLAYER_NOTES.FRIENDLY);
  if (c.state === PSOV.RETAKING) return stop(PLAYER_NOTES.RETAKING);
  if (c.attackerFactionId !== null && c.attackerFactionId !== undefined && c.attackerFactionId !== P) {
    return stop(PLAYER_NOTES.BUSY);
  }
  const p = c.params;
  const wakeAt = sampleNext(at, p.siegeSampleMs);
  if (c.state === PSOV.CAPTURING || c.state === PSOV.HELD) {
    return { pass: false, ops: [{ op: PLAYER_OP.ATTACK, claimId: c.claimId, factionId: P, version: c.version }],
      note: PLAYER_NOTES.SIEGE_STARTED, wakeAt };
  }
  const k = c.clock && c.clock.phase === c.state && c.clock.phaseKey === c.attackStartedAt ? c.clock
    : { creditedMs: 0, lastSampleAt: at, version: null };
  const observedPause = c.observed === true && p.pauseWhenObserved === true;
  const running = c.ownerOnline === true && !observedPause;
  const credit = running ? Math.min(Math.max(0, at - k.lastSampleAt), 2 * p.siegeSampleMs) : 0;
  const progress = k.creditedMs + credit;
  const sample = { op: PLAYER_OP.SAMPLE, claimId: c.claimId, phase: c.state, phaseKey: c.attackStartedAt,
    creditedMs: progress, sampledAt: at, expectVersion: k.version };
  const paused = c.ownerOnline !== true ? PLAYER_NOTES.PAUSED_OFFLINE
    : (c.state === PSOV.SIEGED ? PLAYER_NOTES.SIEGE_OBSERVED : PLAYER_NOTES.REINFORCED_OBSERVED);
  if (c.state === PSOV.SIEGED) {
    if (progress < p.siegeHoldMs) {
      return { pass: false, ops: [sample], note: running ? PLAYER_NOTES.SIEGE : paused, wakeAt };
    }
    return { pass: false, ops: [sample, { op: PLAYER_OP.REINFORCE, claimId: c.claimId, version: c.version,
      until: at + p.reinforceMs }], note: PLAYER_NOTES.REINFORCED, wakeAt };
  }
  if (c.state !== PSOV.REINFORCED) return stop(null);
  if (progress < p.reinforceMs || !running) {
    return { pass: false, ops: [sample], note: running ? PLAYER_NOTES.REINFORCED_WAIT : paused, wakeAt };
  }
  return { pass: false, ops: [sample, { op: PLAYER_OP.RETAKE, claimId: c.claimId, factionId: P, version: c.version }],
    note: PLAYER_NOTES.RETAKING, wakeAt: null };
}

function playerFollowUp(view, d, stateAfter, taken) {
  const c = view.playerClaim;
  if (!c || taken || (c.state !== PSOV.SIEGED && c.state !== PSOV.REINFORCED)) return [];
  const attacker = c.attackerFactionId === undefined ? null : c.attackerFactionId;
  if (attacker === null || (stateAfter === S.INVASION && d.occupier === attacker)) return [];
  return [{ op: PLAYER_OP.LIFT, claimId: c.claimId, version: c.version }];
}

function sovGate(view, P, isHomeReclaim, at) {
  const sov = view.sov === undefined ? null : view.sov;
  if (sov === null || isHomeReclaim || !sov.needs(P)) return { pass: true, op: null, note: null };
  const live = (sov.structures || []).filter((s) => SOV.LIVE_STATES.includes(s.state));
  const foreign = live.find((s) => s.factionId !== P) || null;
  if (foreign !== null) return siegeOf(view, sov, foreign, P, at);
  const own = live.find((s) => s.factionId === P) || null;
  if (own === null) {
    if (sov.adoptPending === true && view.controller !== null && view.controller !== P) {
      return { pass: false, op: null, note: SOV.NOTES.ADOPT_PENDING };
    }
    return { pass: false, op: { op: SOV.OP.ANCHOR, factionId: P, claimSeq: view.seq },
      note: SOV.NOTES.ANCHOR_REQUESTED };
  }
  if (own.state === SOV.ANCHORING) return { pass: false, op: null, note: SOV.NOTES.ANCHORING };
  return { pass: true, op: { op: SOV.OP.BIND, structureId: own.structureId, capturedAt: at }, note: null };
}

function siegeOf(view, sov, foreign, P, at) {
  if (foreign.factionId !== view.controller) return { pass: false, op: null, note: SOV.NOTES.FOREIGN };
  if (foreign.attackerFactionId !== P) {
    return { pass: false, op: { op: SOV.OP.ATTACK, structureId: foreign.structureId, factionId: P,
      version: foreign.version }, note: SOV.NOTES.SIEGE_STARTED };
  }
  const holdMs = Number.isSafeInteger(sov.siegeHoldMs) && sov.siegeHoldMs > 0 ? sov.siegeHoldMs : 0;
  if (at < foreign.attackStartedAt + holdMs) return { pass: false, op: null, note: SOV.NOTES.SIEGE };
  if (sov.observed === true && sov.pauseWhenObserved === true) {
    return { pass: false, op: null, note: SOV.NOTES.SIEGE_OBSERVED };
  }
  return { pass: false, op: { op: SOV.OP.DESTROY, structureId: foreign.structureId, reason: SOV.REASON.SIEGE,
    byFactionId: P, version: foreign.version }, note: SOV.NOTES.CONTROL_RELEASED, release: true };
}

function sovEarly(view, P, isHomeReclaim, defenderWeak) {
  const none = { op: null, note: null };
  const sov = view.sov === undefined ? null : view.sov;
  if (sov === null || sov.earlyTimers !== true || isHomeReclaim || !sov.needs(P)) return none;
  if (view.playerClaim !== undefined && view.playerClaim !== null) return none;
  const live = (sov.structures || []).filter((s) => SOV.LIVE_STATES.includes(s.state));
  const foreign = live.find((s) => s.factionId !== P) || null;
  if (foreign !== null) {
    if (foreign.factionId !== view.controller || foreign.attackerFactionId === P) return none;
    return { op: { op: SOV.OP.ATTACK, structureId: foreign.structureId, factionId: P, version: foreign.version },
      note: SOV.NOTES.SIEGE_STARTED };
  }
  if (live.some((s) => s.factionId === P)) return none;
  if (sov.adoptPending === true && view.controller !== null && view.controller !== P) {
    return { op: null, note: SOV.NOTES.ADOPT_PENDING };
  }
  if (defenderWeak !== true) return none;
  return { op: { op: SOV.OP.ANCHOR, factionId: P, claimSeq: view.seq }, note: SOV.NOTES.ANCHOR_REQUESTED };
}

function sovFollowUp(view, d, stateAfter, H, taken) {
  const ops = [];
  for (const s of view.sov.structures || []) {
    if (!SOV.LIVE_STATES.includes(s.state) || taken.has(s.structureId)) continue;
    const keeps = s.factionId === d.controller || (stateAfter === S.INVASION && d.occupier === s.factionId);
    if (keeps) {
      const attacker = s.attackerFactionId === undefined ? null : s.attackerFactionId;
      if (attacker !== null && (stateAfter !== S.INVASION || d.occupier !== attacker)) {
        ops.push({ op: SOV.OP.LIFT, structureId: s.structureId, version: s.version });
      }
      continue;
    }
    if (H !== null && view.isHostile(H, s.factionId)) {
      ops.push({ op: SOV.OP.DESTROY, structureId: s.structureId, reason: SOV.REASON.FIELD_LOST, byFactionId: H });
    } else {
      ops.push({ op: SOV.OP.END, structureId: s.structureId,
        reason: s.factionId === view.controller ? SOV.REASON.CONTROL_LOST : SOV.REASON.CLAIM_LOST, byFactionId: null });
    }
  }
  return ops;
}

function finish(view, d, params) {
  const state = d.to === null ? view.state : d.to;
  const seq = d.to === null ? view.seq : view.seq + 1;
  const sinceAt = d.to === null ? view.sinceAt : d.at;
  let next = nextOf(state, sinceAt, d.idle === true, d.at, params);
  if (next !== null && d.wakeAt && d.wakeAt.dueAt < next.dueAt) next = d.wakeAt;
  if (d.to !== null && !canTransition(view.state, d.to, d.trigger)) {
    return emptyEvaluation(nextOf(view.state, view.sinceAt, false, d.at, params),
      [...d.notes, "OCCUPATION_TRANSITION_DENIED"]);
  }
  const bad = checkInvariants({ state, controller: d.controller, occupier: d.occupier, capturedAt: d.capturedAt,
    detachedSinceAt: d.detachedSinceAt });
  if (bad !== null) {
    return emptyEvaluation(nextOf(view.state, view.sinceAt, false, d.at, params), [...d.notes, `INVARIANT_${bad}`]);
  }
  const statePatch = {
    occupationState: state,
    controllerFactionId: d.controller,
    occupierFactionId: d.occupier,
    previousControllerFactionId: d.previousController,
    phaseSeq: seq,
    phaseDueAt: next ? next.dueAt : null,
    influenceEvaluatedAt: d.at,
    capturedAt: d.capturedAt,
    detachedSinceAt: d.detachedSinceAt,
  };
  return { to: d.to, statePatch, influence: d.influence, reassign: d.reassign || [], next, notes: d.notes,
    controllerChanged: d.controller !== view.controller, sovOps: Array.isArray(d.sovOps) ? d.sovOps : [],
    playerOps: Array.isArray(d.playerOps) ? d.playerOps : [] };
}

function evaluate(view, trigger, params) {
  try {
    params = capturePaced(view, params);
    const at = clampAt(view, view.at);
    if (view.state === S.STABLE) return emptyEvaluation(null, ["STABLE"]);
    if (view.deferred === true) {
      return emptyEvaluation(nextOf(view.state, view.sinceAt, false, at, params), ["DEFERRED"]);
    }
    if (view.presenceTruncated === true) {
      return emptyEvaluation(nextOf(view.state, view.sinceAt, false, at, params), ["TRUNCATED"]);
    }
    const notes = [];
    const C = view.controller;
    const P = view.occupier;
    const H = holderOf(view);
    const K = view.coreOwner ?? null;
    const acc = accrue(view, H, at, params, notes);
    const score = (f) => (f === null ? 0 : (acc.scores.has(f) ? acc.scores.get(f) : 0));
    const since = view.sinceAt;
    const rangeP = inRange(view, P);
    const rangeC = inRange(view, C);
    const rangeEffC = rangeC || view.capturedAt === null;
    const rangeKnown = view.rangeKnown !== false;
    const hostileHolderOfC = H !== null && C !== null && view.isHostile(H, C);
    const d = { trigger: T.TICK, to: null, controller: C, occupier: P, previousController: view.previousController,
      capturedAt: view.capturedAt, detachedSinceAt: view.detachedSinceAt, at, influence: acc.entries, notes };
    const held = S.HELD_STATES.includes(view.state);
    const sovOps = [];
    const playerOps = [];

    if (d.to === null && K !== null && S.CLAIM_STATES.includes(view.state) && P !== null && P !== K) {
      if (view.state === S.RECON || view.state === S.CONTESTED) {
        Object.assign(d, { trigger: T.TICK, to: S.STABLE, occupier: null });
        notes.push("CORE_PROTECTED");
      } else if (view.state === S.INVASION) {
        Object.assign(d, { trigger: T.TICK, to: S.CONTESTED, occupier: P });
        notes.push("CORE_PROTECTED");
      }
    }

    if (trigger && trigger.kind === T.BATTLE) {
      const W = trigger.winnerFactionId === undefined ? null : trigger.winnerFactionId;
      const L = trigger.loserFactionId === undefined ? null : trigger.loserFactionId;
      if (view.state === S.INVASION && P !== null && L === P && W !== null && view.isHostile(W, P)) {
        Object.assign(d, { trigger: T.BATTLE, to: S.CONTESTED });
        notes.push("INTERRUPTED");
      } else if (held && C !== null && L === C && W !== null && view.isHostile(W, C)) {
        if (K !== null && W !== K) notes.push("CORE_PROTECTED");
        else if (!occupiesOf(view, W, params)) noteCannotOccupy(notes);
        else {
          const adjW = adjacencyOf(view, W, params);
          if (adjW !== true) noteAdjacency(notes, adjW);
          else {
            Object.assign(d, { trigger: T.BATTLE, to: S.CONTESTED, occupier: W });
            notes.push("INTERRUPTED");
          }
        }
      } else if (view.state === S.RECON && W !== null && W === P) {
        const adjP = adjacencyOf(view, P, params);
        if (!occupiesOf(view, P, params)) noteCannotOccupy(notes);
        else if (adjP !== true) noteAdjacency(notes, adjP);
        else Object.assign(d, { trigger: T.BATTLE, to: S.CONTESTED });
      }
    }
    if (d.to === null && trigger && trigger.kind === T.REPEL) {
      const L = trigger.loserFactionId === undefined ? null : trigger.loserFactionId;
      if (view.state === S.INVASION && P !== null && L === P) {
        Object.assign(d, { trigger: T.REPEL, to: S.CONTESTED });
        notes.push("INTERRUPTED", "PLAYER_REPEL");
      }
    }
    const coreBlocksH = hostileHolderOfC && K !== null && H !== K;
    if (coreBlocksH && held && !notes.includes("CORE_PROTECTED")) notes.push("CORE_PROTECTED");
    let interruptByH = hostileHolderOfC && !coreBlocksH;
    if (interruptByH && held && d.to === null && !occupiesOf(view, H, params)) {
      interruptByH = false;
      noteCannotOccupy(notes);
    }
    if (interruptByH && held && d.to === null) {
      const adjH = adjacencyOf(view, H, params);
      if (adjH !== true) {
        interruptByH = false;
        noteAdjacency(notes, adjH);
      }
    }

    if (d.to === null) {
      switch (view.state) {
        case S.RECON:
          if (at >= since + params.reconTimeoutMs) Object.assign(d, { to: S.STABLE, occupier: null });
          break;
        case S.CONTESTED: {
          const adjP = adjacencyOf(view, P, params);
          if (!occupiesOf(view, P, params)) {
            Object.assign(d, { to: S.STABLE, occupier: null });
            noteCannotOccupy(notes);
            break;
          }
          if (adjP === false) {
            Object.assign(d, { to: S.STABLE, occupier: null });
            noteAdjacency(notes, adjP);
          } else if (adjP === true && H === P && score(P) >= params.invasionMinScore && rangeP) d.to = S.INVASION;
          else if (strengthOf(view, P) === 0 && at >= since + params.contestTimeoutMs) {
            Object.assign(d, { to: S.STABLE, occupier: null });
            notes.push("REPELLED");
          }
          if (adjP === null) noteAdjacency(notes, adjP);
          break;
        }
        case S.INVASION: {
          const adjP = H === P ? adjacencyOf(view, P, params) : true;
          if (H !== P) {
            d.to = S.CONTESTED;
            notes.push("INTERRUPTED");
          } else if (!occupiesOf(view, P, params)) {
            d.to = S.CONTESTED;
            noteCannotOccupy(notes);
          } else if (adjP === false) {
            d.to = S.CONTESTED;
            noteAdjacency(notes, adjP);
          } else if (adjP === null) {
            noteAdjacency(notes, adjP);
          } else if (at >= since + params.invasionHoldMs && score(P) >= params.occupyMinScore
            && score(C) <= params.occupyMaxDefenderScore
            && (stationsOf(view, C) === 0 || params.requireNoDefenderStations !== true) && rangeP) {
            const isHomeReclaim = homeOf(view, P);
            const pg = playerGate(view, P, at);
            for (const op of pg.ops) playerOps.push(op);
            if (pg.note !== null) notes.push(pg.note);
            if (pg.wakeAt !== null) d.wakeAt = pg.wakeAt;
            const gate = pg.pass ? sovGate(view, P, isHomeReclaim, at) : { pass: false, op: null, note: null };
            if (gate.op !== null) sovOps.push(gate.op);
            if (gate.note !== null) notes.push(gate.note);
            if (gate.release === true) {
              Object.assign(d, { controller: null, previousController: C, capturedAt: null, detachedSinceAt: null });
            }
            if (gate.pass) {
              Object.assign(d, { to: S.OCCUPIED, controller: P, previousController: C,
                capturedAt: isHomeReclaim ? null : at, detachedSinceAt: null });
              if (isHomeReclaim) notes.push("HOME_RECLAIMED");
            }
          } else if (rangeP && (stationsOf(view, C) === 0 || params.requireNoDefenderStations !== true)) {
            const early = sovEarly(view, P, homeOf(view, P), score(C) <= params.occupyMaxDefenderScore);
            if (early.op !== null) sovOps.push(early.op);
            if (early.note !== null) notes.push(early.note);
          }
          break;
        }
        case S.OCCUPIED:
          if (interruptByH) {
            Object.assign(d, { to: S.CONTESTED, occupier: H });
            notes.push("INTERRUPTED");
          } else if (at >= since + params.occupiedSettleMs && H === C && rangeEffC && consolidatesOf(view, C)) {
            Object.assign(d, { to: S.CONSOLIDATING, detachedSinceAt: null });
          } else if (at >= since + params.occupiedSettleMs && H === C && rangeEffC && !consolidatesOf(view, C)) {
            notes.push("NO_CONSOLIDATION");
          }
          break;
        case S.CONSOLIDATING: {
          if (interruptByH) {
            Object.assign(d, { to: S.CONTESTED, occupier: H });
            notes.push("INTERRUPTED");
          } else if (!consolidatesOf(view, C)) {
            d.to = S.OCCUPIED;
            notes.push("NO_CONSOLIDATION");
          } else if ((rangeKnown && !rangeEffC) || strengthOf(view, C) === 0) {
            d.to = S.OCCUPIED;
            notes.push("NO_CONSOLIDATION");
          } else {
            let residual = 0;
            for (const [f, v] of acc.scores) if (C !== null && view.isHostile(f, C)) residual = Math.max(residual, v);
            if ((rangeKnown && rangeEffC) || d.capturedAt === null) {
              if (at >= since + params.consolidateMs && score(C) >= params.stableMinScore
                && residual <= params.stableMaxResidualScore) {
                Object.assign(d, { to: S.STABLE, occupier: null });
              }
            }
          }
          break;
        }
        default:
          notes.push("UNKNOWN_STATE");
      }
    }
    const state = d.to === null ? view.state : d.to;
    if (rangeKnown && S.HELD_STATES.includes(state) && d.capturedAt !== null && d.controller === C) {
      if (!rangeC && d.detachedSinceAt === null) {
        d.detachedSinceAt = at;
        notes.push("DETACHED");
      } else if (rangeC && d.detachedSinceAt !== null) d.detachedSinceAt = null;
    }
    const newC = d.controller;
    const rangeNewC = newC === C ? rangeC : (newC === P ? rangeP : false);
    const rangeEffNewC = rangeNewC || d.capturedAt === null;
    d.idle = state === S.OCCUPIED && (!rangeEffNewC || strengthOf(view, newC) === 0);
    d.reassign = S.HELD_STATES.includes(state) ? garrisonPlan(view, newC, params) : [];
    if (view.sov !== undefined && view.sov !== null) {
      const taken = new Set(sovOps.map((o) => o.structureId).filter((id) => typeof id === "string"));
      d.sovOps = [...sovOps, ...sovFollowUp(view, d, state, H, taken)];
    }
    if (view.playerClaim !== undefined && view.playerClaim !== null) {
      d.playerOps = [...playerOps, ...playerFollowUp(view, d, state, playerOps.length > 0)];
    }
    return finish(view, d, params);
  } catch (err) {
    let next = null;
    try {
      next = nextOf(view.state, view.sinceAt, false, view.at, params);
    } catch (_err) {
      next = null;
    }
    return emptyEvaluation(next, [`EVALUATE_THREW:${String((err && err.message) || err).slice(0, 80)}`]);
  }
}

function applySignal(view, spec, activeCount, params) {
  try {
    params = capturePaced(view, params);
    const F = spec && spec.factionId;
    const signal = spec && spec.signal;
    if (!Number.isSafeInteger(F) || F <= 0 || !S.SIGNALS.includes(signal)) {
      return { ok: false, reason: "OCCUPATION_INVALID_INPUT" };
    }
    const C = view.controller;
    const P = view.occupier;
    const at = clampAt(view, view.at);
    const state = view.state;
    const K = view.coreOwner ?? null;
    if (K !== null && F !== K) {
      return { ok: false, reason: "CORE_PROTECTED" };
    }
    if (F === C) return { ok: false, reason: "OWN_SYSTEM" };
    if (C !== null && !view.isHostile(F, C)) return { ok: false, reason: "NOT_HOSTILE" };
    if (S.BUSY_STATES.includes(state)) {
      return P === F ? { ok: true, outcome: "NOOP", evaluation: null } : { ok: false, reason: "OCCUPATION_BUSY" };
    }
    if (state === S.RECON && P === F && signal === "RECON") return { ok: true, outcome: "NOOP", evaluation: null };
    if (S.HELD_STATES.includes(state) && signal === "RECON") return { ok: false, reason: "OCCUPATION_BUSY" };
    if (!inRange(view, F)) return { ok: false, reason: "OUT_OF_CAPTURE_RANGE" };
    if (!occupiesOf(view, F, params)) return { ok: false, reason: CANNOT_OCCUPY };
    const notes = [];
    const d = { trigger: T.SIGNAL, to: null, controller: C, occupier: F, previousController: view.previousController,
      capturedAt: view.capturedAt, detachedSinceAt: view.detachedSinceAt, at, influence: [], notes };
    let outcome;
    if (state === S.STABLE) {
      if (activeCount >= params.maxActiveSystems) return { ok: false, reason: "OCCUPATION_CAPACITY" };
      d.to = signal === "RECON" ? S.RECON : S.CONTESTED;
      outcome = "STARTED";
      d.influence = driftOf(view, at, params);
    } else {
      d.influence = accrue(view, holderOf(view), at, params, notes).entries;
      if (state === S.RECON) {
        d.to = signal === "INVASION" ? S.CONTESTED : null;
        outcome = signal === "INVASION" ? "ESCALATED" : "STARTED";
      } else {
        d.to = S.CONTESTED;
        outcome = "ESCALATED";
      }
    }
    const evaluation = finish(view, d, params);
    if (evaluation.notes.some((n) => n.startsWith("INVARIANT_") || n === "OCCUPATION_TRANSITION_DENIED")) {
      return { ok: false, reason: "OCCUPATION_TRANSITION_DENIED", notes: evaluation.notes };
    }
    return { ok: true, outcome, evaluation, drift: state === S.STABLE ? d.influence.length : 0 };
  } catch (err) {
    return { ok: false, reason: "OCCUPATION_SIGNAL_THREW", detail: String((err && err.message) || err).slice(0, 80) };
  }
}

function planAbandon(view, params) {
  if (![S.STABLE, ...S.HELD_STATES].includes(view.state)) return { ok: false, reason: "OCCUPATION_IN_PROGRESS" };
  if (view.state === S.STABLE && view.controller === null) return { ok: true, outcome: "NOOP", evaluation: null };
  const K = view.coreOwner ?? null;
  if (K !== null && view.controller === K) {
    return { ok: false, reason: "CORE_PROTECTED" };
  }
  const at = clampAt(view, view.at);
  const influence = view.state === S.STABLE ? driftOf(view, at, params) : [];
  const evaluation = finish(view, { trigger: T.ABANDON, to: S.STABLE, controller: null, occupier: null,
    previousController: view.controller === null ? view.previousController : view.controller, capturedAt: null,
    detachedSinceAt: null, at, influence, notes: ["ABANDONED"] }, params);
  if (evaluation.to === null) return { ok: false, reason: "OCCUPATION_TRANSITION_DENIED", notes: evaluation.notes };
  return { ok: true, outcome: "ABANDONED", evaluation };
}

function planRelease(view) {
  if (!S.CLAIM_STATES.includes(view.state)) return { ok: false, reason: "OCCUPATION_NOT_CLAIM" };
  if (view.controller === null) return { ok: true, outcome: "NOOP", evaluation: null };
  const K = view.coreOwner ?? null;
  if (K !== null && view.controller === K) return { ok: false, reason: "CORE_PROTECTED" };
  const bad = checkInvariants({ state: view.state, controller: null, occupier: view.occupier, capturedAt: null,
    detachedSinceAt: null });
  if (bad !== null) return { ok: false, reason: "OCCUPATION_TRANSITION_DENIED", notes: [`INVARIANT_${bad}`] };
  return { ok: true, outcome: "RELEASED", evaluation: { to: null,
    statePatch: { controllerFactionId: null, previousControllerFactionId: view.controller, capturedAt: null,
      detachedSinceAt: null },
    influence: [], reassign: [], next: null, notes: ["RELEASED"], controllerChanged: true } };
}

function planBastionRestore(view, B, params) {
  try {
    if (!view || !Number.isSafeInteger(B) || B <= 0 || !params) {
      return { ok: false, reason: "OCCUPATION_TRANSITION_DENIED", notes: ["INVALID_INPUT"] };
    }
    const controller = view.controller ?? null;
    const home = view.home ?? null;
    const occupier = view.occupier ?? null;
    const capturedAt = view.capturedAt ?? null;
    const influence = [];
    const rows = view.influence instanceof Map ? view.influence : new Map();
    const own = rows.has(B) ? rows.get(B).score : null;
    const ownNext = S.round2(Math.max(own === null ? 0 : own, params.stableBaselineScore));
    if (own === null || ownNext !== own) influence.push({ factionId: B, influenceScore: ownNext });
    for (const [factionId, row] of rows) {
      if (factionId === B) continue;
      const next = S.round2(Math.min(row.score, params.stableForeignFloorScore));
      if (next !== row.score) influence.push({ factionId, influenceScore: next });
    }
    influence.sort((a, b) => a.factionId - b.factionId);
    const structureOk = controller === B && home === B && view.state === S.STABLE && occupier === null
      && capturedAt === null;
    if (structureOk && influence.length === 0) return { ok: true, outcome: "NOOP", evaluation: null };
    if (structureOk) {
      return { ok: true, outcome: "RESTORED", evaluation: { to: S.STABLE,
        statePatch: { influenceEvaluatedAt: clampAt(view, view.at) }, influence,
        notes: ["BASTION_INFLUENCE_RESTORED"], controllerChanged: false, homeChanged: false } };
    }
    const bad = checkInvariants({ state: S.STABLE, controller: B, occupier: null, capturedAt: null,
      detachedSinceAt: null });
    if (bad !== null) return { ok: false, reason: "OCCUPATION_TRANSITION_DENIED", notes: [`INVARIANT_${bad}`] };
    const statePatch = { controllerFactionId: B, occupationState: S.STABLE, occupierFactionId: null, capturedAt: null,
      detachedSinceAt: null, phaseDueAt: null, influenceEvaluatedAt: clampAt(view, view.at) };
    if (controller !== null && controller !== B) statePatch.previousControllerFactionId = controller;
    if (view.state !== S.STABLE) statePatch.phaseSeq = view.seq + 1;
    return { ok: true, outcome: "RESTORED", evaluation: { to: S.STABLE, statePatch, influence,
      notes: ["BASTION_RESTORED"], controllerChanged: controller !== B, homeChanged: home !== B } };
  } catch (_err) {
    return { ok: false, reason: "OCCUPATION_TRANSITION_DENIED", notes: ["PLAN_THREW"] };
  }
}

module.exports = {
  TRANSITIONS,
  TRIGGERS: T,
  ADJACENCY_NOTES,
  CANNOT_OCCUPY,
  canTransition,
  checkInvariants,
  evaluate,
  applySignal,
  planAbandon,
  planRelease,
  planBastionRestore,
  territoryUpkeepFactor,
  holderOf,
  accrue,
  nextOf,
  capturePaced,
  playerGate,
  playerFollowUp,
  PLAYER_OP,
  PLAYER_NOTES,
};
