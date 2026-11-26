"use strict";

const P0 = Object.freeze({
  MICROORGANISMS: 2073,
  BASE_METALS: 2267,
  AQUEOUS_LIQUIDS: 2268,
  NOBLE_METALS: 2270,
  HEAVY_METALS: 2272,
  PLANKTIC_COLONIES: 2286,
  COMPLEX_ORGANISMS: 2287,
  CARBON_COMPOUNDS: 2288,
  AUTOTROPHS: 2305,
  NON_CS_CRYSTALS: 2306,
  FELSIC_MAGMA: 2307,
  SUSPENDED_PLASMA: 2308,
  IONIC_SOLUTIONS: 2309,
  NOBLE_GAS: 2310,
  REACTIVE_GAS: 2311,
});

const FIRST_VARIANT_TYPE_ID = 340102;
const BLUEPRINT_OFFSET = 100;

const VARIANTS = Object.freeze([
  [P0.MICROORGANISMS, "Microorganisms"],
  [P0.BASE_METALS, "Base Metals"],
  [P0.AQUEOUS_LIQUIDS, "Aqueous Liquids"],
  [P0.NOBLE_METALS, "Noble Metals"],
  [P0.HEAVY_METALS, "Heavy Metals"],
  [P0.PLANKTIC_COLONIES, "Planktic Colonies"],
  [P0.COMPLEX_ORGANISMS, "Complex Organisms"],
  [P0.CARBON_COMPOUNDS, "Carbon Compounds"],
  [P0.AUTOTROPHS, "Autotrophs"],
  [P0.NON_CS_CRYSTALS, "Non-CS Crystals"],
  [P0.FELSIC_MAGMA, "Felsic Magma"],
  [P0.SUSPENDED_PLASMA, "Suspended Plasma"],
  [P0.IONIC_SOLUTIONS, "Ionic Solutions"],
  [P0.NOBLE_GAS, "Noble Gas"],
  [P0.REACTIVE_GAS, "Reactive Gas"],
].map(([p0TypeID, p0Name], index) => Object.freeze({
  typeID: FIRST_VARIANT_TYPE_ID + index,
  blueprintTypeID: FIRST_VARIANT_TYPE_ID + index + BLUEPRINT_OFFSET,
  p0TypeID,
  p0Name,
})));

const PLANET_CLASSES = Object.freeze([
  [11, "Temperate", [P0.AQUEOUS_LIQUIDS, P0.AUTOTROPHS, P0.CARBON_COMPOUNDS, P0.COMPLEX_ORGANISMS, P0.MICROORGANISMS]],
  [12, "Ice", [P0.AQUEOUS_LIQUIDS, P0.HEAVY_METALS, P0.MICROORGANISMS, P0.NOBLE_GAS, P0.PLANKTIC_COLONIES]],
  [13, "Gas", [P0.AQUEOUS_LIQUIDS, P0.BASE_METALS, P0.IONIC_SOLUTIONS, P0.NOBLE_GAS, P0.REACTIVE_GAS]],
  [2014, "Oceanic", [P0.AQUEOUS_LIQUIDS, P0.CARBON_COMPOUNDS, P0.COMPLEX_ORGANISMS, P0.MICROORGANISMS, P0.PLANKTIC_COLONIES]],
  [2015, "Lava", [P0.BASE_METALS, P0.FELSIC_MAGMA, P0.HEAVY_METALS, P0.NON_CS_CRYSTALS, P0.SUSPENDED_PLASMA]],
  [2016, "Barren", [P0.AQUEOUS_LIQUIDS, P0.BASE_METALS, P0.CARBON_COMPOUNDS, P0.MICROORGANISMS, P0.NOBLE_METALS]],
  [2017, "Storm", [P0.AQUEOUS_LIQUIDS, P0.BASE_METALS, P0.IONIC_SOLUTIONS, P0.NOBLE_GAS, P0.SUSPENDED_PLASMA]],
  [2063, "Plasma", [P0.BASE_METALS, P0.HEAVY_METALS, P0.NOBLE_METALS, P0.NON_CS_CRYSTALS, P0.SUSPENDED_PLASMA]],
].map(([planetTypeID, name, p0TypeIDs]) => Object.freeze({ planetTypeID, name, p0TypeIDs: Object.freeze(p0TypeIDs) })));

const VARIANTS_BY_TYPE_ID = new Map(VARIANTS.map((variant) => [variant.typeID, variant]));

function variantOf(typeID) {
  return VARIANTS_BY_TYPE_ID.get(Number(typeID)) || null;
}

function classesWithP0(p0TypeID) {
  const id = Number(p0TypeID);
  return PLANET_CLASSES.filter((planetClass) => planetClass.p0TypeIDs.includes(id)).map((planetClass) => planetClass.name);
}

function isLaunchType(typeID, cfg) {
  const launchTypeID = Number(cfg && cfg.launchTypeID) || 0;
  if (!(launchTypeID > 0)) return false;
  const id = Number(typeID);
  return id === launchTypeID || variantOf(id) !== null;
}

function listText(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function itemNameOf(variant) {
  return `Planetary Drill (${variant.p0Name})`;
}

const GENERIC_PRECHECK_TEXT = "This drill cannot be launched right now: the server cannot check the planet's resources. " +
  "The drill stays in your cargo hold.";

function refusalMessage({ variant, planetName, reason }) {
  if (!variant) return GENERIC_PRECHECK_TEXT;
  const item = itemNameOf(variant);
  if (reason === "P0_TOO_POOR") {
    return `${item} cannot be launched at ${planetName}: the ${variant.p0Name} deposits of this planet are too poor to mine. ` +
      "The drill stays in your cargo hold.";
  }
  if (reason === "P0_NOT_ON_PLANET") {
    return `${item} cannot be launched at ${planetName}: this planet has no ${variant.p0Name}. ` +
      `${variant.p0Name} is found on ${listText(classesWithP0(variant.p0TypeID))} planets. The drill stays in your cargo hold.`;
  }
  return `${item} cannot be launched right now: the server cannot check the planet's resources. The drill stays in your cargo hold.`;
}

module.exports = {
  BLUEPRINT_OFFSET,
  GENERIC_PRECHECK_TEXT,
  P0,
  PLANET_CLASSES,
  VARIANTS,
  classesWithP0,
  isLaunchType,
  itemNameOf,
  listText,
  refusalMessage,
  variantOf,
};
