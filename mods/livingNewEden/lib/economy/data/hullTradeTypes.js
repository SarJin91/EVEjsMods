"use strict";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const HEADER = {
  "tableVersion": 1,
  "sdeBuild": 3724492,
  "sdeReleaseDate": "2026-11-19T11:07:08Z",
  "sourceHash": "f11b749dc8915c12dc41765c00a60ca33894995f41df58d12e86989c570539be",
  "groups": [
    "frigate",
    "destroyer",
    "cruiser",
    "battlecruiser",
    "battleship",
    "logistics",
    "ewar",
    "tackle"
  ],
  "typeCount": 32
};

const RACES = {
  "1": {"frigate":583,"destroyer":16238,"cruiser":632,"battlecruiser":24698,"battleship":638,"logistics":37458,"ewar":11957,"tackle":11178},
  "2": {"frigate":585,"destroyer":16242,"cruiser":622,"battlecruiser":24702,"battleship":644,"logistics":37460,"ewar":11961,"tackle":11198},
  "4": {"frigate":589,"destroyer":16236,"cruiser":628,"battlecruiser":24696,"battleship":643,"logistics":37457,"ewar":11965,"tackle":11186},
  "8": {"frigate":593,"destroyer":16240,"cruiser":634,"battlecruiser":24700,"battleship":645,"logistics":37459,"ewar":11969,"tackle":11202},
};

const FACTION_RACE = {
  "500001": 1,
  "500002": 2,
  "500003": 4,
  "500004": 8,
  "500010": 1,
  "500011": 2,
  "500012": 4,
  "500016": 8,
  "500019": 4,
  "500020": 8,
};

module.exports = deepFreeze({ HEADER, RACES, FACTION_RACE });
