"use strict";

const LAYERS = Object.freeze(["shield", "armor", "structure"]);

const TEMPLATES = Object.freeze({
  pl: Object.freeze({
    layers: Object.freeze({ shield: "osłony", armor: "pancerz", structure: "kadłub" }),
    one: Object.freeze(["{clause}.", "Kapitanie, {clause}."]),
    many: Object.freeze(["{clauses}."]),
    more: " I jeszcze {n}.",
    hullCritical: " Kadłub zaraz pójdzie!",
    armorCritical: " Pancerz na wykończeniu.",
    lossOne: Object.freeze(["Straciliśmy {name}!", "{name} zniszczony, kapitanie."]),
    lossMany: Object.freeze(["Straciliśmy {names}."]),
    and: " i ",
    unnamed: "Kopia",
  }),
  en: Object.freeze({
    layers: Object.freeze({ shield: "shields", armor: "armor", structure: "hull" }),
    one: Object.freeze(["{clause}.", "Captain, {clause}."]),
    many: Object.freeze(["{clauses}."]),
    more: " Plus {n} more.",
    hullCritical: " Hull's about to go!",
    armorCritical: " Armor's nearly gone.",
    lossOne: Object.freeze(["We lost {name}!", "{name} is gone, Captain."]),
    lossMany: Object.freeze(["We lost {names}."]),
    and: " and ",
    unnamed: "Copy",
  }),
});

module.exports = { LAYERS, TEMPLATES };
