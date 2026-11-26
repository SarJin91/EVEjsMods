"use strict";

const CONTEXTS = Object.freeze(["WORK_MINE", "WORK_HAUL", "WORK_RAT", "WORK_EXPLORE", "WORK_BUILD", "WORK_RUN", "HELD",
  "TRAVEL", "RETURN_FULL", "RETURN_EMPTY", "LAST_LOST", "LAST_RICH", "LAST_DONE", "IDLE_miner", "IDLE_hauler",
  "IDLE_ratter", "IDLE_explorer", "IDLE_industrialist", "IDLE_missioner", "GENERIC"]);

const PLACEHOLDERS = Object.freeze(["system", "home", "place", "corp", "ticker", "lost", "isk"]);

function lines(context, texts) {
  const prefix = `fc-${context.toLowerCase()}-`;
  return Object.freeze(texts.map((text, i) => Object.freeze({ id: `${prefix}${String(i + 1).padStart(2, "0")}`,
    text })));
}

const LINES = Object.freeze({
  WORK_MINE: lines("WORK_MINE", [
    "{corp} mining crew on the belts in {place}, rocks are good today",
    "strip miners running, hold half full",
    "anyone else mining in {system}? the belt is getting thin",
    "[{ticker}] barges cycling, quiet so far",
  ]),
  WORK_HAUL: lines("WORK_HAUL", [
    "{corp} hauler loaded in {place}, moving out soon",
    "cargo run for [{ticker}], do not shoot the Iteron",
    "hauling again, the market in {system} better be worth it",
    "full cargo, slow align, wish me luck",
  ]),
  WORK_RAT: lines("WORK_RAT", [
    "{corp} ratting in {place}, the bounties keep coming",
    "clearing belts for [{ticker}], rats are thick here",
    "anyone else ratting in {system}? the spawns are good",
    "another battleship rat down, loot drops are meh",
  ]),
  WORK_EXPLORE: lines("WORK_EXPLORE", [
    "{corp} scanning in {place}, found a relic site",
    "probes out, the sky in {system} is full of signatures",
    "hacking cans for [{ticker}], the minigame hates me",
    "data site done, on to the next one",
  ]),
  WORK_BUILD: lines("WORK_BUILD", [
    "{corp} production lines are busy in {place}",
    "building for [{ticker}], the minerals ran out again",
    "industry slots in {system} are packed today",
    "jobs running, waiting on the next batch",
  ]),
  WORK_RUN: lines("WORK_RUN", [
    "{corp} running missions out of {place}",
    "another mission for the agent, [{ticker}] standings going up",
    "mission rats in {system} are tougher than they look",
    "accepted a new mission, back to work",
  ]),
  HELD: lines("HELD", [
    "quiet in here, someone strange on the grid in {system}",
    "{corp} holding position, not moving until it is clear",
    "[{ticker}] crew, stay docked a minute, unknown ship around",
    "watching d-scan, something is off",
  ]),
  TRAVEL: lines("TRAVEL", [
    "{corp} heading out to {place}, gate after gate",
    "on the way to {place}, autopilot is too slow",
    "[{ticker}] moving out, see you on the other side",
    "jumping through, nothing to see here",
  ]),
  RETURN_FULL: lines("RETURN_FULL", [
    "hold is full, heading back to {home}",
    "{corp} coming home with about {isk} in the hold",
    "good run, [{ticker}] is going home rich",
    "cargo full, setting course for home",
  ]),
  RETURN_EMPTY: lines("RETURN_EMPTY", [
    "nothing worth keeping, heading back to {home}",
    "{corp} calling it, coming home empty",
    "[{ticker}] crew pulling out, better luck next time",
    "wasted trip, going home",
  ]),
  LAST_LOST: lines("LAST_LOST", [
    "someone caught us in {place}, {lost} ships gone",
    "{corp} lost {lost} ships in {place}, never again",
    "[{ticker}] is still counting the losses",
    "we got jumped last trip, still angry about it",
  ]),
  LAST_RICH: lines("LAST_RICH", [
    "last trip to {place} paid {isk}, best run this month",
    "{corp} made {isk} out of {place}, drinks on us",
    "[{ticker}] is buying new ships after that last run",
    "great haul last time, the wallet is happy",
  ]),
  LAST_DONE: lines("LAST_DONE", [
    "back from {place}, an honest day of work",
    "{corp} finished the job in {place}, resting now",
    "[{ticker}] crew back home, next run soon",
    "job done, time for a break",
  ]),
  IDLE_miner: lines("IDLE_miner", [
    "{corp} looking for a quiet belt near {home}",
    "anyone know where the good ore is this week?",
    "[{ticker}] needs more miners, convo me",
    "waiting for the belts to respawn",
  ]),
  IDLE_hauler: lines("IDLE_hauler", [
    "{corp} has a free hauler in {home}, contracts welcome",
    "need something moved? [{ticker}] hauls cheap",
    "anyone have a courier contract going out?",
    "parked the Iteron, waiting for cargo",
  ]),
  IDLE_ratter: lines("IDLE_ratter", [
    "{corp} looking for good ratting space near {home}",
    "[{ticker}] ratters bored, where are the spawns?",
    "anyone know a system with good bounties?",
    "fitting a new ratting ship, any tips?",
  ]),
  IDLE_explorer: lines("IDLE_explorer", [
    "{corp} buying new probes in {home}",
    "[{ticker}] explorers getting ready to go out",
    "anyone found a good wormhole lately?",
    "refitting the scanner, back out soon",
  ]),
  IDLE_industrialist: lines("IDLE_industrialist", [
    "{corp} needs minerals in {home}, paying market",
    "[{ticker}] taking build orders, convo me",
    "anyone selling blueprint copies?",
    "planning the next production run",
  ]),
  IDLE_missioner: lines("IDLE_missioner", [
    "{corp} looking for a good agent near {home}",
    "[{ticker}] needs a level 4 partner",
    "any agents with decent missions around here?",
    "declined another bad mission, waiting it out",
  ]),
  GENERIC: lines("GENERIC", [
    "o7 from {corp}",
    "[{ticker}] is recruiting, convo me",
    "{corp} says hello to {system}",
    "fly safe everyone",
    "quiet evening, nothing to report",
    "anyone want to join a small corp? we are friendly",
    "{corp} still alive and kicking",
    "back from a break, what did I miss?",
  ]),
});

module.exports = { CONTEXTS, PLACEHOLDERS, LINES };
