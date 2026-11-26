"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { hullsOf } = require("./data/killmailHulls");
const { ARCHETYPE_DATA } = require("./data/archetypes");

const HOUR_MS = 3600000;
const MAX_POW = 30;
const WEIGHT_MAX = 1000;
const OUTCOMES = Object.freeze(["ATTACKER_WIN", "DEFENDER_WIN"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

function securityOf(archetype) {
  const row = typeof archetype === "string" && Object.prototype.hasOwnProperty.call(ARCHETYPE_DATA, archetype)
    ? ARCHETYPE_DATA[archetype] : null;
  return row && typeof row.securityRating === "number" && Number.isFinite(row.securityRating) ? row.securityRating : 0;
}

const linked = (side) => Boolean(side && side.identity && side.identity.ok !== false
  && side.identity.state === "LINKED" && isId(side.identity.corporationId));
const pilotsOf = (side) => (Array.isArray(side.identity.characterIds) ? side.identity.characterIds.filter(isId) : []);

function planKillmail(input) {
  const sk = input && input.skirmish;
  if (!sk || typeof sk.skirmish_id !== "string" || sk.skirmish_id === "" || !isCount(sk.at) || !isId(sk.system_id)
    || !OUTCOMES.includes(sk.outcome) || !isCount(sk.attacker_crew) || !isCount(sk.defender_crew)
    || !isCount(sk.crew_lost_a) || !isCount(sk.crew_lost_d) || !Number.isSafeInteger(sk.seed) || sk.seed < 0
    || !Number.isSafeInteger(input.maxAttackers) || input.maxAttackers < 1 || typeof input.hullEhpOf !== "function") {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  if (!linked(input.attacker) || !linked(input.defender)) return { ok: false, reason: "NO_IDENTITY" };
  const aWins = sk.outcome === "ATTACKER_WIN";
  const loser = aWins ? input.defender : input.attacker;
  const winner = aWins ? input.attacker : input.defender;
  const loserKind = aWins ? sk.defender_kind : sk.attacker_kind;
  const winnerKind = aWins ? sk.attacker_kind : sk.defender_kind;
  const winnerCrew = aWins ? sk.attacker_crew : sk.defender_crew;
  const winnerLost = aWins ? sk.crew_lost_a : sk.crew_lost_d;
  const loserIds = pilotsOf(loser);
  const winnerIds = pilotsOf(winner);
  if (loserIds.length === 0 || winnerIds.length === 0) return { ok: false, reason: "NO_PILOTS" };

  const rng = createRng(deriveSeed(sk.seed, "fckm"));
  const victimId = loserIds[rng.nextInt(0, loserIds.length - 1)];
  const victimHull = rng.pick(hullsOf(loserKind));
  const alive = Math.max(1, winnerCrew - winnerLost);
  const count = Math.min(input.maxAttackers, alive, winnerIds.length);
  const pool = winnerIds.slice();
  for (let i = 0; i < count; i += 1) {
    const j = rng.nextInt(i, pool.length - 1);
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  const pilots = pool.slice(0, count);
  const winnerHulls = hullsOf(winnerKind);
  const hulls = pilots.map(() => rng.pick(winnerHulls));
  const weights = pilots.map(() => rng.nextInt(1, WEIGHT_MAX));
  let ehpRaw = null;
  try {
    ehpRaw = input.hullEhpOf(victimHull);
  } catch (_err) {
    ehpRaw = null;
  }
  const ehp = Math.max(0, Math.round(Number(ehpRaw) || 0));
  const sumW = weights.reduce((s, w) => s + w, 0);
  const damage = weights.map((w) => Math.floor(ehp * w / sumW));
  damage[0] += ehp - damage.reduce((s, d) => s + d, 0);
  const security = securityOf(winner.archetype);
  const attackers = pilots.map((characterId, i) => ({ characterId, corporationId: winner.identity.corporationId,
    shipTypeId: hulls[i], damageDone: damage[i], securityStatus: security }));
  return { ok: true, payload: { v: 1, skirmishId: sk.skirmish_id, at: sk.at, systemId: sk.system_id,
    warId: typeof sk.war_id === "string" ? sk.war_id : null,
    victim: { characterId: victimId, corporationId: loser.identity.corporationId, shipTypeId: victimHull,
      damageTaken: ehp },
    attackers } };
}

function backoffMs(attempts, S) {
  const cap = S.backoffMaxMs;
  const base = Math.min(S.backoffBaseMs, cap);
  const n = Math.max(0, Math.trunc(attempts) - 1);
  if (n >= MAX_POW) return cap;
  return Math.min(cap, base * (2 ** n));
}

function spacingMs(maxPerHour) {
  return Math.ceil(HOUR_MS / Math.max(1, maxPerHour));
}

module.exports = { planKillmail, backoffMs, spacingMs };
