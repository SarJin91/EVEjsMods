"use strict";

const PROFILE_PREFIX = "lne_faction_";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const FACTION_LIVE_PROFILES = deepFreeze({
  500016: {
    corporationId: 1000130,
    hardwareFamily: "serpentis",
    namePrefix: "Sisters of EVE",
    byClass: {
      frigate: { typeId: 33468, presentationTypeId: 57797, label: "Astero", loadoutId: "serpentis_small_blaster_frigate",
        behaviorProfileId: "retail_faction_warfare_entities_75361_federation_frigate" },
      destroyer: { typeId: 16240, presentationTypeId: 25125, label: "Catalyst",
        loadoutId: "serpentis_small_blaster_frigate",
        behaviorProfileId: "retail_faction_warfare_entities_75362_federation_destroyer" },
      cruiser: { typeId: 33470, presentationTypeId: 57798, label: "Stratios",
        loadoutId: "serpentis_medium_blaster_cruiser",
        behaviorProfileId: "retail_faction_warfare_entities_75363_federation_cruiser" },
      battlecruiser: { typeId: 16229, presentationTypeId: 46076, label: "Brutix",
        loadoutId: "serpentis_medium_blaster_battlecruiser",
        behaviorProfileId: "retail_faction_warfare_entities_75364_federation_battlecruiser" },
      battleship: { typeId: 33472, presentationTypeId: 57799, label: "Nestor",
        loadoutId: "serpentis_large_blaster_battleship",
        behaviorProfileId: "retail_faction_warfare_entities_75365_federation_battleship" },
    },
  },
});

const SPAWN_DISTANCE_METERS = 5000;
const SECURITY_STATUS = 0;
const PLACEHOLDER_LOOT_TABLE_ID = "parity_faction_warfare_entities_pending_loot";
const NPC_ENTITY_TYPE = "npc";
const PREFERRED_TARGET_MODE = "invoker";

const BOUNTY_FREIGHTER_PREFIX = "lne_bounty_";
const BOUNTY_FREIGHTER_HULLS = deepFreeze({
  caldari: { presentationTypeId: 2882, freighter: { typeId: 20185, hull: "Charon" },
    jump: { typeId: 28844, hull: "Rhea" } },
  minmatar: { presentationTypeId: 32230, freighter: { typeId: 20189, hull: "Fenrir" },
    jump: { typeId: 28846, hull: "Nomad" } },
  amarr: { presentationTypeId: 2879, freighter: { typeId: 20183, hull: "Providence" },
    jump: { typeId: 28850, hull: "Ark" } },
  gallente: { presentationTypeId: 2877, freighter: { typeId: 20187, hull: "Obelisk" },
    jump: { typeId: 28848, hull: "Anshar" } },
});
const BOUNTY_FREIGHTERS = deepFreeze({
  500010: { label: "Guristas", race: "caldari", corporationId: 1000127, hardwareFamily: "guristasLaunchers",
    behaviorProfileId: "retail_guristas_hauler" },
  500011: { label: "Angel Cartel", race: "minmatar", corporationId: 1000138, hardwareFamily: "angelCartel",
    behaviorProfileId: "retail_angel_hauler" },
  500012: { label: "Blood Raider", race: "amarr", corporationId: 1000134, hardwareFamily: "bloodRaiders",
    behaviorProfileId: "retail_blood_hauler" },
  500019: { label: "Sansha's Nation", race: "amarr", corporationId: 1000162, hardwareFamily: "sanshasNation",
    behaviorProfileId: "retail_sanshas_hauler" },
  500020: { label: "Serpentis", race: "gallente", corporationId: 1000135, hardwareFamily: "serpentis",
    behaviorProfileId: "retail_serpentis_hauler" },
});
const BOUNTY_FREIGHTER_LOADOUT_ID = "retail_empty_npc_entity_loadout";
const BOUNTY_FREIGHTER_SECURITY_STATUS = -5;

function bountyFreighterProfileId(factionId, jump) {
  return `${BOUNTY_FREIGHTER_PREFIX}${jump ? "jump_freighter" : "freighter"}_${factionId}`;
}

module.exports = {
  PROFILE_PREFIX, FACTION_LIVE_PROFILES, SPAWN_DISTANCE_METERS, SECURITY_STATUS, PLACEHOLDER_LOOT_TABLE_ID,
  NPC_ENTITY_TYPE, PREFERRED_TARGET_MODE, BOUNTY_FREIGHTERS, BOUNTY_FREIGHTER_HULLS, BOUNTY_FREIGHTER_LOADOUT_ID, BOUNTY_FREIGHTER_SECURITY_STATUS, bountyFreighterProfileId,
};
