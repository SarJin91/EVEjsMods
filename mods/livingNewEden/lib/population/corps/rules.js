"use strict";

const { ARCHETYPE } = require("../schema");
const { FOCUS } = require("./schema");

const FOCUS_OF_ARCHETYPE = Object.freeze({ [ARCHETYPE.TRADER]: FOCUS.TRADE, [ARCHETYPE.MINER]: FOCUS.MINING,
  [ARCHETYPE.RATTER]: FOCUS.PVE, [ARCHETYPE.EXPLORER]: FOCUS.EXPLORE, [ARCHETYPE.COMMUTER]: FOCUS.TRADE });

function focusOf(archetype) {
  return FOCUS_OF_ARCHETYPE[archetype] || FOCUS.TRADE;
}

function accepts(corp, pilot, distance, u, S) {
  if (!pilot || pilot.corpId !== 0) return false;
  if (!(Number.isFinite(distance) && distance <= S.joinMaxDistance)) return false;
  const permille = focusOf(pilot.archetype) === corp.focus ? S.focusMatchPermille : S.otherFocusPermille;
  return u * 1000 < permille;
}

function leaveCount(members, rng, S) {
  if (!(members > 0)) return 0;
  return Math.min(members, Math.floor((members * S.leavePermille) / 1000 + rng.nextFloat()));
}

function shouldDissolve(corp, members, now, S) {
  if (members <= 0) return { dissolve: true, lowSince: corp.lowSince > 0 ? corp.lowSince : now };
  if (members >= S.membersMin) return { dissolve: false, lowSince: 0 };
  const lowSince = corp.lowSince > 0 ? corp.lowSince : now;
  return { dissolve: now - lowSince >= S.dissolveAfterMs, lowSince };
}

function shouldDissolveActive(corp, members, active, now, S) {
  if (members <= 0) return { ...shouldDissolve(corp, 0, now, S), inactive: false };
  if (active >= S.membersMin) return { dissolve: false, lowSince: 0, inactive: false };
  const lowSince = corp.lowSince > 0 ? corp.lowSince : now;
  const dissolve = now - lowSince >= S.dissolveAfterMs;
  return { dissolve, lowSince, inactive: dissolve && members >= S.membersMin };
}

module.exports = { focusOf, accepts, leaveCount, shouldDissolve, shouldDissolveActive };
