"use strict";

const HULL_LADDER = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]);
const EWAR_FAMILIES = Object.freeze(["web", "scram", "neut", "trackingDisrupt", "sensorDamp", "paint", "ecm"]);

const row = (escortClasses, ewarFamily) => Object.freeze({ escortClasses: Object.freeze(escortClasses), ewarFamily });

const DOCTRINE = Object.freeze({
  frigate: row(["frigate", "destroyer"], "web"),
  tackle: row(["frigate", "destroyer"], "web"),
  ewar: row(["frigate", "destroyer"], "web"),
  destroyer: row(["destroyer", "frigate"], "web"),
  cruiser: row(["cruiser", "destroyer"], "scram"),
  logistics: row(["cruiser", "frigate"], "ecm"),
  battlecruiser: row(["battlecruiser", "cruiser"], "trackingDisrupt"),
  battleship: row(["battleship", "battlecruiser"], "ecm"),
  capital: row(["battleship", "battlecruiser"], "neut"),
  industrial: row(["frigate", "destroyer"], "scram"),
});

module.exports = { DOCTRINE, HULL_LADDER, EWAR_FAMILIES };
