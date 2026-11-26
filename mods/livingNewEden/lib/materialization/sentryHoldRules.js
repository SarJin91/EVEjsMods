"use strict";

const { membersOf } = require("../playerHunt/huntRepository");
const { landed } = require("../fleetExposure/rules");

const ACTION = Object.freeze({ HOLD: "HOLD", EXIT: "EXIT", END: "END" });
const PERMILLE = 1000;

const isObj = (v) => v !== null && typeof v === "object";

function decideHold(facts, p) {
  if (facts.allDestroyed === true) return { action: ACTION.END, reason: "WIPED" };
  if (facts.sceneLoaded !== true || !Array.isArray(facts.alive) || facts.alive.length === 0) {
    return { action: ACTION.END, reason: "SCENE_GONE" };
  }
  if (facts.phase === "EXITING") {
    if (landed(facts.alive, facts.exitPoint)
      || (Number.isSafeInteger(facts.exitAt) && facts.now - facts.exitAt >= p.exitWarpMaxMs)) {
      return { action: ACTION.END, reason: "RETREAT" };
    }
    return { action: ACTION.HOLD };
  }
  if (facts.lostPermille >= p.retreatLossPermille) return { action: ACTION.EXIT };
  if (facts.hostileSentryLive !== true) return { action: ACTION.END, reason: "TARGET_GONE" };
  if (facts.now - facts.lastPlayerSeenAt > p.exitGraceMs) return { action: ACTION.END, reason: "NO_PLAYER" };
  if (facts.now - facts.claimedAt >= p.maxHeldMs) return { action: ACTION.END, reason: "TIMEOUT" };
  return { action: ACTION.HOLD };
}

function lostEhpPermille(members, groups) {
  if (!Array.isArray(members) || members.length === 0) return 0;
  let total = 0;
  let lost = 0;
  for (const m of members) {
    const row = isObj(groups) && isObj(m) && Object.prototype.hasOwnProperty.call(groups, m.hullGroup)
      ? groups[m.hullGroup] : null;
    const ehp = isObj(row) && Number.isFinite(row.ehp) && row.ehp > 0 ? row.ehp : 1;
    total += ehp;
    if (isObj(m) && m.destroyed === true) lost += ehp;
  }
  return total > 0 ? Math.floor((lost * PERMILLE) / total) : 0;
}

function pickHoldMembers(fleet, maxShips) {
  if (!isObj(fleet) || !Array.isArray(fleet.composition) || !Number.isSafeInteger(maxShips) || maxShips < 1) {
    return { ok: false, reason: "NONE" };
  }
  const members = membersOf(fleet.fleetId, fleet.composition)
    .map((m) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup, typeId: m.typeId }))
    .sort((a, b) => (a.memberKey < b.memberKey ? -1 : a.memberKey > b.memberKey ? 1 : 0))
    .slice(0, maxShips);
  return members.length > 0 ? { ok: true, members } : { ok: false, reason: "NONE" };
}

function pickAnchorSentry(views, hostileIds) {
  const hostile = hostileIds instanceof Set ? hostileIds : new Set(Array.isArray(hostileIds) ? hostileIds : []);
  let best = null;
  for (const v of Array.isArray(views) ? views : []) {
    if (!isObj(v) || v.alive !== true || !Number.isSafeInteger(v.itemId) || !hostile.has(v.itemId)) continue;
    if (best === null || v.itemId < best) best = v.itemId;
  }
  return best;
}

module.exports = { decideHold, lostEhpPermille, pickHoldMembers, pickAnchorSentry, ACTION };
