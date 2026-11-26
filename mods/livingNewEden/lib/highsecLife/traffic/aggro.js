"use strict";

const REL_HOSTILE = 2;

const KEYS = Object.freeze({
  rangeMeters: "standingAggroRangeMeters",
  maxSystemsPerPass: "standingAggroMaxSystemsPerPass",
  maxAttackers: "standingAggroMaxAttackers",
  maxCandidates: "standingAggroMaxCandidates",
  holdMs: "standingAggroHoldMs",
  cooldownMs: "standingAggroCooldownMs",
});

function aggroSettingsOf(liveSettings) {
  if (!liveSettings || typeof liveSettings !== "object" || liveSettings.standingAggroEnabled !== true) return null;
  const out = {};
  for (const [field, key] of Object.entries(KEYS)) {
    const v = liveSettings[key];
    const min = field === "cooldownMs" ? 0 : 1;
    if (!Number.isSafeInteger(v) || v < min) return null;
    out[field] = v;
  }
  return Object.freeze(out);
}

function vendorRatSettingsOf(liveSettings) {
  if (!liveSettings || typeof liveSettings !== "object" || liveSettings.standingAggroEnabled !== true
    || liveSettings.vendorRatAggroEnabled !== true) return null;
  const maxPerSystemWindow = liveSettings.vendorRatAggroMaxPerSystemWindow;
  const windowMs = liveSettings.vendorRatAggroWindowMs;
  if (!Number.isSafeInteger(maxPerSystemWindow) || maxPerSystemWindow < 0
    || !Number.isSafeInteger(windowMs) || windowMs < 1) return null;
  return Object.freeze({ maxPerSystemWindow, windowMs });
}

function planAggro(input) {
  const orders = [];
  let friendlySkipped = 0;
  let hostileSeen = 0;
  const quota = input && Number.isSafeInteger(input.vendorOrdersLeft) && input.vendorOrdersLeft >= 0;
  let vendorLeft = quota ? input.vendorOrdersLeft : 0;
  let vendorQuotaSkipped = 0;
  const result = () => (quota ? { orders, friendlySkipped, hostileSeen, vendorQuotaSkipped }
    : { orders, friendlySkipped, hostileSeen });
  const threats = input && Array.isArray(input.threats) ? input.threats : [];
  const maxAttackers = input && Number.isSafeInteger(input.maxAttackers) && input.maxAttackers > 0
    ? input.maxAttackers : 0;
  if (maxAttackers === 0 || typeof input.pilotOf !== "function" || typeof input.relationOf !== "function") {
    return result();
  }
  const armed = input.armed instanceof Map ? input.armed : new Map();
  const cooldownUntil = input.cooldownUntil instanceof Map ? input.cooldownUntil : new Map();
  const used = new Set();
  for (const threat of threats) {
    const shipId = threat ? threat.pilotShipId : 0;
    if (!Number.isSafeInteger(shipId) || shipId <= 0 || armed.has(shipId)) continue;
    const until = cooldownUntil.get(shipId);
    if (until !== undefined && until > input.now) continue;
    const pilotId = input.pilotOf(shipId);
    if (!Number.isSafeInteger(pilotId)) continue;
    const attackers = (Array.isArray(threat.attackers) ? threat.attackers : [])
      .filter((a) => a && Number.isSafeInteger(a.entityId) && typeof a.kind === "string")
      .slice().sort((a, b) => a.distanceMeters - b.distanceMeters || a.entityId - b.entityId);
    const hostile = attackers.filter((a) => input.relationOf(pilotId, a.factionId) === REL_HOSTILE);
    hostileSeen += hostile.length;
    if (hostile.length === 0) {
      if (attackers.length > 0) friendlySkipped += 1;
      continue;
    }
    let free = hostile.filter((a) => !used.has(a.entityId));
    if (quota && vendorLeft === 0 && free.some((a) => a.vendor === true)) {
      vendorQuotaSkipped += 1;
      free = free.filter((a) => a.vendor !== true);
    }
    if (free.length === 0) continue;
    const kind = free[0].kind;
    const vendor = quota && free[0].vendor === true;
    const attackerIds = free.filter((a) => a.kind === kind && (a.vendor === true) === (free[0].vendor === true))
      .slice(0, maxAttackers).map((a) => a.entityId);
    for (const id of attackerIds) used.add(id);
    if (vendor) {
      vendorLeft -= 1;
      orders.push({ pilotShipId: shipId, kind, attackerIds, vendor: true });
    } else {
      orders.push({ pilotShipId: shipId, kind, attackerIds });
    }
  }
  return result();
}

module.exports = { REL_HOSTILE, aggroSettingsOf, vendorRatSettingsOf, planAggro };
