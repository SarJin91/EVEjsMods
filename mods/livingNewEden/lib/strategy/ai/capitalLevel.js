"use strict";

const { escalationLevelOf } = require("./escalation");
const { strengthOf } = require("./strength");
const { isFresh, ttlOf } = require("./targeting");
const { gateOn, lossesOf } = require("./attackLossGate");

const READY = "ready";
const HOME_CATEGORY = "home";
const MAX_LEVEL = 3;

const ZERO = () => ({ level: 0, seen: 0 });
const pos = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const nonNegInt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

function seenOf(snapshot, params, systemId) {
  let seen = 0;
  for (const i of Array.isArray(snapshot.intel) ? snapshot.intel : []) {
    if (i && i.systemId === systemId && isFresh(i, snapshot.at, ttlOf(i, params))) {
      seen = Math.max(seen, pos(i.hostileStrength));
    }
  }
  const th = snapshot.threats;
  if (th && th.mode === READY && Array.isArray(th.items)) {
    for (const t of th.items) if (t && t.systemId === systemId) seen = Math.max(seen, pos(t.occupierStrength));
  }
  const ir = snapshot.intruders;
  if (ir && ir.mode === READY && Array.isArray(ir.items)) {
    for (const x of ir.items) if (x && x.systemId === systemId) seen = Math.max(seen, pos(x.hostileStrength));
  }
  return seen;
}

function playerHotOf(snapshot, params, systemId) {
  const pa = params.playerActivity;
  if (!pa || !Array.isArray(snapshot.playerActivity)) return false;
  return snapshot.playerActivity.some((x) => x && x.systemId === systemId && x.kills >= pa.hotMinKills);
}

function postLevelOf(snapshot, params, systemId, template) {
  try {
    const E = params && params.escalation;
    const C = params && params.capitalLevel;
    if (!E || !C || !snapshot || typeof snapshot !== "object") return ZERO();
    const seen = seenOf(snapshot, params, systemId);
    const home = Boolean(snapshot.faction) && snapshot.faction.homeSystemId === systemId;
    const ratio = pos(params.attackStrengthRatio);
    const base = escalationLevelOf({ required: seen > 0 ? Math.ceil(seen * ratio) : 0,
      baseStrength: strengthOf(Array.isArray(template) ? template : [], params.powerTable || {}),
      category: home ? HOME_CATEGORY : null, hostileStations: 0,
      playerSystem: playerHotOf(snapshot, params, systemId),
      losses: gateOn(snapshot, params) ? lossesOf(snapshot, systemId) : 0 }, E).level;
    const level = Math.min(nonNegInt(E.maxLevel), MAX_LEVEL, base + (home ? nonNegInt(C.homeBonus) : 0));
    return { level, seen };
  } catch (_err) {
    return ZERO();
  }
}

function huntLevelOf(snapshot, params, systemIds, template) {
  if (!params || !params.escalation || !params.capitalLevel || !Array.isArray(systemIds)) return { level: 0 };
  const home = snapshot && snapshot.faction ? snapshot.faction.homeSystemId : null;
  let level = 0;
  for (const id of systemIds) {
    const r = postLevelOf(snapshot, params, id, template);
    if (r.seen > 0 || id === home) level = Math.max(level, r.level);
  }
  const cap = params.capitalLevel.huntMaxLevel;
  return { level: Number.isSafeInteger(cap) && cap >= 0 ? Math.min(level, cap) : level };
}

module.exports = { postLevelOf, huntLevelOf };
