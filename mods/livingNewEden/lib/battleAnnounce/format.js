"use strict";

const { OUTCOME } = require("./schema");

const MAX_LINE = 400;
const ELLIPSIS = "...";
const MS_PER_MINUTE = 60000;

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function cut(text) {
  return text.length <= MAX_LINE ? text : `${text.slice(0, MAX_LINE - ELLIPSIS.length)}${ELLIPSIS}`;
}

function clockOf(at) {
  const d = new Date(Number.isFinite(at) ? at : 0);
  return Number.isNaN(d.getTime()) ? "--:--" : d.toISOString().slice(11, 16);
}

const nameOr = (name, fallback) => (typeof name === "string" && name.trim() !== "" ? oneLine(name) : fallback);

function etaLine(o) {
  const attacker = nameOr(o.attackerName, "unknown forces");
  const system = nameOr(o.systemName, "an unknown system");
  const place = o.regionName ? `${system} (${oneLine(o.regionName)})` : system;
  const held = typeof o.defenderName === "string" && o.defenderName.trim() !== ""
    ? `, held by ${oneLine(o.defenderName)}` : "";
  const minutes = Math.max(1, Math.round((o.etaAt - o.now) / MS_PER_MINUTE));
  return cut(oneLine(`Fleet alert: ${attacker} forces are moving on ${place}${held}. `
    + `ETA ~${clockOf(o.etaAt)} EVE (in ~${minutes} min).`));
}

function endLine(o) {
  const attacker = nameOr(o.attackerName, "unknown forces");
  const system = nameOr(o.systemName, "an unknown system");
  const place = o.regionName ? `${system} (${oneLine(o.regionName)})` : system;
  let text;
  switch (o.outcome) {
    case OUTCOME.SETTLED:
      if (o.attackerWon === true) text = `Battle report: ${attacker} won the battle at ${place}.`;
      else if (o.attackerWon === false) text = `Battle report: the attack of ${attacker} on ${system} was beaten off.`;
      else text = `Battle report: the battle at ${system} is over.`;
      break;
    case OUTCOME.ABORTED:
      text = `Battle report: the battle at ${system} was broken off.`;
      break;
    case OUTCOME.INTERCEPTED:
      text = `Update: the ${attacker} fleet bound for ${system} was intercepted on the way.`;
      break;
    case OUTCOME.CANCELLED:
      text = `Update: the attack of ${attacker} on ${system} was called off.`;
      break;
    case OUTCOME.NO_FIGHT:
      text = `Update: ${attacker} reached ${system} without a fight.`;
      break;
    case OUTCOME.NO_CONTACT:
      text = `Update: ${attacker} forces reached ${system}, no battle so far.`;
      break;
    default:
      text = `Update: no result yet for the attack of ${attacker} on ${system}.`;
  }
  return cut(oneLine(text));
}

module.exports = { etaLine, endLine, MAX_LINE };
