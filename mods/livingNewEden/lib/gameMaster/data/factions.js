"use strict";

const FACTIONS = Object.freeze([
  Object.freeze({ key: "guristas", factionId: 500010, role: "pirate" }),
  Object.freeze({ key: "angel", factionId: 500011, role: "pirate" }),
  Object.freeze({ key: "blood", factionId: 500012, role: "pirate" }),
  Object.freeze({ key: "sansha", factionId: 500019, role: "pirate" }),
  Object.freeze({ key: "serpentis", factionId: 500020, role: "pirate" }),
  Object.freeze({ key: "caldari", factionId: 500001, role: "actor" }),
  Object.freeze({ key: "minmatar", factionId: 500002, role: "actor" }),
  Object.freeze({ key: "amarr", factionId: 500003, role: "actor" }),
  Object.freeze({ key: "gallente", factionId: 500004, role: "actor" }),
]);

const ROLES = Object.freeze({ PIRATE: "pirate", ACTOR: "actor" });

module.exports = { FACTIONS, ROLES };
