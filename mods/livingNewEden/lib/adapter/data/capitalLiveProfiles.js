"use strict";

const PROFILE_PREFIX = "lne_capital_";

const EMPIRE_FACTION_IDS = Object.freeze([500001, 500002, 500003, 500004]);

const TEMPLATE_RACE_BY_FACTION_ID = Object.freeze({
  500003: "blood",
  500001: "guristas",
  500004: "serpentis",
  500002: "angel",
  500012: "blood",
  500010: "guristas",
  500020: "serpentis",
  500019: "sanshas",
  500011: "angel",
});

const FIGHTER_TEMPLATE = "capital_true_sanshas_supercarrier";

const TEMPLATE_BY_RACE_CLASS = Object.freeze({
  blood: Object.freeze({
    carrier: FIGHTER_TEMPLATE,
    dreadnought: "capital_blood_dreadnought",
    force_auxiliary: "capital_blood_dreadnought",
    supercarrier: FIGHTER_TEMPLATE,
    titan: "capital_dark_blood_titan",
  }),
  guristas: Object.freeze({
    carrier: FIGHTER_TEMPLATE,
    dreadnought: "capital_guristas_dreadnought",
    force_auxiliary: "capital_guristas_dreadnought",
    supercarrier: FIGHTER_TEMPLATE,
    titan: "capital_dread_guristas_titan",
  }),
  serpentis: Object.freeze({
    carrier: FIGHTER_TEMPLATE,
    dreadnought: "capital_serpentis_dreadnought",
    force_auxiliary: "capital_serpentis_dreadnought",
    supercarrier: FIGHTER_TEMPLATE,
    titan: "capital_shadow_serpentis_titan",
  }),
  sanshas: Object.freeze({
    carrier: FIGHTER_TEMPLATE,
    dreadnought: "capital_sanshas_dreadnought",
    force_auxiliary: "capital_sanshas_dreadnought",
    supercarrier: FIGHTER_TEMPLATE,
  }),
  angel: Object.freeze({
    carrier: FIGHTER_TEMPLATE,
    dreadnought: "capital_angel_dreadnought",
    force_auxiliary: "capital_angel_dreadnought",
    supercarrier: FIGHTER_TEMPLATE,
    titan: "capital_domination_titan",
  }),
});

const IDENTITY_TEMPLATE_BY_RACE = Object.freeze({
  blood: "capital_blood_dreadnought",
  guristas: "capital_guristas_dreadnought",
  serpentis: "capital_serpentis_dreadnought",
  sanshas: "capital_sanshas_dreadnought",
  angel: "capital_angel_dreadnought",
});

const CAPITAL_CLASS_RUNTIME = Object.freeze({
  carrier: "supercarrier",
  dreadnought: "dreadnought",
  force_auxiliary: "dreadnought",
  supercarrier: "supercarrier",
  titan: "titan",
});

const UNARMED_CLASSES = Object.freeze(["force_auxiliary"]);

const FIGHTER_TUBES = Object.freeze({ carrier: 3, supercarrier: 5 });

const SECURITY_STATUS = Object.freeze({ pirate: -10, empire: -5 });

const NPC_ENTITY_TYPE = "npc";

const CLASS_LABEL = Object.freeze({
  carrier: "Carrier",
  dreadnought: "Dreadnought",
  force_auxiliary: "Force Auxiliary",
  supercarrier: "Supercarrier",
  titan: "Titan",
});

module.exports = {
  PROFILE_PREFIX,
  EMPIRE_FACTION_IDS,
  TEMPLATE_RACE_BY_FACTION_ID,
  TEMPLATE_BY_RACE_CLASS,
  IDENTITY_TEMPLATE_BY_RACE,
  CAPITAL_CLASS_RUNTIME,
  UNARMED_CLASSES,
  FIGHTER_TUBES,
  SECURITY_STATUS,
  NPC_ENTITY_TYPE,
  CLASS_LABEL,
};
