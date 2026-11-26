"use strict";

const S = require("./schema");
const { holdOf } = require("../siege/siegeMachine");
const { SIEGE_ROLES, HOLD_STATES } = require("../siege/schema");
const { gridHoldOf } = require("../siege/gridScope");

const MS_PER_S = 1000;
const ENGAGED = "ENGAGED";
const NULLSEC = "nullsec";
const HOSTILE = "hostile";
const LAYERS = Object.freeze(["shield", "armor", "hull"]);

const PLAYER_SIEGE_TRANSITIONS = Object.freeze({
  SHIELD_ASSAULT: Object.freeze([S.ARMOR_TIMER, S.ARMOR_ASSAULT, S.REPELLED, S.HALTED, S.ABORTED]),
  ARMOR_TIMER: Object.freeze([S.ARMOR_ASSAULT, S.REPELLED, S.HALTED, S.ABORTED]),
  ARMOR_ASSAULT: Object.freeze([S.HULL_TIMER, S.HULL_ASSAULT, S.REPELLED, S.HALTED, S.ABORTED]),
  HULL_TIMER: Object.freeze([S.HULL_ASSAULT, S.REPELLED, S.HALTED, S.ABORTED]),
  HULL_ASSAULT: Object.freeze([S.DESTROYED, S.REPELLED, S.HALTED, S.ABORTED]),
  DESTROYED: Object.freeze([]),
  REPELLED: Object.freeze([]),
  HALTED: Object.freeze([]),
  ABORTED: Object.freeze([]),
});

const START_REASON_RANK = Object.freeze(["NO_TARGET", "NOT_HOSTILE", "COOLDOWN", "BUSY", "LIMIT", "CONTESTED",
  "INSUFFICIENT_FORCE"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function canTransition(from, to) {
  if (!S.STATES.includes(from) || !S.STATES.includes(to)) return { ok: false, reason: "UNKNOWN_STATE", from, to };
  if (!PLAYER_SIEGE_TRANSITIONS[from].includes(to)) return { ok: false, reason: "TRANSITION_NOT_ALLOWED", from, to };
  return { ok: true };
}

function listEdges() {
  const out = [];
  for (const [from, list] of Object.entries(PLAYER_SIEGE_TRANSITIONS)) for (const to of list) out.push([from, to]);
  return out;
}

function assaultMsOf(ehp, damageLimit, dps, params) {
  const p = params || {};
  if (!isNum(ehp) || ehp < 0 || !isNum(dps) || dps <= 0 || !isTime(p.assaultMinMs) || !isTime(p.assaultMaxMs)) {
    return { ok: false, reason: "INSUFFICIENT_FORCE" };
  }
  const effective = Math.min(dps, isNum(damageLimit) && damageLimit > 0 ? damageLimit : dps);
  const ms = Math.ceil((MS_PER_S * ehp) / effective);
  if (ms > p.assaultMaxMs) return { ok: false, reason: "INSUFFICIENT_FORCE" };
  return { ok: true, ms: Math.max(ms, p.assaultMinMs) };
}

function targetOf(view, params) {
  return Boolean(view && view.state === S.V.SHIELD_VULNERABLE && view.destroyedAt === null
    && params.targetFamilies.includes(view.family) && view.assetSafety === true && view.virtualOwner !== true
    && view.tagged !== true);
}

function siegeFactionsOf(fleets) {
  return [...new Set((fleets || []).filter((f) => SIEGE_ROLES.includes(f.fleetRole) && HOLD_STATES.includes(f.state))
    .map((f) => f.factionId))].sort((a, b) => a - b);
}

function planPlayerStart(spec) {
  const p = spec.params;
  if (!spec.system || spec.system.secClass !== NULLSEC) return { start: null, reason: "NOT_NULLSEC" };
  const fleets = spec.fleets || [];
  const G = spec.grid && spec.grid.gridOfFleet instanceof Map && spec.grid.targetGridOf instanceof Map ? spec.grid
    : null;
  const systemEngaged = fleets.some((f) => f.state === ENGAGED);
  if (!G && systemEngaged) return { start: null, reason: "ENGAGED" };
  const targets = (spec.structures || []).filter((v) => targetOf(v, p))
    .sort((a, b) => a.structureId - b.structureId);
  const factions = siegeFactionsOf(fleets);
  const trigger = spec.triggerFleetId ? fleets.find((f) => f.fleetId === spec.triggerFleetId) : null;
  let best = 0;
  const note = (reason) => {
    best = Math.max(best, START_REASON_RANK.indexOf(reason));
  };
  const choose = (list) => {
    let c = trigger ? list.find((e) => e.factionId === trigger.factionId) : undefined;
    if (!c) {
      c = list.slice().sort((a, b) => b.hold.attackerStrength - a.hold.attackerStrength
        || a.factionId - b.factionId)[0];
    }
    return c;
  };
  let approach = null;
  for (const st of targets) {
    const tg = G ? G.targetGridOf.get(st.structureId) : undefined;
    const gridded = G !== null && typeof tg === "string";
    if (G && !gridded && systemEngaged) {
      note("CONTESTED");
      continue;
    }
    if (spec.openStructureIds.has(st.structureId)) {
      note("BUSY");
      continue;
    }
    const last = spec.lastByStructure.get(st.structureId);
    if (last && last.open === true) {
      note("BUSY");
      continue;
    }
    if (last && isTime(last.endedAt) && last.endedAt + p.structureCooldownMs > spec.at) {
      note("COOLDOWN");
      continue;
    }
    if ((spec.openByOwner.get(st.ownerCorpId) || 0) >= p.maxOpenPerOwner) {
      note("LIMIT");
      continue;
    }
    const eligible = [];
    const approachable = [];
    for (const f of factions) {
      if (!spec.isActive(f)) continue;
      if (spec.relation(f, st) !== HOSTILE) {
        note("NOT_HOSTILE");
        continue;
      }
      if (spec.openTotal >= p.maxOpen || (spec.openByFaction.get(f) || 0) >= p.maxOpenPerFaction) {
        note("LIMIT");
        continue;
      }
      const hold = gridded ? gridHoldOf(fleets, f, spec.isHostileFaction, spec.groups, G.gridOfFleet, tg,
        { attackersAnywhere: true }) : holdOf(fleets, f, spec.isHostileFaction, spec.groups);
      if (hold.attackerShips === 0) continue;
      const blocked = gridded && (hold.engaged || hold.contested);
      if (hold.contested || spec.truncated === true || blocked) {
        note("CONTESTED");
        if (blocked && spec.truncated !== true && approach === null
          && LAYERS.every((l) => assaultMsOf(st.ehp[l], st.damageLimit[l], hold.attackerDps, p).ok)) {
          approachable.push({ factionId: f, hold });
        }
        continue;
      }
      const phases = LAYERS.map((l) => assaultMsOf(st.ehp[l], st.damageLimit[l], hold.attackerDps, p));
      if (!phases.every((r) => r.ok)) {
        note("INSUFFICIENT_FORCE");
        continue;
      }
      eligible.push({ factionId: f, hold, ms: phases[0].ms });
    }
    if (eligible.length === 0) {
      if (approach === null && approachable.length > 0) {
        approach = { structureId: st.structureId, attackerFactionId: choose(approachable).factionId };
      }
      continue;
    }
    const chosen = choose(eligible);
    return { start: { structureId: st.structureId, attackerFactionId: chosen.factionId,
      phaseEndsAt: spec.at + chosen.ms, attackerShips: chosen.hold.attackerShips,
      attackerStrength: Math.max(0, Math.round(chosen.hold.attackerStrength)) } };
  }
  if (G) return { start: null, reason: START_REASON_RANK[best], approach };
  return { start: null, reason: START_REASON_RANK[best] };
}

const end = (to, reason) => ({ action: "END", to, reason });

function decidePlayerStep(siege, view, hold, facts) {
  if (!siege || siege.open !== true || siege.phaseSeq !== facts.phaseSeq || siege.waitRound !== facts.round) {
    return { action: "STALE" };
  }
  const at = facts.at;
  if (!view) return end(S.ABORTED, "STRUCTURE_GONE");
  if (view.destroyedAt !== null && view.destroyedAt !== undefined) {
    if (siege.state === S.HULL_ASSAULT && view.destroyedAt >= siege.phaseStartedAt) {
      return end(S.DESTROYED, "DESTROYED");
    }
    return end(S.ABORTED, "STRUCTURE_GONE");
  }
  if (view.ownerCorpId !== siege.ownerCorpId || facts.virtualOwner === true) return end(S.ABORTED, "OWNER_CHANGED");
  const round = siege.waitRound;
  if (hold.engaged || hold.contested) {
    if (round < facts.maxWaitRounds) {
      return { action: "WAIT", round: round + 1, dueAt: at + facts.recheckMs, why: "CONTESTED" };
    }
    return end(S.REPELLED, "CONTESTED_TIMEOUT");
  }
  if (hold.attackerShips === 0) {
    if (Number.isSafeInteger(facts.gridAway) && facts.gridAway > 0 && round < facts.maxWaitRounds) {
      return { action: "WAIT", round: round + 1, dueAt: at + facts.recheckMs, why: "GATHER" };
    }
    return end(S.REPELLED, "ATTACKER_GONE");
  }

  const V = view.state;
  const endsAt = isTime(view.stateEndsAt) ? view.stateEndsAt : null;
  const advance = (to, phaseEndsAt) => ({ action: "ADVANCE", to, phaseEndsAt: Math.max(at, phaseEndsAt),
    vendorState: V, vendorEndsAt: endsAt });
  const assault = (layer, to) => {
    const a = assaultMsOf(view.ehp[layer], view.damageLimit[layer], hold.attackerDps, facts);
    if (!a.ok) return end(S.REPELLED, "INSUFFICIENT_FORCE");
    const due = endsAt === null ? at + a.ms : Math.min(at + a.ms, endsAt - facts.hitMarginMs);
    return advance(to, due);
  };
  const timer = (to) => advance(to, (endsAt === null ? at : endsAt) + facts.timerExitDelayMs);
  const timerWait = () => {
    if (endsAt !== null && at < endsAt) {
      return { action: "WAIT", round: round + 1, dueAt: endsAt + facts.timerExitDelayMs, why: "TIMER" };
    }
    if (round < facts.maxLagRounds) {
      return { action: "WAIT", round: round + 1, dueAt: at + facts.lagRecheckMs, why: "LAG" };
    }
    return end(S.ABORTED, "VENDOR_STUCK");
  };
  const finalGate = () => {
    if (facts.destroyEnabled !== true) return end(S.HALTED, "FINAL_DISABLED");
    if (view.assetSafety !== true) return end(S.HALTED, "NO_ASSET_SAFETY");
    if (facts.ownerActive === null || facts.ownerActive === undefined) return { action: "NEED_OWNER" };
    if (facts.ownerActive !== true) {
      return end(S.HALTED, facts.ownerUnknown === true ? "OWNER_UNKNOWN" : "OWNER_OFFLINE");
    }
    return assault("hull", S.HULL_ASSAULT);
  };
  const due = at >= siege.phaseEndsAt;
  const repaired = () => end(S.REPELLED, "REPAIRED");

  switch (siege.state) {
    case S.SHIELD_ASSAULT:
      if (V === S.V.SHIELD_VULNERABLE) return due ? { action: "HIT", layer: "shield" } : { action: "STALE" };
      if (V === S.V.ARMOR_REINFORCE) return timer(S.ARMOR_TIMER);
      if (V === S.V.ARMOR_VULNERABLE) return assault("armor", S.ARMOR_ASSAULT);
      break;
    case S.ARMOR_TIMER:
      if (V === S.V.ARMOR_REINFORCE) return timerWait();
      if (V === S.V.ARMOR_VULNERABLE) return assault("armor", S.ARMOR_ASSAULT);
      if (V === S.V.SHIELD_VULNERABLE) return repaired();
      break;
    case S.ARMOR_ASSAULT:
      if (V === S.V.ARMOR_VULNERABLE) return due ? { action: "HIT", layer: "armor" } : { action: "STALE" };
      if (V === S.V.HULL_REINFORCE) return timer(S.HULL_TIMER);
      if (V === S.V.HULL_VULNERABLE) return finalGate();
      if (V === S.V.SHIELD_VULNERABLE) return repaired();
      break;
    case S.HULL_TIMER:
      if (V === S.V.HULL_REINFORCE) return timerWait();
      if (V === S.V.HULL_VULNERABLE) return finalGate();
      if (V === S.V.SHIELD_VULNERABLE) return repaired();
      break;
    case S.HULL_ASSAULT:
      if (V === S.V.HULL_VULNERABLE) {
        if (!due) return { action: "STALE" };
        return view.assetSafety === true ? { action: "HIT", layer: "hull" } : end(S.HALTED, "NO_ASSET_SAFETY");
      }
      if (V === S.V.SHIELD_VULNERABLE) return repaired();
      break;
    default:
      return { action: "STALE" };
  }
  return end(S.ABORTED, "STATE_CHANGED");
}

module.exports = { PLAYER_SIEGE_TRANSITIONS, START_REASON_RANK, canTransition, listEdges, assaultMsOf, targetOf,
  siegeFactionsOf, planPlayerStart, decidePlayerStep };
