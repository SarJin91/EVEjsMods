"use strict";

const RANK_TITLES = Object.freeze(["Lieutenant", "Captain", "Commander", "Warlord", "Nemesis", "Dread Nemesis",
  "Scourge", "Reaver Lord", "Doom Herald", "Bane of New Eden"]);
const GANG_FALLBACK = "the gang";

function rankTitleOf(rank) {
  const i = Number.isSafeInteger(rank) ? Math.min(RANK_TITLES.length, Math.max(1, rank)) - 1 : 0;
  return RANK_TITLES[i];
}

function returnLineOf(nick, corpName, rank) {
  const gang = typeof corpName === "string" && corpName.trim() !== "" ? corpName.trim() : GANG_FALLBACK;
  const who = typeof nick === "string" && nick.trim() !== "" ? nick.trim() : "A captain";
  return `${who} of ${gang} is back for you. Rank: ${rankTitleOf(rank)}.`;
}

module.exports = { RANK_TITLES, rankTitleOf, returnLineOf,
  GANG_FALLBACK };
