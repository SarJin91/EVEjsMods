"use strict";

const HULL_CLASSES = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]);

const NAVY_PROFILES_BY_FACTION_ID = Object.freeze({
  500003: Object.freeze({
    frigate: "parity_faction_warfare_entities_75351_imperial_frigate",
    destroyer: "parity_faction_warfare_entities_75352_imperial_destroyer",
    cruiser: "parity_faction_warfare_entities_75353_imperial_cruiser",
    battlecruiser: "parity_faction_warfare_entities_75354_imperial_battlecruiser",
    battleship: "parity_faction_warfare_entities_75355_imperial_battleship",
  }),
  500001: Object.freeze({
    frigate: "parity_faction_warfare_entities_75356_state_frigate",
    destroyer: "parity_faction_warfare_entities_75357_state_destroyer",
    cruiser: "parity_faction_warfare_entities_75358_state_cruiser",
    battlecruiser: "parity_faction_warfare_entities_75359_state_battlecruiser",
    battleship: "parity_faction_warfare_entities_75360_state_battleship",
  }),
  500004: Object.freeze({
    frigate: "parity_faction_warfare_entities_75361_federation_frigate",
    destroyer: "parity_faction_warfare_entities_75362_federation_destroyer",
    cruiser: "parity_faction_warfare_entities_75363_federation_cruiser",
    battlecruiser: "parity_faction_warfare_entities_75364_federation_battlecruiser",
    battleship: "parity_faction_warfare_entities_75365_federation_battleship",
  }),
  500002: Object.freeze({
    frigate: "parity_faction_warfare_entities_75366_republic_frigate",
    destroyer: "parity_faction_warfare_entities_75367_republic_destroyer",
    cruiser: "parity_faction_warfare_entities_75368_republic_cruiser",
    battlecruiser: "parity_faction_warfare_entities_75369_republic_battlecruiser",
    battleship: "parity_faction_warfare_entities_75370_republic_battleship",
  }),
});

const EMPIRE_FACTION_IDS = Object.freeze(Object.keys(NAVY_PROFILES_BY_FACTION_ID).map(Number));

module.exports = { HULL_CLASSES, NAVY_PROFILES_BY_FACTION_ID, EMPIRE_FACTION_IDS };
