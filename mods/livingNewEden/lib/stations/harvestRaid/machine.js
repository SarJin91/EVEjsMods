"use strict";

const S = require("./schema");
const { OPEN_OPERATION_STATES } = require("../../fleets/schema");

const TRANSITIONS = Object.freeze({
  [S.WARNED]: Object.freeze([S.RAIDING, S.REPELLED, S.EXPIRED, S.ABORTED]),
  [S.RAIDING]: Object.freeze([S.SETTLING, S.REPELLED, S.EXPIRED, S.ABORTED]),
  [S.SETTLING]: Object.freeze([S.SETTLED]),
  [S.SETTLED]: Object.freeze([]),
  [S.REPELLED]: Object.freeze([]),
  [S.ABORTED]: Object.freeze([]),
  [S.EXPIRED]: Object.freeze([]),
});

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function canTransition(from, to) {
  const next = Object.prototype.hasOwnProperty.call(TRANSITIONS, from) ? TRANSITIONS[from] : null;
  if (next && next.includes(to)) return { ok: true };
  return { ok: false, reason: "INVALID_TRANSITION", from, to };
}

const refuse = (reason) => ({ start: null, reason });

function planRaidStart(input) {
  const i = input || {};
  const P = i.params || {};
  if (!isTime(i.at)) return refuse("INVALID_INPUT");
  const op = i.operation;
  if (!op || op.operationType !== S.OPERATION_TYPE || !OPEN_OPERATION_STATES.includes(op.state) || !isId(op.factionId)
    || !isId(op.targetSystemId)) return refuse("NO_OPERATION");
  const t = i.target;
  const kind = t && t.kind === S.KIND_SKYHOOK ? S.KIND_SKYHOOK : S.KIND_METENOX;
  const skyhook = kind === S.KIND_SKYHOOK;
  if (!t || (!skyhook && t.typeId !== S.METENOX_TYPE_ID) || !isId(t.structureId) || !isId(t.ownerCorpId)) {
    return refuse("NO_TARGET");
  }
  if (t.systemId !== op.targetSystemId) return refuse("NO_OPERATION");
  if (!Array.isArray(i.secClasses) || !i.secClasses.includes(i.secClass)) return refuse("SEC_CLASS");
  if (t.destroyed === true) return refuse("NO_TARGET");
  if (skyhook && (t.active !== true || t.raidState !== "ready")) return refuse("NO_TARGET");
  if (t.virtualOwner !== false) return refuse("VIRTUAL_OWNER");
  if (i.hostile !== true) return refuse("NOT_HOSTILE");
  if (i.siegeOpen === true) return refuse("SIEGE_OPEN");
  if (i.openOnTarget === true) return refuse("BUSY");
  if (isTime(i.lastTargetEndedAt) && i.at - i.lastTargetEndedAt < P.targetCooldownMs) return refuse("COOLDOWN");
  if (isTime(i.lastOwnerStartedAt) && i.at - i.lastOwnerStartedAt < P.ownerCooldownMs) return refuse("OWNER_COOLDOWN");
  if (i.openTotal >= P.maxOpen || i.openByFaction >= P.maxOpenPerFaction) return refuse("LIMIT");
  if (!(i.attackerShips > 0)) return refuse("NO_HOLD");
  if (skyhook) {
    if (t.busy === true) return refuse("VENDOR_BUSY");
    const w = i.window || {};
    if (w.open !== true && w.imminent !== true) return refuse("WINDOW");
  }
  if (i.ownerOnline !== true) return refuse("OWNER_OFFLINE");
  if (skyhook) {
    if (!(i.lootUnits >= P.skyhookMinLootUnits) || !(i.lootUnits > 0)) return refuse("LOW_LOOT");
  } else if (!(i.lootVolumeM3 >= P.minLootVolumeM3) || !(i.lootVolumeM3 > 0)) return refuse("LOW_LOOT");
  return { start: Object.freeze({ raidId: S.raidIdOf(kind, t.structureId, i.at), targetKind: kind,
    targetId: t.structureId, systemId: t.systemId, ownerCorpId: t.ownerCorpId, attackerFactionId: op.factionId,
    operationId: op.operationId, at: i.at, wallDeadlineAt: i.at + P.wallDeadlineMs,
    firstStepAt: Math.min(i.at + Math.max(1, Math.min(P.sampleMs, P.warningMs)), i.at + P.wallDeadlineMs) }) };
}

function skyhookWindowOf(skyhook, at, leadMs) {
  const open = Boolean(skyhook && skyhook.windowOpen === true);
  const startMs = skyhook && skyhook.window ? skyhook.window.startMs : null;
  const imminent = !open && isTime(startMs) && startMs > at && startMs - at <= leadMs;
  return { open, imminent };
}

function nextDueOf(at, remaining, sampleMs, wallDeadlineAt) {
  const due = at + Math.max(1, Math.min(sampleMs, remaining));
  return wallDeadlineAt > at ? Math.min(due, wallDeadlineAt) : due;
}

function decideRaidStep(raid, facts) {
  if (!raid || (raid.state !== S.WARNED && raid.state !== S.RAIDING)) return { action: "STALE" };
  const f = facts || {};
  const P = f.params || {};
  const at = f.at;
  if (at >= raid.wallDeadlineAt) return { action: "END", to: S.EXPIRED, reason: "WALL_DEADLINE" };
  if (!f.target) return { action: "END", to: S.ABORTED, reason: "TARGET_GONE" };
  if (f.target.destroyed === true) return { action: "END", to: S.ABORTED, reason: "TARGET_DESTROYED" };
  if (f.target.ownerCorpId !== raid.ownerCorpId) return { action: "END", to: S.ABORTED, reason: "OWNER_CHANGED" };
  if (f.siegeOpen === true) return { action: "END", to: S.ABORTED, reason: "SIEGE_OPEN" };
  if (!(f.attackerShips > 0)) return { action: "END", to: S.REPELLED, reason: "NO_HOLD" };
  const skyhook = raid.targetKind === S.KIND_SKYHOOK;
  const w = skyhook ? f.window || {} : null;
  if (skyhook) {
    if (f.target.active === false) return { action: "END", to: S.ABORTED, reason: "TARGET_INACTIVE" };
    if (w.open !== true && w.imminent !== true) return { action: "END", to: S.EXPIRED, reason: "WINDOW_CLOSED" };
  }
  const delta = Math.max(0, Math.min(at - raid.lastSampleAt, 2 * P.sampleMs));
  const credited = f.ownerOnline === true && f.engaged !== true
    && (!skyhook || raid.state === S.WARNED || w.open === true);
  const creditedMs = raid.creditedMs + (credited ? delta : 0);
  if (raid.state === S.WARNED) {
    if (creditedMs >= P.warningMs) {
      return { action: "ADVANCE", to: S.RAIDING, creditedMs: 0, lastSampleAt: at, credited,
        dueAt: nextDueOf(at, P.raidMs, P.sampleMs, raid.wallDeadlineAt) };
    }
    return { action: "SAMPLE", creditedMs, lastSampleAt: at, credited,
      dueAt: nextDueOf(at, P.warningMs - creditedMs, P.sampleMs, raid.wallDeadlineAt) };
  }
  if (creditedMs >= P.raidMs && (!skyhook || w.open === true)) {
    return { action: "SETTLE", to: S.SETTLING, creditedMs, lastSampleAt: at, credited };
  }
  const remaining = skyhook && w.open !== true ? P.sampleMs : P.raidMs - creditedMs;
  return { action: "SAMPLE", creditedMs, lastSampleAt: at, credited,
    dueAt: nextDueOf(at, remaining, P.sampleMs, raid.wallDeadlineAt) };
}

module.exports = { TRANSITIONS, canTransition, planRaidStart, decideRaidStep, skyhookWindowOf };
