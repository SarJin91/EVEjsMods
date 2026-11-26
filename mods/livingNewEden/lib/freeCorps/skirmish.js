"use strict";

const { createRng } = require("../util/rng");
const D = require("./data/skirmish");

const PERMILLE = 1000;
const MAX_CREW = 10;

const crewOf = (n) => Math.max(1, Math.min(MAX_CREW, Number.isSafeInteger(n) ? n : 1));
const powerOf = (kind) => (Object.prototype.hasOwnProperty.call(D.POWER_PER_PILOT, kind)
  ? D.POWER_PER_PILOT[kind] : D.DEFAULT_POWER);
const defenseOf = (band) => (Object.prototype.hasOwnProperty.call(D.BAND_DEFENSE_PERMILLE, band)
  ? D.BAND_DEFENSE_PERMILLE[band] : D.DEFAULT_DEFENSE_PERMILLE);
const wholeOf = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

function resolveSkirmish(input) {
  const a = (input && input.attacker) || {};
  const d = (input && input.defender) || {};
  const crewA = crewOf(a.crew);
  const crewD = crewOf(d.crew);
  const powA = Math.max(1, Math.floor(crewA * powerOf(a.kind) * D.ATTACKER_EDGE_PERMILLE / PERMILLE));
  const powD = Math.max(1, Math.floor(crewD * powerOf(d.kind) * defenseOf(input && input.band) / PERMILLE));
  const rng = createRng(Number.isSafeInteger(input && input.seed) ? input.seed : 0);
  const r = rng.nextInt(1, powA + powD);
  const attackerWins = r <= powA;
  const loserCrew = attackerWins ? crewD : crewA;
  const winnerCrew = attackerWins ? crewA : crewD;
  const lostLoser = rng.nextInt(1, loserCrew);
  const lostWinner = rng.nextInt(0, Math.floor(winnerCrew * D.WINNER_LOSS_MAX_PERMILLE / PERMILLE));
  const crewLostA = attackerWins ? lostWinner : lostLoser;
  const crewLostD = attackerWins ? lostLoser : lostWinner;
  const perPilot = wholeOf(input && input.iskPerPilot);
  const iskLostA = crewLostA * perPilot;
  const iskLostD = crewLostD * perPilot;
  const loot = Math.min(PERMILLE, wholeOf(input && input.lootPermille));
  const lootIsk = attackerWins ? Math.floor(iskLostD * loot / PERMILLE) : 0;
  return Object.freeze({ outcome: attackerWins ? "ATTACKER_WIN" : "DEFENDER_WIN", crewLostA, crewLostD, iskLostA,
    iskLostD, lootIsk, powA, powD });
}

module.exports = { resolveSkirmish };
