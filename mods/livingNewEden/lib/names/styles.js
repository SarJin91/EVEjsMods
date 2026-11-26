"use strict";

const STYLE_KEYS = Object.freeze(["caldari", "minmatar", "amarr", "gallente", "triglavian"]);
const DEFAULT_STYLE = "gallente";
const OUTLAW_OWNER_KIND = "outlaw";

const entry = (style, nicknames) => Object.freeze({ style, nicknames });

const FACTION_STYLE = Object.freeze({
  500001: entry("caldari", false),
  500002: entry("minmatar", false),
  500003: entry("amarr", false),
  500004: entry("gallente", false),
  500010: entry("caldari", true),
  500011: entry("minmatar", true),
  500012: entry("amarr", true),
  500014: entry("gallente", false),
  500016: entry("gallente", false),
  500019: entry("amarr", true),
  500020: entry("gallente", true),
  500026: entry("triglavian", false),
});

const RACE_STYLE = Object.freeze({ 1: "caldari", 2: "minmatar", 4: "amarr", 8: "gallente" });

function styleFor(o) {
  const input = o && typeof o === "object" ? o : {};
  const byFaction = Number.isInteger(input.factionId) ? FACTION_STYLE[input.factionId] : undefined;
  if (byFaction) return { style: byFaction.style, nicknames: byFaction.nicknames };
  const byRace = Number.isInteger(input.raceId) ? RACE_STYLE[input.raceId] : undefined;
  return { style: byRace || DEFAULT_STYLE, nicknames: input.ownerKind === OUTLAW_OWNER_KIND };
}

module.exports = { STYLE_KEYS, DEFAULT_STYLE, FACTION_STYLE, RACE_STYLE, styleFor };
