"use strict";

const S = require("./schema");
const { STRUCTURE_DEFENSE, STRUCTURE_DEFENSE_VERSION, TIMER_SECONDS, BAND_OF_SEC_CLASS, MEDIUM_SIZE } =
  require("../data/structureDefense");
const { buildPowerTable, strengthOf } = require("../../strategy/ai/strength");
const { CONTACTABLE_STATES } = require("../../battle/data/contactRules");

const MS_PER_S = 1000;
const ENGAGED = "ENGAGED";
const STATION_ONLINE = "ONLINE";
const STATION_ANCHORING = "ANCHORING";
const STATION_ARMOR = "ARMOR_REINFORCE";
const STATION_HULL = "HULL_REINFORCE";
const STATION_DESTROYED = "DESTROYED";
const KIND_NPC = "npc";
const FAMILY_NPC = "npc";
const DEFAULT_BAND = "null";
const HIGHSEC = "highsec";

const SIEGE_TRANSITIONS = Object.freeze({
  SHIELD_ASSAULT: Object.freeze([S.ARMOR_TIMER, S.REPELLED, S.ABORTED]),
  ARMOR_TIMER: Object.freeze([S.ARMOR_ASSAULT, S.REPELLED, S.ABORTED]),
  ARMOR_ASSAULT: Object.freeze([S.HULL_TIMER, S.REPELLED, S.ABORTED]),
  HULL_TIMER: Object.freeze([S.HULL_ASSAULT, S.REPELLED, S.ABORTED]),
  HULL_ASSAULT: Object.freeze([S.DESTROYED, S.CAPTURED, S.SACKED, S.REPELLED, S.ABORTED]),
  ANCHOR_ASSAULT: Object.freeze([S.DESTROYED, S.REPELLED, S.ABORTED]),
  REPELLED: Object.freeze([]),
  DESTROYED: Object.freeze([]),
  CAPTURED: Object.freeze([]),
  SACKED: Object.freeze([]),
  ABORTED: Object.freeze([]),
});

const STATION_STATE_OF = Object.freeze({
  SHIELD_ASSAULT: STATION_ONLINE, ARMOR_TIMER: STATION_ARMOR, ARMOR_ASSAULT: STATION_ARMOR,
  HULL_TIMER: STATION_HULL, HULL_ASSAULT: STATION_HULL, ANCHOR_ASSAULT: STATION_ANCHORING,
});

const START_REASON_RANK = Object.freeze(["NO_TARGET", "CORE_PROTECTED", "BUSY", "REPEL_COOLDOWN", "LIMIT", "CONTESTED",
  "INSUFFICIENT_FORCE"]);

const START_PHASES = Object.freeze({ anchor: Object.freeze(["anchor"]),
  shield: Object.freeze(["shield", "armor", "hull"]) });

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const powerTables = new WeakMap();

function canTransitionSiege(from, to) {
  if (!S.SIEGE_STATES.includes(from) || !S.SIEGE_STATES.includes(to)) {
    return { ok: false, reason: "UNKNOWN_STATE", from, to };
  }
  if (!SIEGE_TRANSITIONS[from].includes(to)) return { ok: false, reason: "TRANSITION_NOT_ALLOWED", from, to };
  return { ok: true };
}

function stationStateFor(siegeState) {
  return Object.prototype.hasOwnProperty.call(STATION_STATE_OF, siegeState) ? STATION_STATE_OF[siegeState] : null;
}

function familyOf(station) {
  if (!station) return null;
  return station.kind === KIND_NPC ? FAMILY_NPC : station.structureFamily;
}

function buildPlan(station, secClass, params) {
  const p = params || {};
  if (!(isNum(p.timerScale) && p.timerScale > 0) || !isCount(p.assaultMinMs) || !isCount(p.assaultMaxMs)
    || p.assaultMaxMs < p.assaultMinMs) {
    return { ok: false, reason: "PARAMS_INVALID" };
  }
  const family = familyOf(station);
  const d = typeof family === "string" && Object.prototype.hasOwnProperty.call(STRUCTURE_DEFENSE, family)
    ? STRUCTURE_DEFENSE[family] : null;
  if (!d) return { ok: false, reason: "UNKNOWN_FAMILY" };
  const band = Object.prototype.hasOwnProperty.call(BAND_OF_SEC_CLASS, secClass) ? BAND_OF_SEC_CLASS[secClass]
    : DEFAULT_BAND;
  const armorSec = d.size === MEDIUM_SIZE ? TIMER_SECONDS.armorMedium[band] : TIMER_SECONDS.armorDefault;
  const hullSec = TIMER_SECONDS.hull[band];
  const scaled = (sec) => Math.round(sec * MS_PER_S * p.timerScale);
  return { ok: true, plan: Object.freeze({ v: S.PLAN_VERSION, defenseVersion: STRUCTURE_DEFENSE_VERSION, family,
    band, armorTimerMs: scaled(armorSec), hullTimerMs: scaled(hullSec),
    ehp: Object.freeze({ shield: d.ehp.shield, armor: d.ehp.armor, hull: d.ehp.hull, anchor: d.ehp.shield }),
    cap: Object.freeze({ shield: d.cap.shield, armor: d.cap.armor, hull: d.cap.hull, anchor: d.cap.shield }),
    assaultMinMs: p.assaultMinMs, assaultMaxMs: p.assaultMaxMs }) };
}

function powerTableOf(groups) {
  let t = powerTables.get(groups);
  if (!t) {
    t = buildPowerTable(groups);
    powerTables.set(groups, t);
  }
  return t;
}

function holdOf(fleets, attackerFactionId, isHostile, groups) {
  const table = powerTableOf(groups);
  let attackerShips = 0;
  let attackerDps = 0;
  let attackerStrength = 0;
  let engaged = false;
  let contested = false;
  for (const f of fleets || []) {
    if (f.state === ENGAGED) engaged = true;
    if (f.factionId !== attackerFactionId) {
      if (CONTACTABLE_STATES.includes(f.state) && isHostile(attackerFactionId, f.factionId)) contested = true;
      continue;
    }
    if (!S.SIEGE_ROLES.includes(f.fleetRole) || !S.HOLD_STATES.includes(f.state)) continue;
    for (const e of f.composition || []) {
      const g = groups[e.hullGroup];
      if (!g || !Number.isSafeInteger(e.count) || e.count <= 0) continue;
      attackerShips += e.count;
      attackerDps += e.count * (Number(g.dps) || 0) * (Number(g.applicationFactor) || 0);
    }
    attackerStrength += strengthOf(f.composition, table);
  }
  return { attackerShips, attackerDps, attackerStrength, engaged, contested };
}

function assaultMsOf(plan, phase, attackerDps) {
  const ehp = plan && plan.ehp ? plan.ehp[phase] : undefined;
  const cap = plan && plan.cap ? plan.cap[phase] : undefined;
  if (!isNum(ehp) || !isNum(cap) || !isNum(attackerDps) || attackerDps <= 0) {
    return { ok: false, reason: "INSUFFICIENT_FORCE" };
  }
  const ms = Math.ceil((MS_PER_S * ehp) / Math.min(attackerDps, cap));
  if (ms > plan.assaultMaxMs) return { ok: false, reason: "INSUFFICIENT_FORCE" };
  return { ok: true, ms: Math.max(ms, plan.assaultMinMs) };
}

function targetRank(station) {
  if (station.state === STATION_ANCHORING) return 0;
  return station.kind === KIND_NPC ? 2 : 1;
}

function gridFieldOf(fleets, attackerFactionId, isHostile, groups, gridOfFleet, gridKey) {
  const field = holdOf(fleets.filter((f) => gridOfFleet.get(f.fleetId) === gridKey), attackerFactionId, isHostile,
    groups);
  const all = holdOf(fleets, attackerFactionId, isHostile, groups);
  return { attackerShips: all.attackerShips, attackerDps: all.attackerDps, attackerStrength: all.attackerStrength,
    engaged: field.engaged, contested: field.contested };
}

function chooseOf(candidates, trigger) {
  let chosen = trigger ? candidates.find((e) => e.factionId === trigger.factionId) : undefined;
  if (!chosen) {
    chosen = candidates.slice().sort((a, b) => b.hold.attackerStrength - a.hold.attackerStrength
      || a.factionId - b.factionId)[0];
  }
  return chosen;
}

function planStart(spec) {
  const p = spec.params;
  if (spec.system.secClass === HIGHSEC && p.allowHighsec !== true) return { start: null, reason: "HIGHSEC" };
  const fleets = spec.fleets || [];
  const G = spec.grid && spec.grid.gridOfFleet instanceof Map && spec.grid.targetGridOf instanceof Map ? spec.grid
    : null;
  const systemEngaged = fleets.some((f) => f.state === ENGAGED);
  if (!G && systemEngaged) return { start: null, reason: "ENGAGED" };
  const besieged = new Set((spec.openSieges || []).map((s) => s.stationId));
  const busyAttackers = new Set((spec.openSieges || []).map((s) => s.attackerFactionId));
  const lastOf = spec.lastSieges instanceof Map ? spec.lastSieges : new Map();
  const sackCooling = (stationId) => {
    const last = lastOf.get(stationId);
    return Boolean(last && last.state === S.SACKED && isNum(last.endedAt) && isNum(p.sackCooldownMs)
      && spec.at < last.endedAt + p.sackCooldownMs);
  };
  const pairOf = spec.lastByPair instanceof Map ? spec.lastByPair : null;
  const repelOn = pairOf !== null && isNum(p.repelCooldownMs) && p.repelCooldownMs > 0;
  const repelCooling = (stationId, f) => {
    if (!repelOn) return false;
    const m = pairOf.get(stationId);
    const last = m instanceof Map ? m.get(f) : undefined;
    return Boolean(last && last.state === S.REPELLED && isNum(last.endedAt)
      && spec.at < last.endedAt + p.repelCooldownMs);
  };
  const targets = (spec.stations || []).filter((st) => (st.state === STATION_ONLINE || st.state === STATION_ANCHORING)
    && !besieged.has(st.stationId))
    .sort((a, b) => targetRank(a) - targetRank(b) || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1
      : 0));
  if (typeof spec.isCoreStation === "function") {
    const coreStations = targets.filter((st) => spec.isCoreStation(st.stationId));
    if (coreStations.length > 0 && targets.length === coreStations.length) {
      return { start: null, reason: "CORE_PROTECTED" };
    }
    for (const st of coreStations) {
      const idx = targets.indexOf(st);
      if (idx >= 0) targets.splice(idx, 1);
    }
  }
  const trigger = spec.triggerFleetId ? fleets.find((f) => f.fleetId === spec.triggerFleetId) : null;
  const factions = [...new Set(fleets.filter((f) => S.SIEGE_ROLES.includes(f.fleetRole)
    && S.HOLD_STATES.includes(f.state)).map((f) => f.factionId))].sort((a, b) => a - b);
  let best = 0;
  const note = (reason) => {
    best = Math.max(best, START_REASON_RANK.indexOf(reason));
  };
  let approach = null;
  for (const st of targets) {
    const tg = G ? G.targetGridOf.get(st.stationId) : undefined;
    const gridded = G !== null && typeof tg === "string";
    if (G && !gridded && systemEngaged) {
      note("CONTESTED");
      continue;
    }
    const owner = st.ownerFactionId;
    const built = buildPlan(st, spec.system.secClass, p);
    if (!built.ok) continue;
    const phase = st.state === STATION_ANCHORING ? "anchor" : "shield";
    const eligible = [];
    const approachable = [];
    for (const f of factions) {
      if (f === owner || !spec.isActive(f) || !spec.isHostile(f, owner)) continue;
      if (busyAttackers.has(f) || sackCooling(st.stationId)) {
        note("BUSY");
        continue;
      }
      if (repelCooling(st.stationId, f)) {
        note("REPEL_COOLDOWN");
        continue;
      }
      if (spec.openTotal >= p.maxOpenSieges || (spec.openByAttacker.get(f) || 0) >= p.maxOpenSiegesPerFaction) {
        note("LIMIT");
        continue;
      }
      const hold = gridded ? gridFieldOf(fleets, f, spec.isHostile, spec.groups, G.gridOfFleet, tg)
        : holdOf(fleets, f, spec.isHostile, spec.groups);
      if (hold.attackerShips === 0) continue;
      const blocked = gridded && (hold.engaged || hold.contested);
      if (hold.contested || spec.truncated === true || blocked) {
        note("CONTESTED");
        if (blocked && spec.truncated !== true && approach === null
          && START_PHASES[phase].every((ph) => assaultMsOf(built.plan, ph, hold.attackerDps).ok)) {
          approachable.push({ factionId: f, hold });
        }
        continue;
      }
      const phases = START_PHASES[phase].map((ph) => assaultMsOf(built.plan, ph, hold.attackerDps));
      if (!phases.every((r) => r.ok)) {
        note("INSUFFICIENT_FORCE");
        continue;
      }
      eligible.push({ factionId: f, hold, ms: phases[0].ms });
    }
    if (eligible.length === 0) {
      if (approach === null && approachable.length > 0) {
        approach = { stationId: st.stationId, attackerFactionId: chooseOf(approachable, trigger).factionId };
      }
      continue;
    }
    const chosen = chooseOf(eligible, trigger);
    return { start: { stationId: st.stationId, attackerFactionId: chosen.factionId,
      state: phase === "anchor" ? S.ANCHOR_ASSAULT : S.SHIELD_ASSAULT, phaseEndsAt: spec.at + chosen.ms,
      plan: built.plan, attackerShips: chosen.hold.attackerShips,
      attackerStrength: chosen.hold.attackerStrength } };
  }
  if (G) return { start: null, reason: START_REASON_RANK[best], approach };
  return { start: null, reason: START_REASON_RANK[best] };
}

function decideEnd(station, opts) {
  const o = opts || {};
  if (station.state === STATION_ANCHORING) return S.DESTROYED;
  const capture = o.canOccupy === true && o.captureLimitsOk !== false;
  if (station.kind === KIND_NPC) return capture ? S.CAPTURED : S.SACKED;
  return capture && o.captureUpwell === true ? S.CAPTURED : S.DESTROYED;
}

function decideStep(siege, station, hold, facts) {
  if (!siege || siege.open !== true || siege.phaseSeq !== facts.phaseSeq || siege.waitRound !== facts.round) {
    return { action: "STALE" };
  }
  const reinforced = station && (station.state === STATION_ARMOR || station.state === STATION_HULL);
  const backTo = reinforced ? STATION_ONLINE : null;
  if (!station || station.state === STATION_DESTROYED) return { action: "ABORT", reason: "STATION_GONE", stationTo: null };
  if (station.ownerFactionId !== siege.ownerFactionId) {
    return { action: "ABORT", reason: "OWNER_CHANGED", stationTo: backTo };
  }
  if (station.state !== stationStateFor(siege.state)) {
    return { action: "ABORT", reason: "STATION_STATE_CHANGED", stationTo: backTo };
  }
  if (facts.coreProtected === true) {
    return { action: "REPEL", reason: "CORE_PROTECTED", stationTo: backTo };
  }
  if (hold.engaged || hold.contested) {
    if (siege.waitRound < facts.maxWaitRounds) return { action: "WAIT", round: siege.waitRound + 1 };
    return { action: "REPEL", reason: "CONTESTED_TIMEOUT", stationTo: backTo };
  }
  if (!(hold.attackerDps > 0) || hold.attackerShips === 0) {
    if (Number.isSafeInteger(facts.gridAway) && facts.gridAway > 0 && siege.waitRound < facts.maxWaitRounds) {
      return { action: "GATHER", round: siege.waitRound + 1 };
    }
    return { action: "REPEL", reason: "ATTACKER_GONE", stationTo: backTo };
  }
  const at = facts.at;
  const plan = siege.plan;
  const assault = (phase, to) => {
    const ms = assaultMsOf(plan, phase, hold.attackerDps);
    if (!ms.ok) return { action: "REPEL", reason: "INSUFFICIENT_FORCE", stationTo: backTo };
    return { action: "ADVANCE", to, phaseEndsAt: at + ms.ms, station: null };
  };
  switch (siege.state) {
    case S.SHIELD_ASSAULT:
      return { action: "ADVANCE", to: S.ARMOR_TIMER, phaseEndsAt: at + plan.armorTimerMs,
        station: { from: STATION_ONLINE, to: STATION_ARMOR, stateUntilAt: at + plan.armorTimerMs } };
    case S.ARMOR_TIMER:
      return assault("armor", S.ARMOR_ASSAULT);
    case S.ARMOR_ASSAULT:
      return { action: "ADVANCE", to: S.HULL_TIMER, phaseEndsAt: at + plan.hullTimerMs,
        station: { from: STATION_ARMOR, to: STATION_HULL, stateUntilAt: at + plan.hullTimerMs } };
    case S.HULL_TIMER:
      return assault("hull", S.HULL_ASSAULT);
    case S.HULL_ASSAULT:
      return { action: "END", to: decideEnd(station, { canOccupy: facts.canCapture === true,
        captureUpwell: facts.captureUpwell === true, captureLimitsOk: true }), anchoring: false };
    case S.ANCHOR_ASSAULT:
      return { action: "END", to: S.DESTROYED, anchoring: true };
    default:
      return { action: "STALE" };
  }
}

const NATIVE_END_STATES = Object.freeze([S.HULL_ASSAULT, S.ANCHOR_ASSAULT]);

function decideNative(siege, station, facts) {
  if (station.ownerFactionId !== siege.ownerFactionId) return "OWNER_CHANGED";
  if (!NATIVE_END_STATES.includes(siege.state)) return "NOT_ASSAULT";
  if (station.state !== stationStateFor(siege.state)) return "STATION_STATE_CHANGED";
  if (facts.coreProtected === true) return "CORE_PROTECTED";
  if (!(facts.destroyedAt >= siege.phaseStartedAt)) return "STALE_DESTRUCTION";
  return null;
}

function listSiegeEdges() {
  const out = [];
  for (const [from, list] of Object.entries(SIEGE_TRANSITIONS)) for (const to of list) out.push([from, to]);
  return out;
}

module.exports = { SIEGE_TRANSITIONS, START_REASON_RANK, canTransitionSiege, stationStateFor, familyOf, buildPlan,
  holdOf, assaultMsOf, planStart, decideStep, decideNative, decideEnd, listSiegeEdges };
