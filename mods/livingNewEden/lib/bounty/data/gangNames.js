"use strict";

const CORP_SUFFIXES = Object.freeze(["Syndicate", "Cartel", "Ring", "Crew", "Brotherhood", "Outfit"]);

const DESCRIPTION = "{corp}: outlaws with a price on their heads. They roam the lawless systems and pay no one.";

const SECURITY_RATING = -5;

const CANONICAL_GANG_FACTIONS = Object.freeze([500010, 500011, 500012, 500019, 500020]);

module.exports = { CORP_SUFFIXES, DESCRIPTION, SECURITY_RATING, CANONICAL_GANG_FACTIONS };
