"use strict";

const LEVELS = Object.freeze(["inbound", "system", "scan", "grid", "attack"]);

const TEMPLATES = Object.freeze({
  pl: Object.freeze({
    inbound: Object.freeze({ many: Object.freeze(["Kapitanie, {group} {verb} do nas z sąsiedniego systemu."]),
      verb: Object.freeze(["leci", "lecą", "leci"]) }),
    system: Object.freeze({ many: Object.freeze(["Kapitanie, {group} {verb} do systemu.",
      "Uwaga, {group} {verb} do systemu."]), verb: Object.freeze(["wskakuje", "wskakują", "wskakuje"]) }),
    scan: Object.freeze({ many: Object.freeze(["Na skanie {group}, wrogie{pilots}."]),
      one: Object.freeze(["Na skanie {hostile} {group}{pilots}."]),
      pilotsOnly: Object.freeze({ one: Object.freeze(["Na skanie wrogi pilot."]),
        many: Object.freeze(["Na skanie {count} {pilotsWord}."]) }) }),
    grid: Object.freeze({ many: Object.freeze(["Kapitanie, {group} w sektorze{closing}."]),
      wave: Object.freeze(["Kapitanie, nowa fala: {group} w sektorze{closing}."]),
      closing: Object.freeze([", zbliża się", ", zbliżają się", ", zbliża się"]) }),
    attack: Object.freeze({ many: Object.freeze(["Atakują nas! {group} w sektorze."]),
      one: Object.freeze(["Atakuje nas {group}!"]),
      wave: Object.freeze(["Nowa fala atakuje! {group} w sektorze."]) }),
  }),
  en: Object.freeze({
    inbound: Object.freeze({ many: Object.freeze(["Captain, {group} inbound from next door."]) }),
    system: Object.freeze({ many: Object.freeze(["Captain, {group} jumping in."]) }),
    scan: Object.freeze({ many: Object.freeze(["On scan: {group}, hostile{pilots}."]),
      pilotsOnly: Object.freeze({ one: Object.freeze(["On scan: 1 hostile pilot."]),
        many: Object.freeze(["On scan: {count} hostile pilots."]) }) }),
    grid: Object.freeze({ many: Object.freeze(["Captain, {group} in our sector{closing}."]),
      wave: Object.freeze(["Captain, new wave: {group} in our sector{closing}."]),
      closing: Object.freeze([", closing", ", closing", ", closing"]) }),
    attack: Object.freeze({ many: Object.freeze(["We are under attack! {group} in our sector."]),
      wave: Object.freeze(["New wave attacking! {group} in our sector."]) }),
  }),
});

const CLASSES = Object.freeze([
  Object.freeze({ key: "battlecruiser", word: "battlecruiser", gender: "m",
    pl: Object.freeze(["krążownik liniowy", "krążowniki liniowe", "krążowników liniowych"]),
    en: Object.freeze(["battlecruiser", "battlecruisers"]) }),
  Object.freeze({ key: "battleship", word: "battleship", gender: "m",
    pl: Object.freeze(["pancernik", "pancerniki", "pancerników"]), en: Object.freeze(["battleship", "battleships"]) }),
  Object.freeze({ key: "dreadnought", word: "dreadnought", gender: "m",
    pl: Object.freeze(["drednot", "drednoty", "drednotów"]), en: Object.freeze(["dreadnought", "dreadnoughts"]) }),
  Object.freeze({ key: "carrier", word: "carrier", gender: "m",
    pl: Object.freeze(["lotniskowiec", "lotniskowce", "lotniskowców"]), en: Object.freeze(["carrier", "carriers"]) }),
  Object.freeze({ key: "cruiser", word: "cruiser", gender: "m",
    pl: Object.freeze(["krążownik", "krążowniki", "krążowników"]), en: Object.freeze(["cruiser", "cruisers"]) }),
  Object.freeze({ key: "destroyer", word: "destroyer", gender: "m",
    pl: Object.freeze(["niszczyciel", "niszczyciele", "niszczycieli"]),
    en: Object.freeze(["destroyer", "destroyers"]) }),
  Object.freeze({ key: "frigate", word: "frigate", gender: "f",
    pl: Object.freeze(["fregata", "fregaty", "fregat"]), en: Object.freeze(["frigate", "frigates"]) }),
  Object.freeze({ key: "industrial", word: "industrial", gender: "m",
    pl: Object.freeze(["transportowiec", "transportowce", "transportowców"]),
    en: Object.freeze(["industrial", "industrials"]) }),
]);

const GENERIC_CLASS = Object.freeze({ key: null, gender: "m", pl: Object.freeze(["statek", "statki", "statków"]),
  en: Object.freeze(["ship", "ships"]) });

const WORDS = Object.freeze({
  pl: Object.freeze({ hostile: Object.freeze({ m: "wrogi", f: "wroga" }),
    pilots: Object.freeze(["wrogi pilot", "wrogich pilotów", "wrogich pilotów"]), and: " i ", others: " i inni" }),
  en: Object.freeze({ hostile: Object.freeze({ m: "hostile", f: "hostile" }),
    pilots: Object.freeze(["hostile pilot", "hostile pilots", "hostile pilots"]), and: " and ",
    others: " and others" }),
});

module.exports = { LEVELS, TEMPLATES, CLASSES, GENERIC_CLASS, WORDS };
