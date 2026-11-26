"use strict";

const PREFIXES = Object.freeze(["Amber", "Ashen", "Azure", "Black", "Blue", "Brass", "Bright", "Broken", "Burning",
  "Cinder", "Cobalt", "Cold", "Copper", "Crimson", "Crystal", "Dark", "Dawn", "Deep", "Distant", "Dusk", "Ember",
  "Emerald", "Far", "Feral", "Frozen", "Gilded", "Golden", "Granite", "Grey", "Hollow", "Iron", "Ivory", "Jade", "Last",
  "Lone", "Lunar", "Marble", "Midnight", "Molten", "Northern", "Obsidian", "Onyx", "Pale", "Quiet", "Radiant", "Red",
  "Rusted", "Sable", "Scarlet", "Shattered", "Silent", "Silver", "Solar", "Southern", "Stellar", "Steel", "Stone",
  "Storm", "Swift", "Thunder", "Tidal", "Twin", "Velvet", "Violet", "White", "Wild", "Winter", "Zenith"]);

const NOUNS = Object.freeze(["Anvil", "Arrow", "Beacon", "Comet", "Crown", "Drake", "Eagle", "Falcon", "Forge", "Gate",
  "Hammer", "Harbor", "Hawk", "Horizon", "Lantern", "Lion", "Meridian", "Nebula", "Nova", "Orbit", "Peak", "Phoenix",
  "Pillar", "Quasar", "Raven", "Ridge", "River", "Serpent", "Shield", "Spire", "Star", "Summit", "Tiger", "Tower",
  "Vault", "Viper", "Wolf"]);

const SUFFIXES = Object.freeze({
  miner: Object.freeze(["Mining", "Excavations", "Extraction", "Ore Works", "Prospecting", "Drilling", "Quarries",
    "Minerals", "Ore Syndicate", "Asteroid Works", "Deep Core Mining", "Mining Guild", "Rock Cutters"]),
  hauler: Object.freeze(["Haulage", "Freight", "Logistics", "Shipping", "Transport", "Couriers", "Cargo", "Express",
    "Carriers", "Supply Lines", "Freightways", "Distribution", "Hauling Union"]),
  ratter: Object.freeze(["Rangers", "Wardens", "Bounty Office", "Sentinels", "Pest Control", "Pirate Watch", "Patrol",
    "Vanguard", "Enforcers", "Lancers", "Guardians", "Strikers", "Outriders"]),
  explorer: Object.freeze(["Exploration", "Surveyors", "Pathfinders", "Cartography", "Expeditions", "Discovery",
    "Scouts", "Salvagers", "Relic Hunters", "Wayfinders", "Deep Scan", "Survey Corps", "Archaeology"]),
  industrialist: Object.freeze(["Industries", "Manufacturing", "Fabrication", "Foundry", "Works", "Assembly",
    "Engineering", "Shipyards", "Production", "Industrial Group", "Machine Works", "Foundries", "Constructions"]),
  missioner: Object.freeze(["Contractors", "Agency", "Associates", "Security", "Services", "Operations", "Consulting",
    "Task Force", "Solutions", "Commission", "Mandate", "Directive", "Partners"]),
  hunter: Object.freeze(["Raiders", "Reavers", "Marauders", "Corsairs", "Prowlers", "Stalkers", "Predators",
    "Ambushers", "Blades", "Wolves", "Butchers", "Cutthroats", "Hunting Party"]),
  structure: Object.freeze(["Holdings", "Citadel Group", "Estates", "Anchorage", "Outposts", "Station Works",
    "Keepers", "Bastion", "Stronghold", "Property", "Infrastructure", "Deployments", "Territories"]),
});

module.exports = { PREFIXES, NOUNS, SUFFIXES };
