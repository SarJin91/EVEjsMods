"use strict";

const AI_VOICES = Object.freeze(["GURISTAS", "ANGEL", "BLOOD", "SANSHA", "SERPENTIS", "DEATHLESS", "AMARR", "CALDARI",
  "GALLENTE", "MINMATAR", "CONCORD", "TRIGLAVIAN", "INDEPENDENT"]);
const GLYPH_VOICES = Object.freeze(["DRIFTER", "SLEEPER", "ROGUE_DRONE"]);
const VOICES = Object.freeze([...AI_VOICES, ...GLYPH_VOICES]);

const FACTION_VOICE = Object.freeze({
  500010: "GURISTAS",
  500011: "ANGEL",
  500012: "BLOOD",
  500019: "SANSHA",
  500020: "SERPENTIS",
  500029: "DEATHLESS",
  500003: "AMARR",
  500007: "AMARR",
  500008: "AMARR",
  500001: "CALDARI",
  500004: "GALLENTE",
  500002: "MINMATAR",
  500006: "CONCORD",
  500027: "CONCORD",
  500026: "TRIGLAVIAN",
  500005: "INDEPENDENT",
  500009: "INDEPENDENT",
  500013: "INDEPENDENT",
  500014: "INDEPENDENT",
  500015: "INDEPENDENT",
  500016: "INDEPENDENT",
  500017: "INDEPENDENT",
  500018: "INDEPENDENT",
  500028: "INDEPENDENT",
  500024: "DRIFTER",
  500021: "SLEEPER",
  500025: "ROGUE_DRONE",
});

const STYLES = Object.freeze({
  GURISTAS: "Guristas pirates: cocky, joking, mocking Caldari, happy to rob anyone in a slow ship",
  ANGEL: "Angel Cartel: arrogant, mercenary, money first, cold threats",
  BLOOD: "Blood Raiders: fanatic cultists, talk of blood, harvest and the Covenant, creepy calm",
  SANSHA: "Sansha's Nation: eerie, collective, speak of unity and of being joined to the Master",
  SERPENTIS: "Serpentis: smooth corporate smugglers, boosters and deals, polite menace",
  DEATHLESS: "Deathless Circle: grim outlaws of Zarzakh, terse, scornful of empires",
  AMARR: "Amarr Empire: formal, devout, speak of the Empress, God and order",
  CALDARI: "Caldari State: formal, efficient, corporate, speak of duty and contracts",
  GALLENTE: "Gallente Federation: formal, proud of liberty and democracy, polite propaganda",
  MINMATAR: "Minmatar Republic: proud tribes, blunt, speak of freedom and the clans",
  CONCORD: "CONCORD: dry officials, cite the law, warn calmly, never joke",
  TRIGLAVIAN: "Triglavian Collective: strange syntax, speak of proving, clades and the flow",
  INDEPENDENT: "independent crew: practical, wry, neutral, business and travel talk",
});

const PROFANITY_CAPS = Object.freeze({
  GURISTAS: "full",
  ANGEL: "full",
  BLOOD: "full",
  SANSHA: "full",
  SERPENTIS: "full",
  DEATHLESS: "full",
  TRIGLAVIAN: "mild",
  INDEPENDENT: "mild",
  AMARR: "off",
  CALDARI: "off",
  GALLENTE: "off",
  MINMATAR: "off",
  CONCORD: "off",
});

const SPEAKERS = Object.freeze({
  GURISTAS: Object.freeze(["Guristas Despoiler", "Guristas Arrogator", "Guristas Imputor"]),
  ANGEL: Object.freeze(["Angel Viper", "Angel Ambusher", "Angel Hijacker"]),
  BLOOD: Object.freeze(["Blood Collector", "Blood Reaver", "Blood Seeker"]),
  SANSHA: Object.freeze(["Sansha's Slavehunter", "Sansha's Ravener", "True Power Herald"]),
  SERPENTIS: Object.freeze(["Serpentis Spy", "Serpentis Agent", "Serpentis Watchman"]),
  DEATHLESS: Object.freeze(["Deathless Outlaw", "Deathless Warden", "Circle Enforcer"]),
  AMARR: Object.freeze(["Amarr Navy Paladin", "Imperial Templar", "Amarr Navy Envoy"]),
  CALDARI: Object.freeze(["Caldari Navy Officer", "State Protectorate Pilot", "Caldari Navy Scout"]),
  GALLENTE: Object.freeze(["Federation Navy Officer", "Federal Marshal", "Federation Navy Scout"]),
  MINMATAR: Object.freeze(["Republic Fleet Officer", "Tribal Liberation Pilot", "Republic Fleet Scout"]),
  CONCORD: Object.freeze(["CONCORD Police Officer", "DED Agent", "CONCORD Inspector"]),
  TRIGLAVIAN: Object.freeze(["Triglavian Starving Damavik", "Triglavian Liminal Vedmak", "Triglavian Clade Voice"]),
  INDEPENDENT: Object.freeze(["Independent Captain", "Freelance Pilot", "Contract Pilot"]),
  DRIFTER: Object.freeze(["Drifter Response Battleship", "Drifter Strike Cruiser"]),
  SLEEPER: Object.freeze(["Sleepless Guardian", "Awakened Sentinel"]),
  ROGUE_DRONE: Object.freeze(["Rogue Drone Hive Mind", "Rogue Drone Swarm"]),
});

const COLORS = Object.freeze({
  GURISTAS: "0xffd9b44a",
  ANGEL: "0xffe05a3a",
  BLOOD: "0xffb3122e",
  SANSHA: "0xff6fcf4f",
  SERPENTIS: "0xff7fbf3f",
  DEATHLESS: "0xffa08060",
  AMARR: "0xffe8c35a",
  CALDARI: "0xff5a9ee8",
  GALLENTE: "0xff4fc08a",
  MINMATAR: "0xffc0603a",
  CONCORD: "0xff9fb8d8",
  TRIGLAVIAN: "0xffc83a3a",
  INDEPENDENT: "0xffb0b0b0",
  DRIFTER: "0xff6ad0e0",
  SLEEPER: "0xffd0d0a0",
  ROGUE_DRONE: "0xff8fa060",
});

module.exports = { AI_VOICES, GLYPH_VOICES, VOICES, FACTION_VOICE, STYLES, PROFANITY_CAPS, SPEAKERS, COLORS };
