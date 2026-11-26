"use strict";

const { createRng, deriveSeed } = require("../../util/rng");
const { ARCHETYPE, INTENT, STATE } = require("../schema");
const { dwellMs, dockedDwell, pickWeighted, poolOf, safePoolOf, careerHulls } = require("../rules");
const { CAREER, CAREER_NAMES, INT32_MAX, identityKey } = require("./schema");
const { bandHomeOf } = require("./rules");

const ACTIVITY_INTENTS = Object.freeze([INTENT.MINE, INTENT.RAT, INTENT.EXPLORE]);
const nonNegative = (v) => (v > 0 ? v : 0);
const validCareer = (c) => c >= 1 && c <= CAREER_NAMES.length;

function seedCareerOf(p, C, worldSeed, homeBandIdx) {
  const rng = createRng(deriveSeed(worldSeed, "pop-career-seed", identityKey(p.pilotId, p.gen)));
  const k = pickWeighted(C.seedCareerPermille, rng);
  let career = k >= 0 ? k + 1 : CAREER.ROOKIE;
  if (homeBandIdx >= 0 && homeBandIdx < C.minCareerByBand.length) {
    career = Math.max(career, C.minCareerByBand[homeBandIdx]);
  }
  return { career, xp: Math.max(nonNegative(p.xp), C.xpByCareer[career - 1]) };
}

function accrue(p, next, C, bandIdx, jumped) {
  let xp = nonNegative(p.xp);
  let wealth = nonNegative(p.wealth);
  let event = null;
  if (next.state === STATE.POD) {
    wealth = Math.max(0, wealth - C.lossOnPod * (validCareer(p.career) ? p.career : 0));
    event = "POD";
  } else if (p.state === STATE.ACTIVE && ACTIVITY_INTENTS.includes(p.intent)) {
    xp += 1;
    wealth += C.earnByBand[bandIdx >= 0 && bandIdx < C.earnByBand.length ? bandIdx : 0];
    event = "ACTIVITY";
  } else if ((p.archetype === ARCHETYPE.TRADER || p.archetype === ARCHETYPE.COMMUTER) && p.state === STATE.TRAVEL
    && next.state === STATE.DOCKED && jumped === true) {
    xp += 1;
    wealth += C.tradeEarn;
    event = "TRADE";
  }
  return { xp: Math.min(xp, INT32_MAX), wealth: Math.min(wealth, C.wealthMax), event };
}

function promotionOf(p, C) {
  const c = p.career;
  if (!(c >= 1 && c < CAREER_NAMES.length)) return 0;
  return p.xp >= C.xpByCareer[c] && p.wealth >= C.costByCareer[c] ? c + 1 : 0;
}

function promote(p, to, C, S, table, worldSeed, now) {
  const rng = createRng(deriveSeed(worldSeed, "pop-career", p.pilotId, p.seq));
  let homeId = 0;
  if (to === CAREER.SEASONED && rng.nextFloat() * 1000 < C.moveHomePermille) homeId = bandHomeOf(S, table, rng);
  const moved = homeId > 0 && homeId !== p.homeId;
  const next = { career: to, xp: Math.min(nonNegative(p.xp), INT32_MAX),
    wealth: Math.max(0, nonNegative(p.wealth) - C.costByCareer[to - 1]),
    intent: INTENT.DOCK, state: STATE.DOCKED, destId: 0, dueAt: now + dockedDwell(S, dwellMs(S, rng)),
    ...(moved ? { homeId, systemId: homeId, prevId: 0 } : {}) };
  if (moved) {
    const shipTypeId = movedHullOf(p, to, S, table.bandOf(homeId));
    if (shipTypeId !== p.shipTypeId) next.shipTypeId = shipTypeId;
  }
  return { moved, next };
}

function movedHullOf(p, career, S, band) {
  if (safePoolOf(S, [p.shipTypeId], band).length > 0) return p.shipTypeId;
  const pool = poolOf(S, p.archetype, band);
  const safe = safePoolOf(S, careerHulls(S, pool, career), band);
  const list = safe.length > 0 ? safe : safePoolOf(S, pool, band);
  return list.length > 0 ? list[0] : p.shipTypeId;
}

module.exports = { seedCareerOf, accrue, promotionOf, promote };
