"use strict";

const INDUSTRY_GROUPS = Object.freeze(["industrial", "mining_frigate", "mining_barge", "exhumer", "porpoise", "orca",
  "rorqual", "freighter", "jump_freighter"]);

const HAULER_KEY_BY_GROUP = Object.freeze({ industrial: "industrial", freighter: "freighter",
  jump_freighter: "freighter" });

const HAULERS = Object.freeze({
  caldari: Object.freeze({ industrial: "ore_mining_badger_hauler", freighter: "ore_mining_bustard_hauler" }),
  amarr: Object.freeze({ industrial: "ore_mining_bestower_hauler", freighter: "ore_mining_impel_hauler" }),
  minmatar: Object.freeze({ industrial: "ore_mining_mammoth_hauler", freighter: "ore_mining_mastodon_hauler" }),
  gallente: Object.freeze({ industrial: "ore_mining_occator_hauler", freighter: "ore_mining_occator_hauler" }),
  guristas: Object.freeze({ industrial: "parity_guristas_hauler", freighter: "parity_guristas_transporter" }),
  angels: Object.freeze({ industrial: "parity_angel_hauler", freighter: "parity_angel_transporter" }),
  blood: Object.freeze({ industrial: "parity_blood_hauler", freighter: "parity_blood_transporter" }),
  sanshas: Object.freeze({ industrial: "parity_sanshas_hauler", freighter: "parity_sanshas_transporter" }),
  serpentis: Object.freeze({ industrial: "parity_serpentis_hauler", freighter: "parity_serpentis_transporter" }),
  rogue_drones: Object.freeze({ industrial: "parity_rogue_drone_hauler", freighter: "parity_rogue_drone_transporter" }),
});

const RACE_BY_FACTION_ID = Object.freeze({
  500001: "caldari", 500018: "caldari",
  500003: "amarr", 500007: "amarr", 500008: "amarr",
  500002: "minmatar", 500015: "minmatar",
  500004: "gallente",
  500016: "gallente",
  500010: "guristas", 500011: "angels", 500012: "blood", 500019: "sanshas", 500020: "serpentis",
  500025: "rogue_drones",
});

const DEFAULT_RACE = "caldari";

const NO_INDUSTRY_PROFILE = Object.freeze([500021, 500024, 500026]);

const MINERS = Object.freeze({ mining_frigate: "ore_mining_venture", mining_barge: "ore_mining_retriever",
  exhumer: "ore_mining_hulk" });

const INDUSTRY_LIVE_PROFILES = Object.freeze({ INDUSTRY_GROUPS, HAULER_KEY_BY_GROUP, HAULERS, RACE_BY_FACTION_ID,
  DEFAULT_RACE, NO_INDUSTRY_PROFILE, MINERS });

module.exports = { INDUSTRY_LIVE_PROFILES, INDUSTRY_GROUPS, HAULER_KEY_BY_GROUP, HAULERS, RACE_BY_FACTION_ID,
  DEFAULT_RACE, NO_INDUSTRY_PROFILE, MINERS };
