"use strict";

const INVADER_LIVE_PROFILES = Object.freeze({
  500024: Object.freeze({
    frigate: "parity_drifter_hopilite",
    destroyer: "parity_drifter_hopilite",
    cruiser: "parity_drifter_cruiser",
    battlecruiser: "parity_drifter_strike_cruiser",
    battleship: "parity_drifter_battleship",
  }),
  500026: Object.freeze({
    frigate: "parity_trig_liminal_damavik",
    destroyer: "parity_trig_liminal_kikimora",
    cruiser: "parity_trig_liminal_vedmak",
    battlecruiser: "parity_trig_liminal_drekavac",
    battleship: "parity_trig_liminal_leshak",
  }),
});

const INVADER_FACTION_IDS = Object.freeze([500024, 500026]);

module.exports = { INVADER_LIVE_PROFILES, INVADER_FACTION_IDS };
