"use strict";

function pinDurationMs(hunterFleet, targetFleet, cfg) {
  const hunterGroups = hunterFleet.strengthGroups;
  const targetGroups = targetFleet.strengthGroups;

  let tackle = 0;
  let vH = 0;
  for (const entry of hunterFleet.composition || []) {
    const g = hunterGroups[entry.hullGroup];
    if (!g) continue;
    const tf = g.tackleFactor || 0;
    if (tf > 0) {
      tackle += entry.count * tf;
      if (g.speedClass > vH) vH = g.speedClass;
    }
  }

  let ships = 0;
  let vT = 5;
  for (const entry of targetFleet.composition || []) {
    const g = targetGroups[entry.hullGroup];
    if (!g) continue;
    ships += entry.count;
    if (g.speedClass < vT) vT = g.speedClass;
  }

  if (ships <= 0 || tackle <= 0 || vH === 0) {
    return { ok: false, reason: "NO_TACKLE", pinMs: 0, tackle, coverPermille: 0, speedPermille: 0, vH, vT, k: 0 };
  }

  const coverPermille = Math.min(1000, Math.floor((tackle * 1000) / ships));

  const k = Math.max(0, vT - vH);

  const denom = 1000 + k * cfg.speedPenaltyPermille;
  const speedPermille = Math.floor(1000000 / denom);

  const step1 = Math.floor((cfg.pinBaseMs * coverPermille) / 1000);
  const step2 = Math.floor((step1 * speedPermille) / 1000);
  const pinMs = Math.min(cfg.pinMaxMs, step2);

  if (pinMs < cfg.pinMinMs) {
    return { ok: false, reason: "NO_TACKLE", pinMs, tackle, coverPermille, speedPermille, vH, vT, k };
  }

  return { ok: true, pinMs, tackle, coverPermille, speedPermille, vH, vT, k };
}

function planPin(args) {
  const { hunterFleetId, targetFleetId, systemId, hunterFactionId, targetFactionId, at, pinMs, pinId, idempotencyKey } = args;
  const pinnedAt = at;
  const untilAt = pinnedAt + pinMs;
  if (pinMs <= 0) {
    return { ok: false, reason: "INVALID_PIN_MS", pinMs };
  }
  return {
    ok: true,
    pinId,
    idempotencyKey,
    hunterFleetId,
    targetFleetId,
    systemId,
    hunterFactionId,
    targetFactionId,
    pinnedAt,
    untilAt,
    pinMs,
    state: "ACTIVE",
  };
}

function etaOf(cand, cfg) {
  if (cand.etaMs !== undefined) return cand.etaMs;
  if (typeof cfg.jumpMsForComposition !== "function") return null;
  const timeFactor = Number.isFinite(cfg.travelTimeFactor) && cfg.travelTimeFactor > 0 ? cfg.travelTimeFactor : 1;
  const base = cfg.jumpMsForComposition(cand.composition, { timeFactor });
  if (!base || base.ok !== true || !Number.isSafeInteger(base.baseJumpMs)) return null;
  return cand.jumps * base.baseJumpMs;
}

function pickStrike(args) {
  const { candidateFleets, targetSystemId, targetStrength, hunterStrength, pinMs, cfg } = args;

  if (!candidateFleets || candidateFleets.length === 0) {
    return { ok: false, reason: "NO_CANDIDATES" };
  }

  const requiredStrength = Math.max(1, Math.ceil(targetStrength * cfg.attackStrengthRatio) - hunterStrength);

  let best = null;
  for (const cand of candidateFleets) {
    if (cand.jumps > cfg.strikeMaxJumps) continue;
    if (!cfg.strikeRoles.includes(cand.fleetRole)) continue;
    if (cand.refitPending === true) continue;
    const etaMs = etaOf(cand, cfg);
    if (!Number.isSafeInteger(etaMs) || etaMs < 1) continue;

    const candStrength = typeof cfg.strengthOf === "function"
      ? cfg.strengthOf(cand.composition, cand.strengthGroups)
      : cand.shipCount;

    if (candStrength >= requiredStrength && etaMs + cfg.pinGraceMs <= pinMs) {
      best = { fleetId: cand.fleetId, jumps: cand.jumps, etaMs, strength: candStrength };
      break;
    }
  }

  if (!best) {
    return { ok: false, reason: "NO_SUITABLE_STRIKE" };
  }

  return { ok: true, ...best };
}

const IN_FLIGHT = Object.freeze(["TRAVELLING", "RETREATING"]);
const STRIKE_NOT_ARRIVED = Object.freeze(["TRAVELLING", "RETREATING", "PLANNED"]);
const byId = (a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0);

function decideScan(input) {
  const P = input.params;
  if (input.truncated === true) return { pin: null, reason: "SCAN_TRUNCATED" };
  const hunters = [...(input.hunters || [])].sort(byId).slice(0, Math.max(0, P.maxHuntersPerScan));
  let reason = "NO_HUNTER";
  for (const hunter of hunters) {
    if (!hunter || hunter.fleetRole !== "hunter" || hunter.currentSystemId !== input.systemId
      || !P.holdStates.includes(hunter.state)) continue;
    if (input.pinnedHunters.has(hunter.fleetId)) {
      reason = "ALREADY_PINNING";
      continue;
    }
    const target = (input.fleets || []).filter((f) => f.fleetId !== hunter.fleetId && P.targetRoles.includes(f.fleetRole)
      && !input.pinnedTargets.has(f.fleetId) && input.isHostile(hunter.factionId, f.factionId) === true).sort(byId)[0];
    if (!target) {
      reason = "NO_TARGET";
      continue;
    }
    const calc = pinDurationMs({ composition: hunter.composition, strengthGroups: input.groups },
      { composition: target.composition, strengthGroups: input.groups }, P);
    if (!calc.ok) {
      reason = "NO_TACKLE";
      continue;
    }
    if (input.activeTotal >= P.maxActivePins
      || (input.activeByFaction.get(hunter.factionId) || 0) >= P.maxActivePinsPerFaction) {
      reason = "LIMIT_EXCEEDED";
      continue;
    }
    const targetStrength = (input.fleets || []).filter((f) => f.factionId === target.factionId)
      .reduce((n, f) => n + input.strengthOf(f.composition), 0);
    const hunterStrength = input.strengthOf(hunter.composition);
    const candidates = (input.candidates.get(hunter.factionId) || []).filter((c) => c.fleet.state === "IDLE"
      && c.fleet.operationId === null && c.fleet.refitPending === false && c.jumps >= 1
      && c.fleet.fleetId !== hunter.fleetId && Number.isSafeInteger(c.etaEstimateMs))
      .sort((a, b) => a.jumps - b.jumps || byId(a.fleet, b.fleet));
    const picked = pickStrike({ candidateFleets: candidates.map((c) => ({ fleetId: c.fleet.fleetId,
      fleetRole: c.fleet.fleetRole, refitPending: c.fleet.refitPending, jumps: c.jumps,
      composition: c.fleet.composition, etaMs: c.etaEstimateMs })), targetStrength, hunterStrength, pinMs: calc.pinMs,
    cfg: { strikeRoles: P.strikeRoles, strikeMaxJumps: P.strikeMaxJumps, pinGraceMs: P.pinGraceMs,
      attackStrengthRatio: P.attackStrengthRatio, strengthOf: (composition) => input.strengthOf(composition) } });
    if (!picked.ok) {
      reason = "NO_STRIKE";
      continue;
    }
    const until = input.cooldowns.get(input.pairKeyOf(hunter.factionId, target.factionId));
    if (until !== undefined && until > input.at + picked.etaMs) {
      reason = "ON_COOLDOWN";
      continue;
    }
    const strike = candidates.find((c) => c.fleet.fleetId === picked.fleetId);
    return { reason: "PIN", pin: { hunter, target, strike: { fleetId: strike.fleet.fleetId,
      version: strike.fleet.version, systemId: strike.fleet.currentSystemId, jumps: picked.jumps,
      etaEstimateMs: picked.etaMs, strength: picked.strength }, pinMs: calc.pinMs,
    requiredStrength: Math.max(1, Math.ceil(targetStrength * P.attackStrengthRatio) - hunterStrength),
    calc: { tackle: calc.tackle, coverPermille: calc.coverPermille, speedPermille: calc.speedPermille } } };
  }
  return { pin: null, reason };
}

function decideExpire(input) {
  const { pin, hunter, target, strike } = input;
  if (!pin) return { outcome: "PIN_GONE", close: false };
  if (pin.state !== "ACTIVE") return { outcome: "ALREADY_CLOSED", close: false };
  const legSeq = pin.detail && Number.isSafeInteger(pin.detail.strikeLegSeq) ? pin.detail.strikeLegSeq : null;
  if (strike && strike.currentSystemId === pin.systemId
    && ((legSeq !== null && strike.legSeq > legSeq) || !STRIKE_NOT_ARRIVED.includes(strike.state))) {
    return { outcome: "STRUCK", close: true };
  }
  if (!target || target.state === "DESTROYED") return { outcome: "CANCELLED", close: true };
  if (!hunter || hunter.state === "DESTROYED" || IN_FLIGHT.includes(hunter.state)
    || hunter.currentSystemId !== pin.systemId) {
    return { outcome: "BROKEN", close: true };
  }
  return { outcome: "ESCAPED", close: true };
}

module.exports = {
  pinDurationMs,
  planPin,
  pickStrike,
  decideScan,
  decideExpire,
};