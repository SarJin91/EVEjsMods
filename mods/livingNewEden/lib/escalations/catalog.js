"use strict";

const HL = Object.freeze(["highsec", "lowsec"]);
const L = Object.freeze(["lowsec"]);
const LN = Object.freeze(["lowsec", "nullsec"]);
const N = Object.freeze(["nullsec"]);

const row = (templateId, factionId, dedRating, bands, name) =>
  Object.freeze({ templateId, factionId, dedRating, bands, name });

const DED_TEMPLATES = Object.freeze([
  row("client-dungeon:116", 500020, 1, HL, "Serpentis Drug Outlet"),
  row("client-dungeon:120", 500021, 2, HL, "Rogue Drone Infestation Sprout"),
  row("client-dungeon:149", 500010, 1, HL, "Pith-Robux Asteroid Mining Co."),
  row("client-dungeon:150", 500011, 2, HL, "Angel Creo-Corp Mining"),
  row("client-dungeon:178", 500011, 1, HL, "Minmatar Contracted Bio-Farm"),
  row("client-dungeon:179", 500012, 1, HL, "Old Meanie - Cultivation Center"),
  row("client-dungeon:2243", 500019, 6, LN, "Sansha War Supply Complex"),
  row("client-dungeon:2244", 500020, 3, HL, "Serpentis Narcotic Warehouses"),
  row("client-dungeon:2245", 500012, 6, LN, "Crimson Hand Supply Depot"),
  row("client-dungeon:2246", 500011, 7, N, "Angel Military Operations Complex"),
  row("client-dungeon:2247", 500021, 5, L, "Outgrowth Rogue Drone Hive"),
  row("client-dungeon:2249", 500010, 4, HL, "Guristas Scout Outpost"),
  row("client-dungeon:2250", 500019, 1, HL, "Sansha Military Outpost"),
  row("client-dungeon:2251", 500019, 3, HL, "Sansha's Command Relay Outpost"),
  row("client-dungeon:2253", 500020, 4, HL, "Serpentis Phi-Outpost"),
  row("client-dungeon:2254", 500012, 4, HL, "Mul-Zatah Monastery"),
  row("client-dungeon:2255", 500021, 3, HL, "Rogue Drone Asteroid Infestation"),
  row("client-dungeon:2256", 500011, 10, N, "Angel Cartel Naval Shipyard"),
  row("client-dungeon:2257", 500010, 10, N, "The Maze"),
  row("client-dungeon:2258", 500019, 10, N, "Centus Assembly T.P. Co."),
  row("client-dungeon:2259", 500020, 10, N, "Serpentis Fleet Shipyard"),
  row("client-dungeon:2260", 500012, 10, N, "Blood Raider Naval Shipyard"),
  row("client-dungeon:2261", 500011, 8, N, "Cartel Prisoner Retention"),
  row("client-dungeon:2262", 500010, 8, N, "Pith's Penal Complex"),
  row("client-dungeon:2264", 500011, 5, L, "Angel's Red Light District"),
  row("client-dungeon:2265", 500010, 6, LN, "Guristas Troop Reinvigoration Camp"),
  row("client-dungeon:2455", 500020, 6, LN, "Serpentis Logistical Outpost"),
  row("client-dungeon:2477", 500011, 6, LN, "Angel Mineral Acquisition Outpost"),
  row("client-dungeon:43", 500010, 2, HL, "Pith Merchant Depot"),
  row("client-dungeon:5221", 500012, 8, N, "Blood Raider Prison Camp"),
  row("client-dungeon:5233", 500010, 7, N, "Gurista Military Operations Complex"),
  row("client-dungeon:5235", 500019, 8, N, "Sansha Prison Camp"),
  row("client-dungeon:5236", 500020, 8, N, "Serpentis Prison Camp"),
  row("client-dungeon:5237", 500012, 7, N, "Blood Raider Coordination Center"),
  row("client-dungeon:5238", 500020, 7, N, "Serpentis Paramilitary Complex"),
  row("client-dungeon:5239", 500019, 7, N, "Sansha Military Operations Complex"),
  row("client-dungeon:5240", 500012, 5, L, "Blood Raider Psychotropics Depot"),
  row("client-dungeon:5242", 500010, 5, L, "Guristas Hallucinogen Supply Waypoint"),
  row("client-dungeon:5261", 500019, 5, L, "Sansha's Nation Neural Paralytic Facility"),
  row("client-dungeon:5269", 500020, 5, L, "Serpentis Corporation Hydroponics Site"),
  row("client-dungeon:5275", 500011, 4, HL, "Angel Cartel Occupied Mining Colony"),
  row("client-dungeon:5276", 500019, 4, HL, "Sansha's Nation Occupied Mining Colony"),
  row("client-dungeon:5278", 500011, 3, HL, "Angel Repurposed Outpost"),
  row("client-dungeon:5279", 500012, 3, HL, "Blood Raider Intelligence Collection Point"),
  row("client-dungeon:5302", 500010, 3, HL, "Guristas Guerilla Grounds"),
  row("client-dungeon:5317", 500012, 2, HL, "Blood Raider Human Farm"),
  row("client-dungeon:5469", 500019, 2, HL, "Sansha Acclimatization Facility"),
  row("client-dungeon:5470", 500020, 2, HL, "Serpentis Live Cargo Distribution Facilities"),
]);

const EXCLUDED_ESCALATION_TEMPLATES = Object.freeze(["client-dungeon:10977", "client-dungeon:2413"]);

module.exports = { DED_TEMPLATES, EXCLUDED_ESCALATION_TEMPLATES };
